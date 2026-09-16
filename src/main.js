import { Game } from './core/Game.js';

/**
 * 入口：只负责三件 3D 世界之外的事 —— 启动门、WebXR 会话申请、少量 DOM 提示。
 * 游戏界面本身全在世界空间里（见 ui/Panel.js 的说明）。
 */

/* ─── WebXR Layers 逃生开关（?nolayers=1）—— 排障用，别当解药 ──────────────
 *
 * ⚠️ **2026-08-06 实测结论：这个开关解决不了全黑，反而会让 Pico 4 闪退。**
 * 当时全黑的真凶是 `setFramebufferScaleFactor`（见 RenderRig.js 顶部 ☠️），
 * 跟 layers 无关 —— 最小复现页走的也是 XRProjectionLayer，画面好好的。
 * 开关保留下来只是因为下面这条知识值得留着，默认不启用。
 *
 * Three.js 决定走不走 XRProjectionLayer，**只看浏览器有没有这个 API**：
 *
 *     const supportsLayers = supportsGlBinding
 *         && 'createProjectionLayer' in XRWebGLBinding.prototype;   // three.module.js
 *
 * 它**不看 requestSession 的 optionalFeatures**，所以从下面那行 optionalFeatures
 * 里删掉 'layers' 是没有任何效果的 —— 想强制回退到老的 XRWebGLLayer 路径，
 * 只能把这个 API 本身藏起来。用 delete 而不是赋 undefined：判据是 `in`，
 * 赋值改不了它的结果。
 *
 * 但那条回退路径在 Pico 4 上是坏的（渲染进程 SIGTRAP 崩溃，退回系统菜单），
 * 所以**不要**为了性能去打开它。
 */
if (new URLSearchParams(location.search).get('nolayers') === '1') {
  try {
    delete XRWebGLBinding.prototype.createProjectionLayer;
    console.log('[XR] 已禁用 WebXR Layers，将回退到 XRWebGLLayer 路径');
  } catch (e) {
    console.warn('[XR] 禁用 Layers 失败：', e);
  }
}

const gate = document.getElementById('gate');
const btnDesktop = document.getElementById('btn-desktop');
const btnXR = document.getElementById('btn-xr');
const btnXRInline = document.getElementById('btn-xr-inline');
const xrSub = document.getElementById('xr-sub');
const hudDom = document.getElementById('hud-dom');
const btnMenu = document.getElementById('btn-menu');
const fpsEl = document.getElementById('fps');
const toastEl = document.getElementById('toast');
const xrHint = document.getElementById('xr-hint');
const bciDot = document.getElementById('bci-dot');
const bciText = document.getElementById('bci-text');

let toastTimer = 0;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

let game = null;
let xrSupported = false;
let started = false;
const publicDemo = location.hostname.endsWith('.github.io')
  || new URLSearchParams(location.search).get('publicDemo') === '1';

/**
 * 进/退全屏。两件事都可能失败且**都不该影响流程** —— 失败最多是浏览器 UI 露着，
 * 而抛到调用方会把开测这一步整个打断。
 *
 * XR 沉浸态下直接跳过：那本来就是独占显示，再叠一层全屏只会和 XR 会话打架。
 */
function setFullscreen(on) {
  try {
    if (game?.renderer?.xr?.isPresenting) return;
    if (on) {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch(armFullscreenRetry);
      }
    } else {
      disarmFullscreenRetry();
      if (document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
    }
  } catch { armFullscreenRetry(); }
}

/**
 * 全屏兜底。
 *
 * ☠️ `requestFullscreen` 要 **transient user activation**（Chrome 约 5 秒），而这个项目里
 * 按钮的命中判定发生在 **rAF 帧**里（世界空间面板靠射线命中，见 Game._updateUI）——
 * 前台 60fps 时点击到判定只差十几毫秒，activation 稳稳在有效期内；但帧率掉下去、
 * 或者标签页被切到后台（rAF 被节流到几乎停摆）时，等帧来的时候 activation 已经过期，
 * 浏览器**静默拒绝**，人只会看到"全屏没生效"。2026-08-19 自动化实测就撞在这上面：
 * `onFullscreen(true)` 确实被调到了，而 `navigator.userActivation.isActive` 是 false。
 *
 * 所以失败时挂一个一次性的 `pointerdown` 监听 —— DOM 事件回调是同步路径，
 * activation 一定有效。孩子点说明页「开始」或演示页「跳过」时就补上了，最多晚一次点击。
 */
let fsRetry = null;

function armFullscreenRetry() {
  if (fsRetry) return;
  fsRetry = () => {
    disarmFullscreenRetry();
    // 会话已经结束就别补了 —— 那时正该退出全屏，补进去就是跟 _abortToMenu 打架
    if (!game?._sessionActive || document.fullscreenElement) return;
    try { document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {}); } catch {}
  };
  // capture 阶段：面板的命中判定在 rAF 里，等冒泡回来这一帧可能已经过去了
  addEventListener('pointerdown', fsRetry, true);
}

function disarmFullscreenRetry() {
  if (!fsRetry) return;
  removeEventListener('pointerdown', fsRetry, true);
  fsRetry = null;
}

/* ----------------------------- 初始化 ----------------------------- */

async function boot() {
  try {
    game = new Game();
    game.toast = toast;
    // 「返回」链的最后一跳。Game 不碰 DOM，所以退出到启动门这一步由这里接住
    game.onExitToGate = exitToGate;
    // 开测进全屏（2026-08-19 用户拍板）：施测者中途离开时，孩子单独在机器前 ——
    // 全屏下地址栏、标签页和关闭按钮都看不见，这是唯一真正拦得住"关掉页面"的一层
    // （退出口令门管不了浏览器自己的 UI）。
    //
    // ☠️ **必须由 Game 在按钮的同步路径里调进来。** requestFullscreen 要求
    // transient user activation，放在 await 之后（比如等采集起来之后）就已经过期了，
    // 浏览器会**静默拒绝**，只在控制台留一行警告。
    //
    // ⚠️ Esc 退出全屏是浏览器强制行为，拦不掉；也没法自动重进（重进同样要手势）。
    // 那时口令门照常挡着退出，只是浏览器 UI 露出来了 —— 这是已知的缺口。
    game.onFullscreen = setFullscreen;
    game.onFps = (fps) => { fpsEl.textContent = `${fps} FPS`; };
    // 调试出口：控制台里可以直接 __game._startSession(['catcher']) 跳关、
    // __game.metrics.export() 查看当前采集到的试次数据
    window.__game = game;
  } catch (err) {
    console.error(err);
    btnDesktop.querySelector('.btn-main').textContent = '初始化失败';
    btnDesktop.querySelector('.btn-sub').textContent = String(err?.message || err);
    return;
  }

  btnDesktop.disabled = false;
  btnDesktop.querySelector('.btn-main').textContent = '开始评估';

  // WebXR 能力探测
  if (navigator.xr?.isSessionSupported) {
    try {
      xrSupported = await navigator.xr.isSessionSupported('immersive-vr');
    } catch { xrSupported = false; }
  }

  btnXR.hidden = false;
  if (xrSupported) {
    btnXR.disabled = false;
    xrSub.textContent = '已检测到 VR 设备';
    btnXRInline.hidden = false;
  } else {
    btnXR.disabled = true;
    xrSub.textContent = navigator.xr
      ? '未检测到 VR 设备'
      : '当前浏览器不支持 WebXR';
    xrHint.hidden = false;
    xrHint.innerHTML = '想进 VR：把头显用 USB 连上本机（<b>adb reverse tcp:3500 tcp:3500</b>）'
      + '后在头显浏览器打开 <b>http://localhost:3500</b>，或直接打开 <b>https://bcivr.avena.lol</b>。';
  }

  startBciWatch();
}

/* ------------------------- 顶栏的脑电设备状态 -------------------------
 *
 * 只在启动门上跑，进场后就停：它的唯一职责是让人在戴电极的时候知道"接上了没"。
 * 两个端点都问是因为它们答的不是一件事 —— /bci/status 说采集进程活着没，
 * /bci/metrics 说数据出来了没、脏不脏。只看前者会把"进程在跑但电极没贴稳"
 * 报成一切正常，而那正是最该被看见的情形（坑 #20）。
 */
let bciTimer = 0;

function setBciState(cls, text) {
  bciDot.className = `dot ${cls}`;
  bciText.textContent = text;
}

async function pollBci() {
  if (publicDemo) {
    setBciState('', '公开演示版 · 使用模拟数据');
    return;
  }
  const q = location.search;                      // EEG_TOKEN 场景下要把 ?k= 透传下去
  const get = (p) => fetch(p + q, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  const [st, mt] = await Promise.all([get('/bci/status'), get('/bci/metrics')]);

  if (!st && !mt) { setBciState('', '脑电通道不可用（请用 node serve.mjs 打开）'); return; }

  if (mt?.ok && mt.live) {
    const dirty = mt.contaminated || mt.qualityStatus === 'WARN';
    if (dirty) setBciState('bad', '脑电已连接 · 信号差，检查电极');
    else if (mt.qualityStatus === 'GOOD') setBciState('ok', '脑电已连接 · 信号良好');
    else setBciState('warn', '脑电已连接 · 信号一般');
    return;
  }
  // 上一次采集留下的 latest_metrics.json 会一直躺在那里。刚打开页面时它同样满足
  // 「ok 且不 live」，照直说"采集已停"就会变成"数据 70979s 前"这种既准确又没用的话 ——
  // 隔了夜的文件跟没插设备是一回事，别让人以为设备刚掉线。
  if (mt?.ok && !mt.live) {
    const ageSec = Math.round((mt.ageMs || 0) / 1000);
    if (ageSec < 600) setBciState('warn', `采集已停（数据 ${ageSec}s 前）`);
    else setBciState('', '未接脑电设备 · 将用模拟数据源');
    return;
  }
  if (st?.running) { setBciState('warn', '采集器已启动，正在等第一份数据'); return; }
  setBciState('', '未接脑电设备 · 将用模拟数据源');
}

function startBciWatch() {
  pollBci();
  bciTimer = setInterval(pollBci, 4000);
}

function stopBciWatch() {
  if (bciTimer) { clearInterval(bciTimer); bciTimer = 0; }
}

/* ----------------------------- 会话控制 ----------------------------- */

function hideGate() {
  gate.classList.add('hidden');
  hudDom.hidden = false;
  stopBciWatch();
}

/**
 * 回到启动门 —— 「返回」这条链的最后一跳，由 Game.requestBack() 在大厅里调进来。
 *
 * ☠️ **VR 下必须先结束 XR 会话**：启动门是 DOM，沉浸态里根本不存在（铁律 2）。
 * 不结束就等于把人留在一个什么都没有的场景里，除了摘头显没有别的出路 ——
 * 而"摘头显"正是这条返回路径要消灭的东西。
 *
 * 不重置 `started`：`game.start()` 里有 `bci.connect()` 和 `startAmbient()`，
 * 再走一遍会叠一条环境音、多一个轮询定时器。所以二次进场只是把门藏起来（见 startDesktop）。
 */
function exitToGate() {
  const session = game?.renderer?.xr?.getSession?.();
  if (session) session.end().catch(() => {});
  game?._abortToMenu();          // 停掉可能还开着的关卡/静息/演示，回到干净的大厅状态
  gate.classList.remove('hidden');
  hudDom.hidden = true;
  startBciWatch();               // 门开着的时候才需要盯设备状态
}

async function startDesktop() {
  // 已经启动过就只是把门藏起来，别再 start() 一次（见 exitToGate 的注释）
  if (started) { hideGate(); return; }
  started = true;
  hideGate();
  await game.start();
}

async function enterXR() {
  if (!game) return;
  if (!navigator.xr) { toast('当前浏览器不支持 WebXR'); return; }
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
    });
    if (!started) { started = true; hideGate(); await game.start(); }
    else hideGate();               // 从启动门二次进场（上一次是走「返回」退出来的）
    await game.renderer.xr.setSession(session);
    session.addEventListener('end', () => {
      toast('已退出 VR，回到电脑视角');
    });
    toast('已进入 VR：用手柄射线对准目标，扣扳机出手');
  } catch (err) {
    console.error(err);
    toast(`进入 VR 失败：${err?.message || err}`);
  }
}

btnDesktop.addEventListener('click', () => startDesktop());
btnXR.addEventListener('click', () => enterXR());
btnXRInline.addEventListener('click', () => enterXR());
// 走 requestBack 而不是 _abortToMenu：这个按钮和 Esc、VR 长按 B/Y 是同一条返回链，
// 各写各的必然漂移（表现是"某个入口在某个状态下没反应"，且不报错）
btnMenu.addEventListener('click', () => game?.requestBack());

// 启动门右上角那三个功能页的跳转**不在这个文件里**，是 index.html 里的一段内联脚本 ——
// 本文件是 module，要等 Three.js（2.2MB）加载完才开始执行，在那之前点那三个按钮
// 一点反应都没有。理由与写法见 index.html 里那段注释。

// 头显浏览器里常见的情况：用户直接从系统菜单进入 XR
navigator.xr?.addEventListener?.('sessiongranted', () => enterXR());

addEventListener('visibilitychange', () => {
  if (document.hidden) game?.audio?.setMasterVolume?.(0);
  else game?.audio?.setMasterVolume?.(0.5);
});

boot();
