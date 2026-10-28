// Monster archetypes, enemy weapons and level progression. Pure data.
//
// Models are the Quake 2 player models shipped with the three.js MD2 examples
// (webgl_loader_md2 / webgl_loader_md2_control): Ratamahatta and Ogro, each
// with several skins and separate MD2 weapon meshes animated in sync.

const RATA = "/models/md2/ratamahatta/";
const OGRO = "/models/md2/ogro/";

export const MODELS = {
  ratamahatta: { body: `${RATA}ratamahatta.md2`, skinDir: `${RATA}skins/` },
  ogro:        { body: `${OGRO}ogro.md2`,        skinDir: `${OGRO}skins/` },
};

// Skinned GLB monsters. clips maps the AI's animation names onto the file's
// clips; a model with no death clip gets a procedural fall (see ZombieManager).
export const GLB_MODELS = {
  hellhound: {
    url: "/models/zombie_dog_animation.glb",
    clips: { stand: "idle", walk: "walk", run: "run", attack: "attack 3", pain1: "hit 2", jump: "Jump Edit" },
  },
  dragon: {
    url: "/models/dragon_gold.glb",
    clips: { stand: "Idle", run: "RideFlyRun", attack: "RideFlyRun" },
  },
};

export const WEAPON_MODELS = {
  machinegun: { model: `${RATA}w_machinegun.md2`, skin: `${RATA}skins/w_machinegun.png` },
  shotgun:    { model: `${RATA}w_shotgun.md2`,    skin: `${RATA}skins/w_shotgun.png` },
  blaster:    { model: `${RATA}w_blaster.md2`,    skin: `${RATA}skins/w_blaster.png` },
  club:       { model: `${OGRO}weapon.md2`,       skin: `${OGRO}skins/weapon.jpg` },
};

/**
 * Enemy guns. kind "hitscan" fires instant rays (tracers); kind "bolt" fires
 * visible projectiles you can dodge. Damage is per ray / bolt.
 */
export const ENEMY_GUNS = {
  machinegun: {
    kind: "hitscan", burst: 5, interval: 0.11, pellets: 1, damage: 5, spread: 0.03,
    aimTime: 0.6, cooldown: [1.3, 2.1], range: 34, sound: "smg", tracer: 0xff8a4a,
  },
  shotgun: {
    kind: "hitscan", burst: 1, interval: 0.1, pellets: 6, damage: 4, spread: 0.07,
    aimTime: 0.55, cooldown: [1.4, 2.2], range: 18, sound: "shotgun", tracer: 0xffb070,
  },
  blaster: {
    kind: "bolt", burst: 3, interval: 0.26, damage: 9, speed: 24, radius: 0.18, splash: 0,
    aimTime: 0.6, cooldown: [1.4, 2.2], range: 34, sound: "pistol", color: 0xffd040,
  },
  plasma: { // Warlord
    kind: "bolt", burst: 6, interval: 0.16, damage: 13, speed: 19, radius: 0.32, splash: 2.2,
    aimTime: 0.8, cooldown: [2.4, 3.4], range: 45, sound: "rifle", color: 0x7fd4ff,
  },
  firebreath: { // Dragon: fireballs that leave burning ground (ignite) and a flame trail
    kind: "bolt", burst: 4, interval: 0.2, damage: 11, speed: 21, radius: 0.5, splash: 3, spread: 0.02,
    aimTime: 1.1, cooldown: [3.2, 4.8], range: 60, sound: "flame", color: 0xff6a1a, trail: true, ignite: true,
  },
};

/**
 * Senses:
 *   sight.range (m) and sight.fov (degrees) — line of sight is required
 *   hearing — multiplier on noise radii (footsteps, gunfire, explosions, doors)
 *   hunter: true — charges straight at whatever it hears instead of investigating
 * ranged: { gun, min, max } keeps the monster between min and max metres and shoots.
 * bigBody: too large for doorways; waits outside houses.
 *
 * GLB monsters (glb: key of GLB_MODELS) also need:
 *   hitbox: spheres [radius, y, z, isHead] (y up from the feet, z forward), bodyY
 *   sepRadius — crowd spacing / melee ring; runRef / walkRef — speeds (m/s)
 *   at which the run / walk clips play at 1×; rates — clip speed overrides
 * scent (m): smells living players this close, through walls and darkness.
 * pack: spotting one alerts the rest nearby. pounce: leaping bite.
 * flying: { altitude, dive } — cruises at altitude, drops to dive to attack.
 * healthBar: always shows the overhead bar. bossBar: uses the big HUD bar.
 */
export const MONSTER_TYPES = {
  walker: {
    label: "Walker", model: "ratamahatta", skins: ["ratamahatta.png", "dead.png"],
    height: 2.43, radius: 0.15, mass: 120, hp: 100, speed: 2.8,
    melee: { damage: 6, knock: 5.5, rate: 1 },
    sight: { range: 24, fov: 120 }, hearing: 1.0,
    pool: 42, color: "#d9c39a",
    blurb: "Hunts by sight. Break line of sight to lose it.",
  },
  runner: {
    label: "Runner", model: "ratamahatta", skins: ["gearwhore.png"],
    height: 2.3, radius: 0.15, mass: 100, hp: 60, speed: 5.4,
    melee: { damage: 4, knock: 3, rate: 1.5 },
    sight: { range: 30, fov: 150 }, hearing: 0.9,
    pool: 26, color: "#ffb347",
    blurb: "Fast and fragile, with sharp eyes. Keep moving.",
  },
  listener: {
    label: "Listener", model: "ratamahatta", skins: ["ctf_b.png"],
    height: 2.43, radius: 0.15, mass: 120, hp: 130, speed: 3.6,
    melee: { damage: 8, knock: 6, rate: 1 },
    sight: { range: 7, fov: 70 }, hearing: 2.4, hunter: true,
    pool: 24, color: "#6fb7ff",
    blurb: "Nearly blind, but hears footsteps and gunfire from far away. Walk, don't sprint.",
  },
  gunner: {
    label: "Gunner", model: "ratamahatta", skins: ["ctf_r.png"],
    weapons: ["machinegun", "shotgun", "blaster"],
    height: 2.43, radius: 0.15, mass: 120, hp: 90, speed: 2.6,
    melee: { damage: 5, knock: 4, rate: 1 },
    sight: { range: 36, fov: 120 }, hearing: 1.1,
    ranged: { min: 8, max: 17 },
    pool: 18, color: "#ff5a4a",
    blurb: "Shoots back. Watch for the red laser and get behind walls; bullets don't go through them.",
  },
  brute: {
    label: "Brute", model: "ogro", skins: ["khorne.png", "gordogh.png", "darkam.png"], weapons: ["club"],
    height: 2.8, radius: 0.17, mass: 320, hp: 480, speed: 2.1,
    melee: { damage: 20, knock: 11, rate: 0.8 },
    sight: { range: 22, fov: 110 }, hearing: 0.8, bigBody: true,
    pool: 12, color: "#b06a3a",
    blurb: "Soaks up bullets and hits like a truck. Too big for doorways. Fire works.",
  },
  hound: {
    label: "Hellhound", glb: "hellhound",
    height: 1.05, mass: 90, hp: 85, speed: 7.4,
    hitbox: [[0.36, 0.5, 0.0], [0.32, 0.5, -0.42], [0.25, 0.82, 0.5, true]], bodyY: 0.55, sepRadius: 0.72,
    runRef: 7, walkRef: 1.6, walkMax: 3.2, rates: { attack: 1.6, pain1: 1.4 },
    melee: { damage: 7, knock: 4, rate: 1 },
    pounce: { min: 2.6, max: 7.5, speed: 11.5, time: 0.62, damage: 13, knock: 7, cooldown: [3, 5] },
    sight: { range: 20, fov: 200 }, hearing: 2.0, scent: 15, pack: true, voice: "hound",
    healthBar: true, pool: 18, color: "#d8452f",
    blurb: "Hunts in packs by scent, so the dark won't hide you. Watch for the leap.",
  },
  dragon: {
    // lazy: downloaded after the game has started (MonsterPool.loadLazy): it
    // only appears in later levels, and its model is the biggest download
    label: "Gold Dragon", glb: "dragon", lazy: true,
    height: 3.6, mass: 600, hp: 1500, speed: 6.5,
    hitbox: [[1.15, 1.2, -0.2], [0.7, 1.0, 1.35, true]], bodyY: 1.2, sepRadius: 1.6,
    runRef: 6, rates: { attack: 1.5, stand: 1 },
    melee: { damage: 18, knock: 10, rate: 0.8 },
    flying: { altitude: 13, dive: 8.5 }, muzzle: { y: 1.0, z: 2.3 },
    sight: { range: 75, fov: 360 }, hearing: 1.2, bigBody: true, voice: "dragon",
    ranged: { gun: "firebreath", min: 11, max: 26 },
    healthBar: true, bossBar: true, pool: 2, color: "#ffb030",
    blurb: "Circles overhead and rains fire. Get under a roof; its flames keep burning on the ground.",
  },
  boss: {
    label: "Warlord", model: "ogro", skins: ["sharokh.png"], weapons: ["club"],
    height: 3.9, radius: 0.17, mass: 900, hp: 2600, speed: 2.5,
    melee: { damage: 32, knock: 14, rate: 0.7 },
    sight: { range: 48, fov: 170 }, hearing: 1.6, bigBody: true, boss: true,
    ranged: { gun: "plasma", min: 6, max: 22 },
    pool: 3, color: "#7fd4ff",
    blurb: "The horde's leader. Dodge its plasma and keep your distance.",
  },
};

// ─── Levels ───────────────────────────────────────────────────────────────────
// total: monsters to kill. maxAlive: on the field at once. mix: spawn weights.
// boss: number of Warlords, released once `bossAt` of the level is killed.
// dragon / dragonAt: the same for dragons.
const HAND_MADE = [
  { name: "First Contact", total: 10, maxAlive: 6, mix: { walker: 1 }, introduces: "walker" },
  { name: "Fast Movers", total: 14, maxAlive: 8, mix: { walker: 0.6, runner: 0.4 }, introduces: "runner" },
  { name: "Hellhounds", total: 16, maxAlive: 9, mix: { walker: 0.4, runner: 0.2, hound: 0.4 }, introduces: "hound" },
  { name: "They Can Hear You", total: 16, maxAlive: 9, mix: { walker: 0.3, runner: 0.15, listener: 0.4, hound: 0.15 }, introduces: "listener" },
  { name: "Armed and Dangerous", total: 18, maxAlive: 10, mix: { walker: 0.25, runner: 0.15, listener: 0.15, gunner: 0.3, hound: 0.15 }, introduces: "gunner" },
  { name: "Heavy Hitters", total: 20, maxAlive: 11, mix: { walker: 0.25, runner: 0.15, listener: 0.15, gunner: 0.2, brute: 0.15, hound: 0.1 }, introduces: "brute" },
  { name: "Wings of Fire", total: 18, maxAlive: 10, dragon: 1, dragonAt: 0.25, mix: { walker: 0.3, runner: 0.2, listener: 0.15, gunner: 0.15, hound: 0.2 }, introduces: "dragon" },
  { name: "The Warlord", total: 18, maxAlive: 10, boss: 1, bossAt: 0.3, mix: { walker: 0.25, runner: 0.2, listener: 0.15, gunner: 0.2, brute: 0.1, hound: 0.1 }, introduces: "boss" },
];

const LATE_NAMES = ["No Rest", "Blood Moon", "The Long Night", "Siege", "Overrun", "Last Light", "Hell Gate", "Endless"];

/** Level config for any level number (1-based). Past the hand-made ones it scales up. */
export function getLevel(n) {
  if (n <= HAND_MADE.length) return { n, hpMul: 1, damageMul: 1, speedMul: 1, ...HAND_MADE[n - 1] };
  const k = n - HAND_MADE.length;
  return {
    n,
    name: LATE_NAMES[(k - 1) % LATE_NAMES.length],
    total: Math.min(60, 20 + 3 * k),
    maxAlive: Math.min(22, 11 + k),
    mix: { walker: 0.22, runner: 0.2, listener: 0.16, gunner: 0.2, brute: 0.1, hound: 0.14 },
    boss: k % 5 === 0 ? 1 + Math.floor(k / 10) : 0,
    bossAt: 0.5,
    dragon: k % 3 === 0 ? 1 + (k >= 9 ? 1 : 0) : 0,
    dragonAt: 0.35,
    hpMul: 1 + 0.1 * k,
    damageMul: 1 + 0.06 * k,
    speedMul: Math.min(1.25, 1 + 0.02 * k),
  };
}
