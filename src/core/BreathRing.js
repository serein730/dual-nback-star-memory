import * as THREE from 'three';

/**
 * 呼吸引导环 —— 静息环节的主视觉。
 *
 * 为什么是"环"而不是别的形状：
 *  - 圆是没有方向、没有终点的形状，看着不催促人；方块/进度条天然带"任务感"。
 *  - 半径的开合可以直接映射吸气与呼气的体感（胸腔涨落），孩子不需要读文字就能跟。
 *  - 环上还能顺手挂一条角向进度弧 —— 对 ADHD 儿童，「还剩多久」必须是看得见的形状，
 *    而不是一个需要在脑子里维持的倒计时数字。
 *
 * 整个环是一个 shader quad（不是 TorusGeometry）。理由是这一层要的是软边、内部弥散、
 * 角向起伏和一条会走的弧 —— 这些在片元里几行就能出来，用几何体拼反而又贵又硬。
 */

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uRadius;     // 环半径（quad 半宽为 0.5 的归一化单位）
uniform float uThick;      // 高斯软边的 sigma
uniform float uGlow;       // 整体强度，用于淡入淡出
uniform float uProgress;   // 当前阶段进度 0~1，驱动进度弧
uniform float uArc;        // 进度弧显隐
uniform vec3  uColor;
uniform vec3  uArcColor;

varying vec2 vUv;

const float TAU = 6.283185307179586;

float gauss(float x, float s) { return exp(-(x * x) / (s * s)); }

void main() {
  vec2 p = vUv - 0.5;
  float r = length(p);
  // 0 在正上方、顺时针递增：进度弧从 12 点出发，和钟表一致
  float a = fract(atan(p.x, p.y) / TAU);

  // 角向的缓慢起伏。幅度压到 2% 以内 —— 完美的圆看着像仪器，轻微不圆才像活物；
  // 但这里非常敏感：试过 5%，环立刻变成一个会蠕动的多边形，不再像"圆环"了。
  float wob = 1.0
    + 0.016 * sin(a * TAU * 3.0 + uTime * 0.55)
    + 0.009 * sin(a * TAU * 5.0 - uTime * 0.83);
  float R = uRadius * wob;

  // 底环刻意压暗：它是"跑道"，不是主角。亮度留给下面那条进度弧，
  // 否则亮芯一过曝，弧和环糊成同一条白线，"还剩多久"就读不出来了。
  float d    = r - R;
  float body = gauss(d, uThick) * 0.50;
  float core = gauss(d, uThick * 0.32) * 0.60;
  float halo = gauss(r - R * 1.10, uThick * 0.45) * 0.13;  // 外侧伴环，做层次
  float haze = smoothstep(R * 1.02, R * 0.05, r) * 0.075;  // 环内弥散的"气"

  float ring = body + core + halo + haze;

  // 进度弧：走满一圈 = 这一口气结束。做成彗星形（头亮、尾迅速衰减），
  // 匀亮的实心弧看久了会失去"在走"的感觉
  float band  = gauss(d, uThick * 0.55);
  float trail = step(a, uProgress) * (0.10 + 0.90 * pow(a / max(uProgress, 1e-3), 1.6));
  float head  = smoothstep(0.05, 0.0, abs(a - uProgress)) * 1.9;
  float arc   = band * (trail * 1.15 + head) * uArc;

  vec3 col = (uColor * ring + uArcColor * arc) * uGlow;
  if (col.r + col.g + col.b < 0.005) discard;
  gl_FragColor = vec4(col, 1.0);
}
`;

const DUST_COUNT = 56;

export class BreathRing extends THREE.Group {
  /**
   * @param {Assets} assets 复用已有的火花贴图，不额外生成纹理
   * @param {object} opt
   *   size       quad 边长（米）。环半径永远小于 size/2，留出软边与外环的余量
   *   floorDrop  地面倒影相对本组原点向下的距离（米）
   */
  constructor(assets, { size = 1.8, floorDrop = 1.47 } = {}) {
    super();
    this.size = size;
    this.t = 0;

    this.uniforms = {
      uTime: { value: 0 },
      uRadius: { value: 0.2 },
      uThick: { value: 0.033 },
      uGlow: { value: 0 },
      uProgress: { value: 0 },
      uArc: { value: 0 },
      uColor: { value: new THREE.Color('#6f8cff') },
      uArcColor: { value: new THREE.Color('#eaf8ff') },
    };
    // 地面倒影共享同一组几何参数（半径、厚度、相位、颜色），只在强度上独立 ——
    // 于是光环和它落在台面上的那摊光永远是同一次呼吸，不可能对不上
    this.floorUniforms = { ...this.uniforms, uGlow: { value: 0 }, uArc: { value: 0 } };

    this.quad = new THREE.PlaneGeometry(size, size);

    this.face = new THREE.Mesh(this.quad, this._material(this.uniforms));
    this.face.renderOrder = 2;
    this.add(this.face);

    this.floor = new THREE.Mesh(this.quad, this._material(this.floorUniforms));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.set(0, -floorDrop, 0.16);
    this.floor.renderOrder = 1;
    this.add(this.floor);

    this._buildDust(assets);
  }

  _material(uniforms) {
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
  }

  /** 环上绕行的星尘：随呼吸径向进出，给"半径在变"这件事再加一层可读性。 */
  _buildDust(assets) {
    const pos = new Float32Array(DUST_COUNT * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));

    this.dust = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.055,
      map: assets.tex.spark,
      color: 0xc8ecff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    }));
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 3;
    this.add(this.dust);

    // 每颗给独立的绕行速度，避免整圈同步转动（那看着像一个转盘，不像星尘）
    this._dust = Array.from({ length: DUST_COUNT }, (_, i) => ({
      a: (i / DUST_COUNT) * Math.PI * 2 + Math.random() * 0.12,
      k: 0.94 + Math.random() * 0.16,
      w: 0.05 + Math.random() * 0.09,
      z: (Math.random() - 0.5) * 0.05,
    }));
  }

  /**
   * @param {object} s
   *   open      0~1 呼吸开合（0 = 完全呼尽，1 = 完全吸满）
   *   progress  0~1 当前阶段进度
   *   arc       0~1 进度弧显隐
   *   glow      0~1 整体强度
   *   color     THREE.Color 环主色
   */
  set({ open = 0, progress = 0, arc = 0, glow = 1, color = null } = {}) {
    const u = this.uniforms;
    // 吸满时环更大、更薄、更亮；呼尽时更小、更厚、更柔 —— 和胸腔的手感一致
    u.uRadius.value = 0.2 + open * 0.105;
    u.uThick.value = 0.033 - open * 0.009;
    u.uProgress.value = progress;
    u.uArc.value = arc * glow;
    u.uGlow.value = glow;
    if (color) u.uColor.value.copy(color);
    // 倒影强度只给 0.15：它躺在台面上、被相机以很平的角度看，投影被压扁后
    // 加性混合会把整条带子叠到过曝。0.34 时那里糊成一团白，把底部的说明文字也吃掉了。
    this.floorUniforms.uGlow.value = glow * 0.15;
  }

  reset() {
    this.set({ open: 0, progress: 0, arc: 0, glow: 0 });
  }

  update(dt) {
    this.t += dt;
    this.uniforms.uTime.value = this.t;

    const R = this.uniforms.uRadius.value * this.size;
    const arr = this.dust.geometry.attributes.position.array;
    for (let i = 0; i < DUST_COUNT; i++) {
      const d = this._dust[i];
      const ang = d.a + this.t * d.w;
      const rr = R * d.k;
      arr[i * 3] = Math.cos(ang) * rr;
      arr[i * 3 + 1] = Math.sin(ang) * rr;
      arr[i * 3 + 2] = d.z + Math.sin(this.t * 0.9 + i) * 0.012;
    }
    this.dust.geometry.attributes.position.needsUpdate = true;
    this.dust.material.opacity = 0.75 * this.uniforms.uGlow.value;
  }

  dispose() {
    this.quad.dispose();
    this.face.material.dispose();
    this.floor.material.dispose();
    this.dust.geometry.dispose();
    this.dust.material.dispose();
  }
}
