import { WEAPONS, WEAPON_ORDER, THROWABLES, THROWABLE_ORDER, FUEL_CAN, BISCUIT, GEAR } from "../combat/weapons.js";

const FEED_LIFE = 2600; // ms
const fmtReserve = r => (r === Infinity ? "∞" : `${r}`);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Writes only when the value changes (HUD perf rule)
function setText(node, cache, key, value) {
  if (cache[key] === value) return;
  cache[key] = value;
  node.textContent = value;
}
function setClass(node, cache, key, cls, on) {
  if (cache[key] === on) return;
  cache[key] = on;
  node.classList.toggle(cls, on);
}

/**
 * The always-on inventory DOM: the hotbar, the pickup prompt and the pickup
 * feed. The full inventory screen (Tab) is src/ui/LootScreen.js.
 */
export class InventoryUI {
  /** promptIcon(key) → SVG markup shown in a prompt row (optional). */
  constructor({ inventory, icons, promptIcon = null }) {
    this.inv = inventory;
    this.icons = icons;
    this.promptIcon = promptIcon;
    this._ver = -1;

    this.promptEl = document.getElementById("pickup-prompt");
    this.feedEl = document.getElementById("pickup-feed");
    this._prompt = null;

    this._buildHotbar(document.getElementById("hotbar"));
    this.gearEl = document.getElementById("gear-hud");
    this._gearSig = "";
  }

  // ── Hotbar ──────────────────────────────────────────────────────────────────

  _buildHotbar(root) {
    const weaponsRow = el("div", "hb-weapons");
    this.slots = {};
    for (const id of WEAPON_ORDER) {
      const def = WEAPONS[id];
      const slot = el("div", "hb-slot");
      slot.dataset.hb = "weapon";
      slot.dataset.id = id;
      slot.append(el("span", "hb-key", `${def.slot}`));
      const img = el("img", "hb-icon");
      img.src = this.icons[id];
      img.alt = def.name;
      slot.append(img);
      const ammo = el("span", "hb-ammo", "");
      slot.append(ammo);
      weaponsRow.append(slot);
      this.slots[id] = { slot, ammo, cache: {} };
    }

    const itemsRow = el("div", "hb-items");
    this.tslots = {};
    for (const kind of THROWABLE_ORDER) {
      const t = el("div", "hb-tslot");
      t.dataset.hb = "throwable";
      t.dataset.id = kind;
      const img = el("img", "hb-ticon");
      img.src = this.icons[kind];
      img.alt = THROWABLES[kind].name;
      const count = el("span", "hb-count", "0");
      t.append(img, count);
      itemsRow.append(t);
      this.tslots[kind] = { slot: t, count, cache: {} };
    }
    const med = el("div", "hb-tslot hb-med");
    med.dataset.hb = "medkit";
    const medIcon = el("img", "hb-medicon-img");
    medIcon.src = this.icons.medkit;
    medIcon.alt = "Medkit";
    const medCount = el("span", "hb-count", "0");
    med.append(medIcon, medCount, el("kbd", "hb-kbd", "H"));
    itemsRow.append(med);
    this.medSlot = { slot: med, count: medCount, cache: {} };
    const bis = el("div", "hb-tslot hb-biscuit");
    bis.dataset.hb = "biscuit";
    const bisIcon = el("img", "hb-ticon");
    bisIcon.src = this.icons.biscuit;
    bisIcon.alt = BISCUIT.name;
    const bisCount = el("span", "hb-count", "0");
    bis.append(bisIcon, bisCount);
    itemsRow.append(bis);
    this.bisSlot = { slot: bis, count: bisCount, cache: {} };
    const fuel = el("div", "hb-tslot hb-fuel");
    fuel.dataset.hb = "fuel";
    const fuelIcon = el("img", "hb-ticon");
    fuelIcon.src = this.icons.fuel;
    fuelIcon.alt = FUEL_CAN.name;
    const fuelCount = el("span", "hb-count", "0");
    fuel.append(fuelIcon, fuelCount, el("kbd", "hb-kbd", "T"));
    itemsRow.append(fuel);
    this.fuelSlot = { slot: fuel, count: fuelCount, cache: {} };

    const hints = el("div", "hb-hints");
    hints.innerHTML = "<kbd>G</kbd> throw <kbd>Q</kbd> switch <kbd>Tab</kbd> inventory";

    // Wallet: rupees for the dukaan
    const wallet = el("div", "hb-wallet");
    wallet.innerHTML = `<img class="hb-ticon" alt="" src="${this.icons.cash}"><b>₹0</b>`;
    itemsRow.append(wallet);
    this.wallet = { value: wallet.querySelector("b"), cache: {} };

    root.append(weaponsRow, itemsRow, hints);
  }

  /** Call every frame; only touches the DOM when the inventory changed. */
  update() {
    const inv = this.inv;
    if (inv.version === this._ver) return;
    this._ver = inv.version;

    for (const id of WEAPON_ORDER) {
      const s = this.slots[id];
      const w = inv.weapons[id];
      setClass(s.slot, s.cache, "owned", "owned", !!w);
      setClass(s.slot, s.cache, "eq", "equipped", inv.current === id);
      setText(s.ammo, s.cache, "ammo", w ? `${w.ammo}/${fmtReserve(w.reserve)}` : "");
      setClass(s.slot, s.cache, "dry", "dry", !!w && w.ammo === 0 && w.reserve === 0);
    }
    for (const kind of THROWABLE_ORDER) {
      const s = this.tslots[kind];
      const n = inv.throwables[kind];
      setText(s.count, s.cache, "n", `${n}`);
      setClass(s.slot, s.cache, "sel", "selected", inv.selectedThrowable === kind);
      setClass(s.slot, s.cache, "empty", "empty", n === 0);
    }
    this._updateGear();
    setText(this.medSlot.count, this.medSlot.cache, "n", `${inv.medkits}`);
    setClass(this.medSlot.slot, this.medSlot.cache, "empty", "empty", inv.medkits === 0);
    setText(this.bisSlot.count, this.bisSlot.cache, "n", `${inv.biscuits}`);
    setClass(this.bisSlot.slot, this.bisSlot.cache, "empty", "empty", inv.biscuits === 0);
    setText(this.wallet.value, this.wallet.cache, "v", `₹${inv.cash.toLocaleString("en-IN")}`);
    setText(this.fuelSlot.count, this.fuelSlot.cache, "n", `${inv.fuelCans}`);
    setClass(this.fuelSlot.slot, this.fuelSlot.cache, "empty", "empty", inv.fuelCans === 0);

  }

  /** Helmet / vest / backpack chips under the health card, with armor durability. */
  _updateGear() {
    if (!this.gearEl) return;
    let sig = "", html = "";
    for (const slot of ["helmet", "vest", "backpack"]) {
      const p = this.inv.gear[slot];
      if (!p) continue;
      const g = GEAR[p.id];
      const pct = g.durability ? Math.round((p.dur / g.durability) * 100) : null;
      sig += `${p.id}:${pct};`;
      html += `<span class="gh-chip lv${g.level}${pct !== null && pct < 30 ? " low" : ""}" title="${g.name}">
        <img src="${this.icons[p.id] ?? ""}" alt=""><b>${g.level}</b>${pct !== null ? `<i style="--d:${pct}%"></i>` : ""}</span>`;
    }
    if (sig === this._gearSig) return;
    this._gearSig = sig;
    this.gearEl.innerHTML = html;
  }

  // ── Prompt + feed ───────────────────────────────────────────────────────────

  /**
   * rows: flat list [key, text, key, text, …] (reused by the caller, so no
   * allocation per frame). Rebuilds the DOM only when the content changes.
   */
  setPrompts(rows, count) {
    let sig = "";
    for (let i = 0; i < count; i++) sig += rows[i] + "|";
    if (sig === this._prompt) return;
    this._prompt = sig;
    this.promptEl.replaceChildren();
    for (let i = 0; i < count; i += 2) {
      const row = el("div", "prompt-row");
      row.append(el("kbd", null, rows[i]));
      const svg = this.promptIcon?.(rows[i]);
      if (svg) row.insertAdjacentHTML("beforeend", svg);
      row.append(el("span", null, rows[i + 1]));
      this.promptEl.append(row);
    }
    this.promptEl.classList.toggle("visible", count > 0);
  }

  /** kind: "weapon" | "ammo" | "throwable" | "medkit" | "info" — sets the accent colour. */
  feed(msg, kind = "info", icon = null) {
    const item = el("div", `feed-item feed-${kind}`);
    if (icon && this.icons[icon]) {
      const img = el("img", "feed-icon");
      img.src = this.icons[icon];
      item.append(img);
    }
    item.append(el("span", null, msg));
    this.feedEl.prepend(item);
    while (this.feedEl.children.length > 5) this.feedEl.lastChild.remove();
    setTimeout(() => item.remove(), FEED_LIFE);
  }
}
