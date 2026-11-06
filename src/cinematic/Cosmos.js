import * as THREE from "three";
import { NOISE_GLSL } from "./Medallion.js";

// Scenes 02-06 of the opening cinematic: the space it travels through. Each set
// piece is a group that's only drawn while its shot is on (and a little either
// side, for the crossfades), so the GPU only ever pays for one at a time.
//   sky       a nebula dome whose palette follows the shot, and three shells of stars
//   streaks   warp lines round the camera, stretched by its speed
//   multiverse  luminous universe-bubbles (fresnel shells holding their own nebulae)
//   cluster   thousands of distant galaxies strung along a cosmic web, and one spiral
//             galaxy of tens of thousands of stars the camera dives into
//   solar     the Sun (textured, boiling, with corona), Saturn and its rings, Jupiter,
//             Mars, the Moon and Earth: day map, city lights on the night side, a
//             specular ocean, moving clouds with shadows, atmospheric scattering
// Planet textures: Solar System Scope (CC BY 4.0, NASA-based), public/cinematic/.

const TAU = Math.PI * 2;
const DIR = "/cinematic/";

// ── Shaders ─────────────────────────────────────────────────────────────────
const SKY_VERT = `varying vec3 vDir; void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FRAG = `
  uniform float uTime, uBright;
  uniform vec3 uA, uB, uC;
  varying vec3 vDir;
  ${NOISE_GLSL}
  void main() {
    vec3 d = normalize(vDir);
    float n = fbm(d * 2.2 + vec3(0.0, uTime * 0.004, 0.0));
    float n2 = fbm(d * 4.7 - n * 1.3);
    // A brighter band across the sky, like the Milky Way
    float band = exp(-pow(d.y * 2.6 + n * 0.6 - 0.3, 2.0));
    vec3 col = uA * 0.06 + uB * smoothstep(0.35, 0.85, n) * 0.55 + uC * smoothstep(0.55, 0.95, n2) * 0.45 * band;
    col += uC * band * 0.06;
    gl_FragColor = vec4(col * uBright, 1.0);
  }`;

const STAR_VERT = `
  attribute float aSize, aSeed;
  attribute vec3 aColor;
  uniform float uTime, uScale, uAlpha;
  varying vec3 vC;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(aSize * uScale * (420.0 / -mv.z), 1.0, 9.0);
    vC = aColor;
    vA = uAlpha * (0.75 + 0.25 * sin(uTime * (1.0 + aSeed * 3.0) + aSeed * 60.0));
  }`;
const STAR_FRAG = `
  varying vec3 vC;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float core = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vC * (core * core * 2.2) * vA, 1.0);
  }`;

const STREAK_VERT = `
  attribute float aEnd;
  uniform vec3 uCam, uVel;
  uniform float uLen, uSpan;
  varying float vA;
  void main() {
    vec3 p = position;
    // Wrap round the camera along the way it's going, so the field never runs out
    vec3 dir = normalize(uVel + vec3(0.0001));
    float along = dot(p - uCam, dir);
    p -= dir * (floor((along + uSpan * 0.5) / uSpan) * uSpan);
    p -= uVel * aEnd * uLen;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    vA = (1.0 - aEnd) * clamp(length(uVel) * uLen * 0.04, 0.0, 1.0);
  }`;
const STREAK_FRAG = `uniform vec3 uColor; varying float vA; void main() { gl_FragColor = vec4(uColor * vA, 1.0); }`;

const BUBBLE_VERT = `
  varying vec3 vN, vV, vP;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    vP = position;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const BUBBLE_FRAG = `
  uniform float uTime, uAlpha, uSeed;
  uniform vec3 uCol1, uCol2;
  varying vec3 vN, vV, vP;
  ${NOISE_GLSL}
  void main() {
    float fr = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
    vec3 p = normalize(vP) * 2.0 + uSeed;
    float n = fbm(p + vec3(uTime * 0.03));
    float swirl = fbm(p * 2.3 - n * 1.5);
    vec3 col = mix(uCol1, uCol2, smoothstep(0.3, 0.8, swirl));
    col *= (0.25 + 0.9 * smoothstep(0.35, 0.85, n));
    col += uCol2 * fr * 1.6;
    // Pinprick stars inside it
    vec3 g = floor(p * 40.0);
    float h = fract(sin(dot(g, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    col += vec3(1.0) * step(0.985, h) * 1.2;
    gl_FragColor = vec4(col * uAlpha * (0.35 + fr), 1.0);
  }`;

const GALAXY_VERT = `
  attribute float aSize, aAngle, aType, aSeed;
  attribute vec3 aColor;
  uniform float uAlpha, uScale;
  varying vec3 vC;
  varying float vAng, vType, vA, vSeed;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(aSize * uScale * (900.0 / -mv.z), 1.5, 160.0);
    vC = aColor; vAng = aAngle; vType = aType; vSeed = aSeed;
    vA = uAlpha * smoothstep(4000.0, 900.0, -mv.z);
  }`;
const GALAXY_FRAG = `
  varying vec3 vC;
  varying float vAng, vType, vA, vSeed;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float c = cos(vAng), s = sin(vAng);
    p = mat2(c, -s, s, c) * p;
    p.y /= mix(0.35, 0.9, vType);            // tilt: flat disc .. round elliptical
    float r = length(p) * 2.0;
    if (r > 1.0) discard;
    float a = atan(p.y, p.x);
    float arms = vType < 0.5 ? pow(0.5 + 0.5 * sin(a * 2.0 - log(r + 0.03) * 5.0 + vSeed * 6.0), 2.0) : 0.6;
    float core = exp(-r * r * 22.0) * 1.6;
    float disc = exp(-r * 3.2) * (0.35 + 0.65 * arms);
    gl_FragColor = vec4((vC * disc + vec3(1.0, 0.92, 0.8) * core) * vA, 1.0);
  }`;

const SUN_FRAG = `
  uniform sampler2D tSun;
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vN, vV;
  ${NOISE_GLSL}
  void main() {
    vec2 uv = vUv + vec2(fbm(vec3(vUv * 8.0, uTime * 0.05)) * 0.006, 0.0);
    vec3 tex = texture2D(tSun, uv).rgb;
    float boil = fbm(vec3(vUv * 30.0, uTime * 0.2));
    float limb = pow(max(dot(normalize(vN), normalize(vV)), 0.0), 0.45);
    vec3 col = tex * (1.8 + boil * 0.9) * mix(vec3(1.0, 0.45, 0.15), vec3(1.4, 1.15, 0.85), limb);
    gl_FragColor = vec4(col * 2.2, 1.0);
  }`;
const PLANET_VERT = `
  varying vec2 vUv;
  varying vec3 vN, vV, vW;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const EARTH_FRAG = `
  uniform sampler2D tDay, tNight, tClouds;
  uniform vec3 uSun;
  uniform float uTime, uCloudSpin;
  varying vec2 vUv;
  varying vec3 vN, vV, vW;
  void main() {
    vec3 N = normalize(vN), V = normalize(vV), L = normalize(uSun);
    vec3 day = texture2D(tDay, vUv).rgb;
    vec3 night = texture2D(tNight, vUv).rgb;
    float l = dot(N, L);
    float dayK = smoothstep(-0.12, 0.22, l);
    float ocean = smoothstep(0.015, 0.09, day.b - max(day.r, day.g) * 0.92);
    // Cloud shadows on the ground, offset toward the sun
    float shadow = texture2D(tClouds, vUv + vec2(uCloudSpin - 0.0015, 0.001)).r;
    vec3 col = day * (0.03 + 1.25 * max(l, 0.0)) * (1.0 - shadow * 0.35 * dayK);
    vec3 H = normalize(L + V);
    col += vec3(1.0, 0.92, 0.75) * pow(max(dot(N, H), 0.0), 60.0) * ocean * 0.9 * dayK;
    col += night * vec3(1.0, 0.78, 0.45) * 1.8 * (1.0 - dayK) * (1.0 - ocean);
    // The atmosphere seen through: blue haze toward the edge, warm at the terminator
    float fr = pow(1.0 - max(dot(N, V), 0.0), 2.6);
    col += vec3(0.25, 0.5, 1.0) * fr * 0.9 * smoothstep(-0.3, 0.4, l);
    col += vec3(1.0, 0.45, 0.2) * fr * 0.6 * smoothstep(0.25, 0.0, abs(l));
    gl_FragColor = vec4(col, 1.0);
  }`;
const CLOUD_FRAG = `
  uniform sampler2D tClouds;
  uniform vec3 uSun;
  uniform float uSpin;
  varying vec2 vUv;
  varying vec3 vN, vV, vW;
  void main() {
    float c = texture2D(tClouds, vUv + vec2(uSpin, 0.0)).r;
    float l = dot(normalize(vN), normalize(uSun));
    float lit = smoothstep(-0.15, 0.3, l);
    vec3 col = mix(vec3(0.02, 0.03, 0.06), vec3(1.05), lit) * (0.85 + 0.25 * max(l, 0.0));
    gl_FragColor = vec4(col, c * 0.92);
  }`;
const ATMO_FRAG = `
  uniform vec3 uSun;
  varying vec2 vUv;
  varying vec3 vN, vV, vW;
  void main() {
    vec3 N = normalize(vN), V = normalize(vV);
    float fr = pow(1.0 - abs(dot(N, V)), 4.0);
    float l = dot(N, normalize(uSun));
    vec3 col = mix(vec3(1.0, 0.5, 0.25), vec3(0.35, 0.6, 1.0), smoothstep(-0.05, 0.35, l)) * smoothstep(-0.35, 0.2, l);
    gl_FragColor = vec4(col * fr * 2.2, 1.0);
  }`;

// ── Helpers ─────────────────────────────────────────────────────────────────
function glowTexture(inner, outer) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, inner); grad.addColorStop(0.18, inner); grad.addColorStop(0.45, outer); grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft cloud puff, for the clouds the camera falls through. */
export function cloudTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  for (let i = 0; i < 26; i++) {
    const x = 128 + (Math.random() - 0.5) * 120, y = 128 + (Math.random() - 0.5) * 70, r = 30 + Math.random() * 55;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(255,255,255,0.42)"); grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

export class Cosmos {
  constructor({ lite = false, onProgress = null } = {}) {
    this.lite = lite;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 20000);
    this.disposables = [];
    const keep = o => { this.disposables.push(o); return o; };
    this._keep = keep;
    const loader = new THREE.TextureLoader();
    const tex = (name, srgb = true) => {
      const t = keep(loader.load(DIR + name, () => onProgress?.(name)));
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 8;
      return t;
    };
    this.ambient = new THREE.AmbientLight(0xffffff, 0.08);
    this.scene.add(this.ambient);

    // ── Sky and stars (always on) ──
    this.skyUniforms = { uTime: { value: 0 }, uBright: { value: 0 }, uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uC: { value: new THREE.Color() } };
    const sky = new THREE.Mesh(keep(new THREE.SphereGeometry(10000, 48, 24)), keep(new THREE.ShaderMaterial({
      uniforms: this.skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false,
    })));
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.sky = sky;
    this.scene.add(sky);
    this.starUniforms = { uTime: { value: 0 }, uScale: { value: 1 }, uAlpha: { value: 0 } };
    const NS = lite ? 9000 : 26000;
    const sp = new Float32Array(NS * 3), sc = new Float32Array(NS * 3), ss = new Float32Array(NS), sd = new Float32Array(NS);
    const tints = [[0.7, 0.8, 1.0], [1.0, 1.0, 1.0], [1.0, 0.9, 0.75], [1.0, 0.75, 0.55], [0.8, 0.7, 1.0]];
    for (let i = 0; i < NS; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * TAU, r = rnd(1500, 6000);
      const q = Math.sqrt(1 - u * u);
      sp[i * 3] = Math.cos(a) * q * r; sp[i * 3 + 1] = u * r; sp[i * 3 + 2] = Math.sin(a) * q * r;
      const t = tints[(Math.random() * tints.length) | 0];
      sc.set(t, i * 3);
      ss[i] = Math.pow(Math.random(), 3) * 3.5 + 0.6;
      sd[i] = Math.random();
    }
    const sg = keep(new THREE.BufferGeometry());
    sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    sg.setAttribute("aColor", new THREE.BufferAttribute(sc, 3));
    sg.setAttribute("aSize", new THREE.BufferAttribute(ss, 1));
    sg.setAttribute("aSeed", new THREE.BufferAttribute(sd, 1));
    this.stars = new THREE.Points(sg, keep(new THREE.ShaderMaterial({
      uniforms: this.starUniforms, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    })));
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // ── Warp streaks ──
    const NW = lite ? 500 : 1400, wp = new Float32Array(NW * 6), we = new Float32Array(NW * 2);
    for (let i = 0; i < NW; i++) {
      const a = Math.random() * TAU, r = rnd(6, 120), z = rnd(-400, 400);
      for (let k = 0; k < 2; k++) { wp.set([Math.cos(a) * r, Math.sin(a) * r, z], i * 6 + k * 3); we[i * 2 + k] = k; }
    }
    const wg = keep(new THREE.BufferGeometry());
    wg.setAttribute("position", new THREE.BufferAttribute(wp, 3));
    wg.setAttribute("aEnd", new THREE.BufferAttribute(we, 1));
    this.streakUniforms = { uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() }, uLen: { value: 0.06 }, uSpan: { value: 800 }, uColor: { value: new THREE.Color(0.6, 0.75, 1.2) } };
    this.streaks = new THREE.LineSegments(wg, keep(new THREE.ShaderMaterial({
      uniforms: this.streakUniforms, vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    })));
    this.streaks.frustumCulled = false;
    this.scene.add(this.streaks);

    this._buildMultiverse(keep);
    this._buildCluster(keep);
    this._buildSolar(keep, tex);
  }

  // ── Multiverse: universe-bubbles along the way ──
  _buildMultiverse(keep) {
    const g = this.multiverse = new THREE.Group();
    const geo = keep(new THREE.SphereGeometry(1, this.lite ? 32 : 64, this.lite ? 16 : 32));
    const palettes = [
      [0x2a0b6b, 0x5fd0ff], [0x3b0a52, 0xff9be0], [0x08245e, 0x8af0ff], [0x1d0a4a, 0xffd38a],
      [0x0a3a5e, 0xb59cff], [0x40104a, 0x7fffd4], [0x101060, 0xffb36b],
    ];
    this.bubbles = [];
    const path = this.multiversePath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 80), new THREE.Vector3(14, 6, -60), new THREE.Vector3(-18, -10, -190),
      new THREE.Vector3(22, 12, -320), new THREE.Vector3(-6, 4, -440), new THREE.Vector3(0, 0, -540),
    ], false, "centripetal");
    const N = this.lite ? 14 : 26;
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) / N;
      const c = path.getPointAt(Math.min(1, t * 1.02));
      const side = new THREE.Vector3(rnd(-1, 1), rnd(-0.6, 0.6), 0).normalize();
      const r = rnd(10, 34) * (i === N - 1 ? 1.5 : 1);
      const off = i === N - 1 ? 0 : r + rnd(14, 40);
      const [a, b] = palettes[i % palettes.length];
      const mat = keep(new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 }, uSeed: { value: Math.random() * 10 }, uCol1: { value: new THREE.Color(a) }, uCol2: { value: new THREE.Color(b) } },
        vertexShader: BUBBLE_VERT, fragmentShader: BUBBLE_FRAG,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(c).addScaledVector(side, off);
      if (i === N - 1) m.position.copy(path.getPointAt(1)).add(new THREE.Vector3(0, 0, -40));
      m.scale.setScalar(r);
      g.add(m);
      this.bubbles.push(m);
    }
    this.finalBubble = this.bubbles[this.bubbles.length - 1];
    g.visible = false;
    this.scene.add(g);
  }

  // ── Galaxy cluster: a cosmic web of galaxies, and one spiral to dive into ──
  _buildCluster(keep) {
    const g = this.cluster = new THREE.Group();
    const N = this.lite ? 1600 : 4200;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), ang = new Float32Array(N), type = new Float32Array(N), seed = new Float32Array(N);
    const nodes = Array.from({ length: 14 }, () => new THREE.Vector3(rnd(-1600, 1600), rnd(-700, 700), rnd(-1600, 1000)));
    const v = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      // Most along filaments between nodes, a crowd at each node
      const a = nodes[(Math.random() * nodes.length) | 0], b = nodes[(Math.random() * nodes.length) | 0];
      if (Math.random() < 0.65) v.lerpVectors(a, b, Math.random()); else v.copy(a);
      v.x += gauss() * 120; v.y += gauss() * 120; v.z += gauss() * 120;
      pos.set([v.x, v.y, v.z], i * 3);
      const warm = Math.random();
      col.set(warm < 0.4 ? [1.0, 0.85, 0.65] : warm < 0.8 ? [0.65, 0.75, 1.0] : [0.95, 0.7, 1.0], i * 3);
      size[i] = rnd(4, 14) * (Math.random() < 0.05 ? 2.5 : 1);
      ang[i] = Math.random() * TAU;
      type[i] = Math.random();
      seed[i] = Math.random();
    }
    const geo = keep(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geo.setAttribute("aAngle", new THREE.BufferAttribute(ang, 1));
    geo.setAttribute("aType", new THREE.BufferAttribute(type, 1));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    this.galaxyUniforms = { uAlpha: { value: 1 }, uScale: { value: 1 } };
    const pts = new THREE.Points(geo, keep(new THREE.ShaderMaterial({
      uniforms: this.galaxyUniforms, vertexShader: GALAXY_VERT, fragmentShader: GALAXY_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    })));
    pts.frustumCulled = false;
    g.add(pts);

    // The spiral galaxy: stars along logarithmic arms, a warm bulge, blue arms, pink star-forming knots
    const S = this.lite ? 22000 : 60000, R = 140;
    const sp = new Float32Array(S * 3), sc = new Float32Array(S * 3), ss = new Float32Array(S), sd = new Float32Array(S);
    const arms = 4;
    for (let i = 0; i < S; i++) {
      const bulge = i < S * 0.11;
      let x, y, z, c;
      if (bulge) {
        const r = Math.pow(Math.random(), 1.8) * R * 0.22, a = Math.random() * TAU, u = gauss();
        x = Math.cos(a) * r; z = Math.sin(a) * r; y = u * R * 0.05 * (1 - r / (R * 0.22));
        c = [1.0, 0.85 + Math.random() * 0.1, 0.6];
      } else {
        const r = Math.pow(Math.random(), 0.7) * R, arm = (i % arms) / arms * TAU;
        const a = arm + Math.log(r / 8 + 1) * 2.4 + gauss() * 0.28 * (1 - r / R * 0.5);
        x = Math.cos(a) * r; z = Math.sin(a) * r; y = gauss() * R * 0.025;
        const k = Math.random();
        c = k < 0.06 ? [1.0, 0.45, 0.7] : k < 0.6 ? [0.65, 0.78, 1.0] : [1.0, 0.95, 0.85];
      }
      sp.set([x, y, z], i * 3);
      sc.set(c, i * 3);
      ss[i] = Math.random() < 0.02 ? 2.6 : rnd(0.5, 1.4);
      sd[i] = Math.random();
    }
    const sgeo = keep(new THREE.BufferGeometry());
    sgeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    sgeo.setAttribute("aColor", new THREE.BufferAttribute(sc, 3));
    sgeo.setAttribute("aSize", new THREE.BufferAttribute(ss, 1));
    sgeo.setAttribute("aSeed", new THREE.BufferAttribute(sd, 1));
    this.spiralUniforms = { uTime: { value: 0 }, uScale: { value: 0.16 }, uAlpha: { value: 0.5 } };
    this.spiral = new THREE.Points(sgeo, keep(new THREE.ShaderMaterial({
      uniforms: this.spiralUniforms, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    })));
    this.spiral.frustumCulled = false;
    this.spiral.rotation.x = 0.35;
    const core = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: keep(glowTexture("rgba(255,236,190,0.55)", "rgba(255,170,90,0.12)")), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
    core.scale.setScalar(55);
    this.spiral.add(core);
    g.add(this.spiral);
    g.visible = false;
    this.scene.add(g);
  }

  // ── The solar system ──
  _buildSolar(keep, tex) {
    const g = this.solar = new THREE.Group();
    const sphere = keep(new THREE.SphereGeometry(1, this.lite ? 48 : 96, this.lite ? 24 : 48));
    // The Sun, off to the side and far ahead
    this.sunPos = new THREE.Vector3(-2600, 120, -2700);
    this.sunUniforms = { tSun: { value: tex("sun.webp") }, uTime: { value: 0 } };
    const sun = new THREE.Mesh(sphere, keep(new THREE.ShaderMaterial({ uniforms: this.sunUniforms, vertexShader: PLANET_VERT, fragmentShader: SUN_FRAG })));
    sun.position.copy(this.sunPos);
    sun.scale.setScalar(120);
    g.add(sun);
    const corona = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: keep(glowTexture("rgba(255,244,214,1)", "rgba(255,150,60,0.35)")), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
    corona.position.copy(this.sunPos);
    corona.scale.setScalar(1300);
    g.add(corona);
    this.sunLight = new THREE.PointLight(0xfff1dc, 4, 0, 0);
    this.sunLight.position.copy(this.sunPos);
    g.add(this.sunLight);

    const planet = (name, r, x, y, z, tilt = 0) => {
      const m = new THREE.Mesh(sphere, keep(new THREE.MeshStandardMaterial({ map: tex(name), roughness: 0.95, metalness: 0 })));
      m.position.set(x, y, z);
      m.scale.setScalar(r);
      m.rotation.z = tilt;
      g.add(m);
      return m;
    };
    // Coming in from the outer system: Saturn, Jupiter, Mars, then Earth and the Moon
    this.saturn = planet("saturn.webp", 14, 70, -8, -170, 0.47);
    const ringGeo = keep(new THREE.RingGeometry(1.25, 2.3, 128, 1));
    const ruv = ringGeo.attributes.uv, rpos = ringGeo.attributes.position;
    for (let i = 0; i < ruv.count; i++) {
      const r = Math.hypot(rpos.getX(i), rpos.getY(i));
      ruv.setXY(i, (r - 1.25) / (2.3 - 1.25), 0.5);
    }
    const ring = new THREE.Mesh(ringGeo, keep(new THREE.MeshStandardMaterial({ map: tex("saturn_ring.webp"), transparent: true, side: THREE.DoubleSide, roughness: 1, depthWrite: false })));
    ring.rotation.x = -Math.PI / 2 + 0.35;
    this.saturn.add(ring);
    this.jupiter = planet("jupiter.webp", 24, -150, 30, -760, 0.05);
    this.mars = planet("mars.webp", 3, 55, -12, -1650, 0.44);
    // Earth: R = 20 at E; the Moon nearby
    this.R = 20;
    this.E = new THREE.Vector3(0, 0, -2400);
    this.moon = planet("moon.webp", 5.4, -70, 22, -2310);
    this.earthUniforms = {
      tDay: { value: tex("earth_day.webp") }, tNight: { value: tex("earth_night.webp") }, tClouds: { value: tex("earth_clouds.webp") },
      uSun: { value: new THREE.Vector3() }, uTime: { value: 0 }, uCloudSpin: { value: 0 },
    };
    this.earth = new THREE.Mesh(sphere, keep(new THREE.ShaderMaterial({ uniforms: this.earthUniforms, vertexShader: PLANET_VERT, fragmentShader: EARTH_FRAG })));
    this.earth.position.copy(this.E);
    this.earth.scale.setScalar(this.R);
    g.add(this.earth);
    this.cloudUniforms = { tClouds: this.earthUniforms.tClouds, uSun: this.earthUniforms.uSun, uSpin: { value: 0 } };
    const clouds = new THREE.Mesh(sphere, keep(new THREE.ShaderMaterial({ uniforms: this.cloudUniforms, vertexShader: PLANET_VERT, fragmentShader: CLOUD_FRAG, transparent: true, depthWrite: false })));
    clouds.scale.setScalar(1.008);
    this.earth.add(clouds);
    const atmo = new THREE.Mesh(sphere, keep(new THREE.ShaderMaterial({ uniforms: { uSun: this.earthUniforms.uSun }, vertexShader: PLANET_VERT, fragmentShader: ATMO_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide })));
    atmo.scale.setScalar(1.045);
    this.earth.add(atmo);
    // Sunlight at Earth, and where India (the game's region: Latur, Maharashtra) faces
    const sunDir = this.sunPos.clone().sub(this.E).normalize();
    this.earthUniforms.uSun.value.copy(sunDir);
    const towardCam = new THREE.Vector3(0, 0, 1);
    const A = sunDir.clone().multiplyScalar(0.75).add(towardCam).normalize();   // a morning view: lit, the terminator to one side
    const lat = THREE.MathUtils.degToRad(18.4), lon = THREE.MathUtils.degToRad(76.56);
    this.earth.rotation.y = -lon - Math.atan2(A.z, A.x);
    // India's direction from the centre, in the world, after that spin
    this.earth.updateMatrixWorld(true);
    this.india = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon))
      .applyQuaternion(this.earth.quaternion).normalize();

    // Clouds just over India, to fall through at the end
    const ct = keep(cloudTexture());
    this.diveClouds = new THREE.Group();
    const up = this.india, t1 = new THREE.Vector3(0, 1, 0).cross(up).normalize(), t2 = up.clone().cross(t1);
    for (let i = 0; i < (this.lite ? 40 : 90); i++) {
      const s = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: ct, transparent: true, depthWrite: false, opacity: 0.85 })));
      const h = this.R * rnd(1.012, 1.05), u = gauss() * 1.6, w = gauss() * 1.6;
      s.position.copy(this.E).addScaledVector(up, h).addScaledVector(t1, u).addScaledVector(t2, w);
      s.scale.setScalar(rnd(0.5, 1.4));
      this.diveClouds.add(s);
    }
    g.add(this.diveClouds);
    g.visible = false;
    this.scene.add(g);
  }

  /** The sky's palette by shot, eased by the caller: three colours. */
  setPalette(a, b, c, bright) {
    this.skyUniforms.uA.value.copy(a);
    this.skyUniforms.uB.value.copy(b);
    this.skyUniforms.uC.value.copy(c);
    this.skyUniforms.uBright.value = bright;
  }

  update(t, camVel) {
    this.skyUniforms.uTime.value = t;
    this.starUniforms.uTime.value = t;
    this.spiralUniforms.uTime.value = t;
    this.sunUniforms.uTime.value = t;
    this.cloudUniforms.uSpin.value = t * 0.002;
    this.earthUniforms.uCloudSpin.value = t * 0.002;
    for (const b of this.bubbles) b.material.uniforms.uTime.value = t;
    this.spiral.rotation.y = t * 0.03;
    const alt = this.camera.position.distanceTo(this.E) / this.R;
    const near = THREE.MathUtils.smoothstep(alt, 1.3, 1.08);
    this.diveClouds.visible = near > 0.01;
    for (const s of this.diveClouds.children) s.material.opacity = 0.85 * near;
    this.streakUniforms.uCam.value.copy(this.camera.position);
    this.streakUniforms.uVel.value.copy(camVel);
    // The sky dome and stars stay round the camera (they're "infinitely" far)
    this.sky.position.copy(this.camera.position);
    this.stars.position.copy(this.camera.position);
    this.camera.updateMatrixWorld();
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    for (const d of this.disposables) d.dispose?.();
    this.disposables.length = 0;
    this.scene.clear();
  }
}
