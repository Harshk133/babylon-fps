import { WEAPONS, WEAPON_ORDER, THROWABLES, THROWABLE_ORDER, FUEL_CAN, TOOLKIT, BISCUIT, GEAR } from "../combat/weapons.js";

import { fmtMoney } from "../economy/Currency.js";

const FEED_LIFE = 2600; // ms
const PROMPT_STRIDE = 6; // setPrompts rows: key label, action, detail, icon, progress, key code (sent by a tap)
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
    this.kbd = {};
    med.append(medIcon, medCount, this.kbd.heal = el("kbd", "hb-kbd", "H"));
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
    fuel.append(fuelIcon, fuelCount, this.kbd.refuel = el("kbd", "hb-kbd", "T"));
    itemsRow.append(fuel);
    this.fuelSlot = { slot: fuel, count: fuelCount, cache: {} };
    const kit = el("div", "hb-tslot hb-fuel");
    kit.dataset.hb = "toolkit";
    const kitIcon = el("img", "hb-ticon");
    kitIcon.src = this.icons.toolkit;
    kitIcon.alt = TOOLKIT.name;
    const kitCount = el("span", "hb-count", "0");
    kit.append(kitIcon, kitCount, this.kbd.repair = el("kbd", "hb-kbd", "K"));
    itemsRow.append(kit);
    this.kitSlot = { slot: kit, count: kitCount, cache: {} };

    const hints = el("div", "hb-hints no-throw");
    hints.innerHTML = `<span class="hb-hint-throw"><kbd>G</kbd> throw <kbd>Q</kbd> switch </span><kbd>Tab</kbd> inventory`;
    this.hints = { el: hints, cache: {} };

    // Wallet: Taara for the dukaan
    const wallet = el("div", "hb-wallet empty");
    wallet.innerHTML = `<img class="hb-ticon" alt="" src="${this.icons.cash}"><b>${fmtMoney(0)}</b>`;
    itemsRow.append(wallet);
    this.wallet = { el: wallet, value: wallet.querySelector("b"), cache: {} };

    root.append(weaponsRow, itemsRow, hints);
  }

  /** The keys shown on the hotbar, from the current bindings: label(id) → "H". */
  setKeyLabels(label) {
    for (const [id, node] of Object.entries(this.kbd)) node.textContent = label(id);
    this.hints.el.innerHTML = `<span class="hb-hint-throw"><kbd>${label("throw")}</kbd> throw <kbd>${label("cycleThrow")}</kbd> switch </span><kbd>${label("inventory")}</kbd> inventory`;
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
    let anyThrowable = false;
    for (const kind of THROWABLE_ORDER) {
      const s = this.tslots[kind];
      const n = inv.throwables[kind];
      anyThrowable ||= n > 0;
      setText(s.count, s.cache, "n", `${n}`);
      setClass(s.slot, s.cache, "sel", "selected", inv.selectedThrowable === kind);
      setClass(s.slot, s.cache, "empty", "empty", n === 0);
    }
    setClass(this.hints.el, this.hints.cache, "nt", "no-throw", !anyThrowable);
    this._updateGear();
    setText(this.medSlot.count, this.medSlot.cache, "n", `${inv.medkits}`);
    setClass(this.medSlot.slot, this.medSlot.cache, "empty", "empty", inv.medkits === 0);
    setText(this.bisSlot.count, this.bisSlot.cache, "n", `${inv.biscuits}`);
    setClass(this.bisSlot.slot, this.bisSlot.cache, "empty", "empty", inv.biscuits === 0);
    setText(this.wallet.value, this.wallet.cache, "v", fmtMoney(inv.cash));
    setClass(this.wallet.el, this.wallet.cache, "empty", "empty", inv.cash <= 0);
    setText(this.fuelSlot.count, this.fuelSlot.cache, "n", `${inv.fuelCans}`);
    setClass(this.fuelSlot.slot, this.fuelSlot.cache, "empty", "empty", inv.fuelCans === 0);
    setText(this.kitSlot.count, this.kitSlot.cache, "n", `${inv.toolkits}`);
    setClass(this.kitSlot.slot, this.kitSlot.cache, "empty", "empty", inv.toolkits === 0);

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
   * rows: flat list of [key label, action, detail, icon, progress, code] (progress
   * 0..1, or -1 for no bar; code: the key a tap on the row presses), reused by the caller, so nothing is allocated per
   * frame. The rows are rebuilt (and slide in) only when what they say
   * changes; a moving bar (a crate taking hits, the petrol gauge) is written
   * in place.
   */
  setPrompts(rows, count) {
    const prev = this._rows ??= [];
    let same = count === this._count;
    for (let i = 0; same && i < count; i++) {
      if (i % PROMPT_STRIDE !== 4 && rows[i] !== prev[i]) same = false;
    }
    if (same) {
      for (let i = 4, r = 0; i < count; i += PROMPT_STRIDE, r++) {
        if (rows[i] === prev[i]) continue;
        prev[i] = rows[i];
        const fill = this._bars[r];
        if (fill) fill.style.transform = `scaleX(${Math.max(0, Math.min(1, rows[i]))})`;
      }
      return;
    }
    for (let i = 0; i < count; i++) prev[i] = rows[i];
    this._count = count;
    this._bars = [];
    this.promptEl.replaceChildren();
    for (let i = 0, r = 0; i < count; i += PROMPT_STRIDE, r++) {
      const [key, action, detail, iconName, progress] = [rows[i], rows[i + 1], rows[i + 2], rows[i + 3], rows[i + 4]];
      const row = el("div", r === 0 ? "prompt-row primary" : "prompt-row");
      row.style.setProperty("--i", r);
      const k = el("kbd", key.length > 1 ? "wide" : null, key);
      if (rows[i + 5]) k.dataset.code = rows[i + 5];
      row.append(k);
      const svg = this.promptIcon?.(iconName || key);
      if (svg) {
        const ico = el("span", "prompt-ico");
        ico.innerHTML = svg;
        row.append(ico);
      }
      const text = el("span", "prompt-text");
      text.append(el("span", "prompt-act", action));
      if (detail) text.append(el("span", "prompt-sub", detail));
      if (progress >= 0) {
        const bar = el("span", "prompt-bar");
        const fill = el("i");
        fill.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`;
        bar.append(fill);
        text.append(bar);
        this._bars[r] = fill;
      }
      row.append(text);
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
