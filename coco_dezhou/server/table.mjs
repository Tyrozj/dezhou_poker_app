/**
 * 权威牌桌引擎（服务端裁判）。
 * 一次只处理一手牌的状态机：洗牌发牌 -> 四条街下注 -> 摊牌分池 -> 等待下一手。
 * 引擎不依赖网络、不依赖时钟（超时由外层调用 timeout() 触发），便于单测。
 */

import { makeDeck, shuffle, evaluate, compareScore, cardsText } from '../shared/cards.mjs';

export const PHASES = ['waiting', 'betting', 'showdown'];
export const STREET_NAMES = ['翻前', '翻牌', '转牌', '河牌'];

const DEFAULT_SETTINGS = {
  seats: 6,          // 座位数（2-8）
  startChips: 1000,  // 起始筹码
  sb: 10,            // 小盲
  bb: 20,            // 大盲
  actionSeconds: 25, // 每次行动思考时间
  autoStart: true,   // 一手结束后自动开下一手
  autoRebuy: false,  // 筹码输光自动补码到起始筹码
  rebuyAmount: 0,    // 手动补码数额，0 表示用起始筹码
  timeoutFold: true, // 超时是否一律弃牌（false = 无需跟注时自动过牌）
};

export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  s.seats = clampInt(s.seats, 2, 8, 6);
  s.startChips = clampInt(s.startChips, 100, 1000000, 1000);
  s.sb = clampInt(s.sb, 1, 1000000, 10);
  s.bb = clampInt(s.bb, s.sb * 2, 2000000, Math.max(s.sb * 2, 20));
  s.actionSeconds = clampInt(s.actionSeconds, 10, 120, 25);
  s.autoStart = !!s.autoStart;
  s.autoRebuy = !!s.autoRebuy;
  s.rebuyAmount = clampInt(s.rebuyAmount, 0, 1000000, 0);
  s.timeoutFold = input.timeoutFold === undefined ? true : !!input.timeoutFold;
  return s;
}

function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export class GameTable {
  constructor(settings, hooks = {}) {
    this.settings = normalizeSettings(settings);
    this.hooks = hooks; // { onChange(reason), now() }
    this.now = hooks.now || (() => Date.now());

    this.seats = new Array(this.settings.seats).fill(null);
    this.phase = 'waiting';
    this.handNo = 0;
    this.dealerSeat = -1;
    this.sbSeat = -1;
    this.bbSeat = -1;
    this.actorSeat = -1;
    this.street = 0;
    this.board = [];
    this.deck = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.settings.bb;
    this.deadline = 0;
    this.results = null;
    this.pots = [];
    this.log = [];
    this.seq = 0;
    this.lastAggressor = -1;
    this.handStartedAt = 0;
    this.handEndedAt = 0;
    this.lastPot = 0;
    this.history = [];
    this.maxHistory = 60;
    this.handsRecorded = 0;
    this.lastRecord = null;
    this.handsPlayed = 0;
  }

  /* ---------------- 座位管理 ---------------- */

  seatOf(pid) {
    return this.seats.findIndex((s) => s && s.pid === pid);
  }

  seatInfo(idx) {
    return this.seats[idx] || null;
  }

  freeSeat() {
    return this.seats.findIndex((s) => !s);
  }

  addPlayer(pid, name) {
    const exist = this.seatOf(pid);
    if (exist >= 0) {
      this.seats[exist].connected = true;
      this.seats[exist].name = name;
      this._touch('连接');
      return { ok: true, seat: exist, rejoined: true };
    }
    const idx = this.freeSeat();
    if (idx < 0) return { ok: false, error: '房间已满' };
    this.seats[idx] = {
      pid,
      name,
      chips: this.settings.startChips,
      buyIn: this.settings.startChips, // 累计买入（含补码），用于算净输赢
      chipsAtHandStart: this.settings.startChips,
      bet: 0,
      committed: 0,
      cards: null,
      folded: false,
      allIn: false,
      hasActed: false,
      actedSinceFullRaise: false,
      inHand: false,
      sitOut: false,
      connected: true,
      lastAction: '',
      lastWin: 0,
      timeoutStreak: 0, // 连续超时次数，达到 3 次自动旁观
      joinedHand: this.handNo,
    };
    this._log({ t: 'join', seat: idx, name });
    this._touch('加入');
    return { ok: true, seat: idx };
  }

  removePlayer(pid) {
    const idx = this.seatOf(pid);
    if (idx < 0) return false;
    const seat = this.seats[idx];
    if (this.phase === 'betting' && seat.inHand && !seat.folded) {
      // 中途离桌视为弃牌，已投入的筹码留在池中
      seat.folded = true;
      seat.lastAction = '弃牌';
      if (seat.committed > 0) {
        this.pot += seat.committed;
        seat.committed = 0;
        seat.bet = 0;
      }
      if (this.actorSeat === idx) this.actorSeat = -1;
    }
    this._log({ t: 'leave', seat: idx, name: seat.name });
    this.seats[idx] = null;
    if (this.phase === 'betting') {
      if (this._aliveSeats().length <= 1) this._finishUncontested();
      else if (this.actorSeat < 0 || this.actorSeat === idx) this._runToStable(this._prevSeat(idx));
    }
    this._touch('离开');
    return true;
  }

  setConnected(pid, connected) {
    const idx = this.seatOf(pid);
    if (idx < 0) return;
    this.seats[idx].connected = connected;
    this._touch('在线状态');
  }

  setSitOut(pid, sitOut) {
    const idx = this.seatOf(pid);
    if (idx < 0) return { ok: false, error: '不在座位上' };
    const seat = this.seats[idx];
    if (this.phase === 'betting' && seat.inHand && sitOut) {
      return { ok: false, error: '本手牌进行中，无法旁观' };
    }
    seat.sitOut = !!sitOut;
    this._touch('旁观状态');
    return { ok: true };
  }

  rebuy(pid) {
    const idx = this.seatOf(pid);
    if (idx < 0) return { ok: false, error: '不在座位上' };
    if (this.phase === 'betting' && this.seats[idx].inHand) {
      return { ok: false, error: '本手牌进行中，结算后可补码' };
    }
    const amount = this.settings.rebuyAmount || this.settings.startChips;
    this.seats[idx].chips += amount;
    this.seats[idx].buyIn += amount;
    this.seats[idx].sitOut = false;
    this._log({ t: 'rebuy', seat: idx, name: this.seats[idx].name, amount });
    this._touch('补码');
    return { ok: true, amount };
  }

  /* ---------------- 开局 ---------------- */

  eligibleSeats() {
    const out = [];
    this.seats.forEach((s, i) => {
      if (s && !s.sitOut && (s.chips > 0 || this.settings.autoRebuy)) out.push(i);
    });
    return out;
  }

  canStart() {
    if (this.phase === 'betting') return { ok: false, error: '牌局进行中' };
    const eligible = this.eligibleSeats();
    if (eligible.length < 2) return { ok: false, error: '至少需要 2 位有筹码的玩家' };
    return { ok: true };
  }

  startHand() {
    const can = this.canStart();
    if (!can.ok) return can;

    // 自动补码
    if (this.settings.autoRebuy) {
      for (const s of this.seats) {
        if (s && s.chips <= 0 && !s.sitOut) {
          s.chips = this.settings.startChips;
          s.buyIn += this.settings.startChips;
        }
      }
    }

    const eligible = this.eligibleSeats();
    this.handNo += 1;
    this.handsPlayed += 1;
    this.handStartedAt = this.now();
    this.phase = 'betting';
    this.street = 0;
    this.board = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.settings.bb;
    this.results = null;
    this.pots = [];
    this.lastAggressor = -1;
    this.deadline = 0;

    for (const s of this.seats) {
      if (!s) continue;
      s.bet = 0;
      s.committed = 0;
      s.cards = null;
      s.folded = false;
      s.allIn = false;
      s.hasActed = false;
      s.actedSinceFullRaise = false;
      s.lastAction = '';
      s.lastWin = 0;
      s.chipsAtHandStart = s.chips; // 记录本手开始前的余额，摊牌后算输赢
      s.inHand = eligible.includes(this.seats.indexOf(s));
    }

    // 庄家按钮顺延
    this.dealerSeat = this._nextEligible(this.dealerSeat);
    if (this.dealerSeat < 0) return { ok: false, error: '没有可发牌的玩家' };

    const headsUp = eligible.length === 2;
    this.sbSeat = headsUp ? this.dealerSeat : this._nextEligible(this.dealerSeat);
    this.bbSeat = this._nextEligible(this.sbSeat);

    this.deck = this.hooks.deck ? this.hooks.deck() : shuffle(makeDeck());

    // 发底牌：每人两张
    for (const idx of this._orderedFrom(this.sbSeat === this.dealerSeat ? this.dealerSeat : this.sbSeat)) {
      const s = this.seats[idx];
      if (!s || !s.inHand) continue;
      s.cards = [this.deck.pop(), this.deck.pop()];
    }

    this._postBlind(this.sbSeat, this.settings.sb, '小盲');
    this._postBlind(this.bbSeat, this.settings.bb, '大盲');
    this.currentBet = this.settings.bb;
    this.minRaise = this.settings.bb;

    this._log({ t: 'hand', handNo: this.handNo, dealer: this.dealerSeat });
    this._log({ t: 'blinds', sb: this.sbSeat, bb: this.bbSeat, sbAmount: this.settings.sb, bbAmount: this.settings.bb });

    const first = this.bbSeat; // 3+ 人时大盲后一位先行动；单挑时大盲后一位正好是小盲（庄家）
    this._runToStable(first);
    return { ok: true };
  }

  _postBlind(idx, amount, label) {
    const s = this.seats[idx];
    if (!s) return;
    const pay = Math.min(amount, s.chips);
    s.chips -= pay;
    s.bet += pay;
    s.committed += pay;
    if (s.chips === 0) s.allIn = true;
    s.lastAction = label;
    this._log({ t: 'post', seat: idx, name: s.name, amount: pay, label });
  }

  _nextEligible(from) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const idx = ((from < 0 ? -1 : from) + i + n) % n;
      const s = this.seats[idx];
      if (s && s.inHand) return idx;
    }
    return -1;
  }

  _prevSeat(from) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const idx = ((from - i) % n + n) % n;
      if (this.seats[idx]) return idx;
    }
    return 0;
  }

  _orderedFrom(from) {
    const out = [];
    const n = this.seats.length;
    for (let i = 0; i < n; i++) out.push((from + i) % n);
    return out;
  }

  /* ---------------- 下注状态机 ---------------- */

  _aliveSeats() {
    const out = [];
    this.seats.forEach((s, i) => {
      if (s && s.inHand && !s.folded) out.push(i);
    });
    return out;
  }

  _needsAction(s) {
    return !!s && s.inHand && !s.folded && !s.allIn && s.chips > 0 && (!s.hasActed || s.bet < this.currentBet);
  }

  _findNextActor(after) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const idx = (after + i + n) % n;
      if (this._needsAction(this.seats[idx])) return idx;
    }
    return -1;
  }

  _runToStable(after) {
    for (let guard = 0; guard < 64; guard++) {
      if (this._aliveSeats().length <= 1) {
        this._finishUncontested();
        return;
      }
      // 只剩 1 人可以继续下注、且不欠任何注额时，牌局已无决策可做：直接发完公共牌摊牌
      const canAct = [];
      this.seats.forEach((s, i) => {
        if (s && s.inHand && !s.folded && !s.allIn && s.chips > 0) canAct.push(i);
      });
      if (canAct.length <= 1) {
        const lone = canAct[0];
        const owes = lone !== undefined && this.seats[lone].bet < this.currentBet;
        if (!owes) {
          while (this.street < 3) this._settleStreet();
          this._showdown();
          return;
        }
      }
      const next = this._findNextActor(after);
      if (next >= 0) {
        this.actorSeat = next;
        this.deadline = this.now() + this.settings.actionSeconds * 1000;
        this._touch('等待行动');
        return;
      }
      // 本轮无人可行动
      if (this.street >= 3) {
        this._showdown();
        return;
      }
      this._settleStreet();
      after = this.dealerSeat;
    }
  }

  _settleStreet() {
    for (const s of this.seats) {
      if (!s) continue;
      this.pot += s.bet;
      s.bet = 0;
    }
    this.currentBet = 0;
    this.minRaise = this.settings.bb;
    for (const s of this.seats) {
      if (!s) continue;
      s.hasActed = false;
      s.actedSinceFullRaise = false;
    }
    this.street += 1;
    this.deck.pop(); // 烧牌
    const need = this.street === 1 ? 3 : 1;
    for (let i = 0; i < need; i++) this.board.push(this.deck.pop());
    this._log({ t: 'street', street: this.street, name: STREET_NAMES[this.street], board: this.board.slice() });
    this.actorSeat = -1;
    this.deadline = 0;
  }

  toCallOf(idx) {
    const s = this.seats[idx];
    if (!s) return 0;
    return Math.max(0, this.currentBet - s.bet);
  }

  /* ---------------- 行动 ---------------- */

  act(pid, action = {}, opts = {}) {
    if (this.phase !== 'betting') return { ok: false, error: '当前不在牌局中' };
    const idx = this.seatOf(pid);
    if (idx < 0) return { ok: false, error: '你不在牌桌上' };
    if (idx !== this.actorSeat) return { ok: false, error: '还没轮到你行动' };
    const seat = this.seats[idx];
    if (this._needsAction(seat) === false) return { ok: false, error: '当前无法行动' };

    // 手动行动说明人还在，清空"连续超时"计数
    if (!opts.auto) seat.timeoutStreak = 0;

    const toCall = this.toCallOf(idx);
    const type = String(action.type || '').toLowerCase();

    if (type === 'fold') {
      seat.folded = true;
      seat.lastAction = '弃牌';
      this._log({ t: 'action', seat: idx, name: seat.name, action: 'fold', label: '弃牌', amount: 0 });
    } else if (type === 'check') {
      if (toCall > 0) return { ok: false, error: '有下注，不能过牌' };
      seat.lastAction = '过牌';
      this._log({ t: 'action', seat: idx, name: seat.name, action: 'check', label: '过牌', amount: 0 });
    } else if (type === 'call') {
      if (toCall <= 0) return { ok: false, error: '无需跟注' };
      const pay = Math.min(toCall, seat.chips);
      this._pay(seat, pay);
      seat.lastAction = pay >= toCall ? '跟注' : '全下';
      this._log({
        t: 'action', seat: idx, name: seat.name,
        action: pay >= toCall ? 'call' : 'allin', label: seat.lastAction, amount: pay,
      });
    } else if (type === 'raise' || type === 'bet') {
      const maxTo = seat.bet + seat.chips;
      let to = Math.floor(Number(action.to));
      if (!Number.isFinite(to)) return { ok: false, error: '加注金额无效' };
      if (to > maxTo) to = maxTo;
      if (to <= this.currentBet) return { ok: false, error: '加注必须高于当前下注' };
      const minTo = this.currentBet + this.minRaise;
      if (to < minTo && to < maxTo) {
        return { ok: false, error: `最少加注到 ${minTo}` };
      }
      if (seat.hasActed && seat.actedSinceFullRaise) {
        return { ok: false, error: '本轮已行动，仅可跟注或弃牌' };
      }
      const raiseSize = to - this.currentBet;
      const pay = to - seat.bet;
      this._pay(seat, pay);
      const wasAllIn = seat.allIn;
      this.currentBet = to;
      if (raiseSize >= this.minRaise) {
        this.minRaise = raiseSize;
        for (const s of this.seats) {
          if (s && s !== seat) s.actedSinceFullRaise = false;
        }
      }
      this.lastAggressor = idx;
      seat.lastAction = wasAllIn ? '全下' : '加注';
      this._log({
        t: 'action', seat: idx, name: seat.name,
        action: wasAllIn ? 'allin' : 'raise', label: seat.lastAction, amount: to,
      });
    } else if (type === 'allin' || type === 'all-in') {
      if (seat.chips <= 0) return { ok: false, error: '没有可用筹码' };
      const to = seat.bet + seat.chips;
      const raiseSize = to - this.currentBet;
      this._pay(seat, seat.chips);
      if (to > this.currentBet) {
        this.currentBet = to;
        if (raiseSize >= this.minRaise) {
          this.minRaise = raiseSize;
          for (const s of this.seats) {
            if (s && s !== seat) s.actedSinceFullRaise = false;
          }
        }
        this.lastAggressor = idx;
      }
      seat.lastAction = '全下';
      this._log({ t: 'action', seat: idx, name: seat.name, action: 'allin', label: '全下', amount: to });
    } else {
      return { ok: false, error: '未知操作' };
    }

    seat.hasActed = true;
    seat.actedSinceFullRaise = true;
    this.actorSeat = -1;
    this.deadline = 0;
    this._runToStable(idx);
    return { ok: true };
  }

  _pay(seat, amount) {
    const pay = Math.max(0, Math.min(amount, seat.chips));
    seat.chips -= pay;
    seat.bet += pay;
    seat.committed += pay;
    if (seat.chips === 0) seat.allIn = true;
    return pay;
  }

  /**
   * 超时自动行动：默认一律弃牌（timeoutFold=true），
   * 关闭该设置后改为"能过牌就过牌，否则弃牌"。
   * 连续 3 次超时自动进入旁观，避免整桌陪着等一个不在的人。
   */
  timeout() {
    if (this.phase !== 'betting' || this.actorSeat < 0) return { ok: false };
    const idx = this.actorSeat;
    const seat = this.seats[idx];
    if (!seat) return { ok: false };
    const toCall = this.toCallOf(idx);
    const type = this.settings.timeoutFold ? 'fold' : toCall === 0 ? 'check' : 'fold';
    seat.timeoutStreak = (seat.timeoutStreak || 0) + 1;
    this._log({ t: 'timeout', seat: idx, name: seat.name, auto: type, streak: seat.timeoutStreak });
    const result = this.act(seat.pid, { type }, { auto: true });
    if (seat.timeoutStreak >= 3 && !seat.sitOut) {
      seat.sitOut = true;
      this._log({ t: 'autositout', seat: idx, name: seat.name, streak: seat.timeoutStreak });
      this._touch('自动旁观');
    }
    return result;
  }

  /* ---------------- 结算 ---------------- */

  _finishUncontested() {
    const alive = this._aliveSeats();
    const winner = alive[0];
    for (const s of this.seats) {
      if (!s) continue;
      this.pot += s.bet;
      s.bet = 0;
    }
    const amount = this.pot;
    if (winner >= 0 && this.seats[winner]) {
      this.seats[winner].chips += amount;
      this.seats[winner].lastWin = amount;
      this._log({ t: 'win', seat: winner, name: this.seats[winner].name, amount, reason: '其他人弃牌' });
    }
    this.results = {
      showdown: false,
      awards: winner >= 0 ? [{ seat: winner, pid: this.seats[winner].pid, name: this.seats[winner].name, amount, handName: '', cards: null }] : [],
      reveals: [],
    };
    this._endHand();
  }

  _showdown() {
    for (const s of this.seats) {
      if (!s) continue;
      this.pot += s.bet;
      s.bet = 0;
    }
    const contenders = [];
    this.seats.forEach((s, i) => {
      if (s && s.inHand && !s.folded) {
        const all = s.cards.concat(this.board);
        const ev = evaluate(all);
        contenders.push({ seat: i, s, ev, handName: ev.name });
      }
    });

    // 边池分层
    const levels = [...new Set(this.seats.filter((s) => s && s.committed > 0).map((s) => s.committed))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of levels) {
      let amount = 0;
      for (const s of this.seats) {
        if (!s) continue;
        amount += Math.max(0, Math.min(s.committed, lvl) - prev);
      }
      const eligible = contenders.filter((c) => c.s.committed >= lvl);
      pots.push({ amount, eligible });
      prev = lvl;
    }

    const awards = [];
    const addAward = (seat, amount) => {
      const a = awards.find((x) => x.seat === seat);
      if (a) a.amount += amount;
      else awards.push({ seat, amount });
    };

    let carry = 0;
    for (const pot of pots) {
      const amount = pot.amount + carry;
      if (amount <= 0) continue;
      if (pot.eligible.length === 0) {
        carry = amount; // 死钱并入下一层
        continue;
      }
      carry = 0;
      let best = null;
      for (const c of pot.eligible) {
        if (!best || compareScore(c.ev.score, best.ev.score) > 0) best = c;
      }
      const winners = pot.eligible.filter((c) => compareScore(c.ev.score, best.ev.score) === 0);
      const share = Math.floor(amount / winners.length);
      let remainder = amount - share * winners.length;
      const ordered = winners.slice().sort((a, b) => this._distanceFromDealer(a.seat) - this._distanceFromDealer(b.seat));
      for (const w of ordered) {
        let give = share;
        if (remainder > 0) {
          give += 1;
          remainder -= 1;
        }
        addAward(w.seat, give);
      }
      this._log({
        t: 'pot',
        amount,
        winners: winners.map((w) => ({ seat: w.seat, name: w.s.name, handName: w.handName })),
        sidePot: pots.length > 1,
      });
    }
    if (carry > 0) {
      // 理论上不会发生：兜底给最好的牌
      let best = contenders[0];
      for (const c of contenders) if (compareScore(c.ev.score, best.ev.score) > 0) best = c;
      if (best) addAward(best.seat, carry);
    }

    for (const a of awards) {
      const s = this.seats[a.seat];
      if (!s) continue;
      s.chips += a.amount;
      s.lastWin = a.amount;
    }

    const reveals = contenders.map((c) => ({
      seat: c.seat,
      pid: c.s.pid,
      name: c.s.name,
      cards: c.s.cards.slice(),
      handName: c.handName,
      best5: c.ev.best5,
    }));

    this.results = {
      showdown: true,
      board: this.board.slice(),
      reveals,
      awards: awards
        .map((a) => {
          const r = reveals.find((x) => x.seat === a.seat);
          return {
            seat: a.seat,
            pid: this.seats[a.seat] ? this.seats[a.seat].pid : null,
            name: this.seats[a.seat] ? this.seats[a.seat].name : '',
            amount: a.amount,
            handName: r ? r.handName : '',
          };
        })
        .sort((a, b) => b.amount - a.amount),
    };
    for (const a of this.results.awards) {
      this._log({ t: 'win', seat: a.seat, name: a.name, amount: a.amount, handName: a.handName, reason: a.handName || '摊牌' });
    }
    this._endHand();
  }

  _distanceFromDealer(seat) {
    const n = this.seats.length;
    return (seat - this.dealerSeat + n) % n;
  }

  _endHand() {
    this.phase = 'showdown';
    this.actorSeat = -1;
    this.deadline = 0;
    this.lastPot = this.pot;
    this.pot = 0;
    for (const s of this.seats) {
      if (!s) continue;
      s.bet = 0;
      if (s.chips <= 0 && s.inHand && !this.settings.autoRebuy) {
        s.sitOut = true;
        this._log({ t: 'busted', seat: this.seats.indexOf(s), name: s.name });
      }
    }
    this._recordHand();
    this.handEndedAt = this.now();
    this._touch('一手结束');
  }

  /** 记录这一手：每个人本手开始/结束的筹码与输赢，供房间内「对局记录」查看。 */
  _recordHand() {
    const players = [];
    this.seats.forEach((s, i) => {
      if (!s || !s.inHand) return;
      const before = typeof s.chipsAtHandStart === 'number' ? s.chipsAtHandStart : s.chips;
      players.push({
        seat: i,
        name: s.name,
        before,
        after: s.chips,
        delta: s.chips - before,
        committed: s.committed,
        folded: s.folded,
      });
    });
    const record = {
      handNo: this.handNo,
      at: this.handStartedAt,
      dealerSeat: this.dealerSeat,
      board: this.board.slice(),
      pot: this.lastPot,
      showdown: !!(this.results && this.results.showdown),
      awards: (this.results && this.results.awards ? this.results.awards : []).map((a) => ({
        seat: a.seat,
        name: a.name,
        amount: a.amount,
        handName: a.handName || '',
      })),
      players,
    };
    this.history.push(record);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    this.handsRecorded += 1;
    this.lastRecord = record;
    return record;
  }

  /** 对局记录：最近的手牌流水 + 每位玩家的买入/当前/净输赢。 */
  handHistory(limit = 30) {
    const players = [];
    const liveHand = this.phase === 'betting';
    this.seats.forEach((s, i) => {
      if (!s) return;
      // 牌局进行中，已投入底池的筹码还没结算回来：算进"当前"才不会让账对不上
      const inPlay = liveHand && s.inHand ? s.committed : 0;
      const chips = s.chips + inPlay;
      players.push({
        seat: i,
        name: s.name,
        buyIn: s.buyIn,
        chips,
        inPlay,
        delta: chips - s.buyIn,
        sitOut: s.sitOut,
        inHandNow: liveHand && s.inHand,
      });
    });
    return {
      hands: this.history.slice(-limit),
      players,
      totalHands: this.handsRecorded,
      currentHandNo: this.handNo,
      inPlay: liveHand,
    };
  }

  /* ---------------- 视图 ---------------- */

  logEntries() {
    return this.log;
  }

  _log(entry) {
    this.seq += 1;
    this.log.push({ ...entry, i: this.seq });
    if (this.log.length > 120) this.log.splice(0, this.log.length - 120);
  }

  _touch(reason) {
    if (this.hooks.onChange) this.hooks.onChange(reason);
  }

  /** 给某个玩家（或旁观者 viewerPid=null）的桌面视图。 */
  view(viewerPid = null) {
    const youSeat = viewerPid ? this.seatOf(viewerPid) : -1;
    const reveal = this.phase === 'showdown' && this.results && this.results.showdown;
    const seats = this.seats.map((s, i) => {
      if (!s) return null;
      const showCards = (youSeat === i && s.cards) || (reveal && s.inHand && !s.folded && s.cards);
      return {
        seat: i,
        pid: s.pid,
        name: s.name,
        chips: s.chips,
        bet: s.bet,
        folded: s.folded,
        allIn: s.allIn,
        inHand: s.inHand,
        sitOut: s.sitOut,
        connected: s.connected,
        lastAction: s.lastAction,
        lastWin: s.lastWin,
        isDealer: i === this.dealerSeat && this.phase !== 'waiting',
        cards: showCards ? s.cards.slice() : null,
        cardCount: s.inHand && s.cards ? 2 : 0,
      };
    });

    let you = null;
    if (youSeat >= 0) {
      const s = this.seats[youSeat];
      const toCall = this.toCallOf(youSeat);
      const maxTo = s.bet + s.chips;
      const minTo = Math.min(this.currentBet + this.minRaise, maxTo);
      const isTurn = this.phase === 'betting' && this.actorSeat === youSeat;
      const canRaise = !!isTurn && !s.actedSinceFullRaise;
      you = {
        seat: youSeat,
        chips: s.chips,
        bet: s.bet,
        cards: s.cards ? s.cards.slice() : null,
        folded: s.folded,
        allIn: s.allIn,
        inHand: s.inHand,
        sitOut: s.sitOut,
        isTurn,
        toCall: Math.min(toCall, s.chips),
        legal: isTurn
          ? {
              fold: true,
              check: toCall === 0,
              call: toCall > 0 ? Math.min(toCall, s.chips) : 0,
              raise: canRaise && maxTo > this.currentBet,
              minTo,
              maxTo,
              allin: s.chips > 0,
            }
          : null,
      };
    }

    return {
      phase: this.phase,
      handNo: this.handNo,
      street: this.street,
      streetName: this.phase === 'betting' ? STREET_NAMES[this.street] : STREET_NAMES[3],
      board: this.board.slice(),
      pot: this.phase === 'betting' ? this.pot + this._betsTotal() : (this.lastPot || 0),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      dealerSeat: this.dealerSeat,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      actorSeat: this.actorSeat,
      deadline: this.deadline,
      now: this.now(),
      settings: this.settings,
      seats,
      you,
      results: this.results,
      log: this.log.slice(-40),
      sitOutCount: this.seats.filter((s) => s && s.sitOut).length,
    };
  }

  _betsTotal() {
    return this.seats.reduce((sum, s) => sum + (s ? s.bet : 0), 0);
  }

  /** 用于持久化/战绩的摘要（对应 CoCo 云数据表“战绩表”的一行）。 */
  handRecord(roomCode) {
    return {
      room: roomCode,
      handNo: this.handNo,
      at: this.handStartedAt,
      board: cardsText(this.board),
      results: this.results,
      pots: this.pot,
    };
  }
}
