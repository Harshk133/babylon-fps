import * as THREE from "three";

// Detailed helmets and backpacks (Sketchfab, CC BY 4.0: GEAR_CREDITS; the full
// attribution, sources and changes are in public/models/gear/CREDITS.md).
// Each one is optional: the originals go in public/models/gear/ under these
// names (they stay local; `npm run optimize-assets` writes the committed
// *.opt.glb). Whatever is missing keeps the procedural stand-in (a dome, a
// box) on the soldier and on the ground.
//
// Every model is normalised once into a common frame, so Soldier can fit it to
// any character by size alone:
//   helmet    centred on x / z, rim (lowest point) on y = 0, visor toward +Z
//   backpack  centred on x / y, the side against the back (straps) on z = 0,
//             the bag out along −Z
// yaw / pitch (radians) turn a model into that frame first: set them when an
// export faces some other way. inset: how much of a backpack's depth is
// straps (they wrap forward over the shoulders), so the bag's back panel sits
// on the back; size: a scale on top of the fit.

export const GEAR_MODELS = {
  // (tuned on tools/mixamo/soldier.html?helmet=1&backpack=1&view=side&close=1; ?backpack1.inset=0.3 tries a value)
  helmet1:   { url: "/models/gear/helmet_1.glb",   yaw: 0 },
  helmet2:   { url: "/models/gear/helmet_2.glb",   yaw: 0 },
  helmet3:   { url: "/models/gear/helmet_3.glb",   yaw: Math.PI },
  backpack1: { url: "/models/gear/backpack_1.glb", yaw: Math.PI / 2, inset: 0.3, size: 1.2 },
  backpack2: { url: "/models/gear/backpack_2.glb", yaw: Math.PI, inset: 0.45, size: 1.3 },
  backpack3: { url: "/models/gear/backpack_3.glb", yaw: 0, inset: 0.3, size: 1.45 },
};

/** Shown with the other model credits (CC Attribution asks for it). */
export const GEAR_CREDITS = [
  ["M1 Helmet", "Melvin Stubbe"],
  ["Hełm wz. 2005", "Armored Wave"],
  ["Combat helmet K6-3", "shamanoff"],
  ["Military Tactical Backpack", "Liam3D"],
  ["Low Poly Game Ready Military Tactical Backpack", "DanlyVostok"],
  ["Tactical Explorer Backpack", "yronthal"],
];

/**
 * Loads whatever is there (the optimized copy first, then the original):
 * { key: { model: THREE.Group (normalised), size: Vector3 } | null }.
 */
export async function loadGearModels(gltfLoader) {
  const out = {};
  await Promise.all(Object.entries(GEAR_MODELS).map(async ([key, def]) => {
    out[key] = null;
    let scene = null;
    try {
      scene = (await gltfLoader.loadAsync(def.url.replace(/\.glb$/, ".opt.glb"))).scene;
    } catch {
      try { scene = (await gltfLoader.loadAsync(def.url)).scene; } catch { /* not there: the stand-in stays */ }
    }
    if (scene) out[key] = normalise(scene, def, key.startsWith("helmet") ? "helmet" : "backpack");
  }));
  return out;
}

function normalise(scene, def, kind) {
  // Solid, and the standard shader: the exporters' physical / specular materials cost more
  // per pixel for nothing on something this small, and a "transparent" flag would sort it
  scene.traverse(o => {
    if (!o.isMesh) return;
    const m = o.material;
    if (m.isMeshPhysicalMaterial) {
      const std = new THREE.MeshStandardMaterial();
      THREE.MeshStandardMaterial.prototype.copy.call(std, m);
      std.name = m.name;
      o.material = std;
    }
    if (o.material.transparent && o.material.opacity >= 0.99) {
      o.material.transparent = false;
      o.material.alphaTest = o.material.map ? 0.5 : 0;
    }
  });
  const inner = new THREE.Group();
  inner.add(scene);
  inner.rotation.set(def.pitch ?? 0, def.yaw ?? 0, 0, "YXZ");
  const holder = new THREE.Group();
  holder.add(inner);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  inner.position.set(-c.x, kind === "helmet" ? -box.min.y : -c.y, kind === "helmet" ? -c.z : -box.max.z + size.z * (def.inset ?? 0));
  holder.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
  });
  holder.updateMatrixWorld(true);
  return { model: holder, size, fit: def.size ?? 1, inset: def.inset ?? 0 };
}
