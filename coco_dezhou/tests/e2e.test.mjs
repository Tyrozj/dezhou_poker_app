/**
 * 端到端测试：真的起一个服务，用 3 个 WebSocket 客户端开一桌，从发牌打到摊牌。
 * 运行： node tests/e2e.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = process.env.TEST_PORT || '18765';
process.env.DATA_DIR = 'data/test-run';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { server } = await import('../server/index.mjs');
if (!server.listening) {
  await new Promise((resolve) => server.once('listening', resolve));
}
const PORT = server.address().port;
console.log('[e2e] 服务端口', PORT);

class Client {
  constructor(nickname) {
    this.nickname = nickname;
    this.msgs = [];
    this.state = null;
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket 错误'));
      });
      ws.addEventListener('message', (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        this.msgs.push(m);
        if (m.t === 'state') this.state = m;
      });
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  async waitMsg(pred, timeout = 8000, from = 0) {
    const t0 = Date.now();
    for (;;) {
      for (let i = from; i < this.msgs.length; i++) {
        if (pred(this.msgs[i])) return this.msgs[i];
      }
      if (Date.now() - t0 > timeout) throw new Error(`等待消息超时: ${this.nickname}`);
      await sleep(15);
    }
  }

  mark() {
    return this.msgs.length;
  }

  async waitState(pred, timeout = 8000) {
    const t0 = Date.now();
    for (;;) {
      if (this.state && pred(this.state)) return this.state;
      if (Date.now() - t0 > timeout) {
        throw new Error(`等待状态超时: ${this.nickname} 当前=${this.state && this.state.table.phase}`);
      }
      await sleep(15);
    }
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

test('三人一桌：创建房间 / 房号加入 / 打到摊牌 / 断线重连', async () => {
  const host = new Client('房主');
  await host.connect();
  host.send({
    t: 'create',
    nickname: '房主',
    name: '端到端测试局',
    settings: { seats: 3, startChips: 1000, sb: 10, bb: 20, actionSeconds: 120, autoStart: false },
  });
  const roomMsg = await host.waitMsg((m) => m.t === 'room');
  const code = roomMsg.code;
  assert.match(code, /^\d{6}$/, '房号应为 6 位数字');
  assert.ok(roomMsg.token);
  console.log('[e2e] 1 房间创建成功', code);

  const p2 = new Client('阿二');
  const p3 = new Client('阿三');
  await p2.connect();
  await p3.connect();
  p2.send({ t: 'join', code, nickname: '阿二' });
  p3.send({ t: 'join', code, nickname: '阿三' });

  await host.waitState((s) => s.room.members.length === 3, 8000);
  const joined = host.state.room.members.map((m) => m.name).sort();
  assert.deepEqual(joined, ['房主', '阿三', '阿二'].sort());
  console.log('[e2e] 2 三人到齐');

  // 聊天：广播 + 历史 + REST
  const markChat = host.mark();
  p2.send({ t: 'chat', text: '大家好，我是阿二' });
  const chatMsg = await host.waitMsg((m) => m.t === 'chatMsg', 5000, markChat);
  assert.equal(chatMsg.message.text, '大家好，我是阿二');
  assert.equal(chatMsg.message.name, '阿二');

  const markChatHist = host.mark();
  host.send({ t: 'chatHistory' });
  const chatHist = await host.waitMsg((m) => m.t === 'chat', 5000, markChatHist);
  assert.ok(
    chatHist.list.some((x) => x.text === '大家好，我是阿二'),
    '聊天历史应包含刚发的消息',
  );
  const restChat = await (await fetch(`http://127.0.0.1:${PORT}/api/rooms/${code}/chat`)).json();
  assert.ok(
    restChat.messages.some((x) => x.text === '大家好，我是阿二'),
    'REST 也能读到聊天记录',
  );
  console.log('[e2e] 2.5 聊天广播与记录正常');

  // 房号错误应报错
  const wrong = new Client('错号');
  await wrong.connect();
  wrong.send({ t: 'join', code: '000000', nickname: '错号' });
  const err = await wrong.waitMsg((m) => m.t === 'error');
  assert.match(err.message, /房间不存在/);
  wrong.close();
  console.log('[e2e] 3 错误房号被拒绝');

  // 只有房主能开局
  const mark4 = p2.mark();
  p2.send({ t: 'start' });
  const denied = await p2.waitMsg((m) => m.t === 'error', 8000, mark4);
  assert.match(denied.message, /房主/);
  console.log('[e2e] 4 非房主开局被拒绝');

  host.send({ t: 'start' });
  await host.waitState((s) => s.table.phase === 'betting');
  assert.equal(host.state.table.handNo, 1);
  assert.equal(host.state.table.board.length, 0);
  assert.equal(host.state.table.seats.filter(Boolean).length, 3);
  console.log('[e2e] 5 发牌完成，当前行动座位', host.state.table.actorSeat);

  // 隐私：每个客户端只应看到自己的底牌
  for (const c of [host, p2, p3]) {
    await c.waitState((s) => s.table.phase === 'betting', 4000);
    const withCards = c.state.table.seats.filter((s) => s && s.cards);
    assert.equal(withCards.length, 1, `${c.nickname} 只能看到 1 家底牌（自己）`);
    assert.equal(withCards[0].seat, c.state.you.seat);
  }
  console.log('[e2e] 6 底牌隐私正确');

  // 不在自己回合行动应被拒绝
  const notTurn = [host, p2, p3].find((c) => c.state.table.you && !c.state.table.you.isTurn);
  const mark7 = notTurn.mark();
  notTurn.send({ t: 'action', action: { type: 'fold' } });
  const turnErr = await notTurn.waitMsg((m) => m.t === 'error', 8000, mark7);
  assert.match(turnErr.message, /还没轮到|无法行动/);
  console.log('[e2e] 7 抢行动被拒绝');

  // 所有人一路过牌/跟注到摊牌
  const clients = [host, p2, p3];
  let actions = 0;
  for (let i = 0; i < 300; i++) {
    if (host.state.table.phase === 'showdown') break;
    const actor = clients.find((c) => c.state && c.state.table.you && c.state.table.you.isTurn);
    if (!actor) {
      await sleep(20);
      continue;
    }
    const legal = actor.state.table.you.legal;
    const action = legal && legal.call > 0 ? { type: 'call' } : { type: 'check' };
    actor.send({ t: 'action', action });
    actions += 1;
    await sleep(35);
  }

  const final = await host.waitState((s) => s.table.phase === 'showdown', 8000);
  assert.ok(actions >= 4, `至少发生 4 次行动，实际 ${actions}`);
  assert.equal(final.table.board.length, 5, '摊牌时公共牌应有 5 张');
  assert.ok(final.table.results, '应有本手结果');
  assert.ok(final.table.results.awards.length >= 1);
  assert.equal(final.table.results.players.length, 3, '结算里应带上每个人的输赢');
  assert.equal(
    final.table.results.players.reduce((a, p) => a + p.delta, 0),
    0,
    '结算输赢相加为 0',
  );
  console.log('[e2e] 8 摊牌完成，赢家', final.table.results.awards.map((a) => `${a.name}+${a.amount}`).join(','));

  // 摊牌时所有人底牌公开
  const revealed = final.table.seats.filter((s) => s && s.cards).length;
  assert.equal(revealed, 3);

  // 筹码守恒
  const total = final.table.seats.filter(Boolean).reduce((a, s) => a + s.chips, 0);
  assert.equal(total, 3000, '筹码总量应守恒');

  // 对局记录：手牌流水 + 玩家账本
  const mark8 = host.mark();
  host.send({ t: 'history' });
  const hist = await host.waitMsg((m) => m.t === 'history', 5000, mark8);
  assert.equal(hist.hands.length, 1, '应记录 1 手');
  assert.equal(hist.hands[0].handNo, 1);
  assert.equal(hist.hands[0].board.length, 5);
  assert.equal(hist.hands[0].players.length, 3);
  assert.equal(
    hist.hands[0].players.reduce((a, p) => a + p.delta, 0),
    0,
    '同一手内输赢总和为 0',
  );
  assert.equal(hist.players.length, 3);
  assert.ok(hist.players.every((p) => p.buyIn === 1000), '买入都是起始筹码');
  console.log('[e2e] 8.5 对局记录可用：', hist.hands[0].players.map((p) => `${p.name}${p.delta >= 0 ? '+' : ''}${p.delta}`).join(' '));

  // 断线重连：用 token 回到原座位
  const seatBefore = p2.state.you.seat;
  const tokenBefore = p2.state.you.token;
  p2.close();
  await sleep(150);
  const p2b = new Client('阿二');
  await p2b.connect();
  p2b.send({ t: 'join', code, nickname: '阿二', token: tokenBefore });
  const back = await p2b.waitState((s) => s.you && s.you.seat !== null, 6000);
  assert.equal(back.you.seat, seatBefore, '重连后回到原座位');
  assert.equal(back.you.name, '阿二');
  console.log('[e2e] 9 断线重连回到座位', seatBefore);

  // 房间表（对应 CoCo 云数据表）应有记录
  const rows = await (await fetch(`http://127.0.0.1:${PORT}/api/rooms/rows`)).json();
  const row = rows.rows.find((r) => r.code === code);
  assert.ok(row, '房间表应包含该房间');
  assert.equal(row.players, 3);
  assert.equal(row.bb, 20);

  // 战绩表应写入一手记录
  const hands = await (await fetch(`http://127.0.0.1:${PORT}/api/hands?n=5`)).json();
  const rec = hands.hands.find((h) => h.room === code);
  assert.ok(rec, '战绩表应包含该手牌');
  assert.equal(rec.handNo, 1);
  console.log('[e2e] 10 房间表/战绩表已落库');

  for (const c of [host, p3, p2b]) c.close();
});

test('REST 接口（供 CoCo 积木 HTTP 客户端调用）', async () => {
  const base = `http://127.0.0.1:${PORT}`;
  const created = await (await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nickname: '积木',
      name: 'REST 房',
      settings: { seats: 2, startChips: 800, sb: 5, bb: 10, autoStart: false },
    }),
  })).json();
  assert.match(created.code, /^\d{6}$/);

  const joined = await (await fetch(`${base}/api/rooms/${created.code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: '积木2' }),
  })).json();
  assert.ok(joined.token);

  const state = await (await fetch(`${base}/api/rooms/${created.code}/state?token=${created.token}&wait=0`)).json();
  assert.equal(state.state.room.members.length, 2);
  assert.equal(state.state.room.settings.startChips, 800);

  const started = await (await fetch(`${base}/api/rooms/${created.code}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: created.token }),
  })).json();
  assert.equal(started.ok, true);
  assert.equal(started.state.table.phase, 'betting');

  const list = await (await fetch(`${base}/api/rooms`)).json();
  assert.ok(list.rooms.some((r) => r.code === created.code));

  await fetch(`${base}/api/rooms/${created.code}/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: created.token }),
  });
});

test.after(() => {
  server.close();
  // 房间里的行动计时器仍会持有事件循环，测试结束直接退出
  setTimeout(() => process.exit(process.exitCode || 0), 100);
});
