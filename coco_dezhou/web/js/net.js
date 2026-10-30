/**
 * 传输层：WebSocket 长连接 + 自动重连 + 断线续局。
 * 服务端推送的每条 state 都包含完整的桌面视图，前端直接整屏重绘。
 */

const WS_PATH = '/ws';

export class Net {
  constructor() {
    this.url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;
    this.ws = null;
    this.handlers = new Map();
    this.sess = null;         // { code, token, nickname }
    this.connected = false;
    this.retry = 0;
    this.retryTimer = null;
    this.manualClose = false;
    this.heartbeat = null;
    this.pending = null;     // 连接建立后要补发的创建请求
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  emit(type, payload) {
    for (const fn of this.handlers.get(type) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[net] handler error', err);
      }
    }
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.manualClose = false;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.emit('open');
      this.startHeartbeat();
      if (this.pending) {
        const msg = this.pending;
        this.pending = null;
        this.send(msg);
      } else if (this.sess && this.sess.code) {
        this.send({ t: 'join', code: this.sess.code, nickname: this.sess.nickname, token: this.sess.token });
      } else {
        this.listRooms();
      }
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(msg);
    };

    ws.onclose = () => {
      this.connected = false;
      this.stopHeartbeat();
      this.emit('close');
      if (!this.manualClose) this.scheduleRetry();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.send({ t: 'ping' }), 20000);
  }

  stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  scheduleRetry() {
    if (this.retryTimer) return;
    this.retry = Math.min(this.retry + 1, 6);
    const delay = 600 * this.retry;
    this.emit('reconnecting', delay);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.manualClose = true;
    if (this.ws) this.ws.close();
    this.ws = null;
    this.stopHeartbeat();
    this.sess = null;
  }

  handle(msg) {
    switch (msg.t) {
      case 'hello':
        this.emit('hello', msg);
        break;
      case 'room':
        this.sess = { ...(this.sess || {}), code: msg.code, token: msg.token };
        this.emit('room', msg);
        break;
      case 'state':
        this.emit('state', msg);
        break;
      case 'rooms':
        this.emit('rooms', msg.rooms || []);
        break;
      case 'history':
        this.emit('history', msg);
        break;
      case 'error':
        this.emit('error', msg);
        break;
      case 'left':
        this.sess = null;
        this.emit('left', msg);
        break;
      case 'closed':
        this.sess = null;
        this.emit('closed', msg);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  /* ---------- 业务动作 ---------- */

  listRooms() {
    this.send({ t: 'list' });
  }

  createRoom({ nickname, name, settings }) {
    this.sess = { code: null, token: null, nickname };
    const msg = { t: 'create', nickname, name, settings };
    this.pending = msg;
    if (this.connected) {
      this.pending = null;
      this.send(msg);
    } else {
      this.connect();
    }
  }

  joinRoom({ code, nickname, token }) {
    this.sess = { code: String(code), token: token || null, nickname };
    this.send({ t: 'join', code: String(code), nickname, token });
  }

  leaveRoom() {
    this.send({ t: 'leave' });
    this.sess = null;
  }

  action(action) {
    this.send({ t: 'action', action });
  }
  startGame() { this.send({ t: 'start' }); }
  rebuy() { this.send({ t: 'rebuy' }); }
  sitOut(value) { this.send({ t: 'sitout', value }); }
  kick(playerId) { this.send({ t: 'kick', playerId }); }
  chat(text) { this.send({ t: 'chat', text }); }
  requestHistory() { this.send({ t: 'history' }); }
}
