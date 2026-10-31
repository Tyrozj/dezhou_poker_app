/**
 * 声音引擎：不依赖任何音频文件，全部用 WebAudio 现场合成。
 * - 背景音乐：四段循环的柔和小调铺底（低音量）
 * - 音效：发牌、筹码、过牌、弃牌、加注、全下、赢/输、轮到你
 *
 * 浏览器要求"用户手势后才能出声"，所以第一次点击时调用 unlock()。
 */

const STORE_MUSIC = 'dz.music';
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

export class AudioKit {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicBus = null;
    this.sfxBus = null;
    this.noiseBuf = null;
    this.bgmTimer = null;
    this.bgmChord = 0;
    this.bgmNodes = [];
    this.musicOn = readPref(STORE_MUSIC) !== '0';
    this.sfxOn = readPref(STORE_SFX) !== '0';
    this.unlocked = false;
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
      this.musicBus.gain.value = this.musicOn ? 0.16 : 0;
      this.musicBus.connect(this.master);

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.sfxOn ? 0.85 : 0;
      this.sfxBus.connect(this.master);

      // 一段白噪声，发牌/筹码声都从这里取
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

  /* ---------------- 背景音乐 ---------------- */

  startMusic() {
    const ctx = this.ensure();
    if (!ctx || !this.musicOn || this.bgmTimer) return;
    this.bgmChord = 0;
    this._scheduleChord(true);
    this.bgmTimer = setInterval(() => this._scheduleChord(false), 6200);
  }

  stopMusic() {
    if (this.bgmTimer) clearInterval(this.bgmTimer);
    this.bgmTimer = null;
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const node of this.bgmNodes) {
      try {
        node.gain.cancelScheduledValues(now);
        node.gain.setTargetAtTime(0, now, 0.4);
      } catch {
        /* 已经停了 */
      }
    }
    this.bgmNodes = [];
  }

  setMusic(on) {
    this.musicOn = !!on;
    writePref(STORE_MUSIC, on ? '1' : '0');
    if (!this.ctx) return;
    if (on) {
      this.musicBus.gain.setTargetAtTime(0.16, this.ctx.currentTime, 0.2);
      if (this.unlocked) this.startMusic();
    } else {
      this.musicBus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
      this.stopMusic();
    }
  }

  _scheduleChord(first) {
    const ctx = this.ctx;
    if (!ctx || !this.musicOn) return;

    // A 小调氛围的四段进行，音量很低，只做"有音乐"的底噪感
    const CHORDS = [
      [220.0, 261.63, 329.63, 392.0], // Am7
      [174.61, 220.0, 261.63, 329.63], // Fmaj7
      [130.81, 164.81, 196.0, 246.94], // Cmaj7
      [196.0, 246.94, 293.66, 329.63], // G6
    ];
    const chord = CHORDS[this.bgmChord % CHORDS.length];
    this.bgmChord += 1;

    const start = ctx.currentTime + (first ? 0.15 : 0.1);
    const dur = first ? 7 : 7.5;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 1250;
    filt.Q.value = 0.4;
    filt.connect(this.musicBus);

    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.09;
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain).connect(filt.frequency);
    lfo.start(start);
    lfo.stop(start + dur + 3);

    for (const freq of chord) {
      for (const detune of [-4, 4]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        osc.detune.value = detune;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.09, start + 1.6);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(gain).connect(filt);
        osc.start(start);
        osc.stop(start + dur + 0.2);
        this.bgmNodes.push(gain);
      }
    }
    // 轻低音
    const bass = ctx.createOscillator();
    bass.type = 'sine';
    bass.frequency.value = chord[0] / 2;
    const bassGain = ctx.createGain();
    bassGain.gain.setValueAtTime(0.0001, start);
    bassGain.gain.exponentialRampToValueAtTime(0.1, start + 1.2);
    bassGain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    bass.connect(bassGain).connect(this.musicBus);
    bass.start(start);
    bass.stop(start + dur + 0.2);
    this.bgmNodes.push(bassGain);

    // 只保留最近的和弦节点，避免数组无限增长
    if (this.bgmNodes.length > 40) this.bgmNodes.splice(0, this.bgmNodes.length - 40);
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
