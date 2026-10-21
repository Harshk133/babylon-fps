import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GROUP_WORLD, GROUP_GLASS, GROUP_ZOMBIE } from "../physicsGroups.js";
import { QUALITY } from "../quality.js";

// Enterable houses assembled from Kenney's CC0 Building Kit + Furniture Kit
// (public/models/house/house-kit.glb, built by `npm run build-house-kit`), in
// three kinds (TYPES): the two-storey house, a one-storey bungalow and a small
// cabin. Every house has an animated door with a kinematic collider, a light
// switch and ceiling lamps per floor, and a compound physics body with a box
// per wall section, so walls, windows, floors, stairs and furniture block the
// player and zombies like real ones. Houses stand at their own base height
// (towns sit on hills) and take a wall tint.
//
// Rendering is instanced: per house kind, one InstancedMesh per material for
// the shell (walls, floors, roof, glass) and one for the interior (furniture,
// lamps), plus one each for every door part, the light bulbs and the switch
// rockers, shared by all houses. Each frame cull() packs in only the houses in
// view (and those close by, for shadows); interiors only within
// INTERIOR_RANGE. Forty houses cost about as many draw calls as one.
//
// Compounds (addCompound) are walled yards round a group of houses with a gate
// toward the road: instanced wall pieces, one static body each, and gate-aware
// monster pathing.
//
// House-local frame (kit units, before HOUSE_SCALE): door on the +Z wall.
// _toLocal / _toWorld convert to and from world metres.

// Kit rooms are 2.4 m high with 2.1 m doors: too low for 2.4 m zombies and the
// over-the-shoulder camera. ×1.2 gives 2.9 m ceilings and 1.08 × 2.5 m doors.
const HOUSE_SCALE = 1.2;
const SEG        = 2;                   // kit wall segment length
const WALL_H     = 2.4;
const SINK       = 0.08;                // floor tiles sit flush with the ground
const COLLIDER_T = 0.4;                 // fat enough that nothing tunnels through a 0.1 m wall
const FURN_SCALE = WALL_H / 1.29;       // Furniture Kit walls are 1.29 tall
const DOOR_HALF  = 0.45;
const DOOR_H     = 2.1;
const WIN_Y0     = 0.7;                 // window hole
const WIN_Y1     = 1.9;
const UP_Y       = WALL_H + 0.1;        // upper floor surface (floor tiles sit on the ground-floor walls)
const UP_LEVEL   = 1.6;                 // local feet height above which you count as upstairs
const DOOR_RANGE   = 2.3;
const SWITCH_RANGE = 1.7;
const HOUSE_LIGHTS = QUALITY.houseLights; // shared point lights, given to the nearest lit houses
const IN_MARGIN  = 0.05;
const SHELL_RANGE = 235;                // m: past the camera's far plane anyway
const NEAR_ALWAYS = 55;                 // m: drawn even behind you (their shadows reach into view)
const INTERIOR_RANGE = 50;              // m: furniture, lamps and switches only up close
const R90 = Math.PI / 2;

// Compound walls (world metres)
const YARD_WALL_H = 1.8;
const YARD_WALL_T = 0.24;
const YARD_GATE = 4.2;                  // gate gap width
const YARD_PIER = 3.6;                  // a pier every this many metres
const CLIMB_REACH = 0.95;               // m from a yard wall's centreline that counts as "at the wall"
const VAULT_REACH = 1.1;                // kit units from a window pane

// ── House kinds ───────────────────────────────────────────────────────────────
// Walls: [piece, x, z, rotY]. Walls spanning X are rotated 90°; the doorway is
// turned −90° so the kit's door swings in. Furniture: [piece, x, z, rotY, { y,
// floor, collide }], "front" facing +Z at rotY 0. Lamps / loot: [x, z, floor].

// Two storeys: living room + kitchen downstairs, stairs along the back wall
// rising toward −X; upstairs windows on nearly every side to camp and shoot out.
const HOUSE = {
  halfW: 4, halfD: 3, floors: 2, doorX: 1,
  walls: [
    ["wall-window-square", -3, 3, R90], ["wall", -1, 3, R90],
    ["wall-doorway-square", 1, 3, -R90], ["wall-window-square", 3, 3, R90],
    ["wall", -3, -3, R90], ["wall", -1, -3, R90],
    ["wall", 1, -3, R90], ["wall-window-square", 3, -3, R90],
    ["wall", -4, -2, 0], ["wall-window-square", -4, 0, 0], ["wall", -4, 2, 0],
    ["wall-window-square", 4, -2, 0], ["wall", 4, 0, 0], ["wall", 4, 2, 0],
  ],
  wallsUp: [
    ["wall-window-square-detailed", -3, 3, R90], ["wall-window-square-detailed", -1, 3, R90],
    ["wall-window-square-detailed", 1, 3, R90], ["wall-window-square-detailed", 3, 3, R90],
    ["wall-window-square-detailed", -3, -3, R90], ["wall", -1, -3, R90],
    ["wall", 1, -3, R90], ["wall-window-square-detailed", 3, -3, R90],
    ["wall", -4, -2, 0], ["wall-window-square-detailed", -4, 0, 0], ["wall-window-square-detailed", -4, 2, 0],
    ["wall-window-square-detailed", 4, -2, 0], ["wall-window-square-detailed", 4, 0, 0], ["wall", 4, 2, 0],
  ],
  // Stairs centre line against the back wall, bottom step at x0, top at x1; the
  // stairwell opening upstairs, and the waist-high railing round it
  stairs: { z: -3 + 0.7, x0: 2, x1: -2, hw: 0.65 },
  hole: { x0: -2, x1: 2, z0: -3, z1: -1 },
  railing: [[-1, -1, R90], [1, -1, R90], [2, -2, 0]],
  furniture: [
    ["loungeSofa", -3.5, 1.3, R90],
    ["rugRectangle", -2.3, 1.3, R90, { collide: false }],
    ["tableCoffee", -2.35, 1.3, R90],
    ["cabinetTelevision", -0.9, 1.3, -R90],
    ["televisionModern", -0.9, 1.3, -R90, { y: 0.58, collide: false }],
    ["lampRoundFloor", -3.45, 2.6, 0, { collide: false }],
    ["pottedPlant", -0.3, 2.55, 0],
    ["table", 1.2, 0.3, 0],
    ["chair", 0.8, 1.05, Math.PI], ["chair", 1.6, 1.05, Math.PI],
    ["chair", 0.8, -0.45, 0], ["chair", 1.6, -0.45, 0],
    ["kitchenCabinet", 3.55, -0.6, -R90],
    ["kitchenStove", 3.55, 0.22, -R90],
    ["kitchenFridge", 3.5, 1.15, -R90],
    ["cardboardBoxClosed", 3.45, 2.55, 0], ["cardboardBoxClosed", 3.0, 2.6, -0.2],
    ["bedSingle", -3.3, 1.85, Math.PI, { floor: 1 }],
    ["sideTable", -2.1, 2.62, Math.PI, { floor: 1 }],
    ["rugRectangle", 0.6, 1.3, 0, { floor: 1, collide: false }],
    ["loungeSofa", 0.6, 2.5, Math.PI, { floor: 1 }],
    ["tableCoffee", 0.6, 1.35, 0, { floor: 1 }],
    ["bookcaseOpen", 3.62, 1.6, -R90, { floor: 1 }],
    ["pottedPlant", 2.5, 2.6, 0, { floor: 1 }],
    ["lampRoundFloor", -3.5, -0.4, 0, { floor: 1, collide: false }],
    ["cardboardBoxClosed", 3.45, -2.55, 0, { floor: 1 }], ["cardboardBoxClosed", 3.45, -2.05, 0.3, { floor: 1 }],
  ],
  lamps: [[-0.5, 0.3, 0], [-2.6, 1.3, 0], [2.3, 0.3, 0], [-2.4, 1.2, 1], [1.2, 0.9, 1], [2.9, -1.9, 1]],
  loot: [[-1.5, -0.4, 0], [2.4, 2.3, 0], [-2.8, -0.5, 0], [-1.6, 0.3, 1], [2.7, -1.2, 1], [-2.0, 2.0, 1]],
  // Per floor: light switch (position + facing) and the shared point light's spot
  switches: [
    { pos: new THREE.Vector3(0.27, 1.3, 3 - 0.11), rotY: Math.PI },
    { pos: new THREE.Vector3(-4 + 0.11, UP_Y + 1.3, -1.45), rotY: R90 },
  ],
  lightPos: [new THREE.Vector3(-0.5, 2.0, 0.3), new THREE.Vector3(0.2, UP_Y + 1.9, 0.9)],
};

// One storey, door on the left of the front, bedroom on the left, kitchen-diner on the right
const BUNGALOW = {
  halfW: 4, halfD: 3, floors: 1, doorX: -1,
  walls: [
    ["wall-window-square", -3, 3, R90], ["wall-doorway-square", -1, 3, -R90],
    ["wall-window-square-detailed", 1, 3, R90], ["wall-window-square", 3, 3, R90],
    ["wall", -3, -3, R90], ["wall-window-square", -1, -3, R90],
    ["wall-window-square", 1, -3, R90], ["wall", 3, -3, R90],
    ["wall-window-square", -4, -2, 0], ["wall", -4, 0, 0], ["wall-window-square", -4, 2, 0],
    ["wall", 4, -2, 0], ["wall-window-square", 4, 0, 0], ["wall", 4, 2, 0],
  ],
  furniture: [
    ["bedSingle", -3.0, -1.9, 0],
    ["sideTable", -1.9, -2.6, 0],
    ["bookcaseOpen", -3.62, 0.2, R90],
    ["rugRectangle", -2.5, 0.4, R90, { collide: false }],
    ["lampRoundFloor", -3.45, 2.55, 0, { collide: false }],
    ["loungeSofa", 1.6, -2.45, 0],
    ["tableCoffee", 1.6, -1.35, 0],
    ["cabinetTelevision", 1.6, -0.15, Math.PI],
    ["televisionModern", 1.6, -0.15, Math.PI, { y: 0.58, collide: false }],
    ["kitchenCabinet", 3.55, 0.9, -R90],
    ["kitchenStove", 3.55, 1.72, -R90],
    ["kitchenFridge", 3.5, 2.5, -R90],
    ["table", 1.4, 1.8, 0],
    ["chair", 1.0, 2.5, Math.PI], ["chair", 1.8, 2.5, Math.PI],
    ["pottedPlant", 0.3, 2.6, 0],
    ["cardboardBoxClosed", 3.45, -2.5, 0.2],
  ],
  lamps: [[-2.4, -0.6, 0], [1.6, -1.2, 0], [1.8, 1.6, 0]],
  loot: [[-2.4, 0.9, 0], [2.6, -1.0, 0], [0.2, 0.6, 0], [3.0, -2.3, 0]],
  switches: [{ pos: new THREE.Vector3(-1.73, 1.3, 3 - 0.11), rotY: Math.PI }],
  lightPos: [new THREE.Vector3(0, 2.0, 0)],
};

// One room, 4 × 4: a bed, a table, a stove in the corner
const CABIN = {
  halfW: 2, halfD: 2, floors: 1, doorX: 1,
  walls: [
    ["wall-window-square", -1, 2, R90], ["wall-doorway-square", 1, 2, -R90],
    ["wall", -1, -2, R90], ["wall-window-square", 1, -2, R90],
    ["wall-window-square", -2, -1, 0], ["wall", -2, 1, 0],
    ["wall", 2, -1, 0], ["wall-window-square", 2, 1, 0],
  ],
  furniture: [
    ["bedSingle", -1.25, -0.95, 0],
    ["sideTable", -0.15, -1.6, 0],
    ["table", 1.0, -0.6, 0],
    ["chair", 1.0, 0.1, Math.PI],
    ["kitchenStove", 1.55, -1.55, -R90],
    ["cardboardBoxClosed", -1.55, 1.55, 0.3],
    ["lampRoundFloor", -1.6, 0.6, 0, { collide: false }],
  ],
  lamps: [[0, 0.2, 0]],
  loot: [[-0.6, 0.8, 0], [0.9, -0.1, 0]],
  switches: [{ pos: new THREE.Vector3(0.27, 1.3, 2 - 0.11), rotY: Math.PI }],
  lightPos: [new THREE.Vector3(0, 2.0, 0)],
};

export const HOUSE_TYPES = { house: HOUSE, bungalow: BUNGALOW, cabin: CABIN };
/** World footprint half-sizes of a kind (metres): along the front, and front-to-back. */
export function houseHalfSize(kind) {
  const t = HOUSE_TYPES[kind];
  return { hw: t.halfW * HOUSE_SCALE, hd: t.halfD * HOUSE_SCALE };
}
// Kept for callers that iterate the original house's loot spots
export const HOUSE_LOOT_SPOTS = HOUSE.loot;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _a = { x: 0, z: 0 };
const _b = { x: 0, z: 0 };
const _zl = { x: 0, z: 0 };
const _pl = { x: 0, z: 0 };
const _box = { x: 0, z: 0, rot: 0, hw: 0, hd: 0 };
const _det = { x: 0, z: 0 };
// navigate()'s scratch: the straight line's ends and bounds, and the nearest detour so far
const _nav = { zx: 0, zz: 0, px: 0, pz: 0, x0: 0, x1: 0, z0: 0, z1: 0, best: Infinity, bx: 0, bz: 0 };
function navNear(x, z, r) {
  return x + r > _nav.x0 && x - r < _nav.x1 && z + r > _nav.z0 && z - r < _nav.z1;
}
function navConsider(o) {
  if (!routeAround(o, _nav.zx, _nav.zz, _nav.px, _nav.pz, _det)) return;
  const d = Math.hypot(o.x - _nav.zx, o.z - _nav.zz);
  if (d < _nav.best) { _nav.best = d; _nav.bx = _det.x; _nav.bz = _det.z; }
}
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _onColor = new THREE.Color(2.6, 2.1, 1.35);   // lit bulbs (over 1: they bloom)
const _offColor = new THREE.Color(0.16, 0.15, 0.13);

function segHitsRect(ax, az, bx, bz, ex, ez) {
  // Slab test of segment a→b against the axis-aligned box [−ex, ex] × [−ez, ez]
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  for (const [p, d, e] of [[ax, dx, ex], [az, dz, ez]]) {
    if (Math.abs(d) < 1e-9) {
      if (p < -e || p > e) return false;
    } else {
      let u0 = (-e - p) / d, u1 = (e - p) / d;
      if (u0 > u1) [u0, u1] = [u1, u0];
      t0 = Math.max(t0, u0);
      t1 = Math.min(t1, u1);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/**
 * Rect obstacle helper for navigation. `o` has x, z, rot, hw, hd (getters ok).
 * Returns true and writes a corner waypoint into `out` when the straight line
 * from (zx, zz) to (tx, tz) runs through the obstacle.
 */
function routeAround(o, zx, zz, tx, tz, out) {
  const c = Math.cos(o.rot), s = Math.sin(o.rot);
  const toL = (x, z, r) => { const dx = x - o.x, dz = z - o.z; r.x = dx * c - dz * s; r.z = dx * s + dz * c; return r; };
  const zl = toL(zx, zz, _a), tl = toL(tx, tz, _b);
  const ex = o.hw + 0.6, ez = o.hd + 0.6;
  if (!segHitsRect(zl.x, zl.z, tl.x, tl.z, ex, ez)) return false;

  const cx = o.hw + 1.4, cz = o.hd + 1.4;
  let best = Infinity, bx = 0, bz = 0;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const px = sx * cx, pz = sz * cz;
    const dz0 = Math.hypot(px - zl.x, pz - zl.z);
    if (dz0 < 0.8) continue; // already here: aim for the next corner instead
    if (segHitsRect(zl.x, zl.z, px, pz, o.hw + 0.3, o.hd + 0.3)) continue;
    let cost = dz0;
    if (!segHitsRect(px, pz, tl.x, tl.z, o.hw + 0.3, o.hd + 0.3)) cost += Math.hypot(tl.x - px, tl.z - pz);
    else cost += 2 * (cx + cz) + Math.hypot(tl.x - px, tl.z - pz); // needs another corner after this one
    if (cost < best) { best = cost; bx = px; bz = pz; }
  }
  if (best === Infinity) return false;
  out.x = o.x + bx * c + bz * s;
  out.z = o.z - bx * s + bz * c;
  return true;
}

/** Plain Float32, indexed copy of a mesh's geometry in `matrix` (kit pieces are quantized). */
function bakeGeometry(o, matrix, color = null) {
  const g = new THREE.BufferGeometry();
  for (const key of ["position", "normal", "uv"]) {
    const a = o.geometry.attributes[key];
    if (!a) continue;
    const arr = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) arr[i * a.itemSize + k] = a.getComponent(i, k);
    g.setAttribute(key, new THREE.BufferAttribute(arr, a.itemSize));
  }
  if (o.geometry.index) g.setIndex(Array.from(o.geometry.index.array));
  g.applyMatrix4(matrix);
  if (color) {
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b; }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
  return g;
}

export class Houses {
  /**
   * gltf: the loaded house-kit.glb. obstacles: extra solid rects for zombie
   * pathing ({ x, z, rot, hw, hd }, getters allowed).
   */
  constructor({ scene, world, gltf, sfx, material = null, obstacles = [] }) {
    this.scene = scene;
    this.world = world;
    // Frictionless static material (as for every other wall): bodies slide along walls instead of sticking
    this.material = material;
    this.sfx = sfx;
    this.obstacles = obstacles;
    this.houses = [];
    this.compounds = [];

    const kit = gltf.scene;
    kit.updateMatrixWorld(true);
    this.pieces = {};
    for (const child of kit.children) this.pieces[child.name] = child;
    this.clips = {
      open: gltf.animations.find(c => c.name === "open"),
      close: gltf.animations.find(c => c.name === "close"),
    };

    this.glassMat = new THREE.MeshStandardMaterial({
      color: 0x9fc4d8, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.22, depthWrite: false,
    });
    this.furnitureMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    this.switchPlateMat = new THREE.MeshStandardMaterial({ color: 0xece8e0, roughness: 0.5 });
    this.switchLeverMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.4 });
    this.switchLeverGeo = new THREE.BoxGeometry(0.024, 0.05, 0.03).translate(0, 0.02, 0.012);

    const lamp = this._furnitureTemplate("lampSquareCeiling");
    this.lampTemplate = lamp.wrap;
    this.lampHeight = lamp.size.y;

    this.types = {};
    for (const [name, t] of Object.entries(HOUSE_TYPES)) this.types[name] = this._buildLayout(name, t);

    this.lights = [];
    for (let i = 0; i < HOUSE_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffd29a, 0, 11, 1.4);
      l.position.set(0, -500, 0);
      scene.add(l);
      this.lights.push(l);
    }
    this._finalized = false;
  }

  // ── Layouts (built once per kind, shared by every house of it) ──────────────

  _furnitureTemplate(name) {
    const src = this.pieces[`f_${name}`];
    const inner = src.clone(true);
    inner.position.set(0, 0, 0);
    inner.rotation.set(0, 0, 0);
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    inner.position.set(-center.x, -box.min.y, -center.z);
    const wrap = new THREE.Group();
    wrap.add(inner);
    wrap.scale.setScalar(FURN_SCALE);
    return { wrap, size: size.multiplyScalar(FURN_SCALE) };
  }

  /**
   * Builds a kind's meshes (split into shell and interior, each merged to one
   * geometry per material) and collider lists.
   */
  _buildLayout(name, t) {
    const shell = new THREE.Group(), interior = new THREE.Group();
    const boxes = [];   // solid colliders: { x, y, z, hx, hy, hz, rot, rz? }
    const glass = [];   // window panes: block bodies, not bullets or grenades
    const { halfW: HW, halfD: HD, floors: F } = t;

    // A box in a wall piece's frame (span along local Z, thickness along X)
    const wallBox = (px, pz, rot, z0, z1, y0, y1, list = boxes) => {
      const cz = (z0 + z1) / 2;
      list.push({
        x: px + cz * Math.sin(rot), y: (y0 + y1) / 2 - SINK, z: pz + cz * Math.cos(rot),
        hx: COLLIDER_T / 2, hy: (y1 - y0) / 2, hz: (z1 - z0) / 2, rot,
      });
    };
    const piece = (pname, x, y, z, rot = 0, into = shell) => {
      const o = this.pieces[`b_${pname}`].clone(true);
      o.position.set(x, y, z);
      o.rotation.y = rot;
      into.add(o);
      return o;
    };

    // Walls of every storey; window holes get a glass collider instead of a solid one
    const H = WALL_H + 0.1;
    const storeys = [[t.walls, 0]];
    if (F > 1) storeys.push([t.wallsUp, WALL_H]);
    for (const [list, y] of storeys) {
      for (const [pname, x, z, rot] of list) {
        piece(pname, x, y, z, rot);
        if (pname === "wall") {
          wallBox(x, z, rot, -1, 1, y, y + H);
        } else if (pname === "wall-doorway-square") {
          wallBox(x, z, rot, -1, -DOOR_HALF, y, y + H);
          wallBox(x, z, rot, DOOR_HALF, 1, y, y + H);
          wallBox(x, z, rot, -DOOR_HALF, DOOR_HALF, y + DOOR_H, y + H);
        } else {
          wallBox(x, z, rot, -1, -DOOR_HALF, y, y + H);
          wallBox(x, z, rot, DOOR_HALF, 1, y, y + H);
          wallBox(x, z, rot, -DOOR_HALF, DOOR_HALF, y, y + WIN_Y0);
          wallBox(x, z, rot, -DOOR_HALF, DOOR_HALF, y + WIN_Y1, y + H);
          wallBox(x, z, rot, -DOOR_HALF, DOOR_HALF, y + WIN_Y0, y + WIN_Y1, glass);
        }
      }
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      for (let f = 0; f < F; f++) piece("column", sx * HW, f * WALL_H, sz * HD);
    }
    // Trim band between the storeys, all the way round (faces outward)
    if (F > 1) {
      for (let x = -HW + 1; x < HW; x += SEG) {
        piece("border", x, WALL_H - 0.12, HD, -R90);
        piece("border", x, WALL_H - 0.12, -HD, R90);
      }
      for (let z = -HD + 1; z < HD; z += SEG) {
        piece("border", -HW, WALL_H - 0.12, z, Math.PI);
        piece("border", HW, WALL_H - 0.12, z, 0);
      }
    }

    // Floors (an upper one leaves the stairwell open) and the roof on top
    const nx = (HW * 2) / SEG, nz = (HD * 2) / SEG;
    const hole = t.hole;
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        const x = -HW + SEG / 2 + i * SEG, z = -HD + SEG / 2 + k * SEG;
        piece("floor", x, 0, z);
        if (F > 1) {
          const inHole = hole && x > hole.x0 && x < hole.x1 && z > hole.z0 && z < hole.z1;
          if (!inHole) piece("floor", x, WALL_H, z);
        }
        // Roof: lipped pieces round the edge, flat ones inside
        const edgeX = i === 0 ? -1 : i === nx - 1 ? 1 : 0;
        const edgeZ = k === 0 ? -1 : k === nz - 1 ? 1 : 0;
        let rname = "roof-flat-center", rot = 0;
        if (edgeX && edgeZ) {
          rname = "roof-flat-corner";
          rot = edgeX > 0 ? (edgeZ > 0 ? 0 : R90) : (edgeZ > 0 ? -R90 : Math.PI);
        } else if (edgeX || edgeZ) {
          rname = "roof-flat-side";
          rot = edgeX > 0 ? 0 : edgeX < 0 ? Math.PI : edgeZ > 0 ? -R90 : R90;
        }
        piece(rname, x, F * WALL_H, z, rot);
      }
    }
    // Roof slab
    boxes.push({ x: 0, y: F * WALL_H + 0.08 - SINK, z: 0, hx: HW + 0.25, hy: 0.12, hz: HD + 0.25, rot: 0 });

    if (t.stairs) {
      const st = t.stairs;
      // Upper floor slab in three boxes round the stairwell, top flush with the tiles
      const slab = (x0, x1, z0, z1) => boxes.push({ x: (x0 + x1) / 2, y: WALL_H - SINK, z: (z0 + z1) / 2, hx: (x1 - x0) / 2, hy: 0.1, hz: (z1 - z0) / 2, rot: 0 });
      slab(-HW, hole.x0, -HD, HD);
      slab(hole.x0, hole.x1, hole.z1, HD);
      slab(hole.x1, HW, -HD, HD);
      // Stairs: the kit piece rises toward its +Z, turned to climb toward −X.
      // Collider: one tilted box whose top face is the slope (the player's
      // controller walks it like a ramp), plus a block under the high half.
      // Monsters pass through the ramp (their height follows the steps through
      // surfaceAt()) but not the block, so they can't wander in under the stairs.
      piece("stairs-closed", (st.x0 + st.x1) / 2, 0, st.z, -R90);
      const run = st.x0 - st.x1, slope = Math.atan2(UP_Y, run), len = Math.hypot(run, UP_Y);
      boxes.push({
        x: (st.x0 + st.x1) / 2 - Math.sin(slope) * 0.1, y: UP_Y / 2 - Math.cos(slope) * 0.1 - SINK, z: st.z,
        hx: len / 2, hy: 0.1, hz: st.hw, rot: 0, rz: -slope, stairs: true,
      });
      boxes.push({ x: st.x1 / 2, y: UP_Y / 4 - SINK, z: st.z, hx: -st.x1 / 2, hy: UP_Y / 4, hz: st.hw, rot: 0 });
      for (const [x, z, rot] of t.railing) {
        piece("wall-low", x, UP_Y, z, rot);
        wallBox(x, z, rot, -1, 1, UP_Y, UP_Y + 1.2);
      }
      // The opening beside the top step, between the stairs and the railing (a banister's spot)
      wallBox(hole.x0, (st.z + st.hw + hole.z1) / 2, 0, -(hole.z1 - st.z - st.hw) / 2, (hole.z1 - st.z - st.hw) / 2, UP_Y, UP_Y + 1.2);
    }

    for (const [fname, x, z, rot, opts = {}] of t.furniture) {
      const { wrap, size } = this._furnitureTemplate(fname);
      const y = (opts.y ?? 0) + (opts.floor ? UP_Y : 0);
      wrap.position.set(x, y, z);
      wrap.rotation.y = rot;
      interior.add(wrap);
      if (opts.collide !== false) {
        boxes.push({ x, y: y + size.y / 2 - SINK, z, hx: size.x / 2, hy: size.y / 2, hz: size.z / 2, rot });
      }
    }
    // Ceiling lamps (the bulbs glow separately, per floor) and the switch plates
    const bulbs = [];
    for (const [lx, lz, lf] of t.lamps) {
      const lampObj = this.lampTemplate.clone(true);
      const y = (lf + 1) * WALL_H - this.lampHeight;
      lampObj.position.set(lx, y, lz);
      interior.add(lampObj);
      bulbs.push({ x: lx, y: y - 0.01, z: lz, floor: lf });
    }
    const plateGeo = new THREE.BoxGeometry(0.09, 0.13, 0.014);
    for (const s of t.switches) {
      const plate = new THREE.Mesh(plateGeo, this.switchPlateMat);
      plate.position.copy(s.pos);
      plate.rotation.y = s.rotY;
      interior.add(plate);
    }

    return {
      name, t,
      shell: this._mergeParts(shell, true),
      interior: this._mergeParts(interior, false),
      bulbs,
      colliderBoxes: boxes,
      glassBoxes: glass,
    };
  }

  /**
   * One geometry per material for everything under `group`. The Furniture
   * Kit's flat-coloured materials (rough, untextured, opaque) differ only in
   * colour: that goes into the vertices so they share one material.
   */
  _mergeParts(group, isShell) {
    const flat = m => m.isMeshStandardMaterial && !m.map && !m.transparent && m.roughness === 1 && m.metalness === 0
      && (!m.emissive || m.emissive.getHex() === 0);
    group.updateMatrixWorld(true);
    const groups = new Map();
    group.traverse(o => {
      if (!o.isMesh) return;
      const isGlass = /ignore/i.test(o.name) || /ignore/i.test(o.parent?.name ?? "");
      const baked = !isGlass && flat(o.material);
      // The lamps' bulb material is unlit here: the glow is the instanced bulbs
      const mat = isGlass ? this.glassMat : baked ? this.furnitureMat : o.material;
      const g = bakeGeometry(o, o.matrixWorld, baked ? o.material.color : null);
      if (!groups.has(mat)) groups.set(mat, []);
      groups.get(mat).push(g);
    });
    const parts = [];
    for (const [material, geos] of groups) {
      const geometry = mergeGeometries(geos, false);
      geometry.computeBoundingSphere();
      // Walls take the house's tint (the textured "colormap" material)
      parts.push({ geometry, material, tinted: isShell && !!material.map, glass: material === this.glassMat });
    }
    return parts;
  }

  // ── Houses ──────────────────────────────────────────────────────────────────

  /**
   * Places a house. rotY: radians; the door faces local +Z.
   * opts: { type: "house" | "bungalow" | "cabin", base: ground height under it, tint: THREE.Color }
   */
  add(x, z, rotY, { type = "house", base = 0, tint = null } = {}) {
    const S = HOUSE_SCALE;
    const T = this.types[type];
    const t = T.t;
    const y0 = base - SINK * S;
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(S, S, S));

    // Door: the kit's door piece with its own mixer for the open/close clips.
    // Never in the scene: the instanced door parts copy its animated matrices.
    const doorRoot = new THREE.Group();
    doorRoot.matrixAutoUpdate = false;
    doorRoot.matrix.copy(matrix);
    const door = this.pieces["b_door-rotate-square-a"].clone(true);
    door.position.set(t.doorX + DOOR_HALF, 0, t.halfD);
    door.rotation.y = -R90;
    doorRoot.add(door);
    doorRoot.updateMatrixWorld(true);
    const doorMeshes = [];
    door.traverse(o => { if (o.isMesh) doorMeshes.push(o); });
    const panel = door.getObjectByName("door");
    const mixer = new THREE.AnimationMixer(door);
    const openAction = mixer.clipAction(this.clips.open);
    const closeAction = mixer.clipAction(this.clips.close);
    for (const a of [openAction, closeAction]) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }

    const floors = t.switches.map((s, f) => ({
      house: null, index: f, lightOn: false, switchWorld: new THREE.Vector3(),
      leverMatrix: new THREE.Matrix4(),
    }));

    // Physics: walls, floors, stairs, roof and furniture in one compound static body
    const q = new CANNON.Quaternion().setFromEuler(0, rotY, 0);
    const body = new CANNON.Body({ mass: 0, material: this.material, collisionFilterGroup: GROUP_WORLD });
    const glassBody = new CANNON.Body({ mass: 0, material: this.material, collisionFilterGroup: GROUP_GLASS });
    // Stairs: solid for players and grenades, not for monsters (pinned to surfaceAt, a ramp would stop them)
    const stairBody = new CANNON.Body({
      mass: 0, material: this.material, collisionFilterGroup: GROUP_WORLD, collisionFilterMask: ~GROUP_ZOMBIE,
    });
    const solid = T.colliderBoxes.filter(c => !c.stairs), stairs = T.colliderBoxes.filter(c => c.stairs);
    for (const [list, b] of [[solid, body], [stairs, stairBody], [T.glassBoxes, glassBody]]) {
      if (!list.length) continue;
      for (const c of list) {
        b.addShape(
          new CANNON.Box(new CANNON.Vec3(c.hx * S, c.hy * S, c.hz * S)),
          new CANNON.Vec3(c.x * S, c.y * S, c.z * S),
          new CANNON.Quaternion().setFromEuler(0, c.rot, c.rz ?? 0));
      }
      b.position.set(x, base, z);
      b.quaternion.copy(q);
      this.world.addBody(b);
    }
    // Door leaf: kinematic box that follows the animated panel
    const doorBody = new CANNON.Body({
      mass: 0, type: CANNON.Body.KINEMATIC, material: this.material, collisionFilterGroup: GROUP_WORLD,
    });
    // Leaf-thin like the model: a fatter box would poke into the doorway when the door is open
    doorBody.addShape(
      new CANNON.Box(new CANNON.Vec3(0.035 * S, (DOOR_H / 2) * S, DOOR_HALF * S)),
      new CANNON.Vec3(0, (DOOR_H / 2) * S, DOOR_HALF * S));
    this.world.addBody(doorBody);

    const h = {
      x, z, y0, base, rot: rotY, cos: Math.cos(rotY), sin: Math.sin(rotY),
      type, T, t, hw: t.halfW, hd: t.halfD, matrix, tint: tint ?? new THREE.Color(1, 1, 1),
      radius: Math.hypot(t.halfW, t.halfD) * S + 0.5, cy: y0 + t.floors * WALL_H * S * 0.5,
      doorRoot, door, doorMeshes, panel, mixer, openAction, closeAction, doorBody,
      doorOpen: false, doorAnim: 0,
      floors,
      doorWorld: new THREE.Vector3(),
    };
    this._toWorld(h, t.doorX, t.halfD, h.doorWorld);
    floors.forEach((f, i) => {
      f.house = h;
      const s = t.switches[i];
      this._toWorld(h, s.pos.x, s.pos.z, f.switchWorld);
      f.switchWorld.y = y0 + s.pos.y * S;
      this._leverMatrix(h, f);
    });
    this._syncDoorBody(h);
    this.houses.push(h);
    return h;
  }

  _leverMatrix(h, f) {
    const s = h.t.switches[f.index];
    _m.makeRotationY(s.rotY).setPosition(s.pos);
    _m2.makeRotationX(f.lightOn ? -0.35 : 0.35);
    f.leverMatrix.multiplyMatrices(h.matrix, _m).multiply(_m2);
  }

  /** Interior loot spots ([x, z, floor], house-local) of a house's kind. */
  lootSpots(h) { return h.t.loot; }

  /** World position of a loot spot ([x, z, floor], house-local) in this house. */
  lootSpot(h, [lx, lz, floor], out) {
    this._toWorld(h, lx, lz, out);
    out.y = h.y0 + (floor ? UP_Y : 0.1) * HOUSE_SCALE;
    return out;
  }

  /** House-local kit units → world metres. */
  _toWorld(h, lx, lz, out) {
    out.x = h.x + (lx * h.cos + lz * h.sin) * HOUSE_SCALE;
    out.z = h.z + (-lx * h.sin + lz * h.cos) * HOUSE_SCALE;
    return out;
  }

  /** World metres → house-local kit units. */
  _toLocal(h, x, z, out) {
    const dx = (x - h.x) / HOUSE_SCALE, dz = (z - h.z) / HOUSE_SCALE;
    out.x = dx * h.cos - dz * h.sin;
    out.z = dx * h.sin + dz * h.cos;
    return out;
  }

  _syncDoorBody(h) {
    h.doorRoot.updateMatrixWorld(true);
    h.panel.getWorldPosition(_v);
    h.panel.getWorldQuaternion(_q);
    h.doorBody.position.set(_v.x, _v.y, _v.z);
    h.doorBody.quaternion.set(_q.x, _q.y, _q.z, _q.w);
    h.doorBody.velocity.set(0, 0, 0);
    h.doorBody.aabbNeedsUpdate = true;
  }

  // ── Compounds ───────────────────────────────────────────────────────────────

  /**
   * A walled yard: a rectangle centred on (x, z), turned rotY (its local +Z is
   * the front, toward the road), hw × hd half-size in metres, with a gate in
   * the front wall centred at local x = gateX. base: ground height.
   */
  addCompound(x, z, rotY, hw, hd, gateX, base = 0, tint = null) {
    const c = {
      x, z, rot: rotY, cos: Math.cos(rotY), sin: Math.sin(rotY), hw, hd, base, gateX,
      tint: tint ?? new THREE.Color(0.85, 0.82, 0.76), pieces: [],
      gateOut: { x: 0, z: 0 }, gateIn: { x: 0, z: 0 }, gate: { x: 0, z: 0 },
    };
    const g0 = gateX - YARD_GATE / 2, g1 = gateX + YARD_GATE / 2;
    // Straight runs in yard-local metres: [x0, z0, x1, z1]
    const runs = [
      [-hw, hd, g0, hd], [g1, hd, hw, hd],   // front, split by the gate
      [-hw, -hd, hw, -hd],                    // back
      [-hw, -hd, -hw, hd], [hw, -hd, hw, hd], // sides
    ];
    const body = new CANNON.Body({ mass: 0, material: this.material, collisionFilterGroup: GROUP_WORLD });
    for (const [x0, z0, x1, z1] of runs) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.3) continue;
      const along = Math.abs(x1 - x0) > Math.abs(z1 - z0);
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      body.addShape(
        new CANNON.Box(new CANNON.Vec3(along ? len / 2 : YARD_WALL_T / 2, YARD_WALL_H / 2, along ? YARD_WALL_T / 2 : len / 2)),
        new CANNON.Vec3(mx, YARD_WALL_H / 2, mz));
      // Panels between piers, for the look (and the minimap)
      const n = Math.max(1, Math.round(len / YARD_PIER));
      for (let i = 0; i < n; i++) {
        const a = i / n, b = (i + 1) / n;
        c.pieces.push({ kind: "panel", x0: x0 + (x1 - x0) * a, z0: z0 + (z1 - z0) * a, x1: x0 + (x1 - x0) * b, z1: z0 + (z1 - z0) * b });
      }
      for (let i = 0; i <= n; i++) c.pieces.push({ kind: "pier", x: x0 + (x1 - x0) * (i / n), z: z0 + (z1 - z0) * (i / n) });
    }
    body.position.set(x, base, z);
    body.quaternion.setFromEuler(0, rotY, 0);
    this.world.addBody(body);
    this._yardWorld(c, gateX, hd, c.gate);
    this._yardWorld(c, gateX, hd + 1.6, c.gateOut);
    this._yardWorld(c, gateX, hd - 1.6, c.gateIn);
    this.compounds.push(c);
    return c;
  }

  // ── Climbing and vaulting ──────────────────────────────────────────────────

  /**
   * The yard wall someone at feet (x, z), facing (fx, fz) (unit), is standing
   * against: { x, z } on the wall, { nx, nz } the way over, topY. null if none
   * (gate gaps don't count). out is reused.
   */
  wallClimbSpot(x, z, fx, fz, out = this._climbOut ??= {}) {
    for (const c of this.compounds) {
      const l = this._yardLocal(c, x, z, _a);
      if (Math.abs(l.x) > c.hw + CLIMB_REACH || Math.abs(l.z) > c.hd + CLIMB_REACH) continue;
      const flx = fx * c.cos - fz * c.sin, flz = fx * c.sin + fz * c.cos;
      const g0 = c.gateX - YARD_GATE / 2 - 0.3, g1 = c.gateX + YARD_GATE / 2 + 0.3;
      // [walls along X at z = ±hd, walls along Z at x = ±hw]
      for (const [alongX, at] of [[true, c.hd], [true, -c.hd], [false, -c.hw], [false, c.hw]]) {
        const perp = (alongX ? l.z : l.x) - at, along = alongX ? l.x : l.z;
        const half = alongX ? c.hw : c.hd;
        if (Math.abs(perp) > CLIMB_REACH || Math.abs(along) > half - 0.3) continue;
        if (alongX && at > 0 && along > g0 && along < g1) continue; // the gate: just walk through
        const over = perp > 0 ? -1 : 1;                             // toward the wall and past it
        if ((alongX ? flz : flx) * over < 0.55) continue;
        const nlx = alongX ? 0 : over, nlz = alongX ? over : 0;
        this._yardWorld(c, alongX ? along : at, alongX ? at : along, out);
        out.nx = nlx * c.cos + nlz * c.sin;
        out.nz = -nlx * c.sin + nlz * c.cos;
        out.topY = c.base + YARD_WALL_H;
        return out;
      }
    }
    return null;
  }

  /**
   * The window someone at (x, feetY, z), facing (fx, fz), can vault through:
   * { x, z } the pane's centre, { nx, nz } the way through, sillY, topY. The
   * sill has to be between knee and chest height (upstairs windows work from
   * the inside: out you go). null if none.
   */
  windowVaultSpot(x, feetY, z, fx, fz, out = this._vaultOut ??= {}) {
    const S = HOUSE_SCALE;
    for (const h of this.houses) {
      if (Math.abs(x - h.x) > h.radius + 2 || Math.abs(z - h.z) > h.radius + 2) continue;
      const l = this._toLocal(h, x, z, _a);
      const flx = fx * h.cos - fz * h.sin, flz = fx * h.sin + fz * h.cos;
      for (const g of h.T.glassBoxes) {
        // Pane frame: span (sin rot, cos rot), normal (cos rot, −sin rot), kit units
        const sx = Math.sin(g.rot), sz = Math.cos(g.rot);
        const dx = l.x - g.x, dz = l.z - g.z;
        const along = dx * sx + dz * sz, perp = dx * sz - dz * sx;
        if (Math.abs(along) > g.hz + 0.1 || Math.abs(perp) > VAULT_REACH) continue;
        const over = perp > 0 ? -1 : 1;
        if ((flx * sz - flz * sx) * over < 0.5) continue;
        const sill = h.base + (g.y - g.hy) * S;
        if (sill - feetY < 0.25 || sill - feetY > 1.45) continue;
        this._toWorld(h, g.x, g.z, out);
        const nlx = sz * over, nlz = -sx * over;
        out.nx = nlx * h.cos + nlz * h.sin;
        out.nz = -nlx * h.sin + nlz * h.cos;
        out.sillY = sill;
        out.topY = h.base + (g.y + g.hy) * S;
        return out;
      }
    }
    return null;
  }

  _yardWorld(c, lx, lz, out) {
    out.x = c.x + lx * c.cos + lz * c.sin;
    out.z = c.z - lx * c.sin + lz * c.cos;
    return out;
  }

  _yardLocal(c, x, z, out) {
    const dx = x - c.x, dz = z - c.z;
    out.x = dx * c.cos - dz * c.sin;
    out.z = dx * c.sin + dz * c.cos;
    return out;
  }

  // ── Instanced rendering ─────────────────────────────────────────────────────

  /** Builds the shared instanced meshes. Call once, after every add() / addCompound(). */
  finalize() {
    if (this._finalized) return;
    this._finalized = true;
    const make = (geometry, material, count, { shadow = true, tinted = false } = {}) => {
      const im = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (tinted) im.setColorAt(0, _offColor);
      im.count = 0;
      im.frustumCulled = false;          // culled per house in cull()
      im.castShadow = shadow;
      im.receiveShadow = true;
      if (material.transparent) im.renderOrder = 1;
      this.scene.add(im);
      return im;
    };
    for (const T of Object.values(this.types)) {
      const list = this.houses.filter(h => h.T === T);
      T.list = list;
      T.shellMeshes = T.shell.map(p => make(p.geometry, p.material, list.length, { shadow: !p.glass, tinted: p.tinted }));
      T.shellMeshes.forEach((im, i) => { im.userData.tinted = T.shell[i].tinted; });
      T.interiorMeshes = T.interior.map(p => make(p.geometry, p.material, list.length, { shadow: false }));
    }
    // Door parts, bulbs and rockers are shared by every kind
    const n = this.houses.length;
    const tmpl = this.houses[0]?.doorMeshes ?? [];
    this.doorMeshes = tmpl.map(o => make(o.geometry, o.material, n));
    const bulbGeo = new THREE.BoxGeometry(0.34, 0.035, 0.34);
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const nb = this.houses.reduce((s, h) => s + h.T.bulbs.length, 0);
    this.bulbMesh = make(bulbGeo, bulbMat, nb, { shadow: false, tinted: true });
    const ns = this.houses.reduce((s, h) => s + h.floors.length, 0);
    this.leverMesh = make(this.switchLeverGeo, this.switchLeverMat, ns, { shadow: false });

    // Compound walls: one instanced panel and one instanced pier for every yard
    const panelGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const pierGeo = new THREE.BoxGeometry(0.42, YARD_WALL_H + 0.22, 0.42).translate(0, (YARD_WALL_H + 0.22) / 2, 0);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    const panels = [], piers = [];
    for (const c of this.compounds) for (const p of c.pieces) (p.kind === "panel" ? panels : piers).push([c, p]);
    if (panels.length) {
      const pm = make(panelGeo, wallMat, panels.length, { tinted: true });
      const qm = make(pierGeo, wallMat, piers.length, { tinted: true });
      const pos = new THREE.Vector3(), scl = new THREE.Vector3(), quat = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      const pierColor = new THREE.Color();
      panels.forEach(([c, p], i) => {
        const mx = (p.x0 + p.x1) / 2, mz = (p.z0 + p.z1) / 2;
        const len = Math.hypot(p.x1 - p.x0, p.z1 - p.z0);
        const along = Math.abs(p.x1 - p.x0) > Math.abs(p.z1 - p.z0);
        this._yardWorld(c, mx, mz, _a);
        pos.set(_a.x, c.base, _a.z);
        quat.setFromAxisAngle(up, c.rot);
        scl.set(along ? len : YARD_WALL_T, YARD_WALL_H, along ? YARD_WALL_T : len);
        pm.setMatrixAt(i, _m.compose(pos, quat, scl));
        pm.setColorAt(i, c.tint);
      });
      piers.forEach(([c, p], i) => {
        this._yardWorld(c, p.x, p.z, _a);
        pos.set(_a.x, c.base, _a.z);
        quat.setFromAxisAngle(up, c.rot);
        qm.setMatrixAt(i, _m.compose(pos, quat, scl.set(1, 1, 1)));
        qm.setColorAt(i, pierColor.copy(c.tint).multiplyScalar(0.78));
      });
      pm.count = panels.length;
      qm.count = piers.length;
      for (const im of [pm, qm]) {
        im.instanceMatrix.needsUpdate = true;
        im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        im.frustumCulled = true; // static: let three cull the whole set
      }
    }
    this._shownSig = 0;
    this._typeList = Object.values(this.types);
  }

  /**
   * Packs the houses in view into the instanced meshes: shells in the camera's
   * view (and every one close by, for shadows), interiors, bulbs and switches
   * only up close. Rewrites the instance buffers only when the set changes or
   * a door is moving. Call once per frame before rendering.
   */
  cull(camera) {
    if (!this._finalized) this.finalize();
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    const cp = camera.position;
    // A running hash of who's shown (no strings: nothing allocated per frame)
    let sig = 7, moving = false;
    for (const h of this.houses) {
      const d = Math.hypot(h.x - cp.x, h.z - cp.z);
      _sphere.center.set(h.x, h.cy, h.z);
      _sphere.radius = h.radius;
      const inView = d < SHELL_RANGE && (d < NEAR_ALWAYS || _frustum.intersectsSphere(_sphere));
      h.shown = inView;
      h.inside = inView && d < INTERIOR_RANGE;
      sig = (Math.imul(sig, 31) + (h.shown ? (h.inside ? 2 : 1) : 0)) | 0;
      if (h.doorAnim > 0) moving = true;
    }
    if (sig === this._shownSig && !moving && !this._dirty) return;
    this._shownSig = sig;
    this._dirty = false;

    for (const T of this._typeList) {
      let ns = 0, ni = 0;
      for (const h of T.list) {
        if (!h.shown) continue;
        T.shellMeshes.forEach(im => {
          im.setMatrixAt(ns, h.matrix);
          if (im.userData.tinted) im.setColorAt(ns, h.tint);
        });
        ns++;
        if (h.inside) {
          for (const im of T.interiorMeshes) im.setMatrixAt(ni, h.matrix);
          ni++;
        }
      }
      for (const im of T.shellMeshes) this._commit(im, ns);
      for (const im of T.interiorMeshes) this._commit(im, ni);
    }
    let nd = 0, nb = 0, nl = 0;
    for (const h of this.houses) {
      if (!h.shown) continue;
      h.doorMeshes.forEach((o, i) => this.doorMeshes[i]?.setMatrixAt(nd, o.matrixWorld));
      nd++;
      if (!h.inside) continue;
      for (const b of h.T.bulbs) {
        _v.set(b.x, b.y, b.z).applyMatrix4(h.matrix);
        this.bulbMesh.setMatrixAt(nb, _m.makeTranslation(_v.x, _v.y, _v.z).multiply(_m2.makeRotationY(h.rot)).scale(_v.set(HOUSE_SCALE, HOUSE_SCALE, HOUSE_SCALE)));
        this.bulbMesh.setColorAt(nb, h.floors[b.floor]?.lightOn ? _onColor : _offColor);
        nb++;
      }
      for (const f of h.floors) this.leverMesh.setMatrixAt(nl++, f.leverMatrix);
    }
    for (const im of this.doorMeshes) this._commit(im, nd);
    this._commit(this.bulbMesh, nb);
    this._commit(this.leverMesh, nl);
  }

  /**
   * Loading-screen GPU warm-up: draw every instanced part (stale matrices are
   * fine for one hidden frame) so each program compiles now, not on sight.
   */
  warmup(on) {
    if (!this._finalized) this.finalize();
    const all = [...Object.values(this.types).flatMap(T => [...T.shellMeshes, ...T.interiorMeshes]), ...this.doorMeshes, this.bulbMesh, this.leverMesh];
    for (const im of all) im.count = on ? im.instanceMatrix.count : 0;
    this._shownSig = 0;
  }

  _commit(im, count) {
    im.count = count;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  /** Map footprints (+ door state) for the minimap; compound walls as thin boxes. */
  mapObstacles() {
    const S = HOUSE_SCALE;
    const out = this.houses.map(h => ({
      type: "box", x: h.x, z: h.z, w: (h.t.halfW * 2 + 0.2) * S, d: (h.t.halfD * 2 + 0.2) * S, rot: h.rot, house: true,
      door: { x: h.t.doorX * S, z: h.t.halfD * S, half: DOOR_HALF * S, get open() { return h.doorOpen; } },
    }));
    for (const c of this.compounds) {
      for (const p of c.pieces) {
        if (p.kind !== "panel") continue;
        const mx = (p.x0 + p.x1) / 2, mz = (p.z0 + p.z1) / 2;
        const len = Math.hypot(p.x1 - p.x0, p.z1 - p.z0);
        const along = Math.abs(p.x1 - p.x0) > Math.abs(p.z1 - p.z0);
        this._yardWorld(c, mx, mz, _a);
        out.push({ type: "box", x: _a.x, z: _a.z, w: along ? len : YARD_WALL_T, d: along ? YARD_WALL_T : len, rot: c.rot, wall: true });
      }
    }
    return out;
  }

  isInside(h, x, z, margin = IN_MARGIN) {
    const l = this._toLocal(h, x, z, _a);
    return Math.abs(l.x) < h.hw - margin && Math.abs(l.z) < h.hd - margin;
  }

  /** The house (x, z) is inside, or null. */
  houseAt(x, z) {
    for (const h of this.houses) if (this.isInside(h, x, z)) return h;
    return null;
  }

  /** 0 = ground floor, 1 = upstairs, for feet at world height y in house h. */
  level(h, y) {
    return h.t.floors > 1 && (y - h.y0) / HOUSE_SCALE > UP_LEVEL ? 1 : 0;
  }

  /** The floor (lights, switch) you're on at (x, feet y, z), or null outdoors. */
  floorAt(x, y, z) {
    const h = this.houseAt(x, z);
    return h ? h.floors[this.level(h, y)] : null;
  }

  /** True if (x, z) is inside or right against any house or compound wall (keeps spawns and props out). */
  blocks(x, z, pad = 1.5) {
    for (const h of this.houses) {
      if (Math.abs(x - h.x) > h.radius + pad || Math.abs(z - h.z) > h.radius + pad) continue;
      const l = this._toLocal(h, x, z, _a);
      if (Math.abs(l.x) < h.hw + pad / HOUSE_SCALE && Math.abs(l.z) < h.hd + pad / HOUSE_SCALE) return true;
    }
    for (const c of this.compounds) {
      const l = this._yardLocal(c, x, z, _a);
      const ax = Math.abs(l.x), az = Math.abs(l.z);
      if (ax > c.hw + pad || az > c.hd + pad) continue;
      // On (or near) a wall line, not anywhere in the yard
      if (ax > c.hw - pad || az > c.hd - pad) return true;
    }
    return false;
  }

  /** True if (x, z) is inside a compound's yard. */
  inYard(x, z, margin = 0) {
    for (const c of this.compounds) {
      const l = this._yardLocal(c, x, z, _a);
      if (Math.abs(l.x) < c.hw - margin && Math.abs(l.z) < c.hd - margin) return true;
    }
    return false;
  }

  /**
   * House-local stair surface height at (lx, lz), or null when not over the
   * stairs. lead: read the step that far further up (a body reaches ahead of its centre).
   */
  _stairHeight(h, lx, lz, lead = 0) {
    const st = h.t.stairs;
    if (!st) return null;
    if (Math.abs(lz - st.z) > st.hw + 0.1 || lx < st.x1 - 0.05 || lx > st.x0 + 0.15) return null;
    return THREE.MathUtils.clamp((st.x0 - lx + lead) / (st.x0 - st.x1), 0, 1) * UP_Y;
  }

  /**
   * Height of the floor something standing at (x, feet y, z) walks on: the
   * stairs, the upper floor (when it's already up there) or the ground floor.
   * `ground` is the terrain height there, returned outside every house.
   */
  surfaceAt(x, z, y, ground) {
    for (const h of this.houses) {
      if (Math.abs(x - h.x) > h.radius || Math.abs(z - h.z) > h.radius) continue;
      const l = this._toLocal(h, x, z, _a);
      if (Math.abs(l.x) > h.hw || Math.abs(l.z) > h.hd) continue;
      const S = HOUSE_SCALE;
      const ly = (y - h.y0) / S;
      if (h.t.floors > 1) {
        // Half a metre of lead, so a monster's body clears the next step and the landing's edge
        const stair = this._stairHeight(h, l.x, l.z, 0.45);
        if (stair !== null && ly > stair - 1.1) return h.y0 + stair * S;
        const hole = h.t.hole;
        const inHole = l.x > hole.x0 && l.x < hole.x1 && l.z < hole.z1;
        if (ly > UP_LEVEL && !inHole) return h.y0 + UP_Y * S;
      }
      return Math.max(ground, h.y0 + 0.1 * S);
    }
    return ground;
  }

  // ── Interaction ─────────────────────────────────────────────────────────────

  /** Nearest door / light switch the player can use from (px, pz) with feet at py. */
  interaction(px, pz, py = 0) {
    let door = null, sw = null, bestD = DOOR_RANGE * DOOR_RANGE;
    for (const h of this.houses) {
      if (Math.abs(px - h.x) > h.radius + DOOR_RANGE || Math.abs(pz - h.z) > h.radius + DOOR_RANGE) continue;
      const up = this.level(h, py);
      if (!up) {
        const dx = h.doorWorld.x - px, dz = h.doorWorld.z - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) { bestD = d2; door = h; }
      }
      const f = h.floors[up];
      if (!f) continue;
      const sx = f.switchWorld.x - px, sz = f.switchWorld.z - pz;
      if (sx * sx + sz * sz < SWITCH_RANGE * SWITCH_RANGE && this.isInside(h, px, pz, -0.2)) sw = f;
    }
    return { door, sw };
  }

  setDoor(h, open) {
    if (!h || h.doorOpen === open) return false;
    h.doorOpen = open;
    const from = open ? h.closeAction : h.openAction;
    const to = open ? h.openAction : h.closeAction;
    const dur = to.getClip().duration;
    // Reversing mid-swing starts the other clip from the mirrored time
    const t = from.isRunning() ? Math.max(0, dur - from.time) : 0;
    to.reset();
    to.time = t;
    to.play();
    from.stop();
    h.doorAnim = dur - t + 0.05;
    const at = { x: h.doorWorld.x, y: h.y0 + 1.2, z: h.doorWorld.z };
    open ? this.sfx?.doorOpen(at) : this.sfx?.doorClose(dur - t, at);
    return true;
  }

  /** f: one of h.floors. */
  toggleLight(f) {
    if (!f) return;
    f.lightOn = !f.lightOn;
    this._leverMatrix(f.house, f);
    this._dirty = true;
    this.sfx?.lightSwitch(f.switchWorld);
  }

  // ── Per frame ───────────────────────────────────────────────────────────────

  update(delta, px, pz) {
    for (const h of this.houses) {
      if (h.doorAnim > 0) {
        h.doorAnim -= delta;
        h.mixer.update(delta);
        this._syncDoorBody(h);
        if (h.doorAnim <= 0) this._dirty = true; // one last write with the door at rest
      }
    }

    // Give the shared lights to the nearest lit floors (within 60 m)
    let f0 = null, f1 = null, d0 = 3600, d1 = 3600;
    for (const h of this.houses) {
      const d2 = (h.x - px) ** 2 + (h.z - pz) ** 2;
      if (d2 > d1) continue;
      for (const f of h.floors) {
        if (!f.lightOn) continue;
        if (d2 < d0) { f1 = f0; d1 = d0; f0 = f; d0 = d2; }
        else if (d2 < d1) { f1 = f; d1 = d2; }
      }
    }
    this._assignLight(this.lights[0], f0);
    this._assignLight(this.lights[1], f1); // no-op when the quality preset has only one
  }

  _assignLight(l, f) {
    if (!l) return;
    if (!f) { l.intensity = 0; return; }
    const p = f.house.t.lightPos[f.index];
    this._toWorld(f.house, p.x, p.z, l.position);
    l.position.y = f.house.y0 + p.y * HOUSE_SCALE;
    l.intensity = 9;
  }

  /**
   * Doorway assist: while (x, z) moves through a doorway, returns a sideways
   * pull (written to out) toward the door's centre line, so a 0.7 m wide
   * player doesn't snag the jamb of a 0.9 m door.
   */
  doorAssist(x, z, vx, vz, out) {
    for (const h of this.houses) {
      if (Math.abs(x - h.x) > h.radius + 2 || Math.abs(z - h.z) > h.radius + 2) continue;
      const l = this._toLocal(h, x, z, _a);
      const dx = h.t.doorX;
      if (Math.abs(l.z - h.hd) > 1.2 || Math.abs(l.x - dx) > 0.8) continue;
      const lvz = vx * h.sin + vz * h.cos;        // velocity along the door axis
      if (Math.abs(lvz) < 0.8) continue;
      const pull = THREE.MathUtils.clamp((dx - l.x) * 7, -3, 3) * HOUSE_SCALE;
      out.x = pull * h.cos;
      out.z = -pull * h.sin;
      return true;
    }
    return false;
  }

  // ── Zombie navigation ───────────────────────────────────────────────────────

  /**
   * Picks where a zombie at (zx, zz) should walk to reach the player at
   * (px, pz) given the compounds, houses and other solid obstacles. zy / py:
   * feet heights, so monsters take the stairs to whoever is on the other floor.
   *   0 — nothing in the way, chase directly
   *   1 — walk to out.x/out.z (gate, door, doorway, stairs or a corner around an obstacle)
   *   2 — stuck at a closed door (or too big for it): out = door approach point, out.fx/fz = door
   */
  navigate(zx, zz, px, pz, out, big = false, zy = 0, py = 0) {
    // When several obstacles cross the straight line, detour round the nearest one
    _nav.best = Infinity;
    _nav.zx = zx; _nav.zz = zz; _nav.px = px; _nav.pz = pz;
    // Bounding box of the straight line, to skip obstacles nowhere near it
    _nav.x0 = Math.min(zx, px); _nav.x1 = Math.max(zx, px); _nav.z0 = Math.min(zz, pz); _nav.z1 = Math.max(zz, pz);

    // Yards first: in or out only through the gate
    for (const c of this.compounds) {
      const cr = c.hw + c.hd;
      if (!navNear(c.x, c.z, cr + 2) && Math.hypot(zx - c.x, zz - c.z) > cr) continue;
      const zl = this._yardLocal(c, zx, zz, _zl);
      const pl = this._yardLocal(c, px, pz, _pl);
      const zIn = Math.abs(zl.x) < c.hw && Math.abs(zl.z) < c.hd;
      const pIn = Math.abs(pl.x) < c.hw && Math.abs(pl.z) < c.hd;
      if (zIn !== pIn) {
        const inGate = Math.abs(zl.x - c.gateX) < YARD_GATE / 2 - 0.5 && Math.abs(zl.z - c.hd) < 1.7;
        if (inGate) {
          const tgt = zIn ? c.gateOut : c.gateIn;
          out.x = tgt.x + (tgt.x - c.gate.x) * 0.6; out.z = tgt.z + (tgt.z - c.gate.z) * 0.6;
          return 1;
        }
        const tgt = zIn ? c.gateIn : c.gateOut;
        out.x = tgt.x; out.z = tgt.z;
        if (!zIn) {
          // The gate may be on the far side of the yard
          _box.x = c.x; _box.z = c.z; _box.rot = c.rot; _box.hw = c.hw; _box.hd = c.hd;
          if (routeAround(_box, zx, zz, tgt.x, tgt.z, out)) return 1;
        }
        return 1;
      }
      if (!zIn && !pIn) {
        _box.x = c.x; _box.z = c.z; _box.rot = c.rot; _box.hw = c.hw; _box.hd = c.hd;
        navConsider(_box);
      }
    }

    for (const h of this.houses) {
      if (!navNear(h.x, h.z, h.radius + 2) && Math.hypot(zx - h.x, zz - h.z) > h.radius + 2 && Math.hypot(px - h.x, pz - h.z) > h.radius + 2) continue;
      const zl = this._toLocal(h, zx, zz, _zl);
      const pl = this._toLocal(h, px, pz, _pl);
      const t = h.t, HW = t.halfW, HD = t.halfD, DX = t.doorX;
      _box.x = h.x; _box.z = h.z; _box.rot = h.rot; _box.hw = HW * HOUSE_SCALE; _box.hd = HD * HOUSE_SCALE;
      const zIn = Math.abs(zl.x) < HW - IN_MARGIN && Math.abs(zl.z) < HD - IN_MARGIN;
      const pIn = Math.abs(pl.x) < HW - IN_MARGIN && Math.abs(pl.z) < HD - IN_MARGIN;

      if (zIn && t.stairs) {
        const st = t.stairs;
        const zUp = this.level(h, zy) === 1;
        const pUp = pIn && this.level(h, py) === 1;
        // On the stairs: keep going the way the target is
        if (this._stairHeight(h, zl.x, zl.z) !== null && (zUp || pUp || zl.x < st.x0 - 0.3)) {
          this._toWorld(h, pUp ? st.x1 - 0.9 : st.x0 + 0.9, st.z, out);
          return 1;
        }
        if (zUp && !pUp) return this._towardStairsTop(h, zl, out);   // come down first
        if (!zUp && pUp) return this._towardStairsBottom(h, zl, out); // go up
        if (zUp && this._aroundStairwell(h, zl, pl, out)) return 1;   // upstairs: not across the opening
      }
      if (zIn && pIn) return 0;                                       // same floor

      // In the doorway and lined up with it: keep going straight through
      const aligned = Math.abs(zl.x - DX) < 0.22;
      const inDoorway = aligned && zl.z > HD - 0.9 && zl.z < HD + 0.9;
      if (zIn !== pIn) {
        out.fx = h.doorWorld.x;
        out.fz = h.doorWorld.z;
        if (!zIn) {
          // Outside, player inside: line up in front of the door, then walk through.
          // Big monsters don't fit: they wait (and pound) at the door.
          const canEnter = h.doorOpen && !big;
          if (canEnter && inDoorway) { this._toWorld(h, DX, HD - 1.6, out); return 1; }
          const ax = DX, az = HD + (big ? 1.6 : 1.1);
          const d = Math.hypot(zl.x - ax, zl.z - az);
          if (d < 0.9) {
            if (canEnter && aligned) { this._toWorld(h, DX, HD - 1.6, out); return 1; }
            this._toWorld(h, ax, az, out);
            return canEnter ? 1 : 2;
          }
          this._toWorld(h, ax, az, out);
          // The door may be on the far side of the house
          const tx = out.x, tz = out.z;
          if (routeAround(_box, zx, zz, tx, tz, out)) return 1;
          out.x = tx; out.z = tz;
          return 1;
        }
        // Inside, player outside: line up behind the door and out
        if (h.doorOpen && inDoorway) { this._toWorld(h, DX, HD + 1.6, out); return 1; }
        const ax = DX, az = HD - 1.0;
        const d = Math.hypot(zl.x - ax, zl.z - az);
        if (d < 0.8) {
          if (h.doorOpen && aligned) { this._toWorld(h, DX, HD + 1.6, out); return 1; }
          this._toWorld(h, ax, az, out);
          return h.doorOpen ? 1 : 2;
        }
        this._toWorld(h, ax, az, out);
        return 1;
      }

      // Both outside this house: walk around it if it's in the way
      navConsider(_box);
    }
    for (const o of this.obstacles) navConsider(o);
    if (_nav.best === Infinity) return 0;
    out.x = _nav.bx; out.z = _nav.bz;
    return 1;
  }

  /** Upstairs: if the straight line to the target crosses the stairwell, a corner round it. */
  _aroundStairwell(h, zl, pl, out) {
    const hole = h.t.hole;
    const cx = (hole.x0 + hole.x1) / 2, cz = (hole.z0 + hole.z1) / 2;
    const ex = (hole.x1 - hole.x0) / 2 + 0.35, ez = (hole.z1 - hole.z0) / 2 + 0.35;
    if (!segHitsRect(zl.x - cx, zl.z - cz, pl.x - cx, pl.z - cz, ex, ez)) return false;
    let best = Infinity, bx = 0, bz = 0;
    for (const x of [hole.x0 - 0.6, hole.x1 + 0.6]) {
      const z = hole.z1 + 0.6;
      const d0 = Math.hypot(x - zl.x, z - zl.z);
      if (d0 < 0.4) continue; // already at this corner
      const cost = d0 + Math.hypot(pl.x - x, pl.z - z);
      if (cost < best) { best = cost; bx = x; bz = z; }
    }
    if (best === Infinity) return false;
    this._toWorld(h, bx, bz, out);
    return true;
  }

  /** Ground floor → the foot of the stairs, then up them. */
  _towardStairsBottom(h, zl, out) {
    const st = h.t.stairs;
    const ax = st.x0 + 0.9;
    if (Math.hypot(zl.x - ax, zl.z - st.z) < 0.9) this._toWorld(h, st.x1 - 0.9, st.z, out);
    else this._toWorld(h, ax, st.z, out);
    return 1;
  }

  /** Upper floor → round the railing to the top of the stairs, then down them. */
  _towardStairsTop(h, zl, out) {
    const st = h.t.stairs, hole = h.t.hole;
    const ax = st.x1 - 0.9;
    if (zl.x > ax + 0.5) {
      // Behind the railing: step out in front of it first, then along to the left wall
      if (zl.z < hole.z1 + 0.4) this._toWorld(h, zl.x, hole.z1 + 0.7, out);
      else this._toWorld(h, ax - 0.1, hole.z1 + 0.7, out);
    } else if (Math.hypot(zl.x - ax, zl.z - st.z) < 0.6) {
      this._toWorld(h, st.x0 + 0.9, st.z, out);
    } else {
      this._toWorld(h, ax, st.z, out);
    }
    return 1;
  }
}
