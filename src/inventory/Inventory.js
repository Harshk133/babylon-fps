import {
  WEAPONS, WEAPON_ORDER, STARTING_WEAPONS, STARTING_WEAPON,
  THROWABLES, THROWABLE_ORDER, MEDKIT, FUEL_CAN,
  GEAR, ATTACHMENTS, ITEM_WEIGHT, BASE_CAPACITY,
} from "../combat/weapons.js";
import { weaponStats, fitsWeapon, attachSlotsFor } from "../items/ItemDefs.js";

const emptyAtt = () => ({ optic: null, muzzle: null, mag: null, grip: null });

/**
 * What the player is carrying. Pure state: no DOM, no Three.js.
 *
 * - Guns: one of each type, each with its own magazine, reserve and
 *   attachments ({ optic, muzzle, mag, grip }); attachments travel with the
 *   gun when it's dropped.
 * - Backpack: stacks of throwables, medkits, petrol cans and loose
 *   attachments, limited by each kind's max and by weight vs capacity
 *   (BASE_CAPACITY + backpack + vest).
 * - Gear: helmet / vest / backpack slots, each { id, dur }.
 *
 * Every change bumps `version` so the UI can skip work when nothing moved.
 * Methods that can fail return null / false or { error } and change nothing.
 */
export class Inventory {
  constructor() {
    this.reset();
  }

  /** empty: battle royale drop, nothing in your pockets (current is null until you find a gun). */
  reset(empty = false) {
    this.weapons = {};            // id → { id, ammo, reserve, att }
    this.throwables = {};         // kind → count
    if (!empty) for (const id of STARTING_WEAPONS) this._give(id, WEAPONS[id].magSize, WEAPONS[id].startReserve);
    for (const k of THROWABLE_ORDER) this.throwables[k] = empty ? 0 : THROWABLES[k].start;
    this.medkits = empty ? 0 : MEDKIT.start;
    this.fuelCans = 0;
    this.bag = {};                // loose attachments: id → count
    this.gear = { helmet: null, vest: null, backpack: null };
    this.current = empty ? null : STARTING_WEAPON;
    this.selectedThrowable = THROWABLE_ORDER[0];
    this.version = (this.version ?? 0) + 1;
  }

  _give(id, ammo, reserve, att = null) {
    this.weapons[id] = { id, ammo, reserve, att: { ...emptyAtt(), ...(att ?? {}) } };
  }

  _touch() { this.version++; }

  has(id) { return !!this.weapons[id]; }

  get currentSlot() { return this.current ? this.weapons[this.current] : null; }

  get ownedWeapons() { return WEAPON_ORDER.filter(id => this.weapons[id]); }

  /** Magazine size of a gun with its attachments (extended mag). */
  magSize(id) { return weaponStats(id, this.weapons[id]?.att).magSize; }

  // ── Weight & capacity ───────────────────────────────────────────────────────

  /** Weight carried (guns, ammo and worn gear weigh nothing). */
  get load() {
    let w = 0;
    for (const k of THROWABLE_ORDER) w += this.throwables[k] * (ITEM_WEIGHT[k] ?? 0);
    w += this.medkits * ITEM_WEIGHT.medkit + this.fuelCans * ITEM_WEIGHT.fuel;
    for (const [id, n] of Object.entries(this.bag)) w += n * (ITEM_WEIGHT[id] ?? 0);
    return w;
  }

  /** Carrying capacity: base + backpack + vest pouches. */
  get capacity() {
    let c = BASE_CAPACITY;
    for (const s of ["backpack", "vest"]) if (this.gear[s]) c += GEAR[this.gear[s].id].capacity ?? 0;
    return c;
  }

  /** How many more of `kind` fit by weight (Infinity for weightless kinds). */
  room(kind) {
    const w = ITEM_WEIGHT[kind] ?? 0;
    return w > 0 ? Math.max(0, Math.floor((this.capacity - this.load + 1e-6) / w)) : Infinity;
  }

  /** How many of a stackable kind are carried. */
  count(kind) {
    if (THROWABLES[kind]) return this.throwables[kind];
    if (kind === "medkit") return this.medkits;
    if (kind === "fuel") return this.fuelCans;
    if (ATTACHMENTS[kind]) return this.bag[kind] ?? 0;
    return 0;
  }

  /** Per-kind cap (separate from weight). */
  maxOf(kind) {
    if (THROWABLES[kind]) return THROWABLES[kind].max;
    if (kind === "medkit") return MEDKIT.max;
    if (kind === "fuel") return FUEL_CAN.max;
    if (ATTACHMENTS[kind]) return Infinity;
    return 0;
  }

  /** How many of `kind` could be added right now (kind cap and weight). */
  canAdd(kind) {
    return Math.max(0, Math.min(this.maxOf(kind) - this.count(kind), this.room(kind)));
  }

  /**
   * Adds up to `n` of a stackable kind. Returns how many were taken (0 if
   * none: full, or over the weight limit).
   */
  addStack(kind, n = 1) {
    const take = Math.min(n, this.canAdd(kind));
    if (take <= 0) return 0;
    if (THROWABLES[kind]) this.throwables[kind] += take;
    else if (kind === "medkit") this.medkits += take;
    else if (kind === "fuel") this.fuelCans += take;
    else if (ATTACHMENTS[kind]) this.bag[kind] = (this.bag[kind] ?? 0) + take;
    else return 0;
    this._touch();
    return take;
  }

  /** Removes up to `n` of a stackable kind. Returns how many were removed. */
  removeStack(kind, n = 1) {
    const take = Math.min(n, this.count(kind));
    if (take <= 0) return 0;
    if (THROWABLES[kind]) this.throwables[kind] -= take;
    else if (kind === "medkit") this.medkits -= take;
    else if (kind === "fuel") this.fuelCans -= take;
    else if (ATTACHMENTS[kind]) {
      this.bag[kind] -= take;
      if (this.bag[kind] <= 0) delete this.bag[kind];
    }
    this._touch();
    return take;
  }

  // ── Weapons ─────────────────────────────────────────────────────────────────

  /**
   * Picks up a gun. A gun you already own is stripped for ammo instead.
   * Returns a short message for the pickup feed, or null if nothing was taken.
   */
  addWeapon(id, ammo, reserve, att = null) {
    const def = WEAPONS[id];
    const slot = this.weapons[id];
    if (!slot) {
      this._give(id, 0, Math.min(reserve, def.reserveMax), att);
      this.weapons[id].ammo = Math.min(ammo, this.magSize(id));
      this._touch();
      return { msg: `${def.name}`, isNew: true };
    }
    const taken = this._addReserve(slot, ammo + reserve);
    if (taken <= 0) return null;
    this._touch();
    return { msg: `+${taken} ${def.short} ammo`, isNew: false };
  }

  /** Removes a gun (for dropping), with its attachments. The last gun can't be dropped unless `any`. */
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
    return slot && slot.ammo < this.magSize(slot.id) && slot.reserve > 0;
  }

  /** Moves rounds from reserve into the magazine. */
  finishReload() {
    const slot = this.currentSlot;
    if (!slot) return;
    const need = this.magSize(slot.id) - slot.ammo;
    const take = Math.min(need, slot.reserve);
    slot.ammo += take;
    if (slot.reserve !== Infinity) slot.reserve -= take;
    this._touch();
  }

  // ── Attachments ─────────────────────────────────────────────────────────────

  /** Can `attId` go on `weaponId` (owned, has that slot)? */
  canAttach(weaponId, attId) {
    return !!this.weapons[weaponId] && fitsWeapon(attId, weaponId) && attachSlotsFor(weaponId).includes(ATTACHMENTS[attId].slot);
  }

  /**
   * Mounts `attId` on a gun (the caller has taken it from the backpack or the
   * ground). Returns the attachment it replaced (null if the slot was empty),
   * or undefined if it doesn't fit.
   */
  attach(weaponId, attId) {
    if (!this.canAttach(weaponId, attId)) return undefined;
    const w = this.weapons[weaponId];
    const s = ATTACHMENTS[attId].slot;
    const prev = w.att[s];
    w.att[s] = attId;
    if (prev) this._clampMag(w);
    this._touch();
    return prev;
  }

  /** Takes the attachment off a gun's slot. Returns its id, or null if empty. */
  detach(weaponId, slotName) {
    const w = this.weapons[weaponId];
    const id = w?.att[slotName];
    if (!id) return null;
    w.att[slotName] = null;
    this._clampMag(w);
    this._touch();
    return id;
  }

  /** After losing an extended mag the extra rounds go back to the reserve. */
  _clampMag(w) {
    const max = this.magSize(w.id);
    if (w.ammo <= max) return;
    if (w.reserve !== Infinity) w.reserve += w.ammo - max;
    w.ammo = max;
  }

  /**
   * Best home for a loose attachment: an empty compatible slot on the gun in
   * your hands, then on any other gun. Returns a weapon id or null.
   */
  freeSlotFor(attId) {
    const s = ATTACHMENTS[attId]?.slot;
    const order = [this.current, ...this.ownedWeapons.filter(id => id !== this.current)];
    return order.find(id => id && this.canAttach(id, attId) && !this.weapons[id].att[s]) ?? null;
  }

  // ── Gear ────────────────────────────────────────────────────────────────────

  /** { helmet, vest, backpack } levels (0 = none), for the character model. */
  gearLevels() {
    const lv = s => (this.gear[s] ? GEAR[this.gear[s].id].level : 0);
    return { helmet: lv("helmet"), vest: lv("vest"), backpack: lv("backpack") };
  }

  /** Capacity if slot `s` held `id` instead (null = empty). */
  _capacityWith(s, id) {
    let c = BASE_CAPACITY;
    for (const k of ["backpack", "vest"]) {
      const g = k === s ? id : this.gear[k]?.id;
      if (g) c += GEAR[g].capacity ?? 0;
    }
    return c;
  }

  /**
   * Wears a helmet / vest / backpack. Returns { prev } (the piece it replaced,
   * which the caller drops on the ground) or { error } with nothing changed.
   */
  equipGear(id, dur = null) {
    const g = GEAR[id];
    if (!g) return { error: "Can't wear that" };
    if (this._capacityWith(g.slot, id) < this.load) return { error: "Too much in your backpack for that" };
    const prev = this.gear[g.slot];
    this.gear[g.slot] = { id, dur: dur ?? g.durability ?? null };
    this._touch();
    return { prev };
  }

  /** Takes off a piece of gear. Returns it, or { error } if your load wouldn't fit without it. */
  unequipGear(slot) {
    const piece = this.gear[slot];
    if (!piece) return { error: "Nothing there" };
    if (this._capacityWith(slot, null) < this.load) return { error: "Drop some items first: they won't fit without it" };
    this.gear[slot] = null;
    this._touch();
    return { piece };
  }

  /**
   * Armor soaking `amount` of durability. Returns true if it broke (it's then gone).
   */
  wearGear(slot, amount) {
    const piece = this.gear[slot];
    if (!piece || piece.dur === null) return false;
    piece.dur = Math.max(0, piece.dur - amount);
    this._touch();
    if (piece.dur > 0) return false;
    this.gear[slot] = null;
    return true;
  }

  // ── Throwables ──────────────────────────────────────────────────────────────

  addThrowable(kind, count = 1) {
    const taken = this.addStack(kind, count);
    if (taken <= 0) return null;
    return { msg: `+${taken} ${THROWABLES[kind].name}`, taken };
  }

  throwableFull(kind) {
    return this.canAdd(kind) <= 0;
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

  // ── Petrol cans ─────────────────────────────────────────────────────────────

  addFuelCan(n = 1) {
    const taken = this.addStack("fuel", n);
    return taken > 0 ? { msg: `+${taken} ${FUEL_CAN.name}`, taken } : null;
  }

  takeFuelCan() {
    return this.removeStack("fuel", 1) > 0;
  }

  // ── Medkits ─────────────────────────────────────────────────────────────────

  addMedkit(n = 1) {
    const taken = this.addStack("medkit", n);
    return taken > 0 ? { msg: `+${taken} ${MEDKIT.name}`, taken } : null;
  }

  takeMedkit() {
    return this.removeStack("medkit", 1) > 0;
  }
}
