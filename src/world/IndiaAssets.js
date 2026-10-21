// The Indian models (Sketchfab, CC Attribution; credits in CREDITS below).
// Each one is optional: the files live in public/models/india/ under these
// names (the heavy originals stay local, `npm run optimize-assets` writes the
// committed *.opt.glb), and whatever is missing falls back (the old rickshaw,
// a stand-in jeep, procedural notes and biscuits) or is left out (trucks,
// buildings).

export const INDIA_MODELS = {
  rickshaw:     "/models/india/autorickshaw.glb",
  thar:         "/models/india/thar.glb",
  truck:        "/models/india/truck.glb",
  panchayat:    "/models/india/panchayat.glb",
  townBuilding: "/models/india/town_building.glb",
  biscuit:      "/models/india/parle_g.glb",
  rupees:       "/models/india/rupees_2000.glb",
};

/** Shown on the lobby's credits line (CC Attribution asks for it). */
export const CREDITS = [
  ["Panchayat building", "nayan pachori"],
  ["Autorikshaw - Indian Tuk Tuk", "bhagathartworks"],
  ["Indian Truck", "AFJAL ANSARI"],
  ["Mahindra Thar Roxx", "ansari_studios"],
  ["Town Building", "nayan pachori"],
  ["Indian cookie", "seirogan"],
  ["Indian 2000 rupees notes", "varun pal"],
];

/** True if the dev server / host has a real model at url (Vite answers a missing file with index.html). */
async function exists(url) {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.ok && !(r.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}

/**
 * Loads every model that's there: { key: THREE.Group | null }.
 * gltfLoader: a GLTFLoader with the meshopt decoder set.
 */
export async function loadIndiaModels(gltfLoader) {
  const out = {};
  await Promise.all(Object.entries(INDIA_MODELS).map(async ([key, url]) => {
    out[key] = null;
    const opt = url.replace(/\.glb$/, ".opt.glb");
    const use = (await exists(opt)) ? opt : (await exists(url)) ? url : null;
    if (!use) return;
    try {
      out[key] = (await gltfLoader.loadAsync(use)).scene;
    } catch (err) {
      console.warn(`India model ${key}:`, err);
    }
  }));
  return out;
}
