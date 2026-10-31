/**
 * 声音引擎：不依赖任何音频文件，全部用 WebAudio 现场合成。
 * - 背景音乐：3 段可切换的爵士循环（行走贝斯 + 鼓刷/沙锤 + 和弦切分 + 零星旋律）
 * - 音效：发牌、筹码、过牌、弃牌、加注、全下、赢/输、轮到你
 *
 * 浏览器要求"用户手势后才能出声"，所以第一次点击时调用 unlock()。
 */

const STORE_MUSIC = 'dz.music';
const STORE_TRACK = 'dz.musicTrack';
const STORE_SFX = 'dz.sfx';

function readPref(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式/禁用存储时忽略 */
  }
}

const midiToFreq = (n) => 440 * Math.pow(2, (n - 69) / 12);

/**
 * 三段牌桌爵士。prog 的每个和弦是 4 个 MIDI 音（从低到高），
 * 行走贝斯与切分和弦都从这里派生。
 */
export const TRACKS = [
  {
    id: 'lounge',
    name: '爵士酒廊',
    desc: 'ii–V–I 慢四，行走贝斯 + 鼓刷',
    bpm: 92,
    swing: 0.17,
    prog: [
      [50, 57, 60, 65], // Dm7
      [43, 53, 59, 62], // G7
      [48, 55, 59, 64], // Cmaj7
      [45, 52, 55, 60], // Am7
    ],
  },
  {
    id: 'blues',
    name: '蓝调酒吧',
    desc: 'F 调摇摆蓝调，节奏更活',
    bpm: 108,
    swing: 0.2,
    prog: [
      [41, 48, 51, 56], // F7
      [46, 53, 57, 62], // Bb7
      [41, 48, 51, 56], // F7
      [48, 55, 60, 64], // C7
    ],
  },
  {
    id: 'bossa',
    name: '巴萨诺瓦',
    desc: '拉丁轻节奏，安静不吵',
    bpm: 116,
    swing: 0,
    prog: [
      [45, 52, 57, 60], // Am7
      [50, 57, 60, 65], // Dm7
      [40, 52, 56, 59], // E7
      [45, 52, 57, 60], // Am7
    ],
  },
];

export class AudioKit {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicBus = null;
    this.sfxBus = null;
    this.noiseBuf = null;
    this.bgmTimer = null;
    this.step = 0;
    this.nextTime = 0;
    this.musicOn = readPref(STORE_MUSIC) !== '0';
    this.trackId = TRACKS.some((t) => t.id === readPref(STORE_TRACK)) ? readPref(STORE_TRACK) : 'lounge';
    this.sfxOn = readPref(STORE_SFX) !== '0';
    this.unlocked = false;
  }

  get track() {
    return TRACKS.find((t) => t.id === this.trackId) || TRACKS[0];
  }

  /* ---------------- 基础设施 ---------------- */

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);

      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.musicOn ? 0.5 : 0;
      this.musicBus.connect(this.master);

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.sfxOn ? 0.85 : 0;
      this.sfxBus.connect(this.master);

      const len = Math.floor(this.ctx.sampleRate * 0.6);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** 必须在用户手势里调用一次 */
  unlock() {
    const ctx = this.ensure();
    if (!ctx) return;
    this.unlocked = true;
    if (this.musicOn) this.startMusic();
  }

  /* ---------------- 背景音乐（爵士循环） ---------------- */

  startMusic() {
    const ctx = this.ensure();
    if (!ctx || !this.musicOn || this.bgmTimer) return;
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.12;
    this._pump();
    this.bgmTimer = setInterval(() => this._pump(), 90);
  }

  stopMusic() {
    if (this.bgmTimer) clearInterval(this.bgmTimer);
    this.bgmTimer = null;
  }

  setMusic(on) {
    this.musicOn = !!on;
    writePref(STORE_MUSIC, on ? '1' : '0');
    if (!this.ctx) {
      if (on && this.unlocked) this.startMusic();
      return;
    }
    this.musicBus.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.12);
    if (on) {
      if (this.unlocked) this.startMusic();
    } else {
      this.stopMusic();
    }
  }

  setTrack(id) {
    if (!TRACKS.some((t) => t.id === id)) return;
    this.trackId = id;
    writePref(STORE_TRACK, id);
    if (this.bgmTimer) {
      this.stopMusic();
      this.step = 0;
      this.startMusic();
    }
  }

  /** 提前 0.5s 把接下来的八分音符排进时间轴 */
  _pump() {
    const ctx = this.ctx;
    if (!ctx || !this.musicOn) return;
    const track = this.track;
    const stepDur = 60 / track.bpm / 2; // 八分音符
    while (this.nextTime < ctx.currentTime + 0.5) {
      const when = this.nextTime + (this.step % 2 ? stepDur * track.swing : 0);
      this._scheduleStep(this.step, Math.max(when, ctx.currentTime + 0.02));
      this.nextTime += stepDur;
      this.step++;
    }
  }

  _scheduleStep(step, when) {
    const track = this.track;
    const bar = Math.floor(step / 8) % track.prog.length;
    const chord = track.prog[bar];
    const nextChord = track.prog[(bar + 1) % track.prog.length];
    const eighth = step % 8;
    const beat = Math.floor(eighth / 2); // 0..3
    const isOnBeat = eighth % 2 === 0;

    // 行走贝斯：每拍一个音（根音 → 五度 → 经过音 → 接近下一小节根音）
    if (isOnBeat) {
      const root = chord[0];
      const line = [root, root + 7, nextChord[0] - 2, nextChord[0] - 1];
      const note = line[beat] || root;
      this._musicTone(midiToFreq(note), when, 0.42, 'triangle', 0.16, this.musicBus);
      this._musicTone(midiToFreq(note - 12), when, 0.4, 'sine', 0.1, this.musicBus);
    }

    // 鼓：踩镲/鼓刷（on-beat 重一点）
    const brushGain = track.id === 'bossa' ? 0.05 : 0.045;
    this._musicNoise(when, 0.05, isOnBeat ? 8200 : 6800, isOnBeat ? 0.9 : 0.55, brushGain);
    if (track.id === 'bossa' && (eighth === 3 || eighth === 6)) {
      this._musicNoise(when + 0.02, 0.09, 2400, 0.7, 0.06); // 沙锤
    }

    // 和弦切分：反拍为主，偶尔正拍
    if (eighth === 3 || eighth === 5 || eighth === 7 || (eighth === 0 && Math.random() < 0.4)) {
      const voicing = chord.slice(1);
      for (const n of voicing) {
        this._musicTone(midiToFreq(n), when, 0.26, 'triangle', 0.045, this.musicBus);
      }
    }

    // 零星旋律（每两小节一小句），只在前两首里出现
    if (track.id !== 'bossa' && eighth === 4 && Math.random() < 0.45) {
      const pick = chord[1 + Math.floor(Math.random() * 3)] + 12;
      this._musicTone(midiToFreq(pick), when, 0.7, 'sine', 0.05, this.musicBus);
    }
  }

  _musicTone(freq, when, dur, type, gain, bus) {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g).connect(bus);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  _musicNoise(when, dur, freq, q, gain) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = freq;
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(filt).connect(g).connect(this.musicBus);
    src.start(when);
    src.stop(when + dur + 0.02);
  }

  /* ---------------- 音效 ---------------- */

  setSfx(on) {
    this.sfxOn = !!on;
    writePref(STORE_SFX, on ? '1' : '0');
    if (this.ctx) this.sfxBus.gain.setTargetAtTime(on ? 0.85 : 0, this.ctx.currentTime, 0.1);
  }

  _noise({ at = 0, dur = 0.09, freq = 2200, q = 1.2, gain = 0.25, type = 'bandpass' }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime + at;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  _tone({ at = 0, freq = 440, to = null, dur = 0.12, type = 'sine', gain = 0.2 }) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    const t = ctx.currentTime + at;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  play(name) {
    if (!this.sfxOn || !this.unlocked) return;
    const ctx = this.ensure();
    if (!ctx) return;
    if (document.hidden) return;

    switch (name) {
      case 'deal':
        this._noise({ dur: 0.06, freq: 3200, q: 0.8, gain: 0.16 });
        this._noise({ at: 0.05, dur: 0.05, freq: 2600, q: 0.8, gain: 0.12 });
        break;
      case 'chip':
        this._noise({ dur: 0.035, freq: 2600, q: 2, gain: 0.22 });
        this._tone({ freq: 1180, dur: 0.05, type: 'triangle', gain: 0.1 });
        break;
      case 'check':
        this._tone({ freq: 640, to: 560, dur: 0.09, type: 'sine', gain: 0.2 });
        this._noise({ dur: 0.03, freq: 900, q: 1, gain: 0.08 });
        break;
      case 'fold':
        this._tone({ freq: 190, to: 110, dur: 0.16, type: 'sine', gain: 0.22 });
        this._noise({ dur: 0.05, freq: 600, q: 0.7, gain: 0.08 });
        break;
      case 'raise':
        this._noise({ dur: 0.035, freq: 2800, q: 2, gain: 0.2 });
        this._noise({ at: 0.07, dur: 0.035, freq: 2400, q: 2, gain: 0.18 });
        this._tone({ at: 0.03, freq: 420, to: 620, dur: 0.22, type: 'triangle', gain: 0.12 });
        break;
      case 'allin':
        this._noise({ dur: 0.035, freq: 3000, q: 2, gain: 0.2 });
        this._noise({ at: 0.06, dur: 0.035, freq: 2600, q: 2, gain: 0.2 });
        this._noise({ at: 0.12, dur: 0.035, freq: 2200, q: 2, gain: 0.2 });
        this._tone({ at: 0.04, freq: 320, to: 520, dur: 0.45, type: 'sawtooth', gain: 0.08 });
        break;
      case 'turn':
        this._tone({ freq: 880, dur: 0.11, type: 'sine', gain: 0.2 });
        this._tone({ at: 0.13, freq: 1180, dur: 0.16, type: 'sine', gain: 0.18 });
        break;
      case 'win': {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => {
          this._tone({ at: i * 0.085, freq: f, dur: 0.3, type: 'triangle', gain: 0.16 });
        });
        this._noise({ at: 0.02, dur: 0.08, freq: 4200, q: 0.8, gain: 0.1 });
        break;
      }
      case 'lose':
        this._tone({ freq: 392, dur: 0.18, type: 'triangle', gain: 0.14 });
        this._tone({ at: 0.16, freq: 311, dur: 0.26, type: 'triangle', gain: 0.12 });
        break;
      case 'join':
        this._tone({ freq: 660, dur: 0.1, type: 'sine', gain: 0.13 });
        break;
      case 'click':
        this._tone({ freq: 520, to: 460, dur: 0.05, type: 'sine', gain: 0.12 });
        break;
      default:
        break;
    }
  }
}

export const audio = new AudioKit();
