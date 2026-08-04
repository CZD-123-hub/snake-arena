const http=require('http'),fs=require('fs'),path=require('path');
const {WebSocketServer}=require('ws');

const PORT=process.env.PORT||8731;
const WORLD=4000;                 // 世界边长
const FOOD_TARGET=420;            // 食物目标数量
const TICK_MS=50;                 // 20 tick/s 服务端权威
const MAX_GROW=0.6;               // 吃食物增长
const SPEED=2.7, SPEED_BOOST=4.6; // 每 tick 像素
const HEAD_R=11, BODY_R=8;

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
let nextId=1;
let aiCount=0;
const snakes=new Map();   // id -> snake
const foods=new Map();    // id -> food
const deadQueue=[];

function rnd(n){return Math.random()*n}
function spawnFood(n){
  for(let i=0;i<n;i++){
    const id='f'+(nextId++);
    const big=rnd(1)<0.15;                 // 15% 大经验球
    foods.set(id,{id,x:40+rnd(WORLD-80),y:40+rnd(WORLD-80),big});
  }
}
spawnFood(FOOD_TARGET);

function spawnAI(n){
  for(let i=0;i<n;i++){
    const name=AI_NAMES[aiCount%AI_NAMES.length]+(Math.floor(aiCount/AI_NAMES.length)||'');
    aiCount++;
    const s=createSnake(null,'AI·'+name);
    s.ai=true;
    s.thinkTimer=0;
    snakes.set(s.id,s);
  }
}
  spawnAI(7);
function createSnake(ws,name,skin){
  const id='s'+(nextId++);
  const angle=rnd(Math.PI*2);
  const s={
    id,ws,name:name||('玩家'+Math.floor(100+rnd(900))),
    color:COLORS[Math.floor(rnd(COLORS.length))],
    skin:skin||'',
    x:200+rnd(WORLD-400),y:200+rnd(WORLD-400),
    angle, boost:false,targetLen:12,score:0,
    points:[],alive:true,
    boostHeld:false,ai:false,thinkTimer:0
  };
  for(let i=0;i<12;i++){
    s.points.push({x:s.x-i*9*Math.cos(angle),y:s.y-i*9*Math.sin(angle)});
  }
  return s;
}

function headOf(s){return s.points[0]}

function thinkAI(s){
  if(!s.alive||!s.ai)return;
  const h=headOf(s);
  // 危险检测：其他蛇头（含玩家）是否逼近
  let danger=null,dangerDist=240;
  for(const t of snakes.values()){
    if(!t.alive||t.id===s.id)continue;
    const th=headOf(t);
    const dx=th.x-h.x,dy=th.y-h.y;
    const d=Math.hypot(dx,dy);
    if(d<dangerDist){danger={x:th.x,y:th.y};dangerDist=d}
  }
  let target=null;
  if(danger&&dangerDist<170){
    // 逃离：垂直于威胁方向
    const a=Math.atan2(h.y-danger.y,h.x-danger.x);
    target=a+(Math.random()<0.5?Math.PI/2:-Math.PI/2);
  }else{
    // 寻食：找最近食物
    let best=null,bd=1e18;
    for(const f of foods.values()){
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

function move(s){
  const h=headOf(s);
  const sp=s.boost?SPEED_BOOST:SPEED;
  let nx=h.x+Math.cos(s.angle)*sp, ny=h.y+Math.sin(s.angle)*sp;
  // 软墙：碰到边界推回并反弹
  const hitX=nx<BODY_R||nx>WORLD-BODY_R;
  const hitY=ny<BODY_R||ny>WORLD-BODY_R;
  if(nx<BODY_R)nx=BODY_R; if(nx>WORLD-BODY_R)nx=WORLD-BODY_R;
  if(ny<BODY_R)ny=BODY_R; if(ny>WORLD-BODY_R)ny=WORLD-BODY_R;
  if(hitX)s.angle=Math.PI-s.angle;
  if(hitY)s.angle=-s.angle;
  s.points.unshift({x:nx,y:ny});
  // 加速燃烧长度和经验
  if(s.boost){
    s.targetLen=Math.max(6,s.targetLen-0.25);
    s.score=Math.max(0,s.score-0.15);
  }
  const keep=Math.floor(s.targetLen*0.5)+10;
  while(s.points.length>keep)s.points.pop();
  s.x=nx;s.y=ny;
}

function eatFood(s){
  const h=headOf(s);
  for(const [id,f] of foods){
    const dx=h.x-f.x,dy=h.y-f.y;
    const eatR=f.big?18:13;
    if(dx*dx+dy*dy<eatR*eatR){
      foods.delete(id);
      if(f.big){s.targetLen+=2.5;s.score+=5}
      else{s.targetLen+=MAX_GROW;s.score+=1}
      s.ateFoods=s.ateFoods||[];
      s.ateFoods.push({x:f.x,y:f.y,big:f.big});
    }
  }
}

function kill(s,why){
  s.alive=false;
  const newFoods=[];
  const step=Math.max(6,Math.floor(s.points.length/40));
  for(let i=0;i<s.points.length;i+=step){
    const p=s.points[i];
    if(rnd(1)<0.6){
      const id='f'+(nextId++);
      foods.set(id,{id,x:p.x,y:p.y,big:rnd(1)<0.1});
      newFoods.push(id);
    }
  }
  deadQueue.push({id:s.id,at:Date.now(),ai:s.ai});
  broadcast({type:'death',id:s.id,x:Math.round(s.x),y:Math.round(s.y),foods:newFoods,why:why||''});
  if(s.ws){
    try{s.ws.send(JSON.stringify({type:'gameover',len:Math.round(s.targetLen),score:s.score,rank:currentRank(s.id)}));}catch(e){}
  }
}

function currentRank(id){
  const list=[...snakes.values()].filter(x=>x.alive).sort((a,b)=>b.targetLen-a.targetLen);
  return list.findIndex(x=>x.id===id)+1;
}

function tick(){
  for(const s of snakes.values()){
    if(!s.alive)continue;
    if(s.ai){
      s.thinkTimer=(s.thinkTimer||0)-1;
      if(s.thinkTimer<=0){thinkAI(s);s.thinkTimer=3}
    }
    move(s);
    eatFood(s);
  }
  // 碰撞：蛇头撞任何蛇身（含自己后半段）
  for(const s of snakes.values()){
    if(!s.alive)continue;
    const h=headOf(s);
    for(const t of snakes.values()){
      if(!t.alive||t.id===s.id)continue;
      for(let i=0;i<t.points.length;i+=2){
        const p=t.points[i];
        const dx=h.x-p.x,dy=h.y-p.y;
        if(dx*dx+dy*dy<(BODY_R+HEAD_R)*(BODY_R+HEAD_R)){
          // 大鱼吃小鱼：经验多的蛇头撞到经验少的蛇身 → 吃掉对方
          if(s.score>t.score){
            t.eatenBy=s.name;
            const gained=Math.max(1,Math.floor(t.score*0.5));
            s.score+=gained;
            s.targetLen+=gained*0.4;
            kill(t,'eaten:'+s.name);
            broadcast({type:'eat',killer:s.id,target:t.id,x:Math.round(p.x),y:Math.round(p.y),gained});
          }else{
            kill(s,'hit:'+t.name+'@'+i);
          }
          break;
        }
      }
      if(!s.alive)break;
    }
    if(!s.alive)continue;
    // 撞自己：只检测头部后方足够远的点（跳过紧邻头部的点）
    const skip=Math.max(14,Math.floor((HEAD_R+BODY_R*2)/ (s.boost?SPEED_BOOST:SPEED)));
    for(let i=skip;i<s.points.length;i+=2){
      const p=s.points[i];
      const dx=h.x-p.x,dy=h.y-p.y;
      if(dx*dx+dy*dy<(BODY_R+HEAD_R)*(BODY_R+HEAD_R)){kill(s,'self@'+i);break}
    }
  }
  // 清理死亡蛇；AI 蛇 4 秒后复活
  const now=Date.now();
  for(let i=deadQueue.length-1;i>=0;i--){
    if(now-deadQueue[i].at>3000){
      const d=deadQueue[i];
      snakes.delete(d.id);
      if(d.ai)setTimeout(()=>spawnAI(1),2000+rnd(5000));
      deadQueue.splice(i,1);
    }
  }
  broadcastState();
}

function broadcast(obj){
  const data=JSON.stringify(obj);
  for(const s of snakes.values()){
    if(!s.ws)continue;
    try{s.ws.send(data)}catch(e){}
  }
}

function broadcastState(){
  const sn=[],fadd=[],fdel=[];
  let online=0;
  for(const s of snakes.values()){
    if(!s.alive)continue;
    if(s.ws)online++;
    sn.push({id:s.id,name:s.name,color:s.color,skin:s.skin,x:Math.round(s.x),y:Math.round(s.y),
      len:Math.round(s.targetLen),score:s.score,boost:s.boost,
      points:s.points.map(p=>[p.x|0,p.y|0])});
  }
  // 食物增量：与上次快照对比
  const cur=[...foods.keys()];
  const prev=global.__prevFoods||new Set();
  for(const id of cur)if(!prev.has(id))fadd.push(foods.get(id));
  for(const id of prev)if(!foods.has(id))fdel.push(id);
  global.__prevFoods=new Set(cur);
  const sorted=[...snakes.values()].filter(s=>s.alive).sort((a,b)=>b.score-a.score).slice(0,10);
  const rank=sorted.map((s,i)=>({n:i+1,id:s.id,name:s.name,len:Math.round(s.targetLen),score:s.score}));
  // 吃食物事件（动画用）
  const eats=[];
  for(const s of snakes.values()){
    if(s.ateFoods&&s.ateFoods.length){eats.push({id:s.id,x:s.x,y:s.y,f:s.ateFoods});s.ateFoods=[]}
  }
  broadcast({type:'state',snakes:sn,fadd,fdel,rank,eats,online});
}

function sendInit(ws,s){
  const allSnakes=[...snakes.values()].filter(x=>x.alive).map(x=>({id:x.id,name:x.name,color:x.color,skin:x.skin,
    x:Math.round(x.x),y:Math.round(x.y),len:Math.round(x.targetLen),score:x.score,boost:x.boost,
    points:x.points.map(p=>[p.x|0,p.y|0])}));
  const allFoods=[...foods.values()];
  ws.send(JSON.stringify({type:'init',selfId:s.id,selfColor:s.color,selfSkin:s.skin,world:WORLD,
    snakes:allSnakes,foods:allFoods.map(f=>({id:f.id,x:f.x|0,y:f.y|0,big:!!f.big}))}));
}

wss.on('connection',ws=>{
  ws.isAlive=true;
  ws.on('pong',()=>ws.isAlive=true);
  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw)}catch(e){return}
    if(!msg||!msg.type)return;
    if(msg.type==='join'){
      if(ws.snake){snakes.delete(ws.snake.id)}
      const s=createSnake(ws,String(msg.name||'').slice(0,12),String(msg.skin||''));
      ws.snake=s;
      snakes.set(s.id,s);
      sendInit(ws,s);
    }else if(msg.type==='input'&&ws.snake&&ws.snake.alive){
      ws.snake.angle=+msg.angle||0;
      ws.snake.boost=!!msg.boost;
    }else if(msg.type==='respawn'){
      const s=createSnake(ws,String(msg.name||'').slice(0,12),String(msg.skin||''));
      ws.snake=s;
      snakes.set(s.id,s);
      sendInit(ws,s);
    }
  });
  ws.on('close',()=>{if(ws.snake)snakes.delete(ws.snake.id)});
});

setInterval(tick,TICK_MS);
setInterval(()=>{
  for(const ws of wss.clients){
    if(!ws.isAlive){ws.terminate();continue}
    ws.isAlive=false;ws.ping();
  }
},10000);

server.listen(PORT,()=>console.log('SNAKE ARENA SERVER READY at http://localhost:'+PORT));
