import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeStaticMeshes } from "./MergeStatic.js";
import { GROUP_WORLD } from "../physicsGroups.js";

// Indian street props from public/models/india/ (see IndiaAssets.js): goods
// trucks parked on the highway and ring-road shoulders, and in every town a
// panchayat office and a town building facing the road. Solid boxes for
// physics, footprints for the minimap and monster pathing.
//
// Every copy of a model is one InstancedMesh per material, so six trucks cost
// the draw calls of one. The spots are road-relative and the same for every
// player; a model that's missing is simply left out.

/**
 * kind → target size (metres along its longest horizontal side), how far off
 * the road centreline it stands, and front: the turn that faces the model's
 * entrance toward the road (both building models have theirs on −Z).
 */
const KINDS = {
  truck:        { length: 7.6, offset: 5.0, footprint: 4.6, front: 0 },
  panchayat:    { length: 8.2, offset: 12.5, footprint: 6.0, front: Math.PI },
  townBuilding: { length: 10.5, offset: 13.0, footprint: 7.0, front: Math.PI },
};

/** [kind, road, near x, near z, side (+1 = right of travel)] */
export const PROP_SPOTS = [
  // Trucks between the towns
  ["truck", "Highway", -80, 4, -1], ["truck", "Highway", 90, -17, 1], ["truck", "Highway", 205, -40, -1],
  ["truck", "North Road", 6, 92, 1], ["truck", "Ring Road", 100, 60, 1], ["truck", "Ring Road", -92, -36, -1],
  // A panchayat office and a town building in each named town
  ["panchayat", "Highway", 26, -9, 1], ["townBuilding", "Highway", -52, -3, 1], ["townBuilding", "North Road", 6, -42, -1],
  ["panchayat", "Ring Road", -22, 124, 1], ["townBuilding", "North Road", 2, 156, -1],
  ["panchayat", "Ring Road", 146, -56, 1], ["townBuilding", "Highway", 120, -21, -1],
  ["panchayat", "Ring Road", 8, -148, 1], ["townBuilding", "North Road", 30, -166, 1],
  ["panchayat", "Ring Road", -117, -12, 1], ["townBuilding", "Highway", -142, 14, 1],
];

/**
 * Resolves PROP_SPOTS on the roads: [{ kind, x, z, rot, r }] (r: a radius that
 * covers its footprint; rot turns local +Z, the side facing the road, toward it).
 */
export function propSpots(roads) {
  return PROP_SPOTS.map(([kind, roadName, nx, nz, side]) => {
    const road = roads.byName(roadName);
    const at = roads.pointAt(road, roads.arcNear(road, nx, nz));
    const k = KINDS[kind];
    const ox = at.tz * side, oz = -at.tx * side;   // right of travel × side
    const x = at.x + ox * k.offset, z = at.z + oz * k.offset;
    // Trucks line up with the road; buildings face it
    const rot = kind === "truck" ? Math.atan2(at.tx, at.tz) : Math.atan2(-ox, -oz);
    return { kind, x, z, rot, front: k.front, r: k.footprint };
  });
}

/** Scales and centres a loaded model: longest horizontal side = length, base on y = 0. Returns { template, size }. */
function prepare(src, length) {
  const model = src.clone(true);
  const holder = new THREE.Group();
  holder.add(model);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const s = length / (Math.max(size.x, size.z) || 1);
  const c = box.getCenter(new THREE.Vector3());
  model.position.set(-c.x * s, -box.min.y * s, -c.z * s);
  model.scale.setScalar(s);
  holder.updateMatrixWorld(true);
  mergeStaticMeshes(holder);
  holder.updateMatrixWorld(true);
  return { template: holder, size: size.multiplyScalar(s) };
}

/**
 * Places every spot whose model is loaded. models: { truck, panchayat,
 * townBuilding } (THREE.Group | null). groundAt(x, z): the terrain.
 */
export function placeIndiaProps({ scene, world, material, models, spots, groundAt, mapObstacles, navObstacles }) {
  const byKind = new Map();
  for (const s of spots) {
    if (!models[s.kind]) continue;
    if (!byKind.has(s.kind)) byKind.set(s.kind, []);
    byKind.get(s.kind).push(s);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  for (const [kind, list] of byKind) {
    const { template, size } = prepare(models[kind], KINDS[kind].length);
    const placed = list.map(s => {
      const y = groundAt(s.x, s.z) - 0.05;
      return { ...s, y, matrix: new THREE.Matrix4().compose(p.set(s.x, y, s.z), q.setFromAxisAngle(up, s.rot + s.front), one) };
    });
    // One instanced mesh per merged part (= per material)
    template.traverse(o => {
      if (!o.isMesh) return;
      const inst = new THREE.InstancedMesh(o.geometry, o.material, placed.length);
      placed.forEach((s, i) => inst.setMatrixAt(i, m4.multiplyMatrices(s.matrix, o.matrixWorld)));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.computeBoundingSphere();
      inst.matrixAutoUpdate = false;
      scene.add(inst);
    });
    // Physics: one box each (the trucks' a little narrower than their mirrors)
    const hx = size.x / 2 * (kind === "truck" ? 0.9 : 1), hy = size.y / 2, hz = size.z / 2;
    for (const s of placed) {
      const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
      body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)), new CANNON.Vec3(0, hy, 0));
      body.position.set(s.x, s.y, s.z);
      body.quaternion.setFromEuler(0, s.rot, 0);
      world.addBody(body);
      const o = { type: "box", x: s.x, z: s.z, rot: s.rot, w: hx * 2, d: hz * 2, hw: hx, hd: hz, prop: kind };
      mapObstacles.push(o);
      navObstacles.push(o);
    }
  }
}
