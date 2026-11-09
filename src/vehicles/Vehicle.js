import * as THREE from "three";
import * as CANNON from "cannon-es";
import { groundHeight } from "../world/Terrain.js";
import { GROUP_VEHICLE } from "../physicsGroups.js";
import { mergeStaticMeshes, toFloatGeometry } from "../world/MergeStatic.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Drivable vehicles: the auto-rickshaw, the Mahindra Thar and a tractor. Arcade handling
// (bicycle-model steering, no wheel physics): a vehicle follows the terrain by
// sampling the ground under its wheels, and is stopped by anything on the
// obstacle list (houses, trees, boulders). A kinematic box carries it in the
// physics world, so it shoves monsters and players aside (bullets pass
// through: the driver can be shot).
//
// They run on petrol: driving burns fuel, and an empty tank won't move. Petrol
// cans top it up. At night the headlights come on while someone drives.
//
// In co-op / battle royale the driver simulates it and streams the pose; the
// others smooth toward it (setRemote).

/**
 * Per-kind handling and layout. Local frame: +z forward, +x left, y up; origin
 * on the ground at the centre. seat: the driver's hips. lamps / tails:
 * headlight and tail-light spots. wheels: front / rear axle z and half track.
 * hits: collision probe circles along the length (z) and their radius.
 * box: collider half extents [x, y, z] and centre height. modelYaw: turn that
 * points the loaded model's nose at +z. tone: engine pitch (Sfx.setRickshaw).
 * grip: sideways grip on asphalt (x g; the surface scales it, see drive()).
 * slide: how fast it breaks into a slide past the grip. steerRate: how quickly
 * the wheel turns. dust: puffs per m/s per wheel on loose ground (emitDust).
 * spin: wheels built and spun by the vehicle itself [x, z, radius, width, front].
 */
const NO_EXTRA = [];
const BIKE_TURN_IN = 10;   // 1/s: how fast a bike's turn rate reaches what the steering asks

export const VEHICLES = {
  rickshaw: {
    label: "auto-rickshaw",
    length: 2.7, width: 1.4,
    maxSpeed: 15,         // m/s (~54 km/h)
    reverseSpeed: 5, accel: 5.5, brake: 13, coast: 1.4,
    maxSteer: 0.6, wheelBase: 1.75,
    fuelMax: 100, fuelStart: 35, burn: 0.85, idleBurn: 0.05, canFuel: 50, health: 90,
    enterRange: 3.2, headlight: 130,
    seat: [0, 0.66, 0.38],
    lamps: [[0, 0.98, 1.3]],
    tails: [[-0.45, 0.5, -1.36], [0.45, 0.5, -1.36]],
    wheels: { front: 1.0, rear: -0.78, track: 0.62 },
    hits: { z: [-0.85, 0, 0.85], r: 0.72 },
    box: [0.66, 0.8, 1.3, 0.85],
    modelYaw: Math.PI,           // the Sketchfab tuk-tuk (public/models/india/autorickshaw.glb) faces −Z
    runOver: 5, tone: 1,
    grip: 0.8, slide: 0.12, steerRate: 7, dust: 1.0,
  },
  thar: {
    label: "Thar",
    length: 4.43, width: 2.1,   // the real Thar Roxx: 4.43 m long, 1.92 m tall
    maxSpeed: 24,         // m/s (~86 km/h)
    reverseSpeed: 7, accel: 7.5, brake: 16, coast: 1.6,
    maxSteer: 0.55, wheelBase: 2.71,
    fuelMax: 100, fuelStart: 55, burn: 1.1, idleBurn: 0.06, canFuel: 40, health: 140,
    enterRange: 4.21, headlight: 170,
    seat: [-0.47, 1.05, 0.06],   // right-hand drive
    lamps: [[0.69, 1.13, 2.19], [-0.69, 1.13, 2.19]],
    tails: [[0.89, 1.05, -2.24], [-0.89, 1.05, -2.24]],
    wheels: { front: 1.44, rear: -1.31, track: 0.91 },
    hits: { z: [-1.5, 0, 1.5], r: 1.11 },
    box: [1.05, 1.05, 2.21, 1.11],
    modelYaw: Math.PI / 2,       // the Sketchfab Thar Roxx is modelled nose along −X
    runOver: 7, tone: 0.68,
    grip: 0.95, slide: 0.14, steerRate: 7, dust: 1.4,
  },
  tractor: {
    label: "tractor",
    length: 3.7, width: 1.95,
    maxSpeed: 11,         // m/s (~40 km/h): heavy and geared low
    reverseSpeed: 4, accel: 3.4, brake: 7.5, coast: 0.9,
    maxSteer: 0.62, wheelBase: 2.05,
    fuelMax: 100, fuelStart: 70, burn: 0.7, idleBurn: 0.05, canFuel: 45, health: 180,
    enterRange: 3.6, headlight: 120,
    seat: [0, 1.38, -0.62],
    lamps: [[0.34, 1.22, 1.74], [-0.34, 1.22, 1.74]],
    tails: [[0.62, 1.12, -1.5], [-0.62, 1.12, -1.5]],
    wheels: { front: 1.2, rear: -0.85, track: 0.82 },
    hits: { z: [-1.05, 0, 1.15], r: 0.98 },
    box: [0.97, 0.95, 1.85, 1.0],
    runOver: 6, tone: 0.5,
    // Loose rear end: a sharp turn at speed on dirt swings the back out
    grip: 0.72, slide: 0.2, steerRate: 4, dust: 2.4,
    spin: [[0.86, -0.85, 0.78, 0.46, false], [-0.86, -0.85, 0.78, 0.46, false], [0.74, 1.2, 0.44, 0.28, true], [-0.74, 1.2, 0.44, 0.28, true]],
  },
  // The cheat-code vehicles (main.js "Cheats"): built by hand, parked out of the world until someone asks.
  // turret: a gun that follows your aim. plane: flown, not driven (see fly()); takeoff / stall: m/s.
  tank: {
    label: "battle tank",
    length: 7.2, width: 3.4,
    maxSpeed: 13, reverseSpeed: 6, accel: 5, brake: 12, coast: 3,
    maxSteer: 0.75, wheelBase: 2.6,
    fuelMax: 100, fuelStart: 100, burn: 0.05, idleBurn: 0, canFuel: 100, health: 900,
    enterRange: 5, headlight: 150,
    seat: [0, 2.3, -0.55],
    lamps: [[1.2, 1.3, 3.5], [-1.2, 1.3, 3.5]],
    tails: [[1.2, 1.25, -3.55], [-1.2, 1.25, -3.55]],
    wheels: { front: 2.6, rear: -2.6, track: 1.4 },
    hits: { z: [-2.2, 0, 2.2], r: 1.75 },
    box: [1.7, 1.15, 3.6, 1.2],
    runOver: 14, tone: 0.4, grip: 1.4, slide: 0.05, steerRate: 5, dust: 3,
    turret: true, noBots: true, cam: { distance: 11, height: 2.6 },
  },
  plane: {
    label: "bomber plane",
    length: 12, width: 13,
    maxSpeed: 58, reverseSpeed: 0, accel: 11, brake: 14, coast: 2,
    maxSteer: 0.35, wheelBase: 6,
    fuelMax: 100, fuelStart: 100, burn: 0.12, idleBurn: 0, canFuel: 100, health: 260,
    enterRange: 7, headlight: 150,
    seat: [0, 2.2, 1.7],
    lamps: [[0, 1.5, 6.1]],
    tails: [[6.2, 1.6, -0.6], [-6.2, 1.6, -0.6]],
    wheels: { front: 3.4, rear: -3.4, track: 1.7 },
    hits: { z: [-3, 0, 3], r: 1.4 },
    box: [1.3, 1.2, 5.6, 1.6],
    runOver: 20, tone: 0.8, grip: 2, slide: 0.02, steerRate: 4, dust: 2,
    plane: { takeoff: 22, stall: 15, maxPitch: 0.7, maxRoll: 1.0, turn: 1.05, clearance: 16, top: 125 },
    noBots: true, cam: { distance: 20, height: 4.5 },
  },
  // Motorbikes (public/models/bikes/, Poly Pizza, CC BY 3.0: credited in src/legal/credits.js). Two wheels:
  // they lean into turns instead of sliding, rest on a kickstand when parked, and carry a
  // pillion rider behind the driver (facing forward, or turned round to watch the road behind).
  // bike: wheels [z, y, r] split off the model and spun (front first); grips / pegs: where the
  // driver's hands and feet go; pillion: its hips (seat), pegs and the grab rail behind it;
  // lean: most it leans over in a turn; stand: the kickstand's lean when parked;
  // turn: the hardest it corners (m/s² sideways: arcade, about 2 g, not what a real lean allows).
  sportbike: {
    label: "sport bike",       // (the model is a Suzuki SV650: shown under a generic name)
    length: 2.09, width: 0.75,
    maxSpeed: 31,         // m/s (~110 km/h)
    reverseSpeed: 2, accel: 9, brake: 15, coast: 1.2,
    maxSteer: 0.5, wheelBase: 1.42,
    fuelMax: 100, fuelStart: 50, burn: 0.7, idleBurn: 0.03, canFuel: 60, health: 70,
    enterRange: 2.2, headlight: 110,
    seat: [0, 0.92, -0.14],
    lamps: [[0, 0.86, 0.86]],
    tails: [[0, 0.88, -0.93]],
    wheels: { front: 0.74, rear: -0.68, track: 0.1 },
    hits: { z: [-0.6, 0, 0.6], r: 0.38 },
    box: [0.3, 0.55, 1.0, 0.55],
    modelYaw: 0,
    runOver: 3, tone: 1.45,
    grip: 1.05, slide: 0.12, steerRate: 6, dust: 0.6,
    bike: {
      wheels: [[0.738, 0.303, 0.3], [-0.683, 0.303, 0.3]],
      grips: [[0.31, 0.98, 0.33], [-0.31, 0.98, 0.33]],
      pegs: [[0.17, 0.34, -0.06], [-0.17, 0.34, -0.06]],
      hunch: 0.3,
      pillion: { seat: [0, 1.02, -0.58], pegs: [[0.19, 0.42, -0.42], [-0.19, 0.42, -0.42]], grabs: [[0.17, 0.92, -0.86], [-0.17, 0.92, -0.86]] },
      lean: 0.72, turn: 22, stand: 0.15, standAt: [0.12, -0.12],
    },
  },
  motorbike: {
    label: "army motorbike",
    length: 2.2, width: 0.85,
    maxSpeed: 22,         // m/s (~80 km/h): old and heavy, but at home on dirt
    reverseSpeed: 2, accel: 6.5, brake: 11, coast: 1.0,
    maxSteer: 0.55, wheelBase: 1.49,
    fuelMax: 100, fuelStart: 65, burn: 0.6, idleBurn: 0.03, canFuel: 60, health: 80,
    enterRange: 2.3, headlight: 100,
    seat: [0, 0.76, -0.05],
    lamps: [[0, 0.93, 1.0]],
    tails: [[0, 0.72, -1.02]],
    wheels: { front: 0.83, rear: -0.66, track: 0.1 },
    hits: { z: [-0.65, 0, 0.65], r: 0.4 },
    box: [0.32, 0.5, 1.05, 0.5],
    modelYaw: 0,
    runOver: 3, tone: 0.9,
    grip: 0.95, slide: 0.14, steerRate: 5.5, dust: 0.9,
    bike: {
      wheels: [[0.831, 0.27, 0.28], [-0.663, 0.27, 0.28]],
      grips: [[0.38, 0.93, 0.26], [-0.38, 0.93, 0.26]],
      pegs: [[0.2, 0.42, 0.22], [-0.2, 0.42, 0.22]],
      hunch: 0.12,
      pillion: { seat: [0, 0.86, -0.64], pegs: [[0.21, 0.44, -0.42], [-0.21, 0.44, -0.42]], grabs: [[0.2, 0.78, -0.95], [-0.2, 0.78, -0.95]] },
      lean: 0.62, turn: 20, stand: 0.15, standAt: [0.14, 0.05],
    },
  },
};

/**
 * Lifts a bike's wheels out of its model so they can turn: every connected piece of a mesh
 * that lies inside a wheel's disc ([z, y, r] in the vehicle's frame) goes to that wheel.
 * Returns [{ group, r }] (front first), each group centred on its axle; the rest of the model
 * keeps the other triangles.
 */
function extractWheels(holder, wheels) {
  holder.updateMatrixWorld(true);
  const out = wheels.map(([z, y, r]) => {
    const group = new THREE.Group();
    group.position.set(0, y, z);
    return { group, r, z, y, parts: new Map() };
  });
  const meshes = [];
  holder.traverse(o => { if (o.isMesh && !o.isSkinnedMesh) meshes.push(o); });
  const p = new THREE.Vector3();
  for (const mesh of meshes) {
    const g = mesh.geometry, pos = g.attributes.position, n = pos.count;
    const index = g.index ? Array.from(g.index.array) : [...Array(n).keys()];
    const world = [];
    for (let i = 0; i < n; i++) world.push(p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).clone());
    // Connected pieces: shared vertices and shared corners
    const parent = new Int32Array(n).map((_, i) => i);
    const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    const at = new Map();
    world.forEach((v, i) => {
      const k = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
      if (at.has(k)) parent[find(i)] = find(at.get(k)); else at.set(k, i);
    });
    for (let t = 0; t < index.length; t += 3) { parent[find(index[t])] = find(index[t + 1]); parent[find(index[t])] = find(index[t + 2]); }
    // Which wheel (if any) each piece sits inside
    const owner = new Map();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (owner.get(root) === -1) continue;
      const v = world[i];
      const w = out.findIndex(wh => Math.hypot(v.z - wh.z, v.y - wh.y) <= wh.r * 1.15 && Math.abs(v.x) < 0.25);
      const cur = owner.get(root);
      owner.set(root, cur === undefined ? w : cur === w ? w : -1);
    }
    const keep = [], taken = out.map(() => []);
    for (let t = 0; t < index.length; t += 3) {
      const w = owner.get(find(index[t]));
      (w >= 0 ? taken[w] : keep).push(index[t], index[t + 1], index[t + 2]);
    }
    if (!taken.some(l => l.length)) continue;
    taken.forEach((list, w) => {
      if (!list.length) return;
      const geo = toFloatGeometry(g);
      geo.setIndex(list);
      // Into the wheel's frame (centred on its axle)
      geo.applyMatrix4(mesh.matrixWorld).translate(0, -out[w].y, -out[w].z);
      const part = new THREE.Mesh(geo, mesh.material);
      part.castShadow = true;
      part.receiveShadow = true;
      out[w].group.add(part);
    });
    // (on a copy: the model's clones share their geometry)
    if (keep.length) { mesh.geometry = g.clone(); mesh.geometry.setIndex(keep); }
    else mesh.removeFromParent();
  }
  return out;
}

// A crash: the directions tested round a probe for which way the surface faces
const RING = 8;
const RING_C = Array.from({ length: RING }, (_, i) => Math.cos((i / RING) * Math.PI * 2));
const RING_S = Array.from({ length: RING }, (_, i) => Math.sin((i / RING) * Math.PI * 2));
const SCRAPE_MIN = 2.5;       // m/s: slower than this just stops
const SCRAPE_ANGLE = 0.55;    // speed into the surface / speed: below it, it glances off and slides (about 33°)
const JOLT_K = 150, JOLT_D = 9;   // the body's springs after a hit
const DAMAGE_CLEAR = 22;      // s for a smashed engine (damage 1) to stop smoking
const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));
// Bits of bodywork a hit knocks off, per kind: [r, g, b, gloss]
const PAINT = {
  rickshaw: [0.1, 0.3, 0.16, 0.5], thar: [0.14, 0.17, 0.12, 0.5], tractor: [0.55, 0.1, 0.08, 0.5],
  sportbike: [0.1, 0.16, 0.42, 0.6], motorbike: [0.2, 0.24, 0.13, 0.3],
};
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, "YXZ");

/** A plain low-poly jeep, used for the Thar until its model is in public/models/india/. */
export function standInJeep() {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0x2b3a2a, roughness: 0.6, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.8 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.2, metalness: 0.4 });
  const box = (w, h, d, x, y, z, m) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); g.add(o); };
  box(1.86, 0.62, 3.9, 0, 0.82, 0, paint);          // body
  box(1.8, 0.62, 2.1, 0, 1.43, -0.55, paint);       // cabin
  box(1.7, 0.5, 0.05, 0, 1.45, 0.52, glass);        // windscreen
  box(1.9, 0.18, 0.2, 0, 0.55, 2.0, dark);          // bumpers
  box(1.9, 0.18, 0.2, 0, 0.55, -2.0, dark);
  const wheel = new THREE.CylinderGeometry(0.4, 0.4, 0.32, 14).rotateZ(Math.PI / 2);
  for (const [x, z] of [[0.82, 1.3], [-0.82, 1.3], [0.82, -1.18], [-0.82, -1.18]]) {
    const w = new THREE.Mesh(wheel, dark); w.position.set(x, 0.4, z); g.add(w);
  }
  return g;
}

/**
 * A plain farm tractor (no brand): bonnet, cab frame, big rear wheels.
 * The wheels are not in it: VEHICLES.tractor.spin has the vehicle build and turn them.
 */
export function standInTractor() {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xb3261e, roughness: 0.55, metalness: 0.25 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x3a3c3e, roughness: 0.5, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1c1d, roughness: 0.85 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.9 });
  const box = (w, h, d, x, y, z, m) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); g.add(o); return o; };
  const cyl = (r, h, x, y, z, m, rotX = 0) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), m); o.position.set(x, y, z); o.rotation.x = rotX; g.add(o); return o; };
  box(0.78, 0.7, 1.75, 0, 1.0, 0.75, paint);            // bonnet
  box(0.8, 0.12, 1.8, 0, 1.4, 0.73, paint);              // its lid
  box(0.7, 0.45, 0.1, 0, 0.98, 1.66, dark);              // grille
  box(0.64, 0.5, 1.5, 0, 0.6, 0.55, metal);              // engine block / frame
  box(0.95, 0.6, 1.0, 0, 0.85, -0.55, metal);            // gearbox under the seat
  for (const sx of [-1, 1]) {
    box(0.5, 0.08, 1.3, 0.86 * sx, 1.62, -0.85, paint);  // rear mudguards
    box(0.06, 0.5, 1.3, 0.62 * sx, 1.36, -0.85, paint);
    box(0.06, 1.7, 0.08, 0.6 * sx, 2.25, -1.25, dark);   // roll frame posts
  }
  box(1.26, 0.08, 0.08, 0, 3.08, -1.25, dark);            // ...and its top bar
  box(1.4, 0.06, 1.25, 0, 3.12, -0.75, paint);            // sun canopy
  for (const sx of [-1, 1]) box(0.05, 0.05, 0.8, 0.6 * sx, 3.08, -0.85, dark);
  box(0.52, 0.12, 0.48, 0, 1.25, -0.62, seatMat);         // seat
  box(0.5, 0.45, 0.1, 0, 1.5, -0.88, seatMat);
  cyl(0.035, 0.55, 0, 1.55, -0.05, dark, -0.6);           // steering column
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.025, 6, 16), dark);
  wheel.position.set(0, 1.78, -0.2); wheel.rotation.x = -Math.PI / 2 + 0.6; g.add(wheel);
  cyl(0.05, 1.0, 0.28, 1.85, 1.15, metal);                // exhaust stack
  cyl(0.07, 0.14, 0.28, 2.38, 1.15, dark);
  box(1.6, 0.12, 0.12, 0, 0.55, 1.6, metal);              // front axle
  box(0.4, 0.14, 0.2, 0, 0.5, -1.62, metal);              // tow hitch
  return g;
}

const _armyGreen = new THREE.MeshStandardMaterial({ color: 0x4d5a35, roughness: 0.75, metalness: 0.25 });
const _armyDark = new THREE.MeshStandardMaterial({ color: 0x2a2f22, roughness: 0.85, metalness: 0.2 });
const _steel = new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.4, metalness: 0.8 });
const _planeBody = new THREE.MeshStandardMaterial({ color: 0x6f7f8c, roughness: 0.5, metalness: 0.45 });
const _glass = new THREE.MeshStandardMaterial({ color: 0x16242c, roughness: 0.15, metalness: 0.7 });
const _addBox = (g, w, h, d, x, y, z, m) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; };

/** The hull: tracks, road wheels and sloped armour (the turret is built apart, it has to turn). */
export function standInTank() {
  const g = new THREE.Group();
  _addBox(g, 2.5, 0.85, 6.6, 0, 1.1, 0, _armyGreen);       // hull
  _addBox(g, 2.5, 0.5, 1.5, 0, 1.35, 3.05, _armyGreen).rotation.x = 0.55; // glacis
  _addBox(g, 2.9, 0.08, 6.9, 0, 1.56, 0, _armyDark);       // deck
  for (const sx of [-1, 1]) {
    _addBox(g, 0.7, 0.95, 7.2, 1.42 * sx, 0.5, 0, _armyDark);   // track
    _addBox(g, 0.82, 0.1, 7.0, 1.42 * sx, 1.02, 0, _armyGreen); // fender
    for (let i = 0; i < 6; i++) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.78, 12).rotateZ(Math.PI / 2), _steel);
      w.position.set(1.42 * sx, 0.42, -2.75 + i * 1.1);
      g.add(w);
    }
  }
  _addBox(g, 1.1, 0.5, 0.2, 0, 1.6, -3.3, _armyDark);      // exhaust housing
  return g;
}

/** The turret: { group, barrel, tip }: turned and elevated by the vehicle. */
function tankTurret() {
  const group = new THREE.Group();
  group.position.set(0, 1.6, -0.3);
  _addBox(group, 2.3, 0.72, 2.9, 0, 0.36, 0, _armyGreen);
  _addBox(group, 1.6, 0.14, 2.0, 0, 0.78, -0.1, _armyDark);
  const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.16, 14), _armyDark);
  hatch.position.set(0, 0.86, -0.3); hatch.castShadow = true;
  group.add(hatch);
  const barrel = new THREE.Group();
  barrel.position.set(0, 0.42, 1.4);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 4, 12).rotateX(Math.PI / 2).translate(0, 0, 2), _steel);
  tube.castShadow = true;
  const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.5, 12).rotateX(Math.PI / 2).translate(0, 0, 4.1), _armyDark);
  barrel.add(tube, brake);
  const tip = new THREE.Object3D();
  tip.position.set(0, 0, 4.4);
  barrel.add(tip);
  group.add(barrel);
  return { group, barrel, tip };
}

export function standInPlane() {
  const g = new THREE.Group();
  const cyl = (r1, r2, h, x, y, z, m) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, 14).rotateX(Math.PI / 2), m); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; };
  cyl(0.85, 0.95, 5, 0, 1.75, 2.5, _planeBody);             // fuselage, forward half
  cyl(0.95, 0.3, 6.6, 0, 1.75, -3.3, _planeBody);           // ...and tapering to the tail
  cyl(0.5, 0.85, 1, 0, 1.75, 5.5, _armyDark);               // cowling
  _addBox(g, 1.15, 0.65, 2.2, 0, 2.55, 1.5, _glass);        // canopy
  _addBox(g, 13, 0.2, 2.5, 0, 1.45, 0.6, _planeBody);       // wings
  _addBox(g, 4.6, 0.14, 1.3, 0, 1.95, -5.8, _planeBody);    // tailplane
  _addBox(g, 0.16, 1.9, 1.5, 0, 2.8, -5.9, _armyGreen);     // fin
  for (const sx of [-1, 1]) {
    cyl(0.42, 0.42, 2.4, 3.2 * sx, 1.2, 1.2, _armyDark);    // engine pods / bomb racks
    _addBox(g, 0.12, 1, 0.12, 1.7 * sx, 0.7, 2.4, _armyDark); // gear legs
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 12).rotateZ(Math.PI / 2), _armyDark);
    w.position.set(1.7 * sx, 0.36, 2.4);
    g.add(w);
  }
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 10).rotateZ(Math.PI / 2), _armyDark);
  tail.position.set(0, 0.2, -5.2);
  g.add(tail);
  return g;
}

const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 });
const rimMat = new THREE.MeshStandardMaterial({ color: 0xc8a020, roughness: 0.5, metalness: 0.4 });

/** A wheel the vehicle builds and turns itself (spec.spin): tyre, rim and lugs, merged. */
function spinWheel(r, w) {
  const parts = [new THREE.CylinderGeometry(r, r, w, 16).rotateZ(Math.PI / 2)];
  // Lugs, so you can see it turning
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    parts.push(new THREE.BoxGeometry(w * 1.02, 0.07, r * 0.32).rotateX(-a).translate(0, Math.cos(a) * r, Math.sin(a) * r));
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(mergeGeometries(parts.map(p => p.toNonIndexed()), false), tyreMat));
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 10).rotateZ(Math.PI / 2), rimMat));
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  mergeStaticMeshes(g, { flatten: true });   // tyre + rim: one draw call
  return g;
}

export class Vehicle {
  /**
   * kind: a VEHICLES key. model: THREE.Object3D (a loaded glTF scene, or
   * standInJeep()). spawn: { x, z, yaw }. index: its place in the world's
   * vehicle list (sent over the network). modelYaw: overrides the spec's (a
   * different model of the same vehicle).
   */
  constructor({ scene, world, kind, model, material, spawn, index = 0, standIn = false, modelYaw = null }) {
    this.kind = kind;
    this.spec = VEHICLES[kind];
    this.index = index;
    this.spawn = spawn;
    const S = this.spec;
    this.root = new THREE.Group();
    this.root.rotation.order = "YXZ";
    scene.add(this.root);

    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const holder = new THREE.Group();
    holder.add(model);
    if (!standIn) model.rotation.y = modelYaw ?? S.modelYaw;
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(new THREE.Vector3());
    const s = standIn ? 1 : S.length / (size.z || 1);
    const c = box.getCenter(new THREE.Vector3());
    // Centred on x/z, wheels on the ground
    holder.scale.setScalar(s);
    holder.position.set(-c.x * s, -box.min.y * s, -c.z * s);
    // A bike's wheels come out of the model to turn on their own
    const B = S.bike;
    this.bikeWheels = B ? extractWheels(holder, B.wheels) : [];
    // One draw call per material, not per part; plain colours share a few vertex-coloured materials
    mergeStaticMeshes(holder, { flatten: true });
    // (in a frame that dips on the brakes and squats on the throttle: the suspension)
    this.chassis = new THREE.Group();
    this.chassis.add(holder);
    this.root.add(this.chassis);
    if (S.turret) { this.gun = tankTurret(); this.root.add(this.gun.group); }
    if (S.plane) {
      this.prop = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.2, 0.08), _armyDark);
      this.prop.position.set(0, 1.75, 6.05);
      this.root.add(this.prop);
    }
    this.height = size.y * s;
    for (const w of this.bikeWheels) {
      mergeStaticMeshes(w.group, { flatten: true });
      this.root.add(w.group);
    }
    if (B) {
      // The kickstand: down on the left while parked, folded up while ridden
      this.kickstand = new THREE.Group();
      this.kickstand.position.set(B.standAt[0], 0.3, B.standAt[1]);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.32, 6).translate(0, -0.16, 0), new THREE.MeshStandardMaterial({ color: 0x222326, roughness: 0.6, metalness: 0.5 }));
      rod.castShadow = true;
      this.kickstand.add(rod);
      this.chassis.add(this.kickstand);
    }

    // Wheels the vehicle turns itself (steer group > spinning tyre)
    this.spinners = [];
    for (const [x, z, r, w, front] of S.spin ?? []) {
      const steer = new THREE.Group();
      steer.position.set(x, r, z);
      const tyre = spinWheel(r, w);
      steer.add(tyre);
      this.root.add(steer);
      this.spinners.push({ steer, tyre, r, front });
    }

    // Lamps just glow; the beam is a shared spotlight lent out by main.js (aimHeadlight),
    // since every light in the scene costs every pixel, lit or not
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0x444033, emissive: 0xfff0c8, emissiveIntensity: 0 });
    // All the lamps are one mesh, and all the tail lights another (one draw call each)
    const lampGeos = S.lamps.map(p => new THREE.SphereGeometry(0.085, 12, 8).translate(p[0], p[1], p[2] + 0.04));
    if (lampGeos.length) this.root.add(new THREE.Mesh(lampGeos.length > 1 ? mergeGeometries(lampGeos) : lampGeos[0], this.lampMat));
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2010, emissiveIntensity: 0 });
    const tailGeos = S.tails.map(p => new THREE.BoxGeometry(0.1, 0.06, 0.03).translate(p[0], p[1], p[2]));
    if (tailGeos.length) this.root.add(new THREE.Mesh(tailGeos.length > 1 ? mergeGeometries(tailGeos) : tailGeos[0], this.tailMat));

    this.body = new CANNON.Body({
      mass: 0, type: CANNON.Body.KINEMATIC, material,
      collisionFilterGroup: GROUP_VEHICLE,
    });
    this.body.addShape(new CANNON.Box(new CANNON.Vec3(S.box[0], S.box[1], S.box[2])), new CANNON.Vec3(0, S.box[3], 0));
    this.body.vehicle = this;
    world.addBody(this.body);

    // Footprint for the minimap (and skipped by our own collision test)
    const self = this;
    this.footprint = {
      type: "box", vehicle: true, w: S.width, d: S.length,
      get x() { return self.x; }, get z() { return self.z; }, get rot() { return self.yaw; },
    };

    this.seat = new THREE.Vector3(...S.seat);
    this.pillionSeat = B ? new THREE.Vector3(...B.pillion.seat) : null;
    this.driver = null;        // null, "local", or a remote player id
    this.pillion = null;       // a bike's second rider: null, "local", or a remote player id
    this.pillionFacing = 1;    // 1: facing forward, −1: turned round, facing back
    this.lightLevel = 0;
    this.throttle = 0;
    this.reset();
  }

  reset() {
    this.x = this.spawn.x;
    this.z = this.spawn.z;
    this.yaw = this.spawn.yaw;
    this.setStowed(!!this.spawn.stowed);
    this.air = false;         // a plane off the ground
    this.climb = 0;
    this.turretYaw = this.yaw;
    this.gunPitch = 0;
    this.speed = 0;
    this.steer = 0;
    this.yawRate = 0;
    this.slip = 0;            // m/s sideways (+ = to the left): the slide
    this.skid = 0;            // how hard it's sliding (dust, tyre smoke)
    this._dust = 0;
    this.spin = 0;            // rad/s: a hit off-centre knocks the nose round
    this.jolt = 0; this.joltV = 0;           // nose down (+) after a hit: the body pitches on its springs
    this.joltRoll = 0; this.joltRollV = 0;
    this.damage = 0;          // 0..1 how smashed up the engine is: it smokes, and it clears with time
    this._smoke = 0;
    this.nextHit = 0;         // (effects aren't repeated on every frame of one contact)
    this.contact = { on: false, scrape: false, x: 0, z: 0, nx: 0, nz: 0, vx: 0, vz: 0 };
    this.fuel = this.spec.fuelStart;
    this.health = this.maxHealth;  // crashes wear it down; at 0 it's wrecked until someone repairs it (a toolkit)
    this.driver = null;
    this.pillion = null;
    this.throttle = 0;
    this.remote = null;
    // A bike: how far it leans over (+ = left), and the suspension's dip (+ = nose down)
    this.lean = this.spec.bike ? this.spec.bike.stand : 0;
    this.leanV = 0;
    this.dive = 0;
    this.diveV = 0;
    this._lastSpeed = 0;
    this._pose(0);
    this._settle = 0.5; // the next update places the collider
  }

  get empty() { return this.fuel <= 0; }
  get maxHealth() { return this.spec.health ?? 100; }
  get wrecked() { return this.health <= 0; }
  get healthFrac() { return Math.max(0, this.health) / this.maxHealth; }

  /** Crash damage. Returns true if this hit wrecked it. */
  hurt(amount) {
    if (this.wrecked || amount <= 0) return false;
    this.health = Math.max(0, this.health - amount);
    if (!this.wrecked) return false;
    this.damage = 1;            // smokes until it's repaired
    this.speed *= 0.3;
    return true;
  }

  /** Repaired (by a toolkit) or synced from someone else. */
  setHealth(h) {
    this.health = Math.max(0, Math.min(this.maxHealth, h));
    if (this.wrecked) this.damage = 1;
  }

  /** Ground pose from the wheels: height, pitch and roll. */
  /** Cheat vehicles wait out of the world until someone calls one in. */
  setStowed(on) {
    this.stowed = on;
    this.root.visible = !on;
  }

  /** Called in by a cheat: here, ready to go. */
  deploy(x, z, yaw) {
    this.setStowed(false);
    this.x = x; this.z = z; this.yaw = yaw;
    this.turretYaw = yaw;
    this.air = false;
    this.speed = 0;
    this.remote = null;
    this.driver = null;
    this.fuel = this.spec.fuelMax;
    this.setHealth(this.maxHealth);
    this.damage = 0;
    this._pose(0);
    this.place();
  }

  /** The extra numbers a driver sends after [x, z, yaw, speed, fuel, index]. */
  netExtra() {
    if (this.spec.plane) return [+this.y.toFixed(2), +this.pitch.toFixed(3), +this.roll.toFixed(3), this.air ? 1 : 0];
    if (this.spec.turret) return [+this.turretYaw.toFixed(3), +this.gunPitch.toFixed(3)];
    return NO_EXTRA;
  }

  setRemoteExtra(v) {
    const r = this.remote;
    if (!r || v.length < 8) return;
    if (this.spec.plane) { r.y = v[6]; r.pitch = v[7]; r.roll = v[8]; this.air = !!v[9]; }
    else if (this.spec.turret) { r.ty = v[6]; r.gp = v[7]; }
  }

  /** The tank's gun follows your aim (world yaw, pitch). */
  aimTurret(yaw, pitch) {
    this.turretYaw = yaw;
    this.gunPitch = THREE.MathUtils.clamp(pitch, -0.14, 0.4);
  }

  muzzleWorld(out) {
    this.gun.group.updateWorldMatrix(true, true);
    return this.gun.tip.getWorldPosition(out);
  }

  /**
   * A plane, flown by you. input: { throttle −1..1, steer −1..1 (+ = left bank), pitch −1..1 (+ = nose up) }.
   * It rolls down the ground, lifts off by itself at takeoff speed, and sinks if it gets too
   * slow. Comes back to the ground gently and it lands; too steep, or into a building, it crashes.
   * Returns the crash speed (0 if none).
   */
  fly(delta, input, blocked) {
    const R = this.spec, P = R.plane;
    const t = this.fuel > 0 && !this.wrecked ? input.throttle : 0;
    this.throttle = Math.max(0, t);
    let v = this.speed;
    if (t > 0) v += R.accel * t * delta * (1 - v / R.maxSpeed * 0.85);
    else if (t < 0) v -= R.brake * delta;
    else v -= R.coast * delta * (this.air ? 0.3 : 1);
    v = Math.max(0, Math.min(R.maxSpeed, v));
    this.speed = v;
    if (this.fuel > 0) this.fuel = Math.max(0, this.fuel - R.burn * this.throttle * delta);
    const lift = Math.max(0, Math.min(1, (v - P.stall) / (P.takeoff - P.stall)));
    const k = 1 - Math.exp(-2.4 * delta);
    if (!this.air) {
      this.yawRate = input.steer * 0.75 * Math.min(1, v / 8);
      const yaw = this.yaw + this.yawRate * delta;
      const nx = this.x + Math.sin(yaw) * v * delta, nz = this.z + Math.cos(yaw) * v * delta;
      if (v > 3 && this._blockedAt(nx, nz, yaw, blocked)) { this.speed = 0; return v; }
      this.x = nx; this.z = nz; this.yaw = yaw;
      if (v >= P.takeoff) { this.air = true; this.climb = 2.5; }
      return 0;
    }
    let want = input.pitch * P.maxPitch;
    if (this.climb > 0) { this.climb -= delta; want = Math.max(want, 0.32); }
    want -= (1 - lift) * 0.8;
    this.pitch += (want - this.pitch) * k;
    this.roll += (-input.steer * P.maxRoll - this.roll) * k;
    this.yawRate = -Math.sin(this.roll) * P.turn;
    this.yaw += this.yawRate * delta;
    // The edge of the island: it turns you back
    const far = Math.hypot(this.x, this.z);
    if (far > 490) {
      let d = (Math.atan2(-this.x, -this.z) - this.yaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * 1.5 * delta;
    }
    const cp = Math.cos(this.pitch);
    this.x += Math.sin(this.yaw) * cp * v * delta;
    this.z += Math.cos(this.yaw) * cp * v * delta;
    this.y = Math.min(P.top, this.y + Math.sin(this.pitch) * v * delta - (1 - lift) * 14 * delta);
    const ground = groundHeight(this.x, this.z);
    if (this.y <= ground) {
      this.y = ground;
      const sink = -Math.sin(this.pitch) * v;
      this.air = false;
      this.pitch = this.roll = 0;
      if (sink > 9 || Math.abs(this.roll) > 0.5) { const c = v; this.speed = 0; return Math.max(20, c); }
      return 0;
    }
    if (this.y - ground < P.clearance && blocked(this.x, this.z, 2.5, this)) {
      const c = v;
      this.air = false;
      this.speed = 0;
      this.pitch = this.roll = 0;
      return Math.max(20, c);
    }
    return 0;
  }

  /** Smooths a plane someone else flies; one nobody flies comes down. */
  _planeTick(delta) {
    const r = this.remote;
    if (r && this.driver !== "local" && r.y !== undefined) {
      const k = 1 - Math.exp(-10 * delta);
      this.y += (r.y - this.y) * k;
      this.pitch += (r.pitch - this.pitch) * k;
      this.roll += (r.roll - this.roll) * k;
    } else if (this.air && this.driver === null) {
      this.pitch += (-0.6 - this.pitch) * (1 - Math.exp(-delta));
      this.x += Math.sin(this.yaw) * this.speed * delta;
      this.z += Math.cos(this.yaw) * this.speed * delta;
      this.y -= 30 * delta;
      const g = groundHeight(this.x, this.z);
      if (this.y <= g) { this.y = g; this.air = false; this.speed = 0; this.pitch = this.roll = 0; this.setHealth(0); this.place(); }
    }
    if (this.prop) this.prop.rotation.z += (this.throttle * 40 + Math.abs(this.speed)) * delta;
  }

  _pose(delta) {
    if (this.spec.plane && this.air) {
      this.root.position.set(this.x, this.y, this.z);
      this.root.rotation.set(-this.pitch + this.jolt, this.yaw, this.roll + this.joltRoll);
      return;
    }
    const { front, rear: back, track } = this.spec.wheels;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const fx = sy, fz = cy;          // forward
    const lx = cy, lz = -sy;         // left
    const hF = groundHeight(this.x + fx * front, this.z + fz * front);
    const hL = groundHeight(this.x + fx * back + lx * track, this.z + fz * back + lz * track);
    const hR = groundHeight(this.x + fx * back - lx * track, this.z + fz * back - lz * track);
    const rear = (hL + hR) / 2;
    const pitch = Math.atan2(hF - rear, front - back);
    // Leans out of a slide (a little body roll you can feel); a bike leans into the turn
    const roll = this.spec.bike ? -this.lean : Math.atan2(hL - hR, track * 2) - this.slip * 0.035;
    const y = rear + (hF - rear) * (-back / (front - back));
    if (delta > 0) {
      // A little suspension: ease into the new pose
      const k = 1 - Math.exp(-14 * delta);
      this.y += (y - this.y) * k;
      this.pitch += (pitch - this.pitch) * k;
      this.roll += (roll - this.roll) * k;
    } else {
      this.y = y; this.pitch = pitch; this.roll = roll;
    }
    if (this.spec.bike) this.roll = roll;   // (its own spring already eased it)
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.set(-this.pitch + this.jolt, this.yaw, this.roll + this.joltRoll);
  }

  /**
   * Local driving. input: { throttle −1..1, steer −1..1 (+ = left), handbrake,
   * grip: surface grip ×, 1 on asphalt (dirt, sand and water are lower) }.
   * blocked(x, z, r): true if a circle there hits something solid.
   * Returns the speed lost in a crash (0 if none).
   *
   * Steering is a bicycle model. When a turn asks for more sideways force than
   * the tyres have (spec.grip × surface × g), the difference pushes the
   * vehicle outward as `slip`, which the tyres then scrub off: a drift. The
   * handbrake loosens the grip and lets the back step out.
   */
  drive(delta, input, blocked) {
    const R = this.spec;
    const t = this.fuel > 0 && !this.wrecked ? input.throttle : 0;
    this.throttle = Math.abs(t);
    let v = this.speed;
    if (t > 0) {
      if (v < -0.3) v += R.brake * delta;
      else v += R.accel * t * delta * (1 - Math.max(0, v) / R.maxSpeed);
    } else if (t < 0) {
      if (v > 0.3) v -= R.brake * delta;
      else v = Math.max(-R.reverseSpeed, v - R.accel * 0.6 * delta);
    } else {
      v -= Math.sign(v) * Math.min(Math.abs(v), R.coast * delta);
    }
    if (input.handbrake) v -= Math.sign(v) * Math.min(Math.abs(v), R.brake * 1.4 * delta);
    // Hills: slows you going up, speeds you up coming down
    v -= Math.sin(this.pitch) * 9.8 * 0.55 * delta;
    v = Math.max(-R.reverseSpeed, Math.min(R.maxSpeed, v));

    const steerTarget = input.steer * R.maxSteer * (1 - 0.5 * Math.min(1, Math.abs(v) / R.maxSpeed));
    this.steer += (steerTarget - this.steer) * (1 - Math.exp(-(R.steerRate ?? 7) * delta));
    const grip = (R.grip ?? 0.9) * (input.grip ?? 1) * (input.handbrake ? 0.5 : 1);
    let yawRate = (v * Math.tan(this.steer)) / R.wheelBase;
    // A bike corners up to spec.bike.turn (v·ω ≤ turn: a tighter line the slower you go)
    if (R.bike) {
      const cap = R.bike.turn / Math.max(1.5, Math.abs(v));
      yawRate = THREE.MathUtils.clamp(yawRate, -cap, cap);
    }
    // Sliding: the turn wants v·ω of sideways acceleration, the tyres give grip·g
    // (a bike's tyres hold its full turn on asphalt, and let go on dirt or the handbrake)
    const want = v * yawRate, have = grip * (R.bike ? R.bike.turn / R.grip : 9.8);
    if (Math.abs(want) > have) {
      this.slip -= Math.sign(want) * (Math.abs(want) - have) * (R.slide ?? 0.15) * delta;
      if (input.handbrake) yawRate *= 1.15;
    }
    // Eased in, so a tap of the key at speed doesn't snap a bike round
    if (R.bike) yawRate = this.yawRate + (yawRate - this.yawRate) * (1 - Math.exp(-BIKE_TURN_IN * delta));
    this.slip *= Math.exp(-grip * 2.6 * delta);
    if (Math.abs(this.slip) < 0.01) this.slip = 0;
    this.skid = Math.abs(this.slip);
    this.spin *= Math.exp(-3.5 * delta);
    if (Math.abs(this.spin) < 0.01) this.spin = 0;
    const yaw = this.yaw + (yawRate + this.spin) * delta;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const nx = this.x + (sy * v + cy * this.slip) * delta;
    const nz = this.z + (cy * v - sy * this.slip) * delta;

    let crash = 0;
    // Already wedged into something (parked, spawned or synced there): let it drive out, or it would never move again
    const wedged = this._blockedAt(this.x, this.z, this.yaw, blocked);
    this.contact.on = false;
    if (!wedged && this._blockedAt(nx, nz, yaw, blocked)) {
      crash = this._collide(delta, v, yaw, nx, nz, blocked);
    } else {
      this.x = nx; this.z = nz; this.yaw = yaw;
      this.speed = v;
      this.yawRate = yawRate;
    }
    // Petrol: idling sips, throttle gulps
    if (this.fuel > 0) {
      this.fuel = Math.max(0, this.fuel - (R.idleBurn + R.burn * this.throttle * (0.5 + 0.5 * Math.abs(v) / R.maxSpeed)) * delta);
    }
    return crash;
  }

  /**
   * The move to (nx, nz) hit something. Works out where and which way the surface faces (from
   * which directions round the probe are solid). A shallow angle slides along it, scraping
   * and losing speed; steeper than that stops the vehicle dead with a small bounce, and a hit
   * off-centre knocks the nose round. Returns the speed going into the surface; the
   * details are in this.contact.
   */
  _collide(delta, v, yaw, nx, nz, blocked) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const vx = sy * v + cy * this.slip, vz = cy * v - sy * this.slip;
    const sp = Math.hypot(vx, vz);
    const { z: probes, r } = this.spec.hits;
    // The probe that hit (the one furthest along the way we're going, if several did)
    let px = nx, pz = nz, best = -Infinity;
    for (const o of probes) {
      const x = nx + sy * o, z = nz + cy * o;
      const along = o * Math.sign(v || 1);
      if (along > best && blocked(x, z, r, this)) { best = along; px = x; pz = z; }
    }
    // The surface's normal: away from whichever directions round the probe are solid
    let sx = 0, sz = 0;
    for (let i = 0; i < RING; i++) {
      const c = RING_C[i], s = RING_S[i];
      if (blocked(px + c * r * 1.4, pz + s * r * 1.4, r * 0.5, this)) { sx -= c; sz -= s; }
    }
    let l = Math.hypot(sx, sz);
    if (l < 1e-3 || sx * vx + sz * vz > 0) { sx = -vx; sz = -vz; l = sp || 1; }
    sx /= l; sz /= l;
    const into = Math.max(0, -(vx * sx + vz * sz));
    const c = this.contact;
    c.on = true; c.scrape = false;
    c.x = px - sx * r; c.z = pz - sz * r;
    c.nx = sx; c.nz = sz; c.vx = vx; c.vz = vz;

    if (sp > SCRAPE_MIN && into / sp < SCRAPE_ANGLE) {
      const tx = vx + sx * into, tz = vz + sz * into;
      const dir = v >= 0 ? 1 : -1;
      const turn = wrapPi(Math.atan2(tx * dir, tz * dir) - yaw);
      const y2 = yaw + turn * Math.min(1, 5 * delta);
      const mx = this.x + tx * delta + sx * 0.02, mz = this.z + tz * delta + sz * 0.02;
      if (!this._blockedAt(mx, mz, y2, blocked)) {
        this.x = mx; this.z = mz; this.yaw = y2;
        this.yawRate = turn * Math.min(5, 1 / Math.max(delta, 1e-3)) * 0.5;
        this.speed = v * Math.exp(-(0.5 + (into / sp) * 3) * delta);   // friction against the wall
        this.slip *= 0.8;
        c.scrape = true;
        return into;
      }
      // (Nowhere to slide: pinned in a corner, so it stops like a head-on)
    }
    // Nose-on: the ends crumple, it barely rebounds. A vehicle spins about where it was hit.
    const ax = px - this.x, az = pz - this.z;
    this.spin = THREE.MathUtils.clamp((ax * sz - az * sx) * into * 0.14, -1.8, 1.8);
    this.speed = -v * (0.14 + 0.16 * (1 - Math.min(1, into / 18)));
    this.yawRate = 0;
    this.slip = 0;
    return into;
  }

  /**
   * The body's reaction to a hit, here and on everyone else's screen. strength 0..1, side: which
   * way it rolls (−1..1), dir: 1 nose-first, −1 tail-first.
   */
  impact(strength, side = 0, dir = 1) {
    const B = this.spec.bike;
    this.joltV += dir * strength * (B ? 1.6 : 1.1);
    this.joltRollV += side * strength * (B ? 1.2 : 0.9);
    // A bike wobbles hard: the lean spring takes the kick and shakes it out
    if (B) this.leanV += side * strength * 5;
    if (strength > 0.3) this.damage = Math.min(1, this.damage + strength * 0.7);
    this._settle = Math.max(this._settle, 0.6);
  }

  /** The colour of its bodywork ([r, g, b, gloss]), for the bits a crash knocks off. */
  paintColor(out) {
    const p = PAINT[this.kind] ?? PAINT.thar;
    out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; out[3] = p[3];
    return out;
  }

  /** Smoke from a smashed engine: thick and dark at first, thinning as it clears. fx: DustFX. */
  emitDamageSmoke(fx, delta, color) {
    const R = this.spec;
    this._smoke = Math.min(3, this._smoke + (2 + this.damage * 7) * delta);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const fwd = R.length * 0.28, y = this.y + (R.bike ? 0.55 : 0.85);
    while (this._smoke >= 1) {
      this._smoke -= 1;
      fx.emit(
        this.x + sy * fwd + (Math.random() - 0.5) * 0.25, y, this.z + cy * fwd + (Math.random() - 0.5) * 0.25,
        (Math.random() - 0.5) * 0.5 + sy * this.speed * 0.5, 1.4 + Math.random() * 1.4, (Math.random() - 0.5) * 0.5 + cy * this.speed * 0.5,
        0.5 + this.damage * 0.8 + Math.random() * 0.4,
        color,
      );
    }
  }

  _blockedAt(x, z, yaw, blocked) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const { z: probes, r } = this.spec.hits;
    for (const o of probes) if (blocked(x + sy * o, z + cy * o, r, this)) return true;
    return false;
  }

  /** Someone else is driving: their latest pose. */
  setRemote(id, x, z, yaw, speed, fuel) {
    if (this.stowed) this.setStowed(false);   // (someone's driving it, whatever we heard)
    if (this.driver !== id) {
      this.driver = id;
      if (!this.remote) { this.x = x; this.z = z; this.yaw = yaw; }
    }
    this.remote = { x, z, yaw, speed, age: 0 };
    this.fuel = fuel;
  }

  /** The remote driver got out (or left): park where it is. */
  releaseRemote() {
    this.driver = null;
    this.remote = null;
    this.speed = 0;
    this.yawRate = 0;
    this._settle = 0.5;   // (a bike settles onto its kickstand)
  }

  /**
   * Every frame, after drive() / setRemote(). Places the model and the
   * collider, and runs the lights. darkness: 0 day … 1 night.
   */
  update(delta, darkness) {
    const r = this.remote;
    if (r && this.driver !== "local") {
      // Dead-reckon between packets, then ease toward it
      r.age += delta;
      if (r.age < 0.3) { r.x += Math.sin(r.yaw) * r.speed * delta; r.z += Math.cos(r.yaw) * r.speed * delta; }
      const k = 1 - Math.exp(-12 * delta);
      const prevX = this.x, prevZ = this.z;
      this.x += (r.x - this.x) * k;
      this.z += (r.z - this.z) * k;
      let dy = (r.yaw - this.yaw) % (Math.PI * 2);
      if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * k;
      this.speed = delta > 0 ? Math.hypot(this.x - prevX, this.z - prevZ) / delta * Math.sign(r.speed || 1) : 0;
      this.throttle = Math.min(1, Math.abs(r.speed) / this.spec.maxSpeed + 0.2);
    }
    if (this.spec.bike) this._bikeDynamics(delta);
    if (this.spec.plane) this._planeTick(delta);
    if (this.gun) {
      if (r && this.driver !== "local" && r.ty !== undefined) { this.turretYaw = r.ty; this.gunPitch = r.gp; }
      this.gun.group.rotation.y = this.turretYaw - this.yaw;
      this.gun.barrel.rotation.x = -this.gunPitch;
    }
    if (delta > 0) {
      // The jolt of a hit: springs, a little under-damped, so the body rocks and settles
      const d = Math.min(delta, 0.05);
      this.joltV += (-this.jolt * JOLT_K - this.joltV * JOLT_D) * d;
      this.jolt += this.joltV * d;
      this.joltRollV += (-this.joltRoll * JOLT_K - this.joltRollV * JOLT_D) * d;
      this.joltRoll += this.joltRollV * d;
      if (this.damage > 0 && !this.wrecked) this.damage = Math.max(0, this.damage - delta / DAMAGE_CLEAR);
    }
    // A parked vehicle nobody touches doesn't need re-posing every frame
    const moving = this.driver !== null || this._settle > 0 || this.air || (this.spec.bike && Math.abs(this.leanV) + Math.abs(this.diveV) > 0.01);
    if (moving) {
      this._pose(delta);
      this._settle = this.driver !== null ? 0.5 : this._settle - delta;
    }

    if (moving) {
      // Collider follows; its velocity lets it push bodies it drives into
      const b = this.body;
      b.position.set(this.x, this.y, this.z);
      _q.setFromEuler(_e.set(-this.pitch, this.yaw, this.roll));
      b.quaternion.set(_q.x, _q.y, _q.z, _q.w);
      b.velocity.set(Math.sin(this.yaw) * this.speed, 0, Math.cos(this.yaw) * this.speed);
      b.angularVelocity.set(0, this.yawRate, 0);
      b.aabbNeedsUpdate = true;
    }

    for (const w of this.spinners) {
      w.tyre.rotation.x += (this.speed / w.r) * delta;
      if (w.front) w.steer.rotation.y = this.steer;
    }
    for (const w of this.bikeWheels) w.group.rotation.x += (this.speed / w.r) * delta;

    const on = this.driver !== null && this.fuel > 0 && !this.wrecked;
    const want = on && darkness > 0.4 ? 1 : 0;
    if (want || this.lightLevel > 0.001) {
      this.lightLevel += (want - this.lightLevel) * (1 - Math.exp(-8 * delta));
      if (!want && this.lightLevel < 0.002) this.lightLevel = 0;
    }
    this.lampMat.emissiveIntensity = 0.3 * (on ? 1 : 0) + 3 * this.lightLevel;
    this.tailMat.emissiveIntensity = 1.5 * this.lightLevel;
  }

  /**
   * A bike's lean and suspension, from how it's moving (driven here or smoothed from the
   * driver's packets): it leans into a turn with how hard the turn is, to spec.bike.lean at its limit,
   * stands up when slow, rests on its kickstand when nobody's on it; the nose dips on the
   * brakes and lifts on the throttle. The kickstand swings down when parked.
   */
  _bikeDynamics(delta) {
    const B = this.spec.bike;
    if (delta <= 0) return;
    const ridden = this.driver !== null;
    const v = this.speed;
    let want;
    if (ridden) {
      want = B.lean * THREE.MathUtils.clamp(v * this.yawRate / B.turn, -1, 1);
      // Stopped with a foot down: tipped a little toward it
      want += B.stand * 0.35 * (1 - Math.min(1, Math.abs(v) / 2));
    } else {
      want = Math.abs(v) < 0.5 ? B.stand : 0;
    }
    // Leaning is a spring: quick into a turn, a little settle after
    const k = ridden ? 9 : 5;
    this.leanV += ((want - this.lean) * k * k - 2 * k * 0.8 * this.leanV) * delta;
    this.lean += this.leanV * delta;
    const accel = (v - this._lastSpeed) / delta;
    this._lastSpeed = v;
    const diveWant = THREE.MathUtils.clamp(-accel * 0.008, -0.05, 0.07);
    this.diveV += ((diveWant - this.dive) * 140 - 2 * 12 * 0.6 * this.diveV) * delta;
    this.dive += this.diveV * delta;
    this.chassis.rotation.x = this.dive;
    if (this.kickstand) {
      const down = !ridden && Math.abs(v) < 0.5 ? 1 : 0;
      this.kickstand.userData.k = (this.kickstand.userData.k ?? 1) + (down - (this.kickstand.userData.k ?? 1)) * (1 - Math.exp(-10 * delta));
      const kk = this.kickstand.userData.k;
      // Down: out to the left and a little forward (onto the ground); up: tucked back along the frame
      this.kickstand.rotation.set(THREE.MathUtils.lerp(1.45, 0.25, kk), 0, THREE.MathUtils.lerp(0, 0.55, kk));
    }
  }

  /** A point given in the vehicle's own frame ([x, y, z] or a Vector3) in the world. */
  pointWorld(local, out) {
    this.root.updateMatrixWorld();
    return Array.isArray(local) ? out.set(local[0], local[1], local[2]).applyMatrix4(this.root.matrixWorld) : out.copy(local).applyMatrix4(this.root.matrixWorld);
  }

  /** World position of the pillion rider's hips. */
  pillionWorld(out) { return this.pointWorld(this.pillionSeat, out); }

  /** Points a (shared) spotlight out of this vehicle's lamps, at its current brightness. */
  aimHeadlight(light) {
    const [, y, z] = this.spec.lamps[0];
    this.root.updateMatrixWorld();
    light.position.set(0, y, z).applyMatrix4(this.root.matrixWorld);
    light.target.position.set(0, 0.1, z + 14).applyMatrix4(this.root.matrixWorld);
    light.target.updateMatrixWorld();
    light.intensity = this.spec.headlight * this.lightLevel;
  }

  /**
   * Dust behind the rear wheels. fx: DustFX. surface: { amount: 0 (asphalt)
   * ... 1 (loose dirt), color, smoke } (DUST colours). Faster and sliding means
   * more; on asphalt only a slide makes (tyre) smoke. Capped per frame.
   */
  emitDust(fx, delta, surface) {
    if (this.air) return;
    const sp = Math.abs(this.speed);
    const R = this.spec;
    const rate = Math.max(0, sp - 1.2) * (R.dust ?? 1) * surface.amount + this.skid * (surface.amount > 0 ? 10 : 6);
    if (rate <= 0.05) { this._dust = 0; return; }
    this._dust = Math.min(6, this._dust + rate * 2 * delta);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const { rear, track } = R.wheels;
    const big = 0.7 + R.width * 0.25;
    while (this._dust >= 1) {
      this._dust -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = this.x + sy * (rear - 0.3) + cy * track * side;
      const z = this.z + cy * (rear - 0.3) - sy * track * side;
      const back = -0.3 * this.speed, out = (Math.random() - 0.5) * 1.6 - this.slip * 0.4;
      fx.emit(
        x, this.y + 0.25, z,
        sy * back + cy * out, 0.6 + Math.random() * 0.6, cy * back - sy * out,
        big * (0.8 + Math.random() * 0.5) * (1 + this.skid * 0.12),
        surface.amount > 0 ? surface.color : surface.smoke,
      );
    }
  }

  /** Re-pose and re-place the collider now (after a teleport: reset, a late joiner's world state). */
  place() {
    this._settle = 0.5;
  }

  /** World position of the driver's hips. */
  seatWorld(out) {
    this.root.updateMatrixWorld();
    return out.copy(this.seat).applyMatrix4(this.root.matrixWorld);
  }

  distanceTo(x, z) { return Math.hypot(this.x - x, this.z - z); }

  /** A free spot next to the vehicle to step out to: driver's side, the other side, then behind. */
  exitSpot(blocked, out) {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const side = this.spec.width / 2 + 0.8, back = this.spec.length / 2 + 0.9;
    const first = this.spec.seat[0] < 0 ? -1 : 1; // the driver's door
    const spots = [[cy * side * first, -sy * side * first], [-cy * side * first, sy * side * first], [-sy * back, -cy * back], [sy * (back + 0.2), cy * (back + 0.2)]];
    for (const [dx, dz] of spots) {
      if (!blocked(this.x + dx, this.z + dz, 0.45)) { out.x = this.x + dx; out.z = this.z + dz; return out; }
    }
    out.x = this.x + spots[0][0]; out.z = this.z + spots[0][1];
    return out;
  }
}
