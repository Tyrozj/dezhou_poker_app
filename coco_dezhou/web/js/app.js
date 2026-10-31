/**
 * 手机端界面逻辑：大厅 -> 创建房间 -> 牌桌 -> 结算。
 * 所有状态都来自服务端推送（权威裁判），这里只负责渲染与交互。
 */

import { Net } from './net.js';
import { audio } from './audio.js';
import { evaluate, RANK_NAME, SUIT_SYMBOL } from '/shared/cards.mjs';

const $ = (id) => document.getElementById(id);
const net = new Net();

const S = {
  screen: 'home',
  room: null,
  view: null,
  me: null,
  rooms: [],
  chat: [],
  skew: 0,
  raiseOpen: false,
  raiseTo: 0,
  turnKey: '',
  resultHand: 0,
  boardCount: 0,
  lastHand: 0,
  lastRoomState: null,
  history: null,
  histTab: 'hands',
  histOpen: new Set(),
  logSeq: 0,
  wasMyTurn: false,
};

const LS_NICK = 'dz.nick';
const LS_SESS = 'dz.sess';

/* ---------------- 座位坐标（p=0 永远是自己，位于正下方） ---------------- */

const SEAT_POS = {
  2: [[50, 84], [50, 12]],
  3: [[50, 84], [16, 27], [84, 27]],
  4: [[50, 84], [11, 50], [50, 12], [89, 50]],
  5: [[50, 84], [11, 56], [26, 16], [74, 16], [89, 56]],
  6: [[50, 84], [10, 58], [18, 20], [50, 12], [82, 20], [90, 58]],
  7: [[50, 84], [9, 62], [14, 32], [32, 13], [68, 13], [86, 32], [91, 62]],
  8: [[50, 84], [9, 64], [13, 38], [30, 14], [50, 10], [70, 14], [87, 38], [91, 64]],
};

function seatPositions(n) {
  const key = Math.min(8, Math.max(2, n || 6));
  return SEAT_POS[key];
}

/* ---------------- 小工具 ---------------- */

function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

let toastTimer = null;
function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-show'), ms);
}

function showScreen(name) {
  S.screen = name;
  for (const node of document.querySelectorAll('.screen')) node.classList.remove('is-active');
  const target = $(`screen-${name}`);
  if (target) target.classList.add('is-active');
  if (name === 'home') {
    renderRooms(S.rooms);
    net.listRooms();
  }
}

function cardEl(card) {
  const d = el('div', 'pcard' + (card[1] === 'h' || card[1] === 'd' ? ' red' : ''));
  d.innerHTML = `<span class="rk">${RANK_NAME[card[0]]}</span><span class="st">${SUIT_SYMBOL[card[1]]}</span>`;
  return d;
}

function backEl() {
  return el('div', 'pcard back');
}

function slotEl() {
  return el('div', 'pcard slot');
}

/* ---------------- 大厅 ---------------- */

function initLobby() {
  const nick = localStorage.getItem(LS_NICK) || '';
  $('nickname').value = nick;

  $('nickname').addEventListener('input', (e) => {
    localStorage.setItem(LS_NICK, e.target.value.trim());
  });

  $('btn-go-create').addEventListener('click', () => {
    if (!ensureNickname()) return;
    showScreen('create');
  });

  $('btn-join').addEventListener('click', () => {
    const code = ($('code-input').value || '').replace(/\D/g, '');
    if (code.length !== 6) return toast('请输入 6 位房号');
    if (!ensureNickname()) return;
    doJoin(code);
  });

  $('code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });

  $('code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-join').click();
  });

  $('btn-refresh').addEventListener('click', () => net.listRooms());
}

function ensureNickname() {
  const nick = ($('nickname').value || '').trim();
  if (!nick) {
    toast('先给自己起个昵称');
    $('nickname').focus();
    return false;
  }
  localStorage.setItem(LS_NICK, nick);
  return true;
}

function nickname() {
  return ($('nickname').value || '').trim() || '玩家';
}

function renderRooms(rooms) {
  S.rooms = rooms || [];
  const box = $('room-list');
  box.innerHTML = '';
  if (!S.rooms.length) {
    box.appendChild(el('div', 'empty', '暂无房间，创建一个吧'));
    return;
  }
  for (const r of S.rooms) {
    const item = el('button', 'room-item');
    item.innerHTML = `
      <div class="r-main">
        <div class="r-code">#${r.code}</div>
        <div class="r-sub">${r.name || '牌局'} · ${r.players}/${r.seats} 人 · 盲注 ${r.sb}/${r.bb}</div>
      </div>
      <span class="r-go">${r.players >= r.seats ? '已满' : '进入'}</span>`;
    item.addEventListener('click', () => {
      if (r.players >= r.seats) return toast('该房间已满');
      if (!ensureNickname()) return;
      doJoin(r.code);
    });
    box.appendChild(item);
  }
}

function doJoin(code) {
  let token = null;
  try {
    const saved = JSON.parse(localStorage.getItem(LS_SESS) || 'null');
    if (saved && saved.code === String(code)) token = saved.token;
  } catch {
    token = null;
  }
  net.joinRoom({ code, nickname: nickname(), token });
  toast('正在进入房间…', 900);
}

/* ---------------- 创建房间 ---------------- */

function initCreate() {
  for (const back of document.querySelectorAll('[data-back]')) {
    back.addEventListener('click', () => showScreen(back.dataset.back));
  }

  for (const stepper of document.querySelectorAll('[data-stepper]')) {
    stepper.addEventListener('click', (e) => {
      const btn = e.target.closest('.step-btn');
      if (!btn) return;
      const input = stepper.querySelector('input');
      const dir = Number(btn.dataset.dir);
      const stepMap = { seats: 1, chips: 100, seconds: 5 };
      const step = stepMap[stepper.dataset.stepper] || 1;
      const min = Number(input.min || 0);
      const max = Number(input.max || 999999);
      let v = Number(input.value || 0) + dir * step;
      v = Math.max(min, Math.min(max, v));
      input.value = v;
      if (stepper.dataset.stepper === 'seats') renderChipPills();
    });
  }

  for (const pill of document.querySelectorAll('[data-chips]')) {
    pill.addEventListener('click', () => {
      $('cfg-chips').value = pill.dataset.chips;
      renderChipPills();
    });
  }

  for (const pill of document.querySelectorAll('[data-blind]')) {
    pill.addEventListener('click', () => {
      const [sb, bb] = pill.dataset.blind.split(',');
      $('cfg-sb').value = sb;
      $('cfg-bb').value = bb;
      renderBlindPills();
    });
  }

  $('cfg-sb').addEventListener('input', () => {
    const sb = Number($('cfg-sb').value || 0);
    if (sb > 0) $('cfg-bb').value = Math.max(sb * 2, Number($('cfg-bb').value || 0));
    renderBlindPills();
  });
  $('cfg-bb').addEventListener('input', renderBlindPills);
  $('cfg-chips').addEventListener('input', renderChipPills);

  $('btn-create').addEventListener('click', () => {
    if (!ensureNickname()) return showScreen('home');
    const seats = clamp(Number($('cfg-seats').value), 2, 8);
    const startChips = clamp(Number($('cfg-chips').value), 100, 1000000);
    const sb = clamp(Number($('cfg-sb').value), 1, 100000);
    const bb = clamp(Number($('cfg-bb').value), sb * 2, 200000);
    if (startChips < bb * 10) {
      $('create-hint').textContent = '起始筹码建议至少为大盲的 10 倍';
    } else {
      $('create-hint').textContent = '';
    }
    net.createRoom({
      nickname: nickname(),
      name: ($('cfg-name').value || '').trim(),
      settings: {
        seats,
        startChips,
        sb,
        bb,
        actionSeconds: clamp(Number($('cfg-seconds').value), 10, 120),
        autoStart: $('cfg-autostart').checked,
        autoRebuy: $('cfg-autorebuy').checked,
        timeoutFold: $('cfg-timeoutfold').checked,
      },
    });
    toast('正在创建房间…', 900);
  });

  renderChipPills();
  renderBlindPills();
}

function clamp(v, min, max) {
  const n = Number.isFinite(v) ? v : min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function renderChipPills() {
  const v = String($('cfg-chips').value);
  for (const p of document.querySelectorAll('[data-chips]')) {
    p.classList.toggle('is-active', p.dataset.chips === v);
  }
}

function renderBlindPills() {
  const key = `${$('cfg-sb').value},${$('cfg-bb').value}`;
  for (const p of document.querySelectorAll('[data-blind]')) {
    p.classList.toggle('is-active', p.dataset.blind === key);
  }
}

/* ---------------- 牌桌渲染 ---------------- */

function renderTable() {
  const v = S.view;
  if (!v || !S.room) return;

  $('room-code').textContent = `#${S.room.code}`;
  const seated = S.room.members.filter((m) => m.seat !== null).length;
  const stage = v.phase === 'waiting' ? '等待开局' : `第 ${v.handNo} 手 · ${v.streetName}`;
  $('room-meta').textContent = `${S.room.settings.sb}/${S.room.settings.bb} · ${seated}/${S.room.settings.seats} 人 · ${stage}`;

  renderBoard(v);
  renderSeats(v);
  renderMe(v);
  renderActions(v);
  renderLogStrip(v);
  renderResult(v);
  updateTurnBar();
}

function renderBoard(v) {
  const board = $('board');
  board.innerHTML = '';
  const cards = v.board || [];
  if (!cards.length) S.boardCount = 0;
  for (let i = 0; i < 5; i++) {
    if (cards[i]) {
      const c = cardEl(cards[i]);
      if (i >= S.boardCount) c.classList.add('anim');
      board.appendChild(c);
    } else {
      board.appendChild(slotEl());
    }
  }
  S.boardCount = cards.length;
  $('pot').textContent = v.phase === 'waiting' ? '盲注 ' + v.settings.sb + '/' + v.settings.bb : `底池 ${fmt(v.pot)}`;
  $('street-tag').textContent = v.phase === 'waiting' ? '' : v.streetName;
}

function renderSeats(v) {
  const layer = $('seat-layer');
  layer.innerHTML = '';
  const n = v.settings.seats;
  const pos = seatPositions(n);
  const mySeat = v.you ? v.you.seat : -1;

  for (const seat of v.seats) {
    if (!seat) continue;
    const p = mySeat >= 0 ? (seat.seat - mySeat + n * 2) % n : seat.seat;
    const xy = pos[p] || [50, 50];
    layer.appendChild(seatEl(seat, xy, v, mySeat));
  }

  // 等待提示
  const tip = $('center-tip');
  if (v.phase === 'waiting') {
    const seated = v.seats.filter(Boolean).length;
    tip.innerHTML = `等待玩家加入…<br><b>${seated}/${n}</b> 人<br><span style="font-size:11px;opacity:.6">房号 #${S.room.code}</span>`;
  } else if (v.phase === 'showdown') {
    tip.innerHTML = '';
  } else if (v.you && !v.you.inHand) {
    tip.innerHTML = '本手未参与<br><span style="font-size:11px;opacity:.6">等待下一手</span>';
  } else if (v.you && v.you.folded) {
    tip.innerHTML = '已弃牌<br><span style="font-size:11px;opacity:.6">等待本手结束</span>';
  } else {
    tip.innerHTML = '';
  }
}

function seatEl(seat, xy, v, mySeat) {
  const isMe = seat.seat === mySeat;
  const isTurn = v.actorSeat === seat.seat && v.phase === 'betting';
  const cls = ['seat'];
  const dx = xy[0] - 50;
  const dy = xy[1] - 50;
  if (Math.abs(dx) > 24) cls.push(dx > 0 ? 'chip-left' : 'chip-right');
  else cls.push(dy < 0 ? 'dir-down' : 'dir-up');
  if (isMe) cls.push('is-me');
  if (seat.folded || seat.sitOut || !seat.inHand) cls.push('is-out');
  if (isTurn) cls.push('is-turn');

  const node = el('div', cls.join(' '));
  node.style.left = xy[0] + '%';
  node.style.top = xy[1] + '%';

  if (isMe && seat.chips === 0) {
    node.addEventListener('click', () => net.rebuy());
  }

  // 对手底牌
  if (!isMe) {
    const hole = el('div', 'hole');
    if (seat.cards && seat.cards.length) {
      for (const c of seat.cards) hole.appendChild(cardEl(c));
    } else if (seat.inHand && seat.cardCount === 2) {
      hole.appendChild(backEl());
      hole.appendChild(backEl());
    }
    node.appendChild(hole);
  }

  let tag = '';
  let tagCls = '';
  if (!seat.connected) {
    tag = '离线';
  } else if (seat.folded) {
    tag = '弃牌';
    tagCls = 'fold';
  } else if (seat.allIn) {
    tag = '全下';
    tagCls = 'allin';
  } else if (isTurn) {
    tag = '思考中';
    tagCls = 'act';
  } else if (seat.sitOut) {
    tag = '旁观';
  } else if (!seat.inHand && v.phase !== 'waiting') {
    tag = '等待';
  } else if (seat.lastAction) {
    tag = seat.lastAction;
  }

  const plate = el('div', 'plate');
  plate.innerHTML = `<div class="nm">${escapeHtml(seat.name)}${seat.isDealer ? '' : ''}</div>
    <div class="ch">${fmt(seat.chips)}</div>
    ${tag ? `<div class="st-tag ${tagCls}">${tag}</div>` : ''}`;

  if (isMe) plate.style.borderColor = 'rgba(232,196,121,.55)';
  node.appendChild(plate);

  if (seat.isDealer) {
    node.appendChild(el('div', 'dealer-btn', 'D'));
  }
  if (seat.bet > 0) {
    node.appendChild(el('div', 'bet-chip', fmt(seat.bet)));
  }
  return node;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMe(v) {
  const you = v.you;
  const box = $('me-cards');
  box.innerHTML = '';
  const isNewHand = S.lastHand !== v.handNo;
  if (you && you.cards) {
    for (const c of you.cards) {
      const node = cardEl(c);
      if (isNewHand) node.classList.add('anim');
      box.appendChild(node);
    }
  } else if (you && you.inHand) {
    box.appendChild(backEl());
    box.appendChild(backEl());
  }
  S.lastHand = v.handNo;

  $('me-name').textContent = you ? you.name : '观战';
  $('me-chips').textContent = you ? fmt(you.chips) : '—';

  let state = '';
  if (!you) state = '观战中';
  else if (v.phase === 'waiting') state = '等待开局';
  else if (v.phase === 'showdown') state = '本手结束';
  else if (you.sitOut && !you.inHand) state = '旁观中';
  else if (you.folded) state = '已弃牌';
  else if (you.allIn) state = '已全下，等待发牌';
  else if (you.isTurn) {
    const remain = Math.max(0, Math.ceil((v.deadline - (Date.now() + S.skew)) / 1000));
    state = `轮到你行动 · ${remain}s`;
  } else if (you.inHand && v.actorSeat >= 0) {
    const actor = v.seats[v.actorSeat];
    state = `等待 ${actor ? actor.name : ''} 行动`;
  }

  // 本地牌力提示
  if (you && you.cards && v.board && v.board.length >= 3 && !you.folded) {
    const ev = evaluate([...you.cards, ...v.board]);
    if (ev.cat >= 0) state += ` · ${ev.name}`;
  }
  $('me-state').textContent = state;
}

function renderActions(v) {
  const bar = $('action-bar');
  const you = v.you;

  // 回合标识变化时收起加注面板
  const key = `${v.handNo}-${v.street}-${v.actorSeat}-${v.currentBet}`;
  if (key !== S.turnKey) {
    S.turnKey = key;
    S.raiseOpen = false;
  }

  bar.innerHTML = '';

  if (!you) {
    bar.appendChild(el('div', 'action-tip', '你是旁观者，等待空位入座'));
    return;
  }

  if (!you.inHand && v.phase === 'betting') {
    if (you.chips <= 0) {
      const btn = el('button', 'btn btn-primary btn-block', '筹码用完了，补码后下一手入座');
      btn.addEventListener('click', () => net.rebuy());
      bar.appendChild(btn);
      return;
    }
    bar.appendChild(el('div', 'action-tip', '本手未参与，等待下一手'));
    return;
  }

  if (you.sitOut) {
    if (you.chips <= 0) {
      const btn = el('button', 'btn btn-primary btn-block', '补码继续游戏');
      btn.addEventListener('click', () => net.rebuy());
      bar.appendChild(btn);
      return;
    }
    const btn = el('button', 'btn btn-primary btn-block', '回到牌桌');
    btn.addEventListener('click', () => net.sitOut(false));
    bar.appendChild(btn);
    return;
  }

  if (v.phase === 'waiting') {
    if (you.isHost) {
      const btn = el('button', 'btn btn-primary btn-block btn-lg', '开始牌局');
      btn.addEventListener('click', () => net.startGame());
      bar.appendChild(btn);
    } else {
      bar.appendChild(el('div', 'action-tip', '等待房主开始牌局…'));
    }
    return;
  }

  if (v.phase === 'showdown') {
    if (you.isHost) {
      const btn = el('button', 'btn btn-primary btn-block', '立即开始下一手');
      btn.addEventListener('click', () => net.startGame());
      bar.appendChild(btn);
    } else {
      bar.appendChild(el('div', 'action-tip', '本手结束，等待下一手…'));
    }
    return;
  }

  if (!you.isTurn) {
    const actor = v.actorSeat >= 0 ? v.seats[v.actorSeat] : null;
    const remain = v.deadline ? Math.max(0, Math.ceil((v.deadline - (Date.now() + S.skew)) / 1000)) : 0;
    bar.appendChild(el('div', 'action-tip', `等待 ${actor ? escapeHtml(actor.name) : '其他人'} 行动${remain ? ` · ${remain}s` : ''}`));
    return;
  }

  const legal = you.legal || {};
  if (S.raiseOpen) {
    bar.appendChild(raisePanel(v, legal, you));
  }

  const row = el('div', 'action-row');

  const fold = el('button', 'btn act-fold', '弃牌');
  fold.addEventListener('click', () => {
    audio.play('fold');
    net.action({ type: 'fold' });
  });
  row.appendChild(fold);

  if (legal.check) {
    const check = el('button', 'btn act-check', '过牌');
    check.addEventListener('click', () => {
      audio.play('check');
      net.action({ type: 'check' });
    });
    row.appendChild(check);
  } else if (legal.call) {
    const allInCall = legal.call >= you.chips;
    const call = el('button', 'btn act-call', allInCall ? `全下 ${fmt(legal.call)}` : `跟注 ${fmt(legal.call)}`);
    call.addEventListener('click', () => {
      audio.play(allInCall ? 'allin' : 'chip');
      net.action({ type: 'call' });
    });
    row.appendChild(call);
  }

  if (legal.raise) {
    const minTo = legal.minTo;
    const raiseBtn = el('button', 'btn act-raise', S.raiseOpen ? '确认加注' : '加注');
    raiseBtn.addEventListener('click', () => {
      if (!S.raiseOpen) {
        audio.play('click');
        S.raiseOpen = true;
        S.raiseTo = minTo;
        renderActions(S.view);
      } else {
        audio.play('raise');
        net.action({ type: 'raise', to: S.raiseTo });
        S.raiseOpen = false;
      }
    });
    row.appendChild(raiseBtn);
  }

  if (legal.allin) {
    const allin = el('button', 'btn act-allin', '全下');
    allin.addEventListener('click', () => {
      audio.play('allin');
      net.action({ type: 'allin' });
    });
    row.appendChild(allin);
  }

  bar.appendChild(row);
}

function raisePanel(v, legal, you) {
  const minTo = legal.minTo;
  const maxTo = legal.maxTo;
  if (S.raiseTo < minTo || S.raiseTo > maxTo) S.raiseTo = minTo;

  const wrap = el('div', 'raise-panel is-open');
  const bb = v.settings.bb;
  const pot = v.pot || 0;
  const clampTo = (val) => Math.max(minTo, Math.min(maxTo, Math.round(val / bb) * bb));

  const quick = [
    { label: '最小', value: minTo },
    { label: '½ 池', value: clampTo(you.bet + legal.call + pot / 2) },
    { label: '满池', value: clampTo(you.bet + legal.call + pot) },
    { label: '全下', value: maxTo },
  ];

  const top = el('div', 'raise-top');
  top.innerHTML = `<span>加注到</span><span class="raise-value" id="raise-value">${fmt(S.raiseTo)}</span>`;
  wrap.appendChild(top);

  const quickBox = el('div', 'raise-quick');
  for (const q of quick) {
    const pill = el('button', 'pill', q.label);
    pill.addEventListener('click', () => {
      S.raiseTo = q.value;
      const input = wrap.querySelector('input[type=range]');
      if (input) input.value = q.value;
      wrap.querySelector('#raise-value').textContent = fmt(q.value);
    });
    quickBox.appendChild(pill);
  }
  wrap.appendChild(quickBox);

  const slider = el('input', 'raise-range');
  slider.type = 'range';
  slider.min = String(minTo);
  slider.max = String(Math.max(minTo, maxTo));
  slider.step = '1';
  slider.value = String(S.raiseTo);
  slider.addEventListener('input', () => {
    S.raiseTo = Number(slider.value);
    wrap.querySelector('#raise-value').textContent = fmt(S.raiseTo);
  });
  wrap.appendChild(slider);

  const range = el('div', 'raise-quick');
  range.innerHTML = `<span style="font-size:11px;color:var(--ink-3)">范围 ${fmt(minTo)} – ${fmt(maxTo)}</span>`;
  wrap.appendChild(range);
  return wrap;
}

function renderLogStrip(v) {
  const logs = (v.log || []).slice();
  const last = logs[logs.length - 1];
  $('log-strip').textContent = last ? logText(last) : '等待玩家…';
}

function logText(e) {
  switch (e.t) {
    case 'join': return `${e.name} 入座`;
    case 'leave': return `${e.name} 离开`;
    case 'hand': return `第 ${e.handNo} 手开始，庄家 ${e.dealer + 1} 号位`;
    case 'post': return `${e.name} 下${e.label} ${fmt(e.amount)}`;
    case 'street': return `${e.name}：${(e.board || []).map((c) => SUIT_SYMBOL[c[1]] + RANK_NAME[c[0]]).join(' ')}`;
    case 'action': return `${e.name} ${e.label}${e.amount ? ' ' + fmt(e.amount) : ''}`;
    case 'timeout': return `${e.name} 超时，自动${e.auto === 'check' ? '过牌' : '弃牌'}`;
    case 'autositout': return `${e.name} 连续超时，已自动旁观`;
    case 'win': return `${e.name} 赢下 ${fmt(e.amount)}${e.handName ? `（${e.handName}）` : ''}`;
    case 'busted': return `${e.name} 筹码输光`;
    case 'rebuy': return `${e.name} 补码 ${fmt(e.amount)}`;
    case 'pot': return `${(e.winners || []).map((w) => w.name).join('、')} 赢得 ${fmt(e.amount)}`;
    default: return '';
  }
}

/* ---------------- 结算弹层 ---------------- */

function renderResult(v) {
  const overlay = $('overlay-result');
  const results = v.results;
  if (!results || v.phase !== 'showdown') {
    overlay.classList.remove('is-open');
    return;
  }
  if (S.resultHand === v.handNo) return;
  S.resultHand = v.handNo;

  const board = results.board || v.board || [];
  const boardBox = $('result-board');
  boardBox.innerHTML = '';
  for (const c of board) boardBox.appendChild(cardEl(c));

  const list = $('result-list');
  list.innerHTML = '';
  const awards = results.awards || [];
  const myId = S.me ? S.me.id : null;
  const mySeat = v.you ? v.you.seat : -1;
  const iWon = awards.some((a) => a.seat === mySeat);
  if (mySeat >= 0) audio.play(iWon ? 'win' : 'lose');
  for (const a of awards) {
    const row = el('div', 'result-row' + (a.pid && a.pid === myId ? ' is-you' : ''));
    row.innerHTML = `<span><span class="win-name">${escapeHtml(a.name)}</span><span class="win-hand">${a.handName || ''}</span></span>
      <span class="win-amt">+${fmt(a.amount)}</span>`;
    list.appendChild(row);
  }
  if (!awards.length) list.appendChild(el('div', 'empty', '本手无人获胜'));

  $('result-title').textContent = results.showdown ? '摊牌结果' : '本手结束';
  $('result-foot').textContent = v.settings.autoStart
    ? '下一手即将自动开始…'
    : (v.you && v.you.isHost ? '点按关闭后手动开始下一手' : '等待房主开始下一手');

  overlay.classList.add('is-open');
}

/* ---------------- 计时条 ---------------- */

function updateTurnBar() {
  const fill = $('turn-fill');
  const v = S.view;
  if (!v || v.phase !== 'betting' || !v.deadline) {
    fill.style.transform = 'scaleX(0)';
    return;
  }
  const total = (v.settings.actionSeconds || 25) * 1000;
  const remain = Math.max(0, v.deadline - (Date.now() + S.skew));
  fill.style.transform = `scaleX(${Math.min(1, remain / total)})`;
}

/* ---------------- 菜单 ---------------- */

function openSheet(id) {
  $('mask').classList.add('is-open');
  $(id).classList.add('is-open');
  if (id === 'sheet-menu') renderMenu();
  if (id === 'sheet-log') renderLogSheet();
  if (id === 'sheet-history') {
    renderHistory();
    net.requestHistory();
  }
}

function closeSheets() {
  $('mask').classList.remove('is-open');
  for (const s of document.querySelectorAll('.sheet')) s.classList.remove('is-open');
}

function renderMenu() {
  const room = S.room;
  const v = S.view;
  if (!room || !v) return;
  $('sheet-room').innerHTML = `房间号 <b style="color:var(--gold)">#${room.code}</b>　（点按顶栏房号可复制）<br>
    盲注 ${room.settings.sb}/${room.settings.bb} · 起始 ${fmt(room.settings.startChips)} · ${room.settings.seats} 人桌`;

  const box = $('menu-players');
  box.innerHTML = '';
  const amHost = v.you && v.you.isHost;
  const myId = S.me ? S.me.id : null;
  for (const m of room.members) {
    const seat = m.seat !== null ? v.seats[m.seat] : null;
    const row = el('div', 'menu-player');
    row.innerHTML = `<span class="mp-name">${escapeHtml(m.name)}${m.id === myId ? '（我）' : ''}</span>
      <span class="mp-tag">${seat ? fmt(seat.chips) : '未入座'}${m.isHost ? ' · 房主' : ''}${m.online ? '' : ' · 离线'}</span>`;
    if (amHost && m.id !== myId) {
      const btn = el('button', 'kick-btn', '移出');
      btn.addEventListener('click', () => {
        net.kick(m.id);
        toast('已移出 ' + m.name);
      });
      row.appendChild(btn);
    }
    box.appendChild(row);
  }
}

function renderLogSheet() {
  const list = $('log-list');
  list.innerHTML = '';
  const logs = (S.view && S.view.log) || [];
  for (let i = logs.length - 1; i >= 0; i--) {
    const text = logText(logs[i]);
    if (!text) continue;
    list.appendChild(el('div', 'lg' + (logs[i].t === 'win' ? ' win' : ''), text));
  }
  if (!list.children.length) list.appendChild(el('div', 'empty', '还没有记录'));
}

/* ---------------- 对局记录（手牌流水 / 玩家账本） ---------------- */

function boardText(cards) {
  return (cards || []).map((c) => SUIT_SYMBOL[c[1]] + RANK_NAME[c[0]]).join(' ');
}

function clockOf(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function deltaClass(v) {
  return v > 0 ? 'win' : v < 0 ? 'lose' : 'flat';
}

function signed(v) {
  return v > 0 ? `+${fmt(v)}` : v < 0 ? `-${fmt(-v)}` : '0';
}

function renderHistory() {
  const body = $('hist-body');
  if (!body) return;
  body.innerHTML = '';
  const h = S.history;
  if (!h) {
    body.appendChild(el('div', 'empty', '加载中…'));
    return;
  }
  for (const tab of document.querySelectorAll('#hist-tabs .tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === S.histTab);
  }
  if (S.histTab === 'players') renderHistPlayers(body, h);
  else renderHistHands(body, h);
}

function renderHistHands(body, h) {
  const hands = (h.hands || []).slice().reverse();
  if (!hands.length) {
    body.appendChild(el('div', 'empty', '还没有打完的手牌，打一手就有了'));
    return;
  }
  body.appendChild(
    el('div', 'hist-summary', `已完成 ${h.totalHands || hands.length} 手 · 显示最近 ${hands.length} 手`),
  );

  for (const hand of hands) {
    const key = `hand-${hand.handNo}`;
    const row = el('div', 'hist-hand' + (S.histOpen.has(key) ? ' is-open' : ''));
    const awards = hand.awards || [];
    const winners =
      awards
        .map((a) => {
          const p = (hand.players || []).find((x) => x.seat === a.seat);
          const net = p ? p.delta : a.amount;
          return `${escapeHtml(a.name)} ${signed(net)}${a.handName ? `（${a.handName}）` : ''}`;
        })
        .join('、') || '—';

    row.appendChild(
      el(
        'div',
        'hh-top',
        `<span class="hh-no">#${hand.handNo}</span>
         <span class="hh-board">${boardText(hand.board) || '未发公共牌'}</span>
         <span class="hh-time">${clockOf(hand.at)}</span>`,
      ),
    );
    row.appendChild(
      el(
        'div',
        'hh-meta',
        `<span class="hh-winners">${winners}</span>
         <span class="hh-pot">底池 ${fmt(hand.pot)}</span>`,
      ),
    );

    const detail = el('div', 'hh-detail');
    const players = (hand.players || []).slice().sort((a, b) => b.delta - a.delta);
    for (const p of players) {
      const line = el('div', 'hh-line');
      line.innerHTML = `<span class="hp-name">${escapeHtml(p.name)}</span>
        <span class="hp-flow">${fmt(p.before)} → ${fmt(p.after)}</span>
        <span class="hp-delta ${deltaClass(p.delta)}">${signed(p.delta)}</span>`;
      detail.appendChild(line);
    }
    if (!players.length) detail.appendChild(el('div', 'empty', '本手无参与玩家'));
    row.appendChild(detail);

    row.addEventListener('click', () => {
      if (S.histOpen.has(key)) S.histOpen.delete(key);
      else S.histOpen.add(key);
      row.classList.toggle('is-open');
    });
    body.appendChild(row);
    if (!awards.length) row.classList.add('is-out');
  }
}

function renderHistPlayers(body, h) {
  const players = h.players || [];
  if (!players.length) {
    body.appendChild(el('div', 'empty', '还没有玩家'));
    return;
  }
  body.appendChild(el('div', 'hist-summary', '买入 = 起始筹码 + 补码；净输赢 = 当前筹码 − 买入'));
  if ((h.players || []).some((p) => p.inPlay > 0)) {
    body.appendChild(el('div', 'hist-note', '本手进行中：已投入底池但尚未结算的筹码已计入"当前"'));
  }

  const hands = h.hands || [];
  const sorted = players.slice().sort((a, b) => b.delta - a.delta);
  for (const p of sorted) {
    const key = `player-${p.seat}-${p.name}`;
    const row = el('div', 'hist-player' + (S.histOpen.has(key) ? ' is-open' : ''));
    row.appendChild(
      el(
        'div',
        'hp-top',
        `<span class="hp-name">${escapeHtml(p.name)}</span>
         <span class="hp-delta ${deltaClass(p.delta)}">${signed(p.delta)}</span>`,
      ),
    );
    row.appendChild(
      el(
        'div',
        'hp-sub',
        `买入 ${fmt(p.buyIn)}（起始 ${fmt((S.room && S.room.settings.startChips) || 0)}）· 当前 ${fmt(p.chips)}` +
          (p.inPlay > 0 ? `（含本手 ${fmt(p.inPlay)}）` : ''),
      ),
    );

    const detail = el('div', 'hp-detail');
    const own = hands
      .map((hand) => {
        const rec = (hand.players || []).find((x) => x.seat === p.seat && x.name === p.name);
        return rec ? { handNo: hand.handNo, delta: rec.delta, after: rec.after, at: hand.at } : null;
      })
      .filter(Boolean);
    if (!own.length) detail.appendChild(el('div', 'empty', '还没有参与记录'));
    for (const rec of own.slice().reverse()) {
      detail.appendChild(
        el(
          'div',
          'hh-line',
          `<span class="hh-no">#${rec.handNo}</span>
           <span class="hp-flow">${clockOf(rec.at)} · 余 ${fmt(rec.after)}</span>
           <span class="hp-delta ${deltaClass(rec.delta)}">${signed(rec.delta)}</span>`,
        ),
      );
    }
    row.appendChild(detail);

    row.addEventListener('click', () => {
      if (S.histOpen.has(key)) S.histOpen.delete(key);
      else S.histOpen.add(key);
      row.classList.toggle('is-open');
    });
    body.appendChild(row);
  }
}

/* ---------------- 声音 ---------------- */

const SOUND_BY_LABEL = {
  弃牌: 'fold',
  过牌: 'check',
  跟注: 'chip',
  加注: 'raise',
  全下: 'allin',
  小盲: 'chip',
  大盲: 'chip',
};

function soundForLog(e) {
  switch (e.t) {
    case 'hand':
    case 'street':
      return 'deal';
    case 'post':
      return 'chip';
    case 'action':
      return SOUND_BY_LABEL[e.label] || 'chip';
    case 'timeout':
    case 'autositout':
      return 'fold';
    case 'busted':
      return 'lose';
    case 'rebuy':
      return 'chip';
    case 'join':
      return 'join';
    case 'leave':
      return 'click';
    default:
      return null;
  }
}

/** 根据新出现的日志条目播放音效（第一次进入不补播历史） */
function playLogSounds(log) {
  if (!Array.isArray(log) || !log.length) return;
  const last = log[log.length - 1].i || 0;
  if (!S.logSeq) {
    S.logSeq = last;
    return;
  }
  const mySeat = S.view && S.view.you ? S.view.you.seat : -1;
  const fresh = log.filter((e) => (e.i || 0) > S.logSeq);
  S.logSeq = last;
  for (const e of fresh) {
    // 自己点按钮时已经即时发声了，避免重音
    if (e.t === 'action' && e.seat === mySeat) continue;
    const name = soundForLog(e);
    if (name) audio.play(name);
  }
}

function initAudio() {
  const musicBtn = $('btn-music');
  const sfxBtn = $('btn-sfx');
  const paint = () => {
    musicBtn.classList.toggle('is-off', !audio.musicOn);
    sfxBtn.classList.toggle('is-off', !audio.sfxOn);
  };
  paint();

  musicBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    audio.unlock();
    audio.setMusic(!audio.musicOn);
    paint();
    audio.play('click');
    toast(audio.musicOn ? '背景音乐：开' : '背景音乐：关', 900);
  });

  sfxBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    audio.unlock();
    audio.setSfx(!audio.sfxOn);
    paint();
    if (audio.sfxOn) audio.play('chip');
    toast(audio.sfxOn ? '音效：开' : '音效：关', 900);
  });

  // 浏览器要求用户手势后才能出声
  const unlock = () => audio.unlock();
  document.addEventListener('pointerdown', unlock, { once: true, passive: true });
  document.addEventListener('keydown', unlock, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && audio.musicOn) audio.ensure();
  });
}

/* ---------------- 网络事件 ---------------- */

function initNet() {
  net.on('open', () => {
    if (S.screen === 'home') net.listRooms();
  });

  net.on('reconnecting', () => {
    if (S.screen === 'table') toast('连接断开，正在重连…', 1200);
  });

  net.on('close', () => {
    if (S.screen === 'table') toast('网络中断，正在重连…', 1500);
  });

  net.on('rooms', (rooms) => {
    renderRooms(rooms);
  });

  net.on('history', (msg) => {
    S.history = msg;
    if ($('sheet-history').classList.contains('is-open')) renderHistory();
  });

  net.on('room', (msg) => {
    localStorage.setItem(LS_SESS, JSON.stringify({ code: msg.code, token: msg.token }));
  });

  net.on('state', (payload) => {
    S.room = payload.room;
    S.view = payload.table;
    S.me = payload.you;
    S.chat = payload.chat || [];
    S.skew = (payload.serverTime || Date.now()) - Date.now();
    if (payload.you && payload.room) {
      localStorage.setItem(LS_SESS, JSON.stringify({ code: payload.room.code, token: payload.you.token }));
    }
    // 声音：新日志条目 + "轮到你了"
    const myTurn = !!(S.view.you && S.view.you.isTurn);
    playLogSounds(S.view.log);
    if (myTurn && !S.wasMyTurn) audio.play('turn');
    S.wasMyTurn = myTurn;

    if (S.screen !== 'table') {
      showScreen('table');
      closeSheets();
    }
    renderTable();
    // 对局记录面板开着时，每手结束后自动刷新
    if ($('sheet-history').classList.contains('is-open')) net.requestHistory();
  });

  net.on('error', (msg) => {
    toast(msg.message || '操作失败', 2000);
    if (msg.message && msg.message.includes('房间不存在')) {
      localStorage.removeItem(LS_SESS);
      net.sess = null;
      showScreen('home');
    }
  });

  net.on('left', () => {
    localStorage.removeItem(LS_SESS);
    S.room = null;
    S.view = null;
    closeSheets();
    showScreen('home');
    toast('已离开房间');
  });

  net.on('closed', (msg) => {
    localStorage.removeItem(LS_SESS);
    S.room = null;
    S.view = null;
    closeSheets();
    showScreen('home');
    toast(msg.reason || '房间已关闭');
  });
}

/* ---------------- 牌桌交互 ---------------- */

function initTable() {
  $('btn-leave').addEventListener('click', () => {
    net.leaveRoom();
  });

  $('btn-menu').addEventListener('click', () => openSheet('sheet-menu'));
  $('mask').addEventListener('click', closeSheets);
  $('log-strip').addEventListener('click', () => openSheet('sheet-log'));
  $('overlay-result').addEventListener('click', () => $('overlay-result').classList.remove('is-open'));

  $('btn-history').addEventListener('click', () => {
    closeSheets();
    openSheet('sheet-history');
  });

  $('hist-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    S.histTab = tab.dataset.tab;
    renderHistory();
  });

  $('btn-rebuy').addEventListener('click', () => {
    net.rebuy();
    closeSheets();
  });

  $('btn-sitout').addEventListener('click', () => {
    const sitOut = !(S.view && S.view.you && S.view.you.sitOut);
    net.sitOut(sitOut);
    closeSheets();
  });

  $('btn-quit').addEventListener('click', () => {
    closeSheets();
    net.leaveRoom();
  });

  $('room-code').addEventListener('click', async () => {
    const code = S.room ? S.room.code : '';
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast('房号已复制：' + code);
    } catch {
      toast('房号：' + code);
    }
  });
}

/* ---------------- 启动 ---------------- */

function boot() {
  initLobby();
  initCreate();
  initTable();
  initAudio();
  initNet();

  const savedNick = localStorage.getItem(LS_NICK);
  if (savedNick) $('nickname').value = savedNick;

  // 刷新页面后自动回到原房间
  try {
    const sess = JSON.parse(localStorage.getItem(LS_SESS) || 'null');
    if (sess && sess.code && sess.token) {
      net.sess = { code: sess.code, token: sess.token, nickname: savedNick || '玩家' };
    }
  } catch {
    localStorage.removeItem(LS_SESS);
  }

  // 分享链接 / 刷新回房：?room=123456&nick=名字
  const params = new URLSearchParams(location.search);
  const nickParam = (params.get('nick') || '').trim().slice(0, 12);
  if (nickParam) {
    localStorage.setItem(LS_NICK, nickParam);
    $('nickname').value = nickParam;
  }
  const finalNick = localStorage.getItem(LS_NICK) || '';
  const roomParam = (params.get('room') || '').replace(/\D/g, '').slice(0, 6);
  if (roomParam) {
    $('code-input').value = roomParam;
    if (finalNick) {
      setTimeout(() => doJoin(roomParam), 350);
    } else {
      toast('请输入昵称后点「加入」进入房间 ' + roomParam, 2600);
    }
  }
  if (location.hash === '#create') showScreen('create');

  net.connect();
  // 调试用：控制台里可以 __dezhou.audio.setMusic(false) 之类
  window.__dezhou = { audio, state: S, net };
  setInterval(updateTurnBar, 200);
  setInterval(() => {
    if (S.screen === 'table' && S.view && S.view.you && S.view.you.isTurn) {
      renderMe(S.view);
    }
  }, 500);
  // 大厅里自动刷新房间列表
  setInterval(() => {
    if (S.screen === 'home' && net.connected) net.listRooms();
  }, 5000);
}

boot();
