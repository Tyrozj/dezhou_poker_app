/**
 * 房间层：成员管理 + 对局广播 + 行动计时 + 下一手自动开始。
 * 语义与 CoCo「云房间」一一对应：
 *   创建房间(房号, 人数)  -> RoomManager.create
 *   设置我在房间的昵称     -> addMember
 *   进入房间(房号)        -> join
 *   当前进入的房间人员列表  -> members
 *   发送房间消息          -> broadcast / state payload
 *   当收到房间通知         -> member join/leave 事件
 */

import { EventEmitter } from 'node:events';
import { GameTable, normalizeSettings } from './table.mjs';
import { randomInt } from '../shared/cards.mjs';

const OFFLINE_REMOVE_MS = 120000; // 掉线多久后释放座位
const NEXT_HAND_DELAY_MS = 7000;  // 摊牌结果展示时长，之后自动开下一手
const FIRST_HAND_DELAY_MS = 4000; // 人齐后自动开局等待

let idSeq = 0;

export class Room extends EventEmitter {
  constructor({ code, name, settings, hostId, store, manager }) {
    super();
    this.code = code;
    this.name = name || '德州牌局';
    this.settings = normalizeSettings(settings);
    this.hostId = hostId;
    this.store = store;
    this.manager = manager;
    this.members = new Map();
    this.chat = [];
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();
    this.timers = new Set();
    this.recordedHandNo = 0;
    this.stateSeq = 0;
    this.destroyed = false;

    this.table = new GameTable(this.settings, {
      onChange: (reason) => this.onTableChange(reason),
    });
    this.persist();
  }

  /* ------------- 广播与持久化 ------------- */

  onTableChange() {
    if (this.destroyed) return;
    this.lastActiveAt = Date.now();
    if (this.table.phase === 'showdown' && this.table.handNo > this.recordedHandNo) {
      this.recordedHandNo = this.table.handNo;
      this.store.insertHand({
        room: this.code,
        handNo: this.table.handNo,
        at: this.table.handStartedAt,
        board: this.table.board.join(' '),
        pot: this.table.lastPot,
        results: (this.table.results && this.table.results.awards) || [],
      });
    }
    this.persist();
    this.broadcast();
    this.schedule();
  }

  persist() {
    const rows = [...this.members.values()].filter((m) => m.seat !== null);
    this.store.upsertRoom({
      code: this.code,
      name: this.name,
      seats: this.settings.seats,
      startChips: this.settings.startChips,
      sb: this.settings.sb,
      bb: this.settings.bb,
      phase: this.table.phase,
      handNo: this.table.handNo,
      players: rows.length,
      host: this.hostName(),
      updatedAt: Date.now(),
    });
  }

  hostName() {
    const m = this.members.get(this.hostId);
    return m ? m.name : '';
  }

  summary() {
    const seated = [...this.members.values()].filter((m) => m.seat !== null);
    return {
      code: this.code,
      name: this.name,
      seats: this.settings.seats,
      players: seated.length,
      online: [...this.members.values()].filter((m) => m.online).length,
      sb: this.settings.sb,
      bb: this.settings.bb,
      startChips: this.settings.startChips,
      phase: this.table.phase,
      handNo: this.table.handNo,
      host: this.hostName(),
      createdAt: this.createdAt,
    };
  }

  statePayload(member) {
    const table = this.table.view(member ? member.id : null);
    if (table.you) table.you.isHost = member.id === this.hostId;
    return {
      t: 'state',
      room: {        code: this.code,
        name: this.name,
        settings: this.settings,
        hostId: this.hostId,
        hostName: this.hostName(),
        createdAt: this.createdAt,
        members: [...this.members.values()].map((m) => ({
          id: m.id,
          name: m.name,
          seat: m.seat,
          online: m.online,
          isHost: m.id === this.hostId,
        })),
      },
      you: member
        ? { id: member.id, name: member.name, token: member.token, seat: member.seat, isHost: member.id === this.hostId }
        : null,
      table,
      chat: this.chat.slice(-30),
      seq: this.stateSeq || 0,
      serverTime: Date.now(),
    };
  }

  broadcast() {
    this.stateSeq = (this.stateSeq || 0) + 1;
    for (const m of this.members.values()) {
      this.send(m, this.statePayload(m));
    }
  }

  send(member, msg) {
    if (!member || !member.sink) return;
    try {
      member.sink.send(msg);
    } catch {
      /* 忽略单端发送失败 */
    }
  }

  error(member, message, requestId) {
    this.send(member, { t: 'error', message, requestId });
  }

  /* ------------- 成员 ------------- */

  addMember({ name, token }) {
    const nick = sanitizeName(name);
    // 断线重连：token 命中则复用原成员
    if (token) {
      for (const m of this.members.values()) {
        if (m.token === token) {
          m.name = nick || m.name;
          if (m.seat !== null) {
            const seat = this.table.seatInfo(m.seat);
            if (seat) seat.name = m.name;
          }
          return { member: m, reconnected: true };
        }
      }
    }
    const id = `p${++idSeq}_${randomInt(1e6).toString(36)}`;
    const member = {
      id,
      name: nick,
      token: token && token.length >= 16 ? token : randomToken(),
      seat: null,
      sink: null,
      online: false,
      joinedAt: Date.now(),
      removeTimer: null,
    };
    this.members.set(member.id, member);
    const r = this.table.addPlayer(member.id, member.name);
    if (!r.ok) {
      // 座位已满：不保留成员
      this.members.delete(member.id);
      return { member: null, full: true, error: r.error || '房间已满' };
    }
    member.seat = r.seat;
    this.chat.push({ t: 'sys', text: `${member.name} 进入了房间`, at: Date.now() });
    this.lastActiveAt = Date.now();
    this.onTableChange();
    return { member, reconnected: false, full: false };
  }

  removeMember(member, { notify = true, reason = '' } = {}) {
    if (!this.members.has(member.id)) return;
    clearTimeout(member.removeTimer);
    if (notify) {
      this.send(member, { t: 'left', reason });
      if (member.sink) member.sink.close && member.sink.close();
    }
    this.members.delete(member.id);
    this.table.removePlayer(member.id);
    this.chat.push({ t: 'sys', text: `${member.name} 离开了房间`, at: Date.now() });
    if (this.hostId === member.id) {
      const next = [...this.members.values()].find((m) => m.online) || [...this.members.values()][0];
      this.hostId = next ? next.id : null;
      if (next) this.chat.push({ t: 'sys', text: `${next.name} 成为新房主`, at: Date.now() });
    }
    this.onTableChange();
    if (this.members.size === 0) this.manager.destroy(this.code);
  }

  attach(member, sink) {
    member.sink = sink;
    member.online = true;
    clearTimeout(member.removeTimer);
    member.removeTimer = null;
    if (member.seat !== null) this.table.setConnected(member.id, true);
    this.send(member, this.statePayload(member));
    this.broadcast();
    this.schedule();
  }

  detach(member) {
    member.sink = null;
    member.online = false;
    if (member.seat !== null) this.table.setConnected(member.id, false);
    clearTimeout(member.removeTimer);
    member.removeTimer = setTimeout(() => {
      if (member.online || !this.members.has(member.id)) return;
      // 长时间掉线：释放座位，让其他人能坐下
      const seat = member.seat;
      if (seat !== null) {
        this.table.removePlayer(member.id);
        member.seat = null;
      }
      this.members.delete(member.id);
      if (this.hostId === member.id) {
        const next = [...this.members.values()][0];
        this.hostId = next ? next.id : null;
      }
      this.onTableChange();
      if (this.members.size === 0) this.manager.destroy(this.code);
    }, OFFLINE_REMOVE_MS);
    if (member.removeTimer.unref) member.removeTimer.unref();
    this.onTableChange();
  }

  /* ------------- 行动 ------------- */

  handle(member, msg) {
    const t = msg && msg.t;
    const requestId = msg && msg.requestId;
    switch (t) {
      case 'action': {
        const r = this.table.act(member.id, msg.action || {});
        if (!r.ok) this.error(member, r.error, requestId);
        return r;
      }
      case 'start': {
        if (member.id !== this.hostId) return this.error(member, '只有房主可以开始牌局', requestId);
        const r = this.table.startHand();
        if (!r.ok) this.error(member, r.error, requestId);
        return r;
      }
      case 'rebuy': {
        const r = this.table.rebuy(member.id);
        if (!r.ok) this.error(member, r.error, requestId);
        else this.chat.push({ t: 'sys', text: `${member.name} 补码 ${r.amount}`, at: Date.now() });
        return r;
      }
      case 'sitout': {
        const r = this.table.setSitOut(member.id, !!msg.value);
        if (!r.ok) this.error(member, r.error, requestId);
        this.onTableChange();
        return r;
      }
      case 'chat': {
        const text = String(msg.text || '').slice(0, 60).trim();
        if (text) {
          this.chat.push({ t: 'chat', name: member.name, text, at: Date.now() });
          if (this.chat.length > 50) this.chat.splice(0, this.chat.length - 50);
          this.broadcast();
        }
        return { ok: true };
      }
      case 'history': {
        // 对局记录：手牌流水 + 玩家买入/净输赢（都是牌桌上公开的信息）
        this.send(member, { t: 'history', code: this.code, ...this.table.handHistory() });
        return { ok: true };
      }
      case 'kick': {
        if (member.id !== this.hostId) return this.error(member, '只有房主可以移出玩家', requestId);
        const target = this.members.get(msg.playerId);
        if (!target) return this.error(member, '该玩家已离开', requestId);
        if (target.id === member.id) return this.error(member, '不能移出自己', requestId);
        this.removeMember(target, { notify: true, reason: '你已被房主移出房间' });
        return { ok: true };
      }
      case 'ping':
        return this.send(member, { t: 'pong', at: Date.now() });
      default:
        return this.error(member, '未知消息类型', requestId);
    }
  }

  /* ------------- 计时器 ------------- */

  schedule() {
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
    if (this.destroyed) return;

    const now = Date.now();
    const tbl = this.table;
    if (tbl.phase === 'betting' && tbl.deadline > 0) {
      const delay = Math.max(0, tbl.deadline - now) + 60;
      this._later(() => {
        tbl.timeout();
      }, delay);
      return;
    }
    if (!this.settings.autoStart) return;
    if (tbl.phase === 'showdown' || tbl.phase === 'waiting') {
      const can = tbl.canStart();
      if (!can.ok) return;
      const delay = tbl.phase === 'showdown' ? NEXT_HAND_DELAY_MS : FIRST_HAND_DELAY_MS;
      this._later(() => {
        if (this.table.canStart().ok) this.table.startHand();
      }, delay);
    }
  }

  _later(fn, delay) {
    const h = setTimeout(() => {
      this.timers.delete(h);
      if (!this.destroyed) fn();
    }, delay);
    this.timers.add(h);
  }

  destroy() {
    this.destroyed = true;
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
    for (const m of this.members.values()) {
      clearTimeout(m.removeTimer);
      if (m.sink) {
        try {
          m.sink.send({ t: 'closed', reason: '房间已关闭' });
          m.sink.close && m.sink.close();
        } catch {
          /* ignore */
        }
      }
    }
    this.members.clear();
    this.store.removeRoom(this.code);
  }
}

export class RoomManager {
  constructor({ store }) {
    this.store = store;
    this.rooms = new Map();
    // 房间是内存态：启动时清掉上一次进程遗留的“房间表”行
    for (const row of store.roomRows()) store.removeRoom(row.code);
    this.gcTimer = setInterval(() => this.gc(), 60000);
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  newCode() {
    for (let i = 0; i < 500; i++) {
      const code = String(100000 + randomInt(900000));
      if (!this.rooms.has(code)) return code;
    }
    return String(Date.now()).slice(-6);
  }

  create({ name, settings, hostName }) {
    const code = this.newCode();
    const hostId = null; // 由第一个加入的成员成为房主
    const room = new Room({ code, name, settings, hostId, store: this.store, manager: this });
    this.rooms.set(code, room);
    const { member } = room.addMember({ name: hostName });
    room.hostId = member.id;
    room.persist();
    return { room, member, code };
  }

  get(code) {
    return this.rooms.get(String(code || '')) || null;
  }

  join(code, { name, token }) {
    const room = this.get(code);
    if (!room) return { error: '房间不存在，请检查房间号' };
    const res = room.addMember({ name, token });
    if (res.full) return { error: res.error || '房间已满' };
    return { room, member: res.member };
  }

  destroy(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.destroy();
    this.rooms.delete(code);
  }

  list() {
    return [...this.rooms.values()]
      .map((r) => r.summary())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  gc() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const anyOnline = [...room.members.values()].some((m) => m.online);
      if (!anyOnline && now - room.lastActiveAt > 30 * 60 * 1000) {
        this.destroy(code);
      }
    }
  }
}

function randomToken() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = randomInt(256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sanitizeName(name) {
  const s = String(name || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 12);
  return s || `玩家${1000 + randomInt(9000)}`;
}
