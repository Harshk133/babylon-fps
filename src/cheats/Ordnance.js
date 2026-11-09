import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GROUP_WORLD, GROUP_ZOMBIE } from "../physicsGroups.js";

// Things that fall out of the sky: a bomber's bombs and the meteor shower. One
// pooled InstancedMesh for each look. Everyone flies their own copy; only the copy
// marked `report` (whoever dropped it) calls onImpact, so one blast goes out per bomb.

const POOL = 48;
const BOMB_GRAVITY = 26;
const _from = new CANNON.Vec3(), _to = new CANNON.Vec3(), _res = new CANNON.RaycastResult();
const rayOpts = { collisionFilterMask: GROUP_WORLD, skipBackfaces: true };
const hitOpts = { collisionFilterMask: GROUP_WORLD | GROUP_ZOMBIE, skipBackfaces: true };
// g: gravity; life: s before it gives up; seek: also stops on monsters and snakes; size: stretch
const KINDS = {
  bomb:   { g: BOMB_GRAVITY, life: 12, seek: false, size: [1, 1, 1] },
  meteor: { g: 0, life: 12, seek: false, size: [1.25, 5.5, 1.25] },
  rocket: { g: 0, life: 4, seek: true, size: [0.2, 2.6, 0.2] },
  orb:    { g: 0, life: 3, seek: true, size: [0.8, 0.8, 0.8] },
};
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _dir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Ordnance {
  /** onImpact(kind, x, y, z, by): a reported one has landed. */
  constructor({ scene, world, groundAt, onImpact }) {
    this.world = world;
    this.groundAt = groundAt;
    this.onImpact = onImpact;
    this.items = Array.from({ length: POOL }, () => ({ live: false, kind: "bomb", x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, report: false, by: null }));
    this.live = 0;
    const bomb = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.32, 1.1, 4, 10), new THREE.MeshStandardMaterial({ color: 0x31352c, roughness: 0.55, metalness: 0.5 }));
    const rock = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 1.6, 0.25), toneMapped: true }));
    this.meshes = {};
    const flame = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.9, 0.4) }));
    const orb = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 0.4, 4) }));
    for (const [kind, proto] of [["bomb", bomb], ["meteor", rock], ["rocket", flame], ["orb", orb]]) {
      const im = new THREE.InstancedMesh(proto.geometry, proto.material, POOL);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.count = 0;
      im.visible = false;
      scene.add(im);
      this.meshes[kind] = im;
    }
  }

  /** report: this machine says where it lands. by: who gets the credit. */
  spawn(kind, x, y, z, vx, vy, vz, report, by) {
    const it = this.items.find(i => !i.live);
    if (!it) return;
    Object.assign(it, { live: true, kind, x, y, z, vx, vy, vz, report, by, age: 0 });
    this.live++;
  }

  clear() {
    for (const it of this.items) it.live = false;
    this.live = 0;
    this._draw();
  }

  update(dt) {
    if (!this.live) return;
    for (const it of this.items) {
      if (!it.live || dt <= 0) continue;
      const K = KINDS[it.kind];
      it.vy -= K.g * dt;
      it.age += dt;
      const nx = it.x + it.vx * dt, ny = it.y + it.vy * dt, nz = it.z + it.vz * dt;
      let hit = false, hx = nx, hy = ny, hz = nz;
      const g = this.groundAt(nx, nz);
      _from.set(it.x, it.y, it.z); _to.set(nx, ny, nz);
      _res.reset();
      if (it.age > K.life) { hit = true; }
      else if (this.world.raycastClosest(_from, _to, K.seek ? hitOpts : rayOpts, _res)) {
        hit = true; hx = _res.hitPointWorld.x; hy = _res.hitPointWorld.y; hz = _res.hitPointWorld.z;
      } else if (ny <= g) { hit = true; hy = g; }
      if (hit) {
        it.live = false;
        this.live--;
        if (it.report) this.onImpact(it.kind, hx, hy + 0.3, hz, it.by);
        continue;
      }
      it.x = nx; it.y = ny; it.z = nz;
    }
    this._draw();
  }

  _draw() {
    for (const kind in this.meshes) {
      const im = this.meshes[kind];
      let n = 0;
      for (const it of this.items) {
        if (!it.live || it.kind !== kind) continue;
        _dir.set(it.vx, it.vy, it.vz).normalize();
        _q.setFromUnitVectors(UP, _dir);
        // A meteor is stretched along its fall: a streak
        _s.set(...KINDS[kind].size);
        im.setMatrixAt(n++, _m.compose(_p.set(it.x, it.y, it.z), _q, _s));
      }
      im.count = n;
      im.visible = n > 0;
      if (n) im.instanceMatrix.needsUpdate = true;
    }
  }
}
