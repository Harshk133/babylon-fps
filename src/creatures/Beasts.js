import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GROUP_ZOMBIE } from "../physicsGroups.js";

// The things that come out of the asteroid's crater: giant snakes and giant
// spiders. They share one brain (below): they prowl about, notice whoever comes
// close, chase for a while, lose interest and rest; pace() sets how hard they press,
// and a battle royale is given plenty of room. A bite that connects holds you in the
// jaws; shoot it hard enough and it lets go, otherwise you're eaten. Whoever's bitten
// is left alone for a while afterwards. Two or more players hurting one at about
// the same time finish it on the spot. The host runs them and streams the poses.

export const EMERGE = 0, HUNT = 1, REAR = 2, STRIKE = 3, HOLDING = 4, RECOIL = 5, DEAD = 6, PROWL = 7;
const HOLD = 3.5, FREE_AT = 220, TEAM_WINDOW = 4;
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _c = new THREE.Color();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();
const IDENT = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const lerpAngle = (a, b, k) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};
const instanced = (scene, geo, mat, n, shadow = true) => {
  const im = new THREE.InstancedMesh(geo, mat, n);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.frustumCulled = false;
  im.castShadow = shadow;
  im.count = 0;
  im.visible = false;
  scene.add(im);
  return im;
};

class Beasts {
  /**
   * g: scene, world, material, net, groundAt(x, z), targets() → [{ id, x, y, z, bot }], pace() →
   * { speed, sense, chase, rest, mercy }, mercy (Map id → until), hurt(id, dmg, x, z), grab(id, owner, slot, on),
   * plough(x, z), onKill(owner, slot, by, team), hiss(x, z).
   */
  constructor(g, kind, max, tune) {
    this.g = g;
    this.kind = kind;       // on the wire: "n" snake, "p" spider
    this.tune = tune;       // { hp, strikeAt, biteAt, lunge, turn, label, colliders: [radius…] }
    this.netT = 0;
    this.slots = Array.from({ length: max }, (_, i) => {
      const s = {
        i, active: false, head: null, bodies: [],
        x: 0, z: 0, h: 0, rear: 0, jaw: 0, hp: 0, state: EMERGE, t: 0, target: null, think: 0, phase: i * 1.7,
        nx: 0, nz: 0, nh: 0, nrear: 0, njaw: 0, holding: null, holdDmg: 0, ploughT: 0, rise: 0,
        homeX: 0, homeZ: 0, goalX: 0, goalZ: 0, chase: 0, hitters: new Map(), speed: 0, air: 0,
      };
      tune.colliders.forEach((r, k) => {
        const b = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, collisionFilterGroup: GROUP_ZOMBIE, collisionFilterMask: 0, material: g.material });
        b.addShape(new CANNON.Sphere(r));
        b.beast = { owner: this, i, head: k === 0 };
        s.bodies.push(b);    // (in the physics world only while this one is alive)
      });
      this._makeSlot(s);
      return s;
    });
  }

  get liveCount() { return this.slots.reduce((n, s) => n + (s.active && s.state !== DEAD ? 1 : 0), 0); }
  get hasRoom() { return this.slots.some(s => !s.active); }

  clear() {
    for (const s of this.slots) {
      if (s.holding !== null) this.g.grab(s.holding, this, s.i, false);
      this._park(s);
    }
    this._render(0);
  }

  _park(s) {
    s.active = false;
    s.holding = null;
    s.head.visible = false;
    for (const b of s.bodies) if (b.world) this.g.world.removeBody(b);
  }

  spawnAt(x, z, homeX = x, homeZ = z) {
    const s = this.slots.find(q => !q.active);
    if (!s) return false;
    this._activate(s, x, z);
    s.homeX = homeX; s.homeZ = homeZ;
    this.g.hiss(x, z);
    return true;
  }

  _activate(s, x, z) {
    Object.assign(s, { active: true, x, z, nx: x, nz: z, h: Math.random() * 6.28, rear: 1, jaw: 0.3, hp: this.tune.hp, state: EMERGE, t: 0, target: null, think: 0, holding: null, holdDmg: 0, rise: 0, chase: 0, speed: 0, air: 0 });
    s.nh = s.h; s.nrear = 1; s.njaw = 0.3;
    s.hitters.clear();
    s.head.visible = true;
    for (const b of s.bodies) if (!b.world) { b.position.set(x, -600, z); this.g.world.addBody(b); }
    this._onSpawn(s);
  }

  // ── Damage ───────────────────────────────────────────────────────────────
  hit(slot, dmg, by, head = false) {
    const s = this.slots[slot];
    if (!s?.active || s.state === DEAD) return;
    if (this.g.net.isClient) { this.g.net.send({ t: "snh", k: this.kind, to: "host", i: slot, d: +dmg.toFixed(1), h: head ? 1 : 0 }); return; }
    const d = head ? dmg * 2 : dmg;
    s.hp -= d;
    // Being hit wakes it up: it goes for whoever's nearest
    if (s.state === PROWL) { s.state = HUNT; s.chase = this.g.pace().chase; s.think = 0; }
    if (s.state === HOLDING) {
      s.holdDmg += d;
      if (s.holdDmg >= FREE_AT) this._release(s, RECOIL, 2.5);
    }
    // Two or more people on it at once: that's the end of it
    if (by !== null && by !== undefined) {
      const now = performance.now() / 1000;
      s.hitters.set(by, now);
      for (const [id, t] of s.hitters) if (now - t > TEAM_WINDOW) s.hitters.delete(id);
      if (s.hitters.size >= 2) { this._die(s, by, true); return; }
    }
    if (s.hp <= 0) this._die(s, by, false);
  }

  blast(x, z, radius, dmg, by) {
    if (this.g.net.isClient) return;
    for (const s of this.slots) {
      if (!s.active || s.state === DEAD) continue;
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < radius + 3) this.hit(s.i, dmg * (1 - Math.min(1, d / (radius + 3))) * 2.2, by);
    }
  }

  _release(s, state, time) {
    if (s.holding !== null) this.g.grab(s.holding, this, s.i, false);
    s.holding = null;
    s.state = state;
    s.t = time;
  }

  _die(s, by, team) {
    this._release(s, DEAD, 0);
    this.g.onKill(this, s.i, by, team);
  }

  mouth(slot, out) {
    const s = this.slots[slot];
    s.head.updateWorldMatrix(true, false);
    return out.set(0, -0.2, 2.4).applyMatrix4(s.head.matrixWorld);
  }

  // ── Per frame ────────────────────────────────────────────────────────────
  update(delta) {
    if (delta <= 0) return;
    const host = !this.g.net.isClient;
    for (const s of this.slots) {
      if (!s.active) continue;
      if (host) this._think(s, delta); else this._follow(s, delta);
    }
    this._render(delta);
    if (host && this.g.net.inRoom) {
      this.netT -= delta;
      if (this.netT <= 0) { this.netT = 0.1; this._send(); }
    }
  }

  _nearest(s, sense) {
    const now = performance.now() / 1000;
    let best = null, bd = sense;
    for (const t of this.g.targets()) {
      if ((this.g.mercy.get(t.id) ?? 0) > now) continue;   // it's just had them: they get a head start
      const d = Math.hypot(t.x - s.x, t.z - s.z);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  _prowl(s, time) {
    s.state = PROWL;
    s.t = time;
    s.target = null;
    this._pickGoal(s);
  }

  _pickGoal(s) {
    const a = Math.random() * 6.28, r = 12 + Math.random() * 34;
    s.goalX = s.homeX + Math.cos(a) * r;
    s.goalZ = s.homeZ + Math.sin(a) * r;
  }

  _walk(s, x, z, speed, wiggle, delta) {
    const want = Math.atan2(x - s.x, z - s.z) + wiggle;
    s.h = lerpAngle(s.h, want, Math.min(1, this.tune.turn * delta * 2));
    s.x += Math.sin(s.h) * speed * delta;
    s.z += Math.cos(s.h) * speed * delta;
    s.speed = speed;
  }

  _think(s, delta) {
    const T = this.tune, P = this.g.pace();
    s.t -= delta;
    s.phase += delta * 2.4;
    s.speed = 0;
    const t = s.target;
    const ease = (key, to, rate) => { s[key] += (to - s[key]) * (1 - Math.exp(-rate * delta)); };
    switch (s.state) {
      case EMERGE:
        s.rise = Math.min(1, s.rise + delta / 2.2);
        s.rear = 1; s.jaw = 0.55;
        if (s.rise >= 1) this._prowl(s, P.rest * 0.6);   // looks round first: nobody's eaten the moment it's out
        break;
      case PROWL: {
        ease("rear", 0.08, 5); ease("jaw", 0.08, 6);
        if (Math.hypot(s.goalX - s.x, s.goalZ - s.z) < 4) this._pickGoal(s);
        this._walk(s, s.goalX, s.goalZ, P.speed * 0.45, Math.sin(s.phase) * 0.55, delta);
        if (s.t <= 0 && (s.think -= delta) <= 0) {
          s.think = 0.5;
          s.target = this._nearest(s, P.sense);
          if (s.target) { s.state = HUNT; s.chase = P.chase; }
        }
        break;
      }
      case HUNT: {
        ease("rear", 0.08, 5); ease("jaw", 0.08, 6);
        s.chase -= delta;
        if ((s.think -= delta) <= 0) { s.think = 0.4; s.target = this._nearest(s, P.sense * 1.3); }
        const tt = s.target;
        if (!tt || s.chase <= 0) { this._prowl(s, P.rest); break; }  // gives up: time to fight each other
        const d = Math.hypot(tt.x - s.x, tt.z - s.z);
        this._walk(s, tt.x, tt.z, P.speed, Math.sin(s.phase) * 0.55, delta);
        if ((s.ploughT -= delta) <= 0) { s.ploughT = 0.8; this.g.plough(s.x, s.z); }
        if (d < T.strikeAt) { s.state = REAR; s.t = 0.7; this.g.hiss(s.x, s.z); }
        break;
      }
      case REAR:
        ease("rear", 1, 11); ease("jaw", 1, 9);
        if (t) s.h = lerpAngle(s.h, Math.atan2(t.x - s.x, t.z - s.z), Math.min(1, 7 * delta));
        if (s.t <= 0) { s.state = STRIKE; s.t = 0.5; }
        break;
      case STRIKE: {
        ease("rear", 0.3, 9);
        s.air = Math.sin(Math.min(1, 1 - s.t / 0.5) * Math.PI);
        s.x += Math.sin(s.h) * T.lunge * delta;
        s.z += Math.cos(s.h) * T.lunge * delta;
        s.speed = T.lunge;
        const hit = t && this.g.targets().includes(t) && Math.hypot(t.x - s.x, t.z - s.z) < T.biteAt ? t : null;
        if (hit) {
          this.g.hurt(hit.id, T.bite, s.x, s.z);
          s.jaw = 0.45; s.air = 0;
          if (hit.bot) { this.g.mercy.set(hit.id, performance.now() / 1000 + P.mercy); this._prowl(s, P.rest); }
          else { s.holding = hit.id; s.holdDmg = 0; s.state = HOLDING; s.t = HOLD; this.g.grab(hit.id, this, s.i, true); }
        } else if (s.t <= 0) { s.air = 0; s.state = RECOIL; s.t = 1.3; }
        break;
      }
      case HOLDING:
        ease("rear", 0.85, 4); ease("jaw", 0.4, 6);
        if (s.t <= 0) {
          const v = s.holding;
          this._release(s, RECOIL, 2);
          this.g.mercy.set(v, performance.now() / 1000 + P.mercy);
          this.g.hurt(v, 9999, s.x, s.z);   // eaten
          s.chase = 0;
        }
        break;
      case RECOIL:
        ease("rear", 0.05, 5); ease("jaw", 0.05, 6);
        if (s.t <= 0) this._prowl(s, P.rest);
        break;
      case DEAD:
        ease("rear", 0, 3); ease("jaw", 0.7, 3);
        s.air = 0;
        if (s.t <= -5) this._park(s);
        break;
    }
  }

  _follow(s, delta) {
    const k = 1 - Math.exp(-12 * delta), px = s.x, pz = s.z;
    s.x += (s.nx - s.x) * k;
    s.z += (s.nz - s.z) * k;
    s.h = lerpAngle(s.h, s.nh, k);
    s.rear += (s.nrear - s.rear) * k;
    s.jaw += (s.njaw - s.jaw) * k;
    s.rise = Math.min(1, s.rise + delta / 2.2);
    s.speed = Math.hypot(s.x - px, s.z - pz) / delta;
    s.air = s.state === STRIKE ? Math.min(1, s.air + delta * 5) : Math.max(0, s.air - delta * 5);
    if (s.state === DEAD) s.t -= delta;
  }

  _send() {
    const l = [];
    for (const s of this.slots) {
      if (s.active) l.push(s.i, +s.x.toFixed(1), +s.z.toFixed(1), +s.h.toFixed(2), +s.rear.toFixed(2), +s.jaw.toFixed(2), s.state, Math.max(0, Math.round(s.hp)));
    }
    this.g.net.send({ t: "sn", k: this.kind, l });
  }

  applyNet(l) {
    const seen = new Set();
    for (let k = 0; k + 7 < l.length; k += 8) {
      const s = this.slots[l[k]];
      if (!s) continue;
      seen.add(s.i);
      if (!s.active) this._activate(s, l[k + 1], l[k + 2]);
      [s.nx, s.nz, s.nh, s.nrear, s.njaw, s.state, s.hp] = [l[k + 1], l[k + 2], l[k + 3], l[k + 4], l[k + 5], l[k + 6], l[k + 7]];
    }
    for (const s of this.slots) if (s.active && !seen.has(s.i)) this._park(s);
  }

  _deadSink(s) { return s.state === DEAD ? Math.min(1, -s.t / 5) : 0; }
}

// ── Snakes ───────────────────────────────────────────────────────────────────
const SEGMENTS = 64, STEP = 0.25, TRAIL = 400, EVERY = 2;
const girth = t => 0.4 + 1.1 * Math.sin(Math.min(1, t * 1.25 + 0.14) * Math.PI) ** 0.7;
const snakeSkin = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0.22 });
const boneMat = new THREE.MeshStandardMaterial({ color: 0xd8d0b4, roughness: 0.4 });
const lavaEye = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.9, 0.12) });
const mouthMat = new THREE.MeshStandardMaterial({ color: 0xa3121f, roughness: 0.42, emissive: 0x3a0408 });

function snakeHead() {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x17120f, roughness: 0.3, metalness: 0.35 });
  const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, rz = 0, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, 0, rz); m.castShadow = true; parent.add(m); return m; };
  add(new THREE.SphereGeometry(1, 16, 12).scale(1.5, 0.78, 2.1).translate(0, 0.28, 0.7), skin);
  add(new THREE.SphereGeometry(1, 14, 8).scale(1.2, 0.22, 1.85).translate(0, -0.14, 0.95), mouthMat);
  const brow = new THREE.BoxGeometry(1.2, 0.18, 0.55);
  for (const sx of [-1, 1]) {
    add(new THREE.SphereGeometry(0.27, 10, 8), lavaEye, sx * 0.98, 0.68, 1.2);
    add(brow, skin, sx * 0.78, 0.98, 1.2, 0.28, sx * 0.5);                // an angry brow
    add(new THREE.ConeGeometry(0.2, 1.7, 8), boneMat, sx * 0.86, 1.3, -0.45, -0.95, -sx * 0.32);   // horns
    add(new THREE.ConeGeometry(0.13, 0.85, 7), boneMat, sx * 1.15, 0.8, -0.65, -1.1, -sx * 0.7);
    add(new THREE.ConeGeometry(0.15, 1.25, 8).rotateX(Math.PI), boneMat, sx * 0.62, -0.62, 2.1);   // fangs
    add(new THREE.ConeGeometry(0.08, 0.55, 6).rotateX(Math.PI), boneMat, sx * 0.9, -0.35, 1.55);
  }
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.15, -0.4);
  add(new THREE.SphereGeometry(1, 14, 8).scale(1.3, 0.28, 1.95).translate(0, -0.12, 1.3), skin, 0, 0, 0, 0, 0, jaw);
  add(new THREE.SphereGeometry(1, 12, 8).scale(1.05, 0.14, 1.6).translate(0, 0.08, 1.35), mouthMat, 0, 0, 0, 0, 0, jaw);
  for (const sx of [-1, 1]) add(new THREE.ConeGeometry(0.1, 0.6, 7), boneMat, sx * 0.65, 0.42, 2.5, 0, 0, jaw);
  g.add(jaw);
  g.scale.setScalar(1.35);
  g.visible = false;
  g.userData.jaw = jaw;
  return g;
}

export class GiantSnakes extends Beasts {
  constructor(g) {
    super(g, "n", 3, { hp: 1200, strikeAt: 11, biteAt: 3.4, lunge: 19, turn: 1.9, bite: 30, label: "SNAKE", colliders: Array(8).fill(1.5) });
    const n = this.slots.length;
    this.mesh = instanced(g.scene, new THREE.SphereGeometry(1, 12, 9), snakeSkin, n * SEGMENTS);
    this.spikes = instanced(g.scene, new THREE.ConeGeometry(0.42, 1.5, 6).translate(0, 0.75, 0), boneMat, n * SEGMENTS, false);
    this.mesh.receiveShadow = true;
    // Black with burning orange saddles and a gold fleck: a warning, not a camouflage
    for (let i = 0; i < n * SEGMENTS; i++) {
      const k = i % SEGMENTS;
      const band = Math.sin(k * 0.78) > 0.5;
      this.mesh.setColorAt(i, _c.set(band ? 0xd2470c : k % 5 === 0 ? 0x8a6a1f : 0x16100d));
    }
  }

  _makeSlot(s) {
    s.head = snakeHead();
    this.g.scene.add(s.head);
    s.trail = new Float32Array(TRAIL * 2);
    s.at = 0;
  }

  _onSpawn(s) {
    s.at = 0;
    for (let i = 0; i < TRAIL; i++) { s.trail[i * 2] = s.x; s.trail[i * 2 + 1] = s.z; }
  }

  parts() { return [this.mesh, this.spikes, ...this.slots.map(s => s.head)]; }

  _pushTrail(s) {
    let px = s.trail[s.at * 2], pz = s.trail[s.at * 2 + 1], d = Math.hypot(s.x - px, s.z - pz);
    while (d >= STEP) {
      const k = STEP / d;
      px += (s.x - px) * k; pz += (s.z - pz) * k;
      s.at = (s.at + 1) % TRAIL;
      s.trail[s.at * 2] = px; s.trail[s.at * 2 + 1] = pz;
      d = Math.hypot(s.x - px, s.z - pz);
    }
  }

  _render() {
    const g = this.g.groundAt;
    let n = 0, sp = 0;
    for (const s of this.slots) {
      if (!s.active) continue;
      this._pushTrail(s);
      const sink = (1 - s.rise) * 12 + this._deadSink(s) * 5;
      let k = 0;
      for (let i = 0; i < SEGMENTS; i++) {
        const idx = ((s.at - i * EVERY) % TRAIL + TRAIL) % TRAIL;
        const x = i === 0 ? s.x : s.trail[idx * 2], z = i === 0 ? s.z : s.trail[idx * 2 + 1];
        const r = girth(i / (SEGMENTS - 1));
        const lift = i < 16 ? s.rear * 6.4 * Math.cos((i / 16) * Math.PI / 2) ** 1.5 : 0;
        const y = g(x, z) + r * 0.82 + lift - sink * (1 - i / SEGMENTS * 0.3);
        this.mesh.setMatrixAt(n++, _m.compose(_p.set(x, y, z), IDENT, _s.setScalar(r)));
        if (i % 2 === 0 && i > 4) this.spikes.setMatrixAt(sp++, _m.compose(_p.set(x, y + r * 0.72, z), IDENT, _s.setScalar(r * 0.8)));
        if (i % 8 === 0 && k < 8) {
          const b = s.bodies[k++];
          b.position.set(x, s.state === DEAD ? -600 : y, z);
          b.aabbNeedsUpdate = true;
        }
      }
      s.head.position.set(s.x, g(s.x, s.z) + 0.95 + s.rear * 6.4 - sink, s.z);
      s.head.rotation.set(s.state === STRIKE || s.state === HOLDING ? 0.32 : s.state === DEAD ? 0.5 : 0.08, s.h, 0, "YXZ");
      s.head.userData.jaw.rotation.x = s.jaw * 1.05;
    }
    for (const [m, c] of [[this.mesh, n], [this.spikes, sp]]) {
      m.count = c;
      m.visible = c > 0;
      if (c) m.instanceMatrix.needsUpdate = true;
    }
    if (this.mesh.instanceColor && !this._colored) { this.mesh.instanceColor.needsUpdate = true; this._colored = true; }
  }
}

// ── Spiders ──────────────────────────────────────────────────────────────────
const LEGS = 8, L1 = 4.2, L2 = 5.8, STRIDE = 3, STEP_TIME = 0.17;
// Hip on the body and foot at rest, in the body's frame (right side; the left mirrors it)
const HIPS = [[1.3, 1.9, 2.1], [1.6, 1.9, 0.8], [1.6, 1.9, -0.6], [1.3, 1.9, -1.9]];
const REST = [[6.0, 0, 6.8], [7.8, 0, 2.3], [7.8, 0, -2.5], [6.0, 0, -7]];
const spiderBlack = new THREE.MeshStandardMaterial({ color: 0x0d0b0c, roughness: 0.38, metalness: 0.3 });
const spiderRed = new THREE.MeshBasicMaterial({ color: new THREE.Color(4.5, 0.2, 0.08) });
const legMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.25 });

function spiderBody() {
  const g = new THREE.Group();
  const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, rz = 0, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, 0, rz); m.castShadow = true; parent.add(m); return m; };
  add(new THREE.SphereGeometry(1, 16, 12).scale(1.9, 1.05, 2.3), spiderBlack, 0, 0.1, 0.9);               // thorax
  const abdomen = add(new THREE.SphereGeometry(1, 18, 14).scale(3.1, 2.6, 3.8), spiderBlack, 0, 0.75, -4.2);
  // The marking on its back, glowing, and bristles down the spine
  add(new THREE.ConeGeometry(0.95, 1.9, 4).rotateX(-Math.PI / 2), spiderRed, 0, 3.32, -3.3, 0.18);
  add(new THREE.ConeGeometry(0.95, 1.9, 4).rotateX(Math.PI / 2), spiderRed, 0, 3.32, -5.25, -0.18);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2, z = -4.2 + Math.cos(a) * 2.9;
    for (const sx of [-1, 1]) add(new THREE.ConeGeometry(0.11, 1.15, 6), boneMat, sx * (1.5 + Math.sin(a) * 1.1), 2.75 - Math.abs(Math.cos(a)) * 0.9, z, Math.cos(a) * 0.5, -sx * 0.55);
  }
  // Eight eyes, in two rows
  for (const [x, y, z, r] of [[0.42, 0.95, 3.05, 0.26], [1.02, 0.86, 2.75, 0.22], [0.26, 1.28, 2.78, 0.17], [0.82, 1.22, 2.5, 0.15]]) {
    for (const sx of [-1, 1]) add(new THREE.SphereGeometry(r, 10, 8), spiderRed, sx * x, y, z);
  }
  const fangs = new THREE.Group();
  fangs.position.set(0, -0.3, 3.1);
  for (const sx of [-1, 1]) {
    add(new THREE.SphereGeometry(0.42, 10, 8).scale(1, 1.2, 1.1), spiderBlack, sx * 0.55, 0.1, 0, 0, 0, fangs);
    add(new THREE.ConeGeometry(0.2, 1.7, 8).rotateX(Math.PI), boneMat, sx * 0.55, -1, 0.28, 0.3, 0, fangs);
  }
  g.add(fangs);
  g.visible = false;
  g.userData.fangs = fangs;
  return g;
}

export class GiantSpiders extends Beasts {
  constructor(g) {
    super(g, "p", 3, { hp: 800, strikeAt: 13, biteAt: 4.2, lunge: 22, turn: 2.8, bite: 26, label: "SPIDER", colliders: [2, 3.2, 2.4] });
    const n = this.slots.length * LEGS * 2;
    const geo = new THREE.CylinderGeometry(0.17, 0.42, 1, 7);
    this.legs = instanced(g.scene, geo, legMat, n);
    for (let i = 0; i < n; i++) this.legs.setColorAt(i, _c.set(i % 2 ? 0x2b0507 : 0x0f0b0c));   // upper black, lower blood-dark
  }

  _makeSlot(s) {
    s.head = spiderBody();
    this.g.scene.add(s.head);
    s.feet = Array.from({ length: LEGS }, () => ({ x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, t: 1 }));
    s.bodyY = 0;
  }

  _onSpawn(s) {
    s.bodyY = this.g.groundAt(s.x, s.z) - 8;
    for (let i = 0; i < LEGS; i++) {
      const f = s.feet[i];
      this._rest(s, i, _a);
      f.x = f.fx = f.tx = _a.x; f.z = f.fz = f.tz = _a.z; f.y = f.fy = f.ty = _a.y;
      f.t = 1;
    }
  }

  parts() { return [this.legs, ...this.slots.map(s => s.head)]; }

  /** Where leg i wants its foot now, a little ahead of where the body's going. */
  _rest(s, i, out) {
    const side = i < 4 ? 1 : -1, R = REST[i % 4];
    const sn = Math.sin(s.h), cs = Math.cos(s.h), lead = Math.min(2.6, s.speed * 0.42);
    const lx = R[0] * side, lz = R[2] + lead;
    out.x = s.x + lx * cs + lz * sn;
    out.z = s.z - lx * sn + lz * cs;
    out.y = this.g.groundAt(out.x, out.z);
    return out;
  }

  _render(delta) {
    const g = this.g.groundAt;
    let n = 0;
    for (const s of this.slots) {
      if (!s.active) continue;
      const dead = this._deadSink(s);
      const stand = 3.4 - s.rise * 0 + Math.sin(s.phase * 1.3) * 0.08;
      const want = g(s.x, s.z) + stand - (1 - s.rise) * 11 + s.air * 4.5 - dead * 2.6 + s.rear * 0.9;
      s.bodyY += (want - s.bodyY) * (delta > 0 ? 1 - Math.exp(-14 * delta) : 1);
      s.head.position.set(s.x, s.bodyY, s.z);
      s.head.rotation.set(-s.rear * 0.5 + (s.state === DEAD ? 0.4 : 0), s.h, 0, "YXZ");
      s.head.userData.fangs.rotation.x = -s.jaw * 0.85;
      s.head.updateWorldMatrix(true, false);
      // Colliders: head end, abdomen, thorax
      const sn = Math.sin(s.h), cs = Math.cos(s.h);
      const place = (b, z, y) => { b.position.set(s.x + sn * z, s.state === DEAD ? -600 : s.bodyY + y, s.z + cs * z); b.aabbNeedsUpdate = true; };
      place(s.bodies[0], 2.4, 0.3); place(s.bodies[1], -4.2, 0.75); place(s.bodies[2], 0.5, 0.2);
      // Feet: alternate fours stepping, each foot stays planted until the body has moved on
      let stepping = 0;
      for (const f of s.feet) if (f.t < 1) stepping++;
      for (let i = 0; i < LEGS; i++) {
        const f = s.feet[i], side = i < 4 ? 1 : -1, group = ((i % 4) + (i < 4 ? 0 : 1)) % 2;
        if (f.t >= 1 && delta > 0) {
          this._rest(s, i, _a);
          const far = Math.hypot(_a.x - f.x, _a.z - f.z);
          const turn = Math.floor(s.phase * 3) % 2 === group;
          if (far > STRIDE * 2.2 || (far > STRIDE && turn && stepping < 4)) {
            f.fx = f.x; f.fy = f.y; f.fz = f.z;
            f.tx = _a.x; f.ty = _a.y; f.tz = _a.z;
            f.t = 0;
            stepping++;
          }
        }
        if (f.t < 1) {
          f.t = Math.min(1, f.t + delta / STEP_TIME);
          const e = f.t * f.t * (3 - 2 * f.t);
          f.x = f.fx + (f.tx - f.fx) * e;
          f.z = f.fz + (f.tz - f.fz) * e;
          f.y = f.fy + (f.ty - f.fy) * e + Math.sin(f.t * Math.PI) * 1.7;
        }
        // Front legs go up with it when it rears
        const front = i % 4 === 0 ? s.rear : 0;
        const H = HIPS[i % 4];
        _a.set(H[0] * side, H[1] - 2.2, H[2]).applyMatrix4(s.head.matrixWorld);
        _b.set(f.x, f.y + front * 5.5, f.z);
        // Two bones, the knee high above the hip: that's what makes a spider's outline
        _d.subVectors(_b, _a);
        let dist = _d.length();
        if (dist > L1 + L2 - 0.05) dist = L1 + L2 - 0.05;
        _d.normalize();
        const along = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
        const up = Math.sqrt(Math.max(0, L1 * L1 - along * along));
        const kx = _a.x + _d.x * along, ky = _a.y + _d.y * along + up, kz = _a.z + _d.z * along;
        n = this._seg(n, _a.x, _a.y, _a.z, kx, ky, kz, 1.15);
        n = this._seg(n, kx, ky, kz, _b.x, _b.y, _b.z, 0.75);
      }
    }
    this.legs.count = n;
    this.legs.visible = n > 0;
    if (n) this.legs.instanceMatrix.needsUpdate = true;
    if (this.legs.instanceColor && !this._colored) { this.legs.instanceColor.needsUpdate = true; this._colored = true; }
  }

  _seg(n, ax, ay, az, bx, by, bz, w) {
    _p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    _s.set(bx - ax, by - ay, bz - az);
    const len = _s.length();
    _q.setFromUnitVectors(UP, _s.divideScalar(len || 1));
    this.legs.setMatrixAt(n, _m.compose(_p, _q, _s.set(w, len, w)));
    return n + 1;
  }
}
