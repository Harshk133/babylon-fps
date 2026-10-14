import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GROUP_WORLD, GROUP_GLASS } from "../physicsGroups.js";

// Enterable houses assembled from Kenney's CC0 Building Kit + Furniture Kit
// (public/models/house/house-kit.glb, built by `npm run build-house-kit`).
//
// Every house shares one layout: the static pieces are merged into a few
// meshes once (one draw call per material) and reused by every house. Each
// house then gets its own animated door (the kit's open/close clips) with a
// kinematic collider, a light switch, ceiling lamps, and a compound physics
// body with a box per wall section, so walls, windows and furniture block the
// player and zombies like real walls.
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
const SWITCH_POS = new THREE.Vector3(0.27, 1.3, HALF_D - 0.11);
const LIGHT_POS  = new THREE.Vector3(-0.5, 2.0, -0.4);
const DOOR_RANGE   = 2.3;
const SWITCH_RANGE = 1.7;
const HOUSE_LIGHTS = 2;                 // shared point lights, given to the nearest lit houses
const IN_MARGIN  = 0.05;

const R90 = Math.PI / 2;

// [piece, x, z, rotY]. Walls spanning X are rotated 90°. The doorway is turned
// −90° so the kit's door swings into the house.
const WALLS = [
  ["wall-window-square", -3, HALF_D, R90], ["wall", -1, HALF_D, R90],
  ["wall-doorway-square", DOOR_X, HALF_D, -R90], ["wall-window-square", 3, HALF_D, R90],
  ["wall", -3, -HALF_D, R90], ["wall-window-square", -1, -HALF_D, R90],
  ["wall-window-square", 1, -HALF_D, R90], ["wall", 3, -HALF_D, R90],
  ["wall", -HALF_W, -2, 0], ["wall-window-square", -HALF_W, 0, 0], ["wall", -HALF_W, 2, 0],
  ["wall-window-square", HALF_W, -2, 0], ["wall", HALF_W, 0, 0], ["wall", HALF_W, 2, 0],
];

// [piece, x, z, rotY, { y, collide }]  — "front" of each piece faces +Z at rotY 0
const FURNITURE = [
  ["bedSingle", -3.3, -1.85, 0],
  ["sideTable", -2.1, -2.62, 0],
  ["lampRoundFloor", -1.35, -2.6, 0, { collide: false }],
  ["kitchenFridge", 3.45, -2.6, 0],
  ["kitchenStove", 2.57, -2.45, 0],
  ["kitchenCabinet", 1.75, -2.45, 0],
  ["table", 2.3, -0.5, 0],
  ["chair", 1.9, 0.25, Math.PI], ["chair", 2.7, 0.25, Math.PI],
  ["chair", 1.9, -1.25, 0], ["chair", 2.7, -1.25, 0],
  ["bookcaseOpen", 3.62, 1.6, -R90],
  ["loungeSofa", -3.5, 1.3, R90],
  ["rugRectangle", -2.3, 1.3, R90, { collide: false }],
  ["tableCoffee", -2.35, 1.3, R90],
  ["cabinetTelevision", -0.9, 1.3, -R90],
  ["televisionModern", -0.9, 1.3, -R90, { y: 0.58, collide: false }],
  ["pottedPlant", -0.3, 2.55, 0],
  ["cardboardBoxClosed", 3.45, 2.55, 0], ["cardboardBoxClosed", 3.45, 2.1, 0.3],
  ["cardboardBoxClosed", 3.0, 2.6, -0.2],
];
const CEILING_LAMPS = [[-0.5, -0.4], [-2.6, -1.6], [2.3, -0.5]];

// Interior spots for loot (house-local)
export const HOUSE_LOOT_SPOTS = [[-1.4, -1.0], [0.6, -1.6], [-1.6, 2.4]];

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
    const boxes = [];   // solid colliders: { x, y, z, hx, hy, hz, rot }
    const glass = [];   // window panes: block bodies, not bullets or grenades

    // A box in a wall piece's frame (span along local Z, thickness along X)
    const wallBox = (px, pz, rot, z0, z1, y0, y1, list = boxes) => {
      const cz = (z0 + z1) / 2;
      list.push({
        x: px + cz * Math.sin(rot), y: (y0 + y1) / 2 - SINK, z: pz + cz * Math.cos(rot),
        hx: COLLIDER_T / 2, hy: (y1 - y0) / 2, hz: (z1 - z0) / 2, rot,
      });
    };

    for (const [piece, x, z, rot] of WALLS) {
      const o = this.pieces[`b_${piece}`].clone(true);
      o.position.set(x, 0, z);
      o.rotation.y = rot;
      layout.add(o);
      const H = WALL_H + 0.1;
      if (piece === "wall") {
        wallBox(x, z, rot, -1, 1, 0, H);
      } else if (piece === "wall-doorway-square") {
        wallBox(x, z, rot, -1, -DOOR_HALF, 0, H);
        wallBox(x, z, rot, DOOR_HALF, 1, 0, H);
        wallBox(x, z, rot, -DOOR_HALF, DOOR_HALF, DOOR_H, H);
      } else {
        wallBox(x, z, rot, -1, -DOOR_HALF, 0, H);
        wallBox(x, z, rot, DOOR_HALF, 1, 0, H);
        wallBox(x, z, rot, -DOOR_HALF, DOOR_HALF, 0, WIN_Y0);
        wallBox(x, z, rot, -DOOR_HALF, DOOR_HALF, WIN_Y1, H);
        wallBox(x, z, rot, -DOOR_HALF, DOOR_HALF, WIN_Y0, WIN_Y1, glass);
      }
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const o = this.pieces["b_column"].clone(true);
      o.position.set(sx * HALF_W, 0, sz * HALF_D);
      layout.add(o);
    }
    for (let ix = -1.5; ix <= 1.5; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const x = ix * SEG, z = iz * SEG;
        const floor = this.pieces["b_floor"].clone(true);
        floor.position.set(x, 0, z);
        layout.add(floor);
        // Roof: lipped pieces around the edge, flat ones inside
        const edgeX = Math.abs(ix) === 1.5 ? Math.sign(ix) : 0;
        const edgeZ = Math.abs(iz) === 1 ? Math.sign(iz) : 0;
        let name = "b_roof-flat-center", rot = 0;
        if (edgeX && edgeZ) {
          name = "b_roof-flat-corner";
          rot = edgeX > 0 ? (edgeZ > 0 ? 0 : R90) : (edgeZ > 0 ? -R90 : Math.PI);
        } else if (edgeX || edgeZ) {
          name = "b_roof-flat-side";
          rot = edgeX > 0 ? 0 : edgeX < 0 ? Math.PI : edgeZ > 0 ? -R90 : R90;
        }
        const roof = this.pieces[name].clone(true);
        roof.position.set(x, WALL_H, z);
        roof.rotation.y = rot;
        layout.add(roof);
      }
    }
    boxes.push({ x: 0, y: WALL_H + 0.08 - SINK, z: 0, hx: HALF_W + 0.25, hy: 0.12, hz: HALF_D + 0.25, rot: 0 });

    for (const [name, x, z, rot, opts = {}] of FURNITURE) {
      const { wrap, size } = this._furnitureTemplate(name);
      const y = opts.y ?? 0;
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
      const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
      for (const key of Object.keys(g.attributes)) {
        if (!["position", "normal", "uv"].includes(key)) g.deleteAttribute(key);
      }
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

    // Ceiling lamps: separate so each house can light its own bulbs
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

    // Per-house lamp material so lights switch independently
    let lampMat = null;
    const lampsOn = [];
    for (const [lx, lz] of CEILING_LAMPS) {
      const lamp = this.lampTemplate.clone(true);
      lamp.position.set(lx, WALL_H - this.lampHeight, lz);
      lamp.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = false;
        if (o.material.name === "lamp") {
          lampMat ??= o.material.clone();
          o.material = lampMat;
        }
      });
      root.add(lamp);
      lampsOn.push(lamp);
    }
    if (lampMat) { lampMat.emissive = new THREE.Color(0xffd27a); lampMat.emissiveIntensity = 0; }

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

    // Light switch with an animated rocker
    const sw = new THREE.Group();
    sw.position.copy(SWITCH_POS);
    sw.rotation.y = Math.PI;
    sw.add(new THREE.Mesh(this.switchPlateGeo, this.switchPlateMat));
    const lever = new THREE.Mesh(this.switchLeverGeo, this.switchLeverMat);
    lever.rotation.x = 0.35;
    sw.add(lever);
    root.add(sw);

    this.scene.add(root);
    root.updateMatrixWorld(true);
    // Everything but the door leaf and the switch rocker is static
    root.traverse(o => { o.matrixAutoUpdate = false; });
    door.traverse(o => { o.matrixAutoUpdate = true; });
    lever.matrixAutoUpdate = true;

    // Physics: walls + roof + furniture in one compound static body
    const q = new CANNON.Quaternion().setFromEuler(0, rotY, 0);
    const body = new CANNON.Body({ mass: 0, material: this.material, collisionFilterGroup: GROUP_WORLD });
    const glassBody = new CANNON.Body({ mass: 0, material: this.material, collisionFilterGroup: GROUP_GLASS });
    for (const [list, b] of [[this.colliderBoxes, body], [this.glassBoxes, glassBody]]) {
      for (const c of list) {
        b.addShape(
          new CANNON.Box(new CANNON.Vec3(c.hx * S, c.hy * S, c.hz * S)),
          new CANNON.Vec3(c.x * S, c.y * S, c.z * S),
          new CANNON.Quaternion().setFromEuler(0, c.rot, 0));
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
      x, z, rot: rotY, cos: Math.cos(rotY), sin: Math.sin(rotY),
      hw: HALF_W, hd: HALF_D,
      root, door, panel, mixer, openAction, closeAction, doorBody,
      doorOpen: false, doorAnim: 0,
      lever, lampMat, lightOn: false, light: null,
      switchWorld: new THREE.Vector3(), doorWorld: new THREE.Vector3(),
    };
    this._toWorld(h, DOOR_X, HALF_D, h.doorWorld);
    this._toWorld(h, SWITCH_POS.x, SWITCH_POS.z, h.switchWorld);
    h.switchWorld.y = SWITCH_POS.y * S;
    this._syncDoorBody(h);
    this.houses.push(h);
    return h;
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

  /** True if (x, z) is inside or right against any house (keeps spawns out). */
  blocks(x, z, pad = 1.5) {
    for (const h of this.houses) {
      const l = this._toLocal(h, x, z, _a);
      if (Math.abs(l.x) < HALF_W + pad && Math.abs(l.z) < HALF_D + pad) return true;
    }
    return false;
  }

  // ── Interaction ─────────────────────────────────────────────────────────────

  /** Nearest door / light switch the player can use from (px, pz). */
  interaction(px, pz) {
    let door = null, sw = null, bestD = DOOR_RANGE * DOOR_RANGE;
    for (const h of this.houses) {
      const dx = h.doorWorld.x - px, dz = h.doorWorld.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) { bestD = d2; door = h; }
      const sx = h.switchWorld.x - px, sz = h.switchWorld.z - pz;
      if (sx * sx + sz * sz < SWITCH_RANGE * SWITCH_RANGE && this.isInside(h, px, pz, -0.2)) sw = h;
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

  toggleLight(h) {
    if (!h) return;
    h.lightOn = !h.lightOn;
    h.lever.rotation.x = h.lightOn ? -0.35 : 0.35;
    if (h.lampMat) h.lampMat.emissiveIntensity = h.lightOn ? 2.2 : 0;
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

    // Give the shared lights to the two nearest lit houses (within 60 m)
    let h0 = null, h1 = null, d0 = 3600, d1 = 3600;
    for (const h of this.houses) {
      if (!h.lightOn) continue;
      const d2 = (h.x - px) ** 2 + (h.z - pz) ** 2;
      if (d2 < d0) { h1 = h0; d1 = d0; h0 = h; d0 = d2; }
      else if (d2 < d1) { h1 = h; d1 = d2; }
    }
    this._assignLight(this.lights[0], h0);
    this._assignLight(this.lights[1], h1);
  }

  _assignLight(l, h) {
    if (!l) return;
    if (!h) { l.intensity = 0; return; }
    this._toWorld(h, LIGHT_POS.x, LIGHT_POS.z, l.position);
    l.position.y = LIGHT_POS.y * HOUSE_SCALE;
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
   * (px, pz) given the houses and other solid obstacles.
   *   0 — nothing in the way, chase directly
   *   1 — walk to out.x/out.z (door, doorway or a corner around an obstacle)
   *   2 — stuck at a closed door (or too big for it): out = door approach point, out.fx/fz = door
   */
  navigate(zx, zz, px, pz, out, big = false) {
    for (const h of this.houses) {
      const zl = this._toLocal(h, zx, zz, _zl);
      const pl = this._toLocal(h, px, pz, _pl);
      _box.x = h.x; _box.z = h.z; _box.rot = h.rot;
      const zIn = Math.abs(zl.x) < HALF_W - IN_MARGIN && Math.abs(zl.z) < HALF_D - IN_MARGIN;
      const pIn = Math.abs(pl.x) < HALF_W - IN_MARGIN && Math.abs(pl.z) < HALF_D - IN_MARGIN;
      if (zIn && pIn) return 0;

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
}
