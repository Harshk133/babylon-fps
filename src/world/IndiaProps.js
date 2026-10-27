import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeStaticMeshes } from "./MergeStatic.js";
import { GROUP_WORLD } from "../physicsGroups.js";

// Indian street props from public/models/india/ (see IndiaAssets.js): goods
// trucks parked on the highway and ring-road shoulders, and in every town a
// panchayat office and a town building facing the road. Footprints go on the
// minimap and into monster pathing.
//
// The two buildings can be walked into: the Sketchfab models are closed
// shells, so a doorway is cut into the facade that faces the road and a
// furnished room is built inside (walls, floor, ceiling, lamp, furniture), with
// wall colliders instead of one solid box. IndiaBuildings answers "am I inside"
// and routes monsters through the doorway.
//
// Every copy of a model is one InstancedMesh per material, so six trucks cost
// the draw calls of one. The spots are road-relative and the same for every
// player; a model that's missing is simply left out.

/**
 * kind → target size (metres along its longest horizontal side), how far off
 * the road centreline it stands, and front: the turn that faces the model's
 * entrance toward the road (both building models have theirs on −Z).
 * Sizes follow the real thing next to the 1.8 m soldier: an Indian goods truck
 * is about 8.4 m long and 3.3 m tall.
 */
const KINDS = {
  truck:        { length: 8.4, offset: 5.3, footprint: 5.0, front: 0 },
  panchayat:    { length: 8.2, offset: 12.5, footprint: 6.0, front: Math.PI, enter: "office" },
  townBuilding: { length: 10.5, offset: 13.0, footprint: 7.0, front: Math.PI, enter: "store" },
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

// Enterable buildings (metres)
const DOOR_W    = 1.6;   // doorway width
const DOOR_H    = 2.6;   // doorway height (the tallest walkers fit)
const WALL_T    = 0.22;  // the room's walls sit this far inside the model's
const ROOM_H    = 3.4;   // ceiling height, at most
const FLOOR_Y   = 0.06;  // tiled floor over the flattened ground

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

/**
 * Scales and centres a loaded model: longest horizontal side = length, base on
 * y = 0. Returns { parts: [{ geometry, material }] in that space, size, box }.
 */
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
  const parts = [];
  holder.traverse(o => {
    if (o.isMesh) parts.push({ geometry: floatCopy(o.geometry).applyMatrix4(o.matrixWorld), material: o.material });
  });
  const out = new THREE.Box3();
  for (const p of parts) { p.geometry.computeBoundingBox(); out.union(p.geometry.boundingBox); }
  return { parts, size: out.getSize(new THREE.Vector3()), box: out };
}

/** Non-indexed Float32 copy of position / normal / uv (meshopt output is quantized). */
function floatCopy(src) {
  const g = new THREE.BufferGeometry();
  const n = src.index ? src.index.count : src.attributes.position.count;
  for (const name of ["position", "normal", "uv"]) {
    const a = src.attributes[name];
    if (!a) continue;
    const size = a.itemSize, arr = new Float32Array(n * size);
    for (let i = 0; i < n; i++) {
      const v = src.index ? src.index.getX(i) : i;
      for (let k = 0; k < size; k++) arr[i * size + k] = a.getComponent(v, k);
    }
    g.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

// ─── Doorway cut ────────────────────────────────────────────────────────────

/**
 * The model's main wall planes: for each side, the plane (facing out) with the
 * most triangle area. { front (−Z), back (+Z), left (−X), right (+X), top } in
 * template space; top = highest point of the front wall.
 */
function wallPlanes(parts, box) {
  const dirs = { front: [2, -1], back: [2, 1], left: [0, -1], right: [0, 1] };
  const bins = { front: new Map(), back: new Map(), left: new Map(), right: new Map() };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  let top = 0;
  for (const { geometry } of parts) {
    const p = geometry.attributes.position;
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
      n.subVectors(c, b).cross(a.clone().sub(b));
      const area = n.length() / 2;
      if (area < 1e-4) continue;
      n.normalize();
      for (const side in dirs) {
        const [axis, sign] = dirs[side];
        if (n.getComponent(axis) * sign < 0.95) continue;
        const at = (a.getComponent(axis) + b.getComponent(axis) + c.getComponent(axis)) / 3;
        const key = Math.round(at * 20) / 20;
        bins[side].set(key, (bins[side].get(key) ?? 0) + area);
        if (side === "front") top = Math.max(top, a.y, b.y, c.y);
      }
    }
  }
  const pick = (side, fallback) => {
    let best = fallback, area = 0;
    for (const [k, v] of bins[side]) if (v > area) { area = v; best = k; }
    return best;
  };
  return {
    front: pick("front", box.min.z * 0.9), back: pick("back", box.max.z * 0.9),
    left: pick("left", box.min.x * 0.9), right: pick("right", box.max.x * 0.9),
    top: top || box.max.y * 0.9,
  };
}

/**
 * Height of a raised plinth / veranda floor the model stands on (the biggest
 * upward face between 8 and 90 cm), or 0. The building is sunk by this much,
 * so its floor is level with the ground and nobody has to climb onto it.
 */
function plinthHeight(parts, box) {
  const bins = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const { geometry } of parts) {
    const p = geometry.attributes.position;
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
      n.subVectors(c, b).cross(a.clone().sub(b));
      const area = n.length() / 2;
      if (area < 1e-4 || n.y / (area * 2) < 0.95) continue;
      const y = (a.y + b.y + c.y) / 3;
      if (y < box.min.y + 0.08 || y > box.min.y + 0.9) continue;
      const key = Math.round(y * 50) / 50;
      bins.set(key, (bins.get(key) ?? 0) + area);
    }
  }
  const footprint = (box.max.x - box.min.x) * (box.max.z - box.min.z);
  let best = 0, area = 0;
  for (const [k, v] of bins) if (v > area) { area = v; best = k; }
  return area > footprint * 0.15 ? best - box.min.y : 0;
}

/**
 * A doorway the model already has in its front wall: a pair of jamb faces
 * (one facing +X, one −X, 0.8–3 m apart) reaching the ground near the front
 * plane. Returns { x, w, h, existing: true } or null.
 */
function findDoorway(parts, front) {
  const jambs = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const { geometry } of parts) {
    const p = geometry.attributes.position;
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
      n.subVectors(c, b).cross(a.clone().sub(b));
      if (n.length() < 1e-4) continue;
      n.normalize();
      if (Math.abs(n.x) < 0.95) continue;
      const cz = (a.z + b.z + c.z) / 3;
      const minY = Math.min(a.y, b.y, c.y), maxY = Math.max(a.y, b.y, c.y);
      if (cz < front - 0.15 || cz > front + 0.9 || minY > 0.4 || maxY - minY < 1.6) continue;
      jambs.push({ x: (a.x + b.x + c.x) / 3, sign: Math.sign(n.x), h: maxY });
    }
  }
  let best = null;
  for (const l of jambs) {
    if (l.sign < 0) continue;
    for (const r of jambs) {
      const w = r.x - l.x;
      if (r.sign > 0 || w < 0.8 || w > 3) continue;
      if (!best || w < best.w) best = { x: (l.x + r.x) / 2, w, h: Math.min(l.h, r.h), existing: true };
    }
  }
  return best;
}

/** Sutherland–Hodgman: keeps the part of poly (arrays of vertex records) where value(v) >= 0. */
function clipPoly(poly, value) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const vp = value(p), vq = value(q);
    if (vp >= 0) out.push(p);
    if ((vp >= 0) !== (vq >= 0)) {
      const t = vp / (vp - vq);
      out.push(p.map((x, k) => x + (q[k] - x) * t));
    }
  }
  return out;
}

/**
 * Cuts the doorway (door: { x, w, h }) out of every wall face near the front
 * plane. Vertex records are [px, py, pz, nx, ny, nz, u, v].
 */
function cutDoorway(geometry, front, door = { x: 0, w: DOOR_W, h: DOOR_H }) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal, uv = geometry.attributes.uv;
  const x0 = door.x - door.w / 2, x1 = door.x + door.w / 2, doorH = door.h;
  const out = [];
  const emit = poly => {
    for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1]);
  };
  for (let i = 0; i < pos.count; i += 3) {
    const tri = [i, i + 1, i + 2].map(v => [
      pos.getX(v), pos.getY(v), pos.getZ(v), nor.getX(v), nor.getY(v), nor.getZ(v),
      uv ? uv.getX(v) : 0, uv ? uv.getY(v) : 0,
    ]);
    const cz = (tri[0][2] + tri[1][2] + tri[2][2]) / 3;
    const facing = Math.abs(tri[0][5] + tri[1][5] + tri[2][5]) / 3 > 0.8;
    const minX = Math.min(tri[0][0], tri[1][0], tri[2][0]), maxX = Math.max(tri[0][0], tri[1][0], tri[2][0]);
    const minY = Math.min(tri[0][1], tri[1][1], tri[2][1]);
    if (!facing || Math.abs(cz - front) > 0.8 || maxX <= x0 || minX >= x1 || minY >= doorH) { emit(tri); continue; }
    // Left of the doorway, right of it, and above it
    emit(clipPoly(tri, v => x0 - v[0]));
    emit(clipPoly(tri, v => v[0] - x1));
    emit(clipPoly(clipPoly(clipPoly(tri, v => v[0] - x0), v => x1 - v[0]), v => v[1] - doorH));
  }
  const g = new THREE.BufferGeometry();
  const arr = (off, n) => {
    const a = new Float32Array(out.length * n);
    out.forEach((v, j) => { for (let k = 0; k < n; k++) a[j * n + k] = v[off + k]; });
    return new THREE.BufferAttribute(a, n);
  };
  g.setAttribute("position", arr(0, 3));
  g.setAttribute("normal", arr(3, 3));
  if (uv) g.setAttribute("uv", arr(6, 2));
  return g;
}

// ─── Interior ───────────────────────────────────────────────────────────────

const ROOM_MATS = {
  plaster: new THREE.MeshStandardMaterial({ color: 0xe9dfc8, roughness: 0.92 }),
  floor:   new THREE.MeshStandardMaterial({ color: 0xa48d72, roughness: 0.7 }),
  trim:    new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.8 }),
  wood:    new THREE.MeshStandardMaterial({ color: 0x7a5232, roughness: 0.75 }),
  metal:   new THREE.MeshStandardMaterial({ color: 0x4f6470, roughness: 0.5, metalness: 0.4 }),
  cloth:   new THREE.MeshStandardMaterial({ color: 0x2f6f5e, roughness: 0.95 }),
  lamp:    new THREE.MeshStandardMaterial({ color: 0xfff6dc, emissive: 0xfff1c8, emissiveIntensity: 1.6 }),
};

/**
 * The room inside a building, in template space: boxes per material (merged
 * later), solid boxes for physics, and loot spots. Furniture depends on the
 * kind: a panchayat office (desk, chairs, benches, almirah) or a store
 * (counter, shelves, sacks).
 */
function buildRoom(planes, kind, door) {
  const x0 = planes.left + WALL_T, x1 = planes.right - WALL_T;
  const z0 = planes.front + WALL_T, z1 = planes.back - WALL_T;
  const top = Math.max(door.h + 0.4, Math.min(ROOM_H, planes.top - 0.25));
  const boxes = { plaster: [], floor: [], trim: [], wood: [], metal: [], cloth: [], lamp: [] };
  const solids = [];   // [cx, cy, cz, hx, hy, hz]
  const loot = [];     // [x, y, z]
  const add = (mat, xa, xb, ya, yb, za, zb, solid = false) => {
    boxes[mat].push(new THREE.BoxGeometry(xb - xa, yb - ya, zb - za).translate((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2));
    if (solid) solids.push([(xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2, (xb - xa) / 2, (yb - ya) / 2, (zb - za) / 2]);
  };
  const t = 0.06, dl = door.x - door.w / 2, dr = door.x + door.w / 2, doorH = door.h;
  // Shell: floor, ceiling, four walls (the front one round the doorway), skirting
  add("floor", x0, x1, 0, FLOOR_Y, z0, z1);
  add("plaster", x0, x1, top, top + t, z0, z1);
  add("plaster", x0 - t, x0, 0, top, z0, z1);
  add("plaster", x1, x1 + t, 0, top, z0, z1);
  add("plaster", x0, x1, 0, top, z1, z1 + t);
  add("plaster", x0, dl, 0, top, z0 - t, z0);
  add("plaster", dr, x1, 0, top, z0 - t, z0);
  add("plaster", dl, dr, doorH, top, z0 - t, z0);
  add("trim", x0, x1, FLOOR_Y, 0.16, z1 - 0.03, z1);
  add("trim", x0, x0 + 0.03, FLOOR_Y, 0.16, z0, z1);
  add("trim", x1 - 0.03, x1, FLOOR_Y, 0.16, z0, z1);
  // Doorway reveal through the wall, with a wooden frame
  const zo = planes.front - 0.03;
  add("trim", dl - 0.12, dl, 0, doorH + 0.12, zo, z0);
  add("trim", dr, dr + 0.12, 0, doorH + 0.12, zo, z0);
  add("trim", dl - 0.12, dr + 0.12, doorH, doorH + 0.12, zo, z0);
  // Ceiling lamp (a tube light) and a fan
  add("lamp", -0.6, 0.6, top - 0.05, top, (z0 + z1) / 2 - 0.05, (z0 + z1) / 2 + 0.05);
  add("metal", -0.05, 0.05, top - 0.45, top, (z0 + z1) / 2 + 0.9, (z0 + z1) / 2 + 1.0);
  add("metal", -0.7, 0.7, top - 0.48, top - 0.45, (z0 + z1) / 2 + 0.88, (z0 + z1) / 2 + 1.02);
  add("metal", -0.07, 0.07, top - 0.48, top - 0.45, (z0 + z1) / 2 + 0.25, (z0 + z1) / 2 + 1.65);

  const d = z1 - z0;
  if (kind === "office") {
    // Sarpanch's desk at the back, chairs, a bench each side, a steel almirah
    const dz = z1 - 1.5;
    add("wood", -1.1, 1.1, 0.72, 0.78, dz - 0.45, dz + 0.45, true);
    for (const lx of [-1.0, 1.0]) add("wood", lx - 0.05, lx + 0.05, FLOOR_Y, 0.72, dz - 0.4, dz + 0.4);
    add("wood", -0.3, 0.3, FLOOR_Y, 0.48, dz + 0.65, dz + 1.05, true);
    add("wood", -0.3, 0.3, 0.48, 1.1, dz + 1.0, dz + 1.06);
    for (const lx of [-0.7, 0.7]) add("wood", lx - 0.25, lx + 0.25, FLOOR_Y, 0.46, dz - 1.05, dz - 0.65, true);
    for (const side of [-1, 1]) {
      const bx = side < 0 ? x0 + 0.3 : x1 - 0.3;
      add("wood", bx - 0.22, bx + 0.22, 0.4, 0.46, z0 + 1.0, z0 + Math.min(3.4, d - 2.6), true);
    }
    add("metal", x1 - 0.55, x1 - 0.02, FLOOR_Y, 1.9, z1 - 0.02 - 1.0, z1 - 0.02, true);
    add("cloth", -1.3, 1.3, top - 1.6, top - 0.6, z1 - 0.02, z1);  // notice board
    loot.push([0.5, 0.78, dz], [x0 + 0.8, FLOOR_Y, z0 + d * 0.55], [x1 - 0.9, FLOOR_Y, z0 + 1.0], [-0.8, FLOOR_Y, dz - 1.6]);
  } else {
    // Kirana store: a counter across the room, shelves on three walls, sacks of grain
    const cz = z0 + d * 0.45;
    // ...beside the way in, so the doorway leads straight into the shop
    const ce = Math.min(dl - 0.4, x1 - 2.4);
    if (ce - x0 > 1.6) {
      add("wood", x0 + 0.6, ce, FLOOR_Y, 0.95, cz - 0.3, cz + 0.3, true);
      add("trim", x0 + 0.55, ce + 0.05, 0.95, 1.0, cz - 0.33, cz + 0.33);
    }
    for (const [xa, xb, za, zb] of [[x0, x1, z1 - 0.45, z1], [x0, x0 + 0.45, z0 + 0.5, z1 - 0.45], [x1 - 0.45, x1, cz + 0.6, z1 - 0.45]]) {
      for (const sy of [0.5, 1.1, 1.7]) add("wood", xa, xb, sy, sy + 0.04, za, zb);
      add("wood", xa, xb, FLOOR_Y, 2.1, (za + zb) / 2 - 0.01, (za + zb) / 2 + 0.01, true);
    }
    for (const [sx, sz] of [[x1 - 0.6, z0 + 0.7], [x1 - 1.3, z0 + 0.7], [x1 - 0.95, z0 + 1.35]]) {
      add("cloth", sx - 0.28, sx + 0.28, FLOOR_Y, 0.62, sz - 0.22, sz + 0.22, true);
    }
    loot.push([x0 + 1.0, 0.95, cz], [x0 + 1.4, FLOOR_Y, z1 - 1.2], [x1 - 1.2, FLOOR_Y, z1 - 1.0], [x0 + 1.2, FLOOR_Y, z0 + 0.9]);
  }
  const geos = {};
  for (const [mat, list] of Object.entries(boxes)) if (list.length) geos[mat] = mergeBoxes(list);
  return { geos, solids, loot, room: { x0, x1, z0, z1, top } };
}

/** Merges BoxGeometries (position, normal, uv; indexed) into one. */
function mergeBoxes(list) {
  let verts = 0, idx = 0;
  for (const g of list) { verts += g.attributes.position.count; idx += g.index.count; }
  const pos = new Float32Array(verts * 3), nor = new Float32Array(verts * 3), uv = new Float32Array(verts * 2), ind = new Uint32Array(idx);
  let vo = 0, io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    const ia = g.index.array;
    for (let k = 0; k < ia.length; k++) ind[io + k] = ia[k] + vo;
    vo += g.attributes.position.count;
    io += ia.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(ind, 1));
  return out;
}

// ─── Placement ──────────────────────────────────────────────────────────────

/**
 * Places every spot whose model is loaded. models: { truck, panchayat,
 * townBuilding } (THREE.Group | null). groundAt(x, z): the terrain.
 * Returns the IndiaBuildings (the enterable ones).
 */
export function placeIndiaProps({ scene, world, material, models, spots, groundAt, mapObstacles, navObstacles }) {
  const byKind = new Map();
  for (const s of spots) {
    if (!models[s.kind]) continue;
    if (!byKind.has(s.kind)) byKind.set(s.kind, []);
    byKind.get(s.kind).push(s);
  }
  const buildings = new IndiaBuildings();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const instance = (geometry, mat, placed, shadow) => {
    const inst = new THREE.InstancedMesh(geometry, mat, placed.length);
    placed.forEach((s, i) => inst.setMatrixAt(i, s.matrix));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = shadow;
    inst.receiveShadow = true;
    inst.computeBoundingSphere();
    inst.matrixAutoUpdate = false;
    scene.add(inst);
  };
  for (const [kind, list] of byKind) {
    const k = KINDS[kind];
    const { parts, size, box } = prepare(models[kind], k.length);
    // A building on a plinth is sunk so its floor is the ground (a hair above, so the terrain doesn't show through)
    const lift = k.enter ? plinthHeight(parts, box) : 0;
    const placed = list.map(s => {
      const y = groundAt(s.x, s.z) + (lift > 0 ? 0.03 : -0.05);
      return { ...s, y, yaw: s.rot + s.front, matrix: new THREE.Matrix4().compose(p.set(s.x, y, s.z), q.setFromAxisAngle(up, s.rot + s.front), one) };
    });

    if (!k.enter) {
      for (const part of parts) instance(part.geometry, part.material, placed, true);
      // Physics: one box each (the trucks' a little narrower than their mirrors)
      const hx = size.x / 2 * 0.9, hy = size.y / 2, hz = size.z / 2;
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
      continue;
    }

    // Enterable: the model's own doorway or one cut into the facade, a room inside, wall colliders
    if (lift > 0) {
      for (const part of parts) part.geometry.translate(0, -lift, 0);
      box.min.y -= lift;
      box.max.y -= lift;
    }
    const planes = wallPlanes(parts, box);
    const door = findDoorway(parts, planes.front) ?? { x: 0, w: DOOR_W, h: DOOR_H, existing: false };
    door.h = Math.min(door.h, DOOR_H + 0.4);
    for (const part of parts) {
      instance(door.existing ? part.geometry : cutDoorway(part.geometry, planes.front, door), part.material, placed, true);
    }
    const room = buildRoom(planes, k.enter, door);
    for (const [mat, geo] of Object.entries(room.geos)) instance(geo, ROOM_MATS[mat], placed, false);

    const wallTop = Math.max(planes.top, room.room.top + 0.3);
    const { x0, x1, z0, z1 } = room.room;
    const fz = planes.front - 0.05;
    const walls = [
      [planes.left - 0.05, x0, z0 - WALL_T, z1 + WALL_T, 0, wallTop],
      [x1, planes.right + 0.05, z0 - WALL_T, z1 + WALL_T, 0, wallTop],
      [x0, x1, z1, planes.back + 0.05, 0, wallTop],
      [x0 - WALL_T, door.x - door.w / 2, fz, z0, 0, wallTop],
      [door.x + door.w / 2, x1 + WALL_T, fz, z0, 0, wallTop],
      [door.x - door.w / 2, door.x + door.w / 2, fz, z0, door.h, wallTop],
      [planes.left, planes.right, planes.front, planes.back, wallTop, wallTop + 0.3],   // roof
    ].map(([xa, xb, za, zb, ya, yb]) => [(xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2, (xb - xa) / 2, (yb - ya) / 2, (zb - za) / 2]);
    const hx = size.x / 2, hz = size.z / 2;
    for (const s of placed) {
      const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
      for (const [cx, cy, cz, ex, ey, ez] of [...walls, ...room.solids]) {
        body.addShape(new CANNON.Box(new CANNON.Vec3(ex, ey, ez)), new CANNON.Vec3(cx, cy, cz));
      }
      body.position.set(s.x, s.y, s.z);
      body.quaternion.setFromEuler(0, s.yaw, 0);
      world.addBody(body);
      // Vehicles and the minimap still see the whole footprint; monsters path through the doorway (IndiaBuildings)
      const o = { type: "box", x: s.x, z: s.z, rot: s.rot, w: hx * 2, d: hz * 2, hw: hx, hd: hz, prop: kind };
      mapObstacles.push(o);
      navObstacles.push(o);
      buildings.add(s, kind, room, planes, box, o, door);
    }
  }
  return buildings;
}

// ─── Inside / pathing ───────────────────────────────────────────────────────

const _l = { x: 0, z: 0 };

/**
 * The enterable buildings, for gameplay: inside(x, z), loot spots, spawn
 * blocking and monster pathing through the doorway.
 */
export class IndiaBuildings {
  constructor() {
    this.list = [];
    this.lootSpots = [];   // [{ x, y, z }]
  }

  add(s, kind, room, planes, box, obstacle, door) {
    const b = {
      kind, x: s.x, z: s.z, y: s.y, cos: Math.cos(s.yaw), sin: Math.sin(s.yaw), obstacle,
      ...room.room, radius: Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2 + 1,
    };
    // Door approach points: outside clear of the eaves, and just in
    const outZ = Math.min(planes.front, box.min.z) - 1.2;
    b.doorOut = this._toWorld(b, door.x, outZ, {});
    b.doorIn = this._toWorld(b, door.x, room.room.z0 + 1.0, {});
    b.frontZ = planes.front;
    b.doorX = door.x;
    b.doorW = door.w;
    this.list.push(b);
    for (const [lx, ly, lz] of room.loot) {
      const w = this._toWorld(b, lx, lz, {});
      this.lootSpots.push({ x: w.x, y: s.y + ly, z: w.z });
    }
  }

  _toLocal(b, x, z, out = _l) {
    const dx = x - b.x, dz = z - b.z;
    out.x = dx * b.cos - dz * b.sin;
    out.z = dx * b.sin + dz * b.cos;
    return out;
  }

  _toWorld(b, lx, lz, out) {
    out.x = b.x + lx * b.cos + lz * b.sin;
    out.z = b.z - lx * b.sin + lz * b.cos;
    return out;
  }

  /** The building (x, z) is inside, or null. */
  inside(x, z, margin = 0) {
    for (const b of this.list) {
      if (Math.abs(x - b.x) > b.radius || Math.abs(z - b.z) > b.radius) continue;
      const l = this._toLocal(b, x, z);
      if (l.x > b.x0 + margin && l.x < b.x1 - margin && l.z > b.z0 + margin && l.z < b.z1 - margin) return b;
    }
    return null;
  }

  /** True near or on a building's footprint (no monster spawns). */
  blocks(x, z, pad = 1.5) {
    for (const b of this.list) if (Math.hypot(x - b.x, z - b.z) < b.radius + pad) return true;
    return false;
  }

  /**
   * Monster pathing when it or its target is inside a building: through the
   * doorway. Returns -1 when no building is involved (the other pathing runs),
   * else as Houses.navigate (0 direct, 1 walk to out). outside(ax, az, bx, bz,
   * out): pathing for the leg in the open (round other buildings).
   */
  navigate(zx, zz, tx, tz, out, big, outside) {
    if (!this.list.length) return -1;
    const mb = this.inside(zx, zz, -0.3), tb = this.inside(tx, tz, -0.3);
    if (!mb && !tb) return -1;
    if (mb === tb) return 0;
    if (mb) {
      // Leaving: to the doorway, then out
      const l = this._toLocal(mb, zx, zz);
      const p = Math.abs(l.x - mb.doorX) < mb.doorW / 2 && l.z < mb.z0 + 0.9 ? mb.doorOut : mb.doorIn;
      out.x = p.x; out.z = p.z;
      return 1;
    }
    // Coming in: to the door from outside (round the building), then through it
    const l = this._toLocal(tb, zx, zz);
    const inLine = Math.abs(l.x - tb.doorX) < tb.doorW / 2 - 0.15 && l.z < tb.z0 + 0.5 && l.z > tb.frontZ - 2.2;
    if (big) { out.x = tb.doorOut.x; out.z = tb.doorOut.z; return 1; } // too big for the doorway: wait outside
    if (inLine) { out.x = tb.doorIn.x; out.z = tb.doorIn.z; return 1; }
    const p = tb.doorOut;
    if (Math.hypot(zx - p.x, zz - p.z) < 0.9) { out.x = tb.doorIn.x; out.z = tb.doorIn.z; return 1; }
    // Round the building itself (and anything else) to the door approach point
    const r = outside(zx, zz, p.x, p.z, out);
    if (r === 0) { out.x = p.x; out.z = p.z; }
    return r === 2 ? 2 : 1;
  }
}
