// The "Your look" panel in the lobby: pick a character and the colours of
// its clothes. Changes apply at once to your soldier (who stands in the world
// behind the lobby) through onChange, and are saved (Avatar.saveAvatar).
// Characters made of separate garments (Remy) get a row per slot; one-piece
// characters get a single outfit tint.

import { CHARACTERS, PALETTES, SLOTS, saveAvatar } from "../player/Avatar.js";

const SLOT_LABELS = { top: "Top", bottom: "Trousers", shoes: "Shoes", hair: "Hair", outfit: "Outfit" };
const hex = c => `#${c.toString(16).padStart(6, "0")}`;

export class AvatarPicker {
  /** root: the panel element; avatar: the current look; onChange(avatar). */
  constructor(root, avatar, onChange) {
    this.root = root;
    this.avatar = { ...avatar };
    this.onChange = onChange;
    root.addEventListener("click", e => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const a = this.avatar;
      if (btn.dataset.char !== undefined) a.char = +btn.dataset.char;
      else if (btn.dataset.slot) a[btn.dataset.slot === "outfit" ? "top" : btn.dataset.slot] = +btn.dataset.i;
      else if (btn.dataset.random !== undefined) {
        a.char = Math.floor(Math.random() * CHARACTERS.length);
        for (const s of SLOTS) a[s] = Math.floor(Math.random() * 8);
      } else return;
      saveAvatar(a);
      this._render();
      this.onChange({ ...a });
    });
    this._render();
  }

  _render() {
    const a = this.avatar, def = CHARACTERS[a.char] ?? CHARACTERS[0];
    const slots = def.parts ? Object.keys(def.parts) : ["outfit"];
    const row = slot => {
      const cur = a[slot === "outfit" ? "top" : slot];
      const sw = PALETTES[slot].map((c, i) =>
        `<button class="av-sw${i === cur ? " on" : ""}${i === 0 ? " orig" : ""}" data-slot="${slot}" data-i="${i}" style="--c:${hex(c)}" aria-label="${SLOT_LABELS[slot]} ${i === 0 ? "original" : i}" aria-pressed="${i === cur}"></button>`).join("");
      return `<div class="av-row"><span class="av-slot">${SLOT_LABELS[slot]}</span><div class="av-swatches">${sw}</div></div>`;
    };
    this.root.innerHTML = `
      <div class="av-head"><h2>Your look</h2><button class="av-random" data-random title="Random look">Random</button></div>
      <div class="av-chars" role="radiogroup" aria-label="Character">${CHARACTERS.map((c, i) =>
        `<button class="av-char${i === a.char ? " on" : ""}" data-char="${i}" role="radio" aria-checked="${i === a.char}">${c.label}</button>`).join("")}</div>
      ${slots.map(row).join("")}`;
  }
}
