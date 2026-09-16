import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/**
 * 世界空间 UI 面板。
 *
 * 一个刻意的架构决定：整个 Demo 不用任何 DOM 界面来承载游戏 UI，
 * 全部是画在 Canvas 上、贴到 3D 面板上的世界空间 UI。
 * 原因很简单 —— DOM 覆盖层在 WebXR 沉浸式会话里根本不存在。
 * 想让"电脑端"和"头显端"共用一份界面代码，就只能把 UI 做进 3D 场景。
 *
 * 命中检测走射线 → 面片 UV → Canvas 像素坐标，
 * 于是鼠标和 VR 手柄射线走的是同一条命中路径。
 */

export const FONT = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif';

export const COLORS = {
  ink: '#eaf2ff',
  inkDim: '#9db0d8',
  cyan: '#4de2ff',
  gold: '#ffc94d',
  mint: '#6bffb0',
  coral: '#ff5c6c',
  violet: '#b08cff',
  panel0: 'rgba(16,22,56,0.92)',
  panel1: 'rgba(10,13,36,0.95)',
};

/**
 * 规则图标的配色。和 `UIKit.icon` 放在一起，是因为**颜色是这套图形词汇的一部分**：
 * 红 = 别碰、青 = 可以点、金 = 看这里、绿 = 对了，这四条在关卡里本来就成立
 * （红陨石 / 蓝水晶 / 金色显形门 / 薄荷色正反馈）。演示面板和世界空间的提示精灵
 * 共用这一份 —— 分成两份的话，同一个禁止符在两处颜色不同，规则就不成立了。
 */
export const ICON_COLORS = {
  tap: '#7ff0ff',
  stop: '#ff7a88',
  eye: '#ffd36e',
  check: '#6bffb0',
};

/* --------------------------- Canvas 绘制工具 --------------------------- */
export const UIKit = {
  roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  },

  panelBg(ctx, w, h, { radius = 46, glow = COLORS.cyan, alpha = 1 } = {}) {
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.globalAlpha = alpha;
    const g = ctx.createLinearGradient(0, 0, w * 0.35, h);
    g.addColorStop(0, 'rgba(34,45,104,0.94)');
    g.addColorStop(0.55, 'rgba(16,21,58,0.95)');
    g.addColorStop(1, 'rgba(9,12,32,0.96)');
    UIKit.roundRect(ctx, 6, 6, w - 12, h - 12, radius);
    ctx.fillStyle = g;
    ctx.fill();

    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(140,178,255,0.34)';
    ctx.stroke();

    // 顶部高光边，让面板有玻璃感
    ctx.save();
    ctx.clip();
    const hi = ctx.createLinearGradient(0, 0, 0, h * 0.32);
    hi.addColorStop(0, 'rgba(255,255,255,0.13)');
    hi.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hi;
    ctx.fillRect(0, 0, w, h * 0.32);
    ctx.restore();

    // 四角装饰角标
    ctx.strokeStyle = glow;
    ctx.globalAlpha = alpha * 0.75;
    ctx.lineWidth = 4;
    const L = 34, m = 22;
    [[m, m, 1, 1], [w - m, m, -1, 1], [m, h - m, 1, -1], [w - m, h - m, -1, -1]]
      .forEach(([x, y, sx, sy]) => {
        ctx.beginPath();
        ctx.moveTo(x + L * sx, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + L * sy);
        ctx.stroke();
      });
    ctx.restore();
  },

  text(ctx, str, x, y, {
    size = 34, weight = 500, color = COLORS.ink, align = 'left', baseline = 'middle',
    glow = null, maxWidth = null, lineHeight = null, family = FONT,
  } = {}) {
    ctx.save();
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillStyle = color;
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = size * 0.5; }
    if (maxWidth && lineHeight) {
      const lines = UIKit.wrap(ctx, str, maxWidth);
      lines.forEach((ln, i) => ctx.fillText(ln, x, y + i * lineHeight));
      ctx.restore();
      return lines.length;
    }
    ctx.fillText(str, x, y);
    ctx.restore();
    return 1;
  },

  /** 中文按字符断行（中文没有空格，按词断行不适用）。 */
  wrap(ctx, str, maxWidth) {
    const lines = [];
    let cur = '';
    for (const ch of str) {
      if (ch === '\n') { lines.push(cur); cur = ''; continue; }
      const next = cur + ch;
      if (ctx.measureText(next).width > maxWidth && cur) { lines.push(cur); cur = ch; }
      else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  },

  button(ctx, b, { hovered = false, pressed = false } = {}) {
    const { x, y, w, h, label, sub, kind = 'primary', disabled = false } = b;
    ctx.save();
    const r = h / 2.6;
    const offset = pressed ? 2 : 0;
    UIKit.roundRect(ctx, x, y + offset, w, h, r);

    let fill;
    if (disabled) {
      fill = 'rgba(90,104,150,0.28)';
    } else if (kind === 'primary') {
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, hovered ? '#9df3ff' : '#6fe0ff');
      g.addColorStop(0.55, hovered ? '#49b8ff' : '#2f9dff');
      g.addColorStop(1, hovered ? '#6c7bff' : '#4a5cf0');
      fill = g;
    } else if (kind === 'gold') {
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, hovered ? '#ffe6a3' : '#ffd475');
      g.addColorStop(1, hovered ? '#ffab3d' : '#f79420');
      fill = g;
    } else {
      fill = hovered ? 'rgba(120,150,255,0.30)' : 'rgba(120,150,255,0.13)';
    }
    ctx.fillStyle = fill;
    if (hovered && !disabled) {
      ctx.shadowColor = kind === 'gold' ? 'rgba(255,190,80,0.6)' : 'rgba(90,190,255,0.6)';
      ctx.shadowBlur = 28;
    }
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = disabled ? 'rgba(160,180,220,0.18)'
      : kind === 'ghost' ? 'rgba(150,185,255,0.5)' : 'rgba(255,255,255,0.35)';
    ctx.stroke();

    const labelColor = disabled ? 'rgba(200,214,240,0.4)'
      : (kind === 'primary' || kind === 'gold') ? '#08132b' : COLORS.ink;
    const cy = y + h / 2 + offset - (sub ? 12 : 0);
    UIKit.text(ctx, label, x + w / 2, cy, {
      size: b.size || 34, weight: 700, color: labelColor, align: 'center',
    });
    if (sub) {
      UIKit.text(ctx, sub, x + w / 2, cy + 34, {
        size: 20, weight: 500, align: 'center',
        color: (kind === 'primary' || kind === 'gold') ? 'rgba(8,19,43,0.66)' : COLORS.inkDim,
      });
    }
    ctx.restore();
  },

  bar(ctx, x, y, w, h, value, { color = COLORS.cyan, bg = 'rgba(255,255,255,0.09)', radius = null } = {}) {
    const r = radius ?? h / 2;
    UIKit.roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = bg;
    ctx.fill();
    const vw = Math.max(0, Math.min(1, value)) * w;
    if (vw > 1) {
      ctx.save();
      UIKit.roundRect(ctx, x, y, w, h, r);
      ctx.clip();
      const g = ctx.createLinearGradient(x, y, x + w, y);
      g.addColorStop(0, color);
      g.addColorStop(1, '#ffffff');
      ctx.fillStyle = g;
      ctx.globalAlpha = 0.92;
      UIKit.roundRect(ctx, x, y, vw, h, r);
      ctx.fill();
      ctx.restore();
    }
  },

  /**
   * 规则图标 —— 给**不认字的孩子**用的图形词汇（关卡演示 `core/Demo.js` 靠它说话）。
   *
   * 四个符号刻意都选了不依赖文化背景、也不依赖识字的画法：
   *   tap   点一下      实心点 + 两圈波纹（"这里可以按"）
   *   stop  别碰 / 忍住 圆圈加斜杠（通用禁止符，不用手掌 —— 手掌在不同文化里含义不一）
   *   eye   看好        杏仁眼 + 瞳孔
   *   check 做对了      对勾
   *
   * 同一份实现被两处用：演示面板直接画在自己的画布上，世界空间的提示精灵把它画到
   * 一张离屏 canvas 上转成贴图。**别再另写一份** —— 两份图标迟早长得不一样，
   * 而"面板上的禁止符"和"空中的禁止符"不是同一个东西时，孩子学到的规则就是错的。
   */
  icon(ctx, kind, cx, cy, r, color = COLORS.ink) {
    const TAU = Math.PI * 2;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(3, r * 0.16);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = r * 0.45;
    if (kind === 'tap') {
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.28, 0, TAU); ctx.fill();
      [0.58, 0.92].forEach((k, i) => {
        ctx.globalAlpha = 0.85 - i * 0.35;
        ctx.beginPath(); ctx.arc(cx, cy, r * k, 0, TAU); ctx.stroke();
      });
    } else if (kind === 'stop') {
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.84, 0, TAU); ctx.stroke();
      const d = r * 0.59;
      ctx.beginPath(); ctx.moveTo(cx - d, cy + d); ctx.lineTo(cx + d, cy - d); ctx.stroke();
    } else if (kind === 'eye') {
      ctx.beginPath();
      ctx.moveTo(cx - r, cy);
      ctx.quadraticCurveTo(cx, cy - r * 0.88, cx + r, cy);
      ctx.quadraticCurveTo(cx, cy + r * 0.88, cx - r, cy);
      ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.3, 0, TAU); ctx.fill();
    } else {
      ctx.lineWidth = r * 0.24;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.64, cy + r * 0.04);
      ctx.lineTo(cx - r * 0.16, cy + r * 0.52);
      ctx.lineTo(cx + r * 0.66, cy - r * 0.52);
      ctx.stroke();
    }
    ctx.restore();
  },

  star(ctx, cx, cy, r, filled, color = COLORS.gold) {
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 ? r * 0.45 : r;
      const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
      const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    if (filled) {
      ctx.shadowColor = color; ctx.shadowBlur = r * 0.8;
      ctx.fillStyle = color; ctx.fill();
    } else {
      ctx.lineWidth = r * 0.14;
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.stroke();
    }
    ctx.restore();
  },

  /** 折线图：报告页用来画警觉度曲线和专注度曲线。 */
  lineChart(ctx, x, y, w, h, series, {
    color = COLORS.cyan, fill = true, min = 0, max = 1, grid = 4, dots = true,
  } = {}) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= grid; i++) {
      const gy = y + (h * i) / grid;
      ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); ctx.stroke();
    }
    if (!series || series.length < 2) { ctx.restore(); return; }

    const pt = (i) => {
      const v = (series[i] - min) / (max - min || 1);
      return [x + (w * i) / (series.length - 1), y + h - Math.max(0, Math.min(1, v)) * h];
    };

    if (fill) {
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      for (let i = 0; i < series.length; i++) ctx.lineTo(...pt(i));
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, color.replace(')', ',0.35)').replace('rgb', 'rgba').replace('#', '#'));
      ctx.fillStyle = typeof color === 'string' && color.startsWith('#')
        ? UIKit.hexA(color, 0.22) : 'rgba(80,200,255,0.22)';
      ctx.fill();
    }

    ctx.beginPath();
    for (let i = 0; i < series.length; i++) {
      const [px, py] = pt(i);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.shadowColor = color; ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (dots) {
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < series.length; i++) {
        const [px, py] = pt(i);
        ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  },

  hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  },
};

/* ------------------------------ 面板基类 ------------------------------ */

let _panelId = 0;

export class Panel extends THREE.Group {
  /**
   * @param {object} opt
   *   width/height  世界尺寸（米）
   *   res           每米像素数，决定文字清晰度
   *   backing       是否加一块实体背板（VR 里给面板"厚度"）
   *   mipmaps       是否生成 mipmap 链（默认开，见下方纹理过滤的说明）
   */
  constructor({ width = 1.6, height = 1.0, res = 700, backing = true, mipmaps = true } = {}) {
    super();
    this.name = `panel-${_panelId++}`;
    this.wWorld = width;
    this.hWorld = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * res);
    this.canvas.height = Math.round(height * res);
    this.ctx = this.canvas.getContext('2d');
    this.w = this.canvas.width;
    this.h = this.canvas.height;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    /*
     * 纹理过滤：mipmap 必须开，否则上面那行 anisotropy 是**一句空话** ——
     * 各向异性过滤是在 mipmap 链上做的，没有链就退化成普通双线性。
     *
     * 原来这里是 generateMipmaps:false + LinearFilter，后果是面板一旦被斜看
     * 或缩小（VR 里转个头就会发生）就欠采样，边缘毛刺、文字闪烁 ——
     * 2026-08-06 在 Pico 4 上实测到的锯齿，UI 面板这部分就是这么来的。
     *
     * 代价可以接受：坑 #9 的 markDirty 机制保证面板只在内容真变了时才重绘，
     * 不是每帧生成 mipmap。每帧重绘的 HudPanel 例外，它自己传 mipmaps:false。
     */
    this.texture.anisotropy = 8;
    this.texture.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    this.texture.generateMipmaps = mipmaps;

    if (backing) {
      const back = new THREE.Mesh(
        new RoundedBoxGeometry(width * 1.015, height * 1.02, 0.035, 4, 0.03),
        new THREE.MeshPhysicalMaterial({
          color: 0x0a0e26, metalness: 0.45, roughness: 0.28,
          clearcoat: 1, clearcoatRoughness: 0.2, envMapIntensity: 1.1,
        }),
      );
      back.position.z = -0.024;
      this.add(back);
      this.backing = back;
    }

    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        map: this.texture, transparent: true, depthWrite: false, toneMapped: false,
      }),
    );
    this.plane.userData.panel = this;
    this.add(this.plane);

    this.buttons = [];
    this.hovered = null;
    this.dirty = true;
    this.enabled = true;
  }

  /** 子类重写：把界面画到 this.ctx 上。 */
  render() {}

  markDirty() { this.dirty = true; }

  refresh() {
    if (!this.dirty) return;
    this.dirty = false;
    this.render();
    this.texture.needsUpdate = true;
  }

  /** UV → Canvas 像素 → 命中按钮。 */
  buttonAt(uv) {
    const px = uv.x * this.w;
    const py = (1 - uv.y) * this.h;
    for (const b of this.buttons) {
      if (b.hidden || b.disabled) continue;
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b;
    }
    return null;
  }

  setHover(button) {
    const id = button?.id ?? null;
    if (id === this.hovered) return false;
    this.hovered = id;
    this.markDirty();
    return true;
  }

  clearHover() { return this.setHover(null); }

  /** 面板朝向玩家（懒跟随：转头超过阈值才平滑跟过去，避免 UI 黏在脸上）。 */
  faceCamera(camera, { lerp = 0.12, threshold = 0.25, keepDistance = null } = {}) {
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    const dir = new THREE.Vector3().subVectors(camPos, this.position);
    dir.y = 0;
    if (dir.lengthSq() < 1e-4) return;
    dir.normalize();
    const targetYaw = Math.atan2(dir.x, dir.z);
    let delta = targetYaw - this.rotation.y;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    if (Math.abs(delta) > threshold) this.rotation.y += delta * lerp;
    if (keepDistance) {
      const want = new THREE.Vector3(
        camPos.x - dir.x * keepDistance, this.position.y, camPos.z - dir.z * keepDistance,
      );
      this.position.lerp(want, lerp * 0.5);
    }
  }

  show(v = true) { this.visible = v; this.enabled = v; if (v) this.markDirty(); }
  hide() { this.show(false); }

  dispose() {
    this.texture.dispose();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
  }
}
