import * as THREE from 'three';
import { MiniGame } from './MiniGame.js';

/**
 * 回声之路 —— 视觉空间工作记忆广度（Corsi 方块任务的 3D 变体）。
 *
 * 工作记忆是注意力的"容器"。孩子记不住刚才的指令，往往不是不听话，
 * 而是容器装不下。Cogmed 这类产品的核心训练量就压在这条通路上。
 *
 * 【2026-08-06 改版】保留 Corsi 的核心（**每一轮独立重抽一条新序列**），
 * 只把长度调节从 2-up/1-down 阶梯法换成更直觉的规则：
 *
 *   答对        → 长度 +1
 *   答错 1 次   → 长度不变，换一条**新的**同长度序列再来
 *   连错 2 次   → 长度 −1（下限 2）
 *
 * 为什么不做成"在上一轮末尾追加一根"（Simon 式）：那样相邻轮次不独立，
 * 后一轮包含前一轮的全部内容，把它们当独立试次做统计是有偏的。
 *
 * ⚠️ **这个阶梯的理论收敛点是 29.3% 正确率**（解 `2p²−4p+1=0`），远低于
 * `CLAUDE.md` 坑#18 的 75~85% 心流带。之所以还能用，是因为**一局跑不到那里**：
 * 52 秒只有 5~6 轮、每局都从长度 2 重新开始，前 3~4 轮几乎必对，
 * 实际整局正确率约 60~65%（与改前的 `Staircase` 收敛值 61.8% 基本持平）。
 * 但要知道它的固有特性是**每局最后一两轮必然失败** —— 难度只升不停，总会顶到墙。
 * 如果哪天把 duration 显著拉长，这条规则就会往 29% 掉，那时必须换回阶梯法。
 */

const START_LEN = 2;        // 每局的起始长度
const MIN_LEN = 2;          // 长度下限
const LEAD_IN = 0.75;       // 演示前的静默前摇：给孩子一拍准备时间
const ON = 0.52;            // 单根柱子的点亮时长
const GAP_MAX = 0.40;       // 步间隔上限（短序列用）
const GAP_MIN = 0.20;       // 步间隔下限（长序列压缩到这里为止）
const ERR_HOLD = 1.7;       // 答错后的静默停顿
const WIN_HOLD = 1.3;       // 答对后的庆祝停顿
const DOWN_AFTER = 2;       // 连错几次才降 1 步

/**
 * 记忆期的干扰闪光 —— **2026-08-06 用户拍板关掉，逻辑整段保留在下面**。
 *
 * 关掉的理由（实测出来的，不是口味）：序列步走 `_light()`（亮 **且** 响自己的音高），
 * 干扰只改 `glow`（亮但**哑**）。孩子两三轮就会发现"哑的不算"——这条捷径一旦形成，
 * 干扰就不再消耗注意资源，正好落进坑#17 说的自动化，抗干扰的训练价值归零。
 *
 * 改回 `true` 即可恢复。恢复时要一并处理的两件事：
 *   ① 候选池是"不在本轮序列里的柱子"，序列长到 6 步时可能取空 —— **越难干扰越少，方向是反的**；
 *   ② `README.md` 与 `决策存档/2026-08-05-范式与证据.md` 里"记忆 + 抗干扰"的描述得改回来。
 */
const DISTRACTION = false;

/**
 * 六根柱子的位置与配色。
 *
 * 弧度受桌面视场角限制：六根柱子必须一屏全进，否则孩子要靠转头补全序列，
 * 记忆负荷就掺进了眼动成本，测出来的广度不再是广度。
 *
 * 颜色不只是好看：序列记忆任务里，颜色是位置之外的**第二条编码线索**，
 * 换一套颜色等于换了一次任务难度。
 *
 * **提到模块级是为了让关卡演示（`core/Demo.js`）用同一份布局与配色** ——
 * 演示里"第三根黄色的柱子"到了真关卡里得还是同一根、还是黄的。
 */
export function echoLayout() {
  const colors = [0x4de2ff, 0x6bffb0, 0xffc94d, 0xb98cff, 0xff8fb0, 0x7fd4ff];
  const N = colors.length;
  const r = 3.7;
  return colors.map((color, i) => {
    const a = -Math.PI * 0.175 + (i / (N - 1)) * Math.PI * 0.35;
    return { x: Math.sin(a) * r, z: -Math.cos(a) * r, yaw: -a, color };
  });
}

/** 地面引导环：把六根柱子在视觉上串成一条"路"。演示里也要有，否则那条路不存在。 */
export function echoPathRing() {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(3.56, 3.64, 96, 1, Math.PI * 0.325, Math.PI * 0.35),
    new THREE.MeshBasicMaterial({
      color: 0x6bffb0, transparent: true, opacity: 0.22, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  // 绕 X 轴放平后，环上角 θ 落到世界 (r·cosθ, 0, -r·sinθ)，
  // 与柱子的 (sin a, 0, -cos a) 对齐即 θ = π/2 - a
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.01;
  return m;
}

export class EchoPath extends MiniGame {
  static meta = {
    id: 'echo',
    name: '回声之路',
    skill: '工作记忆 · 序列广度',
    blurb: '记住柱子亮起的顺序，再点一遍',
    color: '#6bffb0',
    duration: 52,
    howto: [
      ['1', '看好水晶柱依次亮起的顺序，每根柱子有自己的声音'],
      ['2', '轮到你的时候，按同样的顺序把它们点一遍'],
      ['3', '记对了下一轮就多一根；记错了不要紧，同样长度再来一次'],
    ],
  };

  constructor(ctx) {
    super(ctx);
    this.pillars = [];
    this.phase = 'idle';      // show | recall | feedback
    this.phaseT = 0;
    this.span = START_LEN;    // 当前轮的序列长度（唯一的难度变量）
    this.wrongRun = 0;        // 连错计数，攒够 DOWN_AFTER 才降一步
    this.trend = 'first';     // up | same | down | first —— 只用来挑吉祥物台词
    this.sequence = [];
    this.inputIndex = 0;
    this.showIndex = -1;
    this.hold = WIN_HOLD;
    this.stepFlash = 0;
    this.rounds = 0;
    this.perfect = 0;
    this.peakSpan = 0;        // 完整复现过的最长序列（结算/报告读这个）
  }

  get currentSpan() { return this.span; }

  /** HUD 只显示已达成的最长长度，不显示当前轮的长度 —— 那等于提前告诉他要点几个。 */
  get difficultyLabel() { return this.peakSpan ? `最长 ${this.peakSpan} 步` : '热身'; }

  /** 演示节奏：序列越长每步越紧凑，但不低于 GAP_MIN，否则长序列的演示会吃掉大半局。 */
  get _step() {
    const over = Math.max(0, this.span - START_LEN);
    return ON + Math.max(GAP_MIN, GAP_MAX - over * 0.03);
  }

  enter() {
    super.enter();
    const { assets } = this.ctx;
    const layout = echoLayout();

    for (let i = 0; i < layout.length; i++) {
      const spot = layout[i];
      const p = assets.crystalPillar(spot.color);
      p.position.set(spot.x, 0, spot.z);
      p.rotation.y = spot.yaw;
      const hb = this.makeHitbox(p, { box: [0.78, 1.6, 0.78] });
      hb.position.y = 0.75;
      p.add(hb);
      p.userData.hitbox = hb;
      p.userData.index = i;
      p.userData.glow = 0;
      p.userData.tone = i;
      this.root.add(p);
      this.pillars.push(p);
    }

    const path = echoPathRing();
    this.root.add(path);
    this.pathRing = path;

    this._beginRound();
  }

  /** 往序列末尾追加一步（不与上一步同柱，避免"连点同一根"这种退化的记忆项）。 */
  _appendStep() {
    const last = this.sequence.length ? this.sequence[this.sequence.length - 1] : -1;
    let idx;
    do { idx = Math.floor(Math.random() * this.pillars.length); } while (idx === last);
    this.sequence.push(idx);
  }

  _beginRound() {
    // 每一轮都重新抽整条序列，不在上一轮基础上追加 ——
    // 相邻轮次因此相互独立，长度是唯一变化的量（Corsi 的施测精神）
    this.sequence.length = 0;
    for (let i = 0; i < this.span; i++) this._appendStep();

    this.showIndex = -1;
    this.inputIndex = 0;
    this.phase = 'show';
    this.phaseT = 0;
    this.hitboxes.length = 0;
    this.roundSpan = this.span;
    this.distraction = DISTRACTION && this.span >= 4;
    this._nextDistraction = LEAD_IN + 0.6;
    this.ctx.onEvent?.({ type: 'echo-show', trend: this.trend });
  }

  _light(pillar, strength = 1, tone = true) {
    pillar.userData.glow = strength;
    if (tone) this.ctx.audio.tone(pillar.userData.tone, 0.34);
    const px = pillar.position.x, pz = pillar.position.z;
    // lookAt 指向正上方 → 光环平铺在地面上，像柱子踩出来的水波
    this.ctx.fx.ring(new THREE.Vector3(px, 0.04, pz), {
      color: pillar.userData.color, from: 0.32, to: 1.05, ttl: 0.55,
      lookAt: new THREE.Vector3(px, 10, pz),
    });
  }

  _enterRecall() {
    this.phase = 'recall';
    this.phaseT = 0;
    this.inputIndex = 0;
    this.hitboxes = this.pillars.map((p) => p.userData.hitbox);
    this.recallStart = this.elapsed;
    this.ctx.audio.select();
    this.ctx.onEvent?.({ type: 'echo-recall' });
  }

  _finishRound(correct) {
    const { fx, audio, input } = this.ctx;
    const rt = (this.elapsed - this.recallStart) * 1000;
    this.hitboxes.length = 0;
    this.phase = 'feedback';
    this.phaseT = 0;
    this.rounds++;

    this.logTrial({
      kind: 'memory', responded: true, correct,
      rt: correct ? rt : null, level: this.roundSpan,
    });

    if (correct) {
      this.perfect++;
      this.wrongRun = 0;
      const isBest = this.roundSpan > this.peakSpan;
      this.peakSpan = Math.max(this.peakSpan, this.roundSpan);
      this.span = this.roundSpan + 1;
      this.trend = 'up';

      const gained = this.addScore(8 * this.roundSpan);
      fx.floatText(new THREE.Vector3(0, 1.5, -2.4), `+${gained}`,
        { color: '#8ff6ff', scale: 0.4 });
      if (isBest && this.roundSpan > START_LEN) {
        fx.floatText(new THREE.Vector3(0, 2.05, -2.4), `${this.roundSpan} 步全对！`,
          { color: '#6bffb0', scale: 0.3, ttl: 1.5 });
        audio.levelUp();
      } else {
        audio.hit(this.streak);
      }
      for (const i of this.sequence) {
        const p = this.pillars[i];
        fx.burst(new THREE.Vector3(p.position.x, 1.3, p.position.z),
          { color: p.userData.color, count: 16, speed: 2.6, size: 0.5 });
      }
      input.pulseAll(0.6, 50);
      this.hold = WIN_HOLD;
    } else {
      this.wrongRun++;
      const stepDown = this.wrongRun >= DOWN_AFTER;
      if (stepDown) {
        this.wrongRun = 0;
        this.span = Math.max(MIN_LEN, this.roundSpan - 1);
        this.trend = 'down';
      } else {
        // 错一次不降级：长度不变，下一轮换一条新的同长度序列再来。
        // 降级步长比升级慢，是坑#18 的老规矩 —— 先保住孩子的信心。
        this.span = this.roundSpan;
        this.trend = 'same';
      }

      audio.commission();
      input.pulseAll(0.8, 90);
      fx.floatText(new THREE.Vector3(0, 1.5, -2.4),
        stepDown ? '我们慢一点，别急' : '没关系，再来一次',
        { color: '#ffd36e', scale: 0.28, ttl: 1.5 });
      // 这里**没有错误回放**（2026-08-06 去掉）。原来是错完立刻高速回放正确序列，
      // 但孩子刚错完最不想看回放，而且回放会立刻接上下一轮的闪烁，
      // 看起来就是"点错了画面就一直在闪"。现在换成一整拍静默，让提示读完再开始。
      this.hold = ERR_HOLD;
    }
  }

  update(dt) {
    this.elapsed += dt;
    this.phaseT += dt;
    const t = this.elapsed;
    this.stepFlash = Math.max(0, this.stepFlash - dt * 2.5);

    if (this.phase === 'show') {
      const step = this._step;
      if (this.phaseT >= LEAD_IN) {
        const idx = Math.floor((this.phaseT - LEAD_IN) / step);
        if (idx !== this.showIndex && idx < this.sequence.length) {
          this.showIndex = idx;
          this._light(this.pillars[this.sequence[idx]], 1);
        }
      }
      // 干扰闪光（当前由 DISTRACTION 关掉，见文件头的归档说明）：
      // 不属于序列的柱子偶尔弱亮一下，且不发声
      if (this.distraction && this.phaseT > this._nextDistraction) {
        this._nextDistraction = this.phaseT + 0.5 + Math.random() * 0.7;
        const pool = this.pillars.filter((p) => !this.sequence.includes(p.userData.index));
        if (pool.length) {
          const d = pool[Math.floor(Math.random() * pool.length)];
          d.userData.glow = Math.max(d.userData.glow, 0.42);
        }
      }
      if (this.phaseT > LEAD_IN + this.sequence.length * step + 0.2) this._enterRecall();
    } else if (this.phase === 'recall') {
      const { hovered, presses } = this.readPointers();
      for (const p of this.pillars) {
        p.userData.hoverK = THREE.MathUtils.lerp(
          p.userData.hoverK ?? 0, hovered.has(p) ? 1 : 0, dt * 12,
        );
      }
      for (const press of presses) {
        if (!press.target) continue;
        const idx = press.target.userData.index;
        this._light(press.target, 0.9);
        if (idx === this.sequence[this.inputIndex]) {
          this.inputIndex++;
          this.stepFlash = 1;   // 地面引导环递进一下：告诉孩子"这一步对了，继续"
          if (this.inputIndex >= this.sequence.length) { this._finishRound(true); break; }
        } else {
          press.target.userData.wrong = 0.5;
          this._finishRound(false);
          break;
        }
      }
      // 超时保护：按序列长度给时间，长序列不能用一刀切的秒数卡
      if (this.phase === 'recall' && this.phaseT > this.sequence.length * 2.8 + 3) {
        this._finishRound(false);
      }
    } else if (this.phase === 'feedback') {
      if (this.phaseT > this.hold) {
        if (this.elapsed < this.duration - 3) this._beginRound();
        else this.phase = 'idle';
      }
    }

    // 柱体发光衰减 + 悬停反馈
    for (const p of this.pillars) {
      const u = p.userData;
      u.glow = Math.max(0, u.glow - dt * 2.4);
      const hover = (u.hoverK ?? 0) * 0.25;
      const lit = u.glow + hover;
      // 点亮强度是调过的：emissive 给到 2.4 + 点光 16 时，柱子会烧成纯白，
      // 连"哪根柱子是什么颜色"都看不出来 —— 而颜色正是这个任务的记忆线索之一
      u.colMat.emissiveIntensity = u.baseIntensity + lit * 1.0;
      u.gem.material.opacity = 0.55 + lit * 0.45;
      u.gem.scale.setScalar(1 + lit * 0.55);
      u.gem.rotation.y += dt * (0.8 + lit * 4);
      u.halo.material.opacity = lit * 0.7;
      u.halo.scale.setScalar(1.1 + lit * 1.2);
      u.light.intensity = lit * 4.5;
      if (u.wrong > 0) {
        u.wrong -= dt;
        p.position.x += Math.sin(t * 55) * 0.006;
        u.colMat.emissive.setHex(0xff4a5e);
      } else if (u.colMat.emissive.getHex() !== u.color) {
        u.colMat.emissive.setHex(u.color);
      }
    }

    // 前摇期间让引导环先亮一下，作为"要开始演示了"的无声预告
    const leadK = (this.phase === 'show' && this.phaseT < LEAD_IN)
      ? Math.sin((this.phaseT / LEAD_IN) * Math.PI) * 0.22 : 0;
    this.pathRing.material.opacity = 0.14 + Math.sin(t * 1.3) * 0.05
      + (this.phase === 'recall' ? 0.18 : 0) + leadK + this.stepFlash * 0.16;

    if (this.elapsed >= this.duration) this.finished = true;
  }
}
