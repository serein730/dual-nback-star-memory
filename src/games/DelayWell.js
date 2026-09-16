import * as THREE from 'three';
import { MiniGame } from './MiniGame.js';

/**
 * 星愿之门 · **测评档**（固定试次的延迟选择任务）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 【为什么加这一关】现有四关（三个体验模块 + 星海捕手 CPT）**全在"执行功能"
 * 这一条通路上**。但 ADHD 是异质的：只有约 30–50% 的患儿存在执行功能缺陷，
 * Sonuga-Barke 的**双通路模型**里，执行功能之外还有**延迟厌恶**这条独立通路。
 * 实证上停止信号任务与延迟选择任务单用判别力一般、合用才是 excellent。
 * 换句话说：只测 CPT，会系统性地漏掉"执行功能没问题、但等不了"的那一半孩子。
 *
 * 【范式】孩子反复在两个选项之间做选择：
 *   **马上拿**：等 2 秒，得 1 颗星愿水晶
 *   **等一等**：等 15 秒，得 2 颗
 * 一共 10 次，**没有对错**。指标是"选马上拿的比例"。
 *
 * 【最要紧的一条设计：选小奖真的能提前结束】
 * 这一关**不做等时化**（no post-reward delay）—— 选了"马上拿"就是省下 13 秒，
 * 整场因此提前结束。理由是实证的，不是省事：
 *   · Sonuga-Barke 等 1992 实验二：在**固定试次**约束下（选小奖 = 整场提前结束）
 *     多动儿童才表现出对小奖的偏好；换成固定 10 分钟的约束（选小奖并不省时，
 *     只是少拿分）时，两组一样有效率。
 *   · MIDA 大样本（360 ADHD / 349 同胞 / 112 对照，6–17 岁）两个条件都有组间差异，
 *     但**"选小奖能省时"那个条件的效应明显更大**。
 * 代价是**施测时长不固定**（全选小奖约 1 分钟，全选大奖约 3.3 分钟）。
 * 这不是缺陷：那段时长差本身就是数据（`totalDelaySec` = 这孩子愿意暴露在延迟里多久）。
 * 本档承诺的一直是"固定试次、固定序列"，从来不是"固定钟表时间"。
 *
 * 【与无反馈契约的关系 —— 这一关是唯一的例外，而且是有理由的例外】
 * 测评档的规矩是"屏幕上不能有任何东西因为孩子做得好/不好而变"。这里的收集罐
 * 会随孩子的选择变多，看上去像破了那条规矩，其实不是：
 *   **选择题没有对错**，罐子反映的是"你选了什么"，不是"你做得对不对"。
 * 而累积感恰恰是这个范式的动力来源 —— 没有"攒起来"的感觉，"等 15 秒换 2 颗"
 * 就只是一句抽象的话，范式当场失效。
 * ⚠️ 但**不出现任何数字**（2026-08-08 用户拍板）：一旦有了分数，孩子会把它带进
 * 对整场的预期，而同一场里的 CPT 段是严格无分数的。
 *
 * 【等待期里什么都不许发生】Antrop 等 2006 发现，延迟期间给非时间性的刺激
 * （放点别的东西看）会**显著改变**孩子对延迟奖励的选择。所以等待期只有倒数点在灭，
 * 没有音效、没有粒子、没有旁白 —— 等待期的刺激水平**是一个协议参数**，不是留白。
 *
 * 【倒数点为什么必须在选之前就看得见】孩子要能做"知情的选择"，就必须先知道
 * 两边各要等多久。目标年龄段有相当一部分**还不认字**，所以时长不写字，
 * 用**一颗点 = 一秒**的弧来表示：2 颗点是一小段弧，15 颗点是整整一圈。
 * 长短之比直接可看，不需要读数、也不需要理解"秒"。
 */

/* ───────────────────────── 施测协议（改这些 = 改测评工具本身） ─────────────────────────
 *
 * 参照系：MIDA / Sonuga-Barke 系列的经典参数是 **1 分 / 2 秒 vs 2 分 / 30 秒**。
 * 本档把长延迟从 30 秒**缩到 15 秒**，这是一处**已知偏离**，理由是时长预算：
 * 30 秒 × 10 试次全选大奖光等待就要 5 分钟，塞不进本场剩下的约 3 分钟。
 * 奖励比例（2:1）与短延迟（2 秒）保持原样。
 * ⚠️ 延迟缩短会不会削弱延迟厌恶的表现，**我们没有依据说不会** —— 必须写进对外材料。
 */
const TRIALS = 10;
/** 小奖：等 2 秒拿 1 颗。 */
const SS = Object.freeze({ key: 'ss', reward: 1, delay: 2 });
/** 大奖：等 15 秒拿 2 颗。 */
const LL = Object.freeze({ key: 'll', reward: 2, delay: 15 });
/** 决策窗（秒）。超时按"未作选择"记，不给奖励。 */
const CHOICE_WINDOW = 8;
/**
 * 超时后的中性停顿，**故意等于小奖的延迟**。
 * 不设它的话"什么都不点"就成了通关最快的路径 —— 一个想早点结束的孩子会学会不作答，
 * 于是我们测到的是"不作答率"而不是选择偏好，而两者在数据上长得完全不一样。
 */
const NO_CHOICE_PAUSE = SS.delay;
/** 选项浮现、领奖飞行、试次间隔。都不是协议参数，是节奏。 */
const REVEAL_SEC = 0.7;
const COLLECT_SEC = 1.3;
const ITI = 1.0;

/**
 * 每一次"马上拿"出现在左边还是右边。
 * **写成字面量而不是种子 + 生成器**：只有 10 项，写死比"跑一遍 PRNG 才知道"更容易
 * 被人当场核对，而跨人可比要求每个孩子看到的左右安排完全一致。
 * 约束：左右各 5 次、同侧最多连着 2 次（连排会诱发"就按这边"的位置定势）。
 */
const SS_SIDE = Object.freeze(['L', 'R', 'R', 'L', 'L', 'R', 'L', 'R', 'R', 'L']);

/* ──────────────────────────── 舞台参数（不是协议参数） ──────────────────────────── */

const OPT_X = 1.45;       // 两个选项各自离中轴的横向距离
const OPT_Y = 1.45;       // 与相机大致等高，略低一点让倒数弧不顶到 HUD
const OPT_Z = -4.3;       // 深度。离舞台灯 (0,2.4,-3.4) 的等效照度 1.84，在安全带内
const JAR_Y = 0.75;       // 收集罐：中央偏下，不挡两个选项
const JAR_Z = -3.0;       // 等效照度 2.43，同样在安全带内（见 渲染-光照与材质 规则）
const JAR_R = 0.42;       // 罐口半径
const GEM_SCALE = 0.38;   // `geo.gem` 原半径 0.16 → 0.061，一堆 20 颗刚好收在罐口内
const REWARD_SCALE = 0.42;
const REWARD_GAP = 0.46;  // 大奖那两颗之间的间距
const DOT_R = 0.6;        // 倒数点所在圆的半径
const DOT_SIZE = 0.045;
const HIT_R = 0.92;       // 判定球。比外观大一圈——儿童瞄准精度有限（MiniGame 的规矩）

/**
 * 导出给关卡演示（`core/Demo.js`）。演示里的门必须**和真的一样大、一样远、
 * 等一样久** —— 尤其是"等多久"：演示教出来的时间感孩子会直接带进正式试次，
 * 演示里等 5 秒、真关卡等 15 秒的话，他做的就不是知情的选择。
 */
export const DELAY_STAGE = Object.freeze({
  optX: OPT_X, optY: OPT_Y, optZ: OPT_Z,
  jarY: JAR_Y, jarZ: JAR_Z,
  rewardScale: REWARD_SCALE, rewardGap: REWARD_GAP,
  dotR: DOT_R, dotSize: DOT_SIZE,
  ss: SS, ll: LL,
  revealSec: REVEAL_SEC, collectSec: COLLECT_SEC,
});

/**
 * 造一个选项（奖励水晶 + 一圈倒数点）。**关卡和演示共用这一份** ——
 * 演示里那两道门必须和真的一样大、一样远、点一样多，否则孩子在演示里建立起来的
 * "等一等要等多久"是错的，而他会带着那个错的时间感去做正式的选择。
 *
 * 水晶外观**钉死**（和 `CatcherCpt._pin` 同一个理由）：标准化施测要求每个孩子、
 * 每一次看到的东西完全一样，否则"这次的水晶好看一点"就成了没人控制的变量。
 */
export function delayOptionProp(assets, opt) {
  const group = new THREE.Group();
  group.position.set(0, OPT_Y, OPT_Z);   // x 由调用方定（左右每试次会换）

  // 奖励：opt.reward 颗**各自独立**的水晶。crystalCluster 出厂自带一颗小跟班，
  // 这里把它藏掉 —— 要让孩子能"数出来"是 1 颗还是 2 颗，一个单位就必须是一颗。
  const rewards = new THREE.Group();
  for (let i = 0; i < opt.reward; i++) {
    const c = assets.crystalCluster('go');
    c.userData.main.geometry = assets.geo.crystal;
    c.userData.buddy.visible = false;
    c.scale.setScalar(REWARD_SCALE);
    c.position.x = (i - (opt.reward - 1) / 2) * REWARD_GAP;
    rewards.add(c);
  }
  group.add(rewards);

  // 倒数点：**一颗点 = 一秒**，从 12 点方向顺时针排。
  // 2 颗是一小段弧、15 颗是整整一圈 —— 长短之比直接可看，不用认字也不用懂"秒"。
  // 圆周的总格数固定按最长的那个选项算，两边的"一秒"才是同样的弧长。
  const dotGeo = new THREE.SphereGeometry(DOT_SIZE, 8, 6);
  const dots = [];
  for (let i = 0; i < opt.delay; i++) {
    const a = (i / LL.delay) * Math.PI * 2;
    const m = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({
      color: 0xffd98a, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    m.position.set(Math.sin(a) * DOT_R, Math.cos(a) * DOT_R, 0);
    group.add(m);
    dots.push(m);
  }
  return { group, rewards, dots };
}

/**
 * 收集罐：一个开口的光环 + 落进去的水晶堆。
 * **没有数字、没有刻度**（2026-08-08 用户拍板）—— 它只回答"我攒下的东西在变多"，
 * 不回答"我得了几分"。累积感是这个范式的动力来源，分数不是。
 */
export function delayJarProp(assets, capacity) {
  const group = new THREE.Group();
  group.position.set(0, JAR_Y, JAR_Z);

  // 罐口比水晶堆的最大外沿再大一圈，堆才像"装在里面"而不是"堆在旁边"
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(JAR_R, 0.022, 10, 64),
    new THREE.MeshBasicMaterial({
      color: 0x8fd7ff, transparent: true, opacity: 0.72,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  rim.rotation.x = Math.PI / 2;
  group.add(rim);

  // 水晶堆预建满额，先全部隐藏。收一颗亮一颗 —— 运行期不 new 东西。
  // ⚠️ `geo.gem` 是半径 0.16 的八面体，**必须缩**：原尺寸下三颗就撑破罐口、
  // 糊成一堆分不出个数的白块，而"看得出攒了多少"正是这个罐子存在的唯一理由。
  const gemMat = new THREE.MeshBasicMaterial({
    color: 0xbfefff, transparent: true, opacity: 0.9, toneMapped: false,
  });
  const gems = [];
  for (let i = 0; i < capacity; i++) {
    const g = new THREE.Mesh(assets.geo.gem, gemMat);
    // 螺旋堆叠：绕着罐心一圈圈往上码，看得出"越来越多"
    const a = i * 2.399;                       // 黄金角，堆得均匀
    const r = 0.075 + (i % 7) * 0.036;         // 最外 0.291 + 半颗宝石 0.06 < JAR_R
    g.scale.setScalar(GEM_SCALE);
    g.position.set(Math.sin(a) * r, 0.02 + Math.floor(i / 7) * 0.052, Math.cos(a) * r);
    g.rotation.set(a, a * 0.7, 0);
    g.visible = false;
    group.add(g);
    gems.push(g);
  }
  return { group, gems };
}

/** 标称时长：全选大奖、每次约 1.5 秒决策。真实时长随选择在 ~1 分到 ~3.3 分之间。 */
const NOMINAL_SEC = Math.round(
  TRIALS * (REVEAL_SEC + 1.5 + LL.delay + COLLECT_SEC + ITI),
);
const MIN_SEC = Math.round(TRIALS * (REVEAL_SEC + 1.5 + SS.delay + COLLECT_SEC + ITI));

export class DelayWell extends MiniGame {
  static meta = {
    id: 'delay',
    name: '星愿之门',
    skill: '延迟耐受 · 冲动选择（固定试次）',
    blurb: '一颗马上拿，还是两颗等一等',
    color: '#ffc94d',
    duration: NOMINAL_SEC,
    /** 走测评呈现（无分数/无神经反馈回显）、并采头动。 */
    assess: true,
    kinematics: true,
    /** 结算页那句夸奖。**不能夸"你很有耐心"那一类** —— 那是在肯定某一种选法。 */
    donePraise: `${TRIALS} 次都做完了，很棒！`,
    /**
     * 说明页那一行。**必须自己带**：`BriefPanel` 原来给 assess 档写死的是
     * "分四段，每段之间休息一下 · 全程难度固定" —— 那句话是照着 CPT 写的，
     * 对这一关**每个字都是假的**（不分段、不休息、时长还不固定）。
     */
    briefNote: `一共 ${TRIALS} 次 · 没有对错，选你想要的 · 时长看你怎么选`,
    howto: [
      ['1', '前面会出现两道星门：一道等一下下就给 1 颗水晶，一道要等久一点、给 2 颗'],
      ['2', '门下面的小圆点就是要等多久 —— 点越多等得越久，一颗点大约一秒'],
      ['3', `一共 ${TRIALS} 次，怎么选都可以，没有对错。选了就等它把点数完，水晶会飞进罐子里`],
    ],
    protocol: {
      version: 'delay-well-1.0',
      paradigm: 'choice-delay',
      trials: TRIALS,
      smallSooner: { reward: SS.reward, delaySec: SS.delay },
      largeLater: { reward: LL.reward, delaySec: LL.delay },
      /**
       * **false = 选小奖真的能省时**（1992 实验二里出现组间差异的那个条件，
       * 也是 MIDA 里效应更大的那个）。改成 true 就换了一个构念，别当参数调。
       */
      postRewardDelayEqualized: false,
      choiceWindowSec: CHOICE_WINDOW,
      noChoicePauseSec: NO_CHOICE_PAUSE,
      sideSequence: SS_SIDE.join(''),
      fixedTrialCount: true,
      /** 施测时长随被试的选择变化，不是固定值。拿到数据的人必须知道这一点。 */
      fixedWallClock: false,
      nominalSecAllLarge: NOMINAL_SEC,
      nominalSecAllSmall: MIN_SEC,
      trialLevelFeedback: false,
      /** 奖励可见并累积，但**不出现数字**（2026-08-08 用户拍板）。 */
      rewardDisplay: 'cumulative-visual-no-numerals',
      /** 等待期不给任何非时间性刺激（Antrop 2006：给了会改变选择）。 */
      delayPeriodStimulation: 'none',
      /** 演示里两个选项**各演一次**（含真实的 15 秒等待），顺序固定小→大。 */
      demonstration: 'animated-noninteractive-both-options',
    },
  };

  constructor(ctx) {
    super(ctx);
    this.trial = -1;
    this.phase = 'iti';
    this.phaseT = 0;
    this.options = {};        // 'ss' | 'll' -> { group, dots, hitbox, side }
    this.chosen = null;
    this.ssChoices = 0;
    this.llChoices = 0;
    this.noChoice = 0;
    this.collected = 0;       // 已落进罐子的水晶数（**只用于摆放，不显示**）
  }

  /** 固定试次：不存在"当前档位"。 */
  get difficultyLabel() { return '固定试次'; }

  enter() {
    super.enter();
    for (const opt of [SS, LL]) {
      const built = delayOptionProp(this.ctx.assets, opt);
      const hb = this.makeHitbox(built.group, { radius: HIT_R });
      built.group.add(hb);
      this.root.add(built.group);
      this.options[opt.key] = { opt, ...built, hitbox: hb, side: 'L' };
    }
    const jar = delayJarProp(this.ctx.assets, TRIALS * LL.reward);
    this.root.add(jar.group);
    this.jar = jar.group;
    this.gems = jar.gems;
    this._nextTrial();
  }

  /* ------------------------------ 试次流程 ------------------------------ */

  _nextTrial() {
    this.trial++;
    if (this.trial >= TRIALS) { this.finished = true; return; }

    const side = SS_SIDE[this.trial];
    this.options.ss.side = side;
    this.options.ll.side = side === 'L' ? 'R' : 'L';
    for (const key of ['ss', 'll']) {
      const o = this.options[key];
      o.group.position.x = o.side === 'L' ? -OPT_X : OPT_X;
      o.group.visible = true;
      o.group.scale.setScalar(0.001);
      // 悬停系数要清零：不清的话上一试次停在 1.06 的那一边，这一试次一出场就比
      // 另一边大一圈 —— 一个**只出现在某一侧**的视觉偏置，而且画面上看不出来
      o.group.userData.k = 1;
      for (const d of o.dots) d.material.opacity = 0.95;
    }
    this.chosen = null;
    this.hitboxes.length = 0;
    this._setPhase('reveal');
    this.ctx.kin?.segment(`choose-${this.trial + 1}`);
  }

  _setPhase(p) { this.phase = p; this.phaseT = 0; }

  /** 出手了。两个选项的确认**完全相同**（同一个音、同一种粒子、同一强度震动）。 */
  _choose(key, pointer) {
    const { fx, audio, input } = this.ctx;
    const o = this.options[key];
    const rt = this.phaseT * 1000;

    this.chosen = o;
    if (key === 'ss') this.ssChoices++; else this.llChoices++;

    this.logTrial({
      kind: 'choice',
      // 选择题没有对错。**这一条必须有**，否则 Metrics 会把它当成一个答错的
      // Go 试次算进正确率、RT、d′ 和错后减速里（见 Metrics._summarize）
      scored: false,
      responded: true,
      correct: null,
      rt,
      choice: key,
      delaySec: o.opt.delay,
      reward: o.opt.reward,
      side: o.side,
      trial: this.trial,
    });

    fx.burst(o.group.position, { color: 0x9fb8e6, count: 12, speed: 2.2, size: 0.42, ttl: 0.36 });
    audio.select();
    input.pulse(pointer, 0.5, 35);

    this.hitboxes.length = 0;
    this._setPhase('wait');
    // 等待期单独成段：孩子在"无事可做的 15 秒"里怎么动，正是多动维度最该看的一段
    this.ctx.kin?.segment(`wait-${key}-${this.trial + 1}`);
  }

  /** 决策窗关掉了还没选。不给奖励，也**不给任何负面反馈**。 */
  _timeout() {
    this.noChoice++;
    this.logTrial({
      kind: 'choice', scored: false, responded: false, correct: null,
      rt: null, choice: null, delaySec: null, reward: 0,
      side: null, trial: this.trial,
    });
    this.hitboxes.length = 0;
    this._setPhase('nochoice');
  }

  /** 把奖励收进罐子。两个选项走**同一套**动画，只是颗数不同。 */
  _collect() {
    const n = this.chosen.opt.reward;
    for (let i = 0; i < n && this.collected < this.gems.length; i++) {
      this.gems[this.collected++].visible = true;
    }
    this.ctx.fx.ring(this.jar.position, { color: 0x8fd7ff, from: 0.2, to: 0.9, ttl: 0.5 });
    this.ctx.audio.calmBell(0);
  }

  update(dt) {
    this.elapsed += dt;
    this.phaseT += dt;

    const { hovered, presses } = this.readPointers();
    if (this.phase === 'choice') {
      for (const press of presses) {
        const key = press.target === this.options.ss.group ? 'ss'
          : press.target === this.options.ll.group ? 'll' : null;
        if (key) { this._choose(key, press.pointer); break; }
      }
    }

    switch (this.phase) {
      case 'reveal': {
        // 两个选项一起浮现，**一模一样的曲线** —— 谁先出来谁就被多看一眼
        const k = Math.min(1, this.phaseT / REVEAL_SEC);
        for (const key of ['ss', 'll']) this.options[key].group.scale.setScalar(k * k * (3 - 2 * k));
        if (this.phaseT >= REVEAL_SEC) {
          for (const key of ['ss', 'll']) this.hitboxes.push(this.options[key].hitbox);
          this._setPhase('choice');
        }
        break;
      }

      case 'choice': {
        if (this.phaseT >= CHOICE_WINDOW) this._timeout();
        break;
      }

      case 'wait': {
        // 没选中的那个淡出：留着会让孩子一直在心里比较，等待期就不再是"纯等待"
        const other = this.chosen === this.options.ss ? this.options.ll : this.options.ss;
        other.group.scale.multiplyScalar(Math.max(0.0001, 1 - dt * 6));

        // 倒数点一秒灭一颗。**这是等待期里唯一会动的东西**（Antrop 2006）
        const left = Math.max(0, this.chosen.opt.delay - this.phaseT);
        this.chosen.dots.forEach((d, i) => {
          d.material.opacity = i < Math.ceil(left) ? 0.95 : 0.06;
        });

        this.waitedSec += dt;
        if (this.phaseT >= this.chosen.opt.delay) { this._collect(); this._setPhase('collect'); }
        break;
      }

      case 'collect': {
        // 领奖：选项缩没，水晶已经在罐子里了
        const k = Math.max(0, 1 - this.phaseT / COLLECT_SEC);
        this.chosen.group.scale.setScalar(Math.max(0.0001, k));
        if (this.phaseT >= COLLECT_SEC) this._setPhase('iti');
        break;
      }

      case 'nochoice': {
        for (const key of ['ss', 'll']) {
          this.options[key].group.scale.multiplyScalar(Math.max(0.0001, 1 - dt * 6));
        }
        if (this.phaseT >= NO_CHOICE_PAUSE) this._setPhase('iti');
        break;
      }

      case 'iti': {
        if (this.phaseT >= ITI) {
          for (const key of ['ss', 'll']) this.options[key].group.visible = false;
          this._nextTrial();
        }
        break;
      }

      default: break;
    }

    // 悬停放大幅度小（1.06）：两个选项本来就大，大幅缩放会让"它在变大"
    // 本身变成一个视觉事件，而两边的视觉事件强度必须相等
    for (const key of ['ss', 'll']) {
      const o = this.options[key];
      if (this.phase !== 'choice') continue;
      const target = hovered.has(o.group) ? 1.06 : 1;
      o.group.userData.k = THREE.MathUtils.lerp(o.group.userData.k ?? 1, target, dt * 12);
      o.group.scale.setScalar(o.group.userData.k);
    }

    // 罐口极慢自转当存在感，**不跟专注度联动**（那是神经反馈闭环）
    this.jar.rotation.y += dt * 0.12;
  }

  hudState() {
    return {
      title: this.meta.name,
      color: this.meta.color,
      mode: 'assess',
      // 进度按**次**报，不是按段 —— 这一关不分段，写"第 3 段"就是假的
      unit: '次',
      block: Math.min(this.trial + 1, TRIALS),
      blockCount: TRIALS,
      breaking: false,
      // 时长不固定，所以进度条走的是试次而不是秒。让孩子看得见"还剩几次"
      // 也正是这个条件要的：选小奖能提前结束，这件事必须是可学会的
      timeLeft: TRIALS - Math.min(this.trial, TRIALS),
      duration: TRIALS,
      level: this.difficultyLabel,
    };
  }
}
