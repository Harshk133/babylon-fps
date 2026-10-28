import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GROUP_WORLD, GROUP_ZOMBIE } from "../physicsGroups.js";
import { ROAD_HALF, SHOULDER } from "./Roads.js";
import { groundHeight } from "./Terrain.js";

// Empty plots along the roads, the way the edge of every Indian town looks:
// a walled-off piece of land with a gate gap toward the road.
//
//   empty         compound wall (brick or plastered), dry soil, a brick pile,
//                 a sand heap; some are overgrown.
//   unfinished    the wall itself is half built: courses stepping up and
//                 down, panels missing (low ones you can jump).
//   construction  a house under construction: an RCC frame (columns and the
//                 first-floor slab) with rebar sticking up, cement bags, brick
//                 and sand, and a plank ramp up onto the slab: a lookout. A
//                 little loot under and on the slab.
//
// Layout is seeded and identical for everyone. One static body per plot
// (walls, frame, piles); the ramp is its own body, which monsters don't
// collide with. Meshes are merged per CELL square and material and culled by
// distance (WorldChunks). Walls go on the obstacle lists so vehicles stop at
// them and the minimap draws them.

const WALL_T = 0.24;
const PANEL = 3;            // m per wall panel
const GATE = 3.4;           // gate gap
const SETBACK = 2.2;        // m from the road shoulder to the front wall
const FRAME_H = 3.2;        // slab height on a construction site
const CELL = 90;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function brickTexture() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#cfc4b4"; g.fillRect(0, 0, 128, 64);       // mortar
  for (let row = 0; row < 8; row++) {
    const off = row % 2 ? 16 : 0;
    for (let col = -1; col < 5; col++) {
      const v = 0.82 + Math.random() * 0.3;
      g.fillStyle = `rgb(${(176 * v) | 0}, ${(88 * v) | 0}, ${(62 * v) | 0})`;
      g.fillRect(col * 32 + off + 1, row * 8 + 1, 30, 6);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function colored(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}
/** A box with UVs in metres (brick texture: 1 m × 0.5 m a tile). */
function brickBox(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i));
    const u = ax > 0.5 ? pos.getZ(i) : pos.getX(i);
    const v = ay > 0.5 ? pos.getZ(i) : pos.getY(i);
    uv.setXY(i, u + x, (v + y) * 2);
  }
  g.translate(x, y, z);
  return g;
}
function box(w, h, d, x, y, z, color, rotY = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  g.deleteAttribute("uv");
  return colored(g, color);
}

export class Plots {
  /**
   * roads: Roads. rng: seeded. blocked(x, z, r): where a plot may not reach
   * (houses, yards, the city, fields, water, caves, reserved spots, the shore).
   */
  constructor({ roads, rng, blocked, every = 52 }) {
    this.plots = [];
    this.lootSpots = [];
    const at = {};
    const clearOfRoads = pts => pts.every(([x, z]) => roads.distance(x, z) > ROAD_HALF + SHOULDER + 0.6);
    for (const road of roads.roads) {
      for (let s = 20; s < road.length - 20; s += every + rng() * every) {
        for (const side of [-1, 1]) {
          if (rng() > 0.42) continue;
          roads.pointAt(road, s, at);
          const hw = 6 + rng() * 6, hd = 5 + rng() * 5;
          const nx = at.tz * side, nz = -at.tx * side;
          const off = ROAD_HALF + SHOULDER + SETBACK + hd;
          const x = at.x + nx * off, z = at.z + nz * off;
          const rot = Math.atan2(-nx, -nz);         // front (local +z) toward the road
          const roll = rng();
          const p = {
            x, z, rot, hw, hd,
            kind: roll < 0.38 ? "construction" : roll < 0.62 ? "unfinished" : "empty",
            brick: rng() < 0.6, overgrown: rng() < 0.3, seed: Math.floor(rng() * 1e9), gateX: (rng() - 0.5) * (hw - GATE),
          };
          const pts = corners(p, 0.5);
          if (!clearOfRoads(pts)) continue;
          if (pts.some(([px, pz]) => blocked(px, pz, 1.5))) continue;
          if (this.plots.some(o => Math.hypot(o.x - x, o.z - z) < Math.hypot(o.hw, o.hd) + Math.hypot(hw, hd) + 2)) continue;
          this.plots.push(p);
        }
      }
    }
  }

  build({ scene, world, material, mapObstacles, navObstacles, chunks }) {
    const brickMat = new THREE.MeshStandardMaterial({ map: brickTexture(), roughness: 0.95 });
    const plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
    const cells = new Map();
    const cellOf = (x, z) => {
      const k = Math.floor(x / CELL) * 4096 + Math.floor(z / CELL);
      if (!cells.has(k)) cells.set(k, { brick: [], plain: [] });
      return cells.get(k);
    };
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();

    for (const p of this.plots) {
      const rng = THREE.MathUtils.seededRandom;
      rng(p.seed);
      // The plot sits on its lowest corner's ground, walls sunk a little into the slope
      const y0 = Math.min(...corners(p, 0).map(([cx, cz]) => groundHeight(cx, cz))) - 0.1;
      const yC = groundHeight(p.x, p.z);
      m.compose(v.set(p.x, y0, p.z), q.setFromAxisAngle(up, p.rot), one);
      const bricks = [], plain = [], solids = [], ramps = [];
      const solid = (w, h, d, x, y, z) => solids.push([w / 2, h / 2, d / 2, x, y, z]);
      const wallC = p.brick ? null : WALL_TINTS[p.seed % WALL_TINTS.length];
      const extra = yC - y0;   // ground rises inside: walls a bit taller where it's higher

      // ── Compound wall: panels round the edge, a gate gap in the front
      const fullH = (p.brick ? 1.7 : 1.9) + Math.max(0, extra * 0.5);
      const panel = (x0, x1, z, along) => {
        for (let a = x0; a < x1 - 0.2; a += PANEL) {
          const b = Math.min(x1, a + PANEL), len = b - a, mid = (a + b) / 2;
          let h = fullH;
          if (p.kind === "unfinished") {
            const r = rng();
            if (r < 0.22) continue;                         // a missing panel
            h = r < 0.55 ? 0.5 + rng() * 0.6 : fullH * (0.7 + rng() * 0.3);
          }
          const [w, d, x, zz] = along ? [len, WALL_T, mid, z] : [WALL_T, len, z, mid];
          if (p.brick) bricks.push(brickBox(w, h, d, x, h / 2, zz));
          else {
            plain.push(box(w, h, d, x, h / 2, zz, wallC));
            plain.push(box(w + 0.06, 0.08, d + 0.06, x, h + 0.04, zz, _coping));
          }
          solid(w, h, d, x, h / 2, zz);
          // Piers at the panel ends of the plastered walls
          if (!p.brick) plain.push(box(0.36, h + 0.15, 0.36, along ? a : z, (h + 0.15) / 2, along ? z : a, _coping));
          mapObstacles.push(this._obstacle(p, x, zz, w, d));
        }
      };
      const { hw, hd } = p;
      const g0 = p.gateX - GATE / 2, g1 = p.gateX + GATE / 2;
      panel(-hw, g0, hd, true); panel(g1, hw, hd, true);           // front, round the gate
      panel(-hw, hw, -hd, true);                                    // back
      panel(-hd, hd, -hw, false); panel(-hd, hd, hw, false);        // sides
      // Gate leaves standing open against the wall
      for (const sx of [-1, 1]) {
        const gx = sx < 0 ? g0 : g1;
        plain.push(box(GATE / 2, 1.5, 0.05, gx - sx * 0.1, 0.85, hd - GATE / 4 - 0.1, _gate, Math.PI / 2));
      }

      // ── Inside
      const pile = (x, z) => { bricks.push(brickBox(1.4, 0.7, 0.9, x, 0.35 + extra * 0.3, z)); solid(1.4, 0.7, 0.9, x, 0.35 + extra * 0.3, z); };
      const sand = (x, z, r) => {
        const g = new THREE.ConeGeometry(r, r * 0.7, 10).translate(x, r * 0.35 + extra * 0.3, z);
        g.deleteAttribute("uv");
        plain.push(colored(g, _sand));
      };
      const bags = (x, z) => {
        for (let i = 0; i < 6; i++) {
          const bx = x + (i % 3) * 0.62 - 0.62, by = 0.14 + Math.floor(i / 3) * 0.26 + extra * 0.3;
          plain.push(box(0.55, 0.24, 0.85, bx, by, z, _bag));
        }
        solid(1.9, 0.55, 0.9, x, 0.28 + extra * 0.3, z);
      };
      pile(-hw * 0.5, -hd * 0.45);
      sand(hw * 0.45, -hd * 0.35, 1.2 + rng() * 0.6);

      if (p.kind === "construction") {
        // RCC frame: a column at each corner of the slab and in the middle of the long sides
        // (narrow enough to leave room for the ramp off its side)
        const sw = Math.min(hw - 3.6, 5.5), sd = Math.min(hd - 1.5, 4.2);
        const sx0 = -hw + 1.5 + sw, sz0 = -hd + 1.5 + sd;  // slab centre, toward the back corner
        const H = FRAME_H + extra * 0.3;
        for (const cx of [-sw, 0, sw]) for (const cz of [-sd, sd]) {
          const x = sx0 + cx * 0.95, z = sz0 + cz * 0.95;
          plain.push(box(0.35, H, 0.35, x, H / 2, z, _concrete));
          solid(0.35, H, 0.35, x, H / 2, z);
          // Rebar sticking up for the next floor
          for (const [ox, oz] of [[-0.1, -0.1], [0.1, -0.1], [-0.1, 0.1], [0.1, 0.1]]) plain.push(box(0.025, 0.9, 0.025, x + ox, H + 0.6, z + oz, _rebar));
        }
        plain.push(box(sw * 2, 0.25, sd * 2, sx0, H + 0.12, sz0, _concrete));
        solid(sw * 2, 0.25, sd * 2, sx0, H + 0.12, sz0);
        // A plank ramp from the yard up onto the slab's side (down toward +x)
        const run = 5.2, slope = Math.atan2(H + 0.25, run), len = Math.hypot(run, H + 0.25);
        const rx = sx0 + sw + run / 2, rz = sz0;
        const plank = new THREE.BoxGeometry(len, 0.08, 0.8).rotateZ(-slope).translate(rx, (H + 0.25) / 2, rz);
        plank.deleteAttribute("uv");
        plain.push(colored(plank, _plank));
        ramps.push([len / 2, 0.06, 0.4, rx, (H + 0.25) / 2 + 0.05, rz, -slope]);
        bags(-hw * 0.4, hd * 0.45);
        pile(hw * 0.5, hd * 0.4);
        const c = Math.cos(p.rot), s = Math.sin(p.rot);
        const spot = (lx, ly, lz) => this.lootSpots.push({ x: p.x + lx * c + lz * s, y: y0 + ly, z: p.z - lx * s + lz * c });
        spot(sx0 - sw * 0.4, 0.15 + extra * 0.3, sz0);   // under the slab
        spot(sx0, H + 0.3, sz0 - sd * 0.4);              // on it
      } else if (rng() < 0.5) bags(0, -hd * 0.4);

      // To the world
      const cell = cellOf(p.x, p.z);
      for (const g of bricks) { g.applyMatrix4(m); cell.brick.push(g); }
      for (const g of plain) { g.applyMatrix4(m); cell.plain.push(g); }
      const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
      for (const [hx, hy, hz, x, y, z] of solids) body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)), new CANNON.Vec3(x, y, z));
      body.position.set(p.x, y0, p.z);
      body.quaternion.setFromEuler(0, p.rot, 0);
      world.addBody(body);
      if (ramps.length) {
        const rb = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD, collisionFilterMask: ~GROUP_ZOMBIE });
        for (const [hx, hy, hz, x, y, z, rz] of ramps) {
          const qx = new CANNON.Quaternion(); qx.setFromEuler(0, 0, rz);
          rb.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)), new CANNON.Vec3(x, y, z), qx);
        }
        rb.position.set(p.x, y0, p.z);
        rb.quaternion.setFromEuler(0, p.rot, 0);
        world.addBody(rb);
      }
      // Monsters go round the plot as a whole (and in through the gate only by luck)
      navObstacles?.push({ type: "box", x: p.x, z: p.z, w: hw * 2, d: hd * 2, rot: p.rot, hw, hd, plot: true });
    }

    this.meshes = [];
    for (const cell of cells.values()) {
      for (const [key, mat] of [["brick", brickMat], ["plain", plainMat]]) {
        if (!cell[key].length) continue;
        const geo = mergeGeometries(cell[key], false);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        scene.add(mesh);
        chunks?.addMesh(mesh);
        this.meshes.push(mesh);
      }
    }
  }

  /** A wall panel as a world-space obstacle box (local x, z centre; w along local x). */
  _obstacle(p, lx, lz, w, d) {
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    return { type: "box", x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c, w, d, rot: p.rot, wall: true, plot: true };
  }

  _at(x, z, pad = 0) {
    for (const p of this.plots) {
      if (Math.abs(x - p.x) > p.hw + p.hd + pad || Math.abs(z - p.z) > p.hw + p.hd + pad) continue;
      const dx = x - p.x, dz = z - p.z, c = Math.cos(p.rot), s = Math.sin(p.rot);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) < p.hw + pad && Math.abs(lz) < p.hd + pad) return p;
    }
    return null;
  }

  /** On (or within pad of) a plot: trees, rocks, fields and loot keep off. */
  blocks(x, z, pad = 0) { return !!this._at(x, z, pad); }

  /** buildTerrain grass mask: bare in the plots (thin on the overgrown ones). */
  grass(x, z) {
    const p = this._at(x, z, 0.5);
    return !p ? 1 : p.overgrown ? 0.9 : 0.15;
  }

  /** buildTerrain tint: dry dug-over soil inside. */
  tint(x, z, c) {
    const p = this._at(x, z, 1);
    if (!p || p.overgrown) return;
    c.lerp(_soil, 0.75);
  }
}

function corners(p, pad) {
  const c = Math.cos(p.rot), s = Math.sin(p.rot), out = [];
  for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0], [0, 0]]) {
    const lx = a * (p.hw + pad), lz = b * (p.hd + pad);
    out.push([p.x + lx * c + lz * s, p.z - lx * s + lz * c]);
  }
  return out;
}

const col = h => new THREE.Color(h);
const WALL_TINTS = [0xd8d0c0, 0xe6dcc8, 0xc9c2b6, 0xd9c7a8, 0xbfb7aa].map(col);
const _coping = col(0xa9a397), _gate = col(0x2f4f3a), _sand = col(0xc9ab78), _bag = col(0xd9d6cc);
const _concrete = col(0x9d978c), _rebar = col(0x4a3a30), _plank = col(0x8a6a44), _soil = new THREE.Color(0.7, 0.58, 0.44);
