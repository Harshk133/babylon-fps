import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GROUP_WORLD, GROUP_GLASS, GROUP_ZOMBIE } from "../physicsGroups.js";
import { mergeStaticMeshes } from "./MergeStatic.js";
import { PROPS, COLUMNS, YARD, VEHICLES, TREES } from "./workshopColliders.js";

// The college workshop (public/models/college_workshop.glb, optimized copy loaded
// first): one big steel-truss hall (x 0..56, z −13..13, floor at y = 0, eaves 5.9,
// ridge 8.5) with welding, machine, carpentry and fitting shops, a store annex with a
// stair to its roof, a covered corridor to the north door and a ring road round it
// all (x −11..66.5, z −31..24, 0.45 below the floor). Its west door faces the road.
// The model's terrain slab, 16 m block and compound wall are not used (dropNodes in
// optimize-assets, NOT_USED here for the unoptimized file): the terrain is tinted.
//
// Drawing: 136k triangles in the file, seldom on screen. Each tier is merged into
// one mesh per material (the file shares one atlas), about a dozen draw calls at most:
// - shell: what you can see from anywhere, always (down to WorldChunks' range).
//   The inside walls and floor stay because you'd see through the window openings.
// - detail: window frames, shutters, parked vehicles, street lamps, the stair.
// - interior: trusses, columns, machines, benches, fans, tube lights, signs. Only near
//   or inside: hardly any of it shows through the windows.
// - only the outer walls, the roof, the annex and the trees cast shadows; nothing
//   inside would (the roof already shades the whole floor).
// - closed models are drawn single-sided (TWO_SIDED lists the ones with open surfaces).
// There are no lights: the tubes are emissive, the shading is baked into the textures.
//
// Colliders: workshopColliders.js (made by scripts/build-workshop-colliders.mjs) plus
// the building itself, below. Window openings are GROUP_GLASS like the houses' (bullets
// pass); the clerestory windows, out of reach at 4.6 m, are plain wall.

/** Where it stands: the campus's centre (m), its door facing the named road; r: the campus radius. */
export const COLLEGE_WORKSHOP = { name: "College Workshop", road: "North Road", x: 66, z: 270, r: 50 };

const CENTRE = { x: 27.75, z: -3.5 };   // the campus's centre in the model (the ring road's)
const YARD_Y = -0.45;                   // model y of the ground outside
const LIFT = 0.03;                      // m: the yard this far over the flattened ground
const HALL = { x0: -0.26, x1: 56.26, z0: -13.26, z1: 13.26 };
const DETAIL_RANGE = 110;               // m from the walls: frames, shutters, vehicles, lamps drawn within this
const INTERIOR_RANGE = 18;              // m from the walls (just past the ring road): everything inside drawn within this
const CELL = 12;                        // m: colliders are grouped into one body per cell
const LOOT_EVERY = 3;                   // a loot spot on every this many benches

const EAVE = 5.9, RIDGE = 8.5;
const SILL = 1, WINDOW_TOP = 2.7, DOOR_TOP = 3.7, WINDOW_W = 1.5;
// Window centres along each wall, and the doorways [from, to] (from the model)
const W_LONG = Array.from({ length: 14 }, (_, i) => 2 + 4 * i);
const WALLS = {
  north: { windows: W_LONG.filter(c => c !== 26), door: [24.5, 27.5] },
  south: { windows: W_LONG.filter(c => c !== 46), door: [44.5, 47.5] },
  west: { windows: [-11.3, -8.5, 3.5, 7, 10.5], door: [-5, -1.5] },
  east: { windows: [-11, -7.5, -4, 4, 7.5, 11], door: null },
};
// Where monsters go in and out: [outside, inside] approach points (x, z), and the
// strip (x0, x1, z0, z1) that leads straight through the door
const DOORS = [
  { out: [26, -26], in: [26, -11.5], strip: [24.4, 27.6, -25.5, -12] },
  { out: [46, 15.6], in: [46, 11.5], strip: [44.6, 47.4, 12, 15.2] },
  { out: [-3.2, -3.25], in: [1.5, -3.25], strip: [-2.8, 1, -4.9, -1.6] },
];

const NOT_USED = /^(BAKE_Ground_Terrain|GLB_Neighbouring_Buildings)$/;
const SHELL = /^(BAKE_|GLB_Ground_and_Roads$|GLB_Vegetation$|GLB_Store_Room|GLB_Entrance_Corridor$|GLB_Roof_Structure$|GLB_Skylights$)/;
const DETAIL = /^GLB_(Windows|Entrance|Exterior_|Vehicles)/;
const SHADOW = /^(BAKE_Exterior_Shell|BAKE_Roof_Sheets|GLB_Vegetation|GLB_Store_Room)/;
const TWO_SIDED = /^GLB_(Entrance_Corridor|Furniture|Wall_Displays|Welding_Shop)$/;
const FAR_APRON_Z = 24.05;              // the neighbour's forecourts lie past the ring road, in GLB_Ground_and_Roads

const _soil = new THREE.Color(0x8a6f4d);
/** Terrain vertex tint: bare earth over the campus, fading out at its edge. */
export function workshopTint(x, z, c) {
  const d = Math.hypot(x - COLLEGE_WORKSHOP.x, z - COLLEGE_WORKSHOP.z), r = COLLEGE_WORKSHOP.r;
  if (d < r + 8) c.lerp(_soil, 0.8 * (1 - THREE.MathUtils.smoothstep(d, r - 3, r + 8)));
}

const box = (x0, y0, z0, x1, y1, z1) => ({
  c: new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
  h: new THREE.Vector3((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2),
});
const fromArr = b => box(b[0], b[1], b[2], b[3], b[4], b[5]);

/** The boxes of one wall running along from..to (u), between a..b across it. */
function wallBoxes({ windows, door }, from, to, a, b, place, solid, glass) {
  const add = (u0, y0, u1, y1, list = solid) => { if (u1 > u0) list.push(place(u0, y0, u1, y1, a, b)); };
  const hw = WINDOW_W / 2;
  // Piers between the openings, floor to eaves
  const gaps = [...windows.map(c => [c - hw, c + hw]), ...(door ? [door] : [])].sort((p, q) => p[0] - q[0]);
  let u = from;
  for (const [g0, g1] of gaps) { add(u, YARD_Y, g0, EAVE); u = g1; }
  add(u, YARD_Y, to, EAVE);
  for (const c of windows) {
    add(c - hw, YARD_Y, c + hw, SILL);
    add(c - hw, SILL, c + hw, WINDOW_TOP, glass);
    add(c - hw, WINDOW_TOP, c + hw, EAVE);
  }
  if (door) add(door[0], DOOR_TOP, door[1], EAVE);
}

/** The whole building's shapes in the model's frame. */
function buildingShapes() {
  const solid = [], glass = [], low = [];
  const alongX = (u0, y0, u1, y1, a, b) => box(u0, y0, a, u1, y1, b);
  const alongZ = (u0, y0, u1, y1, a, b) => box(a, y0, u0, b, y1, u1);
  wallBoxes(WALLS.north, HALL.x0, HALL.x1, HALL.z0, -13, alongX, solid, glass);
  wallBoxes(WALLS.south, HALL.x0, HALL.x1, 13, HALL.z1, alongX, solid, glass);
  wallBoxes(WALLS.west, -13, 13, HALL.x0, 0, alongZ, solid, glass);
  wallBoxes(WALLS.east, -13, 13, 56, HALL.x1, alongZ, solid, glass);
  // Gable ends over the eaves, and the roof's two slopes (bullets, grenades, the dragon's sight)
  solid.push(box(HALL.x0, EAVE, -7, 0, 7.2, 7), box(56, EAVE, -7, HALL.x1, 7.2, 7));
  const slope = Math.atan2(RIDGE - EAVE, 13.5), len = Math.hypot(RIDGE - EAVE, 13.5);
  for (const s of [1, -1]) {
    solid.push({
      c: new THREE.Vector3(28, (RIDGE + EAVE) / 2 - 0.08, s * 6.75),
      h: new THREE.Vector3(28.3, 0.08, len / 2),
      q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), s * slope),
    });
  }
  // The floor and the steps up to it (a rise of 0.45 is more than the player steps)
  low.push(box(-0.3, -0.6, -13.3, 56.3, 0, 13.3));
  low.push(box(-2.2, -0.6, -5, -1.2, -0.24, -1.5), box(-1.2, -0.6, -5, -0.26, -0.06, -1.5));
  low.push(box(44.1, -0.6, 13.96, 47.9, -0.22, 14.56), box(44.1, -0.6, 13.26, 47.9, 0, 13.96));
  low.push(box(24.2, -0.6, -14.16, 27.8, -0.15, -13.7), box(24.2, -0.6, -13.7, 27.8, 0, -13.26));
  // North corridor: slab, low walls, columns, roof; the sign frame on its end
  low.push(box(23.8, -0.6, -25, 28.2, -0.3, -14.16));
  low.push(box(23.93, -0.3, -22.8, 24.27, 0.3, -15), box(27.73, -0.3, -22.8, 28.07, 0.3, -15));
  for (const [z0, z1] of [[-23.84, -23.36], [-20.21, -19.79], [-16.41, -15.99]]) solid.push(box(23.86, -0.3, z0, 24.35, 3.3, z1), box(27.65, -0.3, z0, 28.14, 3.3, z1));
  solid.push(box(23.7, 3.29, -24.6, 28.05, 3.51, -13.26), box(23.4, 3.51, -24.45, 28.6, 4.55, -24.19));
  // South door's canopy; the store annex (shut, no way in) with its roof units
  solid.push(box(43.7, 3.59, 13.26, 48.3, 3.71, 14.46));
  solid.push(box(28.05, YARD_Y, -21.75, 37.55, 3.5, -13.26));
  solid.push(box(33, 3.5, -16.1, 34.2, 4.7, -14.9), box(34.4, 3.5, -16.1, 35.6, 4.7, -14.9));
  // The stair up to the annex's roof: one ramp (x 29.6 → 35.4) and its landing
  const A = new THREE.Vector3(29.6, YARD_Y, -22.15), B = new THREE.Vector3(35.4, 3.58, -22.15);
  const tilt = Math.atan2(B.y - A.y, B.x - A.x), n = new THREE.Vector3(-Math.sin(tilt), Math.cos(tilt), 0);
  low.push({
    c: new THREE.Vector3().addVectors(A, B).multiplyScalar(0.5).addScaledVector(n, -0.1),
    h: new THREE.Vector3(A.distanceTo(B) / 2, 0.1, 0.4),
    q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), tilt),
  });
  low.push(box(35.4, 3.38, -22.6, 36.4, 3.58, -21.7));
  return { solid, glass, low };
}

/** Removes a mesh's triangles lying wholly past z in the model's frame (a compressed mesh is scaled by its node). */
function cutPastZ(mesh, zMax) {
  const geometry = mesh.geometry, pos = geometry.attributes.position, ix = geometry.index;
  if (!ix) return;
  const e = mesh.matrixWorld.elements;
  const past = i => e[2] * pos.getX(i) + e[6] * pos.getY(i) + e[10] * pos.getZ(i) + e[14] > zMax;
  const keep = [];
  for (let t = 0; t < ix.count; t += 3) {
    const a = ix.getX(t), b = ix.getX(t + 1), c = ix.getX(t + 2);
    if (!(past(a) && past(b) && past(c))) keep.push(a, b, c);
  }
  geometry.setIndex(keep);
}

/** The glTF node name a mesh came from (multi-material nodes load as a group of unnamed meshes). */
const nodeName = o => (o.parent?.parent ? o.parent.name : o.name);

/**
 * gltf: the loaded model. roads: world/Roads.js. groundAt(x, z): the finished terrain.
 * Returns { x, z, rot, lootSpots, blocks(), inside(), surfaceAt(), navigate(), update(x, z) }.
 */
export function placeCollegeWorkshop({ gltf, scene, world, material, roads, groundAt, mapObstacles, navObstacles, chunks, anisotropy = 1 }) {
  const def = COLLEGE_WORKSHOP;
  // The west door (local −X) toward the road, square to it
  const road = roads.byName(def.road);
  const at = roads.pointAt(road, roads.arcNear(road, def.x, def.z));
  const rot = Math.atan2(at.z - def.z, def.x - at.x);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const baseY = groundAt(def.x, def.z) + LIFT - YARD_Y;   // world y of the hall's floor (model y = 0)

  const toWorld = (lx, lz, out = {}) => {
    const x = lx - CENTRE.x, z = lz - CENTRE.z;
    out.x = def.x + x * cos + z * sin;
    out.z = def.z - x * sin + z * cos;
    return out;
  };
  const _l = { x: 0, z: 0 };
  const toLocal = (x, z) => {
    const dx = x - def.x, dz = z - def.z;
    _l.x = dx * cos - dz * sin + CENTRE.x;
    _l.z = dx * sin + dz * cos + CENTRE.z;
    return _l;
  };

  // ── Colliders
  const turn = new CANNON.Quaternion().setFromEuler(0, rot, 0);
  /** One static body per CELL (each body at its own centre, for the broadphase grid). */
  const addBodies = (list, opts) => {
    const cells = new Map();
    for (const s of list) {
      const k = `${Math.floor(s.c.x / CELL)},${Math.floor(s.c.z / CELL)}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(s);
    }
    for (const group of cells.values()) {
      const mid = new THREE.Vector3();
      for (const s of group) mid.add(s.c);
      mid.divideScalar(group.length);
      const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD, ...opts });
      for (const s of group) {
        const h = new CANNON.Vec3(Math.max(s.h.x, 0.04), Math.max(s.h.y, 0.04), Math.max(s.h.z, 0.04));
        const q = s.q ? new CANNON.Quaternion(s.q.x, s.q.y, s.q.z, s.q.w) : undefined;
        body.addShape(new CANNON.Box(h), new CANNON.Vec3(s.c.x - mid.x, s.c.y - mid.y, s.c.z - mid.z), q);
      }
      const w = toWorld(mid.x, mid.z);
      body.position.set(w.x, baseY + mid.y, w.z);
      body.quaternion.copy(turn);
      world.addBody(body);
    }
  };
  const { solid, glass, low } = buildingShapes();
  const trunk = ([x, z]) => box(x - 0.25, YARD_Y, z - 0.25, x + 0.25, 4, z + 0.25);
  addBodies([...solid, ...COLUMNS.map(fromArr), ...YARD.map(fromArr), ...VEHICLES.map(fromArr), ...TREES.map(trunk)]);
  addBodies(glass, { collisionFilterGroup: GROUP_GLASS });
  // The floor, steps, stair and benches: monsters walk through (surfaceAt holds them on the floor)
  addBodies([...low, ...PROPS.map(fromArr)], { collisionFilterMask: ~GROUP_ZOMBIE });

  // The minimap, vehicles and the monsters' pathing see the buildings as whole blocks
  // (navigate() below takes monsters through the doors), and the cars and trunks too
  const obstacle = (x0, z0, x1, z1) => {
    const w = toWorld((x0 + x1) / 2, (z0 + z1) / 2);
    const o = { type: "box", x: w.x, z: w.z, rot, w: x1 - x0, d: z1 - z0, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2 };
    mapObstacles.push(o);
    navObstacles.push(o);
  };
  obstacle(HALL.x0, HALL.z0, HALL.x1, HALL.z1);
  obstacle(28.05, -21.75, 37.55, -13.26);
  for (const b of VEHICLES) if ((b[3] - b[0]) * (b[5] - b[2]) > 2) obstacle(b[0], b[2], b[3], b[5]);
  for (const t of TREES) {
    const w = toWorld(t[0], t[1]);
    mapObstacles.push({ type: "circle", x: w.x, z: w.z, r: 0.4 });
  }

  // Loot on the workbenches (waist-high tops of some size), and two up on the annex's roof
  const lootSpots = [];
  PROPS.filter(b => b[4] > 0.6 && b[4] < 1.3 && (b[3] - b[0]) * (b[5] - b[2]) > 0.7).forEach((b, i) => {
    if (i % LOOT_EVERY) return;
    const w = toWorld((b[0] + b[3]) / 2, (b[2] + b[5]) / 2);
    lootSpots.push({ x: w.x, y: baseY + b[4] + 0.02, z: w.z });
  });
  for (const [x, z] of [[30, -19], [36, -17]]) {
    const w = toWorld(x, z);
    lootSpots.push({ x: w.x, y: baseY + 3.52, z: w.z });
  }
  // Door approach points in the world
  const doors = DOORS.map(d => {
    const o = toWorld(d.out[0], d.out[1]), n = toWorld(d.in[0], d.in[1]);
    return { ox: o.x, oz: o.z, ix: n.x, iz: n.z, strip: d.strip };
  });

  // ── Drawing
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const shell = new THREE.Group(), detail = new THREE.Group(), interior = new THREE.Group();
  const parts = [], frontSide = new Map();
  model.traverse(o => { if (o.isMesh) parts.push(o); });
  for (const o of parts) {
    const name = nodeName(o);
    if (NOT_USED.test(name)) { o.removeFromParent(); continue; }
    if (name === "GLB_Ground_and_Roads") cutPastZ(o, FAR_APRON_Z);
    let m = o.material;
    if (m.transparent) {
      // Glass and wire mesh: no depth writes, one pass
      m.depthWrite = false;
      m.forceSinglePass = true;
    } else if (m.side === THREE.DoubleSide && m.map && !TWO_SIDED.test(name) && name !== "BAKE_Roof_Sheets") {
      if (!frontSide.has(m)) {
        const f = m.clone();
        f.side = THREE.FrontSide;
        frontSide.set(m, f);
      }
      o.material = m = frontSide.get(m);
    }
    if (m.map && /^BAKE_/.test(name)) m.map.anisotropy = anisotropy;
    if (name === "BAKE_Roads") {
      // A hair over the flattened ground: pulled forward so it never flickers into the terrain
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      m.polygonOffsetUnits = -4;
    }
    // The panes stay when the frames go (or you'd see through the building from afar)
    // Lettering on the annex and corridor signs is thousands of triangles only readable up close
    const lettering = m.name === "GLB_Emissive" && name !== "GLB_Skylights";
    const group = lettering && SHELL.test(name) ? detail
      : SHELL.test(name) || m.name === "GLB_Glass" ? shell : DETAIL.test(name) ? detail : interior;
    o.castShadow = SHADOW.test(name) && !m.transparent && !lettering;
    // Nothing in the hall takes the sun's shadow: the roof would put all of it in the dark, and it's lit as if by the skylights
    o.receiveShadow = group !== interior && !/^BAKE_(Floor|Walls)_Interior$/.test(name);
    group.attach(o);
  }
  for (const g of [shell, detail, interior]) mergeStaticMeshes(g);

  const root = new THREE.Group();
  root.position.set(def.x, baseY, def.z);
  root.rotation.y = rot;
  const offset = new THREE.Group();
  offset.position.set(-CENTRE.x, 0, -CENTRE.z);
  offset.add(shell, detail, interior);
  root.add(offset);
  scene.add(root);
  root.updateMatrixWorld(true);
  root.traverse(o => { o.matrixAutoUpdate = false; });
  chunks?.add(root, def.x, def.z, def.r);

  const near = (x, z) => Math.abs(x - def.x) < def.r && Math.abs(z - def.z) < def.r;
  /** True under the hall's roof. */
  const inside = (x, z) => {
    if (!near(x, z)) return false;
    const l = toLocal(x, z);
    return l.x > HALL.x0 && l.x < HALL.x1 && l.z > HALL.z0 && l.z < HALL.z1;
  };
  const onStrip = (door, x, z) => {
    const l = toLocal(x, z), s = door.strip;
    return l.x > s[0] && l.x < s[1] && l.z > s[2] && l.z < s[3];
  };

  return {
    x: def.x, z: def.z, rot, lootSpots, baseY, toWorld, tiers: { shell, detail, interior },
    /** True on the campus (keeps trees, rocks, poles and spawns off it). */
    blocks: (x, z, pad = 0) => Math.hypot(x - def.x, z - def.z) < def.r + pad,
    inside,
    /** Where a monster stands: on the floor inside the hall, else on the ground. */
    surfaceAt: (x, z, ground) => (inside(x, z) ? Math.max(ground, baseY) : ground),
    /**
     * Monster pathing when one end is in the hall: -1 not its business, 0 straight
     * there, 1 follow `out`, 2 banging on something (from outside()). Big bodies wait
     * outside. outside(ax, az, bx, bz, o): the pathing round things out of doors.
     */
    navigate(zx, zz, tx, tz, out, big, outside) {
      const mi = inside(zx, zz), ti = inside(tx, tz);
      if (!mi && !ti) return -1;
      if (mi && ti) return 0;
      // The door that makes the shortest way
      let door = doors[0], best = Infinity;
      for (const d of doors) {
        const way = Math.hypot(zx - d.ox, zz - d.oz) + Math.hypot(tx - d.ox, tz - d.oz);
        if (way < best) { best = way; door = d; }
      }
      if (mi) {
        const through = onStrip(door, zx, zz);
        out.x = through ? door.ox : door.ix;
        out.z = through ? door.oz : door.iz;
        return 1;
      }
      if (big) { out.x = door.ox; out.z = door.oz; return 1; }
      if (onStrip(door, zx, zz) || Math.hypot(zx - door.ox, zz - door.oz) < 0.9) { out.x = door.ix; out.z = door.iz; return 1; }
      const r = outside(zx, zz, door.ox, door.oz, out);
      if (r === 0) { out.x = door.ox; out.z = door.oz; }
      return r === 2 ? 2 : 1;
    },
    /** Each frame with the camera position: the detail and the interior are only drawn up close. */
    update(x, z) {
      const l = toLocal(x, z);
      const d = Math.hypot(Math.max(HALL.x0 - l.x, 0, l.x - HALL.x1), Math.max(HALL.z0 - l.z, 0, l.z - HALL.z1));
      detail.visible = d < DETAIL_RANGE;
      interior.visible = d < INTERIOR_RANGE;
    },
  };
}
