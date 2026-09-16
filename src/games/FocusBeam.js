import * as THREE from 'three';
import { MiniGame } from './MiniGame.js';
import { Adaptive } from '../core/Adaptive.js';
import { RUNE_SHAPES } from '../core/Assets.js';

/**
 * 光束聚焦 —— 选择性注意 / 干扰抑制（视觉搜索 + 注意捕获对抗）。
 *
 * 星海捕手练的是"该出手时出手、该忍住时忍住"；这一关练的是另一件事：
 * 在一堆长得很像、还会主动抢眼球的东西里，锁定唯一正确的那个。
 *
 * 三条难度轴，分别对应三种不同的注意负荷，可以独立观察孩子卡在哪一条上：
 *   数量  6 → 14 个        搜索广度
 *   相似  异色异形 → 同色异形   特征搜索退化为联合搜索（不能再靠"跳出来"找）
 *   干扰  静止 → 强闪烁       外源性注意捕获，必须主动抑制才不会被拽走
 * 高难度时中央提示会在搜索开始后消失，额外叠加一层工作记忆负荷。
 */

export const PALETTE = [
  { name: '青', hex: 0x4de2ff },
  { name: '金', hex: 0xffc94d },
  { name: '紫', hex: 0xb98cff },
  { name: '绿', hex: 0x6bffb0 },
];

/**
 * 前方约 83° 弧面上的两排候选位。
 *
 * 这个角度是被桌面视场角卡出来的：相机 62° 垂直 FOV 在 16:9 下水平约 95°，
 * 弧再宽一点，边上的符文石就跑到屏幕外了。VR 里视野更宽，但保持同一套布局
 * 可以让两端的难度完全一致 —— 训练数据要可比，就不能让平台差异混进来。
 *
 * 上排的高度已经顶到 HUD 面板的下沿（HUD 在世界 y=2.55 / z=-2.7），再抬就会被它切掉一角；
 * 下排再往下就压到平台边缘。这两排的余量都已经用完，别再动 —— 提示台要让位就往下让。
 *
 * **提到模块级是为了让关卡演示（`core/Demo.js`）用同一份布局**：演示里符文石的位置
 * 要是和真关卡对不上，孩子刚建立的"该往哪儿看"就白建了。
 */
export function beamSlots() {
  const slots = [];
  const rows = [{ y: 1.24, r: 3.85, n: 8 }, { y: 2.04, r: 3.65, n: 7 }];
  for (const row of rows) {
    for (let i = 0; i < row.n; i++) {
      const spread = Math.PI * 0.42;
      const a = -spread / 2 + (row.n === 1 ? spread / 2 : (i / (row.n - 1)) * spread);
      slots.push({
        pos: new THREE.Vector3(Math.sin(a) * row.r, row.y, -Math.cos(a) * row.r),
        yaw: a,
      });
    }
  }
  return slots;
}

/** 给一块符文石换符号与配色。演示和关卡共用，省得两边的"同一个符文"长得不一样。 */
export function dressRune(assets, stone, shape, colorHex) {
  stone.userData.shape = shape;
  const sym = stone.userData.symbol;
  sym.material.map = assets.tex.runes[shape];
  sym.material.color.setHex(colorHex);
  sym.material.needsUpdate = true;
  stone.userData.halo.material.color.setHex(colorHex);
  stone.userData.plate.material.emissive?.setHex(0x000000);
  stone.userData.color = colorHex;
}

export class FocusBeam extends MiniGame {
  static meta = {
    id: 'beam',
    name: '光束聚焦',
    skill: '选择性注意 · 抗干扰',
    blurb: '在干扰里找出和提示一样的符文',
    color: '#b98cff',
    duration: 48,
    howto: [
      ['1', '中间的水晶台会先亮出一个"目标符文"，看清它的形状和颜色'],
      ['2', '周围会浮出一圈符文石，找到和提示完全一样的那一个并击中它'],
      ['3', '有些符文会故意闪烁抢你的注意力，别被它们带跑'],
    ],
  };

  constructor(ctx) {
    super(ctx);
    this.adaptive = new Adaptive({ start: 0.18, upAt: 0.82, downAt: 0.5, window: 6, stepUp: 0.1 });
    this.phase = 'idle';       // cue | search | feedback
    this.phaseT = 0;
    this.stones = [];
    this.trialIndex = 0;
    this.correctCount = 0;
    this.wrongCount = 0;
    this.timeouts = 0;
  }

  get params() {
    return this.adaptive.map({
      count: [6, 14],
      timeLimit: [6.2, 2.7],
      flicker: [0.0, 1.0],
      sameColor: [0.0, 1.0],   // 干扰项与目标同色的概率
      keepCue: [1.0, 0.0],     // 搜索阶段保留提示的概率
    });
  }

  get difficultyLabel() { return this.adaptive.describe(); }

  enter() {
    super.enter();
    const { assets } = this.ctx;

    // 中央提示台
    const pedestal = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.38, 0.5, 0.13, 24),
      assets.mat.metalDeep,
    );
    base.position.y = 0.065;
    pedestal.add(base);
    // 提示台整体压成矮祭坛：提示石不再悬在眼高，柱子也就没有存在的理由了
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.085, 0.18, 16),
      assets.mat.metalDeep,
    );
    stem.position.y = 0.22;
    pedestal.add(stem);
    pedestal.position.set(0, 0, -2.85);
    this.root.add(pedestal);
    this.pedestal = pedestal;

    /*
     * 提示石搬到候选阵列**下方**（原来在眼高 1.58）。
     *
     * 它在 z=-2.85，比候选石近 1m，0.72 的实物尺寸在屏幕上比候选石还大一圈，
     * 正正当当盖住中间那两三颗 —— 而被盖住的恰好是最先被扫视到的位置，
     * 等于随机地把一部分试次变成"目标根本看不见"，这些试次的数据是废的。
     *
     * 试过把两排候选石上下拉开、让出一条中缝给它，实测走不通：HUD 面板
     * （世界坐标 y=2.55 / z=-2.7）的下沿本来就压在上排石头的上沿，上面没有余量，
     * 下面又受地面限制，中缝装不下"候选 + 提示 + 两道间隙"。
     * 挪到下方则一次解决：候选阵列一个数都不用动（训练参数不变、数据仍可比），
     * 视觉层次也更清楚——下面是提示，上面是要找的东西。
     * 尺寸只从 0.72 降到 0.55，符号在屏幕上仍有 130px 宽，形状与颜色都看得清。
     */
    this.cueStone = assets.runeStone('triangle', 0x7ff0ff);
    this.cueStone.position.set(0, 0.7, -2.85);
    this.cueStone.scale.setScalar(0.55);
    this.root.add(this.cueStone);

    // 点光衰减是平方反比：这盏灯离提示石只有 0.55m，强度必须按"距离平方"折算。
    // 第一版给了 12，等效照度 ≈ 40，整块符文石直接烧成白板，符号完全看不见。
    this.cueLight = new THREE.PointLight(0x7ff0ff, 1.6, 4, 2);
    this.cueLight.position.set(0, 0.7, -2.3);
    this.root.add(this.cueLight);

    // 符文石对象池（最多 14 个）
    for (let i = 0; i < 14; i++) {
      const s = assets.runeStone('triangle', 0x7ff0ff);
      s.visible = false;
      const hb = this.makeHitbox(s, { box: [0.92, 1.05, 0.5] });
      s.add(hb);
      s.userData.hitbox = hb;
      this.root.add(s);
      this.stones.push(s);
    }

    this._slots = beamSlots();
    this._startTrial();
  }

  _startTrial() {
    const p = this.params;
    const count = Math.round(p.count);

    // 目标必须能取到 RUNE_SHAPES 的**全部** 8 个形状。
    // 这里原来写死 `* 6`，于是 cross / moon 永远只当干扰项、从不当目标 ——
    // 8 个符号里有 2 个孩子永远不用去找，而画面上完全看不出异常。
    this.target = {
      shape: RUNE_SHAPES[Math.floor(Math.random() * RUNE_SHAPES.length)],
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    };

    // 提示台
    this._dress(this.cueStone, this.target.shape, this.target.color.hex);
    this.cueStone.visible = true;
    this.cueLight.color.setHex(this.target.color.hex);
    this.cueLight.intensity = 1.8;

    // 候选位随机取样
    const slots = this._slots.slice();
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }

    const targetIdx = Math.floor(Math.random() * count);
    this.active = [];
    for (let i = 0; i < count; i++) {
      const s = this.stones[i];
      const slot = slots[i % slots.length];
      s.position.copy(slot.pos);
      s.rotation.set(0, -slot.yaw, 0);
      s.scale.setScalar(0.001);
      s.visible = false;

      let shape, color;
      if (i === targetIdx) {
        shape = this.target.shape;
        color = this.target.color;
      } else {
        // 干扰项：高难度下与目标同色，只能靠形状区分（联合搜索）
        const sameColor = Math.random() < p.sameColor;
        color = sameColor ? this.target.color
          : PALETTE[Math.floor(Math.random() * PALETTE.length)];
        do {
          shape = RUNE_SHAPES[Math.floor(Math.random() * RUNE_SHAPES.length)];
        } while (shape === this.target.shape && color === this.target.color);
      }
      this._dress(s, shape, color.hex);
      s.userData.isTarget = i === targetIdx;
      s.userData.flickerPhase = Math.random() * 6.28;
      // 只有一部分干扰项闪烁，随机分布才有"抢注意力"的效果
      s.userData.flickerAmp = (i !== targetIdx && Math.random() < 0.45) ? p.flicker : 0;
      s.userData.bobPhase = Math.random() * 6.28;
      this.active.push(s);
    }

    this.keepCue = Math.random() < p.keepCue;
    this.timeLimit = p.timeLimit;
    this.phase = 'cue';
    this.phaseT = 0;
    this.trialLevel = this.adaptive.level;
    this.hitboxes.length = 0;
  }

  _dress(stone, shape, colorHex) { dressRune(this.ctx.assets, stone, shape, colorHex); }

  _enterSearch() {
    this.phase = 'search';
    this.phaseT = 0;
    this.searchStart = this.elapsed;
    this.hitboxes = this.active.map((s) => s.userData.hitbox);
    for (const s of this.active) s.visible = true;
    if (!this.keepCue) this.cueStone.visible = false;
    this.ctx.audio.select();
  }

  _finishTrial(result, stone) {
    const { fx, audio, input } = this.ctx;
    const rt = (this.elapsed - this.searchStart) * 1000;
    this.hitboxes.length = 0;
    this.phase = 'feedback';
    this.phaseT = 0;

    if (result === 'correct') {
      this.correctCount++;
      const gained = this.addScore(14);
      this.logTrial({ kind: 'search', responded: true, correct: true, rt, level: this.trialLevel });
      this.adaptive.record(true);
      fx.burst(stone.position, { color: stone.userData.color, count: 30, speed: 3.2, size: 0.6 });
      fx.ring(stone.position, { color: stone.userData.color, from: 0.3, to: 2.2, ttl: 0.5 });
      fx.floatText(stone.position, `+${gained}`, { color: '#8ff6ff', scale: 0.4 });
      audio.hit(this.streak);
      input.pulseAll(0.6, 40);
      // 干扰项收起
      for (const s of this.active) if (s !== stone) s.userData.fading = true;
    } else if (result === 'wrong') {
      this.wrongCount++;
      this.score = Math.max(0, this.score - 4);
      this.logTrial({ kind: 'search', responded: true, correct: false, rt, level: this.trialLevel });
      this.adaptive.record(false);
      fx.burst(stone.position, { color: 0xff6b7d, count: 12, speed: 2, size: 0.45, ttl: 0.5 });
      fx.floatText(stone.position, '再看看', { color: '#ff8f9c', scale: 0.34 });
      audio.commission();
      input.pulseAll(0.85, 80);
      stone.userData.shake = 0.4;
      // 把正确答案点出来，避免孩子带着错误印象进入下一题
      const t = this.active.find((s) => s.userData.isTarget);
      if (t) {
        fx.ring(t.position, { color: t.userData.color, from: 0.3, to: 1.8, ttl: 0.8 });
        t.userData.highlight = 0.9;
      }
      for (const s of this.active) if (!s.userData.isTarget) s.userData.fading = true;
    } else {
      this.timeouts++;
      this.logTrial({ kind: 'search', responded: false, correct: false, rt: null, level: this.trialLevel });
      this.adaptive.record(false);
      audio.omission();
      const t = this.active.find((s) => s.userData.isTarget);
      if (t) {
        fx.ring(t.position, { color: t.userData.color, from: 0.3, to: 2.0, ttl: 0.9 });
        fx.floatText(t.position, '在这里', { color: '#ffd36e', scale: 0.34 });
        t.userData.highlight = 0.9;
      }
      for (const s of this.active) if (!s.userData.isTarget) s.userData.fading = true;
    }
  }

  update(dt) {
    this.elapsed += dt;
    this.phaseT += dt;
    const t = this.elapsed;

    if (this.phase === 'cue') {
      const k = Math.min(1, this.phaseT / 0.35);
      this.cueStone.scale.setScalar(0.33 + 0.22 * (1 - Math.pow(1 - k, 3)));
      this.cueStone.rotation.y = Math.sin(t * 1.4) * 0.2;
      this.cueLight.intensity = 1.5 + Math.sin(t * 6) * 0.6;
      if (this.phaseT > 1.15) this._enterSearch();
    } else if (this.phase === 'search') {
      const { hovered, presses } = this.readPointers();

      for (const s of this.active) {
        const u = s.userData;
        const grow = Math.min(1, this.phaseT / 0.3);
        let scale = 0.78 * (1 - Math.pow(1 - grow, 3));
        // 闪烁干扰：亮度与尺寸同步脉冲，模拟外源性注意捕获
        if (u.flickerAmp > 0) {
          const f = Math.sin(t * (5.5 + u.flickerAmp * 3) + u.flickerPhase);
          s.userData.symbol.material.opacity = 1;
          // 闪烁强度是有上限的：干扰项要"抢眼"，但不能亮到盖掉自己的符号 ——
          // 那样孩子就不是在抑制干扰，而是在猜一个看不清的东西
          u.halo.material.opacity = 0.2 + Math.max(0, f) * 0.5 * u.flickerAmp;
          scale *= 1 + Math.max(0, f) * 0.08 * u.flickerAmp;
        } else {
          u.halo.material.opacity = 0.24;
        }
        if (hovered.has(s)) scale *= 1.12;
        s.scale.setScalar(scale);
        s.position.y += Math.sin(t * 1.1 + u.bobPhase) * 0.06 * dt;
      }

      for (const press of presses) {
        if (!press.target) continue;
        this._finishTrial(press.target.userData.isTarget ? 'correct' : 'wrong', press.target);
        break;
      }

      if (this.phase === 'search' && this.phaseT > this.timeLimit) this._finishTrial('timeout');
    } else if (this.phase === 'feedback') {
      for (const s of this.active) {
        const u = s.userData;
        if (u.fading) {
          s.scale.multiplyScalar(Math.max(0.001, 1 - dt * 5));
          if (s.scale.x < 0.02) { s.visible = false; u.fading = false; }
        }
        if (u.shake > 0) {
          u.shake -= dt;
          s.position.x += Math.sin(t * 60) * 0.012;
        }
        if (u.highlight > 0) {
          u.highlight -= dt;
          u.halo.material.opacity = 0.3 + Math.abs(Math.sin(t * 9)) * 0.7;
          s.scale.setScalar(0.78 + Math.abs(Math.sin(t * 9)) * 0.14);
        }
      }
      if (this.phaseT > 0.95) {
        for (const s of this.active) { s.visible = false; s.userData.highlight = 0; }
        this.trialIndex++;
        if (this.elapsed < this.duration - 1.5) this._startTrial();
        else this.phase = 'idle';
      }
    }

    this.cueStone.rotation.y = Math.sin(t * 1.2) * 0.18;
    this.pedestal.rotation.y += dt * 0.25;

    if (this.elapsed >= this.duration) this.finished = true;
  }
}
