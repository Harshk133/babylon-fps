import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GROUP_WORLD, GROUP_GLASS, GROUP_ZOMBIE } from "../physicsGroups.js";
import { QUALITY } from "../quality.js";

// Enterable two-story houses assembled from Kenney's CC0 Building Kit +
// Furniture Kit (public/models/house/house-kit.glb, built by
// `npm run build-house-kit`).
//
// Every house shares one layout: the static pieces are merged into a few
// meshes once (one draw call per material) and reused by every house. Each
// house then gets its own animated door (the kit's open/close clips) with a
// kinematic collider, a light switch and ceiling lamps on each floor, and a
// compound physics body with a box per wall section, so walls, windows,
// floors, stairs and furniture block the player and zombies like real ones.
//
// Ground floor: living room + kitchen, door on +Z, stairs along the back wall
// rising toward −X. Upper floor: bedroom / lounge with windows on every side
// (glass stops bodies, not bullets: camp up there and shoot out), a railing
// round the stairwell. Monsters follow you up through surfaceAt() + navigate().
//
// House-local frame (kit units, before HOUSE_SCALE): door on the +Z wall,
// footprint 8 × 6. _toLocal / _toWorld convert to and from world metres.

// Kit rooms are 2.4 m high with 2.1 m doors: too low for 2.4 m zombies and the
// over-the-shoulder camera. ×1.2 gives 2.9 m ceilings and 1.08 × 2.5 m doors.
const HOUSE_SCALE = 1.2;
const SEG        = 2;                   // kit wall segment length
const WALL_H     = 2.4;
const HALF_W     = 4;                   // wall centre lines
const HALF_D     = 3;
const SINK       = 0.08;                // floor tiles sit flush with the ground
const COLLIDER_T = 0.4;                 // fat enough that nothing tunnels through a 0.1 m wall
const FURN_SCALE = WALL_H / 1.29;       // Furniture Kit walls are 1.29 tall
const DOOR_X     = 1;                   // doorway segment centre on the front wall
const DOOR_HALF  = 0.45;
const DOOR_H     = 2.1;
const WIN_Y0     = 0.7;                 // window hole
const WIN_Y1     = 1.9;
const UP_Y       = WALL_H + 0.1;        // upper floor surface (floor tiles sit on the ground-floor walls)
const UP_LEVEL   = 1.6;                 // local feet height above which you count as upstairs
const STAIR_Z    = -HALF_D + 0.7;       // stairs centre line, against the back wall
const STAIR_X0   = 2;                   // bottom step
const STAIR_X1   = -2;                  // top step
const STAIR_HW   = 0.65;
const HOLE       = { x0: -2, x1: 2, z0: -HALF_D, z1: -1 }; // stairwell opening in the upper floor
// Per floor: light switch (position + facing) and the shared point light's spot
const SWITCHES = [
  { pos: new THREE.Vector3(0.27, 1.3, HALF_D - 0.11), rotY: Math.PI },
  { pos: new THREE.Vector3(-HALF_W + 0.11, UP_Y + 1.3, -1.45), rotY: Math.PI / 2 },
];
const LIGHT_POS = [new THREE.Vector3(-0.5, 2.0, 0.3), new THREE.Vector3(0.2, UP_Y + 1.9, 0.9)];
const DOOR_RANGE   = 2.3;
const SWITCH_RANGE = 1.7;
const HOUSE_LIGHTS = QUALITY.houseLights; // shared point lights, given to the nearest lit houses
const IN_MARGIN  = 0.05;

const R90 = Math.PI / 2;

// [piece, x, z, rotY]. Walls spanning X are rotated 90°. The doorway is turned
// −90° so the kit's door swings into the house.
const WALLS = [
  ["wall-window-square", -3, HALF_D, R90], ["wall", -1, HALF_D, R90],
  ["wall-doorway-square", DOOR_X, HALF_D, -R90], ["wall-window-square", 3, HALF_D, R90],
  ["wall", -3, -HALF_D, R90], ["wall", -1, -HALF_D, R90],
  ["wall", 1, -HALF_D, R90], ["wall-window-square", 3, -HALF_D, R90],
  ["wall", -HALF_W, -2, 0], ["wall-window-square", -HALF_W, 0, 0], ["wall", -HALF_W, 2, 0],
  ["wall-window-square", HALF_W, -2, 0], ["wall", HALF_W, 0, 0], ["wall", HALF_W, 2, 0],
];
// Upper floor: a window on almost every segment, to watch (and shoot down at) every approach
const WALLS_UP = [
  ["wall-window-square-detailed", -3, HALF_D, R90], ["wall-window-square-detailed", -1, HALF_D, R90],
  ["wall-window-square-detailed", 1, HALF_D, R90], ["wall-window-square-detailed", 3, HALF_D, R90],
  ["wall-window-square-detailed", -3, -HALF_D, R90], ["wall", -1, -HALF_D, R90],
  ["wall", 1, -HALF_D, R90], ["wall-window-square-detailed", 3, -HALF_D, R90],
  ["wall", -HALF_W, -2, 0], ["wall-window-square-detailed", -HALF_W, 0, 0], ["wall-window-square-detailed", -HALF_W, 2, 0],
  ["wall-window-square-detailed", HALF_W, -2, 0], ["wall-window-square-detailed", HALF_W, 0, 0], ["wall", HALF_W, 2, 0],
];
// Waist-high railing round the stairwell (the top of the stairs, at x = −2, stays open)
const RAILING = [[-1, HOLE.z1, R90], [1, HOLE.z1, R90], [HOLE.x1, -2, 0]];

// [piece, x, z, rotY, { y, floor, collide }]  — "front" of each piece faces +Z at rotY 0
const FURNITURE = [
  // Ground floor: living room left, dining in the middle, kitchen on the right wall
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
  // Upper floor: bedroom left, lounge front, storage behind the railing
  ["bedSingle", -3.3, 1.85, Math.PI, { floor: 1 }],
  ["sideTable", -2.1, 2.62, Math.PI, { floor: 1 }],
  ["rugRectangle", 0.6, 1.3, 0, { floor: 1, collide: false }],
  ["loungeSofa", 0.6, 2.5, Math.PI, { floor: 1 }],
  ["tableCoffee", 0.6, 1.35, 0, { floor: 1 }],
  ["bookcaseOpen", 3.62, 1.6, -R90, { floor: 1 }],
  ["pottedPlant", 2.5, 2.6, 0, { floor: 1 }],
  ["lampRoundFloor", -3.5, -0.4, 0, { floor: 1, collide: false }],
  ["cardboardBoxClosed", 3.45, -2.55, 0, { floor: 1 }], ["cardboardBoxClosed", 3.45, -2.05, 0.3, { floor: 1 }],
];
// [x, z, floor]
const CEILING_LAMPS = [[-0.5, 0.3, 0], [-2.6, 1.3, 0], [2.3, 0.3, 0], [-2.4, 1.2, 1], [1.2, 0.9, 1], [2.9, -1.9, 1]];

// Interior spots for loot (house-local [x, z, floor])
export const HOUSE_LOOT_SPOTS = [[-1.5, -0.4, 0], [2.4, 2.3, 0], [-2.8, -0.5, 0], [-1.6, 0.3, 1], [2.7, -1.2, 1], [-2.0, 2.0, 1]];

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _a = { x: 0, z: 0 };
const _b = { x: 0, z: 0 };
const _zl = { x: 0, z: 0 };
const _pl = { x: 0, z: 0 };
const _box = { x: 0, z: 0, rot: 0, hw: HALF_W * HOUSE_SCALE, hd: HALF_D * HOUSE_SCALE };

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
    this.switchPlateMat = new THREE.MeshStandardMaterial({ color: 0xece8e0, roughness: 0.5 });
    this.switchLeverMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.4 });
    this.switchPlateGeo = new THREE.BoxGeometry(0.09, 0.13, 0.014);
    this.switchLeverGeo = new THREE.BoxGeometry(0.024, 0.05, 0.03).translate(0, 0.02, 0.012);

    this._buildLayout();

    this.lights = [];
    for (let i = 0; i < HOUSE_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffd29a, 0, 11, 1.4);
      l.position.set(0, -500, 0);
      scene.add(l);
      this.lights.push(l);
    }
  }

  // ── Layout (built once, shared by every house) ──────────────────────────────

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

  _buildLayout() {
    const layout = new THREE.Group();
    const boxes = [];   // solid colliders: { x, y, z, hx, hy, hz, rot, rz? }
    const glass = [];   // window panes: block bodies, not bullets or grenades

    // A box in a wall piece's frame (span along local Z, thickness along X)
    const wallBox = (px, pz, rot, z0, z1, y0, y1, list = boxes) => {
      const cz = (z0 + z1) / 2;
      list.push({
        x: px + cz * Math.sin(rot), y: (y0 + y1) / 2 - SINK, z: pz + cz * Math.cos(rot),
        hx: COLLIDER_T / 2, hy: (y1 - y0) / 2, hz: (z1 - z0) / 2, rot,
      });
    };
    const piece = (name, x, y, z, rot = 0) => {
      const o = this.pieces[`b_${name}`].clone(true);
      o.position.set(x, y, z);
      o.rotation.y = rot;
      layout.add(o);
      return o;
    };

    // Both stories of walls; window holes get a glass collider instead of a solid one
    const H = WALL_H + 0.1;
    for (const [list, y] of [[WALLS, 0], [WALLS_UP, WALL_H]]) {
      for (const [name, x, z, rot] of list) {
        piece(name, x, y, z, rot);
        if (name === "wall") {
          wallBox(x, z, rot, -1, 1, y, y + H);
        } else if (name === "wall-doorway-square") {
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
      piece("column", sx * HALF_W, 0, sz * HALF_D);
      piece("column", sx * HALF_W, WALL_H, sz * HALF_D);
    }
    // Trim band between the stories, all the way round (faces outward)
    for (const x of [-3, -1, 1, 3]) {
      piece("border", x, WALL_H - 0.12, HALF_D, -R90);
      piece("border", x, WALL_H - 0.12, -HALF_D, R90);
    }
    for (const z of [-2, 0, 2]) {
      piece("border", -HALF_W, WALL_H - 0.12, z, Math.PI);
      piece("border", HALF_W, WALL_H - 0.12, z, 0);
    }

    // Floors (the upper one leaves the stairwell open) and the roof on top
    for (let ix = -1.5; ix <= 1.5; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const x = ix * SEG, z = iz * SEG;
        piece("floor", x, 0, z);
        const inHole = x > HOLE.x0 && x < HOLE.x1 && z > HOLE.z0 && z < HOLE.z1;
        if (!inHole) piece("floor", x, WALL_H, z);
        // Roof: lipped pieces around the edge, flat ones inside
        const edgeX = Math.abs(ix) === 1.5 ? Math.sign(ix) : 0;
        const edgeZ = Math.abs(iz) === 1 ? Math.sign(iz) : 0;
        let name = "roof-flat-center", rot = 0;
        if (edgeX && edgeZ) {
          name = "roof-flat-corner";
          rot = edgeX > 0 ? (edgeZ > 0 ? 0 : R90) : (edgeZ > 0 ? -R90 : Math.PI);
        } else if (edgeX || edgeZ) {
          name = "roof-flat-side";
          rot = edgeX > 0 ? 0 : edgeX < 0 ? Math.PI : edgeZ > 0 ? -R90 : R90;
        }
        piece(name, x, 2 * WALL_H, z, rot);
      }
    }
    // Upper floor slab in three boxes round the stairwell, top flush with the tiles
    const slab = (x0, x1, z0, z1) => boxes.push({ x: (x0 + x1) / 2, y: WALL_H - SINK, z: (z0 + z1) / 2, hx: (x1 - x0) / 2, hy: 0.1, hz: (z1 - z0) / 2, rot: 0 });
    slab(-HALF_W, HOLE.x0, -HALF_D, HALF_D);
    slab(HOLE.x0, HOLE.x1, HOLE.z1, HALF_D);
    slab(HOLE.x1, HALF_W, -HALF_D, HALF_D);
    boxes.push({ x: 0, y: 2 * WALL_H + 0.08 - SINK, z: 0, hx: HALF_W + 0.25, hy: 0.12, hz: HALF_D + 0.25, rot: 0 });

    // Stairs: the kit piece rises toward its +Z, turned to climb toward −X.
    // Collider: one tilted box whose top face is the slope (the player's
    // controller walks it like a ramp), plus a block under the high half.
    // Monsters pass through the ramp (their height follows the steps through
    // surfaceAt()) but not the block, so they can't wander in under the stairs.
    piece("stairs-closed", (STAIR_X0 + STAIR_X1) / 2, 0, STAIR_Z, -R90);
    const run = STAIR_X0 - STAIR_X1, slope = Math.atan2(UP_Y, run), len = Math.hypot(run, UP_Y);
    boxes.push({
      x: (STAIR_X0 + STAIR_X1) / 2 - Math.sin(slope) * 0.1, y: UP_Y / 2 - Math.cos(slope) * 0.1 - SINK, z: STAIR_Z,
      hx: len / 2, hy: 0.1, hz: STAIR_HW, rot: 0, rz: -slope, stairs: true,
    });
    boxes.push({ x: STAIR_X1 / 2, y: UP_Y / 4 - SINK, z: STAIR_Z, hx: -STAIR_X1 / 2, hy: UP_Y / 4, hz: STAIR_HW, rot: 0 });
    for (const [x, z, rot] of RAILING) {
      piece("wall-low", x, UP_Y, z, rot);
      wallBox(x, z, rot, -1, 1, UP_Y, UP_Y + 1.2);
    }
    // The opening beside the top step, between the stairs and the railing (a banister's spot)
    wallBox(HOLE.x0, (STAIR_Z + STAIR_HW + HOLE.z1) / 2, 0, -(HOLE.z1 - STAIR_Z - STAIR_HW) / 2, (HOLE.z1 - STAIR_Z - STAIR_HW) / 2, UP_Y, UP_Y + 1.2);

    for (const [name, x, z, rot, opts = {}] of FURNITURE) {
      const { wrap, size } = this._furnitureTemplate(name);
      const y = (opts.y ?? 0) + (opts.floor ? UP_Y : 0);
      wrap.position.set(x, y, z);
      wrap.rotation.y = rot;
      layout.add(wrap);
      if (opts.collide !== false) {
        boxes.push({ x, y: y + size.y / 2 - SINK, z, hx: size.x / 2, hy: size.y / 2, hz: size.z / 2, rot });
      }
    }

    // Merge everything static into one mesh per material
    layout.updateMatrixWorld(true);
    const groups = new Map();
    layout.traverse(o => {
      if (!o.isMesh) return;
      const isGlass = /ignore/i.test(o.name) || /ignore/i.test(o.parent?.name ?? "");
      const mat = isGlass ? this.glassMat : o.material;
      // Plain floats first: kit pieces from different exports store vertices in
      // different (quantized) formats, which neither merge nor transform cleanly
      const g = new THREE.BufferGeometry();
      for (const key of ["position", "normal", "uv"]) {
        const a = o.geometry.attributes[key];
        if (!a) continue;
        const arr = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) arr[i * a.itemSize + k] = a.getComponent(i, k);
        g.setAttribute(key, new THREE.BufferAttribute(arr, a.itemSize));
      }
      if (o.geometry.index) g.setIndex(Array.from(o.geometry.index.array));
      g.applyMatrix4(o.matrixWorld);
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
      if (!groups.has(mat)) groups.set(mat, []);
      groups.get(mat).push(g);
    });
    this.staticParts = [];
    for (const [material, geos] of groups) {
      const geometry = mergeGeometries(geos, false);
      geometry.computeBoundingSphere();
      this.staticParts.push({ geometry, material });
    }

    // Ceiling lamps: separate so each floor can light its own bulbs
    const lamp = this._furnitureTemplate("lampSquareCeiling");
    this.lampTemplate = lamp.wrap;
    this.lampHeight = lamp.size.y;

    this.colliderBoxes = boxes;
    this.glassBoxes = glass;
  }

  // ── Houses ──────────────────────────────────────────────────────────────────

  /** Places a house. rotY: radians; the door faces local +Z. */
  add(x, z, rotY) {
    const S = HOUSE_SCALE;
    const root = new THREE.Group();
    root.position.set(x, -SINK * S, z);
    root.rotation.y = rotY;
    root.scale.setScalar(S);

    for (const part of this.staticParts) {
      const mesh = new THREE.Mesh(part.geometry, part.material);
      mesh.castShadow = part.material !== this.glassMat;
      mesh.receiveShadow = true;
      root.add(mesh);
    }

    // Each floor: its own lamp material (so the floors light independently) and switch
    const floors = SWITCHES.map((s, f) => {
      let lampMat = null;
      for (const [lx, lz, lf] of CEILING_LAMPS) {
        if (lf !== f) continue;
        const lamp = this.lampTemplate.clone(true);
        lamp.position.set(lx, (f + 1) * WALL_H - this.lampHeight, lz);
        lamp.traverse(o => {
          if (!o.isMesh) return;
          o.castShadow = false;
          if (o.material.name === "lamp") {
            lampMat ??= o.material.clone();
            o.material = lampMat;
          }
        });
        root.add(lamp);
      }
      if (lampMat) { lampMat.emissive = new THREE.Color(0xffd27a); lampMat.emissiveIntensity = 0; }
      // Light switch with an animated rocker
      const sw = new THREE.Group();
      sw.position.copy(s.pos);
      sw.rotation.y = s.rotY;
      sw.add(new THREE.Mesh(this.switchPlateGeo, this.switchPlateMat));
      const lever = new THREE.Mesh(this.switchLeverGeo, this.switchLeverMat);
      lever.rotation.x = 0.35;
      sw.add(lever);
      root.add(sw);
      return { house: null, index: f, lampMat, lever, lightOn: false, switchWorld: new THREE.Vector3() };
    });

    // Door: the kit's door piece with its own mixer for the open/close clips
    const door = this.pieces["b_door-rotate-square-a"].clone(true);
    door.position.set(DOOR_X + DOOR_HALF, 0, HALF_D);
    door.rotation.y = -R90;
    door.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    root.add(door);
    const panel = door.getObjectByName("door");
    const mixer = new THREE.AnimationMixer(door);
    const openAction = mixer.clipAction(this.clips.open);
    const closeAction = mixer.clipAction(this.clips.close);
    for (const a of [openAction, closeAction]) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }

    this.scene.add(root);
    root.updateMatrixWorld(true);
    // Everything but the door leaf and the switch rockers is static
    root.traverse(o => { o.matrixAutoUpdate = false; });
    door.traverse(o => { o.matrixAutoUpdate = true; });
    for (const f of floors) f.lever.matrixAutoUpdate = true;

    // Physics: walls, floors, stairs, roof and furniture in one compound static body
    const q = new CANNON.Quaternion().setFromEuler(0, rotY, 0);
    const body = new CANNON.Body({ mass: 0, material: this.material, collisionFilterGroup: GROUP_WORLD });
    const glassBody = new CANNON.Body({ mass: 0, material: this.material, collisionFilterGroup: GROUP_GLASS });
    // Stairs: solid for players and grenades, not for monsters (pinned to surfaceAt, a ramp would stop them)
    const stairBody = new CANNON.Body({
      mass: 0, material: this.material, collisionFilterGroup: GROUP_WORLD, collisionFilterMask: ~GROUP_ZOMBIE,
    });
    const solid = this.colliderBoxes.filter(c => !c.stairs), stairs = this.colliderBoxes.filter(c => c.stairs);
    for (const [list, b] of [[solid, body], [stairs, stairBody], [this.glassBoxes, glassBody]]) {
      for (const c of list) {
        b.addShape(
          new CANNON.Box(new CANNON.Vec3(c.hx * S, c.hy * S, c.hz * S)),
          new CANNON.Vec3(c.x * S, c.y * S, c.z * S),
          new CANNON.Quaternion().setFromEuler(0, c.rot, c.rz ?? 0));
      }
      b.position.set(x, 0, z);
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
      x, z, y0: -SINK * S, rot: rotY, cos: Math.cos(rotY), sin: Math.sin(rotY),
      hw: HALF_W, hd: HALF_D,
      root, door, panel, mixer, openAction, closeAction, doorBody,
      doorOpen: false, doorAnim: 0,
      floors,
      doorWorld: new THREE.Vector3(),
    };
    this._toWorld(h, DOOR_X, HALF_D, h.doorWorld);
    floors.forEach((f, i) => {
      f.house = h;
      this._toWorld(h, SWITCHES[i].pos.x, SWITCHES[i].pos.z, f.switchWorld);
      f.switchWorld.y = h.y0 + SWITCHES[i].pos.y * S;
    });
    this._syncDoorBody(h);
    this.houses.push(h);
    return h;
  }

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
    h.door.updateMatrixWorld(true);
    h.panel.getWorldPosition(_v);
    h.panel.getWorldQuaternion(_q);
    h.doorBody.position.set(_v.x, _v.y, _v.z);
    h.doorBody.quaternion.set(_q.x, _q.y, _q.z, _q.w);
    h.doorBody.velocity.set(0, 0, 0);
    h.doorBody.aabbNeedsUpdate = true;
  }

  /** Map footprints (+ door state) for the minimap. */
  mapObstacles() {
    const S = HOUSE_SCALE;
    return this.houses.map(h => ({
      type: "box", x: h.x, z: h.z, w: (HALF_W * 2 + 0.2) * S, d: (HALF_D * 2 + 0.2) * S, rot: h.rot,
      door: { x: DOOR_X * S, z: HALF_D * S, half: DOOR_HALF * S, get open() { return h.doorOpen; } },
    }));
  }

  isInside(h, x, z, margin = IN_MARGIN) {
    const l = this._toLocal(h, x, z, _a);
    return Math.abs(l.x) < HALF_W - margin && Math.abs(l.z) < HALF_D - margin;
  }

  /** The house (x, z) is inside, or null. */
  houseAt(x, z) {
    for (const h of this.houses) if (this.isInside(h, x, z)) return h;
    return null;
  }

  /** 0 = ground floor, 1 = upstairs, for feet at world height y in house h. */
  level(h, y) {
    return (y - h.y0) / HOUSE_SCALE > UP_LEVEL ? 1 : 0;
  }

  /** The floor (lights, switch) you're on at (x, feet y, z), or null outdoors. */
  floorAt(x, y, z) {
    const h = this.houseAt(x, z);
    return h ? h.floors[this.level(h, y)] : null;
  }

  /** True if (x, z) is inside or right against any house (keeps spawns out). */
  blocks(x, z, pad = 1.5) {
    for (const h of this.houses) {
      const l = this._toLocal(h, x, z, _a);
      if (Math.abs(l.x) < HALF_W + pad && Math.abs(l.z) < HALF_D + pad) return true;
    }
    return false;
  }

  /**
   * House-local stair surface height at (lx, lz), or null when not over the
   * stairs. lead: read the step that far further up (a body reaches ahead of its centre).
   */
  _stairHeight(lx, lz, lead = 0) {
    if (Math.abs(lz - STAIR_Z) > STAIR_HW + 0.1 || lx < STAIR_X1 - 0.05 || lx > STAIR_X0 + 0.15) return null;
    return THREE.MathUtils.clamp((STAIR_X0 - lx + lead) / (STAIR_X0 - STAIR_X1), 0, 1) * UP_Y;
  }

  /**
   * Height of the floor something standing at (x, feet y, z) walks on: the
   * stairs, the upper floor (when it's already up there) or the ground floor.
   * `ground` is the terrain height there, returned outside every house.
   */
  surfaceAt(x, z, y, ground) {
    for (const h of this.houses) {
      const l = this._toLocal(h, x, z, _a);
      if (Math.abs(l.x) > HALF_W || Math.abs(l.z) > HALF_D) continue;
      const S = HOUSE_SCALE;
      const ly = (y - h.y0) / S;
      // Half a metre of lead, so a monster's body clears the next step and the landing's edge
      const stair = this._stairHeight(l.x, l.z, 0.45);
      if (stair !== null && ly > stair - 1.1) return h.y0 + stair * S;
      const inHole = l.x > HOLE.x0 && l.x < HOLE.x1 && l.z < HOLE.z1;
      if (ly > UP_LEVEL && !inHole) return h.y0 + UP_Y * S;
      return Math.max(ground, h.y0 + 0.1 * S);
    }
    return ground;
  }

  // ── Interaction ─────────────────────────────────────────────────────────────

  /** Nearest door / light switch the player can use from (px, pz) with feet at py. */
  interaction(px, pz, py = 0) {
    let door = null, sw = null, bestD = DOOR_RANGE * DOOR_RANGE;
    for (const h of this.houses) {
      const up = this.level(h, py);
      if (!up) {
        const dx = h.doorWorld.x - px, dz = h.doorWorld.z - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) { bestD = d2; door = h; }
      }
      const f = h.floors[up];
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
    open ? this.sfx?.doorOpen() : this.sfx?.doorClose(dur - t);
    return true;
  }

  /** f: one of h.floors. */
  toggleLight(f) {
    if (!f) return;
    f.lightOn = !f.lightOn;
    f.lever.rotation.x = f.lightOn ? -0.35 : 0.35;
    if (f.lampMat) f.lampMat.emissiveIntensity = f.lightOn ? 2.2 : 0;
    this.sfx?.click();
  }

  // ── Per frame ───────────────────────────────────────────────────────────────

  update(delta, px, pz) {
    for (const h of this.houses) {
      if (h.doorAnim > 0) {
        h.doorAnim -= delta;
        h.mixer.update(delta);
        this._syncDoorBody(h);
      }
    }

    // Give the shared lights to the nearest lit floors (within 60 m)
    let f0 = null, f1 = null, d0 = 3600, d1 = 3600;
    for (const h of this.houses) {
      const d2 = (h.x - px) ** 2 + (h.z - pz) ** 2;
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
    const p = LIGHT_POS[f.index];
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
      const l = this._toLocal(h, x, z, _a);
      if (Math.abs(l.z - HALF_D) > 1.2 || Math.abs(l.x - DOOR_X) > 0.8) continue;
      const lvz = vx * h.sin + vz * h.cos;        // velocity along the door axis
      if (Math.abs(lvz) < 0.8) continue;
      const pull = THREE.MathUtils.clamp((DOOR_X - l.x) * 7, -3, 3) * HOUSE_SCALE;
      out.x = pull * h.cos;
      out.z = -pull * h.sin;
      return true;
    }
    return false;
  }

  // ── Zombie navigation ───────────────────────────────────────────────────────

  /**
   * Picks where a zombie at (zx, zz) should walk to reach the player at
   * (px, pz) given the houses and other solid obstacles. zy / py: feet
   * heights, so monsters take the stairs to whoever is on the other floor.
   *   0 — nothing in the way, chase directly
   *   1 — walk to out.x/out.z (door, doorway, stairs or a corner around an obstacle)
   *   2 — stuck at a closed door (or too big for it): out = door approach point, out.fx/fz = door
   */
  navigate(zx, zz, px, pz, out, big = false, zy = 0, py = 0) {
    for (const h of this.houses) {
      const zl = this._toLocal(h, zx, zz, _zl);
      const pl = this._toLocal(h, px, pz, _pl);
      _box.x = h.x; _box.z = h.z; _box.rot = h.rot;
      const zIn = Math.abs(zl.x) < HALF_W - IN_MARGIN && Math.abs(zl.z) < HALF_D - IN_MARGIN;
      const pIn = Math.abs(pl.x) < HALF_W - IN_MARGIN && Math.abs(pl.z) < HALF_D - IN_MARGIN;

      if (zIn) {
        const zUp = this.level(h, zy) === 1;
        const pUp = pIn && this.level(h, py) === 1;
        // On the stairs: keep going the way the target is
        if (this._stairHeight(zl.x, zl.z) !== null && (zUp || pUp || zl.x < STAIR_X0 - 0.3)) {
          this._toWorld(h, pUp ? STAIR_X1 - 0.9 : STAIR_X0 + 0.9, STAIR_Z, out);
          return 1;
        }
        if (zUp && !pUp) return this._towardStairsTop(h, zl, out);   // come down first
        if (!zUp && pUp) return this._towardStairsBottom(h, zl, out); // go up
        if (zUp && this._aroundStairwell(h, zl, pl, out)) return 1;   // upstairs: not across the opening
        if (pIn) return 0;                                            // same floor
      }

      // In the doorway and lined up with it: keep going straight through
      const aligned = Math.abs(zl.x - DOOR_X) < 0.22;
      const inDoorway = aligned && zl.z > HALF_D - 0.9 && zl.z < HALF_D + 0.9;
      if (zIn !== pIn) {
        out.fx = h.doorWorld.x;
        out.fz = h.doorWorld.z;
        if (!zIn) {
          // Outside, player inside: line up in front of the door, then walk through.
          // Big monsters don't fit: they wait (and pound) at the door.
          const canEnter = h.doorOpen && !big;
          if (canEnter && inDoorway) { this._toWorld(h, DOOR_X, HALF_D - 1.6, out); return 1; }
          const ax = DOOR_X, az = HALF_D + (big ? 1.6 : 1.1);
          const d = Math.hypot(zl.x - ax, zl.z - az);
          if (d < 0.9) {
            if (canEnter && aligned) { this._toWorld(h, DOOR_X, HALF_D - 1.6, out); return 1; }
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
        if (h.doorOpen && inDoorway) { this._toWorld(h, DOOR_X, HALF_D + 1.6, out); return 1; }
        const ax = DOOR_X, az = HALF_D - 1.0;
        const d = Math.hypot(zl.x - ax, zl.z - az);
        if (d < 0.8) {
          if (h.doorOpen && aligned) { this._toWorld(h, DOOR_X, HALF_D + 1.6, out); return 1; }
          this._toWorld(h, ax, az, out);
          return h.doorOpen ? 1 : 2;
        }
        this._toWorld(h, ax, az, out);
        return 1;
      }

      // Both outside this house: walk around it if it's in the way
      if (routeAround(_box, zx, zz, px, pz, out)) return 1;
    }
    for (const o of this.obstacles) {
      if (routeAround(o, zx, zz, px, pz, out)) return 1;
    }
    return 0;
  }

  /** Upstairs: if the straight line to the target crosses the stairwell, a corner round it. */
  _aroundStairwell(h, zl, pl, out) {
    const cx = (HOLE.x0 + HOLE.x1) / 2, cz = (HOLE.z0 + HOLE.z1) / 2;
    const ex = (HOLE.x1 - HOLE.x0) / 2 + 0.35, ez = (HOLE.z1 - HOLE.z0) / 2 + 0.35;
    if (!segHitsRect(zl.x - cx, zl.z - cz, pl.x - cx, pl.z - cz, ex, ez)) return false;
    let best = Infinity, bx = 0, bz = 0;
    for (const x of [HOLE.x0 - 0.6, HOLE.x1 + 0.6]) {
      const z = HOLE.z1 + 0.6;
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
    const ax = STAIR_X0 + 0.9;
    if (Math.hypot(zl.x - ax, zl.z - STAIR_Z) < 0.9) this._toWorld(h, STAIR_X1 - 0.9, STAIR_Z, out);
    else this._toWorld(h, ax, STAIR_Z, out);
    return 1;
  }

  /** Upper floor → round the railing to the top of the stairs, then down them. */
  _towardStairsTop(h, zl, out) {
    const ax = STAIR_X1 - 0.9;
    if (zl.x > ax + 0.5) {
      // Behind the railing: step out in front of it first, then along to the left wall
      if (zl.z < HOLE.z1 + 0.4) this._toWorld(h, zl.x, HOLE.z1 + 0.7, out);
      else this._toWorld(h, ax - 0.1, HOLE.z1 + 0.7, out);
    } else if (Math.hypot(zl.x - ax, zl.z - STAIR_Z) < 0.6) {
      this._toWorld(h, STAIR_X0 + 0.9, STAIR_Z, out);
    } else {
      this._toWorld(h, ax, STAIR_Z, out);
    }
    return 1;
  }
}
