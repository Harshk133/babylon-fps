import * as THREE from "three";

// GPU fire + smoke in the style of three.js' webgpu_particles example, written
// for WebGLRenderer. Every particle's life (rise, drift, spin, grow, colour,
// fade) is evaluated in the vertex shader from time + per-instance random
// attributes, so emitters cost zero CPU per particle — the CPU only moves an
// emitter's centre and sets its strength.
//
// Each emitter is two instanced draws (smoke under, additive fire over).
// Emitters are pooled and never added/removed after construction.

const HIDE = new THREE.Vector3(0, -500, 0);

// ─── Procedural puff textures (no asset download) ─────────────────────────────
function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function makePuffTexture(seed, softness, detail) {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size - 0.5, ny = y / size - 0.5;
      const r = Math.sqrt(nx * nx + ny * ny) * 2;
      let n = 0, amp = 0.5, f = 4;
      for (let o = 0; o < 5; o++) { n += valueNoise(x / size * f, y / size * f, seed + o) * amp; amp *= 0.5; f *= 2; }
      const falloff = Math.max(0, 1 - r);
      const a = Math.pow(falloff, softness) * (1 - detail + detail * n * 1.6);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.max(0, Math.min(255, a * 255));
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ─── Shaders ──────────────────────────────────────────────────────────────────
const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uStart;
  uniform float uBurst;
  uniform float uLife;
  uniform float uPhase;
  uniform vec3  uCenter;
  uniform float uRadius;
  uniform float uHeight;
  uniform float uRise;
  uniform float uSpread;
  uniform float uSize;
  uniform float uGrow;

  attribute vec3 aSpawn;  // unit disc on xz, 0..1 on y
  attribute vec3 aDrift;  // random direction
  attribute vec4 aSeed;   // x life scale, y spin, z phase, w size scale

  varying vec2  vUv;
  varying float vLife;
  varying float vQuadY;

  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>

  void main() {
    float life = uLife * aSeed.x;
    float t = uBurst > 0.5
      ? (uTime - uStart) / life
      : fract(uTime / life + aSeed.z + uPhase);
    if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

    // Bursts shoot out fast and slow down; loops drift steadily
    float e = uBurst > 0.5 ? 1.0 - (1.0 - t) * (1.0 - t) : t;
    vec3 p = uCenter + vec3(aSpawn.x * uRadius, aSpawn.y * uHeight, aSpawn.z * uRadius);
    p.xz += aDrift.xz * uSpread * e;
    // Buoyancy: rises faster as it heats the air above
    p.y += uRise * (0.55 + aDrift.y * 0.9) * (uBurst > 0.5 ? e : t * (0.6 + 0.4 * t));

    float size = uSize * aSeed.w * mix(1.0, uGrow, t) * (0.35 + 0.65 * min(t * 6.0, 1.0));

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    mvPosition.xy += position.xy * size;
    gl_Position = projectionMatrix * mvPosition;

    float a = aSeed.y * uTime * 1.6 + aSeed.z * 6.2831;
    float s = sin(a), c = cos(a);
    vec2 q = uv - 0.5;
    vUv = vec2(c * q.x - s * q.y, s * q.x + c * q.y) + 0.5;
    vLife = t;
    vQuadY = position.y + 0.5;

    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }
`;

const FIRE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uStrength;
  uniform float uOpacity;
  varying vec2  vUv;
  varying float vLife;
  varying float vQuadY;
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>

  void main() {
    #include <logdepthbuf_fragment>
    float tex = texture2D(uMap, vUv).a;
    // White-hot core → orange → deep red (0xb72f17 in the reference) as it cools
    vec3 hot  = vec3(1.0, 0.86, 0.52);
    vec3 mid  = vec3(1.0, 0.44, 0.08);
    vec3 cool = vec3(0.72, 0.18, 0.09);
    vec3 col = vLife < 0.3 ? mix(hot, mid, vLife / 0.3) : mix(mid, cool, (vLife - 0.3) / 0.7);
    float a = tex * smoothstep(0.0, 0.08, vLife) * (1.0 - vLife) * uStrength * uOpacity;
    #ifdef USE_FOG
      a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth) * 0.7;
    #endif
    gl_FragColor = vec4(col, a);
  }
`;

const SMOKE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uStrength;
  uniform float uOpacity;
  uniform vec3  uSmokeColor;
  varying vec2  vUv;
  varying float vLife;
  varying float vQuadY;
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>

  void main() {
    #include <logdepthbuf_fragment>
    float tex = texture2D(uMap, vUv).a;
    // Young smoke is lit orange by the flames below (0xf27d0c in the reference)
    vec3 col = mix(vec3(0.95, 0.49, 0.05), uSmokeColor, min(vLife * 2.5, 1.0));
    col *= 0.65 + 0.5 * vQuadY; // fake top light
    float a = tex * smoothstep(0.0, 0.15, vLife) * (1.0 - vLife) * uStrength * uOpacity;
    #ifdef USE_FOG
      float f = smoothstep(fogNear, fogFar, vFogDepth);
      col = mix(col, fogColor, f);
    #endif
    gl_FragColor = vec4(col, a);
  }
`;

// ─── Emitter presets ──────────────────────────────────────────────────────────
// fire/smoke: count, life (s), size, grow (size multiplier at end of life),
// rise (m), spread (m), opacity. radius/height: spawn volume.
export const FIRE_PRESETS = {
  ground: {
    burst: false, radius: 3.0, height: 0.25, spawn: "disc", drift: "loop",
    fire:  { count: 280, life: 1.1, size: 1.25, grow: 0.55, rise: 2.4, spread: 0.3, opacity: 0.9 },
    smoke: { count: 70,  life: 3.4, size: 2.6,  grow: 2.2,  rise: 7.5, spread: 1.6, opacity: 0.38 },
  },
  body: {
    burst: false, radius: 0.32, height: 1.9, spawn: "column", drift: "loop",
    fire:  { count: 80, life: 0.7, size: 0.75, grow: 0.5, rise: 1.1, spread: 0.12, opacity: 0.95 },
    smoke: { count: 18, life: 2.2, size: 1.3,  grow: 2.4, rise: 4.0, spread: 0.8,  opacity: 0.3 },
  },
  blast: {
    burst: true, radius: 0.35, height: 0.4, spawn: "disc", drift: "sphere",
    fire:  { count: 240, life: 0.9, size: 2.0, grow: 0.5, rise: 3.0, spread: 4.5, opacity: 1.0 },
    smoke: { count: 90,  life: 3.2, size: 3.0, grow: 2.4, rise: 6.0, spread: 3.8, opacity: 0.55 },
  },
};
const POOL_SIZES = { ground: 3, body: 14, blast: 3 };

function makeGeometry(count, preset, layer) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute("position", base.getAttribute("position"));
  geo.setAttribute("uv", base.getAttribute("uv"));
  const spawn = new Float32Array(count * 3);
  const drift = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    // Fire concentrates toward the middle of a puddle; smoke rises from all of it
    const r = preset.spawn === "column" ? Math.sqrt(Math.random()) : Math.pow(Math.random(), layer === "fire" ? 0.6 : 0.5);
    spawn[i * 3] = Math.cos(a) * r;
    spawn[i * 3 + 1] = Math.random();
    spawn[i * 3 + 2] = Math.sin(a) * r;
    if (preset.drift === "sphere") {
      const u = Math.random() * 0.9 + 0.1, phi = Math.random() * Math.PI * 2;
      const h = Math.sqrt(1 - u * u);
      drift[i * 3] = Math.cos(phi) * h;
      drift[i * 3 + 1] = u;
      drift[i * 3 + 2] = Math.sin(phi) * h;
    } else {
      drift[i * 3] = Math.random() * 2 - 1;
      drift[i * 3 + 1] = Math.random();
      drift[i * 3 + 2] = Math.random() * 2 - 1;
    }
    seed[i * 4] = 0.45 + Math.random() * 0.55;
    seed[i * 4 + 1] = Math.random() * 2 - 1;
    seed[i * 4 + 2] = Math.random();
    seed[i * 4 + 3] = 0.6 + Math.random() * 0.8;
  }
  geo.setAttribute("aSpawn", new THREE.InstancedBufferAttribute(spawn, 3));
  geo.setAttribute("aDrift", new THREE.InstancedBufferAttribute(drift, 3));
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 4));
  geo.instanceCount = count;
  return geo;
}

class Emitter {
  constructor(kind, preset, fireGeo, smokeGeo, fireMat, smokeMat, scene) {
    this.kind = kind;
    this.preset = preset;
    this.active = false;
    this.target = null;   // zombie for body fires
    this.time = 0;        // remaining (ground) / elapsed (burst)
    this.fire = new THREE.Mesh(fireGeo, fireMat.clone());
    this.smoke = new THREE.Mesh(smokeGeo, smokeMat.clone());
    for (const [mesh, layer, base] of [[this.fire, preset.fire, fireMat], [this.smoke, preset.smoke, smokeMat]]) {
      const u = mesh.material.uniforms;
      // Share the clock + texture with the base material instead of copies
      u.uTime = base.uniforms.uTime;
      u.uMap.value = base.uniforms.uMap.value;
      u.uBurst.value = preset.burst ? 1 : 0;
      u.uRadius.value = preset.radius;
      u.uHeight.value = preset.height;
      u.uLife.value = layer.life;
      u.uSize.value = layer.size;
      u.uGrow.value = layer.grow;
      u.uRise.value = layer.rise;
      u.uSpread.value = layer.spread;
      u.uOpacity.value = layer.opacity;
      u.uPhase.value = Math.random();
      u.uCenter.value.copy(HIDE);
      mesh.frustumCulled = false; // the shader moves vertices far from the geometry bounds
      mesh.visible = false;
      scene.add(mesh);
    }
    this.fire.renderOrder = 3;
    this.smoke.renderOrder = 2;
  }

  setVisible(v) {
    this.fire.visible = v;
    this.smoke.visible = v;
  }

  setCenter(x, y, z) {
    this.fire.material.uniforms.uCenter.value.set(x, y, z);
    this.smoke.material.uniforms.uCenter.value.set(x, y, z);
  }

  setShape(radius, height) {
    for (const m of [this.fire, this.smoke]) {
      m.material.uniforms.uRadius.value = radius;
      m.material.uniforms.uHeight.value = height;
    }
  }

  setStrength(s) {
    this.fire.material.uniforms.uStrength.value = s;
    this.smoke.material.uniforms.uStrength.value = s;
  }
}

export class FireFX {
  constructor(scene) {
    this.time = { value: 0 };
    const fireTex = makePuffTexture(7, 1.6, 0.75);
    const smokeTex = makePuffTexture(31, 1.2, 0.9);

    const common = () => ({
      uTime: this.time,
      uStart: { value: 0 },
      uBurst: { value: 0 },
      uLife: { value: 1 },
      uPhase: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uRadius: { value: 1 },
      uHeight: { value: 0 },
      uRise: { value: 1 },
      uSpread: { value: 0 },
      uSize: { value: 1 },
      uGrow: { value: 1 },
      uStrength: { value: 1 },
      uOpacity: { value: 1 },
    });
    const fireMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, common(), { uMap: { value: null } }]),
      vertexShader: VERT,
      fragmentShader: FIRE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    });
    const smokeMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog, common(),
        { uMap: { value: null }, uSmokeColor: { value: new THREE.Color(0x2f2925) } },
      ]),
      vertexShader: VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    // merge() cloned these; point them back at the shared objects
    fireMat.uniforms.uTime = this.time;
    smokeMat.uniforms.uTime = this.time;
    fireMat.uniforms.uMap.value = fireTex;
    smokeMat.uniforms.uMap.value = smokeTex;

    this.pools = {};
    for (const [kind, preset] of Object.entries(FIRE_PRESETS)) {
      const fireGeo = makeGeometry(preset.fire.count, preset, "fire");
      const smokeGeo = makeGeometry(preset.smoke.count, preset, "smoke");
      this.pools[kind] = [];
      for (let i = 0; i < POOL_SIZES[kind]; i++) {
        this.pools[kind].push(new Emitter(kind, preset, fireGeo, smokeGeo, fireMat, smokeMat, scene));
      }
    }
  }

  _acquire(kind) {
    const pool = this.pools[kind];
    let e = pool.find(p => !p.active);
    if (!e) {
      if (kind === "body") return null;
      e = pool.reduce((a, b) => (a.time < b.time ? a : b));
    }
    e.active = true;
    e.setVisible(true);
    return e;
  }

  _release(e) {
    e.active = false;
    e.target = null;
    e.setVisible(false);
    e.setCenter(HIDE.x, HIDE.y, HIDE.z);
  }

  /** Burning puddle (molotov). Fades in, burns for `duration`, fades out over the last second. */
  ground(x, z, radius, duration) {
    const e = this._acquire("ground");
    e.time = duration;
    e.setCenter(x, 0.02, z);
    e.setShape(radius * 0.92, this.pools.ground[0].preset.height);
    e.setStrength(0);
    e.fadeIn = 0;
    return e;
  }

  /** One-shot fireball + smoke column (grenade). */
  blast(x, y, z) {
    const e = this._acquire("blast");
    e.time = 0;
    e.setCenter(x, y, z);
    e.setStrength(1);
    e.fire.material.uniforms.uStart.value = this.time.value;
    e.smoke.material.uniforms.uStart.value = this.time.value;
  }

  /**
   * Keeps a body fire on every burning zombie (zombie.burnTimer > 0), following
   * it while it runs and lying flat on the corpse after it dies.
   */
  syncBodies(zombies, px, pz) {
    for (const e of this.pools.body) {
      if (!e.active) continue;
      const z = e.target;
      if (!z || !z.active || !(z.burnTimer > 0)) {
        if (z) z.fireEmitter = null;
        this._release(e);
        continue;
      }
      const r = z.root.position;
      e.setCenter(r.x, r.y + (z.dying ? 0.05 : 0.15), r.z);
      if (z.dying) e.setShape(0.85, 0.45);
      else e.setShape(0.32, 1.9);
      e.setStrength(Math.min(1, z.burnTimer * 1.5));
    }
    for (const z of zombies) {
      if (!(z.burnTimer > 0) || z.fireEmitter) continue;
      const dx = z.root.position.x - px, dz = z.root.position.z - pz;
      if (dx * dx + dz * dz > 80 * 80) continue;
      const e = this._acquire("body");
      if (!e) break;
      e.target = z;
      z.fireEmitter = e;
    }
  }

  clear() {
    for (const pool of Object.values(this.pools)) for (const e of pool) if (e.active) this._release(e);
  }

  /** Makes every emitter visible so renderer.compile() builds the programs up front. */
  setWarmup(on) {
    for (const pool of Object.values(this.pools)) for (const e of pool) if (!e.active) e.setVisible(on);
  }

  update(delta) {
    this.time.value += delta;
    for (const e of this.pools.ground) {
      if (!e.active) continue;
      e.time -= delta;
      e.fadeIn = Math.min(1, e.fadeIn + delta * 3);
      if (e.time <= 0) { this._release(e); continue; }
      e.setStrength(Math.min(e.fadeIn, e.time));
    }
    for (const e of this.pools.blast) {
      if (!e.active) continue;
      e.time += delta;
      if (e.time > e.preset.smoke.life + 0.1) this._release(e);
    }
  }
}
