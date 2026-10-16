import * as THREE from "three";

// Low-poly procedural models for guns, throwables and pickups.
// Every template is built once; held guns, pickups and projectiles all clone
// these, so geometry and materials are shared across every instance.
//
// Gun frame: origin = where the right hand grips, +X = barrel direction,
// +Y = up. `userData.muzzle` is the barrel tip in that frame (metres).

const MAT = {
  metal:   new THREE.MeshStandardMaterial({ color: 0x2e3135, metalness: 0.7, roughness: 0.4 }),
  polymer: new THREE.MeshStandardMaterial({ color: 0x1c1d1f, metalness: 0.1, roughness: 0.7 }),
  wood:    new THREE.MeshStandardMaterial({ color: 0x6e4325, metalness: 0.0, roughness: 0.8 }),
  olive:   new THREE.MeshStandardMaterial({ color: 0x4f5a2c, metalness: 0.1, roughness: 0.75 }),
  oliveDk: new THREE.MeshStandardMaterial({ color: 0x3a4220, metalness: 0.1, roughness: 0.8 }),
  tan:     new THREE.MeshStandardMaterial({ color: 0x9a8560, metalness: 0.05, roughness: 0.8 }),
  yellow:  new THREE.MeshStandardMaterial({ color: 0xd9a400, metalness: 0.1, roughness: 0.6 }),
  white:   new THREE.MeshStandardMaterial({ color: 0xe6e6e2, metalness: 0.0, roughness: 0.6 }),
  red:     new THREE.MeshStandardMaterial({ color: 0xc4161c, metalness: 0.0, roughness: 0.6 }),
  cloth:   new THREE.MeshStandardMaterial({ color: 0xcfc3a3, metalness: 0.0, roughness: 1.0 }),
  liquid:  new THREE.MeshStandardMaterial({ color: 0xb8620f, metalness: 0.0, roughness: 0.3, emissive: 0x2a1000 }),
  glass:   new THREE.MeshStandardMaterial({
    color: 0x6b8f3a, metalness: 0.1, roughness: 0.1, transparent: true, opacity: 0.55, depthWrite: false,
  }),
};

const _boxCache = new Map();
const _cylCache = new Map();

function boxGeo(w, h, d) {
  const key = `${w}|${h}|${d}`;
  let g = _boxCache.get(key);
  if (!g) { g = new THREE.BoxGeometry(w, h, d); _boxCache.set(key, g); }
  return g;
}

// Cylinder along +X (barrels) or +Y (bottles) with optional taper
function cylGeo(rTop, rBottom, len, alongX) {
  const key = `${rTop}|${rBottom}|${len}|${alongX}`;
  let g = _cylCache.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(rTop, rBottom, len, 10);
    if (alongX) g.rotateZ(-Math.PI / 2);
    _cylCache.set(key, g);
  }
  return g;
}

function part(group, geo, mat, x, y, z, rotZ = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.z = rotZ;
  m.castShadow = true;
  group.add(m);
  return m;
}
const box = (g, w, h, d, mat, x, y, z, rotZ) => part(g, boxGeo(w, h, d), mat, x, y, z, rotZ);
const barrel = (g, r, len, mat, x, y, z) => part(g, cylGeo(r, r, len, true), mat, x, y, z);

function gun(muzzleX, boreY, build) {
  const g = new THREE.Group();
  build(g);
  g.userData.muzzle = new THREE.Vector3(muzzleX, boreY, 0);
  return g;
}

const BUILDERS = {
  pistol: () => gun(0.165, 0.085, g => {
    box(g, 0.20, 0.035, 0.028, MAT.metal,   0.06, 0.085, 0);
    box(g, 0.17, 0.025, 0.026, MAT.polymer, 0.05, 0.058, 0);
    box(g, 0.036, 0.11, 0.03,  MAT.polymer, -0.005, 0.0, 0, -0.25);
    box(g, 0.04, 0.006, 0.012, MAT.polymer, 0.04, 0.03, 0);
  }),

  smg: () => gun(0.3, 0.08, g => {
    box(g, 0.28, 0.06, 0.04,  MAT.polymer, 0.06, 0.07, 0);
    barrel(g, 0.012, 0.08,    MAT.metal,   0.24, 0.08, 0);
    box(g, 0.035, 0.09, 0.03, MAT.polymer, 0, 0.0, 0, -0.2);
    box(g, 0.03, 0.13, 0.025, MAT.metal,   0.09, -0.02, 0);
    box(g, 0.14, 0.02, 0.02,  MAT.metal,   -0.15, 0.07, 0);
    box(g, 0.015, 0.06, 0.03, MAT.polymer, -0.22, 0.06, 0);
    box(g, 0.05, 0.015, 0.012, MAT.polymer, 0.12, 0.108, 0);
  }),

  shotgun: () => gun(0.64, 0.085, g => {
    box(g, 0.2, 0.06, 0.04,    MAT.metal, 0.04, 0.07, 0);
    barrel(g, 0.016, 0.5,      MAT.metal, 0.39, 0.085, 0);
    barrel(g, 0.013, 0.38,     MAT.metal, 0.33, 0.055, 0);
    box(g, 0.14, 0.035, 0.045, MAT.wood,  0.32, 0.05, 0);
    box(g, 0.04, 0.08, 0.032,  MAT.wood,  -0.03, 0.02, 0, -0.35);
    box(g, 0.3, 0.06, 0.035,   MAT.wood,  -0.2, 0.05, 0, 0.1);
    box(g, 0.02, 0.08, 0.04,   MAT.polymer, -0.355, 0.03, 0, 0.1);
  }),

  rifle: () => gun(0.58, 0.085, g => {
    box(g, 0.3, 0.065, 0.04,   MAT.polymer, 0.07, 0.075, 0);
    box(g, 0.2, 0.05, 0.045,   MAT.olive,   0.31, 0.08, 0);
    barrel(g, 0.011, 0.14,     MAT.metal,   0.48, 0.085, 0);
    barrel(g, 0.016, 0.04,     MAT.metal,   0.56, 0.085, 0);
    box(g, 0.035, 0.14, 0.028, MAT.metal,   0.11, -0.01, 0, 0.2);
    box(g, 0.035, 0.09, 0.03,  MAT.polymer, 0, 0.01, 0, -0.25);
    box(g, 0.24, 0.06, 0.035,  MAT.olive,   -0.19, 0.065, 0, 0.05);
    box(g, 0.12, 0.02, 0.015,  MAT.polymer, 0.08, 0.12, 0);
    box(g, 0.02, 0.03, 0.015,  MAT.polymer, 0.02, 0.115, 0);
    box(g, 0.012, 0.035, 0.012, MAT.polymer, 0.37, 0.12, 0);
  }),

  sniper: () => gun(0.73, 0.085, g => {
    box(g, 0.26, 0.06, 0.04,   MAT.metal, 0.05, 0.075, 0);
    barrel(g, 0.013, 0.5,      MAT.metal, 0.43, 0.085, 0);
    barrel(g, 0.018, 0.05,     MAT.metal, 0.7, 0.085, 0);
    box(g, 0.32, 0.05, 0.045,  MAT.tan,   0.25, 0.058, 0);
    box(g, 0.32, 0.07, 0.04,   MAT.tan,   -0.2, 0.05, 0, 0.06);
    box(g, 0.02, 0.1, 0.045,   MAT.polymer, -0.365, 0.035, 0, 0.06);
    box(g, 0.035, 0.085, 0.03, MAT.tan,   0, 0.01, 0, -0.3);
    barrel(g, 0.02, 0.28,      MAT.polymer, 0.07, 0.145, 0);
    barrel(g, 0.028, 0.06,     MAT.polymer, 0.2, 0.145, 0);
    barrel(g, 0.026, 0.05,     MAT.polymer, -0.06, 0.145, 0);
    box(g, 0.015, 0.04, 0.015, MAT.metal, 0.0, 0.115, 0);
    box(g, 0.015, 0.04, 0.015, MAT.metal, 0.14, 0.115, 0);
    box(g, 0.012, 0.012, 0.06, MAT.metal, -0.03, 0.08, 0.04);
    box(g, 0.06, 0.04, 0.03,   MAT.metal, 0.08, 0.03, 0);
  }),

  grenade: () => {
    const g = new THREE.Group();
    const body = part(g, new THREE.SphereGeometry(0.045, 12, 10), MAT.olive, 0, 0, 0);
    body.scale.y = 1.25;
    part(g, cylGeo(0.016, 0.016, 0.03, false), MAT.metal, 0, 0.065, 0);
    box(g, 0.012, 0.075, 0.014, MAT.metal, 0.024, 0.03, 0, -0.25);
    const ring = part(g, new THREE.TorusGeometry(0.014, 0.003, 6, 12), MAT.metal, -0.026, 0.072, 0);
    ring.rotation.y = Math.PI / 2;
    return g;
  },

  molotov: () => {
    const g = new THREE.Group();
    part(g, cylGeo(0.036, 0.036, 0.1, false), MAT.liquid, 0, -0.015, 0);
    part(g, cylGeo(0.04, 0.04, 0.14, false), MAT.glass, 0, 0, 0);
    part(g, cylGeo(0.015, 0.04, 0.04, false), MAT.glass, 0, 0.09, 0);
    part(g, cylGeo(0.014, 0.014, 0.05, false), MAT.glass, 0, 0.135, 0);
    box(g, 0.03, 0.07, 0.03, MAT.cloth, 0.005, 0.18, 0, 0.2);
    return g;
  },

  ammo: () => {
    const g = new THREE.Group();
    box(g, 0.3, 0.16, 0.14,     MAT.olive,   0, 0, 0);
    box(g, 0.31, 0.025, 0.15,   MAT.oliveDk, 0, 0.09, 0);
    box(g, 0.302, 0.03, 0.142,  MAT.yellow,  0, -0.02, 0);
    box(g, 0.09, 0.015, 0.025,  MAT.metal,   0, 0.11, 0);
    return g;
  },

  // Jerrycan: red body, three-bar handle, angled spout
  fuel: () => {
    const g = new THREE.Group();
    box(g, 0.26, 0.32, 0.12,   MAT.red,     0, 0, 0);
    box(g, 0.262, 0.02, 0.122, MAT.metal,   0, 0.09, 0);
    box(g, 0.262, 0.02, 0.122, MAT.metal,   0, -0.09, 0);
    for (const x of [-0.08, 0, 0.08]) box(g, 0.02, 0.06, 0.02, MAT.metal, x, 0.19, 0);
    box(g, 0.2, 0.02, 0.03,    MAT.metal,   0, 0.22, 0);
    part(g, cylGeo(0.022, 0.03, 0.09, false), MAT.polymer, 0.1, 0.2, 0, -0.6);
    return g;
  },

  medkit: () => {
    const g = new THREE.Group();
    box(g, 0.28, 0.18, 0.1,   MAT.white, 0, 0, 0);
    for (const z of [0.052, -0.052]) {
      box(g, 0.12, 0.035, 0.005, MAT.red, 0, 0, z);
      box(g, 0.035, 0.12, 0.005, MAT.red, 0, 0, z);
    }
    box(g, 0.09, 0.02, 0.03, MAT.polymer, 0, 0.1, 0);
    return g;
  },
};

const _templates = new Map();

/** Shared template for an item id (pistol, smg, …, grenade, molotov, ammo, medkit). Clone before adding to a scene. */
export function getItemTemplate(id) {
  let t = _templates.get(id);
  if (!t) {
    t = BUILDERS[id]();
    _templates.set(id, t);
  }
  return t;
}

export function cloneItem(id) {
  const t = getItemTemplate(id);
  const c = t.clone(true);
  c.userData.muzzle = t.userData.muzzle;
  return c;
}

// ─── HUD icons ────────────────────────────────────────────────────────────────
// Renders a white silhouette of an item into a data URL, once at boot. The HUD
// tints it with CSS. Supersampled 3× then downscaled for anti-aliasing.
const _iconMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

export function renderItemIcon(renderer, id, { width = 160, height = 64, yaw = 0, pitch = 0 } = {}) {
  const SS = 3;
  const W = width * SS, H = height * SS;
  const scene = new THREE.Scene();
  scene.overrideMaterial = _iconMat;
  const pivot = new THREE.Group();
  pivot.add(cloneItem(id));
  pivot.rotation.set(pitch, yaw, 0, "YXZ");
  scene.add(pivot);
  pivot.updateMatrixWorld(true);

  const bbox = new THREE.Box3().setFromObject(pivot);
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const aspect = W / H;
  const halfH = Math.max(size.y / 2, size.x / 2 / aspect) * 1.1;
  const halfW = halfH * aspect;
  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 100);
  cam.position.set(center.x, center.y, center.z + 10);
  cam.lookAt(center);

  const rt = new THREE.WebGLRenderTarget(W, H);
  const prevTarget = renderer.getRenderTarget();
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, cam);
  const px = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevColor, prevAlpha);
  rt.dispose();

  const big = document.createElement("canvas");
  big.width = W; big.height = H;
  const bctx = big.getContext("2d");
  const img = bctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 4; // GL rows are bottom-up
    const dst = y * W * 4;
    for (let x = 0; x < W * 4; x += 4) {
      img.data[dst + x] = 255;
      img.data[dst + x + 1] = 255;
      img.data[dst + x + 2] = 255;
      img.data[dst + x + 3] = px[src + x + 3];
    }
  }
  bctx.putImageData(img, 0, 0);

  const small = document.createElement("canvas");
  small.width = width; small.height = height;
  const sctx = small.getContext("2d");
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(big, 0, 0, width, height);
  return small.toDataURL();
}
