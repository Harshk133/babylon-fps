// Graphics quality presets. "auto" picks one from the device (memory, CPU
// cores, GPU name) so a 4 GB laptop with integrated graphics starts on Low.
// The choice is read once at startup (some of it, like antialiasing, can only
// be set when the renderer is created), so changing it reloads the page.
//
// Phones and tablets get their own tuning of each preset (TOUCH_TUNING).
//
// Only purely visual things scale here. Anything with a collider (trees,
// boulders, houses) is identical on every preset, so battle royale loot,
// which skips spots on colliders, comes out the same for every player.

import { IS_TOUCH } from "./input/TouchControls.js";

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
    fireLights: 1,        // point lights shared by molotov fires
    houseLights: 1,       // point lights shared by lit houses
    wreckLight: false,    // the flickering light on the nearest burning wreck
    post: "off",          // PostFX: "off" | "grade" (one colour-grade pass) | "full" (+ bloom)
    caveLights: 1,        // point lights that follow the cave torches nearest the camera
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
    fireLights: 2,
    houseLights: 2,
    wreckLight: true,
    post: "grade",
    caveLights: 2,
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
    fireLights: 2,
    houseLights: 2,
    wreckLight: true,
    post: "full",
    caveLights: 3,
  },
};

// Phones: tile GPUs resolve MSAA on-chip, so antialiasing is close to free,
// and the screens are so dense that rendering at 1 CSS pixel looks smeared.
// What they can't afford is per-pixel lighting (every point light costs every
// lit pixel, even at intensity 0) and overdraw (grass, rain, mist). So the
// touch presets trade those for resolution, which is what you actually see.
const TOUCH_TUNING = {
  low: {
    pixelRatioMax: 1.25,
    pixelRatioMin: 0.85,
    grass: 1600,
    pebbles: 60,
    rain: 1500,
    mist: 18,
  },
  medium: {
    antialias: true,
    pixelRatioMax: 1.4,
    pixelRatioMin: 1,
    shadowEvery: 1,       // every frame: alternating light / heavy frames judder
    grass: 3800,
    pebbles: 120,
    rain: 2800,
    mist: 30,
    fireLights: 1,
    houseLights: 1,
    wreckLight: false,
    post: "off",          // a full-screen pass is real fill-rate on a phone
    caveLights: 1,
  },
  high: {
    antialias: true,
    pixelRatioMax: 1.75,
    pixelRatioMin: 1.1,
    shadowEvery: 1,
    grass: 7000,
    pebbles: 200,
    rain: 4500,
    mist: 45,
    fireLights: 1,
    houseLights: 1,
    post: "grade",
    caveLights: 2,
  },
};
if (IS_TOUCH) for (const [name, tuning] of Object.entries(TOUCH_TUNING)) Object.assign(QUALITY_PRESETS[name], tuning);
// On phones the three presets are the Battery saver / Balanced / High profiles
if (IS_TOUCH) {
  QUALITY_PRESETS.low.label = "Battery saver";
  QUALITY_PRESETS.medium.label = "Balanced";
  QUALITY_PRESETS.high.label = "High";
}

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
  if (IS_TOUCH) return detectPhoneQuality(gpu, mem, cores);
  const integrated = /intel|uhd|iris|hd graphics|mali|adreno|powervr|apple gpu|vega [0-9] |radeon\(tm\) graphics/.test(gpu);
  if (mem <= 4 || cores <= 4) return "low";
  if (integrated || mem <= 8) return "medium";
  return "high";
}

/**
 * Phones all report "integrated" GPUs, so sort them by GPU family instead:
 * Adreno 730+ / Mali-G710+ / Immortalis / Xclipse / Apple are flagships,
 * Adreno 6xx and Mali-G76..G78 are mid-range, the rest is budget.
 */
function detectPhoneQuality(gpu, mem, cores) {
  if (mem <= 3 || cores <= 4) return "low";
  const adreno = +(gpu.match(/adreno[^0-9]*(\d{3})/)?.[1] ?? 0);
  const maliG = +(gpu.match(/mali-g(\d{2,3})/)?.[1] ?? 0);
  if (adreno >= 730 || maliG >= 710 || /immortalis|xclipse|apple gpu/.test(gpu)) return "high";
  if (adreno >= 640 || (maliG >= 76 && maliG < 100) || maliG >= 610) return "medium";
  if (adreno || maliG || /powervr|mali/.test(gpu)) return "low";
  return "medium"; // the WebView hid the GPU name
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
