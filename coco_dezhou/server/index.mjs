/**
 * 服务入口：静态页面 + WebSocket 实时对局 + REST 接口（供 CoCo 积木「HTTP客户端」调用）。
 * 运行： node server/index.mjs   （默认端口 8080，可用 PORT 环境变量覆盖）
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RoomManager } from './rooms.mjs';
import { FileStore } from './store.mjs';
import { acceptUpgrade } from './ws.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const SHARED_DIR = path.join(ROOT, 'shared');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const store = new FileStore(DATA_DIR);
const manager = new RoomManager({ store });
const VERSION = '1.0.0';
const startedAt = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------- 工具 ------------------------- */

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(data);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const candidates = [];
  const safeRel = rel.replace(/^\/+/, '');
  if (safeRel.startsWith('shared/')) candidates.push(path.join(SHARED_DIR, safeRel.slice(7)));
  candidates.push(path.join(WEB_DIR, safeRel));

  for (const file of candidates) {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(WEB_DIR) && !resolved.startsWith(SHARED_DIR)) continue;
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': stat.size,
    });
    fs.createReadStream(resolved).pipe(res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}

function findMember(room, token) {
  if (!room || !token) return null;
  for (const m of room.members.values()) if (m.token === token) return m;
  return null;
}

function attachHttp(room, member) {
  if (member.sink) return member.http || { latest: null, waiters: [] };
  const box = { latest: null, waiters: [] };
  member.http = box;
  room.attach(member, {
    send(msg) {
      box.latest = msg;
      const waiters = box.waiters.splice(0, box.waiters.length);
      for (const fn of waiters) fn(msg);
    },
    close() {},
  });
  return box;
}

/* ------------------------- REST（CoCo 积木可直连） ------------------------- */

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', ':code', 'action']
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return json(res, 204, {});

  // GET /api/health
  if (parts[1] === 'health') {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      rooms: manager.rooms.size,
    });
  }

  // GET /api/rooms  房间列表（搜索房间号用）
  if (parts[1] === 'rooms' && parts.length === 2) {
    if (method === 'GET') return json(res, 200, { rooms: manager.list() });
    if (method === 'POST') {
      const body = await readBody(req);
      const { room, member, code } = manager.create({
        name: body.name,
        settings: body.settings || {},
        hostName: body.nickname,
      });
      attachHttp(room, member);
      return json(res, 200, { code, token: member.token, playerId: member.id, seat: member.seat });
    }
    return json(res, 405, { error: '方法不支持' });
  }

  // GET /api/rooms/rows  房间表（等价于查询 CoCo 云数据表）
  if (parts[1] === 'rooms' && parts[2] === 'rows') {
    return json(res, 200, { rows: store.roomRows() });
  }

  // GET /api/rooms/:code/view  旁观视图（不含任何底牌，便于调试/观战）
  if (parts[1] === 'rooms' && parts[2] && parts[3] === 'view') {
    const room = manager.get(parts[2]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    return json(res, 200, { room: room.summary(), table: room.table.view(null) });
  }

  // GET /api/rooms/:code/history  对局记录（手牌流水 + 玩家账本，均为牌桌公开信息）
  if (parts[1] === 'rooms' && parts[2] && parts[3] === 'history') {
    const room = manager.get(parts[2]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    return json(res, 200, { code: room.code, ...room.table.handHistory(50) });
  }

  // GET /api/rooms/:code/chat  房间聊天记录
  if (parts[1] === 'rooms' && parts[2] && parts[3] === 'chat' && method === 'GET') {
    const room = manager.get(parts[2]);
    if (!room) return json(res, 404, { error: '房间不存在' });
    const n = Math.min(200, Math.max(1, Number(url.searchParams.get('n') || 100)));
    return json(res, 200, { code: room.code, messages: room.chatList(n) });
  }

  // GET /api/hands  战绩表
  if (parts[1] === 'hands') {
    const n = Math.min(200, Math.max(1, Number(url.searchParams.get('n') || 30)));
    return json(res, 200, { hands: store.recentHands(n) });
  }

  const code = parts[2];
  const action = parts[3];
  const room = manager.get(code);
  if (!room) return json(res, 404, { error: '房间不存在' });

  if (action === 'join') {
    const body = await readBody(req);
    const found = findMember(room, body.token);
    if (found) {
      attachHttp(room, found);
      return json(res, 200, { token: found.token, playerId: found.id, seat: found.seat, reconnected: true });
    }
    const resJoin = manager.join(code, { name: body.nickname, token: body.token });
    if (resJoin.error) return json(res, 400, { error: resJoin.error });
    attachHttp(room, resJoin.member);
    return json(res, 200, { token: resJoin.member.token, playerId: resJoin.member.id, seat: resJoin.member.seat });
  }

  if (action === 'state') {
    const token = url.searchParams.get('token') || '';
    const since = Number(url.searchParams.get('since') || 0);
    const wait = Math.min(25, Math.max(0, Number(url.searchParams.get('wait') ?? 20)));
    const member = findMember(room, token);
    if (!member) return json(res, 401, { error: '凭证无效，请重新进入房间' });
    member.lastSeen = Date.now();
    const box = attachHttp(room, member);
    const current = box.latest || room.statePayload(member);
    if ((current.seq || 0) > since || wait === 0) {
      return json(res, 200, { seq: current.seq || room.stateSeq, state: current });
    }
    const payload = await new Promise((resolve) => {
      let done = false;
      const finish = (msg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(msg || current);
      };
      const timer = setTimeout(() => finish(null), wait * 1000);
      box.waiters.push(finish);
    });
    return json(res, 200, { seq: payload.seq || room.stateSeq, state: payload });
  }

  // 需要 token 的操作
  const body = method === 'POST' ? await readBody(req) : {};
  const token = body.token || url.searchParams.get('token');
  const member = findMember(room, token);
  if (!member) return json(res, 401, { error: '凭证无效，请重新进入房间' });
  member.lastSeen = Date.now();
  if (!member.sink) attachHttp(room, member);

  if (action === 'action') {
    const r = room.handle(member, { t: 'action', action: body.action || {} });
    return json(res, 200, { ok: !!r.ok, error: r.error, state: room.statePayload(member) });
  }
  if (action === 'start') {
    const r = room.handle(member, { t: 'start' });
    return json(res, 200, { ok: !!r.ok, error: r.error, state: room.statePayload(member) });
  }
  if (action === 'chat') {
    const r = room.handle(member, { t: 'chat', text: body.text });
    return json(res, 200, { ok: !!r.ok, error: r.error });
  }
  if (action === 'rebuy') {
    const r = room.handle(member, { t: 'rebuy' });
    return json(res, 200, { ok: !!r.ok, error: r.error, state: room.statePayload(member) });
  }
  if (action === 'sitout') {
    const r = room.handle(member, { t: 'sitout', value: body.value });
    return json(res, 200, { ok: !!r.ok, error: r.error, state: room.statePayload(member) });
  }
  if (action === 'kick') {
    const r = room.handle(member, { t: 'kick', playerId: body.playerId });
    return json(res, 200, { ok: !!r.ok, error: r.error });
  }
  if (action === 'leave') {
    room.removeMember(member, { notify: false });
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: '接口不存在' });
}

/* ------------------------- HTTP 服务 ------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message || '服务器错误' });
    else res.end();
  }
});

/* ------------------------- WebSocket ------------------------- */

const sessions = new Set();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  acceptUpgrade(req, socket, head, (conn) => {
    const session = { conn, room: null, member: null, lastSeen: Date.now() };
    sessions.add(session);
    conn.send({ t: 'hello', version: VERSION, serverTime: Date.now() });

    conn.on('message', async (raw) => {
      session.lastSeen = Date.now();
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return conn.send({ t: 'error', message: '消息不是合法 JSON' });
      }
      try {
        handleWsMessage(session, msg);
      } catch (err) {
        conn.send({ t: 'error', message: err.message || '服务器错误', requestId: msg.requestId });
      }
    });

    conn.on('pong', () => {
      session.lastSeen = Date.now();
    });

    conn.on('close', () => {
      sessions.delete(session);
      if (session.room && session.member) session.room.detach(session.member);
    });
  });
});

function handleWsMessage(session, msg) {
  const { conn } = session;
  const t = msg.t;

  if (t === 'list') {
    return conn.send({ t: 'rooms', rooms: manager.list() });
  }
  if (t === 'ping') {
    return conn.send({ t: 'pong', at: Date.now() });
  }

  if (t === 'create') {
    const { room, member, code } = manager.create({
      name: msg.name,
      settings: msg.settings || {},
      hostName: msg.nickname,
    });
    session.room = room;
    session.member = member;
    conn.send({ t: 'room', code, playerId: member.id, token: member.token });
    room.attach(member, wsSink(conn));
    return;
  }

  if (t === 'join' || t === 'resume') {
    const resJoin = manager.join(msg.code, { name: msg.nickname, token: msg.token });
    if (resJoin.error) return conn.send({ t: 'error', message: resJoin.error, requestId: msg.requestId });
    session.room = resJoin.room;
    session.member = resJoin.member;
    conn.send({
      t: 'room',
      code: resJoin.room.code,
      playerId: resJoin.member.id,
      token: resJoin.member.token,
    });
    resJoin.room.attach(resJoin.member, wsSink(conn));
    return;
  }

  if (!session.room || !session.member) {
    return conn.send({ t: 'error', message: '请先进入房间', requestId: msg.requestId });
  }

  if (t === 'leave') {
    session.room.removeMember(session.member, { notify: false });
    session.room = null;
    session.member = null;
    return conn.send({ t: 'left' });
  }

  session.room.handle(session.member, msg);
}

function wsSink(conn) {
  return {
    send(msg) {
      conn.send(msg);
    },
    close() {
      conn.close(1000, 'bye');
    },
  };
}

/* 心跳：清理死连接；清理长时间不轮询的 HTTP 客户端 */
const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const s of sessions) {
    if (now - s.lastSeen > 75000) {
      s.conn.close(1001, 'timeout');
      sessions.delete(s);
      if (s.room && s.member) s.room.detach(s.member);
    } else {
      s.conn.ping();
    }
  }
  for (const room of manager.rooms.values()) {
    for (const m of room.members.values()) {
      if (m.sink && m.http && now - (m.lastSeen || 0) > 70000) {
        room.detach(m);
      }
    }
  }
}, 25000);
if (heartbeat.unref) heartbeat.unref();

/* ------------------------- 启动 ------------------------- */

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('[server] 启动失败:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0', () => {
    const actual = server.address().port;
    console.log('');
    console.log('  ♠ ♥ 德扑云桌 ♦ ♣  已启动  v' + VERSION);
    console.log('  ├─ 本机：   http://localhost:' + actual);
    for (const ip of lanAddresses()) {
      console.log('  ├─ 手机：   http://' + ip + ':' + actual + '   （同一 Wi-Fi）');
    }
    console.log('  └─ 数据目录：' + DATA_DIR);
    console.log('');
    console.log('  用手机浏览器打开上面的地址，创建房间后把 6 位房号发给朋友即可。');
    console.log('');
  });
}

process.on('SIGINT', () => {
  store.flush();
  console.log('\n[server] 已退出');
  process.exit(0);
});

listen(Number(process.env.PORT) || 18080);

export { server, manager, store };
