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
  let f=req.url==='/'?'index.html':decodeURIComponent(req.url.split('?')[0].slice(1));
  if(f.includes('..')){res.writeHead(403);res.end();return}
  fs.readFile(path.join(__dirname,f),(e,d)=>{
    if(e){res.writeHead(404);res.end('404');return}
    res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream'});
    res.end(d);
  });
});
const wss=new WebSocketServer({server});

const COLORS=['#34d399','#22d3ee','#fbbf24','#fb7185','#a78bfa','#f97316','#4ade80','#f472b6','#60a5fa','#e2e8f0','#facc15','#2dd4bf'];
const AI_NAMES=['灵蛇','幻影','疾风','雷霆','青竹','赤焰','玄冰','紫电','追光','贪吃'];
const ITEM_KINDS=['shield','magnet','boost','stealth'];

function rnd(n){return Math.random()*n}

// 点位采样：广播时减少点数量，降带宽（每3点取1；蛇越长采样越密保证平滑）
function ptsSampled(pts){
  const step=Math.max(2,Math.floor(pts.length/40));
  const out=[];
  for(let i=0;i<pts.length;i+=step)out.push([pts[i].x|0,pts[i].y|0]);
  if(out.length<2)return pts.map(p=>[p.x|0,p.y|0]);
  return out;
}

// ---------- 房间 ----------
function createRoom(code){
  const room={
    code,
    snakes:new Map(),foods:new Map(),items:new Map(),
    corpses:new Map(),          // id -> 尸体（死亡蛇身）
    deadQueue:[],nextId:1,aiCount:0,
    prevFoods:new Set(),prevItems:new Set(),aiCheck:0,
    lastActiveAt:Date.now(),    // 最后活跃时间（房间销毁用）
    timers:[]                   // 房间内待清理的定时器
  };
  spawnFood(room,FOOD_TARGET);
  spawnAI(room,AI_TARGET);
  ensureItems(room);
  return room;
}
const rooms=new Map();
const DEFAULT_CODE='global';
const ROOM_TTL_MS=10*60*1000;   // 房间 10 分钟无人后销毁
rooms.set(DEFAULT_CODE,createRoom(DEFAULT_CODE));
function getRoom(code){
  const c=String(code||DEFAULT_CODE).slice(0,12)||DEFAULT_CODE;
  if(!rooms.has(c))rooms.set(c,createRoom(c));
  const room=rooms.get(c);
  room.lastActiveAt=Date.now();
  return room;
}
// 清理空房间：非默认房间 10 分钟无玩家且无 AI 活动则销毁
function cleanRooms(){
  const now=Date.now();
  for(const [code,room] of rooms){
    if(code===DEFAULT_CODE)continue;
    if(now-room.lastActiveAt>ROOM_TTL_MS){
      let anyPlayer=false;
      for(const s of room.snakes.values()){if(s.ws){anyPlayer=true;break}}
      if(!anyPlayer){
        for(const t of room.timers)clearTimeout(t);
        rooms.delete(code);
      }
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
  room.items.set(id,{id,kind,x:100+rnd(WORLD-200),y:100+rnd(WORLD-200)});
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
function createSnake(room,ws,name,skin){
  const id='s'+(room.nextId++);
  const angle=rnd(Math.PI*2);
  const s={
    id,ws,name:name||('玩家'+Math.floor(100+rnd(900))),
    color:COLORS[Math.floor(rnd(COLORS.length))],
    skin:skin||'',
    x:200+rnd(WORLD-400),y:200+rnd(WORLD-400),
    angle,boost:false,targetLen:12,score:0,kills:0,
    points:[],alive:true,
    boostHeld:false,ai:false,thinkTimer:0,paused:false,
    protectUntil:Date.now()+PROTECT_MS,
    effects:{},lastKillAt:0,killStreak:0,emoteUntil:0
  };
  for(let i=0;i<12;i++){
    s.points.push({x:s.x-i*9*Math.cos(angle),y:s.y-i*9*Math.sin(angle)});
  }
  return s;
}

function headOf(s){return s.points[0]}

// ---------- 冲刺断尾（Dash） ----------
const DASH_COOLDOWN=3500;
function doDash(room,s){
  const now=Date.now();
  if(now-(s.lastDash||0)<DASH_COOLDOWN)return;
  s.lastDash=now;
  // 断尾：把尾巴 25% 的点变成食物（经验球）
  const cut=Math.max(2,Math.floor(s.points.length*0.25));
  const newFoods=[];
  for(let i=s.points.length-cut;i<s.points.length;i+=2){
    const p=s.points[i];
    const id='f'+(room.nextId++);
    room.foods.set(id,{id,x:p.x,y:p.y,big:false});
    newFoods.push(id);
  }
  // 突进：沿当前方向猛冲一段距离
  const h=headOf(s);
  const nx=h.x+Math.cos(s.angle)*110, ny=h.y+Math.sin(s.angle)*110;
  if(nx>BODY_R&&nx<WORLD-BODY_R&&ny>BODY_R&&ny<WORLD-BODY_R){
    s.x=nx;s.y=ny;
    s.points.unshift({x:nx,y:ny});
    const keep=Math.floor(s.targetLen*0.5)+10;
    while(s.points.length>keep)s.points.pop();
  }
  broadcast(room,{type:'dash',id:s.id,x:Math.round(s.x),y:Math.round(s.y),foods:newFoods});
}

// ---------- AI ----------
function thinkAI(room,s){
  if(!s.alive||!s.ai)return;
  const h=headOf(s);
  const MARGIN=180;
  let wallTarget=null;
  if(h.x<MARGIN)wallTarget=0;
  else if(h.x>WORLD-MARGIN)wallTarget=Math.PI;
  else if(h.y<MARGIN)wallTarget=Math.PI/2;
  else if(h.y>WORLD-MARGIN)wallTarget=-Math.PI/2;
  let danger=null,dangerDist=240;
  for(const t of room.snakes.values()){
    if(!t.alive||t.id===s.id)continue;
    const th=headOf(t);
    const d=Math.hypot(th.x-h.x,th.y-h.y);
    if(d<dangerDist){danger={x:th.x,y:th.y};dangerDist=d}
  }
  let target=null;
  if(wallTarget!=null){
    target=wallTarget;
  }else if(danger&&dangerDist<170){
    const a=Math.atan2(h.y-danger.y,h.x-danger.x);
    target=a+(Math.random()<0.5?Math.PI/2:-Math.PI/2);
  }else{
    let best=null,bd=1e18;
    for(const f of room.foods.values()){
      const dx=f.x-h.x,dy=f.y-h.y;
      const d=dx*dx+dy*dy;
      if(d<bd){bd=d;best=f}
    }
    target=best?Math.atan2(best.y-h.y,best.x-h.x):s.angle+(rnd(1)-0.5)*0.6;
  }
  if(target!=null){
    let d=target-s.angle;
    while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;
    s.angle+=d*0.09;
    s.angle+=(rnd(1)-0.5)*0.035;
  }
  s.boost=!!(danger&&dangerDist<200);
}

// ---------- 移动/进食 ----------
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

function eatFood(room,s){
  const h=headOf(s);
  const now=Date.now();
  const magnet=!!(s.effects.magnet&&now<s.effects.magnet);
  const r=magnet?70:13;
  for(const [id,f] of room.foods){
    const dx=h.x-f.x,dy=h.y-f.y;
    const eatR=f.big?18:r;
    if(dx*dx+dy*dy<eatR*eatR){
      room.foods.delete(id);
      if(f.big)s.score+=5;
      else s.score+=1;
      s.ateFoods=s.ateFoods||[];
      s.ateFoods.push({x:f.x,y:f.y,big:f.big});
    }
  }
}
function pickupItems(room,s){
  const h=headOf(s);
  const now=Date.now();
  for(const [id,it] of room.items){
    const dx=h.x-it.x,dy=h.y-it.y;
    if(dx*dx+dy*dy<18*18){
      room.items.delete(id);
      s.effects[it.kind]=now+ITEM_DUR[it.kind];
      broadcast(room,{type:'item',id:s.id,kind:it.kind,x:Math.round(it.x),y:Math.round(it.y)});
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
  broadcast(room,{type:'death',id:s.id,x:Math.round(s.x),y:Math.round(s.y),foods:newFoods,why:why||''});
  if(s.ws){
    try{s.ws.send(JSON.stringify({type:'gameover',len:Math.round(s.targetLen),score:s.score,kills:s.kills,rank:currentRank(room,s.id)}));}catch(e){}
  }
}

function currentRank(room,id){
  const list=[...room.snakes.values()].filter(x=>x.alive).sort((a,b)=>b.score-a.score);
  return list.findIndex(x=>x.id===id)+1;
}

// ---------- 主循环 ----------
function tick(){
  for(const room of rooms.values()){
    tickRoom(room);
  }
  cleanRooms();
}
function tickRoom(room){
  const now=Date.now();
  for(const s of room.snakes.values()){
    if(!s.alive||s.paused)continue;
    s.targetLen=Math.max(6,12+s.score);
    if(s.ai){
      s.thinkTimer=(s.thinkTimer||0)-1;
      if(s.thinkTimer<=0){thinkAI(room,s);s.thinkTimer=3}
    }
    const moved=move(room,s);
    if(!moved){kill(room,s,'wall');continue}
    eatFood(room,s);
    pickupItems(room,s);
  }
  // 碰撞：新手保护/护盾/隐身期间免碰撞；大鱼吃小鱼
  for(const s of room.snakes.values()){
    if(!s.alive||s.paused)continue;
    const h=headOf(s);
    for(const t of room.snakes.values()){
      if(!t.alive||t.id===s.id||t.paused)continue;
      if(now<s.protectUntil||now<t.protectUntil)continue;
      if((s.effects.shield&&now<s.effects.shield)||(t.effects.shield&&now<t.effects.shield))continue;
      if(t.effects.stealth&&now<t.effects.stealth)continue;
      const hitR=Math.min(34,19+(Math.sqrt(s.score)+Math.sqrt(t.score))*0.35);
      for(let i=0;i<t.points.length;i+=2){
        const p=t.points[i];
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
            kill(room,s,'hit:'+t.name+'@'+i);
          }
          break;
        }
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
function broadcastState(room){
  const now=Date.now();
  const sn=[],fadd=[],fdel=[],iadd=[],idel=[];
  let online=0;
  for(const s of room.snakes.values()){
    if(!s.alive)continue;
    if(s.ws)online++;
    sn.push({id:s.id,name:s.name,color:s.color,skin:s.skin,x:Math.round(s.x),y:Math.round(s.y),
      len:Math.round(s.targetLen),score:s.score,boost:s.boost,kills:s.kills||0,
      prot:now<s.protectUntil,fx:effObj(s,now),
      points:ptsSampled(s.points)});
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
  broadcast(room,{type:'state',snakes:sn,fadd,fdel,rank,eats,online,iadd,idel,corpses});
}

function sendInit(ws,room,s){
  const now=Date.now();
  const allSnakes=[...room.snakes.values()].filter(x=>x.alive).map(x=>({id:x.id,name:x.name,color:x.color,skin:x.skin,
    x:Math.round(x.x),y:Math.round(x.y),len:Math.round(x.targetLen),score:x.score,boost:x.boost,kills:x.kills||0,
    prot:now<x.protectUntil,fx:effObj(x,now),
    points:ptsSampled(x.points)}));
  ws.send(JSON.stringify({type:'init',selfId:s.id,selfColor:s.color,selfSkin:s.skin,world:WORLD,
    room:room.code,
    snakes:allSnakes,
    foods:[...room.foods.values()].map(f=>({id:f.id,x:f.x|0,y:f.y|0,big:!!f.big})),
    items:[...room.items.values()],
    corpses:[...room.corpses.values()].map(cp=>({id:cp.id,points:ptsSampled(cp.points),color:cp.color,name:cp.name}))}));
  // 玩家加入后：增量广播应从当前快照之后开始（防重复）
  room.prevFoods=new Set([...room.foods.keys()]);
  room.prevItems=new Set([...room.items.keys()]);
}

// ---------- 连接 ----------
wss.on('connection',ws=>{
  ws.isAlive=true;
  ws.on('pong',()=>ws.isAlive=true);
  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw)}catch(e){return}
    if(!msg||!msg.type)return;
    if(msg.type==='join'||msg.type==='respawn'){
      const room=getRoom(String(msg.room||'').replace(/[^\w]/g,'').slice(0,12)||DEFAULT_CODE);
      if(ws.snake&&ws.snake.room!==room){ws.snake.room.snakes.delete(ws.snake.id)}
      const s=createSnake(room,ws,String(msg.name||'').replace(/[^\u4e00-\u9fa5A-Za-z0-9_·\s]/g,'').slice(0,12),String(msg.skin||'').replace(/[^\w]/g,'').slice(0,12));
      s.room=room;
      ws.snake=s;
      room.snakes.set(s.id,s);
      sendInit(ws,room,s);
    }else if(msg.type==='input'&&ws.snake&&ws.snake.alive&&!ws.snake.paused){
      // 输入校验：angle 必须为有限数字并归一化到 [-2π,2π]，boost 转布尔
      const a=+msg.angle;
      if(Number.isFinite(a))ws.snake.angle=((a%(Math.PI*2))+Math.PI*2)%(Math.PI*2);
      ws.snake.boost=!!msg.boost;
    }else if(msg.type==='pause'&&ws.snake){
      ws.snake.paused=!!msg.paused;
    }else if(msg.type==='dash'&&ws.snake&&ws.snake.alive&&!ws.snake.paused){
      doDash(ws.snake.room,ws.snake);
    }else if(msg.type==='emote'&&ws.snake&&ws.snake.alive){
      ws.snake.emote=String(msg.em||'').slice(0,4);
      ws.snake.emoteUntil=Date.now()+2500;
      const room=ws.snake.room;
      broadcast(room,{type:'emote',id:ws.snake.id,em:ws.snake.emote});
    }
  });
  ws.on('close',()=>{if(ws.snake&&ws.snake.room)ws.snake.room.snakes.delete(ws.snake.id)});
});

setInterval(tick,TICK_MS);
setInterval(()=>{
  for(const ws of wss.clients){
    if(!ws.isAlive){ws.terminate();continue}
    ws.isAlive=false;ws.ping();
  }
},10000);

server.listen(PORT,()=>console.log('SNAKE ARENA SERVER READY at http://localhost:'+PORT));
