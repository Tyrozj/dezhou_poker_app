/**
 * 用无头 Edge + CDP 给页面截图（开发自检用）。
 *
 *   node tools/shot.mjs <输出目录> [房号] [昵称]
 *
 * 会依次截取：大厅、创建房间、牌桌（有房号时）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const outDir = process.argv[2] || 'data/shots';
const room = process.argv[3] || '';
const nick = process.argv[4] || '测试玩家';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9333);

const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!edge) {
  console.error('找不到 Edge/Chrome');
  process.exit(1);
}
// 每次都用干净的浏览器配置，避免上次的房间会话被自动恢复
fs.rmSync(path.join(outDir, '.profile'), { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-extensions',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${path.resolve(outDir, '.profile')}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function waitForDevtools(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error('devtools 未就绪');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
  });
}

function makeCdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    }
  });
  return (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
}

let sharedCdp = null;

async function openPage() {
  const target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = await connect(target.webSocketDebuggerUrl);
  const cdp = makeCdp(ws);
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  return { cdp, ws, id: target.id };
}

async function shoot({ name, url, waitMs = 1500, clickSel = '', afterClickMs = 450, preEval = '', waitForSel = '', waitForMs = 30000, afterWaitMs = 350 }) {
  const cdp = sharedCdp;
  await cdp('Page.navigate', { url });
  await sleep(waitMs);

  if (preEval) {
    await cdp('Runtime.evaluate', { expression: preEval, awaitPromise: false });
  }

  if (waitForSel) {
    const t0 = Date.now();
    let hit = false;
    while (Date.now() - t0 < waitForMs) {
      const r = await cdp('Runtime.evaluate', {
        expression: `!!document.querySelector(${JSON.stringify(waitForSel)})`,
        returnByValue: true,
      });
      if (r.result && r.result.value) {
        hit = true;
        break;
      }
      await sleep(250);
    }
    console.log(`  ${name}: 等待 ${waitForSel} -> ${hit ? '出现' : '超时'}`);
    await sleep(afterWaitMs);
  }

  if (clickSel) {
    const r = await cdp('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(clickSel)}); if (!el) return 'none'; el.click(); return 'clicked'; })()`,
      returnByValue: true,
    });
    console.log(`  ${name}: ${r.result && r.result.value}`);
    await sleep(afterClickMs);
  }

  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`  截图 ${file} (${fs.statSync(file).size} bytes)`);
  return file;
}

const AUTOPLAY = `setInterval(function(){
  var b = document.querySelector('.act-check') || document.querySelector('.act-call');
  if (b) b.click();
}, 600);`;

try {
  await waitForDevtools();
  const page = await openPage();
  sharedCdp = page.cdp;
  await shoot({ name: 'home', url: `${BASE}/?t=${Date.now()}`, waitMs: 1400 });
  await shoot({ name: 'create', url: `${BASE}/?t=${Date.now()}#create`, waitMs: 1400 });
  if (room) {
    await shoot({ name: 'table', url: `${BASE}/?room=${room}&nick=${encodeURIComponent(nick)}`, waitMs: 5000 });
    await shoot({
      name: 'table-raise',
      url: `${BASE}/?room=${room}&nick=${encodeURIComponent(nick)}`,
      waitMs: 5000,
      clickSel: '.act-raise',
    });
    await shoot({
      name: 'result',
      url: `${BASE}/?room=${room}&nick=${encodeURIComponent(nick)}`,
      waitMs: 4500,
      preEval: AUTOPLAY,
      waitForSel: '.win-badge',
      waitForMs: 90000,
      afterWaitMs: 1800,
    });
    await shoot({
      name: 'allin',
      url: `${BASE}/?room=${room}&nick=${encodeURIComponent(nick)}`,
      waitMs: 4000,
      waitForSel: '.allin-badge',
      waitForMs: 90000,
    });
    await shoot({
      name: 'history',
      url: `${BASE}/?room=${room}&nick=${encodeURIComponent(nick)}`,
      waitMs: 4500,
      clickSel: '#btn-history',
      afterClickMs: 1200,
    });
    await shoot({
      name: 'history-players',
      url: `${BASE}/?room=${room}&nick=${encodeURIComponent(nick)}`,
      waitMs: 4500,
      preEval: `document.getElementById('btn-history').click(); setTimeout(function(){ var t=document.querySelector('#hist-tabs .tab[data-tab=players]'); if(t) t.click(); }, 700);`,
      waitForSel: '#hist-body .hist-player',
      waitForMs: 8000,
    });
    await shoot({
      name: 'history-detail',
      url: `${BASE}/?room=${room}&nick=${encodeURIComponent(nick)}`,
      waitMs: 4500,
      preEval: `document.getElementById('btn-history').click(); setTimeout(function(){ var r=document.querySelector('#hist-body .hist-hand'); if(r) r.click(); }, 800);`,
      waitForSel: '#hist-body .hist-hand.is-open',
      waitForMs: 8000,
    });
    await shoot({
      name: 'menu',
      url: `${BASE}/?room=${room}&nick=${encodeURIComponent(nick)}`,
      waitMs: 4000,
      clickSel: '#btn-menu',
      afterClickMs: 600,
    });
  }
  page.ws.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${page.id}`).catch(() => {});
} catch (err) {
  console.error('截图失败：', err.message);
} finally {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 300);
}
