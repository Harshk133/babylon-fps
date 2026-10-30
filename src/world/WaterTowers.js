import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GROUP_WORLD } from "../physicsGroups.js";
import { toFloatGeometry } from "./MergeStatic.js";

// Municipal water towers (public/models/india/water_tower.opt.glb, made for
// the game; sources in public/models/indian things/WaterTower/): a concrete
// tank on eight legs, 15 m up, with a spiral stair round a pole on one side and
// the "लातूर शहर महानगरपालिका" board on the tank. You can walk up the stair to the
// railed roof of the tank, a sniper's perch with loot on it. Monsters stay on
// the ground (they're pinned to it), so up there only the ranged ones reach you.
//
// The model is in metres: legs on y = 0, the stair on its +X side, the board
// facing +Z. Colliders come from its own collision mesh (WaterTower_Collision):
// plain cubes become oriented boxes (legs, railing posts), round pieces
// cylinders (the tank), the rest (the stair's helix, its outer wall, the
// bridge to the tank) a trimesh, which the capsule's spheres and every ray
// (ground snap, bullets, camera, sight) handle like the cave rock.
//
// All towers share one InstancedMesh per material (flagged for the map-cell
// split in loadWorld, so far ones aren't drawn): three draw calls per cell.

/** [road, near x, near z, side (+1 = right of travel)]: one by every town, two in Shivpur, a few between. */
export const WATER_TOWER_SPOTS = [
  ["North Road", 8, 44, -1],      // Crossroads
  ["North Road", 2, 150, 1],      // Ravencross
  ["Highway", 172, -34, 1],       // Ashford
  ["North Road", 18, -128, 1],    // Mill Creek
  ["Highway", -98, 5, -1],        // Pine Hollow
  ["Highway", -372, 43, 1],       // Machhiwada
  ["North Road", 11, 336, -1],    // Rampur
  ["North Road", 34, -336, 1],    // Sonapur
  ["Outer Ring", -330, 170, -1],  // Pahadi
  ["Station Road", 318, 4, -1],   // Shivpur
  ["Market Road", 372, -104, 1],  // Shivpur
  ["Highway", -235, 30, -1],      // between the towns
  ["Highway", 262, -46, 1],
  ["North Road", 6, 236, 1],
  ["North Road", 30, -236, -1],
];
const OFFSET = 17;        // m from the road's centreline to the footprint's centre
export const TOWER_R = 7.6; // m: a radius round the footprint (legs and stair)
const SLIDE = 9;          // m along the road per try when a spot is taken
const TRIES = 9;
// The model stands 18.6 m: drawn (and collided) a fifth lower, about 15 m to the
// railing. Only the height: the stair keeps its width (and gets gentler)
const HEIGHT = 0.8;
const ROOF_Y = 17.2 * HEIGHT; // the tank's roof (local)
const MODEL_CX = 1.6;     // the footprint's centre in the model's X (the stair sticks out on +X)
// (the tank's centre is the model's origin: x = −MODEL_CX once recentred)
const HATCH = new CANNON.Box(new CANNON.Vec3(0.55, 0.32 * HEIGHT, 0.55));

/**
 * Resolves the spots on the roads: [{ x, z, rot, r }], rot turning the board
 * (local +Z) toward the road. blocked(x, z, r): taken ground; a spot that's
 * taken slides along its road, and is dropped if nothing nearby is free.
 */
export function waterTowerSpots(roads, blocked) {
  const out = [];
  for (const [name, nx, nz, side] of WATER_TOWER_SPOTS) {
    const road = roads.byName(name);
    if (!road) continue;
    const s0 = roads.arcNear(road, nx, nz);
    for (let i = 0; i < TRIES; i++) {
      const s = s0 + Math.ceil(i / 2) * SLIDE * (i % 2 ? 1 : -1);
      if (!road.closed && (s < 0 || s > road.length)) continue;
      const at = roads.pointAt(road, s);
      const ox = at.tz * side, oz = -at.tx * side;   // away from the road, this side
      const x = at.x + ox * OFFSET, z = at.z + oz * OFFSET;
      if (roads.distance(x, z) < OFFSET - 0.5) continue;  // another road runs closer
      if (out.some(o => Math.hypot(o.x - x, o.z - z) < TOWER_R * 2 + 4) || blocked(x, z, TOWER_R)) continue;
      out.push({ x, z, rot: Math.atan2(-ox, -oz), r: TOWER_R });
      break;
    }
  }
  return out;
}

/** cannon's Trimesh edge list is never used by sphere contacts or rays (see Caves.js). */
class TowerTrimesh extends CANNON.Trimesh {
  updateEdges() { this.edges = new Int16Array(0); }
}

/**
 * The collision mesh split into pieces (by shared corners), each as a shape:
 * { box: { c, h, q } } | { cyl: { c, r, h } } | { tri: { c, verts, idx }, bounds: Box3 }, in
 * the model frame recentred on the footprint.
 */
function colliderPieces(mesh, toLocal) {
  const g = mesh.geometry, pos = g.attributes.position;
  const m = new THREE.Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld);
  const n = pos.count, pts = [];
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m));
  const parent = new Int32Array(n).map((_, i) => i);
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const join = (a, b) => { parent[find(a)] = find(b); };
  const at = new Map();
  pts.forEach((p, i) => {
    const k = `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
    if (at.has(k)) join(i, at.get(k)); else at.set(k, i);
  });
  const index = g.index, tris = index ? index.count : n;
  const vtx = t => (index ? index.getX(t) : t);
  for (let t = 0; t < tris; t += 3) { join(vtx(t), vtx(t + 1)); join(vtx(t), vtx(t + 2)); }
  const groups = new Map();
  for (let t = 0; t < tris; t += 3) {
    const r = find(vtx(t));
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }

  const out = [], e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (const list of groups.values()) {
    const ids = new Set();
    for (const t of list) for (let k = 0; k < 3; k++) ids.add(vtx(t + k));
    const vs = [...ids].map(i => pts[i]);
    const box = new THREE.Box3().setFromPoints(vs);
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());

    if (list.length === 12) {
      // A cube, maybe turned: its three face directions are the box's axes
      const axes = [];
      for (const t of list) {
        nrm.subVectors(pts[vtx(t + 1)], pts[vtx(t)]).cross(e2.subVectors(pts[vtx(t + 2)], pts[vtx(t)])).normalize();
        if (!axes.some(a => Math.abs(a.dot(nrm)) > 0.95)) axes.push(nrm.clone());
      }
      if (axes.length === 3) {
        const ax = axes[0];
        const az = new THREE.Vector3().crossVectors(ax, axes[1]).normalize();
        const ay = new THREE.Vector3().crossVectors(az, ax).normalize();
        const basis = [ax, ay, az], h = new THREE.Vector3();
        const mid = vs.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / vs.length);
        ["x", "y", "z"].forEach((k, i) => {
          let lo = Infinity, hi = -Infinity;
          for (const p of vs) { const d = e1.subVectors(p, mid).dot(basis[i]); lo = Math.min(lo, d); hi = Math.max(hi, d); }
          h[k] = Math.max(0.05, (hi - lo) / 2);
        });
        const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(ax, ay, az));
        out.push({ box: { c: mid, h, q } });
        continue;
      }
    }
    // Round about the vertical (the tank and its rim): every corner on one radius, or on the axis
    const R = Math.max(size.x, size.z) / 2;
    const round = Math.abs(size.x - size.z) < 0.05 * R && R > 1 && vs.every(p => {
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      return d < 0.05 || Math.abs(d - R) < 0.04 * R;
    });
    if (round) {
      out.push({ cyl: { c, r: R, h: size.y } });
      continue;
    }
    // Anything else: its own triangles
    const remap = new Map(), verts = [], idx = [];
    for (const t of list) {
      for (let k = 0; k < 3; k++) {
        const v = vtx(t + k);
        let r = remap.get(v);
        if (r === undefined) {
          r = remap.size;
          remap.set(v, r);
          verts.push(pts[v].x - c.x, pts[v].y - c.y, pts[v].z - c.z);
        }
        idx.push(r);
      }
    }
    out.push({ tri: { c, verts, idx }, bounds: box });
  }
  return stairPieces(out);
}

/**
 * The spiral stair, made walkable. Its trimesh ramp was a poor surface for the
 * capsule (and the landing at the top hangs ~1.3 m over the last turn, a rail
 * beside it lower still: you'd stop there with your head against them). So:
 * - the ramp (the tall piece with many upward faces) is fitted as a helix
 *   (centre, radii, start, rise per radian) and rebuilt from tilted boxes, as
 *   the house stairs are;
 * - the rail beside the landing goes (the stair's outer wall runs up past it);
 * - the landing keeps the triangles with HEADROOM over the helix below.
 * The outer wall and the pole stay as they are.
 */
const HEADROOM = 1.95;
const STEP = Math.PI / 12;   // radians of ramp per box
function stairPieces(pieces) {
  const centre = pc => [(pc.bounds.min.x + pc.bounds.max.x) / 2, (pc.bounds.min.z + pc.bounds.max.z) / 2];
  const ramp = pieces.find(pc => pc.tri && pc.bounds.max.y - pc.bounds.min.y > 8 && upFaces(pc).length > 40 && radial(pc, ...centre(pc)).inner < 0.4);
  if (!ramp) return pieces;
  const [cx, cz] = centre(ramp);
  const { inner, outer } = radial(ramp, cx, cz);
  // Upward faces by height; their angles unwrapped into one turning line: y = y0 + k·(θ − θ0)
  const ups = upFaces(ramp).map(([x, y, z]) => ({ y, a: Math.atan2(z - cz, x - cx) })).sort((p, q) => p.y - q.y);
  let prev = ups[0].a, turn = 0;
  for (const u of ups) {
    let a = u.a + turn;
    while (a - prev > Math.PI) { a -= Math.PI * 2; turn -= Math.PI * 2; }
    while (a - prev < -Math.PI) { a += Math.PI * 2; turn += Math.PI * 2; }
    u.t = prev = a;
  }
  const n = ups.length, mt = ups.reduce((s, u) => s + u.t, 0) / n, my = ups.reduce((s, u) => s + u.y, 0) / n;
  const k = ups.reduce((s, u) => s + (u.t - mt) * (u.y - my), 0) / ups.reduce((s, u) => s + (u.t - mt) ** 2, 0);
  const yAt = t => my + k * (t - mt);                  // the ramp's top along the turning line
  const ta = ups[0].t, tb = ups[n - 1].t;     // bottom and top of the ramp (t falls as it climbs when k < 0)
  const t0 = Math.min(ta, tb), t1 = Math.max(ta, tb), yTop = yAt(tb);
  const thick = 0.18, mid = (inner + outer) / 2, width = outer - inner;
  const out = pieces.filter(pc => pc !== ramp);
  for (let t = t0; t < t1 + STEP / 2; t += STEP) {
    const tc = Math.min(t, t1), y = yAt(tc);
    const x = cx + Math.cos(tc) * mid, z = cz + Math.sin(tc) * mid;
    // Its long side along the tangent (a little long, so the boxes overlap), tilted to the rise there
    const run = mid * STEP * 1.12, slope = Math.atan2(Math.abs(k), mid);
    const tangent = new THREE.Vector3(-Math.sin(tc), 0, Math.cos(tc)).multiplyScalar(Math.sign(k) || 1);
    const radialDir = new THREE.Vector3(Math.cos(tc), 0, Math.sin(tc));
    const along = tangent.clone().multiplyScalar(Math.cos(slope)).setY(Math.sin(slope));
    const upDir = new THREE.Vector3().crossVectors(along, radialDir).normalize();
    if (upDir.y < 0) upDir.negate();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(radialDir, upDir, new THREE.Vector3().crossVectors(radialDir, upDir)));
    out.push({ box: { c: new THREE.Vector3(x, y - thick / 2, z), h: new THREE.Vector3(width / 2, thick / 2, run / 2), q }, stair: true });
  }
  // The ramp's top under (x, z) below y (the turn just beneath), or −∞ off it
  const below = (x, z, y) => {
    const r = Math.hypot(x - cx, z - cz);
    if (r < inner - 0.05 || r > outer + 0.05) return -Infinity;
    const a = Math.atan2(z - cz, x - cx);
    let best = -Infinity;
    for (let m = -12; m <= 12; m++) {
      const t = a + m * Math.PI * 2;
      if (t < t0 - 0.05 || t > t1 + 0.05) continue;
      const h = yAt(t);
      if (h < y && h > best) best = h;
    }
    return best;
  };
  for (const pc of out) {
    if (!pc.tri) continue;
    const b = pc.bounds, r0 = radial(pc, cx, cz).inner, tall = b.max.y - b.min.y;
    // The rail by the landing: short, high up, outside the ramp
    if (tall < 2.5 && b.min.y > yTop - 3 && r0 > outer - 0.1) { pc.tri.idx = []; continue; }
    if (tall > 1 || b.min.y < yTop - 3) continue;   // the wall and the pole stay
    // The landing: only where there's headroom over the turn below
    const { verts: v, idx: id, c: o } = pc.tri, keep = [];
    for (let t = 0; t < id.length; t += 3) {
      let ok = true;
      for (let i = 0; i <= 4 && ok; i++) for (let j = 0; j <= 4 - i && ok; j++) {
        const u = i / 4, w = j / 4, l = 1 - u - w;
        const X = (v[id[t] * 3] * u + v[id[t + 1] * 3] * w + v[id[t + 2] * 3] * l) + o.x;
        const Y = Math.min(v[id[t] * 3 + 1], v[id[t + 1] * 3 + 1], v[id[t + 2] * 3 + 1]) + o.y;
        const Z = (v[id[t] * 3 + 2] * u + v[id[t + 1] * 3 + 2] * w + v[id[t + 2] * 3 + 2] * l) + o.z;
        for (const [ox, oz] of [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]]) {
          if (Y - below(X + ox, Z + oz, Y - 0.5) < HEADROOM) { ok = false; break; }
        }
      }
      if (ok) keep.push(id[t], id[t + 1], id[t + 2]);
    }
    pc.tri.idx = keep;
  }
  return out;
}

/** Centroids of a trimesh piece's upward faces, in the model frame. */
function upFaces(pc) {
  const { verts: v, idx, c } = pc.tri, out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    a.fromArray(v, idx[t] * 3); b.fromArray(v, idx[t + 1] * 3); d.fromArray(v, idx[t + 2] * 3);
    const n = b.clone().sub(a).cross(d.clone().sub(a));
    if (n.y > 0.5 * n.length()) out.push([(a.x + b.x + d.x) / 3 + c.x, (a.y + b.y + d.y) / 3 + c.y, (a.z + b.z + d.z) / 3 + c.z]);
  }
  return out;
}

/** Nearest and farthest a trimesh piece's corners are from the vertical line through (cx, cz). */
function radial(pc, cx, cz) {
  const { verts: v, c } = pc.tri;
  let inner = Infinity, outer = 0;
  for (let i = 0; i < v.length; i += 3) {
    const r = Math.hypot(v[i] + c.x - cx, v[i + 2] + c.z - cz);
    inner = Math.min(inner, r); outer = Math.max(outer, r);
  }
  return { inner, outer };
}

/**
 * Builds every tower. gltf: the loaded model; spots: waterTowerSpots();
 * groundAt(x, z): the finished terrain; anisotropy: the sharpest the GPU does
 * (for the board). Returns { towers, lootSpots, blocks(x, z, pad) }.
 */
export function buildWaterTowers({ gltf, scene, world, material, spots, groundAt, mapObstacles, navObstacles, anisotropy = 8 }) {
  const empty = { towers: [], lootSpots: [], blocks: () => false };
  if (!gltf || !spots.length) return empty;
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  // Model frame → recentred on the footprint
  const toLocal = new THREE.Matrix4().makeTranslation(-MODEL_CX, 0, 0).multiply(new THREE.Matrix4().makeScale(1, HEIGHT, 1)).multiply(new THREE.Matrix4().copy(model.matrixWorld).invert());
  const collision = model.getObjectByName("WaterTower_Collision");
  const collisionMesh = collision?.isMesh ? collision : collision?.getObjectByProperty("isMesh", true);
  const pieces = collisionMesh ? colliderPieces(collisionMesh, toLocal) : [];

  const parts = [];
  const lod = model.getObjectByName("WaterTower_LOD0") ?? model;
  lod.traverse(o => {
    if (!o.isMesh || o === collisionMesh) return;
    const geometry = toFloatGeometry(o.geometry).applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, o.matrixWorld));
    const mat = o.material;
    const sign = /sign/i.test(mat.name);
    for (const map of [mat.map, mat.normalMap, mat.roughnessMap]) if (map) map.anisotropy = sign ? anisotropy : Math.min(anisotropy, 4);
    // The board is read from the foot of the tower: sharp, and a touch of its own light so it isn't lost in the tank's shade
    if (sign && mat.map) { mat.emissive?.set(0x222222); mat.emissiveMap = mat.map; }
    // ...and at its true height, so the lettering isn't squashed with the tower
    if (sign) {
      geometry.computeBoundingBox();
      const cy = (geometry.boundingBox.min.y + geometry.boundingBox.max.y) / 2;
      geometry.translate(0, -cy, 0).scale(1, 1 / HEIGHT, 1).translate(0, cy, 0);
    }
    parts.push({ geometry, material: mat });
  });

  const towers = [], lootSpots = [];
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const meshes = parts.map(({ geometry, material }) => {
    const im = new THREE.InstancedMesh(geometry, material, spots.length);
    im.castShadow = true;
    im.receiveShadow = true;
    im.userData.chunk = true;
    return im;
  });

  spots.forEach((s, i) => {
    const y = groundAt(s.x, s.z);
    const c = Math.cos(s.rot), sn = Math.sin(s.rot);
    const toWorld = (lx, lz) => ({ x: s.x + lx * c + lz * sn, z: s.z - lx * sn + lz * c });
    mtx.compose(p.set(s.x, y, s.z), q.setFromAxisAngle(up, s.rot), one);
    for (const im of meshes) im.setMatrixAt(i, mtx);

    const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
    for (const pc of pieces) {
      if (pc.box) {
        const { c: bc, h, q: bq } = pc.box;
        body.addShape(new CANNON.Box(new CANNON.Vec3(h.x, h.y, h.z)), new CANNON.Vec3(bc.x, bc.y, bc.z), new CANNON.Quaternion(bq.x, bq.y, bq.z, bq.w));
        // Legs block the way (minimap, vehicles); the railing up top doesn't
        if (bc.y - h.y < 1 && !pc.stair) {
          const w = toWorld(bc.x, bc.z);
          mapObstacles.push({ type: "box", x: w.x, z: w.z, rot: s.rot, w: h.x * 2, d: h.z * 2, hw: h.x, hd: h.z, tower: true });
        }
      } else if (pc.cyl) {
        const { c: cc, r, h } = pc.cyl;
        body.addShape(new CANNON.Cylinder(r, r, h, 16), new CANNON.Vec3(cc.x, cc.y, cc.z));
      }
      if (pc.tri?.idx.length) {
        const { c: tc, verts, idx } = pc.tri;
        body.addShape(new TowerTrimesh(verts, idx), new CANNON.Vec3(tc.x, tc.y, tc.z));
        // The stair's footprint: in the way on the ground, and round it for the monsters
        const b = pc.bounds;
        if (b.min.y < 1 && b.max.y - b.min.y > 10) {
          const bx = (b.min.x + b.max.x) / 2, bz = (b.min.z + b.max.z) / 2;
          const hw = (b.max.x - b.min.x) / 2, hd = (b.max.z - b.min.z) / 2, w = toWorld(bx, bz);
          if (!towers[i]?.stair) {
            const o = { type: "box", x: w.x, z: w.z, rot: s.rot, w: hw * 2, d: hd * 2, hw, hd, tower: true };
            mapObstacles.push(o);
            navObstacles.push(o);
            towers[i] = { stair: o };
          }
        }
      }
    }
    body.position.set(s.x, y, s.z);
    body.quaternion.setFromEuler(0, s.rot, 0);
    world.addBody(body);

    // The roof hatch (not in the collision mesh), and loot round it
    body.addShape(HATCH, new CANNON.Vec3(-MODEL_CX, ROOF_Y + HATCH.halfExtents.y, 0));
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + k * Math.PI / 2;
      const w = toWorld(-MODEL_CX + Math.cos(a) * 2.3, Math.sin(a) * 2.3);
      lootSpots.push({ x: w.x, y: y + ROOF_Y + 0.12, z: w.z, tower: i });
    }
    towers[i] = { ...towers[i], x: s.x, z: s.z, y, rot: s.rot, roofY: y + ROOF_Y };
  });

  for (const im of meshes) {
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.matrixAutoUpdate = false;
    im.updateMatrix();
    scene.add(im);
  }
  return {
    towers, lootSpots,
    /** True within pad of a tower's footprint. */
    blocks: (x, z, pad = 0) => towers.some(t => Math.hypot(x - t.x, z - t.z) < TOWER_R + pad),
  };
}
