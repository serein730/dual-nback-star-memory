import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * 渲染装配：渲染器 / 相机 / 玩家 rig / 环境反射 / 后期处理 / WebXR。
 *
 * 关键设计：
 *  - 桌面走 EffectComposer（MSAA RT + UnrealBloom + OutputPass），出图质感由 bloom 撑起来；
 *  - 进入 XR 后自动绕过 composer 直接渲染 —— 后期处理与 XR 的多视图 framebuffer 不兼容，
 *    而且 Quest 级别的 GPU 也吃不下全屏 bloom；材质层面另有一套降级（见 Assets.js）。
 *  - camera 挂在 playerRig 下：桌面手动摆位，XR 由 local-floor 参考空间接管头显位姿。
 */
/**
 * XR 性能旋钮 —— 可用 URL 参数现场调，省得为试一个数值就改代码重进头显。
 *
 *   ?xrscale=0.8     渲染分辨率倍率（默认 1，**在 Pico 4 上不要动，见下**）
 *   ?foveation=1     注视点渲染强度 0~1（默认 0.85）
 *   ?aa=0            关多重采样
 *
 * ☠️ **`xrscale` 在 Pico 4 上会导致画面全黑，默认必须留 1。**（2026-08-06 实测）
 *
 * 症状极具迷惑性 —— 一切"看起来"都正常：
 *     XRProjectionLayer 建得出来、isPresenting=true、层尺寸如实变成 2406×1203、
 *     渲染循环满帧 71.8fps、drawCalls 正常、控制台一条错误都没有。
 *     **只是合成器不把画面送进眼睛**，头显里纯黑。
 *
 * 用最小复现页（xrtest.html）做单变量确认过，同一台设备、同一个页面：
 *     scale=1    层 3008×1504  → 看得见
 *     stencil=0  层 3008×1504  → 看得见
 *     scale=0.8  层 2406×1203  → **看不见**
 *
 * 根因在 Pico 浏览器（Chrome 105 内核）的 WebXR Layers 实现，不是 three 的问题。
 * 想降分辨率省填充率，走 foveation，别碰 scaleFactor。
 */
const XR_TUNING = (() => {
  const p = new URLSearchParams(location.search);
  const num = (key, dflt, lo, hi) => {
    const v = parseFloat(p.get(key));
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
  };
  return {
    // 默认 1 = 不调用 setFramebufferScaleFactor。改这个默认值前先读上面那段 ☠️
    scale: num('xrscale', 1, 0.3, 1),
    foveation: num('foveation', 0.85, 0, 1),
    post: p.get('post'),   // '0' 强制关后期 / '1' 强制开，不填则按设备自动判
    // ?aa=0 关多重采样。XR 下这一档很值钱：Three.js 建 XRProjectionLayer 时写死
    // `samples: attributes.antialias ? 4 : 0`，也就是 4x MSAA —— 在 2406x1203 双眼
    // 上按面积算是一笔巨大的带宽开销，而 Adreno 650 最缺的就是带宽。
    // antialias 是 WebGLRenderer 的构造参数，运行期改不了，只能在这里定。
    aa: p.get('aa') !== '0',
  };
})();

/**
 * 是不是头显自带的浏览器。
 *
 * 为什么要单独认它：画质降级原本只挂在 `sessionstart` 上，也就是**点了"进入 VR"之后**
 * 才生效。可在头显里打开网页、还没进沉浸式的那段时间，跑的是完整桌面路径 ——
 * EffectComposer 全屏 bloom + MSAA×4 的 HalfFloat RT + 折射/虹彩材质 + 阴影，
 * 骁龙 XR2 这级的移动 GPU 扛不住，表现就是"在头显浏览器里打开就很卡"。
 *
 * 而这段 2D 画面本来只是"点进入 VR 之前的过渡"，画质毫无意义，流畅才有意义。
 * 用 UA 嗅探而不是按帧率自适应，是因为演示场景要的是**可预测**：
 * 自适应会在演示到一半时突然变画质，比一直低画质更糟。
 */
const IS_HEADSET_BROWSER = /\b(Pico|Quest|OculusBrowser|Wolvic|VRBrowser)\b/i.test(
  typeof navigator === 'undefined' ? '' : navigator.userAgent,
);

/**
 * 场景的成图眼高。桌面相机被每帧按回这个高度，**关卡布局的所有角度都是按它排的**，
 * 所以 XR 里也必须把眼睛送到同一高度（见 `calibrateEyeHeight()`）。
 * 三处引用同一个数：这里、构造函数的初始机位、`Game._frame()` 的桌面复位。
 */
export const EYE_HEIGHT = 1.6;

export class RenderRig {
  constructor() {
    const renderer = new THREE.WebGLRenderer({
      antialias: XR_TUNING.aa,
      powerPreference: 'high-performance',
      stencil: false,
    });
    renderer.setSize(innerWidth, innerHeight);
    // 头显浏览器的 2D 窗口本身就是在 VR 合成器里贴出来的，再乘 devicePixelRatio 纯属浪费
    renderer.setPixelRatio(IS_HEADSET_BROWSER ? 1 : Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    // r185 起 PCFSoftShadowMap 已废弃（内部会回退到 PCFShadowMap 并打一条警告），直接用后者
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    // 只在显式要求时才动它 —— 默认 1 就完全不调用这个 API。
    // Pico 4 上任何 ≠1 的倍率都会让画面静默变黑（见文件顶部 ☠️ 那段）。
    // 必须在会话开始之前设：层是建会话时按这个倍率一次性分配的，中途改不了。
    if (XR_TUNING.scale !== 1) {
      try {
        renderer.xr.setFramebufferScaleFactor(XR_TUNING.scale);
        console.warn(`[XR] framebufferScaleFactor=${XR_TUNING.scale} —— Pico 4 上这会导致全黑，只应用于排障`);
      } catch { /* 老实现没有该 API */ }
    }
    document.body.appendChild(renderer.domElement);
    this.renderer = renderer;

    // 68° 垂直 FOV：桌面端所有任务元素都要落在画面内，而窗口宽高比是用户说了算的。
    // 16:9 下水平半视场约 50°，4:3 下约 42° —— 关卡布局的角度上限就是按后者定的。
    // XR 会话里这个值不生效，头显自己接管投影矩阵。
    this.camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.08, 400);
    this.camera.position.set(0, EYE_HEIGHT, 0);

    // 玩家 rig：所有位移作用在 rig 上，XR 中头显位姿叠加在其之上
    // （three 的做法是 cameraXR.matrixWorld = playerRig.matrixWorld × 头姿，
    //   所以抬 rig 就等于抬眼高 —— `calibrateEyeHeight()` 靠的就是这一条）
    this.playerRig = new THREE.Group();
    this.playerRig.add(this.camera);

    this.scene = new THREE.Scene();
    this.scene.add(this.playerRig);

    // —— 环境反射：RoomEnvironment 程序化生成，无需外部 HDR 文件 ——
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.02);
    this.scene.environment = envRT.texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this._buildComposer();

    // 头显浏览器一上来就按低画质跑，不等 sessionstart（见 IS_HEADSET_BROWSER 注释）
    this.quality = IS_HEADSET_BROWSER ? 'low' : 'high';   // high | low
    this.skipPost = XR_TUNING.post === '1' ? false
      : XR_TUNING.post === '0' ? true
      : IS_HEADSET_BROWSER;
    this.isXR = false;
    this._eyeCalibrated = false;
    this._resizeBound = () => this.resize();
    addEventListener('resize', this._resizeBound);

    renderer.xr.addEventListener('sessionstart', () => this._onXRChange(true));
    renderer.xr.addEventListener('sessionend', () => this._onXRChange(false));
  }

  _buildComposer() {
    const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
      type: THREE.HalfFloatType,
      samples: 4, // 后期链路里保住 MSAA，边缘不糊
    });
    const composer = new EffectComposer(this.renderer, rt);
    composer.setPixelRatio(Math.min(devicePixelRatio, 2));
    composer.addPass(new RenderPass(this.scene, this.camera));

    // 阈值必须 ≥ 1.0。合成器的缓冲是线性 HDR，纯白 UI 面板正好是 1.0：
    // 阈值低于 1 的话，所有白色界面文字都会被当成"高光"糊掉一圈，
    // 只有真正超过 1 的自发光（additive 光晕、粒子）才应该溢出。
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight),
      0.42,  // strength
      0.62,  // radius
      1.02,  // threshold
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    this.composer = composer;
    this.bloom = bloom;
  }

  _onXRChange(active) {
    this.isXR = active;
    this.quality = active ? 'low' : 'high';
    // 眼高每次进会话都要重新校准（换人 = 换身高），退出时把 rig 放回原位，
    // 否则桌面相机被抬着，而桌面端本来就已经在正确高度上了。
    this._eyeCalibrated = false;
    if (!active) this.playerRig.position.y = 0;
    if (active) {
      // 注视点渲染：边缘降采样换帧率。中心清晰、余光模糊，正好符合人眼特性，
      // 是移动头显上"几乎不要钱"的一档性能
      try { this.renderer.xr.setFoveation(XR_TUNING.foveation); } catch { /* 老实现没有该 API */ }
      // 阴影贴图是独立的一遍渲染。World.setQuality('low') 已经把投影光源关了，
      // 这里连开关一起关掉，省下 shadowMap 每帧的状态检查与可能的 RT 绑定
      this.renderer.shadowMap.enabled = false;
    } else {
      this.renderer.shadowMap.enabled = true;
    }
    this.onQualityChange?.(this.quality);
  }

  /**
   * 把 XR 里的眼高对齐到场景的成图眼高。**必须每帧调**（`Game._frame()` 开头），
   * 内部只在会话的第一个有效头姿上真正动一次。
   *
   * 为什么必须做：`local-floor` 给的是**真实**头高，而场景是按眼在 1.6m 排的。
   * 两者不相等的原因有两类，且都不是异常情况：
   *   ① 被试就是矮 —— 本项目面向 6–12 岁儿童，眼高约 1.1~1.3m；
   *   ② 头显的地板面不等于真实地板 —— Pico 4 实测：戴在头上时 `local-floor`
   *      只报 **0.355m**（2026-08-08 实机量的），也就是地板面比真实地板高了约 1m。
   * 不校准的后果是整个场景悬在头顶、全程要抬头看，而铁律 6 要求两端同一套布局。
   *
   * **只校准一次，之后不再跟随。** 每帧跟随会让世界随人起坐上下滑（比偏高更糟），
   * 也会把头动指标里的垂直位移全部抹平。
   *
   * `cameraXR.cameras.length > 0` 是"这一帧真的拿到 viewerPose 了"的判据 ——
   * 没有 pose 时 three 的 `onAnimationFrame` 整段跳过，`cameras` 一直是空数组；
   * 用它而不是"头高 > 某个阈值"，是因为矮小孩子和怪异地板标定都可能落在阈值下面。
   */
  calibrateEyeHeight() {
    if (!this.isXR || this._eyeCalibrated) return;
    const camXR = this.renderer.xr.getCamera();
    if (!camXR || camXR.cameras.length === 0) return;   // 还没有真实头姿
    const headY = camXR.matrix.elements[13];            // 参考空间里的头高
    this.playerRig.position.y = EYE_HEIGHT - headY;
    // 立刻推一遍父链：手柄也挂在 rig 底下，而它们的 matrixWorld 平时是靠
    // renderer.render() 里的 scene.updateMatrixWorld() 更新的（也就是上一帧的 rig）。
    // 不推这一下，校准当帧的手柄射线原点还在旧高度上。
    this.playerRig.updateMatrixWorld(true);
    this._eyeCalibrated = true;
    console.log(`[XR] 眼高校准：头显报 ${headY.toFixed(3)}m，rig 抬 ${this.playerRig.position.y.toFixed(3)}m → 眼高 ${EYE_HEIGHT}m`);
  }

  /** 重新校准（换人戴、或坐姿变了）：`__game.rig.recenter()`。 */
  recenter() { this._eyeCalibrated = false; }

  /** 当前 XR 性能设置 —— 头显里调参时用 `__game.rig.xrInfo` 查证到底生效了没。 */
  get xrInfo() {
    const base = this.renderer.xr.getBaseLayer?.();
    // ⚠️ 两种层的尺寸属性名不一样，必须都问：走 WebXR Layers 时拿到的是
    // XRProjectionLayer，只有 textureWidth/Height；framebufferWidth/Height 是老
    // XRWebGLLayer 的属性。只问后者的话，Pico 上这里恒为 "undefinedxundefined" ——
    // 而这正是用来确认 xrscale 有没有生效的那个字段（2026-08-08 实机发现）。
    const w = base ? (base.textureWidth ?? base.framebufferWidth) : null;
    const h = base ? (base.textureHeight ?? base.framebufferHeight) : null;
    return {
      scale: XR_TUNING.scale,
      foveation: XR_TUNING.foveation,
      // 实际拿到的层尺寸 —— 头显给的可能和请求的不完全一致
      framebuffer: base ? `${w}x${h}` : '未在 XR 会话中',
      layerType: base ? base.constructor.name : '未在 XR 会话中',
      eyeHeight: this._eyeCalibrated
        ? `${EYE_HEIGHT}m（rig 抬了 ${this.playerRig.position.y.toFixed(3)}m）`
        : '未校准',
      shadows: this.renderer.shadowMap.enabled,
      quality: this.quality,
    };
  }

  resize() {
    if (this.renderer.xr.isPresenting) return;
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  /** 每帧出图：XR 与头显浏览器直渲，桌面走后期。 */
  render() {
    if (this.renderer.xr.isPresenting || this.skipPost) {
      this.renderer.render(this.scene, this.camera);
    } else {
      this.composer.render();
    }
  }

  /**
   * 把构造期就定下来的画质档应用下去。
   * 必须由 Game 在装好 onQualityChange 之后调用一次 —— 头显浏览器的低画质是在
   * 构造函数里定的，那时回调还不存在，不补这一下材质就仍然是高画质。
   */
  syncQuality() { this.onQualityChange?.(this.quality); }

  /** 头显里玩家的水平朝向（用于把 UI 面板懒跟随到视线前方）。 */
  getViewYaw() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return Math.atan2(dir.x, dir.z);
  }
}
