import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GROUP_WORLD, GROUP_PLAYER, GROUP_PROJECTILE } from "../physicsGroups.js";

// Rolling ground: a seeded heightmap over the whole map, flattened under the
// houses and props, falling away into the sea round the edge: the map is an
// island (shoreRadius() is its coastline, SEA_Y the water level).
//
// One grid feeds everything: cannon Heightfield tiles (physics), a single
// render mesh, and a half-float texture (R = height, G = grass density) that
// GPU effects sample with TERRAIN_GLSL, so grass, rain splashes and mist sit
// on the ground without any CPU work. groundHeight(x, z) is the CPU lookup
// every system uses instead of assuming y = 0.

export const TERRAIN_HALF = 520;              // the grid spans −HALF … +HALF on x and z
export const TERRAIN_STEP = 2.5;              // metres between height samples
export const TERRAIN_N = Math.round((TERRAIN_HALF * 2) / TERRAIN_STEP) + 1;
export const PLAY_RADIUS = 510;               // hard limit (the sea turns you back well before it)
export const SHORE_R = 470;                   // the coast's average distance from the centre
export const SEA_Y = -3.2;                    // sea level (land is around 0)
const BEACH_IN = 26;                          // m inland of the waterline where the land starts sloping to the sea
const SEA_SLOPE = 0.2;                        // drop per metre past the waterline
export const SEA_INLAND = 6;                  // m inland of the waterline the sea (mesh, depth) starts; the caves keep further in
const TILE_CELLS = 33;                        // physics tile size (cells); keeps long rays cheap
const RENDER_TILE = 40;                       // render tile size (cells, 100 m): culled by view and by distance

let heights = null;                           // Float32Array N×N, row-major [iz * N + ix]

// ── Noise ────────────────────────────────────────────────────────────────────
function hash(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz, seed), b = hash(ix + 1, iz, seed);
  const c = hash(ix, iz + 1, seed), d = hash(ix + 1, iz + 1, seed);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

export function fbm(x, z, octaves, seed) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x, z, seed + o * 17) * amp;
    norm += amp;
    x *= 2.03; z *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Distance of the waterline from the centre in the direction of (x, z): a
 * wobbly coast (~430 … 505 m; the roads end ~25 m inland) with two bays.
 */
export function shoreRadius(x, z) {
  const a = Math.atan2(z, x);
  const wob = fbm(Math.cos(a) * 2.6 + 9, Math.sin(a) * 2.6 + 9, 3, 41) - 0.5;
  const bay = Math.max(0, Math.cos(a - 2.4)) ** 14 * 26 + Math.max(0, Math.cos(a + 0.7)) ** 18 * 22;
  return SHORE_R + wob * 62 - bay;
}

/** Natural height before flattening: soft hills and small bumps (taller out in the new country), sloping into the sea past the shore. */
export function rawHeight(x, z) {
  // The old middle of the map keeps its gentle hills; past ~260 m they grow into real high ground
  const outer = smooth(240, 340, Math.hypot(x, z));
  const hills = (fbm(x / 95, z / 95, 4, 11) - 0.5) * 10 + outer * Math.max(0, fbm(x / 140 + 20, z / 140 - 4, 3, 17) - 0.45) * 26;
  const bumps = (vnoise(x / 8, z / 8, 23) - 0.5) * 0.6;
  const d = Math.hypot(x, z) - shoreRadius(x, z);       // < 0 on land, > 0 out at sea
  if (d < -BEACH_IN) return hills + bumps;
  // Beach: a straight slope through the waterline, rocky where the noise says so
  const coast = SEA_Y + 0.35 - d * SEA_SLOPE + (vnoise(x / 6, z / 6, 53) - 0.5) * 0.5;
  const e = smooth(-BEACH_IN, 4, d);
  return (hills + bumps) * (1 - e) + coast * e;
}

/**
 * Water depth over the sea floor at (x, z) (≤ 0 on dry land). Only near the
 * coast: inland, ground below sea level is a cave floor, not the sea. The
 * river and ponds are River.depthAt.
 */
export function seaDepth(x, z) {
  if (Math.hypot(x, z) < shoreRadius(x, z) - SEA_INLAND) return 0;
  return SEA_Y - groundHeight(x, z);
}

// ── Lookup ───────────────────────────────────────────────────────────────────
/** Ground height at (x, z), bilinear over the grid. 0 before the terrain exists. */
export function groundHeight(x, z) {
  if (!heights) return 0;
  const N = TERRAIN_N;
  let gx = (x + TERRAIN_HALF) / TERRAIN_STEP, gz = (z + TERRAIN_HALF) / TERRAIN_STEP;
  gx = Math.min(N - 1.001, Math.max(0, gx));
  gz = Math.min(N - 1.001, Math.max(0, gz));
  const ix = gx | 0, iz = gz | 0, fx = gx - ix, fz = gz - iz;
  const i = iz * N + ix;
  const a = heights[i], b = heights[i + 1], c = heights[i + N], d = heights[i + N + 1];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

// ── GPU access ───────────────────────────────────────────────────────────────
const placeholder = new THREE.DataTexture(new Uint16Array([0, 0x3c00]), 1, 1, THREE.RGFormat, THREE.HalfFloatType);
placeholder.needsUpdate = true;
/** Shared by every material that includes TERRAIN_GLSL (the texture is swapped in when built). */
export const terrainUniforms = {
  uTerrainMap: { value: placeholder },
  uTerrainInfo: { value: new THREE.Vector4(TERRAIN_HALF, TERRAIN_STEP, TERRAIN_N, 0) },
};
export const TERRAIN_GLSL = /* glsl */ `
  uniform sampler2D uTerrainMap;
  uniform vec4 uTerrainInfo;
  vec4 terrainSample(vec2 xz) {
    vec2 uv = ((xz + uTerrainInfo.x) / uTerrainInfo.y + 0.5) / uTerrainInfo.z;
    return texture2D(uTerrainMap, uv);
  }
  float terrainH(vec2 xz) { return terrainSample(xz).r; }
`;

/**
 * Height after the pads: each pad flattens a disc to its own level y
 * (default 0) and blends back into the hills over `fade` metres. Where pads
 * overlap, the one holding the ground flattest wins.
 */
export function flatHeight(x, z, pads) {
  let flat = 1, py = 0;
  for (const p of pads) {
    const dx = x - p.x, dz = z - p.z;
    const reach = p.r + p.fade;
    if (dx * dx + dz * dz >= reach * reach) continue;
    const f = smooth(p.r, reach, Math.sqrt(dx * dx + dz * dz));
    if (f < flat) { flat = f; py = p.y ?? 0; }
  }
  return py + (rawHeight(x, z) - py) * flat;
}

/**
 * Builds the ground.
 *   pads: [{ x, z, r, fade, y }] flat discs (at height y, default 0) under towns, houses, props and spawn
 *   grassMask(x, z): 0..1 grass density (0 inside houses, on props)
 *   renderStep: 1 = every height sample in the mesh, 2 = every other one
 *   modify(x, z, h): optional final say on each height (roads level it, the caves sink it)
 *   tint(x, z, color): optional final say on each vertex colour (dirt road shoulders)
 * Returns { tiles (render meshes, ~100 m square), bodies }.
 */
export function buildTerrain({ scene, world, material, physicsMaterial, pads, grassMask, renderStep = 1, modify = null, tint = null }) {
  const N = TERRAIN_N, H = TERRAIN_HALF, S = TERRAIN_STEP;
  heights = new Float32Array(N * N);
  for (let iz = 0; iz < N; iz++) {
    const z = -H + iz * S;
    for (let ix = 0; ix < N; ix++) {
      const x = -H + ix * S;
      const h = flatHeight(x, z, pads);
      heights[iz * N + ix] = modify ? modify(x, z, h) : h;
    }
  }

  // ── Physics: static heightfield tiles. Only the player and thrown things
  // collide with it; monsters are pinned to groundHeight() by their AI.
  const bodies = [];
  for (let tz = 0; tz < N - 1; tz += TILE_CELLS) {
    for (let tx = 0; tx < N - 1; tx += TILE_CELLS) {
      const nx = Math.min(TILE_CELLS, N - 1 - tx) + 1, nz = Math.min(TILE_CELLS, N - 1 - tz) + 1;
      // cannon: data[i][j] is the height at local (i·S, j·S); the body is turned so local +y is world −z
      const data = [];
      for (let i = 0; i < nx; i++) {
        const col = [];
        for (let j = 0; j < nz; j++) col.push(heights[(tz + nz - 1 - j) * N + tx + i]);
        data.push(col);
      }
      const body = new CANNON.Body({
        mass: 0, material: physicsMaterial,
        collisionFilterGroup: GROUP_WORLD,
        collisionFilterMask: GROUP_PLAYER | GROUP_PROJECTILE,
      });
      body.addShape(new CANNON.Heightfield(data, { elementSize: S }));
      body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
      body.position.set(-H + tx * S, 0, -H + (tz + nz - 1) * S);
      world.addBody(body);
      bodies.push(body);
    }
  }

  // ── Render mesh, tinted by height and slope: tiles of RENDER_TILE cells, so
  // the view frustum and the draw range (WorldChunks) drop most of the island
  const step = Math.max(1, renderStep | 0);
  const M = Math.floor((N - 1) / step) + 1;
  const pos = new Float32Array(M * M * 3), uv = new Float32Array(M * M * 2), col = new Float32Array(M * M * 3), nor = new Float32Array(M * M * 3);
  const grass = new THREE.Color(1, 1, 1), dirt = new THREE.Color(0.72, 0.62, 0.5), rock = new THREE.Color(0.55, 0.53, 0.52);
  const c = new THREE.Color();
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      const ix = i * step, iz = j * step, k = j * M + i;
      const x = -H + ix * S, z = -H + iz * S, y = heights[iz * N + ix];
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      uv[k * 2] = x / 2; uv[k * 2 + 1] = z / 2; // grass texture tiles every 2 m
      const gx = heights[iz * N + Math.min(N - 1, ix + 1)] - heights[iz * N + Math.max(0, ix - 1)];
      const gz = heights[Math.min(N - 1, iz + 1) * N + ix] - heights[Math.max(0, iz - 1) * N + ix];
      const slope = Math.hypot(gx, gz) / (2 * S);
      // Normal from the height gradient (the same either side of a tile seam)
      const nl = Math.hypot(gx / (2 * S), 1, gz / (2 * S));
      nor[k * 3] = -gx / (2 * S) / nl; nor[k * 3 + 1] = 1 / nl; nor[k * 3 + 2] = -gz / (2 * S) / nl;
      const patch = fbm(x / 14, z / 14, 2, 77);
      c.copy(grass).lerp(dirt, smooth(0.45, 0.75, patch) * 0.55).lerp(rock, smooth(0.35, 0.8, slope));
      c.multiplyScalar(0.86 + smooth(-3, 3, y) * 0.18);
      if (tint) tint(x, z, c);
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
  }
  material.vertexColors = true;
  material.needsUpdate = true;
  const T = Math.max(4, Math.round(RENDER_TILE / step));
  const tiles = [];
  for (let j0 = 0; j0 < M - 1; j0 += T) {
    for (let i0 = 0; i0 < M - 1; i0 += T) {
      const w = Math.min(T, M - 1 - i0) + 1, h = Math.min(T, M - 1 - j0) + 1;
      const tp = new Float32Array(w * h * 3), tu = new Float32Array(w * h * 2), tc = new Float32Array(w * h * 3), tn = new Float32Array(w * h * 3);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const src = (j0 + j) * M + i0 + i, dst = j * w + i;
          tp.set(pos.subarray(src * 3, src * 3 + 3), dst * 3);
          tn.set(nor.subarray(src * 3, src * 3 + 3), dst * 3);
          tc.set(col.subarray(src * 3, src * 3 + 3), dst * 3);
          tu.set(uv.subarray(src * 2, src * 2 + 2), dst * 2);
        }
      }
      const index = new Uint32Array((w - 1) * (h - 1) * 6);
      let n = 0;
      for (let j = 0; j < h - 1; j++) {
        for (let i = 0; i < w - 1; i++) {
          const a = j * w + i, b = a + 1, d = a + w, e = d + 1;
          index[n++] = a; index[n++] = d; index[n++] = b;
          index[n++] = b; index[n++] = d; index[n++] = e;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(tp, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(tn, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(tu, 2));
      geo.setAttribute("color", new THREE.BufferAttribute(tc, 3));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      scene.add(mesh);
      tiles.push(mesh);
    }
  }

  // ── Height + grass texture for the GPU effects
  const tex = new Uint16Array(N * N * 2);
  for (let iz = 0; iz < N; iz++) {
    const z = -H + iz * S;
    for (let ix = 0; ix < N; ix++) {
      const x = -H + ix * S, k = iz * N + ix;
      const r = Math.hypot(x, z);
      tex[k * 2] = THREE.DataUtils.toHalfFloat(heights[k]);
      tex[k * 2 + 1] = THREE.DataUtils.toHalfFloat(r > PLAY_RADIUS - 6 ? 0 : grassMask(x, z));
    }
  }
  const map = new THREE.DataTexture(tex, N, N, THREE.RGFormat, THREE.HalfFloatType);
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearFilter;
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  map.needsUpdate = true;
  terrainUniforms.uTerrainMap.value = map;

  return { tiles, bodies };
}
