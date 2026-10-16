// Graphics quality presets. "auto" picks one from the device (memory, CPU
// cores, GPU name) so a 4 GB laptop with integrated graphics starts on Low.
// The choice is read once at startup (some of it, like antialiasing, can only
// be set when the renderer is created), so changing it reloads the page.
//
// Only purely visual things scale here. Anything with a collider (trees,
// boulders, houses) is identical on every preset, so battle royale loot,
// which skips spots on colliders, comes out the same for every player.

const KEY = "babylon-fps:quality";

export const QUALITY_PRESETS = {
  low: {
    label: "Low",
    antialias: false,
    pixelRatioMax: 0.85,  // render below native resolution; dynamic resolution works under this
    pixelRatioMin: 0.5,
    shadows: false,
    shadowEvery: 0,       // 0 = no shadow map at all
    grass: 2200,
    pebbles: 70,
    rain: 2500,
    mist: 35,
    terrainStep: 2,       // render every 2nd heightmap point (physics always uses all of them)
    mountainSegments: 96,
    anisotropy: 1,
  },
  medium: {
    label: "Medium",
    antialias: false,
    pixelRatioMax: 1,
    pixelRatioMin: 0.6,
    shadows: true,
    shadowEvery: 2,       // redraw the shadow map every other frame
    grass: 6000,
    pebbles: 160,
    rain: 5500,
    mist: 60,
    terrainStep: 1,
    mountainSegments: 160,
    anisotropy: 4,
  },
  high: {
    label: "High",
    antialias: true,
    pixelRatioMax: 1.5,
    pixelRatioMin: 0.65,
    shadows: true,
    shadowEvery: 1,
    grass: 12000,
    pebbles: 260,
    rain: 9000,
    mist: 90,
    terrainStep: 1,
    mountainSegments: 224,
    anisotropy: 8,
  },
};

function gpuName() {
  try {
    const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return String(name || "");
  } catch {
    return "";
  }
}

/** Best guess for this machine. */
export function detectQuality() {
  const gpu = gpuName().toLowerCase();
  const mem = navigator.deviceMemory ?? 8;       // GB (Chrome/Edge only; others report nothing)
  const cores = navigator.hardwareConcurrency ?? 4;
  if (/swiftshader|llvmpipe|software|microsoft basic/.test(gpu)) return "low";
  const integrated = /intel|uhd|iris|hd graphics|mali|adreno|powervr|apple gpu|vega [0-9] |radeon\(tm\) graphics/.test(gpu);
  if (mem <= 4 || cores <= 4) return "low";
  if (integrated || mem <= 8) return "medium";
  return "high";
}

export function savedQuality() {
  try { return localStorage.getItem(KEY) || "auto"; } catch { return "auto"; }
}

export function saveQuality(value) {
  try { localStorage.setItem(KEY, value); } catch { /* private mode */ }
}

const setting = savedQuality();
export const QUALITY_NAME = QUALITY_PRESETS[setting] ? setting : detectQuality();
export const QUALITY = QUALITY_PRESETS[QUALITY_NAME];
/** What the lobby shows: "auto" or a preset name. */
export const QUALITY_SETTING = QUALITY_PRESETS[setting] ? setting : "auto";
