import * as THREE from 'three';
import { sparkTexture } from './Assets.js';

/**
 * 场景：一座悬浮在星海之上的观星台。
 *
 * 场景设计不是装饰，它直接服务训练目标：
 *  - 中央平台 + 环形跑道 → 给孩子明确的"注意力舞台"，目标只会从舞台前方来；
 *  - 背景做得深、做得暗、做得慢 → 视觉噪声低，不与前景目标抢注意资源；
 *  - 极光/星尘等动态元素全部放在远处且低对比 → 有生命感但不构成干扰源。
 * 干扰必须是任务可控的（由关卡逻辑投放），而不是场景里随机冒出来的。
 */

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const SKY_FRAG = /* glsl */`
precision highp float;
uniform float uTime;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uNebulaA;
uniform vec3 uNebulaB;
uniform float uNebulaGain;
varying vec3 vDir;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
        mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
        mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

// 分格星点：每个格子最多一颗星，带独立闪烁相位，避免整片同步闪
float stars(vec3 dir, float density, float scale, float seed) {
  vec3 p = dir * scale;
  vec3 cell = floor(p);
  vec3 f = fract(p) - 0.5;
  float r = hash(cell + seed);
  if (r > density) return 0.0;
  vec3 off = (vec3(hash(cell + 1.7 + seed), hash(cell + 3.3 + seed), hash(cell + 5.9 + seed)) - 0.5) * 0.7;
  float d = length(f - off);
  float tw = 0.62 + 0.38 * sin(uTime * (0.8 + r * 2.6) + r * 40.0);
  return smoothstep(0.09, 0.0, d) * tw * (0.35 + r * 0.9);
}

void main() {
  float h = vDir.y;
  vec3 col = mix(uHorizon, uZenith, smoothstep(-0.05, 0.85, h));
  col = mix(uGround, col, smoothstep(-0.45, -0.02, h));

  float band = smoothstep(-0.35, 0.6, h);

#if LOW_SKY
  // ── 移动头显档：星云降成单次 vnoise ──
  // 这个天空球包住整个视野，它的片元着色器要在**每一个像素**上跑一遍。
  // 完整版每像素约 88 次 hash（两层 5 阶 fbm 就占 80 次），在 Pico 4 的
  // 904 万像素上等于每帧 8 亿次噪声运算 —— 实测它一个对象就吃掉一多半帧率
  // （关掉天空：26 → 63.9 fps）。这里把 fbm 换成单次 vnoise，约 12 次 hash。
  // 星点保留：星星是"星海"主题的核心视觉，砍了就不是这个场景了。
  vec3 q = vDir * 2.4;
  float n1 = vnoise(q + vec3(uTime * 0.008, 0.0, uTime * 0.005));
  float neb = pow(max(0.0, n1 * 1.3 - 0.42), 2.0) * 1.5;
  col += mix(uNebulaA, uNebulaB, n1) * neb * band * uNebulaGain;

  float s = stars(vDir, 0.055, 150.0, 0.0);
#else
  // 星云：两层不同速度的 fbm 交叠，制造深度
  vec3 q = vDir * 1.6;
  float n1 = fbm(q + vec3(uTime * 0.008, 0.0, uTime * 0.005));
  float n2 = fbm(q * 2.1 + vec3(-uTime * 0.006, uTime * 0.004, 0.0));
  float neb = pow(max(0.0, n1 * 1.15 - 0.35), 2.0) * 1.6;
  float neb2 = pow(max(0.0, n2 * 1.1 - 0.42), 2.4) * 1.4;
  col += (uNebulaA * neb + uNebulaB * neb2) * band * uNebulaGain;

  float s = stars(vDir, 0.055, 150.0, 0.0) + stars(vDir, 0.02, 78.0, 11.3) * 1.4;
#endif

  col += vec3(0.85, 0.92, 1.0) * s * smoothstep(-0.2, 0.15, h);

  gl_FragColor = vec4(col, 1.0);
}
`;

const AURORA_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const AURORA_FRAG = /* glsl */`
precision highp float;
uniform float uTime;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uIntensity;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.1; a *= 0.52; }
  return s;
}

void main() {
  float x = vUv.x;
  float y = vUv.y;
  float curtain = fbm(vec2(x * 3.2 + uTime * 0.06, y * 1.4 - uTime * 0.1));
  float ribbon = smoothstep(0.35, 0.75, curtain);
  float vertical = smoothstep(0.0, 0.32, y) * smoothstep(1.0, 0.55, y);
  float edges = smoothstep(0.0, 0.16, x) * smoothstep(1.0, 0.84, x);
  vec3 col = mix(uColorA, uColorB, y + curtain * 0.3);
  float a = ribbon * vertical * edges * uIntensity;
  gl_FragColor = vec4(col * a, a);
}
`;

/**
 * 确定性伪随机：**给定种子**时场景布局完全可复现（调试、录屏、前后对比截图全靠它）。
 *
 * 种子本身默认每次加载随机（见 `World.constructor`），这样每次打开 demo 看到的
 * 浮岛分布、星尘、岛上水晶都不一样；需要复现某一次布局时用 `?seed=<整数>` 锁定。
 */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class World {
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    // 种子每次加载换一个 —— 原来写死 20260804，于是 11 个浮岛的位置、大小、高度、
    // 上面有没有水晶、什么颜色，每次刷新分毫不差，是"每次玩起来都一样"最大的观感来源。
    // `?seed=<整数>` 可以锁回确定值（调试 / 录屏 / 截图对比时用）。
    const forced = Number(new URLSearchParams(location.search).get('seed'));
    this.seed = Number.isFinite(forced) && forced !== 0
      ? forced : (Math.random() * 0xffffffff) >>> 0;
    this.rand = mulberry32(this.seed);
    this.t = 0;
    this.group = new THREE.Group();
    scene.add(this.group);

    this._buildSky();
    this._buildLights();
    this._buildPlatform();
    this._buildFloatingIslands();
    this._buildAurora();
    this._buildStardust();

    scene.fog = new THREE.FogExp2(0x0a0f2c, 0.019);
  }

  _buildSky() {
    this.skyUniforms = {
      uTime: { value: 0 },
      uZenith: { value: new THREE.Color(0x070a22) },
      uHorizon: { value: new THREE.Color(0x24306e) },
      uGround: { value: new THREE.Color(0x05060f) },
      uNebulaA: { value: new THREE.Color(0x3f5fd0) },
      uNebulaB: { value: new THREE.Color(0x8a4bd8) },
      uNebulaGain: { value: 0.85 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(180, 48, 32),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms,
        // 用 define 而不是 uniform 分支：低画质档下那两层 fbm 要在**编译期**就消失，
        // 留成运行期分支等于白省（GPU 仍要为它保留寄存器和指令槽）
        defines: { LOW_SKY: 0 },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    );
    sky.frustumCulled = false;
    this.group.add(sky);
    this.sky = sky;
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0x9db4ff, 0x1a1030, 0.7);
    this.group.add(hemi);

    const key = new THREE.DirectionalLight(0xbfd8ff, 1.9);
    key.position.set(6, 11, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 34;
    const d = 10;
    Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
    key.shadow.bias = -0.0012;
    key.shadow.normalBias = 0.02;
    this.group.add(key);
    this.keyLight = key;

    // 冷暖对撞的补光，让 PBR 材质出层次。
    // 点光用的是物理衰减（decay=2），强度要按"距离平方"来估：
    // 强度 26、距离 9m ≈ 0.32 的有效照度，看着不多其实刚好。
    const rimA = new THREE.PointLight(0x4fc8ff, 26, 26, 2);
    rimA.position.set(-7, 4.5, -6);
    this.group.add(rimA);

    const rimB = new THREE.PointLight(0xff7bb0, 13, 24, 2);
    rimB.position.set(7.5, 4.6, -7.5);
    this.group.add(rimB);

    // 舞台灯：照亮玩家正前方的任务区，而不是脚下 ——
    // 放在脚下时离吉祥物只有 1.7m，平方反比一算直接把它烧成白块
    const stage = new THREE.PointLight(0x8fd7ff, 6, 14, 2);
    stage.position.set(0, 2.4, -3.4);
    this.group.add(stage);
    this.stageLight = stage;
  }

  _buildPlatform() {
    const R = 6.2;
    const g = new THREE.Group();
    this.group.add(g);
    this.platform = g;

    // 台面
    const deckMat = new THREE.MeshStandardMaterial({
      color: 0x252f66, metalness: 0.5, roughness: 0.42, envMapIntensity: 1.25,
    });
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.985, 0.34, 96, 1), deckMat);
    deck.position.y = -0.17;
    deck.receiveShadow = true;
    g.add(deck);

    // 台面纹理：同心发光环 + 放射刻线，兼做空间参照（VR 里防眩晕的关键）
    const ringMat = (color, opacity) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    [[1.15, 1.22, 0x4fd8ff, 0.5], [2.6, 2.68, 0x4fd8ff, 0.3],
     [4.1, 4.17, 0x6f8bff, 0.24], [R - 0.28, R - 0.16, 0x8ff0ff, 0.65]].forEach(([r0, r1, c, o]) => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 96), ringMat(c, o));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.006;
      g.add(ring);
    });

    const spokes = new THREE.Group();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(0.028, R - 1.3),
        ringMat(0x4fd8ff, 0.13),
      );
      line.rotation.x = -Math.PI / 2;
      line.rotation.z = -a;
      line.position.set(Math.sin(a) * (R + 1.3) / 2, 0.005, Math.cos(a) * (R + 1.3) / 2);
      spokes.add(line);
    }
    g.add(spokes);

    // 边缘发光环带
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(R, 0.045, 12, 128),
      new THREE.MeshBasicMaterial({ color: 0x7fe9ff, toneMapped: false }),
    );
    rim.rotation.x = Math.PI / 2;
    g.add(rim);
    this.rim = rim;

    // 岛体下方：带噪声位移的倒锥，做出天然岩体而不是干净的圆锥
    const rockGeo = new THREE.ConeGeometry(R * 0.98, 5.4, 26, 8);
    rockGeo.rotateX(Math.PI);
    this._displace(rockGeo, 0.42, 1.1);
    rockGeo.computeVertexNormals();
    const rock = new THREE.Mesh(rockGeo, new THREE.MeshStandardMaterial({
      color: 0x2a2f52, metalness: 0.15, roughness: 0.85, flatShading: true, envMapIntensity: 0.7,
    }));
    rock.position.y = -0.34 - 2.7;
    g.add(rock);

    // 岩体缝隙里的发光晶脉
    for (let i = 0; i < 14; i++) {
      const a = this.rand() * Math.PI * 2;
      const depth = 0.6 + this.rand() * 3.4;
      const r = R * (0.95 - depth / 6.4);
      const shard = new THREE.Mesh(
        this.assets.geo.crystalSmall,
        new THREE.MeshBasicMaterial({
          color: this.rand() > 0.5 ? 0x59d6ff : 0xa27bff,
          transparent: true, opacity: 0.55, toneMapped: false,
        }),
      );
      shard.position.set(Math.cos(a) * r, -0.5 - depth, Math.sin(a) * r);
      shard.rotation.set(this.rand() * 3, this.rand() * 3, this.rand() * 3);
      shard.scale.setScalar(0.3 + this.rand() * 0.5);
      g.add(shard);
    }
  }

  _displace(geo, amount, freq) {
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = Math.sin(v.x * freq + v.y * 0.7) * Math.cos(v.z * freq * 1.3 + v.y * 0.5);
      const k = 1 + n * amount * (0.4 + Math.abs(v.y) * 0.12);
      pos.setXYZ(i, v.x * k, v.y, v.z * k);
    }
    pos.needsUpdate = true;
  }

  _buildFloatingIslands() {
    this.islands = [];
    const mat = new THREE.MeshStandardMaterial({
      color: 0x232849, metalness: 0.2, roughness: 0.82, flatShading: true, envMapIntensity: 0.6,
    });
    const topMat = new THREE.MeshStandardMaterial({
      color: 0x2f3a72, metalness: 0.45, roughness: 0.5, flatShading: true, envMapIntensity: 0.9,
    });

    for (let i = 0; i < 11; i++) {
      const g = new THREE.Group();
      const a = (i / 11) * Math.PI * 2 + this.rand() * 0.5;
      const dist = 13 + this.rand() * 22;
      const scale = 0.5 + this.rand() * 1.9;
      g.position.set(Math.cos(a) * dist, -4 + this.rand() * 12, Math.sin(a) * dist);
      g.scale.setScalar(scale);

      const bodyGeo = new THREE.ConeGeometry(1.5, 2.6, 9, 4);
      bodyGeo.rotateX(Math.PI);
      this._displace(bodyGeo, 0.34, 1.6);
      bodyGeo.computeVertexNormals();
      const body = new THREE.Mesh(bodyGeo, mat);
      body.position.y = -1.3;
      g.add(body);

      const top = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.48, 0.22, 9), topMat);
      g.add(top);

      if (this.rand() > 0.35) {
        const shard = new THREE.Mesh(this.assets.geo.crystal, new THREE.MeshBasicMaterial({
          color: this.rand() > 0.5 ? 0x5fd8ff : 0xb98cff,
          transparent: true, opacity: 0.7, toneMapped: false,
        }));
        shard.scale.setScalar(0.5 + this.rand() * 0.7);
        shard.position.y = 0.7;
        shard.rotation.y = this.rand() * 3;
        g.add(shard);
      }

      g.userData = { phase: this.rand() * Math.PI * 2, amp: 0.25 + this.rand() * 0.5, baseY: g.position.y };
      this.islands.push(g);
      this.group.add(g);
    }
  }

  _buildAurora() {
    this.auroraUniforms = [];
    const specs = [
      { w: 60, h: 26, dist: 62, angle: -0.9, a: 0x2effc8, b: 0x2a6bff, i: 0.5 },
      { w: 74, h: 30, dist: 74, angle: 0.6, a: 0x9b6bff, b: 0x2ad8ff, i: 0.42 },
      { w: 52, h: 22, dist: 55, angle: 2.4, a: 0x35d0ff, b: 0x7b5bff, i: 0.35 },
    ];
    for (const s of specs) {
      const u = {
        uTime: { value: 0 },
        uColorA: { value: new THREE.Color(s.a) },
        uColorB: { value: new THREE.Color(s.b) },
        uIntensity: { value: s.i },
      };
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(s.w, s.h, 1, 1),
        new THREE.ShaderMaterial({
          uniforms: u,
          vertexShader: AURORA_VERT,
          fragmentShader: AURORA_FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          fog: false,
          toneMapped: false,
        }),
      );
      mesh.position.set(Math.sin(s.angle) * s.dist, 14, Math.cos(s.angle) * s.dist);
      mesh.lookAt(0, 8, 0);
      this.group.add(mesh);
      this.auroraUniforms.push(u);
    }
  }

  _buildStardust() {
    const N = 1400;
    const pos = new Float32Array(N * 3);
    const scale = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = this.rand() * Math.PI * 2;
      const r = 3 + Math.pow(this.rand(), 0.6) * 34;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = -6 + this.rand() * 24;
      pos[i * 3 + 2] = Math.sin(a) * r;
      scale[i] = 0.4 + this.rand() * 1.6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aScale', new THREE.Float32BufferAttribute(scale, 1));

    const mat = new THREE.PointsMaterial({
      size: 0.14,
      map: sparkTexture(64),
      color: 0x9fd6ff,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.group.add(pts);
    this.stardust = pts;
  }

  /** 神经反馈：专注度越高，极光越亮、平台边环越活跃 —— 这是"看得见的注意力"。 */
  setAttention(value01) {
    const v = Math.max(0, Math.min(1, value01));
    this.auroraUniforms.forEach((u, i) => {
      u.uIntensity.value = (0.16 + v * 0.62) * (1 - i * 0.14);
    });
    this.skyUniforms.uNebulaGain.value = 0.55 + v * 0.7;
    this.stageLight.intensity = 3.5 + v * 7;
    this.rim.material.color.setHSL(0.52 - v * 0.06, 0.9, 0.45 + v * 0.25);
  }

  update(dt) {
    this.t += dt;
    this.skyUniforms.uTime.value = this.t;
    this.auroraUniforms.forEach((u) => { u.uTime.value = this.t; });
    this.stardust.rotation.y += dt * 0.012;
    for (const island of this.islands) {
      const u = island.userData;
      island.position.y = u.baseY + Math.sin(this.t * 0.35 + u.phase) * u.amp;
      island.rotation.y += dt * 0.03;
    }
  }

  setQuality(q) {
    const low = q === 'low';
    this.keyLight.castShadow = !low;
    if (this.stardust.material) this.stardust.material.opacity = low ? 0.55 : 0.75;

    // 天空穹顶是这个场景里最贵的一个对象（实测在 Pico 4 上独占一多半帧率，
    // 见 SKY_FRAG 里 LOW_SKY 分支的注释）。切 define 会触发 shader 重编译，
    // 只在档位真的变了时做 —— 重编译本身会卡一下。
    const want = low ? 1 : 0;
    const mat = this.sky?.material;
    if (mat && mat.defines.LOW_SKY !== want) {
      mat.defines.LOW_SKY = want;
      mat.needsUpdate = true;
    }
  }
}
