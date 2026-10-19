import * as THREE from "three";
import { SMOKE, SMOKE_COLORS } from "./weapons.js";

// Coloured smoke screens from smoke grenades. Like FireFX, each puff's whole
// life (billow out, swirl, rise, fade) is computed in the vertex shader from
// one shared time uniform, so the CPU only places a cloud. Clouds are pooled
// and stay in the scene (hidden when idle), so nothing compiles mid-match.
//
// Gameplay reads the same shape on the CPU: blocks() says whether a sight
// line passes through a cloud (enemy name tags hide behind smoke) and
// density() how deep a point is inside one (the screen tint when you're in it).

const MAX_CLOUDS = 4;
const PUFFS = 96;
const HIDE_Y = -500;
const CONCEAL_FROM = 0.35; // cloud strength (0..1) from which it hides players

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uStart;
  uniform float uDur;
  uniform float uGrow;
  uniform float uFade;
  uniform vec3  uCenter;
  uniform float uRadius;
  uniform float uHeight;

  attribute vec3 aSpawn;  // unit disc on xz, 0..1 on y (biased low)
  attribute vec4 aSeed;   // x size, y spin, z phase, w shade

  varying vec2  vUv;
  varying float vAlpha;
  varying float vShade;

  #include <common>
  #include <fog_pars_vertex>

  void main() {
    float age = uTime - uStart;
    if (age < 0.0 || age > uDur) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

    // Pours out of the canister fast, then slows to a lazy billow
    float g = clamp(age / uGrow, 0.0, 1.0);
    float grow = 1.0 - (1.0 - g) * (1.0 - g) * (1.0 - g);
    float life = age / uDur;

    vec3 p = uCenter;
    p.xz += aSpawn.xz * uRadius * grow;
    p.y  += 0.4 + aSpawn.y * uHeight * (0.3 + 0.7 * grow) + life * 1.2;
    float ph = aSeed.z * 6.2831;
    p.x += sin(uTime * 0.31 + ph) * 0.6;
    p.z += cos(uTime * 0.27 + ph * 1.3) * 0.6;
    p.y += sin(uTime * 0.22 + ph * 2.1) * 0.25;

    float size = (2.4 + aSeed.x * 2.4) * (0.3 + 0.7 * grow) * (1.0 + life * 0.35);

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    mvPosition.xy += position.xy * size;
    gl_Position = projectionMatrix * mvPosition;

    float a = aSeed.y * uTime * 0.25 + ph;
    float s = sin(a), c = cos(a);
    vec2 q = uv - 0.5;
    vUv = vec2(c * q.x - s * q.y, s * q.x + c * q.y) + 0.5;
    vAlpha = clamp(age / 0.35, 0.0, 1.0) * (1.0 - smoothstep(uDur - uFade, uDur, age));
    // Lit from above: the tops of the billows are brighter
    vShade = aSeed.w * 0.3 + aSpawn.y * 0.45 + position.y * 0.25;

    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3  uColor;
  uniform float uLight;
  varying vec2  vUv;
  varying float vAlpha;
  varying float vShade;
  #include <common>
  #include <fog_pars_fragment>

  void main() {
    float t = texture2D(uMap, vUv).a;
    float a = min(1.0, t * 1.25) * vAlpha;
    if (a < 0.01) discard;
    // Tops of the billows catch the light, undersides are shadowed
    vec3 col = uColor * (0.5 + vShade) * (0.94 + 0.12 * (1.0 - t));
    gl_FragColor = vec4(mix(col, vec3(dot(col, vec3(0.33))), 0.12) * uLight, a);
    #include <fog_fragment>
  }
`;

/** Soft wispy puff: radial falloff broken up by fractal noise, drawn once on a canvas. */
function makePuff() {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const img = g.createImageData(size, size);
  const lattice = new Float32Array(33 * 33).map(() => Math.random());
  const noise = (x, y) => {
    const xi = Math.floor(x) & 31, yi = Math.floor(y) & 31;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const at = (i, j) => lattice[(j & 31) * 33 + (i & 31)];
    const a = at(xi, yi), b = at(xi + 1, yi), cc = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (cc - a) * v + (a - b - cc + d) * u * v;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size - 0.5, ny = y / size - 0.5;
      const r = Math.sqrt(nx * nx + ny * ny) * 2;
      let n = 0, amp = 0.5, f = 3;
      for (let o = 0; o < 4; o++) { n += noise(x / size * f, y / size * f) * amp; amp *= 0.5; f *= 2; }
      const a = Math.pow(Math.max(0, 1 - r), 1.3) * (0.35 + n * 1.1);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.max(0, Math.min(255, a * 255));
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

function makeGeometry() {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute("position", base.getAttribute("position"));
  geo.setAttribute("uv", base.getAttribute("uv"));
  const spawn = new Float32Array(PUFFS * 3);
  const seed = new Float32Array(PUFFS * 4);
  for (let i = 0; i < PUFFS; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.pow(Math.random(), 0.55);
    spawn[i * 3] = Math.cos(a) * r;
    spawn[i * 3 + 1] = Math.pow(Math.random(), 1.4) * (1 - r * 0.45); // a dome, not a drum
    spawn[i * 3 + 2] = Math.sin(a) * r;
    seed[i * 4] = Math.random();
    seed[i * 4 + 1] = Math.random() * 2 - 1;
    seed[i * 4 + 2] = Math.random();
    seed[i * 4 + 3] = Math.random();
  }
  geo.setAttribute("aSpawn", new THREE.InstancedBufferAttribute(spawn, 3));
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 4));
  geo.instanceCount = PUFFS;
  return geo;
}

export class SmokeFX {
  constructor(scene) {
    this.time = { value: 0 };
    this.light = { value: 1 };
    const geo = makeGeometry();
    const map = makePuff();
    const base = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 }, uStart: { value: -1e6 }, uDur: { value: SMOKE.duration },
        uGrow: { value: SMOKE.grow }, uFade: { value: SMOKE.fade },
        uCenter: { value: new THREE.Vector3() }, uRadius: { value: SMOKE.radius }, uHeight: { value: SMOKE.height },
        uColor: { value: new THREE.Color() }, uLight: { value: 1 }, uMap: { value: null },
      }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });

    this.clouds = [];
    for (let i = 0; i < MAX_CLOUDS; i++) {
      const mat = base.clone();
      // clone() copies uniforms; share time, light and the texture
      mat.uniforms.uTime = this.time;
      mat.uniforms.uLight = this.light;
      mat.uniforms.uMap.value = map;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false; // the shader moves every puff
      mesh.renderOrder = 3;       // over fire and blood, under the name tags' depth test
      mesh.visible = false;
      mesh.position.set(0, HIDE_Y, 0);
      scene.add(mesh);
      this.clouds.push({ mesh, mat, active: false, x: 0, y: 0, z: 0, age: 0, color: new THREE.Color() });
    }
  }

  /** A new cloud on the ground at (x, y, z). color: index into SMOKE_COLORS. */
  spawn(x, y, z, color = 0) {
    const c = this.clouds.find(q => !q.active) ?? this.clouds.reduce((a, b) => (a.age > b.age ? a : b));
    c.active = true;
    c.x = x; c.y = y; c.z = z;
    c.age = 0;
    c.color.set(SMOKE_COLORS[((color | 0) % SMOKE_COLORS.length + SMOKE_COLORS.length) % SMOKE_COLORS.length]);
    const u = c.mat.uniforms;
    u.uStart.value = this.time.value;
    u.uCenter.value.set(x, y, z);
    u.uColor.value.copy(c.color);
    c.mesh.position.set(0, 0, 0);
    c.mesh.visible = true;
  }

  clear() {
    for (const c of this.clouds) this._end(c);
  }

  _end(c) {
    c.active = false;
    c.mesh.visible = false;
    c.mat.uniforms.uStart.value = -1e6;
  }

  /** light: 0..1 scene brightness, so smoke doesn't glow at night. */
  update(delta, light = 1) {
    this.time.value += delta;
    this.light.value = light;
    for (const c of this.clouds) {
      if (!c.active) continue;
      c.age += delta;
      if (c.age >= SMOKE.duration) this._end(c);
    }
  }

  /** 0..1: how built up / not yet faded a cloud is. */
  _strength(c) {
    const fadeOut = Math.min(1, (SMOKE.duration - c.age) / SMOKE.fade);
    return Math.min(c.age / (SMOKE.grow * 0.6), 1, fadeOut);
  }

  _radius(c) {
    const g = Math.min(1, c.age / SMOKE.grow);
    return SMOKE.radius * (1 - (1 - g) ** 3);
  }

  /** True if the sight line a → b passes through a thick enough cloud. */
  blocks(a, b) {
    for (const c of this.clouds) {
      if (!c.active || this._strength(c) < CONCEAL_FROM) continue;
      const r = this._radius(c) * 0.8;
      // Closest point to the cloud's axis on the segment, in plan view
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 1e-6 ? Math.min(1, Math.max(0, ((c.x - a.x) * dx + (c.z - a.z) * dz) / len2)) : 0;
      const px = a.x + dx * t - c.x, pz = a.z + dz * t - c.z;
      if (px * px + pz * pz > r * r) continue;
      const y = a.y + (b.y - a.y) * t;
      if (y > c.y - 1 && y < c.y + SMOKE.height + 1.5) return true;
    }
    return false;
  }

  /**
   * How deep p is inside the thickest cloud (0 outside, 1 well inside), and
   * that cloud's colour in `outColor`.
   */
  density(p, outColor) {
    let best = 0;
    for (const c of this.clouds) {
      if (!c.active) continue;
      const r = this._radius(c);
      if (r < 0.5 || p.y < c.y - 1 || p.y > c.y + SMOKE.height + 1.5) continue;
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      const k = Math.min(1, Math.max(0, (r - d) / (r * 0.35))) * this._strength(c);
      if (k > best) { best = k; outColor?.copy(c.color); }
    }
    return best;
  }
}
