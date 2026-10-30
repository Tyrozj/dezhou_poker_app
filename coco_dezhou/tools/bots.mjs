/**
 * 陪练机器人：给自己开一桌补人头，方便一个人在手机上测试/演示。
 *
 *   node tools/bots.mjs --create --seats 4 --count 3
 *   node tools/bots.mjs --room 123456 --count 3
 *
 * 参数：
 *   --create        由第一个机器人创建房间并打印房号
 *   --room CODE     加入已有房间
 *   --count N       机器人数量（默认 3）
 *   --seats N       创建房间时的座位数（默认 4）
 *   --chips N       起始筹码（默认 1000）
 *   --sb N / --bb N 盲注（默认 10/20）
 *   --url URL       服务地址（默认 http://127.0.0.1:18080）
 *   --delay MS      每个动作的思考延迟（默认 900ms）
 */

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const next = args[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
};

const BASE = String(arg('url', 'http://127.0.0.1:18080')).replace(/\/$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const COUNT = Number(arg('count', 3));
const SEATS = Number(arg('seats', 4));
const CHIPS = Number(arg('chips', 1000));
const SB = Number(arg('sb', 10));
const BB = Number(arg('bb', 20));
const DELAY = Number(arg('delay', 900));
const SHOULD_CREATE = args.includes('--create');
const ROOM = arg('room', null);
const MIN_START = Number(arg('min-start', SEATS));

const NAMES = ['阿宝', '阿呆', '老王', '小敏', '大伟', '阿强', '琪琪', '老李'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
  constructor(name, index) {
    this.name = name;
    this.index = index;
    this.state = null;
    this.code = null;
    this.busy = false;
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('连接失败')));
      ws.addEventListener('message', (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.t === 'state') {
          this.state = m;
          this.think();
        } else if (m.t === 'room') {
          this.code = m.code;
          if (!process.__code) {
            process.__code = m.code;
            console.log('');
            console.log(`  房号：${m.code}`);
            console.log(`  在手机上打开：${BASE}/?room=${m.code}`);
            console.log('');
          }
        } else if (m.t === 'error') {
          console.log(`[${this.name}] 收到错误：${m.message}`);
        }
      });
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  async think() {
    if (this.busy) {
      this.pending = true;
      return;
    }
    if (!this.state) return;
    const v = this.state.table;
    const you = v.you;
    if (!you) return;
    // 房主机器人：人数够了就自动开局；一手结束后稍等再开下一手
    if ((v.phase === 'waiting' || v.phase === 'showdown') && you.isHost) {
      const seated = v.seats.filter(Boolean).length;
      if (seated >= Math.max(2, MIN_START)) {
        this.busy = true;
        await sleep(v.phase === 'showdown' ? 4000 : 1500);
        this.send({ t: 'start' });
        await sleep(600);
        this.busy = false;
        if (this.pending) {
          this.pending = false;
          this.think();
        }
      }
      return;
    }

    if (!you.isTurn) return;
    this.busy = true;
    await sleep(DELAY * (0.6 + Math.random() * 0.8));

    const legal = you.legal;
    if (!legal) {
      this.busy = false;
      return;
    }
    let action;
    const roll = Math.random();
    if (legal.raise && roll > 0.86) {
      action = { type: 'raise', to: legal.minTo };
    } else if (legal.call > 0) {
      action = legal.call >= you.chips * 0.7 && roll > 0.85 ? { type: 'fold' } : { type: 'call' };
    } else {
      action = { type: 'check' };
    }
    this.send({ t: 'action', action });
    console.log(`[${this.name}] ${action.type}${action.to ? ' -> ' + action.to : ''}`);
    await sleep(250);
    this.busy = false;
    // 睡醒后可能已经有新状态被丢掉了，主动再跑一次
    if (this.pending) {
      this.pending = false;
      this.think();
    }
  }
}

async function main() {
  const bots = [];
  for (let i = 0; i < COUNT; i++) {
    const bot = new Bot(NAMES[i % NAMES.length] + (i >= NAMES.length ? i : ''), i);
    await bot.connect();
    bots.push(bot);
    await sleep(120);
  }

  let roomCode = ROOM;
  if (SHOULD_CREATE) {
    const host = bots[0];
    host.send({
      t: 'create',
      nickname: host.name,
      name: '机器人陪练局',
      settings: { seats: SEATS, startChips: CHIPS, sb: SB, bb: BB, actionSeconds: 15, autoStart: false, autoRebuy: false },
    });
    for (let i = 0; i < 100 && !host.code; i++) await sleep(50);
    roomCode = host.code;
  }

  if (!roomCode) {
    console.log('用法：node tools/bots.mjs --create --seats 4 --count 3');
    console.log('      node tools/bots.mjs --room 123456 --count 3');
    process.exit(0);
  }

  // 其余机器人加入同一房间
  for (let i = 1; i < bots.length; i++) {
    bots[i].send({ t: 'join', code: roomCode, nickname: bots[i].name });
    await sleep(250);
  }

  console.log(`已启动 ${COUNT} 个机器人，Ctrl+C 退出。`);

  // 心跳：避免长时间不操作被判为掉线
  setInterval(() => {
    for (const bot of bots) bot.send({ t: 'ping' });
  }, 20000);
}

process.on('SIGINT', () => {
  console.log('\n机器人下线');
  process.exit(0);
});

main().catch((err) => {
  console.error('机器人启动失败：', err.message);
  process.exit(1);
});
