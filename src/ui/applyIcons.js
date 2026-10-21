import { icon, iconUrl, ICON_PATHS, ICON_CREDITS } from "./gameIcons.js";
import { CREDITS } from "../world/IndiaAssets.js";

// Puts the game-icons.net set (src/ui/gameIcons.js) into the static HUD and
// lobby markup at boot, so index.html stays readable. Each swap keeps the old
// element's classes, so the existing CSS (size, colour, animation) still applies.

function swapSvg(selector, name) {
  for (const old of document.querySelectorAll(selector)) {
    const tpl = document.createElement("template");
    tpl.innerHTML = icon(name, old.getAttribute("class") ?? "");
    old.replaceWith(tpl.content.firstChild);
  }
}

export function applyStaticIcons() {
  swapSvg(".health-heart", "heart");
  swapSvg(".threat-eye", "eye");
  swapSvg("#lobby-solo .mode-icon", "solo");
  swapSvg("#lobby-coop .mode-icon", "coop");
  swapSvg("#lobby-br .mode-icon", "br");
  const kills = document.querySelector(".kills-label");
  if (kills) kills.innerHTML = `${icon("skull", "kills-icon")}KILLS`;
  const torch = document.getElementById("env-torch");
  if (torch) torch.insertAdjacentHTML("afterbegin", icon("flashlight", "env-torch-icon"));
  const veh = document.querySelector("#vehicle-hud .veh-title");
  if (veh) veh.innerHTML = `${icon("steering", "veh-icon")}<span id="veh-name">AUTO-RICKSHAW</span>`;
  const noise = document.querySelector("#noise-meter .noise-label");
  if (noise) noise.innerHTML = `${icon("noise", "noise-icon")}NOISE`;
  // CC BY credits for the Sketchfab models and the icons, on the pause screen
  const start = document.getElementById("start-screen");
  if (start && !start.querySelector(".credits")) {
    const p = document.createElement("p");
    p.className = "credits";
    p.textContent = `3D models (Sketchfab, CC BY): ${CREDITS.map(([what, who]) => `${what} by ${who}`).join(" · ")}. ${ICON_CREDITS}.`;
    start.append(p);
  }
}

/** Gear and item ids that share an icon. */
const ITEM_ICON = { helmet1: "helmet", helmet2: "helmet", helmet3: "helmet", vest1: "vest", vest2: "vest", vest3: "vest", backpack1: "backpack", backpack2: "backpack", backpack3: "backpack" };

/**
 * Replaces the rendered 3D silhouettes in an item → URL icon map with the
 * game-icons versions wherever the set has one (white, tinted by CSS).
 */
export function useGameItemIcons(icons) {
  for (const id of Object.keys(icons)) {
    const name = ITEM_ICON[id] ?? id;
    if (ICON_PATHS[name]) icons[id] = iconUrl(name, "#fff");
  }
  return icons;
}
