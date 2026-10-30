/**
 * 上线自检：对已部署的地址做一遍真实检查。
 *
 *   node tools/live-check.mjs https://dezhou-poker-app.onrender.com
 *
 * 会验证：健康检查 → REST 建房 → wss 进房收到状态 → 清理房间。
 * 两个手机开黑前跑一次，就知道服务端、HTTPS、WebSocket 是否都通。
 */

const BASE = (process.argv[2] || process.env.BASE_URL || '').replace(/\/$/, '');
if (!BASE) {
  console.log('用法：node tools/live-check.mjs https://你的地址');
  process.exit(1);
}
const WS_BASE = BASE.replace(/^http/, 'ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (msg) => console.log('  ✔ ' + msg);
const bad = (msg) => {
  failed = true;
  console.log('  ✖ ' + msg);
};

console.log('\n自检目标：' + BASE + '\n');

// 1. 健康检查（同时顺手把免费实例唤醒）
let health = null;
for (let i = 0; i < 3 && !health; i++) {
  try {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/health`);
    health = await res.json();
    ok(`/api/health 正常（${Date.now() - t0}ms，版本 ${health.version}）`);
  } catch (err) {
    if (i === 2) bad('健康检查失败：' + err.message);
    else {
      console.log('  … 实例可能在休眠，等 5 秒重试');
      await sleep(5000);
    }
  }
}
if (!health) process.exit(1);

// 2. REST 建房 + wss 进房
let created = null;
try {
  created = await (await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nickname: '自检-A',
      name: '部署自检',
      settings: { seats: 2, sb: 10, bb: 20, actionSeconds: 30, autoStart: false },
    }),
  })).json();
  if (/^\d{6}$/.test(created.code)) ok(`REST 创建房间成功：#${created.code}`);
  else bad('REST 创建房间返回异常：' + JSON.stringify(created));
} catch (err) {
  bad('REST 创建房间失败：' + err.message);
}

if (created && created.code) {
  try {
    const state = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/ws`);
      const timer = setTimeout(() => reject(new Error('20 秒内没收到状态')), 20000);
      const done = (fn, arg) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        fn(arg);
      };
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ t: 'join', code: created.code, nickname: '自检-B' }));
      });
      ws.addEventListener('error', () => done(reject, new Error('WebSocket 连接失败')));
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'error') done(reject, new Error(m.message));
        if (m.t === 'state' && m.table && m.table.seats.filter(Boolean).length >= 1) done(resolve, m);
      });
    });
    ok(`wss 连接正常，进房成功（座位 ${state.you.seat}，房间 ${state.room.code}）`);
  } catch (err) {
    bad('WebSocket 检查失败：' + err.message);
  }

  try {
    await fetch(`${BASE}/api/rooms/${created.code}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: created.token }),
    });
    ok('清理自检房间完成');
  } catch {
    /* 清理失败不影响结论 */
  }
}

// 3. 静态资源
try {
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  if (res.ok && html.includes('德扑云桌')) ok('首页可访问');
  else bad('首页异常（HTTP ' + res.status + '）');
} catch (err) {
  bad('首页拉取失败：' + err.message);
}

console.log(failed ? '\n结论：有检查项失败，把上面输出贴给我。\n' : '\n结论：全部通过，可以开黑了。手机打开 ' + BASE + '\n');
process.exit(failed ? 1 : 0);
