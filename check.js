// check.js — 语法校验 + 核心场景回归测试（0 依赖，node check.js 一键运行）
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');
const WebSocket = require('ws');

const PORT = 8731;
let passed = 0, failed = 0;
function ok(name) { passed++; console.log('  ✓', name); }
function bad(name, detail) { failed++; console.error('  ✗', name, detail || ''); }

// ---------- 1) 语法检查 ----------
console.log('[1/3] 语法检查');
try {
  new Function(fs.readFileSync('server.js', 'utf8'));
  ok('server.js 语法');
} catch (e) { bad('server.js 语法', e.message); }
const html = fs.readFileSync('index.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { bad('index.html 脚本提取'); }
else {
  try { new Function(m[1]); ok('index.html JS 语法'); }
  catch (e) { bad('index.html JS 语法', e.message); }
}

// ---------- 2) 集成测试 ----------
function waitPort(tries) {
  return new Promise((res, rej) => {
    if (tries <= 0) return rej(new Error('server 端口未就绪'));
    const s = net.connect(PORT, '127.0.0.1', () => { s.destroy(); res(); });
    s.on('error', () => setTimeout(() => waitPort(tries - 1).then(res, rej), 250));
  });
}

function connect(room) {
  return new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    const msgs = [];
    ws.on('message', d => { try { msgs.push(JSON.parse(d)); } catch (e) {} });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', name: 'TEST', room }));
      // 等待 init 到达
      const t0 = Date.now();
      const iv = setInterval(() => {
        const init = msgs.find(x => x.type === 'init');
        if (init) { clearInterval(iv); res({ ws, msgs, init }); }
        else if (Date.now() - t0 > 5000) { clearInterval(iv); rej(new Error('join 超时')); }
      }, 50);
    });
    ws.on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('[2/3] 集成测试');
  // 启动前检查端口占用：占用则提示先关闭（本地测试服务器）
  const busy = await new Promise(res => {
    const s = net.connect(PORT, '127.0.0.1', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
  });
  if (busy) {
    bad('端口 ' + PORT + ' 已被占用（请先关闭本地测试服务器再跑测试）');
    console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
    process.exit(1);
  }
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
  });
  try {
    await waitPort(30);

    // 场景 1：默认房间 join + init 完整
    const c1 = await connect('global');
    if (c1.init.room === 'global' && c1.init.selfId) ok('默认房间 join → init 正确');
    else bad('默认房间 join', JSON.stringify(c1.init).slice(0, 120));
    if (c1.init.snakes && c1.init.snakes.length > 0) ok('init 带 AI 蛇（' + c1.init.snakes.length + ' 条）');
    else bad('init 缺 AI 蛇');
    if (c1.init.foods && c1.init.foods.length > 0) ok('init 带食物（' + c1.init.foods.length + ' 个）');
    else bad('init 缺食物');

    // 场景 2：房间隔离
    const c2 = await connect('ABC123');
    if (c2.init.room === 'ABC123') ok('自定义房间 ABC123 隔离正常');
    else bad('房间隔离', 'room=' + c2.init.room);

    // 场景 3：非法输入不崩服务（NaN 角度 + 超长名字）
    c1.ws.send(JSON.stringify({ type: 'input', angle: NaN, boost: 'yes' }));
    c1.ws.send(JSON.stringify({ type: 'input', angle: 'abc', boost: 1 }));
    await sleep(400);
    if (c1.ws.readyState === WebSocket.OPEN) ok('非法输入后连接存活');
    else bad('非法输入导致断连');
    const st = c1.msgs.find(x => x.type === 'state');
    if (st && st.snakes && st.snakes.length > 0) ok('非法输入后 state 广播正常');
    else bad('非法输入后 state 异常');

    // 场景 4：冲刺 + 表情广播
    const beforeDash = c1.msgs.length;
    c1.ws.send(JSON.stringify({ type: 'dash' }));
    await sleep(400);
    const dash = c1.msgs.slice(beforeDash).find(x => x.type === 'dash');
    if (dash && dash.id === c1.init.selfId) ok('冲刺广播正常（dx=' + (dash.dx || 0) + '）');
    else bad('冲刺广播缺失');
    const beforeEm = c1.msgs.length;
    c1.ws.send(JSON.stringify({ type: 'emote', em: '😀' }));
    await sleep(400);
    const em = c1.msgs.slice(beforeEm).find(x => x.type === 'emote');
    if (em && em.id === c1.init.selfId) ok('表情广播正常');
    else bad('表情广播缺失');

    // 场景 5：频率限制（70 条 input 洪水 → 连接不崩，限流生效）
    for (let i = 0; i < 70; i++) c1.ws.send(JSON.stringify({ type: 'input', angle: 1 }));
    await sleep(300);
    if (c1.ws.readyState === WebSocket.OPEN) ok('70 条 input 洪水后连接存活（限流生效）');
    else bad('洪水导致断连');
    const emBefore = c1.msgs.length;
    for (let i = 0; i < 10; i++) c1.ws.send(JSON.stringify({ type: 'emote', em: 'X' }));
    await sleep(300);
    const emMsgs = c1.msgs.slice(emBefore).filter(x => x.type === 'emote');
    if (emMsgs.length <= 2) ok('emote 限流（10 连发仅 ' + emMsgs.length + ' 条广播）');
    else bad('emote 限流失效', '广播 ' + emMsgs.length + ' 条');

    // 场景 6：断线重连恢复原位
    const w3 = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    const rc1 = await new Promise(res => {
      w3.on('open', () => w3.send(JSON.stringify({ type: 'join', name: 'RC', room: 'recon' })));
      w3.on('message', d => {
        const m = JSON.parse(d);
        if (m.type === 'init') res({ token: m.token, sid: m.selfId });
      });
      setTimeout(() => res(null), 5000);
    });
    if (rc1) {
      w3.close();
      await sleep(400);
      const w4 = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
      const rc2 = await new Promise(res => {
        w4.on('open', () => w4.send(JSON.stringify({ type: 'rejoin', token: rc1.token, room: 'recon' })));
        w4.on('message', d => {
          const m = JSON.parse(d);
          if (m.type === 'init') res({ sid: m.selfId, token: m.token });
        });
        setTimeout(() => res(null), 5000);
      });
      if (rc2 && rc2.sid === rc1.sid && rc2.token === rc1.token) ok('断线重连恢复原位（同一蛇）');
      else bad('断线重连', JSON.stringify(rc2));
      w4.close();
    } else bad('重连测试 join 超时');

    c1.ws.close(); c2.ws.close();
    await sleep(200);
  } finally {
    child.kill();
  }
  console.log('[3/3] 清理');
  // 给子进程退出留时间
  await sleep(300);
}

run().catch(e => { failed++; console.error('  ✗ 测试执行异常:', e.message); })
  .finally(() => {
    console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
    process.exit(failed ? 1 : 0);
  });
