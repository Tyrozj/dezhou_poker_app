import test from 'node:test';
import assert from 'node:assert/strict';
import { GameTable, normalizeSettings } from '../server/table.mjs';

/** 按发牌顺序给出牌，返回引擎实际 pop 的牌堆（从尾部弹）。 */
function deckByDealOrder(order) {
  return { deck: () => order.slice().reverse() };
}

function newTable(settings, order) {
  const t = new GameTable({ startChips: 1000, sb: 10, bb: 20, actionSeconds: 25, ...settings }, deckByDealOrder(order));
  return t;
}

function totalChips(t) {
  let sum = t.pot + t.lastPot * 0;
  for (const s of t.seats) if (s) sum += s.chips + s.bet;
  return sum;
}

test('参数会被约束到合法区间', () => {
  const s = normalizeSettings({ seats: 99, startChips: 1, sb: 50, bb: 20, actionSeconds: 1 });
  assert.equal(s.seats, 8);
  assert.equal(s.startChips, 100);
  assert.equal(s.sb, 50);
  assert.ok(s.bb >= s.sb * 2);
  assert.equal(s.actionSeconds, 10);
});

test('单挑：庄家是小盲且翻前先行动，四人街过牌到摊牌', () => {
  // 发牌顺序：seat0 两张、seat1 两张、烧牌、翻牌 3、烧、转、烧、河
  const order = ['As', 'Kh', 'Qs', 'Qh', '2c', '7d', '9s', 'Jh', '3c', '4d', '5d', '6d', '8c'];
  const t = newTable({ seats: 2 }, order);
  t.addPlayer('p1', '小明');
  t.addPlayer('p2', '小红');
  const r = t.startHand();
  assert.ok(r.ok);
  assert.equal(t.dealerSeat, 0);
  assert.equal(t.sbSeat, 0);
  assert.equal(t.bbSeat, 1);
  assert.equal(t.seats[0].chips, 990);
  assert.equal(t.seats[1].chips, 980);
  assert.equal(t.actorSeat, 0, '单挑时小盲（庄家）翻前先行动');
  assert.equal(t.seats[0].cards.length, 2);

  assert.ok(t.act('p1', { type: 'call' }).ok);
  assert.equal(t.actorSeat, 1, '大盲还有选择权');
  assert.ok(t.act('p2', { type: 'check' }).ok);
  assert.equal(t.street, 1, '进入翻牌');
  assert.equal(t.board.length, 3);
  assert.equal(t.actorSeat, 1, '单挑时翻牌后由大盲先行动');

  // 三条街一路过牌到摊牌
  for (let i = 0; i < 6 && t.phase === 'betting'; i++) {
    const actor = t.seats[t.actorSeat];
    assert.ok(t.act(actor.pid, { type: 'check' }).ok);
  }
  assert.equal(t.phase, 'showdown');
  assert.equal(t.board.length, 5);
  assert.ok(t.results.showdown);
  assert.equal(t.results.awards.length, 1);
  assert.equal(t.results.awards[0].pid, 'p2');
  assert.equal(t.results.awards[0].amount, 40);
  assert.equal(totalChips(t), 2000);
  assert.equal(t.seats[1].chips, 1020);
});

test('加注必须达到最小加注额，弃牌后对手直接赢池', () => {
  const order = ['2s', '3h', '4s', '5h', '6c', '7d', '8s', '9h', 'Tc', 'Jd', 'Qd', 'Kd', 'Ad'];
  const t = newTable({ seats: 2 }, order);
  t.addPlayer('p1', 'A');
  t.addPlayer('p2', 'B');
  t.startHand();
  const bad = t.act('p1', { type: 'raise', to: 30 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /最少加注到 40/);
  const ok = t.act('p1', { type: 'raise', to: 40 });
  assert.ok(ok.ok);
  assert.equal(t.currentBet, 40);
  assert.ok(t.act('p2', { type: 'fold' }).ok);
  assert.equal(t.phase, 'showdown');
  assert.equal(t.results.showdown, false);
  assert.equal(t.results.awards[0].pid, 'p1');
  // p1 投入 40，p2 投入 20，共 60 归 p1：1000-40+60 = 1020
  assert.equal(t.seats[0].chips, 1020);
  assert.equal(t.seats[1].chips, 980);
  assert.equal(totalChips(t), 2000);
});

test('三人全下：主池与边池都分给最大的牌', () => {
  // 发牌起点是小盲（seat1），顺序：seat1、seat2、seat0
  const order = [
    'Ks', 'Kh',   // seat1 p2
    'Qs', 'Qh',   // seat2 p3
    'As', 'Ah',   // seat0 p1
    '2c',         // burn
    '3d', '7h', '9c', // flop
    '4d',         // burn
    '5c',         // turn
    '6d',         // burn
    '8c',         // river
  ];
  const t = newTable({ seats: 3, startChips: 1000, sb: 10, bb: 20 }, order);
  t.addPlayer('p1', 'A');
  t.addPlayer('p2', 'B');
  t.addPlayer('p3', 'C');
  t.seats[0].chips = 100;
  t.seats[1].chips = 300;
  t.seats[2].chips = 1000;
  t.startHand();
  assert.equal(t.actorSeat, 0, '大盲后一位先行动');
  assert.ok(t.act('p1', { type: 'allin' }).ok);
  assert.ok(t.act('p2', { type: 'allin' }).ok);
  assert.ok(t.act('p3', { type: 'call' }).ok);
  // 三家都全下/跟注后无人可行动，直接发完公共牌摊牌
  assert.equal(t.phase, 'showdown');
  assert.equal(t.board.length, 5);
  const bySeat = Object.fromEntries(t.results.awards.map((a) => [a.seat, a.amount]));
  assert.equal(bySeat[0], 300, '主池 300 归 AA');
  assert.equal(bySeat[1], 400, '边池 400 归 KK');
  assert.equal(t.seats[0].chips, 300);
  assert.equal(t.seats[1].chips, 400);
  assert.equal(t.seats[2].chips, 700);
  assert.equal(totalChips(t), 1400);
});

test('超时：无下注时自动过牌，有下注时自动弃牌', () => {
  const order = ['2s', '3h', '4s', '5h', '6c', '7d', '8s', '9h', 'Tc', 'Jd', 'Qd', 'Kd', 'Ad'];
  const t = newTable({ seats: 2, actionSeconds: 1 }, order);
  t.addPlayer('p1', 'A');
  t.addPlayer('p2', 'B');
  t.startHand();
  // p1 面对大盲，超时弃牌
  t.timeout();
  assert.equal(t.seats[0].folded, true);
  assert.equal(t.phase, 'showdown');
});

test('超时自动弃牌：timeoutFold 开启时，即使无需跟注也弃牌', () => {
  const order = ['2s', '3h', '4s', '5h', '6c', '7d', '8s', '9h', 'Tc', 'Jd', 'Qd', 'Kd', 'Ad'];
  const t = newTable({ seats: 2, timeoutFold: true }, order);
  t.addPlayer('p1', 'A');
  t.addPlayer('p2', 'B');
  t.startHand();
  t.act('p1', { type: 'call' });
  t.act('p2', { type: 'check' }); // 进入翻牌，轮到 p2（大盲），无需跟注
  assert.equal(t.street, 1);
  const actor = t.seats[t.actorSeat];
  t.timeout();
  assert.equal(actor.folded, true, '开启 timeoutFold 时超时一律弃牌');
  assert.equal(t.phase, 'showdown');
});

test('超时自动过牌：timeoutFold 关闭时，无需跟注则过牌', () => {
  const order = ['2s', '3h', '4s', '5h', '6c', '7d', '8s', '9h', 'Tc', 'Jd', 'Qd', 'Kd', 'Ad'];
  const t = newTable({ seats: 2, timeoutFold: false }, order);
  t.addPlayer('p1', 'A');
  t.addPlayer('p2', 'B');
  t.startHand();
  t.act('p1', { type: 'call' });
  t.act('p2', { type: 'check' });
  const actorSeat = t.actorSeat;
  t.timeout();
  assert.equal(t.seats[actorSeat].folded, false, '关闭后应自动过牌而不是弃牌');
  assert.equal(t.seats[actorSeat].hasActed, true);
});

test('连续 3 次超时后自动旁观，手动行动会清零计数', () => {
  const order = ['2s', '3h', '4s', '5h', '6c', '7d', '8s', '9h', 'Tc', 'Jd', 'Qd', 'Kd', 'Ad',
    'Ah', 'Kh', 'Qh', 'Jh', 'Th', '9d', '8d', '7c', '6s', '5c', '4c', '3c', '2d'];
  const t = newTable({ seats: 2, timeoutFold: true }, order);
  t.addPlayer('p1', 'A');
  t.addPlayer('p2', 'B');

  // 轮到 p1 时让它超时；轮到别人时正常行动，保证超时计数都落在 p1 身上
  const timeoutWhenP1 = () => {
    for (let i = 0; i < 20 && t.phase === 'betting'; i++) {
      const actor = t.seats[t.actorSeat];
      if (actor.pid === 'p1') {
        t.timeout();
        return true;
      }
      t.act(actor.pid, t.toCallOf(t.actorSeat) > 0 ? { type: 'call' } : { type: 'check' });
    }
    return false;
  };

  t.startHand();
  assert.equal(timeoutWhenP1(), true);
  assert.equal(t.seats[0].timeoutStreak, 1);

  // 手动行动（弃牌）应把连续超时清零
  t.startHand();
  for (let i = 0; i < 20 && t.phase === 'betting' && t.seats[t.actorSeat].pid !== 'p1'; i++) {
    t.act(t.seats[t.actorSeat].pid, t.toCallOf(t.actorSeat) > 0 ? { type: 'call' } : { type: 'check' });
  }
  if (t.phase === 'betting') t.act('p1', { type: 'fold' });
  assert.equal(t.seats[0].timeoutStreak, 0, '手动行动后连续超时计数清零');

  // 再连续超时 3 次
  for (let round = 1; round <= 3; round++) {
    t.startHand();
    timeoutWhenP1();
    assert.equal(t.seats[0].timeoutStreak, round, `第 ${round} 次超时计数`);
  }
  assert.equal(t.seats[0].sitOut, true, '连续 3 次超时后自动旁观');
  assert.equal(t.eligibleSeats().includes(0), false, '下一手不再给他发牌');
});

test('中途加入的人等下一手才发牌', () => {
  const order = ['2s', '3h', '4s', '5h', '6c', '7d', '8s', '9h', 'Tc', 'Jd', 'Qd', 'Kd', 'Ad',
    'Ah', 'Kh', 'Qh', 'Jh', 'Th', '9d', '8d', '7c', '6s', '5c', '4c', '3c', '2d'];
  const t = newTable({ seats: 4 }, order);
  t.addPlayer('p1', 'A');
  t.addPlayer('p2', 'B');
  t.startHand();
  t.addPlayer('p3', 'C');
  assert.equal(t.seats[2].inHand, false, '牌局中加入不参与本手');
  t.act('p1', { type: 'fold' });
  assert.equal(t.phase, 'showdown');
  const r = t.startHand();
  assert.ok(r.ok);
  assert.equal(t.seats[2].inHand, true);
  assert.equal(t.seats[2].cards.length, 2);
});

test('玩家离桌：已投入筹码留在池中，其余人继续', () => {
  const order = ['As', 'Ah', 'Ks', 'Kh', 'Qs', 'Qh', '2c', '3d', '7h', '9c', '4d', '5c', '6d'];
  const t = newTable({ seats: 3 }, order);
  t.addPlayer('p1', 'A');
  t.addPlayer('p2', 'B');
  t.addPlayer('p3', 'C');
  t.startHand();
  t.act('p1', { type: 'call' });
  assert.ok(t.removePlayer('p2'));
  const potBefore = t.pot;
  assert.ok(potBefore > 0, '离桌玩家的大盲已计入底池');
});

test('补码：局间可用，牌局中不可用', () => {
  const order = ['2s', '3h', '4s', '5h', '6c', '7d', '8s', '9h', 'Tc', 'Jd', 'Qd', 'Kd', 'Ad'];
  const t = newTable({ seats: 2 }, order);
  t.addPlayer('p1', 'A');
  t.addPlayer('p2', 'B');
  t.startHand();
  assert.equal(t.rebuy('p1').ok, false, '牌局进行中不能补码');
  t.act('p1', { type: 'fold' });
  assert.equal(t.phase, 'showdown');
  const before = t.seats[0].chips;
  const r = t.rebuy('p1');
  assert.equal(r.ok, true);
  assert.equal(t.seats[0].chips, before + 1000);
  assert.equal(t.seats[0].sitOut, false);
});

test('旁观：牌局中不能旁观，局间可以', () => {
  const order = ['2s', '3h', '4s', '5h', '6c', '7d', '8s', '9h', 'Tc', 'Jd', 'Qd', 'Kd', 'Ad'];
  const t = newTable({ seats: 3 }, order);
  t.addPlayer('p1', 'A');
  t.addPlayer('p2', 'B');
  t.addPlayer('p3', 'C');
  t.startHand();
  assert.equal(t.setSitOut('p1', true).ok, false, '本手进行中不能旁观');
  t.act('p1', { type: 'fold' });
  t.act('p2', { type: 'fold' });
  assert.equal(t.phase, 'showdown');
  assert.equal(t.setSitOut('p2', true).ok, true);
  assert.equal(t.eligibleSeats().includes(1), false);
});

test('对局记录：每手输赢相加为 0，买入与净输赢可查', () => {
  const order = ['2s', '3h', '4s', '5h', '6c', '7d', '8s', '9h', 'Tc', 'Jd', 'Qd', 'Kd', 'Ad'];
  const t = newTable({ seats: 2, startChips: 1000, sb: 10, bb: 20 }, order);
  t.addPlayer('p1', 'A');
  t.addPlayer('p2', 'B');
  t.startHand();
  t.act('p1', { type: 'fold' });

  assert.equal(t.history.length, 1, '一手结束后应有一条记录');
  const rec = t.history[0];
  assert.equal(rec.handNo, 1);
  assert.equal(rec.pot, 30, 'A 的小盲 10 + B 的大盲 20');
  assert.equal(rec.players.length, 2);
  const sumDelta = rec.players.reduce((a, p) => a + p.delta, 0);
  assert.equal(sumDelta, 0, '同一手内输赢总和为 0');
  const a = rec.players.find((p) => p.name === 'A');
  const b = rec.players.find((p) => p.name === 'B');
  assert.equal(a.delta, -10, 'A 弃牌输掉小盲');
  assert.equal(b.delta, 10);
  assert.equal(a.before, 1000);
  assert.equal(a.after, 990);

  const h = t.handHistory();
  assert.equal(h.hands.length, 1);
  assert.equal(h.totalHands, 1);
  const ledgerA = h.players.find((p) => p.name === 'A');
  assert.equal(ledgerA.buyIn, 1000, '买入 = 起始筹码');
  assert.equal(ledgerA.delta, -10, '净输赢 = 当前 - 买入');

  // 补码会同时抬高买入与当前筹码，净输赢不受影响
  t.rebuy('p1');
  const h2 = t.handHistory();
  const a2 = h2.players.find((p) => p.name === 'A');
  assert.equal(a2.buyIn, 2000);
  assert.equal(a2.chips, 1990);
  assert.equal(a2.delta, -10);
});
