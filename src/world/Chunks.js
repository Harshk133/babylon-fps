import * as THREE from "three";

// Distance culling for the static world. The island is ~1 km across but the
// camera's far plane is 220 m and the fog closes in before that, so most of
// it never needs drawing. Static things register with a centre and radius
// (terrain tiles, rock / tree / pole cells, city blocks, plots); update()
// hides whatever is past RANGE from the focus point, a few times a second.
// Colliders and gameplay data are untouched (they're always there); only the
// render side is switched, so it's identical for every player.
//
// splitInstanced() turns one map-wide InstancedMesh (every rock, every dead
// tree) into one per CELL-metre square, so each can be culled on its own.

const RANGE = 245;        // m: a bit past the far plane (shadows reach in from the edge)
const EVERY = 0.2;        // s between visibility passes

export class WorldChunks {
  constructor() {
    this.items = [];
    this._t = 0;
    this.shown = 0;
  }

  /** obj: any Object3D; (x, z) its centre, r its radius (m). */
  add(obj, x, z, r) {
    this.items.push({ obj, x, z, r });
    return obj;
  }

  /** Adds a mesh by its own bounding sphere. */
  addMesh(mesh) {
    const g = mesh.geometry;
    if (mesh.isInstancedMesh) { if (!mesh.boundingSphere) mesh.computeBoundingSphere(); }
    else if (!g.boundingSphere) g.computeBoundingSphere();
    const s = mesh.isInstancedMesh ? mesh.boundingSphere : g.boundingSphere;
    _v.copy(s.center).applyMatrix4(mesh.matrixWorld);
    return this.add(mesh, _v.x, _v.z, s.radius);
  }

  update(delta, x, z, force = false) {
    this._t -= delta;
    if (this._t > 0 && !force) return;
    this._t = EVERY;
    let shown = 0;
    for (const it of this.items) {
      const dx = it.x - x, dz = it.z - z, reach = RANGE + it.r;
      const v = dx * dx + dz * dz < reach * reach;
      if (it.obj.visible !== v) it.obj.visible = v;
      if (v) shown++;
    }
    this.shown = shown;
  }

  /** Everything visible (the loading-screen shader warm-up). */
  showAll() { for (const it of this.items) it.obj.visible = true; }
}

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();

/**
 * Splits an InstancedMesh into one per cell (by each instance's position),
 * replacing it in its parent. The pieces share its geometry and material.
 * Returns the new meshes (each with its bounding sphere computed).
 */
export function splitInstanced(mesh, cell = 120) {
  const parent = mesh.parent;
  const groups = new Map();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, _m);
    _v.setFromMatrixPosition(_m);
    const k = Math.floor(_v.x / cell) * 4096 + Math.floor(_v.z / cell);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const out = [];
  for (const list of groups.values()) {
    const m = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
    list.forEach((src, i) => {
      mesh.getMatrixAt(src, _m);
      m.setMatrixAt(i, _m);
      if (mesh.instanceColor) { mesh.getColorAt(src, _c); m.setColorAt(i, _c); }
    });
    m.castShadow = mesh.castShadow;
    m.receiveShadow = mesh.receiveShadow;
    m.frustumCulled = mesh.frustumCulled;
    m.renderOrder = mesh.renderOrder;
    m.matrixAutoUpdate = false;
    m.matrix.copy(mesh.matrix);
    m.matrixWorld.copy(mesh.matrixWorld);
    m.computeBoundingSphere();
    parent?.add(m);
    out.push(m);
  }
  parent?.remove(mesh);
  return out;
}
