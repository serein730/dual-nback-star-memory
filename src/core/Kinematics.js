/**
 * 头部运动学采集 —— ADHD 三大核心症状里我们此前唯一没测的那一维：**多动**。
 *
 * 为什么值得做：QbTest 就是「CPT + 红外头动追踪」，它是目前唯一被 NICE（DG60）
 * 推荐进 6–17 岁 ADHD 诊断流程的数字工具，而它的活动通道只有一个贴在额头的
 * 反光点。VR 头显每帧免费产出 6DoF 头部位姿 —— 同一条信号，我们零硬件成本就有。
 * 另有研究报告，VR 里的头部总位移单独就能解释多动评分约四成的方差。
 *
 * 变量对齐 QbTest 的 QbActivity 四项（micro-events / distance / area / time active）。
 * ⚠️ **阈值是我们自己定的**：QbTest 的具体判据不公开，所以这里的数值只能个体内比较，
 * 跟 QbTest 的分数没有任何换算关系。阈值都写成了常量并标了单位，改了要记进执行日志。
 *
 * ☠️ **桌面端采不到真实头动。** `Game._frame()` 每帧把相机按回 (0,1.6,0)，
 * 只有鼠标视差在改姿态 —— 位移恒为 0、转动是鼠标不是头。所以桌面端一律
 * `valid:false`，导出里那些 0 **不是"这孩子很安静"，是"没有测"**。
 * 这两件事在报告上长得一模一样，是这个模块最容易被误读的地方。
 */

/** 采样率。8 分钟 × 20Hz ≈ 9600 点，够算统计量又不至于把导出 JSON 撑爆。 */
const HZ = 20;
/** 速度超过这个值（m/s）算"在动"。约等于头部每秒挪 5cm。 */
const MOVE_MPS = 0.05;
/** 相邻采样位移超过这个值（m）记一次微动事件。20Hz 下 5mm ≈ 0.1 m/s。 */
const MICRO_M = 0.005;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export class Kinematics {
  constructor() { this.reset(); }

  reset() {
    this.valid = false;
    this.source = 'none';
    this.samples = [];        // { t, x, y, z, yaw, pitch }
    this.segments = [];       // { label, from, to }
    this._acc = 0;
    this._t = 0;
    this._label = null;
    this._segStart = 0;
  }

  /** @param {'xr'|'desktop'} source 桌面端会被标成无效，见文件头 */
  start(source) {
    this.reset();
    this.source = source;
    this.valid = source === 'xr';
    this._label = 'block-0';
    this._segStart = 0;
  }

  /** 关掉当前段、开一个新段。段边界由关卡在换段时调。 */
  segment(label) {
    if (this._label !== null) {
      this.segments.push({ label: this._label, from: this._segStart, to: this._t });
    }
    this._label = label;
    this._segStart = this._t;
  }

  stop() {
    if (this._label !== null) {
      this.segments.push({ label: this._label, from: this._segStart, to: this._t });
      this._label = null;
    }
  }

  /**
   * 每帧调，内部按 HZ 抽稀。
   *
   * 直接读 `matrixWorld` 的元素而不是 `camera.position` / `getWorldPosition()`：
   * ① XR 下相机挂在玩家 rig 底下，`position` 是局部量；② 每次采样都 new 一个
   * Vector3 的话，8 分钟就是近万次分配（`FX` 那条运行期零 GC 的规矩同样适用）。
   * 姿态也从矩阵取：第三列是相机的局部 +Z 轴，相机看向 −Z，所以前向 = −(e8,e9,e10)。
   *
   * @param {THREE.Camera} camera XR 下由头显姿态驱动；桌面下是固定机位（数据无效）
   */
  sample(camera, dt) {
    this._t += dt;
    this._acc += dt;
    if (this._acc < 1 / HZ) return;
    this._acc = 0;
    const e = camera.matrixWorld.elements;
    const fx = -e[8], fy = -e[9], fz = -e[10];
    this.samples.push({
      t: this._t,
      x: e[12], y: e[13], z: e[14],
      yaw: Math.atan2(fx, fz),
      pitch: Math.asin(Math.max(-1, Math.min(1, fy))),
    });
  }

  /** 一段采样的统计量。`from`/`to` 是秒。 */
  _stats(from = 0, to = Infinity) {
    const seg = this.samples.filter((s) => s.t >= from && s.t < to);
    const out = {
      seconds: 0, samples: seg.length,
      distance: 0, microEvents: 0, timeActive: 0, activeRatio: 0,
      area: 0, headTurnDeg: 0, meanSpeed: 0,
    };
    if (seg.length < 2) return out;

    out.seconds = seg[seg.length - 1].t - seg[0].t;
    const speeds = [];
    let activeSamples = 0;
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1], b = seg[i];
      const dt = b.t - a.t;
      if (dt <= 0) continue;
      const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      out.distance += d;
      if (d > MICRO_M) out.microEvents++;
      const v = d / dt;
      speeds.push(v);
      if (v > MOVE_MPS) { activeSamples++; out.timeActive += dt; }
      // 转动量走偏航+俯仰的合成角。跨 ±π 的绕回会造出一个假的大跳，夹掉。
      let dy = b.yaw - a.yaw;
      if (dy > Math.PI) dy -= 2 * Math.PI; else if (dy < -Math.PI) dy += 2 * Math.PI;
      out.headTurnDeg += Math.hypot(dy, b.pitch - a.pitch) * 180 / Math.PI;
    }
    out.meanSpeed = mean(speeds);
    out.activeRatio = seg.length > 1 ? activeSamples / (seg.length - 1) : 0;

    // 活动范围：水平面上去均值后的 95% 标准差椭圆面积 π·(2σx)·(2σz)。
    // 用椭圆而不是外接矩形 —— 矩形会被一次转身的极值整个撑开，
    // 而我们要的是"平时在多大范围里晃"，不是"最远到过哪"。
    const mx = mean(seg.map((s) => s.x)), mz = mean(seg.map((s) => s.z));
    const sx = Math.sqrt(mean(seg.map((s) => (s.x - mx) ** 2)));
    const sz = Math.sqrt(mean(seg.map((s) => (s.z - mz) ** 2)));
    out.area = Math.PI * (2 * sx) * (2 * sz);
    return out;
  }

  /**
   * 导出用。原始轨迹降到 2Hz 才进 JSON —— 20Hz 的 9600 个点对报告没有额外信息，
   * 但会让导出文件大一个量级。
   */
  report() {
    this.stop();
    const step = Math.max(1, Math.round(HZ / 2));
    const trace = [];
    for (let i = 0; i < this.samples.length; i += step) {
      const s = this.samples[i];
      trace.push([+s.t.toFixed(2), +s.x.toFixed(4), +s.y.toFixed(4), +s.z.toFixed(4)]);
    }
    return {
      valid: this.valid,
      source: this.source,
      // 这句话是给读 JSON 的人看的，不是给程序看的。见文件头那条 ☠️
      note: this.valid ? null
        : '桌面端相机固定，头动数据无效；下面的 0 表示未测量，不代表被试没有动。',
      hz: HZ,
      thresholds: { moveMps: MOVE_MPS, microM: MICRO_M },
      overall: this._stats(),
      segments: this.segments.map((s) => ({ label: s.label, ...this._stats(s.from, s.to) })),
      trace,
    };
  }
}
