import * as THREE from "three";
import { lightPool } from "../render/LightPool.js";
import { terrainUniforms, TERRAIN_GLSL } from "./Terrain.js";
import { QUALITY } from "../quality.js";

// Mood: low ground mist that drifts around the player, and burning wrecks
// that pour smoke into the sky. Like FireFX, every particle's motion comes
// from a time uniform in the vertex shader; the CPU only updates uniforms.

const MIST_COUNT   = 90;
const MIST_BOX     = 110;   // mist banks wrap within this square around the camera
const SMOKE_PER    = 34;    // smoke particles per burning source
const FLAME_PER    = 18;
const SMOKE_LIFE   = 7.5;
const FLAME_LIFE   = 0.9;
const LIGHT_RANGE  = 55;

function makePuff(seed) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 22; i++) {
    const x = 64 + (rnd() - 0.5) * 60, y = 64 + (rnd() - 0.5) * 50, r = 18 + rnd() * 30;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(255,255,255,0.22)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  // Fade the square's edges so no corner ever shows
  const mask = g.createRadialGradient(64, 64, 30, 64, 64, 64);
  mask.addColorStop(0, "rgba(0,0,0,0)");
  mask.addColorStop(1, "rgba(0,0,0,1)");
  g.globalCompositeOperation = "destination-out";
  g.fillStyle = mask;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const MIST_VERT = /* glsl */ `
  ${TERRAIN_GLSL}
  attribute vec4 aRand;    // x, z (0..1), size, phase
  uniform float uTime;
  uniform vec3 uCam;
  uniform vec2 uDrift;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vec2 wp = aRand.xy * ${MIST_BOX.toFixed(1)} + uDrift * uTime;
    wp -= ${MIST_BOX.toFixed(1)} * floor((wp - uCam.xz) / ${MIST_BOX.toFixed(1)} + 0.5);
    float w = 7.0 + aRand.z * 9.0;
    float h = w * 0.38;
    vec3 base = vec3(wp.x, terrainH(wp) - 0.4 + sin(uTime * 0.2 + aRand.w * 6.28) * 0.15, wp.y);
    // Billboard around the vertical axis so banks stay on the ground
    vec3 toCam = cameraPosition - base;
    vec3 side = normalize(vec3(toCam.z, 0.0, -toCam.x));
    vec3 p = base + side * position.x * w + vec3(0.0, (position.y + 0.5) * h, 0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    vUv = uv;
    float d = length(toCam.xz);
    // Fade near the camera (no full-screen wash) and at the box edge
    vAlpha = smoothstep(2.5, 9.0, d) * smoothstep(${(MIST_BOX * 0.5).toFixed(1)}, ${(MIST_BOX * 0.3).toFixed(1)}, d);
    // None where nothing grows: indoors, under props, and in the caves (the ground there is the cave floor)
    vAlpha *= smoothstep(0.02, 0.25, terrainSample(wp).g);
  }
`;

const MIST_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    float a = texture2D(uMap, vUv).a;
    // Soft bottom edge where the quad meets the ground
    a *= smoothstep(0.0, 0.35, vUv.y);
    gl_FragColor = vec4(uColor, a * vAlpha * uOpacity);
  }
`;

// Smoke + flames share one vertex shader; aSrc is the source each particle belongs to
const PLUME_VERT = /* glsl */ `
  attribute vec3 aSrc;
  attribute vec4 aRand;    // phase, spread angle, spread, size jitter
  uniform float uTime, uLife, uRise, uSize, uGrow, uSpread;
  uniform vec2 uWind;
  varying vec2 vUv;
  varying float vT;
  void main() {
    float t = fract(uTime / uLife + aRand.x);
    float a = aRand.y * 6.2831;
    vec3 c = aSrc;
    c.x += cos(a) * aRand.z * uSpread * (0.3 + t);
    c.z += sin(a) * aRand.z * uSpread * (0.3 + t);
    c.y += t * uRise;
    c.xz += uWind * t * t * uLife;
    float size = uSize * (0.6 + aRand.w * 0.6) * (1.0 + t * uGrow);
    vec4 mv = viewMatrix * vec4(c, 1.0);
    float r = aRand.x * 6.28 + uTime * (aRand.w - 0.5) * 0.6;
    vec2 q = position.xy * size;
    mv.xy += vec2(q.x * cos(r) - q.y * sin(r), q.x * sin(r) + q.y * cos(r));
    gl_Position = projectionMatrix * mv;
    vUv = uv;
    vT = t;
    vec4 mvPosition = mv;
    #include <fog_vertex>
  }
`;

const SMOKE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  #include <fog_pars_fragment>
  varying vec2 vUv;
  varying float vT;
  void main() {
    float a = texture2D(uMap, vUv).a * smoothstep(0.0, 0.08, vT) * (1.0 - vT) * 1.6;
    vec3 col = mix(uColor * 1.6, uColor, vT);
    #ifdef USE_FOG
      col = mix(col, fogColor, smoothstep(fogNear, fogFar, vFogDepth) * 0.8);
    #endif
    gl_FragColor = vec4(col, a);
  }
`;

const FLAME_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying float vT;
  void main() {
    float a = texture2D(uMap, vUv).a * smoothstep(0.0, 0.15, vT) * (1.0 - vT) * 3.0;
    vec3 col = mix(vec3(1.0, 0.85, 0.45), vec3(0.9, 0.22, 0.04), vT);
    gl_FragColor = vec4(col * a, a);
  }
`;

const PLUME_VERT_FOG = "#include <fog_pars_vertex>\n" + PLUME_VERT;

export class Atmosphere {
  /** mist: how many mist banks (quality setting). */
  constructor(scene, mist = MIST_COUNT) {
    this.scene = scene;
    this.time = { value: 0 };
    const puff = makePuff(7);

    // ── Ground mist
    const plane = new THREE.PlaneGeometry(1, 1);
    const mistGeo = new THREE.InstancedBufferGeometry();
    mistGeo.index = plane.index;
    mistGeo.setAttribute("position", plane.getAttribute("position"));
    mistGeo.setAttribute("uv", plane.getAttribute("uv"));
    const r = new Float32Array(mist * 4);
    for (let i = 0; i < r.length; i++) r[i] = Math.random();
    mistGeo.setAttribute("aRand", new THREE.InstancedBufferAttribute(r, 4));
    mistGeo.instanceCount = mist;
    this.mistMat = new THREE.ShaderMaterial({
      uniforms: {
        ...terrainUniforms,
        uTime: this.time,
        uCam: { value: new THREE.Vector3() },
        uDrift: { value: new THREE.Vector2(0.35, 0.12) },
        uMap: { value: puff },
        uColor: { value: new THREE.Color() },
        uOpacity: { value: 0.5 },
      },
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.mist = new THREE.Mesh(mistGeo, this.mistMat);
    this.mist.frustumCulled = false;
    this.mist.renderOrder = 2;
    scene.add(this.mist);

    this.sources = [];
    this.smoke = null;
    this.flames = null;
    this._puff = puff;
    // One firelight, moved to the burning wreck nearest the player (presets
    // short on per-pixel lighting skip it: the flames still glow)
    this.light = null;
    if (QUALITY.wreckLight) {
      this.light = new THREE.PointLight(0xff7a30, 0, 18, 1.5);
      this.light.position.set(0, -500, 0);
      lightPool.adopt(this.light, 1);
    }
  }

  /** Fixed burning spots: [{ x, y, z, scale }]. Call once, after the world is placed. */
  setSources(list) {
    this.sources = list;
    const plane = new THREE.PlaneGeometry(1, 1);
    const build = (per) => {
      const n = list.length * per;
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = plane.index;
      geo.setAttribute("position", plane.getAttribute("position"));
      geo.setAttribute("uv", plane.getAttribute("uv"));
      const src = new Float32Array(n * 3), rnd = new Float32Array(n * 4);
      list.forEach((s, si) => {
        for (let i = 0; i < per; i++) {
          const k = si * per + i;
          src[k * 3] = s.x; src[k * 3 + 1] = s.y; src[k * 3 + 2] = s.z;
          rnd[k * 4] = i / per + Math.random() * 0.02;
          rnd[k * 4 + 1] = Math.random();
          rnd[k * 4 + 2] = Math.random() * s.scale;
          rnd[k * 4 + 3] = Math.random();
        }
      });
      geo.setAttribute("aSrc", new THREE.InstancedBufferAttribute(src, 3));
      geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(rnd, 4));
      geo.instanceCount = n;
      return geo;
    };
    const plume = (life, rise, size, grow, spread) => ({
      uTime: this.time,
      uLife: { value: life }, uRise: { value: rise }, uSize: { value: size },
      uGrow: { value: grow }, uSpread: { value: spread },
      uWind: { value: new THREE.Vector2(0.4, 0.15) },
      uMap: { value: this._puff },
    });
    this.smokeMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(0x1b1816) } }]),
      vertexShader: PLUME_VERT_FOG,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    Object.assign(this.smokeMat.uniforms, plume(SMOKE_LIFE, 16, 1.6, 4.5, 1.2));
    this.smoke = new THREE.Mesh(build(SMOKE_PER), this.smokeMat);
    this.smoke.frustumCulled = false;
    this.scene.add(this.smoke);

    this.flameMat = new THREE.ShaderMaterial({
      uniforms: plume(FLAME_LIFE, 1.8, 0.7, 0.6, 0.55),
      vertexShader: PLUME_VERT_FOG,
      fragmentShader: FLAME_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.flames = new THREE.Mesh(build(FLAME_PER), this.flameMat);
    this.flames.frustumCulled = false;
    this.scene.add(this.flames);
  }

  /**
   * mist 0..1 (thicker at night and in rain); fogColor tints it; wind (m/s)
   * leans the smoke; rain dampens the flames.
   */
  update(delta, camPos, { mist, fogColor, wind, rain }) {
    this.time.value += delta;
    const u = this.mistMat.uniforms;
    u.uCam.value.copy(camPos);
    u.uColor.value.copy(fogColor).multiplyScalar(1.35).addScalar(0.02);
    u.uOpacity.value = 0.25 + mist * 0.55;
    if (this.smoke) {
      this.smokeMat.uniforms.uWind.value.set(0.35, 0.12).multiplyScalar(0.5 + wind * 0.6);
      this.flameMat.uniforms.uSize.value = 0.7 * (1 - rain * 0.35);
    }

    // Firelight on the nearest wreck in range
    if (!this.light) return;
    let best = null, bd = LIGHT_RANGE * LIGHT_RANGE;
    for (const s of this.sources) {
      const d = (s.x - camPos.x) ** 2 + (s.z - camPos.z) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    if (best) {
      const t = this.time.value;
      this.light.position.set(best.x, best.y + 1.4, best.z);
      this.light.intensity = (9 + Math.sin(t * 17) * 2 + Math.sin(t * 29 + 1.3) * 1.5) * (1 - rain * 0.3) * best.scale;
    } else {
      this.light.intensity = 0;
    }
  }
}
