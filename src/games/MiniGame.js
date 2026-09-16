import * as THREE from 'three';

/**
 * 迷你游戏基类。
 *
 * 约定：每一关都是一个"试次生成器"——它负责投放刺激、判定反应、把每一个试次
 * 交给 Metrics 记账，并把难度反馈给 Adaptive。关卡自己不管分数展示、不管场景、
 * 不管输入设备差异，这些都由外层提供。
 */

const HITBOX_MAT = new THREE.MeshBasicMaterial({
  transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
});

export class MiniGame {
  /** @param {object} ctx { scene, assets, fx, audio, metrics, bci, world, input, camera } */
  constructor(ctx) {
    this.ctx = ctx;
    this.root = new THREE.Group();
    this.hitboxes = [];
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.elapsed = 0;
    this.finished = false;
    this.recent = [];       // 最近 12 次对错，用于给脑电模拟提供表现上下文
  }

  get meta() { return this.constructor.meta; }
  get duration() { return this.meta.duration; }

  enter() { this.ctx.scene.add(this.root); }

  /**
   * 退出关卡时释放"只属于这一关"的 GPU 资源。
   * 判据是"是否在 Assets 的共享注册表里"——共享的几何/材质要留给下一关继续用，
   * 关卡自己 new 出来的（判定盒、符文石的独立符号材质、柱体玻璃材质…）必须回收。
   * 不做这件事的话，来回重玩几轮就会稳定地漏显存。
   */
  exit() {
    const { scene, assets } = this.ctx;
    scene.remove(this.root);
    const keepGeo = new Set(Object.values(assets.geo));
    this.root.traverse((o) => {
      if (o.geometry && !keepGeo.has(o.geometry)) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        if (m === HITBOX_MAT || assets.isShared(m)) continue;
        assets.untrack(m);
        m.dispose();
      }
    });
    this.root.clear();
    this.hitboxes.length = 0;
  }

  /** 生成一个不可见但可命中的包围球/盒。儿童的瞄准精度有限，判定盒必须比外观大一圈。 */
  makeHitbox(owner, { radius = 0.7, box = null } = {}) {
    const geo = box
      ? new THREE.BoxGeometry(box[0], box[1], box[2])
      : new THREE.SphereGeometry(radius, 10, 8);
    const m = new THREE.Mesh(geo, HITBOX_MAT);
    m.userData.owner = owner;
    m.userData.disposable = true;
    return m;
  }

  /**
   * 解析本帧所有指针：返回 { hovered:Set, presses:[{pointer, target, point}] }。
   * 桌面鼠标和 XR 手柄在这里合流，之后的逻辑完全一致。
   */
  readPointers() {
    const { input } = this.ctx;
    const hovered = new Set();
    const presses = [];
    for (const p of input.active()) {
      const hits = p.raycaster.intersectObjects(this.hitboxes, false);
      const hit = hits[0];
      if (hit) {
        const owner = hit.object.userData.owner;
        hovered.add(owner);
        input.setBeam(p, hit.distance, hit.point);
        if (p.pressed) presses.push({ pointer: p, target: owner, point: hit.point });
      } else {
        input.setBeam(p, null, null);
        if (p.pressed) presses.push({ pointer: p, target: null, point: null });
      }
    }
    return { hovered, presses };
  }

  /**
   * 记账一个试次并驱动自适应难度。
   * 额外字段**原样透传**给 `Metrics.addTrial`（测评档要写 block / half / anticipatory）——
   * 所以这里不能再解构成固定的几个参数，否则新字段会被静默吃掉，
   * 而这类丢失在报告上表现为"某个指标永远是 0"，不会有任何报错。
   */
  logTrial(t) {
    const { correct } = t;
    this.ctx.metrics.addTrial({ game: this.meta.id, rt: null, level: 0, ...t });
    // 把试次打到原始波形上（真机源才会真的发出去，见 Game._mark）。
    //
    // ⚠️ **故意不带 `label`**：带了就会把波形 marker 列的段标签从 `play:cpt`
    // 改写成 `trial:cpt` 并一直粘着（采集器只在收到 label 时才换段），
    // 于是整段的分段标注被试次事件冲掉。试次要的是"精确时刻"，不是"改段"。
    //
    // 带上 rt 是为了能反推**刺激出现**的时刻：logTrial 是在判定完成时调的，
    // 也就是反应之后；`刺激时刻 = 打点时刻 − rt`，而 rt 是游戏侧精确测的。
    // 做试次锁时平均（ERP）时用得到这一步。
    this.ctx._mark?.('trial', {
      game: this.meta.id,
      detail: { kind: t.kind ?? null, correct: correct ?? null, rt: t.rt ?? null },
    });
    this.recent.push(correct ? 1 : 0);
    if (this.recent.length > 12) this.recent.shift();
    if (correct) { this.streak++; this.bestStreak = Math.max(this.bestStreak, this.streak); }
    else this.streak = 0;
  }

  get recentAccuracy() {
    if (!this.recent.length) return 0.7;
    return this.recent.reduce((a, b) => a + b, 0) / this.recent.length;
  }

  addScore(base) {
    const mult = this.ctx.bci.scoreMultiplier;
    const streakBonus = 1 + Math.min(this.streak, 10) * 0.08;
    const gained = Math.round(base * mult * streakBonus);
    this.score += gained;
    return gained;
  }

  update(/* dt */) {}

  hudState() {
    return {
      title: this.meta.name,
      color: this.meta.color,
      score: this.score,
      streak: this.streak,
      accuracy: this.recentAccuracy,
      timeLeft: Math.max(0, this.duration - this.elapsed),
      duration: this.duration,
      level: this.difficultyLabel || '基础',
    };
  }
}
