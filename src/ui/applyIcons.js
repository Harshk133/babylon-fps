import { icon, iconUrl, ICON_PATHS } from "./gameIcons.js";

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
  // (the credits for every model, icon, sound and font: the Credits & Legal screen, ui/LegalScreen.js)
}

/** Gear and item ids that share an icon. */
const ITEM_ICON = { helmet1: "helmet", helmet2: "helmet", helmet3: "helmet", vest1: "vest", vest2: "vest", vest3: "vest", backpack1: "backpack", backpack2: "backpack", backpack3: "backpack", holo: "reddot", scope2x: "scope4x", scope6x: "scope4x", scope8x: "scope4x", toolkit: "toolbox", grapple: "grapple" };

/** The game-icons version of an item's icon (white, tinted by CSS), or null if the set has none. */
export function gameItemIcon(id) {
  const name = ITEM_ICON[id] ?? id;
  return ICON_PATHS[name] ? iconUrl(name, "#fff") : null;
}
