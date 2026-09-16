import * as THREE from 'three';
import { Panel, UIKit, COLORS, ICON_COLORS, FONT } from './Panel.js';

/**
 * 具体界面：主菜单 / 关卡说明 / 战斗 HUD / 单关结算 / 测评报告 / 脑电设置 / 吉祥物气泡。
 * 全部继承 Panel，所以在电脑和 VR 头显里长得一模一样、点法也一模一样。
 */

// HUD 活动件的颜色暂存。模块级复用，因为 _updateLive() 每帧都跑 ——
// 在那里 new Color 就是 20 分钟几万次分配（跟 FX / Kinematics 同一条规矩）。
const _cA = new THREE.Color();
const _cB = new THREE.Color();
const _WHITE = new THREE.Color(0xffffff);

/* ------------------------------ 静息引导页 ------------------------------ */

/**
 * 静息环节的文字层，套在呼吸环外面。
 *
 * 刻意做成无背景板：这一页的主角是那个会呼吸的光环，加一块深色底会把它压死。
 * 版面按环的尺寸留空 —— 环最大时外缘落在画布 y≈145~910 之间，
 * 标题、计数点、大字、提示语全部避开这条带，不会和环叠在一起。
 *
 * 另一件要紧的事：这块画布每帧都被读，但只在"阶段变了"的时候才重画。
 * 呼吸进度是靠 3D 环上的弧走的，不靠这里的像素 —— 否则 1178×1054 的纹理
 * 每帧上传一次，光这一个面板就要吃掉几百 MB/s 的带宽。
 */
export class RestPanel extends Panel {
  constructor() {
    super({ width: 1.9, height: 1.7, res: 620, backing: false });
    this.state = {
      label: '准 备', hint: '', color: COLORS.cyan, cycle: -1, cycles: 3, done: 0,
    };
    this._sig = '';
    this.buttons = [{
      id: 'rest-skip', kind: 'ghost', label: '跳过静息', size: 24,
      x: this.w - 276, y: 34, w: 230, h: 74,
    }];
  }

  set(s) {
    const sig = `${s.label}|${s.hint}|${s.color}|${s.cycle}|${s.done}`;
    if (sig === this._sig) return;
    this._sig = sig;
    Object.assign(this.state, s);
    this.markDirty();
  }

  render() {
    const ctx = this.ctx, { w, h } = this;
    const s = this.state;
    ctx.clearRect(0, 0, w, h);

    UIKit.text(ctx, '静息准备', w / 2, 56, {
      size: 34, weight: 700, align: 'center', color: COLORS.ink,
    });
    UIKit.text(ctx, '正式开始前，先让身体安静下来', w / 2, 98, {
      size: 23, align: 'center', color: COLORS.inkDim,
    });

    const cy = h / 2;

    // 呼吸计数点：已完成填实、正在进行描边、还没到的最淡。
    // 三个点比"第 2 / 3 次"这种文字好读 —— 孩子扫一眼就知道还剩几口气。
    // 已完成的点固定用薄荷色，不跟着阶段变色：它是一个只增不减的计数，
    // 颜色一变就不像"攒下来的东西"了。
    const n = s.cycles;
    for (let i = 0; i < n; i++) {
      const x = w / 2 - ((n - 1) * 46) / 2 + i * 46;
      const y = cy - 150;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      if (i < s.done) {
        ctx.fillStyle = COLORS.mint;
        ctx.shadowColor = COLORS.mint; ctx.shadowBlur = 16;
        ctx.fill();
      } else if (i === s.cycle) {
        ctx.lineWidth = 4; ctx.strokeStyle = s.color;
        ctx.shadowColor = s.color; ctx.shadowBlur = 12;
        ctx.stroke();
      } else {
        ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(175,198,240,0.5)'; ctx.stroke();
      }
      ctx.restore();
    }

    UIKit.text(ctx, s.label, w / 2, cy + 4, {
      size: 100, weight: 800, align: 'center', color: COLORS.ink, glow: s.color,
    });
    UIKit.text(ctx, s.hint, w / 2, cy + 96, {
      size: 26, align: 'center', color: s.color,
    });

    // 画布底部这条带子刻意留空：那一段正好落在观星台边缘的高光环上，
    // 放任何文字都会被冲掉。"跟不上也没关系"这句改由吉祥物说。
    for (const b of this.buttons) UIKit.button(ctx, b, { hovered: this.hovered === b.id });
  }
}

/* ------------------------------- 主菜单 ------------------------------- */

export class MenuPanel extends Panel {
  constructor(games) {
    super({ width: 2.24, height: 1.4, res: 620 });
    this.games = games;
    this.progress = {};      // { gameId: stars }
    this._layout();
  }

  _layout() {
    const { w, h } = this;
    const cardW = (w - 200) / this.games.length;
    const cardY = 268;
    const cardH = 300;
    this.buttons = this.games.map((g, i) => ({
      id: `game:${g.id}`, kind: 'card', game: g,
      x: 100 + i * (cardW + 25), y: cardY, w: cardW - 25, h: cardH,
    }));
    // 底排四个键。**「儿童·测评」是唯一的 primary** —— 各档的数据可比性完全不同
    // （固定难度 / 自适应 / 阈值追踪），视觉重量必须把人往正确的那一档引；三个模块卡片仍然
    // 可以单点，但它们进的是体验档。
    //
    // ⚠️ **2026-08-12 去掉了「脑电设置」按钮与那条脑电状态条**（用户要求"更清爽"）。
    // 这不是把功能删了，是把它挪到了必经之路上：现在点底排任一开测键
    // 一律先进 `PreflightPanel`，被试与脑电在那里设。菜单上再放一份等于两个入口，
    // 而**旧状态条还会说反话** —— 它的颜色只看 `quality`，模拟源质量很高于是显示成
    // 薄荷绿（这套界面里绿＝一切正常），实际含义却是"这一场的脑电是假的"。
    /*
     * ☠️ **底排从三键变四键（2026-08-22，加老年训练档）。文案是被宽度逼短的，不是随手改的。**
     * `UIKit.button` 的 label 与 sub **都不传 maxWidth**，既不折行也不裁切 —— 写长了直接
     * 溢出按钮边缘，而且**不报错**。四键分掉的可用宽比三键时每键少三成，所以原来的
     * 「开始标准测评 / CPT + 延迟选择 · 约 10-12 分钟」装不下了。
     * **改宽度或加第五键之前，先用 `__game.menu.ctx.measureText()` 量一遍**（用面板自己的
     * 上下文，字体才一致）—— 本轮四条 label/sub 都实测过，**最紧的一条余量 91px**。
     *
     * 顺带把人群写进 label：现在一个菜单上并排站着两个人群，而它们的数据分存储根、
     * 报告口径、免责声明**没有一条是共用的**。不写清楚，施测者点错档不会有任何提示。
     */
    const gap = 18;
    const avail = w - 200 - gap * 3;
    const ws = [0.30, 0.26, 0.23, 0.21].map((f) => avail * f);
    const specs = [
      // 时长要报**整场**的（CPT 8:18 + 延迟选择 1~3.3 分），不是其中一关的。
      // 报少了，家长按 8 分钟安排孩子的耐受，到点了还没完
      { id: 'assess', kind: 'primary', label: '儿童 · 测评', sub: '约 10-12 分钟', size: 34 },
      // ⚠️ 时长同样报整场。**但现在的"整场"只有 UFOV 子测验 1 一个 block** ——
      // 决策存档定的剂量是 30 分钟一次，要靠子测验 2/3 或多个 block 补齐（都还没做）。
      // 别把 sub 写成"约 30 分钟"：那是疗程设计值，不是这个按钮现在真会跑的时长。
      { id: 'train', kind: 'ghost', label: '老年 · 训练', sub: 'UFOV · 约 5 分钟' },
      { id: 'start', kind: 'ghost', label: '三模块体验', sub: '自适应 · 约 4 分钟' },
      // sub 别再写"上一次结果"：它点开的是浏览器里的完整报告页（历次都在），
      // 而游戏进程里**只有当前这一场**的数据 —— 旧文案承诺了一件做不到的事
      { id: 'report', kind: 'ghost', label: '测评报告', sub: '历次·电脑端' },
    ];
    let x = 100;
    specs.forEach((sp, i) => {
      this.buttons.push({ ...sp, x, y: h - 232, w: ws[i], h: 108 });
      x += ws[i] + gap;
    });
  }

  setProgress(p) { this.progress = p; this.markDirty(); }

  render() {
    const ctx = this.ctx, { w, h } = this;
    UIKit.panelBg(ctx, w, h);

    UIKit.text(ctx, '星海专注营', w / 2, 96, {
      size: 76, weight: 800, align: 'center', color: COLORS.ink, glow: 'rgba(90,200,255,0.75)',
    });
    UIKit.text(ctx, '注意力表现测评 · 行为 + 脑电 + 头动多通道采集', w / 2, 168, {
      size: 27, align: 'center', color: COLORS.inkDim,
    });
    // ⚠️ 这一行会点名底排按钮，**改按钮文案就必须回来改它**（2026-08-22 踩过：
    // 底排从三键改四键后，这里还写着已经不存在的「开始标准测评」和"下面三个模块"）
    UIKit.text(ctx, '儿童走「儿童·测评」（固定难度）；老年走「老年·训练」；上方前三项为体验，最右是双模态星忆', w / 2, 216, {
      size: 22, align: 'center', color: 'rgba(140,160,205,0.75)',
    });

    for (const b of this.buttons) {
      if (b.kind === 'card') this._card(ctx, b, this.hovered === b.id);
      else UIKit.button(ctx, b, { hovered: this.hovered === b.id });
    }

    // ⚠️ 卡片底沿（cardY+cardH=568）与底排按钮顶沿（h-232=636）之间那 68px 现在是空的。
    // 原来那里是脑电状态条，2026-08-12 随「脑电设置」按钮一起去掉了（理由见 _layout）。
    // **别急着往这块空白里塞东西** —— 它现在的作用是把三张关卡卡片和底排操作分开。

    UIKit.text(ctx, '技术验证原型 · 非医疗器械 · 数据不构成任何诊断或治疗建议', w / 2, h - 62, {
      size: 20, align: 'center', color: 'rgba(120,138,180,0.8)',
    });
  }

  _card(ctx, b, hovered) {
    const g = b.game;
    ctx.save();
    UIKit.roundRect(ctx, b.x, b.y, b.w, b.h, 30);
    const grad = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    grad.addColorStop(0, hovered ? 'rgba(90,130,255,0.34)' : 'rgba(70,95,190,0.17)');
    grad.addColorStop(1, hovered ? 'rgba(40,60,150,0.3)' : 'rgba(30,40,95,0.14)');
    ctx.fillStyle = grad;
    if (hovered) { ctx.shadowColor = 'rgba(90,190,255,0.55)'; ctx.shadowBlur = 30; }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = hovered ? 'rgba(150,200,255,0.72)' : 'rgba(140,170,255,0.24)';
    ctx.stroke();
    ctx.restore();

    const cx = b.x + b.w / 2;
    this._emblem(ctx, g.id, cx, b.y + 78, 44, g.color);

    UIKit.text(ctx, g.name, cx, b.y + 158, {
      size: 36, weight: 700, align: 'center', color: COLORS.ink,
    });
    UIKit.text(ctx, g.skill, cx, b.y + 200, {
      size: 22, align: 'center', color: g.color,
    });
    UIKit.text(ctx, g.blurb, cx, b.y + 240, {
      size: 19, align: 'center', color: COLORS.inkDim,
      maxWidth: b.w - 36, lineHeight: 25,
    });

    // 星星压到卡片底边：blurb 万一折成两行也不会撞上
    const stars = this.progress[g.id] || 0;
    for (let i = 0; i < 3; i++) {
      UIKit.star(ctx, cx - 34 + i * 34, b.y + b.h - 26, 14, i < stars);
    }
  }

  /** 每关的图标，用画笔画出来，避免引入图标字体或图片资源。 */
  _emblem(ctx, id, cx, cy, r, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 20;
    if (id === 'catcher') {
      ctx.beginPath();
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 0.62, cy - r * 0.32);
      ctx.lineTo(cx + r * 0.62, cy + r * 0.42); ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r * 0.62, cy + r * 0.42); ctx.lineTo(cx - r * 0.62, cy - r * 0.32);
      ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - r * 0.62, cy - r * 0.32); ctx.lineTo(cx + r * 0.62, cy - r * 0.32);
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
      ctx.globalAlpha = 0.55; ctx.stroke();
    } else if (id === 'beam') {
      [1, 0.62, 0.28].forEach((k, i) => {
        ctx.globalAlpha = 1 - i * 0.22;
        ctx.beginPath(); ctx.arc(cx, cy, r * k, 0, Math.PI * 2); ctx.stroke();
      });
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.11, 0, Math.PI * 2); ctx.fill();
    } else if (id === 'echo') {
      const xs = [-1, -0.33, 0.33, 1];
      const hs = [0.55, 0.95, 0.72, 1.15];
      xs.forEach((x, i) => {
        ctx.globalAlpha = i === 1 || i === 3 ? 1 : 0.45;
        const px = cx + x * r * 0.72;
        ctx.beginPath();
        ctx.moveTo(px, cy + r * 0.7);
        ctx.lineTo(px, cy + r * 0.7 - r * hs[i]);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, cy + r * 0.7 - r * hs[i] - 6, 6, 0, Math.PI * 2);
        ctx.fill();
      });
    } else {
      // 双模态 N-back：上方是空间位置，下方两个圆分别代表视觉/听觉反应键。
      [[-0.72, 0.08], [0, -0.48], [0.72, 0.08]].forEach(([x, y], i) => {
        ctx.globalAlpha = i === 1 ? 1 : 0.52;
        ctx.beginPath(); ctx.arc(cx + x * r, cy + y * r, r * 0.14, 0, Math.PI * 2); ctx.fill();
      });
      ctx.globalAlpha = 0.88;
      ctx.beginPath(); ctx.arc(cx - r * .42, cy + r * .72, r * .16, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx + r * .42, cy + r * .72, r * .16, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
}

/* --------------------------- 开始前确认（Preflight） ---------------------------
 *
 * 每次点「开始标准测评」/「三模块体验」都会先经过这一页（2026-08-12 用户拍板：
 * **不做条件检测，一律硬弹**）。它要解决的是一类只在事后才暴露的错误：
 *
 *   · 忘了选被试 → 服务端回落到 `readCurrentSubject()`，于是这一场**静默挂到
 *     上一个孩子名下**（`serve.mjs` 那一行是刻意的：丢一场数据比记错人更难补救）。
 *     事后没有任何线索能发现，两个孩子连着测的话连时间戳都推不出来。
 *   · 没起采集 / 停在模拟源 → 跑满 10 分钟，拿回来一整场假脑电。
 *
 * 所以两件事都做在**必经之路**上，而不是靠菜单上的提示条（那条 2026-08-12 已删：
 * 它的颜色只看 quality，模拟源质量很高 → 显示成绿色，反而在说反话）。
 *
 * ⚠️ **年份用加减按钮而不是键盘输入**：铁律 6 要求桌面与 VR 同一套布局与判定，
 * 而头显里没有键盘。性别同理做成三个按钮。这也顺带避开了中文 IME 那一堆事。
 */

const PF_PER = 4;   // 被试列表一屏画几个，其余靠滚轮

export class PreflightPanel extends Panel {
  constructor() {
    super({ width: 2.24, height: 1.4, res: 620 });
    this.info = {
      subjects: [],        // [{ subject_id, display_code, birth_year, sex }]
      currentId: null,
      scroll: 0,           // 列表第一个可见项的下标（滚轮驱动，见 Game 的 wheel 监听）
      newYear: 2018,       // 默认 8 岁，正落在 6–12 岁设计年龄段的中间
      newSex: null,
      yearEditing: false,  // 年份正在用键盘改
      yearBuf: '',
      source: { label: '模拟脑电源', quality: 0, simulated: true, live: false, running: false, note: '' },
      busy: '',            // 非空时压住所有操作（启动采集要几十秒）
      modeLabel: '',
      /**
       * 当前采集流已经服务过谁（`null` = 还没人用过 / 模拟源 / 采集没跑）。
       *   blocked  这条流上一场是**别的孩子** —— 硬拦，见下方 render 的红字
       *   warn     同一个孩子重测，波形会混在一起 —— 只提示，仍可开始
       *   count    这条流上已经跑过几场
       */
      run: null,
    };
    this._sig = '';
    this._layout();
  }

  /** 被试列表是动态的，所以按钮每次都重建；固定按钮的 id 与坐标在这里定死。 */
  _layout() {
    const { w, h } = this;
    this.colL = { x: 64, w: 624 };
    this.colR = { x: 724, w: 601 };
    this.cardY = 156;
    this.cardH = 512;
    this._rebuild();
  }

  _rebuild() {
    const { w, h } = this;
    const L = this.colL, R = this.colR;
    const i = this.info;
    const busy = !!i.busy;
    const btns = [];

    // ---- 左栏：被试列表（最多 4 行，多的滚不下就靠 bci.html 选，这里只列最近建的）----
    // ⚠️ **列表项不能用 `sub`**：UIKit.button 把 sub 画在 `cy + 34`，按钮只有 54 高时
    // 那一行会掉到按钮外面去，压在下一项上（画布上不报错，只是看着脏）。
    // 年龄性别拼进 label 里，一行说完。
    //
    // 一屏只画 PER 个，其余靠滚轮翻（`info.scroll` 是第一个可见项的下标）。
    // ⚠️ **滚轮是桌面专属**（2026-08-12 用户明确"先不做 VR 里的"）：头显里没有滚轮，
    // 被试超过 4 个时在 VR 下就只能看到前 4 个。要补 VR 的话得加翻页按钮。
    const start = Math.max(0, Math.min(i.scroll, Math.max(0, i.subjects.length - PF_PER)));
    i.subjects.slice(start, start + PF_PER).forEach((s, k) => {
      btns.push({
        id: `pf-subj:${s.subject_id}`, kind: s.subject_id === i.currentId ? 'primary' : 'ghost',
        label: `${s.display_code}   ${subjLine(s)}`, size: 25, disabled: busy,
        x: L.x + 24, y: 286 + k * 62, w: L.w - 48, h: 54,
      });
    });

    // ---- 左栏：新建被试 ----
    // 横向预算（左栏内宽 624，两侧各留 24）：52 + 96 + 52 + 20 + 68 + 68 + 20 + 200 = 576
    // ⚠️ 列表最后一项的底沿在 286+3*62+54 = 526，这里必须留够间距：
    // 原来用 +16 时「出生年 / 性别」那行标签落在 528，与列表贴在一起（差 2px）
    const ny = 286 + PF_PER * 62 + 34;
    btns.push({ id: 'pf-year-', kind: 'ghost', label: '−', size: 30, disabled: busy, x: L.x + 24, y: ny, w: 52, h: 54 });
    // 年份本身也是按钮：点一下用键盘直接敲（桌面专属，同上）。± 两个键留着，
    // 因为改 1~2 岁时点一下比"点进去、退格四次、重敲"快得多
    btns.push({ id: 'pf-year', kind: 'ghost', label: '', size: 30, disabled: busy, x: L.x + 76, y: ny, w: 96, h: 54 });
    btns.push({ id: 'pf-year+', kind: 'ghost', label: '+', size: 30, disabled: busy, x: L.x + 172, y: ny, w: 52, h: 54 });
    btns.push({ id: 'pf-sex:F', kind: i.newSex === 'F' ? 'primary' : 'ghost', label: '女', size: 26, disabled: busy, x: L.x + 244, y: ny, w: 68, h: 54 });
    btns.push({ id: 'pf-sex:M', kind: i.newSex === 'M' ? 'primary' : 'ghost', label: '男', size: 26, disabled: busy, x: L.x + 312, y: ny, w: 68, h: 54 });
    btns.push({ id: 'pf-new', kind: 'ghost', label: '建号并选中', size: 24, disabled: busy, x: L.x + 400, y: ny, w: 200, h: 54 });

    // ---- 右栏：脑电 ----
    const by = this.cardY + this.cardH - 82;
    const bw3 = (R.w - 48 - 24) / 2;
    btns.push({
      id: 'pf-source', kind: 'ghost', label: '切换数据源', sub: '模拟 / 真机 / 桥接', size: 24,
      disabled: busy, x: R.x + 24, y: by, w: bw3, h: 66,
    });
    // 这条流已经服务过别人（或同一个孩子的上一场）时，「开始/停止采集」原地变成
    // 「重启采集」—— 不新增第四个按钮：换流本来就是"停了再起"，让人点两次
    // 反而会有人只点一次就走
    const needRestart = !!(i.run && (i.run.blocked || i.run.warn));
    btns.push({
      id: needRestart ? 'pf-restart' : 'pf-collect',
      kind: needRestart ? 'primary' : (i.source.running ? 'ghost' : 'primary'),
      label: needRestart ? '重启采集' : (i.source.running ? '停止采集' : '开始采集'),
      sub: needRestart ? '换一条干净的流' : '本机采集程序', size: 24,
      // 模拟源下没有采集程序可启停，禁用比"点了没反应"诚实
      disabled: busy || i.source.simulated, x: R.x + 24 + bw3 + 24, y: by, w: bw3, h: 66,
    });
    // 频带功率那一屏（BciPanel）唯一的入口 —— 菜单上的「脑电设置」按钮 2026-08-12
    // 删掉之后，不留这个口子它就成了没有入口的死代码
    btns.push({
      id: 'pf-bci', kind: 'ghost', label: '信号详情', size: 22,
      disabled: busy, x: R.x + R.w - 24 - 160, y: this.cardY + 16, w: 160, h: 46,
    });

    // ---- 底部 ----
    // ☠️ **被试是硬条件，脑电不是**：没设备的机器上永远拿不到真机源，硬拦会让
    //    VR 演示与无设备联调彻底做不了。所以模拟源只给红字警告、仍可开始 ——
    //    但那句警告必须一直在，且用的是"这一场不会有真实脑电"这种说人话的措辞。
    btns.push({ id: 'pf-back', kind: 'ghost', label: '返回', sub: 'Esc', size: 28, disabled: busy, x: 64, y: h - 132, w: 240, h: 96 });
    btns.push({
      id: 'pf-start', kind: 'primary', label: '开始测评', sub: i.modeLabel, size: 34,
      // ☠️ `run.blocked` 是**硬条件**，和"没选被试"同级：这条采集流上一场是别的
      // 孩子，继续用就是把两个人的脑电写进同一份样本文件。理由见 render 里的红字
      disabled: busy || !i.currentId || !!i.run?.blocked,
      x: w - 64 - 460, y: h - 132, w: 460, h: 96,
    });
    this.buttons = btns;
  }

  setInfo(info) {
    Object.assign(this.info, info);
    const i = this.info;
    const s = i.source;
    const sig = [
      i.currentId, i.newYear, i.newSex, i.busy, i.modeLabel, i.scroll, i.yearEditing, i.yearBuf,
      i.subjects.map((x) => `${x.subject_id}:${x.display_code}:${x.birth_year}:${x.sex}`).join(','),
      s.label, s.simulated, s.live, s.running, s.note, Math.round(s.quality * 20),
      // 采集流警告参与签名：漏了它，警告出现/消失时面板不会重画（坑#9）
      i.run ? `${i.run.blocked}:${i.run.warn}:${i.run.count}` : '-',
    ].join('|');
    if (sig === this._sig) return;
    this._sig = sig;
    this._rebuild();
    this.markDirty();
  }

  render() {
    const ctx = this.ctx, { w, h } = this;
    const i = this.info;
    const L = this.colL, R = this.colR;
    UIKit.panelBg(ctx, w, h);

    UIKit.text(ctx, '开始前确认', w / 2, 66, {
      size: 52, weight: 800, align: 'center', color: COLORS.ink, glow: 'rgba(90,200,255,0.7)',
    });
    UIKit.text(ctx, '这两件事只能在开始前设，事后补不回来', w / 2, 114, {
      size: 22, align: 'center', color: COLORS.inkDim,
    });

    /* ---------------- 左：被试 ---------------- */
    this._box(ctx, L.x, this.cardY, L.w, this.cardH, !!i.currentId);
    UIKit.text(ctx, '① 这一场是谁在做', L.x + 24, this.cardY + 40, { size: 24, color: COLORS.inkDim });

    const cur = i.subjects.find((s) => s.subject_id === i.currentId);
    if (cur) {
      UIKit.text(ctx, cur.display_code, L.x + 24, this.cardY + 100, {
        size: 46, weight: 800, color: COLORS.mint,
      });
      UIKit.text(ctx, subjLine(cur), L.x + 24 + 190, this.cardY + 106, { size: 24, color: COLORS.inkDim });
    } else {
      UIKit.text(ctx, '未选择', L.x + 24, this.cardY + 100, {
        size: 46, weight: 800, color: COLORS.coral,
      });
      UIKit.text(ctx, '不选就没法开始 —— 选错人比没选更糟', L.x + 24 + 170, this.cardY + 106, {
        size: 21, color: 'rgba(226,96,106,0.85)',
      });
    }

    if (!i.subjects.length) {
      UIKit.text(ctx, '这台机器上还没有被试，用下面一行建一个', L.x + 24, 300, {
        size: 22, color: COLORS.inkDim,
      });
    }

    // 滚动指示：只有装不下时才出现，否则是纯噪声
    const total = i.subjects.length;
    if (total > PF_PER) {
      const start = Math.max(0, Math.min(i.scroll, total - PF_PER));
      UIKit.text(ctx, `${start + 1}-${Math.min(start + PF_PER, total)} / ${total} · 滚轮翻`,
        L.x + L.w - 24, this.cardY + 40, { size: 19, align: 'right', color: COLORS.inkDim });
    }

    // 新建行的两个说明。年份夹在 [−] 与 [+] 之间那 96px 里，居中
    // ⚠️ 列表最后一项的底沿在 286+3*62+54 = 526，这里必须留够间距：
    // 原来用 +16 时「出生年 / 性别」那行标签落在 528，与列表贴在一起（差 2px）
    const ny = 286 + PF_PER * 62 + 34;
    const yearCx = L.x + 24 + 52 + 48;
    // 编辑中显示正在敲的那几位 + 一个光标，否则显示当前值
    const yearTxt = i.yearEditing ? `${i.yearBuf}|` : String(i.newYear);
    UIKit.text(ctx, yearTxt, yearCx, ny + 27, {
      size: 30, weight: 700, align: 'center', color: i.yearEditing ? COLORS.cyan : COLORS.ink,
    });
    UIKit.text(ctx, i.yearEditing ? '敲 4 位年份 · 回车确认'
      : `${new Date().getFullYear() - i.newYear} 岁`, yearCx, ny + 68, {
      size: 19, align: 'center', color: i.yearEditing ? COLORS.cyan : COLORS.inkDim,
    });
    UIKit.text(ctx, '出生年 / 性别 · 姓名一律不存', L.x + 24, ny - 22, { size: 20, color: COLORS.inkDim });

    /* ---------------- 右：脑电 ---------------- */
    const s = i.source;
    // 判据是**能不能采到真数据**，不是 quality —— 这正是旧状态条说反话的地方
    const ok = !s.simulated && s.live && s.quality > 0.35;
    this._box(ctx, R.x, this.cardY, R.w, this.cardH, ok);
    UIKit.text(ctx, '② 脑电从哪来', R.x + 24, this.cardY + 40, { size: 24, color: COLORS.inkDim });

    const srcColor = s.simulated ? COLORS.gold : ok ? COLORS.mint : COLORS.coral;
    UIKit.text(ctx, s.label, R.x + 24, this.cardY + 100, { size: 40, weight: 800, color: srcColor });

    if (s.simulated) {
      // ☠️ 这段话不许改软。模拟源看起来一切正常（质量高、指数在动），
      //    唯独数据是编的 —— 而报告页事后**看不出**这一场是模拟的还是真的。
      UIKit.text(ctx, '这一场不会有真实脑电数据', R.x + 24, this.cardY + 152, {
        size: 26, weight: 700, color: COLORS.gold,
      });
      UIKit.text(ctx, '行为数据照常记录，可以照常演示；要采脑电就先切到真机源、再点开始采集。',
        R.x + 24, this.cardY + 196, { size: 21, color: COLORS.inkDim, maxWidth: R.w - 48, lineHeight: 30 });
    } else {
      UIKit.text(ctx, s.note || (s.live ? '正在出数据' : '还没收到数据'), R.x + 24, this.cardY + 152, {
        size: 24, color: s.live ? COLORS.ink : COLORS.coral,
      });
      UIKit.text(ctx, '信号质量', R.x + 24, this.cardY + 214, { size: 21, color: COLORS.inkDim });
      const qc = s.quality > 0.6 ? COLORS.mint : s.quality > 0.35 ? COLORS.gold : COLORS.coral;
      UIKit.bar(ctx, R.x + 24, this.cardY + 236, R.w - 48, 18, s.quality, { color: qc });
      UIKit.text(ctx, s.quality > 0.6 ? '良好' : s.quality > 0.35 ? '一般 · 可以开始' : '差 · 先把电极贴稳',
        R.x + 24, this.cardY + 284, { size: 24, weight: 700, color: qc });
      /*
       * 采集流复用警告。中途退出**故意不停采集**（2026-08-19 用户拍板），所以同一条
       * 流可能被好几场共用 —— 这两句是那个决定唯一的现场提示。
       *
       * ☠️ 两级说的不是同一件事，写串了就是在报告上说假话：
       *   blocked（换人）＝ 两个孩子的脑电会写进同一份样本文件，这是**合规问题**，硬拦；
       *   warn（同人重测）＝ 只是段归属分不清，施测者知情就行，仍可开始。
       *
       * ⚠️ **纵向预算卡得很死**：按钮顶沿在 `cardY + 430`（by = cardY + cardH - 82），
       * 正文 lineHeight 26 起于 +364，两行落在 364/390 —— 再多一行就压到按钮上了
       * （2026-08-19 实跑截图抓到过一次：三行文案盖住了「重启采集」）。
       * 所以两条文案都必须在 **2 行 / 约 52 个汉字**以内（可用宽 553px，21px 字约 26 字/行）。
       * 改文案后要重新截图看，`measureText` 估不出折行后的总高度。
       */
      if (i.run?.blocked) {
        UIKit.text(ctx, '这条采集流上一场是别的孩子', R.x + 24, this.cardY + 330, {
          size: 23, weight: 700, color: COLORS.coral,
        });
        UIKit.text(ctx, '两个人的脑电会写进同一份波形。请先点「重启采集」。',
          R.x + 24, this.cardY + 364, { size: 21, color: 'rgba(226,96,106,0.9)', maxWidth: R.w - 48, lineHeight: 26 });
      } else if (i.run?.warn) {
        UIKit.text(ctx, `本场脑电会与前 ${i.run.count} 场记在同一份波形里`, R.x + 24, this.cardY + 330, {
          size: 23, weight: 700, color: COLORS.gold,
        });
        UIKit.text(ctx, '同一个孩子重测，不会串人，但事后分不清哪段是哪场。要分开就点「重启采集」。',
          R.x + 24, this.cardY + 364, { size: 21, color: COLORS.inkDim, maxWidth: R.w - 48, lineHeight: 26 });
      } else if (!s.running) {
        // 与上面两条互斥：采集流警告比"没起采集"更要紧，同时画两条就会重叠
        UIKit.text(ctx, '采集程序没在跑，点「开始采集」', R.x + 24, this.cardY + 330, {
          size: 21, color: 'rgba(226,96,106,0.9)',
        });
      }
    }

    /* ---------------- 忙碌覆盖 ---------------- */
    // 启动采集要几十秒，这期间必须有东西在动，否则人会以为点了没反应而反复点
    if (i.busy) {
      UIKit.text(ctx, i.busy, w / 2, h - 172, {
        size: 26, weight: 700, align: 'center', color: COLORS.cyan,
      });
    }

    for (const b of this.buttons) UIKit.button(ctx, b, { hovered: this.hovered === b.id });
  }

  /** 左右两栏的底板。`ok` 决定描边色 —— 一眼看出哪一栏还没弄好。 */
  _box(ctx, x, y, w, h, ok) {
    ctx.save();
    UIKit.roundRect(ctx, x, y, w, h, 26);
    ctx.fillStyle = 'rgba(18,28,66,0.5)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = ok ? 'rgba(70,214,166,0.55)' : 'rgba(226,96,106,0.5)';
    ctx.stroke();
    ctx.restore();
  }
}

/** 被试的一行说明。年龄口径与 bci.html / viz.html 一致：当前年 − 出生年。 */
function subjLine(s) {
  const bits = [];
  if (s.birth_year) bits.push(`${new Date().getFullYear() - s.birth_year} 岁`);
  if (s.sex === 'M') bits.push('男'); else if (s.sex === 'F') bits.push('女');
  return bits.join(' · ') || '未填年龄性别';
}

/* ----------------------------- 关卡说明页 ----------------------------- */

export class BriefPanel extends Panel {
  constructor() {
    super({ width: 1.9, height: 1.16, res: 660 });
    this.game = null;
    this.countdown = null;
    // 「再看演示」不是可有可无的便利键：这一页的三行玩法说明对**不认字的孩子**
    // 等于空白，他理解规则的唯一渠道就是刚才那段演示。旁边的大人要能随手再放一遍。
    this.buttons = [
      { id: 'go', kind: 'primary', label: '我准备好了', sub: '点击 / 扣扳机开始',
        x: 0, y: 0, w: 460, h: 112 },
      { id: 'demo', kind: 'ghost', label: '再看演示', x: 0, y: 0, w: 260, h: 112, size: 30 },
      { id: 'back', kind: 'ghost', label: '返回', x: 0, y: 0, w: 190, h: 112, size: 30 },
    ];
    this._place();
  }

  _place() {
    const { w, h } = this;
    const gap = 22;
    const total = this.buttons.reduce((a, b) => a + b.w, 0) + gap * (this.buttons.length - 1);
    let x = (w - total) / 2;
    for (const b of this.buttons) { b.x = x; b.y = h - 178; x += b.w + gap; }
  }

  setGame(g) { this.game = g; this.countdown = null; this.markDirty(); }
  setCountdown(n) { this.countdown = n; this.markDirty(); }

  render() {
    const ctx = this.ctx, { w, h } = this;
    UIKit.panelBg(ctx, w, h, { glow: this.game?.color || COLORS.cyan });
    if (!this.game) return;
    const g = this.game;

    if (this.countdown !== null) {
      UIKit.text(ctx, g.name, w / 2, 110, { size: 46, weight: 700, align: 'center', color: g.color });
      const label = this.countdown > 0 ? String(this.countdown) : '开始!';
      UIKit.text(ctx, label, w / 2, h / 2 + 20, {
        size: this.countdown > 0 ? 210 : 140, weight: 800, align: 'center',
        color: COLORS.ink, glow: g.color,
      });
      UIKit.text(ctx, '看准了再出手，稳比快更重要', w / 2, h - 96, {
        size: 26, align: 'center', color: COLORS.inkDim,
      });
      return;
    }

    UIKit.text(ctx, g.name, w / 2, 96, {
      size: 60, weight: 800, align: 'center', color: COLORS.ink, glow: g.color,
    });
    UIKit.text(ctx, g.skill, w / 2, 156, { size: 27, align: 'center', color: g.color });

    // 玩法要点
    const lines = g.howto;
    let y = 228;
    for (const [icon, text] of lines) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(120, y - 2, 20, 0, Math.PI * 2);
      ctx.fillStyle = UIKit.hexA(g.color.replace('#', '#'), 0.22);
      ctx.fill();
      ctx.strokeStyle = g.color; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
      UIKit.text(ctx, icon, 120, y - 2, { size: 22, align: 'center', color: g.color, weight: 700 });
      UIKit.text(ctx, text, 164, y - 2, {
        size: 27, color: COLORS.ink, maxWidth: w - 260, lineHeight: 36,
      });
      y += 66;
    }

    // ⚠️ 这一行必须跟着**关卡**走，不只是跟着档位走。测评档是固定难度，套上
    // "难度会自动调整"就是在说明页上写了一句假话；但反过来，"分四段、每段休息"
    // 也只对 CPT 成立 —— 延迟选择关不分段、不休息、时长还随选择变化。
    // 所以关卡可以用 `meta.briefNote` 自带这一行，测评档的默认值只是 CPT 的写法。
    const mins = g.duration >= 180 ? `约 ${Math.round(g.duration / 60)} 分钟` : `${g.duration} 秒`;
    // 默认值只能说**两档各自所有关卡都成立**的话。写成某一关的样子，
    // 下一关加进来时它就会替那一关说谎，而且不报错
    const note = g.briefNote
      || (g.assess ? '固定试次的标准化流程 · 全程不报对错'
        : g.train ? '会一直调到你看不清为止 · 那是设计好的'
          : '难度会跟着你的表现自动调整');
    UIKit.text(ctx, `时长 ${mins} · ${note}`,
      w / 2, h - 214, { size: 23, align: 'center', color: COLORS.inkDim });

    for (const b of this.buttons) UIKit.button(ctx, b, { hovered: this.hovered === b.id });
  }
}

/* ----------------------------- 关卡演示字幕 ----------------------------- */

/**
 * 关卡演示（`core/Demo.js`）的字幕条。
 *
 * 位置刻意占了 HUD 的那个槽位（世界 y≈2.58 / z=-2.72）：那一片是全场唯一确定
 * **不会挡住任何关卡道具**的空档（光束聚焦上排符文石的顶已经顶到那里，见 `FocusBeam`
 * 里那段注释），而且孩子过一会儿就会在同一个位置看到 HUD，视线不用重新学。
 * 面板做得很扁也是为了这个 —— 演示的主角在下面的 3D 舞台上，不在这块画布上。
 *
 * ⚠️ **这一页的文字是给旁边的大人看的**，不是给孩子的。孩子看的是左边那个大图标
 * 和下面正在演的动作 —— 这一整套东西存在的前提就是"孩子不认字"。
 * 所以文字可以写得具体，但**图标必须自己能说清规则**。
 */
export class DemoPanel extends Panel {
  constructor() {
    super({ width: 2.3, height: 0.52, res: 660 });
    this.state = { name: '', color: COLORS.cyan, icon: 'eye', text: '', step: 0, steps: 1 };
    this._sig = '';
    const y = 124;
    this.buttons = [
      { id: 'demo-replay', kind: 'ghost', label: '再看一遍', x: 880, y, w: 300, h: 96, size: 30 },
      { id: 'demo-skip', kind: 'ghost', label: '跳过', sub: '直接看说明', x: 1200, y, w: 250, h: 96, size: 30 },
    ];
  }

  /** 每帧被调用 —— 必须先比对再打脏标记（坑#9：这张画布 1518×343）。 */
  set(s) {
    const sig = `${s.name}|${s.icon}|${s.text}|${s.step}|${s.steps}`;
    if (sig === this._sig) return;
    this._sig = sig;
    Object.assign(this.state, s);
    this.markDirty();
  }

  render() {
    const ctx = this.ctx, { w, h } = this;
    const s = this.state;
    UIKit.panelBg(ctx, w, h, { radius: 34, glow: s.color });

    UIKit.icon(ctx, s.icon, 92, h / 2, 48, ICON_COLORS[s.icon] || COLORS.ink);

    UIKit.text(ctx, `${s.name} · 看我玩一遍`, 170, 92, { size: 26, color: COLORS.inkDim });
    UIKit.text(ctx, s.text, 170, 178, {
      size: 40, weight: 700, color: COLORS.ink, maxWidth: 660, lineHeight: 46,
    });

    // 进度点：还剩几段规则要看。对不认字的孩子，"还有多久"必须是看得见的形状
    for (let i = 0; i < s.steps; i++) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(178 + i * 32, 258, 8, 0, Math.PI * 2);
      if (i <= s.step) {
        ctx.fillStyle = s.color;
        ctx.shadowColor = s.color; ctx.shadowBlur = 12;
        ctx.fill();
      } else {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(175,198,240,0.45)';
        ctx.stroke();
      }
      ctx.restore();
    }

    for (const b of this.buttons) UIKit.button(ctx, b, { hovered: this.hovered === b.id });
  }
}

/* -------------------------------- HUD -------------------------------- */

export class HudPanel extends Panel {
  constructor() {
    /*
     * ⚠️ **mipmaps 必须开**（2026-08-08 改过来的，之前是 false）。
     *
     * 原来的理由是"HUD 每帧重绘，每帧再生成 mipmap 链纯属浪费；而且它正对玩家、
     * 不会被斜看，用不上各向异性过滤"。**第二句是错的** —— 各向异性过滤确实用不上，
     * 但 mipmap 要解决的不是斜看，是**缩小采样**。Pico 4 实机量到：
     *   每眼视口 1504×1504，本画布 1645×350，屏幕上只占 545×120 px
     *   → 纹素/屏幕像素 = **2.97**，纹理在被缩小 3 倍
     * 关掉 mipmap 时每个屏幕像素只从 ~9 个纹素里挑 1 个，细笔画就闪烁碎裂 ——
     * 这是全场 8 个面板里唯一关掉的一个，也正是肉眼一眼看出"HUD 字锯齿最重"的原因。
     *
     * 第一句（每帧重绘）用下面的 `set()` 签名比对解决：只在**画出来真的不一样**时
     * 才 markDirty。所以现在既有 mipmap，上传次数还比以前少。
     */
    super({ width: 2.35, height: 0.5, res: 700, backing: false, mipmaps: true });
    this.plane.material.opacity = 0.96;
    this.state = {
      title: '', timeLeft: 0, duration: 1, score: 0, streak: 0,
      accuracy: 1, attention: 50, quality: 0, level: '基础', color: COLORS.cyan,
    };
    this.buttons = [];
    this._sig = null;
    this._buildLive();
  }

  /* ------------------------ 从主画布上搬出来的活动件 ------------------------
   *
   * ☠️ **别把这三样搬回画布。** 主画布 1645×350，Pico 4 实机量到重新上传一次
   * 约 **25ms 管线停顿**；而时间条每秒变 10.8 次、专注度条与读数每秒变 8.2 次，
   * 每一次都要重传整张大图 —— 游玩中帧率因此从 48 掉到 **23**（2026-08-08 实机
   * 分离变量量出来的：冻结上传后帧率立刻回到 47.9，而那张大纹理还挂着）。
   *
   * 搬走之后主画布只剩文字，每秒变约 0.2 次。这正是
   * `.claude/rules/界面-世界空间文字与画布.md` 里那条规矩：
   * 「连续动感靠 3D 物体或面板材质的属性来做 —— 改材质属性不触发纹理上传」。
   *
   * 各件对应画布上的原坐标（`render()` 里仍画着**底槽**，只有填充搬走了）：
   *   时间条填充  x 36..1609,   y 26..38
   *   专注度填充  x 1145..1425, y 169..203
   *   专注度读数  x 1447 起,    y 155..219（size 38 / weight 700）
   *
   * 已知的视觉差异（就一处）：填充右端由圆头变方头。条子只有约 11 屏幕像素高，
   * 圆角半径那几像素看不出来，而方头作为"进度到哪了"其实更准。
   */
  _buildLive() {
    const timeR = this._localRect(36, 26, 1573, 12);
    this.timeFill = this._makeFillBar(timeR, 1);
    this.add(this.timeFill);

    const attnR = this._localRect(1145, 169, 280, 34);
    this.attnFill = this._makeFillBar(attnR, 0.92);   // 0.92 复现 UIKit.bar 的 globalAlpha
    this.add(this.attnFill);

    this.attnNum = this._makeAttnNum(this._localRect(1447, 155, 128, 64));
    this.add(this.attnNum);

    this._barColor = null;
    this._attnShown = null;
    this._attnRight = null;
  }

  /** 画布像素矩形 → 面板局部坐标（米）。左上原点 → 中心原点、y 翻向。 */
  _localRect(px, py, pw, ph) {
    return {
      x: ((px + pw / 2) / this.w - 0.5) * this.wWorld,
      y: (0.5 - (py + ph / 2) / this.h) * this.hWorld,
      w: (pw / this.w) * this.wWorld,
      h: (ph / this.h) * this.hWorld,
    };
  }

  /**
   * 左端锚定的渐变填充条。`scale.x` 直接就是"从左往右长出多少米"。
   * 渐变用**顶点色**而不是渐变纹理：纹理会被 scale 拉伸变形，而且乘法混合
   * 只能压暗、做不出画布上那种「本色 → 纯白」的提亮。
   */
  _makeFillBar(rect, opacity) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0.5, 0, 0);   // 原点挪到左边缘
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12).fill(1), 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity,
      depthWrite: false, toneMapped: false,
    }));
    // z 抬一点点 + renderOrder，压住与面板本体的 z-fight（两者都 depthWrite:false）
    mesh.position.set(rect.x - rect.w / 2, rect.y, 0.002);
    mesh.scale.set(0, rect.h, 1);
    mesh.renderOrder = 2;
    mesh.userData.fullW = rect.w;
    return mesh;
  }

  /**
   * 专注度读数的专属小画布（128×64）。
   * 它照旧每秒重绘 8 次，但 8K 像素相对主画布的 575K 是 1/70，上传成本可以忽略 ——
   * **这一块是"搬两根条子"能不能拿到帧率的关键**：读数也是画布文字，
   * 留在主画布上的话每秒 8 次大图上传照旧，条子搬了也白搬。
   * 1 迷你像素 = 1 主画布像素，所以字号沿用原来的 38，不用换算。
   */
  _makeAttnNum(rect) {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 64;
    this._attnCtx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    this._attnTex = tex;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(rect.w, rect.h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
    );
    mesh.position.set(rect.x, rect.y, 0.002);
    mesh.renderOrder = 2;
    return mesh;
  }

  _setBarColors(mesh, left, right) {
    const c = mesh.geometry.attributes.color;
    _cA.set(left); _cB.set(right);           // 复用模块级实例，热路径不 new Color
    c.setXYZ(0, _cA.r, _cA.g, _cA.b); c.setXYZ(2, _cA.r, _cA.g, _cA.b);
    c.setXYZ(1, _cB.r, _cB.g, _cB.b); c.setXYZ(3, _cB.r, _cB.g, _cB.b);
    c.needsUpdate = true;
  }

  /** 每帧刷活动件。**全是改属性，一次纹理上传都不产生**（读数变了才传那块小的）。 */
  _updateLive() {
    const s = this.state;
    const frac = Math.max(0, Math.min(1, s.timeLeft / (s.duration || 1)));
    this.timeFill.scale.x = frac * this.timeFill.userData.fullW;
    this.timeFill.visible = frac > 0.002;
    if (this._barColor !== s.color) {
      this._barColor = s.color;
      this._setBarColors(this.timeFill, s.color, '#ffffff');
    }

    // 测评档与老年训练档都没有专注度回显（见 _renderNoFeedback）—— 连活动件一起藏掉
    const show = s.mode !== 'assess' && s.mode !== 'train';
    this.attnFill.visible = show;
    this.attnNum.visible = show;
    if (!show) return;

    const v = Math.max(0, Math.min(1, (s.attention || 0) / 100));
    this.attnFill.scale.x = v * this.attnFill.userData.fullW;
    this.attnFill.visible = v > 0.004;
    const col = s.attention > 65 ? COLORS.mint : s.attention > 40 ? COLORS.cyan : COLORS.gold;
    // UIKit.bar 的渐变铺满**整条**、填充只露出前一段，所以右端色要取 lerp(色, 白, v)，
    // 否则填充到一半时右端就已经是纯白了，跟画布版本不一样
    _cB.set(col).lerp(_WHITE, v);
    const rightHex = _cB.getHexString();
    if (this._barColorAttn !== col || this._attnRight !== rightHex) {
      this._barColorAttn = col; this._attnRight = rightHex;
      this._setBarColors(this.attnFill, col, `#${rightHex}`);
    }

    const n = Math.round(s.attention);
    if (n !== this._attnShown) {
      this._attnShown = n;
      const c = this._attnCtx;
      c.clearRect(0, 0, 128, 64);
      UIKit.text(c, String(n), 0, 32, { size: 38, weight: 700, color: COLORS.ink });
      this._attnTex.needsUpdate = true;
    }
  }

  dispose() {
    super.dispose();
    for (const m of [this.timeFill, this.attnFill, this.attnNum]) {
      m.geometry.dispose();
      m.material.map?.dispose();
      m.material.dispose();
    }
  }

  /**
   * 只在主画布真会画得不一样时才重绘 —— 参照 `RestPanel` 的签名比对（坑 #9）。
   * 原来这里是每帧无条件 `markDirty()`，那是 VR 游玩帧率减半的直接原因。
   */
  set(s) {
    Object.assign(this.state, s);
    // 活动件先刷 —— 它在签名比对**之前**，因为改属性不花上传成本，
    // 而且签名里已经没有这些连续量了，放在 return 后面会整个失效
    this._updateLive();

    const t = this.state;
    /*
     * ⚠️ **签名必须只含"这一帧的主画布真会画得不一样"的字段。**
     *
     * 两条排除都不是优化而是必须：
     *  ① 时间条 / 专注度条 / 专注度读数已经搬到 3D 物体与小画布上了（见 _buildLive），
     *    主画布上只剩不动的底槽 —— 把它们算进签名等于为**画布外的东西**付一次
     *    整张大图上传（约 25ms 管线停顿）。
     *  ② 测评档与训练档刻意不回显分数/连击/正确率（见 _renderNoFeedback），同理不能算进来。
     * 违反任何一条的症状都一样：画面上一个像素都不会不同，而 VR 帧率减半。
     */
    const sig = [t.title, t.level, t.mode, t.breaking ? 1 : 0, t.block, t.unit, t.color, t.quality];
    if (t.mode !== 'assess' && t.mode !== 'train') {
      sig.push(t.score, t.streak, Math.round((t.accuracy || 0) * 100));
    }
    const joined = sig.join('|');
    if (joined === this._sig) return;
    this._sig = joined;
    this.markDirty();
  }

  render() {
    const ctx = this.ctx, { w, h } = this;
    const s = this.state;
    ctx.clearRect(0, 0, w, h);

    UIKit.roundRect(ctx, 4, 4, w - 8, h - 8, 40);
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(12,17,44,0.86)');
    g.addColorStop(0.5, 'rgba(20,28,68,0.8)');
    g.addColorStop(1, 'rgba(12,17,44,0.86)');
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(140,178,255,0.28)'; ctx.stroke();

    // 剩余时间条：**这里只画底槽**，会动的填充是 `this.timeFill`（3D 面片，见 _buildLive）。
    // 想在这儿把填充画回来的话，先读 _buildLive 顶上那段 ☠️。
    UIKit.roundRect(ctx, 36, 26, w - 72, 12, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill();

    const midY = h / 2 + 26;
    // 左：关卡名 + 难度
    UIKit.text(ctx, s.title, 48, midY - 20, { size: 40, weight: 700, color: COLORS.ink });
    // 小字一律 weight 700。**别改回默认的 500** —— 27px 的字在 Pico 4 上只有
    // 8.9 个屏幕像素（画布被缩小 3 倍采样），weight 500 的中文笔画在这个尺寸下
    // 直接糊成一团。加粗不动任何坐标，是唯一不需要重排版面的办法。
    // ⚠️ 训练档不画这一行：它的 `level` 是"238Hz · 1步=4帧"这类**内部标定读数**，
    // 对被试没有意义（而且是个老人），而"难度"这个词对阶梯法关卡本身就是假的 ——
    // 难度每一试次都在动，正是被测量的东西。
    if (s.mode !== 'train') {
      UIKit.text(ctx, `难度 ${s.level}`, 48, midY + 30, { size: 27, weight: 700, color: COLORS.inkDim });
    }

    if (s.mode === 'assess' || s.mode === 'train') { this._renderNoFeedback(ctx, s, midY); return; }

    // 中：得分与连击
    UIKit.text(ctx, String(s.score), w * 0.45, midY - 10, {
      size: 68, weight: 800, align: 'right', color: COLORS.gold, glow: 'rgba(255,200,80,0.5)',
    });
    UIKit.text(ctx, '分', w * 0.45 + 10, midY + 8, { size: 27, weight: 700, color: COLORS.inkDim });

    if (s.streak >= 2) {
      UIKit.text(ctx, `连击 ×${s.streak}`, w * 0.45 + 78, midY - 12, {
        size: 33, weight: 700, color: COLORS.mint, glow: 'rgba(100,255,180,0.5)',
      });
    }
    UIKit.text(ctx, s.mode === 'nback'
      ? `命中率 ${s.accuracy == null ? '—' : Math.round(s.accuracy * 100) + '%'}`
      : `正确率 ${Math.round(s.accuracy * 100)}%`, w * 0.45 + 78, midY + 32, {
      size: 27, weight: 700, color: COLORS.inkDim,
    });

    // 右：专注度指数（脑电）。**这里只画标签和底槽** —— 会动的填充是 `this.attnFill`，
    // 数字读数是 `this.attnNum`（各自独立，见 _buildLive 顶上的 ☠️）。
    // `UIKit.bar` 传 value=0 就只画底槽，vw 为 0 时它会跳过填充那段。
    const bx = w - 500, by = midY - 32;
    UIKit.text(ctx, '专注度', bx - 18, by + 18, { size: 27, weight: 700, align: 'right', color: COLORS.inkDim });
    UIKit.bar(ctx, bx, by, 280, 34, 0, {
      color: s.attention > 65 ? COLORS.mint : s.attention > 40 ? COLORS.cyan : COLORS.gold,
    });

    // 信号质量点
    this._quality(ctx, s, bx + 386, by + 18);
  }

  /**
   * 「无表现回显」的 HUD。**没有分数、没有连击、没有正确率、没有专注度条** ——
   * 这四样都是对表现的即时回显。留下的只有三样跟表现无关的东西：
   * 进行到哪了、要不要休息、脑电信号还在不在（那是设备状态，不是成绩）。
   *
   * ⚠️ **两个档共用这一份，但理由不同 —— 哪天理由分家了就把它拆开，别硬合。**
   *   · 测评档（`mode:'assess'`）：回显会让孩子在任务中调整策略，被测的就不再是
   *     他自然状态下的表现（见 `CatcherCpt.js` 文件头 ③）。
   *   · 老年训练档（`mode:'train'`）：刻板印象威胁 + 铁律 5「只给正反馈」，
   *     而且阶梯法把正确率钳在 75%，显示出来永远像在错四分之一（见 `UfovFocus.hudState`）。
   * 现在两边要的版面碰巧一模一样（进度 + 信号质量），所以合成一份；
   * 但**训练档还多一条：连"难度"那行也不画**，那个分支在 `render()` 里。
   */
  _renderNoFeedback(ctx, s, midY) {
    const { w } = this;
    if (s.breaking) {
      UIKit.text(ctx, '休息一下', w * 0.52, midY - 4, {
        size: 46, weight: 800, align: 'center', color: COLORS.mint,
        glow: 'rgba(100,255,180,0.45)',
      });
    } else {
      // 量词跟着关卡走：CPT 是分段的（"第 2 段 / 共 4 段"），延迟选择关不分段、
      // 按次计（"第 3 次 / 共 10 次"）。写死"段"对后者是一句假话，而且是关于
      // "这一关到底怎么组织"的那句话
      const unit = s.unit || '段';
      UIKit.text(ctx, `第 ${s.block} ${unit}`, w * 0.52, midY - 14, {
        size: 44, weight: 800, align: 'center', color: COLORS.ink,
      });
      // 小字一律 weight 700，理由同上面「难度」那行
      UIKit.text(ctx, `共 ${s.blockCount} ${unit}`, w * 0.52, midY + 26, {
        size: 24, weight: 700, align: 'center', color: COLORS.inkDim,
      });
    }

    // 右：只留信号质量 —— 它是设备状态（电极还贴着吗），不是成绩
    const qx = w - 300;
    UIKit.text(ctx, '脑电信号', qx - 18, midY + 4, { size: 26, weight: 700, align: 'right', color: COLORS.inkDim });
    this._quality(ctx, s, qx + 14, midY - 4);
  }

  _quality(ctx, s, x, y) {
    for (let i = 0; i < 3; i++) {
      const on = s.quality > (i + 1) / 3.4;
      ctx.beginPath();
      ctx.arc(x + i * 20, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = on ? COLORS.mint : 'rgba(255,255,255,0.16)';
      ctx.fill();
    }
  }
}

/* ----------------------------- 单关结算页 ----------------------------- */

export class ResultPanel extends Panel {
  constructor() {
    super({ width: 1.85, height: 1.2, res: 660 });
    this.data = null;
    this.buttons = [
      { id: 'next', kind: 'primary', label: '继续', x: 0, y: 0, w: 460, h: 110 },
      { id: 'menu', kind: 'ghost', label: '回菜单', x: 0, y: 0, w: 240, h: 110 },
    ];
    const total = 460 + 24 + 240;
    const x0 = (this.w - total) / 2;
    this.buttons[0].x = x0; this.buttons[0].y = this.h - 168;
    this.buttons[1].x = x0 + 484; this.buttons[1].y = this.h - 168;
  }

  setData(d, { nextLabel = '继续' } = {}) {
    this.data = d;
    this.buttons[0].label = nextLabel;
    this.markDirty();
  }

  /** 归档回执：这一场挂在谁名下。`null` = 未认领，必须显眼说出来（见 Game._archiveSession）。 */
  setArchived(code) {
    if (this._archived === code) return;
    this._archived = code;
    this.markDirty();
  }

  render() {
    const ctx = this.ctx, { w, h } = this;
    const d = this.data;
    UIKit.panelBg(ctx, w, h, { glow: d?.color || COLORS.cyan });
    if (!d) return;

    UIKit.text(ctx, d.title, w / 2, 84, { size: 46, weight: 800, align: 'center', color: COLORS.ink });
    UIKit.text(ctx, d.praise, w / 2, 140, {
      size: 30, align: 'center', color: d.color, glow: UIKit.hexA(d.color, 0.5),
    });

    // stars=null 是测评档：那一档不给星（星是评价，测评不评价）。
    // 换成一枚"做完了"的勾 —— 孩子仍然得到一个明确的完成信号，
    // 但它对任何表现都是同一个，不泄露成绩、也不给下一次留预期。
    if (d.stars == null) this._doneBadge(ctx, w / 2, 228);
    else for (let i = 0; i < 3; i++) UIKit.star(ctx, w / 2 - 92 + i * 92, 232, 40, i < d.stars);

    const stats = d.stats;
    const cols = stats.length;
    const cw = (w - 180) / cols;
    stats.forEach((st, i) => {
      const x = 90 + cw * i + cw / 2;
      UIKit.text(ctx, st.value, x, 340, {
        size: 52, weight: 800, align: 'center', color: st.color || COLORS.ink,
      });
      UIKit.text(ctx, st.label, x, 392, { size: 22, align: 'center', color: COLORS.inkDim });
      if (st.hint) UIKit.text(ctx, st.hint, x, 424, { size: 18, align: 'center', color: 'rgba(130,150,195,0.8)' });
    });

    if (d.tip) {
      ctx.save();
      UIKit.roundRect(ctx, 90, h - 300, w - 180, 84, 22);
      ctx.fillStyle = 'rgba(120,160,255,0.1)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(140,180,255,0.25)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
      UIKit.text(ctx, d.tip, w / 2, h - 258, {
        size: 24, align: 'center', color: COLORS.ink, maxWidth: w - 220, lineHeight: 32,
      });
    }

    // 归档回执。位置在按钮上方那条窄缝里（tip 底沿 h-216，按钮顶沿 h-168）
    archivedLine(ctx, w, h - 192, this._archived);

    for (const b of this.buttons) UIKit.button(ctx, b, { hovered: this.hovered === b.id });
  }

  /** 完成徽章：一圈光环 + 一个勾。纯画笔，无资产（铁律 3）。 */
  _doneBadge(ctx, cx, cy) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, 46, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.mint; ctx.lineWidth = 5;
    ctx.shadowColor = 'rgba(100,255,180,0.6)'; ctx.shadowBlur = 26;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 22, cy + 2); ctx.lineTo(cx - 6, cy + 19); ctx.lineTo(cx + 24, cy - 18);
    ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * 「本场挂在谁名下」那一行 —— 结算页与测评报告页共用一份实现。
 *
 * ☠️ **这是当场发现"记错人"的最后一次机会**：事后翻报告时，这一场已经混进那个
 * 孩子的历次记录里了，而且看不出是哪一场串的。所以未认领必须用警示色显眼说，
 * 别做成一行灰色小字。
 *
 * `code === undefined` 表示这一场还没归档（或归档失败），什么都不画。
 */
function archivedLine(ctx, w, y, code) {
  if (code === undefined) return;
  const ok = !!code;
  UIKit.text(ctx, ok ? `本场已归档 · 被试 ${code}` : '⚠️ 本场未认领 —— 开始前没有选被试',
    w / 2, y, {
      size: 24, weight: 700, align: 'center',
      color: ok ? COLORS.mint : COLORS.coral,
    });
}

/* ------------------------------ 测评报告 ------------------------------ */

export class ReportPanel extends Panel {
  constructor() {
    super({ width: 2.55, height: 1.74, res: 600 });
    this.report = null;
    this.buttons = [
      { id: 'again', kind: 'primary', label: '再测一次', x: 0, y: 0, w: 380, h: 98, size: 30 },
      { id: 'menu', kind: 'ghost', label: '返回菜单', x: 0, y: 0, w: 270, h: 98, size: 30 },
      { id: 'export', kind: 'ghost', label: '导出数据 JSON', x: 0, y: 0, w: 330, h: 98, size: 30 },
      { id: 'viz', kind: 'ghost', label: '完整报告', x: 0, y: 0, w: 280, h: 98, size: 30 },
    ];
    // 总宽 1352 < 画布 1530（2.55m × res 600），左右各余 89px。**再加按钮前先算这一笔** ——
    // 超了不会报错，只会把最外侧的按钮挤出面板边缘，而它照样能被射线打到
    const gap = 24;
    const total = 380 + 270 + 330 + 280 + gap * 3;
    let x = (this.w - total) / 2;
    for (const b of this.buttons) { b.x = x; b.y = this.h - 128; x += b.w + gap; }
  }

  setReport(r) { this.report = r; this.markDirty(); }

  /** 归档回执，与 ResultPanel 同一套语义（见 archivedLine）。 */
  setArchived(code) {
    if (this._archived === code) return;
    this._archived = code;
    this.markDirty();
  }

  render() {
    const ctx = this.ctx, { w, h } = this;
    UIKit.panelBg(ctx, w, h);
    const r = this.report;
    if (!r) return;

    const M = 88;                 // 左右留白
    const halfW = (w - M * 2 - 26) / 2;
    const rightX = M + halfW + 26;

    // 「速览」而不是「报告」：完整报告（历次记录、客观指标、可导出）在浏览器页里，
    // 这一屏只是刚做完那一刻的即时反馈。名字写成"报告"会让人以为看到的就是全部
    UIKit.text(ctx, '本次速览', M, 78, { size: 46, weight: 800, color: COLORS.ink });
    UIKit.text(ctx, r.subtitle, M, 126, { size: 22, color: COLORS.inkDim });

    // 总星级：留着，但压成右上角的小字号 —— 星星是给孩子的激励，
    // 不是测评结论。让它和指标卡抢视觉重量，读报告的人就会把它当成结论。
    // **测评档传 null**：那一档整条流程都不评价，报告页也不能在角落里偷偷评一下。
    if (r.totalStars != null) {
      for (let i = 0; i < 9; i++) UIKit.star(ctx, w - M - 14 - i * 26, 80, 10, i < r.totalStars);
      UIKit.text(ctx, `本次 ${r.totalStars} / 9 星`, w - M, 126, {
        size: 20, align: 'right', color: 'rgba(198,170,96,0.85)',
      });
    } else {
      // 说「固定试次」而不是「固定难度」：测评档现在有两关，而延迟选择关根本
      // 没有"难度"这回事（选哪个都不算错）。两关共有的性质是试次与序列固定。
      // ☠️ **这个角标必须跟着档位走，它是一句关于"这份报告是怎么采出来的"的断言。**
      // 2026-08-22 踩过：老年训练档也传 `totalStars:null`，于是顶着「固定试次·标准化施测」
      // 出报告 —— 而那一档是自适应双阶梯，**每一个字都是反的**，且画面上看着完全正常。
      UIKit.text(ctx, r.badge || '固定试次 · 标准化施测', w - M, 96, {
        size: 24, align: 'right', weight: 700, color: COLORS.mint,
      });
    }

    // ---- 关键指标卡 ----
    const cards = r.cards;
    const cw = (w - M * 2 - (cards.length - 1) * 18) / cards.length;
    // cardH 要装得下折成两行的 note（"辨别 Go/NoGo 的敏感度" 就是两行）——
    // 158 时第二行正好被卡片底边裁掉最后一个字，而且不报任何错（同坑#35 那类）
    const cardY = 166, cardH = 166;
    cards.forEach((c, i) => {
      const x = M + i * (cw + 18);
      ctx.save();
      UIKit.roundRect(ctx, x, cardY, cw, cardH, 22);
      ctx.fillStyle = 'rgba(120,160,255,0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(140,180,255,0.2)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
      UIKit.text(ctx, c.label, x + cw / 2, cardY + 36, { size: 21, align: 'center', color: COLORS.inkDim });
      UIKit.text(ctx, c.value, x + cw / 2, cardY + 88, {
        size: 48, weight: 800, align: 'center', color: c.color || COLORS.ink,
      });
      UIKit.text(ctx, c.note, x + cw / 2, cardY + 130, {
        size: 17, align: 'center', color: 'rgba(140,158,200,0.9)',
        maxWidth: cw - 20, lineHeight: 21,
      });
    });

    // ---- 图表区 ----
    const chartY = 392, chartH = 168;
    // ⚠️ 标题与量程必须可配：老年训练档这条曲线画的是**呈现时长阈值的收敛轨迹**（毫秒），
    // 不是正确率 —— 那一档的试次全是 `scored:false`，"各时段正确率"对它是一句假话。
    // `lineChart` 对 `length < 2` 会只画网格后返回，传空数组安全。
    UIKit.text(ctx, r.vigilanceTitle || '注意力保持曲线（各时段正确率）', M, chartY - 20, { size: 22, color: COLORS.ink });
    UIKit.lineChart(ctx, M, chartY, halfW, chartH, r.vigilance, {
      color: COLORS.cyan, min: r.vigilanceMin ?? 0, max: r.vigilanceMax ?? 1,
    });
    UIKit.text(ctx, '开始', M, chartY + chartH + 24, { size: 18, color: COLORS.inkDim });
    UIKit.text(ctx, '结束', M + halfW, chartY + chartH + 24, { size: 18, align: 'right', color: COLORS.inkDim });

    UIKit.text(ctx, `专注度指数（${r.attentionSource || '脑电'} 0-100）`, rightX, chartY - 20,
      { size: 22, color: COLORS.ink });
    UIKit.lineChart(ctx, rightX, chartY, halfW, chartH, r.attention, {
      color: COLORS.violet, min: 0, max: 100,
    });

    // ---- 分项成绩（左） / 观察建议（右） ----
    const secY = chartY + chartH + 74;
    UIKit.text(ctx, r.perGameTitle || '分项成绩', M, secY, { size: 25, weight: 700, color: COLORS.ink });
    r.perGame.forEach((g, i) => {
      const rowY = secY + 46 + i * 40;
      UIKit.text(ctx, g.name, M + 6, rowY, { size: 22, color: g.color });
      UIKit.text(ctx, g.detail, M + 168, rowY, { size: 20, color: COLORS.inkDim });
      // 同上：测评档的每一行都传 stars=null，不在这里补一个评价
      if (g.stars != null) {
        for (let s = 0; s < 3; s++) UIKit.star(ctx, M + halfW - 76 + s * 32, rowY, 12, s < g.stars);
      }
    });

    // 老年训练档没有"家长"，这一栏写给施测者看，所以标题也要可配
    UIKit.text(ctx, r.adviceTitle || '给家长的观察建议', rightX, secY, { size: 25, weight: 700, color: COLORS.ink });
    UIKit.text(ctx, r.advice, rightX, secY + 44, {
      size: 20, color: COLORS.inkDim, maxWidth: halfW, lineHeight: 30,
    });

    // ⚠️ 这一句不是免责套话，而且**两档说的不是同一件事**：
    //   体验档 —— 难度是按表现自适应调的，两个孩子看到的题不一样，只能跟自己比；
    //   测评档 —— 难度固定、序列固定，原理上可跨人比，但我们没有常模，所以仍然只是辅助参考。
    // 把测评档也套上"自适应"那句话是**事实错误**，反过来把体验档说成"标准化"更糟。
    UIKit.text(ctx, r.disclaimer
      || '难度按表现自适应调整，指标仅为个体内参考；本报告为原型演示数据，'
        + '未经临床常模标定，不可用于诊断或疗效评估。',
      // 抬高 8px 并给了换行参数：测评档那句更长，万一折成两行，
      // 第二行原本会压到按钮顶边上（同坑#35 那一类：不报错、只是看着不对）
      w / 2, h - 166, {
        size: 18, align: 'center', color: 'rgba(120,138,180,0.85)',
        maxWidth: w - M * 2, lineHeight: 22,
      });

    // 归档回执。放在免责声明上方 —— 那行是每场都一样的固定文本，
    // 而这一行是**这一场独有**的信息，压在它下面会被当成同一段套话扫过去
    archivedLine(ctx, w, h - 206, this._archived);

    for (const b of this.buttons) UIKit.button(ctx, b, { hovered: this.hovered === b.id });
  }
}

/* ------------------------------ 脑电设置 ------------------------------
 *
 * 为什么这一页必须在世界空间里再做一份（bci.html 已经有一个完整的了）：
 * 戴上头显之后就看不见电脑屏幕了，而"电极贴稳没有"恰恰是戴着头显的时候最需要
 * 确认的一件事。DOM 页面在沉浸式会话里根本不存在（铁律 2），而 XR 会话中导航
 * 会让 Pico 浏览器直接崩（坑#33）—— 所以这里不是重复建设，是唯一可行的做法。
 *
 * 分工：这一页只管"看得见 + 能启停 + 能切源"这三件戴着头显要做的事；
 * 完整的电极佩戴顺序、采集器日志、控制口令输入仍然留在 bci.html。
 */
/**
 * 采集侧给的污染原因是内部标签（bci/capture.py 的 is_sample_window_contaminated）。
 * 这一页是给正在戴电极的人看的，直接把 voltage_std_high 摆上去等于什么都没说 ——
 * 要说的是"你现在该做什么"。表里没有的值原样透出，好过吞掉一个我们没见过的原因。
 */
const REASON_TEXT = {
  voltage_std_high: '电压波动过大 · 别动、放松额头',
  manual_event_inside_window: '窗口内有人工标记',
  manual_event_inside_epoch: '窗口内有人工标记',
  manual_event_within_padding: '附近有人工标记',
};

export class BciPanel extends Panel {
  constructor() {
    super({ width: 2.24, height: 1.4, res: 620 });
    this.info = {
      label: '模拟脑电源', note: '', quality: 0, attention: 50,
      simulated: true, live: false, running: false, peer: null, bands: null, reasons: [],
    };
    this._sig = '';
    this._layout();
  }

  _layout() {
    const { w, h } = this;
    const bw = [380, 340, 240], gap = 26;
    const total = bw.reduce((a, b) => a + b, 0) + gap * 2;
    let x = (w - total) / 2;
    const y = h - 158;
    this.buttons = [
      { id: 'bci-source', kind: 'ghost', label: '切换数据源', sub: '模拟 / 真机 / 桥接',
        x, y, w: bw[0], h: 104, size: 30 },
      { id: 'bci-collect', kind: 'primary', label: '开始采集', sub: '本机采集程序',
        x: x + bw[0] + gap, y, w: bw[1], h: 104, size: 30 },
      { id: 'bci-back', kind: 'ghost', label: '返回', sub: 'Esc',
        x: x + bw[0] + bw[1] + gap * 2, y, w: bw[2], h: 104, size: 30 },
    ];
  }

  /**
   * 每帧都会被调用，所以**必须先比对再打脏标记**（坑#9：这张画布 1389×868，
   * 无条件重绘 + 上传就是每秒几百 MB 的带宽）。注意力指数取整到 1、质量取整到
   * 0.05 之后，实际重绘频率就落到上游的更新频率（2Hz）上。
   */
  setInfo(info) {
    Object.assign(this.info, info);
    const i = this.info;
    const b = i.bands || {};
    const sig = [
      i.label, i.note, i.simulated, i.live, i.running, i.peer,
      Math.round(i.attention), Math.round(i.quality * 20),
      ...['theta', 'alpha', 'beta', 'mains50'].map((k) => (b[k] ? b[k].toPrecision(2) : '-')),
    ].join('|');
    if (sig === this._sig) return;
    this._sig = sig;

    const collect = this.buttons.find((x) => x.id === 'bci-collect');
    collect.label = i.running ? '停止采集' : '开始采集';
    collect.kind = i.running ? 'ghost' : 'primary';
    // 采集跑在别的机器上时，本机的启停按钮起的是本机那个采集器 —— 那台机器上
    // 根本没插设备。不禁用的话，人会在错的机器上反复点「开始采集」（见 CLAUDE.md）
    collect.disabled = !!i.peer;
    collect.sub = i.peer ? '采集在另一台机器上' : '本机采集程序';
    this.markDirty();
  }

  render() {
    const ctx = this.ctx, { w, h } = this;
    const i = this.info;
    UIKit.panelBg(ctx, w, h);

    UIKit.text(ctx, '脑电设置', w / 2, 84, {
      size: 60, weight: 800, align: 'center', color: COLORS.ink, glow: 'rgba(90,200,255,0.7)',
    });
    UIKit.text(ctx, i.label, w / 2, 142, { size: 27, align: 'center', color: COLORS.cyan });
    UIKit.text(ctx, i.note || (i.simulated ? '不接设备也能完成全部测评' : '等待数据'), w / 2, 182, {
      size: 21, align: 'center', color: COLORS.inkDim,
    });

    const M = 90, colW = (w - M * 2 - 30) / 2, cardY = 218, cardH = 208;

    // ---- 左：信号质量 ----
    this._card(ctx, M, cardY, colW, cardH);
    UIKit.text(ctx, '信号质量', M + 24, cardY + 40, { size: 23, color: COLORS.inkDim });
    const q = i.quality;
    const qColor = q > 0.6 ? COLORS.mint : q > 0.3 ? COLORS.gold : COLORS.coral;
    // 模拟源开局两秒内质量是从 0 爬上来的（它在模拟电极接触建立的过程）。
    // 这时候说"检查电极"会让人去找一个根本不存在的设备问题 —— 模拟源没有电极。
    const qText = !i.live && !i.simulated ? '无数据'
      : q > 0.6 ? '良好' : q > 0.3 ? '一般'
        : i.simulated ? '模拟信号建立中' : '差 · 检查电极';
    UIKit.text(ctx, qText, M + 24, cardY + 96, { size: 40, weight: 800, color: qColor });
    UIKit.bar(ctx, M + 24, cardY + 132, colW - 48, 16, q, { color: qColor });
    // 这句是坑#20 的用户侧说明：质量差时指数会被冻结，不是"数值偏低"而是"不可用"
    const reasonText = i.reasons?.length
      ? i.reasons.map((r) => REASON_TEXT[r] || r).join(' · ')
      : '质量低于 0.35 时指数被冻结，不驱动画面';
    UIKit.text(ctx, reasonText,
      M + 24, cardY + 172, { size: 19, color: 'rgba(140,158,200,0.9)', maxWidth: colW - 48, lineHeight: 24 });

    // ---- 右：注意力指数 ----
    const rx = M + colW + 30;
    this._card(ctx, rx, cardY, colW, cardH);
    UIKit.text(ctx, '注意力指数', rx + 24, cardY + 40, { size: 23, color: COLORS.inkDim });
    UIKit.text(ctx, String(Math.round(i.attention)), rx + 24, cardY + 96, {
      size: 46, weight: 800, color: COLORS.violet,
    });
    UIKit.text(ctx, '/ 100', rx + 24 + 100, cardY + 104, { size: 22, color: COLORS.inkDim });
    UIKit.bar(ctx, rx + 24, cardY + 132, colW - 48, 16, i.attention / 100, { color: COLORS.violet });
    // 反复强调"相对量"：绝对分数一旦被当成能力值，就成了跨人比较，那是错的（见 CLAUDE.md）
    UIKit.text(ctx, '50 = 他自己近一分钟的平均水平，不能跨人比较',
      rx + 24, cardY + 172, { size: 19, color: 'rgba(140,158,200,0.9)' });

    // ---- 频带功率 ----
    const bandY = cardY + cardH + 52;
    UIKit.text(ctx, '频带功率', M, bandY, { size: 23, color: COLORS.inkDim });
    const b = i.bands;
    if (!b) {
      UIKit.text(ctx, i.simulated ? '模拟数据源不产生频带功率 —— 切到真机档才有'
        : '还没收到数据', w / 2, bandY + 74, {
        size: 24, align: 'center', color: 'rgba(140,158,200,0.75)',
      });
    } else {
      const rows = [
        ['θ 4–8Hz', b.theta, COLORS.cyan],
        ['α 8–13Hz', b.alpha, COLORS.mint],
        ['β 13–30Hz', b.beta, COLORS.violet],
        ['50Hz 工频', b.mains50, COLORS.coral],
      ];
      rows.forEach(([label, v, color], k) => {
        const y = bandY + 44 + k * 40;
        UIKit.text(ctx, label, M, y, { size: 21, color: COLORS.inkDim });
        // 功率跨好几个数量级（实测工频能到 beta 的上万倍），线性条会把除工频外的
        // 三条全压成 0 —— 所以条按 log10 归一，看的是"量级"不是"比例"
        const norm = v > 0 ? Math.max(0, Math.min(1, (Math.log10(v) - 4) / 9)) : 0;
        UIKit.bar(ctx, M + 180, y - 9, w - M * 2 - 180 - 170, 18, norm, { color });
        UIKit.text(ctx, v > 0 ? v.toExponential(1) : '—', w - M, y, {
          size: 20, align: 'right', color: COLORS.inkDim,
        });
      });
    }

    for (const btn of this.buttons) UIKit.button(ctx, btn, { hovered: this.hovered === btn.id });
  }

  _card(ctx, x, y, w, h) {
    ctx.save();
    UIKit.roundRect(ctx, x, y, w, h, 24);
    ctx.fillStyle = 'rgba(120,160,255,0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,180,255,0.2)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

/* ---------------------------- 吉祥物对话气泡 ---------------------------- */

export class BubblePanel extends Panel {
  constructor() {
    super({ width: 0.92, height: 0.36, res: 780, backing: false });
    this.message = '';
    this.buttons = [];
  }

  say(msg) { this.message = msg; this.markDirty(); this.visible = true; }

  render() {
    const ctx = this.ctx, { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    UIKit.roundRect(ctx, 8, 8, w - 16, h - 34, 34);
    ctx.fillStyle = 'rgba(238,246,255,0.94)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,190,255,0.7)';
    ctx.lineWidth = 3;
    ctx.stroke();
    // 小尾巴
    ctx.beginPath();
    ctx.moveTo(w * 0.34, h - 36);
    ctx.lineTo(w * 0.42, h - 8);
    ctx.lineTo(w * 0.5, h - 36);
    ctx.closePath();
    ctx.fillStyle = 'rgba(238,246,255,0.94)';
    ctx.fill();
    ctx.restore();

    ctx.font = `600 34px ${FONT}`;
    const lines = UIKit.wrap(ctx, this.message, w - 90);
    const startY = (h - 34) / 2 - ((lines.length - 1) * 42) / 2;
    lines.forEach((ln, i) => {
      UIKit.text(ctx, ln, w / 2, startY + i * 42, {
        size: 34, weight: 600, align: 'center', color: '#122048',
      });
    });
  }
}

/* --------------------------- 退出口令门（ExitGate） ---------------------------
 *
 * 施测中途要退出时挡在前面的一页（2026-08-19 用户拍板）。要解决的场景很具体：
 * **施测者中途离开，孩子一个人在机器前**，按 Esc 或点返回就能把整场测评作废 ——
 * 行为试次与脑电快照全在浏览器内存里，`metrics.reset()` 一清就没了。
 *
 * ⚠️ **这一页不是安全设施，是流程设施。** 口令明文放在服务端（见 serve.mjs 的
 * ADMIN_PASSWORD），会看源码的人一眼就能拿到，那不在威胁模型里。
 *
 * ☠️ **必须留一条给孩子的出路。** 孩子真的不舒服想停下来时，如果这一页只写着
 * "输口令才能退出"，他能做的就只剩乱按乱点。所以底下那句"可以先摘下设备休息"
 * 不是客套话，是这一页唯一对孩子说的话 —— 别删。
 *
 * 输入用物理键盘（桌面专属，同「开始前确认」页的年份输入）：真实采集只在桌面端做，
 * VR 只剩演示门面、判据天然不成立，所以这里不做 VR 的等价物。
 */
export class ExitGatePanel extends Panel {
  constructor() {
    super({ width: 1.72, height: 1.02, res: 620 });
    this.info = { len: 0, error: '', checking: false };
    this._sig = '';
    this.buttons = [{
      id: 'gate-cancel', kind: 'primary', label: '继续测评', sub: 'Esc',
      size: 30, x: (this.w - 380) / 2, y: this.h - 122, w: 380, h: 86,
    }];
  }

  setInfo(info) {
    Object.assign(this.info, info);
    const sig = `${this.info.len}|${this.info.error}|${this.info.checking}`;
    if (sig === this._sig) return;
    this._sig = sig;
    this.markDirty();
  }

  render() {
    const ctx = this.ctx, { w, h } = this;
    const i = this.info;
    UIKit.panelBg(ctx, w, h, { glow: COLORS.gold });

    UIKit.text(ctx, '需要老师确认', w / 2, 76, {
      size: 44, weight: 800, align: 'center', color: COLORS.ink, glow: 'rgba(255,201,77,0.6)',
    });
    UIKit.text(ctx, '测评正在进行中，退出会让这一场的数据作废', w / 2, 126, {
      size: 22, align: 'center', color: COLORS.inkDim,
    });

    // 输入框。**只画圆点不画字符** —— 孩子就在旁边看着施测者敲
    const bx = w / 2 - 250, by = 178;
    UIKit.roundRect(ctx, bx, by, 500, 78, 18);
    ctx.fillStyle = 'rgba(8,11,30,0.72)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = i.error ? 'rgba(226,96,106,0.75)' : 'rgba(140,178,255,0.4)';
    ctx.stroke();

    const dots = '●'.repeat(Math.min(i.len, 24));
    UIKit.text(ctx, i.len ? `${dots}|` : '请老师输入口令后回车', w / 2, by + 40, {
      size: i.len ? 26 : 23, align: 'center',
      color: i.len ? COLORS.cyan : COLORS.inkDim,
    });

    // 状态行固定占一行高度，有没有内容都不让下面的版面跳动
    const msg = i.checking ? '正在核对…' : (i.error || '');
    if (msg) {
      UIKit.text(ctx, msg, w / 2, by + 116, {
        size: 24, weight: 700, align: 'center',
        color: i.checking ? COLORS.cyan : COLORS.coral,
      });
    }

    // ☠️ 给孩子的出路，别删（见文件头注释）
    UIKit.text(ctx, '如果不舒服，可以先摘下设备休息一下，等老师回来', w / 2, by + 176, {
      size: 23, align: 'center', color: COLORS.gold,
    });

    for (const b of this.buttons) UIKit.button(ctx, b, { hovered: this.hovered === b.id });
  }
}
