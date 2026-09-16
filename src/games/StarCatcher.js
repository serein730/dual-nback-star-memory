import * as THREE from 'three';
import { MiniGame } from './MiniGame.js';
import { Adaptive } from '../core/Adaptive.js';

/**
 * 星海捕手 —— Go / No-Go 范式。
 *
 * 持续注意（sustained attention）与反应抑制（inhibitory control）是 ADHD 训练里
 * 被验证最多的两个靶点，CPT 类任务是它们的标准载体。这里把 CPT 做成一个
 * "接水晶、躲陨石"的射击场：
 *
 *   Go   信号 = 蓝色水晶簇 → 必须出手（漏掉 = omission，走神指标）
 *   NoGo 信号 = 红色尖刺陨石 → 必须忍住（打了 = commission，冲动指标）
 *
 * 高难度下引入"伪装陨石"：一部分陨石以水晶外形出现，飞过"显形线"才炸开外壳。
 * 这一步很关键 —— 它把任务从"看颜色的条件反射"逼回"必须持续监控"，
 * 否则孩子几个回合就会形成自动化反应，训练强度归零。
 */

/**
 * 伪装陨石的显形线：越过这个深度，伪装必然脱落，而且这条线是**看得见的**（琥珀色光门）。
 *
 * 初版是在 -6.5 ~ -3.5 之间随机现原形，有两个毛病：
 *   ① 等太久 —— 中等难度下要等 2.7 秒才炸壳，主观上就是"过了半天才变"；
 *   ② 规则不可学 —— 最晚的那批已经越过捕获门（z=-4.2）才现原形，孩子无从知道
 *      "什么时候可以放心出手"，只能凭猜。那练的是赌运气，不是抑制控制。
 * 改成固定深度 + 一道可见的门之后：等待缩短约 20%、现原形后的反应余量增加约 40%，
 * 而且"过门前忍住、过门后判断"成为一条能学会的规则。
 *
 * 导出是给关卡演示（`core/Demo.js`）用的：演示里那道琥珀光门必须和真关卡在同一个深度，
 * 否则孩子在演示里学到的是一条在真关卡里不成立的规则。
 */
export const REVEAL_Z = -7.6;

export class StarCatcher extends MiniGame {
  static meta = {
    id: 'catcher',
    name: '星海捕手',
    skill: '持续注意 · 反应抑制',
    blurb: '接住蓝水晶，忍住不碰红陨石',
    color: '#4de2ff',
    duration: 48,
    howto: [
      ['1', '瞄准飞来的蓝色水晶，点击 / 扣扳机把它收进来'],
      ['2', '红色尖刺陨石不要碰，看到了就忍住不出手'],
      ['3', '有些陨石会伪装成水晶，穿过琥珀色光门才现原形 —— 过门之前别急着出手'],
    ],
  };

  constructor(ctx) {
    super(ctx);
    this.adaptive = new Adaptive({ start: 0.2, upAt: 0.85, downAt: 0.58, window: 8 });
    this.actives = [];
    this.spawnTimer = 0.8;
    this.pool = { crystals: [], hazards: [] };
    this.hits = 0;
    this.commissions = 0;
    this.omissions = 0;
  }

  get params() {
    return this.adaptive.map({
      speed: [2.5, 6.0],
      interval: [1.35, 0.52],
      nogoRatio: [0.2, 0.44],
      lateral: [0.0, 1.15],
      disguise: [0.0, 0.6],
    });
  }

  get difficultyLabel() { return this.adaptive.describe(); }

  enter() {
    super.enter();
    const { assets } = this.ctx;

    // 目标对象池：运行期不再 new 几何体，避免命中高峰时的分配抖动
    for (let i = 0; i < 10; i++) {
      const c = assets.crystalCluster('go');
      c.visible = false;
      const hb = this.makeHitbox(c, { radius: 0.78 });
      c.add(hb);
      c.userData.hitbox = hb;
      this.root.add(c);
      this.pool.crystals.push(c);

      const z = assets.hazard();
      z.visible = false;
      const hb2 = this.makeHitbox(z, { radius: 0.66 });
      z.add(hb2);
      z.userData.hitbox = hb2;
      this.root.add(z);
      this.pool.hazards.push(z);
    }

    // 前方的"捕获门"：给孩子一个明确的空间靶区，也是 VR 里的深度参照
    // 半径按桌面视场角反推：z=-4.2 处垂直半视野约 2.5m，取 1.95 才能整圈都在画面里
    const gate = new THREE.Mesh(
      new THREE.TorusGeometry(1.95, 0.028, 10, 96),
      new THREE.MeshBasicMaterial({
        color: 0x4de2ff, transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }),
    );
    gate.position.set(0, 1.72, -4.2);
    this.root.add(gate);
    this.gate = gate;

    // 显形线：伪装陨石穿过它就现原形。压扁成椭圆是为了贴合视野形状 ——
    // 正圆的下半圈会插进观星台里，看着像半道门。
    const veil = new THREE.Mesh(
      new THREE.TorusGeometry(3.2, 0.055, 8, 96),
      new THREE.MeshBasicMaterial({
        color: 0xffa53d, transparent: true, opacity: 0.32,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }),
    );
    veil.position.set(0, 1.72, REVEAL_Z);
    veil.scale.set(1, 0.62, 1);
    this.root.add(veil);
    this.veil = veil;
    this.veilPulse = 0;
  }

  _take(kind) {
    const pool = kind === 'go' ? this.pool.crystals : this.pool.hazards;
    return pool.find((o) => !o.visible) || null;
  }

  _spawn() {
    const { assets } = this.ctx;
    const p = this.params;
    const isNoGo = Math.random() < p.nogoRatio;
    const disguised = isNoGo && Math.random() < p.disguise;

    const kind = isNoGo ? 'nogo' : 'go';
    // 伪装陨石先借用水晶外壳出场
    const shellKind = disguised ? 'go' : kind;
    const obj = this._take(shellKind);
    if (!obj) return;

    // 每次投放都重抽形态。池对象是复用的 —— 只在建池时随机的话，
    // 整局看到的就是那 10 个固定模型在转，这正是"每次玩起来一样"的来源
    if (shellKind === 'go') assets.varyCrystal(obj);
    else assets.varyHazard(obj);

    const x = (Math.random() * 2 - 1) * 2.7;
    const y = 1.0 + Math.random() * 1.5;
    obj.position.set(x, y, -17);
    obj.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    obj.scale.setScalar(0.001);
    obj.visible = true;

    const speed = p.speed * (0.88 + Math.random() * 0.28);
    const entry = {
      obj,
      shell: obj,
      kind,
      disguised,
      revealed: !disguised,
      // 固定在显形线上，不再随机：分界必须可预期，孩子才学得到"过门再出手"
      revealAt: REVEAL_Z,
      speed,
      lateral: (Math.random() * 2 - 1) * p.lateral,
      phase: Math.random() * 6.28,
      baseX: x,
      spawnAt: this.elapsed,
      activeAt: null,
      resolved: false,
      level: this.adaptive.level,
      dying: 0,
    };
    this.actives.push(entry);
    this.hitboxes.push(obj.userData.hitbox);
  }

  /** 伪装陨石现原形：换壳 + 一圈警示波纹。 */
  _reveal(e) {
    const { fx, audio } = this.ctx;
    const hazard = this._take('nogo');
    if (!hazard) { e.revealed = true; return; }
    this.ctx.assets.varyHazard(hazard);
    hazard.position.copy(e.obj.position);
    hazard.rotation.copy(e.obj.rotation);
    hazard.scale.copy(e.obj.scale);
    hazard.visible = true;

    this._release(e.obj);
    const idx = this.hitboxes.indexOf(e.obj.userData.hitbox);
    if (idx >= 0) this.hitboxes.splice(idx, 1);

    e.obj = hazard;
    e.revealed = true;
    this.hitboxes.push(hazard.userData.hitbox);

    fx.ring(hazard.position, { color: 0xff5c6c, from: 0.4, to: 1.9, ttl: 0.45 });
    fx.burst(hazard.position, { color: 0xff8a5c, count: 10, speed: 2.2, ttl: 0.45, size: 0.4 });
    audio.commission(THREE.MathUtils.clamp(hazard.position.x / 4, -1, 1) * 0.6);
    // 整道门跟着闪一下：把"过了这条线才现原形"变成看得见的因果，而不是要孩子自己总结
    this.veilPulse = 1;
  }

  _release(obj) {
    obj.visible = false;
    obj.scale.setScalar(0.001);
  }

  _remove(e) {
    const idx = this.hitboxes.indexOf(e.obj.userData.hitbox);
    if (idx >= 0) this.hitboxes.splice(idx, 1);
    this._release(e.obj);
    const i = this.actives.indexOf(e);
    if (i >= 0) this.actives.splice(i, 1);
  }

  _resolveHit(e, pointer, point) {
    const { fx, audio, input } = this.ctx;
    const pan = THREE.MathUtils.clamp(e.obj.position.x / 4, -1, 1) * 0.7;
    const rt = e.activeAt !== null ? (this.elapsed - e.activeAt) * 1000 : null;
    e.resolved = true;

    if (e.kind === 'go') {
      this.hits++;
      const gained = this.addScore(10);
      this.logTrial({ kind: 'go', responded: true, correct: true, rt, level: e.level });
      this.adaptive.record(true);

      fx.burst(point || e.obj.position, { color: 0x7fe4ff, count: 30, speed: 3.6, size: 0.62 });
      fx.ring(e.obj.position, { color: 0x9ff0ff, from: 0.3, to: 2.4, ttl: 0.5 });
      fx.floatText(e.obj.position, `+${gained}`, { color: '#8ff6ff', scale: 0.42 });
      if (this.streak > 0 && this.streak % 5 === 0) {
        fx.floatText(
          new THREE.Vector3(e.obj.position.x, e.obj.position.y + 0.55, e.obj.position.z),
          `连击 ${this.streak}!`, { color: '#6bffb0', scale: 0.36, ttl: 1.3 },
        );
        audio.levelUp();
      }
      audio.hit(this.streak, pan);
      input.pulse(pointer, 0.55, 40);
      e.dying = 0.28;
    } else {
      this.commissions++;
      this.score = Math.max(0, this.score - 5);
      this.logTrial({ kind: 'nogo', responded: true, correct: false, rt, level: e.level });
      this.adaptive.record(false);

      fx.burst(point || e.obj.position, {
        color: 0xff6b7d, count: 14, speed: 2.4, size: 0.5, ttl: 0.6,
      });
      fx.floatText(e.obj.position, '忍住呀', { color: '#ff8f9c', scale: 0.36 });
      audio.commission(pan);
      input.pulse(pointer, 0.9, 90);
      e.dying = 0.34;
      this.ctx.onEvent?.({ type: 'commission' });
    }
  }

  update(dt) {
    this.elapsed += dt;
    const p = this.params;

    // 投放
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.elapsed < this.duration - 1.2) {
      this.spawnTimer = p.interval * (0.82 + Math.random() * 0.4);
      this._spawn();
    }

    const { hovered, presses } = this.readPointers();

    // 命中判定（先于位移，保证点击的是玩家看到的那一帧位置）
    for (const press of presses) {
      const e = this.actives.find((a) => a.obj === press.target && !a.resolved && a.dying === 0);
      if (e) this._resolveHit(e, press.pointer, press.point);
    }

    const t = this.elapsed;
    for (let i = this.actives.length - 1; i >= 0; i--) {
      const e = this.actives[i];
      const o = e.obj;

      if (e.dying > 0) {
        e.dying -= dt;
        o.scale.multiplyScalar(Math.max(0.0001, 1 - dt * 7));
        o.rotation.y += dt * 9;
        if (e.dying <= 0) this._remove(e);
        continue;
      }

      o.position.z += e.speed * dt;

      // 出场缩放（弹性），避免目标"啪"地凭空出现造成惊吓
      const age = t - e.spawnAt;
      const grow = Math.min(1, age / 0.45);

      // 逃逸淡出：目标不能真的"穿过玩家的脑袋"飞走。
      // 桌面上，一块贴到镜头前的加色光晕会糊掉半个屏幕；
      // VR 里更严重 —— 物体从眼前 20cm 处掠过是实打实的不适感，
      // 这是 XR 内容里最常见也最容易被忽略的舒适度问题之一。
      const escape = THREE.MathUtils.clamp((o.position.z + 1.4) / 2.0, 0, 1);
      const s = 0.62 * (1 + 0.25 * Math.sin(grow * Math.PI)) * grow * (1 - escape * 0.88);
      o.scale.setScalar(Math.max(0.001, s));
      o.position.x = e.baseX + Math.sin(t * 1.6 + e.phase) * e.lateral;
      o.position.y += Math.sin(t * 2.1 + e.phase) * 0.12 * dt;
      o.rotation.y += dt * (o.userData.spin || 0.6);
      o.rotation.x += dt * 0.22;

      // 光晕随距离呼吸
      const halo = o.userData.halo;
      if (halo) {
        const base = e.kind === 'nogo' && e.revealed ? 0.5 : 0.55;
        halo.material.opacity = (base + Math.sin(t * 4 + e.phase) * 0.16) * (1 - escape);
      }

      // 进入响应窗口：开始计反应时
      if (e.activeAt === null && o.position.z > -9) e.activeAt = t;

      // 伪装陨石现原形
      if (!e.revealed && o.position.z > e.revealAt) this._reveal(e);

      // 悬停高亮：告诉孩子"你正瞄着它"
      const isHover = hovered.has(o);
      const targetScale = isHover ? 1.16 : 1;
      o.userData.hoverK = THREE.MathUtils.lerp(o.userData.hoverK ?? 1, targetScale, dt * 12);
      o.scale.multiplyScalar(o.userData.hoverK);

      // 越过玩家：结算未反应的试次（在到达头部之前就收掉）
      if (o.position.z > 0.6) {
        if (!e.resolved) {
          if (e.kind === 'go') {
            this.omissions++;
            this.logTrial({ kind: 'go', responded: false, correct: false, rt: null, level: e.level });
            this.adaptive.record(false);
            this.ctx.audio.omission();
            this.ctx.onEvent?.({ type: 'omission' });
          } else {
            this.logTrial({ kind: 'nogo', responded: false, correct: true, rt: null, level: e.level });
            this.adaptive.record(true);
            // 飘字放回舒适距离：此时物体已经贴到玩家脸上，就地生成的文字会大到糊屏
            this.ctx.fx.floatText(
              new THREE.Vector3(o.position.x * 0.6, o.position.y, -2.4),
              '忍住了 +3', { color: '#6bffb0', scale: 0.32, ttl: 0.9 },
            );
            this.addScore(3);
          }
        }
        this._remove(e);
      }
    }

    // 捕获门跟着专注度呼吸
    const att = this.ctx.bci.attention / 100;
    this.gate.material.opacity = 0.16 + att * 0.3;
    this.gate.scale.setScalar(1 + Math.sin(t * 1.4) * 0.02 + att * 0.05);
    this.gate.rotation.z += dt * 0.12;

    // 显形线：常态是一圈暗琥珀，有伪装脱落时整环亮一下
    this.veilPulse = Math.max(0, this.veilPulse - dt * 2.2);
    this.veil.material.opacity = 0.3 + Math.sin(t * 1.1) * 0.06 + this.veilPulse * 0.5;
    this.veil.scale.set(1 + this.veilPulse * 0.05, 0.62 * (1 + this.veilPulse * 0.05), 1);

    if (this.elapsed >= this.duration) this.finished = true;
  }
}
