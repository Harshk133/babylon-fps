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
  // Made for the game (sources in public/models/indian things/, no credit line needed)
  waterTower:   "/models/india/water_tower.glb",
  chaiwala:     "/models/india/chaiwala.glb",
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

/**
 * Loads every model that's there: { key: THREE.Group | null }. The optimized
 * copy is fetched straight away (no HEAD request first: on a phone every
 * round trip is 100+ ms); if it's missing, the original; if that's missing too
 * (the dev server answers with index.html, which won't parse), null.
 * gltfLoader: a GLTFLoader with the meshopt decoder set.
 */
export async function loadIndiaModels(gltfLoader) {
  const out = {};
  await Promise.all(Object.entries(INDIA_MODELS).map(async ([key, url]) => {
    out[key] = null;
    const opt = url.replace(/\.glb$/, ".opt.glb");
    try {
      out[key] = (await gltfLoader.loadAsync(opt)).scene;
    } catch {
      try { out[key] = (await gltfLoader.loadAsync(url)).scene; } catch { /* not there: left out */ }
    }
  }));
  return out;
}
