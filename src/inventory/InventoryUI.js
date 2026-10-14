import { WEAPONS, WEAPON_ORDER, THROWABLES, THROWABLE_ORDER, MEDKIT } from "../combat/weapons.js";

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
 * DOM for everything inventory-related: the always-on hotbar, the pickup
 * prompt, the pickup feed, and the full inventory screen (Tab).
 */
export class InventoryUI {
  constructor({ inventory, icons, onEquip, onDrop, onSelectThrowable, onUseMedkit, onClose }) {
    this.inv = inventory;
    this.icons = icons;
    this.cb = { onEquip, onDrop, onSelectThrowable, onUseMedkit, onClose };
    this._ver = -1;
    this._panelVer = -1;
    this.open = false;

    this.promptEl = document.getElementById("pickup-prompt");
    this.feedEl = document.getElementById("pickup-feed");
    this.panelEl = document.getElementById("inventory");
    this._prompt = null;

    this._buildHotbar(document.getElementById("hotbar"));
    this._buildPanel();
  }

  // ── Hotbar ──────────────────────────────────────────────────────────────────

  _buildHotbar(root) {
    const weaponsRow = el("div", "hb-weapons");
    this.slots = {};
    for (const id of WEAPON_ORDER) {
      const def = WEAPONS[id];
      const slot = el("div", "hb-slot");
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
      const img = el("img", "hb-ticon");
      img.src = this.icons[kind];
      img.alt = THROWABLES[kind].name;
      const count = el("span", "hb-count", "0");
      t.append(img, count);
      itemsRow.append(t);
      this.tslots[kind] = { slot: t, count, cache: {} };
    }
    const med = el("div", "hb-tslot hb-med");
    const medIcon = el("span", "hb-medicon", "+");
    const medCount = el("span", "hb-count", "0");
    med.append(medIcon, medCount, el("kbd", "hb-kbd", "H"));
    itemsRow.append(med);
    this.medSlot = { slot: med, count: medCount, cache: {} };

    const hints = el("div", "hb-hints");
    hints.innerHTML = "<kbd>G</kbd> throw <kbd>Q</kbd> switch <kbd>Tab</kbd> inventory";

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
    setText(this.medSlot.count, this.medSlot.cache, "n", `${inv.medkits}`);
    setClass(this.medSlot.slot, this.medSlot.cache, "empty", "empty", inv.medkits === 0);

    if (this.open) this._renderPanel();
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
      row.append(el("kbd", null, rows[i]), el("span", null, rows[i + 1]));
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

  // ── Inventory screen ────────────────────────────────────────────────────────

  _buildPanel() {
    const p = this.panelEl;
    p.innerHTML = `
      <div class="inv-panel" role="dialog" aria-label="Inventory">
        <header class="inv-head">
          <h2>INVENTORY</h2>
          <span class="inv-hint"><kbd>Tab</kbd> or <kbd>Esc</kbd> to close</span>
        </header>
        <h3 class="inv-section">WEAPONS</h3>
        <div class="inv-weapons"></div>
        <h3 class="inv-section">EQUIPMENT</h3>
        <div class="inv-items"></div>
      </div>`;
    this.weaponsEl = p.querySelector(".inv-weapons");
    this.itemsEl = p.querySelector(".inv-items");
    // Clicking the dimmed backdrop closes the screen
    p.addEventListener("mousedown", e => { if (e.target === p) this.cb.onClose(); });
    p.addEventListener("click", e => {
      const btn = e.target.closest("button[data-act]");
      if (!btn || btn.disabled) return;
      const { act, id } = btn.dataset;
      if (act === "equip") this.cb.onEquip(id);
      else if (act === "drop") this.cb.onDrop(id);
      else if (act === "select") this.cb.onSelectThrowable(id);
      else if (act === "medkit") this.cb.onUseMedkit();
    });
  }

  setOpen(open) {
    this.open = open;
    this.panelEl.classList.toggle("visible", open);
    if (open) this._renderPanel();
  }

  _statBar(label, v) {
    const pct = Math.round(Math.max(0.04, Math.min(1, v)) * 100);
    return `<div class="stat"><span>${label}</span><div class="stat-bar"><i style="width:${pct}%"></i></div></div>`;
  }

  _renderPanel() {
    const inv = this.inv;
    if (this._panelVer === inv.version) return;
    this._panelVer = inv.version;
    const canDrop = inv.ownedWeapons.length > 1;

    this.weaponsEl.innerHTML = WEAPON_ORDER.map(id => {
      const d = WEAPONS[id];
      const w = inv.weapons[id];
      const eq = inv.current === id;
      const stats =
        this._statBar("Damage", (d.damage * d.pellets) / 160) +
        this._statBar("Fire rate", d.fireRate / 11) +
        this._statBar("Accuracy", 1 - (d.spreadHip + d.spreadAim) / 0.13) +
        this._statBar("Range", d.range / 300);
      if (!w) {
        return `
          <div class="inv-card locked">
            <div class="card-top"><span class="card-key">${d.slot}</span><span class="card-name">${d.name}</span></div>
            <img class="card-icon" src="${this.icons[id]}" alt="">
            <div class="card-ammo">Not found yet</div>
            <div class="stats">${stats}</div>
          </div>`;
      }
      return `
        <div class="inv-card${eq ? " equipped" : ""}">
          <div class="card-top">
            <span class="card-key">${d.slot}</span><span class="card-name">${d.name}</span>
            ${eq ? '<span class="card-badge">EQUIPPED</span>' : ""}
          </div>
          <img class="card-icon" src="${this.icons[id]}" alt="">
          <div class="card-ammo"><b>${w.ammo}</b> / ${fmtReserve(w.reserve)} <small>${d.auto ? "AUTO" : "SEMI"} · ${d.magSize} RND</small></div>
          <div class="stats">${stats}</div>
          <div class="card-actions">
            <button data-act="equip" data-id="${id}" ${eq ? "disabled" : ""}>${eq ? "In hand" : "Equip"}</button>
            <button data-act="drop" data-id="${id}" class="ghost" ${canDrop ? "" : "disabled"}>Drop</button>
          </div>
        </div>`;
    }).join("");

    const throwCards = THROWABLE_ORDER.map(kind => {
      const t = THROWABLES[kind];
      const n = inv.throwables[kind];
      const sel = inv.selectedThrowable === kind;
      const desc = kind === "grenade"
        ? "Bounces, explodes after 2 s. Huge blast radius."
        : "Shatters on impact. Burns the area for 8 s.";
      return `
        <div class="inv-card item${sel ? " equipped" : ""}">
          <div class="card-top"><span class="card-name">${t.name}</span>${sel ? '<span class="card-badge">READY</span>' : ""}</div>
          <img class="card-icon small" src="${this.icons[kind]}" alt="">
          <div class="card-count"><b>${n}</b> / ${t.max}</div>
          <p class="card-desc">${desc}</p>
          <div class="card-actions">
            <button data-act="select" data-id="${kind}" ${sel ? "disabled" : ""}>${sel ? "Selected" : "Select"}</button>
          </div>
        </div>`;
    }).join("");

    const medCard = `
      <div class="inv-card item">
        <div class="card-top"><span class="card-name">${MEDKIT.name}</span></div>
        <div class="card-icon medkit-icon">+</div>
        <div class="card-count"><b>${inv.medkits}</b> / ${MEDKIT.max}</div>
        <p class="card-desc">Restores ${MEDKIT.heal} health. Press <kbd>H</kbd> in game.</p>
        <div class="card-actions">
          <button data-act="medkit" ${inv.medkits > 0 ? "" : "disabled"}>Use</button>
        </div>
      </div>`;

    this.itemsEl.innerHTML = throwCards + medCard;
  }
}
