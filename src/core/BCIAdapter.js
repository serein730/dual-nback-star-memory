/**
 * 脑电（BCI）接入抽象层 —— 本 Demo 的核心可行性验证点之一。
 *
 * 目标：让"游戏逻辑"完全不知道数据来自模拟器还是真实头环。所有数据源实现同一个接口：
 *
 *     connect() -> Promise<void>
 *     update(dt, context) -> void        // 模拟源用它推进内部状态，真实源可空实现
 *     read() -> { attention, relaxation, quality, connected }
 *
 * 现在跑的是 MockEEGSource；未来接 Muse / BrainLink / OpenBCI 时，
 * 只需要实现一个新的 Source 并 adapter.use(new XxxSource())，游戏侧零改动。
 *
 * 注意力指数在游戏里的三处用法（神经反馈闭环的最小可用形态）：
 *   1. 视觉：场景极光强度、护盾环大小随专注度呼吸；
 *   2. 数值：得分倍率 1.0x ~ 1.5x；
 *   3. 报告：专注度曲线与行为指标并排，用于观察"主观专注"与"客观表现"是否同步。
 */

export class BCISource {
  constructor() {
    this.label = '未知设备';
    this.status = 'idle'; // idle | connecting | streaming | error
    this.note = '';       // 一句话运行状态，跟在 label 后面显示给用户（真实设备才用得上）
    this._state = { attention: 50, relaxation: 50, quality: 0, connected: false };
  }
  async connect() { this.status = 'streaming'; this._state.connected = true; }
  disconnect() { this.status = 'idle'; this._state.connected = false; }
  update(/* dt, ctx */) {}
  read() { return this._state; }
}

/**
 * 模拟脑电源。不是简单随机数 —— 刻意复现了真实注意力信号的几个特征，
 * 否则可视化出来一眼假，也没法验证下游的平滑/阈值逻辑是否可用：
 *   - Ornstein-Uhlenbeck 过程：围绕基线的有惯性游走（真实 EEG 指数不会瞬跳）；
 *   - 表现耦合：连续命中会抬高基线，连续失误会压低（行为与脑电正相关）；
 *   - 走神事件：随机出现 3~7 秒的低谷，用来测试"注意力掉线"时的游戏反馈；
 *   - 信号质量：开局 2 秒内爬升，模拟电极接触建立过程。
 */
export class MockEEGSource extends BCISource {
  constructor(seed = 7) {
    super();
    this.label = '模拟脑电源 (Mock EEG)';
    this.baseline = 58;
    this.value = 55;
    this.relax = 50;
    this.t = 0;
    this.driftPhase = seed;
    this.lapse = { active: false, until: 0, next: 8 + Math.random() * 10 };
  }

  async connect() {
    this.status = 'connecting';
    await new Promise((r) => setTimeout(r, 350));
    this.status = 'streaming';
    this._state.connected = true;
  }

  update(dt, ctx = {}) {
    if (this.status !== 'streaming') return;
    this.t += dt;

    // 电极接触质量爬升
    this._state.quality = Math.min(1, this.t / 2.2);

    // 行为表现把基线往上/下拉（-10 ~ +14）
    const perf = typeof ctx.recentAccuracy === 'number' ? ctx.recentAccuracy : 0.7;
    const streakBoost = Math.min(14, (ctx.streak || 0) * 1.6);
    const target = 44 + perf * 26 + streakBoost * 0.5;

    // 走神事件
    if (!this.lapse.active && this.t > this.lapse.next) {
      this.lapse.active = true;
      this.lapse.until = this.t + 3 + Math.random() * 4;
    }
    if (this.lapse.active && this.t > this.lapse.until) {
      this.lapse.active = false;
      this.lapse.next = this.t + 12 + Math.random() * 16;
    }
    const lapsePull = this.lapse.active ? -26 : 0;

    // OU 过程 + 慢漂移 + 高频抖动
    const theta = 0.9;            // 回归速度
    const sigma = 9;              // 噪声强度
    const drift = Math.sin(this.t * 0.23 + this.driftPhase) * 4;
    const noise = (Math.random() * 2 - 1) * sigma * Math.sqrt(dt);
    this.value += theta * (target + drift + lapsePull - this.value) * dt + noise;
    this.value = Math.max(2, Math.min(98, this.value));

    // 放松度与注意力弱负相关
    this.relax += (Math.max(10, 100 - this.value * 0.75) - this.relax) * 0.6 * dt
      + (Math.random() * 2 - 1) * 2 * Math.sqrt(dt);
    this.relax = Math.max(2, Math.min(98, this.relax));

    this._state.attention = this.value;
    this._state.relaxation = this.relax;
  }
}

/**
 * WebSocket 数据源（预留）。约定桥接程序把设备 SDK 的数据以 JSON 帧推过来：
 *   { "attention": 0-100, "relaxation": 0-100, "quality": 0-1 }
 * 这是目前接 NeuroSky / BrainLink / OpenBCI 最省事的一条路 —— 设备 SDK 跑在本机的
 * Python/Node 桥接进程里，浏览器只负责消费，绕开了浏览器端蓝牙协议栈的所有坑。
 */
export class WebSocketEEGSource extends BCISource {
  constructor(url = 'ws://127.0.0.1:9000') {
    super();
    this.url = url;
    this.label = `WebSocket 桥接 (${url})`;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.status = 'connecting';
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { this.status = 'error'; return reject(e); }
      this.ws = ws;
      const timer = setTimeout(() => { this.status = 'error'; reject(new Error('连接超时')); }, 4000);
      ws.onopen = () => { clearTimeout(timer); this.status = 'streaming'; this._state.connected = true; resolve(); };
      ws.onerror = (e) => { clearTimeout(timer); this.status = 'error'; reject(e); };
      ws.onclose = () => { this.status = 'idle'; this._state.connected = false; };
      ws.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (typeof d.attention === 'number') this._state.attention = d.attention;
          if (typeof d.relaxation === 'number') this._state.relaxation = d.relaxation;
          if (typeof d.quality === 'number') this._state.quality = d.quality;
        } catch { /* 忽略坏帧 */ }
      };
    });
  }

  disconnect() { this.ws?.close(); super.disconnect(); }
}

/**
 * DreamLab Mini 数据源 —— 手头这台真实设备的接入。
 *
 * ┌─ 数据是怎么走到这里的 ────────────────────────────────────────────────┐
 * │  头环 ~~无线~~> USB 接收器 > EEGCollector.exe（本机 :8000，每 0.5s 出一份指标）│
 * │        > serve.mjs 的 /bci/metrics（同源代理 + 字段裁剪）> 这个类          │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 为什么不像 WebSocketEEGSource 那样直连本机端口：页面是从公网反代打开的
 * （https://bcivr.avena.lol），浏览器里的 127.0.0.1 指的是头显自己，而且 https
 * 页面不允许连明文 ws://。同源的 /bci/metrics 是唯一能同时满足两端的路径。
 *
 * ⚠️ 这台设备只有一组差分导联（前额 + / 枕部 −，乳突参考），不是多通道脑电帽。
 * 下面算出来的"注意力指数"是**该被试相对于自己近几十秒水平**的投入度排名，
 * 不是绝对值、更不是任何临床指标——换个人、换次戴法，绝对数就不可比。
 * 它在这个 Demo 里的作用和 MockEEGSource 完全一样：驱动画面、驱动倍率、进曲线。
 */
export class DreamLabSource extends BCISource {
  /**
   * @param {object} opts
   *   url       同源端点，默认 /bci/metrics
   *   hz        轮询频率。上游 0.5s 才更新一次，2Hz 已经够，再高只是空转
   *   token     serve.mjs 启用 EEG_TOKEN 时要带的口令；默认从页面 URL 的 ?k= 取
   */
  constructor({ url = '/bci/metrics', hz = 2, token = null } = {}) {
    super();
    this.label = 'DreamLab Mini';
    this.url = url;
    this.periodMs = 1000 / hz;
    this.token = token ?? new URLSearchParams(location.search).get('k');
    this.timer = null;
    this.last = null;        // 最近一帧裁剪后的上游数据
    this.failures = 0;
    this.note = '';          // 给菜单栏看的一句话状态
    // 个体内标定器：ln(EI) 的指数加权均值/方差。EEG 绝对功率的个体差异是数量级的，
    // 不做个体内标定就只能得到"这个人今天电极贴得紧不紧"，得不到"他此刻投不投入"。
    this._cal = { mean: 0, var: 1, n: 0 };
    this._tbr = null;        // theta/beta ratio，只进报告不驱动画面
  }

  async connect() {
    this.status = 'connecting';
    const first = await this._poll();
    // 采集没点「开始」时上游会 503。这不算连接失败——设备链路是通的，
    // 只是还没出数据。保持 streaming 并自愈，比让用户反复点切换要好。
    this.status = 'streaming';
    this._state.connected = true;
    this.timer = setInterval(() => { this._poll(); }, this.periodMs);
    return first;
  }

  disconnect() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    super.disconnect();
  }

  async _poll() {
    let data;
    try {
      const u = this.token ? `${this.url}?k=${encodeURIComponent(this.token)}` : this.url;
      const res = await fetch(u, { cache: 'no-store' });
      data = await res.json();
    } catch (e) {
      this.failures += 1;
      this.note = '连不上本机脑电通道';
      this._degrade();
      return null;
    }

    if (!data || data.ok !== true) {
      this.failures += 1;
      this.note = data?.error || '采集程序未就绪';
      this._degrade();
      return data;
    }
    if (!data.live) {
      this.note = `采集已停（数据 ${(data.ageMs / 1000).toFixed(0)}s 前）`;
      this._degrade();
      return data;
    }

    this.failures = 0;
    this.last = data;
    this._ingest(data);
    return data;
  }

  /** 数据不可信时：质量清零，注意力向中位缓慢回落，绝不让它停在一个漂亮的数字上骗人。 */
  _degrade() {
    this._state.quality = 0;
    this._state.attention += (50 - this._state.attention) * 0.08;
    this._state.relaxation += (50 - this._state.relaxation) * 0.08;
  }

  _ingest(d) {
    const b = d.band || {};
    const quality = this._quality(d, b);
    this._state.quality = quality;
    this.note = quality > 0.6 ? '信号良好' : quality > 0.3 ? '信号一般' : '信号差，检查电极';

    const theta = b.theta, alpha = b.alpha, beta = b.beta;
    if (!(theta > 0) || !(alpha > 0) || !(beta > 0)) { this._degrade(); return; }

    this._tbr = theta / beta;

    // 质量门控：脏数据不许驱动指数。坑在于肌电/工频污染会把 beta 抬得极高，
    // 咬一下牙就是"满格专注"——那比没有数据更糟，因为它看起来是真的。
    if (quality < 0.35) { this._degrade(); return; }

    // Engagement Index，Pope et al. 1995（NASA 任务投入度指标）
    const ei = beta / (alpha + theta);
    const z = Math.log(ei);

    // 指数加权均值/方差，时间常数约 60s（2Hz 下 α≈1/120）
    const c = this._cal;
    const w = 1 / 120;
    if (c.n === 0) { c.mean = z; c.var = 0.25; }
    else {
      const d0 = z - c.mean;
      c.mean += w * d0;
      c.var += w * (d0 * d0 - c.var);
    }
    c.n += 1;

    // σ 给下限：信号非常平稳时方差会收缩到接近 0，再拿它做分母就是把测量噪声
    // 放大成满量程抖动——画面会疯狂闪，看着像"注意力剧烈波动"，其实什么都没发生。
    // 0.15 是 ln(EI) 尺度上大约 ±16% 的相对变化，比这更小的起伏当噪声处理。
    const sd = Math.max(Math.sqrt(Math.max(c.var, 1e-6)), 0.15);
    const dev = Math.max(-2.5, Math.min(2.5, (z - c.mean) / sd));
    // 冷启动：标定不足 30 帧（15 秒）时按比例压向 50，不假装已经知道这个人的基线
    const warm = Math.min(1, c.n / 30);
    this._state.attention = 50 + warm * 20 * dev;

    // 放松度走 alpha 占比（闭眼放松时 alpha 上升是脑电里最稳的现象之一）
    const total = alpha + beta + theta;
    this._state.relaxation = Math.max(2, Math.min(98, (alpha / total) * 180));
  }

  /** 把上游的质量判据 + 工频污染合成 0~1。 */
  _quality(d, b) {
    let q = d.qualityStatus === 'GOOD' ? 0.9 : d.qualityStatus === 'CHECK' ? 0.6 : 0.25;
    if (d.contaminated) q = Math.min(q, 0.25);
    // 50Hz 工频：这台设备实测能出现工频功率是 beta 的上万倍的情况，
    // 那种数据算出来的任何频带比值都没有意义，必须能被识别成"不可用"而不是"偏低"。
    const sig = (b.delta || 0) + (b.theta || 0) + (b.alpha || 0) + (b.beta || 0) + (b.gamma || 0);
    if (sig > 0 && b.mains50 > 0) {
      const ratio = b.mains50 / (sig + b.mains50);
      if (ratio > 0.8) q = Math.min(q, 0.1);
      else if (ratio > 0.5) q *= 0.5;
    }
    return q;
  }

  /** 给报告用的原始指标（不驱动画面，只做记录）。 */
  get detail() {
    return {
      device: 'DreamLab Mini',
      thetaBetaRatio: this._tbr,
      alphaBetaRatio: this.last?.alphaBetaRatio ?? null,
      qualityStatus: this.last?.qualityStatus ?? null,
      calibrationFrames: this._cal.n,
      note: this.note,
    };
  }
}

/**
 * Web Bluetooth 数据源（预留骨架）。
 * 真机接入时需要填三个常量：设备名前缀、Service UUID、Characteristic UUID，
 * 并在 _decode 里按厂商协议解析。注意 Web Bluetooth 必须在 HTTPS/localhost 下、
 * 且由用户手势触发；Pico / Quest 的浏览器对它的支持都不稳定，头显场景走本机桥接更现实
 * （手头这台 DreamLab Mini 就是走 DreamLabSource 那条 HTTP 路，见上）。
 */
export class BluetoothEEGSource extends BCISource {
  constructor({ namePrefix = 'BrainLink', service = 0xfff0, characteristic = 0xfff1 } = {}) {
    super();
    Object.assign(this, { namePrefix, service, characteristic });
    this.label = `蓝牙设备 (${namePrefix})`;
  }

  static get available() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

  async connect() {
    if (!BluetoothEEGSource.available) throw new Error('当前浏览器不支持 Web Bluetooth');
    this.status = 'connecting';
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: this.namePrefix }],
      optionalServices: [this.service],
    });
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(this.service);
    const ch = await svc.getCharacteristic(this.characteristic);
    await ch.startNotifications();
    ch.addEventListener('characteristicvaluechanged', (e) => this._decode(e.target.value));
    this.device = device;
    this.status = 'streaming';
    this._state.connected = true;
  }

  /** 按具体厂商的数据包格式实现；这里给出 NeuroSky ThinkGear 风格的占位解析。 */
  _decode(dataView) {
    if (dataView.byteLength < 2) return;
    this._state.attention = dataView.getUint8(0);
    this._state.relaxation = dataView.getUint8(1);
    this._state.quality = 1;
  }

  disconnect() { try { this.device?.gatt?.disconnect(); } catch {} super.disconnect(); }
}

/** 对游戏侧暴露的唯一入口：平滑后的注意力指数 + 状态。 */
export class BCIAdapter {
  constructor(source = new MockEEGSource()) {
    this.source = source;
    this.smoothed = 50;
    this.enabled = true;
    this.listeners = new Set();
    this._lowSince = null;
  }

  async use(source) {
    try { this.source?.disconnect(); } catch {}
    this.source = source;
    await source.connect();
    return source;
  }

  connect() { return this.source.connect(); }

  update(dt, ctx) {
    if (!this.enabled) return;
    this.source.update(dt, ctx);
    const s = this.source.read();
    // 视觉用的平滑值：0.35s 时间常数，避免画面抖动
    this.smoothed += (s.attention - this.smoothed) * Math.min(1, dt / 0.35);

    // "持续走神"事件：低于 35 连续 2.5 秒就通知游戏侧（用来触发温和的召回提示）
    const now = performance.now();
    if (this.smoothed < 35) {
      if (this._lowSince === null) this._lowSince = now;
      else if (now - this._lowSince > 2500) {
        this._lowSince = now + 6000; // 冷却，避免刷屏
        this.listeners.forEach((fn) => fn({ type: 'attention-lapse', value: this.smoothed }));
      }
    } else this._lowSince = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  get attention() { return this.smoothed; }
  get quality() { return this.source.read().quality; }
  get connected() { return this.source.read().connected; }
  get label() { return this.source.label; }

  /** 菜单栏显示用：设备名 + 一句话状态（真实设备会写"信号差，检查电极"这类）。 */
  get statusText() {
    const n = this.source.note;
    return n ? `${this.source.label} · ${n}` : this.source.label;
  }

  /**
   * 专注度换算的得分倍率：1.0x ~ 1.5x。
   *
   * 信号质量差时钳回 1.0 —— 接真机后这条是必需的：电极松脱/咬牙时 beta 会爆表，
   * 不钳的话孩子会因为"乱动"拿到高倍率，等于教他用肌电刷分，训练目标直接反了。
   * Mock 源开局 2 秒内质量从 0 爬升，也会短暂落在 1.0，无害。
   */
  get scoreMultiplier() {
    if (this.quality < 0.35) return 1;
    return 1 + Math.max(0, (this.smoothed - 45) / 55) * 0.5;
  }
}
