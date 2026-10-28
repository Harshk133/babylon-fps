import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { fbm, groundHeight, shoreRadius } from "./Terrain.js";
import { QUALITY, QUALITY_NAME } from "../quality.js";

// Farmland: rectangular fields in the open country between the towns, lined
// up with the nearest road like real plots. Each field grows one crop:
//
//   sugarcane  2.6–3.4 m clumps in rows, with a walking lane every few rows.
//              Taller than a standing player: inCane() makes you much harder
//              for monsters (and battle royale bots) to spot.
//   wheat      knee-high golden stalks.
//   veg        low, dark green rows (a vegetable plot).
//   stubble    a harvested field: short dry tufts and haystacks.
//   ploughed   bare furrowed soil (ridges, no crop).
//
// Crops are decoration (no colliders, bullets pass): every field is one
// InstancedMesh per crop (frustum culled per field, hidden past DRAW_DIST),
// swaying in the vertex shader. Its instances are shuffled, so drawing only
// the first `count` thins the whole field evenly: far fields draw fewer
// clumps (FULL_DIST … DRAW_DIST down to FAR_SHARE), the bare soil under
// them fills the gaps. The layout is seeded and identical on every
// quality preset; only the number of clumps per field follows QUALITY.
// The terrain under a field is tinted to its soil (tint) and has no grass
// (grass). layoutFields() runs before the terrain; build() after it.

const KINDS = {
  sugarcane: { soil: [0.5, 0.4, 0.3], spacing: 1.05, row: 1.25, lane: 7 },
  wheat:     { soil: [0.78, 0.64, 0.42], spacing: 0.75, row: 0.62 },
  veg:       { soil: [0.46, 0.36, 0.27], spacing: 0.7, row: 1.0 },
  stubble:   { soil: [0.78, 0.66, 0.44], spacing: 1.3, row: 1.3 },
  ploughed:  { soil: [0.52, 0.4, 0.29], row: 0.95 },
};
const DRAW_DIST = 165;     // m: fields past this are hidden (the fog has them anyway)
const FULL_DIST = 45;      // m: every clump drawn up to here…
const FAR_SHARE = 0.28;    // …thinning to this share at DRAW_DIST
const EDGE = 1.2;          // m of bare soil inside the field's border
const DENSITY = { low: 0.55, medium: 0.8, high: 1 };

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Picks the fields. rng: seeded; blocked(x, z, pad): true where a field may
 * not reach (roads, houses, yards, caves, water, the shore, reserved spots);
 * roads: for the plot direction. Returns [{ kind, x, z, rot, hw, hd }].
 */
export function layoutFields({ rng, blocked, roads, count = 40 }) {
  const fields = [];
  const corners = (f, pad) => {
    const c = Math.cos(f.rot), s = Math.sin(f.rot), out = [];
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0], [0, 0], [0.5, 0.5], [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5]]) {
      const lx = a * (f.hw + pad), lz = b * (f.hd + pad);
      out.push([f.x + lx * c + lz * s, f.z - lx * s + lz * c]);
    }
    return out;
  };
  for (let attempt = 0; attempt < count * 60 && fields.length < count; attempt++) {
    const a = rng() * Math.PI * 2, x0 = Math.cos(a), z0 = Math.sin(a);
    const r = 40 + Math.sqrt(rng()) * (shoreRadius(x0, z0) - 80);
    const x = x0 * r, z = z0 * r;
    const near = roads.nearest(x, z);
    // Plots run square to the nearest road (or to the compass out in the open)
    let rot = near.d < 80 && near.road ? Math.atan2(near.road.pts[near.i].tx, near.road.pts[near.i].tz) : Math.round(fbm(x / 200, z / 200, 2, 5) * 4) * Math.PI / 2;
    rot += (rng() - 0.5) * 0.12;
    const f = { x, z, rot, hw: 9 + rng() * 12, hd: 7 + rng() * 8, kind: null };
    if (fields.some(o => Math.hypot(o.x - x, o.z - z) < Math.hypot(o.hw, o.hd) + Math.hypot(f.hw, f.hd) + 3)) continue;
    if (corners(f, 2).some(([cx, cz]) => blocked(cx, cz, 2))) continue;
    // Sugarcane grows in belts; the rest is mixed
    const belt = fbm(x / 110 + 3, z / 110 - 7, 3, 61);
    const roll = rng();
    f.kind = belt > 0.66 ? (roll < 0.75 ? "sugarcane" : "wheat")
      : roll < 0.15 ? "sugarcane" : roll < 0.45 ? "wheat" : roll < 0.62 ? "veg" : roll < 0.82 ? "stubble" : "ploughed";
    // Sugarcane: a walking lane through the rows every few metres (here, not in
    // build(): inCane() reads them, so they must not depend on the quality preset)
    const lane = KINDS[f.kind].lane;
    if (lane) {
      f.lanes = [];
      for (let lx = -f.hw + lane * (0.5 + rng() * 0.5); lx < f.hw - 2; lx += lane + rng() * 3) f.lanes.push(lx);
    }
    fields.push(f);
  }
  return fields;
}

/** Field-local coordinates of (x, z) (lx along hw, lz along hd) into out. */
function toLocal(f, x, z, out) {
  const dx = x - f.x, dz = z - f.z, c = Math.cos(f.rot), s = Math.sin(f.rot);
  out.x = dx * c - dz * s;
  out.z = dx * s + dz * c;
  return out;
}
const _l = { x: 0, z: 0 };

// ── Crop geometry (one clump, its own frame: y up, base at 0) ────────────────
function blade(len, width, bend, yaw, tilt, color, out, segs = 2) {
  // A tapering blade bent outward in segments (the tip one a single
  // triangle: 3 triangles for two segments); vertex colours darken at the base
  const pos = [], col = [];
  // Colours are written as sRGB; vertex colours are linear
  const lin = color.map(v => Math.pow(v, 2.2));
  let px = 0, py = 0, ang = tilt;
  const pts = [[0, 0]];
  for (let i = 1; i <= segs; i++) {
    ang += bend / segs;
    px += Math.sin(ang) * len / segs;
    py += Math.cos(ang) * len / segs;
    pts.push([px, py]);
  }
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  // Out along (cy, −sy), across along (sy, cy)
  const at = (p, side, w) => [p[0] * cy + side * w * sy, p[1], -p[0] * sy + side * w * cy];
  for (let i = 0; i < segs; i++) {
    const w0 = width * (1 - i / segs), w1 = width * (1 - (i + 1) / segs);
    const a = at(pts[i], -1, w0 / 2), b = at(pts[i], 1, w0 / 2), c = at(pts[i + 1], -1, w1 / 2), d = at(pts[i + 1], 1, w1 / 2);
    const k0 = 0.72 + 0.28 * (i / segs), k1 = 0.72 + 0.28 * ((i + 1) / segs);
    if (i === segs - 1) {
      pos.push(...a, ...b, ...c);  // the tip: c and d meet
      for (const k of [k0, k0, k1]) col.push(lin[0] * k, lin[1] * k, lin[2] * k);
      continue;
    }
    pos.push(...a, ...b, ...c, ...b, ...d, ...c);
    for (const k of [k0, k0, k1, k0, k1, k1]) col.push(lin[0] * k, lin[1] * k, lin[2] * k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  out.push(g);
}

function stalk(h, r, color, out) {
  const g = new THREE.CylinderGeometry(r * 0.8, r, h, 3, 1, true).translate(0, h / 2, 0).toNonIndexed();
  g.deleteAttribute("uv"); g.deleteAttribute("normal");
  const n = g.attributes.position.count, col = new Float32Array(n * 3);
  const lin = color.map(v => Math.pow(v, 2.2));
  for (let i = 0; i < n; i++) col.set(lin, i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.push(g);
}

function cropGeometry(kind) {
  const parts = [];
  const r = THREE.MathUtils.seededRandom;
  THREE.MathUtils.seededRandom(1234);
  if (kind === "sugarcane") {
    for (let i = 0; i < 2; i++) {
      const g = []; stalk(2.55 + i * 0.3, 0.04, [0.52, 0.55, 0.3], g);
      g[0].translate((i - 0.5) * 0.16, 0, i * 0.08);
      parts.push(...g);
    }
    for (let i = 0; i < 8; i++) blade(1.5 + r() * 0.5, 0.12, 1.2 + r() * 0.5, (i / 8) * Math.PI * 2, 0.15, [0.3 + r() * 0.08, 0.5, 0.18], parts);
    for (const g of parts.slice(2)) g.translate(0, 1.0 + r() * 0.9, 0);
  } else if (kind === "wheat") {
    // A tussock of stalks fanning out, each with a fat golden ear on top
    for (let i = 0; i < 8; i++) {
      const yaw = (i / 8) * Math.PI * 2 + r() * 0.5, tilt = 0.06 + r() * 0.16, len = 0.75 + r() * 0.25;
      blade(len, 0.05, 0.12, yaw, tilt, [0.78, 0.66, 0.36], parts, 1);
      const g = []; blade(0.22, 0.085, 0, yaw, tilt, [0.92, 0.76, 0.4], g, 2);
      g[0].translate(Math.cos(yaw) * Math.sin(tilt) * len, len * 0.97, -Math.sin(yaw) * Math.sin(tilt) * len);
      parts.push(...g);
    }
  } else if (kind === "veg") {
    for (let i = 0; i < 7; i++) blade(0.42 + r() * 0.12, 0.22, 1.3, (i / 7) * Math.PI * 2, 0.4, [0.2, 0.42, 0.16], parts);
  } else {
    // stubble: short dry tufts
    for (let i = 0; i < 6; i++) blade(0.22 + r() * 0.08, 0.05, 0.4, (i / 6) * Math.PI * 2, 0.2, [0.74, 0.62, 0.38], parts, 1);
  }
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  // Grass-like lighting: normals mostly up, so both sides of a blade light alike
  const nor = geo.attributes.normal;
  for (let i = 0; i < nor.count; i++) {
    const nx = nor.getX(i) * 0.35, nz = nor.getZ(i) * 0.35;
    const l = Math.hypot(nx, 1, nz);
    nor.setXYZ(i, nx / l, 1 / l, nz / l);
  }
  return geo;
}

const cropUniforms = { uTime: { value: 0 }, uWind: { value: 0.35 } };

function cropMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, cropUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uWind;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 base = instanceMatrix[3].xz;
          float sway = sin(uTime * 1.7 + base.x * 0.31 + base.y * 0.23) + 0.5 * sin(uTime * 2.9 + base.x * 0.7);
          float bendK = transformed.y * transformed.y * 0.025;
          transformed.x += sway * uWind * bendK;
          transformed.z += sway * uWind * bendK * 0.5;
        #endif`);
    // Both faces of a blade lit alike: the normals point up, never flipped for the back face
    shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_begin>", `
      float faceDirection = 1.0;
      vec3 normal = normalize( vNormal );
      vec3 nonPerturbedNormal = normal;`);
  };
  mat.customProgramCacheKey = () => "crop";
  return mat;
}

// Ploughed ridges, stacked haystacks
function furrowGeometry() {
  // A low rounded ridge 1 m long along local x, 0.5 m wide
  // (half a cylinder: axis to z, the round side up)
  const g = new THREE.CylinderGeometry(0.28, 0.28, 1.02, 5, 1, true, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2);
  g.scale(1, 0.5, 1);
  return g;
}

export class Farmland {
  /** fields: from layoutFields(). */
  constructor(fields) {
    this.fields = fields;
    this.meshes = [];
    for (const f of fields) {
      // Field-wide bounds for quick rejects
      f.r = Math.hypot(f.hw, f.hd);
    }
    this.cane = fields.filter(f => f.kind === "sugarcane");
  }

  _inField(x, z, pad = 0) {
    for (const f of this.fields) {
      if (Math.abs(x - f.x) > f.r + pad || Math.abs(z - f.z) > f.r + pad) continue;
      toLocal(f, x, z, _l);
      if (Math.abs(_l.x) < f.hw + pad && Math.abs(_l.z) < f.hd + pad) return f;
    }
    return null;
  }

  /** True in a sugarcane field's crop (not on its lanes or border). */
  inCane(x, z) {
    for (const f of this.cane) {
      if (Math.abs(x - f.x) > f.r || Math.abs(z - f.z) > f.r) continue;
      toLocal(f, x, z, _l);
      if (Math.abs(_l.x) > f.hw - EDGE || Math.abs(_l.z) > f.hd - EDGE) continue;
      if (f.lanes?.some(lx => Math.abs(_l.x - lx) < 0.9)) continue;
      return true;
    }
    return false;
  }

  /** True on (or within pad of) any field: trees, rocks and loot keep off. */
  blocks(x, z, pad = 0) { return !!this._inField(x, z, pad); }

  /** buildTerrain grass mask: none inside the fields, thin at their edge. */
  grass(x, z) {
    const f = this._inField(x, z, 1.5);
    if (!f) return 1;
    toLocal(f, x, z, _l);
    const edge = Math.min(f.hw - Math.abs(_l.x), f.hd - Math.abs(_l.z));
    return smooth(0, -1.5, edge) * 0.6;
  }

  /** buildTerrain tint: each field's soil, darker toward the middle. */
  tint(x, z, c) {
    const f = this._inField(x, z, 1);
    if (!f) return;
    toLocal(f, x, z, _l);
    const edge = Math.min(f.hw - Math.abs(_l.x), f.hd - Math.abs(_l.z));
    const k = smooth(-1, 1.5, edge);
    const soil = KINDS[f.kind].soil;
    _c.setRGB(soil[0], soil[1], soil[2]).multiplyScalar(0.92 + fbm(x / 7, z / 7, 2, 90) * 0.16);
    c.lerp(_c, k * 0.9);
  }

  /** Builds the crops, furrows and haystacks on the finished terrain. rng: seeded (layout only). */
  build(scene, rng) {
    const dens = DENSITY[QUALITY_NAME] ?? (QUALITY.grass < 4000 ? DENSITY.low : QUALITY.grass < 9000 ? DENSITY.medium : DENSITY.high);
    const mat = cropMaterial();
    const geos = {};
    const furrow = furrowGeometry();
    const soilMat = new THREE.MeshStandardMaterial({ color: 0x6a4e36, roughness: 1 });
    const hayGeo = new THREE.CylinderGeometry(0.9, 1.25, 1.6, 9).translate(0, 0.8, 0);
    const hayTop = new THREE.ConeGeometry(0.95, 0.9, 9).translate(0, 2.05, 0);
    const hayMat = new THREE.MeshStandardMaterial({ color: 0xc9a65a, roughness: 1 });
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const hay = [];
    for (const f of this.fields) {
      const K = KINDS[f.kind];
      const c = Math.cos(f.rot), sn = Math.sin(f.rot);
      const world = (lx, lz) => [f.x + lx * c + lz * sn, f.z - lx * sn + lz * c];
      const mats = [];
      if (f.kind === "ploughed") {
        // Ridges along local z, every K.row metres across x, in 1 m pieces that follow the ground
        for (let lx = -f.hw + EDGE; lx <= f.hw - EDGE; lx += K.row) {
          for (let lz = -f.hd + EDGE; lz <= f.hd - EDGE; lz += 1) {
            const [x, z] = world(lx, lz);
            q.setFromAxisAngle(up, f.rot);
            mats.push(m4.compose(p.set(x, groundHeight(x, z) - 0.04, z), q, s.set(1, 1, 1)).clone());
          }
        }
        const mesh = new THREE.InstancedMesh(furrow, soilMat, mats.length);
        mats.forEach((m, i) => mesh.setMatrixAt(i, m));
        this._add(scene, mesh, f);
        continue;
      }
      geos[f.kind] ??= cropGeometry(f.kind);
      const step = K.spacing / Math.sqrt(dens);
      for (let lz = -f.hd + EDGE; lz <= f.hd - EDGE; lz += K.row) {
        for (let lx = -f.hw + EDGE; lx <= f.hw - EDGE; lx += step) {
          if (f.lanes?.some(l => Math.abs(lx - l) < 0.9)) continue;
          const jx = lx + (rng() - 0.5) * step * 0.5, jz = lz + (rng() - 0.5) * K.row * 0.3;
          const [x, z] = world(jx, jz);
          const k = 0.8 + rng() * 0.4;
          q.setFromAxisAngle(up, rng() * Math.PI * 2);
          mats.push(m4.compose(p.set(x, groundHeight(x, z) - 0.05, z), q, s.set(k, k * (0.9 + rng() * 0.25), k)).clone());
        }
      }
      if (mats.length) {
        // Shuffled, so a partial count thins the field evenly
        for (let i = mats.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [mats[i], mats[j]] = [mats[j], mats[i]]; }
        const mesh = new THREE.InstancedMesh(geos[f.kind], mat, mats.length);
        mesh.userData.thin = true;
        mats.forEach((m, i) => mesh.setMatrixAt(i, m));
        this._add(scene, mesh, f);
      }
      if (f.kind === "stubble") {
        // A few haystacks on the harvested field
        for (let i = 0, n = 2 + Math.floor(rng() * 3); i < n; i++) {
          const [x, z] = world((rng() - 0.5) * (f.hw - 3) * 2, (rng() - 0.5) * (f.hd - 3) * 2);
          hay.push({ x, z, s: 0.85 + rng() * 0.35 });
        }
      }
    }
    if (hay.length) {
      for (const g of [hayGeo, hayTop]) {
        const mesh = new THREE.InstancedMesh(g, hayMat, hay.length);
        hay.forEach((h, i) => mesh.setMatrixAt(i, m4.compose(p.set(h.x, groundHeight(h.x, h.z) - 0.1, h.z), q.identity(), s.setScalar(h.s))));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        mesh.matrixAutoUpdate = false;
        scene.add(mesh);
      }
    }
    this.haystacks = hay;
  }

  _add(scene, mesh, f) {
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.computeBoundingSphere();
    mesh.userData.field = f;
    scene.add(mesh);
    this.meshes.push(mesh);
  }

  /** Every frame: wind and time for the sway, far fields hidden. */
  update(time, wind, camX, camZ) {
    cropUniforms.uTime.value = time;
    cropUniforms.uWind.value = 0.25 + wind * 0.6;
    for (const m of this.meshes) {
      const f = m.userData.field;
      const d = Math.max(0, Math.hypot(f.x - camX, f.z - camZ) - f.r);
      m.visible = d < DRAW_DIST;
      if (m.visible && m.userData.thin) {
        const share = 1 - (1 - FAR_SHARE) * smooth(FULL_DIST, DRAW_DIST, d);
        m.count = Math.max(1, Math.round(m.instanceMatrix.count * share));
      }
    }
  }

  /** Shows everything (the loading-screen shader warm-up). */
  showAll() { for (const m of this.meshes) { m.visible = true; m.count = m.instanceMatrix.count; } }

  /** For the maps: [{ kind, x, z, rot, hw, hd }]. */
  mapInfo() { return this.fields.map(({ kind, x, z, rot, hw, hd }) => ({ kind, x, z, rot, hw, hd })); }
}

const _c = new THREE.Color();
