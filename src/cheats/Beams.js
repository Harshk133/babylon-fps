import * as THREE from "three";

// Glowing lines for the super-weapons: rail shots, lightning. All beams are one
// additive InstancedMesh of stretched cylinders; black holes are a small pool.

const CAP = 220;
const HOLES = 3;
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _d = new THREE.Vector3(), _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class Beams {
  constructor(scene) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), mat, CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _c.set(0xffffff));
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.items = Array.from({ length: CAP }, () => ({ ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, w: 0, r: 1, g: 1, b: 1, life: 0, max: 1 }));
    this.next = 0;
    this.live = 0;
    this.holes = Array.from({ length: HOLES }, () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0x000000 })));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.26, 10, 40).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.9, 5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      const halo = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.08, 8, 40).rotateX(1.2), ring.material);
      g.add(ring, halo);
      g.visible = false;
      scene.add(g);
      return { g, ring, halo, t: 0, life: 0 };
    });
  }

  /** color: a THREE.Color hex; width in metres. */
  beam(a, b, color, width = 0.14, life = 0.28) {
    const it = this.items[this.next];
    this.next = (this.next + 1) % CAP;
    if (it.life <= 0) this.live++;
    _c.set(color);
    Object.assign(it, { ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, w: width, r: _c.r * 3, g: _c.g * 3, b: _c.b * 3, life, max: life });
  }

  /** A jagged bolt through points (flat [x, y, z, ...]). */
  bolt(points, color) {
    const a = {}, b = {};
    for (let i = 0; i + 5 < points.length; i += 3) {
      let ax = points[i], ay = points[i + 1], az = points[i + 2];
      const ex = points[i + 3], ey = points[i + 4], ez = points[i + 5];
      for (let k = 1; k <= 6; k++) {
        const t = k / 6, j = k === 6 ? 0 : 0.8;
        const bx = ax + (ex - points[i]) / 6 + (Math.random() - 0.5) * j, by = ay + (ey - points[i + 1]) / 6 + (Math.random() - 0.5) * j, bz = az + (ez - points[i + 2]) / 6 + (Math.random() - 0.5) * j;
        a.x = ax; a.y = ay; a.z = az; b.x = bx; b.y = by; b.z = bz;
        this.beam(a, b, color, 0.07, 0.2);
        ax = bx; ay = by; az = bz;
      }
    }
  }

  /** A black hole opens here for `life` seconds. */
  hole(x, y, z, life) {
    const h = this.holes.find(o => !o.g.visible) ?? this.holes[0];
    h.g.visible = true;
    h.g.position.set(x, y, z);
    h.t = 0;
    h.life = life;
  }

  update(dt) {
    for (const h of this.holes) {
      if (!h.g.visible) continue;
      h.t += dt;
      const k = Math.min(1, h.t * 3) * Math.min(1, (h.life - h.t) * 4);
      h.g.scale.setScalar(Math.max(0.01, k * (1.5 + Math.sin(h.t * 19) * 0.08)));
      h.ring.rotation.y += dt * 6;
      h.halo.rotation.z += dt * 3.7;
      if (h.t >= h.life) h.g.visible = false;
    }
    if (!this.live) { if (this.mesh.visible) { this.mesh.visible = false; this.mesh.count = 0; } return; }
    let n = 0;
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) { this.live--; continue; }
      const f = it.life / it.max;
      _d.set(it.bx - it.ax, it.by - it.ay, it.bz - it.az);
      const len = _d.length();
      _p.set((it.ax + it.bx) / 2, (it.ay + it.by) / 2, (it.az + it.bz) / 2);
      _q.setFromUnitVectors(UP, _d.divideScalar(len || 1));
      this.mesh.setMatrixAt(n, _m.compose(_p, _q, _s.set(it.w * f, len, it.w * f)));
      this.mesh.setColorAt(n, _c.setRGB(it.r * f, it.g * f, it.b * f));
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
