import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GROUP_WORLD } from "../physicsGroups.js";

// Breakable wooden crates (after three.js webgl_geometry_cube: one BoxGeometry
// with a crate texture). Kick one standing, punch it crouched or prone, shoot
// it or blow it up; it bursts into planks and spills loot.
//
// Drawing: one InstancedMesh for every crate (a broken one is scaled to zero)
// and one for the flying planks. Each crate is a static Box body (GROUP_WORLD,
// body.crate = its index), taken out of the world while it's broken.
// Placement and indices are deterministic, so the index is the network id.

export const CRATE_SIZE = 0.9;            // m, a cube
export const CRATE_HP = 100;
const SHAKE_TIME = 0.28;                  // s a hit makes the crate rock
const PLANKS_PER_BREAK = 10;
const PLANK_POOL = 90;
const PLANK_LIFE = 5.5;                   // s on the ground before they shrink away
const GRAVITY = 14;

/** The crate's face: planks in a frame with a diagonal brace, drawn once. */
function crateTexture(renderer) {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  let seed = 0x5eed;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  // Planks with grain
  const planks = 5, ph = S / planks;
  for (let i = 0; i < planks; i++) {
    const l = 0.85 + rnd() * 0.25;
    g.fillStyle = `rgb(${(176 * l) | 0}, ${(122 * l) | 0}, ${(66 * l) | 0})`;
    g.fillRect(0, i * ph, S, ph);
    for (let k = 0; k < 14; k++) {
      g.strokeStyle = `rgba(80, 45, 18, ${0.12 + rnd() * 0.18})`;
      g.lineWidth = 0.6 + rnd() * 1.2;
      const y = i * ph + rnd() * ph;
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(S * 0.3, y + (rnd() - 0.5) * 6, S * 0.7, y + (rnd() - 0.5) * 6, S, y + (rnd() - 0.5) * 4);
      g.stroke();
    }
    // A knot now and then
    if (rnd() < 0.5) {
      g.fillStyle = "rgba(70, 38, 14, 0.55)";
      g.beginPath();
      g.ellipse(30 + rnd() * (S - 60), i * ph + ph / 2, 5 + rnd() * 4, 2.5, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "rgba(40, 22, 8, 0.75)";
    g.fillRect(0, i * ph, S, 2);
  }

  const frame = (x, y, w, h) => {
    g.fillStyle = "#8a5a2b";
    g.fillRect(x, y, w, h);
    g.strokeStyle = "rgba(40, 20, 6, 0.8)";
    g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    g.fillStyle = "rgba(255, 220, 160, 0.12)";
    g.fillRect(x + 2, y + 2, w - 4, 3);
  };
  const B = 30;
  // Diagonal brace, under the frame
  g.save();
  g.translate(S / 2, S / 2);
  g.rotate(-Math.PI / 4);
  frame(-S * 0.72, -B / 2, S * 1.44, B);
  g.restore();
  frame(0, 0, S, B); frame(0, S - B, S, B);
  frame(0, 0, B, S); frame(S - B, 0, B, S);
  // Nails
  g.fillStyle = "#3b3631";
  for (const [x, y] of [[B / 2, B / 2], [S - B / 2, B / 2], [B / 2, S - B / 2], [S - B / 2, S - B / 2], [S / 2, B / 2], [S / 2, S - B / 2], [B / 2, S / 2], [S - B / 2, S / 2]]) {
    g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2); g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer?.capabilities.getMaxAnisotropy() ?? 1);
  tex.generateMipmaps = true;
  return tex;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _e = new THREE.Euler();
const _UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3(0, 0, 0);

export class Crates {
  /**
   * spots: [{ x, y, z, yaw }] (y = the ground under it). mapObstacles gets a
   * footprint per crate (zeroed while broken).
   */
  constructor({ scene, world, material, renderer, spots, mapObstacles = null }) {
    this.world = world;
    this.list = [];

    const tex = crateTexture(renderer);
    this.material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82, metalness: 0 });
    const geo = new THREE.BoxGeometry(CRATE_SIZE, CRATE_SIZE, CRATE_SIZE);
    const n = Math.max(1, spots.length);
    this.mesh = new THREE.InstancedMesh(geo, this.material, n);
    this.mesh.name = "crates";
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.count = spots.length;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);

    const half = new CANNON.Vec3(CRATE_SIZE / 2, CRATE_SIZE / 2, CRATE_SIZE / 2);
    const shape = new CANNON.Box(half);
    spots.forEach((s, i) => {
      const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
      body.addShape(shape);
      body.position.set(s.x, s.y + CRATE_SIZE / 2, s.z);
      body.quaternion.setFromEuler(0, s.yaw, 0);
      body.crate = i;
      world.addBody(body);
      const foot = { type: "box", x: s.x, z: s.z, w: CRATE_SIZE, d: CRATE_SIZE, rot: s.yaw, crate: true };
      mapObstacles?.push(foot);
      this.list.push({ i, x: s.x, y: s.y, z: s.z, yaw: s.yaw, hp: CRATE_HP, broken: false, brokenAt: 0, shake: 0, sx: 0, sz: 0, body, foot });
      this._write(this.list[i]);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this._shaking = [];

    // Flying planks
    this.planks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.62, 0.05, 0.16), this.material, PLANK_POOL);
    this.planks.name = "crate-planks";
    this.planks.castShadow = true;
    this.planks.frustumCulled = false;
    this.planks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.planks.count = 0;
    this.planks.visible = false;
    scene.add(this.planks);
    this._pl = Array.from({ length: PLANK_POOL }, () => ({
      live: false, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(),
      ax: new THREE.Vector3(), spin: 0, t: 0, floor: 0, rest: false,
    }));
    this._next = 0;
  }

  get count() { return this.list.length; }

  _write(c) {
    if (c.broken) {
      _m.compose(_p.set(c.x, c.y - 50, c.z), _q.identity(), ZERO);
    } else {
      _q.setFromAxisAngle(_UP, c.yaw);
      _p.set(c.x, c.y + CRATE_SIZE / 2, c.z);
      if (c.shake > 0) {
        // Rocks away from the hit and back, a little jitter on top
        const k = c.shake / SHAKE_TIME, a = Math.sin(k * Math.PI * 3) * 0.09 * k;
        _axis.set(c.sz, 0, -c.sx);
        if (_axis.lengthSq() > 1e-6) { _axis.normalize(); _q2.setFromAxisAngle(_axis, a); _q.premultiply(_q2); }
        _p.x += c.sx * a * 0.25; _p.z += c.sz * a * 0.25;
      }
      _m.compose(_p, _q, _s.set(1, 1, 1));
    }
    this.mesh.setMatrixAt(c.i, _m);
  }

  /**
   * The crate a player at (x, feetY, z) facing (fx, fz) can kick or punch:
   * close in front of them, roughly on their level. Returns the record or null.
   */
  nearest(x, feetY, z, fx, fz, reach = 1.55) {
    let best = null, bestD = Infinity;
    for (const c of this.list) {
      if (c.broken) continue;
      const dx = c.x - x, dz = c.z - z;
      if (Math.abs(dx) > 3 || Math.abs(dz) > 3) continue;
      if (Math.abs(c.y - feetY) > 1.2) continue;
      const d = Math.hypot(dx, dz);
      if (d > reach) continue;
      // In front (any direction once you're right against it)
      if (d > 0.9 && (dx * fx + dz * fz) / d < 0.35) continue;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /** Damage from a kick, a punch or a bullet. dx, dz: the direction of the blow. Returns true if it breaks. */
  hit(i, dmg, dx = 0, dz = 0) {
    const c = this.list[i];
    if (!c || c.broken) return false;
    c.hp -= dmg;
    const l = Math.hypot(dx, dz) || 1;
    c.sx = dx / l; c.sz = dz / l;
    if (c.shake <= 0) this._shaking.push(c);
    c.shake = SHAKE_TIME;
    return c.hp <= 0;
  }

  /** Bursts it: hidden, no collider, planks fly off along (dx, dz) unless !burst. Idempotent. */
  break(i, dx = 0, dz = 0, now = 0, burst = true) {
    const c = this.list[i];
    if (!c || c.broken) return false;
    c.broken = true;
    c.brokenAt = now;
    c.hp = 0;
    c.shake = 0;
    this.world.removeBody(c.body);
    c.foot.w = c.foot.d = 0.01;
    this._write(c);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (burst) this._burst(c, dx, dz);
    return true;
  }

  /** Back in one piece (a respawn, or a new battle royale match). */
  restore(i) {
    const c = this.list[i];
    if (!c || !c.broken) return;
    c.broken = false;
    c.hp = CRATE_HP;
    this.world.addBody(c.body);
    c.foot.w = c.foot.d = CRATE_SIZE;
    this._write(c);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  restoreAll() {
    for (const c of this.list) {
      if (c.broken) this.restore(c.i);
      else c.hp = CRATE_HP;
    }
  }

  /** Indices of the broken crates (for late joiners). */
  brokenList() {
    const out = [];
    for (const c of this.list) if (c.broken) out.push(c.i);
    return out;
  }

  /** Planks flying from a point (a smashed stall uses it too): { x, y, z } is the base. */
  burstAt(at, dx = 0, dz = 0) { this._burst(at, dx, dz); }

  _burst(c, dx, dz) {
    const l = Math.hypot(dx, dz);
    const ux = l > 1e-4 ? dx / l : 0, uz = l > 1e-4 ? dz / l : 0;
    for (let n = 0; n < PLANKS_PER_BREAK; n++) {
      const pl = this._pl[this._next];
      this._next = (this._next + 1) % PLANK_POOL;
      pl.live = true; pl.rest = false; pl.t = 0;
      pl.floor = c.y + 0.03;
      pl.p.set(c.x + (Math.random() - 0.5) * 0.6, c.y + 0.15 + Math.random() * 0.7, c.z + (Math.random() - 0.5) * 0.6);
      const out = 1.2 + Math.random() * 2.2, a = Math.random() * Math.PI * 2;
      pl.v.set(Math.cos(a) * out + ux * 2.6, 2.2 + Math.random() * 3.2, Math.sin(a) * out + uz * 2.6);
      pl.q.setFromEuler(_e.set(Math.random() * 3, Math.random() * 6.3, Math.random() * 3));
      pl.ax.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      pl.spin = 6 + Math.random() * 10;
    }
    this.planks.visible = true;
  }

  update(dt) {
    // Rocking crates
    if (this._shaking.length) {
      for (let k = this._shaking.length - 1; k >= 0; k--) {
        const c = this._shaking[k];
        c.shake = Math.max(0, c.shake - dt);
        if (!c.broken) this._write(c);
        if (c.shake <= 0) this._shaking.splice(k, 1);
      }
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    if (!this.planks.visible) return;
    // Planks: tumble, bounce, settle, shrink away
    let n = 0;
    for (const pl of this._pl) {
      if (!pl.live) continue;
      pl.t += dt;
      if (!pl.rest) {
        pl.v.y -= GRAVITY * dt;
        pl.p.addScaledVector(pl.v, dt);
        _q2.setFromAxisAngle(pl.ax, pl.spin * dt);
        pl.q.premultiply(_q2);
        if (pl.p.y < pl.floor) {
          pl.p.y = pl.floor;
          if (Math.abs(pl.v.y) < 1.2) {
            pl.rest = true;
            // Lie flat-ish on the ground, keeping its heading
            _axis.set(0, 0, 1).applyQuaternion(pl.q);
            pl.q.setFromAxisAngle(_UP, Math.atan2(_axis.x, _axis.z));
          } else {
            pl.v.y *= -0.32; pl.v.x *= 0.55; pl.v.z *= 0.55; pl.spin *= 0.5;
          }
        }
      }
      const fade = pl.t > PLANK_LIFE ? 1 - (pl.t - PLANK_LIFE) / 0.6 : 1;
      if (fade <= 0) { pl.live = false; continue; }
      _m.compose(pl.p, pl.q, _s.setScalar(fade));
      this.planks.setMatrixAt(n++, _m);
    }
    this.planks.count = n;
    this.planks.visible = n > 0;
    this.planks.instanceMatrix.needsUpdate = true;
  }
}
