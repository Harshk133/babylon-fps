import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GROUP_WORLD } from "../physicsGroups.js";
import {
  CAMPUS_BUILDINGS, CRICKET, FIELD_POLY, RED_STRIP, WALL, WALL_GAPS, KEEP_OUT, AREA, AREA_BOX,
  TREE_CLUSTERS, TREE_ROWS, px, inPoly, polyEdgeDist, inCampusArea, SCALE,
} from "./CampusLayout.js";

// The college campus round the cricket ground (layout: CampusLayout.js, traced
// from the satellite picture). Everything that isn't already in the game: the
// academic blocks, the main building, the blocks east of the ground, the
// boundary wall, the cricket ground (pitch, square, rope, sight screens) and
// lamp posts along the campus roads. The roads themselves are ordinary roads
// (world/Roads.js, CAMPUS_ROADS) so they level the ground and show on the maps.
//
// Buildings are solid RCC blocks (not enterable): plinth, painted walls with a
// window per bay (one canvas texture), floor bands, a flat roof with a parapet,
// water tanks and a stair head; some have a corridor (verandah) with columns
// along one side, which you can walk along on the ground floor. Drawing: every
// part merged into three meshes per 60 m cell (facade, plain, pitch). Physics:
// one static compound body per building, one per wall run.

const FH = 3.6;            // floor height (m)
const BAY = 3.2;           // window bay width (m)
const PARAPET = 0.95;
const PLINTH = 0.18;
const VER_D = 2.5;         // verandah depth
const COL = 0.38;          // verandah column size
const APRON = 1.6;         // concrete apron round a building
const WALL_H = 2.1, WALL_T = 0.24, PANEL = 4;
const CELL = 60;           // merge / cull cell (m)
const LAMP_EVERY = 30;     // m between lamp posts along a campus road

const lin = hex => new THREE.Color(hex);
const _concrete = lin(0xa8a196), _band = lin(0xb9ae9a), _plinth = lin(0x6d665e), _roof = lin(0x8d877d), _tank = lin(0x1d1f1d);
const _door = lin(0x4a3524), _white = lin(0xf4f4ef), _rail = lin(0x3b3e40), _wall = lin(0xd8cdb6), _coping = lin(0xb3a88f);
const _stump = lin(0xe8dcb8), _lamp = lin(0x55595c);
const _turf = new THREE.Color(0.86, 1.0, 0.8), _turf2 = new THREE.Color(0.78, 0.94, 0.72);
const _turfDry = new THREE.Color(0.72, 0.7, 0.45);
const _square = new THREE.Color(0.95, 0.96, 0.78), _redEarth = new THREE.Color(0.85, 0.5, 0.36);

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ── Textures ─────────────────────────────────────────────────────────────────
/** One bay × one floor of an Indian college block: plaster, a wide window with a chajja over it. */
function facadeTexture() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 144;
  const g = c.getContext("2d");
  g.fillStyle = "#f2efe8";
  g.fillRect(0, 0, 128, 144);
  for (let i = 0; i < 220; i++) {
    g.fillStyle = `rgba(95, 85, 65, ${Math.random() * 0.05})`;
    g.fillRect(Math.random() * 128, Math.random() * 144, 2 + Math.random() * 8, 3 + Math.random() * 22);
  }
  g.fillStyle = "rgba(70, 60, 45, 0.18)"; g.fillRect(0, 138, 128, 6);           // floor band shadow
  g.fillStyle = "#9d978c"; g.fillRect(12, 26, 104, 7);                          // chajja
  g.fillStyle = "rgba(0,0,0,0.22)"; g.fillRect(14, 33, 100, 6);
  g.fillStyle = "#3f5547"; g.fillRect(18, 42, 92, 70);                          // green-painted frame
  g.fillStyle = "#1f2b30"; g.fillRect(22, 46, 84, 62);                          // glass
  g.fillStyle = "rgba(170, 205, 220, 0.25)"; g.fillRect(22, 46, 40, 62);        // reflection
  g.fillStyle = "#3f5547";
  g.fillRect(62, 46, 4, 62); g.fillRect(22, 74, 84, 3);                         // mullion, transom
  g.strokeStyle = "rgba(20,20,20,0.8)"; g.lineWidth = 1.5;                      // grille
  for (let x = 30; x < 106; x += 8) { g.beginPath(); g.moveTo(x, 77); g.lineTo(x, 108); g.stroke(); }
  g.fillStyle = "#a39d92"; g.fillRect(14, 112, 100, 5);                         // sill
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Close-mown grass, tiled every 4 m (the stripes come from the vertex colours). */
function turfTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#c8d8b0"; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2600; i++) {
    const v = 150 + Math.random() * 105 | 0;
    g.fillStyle = `rgba(${v - 30}, ${v}, ${v - 70}, 0.5)`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 1, 2 + Math.random() * 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** The pitch: rolled clay, worn ends, white creases (length along v). */
function pitchTexture() {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 512;
  const g = c.getContext("2d");
  const grd = g.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0, "#a88f62"); grd.addColorStop(0.15, "#c2aa78"); grd.addColorStop(0.5, "#cdb788");
  grd.addColorStop(0.85, "#c2aa78"); grd.addColorStop(1, "#a88f62");
  g.fillStyle = grd; g.fillRect(0, 0, 64, 512);
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(80, 60, 30, ${Math.random() * 0.12})`;
    g.fillRect(Math.random() * 64, Math.random() * 512, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  // Creases: popping crease 1.22 m in front of the stumps, return creases, bowling crease at the stumps
  g.fillStyle = "#f5f3ea";
  const L = 22.12, m = y => y / L * 512;   // texture spans 22.12 m (1 m past each set of stumps)
  for (const end of [1, L - 1]) {
    const dir = end < L / 2 ? 1 : -1;
    g.fillRect(0, m(end) - 1, 64, 2);                         // bowling crease
    g.fillRect(0, m(end + dir * 1.22) - 1, 64, 2);            // popping crease
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────
function colored(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b; }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}
function box(w, h, d, x, y, z, color, rotY = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  g.deleteAttribute("uv");
  return colored(g, color);
}
function cyl(r, h, x, y, z, color, seg = 10) {
  const g = new THREE.CylinderGeometry(r, r, h, seg).translate(x, y, z);
  g.deleteAttribute("uv");
  return colored(g, color);
}
/** A wall plane facing out of the side `face` (n / s / e / w), from u0 to u1 along it, with window bays. */
function facadePlane(face, part, u0, u1, h, color) {
  const len = u1 - u0;
  const g = new THREE.PlaneGeometry(len, h);
  const uv = g.attributes.uv;
  const bays = Math.max(1, Math.round(len / BAY)), floors = Math.max(1, Math.round(h / FH));
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * bays, uv.getY(i) * floors);
  const mid = (u0 + u1) / 2, out = 0.015;
  const { x, z, w, d } = part;
  if (face === "n") g.translate(mid, h / 2, z + d / 2 + out);
  else if (face === "s") { g.rotateY(Math.PI); g.translate(mid, h / 2, z - d / 2 - out); }
  else if (face === "w") { g.rotateY(-Math.PI / 2); g.translate(x - w / 2 - out, h / 2, -mid); }
  else { g.rotateY(Math.PI / 2); g.translate(x + w / 2 + out, h / 2, -mid); }
  return colored(g, color);
}

/**
 * The stretches of a part's side that are open air (not inside another part
 * of the same building), as [from, to] along the side: x for n / s, −z for e / w
 * (so "along" runs left to right seen from outside on the n and e sides).
 */
function openRuns(parts, i, face) {
  const p = parts[i];
  const ns = face === "n" || face === "s";
  const fixed = face === "n" ? p.z + p.d / 2 : face === "s" ? p.z - p.d / 2 : face === "e" ? p.x + p.w / 2 : p.x - p.w / 2;
  let runs = ns ? [[p.x - p.w / 2, p.x + p.w / 2]] : [[-(p.z + p.d / 2), -(p.z - p.d / 2)]];
  for (let j = 0; j < parts.length; j++) {
    if (j === i) continue;
    const q = parts[j];
    const inside = ns ? fixed > q.z - q.d / 2 + 0.01 && fixed < q.z + q.d / 2 - 0.01 : fixed > q.x - q.w / 2 + 0.01 && fixed < q.x + q.w / 2 - 0.01;
    if (!inside) continue;
    const [a, b] = ns ? [q.x - q.w / 2, q.x + q.w / 2] : [-(q.z + q.d / 2), -(q.z - q.d / 2)];
    const next = [];
    for (const [r0, r1] of runs) {
      if (b <= r0 || a >= r1) { next.push([r0, r1]); continue; }
      if (a > r0) next.push([r0, a]);
      if (b < r1) next.push([b, r1]);
    }
    runs = next;
  }
  return runs.filter(([a, b]) => b - a > 0.2);
}

export class Campus {
  constructor() {
    this.buildings = CAMPUS_BUILDINGS;
    this.rects = [];          // solid footprints in the world: { x, z, c, s, hw, hd }
    this.lootSpots = [];
    this.y = 0;
    this._area = AREA_BOX;
  }

  // ── Layout queries (usable before build) ─────────────────────────────────
  /** Inside the campus grounds (+ pad): houses, fields, plots, scattered trees and rocks keep out. */
  area(x, z, pad = 0) {
    const b = this._area;
    if (x < b.x0 - pad || x > b.x1 + pad || z < b.z0 - pad || z > b.z1 + pad) return false;
    return inCampusArea(x, z, pad);
  }
  /** On the cricket field (inside the rope, + pad). */
  onField(x, z, pad = 0) {
    const dx = (x - CRICKET.x) / (CRICKET.rx * CRICKET.rope + pad), dz = (z - CRICKET.z) / (CRICKET.rz * CRICKET.rope + pad);
    return dx * dx + dz * dz < 1;
  }
  /** A building, verandah, sight screen or the wall here (+ pad)? Filled in by layout() / build(). */
  blocks(x, z, pad = 0) {
    const b = this._area;
    if (x < b.x0 - pad - 4 || x > b.x1 + pad + 4 || z < b.z0 - pad - 4 || z > b.z1 + pad + 4) return false;
    for (const r of this.rects) {
      const dx = x - r.x, dz = z - r.z;
      if (Math.abs(dx) > r.reach + pad || Math.abs(dz) > r.reach + pad) continue;
      const lx = dx * r.c - dz * r.s, lz = dx * r.s + dz * r.c;
      if (Math.abs(lx) < r.hw + pad && Math.abs(lz) < r.hd + pad) return true;
    }
    return false;
  }
  /** Flat pads for the terrain (all at height y): discs filling the campus, clear of the workshop's and CSE building's own. */
  pads(y) {
    const out = [];
    const b = this._area;
    for (let x = b.x0 + 8; x <= b.x1; x += 24) {
      for (let z = b.z0 + 8; z <= b.z1; z += 24) {
        if (!inPoly(x, z, AREA)) continue;
        if (KEEP_OUT.some(k => Math.hypot(x - k.x, z - k.z) < k.r + 26)) continue;
        out.push({ x, z, r: 16, fade: 16, y });
      }
    }
    return out;
  }
  /** buildTerrain tint: the cricket field's turf (mowing stripes, the square), the red strip by the south road. */
  tint(x, z, c) {
    const b = this._area;
    if (x < b.x0 - 4 || x > b.x1 + 4 || z < b.z0 - 4 || z > b.z1 + 4) return;
    if (inPoly(x, z, RED_STRIP)) { c.lerp(_redEarth, 0.85); return; }
    if (!inPoly(x, z, FIELD_POLY)) return;
    const edge = smooth(0, 6, polyEdgeDist(x, z, FIELD_POLY));
    // Mown in 5 m stripes across the ground; a lighter, drier square round the pitch
    const stripe = Math.floor((z - CRICKET.z) / 5) & 1 ? _turf : _turf2;
    const dx = Math.abs(x - CRICKET.x), dz = Math.abs(z - CRICKET.z);
    const sq = (1 - smooth(CRICKET.square[0] * 0.5, CRICKET.square[0] * 0.5 + 3, dx)) * (1 - smooth(CRICKET.square[1] * 0.5, CRICKET.square[1] * 0.5 + 3, dz));
    c.lerp(stripe, 0.9 * edge).lerp(_square, sq * 0.8);
  }
  /** Grass tufts: none on the playing area (it's mown) or round the buildings, a thin edge round the field. */
  grass(x, z) {
    const b = this._area;
    if (x < b.x0 - 4 || x > b.x1 + 4 || z < b.z0 - 4 || z > b.z1 + 4) return 1;
    if (this.onField(x, z, 3)) return 0;
    if (inPoly(x, z, FIELD_POLY)) return 0.35;
    if (this.blocks(x, z, APRON + 0.6)) return 0;
    return 1;
  }

  /** Footprints of the buildings (and their verandahs and porches): call before build to answer blocks(). */
  layout() {
    this.rects.length = 0;
    for (const b of this.buildings) {
      const c = Math.cos(b.rot), s = Math.sin(b.rot);
      const add = (lx, lz, hw, hd) => {
        const x = b.x + lx * c + lz * s, z = b.z - lx * s + lz * c;
        this.rects.push({ x, z, c, s, hw, hd, rot: b.rot, reach: Math.hypot(hw, hd), building: b });
      };
      b.parts.forEach(p => add(p.x, p.z, p.w / 2, p.d / 2));
      const v = this._verandah(b);
      if (v) add(v.x, v.z, v.w / 2, v.d / 2);
      const po = this._porch(b);
      if (po) add(po.x, po.z, po.w / 2, po.d / 2);
    }
    // Sight screens behind each end of the pitch
    for (const sgn of [-1, 1]) {
      this.rects.push({ x: CRICKET.x, z: CRICKET.z + sgn * (CRICKET.rz * CRICKET.rope - 4), c: 1, s: 0, hw: 4.6, hd: 0.5, rot: 0, reach: 4.7, screen: true });
    }
    return this;
  }
  /** The verandah strip (building frame) along the first part's side, or null. */
  _verandah(b) {
    if (!b.verandah) return null;
    const p = b.parts[0];
    switch (b.verandah) {
      case "n": return { x: p.x, z: p.z + p.d / 2 + VER_D / 2, w: p.w, d: VER_D, face: "n" };
      case "s": return { x: p.x, z: p.z - p.d / 2 - VER_D / 2, w: p.w, d: VER_D, face: "s" };
      case "e": return { x: p.x + p.w / 2 + VER_D / 2, z: p.z, w: VER_D, d: p.d, face: "e" };
      default: return { x: p.x - p.w / 2 - VER_D / 2, z: p.z, w: VER_D, d: p.d, face: "w" };
    }
  }
  /** The entrance porch: in front of the verandah at the middle of the first part. */
  _porch(b) {
    if (!b.porch || b.verandah !== "n") return null;
    const p = b.parts[0];
    return { x: p.x, z: p.z + p.d / 2 + VER_D + 2.2, w: 8, d: 4.4 };
  }

  /**
   * Builds it all. groundAt(x, z): the finished terrain. roads: world/Roads.js (the
   * lamp posts go along the campus roads). river: keeps the wall off the lake's bank.
   */
  build({ scene, world, material, groundAt, roads, river, mapObstacles, navObstacles, chunks }) {
    if (!this.rects.length) this.layout();
    const facadeMat = new THREE.MeshStandardMaterial({ map: facadeTexture(), vertexColors: true, roughness: 0.9 });
    const plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1cc, emissive: 0xffe2a8, emissiveIntensity: 0.6, roughness: 0.5 });
    const pitchMat = new THREE.MeshStandardMaterial({ map: pitchTexture(), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const cells = new Map();
    const cellOf = (x, z) => {
      const k = Math.floor(x / CELL) * 4096 + Math.floor(z / CELL);
      if (!cells.has(k)) cells.set(k, { facade: [], plain: [], lamp: [], pitch: [] });
      return cells.get(k);
    };
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
    const toCell = (list, dst, x, y, z, rot) => {
      m.compose(pos.set(x, y, z), q.setFromAxisAngle(up, rot), one);
      for (const g of list) { g.applyMatrix4(m); dst.push(g); }
    };
    const nav = o => { mapObstacles.push(o); navObstacles.push(o); };

    // ── Buildings
    for (const b of this.buildings) {
      const y0 = groundAt(b.x, b.z);
      this.y = y0;
      const H = b.floors * FH;
      const tint = new THREE.Color(b.tint);
      const facade = [], plain = [], solids = [];
      const solid = (w, h, d, x, y, z) => solids.push([w / 2, h / 2, d / 2, x, y, z]);
      b.parts.forEach((p, i) => {
        const roofY = H + i * 0.012;   // no z-fighting where two parts' roofs overlap
        solid(p.w, H, p.d, p.x, H / 2, p.z);
        plain.push(box(p.w + APRON * 2, 0.06, p.d + APRON * 2, p.x, 0.03, p.z, _concrete));
        // (the plinth runs a metre into the ground: no gap where the ground dips at a corner)
        plain.push(box(p.w + 0.3, PLINTH * 2 + 1, p.d + 0.3, p.x, PLINTH - 0.5, p.z, _plinth));
        plain.push(box(p.w, 0.22, p.d, p.x, roofY + 0.11, p.z, _roof));
        for (const face of ["n", "s", "e", "w"]) {
          for (const [u0, u1] of openRuns(b.parts, i, face)) {
            facade.push(facadePlane(face, p, u0, u1, H, tint));
            // Floor bands and the parapet along the same open stretch
            const len = u1 - u0, mid = (u0 + u1) / 2;
            const ns = face === "n" || face === "s";
            const off = face === "n" ? p.z + p.d / 2 : face === "s" ? p.z - p.d / 2 : face === "e" ? p.x + p.w / 2 : p.x - p.w / 2;
            const along = (w, h, d, y, color, inset = 0) => ns
              ? box(len, h, d, mid, y, off + (face === "n" ? -inset : inset), color)
              : box(d, h, len, off + (face === "e" ? -inset : inset), y, -mid, color);
            for (let f = 1; f < b.floors; f++) plain.push(along(len, 0.22, 0.34, f * FH, _band));
            plain.push(along(len, 0.24, 0.42, H + 0.04, _band));                                     // roof band
            plain.push(along(len, PARAPET, 0.2, roofY + 0.22 + PARAPET / 2, tint, 0.1));
            if (ns) solid(len, PARAPET, 0.2, mid, roofY + 0.22 + PARAPET / 2, off + (face === "n" ? -0.1 : 0.1));
            else solid(0.2, PARAPET, len, off + (face === "e" ? -0.1 : 0.1), roofY + 0.22 + PARAPET / 2, -mid);
          }
        }
      });
      // Doors on the ground floor: the middle of the verandah side, else the longest side
      const p0 = b.parts[0];
      const doorFace = b.verandah ?? (p0.w >= p0.d ? "s" : "e");
      const dn = doorFace === "n" ? 1 : doorFace === "s" ? -1 : 0, de = doorFace === "e" ? 1 : doorFace === "w" ? -1 : 0;
      const along = dn ? p0.w : p0.d;
      const doors = along > 24 ? [-along / 4, along / 4] : [0];
      for (const t of doors) {
        const dx = dn ? p0.x + t : p0.x + de * (p0.w / 2 + 0.04), dz = dn ? p0.z + dn * (p0.d / 2 + 0.04) : p0.z + t;
        plain.push(dn ? box(1.8, 2.4, 0.1, dx, PLINTH * 2 + 1.2, dz, _door) : box(0.1, 2.4, 1.8, dx, PLINTH * 2 + 1.2, dz, _door));
      }
      // Verandah: columns, a slab over each floor, a rail along the upper ones
      const v = this._verandah(b);
      if (v) {
        const ns = v.face === "n" || v.face === "s";
        const len = ns ? v.w : v.d;
        const outer = ns ? v.z + (v.face === "n" ? VER_D / 2 - COL / 2 : -VER_D / 2 + COL / 2) : v.x + (v.face === "e" ? VER_D / 2 - COL / 2 : -VER_D / 2 + COL / 2);
        const n = Math.max(2, Math.round(len / 3.6));
        for (let k = 0; k <= n; k++) {
          const a = -len / 2 + COL / 2 + (len - COL) * k / n;
          const cx = ns ? v.x + a : outer, cz = ns ? outer : v.z + a;
          plain.push(box(COL, H, COL, cx, H / 2, cz, tint));
          solid(COL, H, COL, cx, H / 2, cz);
        }
        plain.push(box(v.w, 0.12, v.d, v.x, 0.06, v.z, _concrete));                                  // corridor floor
        for (let f = 1; f <= b.floors; f++) {
          plain.push(box(v.w, 0.2, v.d, v.x, f * FH - 0.1, v.z, f === b.floors ? _roof : _concrete));
          solid(v.w, 0.2, v.d, v.x, f * FH - 0.1, v.z);
          if (f < b.floors) {
            const rw = ns ? v.w : 0.14, rd = ns ? 0.14 : v.d;
            const rx = ns ? v.x : outer, rz = ns ? outer : v.z;
            plain.push(box(rw, 0.95, rd, rx, f * FH + 0.48, rz, tint));
            solid(rw, 0.95, rd, rx, f * FH + 0.48, rz);
          }
        }
        plain.push(ns ? box(v.w, 0.5, 0.16, v.x, H + 0.25, outer, tint) : box(0.16, 0.5, v.d, outer, H + 0.25, v.z, tint));
      }
      // Porch: four big columns and a slab over the entrance
      const po = this._porch(b);
      if (po) {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          const cx = po.x + sx * (po.w / 2 - 0.35), cz = po.z + sz * (po.d / 2 - 0.35);
          plain.push(box(0.6, FH * 1.4, 0.6, cx, FH * 0.7, cz, _white));
          solid(0.6, FH * 1.4, 0.6, cx, FH * 0.7, cz);
        }
        plain.push(box(po.w + 0.6, 0.35, po.d + VER_D, po.x, FH * 1.4 + 0.17, po.z - VER_D / 2, _white));
        plain.push(box(po.w + 0.6, 0.6, 0.2, po.x, FH * 1.4 + 0.6, po.z + po.d / 2 + 0.2, tint));
        plain.push(box(po.w, 0.3, po.d, po.x, 0.15, po.z, _concrete));                              // steps
      }
      // Roof: a stair head on the first part, water tanks on stands
      const sh = { x: p0.x + p0.w / 2 - 2.2, z: p0.z - p0.d / 2 + 2.0 };
      plain.push(box(3.4, 2.7, 3.0, sh.x, H + 0.22 + 1.35, sh.z, tint));
      plain.push(box(3.8, 0.18, 3.4, sh.x, H + 0.22 + 2.79, sh.z, _roof));
      solid(3.4, 2.7, 3.0, sh.x, H + 0.22 + 1.35, sh.z);
      const area = b.parts.reduce((a, p) => a + p.w * p.d, 0);
      const tanks = area > 600 ? 3 : area > 220 ? 2 : 1;
      for (let k = 0; k < tanks; k++) {
        const p = b.parts[k % b.parts.length];
        const tx = p.x - p.w / 2 + 2.2 + k * 2.6, tz = p.z + p.d / 2 - 2.2;
        plain.push(box(2.0, 0.8, 2.0, tx, H + 0.22 + 0.4, tz, _concrete));
        plain.push(cyl(0.85, 1.6, tx, H + 0.22 + 0.8 + 0.8, tz, _tank, 12));
        solid(2.0, 2.4, 2.0, tx, H + 0.22 + 1.2, tz);
      }

      const cell = cellOf(b.x, b.z);
      toCell(facade, cell.facade, b.x, y0, b.z, b.rot);
      toCell(plain, cell.plain, b.x, y0, b.z, b.rot);
      const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
      for (const [hx, hy, hz, x, y, z] of solids) body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)), new CANNON.Vec3(x, y, z));
      body.position.set(b.x, y0, b.z);
      body.quaternion.setFromEuler(0, b.rot, 0);
      world.addBody(body);
      // A loot spot or two on the verandah / beside the door
      const c = Math.cos(b.rot), s = Math.sin(b.rot);
      const spot = (lx, lz) => this.lootSpots.push({ x: b.x + lx * c + lz * s, y: y0 + 0.14, z: b.z - lx * s + lz * c });
      if (v) { spot(v.x + (v.face === "e" || v.face === "w" ? 0 : -v.w / 4), v.z); spot(v.x + (v.face === "e" || v.face === "w" ? 0 : v.w / 4), v.z); }
    }
    // Minimap, vehicles and monster pathing: every footprint
    for (const r of this.rects) {
      if (r.screen) continue;
      nav({ type: "box", x: r.x, z: r.z, rot: r.rot, w: r.hw * 2, d: r.hd * 2, hw: r.hw, hd: r.hd, campus: true });
    }

    // ── Cricket ground: mown turf, the pitch, the stumps, the boundary rope, two sight screens
    {
      const { x, z } = CRICKET;
      const y = groundAt(x, z);
      const cell = cellOf(x, z);
      // Turf: a grid of 2 m cells over the open ground (off the roads), stripes mown north-south
      // in 5 m bands, a little drier toward its edge; it lies on the campus's flat pad
      const T = 2, verts = [], cols = [], uvs = [];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [fx, fz] of FIELD_POLY) { x0 = Math.min(x0, fx); x1 = Math.max(x1, fx); z0 = Math.min(z0, fz); z1 = Math.max(z1, fz); }
      const col = new THREE.Color();
      for (let gx = Math.floor(x0 / T) * T; gx < x1; gx += T) {
        for (let gz = Math.floor(z0 / T) * T; gz < z1; gz += T) {
          const cx = gx + T / 2, cz = gz + T / 2;
          if (!inPoly(cx, cz, FIELD_POLY) || roads.onRoad(cx, cz, 0.4) || polyEdgeDist(cx, cz, FIELD_POLY) < 1) continue;
          if (KEEP_OUT.some(k => Math.hypot(cx - k.x, cz - k.z) < k.r + 8)) continue;   // the workshop's pad slopes there
          const corners = [[gx, gz], [gx + T, gz], [gx + T, gz + T], [gx, gz + T]];
          const hy = corners.map(([a, b]) => groundAt(a, b) + 0.05);
          const stripe = Math.floor((cx - x) / 5) & 1;
          const dry = 1 - smooth(1, 9, polyEdgeDist(cx, cz, FIELD_POLY));
          const inside = this.onField(cx, cz, 0) ? 1 : 0.92;
          col.setRGB(0.62, 0.78, 0.42).multiplyScalar((stripe ? 1.0 : 0.88) * inside).lerp(_turfDry, dry * 0.6);
          for (const k of [0, 2, 1, 0, 3, 2]) {
            verts.push(corners[k][0], hy[k], corners[k][1]);
            uvs.push(corners[k][0] / 4, corners[k][1] / 4);
            cols.push(col.r, col.g, col.b);
          }
        }
      }
      if (verts.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
        g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
        g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
        g.computeVertexNormals();
        g.computeBoundingSphere();
        const turf = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
          map: turfTexture(), vertexColors: true, roughness: 0.96, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        }));
        turf.receiveShadow = true;
        turf.matrixAutoUpdate = false;
        turf.updateMatrix();
        scene.add(turf);
        chunks?.addMesh(turf);
        (this.meshes ??= []).push(turf);
      }
      const pitch = new THREE.PlaneGeometry(CRICKET.pitchW + 0.6, CRICKET.pitchL + 2).rotateX(-Math.PI / 2).translate(x, y + 0.035, z);
      cell.pitch.push(pitch);
      const plain = [];
      for (const end of [-1, 1]) {
        const sz = z + end * CRICKET.pitchL / 2;
        for (const k of [-1, 0, 1]) plain.push(cyl(0.02, 0.71, x + k * 0.1, y + 0.36, sz, _stump, 6));
      }
      // Rope: a low white ribbon round the oval
      const N = 120, rx = CRICKET.rx * CRICKET.rope, rz = CRICKET.rz * CRICKET.rope;
      for (let i = 0; i < N; i++) {
        const a0 = i / N * Math.PI * 2, a1 = (i + 1) / N * Math.PI * 2;
        const x0 = x + Math.cos(a0) * rx, z0 = z + Math.sin(a0) * rz, x1 = x + Math.cos(a1) * rx, z1 = z + Math.sin(a1) * rz;
        const len = Math.hypot(x1 - x0, z1 - z0), mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
        plain.push(box(len + 0.05, 0.08, 0.12, mx, groundAt(mx, mz) + 0.05, mz, _white, -Math.atan2(z1 - z0, x1 - x0)));
      }
      for (const r of this.rects) {
        if (!r.screen) continue;
        const gy = groundAt(r.x, r.z);
        plain.push(box(9, 3.6, 0.2, r.x, gy + 0.5 + 1.8, r.z, _white));
        for (const sx of [-4.2, 0, 4.2]) plain.push(box(0.14, 0.6, 0.9, r.x + sx, gy + 0.3, r.z, _rail));
        const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
        body.addShape(new CANNON.Box(new CANNON.Vec3(4.5, 2.05, 0.3)));
        body.position.set(r.x, gy + 2.05, r.z);
        world.addBody(body);
        mapObstacles.push({ type: "box", x: r.x, z: r.z, rot: 0, w: 9, d: 0.6, hw: 4.5, hd: 0.3, campus: true });
      }
      cell.plain.push(...plain);
    }

    // ── Boundary wall: panels between piers, following the ground; gaps at the back gate,
    // the lake's bank and the existing grounds
    {
      const skip = (x, z) => WALL_GAPS.some(g => Math.hypot(x - g.at[0], z - g.at[1]) < g.hw)
        || KEEP_OUT.some(k => Math.hypot(x - k.x, z - k.z) < k.r) || !!river?.wet(x, z, 1.5) || roads.onRoad(x, z, 0.6);
      for (let i = 0; i < WALL.length - 1; i++) {
        const [ax, az] = WALL[i], [bx, bz] = WALL[i + 1];
        const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / PANEL));
        const ux = (bx - ax) / L, uz = (bz - az) / L;
        const rot = -Math.atan2(uz, ux);         // local +X along the wall
        let run = null;                          // the panels of one unbroken stretch: one body, one obstacle
        const flush = () => {
          if (!run || !run.shapes.length) { run = null; return; }
          const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
          for (const [hx, hy, hz, x, y, z] of run.shapes) body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)), new CANNON.Vec3(x, y, z));
          body.position.set(run.x, run.y, run.z);
          body.quaternion.setFromEuler(0, rot, 0);
          world.addBody(body);
          const len = run.t1 - run.t0, mid = (run.t0 + run.t1) / 2;
          const o = { type: "box", x: ax + ux * mid, z: az + uz * mid, rot, w: len, d: WALL_T, hw: len / 2, hd: WALL_T / 2, wall: true, campus: true };
          mapObstacles.push(o);
          navObstacles.push(o);
          run = null;
        };
        for (let k = 0; k < n; k++) {
          const t0 = k * L / n, t1 = (k + 1) * L / n, tm = (t0 + t1) / 2;
          const mx = ax + ux * tm, mz = az + uz * tm;
          if (skip(mx, mz)) { flush(); continue; }
          const gy = Math.min(groundAt(ax + ux * t0, az + uz * t0), groundAt(mx, mz), groundAt(ax + ux * t1, az + uz * t1));
          if (!run) run = { x: mx, y: gy, z: mz, tm0: tm, t0, t1, shapes: [] };
          run.t1 = t1;
          const cell = cellOf(mx, mz);
          const len = t1 - t0;
          const g = [box(len, WALL_H + 0.3, WALL_T, 0, (WALL_H + 0.3) / 2 - 0.3, 0, _wall),
            box(len + 0.04, 0.08, WALL_T + 0.08, 0, WALL_H + 0.04, 0, _coping),
            box(0.42, WALL_H + 0.55, 0.42, -len / 2, (WALL_H + 0.55) / 2 - 0.3, 0, _wall)];
          toCell(g, cell.plain, mx, gy, mz, rot);
          // Shapes in the run's frame (local +X along the wall)
          run.shapes.push([len / 2, WALL_H / 2, WALL_T / 2, tm - run.tm0, gy - run.y + WALL_H / 2, 0]);
        }
        flush();
        // The back gate's pillars
        for (const gp of WALL_GAPS) {
          const along = (gp.at[0] - ax) * ux + (gp.at[1] - az) * uz;
          if (along < 0 || along > L) continue;
          const off = (gp.at[0] - ax) * -uz + (gp.at[1] - az) * ux;
          if (Math.abs(off) > 3) continue;
          for (const sgn of [-1, 1]) {
            const x = gp.at[0] + ux * sgn * (gp.hw + 0.3), z = gp.at[1] + uz * sgn * (gp.hw + 0.3), gy = groundAt(x, z);
            toCell([box(0.7, 2.9, 0.7, 0, 1.45, 0, _coping)], cellOf(x, z).plain, x, gy, z, rot);
            const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
            body.addShape(new CANNON.Box(new CANNON.Vec3(0.35, 1.45, 0.35)));
            body.position.set(x, gy + 1.45, z);
            world.addBody(body);
            mapObstacles.push({ type: "box", x, z, rot, w: 0.7, d: 0.7, hw: 0.35, hd: 0.35, campus: true });
          }
        }
      }
    }

    // ── Lamp posts along the campus roads (emissive heads: no lights)
    {
      const at = {};
      for (const r of roads.roads) {
        if (!r.campus) continue;
        for (let s = LAMP_EVERY * 0.5, side = 1; s < r.length - 3; s += LAMP_EVERY, side = -side) {
          roads.pointAt(r, s, at);
          const nx = at.tz, nz = -at.tx;
          const x = at.x + nx * side * 4.9, z = at.z + nz * side * 4.9;
          const near = roads.nearest(x, z);
          if (near.road !== r || near.d < 4.2 || this.blocks(x, z, 1) || this.onField(x, z, 1)) continue;
          const gy = groundAt(x, z), yaw = Math.atan2(-nx * side, -nz * side);
          const cell = cellOf(x, z);
          toCell([cyl(0.07, 6.2, 0, 3.1, 0, _lamp, 6), box(0.08, 0.08, 1.4, 0, 6.1, 0.7, _lamp)], cell.plain, x, gy, z, yaw);
          toCell([box(0.32, 0.12, 0.6, 0, 6.02, 1.3, _white)], cell.lamp, x, gy, z, yaw);
          const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
          body.addShape(new CANNON.Cylinder(0.09, 0.09, 6.2, 6));
          body.position.set(x, gy + 3.1, z);
          world.addBody(body);
          mapObstacles.push({ type: "circle", x, z, r: 0.25, hit: 0.15, pole: true });
        }
      }
    }

    // ── One mesh per material per cell
    this.meshes ??= [];
    for (const cell of cells.values()) {
      for (const [key, mat, shadow] of [["facade", facadeMat, true], ["plain", plainMat, true], ["lamp", lampMat, false], ["pitch", pitchMat, false]]) {
        if (!cell[key].length) continue;
        const geo = mergeGeometries(cell[key], false);
        if (!geo) continue;
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = shadow;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        scene.add(mesh);
        chunks?.addMesh(mesh);
        this.meshes.push(mesh);
      }
    }
    return this;
  }

  /**
   * The campus trees (neem / gulmohar-like: a trunk and a lumpy crown), all
   * in two InstancedMeshes, a trunk collider each. spots from treeSpots().
   */
  plantTrees({ scene, world, material, spots, rng, groundAt, mapObstacles }) {
    if (!spots.length) return;
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 3.4, 6).translate(0, 1.7, 0);
    trunkGeo.deleteAttribute("uv");
    const blobs = [[0, 4.6, 0, 2.3], [1.3, 4.1, 0.5, 1.6], [-1.2, 4.2, -0.4, 1.7], [0.3, 5.6, -0.6, 1.5], [-0.4, 3.9, 1.2, 1.4]].map(([x, y, z, r], i) => {
      const g = new THREE.IcosahedronGeometry(r, 1).translate(x, y, z);
      g.deleteAttribute("uv");
      return colored(g.index ? g.toNonIndexed() : g, new THREE.Color().setHSL(0.27 + i * 0.012, 0.42, 0.26 + (i % 2) * 0.05));
    });
    const crownGeo = mergeGeometries(blobs, false);
    crownGeo.computeVertexNormals();
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4f3d2e, roughness: 0.95 });
    const crownMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();
    spots.forEach((t, i) => {
      const k = 0.8 + rng() * 0.5, y = groundAt(t.x, t.z) - 0.05;
      m.compose(p.set(t.x, y, t.z), q.setFromAxisAngle(up, rng() * Math.PI * 2), s.set(k, k * (0.9 + rng() * 0.25), k));
      trunks.setMatrixAt(i, m);
      crowns.setMatrixAt(i, m);
      crowns.setColorAt(i, tint.setHSL(0.24 + rng() * 0.06, 0.5, 0.75 + rng() * 0.35));
      const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
      body.addShape(new CANNON.Cylinder(0.24 * k, 0.24 * k, 3.4 * k, 6));
      body.position.set(t.x, y + 1.7 * k, t.z);
      world.addBody(body);
      mapObstacles.push({ type: "circle", x: t.x, z: t.z, r: Math.max(0.8, 2.3 * k * 0.7), hit: 0.24 * k + 0.1 });
    });
    for (const mesh of [trunks, crowns]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.chunk = true;     // split per map cell with the rocks and poles (main.js, end of loadWorld)
      mesh.computeBoundingSphere();
      scene.add(mesh);
    }
    this.trees = spots;
  }

  /**
   * Where the campus trees go (seeded): clusters and rows from the picture,
   * clear of the buildings, roads, the field, the wall and the existing grounds.
   * ok(x, z): the caller's own test (roads, water). Returns [{ x, z }].
   */
  treeSpots(rng, ok) {
    const out = [];
    const free = (x, z) => this.area(x, z) && !this.blocks(x, z, 3.2) && !this.onField(x, z, 4)
      && polyEdgeDist(x, z, AREA) > 2.5 && !KEEP_OUT.some(k => Math.hypot(x - k.x, z - k.z) < k.r + 3)
      && !out.some(t => Math.hypot(t.x - x, t.z - z) < 5.5) && ok(x, z);
    for (const [u, v, r, n] of TREE_CLUSTERS) {
      for (let k = 0, tries = 0; k < n && tries < n * 12; tries++) {
        const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * r;
        const [x, z] = px(u + Math.cos(a) * d, v + Math.sin(a) * d);
        if (free(x, z)) { out.push({ x, z }); k++; }
      }
    }
    for (const [[u0, v0], [u1, v1], n] of TREE_ROWS) {
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const [x, z] = px(u0 + (u1 - u0) * t + (rng() - 0.5) * 3, v0 + (v1 - v0) * t + (rng() - 0.5) * 3);
        if (free(x, z)) out.push({ x, z });
      }
    }
    return out;
  }
}

export { SCALE as CAMPUS_SCALE };
