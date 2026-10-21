import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeStaticMeshes } from "./MergeStatic.js";
import { GROUP_WORLD } from "../physicsGroups.js";

// The college gate (M. S. Bidve Engineering College): an arch of pillars, a
// long beam with the name on it and a guard booth in the middle, standing
// across the North Road between Crossroads and Ravencross. The model
// (public/models/college_gate.opt.glb) comes from the three-fps-game.netlify.app
// world; its ground is at y = 0 and the pillars run on below it.
//
// Every part gets its own box collider (pillars, booth, beam, sign), so you
// drive and walk through the openings and bullets stop on the stone. The parts
// that reach the ground go on the obstacle lists (minimap, the rickshaw,
// monster pathing) as small boxes, not one box round the whole gate.

/** Where it stands: on this road, near this point, this wide (m). */
export const COLLEGE_GATE = { road: "North Road", x: 6, z: 72, width: 22, clear: 14 };

const GROUND_PART = 1.2;   // model units: a part whose bottom is this close to the ground blocks the way

/**
 * gltf: the loaded model. roads: world/Roads.js (the gate turns across the
 * road). groundAt(x, z): the finished terrain. Returns { x, z, rot, blocks(x, z, pad) }.
 */
export function placeCollegeGate({ gltf, scene, world, material, roads, groundAt, mapObstacles, navObstacles }) {
  const def = COLLEGE_GATE;
  const road = roads.byName(def.road);
  const at = roads.pointAt(road, roads.arcNear(road, def.x, def.z));
  // The gate spans its local Z: turn that across the road (perpendicular to the tangent)
  const rot = Math.atan2(at.tz, -at.tx);
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const scale = def.width / (box.max.z - box.min.z);
  const y = groundAt(at.x, at.z);
  model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // One box per part, measured in the model's own frame before the parts are merged
  const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
  const part = new THREE.Box3(), c = new THREE.Vector3(), h = new THREE.Vector3();
  const cos = Math.cos(rot), sin = Math.sin(rot);
  model.traverse(o => {
    if (!o.isMesh) return;
    part.setFromObject(o);
    if (part.max.y < 0) return; // all underground
    part.min.y = Math.max(part.min.y, -1);
    part.getCenter(c);
    part.getSize(h).multiplyScalar(0.5 * scale);
    h.set(Math.max(h.x, 0.12), Math.max(h.y, 0.12), Math.max(h.z, 0.12));
    body.addShape(new CANNON.Box(new CANNON.Vec3(h.x, h.y, h.z)), new CANNON.Vec3(c.x * scale, c.y * scale, c.z * scale));
    if (part.min.y > GROUND_PART) return; // overhead: beam, roof, sign
    // On the ground: in everyone's way (world-space footprint of the part)
    const wx = at.x + (c.x * cos + c.z * sin) * scale, wz = at.z + (-c.x * sin + c.z * cos) * scale;
    const o2 = { type: "box", x: wx, z: wz, rot, w: h.x * 2, d: h.z * 2, hw: h.x, hd: h.z, gate: true };
    mapObstacles.push(o2);
    navObstacles.push(o2);
  });
  body.position.set(at.x, y, at.z);
  body.quaternion.setFromEuler(0, rot, 0);
  world.addBody(body);

  mergeStaticMeshes(model);
  const root = new THREE.Group();
  root.position.set(at.x, y, at.z);
  root.rotation.y = rot;
  root.scale.setScalar(scale);
  root.add(model);
  scene.add(root);
  root.updateMatrixWorld(true);
  root.traverse(o => { o.matrixAutoUpdate = false; });

  return {
    x: at.x, z: at.z, rot,
    /** True near the gate (keeps trees, rocks and poles out of it). */
    blocks: (x, z, pad = 0) => Math.hypot(x - at.x, z - at.z) < def.clear + pad,
  };
}
