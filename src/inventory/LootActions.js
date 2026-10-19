import { WEAPONS, THROWABLES, ATTACHMENTS, GEAR, ATTACH_SLOT_NAMES } from "../combat/weapons.js";
import { ITEMS } from "../items/ItemDefs.js";

/** m: loot this close shows in the inventory screen's vicinity list. */
export const VICINITY = 3.2;
const REACH = VICINITY + 0.8; // a little slack: you may have stepped while dragging

/**
 * Every item transfer between the ground, the backpack, the guns and the
 * gear slots, with its validation. The inventory screen, the E key and
 * walking over loot all go through here, so the rules are the same
 * everywhere: nothing is duplicated or lost, and an operation either
 * applies fully or changes nothing (returning { ok: false, msg }).
 *
 * Sources (src):  { from: "loot", entry, uid } · { from: "bag", kind }
 *                 { from: "weapon", id } · { from: "att", weapon, slot } · { from: "gear", slot }
 * Targets (dst):  { to: "bag" } · { to: "ground" } · { to: "weapon", id }
 *                 { to: "att", weapon, slot } · { to: "gear", slot }
 *
 * Shared world loot (battle royale, co-op drops) is claimed from the host
 * first (`claim`), so two players can't both take the same item.
 */
export class LootActions {
  /**
   * inventory, pickups: the game state.
   * spawnLoot(kind, data, at?): puts a real pickup in the world (shared when online); at = { x, y, z }, default your feet.
   * claim(entry, apply): runs apply() once this client may take the entry (now, or when the host agrees).
   * player(): { x, y (feet), z }.
   * onChange(prevCurrent): the held gun, its stats or the gear changed.
   * notify(msg, kind, icon): the pickup feed.
   * sfx: pickup / equip sounds.
   */
  constructor({ inventory, pickups, spawnLoot, claim, player, onChange, notify, sfx }) {
    Object.assign(this, { inv: inventory, pickups, spawnLoot, claim, player, onChange, notify, sfx });
    this._near = [];
  }

  /** Loot in reach, nearest first (reused array). */
  nearby() {
    const p = this.player();
    return this.pickups.near(p.x, p.z, p.y, VICINITY, this._near);
  }

  // ── Checks (pure: used to highlight drop targets while dragging) ────────────

  /** { ok, mode, msg }: mode "pickup" | "drop" | "equip" | "attach" | "swap" | "detach" | "move". */
  check(src, dst) {
    const inv = this.inv;
    switch (src.from) {
      case "loot": {
        const e = src.entry;
        if (!this._lootValid(src)) return no("Item no longer available");
        const kind = e.kind, item = ITEMS[kind], cat = e.def.category;
        if (dst.to === "ground") return no(null);
        if (dst.to === "gear") {
          if (cat !== "gear") return no("Only armor and backpacks go there");
          if (GEAR[kind].slot !== dst.slot) return no(`That goes in the ${GEAR[kind].slot} slot`);
          if (inv._capacityWith(dst.slot, kind) < inv.load) return no("Too much in your backpack for that");
          return yes(inv.gear[dst.slot] ? "swap" : "equip");
        }
        if (dst.to === "att" || dst.to === "weapon" && cat === "attachment") {
          if (cat !== "attachment") return no("Only attachments go there");
          const w = dst.weapon ?? dst.id;
          if (!inv.canAttach(w, kind)) return no(`Doesn't fit the ${WEAPONS[w]?.short ?? "gun"}`);
          if (dst.slot && ATTACHMENTS[kind].slot !== dst.slot) return no(`That's not a ${ATTACH_SLOT_NAMES[dst.slot].toLowerCase()}`);
          return yes(inv.weapons[w].att[ATTACHMENTS[kind].slot] ? "swap" : "attach");
        }
        if (dst.to === "weapon" && cat !== "weapon") return no("Only guns go there");
        // Into the backpack (or the weapons list): what would actually be taken
        return this._pickupCheck(e);
      }
      case "bag": {
        const kind = src.kind;
        if (inv.count(kind) <= 0) return no("You don't have that any more");
        if (dst.to === "ground") return yes("drop");
        if (dst.to === "bag") return no(null);
        if (dst.to === "att" || dst.to === "weapon") {
          if (!ATTACHMENTS[kind]) return no("Only attachments go on a gun");
          const w = dst.weapon ?? dst.id;
          if (!inv.canAttach(w, kind)) return no(`Doesn't fit the ${WEAPONS[w]?.short ?? "gun"}`);
          if (dst.slot && ATTACHMENTS[kind].slot !== dst.slot) return no(`That's not a ${ATTACH_SLOT_NAMES[dst.slot].toLowerCase()}`);
          return yes(inv.weapons[w].att[ATTACHMENTS[kind].slot] ? "swap" : "attach");
        }
        return no("Can't put that there");
      }
      case "weapon": {
        if (!inv.weapons[src.id]) return no("You don't have that gun");
        if (dst.to === "ground") return yes("drop");
        if (dst.to === "weapon" && dst.id === src.id) return yes("equip");
        return no(dst.to === "bag" ? "Guns are carried on you, not in the backpack" : "Can't put that there");
      }
      case "att": {
        const id = inv.weapons[src.weapon]?.att[src.slot];
        if (!id) return no("Nothing attached there");
        if (dst.to === "ground") return yes("drop");
        if (dst.to === "bag") return inv.room(id) >= 1 ? yes("detach") : no("Backpack full");
        if (dst.to === "att" || dst.to === "weapon") {
          const w = dst.weapon ?? dst.id;
          if (w === src.weapon) return no(null);
          if (!inv.canAttach(w, id)) return no(`Doesn't fit the ${WEAPONS[w]?.short ?? "gun"}`);
          if (dst.slot && ATTACHMENTS[id].slot !== dst.slot) return no(`That's not a ${ATTACH_SLOT_NAMES[dst.slot].toLowerCase()}`);
          return yes(inv.weapons[w].att[ATTACHMENTS[id].slot] ? "swap" : "move");
        }
        return no("Can't put that there");
      }
      case "gear": {
        const piece = inv.gear[src.slot];
        if (!piece) return no("Nothing there");
        if (dst.to === "ground") {
          return inv._capacityWith(src.slot, null) < inv.load ? no("Drop some items first: they won't fit without it") : yes("drop");
        }
        if (dst.to === "bag") return no("Armor and backpacks are worn, not carried");
        return no("Can't put that there");
      }
    }
    return no(null);
  }

  _lootValid(src) {
    const e = src.entry;
    if (!e?.active || e.pending || (src.uid !== undefined && e.uid !== src.uid)) return false;
    const p = this.player();
    return Math.hypot(e.x - p.x, e.z - p.z) <= REACH && Math.abs(e.y - p.y) < 1.6;
  }

  /** Would picking this entry up take anything? */
  _pickupCheck(e) {
    const inv = this.inv, kind = e.kind;
    switch (e.def.category) {
      case "weapon":
        if (!inv.weapons[kind]) return yes("pickup");
        if (!inv.ammoFull() || this._attHome(e.data?.att)) return yes("merge");
        return no(`${WEAPONS[kind].short}: ammo full`);
      case "ammo": return inv.ammoFull() ? no("Ammo full") : yes("merge");
      case "gear":
        if (inv._capacityWith(GEAR[kind].slot, kind) < inv.load) return no("Too much in your backpack for that");
        return yes(inv.gear[GEAR[kind].slot] ? "swap" : "equip");
      case "attachment":
        if (inv.freeSlotFor(kind) || inv.room(kind) >= 1) return yes(inv.count(kind) ? "merge" : "pickup");
        return no("Backpack full");
      default: {
        if (inv.canAdd(kind) > 0) return yes(inv.count(kind) ? "merge" : "pickup");
        return no(inv.count(kind) >= inv.maxOf(kind) ? `Can't carry more ${ITEMS[kind].name}s` : "Backpack full");
      }
    }
  }

  _attHome(att) {
    if (!att) return false;
    return Object.values(att).some(id => id && (this.inv.freeSlotFor(id) || this.inv.room(id) >= 1));
  }

  // ── Doing it ────────────────────────────────────────────────────────────────

  /** Performs src → dst. qty: how many of a stack (default all). Returns { ok, msg, pending }. */
  move(src, dst, qty = Infinity) {
    const c = this.check(src, dst);
    if (!c.ok) return c;
    const inv = this.inv;
    switch (src.from) {
      case "loot": return this.pickup(src.entry, { qty, dst, uid: src.uid });
      case "bag":
        if (dst.to === "ground") return this._dropStack(src.kind, qty);
        return this._attachFromBag(src.kind, dst.weapon ?? dst.id);
      case "weapon":
        if (dst.to === "ground") return this._dropWeapon(src.id);
        return this.equipWeapon(src.id);
      case "att": {
        const id = inv.weapons[src.weapon].att[src.slot];
        if (dst.to === "ground") {
          inv.detach(src.weapon, src.slot);
          this.spawnLoot(id, { count: 1 });
          this._changed();
          return ok(`Dropped ${ITEMS[id].name}`);
        }
        if (dst.to === "bag") {
          inv.detach(src.weapon, src.slot);
          inv.addStack(id, 1);
          this._changed();
          return ok(`${ITEMS[id].name} to backpack`);
        }
        return this._moveAttachment(src.weapon, src.slot, dst.weapon ?? dst.id);
      }
      case "gear": {
        const r = inv.unequipGear(src.slot);
        if (r.error) return no(r.error);
        this.spawnLoot(r.piece.id, { dur: r.piece.dur });
        this._changed();
        return ok(`Dropped ${ITEMS[r.piece.id].name}`);
      }
    }
    return no(null);
  }

  /**
   * Takes a world pickup. opts: qty (stack amount), dst (where it was
   * dragged: a gear / attachment slot or a gun), uid (the row's spawn id),
   * equip (switch to a new gun), auto (walk-over: no "full" spam).
   */
  pickup(entry, opts = {}) {
    const src = { from: "loot", entry, uid: opts.uid ?? entry.uid };
    if (!this._lootValid(src)) return no("Item no longer available");
    const c = opts.dst && opts.dst.to !== "bag" ? this.check(src, opts.dst) : this._pickupCheck(entry);
    if (!c.ok) return c;
    const uid = entry.uid;
    let result = { ok: true, pending: true, msg: null };
    let sync = true;
    this.claim(entry, () => {
      // Granted (maybe later, from the host): the entry is still here locally
      if (!entry.active || entry.uid !== uid) return;
      const r = this._take(entry, opts);
      if (sync) result = r;
      else if (r.msg) this.notify(r.msg, r.ok ? entry.def.category : "info", entry.kind);
    });
    sync = false;
    return result;
  }

  /** Applies a granted pickup. Anything that couldn't be taken goes back on the ground. */
  _take(entry, opts) {
    const inv = this.inv, kind = entry.kind, data = entry.data ?? {};
    const at = { x: entry.x, y: entry.y, z: entry.z };
    const prev = inv.current;
    let msg = null;
    this.pickups.release(entry);
    switch (entry.def.category) {
      case "weapon": {
        if (!inv.weapons[kind]) {
          inv.addWeapon(kind, data.ammo ?? WEAPONS[kind].magSize, data.reserve ?? 0, data.att);
          if (opts.equip || !inv.current || opts.dst?.to === "weapon") inv.equip(kind);
          msg = `Picked up ${WEAPONS[kind].name}`;
          break;
        }
        // Already have one: take its ammo and whatever attachments find a home
        const r = inv.addWeapon(kind, data.ammo ?? 0, data.reserve ?? 0);
        const left = [];
        for (const id of Object.values(data.att ?? {})) {
          if (!id) continue;
          const w = inv.freeSlotFor(id);
          if (w && inv.weapons[w].att[ATTACHMENTS[id].slot] === null) inv.attach(w, id);
          else if (inv.addStack(id, 1) < 1) left.push(id);
        }
        for (const id of left) this.spawnLoot(id, { count: 1 }, at);
        msg = r?.msg ?? `Took the attachments off the ${WEAPONS[kind].short}`;
        break;
      }
      case "ammo": {
        const r = inv.addAmmoCrate();
        if (!r) { this.spawnLoot(kind, null, at); return no("Ammo full"); }
        msg = r.msg;
        break;
      }
      case "gear": {
        const r = inv.equipGear(kind, data.dur);
        if (r.error) { this.spawnLoot(kind, data, at); return no(r.error); }
        if (r.prev) this.spawnLoot(r.prev.id, { dur: r.prev.dur });
        msg = r.prev ? `Swapped for ${GEAR[kind].name}` : `Equipped ${GEAR[kind].name}`;
        break;
      }
      case "attachment": {
        const count = data.count ?? 1;
        let want = Math.min(count, opts.qty ?? Infinity), taken = 0;
        // Dragged onto a gun / slot, or picked up with E: straight onto a gun
        const target = opts.dst?.weapon ?? opts.dst?.id ?? (opts.dst ? null : inv.freeSlotFor(kind));
        if (target && want > 0 && inv.canAttach(target, kind)) {
          const replaced = inv.attach(target, kind);
          taken++; want--;
          if (replaced && inv.addStack(replaced, 1) < 1) this.spawnLoot(replaced, { count: 1 });
          msg = `${ITEMS[kind].name} on the ${WEAPONS[target].short}`;
        }
        const bagged = want > 0 ? inv.addStack(kind, want) : 0;
        taken += bagged;
        if (count - taken > 0) this.spawnLoot(kind, { count: count - taken }, at);
        if (taken === 0) return no("Backpack full");
        msg ??= `+${taken} ${ITEMS[kind].name}`;
        break;
      }
      default: {
        // Stacks: throwables, medkits, petrol
        const count = data.count ?? 1;
        const taken = inv.addStack(kind, Math.min(count, opts.qty ?? Infinity));
        if (count - taken > 0) this.spawnLoot(kind, THROWABLES[kind] || count - taken > 1 ? { count: count - taken } : null, at);
        if (taken === 0) return no(inv.count(kind) >= inv.maxOf(kind) ? `Can't carry more ${ITEMS[kind].name}s` : "Backpack full");
        msg = `+${taken} ${ITEMS[kind].name}`;
      }
    }
    this.sfx?.pickup(entry.def.category === "weapon" || entry.def.category === "gear");
    this._changed(prev);
    return ok(msg);
  }

  _dropStack(kind, qty) {
    const n = this.inv.removeStack(kind, Math.max(1, Math.min(qty, this.inv.count(kind))));
    if (n <= 0) return no("Nothing to drop");
    this.spawnLoot(kind, { count: n });
    this._changed();
    return ok(`Dropped ${n > 1 ? `${n} × ` : ""}${ITEMS[kind].name}`);
  }

  _dropWeapon(id) {
    const prev = this.inv.current;
    const slot = this.inv.removeWeapon(id, true);
    if (!slot) return no("You don't have that gun");
    this.spawnLoot(id, { ammo: slot.ammo, reserve: slot.reserve, att: { ...slot.att } });
    this._changed(prev);
    return ok(`Dropped ${WEAPONS[id].name}`);
  }

  equipWeapon(id) {
    const prev = this.inv.current;
    if (!this.inv.equip(id)) return no(null);
    this._changed(prev);
    return ok(null);
  }

  _attachFromBag(kind, weapon) {
    const inv = this.inv;
    if (inv.removeStack(kind, 1) < 1) return no("You don't have that any more");
    const replaced = inv.attach(weapon, kind);
    if (replaced === undefined) { inv.addStack(kind, 1); return no("Doesn't fit"); }
    let msg = `${ITEMS[kind].name} on the ${WEAPONS[weapon].short}`;
    if (replaced && inv.addStack(replaced, 1) < 1) {
      this.spawnLoot(replaced, { count: 1 });
      msg += ` · ${ITEMS[replaced].name} dropped (backpack full)`;
    }
    this._changed();
    return ok(msg);
  }

  _moveAttachment(from, slot, to) {
    const inv = this.inv;
    const id = inv.detach(from, slot);
    const replaced = inv.attach(to, id);
    if (replaced === undefined) { inv.attach(from, id); return no("Doesn't fit"); }
    if (replaced) {
      // Swap: the other gun's attachment comes back here if it fits, else the backpack, else the ground
      if (inv.canAttach(from, replaced) && !inv.weapons[from].att[ATTACHMENTS[replaced].slot]) inv.attach(from, replaced);
      else if (inv.addStack(replaced, 1) < 1) this.spawnLoot(replaced, { count: 1 });
    }
    this._changed();
    return ok(`${ITEMS[id].name} moved to the ${WEAPONS[to].short}`);
  }

  _changed(prevCurrent = this.inv.current) {
    this.onChange?.(prevCurrent);
  }
}

const ok = msg => ({ ok: true, msg });
const yes = mode => ({ ok: true, mode });
const no = msg => ({ ok: false, msg });
