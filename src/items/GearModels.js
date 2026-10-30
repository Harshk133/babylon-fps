import * as THREE from "three";

// Detailed helmets, vests and backpacks (Sketchfab, CC BY 4.0: GEAR_CREDITS;
// the full attribution, sources and changes are in public/models/gear/CREDITS.md).
// Each one is optional: the originals go in public/models/gear/ under these
// names (they stay local; `npm run optimize-assets` writes the committed
// *.opt.glb). Whatever is missing keeps the procedural stand-in (a dome, a
// box) on the soldier and on the ground. Worn ones are fitted by Soldier, the
// ones on the ground are drawn by Pickups.
//
// Every model is normalised once into a common frame, so it can be fitted to
// any character by size alone:
//   helmet    centred on x / z, rim (lowest point) on y = 0, visor toward +Z
//   vest      centred, the front toward +Z
//   backpack  the bag (not its straps or loose buckles, which stick out) centred
//             on x / y, its back panel on z = 0, the bag out along −Z
// yaw (radians) turns a model into that frame first, for an export that faces
// some other way; size: a scale on top of the fit; tint: multiplies its colours
// (one vest model, three levels).

export const GEAR_MODELS = {
  // (checked on tools/mixamo/soldier.html?helmet=1&backpack=1&vest=1&view=side&close=1; ?backpack1.yaw=… tries a value)
  helmet1:   { url: "/models/gear/helmet_1.glb",   yaw: 0 },
  helmet2:   { url: "/models/gear/helmet_2.glb",   yaw: 0 },
  helmet3:   { url: "/models/gear/helmet_3.glb",   yaw: Math.PI },
  vest1:     { url: "/models/gear/vest_1.glb",     yaw: 0, tint: 0xb8c49a },
  vest2:     { url: "/models/gear/vest_1.glb",     yaw: 0, tint: 0xd8c49a },
  vest3:     { url: "/models/gear/vest_1.glb",     yaw: 0 },
  backpack1: { url: "/models/gear/backpack_1.glb", yaw: Math.PI / 2 },
  backpack2: { url: "/models/gear/backpack_2.glb", yaw: Math.PI },
  backpack3: { url: "/models/gear/backpack_3.glb", yaw: 0 },
};

/** Shown with the other model credits (CC BY asks for it), one per file. */
export const GEAR_CREDITS = {
  "/models/gear/helmet_1.glb":   ["M1 Helmet", "Melvin Stubbe"],
  "/models/gear/helmet_2.glb":   ["Hełm wz. 2005", "Armored Wave"],
  "/models/gear/helmet_3.glb":   ["Combat helmet K6-3", "shamanoff"],
  "/models/gear/vest_1.glb":     ["Military Armor 3D Model", "Exactly"],
  "/models/gear/backpack_1.glb": ["Military Tactical Backpack", "Liam3D"],
  "/models/gear/backpack_2.glb": ["Low Poly Game Ready Military Tactical Backpack", "DanlyVostok"],
  "/models/gear/backpack_3.glb": ["Tactical Explorer Backpack", "yronthal"],
};

const kindOf = key => key.replace(/\d+$/, "");

/**
 * Loads whatever is there (the optimized copy first, then the original; each
 * file once): { key: { model, size, bag?, fit, url } | null }. model is a
 * THREE.Group in the frame above; size its bounds; bag (backpacks) the bag's
 * own extent { w, h, d } without the straps.
 */
export async function loadGearModels(gltfLoader) {
  const files = new Map();
  const fetchOnce = url => {
    if (!files.has(url)) {
      files.set(url, gltfLoader.loadAsync(url.replace(/\.glb$/, ".opt.glb"))
        .catch(() => gltfLoader.loadAsync(url))
        .then(g => g.scene, () => null));   // not there: the stand-in stays
    }
    return files.get(url);
  };
  const out = {};
  await Promise.all(Object.entries(GEAR_MODELS).map(async ([key, def]) => {
    const scene = await fetchOnce(def.url);
    out[key] = scene ? normalise(scene.clone(true), def, kindOf(key)) : null;
  }));
  return out;
}

const _v = new THREE.Vector3();

function normalise(scene, def, kind) {
  // Solid, and the standard shader: the exporters' physical / specular materials cost more
  // per pixel for nothing on something this small, and a "transparent" flag would sort it
  scene.traverse(o => {
    if (!o.isMesh) return;
    let m = o.material;
    if (m.isMeshPhysicalMaterial) {
      const std = new THREE.MeshStandardMaterial();
      THREE.MeshStandardMaterial.prototype.copy.call(std, m);
      std.name = m.name;
      m = std;
    } else if (def.tint) {
      m = m.clone();
    }
    if (m.transparent && m.opacity >= 0.99) {
      m.transparent = false;
      m.alphaTest = m.map ? 0.5 : 0;
    }
    if (def.tint) m.color.multiply(new THREE.Color(def.tint));
    o.material = m;
    o.castShadow = true;
    o.receiveShadow = false;
  });
  const inner = new THREE.Group();
  inner.add(scene);
  inner.rotation.y = def.yaw ?? 0;
  const holder = new THREE.Group();
  holder.add(inner);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  let bag = null;
  if (kind === "helmet") {
    inner.position.set(-c.x, -box.min.y, -c.z);
  } else if (kind === "vest") {
    inner.position.set(-c.x, -c.y, -c.z);
  } else {
    // The bag's body by where most of its surface is: straps and buckles are thin and stick
    // out (forward over the shoulders, down the sides), the bounding box follows them
    const xs = [], ys = [], zs = [];
    holder.traverse(o => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        _v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        xs.push(_v.x); ys.push(_v.y); zs.push(_v.z);
      }
    });
    const at = (a, f) => a[Math.floor(f * (a.length - 1))];
    for (const a of [xs, ys, zs]) a.sort((p, q) => p - q);
    const x0 = at(xs, 0.05), x1 = at(xs, 0.95), y0 = at(ys, 0.04), y1 = at(ys, 0.96);
    const back = at(zs, 0.88), front = at(zs, 0.04);   // its back panel; the far side
    inner.position.set(-(x0 + x1) / 2, -(y0 + y1) / 2, -back);
    bag = { w: x1 - x0, h: y1 - y0, d: back - front };
  }
  holder.updateMatrixWorld(true);
  return { model: holder, size, bag, fit: def.size ?? 1, url: def.url };
}
