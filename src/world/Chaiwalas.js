import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GROUP_WORLD } from "../physicsGroups.js";
import { toFloatGeometry } from "./MergeStatic.js";

// The chaiwala ("गरम चहा"): a chai seller on his little plinth, pouring from his
// kettle (public/models/india/chaiwala.opt.glb, made for the game; sources in
// public/models/indian things/GaramChaha/). One stands by every dukaan stall,
// by every town store and in front of some of Shivpur's shops. The model is in
// metres, plinth on y = 0, facing +Z; every copy is one InstancedMesh per
// material (flagged for the map-cell split in loadWorld), with a small box
// collider each.

const HALF = { x: 0.53, y: 1.0, z: 0.38 };   // the plinth and figure
export const CHAIWALA_R = 0.8;               // m: a radius round the footprint

/** Beside a dukaan stall (stall: { x, z, rot }): right of its counter, facing the road. */
export function chaiwalaByStall(s, stallHalfW = 1.5) {
  const lx = stallHalfW + 0.9, lz = 0.5, c = Math.cos(s.rot), sn = Math.sin(s.rot);
  return { x: s.x + lx * c + lz * sn, z: s.z - lx * sn + lz * c, rot: s.rot };
}

/** In front of a building that faces the road (b: { x, z, rot }, its front local +Z at fz, side x at lx). */
export function chaiwalaAtFront(b, lx, fz) {
  const c = Math.cos(b.rot), sn = Math.sin(b.rot);
  return { x: b.x + lx * c + fz * sn, z: b.z - lx * sn + fz * c, rot: b.rot };
}


/**
 * gltf: the loaded model; spots: [{ x, z, rot }]; groundAt(x, z): the
 * finished terrain. Returns the spots that got one.
 */
export function buildChaiwalas({ gltf, scene, world, material, spots, groundAt, mapObstacles, navObstacles }) {
  if (!gltf || !spots.length) return [];
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const parts = [];
  model.traverse(o => {
    if (!o.isMesh) return;
    parts.push({ geometry: toFloatGeometry(o.geometry).applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld)), material: o.material });
  });
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const meshes = parts.map(({ geometry, material: mat }) => {
    const im = new THREE.InstancedMesh(geometry, mat, spots.length);
    im.castShadow = true;
    im.receiveShadow = true;
    im.userData.chunk = true;
    return im;
  });
  const shape = new CANNON.Box(new CANNON.Vec3(HALF.x, HALF.y, HALF.z));
  spots.forEach((s, i) => {
    const y = groundAt(s.x, s.z);
    mtx.compose(p.set(s.x, y, s.z), q.setFromAxisAngle(up, s.rot), one);
    for (const im of meshes) im.setMatrixAt(i, mtx);
    const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
    body.addShape(shape);
    body.position.set(s.x, y + HALF.y, s.z);
    body.quaternion.setFromEuler(0, s.rot, 0);
    world.addBody(body);
    const o = { type: "box", x: s.x, z: s.z, rot: s.rot, w: HALF.x * 2, d: HALF.z * 2, hw: HALF.x, hd: HALF.z, chai: true };
    mapObstacles.push(o);
    navObstacles.push(o);
  });
  for (const im of meshes) {
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.matrixAutoUpdate = false;
    im.updateMatrix();
    scene.add(im);
  }
  return spots;
}
