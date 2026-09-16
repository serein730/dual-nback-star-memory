/**
 * 全程序化音效（WebAudio 合成，零音频素材，零加载时间）。
 *
 * 儿童注意力训练的音效设计有两条硬约束：
 *  1. 正反馈必须即时、明亮、可叠加（连击升调），强化正确反应；
 *  2. 负反馈不能刺耳 —— 错误只是"提示"，不是"惩罚"，否则孩子会为了躲避声音而放弃作答，
 *     误报率下降但漏报率飙升，训练数据就废了。这里用低音量的柔和短音代替蜂鸣。
 */
export class AudioKit {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.ambient = null;
  }

  /** 必须在用户手势里调用（浏览器自动播放策略）。 */
  unlock() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { this.enabled = false; return; }
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
  }

  _voice({ type = 'sine', freq = 440, dur = 0.18, gain = 0.3, attack = 0.006, glide = 0, pan = 0, detune = 0 }) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(freq, t);
    if (glide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * glide), t + dur);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    let node = g;
    if (this.ctx.createStereoPanner && pan) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p); node = p;
    }
    osc.connect(g); node.connect(this.master);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  _noise({ dur = 0.25, gain = 0.14, freq = 900, q = 1.2, pan = 0 }) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const len = Math.ceil(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const g = this.ctx.createGain(); g.gain.value = gain;
    let node = g;
    if (this.ctx.createStereoPanner && pan) {
      const p = this.ctx.createStereoPanner(); p.pan.value = pan;
      g.connect(p); node = p;
    }
    src.connect(bp); bp.connect(g); node.connect(this.master);
    src.start(t);
  }

  // ---------- 语义化音效 ----------

  /** 命中 Go 目标：连击越高越亮（五声音阶，不会难听）。 */
  hit(streak = 0, pan = 0) {
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
    const semi = scale[Math.min(streak, scale.length - 1)];
    const f = 523.25 * Math.pow(2, semi / 12);
    this._voice({ type: 'triangle', freq: f, dur: 0.16, gain: 0.28, pan });
    this._voice({ type: 'sine', freq: f * 2, dur: 0.22, gain: 0.12, pan, attack: 0.02 });
  }

  /** 误报（该忍住却出手了）：柔和的下滑短音，不刺耳。 */
  commission(pan = 0) {
    this._voice({ type: 'sine', freq: 233, dur: 0.26, gain: 0.16, glide: 0.72, pan });
    this._noise({ dur: 0.16, gain: 0.05, freq: 420, pan });
  }

  /** 漏报（目标溜走）：一声几乎听不出情绪的气声。 */
  omission() {
    this._noise({ dur: 0.3, gain: 0.045, freq: 700, q: 0.7 });
  }

  select() { this._voice({ type: 'sine', freq: 720, dur: 0.07, gain: 0.16 }); }
  hover() { this._voice({ type: 'sine', freq: 980, dur: 0.045, gain: 0.05 }); }

  countdown(n) {
    const f = n <= 0 ? 880 : 440 + (3 - n) * 60;
    this._voice({ type: 'triangle', freq: f, dur: n <= 0 ? 0.4 : 0.12, gain: 0.24 });
  }

  levelUp() {
    [0, 4, 7, 12].forEach((s, i) => {
      setTimeout(() => this._voice({
        type: 'triangle', freq: 523.25 * Math.pow(2, s / 12), dur: 0.3, gain: 0.22,
      }), i * 85);
    });
  }

  fanfare() {
    [0, 7, 12, 16, 19].forEach((s, i) => {
      setTimeout(() => {
        this._voice({ type: 'triangle', freq: 392 * Math.pow(2, s / 12), dur: 0.5, gain: 0.2 });
        this._voice({ type: 'sine', freq: 784 * Math.pow(2, s / 12), dur: 0.6, gain: 0.08 });
      }, i * 120);
    });
  }

  /** 序列复现关卡里每根柱子的音高（把空间序列同时编码成听觉序列，是 Corsi 类任务的常见增强）。 */
  tone(index, dur = 0.32) {
    const scale = [261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25];
    const f = scale[index % scale.length] * (index >= scale.length ? 2 : 1);
    this.toneHz(f, dur);
  }

  /**
   * 按明确频率播放记忆刺激。N-back 的音高集合属于施测协议，不能再通过
   * `tone(index)` 的内部音阶间接推导，否则协议与实际刺激会静默漂移。
   */
  toneHz(freq, dur = 0.32) {
    const f = Number(freq);
    if (!Number.isFinite(f) || f <= 0) return;
    this._voice({ type: 'sine', freq: f, dur, gain: 0.26, attack: 0.02 });
    this._voice({ type: 'triangle', freq: f * 2, dur: dur * 0.7, gain: 0.07 });
  }

  /**
   * N-back 的听觉项目：三角波提供清楚的起音，纯音泛音保留稳定音高。
   * 这是“刺激”，不是答对/答错的音效，调用方必须传协议内的固定频率。
   */
  nbackToneHz(freq, dur = 0.52) {
    const f = Number(freq);
    if (!Number.isFinite(f) || f <= 0) return;
    this._voice({ type: 'triangle', freq: f, dur, gain: 0.3, attack: 0.008 });
    this._voice({ type: 'sine', freq: f * 2, dur: dur * 0.68, gain: 0.065, attack: 0.012 });
  }

  /**
   * 儿童版 N-back 用清楚的字母名作为听觉项目；系统没有可用英语语音时，才回退
   * 到协议内的固定音高。字母内容随试次索引记录，回退不会改变 N-back 判定。
   */
  nbackLetter(letter, fallbackHz, dur = 0.52) {
    const synth = globalThis.speechSynthesis;
    const Utterance = globalThis.SpeechSynthesisUtterance;
    if (synth && Utterance && this.enabled) {
      synth.cancel();
      const u = new Utterance(String(letter));
      u.lang = 'en-US';
      u.rate = 0.72;
      u.pitch = 1.18;
      u.volume = 0.62;
      synth.speak(u);
      return;
    }
    this.nbackToneHz(fallbackHz, dur);
  }

  /**
   * 呼吸引导音（静息环节）：吸气上行、呼气下行。
   *
   * 三条约束：
   *  1. 必须是"陪伴"不是"指令"—— 音量压到 0.085，孩子跟不上也不会有被催的感觉；
   *  2. 频率走连续 ramp 而不是分段音符，否则听起来像节拍器，反而把人绷紧；
   *  3. 呼气的低通往下扫、吸气往上扫 —— 亮度变化比音高变化更容易被无意识地跟随。
   */
  breath(dir = 'in', dur = 4) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const rise = dir === 'in';
    const f0 = rise ? 174.61 : 261.63;     // F3 ↔ C4
    const f1 = rise ? 261.63 : 174.61;

    const bus = this.ctx.createGain();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(rise ? 420 : 1500, t);
    lp.frequency.linearRampToValueAtTime(rise ? 1500 : 380, t + dur);
    bus.connect(lp); lp.connect(this.master);

    // 吸气的峰值靠后（越吸越满），呼气的峰值靠前（一开始就吐出去）
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.linearRampToValueAtTime(0.085, t + dur * (rise ? 0.62 : 0.16));
    bus.gain.linearRampToValueAtTime(0.0001, t + dur);

    [1, 2, 3].forEach((h, i) => {
      const o = this.ctx.createOscillator();
      o.type = i === 0 ? 'sine' : 'triangle';
      o.detune.value = i * 4;
      o.frequency.setValueAtTime(f0 * h, t);
      o.frequency.linearRampToValueAtTime(f1 * h, t + dur);
      const g = this.ctx.createGain();
      g.gain.value = 0.5 / (i + 1.6);
      o.connect(g); g.connect(bus);
      o.start(t); o.stop(t + dur + 0.1);
    });

    // 起手一声极轻的气声，像空气真的开始流动。只做 0.8 秒 ——
    // 噪声要现场合成 buffer，按整段时长生成纯属浪费内存
    this._noise({ dur: 0.8, gain: rise ? 0.02 : 0.026, freq: rise ? 1100 : 700, q: 0.6 });
  }

  /** 一轮呼吸完成的轻铃：泛音干净、衰减长，用来标记进度而不打断放松状态。 */
  calmBell(step = 0) {
    const f = 523.25 * Math.pow(2, [0, 4, 7][step % 3] / 12);
    this._voice({ type: 'sine', freq: f, dur: 1.7, gain: 0.1, attack: 0.012 });
    this._voice({ type: 'sine', freq: f * 2.01, dur: 1.2, gain: 0.04, attack: 0.02 });
    this._voice({ type: 'sine', freq: f * 3.02, dur: 0.8, gain: 0.02, attack: 0.02 });
  }

  /** 极低音量的环境铺底，给场景一点"活着"的感觉，不喧宾夺主。 */
  startAmbient() {
    if (!this.ctx || this.ambient) return;
    const t = this.ctx.currentTime;
    const bus = this.ctx.createGain();
    bus.gain.value = 0.0001;
    bus.gain.exponentialRampToValueAtTime(0.055, t + 4);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 620;
    bus.connect(filter); filter.connect(this.master);

    const oscs = [130.81, 196, 261.63, 329.63].map((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = i % 2 ? 'sine' : 'triangle';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.value = 0.25 / (i + 1);
      // 缓慢失谐制造 chorus 漂移感
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.05 + i * 0.017;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 3 + i;
      lfo.connect(lfoGain); lfoGain.connect(o.detune);
      lfo.start();
      o.connect(g); g.connect(bus); o.start();
      return o;
    });
    this.ambient = { bus, oscs };
  }

  /** 调整环境铺底音量（静息期抬高、回到游戏后压回）。 */
  setAmbientGain(v, ramp = 1.5) {
    if (!this.ctx || !this.ambient) return;
    const t = this.ctx.currentTime;
    const g = this.ambient.bus.gain;
    // startAmbient 里排了一条 4 秒的淡入曲线，不取消的话这里设的值会被它覆盖掉
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.exponentialRampToValueAtTime(Math.max(0.0001, v), t + ramp);
  }

  setMasterVolume(v) { if (this.master) this.master.gain.value = v; }
}
