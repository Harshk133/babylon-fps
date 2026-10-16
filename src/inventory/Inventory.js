import {
  WEAPONS, WEAPON_ORDER, STARTING_WEAPONS, STARTING_WEAPON,
  THROWABLES, THROWABLE_ORDER, MEDKIT,
} from "../combat/weapons.js";

/**
 * What the player is carrying. Pure state: no DOM, no Three.js.
 * One of each gun type (each with its own magazine + reserve), stacks of
 * throwables, and medkits. `version` bumps on every change so the UI can
 * skip work when nothing moved.
 */
export class Inventory {
  constructor() {
    this.reset();
  }

  /** empty: battle royale drop, nothing in your pockets (current is null until you find a gun). */
  reset(empty = false) {
    this.weapons = {};            // id → { id, ammo, reserve }
    this.throwables = {};         // kind → count
    if (!empty) for (const id of STARTING_WEAPONS) this._give(id, WEAPONS[id].magSize, WEAPONS[id].startReserve);
    for (const k of THROWABLE_ORDER) this.throwables[k] = empty ? 0 : THROWABLES[k].start;
    this.medkits = empty ? 0 : MEDKIT.start;
    this.current = empty ? null : STARTING_WEAPON;
    this.selectedThrowable = THROWABLE_ORDER[0];
    this.version = (this.version ?? 0) + 1;
  }

  _give(id, ammo, reserve) {
    this.weapons[id] = { id, ammo, reserve };
  }

  _touch() { this.version++; }

  has(id) { return !!this.weapons[id]; }

  get currentSlot() { return this.current ? this.weapons[this.current] : null; }

  get ownedWeapons() { return WEAPON_ORDER.filter(id => this.weapons[id]); }

  // ── Weapons ─────────────────────────────────────────────────────────────────

  /**
   * Picks up a gun. A gun you already own is stripped for ammo instead.
   * Returns a short message for the pickup feed, or null if nothing was taken.
   */
  addWeapon(id, ammo, reserve) {
    const def = WEAPONS[id];
    const slot = this.weapons[id];
    if (!slot) {
      this._give(id, Math.min(ammo, def.magSize), Math.min(reserve, def.reserveMax));
      this._touch();
      return { msg: `${def.name}`, isNew: true };
    }
    const taken = this._addReserve(slot, ammo + reserve);
    if (taken <= 0) return null;
    this._touch();
    return { msg: `+${taken} ${def.short} ammo`, isNew: false };
  }

  /** Removes a gun (for dropping). The last gun can't be dropped unless `any`. */
  removeWeapon(id, any = false) {
    if (!this.weapons[id] || (!any && this.ownedWeapons.length <= 1)) return null;
    const slot = this.weapons[id];
    delete this.weapons[id];
    if (this.current === id) this.current = this.ownedWeapons[0] ?? null;
    this._touch();
    return slot;
  }

  _addReserve(slot, amount) {
    const max = WEAPONS[slot.id].reserveMax;
    if (slot.reserve === Infinity) return 0;
    const taken = Math.min(amount, max - slot.reserve);
    slot.reserve += taken;
    return taken;
  }

  /** Ammo crate: tops up every owned gun with finite reserve. */
  addAmmoCrate() {
    let total = 0;
    for (const id of this.ownedWeapons) {
      const slot = this.weapons[id];
      total += this._addReserve(slot, WEAPONS[id].pickupReserve);
    }
    if (total > 0) this._touch();
    return total > 0 ? { msg: "+ Ammo for all guns" } : null;
  }

  ammoFull() {
    return this.ownedWeapons.every(id => {
      const s = this.weapons[id];
      return s.reserve === Infinity || s.reserve >= WEAPONS[id].reserveMax;
    });
  }

  equip(id) {
    if (!this.weapons[id] || this.current === id) return false;
    this.current = id;
    this._touch();
    return true;
  }

  /** dir = +1 / −1 through owned weapons in slot order. */
  cycle(dir) {
    const owned = this.ownedWeapons;
    if (owned.length < 2) return null;
    const i = owned.indexOf(this.current);
    const next = owned[(i + dir + owned.length) % owned.length];
    this.equip(next);
    return next;
  }

  /** Spends one round from the magazine. */
  consumeRound() {
    const slot = this.currentSlot;
    if (!slot || slot.ammo <= 0) return false;
    slot.ammo--;
    this._touch();
    return true;
  }

  canReload() {
    const slot = this.currentSlot;
    return slot && slot.ammo < WEAPONS[slot.id].magSize && slot.reserve > 0;
  }

  /** Moves rounds from reserve into the magazine. */
  finishReload() {
    const slot = this.currentSlot;
    if (!slot) return;
    const need = WEAPONS[slot.id].magSize - slot.ammo;
    const take = Math.min(need, slot.reserve);
    slot.ammo += take;
    if (slot.reserve !== Infinity) slot.reserve -= take;
    this._touch();
  }

  // ── Throwables ──────────────────────────────────────────────────────────────

  addThrowable(kind, count = 1) {
    const max = THROWABLES[kind].max;
    const taken = Math.min(count, max - this.throwables[kind]);
    if (taken <= 0) return null;
    this.throwables[kind] += taken;
    this._touch();
    return { msg: `+${taken} ${THROWABLES[kind].name}` };
  }

  throwableFull(kind) {
    return this.throwables[kind] >= THROWABLES[kind].max;
  }

  selectThrowable(kind) {
    if (this.selectedThrowable === kind) return;
    this.selectedThrowable = kind;
    this._touch();
  }

  cycleThrowable() {
    const i = THROWABLE_ORDER.indexOf(this.selectedThrowable);
    this.selectThrowable(THROWABLE_ORDER[(i + 1) % THROWABLE_ORDER.length]);
    return this.selectedThrowable;
  }

  /** Takes one of the selected throwable. Returns its kind, or null if out. */
  takeThrowable() {
    const kind = this.selectedThrowable;
    if (this.throwables[kind] <= 0) return null;
    this.throwables[kind]--;
    this._touch();
    return kind;
  }

  // ── Medkits ─────────────────────────────────────────────────────────────────

  addMedkit() {
    if (this.medkits >= MEDKIT.max) return null;
    this.medkits++;
    this._touch();
    return { msg: `+1 ${MEDKIT.name}` };
  }

  takeMedkit() {
    if (this.medkits <= 0) return false;
    this.medkits--;
    this._touch();
    return true;
  }
}
