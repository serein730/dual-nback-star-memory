import * as THREE from 'three';
import { sparkTexture, glowTexture } from './Assets.js';

/**
 * 特效层：粒子爆裂、扩散光环、飘字。
 *
 * 全部走对象池，运行期零 GC 压力 —— 头显上一次卡顿就是一次晕眩，
 * 而反馈特效恰恰是命中瞬间集中触发的，最容易踩到分配抖动。
 *
 * 反馈设计遵循一条原则：正确反馈要"大声"，错误反馈要"小声"。
 * 孩子应该为做对而兴奋，而不是为做错而紧张。
 */

const PARTICLE_VERT = /* glsl */`
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (260.0 / max(0.001, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAG = /* glsl */`
precision mediump float;
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
  if (gl_FragColor.a < 0.01) discard;
}
`;

const MAX_PARTICLES = 900;

export class FX {
  constructor(scene) {
    this.scene = scene;
    this._initParticles();
    this._initRings();
    this.texts = [];
    this._textCache = new Map();
    this._glow = glowTexture();
  }

  _initParticles() {
    const pos = new Float32Array(MAX_PARTICLES * 3);
    const col = new Float32Array(MAX_PARTICLES * 3);
    const size = new Float32Array(MAX_PARTICLES);
    const alpha = new Float32Array(MAX_PARTICLES);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);

    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: sparkTexture(96) } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    this.particles = Array.from({ length: MAX_PARTICLES }, () => ({
      life: 0, ttl: 1, vx: 0, vy: 0, vz: 0, drag: 0.94, gravity: 0, size: 1,
    }));
    this.pCount = 0;
  }

  _initRings() {
    this.rings = [];
    const geo = new THREE.RingGeometry(0.5, 0.56, 48);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false,
      }));
      m.visible = false;
      this.scene.add(m);
      this.rings.push({ mesh: m, life: 0, ttl: 1, from: 0.2, to: 2 });
    }
  }

  /** 粒子爆裂。正确用暖亮色、大量；错误用暗红、少量。 */
  burst(position, {
    color = 0x7fe4ff, count = 26, speed = 3.2, ttl = 0.8, size = 0.6, gravity = -2.6, spread = 1,
  } = {}) {
    const c = new THREE.Color(color);
    const geo = this.points.geometry;
    const pos = geo.attributes.position.array;
    const col = geo.attributes.aColor.array;
    const sz = geo.attributes.aSize.array;
    const al = geo.attributes.aAlpha.array;

    for (let i = 0; i < count; i++) {
      const idx = this.pCount % MAX_PARTICLES;
      this.pCount++;
      const p = this.particles[idx];
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const v = speed * (0.35 + Math.random() * 0.85);
      p.vx = Math.sin(phi) * Math.cos(theta) * v * spread;
      p.vy = Math.cos(phi) * v * spread + speed * 0.25;
      p.vz = Math.sin(phi) * Math.sin(theta) * v * spread;
      p.life = 0;
      p.ttl = ttl * (0.65 + Math.random() * 0.7);
      p.gravity = gravity;
      p.size = size * (0.6 + Math.random() * 0.9);

      pos[idx * 3] = position.x; pos[idx * 3 + 1] = position.y; pos[idx * 3 + 2] = position.z;
      col[idx * 3] = c.r; col[idx * 3 + 1] = c.g; col[idx * 3 + 2] = c.b;
      sz[idx] = p.size; al[idx] = 1;
    }
    geo.setDrawRange(0, MAX_PARTICLES);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aColor.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
  }

  /** 扩散光环，用于标记"这里发生了一件事"。 */
  ring(position, { color = 0x7fe4ff, from = 0.25, to = 2.2, ttl = 0.6, lookAt = null } = {}) {
    const r = this.rings.find((x) => x.life >= x.ttl) || this.rings[0];
    r.life = 0; r.ttl = ttl; r.from = from; r.to = to;
    r.mesh.visible = true;
    r.mesh.position.copy(position);
    r.mesh.material.color.set(color);
    r.mesh.material.opacity = 0.9;
    r.mesh.scale.setScalar(from);
    if (lookAt) r.mesh.lookAt(lookAt);
    return r;
  }

  /**
   * 飘字纹理带缓存。注意加了上限：分数文本是 "+13"/"+21"/"+34"… 这种几乎不重复的串，
   * 无上限缓存会一路涨到几十 MB 显存 —— 缓存命中率高的是"太棒了"这类固定文案，
   * 分数串本来就只用一次，淘汰掉没有损失。
   *
   * 画布宽度必须按文本实测，不能写死。写死 512 时，96px 的中文只装得下 5 个字，
   * 第 6 个字起会被**居中裁切**：屏幕上出现的是"关系，再来一"，首尾各少一个字，
   * 而且没有任何报错——看起来就像文案本来就是那样写的。
   * 返回 aspect 一起交给 sprite：只要 sprite 的宽高比等于画布的，字的物理大小就不变，
   * 变的只是精灵的包围盒 —— 所以这个修法不动任何一处现有飘字的观感。
   */
  _textTexture(text, color) {
    const key = `${text}|${color}`;
    const now = performance.now();
    const hit = this._textCache.get(key);
    if (hit) { hit.t = now; return hit; }

    // 只淘汰 5 秒内没被用过的条目：飘字生命周期约 1 秒，
    // 这样绝不会把还在屏幕上的精灵所引用的纹理释放掉
    if (this._textCache.size >= 48) {
      for (const [k, v] of this._textCache) {
        if (now - v.t > 5000) { v.tex.dispose(); this._textCache.delete(k); break; }
      }
    }
    const FONT = '700 96px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
    const c = document.createElement('canvas');
    // 先拿一个临时 context 量宽（改 canvas.width 会清空 context 状态，量必须在设尺寸之前）
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = FONT;
    // 余量 64px：辉光 shadowBlur 26 + 描边 3，两侧都要装得下
    c.width = Math.max(192, Math.ceil(probe.measureText(text).width) + 64);
    c.height = 160;
    const ctx = c.getContext('2d');
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = 26;
    ctx.fillStyle = color;
    ctx.fillText(text, c.width / 2, 84);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.strokeText(text, c.width / 2, 84);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const entry = { tex, t: now, aspect: c.width / c.height };
    this._textCache.set(key, entry);
    return entry;
  }

  /** 空间飘字：命中即时反馈，VR 里比屏幕 HUD 有效得多。 */
  floatText(position, text, { color = '#8ff6ff', scale = 0.5, ttl = 1.1, rise = 0.9 } = {}) {
    const { tex, aspect } = this._textTexture(text, color);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    spr.scale.set(scale * aspect, scale, 1);
    spr.position.copy(position);
    spr.renderOrder = 998;
    this.scene.add(spr);
    this.texts.push({ spr, life: 0, ttl, rise, baseY: position.y, scale, aspect });
  }

  update(dt) {
    // 粒子
    const geo = this.points.geometry;
    const pos = geo.attributes.position.array;
    const al = geo.attributes.aAlpha.array;
    let any = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (p.life >= p.ttl) { al[i] = 0; continue; }
      any = true;
      p.life += dt;
      p.vy += p.gravity * dt;
      p.vx *= 0.96; p.vz *= 0.96;
      pos[i * 3] += p.vx * dt;
      pos[i * 3 + 1] += p.vy * dt;
      pos[i * 3 + 2] += p.vz * dt;
      const k = 1 - p.life / p.ttl;
      al[i] = k * k;
    }
    if (any) {
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
    }

    // 光环
    for (const r of this.rings) {
      if (r.life >= r.ttl) { if (r.mesh.visible) r.mesh.visible = false; continue; }
      r.life += dt;
      const k = Math.min(1, r.life / r.ttl);
      const e = 1 - Math.pow(1 - k, 3);
      r.mesh.scale.setScalar(r.from + (r.to - r.from) * e);
      r.mesh.material.opacity = 0.9 * (1 - k);
    }

    // 飘字
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life += dt;
      const k = t.life / t.ttl;
      if (k >= 1) {
        this.scene.remove(t.spr);
        t.spr.material.dispose();
        this.texts.splice(i, 1);
        continue;
      }
      t.spr.position.y = t.baseY + t.rise * (1 - Math.pow(1 - k, 2));
      const pop = k < 0.18 ? 0.6 + (k / 0.18) * 0.55 : 1.15 - (k - 0.18) * 0.16;
      t.spr.scale.set(t.scale * t.aspect * pop, t.scale * pop, 1);
      t.spr.material.opacity = k > 0.65 ? 1 - (k - 0.65) / 0.35 : 1;
    }
  }
}
