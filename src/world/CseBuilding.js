import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GROUP_WORLD, GROUP_ZOMBIE } from "../physicsGroups.js";
import { mergeStaticMeshes, toFloatGeometry } from "./MergeStatic.js";

// The CSE building (public/models/cse_building.glb, optimized copy loaded
// first): a three-storey classroom block round a covered atrium with a
// badminton court, on its own campus west of the North Road, north of
// Ravencross. The model is in metres with its main entrance on +Z, which is
// turned toward the road: the building spans local x 0..31, z −52.5..0 (a
// stair tower and porch out to x 33.9), floors at 0 / 3.6 / 7.2, a skylit roof
// at 10.8. The paving (x −2.5..36.5, z −55..2.5) and an L of asphalt road with
// parking bays (out to x 46, z −62..11) sit 0.45 below the ground floor, with
// steps up at the entrances. The model's dirt slab (x −22..58, z −75..22) isn't
// used: the terrain under the campus is tinted to earth (cseTint) and blends
// into the country, where an 80 × 97 m rectangle would need a pad of its own.
//
// Drawing (the exported file is ~115 meshes, 22 of them instanced furniture):
// - every static part is merged into one mesh per material, in three groups
//   drawn by distance from the building: the shell (walls, floors, roof, glass,
//   paving, trees) always, the detail (window frames, curtains, doors, stairs,
//   railings, road paint, parked bikes) within DETAIL_RANGE, the interior
//   (desks, fans, lights, boards, plants, toilets, the court) within
//   INTERIOR_RANGE.
// - furniture with few copies is baked into those merged meshes (one draw call
//   per material, not per part); only the desks and fans stay instanced.
// - plain-coloured opaque materials become vertex colours on a few shared ones
//   (flattenColours), which is most of the model's 74 materials.
// - only the big structure casts shadows.
//
// Doors: 20 staff cabins and 2 labs on the upper floors, each a node DOOR_<id>
// at its hinge, closed as exported, with openAngle (the signed swing) in its
// extras. All leaves are drawn by a few
// InstancedMeshes, written only while a door moves; each has a kinematic box like
// the house doors. F works the nearest (main.js: useCseDoor, net csedoor, world.cse).
//
// Colliders come from the model's collision proxy (COL_Structure and the
// instanced INST_COL_DeskBox):
// - each connected piece is a union of boxes, decomposed back into boxes on
//   the grid of its own corner coordinates (a cell is solid when a ray along
//   x or z is inside the surface: winding of the faces it crosses), then
//   grown greedily. A plain 12-triangle box is used as it is.
// - every stair also gets a ramp per flight along its nosings (found from the
//   treads), so the controller walks it like the house stairs.
// - desks are merged into whole rows, placed by the visible desks' instances
//   (the proxy's own instances are all exported at the origin). Desks, the plinth and the
//   entrance steps are for players, bullets and grenades only: monsters walk
//   through them and are held on the ground floor by surfaceAt().

/** Where it stands: centre of the building (m), facing the named road; r: the campus radius. */
export const CSE_BUILDING = { name: "CSE Building", road: "North Road", x: -50, z: 216, r: 48 };

const CENTRE = { x: 18, z: -25.5 };  // the campus's centre in the model (paving + roads)
const PAVING_TOP = -0.44;          // model y of the paving's top: it sits on the flattened ground
const LIFT = 0.03;                 // m: the paving this far over the ground
const DETAIL_RANGE = 120;          // m from the walls: window frames, curtains, doors, stairs, railings drawn within this
const INTERIOR_RANGE = 45;         // m from the walls: furniture, lights, boards, the court drawn within this
const DESK_GAP = 0.45;             // m: desks closer than this in a line share one collider
const BAKE_MAX = 40;               // furniture with this many copies or fewer is merged, not instanced
const DOOR_TIME = 0.6;             // s for a full swing
const DOOR_REACH = 1.7;            // m from the doorway to offer the door
const DOOR_CLEAR = 0.55;           // m each side of a doorway kept clear of colliders (only the collider: see clearDoorways)
const DOOR_FLOOR = 1.6;            // m of height: the door has to be on your floor
const GROUND_PART = 1.2;           // m over the floor: a collider this low blocks the way (minimap, pathing, vehicles)
const LOW_PART = 0.5;              // m over the floor: colliders under this let monsters through (plinth, steps, dais)
const CELL = 12;                   // m: colliders are grouped into one body per cell
const RAMP_T = 0.2;                // m: ramp thickness
const LOOT_EVERY = 15;             // a loot spot on every this many desks

const OUTDOOR = /^INST_(PeachColumn|PorchColumn|Tree|Bush)/;
const INTERIOR = /^(INST_(?!Motorbike)|Classrooms_|Computer_Labs_|Staff_Rooms_|Central_Atrium_|Toilets_|Props_|Lighting_)/;
const DETAIL = /(_frame|_alu|_curtain|_jamb|_sign|_door|_iron|_light|_paint|^INST_Motorbike|^Railings_|^Staircases_|^Corridors_)/;
const SHADOW = /(_wall|_beige|_floor|roof_slab|_column|_clad|_acp|_fascia|_granite|PeachColumn|INST_Tree)/;
const DIRT = /_dirt$/;             // the model's ground slab (see the top of this file)

const _soil = new THREE.Color(0x8a6f4d);
/** Terrain vertex tint: bare earth over the campus, fading out at its edge. */
export function cseTint(x, z, c) {
  const d = Math.hypot(x - CSE_BUILDING.x, z - CSE_BUILDING.z), r = CSE_BUILDING.r;
  if (d < r + 8) c.lerp(_soil, 0.8 * (1 - THREE.MathUtils.smoothstep(d, r - 3, r + 8)));
}

/** A mesh's triangles in the root's frame, split into connected pieces: { pts, list: [[a, b, c], …] per piece }. */
function pieces(mesh, rootInv) {
  const g = mesh.geometry, pos = g.attributes.position;
  const m = new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld);
  const n = pos.count;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m));
  const parent = new Int32Array(n).map((_, i) => i);
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const join = (a, b) => { parent[find(a)] = find(b); };
  // Corners at the same spot belong together (each face has its own vertices)
  const at = new Map();
  pts.forEach((p, i) => {
    const k = `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
    if (at.has(k)) join(i, at.get(k)); else at.set(k, i);
  });
  const index = g.index;
  const count = index ? index.count : n;
  const vtx = t => (index ? index.getX(t) : t);
  for (let t = 0; t < count; t += 3) { join(vtx(t), vtx(t + 1)); join(vtx(t), vtx(t + 2)); }
  const out = new Map();
  for (let t = 0; t < count; t += 3) {
    const r = find(vtx(t));
    if (!out.has(r)) out.set(r, []);
    out.get(r).push([vtx(t), vtx(t + 1), vtx(t + 2)]);
  }
  return { pts, list: [...out.values()] };
}

const _e2 = new THREE.Vector3();
function normalOf(pts, [a, b, c], out) {
  return out.subVectors(pts[b], pts[a]).cross(_e2.subVectors(pts[c], pts[a])).normalize();
}

/** Point (u, v) in triangle (a, b, c) projected on the (U, V) axes. */
function inTri(u, v, a, b, c, U, V) {
  const d1 = (u - b[U]) * (a[V] - b[V]) - (a[U] - b[U]) * (v - b[V]);
  const d2 = (u - c[U]) * (b[V] - c[V]) - (b[U] - c[U]) * (v - c[V]);
  const d3 = (u - a[U]) * (c[V] - a[V]) - (c[U] - a[U]) * (v - a[V]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

const uniq = vals => [...new Set(vals.map(v => +v.toFixed(3)))].sort((a, b) => a - b);

/**
 * A connected union of axis-aligned boxes as boxes. Cells of the grid of its
 * corner coordinates are solid when a ray along x (or z) has entered more
 * faces than it has left (each face counted once however it's triangulated),
 * then grown greedily along x, z and y.
 */
function solidBoxes(pts, tris) {
  const idx = tris.flat();
  const xs = uniq(idx.map(i => pts[i].x)), ys = uniq(idx.map(i => pts[i].y)), zs = uniq(idx.map(i => pts[i].z));
  const nx = xs.length - 1, ny = ys.length - 1, nz = zs.length - 1;
  if (nx < 1 || ny < 1 || nz < 1) return [];
  const solid = new Uint8Array(nx * ny * nz);
  const id = (i, j, k) => (j * nz + k) * nx + i;
  const nrm = new THREE.Vector3();
  // Faces by plane: axis → { at, sign, tris }
  const planes = { x: new Map(), z: new Map() };
  for (const t of tris) {
    normalOf(pts, t, nrm);
    for (const ax of ["x", "z"]) {
      if (Math.abs(nrm[ax]) < 0.9) continue;
      const at = +pts[t[0]][ax].toFixed(3), sign = Math.sign(nrm[ax]);
      const key = `${at}|${sign}`;
      if (!planes[ax].has(key)) planes[ax].set(key, { at, sign, tris: [] });
      planes[ax].get(key).tris.push(t);
    }
  }
  const mid = (list, i) => (list[i] + list[i + 1]) / 2;
  const crossings = [];
  /** Marks the solid cells along one ray: (u, v) its position on the other two axes. */
  const sweep = (plist, u, v, U, V, cells, n, mark) => {
    crossings.length = 0;
    for (const p of plist) if (p.tris.some(([a, b, c]) => inTri(u, v, pts[a], pts[b], pts[c], U, V))) crossings.push(p);
    if (!crossings.length) return;
    crossings.sort((p, q) => p.at - q.at);
    let w = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const at = mid(cells, i);
      while (c < crossings.length && crossings[c].at < at) w -= crossings[c++].sign;
      if (w > 0) mark(i);
    }
  };
  const xPlanes = [...planes.x.values()], zPlanes = [...planes.z.values()];
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nz; k++) sweep(xPlanes, mid(ys, j), mid(zs, k), "y", "z", xs, nx, i => { solid[id(i, j, k)] = 1; });
    for (let i = 0; i < nx; i++) sweep(zPlanes, mid(xs, i), mid(ys, j), "x", "y", zs, nz, k => { solid[id(i, j, k)] = 1; });
  }
  // Grow boxes: along x, then z, then y
  const out = [];
  const full = (i0, i1, j0, j1, k0, k1) => {
    for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) if (!solid[id(i, j, k)]) return false;
    return true;
  };
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nz; k++) {
      for (let i = 0; i < nx; i++) {
        if (!solid[id(i, j, k)]) continue;
        let i1 = i, k1 = k, j1 = j;
        while (i1 + 1 < nx && solid[id(i1 + 1, j, k)]) i1++;
        while (k1 + 1 < nz && full(i, i1, j, j, k1 + 1, k1 + 1)) k1++;
        while (j1 + 1 < ny && full(i, i1, j1 + 1, j1 + 1, k, k1)) j1++;
        for (let jj = j; jj <= j1; jj++) for (let kk = k; kk <= k1; kk++) for (let ii = i; ii <= i1; ii++) solid[id(ii, jj, kk)] = 0;
        out.push(new THREE.Box3(new THREE.Vector3(xs[i], ys[j], zs[k]), new THREE.Vector3(xs[i1 + 1], ys[j1 + 1], zs[k1 + 1])));
      }
    }
  }
  return out;
}

/** Upward faces that look like stair treads (a step deep, a stair wide), merged per tread. */
function collectTreads(pts, tris, out) {
  const nrm = new THREE.Vector3();
  const faces = new Map();
  for (const t of tris) {
    if (normalOf(pts, t, nrm).y < 0.9) continue;
    const y = +pts[t[0]].y.toFixed(2);
    const b = new THREE.Box3();
    for (const i of t) b.expandByPoint(pts[i]);
    // Triangles of one face share its plane and touch its box
    let f = null;
    for (const g of faces.get(y) ?? []) {
      if (g.box.min.x <= b.max.x + 1e-3 && b.min.x <= g.box.max.x + 1e-3 && g.box.min.z <= b.max.z + 1e-3 && b.min.z <= g.box.max.z + 1e-3) { f = g; break; }
    }
    if (f) f.box.union(b);
    else { if (!faces.has(y)) faces.set(y, []); faces.get(y).push({ box: b }); }
  }
  for (const [y, list] of faces) {
    for (const { box } of list) {
      const dx = box.max.x - box.min.x, dz = box.max.z - box.min.z;
      const along = dx < dz ? "x" : "z", depth = Math.min(dx, dz), width = Math.max(dx, dz);
      if (depth < 0.18 || depth > 0.4 || width < 0.8 || width > 3) continue;
      const side = along === "x" ? "z" : "x";
      out.push({ y, along, a0: box.min[along], a1: box.max[along], c: (box.min[along] + box.max[along]) / 2, s0: box.min[side], s1: box.max[side] });
    }
  }
}

/**
 * Ramps up the stairs: treads chained into flights (each the next one a step
 * up and a tread on), a ramp per flight along its nosings, from the floor or
 * landing below the first tread to the one above the last.
 */
function stairRamps(treads, out) {
  const used = new Set();
  const next = t => treads.find(n => !used.has(n) && n.along === t.along
    && n.y - t.y > 0.08 && n.y - t.y < 0.3
    && Math.abs(n.s0 - t.s0) < 0.1 && Math.abs(n.s1 - t.s1) < 0.1
    && Math.abs(Math.abs(n.c - t.c) - (t.a1 - t.a0)) < 0.08);
  for (const start of [...treads].sort((p, q) => p.y - q.y)) {
    if (used.has(start)) continue;
    const flight = [start];
    used.add(start);
    for (let n = next(start); n; n = next(n)) { flight.push(n); used.add(n); }
    if (flight.length < 3) continue;
    const first = flight[0], last = flight[flight.length - 1], along = first.along;
    const dir = Math.sign(flight[1].c - first.c);
    const depth = first.a1 - first.a0, rise = (last.y - first.y) / (flight.length - 1);
    const nose = t => (dir > 0 ? t.a0 : t.a1);
    const sc = (first.s0 + first.s1) / 2, w = first.s1 - first.s0;
    const point = (a, y) => (along === "x" ? new THREE.Vector3(a, y, sc) : new THREE.Vector3(sc, y, a));
    const A = point(nose(first) - dir * depth, first.y - rise), B = point(nose(last) + dir * depth, last.y + rise);
    const u = new THREE.Vector3().subVectors(B, A);
    const len = u.length();
    u.normalize();
    const across = along === "x" ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    let nrm = new THREE.Vector3().crossVectors(u, across);
    if (nrm.y < 0) { across.negate(); nrm = new THREE.Vector3().crossVectors(u, across); }
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, nrm, u));
    const c = new THREE.Vector3().addVectors(A, B).multiplyScalar(0.5).addScaledVector(nrm, -RAMP_T / 2);
    out.push({ c, h: new THREE.Vector3(w / 2, RAMP_T / 2, len / 2), q, low: A.y < LOW_PART && B.y < LOW_PART });
  }
}

/** Merges boxes in line with the same height and width, across gaps nobody fits through (the desk columns: the aisles stay). */
function mergeBoxes(boxes) {
  const eq = (a, b) => Math.abs(a - b) < 0.02;
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let k = i + 1; k < boxes.length; k++) {
        const a = boxes[i], b = boxes[k];
        if (!eq(a.min.y, b.min.y) || !eq(a.max.y, b.max.y)) continue;
        const sameX = eq(a.min.x, b.min.x) && eq(a.max.x, b.max.x) && a.min.z <= b.max.z + DESK_GAP && b.min.z <= a.max.z + DESK_GAP;
        const sameZ = eq(a.min.z, b.min.z) && eq(a.max.z, b.max.z) && a.min.x <= b.max.x + DESK_GAP && b.min.x <= a.max.x + DESK_GAP;
        if (!sameX && !sameZ) continue;
        a.union(b);
        boxes.splice(k, 1);
        merged = true;
        k--;
      }
    }
  }
  return boxes;
}

/** Every instance of an InstancedMesh as a box in the root's frame (box: its own geometry's, or the one given). */
function instanceBoxes(mesh, rootInv, box = null) {
  if (!box) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    box = mesh.geometry.boundingBox;
  }
  const out = [], m = new THREE.Matrix4(), w = new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld);
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    out.push(box.clone().applyMatrix4(m.premultiply(w)));
  }
  return out;
}

/** Replaces a small InstancedMesh with plain meshes in its group, so mergeStaticMeshes takes them. */
function bakeInstances(im, group) {
  const m = new THREE.Matrix4();
  for (let i = 0; i < im.count; i++) {
    const copy = new THREE.Mesh(im.geometry, im.material);
    copy.castShadow = im.castShadow;
    copy.receiveShadow = im.receiveShadow;
    im.getMatrixAt(i, m);
    copy.applyMatrix4(m.premultiply(im.matrix));
    group.add(copy);
  }
  group.remove(im);
}

/**
 * Plain-coloured opaque meshes in a group get vertex colours and share a material per
 * roughness / metalness / side, so they merge into a handful of draw calls.
 * Shadow casters keep theirs (a merged mesh casts as a whole).
 */
function flattenColours(group, shared) {
  group.traverse(o => {
    const m = o.material;
    if (!o.isMesh || o.isInstancedMesh || o.castShadow || !m?.isMeshStandardMaterial) return;
    if (m.transparent || m.alphaTest > 0 || m.polygonOffset || m.map || m.normalMap || m.roughnessMap || m.metalnessMap || m.aoMap || m.emissiveMap) return;
    if (m.emissive.r + m.emissive.g + m.emissive.b > 0) return;
    const rough = Math.round(m.roughness * 5) / 5, metal = Math.round(m.metalness * 2) / 2;
    const key = `${rough}|${metal}|${m.side}`;
    if (!shared.has(key)) shared.set(key, new THREE.MeshStandardMaterial({ name: `Flat_${key}`, vertexColors: true, roughness: rough, metalness: metal, side: m.side }));
    const g = toFloatGeometry(o.geometry), n = g.attributes.position.count;
    const had = g.attributes.color, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      c[i * 3] = m.color.r * (had ? had.getX(i) : 1);
      c[i * 3 + 1] = m.color.g * (had ? had.getY(i) : 1);
      c[i * 3 + 2] = m.color.b * (had ? had.getZ(i) : 1);
    }
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    g.deleteAttribute("uv");
    o.geometry = g;
    o.material = shared.get(key);
  });
}

const easeDoor = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Takes the door nodes out of the model: [{ id, hinge, closed, swing, c, h, leaves }],
 * hinge in the model's frame, the collider's centre c and half size h and the leaf
 * geometries in the door's own frame (closed or open, the door turns about its origin).
 * The collider is the leaf's own box: the exported COL_DOOR_ children sit at the model's
 * origin (their parent's transform is applied twice).
 */
function takeDoors(model) {
  const nodes = [], doors = [];
  model.traverse(o => { if (/^DOOR_/.test(o.name)) nodes.push(o); });
  const inv = new THREE.Matrix4(), rel = new THREE.Matrix4();
  for (const node of nodes) {
    inv.copy(node.matrixWorld).invert();
    const leaves = [], col = new THREE.Box3();
    node.traverse(o => {
      if (!o.isMesh) return;
      let isCol = o.material?.name === "Collision_Proxy";
      for (let n = o; n && n !== node && !isCol; n = n.parent) isCol = /^COL_/.test(n.name);
      if (isCol) return;
      rel.multiplyMatrices(inv, o.matrixWorld);
      const geometry = toFloatGeometry(o.geometry).applyMatrix4(rel);
      geometry.computeBoundingBox();
      col.union(geometry.boundingBox);
      leaves.push({ geometry, material: o.material });
    });
    const q = new THREE.Quaternion().setFromRotationMatrix(node.matrixWorld);
    doors.push({
      id: node.userData.doorId ?? node.name.slice(5),
      hinge: new THREE.Vector3().setFromMatrixPosition(node.matrixWorld),
      closed: 2 * Math.atan2(q.y, q.w),
      swing: node.userData.openAngle ?? Math.PI / 2,
      c: col.getCenter(new THREE.Vector3()),
      h: col.getSize(new THREE.Vector3()).multiplyScalar(0.5),
      leaves,
      open: false, t: 0, slots: [], body: null, x: 0, y: 0, z: 0, ax: 0, az: 0, index: doors.length,
    });
  }
  for (const node of nodes) node.removeFromParent();
  return doors;
}

/**
 * Two cabins have a partition ending 35 cm in front of the door, off-centre: its end and
 * the jamb leave 0.64 m, less than the player's 0.7 m. A collider standing that close
 * in front of a doorway is cut back to DOOR_CLEAR (the wall is still drawn: a shoulder
 * clips it by a few cm). The doorway's own walls, beside the opening, aren't touched.
 */
function clearDoorways(doors, shapes) {
  const cut = new Set();
  for (const d of doors) {
    const ax = Math.cos(d.closed), az = -Math.sin(d.closed);
    const along = Math.abs(az) > Math.abs(ax) ? "z" : "x", depth = along === "z" ? "x" : "z";
    const mid = { x: d.hinge.x + ax * d.c.x, z: d.hinge.z + az * d.c.x };
    const half = d.h.x - 0.03;
    for (const sh of shapes) {
      const b = sh.box;
      if (!b || b.max.y < d.hinge.y + 0.3 || b.min.y > d.hinge.y + 1.9) continue;
      if (b.min[along] > mid[along] + half || b.max[along] < mid[along] - half) continue;
      if (b.min[depth] > mid[depth] + 0.1 && b.min[depth] < mid[depth] + DOOR_CLEAR) b.min[depth] = mid[depth] + DOOR_CLEAR;
      if (b.max[depth] < mid[depth] - 0.1 && b.max[depth] > mid[depth] - DOOR_CLEAR) b.max[depth] = mid[depth] - DOOR_CLEAR;
      if (b.min[depth] >= b.max[depth]) cut.add(sh);
    }
  }
  return cut.size ? shapes.filter(sh => !cut.has(sh)) : shapes;
}

/** The glTF node name a mesh came from (multi-material nodes load as a group of unnamed meshes). */
const nodeName = o => (o.parent?.parent ? o.parent.name : o.name);

/**
 * gltf: the loaded model. roads: world/Roads.js. groundAt(x, z): the finished
 * terrain. Returns { x, z, rot, lootSpots, blocks(), inside(), surfaceAt(), update(x, z) }.
 */
export function placeCseBuilding({ gltf, scene, world, material, roads, groundAt, mapObstacles, navObstacles, chunks, anisotropy = 1 }) {
  const def = CSE_BUILDING;
  // Front (local +Z) toward the road, square to it
  const road = roads.byName(def.road);
  const at = roads.pointAt(road, roads.arcNear(road, def.x, def.z));
  const rot = Math.atan2(at.x - def.x, at.z - def.z);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const baseY = groundAt(def.x, def.z) + LIFT - PAVING_TOP;   // world y of the ground floor (model y = 0)
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const doors = takeDoors(model);
  model.updateMatrixWorld(true);

  // ── Colliders, in the model's frame: { box } or { c, h, q } (an oriented box)
  let shapes = [];
  const treads = [];
  let desks = [];
  const collision = [], dirt = [];
  let bench = null;
  model.traverse(o => {
    if (!o.isMesh) return;
    if (/^(COL_|INST_COL_)/.test(nodeName(o)) || o.material?.name === "Collision_Proxy") collision.push(o);
    else if (DIRT.test(nodeName(o))) dirt.push(o);
    else if (!bench && o.isInstancedMesh && /DeskBench/.test(nodeName(o))) bench = o;
  });
  for (const mesh of collision) {
    if (mesh.isInstancedMesh) {
      // The desk's collision box, where the desks actually stand
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (bench) desks.push(...instanceBoxes(bench, rootInv, mesh.geometry.boundingBox));
      continue;
    }
    const { pts, list } = pieces(mesh, rootInv);
    for (const tris of list) {
      collectTreads(pts, tris, treads);
      if (tris.length <= 12) {
        const box = new THREE.Box3();
        for (const t of tris) for (const i of t) box.expandByPoint(pts[i]);
        if (box.max.y < PAVING_TOP - 0.05) continue;   // the dirt slab: the terrain is the floor there
        shapes.push({ box });
      } else {
        for (const box of solidBoxes(pts, tris)) shapes.push({ box });
      }
    }
  }
  stairRamps(treads, shapes);
  shapes = clearDoorways(doors, shapes);
  desks = mergeBoxes(desks);

  // Model frame → world: the building's centre on (def.x, def.z), turned by rot
  const toWorld = (lx, lz, out = {}) => {
    const x = lx - CENTRE.x, z = lz - CENTRE.z;
    out.x = def.x + x * cos + z * sin;
    out.z = def.z - x * sin + z * cos;
    return out;
  };
  for (const s of shapes) {
    if (!s.box) continue;
    s.c = s.box.getCenter(new THREE.Vector3());
    s.h = s.box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    s.low = s.box.max.y < LOW_PART;
  }
  const turn = new CANNON.Quaternion().setFromEuler(0, rot, 0);
  /** One static body per CELL of the campus (each body at its own centre, for the broadphase grid). */
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
  // Walls, floors, columns, railings, the upper stairs: solid for everything
  addBodies(shapes.filter(s => !s.low));
  // Plinth, entrance steps, the dais and the desks: monsters walk through
  // (surfaceAt holds them on the floor); a ledge would stop them
  const low = shapes.filter(s => s.low);
  for (const box of desks) low.push({ c: box.getCenter(new THREE.Vector3()), h: box.getSize(new THREE.Vector3()).multiplyScalar(0.5) });
  addBodies(low, { collisionFilterMask: ~GROUP_ZOMBIE });

  // Walls and columns on the ground floor: the minimap, vehicles and the monsters' pathing
  for (const { box, c, h } of shapes) {
    if (!box || box.min.y > GROUND_PART || box.max.y < GROUND_PART || h.x * h.z > 40) continue;
    const w = toWorld(c.x, c.z);
    const o = { type: "box", x: w.x, z: w.z, rot, w: h.x * 2, d: h.z * 2, hw: h.x, hd: h.z, cse: true };
    mapObstacles.push(o);
    navObstacles.push(o);
  }

  // Loot on the desk tops, on every floor
  const lootSpots = [];
  if (bench) {
    instanceBoxes(bench, rootInv).forEach((b, i) => {
      if (i % LOOT_EVERY) return;
      const c = b.getCenter(new THREE.Vector3());
      const w = toWorld(c.x, c.z);
      lootSpots.push({ x: w.x, y: baseY + b.max.y + 0.02, z: w.z });
    });
  }

  // ── Drawing
  for (const o of collision) o.removeFromParent();
  for (const o of dirt) o.removeFromParent();
  model.updateMatrixWorld(true);
  const shell = new THREE.Group(), detail = new THREE.Group(), interior = new THREE.Group();
  const parts = [];
  model.traverse(o => { if (o.isMesh) parts.push(o); });
  for (const o of parts) {
    const name = nodeName(o), m = o.material;
    if (m.transparent) {
      // Glass and the court net: no depth writes, one pass
      m.depthWrite = false;
      m.forceSinglePass = true;
    }
    if (m.map) m.map.anisotropy = anisotropy;
    if (/paving|asphalt|_paint/.test(name)) {
      // A hair over the flattened ground (the paint a hair over the road): pulled
      // forward in depth so they never flicker into the terrain or each other
      const paint = /_paint/.test(name);
      m.polygonOffset = true;
      m.polygonOffsetFactor = paint ? -4 : -2;
      m.polygonOffsetUnits = paint ? -8 : -4;
    }
    const group = OUTDOOR.test(name) ? shell : INTERIOR.test(name) ? interior : DETAIL.test(name) ? detail : shell;
    o.castShadow = group === shell && !m.transparent && SHADOW.test(name);
    o.receiveShadow = true;
    group.attach(o);
    if (o.isInstancedMesh && o.count <= BAKE_MAX) bakeInstances(o, group);
  }
  const flats = new Map();
  for (const g of [shell, detail, interior]) {
    flattenColours(g, flats);
    mergeStaticMeshes(g);
  }

  // The door leaves: one InstancedMesh per material and shape, the matrices written as doors move
  const buckets = new Map();
  for (const d of doors) {
    for (const leaf of d.leaves) {
      leaf.geometry.computeBoundingBox();
      const b = leaf.geometry.boundingBox;
      const key = `${leaf.material.uuid}|${leaf.geometry.attributes.position.count}|${b.min.toArray().concat(b.max.toArray()).map(v => v.toFixed(2)).join()}`;
      if (!buckets.has(key)) buckets.set(key, { ...leaf, list: [] });
      buckets.get(key).list.push(d);
    }
    d.leaves = null;
  }
  const doorMeshes = [];
  const _mtx = new THREE.Matrix4(), _dq = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0), _one = new THREE.Vector3(1, 1, 1);
  const writeDoor = d => {
    _mtx.compose(d.hinge, _dq.setFromAxisAngle(_up, d.closed + d.swing * easeDoor(d.t)), _one);
    for (let i = 0; i < d.slots.length; i += 2) {
      d.slots[i].setMatrixAt(d.slots[i + 1], _mtx);
      d.slots[i].instanceMatrix.needsUpdate = true;
    }
  };
  for (const { geometry, material, list } of buckets.values()) {
    if (material.transparent) {
      material.depthWrite = false;
      material.forceSinglePass = true;
    }
    const im = new THREE.InstancedMesh(geometry, material, list.length);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.receiveShadow = true;
    list.forEach((d, i) => d.slots.push(im, i));
    doorMeshes.push(im);
    interior.add(im);
  }
  for (const d of doors) writeDoor(d);
  for (const im of doorMeshes) im.computeBoundingSphere();

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

  // Each door's kinematic box, and its doorway in the world
  const _bq = new CANNON.Quaternion();
  const poseDoor = d => {
    d.body.quaternion.copy(_bq.setFromEuler(0, rot + d.closed + d.swing * easeDoor(d.t), 0));
    d.body.aabbNeedsUpdate = true;
  };
  for (const d of doors) {
    const yaw = rot + d.closed, s = Math.sin(yaw), cc = Math.cos(yaw);
    const w = toWorld(d.hinge.x, d.hinge.z);
    d.body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material, collisionFilterGroup: GROUP_WORLD });
    d.body.addShape(new CANNON.Box(new CANNON.Vec3(Math.max(d.h.x, 0.04), Math.max(d.h.y, 0.04), Math.max(d.h.z, 0.04))), new CANNON.Vec3(d.c.x, d.c.y, d.c.z));
    d.body.position.set(w.x, baseY + d.hinge.y, w.z);
    poseDoor(d);
    world.addBody(d.body);
    d.x = w.x + d.c.x * cc + d.c.z * s;
    d.z = w.z - d.c.x * s + d.c.z * cc;
    d.y = baseY + d.hinge.y;
    d.ax = cc; d.az = -s;     // along the doorway
  }
  const moving = [];

  // The building's footprint (model frame): its ground-floor slabs (main block, rear wing, stair tower)
  const slabs = [], foot = new THREE.Box3();
  for (const { box } of shapes) {
    if (!box || box.min.y > -0.2 || Math.abs(box.max.y) > 0.05 || (box.max.x - box.min.x) * (box.max.z - box.min.z) < 5) continue;
    slabs.push(box);
    foot.union(box);
  }
  const _l = { x: 0, z: 0 };
  const toLocal = (x, z) => {
    const dx = x - def.x, dz = z - def.z;
    _l.x = dx * cos - dz * sin + CENTRE.x;
    _l.z = dx * sin + dz * cos + CENTRE.z;
    return _l;
  };
  /** True under the building's roof. */
  const inside = (x, z) => {
    if (Math.abs(x - def.x) > def.r || Math.abs(z - def.z) > def.r) return false;
    const l = toLocal(x, z);
    for (const b of slabs) if (l.x > b.min.x && l.x < b.max.x && l.z > b.min.z && l.z < b.max.z) return true;
    return false;
  };

  return {
    x: def.x, z: def.z, rot, lootSpots,
    /** True on the campus (keeps trees, rocks, poles and spawns off it). */
    blocks: (x, z, pad = 0) => Math.hypot(x - def.x, z - def.z) < def.r + pad,
    inside,
    /** Where a monster stands: on the ground floor inside the building, else on the ground. */
    surfaceAt: (x, z, ground) => (inside(x, z) ? Math.max(ground, baseY) : ground),
    doors,
    /** The nearest door you can reach at (x, z) with your feet at feetY, or null. */
    doorAt(x, z, feetY) {
      if (Math.abs(x - def.x) > def.r || Math.abs(z - def.z) > def.r) return null;
      let best = null, bd = DOOR_REACH;
      for (const d of doors) {
        if (Math.abs(d.y - feetY) > DOOR_FLOOR) continue;
        const dist = Math.hypot(d.x - x, d.z - z);
        if (dist < bd) { bd = dist; best = d; }
      }
      return best;
    },
    /** Swing door i open or shut (instant: a late join). */
    setDoor(i, open, instant = false) {
      const d = doors[i];
      if (!d || d.open === open) return;
      d.open = open;
      if (instant) {
        d.t = open ? 1 : 0;
        writeDoor(d);
        poseDoor(d);
      } else if (!moving.includes(d)) {
        moving.push(d);
      }
    },
    /** Indices of the open doors. */
    openDoors: () => doors.filter(d => d.open).map(d => d.index),
    /**
     * The doorways are only just wider than you: walking through an open one, a nudge
     * (written to out) toward its middle, so you don't catch on the frame.
     */
    doorAssist(x, z, feetY, vx, vz, out) {
      if (Math.abs(x - def.x) > def.r || Math.abs(z - def.z) > def.r || (vx === 0 && vz === 0)) return false;
      for (const d of doors) {
        if (d.t < 0.5 || Math.abs(d.y - feetY) > DOOR_FLOOR) continue;
        const dx = x - d.x, dz = z - d.z;
        const along = dx * d.ax + dz * d.az, depth = -dx * d.az + dz * d.ax;
        if (Math.abs(along) > 0.8 || Math.abs(depth) > 0.8) continue;
        const pull = THREE.MathUtils.clamp(-along * 6, -1.6, 1.6);
        out.x = d.ax * pull;
        out.z = d.az * pull;
        return true;
      }
      return false;
    },
    /** Each frame: advances the swinging doors. */
    updateDoors(delta) {
      for (let i = moving.length - 1; i >= 0; i--) {
        const d = moving[i], to = d.open ? 1 : 0;
        d.t = to > d.t ? Math.min(to, d.t + delta / DOOR_TIME) : Math.max(to, d.t - delta / DOOR_TIME);
        writeDoor(d);
        poseDoor(d);
        if (d.t === to) moving.splice(i, 1);
      }
    },
    /** Each frame with the camera position: the detail and the interior are only drawn up close. */
    update(x, z) {
      const l = toLocal(x, z);
      const d = Math.hypot(Math.max(foot.min.x - l.x, 0, l.x - foot.max.x), Math.max(foot.min.z - l.z, 0, l.z - foot.max.z));
      detail.visible = d < DETAIL_RANGE;
      interior.visible = d < INTERIOR_RANGE;
    },
  };
}
