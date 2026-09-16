/**
 * 自适应难度。成熟的注意力训练产品几乎都靠它吃饭：难度必须一直贴着孩子能力的边缘走。
 *
 * 太简单 → 自动化处理，注意资源不再被调用，训练无效；
 * 太难   → 连续失败，挫败感摧毁依从性，孩子不肯再玩。
 * 目标是把正确率钳在 75%~85% 这个"心流带"里。
 *
 * 这里给三种机制：
 *  - Adaptive：滑动窗口正确率驱动的连续档位，适合速度/密度类参数（星海捕手、光束聚焦）；
 *  - Staircase：n-up/m-down 阶梯法，适合离散的广度参数；
 *  - UfovStaircase：双阶梯 + 加权 up-down，**测阈值不是调难度**（老年版 UFOV）。
 *
 * ⚠️ 前两种是「把难度钳在心流带」的**训练**工具，第三种是「逼近某个正确率对应的
 * 刺激强度」的**测量**工具 —— 目标不同，别拿一个去替另一个。
 *
 * ⚠️ **Staircase 目前没有使用者。** 回声之路 2026-08-06 换了长度调节规则
 * （答对 +1 / 错 1 次不变 / 连错 2 次 −1，长度由关卡自己管）。类保留是因为它有出处
 * （Levitt 1971，见 决策存档/2026-08-05-范式与证据.md 第六节）、且**关卡时长一旦拉长就必须换回它**
 * （新规则的收敛点只有 29.3%，靠"一局跑不到那里"才成立）—— 不是漏删的死代码。
 */

export class Adaptive {
  constructor({
    start = 0.22,
    min = 0,
    max = 1,
    window = 8,          // 滑动窗口试次数
    upAt = 0.85,         // 窗口正确率高于此值 → 升档
    downAt = 0.6,        // 低于此值 → 降档
    stepUp = 0.09,
    stepDown = 0.12,     // 降档比升档快：先保住孩子的信心
  } = {}) {
    Object.assign(this, { min, max, window, upAt, downAt, stepUp, stepDown });
    this.level = start;
    this.recent = [];
    this.history = [{ trial: 0, level: start }];
    this.changes = 0;
  }

  record(correct) {
    this.recent.push(correct ? 1 : 0);
    if (this.recent.length > this.window) this.recent.shift();
    if (this.recent.length >= Math.min(4, this.window)) {
      const acc = this.recent.reduce((a, b) => a + b, 0) / this.recent.length;
      const before = this.level;
      if (acc >= this.upAt) { this.level = Math.min(this.max, this.level + this.stepUp); this.recent.length = 0; }
      else if (acc <= this.downAt) { this.level = Math.max(this.min, this.level - this.stepDown); this.recent.length = 0; }
      if (before !== this.level) this.changes++;
    }
    this.history.push({ trial: this.history.length, level: this.level });
    return this.level;
  }

  /** 把 0~1 的档位映射到一组具体参数：{ speed:[慢,快], gap:[疏,密] } */
  map(spec) {
    const out = {};
    for (const [k, range] of Object.entries(spec)) {
      out[k] = range[0] + (range[1] - range[0]) * this.level;
    }
    return out;
  }

  /** 给家长报告用的一句话难度描述。 */
  describe() {
    const l = this.level;
    if (l < 0.2) return '入门';
    if (l < 0.42) return '基础';
    if (l < 0.62) return '进阶';
    if (l < 0.82) return '熟练';
    return '挑战';
  }
}

export class Staircase {
  /**
   * 默认 2-up / 1-down：连对两次才加长度，错一次立刻退。
   * 收敛点解 `p² = 1−p` 得 **61.8%**（旧注释写的 ~70% 不准，70.7% 是另一种记法下的值）。
   */
  constructor({ start = 3, min = 2, max = 9, upAfter = 2, downAfter = 1 } = {}) {
    Object.assign(this, { min, max, upAfter, downAfter });
    this.value = start;
    this.correctRun = 0;
    this.wrongRun = 0;
    this.reversals = 0;
    this.peak = start;
    this._lastDir = 0;
  }

  record(correct) {
    if (correct) {
      this.correctRun++; this.wrongRun = 0;
      if (this.correctRun >= this.upAfter) {
        this.correctRun = 0;
        this._move(+1);
      }
    } else {
      this.wrongRun++; this.correctRun = 0;
      if (this.wrongRun >= this.downAfter) {
        this.wrongRun = 0;
        this._move(-1);
      }
    }
    return this.value;
  }

  _move(dir) {
    const next = Math.max(this.min, Math.min(this.max, this.value + dir));
    if (next === this.value) return;
    if (this._lastDir !== 0 && dir !== this._lastDir) this.reversals++;
    this._lastDir = dir;
    this.value = next;
    this.peak = Math.max(this.peak, this.value);
  }
}

/**
 * UFOV 阈值阶梯：双阶梯（two interleaved）+ 加权 up-down，收敛到 **75% 正确率**。
 *
 * ☠️ **单位是「步」不是毫秒**，1 步 = 16.67ms = 本机的 N 帧（60Hz→1 帧、240Hz→4 帧）。
 * 刺激只能落在帧边界上，按毫秒记会在换一台机器时静默失真 ——
 * 见 `.claude/rules/标定-UFOV呈现时长.md`，那条还管着「刷新率必须是 60 的整数倍」。
 *
 * ⚠️ **哪些有出处、哪些是我们定的，必须分清**（决策存档/2026-08-21 §5.2）：
 *  - 【有出处·Inquisit UFOV 手册】呈现时长范围 16.67–500ms（＝1~30 步）、目标准确率 75%、
 *    双阶梯、起始步长 3 帧、**首次答错后步长降为 1 帧**。
 *  - 【我们定的】答对 −1 单位 / 答错 +3 单位这个**加权比例**。原版的确切升降规则没查到，
 *    3:1 是按 Kaernbach 1991 的加权 up-down 推的：稳态时 `p·S_down = (1−p)·S_up`，
 *    代入 p=0.75 解得 `S_up/S_down = 3`。
 *    **这是"能收敛到 75%"的一个正确解，不保证与原版逐帧一致** —— 所以阈值可以个体内比、
 *    可以跟同一套实现的别人比，**但别直接对上 UFOV 的常模**。
 *
 * 双阶梯的作用是防预测：两条独立阶梯随机交错，被试猜不出下一次会更难还是更易。
 */
/**
 * 阶梯的起始步长。**提到模块级并导出，是为了让演示能用同一个数** ——
 * 演示里星舰闪多久，被试会直接带进正式关卡当成"它就该这么快"的预期，
 * 而正式关卡第一试次用的正是这个值。演示里另抄一个数 = 教了个错的时间感
 * （见 `.claude/rules/演示-必须用关卡真常量.md`）。
 */
export const UFOV_START_STEPS = 20;

export class UfovStaircase {
  constructor({
    // ⚠️ **训练参数，凭经验拍的，未经标定**（同项目里其它难度参数，见 CLAUDE.md）。
    // 20 步 ≈ 333ms：从**明显看得见**的一端进，两个理由 ——
    // ① 心理物理学惯例：起点要让被试先理解任务，而不是先体验失败；
    // ② 起始值低于真阈值时前期会连错，实测代价是正确率被压到 **70.0%**（真阈值 16 步、
    //    起始 12 步、60 试次），且阈值低估 −0.54 步。老人连错最伤依从性（见关卡 rule）。
    // 代价是真阈值很低的人要多花几个试次往下走 —— 那一侧是"一路答对"，不伤人。
    startSteps = UFOV_START_STEPS,
    minSteps = 1,      // 16.67ms
    maxSteps = 30,     // 500ms
    coarse = 3,        // 首错之前的粗调步长（帧→步同值：3）
    fine = 1,          // 首错之后的细调步长
    upWeight = 3,      // 答错时向上走几个单位（3:1 → 收敛 75%）
    tracks = 2,        // 双阶梯
    rand = Math.random,
  } = {}) {
    Object.assign(this, { minSteps, maxSteps, coarse, fine, upWeight, rand });
    this.tracks = Array.from({ length: tracks }, () => ({
      value: startSteps,
      unit: coarse,
      erred: false,      // 这条阶梯错过没有 —— 决定用 coarse 还是 fine
      lastDir: 0,
      reversals: [],     // 记的是反转【发生时的值】，不是次数
    }));
    this.trials = 0;
    this.current = null;
  }

  /** 随机挑一条阶梯，返回本试次要用的呈现步数。 */
  next() {
    const i = Math.floor(this.rand() * this.tracks.length) % this.tracks.length;
    this.current = i;
    return { track: i, steps: this.tracks[i].value };
  }

  /** 记账一次作答。`track` 必须是 next() 给的那条，别自己传。 */
  record(track, correct) {
    const t = this.tracks[track];
    if (!t) return null;
    this.trials++;
    // 答对 → 变难（缩短）；答错 → 变易（延长）。
    // ☠️ **加权只在细调阶段生效**：粗调时 unit 已经是 3，再 ×3 就是一次 9 步的大跳，
    // 会把值甩到远高于真阈值的地方，而细调只能 1 步 1 步挪回来 —— 60 试次内走不完，
    // 阶梯于是长期停在过易的一侧。实测代价：真阈值 4 步时正确率被拉到 **83.3%**（应为 75%）、
    // 阈值高估 +1.26 步；真阈值越低越严重（16 步时反而正常，因为够远、走得回来）。
    // 收敛点由细调阶段决定，所以粗调对称不影响 75% 这个目标。
    const dir = correct ? -1 : +1;
    const delta = (correct ? 1 : (t.erred ? this.upWeight : 1)) * t.unit;
    const next = Math.max(this.minSteps, Math.min(this.maxSteps, t.value + dir * delta));

    // ☠️ 步长缩减发生在【首次答错】，而不是首次反转 —— 这是手册明写的规则。
    // 写成"首次反转"会让粗调阶段多跑几个试次，阈值不受影响但收敛更慢。
    if (!correct && !t.erred) { t.erred = true; t.unit = this.fine; }

    // 反转：方向变了就记下【转折点的值】。撞到上下限不算反转（那是天花板不是转折）。
    if (t.lastDir !== 0 && dir !== t.lastDir && next !== t.value) t.reversals.push(t.value);
    if (next !== t.value) t.lastDir = dir;
    t.value = next;
    return t.value;
  }

  /**
   * ⚠️ **别拿整场正确率去判断阶梯有没有收敛。** 阶梯从固定起点出发，前期必然有一段
   * 暂态（起点高于真阈值就一路答对），它会把整场正确率抬到 75% 以上：模拟实测
   * 真阈值 4 步时整场 **80.0%** 而稳态只有 76.7%，阈值本身准（偏差 +0.70 步）。
   * 报告上若要写正确率，得说清是整场还是稳态，否则读者会以为"没收敛"或"太简单"。
   *
   * 阈值 = 各阶梯「后 N 个反转点」的均值，再跨阶梯平均。
   * 丢弃前 `drop` 个反转是标准做法：那几个还在粗调、离真值远。
   * 反转不够时返回 `ok:false` **而不是编一个数** —— 同 ex-Gaussian 那条纪律。
   */
  threshold({ drop = 2, need = 4 } = {}) {
    const per = [];
    for (const t of this.tracks) {
      const use = t.reversals.slice(drop);
      if (use.length >= need) per.push(use.reduce((a, b) => a + b, 0) / use.length);
    }
    if (!per.length) {
      return { ok: false, reason: `反转点不足（各阶梯需 ${drop}+${need} 个）`, steps: null };
    }
    const steps = per.reduce((a, b) => a + b, 0) / per.length;
    return { ok: true, steps, perTrack: per, tracksUsed: per.length };
  }

  /** 调试/导出用的快照。 */
  snapshot() {
    return {
      trials: this.trials,
      tracks: this.tracks.map((t) => ({
        value: t.value, unit: t.unit, erred: t.erred, reversals: t.reversals.slice(),
      })),
    };
  }
}
