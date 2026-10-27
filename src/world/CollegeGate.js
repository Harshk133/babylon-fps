import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GROUP_WORLD, GROUP_GLASS } from "../physicsGroups.js";

// The college gate (MSBECL): stone pillars, a beam with the college's name on
// it, a guard booth in the middle and iron gates over the two lanes either
// side, across the North Road between Crossroads and Ravencross. The model
// (public/models/msbecl_gate_final.glb, optimized copy loaded first) is
// built to scale in metres: ground at y = 0, spanning its local X.
//
// - Colliders come from the model's own collision mesh (College_Gate_Collision):
//   one box per cube in it (pillars, beam, booth walls, base, roof).
// - The four gate leaves and the booth door swing with the model's clips
//   (Gate_Leaf_*_Open / _Close, Room_Door_Open / _Close). The gates start
//   open; F next to them shuts or opens both lanes, F at the booth works its
//   door. A shut gate stops players, monsters and vehicles (not bullets: it's
//   bars) and goes on the obstacle lists while it's shut.

/** Where it stands: on this road, near this point; clear: keep trees, rocks and poles this far away (m). */
export const COLLEGE_GATE = { road: "North Road", x: 6, z: 72, clear: 12 };

const GROUND_PART = 1.2;     // m: a collider whose bottom is this low blocks the way (minimap, pathing, vehicles)
const GATE_REACH = 4.5;      // m from a lane's centre to offer the gate
const BOOTH_REACH = 1.8;     // m from the booth door
const LANES = [-3.88, 3.88]; // local x of the two lane centres (where the leaves meet)
const LANE_HALF = 1.7;       // half the opening of a lane
const LEAF_H = 3.2;

/**
 * The collision mesh's solids as boxes [Box3] in the root's frame. Pieces are
 * found by shared corners; a plain cube (12 triangles) becomes its bounding
 * box, anything else (the booth's U of walls) one thin box per flat face, so
 * it stays hollow.
 */
function cubes(mesh, rootInv) {
  const g = mesh.geometry, pos = g.attributes.position;
  const m = new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld);
  const n = pos.count;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m));
  const parent = new Int32Array(n).map((_, i) => i);
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const join = (a, b) => { parent[find(a)] = find(b); };
  // Corners at the same spot belong together (each face of an exported cube has its own vertices)
  const at = new Map();
  pts.forEach((p, i) => {
    const k = `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
    if (at.has(k)) join(i, at.get(k)); else at.set(k, i);
  });
  const index = g.index;
  const tris = index ? index.count : n;
  const vtx = t => (index ? index.getX(t) : t);
  for (let t = 0; t < tris; t += 3) { join(vtx(t), vtx(t + 1)); join(vtx(t), vtx(t + 2)); }
  const pieces = new Map();   // root → triangle starts
  for (let t = 0; t < tris; t += 3) {
    const r = find(vtx(t));
    if (!pieces.has(r)) pieces.set(r, []);
    pieces.get(r).push(t);
  }
  const out = [], e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (const list of pieces.values()) {
    if (list.length === 12) {
      const b = new THREE.Box3();
      for (const t of list) for (let k = 0; k < 3; k++) b.expandByPoint(pts[vtx(t + k)]);
      out.push(b);
      continue;
    }
    // Faces by plane (axis, side, offset): each a thin box
    const faces = new Map();
    for (const t of list) {
      const a = pts[vtx(t)], b = pts[vtx(t + 1)], c = pts[vtx(t + 2)];
      const nrm = e1.subVectors(b, a).cross(e2.subVectors(c, a));
      const ax = Math.abs(nrm.x) > Math.abs(nrm.y) ? (Math.abs(nrm.x) > Math.abs(nrm.z) ? "x" : "z") : (Math.abs(nrm.y) > Math.abs(nrm.z) ? "y" : "z");
      const k = `${ax}${Math.sign(nrm[ax])}${a[ax].toFixed(2)}`;
      if (!faces.has(k)) faces.set(k, new THREE.Box3());
      faces.get(k).expandByPoint(a).expandByPoint(b).expandByPoint(c);
    }
    out.push(...faces.values());
  }
  return out;
}

/**
 * gltf: the loaded model (scene + animations). roads: world/Roads.js.
 * groundAt(x, z): the finished terrain. Returns the gate: { x, z, rot,
 * blocks(), interaction(), toggle(), setState(), update(delta), state }.
 */
export function placeCollegeGate({ gltf, scene, world, material, roads, groundAt, mapObstacles, navObstacles }) {
  const def = COLLEGE_GATE;
  const road = roads.byName(def.road);
  const at = roads.pointAt(road, roads.arcNear(road, def.x, def.z));
  // The model spans its local X: turn its local Z along the road
  const rot = Math.atan2(at.tx, at.tz);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const y = groundAt(at.x, at.z);
  const model = gltf.scene;

  // Leftovers in the export: a default cube; the collision mesh is for physics only
  model.getObjectByName("Cube")?.removeFromParent();
  model.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const collision = model.getObjectByName("College_Gate_Collision");
  const collisionMesh = collision?.isMesh ? collision : collision?.getObjectByProperty("isMesh", true);
  const boxes = collisionMesh ? cubes(collisionMesh, rootInv) : [new THREE.Box3().setFromObject(model)];
  collision?.removeFromParent();

  const toWorld = (lx, lz, out = {}) => {
    out.x = at.x + lx * cos + lz * sin;
    out.z = at.z - lx * sin + lz * cos;
    return out;
  };

  // Stone: one compound body
  const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
  const c = new THREE.Vector3(), h = new THREE.Vector3();
  for (const b of boxes) {
    b.getCenter(c);
    b.getSize(h).multiplyScalar(0.5);
    h.set(Math.max(h.x, 0.06), Math.max(h.y, 0.06), Math.max(h.z, 0.06));
    body.addShape(new CANNON.Box(new CANNON.Vec3(h.x, h.y, h.z)), new CANNON.Vec3(c.x, c.y, c.z));
    if (b.min.y > GROUND_PART) continue; // overhead: beam, roof, lintel
    const w = toWorld(c.x, c.z);
    const o = { type: "box", x: w.x, z: w.z, rot, w: h.x * 2, d: h.z * 2, hw: h.x, hd: h.z, gate: true };
    mapObstacles.push(o);
    navObstacles.push(o);
  }
  body.position.set(at.x, y, at.z);
  body.quaternion.setFromEuler(0, rot, 0);
  world.addBody(body);

  // The iron gates: bars with see-through gaps, cut out (no sorting, one pass)
  model.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const m = o.material;
    if (m.transparent || m.alphaTest > 0) {
      m.transparent = false;
      m.alphaTest = 0.5;
      m.depthWrite = true;
    }
  });

  const root = new THREE.Group();
  root.position.set(at.x, y, at.z);
  root.rotation.y = rot;
  root.add(model);
  scene.add(root);
  root.updateMatrixWorld(true);
  // Only the leaves and the booth door move
  const moving = new Set(["Gate_Leaf_L1", "Gate_Leaf_L2", "Gate_Leaf_R1", "Gate_Leaf_R2", "Room_Door"]);
  root.traverse(o => {
    let n = o, animated = false;
    while (n && n !== root) { if (moving.has(n.name)) { animated = true; break; } n = n.parent; }
    if (!animated && o !== root) o.matrixAutoUpdate = false;
  });

  // Animation: one action per clip; "open" / "close" play the matching set
  const mixer = new THREE.AnimationMixer(model);
  const clip = name => gltf.animations.find(a => a.name === name);
  const actions = (part, open) => {
    const names = part === "gate"
      ? ["Gate_Leaf_L1", "Gate_Leaf_L2", "Gate_Leaf_R1", "Gate_Leaf_R2"].map(n => `${n}_${open ? "Open" : "Close"}`)
      : [`Room_Door_${open ? "Open" : "Close"}`];
    return names.map(clip).filter(Boolean).map(cl => {
      const a = mixer.clipAction(cl);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      return a;
    });
  };
  const sets = { gate: { true: actions("gate", true), false: actions("gate", false) }, booth: { true: actions("booth", true), false: actions("booth", false) } };
  let animTime = 0;   // seconds the mixer still has to run

  // A shut gate: a bar-proof (bullets pass) box over each lane, and an obstacle for vehicles and pathing
  const leafBody = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_GLASS });
  for (const lx of LANES) leafBody.addShape(new CANNON.Box(new CANNON.Vec3(LANE_HALF, LEAF_H / 2, 0.08)), new CANNON.Vec3(lx, LEAF_H / 2, 0));
  leafBody.position.copy(body.position);
  leafBody.quaternion.copy(body.quaternion);
  const laneObstacles = LANES.map(lx => {
    const w = toWorld(lx, 0);
    return { type: "box", x: w.x, z: w.z, rot, w: LANE_HALF * 2, d: 0.3, hw: LANE_HALF, hd: 0.15, gate: true };
  });
  // The booth door: a thin panel while shut
  const doorBox = boxes.find(b => b.min.y > 2 && b.max.x - b.min.x < 1.2 && b.max.z < 0); // lintel over the door
  const doorX = doorBox ? (doorBox.min.x + doorBox.max.x) / 2 : 0;
  const doorZ = doorBox ? (doorBox.min.z + doorBox.max.z) / 2 : -0.74;
  const doorBody = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
  doorBody.addShape(new CANNON.Box(new CANNON.Vec3(0.44, 1.1, 0.05)), new CANNON.Vec3(doorX, 1.35, doorZ));
  doorBody.position.copy(body.position);
  doorBody.quaternion.copy(body.quaternion);

  const state = { gate: true, booth: false };   // open?
  const apply = (part, open, instant) => {
    for (const a of sets[part][!open]) a.stop();
    for (const a of sets[part][open]) {
      a.reset().play();
      if (instant) a.time = a.getClip().duration;
    }
    animTime = Math.max(animTime, instant ? 0.01 : 2.6);
    if (part === "gate") {
      if (open) {
        if (leafBody.world) world.removeBody(leafBody);
        for (const o of laneObstacles) {
          let i = mapObstacles.indexOf(o); if (i >= 0) mapObstacles.splice(i, 1);
          i = navObstacles.indexOf(o); if (i >= 0) navObstacles.splice(i, 1);
        }
      } else {
        if (!leafBody.world) world.addBody(leafBody);
        for (const o of laneObstacles) {
          if (!mapObstacles.includes(o)) mapObstacles.push(o);
          if (!navObstacles.includes(o)) navObstacles.push(o);
        }
      }
    } else if (open) {
      if (doorBody.world) world.removeBody(doorBody);
    } else if (!doorBody.world) {
      world.addBody(doorBody);
    }
    state[part] = open;
  };
  apply("gate", true, true);
  apply("booth", false, true);
  mixer.update(0.01);

  const _l = { x: 0, z: 0 };
  const toLocal = (x, z) => {
    const dx = x - at.x, dz = z - at.z;
    _l.x = dx * cos - dz * sin;
    _l.z = dx * sin + dz * cos;
    return _l;
  };

  return {
    x: at.x, z: at.z, rot, state,
    /** True near the gate (keeps trees, rocks and poles out of it). */
    blocks: (x, z, pad = 0) => Math.hypot(x - at.x, z - at.z) < def.clear + pad,
    /** What F would work at (x, z): "booth", "gate" or null, with its prompt. */
    interaction(x, z) {
      if (Math.abs(x - at.x) > 10 || Math.abs(z - at.z) > 10) return null;
      const l = toLocal(x, z);
      if (Math.hypot(l.x - doorX, l.z - doorZ) < BOOTH_REACH) return { part: "booth", label: state.booth ? "Close booth door" : "Open booth door" };
      for (const lx of LANES) {
        if (Math.abs(l.x - lx) < GATE_REACH && Math.abs(l.z) < 3) return { part: "gate", label: state.gate ? "Close the college gate" : "Open the college gate" };
      }
      return null;
    },
    /** Swing it the other way; returns the new state (true = open). */
    toggle(part) {
      apply(part, !state[part], false);
      return state[part];
    },
    /** From the network / a late join. */
    setState(part, open, instant = false) {
      if (state[part] !== open) apply(part, open, instant);
    },
    update(delta) {
      if (animTime <= 0) return;
      animTime -= delta;
      mixer.update(delta);
    },
  };
}
