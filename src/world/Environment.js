import * as THREE from "three";

// Day / evening / night cycle. Owns the sky dome (gradient, sun, moon, stars,
// drifting clouds, lightning flashes) and drives the scene's sun/moon light,
// hemisphere + ambient fill, fog and exposure from a keyframed palette.
//
// Weather (rain clouds, lightning) feeds in through update(); gameplay reads
// `darkness` (0 bright day … 1 deep night) to scale how well monsters see.

const SKY_RADIUS = 190; // inside the camera's far plane (220)

// Palette by hour. Days stay grey and overcast; it's a horror game.
// top/hor: sky gradient · fog: colour/near/far · light: sun or moon colour +
// intensity · hemi: sky/ground/intensity · amb: ambient · exp: tone-map
// exposure · stars 0..1 · dark: gameplay darkness 0..1
const KEYS = [
  { h: 0,    top: 0x04060c, hor: 0x111725, fog: 0x0b0f17, near: 3,  far: 62,  light: 0x8ea4d8, li: 0.5, hs: 0x2c3a58, hg: 0x0b0a09, hi: 0.48, amb: 0x26304a, ai: 0.14, exp: 0.95, stars: 1,   dark: 1 },
  { h: 4.6,  top: 0x060912, hor: 0x161b2a, fog: 0x0e121b, near: 3,  far: 66,  light: 0x8ea4d8, li: 0.46, hs: 0x2c3a58, hg: 0x0b0a09, hi: 0.48, amb: 0x26304a, ai: 0.14, exp: 0.95, stars: 0.9, dark: 1 },
  { h: 5.9,  top: 0x1a2036, hor: 0x5b4655, fog: 0x332b36, near: 5,  far: 80,  light: 0xff9a74, li: 0.7,  hs: 0x55597a, hg: 0x1c1714, hi: 0.5,  amb: 0x3a3a50, ai: 0.16, exp: 0.98, stars: 0.3, dark: 0.7 },
  { h: 7.2,  top: 0x48566f, hor: 0xb89a8c, fog: 0x7c7478, near: 10, far: 115, light: 0xffc8a8, li: 1.5,  hs: 0x8090b0, hg: 0x3a3028, hi: 0.72, amb: 0x5a5a68, ai: 0.2,  exp: 1.0,  stars: 0,   dark: 0.25 },
  { h: 10,   top: 0x5a6a80, hor: 0xa2a8ac, fog: 0x8f9599, near: 16, far: 140, light: 0xfff0dc, li: 1.9,  hs: 0xa6b4c6, hg: 0x463d34, hi: 0.85, amb: 0x6a6a72, ai: 0.22, exp: 1.0,  stars: 0,   dark: 0 },
  { h: 14.5, top: 0x56667e, hor: 0xa6a6a4, fog: 0x939390, near: 16, far: 140, light: 0xfff0dc, li: 1.9,  hs: 0xa6b4c6, hg: 0x463d34, hi: 0.85, amb: 0x6a6a72, ai: 0.22, exp: 1.0,  stars: 0,   dark: 0 },
  { h: 17,   top: 0x48557a, hor: 0xd69a6a, fog: 0xa88066, near: 22, far: 160, light: 0xffc48a, li: 2.2,  hs: 0x9fb4d8, hg: 0x4a3a2c, hi: 0.85, amb: 0x7a6658, ai: 0.22, exp: 1.04, stars: 0,   dark: 0.05 },
  { h: 18.6, top: 0x2a2340, hor: 0xa8462f, fog: 0x56302a, near: 12, far: 110, light: 0xff6a3a, li: 1.3,  hs: 0x6a5a7a, hg: 0x2a1e18, hi: 0.6,  amb: 0x553a38, ai: 0.18, exp: 1.02, stars: 0,   dark: 0.35 },
  { h: 19.8, top: 0x0d0f20, hor: 0x3a2030, fog: 0x1d1520, near: 5,  far: 78,  light: 0x9a7090, li: 0.45, hs: 0x38385a, hg: 0x13100e, hi: 0.42, amb: 0x302a40, ai: 0.15, exp: 0.97, stars: 0.6, dark: 0.75 },
  { h: 21.2, top: 0x04060c, hor: 0x111725, fog: 0x0b0f17, near: 3,  far: 62,  light: 0x8ea4d8, li: 0.5, hs: 0x2c3a58, hg: 0x0b0a09, hi: 0.48, amb: 0x26304a, ai: 0.14, exp: 0.95, stars: 1,   dark: 1 },
  { h: 24,   top: 0x04060c, hor: 0x111725, fog: 0x0b0f17, near: 3,  far: 62,  light: 0x8ea4d8, li: 0.5, hs: 0x2c3a58, hg: 0x0b0a09, hi: 0.48, amb: 0x26304a, ai: 0.14, exp: 0.95, stars: 1,   dark: 1 },
];
const COLOR_KEYS = ["top", "hor", "fog", "light", "hs", "hg", "amb"];
const NUM_KEYS = ["near", "far", "li", "hi", "ai", "exp", "stars", "dark"];
// Hex → THREE.Color once (in the linear working space)
for (const k of KEYS) for (const c of COLOR_KEYS) k[c] = new THREE.Color(k[c]);

const PHASES = [
  [4.6, "Night"], [7.2, "Dawn"], [17, "Day"], [19.8, "Dusk"], [24, "Night"],
];

const BLOOD_MOON = new THREE.Color(0xff3a22);
const PALE_MOON = new THREE.Color(0xdfe6ff);
const BLOOD_FOG = new THREE.Color(0x2a0a08);
const STORM_GREY = new THREE.Color(0x3a3d44);

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uTop, uHor, uGround, uSunDir, uSunColor, uMoonDir, uMoonColor;
  uniform float uSunVis, uMoonVis, uStars, uTime, uCloud, uFlash;
  varying vec3 vDir;

  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1, 0)), f.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = h > 0.0
      ? mix(uHor, uTop, pow(smoothstep(0.0, 0.65, h), 0.65))
      : mix(uHor, uGround, smoothstep(0.0, -0.12, h));

    // Sun: wide glow + disc
    float sd = max(dot(d, uSunDir), 0.0);
    col += uSunColor * (pow(sd, 10.0) * 0.32 + pow(sd, 900.0) * 2.0) * uSunVis;
    // Moon: disc + halo
    float md = dot(d, uMoonDir);
    col += uMoonColor * (smoothstep(0.99935, 0.9996, md) * 1.4 + pow(max(md, 0.0), 80.0) * 0.22) * uMoonVis;

    if (h > 0.0) {
      // Stars twinkle; hidden by cloud
      vec3 cell = floor(d * 520.0);
      float s = hash3(cell);
      float star = step(0.9978, s) * (0.55 + 0.45 * sin(uTime * (1.5 + s * 3.0) + s * 90.0));
      float clouds = 0.0;
      vec2 uv = d.xz / (h + 0.12) * 1.3 + uTime * vec2(0.006, 0.0025);
      float n = fbm(uv);
      float cover = mix(0.62, 0.18, uCloud);
      clouds = smoothstep(cover, cover + 0.32, n) * smoothstep(0.0, 0.22, h);
      col += vec3(star) * uStars * smoothstep(0.02, 0.3, h) * (1.0 - clouds);
      vec3 cloudCol = mix(uHor * 0.75, uTop * 1.6 + 0.02, 0.45) * (1.0 + uFlash * 4.0);
      col = mix(col, cloudCol, clouds * 0.88);
    }
    col += uFlash * vec3(0.55, 0.6, 0.78) * (0.35 + 0.65 * max(h, 0.0));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Environment {
  /**
   * lights: { hemi, ambient, sun }. dayMinutes: real minutes per full 24 h.
   */
  constructor({ scene, renderer, lights, startHour = 18.2, dayMinutes = 16 }) {
    this.scene = scene;
    this.renderer = renderer;
    this.lights = lights;
    this.hour = startHour;
    this.dayMinutes = dayMinutes;
    this.timeScale = 1;
    this.paused = false;
    this.bloodMoon = false;
    this.darkness = 0;
    this.lightDir = new THREE.Vector3(0.6, 0.6, 0.4);
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.cur = {};
    for (const c of COLOR_KEYS) this.cur[c] = new THREE.Color();
    this._fogColor = new THREE.Color();
    this.onNightfall = null; // (bloodMoon) once each evening

    this.uniforms = {
      uTop: { value: new THREE.Color() },
      uHor: { value: new THREE.Color() },
      uGround: { value: new THREE.Color() },
      uSunDir: { value: this.sunDir },
      uSunColor: { value: new THREE.Color() },
      uMoonDir: { value: this.moonDir },
      uMoonColor: { value: PALE_MOON.clone() },
      uSunVis: { value: 0 },
      uMoonVis: { value: 0 },
      uStars: { value: 0 },
      uTime: { value: 0 },
      uCloud: { value: 0 },
      uFlash: { value: 0 },
    };
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
      }),
    );
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    scene.background = null;
    this._wasNight = this.hour >= 19.8 || this.hour < 5;
  }

  /** "21:40" */
  get timeLabel() {
    const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  get phase() {
    for (const [end, name] of PHASES) if (this.hour < end) return name;
    return "Night";
  }

  _sample() {
    const h = this.hour;
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const t = THREE.MathUtils.smoothstep(h, a.h, b.h);
    for (const c of COLOR_KEYS) this.cur[c].copy(a[c]).lerp(b[c], t);
    for (const n of NUM_KEYS) this.cur[n] = a[n] + (b[n] - a[n]) * t;
  }

  /** weather: { cloud 0..1, rain 0..1, flash 0..1 }. camera: the sky follows it. */
  update(delta, camera, weather) {
    if (!this.paused) {
      this.hour = (this.hour + delta * this.timeScale * 24 / (this.dayMinutes * 60)) % 24;
    }
    const night = this.hour >= 19.8 || this.hour < 5;
    if (night && !this._wasNight) {
      // A third of nights rise red
      this.bloodMoon = Math.random() < 0.33;
      this.onNightfall?.(this.bloodMoon);
    }
    this._wasNight = night;
    this._sample();
    const c = this.cur;
    const cloud = weather?.cloud ?? 0;
    const flash = weather?.flash ?? 0;
    const blood = this.bloodMoon && night ? 1 : 0;

    // Sun arcs east → west from 05:30 to 19:30 (matching the palette), the moon opposite
    const a = (this.hour - 5.5) / 14 * Math.PI;
    this.sunDir.set(Math.cos(a), Math.sin(a), 0.35).normalize();
    this.moonDir.set(-Math.cos(a), -Math.sin(a) * 0.85, -0.3).normalize();
    const useSun = this.sunDir.y >= this.moonDir.y;
    const body = useSun ? this.sunDir : this.moonDir;
    // Dim to nothing as the light source crosses the horizon, so the swap
    // between sun and moon (and their shadows) never pops
    const horizon = THREE.MathUtils.smoothstep(body.y, 0.0, 0.14);
    this.lightDir.copy(body);
    this.lightDir.y = Math.max(this.lightDir.y, 0.22);
    this.lightDir.normalize();

    const overcast = 1 - cloud * 0.45;
    const { hemi, ambient, sun } = this.lights;
    sun.color.copy(c.light);
    if (!useSun && blood) sun.color.lerp(BLOOD_MOON, 0.6);
    sun.intensity = c.li * horizon * overcast;
    hemi.color.copy(c.hs);
    hemi.groundColor.copy(c.hg);
    hemi.intensity = c.hi * (1 - cloud * 0.25) + flash * 2.6;
    ambient.color.copy(c.amb);
    ambient.intensity = c.ai + flash * 0.6;

    // Fog: rain pulls it in and greys it; a blood moon stains it red
    const fog = this.scene.fog;
    this._fogColor.copy(c.fog).lerp(STORM_GREY, cloud * 0.25 * (1 - c.dark)).lerp(BLOOD_FOG, blood * 0.55);
    fog.color.copy(this._fogColor);
    fog.near = c.near * (1 - cloud * 0.4);
    fog.far = c.far * (1 - cloud * 0.32);
    this.renderer.setClearColor(fog.color);
    this.renderer.toneMappingExposure = c.exp;

    const u = this.uniforms;
    u.uTop.value.copy(c.top).lerp(STORM_GREY, cloud * 0.35 * (1 - c.dark)).multiplyScalar(1 - cloud * 0.3);
    u.uHor.value.copy(this._fogColor);
    u.uGround.value.copy(this._fogColor).multiplyScalar(0.6);
    u.uSunColor.value.copy(c.light);
    u.uSunVis.value = THREE.MathUtils.smoothstep(this.sunDir.y, -0.08, 0.1) * (1 - cloud * 0.8);
    u.uMoonVis.value = THREE.MathUtils.smoothstep(this.moonDir.y, -0.05, 0.12) * (1 - cloud * 0.7);
    u.uMoonColor.value.copy(PALE_MOON).lerp(BLOOD_MOON, blood);
    u.uStars.value = c.stars * (1 - cloud * 0.9);
    u.uTime.value += delta;
    u.uCloud.value = cloud;
    u.uFlash.value = flash;
    this.sky.position.copy(camera.position);

    this.darkness = Math.min(1, c.dark + cloud * 0.15);
  }
}
