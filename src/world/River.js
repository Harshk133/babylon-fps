import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GROUP_WORLD } from "../physicsGroups.js";
import { SEA_Y, groundHeight } from "./Terrain.js";
import { ROAD_HALF, SHOULDER } from "./Roads.js";
import { waterMaterial } from "./Water.js";

// The river and the village ponds.
//
// The river is a centreline (Catmull-Rom through RIVER.points, sampled every
// SAMPLE metres) from a lake east of Crossroads, under the Highway and the
// Ring Road, out into the south-east bay. Its water level follows the ground
// but only ever runs downhill (a running minimum, eased), ending at sea
// level. buildTerrain's modify carves a channel under it (parabolic bed,
// a low levee each side so the water always has banks); the water is one
// ribbon mesh at the water level, ponds are discs, all with the shared water
// material (Water.js), so the river costs one draw call.
//
// Roads cross on causeway bridges: setProfile's height gets a hump there
// (bridgeLift), Roads.modify fills the channel under the asphalt, and
// buildBridges() adds parapets and concrete side walls with culverts.
// Everything is fixed data, so every player builds the same river.

export const RIVER = {
  name: "Sona River",
  // lake east of Crossroads → under the Highway → under the Ring Road → under the Outer Ring → the south-east bay
  points: [[64, 54], [74, 26], [84, 0], [86, -22], [82, -52], [92, -88], [108, -122], [134, -160], [166, -192], [205, -228],
    [250, -272], [292, -312], [330, -350], [362, -382]],
  width: [5, 10],         // half width at the source → at the mouth (m)
  depth: 1.5,             // m of water down the middle
};
/** Village ponds: centre and radius. */
export const PONDS = [
  { x: 64, z: 54, r: 13 },     // the lake the river runs out of
  { x: -62, z: 58, r: 9 },
  { x: -46, z: -78, r: 8 },
];

const SAMPLE = 3;
const BANK = 4;          // m of sloping bank beyond the water's edge (wider where it cuts through high ground)
const VALLEY = 1.8;      // extra bank width per metre the ground stands over the water
const VALLEY_MAX = 26;
const LEVEE = 0.35;      // the banks never sit lower than this above the water
const CELL = 12;
const BRIDGE_LIFT = 1.3; // m the road rises over the river

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class River {
  constructor(def = RIVER, ponds = PONDS) {
    this.def = def;
    this.ponds = ponds.map(p => ({ ...p, y: 0 }));
    const curve = new THREE.CatmullRomCurve3(def.points.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, "centripetal");
    const n = Math.max(2, Math.ceil(curve.getLength() / SAMPLE));
    this.pts = curve.getSpacedPoints(n).map((v, i) => {
      const t = i / n;
      return { x: v.x, z: v.z, tx: 0, tz: 0, hw: def.width[0] + (def.width[1] - def.width[0]) * t, y: 0 };
    });
    const pts = this.pts;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      pts[i].tx = (b.x - a.x) / l; pts[i].tz = (b.z - a.z) / l;
    }
    // Segment grid for nearest()
    this.grid = new Map();
    const reach = def.width[1] + BANK + VALLEY_MAX + 4;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      for (let gx = Math.floor((Math.min(a.x, b.x) - reach) / CELL); gx <= Math.floor((Math.max(a.x, b.x) + reach) / CELL); gx++) {
        for (let gz = Math.floor((Math.min(a.z, b.z) - reach) / CELL); gz <= Math.floor((Math.max(a.z, b.z) + reach) / CELL); gz++) {
          const k = gx * 4096 + gz;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k).push(i);
        }
      }
    }
    this._hit = { d: Infinity, i: 0, t: 0, hw: 0, y: 0 };
    this._pond = { y: 0, hw: 0, d: 0 };
    this.bridges = [];
  }

  /** Closest point on the centreline: reused { d, i, t, hw, y } (d = Infinity when far). */
  nearest(x, z) {
    const out = this._hit;
    out.d = Infinity;
    const list = this.grid.get(Math.floor(x / CELL) * 4096 + Math.floor(z / CELL));
    if (!list) return out;
    for (const i of list) {
      const a = this.pts[i], b = this.pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
      if (d < out.d) {
        out.d = d; out.i = i; out.t = t;
        out.hw = a.hw + (b.hw - a.hw) * t;
        out.y = a.y + (b.y - a.y) * t;
      }
    }
    return out;
  }

  /**
   * Water levels from the ground (heightAt: after the pads, before roads):
   * a little under the ground, never rising downstream, eased, and down to
   * sea level at the mouth. Ponds sit a little under their lowest rim.
   */
  setProfile(heightAt) {
    const pts = this.pts, n = pts.length;
    let run = Infinity;
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      // The lowest ground across the channel, so the water never spills over a low bank
      const nx = p.tz, nz = -p.tx;
      let g = Infinity;
      for (const o of [-1, -0.5, 0, 0.5, 1]) g = Math.min(g, heightAt(p.x + nx * p.hw * o, p.z + nz * p.hw * o));
      run = Math.min(run, g - 0.6);
      y[i] = Math.max(SEA_Y, run);
    }
    // Ease it (a backward-weighted blur keeps it from ever climbing)
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < n; i++) y[i] = Math.min(y[i - 1], y[i] * 0.6 + y[i - 1] * 0.4);
    }
    for (let i = 0; i < n; i++) pts[i].y = y[i];
    pts[n - 1].y = SEA_Y;
    for (const p of this.ponds) {
      let g = heightAt(p.x, p.z);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        g = Math.min(g, heightAt(p.x + Math.cos(a) * p.r, p.z + Math.sin(a) * p.r));
      }
      p.y = g - 0.5;
    }
    // The source lake feeds the river at its own level
    const lake = this.ponds[0];
    lake.y = Math.min(lake.y, pts[0].y);
    for (let i = 0; i < n && pts[i].y > lake.y; i++) pts[i].y = lake.y;
  }

  /** The water at (x, z): { y, hw, d } of the river or a pond, or null on dry land (pad: extra reach). */
  waterAt(x, z, pad = 0) {
    const n = this.nearest(x, z);
    if (n.d < n.hw + pad) return n;
    for (const p of this.ponds) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.r + pad) { const o = this._pond; o.y = p.y; o.hw = p.r; o.d = d; return o; }
    }
    return null;
  }

  /** Water depth over the ground at (x, z) (0 where dry). Needs the final terrain. */
  depthAt(x, z) {
    const w = this.waterAt(x, z);
    return w ? Math.max(0, w.y - groundHeight(x, z)) : 0;
  }

  /** True on the water, its banks, or within pad metres of them (no trees, loot, houses there). */
  wet(x, z, pad = 0) { return !!this.waterAt(x, z, BANK + pad); }

  /** buildTerrain modify: carve the channel and the ponds, keep a levee round them. */
  modify(x, z, h) {
    const n = this.nearest(x, z);
    if (n.d < n.hw + BANK + VALLEY_MAX) h = this._carve(h, n.d, n.hw, n.y);
    for (const p of this.ponds) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.r + BANK + VALLEY_MAX) h = this._carve(h, d, p.r, p.y);
    }
    return h;
  }

  _carve(h, d, hw, wy) {
    if (d < hw) {
      // Parabolic bed: deepest in the middle, a shallow shelf at the edge
      const u = d / hw;
      const bed = wy - this.def.depth * (1 - u * u) - 0.15;
      return Math.min(h, bed);
    }
    // Bank: from just over the water at the edge back to the ground, never below the levee
    // (raised to a levee where the ground is lower than the water). Through high
    // ground the bank widens into a valley instead of a sheer cut.
    const bank = wy + LEVEE;
    const width = BANK + Math.min(VALLEY_MAX, Math.max(0, h - bank - 1.5) * VALLEY);
    if (d > hw + width) return h;
    return bank + (h - bank) * smooth(hw, hw + width, d);
  }

  /** buildTerrain tint: mud under the water, damp dark soil on the banks. */
  tint(x, z, c) {
    const w = this.waterAt(x, z, BANK + 2);
    if (!w) return;
    const k = 1 - smooth(w.hw, w.hw + BANK + 2, w.d);
    c.lerp(_mud, k * 0.85);
  }

  /** For the road profiles: a hump where a road crosses the water, so it rides over on a causeway. */
  bridgeLift(x, z) {
    const w = this.waterAt(x, z, 14);
    if (!w || w.hw > 20) return 0;  // not over the ponds
    return BRIDGE_LIFT * (1 - smooth(w.hw, w.hw + 14, w.d));
  }

  /** Where the roads cross the river: [{ x, z, tx, tz, y, half }] (road point, its direction, half the span). */
  findCrossings(roads) {
    const out = [];
    for (const r of roads.roads) {
      let inside = false, best = null;
      for (const p of r.pts) {
        const n = this.nearest(p.x, p.z);
        const over = n.d < n.hw + 1;
        if (over && (!best || n.d < best.d)) best = { x: p.x, z: p.z, tx: p.tx, tz: p.tz, y: p.y, d: n.d, half: n.hw + BANK * 0.6 };
        if (!over && inside && best) { out.push(best); best = null; }
        inside = over;
      }
      if (best) out.push(best);
    }
    this.bridges = out;
    return out;
  }

  /** The water ribbon and the pond discs: one mesh. */
  buildMesh(scene) {
    const pts = this.pts, n = pts.length;
    const pos = new Float32Array(n * 2 * 3);
    const idx = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i], nx = p.tz, nz = -p.tx;
      const w = p.hw + 1.2; // a little into the bank, so the edge meets the slope
      pos.set([p.x - nx * w, p.y, p.z - nz * w, p.x + nx * w, p.y, p.z + nz * w], i * 6);
      if (i < n - 1) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); } // facing up
    }
    const ribbon = new THREE.BufferGeometry();
    ribbon.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    ribbon.setIndex(idx);
    const geos = [ribbon];
    for (const p of this.ponds) {
      const g = new THREE.CircleGeometry(p.r + 1.2, 32).rotateX(-Math.PI / 2);
      g.translate(p.x, p.y, p.z);
      geos.push(g);
    }
    for (const g of geos) { g.deleteAttribute("uv"); g.deleteAttribute("normal"); }
    const geo = mergeGeometries(geos.map(g => g.toNonIndexed()), false);
    // Flat water: every normal straight up
    const nor = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, waterMaterial());
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    this.mesh = mesh;
    return mesh;
  }

  /**
   * Causeway bridges at the crossings: parapets each side (solid, on the
   * obstacle lists so vehicles stay on the deck), and concrete side walls
   * down to the water with dark culvert mouths. Needs the final terrain.
   */
  buildBridges({ scene, world, material, mapObstacles }) {
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b2a4, roughness: 0.9 });
    const stripe = new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.85 });
    const culvert = new THREE.MeshBasicMaterial({ color: 0x0b0d0c });
    const parts = { concrete: [], stripe: [], culvert: [] };
    const box = (list, w, h, d, x, y, z, rot) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.rotateY(rot); g.translate(x, y, z);
      list.push(g);
    };
    for (const b of this.bridges) {
      const rot = Math.atan2(b.tx, b.tz);
      const nx = b.tz, nz = -b.tx;                 // across the road
      const deckY = groundHeight(b.x, b.z);
      const span = b.half * 2 + 4;
      const side = ROAD_HALF + 0.45;
      for (const sgn of [-1, 1]) {
        const px = b.x + nx * side * sgn, pz = b.z + nz * side * sgn;
        // Parapet with a whitewashed top, posts at the ends
        box(parts.concrete, 0.32, 0.8, span, px, deckY + 0.4, pz, rot);
        box(parts.stripe, 0.36, 0.12, span + 0.1, px, deckY + 0.86, pz, rot);
        for (const e of [-1, 1]) box(parts.stripe, 0.5, 1.1, 0.5, px + b.tx * span / 2 * e, deckY + 0.55, pz + b.tz * span / 2 * e, rot);
        // Side wall of the causeway, down into the water, with two culvert mouths
        const wx = b.x + nx * (ROAD_HALF + SHOULDER) * sgn, wz = b.z + nz * (ROAD_HALF + SHOULDER) * sgn;
        const bottom = deckY - 3.2;
        box(parts.concrete, 0.5, deckY - bottom, span, wx, (deckY + bottom) / 2 - 0.05, wz, rot);
        for (const o of [-0.25, 0.25]) {
          const cx = wx + nx * 0.27 * sgn + b.tx * span * o, cz = wz + nz * 0.27 * sgn + b.tz * span * o;
          box(parts.culvert, 0.04, 1.3, span * 0.3, cx, deckY - 2.1, cz, rot);
        }
        // Solid parapet (players, monsters, vehicles)
        const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
        body.addShape(new CANNON.Box(new CANNON.Vec3(0.16, 0.5, span / 2)));
        body.position.set(px, deckY + 0.5, pz);
        body.quaternion.setFromEuler(0, rot, 0);
        world.addBody(body);
        mapObstacles.push({ type: "box", x: px, z: pz, w: 0.32, d: span, rot, bridge: true });
      }
    }
    if (!this.bridges.length) return;
    for (const [k, mat] of [["concrete", concrete], ["stripe", stripe], ["culvert", culvert]]) {
      const geo = mergeGeometries(parts[k].map(g => g.toNonIndexed()), false);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = k !== "culvert";
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      scene.add(mesh);
    }
  }

  /** For the maps: the river as a polyline [[x, z], …] with its half widths, and the ponds. */
  mapInfo() {
    return { line: this.pts.map(p => [p.x, p.z, p.hw]), ponds: this.ponds.map(p => [p.x, p.z, p.r]) };
  }
}

const _mud = new THREE.Color(0.42, 0.36, 0.28);
