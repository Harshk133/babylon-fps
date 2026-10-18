import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GROUP_WORLD, GROUP_PLAYER, GROUP_PROJECTILE } from "../physicsGroups.js";

// Rolling ground: a seeded heightmap over the whole map, flattened under the
// houses and props, rising into steep ridges at the edge (the map border).
//
// One grid feeds everything: cannon Heightfield tiles (physics), a single
// render mesh, and a half-float texture (R = height, G = grass density) that
// GPU effects sample with TERRAIN_GLSL, so grass, rain splashes and mist sit
// on the ground without any CPU work. groundHeight(x, z) is the CPU lookup
// every system uses instead of assuming y = 0.

export const TERRAIN_HALF = 330;              // the grid spans −HALF … +HALF on x and z
export const TERRAIN_STEP = 2.5;              // metres between height samples
export const TERRAIN_N = Math.round((TERRAIN_HALF * 2) / TERRAIN_STEP) + 1;
export const PLAY_RADIUS = 316;               // you can't go further out than this
const EDGE_START = 235;                       // the border ridges start rising here
const TILE_CELLS = 33;                        // physics tile size (cells); keeps long rays cheap

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

/** Natural height before flattening: soft hills, small bumps, border ridges. */
export function rawHeight(x, z) {
  const hills = (fbm(x / 95, z / 95, 4, 11) - 0.5) * 10;
  const bumps = (vnoise(x / 8, z / 8, 23) - 0.5) * 0.6;
  const r = Math.hypot(x, z);
  const e = smooth(EDGE_START, PLAY_RADIUS + 6, r);
  return (hills + bumps) * (1 - e * 0.6) + e * e * (20 + fbm(x / 35, z / 35, 3, 31) * 16);
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
 * Builds the ground.
 *   pads: [{ x, z, r, fade }] flat (y = 0) discs under houses, props and spawn
 *   grassMask(x, z): 0..1 grass density (0 inside houses, on props)
 *   renderStep: 1 = every height sample in the mesh, 2 = every other one
 *   modify(x, z, h): optional final say on each height (the caves sink the ground under them)
 * Returns { mesh, bodies }.
 */
export function buildTerrain({ scene, world, material, physicsMaterial, pads, grassMask, renderStep = 1, modify = null }) {
  const N = TERRAIN_N, H = TERRAIN_HALF, S = TERRAIN_STEP;
  heights = new Float32Array(N * N);
  for (let iz = 0; iz < N; iz++) {
    const z = -H + iz * S;
    for (let ix = 0; ix < N; ix++) {
      const x = -H + ix * S;
      let flat = 1;
      for (const p of pads) {
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < p.r + p.fade) flat = Math.min(flat, smooth(p.r, p.r + p.fade, d));
      }
      const h = rawHeight(x, z) * flat;
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

  // ── Render mesh: one draw call, tinted by height and slope
  const step = Math.max(1, renderStep | 0);
  const M = Math.floor((N - 1) / step) + 1;
  const pos = new Float32Array(M * M * 3), uv = new Float32Array(M * M * 2), col = new Float32Array(M * M * 3);
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
      const patch = fbm(x / 14, z / 14, 2, 77);
      c.copy(grass).lerp(dirt, smooth(0.45, 0.75, patch) * 0.55).lerp(rock, smooth(0.35, 0.8, slope));
      c.multiplyScalar(0.86 + smooth(-3, 3, y) * 0.18);
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
  }
  const index = new Uint32Array((M - 1) * (M - 1) * 6);
  let n = 0;
  for (let j = 0; j < M - 1; j++) {
    for (let i = 0; i < M - 1; i++) {
      const a = j * M + i, b = a + 1, d = a + M, e = d + 1;
      index[n++] = a; index[n++] = d; index[n++] = b;
      index[n++] = b; index[n++] = d; index[n++] = e;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  material.vertexColors = true;
  material.needsUpdate = true;
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);

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

  return { mesh, bodies };
}
