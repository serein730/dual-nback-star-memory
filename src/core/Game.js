import * as THREE from 'three';
import { RenderRig, EYE_HEIGHT } from './RenderRig.js';
import { Assets } from './Assets.js';
import { World } from './World.js';
import { FX } from './FX.js';
import { AudioKit } from './AudioKit.js';
import { Metrics } from './Metrics.js';
import { InputHub } from './InputHub.js';
import { BCIAdapter, MockEEGSource, WebSocketEEGSource, DreamLabSource } from './BCIAdapter.js';
import { RestPhase } from './RestPhase.js';
import { Demo, demoDuration } from './Demo.js';
import {
  MenuPanel, BriefPanel, HudPanel, ResultPanel, ReportPanel, BubblePanel, RestPanel, BciPanel,
  DemoPanel, PreflightPanel, ExitGatePanel,
} from '../ui/Screens.js';
import { StarCatcher } from '../games/StarCatcher.js';
import { FocusBeam } from '../games/FocusBeam.js';
import { EchoPath } from '../games/EchoPath.js';
import { CatcherCpt } from '../games/CatcherCpt.js';
import { DelayWell } from '../games/DelayWell.js';
import { UfovFocus } from '../games/UfovFocus.js';
import { DualNBack } from '../games/DualNBack.js';
import { Kinematics } from './Kinematics.js';

const GAMES = {
  catcher: StarCatcher, beam: FocusBeam, echo: EchoPath,
  cpt: CatcherCpt, delay: DelayWell,
  ufov: UfovFocus,
  nback: DualNBack,
};
/** 体验档：三个自适应模块。指标只能个体内比较。 */
const ORDER = ['catcher', 'beam', 'echo'];
/**
 * 测评档：固定试次的标准化流程，两关分别打在 ADHD 双通路模型的两条通路上 ——
 * `cpt` 测执行功能（持续注意 / 反应抑制），`delay` 测延迟厌恶。
 * 只测前者会系统性地漏掉"执行功能没问题、但等不了"的那一半孩子。
 *
 * ⚠️ **顺序写死，且 delay 必须排在 cpt 之后**（2026-08-08 用户拍板）：
 * cpt 是两关里唯一参数可追溯到文献的，要保住它的施测条件不被前置任务改掉。
 * 代价是延迟选择受 8 分 18 秒任务后的疲劳影响 —— 这个混淆已写进报告与导出，
 * **不要为了"让延迟任务更干净"就把顺序调过来**，那是拿主测量去换次测量。
 */
const ASSESS_ORDER = ['cpt', 'delay'];
/**
 * 老年训练档（2026-08-21 拍板，见 `决策存档/2026-08-21-老年版块方向与依据.md`）。
 * 与上面两档的根本差别：它是**训练**不是测评 —— 剂量 30 分钟 × 5 次/周 × 8 周 = 20 小时，
 * 产出的是「呈现时长阈值」而不是正确率/d′。
 *
 * ✅ **2026-08-22 已接成第三档**（用户拍板）：菜单第二个键 → `_openPreflight(TRAIN_ORDER,'train',…)`，
 * 结算走 `_levelStats`/`_levelTip` 的 `ufov` 分支，报告走 `_showTrainReport()`，
 * 「再来一次」回本档。档位判定从 `isAssess` 一个布尔改成 `isAssess`/`isTrain`/`noFeedback` 三个 —— 见那段注释。
 *
 * ⚠️ **调试进这一档要用 `'train'`，别再写 `'single'`**：
 *   `__game._startSession(['ufov'], 'train', { rest: false, demo: false })`
 * 写 `'single'` 时 `isTrain` 为假，会走成体验档 —— 报告页拿到的是儿童版那套卡片与
 * **写反了的免责声明**，而画面照常出得来。
 *
 * ⚠️ 仍**别**把 `ufov` 塞进 `ORDER` 或 `ASSESS_ORDER`：那两档的指标口径与免责声明都不适用它。
 */
const TRAIN_ORDER = ['ufov'];
/** 双模态星忆先做图形引导，再由老师/儿童选择第 1、2 或 3 关；记录仅作同一儿童纵向追踪。 */
const NBACK_ORDER = ['nback'];
// GitHub Pages 的公开版本只用于游戏演示：不接设备、不建被试、不向服务端归档。
// ?publicDemo=1 让本机也能沿用同一条公开演示路径验收。
const PUBLIC_DEMO = location.hostname.endsWith('.github.io')
  || new URLSearchParams(location.search).get('publicDemo') === '1';

/** ⚠️ 加新状态是三处联动：这里 + `_setState()` 的 switch + `requestBack()` 的分支。 */
const STATE = {
  MENU: 'menu',
  PREFLIGHT: 'preflight',
  DEMO: 'demo',
  REST: 'rest',
  BRIEF: 'brief',
  COUNTDOWN: 'countdown',
  PLAY: 'play',
  RESULT: 'result',
  REPORT: 'report',
  BCI: 'bci',
  /**
   * 中途退出的口令门（2026-08-19）。**它是覆盖在别的状态之上的一层**：
   * `_gateFrom` 记着从哪个状态进来的，取消就退回去。
   * 关卡因此自动暂停 —— `_frame()` 只在 `STATE.PLAY` 下 update 关卡，
   * 而这是刻意的：孩子按退出的那一刻已经不在任务上了，让关卡继续跑只会
   * 产出一串假的漏报。中断本身会打点记进波形（见 `_openExitGate`）。
   */
  EXITGATE: 'exitgate',
};

/** 吉祥物台词。同一个事件准备多句，避免重复感；全部是鼓励导向，不评判孩子。 */
const LINES = {
  menu: ['我是小北，今天我们测测注意力！', '选一个开始吧，我陪着你。', '准备好了吗？慢慢来，稳一点更好。'],
  commission: ['稳住～看清楚再出手', '这个是陨石哦，忍住', '深呼吸，不着急'],
  omission: ['刚刚那个溜走啦', '眼睛跟着水晶走', '没事，下一个接住它'],
  lapse: ['我们回到这里来', '看看我这边，重新开始', '休息一下下，再出发'],
  praise: ['太棒了！', '就是这个感觉！', '你越来越稳了！', '厉害，保持住！'],
  levelEnd: ['这一关完成啦！', '干得漂亮！', '休息一下，看看成绩'],
  // 测评档的段间用语。**只夸坚持，不评表现** —— 说一句"这段做得不错"就是给了
  // 对错反馈，后面几段测的就不是同一个任务了（见 CatcherCpt.js 文件头 ③）。
  assessBreak: ['休息一下，甩甩胳膊', '喝口水，马上继续', '很好，我们接着来'],
  // 回声之路每轮开演时的引导语。**只报趋势不报数量** —— 说"这一轮 5 个"
  // 会把孩子的注意力从"顺序"引到"计数"上。趋势由关卡的 trend 字段给。
  echoShow: {
    first: '看好顺序，我先走一遍',
    up: '变长了，看好啦！',
    same: '再来一次，看好顺序',
    down: '这次短一点，别急',
  },
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class Game {
  constructor() {
    this.rig = new RenderRig();
    this.scene = this.rig.scene;
    this.camera = this.rig.camera;
    this.renderer = this.rig.renderer;

    this.assets = new Assets('high');
    this.world = new World(this.scene, this.assets);
    this.fx = new FX(this.scene);
    this.audio = new AudioKit();
    this.metrics = new Metrics();
    // 头部运动学（"多动"维度）。只在标注了 meta.kinematics 的关卡里采，
    // 而且**桌面端采不到真实头动**（相机是固定机位）—— 见 Kinematics.js 文件头
    this.kin = new Kinematics();
    // ★ **默认真机源**（2026-08-12 用户拍板，此前默认是模拟源）。
    //
    // 理由是施测现场的默认应该是"要采数据"，而不是"先演示一下" —— 停在模拟源上
    // 跑完一整场，拿回来的脑电是编的，而报告页事后看不出这一场是模拟的。
    //
    // ⚠️ **代价写在这里，别让下一个人重新发现**：没有设备的机器上，DreamLabSource
    // 连不上不会自己回退（那是 `_cycleBci` 里刻意保留的行为：静默回退会让人以为
    // 真机接上了）。所以 clone 下来直接跑的人会看到「开始前确认」右栏一片红 ——
    // 铁律 3 的判据仍然满足（点一下「切换数据源」就能玩），但**多了一步**。
    // 这一步是故意的：它把"这一场没有真脑电"从静默变成了必须动手确认。
    // 公开站没有同源采集服务，必须主动选模拟源；否则请求失败后的降级逻辑会把
    // 专注度钉在 50，看起来像没有动态显示。
    this.bci = new BCIAdapter(PUBLIC_DEMO ? new MockEEGSource() : new DreamLabSource());
    this.input = new InputHub({
      renderer: this.renderer, camera: this.camera, scene: this.scene, audio: this.audio,
      // 手柄必须跟相机同一个父节点（见 InputHub._bindXR 的 ⚠️）
      playerRig: this.rig.playerRig,
    });
    // 关卡演示：每一关开打前先把规则演一遍。**目标用户里有一部分还不认字**，
    // 说明页那三行文字对他们等于空白（见 Demo.js 文件头）
    this.demo = new Demo({
      scene: this.scene, assets: this.assets, fx: this.fx, audio: this.audio, camera: this.camera,
    });

    this.state = STATE.MENU;
    // 本机采集进程的状态。只在脑电设置页轮询（见 _frame），别处不关心
    this._collector = { running: false, peer: null };
    this.queue = [];
    this.current = null;
    this.progress = {};        // gameId -> stars
    this.sessionMode = 'full';
    // 用 Timer 而不是已废弃的 Clock：它按 setAnimationLoop 传入的时间戳推进，
    // 在 XR 会话里跟的是头显的帧时钟，比自己读 performance.now() 更贴合合成器节奏
    this.timer = new THREE.Timer();
    this.fpsAcc = 0; this.fpsFrames = 0;

    this._buildUI();
    this._buildMascot();
    this._buildRest();
    this._wireEvents();

    this.rig.onQualityChange = (q) => {
      this.assets.setQuality(q);
      this.world.setQuality(q);
    };
    // 头显浏览器在 RenderRig 构造时就已经定成低画质了，那会儿这个回调还不存在，
    // 补一次才能真正落到材质上（桌面是 high，这一下是空操作）
    this.rig.syncQuality();
  }

  /* ------------------------------ 构建 ------------------------------ */

  _buildUI() {
    const metas = [...ORDER, ...NBACK_ORDER].map((id) => GAMES[id].meta);

    // 面板距离 2.2~2.6m：VR 里这是舒适的阅读距离（再近会有辐辏冲突，再远看不清小字），
    // 桌面端在这个距离上面板刚好占据约一半画面宽度
    this.menu = new MenuPanel(metas);
    this.menu.position.set(0, 1.52, -2.38);

    this.brief = new BriefPanel();
    this.brief.position.set(0, 1.5, -2.22);

    this.hud = new HudPanel();
    this.hud.position.set(0, 2.55, -2.7);
    this.hud.rotation.x = 0.24;

    /*
     * 关卡进行中的信号灯。
     *
     * ☠️ **绝不能画进 HUD 画布。** 那张画布 1645×350，每次重传在 Pico 4 上约 25ms
     * 管线停顿 —— 实测把 VR 帧率从 48 打到 23。信号质量是**连续变化**的量，画进去
     * 等于每秒触发数次重传。所以按那条 rule 的第三点做成独立 3D 面片：
     * 改 `material.color` 不碰任何纹理，零上传。
     *
     * 位置在 HUD（宽 2.35）左端外侧一点，不占版面、余光扫得到。
     */
    this.sigDot = new THREE.Mesh(
      new THREE.CircleGeometry(0.03, 20),
      new THREE.MeshBasicMaterial({ color: 0x3ad29f, transparent: true, opacity: 0.92 }),
    );
    this.sigDot.position.set(-1.26, 2.55, -2.69);
    this.sigDot.rotation.x = 0.24;
    this.sigDot.visible = false;
    this.scene.add(this.sigDot);
    this._sigBand = -1;

    // 演示字幕条借用 HUD 的槽位：那是全场唯一确定不挡关卡道具的空档
    // （光束聚焦上排符文石的顶已经顶到那儿了），而且孩子过一会儿就会在同一个
    // 位置看到 HUD —— 视线不用重新学一遍
    this.demoPanel = new DemoPanel();
    this.demoPanel.position.set(0, 2.58, -2.72);
    this.demoPanel.rotation.x = 0.24;

    this.result = new ResultPanel();
    this.result.position.set(0, 1.52, -2.28);

    this.report = new ReportPanel();
    this.report.position.set(0, 1.6, -2.55);

    // 脑电设置与主菜单同一个位置：它是从菜单点进来的一层，位置一致才不会有"跳一下"的感觉。
    // ⚠️ 2026-08-12 起菜单上没有它的入口了，唯一入口是「开始前确认」页的「信号详情」。
    this.bciPanel = new BciPanel();
    this.bciPanel.position.copy(this.menu.position);

    // 开始前确认：每次开测都要经过它（2026-08-12 用户拍板"不检测、一律硬弹"）。
    // 位置同菜单，理由同上
    this.preflight = new PreflightPanel();
    this.preflight.position.copy(this.menu.position);

    // 静息页压在呼吸环（z = -2.35）前面一点，让文字始终盖在光环之上
    this.restPanel = new RestPanel();
    this.restPanel.position.set(0, 1.5, -2.3);
    this.restPanel.plane.renderOrder = 6;

    // 退出口令门。位置比别的面板更靠近相机、也更高一点：它是盖在正在进行的关卡
    // 之上的一层，摆在关卡任务区的深度上会和场景里的道具穿插
    this.exitGate = new ExitGatePanel();
    this.exitGate.position.set(0, 1.55, -1.95);
    this.exitGate.plane.renderOrder = 8;

    this.bubble = new BubblePanel();
    this.bubble.position.set(-1.74, 1.58, -2.36);
    this.bubble.rotation.y = 0.26;

    this.panels = [
      this.menu, this.demoPanel, this.restPanel, this.brief, this.hud, this.result,
      this.report, this.bciPanel, this.preflight, this.exitGate,
    ];
    for (const p of [...this.panels, this.bubble]) {
      p.visible = false;
      this.scene.add(p);
    }
    this.menu.visible = true;
  }

  _buildMascot() {
    this.mascot = this.assets.mascot();
    this.mascot.scale.setScalar(0.68);
    this.mascot.position.set(-1.88, 0.92, -2.42);
    this.mascot.rotation.y = 0.34;
    this.scene.add(this.mascot);
    this._bubbleTimer = 0;
  }

  _buildRest() {
    this.rest = new RestPhase({
      scene: this.scene,
      assets: this.assets,
      audio: this.audio,
      fx: this.fx,
      world: this.world,
      bci: this.bci,
      metrics: this.metrics,
      mascot: this.mascot,
      say: (msg, sec) => this.say(msg, sec),
    });
  }

  _wireEvents() {
    this.input.onEscape(() => this.requestBack());

    /* ---- 「开始前确认」页的两个桌面专属交互 ----
     *
     * ⚠️ **两个都在 VR 里不存在**（头显没有键盘、没有滚轮）。2026-08-12 用户明确
     * "先不做 VR 里的"，所以这里不为 VR 做等价物；要补的话是给年份加 ± 键
     * （已经有了）和给列表加翻页按钮（没做）。别在别处再加一份键盘处理。
     */
    this.input.onAny((code) => {
      if (this.state !== STATE.PREFLIGHT || !this._pf?.yearEditing) return;
      const p = this._pf;
      const digit = /^(Digit|Numpad)(\d)$/.exec(code);
      if (digit) {
        if (p.yearBuf.length < 4) p.yearBuf += digit[2];
        // 敲满 4 位就直接落值，省掉一次回车
        if (p.yearBuf.length === 4) this._commitYear();
        else this._pushPreflight();
        return;
      }
      if (code === 'Backspace') { p.yearBuf = p.yearBuf.slice(0, -1); this._pushPreflight(); return; }
      if (code === 'Enter' || code === 'NumpadEnter') { this._commitYear(); }
    });

    /* ---- 退出口令的键盘输入（桌面专属，理由同上）----
     *
     * 用 `e.key` 而不是 `code`：口令是字符串，而 `code` 给的是物理键位。
     * 面板上只画圆点不回显字符 —— 孩子就站在旁边看着施测者敲。
     */
    this.input.onAny((code, e) => {
      if (this.state !== STATE.EXITGATE) return;
      if (code === 'Backspace') {
        this._gateBuf = (this._gateBuf || '').slice(0, -1);
        this.exitGate.setInfo({ len: this._gateBuf.length, error: '' });
        return;
      }
      if (code === 'Enter' || code === 'NumpadEnter') { this._submitExitGate(); return; }
      // 只收单字符可打印键；限长挡住孩子按住不放糊满一屏
      const ch = e?.key;
      if (typeof ch === 'string' && ch.length === 1 && (this._gateBuf || '').length < 64) {
        this._gateBuf = (this._gateBuf || '') + ch;
        this.exitGate.setInfo({ len: this._gateBuf.length, error: '' });
      }
    });

    // 被试多了要能翻。这个状态下没有别的可滚的东西，所以不判断指针位置
    addEventListener('wheel', (e) => {
      if (this.state !== STATE.PREFLIGHT || !this._pf) return;
      const n = this._pf.subjects.length;
      if (n <= 4) return;
      const next = this._pf.scroll + (e.deltaY > 0 ? 1 : -1);
      this._pf.scroll = Math.max(0, Math.min(next, n - 4));
      this._pushPreflight();
    }, { passive: true });

    // 长按 B/Y 刚起手时给一句话。**必须走气泡不走 toast** —— 沉浸态里 DOM 看不见。
    // 文案要跟着当前这一层走：在大厅里按下去是「离开 3D 世界」，不是「回大厅」
    this.input.onMenuHint(() => {
      this.say(this.state === STATE.MENU ? '再按住一会儿就退出～' : '再按住一会儿就回大厅～', 2);
    });

    this.bci.on((e) => {
      if (e.type === 'attention-lapse' && this.state === STATE.PLAY) {
        this.say(pick(LINES.lapse), 2.6);
        this.assets.setMascotMood(this.mascot, 'wow');
      }
    });

    // 关卡回调：让吉祥物对孩子的行为即时回应
    this.gameEvents = (e) => {
      if (e.type === 'commission') this.say(pick(LINES.commission), 1.8);
      else if (e.type === 'omission' && Math.random() < 0.4) this.say(pick(LINES.omission), 1.6);
      // 不报数量："这一轮 5 个"会把注意力从顺序引到计数上。只报趋势。
      else if (e.type === 'echo-show') this.say(LINES.echoShow[e.trend] || LINES.echoShow.first, 1.7);
      else if (e.type === 'echo-recall') this.say('该你啦！', 1.2);
      else if (e.type === 'assess-block') {
        this.say(e.index === 0 ? '开始啦，看好正前方' : pick(LINES.assessBreak), 3);
      } else if (e.type === 'nback-stardust') {
        this.say(e.combo >= 3 ? `连续 ${e.combo} 次，飞船加速！` : '太棒啦，星尘收集成功！', 2);
      } else if (e.type === 'nback-support') {
        this.say('没关系，我们从第一个重新记', 2.8);
      }
    };
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  async start() {
    this.audio.unlock();
    this.audio.startAmbient();
    await this.bci.connect();
    this.say(pick(LINES.menu), 4);
    this.renderer.setAnimationLoop((t, frame) => this._frame(t, frame));
  }

  /**
   * 「返回」的统一语义：**层层后退，退到大厅再按一次就离开 3D 世界回启动门。**
   *
   * 三个入口全部走这里 —— 桌面 Esc、VR 长按 B/Y、右上角那个 DOM 按钮。
   * 分开写的话三处迟早漂移，而漂移的表现是"某一个入口在某一个状态下没反应"，
   * 没有任何报错（这正是它之前的样子：大厅里三个入口都是空操作，人进了大厅就出不去，
   * VR 下只能摘头显）。
   *
   * 最后一跳交给 `onExitToGate`，由 main.js 注入：启动门是 DOM，而 Game 不碰 DOM。
   */
  requestBack() {
    // 正在用键盘改年份时，Esc 先退出编辑而不是退出整页 —— 否则改错一位数字
    // 想取消，代价是整个「开始前确认」重来一遍
    if (this.state === STATE.PREFLIGHT && this._pf?.yearEditing) {
      this._pf.yearEditing = false;
      this._pf.yearBuf = '';
      this._pushPreflight();
      return;
    }
    // 脑电详情是从「开始前确认」进去的一层，退回它而不是一路退到大厅 ——
    // 否则去看一眼信号就把刚选好的被试与档位丢了
    if (this.state === STATE.BCI) { this._setState(STATE.PREFLIGHT); return; }
    // 口令门开着时，Esc 只关掉这一页、回到刚才那个状态 ——
    // ☠️ **绝不能在这里继续往下走**，否则孩子连按两下 Esc 就退出去了
    if (this.state === STATE.EXITGATE) { this._closeExitGate(); return; }
    // 这两个状态没有"进行中的东西"要中止，直接退一层
    if (this.state === STATE.PREFLIGHT || this.state === STATE.REPORT) { this._setState(STATE.MENU); return; }
    // 已经在大厅：再退就是离开 3D 世界。VR 下 main.js 会先结束 XR 会话，
    // 否则人还留在沉浸态里，而启动门在那里根本不存在
    if (this.state === STATE.MENU) { this.onExitToGate?.(); return; }
    // 真机采集中要口令才放行（见 _needsExitGate）。这里是**唯一的返回链**，
    // 所以三个入口（Esc / 右上角按钮 / VR 长按）一次全挡住
    if (this._needsExitGate()) { this._openExitGate(); return; }
    this._abortToMenu();
  }

  /* --------------------------- 中途退出的口令门 ---------------------------
   *
   * 判据是**真机源 + 会话进行中**，两个都要：
   *   · 模拟源下退出不会损失任何真实数据，弹口令只是在挡演示和联调；
   *   · 不在会话里（大厅、报告页、脑电页）本来就没有"进行中的测评"可作废。
   * VR 只剩演示门面、不做真实采集，所以判据在头显里天然不成立 —— 不必特判。
   */
  _needsExitGate() {
    // 双模态星忆是可随时停止的训练体验：不让儿童被口令页困住。
    // 固定测评等其他真机采集流程仍保留老师确认，避免误中断正式数据采集。
    return this.sessionMode !== 'nback' && this._sessionActive && (this.bci?.source instanceof DreamLabSource);
  }

  _openExitGate() {
    if (this.state === STATE.EXITGATE) return;
    this._gateFrom = this.state;
    this._gateBuf = '';
    this.exitGate.setInfo({ len: 0, error: '', checking: false });
    // 中断本身是施测条件的一部分，要能在波形上看见：孩子在第几分钟按了退出、
    // 停了多久再继续，事后只有这条打点说得清（`_mark` 自己会判会话是否还开着）
    this._mark('exit-gate', { detail: 'open' });
    this._setState(STATE.EXITGATE);
    this.say('要退出的话，请老师输入口令', 4);
  }

  /** 取消退出，回到刚才那个状态。关卡从暂停处继续。 */
  _closeExitGate() {
    const back = this._gateFrom || STATE.MENU;
    this._gateBuf = '';
    this._gateFrom = null;
    this._mark('exit-gate', { detail: 'cancel' });
    this._setState(back);
  }

  /**
   * 口令校验走服务端（`POST /data/admin-check`），前端只拿一个 true/false。
   * 放服务端只为挡一件事：孩子按 F12 翻前端代码。见 serve.mjs 的 ADMIN_PASSWORD。
   */
  async _submitExitGate() {
    if (this._gateChecking) return;
    const password = this._gateBuf || '';
    if (!password) { this.exitGate.setInfo({ error: '还没输入口令' }); return; }
    this._gateChecking = true;
    this.exitGate.setInfo({ checking: true, error: '' });
    let pass = false;
    try {
      const r = await fetch('/data/admin-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      pass = !!(await r.json())?.pass;
    } catch {
      // 服务端联系不上时**不放行**：这条路一旦在出错时默认通过，
      // 拔掉网线就等于绕过口令
      this.exitGate.setInfo({ checking: false, error: '联系不上服务端，没法核对口令' });
      this._gateChecking = false;
      return;
    }
    this._gateChecking = false;
    if (!pass) {
      // 提示保持平淡、不限次数：限次只会把施测者自己锁死，
      // 而语气越戏剧化，孩子越会把它当成一个值得反复试的游戏
      this._gateBuf = '';
      this.exitGate.setInfo({ len: 0, checking: false, error: '口令不对' });
      return;
    }
    this._mark('exit-gate', { detail: 'pass' });
    this._gateFrom = null;
    this._gateBuf = '';
    this._abortToMenu();   // 全屏在它里面退
  }

  say(msg, seconds = 3) {
    this.bubble.say(msg);
    this.bubble.visible = true;
    this._bubbleTimer = seconds;
  }

  /* ------------------------------ 状态机 ------------------------------ */

  _setState(s) {
    this.state = s;
    // 打点，把"这一刻在做什么"记进指标时间轴（见 Metrics.markPhase）。
    // 只有和关卡相关的几段才带关卡 id：PLAY 时 current 已就位，DEMO/BRIEF/COUNTDOWN 用
    // pendingId —— 那几段虽然一个试次都没有，却同样要能按关卡归属。
    // 菜单/报告/脑电页不带，否则会留下 `menu:beam` 这种上一关的残影。
    const withLevel = s === STATE.DEMO || s === STATE.BRIEF || s === STATE.COUNTDOWN
      || s === STATE.PLAY || s === STATE.RESULT;
    const levelId = withLevel ? (this.current?.meta?.id ?? this.pendingId ?? null) : null;
    this.metrics.markPhase(s, levelId);
    // 同一次打点也推给采集器，让它落到原始波形的样本上。label 的构成与
    // `Metrics.export()` 里 eeg.byPhase 的键**保持一致**（`phase:game`），
    // 这样波形的 marker 列和报告里的分段摘要能直接对上，不用再做一次映射
    this._mark('phase', { label: levelId ? `${s}:${levelId}` : s, phase: s, game: levelId });
    for (const p of this.panels) p.show(false);
    switch (s) {
      case STATE.MENU:
        this.menu.setProgress(this.progress);
        this.menu.show(true);
        this._mascotSpot('side');
        break;
      case STATE.DEMO:
        this.demoPanel.show(true);
        // 用 corner 而不是 side：演示展示的就是任务区，而 side 位（-1.88, 0.92）
        // 正好站在光束聚焦候选阵列最左那颗前面，把它连同光标一起挡住。
        // corner 位存在的理由本来就是"不挡任务区又留在视野里"，演示适用同一条。
        this._mascotSpot('corner');
        break;
      case STATE.REST:
        this.restPanel.show(true);
        this._mascotSpot('side');
        break;
      case STATE.BRIEF:
        this.brief.show(true);
        this._mascotSpot('side');
        break;
      case STATE.COUNTDOWN:
        this.brief.show(true);
        break;
      case STATE.PLAY:
        this.hud.show(true);
        this._mascotSpot('corner');
        break;
      case STATE.RESULT:
        this.result.show(true);
        this._mascotSpot('side');
        break;
      case STATE.REPORT:
        this.report.show(true);
        this._mascotSpot('side');
        break;
      case STATE.PREFLIGHT:
        this._pollCollector();      // 异步，先用上一次的状态画，回来后下一帧就刷新
        this._pushPreflight();
        this.preflight.show(true);
        this._mascotSpot('side');
        break;
      case STATE.BCI:
        this._pollCollector();      // 异步，先用上一次的状态画，回来后下一帧就刷新
        this._pushBciUi();
        this.bciPanel.show(true);
        this._mascotSpot('side');
        this.say('把电极贴稳，看这里的信号条', 3);
        break;
      case STATE.EXITGATE:
        // HUD 留着不藏：孩子看得见"测评还在这儿"，比整块画面被一个对话框吃掉更安心
        if (this._gateFrom === STATE.PLAY) this.hud.show(true);
        this.exitGate.show(true);
        this._mascotSpot('side');
        break;
      default: break;
    }
  }

  _mascotSpot(where) {
    // corner 位要同时满足两件事：不挡任务区，又必须留在视野里 ——
    // 关卡中的鼓励和纠正都靠它头顶的气泡说，跑到画面外就等于反馈没了
    const target = where === 'corner'
      ? new THREE.Vector3(-2.35, 0.55, -2.4)
      : new THREE.Vector3(-1.88, 0.92, -2.42);
    this._mascotTarget = target;
    this.bubble.position.set(target.x + 0.14, target.y + 0.88, target.z + 0.06);
  }

  /**
   * @param {string[]} ids   关卡队列
   * @param {string}   mode  'assess'（固定难度测评档）| 'train'（老年训练档）| 'full' | 'single'（自适应体验档）
   * @param {object}   opt   rest=false 跳过静息、demo=false 跳过演示（都是调试用）
   */
  async _startSession(ids, mode = 'full', { rest = true, demo = true } = {}) {
    // 防重入：启动采集要几十秒，这期间菜单按钮还是点得动的，连点两下会起两条流程
    if (this._starting) return false;
    this._starting = true;
    try {
      // 真机源下必须先把采集拉起来，起不来就**硬拦**（2026-08-09 用户拍板）。
      // 理由是没有脑电的那一场事后无法补采，而"连上了但没数据"这种失败在现场
      // 极难当场察觉 —— 宁可卡在开始前，也不要跑完 8 分钟才发现整场没脑电。
      if (!this.isPublicDemo) {
        if (!await this._ensureCollector()) return false;
        // 认领这条流。要在开测的这一刻发，见 _claimRun
        this._claimRun();
      }
    } finally {
      this._starting = false;
    }
    // 正常路径（_endLevel / _abortToMenu）进来时 current 已经是 null，这行不做事。
    // 它挡的是**调试跳关**：CLAUDE.md 把 _startSession 列为 __game 上的调试出口，
    // 在关卡进行中直接调，旧关卡的 root 就会留在场景里 —— 上一关的柱子和这一关的
    // 水晶同框，而且**显存计数看不出来**（残留 root 里全是共享几何，dispose 不触发），
    // 所以"三关来回 N 轮看 renderer.info"这条验收方法抓不到它。
    if (this.current) { this.current.exit(); this.current = null; }
    this.demo.exit();
    this.metrics.reset();
    this.kin.reset();
    // 会话从这一刻算起：_frame 开始留档脑电快照（含静息与演示段），
    // 墙上时间戳则是把这一场和采集器那边的原始波形对上的唯一依据
    this._sessionActive = true;
    this._sessionStartedAtUnix = Date.now();
    this._archived = false;
    // 本场的归档 id。第一个存档点由服务端生成并回传，之后所有存档点与最终归档
    // 都带着它 —— 落在同一个目录里互相覆盖，而不是一关堆一个目录
    this._sessionId = null;
    // ☠️ `Kinematics.start()` 内部会 reset —— 一场里有两个采头动的关卡时，
    // 第二关一开始就把第一关的采样冲掉了，而报告和导出都只会拿到最后一关的数字，
    // **看上去完全正常**。所以每一关结束时在 _endLevel 里存一份快照，按关卡 id 收着。
    this.kinByGame = {};
    this.queue = ids.slice();
    // 队列会被 shift 空，但导出时还要知道本场原本安排了哪几关
    this.sessionIds = ids.slice();
    this.sessionMode = mode;
    // 静息**排在第一段演示之后**（2026-08-07 用户拍板）。演示是会让孩子兴奋起来的，
    // 呼吸正好把那股劲压回基线再开测 —— 反过来（先呼吸再看演示）就是花 40 秒
    // 把唤醒度压下去，然后当场又抬上来。整场仍然只做一次静息。
    this._pendingRest = rest;
    this._demoEnabled = demo;
    this._demoWatched = 0;
    this._demoPlays = 0;
    this._nextInQueue();
  }

  /*
   * ☠️ **档位从"一个布尔"变成"三选一"（2026-08-22）。加老年训练档时改的。**
   *
   * 在这之前全项目靠 `isAssess` 一个布尔分两档，隐含前提是「不是测评档就是体验档」。
   * 第三档一进来，这个前提在**每一处**都不再成立，而漏掉任何一处**都不报错**：
   * 最隐蔽的是 `_onButton('again')` —— 老人打完点「再来一次」会掉进儿童版那三关，
   * 两档数据不可互相比较，报告却看起来完全正常。
   *
   * ⚠️ **新增读取点时先想清楚要的是哪一个**：
   *   · `isAssess` —— 只有测评档为真。用于"这一档的规矩/报告口径"。
   *   · `isTrain`  —— 只有老年训练档为真。
   *   · `noFeedback` —— 测评档 **或** 训练档。用于"不回显表现"这件事本身。
   *     两档的**理由不同**（测评档怕污染测量、训练档怕刻板印象威胁），但要的行为一样；
   *     哪天理由分家了就把用到它的地方拆开，别硬合。
   * `sessionMode` 的取值：`assess` / `train` / `nback` / `full` / `single`。
   * `nback` 是儿童工作记忆纵向追踪档，仍属自适应、无常模，不与固定测评档混用。
   */
  get isAssess() { return this.sessionMode === 'assess'; }
  get isTrain() { return this.sessionMode === 'train'; }
  get isPublicDemo() { return PUBLIC_DEMO; }
  get noFeedback() { return this.isAssess || this.isTrain; }

  /*
   * ☠️ **本场的数据落哪棵树。** `data/` 下按人群分成两棵完整的树（`child` / `elder`），
   * 各有自己的 `sessions/`、`index.db`、`subjects.json`，**被试编号也各自发号**
   * —— 两边都可能有 `S-001`，那不是同一个人。
   *
   * ⚠️ **每一处 `/data/*` 请求都必须带上它**（用 `_dataUrl()`）。服务端缺参数时一律
   * 当 `child`，所以漏带的表现不是报错，是**老年的数据静静地写进了儿童库**。
   *
   * 为什么要看 `_pendingRun`：开测前停在 `PREFLIGHT` 页选被试时，`sessionMode` 还是
   * **上一场**的值（它要到 `_startSession` 才更新）。那一页拉的正是被试列表，
   * 用错了就会把儿童的编号列给老年施测者看。
   */
  get cohort() {
    const mode = this.state === STATE.PREFLIGHT
      ? (this._pendingRun?.mode || this.sessionMode)
      : this.sessionMode;
    return mode === 'train' ? 'elder' : 'child';
  }

  /** 拼 `/data/*` 的地址，自动带上人群。**别再手写裸的 `/data/xxx`**。 */
  _dataUrl(sub) {
    return `/data/${sub}${sub.includes('?') ? '&' : '?'}cohort=${this.cohort}`;
  }

  /**
   * 静息环节安排在整场会话的最前面、且只做一次。
   * 每关前都来一遍的话，三关就是三次 —— 仪式一旦变成负担就失效了；
   * 而基线只需要采一次，采多了反而会被前一关的余温污染。
   */
  _beginRest() {
    this._setState(STATE.REST);
    this.rest.enter();
  }

  _endRest() {
    this.rest.exit();
    this._toBrief();
  }

  /**
   * 取下一关。顺序是 **演示 →（仅第一次）静息 → 说明**。
   * 队列在这里就被 shift 掉，`pendingId` 之后一路带到 `_launch()`。
   */
  _nextInQueue() {
    const id = this.queue.shift();
    if (!id) { this._showReport(); return; }
    this.pendingId = id;
    if (this._demoEnabled && demoDuration(id) > 0) { this._beginDemo(id); return; }
    if (this._pendingRest) { this._pendingRest = false; this._beginRest(); return; }
    this._toBrief();
  }

  _beginDemo(id) {
    this.demo.setGame(GAMES[id].meta);
    this.demo.enter(id);
    this.demoPanel.set(this.demo.uiState);
    this._setState(STATE.DEMO);
    this.say('先看我玩一遍～', 3);
  }

  /**
   * 演示结束（自然播完 / 点「跳过」）。
   * 第一段演示之后要接静息，之后每一段都直接进说明页。
   * 从说明页点「再看演示」回来时 `_pendingRest` 已经是 false，所以会正确地回到说明页。
   */
  /**
   * 记下孩子**实际**看了多久演示（提前跳过、反复重看都算进来）。
   * 这不是统计癖：看过演示和没看过的孩子，头二十个试次根本不是同一件事，
   * 而那几个试次正落在警觉度曲线最前面。导出 JSON 里必须留下这一段的痕迹，
   * 否则拿到数据的人无从知道两份记录的施测条件其实不一样。
   */
  _creditDemo() {
    const cap = this.demo.script?.duration ?? this.demo.t;
    this._demoWatched = (this._demoWatched || 0) + Math.min(this.demo.t, cap);
    this._demoPlays = (this._demoPlays || 0) + 1;
  }

  _endDemo() {
    this._creditDemo();
    this.demo.exit();
    if (this._pendingRest) { this._pendingRest = false; this._beginRest(); return; }
    this._toBrief();
  }

  _toBrief() {
    const meta = GAMES[this.pendingId].meta;
    this.brief.setGame(meta);
    this._setState(STATE.BRIEF);
    this.say(`下一关：${meta.name}`, 3);
  }

  _beginCountdown() {
    this._setState(STATE.COUNTDOWN);
    this.countdown = 3;
    this.countdownT = 0;
    this.brief.setCountdown(3);
    this.audio.countdown(3);
  }

  _launch(id) {
    const Klass = GAMES[id];
    this.current = new Klass({
      scene: this.scene,
      assets: this.assets,
      fx: this.fx,
      audio: this.audio,
      metrics: this.metrics,
      kin: this.kin,
      bci: this.bci,
      world: this.world,
      input: this.input,
      camera: this.camera,
      sessionMode: this.sessionMode,
      onEvent: this.gameEvents,
      // ⚠️ ctx 是**显式列出来的对象**，不是 Game 本身 —— 关卡要用的每个东西都得
      // 在这里点名。`MiniGame.logTrial()` 里的试次打点靠它，漏了就是
      // `this.ctx._mark?.()` 恒为 undefined：一条试次都不会落到波形上，**且不报错**。
      _mark: (type, extra) => this._mark(type, extra),
    });
    if (Klass.meta.kinematics) {
      this.kin.start(this.renderer.xr.isPresenting ? 'xr' : 'desktop');
    }
    this.current.enter();
    this._setState(STATE.PLAY);
  }

  _endLevel() {
    const g = this.current;
    if (!g) return;
    const id = g.meta.id;
    const s = this.metrics.summary(id);
    const assess = !!g.meta.assess;
    // ⚠️ 这里判的是**关卡**的档位标记，不是会话的 `sessionMode` —— 结算页跟着刚打完的
    // 那一关走。`noScore` 是"这一关不给星、不给评价"的两档合集（理由见 isAssess 那段）。
    const train = !!g.meta.train;
    const noScore = assess || train;
    if (g.meta.kinematics) {
      this.kin.stop();
      // 下一关 start() 会清空采样，所以快照必须在这里取（见 _startSession 的注释）
      (this.kinByGame ??= {})[id] = this.kin.report();
    }

    // ⚠️ 阈值必须在 `g.exit()` **之前**存下来。报告页跑在 `_showReport()` 里，那时
    // `this.current` 已经是 null、关卡对象也没人再持有 —— 同 `_echoPeak` 的处境。
    // 存快照而不是存关卡引用：关卡的几何/材质都已 dispose，留着引用只会让人误以为还能读。
    if (id === 'ufov') {
      this._ufov = {
        thresholdSteps: g.thresholdSteps,
        thresholdMs: g.thresholdMs,
        trials: g.trialNo,
        answered: g.answered,
        refreshHz: g.refreshHz,
        framesPerStep: g.framesPerStep,
        tracks: g.stair.snapshot().tracks,
      };
    }
    if (id === 'nback') this._nback = g.report();

    // 测评档不给星。星是"你做得多好"的即时评价 —— 在一个刻意不给对错反馈的
    // 流程末尾把成绩摊开，等于把前面 8 分钟守住的东西在最后一屏还回去，
    // 而且孩子下次再测时会带着"上回几颗星"的预期进来。这里只肯定"你做完了"。
    // 训练档同样不给星，理由换一条：星是"你做得多好"，而阶梯法把正确率钳在 75%，
    // 星数只会反映阶梯收敛到哪一步、跟努力无关；何况老年人存在刻板印象威胁。
    const stars = noScore ? null : this.metrics.stars(id);
    if (!noScore) this.progress[id] = Math.max(this.progress[id] || 0, stars);

    g.exit();
    this.current = null;

    this.result.setData({
      // ⚠️ 测评档现在有两关，这两行原来都是照着"只有 CPT 一关"写的：
      // 打完 CPT 就说「测评完成」（后面还有一关）、说「做完了全部四段」
      // （延迟选择关根本不分段）。**都是不报错的假话**，跟着关卡走才对。
      title: !this.queue.length && assess ? '测评完成'
        : !this.queue.length && train ? '今天的训练完成'
          : `${g.meta.name} 完成`,
      praise: noScore ? (g.meta.donePraise || '你坚持做完了，很棒！')
        : stars >= 3 ? '完美表现！' : stars === 2 ? '很不错！' : '完成啦，继续加油！',
      color: g.meta.color,
      stars,
      stats: this._levelStats(id, g, s),
      tip: this._levelTip(id, g, s),
    }, { nextLabel: this.queue.length ? '下一关' : '查看报告' });

    this.audio.fanfare();
    this.assets.setMascotMood(this.mascot, 'wow');
    // 训练档这一句不能带"数据/成绩"的意思，也不能夸表现 —— 见 UfovFocus 文件头「反馈策略」
    this.say(assess ? '做完啦，我们去看看数据'
      : train ? '今天就到这里，辛苦了'
        : pick(LINES.levelEnd), 3);
    this._setState(STATE.RESULT);

    // 一关打完落一次存档点（见 _checkpoint）。放在 _setState 之后：结算页先出来，
    // 落盘在背景里做，孩子那边一帧都不用等
    this._checkpoint();
  }

  _levelStats(id, g, s) {
    const acc = `${Math.round(s.accuracy * 100)}%`;
    if (id === 'delay') {
      // ⚠️ 这一屏**不能出现选择的分布，也不能出现水晶数**。
      // 前者是策略回显（下次再测时孩子会带着"上回我选了几次小的"进来），
      // 后者是分数（用户拍板：奖励只以罐子的方式可见，不出现数字）。
      // s.total 在这里恒为 0 —— 这一关的试次全是 `scored:false`，数在 s.unscored 里。
      const c = this.metrics.choiceSummary(id);
      return [
        { label: '完成选择', value: `${c.made} / ${c.trials}`, color: '#ffc94d' },
        {
          label: '平均决定用时',
          value: c.decisionMs ? `${Math.round(c.decisionMs)}ms` : '—',
          hint: '想多久做的决定',
        },
      ];
    }
    if (id === 'cpt') {
      // 结算页给孩子看的那一屏，刻意只报"做了多少"和最中性的两项，
      // 完整指标（τ / d′ / 抢答 / 头动）都在报告页与导出 JSON 里给成人看
      return [
        { label: '完成试次', value: `${s.total}`, color: '#4de2ff' },
        { label: '完成段数', value: '4 / 4', color: '#6bffb0' },
        { label: '平均反应', value: s.rtMean ? `${Math.round(s.rtMean)}ms` : '—' },
      ];
    }
    if (id === 'ufov') {
      // 与 cpt 同一条理由：结算页是**被试自己看的那一屏**，只报"做了多少"；
      // 完整指标（阈值毫秒、双阶梯轨迹）留给报告页与导出，给施测者看。
      // ⚠️ 这一关比 cpt 还严一层，**连"平均反应"都不能给**：UFOV 的自变量是呈现时长
      // 不是 RT（`rt` 全程为 null），而老年人存在刻板印象威胁，任何速度读数都在把
      // 注意力引向"我是不是变慢了"。正确率同理不给 —— 阶梯把它钳在 75%，
      // 对每个人都一样、没有信息量，看上去却永远像在错四分之一。
      // 「本次用时」留着是给施测者的：30 分钟一次的剂量要靠它排。
      const secs = Math.max(0, Math.round(g.elapsed));
      return [
        { label: '完成次数', value: `${g.trialNo} / ${g.meta.protocol.trials}`, color: '#7fd7ff' },
        { label: '本次用时', value: `${Math.floor(secs / 60)} 分 ${String(secs % 60).padStart(2, '0')} 秒` },
      ];
    }
    if (id === 'nback') {
      const n = this.metrics.nBackSummary(id);
      return [
        { label: '完成反应', value: String(n.trials), color: '#65dfff' },
        { label: '视觉正确率', value: `${Math.round(n.visual.accuracy * 100)}%`, color: '#65dfff' },
        { label: '听觉正确率', value: `${Math.round(n.auditory.accuracy * 100)}%`, color: '#ffc767' },
        { label: '最高难度', value: `和前面第 ${Math.max(...n.levels, 1)} 次比`, color: '#b98cff' },
      ];
    }
    if (id === 'catcher') {
      return [
        { label: '正确率', value: acc, color: '#4de2ff' },
        { label: '接住水晶', value: String(s.hits), color: '#6bffb0' },
        { label: '冲动出手', value: String(s.commissions), color: '#ff5c6c', hint: '该忍住却出手' },
        { label: '走神漏接', value: String(s.omissions), color: '#ffc94d', hint: '目标溜走' },
        { label: '平均反应', value: s.rtMean ? `${Math.round(s.rtMean)}ms` : '—' },
      ];
    }
    if (id === 'beam') {
      return [
        { label: '正确率', value: acc, color: '#b98cff' },
        { label: '找对次数', value: String(s.hits), color: '#6bffb0' },
        { label: '选错', value: String(s.wrongChoices), color: '#ff5c6c' },
        { label: '超时', value: String(s.omissions), color: '#ffc94d' },
        { label: '平均用时', value: s.rtMean ? `${(s.rtMean / 1000).toFixed(1)}s` : '—' },
      ];
    }
    return [
      { label: '正确率', value: acc, color: '#6bffb0' },
      { label: '完成序列', value: String(s.hits), color: '#4de2ff' },
      { label: '最长序列', value: String(g.peakSpan), color: '#ffc94d', hint: '完整复现的最多步数' },
      { label: '当前长度', value: String(g.currentSpan) },
    ];
  }

  _levelTip(id, g, s) {
    // 测评档的这一句必须对**任何表现**都成立：给一句跟成绩相关的话，
    // 就是把刚才刻意不给的反馈在最后补上了
    if (id === 'cpt') return '全部做完了，很不错的坚持。数据已经记好，接下来看报告。';
    // 延迟选择关更严一层：这一关连"表现"都没有。任何暗示某种选法更好的话
    // （"你很有耐心"／"下次可以多等等"）都会直接改掉重测时的选择分布
    if (id === 'delay') return '这一关没有对错，你按自己的想法选就好。都做完啦，我们去看报告。';
    // 训练档：这一句同样要对**任何表现**都成立。它还多做一件事 ——
    // 解释"为什么后半程一定会看不清"。阶梯法的设计就是把人推到看不清为止，
    // 不说破的话，被试会把它读成"我不行"，而依从性是本版块的头号风险。
    if (id === 'ufov') return '都做完了，辛苦。这一关没有"答对多少"这回事 —— 它会一直加快到你看不清为止，所以后半程觉得难是设计好的，不是你没做好。';
    if (id === 'nback') return '完成啦。记住星位和声音不容易，你已经坚持做完了。';
    if (id === 'catcher') {
      if (s.commissions > s.omissions + 2) return '这一关更多是"急"了一点：陨石飞近时先停半秒，看清颜色再决定要不要出手。';
      if (s.omissions > s.commissions + 2) return '有几个水晶悄悄溜走了：试着把视线放在远处，早一点发现它们。';
      if (s.rtCV > 0.35) return '反应时忽快忽慢，说明注意力有起伏。下一关试着保持同样的节奏。';
      return '出手和忍住都控制得不错，节奏很稳，继续保持。';
    }
    if (id === 'beam') {
      if (s.wrongChoices > 2) return '有几次被闪烁的符文带跑了。先在心里默念目标的形状和颜色，再开始找。';
      if (s.omissions > 1) return '有几次没在时间内找到。可以从中间往两边扫一遍，比到处乱看更快。';
      return '在干扰里锁定目标的能力很好，下次可以试试更难的档位。';
    }
    if (g.peakSpan >= 6) return `一次记住 ${g.peakSpan} 个位置，工作记忆表现很出色！`;
    if (g.peakSpan <= 3) return '试着把亮起的顺序在心里念一遍（比如"左、中、右"），会更容易记住。';
    return '记忆广度稳定在中等水平，再来几轮还能往上走。';
  }

  _showReport() {
    // 收尾：停采集 + 归档。**不 await** —— 报告页要立刻出来，而停采集要等 collector
    // 写完几十 MB 数据文件（实测约 2 秒）。归档失败只提示不阻断：数据还在浏览器里，
    // 报告页那个「导出数据 JSON」仍然拿得到完整的一份
    this._archiveSession();
    // 测评做完了，报告页要能被施测者正常操作（打开 viz、导出），退掉全屏
    this.onFullscreen?.(false);
    if (this.isAssess) { this._showAssessReport(); return; }
    if (this.isTrain) { this._showTrainReport(); return; }
    const overall = this.metrics.summary();
    const reportIds = this.sessionIds?.length ? this.sessionIds : ORDER;
    const catcher = this.metrics.summary('catcher');
    const beam = this.metrics.summary('beam');
    const echo = this.metrics.summary('echo');
    const totalStars = reportIds.reduce((a, id) => a + (this.metrics.stars(id) || 0), 0);

    const cards = [
      {
        label: '总体正确率', value: `${Math.round(overall.accuracy * 100)}%`,
        color: '#4de2ff', note: '所有关卡合计',
      },
      {
        label: '平均反应时', value: overall.rtMean ? `${Math.round(overall.rtMean)}ms` : '—',
        color: '#8ff6ff', note: '不追求最快，追求稳定',
      },
      {
        label: '反应稳定性', value: overall.rtCV ? overall.rtCV.toFixed(2) : '—',
        color: overall.rtCV && overall.rtCV < 0.3 ? '#6bffb0' : '#ffc94d',
        note: '变异系数 CV，越低越稳',
      },
      {
        label: this.metrics.nBackSummary('nback').trials ? '双模态记忆 d′' : '抑制控制 d′',
        value: this.metrics.nBackSummary('nback').trials ? this.metrics.nBackSummary('nback').overall.dPrime.toFixed(2) : catcher.dPrime ? catcher.dPrime.toFixed(2) : '—',
        color: '#b98cff', note: '辨别 Go/NoGo 的敏感度',
      },
      {
        label: this.metrics.nBackSummary('nback').trials ? '最高记忆间隔' : '记忆广度',
        value: this.metrics.nBackSummary('nback').trials ? `前 ${Math.max(...this.metrics.nBackSummary('nback').levels, 1)} 次` : echo.total ? String(this._echoPeak ?? '—') : '—',
        color: '#6bffb0', note: this.metrics.nBackSummary('nback').trials
          ? '本场实际进入的最高负荷' : '能复现的最长序列',
      },
      this._restCard(),
    ];

    const perGame = reportIds.map((id) => {
      const meta = GAMES[id].meta;
      const s = this.metrics.summary(id);
      let detail = '未进行';
      if (s.total) {
        if (id === 'catcher') detail = `正确率 ${Math.round(s.accuracy * 100)}% · 冲动 ${s.commissions} · 漏接 ${s.omissions}`;
        else if (id === 'beam') detail = `正确率 ${Math.round(s.accuracy * 100)}% · 选错 ${s.wrongChoices} · 超时 ${s.omissions}`;
        else if (id === 'nback') {
          const n = this.metrics.nBackSummary(id);
          detail = `视觉 ${Math.round(n.visual.accuracy * 100)}% · 听觉 ${Math.round(n.auditory.accuracy * 100)}% · 漏报 ${n.overall.omissions} · 虚报 ${n.overall.commissions}`;
        } else detail = `复现 ${s.hits} 轮 · 最长序列 ${this._echoPeak ?? '—'} 步`;
      }
      return { name: meta.name, color: meta.color, detail, stars: this.metrics.stars(id) };
    });

    // 数据源要写进报告页本身：真机和模拟源产出的曲线长得一模一样，
    // 报告一旦离开屏幕（截图、给家长看），没有这行就再也分不出哪份是真的。
    const bciMeta = this._bciMeta();
    const srcLabel = bciMeta.simulated ? '模拟脑电源' : bciMeta.device;

    this.report.setReport({
      subtitle: `${new Date().toLocaleString('zh-CN')} · 共 ${overall.total} 个试次 · 数据源：${srcLabel}`,
      attentionSource: srcLabel,
      totalStars,
      cards,
      vigilance: this.metrics.vigilanceCurve(6).map((v) => v.accuracy),
      attention: this.metrics.attentionCurve(40),
      perGame,
      advice: this._advice(overall, catcher, beam, echo),
    });
    this.audio.fanfare();
    this._setState(STATE.REPORT);
    this.say('这是今天的成绩单，给爸爸妈妈看看吧！', 5);
  }

  /**
   * 测评档的报告。和体验档那份是两个东西，差别不只是数字换了：
   *   - **没有星**（星是评价，测评不评价）
   *   - 指标以 CPT 体系的口径给（漏报率/误报率按各自的 Go / No-Go 试次数算，
   *     而不是"总正确率"—— 后者会被两半悬殊的目标比例摊平，读不出任何东西）
   *   - 多一项 τ（RT 长尾），它是 RTV 里对 ADHD 最敏感的成分
   *   - 免责声明换了一条：这一档**不是**自适应难度，那句话在这里是错的
   */
  _showAssessReport() {
    const s = this.metrics.summary('cpt');
    const halves = this.metrics.halfSummary('cpt');
    // 头动要按关卡取快照：`kin` 里现在装的是**最后一关**的采样（见 _endLevel）。
    // 直接用 this.kin.report() 的话，头部活动量那张卡会悄悄变成"延迟选择那 3 分钟的"，
    // 而卡片上写着"全程累计"—— 数字正常、含义全错。
    const kin = this.kinByGame?.cpt || this.kin.report();
    const choice = this.metrics.choiceSummary('delay');

    const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
    const omitRate = s.goTrials ? s.omissions / s.goTrials : 0;
    const commRate = s.nogoTrials ? s.commissions / s.nogoTrials : 0;
    const tau = s.exG?.ok ? s.exG.tau : null;

    // ⚠️ 指标卡的 note 必须**一行装得下**（画布 17px 字，可用宽约 190px，约 11 个汉字）。
    // 折成两行会压在卡片底边上，而且不报任何错 —— 这一版是量过宽度定的（坑#35 那一类）。
    const cards = [
      {
        label: '漏报率', value: pct(s.omissions, s.goTrials),
        color: omitRate > 0.2 ? '#ffc94d' : '#6bffb0',
        note: `该出手没出手 · ${s.goTrials} 个`,
      },
      {
        label: '误报率', value: pct(s.commissions, s.nogoTrials),
        color: commRate > 0.25 ? '#ffc94d' : '#6bffb0',
        note: `该忍住却出手 · ${s.nogoTrials} 个`,
      },
      // 第 5 张卡是**两条通路各占一张**的那一张：跑了延迟选择关就给它，
      // 否则退回 CPT 的平均反应时（调试时单跑 cpt 会走到这条）。
      // 卡位是硬的（一行 6 张、宽度按 6 算好的），加第 7 张会把每张的 note 挤到折行 ——
      // 平均反应时因此挪进了下面的分项行，不是删掉了
      choice.trials ? {
        label: '延迟选择',
        // 报的是"选马上拿的比例"。**故意用中性色**：这一项没有常模，
        // 也没有"高了不好、低了好"的方向 —— 给它上黄/绿就是在下一个我们下不了的判断
        value: choice.ssRate != null ? `${Math.round(choice.ssRate * 100)}%` : '—',
        color: '#ffc94d',
        note: choice.made ? `选马上拿 ${choice.ss}/${choice.made} 次` : '本次未作出选择',
      } : {
        label: '平均反应时', value: s.rtMean ? `${Math.round(s.rtMean)}ms` : '—',
        color: '#8ff6ff', note: '不追求最快，追求稳定',
      },
      {
        label: '反应长尾 τ', value: tau != null ? `${Math.round(tau)}ms` : '—',
        color: tau != null && tau > 220 ? '#ffc94d' : '#b98cff',
        note: tau != null ? '偶发超慢反应的量级' : `有效反应不足 ${s.exG?.n ?? 0} 个`,
      },
      {
        label: '辨别力 d′', value: s.dPrime ? s.dPrime.toFixed(2) : '—',
        color: '#4de2ff', note: '扣掉乱按后的分辨能力',
      },
      kin.valid
        ? {
          label: '头部活动量', value: `${kin.overall.distance.toFixed(1)}m`,
          color: '#8fb4ff', note: `全程累计 · 动作 ${kin.overall.microEvents} 次`,
        }
        : this._restCard(),
    ];

    /**
     * 分项行只有 4 行的高度（再多就压到免责声明上，而且不报错）。
     * 两关都要在这里露面，所以 CPT 从"每段一行"收成"每半一行" ——
     * 两半正是 TOVA 式设计里被对比的那两个条件（稀少→漏报 / 频繁→误报），
     * 而更细的分段仍在左边那条 8 段曲线和导出 JSON 的 `blocks` 里，一点没丢。
     */
    const perGame = [];
    for (const [key, label, color] of [
      ['low-go', '前两段', '#8fb4ff'], ['high-go', '后两段', '#b98cff'],
    ]) {
      const h = halves[key];
      if (!h) continue;
      perGame.push({
        name: label,
        color,
        detail: `${key === 'low-go' ? '目标稀少' : '目标频繁'} · `
          + `漏 ${h.omissions}/${h.goTrials} · 误 ${h.commissions}/${h.nogoTrials}`
          + (h.rtMean ? ` · ${Math.round(h.rtMean)}ms` : ''),
        stars: null,
      });
    }
    if (choice.trials) {
      const bias = choice.sideBias == null ? null : Math.round(choice.sideBias * 100);
      perGame.push({
        name: '延迟选择',
        color: '#ffc94d',
        detail: `马上拿 ${choice.ss} · 等一等 ${choice.ll}`
          + (choice.noChoice ? ` · 未选 ${choice.noChoice}` : ''),
        stars: null,
      });
      perGame.push({
        name: '等待与决定',
        color: '#ffc94d',
        // 累计等待就是这孩子实际暴露在延迟里的秒数 —— 全选小奖和全选大奖能差三倍，
        // 而那个差本身就是这一关要测的东西
        detail: `累计等待 ${Math.round(choice.totalDelaySec)}s`
          + (choice.decisionMs ? ` · 决定 ${Math.round(choice.decisionMs)}ms` : '')
          + (bias == null ? '' : ` · 选左 ${bias}%`),
        stars: null,
      });
    }

    const bciMeta = this._bciMeta();
    const srcLabel = bciMeta.simulated ? '模拟脑电源' : bciMeta.device;

    this.report.setReport({
      // 副标题的可用宽度只有约 1140px（右上角还站着"固定难度·标准化施测"）——
      // 两关的完整协议版本（`catcher-cpt-1.0/seed-…` 与 `delay-well-1.0`）只在导出 JSON 里，
      // 这里放的是"实际做了多少"，那才是读报告的人第一眼要确认的
      subtitle: `${new Date().toLocaleString('zh-CN')} · 固定试次测评档 · `
        + `CPT ${s.total} 试次（抢答 ${s.anticipatory}）`
        + (choice.trials ? ` · 延迟选择 ${choice.made}/${choice.trials} 次` : '')
        + ` · 数据源：${srcLabel}`,
      attentionSource: srcLabel,
      totalStars: null,
      cards,
      // 8 段而不是 6 段：200 个试次撑得住更细的分辨率，而"后半程掉线"正是要看的东西
      vigilance: this.metrics.vigilanceCurve(8, 'cpt').map((v) => v.accuracy),
      attention: this.metrics.attentionCurve(40),
      perGame,
      perGameTitle: choice.trials ? '分项表现（CPT 两半 · 延迟选择）'
        : '分段表现（前两段目标稀少 / 后两段目标频繁）',
      advice: this._assessAdvice(s, halves, kin, choice),
      // ⚠️ 两关说的不是同一件事，合成一句就会把其中一句说成假的：
      // CPT 段有公认的指标口径；延迟选择段**连"哪种选法更好"都不存在**。
      disclaimer: '固定试次的标准化流程。CPT 段对齐 CPT 体系口径；'
        + '延迟选择段没有对错、也无常模。全部指标未经临床标定，'
        + '只能作为临床评估的辅助参考，不构成筛查或诊断结论。',
    });
    this.audio.fanfare();
    this._setState(STATE.REPORT);
    this.say('数据都记好了，交给医生和爸爸妈妈看', 5);
  }

  /**
   * 老年训练档的报告。**与另外两档的差别不只是数字，是"这一页写给谁看"** ——
   * 老人本人就坐在屏幕前，而施测者（社区/养老院的护理人员，不是测评员）要当场判断
   * 这一场采到的数据能不能用。由此四条规矩：
   *   · **给阈值，不给跨次对比**（2026-08-22 用户拍板）。阈值是本版块唯一的输出指标，
   *     施测者当场就要看到；而"比上次快/慢"会把天然的日间波动变成持续的负反馈 ——
   *     铁律 5 与刻板印象威胁两条都要防的正是这个。跨次趋势放 viz（施测者单独在
   *     电脑上开，老人不在旁边）。
   *   · **不给正确率**：双阶梯把它钳在 75%，对每个人都一样、没有信息量，
   *     看上去却永远像在错四分之一。
   *   · 左边那条曲线画的是**阈值收敛轨迹（毫秒）**，不是正确率曲线 ——
   *     这一关的试次全是 `scored:false`，正确率曲线对它根本不存在。
   *   · 「时间网格」那张卡是**施测机准入判定**，每一场都复查一次：刷新率不是 60 的
   *     整数倍就凑不出 16.67ms 步长，该机阈值与任何常模都不可比，而画面上看不出来
   *     （见 `.claude/rules/标定-UFOV呈现时长.md`）。
   */
  _showTrainReport() {
    const u = this._ufov || {};
    const trials = this.metrics.trials.filter((t) => t.kind === 'ufov');
    const series = trials.map((t) => t.ufovMs).filter((v) => v != null);
    const timeouts = trials.filter((t) => t.ufovTimeout).length;
    const planned = GAMES.ufov?.meta?.protocol?.trials ?? trials.length;
    const ms = u.thresholdMs;

    // 施测机准入：一步到底是不是正好 16.67ms。0.2ms 的容差是给帧间隔测量留的，
    // 60 的整数倍能压到 0 附近，144/165Hz 则差出整整半帧以上
    const stepMs = u.refreshHz ? (u.framesPerStep * 1000) / u.refreshHz : null;
    const aligned = stepMs != null && Math.abs(stepMs - 1000 / 60) < 0.2;

    const bciMeta = this._bciMeta();
    const srcLabel = bciMeta.simulated ? '模拟脑电源' : bciMeta.device;

    // ⚠️ note 一行约 11 个汉字（17px 字、可用宽约 190px），折行会压到卡片底边**且不报错**
    const cards = [
      {
        label: '呈现时长阈值', value: ms != null ? `${ms}ms` : '—',
        color: '#7fd7ff', note: ms != null ? '认对七成半所需' : '本次未收敛',
      },
      {
        label: '完成次数', value: `${u.trials ?? 0} / ${planned}`,
        color: (u.trials ?? 0) >= planned ? '#6bffb0' : '#ffc94d', note: '做满才有阈值',
      },
      {
        label: '有效作答', value: `${u.answered ?? 0} / ${u.trials ?? 0}`,
        color: timeouts > planned * 0.15 ? '#ffc94d' : '#6bffb0',
        note: `超时 ${timeouts} 次不计`,
      },
      {
        label: '阈值步数', value: u.thresholdSteps != null ? `${u.thresholdSteps.toFixed(1)} 步` : '—',
        color: '#b98cff', note: '一步 ＝ 16.67ms',
      },
      {
        label: '时间网格', value: u.refreshHz ? `${Math.round(u.refreshHz)}Hz` : '—',
        color: aligned ? '#6bffb0' : '#ff5c6c',
        note: aligned ? `一步 ${u.framesPerStep} 帧 · 对齐` : '刷新率对不齐',
      },
      this._restCard(),
    ];

    // 分项行：双阶梯各一条。反转次数是"收敛得够不够"的直读指标 ——
    // 阈值取的就是反转点的均值，反转太少说明这个阈值是估不准的
    const perGame = (u.tracks || []).map((t, i) => ({
      name: `阶梯 ${'AB'[i] ?? i + 1}`,
      color: i === 0 ? '#7fd7ff' : '#b98cff',
      detail: `落在 ${t.value} 步 · 反转 ${t.reversals?.length ?? 0} 次 · 当前步长 ${t.unit}`,
      stars: null,
    }));

    this.report.setReport({
      subtitle: `${new Date().toLocaleString('zh-CN')} · 老年训练档 · `
        + `UFOV 子测验1 ${u.trials ?? 0}/${planned} 次 · 数据源：${srcLabel}`,
      attentionSource: srcLabel,
      totalStars: null,
      // ⚠️ 不传的话会顶着测评档那句「固定试次 · 标准化施测」出报告，而本档是自适应双阶梯
      badge: '自适应阈值追踪 · 训练档',
      cards,
      // 量程按协议的呈现时长范围给（16.67~500ms），不按本场极值 —— 按本场极值会让
      // 每一场的曲线都"占满整个纵轴"，看上去波动一样大，跨场根本没法比
      vigilance: series,
      vigilanceTitle: '呈现时长阈值收敛轨迹（毫秒 · 越低越好）',
      vigilanceMin: 0,
      vigilanceMax: 500,
      attention: this.metrics.attentionCurve(40),
      perGame,
      perGameTitle: '双阶梯收敛情况',
      adviceTitle: '给施测者的记录',
      advice: this._trainAdvice(u, planned, timeouts, aligned),
      // ☠️ 这一句的三个"不"都是红线，删一个就是在报告上说假话：
      // ① ACTIVE 试验关于车祸/跌倒/痴呆的迁移结论**属于那个试验，不属于本工具**
      //    （Lumosity 被 FTC 罚 200 万的违规宣称正是同一形状）
      // ② 刺激尺寸与升降规则都是本项目自定的，与原版 UFOV 协议**不可直接对齐**
      // ③ 不是医疗器械（铁律 1）
      disclaimer: '采用 ACTIVE 试验所用的 UFOV 范式，但刺激尺寸与升降规则均为本项目自定，'
        + '阈值不可与原版协议或任何常模直接对齐，也不承载该试验的任何迁移结论。'
        + '本工具不是医疗器械，不构成诊断、评估结论或疗效承诺。',
    });
    this.audio.fanfare();
    this._setState(STATE.REPORT);
    // ⚠️ 这一句老人听得见，所以不评表现、不提"数据/成绩"，只说"结束了"
    this.say('今天的训练做完了，辛苦您', 5);
  }

  /**
   * 训练档的"观察建议"栏。**写给施测者的操作记录，不是给被试的评价** ——
   * 只说"这一场的数据能不能用、下次要注意什么"，一个字都不评表现。
   */
  _trainAdvice(u, planned, timeouts, aligned) {
    const parts = [];
    if (!aligned) {
      parts.push('这台机器的刷新率不是 60 的整数倍，呈现时长凑不出 16.67ms 的整步，'
        + '本场阈值与原版协议不可比。换机器或把系统刷新率改成 60/120/240 后重测。');
    }
    if ((u.trials ?? 0) < planned) {
      parts.push(`本场只做到第 ${u.trials ?? 0} 次（共 ${planned} 次），中途结束的场次阈值不完整。`);
    } else if (u.thresholdSteps == null) {
      parts.push('双阶梯没有收敛到可估阈值，通常是超时太多或中途换了作答策略。'
        + '下次开始前确认被试听懂了"看不清就凭感觉选"。');
    }
    if (timeouts > planned * 0.15) {
      parts.push(`有 ${timeouts} 次没在 8 秒内作答。若是因为看不清就不敢选，`
        + '开始前再说明一次：这一关本来就会闪到看不清，凭感觉选就行。');
    }
    if (!parts.length) parts.push('阶梯收敛正常、超时在可接受范围内，本场数据可用。');
    // 建议栏只排得下 2 段（再多会压到免责声明上，同 _assessAdvice 的限制）
    return parts.slice(0, 2).join('\n');
  }

  /**
   * 测评档的观察建议。只描述行为模式，**不做任何诊断性表述**（铁律 1、坑#19）。
   * 阈值全是凭经验拍的，改动等于改产品 —— 真要定阈值得靠真实儿童数据。
   */
  _assessAdvice(s, halves, kin, choice = null) {
    const parts = [];
    const low = halves['low-go'], high = halves['high-go'];
    const omitRate = s.goTrials ? s.omissions / s.goTrials : 0;
    const commRate = s.nogoTrials ? s.commissions / s.nogoTrials : 0;

    if (omitRate > 0.2 && omitRate > commRate) {
      const lowOmit = low && low.goTrials ? low.omissions / low.goTrials : 0;
      parts.push(`漏报占比较高（${Math.round(omitRate * 100)}%）`
        + (lowOmit > omitRate ? '，且集中在目标稀少的前两段 —— 任务越枯燥越容易掉线。' : '。')
        + '这一项对应的是持续性注意。');
    } else if (commRate > 0.25) {
      const highComm = high && high.nogoTrials ? high.commissions / high.nogoTrials : 0;
      parts.push(`误报占比较高（${Math.round(commRate * 100)}%）`
        + (highComm > commRate ? '，且集中在目标频繁的后两段 —— 一旦形成"看到就点"的惯性就收不住。' : '。')
        + '这一项对应的是反应抑制。');
    } else if (s.total) {
      parts.push('漏报与误报都在较低水平，本次任务中的持续注意与反应抑制表现平稳。');
    }

    const tau = s.exG?.ok ? s.exG.tau : null;
    if (tau != null && tau > 220) {
      parts.push(`反应时长尾明显（τ≈${Math.round(tau)}ms）：大部分反应是正常的，`
        + '但夹杂着少量特别慢的 —— 这种"一阵一阵"比"整体偏慢"更值得留意。');
    } else if (s.anticipatory >= 5) {
      parts.push(`出现 ${s.anticipatory} 次抢答（刺激还来不及看清就出手）。`);
    } else if (kin.valid && kin.overall.activeRatio > 0.5) {
      parts.push(`任务过程中头部有 ${Math.round(kin.overall.activeRatio * 100)}% 的时间在移动，`
        + '累计位移 ' + kin.overall.distance.toFixed(1) + ' 米。');
    }

    // 延迟选择那一句**占死第二段**：两条通路各说一句，才是加这一关的理由。
    // 让它跟 CPT 的第二句去抢 slice(0,2)，抢输的那一半通路在报告上就不存在了。
    const delayLine = this._delayAdvice(choice);
    return (delayLine ? [parts[0], delayLine] : parts.slice(0, 2))
      .filter(Boolean).join('\n');
  }

  /**
   * 延迟选择关的观察句。**这一段比 CPT 那段更容易说错**，因为它很容易被读成
   * "孩子没耐心"。三条硬规矩：
   *   ① 不给方向性判断（没有常模，"选马上拿多"既不是缺陷也不是优点）；
   *   ② 位置定势要先说 —— 一直点同一边的孩子可能根本没在比较两个选项，
   *      那样这个比例是不可解读的，先说指标再说这句就晚了；
   *   ③ 疲劳混淆要写出来 —— 这一关排在 8 分 18 秒的 CPT 之后（顺序是拍板定的），
   *      "想早点结束"和"等不了"在数据上长得一模一样。
   */
  _delayAdvice(choice) {
    if (!choice || !choice.trials) return '';
    if (!choice.made) return '延迟选择段全程未作出选择，这一段没有可解读的数据。';
    if (choice.sideBias != null && (choice.sideBias <= 0.15 || choice.sideBias >= 0.85)) {
      return `延迟选择段有 ${Math.round(Math.max(choice.sideBias, 1 - choice.sideBias) * 100)}%`
        + ' 的选择落在同一侧，更像位置定势而非偏好，这一段的比例宜谨慎解读。';
    }
    const pct = Math.round(choice.ssRate * 100);
    return `延迟选择：${choice.made} 次里 ${choice.ss} 次选了"马上拿"（${pct}%），`
      + `累计等待 ${Math.round(choice.totalDelaySec)} 秒。这一项无常模、无好坏方向；`
      + '且它排在 8 分钟任务之后，疲劳与"等不了"在数据上无法区分。';
  }

  /**
   * 静息基线卡。报的是"任务态相对自己静息态的抬升"而不是绝对值 ——
   * 专注度的绝对刻度受电极位置和个体差异影响太大，跨人比较没有意义，
   * 跟自己的静息态比才是可解释的。
   */
  _restCard() {
    const base = this.metrics.restBaseline;
    const task = this.metrics.taskAttentionMean;
    if (base == null) {
      return { label: '静息基线', value: '—', color: '#8fb4ff', note: '本次跳过了静息' };
    }
    const delta = task == null ? null : Math.round(task - base);
    return {
      label: '静息基线',
      value: String(Math.round(base)),
      color: '#8fb4ff',
      // 卡片宽度只够一行 20 字符左右，写长了会从卡片底边溢出去
      note: delta == null ? '静息态专注度均值'
        : `任务时 ${delta >= 0 ? '+' : ''}${delta}`,
    };
  }

  /**
   * 把指标翻译成家长能看懂的一句话。
   * 刻意只描述行为模式、给出可操作的观察建议，不做任何诊断性表述。
   */
  _advice(overall, catcher, beam /* , echo */) {
    const parts = [];
    const commRate = catcher.nogoTrials ? catcher.commissions / catcher.nogoTrials : 0;
    const omitRate = catcher.goTrials ? catcher.omissions / catcher.goTrials : 0;

    if (commRate > 0.3 && commRate > omitRate) {
      parts.push('本次表现偏"冲动型"：看到刺激就想反应，抑制的那一下比较难。日常可以多玩需要"等一等"的游戏，比如红绿灯、木头人。');
    } else if (omitRate > 0.25 && omitRate > commRate) {
      parts.push('本次表现偏"走神型"：该反应时没跟上。可以缩短单次任务时长，中间安排短休息，比一次硬撑更有效。');
    } else if (overall.total > 0) {
      parts.push('冲动与走神都控制在较低水平，注意力分配比较均衡。');
    }

    if (overall.rtCV > 0.35) {
      parts.push('反应时波动较大（CV 偏高），这通常比"平均反应慢"更值得关注 —— 说明注意力是一阵一阵的。');
    } else if (beam.total && beam.accuracy < 0.7) {
      parts.push('在干扰条件下找目标较吃力，抗干扰是当前的短板，可以先从减少环境干扰入手（安静的桌面、一次只做一件事）。');
    }
    // 只留两段：面板高度有限，写多了会压到按钮上，而家长真正会读完的也就两句
    return parts.slice(0, 2).join('\n');
  }

  _abortToMenu() {
    if (this.current) { this.kin.stop(); this.current.exit(); this.current = null; }
    if (!this.rest.finished) this.rest.exit();
    this.demo.exit();
    this.queue = [];
    this._pendingRest = false;
    // 中途退出**不归档**：跑了一半的场次进库只会让 data/ 里堆满调试废场，
    // 而完整跑完那一条路（_showReport）才是唯一产出报告的出口。
    // 采集器**故意不停** —— 施测者多半是要立刻重开一场，留着能省掉下一次的 25 秒等待。
    this._sessionActive = false;
    // 回大厅就不需要全屏了：施测者要在这里选被试、看信号，浏览器 UI 该露出来
    this.onFullscreen?.(false);
    this._gateFrom = null;
    this._gateBuf = '';
    this._setState(STATE.MENU);
    this.say('随时可以再来～', 2.5);
  }

  /* ------------------------------ 按钮分发 ------------------------------ */

  _onButton(id) {
    this.audio.select();
    // ☠️ **开测一律先过「开始前确认」，不做任何条件检测**（2026-08-12 用户拍板）。
    // 检测式的提醒挡不住"直接点开始"这个习惯动作，而漏掉的代价是不可逆的：
    // 忘了换人 → 这一场静默挂到上一个孩子名下；停在模拟源 → 整场脑电是编的。
    if (id === 'assess') { this._openPreflight(ASSESS_ORDER, 'assess', '标准测评 · 约 10-12 分钟'); return; }
    if (id === 'train') { this._openPreflight(TRAIN_ORDER, 'train', '老年专注训练 · UFOV 子测验1 · 约 5 分钟'); return; }
    if (id === 'start') { this._openPreflight(ORDER, 'full', '三模块体验 · 约 4 分钟'); return; }
    if (id.startsWith('game:')) {
      const gameId = id.slice(5);
      // 公开页只暴露无归档的 N-back 演示；不显示被试选择，也不伪造数据保存。
      if (this.isPublicDemo && gameId === 'nback') {
        this.onFullscreen?.(true);
        this._startSession(['nback'], 'nback', { rest: false, demo: false });
        return;
      }
      // N-back 是可重复的工作记忆追踪模块，单独标记 sessionMode，避免导出后
      // 与普通单关体验混为一类；它仍然不并入固定协议的标准测评档。
      this._openPreflight([gameId], gameId === 'nback' ? 'nback' : 'single',
        gameId === 'nback' ? '儿童 · 双模态星忆 · 约 4 分钟' : '单关体验');
      return;
    }

    // ---- 开始前确认页 ----
    if (id === 'pf-back') { this._setState(STATE.MENU); return; }
    if (id === 'pf-start') {
      const r = this._pendingRun;
      // ☠️ **进全屏必须在这里同步调**，不能挪进 _startSession —— 那个函数一上来就
      // `await _ensureCollector()`（真机源下可能等 45 秒），await 之后
      // transient user activation 早过期了，浏览器会静默拒绝全屏请求
      if (r) { this.onFullscreen?.(true); this._startSession(r.ids, r.mode); }
      return;
    }
    if (id === 'pf-source') { this._cycleBci(); return; }
    if (id === 'pf-collect') { this._toggleCollector(); return; }
    if (id === 'pf-restart') { this._restartCollector(); return; }
    if (id === 'pf-bci') { this._setState(STATE.BCI); return; }
    if (id.startsWith('pf-subj:')) { this._pickSubject(id.slice(8)); return; }
    if (id === 'pf-year-' || id === 'pf-year+') {
      // 只夹一个防止界面画崩的物理边界（负数年份没法显示），**不做年龄校验** ——
      // 成人被试是真实场景，见 _commitYear 的注释
      const d = id === 'pf-year+' ? 1 : -1;
      this._pf.yearEditing = false;
      this._pf.newYear = Math.max(1900, Math.min(2100, this._pf.newYear + d));
      this._pushPreflight();
      return;
    }
    // 点年份 → 用键盘直接敲（桌面专属）。空 buf 起手，敲够 4 位或回车才提交
    if (id === 'pf-year') {
      this._pf.yearEditing = !this._pf.yearEditing;
      this._pf.yearBuf = '';
      this._pushPreflight();
      return;
    }
    if (id.startsWith('pf-sex:')) {
      const v = id.slice(7);
      this._pf.newSex = this._pf.newSex === v ? null : v;   // 再点一次取消，避免选错了改不掉
      this._pushPreflight();
      return;
    }
    if (id === 'pf-new') { this._createSubject(); return; }
    // ☠️ **这里不能调 `_showReport()`。** 它渲染的是 `this.metrics` —— 也就是
    // **当前这次会话**的内存对象。从菜单进来时那个对象是空的，于是页面显示
    // "共 0 个试次"，而按钮上写着"上一次结果"。历史场次在 `data/sessions/` 里，
    // 只有报告页（viz.html）读得到，游戏进程里根本没有它们。
    if (id === 'report') { this._openViz(); return; }
    if (id === 'bci-source') { this._cycleBci(); return; }
    if (id === 'bci-collect') { this._toggleCollector(); return; }
    // 退回「开始前确认」而不是大厅 —— 这一页现在只能从那里进来
    if (id === 'bci-back') { this._setState(STATE.PREFLIGHT); return; }
    if (id === 'rest-skip') { this._endRest(); return; }
    if (id === 'demo-replay') { this._creditDemo(); this.demo.replay(); return; }
    if (id === 'demo-skip') { this._endDemo(); return; }
    // 说明页上的「再看演示」。走 _beginDemo 而不是 _nextInQueue —— 队列早就 shift 过了
    if (id === 'demo') { this._beginDemo(this.pendingId); return; }
    if (id === 'go') { this._beginCountdown(); return; }
    // 口令门自己的按钮。它只取消，不放行 —— 放行的唯一出口是敲对口令后回车
    if (id === 'gate-cancel') { this._closeExitGate(); return; }
    // ⚠️ 说明页「返回」与结算页「菜单」**绕开了 requestBack()**，所以口令门要在这里
    // 各挡一次。漏掉任意一处，孩子换个按钮点就出去了，而且不报错
    if (id === 'back') {
      if (this._needsExitGate()) { this._openExitGate(); return; }
      this._abortToMenu();
      return;
    }
    if (id === 'next') {
      if (this.queue.length) this._nextInQueue();
      else this._showReport();
      return;
    }
    if (id === 'menu') {
      if (this._needsExitGate()) { this._openExitGate(); return; }
      this._abortToMenu();
      return;
    }
    // 「再测一次」要回到刚才那一档。跳回体验档的话，孩子会以为自己重测了，
    // 而两档的数据不可互相比较
    if (id === 'again') {
      // ☠️ **必须回到同一档。** 漏掉哪一档，那一档的人点「再来一次」就换了个档跑，
      // 而两档数据不可互相比较、报告却看起来完全正常（见 编排 rule「改一处必查另一处」）。
      if (this.isAssess) this._startSession(ASSESS_ORDER, 'assess');
      else if (this.isTrain) this._startSession(TRAIN_ORDER, 'train');
      else if (this.sessionMode === 'single' || this.sessionMode === 'nback') {
        this._startSession(this.sessionIds, this.sessionMode);
      }
      else this._startSession(ORDER, 'full');
      return;
    }
    if (id === 'export') { this._exportJSON(); return; }
    if (id === 'viz') { this._openViz(); return; }
  }

  /**
   * 三态循环：模拟源 → DreamLab 真机 → WebSocket 桥接 → 模拟源。
   *
   * 真机排在第二位是因为它是现在唯一手头有的设备；WebSocket 桥接留着，
   * 它是"换任何别的设备"的通用入口（tools/mock-eeg-bridge.mjs 演示了那条路）。
   * 注意真机档**不做连不上就回退**：采集程序还没点「开始采集」是最常见的情形，
   * 静默回退到模拟源会让人以为真机接上了——那正是演示时最不能出的错。
   */
  async _cycleBci() {
    const s = this.bci.source;
    try {
      if (s instanceof MockEEGSource) {
        this.toast?.('正在连接 DreamLab Mini …');
        await this.bci.use(new DreamLabSource());
        const live = this.bci.source.last?.live;
        this.toast?.(live ? '已接入 DreamLab Mini' : '已切到真机源，但采集程序还没出数据');
      } else if (s instanceof DreamLabSource) {
        this.toast?.('正在尝试连接 ws://127.0.0.1:9000 …');
        await this.bci.use(new WebSocketEEGSource('ws://127.0.0.1:9000'));
        this.toast?.('已连接到 WebSocket 脑电桥接');
      } else {
        await this.bci.use(new MockEEGSource());
        this.toast?.('已切回模拟脑电源');
      }
    } catch {
      await this.bci.use(new MockEEGSource());
      this.toast?.('该数据源连不上，已回退到模拟数据源');
    }
    this._pushPreflight();
    this._pushBciUi();
  }

  /* ------------------------- 开始前确认（Preflight） -------------------------
   *
   * ☠️ **`this.subjectId` 在 2026-08-12 之前从来没有被赋过值。** 全项目只有归档
   * 那一处读它，没有任何一处写 —— 于是游戏永远传 null，服务端一律回落到
   * `readCurrentSubject()`。回落本身是对的（丢一场数据比记错人更难补救），但它
   * 意味着**"忘了换人"和"选对了人"在代码里长得一模一样**。现在这一页选完就写，
   * 归档时带的是这一场真正确认过的那个人。
   */

  /** 进入开始前确认。`ids/mode` 先存着，等人点了「开始测评」再真的开。 */
  _openPreflight(ids, mode, modeLabel) {
    this._pendingRun = { ids, mode, modeLabel };
    this._pf = this._pf || {
      subjects: [], currentId: null, scroll: 0,
      newYear: 2018, newSex: null, yearEditing: false, yearBuf: '', busy: '',
      run: null,
    };
    this._setState(STATE.PREFLIGHT);
    this._loadSubjects();       // 异步，回来后自己 _pushPreflight()
    this._refreshRunClaims();   // 同上
  }

  /* ------------------- 采集流复用（换人强制换流） -------------------
   *
   * 中途退出**故意不停采集**（2026-08-19 用户拍板：省下次重开的 25~45 秒），
   * 代价是同一条流可能被好几场共用。同一个孩子重测只是段归属分不清；
   * ☠️ **换了个孩子就是把两个人的脑电写进同一份样本文件** —— 那不是"数据不好用"，
   * 是把 A 的生理数据混进 B 的归档，所以那一档是硬拦，不是提示。
   */

  /** 拉一次"当前这条流服务过谁"。异步，回来自己刷面板。 */
  async _refreshRunClaims() {
    if (!this._pf) return;
    const src = this.bci.source;
    if (!(src instanceof DreamLabSource)) { this._pf.run = null; this._pushPreflight(); return; }
    // 用现拉的状态而不是 `src.last`（那份在采集停掉后会永久停在 live:true，
    // 见 _probeCollector）—— 否则采集早就停了还在报"这条流被用过"
    const now = await this._probeCollector();
    if (!now?.live || !now.runId) { this._pf.run = null; this._pushPreflight(); return; }
    let claims = [];
    try {
      const r = await fetch(`/bci/claim?runId=${encodeURIComponent(now.runId)}`, { cache: 'no-store' });
      claims = (await r.json())?.claims || [];
    } catch { /* 拉不到就当没人用过：这一层是提示，不该因为网络抖动把人拦在门外 */ }
    this._pf.run = { runId: now.runId, claims };
    this._pushPreflight();
  }

  /** 把 claims 算成面板要的两级警告。当前选的被试变了要重算，所以放在 push 时算。 */
  _runWarning() {
    const run = this._pf?.run;
    if (!run || !run.claims.length) return null;
    const cur = this._pf.currentId || null;
    const others = run.claims.filter((c) => c.subjectId && c.subjectId !== cur);
    return {
      blocked: others.length > 0,
      warn: others.length === 0 && run.claims.some((c) => c.subjectId === cur),
      count: run.claims.length,
    };
  }

  /**
   * 认领当前这条流。**开测成功后立刻发** —— 发晚了（比如等到归档）就挡不住
   * "中途退出、换个孩子、马上开测"这条最危险的路径。
   */
  _claimRun() {
    const runId = this._eegRunId;
    if (!runId) return;
    fetch('/bci/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,   // 页面被关掉时这一条仍要发出去，否则下一场查不到
      body: JSON.stringify({ runId, subjectId: this.subjectId ?? null }),
    }).catch(() => {});
  }

  /** 停了再起，换一条干净的流。停止要走完 collector 收尾，所以整个过程几十秒。 */
  async _restartCollector() {
    if (!this._pf) return;
    this._pf.busy = '正在停止当前采集…';
    this._pushPreflight();
    try {
      await fetch('/bci/stop', { method: 'POST' });
      this._pf.busy = '正在启动新的采集…';
      this._pushPreflight();
      await fetch('/bci/start', { method: 'POST' });
      await this._waitForEeg(45000, (last, elapsedMs) => {
        const left = Math.max(0, Math.ceil((45000 - elapsedMs) / 1000));
        this._pf.busy = last
          ? `采集程序已启动，等待设备出数据…（${left}s）`
          : `正在联系采集程序…（${left}s）`;
        this._pushPreflight();
      });
    } catch { /* 失败了下面的 refresh 会把真实状态显示出来 */ }
    this._pf.busy = '';
    await this._pollCollector();
    await this._refreshRunClaims();
  }

  /**
   * 把敲进去的那几位落成出生年。
   *
   * ⚠️ **不做年龄区间校验**（2026-08-12 用户拍板）：原来卡 2005~2030，而 S-000 就是
   * 2004 年生的成人 —— 成人被试是真实场景（对照、联调、给合作方演示时自己上），
   * 卡区间等于把它们挡在外面。这里只要求是数字。
   */
  _commitYear() {
    const p = this._pf;
    const v = parseInt(p.yearBuf, 10);
    if (Number.isFinite(v) && v > 0) p.newYear = v;
    p.yearEditing = false;
    p.yearBuf = '';
    this._pushPreflight();
  }

  async _loadSubjects() {
    try {
      const [a, b] = await Promise.all([
        fetch(this._dataUrl('subjects'), { cache: 'no-store' }).then((r) => r.json()),
        fetch(this._dataUrl('current-subject'), { cache: 'no-store' }).then((r) => r.json()),
      ]);
      // 新建的排在最前面：施测现场最常见的动作是"刚给这个孩子建了号，马上要选它"
      this._pf.subjects = (a?.subjects || []).slice().reverse();
      this._pf.currentId = b?.subjectId || null;
      this.subjectId = this._pf.currentId;
    } catch {
      // 没跑 serve.mjs（file:// 直开）时问不到。不弹错：这条路上本来就没有归档，
      // 面板会显示"未选择"并挡住开始按钮，语义正好
      this._pf.subjects = [];
    }
    this._pushPreflight();
  }

  async _pickSubject(id) {
    this._pf.busy = '正在切换被试…';
    this._pushPreflight();
    try {
      await fetch(this._dataUrl('current-subject'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId: id }),
      });
      this._pf.currentId = id;
      this.subjectId = id;      // 归档时带上，见本节顶部的注释
    } catch { this.toast?.('选被试失败，检查服务是否还在跑'); }
    this._pf.busy = '';
    this._pushPreflight();
  }

  /**
   * 新建被试并立刻设为当前。
   *
   * ☠️ **只传出生年与性别，绝不传姓名** —— 姓名一律不落本地（CLAUDE.md 红线），
   * 服务端那一侧也会显式丢弃 `name` 字段。这里连输入姓名的地方都不提供。
   */
  async _createSubject() {
    if (!this._pf.newSex) { this.toast?.('先选性别再建号'); return; }
    this._pf.busy = '正在建号…';
    this._pushPreflight();
    try {
      const r = await fetch(this._dataUrl('subject'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ birthYear: this._pf.newYear, sex: this._pf.newSex }),
      }).then((x) => x.json());
      if (r?.ok && r.subjectId) {
        this._pf.subjects = (r.subjects || []).slice().reverse();
        this._pf.busy = '';
        await this._pickSubject(r.subjectId);
        const code = (r.subjects || []).find((s) => s.subject_id === r.subjectId)?.display_code;
        this.toast?.(`已建号 ${code || ''} 并设为当前被试`);
        return;
      }
      this.toast?.(r?.error || '建号失败');
    } catch { this.toast?.('建号失败，检查服务是否还在跑'); }
    this._pf.busy = '';
    this._pushPreflight();
  }

  /** 把被试与脑电两侧的状态推给面板（面板内部比对过才重绘，坑#9）。 */
  _pushPreflight() {
    if (!this._pf) return;
    const s = this.bci.source;
    this.preflight.setInfo({
      subjects: this._pf.subjects,
      currentId: this._pf.currentId,
      scroll: this._pf.scroll,
      newYear: this._pf.newYear,
      newSex: this._pf.newSex,
      yearEditing: this._pf.yearEditing,
      yearBuf: this._pf.yearBuf,
      // `_bciNote` 是启动采集期间的进度覆盖（原来喂给菜单状态条，2026-08-12 随它一起搬到这里）
      busy: this._bciNote || this._pf.busy || '',
      modeLabel: this._pendingRun?.modeLabel || '',
      run: this._runWarning(),
      source: {
        label: s.label,
        quality: this.bci.quality,
        simulated: s instanceof MockEEGSource,
        live: !!s.last?.live,
        running: this._collector.running,
        note: s.note || '',
      },
    });
  }

  /* --------------------------- 脑电设置页 --------------------------- */

  /** 把当前脑电状态推给世界空间的设置面板（面板内部比对过才重绘，坑#9）。 */
  _pushBciUi() {
    const s = this.bci.source;
    const last = s.last || null;          // 只有真机源有 last，模拟/桥接源没有
    this.bciPanel.setInfo({
      label: s.label,
      note: s.note || '',
      quality: this.bci.quality,
      attention: this.bci.attention,
      simulated: s instanceof MockEEGSource,
      live: !!last?.live,
      running: this._collector.running,
      peer: this._collector.peer,
      bands: last?.band || null,
      reasons: last?.contaminationReasons || [],
    });
  }

  async _pollCollector() {
    try {
      const res = await fetch(`/bci/status${location.search}`, { cache: 'no-store' });
      const st = await res.json();
      this._collector.running = !!st.running;
      this._collector.peer = st.peer || null;
    } catch {
      // 没跑 serve.mjs（比如直接开的 file://）时问不到，按"没在采"处理
      this._collector.running = false;
    }
  }

  /**
   * 在头显里启停本机的采集程序。
   *
   * 公网访问时 serve.mjs 要控制口令（?c=），本机直连免口令 —— 一体式 USB 直连
   * 走的是 adb reverse 的 localhost，所以头显里点这个按钮不需要口令。
   * 403 时不装作成功：把"去哪拿口令"如实说出来。
   */
  async _toggleCollector() {
    if (this._collector.peer) { this.toast?.('采集跑在另一台机器上，请去那台机器的页面启停'); return; }
    const start = !this._collector.running;
    this.toast?.(start ? '正在启动采集程序…' : '正在停止采集（要等它释放串口）…');
    try {
      const res = await fetch(`/bci/${start ? 'start' : 'stop'}${location.search}`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) { this.toast?.(body?.error || `操作失败（HTTP ${res.status}）`); return; }
      this._collector.running = !!body.running;
      if (body.error) this.toast?.(body.error);
      else this.toast?.(body.running ? '采集器已启动，等设备上线' : '采集已停止');
      this._pushBciUi();
    } catch (e) {
      this.toast?.(`连不上本机服务：${e?.message || e}`);
    }
  }

  /** 导出/报告要带上的数据源说明。真机与模拟源产出的曲线长得像，必须靠这段区分。 */
  _bciMeta() {
    const s = this.bci.source;
    return {
      device: s.label,
      simulated: s instanceof MockEEGSource,
      note: s.note || null,
      detail: s.detail ?? null,
    };
  }

  /**
   * 导出用的完整元信息。`sessionMode` + `protocol` 这两项决定了拿到 JSON 的人
   * 能不能把它跟别的孩子比 —— 缺了它们，两档产出的文件长得一模一样。
   * `demo` 同理：它记的是**本次施测前实际发生过什么**，见 `_creditDemo()`。
   */
  _exportMeta() {
    return {
      ...this._bciMeta(),
      sessionMode: this.sessionMode,
      // 按本场**实际排了哪几关**收集协议，而不是写死 cpt 一关。
      // 写死的后果很隐蔽：加了第二关之后，导出的 JSON 会如实地描述一份
      // 只有 CPT 的施测流程，而拿到数据的人没有任何办法发现少了一关。
      // 训练档同样要出协议：UFOV 的阈值离开「呈现时长范围/目标正确率/坐距」就没法解释，
      // 而 `_protocolMap()` 本来就是按本场关卡收的，对 ufov 直接可用
      protocol: (this.noFeedback || this.sessionIds?.includes('nback')) ? this._protocolMap() : null,
      demo: {
        enabled: this._demoEnabled !== false,
        plays: this._demoPlays || 0,
        watchedSec: +(this._demoWatched || 0).toFixed(1),
        // 本场全部演示按脚本原本该有多长 —— 和 watchedSec 一比就知道跳过了多少
        nominalSec: +(this.sessionIds || []).reduce((a, id) => a + demoDuration(id), 0).toFixed(1),
      },
      // 同样按关卡收：`Kinematics.start()` 会清掉上一关的采样，所以这里读的是
      // _endLevel 存下的快照；最后一关若还没结算（异常路径）就现取一份补上
      kinematics: this._kinMap(),
      /*
       * ☠️ **阈值必须落进 report.json，别让消费方自己从 trials 重算。**
       * 它是老年训练档**唯一的输出指标**，而算它要复现双阶梯的反转点判定 ——
       * 那套逻辑只该有一份（在 `UfovStaircase` 里）。让 viz / 导出脚本各算一遍，
       * 迟早漂移，而漂移了没人会发现：两边算出来的数看着都合理。
       * （同 `metricsFromReport` 那条规矩，见 `.claude/rules/归档-会话数据与被试.md`。）
       * 值来自 `_endLevel` 存下的快照 —— 报告页跑到这里时关卡对象已经 exit 了。
       */
      ufov: this._ufov ?? null,
      nback: this._nback ?? null,
    };
  }

  /** 本场实际排了哪几关 → 各自的施测协议。没有 protocol 的关卡不出现。 */
  _protocolMap() {
    const out = {};
    for (const id of this.sessionIds || []) {
      const p = GAMES[id]?.meta?.protocol;
      if (p) out[id] = p;
    }
    return Object.keys(out).length ? out : null;
  }

  _kinMap() {
    const out = { ...(this.kinByGame || {}) };
    if (!Object.keys(out).length) {
      return this.kin.samples.length ? { [this.current?.meta?.id ?? 'unknown']: this.kin.report() } : null;
    }
    return out;
  }

  /* ----------------------- 采集启停与会话归档 ----------------------- */

  /**
   * 开测之前把脑电采集拉起来。返回 false = 拦住这一场，不进关卡。
   *
   * ⚠️ **只有真机源才拦。** 模拟源直接放行 —— 否则一台没接设备的机器就玩不了游戏，
   * 而铁律 3 的判据恰恰是「git clone + node serve.mjs 能不能跑起完整游戏」。
   *
   * 自动重试一次是有实据的：2026-08-09 在第二台机器上首次启动就撞上一次启动竞态
   * （协议栈的 Thread-3 在 sock.accept 抛 WinError 10038），停掉重启一次就好了。
   *
   * 提示走吉祥物气泡而不是 toast —— **toast 是 DOM，沉浸式会话里根本不存在**（铁律 2），
   * 戴着头显的人一个字也看不到。
   */
  /**
   * 把"此刻在做什么"推给采集器，让它直接打在**原始波形的样本上**。
   *
   * 为什么不是事后对齐：2026-08-10 拿 1251 条真实快照实测过，靠 2Hz 快照回归两个
   * 时钟，残差中位 **124ms**、p95 250ms；换线性回归也只到 121ms（漂移只占 -130ppm）。
   * 那 124ms 全部来自快照链路本身（上游算完 → 写文件 → serve.mjs 读 → 游戏轮询），
   * **不是时钟不准**，所以怎么拟合都消不掉。这条路是绕开它：事件直达采集器，
   * 由采集器在收到的那一刻记时间戳并换算成 sample_index。
   *
   * ☠️ **绝不 await、绝不让它抛**。打点失败最多是那一段少个标签，
   * 而阻塞或抛错会波及整场测评 —— 8 分 18 秒的测评档中断一次就是整场作废。
   *
   * 只在**真机源且真在出数据**时推：模拟源下没有采集器在听，写了也只是让
   * 下一场采集启动时多清一次文件。
   */
  _mark(type, extra = {}) {
    // ☠️ **会话没开始就不能发。** `_setState` 在会话之外照样被调用（回大厅、进脑电页），
    // 那时 `metrics.startedAt` 还停在**上一场**上，发出去的 `t` 指向另一条时间轴。
    // 2026-08-10 首次真机实测撞到过：一条 `menu` 事件带着上一场的 t=49197.8ms，
    // 而同场其余 221 条的时钟偏移稳定在 24.37~24.39s —— 那一个点把导出脚本的
    // 时钟映射从 **4.9ms 拖到 341ms**，还留下一个 52 秒的离群残差。
    // 它不报错，只是让整条映射变歪，而 game_events.csv 看上去完全正常。
    if (!this._sessionActive) return;
    const src = this.bci?.source;
    if (!(src instanceof DreamLabSource) || !src.last?.live) return;
    const startedAt = this.metrics?.startedAt;
    if (!Number.isFinite(startedAt)) return;
    try {
      fetch('/bci/mark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // keepalive：页面被关掉/头显摘下时这一条仍会发出去
        keepalive: true,
        body: JSON.stringify({
          t: +(performance.now() - startedAt).toFixed(1),
          type,
          ...extra,
        }),
      }).catch(() => {});
    } catch { /* fetch 本身抛（极少见）也不能影响游戏 */ }
  }

  /**
   * 采集开始/结束的那一刻给一个明确的、听得见也看得见的信号。
   *
   * 铁律 5（负反馈小声、正反馈大声）在这里的含义：**两个都用正反馈型的柔和钟声**。
   * 采集结束不是"你做错了"，用下行的提示音会让孩子以为自己搞砸了。`calmBell`
   * 是静息呼吸那套引导音，本来就是往"平静"方向调的，两处复用同一个音色，
   * 孩子听第二次就知道"这是设备的声音，不是对我的评价"。
   *
   * @param {'on'|'off'} kind
   */
  _announceCapture(kind, text) {
    this.say(text, kind === 'on' ? 3 : 4);
    // step 参数在 calmBell 里选音高：开始用低的、结束用高一点的，
    // 两者可分辨但都不刺耳
    try { this.audio?.calmBell?.(kind === 'on' ? 0 : 2); } catch { /* 音频没解锁就算了，提示不能反过来影响流程 */ }
  }

  /**
   * 现拉一次上游状态。
   *
   * ☠️ **不能用 `src.last` 代替它。** `DreamLabSource._poll()` 只在 `live` 为真时
   * 才写 `this.last`（见 BCIAdapter），所以采集一旦停掉，`last` 会**永久停在停止前
   * 那一帧、`live` 一直是 true**。拿它当"采集在不在跑"的判据，效果是"这台机器只要
   * 采过一次，以后每一场都以为采集正在跑" —— 而实际上一条流都没起来，
   * 整场跑完才发现没有脑电。开测前多一次 fetch 换掉这个坑，非常划算。
   */
  async _probeCollector() {
    try {
      const src = this.bci.source;
      const u = src?.token ? `/bci/metrics?k=${encodeURIComponent(src.token)}` : '/bci/metrics';
      const d = await (await fetch(u, { cache: 'no-store' })).json();
      return d?.ok ? d : null;
    } catch { return null; }
  }

  async _ensureCollector() {
    const src = this.bci.source;
    if (!(src instanceof DreamLabSource)) return true;

    // ☠️ 上一场的收尾还没走完就开新场（报告页飞快点「再测一次」）—— 必须等它。
    // 不等的话新场会领走一个**正在被搬走**的 runId，结果是这一场
    // `rawArchived=false`、完全没有原始脑电，而界面上一句提示都没有。
    if (this._stopPromise) {
      this._bciNote = '正在收尾上一场的采集…';
      this.say('上一场还在保存，稍等一下…', 12);
      try { await this._stopPromise; } catch { /* 停不干净也要继续，下面会重新起 */ }
      this._stopPromise = null;
    }

    // 施测者已经自己点过「开始采集」并且真在出数据 —— 直接沿用这一条流，别重启它。
    // ⚠️ 这条分支原来一声不响就返回了，于是"先去 bci.html 点开始、再回游戏"这个
    // 最常用的流程里，**从头到尾没有任何一处告诉人采集已经在跑**（2026-08-10 用户反馈）
    const now = await this._probeCollector();
    if (now?.live) {
      this._eegRunId = now.runId || null;
      this._announceCapture('on', '脑电已经在采集了，我们开始吧！');
      return true;
    }

    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        this.say(attempt === 1 ? '正在启动脑电采集，稍等一下…' : '没连上，再试一次…', 40);
        this._bciNote = attempt === 1 ? '正在启动采集程序…' : '没连上，第 2 次尝试…';
        try { await fetch('/bci/start', { method: 'POST' }); }
        catch { /* 起不来也继续往下等：下面那个 live 轮询才是真正的判据 */ }
        // 进度分三档，判据是上游快照的形态而不是时间：没有快照 = 采集器还没在写文件；
        // 有快照但 live=false = 采集器起来了但设备没出数据（**这正是 2026-08-09 那次
        // 启动失败的样子**：receiver=True / device=False / 文件全 0 字节）
        const ok = await this._waitForEeg(45000, (last, elapsedMs) => {
          const left = Math.max(0, Math.ceil((45000 - elapsedMs) / 1000));
          this._bciNote = !last
            ? `正在联系采集程序…（${left}s）`
            : `采集程序已启动，等待设备出数据…（${left}s）`;
        });
        if (ok) {
          this._eegRunId = this.bci.source.last?.runId || null;
          this._announceCapture('on', '脑电准备好了，我们开始吧！');
          return true;
        }
      }
      this.say('脑电没能启动，先检查接收器和头环，再重新开始', 12);
      this.toast?.('脑电采集启动失败，本场已取消（采集器日志见 bci.html）');
      return false;
    } finally {
      // 无论成败都要交还状态条，否则它会永远停在最后一句进度上，
      // 而真实状态（信号好没好）再也刷不出来
      this._bciNote = null;
    }
  }

  /**
   * 等到上游**真的在出数据**。
   * ☠️ 判据必须是 `live`，不能是"/bci/start 返回了 200"：采集进程起来了、但设备没连上时
   * 端点照样 200，而那正是 2026-08-09 第一次启动失败的样子（receiver=True 而 device=False，
   * 数据文件全是 0 字节）。用返回码当判据 = 硬拦形同虚设。
   */
  _waitForEeg(timeoutMs, onTick = null) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      // ☠️ 每轮**现拉**，不读 `source.last` —— 那份快照在采集停掉之后会永久停在
      // `live:true`（见 _probeCollector 的注释），拿它做等待判据的话，
      // 这个"等采集起来"的循环会在第一次 tick 就立刻返回 true，硬拦形同虚设。
      const tick = async () => {
        const now = await this._probeCollector();
        if (now?.live) { resolve(true); return; }
        const elapsed = performance.now() - t0;
        // 回调放在超时判断之前：最后一次也该把进度更新到位
        try { onTick?.(now, elapsed); } catch { /* 进度显示不能影响判据 */ }
        if (elapsed > timeoutMs) { resolve(false); return; }
        setTimeout(tick, 500);
      };
      tick();
    });
  }

  /**
   * 把这一场落进 `data/` 归档库（行为指标 + 脑电时间序列 + collector 原始产物）。
   *
   * ☠️ **停采集必须排在归档之前。** collector 运行期间只有 latest_metrics.json 在滚动写，
   * 另外 8 个原始产物文件全是 0 字节，要等它正常结束才一次性落盘
   * （2026-08-09 实测：跑到 1062 秒时 realtime_metrics.jsonl 仍然是 0 字节）。
   * 先归档后停采集的话，搬过去的 raw 目录里全是空文件，而且**看不出任何异常**。
   */
  /**
   * 存档点（2026-08-19 用户拍板）：**一关打完就把到目前为止的数据落一次盘。**
   *
   * 要救的是唯一真会丢的那块：行为试次与 2Hz 脑电快照全都只活在浏览器内存里，
   * 会话中途挂掉（孩子关标签页、施测者输口令退出）`metrics.reset()` 一清就没了。
   * 原始波形反倒不会丢 —— 它在采集器那边的磁盘上，只会被污染、不会消失。
   *
   * 走的是**同一条归档路、同一个 sessionId、同一个目录**，只是不搬 raw、不标
   * complete（见 archive.mjs）。所以中途挂掉时数据已经在盘上了，不需要任何
   * "下次启动检测有没有孤儿"的逻辑。
   *
   * ⚠️ **fire-and-forget，绝不 await**：这是在结算页刚出来的那一刻发的，
   * 卡住它就是卡住孩子面前的画面。失败也不提示 —— 存档点是保险，不是主路径，
   * 真正的归档在 `_archiveSession` 里还会再来一次。
   *
   * ☠️ 测评档实际只有**一个**存档点（CPT 打完那一刻），因为它只有两关而
   * 段边界不存（2026-08-19 用户拍板）。也就是说孩子在 CPT 那 8 分 18 秒里途中
   * 退出，那一关的数据照样全丢 —— 这是已知且被接受的缺口，别在文档里说成"全程保护"。
   */
  _checkpoint() {
    if (!this._sessionActive || this._archived) return;
    this._postArchive(true, this._eegRunId).catch(() => { /* 保险失败不影响主路径 */ });
  }

  async _archiveSession() {
    if (!this._sessionActive || this._archived) return;
    this._sessionActive = false;
    this._archived = true;     // 「再测一次」会再进一次报告页，不能重复归档同一场

    const runId = this._eegRunId || null;
    // ☠️ **取出来就立刻清掉。** 报告页的「再测一次」会在这个函数还没跑完时就调
    // `_startSession`，那时若 `_eegRunId` 还在，新一场就会领走一个**正在被搬走**的
    // runId —— 结果是新场 `rawArchived=false`、整场没有原始脑电，而界面上毫无提示。
    // 另一半防护在 `_ensureCollector` 里（等 `_stopPromise`）。
    this._eegRunId = null;

    if (runId) {
      // 先 announce 再停：停采集要走完 collector 的收尾（8 个产物一次性落盘），
      // 那几秒里人应该已经知道"采完了"，而不是对着静止的画面猜
      this._announceCapture('off', '脑电采集结束，数据保存好了');
      // 存成 promise 而不是直接 await：下一场的 `_ensureCollector` 要能等到它
      this._stopPromise = fetch('/bci/stop', { method: 'POST' }).catch(() => {});
      await this._stopPromise;
      this._stopPromise = null;
    }

    await this._postArchive(false, runId);
  }

  /**
   * 归档请求的唯一实现，存档点与最终归档共用。
   * 两份必然漂移，而漂移了不会有人发现 —— 存档点写进去的字段和最终那次不一致时，
   * 库里的数字看起来永远合理。
   *
   * @param {boolean} partial  true = 存档点（服务端据此不搬 raw、标 complete=false）
   * @param {string|null} runId 本场的采集流 id（最终归档时 `_eegRunId` 已被清空，所以要传）
   */
  async _postArchive(partial, runId) {
    if (this.isPublicDemo) return;
    const report = this.metrics.export(this._exportMeta());
    try {
      const res = await fetch(this._dataUrl('session'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report,
          // 第一次归档时还没有 id，服务端生成并回传；之后每一次都带上同一个，
          // 于是所有存档点和最终归档落在**同一个目录**里、互相覆盖
          sessionId: this._sessionId ?? null,
          partial,
          subjectId: this.subjectId ?? null,
          startedAtUtc: this._sessionStartedAtUnix ?? Date.now(),
          endedAtUtc: Date.now(),
          tzOffsetMin: new Date().getTimezoneOffset(),
          eegRunId: runId ?? null,
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (out.ok && out.sessionId) this._sessionId = out.sessionId;
      // 存档点是背景保险，不打扰孩子面前的画面 —— 提示只在最终归档时给
      if (partial) return;
      // ☠️ **被试编号要在这里说出来**：这是当场发现"记错人"的最后一次机会。
      // 事后翻报告时数据已经混进那个孩子的历次记录里了，而且看不出是哪一场串的。
      // 未认领也必须显眼说 —— 它意味着这一场没挂在任何人名下。
      if (out.ok) {
        const who = out.subjectCode ? `被试 ${out.subjectCode}` : '⚠️ 未认领（没有选被试）';
        // 标脏也要当场说：事后从报告页看不出这一场的波形和别人挤在一条流上
        const dirty = out.rawDirty ? ' · ⚠️ 与其它场次共用采集流' : '';
        this.toast?.(`本场已归档 · ${who} · ${out.dir}${dirty}`);
        this.result?.setArchived?.(out.subjectCode || null);
        this.report?.setArchived?.(out.subjectCode || null);
      } else {
        this.toast?.(`归档失败：${out.error || res.status}（报告页仍可手动导出 JSON）`);
      }
    } catch (e) {
      if (!partial) this.toast?.(`归档失败：${e.message}（报告页仍可手动导出 JSON）`);
      throw e;
    }
  }

  /**
   * 打开完整测评报告（浏览器页）。
   *
   * ⚠️ **沉浸态下不能走 `window.open`**：新标签页在头显里根本看不见，而且
   * `toast` 也是 DOM（铁律 2），提示同样看不到 —— 戴着头显的人只会觉得
   * "点了没反应"。所以 XR 下改用吉祥物气泡说明要回电脑端看。
   */
  _openViz() {
    if (this.renderer?.xr?.getSession?.()) {
      this.say('这个要在电脑上看哦，摘下头显打开「测评报告」', 6);
      return;
    }
    try {
      window.open('/viz.html', '_blank');
      this.toast?.('已在新标签页打开测评报告');
    } catch {
      this.toast?.('打不开新标签页，手动访问 localhost:3500/viz.html');
    }
  }

  _exportJSON() {
    try {
      const data = JSON.stringify(this.metrics.export(this._exportMeta()), null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `focus-camp-session-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      this.toast?.('测评数据已导出为 JSON');
    } catch {
      this.toast?.('当前环境不支持文件下载（VR 内请回到电脑端导出）');
    }
  }

  /* ------------------------------ 主循环 ------------------------------ */

  _updateUI(dt) {
    const planes = [];
    for (const p of this.panels) {
      if (p.visible && p.enabled && p.buttons.length) planes.push(p.plane);
    }

    const touched = new Set();
    for (const pointer of this.input.active()) {
      const hits = planes.length ? pointer.raycaster.intersectObjects(planes, false) : [];
      const hit = hits[0];
      if (!hit) continue;
      const panel = hit.object.userData.panel;
      const btn = panel.buttonAt(hit.uv);
      touched.add(panel);
      this.input.setBeam(pointer, hit.distance, hit.point);
      if (panel.setHover(btn) && btn) this.audio.hover();
      if (pointer.pressed && btn) {
        this.input.pulse(pointer, 0.4, 30);
        this._onButton(btn.id, panel);
        return;
      }
    }
    for (const p of this.panels) if (!touched.has(p) && p.visible) p.clearHover();

    // 没命中任何东西的指针，射线给个默认长度
    for (const pointer of this.input.active()) {
      if (pointer.type === 'xr' && !touched.size && this.state !== STATE.PLAY) {
        this.input.setBeam(pointer, null, null);
      }
    }

    // 面板懒跟随：VR 里玩家转身后 UI 会平滑跟过来，但不会黏在脸上
    if (this.renderer.xr.isPresenting) {
      for (const p of this.panels) if (p.visible) p.faceCamera(this.camera, { lerp: 0.06, threshold: 0.4 });
      this.bubble.faceCamera(this.camera, { lerp: 0.08, threshold: 0.5 });
      // 呼吸环不是 Panel，不在懒跟随队列里。它和静息页共用一个圆心，
      // 直接抄面板的偏航角就够了 —— 否则玩家在 VR 里一转头，
      // 文字跟过来了、环还留在原地，圆环还会被斜着看成椭圆
      if (this.state === STATE.REST) this.rest.ring.rotation.y = this.restPanel.rotation.y;
    }

    for (const p of this.panels) p.refresh();
    this.bubble.refresh();

    if (this._bubbleTimer > 0) {
      this._bubbleTimer -= dt;
      if (this._bubbleTimer <= 0) {
        this.bubble.visible = false;
        this.assets.setMascotMood(this.mascot, 'happy');
      }
    }
  }

  _frame(time, frame) {
    this.timer.update(time);
    const dt = Math.min(0.05, this.timer.getDelta());

    // XR 眼高校准。必须在 input.update() 之前 —— 它会抬整个 playerRig，
    // 手柄射线的命中点也随之改变，晚一步就是这一帧"指哪打不到哪"。
    // 内部自己判"校准过没有"，每帧调的开销只有一次布尔判断。
    this.rig.calibrateEyeHeight();

    // 桌面端的轻微视差：相机跟着鼠标偏一点点，画面立刻"立体"起来。
    // 幅度刻意压得很小（±5°），大了会干扰瞄准 —— 而且必须在 input.update()
    // 之前更新，否则射线用的是上一帧的相机姿态，指哪打不到哪。
    if (!this.renderer.xr.isPresenting) {
      const n = this.input.ndc;
      this._camYaw = THREE.MathUtils.lerp(this._camYaw ?? 0, -n.x * 0.09, dt * 4);
      this._camPitch = THREE.MathUtils.lerp(this._camPitch ?? 0, n.y * 0.05, dt * 4);
      this.camera.rotation.set(this._camPitch, this._camYaw, 0, 'YXZ');
      this.camera.position.set(0, EYE_HEIGHT, 0);
    }

    this.input.update(dt);   // dt 是给「长按 B/Y 返回」计时用的

    // 脑电：把"最近表现"喂给数据源，模拟行为与脑电的耦合
    this.bci.update(dt, {
      recentAccuracy: this.current ? this.current.recentAccuracy : 0.7,
      streak: this.current ? this.current.streak : 0,
    });
    if (this.state === STATE.PLAY) this.metrics.sampleAttention(this.bci.attention, this.bci.quality);
    // 脑电原始快照记**整场**，不只关卡内：静息基线要用它，段间休息与说明页上的状态
    // 同样是数据（"孩子在两关之间是不是已经累了"读的就是这一段）。上游只有 2Hz，
    // 每帧调进去的重复帧由 Metrics 按 elapsedSec 去重
    if (this._sessionActive) {
      this.metrics.sampleEegSnapshot(this.bci.source?.last, this.bci.attention, this.bci.quality);
    }
    // 静息期的世界由呼吸节律驱动（见 RestPhase），不跟专注度走。
    // **测评档在关卡内也不跟**：极光/舞台灯/边环随专注度呼吸是一条实打实的神经反馈
    // 闭环，孩子会（哪怕无意识地）去追那个画面，被测的就不再是他自然状态下的表现。
    // 脑电照采照记，只是不回显 —— 和"关掉得分倍率"是同一条理由。
    // ⚠️ **训练档同样要钳**（2026-08-22 加）：理由换成刻板印象威胁 + 脑电是本版块的
    // 结果指标 —— 让世界跟着专注度呼吸，老人就会去追那个画面，采到的脑电便不再是
    // 自然状态下的。这也是 UFOV 观测窗底衬必须用不吃光照的材质的**第二重保险**：
    // 钳位只在 PLAY 期生效，说明页/倒计时那几秒世界照样在呼吸。
    const loopOff = this.noFeedback && this.state === STATE.PLAY;
    if (this.state !== STATE.REST) {
      this.world.setAttention(loopOff ? 0.5 : this.bci.attention / 100);
    }

    /*
     * 关卡里的信号灯。改的是 material.color，不碰纹理，所以每帧跑也没有上传开销。
     *
     * ⚠️ **两档的规则不同，而且不能反过来**：体验档常驻（信号差时孩子该知道自己
     * 要坐正/别咬牙）；**测评档只在信号变差时才亮** —— 那一档刻意关掉了全部试次级
     * 反馈，一个跟着专注度变色的灯就是一条实打实的神经反馈闭环，孩子会去追它，
     * 被测的就不再是自然状态下的表现（同 `loopOff` 那条理由）。
     */
    if (this.state === STATE.PLAY) {
      const q = this.bci.quality;
      const band = q > 0.6 ? 2 : q > 0.3 ? 1 : 0;
      // 训练档跟测评档同规则：只在信号变差时才亮。常驻的变色灯＝一条神经反馈闭环
      const show = this.noFeedback ? band === 0 : true;
      this.sigDot.visible = show;
      if (show && band !== this._sigBand) {
        this._sigBand = band;
        this.sigDot.material.color.setHex(band === 2 ? 0x3ad29f : band === 1 ? 0xe6b446 : 0xe2606a);
      }
    } else if (this.sigDot.visible) {
      this.sigDot.visible = false;
      this._sigBand = -1;
    }

    // 「开始前确认」页每 0.5 秒刷一次：真机的状态是会自己变的（等待采集 → 信号良好 →
    // 信号差），只在进页面时更新一次的话，用户戴好电极了界面还停在旧状态。
    // ⚠️ 这段原来盯的是 STATE.MENU（菜单状态条），2026-08-12 状态条删掉后搬到这里。
    // `setInfo` 内部比对过才重绘（坑#9），所以 0.5Hz 不会白传纹理。
    this._bciUiTimer = (this._bciUiTimer ?? 0) + dt;
    if (this.state === STATE.PREFLIGHT && this._bciUiTimer > 0.5) {
      this._bciUiTimer = 0;
      // 顺带把采集器的运行状态也刷一下，否则在别处（bci.html）启停了这边看不见
      this._pollCollector();
      this._pushPreflight();
    } else if (this.state === STATE.BCI && this._bciUiTimer > 0.4) {
      // 设置页刷得快一些：戴电极的人正对着它调整位置，反馈慢了就没法用它对位
      this._bciUiTimer = 0;
      this._pushBciUi();
    }

    // 采集进程状态变化很慢（起/停各一次），2.5s 问一次够了，而且只在设置页问
    this._collectorTimer = (this._collectorTimer ?? 0) + dt;
    if (this.state === STATE.BCI && this._collectorTimer > 2.5) {
      this._collectorTimer = 0;
      this._pollCollector();
    }

    this.world.update(dt);
    this.fx.update(dt);
    this.assets.animateMascot(this.mascot, dt);

    if (this._mascotTarget) this.mascot.position.lerp(this._mascotTarget, dt * 3);

    switch (this.state) {
      case STATE.DEMO: {
        this.demo.update(dt);
        this.demoPanel.set(this.demo.uiState);
        if (this.demo.finished) this._endDemo();
        break;
      }
      case STATE.REST: {
        this.rest.update(dt);
        const ui = this.rest.uiState;
        this.restPanel.set(ui);
        // 文字层跟着一起明暗起伏。这一下不重画画布，只改面板材质的透明度 ——
        // 呼吸的动感靠 3D 环出，画布只在阶段切换时重绘一次
        this.restPanel.plane.material.opacity = 0.84 + ui.open * 0.16;
        if (this.rest.finished) this._endRest();
        break;
      }
      case STATE.COUNTDOWN: {
        this.countdownT += dt;
        if (this.countdownT >= 1) {
          this.countdownT -= 1;
          this.countdown--;
          this.brief.setCountdown(Math.max(0, this.countdown));
          this.audio.countdown(this.countdown);
          if (this.countdown < 0) this._launch(this.pendingId);
        }
        break;
      }
      case STATE.PLAY: {
        if (this.current) {
          if (this.current.meta.kinematics) this.kin.sample(this.camera, dt);
          this.current.update(dt);
          const st = this.current.hudState();
          this.hud.set({
            ...st,
            // 公开演示版明确使用游戏表现驱动的模拟波动；本地/真机始终显示 EEG 值。
            attention: this.isPublicDemo && Number.isFinite(st.demoAttention) ? st.demoAttention : this.bci.attention,
            quality: this.bci.quality,
          });
          if (this.current.meta.id === 'echo') this._echoPeak = this.current.peakSpan;
          if (this.current.finished) this._endLevel();
        }
        break;
      }
      default: break;
    }

    this._updateUI(dt);
    this.input.endFrame();

    this.rig.render();

    // FPS
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.onFps?.(Math.round(this.fpsFrames / this.fpsAcc));
      this.fpsAcc = 0; this.fpsFrames = 0;
    }
    void time; void frame;
  }
}

export { STATE };
