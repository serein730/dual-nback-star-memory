import * as THREE from 'three';
import { BreathRing } from './BreathRing.js';

/**
 * 静息环节 —— 正式测评开始前的一段呼吸引导。
 *
 * 为什么要有这一段（它不是装饰）：
 *
 *  1. 生理上：4-2-6 的节律里呼气显著长于吸气，这是激活副交感（迷走）通路最简单的做法，
 *     能把过高的唤醒度压下来。ADHD 儿童在坐到屏幕前那一刻通常是"过度唤醒 + 冲动待发"，
 *     直接开打，前 30 秒的数据几乎必然偏冲动型，污染整场基线。
 *  2. 数据上：这 40 秒同时是一次静息态基线采集（eyes-open resting baseline）。
 *     报告里"任务态比静息态高多少"比孤立的专注度绝对值有意义得多 ——
 *     绝对值受电极位置、个体差异影响太大，差值才是可比的。
 *  3. 体验上：给孩子一个从"跑来跑去"切到"坐下来"的仪式。有明确的起点，
 *     比直接弹出倒计时更容易进入状态。
 *
 * 节律参数（4 秒吸 / 2 秒屏 / 6 秒呼 × 3 轮）是按儿童肺活量拍的：
 * 呼气必须长于吸气，但 6 秒已经是多数学龄儿童不憋气就能完成的上限；
 * 屏息只留 2 秒 —— 再长孩子会紧张，反而把唤醒度又拉上去。
 */

const CYCLES = 3;
const RHYTHM = { inhale: 4.0, hold: 2.0, exhale: 6.0 };
const INTRO = 2.6;
const OUTRO = 2.8;

/** 呼尽时环不会收成一个点：留一截底，否则中央的字会被环压到。 */
const EXHALED = 0.12;

const COLOR = {
  calm: new THREE.Color('#4fd8ff'),
  low: new THREE.Color('#6f8cff'),    // 呼尽：偏冷的蓝紫
  peak: new THREE.Color('#7dffd0'),   // 吸满：亮薄荷
};

const COPY = {
  intro: { label: '准 备', hint: '坐好，肩膀松下来', color: '#4fd8ff' },
  inhale: { label: '吸 气', hint: '用鼻子，慢慢吸满', color: '#7dffd0' },
  hold: { label: '屏 住', hint: '轻轻停一下', color: '#a8ffe4' },
  exhale: { label: '呼 气', hint: '用嘴巴，慢慢吐完', color: '#8fa8ff' },
  outro: { label: '很 好', hint: '现在我们开始', color: '#7dffd0' },
};

const smooth = (k) => k * k * (3 - 2 * k);

export class RestPhase {
  /** @param {object} ctx { scene, assets, audio, fx, world, bci, metrics, mascot, say } */
  constructor(ctx) {
    Object.assign(this, ctx);

    this.center = new THREE.Vector3(0, 1.5, -2.35);
    this.ring = new BreathRing(this.assets, { size: 1.8, floorDrop: this.center.y - 0.03 });
    this.ring.position.copy(this.center);
    this.ring.visible = false;
    this.scene.add(this.ring);

    this.steps = this._buildSteps();
    this.total = this.steps.reduce((a, s) => a + s.dur, 0);

    this._color = new THREE.Color();
    this._floorPoint = new THREE.Vector3(0, 0.03, this.center.z + 0.16);
    this._floorUp = new THREE.Vector3(0, 6, this.center.z + 0.16);
    this._mascotScale = this.mascot.scale.x;

    // 面板每帧要读，做成常驻对象避免运行期分配
    this._ui = { label: '', hint: '', color: '#4fd8ff', cycle: -1, cycles: CYCLES, done: 0, open: 0 };

    this.finished = true;
  }

  _buildSteps() {
    const steps = [{ kind: 'intro', dur: INTRO, cycle: -1, from: COLOR.calm, to: COLOR.low }];
    for (let c = 0; c < CYCLES; c++) {
      steps.push({ kind: 'inhale', dur: RHYTHM.inhale, cycle: c, from: COLOR.low, to: COLOR.peak });
      steps.push({ kind: 'hold', dur: RHYTHM.hold, cycle: c, from: COLOR.peak, to: COLOR.peak });
      steps.push({ kind: 'exhale', dur: RHYTHM.exhale, cycle: c, from: COLOR.peak, to: COLOR.low });
    }
    steps.push({ kind: 'outro', dur: OUTRO, cycle: -1, from: COLOR.low, to: COLOR.calm });
    return steps;
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  enter() {
    this.i = 0;
    this.t = 0;
    this.elapsed = 0;
    this.open = 0;
    this.cyclesDone = 0;
    this.finished = false;

    this.ring.visible = true;
    this.ring.reset();
    this.assets.setMascotMood(this.mascot, 'happy');
    // 环境铺底抬一点：这 40 秒画面上几乎什么都不发生，太安静会让人觉得程序卡住了
    this.audio.setAmbientGain(0.1);
    this.audio.calmBell(0);
    this._enterStep(this.steps[0]);
  }

  exit() {
    this.finished = true;
    this.ring.visible = false;
    this.ring.reset();
    this.audio.setAmbientGain(0.055);
    this.mascot.scale.setScalar(this._mascotScale);
  }

  _enterStep(s) {
    switch (s.kind) {
      case 'intro':
        this.say('先跟我一起呼吸三次，把心静下来～', INTRO + 1.6);
        break;
      case 'inhale':
        this.audio.breath('in', s.dur);
        break;
      case 'hold':
        if (s.cycle === 0) this.say('停一下下就好', 1.8);
        break;
      case 'exhale':
        this.audio.breath('out', s.dur);
        // 第一次呼气就把压力卸掉。做不到才是常态，
        // 让孩子在静息环节里体验"失败"是这个设计能想到的最糟结果
        if (s.cycle === 0) this.say('跟不上也没关系，慢慢来就好', 3);
        // 地面涟漪：把"吐出去的这口气"变成一件看得见的事，
        // 也顺便把孩子的视线从环上带到脚下的台面，视线一移动就不容易发呆
        this.fx.ring(this._floorPoint, {
          color: 0x8fe4ff, from: 0.35, to: 3.4, ttl: s.dur * 0.92, lookAt: this._floorUp,
        });
        break;
      case 'outro':
        this.audio.calmBell(2);
        this.say('很好，现在我们出发！', OUTRO);
        break;
      default: break;
    }
  }

  _advance() {
    const done = this.steps[this.i];
    this.t -= done.dur;

    if (done.kind === 'exhale') {
      this.cyclesDone = done.cycle + 1;
      if (this.cyclesDone < CYCLES) {
        this.audio.calmBell(this.cyclesDone);
        this.say(this.cyclesDone === 1 ? '很好，就是这样～' : '最后一次，慢慢来', 2.2);
      }
    }

    this.i++;
    if (this.i >= this.steps.length) { this.finished = true; return; }
    this._enterStep(this.steps[this.i]);
  }

  /* ------------------------------ 每帧 ------------------------------ */

  update(dt) {
    if (this.finished) return;
    const s = this.steps[this.i];
    this.t += dt;
    this.elapsed += dt;
    const k = Math.min(1, this.t / s.dur);

    // 呼吸曲线走余弦而不是线性：真实的吸与呼在两端都是渐进的，
    // 线性插值会在阶段切换的瞬间"顶"一下，孩子会跟着一顿，节奏就断了
    let open = this.open;
    let glow = 1;
    let arc = 1;
    switch (s.kind) {
      case 'intro':
        open = EXHALED * smooth(k); glow = smooth(k); arc = 0;
        break;
      case 'inhale':
        open = EXHALED + (1 - EXHALED) * (1 - Math.cos(Math.PI * k)) / 2;
        break;
      case 'hold':
        // 屏息期环必须还在动，哪怕只有 1% —— 完全静止会被读成"卡住了"
        open = 1 + Math.sin(this.elapsed * 2.3) * 0.012;
        break;
      case 'exhale':
        open = EXHALED + (1 - EXHALED) * (1 + Math.cos(Math.PI * k)) / 2;
        break;
      case 'outro':
        open = EXHALED * (1 - smooth(k)); glow = 1 - smooth(k); arc = 0;
        break;
      default: break;
    }
    this.open = open;

    this._color.copy(s.from).lerp(s.to, k);
    this.ring.set({ open, progress: k, arc, glow, color: this._color });
    this.ring.update(dt);

    // 整个星海跟着一起呼吸。复用的是神经反馈那套视觉语言（极光/舞台灯随专注度起伏），
    // 只是这一次驱动它的不是脑电，而是孩子自己的呼吸 —— 对孩子来说是同一件事：
    // "我做的事情，世界会回应"。
    this.world.setAttention(0.2 + open * 0.55);
    this.mascot.scale.setScalar(this._mascotScale * (1 + open * 0.055));

    // 静息基线：丢掉开头 4 秒（电极接触质量还在爬升，孩子也还没安静下来），
    // 收尾段同样不采 —— 那时孩子已经在准备起跳了，不算静息
    if (this.elapsed > 4 && s.kind !== 'outro') this.metrics.sampleRest(this.bci.attention);

    if (this.t >= s.dur) this._advance();
  }

  /** 给 RestPanel 读的界面状态（常驻对象，不产生每帧垃圾）。 */
  get uiState() {
    const s = this.steps[Math.min(this.i, this.steps.length - 1)];
    const c = COPY[s.kind];
    const u = this._ui;
    u.label = c.label;
    u.hint = c.hint;
    u.color = c.color;
    u.cycle = s.cycle;
    u.done = this.cyclesDone;
    u.open = this.open;
    return u;
  }
}

export { CYCLES as REST_CYCLES };
