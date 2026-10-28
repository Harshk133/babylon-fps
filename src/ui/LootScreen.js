// The inventory screen (Tab), laid out like PUBG / BGMI: what's on the ground
// around you, your backpack, your character with the gear you wear, and your
// guns with their attachment slots. Items move by drag and drop (pointer
// events, so mouse and touch both work), double-click, or a right-click menu.
//
// It never edits the inventory itself: every transfer goes through
// LootActions (validated, all-or-nothing), and the panels are re-drawn from
// the real state only when it changes (inventory.version / the loot in reach).

import { WEAPONS, WEAPON_ORDER, THROWABLE_ORDER, ATTACH_SLOT_NAMES, GEAR, GEAR_SLOTS, ATTACHMENTS } from "../combat/weapons.js";
import { ITEMS, GROUPS, RARITY_COLOR, attachSlotsFor, weaponStats } from "../items/ItemDefs.js";
import { CharacterPreview } from "./CharacterPreview.js";
import "./loot-screen.css";

const DRAG_START = 6;          // px the pointer moves before a press becomes a drag
const LOOT_REFRESH = 0.15;     // s between vicinity scans
const GEAR_LABEL = { helmet: "Helmet", vest: "Vest", backpack: "Backpack" };
const fmtReserve = r => (r === Infinity ? "∞" : `${r}`);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export class LootScreen {
  /**
   * root: the #inventory element. actions: LootActions. icons: kind → image URL.
   * cb: { onUse(kind), onSelectThrowable(kind) }.
   */
  constructor({ root, inventory, actions, icons, cb }) {
    this.root = root;
    this.inv = inventory;
    this.actions = actions;
    this.icons = icons;
    this.cb = cb;
    this.open = false;
    this._ver = -1;
    this._lootSig = "";
    this._lootT = 0;
    this._loot = new Map();   // uid → entry (rows currently shown)
    this._drag = null;
    this._press = null;

    root.innerHTML = `
      <div class="ls" role="dialog" aria-label="Inventory">
        <section class="ls-col ls-vicinity" data-drop="ground">
          <header class="ls-head"><h2>Vicinity</h2><span class="ls-sub" data-ref="lootCount"></span></header>
          <div class="ls-list" data-ref="loot"></div>
          <div class="ls-dropzone">Drop on the ground</div>
        </section>
        <section class="ls-col ls-bag" data-drop="bag">
          <header class="ls-head"><h2>Backpack</h2><span class="ls-cap" data-ref="cap"></span></header>
          <div class="ls-capbar"><i data-ref="capFill"></i></div>
          <div class="ls-list" data-ref="bag"></div>
        </section>
        <section class="ls-center">
          <div class="ls-gear" data-ref="gear"></div>
          <canvas class="ls-char" aria-label="Your character: drag to turn"></canvas>
          <div class="ls-turn">Drag to turn</div>
        </section>
        <section class="ls-col ls-weapons">
          <header class="ls-head"><h2>Weapons</h2><span class="ls-sub" data-ref="gunCount"></span></header>
          <div class="ls-guns" data-ref="guns"></div>
        </section>
        <footer class="ls-hints">
          <span><b>Drag</b> to pick up, equip, attach or drop</span>
          <span><b>Double-click</b> quick action</span>
          <span><b>Right-click</b> more</span>
          <span><b>Shift</b>-drag a stack to choose how many</span>
          <span><kbd>Tab</kbd> / <kbd>Esc</kbd> close</span>
        </footer>
        <div class="ls-toast" data-ref="toast" role="status"></div>
        <div class="ls-menu" data-ref="menu" hidden></div>
        <div class="ls-modal" data-ref="modal" hidden></div>
      </div>`;
    this.el = {};
    for (const n of root.querySelectorAll("[data-ref]")) this.el[n.dataset.ref] = n;
    this.preview = new CharacterPreview(root.querySelector(".ls-char"));

    // One set of listeners for the whole screen (rows are re-drawn, listeners aren't)
    root.addEventListener("pointerdown", e => this._onDown(e));
    root.addEventListener("pointermove", e => this._onMove(e));
    root.addEventListener("pointerup", e => this._onUp(e));
    root.addEventListener("pointercancel", () => this._cancelDrag());
    root.addEventListener("dblclick", e => this._onDouble(e));
    root.addEventListener("contextmenu", e => this._onMenu(e));
    root.addEventListener("click", e => {
      const item = e.target.closest("[data-menu-act]");
      if (item) { this._runMenu(item.dataset.menuAct); return; }
      if (!e.target.closest(".ls-menu")) this._closeMenu();
    });
  }

  /** Loads the 3D preview in the background (the screen works without it). */
  initPreview(loader) {
    return this.preview.init(loader).catch(err => console.warn("Character preview unavailable:", err));
  }

  setOpen(open) {
    this.open = open;
    this.root.classList.toggle("visible", open);
    if (open) {
      this._ver = -1;
      this._lootSig = "";
      this._lootT = 0;
      this.update(0);
    } else {
      this._cancelDrag();
      this._closeMenu();
      this._closeModal();
    }
  }

  /** Esc: closes a menu / dialog first. Returns true if it was used. */
  escape() {
    if (this._drag) { this._cancelDrag(); return true; }
    if (!this.el.menu.hidden) { this._closeMenu(); return true; }
    if (!this.el.modal.hidden) { this._closeModal(); return true; }
    return false;
  }

  /** dt: real seconds. Call every frame while open. */
  update(dt) {
    if (!this.open) return;
    this._lootT -= dt;
    if (this._lootT <= 0) {
      this._lootT = LOOT_REFRESH;
      this._renderLoot();
    }
    if (this.inv.version !== this._ver) {
      this._ver = this.inv.version;
      this._renderBag();
      this._renderGear();
      this._renderGuns();
      if (this._drag) this._markTargets();
    }
    this.preview.sync(this.inv.current, this.inv.gearLevels());
    this.preview.render(dt);
  }

  // ── Panels ──────────────────────────────────────────────────────────────────

  _icon(kind, cls = "ls-ico") {
    const src = this.icons[kind];
    return src ? `<img class="${cls}" src="${src}" alt="" draggable="false">` : `<span class="${cls} ls-ico-none"></span>`;
  }

  _row({ src, kind, name, sub = "", qty = "", tag = "", extra = "", rarity = ITEMS[kind]?.rarity }) {
    return `<div class="ls-row" style="--rar:${RARITY_COLOR[rarity] ?? RARITY_COLOR.common}" ${src} tabindex="0">
      ${this._icon(kind)}
      <span class="ls-name">${esc(name)}${tag ? `<em>${tag}</em>` : ""}${sub ? `<small>${esc(sub)}</small>` : ""}</span>
      ${extra}<span class="ls-qty">${qty}</span>
    </div>`;
  }

  _lootLabel(e) {
    const item = ITEMS[e.kind], d = e.data ?? {};
    switch (e.def.category) {
      case "weapon": {
        const atts = Object.values(d.att ?? {}).filter(Boolean).length;
        return { sub: `${d.ammo ?? 0} / ${fmtReserve(d.reserve ?? 0)} rounds${atts ? ` · ${atts} attachment${atts > 1 ? "s" : ""}` : ""}`, qty: "" };
      }
      case "gear":
        return { sub: GEAR[e.kind].durability ? `Durability ${Math.round(d.dur ?? GEAR[e.kind].durability)} / ${GEAR[e.kind].durability}` : item.desc, qty: "" };
      case "ammo": return { sub: "Ammo for every gun", qty: "" };
      case "cash": return { sub: "Walk over it to pocket it", qty: `₹${(d.count ?? 0).toLocaleString("en-IN")}` };
      default: return { sub: item.type === "attachment" ? ATTACH_SLOT_NAMES[ATTACHMENTS[e.kind].slot] : "", qty: (d.count ?? 1) > 1 ? `×${d.count}` : "" };
    }
  }

  _renderLoot() {
    const list = this.actions.nearby();
    let sig = "";
    for (const e of list) sig += `${e.uid}:${e.data?.count ?? 1},`;
    if (sig === this._lootSig) return;
    this._lootSig = sig;
    this._loot.clear();
    let html = "";
    for (const e of list) {
      this._loot.set(String(e.uid), e);
      const l = this._lootLabel(e);
      html += this._row({ src: `data-src="loot" data-uid="${e.uid}"`, kind: e.kind, name: ITEMS[e.kind]?.name ?? e.def.label, sub: l.sub, qty: l.qty });
    }
    this.el.loot.innerHTML = html || `<p class="ls-empty">Nothing on the ground nearby.<br>Walk up to loot to see it here.</p>`;
    this.el.lootCount.textContent = list.length ? `${list.length}` : "";
    if (this._drag) this._markTargets();
  }

  _renderBag() {
    const inv = this.inv;
    const groups = Object.fromEntries(GROUPS.map(g => [g, []]));
    if (inv.biscuits) groups.Healing.push(this._row({ src: `data-src="bag" data-kind="biscuit"`, kind: "biscuit", name: ITEMS.biscuit.name, sub: "H to eat", qty: `×${inv.biscuits}` }));
    if (inv.medkits) groups.Healing.push(this._row({ src: `data-src="bag" data-kind="medkit"`, kind: "medkit", name: ITEMS.medkit.name, sub: "H to use", qty: `×${inv.medkits}` }));
    for (const k of THROWABLE_ORDER) {
      if (!inv.throwables[k]) continue;
      groups.Throwables.push(this._row({
        src: `data-src="bag" data-kind="${k}"`, kind: k, name: ITEMS[k].name,
        tag: inv.selectedThrowable === k ? "READY" : "", qty: `×${inv.throwables[k]}`,
      }));
    }
    for (const [k, n] of Object.entries(inv.bag)) {
      if (n > 0) groups.Attachments.push(this._row({ src: `data-src="bag" data-kind="${k}"`, kind: k, name: ITEMS[k].name, sub: ATTACH_SLOT_NAMES[ATTACHMENTS[k].slot], qty: n > 1 ? `×${n}` : "" }));
    }
    if (inv.fuelCans) groups.Utility.push(this._row({ src: `data-src="bag" data-kind="fuel"`, kind: "fuel", name: ITEMS.fuel.name, sub: "T next to a vehicle", qty: `×${inv.fuelCans}` }));

    // Ammo rides with each gun; listed here so you can see what you've got
    const ammo = inv.ownedWeapons.map(id => {
      const w = inv.weapons[id];
      return `<div class="ls-row ls-info">${this._icon("ammo")}<span class="ls-name">${WEAPONS[id].short} ammo<small>${w.ammo} loaded</small></span><span class="ls-qty">${fmtReserve(w.reserve)}</span></div>`;
    }).join("");

    let html = "";
    for (const g of GROUPS) if (groups[g].length) html += `<h3 class="ls-group">${g}</h3>${groups[g].join("")}`;
    if (ammo) html += `<h3 class="ls-group">Ammo</h3>${ammo}`;
    this.el.bag.innerHTML = html || `<p class="ls-empty">Your backpack is empty.<br>Drag loot here to pick it up.</p>`;

    const load = inv.load, cap = inv.capacity;
    this.el.cap.innerHTML = `<b>${Math.round(load)}</b> / ${cap}`;
    this.el.cap.classList.toggle("full", load >= cap - 5);
    this.el.capFill.style.width = `${Math.min(100, (load / cap) * 100)}%`;
    this.el.capFill.parentElement.classList.toggle("warn", load / cap > 0.85);
  }

  _renderGear() {
    let html = "";
    for (const slot of GEAR_SLOTS) {
      const piece = this.inv.gear[slot];
      if (!piece) {
        html += `<div class="ls-slot ls-gslot empty" data-drop="gear" data-slot="${slot}"><span class="ls-slot-label">${GEAR_LABEL[slot]}</span></div>`;
        continue;
      }
      const g = GEAR[piece.id];
      const dur = g.durability ? piece.dur / g.durability : null;
      html += `<div class="ls-slot ls-gslot" style="--rar:${RARITY_COLOR[ITEMS[piece.id].rarity]}" data-drop="gear" data-slot="${slot}" data-src="gear" title="${esc(g.name)}">
        ${this._icon(piece.id, "ls-slot-ico")}
        <span class="ls-lv">Lv.${g.level}</span>
        ${dur !== null ? `<span class="ls-dur${dur < 0.3 ? " low" : ""}"><i style="width:${Math.round(dur * 100)}%"></i></span>` : ""}
      </div>`;
    }
    this.el.gear.innerHTML = html;
  }

  _renderGuns() {
    const inv = this.inv;
    const owned = inv.ownedWeapons;
    this.el.gunCount.textContent = `${owned.length} / ${WEAPON_ORDER.length}`;
    if (!owned.length) {
      this.el.guns.innerHTML = `<div class="ls-gun empty" data-drop="weapon" data-id=""><p class="ls-empty">No guns.<br>Drag one here from the vicinity.</p></div>`;
      return;
    }
    this.el.guns.innerHTML = owned.map(id => {
      const w = inv.weapons[id], d = WEAPONS[id], st = weaponStats(id, w.att);
      const slots = attachSlotsFor(id).map(s => {
        const a = w.att[s];
        return a
          ? `<div class="ls-slot ls-aslot" style="--rar:${RARITY_COLOR[ITEMS[a].rarity]}" data-drop="att" data-weapon="${id}" data-slot="${s}" data-src="att" title="${esc(ITEMS[a].name)}">${this._icon(a, "ls-slot-ico")}</div>`
          : `<div class="ls-slot ls-aslot empty" data-drop="att" data-weapon="${id}" data-slot="${s}"><span class="ls-slot-label">${ATTACH_SLOT_NAMES[s]}</span></div>`;
      }).join("");
      return `<div class="ls-gun${inv.current === id ? " held" : ""}" style="--rar:${RARITY_COLOR[ITEMS[id].rarity]}" data-drop="weapon" data-id="${id}" data-src="weapon">
        <div class="ls-gun-top"><span class="ls-key">${d.slot}</span><span class="ls-gun-name">${esc(d.name)}</span>${inv.current === id ? "<em>IN HANDS</em>" : ""}</div>
        ${this._icon(id, "ls-gun-ico")}
        <div class="ls-gun-ammo"><b>${w.ammo}</b><span>/ ${st.magSize}</span><span class="ls-res">${fmtReserve(w.reserve)} spare</span>${st.suppressed ? '<span class="ls-badge">SUPPRESSED</span>' : ""}</div>
        <div class="ls-aslots">${slots}</div>
      </div>`;
    }).join("");
  }

  // ── Sources & targets ───────────────────────────────────────────────────────

  _src(node) {
    const d = node.dataset;
    switch (d.src) {
      case "loot": { const entry = this._loot.get(d.uid); return entry ? { from: "loot", entry, uid: entry.uid } : null; }
      case "bag": return { from: "bag", kind: d.kind };
      case "weapon": return { from: "weapon", id: d.id };
      case "att": return { from: "att", weapon: d.weapon, slot: d.slot };
      case "gear": return { from: "gear", slot: d.slot };
    }
    return null;
  }

  _dst(node) {
    const d = node.dataset;
    switch (d.drop) {
      case "ground": return { to: "ground" };
      case "bag": return { to: "bag" };
      case "weapon": return d.id ? { to: "weapon", id: d.id } : { to: "bag" };
      case "att": return { to: "att", weapon: d.weapon, slot: d.slot };
      case "gear": return { to: "gear", slot: d.slot };
    }
    return null;
  }

  /** What a source shows on the drag ghost: { kind, name, qty, stack }. */
  _describe(src) {
    const inv = this.inv;
    switch (src.from) {
      case "loot": return { kind: src.entry.kind, name: ITEMS[src.entry.kind]?.name, qty: src.entry.data?.count ?? 1, stack: ITEMS[src.entry.kind]?.stackable };
      case "bag": return { kind: src.kind, name: ITEMS[src.kind].name, qty: inv.count(src.kind), stack: true };
      case "weapon": return { kind: src.id, name: WEAPONS[src.id].name, qty: 1 };
      case "att": { const id = inv.weapons[src.weapon]?.att[src.slot]; return { kind: id, name: ITEMS[id]?.name, qty: 1 }; }
      case "gear": { const id = inv.gear[src.slot]?.id; return { kind: id, name: ITEMS[id]?.name, qty: 1 }; }
    }
    return {};
  }

  // ── Drag and drop ───────────────────────────────────────────────────────────

  _onDown(e) {
    if (e.button !== 0) return;
    if (!e.target.closest(".ls-menu")) this._closeMenu();
    const node = e.target.closest("[data-src]");
    if (!node || e.target.closest(".ls-char")) return;
    this._press = { node, x: e.clientX, y: e.clientY, id: e.pointerId, shift: e.shiftKey || e.ctrlKey };
  }

  _onMove(e) {
    const p = this._press;
    if (p && !this._drag && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_START) this._startDrag(p, e);
    if (!this._drag) return;
    const g = this._drag.ghost;
    g.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop]") ?? null;
    if (over !== this._drag.over) {
      this._drag.over?.classList.remove("over");
      this._drag.over = over;
      over?.classList.add("over");
      const res = over ? this._drag.results.get(over) : null;
      g.dataset.hint = res ? (res.ok ? MODE_LABEL[res.mode] ?? "" : res.msg ?? "") : "";
      g.classList.toggle("bad", !!res && !res.ok);
    }
  }

  _startDrag(p, e) {
    const src = this._src(p.node);
    if (!src) { this._press = null; return; }
    const desc = this._describe(src);
    if (!desc.kind) { this._press = null; return; }
    const ghost = document.createElement("div");
    ghost.className = "ls-ghost";
    ghost.innerHTML = `${this._icon(desc.kind)}<span>${esc(desc.name)}</span>${desc.qty > 1 ? `<b>×${desc.qty}</b>` : ""}`;
    ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
    this.root.querySelector(".ls").append(ghost);
    p.node.classList.add("lifted");
    try { this.root.setPointerCapture(p.id); } catch { /* touch already released */ }
    this._drag = { src, desc, ghost, node: p.node, shift: p.shift, over: null, results: new Map(), from: p.node.getBoundingClientRect() };
    this.root.querySelector(".ls").classList.add("dragging", `drag-${src.from}`);
    this._markTargets();
  }

  /** Marks every drop target valid / invalid (and swap / merge) for the dragged item. */
  _markTargets() {
    const d = this._drag;
    d.results.clear();
    for (const t of this.root.querySelectorAll("[data-drop]")) {
      t.classList.remove("ok", "bad", "swap", "merge", "over");
      const dst = this._dst(t);
      if (!dst) continue;
      const res = this.actions.check(d.src, dst);
      d.results.set(t, res);
      if (res.ok) t.classList.add("ok", ...(res.mode === "swap" ? ["swap"] : res.mode === "merge" ? ["merge"] : []));
      else if (res.msg) t.classList.add("bad");
    }
    if (d.over && this.root.contains(d.over)) d.over.classList.add("over");
  }

  async _onUp(e) {
    const p = this._press;
    this._press = null;
    const d = this._drag;
    if (!d) return;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop]");
    const dst = over ? this._dst(over) : null;
    this._endDrag(false);
    if (!dst) { this._flyBack(d); return; }
    const check = this.actions.check(d.src, dst);
    if (!check.ok) {
      this._flyBack(d);
      if (check.msg) this.toast(check.msg, true);
      return;
    }
    let qty = Infinity;
    if (d.shift && d.desc.stack && d.desc.qty > 1) {
      qty = await this._askQty(`${check.mode === "drop" ? "Drop" : "Take"} how many ${d.desc.name}?`, d.desc.qty);
      if (!qty) { this._flyBack(d); return; }
      if (!this.actions.check(d.src, dst).ok) { this._flyBack(d); return; } // changed while the dialog was up
    }
    const res = this.actions.move(d.src, dst, qty);
    if (res.ok) {
      d.ghost.classList.add("gone");
      setTimeout(() => d.ghost.remove(), 200);
    } else this._flyBack(d);
    this._finish(res, over);
  }

  _finish(res, target = null) {
    if (res.msg) this.toast(res.msg, !res.ok);
    if (res.ok && target) {
      target.classList.remove("flash");
      void target.offsetWidth;
      target.classList.add("flash");
    }
    this._lootSig = ""; // the ground changed: rescan now
    this._lootT = 0;
  }

  _endDrag() {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    d.node.classList.remove("lifted");
    const ls = this.root.querySelector(".ls");
    ls.classList.remove("dragging", "drag-loot", "drag-bag", "drag-weapon", "drag-att", "drag-gear");
    for (const t of this.root.querySelectorAll("[data-drop]")) t.classList.remove("ok", "bad", "swap", "merge", "over");
  }

  /** Failed drop: the ghost slides back to where it came from. */
  _flyBack(d) {
    const g = d.ghost;
    g.classList.add("back");
    g.style.transform = `translate(${d.from.left}px, ${d.from.top}px)`;
    setTimeout(() => g.remove(), 220);
  }

  _cancelDrag() {
    const d = this._drag;
    this._press = null;
    if (!d) return;
    this._endDrag();
    this._flyBack(d);
  }

  // ── Double-click: the obvious action ────────────────────────────────────────

  _onDouble(e) {
    const node = e.target.closest("[data-src]");
    const src = node && this._src(node);
    if (!src) return;
    const inv = this.inv;
    let res = { ok: false, msg: null };
    switch (src.from) {
      case "loot": res = this.actions.pickup(src.entry, { uid: src.uid, equip: true }); break;
      case "bag":
        if (src.kind === "medkit" || src.kind === "biscuit") { this.cb.onUse(src.kind); return; }
        if (src.kind === "fuel") { this.cb.onUse("fuel"); return; }
        if (THROWABLE_ORDER.includes(src.kind)) { this.cb.onSelectThrowable(src.kind); return; }
        if (ATTACHMENTS[src.kind]) {
          const w = [inv.current, ...inv.ownedWeapons].find(id => id && inv.canAttach(id, src.kind));
          res = w ? this.actions.move(src, { to: "weapon", id: w }) : { ok: false, msg: "None of your guns takes that" };
        }
        break;
      case "weapon": res = this.actions.equipWeapon(src.id); break;
      case "att": res = this.actions.move(src, { to: "bag" }); break;
      case "gear": return;
    }
    this._finish(res, node);
  }

  // ── Right-click menu ────────────────────────────────────────────────────────

  _onMenu(e) {
    e.preventDefault();
    const node = e.target.closest("[data-src]");
    const src = node && this._src(node);
    if (!src) { this._closeMenu(); return; }
    const inv = this.inv, items = [];
    const desc = this._describe(src);
    switch (src.from) {
      case "loot": {
        const cat = src.entry.def.category;
        items.push(["take", cat === "gear" ? "Equip" : cat === "weapon" && !inv.has(src.entry.kind) ? "Pick up & equip" : "Pick up"]);
        if (desc.stack && desc.qty > 1) items.push(["takeSome", "Pick up some…"]);
        break;
      }
      case "bag":
        if (src.kind === "medkit") items.push(["use", "Use"]);
        if (src.kind === "biscuit") items.push(["use", "Eat"]);
        if (src.kind === "fuel") items.push(["use", "Fill the rickshaw"]);
        if (THROWABLE_ORDER.includes(src.kind) && inv.selectedThrowable !== src.kind) items.push(["select", "Ready to throw"]);
        if (ATTACHMENTS[src.kind]) for (const w of inv.ownedWeapons) if (inv.canAttach(w, src.kind)) items.push([`attach:${w}`, `Attach to ${WEAPONS[w].short}`]);
        items.push(["drop", "Drop"]);
        if (desc.qty > 1) items.push(["dropSome", "Drop some…"]);
        break;
      case "weapon":
        if (inv.current !== src.id) items.push(["equip", "Equip"]);
        items.push(["drop", "Drop"]);
        break;
      case "att":
        items.push(["detach", "Move to backpack"], ["drop", "Drop"]);
        break;
      case "gear":
        items.push(["drop", "Drop"]);
        break;
    }
    items.push(["inspect", "Inspect"]);
    this._menuSrc = { src, node };
    const m = this.el.menu;
    m.innerHTML = `<div class="ls-menu-title">${this._icon(desc.kind)}${esc(desc.name ?? "")}</div>` +
      items.map(([act, label]) => `<button data-menu-act="${act}">${label}</button>`).join("");
    m.hidden = false;
    const r = this.root.getBoundingClientRect();
    m.style.left = `${Math.min(e.clientX, r.right - m.offsetWidth - 8)}px`;
    m.style.top = `${Math.min(e.clientY, r.bottom - m.offsetHeight - 8)}px`;
  }

  async _runMenu(act) {
    const ctx = this._menuSrc;
    this._closeMenu();
    if (!ctx) return;
    const { src, node } = ctx;
    const desc = this._describe(src);
    let res = { ok: false, msg: null };
    if (act === "inspect") { this._inspect(src, desc); return; }
    if (act === "use") { this.cb.onUse(src.kind); return; }
    if (act === "select") { this.cb.onSelectThrowable(src.kind); return; }
    if (act === "take") res = this.actions.pickup(src.entry, { uid: src.uid, equip: true });
    else if (act === "takeSome") {
      const n = await this._askQty(`Pick up how many ${desc.name}?`, desc.qty);
      if (!n) return;
      res = this.actions.pickup(src.entry, { uid: src.uid, qty: n, dst: { to: "bag" } });
    } else if (act === "drop") res = this.actions.move(src, { to: "ground" });
    else if (act === "dropSome") {
      const n = await this._askQty(`Drop how many ${desc.name}?`, desc.qty);
      if (!n) return;
      res = this.actions.move(src, { to: "ground" }, n);
    } else if (act === "equip") res = this.actions.equipWeapon(src.id);
    else if (act === "detach") res = this.actions.move(src, { to: "bag" });
    else if (act.startsWith("attach:")) res = this.actions.move(src, { to: "weapon", id: act.slice(7) });
    this._finish(res, node);
  }

  _closeMenu() {
    this.el.menu.hidden = true;
    this._menuSrc = null;
  }

  // ── Dialogs: how many, inspect ──────────────────────────────────────────────

  /** Resolves to a number 1..max, or 0 if cancelled. */
  _askQty(title, max) {
    return new Promise(resolve => {
      const m = this.el.modal;
      const start = Math.max(1, Math.floor(max / 2));
      m.innerHTML = `<div class="ls-dialog">
        <h3>${esc(title)}</h3>
        <div class="ls-qty-row"><input type="range" min="1" max="${max}" value="${start}"><output>${start}</output></div>
        <div class="ls-dialog-btns"><button data-q="cancel" class="ghost">Cancel</button><button data-q="all" class="ghost">All (${max})</button><button data-q="ok">Confirm</button></div>
      </div>`;
      m.hidden = false;
      const range = m.querySelector("input"), out = m.querySelector("output");
      range.addEventListener("input", () => { out.textContent = range.value; });
      const done = v => { this._modalCancel = null; this._closeModal(); resolve(v); };
      this._modalCancel = () => resolve(0);
      m.querySelector(".ls-dialog-btns").addEventListener("click", e => {
        const q = e.target.dataset.q;
        if (q === "ok") done(+range.value);
        else if (q === "all") done(max);
        else if (q === "cancel") done(0);
      });
      range.focus();
    });
  }

  _inspect(src, desc) {
    const item = ITEMS[desc.kind];
    if (!item) return;
    const inv = this.inv, lines = [];
    lines.push(["Type", item.type === "gear" ? `${GEAR_LABEL[item.equipmentSlot]} · Level ${item.level}` : item.type[0].toUpperCase() + item.type.slice(1)]);
    if (item.weight) lines.push(["Weight", `${item.weight}${item.stackable ? " each" : ""}`]);
    if (item.maxStack > 1 && item.maxStack < 99) lines.push(["Carry up to", `${item.maxStack}`]);
    if (src.from === "gear") lines.push(["Durability", `${Math.round(inv.gear[src.slot].dur)} / ${GEAR[desc.kind].durability ?? "—"}`]);
    if (item.type === "weapon") {
      const w = src.from === "weapon" ? inv.weapons[src.id] : src.entry?.data;
      const st = weaponStats(desc.kind, w?.att);
      lines.push(["Damage", `${st.damage}${st.pellets > 1 ? ` × ${st.pellets}` : ""}`], ["Fire rate", `${st.fireRate}/s`], ["Magazine", `${st.magSize}`], ["Range", `${st.range} m`]);
      const atts = Object.values(w?.att ?? {}).filter(Boolean).map(a => ITEMS[a].name);
      if (atts.length) lines.push(["Attachments", atts.join(", ")]);
    }
    const m = this.el.modal;
    m.innerHTML = `<div class="ls-dialog ls-inspect" style="--rar:${RARITY_COLOR[item.rarity]}">
      <div class="ls-inspect-head">${this._icon(desc.kind, "ls-inspect-ico")}<div><h3>${esc(item.name)}</h3><span class="ls-rarity">${item.rarity}</span></div></div>
      <p>${esc(item.desc ?? "")}</p>
      <dl>${lines.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <div class="ls-dialog-btns"><button data-q="close">Close</button></div>
    </div>`;
    m.hidden = false;
    m.querySelector("[data-q=close]").addEventListener("click", () => this._closeModal());
  }

  _closeModal() {
    if (this.el.modal.hidden) return;
    this.el.modal.hidden = true;
    this.el.modal.innerHTML = "";
    const c = this._modalCancel;
    this._modalCancel = null;
    c?.();
  }

  toast(msg, bad = false) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.toggle("bad", bad);
    t.classList.remove("show");
    void t.offsetWidth;
    t.classList.add("show");
  }
}

const MODE_LABEL = { pickup: "Pick up", drop: "Drop", equip: "Equip", attach: "Attach", swap: "Swap", merge: "Add to stack", detach: "To backpack", move: "Move" };
