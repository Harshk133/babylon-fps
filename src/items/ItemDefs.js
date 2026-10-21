// Item catalog for the inventory: one definition per item kind, built from
// the gameplay data in combat/weapons.js (so a new gun, throwable, gear piece
// or attachment added there shows up here without UI changes). Pure data.

import {
  WEAPONS, WEAPON_ORDER, THROWABLES, THROWABLE_ORDER, MEDKIT, BISCUIT, FUEL_CAN, PICKUP_KINDS,
  GEAR, ATTACHMENTS, ATTACH_SLOTS, ITEM_WEIGHT,
} from "../combat/weapons.js";

/** Display order of the backpack groups. */
export const GROUPS = ["Healing", "Throwables", "Attachments", "Utility"];

export const RARITY_COLOR = { common: "#c9c2b6", uncommon: "#6fcf5a", rare: "#4aa3ff", epic: "#b06cff" };
const LEVEL_RARITY = [null, "common", "rare", "epic"];

/**
 * id → {
 *   id, name, type ("weapon" | "throwable" | "heal" | "utility" | "ammo" | "gear" | "attachment"),
 *   group (backpack section), icon (key into the HUD icon atlas), maxStack,
 *   weight (per unit), rarity, equipmentSlot, compatibleSlots, fits (attachments),
 *   level (gear), stackable (carried as a count), desc
 * }
 */
export const ITEMS = {};

for (const id of WEAPON_ORDER) {
  const w = WEAPONS[id];
  ITEMS[id] = {
    id, name: w.name, type: "weapon", group: null, icon: id, maxStack: 1, weight: 0,
    rarity: id === "sniper" ? "epic" : id === "rifle" || id === "shotgun" ? "rare" : "common",
    equipmentSlot: "weapon", compatibleSlots: attachSlotsFor(id), stackable: false,
    desc: `${w.auto ? "Full auto" : "Semi auto"} · ${w.magSize} round magazine · ${w.damage * w.pellets} damage per shot`,
  };
}
for (const id of THROWABLE_ORDER) {
  ITEMS[id] = {
    id, name: THROWABLES[id].name, type: "throwable", group: "Throwables", icon: id, maxStack: THROWABLES[id].max,
    weight: ITEM_WEIGHT[id] ?? 15, rarity: id === "grenade" ? "uncommon" : "common", equipmentSlot: null,
    compatibleSlots: [], stackable: true,
    desc: {
      grenade: "Bounces, explodes after 2 s. Huge blast radius.",
      molotov: "Shatters on impact. Burns the area for 8 s.",
      smoke: "A big coloured cloud for 20 s. Nobody sees you inside it.",
    }[id] ?? "",
  };
}
ITEMS.medkit = {
  id: "medkit", name: MEDKIT.name, type: "heal", group: "Healing", icon: "medkit", maxStack: MEDKIT.max,
  weight: ITEM_WEIGHT.medkit, rarity: "uncommon", equipmentSlot: null, compatibleSlots: [], stackable: true,
  desc: `Restores ${MEDKIT.heal} health. Press H to use.`,
};
ITEMS.biscuit = {
  id: "biscuit", name: BISCUIT.name, type: "heal", group: "Healing", icon: "biscuit", maxStack: BISCUIT.max,
  weight: ITEM_WEIGHT.biscuit, rarity: "common", equipmentSlot: null, compatibleSlots: [], stackable: true,
  desc: `A quick snack: +${BISCUIT.heal} health. H eats one when you aren't hurt enough for a medkit.`,
};
ITEMS.cash = {
  id: "cash", name: "₹2000 Notes", type: "cash", group: null, icon: "cash", maxStack: 1, weight: 0,
  rarity: "uncommon", equipmentSlot: null, compatibleSlots: [], stackable: false,
  desc: "Money. Spend it at a dukaan (shop stall) in any town.",
};
ITEMS.fuel = {
  id: "fuel", name: FUEL_CAN.name, type: "utility", group: "Utility", icon: "fuel", maxStack: FUEL_CAN.max,
  weight: ITEM_WEIGHT.fuel, rarity: "common", equipmentSlot: null, compatibleSlots: [], stackable: true,
  desc: "Fills a rickshaw or a Thar. Press T next to it.",
};
ITEMS.ammo = {
  id: "ammo", name: PICKUP_KINDS.ammo.label, type: "ammo", group: null, icon: "ammo", maxStack: 1, weight: 0,
  rarity: "common", equipmentSlot: null, compatibleSlots: [], stackable: false,
  desc: "Tops up the reserve ammo of every gun you carry.",
};
for (const [id, g] of Object.entries(GEAR)) {
  const effect = g.slot === "backpack"
    ? `+${g.capacity} carrying capacity`
    : `Stops ${Math.round(g.reduce * 100)}% of ${g.slot === "helmet" ? "head" : "body"} damage · ${g.durability} durability${g.capacity ? ` · +${g.capacity} capacity` : ""}`;
  ITEMS[id] = {
    id, name: g.name, type: "gear", group: null, icon: id, maxStack: 1, weight: 0, rarity: LEVEL_RARITY[g.level],
    equipmentSlot: g.slot, compatibleSlots: [g.slot], level: g.level, stackable: false, desc: effect,
  };
}
for (const [id, a] of Object.entries(ATTACHMENTS)) {
  ITEMS[id] = {
    id, name: a.name, type: "attachment", group: "Attachments", icon: id, maxStack: 99, weight: ITEM_WEIGHT[id] ?? 10,
    rarity: id === "scope4x" || id === "suppressor" ? "rare" : "uncommon", equipmentSlot: null,
    compatibleSlots: [a.slot], fits: a.fits, stackable: true,
    desc: `${describeMods(a.mods)} · Fits: ${a.fits.map(w => WEAPONS[w].short).join(", ")}`,
  };
}

function describeMods(m) {
  const out = [];
  if (m.aimFov) out.push("4x zoom");
  if (m.aimFovMul) out.push("closer aim");
  if (m.spreadAimMul) out.push(`${Math.round((1 - m.spreadAimMul) * 100)}% tighter aim`);
  if (m.recoilMul) out.push(`${Math.round((1 - m.recoilMul) * 100)}% less recoil`);
  if (m.bloomMul) out.push("steadier bursts");
  if (m.magMul) out.push(`+${Math.round((m.magMul - 1) * 100)}% magazine`);
  if (m.suppressed) out.push("quiet shots, monsters hear less");
  return out.join(", ");
}

/** Attachment slots a gun has (any attachment fits it there). */
export function attachSlotsFor(weaponId) {
  return ATTACH_SLOTS.filter(s => Object.values(ATTACHMENTS).some(a => a.slot === s && a.fits.includes(weaponId)));
}

/** True if attachment `attId` mounts on `weaponId`. */
export function fitsWeapon(attId, weaponId) {
  return !!ATTACHMENTS[attId]?.fits.includes(weaponId);
}

const _stats = new Map();
/**
 * A gun's stats with its attachments applied (cached per combination, so
 * calling it every frame allocates nothing). att: { optic, muzzle, mag, grip }.
 */
export function weaponStats(id, att) {
  const base = WEAPONS[id];
  if (!base) return undefined;
  let key = id;
  if (att) for (const s of ATTACH_SLOTS) key += `|${att[s] ?? ""}`;
  let d = _stats.get(key);
  if (d) return d;
  d = { ...base, suppressed: false };
  for (const s of ATTACH_SLOTS) {
    const a = att?.[s] ? ATTACHMENTS[att[s]] : null;
    if (!a) continue;
    const m = a.mods;
    if (m.aimFov) d.aimFov = Math.min(d.aimFov, m.aimFov);
    if (m.aimFovMul) d.aimFov *= m.aimFovMul;
    if (m.spreadAimMul) d.spreadAim *= m.spreadAimMul;
    if (m.spreadHipMul) d.spreadHip *= m.spreadHipMul;
    if (m.recoilMul) { d.recoilPitch *= m.recoilMul; d.recoilYaw *= m.recoilMul; }
    if (m.bloomMul) d.bloomPerShot *= m.bloomMul;
    if (m.alertMul) d.alertRadius *= m.alertMul;
    if (m.magMul) d.magSize = Math.round(d.magSize * m.magMul);
    if (m.suppressed) d.suppressed = true;
    if (m.scope) d.scope = true;
  }
  _stats.set(key, d);
  return d;
}
