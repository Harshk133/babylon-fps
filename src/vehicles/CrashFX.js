import * as THREE from "three";

// What a vehicle throws off when it hits something: white-hot sparks and tumbling
// shards (glass, paint, plastic, wood chips off a tree). Like DustFX, each piece's whole
// flight is computed in the vertex shader from one time uniform: emitting writes a piece's
// start and velocity into a ring buffer, and nothing else touches it. Gravity and one
// bounce off the ground are solved in closed form, so a piece needs no per-frame CPU.
//
// Two draw calls while anything is flying, none otherwise.

const MAX_SPARKS = 512;
const MAX_SHARDS = 192;
const GRAVITY = 9.8;

// Where a falling piece is at `age`: thrown from aStart at aVel, bouncing once off
// `ground` (it loses most of its speed there, and sparks skitter along the road)
const FLIGHT = /* glsl */ `
  vec3 flight(vec3 o, vec3 v, float ground, float bounce, float age) {
    float h = max(o.y - ground, 0.0);
    float hit = (v.y + sqrt(v.y * v.y + 2.0 * ${GRAVITY.toFixed(1)} * h)) / ${GRAVITY.toFixed(1)};
    if (age < hit) return o + v * age + vec3(0.0, -0.5 * ${GRAVITY.toFixed(1)} * age * age, 0.0);
    vec3 at = vec3(o.x + v.x * hit, ground, o.z + v.z * hit);
    float up = (${GRAVITY.toFixed(1)} * hit - v.y) * bounce;
    float t = age - hit;
    return at + vec3(v.x * 0.55 * t, max(0.0, up * t - 0.5 * ${GRAVITY.toFixed(1)} * t * t), v.z * 0.55 * t);
  }
`;

const SPARK_VERT = /* glsl */ `
  uniform float uTime;
  attribute vec4 aStart;   // xyz origin, w start time
  attribute vec4 aVel;     // xyz velocity, w life
  attribute vec4 aMisc;    // x ground height, y width, z tail seconds, w brightness
  varying vec2 vUv;
  varying vec3 vColor;
  ${FLIGHT}
  void main() {
    float age = uTime - aStart.w;
    if (age < 0.0 || age > aVel.w) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float life = age / aVel.w;
    // A streak from where it was a moment ago to where it is: the fast ones draw long lines
    vec4 head = modelViewMatrix * vec4(flight(aStart.xyz, aVel.xyz, aMisc.x, 0.4, age), 1.0);
    vec4 tail = modelViewMatrix * vec4(flight(aStart.xyz, aVel.xyz, aMisc.x, 0.4, max(0.0, age - aMisc.z)), 1.0);
    vec2 dir = head.xy - tail.xy;
    float len = length(dir);
    dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
    vec2 across = vec2(-dir.y, dir.x);
    vec4 mv = mix(tail, head, position.y + 0.5);
    float w = aMisc.y * (1.0 - life * 0.65);
    mv.xy += across * position.x * w + dir * (position.y) * w;
    gl_Position = projectionMatrix * mv;
    vUv = uv;
    // White hot, then yellow, orange, and a dull red as it dies
    vec3 hot = mix(vec3(1.0, 0.92, 0.72), vec3(1.0, 0.55, 0.14), smoothstep(0.08, 0.5, life));
    hot = mix(hot, vec3(0.7, 0.13, 0.03), smoothstep(0.55, 1.0, life));
    vColor = hot * aMisc.w * (1.0 - smoothstep(0.82, 1.0, life));
  }
`;
const SPARK_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vec2 q = (vUv - 0.5) * 2.0;
    float a = (1.0 - q.x * q.x) * (1.0 - q.y * q.y * q.y * q.y);
    gl_FragColor = vec4(vColor * a * a, 1.0);
  }
`;

const SHARD_VERT = /* glsl */ `
  uniform float uTime;
  attribute vec4 aStart;   // xyz origin, w start time
  attribute vec4 aVel;     // xyz velocity, w life
  attribute vec4 aSpin;    // xyz tumble axis × speed, w ground height
  attribute vec4 aTint;    // rgb colour, a size
  attribute float aGloss;  // how much it glints as it turns (glass 1, wood 0)
  varying vec2 vUv;
  varying vec3 vColor;
  ${FLIGHT}
  vec3 turn(vec3 p, vec3 axis, float a) {
    float c = cos(a), s = sin(a);
    return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
  }
  void main() {
    float age = uTime - aStart.w;
    if (age < 0.0 || age > aVel.w) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float spin = length(aSpin.xyz);
    vec3 axis = aSpin.xyz / max(spin, 0.001);
    // It stops tumbling once it has come to rest on the ground
    float h = max(aStart.y - aSpin.w, 0.0);
    float land = (aVel.y + sqrt(aVel.y * aVel.y + 19.6 * h)) / 9.8 + 0.6;
    float angle = spin * min(age, land);
    float shrink = 1.0 - smoothstep(0.8, 1.0, age / aVel.w);
    vec3 at = flight(aStart.xyz, aVel.xyz, aSpin.w + 0.02, 0.3, age);
    vec3 local = turn(vec3(position.xy * aTint.a * shrink, 0.0), axis, angle);
    vec4 mv = modelViewMatrix * vec4(at + local, 1.0);
    gl_Position = projectionMatrix * mv;
    vUv = uv;
    // Lit by how it faces up, with a glint when it catches the sun
    vec3 n = turn(vec3(0.0, 0.0, 1.0), axis, angle);
    float face = 0.55 + 0.45 * abs(n.y);
    float glint = pow(abs(dot(n, normalize(vec3(0.3, 0.8, 0.5)))), 24.0) * aGloss;
    vColor = aTint.rgb * face + vec3(1.6) * glint;
  }
`;
const SHARD_FRAG = /* glsl */ `
  uniform float uLight;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    // A jagged triangle rather than a square
    if (vUv.x + vUv.y * 0.8 > 1.0) discard;
    gl_FragColor = vec4(vColor * uLight, 1.0);
  }
`;

/** Shard colours: [r, g, b, gloss]. */
const GLASS = [0.72, 0.86, 0.9, 1], LAMP = [0.95, 0.9, 0.72, 1], BLACK = [0.07, 0.07, 0.08, 0.3];
const WOOD = [0.36, 0.25, 0.15, 0], BARK = [0.2, 0.15, 0.1, 0], GRIT = [0.5, 0.47, 0.43, 0];

function instanced(count, attrs) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute("position", base.getAttribute("position"));
  geo.setAttribute("uv", base.getAttribute("uv"));
  const out = { geo };
  for (const [name, size] of attrs) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    out[name] = a;
  }
  // Nothing alive until something is written
  for (let i = 0; i < count; i++) out.aStart.setW(i, -1e4);
  geo.instanceCount = count;
  return out;
}

export const CRASH_KIND = { HARD: 0, TREE: 1, EDGE: 2 };

export class CrashFX {
  /** density: 0..1 how many pieces a crash throws (phones and Low take fewer). */
  constructor(scene, density = 1) {
    this.density = density;
    this.time = 0;
    this.uTime = { value: 0 };
    this.uLight = { value: 1 };
    this.sparks = instanced(MAX_SPARKS, [["aStart", 4], ["aVel", 4], ["aMisc", 4]]);
    this.shards = instanced(MAX_SHARDS, [["aStart", 4], ["aVel", 4], ["aSpin", 4], ["aTint", 4], ["aGloss", 1]]);
    this.sparkMesh = new THREE.Mesh(this.sparks.geo, new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime }, vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false,
    }));
    this.shardMesh = new THREE.Mesh(this.shards.geo, new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uLight: this.uLight }, vertexShader: SHARD_VERT, fragmentShader: SHARD_FRAG, side: THREE.DoubleSide,
    }));
    for (const m of [this.sparkMesh, this.shardMesh]) {
      m.frustumCulled = false;
      m.renderOrder = 3;
      m.visible = true;       // (until warm-up is over, so its programs compile with the rest)
      m.matrixAutoUpdate = false;
      scene.add(m);
    }
    this.nextSpark = this.nextShard = 0;
    this.sparkUntil = this.shardUntil = 0;
    this.warm = true;
    this.dirtySparks = this.dirtyShards = false;
  }

  /** Warm-up is done: from now on the meshes are drawn only while something flies. */
  endWarmup() { this.warm = false; }

  _spark(x, y, z, vx, vy, vz, ground, life, width, tail, bright) {
    const s = this.sparks, i = this.nextSpark;
    this.nextSpark = (i + 1) % MAX_SPARKS;
    s.aStart.setXYZW(i, x, y, z, this.time);
    s.aVel.setXYZW(i, vx, vy, vz, life);
    s.aMisc.setXYZW(i, ground, width, tail, bright);
    this.sparkUntil = Math.max(this.sparkUntil, this.time + life);
    this.dirtySparks = true;
  }

  _shard(x, y, z, vx, vy, vz, ground, size, life, c) {
    const s = this.shards, i = this.nextShard;
    this.nextShard = (i + 1) % MAX_SHARDS;
    s.aStart.setXYZW(i, x, y, z, this.time);
    s.aVel.setXYZW(i, vx, vy, vz, life);
    const sp = 8 + Math.random() * 22;
    let ax = Math.random() - 0.5, ay = Math.random() - 0.5, az = Math.random() - 0.5;
    const l = Math.hypot(ax, ay, az) || 1;
    ax *= sp / l; ay *= sp / l; az *= sp / l;
    s.aSpin.setXYZW(i, ax, ay, az, ground);
    s.aTint.setXYZW(i, c[0], c[1], c[2], size);
    s.aGloss.setX(i, c[3]);
    this.shardUntil = Math.max(this.shardUntil, this.time + life);
    this.dirtyShards = true;
  }

  /**
   * The moment of impact at (x, z), from yLo to yHi above the ground. (nx, nz): the surface's
   * normal, toward the vehicle. (vx, vz): the vehicle's velocity. strength 0..1. body: the
   * vehicle's paint [r, g, b, gloss], kind: CRASH_KIND. Sparks fan out off the surface and
   * are carried along with the vehicle's motion; a hard hit also breaks things.
   */
  burst(x, z, ground, yLo, yHi, nx, nz, vx, vz, strength, body, kind = CRASH_KIND.HARD) {
    const d = this.density;
    const tree = kind === CRASH_KIND.TREE;
    const n = Math.round((tree ? 4 + 8 * strength : 14 + 110 * strength) * d);
    for (let i = 0; i < n; i++) {
      const out = (1.5 + Math.random() * Math.random() * 11) * (0.6 + strength * 0.9);
      const a = (Math.random() - 0.5) * 2.6, ca = Math.cos(a), sa = Math.sin(a);
      // The surface's normal fanned round, plus a share of the vehicle's own momentum
      const dx = nx * ca - nz * sa, dz = nz * ca + nx * sa;
      const carry = 0.1 + Math.random() * 0.4;
      this._spark(
        x + (Math.random() - 0.5) * 0.3, yLo + Math.random() * (yHi - yLo), z + (Math.random() - 0.5) * 0.3,
        dx * out + vx * carry, 0.4 + Math.random() * 5 * (0.5 + strength), dz * out + vz * carry,
        ground, 0.25 + Math.random() * (0.45 + strength * 0.75), 0.022 + Math.random() * 0.028, 0.03 + Math.random() * 0.025, 2.2 + Math.random() * 1.6,
      );
    }
    // The flash where it hit: one big soft spark that barely moves
    if (strength > 0.2 && !tree) this._spark(x, (yLo + yHi) / 2, z, nx * 0.5, 0.3, nz * 0.5, ground, 0.09, 0.5 + strength * 0.9, 0, 1.8);

    const pieces = tree
      ? Math.round((6 + 22 * strength) * d)
      : strength < 0.22 ? 0 : Math.round((5 + 38 * strength) * d);
    for (let i = 0; i < pieces; i++) {
      const r = Math.random();
      const c = tree ? (r < 0.6 ? WOOD : BARK)
        : kind === CRASH_KIND.EDGE ? GRIT
          : r < 0.34 ? GLASS : r < 0.46 ? LAMP : r < 0.68 ? BLACK : r < 0.92 ? body : GRIT;
      const out = 1 + Math.random() * (3 + strength * 6);
      const a = (Math.random() - 0.5) * 2.9, ca = Math.cos(a), sa = Math.sin(a);
      const carry = 0.25 + Math.random() * 0.45;
      const small = c === GLASS || c === LAMP;
      this._shard(
        x + nx * 0.1, yLo + Math.random() * (yHi - yLo), z + nz * 0.1,
        (nx * ca - nz * sa) * out + vx * carry, 0.8 + Math.random() * (2.4 + strength * 3.6), (nz * ca + nx * sa) * out + vz * carry,
        ground, (small ? 0.035 + Math.random() * 0.05 : 0.05 + Math.random() * 0.1), 3.5 + Math.random() * 4, c,
      );
    }
  }

  /** Metal dragged along a surface: a stream of sparks. rate: pieces this call may throw. */
  scrape(x, z, ground, yLo, yHi, nx, nz, vx, vz, rate) {
    const n = Math.min(14, Math.floor(rate * this.density + Math.random()));
    for (let i = 0; i < n; i++) {
      // Dragged off in the direction of travel, bouncing away from the wall and the road
      const k = 0.35 + Math.random() * 0.55, off = 0.3 + Math.random() * 2.4;
      this._spark(
        x, yLo + Math.random() * (yHi - yLo), z,
        vx * k + nx * off, 0.2 + Math.random() * 2.2, vz * k + nz * off,
        ground, 0.2 + Math.random() * 0.45, 0.018 + Math.random() * 0.022, 0.03, 2.4 + Math.random() * 1.4,
      );
    }
  }

  /** Every frame. light: 0..1 scene brightness (a shard isn't glowing at night; sparks are). */
  update(delta, light = 1) {
    this.time += delta;
    this.uTime.value = this.time;
    this.uLight.value = light;
    if (this.dirtySparks) {
      const s = this.sparks;
      s.aStart.needsUpdate = s.aVel.needsUpdate = s.aMisc.needsUpdate = true;
      this.dirtySparks = false;
    }
    if (this.dirtyShards) {
      const s = this.shards;
      s.aStart.needsUpdate = s.aVel.needsUpdate = s.aSpin.needsUpdate = s.aTint.needsUpdate = s.aGloss.needsUpdate = true;
      this.dirtyShards = false;
    }
    this.sparkMesh.visible = this.warm || this.time < this.sparkUntil;
    this.shardMesh.visible = this.warm || this.time < this.shardUntil;
  }
}
