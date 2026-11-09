import * as THREE from "three";

// What's left of a destroyed building: chunks of it thrown out and falling, then
// staying on the ground as a rubble heap. One InstancedMesh for every chunk in the
// world (old rubble is reused when it runs out); the CPU only touches chunks still
// moving. Rubble has no collider: you can walk over it.

const CAP = 1800;
const PER_BUILDING = 46;
const GRAVITY = 24;
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _c = new THREE.Color();

export class Demolition {
  constructor({ scene, groundAt }) {
    this.groundAt = groundAt;
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _c.set(0xffffff));
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
    this.next = 0;      // ring position
    this.used = 0;
    this.moving = [];   // chunks in the air
    this.chunks = Array.from({ length: CAP }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, spin: 0, floor: 0, i: 0, air: false }));
  }

  /**
   * A building comes down. x, z, base: where; w, d: footprint; h: height; rot; color.
   * instant: already rubble (someone joining a game where it happened).
   */
  collapse({ x, z, base, w, d, h, rot = 0, color = 0xb5a792 }, instant = false) {
    const c = Math.cos(rot), s = Math.sin(rot);
    for (let n = 0; n < PER_BUILDING; n++) {
      const i = this.next;
      this.next = (i + 1) % CAP;
      this.used = Math.min(CAP, this.used + 1);
      const k = this.chunks[i];
      k.i = i;
      if (k.air) { k.air = false; this.moving.splice(this.moving.indexOf(k), 1); }
      const lx = (Math.random() - 0.5) * w * 1.05, lz = (Math.random() - 0.5) * d * 1.05;
      k.x = x + lx * c + lz * s;
      k.z = z - lx * s + lz * c;
      k.floor = this.groundAt(k.x, k.z);
      k.y = base + Math.random() * h;
      const big = Math.random();
      k.sx = 0.5 + big * 2.3; k.sy = 0.35 + Math.random() * 1.2; k.sz = 0.5 + Math.random() * 2.3;
      k.rx = Math.random() * 3; k.ry = Math.random() * 3; k.rz = Math.random() * 3;
      k.spin = (Math.random() - 0.5) * 7;
      const out = 2 + Math.random() * 7;
      const len = Math.hypot(lx, lz) || 1;
      k.vx = (lx * c + lz * s) / len * out;
      k.vz = (-lx * s + lz * c) / len * out;
      k.vy = 3 + Math.random() * 9;
      this.mesh.setColorAt(i, _c.set(color).multiplyScalar(0.55 + Math.random() * 0.55));
      if (instant) { k.y = k.floor + k.sy * 0.3; this._write(k); }
      else { k.air = true; this.moving.push(k); this._write(k); }
    }
    this.mesh.count = this.used;
    this.mesh.visible = this.used > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  _write(k) {
    _q.setFromEuler(_e.set(k.rx, k.ry, k.rz));
    this.mesh.setMatrixAt(k.i, _m.compose(_p.set(k.x, k.y, k.z), _q, _s.set(k.sx, k.sy, k.sz)));
  }

  update(dt) {
    if (!this.moving.length || dt <= 0) return;
    for (let n = this.moving.length - 1; n >= 0; n--) {
      const k = this.moving[n];
      k.vy -= GRAVITY * dt;
      k.x += k.vx * dt; k.y += k.vy * dt; k.z += k.vz * dt;
      k.rx += k.spin * dt; k.rz += k.spin * 0.7 * dt;
      if (k.y <= k.floor + k.sy * 0.3) {
        k.y = k.floor + k.sy * 0.3;
        k.air = false;
        this.moving[n] = this.moving[this.moving.length - 1];
        this.moving.pop();
      }
      this._write(k);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Every building is back (a new battle royale match). */
  clear() {
    for (const k of this.moving) k.air = false;
    this.moving.length = 0;
    this.used = 0;
    this.next = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }
}
