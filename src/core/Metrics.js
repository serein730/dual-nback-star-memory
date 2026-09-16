/**
 * 试次级数据采集与注意力指标计算。
 *
 * 采用 CPT（持续操作测验）体系里公认的一组指标，而不是只报"得分"：
 *   - 漏报 omission     → 持续性注意（走神）
 *   - 误报 commission   → 反应抑制（冲动）
 *   - RT 均值           → 加工速度
 *   - RT 变异系数 CV    → 注意力稳定性，ADHD 研究中比 RT 均值更敏感的指标
 *   - RT 长尾 τ         → 同上，但比 CV 更敏感（见下方 exGaussian 的注释）
 *   - d′ (敏感性)       → 剔除"乱按"策略影响后的真实辨别力
 *   - 抢答 anticipatory → 刺激还来不及被加工就出手，冲动的另一个侧面
 *   - 错后减速 PES      → 犯错之后有没有"收一收"
 *   - 分段正确率        → 警觉度衰减曲线（vigilance decrement）
 *
 * 说明：本原型的数值仅用于演示数据链路，未经任何常模标定，不能作为评估依据。
 */

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * 抢答阈值（ms）。刺激呈现后这么短的时间内出手，不可能是被这个刺激驱动的 ——
 * 它反映的是"手已经在路上了"。QbTest 的 6–12 岁版本专门把这一项单列
 * （anticipatory errors），本项目照做：抢答**不计入命中，也不进 RT 统计**，
 * 混进去会把 RT 均值和 τ 一起拉偏。
 */
export const ANTICIPATORY_MS = 150;

/** 标准正态分位数（Acklam 有理逼近，|误差| < 1.15e-9），用于 d′。 */
export function probit(p) {
  p = Math.max(1e-6, Math.min(1 - 1e-6, p));
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > ph) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * ex-Gaussian 三参数分解（μ / σ / τ）。
 *
 * **为什么要它**：反应时变异性（RTV）是 ADHD 行为指标里组间差异最稳的一个
 * （Kofler 2013 元分析 319 项研究，g = 0.71，比 RT 均值敏感）。但把 RTV 压成
 * 一个 CV 会丢掉最有信息量的部分 —— 后续元分析显示，ADHD 的 RTV 升高**主要来自
 * 分布的长尾**：把 RT 分布拆成"高斯主体 + 指数长尾"之后，
 * **τ（长尾成分）的效应量明显大于 σ（主体离散度），也大于 CV**。
 * 直观含义：τ 大 = 偶发的"整个人不在线"的超慢反应多，而不是整体反应慢。
 *
 * **用的是矩估计（method of moments），不是极大似然。** MoM 效率低于 MLE，
 * 但它闭式可解、零依赖、不会不收敛；而 MLE 需要 erfc 近似加迭代优化，
 * 在一个"演示数据链路"的原型里不值得。**这一点必须如实标注**，
 * 别让人以为这里的 τ 能直接跟论文里的 MLE 估计值对比。
 *
 *   均值   m  = μ + τ
 *   方差   v  = σ² + τ²
 *   偏度   γ  = 2τ³ / (σ²+τ²)^1.5
 *   ⇒ τ = (γ/2)^(1/3)·√v ，  μ = m − τ ，  σ = √(v − τ²)
 *
 * @param {number[]} rts 反应时（ms）
 * @param {number}   minN 少于这么多个就不给结果（拟合本身会变得没有意义）
 */
export function exGaussian(rts, minN = 40) {
  const n = rts.length;
  if (n < minN) return { ok: false, n, reason: 'too-few-trials', mu: null, sigma: null, tau: null };

  const m = rts.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m3 = 0;
  for (const x of rts) { const d = x - m; m2 += d * d; m3 += d * d * d; }
  m2 /= n; m3 /= n;
  const sd = Math.sqrt(m2);
  if (sd <= 0) return { ok: false, n, reason: 'zero-variance', mu: null, sigma: null, tau: null };

  // 偏度必须为正才有指数长尾可分。负偏（左偏）在 RT 数据里通常意味着
  // 试次太少或有截尾，此时硬算会得到虚数 σ —— 如实报 ok:false，别编一个数出来。
  let skew = m3 / (m2 * sd);
  if (skew <= 0.01) return { ok: false, n, reason: 'non-positive-skew', skew, mu: null, sigma: null, tau: null };
  // γ→2 时 τ→sd、σ→0；再往上 σ² 变负。夹住上界而不是让它溢出。
  const clipped = skew > 1.98;
  if (clipped) skew = 1.98;

  const tau = Math.cbrt(skew / 2) * sd;
  const sigma = Math.sqrt(Math.max(1e-6, m2 - tau * tau));
  return { ok: true, n, mu: m - tau, sigma, tau, skew, clipped, method: 'moments' };
}

export class Metrics {
  constructor() { this.reset(); }

  reset() {
    this.trials = [];
    this.attentionSamples = [];   // { t, value }
    this.restSamples = [];        // 静息环节采到的专注度
    this.eegSnapshots = [];       // 2Hz 上游快照原样留档，见 sampleEegSnapshot
    this._lastEegKey = null;      // 去重键（上游的 elapsedSec）
    this._eegMeta = null;         // 会话级：runId / 设备 / 是否真机
    this.phases = [];             // 流程打点 { t, phase, game }，见 markPhase
    this._phase = null;
    this._phaseGame = null;
    this.startedAt = performance.now();
    this.startedAtUnix = Date.now();   // 墙上时间。脑电原始数据按它切片，performance.now 对不上
    this.byGame = new Map();
  }

  /**
   * @param {object} t
   *   game         关卡 id
   *   kind         'go' | 'nogo' | 'search' | 'memory' | 'choice'
   *   responded    是否做出了反应
   *   correct      该试次是否正确（`scored:false` 的试次传 null）
   *   rt           反应时（ms），未反应为 null
   *   level        当时的难度档位
   *   —— 以下仅测评档写入（训练档没有，读的时候都要允许 undefined）——
   *   block        第几段（0 起）
   *   half         'low-go' | 'high-go'，TOVA 式两半设计里的哪一半
   *   anticipatory 是否抢答（rt < ANTICIPATORY_MS）
   *   —— 仅延迟选择关（`kind:'choice'`）写入 ——
   *   scored       false = **这个试次没有对错**，整条不进正确率/RT/d′/PES/警觉度曲线
   *   choice       'ss'（马上拿）| 'll'（等一等）| null（超时未选）
   *   delaySec     这次实际等了多久；reward 拿到几颗；side 选的是左还是右
   */
  addTrial(t) {
    const rec = { ...t, at: performance.now() - this.startedAt };
    this.trials.push(rec);
    if (!this.byGame.has(t.game)) this.byGame.set(t.game, []);
    this.byGame.get(t.game).push(rec);
    return rec;
  }

  /**
   * @param {number} value   专注度指数 0-100
   * @param {number} quality 信号质量 0-1。接真机后必须记这个：电极松脱时数据源会把
   *   指数压回中位，曲线看上去"平稳正常"，但那是没数据，不是真的平稳。不记录质量的话
   *   报告没法区分这两种情况——而它们对家长意味着完全相反的事。
   */
  sampleAttention(value, quality = 1) {
    this.attentionSamples.push({ t: performance.now() - this.startedAt, value, quality });
  }

  /**
   * 流程打点：记下"这一刻在做什么"。
   *
   * 为什么必须打点而不是事后按试次时间反推：**静息、演示、说明页、段间休息里一个试次都没有**，
   * 反推只能覆盖有试次的时段，而那几段恰恰是最该单独看的（静息是基线，演示会让孩子兴奋，
   * 段间休息是"缓过来了没有"）。2026-08-09 第一次分析真人数据时就卡在这里 ——
   * 体验档三个关卡只能靠 `trial.game` 拆，静息段无处归属。
   *
   * @param {string} phase 状态机的状态名（menu/demo/rest/brief/countdown/play/result/report/bci）
   * @param {string=} game 当前（或即将进入）的关卡 id，没有就传 null
   */
  markPhase(phase, game = null) {
    if (phase === this._phase && game === this._phaseGame) return;
    this._phase = phase;
    this._phaseGame = game;
    this.phases.push({ t: +(performance.now() - this.startedAt).toFixed(1), phase, game });
  }

  /**
   * 记一帧**上游脑电快照**（六条频带功率、α/β、信号质量、电压标准差……）。
   *
   * 和 sampleAttention 的分工：那条记的是**换算之后**的专注度指数（0–100 的一个数），
   * 这条记的是**脑电本身**。原来只留前者，等于把 EI = β/(α+θ) 之前的信息全丢了 ——
   * 拿到导出的人既没法重算指数、没法换一套算法，也看不出某一段里 α 到底发生了什么。
   * 而那 2Hz 的完整快照游戏侧**本来就在轮询拿**，只是用完就扔。
   *
   * ⚠️ 调用方每帧调（60Hz），上游只有 2Hz。**必须按 elapsedSec 去重** —— 它是采集器
   * 自己的时钟，同一条快照被重复读到时值不变。不去重的话一场会存下约三万条记录、
   * 十几 MB，其中 29/30 是同一帧的副本。
   *
   * @param {object} snap  BCIAdapter 的上游快照（DreamLabSource.last）
   * @param {number=} attention 同一时刻换算出的专注度指数，一并留档便于对齐
   * @param {number=} quality   同一时刻的质量系数 0–1
   */
  sampleEegSnapshot(snap, attention = null, quality = null) {
    if (!snap || snap.ok === false) return;
    const key = snap.elapsedSec;
    if (key == null || key === this._lastEegKey) return;
    this._lastEegKey = key;

    // 会话级信息不必每条都存。firstRunId ≠ lastRunId 说明采集器中途重启过 ——
    // 那意味着这一场的原始波形分在两个 session 目录里，拿数据的人必须知道
    if (!this._eegMeta) {
      this._eegMeta = {
        firstRunId: snap.runId ?? null, lastRunId: snap.runId ?? null,
        device: snap.device ?? null, live: snap.live ?? null,
        sampleRateHz: snap.sampleRateHz ?? null,
      };
    } else {
      this._eegMeta.lastRunId = snap.runId ?? this._eegMeta.lastRunId;
    }

    this.eegSnapshots.push({
      // 游戏时间轴（ms，与试次的 `at` 同一起点）—— 要把脑电和某个试次对上就靠这一列
      t: +(performance.now() - this.startedAt).toFixed(1),
      // 采集器自己的时钟。跨到原始波形（raw 里的 CSV）时用它定位
      elapsedSec: key,
      // 打点：这一帧属于流程的哪一段、哪一关。有了它，分析时直接 group by 就能分关卡看，
      // 不必再拿试次时间去反推（静息与演示段根本没有试次可反推）
      phase: this._phase, game: this._phaseGame,
      attention, quality,
      qualityStatus: snap.qualityStatus ?? null,
      contaminated: snap.contaminated ?? null,
      contaminationReasons: snap.contaminationReasons ?? null,
      voltageStdUv: snap.voltageStdUv ?? null,
      alphaRmsUv: snap.alphaRmsUv ?? null,
      betaRmsUv: snap.betaRmsUv ?? null,
      alphaBetaRatio: snap.alphaBetaRatio ?? null,
      band: snap.band ?? null,
      orientationG: snap.orientationG ?? null,
    });
  }

  /** 静息环节的专注度采样（与任务态分开存，两者要做差）。 */
  sampleRest(value) { this.restSamples.push(value); }

  /**
   * 静息基线。之所以要它：专注度指数的绝对值受电极位置、个体差异影响太大，
   * 单看"任务时 62 分"没有解释力；「任务态比自己的静息态高多少」才是可比的量。
   */
  get restBaseline() {
    if (!this.restSamples.length) return null;
    return this.restSamples.reduce((a, b) => a + b, 0) / this.restSamples.length;
  }

  get taskAttentionMean() {
    if (!this.attentionSamples.length) return null;
    return this.attentionSamples.reduce((a, b) => a + b.value, 0) / this.attentionSamples.length;
  }

  /** @param {string=} game 只统计某一关；省略则统计整场会话。 */
  summary(game) {
    return this._summarize(game ? (this.byGame.get(game) || []) : this.trials);
  }

  /**
   * 双模态 N-back 的专用汇总。每个时间点有视觉、听觉两条独立的 Go/No-Go
   * 记录，不能把其中一条的命中拿去抵另一条的漏报；这里分别汇总后再给总数。
   */
  nBackSummary(game) {
    const all = (game ? (this.byGame.get(game) || []) : this.trials)
      .filter((t) => t.paradigm === 'dual-nback');
    const visual = all.filter((t) => t.modality === 'visual');
    const auditory = all.filter((t) => t.modality === 'auditory');
    const scored = all.filter((t) => t.scored !== false && !t.anticipatory);
    const levels = [...new Set(scored.map((t) => t.n).filter(Number.isFinite))];
    const group = (key) => {
      const buckets = new Map();
      for (const t of all) {
        const value = t[key];
        if (value == null) continue;
        if (!buckets.has(value)) buckets.set(value, []);
        buckets.get(value).push(t);
      }
      return [...buckets.keys()].sort((a, b) => Number(a) - Number(b)).map((value) => {
        const list = buckets.get(value);
        return {
          [key]: value,
          overall: this._summarize(list),
          visual: this._summarize(list.filter((t) => t.modality === 'visual')),
          auditory: this._summarize(list.filter((t) => t.modality === 'auditory')),
        };
      });
    };
    return {
      trials: scored.length,
      warmup: all.filter((t) => t.scored === false).length,
      levels,
      overall: this._summarize(all),
      visual: this._summarize(visual),
      auditory: this._summarize(auditory),
      // 自适应任务只报总体数会混合不同工作记忆负荷。纵向追踪应优先比较
      // 相同 n 下的命中、漏报、虚报、d′ 与反应时，并保留各段的适应轨迹。
      byBlock: group('block'),
      byLevel: group('n'),
    };
  }

  /**
   * 按测评档的"段"（block）分组统计。训练档的试次没有 block 字段，返回空数组。
   * 段级统计是警觉度衰减曲线的分辨率来源 —— 整场一个数看不出"后半程掉线"。
   */
  blockSummary(game) {
    const list = game ? (this.byGame.get(game) || []) : this.trials;
    const groups = new Map();
    for (const t of list) {
      if (t.block == null) continue;
      if (!groups.has(t.block)) groups.set(t.block, []);
      groups.get(t.block).push(t);
    }
    return [...groups.keys()].sort((a, b) => a - b).map((b) => ({
      block: b,
      half: groups.get(b)[0].half ?? null,
      ...this._summarize(groups.get(b)),
    }));
  }

  /** 只按 TOVA 式两半（低目标率 / 高目标率）分组。 */
  halfSummary(game) {
    const list = game ? (this.byGame.get(game) || []) : this.trials;
    const out = {};
    for (const half of ['low-go', 'high-go']) {
      const seg = list.filter((t) => t.half === half);
      if (seg.length) out[half] = this._summarize(seg);
    }
    return out;
  }

  /**
   * 延迟选择关的统计。**和上面那套 CPT 口径完全分开** —— 这里没有正确率、没有 d′，
   * 因为这个范式里没有正确答案，"选小奖"不是错误。
   *
   * 主指标是 `ssRate`（选"马上拿"的比例）。⚠️ 它**没有常模、也没有方向性判断**：
   * 高不等于有问题，低不等于好。它的用处是和量表、和 CPT 指标并排看，
   * 以及**个体内**的前后对比。任何"超过 X 就怎样"的阈值我们都没有依据定。
   *
   * `earlyVsLate` 是同一场里前一半与后一半的差：一个开头愿意等、后来不愿等的孩子，
   * 和一个从头到尾都不愿等的孩子，`ssRate` 可能一模一样，但那是两件事。
   */
  choiceSummary(game) {
    const list = (game ? (this.byGame.get(game) || []) : this.trials)
      .filter((t) => t.kind === 'choice');
    const out = {
      trials: list.length, made: 0, noChoice: 0, ss: 0, ll: 0,
      ssRate: null, decisionMs: null, decisionSD: null,
      totalDelaySec: 0, rewards: 0,
      earlyVsLate: null, sideBias: null,
    };
    if (!list.length) return out;

    const rts = [];
    let leftPicks = 0;
    for (const t of list) {
      if (!t.responded) { out.noChoice++; continue; }
      out.made++;
      if (t.choice === 'ss') out.ss++; else out.ll++;
      out.totalDelaySec += t.delaySec || 0;
      out.rewards += t.reward || 0;
      if (t.side === 'L') leftPicks++;
      if (typeof t.rt === 'number') rts.push(t.rt);
    }
    if (!out.made) return out;

    out.ssRate = out.ss / out.made;
    // 位置定势：一直点同一边的孩子可能根本没在看两边的差别，那样 ssRate 就不可解读。
    // 0.5 = 左右各半；接近 0 或 1 = 只按一边。这是**数据可信度**的指标，不是行为指标。
    out.sideBias = leftPicks / out.made;

    if (rts.length) {
      out.decisionMs = rts.reduce((a, b) => a + b, 0) / rts.length;
      out.decisionSD = Math.sqrt(
        rts.reduce((a, b) => a + (b - out.decisionMs) ** 2, 0) / rts.length,
      );
    }

    const half = Math.floor(list.length / 2);
    const rate = (seg) => {
      const m = seg.filter((t) => t.responded);
      return m.length ? m.filter((t) => t.choice === 'ss').length / m.length : null;
    };
    const early = rate(list.slice(0, half)), late = rate(list.slice(half));
    if (early != null && late != null) out.earlyVsLate = { early, late, delta: late - early };
    return out;
  }

  _summarize(list) {
    const s = {
      total: 0,
      hits: 0, omissions: 0, commissions: 0, correctRejections: 0, wrongChoices: 0,
      goTrials: 0, nogoTrials: 0, anticipatory: 0,
      accuracy: 0, rtMean: 0, rtSD: 0, rtCV: 0, dPrime: 0,
      hitRate: 0, omissionRate: 0, falseAlarmRate: 0,
      exG: null, postErrorSlowing: null,
      bestStreak: 0, score: 0, unscored: 0,
    };
    if (!list.length) return s;

    // ☠️ **没有对错的试次必须整条剔出去**（延迟选择关：`scored:false`）。
    // 不剔的话下面每一步都会静默地把它当成"一个答错的 Go 试次"：`correct` 是 null
    // → 算进正确率的分母、`rt` 进 RT 与 τ、`kind` 不是 'nogo' → 进 d′ 的命中率、
    // 还会被错后减速当成一次错误。**报出来的每个数都仍然是个正常的数**，
    // 只是整场的正确率被一个"根本没有正确答案的任务"拉低了十个百分点。
    const scored = [];
    for (const t of list) {
      if (t.scored === false) s.unscored++;
      else scored.push(t);
    }
    if (!scored.length) return s;

    // 抢答整条剔出去再统计。它既不是命中也不是漏报 —— 把它算进任何一类，
    // 正确率和 d′ 都会被一个跟刺激无关的动作带偏（见 ANTICIPATORY_MS）。
    const valid = [];
    for (const t of scored) {
      if (t.anticipatory) s.anticipatory++;
      else valid.push(t);
    }
    s.total = valid.length;
    if (!valid.length) return s;

    const rts = [];
    let streak = 0;
    for (const t of valid) {
      const isNoGo = t.kind === 'nogo';
      if (isNoGo) {
        s.nogoTrials++;
        if (t.responded) s.commissions++; else s.correctRejections++;
      } else {
        s.goTrials++;
        if (t.correct) { s.hits++; if (typeof t.rt === 'number') rts.push(t.rt); }
        // 搜索/记忆类任务里"做了反应但选错了"既不是漏报也不是虚报，单独归类，
        // 否则会污染 d′ 的虚报率
        else if (t.responded) s.wrongChoices++;
        else s.omissions++;
      }
      if (t.correct) { streak++; s.bestStreak = Math.max(s.bestStreak, streak); }
      else streak = 0;
    }

    s.accuracy = valid.filter((t) => t.correct).length / valid.length;

    if (rts.length) {
      s.rtMean = rts.reduce((a, b) => a + b, 0) / rts.length;
      const v = rts.reduce((a, b) => a + (b - s.rtMean) ** 2, 0) / rts.length;
      s.rtSD = Math.sqrt(v);
      s.rtCV = s.rtMean > 0 ? s.rtSD / s.rtMean : 0;
      s.exG = exGaussian(rts);
    }

    // d′：命中率与虚报率各做 log-linear 修正，避免 0/1 导致无穷大
    if (s.goTrials > 0 && s.nogoTrials > 0) {
      s.hitRate = s.hits / s.goTrials;
      s.omissionRate = s.omissions / s.goTrials;
      s.falseAlarmRate = s.commissions / s.nogoTrials;
      const hr = (s.hits + 0.5) / (s.goTrials + 1);
      const far = (s.commissions + 0.5) / (s.nogoTrials + 1);
      s.dPrime = probit(clamp01(hr)) - probit(clamp01(far));
    } else if (s.goTrials > 0) {
      s.hitRate = s.hits / s.goTrials;
      s.omissionRate = s.omissions / s.goTrials;
    } else if (s.nogoTrials > 0) {
      s.falseAlarmRate = s.commissions / s.nogoTrials;
    }

    s.postErrorSlowing = this._pes(valid);
    return s;
  }

  /**
   * 错后减速（post-error slowing）：错完一次之后的那一个反应，比答对之后的慢多少毫秒。
   * 正值 = 犯错后会"收一收"（正常的表现监控）；接近 0 或为负值 = 错了也不调整。
   * 只在有 RT 的试次上算，两侧各至少 5 个才给结果 —— 少于这个数噪声大过信号。
   */
  _pes(list) {
    const after = { err: [], ok: [] };
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      if (typeof cur.rt !== 'number') continue;
      (prev.correct ? after.ok : after.err).push(cur.rt);
    }
    if (after.err.length < 5 || after.ok.length < 5) return null;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    return mean(after.err) - mean(after.ok);
  }

  /**
   * 把会话切成 n 段看正确率与 RT 的漂移 —— 走神通常发生在后半程。
   * 无对错的试次（延迟选择关）先剔掉：它们没有 `correct`，混进来会把曲线整体压低，
   * 而曲线本身看不出哪一段是被污染的。全是无对错试次的关卡返回空数组。
   */
  vigilanceCurve(n = 6, game) {
    const all = game ? (this.byGame.get(game) || []) : this.trials;
    const list = all.filter((t) => t.scored !== false);
    if (!list.length) return [];
    if (list.length < n) n = Math.max(2, Math.floor(list.length / 2)) || 1;
    const out = [];
    const per = Math.ceil(list.length / n) || 1;
    for (let i = 0; i < n; i++) {
      const seg = list.slice(i * per, (i + 1) * per);
      if (!seg.length) continue;
      const rts = seg.filter((t) => typeof t.rt === 'number').map((t) => t.rt);
      out.push({
        index: i,
        accuracy: seg.filter((t) => t.correct).length / seg.length,
        rt: rts.length ? rts.reduce((a, b) => a + b, 0) / rts.length : null,
      });
    }
    return out;
  }

  attentionCurve(points = 48) {
    if (!this.attentionSamples.length) return [];
    const step = Math.max(1, Math.floor(this.attentionSamples.length / points));
    const out = [];
    for (let i = 0; i < this.attentionSamples.length; i += step) {
      const chunk = this.attentionSamples.slice(i, i + step);
      out.push(chunk.reduce((a, b) => a + b.value, 0) / chunk.length);
    }
    return out;
  }

  /** 0~3 颗星，给孩子的即时激励；权重偏向"稳"而不是"快"。 */
  stars(game) {
    const s = this.summary(game);
    if (!s.total) return 0;
    let pts = 0;
    if (s.accuracy >= 0.6) pts++;
    if (s.accuracy >= 0.78) pts++;
    if (s.accuracy >= 0.9 || (s.accuracy >= 0.82 && s.rtCV > 0 && s.rtCV < 0.28)) pts++;
    return pts;
  }

  /** 本次会话里信号不可用的采样占比。真机接入后这是解读专注度曲线的前提条件。 */
  get lowQualityRatio() {
    if (!this.attentionSamples.length) return null;
    const bad = this.attentionSamples.filter((s) => (s.quality ?? 1) < 0.35).length;
    return bad / this.attentionSamples.length;
  }

  /**
   * 按阶段聚合脑电，键形如 `play:cpt` / `rest` / `demo:beam`。
   *
   * 直接给出"每一关、每一段的专注度与信号质量"，省得每个拿到数据的人自己写一遍
   * 对齐代码 —— 各写各的口径迟早不一致，而不一致了没人会发现。
   *
   * ⚠️ **阶段之间的指数不可直接比较。** 不同任务的眼动量不同，而 1 导联前额电极对扫视
   * 极敏感（β 会被污染，EI=β/(α+θ)）。2026-08-09 实测：视觉搜索关(beam)比另两关低 25 分，
   * 那更可能是眼动伪迹而不是"孩子在这一关不投入"。同一阶段的**个体内前后比较**才是安全的。
   */
  _eegByPhase() {
    const groups = new Map();
    for (const s of this.eegSnapshots) {
      const key = s.game ? `${s.phase}:${s.game}` : (s.phase || 'unknown');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const num = (list, k) => {
      const v = list.map((x) => x[k]).filter((x) => typeof x === 'number');
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const r = (v, d = 2) => (v == null ? null : +v.toFixed(d));
    const out = {};
    for (const [key, list] of groups) {
      const att = list.map((x) => x.attention).filter((v) => typeof v === 'number');
      const m = att.length ? att.reduce((a, b) => a + b, 0) / att.length : null;
      out[key] = {
        n: list.length,
        durationMs: +(list[list.length - 1].t - list[0].t).toFixed(1),
        attentionMean: r(m),
        attentionSD: r(att.length ? Math.sqrt(att.reduce((a, b) => a + (b - m) ** 2, 0) / att.length) : null),
        alphaRmsUv: r(num(list, 'alphaRmsUv')),
        betaRmsUv: r(num(list, 'betaRmsUv')),
        alphaBetaRatio: r(num(list, 'alphaBetaRatio')),
        voltageStdUv: r(num(list, 'voltageStdUv')),
        goodRatio: r(list.filter((x) => x.qualityStatus === 'GOOD').length / list.length, 3),
      };
    }
    return out;
  }

  /**
   * 导出为 JSON —— 未来对接家长端/后端的数据格式草案。
   * @param {object=} meta 由 Game 注入的数据源信息（设备名/是否真机/标定状态）。
   *   Metrics 不认识 BCIAdapter，这条按项目惯例走 Game 转手。
   */
  export(meta = {}) {
    const games = {};
    for (const g of this.byGame.keys()) {
      const blocks = this.blockSummary(g);
      games[g] = {
        summary: this.summary(g),
        vigilance: this.vigilanceCurve(6, g),
        stars: this.stars(g),
      };
      // 测评档才有的两块。训练档没有 block 字段，这里就不会多出空对象 ——
      // 拿到这份 JSON 的人据此就能一眼分出"这是哪一档跑出来的"
      if (blocks.length) {
        games[g].blocks = blocks;
        games[g].halves = this.halfSummary(g);
      }
      // 延迟选择关才有。它和上面的 summary 是**两套不可混用的口径** ——
      // 那一关的 summary 里正确率/d′ 全是 0，因为它根本没有对错（unscored 才是它的试次数）
      const choice = this.choiceSummary(g);
      if (choice.trials) games[g].choice = choice;
      const nback = this.nBackSummary(g);
      if (nback.trials || nback.warmup) games[g].nback = nback;
    }
    return {
      // v5（2026-08-09）：新增 `phases` 流程打点，每条脑电快照带上 `phase`/`game`，
      //   并给出 `eeg.byPhase` 按阶段的聚合。起因是第一次分析真人数据时发现：
      //   **静息、演示、说明页、段间休息里一个试次都没有**，只靠试次时间反推分不出段来，
      //   而那几段恰恰最该单独看（静息是基线、演示会让孩子兴奋）。
      // v4（2026-08-09）：新增 `eeg` 段 —— 2Hz 上游快照的完整时间序列（频带功率、
      //   α/β、信号质量），以及 `startedAtUnix`/`endedAtUnix` 两个墙上时间戳。
      //   在此之前脑电只以 `attentionCurve` 的 48 个降采样点存在，**丢掉了 99.8%**，
      //   既没法和试次对齐，也拿不到脑电本身（只有换算后的指数）。
      // v3（2026-08-08）：测评档变成两关，`protocol` 与 `kinematics` 从单个对象
      // 改成按关卡 id 索引的表；新增 `games.<id>.choice`（延迟选择关的口径）
      // 与 `summary.unscored`（无对错试次数）。v2 的读法在这三处上会读到 undefined。
      // v6（2026-08-22）：新增顶层 `ufov` 段（老年训练档的呈现时长阈值与双阶梯落点）。
      //   ☠️ **它必须由这里显式挑出来** —— `export()` 不展开 `meta`，而是逐项点名。
      //   2026-08-22 踩过：只往 `Game._exportMeta()` 加了字段，报告里一声不响地没有它，
      //   viz 那边读到 undefined 就当"这一版还没记阈值"，两边都不报错。
      //   **加任何新的导出字段都要改这里，不是只改 `_exportMeta()`。**
      version: 7,
      generatedAt: new Date().toISOString(),
      durationMs: performance.now() - this.startedAt,
      // ★ 墙上时间。performance.now() 的起点是页面加载，跨不到采集器那边去；
      // 要把这一场和 raw 里的原始波形对上，只能靠这两个 unix 毫秒戳
      startedAtUnix: this.startedAtUnix,
      endedAtUnix: Date.now(),
      // 'assess' = 固定难度测评档；'nback' = 双模态工作记忆纵向追踪；
      // 'full'/'single' = 自适应体验档。自适应档都没有常模，不做诊断性解释。
      // 缺了这一行，两档产出的 JSON 长得一样，而它们的可比性完全不同。
      sessionMode: meta.sessionMode ?? null,
      // 按关卡 id 索引：`{ cpt: {...}, delay: {...} }`。测评档有两关，而两关的
      // 施测协议完全不同（一个固定时长、一个时长随选择变化），合成一份就说不清了
      protocol: meta.protocol ?? null,
      overall: this.summary(),
      games,
      // 头部运动学（"多动"维度），同样按关卡 id 索引 —— `Kinematics.start()` 会
      // 清空上一关的采样，所以每一关结束时都得先取一份快照（见 Game._endLevel）。
      // 桌面端相机是固定的，采不到真实头动 —— valid=false 时下面的数字
      // **不是"这孩子很安静"，是"没有测"**。
      kinematics: meta.kinematics ?? null,
      // 老年训练档唯一的输出指标（呈现时长阈值 + 双阶梯落点）。别让消费方从 trials 重算 ——
      // 算它要复现反转点判定，那套逻辑只该有一份（在 `UfovStaircase` 里）。其它档为 null。
      ufov: meta.ufov ?? null,
      // 双模态 N-back 的自适应轨迹（每段 n、段正确率与下一段 n）。
      // 原始试次仍在 trials，保留这份快照避免消费方各自复算适应规则而漂移。
      nback: meta.nback ?? null,
      rest: {
        baseline: this.restBaseline,
        samples: this.restSamples.length,
        taskMean: this.taskAttentionMean,
      },
      // 专注度数据的来源与可信度。任何拿这份 JSON 做分析的人都得先看这一段：
      // simulated=true 时下面的曲线是模拟信号，不是这个孩子的脑电。
      attentionSource: {
        device: meta.device ?? null,
        simulated: meta.simulated ?? null,
        note: meta.note ?? null,
        detail: meta.detail ?? null,
        lowQualityRatio: this.lowQualityRatio,
      },
      // 48 个降采样点，报告页那条曲线用的就是它。**留着不动**是为了不破坏已有读法；
      // 要做分析请用下面的 eeg.snapshots，那才是完整的
      attentionCurve: this.attentionCurve(),
      // ★ v4 新增：脑电时间序列本身。`snapshots` 每条约 2Hz，一场 8 分 18 秒约 1000 条。
      // ⚠️ `live:false` 时这些是**模拟信号**，不是这个孩子的脑电 —— 分析前先看这一行。
      // ⚠️ `firstRunId !== lastRunId` 说明采集器中途重启过，原始波形分在两个目录里。
      // 流程打点：每一段从什么时候开始。和 trials 的 `at`、eeg 的 `t` 同一时间轴
      phases: this.phases,
      eeg: {
        ...(this._eegMeta || { firstRunId: null, lastRunId: null, device: null, live: null, sampleRateHz: null }),
        count: this.eegSnapshots.length,
        // 按阶段/关卡聚合好的摘要。⚠️ 阶段之间不可直接比较，见 _eegByPhase 的说明
        byPhase: this._eegByPhase(),
        snapshots: this.eegSnapshots,
      },
      trials: this.trials,
    };
  }
}
