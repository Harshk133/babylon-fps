import * as THREE from "three";
import { ROAD_HALF, SHOULDER } from "./Roads.js";

// The map's layout: the road network and the towns along it, in the spirit
// of PUBG / Free Fire maps (named towns on a road grid, farmsteads between,
// open country around them). Everything is generated from a seed, so every
// player and every quality preset builds the same world.
//
// A town lines its roads with buildings (houses, bungalows, cabins, corner
// shops, three-storey apartments and warehouses, doors toward the street),
// sits on its own levelled plateau, and walls some of them into compounds
// with a gate toward the road. Farmsteads are houses, cottages and barns.

/** Road centrelines (control points), in metres. The map's playable radius is ~230 m. */
export const ROAD_DEFS = [
  { name: "Highway", points: [[-232, 30], [-200, 25], [-120, 8], [-55, -4], [0, -6], [60, -12], [150, -30], [232, -42]] },
  { name: "North Road", points: [[6, 232], [0, 170], [2, 128], [6, 70], [8, 20], [8, -6], [4, -60], [15, -110], [26, -150], [30, -232]] },
  {
    name: "Ring Road", closed: true,
    points: [[2, 128], [50, 92], [115, 45], [150, -30], [125, -110], [26, -150], [-40, -120], [-75, -55], [-120, 8], [-110, 80], [-55, 120]],
  },
];

/**
 * Towns: centre, the roads they line (± span metres of road), how full the
 * plots are, the share of houses walled into yards, and a clear radius round
 * the centre (Crossroads keeps the spawn open). Farmsteads have no name.
 */
export const TOWNS = [
  { name: "Crossroads", x: 0, z: 0, roads: [["Highway", 62], ["North Road", 62]], density: 0.75, yards: 0.35, clear: 24 },
  { name: "Ravencross", x: 2, z: 128, roads: [["North Road", 52], ["Ring Road", 34]], density: 0.95, yards: 0.5 },
  { name: "Ashford", x: 150, z: -30, roads: [["Highway", 50], ["Ring Road", 30]], density: 0.95, yards: 0.5 },
  { name: "Mill Creek", x: 26, z: -150, roads: [["North Road", 44], ["Ring Road", 30]], density: 0.9, yards: 0.45 },
  { name: "Pine Hollow", x: -120, z: 8, roads: [["Highway", 50], ["Ring Road", 30]], density: 0.9, yards: 0.45 },
  // Farmsteads along the ring and the highway
  { x: 82, z: 70, roads: [["Ring Road", 12]], density: 1, yards: 0.9 },
  { x: 140, z: -75, roads: [["Ring Road", 12]], density: 1, yards: 0.9 },
  { x: -10, z: -136, roads: [["Ring Road", 12]], density: 1, yards: 0.9 },
  { x: -98, z: -24, roads: [["Ring Road", 12]], density: 1, yards: 0.9 },
  { x: -116, z: 62, roads: [["Ring Road", 12]], density: 1, yards: 0.9 },
  { x: -180, z: 18, roads: [["Highway", 14]], density: 1, yards: 0.9 },
  { x: 205, z: -38, roads: [["Highway", 14]], density: 1, yards: 0.9 },
  { x: 2, z: 195, roads: [["North Road", 14]], density: 1, yards: 0.9 },
];

const TOWN_KINDS = [["house", 0.27], ["bungalow", 0.18], ["cabin", 0.08], ["shop", 0.18], ["apartment", 0.17], ["warehouse", 0.12]];
const FARM_KINDS = [["house", 0.3], ["bungalow", 0.28], ["cabin", 0.2], ["warehouse", 0.22]];
const HOUSE_TINTS = [0xfff6e6, 0xffdcc0, 0xd6ead0, 0xd2e0f8, 0xf6d0cc, 0xf2e2b8, 0xffffff, 0xe8d8f0].map(c => new THREE.Color(c));
const WALL_TINTS = [0xd9d2c4, 0xc7b29a, 0xb0a89c, 0xa86f55, 0xcfc6b0].map(c => new THREE.Color(c));
const FRONT_GAP = 5.2;     // m between the road's edge and a house's front wall
const PLOT_PITCH = 17;     // m of road per plot (+ a little jitter)
const YARD_MARGIN = 2.2;   // m of yard round the houses
const YARD_FRONT = 2.0;    // m of yard in front of the houses (the gate side)

/**
 * Lays out every town. Pure geometry: the caller adds the houses and yards.
 *   roads: Roads. rng: seeded () → [0, 1). halfSize(kind) → { hw, hd, doorX } in metres.
 *   blocked(x, z, r): true where nothing may be built (caves, the map edge).
 *   keepClear: [{ x, z, r }] spots to leave alone (spawn, props, the rickshaw).
 *   heightAt(x, z): the natural ground (for each town's plateau level).
 * Returns { houses: [{ kind, x, z, rot, doorX, tint, town }], yards: [{ x, z, rot, hw, hd, gateX, tint, town }],
 *           plateaus: [{ x, z, r, fade, y }], labels: [{ name, x, z }] }.
 */
export function layoutTowns({ roads, rng, halfSize, blocked, keepClear, heightAt }) {
  const houses = [], yards = [], plateaus = [], labels = [];
  const at = {};
  const pick = list => list[Math.floor(rng() * list.length)];
  const kindOf = weights => {
    let r = rng();
    for (const [k, w] of weights) { if ((r -= w) < 0) return k; }
    return weights[0][0];
  };

  // Footprint corners of a house (or yard) in world space
  const corners = (x, z, rot, hw, hd, pad = 0) => {
    const c = Math.cos(rot), s = Math.sin(rot), out = [];
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const lx = sx * (hw + pad), lz = sz * (hd + pad);
      out.push([x + lx * c + lz * s, z - lx * s + lz * c]);
    }
    return out;
  };
  const clearOfRoads = pts => pts.every(([x, z]) => roads.distance(x, z) > ROAD_HALF + SHOULDER + 0.8);
  const insideHouse = (x, z, h, pad) => {
    const c = Math.cos(h.rot), s = Math.sin(h.rot), dx = x - h.x, dz = z - h.z;
    return Math.abs(dx * c - dz * s) < h.hw + pad && Math.abs(dx * s + dz * c) < h.hd + pad;
  };

  for (const town of TOWNS) {
    const reach = Math.max(...town.roads.map(([, span]) => span));
    const level = heightAt(town.x, town.z);
    const plateau = { x: town.x, z: town.z, r: reach + 16, fade: 26, y: level };
    if (town.name === "Crossroads") plateau.y = 0; // the spawn pad
    plateaus.push(plateau);
    if (town.name) labels.push({ name: town.name, x: town.x, z: town.z });
    const placed = [];

    for (const [roadName, span] of town.roads) {
      const road = roads.byName(roadName);
      if (!road) continue;
      const s0 = roads.arcNear(road, town.x, town.z);
      for (const side of [-1, 1]) {
        const row = [];
        for (let ds = -span; ds <= span; ds += PLOT_PITCH + rng() * 4) {
          if (rng() > town.density) continue;
          let s = s0 + ds;
          if (road.closed) s = ((s % road.length) + road.length) % road.length;
          else if (s < 0 || s > road.length) continue;
          roads.pointAt(road, s, at);
          const nx = at.tz, nz = -at.tx; // right of the road
          const kind = kindOf(town.name ? TOWN_KINDS : FARM_KINDS);
          const { hw, hd, doorX } = halfSize(kind);
          const off = ROAD_HALF + SHOULDER + FRONT_GAP + hd;
          const x = at.x + nx * off * side, z = at.z + nz * off * side;
          // Door (local +Z) toward the road
          const rot = Math.atan2(-nx * side, -nz * side);
          const r = Math.hypot(hw, hd);
          if (town.clear && Math.hypot(x - town.x, z - town.z) < town.clear + r) continue;
          if (Math.hypot(x, z) > 222 || blocked(x, z, r + 6)) continue;
          if (keepClear.some(k => Math.hypot(x - k.x, z - k.z) < k.r + r + 1.5)) continue;
          if (!clearOfRoads(corners(x, z, rot, hw, hd, 0.3))) continue;
          if ([...houses, ...placed].some(h => Math.hypot(h.x - x, h.z - z) < h.r + r + 3)) continue;
          const h = { kind, x, z, rot, hw, hd, doorX, r, s, tint: pick(HOUSE_TINTS), town: town.name ?? null, base: plateau.y };
          placed.push(h);
          row.push(h);
        }

        // Wall some neighbours into a yard, gate in front of the first one's door
        for (let i = 0; i < row.length;) {
          if (rng() > town.yards) { i++; continue; }
          const size = 1 + Math.floor(rng() * Math.min(3, row.length - i));
          const group = row.slice(i, i + size);
          i += size;
          const yard = fitYard(group, rng, pick);
          if (!yard) continue;
          const pts = yardPerimeter(yard);
          const others = [...houses, ...placed].filter(h => !group.includes(h));
          const ok = clearOfRoads(pts)
            && !pts.some(([x, z]) => others.some(h => insideHouse(x, z, h, 1.2)))
            && !pts.some(([x, z]) => yards.some(y => insideHouse(x, z, y, 1.0)))
            && !pts.some(([x, z]) => keepClear.some(k => Math.hypot(x - k.x, z - k.z) < k.r + 1))
            && !blocked(yard.x, yard.z, Math.hypot(yard.hw, yard.hd) + 3);
          if (!ok) continue;
          yard.town = town.name ?? null;
          yard.base = plateau.y;
          yards.push(yard);
        }
      }
    }
    houses.push(...placed);
  }
  return { houses, yards, plateaus, labels };
}

/** The yard rectangle round a row of houses (in the first house's frame), gate in front of its door. */
function fitYard(group, rng, pick) {
  const ref = group[0];
  const rot = ref.rot, c = Math.cos(rot), s = Math.sin(rot);
  const toL = (x, z) => [(x - ref.x) * c - (z - ref.z) * s, (x - ref.x) * s + (z - ref.z) * c];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const h of group) {
    const hc = Math.cos(h.rot), hs = Math.sin(h.rot);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const wx = h.x + sx * h.hw * hc + sz * h.hd * hs, wz = h.z - sx * h.hw * hs + sz * h.hd * hc;
      const [lx, lz] = toL(wx, wz);
      x0 = Math.min(x0, lx); x1 = Math.max(x1, lx); z0 = Math.min(z0, lz); z1 = Math.max(z1, lz);
    }
  }
  x0 -= YARD_MARGIN; x1 += YARD_MARGIN; z0 -= YARD_MARGIN; z1 += YARD_FRONT;
  const hw = (x1 - x0) / 2, hd = (z1 - z0) / 2;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  // Back to world
  const x = ref.x + cx * c + cz * s, z = ref.z - cx * s + cz * c;
  // Gate in front of the reference house's door
  const gateX = Math.min(hw - 2.6, Math.max(-hw + 2.6, ref.doorX - cx));
  return { x, z, rot, hw, hd, gateX, tint: pick(WALL_TINTS) };
}

/** Points along a yard's walls (for clearance checks). */
function yardPerimeter(y) {
  const c = Math.cos(y.rot), s = Math.sin(y.rot), pts = [];
  const step = 1.5;
  const push = (lx, lz) => pts.push([y.x + lx * c + lz * s, y.z - lx * s + lz * c]);
  for (let lx = -y.hw; lx <= y.hw; lx += step) { push(lx, y.hd); push(lx, -y.hd); }
  for (let lz = -y.hd; lz <= y.hd; lz += step) { push(y.hw, lz); push(-y.hw, lz); }
  return pts;
}
