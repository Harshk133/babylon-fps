import * as THREE from "three";
import { terrainUniforms, TERRAIN_GLSL } from "./Terrain.js";

// Rain, splashes and storms. All drops live on the GPU: each is a streak
// whose fall, wrap-around-the-camera and wind slant come from one time
// uniform, so the CPU only sets a few uniforms per frame. Intensity hides a
// fraction of the drops instead of rebuilding anything.

const DROPS        = 9000;
const RAIN_BOX     = 46;   // drops wrap within this square around the camera
const RAIN_HEIGHT  = 26;
const SPLASHES     = 420;
const SPLASH_BOX   = 22;
const BOLT_SEGS    = 22;

// rain: drop density, cloud: overcast (darkens the world), wind: m/s slant
const STATES = {
  clear:    { rain: 0,    cloud: 0.1,  wind: 0.5, label: "Clear" },
  overcast: { rain: 0,    cloud: 0.6,  wind: 1.2, label: "Overcast" },
  drizzle:  { rain: 0.3,  cloud: 0.72, wind: 1.4, label: "Drizzle" },
  rain:     { rain: 0.65, cloud: 0.85, wind: 2.2, label: "Rain" },
  storm:    { rain: 1,    cloud: 1,    wind: 4.5, label: "Thunderstorm" },
};
// Where each state tends to go next (weights)
const NEXT = {
  clear:    { overcast: 3, clear: 1 },
  overcast: { drizzle: 3, clear: 1, rain: 1 },
  drizzle:  { rain: 3, overcast: 1 },
  rain:     { storm: 2, drizzle: 2, overcast: 1 },
  storm:    { rain: 3 },
};

const RAIN_VERT = /* glsl */ `
  attribute vec4 aRand;
  uniform float uTime, uIntensity;
  uniform vec3 uCam;
  uniform vec2 uWind;
  varying float vAlpha;
  varying float vT;
  void main() {
    if (aRand.w > uIntensity) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }
    float speed = 15.0 + aRand.z * 7.0;
    float y = mod(aRand.y * ${RAIN_HEIGHT.toFixed(1)} - uTime * speed, ${RAIN_HEIGHT.toFixed(1)});
    vec2 wp = vec2(aRand.x, fract(aRand.x * 91.7 + aRand.z * 37.3)) * ${RAIN_BOX.toFixed(1)};
    // Wrap the fixed world position into the box around the camera
    wp -= ${RAIN_BOX.toFixed(1)} * floor((wp - uCam.xz) / ${RAIN_BOX.toFixed(1)} + 0.5);
    wp += uWind * (y / speed);
    vec3 base = vec3(wp.x, y, wp.y);
    vec3 dir = normalize(vec3(uWind.x, -speed, uWind.y));
    vec3 toCam = normalize(cameraPosition - base);
    vec3 side = normalize(cross(dir, toCam));
    float len = 0.45 + speed * 0.025;
    vec3 p = base + side * position.x * 0.02 - dir * position.y * len;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    float dc = distance(base, cameraPosition);
    vAlpha = smoothstep(${(RAIN_BOX * 0.5).toFixed(1)}, ${(RAIN_BOX * 0.25).toFixed(1)}, distance(wp, uCam.xz)) * smoothstep(0.6, 2.5, dc);
    vT = position.y;
  }
`;

const RAIN_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlpha;
  varying float vT;
  void main() {
    gl_FragColor = vec4(uColor, vAlpha * uOpacity * (1.0 - vT * 0.7));
  }
`;

const SPLASH_VERT = /* glsl */ `
  ${TERRAIN_GLSL}
  attribute vec4 aRand;
  uniform float uTime, uIntensity;
  uniform vec3 uCam;
  varying vec2 vUv;
  varying float vAlpha;
  float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    if (aRand.w > uIntensity) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }
    float t = uTime * (1.6 + aRand.z * 1.4) + aRand.y * 10.0;
    float cyc = floor(t);
    float k = fract(t);
    // A fresh random spot every cycle
    vec2 r = vec2(h(aRand.xy + cyc), h(aRand.yx * 1.7 + cyc * 1.3)) - 0.5;
    vec2 c = uCam.xz + r * ${SPLASH_BOX.toFixed(1)};
    float size = 0.05 + k * 0.32;
    vec3 p = vec3(c.x + position.x * size, terrainH(c) + 0.05, c.y + position.y * size);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    vUv = uv;
    vAlpha = (1.0 - k) * (1.0 - k);
  }
`;

const SPLASH_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float ring = smoothstep(0.62, 0.85, d) * smoothstep(1.0, 0.88, d);
    gl_FragColor = vec4(uColor, ring * vAlpha * uOpacity);
  }
`;

function instancedQuad(count, randFn, plane) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = plane.index;
  geo.setAttribute("position", plane.getAttribute("position"));
  geo.setAttribute("uv", plane.getAttribute("uv"));
  const rand = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) randFn(rand, i * 4, i / count);
  geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(rand, 4));
  geo.instanceCount = count;
  return geo;
}

export class Weather {
  /** drops: rain streak count (quality setting). */
  constructor(scene, startState = "overcast", drops = DROPS) {
    this.state = startState;
    this.stateTimer = 50;
    this.rain = 0;
    this.cloud = STATES[startState].cloud;
    this.wind = STATES[startState].wind;
    this.flash = 0;
    this.time = 0;
    this.locked = false;          // lil-gui: hold the current state
    this.onThunder = null;        // (strength 0..1) — after the flash, delayed by distance
    this._lightningTimer = 6;
    this._flashSeq = [];
    this._thunder = [];
    this._windDir = new THREE.Vector2(1, 0.35).normalize();

    // Streaks: unit quad x ∈ [-.5, .5], y ∈ [0, 1] (head → tail)
    const streak = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const rainGeo = instancedQuad(drops, (a, i, f) => {
      a[i] = Math.random(); a[i + 1] = Math.random(); a[i + 2] = Math.random(); a[i + 3] = f;
    }, streak);
    this.common = {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uCam: { value: new THREE.Vector3() },
    };
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.common,
        uWind: { value: new THREE.Vector2() },
        uColor: { value: new THREE.Color(0xaab4c4) },
        uOpacity: { value: 0.32 },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide, // the camera-facing streak can wind either way
      forceSinglePass: true,  // ...but one pass: three draws transparent double-sided twice otherwise
    });
    this.rainMesh = new THREE.Mesh(rainGeo, this.rainMat);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 4;
    scene.add(this.rainMesh);

    const flat = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const splashGeo = instancedQuad(SPLASHES, (a, i, f) => {
      a[i] = Math.random() * 100; a[i + 1] = Math.random(); a[i + 2] = Math.random(); a[i + 3] = f;
    }, flat);
    this.splashMat = new THREE.ShaderMaterial({
      uniforms: { ...this.common, ...terrainUniforms, uColor: { value: new THREE.Color(0xc8d0dc) }, uOpacity: { value: 0.35 } },
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    this.splashMesh = new THREE.Mesh(splashGeo, this.splashMat);
    this.splashMesh.frustumCulled = false;
    this.splashMesh.renderOrder = 3;
    scene.add(this.splashMesh);

    // Lightning bolt: a jagged ribbon far away, shown for a blink
    this.boltPos = new Float32Array((BOLT_SEGS + 1) * 2 * 3);
    const idx = [];
    for (let i = 0; i < BOLT_SEGS; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const boltGeo = new THREE.BufferGeometry();
    boltGeo.setAttribute("position", new THREE.BufferAttribute(this.boltPos, 3).setUsage(THREE.DynamicDrawUsage));
    boltGeo.setIndex(idx);
    this.bolt = new THREE.Mesh(boltGeo, new THREE.MeshBasicMaterial({
      color: 0xe8eeff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, side: THREE.DoubleSide, forceSinglePass: true,
    }));
    this.bolt.frustumCulled = false;
    this.bolt.renderOrder = -5;
    this.bolt.visible = false;
    scene.add(this.bolt);
  }

  get label() { return STATES[this.state].label; }

  /** Jump to a state (lil-gui / tests). */
  set(state) {
    if (!STATES[state]) return;
    this.state = state;
    this.stateTimer = 90 + Math.random() * 60;
  }

  _nextState() {
    const opts = NEXT[this.state];
    let r = Math.random() * Object.values(opts).reduce((a, b) => a + b, 0);
    for (const [s, w] of Object.entries(opts)) { r -= w; if (r <= 0) return s; }
    return "overcast";
  }

  _strike(camPos) {
    // A few flickers over ~0.4 s, then thunder after the light (≈ distance / 340 m/s)
    const n = 2 + ((Math.random() * 3) | 0);
    let t = 0;
    for (let i = 0; i < n; i++) {
      t += 0.04 + Math.random() * 0.12;
      this._flashSeq.push({ at: this.time + t, power: 0.5 + Math.random() * 0.5 });
    }
    const dist = 250 + Math.random() * 1500;
    this._thunder.push({ at: this.time + dist / 340, strength: THREE.MathUtils.clamp(1.4 - dist / 1400, 0.25, 1) });

    // Draw a bolt toward the horizon in a random direction
    const ang = Math.random() * Math.PI * 2;
    const R = 150;
    let x = camPos.x + Math.cos(ang) * R, z = camPos.z + Math.sin(ang) * R;
    const sideX = -Math.sin(ang), sideZ = Math.cos(ang);
    let y = 95;
    const p = this.boltPos;
    for (let i = 0; i <= BOLT_SEGS; i++) {
      const w = 1.6 * (1 - i / BOLT_SEGS) + 0.4;
      const o = i * 6;
      p[o] = x - sideX * w; p[o + 1] = y; p[o + 2] = z - sideZ * w;
      p[o + 3] = x + sideX * w; p[o + 4] = y; p[o + 5] = z + sideZ * w;
      y -= 95 / BOLT_SEGS;
      const j = (Math.random() - 0.5) * 9;
      x += sideX * j; z += sideZ * j;
    }
    this.bolt.geometry.attributes.position.needsUpdate = true;
    this.bolt.visible = true;
    this._boltLife = 0.22;
  }

  /** camPos: THREE.Vector3; indoor: the camera is inside a house (hide the rain). */
  update(delta, camPos, indoor) {
    this.time += delta;
    if (!this.locked) {
      this.stateTimer -= delta;
      if (this.stateTimer <= 0) {
        this.state = this._nextState();
        this.stateTimer = 70 + Math.random() * 90;
      }
    }
    const target = STATES[this.state];
    const k = 1 - Math.exp(-0.25 * delta);
    this.rain += (target.rain - this.rain) * k;
    this.cloud += (target.cloud - this.cloud) * k;
    this.wind += (target.wind - this.wind) * k;
    this._windDir.rotateAround({ x: 0, y: 0 }, Math.sin(this.time * 0.05) * 0.002);

    // Lightning only in storms
    if (this.state === "storm" && this.rain > 0.7) {
      this._lightningTimer -= delta;
      if (this._lightningTimer <= 0) {
        this._lightningTimer = 5 + Math.random() * 12;
        this._strike(camPos);
      }
    }
    let flash = 0;
    for (let i = this._flashSeq.length - 1; i >= 0; i--) {
      const f = this._flashSeq[i];
      const age = this.time - f.at;
      if (age < 0) continue;
      if (age > 0.25) { this._flashSeq.splice(i, 1); continue; }
      flash = Math.max(flash, f.power * (1 - age / 0.25));
    }
    this.flash = flash;
    for (let i = this._thunder.length - 1; i >= 0; i--) {
      if (this.time >= this._thunder[i].at) {
        this.onThunder?.(this._thunder[i].strength);
        this._thunder.splice(i, 1);
      }
    }
    if (this.bolt.visible) {
      this._boltLife -= delta;
      this.bolt.material.opacity = Math.max(0, this._boltLife / 0.22) * (0.6 + Math.random() * 0.4);
      if (this._boltLife <= 0) this.bolt.visible = false;
    }

    const shown = indoor ? 0 : this.rain;
    this.common.uTime.value = this.time;
    this.common.uIntensity.value = shown;
    this.common.uCam.value.copy(camPos);
    this.rainMat.uniforms.uWind.value.copy(this._windDir).multiplyScalar(this.wind);
    // Drops catch the lightning
    this.rainMat.uniforms.uOpacity.value = 0.3 + flash * 0.4;
    this.rainMesh.visible = shown > 0.01;
    this.splashMesh.visible = shown > 0.01;
  }
}
