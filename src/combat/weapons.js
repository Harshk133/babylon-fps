// Weapon, throwable and pickup definitions. Pure data — no Three.js here.

// Shared by every gun: hits above (zombie height − headHeight) are headshots
export const HEAD_HEIGHT = 0.5;

/**
 * Gun stats. `reserve: Infinity` means the gun never runs dry (pistol fallback).
 * `pellets` > 1 fires a spread of rays per shot (shotgun).
 * `auto: false` needs a fresh trigger pull per shot.
 */
export const WEAPONS = {
  pistol: {
    name: "Pistol", short: "PISTOL", slot: 1, auto: false,
    fireRate: 6, magSize: 12, reserveMax: Infinity, startReserve: Infinity, pickupReserve: 24,
    reloadTime: 1.2, damage: 34, pellets: 1, headshotMultiplier: 3, range: 90,
    spreadHip: 0.016, spreadAim: 0.002, spreadMove: 0.016, spreadAir: 0.04,
    bloomPerShot: 0.01, bloomMax: 0.03, bloomRecovery: 0.12,
    recoilPitch: 0.02, recoilYaw: 0.006, push: 1.0, alertRadius: 28, aimFov: 44,
    sound: "pistol", tracersPerShot: 1,
  },
  smg: {
    name: "Submachine Gun", short: "SMG", slot: 2, auto: true,
    fireRate: 11, magSize: 32, reserveMax: 320, startReserve: 160, pickupReserve: 96,
    reloadTime: 1.7, damage: 25, pellets: 1, headshotMultiplier: 4, range: 150,
    spreadHip: 0.02, spreadAim: 0.003, spreadMove: 0.02, spreadAir: 0.04,
    bloomPerShot: 0.004, bloomMax: 0.03, bloomRecovery: 0.12,
    recoilPitch: 0.012, recoilYaw: 0.004, push: 1.2, alertRadius: 38, aimFov: 42,
    sound: "smg", tracersPerShot: 1,
  },
  shotgun: {
    name: "Shotgun", short: "SHOTGUN", slot: 3, auto: false,
    fireRate: 1.4, magSize: 8, reserveMax: 48, startReserve: 16, pickupReserve: 16,
    reloadTime: 2.4, damage: 16, pellets: 9, headshotMultiplier: 2, range: 40,
    spreadHip: 0.075, spreadAim: 0.05, spreadMove: 0.015, spreadAir: 0.03,
    bloomPerShot: 0, bloomMax: 0, bloomRecovery: 0.12,
    recoilPitch: 0.05, recoilYaw: 0.012, push: 1.4, alertRadius: 45, aimFov: 50,
    sound: "shotgun", tracersPerShot: 5,
  },
  rifle: {
    name: "Assault Rifle", short: "RIFLE", slot: 4, auto: true,
    fireRate: 8.5, magSize: 30, reserveMax: 240, startReserve: 90, pickupReserve: 60,
    reloadTime: 2.0, damage: 38, pellets: 1, headshotMultiplier: 3, range: 180,
    spreadHip: 0.022, spreadAim: 0.0015, spreadMove: 0.022, spreadAir: 0.045,
    bloomPerShot: 0.005, bloomMax: 0.028, bloomRecovery: 0.1,
    recoilPitch: 0.017, recoilYaw: 0.006, push: 1.6, alertRadius: 42, aimFov: 36,
    sound: "rifle", tracersPerShot: 1,
  },
  sniper: {
    name: "Sniper Rifle", short: "SNIPER", slot: 5, auto: false,
    fireRate: 0.9, magSize: 5, reserveMax: 40, startReserve: 15, pickupReserve: 10,
    reloadTime: 2.8, damage: 160, pellets: 1, headshotMultiplier: 3, range: 300,
    spreadHip: 0.05, spreadAim: 0.0, spreadMove: 0.03, spreadAir: 0.06,
    bloomPerShot: 0, bloomMax: 0, bloomRecovery: 0.12,
    // scope: aiming looks down a real scope (overlay, first-person, ~9x zoom)
    recoilPitch: 0.07, recoilYaw: 0.01, push: 5, alertRadius: 60, aimFov: 7, scope: true,
    sound: "sniper", tracersPerShot: 1,
  },
};

export const WEAPON_ORDER = ["pistol", "smg", "shotgun", "rifle", "sniper"];
export const STARTING_WEAPONS = ["pistol", "smg"];
export const STARTING_WEAPON = "smg";

export const THROWABLES = {
  grenade: { name: "Frag Grenade", short: "FRAG", max: 5, start: 2 },
  molotov: { name: "Molotov", short: "MOLOTOV", max: 5, start: 1 },
  smoke:   { name: "Smoke Grenade", short: "SMOKE", max: 3, start: 0 },
};
export const THROWABLE_ORDER = ["grenade", "molotov", "smoke"];

export const MEDKIT = { name: "Medkit", max: 3, start: 0, heal: 50 };
/** Parle-G: a quick snack heal. H eats one unless you're hurt enough for a medkit. */
export const BISCUIT = { name: "Parle-G Biscuits", max: 8, start: 0, heal: 20, medkitBelow: 60 };

/**
 * Rupees: ₹2000 notes lying around, dropped by monsters and by eliminated
 * players. Spent at the dukaan stalls in the towns (src/economy/Shop.js).
 */
export const CASH = {
  note: 2000,                           // one bundle in the world
  monster: { walker: 100, runner: 150, listener: 150, gunner: 300, brute: 500, hound: 200, dragon: 3000, boss: 5000 },
  monsterChance: 0.35,                  // ordinary monsters drop cash this often (bosses always)
};

// Petrol for the auto-rickshaw: carried, poured in with T next to it (or while driving)
export const FUEL_CAN = { name: "Petrol Can", max: 2 };

// Grenade / molotov tuning
export const GRENADE = {
  fuse: 2.2,          // a remote throw that didn't say how long was left
  cookTime: 5,        // the fuse starts when you pull the pin (hold G): 5…1 on screen, then it bursts
  radius: 7.5,
  maxDamage: 240,
  minDamage: 30,
  push: 9,
  playerRadius: 5.5,
  playerMaxDamage: 60,
  alertRadius: 60,
};
export const MOLOTOV = {
  maxFlight: 4,       // shatters on contact, or after this many seconds in the air
  radius: 3.4,
  duration: 8,
  tick: 0.25,
  zombieDps: 40,
  playerDps: 18,
  alertRadius: 30,
};
/** Smoke grenade: a coloured cloud you can't see through (src/combat/SmokeFX.js). */
export const SMOKE = {
  fuse: 1.4,          // pops after this long, wherever it rolled to
  radius: 6,          // m, fully grown
  height: 4.2,        // m
  grow: 2.5,          // s to billow out to full size
  duration: 20,       // s the cloud lasts, fade included
  fade: 4,            // s it thins out at the end
  warmupKit: 2,       // given in the battle royale warm-up so you can try it
};
/** Each smoke grenade pops in one of these, picked when it's thrown. */
export const SMOKE_COLORS = [0xe53935, 0xff8a1f, 0xffd23f, 0x43d36b, 0x2ec4d6, 0x3d7bff, 0x9b5cff, 0xff5cc8, 0xd8d8d8];

// ── Gear: helmets, vests, backpacks ─────────────────────────────────────────
/**
 * reduce: share of the damage it stops (helmets: headshots in the battle
 * royale and a little of every monster hit; vests: body hits and blasts).
 * durability: damage it can soak before it breaks. capacity: backpack
 * carrying capacity added (vests add a little too, like PUBG's pouches).
 * Equipped gear weighs nothing; you can't carry a spare in the backpack.
 */
export const GEAR = {
  helmet1:   { slot: "helmet",   level: 1, name: "Helmet (Lv. 1)",   reduce: 0.3,  durability: 80 },
  helmet2:   { slot: "helmet",   level: 2, name: "Helmet (Lv. 2)",   reduce: 0.4,  durability: 150 },
  helmet3:   { slot: "helmet",   level: 3, name: "Helmet (Lv. 3)",   reduce: 0.55, durability: 230 },
  vest1:     { slot: "vest",     level: 1, name: "Vest (Lv. 1)",     reduce: 0.3,  durability: 200, capacity: 50 },
  vest2:     { slot: "vest",     level: 2, name: "Vest (Lv. 2)",     reduce: 0.4,  durability: 220, capacity: 50 },
  vest3:     { slot: "vest",     level: 3, name: "Vest (Lv. 3)",     reduce: 0.55, durability: 250, capacity: 50 },
  backpack1: { slot: "backpack", level: 1, name: "Backpack (Lv. 1)", capacity: 100 },
  backpack2: { slot: "backpack", level: 2, name: "Backpack (Lv. 2)", capacity: 160 },
  backpack3: { slot: "backpack", level: 3, name: "Backpack (Lv. 3)", capacity: 220 },
};
export const GEAR_SLOTS = ["helmet", "vest", "backpack"];
/** Helmets also take this share of `reduce` off monster hits (bites to the head). */
export const HELMET_MONSTER_SHARE = 0.35;
/** Vests stop this share of `reduce` of a grenade blast. */
export const VEST_BLAST_SHARE = 0.6;

// ── Attachments ──────────────────────────────────────────────────────────────
/**
 * slot: where it goes on a gun. fits: guns it mounts on. mods: multipliers
 * (…Mul) or replacements applied to the gun's stats while attached
 * (see weaponStats() in src/items/ItemDefs.js).
 */
export const ATTACHMENTS = {
  reddot:      { slot: "optic",  name: "Red Dot Sight",  fits: ["pistol", "smg", "shotgun", "rifle"], mods: { aimFovMul: 0.86, spreadAimMul: 0.65 } },
  scope4x:     { slot: "optic",  name: "4x ACOG Scope",  fits: ["smg", "rifle", "sniper"],            mods: { aimFov: 12, spreadAimMul: 0.5, scope: true } },
  compensator: { slot: "muzzle", name: "Compensator",    fits: ["smg", "rifle", "sniper"],            mods: { recoilMul: 0.68 } },
  suppressor:  { slot: "muzzle", name: "Suppressor",     fits: ["pistol", "smg", "rifle", "sniper"],  mods: { alertMul: 0.4, recoilMul: 0.9, suppressed: true } },
  extmag:      { slot: "mag",    name: "Extended Mag",   fits: ["pistol", "smg", "rifle", "sniper"],  mods: { magMul: 1.5 } },
  grip:        { slot: "grip",   name: "Vertical Grip",  fits: ["smg", "rifle"],                      mods: { recoilMul: 0.8, bloomMul: 0.7, spreadHipMul: 0.85 } },
};
export const ATTACH_SLOTS = ["optic", "muzzle", "mag", "grip"];
export const ATTACH_SLOT_NAMES = { optic: "Optic", muzzle: "Muzzle", mag: "Magazine", grip: "Grip" };

// ── Carrying ─────────────────────────────────────────────────────────────────
/** Weight of one of each carried item. Guns, their ammo and worn gear weigh nothing. */
export const ITEM_WEIGHT = {
  grenade: 18, molotov: 18, smoke: 14, medkit: 20, fuel: 30, biscuit: 5,
  reddot: 10, scope4x: 15, compensator: 10, suppressor: 12, extmag: 15, grip: 10,
};
/** Capacity with no backpack and no vest (backpacks / vests add GEAR[…].capacity). */
export const BASE_CAPACITY = 100;

/**
 * Pickup kinds. `category` drives the colour of the ground glow; `interact`
 * kinds need E, the rest are collected by walking over them.
 */
export const PICKUP_KINDS = {
  pistol:  { category: "weapon",    label: "Pistol",         scale: 1.8, interact: true },
  smg:     { category: "weapon",    label: "Submachine Gun", scale: 1.5, interact: true },
  shotgun: { category: "weapon",    label: "Shotgun",        scale: 1.3, interact: true },
  rifle:   { category: "weapon",    label: "Assault Rifle",  scale: 1.3, interact: true },
  sniper:  { category: "weapon",    label: "Sniper Rifle",   scale: 1.2, interact: true },
  ammo:    { category: "ammo",      label: "Ammo Crate",     scale: 1.3 },
  grenade: { category: "throwable", label: "Frag Grenade",   scale: 2.2 },
  molotov: { category: "throwable", label: "Molotov",        scale: 1.8 },
  smoke:   { category: "throwable", label: "Smoke Grenade",  scale: 2.0 },
  medkit:  { category: "medkit",    label: "Medkit",         scale: 1.4 },
  biscuit: { category: "medkit",    label: "Parle-G Biscuits", scale: 2.4 },
  fuel:    { category: "fuel",      label: "Petrol Can",     scale: 1.6 },
  cash:    { category: "cash",      label: "₹2000 Notes",    scale: 2.4 },
};
for (const [id, g] of Object.entries(GEAR)) {
  PICKUP_KINDS[id] = { category: "gear", label: g.name, scale: g.slot === "helmet" ? 2.2 : 1.5, interact: true };
}
for (const [id, a] of Object.entries(ATTACHMENTS)) {
  PICKUP_KINDS[id] = { category: "attachment", label: a.name, scale: a.slot === "optic" ? 2.2 : 2.6, interact: true };
}
