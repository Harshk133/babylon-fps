import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GROUP_WORLD } from "../physicsGroups.js";
import { QUALITY } from "../quality.js";
import { shoreRadius } from "./Terrain.js";

// Roads and the power line along them.
//
// Each road is a smooth centreline (centripetal Catmull-Rom through its
// control points) sampled every SAMPLE metres. Its height profile follows the
// ground but eased (no bumps), and holds level through towns. The terrain is
// levelled under the asphalt and its shoulders (modify) and tinted dirt
// beside it (tint), so everything that reads groundHeight() — monsters,
// pickups, the rickshaw — sees the road. Drawing: one merged mesh for every
// road, one instanced mesh for every power pole (+ one for the transformers)
// and one line mesh for every wire.

export const ROAD_HALF = 3.6;          // m: half the asphalt width (two lanes)
export const SHOULDER = 1.6;           // m: flat dirt beyond the asphalt
const BLEND = 5;                       // m: back into the hills
const SAMPLE = 3;                      // m between centreline samples
const CELL = 12;                       // m: lookup grid
const POLE_SPACING = 34;
const POLE_SIDE = ROAD_HALF + SHOULDER + 0.7;
const POLE_H = 8.4;
const ARM_Y = 7.6;
const WIRE_SAG = 0.7;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Centripetal Catmull-Rom through points [[x, z], …], sampled every `step` metres. */
function sampleCurve(points, closed, step) {
  const P = points.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve = new THREE.CatmullRomCurve3(P, closed, "centripetal");
  const n = Math.max(2, Math.ceil(curve.getLength() / step));
  return curve.getSpacedPoints(n).map(v => ({ x: v.x, z: v.z }));
}

export class Roads {
  /** defs: [{ name, points: [[x, z], …], closed }] */
  constructor(defs) {
    this.roads = defs.map(def => {
      const pts = sampleCurve(def.points, !!def.closed, SAMPLE);
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const tl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        pts[i].tx = (b.x - a.x) / tl;
        pts[i].tz = (b.z - a.z) / tl;
        if (i) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        pts[i].s = s;
        pts[i].y = 0;
      }
      return { name: def.name, closed: !!def.closed, pts, length: s };
    });
    // Grid of segments for fast nearest-road lookups
    this.grid = new Map();
    this.roads.forEach((r, ri) => {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        const reach = ROAD_HALF + SHOULDER + BLEND + 2;
        const x0 = Math.floor((Math.min(a.x, b.x) - reach) / CELL), x1 = Math.floor((Math.max(a.x, b.x) + reach) / CELL);
        const z0 = Math.floor((Math.min(a.z, b.z) - reach) / CELL), z1 = Math.floor((Math.max(a.z, b.z) + reach) / CELL);
        for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
          const k = gx * 4096 + gz;
          let list = this.grid.get(k);
          if (!list) this.grid.set(k, list = []);
          list.push(ri, i);
        }
      }
    });
    this._hit = { d: Infinity, road: null, i: 0, t: 0, y: 0, x: 0, z: 0 };
  }

  byName(name) { return this.roads.find(r => r.name === name); }

  /**
   * Closest point on any road centreline to (x, z), within the grid's reach.
   * Returns a reused { d, road, i, t, y, x, z } (d = Infinity when none).
   */
  nearest(x, z) {
    const out = this._hit;
    out.d = Infinity;
    out.road = null;
    const list = this.grid.get(Math.floor(x / CELL) * 4096 + Math.floor(z / CELL));
    if (!list) return out;
    for (let k = 0; k < list.length; k += 2) {
      const r = this.roads[list[k]], i = list[k + 1];
      const a = r.pts[i], b = r.pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2));
      const px = a.x + dx * t, pz = a.z + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < out.d) {
        out.d = d; out.road = r; out.i = i; out.t = t; out.x = px; out.z = pz;
        out.y = a.y + (b.y - a.y) * t;
      }
    }
    return out;
  }

  /** Distance from (x, z) to the nearest road centreline (Infinity if far). */
  distance(x, z) { return this.nearest(x, z).d; }

  /** True on the asphalt or its shoulders (plus `pad`). */
  onRoad(x, z, pad = 0) { return this.distance(x, z) < ROAD_HALF + SHOULDER + pad; }

  /** A point along a road at arc length s (clamped): { x, z, tx, tz, y }. */
  pointAt(road, s, out = {}) {
    const pts = road.pts;
    s = Math.min(road.length, Math.max(0, s));
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].s <= s) lo = m; else hi = m; }
    const a = pts[lo], b = pts[hi];
    const t = (s - a.s) / ((b.s - a.s) || 1);
    out.x = a.x + (b.x - a.x) * t;
    out.z = a.z + (b.z - a.z) * t;
    out.tx = a.tx + (b.tx - a.tx) * t;
    out.tz = a.tz + (b.tz - a.tz) * t;
    const tl = Math.hypot(out.tx, out.tz) || 1;
    out.tx /= tl; out.tz /= tl;
    out.y = a.y + (b.y - a.y) * t;
    return out;
  }

  /** Arc length of the road sample nearest (x, z). */
  arcNear(road, x, z) {
    let best = Infinity, s = 0;
    for (const p of road.pts) {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < best) { best = d; s = p.s; }
    }
    return s;
  }

  /**
   * Height profiles: the ground (`heightAt`, after the town pads) along each
   * road, eased over ~40 m. Samples inside a `level` disc ({ x, z, r, y }:
   * the towns) hold that disc's height exactly.
   */
  setProfile(heightAt, level = []) {
    for (const r of this.roads) {
      const pts = r.pts, n = pts.length;
      const fixed = new Array(n).fill(null);
      for (let i = 0; i < n; i++) {
        pts[i].y = heightAt(pts[i].x, pts[i].z);
        for (const l of level) if (Math.hypot(pts[i].x - l.x, pts[i].z - l.z) < l.r) { fixed[i] = l.y; break; }
      }
      const y = pts.map(p => p.y), tmp = new Float32Array(n);
      for (let pass = 0; pass < 4; pass++) {
        for (let i = 0; i < n; i++) {
          if (fixed[i] !== null) { tmp[i] = fixed[i]; continue; }
          let sum = 0, w = 0;
          for (let k = -6; k <= 6; k++) {
            let j = i + k;
            if (r.closed) j = (j + n) % n; else if (j < 0 || j >= n) continue;
            const wk = 7 - Math.abs(k);
            sum += y[j] * wk; w += wk;
          }
          tmp[i] = sum / w;
        }
        for (let i = 0; i < n; i++) y[i] = tmp[i];
      }
      for (let i = 0; i < n; i++) pts[i].y = y[i];
    }
  }

  /** buildTerrain modify: level the ground under the road and its shoulders, ease back into the hills. */
  modify(x, z, h) {
    const n = this.nearest(x, z);
    if (n.d >= ROAD_HALF + SHOULDER + BLEND) return h;
    const t = smooth(ROAD_HALF + SHOULDER, ROAD_HALF + SHOULDER + BLEND, n.d);
    return n.y + (h - n.y) * t;
  }

  /** buildTerrain tint: packed dirt beside the asphalt. */
  tint(x, z, c) {
    const d = this.distance(x, z);
    const reach = ROAD_HALF + SHOULDER + 2;
    if (d >= reach) return;
    const k = 1 - smooth(ROAD_HALF + SHOULDER - 0.4, reach, d);
    c.lerp(_dirt, k * 0.8);
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  /** One mesh for every road: asphalt with edge lines and a dashed centre line. */
  buildMesh(scene) {
    const tex = makeAsphaltTexture();
    tex.anisotropy = QUALITY.anisotropy ?? 4;
    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.93, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const geos = this.roads.map((r, ri) => {
      const pts = r.closed ? [...r.pts, r.pts[0]] : r.pts;
      const n = pts.length;
      const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), nor = new Float32Array(n * 2 * 3);
      // Stacked a hair apart, so crossing roads don't flicker where they overlap
      const lift = 0.07 + ri * 0.012;
      let s = 0;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        if (i) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
        const nx = p.tz, nz = -p.tx; // right of the direction of travel
        for (let side = 0; side < 2; side++) {
          const k = i * 2 + side, sgn = side ? 1 : -1;
          pos[k * 3] = p.x + nx * ROAD_HALF * sgn;
          pos[k * 3 + 1] = p.y + lift;
          pos[k * 3 + 2] = p.z + nz * ROAD_HALF * sgn;
          nor[k * 3 + 1] = 1;
          uv[k * 2] = side;
          uv[k * 2 + 1] = s / 8;
        }
      }
      const idx = [];
      for (let i = 0; i < n - 1; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      return g;
    });
    const geo = mergeGeometries(geos, false);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    this.mesh = mesh;
    return mesh;
  }

  /**
   * Wear on the asphalt: potholes (dark broken-edged dips) and patched
   * squares, two instanced decal meshes laid on the road surface (no
   * colliders, so they never upset driving). Fewer through the towns' level
   * stretches, more out on the country roads. skip(x, z): none there (bridges).
   */
  buildPotholes(scene, rng, skip = () => false) {
    const holes = [], patches = [];
    const at = {};
    this.roads.forEach((r, ri) => {
      const lift = 0.07 + ri * 0.012 + 0.008;
      for (let s = 6; s < r.length - 6; s += 9 + rng() * 14) {
        this.pointAt(r, s, at);
        const near = this.nearest(at.x, at.z);
        if (near.road !== r) continue;            // a junction: the other road is on top
        if (skip(at.x, at.z)) continue;
        // Level stretches (towns) are kept better
        const town = Math.abs(at.y - this.pointAt(r, s + 30, {}).y) < 0.01 && Math.abs(at.y - this.pointAt(r, s - 30, {}).y) < 0.01;
        if (rng() < (town ? 0.8 : 0.25)) continue;
        const across = (rng() * 2 - 1) * (ROAD_HALF - 0.9);
        const nx = at.tz, nz = -at.tx;
        const x = at.x + nx * across, z = at.z + nz * across, y = at.y + lift;
        const yaw = Math.atan2(at.tx, at.tz) + (rng() - 0.5) * 0.5;
        if (rng() < 0.7) holes.push({ x, y, z, yaw, sx: 0.7 + rng() * 0.8, sz: 0.55 + rng() * 0.7 });
        else patches.push({ x, y: y - 0.002, z, yaw, sx: 1 + rng() * 1.6, sz: 0.8 + rng() * 1.8 });
      }
    });
    // A pothole: jagged disc, darker in the middle (vertex colour), facing up
    const holeGeo = new THREE.CircleGeometry(1, 12).rotateX(-Math.PI / 2);
    const hp = holeGeo.attributes.position, col = new Float32Array(hp.count * 3);
    for (let i = 0; i < hp.count; i++) {
      const rim = i === 0 ? 0 : 0.75 + Math.sin(i * 2.7) * 0.15 + Math.cos(i * 5.1) * 0.1;
      hp.setXYZ(i, hp.getX(i) * rim, 0, hp.getZ(i) * rim);
      const k = i === 0 ? 0.2 : 0.6;
      col.set([k, k, k], i * 3);
    }
    holeGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const decal = (geo, color, list, vertexColors) => {
      if (!list.length) return;
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 1, vertexColors,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3();
      list.forEach((h, i) => mesh.setMatrixAt(i, m.compose(p.set(h.x, h.y, h.z), q.setFromAxisAngle(up, h.yaw), sc.set(h.sx, 1, h.sz))));
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.computeBoundingSphere();
      scene.add(mesh);
    };
    decal(holeGeo, 0x2a2826, holes, true);
    decal(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), 0x34312e, patches, false);
    this.potholes = holes.length;
  }

  /**
   * Power poles every POLE_SPACING metres beside each road, with three sagging
   * wires between neighbours. blocked(x, z): no pole there (houses, yards,
   * rock). groundAt(x, z): height for the pole's foot. Each pole gets a
   * cylinder collider and a minimap dot (mapObstacles).
   */
  buildPoles({ scene, world, material, blocked, groundAt, mapObstacles }) {
    const poles = [];
    const at = {};
    for (const r of this.roads) {
      let prev = null;
      for (let s = POLE_SPACING * 0.5; s < r.length - 4; s += POLE_SPACING) {
        this.pointAt(r, s, at);
        const nx = at.tz, nz = -at.tx;
        const x = at.x - nx * POLE_SIDE, z = at.z - nz * POLE_SIDE;
        // Not at junctions (another road close by), not in or against buildings
        const near = this.nearest(x, z);
        const ok = near.road === r && near.d > POLE_SIDE - 0.5 && Math.hypot(x, z) < shoreRadius(x, z) - 20 && !blocked(x, z);
        if (!ok) { prev = null; continue; }
        // Local +Z along the road, so the crossarm (local X) spans across it
        const pole = { x, z, y: groundAt(x, z), yaw: Math.atan2(at.tx, at.tz), road: r, s, prev, transformer: poles.length % 5 === 2 };
        poles.push(pole);
        prev = pole;
      }
    }
    if (!poles.length) return poles;

    // One instanced mesh for the poles, one for the transformer drums
    const { pole: poleGeo, drum: drumGeo } = makePoleGeometry();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.05 });
    const im = new THREE.InstancedMesh(poleGeo, mat, poles.length);
    const drums = poles.filter(p => p.transformer);
    const dm = new THREE.InstancedMesh(drumGeo, mat, Math.max(1, drums.length));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p3 = new THREE.Vector3();
    poles.forEach((p, i) => {
      im.setMatrixAt(i, m.compose(p3.set(p.x, p.y - 0.1, p.z), q.setFromAxisAngle(up, p.yaw), one));
    });
    drums.forEach((p, i) => {
      dm.setMatrixAt(i, m.compose(p3.set(p.x, p.y - 0.1, p.z), q.setFromAxisAngle(up, p.yaw), one));
    });
    dm.count = drums.length;
    for (const mesh of [im, dm]) {
      mesh.userData.chunk = true; // split per map cell by main.js (WorldChunks)
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      scene.add(mesh);
    }

    // Wires: three per span, sagging between the crossarm ends
    const segs = [];
    const SUB = 10;
    for (const p of poles) {
      const a = p.prev;
      if (!a || Math.hypot(p.x - a.x, p.z - a.z) > POLE_SPACING * 1.6) continue;
      for (const off of [-0.68, 0, 0.68]) {
        const ax = a.x + Math.cos(a.yaw) * off, az = a.z - Math.sin(a.yaw) * off, ay = a.y + ARM_Y + 0.18;
        const bx = p.x + Math.cos(p.yaw) * off, bz = p.z - Math.sin(p.yaw) * off, by = p.y + ARM_Y + 0.18;
        for (let k = 0; k < SUB; k++) {
          for (const t of [k / SUB, (k + 1) / SUB]) {
            segs.push(ax + (bx - ax) * t, ay + (by - ay) * t - 4 * WIRE_SAG * t * (1 - t), az + (bz - az) * t);
          }
        }
      }
    }
    if (segs.length) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
      wg.computeBoundingSphere();
      const wires = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x161615 }));
      wires.matrixAutoUpdate = false;
      scene.add(wires);
    }

    // Colliders (cannon's Cylinder is Y-aligned already) and minimap dots
    const shape = new CANNON.Cylinder(0.16, 0.18, POLE_H, 6);
    for (const p of poles) {
      const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
      body.addShape(shape);
      body.position.set(p.x, p.y + POLE_H / 2 - 0.1, p.z);
      world.addBody(body);
      mapObstacles?.push({ type: "circle", x: p.x, z: p.z, r: 0.25, pole: true });
    }
    return poles;
  }

  /** Centrelines for the maps: [{ pts: [x0, z0, x1, z1, …], closed }]. */
  mapLines() {
    return this.roads.map(r => {
      const pts = [];
      for (let i = 0; i < r.pts.length; i += 2) pts.push(r.pts[i].x, r.pts[i].z);
      const last = r.pts[r.pts.length - 1];
      pts.push(last.x, last.z);
      return { pts, closed: r.closed, width: ROAD_HALF * 2 };
    });
  }
}

const _dirt = new THREE.Color(0.62, 0.53, 0.42);

/** Asphalt with a little grain, white edge lines and a dashed yellow centre line. */
function makeAsphaltTexture() {
  const w = 64, h = 256;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = 52 + Math.random() * 18 + (Math.random() < 0.04 ? 22 : 0);
      img.data[i] = n; img.data[i + 1] = n; img.data[i + 2] = n + 3; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.globalAlpha = 0.85;
  g.fillStyle = "#e8e4d8";
  g.fillRect(3, 0, 2, h);
  g.fillRect(w - 5, 0, 2, h);
  g.fillStyle = "#e0b33a";
  g.fillRect(w / 2 - 1, 0, 2, h * 0.45);
  // A few cracks and tar patches
  g.globalAlpha = 0.35;
  g.strokeStyle = "#1d1d1f";
  for (let k = 0; k < 5; k++) {
    g.beginPath();
    let x = 8 + Math.random() * (w - 16), y = Math.random() * h;
    g.moveTo(x, y);
    for (let j = 0; j < 4; j++) { x += (Math.random() - 0.5) * 10; y += Math.random() * 14; g.lineTo(x, y); }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A weathered wooden pole with a crossarm and three insulators; the transformer drum apart. */
function makePoleGeometry() {
  const parts = [];
  const add = (geo, color, x, y, z) => {
    geo.translate(x, y, z);
    const n = geo.attributes.position.count, col = new Float32Array(n * 3), c = new THREE.Color(color);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.deleteAttribute("uv");
    parts.push(geo);
  };
  add(new THREE.CylinderGeometry(0.11, 0.16, POLE_H, 7), 0x5c4a39, 0, POLE_H / 2, 0);
  add(new THREE.BoxGeometry(1.75, 0.13, 0.13), 0x47392c, 0, ARM_Y, 0);
  add(new THREE.BoxGeometry(0.06, 0.6, 0.06), 0x47392c, 0.45, ARM_Y - 0.28, 0); // brace
  for (const x of [-0.68, 0, 0.68]) add(new THREE.CylinderGeometry(0.045, 0.06, 0.18, 6), 0xd9d4c6, x, ARM_Y + 0.12, 0);
  const pole = mergeGeometries(parts.map(g => g.toNonIndexed()), false);
  pole.computeVertexNormals();

  const drumParts = [];
  const drum = new THREE.CylinderGeometry(0.28, 0.28, 0.8, 10).translate(0, ARM_Y - 1.4, 0.32);
  const lid = new THREE.CylinderGeometry(0.3, 0.3, 0.06, 10).translate(0, ARM_Y - 0.97, 0.32);
  for (const [g, color] of [[drum, 0x7d858a], [lid, 0x5f666b]]) {
    const n = g.attributes.position.count, col = new Float32Array(n * 3), c = new THREE.Color(color);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.deleteAttribute("uv");
    drumParts.push(g.toNonIndexed());
  }
  const drumGeo = mergeGeometries(drumParts, false);
  drumGeo.computeVertexNormals();
  return { pole, drum: drumGeo };
}
