import * as THREE from 'three';
import { MiniGame } from './MiniGame.js';

/**
 * 双模态 N-back。
 *
 * 两条刺激流彼此独立：视觉流是空间位置，听觉流是字母名；每一条都只在「当前
 * 项与 n 项前相同」时算目标。这样没有把「看见后再记住」偷换成单纯的反应
 * 任务，也不会让任一模态替另一模态给出答案。
 *
 * 这是自适应体验/训练入口，而不是有常模的诊断量表。所有比较必须保留同一
 * protocol、同一版本和相近的环境；原始试次仍以标准 go/nogo 语义留档。
 */

export const NBACK_STAGE = Object.freeze({
  positions: Object.freeze([
    [-1.32, 1.54, -4.85], [-0.54, 2.04, -4.85], [0.54, 2.04, -4.85],
    [1.32, 1.54, -4.85], [-0.78, 1.08, -4.85], [0.78, 1.08, -4.85],
  ]),
  visualColor: 0x4e7fc2,
  stimulusColor: 0xff9f59,
  audioColor: 0xffc767,
  visualPadX: -1.45,
  bothPadX: 0,
  auditoryPadX: 1.45,
  guidedPadX: 0,
  padY: 0.48,
  padZ: -3.0,
});

// 相邻音至少相隔一个纯四/五度。比连续音阶更容易在普通笔记本扬声器上分辨，
// 同时仍是固定、可复现的纯音刺激，而不是带语言含义的提示音。
export const NBACK_AUDIO_FREQS = Object.freeze([261.63, 392, 587.33, 783.99, 1046.5, 1318.51]);
// 避开 B/D、M/N、E/T 等儿童容易混听的字母对；各项的起始音和韵母都拉开。
export const NBACK_AUDIO_LABELS = Object.freeze(['A', 'K', 'O', 'U', 'W', 'Z']);
export const NBACK_PROTOCOL = Object.freeze({
  version: 8,
  paradigm: 'dual-nback',
  task: 'guided 0-back visual target, then visual-spatial + auditory-letter N-back',
  startN: 0,
  minN: 0,
  maxN: 3,
  blocks: 4,
  guidedTrials: 6,
  scoredTrialsPerBlock: 12,
  soaMs: 4000,
  stimulusMs: 1100,
  auditoryStimulusMs: 520,
  targetRate: 0.3,
  zeroTargetVisual: 0,
  auditoryFrequenciesHz: NBACK_AUDIO_FREQS,
  auditoryLabels: NBACK_AUDIO_LABELS,
  responseControls: 'visual pad, auditory pad, and combined pad; combined pad records both modality responses at one timestamp',
  adaptation: 'a short 0-back tutorial is followed by explicit player choice of fixed 1-back, 2-back, or 3-back; the selected difficulty is retained for the remaining blocks',
  scoring: 'each non-anticipatory target hit collects one stardust; warmup and correct rejection give no reward',
  warmup: 'first n items of each block are scored:false',
  comparability: 'sessions are comparable only within the same selected difficulty and protocol; not normative diagnosis',
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mix = (a, b, t) => a + (b - a) * t;

export class DualNBack extends MiniGame {
  static meta = {
    id: 'nback',
    name: '双模态星忆',
    skill: '工作记忆 · 渐进训练',
    blurb: '收集星尘：认识星球 → 记住星位和字母',
    color: '#65dfff',
    duration: 245,
    protocol: NBACK_PROTOCOL,
    howto: [
      ['1', '先认识能量星球：看见金色标记的星球，就按按钮'],
      ['2', '熟悉后，记住刚才的星位；一样才按左边'],
      ['3', '最后加上字母声音：位置、字母都一样时按中间'],
    ],
    briefNote: '先从认识能量星球开始。连续答对会收集星尘；卡住时会自动放慢难度。',
    donePraise: '星海任务完成！收集到的星尘和训练记录已经保存。',
  };

  constructor(ctx) {
    super(ctx);
    this.n = NBACK_PROTOCOL.startN;
    this.block = 0;
    this.index = -1;
    this.phaseT = 0;
    this.stimulusAt = 0;
    this.visual = [];
    this.audio = [];
    this.current = null;
    this.responses = { visual: null, auditory: null };
    this.blockLog = [];
    this.levelHistory = [{ block: 0, n: this.n, reason: 'start' }];
    this.breakT = 0;
    this.blockComplete = false;
    this.targetCount = 0;
    this.targetHits = 0;
    this.energy = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.consecutiveMisses = 0;
    this.blockNeedsSupport = false;
    this.selectingLevel = false;
    this.selectedLevel = null;
    this.zeroTargetVisual = NBACK_PROTOCOL.zeroTargetVisual;
    this.feedback = '';
    this.textures = [];
  }

  get difficultyLabel() { return this.n === 0 ? '新手训练' : `和前面第 ${this.n} 次比`; }
  get recentAccuracy() { return this.targetCount ? this.targetHits / this.targetCount : 0; }

  enter() {
    super.enter();
    this._buildStage();
    this._beginBlock();
  }

  _buildStage() {
    const S = NBACK_STAGE;
    this.stars = S.positions.map((pos, i) => {
      const group = new THREE.Group();
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.35, 30), new THREE.MeshBasicMaterial({
        color: S.visualColor, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false, toneMapped: false,
      }));
      const core = new THREE.Mesh(new THREE.CircleGeometry(0.16, 28), new THREE.MeshBasicMaterial({
        color: S.visualColor, transparent: true, opacity: 0.28, depthWrite: false, depthTest: false, toneMapped: false,
      }));
      // 任务刺激必须压过纯装饰的浮岛/水晶；否则被挡住的 trial 没有可解释性。
      group.position.set(...pos); group.renderOrder = 10;
      halo.renderOrder = 10; core.renderOrder = 10;
      group.add(halo, core);
      group.userData = { index: i, halo, core, glow: 0 };
      this.root.add(group);
      return group;
    });

    this.pads = [
      this._makePad('visual', S.visualPadX, S.visualColor),
      this._makePad('both', S.bothPadX, 0xb98cff),
      this._makePad('auditory', S.auditoryPadX, S.audioColor),
    ];
    this.hitboxes = this.pads.map((p) => p.userData.hitbox);
    this.instruction = this._label(3.8, .5, [0, 2.68, -5.8]);
    this.controlLabels = [
      this._label(1.16, .22, [S.visualPadX, .10, S.padZ], ['位置一样 → 左边']),
      this._label(1.16, .22, [S.bothPadX, .10, S.padZ], ['两个都一样 → 中间']),
      this._label(1.16, .22, [S.auditoryPadX, .10, S.padZ], ['字母一样 → 右边']),
    ];
    this.feedbackLabel = this._label(2.8, .22, [0, 1.08, -2.65]);

    // 一个很淡的中心注视点，帮助孩子稳定看向刺激区，不做动画、不抢任务线索。
    const fix = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.065, 18), new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false,
    }));
    fix.position.set(0, 1.63, -4.87); this.root.add(fix);
    const marker = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.42, 30), new THREE.MeshBasicMaterial({
      color: 0xffd36d, transparent: true, opacity: 0.88, depthWrite: false, toneMapped: false,
    }));
    marker.position.set(...S.positions[this.zeroTargetVisual]);
    this.root.add(marker); this.zeroTargetMarker = marker;
  }

  _label(w, h, pos, lines = []) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * 350); canvas.height = Math.round(h * 350);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
    mesh.position.set(...pos); this.root.add(mesh); this.textures.push(texture);
    const label = { canvas, texture, mesh, signature: null };
    this._writeLabel(label, lines);
    return label;
  }

  _writeLabel(label, lines) {
    const signature = lines.join('|');
    if (label.signature === signature) return;
    label.signature = signature;
    const c = label.canvas, ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(10,18,42,.94)'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    lines.forEach((line, i) => {
      ctx.font = `700 ${lines.length > 1 ? 38 : 30}px "Microsoft YaHei",sans-serif`;
      ctx.fillStyle = i === 0 ? '#ffdf96' : '#eaf2ff';
      ctx.fillText(line, c.width / 2, c.height * (i + .5) / lines.length);
    });
    label.texture.needsUpdate = true;
  }

  _refreshInstructions() {
    let lines;
    if (this.selectingLevel) {
      lines = ['新手训练完成！选择下一段记忆任务', '从 1-back 开始；熟悉规则后可挑战 2-back 或 3-back'];
    } else if (this.blockComplete) {
      lines = [`任务 ${this.block + 1} 完成 · 能量 ${this.energy}`, this.block + 1 < NBACK_PROTOCOL.blocks ? '飞船正在准备下一段任务…' : '星海任务全部完成！'];
    } else if (this.n === 0) {
      lines = ['新手训练 · 认识能量星球', '看见金色圈住的星球，就按下方按钮'];
    } else if (!this.current || this.current.warmup) {
      lines = [`${this.n === 1 ? '星尘记忆' : '星际记忆'} · 先记 ${Math.max(1, this.index + 1)} 次`, `先不按 · 从第 ${this.n + 1} 次开始和前面比`];
    } else {
      lines = [`任务 ${this.block + 1}/${NBACK_PROTOCOL.blocks} · 星尘 ${this.energy}`, `和前面第 ${this.n} 次比：一样才按，不一样不按`];
    }
    this._writeLabel(this.instruction, lines);
    this._writeLabel(this.feedbackLabel, [this.feedback || (this.n === 0 ? '找到金色能量星球，帮飞船充能！' : '左边看星位 · 右边听字母 · 两个都一样按中间')]);
  }

  hudState() {
    return { ...super.hudState(), mode: 'nback', streak: this.combo,
      score: this.energy, accuracy: this.targetCount ? this.targetHits / this.targetCount : null };
  }

  exit() {
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
    super.exit();
  }

  _makePad(modality, x, color) {
    const g = new THREE.Group();
    g.position.set(x, NBACK_STAGE.padY, NBACK_STAGE.padZ);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.37, 32), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.54, depthWrite: false, toneMapped: false,
    }));
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.255, 32), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.16, depthWrite: false, toneMapped: false,
    }));
    g.add(face, ring);
    // 无文字图形：左是眼形（视觉），右是三道同心声波（听觉）。
    if (modality === 'visual') {
      const eye = new THREE.Mesh(new THREE.RingGeometry(0.065, 0.12, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 }));
      eye.scale.y = 0.62; g.add(eye);
    } else if (modality === 'auditory') {
      [0.05, 0.12, 0.19].forEach((r) => g.add(new THREE.Mesh(
        new THREE.RingGeometry(r, r + 0.018, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
      )));
    } else {
      const eye = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.09, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 }));
      eye.scale.y = 0.62; eye.position.x = -0.07; g.add(eye);
      [0.045, 0.095].forEach((r) => {
        const wave = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.014, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }));
        wave.position.x = 0.08; g.add(wave);
      });
    }
    const hb = this.makeHitbox(g, { radius: 0.5 }); hb.position.z = 0.03; g.add(hb);
    g.userData = { modality, color, ring, face, hitbox: hb, flash: 0, hover: 0 };
    this.root.add(g);
    return g;
  }

  _beginBlock() {
    this.index = -1; this.visual.length = 0; this.audio.length = 0;
    this.current = null; this.phaseT = NBACK_PROTOCOL.soaMs / 1000;
    this.blockStart = this.elapsed; this.blockComplete = false;
    this.ctx.onEvent?.({ type: 'nback-block', index: this.block, n: this.n });
    this.blockNeedsSupport = false;
    this.consecutiveMisses = 0;
    this._setControlsForLevel();
    this.feedback = '';
    this._refreshInstructions();
  }

  /** 0-back 只留一个大按钮，先把规则学会再引入双模态按键。 */
  _setControlsForLevel() {
    const guided = this.n === 0;
    if (this.selectingLevel) {
      this.zeroTargetMarker.visible = false;
      this.pads.forEach((pad, i) => {
        pad.visible = true;
        pad.position.x = [NBACK_STAGE.visualPadX, NBACK_STAGE.bothPadX, NBACK_STAGE.auditoryPadX][i];
        this.controlLabels[i].mesh.visible = true;
        this._writeLabel(this.controlLabels[i], [`${i + 1}-back`, i === 0 ? '从这里开始' : i === 1 ? '记住前 2 次' : '记住前 3 次']);
      });
      return;
    }
    this.zeroTargetMarker.visible = guided;
    this.pads.forEach((pad, i) => {
      const visible = !guided || i === 0;
      pad.visible = visible;
      if (i === 0) pad.position.x = guided ? NBACK_STAGE.guidedPadX : NBACK_STAGE.visualPadX;
      this.controlLabels[i].mesh.visible = !guided;
    });
    if (!guided) {
      this._writeLabel(this.controlLabels[0], ['位置一样 → 左边']);
      this._writeLabel(this.controlLabels[1], ['两个都一样 → 中间']);
      this._writeLabel(this.controlLabels[2], ['字母一样 → 右边']);
    }
  }

  _nextValue(stream, target) {
    if (this.n === 0) {
      if (target) return this.zeroTargetVisual;
      let value;
      do { value = Math.floor(Math.random() * NBACK_STAGE.positions.length); } while (value === this.zeroTargetVisual);
      return value;
    }
    const compare = stream.length >= this.n ? stream[stream.length - this.n] : null;
    if (target && compare != null) return compare;
    let value;
    do { value = Math.floor(Math.random() * NBACK_STAGE.positions.length); } while (compare != null && value === compare);
    return value;
  }

  _nextTrial() {
    this.index++;
    if (this.n === 0) {
      // 每次教学题都换一个金色目标，孩子要看清“金圈”而非只记住固定位置。
      this.zeroTargetVisual = (this.zeroTargetVisual + 1 + Math.floor(Math.random() * (NBACK_STAGE.positions.length - 1))) % NBACK_STAGE.positions.length;
      this.zeroTargetMarker.position.set(...NBACK_STAGE.positions[this.zeroTargetVisual]);
    }
    const warmup = this.n > 0 && this.index < this.n;
    const visualTarget = !warmup && Math.random() < NBACK_PROTOCOL.targetRate;
    const auditoryTarget = this.n > 0 && !warmup && Math.random() < NBACK_PROTOCOL.targetRate;
    const visualValue = this._nextValue(this.visual, visualTarget);
    const audioValue = this._nextValue(this.audio, auditoryTarget);
    this.visual.push(visualValue); this.audio.push(audioValue);
    this.current = { warmup, visualValue, audioValue, visualTarget, auditoryTarget, index: this.index, n: this.n };
    this.current.stimulusAt = performance.now() - this.ctx.metrics.startedAt;
    this.responses = { visual: null, auditory: null };
    this.phaseT = 0; this.stimulusAt = this.elapsed;
    this.feedback = '';
    this.stars.forEach((s) => { s.userData.glow = 0; this._paintStar(s); });
    this.stars[visualValue].userData.glow = 1;
    this._paintStar(this.stars[visualValue]);
    if (this.n > 0) this._playLetter(audioValue);
    this._refreshInstructions();
    this.ctx._mark?.('nback-stimulus', {
      game: this.meta.id,
      detail: { block: this.block, index: this.index, n: this.n, difficulty: this.n, visualTarget, auditoryTarget, warmup },
    });
  }

  _playLetter(index) {
    // 字母本身是听觉刺激；索引与回退音高都留在协议里，确保可复现、可导出。
    this.ctx.audio.nbackLetter(NBACK_AUDIO_LABELS[index], NBACK_AUDIO_FREQS[index], NBACK_PROTOCOL.auditoryStimulusMs / 1000);
  }

  _respond(modality) {
    if (!this.current || this.current.warmup || this.blockComplete || this.responses[modality]
      || this.elapsed - this.stimulusAt >= NBACK_PROTOCOL.soaMs / 1000) return;
    const target = modality === 'visual' ? this.current.visualTarget : this.current.auditoryTarget;
    const rt = (this.elapsed - this.stimulusAt) * 1000;
    this.responses[modality] = { rt, target, method: 'single' };
    const pad = this.pads.find((p) => p.userData.modality === modality);
    const hit = target && rt >= 150;
    pad.userData.flash = hit ? 1 : -0.65;
    if (hit) this.score += 10;
    if (hit) this._celebrateStardust(1);
    // 纯视觉反馈，避免奖励音混进正在记忆的听觉刺激流。
    this.feedback = rt < 150 ? '慢一点，看清楚再出发' : hit ? '太棒啦！收集到星尘 ✨' : '差一点，再看看下一颗星球';
    this._refreshInstructions();
  }

  /**
   * 鼠标不能像双手一样真正同时点击两个相距较远的圆钮。中间圆钮是一个
   * “两个都一样”的单次回答：它给两条流写入同一个反应时，仍逐模态计分，
   * 因而不会把双目标偷换成第三种目标，也不会丢掉漏报/虚报的可分析性。
   */
  _respondBoth() {
    if (!this.current || this.current.warmup || this.blockComplete
      || (this.responses.visual && this.responses.auditory)
      || this.elapsed - this.stimulusAt >= NBACK_PROTOCOL.soaMs / 1000) return;
    const rt = (this.elapsed - this.stimulusAt) * 1000;
    let added = 0;
    for (const modality of ['visual', 'auditory']) {
      if (this.responses[modality]) continue;
      const target = modality === 'visual' ? this.current.visualTarget : this.current.auditoryTarget;
      this.responses[modality] = { rt, target, method: 'combined' };
      const pad = this.pads.find((p) => p.userData.modality === modality);
      const hit = target && rt >= 150;
      pad.userData.flash = hit ? 1 : -0.65;
      if (hit) { this.score += 10; added++; }
    }
    const bothPad = this.pads.find((p) => p.userData.modality === 'both');
    const bothTarget = this.current.visualTarget && this.current.auditoryTarget;
    bothPad.userData.flash = bothTarget && rt >= 150 ? 1 : -0.65;
    if (added) this._celebrateStardust(added);
    this.feedback = rt < 150 ? '慢一点，看清、听清再出发' : bothTarget
      ? '太棒啦！双星尘已收集 ✨' : '差一点，两个都一样时再按中间';
    this._refreshInstructions();
  }

  _finishTrial() {
    const c = this.current;
    const activeModalities = this._activeModalities();
    let collected = 0;
    let trialMistake = false;
    for (const modality of activeModalities) {
      const target = modality === 'visual' ? c.visualTarget : c.auditoryTarget;
      const answer = this.responses[modality];
      const correct = target ? !!answer : !answer;
      const rt = answer?.rt ?? null;
      // 命中率只统计已结束的项目；刺激出现时改变分母会泄露“这次是目标”。
      if (!c.warmup && target && !(rt != null && rt < 150)) {
        this.targetCount++;
        if (answer) this.targetHits++;
      }
      // 直接记账，不让基类把热身与正确拒绝当成奖励连击/近期命中。
      this.ctx.metrics.addTrial({ game: this.meta.id,
        kind: target ? 'go' : 'nogo', paradigm: 'dual-nback', modality,
        block: this.block, trial: c.index, level: c.n, n: c.n, target,
        stimulus: modality === 'visual' ? c.visualValue : c.audioValue,
        comparedTo: this.n === 0 ? this.zeroTargetVisual : (modality === 'visual' ? this.visual[c.index - c.n] : this.audio[c.index - c.n]),
        warmup: c.warmup, scored: !c.warmup, responded: !!answer, responseMethod: answer?.method ?? null, correct: c.warmup ? null : correct,
        stimulusAt: c.stimulusAt,
        points: !c.warmup && target && answer && rt >= 150 ? 10 : 0,
        rt, anticipatory: rt != null && rt < 150,
      });
      this.ctx._mark?.('trial', { game: this.meta.id, detail: { modality, block: this.block, trial: c.index, warmup: c.warmup, correct: c.warmup ? null : correct, rt } });
      if (!c.warmup && target && answer && rt >= 150) collected++;
      if (!c.warmup && !correct) trialMistake = true;
    }
    if (collected) {
      this.energy += collected;
      this.combo++;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      this.consecutiveMisses = 0;
      this.feedback = this.combo >= 3 ? `连续 ${this.combo} 次！飞船能量上升 🚀` : '太棒啦！成功收集星尘 ✨';
      this.ctx.onEvent?.({ type: 'nback-stardust', energy: this.energy, combo: this.combo });
    } else if (trialMistake) {
      this.combo = 0;
      this.consecutiveMisses++;
      if (this.consecutiveMisses >= 3) {
        this.blockNeedsSupport = true;
        this.feedback = '我们回到简单一点的任务，再试一次';
        this.ctx.onEvent?.({ type: 'nback-support', n: this.n });
      } else this.feedback = '差一点，再试一次！';
    }
    this._refreshInstructions();
    const totalInBlock = this.n === 0 ? NBACK_PROTOCOL.guidedTrials : this.n + NBACK_PROTOCOL.scoredTrialsPerBlock;
    if (this.index + 1 >= totalInBlock) this._finishBlock();
    this.current = null;
  }

  _finishBlock() {
    const trials = this.ctx.metrics.trials.filter((t) => t.game === this.meta.id && t.block === this.block && t.scored !== false && !t.anticipatory);
    const accuracy = trials.length ? trials.filter((t) => t.correct).length / trials.length : 0;
    const rates = this._activeModalities().flatMap((modality) => {
      const list = trials.filter((t) => t.modality === modality);
      const targets = list.filter((t) => t.target), others = list.filter((t) => !t.target);
      return [targets.length ? targets.filter((t) => t.responded).length / targets.length : null,
        others.length ? others.filter((t) => !t.responded).length / others.length : null];
    });
    const adaptationScore = rates.includes(null) ? null : Math.min(...rates);
    const before = this.n;
    // 新手段只教规则；后续难度由儿童/老师明确选择，而不是由短段样本自动猜测。
    if (before === 0) {
      this.blockLog.push({ block: this.block, n: before, accuracy, adaptationScore, scored: trials.length,
        energy: this.energy, bestCombo: this.bestCombo, supportShown: this.blockNeedsSupport, nextN: null });
      this.levelHistory.push({ block: this.block + 1, n: null, reason: 'choose' });
      this.selectingLevel = true;
      this._setControlsForLevel();
      this._refreshInstructions();
      return;
    }
    this.blockLog.push({ block: this.block, n: before, accuracy, adaptationScore, scored: trials.length,
      energy: this.energy, bestCombo: this.bestCombo, supportShown: this.blockNeedsSupport, nextN: this.n });
    this.levelHistory.push({ block: this.block + 1, n: this.n, reason: 'selected' });
    this.blockComplete = true; this.breakT = 0;
    this.ctx.onEvent?.({ type: 'nback-block-end', index: this.block, n: before, nextN: this.n });
    this._refreshInstructions();
  }

  report() { return { protocol: NBACK_PROTOCOL, blockLog: this.blockLog.slice(), levelHistory: this.levelHistory.slice(),
    stardust: this.energy, bestCombo: this.bestCombo }; }

  _activeModalities() { return this.n === 0 ? ['visual'] : ['visual', 'auditory']; }

  _celebrateStardust(amount) {
    const star = this.stars[this.current?.visualValue] || this.stars[0];
    const position = star.position;
    // 与前三个小游戏相同的「爆粒子 + 光环 + 上浮文字 + 成功音」组合；
    // 持续时间很短，不持续干扰下一次刺激或 EEG 对齐。
    this.ctx.fx?.burst(position, { color: 0xffd36d, count: 24 + amount * 6, speed: 3.1, size: 0.56, ttl: 0.58 });
    this.ctx.fx?.ring(position, { color: 0xffe08a, from: 0.28, to: 1.9, ttl: 0.46 });
    this.ctx.fx?.floatText(position, `+${amount} 星尘`, { color: '#ffdf96', scale: 0.4, ttl: 1.05 });
    this.ctx.audio?.hit(this.combo + 1);
    this.ctx.input?.pulseAll(0.5, 38);
  }

  _chooseLevel(modality) {
    const next = modality === 'visual' ? 1 : modality === 'both' ? 2 : 3;
    this.n = next;
    this.selectedLevel = next;
    this.selectingLevel = false;
    this.block++;
    this.feedback = `已选择 ${next}-back，慢慢来，记住前面第 ${next} 次。`;
    this.ctx.onEvent?.({ type: 'nback-level-selected', n: next });
    this._beginBlock();
  }

  _paintStar(star) {
    const u = star.userData;
    const active = u.glow > 0;
    if (u.active !== active) {
      u.active = active;
      u.core.material.color.setHex(active ? NBACK_STAGE.stimulusColor : NBACK_STAGE.visualColor);
      u.halo.material.color.setHex(active ? NBACK_STAGE.stimulusColor : NBACK_STAGE.visualColor);
    }
    u.core.material.opacity = .18 + u.glow * .82;
    u.halo.material.opacity = .06 + u.glow * .86;
    star.scale.setScalar(1 + u.glow * .45);
  }

  update(dt) {
    if (this.finished) return;
    this.elapsed += dt;
    const { hovered, presses } = this.readPointers();
    for (const p of this.pads) {
      const u = p.userData; u.hover = mix(u.hover, hovered.has(p) ? 1 : 0, Math.min(1, dt * 12));
      u.flash = mix(u.flash, 0, Math.min(1, dt * 4.5));
      const good = Math.max(0, u.flash), bad = Math.max(0, -u.flash);
      u.ring.material.opacity = 0.48 + u.hover * .35 + good * .32;
      u.face.material.opacity = .13 + u.hover * .16 + good * .22 + bad * .10;
      p.scale.setScalar(1 + u.hover * .08 + good * .11);
    }
    for (const press of presses) {
      const modality = press.target?.userData?.modality;
      if (this.selectingLevel && modality) this._chooseLevel(modality);
      else if (modality === 'both') this._respondBoth();
      else if (modality) this._respond(modality);
    }
    for (const star of this.stars) {
      const u = star.userData;
      u.glow = this.current && u.index === this.current.visualValue && this.elapsed - this.stimulusAt < NBACK_PROTOCOL.stimulusMs / 1000 ? 1 : 0;
      this._paintStar(star);
    }

    if (this.selectingLevel) return;

    if (this.blockComplete) {
      this.breakT += dt;
      if (this.breakT > 1.7) {
        this.block++;
        if (this.block >= NBACK_PROTOCOL.blocks) { this.finished = true; return; }
        this._beginBlock();
      }
      return;
    }
    this.phaseT += dt;
    if (!this.current && this.phaseT >= NBACK_PROTOCOL.soaMs / 1000) this._nextTrial();
    else if (this.current && this.phaseT >= NBACK_PROTOCOL.soaMs / 1000) this._finishTrial();
    // 按完整段结束，帧舍入或暂停不能使最后几个试次被固定秒数截断。
  }
}
