const http=require('http'),fs=require('fs'),path=require('path');
const {WebSocketServer}=require('ws');

const PORT=process.env.PORT||8731;
const WORLD=4000;                 // 世界边长
const FOOD_TARGET=650;            // 食物目标数量
const TICK_MS=50;                 // 20 tick/s 服务端权威
const SPEED=3.4, SPEED_BOOST=5.6; // 每 tick 像素
const HEAD_R=11, BODY_R=8;
const AI_TARGET=12;               // 每房间 AI 蛇目标数量
const PROTECT_MS=3000;            // 新手保护时长
const ITEM_TARGET=4;              // 每房间道具数量
const ITEM_DUR={shield:3000,magnet:4000,boost:3000,stealth:4000};

const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png'};
const server=http.createServer((req,res)=>{
  // 健康检查端点：/health 返回运行状态 JSON（Railway Healthcheck Path 指向它）
  if(req.url==='/health'){
    const body=JSON.stringify(healthInfo());
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(body);
    return;
  }
  // 名人堂榜单
  if(req.url==='/rank'){
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify(hallOfFame.slice(0,10)));
    return;
  }
  let f=req.url==='/'?'index.html':decodeURIComponent(req.url.split('?')[0].slice(1));
  if(f.includes('..')){res.writeHead(403);res.end();return}
  fs.readFile(path.join(__dirname,f),(e,d)=>{
    if(e){res.writeHead(404);res.end('404');return}
    // no-cache：浏览器每次使用前先校验（304 快速命中），避免旧版本缓存导致新功能不可见
    res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream','Cache-Control':'no-cache'});
    res.end(d);
  });
});
const wss=new WebSocketServer({server});

const COLORS=['#34d399','#22d3ee','#fbbf24','#fb7185','#a78bfa','#f97316','#4ade80','#f472b6','#60a5fa','#e2e8f0','#facc15','#2dd4bf'];
const AI_NAMES=['灵蛇','幻影','疾风','雷霆','青竹','赤焰','玄冰','紫电','追光','贪吃'];
const ITEM_KINDS=['shield','magnet','boost','stealth'];

function rnd(n){return Math.random()*n}

// 点位采样：广播时减少点数量，降带宽（保底 60 点，蛇身圆润不卡）
function ptsSampled(pts){
  const step=Math.max(1,Math.floor(pts.length/60));
  if(step===1)return pts.map(p=>[p.x|0,p.y|0]);
  const out=[];
  for(let i=0;i<pts.length;i+=step)out.push([pts[i].x|0,pts[i].y|0]);
  return out;
}

// ---------- 房间 ----------
const ROUND_MS=process.env.ROUND_MS?(+process.env.ROUND_MS):30*60*1000; // 每轮时长：默认 30 分钟（环境变量可覆盖，测试用）
const DECAY_AFTER=50;        // 大蛇萎缩阈值：经验超过此值后开始自然流失
const DECAY_RATE=0.01;       // 每 tick 流失（=0.2 经验/秒）
function createRoom(code){
  const room={
    code,
    snakes:new Map(),foods:new Map(),items:new Map(),
    corpses:new Map(),          // id -> 尸体（死亡蛇身）
    deadQueue:[],nextId:1,aiCount:0,
    prevFoods:new Set(),prevItems:new Set(),aiCheck:0,
    lastActiveAt:Date.now(),    // 最后活跃时间（房间销毁用）
    timers:[],                  // 房间内待清理的定时器
    roundEndsAt:Date.now()+ROUND_MS, // 本轮结束时间
    bonus:{}                    // 上轮奖励：蛇 id -> 起始经验加成
  };
  spawnFood(room,FOOD_TARGET);
  spawnAI(room,AI_TARGET);
  ensureItems(room);
  return room;
}
const rooms=new Map();
const DEFAULT_CODE='global';
const MAX_ROOMS=40; // 房间数硬上限：防恶意创建大量房间拖垮免费实例（每房 12 AI + 650 食物）
function getRoom(code){
  const c=String(code||DEFAULT_CODE).slice(0,12)||DEFAULT_CODE;
  if(!rooms.has(c)){
    // 达到上限：非默认房间拒绝创建，回落到默认房间（默认房间缺失则重建）
    if(rooms.size>=MAX_ROOMS){
      if(!rooms.has(DEFAULT_CODE))rooms.set(DEFAULT_CODE,createRoom(DEFAULT_CODE));
      const fb=rooms.get(DEFAULT_CODE);
      fb.lastActiveAt=Date.now();
      return fb;
    }
    rooms.set(c,createRoom(c));
  }
  const room=rooms.get(c);
  room.lastActiveAt=Date.now();
  return room;
}
// 清理空房间：无真实玩家（真人连接）立即销毁并释放定时器
// 默认 global 房间同样适用：没人就来，有人来再重建
function cleanRooms(){
  for(const [code,room] of rooms){
    let anyPlayer=false;
    // ws 在线或 offline 重连窗口期内都算活跃（防止重连时房间已被销毁）
    for(const s of room.snakes.values()){if(s.ws||s.offline){anyPlayer=true;break}}
    if(!anyPlayer){
      for(const t of room.timers)clearTimeout(t);
      rooms.delete(code);
    }
  }
}

// ---------- 生成 ----------
function spawnFood(room,n){
  // 中心密集：65% 食物集中在中心 28% 半径区域，其余分散全图
  // 逼着蛇往中间聚集，战斗自然发生
  for(let i=0;i<n;i++){
    const id='f'+(room.nextId++);
    const big=rnd(1)<0.15;
    let x,y;
    if(rnd(1)<0.65){
      const a=rnd(Math.PI*2);
      const r=rnd(WORLD*0.28);
      x=WORLD/2+Math.cos(a)*r;
      y=WORLD/2+Math.sin(a)*r;
    }else{
      x=40+rnd(WORLD-80);y=40+rnd(WORLD-80);
    }
    room.foods.set(id,{id,x,y,big});
  }
}
function spawnItem(room){
  const kind=ITEM_KINDS[Math.floor(rnd(ITEM_KINDS.length))];
  const id='i'+(room.nextId++);
  // 道具偏向中心区域（50% 概率），避免刷在死角
  let x,y;
  if(rnd(1)<0.5){
    const a=rnd(Math.PI*2),r=rnd(WORLD*0.3);
    x=WORLD/2+Math.cos(a)*r;y=WORLD/2+Math.sin(a)*r;
  }else{
    x=100+rnd(WORLD-200);y=100+rnd(WORLD-200);
  }
  room.items.set(id,{id,kind,x,y});
}
function ensureItems(room){
  while(room.items.size<ITEM_TARGET)spawnItem(room);
}
function spawnAI(room,n){
  for(let i=0;i<n;i++){
    const name=AI_NAMES[room.aiCount%AI_NAMES.length]+(Math.floor(room.aiCount/AI_NAMES.length)||'');
    room.aiCount++;
    const s=createSnake(room,null,'AI·'+name);
    s.ai=true;
    s.thinkTimer=0;
    room.snakes.set(s.id,s);
  }
}
// 安全出生点：避开所有蛇头至少 350px（防出生杀）
function safeSpawn(room){
  for(let tries=0;tries<12;tries++){
    const x=200+rnd(WORLD-400),y=200+rnd(WORLD-400);
    let ok=true;
    for(const t of room.snakes.values()){
      if(!t.alive)continue;
      const th=headOf(t);
      const dx=th.x-x,dy=th.y-y;
      if(dx*dx+dy*dy<350*350){ok=false;break}
    }
    if(ok)return{x,y};
  }
  return{x:200+rnd(WORLD-400),y:200+rnd(WORLD-400)};
}
function createSnake(room,ws,name,skin){
  const id='s'+(room.nextId++);
  const angle=rnd(Math.PI*2);
  const pos=safeSpawn(room);
  const s={
    id,ws,name:name||('玩家'+Math.floor(100+rnd(900))),
    color:COLORS[Math.floor(rnd(COLORS.length))],
    skin:skin||'',
    x:pos.x,y:pos.y,
    angle,boost:false,targetLen:12,score:0,kills:0,
    points:[],alive:true,
    boostHeld:false,ai:false,thinkTimer:0,paused:false,
    protectUntil:Date.now()+PROTECT_MS,
    effects:{},lastKillAt:0,killStreak:0,emoteUntil:0,
    sessionToken:'st'+Math.random().toString(36).slice(2)+Date.now().toString(36),
    offline:false,offlineUntil:0
  };
  for(let i=0;i<12;i++){
    s.points.push({x:s.x-i*9*Math.cos(angle),y:s.y-i*9*Math.sin(angle)});
  }
  return s;
}

function headOf(s){return s.points[0]}

// ---------- 冲刺（Dash） ----------
const DASH_COOLDOWN=3500;
function doDash(room,s){
  const now=Date.now();
  if(now-(s.lastDash||0)<DASH_COOLDOWN)return;
  s.lastDash=now;
  // 整体瞬移：整条蛇沿当前方向平移 DASH_DIST，不拉伸不断尾
  const dx=Math.cos(s.angle)*110,dy=Math.sin(s.angle)*110;
  let ok=true;
  for(const p of s.points){
    if(p.x+dx<BODY_R||p.x+dx>WORLD-BODY_R||p.y+dy<BODY_R||p.y+dy>WORLD-BODY_R){ok=false;break}
  }
  if(ok){
    for(const p of s.points){p.x+=dx;p.y+=dy}
    s.x+=dx;s.y+=dy;
    // 广播位移量+方向，前端本地同步瞬移（避免偏差触发拉回抖动）
    broadcast(room,{type:'dash',id:s.id,x:Math.round(s.x),y:Math.round(s.y),dx:Math.round(dx),dy:Math.round(dy),a:s.angle});
  }else{
    broadcast(room,{type:'dash',id:s.id,x:Math.round(s.x),y:Math.round(s.y),dx:0,dy:0,a:s.angle});
  }
}

// ---------- AI ----------
function thinkAI(room,s,objGrid){
  if(!s.alive||!s.ai)return;
  const h=headOf(s);
  const MARGIN=180;
  let wallTarget=null;
  if(h.x<MARGIN)wallTarget=0;
  else if(h.x>WORLD-MARGIN)wallTarget=Math.PI;
  else if(h.y<MARGIN)wallTarget=Math.PI/2;
  else if(h.y>WORLD-MARGIN)wallTarget=-Math.PI/2;
  // 危险检测：只怕比自己分高的蛇头逼近（小蛇接近不逃，AI 会主动猎杀）
  let danger=null,dangerDist=240;
  for(const t of room.snakes.values()){
    if(!t.alive||t.id===s.id)continue;
    if(t.score<s.score)continue;
    const th=headOf(t);
    const d=Math.hypot(th.x-h.x,th.y-h.y);
    if(d<dangerDist){danger={x:th.x,y:th.y};dangerDist=d}
  }
  // 追猎：找比自己分低且较近的蛇（AI 主动攻击）
  let prey=null,preyDist=420;
  for(const t of room.snakes.values()){
    if(!t.alive||t.id===s.id)continue;
    if(t.score>=s.score)continue;
    const th=headOf(t);
    const d=Math.hypot(th.x-h.x,th.y-h.y);
    if(d<preyDist){prey={x:th.x,y:th.y,ang:t.angle};preyDist=d}
  }
  // 尸体：最近的未吃尸体（AI 会扑食）
  let corpse=null,cpDist=500;
  for(const cp of room.corpses.values()){
    if(cp.eaten||!cp.points.length)continue;
    const p=cp.points[0];
    const d=Math.hypot(p[0]-h.x,p[1]-h.y);
    if(d<cpDist){corpse={x:p[0],y:p[1]};cpDist=d}
  }
  let target=null;
  if(wallTarget!=null){
    target=wallTarget;
  }else if(danger&&dangerDist<170){
    // 逃离：垂直于威胁方向
    const a=Math.atan2(h.y-danger.y,h.x-danger.x);
    target=a+(Math.random()<0.5?Math.PI/2:-Math.PI/2);
  }else if(prey&&preyDist<320){
    // 追猎带拦截角：瞄准猎物头前方 60px（预判走位）
    target=Math.atan2(prey.y+Math.sin(prey.ang)*60-h.y,prey.x+Math.cos(prey.ang)*60-h.x);
  }else if(corpse&&cpDist<420){
    target=Math.atan2(corpse.y-h.y,corpse.x-h.x);
  }else{
    // 寻食：查 objGrid 局部格子（3×3 格平均 3.6 个食物，足够；罕见空时扩 5×5）
    // 替代每决策周期全量遍历 650 食物，AI 决策 CPU 降 ~90%
    let best=null,bd=1e18;
    const cx=(h.x/CELL)|0,cy=(h.y/CELL)|0;
    for(let r=1;r<=2;r++){
      for(let gx=cx-r;gx<=cx+r;gx++){
        for(let gy=cy-r;gy<=cy+r;gy++){
          const arr=objGrid.get(gx+','+gy);
          if(!arr)continue;
          for(const item of arr){
            if(item[0]!=='f')continue;
            const f=item[1];
            const dx=f.x-h.x,dy=f.y-h.y;
            const d=dx*dx+dy*dy;
            if(d<bd){bd=d;best=f}
          }
        }
      }
      if(best||r===2)break; // 3×3 找到即停；没有则用 5×5 结果
    }
    target=best?Math.atan2(best.y-h.y,best.x-h.x):s.angle+(rnd(1)-0.5)*0.6;
  }
  if(target!=null){
    let d=target-s.angle;
    while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;
    s.angle+=d*0.09;
    s.angle+=(rnd(1)-0.5)*0.035;
  }
  // 加速：危险近身或追猎近距时 boost
  s.boost=!!(danger&&dangerDist<200)||!!(prey&&preyDist<220);
}

// ---------- 移动/进食 ----------
// 静态对象网格（食物+道具）：蛇头只查周围 3×3 格，替代每 tick 全量遍历 650 食物
// 磁铁半径 70 < CELL=100，3×3 查询等价不漏判
function buildObjectGrid(room){
  const grid=new Map();
  for(const f of room.foods.values()){
    const k=((f.x/CELL)|0)+','+((f.y/CELL)|0);
    let arr=grid.get(k);if(!arr){arr=[];grid.set(k,arr)}
    arr.push(['f',f]);
  }
  for(const it of room.items.values()){
    const k=((it.x/CELL)|0)+','+((it.y/CELL)|0);
    let arr=grid.get(k);if(!arr){arr=[];grid.set(k,arr)}
    arr.push(['i',it]);
  }
  return grid;
}
function move(room,s){
  const h=headOf(s);
  const now=Date.now();
  const freeBoost=!!(s.effects.boost&&now<s.effects.boost);
  const sp=s.boost?SPEED_BOOST:SPEED;
  let nx=h.x+Math.cos(s.angle)*sp,ny=h.y+Math.sin(s.angle)*sp;
  if(nx<BODY_R||nx>WORLD-BODY_R||ny<BODY_R||ny>WORLD-BODY_R)return false;
  s.points.unshift({x:nx,y:ny});
  // 加速燃烧经验（磁铁/极速道具期间不消耗）
  if(s.boost&&!freeBoost)s.score=Math.max(0,s.score-0.003);
  const keep=Math.floor(s.targetLen*0.5)+10;
  while(s.points.length>keep)s.points.pop();
  s.x=nx;s.y=ny;
  return true;
}

function eatFood(room,s,grid){
  const h=headOf(s);
  const now=Date.now();
  const magnet=!!(s.effects.magnet&&now<s.effects.magnet);
  const r=magnet?70:13;
  const cx=(h.x/CELL)|0,cy=(h.y/CELL)|0;
  for(let gx=cx-1;gx<=cx+1;gx++){
    for(let gy=cy-1;gy<=cy+1;gy++){
      const arr=grid.get(gx+','+gy);
      if(!arr)continue;
      for(const item of arr){
        if(item[0]!=='f')continue;
        const f=item[1];
        const dx=h.x-f.x,dy=h.y-f.y;
        const eatR=f.big?18:r;
        if(dx*dx+dy*dy<eatR*eatR){
          room.foods.delete(f.id);
          if(f.big)s.score+=5;
          else s.score+=1;
          s.ateFoods=s.ateFoods||[];
          s.ateFoods.push({x:f.x,y:f.y,big:f.big});
        }
      }
    }
  }
}
function pickupItems(room,s,grid){
  const h=headOf(s);
  const now=Date.now();
  const cx=(h.x/CELL)|0,cy=(h.y/CELL)|0;
  for(let gx=cx-1;gx<=cx+1;gx++){
    for(let gy=cy-1;gy<=cy+1;gy++){
      const arr=grid.get(gx+','+gy);
      if(!arr)continue;
      for(const item of arr){
        if(item[0]!=='i')continue;
        const it=item[1];
        const dx=h.x-it.x,dy=h.y-it.y;
        if(dx*dx+dy*dy<18*18){
          room.items.delete(it.id);
          s.effects[it.kind]=now+ITEM_DUR[it.kind];
          broadcast(room,{type:'item',id:s.id,kind:it.kind,x:Math.round(it.x),y:Math.round(it.y)});
        }
      }
    }
  }
}

// ---------- 死亡 ----------
function kill(room,s,why){
  s.alive=false;
  // 死亡：蛇身变尸体流（保留身体供其他蛇啃食，8 秒后腐烂消失）
  if(s.points.length>=6){
    const cid='c'+(room.nextId++);
    const pts=s.points.map(p=>[p.x|0,p.y|0]);
    room.corpses.set(cid,{id:cid,points:pts,color:s.color,name:s.name,expireAt:Date.now()+8000});
  }
  // 少量碎片散落
  const newFoods=[];
  const step=Math.max(14,Math.floor(s.points.length/24));
  for(let i=0;i<s.points.length;i+=step){
    const p=s.points[i];
    if(rnd(1)<0.5){
      const id='f'+(room.nextId++);
      room.foods.set(id,{id,x:p.x,y:p.y,big:false});
      newFoods.push(id);
    }
  }
  room.deadQueue.push({id:s.id,at:Date.now(),ai:s.ai});
  // 玩家死亡上报名人堂（AI 不计）
  if(!s.ai&&!s.offline)addToHall(s.name,Math.round(s.score),s.kills||0);
  broadcast(room,{type:'death',id:s.id,x:Math.round(s.x),y:Math.round(s.y),foods:newFoods,why:why||''});
  if(s.ws){
    try{s.ws.send(JSON.stringify({type:'gameover',len:Math.round(s.targetLen),score:s.score,kills:s.kills,rank:currentRank(room,s.id)}));}catch(e){}
  }
}

// ---------- 名人堂（内存版 Top50；后续可平滑升级 CloudBase 云数据库） ----------
const hallOfFame=[]; // {name,score,kills,at}
function addToHall(name,score,kills){
  if(!name||name.startsWith('AI·')||score<=0)return;
  hallOfFame.push({name:String(name).slice(0,12),score,kills:kills||0,at:Date.now()});
  hallOfFame.sort((a,b)=>b.score-a.score);
  if(hallOfFame.length>50)hallOfFame.length=50;
}

function currentRank(room,id){
  const list=[...room.snakes.values()].filter(x=>x.alive).sort((a,b)=>b.score-a.score);
  return list.findIndex(x=>x.id===id)+1;
}

// ---------- 轮次结算 ----------
// 每 30 分钟一轮：结算前三名（下一轮起始经验加成），重置世界与蛇身重新开战
function endRound(room){
  const now=Date.now();
  const rank=[...room.snakes.values()].filter(s=>s.alive).sort((a,b)=>b.score-a.score).slice(0,10)
    .map((s,i)=>({n:i+1,id:s.id,name:s.name,score:Math.round(s.score),kills:s.kills||0}));
  // 前三名上报名人堂 + 下轮起始加成（🥇+5 🥈+3 🥉+2）
  const prizes={0:5,1:3,2:2};
  const bonus={};
  rank.slice(0,3).forEach((r,i)=>{
    if(!r.name.startsWith('AI·'))addToHall(r.name,r.score,r.kills);
    bonus[r.id]=prizes[i];
  });
  // 重置世界
  room.foods.clear();room.corpses.clear();room.deadQueue=[];
  spawnFood(room,FOOD_TARGET);
  room.items.clear();ensureItems(room);
  // 蛇全部重生（保持连接，score 归零 + 新手保护）
  for(const s of room.snakes.values()){
    s.alive=true;s.score=0;s.kills=0;s.targetLen=12;
    s.paused=false;
    // 断线中的蛇保持 offline（ws=null 不复活成僵尸蛇，重连窗口保留）
    if(!s.ws){s.offline=true;s.offlineUntil=Math.max(s.offlineUntil||0,now+30000);}
    else s.offline=false;
    s.boost=false;s.effects={};s.lastKillAt=0;s.killStreak=0;
    s.protectUntil=now+PROTECT_MS;
    const pos=safeSpawn(room);
    s.x=pos.x;s.y=pos.y;s.angle=rnd(Math.PI*2);
    s.points=[];
    for(let i=0;i<12;i++)s.points.push({x:s.x-i*9*Math.cos(s.angle),y:s.y-i*9*Math.sin(s.angle)});
    if(bonus[s.id])s.score=bonus[s.id];
  }
  room.roundEndsAt=now+ROUND_MS;
  broadcast(room,{type:'roundEnd',rank});
}

// ---------- 主循环 ----------
// ---------- 空间索引 ----------
const CELL=100; // 网格大小（px）；hitR 上限 42 < CELL，3×3 查询不漏判
function buildGrid(room){
  const grid=new Map();
  for(const t of room.snakes.values()){
    if(!t.alive)continue;
    for(const p of t.points){
      const k=((p.x/CELL)|0)+','+((p.y/CELL)|0);
      let arr=grid.get(k);
      if(!arr){arr=[];grid.set(k,arr)}
      arr.push([t,p]);
    }
  }
  return grid;
}

function tick(){
  for(const room of rooms.values()){
    tickRoom(room);
  }
  cleanRooms();
}
function tickRoom(room){
  const now=Date.now();
  // 轮次到期：结算并重置，进入下一轮
  if(now>room.roundEndsAt){endRound(room);return}
  // 静态对象网格（食物+道具）供本 tick 拾取查询
  const objGrid=buildObjectGrid(room);
  for(const s of room.snakes.values()){
    if(!s.alive||s.paused||s.offline)continue;
    s.targetLen=Math.max(6,12+s.score);
    // 大蛇萎缩：经验超过阈值后自然流失，必须持续吃球维持
    if(s.score>DECAY_AFTER)s.score=Math.max(DECAY_AFTER,s.score-DECAY_RATE);
    if(s.ai){
      s.thinkTimer=(s.thinkTimer||0)-1;
      if(s.thinkTimer<=0){thinkAI(room,s,objGrid);s.thinkTimer=3}
    }
    const moved=move(room,s);
    if(!moved){kill(room,s,'wall');continue}
    eatFood(room,s,objGrid);
    pickupItems(room,s,objGrid);
  }
  // 碰撞：新手保护/护盾/隐身期间免碰撞；大鱼吃小鱼
  // 注意：暂停的蛇不动但【仍可被吃】（防暂停无敌漏洞）
  // 网格空间索引：100px 格子，蛇身点注册，蛇头只查周围 3×3 格（hitR 上限 42 < CELL，等价不漏判）
  const grid=buildGrid(room);
  for(const s of room.snakes.values()){
    if(!s.alive)continue;
    const h=headOf(s);
    const cx=(h.x/CELL)|0,cy=(h.y/CELL)|0;
    const done=new Set(); // 蛇级条件已通过，多点复用跳过重复条件判断
    for(let gx=cx-1;gx<=cx+1;gx++){
      for(let gy=cy-1;gy<=cy+1;gy++){
        const arr=grid.get(gx+','+gy);
        if(!arr)continue;
        for(const item of arr){
          const t=item[0],p=item[1];
          if(t.id===s.id||!t.alive||done.has(t.id))continue;
          if(now<t.protectUntil)continue;             // 对方保护中：不能吃它
          if((s.effects.shield&&now<s.effects.shield)||(t.effects.shield&&now<t.effects.shield))continue;
          if(t.effects.stealth&&now<t.effects.stealth)continue;
          done.add(t.id);
          const hitR=Math.min(42,19+(Math.sqrt(s.score)+Math.sqrt(t.score))*0.5);
          const dx=h.x-p.x,dy=h.y-p.y;
          if(dx*dx+dy*dy<hitR*hitR){
            if(s.score>t.score){
              t.eatenBy=s.name;
              const now2=Date.now();
              if(now2-(s.lastKillAt||0)<5000)s.killStreak=(s.killStreak||0)+1;
              else s.killStreak=1;
              s.lastKillAt=now2;
              const mult=s.killStreak>=2?1.5:1;
              const gained=Math.max(1,Math.floor(t.score*mult));
              s.score+=gained;
              s.kills=(s.kills||0)+1;
              kill(room,t,'eaten:'+s.name);
              broadcast(room,{type:'eat',killer:s.id,target:t.id,killerName:s.name,targetName:t.name,x:Math.round(p.x),y:Math.round(p.y),gained});
              if(s.killStreak>=2)broadcast(room,{type:'killstreak',killer:s.id,count:s.killStreak});
            }else if(t.score>s.score){
              // 自己保护中或隐身：免疫被杀（但对方保护中已在上方排除）
              if(!(now<s.protectUntil)&&!(s.effects.stealth&&now<s.effects.stealth)){
                kill(room,s,'hit:'+t.name);
              }
            }
            break;
          }
        }
        if(!s.alive)break;
      }
      if(!s.alive)break;
    }
  }
  // 啃食尸体：蛇头碰到尸体任一点 → 整具尸体被吃，蛇获得尸体剩余经验
  for(const s of room.snakes.values()){
    if(!s.alive||s.paused)continue;
    const h=headOf(s);
    for(const [cid,cp] of room.corpses){
      if(cp.eaten)continue;
      for(let i=0;i<cp.points.length;i+=3){
        const p=cp.points[i];
        const dx=h.x-p[0],dy=h.y-p[1];
        if(dx*dx+dy*dy<20*20){
          cp.eaten=true;
          room.corpses.delete(cid);
          const gained=Math.max(1,Math.floor(cp.points.length/3));
          s.score+=gained;
          s.targetLen=Math.max(6,12+s.score);
          broadcast(room,{type:'corpseEat',id:s.id,cid,x:Math.round(p[0]),y:Math.round(p[1]),gained});
          break;
        }
      }
      if(cp.eaten)break;
    }
  }
  // 尸体腐烂过期
  for(const [cid,cp] of [...room.corpses]){
    if(now>cp.expireAt){
      room.corpses.delete(cid);
      // 腐烂：尸体变成少量食物
      const step=Math.max(12,Math.floor(cp.points.length/10));
      for(let i=0;i<cp.points.length;i+=step){
        if(rnd(1)<0.5){
          const p=cp.points[i];
          const id='f'+(room.nextId++);
          room.foods.set(id,{id,x:p[0],y:p[1],big:false});
        }
      }
    }
  }
  // 清理死亡蛇；AI 复活
  for(let i=room.deadQueue.length-1;i>=0;i--){
    if(now-room.deadQueue[i].at>3000){
      const d=room.deadQueue[i];
      room.snakes.delete(d.id);
      if(d.ai){
        const t=setTimeout(()=>{if(rooms.has(room.code))spawnAI(room,1)},2000+rnd(5000));
        room.timers.push(t);
      }
      room.deadQueue.splice(i,1);
    }
  }
  // 定期补充 AI
  if(now-(room.aiCheck||0)>2000){
    room.aiCheck=now;
    let aiAlive=0;
    for(const s of room.snakes.values())if(s.alive&&s.ai)aiAlive++;
    if(aiAlive<AI_TARGET)spawnAI(room,AI_TARGET-aiAlive);
  }
  // 离线玩家超时清理（30s 内可重连，超时移除）
  for(const [id,s] of [...room.snakes]){
    if(s.offline&&now>s.offlineUntil)room.snakes.delete(id);
  }
  ensureItems(room);
  broadcastState(room);
}

// ---------- 广播 ----------
function broadcast(room,obj){
  const data=JSON.stringify(obj);
  for(const s of room.snakes.values()){
    if(!s.ws)continue;
    try{s.ws.send(data)}catch(e){}
  }
}
function effObj(s,now){
  return {shield:Math.max(0,(s.effects.shield||0)-now),magnet:Math.max(0,(s.effects.magnet||0)-now),
    boost:Math.max(0,(s.effects.boost||0)-now),stealth:Math.max(0,(s.effects.stealth||0)-now)};
}
const VIEW_IN=1250, VIEW_OUT=1500; // AOI 滞回：进视野 1250 / 出视野 1500，中间区间保持上次状态，消除边缘闪烁
// 蛇对象统一构建（不含 points）：broadcastState/sendInit 复用，保证字段一致
function snakeMsg(s,now){
  return {id:s.id,name:s.name,color:s.color,skin:s.skin,x:Math.round(s.x),y:Math.round(s.y),
    len:Math.round(s.targetLen),score:s.score,boost:s.boost,kills:s.kills||0,
    prot:now<s.protectUntil,fx:effObj(s,now)};
}
function broadcastState(room){
  const now=Date.now();
  const fadd=[],fdel=[],iadd=[],idel=[];
  let online=0;
  // 每条蛇的元数据（不含 points），视野裁剪时复用
  const metas=new Map();
  for(const s of room.snakes.values()){
    if(!s.alive)continue;
    if(s.ws)online++;
    metas.set(s.id,snakeMsg(s,now));
  }
  const cur=[...room.foods.keys()];
  for(const id of cur)if(!room.prevFoods.has(id))fadd.push(room.foods.get(id));
  for(const id of room.prevFoods)if(!room.foods.has(id))fdel.push(id);
  room.prevFoods=new Set(cur);
  const ics=[...room.items.keys()];
  for(const id of ics)if(!room.prevItems.has(id))iadd.push(room.items.get(id));
  for(const id of room.prevItems)if(!room.items.has(id))idel.push(id);
  room.prevItems=new Set(ics);
  // 尸体全量广播（数量少，直接全发，前端幂等覆盖）
  const corpses=[...room.corpses.values()].map(cp=>({id:cp.id,points:ptsSampled(cp.points),color:cp.color,name:cp.name}));
  const sorted=[...room.snakes.values()].filter(s=>s.alive).sort((a,b)=>b.score-a.score);
  const rank=sorted.map((s,i)=>({n:i+1,id:s.id,name:s.name,len:Math.round(s.targetLen),score:s.score}));
  const eats=[];
  for(const s of room.snakes.values()){
    if(s.ateFoods&&s.ateFoods.length){eats.push({id:s.id,x:s.x,y:s.y,f:s.ateFoods});s.ateFoods=[]}
  }
  // 公共载荷序列化一次，蛇数组按玩家视野个性化（滞回裁剪防边缘闪烁）
  const roundRemain=Math.max(0,Math.round((room.roundEndsAt-now)/1000));
  const base=JSON.stringify({fadd,fdel,rank,eats,online,iadd,idel,corpses,roundRemain});
  for(const p of room.snakes.values()){
    if(!p.ws)continue;
    if(!p._full)p._full=new Map(); // 该玩家视角下各蛇的"上次完整状态"（per-player 滞回）
    const sn=[];
    for(const s of room.snakes.values()){
      if(!s.alive)continue;
      const m=metas.get(s.id);
      const dx=p.x-s.x,dy=p.y-s.y;
      const d2=dx*dx+dy*dy;
      const prev=p._full.get(s.id)===true;
      const full = d2<VIEW_IN*VIEW_IN ? true : (d2>VIEW_OUT*VIEW_OUT ? false : prev);
      p._full.set(s.id,full);
      if(full){
        sn.push({...m,points:ptsSampled(s.points)});
      }else{
        sn.push(m);
      }
    }
    try{p.ws.send('{"type":"state","snakes":'+JSON.stringify(sn)+','+base.slice(1))}catch(e){}
  }
}

function sendInit(ws,room,s){
  const now=Date.now();
  const allSnakes=[...room.snakes.values()].filter(x=>x.alive)
    .map(x=>({...snakeMsg(x,now),points:ptsSampled(x.points)}));
  ws.send(JSON.stringify({type:'init',selfId:s.id,selfColor:s.color,selfSkin:s.skin,world:WORLD,
    room:room.code,token:s.sessionToken,
    snakes:allSnakes,
    foods:[...room.foods.values()].map(f=>({id:f.id,x:f.x|0,y:f.y|0,big:!!f.big})),
    items:[...room.items.values()],
    corpses:[...room.corpses.values()].map(cp=>({id:cp.id,points:ptsSampled(cp.points),color:cp.color,name:cp.name}))}));
  // 玩家加入后：增量广播应从当前快照之后开始（防重复）
  room.prevFoods=new Set([...room.foods.keys()]);
  room.prevItems=new Set([...room.items.keys()]);
}

// ---------- 连接 ----------
// 每连接频率限制：input ≤60/s（客户端 25ms 一发=40/s，留余量）、emote ≤2/s
const RATE={input:60,emote:2};
function rateLimit(ws,key){
  const now=Date.now();
  if(!ws.rate)ws.rate={};
  const arr=ws.rate[key]=(ws.rate[key]||[]).filter(t=>now-t<1000);
  if(arr.length>=RATE[key])return false;
  arr.push(now);
  return true;
}
wss.on('connection',ws=>{
  ws.isAlive=true;
  ws.on('pong',()=>ws.isAlive=true);
  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw)}catch(e){return}
    if(!msg||!msg.type)return;
    if(msg.type==='rejoin'){
      // 断线重连：按 sessionToken 找回原蛇恢复原位
      const token=String(msg.token||'');
      const code=String(msg.room||'').replace(/[^\w]/g,'').slice(0,12)||DEFAULT_CODE;
      const room=getRoom(code);
      let s=null;
      if(room)for(const x of room.snakes.values()){
        if(x.sessionToken===token){s=x;break}
      }
      if(s&&s.alive&&!s.ai){
        s.ws=ws;ws.snake=s;
        s.offline=false;s.offlineUntil=0;
        s.paused=false;
        sendInit(ws,room,s);
        broadcast(room,{type:'rejoin',id:s.id,name:s.name});
        return;
      }
      // 找不到或已死：按新加入处理
      if(ws.snake&&ws.snake.room){ws.snake.room.snakes.delete(ws.snake.id)}
      const ns=createSnake(room,ws,String(msg.name||'').replace(/[^\u4e00-\u9fa5A-Za-z0-9_·\s]/g,'').slice(0,12),String(msg.skin||'').replace(/[^\w]/g,'').slice(0,12));
      ns.room=room;
      ws.snake=ns;
      room.snakes.set(ns.id,ns);
      // 上轮奖励：起始经验加成（与 join 分支一致）
      if(room.bonus&&room.bonus[ns.id]){ns.score=room.bonus[ns.id];delete room.bonus[ns.id]}
      sendInit(ws,room,ns);
      return;
    }
    if(msg.type==='join'||msg.type==='respawn'){
      const room=getRoom(String(msg.room||'').replace(/[^\w]/g,'').slice(0,12)||DEFAULT_CODE);
      if(ws.snake&&ws.snake.room!==room){ws.snake.room.snakes.delete(ws.snake.id)}
      const s=createSnake(room,ws,String(msg.name||'').replace(/[^\u4e00-\u9fa5A-Za-z0-9_·\s]/g,'').slice(0,12),String(msg.skin||'').replace(/[^\w]/g,'').slice(0,12));
      s.room=room;
      ws.snake=s;
      room.snakes.set(s.id,s);
      // 上轮奖励：起始经验加成
      if(room.bonus&&room.bonus[s.id]){s.score=room.bonus[s.id];delete room.bonus[s.id]}
      sendInit(ws,room,s);
    }else if(msg.type==='input'&&ws.snake&&ws.snake.alive&&!ws.snake.paused&&!ws.snake.offline){
      if(!rateLimit(ws,'input'))return;
      // 输入校验：angle 必须为有限数字并归一化到 [-2π,2π]，boost 转布尔
      const a=+msg.angle;
      if(Number.isFinite(a))ws.snake.angle=((a%(Math.PI*2))+Math.PI*2)%(Math.PI*2);
      ws.snake.boost=!!msg.boost;
    }else if(msg.type==='pause'&&ws.snake){
      ws.snake.paused=!!msg.paused;
    }else if(msg.type==='dash'&&ws.snake&&ws.snake.alive&&!ws.snake.paused&&!ws.snake.offline){
      doDash(ws.snake.room,ws.snake);
    }else if(msg.type==='emote'&&ws.snake&&ws.snake.alive){
      if(!rateLimit(ws,'emote'))return;
      ws.snake.emote=String(msg.em||'').slice(0,4);
      ws.snake.emoteUntil=Date.now()+2500;
      const room=ws.snake.room;
      broadcast(room,{type:'emote',id:ws.snake.id,em:ws.snake.emote});
    }
  });
  // 断开：蛇保留 30s（offline 可被吃，防无敌；30s 内可凭 token 重连恢复）
  ws.on('close',()=>{
    const s=ws.snake;
    if(s&&s.room&&!s.ai){
      s.offline=true;s.offlineUntil=Date.now()+30000;
      s.ws=null;
    }
  });
});

setInterval(tick,TICK_MS);
setInterval(()=>{
  for(const ws of wss.clients){
    if(!ws.isAlive){ws.terminate();continue}
    ws.isAlive=false;ws.ping();
  }
},10000);

// ---------- 健康检查与日志 ----------
const STARTED_AT=Date.now();
function healthInfo(){
  let roomsActive=0,online=0,aiTotal=0,players=0;
  for(const [code,room] of rooms){
    if(room.snakes.size===0)continue;
    roomsActive++;
    for(const s of room.snakes.values()){
      if(!s.alive)continue;
      if(s.ai)aiTotal++;else players++;
      if(s.ws)online++;
    }
  }
  return {
    status:'ok',
    uptimeSec:Math.round((Date.now()-STARTED_AT)/1000),
    rooms:roomsActive,
    online,
    ai:aiTotal,
    players,
    memMB:Math.round(process.memoryUsage().rss/1048576)
  };
}
// 每 30s 输出一行结构化日志（Railway 日志面板可查）
setInterval(()=>{
  const h=healthInfo();
  console.log(JSON.stringify({t:new Date().toISOString(),...h}));
},30000);

server.listen(PORT,()=>console.log('SNAKE ARENA SERVER READY at http://localhost:'+PORT));
