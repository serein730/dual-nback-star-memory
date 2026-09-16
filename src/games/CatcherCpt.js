import * as THREE from 'three';
import { MiniGame } from './MiniGame.js';
import { ANTICIPATORY_MS } from '../core/Metrics.js';

/**
 * 星海捕手 · **测评档**（固定难度 CPT）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 这一档和训练档（`StarCatcher.js`）是**同一个玩法的两种用途**，不是同一个东西。
 * 分开的理由只有一条：**自适应难度与跨人可比是互斥的**。CPT 类标准化评估
 * （Conners CPT 3、TOVA、QbTest、MOXO）全部是固定难度、固定试次、固定时长，
 * 因为"两个孩子的分数能不能比"要求他们看到的刺激完全一样。训练档为了依从性
 * 把难度钳在心流带里，代价就是它的 omission/commission 只能个体内比较。
 *
 * 三条设计出处（详见 `决策存档/2026-08-05-范式与证据.md` 第十节）：
 *
 *   ① **两半设计**（TOVA）：前两段目标稀少（Go 26%）→ 很少出手、任务枯燥 →
 *      逼出漏报，测持续注意；后两段目标频繁（Go 74%）→ 建立起反应定势 →
 *      逼出误报，测反应抑制。同一套刺激，靠改目标比例分别放大两种错误。
 *   ② **刺激位置固定在中轴**（x=0）。训练档的目标在 ±2.7m 内随机横向出现，
 *      于是 RT = 检测 + 决策 + **瞄准**，而瞄准距离每次不同 —— 那部分方差
 *      跟注意力无关，却会直接抬高 RT 变异性，而 RTV 恰恰是我们最看重的指标
 *      （Kofler 2013，g=0.71）。CPT 的本质是"位置不变、身份在变"，照做。
 *   ③ **全程无对错反馈**。命中确认对 Go 和 No-Go **完全相同**（同样的音、
 *      同样的粒子、同样的震动），只回答"你点到了"，不回答"你对了没有"。
 *      有对错反馈的话孩子会在任务过程中学习和调整策略，后半程测的就不是
 *      同一个任务了；错误反馈还会引入额外的错后调整变异。
 *
 * ⚠️ **这一档故意违反了两条平时的规矩，都是有理由的**：
 *   - 坑#18「难度必须钳在 75~85% 心流带」—— 固定难度必然让一部分孩子掉出去。
 *     这是测评与训练的固有冲突，只能靠"段间鼓励 + 控制单段长度"缓解，不能调难度。
 *   - 铁律 5「负反馈小声、正反馈大声」—— 这里是**两者都没有**。铁律管的是
 *     有反馈时的比例，全无反馈不属于它管的情形，但换来的代价（枯燥）是真的。
 *
 * ⚠️ **与 `StarCatcher.js` 是双份维护点**（SYNC.md #3c）：飞行/命中/回收的逻辑
 * 在两边各有一份。**这是故意的** —— 两档的飞行规则本来就不同（出场动画、
 * 横向漂移、伪装脱落、逃逸淡出都只在训练档有），硬合成一份的结果是一个
 * 到处 `if (assess)` 的函数，比两份更难读也更容易改错。改一边时过来看一眼另一边。
 */

/* ───────────────────────── 施测协议（改这些 = 改测评工具本身） ─────────────────────────
 *
 * 参照系（都是成人/儿童临床在用的）：Conners CPT 3 = 14 分钟 / 360 试次 / ISI 1·2·4s；
 * TOVA = 21.6 分钟 / 648 试次 / ISI 2s 固定；QbTest（6–17 岁）= 15 分钟；AULA = 20 分钟。
 * 本档 8 分 18 秒 / 200 试次，是这一组里最短的 —— 取舍是儿童在头显里的耐受度，
 * 代价是每一半的 Go 试次偏少（各 50 个），已在报告与导出里标注。
 */
const BLOCKS = 4;
const TRIALS_PER_BLOCK = 50;
/** 投放间隔（秒），固定不抖动。TOVA 是 2.0s；这里给到 2.4s 是为了让屏幕上永远只有一个目标。 */
const ISI = 2.4;
/** 段间休息。只说"第几段"和一句鼓励，**不报成绩** —— 报了就等于给了对错反馈。 */
const BREAK_SEC = 6;
/** 每段 Go 试次数。前两段稀少 / 后两段频繁，合计 Go 100 : No-Go 100（d′ 两侧样本量平衡）。 */
const GO_COUNTS = [13, 13, 37, 37];
/** 同类刺激最多连续几个。不限的话会随机出现"连着 9 个都不用出手"这种极端段落。 */
const MAX_RUN = 4;
/**
 * 刺激序列的种子**写死**。跨人可比要求每个孩子看到的序列相同 ——
 * 这与场景布局（`World.seed`，每次随机）是两回事，别顺手改成随机。
 * 将来要做重测版本（form B/C）就在这里换种子，并把版本号写进导出 JSON。
 */
const SEQ_SEED = 20260807;

const SPAWN_Z = -9.0;     // 刺激呈现（瞬时全尺寸，onset 必须明确，见下方 _spawn）
const WINDOW_Z = -2.6;    // 响应窗关闭：到这里还没出手就是漏报/正确拒绝
const EXIT_Z = -1.4;      // 淡出结束、对象回收。不让它飞到脸上（坑#11）
const SPEED = 3.6;        // m/s，固定不抖动
const LANE_Y = 1.62;      // 与相机等高的中轴
const SCALE = 0.62;       // 与训练档的稳态尺寸一致，两档的视觉大小可比
/** 判定盒半径 Go 与 No-Go **必须相同** —— 不同的话 No-Go 更难点中，误报率被系统性低估。 */
const HIT_R = 0.78;

/**
 * 舞台参数（不是协议参数）—— 刺激长什么样、从哪飞到哪。
 * 导出给关卡演示（`core/Demo.js`）用：演示里那颗水晶必须**和真的一样大、一样快、
 * 走一样的路线**，否则演示教出来的时间感在正式测评里全是错的。
 * ⚠️ 改这里就是改施测条件，见 SYNC.md #18b 的四端。
 */
export const CPT_STAGE = Object.freeze({
  laneY: LANE_Y, spawnZ: SPAWN_Z, windowZ: WINDOW_Z, exitZ: EXIT_Z, speed: SPEED, scale: SCALE,
});

const BLOCK_SEC = TRIALS_PER_BLOCK * ISI;              // 120.0
const PERIOD = BLOCK_SEC + BREAK_SEC;                  // 126.0
const TOTAL_TRIALS = BLOCKS * TRIALS_PER_BLOCK;        // 200
const DURATION = BLOCKS * BLOCK_SEC + (BLOCKS - 1) * BREAK_SEC;  // 498 = 8:18
/** 响应窗长度（秒）。儿童的 Go/No-Go 选择反应时约 0.5~0.8s，1.78s 留了充裕余量。 */
const WINDOW_SEC = (WINDOW_Z - SPAWN_Z) / SPEED;       // 1.778

/** 与 `World.js` 同款的 32 位 PRNG。这里另写一份是为了让序列只依赖 SEQ_SEED，不受场景种子影响。 */
function mulberry32(a) {
  return function next() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function maxRun(arr) {
  let best = 0, run = 0, prev = null;
  for (const v of arr) { run = v === prev ? run + 1 : 1; prev = v; if (run > best) best = run; }
  return best;
}

/**
 * 生成固定的刺激序列。
 * 做法是"先摆 No-Go，再把 Go 塞进它们之间的空隙，每个空隙最多 MAX_RUN 个" ——
 * 直接对整段做 Fisher-Yates 再拒绝采样，在 37:13 这种悬殊比例下命中率很低。
 */
function buildSequence(seed) {
  const rnd = mulberry32(seed);
  const blocks = [];
  for (let b = 0; b < BLOCKS; b++) {
    const goN = GO_COUNTS[b];
    const nogoN = TRIALS_PER_BLOCK - goN;
    let best = null;
    for (let attempt = 0; attempt < 400; attempt++) {
      const gaps = new Array(nogoN + 1).fill(0);
      let left = goN;
      let guard = goN * 40;
      while (left > 0 && guard-- > 0) {
        const g = Math.floor(rnd() * gaps.length);
        if (gaps[g] < MAX_RUN) { gaps[g]++; left--; }
      }
      const seq = [];
      for (let i = 0; i < gaps.length; i++) {
        for (let k = 0; k < gaps[i]; k++) seq.push('go');
        if (i < nogoN) seq.push('nogo');
      }
      if (!best || maxRun(seq) < maxRun(best)) best = seq;
      if (maxRun(seq) <= MAX_RUN) break;
    }
    blocks.push(best);
  }
  return blocks;
}

const spawnTimeOf = (idx) => Math.floor(idx / TRIALS_PER_BLOCK) * PERIOD
  + (idx % TRIALS_PER_BLOCK) * ISI;

export class CatcherCpt extends MiniGame {
  static meta = {
    id: 'cpt',
    name: '星海捕手 · 测评',
    skill: '持续注意 · 反应抑制（固定难度）',
    blurb: '接住蓝水晶，忍住不碰红陨石',
    color: '#4de2ff',
    duration: DURATION,
    /** 给 Game 用的两个开关：走测评呈现（无分数/无神经反馈回显）、并采头动。 */
    assess: true,
    kinematics: true,
    /** 结算页那句夸奖。**只夸坚持、不评表现**，而且必须只说这一关真有的东西。 */
    donePraise: '你坚持做完了全部四段，很棒！',
    /**
     * 说明页那一行。**自己带着**，别再靠 `BriefPanel` 的默认值 ——
     * 那个默认值原来就是照这一关写的，于是加第二关时它悄悄给延迟选择关
     * 也说了"分四段、每段休息"。默认值只该说两关都成立的话。
     */
    briefNote: '分四段，每段之间休息一下 · 全程难度固定',
    howto: [
      ['1', '水晶和陨石会从正前方一个一个飞来，蓝色水晶就出手接住'],
      ['2', '红色尖刺陨石不要碰，看到了就忍住，等它自己飞走'],
      ['3', '一共四段，每段之间会休息一下。这次没有分数，只要按自己的节奏做完就好'],
    ],
    protocol: {
      version: `catcher-cpt-1.0/seed-${SEQ_SEED}`,
      blocks: BLOCKS,
      trialsPerBlock: TRIALS_PER_BLOCK,
      totalTrials: TOTAL_TRIALS,
      goCounts: GO_COUNTS,
      isiSec: ISI,
      breakSec: BREAK_SEC,
      responseWindowSec: +WINDOW_SEC.toFixed(3),
      anticipatoryMs: ANTICIPATORY_MS,
      fixedDifficulty: true,
      trialLevelFeedback: false,
      stimulusLane: 'center-fixed',
      /**
       * 正式试次之前有一段**演示**（`core/Demo.js`）：程序化动画，只播放、**不可交互**，
       * 因此它不是练习块（practice block），不产生任何试次、也不让孩子先"上手"一遍。
       * 记在协议里是因为它确实改变了施测条件 —— 本次实际播了多久见导出的 `demo` 段。
       */
      demonstration: 'animated-noninteractive',
    },
  };

  constructor(ctx) {
    super(ctx);
    this.sequence = buildSequence(SEQ_SEED);
    this.actives = [];
    this.pool = { go: [], nogo: [] };
    this.nextIdx = 0;
    this.block = -1;
    this.inBreak = false;
    this.hits = 0;
    this.commissions = 0;
    this.omissions = 0;
    this.anticipatory = 0;
  }

  /** 固定难度：不存在"当前档位"。报告里显示的是协议版本，不是难度。 */
  get difficultyLabel() { return '固定难度'; }

  enter() {
    super.enter();
    const { assets } = this.ctx;

    // 屏幕上永远只有一个目标（ISI 2.4s > 对象存活 2.11s），池子 3 个纯属余量
    for (let i = 0; i < 3; i++) {
      for (const kind of ['go', 'nogo']) {
        const o = kind === 'go' ? assets.crystalCluster('go') : assets.hazard();
        o.visible = false;
        const hb = this.makeHitbox(o, { radius: HIT_R });
        o.add(hb);
        o.userData.hitbox = hb;
        this._pin(o, kind);
        this.root.add(o);
        this.pool[kind].push(o);
      }
    }

    // 捕获门保留：它在 VR 里是深度参照物（没有它，中轴飞来的东西很难判断远近），
    // 但**显形线不建**——测评档没有伪装陨石，留一道解释不了的光门只会让人分心
    const gate = new THREE.Mesh(
      new THREE.TorusGeometry(1.95, 0.028, 10, 96),
      new THREE.MeshBasicMaterial({
        color: 0x4de2ff, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }),
    );
    gate.position.set(0, LANE_Y, -4.2);
    this.root.add(gate);
    this.gate = gate;
  }

  /**
   * 把刺激外观**钉死**。`assets.crystalCluster()` 出厂时会调一次 `varyCrystal()`，
   * 训练档还会在每次投放时重抽形态（那是为了消除重复感）—— 测评档要反过来：
   * 标准化施测要求每一个 Go 都长得一模一样，否则"这次的水晶好认一点"就成了
   * 一个没人控制的难度变量。
   */
  _pin(o, kind) {
    const { geo } = this.ctx.assets;
    const u = o.userData;
    if (kind === 'go') {
      u.main.geometry = geo.crystal;
      u.buddy.geometry = geo.crystalSmall;
      u.buddy.position.set(0.33, -0.26, 0.1);
      u.buddy.rotation.set(0.18, 0.8, 0.42);
      u.buddy.scale.setScalar(1);
    } else {
      u.shell.geometry = geo.bomb;
      u.bands[0].rotation.set(Math.PI / 2, 0, 0);
      u.bands[1].rotation.set(0, 0, Math.PI / 2);
    }
    u.spin = 0.6;
  }

  _take(kind) { return this.pool[kind].find((o) => !o.visible) || null; }

  _spawn(idx) {
    const blk = Math.floor(idx / TRIALS_PER_BLOCK);
    const kind = this.sequence[blk][idx % TRIALS_PER_BLOCK];
    const obj = this._take(kind);
    if (!obj) return;

    // 中轴、等高、**瞬时全尺寸**。训练档那个 0.45 秒的弹性出场在这里必须去掉：
    // 刺激呈现时刻要是模糊的，RT 就没有起点，τ 和 RTV 全都建立在一个抖动的原点上。
    obj.position.set(0, LANE_Y, SPAWN_Z);
    obj.rotation.set(0, 0, 0);
    obj.scale.setScalar(SCALE);
    obj.userData.hoverK = 1;
    obj.visible = true;
    if (obj.userData.halo) obj.userData.halo.material.opacity = 0.55;

    this.actives.push({
      obj, kind, idx, block: blk,
      half: blk < BLOCKS / 2 ? 'low-go' : 'high-go',
      spawnAt: this.elapsed,
      resolved: false,
      fading: 0,
    });
    this.hitboxes.push(obj.userData.hitbox);
  }

  _dropHitbox(e) {
    const i = this.hitboxes.indexOf(e.obj.userData.hitbox);
    if (i >= 0) this.hitboxes.splice(i, 1);
  }

  _remove(e) {
    this._dropHitbox(e);
    e.obj.visible = false;
    e.obj.scale.setScalar(0.001);
    const i = this.actives.indexOf(e);
    if (i >= 0) this.actives.splice(i, 1);
  }

  /**
   * 出手了。**Go 和 No-Go 走完全相同的一套确认**（同一个音、同一种粒子、
   * 同一强度的震动），这是这一档最要紧的一条规矩 —— 见文件头 ③。
   */
  _respond(e, pointer) {
    const { fx, audio, input } = this.ctx;
    const rt = (this.elapsed - e.spawnAt) * 1000;
    const early = rt < ANTICIPATORY_MS;
    e.resolved = true;

    if (early) this.anticipatory++;
    else if (e.kind === 'go') this.hits++;
    else this.commissions++;

    this.logTrial({
      kind: e.kind, responded: true, correct: !early && e.kind === 'go',
      rt, level: 0, block: e.block, half: e.half, anticipatory: early,
    });

    // 中性确认：只说"点到了"，不说"对了/错了"
    fx.burst(e.obj.position, { color: 0x9fb8e6, count: 12, speed: 2.2, size: 0.42, ttl: 0.36 });
    audio.select();
    input.pulse(pointer, 0.5, 35);

    this._dropHitbox(e);
    e.fading = 0.22;
  }

  /** 响应窗关闭时还没出手。漏报和正确拒绝**都不给任何反馈**。 */
  _timeout(e) {
    e.resolved = true;
    if (e.kind === 'go') this.omissions++;
    this.logTrial({
      kind: e.kind, responded: false, correct: e.kind === 'nogo',
      rt: null, level: 0, block: e.block, half: e.half, anticipatory: false,
    });
    this._dropHitbox(e);
  }

  update(dt) {
    this.elapsed += dt;
    const t = this.elapsed;

    // 段边界：通知头动采集换段 + 让吉祥物说一句（只鼓励，不报成绩）
    const b = Math.min(BLOCKS - 1, Math.floor(t / PERIOD));
    if (b !== this.block) {
      this.block = b;
      if (b > 0) this.ctx.kin?.segment(`block-${b}`);
      this.ctx.onEvent?.({ type: 'assess-block', index: b, total: BLOCKS });
    }
    this.inBreak = (t % PERIOD) >= BLOCK_SEC && b < BLOCKS - 1;

    // 投放严格按时间表走，一个参数都不随机。追上多帧的情况用 while 补齐
    // （rAF 被节流过一段时间后可能一次跳过好几个投放点）
    while (this.nextIdx < TOTAL_TRIALS && t >= spawnTimeOf(this.nextIdx)) {
      this._spawn(this.nextIdx++);
    }

    const { hovered, presses } = this.readPointers();
    for (const press of presses) {
      const e = this.actives.find((a) => a.obj === press.target && !a.resolved);
      if (e) this._respond(e, press.pointer);
    }

    for (let i = this.actives.length - 1; i >= 0; i--) {
      const e = this.actives[i];
      const o = e.obj;

      if (e.fading > 0) {
        // 命中后就地缩没（不再前进，避免"打中了还继续朝我飞"的怪异感）
        e.fading -= dt;
        o.scale.multiplyScalar(Math.max(0.0001, 1 - dt * 8));
        o.rotation.y += dt * 7;
        if (e.fading <= 0) this._remove(e);
        continue;
      }

      o.position.z += SPEED * dt;
      o.rotation.y += dt * (o.userData.spin || 0.6);
      o.rotation.x += dt * 0.18;

      if (!e.resolved && o.position.z >= WINDOW_Z) this._timeout(e);

      if (e.resolved) {
        // 窗口已关：飞完最后 1.2m 顺势淡出。不能立刻消失 —— 目标"啪"地不见
        // 会被孩子读成一次反馈（"是不是我做错了"），而这一档不能有任何反馈。
        const k = 1 - (o.position.z - WINDOW_Z) / (EXIT_Z - WINDOW_Z);
        o.scale.setScalar(Math.max(0.001, SCALE * Math.max(0, k)));
        if (o.position.z >= EXIT_Z) this._remove(e);
        continue;
      }

      // 悬停放大幅度比训练档小（1.16 → 1.08）：目标全在中轴上，准星本来就压着它，
      // 大幅缩放会让"目标在变大"这件事本身变成一个视觉事件
      const target = hovered.has(o) ? 1.08 : 1;
      o.userData.hoverK = THREE.MathUtils.lerp(o.userData.hoverK ?? 1, target, dt * 12);
      o.scale.setScalar(SCALE * o.userData.hoverK);
    }

    // 捕获门只做极慢的自转当深度参照。**不跟专注度联动** ——
    // 那是神经反馈闭环，会改变被测的行为（同理 Game 在测评档冻结了世界的专注度回显）
    this.gate.rotation.z += dt * 0.08;

    if (this.nextIdx >= TOTAL_TRIALS && !this.actives.length) this.finished = true;
    if (t >= DURATION + 3) this.finished = true;   // 兜底，正常走不到
  }

  hudState() {
    return {
      title: this.meta.name,
      color: this.meta.color,
      mode: 'assess',
      block: this.block + 1,
      blockCount: BLOCKS,
      done: Math.min(this.nextIdx, TOTAL_TRIALS),
      totalTrials: TOTAL_TRIALS,
      breaking: this.inBreak,
      timeLeft: Math.max(0, DURATION - this.elapsed),
      duration: DURATION,
      level: this.difficultyLabel,
    };
  }
}
