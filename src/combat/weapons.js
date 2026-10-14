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
    fireRate: 6, magSize: 12, reserveMax: Infinity, startReserve: Infinity, pickupReserve: 0,
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
    recoilPitch: 0.07, recoilYaw: 0.01, push: 5, alertRadius: 60, aimFov: 16,
    sound: "sniper", tracersPerShot: 1,
  },
};

export const WEAPON_ORDER = ["pistol", "smg", "shotgun", "rifle", "sniper"];
export const STARTING_WEAPONS = ["pistol", "smg"];
export const STARTING_WEAPON = "smg";

export const THROWABLES = {
  grenade: { name: "Frag Grenade", short: "FRAG", max: 5, start: 2 },
  molotov: { name: "Molotov", short: "MOLOTOV", max: 5, start: 1 },
};
export const THROWABLE_ORDER = ["grenade", "molotov"];

export const MEDKIT = { name: "Medkit", max: 3, start: 0, heal: 50 };

// Grenade / molotov tuning
export const GRENADE = {
  fuse: 2.2,
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

/**
 * Pickup kinds. `category` drives the colour of the ground glow and whether
 * the item needs E (weapons) or is collected by walking over it.
 */
export const PICKUP_KINDS = {
  pistol:  { category: "weapon",    label: "Pistol",         scale: 1.8 },
  smg:     { category: "weapon",    label: "Submachine Gun", scale: 1.5 },
  shotgun: { category: "weapon",    label: "Shotgun",        scale: 1.3 },
  rifle:   { category: "weapon",    label: "Assault Rifle",  scale: 1.3 },
  sniper:  { category: "weapon",    label: "Sniper Rifle",   scale: 1.2 },
  ammo:    { category: "ammo",      label: "Ammo Crate",     scale: 1.3 },
  grenade: { category: "throwable", label: "Frag Grenade",   scale: 2.2 },
  molotov: { category: "throwable", label: "Molotov",        scale: 1.8 },
  medkit:  { category: "medkit",    label: "Medkit",         scale: 1.4 },
};
