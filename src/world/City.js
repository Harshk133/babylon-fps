import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GROUP_WORLD, GROUP_ZOMBIE } from "../physicsGroups.js";
import { ROAD_HALF, SHOULDER } from "./Roads.js";

// Shivpur, the city: rows of 2–5 storey buildings along a grid of streets
// (Towns.CITY), the way an Indian market town is built.
//
//   Ground floor  an open shop: rolled-up shutter, signboard, shelves and a
//                 counter inside, loot on the floor. You can walk in.
//   Upper floors  solid (not enterable): plastered facade with grilled
//                 windows and sunshades (a canvas texture), balconies on some.
//   Roof          flat, parapet all round, a black water tank on its stand.
//   Back stairs   about half the buildings have a two-lane switchback stair
//                 up the back wall to the roof: rooftop positions over the
//                 streets, with a little loot up there.
//
// Everything is generated from the seed, so every player builds the same
// city. Rendering: every building's parts are merged per CELL-metre square
// and material (a few draw calls per cell), registered with WorldChunks so
// far cells aren't drawn. Physics: one static compound body per building
// (walls, slabs, the solid upper block, parapets, tank, stair columns) and
// one for its stairs and landings, which monsters don't collide with (they
// stay on the ground, like house stairs).

const FH = 3.4;            // floor height (m)
const T = 0.25;            // wall thickness
const BAY = 3.0;           // facade texture tile width (one window)
const SIDEWALK = 1.4;      // m between the road shoulder and a shop front
const LANE = 1.15;         // stair lane width
const STAIR_D = LANE * 2 + 0.3;
const PARAPET = 1.0;
const CELL = 60;           // merge / cull cell (m)

const SIGNS = [
  ["SHARMA KIRANA STORE", "किराना स्टोर", "#1f5f3a"],
  ["AGRAWAL MEDICAL", "मेडिकल", "#0f4f8a"],
  ["MOBILE REPAIRING", "मोबाइल रिपेयरिंग", "#8a1f1f"],
  ["CHAI & NASHTA", "चाय नाश्ता", "#6a3a12"],
  ["GUPTA HARDWARE", "हार्डवेयर", "#3a3a3a"],
  ["LAXMI SAREES", "लक्ष्मी साड़ी", "#7a1450"],
  ["NEW BOMBAY TAILORS", "टेलर्स", "#24407a"],
  ["SAI ELECTRICALS", "इलेक्ट्रिकल्स", "#b05a00"],
];
const WALL_TINTS = [0xf2e6d0, 0xf4c9b8, 0xf6e3a1, 0xc9e2f0, 0xd5ecd0, 0xffffff, 0xe8d0e8, 0xf3d6a4, 0xdfe7e0].map(c => new THREE.Color(c));

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ── Textures ─────────────────────────────────────────────────────────────────
/** One bay of facade (BAY m × one floor): plaster, a grilled window, a sunshade over it. */
function facadeTexture() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 144;
  const g = c.getContext("2d");
  g.fillStyle = "#e9e5dc";
  g.fillRect(0, 0, 128, 144);
  // Weathering: streaks and blotches
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(90, 80, 60, ${Math.random() * 0.06})`;
    g.fillRect(Math.random() * 128, Math.random() * 144, 2 + Math.random() * 10, 2 + Math.random() * 18);
  }
  g.fillStyle = "rgba(60, 50, 40, 0.25)"; g.fillRect(0, 140, 128, 4);          // floor band
  g.fillStyle = "#8d877c"; g.fillRect(26, 30, 76, 8);                           // chajja (sunshade)
  g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(28, 38, 72, 5);                  // its shadow
  g.fillStyle = "#5b4636"; g.fillRect(32, 44, 64, 66);                          // frame
  g.fillStyle = "#24323a"; g.fillRect(36, 48, 56, 58);                          // glass
  g.fillStyle = "rgba(160, 200, 220, 0.22)"; g.fillRect(36, 48, 26, 58);        // reflection
  g.strokeStyle = "#1c1c1c"; g.lineWidth = 2;                                   // grille
  for (let x = 42; x < 92; x += 8) { g.beginPath(); g.moveTo(x, 48); g.lineTo(x, 106); g.stroke(); }
  for (const y of [62, 78, 94]) { g.beginPath(); g.moveTo(36, y); g.lineTo(92, y); g.stroke(); }
  g.fillStyle = "#9a948a"; g.fillRect(28, 110, 72, 6);                         // sill
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Shop signs: SIGNS in a 2 × 4 atlas. */
function signTexture() {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 512;
  const g = c.getContext("2d");
  SIGNS.forEach(([en, hi, bg], i) => {
    const x = (i % 2) * 512, y = Math.floor(i / 2) * 128;
    g.fillStyle = bg; g.fillRect(x, y, 512, 128);
    g.strokeStyle = "#f2c94c"; g.lineWidth = 6; g.strokeRect(x + 6, y + 6, 500, 116);
    g.fillStyle = "#fff6dc"; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = "bold 46px 'Arial Black', Arial, sans-serif";
    g.fillText(en, x + 256, y + 50, 480);
    g.font = "bold 30px 'Nirmala UI', 'Mangal', sans-serif";
    g.fillText(hi, x + 256, y + 98, 480);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ── Geometry helpers (all in a building's local frame, then moved to the world)
function colored(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}
function box(w, h, d, x, y, z, color, rotZ = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotZ) g.rotateZ(rotZ);
  g.translate(x, y, z);
  g.deleteAttribute("uv");
  return colored(g, color);
}

export class City {
  /**
   * def: Towns.CITY. roads: Roads. rng: seeded. base: the city plateau height.
   * blocked(x, z, r): somewhere a building must not go (other than roads).
   */
  constructor({ def, roads, rng, base, blocked = () => false }) {
    this.def = def;
    this.base = base;
    this.buildings = [];
    this.lootSpots = [];
    this._layout(roads, rng, blocked);
  }

  _layout(roads, rng, blocked) {
    const D = this.def, at = {};
    const roadClear = (x, z) => roads.distance(x, z) > ROAD_HALF + SHOULDER + 0.5;
    const placed = this.buildings;
    for (const name of D.streets) {
      const road = roads.byName(name);
      if (!road) continue;
      for (const side of [-1, 1]) {
        let s = 0;
        while (s < road.length) {
          const w = 8 + Math.floor(rng() * 6);          // 8–13 m frontage
          const gap = rng() < 0.5 ? 2.4 : 0.3;           // an alley, or nearly touching the neighbour
          roads.pointAt(road, s + w / 2, at);
          s += w + gap;
          if (at.x < D.x0 - 4 || at.x > D.x1 + 4 || at.z < D.z0 - 4 || at.z > D.z1 + 4) continue;
          const d = 10 + Math.floor(rng() * 4);
          const stair = rng() < 0.5;
          const back = stair ? STAIR_D : 0;
          const nx = at.tz * side, nz = -at.tx * side;   // away from the road, this side
          const off = ROAD_HALF + SHOULDER + SIDEWALK + d / 2;
          const x = at.x + nx * off, z = at.z + nz * off;
          // Front (local +z) toward the road
          const rot = Math.atan2(-nx, -nz);
          const centre = Math.hypot(x - D.x, z - D.z);
          const floors = Math.min(5, 2 + Math.floor(rng() * 3) + (centre < 45 ? 1 : 0));
          const b = { x, z, rot, w, d, floors, stair, back, tint: WALL_TINTS[Math.floor(rng() * WALL_TINTS.length)], sign: Math.floor(rng() * SIGNS.length), balcony: rng() < 0.55, shutter: rng() };
          // Footprint (+ stairs) clear of every road, other buildings and blocked ground
          const pts = this._corners(b, 0.4);
          if (!pts.every(([px, pz]) => roadClear(px, pz))) continue;
          if (pts.some(([px, pz]) => blocked(px, pz, 1))) continue;
          if (placed.some(o => obbOverlap(o, b, 0.25))) continue;
          placed.push(b);
        }
      }
    }
  }

  /** Footprint corners (with the stairs behind), padded, in world space. */
  _corners(b, pad = 0) {
    const c = Math.cos(b.rot), s = Math.sin(b.rot), out = [];
    const z0 = -b.d / 2 - b.back - pad, z1 = b.d / 2 + pad, x0 = -b.w / 2 - pad, x1 = b.w / 2 + pad;
    for (const lx of [x0, 0, x1]) for (const lz of [z0, (z0 + z1) / 2, z1]) out.push([b.x + lx * c + lz * s, b.z - lx * s + lz * c]);
    return out;
  }

  /** Builds meshes and colliders. Needs the final terrain (base height). */
  build({ scene, world, material, mapObstacles, chunks }) {
    const facadeMat = new THREE.MeshStandardMaterial({ map: facadeTexture(), vertexColors: true, roughness: 0.92 });
    const plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    const signMat = new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.6, emissive: 0x222222 });
    const cells = new Map();
    const cellOf = (x, z) => {
      const k = Math.floor(x / CELL) * 4096 + Math.floor(z / CELL);
      if (!cells.has(k)) cells.set(k, { facade: [], plain: [], sign: [], x: 0, z: 0, n: 0 });
      return cells.get(k);
    };
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();

    for (const b of this.buildings) {
      const y0 = this.base;
      const H = b.floors * FH;
      const cell = cellOf(b.x, b.z);
      cell.x += b.x; cell.z += b.z; cell.n++;
      m.compose(p.set(b.x, y0, b.z), q.setFromAxisAngle(up, b.rot), one);
      const facade = [], plain = [], sign = [];
      const solids = [];   // physics boxes [hx, hy, hz, x, y, z]
      const stairs = [];   // physics boxes with tilt [hx, hy, hz, x, y, z, rotZ]
      const solid = (w, h, d, x, y, z) => solids.push([w / 2, h / 2, d / 2, x, y, z]);
      const wall = b.tint, dark = _dark, floorC = _tile, concrete = _concrete;
      const { w, d } = b;
      const fz = d / 2, bz = -d / 2;

      // ── Ground floor: an open shop
      plain.push(box(w, 0.12, d, 0, 0.06, 0, floorC));                                       // tiled floor
      plain.push(box(w, FH, T, 0, FH / 2, bz + T / 2, wall));  solid(w, FH, T, 0, FH / 2, bz + T / 2);
      for (const sx of [-1, 1]) {
        plain.push(box(T, FH, d, sx * (w / 2 - T / 2), FH / 2, 0, wall));
        solid(T, FH, d, sx * (w / 2 - T / 2), FH / 2, 0);
        plain.push(box(0.7, FH, 0.5, sx * (w / 2 - 0.35), FH / 2, fz - 0.25, wall));          // front pillars
        solid(0.7, FH, 0.5, sx * (w / 2 - 0.35), FH / 2, fz - 0.25);
      }
      // Shutter: rolled up (housing only) or part-way down
      const drop = b.shutter < 0.6 ? 0 : b.shutter < 0.85 ? 0.7 : 1.3;
      plain.push(box(w - 1.2, 0.45 + drop, 0.22, 0, FH - 0.55 - drop / 2, fz - 0.15, _shutter));
      if (drop > 0.9) solid(w - 1.2, drop, 0.22, 0, FH - 0.55 - drop / 2, fz - 0.15);
      plain.push(box(w, 0.75, 0.6, 0, FH - 0.1, fz - 0.1, wall));                           // lintel band
      // Inside: shelves along the back wall and a counter
      plain.push(box(w - 1.2, 2.0, 0.45, 0, 1.0, bz + T + 0.25, _wood));
      solid(w - 1.2, 2.0, 0.45, 0, 1.0, bz + T + 0.25);
      for (const y of [0.6, 1.1, 1.6]) plain.push(box(w - 1.3, 0.25, 0.3, 0, y, bz + T + 0.55, SHELF_GOODS[(b.sign + y * 10) % SHELF_GOODS.length | 0]));
      const cx = (b.sign % 2 ? 1 : -1) * (w / 2 - 1.6);
      plain.push(box(0.7, 1.0, d * 0.45, cx, 0.5, -d * 0.05, _wood));
      solid(0.7, 1.0, d * 0.45, cx, 0.5, -d * 0.05);
      // Signboard over the shutter
      const sg = new THREE.PlaneGeometry(Math.min(w - 1, 7.5), 1.0);
      const u0 = (b.sign % 2) * 0.5, v0 = 1 - (Math.floor(b.sign / 2) + 1) * 0.25;
      const uv = sg.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.5, v0 + uv.getY(i) * 0.25);
      sg.translate(0, FH + 0.45, fz + 0.24);
      sign.push(sg.toNonIndexed());

      // ── Upper floors: the solid block, ceiling slab of the shop at its base
      solid(w, H - FH, d, 0, (FH + H) / 2, 0);
      plain.push(box(w, 0.3, d, 0, FH + 0.15, 0, concrete));
      const upper = H - FH;
      if (upper > 0) {
        for (const [face, len] of [["front", w], ["back", w], ["left", d], ["right", d]]) facade.push(facadeQuad(face, len, upper, w, d, FH, wall));
        // Floor bands
        for (let f = 2; f < b.floors; f++) plain.push(box(w + 0.1, 0.18, d + 0.1, 0, f * FH, 0, concrete));
        // Balconies on the front of each upper floor
        if (b.balcony) {
          for (let f = 1; f < b.floors; f++) {
            const by = f * FH;
            const bw = Math.min(w - 2, 5);
            plain.push(box(bw, 0.16, 1.1, 0, by + 0.08, fz + 0.55, concrete));
            plain.push(box(bw, 0.9, 0.06, 0, by + 0.6, fz + 1.07, _rail));
            for (const sx of [-1, 1]) plain.push(box(0.06, 0.9, 1.1, sx * bw / 2, by + 0.6, fz + 0.55, _rail));
            solid(bw, 0.16, 1.1, 0, by + 0.08, fz + 0.55);
          }
        }
      }
      // Roof: slab top is the block's top; parapet round it with a gap where the stairs arrive
      plain.push(box(w, 0.12, d, 0, H + 0.06, 0, _roof));
      // (the top landing is at the end the last flight climbs to)
      const gapX = b.stair ? ((b.floors - 1) % 2 ? -1 : 1) * (w / 2 - 0.6) : null;
      const pw = (len, x, z, along) => {
        plain.push(along ? box(len, PARAPET, T, x, H + PARAPET / 2, z, wall) : box(T, PARAPET, len, x, H + PARAPET / 2, z, wall));
        if (along) solid(len, PARAPET, T, x, H + PARAPET / 2, z); else solid(T, PARAPET, len, x, H + PARAPET / 2, z);
      };
      pw(w, 0, fz - T / 2, true);
      pw(d, -w / 2 + T / 2, 0, false); pw(d, w / 2 - T / 2, 0, false);
      if (gapX === null) pw(w, 0, bz + T / 2, true);
      else {
        // Back parapet in two pieces round a 1.4 m gap at gapX
        const g0 = gapX - 0.7, g1 = gapX + 0.7;
        if (g0 > -w / 2) pw(g0 + w / 2, (g0 - w / 2) / 2, bz + T / 2, true);
        if (g1 < w / 2) pw(w / 2 - g1, (g1 + w / 2) / 2, bz + T / 2, true);
      }
      // Water tank on its stand
      const tx = -(b.sign % 2 ? -1 : 1) * (w / 2 - 1.4), tz = fz - 1.6;
      plain.push(box(1.5, 0.5, 1.5, tx, H + 0.25, tz, concrete));
      const tank = new THREE.CylinderGeometry(0.72, 0.72, 1.35, 12).translate(tx, H + 1.2, tz);
      tank.deleteAttribute("uv");
      plain.push(colored(tank, _tank));
      solid(1.5, 1.9, 1.5, tx, H + 0.95, tz);

      // ── Back stairs: two lanes of switchback flights up to the roof
      if (b.stair) {
        const run = w - 2.4;
        const laneZ = [bz - 0.15 - LANE / 2, bz - 0.15 - LANE * 1.5];
        const slope = Math.atan2(FH, run), len = Math.hypot(run, FH);
        for (let f = 0; f < b.floors; f++) {
          const dir = f % 2 ? -1 : 1;                 // even flights climb toward +x
          const lz = laneZ[f % 2];
          const yA = f * FH;
          const xa = -dir * run / 2;                  // bottom end
          // Steps (drawn) and a ramp (the collider)
          const steps = Math.round(FH / 0.2);
          for (let k = 0; k < steps; k++) {
            const sx = xa + dir * (k + 0.5) * run / steps;
            plain.push(box(run / steps + 0.02, 0.2, LANE, sx, yA + (k + 1) * FH / steps - 0.1, lz, concrete));
          }
          plain.push(box(len, 0.18, LANE, 0, yA + FH / 2 - 0.25, lz, concrete, dir * slope));   // the slab under them
          stairs.push([len / 2, 0.08, LANE / 2, Math.sin(dir * slope) * 0.08, yA + FH / 2 - Math.cos(slope) * 0.08 + 0.1, lz, dir * slope]);
          // Landing at the top end, across both lanes (at the roof: reaching into the parapet gap)
          const xl = dir * (run / 2 + 0.6);
          const top = yA + FH;
          const last = f === b.floors - 1;
          const lz0 = bz - 0.15 - STAIR_D + 0.3, lz1 = last ? bz + 0.6 : bz - 0.15;
          plain.push(box(1.2, 0.2, lz1 - lz0, xl, top - 0.1, (lz0 + lz1) / 2, concrete));
          stairs.push([0.6, 0.1, (lz1 - lz0) / 2, xl, top - 0.1, (lz0 + lz1) / 2, 0]);
          // Columns under the landing, and a rail on the outside
          plain.push(box(0.25, top, 0.25, xl, top / 2, lz0 + 0.12, concrete));
          solid(0.25, top, 0.25, xl, top / 2, lz0 + 0.12);
          plain.push(box(1.2, 0.9, 0.06, xl, top + 0.45, lz0, _rail));
          if (f % 2) plain.push(box(len, 0.06, 0.06, 0, yA + FH / 2 + 0.85, laneZ[1] - LANE / 2, _rail, dir * slope));
        }
      }

      // To the world
      for (const [list, dst] of [[facade, cell.facade], [plain, cell.plain], [sign, cell.sign]]) {
        for (const g of list) { g.applyMatrix4(m); dst.push(g); }
      }
      // Physics
      const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
      for (const [hx, hy, hz, x, y, z] of solids) body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)), new CANNON.Vec3(x, y, z));
      body.position.set(b.x, y0, b.z);
      body.quaternion.setFromEuler(0, b.rot, 0);
      world.addBody(body);
      if (stairs.length) {
        const sb = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD, collisionFilterMask: ~GROUP_ZOMBIE });
        const qz = new CANNON.Quaternion();
        for (const [hx, hy, hz, x, y, z, rz] of stairs) {
          qz.setFromEuler(0, 0, rz);
          sb.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)), new CANNON.Vec3(x, y, z), qz.clone());
        }
        sb.position.set(b.x, y0, b.z);
        sb.quaternion.setFromEuler(0, b.rot, 0);
        world.addBody(sb);
      }
      // Minimap / vehicles: the footprint with its stairs
      const cz = -b.back / 2, c = Math.cos(b.rot), s = Math.sin(b.rot);
      b.fx = b.x + cz * s; b.fz = b.z + cz * c;
      mapObstacles.push({ type: "box", x: b.fx, z: b.fz, w, d: d + b.back, rot: b.rot, city: true });
      // Loot: in the shop, and on the roof when the stairs go up there
      const spot = (lx, ly, lz) => this.lootSpots.push({ x: b.x + lx * c + lz * s, y: y0 + ly, z: b.z - lx * s + lz * c });
      spot(-cx * 0.4, 0.14, d * 0.15);
      if (w > 9) spot(cx * 0.2, 0.14, -d * 0.2);
      if (b.stair) spot(0, H + 0.14, -d * 0.15);
    }

    // One mesh per material per cell
    this.meshes = [];
    for (const cell of cells.values()) {
      for (const [key, mat] of [["facade", facadeMat], ["plain", plainMat], ["sign", signMat]]) {
        if (!cell[key].length) continue;
        const geo = mergeGeometries(cell[key], false);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = key !== "sign";
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        scene.add(mesh);
        chunks?.addMesh(mesh);
        this.meshes.push(mesh);
      }
    }
  }

  _local(b, x, z, out) {
    const dx = x - b.x, dz = z - b.z, c = Math.cos(b.rot), s = Math.sin(b.rot);
    out.x = dx * c - dz * s;
    out.z = dx * s + dz * c;
    return out;
  }

  /** The building whose footprint (+ stairs, + pad) holds (x, z), or null. */
  buildingAt(x, z, pad = 0) {
    for (const b of this.buildings) {
      if (Math.abs(x - b.x) > b.w + b.d + pad || Math.abs(z - b.z) > b.w + b.d + pad) continue;
      this._local(b, x, z, _l);
      if (Math.abs(_l.x) < b.w / 2 + pad && _l.z < b.d / 2 + pad && _l.z > -b.d / 2 - b.back - pad) return b;
    }
    return null;
  }

  /** True inside a shop (under its ceiling): rain and visibility use it. feetY: height of the feet. */
  inside(x, z, feetY = null) {
    const b = this.buildingAt(x, z);
    if (!b) return false;
    this._local(b, x, z, _l);
    if (_l.z < -b.d / 2) return false;   // the stairs are outdoors
    return feetY === null || feetY < this.base + FH - 0.5;
  }

  /** Keeps trees, rocks, plots, grass and spawns off the buildings. */
  blocks(x, z, pad = 1) { return !!this.buildingAt(x, z, pad); }

  /** Inside the city's paved area (a little round the blocks). */
  inArea(x, z, pad = 0) {
    const D = this.def;
    return x > D.x0 - 14 - pad && x < D.x1 + 14 + pad && z > D.z0 - 14 - pad && z < D.z1 + 14 + pad;
  }

  /** buildTerrain tint: dusty paving through the city. */
  tint(x, z, c) {
    const D = this.def;
    const e = Math.min(x - (D.x0 - 16), (D.x1 + 16) - x, z - (D.z0 - 16), (D.z1 + 16) - z);
    if (e <= 0) return;
    c.lerp(_paving, smooth(0, 8, e) * 0.85);
  }
}

/** A facade wall (local frame) for the upper floors, UVs in bays and floors. */
function facadeQuad(face, len, h, w, d, y0, color) {
  const g = new THREE.PlaneGeometry(len, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(1, Math.round(len / BAY)), uv.getY(i) * Math.round(h / FH));
  const out = 0.02;
  if (face === "front") g.translate(0, y0 + h / 2, d / 2 + out);
  else if (face === "back") { g.rotateY(Math.PI); g.translate(0, y0 + h / 2, -d / 2 - out); }
  else if (face === "left") { g.rotateY(-Math.PI / 2); g.translate(-w / 2 - out, y0 + h / 2, 0); }
  else { g.rotateY(Math.PI / 2); g.translate(w / 2 + out, y0 + h / 2, 0); }
  return colored(g, color);
}

/** Do two buildings' footprints (+ stairs) overlap (with a gap)? Separating axes on two rectangles. */
function obbOverlap(a, b, gap) {
  const rect = o => {
    const c = Math.cos(o.rot), s = Math.sin(o.rot), cz = -o.back / 2;
    return { x: o.x + cz * s, z: o.z + cz * c, hx: o.w / 2 + gap, hz: (o.d + o.back) / 2 + gap, ax: [c, -s], az: [s, c] };
  };
  const A = rect(a), B = rect(b);
  const dx = B.x - A.x, dz = B.z - A.z;
  for (const axis of [A.ax, A.az, B.ax, B.az]) {
    const proj = (R) => R.hx * Math.abs(R.ax[0] * axis[0] + R.ax[1] * axis[1]) + R.hz * Math.abs(R.az[0] * axis[0] + R.az[1] * axis[1]);
    if (Math.abs(dx * axis[0] + dz * axis[1]) > proj(A) + proj(B)) return false;
  }
  return true;
}

const _l = { x: 0, z: 0 };
const lin = hex => new THREE.Color(hex);
const _dark = lin(0x2a2a2a), _tile = lin(0xb8ab98), _concrete = lin(0xa39c90), _shutter = lin(0x7d8186);
const _wood = lin(0x6b4a2e), _rail = lin(0x3a3d40), _roof = lin(0x8f887e), _tank = lin(0x1b1b1b), _paving = new THREE.Color(0.66, 0.6, 0.52);
const SHELF_GOODS = [0xc23b22, 0xe0b23c, 0x2f7d4a, 0x2a5aa0, 0xdcdcdc, 0x8a3c8a].map(c => new THREE.Color(c));
