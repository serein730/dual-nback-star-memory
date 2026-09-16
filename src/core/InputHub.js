import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

/**
 * Pico 4 手柄官方模型的本地资产目录。**必须是本地** —— factory 的默认路径是
 * jsDelivr 的 CDN，断网就没有手柄（铁律 3：演示现场没网）。
 * 这份 `profilesList.json` 是我们自己写的、与上游那份刻意不同，
 * 为什么不同见 `vendor/webxr-input-profiles/README.md`（一句话：不写那一条就会
 * 拿到 Quest 2 的手柄，而且不报错）。
 */
const PROFILES_PATH = './vendor/webxr-input-profiles/profiles';

/*
 * XR 里的「返回」手势：长按 B（右）/ Y（左）。
 *
 * 为什么必须有：沉浸态里 DOM 不存在（铁律 2），右上角那个返回按钮在头显里
 * **根本没有** —— 在补上这条之前，VR 下进了关卡就出不来，只能摘头显。
 *
 * 按键号取 5 不是猜的：`vendor/webxr-input-profiles/profiles/pico-4/profile.json`
 * 里 `y-button`/`b-button` 的 `gamepadIndices.button` 都是 5，而这也正是
 * xr-standard 的通用约定，所以换头显同样成立。
 *
 * **为什么是长按而不是单按**：测评档一场 8 分 18 秒 / 200 试次，误触退出
 * = 那一场整个作废（和"中途摘头显"是同一个后果），而 B/Y 恰好在拇指自然
 * 搭着的位置上。1.2 秒足够挡掉误触，又不至于让人以为没反应。
 */
const MENU_BTN = 5;
const MENU_HOLD_SEC = 1.2;
const MENU_HINT_SEC = 0.18;   // 按到这么久就先给提示，让人知道"要继续按"

/**
 * 输入统一层：把「桌面鼠标/触摸」和「XR 手柄」抹平成同一套指针语义。
 *
 * 这是整个 Demo 里最值钱的一层抽象。三个迷你游戏和所有 UI 面板都只面向
 * Pointer（射线 + 按下/抬起）编程，因此同一份交互代码在电脑和头显里都成立，
 * 不需要为 VR 单独写一套 UI 或一套命中逻辑。
 *
 * Pointer 提供：
 *   raycaster    已就绪的射线（世界空间）
 *   pressed      本帧是否刚按下
 *   released     本帧是否刚抬起
 *   down         是否处于按住状态
 *   setBeam(d)   把可视射线截断到命中距离
 */

class Pointer {
  constructor(type, id) {
    this.type = type;        // 'screen' | 'xr'
    this.id = id;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 60;
    this.down = false;
    this.pressed = false;
    this.released = false;
    this.enabled = type === 'screen';
    this.hand = null;
    this.hitPoint = new THREE.Vector3();
    this.hasHit = false;
  }
  clearFrame() { this.pressed = false; this.released = false; }
}

export class InputHub {
  constructor({ renderer, camera, scene, audio, playerRig }) {
    this.renderer = renderer;
    this.camera = camera;
    this.scene = scene;
    this.audio = audio;
    // 手柄挂这里，不挂 scene（见 _bindXR 的 ⚠️）。没传就退回 scene，
    // 等价于 rig 恒在原点的旧行为。
    this.playerRig = playerRig || scene;

    this.pointers = [];
    this.screenPointer = new Pointer('screen', 'mouse');
    this.pointers.push(this.screenPointer);

    this.ndc = new THREE.Vector2(0, 0);
    this.hasScreenPos = false;
    this.keys = new Set();
    this.listeners = { escape: new Set(), any: new Set(), menuHint: new Set() };
    this._menuHold = 0;
    this._menuHinted = false;

    this._bindScreen();
    this._bindXR();
  }

  /* ----------------------- 桌面 / 触摸 ----------------------- */

  _bindScreen() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';

    const setNdc = (e) => {
      this.ndc.x = (e.clientX / innerWidth) * 2 - 1;
      this.ndc.y = -(e.clientY / innerHeight) * 2 + 1;
      this.hasScreenPos = true;
    };

    el.addEventListener('pointermove', setNdc);
    el.addEventListener('pointerdown', (e) => {
      setNdc(e);
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      this.screenPointer.down = true;
      this.screenPointer.pressed = true;
      // 合成事件（自动化测试）里 pointerId 可能无效，捕获会抛 NotFoundError
      try { el.setPointerCapture?.(e.pointerId); } catch { /* 忽略 */ }
    });
    el.addEventListener('pointerup', () => {
      if (!this.screenPointer.down) return;
      this.screenPointer.down = false;
      this.screenPointer.released = true;
    });
    el.addEventListener('pointerleave', () => { this.screenPointer.down = false; });

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      // 空格键：给还不擅长鼠标点击的小朋友一个更快的反应通道
      if (e.code === 'Space') {
        e.preventDefault();
        this.screenPointer.down = true;
        this.screenPointer.pressed = true;
      }
      if (e.code === 'Escape') this.listeners.escape.forEach((f) => f());
      // 第二个参数是原始事件：`code` 是物理键位（`KeyH`），拿不到**字符**，
      // 而退出口令要的是 `e.key`。老回调只声明了一个形参，加参数不影响它们
      this.listeners.any.forEach((f) => f(e.code, e));
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space') {
        this.screenPointer.down = false;
        this.screenPointer.released = true;
      }
    });
  }

  /* ----------------------- WebXR 手柄 ----------------------- */

  _bindXR() {
    this.xrPointers = [];
    this.controllerGroup = new THREE.Group();
    // ⚠️ **必须挂在 playerRig 下，不能挂在 scene 下。**
    // three 只写手柄的**局部** matrix（three.core.js 里 grip/targetRay 都是
    // `matrix.fromArray(pose)` + decompose），matrixWorld 由父链推出 —— 所以手柄
    // 跟相机必须共享同一个父节点，否则 rig 一动，头动了手不动。
    // 症状是"要低头看很远才能看到手柄"，而射线命中照样准（update() 里独立算），
    // 所以控制台和命中日志全都正常。rig 恒在原点的时候完全看不出来。
    this.playerRig.add(this.controllerGroup);

    this._modelFactory = new XRControllerModelFactory().setPath(PROFILES_PATH);

    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);
      const grip = this.renderer.xr.getControllerGrip(i);
      const pointer = new Pointer('xr', `xr-${i}`);
      pointer.enabled = false;
      pointer.object = controller;

      const beam = this._makeBeam();
      controller.add(beam);
      pointer.beam = beam;

      // 准星反过来 —— 它必须挂在 scene 上，**别跟着上面的 controllerGroup 一起搬**：
      // setBeam() 直接把世界空间的命中点 copy 进它的 position，挂到 rig 下就会被
      // rig 的偏移量重复叠加一次，准星飘到命中点上方 1.25m。
      const dot = this._makeReticle();
      dot.visible = false;
      this.scene.add(dot);
      pointer.dot = dot;

      // 手里的实体：官方模型 + 程序化兜底，两个都挂上，谁先到位谁显示。
      //
      // 为什么留兜底：官方模型只覆盖 `profilesList.json` 里列过的设备（当前只有
      // Pico 4），换个头显、或者 vendor 目录缺文件，factory 只会 console.warn 一句，
      // **手上就什么都没有了**。而"能在任意设备上跑起来"是铁律 3 的一部分。
      // 兜底切换靠 update() 里数 model.children —— factory 的 onLoad 是工厂级单回调，
      // 分不出是哪只手，而 children 非空就是"glTF 已经挂上去了"的直接证据。
      const wand = this._makeWand();
      grip.add(wand);
      pointer.wand = wand;

      // 模型必须挂 grip 不是 controller：grip space 才是"手握着的那个东西"的位姿，
      // targetRay space 是射线的，用它模型会歪着（WebXR 规范里这是两个不同的空间）。
      const model = this._modelFactory.createControllerModel(grip);
      grip.add(model);
      pointer.model = model;

      controller.addEventListener('selectstart', () => {
        pointer.down = true; pointer.pressed = true;
      });
      controller.addEventListener('selectend', () => {
        pointer.down = false; pointer.released = true;
      });
      controller.addEventListener('connected', (e) => {
        pointer.enabled = true;
        pointer.hand = e.data?.handedness || null;
        pointer.gamepad = e.data?.gamepad || null;
        beam.visible = true;
      });
      controller.addEventListener('disconnected', () => {
        pointer.enabled = false;
        beam.visible = false;
        dot.visible = false;
      });

      this.controllerGroup.add(controller, grip);
      this.pointers.push(pointer);
      this.xrPointers.push(pointer);
    }
  }

  _makeBeam() {
    // 沿 -Z 的细锥体：比 Line 更可控（线宽在多数实现里被限制为 1px）
    const geo = new THREE.CylinderGeometry(0.0035, 0.0012, 1, 8, 1, true);
    geo.translate(0, -0.5, 0);
    // ⚠️ 这个符号是 +，不是 −。手柄的前向是 −Z，而 rotateX 的矩阵是
    //   y' = cosθ·y − sinθ·z,  z' = sinθ·y + cosθ·z
    // 所以把 y∈[−1,0] 的锥体转到 z∈[−1,0] 需要 θ=+π/2；给 −π/2 会转到 z∈[0,+1]，
    // **光束从手柄后面射出去**，而命中判定用的是 update() 里独立算的 −Z 方向，
    // 于是"准星在前面、光束在后面"，只有戴上头显才看得出来（2026-08-08 实机抓到）。
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x7fe4ff, transparent: true, opacity: 0.62,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.scale.z = 6;
    m.visible = false;
    return m;
  }

  _makeReticle() {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.018, 0.026, 24),
      new THREE.MeshBasicMaterial({
        color: 0x9ff0ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
        depthTest: false, toneMapped: false,
      }),
    );
    g.add(ring);
    const core = new THREE.Mesh(
      new THREE.CircleGeometry(0.006, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, toneMapped: false }),
    );
    g.add(core);
    g.renderOrder = 999;
    return g;
  }

  /** 简化的手柄外形：拿在手里有实体感，但不追求还原具体机型。 */
  _makeWand() {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x20264a, metalness: 0.6, roughness: 0.35, envMapIntensity: 1.2,
    });
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.021, 0.075, 4, 12), bodyMat);
    grip.rotation.x = 0.35;
    g.add(grip);

    const head = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 8, 28), new THREE.MeshStandardMaterial({
      color: 0x9fb2e8, metalness: 0.9, roughness: 0.2, envMapIntensity: 1.5,
    }));
    head.position.set(0, 0.035, -0.02);
    head.rotation.x = Math.PI / 2 + 0.35;
    g.add(head);

    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.0115, 12, 10), new THREE.MeshBasicMaterial({
      color: 0x7ff0ff, toneMapped: false,
    }));
    tip.position.set(0, 0.038, -0.02);
    g.add(tip);
    return g;
  }

  /** 命中反馈的手柄震动。 */
  pulse(pointer, intensity = 0.5, ms = 45) {
    const gp = pointer?.gamepad;
    const act = gp?.hapticActuators?.[0];
    try { act?.pulse?.(intensity, ms); } catch { /* 部分实现不支持 */ }
  }

  pulseAll(intensity = 0.5, ms = 45) {
    this.xrPointers.forEach((p) => p.enabled && this.pulse(p, intensity, ms));
  }

  onEscape(fn) { this.listeners.escape.add(fn); return () => this.listeners.escape.delete(fn); }

  /**
   * 任意按键（收到的是 `e.code`）。
   *
   * `listeners.any` 这个集合从一开始就在 keydown 里被遍历，但**在 2026-08-12
   * 之前没有任何注册入口** —— 也就是说它一直是空的。补上它是为了「开始前确认」页
   * 用键盘敲出生年份。⚠️ 回调里**必须自己判断当前状态**：这是全局 keydown，
   * 关卡进行中同样会收到，而那时候数字键不该有任何副作用。
   */
  onAny(fn) { this.listeners.any.add(fn); return () => this.listeners.any.delete(fn); }

  /** 长按返回刚起手时触发一次：用来提示"再按住一会儿"。 */
  onMenuHint(fn) { this.listeners.menuHint.add(fn); return () => this.listeners.menuHint.delete(fn); }

  /**
   * 长按 B/Y 返回。反馈走**震动 + 世界空间气泡**，不能用 toast ——
   * toast 是 DOM，沉浸态里看不见（铁律 2），用它等于没有反馈。
   */
  _pollMenuHold(dt) {
    let held = false;
    for (const p of this.xrPointers) {
      // 按键数少于 6 的设备上 buttons[5] 是 undefined，可选链兜掉，不崩
      if (p.enabled && p.gamepad?.buttons?.[MENU_BTN]?.pressed) { held = true; break; }
    }
    if (!held) { this._menuHold = 0; this._menuHinted = false; return; }

    const before = this._menuHold;
    this._menuHold += dt;

    if (!this._menuHinted && this._menuHold >= MENU_HINT_SEC) {
      this._menuHinted = true;
      this.pulseAll(0.35, 30);
      this.listeners.menuHint.forEach((f) => f());
    }
    // 跨过阈值的那一帧才触发。按住不放时 _menuHold 继续涨，所以只会响一次
    if (before < MENU_HOLD_SEC && this._menuHold >= MENU_HOLD_SEC) {
      this.pulseAll(0.85, 90);
      this.listeners.escape.forEach((f) => f());
    }
  }

  /**
   * 每帧刷新射线；游戏逻辑随后用 pointer.raycaster 做命中。
   * @param {number} dt 秒。长按返回要计时，没有它就只能读 performance.now()
   */
  update(dt = 0) {
    const presenting = this.renderer.xr.isPresenting;
    if (presenting) this._pollMenuHold(dt);
    else { this._menuHold = 0; this._menuHinted = false; }

    this.screenPointer.enabled = !presenting;
    if (!presenting) {
      this.screenPointer.raycaster.setFromCamera(
        this.hasScreenPos ? this.ndc : new THREE.Vector2(0, 0),
        this.camera,
      );
    }

    for (const p of this.xrPointers) {
      if (!p.enabled) continue;

      // 官方模型在位就藏起程序化手柄，不在位就显示它。写成每帧无条件赋值而不是
      // 「切一次就置 null」，是为了断连再接时能自愈 —— factory 的 disconnected
      // 会把 glTF 从模型节点上摘掉，那一刻兜底必须自己回来。
      // 模型永远不来（换头显 / 资产缺失）时兜底一直显示，这是设计不是漏改。
      p.wand.visible = p.model.children.length === 0;

      const c = p.object;
      c.updateMatrixWorld();
      const origin = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(
        new THREE.Quaternion().setFromRotationMatrix(c.matrixWorld),
      ).normalize();
      p.raycaster.set(origin, dir);
    }
  }

  /** 把可视射线截断到命中点（没命中就给个默认长度）。 */
  setBeam(pointer, distance, hitPoint) {
    if (pointer.type !== 'xr' || !pointer.beam) return;
    const d = distance && isFinite(distance) ? Math.min(distance, 30) : 6;
    pointer.beam.scale.z = d;
    if (hitPoint && pointer.dot) {
      pointer.dot.visible = true;
      pointer.dot.position.copy(hitPoint);
      pointer.dot.lookAt(
        pointer.raycaster.ray.origin.x,
        pointer.raycaster.ray.origin.y,
        pointer.raycaster.ray.origin.z,
      );
    } else if (pointer.dot) {
      pointer.dot.visible = false;
    }
  }

  /** 活跃指针（桌面模式只有鼠标，XR 下只有已连接的手柄）。 */
  active() { return this.pointers.filter((p) => p.enabled); }

  endFrame() { this.pointers.forEach((p) => p.clearFrame()); }
}
