import * as THREE from 'three';
import { MiniGame } from './MiniGame.js';
import { UfovStaircase } from '../core/Adaptive.js';

/**
 * 星舰辨识 · **老年训练档** —— UFOV 子测验 1（集中注意 / 加工速度）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 范式出处：ACTIVE 试验所用的 Useful Field of View。三个子测验递进 ——
 * ① 中央辨别（本关）② 中央 + 外周定位 ③ 外周埋进干扰物。
 * 详见 `决策存档/2026-08-21-老年版块方向与依据.md` §五。
 *
 * ☠️ **产出的是「呈现时长阈值」，不是正确率。** 阶梯把正确率钳在 75%，所以正确率
 * 对每个人都一样、没有信息量；有信息量的是"要看多久才能达到那个正确率"。
 * 因此试次一律 `scored:false`（同延迟选择关），**绝不能进 CPT 那套 d′/τ 统计** ——
 * 混进去每个数都算得出来、也都没有意义，见 `.claude/rules/指标-试次schema与统计.md`。
 *
 * ☠️ **呈现时长按【帧】计，不按毫秒。** 刺激只能落在帧边界上；本机一个 UFOV 步长
 * （16.67ms）等于几帧由运行时实测的帧间隔决定（60Hz→1、240Hz→4）。
 * 施测机刷新率必须是 60 的整数倍，否则阈值与原版协议对不齐 ——
 * 判定在 `ufovtest.html`，规则见 `.claude/rules/标定-UFOV呈现时长.md`。
 *
 * ⚠️ **本关刻意不解决"真实视角"问题，做子测验 2 之前必须先解**：
 * 3D 场景按角度布置只能保证**屏幕投影比例**固定；眼睛看到的实际视角还取决于
 * 屏幕物理尺寸与坐距（协议已锁 60cm，但屏幕尺寸每台机器不同，浏览器拿不到）。
 * 子测验 1 测的是"要看多久"，对视角不敏感（看得清就行）；
 * 子测验 2/3 的外周偏心度（10°/20°/30°）**对视角高度敏感**，那时必须让施测机
 * 标定时录入屏幕尺寸，否则不同机器上的"20° 外周"根本不是同一个位置。
 *
 * ⚠️ **反馈策略与儿童测评档相反**：这是**训练**不是测评，需要反馈维持动机（依从性是
 * 本版块头号风险）。但只给正反馈、不给负反馈 —— 答错时什么都不发生，直接进下一试次。
 * 理由不只是铁律 5：老年人存在**刻板印象威胁**（测试情境暗示"在测你老没老"会让
 * 表现低于真实能力，元分析 32 篇），负反馈会把这个效应放大，而它污染的是数据本身。
 */

/* ───────────────────────── 施测协议（改这些 = 改测量工具本身） ─────────────────────────
 * ⚠️ 下面的数值**除呈现时长范围外全是凭经验拍的、未经标定**（同项目其它训练参数）。
 * 有出处的只有：呈现时长 1~30 步（16.67–500ms）、目标准确率 75%、双阶梯、
 * 起始步长 3 帧、首错后 1 帧 —— 均出自 Inquisit UFOV 手册。
 */
const TRIALS      = 60;    // 一个 block 的试次数。模拟实测：60 试次内 200/200 能估出阈值
const FIXATE_S    = 0.5;   // 注视点时长
const MASK_STEPS  = 6;     // 掩蔽时长（步）。⚠️ 我们加的：原版是否有掩蔽没查到。
                           // 没有掩蔽的话视觉后像会把"呈现 1 帧"实际延长，阈值被系统性低估，
                           // 而画面上完全看不出来 —— 这是心理物理学的标准做法，不是装饰。
const RESP_MAX_S  = 8;     // 响应窗上限。老人慢，给足；超时记为未作答（不喂阶梯）
const ITI_S       = 0.6;   // 试次间隔

const UFOV_STEP_MS = 1000 / 60;  // 一个 UFOV 步长的名义时长
const WARMUP_FRAMES = 40;        // 进关后先测这么多帧，定出"一步 = 几帧"

/* ───────────────────────── 刺激的尺寸：虚拟张角 ≠ 眼睛看到的张角 ─────────────────────────
 *
 * ☠️ **这两个数差三倍多，混用过一次（2026-08-22）。** 下面这条链每一环都要记住：
 *   ① 3D 世界里物体对**相机**张多少度（把包围盒角点 `.project(camera)` 量出来的）
 *   ② ÷ 相机垂直视场 68° = 它占**屏幕高度的百分之几** ← 只有这一步是跨机器不变的
 *   ③ × 屏幕物理高度 ÷ 坐距 = **被试眼睛真正看到的度数** ← 这一步依赖机器
 * 只有 ② 是代码能锁住的量；① 拿去跟文献里的度数比就是**高估三倍**。
 *
 * 本关按 ② 定尺寸：外接框占屏高 **17.3%** / 占屏宽 **10.5%**（16:10 全屏）。
 * 在标定机（22cm × 34cm 面板、协议锁定坐距 60cm、施测时全屏）上折算 ≈ **3.4° × 3.6°**。
 * ⚠️ 换一台屏幕尺寸不同的施测机，这个度数就变了 —— 这正是 §5.4 那条未解的实施前提
 * （`决策存档/2026-08-21-老年版块方向与依据.md`），子测验 2 的外周偏心度会被它卡死。
 *
 * ⚠️ **3.4° × 3.6° 是拍的，未标定。** 原版 UFOV 中央目标的确切张角**没查到**
 * （Inquisit 手册的 URL 已 404，换关键词搜不到别的出处），所以**别拿本关阈值直接对常模**。
 * 定这个值的依据只有两条边界：再小则老花/对比敏感度下降的老人认不出轮廓（任务从辨别退化成猜），
 * 再大则往"检测"滑、且做子测验 2 时会挤掉外周目标的位置。
 */
const SHIP_HALF_W = 0.34;   // 外接框半宽（米 @3m）
const SHIP_HALF_H = 0.35;   // 外接框半高

/**
 * ☠️ **这一关的全部布局常量，提到模块级并导出是为了给演示用。**
 *
 * `Demo.js` 必须 import 它，**不许在演示里另抄一份坐标**：演示教出来的空间感与
 * 时间感，被试会直接带进正式关卡 —— 演示里星舰闪在一个位置、真关卡在另一个位置，
 * 学到的"该往哪看"就是错的，而错的那部分会记进阈值里，我们却会把它当成加工速度。
 * 规则见 `.claude/rules/演示-必须用关卡真常量.md`（`CPT_STAGE`/`DELAY_STAGE` 同理）。
 *
 * ⚠️ 改这里等于同时改关卡与演示 —— 那正是它存在的意义，别为了"演示看着更清楚"
 * 在 `Demo.js` 里覆写任何一项。
 */
export const UFOV_STAGE = {
  /** 中央刺激 / 注视点 / 掩蔽 三者同址 —— UFOV 要求全程中央固视 */
  at: { x: 0, y: 1.6, z: -3 },
  halfW: SHIP_HALF_W,
  halfH: SHIP_HALF_H,
  /** 两个作答选项：左右对称，只在响应期可见 */
  optX: 1.15, optY: 1.15, optZ: -3, optScale: 0.9, hitR: 0.62,
  fix: { inner: 0.05, outer: 0.075 },
  maskR: 0.55,
  /** 观测窗：底衬 + 窗框。尺寸是按投影反推的，理由见 enter() 里那段 */
  backdrop: { w: 4.0, h: 1.9, y: 1.35, z: -3.7 },
  frame: { w: 4.16, h: 2.06, y: 1.35, z: -3.72 },
  colors: { stim: 0xdff4ff, mask: 0xa9c8de, fix: 0x7fd7ff, back: 0x0a1030, frame: 0x243a72 },
  /** 渲染顺序（见 enter() 里"不看深度、按序画"那段） */
  order: { frame: 9, back: 10, mask: 11, stim: 12 },
  /** 时间常量：演示要按同一个步长算呈现与掩蔽时长，别在演示里另写毫秒数 */
  stepMs: UFOV_STEP_MS,
  maskSteps: MASK_STEPS,
  /** 这几样是"不看深度、按序画"的材质配方，演示照抄同一份（理由见 enter()） */
  over: { depthTest: false, depthWrite: false, transparent: true },
};

/**
 * 两型星舰：**外接框与整段下半身完全相同，唯一的区别是鼻锥收成尖角还是截平。**
 *
 * ☠️ **两型必须等尺寸，这是构念要求不是美术要求**（决策存档 §5.3：「二选一的辨别难度」
 * 是构念参数）。初版把区别写在鼻锥长度上（0.62 vs 0.18），结果尖头型整体比平头型
 * **高 1.92 倍** —— 被试实际在做的是"大 vs 小"而不是"尖 vs 平"，而尺寸线索在
 * 十几毫秒的呈现下远比轮廓好认，阈值被系统性压低，**画面上完全看不出来**。
 *
 * ⚠️ **残留一条未消掉的线索：轮廓面积 0.256 vs 0.322（平头型多 26%）。**
 * 同色实心图形在极短闪现下，总亮度本身可以当线索用。在固定外接框的前提下
 * "尖 vs 平"必然带来面积差（尖角那块地方一个填一个不填），要抹平就得在别处
 * 挖补偿缺口，那会在尾部再造出第二个辨别线索、把任务变成另一回事。
 * **所以是知情接受，不是没看见** —— 它有没有真的变成亮度线索要老年被试实测才知道，
 * 已入待验证清单。
 *
 * 另：初版那个"给一点厚度"的离面顶点（z=0.26）去掉了 —— 透视下它会让轮廓随视差变形，
 * 且给出一条明暗线索，而本关要的是一个**平面的、只有轮廓可辨**的刺激。
 */
export function shipGeometry(kind) {
  const flat = kind === 'sharp' ? 0 : 0.12;   // 顶端半宽：0 = 收成尖角
  const H = SHIP_HALF_H, W = SHIP_HALF_W;
  // 逆时针（从 +z 看）；MeshBasicMaterial 默认剔除背面，顺序反了就整个看不见
  const poly = flat === 0
    ? [[0, H], [-W, -0.20], [-0.12, -H], [0.12, -H], [W, -0.20]]
    : [[-flat, H], [-W, -0.20], [-0.12, -H], [0.12, -H], [W, -0.20], [flat, H]];
  const v = [];
  for (let i = 1; i < poly.length - 1; i++) {   // 以 poly[0] 为扇心三角化
    v.push(poly[0][0], poly[0][1], 0, poly[i][0], poly[i][1], 0, poly[i + 1][0], poly[i + 1][1], 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

export class UfovFocus extends MiniGame {
  /**
   * ⚠️ **`color` 必须是 `'#rrggbb'` 字符串，不是 `0x` 数字** —— `BriefPanel.render()` 里
   * 会对它调 `.replace()`。写成数字的表现不是"颜色不对"，是**说明页每帧抛异常**，
   * 而 `_updateUI()` 在 `_frame()` 里排在 `current.update()` 之前 ——
   * 于是关卡时间恒定不动、state 却一切正常，症状与 rAF 节流一模一样。
   * `howto` 缺失同理（`lines is not iterable`）。**meta 不是显示配置，是硬契约。**
   */
  static meta = {
    id: 'ufov',
    name: '星舰辨识',
    skill: '加工速度 · 集中注意',
    blurb: '一闪而过，认出是哪一型',
    color: '#7fd7ff',
    duration: 300,      // 上限兜底；实际由 TRIALS 决定何时 finished
    train: true,        // 老年训练档标记（对应 assess 之于测评档）
    kinematics: false,  // 桌面端头动恒为 0，别开
    /**
     * 结算页那句话。**只说完成，不评表现** —— 老年人存在刻板印象威胁，
     * 任何"你反应很快/还不错"的评价都在把注意力引向"我是不是老了"。
     */
    donePraise: `${TRIALS} 次都做完了，辛苦了。`,
    /** 说明页那一行。必须自己带 —— 默认值是照 CPT 写的，对这一关每个字都是假的。 */
    briefNote: `一共 ${TRIALS} 次 · 每次只闪一下 · 看不清就凭感觉选，很正常`,
    howto: [
      ['1', '先看住正中间的小圆圈，星舰会在那里一闪而过'],
      ['2', '认一下它是尖头还是平头，然后在下面两个图形里点一样的那个'],
      ['3', '它会越闪越快，看不清是正常的 —— 凭感觉选就行，不用着急'],
    ],
    protocol: {
      version: 'ufov-focus-1.0',
      paradigm: 'ufov-subtest1-central-discrimination',
      trials: TRIALS,
      staircase: 'double, weighted up-down (down 1 : up 3), target 75%',
      durationRangeMs: [+UFOV_STEP_MS.toFixed(2), +(30 * UFOV_STEP_MS).toFixed(1)],
      maskSteps: MASK_STEPS,
      responseWindowSec: RESP_MAX_S,
      seatingDistanceCm: 60,   // 施测协议锁定值（2026-08-22 用户拍板）
      /** ⚠️ 训练档给正反馈、不给负反馈；与测评档"两者都没有"不是一回事。 */
      trialLevelFeedback: 'positive-only',
      fixedDifficulty: false,
    },
  };

  constructor(ctx) {
    super(ctx);
    this.stair = new UfovStaircase();
    this.phase = 'warmup';
    this.trialNo = 0;
    this.frameNo = 0;
    this._phaseStartFrame = 0;
    this._phaseT = 0;
    this._warmTs = [];
    this.framesPerStep = 1;      // 直到预热测完为止
    this.refreshHz = null;
    this.answered = 0;
    this.correctN = 0;
    this._cur = null;
    this._disposables = [];
  }

  enter() {
    // ⚠️ 一切坐标都从 `UFOV_STAGE` 取，别在这里写字面量 —— 演示 import 的是同一份
    const S = UFOV_STAGE;
    const at = new THREE.Vector3(S.at.x, S.at.y, S.at.z);

    /*
     * 观测窗：刺激、掩蔽、两个选项**全部落在这块均匀底衬上**。
     *
     * ☠️ **这不是装饰，是心理物理学的前提：背景一变，对比度就变，阈值跟着变。**
     * 不加它时星海背景在这一片是花的 —— 观星台平台正好卡在画面中央偏右，
     * 实测（2026-08-22 截图）**刺激下缘和右侧选项都压在平台上、左侧选项在纯天空上**，
     * 于是二选一的两个选项背景一暗一亮，直接构成左右偏倚。
     *
     * ☠️ **第二条理由读代码更看不出来：世界光照跟着专注度呼吸。** `Game._frame()` 里
     * `world.setAttention()` 只在**测评档**被钳成 0.5（`loopOff = this.isAssess && …`），
     * 训练档没被钳 —— 也就是说不加底衬的话，刺激的背景亮度**跟着被试自己的脑电走**。
     * 底衬用 `MeshBasicMaterial`（不吃光照），把这条链一次切断。
     * ⚠️ 世界其它部分仍然在跟着呼吸，那属于"训练档要不要关掉神经反馈回显"，
     * 是接第三档时要一起定的事（一级），不在本关内解决。
     *
     * 尺寸是按投影反推的，不是拍的：要盖住 z=−3 处 x∈±1.46、y∈0.835~1.95 的那片
     * （两个选项的外缘 + 刺激的外接框），底衬放在 z=−3.7（**必须躲开掩蔽球的后半，
     * 它是 r=0.55 的球、后缘到 z=−3.55**），按 3.7/3 放大后需要半宽 ≥1.80、
     * y 覆盖 0.66~2.03 —— 取 4.0 × 1.9、中心 (0, 1.35, −3.7) 留出余量。
     */
    /*
     * ☠️ **光把底衬放到刺激后面是不够的 —— 必须关掉深度测试、改用渲染顺序。**
     * 场景里有两团星尘（`Points`，1400 + 900 个点，锚在原点向四周铺开），其中一部分点
     * **比刺激还近**：实测射线打到的那颗在 2.27m 处，而刺激在 3m、底衬在 3.7m。
     * 也就是说按深度排，星尘会飘在观测窗**里面**、甚至压在星舰上（2026-08-22 截图里
     * 观测窗右侧那个亮点就是它）。往近处挪底衬治不了 —— 星尘是绕着相机铺的，
     * 挪到哪都可能有点在更前面。
     * 所以这一片改成"按顺序画、不看深度"：底衬先铺满，再把本关自己的东西盖上去。
     * ⚠️ 代价是这几个物体会画在**任何**与它们重叠的世界物体之上。当前不重叠的是
     * HUD（实测投影：底衬顶边 NDC 0.280 < HUD 底边 0.384），说明页/结算页出现时
     * 关卡 root 已经被 `exit()` 摘掉了。**再往 root 里加东西时要重新过一遍这两条。**
     */
    /*
     * ☠️ **`transparent: true` 在这里不是为了半透明，是为了挤进同一个渲染批次。**
     * Three.js 先画完**所有**不透明物体，再画透明物体 —— `renderOrder` 只在批次**内部**排序，
     * 跨批次不起作用。星尘（三团 `Points`，全是 `transparent:true`）和远处那些装饰结构
     * 都在透明批次里，所以底衬只要是不透明的，就**必定**先画、然后被它们盖上去。
     * 实测（2026-08-22）：只设 `depthTest:false` 时窗内仍有星点，右上角还飘进来一个
     * 17m 外的青色装饰体。把本关这几样也标成 transparent（`opacity` 仍是 1，画面不变），
     * 它们就和星尘同批，`renderOrder` 9~12 才真的排在 0~3 后面。
     */
    const OVER = S.over;
    // 窗框：纯粹为了让这块黑不像"贴上去的方块"，与星海的面板语言对齐
    this._frameGeo = new THREE.PlaneGeometry(S.frame.w, S.frame.h);
    this._frameMat = new THREE.MeshBasicMaterial({ color: S.colors.frame, ...OVER });
    this._disposables.push(this._frameGeo, this._frameMat);
    const frame = new THREE.Mesh(this._frameGeo, this._frameMat);
    frame.position.set(0, S.frame.y, S.frame.z);
    frame.renderOrder = S.order.frame;
    this.root.add(frame);

    this._backGeo = new THREE.PlaneGeometry(S.backdrop.w, S.backdrop.h);
    this._backMat = new THREE.MeshBasicMaterial({ color: S.colors.back, ...OVER });
    this._disposables.push(this._backGeo, this._backMat);
    this.backdrop = new THREE.Mesh(this._backGeo, this._backMat);
    this.backdrop.position.set(0, S.backdrop.y, S.backdrop.z);
    this.backdrop.renderOrder = S.order.back;
    this.root.add(this.backdrop);

    // 刺激与掩蔽各自一个 mesh，整关复用（每试次只切 visible 与几何，不反复 new）
    this._geoSharp = shipGeometry('sharp');
    this._geoBlunt = shipGeometry('blunt');
    // 刺激/掩蔽/注视点/选项全部随底衬走"不看深度、按序画"，否则星尘会插到它们前面
    this._matStim = new THREE.MeshBasicMaterial({ color: S.colors.stim, ...OVER });
    this._matMask = new THREE.MeshBasicMaterial({ color: S.colors.mask, wireframe: true, ...OVER });
    this._disposables.push(this._geoSharp, this._geoBlunt, this._matStim, this._matMask);

    this.stim = new THREE.Mesh(this._geoSharp, this._matStim);
    this.stim.position.copy(at);
    this.stim.visible = false;
    this.stim.renderOrder = S.order.stim;
    this.root.add(this.stim);

    // 掩蔽：一团碎线，盖住刺激占的那块视野，切断后像
    this.mask = new THREE.Mesh(new THREE.IcosahedronGeometry(S.maskR, 1), this._matMask);
    this.mask.position.copy(at);
    this.mask.visible = false;
    this.mask.renderOrder = S.order.mask;
    this._disposables.push(this.mask.geometry);
    this.root.add(this.mask);

    // 注视点：告诉被试"盯这里"，UFOV 全程要求中央固视
    this._fixGeo = new THREE.RingGeometry(S.fix.inner, S.fix.outer, 20);
    this._fixMat = new THREE.MeshBasicMaterial({ color: S.colors.fix, ...OVER });
    this._disposables.push(this._fixGeo, this._fixMat);
    this.fix = new THREE.Mesh(this._fixGeo, this._fixMat);
    this.fix.position.copy(at);
    this.fix.renderOrder = S.order.stim;
    this.root.add(this.fix);

    // 两个作答选项，常驻但只在响应期可见 + 可命中
    this.options = ['sharp', 'blunt'].map((kind, i) => {
      const m = new THREE.Mesh(kind === 'sharp' ? this._geoSharp : this._geoBlunt, this._matStim);
      m.position.set(i === 0 ? -S.optX : S.optX, S.optY, S.optZ);
      m.scale.setScalar(S.optScale);
      m.visible = false;
      m.userData.kind = kind;
      m.renderOrder = S.order.stim;
      this.root.add(m);
      const hb = this.makeHitbox(m, { radius: S.hitR });
      hb.position.copy(m.position);
      hb.visible = false;
      this.root.add(hb);
      this.hitboxes.push(hb);
      return { mesh: m, hitbox: hb, kind };
    });

    // 本关的几何/材质**全是自己 new 的**，一个都不来自 Assets 共享注册表 ——
    // 所以 exit() 里全部 dispose，不必走"是否共享"的判据（见 关卡 rule）。
    super.enter();
  }

  /** 进关后先测帧间隔，定出"一个 UFOV 步长 = 本机几帧"。 */
  _warmup(ts) {
    this._warmTs.push(ts);
    if (this._warmTs.length < WARMUP_FRAMES) return false;
    const d = [];
    for (let i = 1; i < this._warmTs.length; i++) d.push(this._warmTs[i] - this._warmTs[i - 1]);
    d.sort((a, b) => a - b);
    const medMs = d[d.length >> 1];
    this.refreshHz = 1000 / medMs;
    this.framesPerStep = Math.max(1, Math.round(UFOV_STEP_MS / medMs));
    return true;
  }

  _beginTrial() {
    const { track, steps } = this.stair.next();
    this._cur = {
      track, steps,
      kind: Math.random() < 0.5 ? 'sharp' : 'blunt',
      shownFrames: 0,
    };
    this.stim.geometry = this._cur.kind === 'sharp' ? this._geoSharp : this._geoBlunt;
    this._setPhase('fixate');
  }

  _setPhase(p) {
    this.phase = p;
    this._phaseT = 0;
    this._phaseStartFrame = this.frameNo;
    const resp = p === 'respond';
    /*
     * ⚠️ **注视环在刺激相必须消失。** 它和刺激同在 (0,1.6,−3)，初版两者同时可见 ——
     * 实测截图里那个青色圆环正压在星舰正中央，等于给一个本来就只有十几毫秒的
     * 轮廓判断额外叠了一层遮挡。UFOV 要求的是"全程盯着中央"，不是"全程看得见注视点"：
     * 目标出现时由目标本身接管中央位置，这是注视点范式的标准做法。
     * 掩蔽相同样不显示（掩蔽本来就盖着那块）；响应相也不显示（这时人要去看两个选项）。
     */
    this.fix.visible = p === 'fixate' || p === 'iti';
    this.stim.visible = p === 'stim';
    this.mask.visible = p === 'mask';
    for (const o of this.options) { o.mesh.visible = resp; o.hitbox.visible = resp; }
  }

  /** 本相已经过了几帧 —— UFOV 的时间全部走这里，不走 dt。 */
  get _framesInPhase() { return this.frameNo - this._phaseStartFrame; }

  update(dt) {
    this.elapsed += dt;
    this.frameNo++;
    this._phaseT += dt;

    if (this.phase === 'warmup') {
      if (this._warmup(performance.now())) this._beginTrial();
      return;
    }
    if (this.finished) return;

    switch (this.phase) {
      case 'fixate':
        if (this._phaseT >= FIXATE_S) this._setPhase('stim');
        break;

      case 'stim': {
        // ☠️ 帧计数，不是 dt 累加。刺激在进入本相那一帧显示，跨过 N 帧后换掩蔽。
        const want = this._cur.steps * this.framesPerStep;
        if (this._framesInPhase >= want) {
          this._cur.shownFrames = this._framesInPhase;
          this._setPhase('mask');
        }
        break;
      }

      case 'mask':
        if (this._framesInPhase >= MASK_STEPS * this.framesPerStep) this._setPhase('respond');
        break;

      case 'respond': {
        const { presses } = this.readPointers();
        const hit = presses.find((p) => p.target);
        if (hit) { this._answer(hit.target.userData.kind); break; }
        if (this._phaseT >= RESP_MAX_S) this._answer(null);   // 超时
        break;
      }

      case 'iti':
        if (this._phaseT >= ITI_S) {
          if (this.trialNo >= TRIALS) this.finished = true;
          else this._beginTrial();
        }
        break;
    }
  }

  _answer(kind) {
    const c = this._cur;
    const timeout = kind === null;
    const correct = !timeout && kind === c.kind;
    this.trialNo++;
    if (!timeout) { this.answered++; if (correct) this.correctN++; }

    // ⚠️ 超时不喂阶梯：没作答不等于答错，喂进去会把阈值往易的一侧推。
    if (!timeout) this.stair.record(c.track, correct);

    // 只给正反馈。答错时**什么都不发生** —— 见文件头"反馈策略"。
    if (correct) this.ctx.fx?.ring(this.stim.position, { color: 0x7fd7ff, to: 1.1, ttl: 0.4 });

    this.logTrial({
      kind: 'ufov',
      scored: false,        // ☠️ 不进 CPT 那套统计，理由见文件头
      correct: null,        // scored:false 的约定
      rt: null,             // UFOV 的自变量是呈现时长，不是 RT
      // 以下为原样透传的自定义字段（`logTrial` 不解构，见 指标 rule）
      ufovSteps: c.steps,
      ufovFrames: c.shownFrames,
      ufovMs: +(c.shownFrames * (1000 / (this.refreshHz || 60))).toFixed(2),
      ufovTrack: c.track,
      ufovCorrect: timeout ? null : correct,
      ufovTimeout: timeout,
    });
    this._setPhase('iti');
  }

  /** 暴露给 Game 的自定义字段。⚠️ 改名要同步 `_levelStats` / `_levelTip` / `_showReport`。 */
  get thresholdSteps() { const t = this.stair.threshold(); return t.ok ? t.steps : null; }
  get thresholdMs() {
    const s = this.thresholdSteps;
    return s === null ? null : +(s * UFOV_STEP_MS).toFixed(1);
  }

  exit() {
    for (const d of this._disposables) {
      this.ctx.assets?.untrack?.(d);
      d.dispose?.();
    }
    this._disposables.length = 0;
    super.exit();
  }

  /**
   * ☠️ **`mode` 是 HUD 的分派开关，不是一个描述性字段。** `HudPanel` 靠它选渲染路径：
   * 缺了就退回体验档那条，而那条会把 `score`/`accuracy` 直接画出来 ——
   * 传 `null` 拦不住它，屏幕上出现的是**字面量 `null 分` 与 `正确率 0%`**
   * （2026-08-22 实测，初版就是这样）。测评档用的是同一个开关（`mode:'assess'`）。
   *
   * 训练档不显示分数/连击/正确率：既因为铁律 5「只给正反馈」，也因为老年人存在
   * 刻板印象威胁 —— 一个一直在掉的正确率就是持续的负反馈，而阶梯法会把正确率
   * 钳在 75%，看上去永远像在错四分之一。**也不回显专注度**（2026-08-22 用户拍板）：
   * 回显 = 神经反馈闭环，老人会去追那个画面，而脑电正是我们要当结果指标采的东西。
   * 留下的只有跟表现无关的两样：进行到第几次、脑电信号还在不在（那是设备状态）。
   */
  hudState() {
    return {
      ...super.hudState(),
      mode: 'train',
      // 复用「第 N 段 / 共 M 段」那套版面的字段；本关不分段，按次计
      block: Math.min(this.trialNo + 1, TRIALS),
      blockCount: TRIALS,
      unit: '次',
    };
  }
}
