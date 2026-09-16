import * as THREE from 'three';
import { UIKit, ICON_COLORS } from '../ui/Panel.js';
import { REVEAL_Z } from '../games/StarCatcher.js';
import { beamSlots, dressRune, PALETTE } from '../games/FocusBeam.js';
import { echoLayout, echoPathRing } from '../games/EchoPath.js';
import { CPT_STAGE } from '../games/CatcherCpt.js';
import { DELAY_STAGE, delayOptionProp, delayJarProp } from '../games/DelayWell.js';
import { UFOV_STAGE, shipGeometry } from '../games/UfovFocus.js';
import { NBACK_STAGE, NBACK_PROTOCOL, NBACK_AUDIO_FREQS, NBACK_AUDIO_LABELS } from '../games/DualNBack.js';
import { UFOV_START_STEPS } from './Adaptive.js';

/**
 * 关卡演示 —— 每一关开打之前，先在同一个 3D 舞台上把规则**演一遍**给孩子看。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【为什么需要它】目标用户里有相当一部分**还不认字**。而在此之前，规则只存在于
 * `meta.howto` 那三行文字里（说明页 `BriefPanel`）—— 对不认字的孩子，那一页等于空白，
 * 他只能靠前十几个试次现场试错。**那十几个试次的数据是废的**，而且它们正好落在
 * 警觉度曲线最前面，会把"开局表现"整体压低。演示不是体验优化，是数据质量问题。
 *
 * 【为什么不是视频】铁律 3：零外部资产。而且 DOM 的 `<video>` 在 WebXR 沉浸式会话里
 * 根本不存在（铁律 2），真播一段视频就等于 VR 端没有演示。所以演示是**程序化动画**：
 * 用关卡真正的那些道具（同一个 `Assets` 工厂出的水晶/陨石/符文石/水晶柱）、
 * 真正的那套布局常量（从各关卡 import，见下），演一遍标准玩法。
 * 附带的好处是它天然跟着画质档降级，也天然是双端同一份。
 *
 * 【怎么说话】三条，都是为"不认字"服务的：
 *   ① **主要靠动作**：一个会移动、会按下去的光标环，把"看→瞄→点"整套动作演出来。
 *      孩子模仿的是动作，不是文字。
 *   ② **辅以四个图标**（`UIKit.icon`）：点 / 别碰 / 看 / 对了。不依赖识字，也不依赖文化。
 *   ③ **文字只给旁边的大人看**：面板上那一行短句是给家长/施测者的，不指望孩子读。
 *
 * 【和关卡的关系 —— 这是最要紧的一条】
 * 演示里的**位置、速度、大小、颜色**全部从关卡文件 import，不在这里重写一份：
 *   `REVEAL_Z`（显形线深度）/ `beamSlots()`（符文石两排候选位）/ `echoLayout()`（六根柱子）
 *   / `CPT_STAGE`（测评档的中轴、速度、尺寸）。
 * 理由很实在：演示教出来的空间感和时间感，孩子会**直接带进正式关卡**。
 * 演示里的门在 -6、真关卡里在 -7.6，孩子学到的"什么时候可以出手"就是错的，
 * 而错的那部分会记进他的反应时里 —— 我们却会把它当成注意力指标。
 *
 * ⚠️ 只有**发光/衰减这类纯观感的每帧曲线**在这里另写了一份（见 echo 脚本的 tick）。
 *    改关卡的视觉时过来看一眼，别让演示里的柱子和真柱子亮得不一样。
 *
 * 【演示不是练习试次】这里**不接受任何输入**：没有 hitbox，孩子点不到演示里的东西。
 * 演示只播放、只能「再看一遍」或「跳过」。真要加可交互的练习块，那是另一件事
 * （对测评档而言还会动施测协议），得单独拍板。
 */

/* ============================ 光标与图标 ============================ */

/** 光标停在目标前方多远（米）。太近会插进目标里，太远看着不像"指着它"。 */
const STANDOFF = 0.55;
const smooth = (k) => k * k * (3 - 2 * k);

/** 飞行道具的默认航道。演示里的水晶/陨石飞得比真关卡慢一点：孩子第一次看，需要时间把动作看清楚。 */
const DEMO_SPEED = 3.2;
const DEMO_FROM = -13;
const LANE_Y = 1.62;

/** 把 `UIKit.icon` 画到离屏画布上转成贴图 —— 世界空间的提示精灵用它。 */
function iconTexture(kind, size = 192) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  UIKit.icon(c.getContext('2d'), kind, size / 2, size / 2, size * 0.33, ICON_COLORS[kind]);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ============================== 导演 ============================== */

export class Demo {
  /** @param {object} ctx { scene, assets, fx, audio, camera } */
  constructor(ctx) {
    this.ctx = ctx;
    this.id = null;
    this.script = null;
    this.t = 0;
    this.finished = true;
    this._active = false;

    // root 只在演示进行时才挂进场景 —— 常驻的话会被坑#37 的"关卡 root 残留"探针
    // 数进去，那条探针就再也说不清了
    this.root = new THREE.Group();
    this.root.name = 'demo';
    this.props = new THREE.Group();
    this.root.add(this.props);

    this.icons = Object.fromEntries(
      Object.keys(ICON_COLORS).map((k) => [k, iconTexture(k)]),
    );
    this._buildCursor();
    this._buildHint();

    this.s = { flyers: [] };
    this.p = {};
    this._ui = { name: '', color: '#4de2ff', icon: 'eye', text: '', step: 0, steps: 1 };
    this._from = new THREE.Vector3();
    this._to = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  /**
   * 光标：一圈加色光环 + 中心亮点。它是这段演示里唯一"代表孩子的手"的东西。
   *
   * 半径 0.28 是量出来的，不是拍的：更小的环（第一版 0.13）会正好落在水晶**里面**，
   * 而水晶本身是一块亮蓝白的自发光体 —— 加色混合的环叠上去就糊没了，
   * 截图上几乎看不出"有个东西在指着它"。做成**把目标圈起来**的准星就没这个问题，
   * 因为环落在目标轮廓与背景的交界上，两边至少有一边是暗的。
   */
  _buildCursor() {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.28, 0.022, 8, 40),
      new THREE.MeshBasicMaterial({
        color: 0x9ff0ff, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false,
      }),
    );
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.034, 12, 8),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.9,
        depthWrite: false, depthTest: false, toneMapped: false,
      }),
    );
    const glow = this.ctx.assets.glowSprite(0x8fe8ff, 0.46, 0.45);
    g.add(ring, dot, glow);
    // 光标必须永远画在最上面：它一旦被水晶挡住，"手指在哪儿"这件事就断了
    g.renderOrder = 997;
    g.visible = false;
    this.root.add(g);
    this.cursor = g;
    this.cursorRing = ring;
    this.cursorDot = dot;
    this._press = 0;
    this._follow = null;
    this._moveT = 0;
    this._moveDur = 0;
  }

  /** 规则图标精灵。深度测试关掉：它是叠在画面上的说明，不参与遮挡。 */
  _buildHint() {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.icons.eye, transparent: true,
      depthWrite: false, depthTest: false, toneMapped: false,
    }));
    s.scale.setScalar(0.44);
    s.renderOrder = 999;
    s.visible = false;
    this.root.add(s);
    this.hint = s;
    this._hintT = 0;
    this._hintTtl = 1;
    this._hintFollow = null;
    this._hintOff = new THREE.Vector3();
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  enter(id) {
    if (this._active) this.exit();
    this.id = id;
    this.script = SCRIPTS[id] || null;
    this.t = 0;
    this._beat = 0;
    this.s = { flyers: [] };
    this.p = {};
    this._follow = null;
    this._moveDur = 0;
    this._press = 0;
    this._hintT = 0;
    this._hintFollow = null;
    // 光标先摆在一个中性位置。不给初值的话它停在原点（玩家脚下），
    // 第一次 moveTo 看起来就是"有个东西从地板飞上来"
    this.cursor.position.set(0, 1.35, -2.3);
    this.cursor.visible = false;
    this.hint.visible = false;
    // 没写脚本的关卡（将来新加的）直接判完成，Game 会立刻走到下一步。
    // 宁可没有演示，也不要卡在一个空舞台上。
    this.finished = !this.script;
    if (!this.script) return;
    this._active = true;
    this.script.build(this);
    this.ctx.scene.add(this.root);
  }

  /** 「再看一遍」：整段重建而不是把时间轴倒回去 —— 状态一定干净，代价只是一次重建。 */
  replay() {
    const id = this.id;
    this.exit();
    this.enter(id);
  }

  /**
   * 回收判据与 `MiniGame.exit()` 完全一致（坑#7）：在 `assets.geo` / `assets._shared`
   * 里的留着给下一关用，演示自己 new 的（光门、显形线、地面环、提示台、
   * 符文石的独立符号材质…）必须 dispose。
   * 光标与提示精灵挂在 root 上而不是 props 上，所以不会被这里回收掉。
   */
  exit() {
    if (!this._active) return;
    this._active = false;
    this.finished = true;
    this.ctx.scene.remove(this.root);

    const { assets } = this.ctx;
    const keepGeo = new Set(Object.values(assets.geo));
    this.props.traverse((o) => {
      if (o.geometry && !keepGeo.has(o.geometry)) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        if (assets.isShared(m)) continue;
        assets.untrack(m);
        m.dispose();
      }
    });
    this.props.clear();
    this.s = { flyers: [] };
    this.p = {};
  }

  /** 面板读的状态。字幕按时间挑，切换时才会让面板重绘（坑#9 由面板那边比对）。 */
  get uiState() {
    const u = this._ui;
    const caps = this.script?.captions;
    if (!caps || !caps.length) return u;
    let i = 0;
    while (i + 1 < caps.length && caps[i + 1].at <= this.t) i++;
    u.icon = caps[i].icon;
    u.text = caps[i].text;
    u.step = i;
    u.steps = caps.length;
    return u;
  }

  setGame(meta) {
    this._ui.name = meta.name;
    this._ui.color = meta.color;
  }

  /* ------------------------------ 脚本 API ------------------------------ */

  /** 加一圈加色圆环（捕获门 / 显形线都是这个）。squash 用来把正圆压成贴合视野的椭圆。 */
  torus(radius, tube, color, opacity, { y = 1.72, z = 0, squash = 1 } = {}) {
    const m = new THREE.Mesh(
      new THREE.TorusGeometry(radius, tube, 10, 96),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }),
    );
    m.position.set(0, y, z);
    m.scale.set(1, squash, 1);
    this.props.add(m);
    return m;
  }

  /**
   * 让一个道具朝玩家飞。
   * `atZ/onZ` 是"飞到某个深度时触发一次"（伪装脱落靠它，和真关卡一样按**空间**判定，
   * 不按时间 —— 按时间的话掉帧就会让它在错误的位置炸壳）。
   *
   * `fadeFrom` 默认 -2.8：道具**不许真的飞到玩家脸上**（坑#11）。桌面上那是一块糊掉
   * 半个屏幕的光晕，VR 里是实打实的不适感 —— 演示是孩子在这个场景里看到的第一样
   * 会动的东西，绝不能是它。
   */
  launch(obj, {
    speed = DEMO_SPEED, from = DEMO_FROM, x = 0, y = LANE_Y, scale = 0.62,
    endZ = -0.9, fadeFrom = -2.8, atZ = null, onZ = null, onEnd = null,
  } = {}) {
    obj.position.set(x, y, from);
    obj.rotation.set(0, 0, 0);
    obj.scale.setScalar(scale);
    obj.visible = true;
    const f = { obj, speed, endZ, fadeFrom, atZ, onZ, onEnd, scale };
    this.s.flyers.push(f);
    return f;
  }

  /** 提前收起一个飞行道具（被"接住"了）。 */
  drop(obj) {
    const i = this.s.flyers.findIndex((f) => f.obj === obj);
    if (i >= 0) this.s.flyers.splice(i, 1);
    obj.visible = false;
  }

  showCursor(v = true) { this.cursor.visible = v; }

  /** 光标跟住一个道具（目标在动的时候用这个，写死坐标会看着像"指偏了"）。 */
  follow(obj, off = null) {
    this._follow = obj ? { obj, off } : null;
    if (obj) this._moveDur = 0;
  }

  /** 光标平滑移到一个固定点。 */
  moveTo(pos, dur = 0.8) {
    this._follow = null;
    this._from.copy(this.cursor.position);
    this._to.copy(pos);
    this._moveT = 0;
    this._moveDur = dur;
  }

  /** 按下去。默认发的是界面确认音，各脚本自己决定要不要再补关卡音效。 */
  press() {
    this._press = 0.34;
    this.ctx.audio.select();
    this.ctx.fx.ring(this.cursor.position, {
      color: 0x9ff0ff, from: 0.1, to: 0.62, ttl: 0.34,
    });
  }

  /**
   * 弹一个规则图标。给了 follow 就跟着那个道具走。
   * 偏移对"跟随"和"定点"两种都生效，默认往上抬 0.62m —— 图标要是和光标叠在同一点，
   * 屏幕上就成了"一个环里套着一个勾"的怪东西，两个符号互相吃掉对方。
   */
  showHint(kind, pos, { ttl = 1.9, follow = null, off = null } = {}) {
    this.hint.material.map = this.icons[kind];
    this.hint.material.needsUpdate = true;
    if (off) this._hintOff.copy(off); else this._hintOff.set(0, 0.62, 0);
    if (pos) this.hint.position.copy(pos).add(this._hintOff);
    this._hintFollow = follow;
    this._hintT = ttl;
    this._hintTtl = ttl;
    this.hint.visible = true;
  }

  /* ------------------------------ 每帧 ------------------------------ */

  update(dt) {
    if (!this._active) return;
    this.t += dt;
    const sc = this.script;

    while (this._beat < sc.beats.length && sc.beats[this._beat].at <= this.t) {
      sc.beats[this._beat++].run(this);
    }

    for (let i = this.s.flyers.length - 1; i >= 0; i--) this._stepFlyer(this.s.flyers[i], dt, i);
    sc.tick?.(this, dt, this.t);

    this._stepCursor(dt);
    this._stepHint(dt);

    if (this.t >= sc.duration) this.finished = true;
  }

  _stepFlyer(f, dt, i) {
    const o = f.obj;
    o.position.z += f.speed * dt;
    o.rotation.y += dt * (o.userData.spin || 0.6);
    o.rotation.x += dt * 0.18;

    if (f.onZ && o.position.z >= f.atZ) { const cb = f.onZ; f.onZ = null; cb(this, f); }

    // 淡出而不是"啪"地消失：突然不见会被读成一次反馈（"是不是我做错了"），
    // 测评档尤其不能有 —— 这条规矩和 CatcherCpt 里那段是同一条
    if (f.fadeFrom != null && o.position.z >= f.fadeFrom) {
      const k = 1 - (o.position.z - f.fadeFrom) / (f.endZ - f.fadeFrom);
      o.scale.setScalar(Math.max(0.001, f.scale * Math.max(0, k)));
    }
    if (o.position.z >= f.endZ) {
      o.visible = false;
      this.s.flyers.splice(i, 1);
      f.onEnd?.(this, f);
    }
  }

  _aim(obj, off, out) {
    out.copy(obj.position);
    if (off) out.add(off);
    this._dir.subVectors(this._camPos, out);
    if (this._dir.lengthSq() > 1e-6) out.addScaledVector(this._dir.normalize(), STANDOFF);
  }

  _stepCursor(dt) {
    const c = this.cursor;
    this._camPos.setFromMatrixPosition(this.ctx.camera.matrixWorld);

    if (this._follow) {
      this._aim(this._follow.obj, this._follow.off, this._to);
      c.position.lerp(this._to, Math.min(1, dt * 5.5));
    } else if (this._moveDur > 0) {
      this._moveT = Math.min(this._moveDur, this._moveT + dt);
      c.position.lerpVectors(this._from, this._to, smooth(this._moveT / this._moveDur));
      if (this._moveT >= this._moveDur) this._moveDur = 0;
    }
    // 光环正对玩家才是个"环"，否则斜看就成了椭圆
    c.lookAt(this._camPos);

    if (this._press > 0) {
      this._press = Math.max(0, this._press - dt);
      const k = 1 - this._press / 0.34;
      const squeeze = 1 - Math.sin(k * Math.PI) * 0.42;
      this.cursorRing.scale.setScalar(squeeze);
      this.cursorDot.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.8);
    } else {
      // 常态下慢慢呼吸一下，不然它看着像一张贴纸
      const b = 1 + Math.sin(this.t * 3.4) * 0.05;
      this.cursorRing.scale.setScalar(b);
      this.cursorDot.scale.setScalar(1);
    }
  }

  _stepHint(dt) {
    if (this._hintT <= 0) { if (this.hint.visible) this.hint.visible = false; return; }
    this._hintT -= dt;
    if (this._hintFollow) {
      this.hint.position.copy(this._hintFollow.position).add(this._hintOff);
    }
    const age = this._hintTtl - this._hintT;
    const fadeIn = Math.min(1, age / 0.16);
    const fadeOut = Math.min(1, this._hintT / 0.4);
    this.hint.material.opacity = Math.min(fadeIn, fadeOut);
    this.hint.scale.setScalar(0.44 * (0.7 + fadeIn * 0.3));
    if (this._hintT <= 0) this.hint.visible = false;
  }
}

/* ============================== 四段脚本 ==============================
 *
 * 每段脚本三部分：
 *   build(d)          搭台（道具都进 d.props，退出时按坑#7 的判据回收）
 *   beats[]           `{ at: 秒, run(d) }`，按时间只触发一次
 *   tick(d, dt, t)    每帧的连续动画
 *   captions[]        `{ at, icon, text }` —— 图标给孩子，文字给旁边的大人
 *
 * 时长都压在 10~16 秒。再长孩子就开始看别处了，而演示本身也会变成一次注意力消耗，
 * 那就和它要服务的目的反着来了。
 */

/* ------------------------------ 星海捕手 ------------------------------ */

const catcherDemo = {
  duration: 15.6,
  captions: [
    { at: 0, icon: 'eye', text: '蓝色水晶：瞄准它，点一下' },
    { at: 4.4, icon: 'stop', text: '红色陨石：忍住，别碰' },
    { at: 9.6, icon: 'eye', text: '有的"水晶"是假的' },
    { at: 11.6, icon: 'stop', text: '穿过金色的门才现原形' },
  ],

  build(d) {
    const { assets } = d.ctx;
    const p = d.p;
    p.crystal = assets.crystalCluster('go');
    p.rock = assets.hazard();
    p.fake = assets.crystalCluster('go');
    p.rock2 = assets.hazard();
    for (const o of [p.crystal, p.rock, p.fake, p.rock2]) {
      o.visible = false;
      d.props.add(o);
    }
    // 捕获门与显形线：深度从关卡文件来，演示和真关卡必须是同一道门
    p.gate = d.torus(1.95, 0.028, 0x4de2ff, 0.26, { z: -4.2 });
    p.veil = d.torus(3.2, 0.055, 0xffa53d, 0.3, { z: REVEAL_Z, squash: 0.62 });
    d.s.veilPulse = 0;
  },

  beats: [
    { at: 0.6, run: (d) => { d.launch(d.p.crystal, { speed: DEMO_SPEED, from: DEMO_FROM }); } },
    { at: 2.2, run: (d) => { d.showCursor(true); d.follow(d.p.crystal); } },
    {
      at: 3.5,
      run: (d) => {
        const o = d.p.crystal, { fx, audio } = d.ctx;
        d.press();
        fx.burst(o.position, { color: 0x7fe4ff, count: 30, speed: 3.6, size: 0.62 });
        fx.ring(o.position, { color: 0x9ff0ff, from: 0.3, to: 2.4, ttl: 0.5 });
        audio.hit(0);
        d.showHint('check', o.position);
        d.drop(o);
        d.follow(null);
      },
    },

    { at: 4.8, run: (d) => { d.launch(d.p.rock, { speed: DEMO_SPEED, from: DEMO_FROM }); } },
    // 光标挪到陨石**旁边**而不是正前方：正前方看着像在瞄准它，那是反着教
    {
      at: 6.0,
      run: (d) => {
        d.follow(d.p.rock, new THREE.Vector3(0.72, 0.3, 0));
        d.showHint('stop', null, { ttl: 2.6, follow: d.p.rock });
      },
    },
    {
      at: 8.7,
      run: (d) => {
        // 忍住了 —— 关卡里这一下是有正反馈的（"忍住了 +3"），演示照给
        d.showHint('check', new THREE.Vector3(0, 1.25, -2.4));
        d.ctx.audio.select();
      },
    },

    { at: 9.8, run: (d) => { d.launch(d.p.fake, {
      speed: DEMO_SPEED, from: DEMO_FROM, atZ: REVEAL_Z, onZ: catcherReveal,
    }); } },
    { at: 10.6, run: (d) => { d.follow(d.p.fake); } },
    {
      at: 14.0,
      run: (d) => {
        d.showHint('check', new THREE.Vector3(0, 1.25, -2.4));
        d.ctx.audio.select();
        d.follow(null);
      },
    },
  ],

  tick(d, dt) {
    d.p.gate.rotation.z += dt * 0.12;
    d.s.veilPulse = Math.max(0, d.s.veilPulse - dt * 2.2);
    d.p.veil.material.opacity = 0.3 + d.s.veilPulse * 0.5;
    d.p.veil.scale.set(1 + d.s.veilPulse * 0.05, 0.62 * (1 + d.s.veilPulse * 0.05), 1);
  },
};

/** 伪装脱落：换壳 + 整道门闪一下 + 光标退开。和 `StarCatcher._reveal()` 是同一场戏。 */
function catcherReveal(d, f) {
  const { fx, audio } = d.ctx;
  const rock = d.p.rock2;
  rock.position.copy(d.p.fake.position);
  rock.rotation.copy(d.p.fake.rotation);
  rock.scale.copy(d.p.fake.scale);
  rock.visible = true;
  d.p.fake.visible = false;
  f.obj = rock;

  fx.ring(rock.position, { color: 0xff5c6c, from: 0.4, to: 1.9, ttl: 0.45 });
  fx.burst(rock.position, { color: 0xff8a5c, count: 10, speed: 2.2, ttl: 0.45, size: 0.4 });
  audio.commission();
  d.s.veilPulse = 1;

  d.follow(rock, new THREE.Vector3(0.78, 0.34, 0));
  d.showHint('stop', null, { ttl: 2.4, follow: rock });
}

/* ------------------------------ 光束聚焦 ------------------------------ */

/**
 * 演示用固定的一题：目标 = 青色六边形。**不随机** —— 演示每次都一样，
 * 大人才能在旁边跟着说"找那个青色的六边形"，而随机题面下这句话每次都得重编。
 */
const BEAM_TARGET = { shape: 'hexagon', color: PALETTE[0].hex };
/**
 * 候选位取自 `beamSlots()`（0~7 是下排、8~14 是上排），挑 7 个铺开两排。
 *
 * ⚠️ **刻意避开 10 / 11 / 12 号位**：舞台灯就在 (0, 2.4, -3.4)，而 11 号位是
 * (0, 2.04, -3.65) —— 相距只有 0.44m，点光是平方反比衰减，等效照度 38.9，
 * 是其它位置（1~3）的十几倍，符文石当场烧成一块白板、符号完全看不出来（坑#6 那一类）。
 * 10 / 12 号位是 9.5，也偏亮。演示的目标一旦落在那儿，孩子就是在"找一个看不清的东西"。
 *
 * （**真关卡的随机取样也会命中这三个位置**，那是一个已存在的问题，不在这次改动范围内 ——
 * 见 `PROGRESS.md` 待确认项。这里只保证演示不踩。）
 */
const BEAM_SLOTS = [2, 5, 6, 7, 8, 9, 13];
/** 目标放上排偏右（slot 13），干扰放下排偏左（slot 2）—— 隔得远，光标那一甩才读得出"不是那个、是这个"。 */
const BEAM_TARGET_AT = 6;
const BEAM_FLICKER_AT = 0;
const BEAM_FILLERS = [
  // 第一个就是闪烁的那颗：**同色异形**。它同时演了两件事 ——
  // "会闪的不一定对"（外源性注意捕获）和"光看颜色不够"（联合搜索）
  { shape: 'triangle', color: PALETTE[0].hex },
  { shape: 'star', color: PALETTE[2].hex },
  { shape: 'diamond', color: PALETTE[1].hex },
  { shape: 'hexagon', color: PALETTE[3].hex },    // 同形异色：只差颜色
  { shape: 'circle', color: PALETTE[2].hex },
  { shape: 'cross', color: PALETTE[1].hex },
];

const beamDemo = {
  duration: 14.4,
  captions: [
    { at: 0, icon: 'eye', text: '先看清下面亮出的符文' },
    { at: 2.6, icon: 'eye', text: '在上面找出一模一样的' },
    { at: 5.6, icon: 'stop', text: '会闪的是干扰，别被带跑' },
    { at: 8.4, icon: 'tap', text: '形状和颜色都一样才对' },
  ],

  build(d) {
    const { assets } = d.ctx;
    const p = d.p;

    // 提示台（矮祭坛）+ 提示石，位置与关卡一致：提示在下、要找的在上
    const pedestal = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.5, 0.13, 24), assets.mat.metalDeep);
    base.position.y = 0.065;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.085, 0.18, 16), assets.mat.metalDeep);
    stem.position.y = 0.22;
    pedestal.add(base, stem);
    pedestal.position.set(0, 0, -2.85);
    d.props.add(pedestal);
    p.pedestal = pedestal;

    p.cue = assets.runeStone(BEAM_TARGET.shape, BEAM_TARGET.color);
    dressRune(assets, p.cue, BEAM_TARGET.shape, BEAM_TARGET.color);
    p.cue.position.set(0, 0.7, -2.85);
    p.cue.scale.setScalar(0.001);
    p.cue.visible = false;
    d.props.add(p.cue);

    p.cueLight = new THREE.PointLight(BEAM_TARGET.color, 0, 4, 2);
    p.cueLight.position.set(0, 0.7, -2.3);
    d.props.add(p.cueLight);

    const slots = beamSlots();
    p.stones = BEAM_SLOTS.map((slotIdx, i) => {
      const isTarget = i === BEAM_TARGET_AT;
      const look = isTarget ? BEAM_TARGET : BEAM_FILLERS[i > BEAM_TARGET_AT ? i - 1 : i];
      const s = assets.runeStone(look.shape, look.color);
      dressRune(assets, s, look.shape, look.color);
      const slot = slots[slotIdx];
      s.position.copy(slot.pos);
      s.rotation.set(0, -slot.yaw, 0);
      s.scale.setScalar(0.001);
      s.visible = false;
      s.userData.isTarget = isTarget;
      s.userData.flicker = i === BEAM_FLICKER_AT;
      d.props.add(s);
      return s;
    });
    d.s.grow = 0;
    d.s.settle = 0;
  },

  beats: [
    {
      at: 0.4,
      run: (d) => {
        d.p.cue.visible = true;
        d.p.cueLight.intensity = 1.6;
        d.showHint('eye', new THREE.Vector3(0, 0.7, -2.85), { ttl: 2.0, off: new THREE.Vector3(0, 0.55, 0) });
        d.ctx.audio.select();
      },
    },
    {
      at: 2.6,
      run: (d) => {
        for (const s of d.p.stones) s.visible = true;
        d.s.grow = 0.001;
        d.ctx.audio.select();
      },
    },
    // 先被闪烁的那颗勾过去 —— 这一下就是要演"注意力被抢走"是什么感觉
    { at: 4.6, run: (d) => { d.showCursor(true); d.moveTo(aimAt(d, d.p.stones[BEAM_FLICKER_AT]), 1.0); } },
    {
      at: 5.9,
      run: (d) => {
        d.showHint('stop', null, { ttl: 2.0, follow: d.p.stones[BEAM_FLICKER_AT], off: new THREE.Vector3(0, 0.62, 0.2) });
      },
    },
    // 再明确地甩到正确的那颗上：孩子看到的是"不是那个 → 是这个"
    { at: 7.4, run: (d) => { d.moveTo(aimAt(d, d.p.stones[BEAM_TARGET_AT]), 1.1); } },
    {
      at: 9.0,
      run: (d) => {
        const t = d.p.stones[BEAM_TARGET_AT], { fx, audio } = d.ctx;
        d.press();
        fx.burst(t.position, { color: BEAM_TARGET.color, count: 30, speed: 3.2, size: 0.6 });
        fx.ring(t.position, { color: BEAM_TARGET.color, from: 0.3, to: 2.2, ttl: 0.5 });
        audio.hit(0);
        // 对勾挪到目标右侧同高：正上方 0.62m 处正好落在字幕条那一片，
        // 而提示精灵是 depthTest:false，会直接画到面板上去（不报错，只是难看）
        d.showHint('check', null, { ttl: 2.4, follow: t, off: new THREE.Vector3(0.62, 0, 0.3) });
        d.s.settle = 1;
      },
    },
  ],

  tick(d, dt, t) {
    // 提示石出场：弹性放大到 0.55（与关卡一致），之后轻轻摆
    if (d.p.cue.visible) {
      d.s.cueK = Math.min(1, (d.s.cueK ?? 0) + dt * 3);
      d.p.cue.scale.setScalar(0.33 + 0.22 * (1 - Math.pow(1 - d.s.cueK, 3)));
      d.p.cue.rotation.y = Math.sin(t * 1.3) * 0.18;
      d.p.cueLight.intensity = 1.5 + Math.sin(t * 6) * 0.5;
    }
    d.p.pedestal.rotation.y += dt * 0.25;

    if (!d.s.grow) return;
    d.s.grow = Math.min(1, d.s.grow + dt * 3.2);
    const base = 0.78 * (1 - Math.pow(1 - d.s.grow, 3));
    for (const s of d.p.stones) {
      const u = s.userData;
      let k = base;
      if (u.flicker && !d.s.settle) {
        const f = Math.max(0, Math.sin(t * 8.2));
        u.halo.material.opacity = 0.2 + f * 0.5;
        k *= 1 + f * 0.08;
      } else {
        u.halo.material.opacity = u.isTarget && d.s.settle
          ? 0.3 + Math.abs(Math.sin(t * 9)) * 0.6 : 0.24;
      }
      // 答对之后其余石头收起来，把画面让给正确答案
      if (d.s.settle && !u.isTarget) {
        u.fade = Math.max(0, (u.fade ?? 1) - dt * 2.2);
        k *= u.fade;
        if (k < 0.02) s.visible = false;
      }
      s.scale.setScalar(Math.max(0.001, k));
    }
  },
};

/** 目标在原地不动时，直接算出光标该停的那个点。 */
function aimAt(d, obj) {
  const out = new THREE.Vector3();
  d._camPos.setFromMatrixPosition(d.ctx.camera.matrixWorld);
  d._aim(obj, null, out);
  return out;
}

/* ------------------------------ 回声之路 ------------------------------ */

/** 演示序列写死。演示每次一样，孩子第二次看才是在"复习规则"而不是"看新题"。 */
const ECHO_SEQ = [1, 4, 2];

const echoDemo = {
  duration: 14.8,
  captions: [
    { at: 0, icon: 'eye', text: '看柱子亮起来的顺序' },
    { at: 3.6, icon: 'tap', text: '轮到你，按一样的顺序点' },
    { at: 9.2, icon: 'check', text: '记对了，下一轮会更长' },
  ],

  build(d) {
    const { assets } = d.ctx;
    d.p.pillars = echoLayout().map((spot, i) => {
      const p = assets.crystalPillar(spot.color);
      p.position.set(spot.x, 0, spot.z);
      p.rotation.y = spot.yaw;
      p.userData.index = i;
      p.userData.glow = 0;
      p.userData.tone = i;
      d.props.add(p);
      return p;
    });
    d.p.path = echoPathRing();
    d.props.add(d.p.path);
    d.s.recall = false;
  },

  beats: [
    { at: 0.5, run: (d) => { d.showHint('eye', new THREE.Vector3(0, 1.55, -3.2), { ttl: 2.2 }); } },
    { at: 1.3, run: (d) => echoLight(d, ECHO_SEQ[0]) },
    { at: 2.0, run: (d) => echoLight(d, ECHO_SEQ[1]) },
    { at: 2.7, run: (d) => echoLight(d, ECHO_SEQ[2]) },

    {
      at: 3.8,
      run: (d) => {
        d.s.recall = true;
        d.ctx.audio.select();
        d.showCursor(true);
        d.moveTo(aimAt(d, gemOf(d, ECHO_SEQ[0])), 0.9);
      },
    },
    { at: 5.0, run: (d) => { d.press(); echoLight(d, ECHO_SEQ[0]); d.moveTo(aimAt(d, gemOf(d, ECHO_SEQ[1])), 0.85); } },
    { at: 6.2, run: (d) => { d.press(); echoLight(d, ECHO_SEQ[1]); d.moveTo(aimAt(d, gemOf(d, ECHO_SEQ[2])), 0.85); } },
    { at: 7.4, run: (d) => { d.press(); echoLight(d, ECHO_SEQ[2]); } },
    {
      at: 8.2,
      run: (d) => {
        const { fx, audio } = d.ctx;
        for (const i of ECHO_SEQ) {
          const p = d.p.pillars[i];
          fx.burst(new THREE.Vector3(p.position.x, 1.3, p.position.z),
            { color: p.userData.color, count: 16, speed: 2.6, size: 0.5 });
        }
        audio.levelUp();
        d.showHint('check', new THREE.Vector3(0, 1.45, -3.2), { ttl: 2.6 });
        d.s.recall = false;
      },
    },
  ],

  /**
   * 柱体发光衰减 —— 这一段是从 `EchoPath.update()` 抄来的**观感副本**（唯一的一处）。
   * 抄而不是共用的理由：那边还纠缠着 hover / 答错抖动 / 错色闪烁，
   * 演示一个都不需要。改关卡的点亮观感时过来对一眼。
   */
  tick(d, dt) {
    for (const p of d.p.pillars) {
      const u = p.userData;
      u.glow = Math.max(0, u.glow - dt * 2.4);
      u.colMat.emissiveIntensity = u.baseIntensity + u.glow;
      u.gem.material.opacity = 0.55 + u.glow * 0.45;
      u.gem.scale.setScalar(1 + u.glow * 0.55);
      u.gem.rotation.y += dt * (0.8 + u.glow * 4);
      u.halo.material.opacity = u.glow * 0.7;
      u.halo.scale.setScalar(1.1 + u.glow * 1.2);
      u.light.intensity = u.glow * 4.5;
    }
    d.p.path.material.opacity = 0.14 + (d.s.recall ? 0.18 : 0);
  },
};

function echoLight(d, idx) {
  const p = d.p.pillars[idx];
  p.userData.glow = 1;
  d.ctx.audio.tone(p.userData.tone, 0.34);
  d.ctx.fx.ring(new THREE.Vector3(p.position.x, 0.04, p.position.z), {
    color: p.userData.color, from: 0.32, to: 1.05, ttl: 0.55,
    lookAt: new THREE.Vector3(p.position.x, 10, p.position.z),
  });
}

/** 光标要指的是柱顶那颗宝石，不是柱子的原点（原点在地面上）。 */
function gemOf(d, idx) {
  const p = d.p.pillars[idx];
  return { position: new THREE.Vector3(p.position.x, p.userData.gem.position.y, p.position.z) };
}

/* --------------------------- 星海捕手 · 测评 --------------------------- */

/**
 * 测评档的演示。和体验档那段是**两段戏**，差别正是这一档存在的理由：
 *   - 刺激走中轴、瞬时全尺寸、速度固定（全部取自 `CPT_STAGE`）；
 *   - 命中确认是**中性**的（灰蓝粒子 + 界面音），Go 和 No-Go 一模一样；
 *   - **不出现空中的对勾**。演示里给一个"你做对了"的符号，孩子就会在正式测评里
 *     等它出现 —— 而那一档整场都不会出现，等于我们亲手制造了一个落差。
 *     规则用禁止符讲，"对了"这件事只留在面板文字里（那是给大人看的）。
 */
const cptDemo = {
  duration: 10.6,
  captions: [
    { at: 0, icon: 'tap', text: '蓝色水晶：出手接住' },
    { at: 3.4, icon: 'stop', text: '红色陨石：忍住，等它飞走' },
    { at: 6.6, icon: 'eye', text: '没有分数，也不告诉你对错' },
  ],

  build(d) {
    const { assets } = d.ctx;
    d.p.crystal = assets.crystalCluster('go');
    d.p.rock = assets.hazard();
    for (const o of [d.p.crystal, d.p.rock]) { o.visible = false; d.props.add(o); }
    // 捕获门保留（VR 里它是深度参照），显形线不建 —— 这一档没有伪装陨石
    d.p.gate = d.torus(1.95, 0.028, 0x4de2ff, 0.22, { y: CPT_STAGE.laneY, z: -4.2 });
  },

  beats: [
    {
      at: 0.5,
      run: (d) => d.launch(d.p.crystal, {
        speed: CPT_STAGE.speed, from: CPT_STAGE.spawnZ, y: CPT_STAGE.laneY,
        scale: CPT_STAGE.scale, endZ: CPT_STAGE.exitZ, fadeFrom: CPT_STAGE.windowZ,
      }),
    },
    { at: 1.0, run: (d) => { d.showCursor(true); d.follow(d.p.crystal); } },
    {
      at: 1.9,
      run: (d) => {
        const o = d.p.crystal;
        d.press();
        // 与 CatcherCpt._respond() 完全同一套中性确认
        d.ctx.fx.burst(o.position, { color: 0x9fb8e6, count: 12, speed: 2.2, size: 0.42, ttl: 0.36 });
        d.drop(o);
        d.follow(null);
      },
    },

    {
      at: 3.8,
      run: (d) => d.launch(d.p.rock, {
        speed: CPT_STAGE.speed, from: CPT_STAGE.spawnZ, y: CPT_STAGE.laneY,
        scale: CPT_STAGE.scale, endZ: CPT_STAGE.exitZ, fadeFrom: CPT_STAGE.windowZ,
      }),
    },
    // 手挪开并停住：这一档要教的"忍住"就是**什么都不做**
    {
      at: 4.3,
      run: (d) => {
        d.moveTo(new THREE.Vector3(-1.15, 1.1, -2.6), 0.8);
        d.showHint('stop', null, { ttl: 2.4, follow: d.p.rock });
      },
    },
  ],

  tick(d, dt) { d.p.gate.rotation.z += dt * 0.08; },
};

/* ------------------------------ 星愿之门 ------------------------------
 *
 * 这一段演示和别的四段有两点根本不同，都直接来自"它教的是一个选择题"：
 *
 * ① **必须两个选项各演一次，而且给完全相同的待遇。**
 *    只演其中一个，就是在教孩子"该选这个" —— 而孩子选什么正是我们要测的量，
 *    等于我们亲手把答案写进了题目。顺序固定小→大（不是随机），
 *    这样每个孩子受到的顺序影响至少是同一个。
 *    ⚠️ 顺序本身仍可能有近因效应（后看到的那个印象更深），**我们没有依据说它多大**，
 *    已写进已知偏离表。
 *
 * ② **长的那个必须真的等满 15 秒。** 这是全项目最反直觉的一段演示 ——
 *    24 秒的演示里有 15 秒什么都不发生。但压缩它就等于骗人：孩子在演示里学到
 *    "等一等大概三秒"，回到正式试次却要等 15 秒，他做的第一个选择就不是知情的选择，
 *    而那个试次的数据我们照样会当成偏好记下来。
 *    这条和 `演示-必须用关卡真常量` 是同一条规矩，只是这里换成了时间。
 *
 * 和 cpt 那段一样：**不出现空中的对勾**。这一关连"对"都不存在。
 */
const delayDemo = {
  /**
   * 26.6 秒，是全项目最长的一段演示，其中 15 秒什么都不发生 —— 见文件头 ②。
   * ⚠️ **这个数必须 ≥ 大奖那次领奖结束的时刻**（10.4 起 + 15 秒等待 + 领奖）。
   * 短了的后果非常隐蔽：演示会在等待中途结束，孩子**永远看不到"等久了真的给两颗"**，
   * 而那恰好是这一关唯一要教的事 —— 画面上只是"演示放完了"，一点异常都看不出来。
   */
  duration: 26.6,
  captions: [
    { at: 0, icon: 'eye', text: '两道星门，看清楚' },
    { at: 1.4, icon: 'eye', text: '左边等一下下，给 1 颗' },
    { at: 2.6, icon: 'tap', text: '右边等久一点，给 2 颗' },
    { at: 4.0, icon: 'tap', text: '先试左边：点一下' },
    { at: 5.6, icon: 'eye', text: '圆点数完，水晶就进罐子' },
    { at: 9.2, icon: 'tap', text: '再试右边：点一下' },
    { at: 11.0, icon: 'eye', text: '圆点多，就要等这么久' },
    { at: 25.6, icon: 'eye', text: '没有对错，你想要哪个都行' },
  ],

  build(d) {
    const { assets } = d.ctx;
    const p = d.p;
    // 关卡的真道具、真位置、真点数（`delayOptionProp` 就是关卡自己用的那一份）
    p.ss = delayOptionProp(assets, DELAY_STAGE.ss);
    p.ll = delayOptionProp(assets, DELAY_STAGE.ll);
    // 演示里左右**固定**（小在左、大在右）：真关卡每次会换边，但演示每次一样，
    // 旁边的大人才能跟着说"左边这道等一下下"。同 beam 固定考青色六边形那条。
    p.ss.group.position.x = -DELAY_STAGE.optX;
    p.ll.group.position.x = DELAY_STAGE.optX;
    for (const o of [p.ss, p.ll]) d.props.add(o.group);

    const jar = delayJarProp(assets, DELAY_STAGE.ss.reward + DELAY_STAGE.ll.reward);
    p.jar = jar.group;
    p.gems = jar.gems;
    p.collected = 0;
    d.props.add(jar.group);
    d.s.drain = null;
  },

  beats: [
    { at: 0.6, run: (d) => { d.showCursor(true); d.moveTo(new THREE.Vector3(0, 1.5, -2.6), 0.7); } },
    // 先分别指一下两道门，让"两个选项"这件事本身先被看见
    { at: 1.5, run: (d) => d.moveTo(aimPoint(d, d.p.ss.group), 0.8) },
    { at: 2.7, run: (d) => d.moveTo(aimPoint(d, d.p.ll.group), 0.8) },

    // —— 小奖：点它，等 2 秒，水晶进罐 ——
    { at: 4.2, run: (d) => d.moveTo(aimPoint(d, d.p.ss.group), 0.8) },
    { at: 5.2, run: (d) => delayPick(d, d.p.ss, DELAY_STAGE.ss) },

    // ☠️ 两道门必须先摆回来再演第二次。上一次 delayPick 把没选的那道藏了、
    // 数完的那道也藏了 —— 不重置的话后半段光标是在**指着空气**按下去，
    // 而屏幕上只是"什么都没发生"，看不出是 bug
    { at: 8.4, run: (d) => delayReset(d) },

    // —— 大奖：点它，等满 15 秒 ——
    { at: 9.4, run: (d) => d.moveTo(aimPoint(d, d.p.ll.group), 0.8) },
    { at: 10.4, run: (d) => delayPick(d, d.p.ll, DELAY_STAGE.ll) },
  ],

  tick(d, dt) {
    d.p.jar.rotation.y += dt * 0.12;

    const s = d.s.drain;
    if (!s) return;
    s.t += dt;
    // 倒数点一秒灭一颗 —— 和关卡 `update()` 的 wait 分支是同一条曲线
    const left = Math.max(0, s.delay - s.t);
    for (let i = 0; i < s.dots.length; i++) {
      s.dots[i].material.opacity = i < Math.ceil(left) ? 0.95 : 0.06;
    }
    if (s.t >= s.delay) {
      d.s.drain = null;
      delayCollect(d, s.reward);
      s.group.visible = false;
    }
  },
};

/** 光标停在某个道具前方的落点。`moveTo` 要的是世界坐标，不是道具本身。 */
function aimPoint(d, obj) {
  const camPos = new THREE.Vector3().setFromMatrixPosition(d.ctx.camera.matrixWorld);
  const to = obj.position.clone();
  return to.addScaledVector(camPos.sub(to).normalize(), STANDOFF);
}

/** 把两道门摆回"可以选"的样子：都显形、倒数点全亮。 */
function delayReset(d) {
  for (const prop of [d.p.ss, d.p.ll]) {
    prop.group.visible = true;
    prop.group.scale.setScalar(1);
    for (const dot of prop.dots) dot.material.opacity = 0.95;
  }
}

/** 演示里"选中一道门"：与 `DelayWell._choose()` 完全同一套中性确认。 */
function delayPick(d, prop, opt) {
  d.press();
  d.ctx.fx.burst(prop.group.position, {
    color: 0x9fb8e6, count: 12, speed: 2.2, size: 0.42, ttl: 0.36,
  });
  // 没被选的那道淡出，等待期就只剩下倒数点在动（等待期不许有别的刺激）
  const other = prop === d.p.ss ? d.p.ll : d.p.ss;
  other.group.visible = false;
  d.s.drain = { t: 0, delay: opt.delay, dots: prop.dots, reward: opt.reward, group: prop.group };
}

/** 领奖：与 `DelayWell._collect()` 同一套（同一个铃、同一圈光环，只是颗数不同）。 */
function delayCollect(d, n) {
  const p = d.p;
  for (let i = 0; i < n && p.collected < p.gems.length; i++) p.gems[p.collected++].visible = true;
  d.ctx.fx.ring(p.jar.position, { color: 0x8fd7ff, from: 0.2, to: 0.9, ttl: 0.5 });
  d.ctx.audio.calmBell(0);
}

/* ------------------------ 星舰辨识 · 老年训练档 ------------------------
 *
 * 这一段和前五段有三点根本不同，都来自"它教的是一个【极短呈现】的二选一"：
 *
 * ① **两型星舰各演一次，待遇完全相同**（同星愿之门那条）。左尖头、右平头是
 *    关卡里 `['sharp','blunt'].map()` 写死的顺序，演示照抄 —— 演示里左右和真关卡
 *    不一样，被试学到的动作就是错的，而他会直接带进正式关卡。
 *
 * ② ☠️ **前两次刻意放慢，最后才给真速度，而且这件事在字幕里说破。**
 *    真速度是起始 `UFOV_START_STEPS` 步 ≈ 333ms。老人第一次看，333ms 的闪现
 *    根本来不及形成印象 ——「点一样的那个」这条规则就**教不出来**。
 *    所以先用 4 倍时长让人看清两型长什么样，再把两型**各闪一次真速度**（不作答，
 *    只是让人知道正式开始有多快）。
 *    ⚠️ 这是本项目唯一一处"演示时间 ≠ 关卡时间"，所以两条都必须成立：
 *    **放慢的那两次两型对称、真速度那两次也两型对称**（任何一边多演一次都是在
 *    制造熟悉度偏好，而被试选哪个正是阈值的来源）；**真速度用的是导出的真常量**，
 *    不在这里另写毫秒数。
 *
 * ③ **收尾字幕必须说"看不清是正常的"。** 阶梯法会一直把人推到看不清为止 ——
 *    不说破的话老人会把它读成"我不行"，而依从性是本版块的头号风险
 *    （决策存档 §3.7）。同 `UfovFocus._levelTip()` 那句，改一处过来看另一处。
 */

/** 放慢倍数。只作用于前两次教学闪现，真速度那两次不受它影响。 */
const UFOV_DEMO_SLOW = 4;
const ufovRealMs = UFOV_START_STEPS * UFOV_STAGE.stepMs;
const ufovMaskMs = UFOV_STAGE.maskSteps * UFOV_STAGE.stepMs;

/** 闪一次：`stim` 显示 `ms` 毫秒 → 掩蔽 → 回到注视点。时序由 tick 推进。 */
function ufovFlash(d, kind, ms) {
  const p = d.p;
  p.stim.geometry = kind === 'sharp' ? p.geoSharp : p.geoBlunt;
  p.fix.visible = false;
  p.stim.visible = true;
  p.mask.visible = false;
  d.s.flash = { t: 0, on: ms / 1000, mask: ufovMaskMs / 1000, masked: false };
}

/** 摆回"可以再演一次"的样子。不重置的话第二轮光标是在指着空气按（同 delayReset）。 */
function ufovReset(d) {
  const p = d.p;
  d.s.flash = null;
  p.stim.visible = false;
  p.mask.visible = false;
  p.fix.visible = true;
  for (const o of p.opts) o.visible = false;
  d.showCursor(false);
}

/** 演示里"选中一个选项"：只给正反馈，答错时什么都不发生（同 UfovFocus._answer）。 */
function ufovPick(d, mesh) {
  d.press();
  d.ctx.fx.ring(mesh.position, { color: UFOV_STAGE.colors.fix, to: 1.1, ttl: 0.4 });
}

const ufovDemo = {
  /**
   * ⚠️ **必须 ≥ 最后一次真速度闪现结束的时刻**（12.2 起 + 0.33 + 掩蔽 0.1）。
   * 短了的后果和星愿之门那条同形：演示在闪现中途结束，被试**永远看不到真速度**，
   * 而那正是这段演示最后要交代的一件事 —— 画面上只是"演示放完了"。
   */
  duration: 15.0,
  captions: [
    { at: 0, icon: 'eye', text: '先看住正中间的小圆圈' },
    { at: 1.4, icon: 'eye', text: '星舰会在那里闪一下（这次放慢）' },
    { at: 3.4, icon: 'tap', text: '在下面两个里，点一样的那个' },
    { at: 5.6, icon: 'eye', text: '再来一次，这回是平头的' },
    { at: 10.2, icon: 'eye', text: '正式开始是这个速度 ——' },
    { at: 13.0, icon: 'check', text: '看不清是正常的，凭感觉选就行' },
  ],

  build(d) {
    const S = UFOV_STAGE;
    const p = d.p;
    const mk = (geo, mat, pos, order) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(pos[0], pos[1], pos[2]);
      m.renderOrder = order;
      d.props.add(m);
      return m;
    };

    // 观测窗：和关卡同一套底衬 + 窗框。不搭的话演示背景是花的，
    // 而"背景一变对比度就变"那条对演示同样成立 —— 教出来的难度感会偏
    p.matFrame = new THREE.MeshBasicMaterial({ color: S.colors.frame, ...S.over });
    p.matBack = new THREE.MeshBasicMaterial({ color: S.colors.back, ...S.over });
    p.matStim = new THREE.MeshBasicMaterial({ color: S.colors.stim, ...S.over });
    p.matMask = new THREE.MeshBasicMaterial({ color: S.colors.mask, wireframe: true, ...S.over });
    p.matFix = new THREE.MeshBasicMaterial({ color: S.colors.fix, ...S.over });

    mk(new THREE.PlaneGeometry(S.frame.w, S.frame.h), p.matFrame, [0, S.frame.y, S.frame.z], S.order.frame);
    mk(new THREE.PlaneGeometry(S.backdrop.w, S.backdrop.h), p.matBack, [0, S.backdrop.y, S.backdrop.z], S.order.back);

    p.geoSharp = shipGeometry('sharp');
    p.geoBlunt = shipGeometry('blunt');

    const at = [S.at.x, S.at.y, S.at.z];
    p.stim = mk(p.geoSharp, p.matStim, at, S.order.stim);
    p.stim.visible = false;
    p.mask = mk(new THREE.IcosahedronGeometry(S.maskR, 1), p.matMask, at, S.order.mask);
    p.mask.visible = false;
    p.fix = mk(new THREE.RingGeometry(S.fix.inner, S.fix.outer, 20), p.matFix, at, S.order.stim);

    // 左尖头、右平头 —— 与关卡的固定顺序一致，别在这里换边
    p.opts = ['sharp', 'blunt'].map((kind, i) => {
      const m = mk(kind === 'sharp' ? p.geoSharp : p.geoBlunt, p.matStim,
        [i === 0 ? -S.optX : S.optX, S.optY, S.optZ], S.order.stim);
      m.scale.setScalar(S.optScale);
      m.visible = false;
      return m;
    });

    d.s.flash = null;
    d.showCursor(false);
  },

  beats: [
    // —— 第一次：尖头，放慢 ——
    { at: 1.8, run: (d) => ufovFlash(d, 'sharp', ufovRealMs * UFOV_DEMO_SLOW) },
    { at: 3.5, run: (d) => { for (const o of d.p.opts) o.visible = true; } },
    { at: 3.9, run: (d) => { d.showCursor(true); d.moveTo(ufovAim(d, d.p.opts[0]), 0.8); } },
    { at: 4.9, run: (d) => ufovPick(d, d.p.opts[0]) },

    // ☠️ 演第二次之前必须摆回来（同 delayReset 那条）
    { at: 5.7, run: (d) => ufovReset(d) },

    // —— 第二次：平头，同样放慢、同样的节奏 ——
    { at: 6.4, run: (d) => ufovFlash(d, 'blunt', ufovRealMs * UFOV_DEMO_SLOW) },
    { at: 8.1, run: (d) => { for (const o of d.p.opts) o.visible = true; } },
    { at: 8.5, run: (d) => { d.showCursor(true); d.moveTo(ufovAim(d, d.p.opts[1]), 0.8); } },
    { at: 9.5, run: (d) => ufovPick(d, d.p.opts[1]) },

    // —— 真速度：两型各一次，不作答，只是让人知道正式开始有多快 ——
    { at: 10.3, run: (d) => ufovReset(d) },
    { at: 11.0, run: (d) => ufovFlash(d, 'sharp', ufovRealMs) },
    { at: 12.2, run: (d) => ufovFlash(d, 'blunt', ufovRealMs) },
  ],

  tick(d, dt) {
    const f = d.s.flash;
    if (!f) return;
    f.t += dt;
    if (!f.masked && f.t >= f.on) {
      f.masked = true;
      d.p.stim.visible = false;
      d.p.mask.visible = true;
    }
    if (f.t >= f.on + f.mask) {
      d.s.flash = null;
      d.p.mask.visible = false;
      d.p.fix.visible = true;
    }
  },
};

/** 光标停在选项前方的落点（同 delay 的 aimPoint，这里单列是为了不跨段依赖）。 */
function ufovAim(d, obj) {
  const camPos = new THREE.Vector3().setFromMatrixPosition(d.ctx.camera.matrixWorld);
  const to = obj.position.clone();
  return to.addScaledVector(camPos.sub(to).normalize(), STANDOFF);
}

/* ------------------------------ 双模态 N-back ------------------------------ */

/**
 * 演示只教“各管各的”两条规则，不做可回答的练习，以免把演示行为混入测量。
 * 星位、反应键位置和音高索引均取自 DualNBack 的真常量。
 */
const nbackDemo = {
  duration: .8 + 5 * NBACK_PROTOCOL.soaMs / 1000,
  captions: [
    { at: 0, icon: 'eye', text: '新手训练：金色圈住的是能量星球，看见它就按' },
    { at: .8 + NBACK_PROTOCOL.soaMs / 1000, icon: 'tap', text: '找到啦！收集星尘后，会开始记住刚才的星位' },
    { at: .8 + 2 * NBACK_PROTOCOL.soaMs / 1000, icon: 'eye', text: '星尘记忆：现在加入字母，先听一次、记住它' },
    { at: .8 + 3 * NBACK_PROTOCOL.soaMs / 1000, icon: 'stop', text: '都不一样时，安静等下一颗星球' },
    { at: .8 + 4 * NBACK_PROTOCOL.soaMs / 1000, icon: 'tap', text: '星际记忆：位置和字母都一样，按中间' },
  ],
  build(d) {
    const p = d.p;
    p.stars = NBACK_STAGE.positions.map((pos) => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(.2, 24), new THREE.MeshBasicMaterial({
        color: NBACK_STAGE.visualColor, transparent: true, opacity: .22, toneMapped: false,
      }));
      m.position.set(...pos); d.props.add(m); return m;
    });
    p.zeroTarget = new THREE.Mesh(new THREE.RingGeometry(.34, .4, 30), new THREE.MeshBasicMaterial({
      color: 0xffd36d, transparent: true, opacity: .9, toneMapped: false,
    }));
    p.zeroTarget.position.set(...NBACK_STAGE.positions[NBACK_PROTOCOL.zeroTargetVisual]);
    d.props.add(p.zeroTarget);
    p.pads = [NBACK_STAGE.guidedPadX, NBACK_STAGE.bothPadX, NBACK_STAGE.auditoryPadX].map((x, i) => {
      const color = i === 0 ? NBACK_STAGE.visualColor : i === 1 ? 0xb98cff : NBACK_STAGE.audioColor;
      const m = new THREE.Mesh(new THREE.RingGeometry(.28, .37, 30), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .68 }));
      m.position.set(x, NBACK_STAGE.padY, NBACK_STAGE.padZ); d.props.add(m); return m;
    });
    d.s.lit = -1; d.s.pad = -1;
  },
  beats: [
    { at: .8, run: (d) => nbackLight(d, NBACK_PROTOCOL.zeroTargetVisual, null) },
    { at: .8 + NBACK_PROTOCOL.soaMs / 1000, run: (d) => { nbackLight(d, NBACK_PROTOCOL.zeroTargetVisual, null); d.showCursor(true); d.moveTo(aimAt(d, d.p.pads[0]), .7); } },
    { at: .8 + NBACK_PROTOCOL.soaMs / 1000 + .9, run: (d) => { d.press(); d.showHint('check', d.p.pads[0].position, { ttl: 1.2 }); } },
    { at: .8 + 2 * NBACK_PROTOCOL.soaMs / 1000, run: (d) => { d.p.pads[0].position.x = NBACK_STAGE.visualPadX; nbackLight(d, 2, 4); d.moveTo(aimAt(d, d.p.pads[1]), .7); } },
    { at: .8 + 2 * NBACK_PROTOCOL.soaMs / 1000 + .9, run: (d) => { d.press(); d.showHint('check', d.p.pads[2].position, { ttl: 1.2 }); } },
    { at: .8 + 3 * NBACK_PROTOCOL.soaMs / 1000, run: (d) => { nbackLight(d, 4, 5); d.showCursor(false); } },
    { at: .8 + 4 * NBACK_PROTOCOL.soaMs / 1000, run: (d) => { nbackLight(d, 4, 5); d.showCursor(true); d.moveTo(aimAt(d, d.p.pads[1]), .7); } },
    { at: .8 + 4 * NBACK_PROTOCOL.soaMs / 1000 + .8, run: (d) => { d.press(); d.showHint('check', new THREE.Vector3(0, 1.55, -4.9), { ttl: 1.1 }); } },
  ],
  tick(d, dt) {
    d.p.stars.forEach((m, i) => { m.material.opacity = i === d.s.lit && d.t - d.s.onset < NBACK_PROTOCOL.stimulusMs / 1000 ? .95 : .18; });
    d.p.zeroTarget.visible = d.t < .8 + 2 * NBACK_PROTOCOL.soaMs / 1000;
    d.p.pads.forEach((m, i) => { m.material.opacity = i === d.s.pad ? .95 : .62; });
  },
};

function nbackLight(d, visual, tone) {
  d.s.lit = visual; d.s.pad = -1;
  d.s.onset = d.t;
  // 与正式关同一套字母刺激与回退音高；数组显式取值保证索引有效。
  if (NBACK_AUDIO_FREQS[tone] != null) d.ctx.audio.nbackLetter(NBACK_AUDIO_LABELS[tone], NBACK_AUDIO_FREQS[tone], NBACK_PROTOCOL.auditoryStimulusMs / 1000);
}

const SCRIPTS = {
  catcher: catcherDemo,
  beam: beamDemo,
  echo: echoDemo,
  cpt: cptDemo,
  delay: delayDemo,
  ufov: ufovDemo,
  nback: nbackDemo,
};

/**
 * 某一关演示有多长（秒），没有脚本的关卡返回 0。
 *
 * 存在的理由不是给 UI 用：**测评档导出的 `protocol` 必须如实写明施测前放了多长的演示**
 * （SYNC.md #18b）。演示会影响施测结果 —— 看过演示的孩子和没看过的，前 20 个试次
 * 根本不是同一件事。拿到 JSON 的人有权知道这一段存在、有多长。
 * 走函数而不是让 `CatcherCpt` 直接 import 常量，是为了不在两个文件之间制造循环引用。
 */
export function demoDuration(id) { return SCRIPTS[id]?.duration ?? 0; }
