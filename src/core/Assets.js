import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * 程序化资产库：几何 + PBR 材质 + 贴图，全部代码生成，不依赖任何外部模型/贴图文件。
 *
 * 为什么不加载 glTF：这个原型要能离线跑、要能塞进头显浏览器、要一份代码同时服务
 * 桌面高画质与 XR 低开销两档。程序化资产可以按画质档位重建材质，而且改一个参数就
 * 能改一整类道具的手感 —— 对 demo 迭代速度比外部模型划算得多。
 *
 * 画质分档：
 *   high（桌面）：折射 transmission + 虹彩 iridescence + clearcoat + 高分辨率细分
 *   low （XR）  ：关折射（每帧额外一遍场景渲染，Pico 4 那级移动 GPU 吃不消），改用半透明 + 自发光近似
 */

const TAU = Math.PI * 2;

/* ============================ 贴图工厂 ============================ */

function canvas2d(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return { c, ctx: c.getContext('2d') };
}

function toTexture(c, { srgb = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/** 径向渐变光晕（additive sprite 用）。 */
export function glowTexture(size = 256, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const { c, ctx } = canvas2d(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.28, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return toTexture(c);
}

/** 四芒星闪光（星尘、命中特效）。 */
export function sparkTexture(size = 128) {
  const { c, ctx } = canvas2d(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = size * 0.018;
  ctx.beginPath();
  ctx.moveTo(size / 2, size * 0.06); ctx.lineTo(size / 2, size * 0.94);
  ctx.moveTo(size * 0.06, size / 2); ctx.lineTo(size * 0.94, size / 2);
  ctx.stroke();
  return toTexture(c);
}

/** 地面软阴影贴片（比真实阴影便宜，XR 下代替 shadowMap）。 */
export function blobShadowTexture(size = 128) {
  const { c, ctx } = canvas2d(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.18)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  return toTexture(c, { srgb: false });
}

/** 符文图形：光束聚焦关的目标/干扰项都从这里出，形状族必须"相似但可辨"。 */
export const RUNE_SHAPES = ['triangle', 'square', 'diamond', 'circle', 'star', 'hexagon', 'cross', 'moon'];

export function runeTexture(shape, color = '#7ff0ff', size = 256) {
  const { c, ctx } = canvas2d(size);
  const s = size, cx = s / 2, cy = s / 2, r = s * 0.3;
  ctx.clearRect(0, 0, s, s);
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = s * 0.055;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = s * 0.09;

  const poly = (n, rot = 0, rad = r) => {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = rot - Math.PI / 2 + (i / n) * TAU;
      const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.stroke();
  };

  switch (shape) {
    case 'triangle': poly(3); break;
    case 'square': poly(4, Math.PI / 4); break;
    case 'diamond': poly(4); break;
    case 'hexagon': poly(6); break;
    case 'circle':
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke(); break;
    case 'star': {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 ? r * 0.45 : r;
        const a = -Math.PI / 2 + (i / 10) * TAU;
        const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath(); ctx.stroke(); break;
    }
    case 'cross':
      ctx.beginPath();
      ctx.moveTo(-r * 0.8, 0); ctx.lineTo(r * 0.8, 0);
      ctx.moveTo(0, -r * 0.8); ctx.lineTo(0, r * 0.8);
      ctx.stroke(); break;
    case 'moon': {
      ctx.beginPath(); ctx.arc(0, 0, r, Math.PI * 0.32, Math.PI * 1.68); ctx.stroke();
      break;
    }
    default: poly(5);
  }
  return toTexture(c);
}

/** 吉祥物的眼睛（可切换表情）。 */
export function faceTexture(mood = 'happy', size = 256) {
  const { c, ctx } = canvas2d(size);
  ctx.clearRect(0, 0, size, size);
  const eye = (x, open = 1) => {
    ctx.fillStyle = '#8ff6ff';
    ctx.shadowColor = '#5ce2ff'; ctx.shadowBlur = size * 0.11;
    ctx.beginPath();
    ctx.ellipse(x, size * 0.46, size * 0.072, size * 0.1 * open, 0, 0, TAU);
    ctx.fill();
  };
  if (mood === 'blink') {
    ctx.strokeStyle = '#8ff6ff'; ctx.lineWidth = size * 0.035; ctx.lineCap = 'round';
    ctx.shadowColor = '#5ce2ff'; ctx.shadowBlur = size * 0.1;
    [0.33, 0.67].forEach((f) => {
      ctx.beginPath();
      ctx.moveTo(size * f - size * 0.07, size * 0.46);
      ctx.lineTo(size * f + size * 0.07, size * 0.46);
      ctx.stroke();
    });
  } else {
    eye(size * 0.33, mood === 'wow' ? 1.25 : 1);
    eye(size * 0.67, mood === 'wow' ? 1.25 : 1);
  }
  // 嘴
  ctx.strokeStyle = '#7fe9ff'; ctx.lineWidth = size * 0.026; ctx.lineCap = 'round';
  ctx.beginPath();
  if (mood === 'wow') ctx.arc(size * 0.5, size * 0.63, size * 0.055, 0, TAU);
  else ctx.arc(size * 0.5, size * 0.58, size * 0.085, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
  return toTexture(c);
}

/* ============================ 几何工厂 ============================ */

/**
 * 合并一组几何体。
 * 坑点：three 的 mergeGeometries 要求所有输入"要么全带 index，要么全不带"。
 * Cylinder/Cone 是索引几何，而 Icosahedron（PolyhedronGeometry）是非索引的，
 * 直接混合会静默失败返回 null。这里统一降到非索引再合并。
 */
function mergeParts(parts) {
  const hasNonIndexed = parts.some((p) => p.index === null);
  const normalized = parts.map((p) => (hasNonIndexed && p.index !== null ? p.toNonIndexed() : p));
  const merged = BufferGeometryUtils.mergeGeometries(normalized, false);
  normalized.forEach((n, i) => { if (n !== parts[i]) n.dispose(); });
  parts.forEach((p) => p.dispose());
  if (!merged) throw new Error('mergeParts: 几何体属性不兼容，合并失败');
  return merged;
}

/**
 * 六棱柱水晶（石英原石造型）：柱身 + 上下锥冠，flat shading 出干净的切面。
 * 比直接拿球体或八面体当"水晶"要像样得多，而且顶点数依然很低。
 */
export function crystalGeometry({ radius = 0.5, shaft = 1.0, topCap = 0.62, bottomCap = 0.34 } = {}) {
  const parts = [];
  const body = new THREE.CylinderGeometry(radius, radius * 0.96, shaft, 6, 1, false);
  parts.push(body);

  const top = new THREE.ConeGeometry(radius, topCap, 6);
  top.translate(0, shaft / 2 + topCap / 2, 0);
  parts.push(top);

  const bottom = new THREE.ConeGeometry(radius * 0.96, bottomCap, 6);
  bottom.rotateX(Math.PI);
  bottom.translate(0, -shaft / 2 - bottomCap / 2, 0);
  parts.push(bottom);

  const merged = mergeParts(parts);
  merged.center();
  merged.computeVertexNormals();
  return merged;
}

/** 带尖刺的金属球（No-Go 目标）。刺按黄金角均布，避免看起来像随机堆的。 */
export function spikedBallGeometry({ radius = 0.42, spikes = 16, spikeLen = 0.26 } = {}) {
  const parts = [new THREE.IcosahedronGeometry(radius, 2)];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const dir = new THREE.Vector3();
  const m = new THREE.Matrix4();

  for (let i = 0; i < spikes; i++) {
    const y = 1 - (i / (spikes - 1)) * 2;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    dir.set(Math.cos(theta) * rr, y, Math.sin(theta) * rr).normalize();

    const cone = new THREE.ConeGeometry(radius * 0.2, spikeLen, 5);
    cone.translate(0, radius + spikeLen * 0.42, 0);
    q.setFromUnitVectors(up, dir);
    m.makeRotationFromQuaternion(q);
    cone.applyMatrix4(m);
    parts.push(cone);
  }
  const merged = mergeParts(parts);
  merged.computeVertexNormals();
  return merged;
}

/* ============================ 资产库 ============================ */

export class Assets {
  constructor(quality = 'high') {
    this.quality = quality;
    this.tex = {
      glow: glowTexture(),
      spark: sparkTexture(),
      shadow: blobShadowTexture(),
      runes: Object.fromEntries(RUNE_SHAPES.map((s) => [s, runeTexture(s, '#ffffff')])),
      face: { happy: faceTexture('happy'), blink: faceTexture('blink'), wow: faceTexture('wow') },
    };

    /*
     * 形态变体（2026-08-06 加）：原来池子里 10 个水晶用的是**同一个几何**，
     * 连伴生小晶体的位置都写死在 `crystalCluster()` 里 —— 玩一局看到的其实是
     * 同一个模型转了几十次，重复感全从这里来。
     *
     * 三条硬约束，改这些数值前先读：
     *   ① **外接尺寸必须接近**。判定盒是固定半径的球（`makeHitbox`），
     *      外观差太多就会出现"看着没碰到却打中了"。当前三套水晶的包围球
     *      半径是 1.10 / 1.15 / 1.06，差异 ±5%，被判定盒本来就留的余量吸收掉。
     *   ② **不能跨类相似**。水晶是 Go、陨石是 No-Go，变体只能改"胖瘦疏密"，
     *      不能让某个水晶变体看起来像陨石 —— 那是在污染信号本身。
     *   ③ **必须挂进 `this.geo`**，否则关卡 `exit()` 会当成自建资源 dispose 掉（坑#7）。
     */
    this.geo = {
      crystal: crystalGeometry(),
      crystalB: crystalGeometry({ radius: 0.45, shaft: 1.12, topCap: 0.70, bottomCap: 0.30 }),
      crystalC: crystalGeometry({ radius: 0.55, shaft: 0.88, topCap: 0.54, bottomCap: 0.40 }),
      crystalSmall: crystalGeometry({ radius: 0.34, shaft: 0.6, topCap: 0.42, bottomCap: 0.22 }),
      crystalSmallB: crystalGeometry({ radius: 0.27, shaft: 0.46, topCap: 0.52, bottomCap: 0.18 }),
      crystalSmallC: crystalGeometry({ radius: 0.39, shaft: 0.52, topCap: 0.34, bottomCap: 0.26 }),
      // 外接半径统一 = radius + spikeLen = 0.68，只变刺的疏密与长短
      bomb: spikedBallGeometry(),
      bombB: spikedBallGeometry({ radius: 0.40, spikes: 21, spikeLen: 0.28 }),
      bombC: spikedBallGeometry({ radius: 0.45, spikes: 11, spikeLen: 0.23 }),
      gem: new THREE.OctahedronGeometry(0.16, 0),
      plate: new RoundedBoxGeometry(0.66, 0.8, 0.13, 5, 0.055),
      plateBack: new RoundedBoxGeometry(0.74, 0.88, 0.08, 5, 0.045),
      pillar: new THREE.CylinderGeometry(0.17, 0.21, 1.05, 16, 1),
      pillarBase: new THREE.CylinderGeometry(0.3, 0.36, 0.11, 20, 1),
      ring: new THREE.TorusGeometry(0.62, 0.018, 8, 64),
      quad: new THREE.PlaneGeometry(1, 1),
    };

    this._materials = new Set();
    this.mat = this._buildMaterials();
    // 共享材质注册表：关卡退出时据此区分"可以回收"和"必须留着"
    this._shared = new Set(Object.values(this.mat));
  }

  _track(m) { this._materials.add(m); return m; }

  isShared(m) { return this._shared.has(m); }

  untrack(m) { this._materials.delete(m); }

  _buildMaterials() {
    const hi = this.quality === 'high';

    // 宝石材质的调参要点：吸收距离要短、自发光要弱。
    // 第一版把 attenuationDistance 设成 1.4、emissive 拉到 0.35，结果水晶在场景里
    // 糊成一团发光的白斑 —— 折射材质本来就吃背景光，再叠自发光就彻底没有体积感了。
    // 现在靠色散(dispersion) + 虹彩(iridescence) + 环境反射出质感，自发光只留一点点保底。
    const gemBase = (color, emissive) => this._track(new THREE.MeshPhysicalMaterial({
      color,
      metalness: 0,
      roughness: hi ? 0.05 : 0.16,
      transmission: hi ? 0.82 : 0,
      thickness: hi ? 0.9 : 0,
      ior: 1.78,
      // 注意：不要开 dispersion。在 r185 + 本项目的后期链路下，一旦 dispersion > 0
      // 整个折射材质就渲染不出来（对象在场景里、visible 为 true、也没有报错，
      // 但屏幕上什么都没有）。实测确认，代价换不来收益，直接放弃色散。
      iridescence: hi ? 0.62 : 0,
      iridescenceIOR: 1.6,
      clearcoat: hi ? 1 : 0.4,
      clearcoatRoughness: 0.06,
      attenuationColor: new THREE.Color(color),
      attenuationDistance: 0.5,
      emissive: new THREE.Color(emissive),
      emissiveIntensity: hi ? 0.16 : 0.85,
      envMapIntensity: hi ? 2.0 : 1.1,
      transparent: !hi,
      opacity: hi ? 1 : 0.88,
      flatShading: true,
      side: THREE.DoubleSide,
    }));

    return {
      crystalGo: gemBase(0x1fc4ff, 0x07547a),
      crystalGold: gemBase(0xffc84e, 0x7a4c08),
      crystalViolet: gemBase(0xa872ff, 0x341a78),

      bombShell: this._track(new THREE.MeshStandardMaterial({
        color: 0x2a2f45, metalness: 0.92, roughness: 0.3, envMapIntensity: 1.3,
      })),
      bombGlow: this._track(new THREE.MeshStandardMaterial({
        color: 0x160406, emissive: 0xff3d55, emissiveIntensity: 2.4,
        metalness: 0.4, roughness: 0.5,
      })),

      stone: this._track(new THREE.MeshStandardMaterial({
        color: 0x39406b, metalness: 0.12, roughness: 0.62, envMapIntensity: 0.9,
      })),
      stoneFrame: this._track(new THREE.MeshStandardMaterial({
        color: 0x7486bd, metalness: 0.92, roughness: 0.3, envMapIntensity: 1.15,
      })),

      metalLight: this._track(new THREE.MeshStandardMaterial({
        color: 0xc3d1ef, metalness: 0.88, roughness: 0.26, envMapIntensity: 1.2,
      })),
      // 用于底座/支架这类大面积朝上的金属件：粗糙度高一些，
      // 否则会在顶灯下形成一大块过曝的镜面高光
      metalDeep: this._track(new THREE.MeshStandardMaterial({
        color: 0x46527f, metalness: 0.8, roughness: 0.45, envMapIntensity: 0.9,
      })),
      shell: this._track(new THREE.MeshPhysicalMaterial({
        color: 0xf2f6ff, metalness: 0.08, roughness: 0.22,
        clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 1.2,
      })),
      shellAccent: this._track(new THREE.MeshPhysicalMaterial({
        color: 0x4bc7ff, metalness: 0.25, roughness: 0.28,
        clearcoat: 1, clearcoatRoughness: 0.15, envMapIntensity: 1.3,
      })),
      visor: this._track(new THREE.MeshPhysicalMaterial({
        color: 0x0c1230, metalness: 0.3, roughness: 0.08,
        clearcoat: 1, envMapIntensity: 1.8,
      })),
    };
  }

  setQuality(q) {
    if (q === this.quality) return;
    this.quality = q;
    const hi = q === 'high';
    for (const m of this._materials) {
      if (m.isMeshPhysicalMaterial && 'transmission' in m && m.userData.noTransmissionSwap !== true) {
        if (m.transmission > 0 || m.userData.hadTransmission) {
          m.userData.hadTransmission = true;
          m.transmission = hi ? 0.92 : 0;
          m.thickness = hi ? 1.15 : 0;
          m.iridescence = hi ? 0.5 : 0;
          m.transparent = !hi;
          m.opacity = hi ? 1 : 0.88;
          m.emissiveIntensity = hi ? 0.35 : 0.95;
          m.roughness = hi ? 0.06 : 0.16;
          m.needsUpdate = true;
        }
      }
    }
  }

  /* ------------------------ 组合模型 ------------------------ */

  /** 加性混合光晕面片（永远面向相机）。 */
  glowSprite(color = 0x66e5ff, size = 1, opacity = 0.85) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.tex.glow,
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }));
    s.scale.setScalar(size);
    return s;
  }

  blobShadow(size = 1) {
    const m = new THREE.Mesh(this.geo.quad, new THREE.MeshBasicMaterial({
      map: this.tex.shadow, transparent: true, depthWrite: false, opacity: 0.75,
    }));
    m.rotation.x = -Math.PI / 2;
    m.scale.setScalar(size);
    return m;
  }

  /**
   * Go 目标：主晶体 + 伴生小晶体 + 内核光 + 外圈光晕。
   * 伴生晶体是"看起来像被建模过"和"看起来像个原始几何体"的分界线。
   */
  crystalCluster(variant = 'go') {
    const g = new THREE.Group();
    const mat = variant === 'gold' ? this.mat.crystalGold
      : variant === 'violet' ? this.mat.crystalViolet : this.mat.crystalGo;
    const tint = variant === 'gold' ? 0xffd36e : variant === 'violet' ? 0xc39cff : 0x66e5ff;

    const main = new THREE.Mesh(this.geo.crystal, mat);
    main.castShadow = true;
    g.add(main);

    const buddy = new THREE.Mesh(this.geo.crystalSmall, mat);
    buddy.castShadow = true;
    g.add(buddy);
    g.userData.main = main;
    g.userData.buddy = buddy;
    this.varyCrystal(g);

    // 内核只留一点点，够透过折射看到"里面有东西"就行，大了就变成灯泡
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.1, 1),
      new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.5, toneMapped: false }),
    );
    g.add(core);

    const halo = this.glowSprite(tint, 1.55, 0.3);
    g.add(halo);

    g.userData.spin = 0.5 + Math.random() * 0.4;
    g.userData.core = core;
    g.userData.halo = halo;
    return g;
  }

  /**
   * 给一簇水晶重新随机形态。**投放时调一次**，而不是只在建池时调 ——
   * 池对象是复用的，只在建池时随机的话，同一个对象整局都长一个样。
   * 只换几何引用和伴生晶体的摆位，不产生任何分配（运行期零 GC，坑同 `FX`）。
   */
  varyCrystal(g) {
    const u = g.userData;
    if (!u.main) return;
    const i = Math.floor(Math.random() * 3);
    u.main.geometry = [this.geo.crystal, this.geo.crystalB, this.geo.crystalC][i];
    u.buddy.geometry = [this.geo.crystalSmall, this.geo.crystalSmallB, this.geo.crystalSmallC][
      Math.floor(Math.random() * 3)
    ];
    // 伴生晶体换边 + 换角度。它是"看起来像被建模过"和"看起来像个原始几何体"的分界线，
    // 所以它的摆位比主晶体的胖瘦更影响"这两块不是同一个东西"的观感。
    const side = Math.random() < 0.5 ? -1 : 1;
    u.buddy.position.set(side * (0.28 + Math.random() * 0.12), -0.34 + Math.random() * 0.2, 0.06 + Math.random() * 0.1);
    u.buddy.rotation.set(Math.random() * 0.5, Math.random() * Math.PI, side * (0.3 + Math.random() * 0.35));
    u.buddy.scale.setScalar(0.85 + Math.random() * 0.3);
  }

  /** 同上，给陨石换刺的疏密。外接半径三套一致，判定盒不用跟着改。 */
  varyHazard(g) {
    const u = g.userData;
    if (!u.shell) return;
    u.shell.geometry = [this.geo.bomb, this.geo.bombB, this.geo.bombC][
      Math.floor(Math.random() * 3)
    ];
    // 两道赤道环的夹角也换一换，光带扫过的方向就不会每次都一样
    const tilt = (Math.random() - 0.5) * 0.9;
    u.bands[0].rotation.set(Math.PI / 2, tilt, 0);
    u.bands[1].rotation.set(0, 0, Math.PI / 2 + tilt * 0.6);
  }

  /** No-Go 目标：暗金属尖刺球 + 赤道发光环 + 危险脉冲。 */
  hazard() {
    const g = new THREE.Group();

    const shell = new THREE.Mesh(this.geo.bomb, this.mat.bombShell);
    shell.castShadow = true;
    g.add(shell);

    const bandGeo = new THREE.TorusGeometry(0.44, 0.035, 10, 40);
    const band = new THREE.Mesh(bandGeo, this.mat.bombGlow);
    band.rotation.x = Math.PI / 2;
    g.add(band);

    const band2 = new THREE.Mesh(bandGeo, this.mat.bombGlow);
    band2.rotation.z = Math.PI / 2;
    band2.scale.setScalar(0.82);
    g.add(band2);

    const halo = this.glowSprite(0xff4a5e, 1.75, 0.42);
    g.add(halo);

    g.userData.halo = halo;
    g.userData.bands = [band, band2];
    g.userData.shell = shell;
    g.userData.spin = 0.9;
    this.varyHazard(g);
    return g;
  }

  /** 符文石：金属外框 + 石板 + 发光符号，可换符号与配色。 */
  runeStone(shape = 'triangle', color = 0x7ff0ff) {
    const g = new THREE.Group();

    const back = new THREE.Mesh(this.geo.plateBack, this.mat.stoneFrame);
    back.position.z = -0.045;
    back.castShadow = true;
    g.add(back);

    const plate = new THREE.Mesh(this.geo.plate, this.mat.stone.clone());
    this._track(plate.material);
    g.add(plate);

    const symbolMat = new THREE.MeshBasicMaterial({
      map: this.tex.runes[shape] || this.tex.runes.triangle,
      color,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    const symbol = new THREE.Mesh(this.geo.quad, symbolMat);
    symbol.scale.setScalar(0.56);
    symbol.position.z = 0.072;
    g.add(symbol);

    const halo = this.glowSprite(color, 1.35, 0.28);
    halo.position.z = 0.1;
    g.add(halo);

    g.userData.shape = shape;
    g.userData.symbol = symbol;
    g.userData.plate = plate;
    g.userData.halo = halo;
    return g;
  }

  /** 记忆关的水晶柱：底座 + 柱体 + 顶部宝石 + 内部光柱（激活时点亮）。 */
  crystalPillar(color = 0x64d9ff) {
    const g = new THREE.Group();

    const base = new THREE.Mesh(this.geo.pillarBase, this.mat.metalDeep);
    base.position.y = 0.055;
    base.receiveShadow = true;
    g.add(base);

    // 柱身用"这根柱子自己的颜色"淡化后的玻璃色 + 同色吸收，
    // 六根柱子才会各自有身份 —— 序列记忆任务里，颜色是位置之外的第二条编码线索
    const tint = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.42);
    const colMat = new THREE.MeshPhysicalMaterial({
      color: tint, metalness: 0, roughness: 0.12,
      transmission: this.quality === 'high' ? 0.72 : 0,
      transparent: this.quality !== 'high',
      opacity: this.quality === 'high' ? 1 : 0.72,
      thickness: 0.7, ior: 1.5, clearcoat: 1,
      attenuationColor: new THREE.Color(color),
      attenuationDistance: 0.8,
      emissive: new THREE.Color(color), emissiveIntensity: 0.15,
      envMapIntensity: 1.25,
    });
    this._track(colMat);
    const col = new THREE.Mesh(this.geo.pillar, colMat);
    col.position.y = 0.11 + 0.525;
    col.castShadow = true;
    g.add(col);

    const gem = new THREE.Mesh(this.geo.gem, new THREE.MeshBasicMaterial({
      color, toneMapped: false, transparent: true, opacity: 0.95,
    }));
    gem.position.y = 0.11 + 1.05 + 0.1;
    g.add(gem);

    const halo = this.glowSprite(color, 1.1, 0.0);
    halo.position.y = gem.position.y;
    g.add(halo);

    const light = new THREE.PointLight(color, 0, 3.2, 2);
    light.position.y = gem.position.y;
    g.add(light);

    g.userData = { col, gem, halo, light, colMat, color, baseIntensity: 0.15 };
    return g;
  }

  /** 吉祥物「小北」：全场引导者。用圆角体块 + 玻璃面罩堆出来，不走低模棱角风。 */
  mascot() {
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);

    const torso = new THREE.Mesh(new RoundedBoxGeometry(0.38, 0.36, 0.32, 6, 0.13), this.mat.shell);
    torso.castShadow = true;
    body.add(torso);

    const chest = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.17, 0.05, 4, 0.03), this.mat.shellAccent);
    chest.position.set(0, 0.01, 0.16);
    body.add(chest);

    const head = new THREE.Mesh(new RoundedBoxGeometry(0.44, 0.4, 0.4, 6, 0.16), this.mat.shell);
    head.position.y = 0.42;
    head.castShadow = true;
    body.add(head);

    const visor = new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.23, 0.07, 5, 0.06), this.mat.visor);
    visor.position.set(0, 0.44, 0.19);
    body.add(visor);

    const faceMat = new THREE.MeshBasicMaterial({
      map: this.tex.face.happy, transparent: true, depthWrite: false, toneMapped: false,
    });
    const face = new THREE.Mesh(this.geo.quad, faceMat);
    face.scale.set(0.32, 0.26, 1);
    face.position.set(0, 0.445, 0.228);
    body.add(face);

    // 天线
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.2, 8), this.mat.metalLight);
    stalk.position.y = 0.72;
    body.add(stalk);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.052, 16, 12), new THREE.MeshBasicMaterial({
      color: 0x7ff0ff, toneMapped: false,
    }));
    bulb.position.y = 0.83;
    body.add(bulb);
    const bulbGlow = this.glowSprite(0x7ff0ff, 0.3, 0.75);
    bulbGlow.position.y = 0.83;
    body.add(bulbGlow);

    // 手臂（悬浮，无关节）
    const armGeo = new THREE.CapsuleGeometry(0.045, 0.12, 4, 10);
    const armL = new THREE.Mesh(armGeo, this.mat.shellAccent);
    armL.position.set(-0.27, 0.02, 0);
    armL.rotation.z = 0.35;
    body.add(armL);
    const armR = armL.clone();
    armR.position.x = 0.27;
    armR.rotation.z = -0.35;
    body.add(armR);

    // 悬浮环
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.012, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0x5ce0ff, transparent: true, opacity: 0.75, toneMapped: false }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.3;
    g.add(ring);

    const shadow = this.blobShadow(1.05);
    shadow.position.y = -0.55;
    g.add(shadow);

    g.userData = { body, face, faceMat, ring, armL, armR, bulbGlow, t: Math.random() * 10 };
    return g;
  }

  /** 每帧动画：吉祥物的呼吸/眨眼/环旋转。 */
  animateMascot(m, dt) {
    const u = m.userData;
    u.t += dt;
    u.body.position.y = Math.sin(u.t * 1.5) * 0.045;
    u.body.rotation.y = Math.sin(u.t * 0.6) * 0.18;
    u.ring.rotation.z += dt * 0.9;
    u.ring.scale.setScalar(1 + Math.sin(u.t * 2.2) * 0.06);
    u.armL.rotation.z = 0.35 + Math.sin(u.t * 1.9) * 0.14;
    u.armR.rotation.z = -0.35 - Math.sin(u.t * 1.9 + 0.6) * 0.14;
    u.bulbGlow.material.opacity = 0.6 + Math.sin(u.t * 3.1) * 0.3;

    // 随机眨眼
    if (u.blinkUntil && u.t < u.blinkUntil) return;
    if (u.blinkUntil && u.t >= u.blinkUntil) {
      u.faceMat.map = this.tex.face[u.mood || 'happy'];
      u.faceMat.needsUpdate = true;
      u.blinkUntil = 0;
      u.nextBlink = u.t + 2.5 + Math.random() * 3.5;
    }
    if (!u.nextBlink) u.nextBlink = u.t + 2 + Math.random() * 3;
    if (u.t > u.nextBlink) {
      u.faceMat.map = this.tex.face.blink;
      u.faceMat.needsUpdate = true;
      u.blinkUntil = u.t + 0.12;
    }
  }

  setMascotMood(m, mood) {
    m.userData.mood = mood;
    m.userData.faceMat.map = this.tex.face[mood] || this.tex.face.happy;
    m.userData.faceMat.needsUpdate = true;
  }
}
