import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { rawHeight, fbm, groundHeight } from "./Terrain.js";
import { GROUP_WORLD } from "../physicsGroups.js";

// Underground cave networks. Each one is a rock massif (a rugged hill rising
// out of the terrain) with tunnels and chambers running through it below the
// surrounding ground, and mouths where the tunnels come out of its flanks.
//
// The terrain is a heightfield (one height per x, z, solid underneath), so it
// can't hold a tunnel. Instead:
//   • the terrain under each network is sunk to the cave floor (modify()
//     below, applied by buildTerrain), so the floor IS the terrain and every
//     groundHeight() user (monsters, pickups, landing) works underground;
//   • one signed distance field per massif, solid = below the hill's skin and
//     outside the tunnel/chamber void, is polygonised (surface nets) into a
//     single rock mesh: outer slopes, cave walls, ceilings and the mouths
//     where tunnels pierce the flank all come out of it seamlessly;
//   • that mesh is also a cannon Trimesh in GROUP_WORLD: the player's capsule
//     spheres, grenades and monsters collide with it, and every raycast
//     (bullets, camera boom, ground check, monster sight, blast shielding)
//     stops at rock.
// Everything derives from fixed layouts and seeded noise, so it's identical
// for every player and on every quality preset (the collider must be).
//
// Light: rock carries a per-vertex "sky" value (1 outside, 0 deep inside)
// that scales the sun, hemisphere and ambient light in its shader, plus
// baked torchlight. A few real point lights (QUALITY.caveLights) follow the
// torches nearest the camera, so torches light characters and the rock
// near you for real and flicker.

// ── Layout ───────────────────────────────────────────────────────────────────
// Node kinds: "m" mouth (where the floor meets the outside ground), "j"
// junction, "c" chamber (radius r). Edges: [a, b, width multiplier].
const NETWORKS = [
  {
    name: "Hollow Ridge",
    x: 120, z: 150, rot: 0.55,
    nodes: [
      [-52, 4, "m"], [-30, 0, "j"], [0, 0, "c", 11], [24, -6, "j"], [50, -14, "m"],
      [6, 24, "j"], [-6, 40, "c", 9], [-24, 62, "m"], [30, -36, "m"], [-30, 24, "j"],
    ],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5, 0.9], [5, 6], [6, 7], [3, 8], [1, 9, 0.8], [9, 6, 0.85]],
  },
  {
    name: "Bone Hollow",
    x: -172, z: -92, rot: -0.35,
    nodes: [
      [-30, -16, "m"], [-12, -4, "j"], [8, 4, "c", 10], [34, -6, "m"],
      [10, 26, "j"], [-4, 50, "m"], [32, 34, "m"],
    ],
    edges: [[0, 1], [1, 2], [2, 3], [2, 4, 0.9], [4, 5], [4, 6, 0.85]],
  },
];

const TUNNEL_R = 3.4;          // m, tunnel radius (before the width multiplier)
const Y_SQUASH = 1.2;          // tunnels are lower than wide
const AXIS_UP = 1.6;           // tunnel axis above the floor → ~4.4 m ceilings, ~5.6 m wide floors
const CH_UP = 2.2;             // chamber centre above the floor
const FLOOR_DEPTH = 2.5;       // cave floor below the lowest ground around it
const DOME = 14;               // hill height over the tunnels (above the natural ground)
const DOME_R1 = 8, DOME_R2 = 26;
const SINK = 2.5;              // the hill's skin dips this far under the ground at its edge
const LOWER_FLAT = 9;          // ground is sunk to the floor this far from a tunnel axis…
const LOWER_FADE = 4;          // …and comes back up over this
const CELL = 0.9;              // surface-net grid (m)
const PAD = DOME_R2 + 4;       // grid margin around the nodes
const VISUAL_FLOOR = 0.04;     // the rock floor sits this far over the terrain (no z-fight)
const CHUNK = 40;              // render chunks (m), for frustum culling

const TORCH_COLOR = new THREE.Color(1.0, 0.56, 0.22);
const TORCH_REACH = 9;         // m, baked light range

// ── Small math ───────────────────────────────────────────────────────────────
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
function hash3(ix, iy, iz) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2147483647) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), ux), l(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), ux), uy),
    l(l(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), ux), l(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), ux), uy),
    uz);
}
/** Floor height at parameter t along segment s (flat for s.flat m, then a straight ramp). */
function segFloor(s, t) {
  return s.fa + (s.fb - s.fa) * Math.max(0, (t * s.len - s.flat) / (s.len - s.flat));
}
/** Distance from (x, z) to segment s, and the parameter t (0 at a, 1 at b). */
function segDist(s, x, z, out) {
  const t = Math.min(1, Math.max(0, ((x - s.ax) * s.ux + (z - s.az) * s.uz) / s.len));
  const px = s.ax + s.ux * s.len * t, pz = s.az + s.uz * s.len * t;
  out.t = t;
  return Math.hypot(x - px, z - pz);
}

// ── Networks in world space ──────────────────────────────────────────────────
function prepare(def) {
  const c = Math.cos(def.rot), s = Math.sin(def.rot);
  const nodes = def.nodes.map(([lx, lz, kind, r], id) => ({
    id, kind, r: r ?? 0,
    x: def.x + lx * c - lz * s,
    z: def.z + lx * s + lz * c,
  }));
  // The floor sits below the lowest natural ground among the nodes; mouths
  // start at the ground outside and ramp down
  let low = Infinity;
  for (const n of nodes) low = Math.min(low, rawHeight(n.x, n.z));
  const floorY = low - FLOOR_DEPTH;
  for (const n of nodes) n.floor = n.kind === "m" ? rawHeight(n.x, n.z) : floorY;

  const segs = def.edges.map(([a, b, w = 1]) => {
    let A = nodes[a], B = nodes[b];
    if (A.kind === "m") [A, B] = [B, A];          // mouth edges run inside → out
    const len = Math.hypot(B.x - A.x, B.z - A.z);
    return {
      a: A.id, b: B.id, mouth: B.kind === "m",
      ax: A.x, az: A.z, bx: B.x, bz: B.z, len,
      ux: (B.x - A.x) / len, uz: (B.z - A.z) / len,
      fa: A.floor, fb: B.floor,
      // A mouth tunnel out of a chamber ramps up from the chamber's edge, not
      // its centre (the chamber floor is flat out to its radius: ramping from
      // the centre left a ledge too high to step up at the rim)
      flat: A.kind === "c" ? Math.min(A.r, len * 0.5) : 0,
      r: TUNNEL_R * w,
      open: len,                                     // distance from a where it leaves the hill (set below)
    };
  });
  const chambers = nodes.filter(n => n.kind === "c");
  const inner = segs.filter(sg => !sg.mouth);

  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const n of nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); z0 = Math.min(z0, n.z); z1 = Math.max(z1, n.z); }
  const net = {
    name: def.name, nodes, segs, inner, chambers, floorY,
    x0: x0 - PAD, x1: x1 + PAD, z0: z0 - PAD, z1: z1 + PAD,
    cx: (x0 + x1) / 2, cz: (z0 + z1) / 2,
    torches: [],
  };
  // Where each mouth tunnel leaves the hill: its ceiling comes out of the skin
  for (const sg of segs) {
    if (!sg.mouth) continue;
    for (let d = 0; d <= sg.len; d += 0.5) {
      const x = sg.ax + sg.ux * d, z = sg.az + sg.uz * d;
      const floor = segFloor(sg, d / sg.len);
      if (skinHeight(net, x, z) < floor + AXIS_UP + sg.r / Y_SQUASH + 0.6) { sg.open = d; break; }
    }
  }
  return net;
}

/** Distance to the hill's spine: interior tunnels and chambers (not the mouth tunnels). */
function domeDist(net, x, z) {
  let d = Infinity;
  for (const s of net.inner) d = Math.min(d, segDist(s, x, z, _t));
  for (const c of net.chambers) d = Math.min(d, Math.max(0, Math.hypot(x - c.x, z - c.z) - c.r * 0.6));
  return d;
}
const _t = { t: 0 };

/** Height of the hill's rock skin at (x, z). */
function skinHeight(net, x, z) {
  const d = domeDist(net, x, z);
  const hill = 1 - smooth(DOME_R1, DOME_R2, d);
  // Rugged: broad lumps, sharp ridges (folded noise) and small knobs
  const rug = (fbm(x / 11, z / 11, 3, 501) - 0.5) * 6
    + (1 - Math.abs(fbm(x / 6, z / 6, 2, 503) * 2 - 1)) * 2.4
    + (fbm(x / 3.5, z / 3.5, 2, 502) - 0.5) * 1.2;
  return rawHeight(x, z) + DOME * hill - SINK + rug * (1 - smooth(DOME_R1, DOME_R2 + 4, d));
}

/**
 * Nearest tunnel / chamber at (x, z): out.d (0 inside a chamber), out.floor,
 * out.seg / out.ch (index or −1) and out.t along the segment.
 */
function corridor(net, x, z, out) {
  out.d = Infinity; out.seg = -1; out.ch = -1; out.floor = net.floorY; out.t = 0;
  for (let i = 0; i < net.segs.length; i++) {
    const s = net.segs[i];
    const d = segDist(s, x, z, _t);
    if (d < out.d) {
      out.d = d; out.seg = i; out.t = _t.t; out.ch = -1;
      out.floor = segFloor(s, _t.t);
    }
  }
  for (let i = 0; i < net.chambers.length; i++) {
    const c = net.chambers[i];
    const d = Math.max(0, Math.hypot(x - c.x, z - c.z) - c.r);
    if (d <= out.d) { out.d = d; out.ch = i; out.seg = -1; out.floor = net.floorY; }
  }
  return out;
}
const _cor = { d: 0, floor: 0, seg: -1, ch: -1, t: 0 };

/** Signed distance to the open space of the caves: negative inside a tunnel or chamber. */
function voidDist(net, x, y, z) {
  let v = 1e9, nearest = Infinity, floor = net.floorY;
  for (const s of net.segs) {
    const dxz = segDist(s, x, z, _t);
    if (dxz > s.r + 4) { if (dxz < nearest) { nearest = dxz; floor = segFloor(s, _t.t); } continue; }
    const f = segFloor(s, _t.t);
    if (dxz < nearest) { nearest = dxz; floor = f; }
    const dy = (y - f - AXIS_UP) * Y_SQUASH;
    // Wider and narrower stretches along the tunnel
    const r = s.r * (0.86 + 0.32 * noise3(x * 0.06, 7.3, z * 0.06));
    v = smin(v, Math.sqrt(dxz * dxz + dy * dy) - r, 1.6);
  }
  for (const c of net.chambers) {
    const ry = c.r * 0.55;
    const ex = (x - c.x) / c.r, ey = (y - net.floorY - CH_UP) / ry, ez = (z - c.z) / c.r;
    const dc = (Math.sqrt(ex * ex + ey * ey + ez * ez) - 1) * Math.min(c.r, ry);
    v = smin(v, dc, 3);
    if (Math.hypot(x - c.x, z - c.z) < c.r) floor = net.floorY;
  }
  // Rough rock walls, only where it matters
  if (v < 3) v += (noise3(x * 0.2, y * 0.26, z * 0.2) - 0.5) * 1.5 + (noise3(x * 0.55, y * 0.55, z * 0.55) - 0.5) * 0.6 + (noise3(x * 1.3, y * 1.3, z * 1.3) - 0.5) * 0.22;
  // Flat floor: nothing below it is open
  return Math.max(v, floor + VISUAL_FLOOR - y);
}

const NETS = NETWORKS.map(prepare);

function netAt(x, z, margin = 0) {
  for (const n of NETS) {
    if (x > n.x0 - margin && x < n.x1 + margin && z > n.z0 - margin && z < n.z1 + margin) return n;
  }
  return null;
}

// ── Hooks used while the world is built (pure, before any mesh exists) ─────

/** buildTerrain's modify(): sinks the ground to the cave floor under every tunnel and chamber. */
export function caveTerrain(x, z, h) {
  const net = netAt(x, z);
  if (!net) return h;
  const c = corridor(net, x, z, _cor);
  if (c.d > LOWER_FLAT + LOWER_FADE) return h;
  return Math.min(h, c.floor + (h - c.floor) * smooth(LOWER_FLAT, LOWER_FLAT + LOWER_FADE, c.d));
}

/** 0 where rock or a sunken cave floor is: no grass there. */
export function caveGrass(x, z) {
  const net = netAt(x, z);
  if (!net) return 1;
  if (corridor(net, x, z, _cor).d < LOWER_FLAT + LOWER_FADE + 1) return 0;
  return domeDist(net, x, z) < DOME_R2 - 1 ? 0 : 1;
}

/** True on or near a massif (keeps houses, trees, stones and spawns off it). */
export function caveBlocks(x, z, pad = 0) {
  const net = netAt(x, z, pad);
  if (!net) return false;
  return domeDist(net, x, z) < DOME_R2 - 2 + pad || corridor(net, x, z, _cor).d < LOWER_FLAT + LOWER_FADE + pad;
}

// ── Rock shader: sky light fades out underground, baked torchlight ──────────
function rockMaterial() {
  // Faceted (flat-shaded) like the rest of the low-poly world
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, flatShading: true });
  mat.userData.torchGlow = { value: 1 };
  mat.onBeforeCompile = shader => {
    shader.uniforms.uTorchGlow = mat.userData.torchGlow;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aSky;\nattribute vec3 aTorch;\nvarying float vSky;\nvarying vec3 vTorch;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSky = aSky;\nvTorch = aTorch;");
    const lights = THREE.ShaderChunk.lights_fragment_begin.replace(
      "getDirectionalLightInfo( directionalLight, directLight );",
      "getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= vSky;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vSky;\nvarying vec3 vTorch;\nuniform float uTorchGlow;")
      .replace("#include <lights_fragment_begin>", lights)
      // Sky and ambient light don't reach far underground (a little stays, so it's never pitch black)
      .replace("#include <lights_fragment_maps>", "#if defined( RE_IndirectDiffuse )\n\tirradiance *= 0.06 + 0.94 * vSky;\n#endif\n#include <lights_fragment_maps>")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * vTorch * uTorchGlow;");
  };
  mat.customProgramCacheKey = () => "cave-rock";
  return mat;
}

// ── Torch flames: one draw call of camera-facing quads, all on the GPU ──────
const FLAME_VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute vec3 aCenter;
  attribute float aSeed;
  uniform float uTime;
  varying vec2 vUv;
  varying float vSeed;
  void main() {
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 p = aCenter + right * position.x * 0.7 + vec3(0.0, 1.0, 0.0) * (position.y * 0.9 + 0.22);
    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    vUv = position.xy;   // x −0.5..0.5, y −0.5..0.5
    vSeed = aSeed;
    #include <fog_vertex>
  }
`;
const FLAME_FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform float uTime;
  varying vec2 vUv;
  varying float vSeed;
  void main() {
    float t = uTime * (1.0 + fract(vSeed * 7.1) * 0.3) + vSeed * 40.0;
    vec2 uv = vUv;
    float y = uv.y + 0.32;                                 // flame base near the bottom of the quad
    // Sway and lick: the tip wanders more than the base
    float lick = sin(t * 7.0 + y * 9.0) * 0.06 + sin(t * 13.0 + y * 17.0) * 0.03;
    float x = uv.x - lick * smoothstep(0.0, 0.6, y);
    float width = 0.24 * pow(max(0.0, 1.0 - y / (0.64 + 0.08 * sin(t * 5.0))), 0.6) * smoothstep(-0.08, 0.05, y);
    float body = smoothstep(width, width * 0.15, abs(x)) * step(-0.06, y);
    float core = smoothstep(width * 0.55, 0.0, abs(x)) * smoothstep(0.42, 0.0, y);
    vec3 col = mix(vec3(0.9, 0.18, 0.02), vec3(1.0, 0.55, 0.12), body);
    col = mix(col, vec3(1.0, 0.92, 0.6), core);
    // Soft halo so the flame glows even without bloom
    float halo = exp(-dot(vec2(uv.x, uv.y + 0.12), vec2(uv.x, uv.y + 0.12)) * 14.0) * 0.32;
    vec3 c = col * body * 2.4 + vec3(1.0, 0.5, 0.15) * halo;
    float a = max(body, halo);
    if (a < 0.01) discard;
    gl_FragColor = vec4(c, a);
    #include <fog_fragment>
  }
`;
const EMBER_VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute vec3 aCenter;
  attribute float aSeed;
  uniform float uTime;
  uniform float uScale;
  varying float vLife;
  void main() {
    float life = fract(uTime * (0.45 + fract(aSeed * 3.7) * 0.4) + aSeed);
    vLife = life;
    vec3 p = aCenter + vec3(
      sin(aSeed * 31.0 + life * 5.0) * 0.18 * life,
      0.25 + life * 1.3,
      cos(aSeed * 17.0 + life * 4.0) * 0.18 * life);
    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = (1.0 - life) * 0.06 * uScale / max(0.5, -mvPosition.z);
    #include <fog_vertex>
  }
`;
const EMBER_FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  varying float vLife;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.1, length(d)) * (1.0 - vLife);
    if (a < 0.02) discard;
    gl_FragColor = vec4(vec3(1.0, 0.55, 0.15) * 2.0, a);
    #include <fog_fragment>
  }
`;

function flicker(t, seed) {
  return 0.8 + 0.1 * Math.sin(t * 7.3 + seed) + 0.06 * Math.sin(t * 13.1 + seed * 1.7) + 0.04 * Math.sin(t * 23.7 + seed * 2.3);
}

// ── Building ─────────────────────────────────────────────────────────────────
// Phase 1 (meshNet) needs no terrain, so it runs while the models are still
// downloading (precomputeCaves() at the start of loadWorld). Phase 2 (the
// Caves constructor, after the terrain) culls what's under the ground,
// chunks it and makes the colliders.

const CORNER = [];
for (let c = 0; c < 8; c++) CORNER.push([c & 1, (c >> 1) & 1, (c >> 2) & 1]);
const EDGE_A = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3];
const EDGE_B = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];

const ROCK_A = new THREE.Color().setRGB(0.46, 0.43, 0.4, THREE.SRGBColorSpace);
const ROCK_B = new THREE.Color().setRGB(0.27, 0.25, 0.24, THREE.SRGBColorSpace);
const ROCK_WET = new THREE.Color().setRGB(0.2, 0.17, 0.15, THREE.SRGBColorSpace);
const MOSS = new THREE.Color().setRGB(0.3, 0.33, 0.2, THREE.SRGBColorSpace);
const LICHEN = new THREE.Color().setRGB(0.5, 0.47, 0.34, THREE.SRGBColorSpace);

function meshNet(net) {
  // 1. Sample the rock field on a grid. Everything that only depends on x, z is per column.
  const nx = Math.ceil((net.x1 - net.x0) / CELL) + 1;
  const nz = Math.ceil((net.z1 - net.z0) / CELL) + 1;
  const skin = new Float32Array(nx * nz), crag = new Float32Array(nx * nz), colFloor = new Float32Array(nx * nz);
  const colNear = new Uint8Array(nx * nz);
  let ylo = net.floorY, yhi = -Infinity;
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const x = net.x0 + i * CELL, z = net.z0 + k * CELL, c = i + nx * k;
      const h = skinHeight(net, x, z);
      skin[c] = h;
      const cor = corridor(net, x, z, _cor);
      // No crags round the mouths: where a tunnel cuts a bulge it leaves thin flaps of rock
      const nearMouth = cor.seg >= 0 && net.segs[cor.seg].mouth ? smooth(3.5, 10, cor.d) : 1;
      crag[c] = (1 - smooth(DOME_R1, DOME_R2 + 4, domeDist(net, x, z))) * nearMouth;
      colNear[c] = cor.d < 16 ? 1 : 0;
      colFloor[c] = cor.floor;
      ylo = Math.min(ylo, h - 1.5);
      yhi = Math.max(yhi, h + 1.5);
    }
  }
  const y0 = ylo - 1.5;
  const ny = Math.ceil((yhi + 1.5 - y0) / CELL) + 1;
  const F = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const z = net.z0 + k * CELL;
    for (let i = 0; i < nx; i++) {
      const x = net.x0 + i * CELL, c = i + nx * k;
      const sk = skin[c], cg = crag[c] * 3.4, near = colNear[c], fl = colFloor[c];
      // Chambers keep a solid roof: no crag or lump may open them to the sky
      let roof = -Infinity;
      for (const ch of net.chambers) if (Math.hypot(x - ch.x, z - ch.z) < ch.r + 3) roof = net.floorY + CH_UP + ch.r * 0.55 + 3.5;
      for (let j = 0; j < ny; j++) {
        const y = y0 + j * CELL;
        let f = y - sk;
        // Crags: the hill's skin bulges and overhangs a little (3D noise near the surface)
        if (cg > 0.05 && f > -3 && f < 3) f += (noise3(x * 0.15, y * 0.15, z * 0.15) - 0.5) * cg;
        if (y < roof) f = Math.min(f, y - roof);
        // The tunnels and chambers: only near them, between the floor and the tallest ceilings
        // (a smooth max: the mouths get a worn, rounded rim instead of thin slivers of rock)
        if (near && f < 2.5 && y > fl - 1.5 && y < fl + 11) f = -smin(-f, voidDist(net, x, y, z), 1.6);
        F[i + nx * (j + ny * k)] = f;           // rock is solid (f < 0), air positive
      }
    }
  }
  const grid = { F, nx, ny, nz, x0: net.x0, y0, z0: net.z0 };

  // 2. Surface nets: one vertex per cell the surface crosses, one quad per crossing grid edge
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const sxy = nx, sxyz = nx * ny;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const off = new Int32Array(8);
  for (let c = 0; c < 8; c++) off[c] = CORNER[c][0] + sxy * CORNER[c][1] + sxyz * CORNER[c][2];
  const cv = new Float32Array(8);
  let pos = new Float32Array(1 << 16), nv = 0;
  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      let base = sxy * j + sxyz * k;
      for (let i = 0; i < cx; i++, base++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) { const v = F[base + off[c]]; cv[c] = v; if (v < 0) mask |= 1 << c; }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGE_A[e], b = EDGE_B[e], va = cv[a], vb = cv[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb), ca = CORNER[a], cb = CORNER[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          n++;
        }
        if (nv * 3 + 3 > pos.length) { const g = new Float32Array(pos.length * 2); g.set(pos); pos = g; }
        cellVert[i + cx * (j + cy * k)] = nv;
        pos[nv * 3] = net.x0 + (i + sx / n) * CELL;
        pos[nv * 3 + 1] = y0 + (j + sy / n) * CELL;
        pos[nv * 3 + 2] = net.z0 + (k + sz / n) * CELL;
        nv++;
      }
    }
  }
  const P = pos.slice(0, nv * 3);
  // Normals: the field's gradient points out of the rock, into the air
  const N = new Float32Array(nv * 3);
  const h = CELL * 0.5;
  for (let v = 0; v < nv; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    const gx = sampleGrid(grid, x + h, y, z) - sampleGrid(grid, x - h, y, z);
    const gy = sampleGrid(grid, x, y + h, z) - sampleGrid(grid, x, y - h, z);
    const gz = sampleGrid(grid, x, y, z + h) - sampleGrid(grid, x, y, z - h);
    const l = Math.hypot(gx, gy, gz) || 1;
    N[v * 3] = gx / l; N[v * 3 + 1] = gy / l; N[v * 3 + 2] = gz / l;
  }
  // Quads round every grid edge the surface crosses, wound to face the air
  const tris = [];
  const cvx = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= cx || j >= cy || k >= cz) ? -1 : cellVert[i + cx * (j + cy * k)];
  const tri = (p, q, r) => {
    const e1x = P[q * 3] - P[p * 3], e1y = P[q * 3 + 1] - P[p * 3 + 1], e1z = P[q * 3 + 2] - P[p * 3 + 2];
    const e2x = P[r * 3] - P[p * 3], e2y = P[r * 3 + 1] - P[p * 3 + 1], e2z = P[r * 3 + 2] - P[p * 3 + 2];
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const dot = fx * (N[p * 3] + N[q * 3] + N[r * 3]) + fy * (N[p * 3 + 1] + N[q * 3 + 1] + N[r * 3 + 1]) + fz * (N[p * 3 + 2] + N[q * 3 + 2] + N[r * 3 + 2]);
    if (dot >= 0) tris.push(p, q, r); else tris.push(p, r, q);
  };
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    tri(a, b, c);
    tri(a, c, d);
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = i + sxy * j + sxyz * k;
        const s0 = F[idx] < 0;
        if (i + 1 < nx && s0 !== (F[idx + 1] < 0)) quad(cvx(i, j - 1, k - 1), cvx(i, j, k - 1), cvx(i, j, k), cvx(i, j - 1, k));
        if (j + 1 < ny && s0 !== (F[idx + sxy] < 0)) quad(cvx(i - 1, j, k - 1), cvx(i, j, k - 1), cvx(i, j, k), cvx(i - 1, j, k));
        if (k + 1 < nz && s0 !== (F[idx + sxyz] < 0)) quad(cvx(i - 1, j - 1, k), cvx(i, j - 1, k), cvx(i, j, k), cvx(i - 1, j, k));
      }
    }
  }

  // 3. Per-vertex look: rock colour, crevices darkened from the field, sky exposure
  const col = new Float32Array(nv * 3), sky = new Float32Array(nv);
  const c0 = new THREE.Color();
  for (let v = 0; v < nv; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    const nyv = N[v * 3 + 1];
    const gi = Math.min(nx - 1, Math.max(0, Math.round((x - net.x0) / CELL)));
    const gk = Math.min(nz - 1, Math.max(0, Math.round((z - net.z0) / CELL)));
    const cave = y < skin[gi + nx * gk] - 2.2;
    const n1 = noise3(x * 0.11, y * 0.35, z * 0.11), n2 = noise3(x * 0.7, y * 0.7, z * 0.7);
    const band = 0.5 + 0.5 * Math.sin(y * 2.1 + n1 * 4);
    c0.copy(ROCK_A).lerp(ROCK_B, n1 * 0.8 + band * 0.3);
    if (cave) c0.lerp(ROCK_WET, 0.5 + n2 * 0.3);
    else if (nyv > 0.55) c0.lerp(n1 > 0.55 ? LICHEN : MOSS, smooth(0.55, 0.9, nyv) * (0.45 + n2 * 0.35));
    // Ambient occlusion: how far the field opens up just off the surface
    const ao = Math.min(1, Math.max(0, sampleGrid(grid, x + N[v * 3] * 1.5, y + N[v * 3 + 1] * 1.5, z + N[v * 3 + 2] * 1.5) / 1.5));
    c0.multiplyScalar((0.35 + 0.65 * ao) * (0.8 + n2 * 0.4));
    col[v * 3] = c0.r; col[v * 3 + 1] = c0.g; col[v * 3 + 2] = c0.b;
    sky[v] = cave ? skyAt(net, x, z) : 1;
  }

  // 4. Torches (on the walls, found through the field), then their light baked into the rock
  placeTorches(net, grid);
  const torch = new Float32Array(nv * 3);
  for (const tr of net.torches) {
    const fx = tr.flame.x, fy = tr.flame.y, fz = tr.flame.z;
    for (let v = 0; v < nv; v++) {
      const dx = fx - P[v * 3], dy = fy - P[v * 3 + 1], dz = fz - P[v * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > TORCH_REACH * TORCH_REACH) continue;
      const d = Math.sqrt(d2);
      const ndl = (dx * N[v * 3] + dy * N[v * 3 + 1] + dz * N[v * 3 + 2]) / d;
      if (ndl <= -0.1) continue;
      // Blocked by rock on the way? (march the field toward the flame)
      let lit = 1;
      for (let st = 0.9; st < d - 0.4; st += 0.6) {
        const f = st / d;
        if (sampleGrid(grid, P[v * 3] + dx * f, P[v * 3 + 1] + dy * f, P[v * 3 + 2] + dz * f) < -0.2) { lit = 0.05; break; }
      }
      const kk = (0.15 + 0.85 * Math.max(0, ndl)) * lit * 1.15 / (1 + d2 * 0.3) * smooth(TORCH_REACH, TORCH_REACH * 0.35, d);
      torch[v * 3] += TORCH_COLOR.r * kk;
      torch[v * 3 + 1] += TORCH_COLOR.g * kk;
      torch[v * 3 + 2] += TORCH_COLOR.b * kk;
    }
  }
  net.mesh = { P, col, sky, torch, tris, nv };
}

/** 1 at a mouth's opening, fading to 0 about 12 m into the tunnel; 0 deeper in. */
function skyAt(net, x, z) {
  const c = corridor(net, x, z, _cor);
  if (c.seg < 0) return 0;
  const s = net.segs[c.seg];
  if (!s.mouth) return 0;
  const inside = s.open - c.t * s.len;             // metres inside the opening
  return 1 - smooth(-1, 12, inside);
}

/** Torches on the walls: inside each mouth, at junctions, round chambers, in some long tunnels. */
function placeTorches(net, grid) {
  net.torches = [];
  const anchors = [];
  let rng = (0x70c4 ^ Math.imul(net.nodes.length, 7919)) >>> 0;
  const rand = () => { rng = (Math.imul(1664525, rng) + 1013904223) >>> 0; return rng / 4294967296; };
  net.segs.forEach((s, i) => {
    const px = -s.uz, pz = s.ux;                     // left of the tunnel
    if (s.mouth) {
      const d = Math.max(2, s.open - 4.5);
      const sd = i % 2 ? 1 : -1;
      anchors.push({ x: s.ax + s.ux * d, z: s.az + s.uz * d, dirs: [[px * sd, pz * sd], [-px * sd, -pz * sd]], floor: segFloor(s, d / s.len) });
    } else if (s.len > 22 && rand() < 0.6) {
      // Some long tunnels get one halfway; the rest stay dark
      const d = s.len * (0.4 + rand() * 0.2);
      const sd = rand() < 0.5 ? 1 : -1;
      anchors.push({ x: s.ax + s.ux * d, z: s.az + s.uz * d, dirs: [[px * sd, pz * sd], [-px * sd, -pz * sd]], floor: net.floorY });
    }
  });
  for (const n of net.nodes) {
    if (n.kind === "j") {
      const dirs = [];
      for (let a = 0; a < 8; a++) dirs.push([Math.cos(a * Math.PI / 4 + 0.3), Math.sin(a * Math.PI / 4 + 0.3)]);
      anchors.push({ x: n.x, z: n.z, dirs, floor: net.floorY, nearest: true });
    } else if (n.kind === "c") {
      for (let a = 0; a < 3; a++) {
        const dirs = [];
        for (let b = 0; b < 5; b++) { const ang = a * 2.09 + b * 0.35 + n.id; dirs.push([Math.cos(ang), Math.sin(ang)]); }
        anchors.push({ x: n.x, z: n.z, dirs, floor: net.floorY, maxReach: n.r * 1.3 });
      }
    }
  }
  const p = new THREE.Vector3();
  for (const an of anchors) {
    // March out to the wall at about shoulder height; at junctions take the nearest wall
    let best = null;
    for (const [dx, dz] of an.dirs) {
      const y = an.floor + 2.1;
      let hit = null;
      for (let st = 0.5; st < (an.maxReach ?? 9); st += 0.2) {
        if (sampleGrid(grid, an.x + dx * st, y, an.z + dz * st) < 0) { hit = st - 0.2; break; }
      }
      if (hit === null) continue;
      if (!best || (an.nearest && hit < best.s)) best = { s: hit, dx, dz, y };
      if (!an.nearest) break;
    }
    if (!best) continue;
    p.set(an.x + best.dx * best.s, best.y, an.z + best.dz * best.s);
    // Wall normal from the field (into the air), kept level
    const hh = 0.3;
    const n = new THREE.Vector3(
      sampleGrid(grid, p.x + hh, p.y, p.z) - sampleGrid(grid, p.x - hh, p.y, p.z),
      0,
      sampleGrid(grid, p.x, p.y, p.z + hh) - sampleGrid(grid, p.x, p.y, p.z - hh));
    if (n.lengthSq() < 1e-6) n.set(-best.dx, 0, -best.dz);
    n.normalize();
    const mount = p.clone().addScaledVector(n, 0.05);
    const dir = n.clone().multiplyScalar(0.75).add(new THREE.Vector3(0, 0.66, 0)).normalize();
    const flame = mount.clone().addScaledVector(dir, 0.46);
    net.torches.push({ mount, dir, flame, seed: net.torches.length * 1.37 + net.floorY, net });
  }
}

/**
 * cannon's Trimesh also builds an edge list (through a string-keyed map of
 * every edge: slow for tens of thousands of triangles). Neither sphere
 * contacts nor raycasts use it, so it's skipped.
 */
class RockTrimesh extends CANNON.Trimesh {
  updateEdges() { this.edges = new Int16Array(0); }
}

/** Splits a triangle list into CHUNK-sized tiles by their first vertex. */
function chunkTriangles(list, P, net) {
  const chunks = new Map();
  for (let t = 0; t < list.length; t += 3) {
    const a = list[t];
    const key = Math.floor((P[a * 3] - net.x0) / CHUNK) * 1000 + Math.floor((P[a * 3 + 2] - net.z0) / CHUNK);
    let c = chunks.get(key);
    if (!c) chunks.set(key, c = []);
    c.push(list[t], list[t + 1], list[t + 2]);
  }
  return chunks.values();
}

let _precomputed = false;
/**
 * The heavy part of building the caves (field, mesh, colours, torches, baked
 * light). Needs no terrain, so it can run while assets download. Idempotent.
 */
export function precomputeCaves() {
  if (_precomputed) return;
  _precomputed = true;
  for (const net of NETS) meshNet(net);
}

// ── The caves ────────────────────────────────────────────────────────────────
export class Caves {
  /**
   * Build after the terrain (it reads the final groundHeight()).
   * lights: how many real point lights follow the nearest torches.
   */
  constructor({ scene, world, physicsMaterial, lights = 2 }) {
    this.scene = scene;
    this.nets = NETS;
    this.material = rockMaterial();
    this.time = 0;
    this.torches = [];
    this.meshes = [];
    this.bodies = [];
    this.lootSpots = [];

    precomputeCaves();
    for (const net of NETS) {
      this._assemble(net, world, physicsMaterial);
      this.torches.push(...net.torches);
    }
    this._buildTorchMeshes();

    // Real lights for the torches nearest the camera (always in the scene: no shader recompiles)
    this.lights = [];
    for (let i = 0; i < lights; i++) {
      const l = new THREE.PointLight(0xff9a48, 0, 12, 1.5);
      l.userData.torch = null;
      l.userData.fade = 0;
      scene.add(l);
      this.lights.push(l);
    }
    for (const net of NETS) this._buildNav(net);
  }

  /** Phase 2: drop what's under the ground, render chunks, colliders, loot spots. */
  _assemble(net, world, physicsMaterial) {
    const { P, col, sky, torch, tris, nv } = net.mesh;
    // Keep what can be seen; the floor stays out of the collider (the terrain is the floor)
    const ground = new Float32Array(nv);
    for (let v = 0; v < nv; v++) ground[v] = groundHeight(P[v * 3], P[v * 3 + 2]);
    const render = [], collide = [];
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const ya = P[a * 3 + 1], yb = P[b * 3 + 1], yc = P[c * 3 + 1];
      if (ya < ground[a] - 0.25 && yb < ground[b] - 0.25 && yc < ground[c] - 0.25) continue;
      render.push(a, b, c);
      const e1x = P[b * 3] - P[a * 3], e1z = P[b * 3 + 2] - P[a * 3 + 2], e1y = yb - ya;
      const e2x = P[c * 3] - P[a * 3], e2z = P[c * 3 + 2] - P[a * 3 + 2], e2y = yc - ya;
      const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
      const up = fy / (Math.hypot(fx, fy, fz) || 1);
      const floorTri = up > 0.7 && ya < ground[a] + 0.35 && yb < ground[b] + 0.35 && yc < ground[c] + 0.35;
      if (!floorTri) collide.push(a, b, c);
    }

    // Render chunks (frustum culling), each with its own vertex list
    for (const list of chunkTriangles(render, P, net)) {
      const remap = new Map();
      const idx = new Uint32Array(list.length);
      const vp = [], vc = [], vs = [], vt = [];
      for (let q = 0; q < list.length; q++) {
        const v = list[q];
        let r = remap.get(v);
        if (r === undefined) {
          r = remap.size;
          remap.set(v, r);
          vp.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
          vc.push(col[v * 3], col[v * 3 + 1], col[v * 3 + 2]);
          vs.push(sky[v]);
          vt.push(torch[v * 3], torch[v * 3 + 1], torch[v * 3 + 2]);
        }
        idx[q] = r;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(vp, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(vc, 3));
      geo.setAttribute("aSky", new THREE.Float32BufferAttribute(vs, 1));
      geo.setAttribute("aTorch", new THREE.Float32BufferAttribute(vt, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scene.add(mesh);
      this.meshes.push(mesh);
    }

    // Colliders: static trimeshes chunked the same way (cannon keeps trimesh
    // indices in an Int16Array, so each needs its own small vertex list).
    // Each body sits at its chunk's centre with the vertices relative to it:
    // the broadphase tests a bounding sphere round the body's position, and a
    // body at the world origin would "touch" everything within ~200 m of it.
    for (const list of chunkTriangles(collide, P, net)) {
      const remap = new Map(), verts = [], idx = [];
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (const v of list) {
        let r = remap.get(v);
        if (r === undefined) {
          r = remap.size;
          remap.set(v, r);
          const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
          verts.push(x, y, z);
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z);
          x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
        }
        idx.push(r);
      }
      if (remap.size > 32767) console.warn("Caves: collider chunk too big", remap.size);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
      for (let i = 0; i < verts.length; i += 3) { verts[i] -= cx; verts[i + 1] -= cy; verts[i + 2] -= cz; }
      const body = new CANNON.Body({ mass: 0, material: physicsMaterial, collisionFilterGroup: GROUP_WORLD });
      body.position.set(cx, cy, cz);
      body.addShape(new RockTrimesh(verts, idx));
      body.allowSleep = true;
      world.addBody(body);
      this.bodies.push(body);
    }
    net.triangles = render.length / 3;
    net.colliderTriangles = collide.length / 3;
    net.mesh = null;

    // Loot: a few spots in every chamber and at the junctions
    for (const n of net.nodes) {
      if (n.kind === "c") {
        for (let a = 0; a < 3; a++) {
          const ang = a * 2.1 + n.id;
          const x = n.x + Math.cos(ang) * n.r * 0.45, z = n.z + Math.sin(ang) * n.r * 0.45;
          this.lootSpots.push({ x, y: groundHeight(x, z), z });
        }
      } else if (n.kind === "j") {
        this.lootSpots.push({ x: n.x, y: groundHeight(n.x, n.z), z: n.z });
      }
    }
  }

  _skyAt(net, x, z) { return skyAt(net, x, z); }

  _buildTorchMeshes() {
    const parts = [];
    const wood = new THREE.Color().setRGB(0.24, 0.15, 0.09, THREE.SRGBColorSpace);
    const iron = new THREE.Color().setRGB(0.12, 0.12, 0.13, THREE.SRGBColorSpace);
    const char = new THREE.Color().setRGB(0.05, 0.03, 0.02, THREE.SRGBColorSpace);
    const paint = (geo, c) => {
      const n = geo.getAttribute("position").count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
      geo.setAttribute("color", new THREE.BufferAttribute(a, 3));
      return geo;
    };
    const q = new THREE.Quaternion(), m = new THREE.Matrix4(), up = new THREE.Vector3(0, 1, 0);
    for (const t of this.torches) {
      q.setFromUnitVectors(up, t.dir);
      // Handle along dir, a charred head, an iron bracket ring and a wall plate
      const handle = paint(new THREE.CylinderGeometry(0.035, 0.028, 0.52, 6).translate(0, 0.2, 0), wood);
      const head = paint(new THREE.CylinderGeometry(0.06, 0.045, 0.12, 6).translate(0, 0.44, 0), char);
      const ring = paint(new THREE.TorusGeometry(0.05, 0.012, 4, 8).rotateX(Math.PI / 2).translate(0, 0.12, 0), iron);
      for (const g of [handle, head, ring]) {
        m.compose(t.mount, q, _one);
        parts.push(g.applyMatrix4(m));
      }
      const plate = paint(new THREE.BoxGeometry(0.16, 0.24, 0.04), iron);
      const qp = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(t.dir.x, 0, t.dir.z).normalize());
      m.compose(t.mount.clone().add(new THREE.Vector3(0, 0.08, 0)), qp, _one);
      parts.push(plate.applyMatrix4(m));
    }
    if (!parts.length) return;
    const geo = mergeGeometries(parts.map(g => { g.deleteAttribute("uv"); return g.index ? g.toNonIndexed() : g; }));
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.2 }));
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    this.torchMesh = mesh;

    // Flames: a quad per torch
    const n = this.torches.length;
    const qpos = new Float32Array(n * 4 * 3), center = new Float32Array(n * 4 * 3), seed = new Float32Array(n * 4);
    const index = [];
    const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    this.torches.forEach((t, i) => {
      for (let c = 0; c < 4; c++) {
        const k = i * 4 + c;
        qpos[k * 3] = corners[c][0]; qpos[k * 3 + 1] = corners[c][1];
        center[k * 3] = t.flame.x; center[k * 3 + 1] = t.flame.y - 0.12; center[k * 3 + 2] = t.flame.z;
        seed[k] = t.seed;
      }
      index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    });
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute("position", new THREE.BufferAttribute(qpos, 3));
    fgeo.setAttribute("aCenter", new THREE.BufferAttribute(center, 3));
    fgeo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    fgeo.setIndex(index);
    this.flameUniforms = { uTime: { value: 0 }, uScale: { value: 600 } };
    const flameMat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsLib.fog, ...this.flameUniforms },
      vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    });
    const flames = new THREE.Mesh(fgeo, flameMat);
    flames.frustumCulled = false;
    flames.renderOrder = 4;
    this.scene.add(flames);

    // Embers: six per torch
    const E = 6, epos = new Float32Array(n * E * 3), ecenter = new Float32Array(n * E * 3), eseed = new Float32Array(n * E);
    this.torches.forEach((t, i) => {
      for (let e = 0; e < E; e++) {
        const k = i * E + e;
        ecenter[k * 3] = t.flame.x; ecenter[k * 3 + 1] = t.flame.y - 0.2; ecenter[k * 3 + 2] = t.flame.z;
        eseed[k] = (t.seed * 13.7 + e * 0.161) % 1;
      }
    });
    const egeo = new THREE.BufferGeometry();
    egeo.setAttribute("position", new THREE.BufferAttribute(epos, 3));
    egeo.setAttribute("aCenter", new THREE.BufferAttribute(ecenter, 3));
    egeo.setAttribute("aSeed", new THREE.BufferAttribute(eseed, 1));
    const emberMat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsLib.fog, ...this.flameUniforms },
      vertexShader: EMBER_VERT, fragmentShader: EMBER_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    });
    const embers = new THREE.Points(egeo, emberMat);
    embers.frustumCulled = false;
    embers.renderOrder = 4;
    this.scene.add(embers);
  }

  // ── Monster navigation ─────────────────────────────────────────────────────
  // A graph of tunnel nodes, mouths and an approach point outside each mouth,
  // with all-pairs shortest paths. Monsters only use it when they or their
  // target are in a tunnel; outside, they treat each massif as a box to go
  // round (navObstacle).

  _buildNav(net) {
    const nodes = net.nodes.map(n => ({ x: n.x, z: n.z }));
    const links = net.segs.map(s => [s.a, s.b]);
    net.approach = [];
    for (const s of net.segs) {
      if (!s.mouth) continue;
      const id = nodes.length;
      nodes.push({ x: s.bx + s.ux * 4, z: s.bz + s.uz * 4 });
      links.push([s.b, id]);
      net.approach.push(id);
    }
    const n = nodes.length;
    const D = Array.from({ length: n }, () => new Float32Array(n).fill(Infinity));
    const next = Array.from({ length: n }, () => new Int16Array(n).fill(-1));
    for (let i = 0; i < n; i++) { D[i][i] = 0; next[i][i] = i; }
    for (const [a, b] of links) {
      const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
      D[a][b] = D[b][a] = d;
      next[a][b] = b; next[b][a] = a;
    }
    for (let k = 0; k < n; k++)
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          if (D[i][k] + D[k][j] < D[i][j]) { D[i][j] = D[i][k] + D[k][j]; next[i][j] = next[i][k]; }
    net.nav = { nodes, D, next };
    // A ring of waypoints round the hill (its spine's convex hull pushed out
    // past the foot of the slope), for monsters walking past outside
    const pts = net.nodes.filter(nd => nd.kind !== "m").map(nd => [nd.x, nd.z]);
    const hull = convexHull(pts);
    let hx = 0, hz = 0;
    for (const [x, z] of hull) { hx += x; hz += z; }
    hx /= hull.length; hz /= hull.length;
    net.ring = [];
    for (let i = 0; i < hull.length; i++) {
      const [ax, az] = hull[i], [bx, bz] = hull[(i + 1) % hull.length];
      const len = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(len / 14));
      for (let k = 0; k < steps; k++) {
        const x = ax + (bx - ax) * (k / steps), z = az + (bz - az) * (k / steps);
        const dx = x - hx, dz = z - hz, dl = Math.hypot(dx, dz) || 1;
        net.ring.push({ x: x + dx / dl * (DOME_R2 + 2), z: z + dz / dl * (DOME_R2 + 2) });
      }
    }
  }

  /** True if walking straight from a to b at ground level would run into a hill's rock. */
  _blocked(net, ax, az, bx, bz) {
    const len = Math.hypot(bx - ax, bz - az), n = Math.ceil(len / 2);
    for (let i = 1; i < n; i++) {
      const x = ax + (bx - ax) * (i / n), z = az + (bz - az) * (i / n);
      if (x < net.x0 || x > net.x1 || z < net.z0 || z > net.z1) continue;
      if (domeDist(net, x, z) < DOME_R2 - 7 && corridor(net, x, z, _cor).d > 3.5) return true;
    }
    return false;
  }

  /** Next ring waypoint round a hill on the way from z to the goal (into out). */
  _detour(net, zx, zz, gx, gz, out) {
    let best = Infinity, w = null;
    for (const r of net.ring) {
      const dz = Math.hypot(r.x - zx, r.z - zz);
      if (dz < 3 || this._blocked(net, zx, zz, r.x, r.z)) continue;
      const cost = dz + Math.hypot(gx - r.x, gz - r.z) + (this._blocked(net, r.x, r.z, gx, gz) ? 60 : 0);
      if (cost < best) { best = cost; w = r; }
    }
    if (!w) { out.x = gx; out.z = gz; return; }
    out.x = w.x; out.z = w.z;
  }

  /** Which tunnel / chamber (x, feet y, z) is in: { net, seg, ch } or null (outside or on top). */
  _region(x, z, y, out, margin = 0, snap = false) {
    for (const net of NETS) {
      if (x < net.x0 || x > net.x1 || z < net.z0 || z > net.z1) continue;
      const c = corridor(net, x, z, _cor);
      const far = c.ch >= 0 ? c.d > 0.5 + margin : c.d > 3.2 + margin;
      // snap: a point in the rock beside a tunnel (a monster's retreat spot, a
      // body pushed off the axis) belongs to the nearest tunnel, not the outside
      if (far && !(snap && domeDist(net, x, z) < DOME_R2 - 7)) continue;
      if (y > c.floor + 4) continue;                 // up on the hill, not in the tunnel below
      out.net = net; out.seg = c.seg; out.ch = c.ch;
      return out;
    }
    return null;
  }

  /** Node ids that bound a region (a tunnel's two ends, or the chamber). */
  _ends(net, r, out) {
    out.length = 0;
    if (r.seg >= 0) { out.push(net.segs[r.seg].a, net.segs[r.seg].b); }
    else out.push(net.chambers[r.ch].id);
    return out;
  }

  /**
   * Like Houses.navigate: 1 + waypoint in `out`, 0 to chase directly, or −1
   * when the caves have nothing to say (let the houses' pathing decide).
   * outside(zx, zz, tx, tz, out): the regular pathing, for legs out in the open.
   */
  navigate(zx, zz, tx, tz, out, big, zy, ty, outside) {
    const zr = this._region(zx, zz, zy, _zr, 0, true);
    const tr = this._region(tx, tz, ty, _tr, 0, true);
    if (!zr && !tr) {
      // Both in the open: go round any hill in the way
      for (const n of NETS) {
        if (Math.max(zx, tx) < n.x0 || Math.min(zx, tx) > n.x1 || Math.max(zz, tz) < n.z0 || Math.min(zz, tz) > n.z1) continue;
        if (this._blocked(n, zx, zz, tx, tz)) { this._detour(n, zx, zz, tx, tz, out); return 1; }
      }
      return -1;
    }
    const net = (zr ?? tr).net;
    const nav = net.nav;
    if (zr && tr && zr.net === tr.net) {
      if (zr.seg === tr.seg && zr.ch === tr.ch) return 0;
      // A tunnel and the chamber at its end: straight in
      const zs = zr.seg >= 0 ? net.segs[zr.seg] : null, ts = tr.seg >= 0 ? net.segs[tr.seg] : null;
      const zc = zr.ch >= 0 ? net.chambers[zr.ch].id : -1, tc = tr.ch >= 0 ? net.chambers[tr.ch].id : -1;
      if ((zs && tc >= 0 && (zs.a === tc || zs.b === tc)) || (ts && zc >= 0 && (ts.a === zc || ts.b === zc))) return 0;
    }
    // Big monsters don't fit: they wait outside the nearest mouth
    if (big && tr && !zr) {
      let best = Infinity, w = 0;
      for (const id of net.approach) {
        const d = Math.hypot(nav.nodes[id].x - zx, nav.nodes[id].z - zz);
        if (d < best) { best = d; w = id; }
      }
      out.x = nav.nodes[w].x; out.z = nav.nodes[w].z;
      return best < 2 ? 0 : 1;
    }
    const starts = zr && zr.net === net ? this._ends(net, zr, _s) : net.approach;
    const ends = tr && tr.net === net ? this._ends(net, tr, _e) : net.approach;
    let best = Infinity, bs = -1, be = -1;
    for (const s of starts) {
      const cs = Math.hypot(nav.nodes[s].x - zx, nav.nodes[s].z - zz);
      for (const e of ends) {
        const c = cs + nav.D[s][e] + Math.hypot(nav.nodes[e].x - tx, nav.nodes[e].z - tz);
        if (c < best) { best = c; bs = s; be = e; }
      }
    }
    if (bs < 0) return -1;
    let w = bs;
    // Already at the first node: on to the next one along the path
    if (Math.hypot(nav.nodes[w].x - zx, nav.nodes[w].z - zz) < 1.8) {
      if (w === be) return tr ? 0 : -1;
      w = nav.next[w][be];
    }
    out.x = nav.nodes[w].x;
    out.z = nav.nodes[w].z;
    // Out in the open on the way to a mouth: round the hill if it's in the
    // way, else the regular pathing (houses) gets there
    if (!zr) {
      const tx2 = out.x, tz2 = out.z;
      if (this._blocked(net, zx, zz, tx2, tz2)) this._detour(net, zx, zz, tx2, tz2, out);
      else if (outside && outside(zx, zz, tx2, tz2, out) === 0) { out.x = tx2; out.z = tz2; }
    }
    return 1;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /**
   * How deep underground (x, y, z) is: 0 outside or at a mouth, up to 1 in
   * the tunnels and chambers away from daylight.
   */
  depthAt(x, y, z) {
    const net = netAt(x, z);
    if (!net) return 0;
    const c = corridor(net, x, z, _cor);
    if (c.d > 6 || y > c.floor + 9) return 0;
    if (voidDist(net, x, y, z) > 0.3) return 0;
    if (y > skinHeight(net, x, z)) return 0;
    return 1 - this._skyAt(net, x, z);
  }

  /** True when something with its feet at y is down in a tunnel or chamber (not up on the hill). */
  inside(x, z, y) { return !!this._region(x, z, y, _in, 1.5); }

  /** True where solid rock stands at ground level (the rickshaw can't drive there). */
  solidAt(x, z, r = 0) {
    const net = netAt(x, z);
    if (!net) return false;
    if (domeDist(net, x, z) > DOME_R2 - 4) return false;
    for (const c of net.chambers) if (Math.hypot(x - c.x, z - c.z) < c.r - 1 - r) return false;
    for (const s of net.segs) if (segDist(s, x, z, _t) < 2.4 - r) return false;
    return true;
  }

  /** Height of the rock skin when standing on top of a massif, else null. */
  topAt(x, z) {
    const net = netAt(x, z);
    if (!net || domeDist(net, x, z) > DOME_R2 - 4) return null;
    const h = skinHeight(net, x, z);
    return h > groundHeight(x, z) + 0.5 ? h : null;
  }

  /** Distance to the nearest torch flame (for visibility and crackle). */
  nearestTorch(x, y, z) {
    let best = Infinity;
    for (const t of this.torches) best = Math.min(best, (t.flame.x - x) ** 2 + (t.flame.y - y) ** 2 + (t.flame.z - z) ** 2);
    return Math.sqrt(best);
  }

  /** For the world map: tunnels as segments, mouths, names. */
  mapInfo() {
    return NETS.map(n => ({
      name: n.name, x: n.cx, z: n.cz,
      tunnels: n.segs.map(s => [s.ax, s.az, s.bx, s.bz]),
      mouths: n.nodes.filter(nd => nd.kind === "m").map(nd => ({ x: nd.x, z: nd.z })),
    }));
  }

  /** Surface height for the world map's relief: the hills, not the floors under them. */
  mapHeight(x, z) {
    const net = netAt(x, z);
    const g = groundHeight(x, z);
    if (!net) return g;
    return Math.max(g, skinHeight(net, x, z));
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  /** Flicker, and the real lights handed to the torches nearest the camera. */
  update(delta, camPos, viewportH) {
    this.time += delta;
    const t = this.time;
    this.flameUniforms.uTime.value = t;
    this.flameUniforms.uScale.value = viewportH;
    this.material.userData.torchGlow.value = 0.9 + 0.1 * Math.sin(t * 5.1) * Math.sin(t * 2.3 + 1);

    // Nearest torches within 30 m get a light
    const near = _near;
    near.length = 0;
    if (netAt(camPos.x, camPos.z, 30)) {
      for (const tr of this.torches) {
        const d2 = tr.flame.distanceToSquared(camPos);
        if (d2 < 900) near.push(tr), tr._d2 = d2;
      }
      near.sort((a, b) => a._d2 - b._d2);
      near.length = Math.min(near.length, this.lights.length);
    }
    for (const l of this.lights) {
      const tr = l.userData.torch;
      if (tr && !near.includes(tr)) l.userData.torch = null;
    }
    for (const tr of near) {
      if (this.lights.some(l => l.userData.torch === tr)) continue;
      const free = this.lights.find(l => !l.userData.torch);
      if (!free) break;
      free.userData.torch = tr;
      free.userData.fade = 0;
      free.position.copy(tr.flame);
    }
    for (const l of this.lights) {
      const tr = l.userData.torch;
      if (!tr) { l.intensity = 0; continue; }
      l.userData.fade = Math.min(1, l.userData.fade + delta * 3);
      const f = flicker(t, tr.seed);
      l.intensity = 9 * f * l.userData.fade;
      // The flame wanders a little, so the light does too
      l.position.set(tr.flame.x + Math.sin(t * 6 + tr.seed) * 0.03, tr.flame.y + 0.05 * f, tr.flame.z + Math.cos(t * 5 + tr.seed) * 0.03);
    }
  }
}

const _one = new THREE.Vector3(1, 1, 1);
const _near = [];
const _zr = { net: null, seg: -1, ch: -1 };
const _in = { net: null, seg: -1, ch: -1 };
const _tr = { net: null, seg: -1, ch: -1 };
const _s = [], _e = [];

/** Convex hull of [x, z] points (monotone chain), counter-clockwise. */
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  hi.pop(); lo.pop();
  return lo.concat(hi);
}

/** Trilinear sample of a grid's field (outside the grid: air above, rock below). */
function sampleGrid(g, x, y, z) {
  let fx = (x - g.x0) / CELL, fy = (y - g.y0) / CELL, fz = (z - g.z0) / CELL;
  if (fx < 0 || fz < 0 || fx > g.nx - 1.001 || fz > g.nz - 1.001) return 1;
  if (fy < 0) return -1;
  if (fy > g.ny - 1.001) return 1;
  const i = fx | 0, j = fy | 0, k = fz | 0;
  fx -= i; fy -= j; fz -= k;
  const F = g.F, nx = g.nx, ny = g.ny;
  const at = (a, b, c) => F[(i + a) + nx * ((j + b) + ny * (k + c))];
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(at(0, 0, 0), at(1, 0, 0), fx), l(at(0, 1, 0), at(1, 1, 0), fx), fy),
    l(l(at(0, 0, 1), at(1, 0, 1), fx), l(at(0, 1, 1), at(1, 1, 1), fx), fy),
    fz);
}
