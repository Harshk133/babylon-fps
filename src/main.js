import "./style.css";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import GUI from "lil-gui";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLLoader } from "three/addons/loaders/VRMLLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { ZombieManager } from "./zombies/ZombieManager.js";
import { Soldier } from "./player/Soldier.js";
import { Effects } from "./combat/Effects.js";
import { Sfx } from "./combat/Sfx.js";
import { Throwables } from "./combat/Throwables.js";
import { FireFX } from "./combat/FireFX.js";
import { SmokeFX } from "./combat/SmokeFX.js";
import { Minimap } from "./ui/Minimap.js";
import { WorldMap } from "./ui/WorldMap.js";
import { Waypoints } from "./ui/Waypoints.js";
import { Houses, houseHalfSize } from "./world/Houses.js";
import { EnemyFire } from "./combat/EnemyFire.js";
import { LevelDirector } from "./zombies/LevelDirector.js";
import { MONSTER_TYPES } from "./zombies/MonsterTypes.js";
import { GameHUD } from "./ui/GameHUD.js";
import { HealthBars } from "./ui/HealthBars.js";
import { Environment } from "./world/Environment.js";
import { Weather } from "./world/Weather.js";
import { Atmosphere } from "./world/Atmosphere.js";
import { plantDeadForest } from "./world/Forest.js";
import { buildTerrain, groundHeight, flatHeight, rawHeight, PLAY_RADIUS } from "./world/Terrain.js";
import { Roads, ROAD_HALF } from "./world/Roads.js";
import { ROAD_DEFS, layoutTowns } from "./world/Towns.js";
import { Backdrop } from "./world/Backdrop.js";
import { Grass, GRASS_FLATTENERS } from "./world/Grass.js";
import { Caves, caveTerrain, caveGrass, caveBlocks, precomputeCaves } from "./world/Caves.js";
import { scatterRocks } from "./world/Rocks.js";
import { COLLEGE_GATE, placeCollegeGate } from "./world/CollegeGate.js";
import { loadIndiaModels } from "./world/IndiaAssets.js";
import { propSpots, placeIndiaProps } from "./world/IndiaProps.js";
import { mergeStaticMeshes } from "./world/MergeStatic.js";
import { Vehicle, VEHICLES, standInJeep } from "./vehicles/Vehicle.js";
import { QUALITY, QUALITY_NAME, QUALITY_SETTING, QUALITY_PRESETS, saveQuality } from "./quality.js";
import { Net } from "./net/Net.js";
import { RemotePlayers, PHASE_GROUND, PHASE_PLANE, PHASE_FALL, PHASE_CHUTE } from "./net/RemotePlayers.js";
import { MonsterSync } from "./net/MonsterSync.js";
import { MonsterAudio } from "./audio/MonsterAudio.js";
import { Lobby } from "./net/Lobby.js";
import { BrHud } from "./br/BrHud.js";
import { ZoneWall, createPlane, updatePlane, createParachute, setSkydivePose } from "./br/BrVisuals.js";
import {
  PLANE, FREEFALL, CHUTE, BR_AUTO_START, BR_END_HOLD, BR_WARMUP_RESPAWN, BR_MAX_PLAYERS,
  PVP_DAMAGE, PVP_HEADSHOT, PVP_HEAD_Y, BR_GUN_RESERVE,
  planeRoute, planeAt, zoneCircles, zoneAt, lootPlan, fmtClock,
} from "./br/BattleRoyale.js";
import { ENEMY_GUNS, getLevel } from "./zombies/MonsterTypes.js";
import {
  WEAPONS, WEAPON_ORDER, HEAD_HEIGHT, GRENADE, MOLOTOV, MEDKIT, BISCUIT, CASH, THROWABLES, THROWABLE_ORDER,
  SMOKE, SMOKE_COLORS, GEAR, ATTACHMENTS, HELMET_MONSTER_SHARE, VEST_BLAST_SHARE,
} from "./combat/weapons.js";
import { weaponStats } from "./items/ItemDefs.js";
import { LootActions } from "./inventory/LootActions.js";
import { LootScreen } from "./ui/LootScreen.js";
import { Inventory } from "./inventory/Inventory.js";
import { InventoryUI } from "./inventory/InventoryUI.js";
import { Pickups } from "./pickups/Pickups.js";
import { renderItemIcon, setItemModel, cloneItem } from "./items/ItemModels.js";
import { applyStaticIcons, gameItemIcon } from "./ui/applyIcons.js";
import { icon } from "./ui/gameIcons.js";
import { SHOP_ITEMS, ShopUI, fmtRupees } from "./economy/Shop.js";
import { shopSpots, buildShops, SHOP_RANGE } from "./world/Shops.js";
import { WeaponWheel } from "./ui/WeaponWheel.js";
import { KillStreak } from "./ui/KillStreak.js";
import { PostFX } from "./render/PostFX.js";
import { Confetti } from "./ui/Confetti.js";
import { ScreenBlood } from "./ui/ScreenBlood.js";
import { Progress } from "./meta/Progress.js";
import { ProgressUI } from "./ui/ProgressUI.js";
import { TouchControls, IS_TOUCH, IS_NATIVE } from "./input/TouchControls.js";
import { STANCES, setCapsuleStance } from "./player/Stance.js";
import { PerfOverlay, PERF_ENABLED, BENCH_ENABLED } from "./debug/PerfOverlay.js";
import { StaticGridBroadphase } from "./physics/StaticGridBroadphase.js";
import { GROUP_WORLD, GROUP_PLAYER, GROUP_ZOMBIE } from "./physicsGroups.js";

// ─── Game mode ────────────────────────────────────────────────────────────────
// "solo" and "coop" fight the horde; "br" is the battle royale (players vs players)
let gameMode = "solo";
const isBR = () => gameMode === "br";

// ─── Constants ────────────────────────────────────────────────────────────────
const JOG_SPEED           = 5.2;   // m/s — default movement
const BACKPEDAL_SPEED     = 3.6;
const STRAFE_SPEED        = 4.6;
const SPRINT_SPEED        = 8.0;   // Shift + W, can't shoot while sprinting
const AIM_MOVE_MULTIPLIER = 0.62;  // slower while aiming down sights
const JUMP_VELOCITY       = 5.5;
const CHARACTER_HEIGHT    = 1.8;
const CHARACTER_RADIUS    = 0.35;
const CAPSULE_HEIGHT      = CHARACTER_HEIGHT - CHARACTER_RADIUS * 2;
const CAPSULE_HALF_HEIGHT = CAPSULE_HEIGHT / 2;
const FEET_OFFSET         = CAPSULE_HALF_HEIGHT + CHARACTER_RADIUS;
const GROUND_SNAP_DISTANCE = 0.08;
const STEP_UP             = 0.3;   // the controller climbs ledges this high (stairs, door sills)
const MOVE_ACCEL          = 14;    // exp-blend rates: a little weight, still responsive
const MOVE_DECEL          = 12;
const AIR_CONTROL         = 2;
const ROTATION_SPEED      = 16;
const SHADOW_FRUSTUM_SIZE = 25;

// ─── World Scatter Settings ───────────────────────────────────────────────────
const BOULDER_COUNT      = 46;    // solid stones (same on every quality: they have colliders)
const COVER_ROCK_COUNT   = 34;    // big rocks to hide behind (same on every quality too)
const TREE_A_COUNT       = 5;
const TREE_B_COUNT       = 4;

// Tree sizes in player heights (the soldier is CHARACTER_HEIGHT = 1.8 m tall),
// so a tree always reads as a tree next to the player: 4–9× is 7–16 m.
const TREE_A_HEIGHT_MUL  = [5, 8.5];   // old tree with vines
const TREE_B_HEIGHT_MUL  = [3.5, 6];   // driftwood
const DEAD_TREE_COUNT    = 130;
const DEAD_TREE_HEIGHT_MUL = [4, 8];

const SCATTER_RADIUS_MIN = 18;
const SCATTER_RADIUS_MAX = 200;

// ─── Monster Settings ─────────────────────────────────────────────────────────
// Per-type size, health, speed and senses live in zombies/MonsterTypes.js
const MONSTER_LIN_DAMPING      = 0.05; // Low damping so movement is fluid
const MONSTER_ANG_DAMPING      = 1.0;

// ─── Weapons & Items ──────────────────────────────────────────────────────────
// Gun stats live in combat/weapons.js; the inventory tracks what's carried.
const SWITCH_TIME    = 0.4;   // weapon draw time after a swap
const THROW_SPEED    = 15;
const THROW_LOFT     = 4.5;
const THROW_COOLDOWN = 0.6;
const DROP_LIFETIME  = 45;    // zombie loot despawns after this many seconds

const inventory = new Inventory();
// The held gun's stats with its attachments (cached per combination); undefined when empty-handed
const currentDef = () => (inventory.current ? weaponStats(inventory.current, inventory.weapons[inventory.current].att) : undefined);

// ─── Player Health System ─────────────────────────────────────────────────────
let playerHealth     = 100;
const MAX_HEALTH     = 100;
const REGEN_DELAY    = 3.0;   // seconds after the last hit before regen kicks in
const damageOverlayEl = document.getElementById("damage-overlay");
const lowHealthEl     = document.getElementById("low-health");
const healthFillEl    = document.getElementById("health-bar-fill");
const healthTrailEl   = document.getElementById("health-bar-trail");
const healthValEl     = document.getElementById("health-val");
const threatEl        = document.getElementById("threat");
const threatCountEl   = document.getElementById("threat-count");
const deathScreenEl   = document.getElementById("death-screen");
const deathXpEl       = document.getElementById("death-xp");

let damageFlash   = 0;   // 0..1, decays every frame
let cameraTrauma  = 0;   // 0..1, drives camera shake
let timeSinceHit  = 99;
let healthTrail   = 100; // lagging "recent damage" bar
const knockbackVel = new CANNON.Vec3();

// Cached HUD values so the DOM is only touched when something changes
const hudCache = { hp: -1, trail: -1, flash: -1, low: -1, threat: -1 };

function updatePlayerHealthUI(delta) {
  const hp = Math.ceil(Math.max(0, playerHealth));
  if (hp !== hudCache.hp) {
    hudCache.hp = hp;
    if (healthFillEl) {
      healthFillEl.style.width = `${hp}%`;
      healthFillEl.classList.toggle("critical", hp <= 30);
    }
    if (healthValEl) healthValEl.textContent = `${hp}`;
    // The ECG races as you bleed
    const beat = (0.42 + hp / 100 * 0.78).toFixed(2);
    if (beat !== hudCache.beat) {
      hudCache.beat = beat;
      healthCardEl?.style.setProperty("--beat", `${beat}s`);
      healthCardEl?.classList.toggle("flatline", hp <= 0);
    }
  }

  if (timeSinceHit > 0.5) healthTrail += (playerHealth - healthTrail) * (1 - Math.exp(-4 * delta));
  if (healthTrail < playerHealth) healthTrail = playerHealth;
  const trail = Math.round(healthTrail);
  if (trail !== hudCache.trail) {
    hudCache.trail = trail;
    if (healthTrailEl) healthTrailEl.style.width = `${trail}%`;
  }

  damageFlash = Math.max(0, damageFlash - delta * 3.2);
  const flash = Math.round(damageFlash * 50) / 50;
  if (flash !== hudCache.flash) {
    hudCache.flash = flash;
    if (damageOverlayEl) damageOverlayEl.style.opacity = `${flash}`;
  }

  // No bleeding-out vignette over someone else's fight while spectating
  const low = brWatching() ? 0 : Math.round(THREE.MathUtils.clamp((40 - playerHealth) / 40, 0, 1) * 20) / 20;
  if (low !== hudCache.low) {
    hudCache.low = low;
    if (lowHealthEl) {
      lowHealthEl.style.opacity = `${low}`;
      lowHealthEl.classList.toggle("on", low > 0); // its pulse animation only runs while it shows
    }
  }
}

function updateThreatUI() {
  const n = zombieManager ? zombieManager.chasingCount : 0;
  if (n === hudCache.threat) return;
  hudCache.threat = n;
  if (threatCountEl) threatCountEl.textContent = `${n}`;
  if (threatEl) threatEl.classList.toggle("active", n > 0);
}

/**
 * srcX / srcZ: where the hit came from (shows the red direction arc).
 * kind: what armor applies: "head" (helmet), "body" (vest), "blast" (vest,
 * partly), "monster" (vest + a little helmet), "raw" (none: fire, zone, falls).
 */
function dealDamageToPlayer(amount, knockX = 0, knockZ = 0, shake = 0.45, srcX = null, srcZ = null, kind = "raw") {
  if (playerHealth <= 0 || (isBR() && (br.ghost || br.flight === PHASE_PLANE))) return;
  amount = armorAbsorb(amount, kind);
  playerHealth = Math.max(0, playerHealth - amount);
  if (srcX !== null) {
    const dx = srcX - characterBody.position.x, dz = srcZ - characterBody.position.z;
    // Angle clockwise from the camera's forward: right = (−cos, sin), forward = (sin, cos)
    const right = dx * -Math.cos(aimYaw) + dz * Math.sin(aimYaw);
    const fwd = dx * Math.sin(aimYaw) + dz * Math.cos(aimYaw);
    gameHud.hitFrom(Math.atan2(right, fwd), amount / 15);
  }
  sfx.hurt();
  postFx.hurt(Math.min(1, amount / 30));
  // Aqua blood: a spray off the body (away from whoever hit you) and drops on the screen
  if (amount > 0.5) {
    const p = characterBody.position;
    _bleedAt.set(p.x, p.y + (kind === "head" ? 0.6 : 0.2), p.z);
    const away = srcX !== null;
    effects.bleed(_bleedAt, away ? p.x - srcX : Math.random() - 0.5, away ? p.z - srcZ : Math.random() - 0.5, Math.min(22, 6 + amount * 0.5));
    let screenAngle = null;
    if (away) {
      const dx = srcX - p.x, dz = srcZ - p.z;
      screenAngle = Math.atan2(dx * -Math.cos(aimYaw) + dz * Math.sin(aimYaw), dx * Math.sin(aimYaw) + dz * Math.cos(aimYaw));
    }
    screenBlood.hit(Math.min(1, amount / 35), screenAngle);
    playerAnim.hurt(amount);
  }
  timeSinceHit = 0;
  damageFlash  = Math.min(1, damageFlash + Math.max(0.25, shake * 1.5));
  cameraTrauma = Math.min(1, cameraTrauma + shake);
  knockbackVel.x += knockX;
  knockbackVel.z += knockZ;
  if (playerHealth <= 0) onPlayerDeath();
}

/** Helmet / vest take their share of a hit and lose that much durability; broken pieces are gone. */
function armorAbsorb(amount, kind) {
  if (kind === "raw" || amount <= 0) return amount;
  let stopped = 0;
  const soak = (slot, share) => {
    const piece = inventory.gear[slot];
    if (!piece || share <= 0) return;
    const s = amount * GEAR[piece.id].reduce * share;
    stopped += s;
    if (inventory.wearGear(slot, s * 1.6)) {
      inventoryUI.feed(`${GEAR[piece.id].name} destroyed`, "info", piece.id);
      sfx.thud(null, false);
    }
  };
  if (kind === "head") soak("helmet", 1);
  else if (kind === "body") soak("vest", 1);
  else if (kind === "blast") soak("vest", VEST_BLAST_SHARE);
  else if (kind === "monster") { soak("vest", 1); soak("helmet", HELMET_MONSTER_SHARE); }
  return Math.max(0, amount - Math.min(stopped, amount * 0.75));
}

function regenPlayerHealth(amount) {
  if (playerHealth > 0 && playerHealth < MAX_HEALTH && timeSinceHit > REGEN_DELAY) {
    playerHealth = Math.min(MAX_HEALTH, playerHealth + amount);
  }
}

function onPlayerDeath() {
  cancelClimb();
  killStreak.reset();
  setStance("stand", true);
  cameraTrauma = 1;
  soldier.die();
  sfx.hurt();
  cancelThrow();
  setInventoryOpen(false);
  exitVehicle();
  if (isBR()) { brOnLocalDeath(); return; }
  if (deathKillsEl) deathKillsEl.textContent = `${killsThisLife}`;
  if (deathXpEl) deathXpEl.textContent = progress.runXp ? `+${progress.runXp.toLocaleString()} XP this life` : "";
  if (deathScreenEl) deathScreenEl.classList.add("visible");
  releaseLock();
}

function respawnPlayer() {
  cancelClimb();
  playerHealth = MAX_HEALTH;
  healthTrail  = MAX_HEALTH;
  timeSinceHit = 99;
  knockbackVel.set(0, 0, 0);
  // Co-op: come back next to a living teammate
  const mate = net.connected ? remotePlayers.targets().find(t => t.alive) : null;
  const sx = mate ? mate.pos.x + 2 : 0, sz = mate ? mate.pos.z + 2 : 0;
  exitVehicle();
  const sy = groundHeight(sx, sz);
  characterBody.position.set(sx, sy + FEET_OFFSET + 0.02, sz);
  characterBody.velocity.set(0, 0, 0);
  moveVelocity.set(0, 0, 0);
  camPivot.set(sx, sy + cameraRig.pivotHeight, sz);
  inventory.reset();
  onWeaponChanged(false);
  throwables.clear();
  fireFX.clear();
  enemyFire.clear();
  killsThisLife = 0;
  progress.resetRun();
  soldier.revive();
  setStance("stand", true);
  if (!net.connected) director?.restart(); // solo: same level, from the top
  if (deathScreenEl) deathScreenEl.classList.remove("visible");
  requestLock();
}

function requestLock() {
  // Touch screens have no pointer lock: "locked" is just the playing state
  if (IS_TOUCH) {
    if (touchPlaying) return;
    touchPlaying = true;
    goFullscreen();
    onLockChange();
    return;
  }
  // Newer browsers return a promise that rejects if the lock is refused
  const p = canvas.requestPointerLock();
  // Refused (e.g. no user gesture): show the pause screen rather than a frozen game
  if (p && p.catch) p.catch(() => onLockChange());
}

function releaseLock() {
  if (IS_TOUCH) {
    if (!touchPlaying) return;
    touchPlaying = false;
    onLockChange();
    return;
  }
  if (document.pointerLockElement) document.exitPointerLock();
}

/** Mobile browsers: go fullscreen and sideways on the first tap (the Android app already is). */
function goFullscreen() {
  if (IS_NATIVE || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  document.documentElement.requestFullscreen({ navigationUI: "hide" })
    .then(() => screen.orientation?.lock?.("landscape"))
    .catch(() => {});
}

// ─── Combat HUD ───────────────────────────────────────────────────────────────
const crosshairEl   = document.getElementById("crosshair");
const hitMarkerEl   = document.getElementById("hitmarker");
const ammoCountEl   = document.getElementById("ammo-count");
const reloadBarEl   = document.getElementById("reload-bar");
const ammoCardEl    = document.getElementById("ammo-card");
const killsEl       = document.getElementById("kills-count");
const startScreenEl = document.getElementById("start-screen");
const deathKillsEl  = document.getElementById("death-kills");

const ammoReserveEl = document.getElementById("ammo-reserve");
const ammoWeaponEl  = document.getElementById("ammo-weapon");
const ammoPipsEl    = document.getElementById("ammo-pips-fill");
const healthCardEl  = document.querySelector(".health-card");

const startTitleEl = document.getElementById("start-title");
const startVerbEl = document.getElementById("start-verb");
const pauseNoteEl = document.getElementById("pause-note");
let hasPlayed = false;   // clicked into the game at least once

/**
 * Solo freezes while the pause screen is up (Esc, Tab inventory, a lost
 * pointer lock). Co-op and the battle royale share one world, so they can't.
 */
function canPause() {
  return gameMode === "solo" && !net.connected && !bench.on;
}
function gamePaused() {
  return hud.paused && hasPlayed && playerHealth > 0 && canPause();
}

const hud = {
  paused: true,
  gap: -1, ammo: -1, reserve: null, weapon: null, reload: -1, kills: -1, low: null,
  hitTimer: 0, hitClass: "", shownPaused: null, crosshairHidden: null,
};

function showHitMarker(headshot, killed) {
  const cls = killed ? "show kill" : headshot ? "show head" : "show";
  hud.hitTimer = killed ? 0.35 : 0.14;
  if (!hitMarkerEl) return;
  // Restart the pop animation even when the class doesn't change
  hitMarkerEl.className = "";
  void hitMarkerEl.offsetWidth;
  hitMarkerEl.className = cls;
  hud.hitClass = cls;
}

function updateCombatHUD(delta) {
  // Crosshair gap follows the actual bullet spread
  const gap = Math.round(4 + currentSpread() * 420 * (62 / camera.fov));
  if (gap !== hud.gap) {
    hud.gap = gap;
    crosshairEl?.style.setProperty("--gap", `${gap}px`);
  }
  const hideCrosshair = sprinting || playerHealth <= 0 || !currentDef() || brAirborne() || drive.on || scopeShown;
  if (hideCrosshair !== hud.crosshairHidden) {
    hud.crosshairHidden = hideCrosshair;
    crosshairEl?.classList.toggle("hidden", hideCrosshair);
  }

  if (hud.hitTimer > 0) {
    hud.hitTimer -= delta;
    if (hud.hitTimer <= 0 && hitMarkerEl) {
      hitMarkerEl.className = "";
      hud.hitClass = "";
    }
  }

  const def = currentDef();
  const slot = inventory.currentSlot;
  const mag = def ? def.magSize : 1;
  const ammo = slot ? slot.ammo : 0, reserve = slot ? slot.reserve : 0;
  if (inventory.current !== hud.weapon) {
    hud.weapon = inventory.current;
    hud.ammo = -1;
    if (ammoWeaponEl) ammoWeaponEl.textContent = def ? def.short : "UNARMED";
    // One pip per round in the magazine
    ammoCardEl?.style.setProperty("--pips", `${mag}`);
  }
  if (ammo !== hud.ammo) {
    hud.ammo = ammo;
    if (ammoCountEl) ammoCountEl.textContent = `${ammo}`;
    if (ammoPipsEl) ammoPipsEl.style.clipPath = `inset(0 ${100 - (ammo / mag) * 100}% 0 0)`;
    const low = ammo <= Math.max(1, mag * 0.25);
    if (low !== hud.low) {
      hud.low = low;
      ammoCardEl?.classList.toggle("low", low);
    }
  }
  if (reserve !== hud.reserve) {
    hud.reserve = reserve;
    if (ammoReserveEl) ammoReserveEl.textContent = `/ ${reserve === Infinity ? "∞" : reserve}`;
  }

  const reload = weapon.reloading && def ? Math.round((1 - weapon.reloadTimer / def.reloadTime) * 50) / 50 : -1;
  if (reload !== hud.reload) {
    hud.reload = reload;
    ammoCardEl?.classList.toggle("reloading", reload >= 0);
    if (reloadBarEl) reloadBarEl.style.transform = `scaleX(${Math.max(0, reload)})`;
  }

  if (killsThisLife !== hud.kills) {
    hud.kills = killsThisLife;
    if (killsEl) killsEl.textContent = `${killsThisLife}`;
  }

  const showStart = hud.paused && playerHealth > 0 && !inventoryOpen && !lobby?.open && !brWatching();
  if (showStart !== hud.shownPaused) {
    hud.shownPaused = showStart;
    startScreenEl?.classList.toggle("visible", showStart);
    // After the first click in, it's a pause screen; say whether the world froze
    if (showStart && hasPlayed) {
      const frozen = canPause();
      startTitleEl.textContent = "PAUSED";
      startVerbEl.textContent = "resume";
      pauseNoteEl.textContent = frozen ? "" : isBR() ? "The match goes on without you" : "The horde doesn't wait in co-op";
    }
  }
}

// ─── Keys ─────────────────────────────────────────────────────────────────────
const keys = { forward: false, backward: false, left: false, right: false, jump: false, run: false };

// ─── Seeded Random (LCG) ──────────────────────────────────────────────────────
function makeLCG(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
const rng = makeLCG(0xdeadbeef);

function rngRange(rng, min, max) {
  return min + rng() * (max - min);
}

function scatterPositions(count, rngFn, minR, maxR, minSep) {
  const positions = [];
  let attempts = 0;
  while (positions.length < count && attempts < count * 30) {
    attempts++;
    const angle = rngFn() * Math.PI * 2;
    const r     = Math.sqrt(rngFn()) * (maxR - minR) + minR;
    const x     = Math.cos(angle) * r;
    const z     = Math.sin(angle) * r;
    let ok = true;
    for (const p of positions) {
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz < minSep * minSep) { ok = false; break; }
    }
    if (ok) positions.push({ x, z });
  }
  return positions;
}

// ─── Scene & Renderer ─────────────────────────────────────────────────────────
// Sky, fog colour/range and the lights are driven by the day/night cycle
// (world/Environment.js); these are just the starting values.
const scene = new THREE.Scene();
// Hidden things (pooled bullets and effects, parked monsters, far loot) keep
// their last matrices: nothing draws them, and they're brought up to date the
// frame they show again. Same as three's updateMatrixWorld otherwise.
function updateVisibleMatrices(o, force) {
  if (o.matrixAutoUpdate) o.updateMatrix();
  if (o.matrixWorldNeedsUpdate || force) {
    if (o.matrixWorldAutoUpdate) {
      if (o.parent === null) o.matrixWorld.copy(o.matrix);
      else o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix);
      // What SkinnedMesh.updateMatrixWorld adds: without it a skinned GLB
      // (hellhound, dragon) keeps the inverse from its parking spot at
      // y = −500 and is drawn 500 m up in the sky, health bar left behind
      if (o.isSkinnedMesh && o.bindMode === THREE.AttachedBindMode) o.bindMatrixInverse.copy(o.matrixWorld).invert();
    }
    o.matrixWorldNeedsUpdate = false;
    force = true;
  }
  const children = o.children;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.visible && (c.matrixWorldAutoUpdate || force)) updateVisibleMatrices(c, force);
  }
}
scene.updateMatrixWorld = function (force) { updateVisibleMatrices(this, force); };
scene.fog = new THREE.Fog(0xb08468, 35, 190);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.5, 220);

const canvas = document.getElementById("webgl");
// No logarithmic depth: near/far of 0.5/220 doesn't need it, and log depth
// writes gl_FragDepth, which disables early-Z for every pixel in the scene.
// Antialiasing is the first thing old integrated GPUs can't afford, so only High has it
// With post-processing on, the MSAA lives on PostFX's scene target instead
const renderer = new THREE.WebGLRenderer({ canvas, antialias: QUALITY.antialias && QUALITY.post === "off", powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
// Asking the driver whether each program linked waits for it to finish compiling,
// one program at a time; in a release build that stall is pure loading time
renderer.debug.checkShaderErrors = import.meta.env.DEV;

// ─── Dynamic resolution ───────────────────────────────────────────────────────
// Drops the render scale when frames run long and creeps back up when there's
// headroom, so a heavy moment (big horde, explosions) costs sharpness, not FPS.
const MAX_PIXEL_RATIO = Math.min(window.devicePixelRatio, QUALITY.pixelRatioMax);
const MIN_PIXEL_RATIO = Math.min(QUALITY.pixelRatioMin, MAX_PIXEL_RATIO);
const perf = { ratio: MAX_PIXEL_RATIO, avg: 16.7, logic: 8, slow: 0, fast: 0, upWait: 3000, raisedAt: -1e9 };
renderer.setPixelRatio(perf.ratio);

/**
 * frameMs: time since the last frame. cpuMs: JavaScript spent on the frame,
 * game logic (physics, AI, animation) and issuing the draw calls. When that
 * eats most of the frame, the CPU is the limit (typical on phones, and on
 * integrated GPUs with many draw calls) and a lower resolution would only blur
 * the picture without making it any faster, so it stays sharp.
 *
 * Every change reallocates the canvas and the post-processing targets (a
 * hitch), so it backs off: a raise that gets taken back within 8 s doubles
 * the wait before the next try (up to a minute).
 */
function updateDynamicResolution(frameMs, cpuMs) {
  perf.avg += (Math.min(frameMs, 100) - perf.avg) * 0.05;
  perf.logic += (Math.min(cpuMs, 100) - perf.logic) * 0.05;
  const cpuBound = perf.logic > perf.avg * 0.6;
  // Frame budget: 60 FPS, or 30 when a phone is capped there (a capped frame isn't a slow one)
  const budget = 1000 / frameCap();
  updateAutoFps(frameMs);
  if (perf.avg > budget * 1.2 && !cpuBound) { perf.slow += frameMs; perf.fast = 0; }
  else if (perf.avg < budget * 0.84) { perf.fast += frameMs; perf.slow = 0; }
  else { perf.slow = 0; perf.fast = 0; }

  let next = perf.ratio;
  const now = performance.now();
  if (perf.slow > 600) {
    next = Math.max(MIN_PIXEL_RATIO, perf.ratio - 0.1);
    if (next !== perf.ratio && now - perf.raisedAt < 8000) perf.upWait = Math.min(60000, perf.upWait * 2);
  } else if (perf.fast > perf.upWait) {
    next = Math.min(MAX_PIXEL_RATIO, perf.ratio + 0.05);
    if (next !== perf.ratio) perf.raisedAt = now;
  }
  if (next !== perf.ratio) {
    perf.ratio = next;
    perf.slow = 0;
    perf.fast = 0;
    renderer.setPixelRatio(next);
    syncPostSize();
  }
}
// Low: no shadow map at all. Medium: redrawn every other frame. High: every frame.
renderer.shadowMap.enabled = QUALITY.shadows;
// (PCFSoftShadowMap is gone from three r18x: it only warns and falls back, and
// combined with the every-other-frame redraw it broke rendering on phones)
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = QUALITY.shadowEvery === 1;
// Two passes per frame: distant mountains + sky (Backdrop), then the game scene
renderer.autoClear = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

// Bloom + a colour grade that follows the game (src/render/PostFX.js)
const postFx = new PostFX(renderer, { mode: QUALITY.post, samples: QUALITY.antialias ? 4 : 0 });
const _postSize = new THREE.Vector2();
function syncPostSize() {
  renderer.getDrawingBufferSize(_postSize);
  postFx.setSize(_postSize.x, _postSize.y);
}

const effects = new Effects(scene);
// Blood drops land on the terrain, or on the asphalt (drawn up to 10 cm over the levelled ground)
effects.groundAt = (x, z) => groundHeight(x, z) + (roads && roads.distance(x, z) < ROAD_HALF ? 0.11 : 0);
const screenBlood = new ScreenBlood();             // aqua drops on the screen when you're hit
const _bleedAt = new THREE.Vector3();
// HRTF 3D audio on desktop (headphones hear left / right / behind); phones pan cheaper.
// The samples start downloading now, alongside the models.
const sfx = new Sfx({ hrtf: !IS_TOUCH });
sfx.preload();

// ─── Physics World ────────────────────────────────────────────────────────────
const world = new CANNON.World();
world.gravity.set(0, -20, 0); // Earth gravity
// Static bodies in a grid, built once; only moving bodies are swept each step
// (physics/StaticGridBroadphase.js). Pairs are confirmed by bounding boxes, not
// bounding spheres: long walls, roads and flat static bodies have spheres far
// bigger than they are.
world.broadphase = new StaticGridBroadphase(world);
world.allowSleep = true;
world.solver.iterations = 8;
world.solver.tolerance = 0.0001;
// cannon's default collision matrix is an n²/2 array cleared every step: with
// ~440 bodies that's ~96k entries wiped up to 3× a frame. The object matrix only
// stores pairs that actually touch.
world.collisionMatrix = new CANNON.ObjectCollisionMatrix();
world.collisionMatrixPrevious = new CANNON.ObjectCollisionMatrix();

const groundMaterial    = new CANNON.Material("ground");
const characterMaterial = new CANNON.Material("character");
const staticMaterial    = new CANNON.Material("static");
const monsterMaterial   = new CANNON.Material("monster");
const projectileMaterial = new CANNON.Material("projectile");

// The controller sets the player's velocity directly every frame, so friction
// would only fight it (and make the player stick to walls instead of sliding)
const contactDefaults = {
  friction: 0.0, restitution: 0,
  contactEquationStiffness: 1e7, contactEquationRelaxation: 3,
  frictionEquationStiffness: 1e7, frictionEquationRelaxation: 3,
};
world.addContactMaterial(new CANNON.ContactMaterial(groundMaterial, characterMaterial, contactDefaults));
world.addContactMaterial(new CANNON.ContactMaterial(staticMaterial,  characterMaterial, contactDefaults));

// Non-sticking ground contact for Monster movement
world.addContactMaterial(new CANNON.ContactMaterial(groundMaterial, monsterMaterial, {
  friction: 0.0, restitution: 0,
  contactEquationStiffness: 1e7, contactEquationRelaxation: 3,
}));
// Frictionless so player/zombie and zombie/zombie bodies slide apart instead of climbing
world.addContactMaterial(new CANNON.ContactMaterial(characterMaterial, monsterMaterial, {
  friction: 0.0, restitution: 0,
  contactEquationStiffness: 1e7, contactEquationRelaxation: 3,
}));
world.addContactMaterial(new CANNON.ContactMaterial(monsterMaterial, monsterMaterial, {
  friction: 0.0, restitution: 0,
  contactEquationStiffness: 1e7, contactEquationRelaxation: 3,
}));
// Frictionless too: zombies slide along walls and door jambs instead of sticking to them
world.addContactMaterial(new CANNON.ContactMaterial(staticMaterial, monsterMaterial, {
  friction: 0.0, restitution: 0,
  contactEquationStiffness: 1e7, contactEquationRelaxation: 3,
}));

// Grenades bounce and roll a little; molotovs shatter on the first contact anyway
world.addContactMaterial(new CANNON.ContactMaterial(groundMaterial, projectileMaterial, { friction: 0.5, restitution: 0.3 }));
world.addContactMaterial(new CANNON.ContactMaterial(staticMaterial, projectileMaterial, { friction: 0.3, restitution: 0.4 }));
world.addContactMaterial(new CANNON.ContactMaterial(monsterMaterial, projectileMaterial, { friction: 0.2, restitution: 0.2 }));

// ─── Static objects ───────────────────────────────────────────────────────────
// Things that never move skip the per-frame matrix recompute.
function freezeStatic(root) {
  root.updateMatrixWorld(true);
  root.traverse(o => { o.matrixAutoUpdate = false; });
}

// Footprints of world objects for the minimap, and solid rects zombies path around
const mapObstacles = [];
const navObstacles = [];
let caves = null;          // world/Caves.js, built in loadWorld()
let indiaBuildings = null; // world/IndiaProps.js: the panchayat offices and town buildings you can walk into
let caveMapShapes = [];
/** What you'd stand on from above: the ground, or the top of a cave hill. */
function surfaceHeight(x, z) {
  return caves?.topAt(x, z) ?? groundHeight(x, z);
}

// ─── Collider Helpers ─────────────────────────────────────────────────────────
function addTreeCollider(x, y, z, rotY, scale, trunkR, trunkH, crownR, crownY) {
  const body = new CANNON.Body({ mass: 0, material: staticMaterial });
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.01;
  body.sleepTimeLimit  = 0.1;

  // cannon-es cylinders are already Y-up: no rotation (a rotated one lies sideways in the air)
  const trunk = new CANNON.Cylinder(trunkR * scale, trunkR * scale, trunkH * scale, 8);
  body.addShape(trunk, new CANNON.Vec3(0, (trunkH * scale) / 2, 0));

  const canopy = new CANNON.Sphere(crownR * scale);
  body.addShape(canopy, new CANNON.Vec3(0, crownY * scale, 0));

  body.position.set(x, y, z);
  body.quaternion.setFromEuler(0, rotY, 0);
  world.addBody(body);
  mapObstacles.push({ type: "circle", x, z, r: Math.max(0.8, crownR * scale * 0.7) });
}

function addBoxCollider(x, y, z, rotY, scale, sizeX, sizeY, sizeZ, centreY) {
  const body = new CANNON.Body({ mass: 0, material: staticMaterial });
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.01;
  body.sleepTimeLimit  = 0.1;

  const box = new CANNON.Box(new CANNON.Vec3(
    (sizeX * scale) / 2,
    (sizeY * scale) / 2,
    (sizeZ * scale) / 2
  ));
  body.addShape(box, new CANNON.Vec3(0, centreY * scale, 0));
  body.position.set(x, y, z);
  body.quaternion.setFromEuler(0, rotY, 0);
  world.addBody(body);
  mapObstacles.push({ type: "box", x, z, w: sizeX * scale, d: sizeZ * scale, rot: rotY });
}

function addCapsuleToBody(body, radius, height) {
  const hh = height / 2;
  // cannon-es Cylinder is Y-aligned already. Rotating it (old cannon.js habit)
  // turned the capsule's middle into a 1.1 m horizontal bar along world Z,
  // which snagged on door jambs and made the player wider than a doorway.
  body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, -hh, 0));
  body.addShape(new CANNON.Cylinder(radius, radius, height, 12), new CANNON.Vec3(0, 0, 0));
  body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0,  hh, 0));
}

// ─── Ground ───────────────────────────────────────────────────────────────────
const textureLoader = new THREE.TextureLoader();
// Prefer the downsized copy from `npm run optimize-assets`, fall back to the original
const grassTexture  = textureLoader.load("/texture/grass2.opt.jpg", undefined, undefined, () => {
  textureLoader.load("/texture/grass2.jpg", img => { grassTexture.image = img.image; grassTexture.needsUpdate = true; });
});
grassTexture.wrapS = THREE.RepeatWrapping;
grassTexture.wrapT = THREE.RepeatWrapping;
// The terrain's UVs are world metres / 2, so the texture tiles every 2 m
grassTexture.colorSpace  = THREE.SRGBColorSpace;
grassTexture.anisotropy  = Math.min(renderer.capabilities.getMaxAnisotropy(), QUALITY.anisotropy);
grassTexture.minFilter   = THREE.LinearMipmapLinearFilter;
grassTexture.magFilter   = THREE.LinearFilter;
grassTexture.generateMipmaps = true;

const planeMaterial = new THREE.MeshStandardMaterial({
  map: grassTexture, roughness: 0.95, metalness: 0.02,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});

// The rolling heightmap ground (world/Terrain.js) is built in loadWorld(),
// once the houses are placed, because it flattens itself under them. This
// plane far below only catches anything that ever slips through it.
const groundBody = new CANNON.Body({ mass: 0, material: groundMaterial });
groundBody.addShape(new CANNON.Plane());
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
groundBody.position.y = -40;
world.addBody(groundBody);

// ─── Lighting ─────────────────────────────────────────────────────────────────
// Colours and intensities are set every frame by the day/night cycle
const hemiLight = new THREE.HemisphereLight(0x9fb4d8, 0x4a3a2c, 0.9);
const ambientLight = new THREE.AmbientLight(0xffe2c8, 0.25);
scene.add(hemiLight, ambientLight);
const sun = new THREE.DirectionalLight(0xffc48a, 2.4); // the moon at night
sun.position.set(6, 12, 4);
sun.castShadow = QUALITY.shadows;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near   = 1;
sun.shadow.camera.far    = 60;
sun.shadow.camera.left   = -SHADOW_FRUSTUM_SIZE;
sun.shadow.camera.right  =  SHADOW_FRUSTUM_SIZE;
sun.shadow.camera.top    =  SHADOW_FRUSTUM_SIZE;
sun.shadow.camera.bottom = -SHADOW_FRUSTUM_SIZE;
sun.shadow.bias          = -0.0003;
sun.shadow.normalBias    = 0.05;
// Soft fill from the camera side so the player and zombies don't turn into pure
// silhouettes when looking away from the low sun
const fillLight = new THREE.DirectionalLight(0xc8d4ff, 0.55);
camera.add(fillLight);
fillLight.position.set(0, 1, 1);
fillLight.target.position.set(0, 0, -1);
camera.add(fillLight.target);
scene.add(camera);
const sunTarget = new THREE.Object3D();
scene.add(sunTarget);
sun.target = sunTarget;
scene.add(sun);

// Flashlight (F): a spot from the camera along the aim. It's always in the
// scene (intensity 0 when off) so toggling never recompiles shaders. At night
// it's the difference between seeing and not, but monsters see it too.
const FLASHLIGHT_INTENSITY = 160;
const flashlight = new THREE.SpotLight(0xfff1d6, 0, 46, 0.42, 0.55, 1.6);
flashlight.castShadow = false;
scene.add(flashlight, flashlight.target);
const torch = { on: false, manual: false, level: 0, hinted: false };

// Always a clear, sunny midday: no day/night cycle and no rain
const env = new Environment({ scene, renderer, lights: { hemi: hemiLight, ambient: ambientLight, sun }, startHour: 12 });
env.paused = true;
const weather = new Weather(scene, "clear", QUALITY.rain);
weather.locked = true;
const atmosphere = new Atmosphere(scene, QUALITY.mist);
const grass = new Grass(scene, QUALITY.grass);
const backdrop = new Backdrop({ segments: QUALITY.mountainSegments });
backdrop.adoptSky(env.sky);
const healthBars = new HealthBars(scene);

// ─── Character Physics & Root ─────────────────────────────────────────────────
const characterRoot = new THREE.Group();
scene.add(characterRoot);

const characterBody = new CANNON.Body({
  mass: 70, material: characterMaterial,
  linearDamping: 0.08, angularDamping: 1,
  fixedRotation: true,
  sleepSpeedLimit: 0.1, sleepTimeLimit: 0.5,
  collisionFilterGroup: GROUP_PLAYER,
});
addCapsuleToBody(characterBody, CHARACTER_RADIUS, CAPSULE_HEIGHT);
characterBody.position.set(0, FEET_OFFSET + 0.02, 0);
world.addBody(characterBody);

const soldier = new Soldier();
characterRoot.add(soldier.root);

let bodyYaw       = 0;     // facing of the character mesh (rad); 0 faces +Z
let turningInPlace = false;
let onGround      = false;
let jumpQueued    = false;
let sprinting     = false;

// ─── Stance: C crouches, Z goes prone (lying on the ground), as in PUBG ───────
// Each key again (or Space, or sprinting) gets you back up. Lower stances are
// slower and quieter, harder to spot and far harder to hit (Stance.js), and
// you can shoot from all of them.
let stance = "stand";
let stanceEye = STANCES.stand.eye;   // smoothed camera pivot height
const STANCE_RANK = { stand: 0, crouch: 1, prone: 2 };
const _headFrom = new CANNON.Vec3(), _headTo = new CANNON.Vec3(), _headRes = new CANNON.RaycastResult();
const headRayOpts = { collisionFilterMask: GROUP_WORLD, skipBackfaces: true };

/** Room above to rise into `next`? (a table, the stairs or a ceiling can be in the way) */
function roomToRise(next) {
  const top = STANCES[next].top ?? CAPSULE_HALF_HEIGHT;
  const p = characterBody.position;
  _headFrom.set(p.x, p.y - 0.3, p.z);
  _headTo.set(p.x, p.y + top + CHARACTER_RADIUS + 0.05, p.z);
  _headRes.reset();
  return !world.raycastClosest(_headFrom, _headTo, headRayOpts, _headRes);
}

/** force: skip the headroom check (death, respawn, driving, the drop). */
function setStance(next, force = false) {
  if (next === stance) return true;
  if (!force && STANCE_RANK[next] < STANCE_RANK[stance] && !roomToRise(next)) {
    inventoryUI.feed("No room to stand up here", "info");
    return false;
  }
  stance = next;
  setCapsuleStance(characterBody, stance, CAPSULE_HALF_HEIGHT);
  soldier.stance = stance;
  return true;
}

/** C / Z: that stance, or back up to standing if you're already in it. */
function toggleStance(which) {
  if (playerHealth <= 0 || drive.on || brAirborne()) return;
  setStance(stance === which ? "stand" : which);
}

// ─── Camera Rig (over-the-shoulder) ───────────────────────────────────────────
// Aim direction = (sin yaw·cos pitch, sin pitch, cos yaw·cos pitch); +pitch looks up.
const cameraRig = {
  pivotHeight: 1.55,
  hip:    { distance: 2.6,  shoulder: 0.55, height: 0.12, fov: 62 },
  aim:    { distance: 1.25, shoulder: 0.5,  height: 0.06, fov: 42 },
  sprint: { distance: 3.0,  shoulder: 0.45, height: 0.15, fov: 70 },
  air:    { distance: 6.5,  shoulder: 0,    height: 1.0,  fov: 72 }, // freefall / parachute
  plane:  { distance: 24,   shoulder: 0,    height: 5.0,  fov: 66 }, // riding in the drop plane
  drive:  { distance: 5.6,  shoulder: 0,    height: 0.75, fov: 68 }, // behind the auto-rickshaw
  scope:  { distance: -0.15, shoulder: 0,   height: 0.04, fov: 7 },  // down a scope: at the eye (fov = the gun's)
  fp:     { distance: 0,    shoulder: 0,    height: 0,    fov: 74 }, // first person indoors (eye from the head bone)
  followXZ: 16, followY: 9,
  pitchMin: -1.2, pitchMax: 1.0,
  sensitivity: 0.0022, aimSensitivity: 0.0012,
};
let aimYaw = 0, aimPitch = -0.12;
let aimBlend = 0, sprintBlend = 0, airBlend = 0, planeBlend = 0, driveBlend = 0;
let scopeBlend = 0;              // 0..1: looking down a scoped gun (sniper, 4x ACOG)
let fpBlend = 0;                 // 0..1: first-person view, inside a house
const FP_EYE_UP  = 0.1;          // eyes above the head joint (m)
const FP_EYE_FWD = 0.14;         // ...and in front of it, along the aim
const FP_NEAR    = 0.05;         // near plane in first person, so the gun in your hands isn't clipped
const TP_NEAR    = 0.5;
const SCOPE_AIM_FOV = 32;        // a scoped gun's shoulder-aim FOV on the way into the scope

// Scope view: the lens overlay, and your own body hidden (the camera sits in
// your head). Touched only when it flips.
const scopeEl = document.createElement("div");
scopeEl.id = "scope-overlay";
scopeEl.innerHTML = '<div class="scope-lens"><i class="scope-h"></i><i class="scope-v"></i><i class="scope-dot"></i></div>';
document.body.append(scopeEl);
let scopeShown = false;
function updateScopeView() {
  const on = scopeBlend > 0.6;
  if (on === scopeShown) return;
  scopeShown = on;
  scopeEl.classList.toggle("on", on);
  if (soldier.root) soldier.root.visible = !on;
}

/** Looking down a scope slows the mouse / gyro to match the zoom. */
function scopeLookScale() {
  return 1 - scopeBlend * (1 - Math.min(1, cameraRig.scope.fov / SCOPE_AIM_FOV));
}
let camFrac = 1;                 // 0..1 of the desired boom length after collision
let recoilPitch = 0, recoilYaw = 0;
const camPivot     = new THREE.Vector3(0, cameraRig.pivotHeight, 0);
const camOffset    = new THREE.Vector3();
const camLook      = new THREE.Vector3();
const camRight     = new THREE.Vector3();
const camRayFrom   = new CANNON.Vec3();
const camRayTo     = new CANNON.Vec3();
const camRayResult = new CANNON.RaycastResult();
const camRayOpts   = { collisionFilterMask: GROUP_WORLD, skipBackfaces: true };

// ─── Movement Helpers ─────────────────────────────────────────────────────────
const moveVelocity              = new CANNON.Vec3(); // input-driven, excludes knockback
const groundContactNormal       = new CANNON.Vec3(0, 1, 0);
const groundStickForce          = new CANNON.Vec3();
const rayOrigin                 = new CANNON.Vec3();
const rayTo                     = new CANNON.Vec3();
const rayResult                 = new CANNON.RaycastResult();
const groundRayOpts             = { collisionFilterMask: GROUP_WORLD, skipBackfaces: true };

const _doorPull = { x: 0, z: 0 };

function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ─── Input ────────────────────────────────────────────────────────────────────
const input = { fire: false, aim: false, firePressed: false };
let touchPlaying = false;
// mapHoldsPlay: the big map has freed the mouse on desktop, but the game is still on
let mapHoldsPlay = false;
const isLocked = () => touchPlaying || mapHoldsPlay || shopHoldsPlay || bench.on || document.pointerLockElement === canvas;

const SLOT_KEYS = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5 };

function setKey(code, pressed, repeat) {
  switch (code) {
    case "KeyW": case "ArrowUp":    keys.forward   = pressed; break;
    case "KeyS": case "ArrowDown":  keys.backward  = pressed; break;
    case "KeyA": case "ArrowLeft":  keys.left      = pressed; break;
    case "KeyD": case "ArrowRight": keys.right     = pressed; break;
    case "Space":
      keys.jump = pressed;
      if (pressed) jumpQueued = true;
      break;
    case "ShiftLeft": case "ShiftRight": keys.run = pressed; break;
  }
  if (repeat) return;

  // One-shot actions
  const playing = isLocked() && playerHealth > 0;
  if (pressed) {
    if (code === "Tab" || code === "KeyI") { setInventoryOpen(!inventoryOpen); return; }
    if (code === "Escape" && inventoryOpen) { if (!lootScreen.escape()) setInventoryOpen(false); return; }
    if (code === "KeyM" && !lobby.open && (isLocked() || brWatching() || worldMap.open)) { setMapOpen(!worldMap.open); return; }
    if (code === "Escape" && worldMap.open) { setMapOpen(false); return; }
    if (code === "Escape" && shopUI.open) { setShopOpen(false); return; }
    if (isBR() && !lobby.open) {
      if (code === "Enter" && net.isHost && (br.state === "warm" || br.state === "count")) { brHostStart(); return; }
      if (brWatching()) {
        if (code === "KeyA" || code === "ArrowLeft") brPickSpectate(-1);
        if (code === "KeyD" || code === "ArrowRight") brPickSpectate(1);
        return;
      }
    }
    if (!playing) return;
    if (code in SLOT_KEYS) {
      cancelWeaponWheel();
      const id = WEAPON_ORDER.find(w => WEAPONS[w].slot === SLOT_KEYS[code]);
      if (inventory.has(id)) equipWeapon(id);
      else inventoryUI.feed(`${WEAPONS[id].name} not found yet`, "info");
    }
    switch (code) {
      case "KeyR": startReload(); break;
      case "KeyE": interact(); break;
      case "KeyG": beginThrow(); break;
      case "KeyQ": cycleThrowable(); break;
      case "KeyH": useHeal(); break;
      case "KeyB": if (nearShop) setShopOpen(!shopUI.open); break;
      case "KeyF": if (nearDoor) useDoor(!nearDoor.doorOpen); else if (nearGatePart) useGate(nearGatePart); break;
      case "KeyC": toggleStance("crouch"); break;
      case "KeyZ": toggleStance("prone"); break;
      case "KeyL": useLightSwitch(); break;
      case "KeyN": toggleTorch(); break;
      case "KeyV": toggleVehicle(); break;
      case "KeyT": refuelVehicle(); break;
    }
  } else if (code === "KeyG") {
    releaseThrow();
  }
}
window.addEventListener("keydown", e => {
  if (e.code === "Tab") e.preventDefault(); // keep focus from jumping around the page
  setKey(e.code, true, e.repeat);
});
window.addEventListener("keyup", e => setKey(e.code, false, false));
canvas.addEventListener("click", () => {
  sfx.unlock();
  if (touch?.settingsEl.classList.contains("on")) return;
  if (brWatching()) { brPickSpectate(1); return; }
  if (playerHealth > 0 && !inventoryOpen && !lobby?.open) requestLock();
});
let wheelCooldown = 0;
window.addEventListener("wheel", e => {
  if (!isLocked() || e.deltaY === 0) return;
  if (worldMap.open) return; // the map zooms with its own wheel handler
  if (playerHealth <= 0) return;
  const now = performance.now();
  if (now < wheelCooldown) return;
  wheelCooldown = now + 120;
  if (drive.on || brAirborne() || inventory.ownedWeapons.length === 0) return;
  const dir = e.deltaY > 0 ? 1 : -1;
  if (!weaponWheel.isOpen) openWeaponWheel(dir);
  else if (weaponWheel.turn(dir)) sfx.click();
}, { passive: true });
canvas.addEventListener("mousedown", e => {
  if (!isLocked()) return;
  if (worldMap.open || shopUI.open) return;
  if (weaponWheel.isOpen) {
    // Left click equips the front card, right click keeps what you hold
    if (e.button === 0) confirmWeaponWheel();
    if (e.button === 2) cancelWeaponWheel();
    return;
  }
  if (e.button === 0) { input.fire = true; input.firePressed = true; }
  if (e.button === 2) input.aim = true;
});
window.addEventListener("mouseup", e => {
  if (e.button === 0) input.fire = false;
  if (e.button === 2) input.aim = false;
});
window.addEventListener("contextmenu", e => e.preventDefault());
function onLockChange() {
  if (!isLocked()) { input.fire = false; input.aim = false; cancelThrow(); if (!brWatching()) setMapOpen(false); }
  hud.paused = !isLocked();
  if (isLocked()) hasPlayed = true;
  // Silence the frozen world (the click back in resumes the audio)
  if (canPause() && hasPlayed && playerHealth > 0) {
    if (hud.paused) sfx.ctx?.suspend?.();
    else sfx.ctx?.resume?.();
  }
  // The first level starts when you first click into the game
  // (co-op clients follow the host's levels instead)
  if (isLocked() && director && director.state === "idle" && !net.isClient && !isBR() && !bench.on) director.start(1);
}
document.addEventListener("pointerlockchange", onLockChange);
document.addEventListener("mousemove", e => {
  if (!isLocked() || IS_TOUCH) return;
  if (worldMap.open) return;
  lookBy(e.movementX, e.movementY);
});

/** Mouse / touch-drag look, in mouse pixels. */
function lookBy(dx, dy) {
  if (drive.on && (dx || dy)) drive.lastMouse = performance.now() / 1000;
  const s = THREE.MathUtils.lerp(cameraRig.sensitivity, cameraRig.aimSensitivity, aimBlend) * scopeLookScale();
  aimYaw   -= dx * s;
  aimPitch -= dy * s;
  aimPitch  = THREE.MathUtils.clamp(aimPitch, cameraRig.pitchMin, cameraRig.pitchMax);
}

/** Gyro look, in radians; slowed down while scoped, like the mouse. */
function turnBy(yaw, pitch) {
  if (drive.on && Math.abs(yaw) > 0.004) drive.lastMouse = performance.now() / 1000;
  const s = THREE.MathUtils.lerp(1, cameraRig.aimSensitivity / cameraRig.sensitivity, aimBlend) * scopeLookScale();
  aimYaw   += yaw * s;
  aimPitch += pitch * s;
  aimPitch  = THREE.MathUtils.clamp(aimPitch, cameraRig.pitchMin, cameraRig.pitchMax);
}

// ─── Touch controls (phones, tablets, the Android app) ────────────────────────
const touch = IS_TOUCH ? new TouchControls({
  key: (code, pressed) => setKey(code, pressed, false),
  look: (dx, dy) => { if (isLocked()) lookBy(dx, dy); },
  turn: (yaw, pitch) => { if (isLocked()) turnBy(yaw, pitch); },
  fire(down) {
    if (down && isLocked()) { input.fire = true; input.firePressed = true; }
    else input.fire = false;
  },
  aim(on) { input.aim = on && isLocked(); },
  hotbar({ hb, id }) {
    if (playerHealth <= 0) return;
    if (hb === "weapon") {
      if (inventory.has(id)) equipWeapon(id);
      else inventoryUI.feed(`${WEAPONS[id].name} not found yet`, "info");
    } else if (hb === "throwable") {
      if (inventory.selectedThrowable !== id) selectThrowable(id);
    } else if (hb === "medkit") useHeal("medkit");
    else if (hb === "biscuit") useHeal("biscuit");
    else if (hb === "fuel") refuelVehicle();
  },
  pause: () => releaseLock(),
  unlock: () => sfx.unlock(),
}) : null;

// Android back button: close the settings / inventory / map, otherwise pause
window.addEventListener("androidback", () => {
  if (touch?.settingsEl.classList.contains("on")) touch.showSettings(false);
  else if (inventoryOpen) setInventoryOpen(false);
  else if (worldMap.open) setMapOpen(false);
  else releaseLock();
});

const _touchCtx = {
  playing: false, alive: true, aiming: false, inventoryOpen: false, lobby: false, spectating: false,
  br: false, canStart: false, driving: false, airborne: false, jumpLabel: "", throwCount: 0, healCount: 0, stance: "stand",
};
function updateTouch() {
  if (!touch) return;
  const c = _touchCtx;
  c.playing = isLocked();
  c.alive = playerHealth > 0 && !brWatching();
  c.aiming = aimBlend > 0.5 || throwAiming;
  c.inventoryOpen = inventoryOpen;
  c.lobby = !!lobby?.open;
  c.spectating = brWatching();
  c.br = isBR();
  c.canStart = isBR() && net.isHost && (br.state === "warm" || br.state === "count");
  c.driving = drive.on;
  c.airborne = brAirborne();
  c.stance = stance;
  c.jumpLabel = drive.on ? "BRAKE"
    : climb.offer === "wall" ? "CLIMB" : climb.offer === "window" ? "VAULT"
    : stance !== "stand" ? "STAND"
    : !isBR() || br.flight === PHASE_GROUND ? "JUMP"
    : br.flight === PHASE_PLANE ? "JUMP" : br.flight === PHASE_FALL ? "CHUTE" : "";
  c.throwCount = inventory.throwables[inventory.selectedThrowable] ?? 0;
  c.healCount = inventory.medkits + inventory.biscuits;
  touch.update(c);
}

// ─── Ground Check ─────────────────────────────────────────────────────────────
let groundRayHit = false;   // checkGrounded's ray, reused by snapCharacterToGround (same spot)
function checkGrounded() {
  onGround = false;
  rayOrigin.set(characterBody.position.x, characterBody.position.y + 0.05,          characterBody.position.z);
  rayTo    .set(characterBody.position.x, characterBody.position.y - FEET_OFFSET - 0.45, characterBody.position.z);
  const hit = world.raycastClosest(rayOrigin, rayTo, groundRayOpts, rayResult);
  groundRayHit = hit;
  if (!hit) return;
  const dist = rayResult.distance - FEET_OFFSET;
  if (dist <= GROUND_SNAP_DISTANCE && characterBody.velocity.y <= 0.75) {
    onGround = true;
    groundContactNormal.set(rayResult.hitNormalWorld.x, rayResult.hitNormalWorld.y, rayResult.hitNormalWorld.z);
  }
}

function applyGroundStickForce(delta) {
  if (!onGround) return;
  if (characterBody.velocity.y < 0) characterBody.velocity.y = 0;
  const f = 70 * characterBody.mass * delta;
  groundStickForce.set(-groundContactNormal.x * f, -groundContactNormal.y * f, -groundContactNormal.z * f);
  characterBody.applyForce(groundStickForce);
}

function snapCharacterToGround() {
  if (!onGround) return;
  // Runs right after checkGrounded with the body where it was: reuse its ray
  if (groundRayHit) {
    const d = rayResult.distance - FEET_OFFSET;
    if (d < GROUND_SNAP_DISTANCE && d > -STEP_UP) characterBody.position.y -= d;
  }
  if (characterBody.velocity.y < 0) characterBody.velocity.y = 0;
}

// ─── Movement ─────────────────────────────────────────────────────────────────
// WASD is camera-relative; the body turns to face the aim direction (strafe mode)
function updateCharacterMovement(delta) {
  const alive = playerHealth > 0;
  let ix = 0, iz = 0; // ix: +right, iz: +forward
  if (alive && !inventoryOpen) {
    if (keys.forward)  iz += 1;
    if (keys.backward) iz -= 1;
    if (keys.right)    ix += 1;
    if (keys.left)     ix -= 1;
    if (touch) { ix += touch.moveX; iz += touch.moveY; }
  }
  const len = Math.hypot(ix, iz);
  const movingInput = len > 0;
  const analog = Math.min(1, len); // keys always give 1; the joystick less near its centre
  if (movingInput) { ix /= len; iz /= len; }

  sprinting = alive && (keys.run || !!touch?.sprint) && iz > 0.5 && !input.fire && !input.aim;
  // Sprinting gets you up off the ground first
  if (sprinting && stance !== "stand" && !setStance("stand")) sprinting = false;

  let speed = 0;
  if (sprinting) {
    speed = SPRINT_SPEED;
  } else if (movingInput) {
    const ax = Math.abs(ix), az = Math.abs(iz);
    speed = (az * (iz >= 0 ? JOG_SPEED : BACKPEDAL_SPEED) + ax * STRAFE_SPEED) / (ax + az);
    if (input.aim) speed *= AIM_MOVE_MULTIPLIER;
    speed *= STANCES[stance].speed;
    speed *= analog;
  }

  // forward = (sin yaw, cos yaw), right = (−cos yaw, sin yaw)
  const sy = Math.sin(aimYaw), cy = Math.cos(aimYaw);
  const targetX = (iz * sy - ix * cy) * speed;
  const targetZ = (iz * cy + ix * sy) * speed;

  // Knockback rides on top of the input-driven velocity and decays on its own
  const rate = onGround ? (movingInput ? MOVE_ACCEL : MOVE_DECEL) : AIR_CONTROL;
  const blend = 1 - Math.exp(-rate * delta);
  moveVelocity.x += (targetX - moveVelocity.x) * blend;
  moveVelocity.z += (targetZ - moveVelocity.z) * blend;
  if (!movingInput && moveVelocity.lengthSquared() < 0.01)
    moveVelocity.set(0, 0, 0);

  const knockDecay = Math.exp(-9 * delta);
  knockbackVel.x *= knockDecay;
  knockbackVel.z *= knockDecay;
  characterBody.velocity.x = moveVelocity.x + knockbackVel.x;
  characterBody.velocity.z = moveVelocity.z + knockbackVel.z;
  // Guide the player through doorways instead of snagging on the jamb
  if (houses?.doorAssist(characterBody.position.x, characterBody.position.z, moveVelocity.x, moveVelocity.z, _doorPull)) {
    characterBody.velocity.x += _doorPull.x;
    characterBody.velocity.z += _doorPull.z;
  }

  // SPACE at a window vaults through it, at a yard wall (after a moment) climbs it
  updateClimbOffer(delta);
  if (jumpQueued && alive && climb.offer) startClimb();
  // Jump from a crouch stands you up; from prone, to a crouch
  else if (jumpQueued && alive && stance !== "stand") setStance(stance === "prone" ? "crouch" : "stand");
  else if (jumpQueued && onGround && alive) {
    characterBody.velocity.y = JUMP_VELOCITY;
    jumpGrace = 0.8;
    onGround = false;
  }
  jumpQueued = false;

  // Facing: lock to the camera while moving or using the gun; when standing
  // still, only turn in place once the camera swings well past the shoulder.
  if (!alive) return;
  const engaged = movingInput || input.aim || input.fire || throwAiming || timeSinceShot < 0.6;
  const diff = angleDiff(aimYaw, bodyYaw);
  if (!engaged && Math.abs(diff) > 1.4) turningInPlace = true;
  if (turningInPlace && Math.abs(diff) < 0.05) turningInPlace = false;
  if (engaged || turningInPlace) {
    const turnRate = engaged ? ROTATION_SPEED : ROTATION_SPEED * 0.5;
    bodyYaw += diff * (1 - Math.exp(-turnRate * delta));
  }
  characterRoot.rotation.y = bodyYaw;
}

// ─── Climbing yard walls, vaulting through windows ────────────────────────────
// Stand at a compound wall facing it for CLIMB_WAIT s and SPACE climbs over it;
// face a window whose sill is between knee and chest height and SPACE vaults
// through (out of an upstairs one too: you drop from the sill). A short
// scripted move with collisions off, then gravity takes over.
const CLIMB_WAIT  = 2;      // s at a wall before the climb is offered
const CLIMB_TIME  = 1.05;   // s up and over a yard wall
const VAULT_TIME  = 0.6;    // s through a window
const CLIMB_SPLIT = 0.55;   // share of the move spent getting up to the top
const climb = {
  active: false, kind: "", t: 0, dur: 1, wait: 0, offer: "", spot: null,
  from: new THREE.Vector3(), mid: new THREE.Vector3(), to: new THREE.Vector3(), pos: new THREE.Vector3(),
  dirX: 0, dirZ: 0,
};

/** What SPACE does right now besides jumping: "wall", "window" or "". */
function updateClimbOffer(delta) {
  climb.offer = "";
  climb.spot = null;
  if (climb.active || playerHealth <= 0 || drive.on || brAirborne() || !houses
    || stance === "prone" || throwAiming || inventoryOpen) { climb.wait = 0; return; }
  const p = characterBody.position;
  const fx = Math.sin(aimYaw), fz = Math.cos(aimYaw);
  const win = onGround && houses.windowVaultSpot(p.x, p.y - FEET_OFFSET, p.z, fx, fz);
  if (win) { climb.offer = "window"; climb.spot = win; climb.wait = 0; return; }
  const wall = houses.wallClimbSpot(p.x, p.z, fx, fz);
  if (!wall) { climb.wait = 0; return; }
  // A frame or two off the ground (contact jitter) doesn't restart the wait
  climb.wait += delta;
  if (climb.wait >= CLIMB_WAIT && onGround) { climb.offer = "wall"; climb.spot = wall; }
}

function startClimb() {
  const s = climb.spot, p = characterBody.position;
  climb.kind = climb.offer;
  climb.from.set(p.x, p.y - FEET_OFFSET, p.z);
  if (climb.kind === "wall") {
    climb.mid.set(s.x, s.topY + 0.12, s.z);
    const tx = s.x + s.nx * 0.95, tz = s.z + s.nz * 0.95;
    climb.to.set(tx, groundHeight(tx, tz) + 0.05, tz);
    climb.dur = CLIMB_TIME;
  } else {
    climb.mid.set(s.x, s.sillY + 0.08, s.z);
    // Off the sill on the far side; from upstairs the fall does the rest
    climb.to.set(s.x + s.nx * 0.85, s.sillY + 0.08, s.z + s.nz * 0.85);
    climb.dur = VAULT_TIME;
  }
  bodyYaw = Math.atan2(s.nx, s.nz);
  climb.dirX = s.nx;
  climb.dirZ = s.nz;
  climb.active = true;
  climb.t = 0;
  playerAnim.gesture(climb.kind === "wall" ? "climb" : "vault", climb.dur);
  climb.wait = 0;
  climb.offer = "";
  if (stance !== "stand") setStance("stand", true);
  moveVelocity.set(0, 0, 0);
  knockbackVel.set(0, 0, 0);
  characterBody.collisionResponse = false;
  sfx.footstep(footSurface(p.x, climb.from.y, p.z), 0.7);
  makeNoise(p.x, p.z, 8, "step");
}

/** Moves the body along the climb (before the physics step; climbAfterStep pins it after). */
function updateClimb(delta) {
  climb.t += delta;
  const k = Math.min(1, climb.t / climb.dur);
  const { from, mid, to, pos } = climb;
  if (k < CLIMB_SPLIT) {
    const a = k / CLIMB_SPLIT, up = 1 - (1 - a) * (1 - a);
    pos.set(from.x + (mid.x - from.x) * a, from.y + (mid.y - from.y) * up, from.z + (mid.z - from.z) * a);
  } else {
    const a = (k - CLIMB_SPLIT) / (1 - CLIMB_SPLIT);
    pos.set(mid.x + (to.x - mid.x) * a, mid.y + (to.y - mid.y) * a * a, mid.z + (to.z - mid.z) * a);
  }
  climbAfterStep();
  characterRoot.rotation.y = bodyYaw;
  if (k >= 1) {
    climb.active = false;
    characterBody.collisionResponse = true;
    // Step off with a little momentum so it doesn't feel like a teleport
    moveVelocity.set(climb.dirX * 1.6, 0, climb.dirZ * 1.6);
    characterBody.velocity.set(moveVelocity.x, 0, moveVelocity.z);
    jumpGrace = 0.4;
  }
}

function climbAfterStep() {
  if (!climb.active) return;
  characterBody.position.set(climb.pos.x, climb.pos.y + FEET_OFFSET, climb.pos.z);
  characterBody.velocity.set(0, 0, 0);
}

/** Drops a climb in progress (death, getting in the rickshaw, a respawn). */
function cancelClimb() {
  if (!climb.active) return;
  climb.active = false;
  characterBody.collisionResponse = true;
}

// Animations beyond the clips the soldier walks and aims with (Soldier.playClip / playGesture).
// Teammates see them too: each one goes out as an "anim" message.
let airPose = 0;                 // eased 0..1: knees tucked in the air
const playerAnim = {
  clip(name, dur, weight = 1) {
    soldier.playClip(name, dur, weight);
    net.send({ t: "anim", c: name, d: dur, w: weight });
  },
  gesture(name, dur) {
    soldier.playGesture(name, dur);
    net.send({ t: "anim", g: name, d: +dur.toFixed(2) });
  },
  /** Flinch when hit: harder hits, the bigger reaction. */
  hurt(amount) {
    if (playerHealth <= 0 || soldier.gesture?.name === "vault" || soldier.gesture?.name === "climb") return;
    this.clip(amount > 18 ? "hit2" : "hit", amount > 18 ? 0.7 : 0.5, 0.4);
  },
};

function updateSoldier(delta) {
  characterRoot.updateMatrixWorld(true);
  const inAir = !onGround && !climb.active && !drive.on && !brAirborne() && Math.abs(characterBody.velocity.y) > 1.2;
  airPose += ((inAir ? 1 : 0) - airPose) * (1 - Math.exp(-10 * delta));
  const vx = characterBody.velocity.x - knockbackVel.x;
  const vz = characterBody.velocity.z - knockbackVel.z;
  const sy = Math.sin(bodyYaw), cy = Math.cos(bodyYaw);
  const alive = playerHealth > 0;
  soldier.update(delta, {
    localForward: onGround ? vx * sy + vz * cy : 0,
    localRight:   onGround ? -vx * cy + vz * sy : 0,
    // Prone always holds the gun up (the arms are what you lie on)
    // First person holds it up too, so the gun is in front of you
    aiming: alive && !sprinting && !brAirborne() && !drive.on && (input.aim || input.fire || timeSinceShot < 0.5 || stance === "prone" || fpBlend > 0.5),
    firing: timeSinceShot < 0.12,
    aimYawOffset: angleDiff(aimYaw + recoilYaw, bodyYaw),
    aimPitch: aimPitch + recoilPitch,
    health: playerHealth / MAX_HEALTH,
    air: airPose,
  });
}

// ─── Shadow / Camera ──────────────────────────────────────────────────────────
function updateSunShadow() {
  const fx = focusPos.x, fz = focusPos.z;
  const d = env.lightDir; // sun by day, moon by night
  sunTarget.position.set(fx, 0, fz);
  sun.position.set(fx + d.x * 40, d.y * 40, fz + d.z * 40);
  sun.shadow.camera.updateProjectionMatrix();
}

// ─── Flashlight, weather & mood ───────────────────────────────────────────────
const _torchAim = new THREE.Vector3();
let stingerTimer = 25;
let heartTimer = 0;
let wetness = 0;
let indoor = false;
let caveDepth = 0;        // camera underground: 0 … 1 (eased)
let caveDripTimer = 2, caveCrackleTimer = 0.5, caveHintShown = false;

/**
 * After the day/night cycle sets the lights: no sun, sky or ambient light far
 * underground (the rock's own shader already shuts them out; this is for the
 * characters and props in there), and a short, dark fog.
 */
function dimUnderground(d) {
  sun.intensity *= 1 - d;
  hemiLight.intensity *= 1 - d * 0.9;
  ambientLight.intensity *= 1 - d * 0.75;
  scene.fog.color.lerp(_caveFog, d * 0.85);
  scene.fog.near = THREE.MathUtils.lerp(scene.fog.near, 4, d);
  scene.fog.far = THREE.MathUtils.lerp(scene.fog.far, 70, d);
}
const _caveFog = new THREE.Color(0x07060a);

/** Dripping water deep in, torches crackling up close, and a hint about the flashlight. */
function updateCaveSounds(delta) {
  if (!caves || playerHealth <= 0) return;
  if (caveDepth > 0.3) {
    caveDripTimer -= delta;
    if (caveDripTimer <= 0) {
      caveDripTimer = 0.5 + Math.random() * 2.2;
      sfx.drip(caveDepth * (0.4 + Math.random() * 0.6));
    }
    if (!caveHintShown && caveDepth > 0.6) {
      caveHintShown = true;
      if (!torch.on) inventoryUI.feed("It's dark down here: F for your flashlight", "info");
    }
  }
  const p = characterBody.position;
  const d = caves.nearestTorch(p.x, p.y, p.z);
  if (d < 7) {
    caveCrackleTimer -= delta;
    if (caveCrackleTimer <= 0) {
      caveCrackleTimer = 0.08 + Math.random() * 0.35;
      sfx.crackle((1 - d / 7) * 0.8);
    }
  }
}
const DRY_GROUND = { roughness: 0.95, color: new THREE.Color(0xffffff) };
const _grassLight = new THREE.Color();
const _grassTint = new THREE.Color();
const WET_GROUND = { roughness: 0.45, color: new THREE.Color(0x8a8a8a) };

function toggleTorch() {
  torch.on = !torch.on;
  torch.manual = true;
  sfx.click();
}

function updateTorch(delta) {
  // Comes on by itself as night falls, until you switch it yourself
  if (!torch.manual) torch.on = env.darkness > 0.55;
  if (env.darkness > 0.55 && !torch.hinted) {
    torch.hinted = true;
    inventoryUI.feed(`Night falls. ${IS_TOUCH ? "The torch button" : "N"} toggles your flashlight (they can see it)`, "info");
  }
  const want = torch.on && playerHealth > 0 && !brWatching() ? 1 : 0;
  torch.level += (want - torch.level) * (1 - Math.exp(-14 * delta));
  // A faint flicker in the dark
  const flicker = 1 - (Math.random() < 0.02 ? Math.random() * 0.4 : 0);
  flashlight.intensity = FLASHLIGHT_INTENSITY * torch.level * flicker;
  // From the soldier's chest along the aim: starting at the camera would
  // floodlight the soldier's back
  camera.getWorldDirection(_torchAim);
  flashlight.position.copy(camPivot).addScaledVector(camRight, 0.15).addScaledVector(_torchAim, 0.6);
  flashlight.position.y -= 0.2;
  flashlight.target.position.copy(flashlight.position).addScaledVector(_torchAim, 12);
  flashlight.target.updateMatrixWorld();
}

// Grass is flattened round every monster and player near the camera, so
// nothing low (hellhounds especially) can hide in it on the dense presets
const TRAMPLE_RANGE = 34;            // m from the camera (grass only grows within 32)
const _trample = [];                 // reused { d, x, z, r } entries
let _trampleN = 0;
function trampleAt(x, z, r) {
  const dx = x - camera.position.x, dz = z - camera.position.z;
  const d = dx * dx + dz * dz;
  if (d > TRAMPLE_RANGE * TRAMPLE_RANGE) return;
  const e = _trample[_trampleN] ??= { d: 0, x: 0, z: 0, r: 0 };
  e.d = d; e.x = x; e.z = z; e.r = r;
  _trampleN++;
}
const _byDist = (a, b) => a.d - b.d;
function updateGrassTrample() {
  _trampleN = 0;
  trampleAt(characterBody.position.x, characterBody.position.z, 1.1);
  for (const t of remotePlayers.targets()) trampleAt(t.pos.x, t.pos.z, 1.1);
  // pool.all covers the host's monsters and a co-op client's puppets alike
  for (const m of zombieManager?.pool.all ?? []) {
    if (!m.active || m.def.flying) continue;
    trampleAt(m.root.position.x, m.root.position.z, Math.max(1.6, m.def.height * 0.75));
  }
  // Only the nearest fit in the shader; sort just the used part when there are more
  // (entries past _trampleN are dropped; trampleAt() recreates them on demand)
  if (_trampleN > GRASS_FLATTENERS) {
    _trample.length = _trampleN;
    _trample.sort(_byDist);
  }
  grass.beginFlat();
  for (let i = 0; i < _trampleN; i++) grass.flat(_trample[i].x, _trample[i].z, _trample[i].r);
  grass.endFlat();
}

function updateMood(delta) {
  // Underground: how far from daylight the camera is (0 outside … 1 deep in a cave), eased
  const deep = caves ? caves.depthAt(camera.position.x, camera.position.y, camera.position.z) : 0;
  caveDepth += (deep - caveDepth) * (1 - Math.exp(-3 * delta));
  indoor = !!houses?.houseAt(camera.position.x, camera.position.z) || !!indiaBuildings?.inside(camera.position.x, camera.position.z) || deep > 0.05;
  env.update(delta, camera, weather);
  if (caveDepth > 0.001) dimUnderground(caveDepth);
  caves?.update(delta, camera.position, renderer.domElement.height);
  weather.update(delta, camera.position, indoor);
  atmosphere.update(delta, camera.position, {
    mist: Math.max(env.darkness * 0.8, weather.rain * 0.6),
    fogColor: scene.fog.color,
    wind: weather.wind,
    rain: weather.rain,
  });
  healthBars.update(delta, zombieManager?.active ?? [], characterBody.position);
  updateTorch(delta);
  _grassLight.copy(hemiLight.color).multiplyScalar(hemiLight.intensity * 0.6);
  _grassTint.copy(sun.color).multiplyScalar(sun.intensity * 0.22);
  _grassLight.add(_grassTint);
  _grassTint.copy(ambientLight.color).multiplyScalar(ambientLight.intensity);
  _grassLight.add(_grassTint);
  grass.update(delta, camera.position, _grassLight, weather.wind, wetness);
  updateGrassTrample();

  // Rain soaks the ground (darker, glossier); it dries slowly
  wetness += ((weather.rain > 0.15 ? 1 : 0) - wetness) * (1 - Math.exp(-(weather.rain > 0.15 ? 0.08 : 0.02) * delta));
  planeMaterial.roughness = THREE.MathUtils.lerp(DRY_GROUND.roughness, WET_GROUND.roughness, wetness);
  planeMaterial.color.copy(DRY_GROUND.color).lerp(WET_GROUND.color, wetness);
  // Rain hides your scent from the hounds
  if (zombieManager) zombieManager.scentMul = 1 - weather.rain * 0.35;

  sfx.setAmbience(weather.rain * (1 - caveDepth * 0.7), Math.min(1, weather.wind / 4.5) * (1 - caveDepth * 0.85), env.darkness, indoor);
  updateCaveSounds(delta);
  // Things in the dark
  stingerTimer -= delta;
  if (stingerTimer <= 0) {
    stingerTimer = 18 + Math.random() * 30;
    if (env.darkness > 0.6 && playerHealth > 0) sfx.stinger();
  }
  // Heartbeat when hurt
  if (playerHealth > 0 && playerHealth < 35) {
    heartTimer -= delta;
    if (heartTimer <= 0) {
      heartTimer = 0.55 + playerHealth / 60;
      sfx.heartbeat(0.25 + (35 - playerHealth) / 70);
    }
  }
  gameHud.setWorld(env.timeLabel, env.phase, weather.label, torch.on, env.bloodMoon && env.darkness > 0.6);
  gameHud.setDarkness(env.darkness);
}

function rigValue(key) {
  const { hip, aim, sprint, air, plane, drive: car } = cameraRig;
  const v = THREE.MathUtils.lerp(THREE.MathUtils.lerp(hip[key], aim[key], aimBlend), sprint[key], sprintBlend);
  const w = THREE.MathUtils.lerp(THREE.MathUtils.lerp(v, air[key], airBlend), plane[key], planeBlend);
  const d = THREE.MathUtils.lerp(w, car[key], driveBlend);
  // First person zooms like the shoulder aim does
  const fp = key === "fov" ? THREE.MathUtils.lerp(cameraRig.fp.fov, aim.fov, aimBlend) : cameraRig.fp[key];
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(d, fp, fpBlend), cameraRig.scope[key], scopeBlend);
}

/** Eases the freefall / plane / driving camera presets in and out. phase: a PHASE_* drop phase. */
function blendAirRig(phase, delta, driving = false) {
  const k = 1 - Math.exp(-3 * delta);
  driveBlend += ((driving ? 1 : 0) - driveBlend) * k;
  airBlend   += ((phase === PHASE_FALL || phase === PHASE_CHUTE ? 1 : 0) - airBlend) * k;
  planeBlend += ((phase === PHASE_PLANE ? 1 : 0) - planeBlend) * k;
}

function updateThirdPersonCamera(delta) {
  const alive = playerHealth > 0;
  aimBlend    += ((input.aim && alive && !sprinting && !brAirborne() ? 1 : 0) - aimBlend) * (1 - Math.exp(-12 * delta));
  sprintBlend += ((sprinting ? 1 : 0) - sprintBlend) * (1 - Math.exp(-4 * delta));
  // A scoped gun goes on into the scope once it's up at the shoulder
  const scoped = aimBlend > 0.8 && input.aim && alive && !!currentDef()?.scope && !drive.on && !climb.active
    && weapon.switchTimer <= 0 && !weapon.reloading && !throwAiming;
  scopeBlend  += ((scoped ? 1 : 0) - scopeBlend) * (1 - Math.exp(-18 * delta));
  if (!scoped && scopeBlend < 0.01) scopeBlend = 0;
  updateScopeView();
  blendAirRig(isBR() ? br.flight : PHASE_GROUND, delta, drive.on);
  // Inside a house the camera moves into your head; outside it's the shoulder camera again
  const inside = alive && !drive.on && !climb.active && !brAirborne()
    && (!!houses?.houseAt(characterBody.position.x, characterBody.position.z)
      || !!indiaBuildings?.inside(characterBody.position.x, characterBody.position.z));
  fpBlend += ((inside ? 1 : 0) - fpBlend) * (1 - Math.exp(-8 * delta));
  if (!inside && fpBlend < 0.01) fpBlend = 0;
  soldier.setFirstPerson(fpBlend > 0.5);

  // Critically-damped style follow: tight on XZ, softer on Y so jumps/steps don't jolt
  const kxz = 1 - Math.exp(-cameraRig.followXZ * delta);
  const ky  = 1 - Math.exp(-cameraRig.followY * delta);
  camPivot.x += (characterBody.position.x - camPivot.x) * kxz;
  camPivot.z += (characterBody.position.z - camPivot.z) * kxz;
  stanceEye += (STANCES[stance].eye - stanceEye) * (1 - Math.exp(-10 * delta));
  camPivot.y += (characterBody.position.y - FEET_OFFSET + stanceEye - camPivot.y) * ky;

  recoilPitch *= Math.exp(-10 * delta);
  recoilYaw   *= Math.exp(-12 * delta);
  placeCamera(aimYaw + recoilYaw, aimPitch + recoilPitch, delta);
}

/** Battle royale spectator: the same shoulder camera, riding another player's aim. */
function updateSpectatorCamera(delta, p) {
  aimBlend    += (0 - aimBlend) * (1 - Math.exp(-12 * delta));
  scopeBlend = 0;
  updateScopeView();
  fpBlend = 0;
  soldier.setFirstPerson(false);
  sprintBlend += (0 - sprintBlend) * (1 - Math.exp(-4 * delta));
  blendAirRig(p.phase, delta, p.driving);
  const k = 1 - Math.exp(-10 * delta);
  const rp = p.root.position;
  camPivot.x += (rp.x - camPivot.x) * k;
  camPivot.z += (rp.z - camPivot.z) * k;
  camPivot.y += (rp.y + cameraRig.pivotHeight - camPivot.y) * k;
  placeCamera(p.aimYaw, p.aimPitch, delta);
}

/** Boom from camPivot along yaw / pitch, collision, shake and FOV. */
function placeCamera(yaw, rawPitch, delta) {
  const pitch = THREE.MathUtils.clamp(rawPitch, cameraRig.pitchMin, cameraRig.pitchMax);
  const cp = Math.cos(pitch);
  camLook.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
  camRight.set(-Math.cos(yaw), 0, Math.sin(yaw));

  // Boom: pivot → shoulder → back along the aim direction
  camOffset.copy(camRight).multiplyScalar(rigValue("shoulder"));
  camOffset.y += rigValue("height");
  camOffset.addScaledVector(camLook, -rigValue("distance"));

  // Pull in instantly when something blocks the boom, ease back out when clear
  const boom = camOffset.length();
  camRayFrom.set(camPivot.x, camPivot.y, camPivot.z);
  camRayTo.set(camPivot.x + camOffset.x, camPivot.y + camOffset.y, camPivot.z + camOffset.z);
  let targetFrac = 1;
  if (boom > 0.01 && world.raycastClosest(camRayFrom, camRayTo, camRayOpts, camRayResult)) {
    targetFrac = Math.max(0.1, (camRayResult.distance - 0.25) / boom);
  }
  if (targetFrac < camFrac) camFrac = targetFrac;
  else camFrac += (targetFrac - camFrac) * (1 - Math.exp(-5 * delta));

  camera.position.copy(camPivot).addScaledVector(camOffset, camFrac);
  camera.rotation.order = "YXZ";
  camera.rotation.set(pitch, yaw + Math.PI, 0);

  // Trauma-based shake: squared falloff feels punchy on a hit, then settles fast
  if (cameraTrauma > 0.001) {
    const t = clock.elapsedTime * 38;
    const s = cameraTrauma * cameraTrauma;
    camera.rotation.z += Math.sin(t * 1.3) * 0.035 * s;
    camera.rotation.x += Math.sin(t * 0.9 + 1.7) * 0.025 * s;
    camera.rotation.y += Math.sin(t * 1.1 + 4.2) * 0.025 * s;
  }

  const fov = rigValue("fov");
  const near = fpBlend > 0.3 ? FP_NEAR : TP_NEAR;
  if (Math.abs(camera.fov - fov) > 0.01 || camera.near !== near) {
    camera.fov = fov;
    camera.near = near;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
}

/**
 * First person: once the soldier is posed this frame, put the camera at its
 * eyes (the head joint follows the stance, the walk and the aim lean).
 */
const _fpEye = new THREE.Vector3();
function applyFirstPersonCamera() {
  const w = fpBlend * (1 - scopeBlend);
  if (w <= 0.001 || !soldier.root) return;
  soldier.getHeadWorldPosition(_fpEye);
  _fpEye.x += Math.sin(aimYaw) * FP_EYE_FWD;
  _fpEye.y += FP_EYE_UP;
  _fpEye.z += Math.cos(aimYaw) * FP_EYE_FWD;
  camera.position.lerp(_fpEye, w);
  camera.updateMatrixWorld();
}

// ─── Weapon ───────────────────────────────────────────────────────────────────
const weapon = { cooldown: 0, reloading: false, reloadTimer: 0, bloom: 0, switchTimer: 0, triggerLatched: false };
let timeSinceShot = 99;
let killsThisLife = 0;
let dryFireNotice = 0;

const _shotDir    = new THREE.Vector3();
const _aimDir     = new THREE.Vector3();
const _muzzle     = new THREE.Vector3();
const _hitPoint   = new THREE.Vector3();
const _shotFrom   = new CANNON.Vec3();
const _shotTo     = new CANNON.Vec3();
const _shotResult = new CANNON.RaycastResult();
const shotOpts    = { collisionFilterMask: GROUP_WORLD | GROUP_ZOMBIE, skipBackfaces: true };

function startReload() {
  if (weapon.reloading || weapon.switchTimer > 0 || playerHealth <= 0 || !inventory.canReload()) return;
  const def = currentDef();
  weapon.reloading = true;
  weapon.reloadTimer = def.reloadTime;
  playerAnim.gesture("reload", def.reloadTime);
  sfx.reload(def.reloadTime, def.sound);
}

function equipWeapon(id) {
  if (inventory.equip(id)) onWeaponChanged();
}

/** Syncs the held model, camera zoom and weapon timers to inventory.current. */
function onWeaponChanged(withSound = true) {
  const def = currentDef();
  soldier.setWeapon(inventory.current);
  // Scoped guns: a wide shoulder aim, then the real zoom inside the scope
  cameraRig.aim.fov = def ? (def.scope ? Math.max(def.aimFov, SCOPE_AIM_FOV) : def.aimFov) : 50;
  cameraRig.scope.fov = def?.scope ? def.aimFov : cameraRig.aim.fov;
  weapon.reloading = false;
  soldier.stopGesture("reload");
  weapon.bloom = 0;
  weapon.cooldown = 0;
  weapon.switchTimer = withSound ? SWITCH_TIME : 0;
  if (withSound) sfx.equip();
}

function currentSpread() {
  const def = currentDef();
  if (!def) return 0.02;
  const hSpeed = Math.hypot(characterBody.velocity.x, characterBody.velocity.z);
  const moving = THREE.MathUtils.clamp(hSpeed / JOG_SPEED, 0, 1);
  return THREE.MathUtils.lerp(def.spreadHip, def.spreadAim, aimBlend)
    + def.spreadMove * moving * (1 - aimBlend * 0.6)
    + (onGround ? 0 : def.spreadAir)
    + weapon.bloom;
}

function updateWeapon(delta) {
  const def = currentDef();
  if (!def || brAirborne() || drive.on) {
    // Empty hands, or still in the air: nothing to shoot with
    timeSinceShot += delta;
    input.firePressed = false;
    weapon.reloading = false;
    return;
  }
  weapon.cooldown = Math.max(0, weapon.cooldown - delta);
  weapon.switchTimer = Math.max(0, weapon.switchTimer - delta);
  weapon.bloom = Math.max(0, weapon.bloom - delta * def.bloomRecovery);
  timeSinceShot += delta;

  if (weapon.reloading) {
    weapon.reloadTimer -= delta;
    if (weapon.reloadTimer <= 0) {
      weapon.reloading = false;
      inventory.finishReload();
    }
  }

  const pressed = input.firePressed;
  input.firePressed = false;
  if (!input.fire) weapon.triggerLatched = false;
  if (!input.fire || playerHealth <= 0 || !isLocked() || sprinting || weapon.reloading
      || weapon.switchTimer > 0 || throwAiming) return;

  const slot = inventory.currentSlot;
  if (slot.ammo <= 0) {
    if (pressed) {
      sfx.dryFire();
      if (slot.reserve <= 0 && clock.elapsedTime > dryFireNotice) {
        dryFireNotice = clock.elapsedTime + 2;
        inventoryUI.feed(`${def.short} out of ammo — switch weapons`, "info");
      }
    }
    startReload();
    return;
  }
  // Semi-auto guns need a fresh trigger pull per shot
  if (!def.auto && weapon.triggerLatched) return;
  // Wait for the gun to come up so the first tracer leaves the barrel, not the hip
  if (soldier.aimWeight < 0.55 || weapon.cooldown > 0) return;

  fireShot(def);
  weapon.cooldown = 1 / def.fireRate;
  weapon.triggerLatched = true;
}

const shotPoints = [];
const CLOSE_SPLASH = 4.5;   // m: hits this close spatter your screen
const pvpDamage = new Map(); // player id → damage from this shot
const pvpHead = new Map();

function fireShot(def) {
  inventory.consumeRound();
  timeSinceShot = 0;

  const spread = currentSpread();
  weapon.bloom = Math.min(def.bloomMax, weapon.bloom + def.bloomPerShot);

  camera.getWorldDirection(_aimDir);
  // Start the trace level with the player so nothing between camera and player gets hit
  const startT = Math.max(0,
    (camPivot.x - camera.position.x) * _aimDir.x +
    (camPivot.y - camera.position.y) * _aimDir.y +
    (camPivot.z - camera.position.z) * _aimDir.z);
  soldier.getMuzzleWorldPosition(_muzzle);
  effects.muzzleFlash(_muzzle);
  sfx.gunshot(def.sound, def.suppressed ? 0.35 : 1);

  let anyHit = false, anyHead = false, anyKill = false;
  shotPoints.length = 0;
  // Battle royale: bullets hit other players too (never your own capsule)
  const pvp = isBR();
  shotOpts.collisionFilterMask = GROUP_WORLD | GROUP_ZOMBIE | (pvp ? GROUP_PLAYER : 0);
  const ownGroup = characterBody.collisionFilterGroup;
  characterBody.collisionFilterGroup = 0;
  pvpDamage.clear();
  pvpHead.clear();
  for (let i = 0; i < def.pellets; i++) {
    _shotDir.copy(_aimDir);
    _shotDir.x += (Math.random() - 0.5) * 2 * spread;
    _shotDir.y += (Math.random() - 0.5) * 2 * spread;
    _shotDir.z += (Math.random() - 0.5) * 2 * spread;
    _shotDir.normalize();

    _shotFrom.set(
      camera.position.x + _aimDir.x * startT,
      camera.position.y + _aimDir.y * startT,
      camera.position.z + _aimDir.z * startT);
    _shotTo.set(
      _shotFrom.x + _shotDir.x * def.range,
      _shotFrom.y + _shotDir.y * def.range,
      _shotFrom.z + _shotDir.z * def.range);

    _shotResult.reset();
    const hit = world.raycastClosest(_shotFrom, _shotTo, shotOpts, _shotResult);
    if (hit) _hitPoint.copy(_shotResult.hitPointWorld);
    else _hitPoint.set(_shotTo.x, _shotTo.y, _shotTo.z);

    if (i < def.tracersPerShot) {
      effects.tracer(_muzzle, _hitPoint);
      shotPoints.push(+_hitPoint.x.toFixed(2), +_hitPoint.y.toFixed(2), +_hitPoint.z.toFixed(2));
    }
    if (!hit) continue;

    const zombie = _shotResult.body.zombie;
    const victim = _shotResult.body.playerTarget;
    if (pvp && victim && !victim.local) {
      const head = _hitPoint.y - (_shotResult.body.position.y - FEET_OFFSET) > PVP_HEAD_Y;
      const dmg = (PVP_DAMAGE[inventory.current] ?? 15) * (head ? PVP_HEADSHOT[inventory.current] ?? 1.5 : 1);
      pvpDamage.set(victim.id, (pvpDamage.get(victim.id) ?? 0) + dmg);
      if (head) pvpHead.set(victim.id, true);
      effects.impact(_hitPoint, -_shotDir.x, 0.3, -_shotDir.z, "blood", head ? 18 : def.pellets > 1 ? 4 : 9);
      if (i === 0 && _hitPoint.distanceToSquared(camera.position) < CLOSE_SPLASH * CLOSE_SPLASH) screenBlood.splash(0.4);
      anyHit = true;
      anyHead ||= head;
    } else if (zombie && zombieManager) {
      const headshot = zombieManager.isHeadshot(zombie, _hitPoint, HEAD_HEIGHT);
      const damage = def.damage * (headshot ? def.headshotMultiplier : 1);
      zombie.killCause = headshot ? "head" : "gun";
      const killed = hitMonster(zombie, damage, _shotDir.x * def.push, _shotDir.z * def.push);
      const blood = def.pellets > 1 ? 4 : headshot ? 22 : 10;
      effects.impact(_hitPoint, -_shotDir.x, 0.3, -_shotDir.z, "blood", blood);
      if (i === 0 && _hitPoint.distanceToSquared(camera.position) < CLOSE_SPLASH * CLOSE_SPLASH) screenBlood.splash(headshot ? 0.6 : 0.35);
      anyHit = true;
      anyHead ||= headshot;
      anyKill ||= killed;
    } else {
      const n = _shotResult.hitNormalWorld;
      effects.impact(_hitPoint, n.x, n.y, n.z, "dust", def.pellets > 1 ? 3 : 7);
    }
  }

  characterBody.collisionFilterGroup = ownGroup;
  // One damage message per player hit (a shotgun blast is one hit, not nine)
  for (const [id, dmg] of pvpDamage) {
    net.send({
      t: "pvp", to: id, d: +dmg.toFixed(1), hs: pvpHead.has(id) ? 1 : 0, w: inventory.current,
      sx: +characterBody.position.x.toFixed(1), sz: +characterBody.position.z.toFixed(1),
    });
  }

  if (anyHit) {
    showHitMarker(anyHead, anyKill);
    sfx.hit(anyHead);
    if (anyKill) sfx.kill();
  }

  // Recoil: kick that recovers, plus a little permanent climb to manage
  const kick = def.recoilPitch * (1 - aimBlend * 0.45);
  recoilPitch += kick;
  recoilYaw   += (Math.random() - 0.5) * 2 * def.recoilYaw;
  aimPitch     = Math.min(cameraRig.pitchMax, aimPitch + kick * 0.25);
  cameraTrauma = Math.min(1, cameraTrauma + (def.pellets > 1 || def.damage > 100 ? 0.18 : 0.05));

  makeNoise(characterBody.position.x, characterBody.position.z, def.alertRadius, "shot");
  noteShot("me", characterBody.position.x, characterBody.position.z);
  if (net.connected) {
    net.send({ t: "shot", w: def.sound, s: def.suppressed ? 1 : undefined, f: [+_muzzle.x.toFixed(2), +_muzzle.y.toFixed(2), +_muzzle.z.toFixed(2)], h: shotPoints });
  }
}

// ─── Throwables (grenade / molotov) ───────────────────────────────────────────
let throwAiming   = false;
let throwCooldown = 0;
const _throwFrom  = new THREE.Vector3();
const _throwVel   = new THREE.Vector3();
// Grenade cook countdown: one big number under the crosshair, touched only when it changes
let cookTime      = -1;     // seconds since the pin was pulled, −1 = not cooking
let cookShown     = 0;
const cookEl = document.createElement("div");
cookEl.id = "grenade-cook";
document.body.append(cookEl);

function computeThrow() {
  // From the right shoulder, along the camera aim with some loft
  _throwFrom.set(characterBody.position.x, characterBody.position.y - FEET_OFFSET + 1.55, characterBody.position.z)
    .addScaledVector(camRight, 0.3)
    .addScaledVector(camLook, 0.35);
  _throwVel.copy(camLook).multiplyScalar(THROW_SPEED);
  _throwVel.y += THROW_LOFT;
  _throwVel.x += moveVelocity.x * 0.5;
  _throwVel.z += moveVelocity.z * 0.5;
}

function beginThrow() {
  if (throwCooldown > 0 || throwAiming || brAirborne() || drive.on) return;
  const kind = inventory.selectedThrowable;
  if (inventory.throwables[kind] <= 0) {
    inventoryUI.feed(`No ${THROWABLES[kind].name}s — ${IS_TOUCH ? "tap ⇄" : "press Q"} to switch`, "info", kind);
    return;
  }
  throwAiming = true;
  weapon.reloading = false;
  // A grenade's fuse starts with the pin: hold it to cook, the HUD counts 5…1
  cookTime = kind === "grenade" ? 0 : -1;
  if (cookTime === 0) sfx.pin();
}

function releaseThrow() {
  if (!throwAiming) return;
  throwAiming = false;
  throwables.hidePreview();
  if (playerHealth <= 0) { setCookCountdown(0); return; }
  computeThrow();
  launchThrow(cookTime >= 0 ? Math.max(0.05, GRENADE.cookTime - cookTime) : undefined);
}

/** Throws the selected item from _throwFrom at _throwVel (fuse: a cooked grenade's time left). */
function launchThrow(fuse) {
  setCookCountdown(0);
  cookTime = -1;
  const kind = inventory.takeThrowable();
  if (!kind) return;
  // Smoke comes in a random colour; c tells everyone else which
  const color = kind === "smoke" ? Math.floor(Math.random() * SMOKE_COLORS.length) : 0;
  if (kind === "smoke") sfx.pin();
  throwables.throw(kind, _throwFrom, _throwVel, localTarget.id, color, fuse);
  if (net.connected) {
    net.send({
      t: "throw", k: kind, c: color, f: fuse === undefined ? undefined : +fuse.toFixed(2),
      o: [_throwFrom.x, _throwFrom.y, _throwFrom.z].map(v => +v.toFixed(3)),
      v: [_throwVel.x, _throwVel.y, _throwVel.z].map(v => +v.toFixed(3)),
    });
  }
  throwCooldown = THROW_COOLDOWN;
}

function cancelThrow() {
  throwAiming = false;
  cookTime = -1;
  setCookCountdown(0);
  throwables.hidePreview();
}

function setCookCountdown(n) {
  if (n === cookShown) return;
  cookShown = n;
  cookEl.textContent = n > 0 ? String(n) : "";
  cookEl.classList.toggle("show", n > 0);
  cookEl.classList.toggle("hot", n > 0 && n <= 2);
  if (n > 0 && n < GRENADE.cookTime) sfx.click();
}

function cycleThrowable() {
  selectThrowable(inventory.cycleThrowable());
}

function selectThrowable(kind) {
  inventory.selectThrowable(kind);
  sfx.click();
  inventoryUI.feed(`${THROWABLES[kind].name} ready (${inventory.throwables[kind]})`, "throwable", kind);
}

function updateThrowAim(delta) {
  throwCooldown = Math.max(0, throwCooldown - delta);
  if (!throwAiming) return;
  if (playerHealth <= 0 || !isLocked()) { cancelThrow(); return; }
  computeThrow();
  if (cookTime >= 0) {
    cookTime += delta;
    if (cookTime >= GRENADE.cookTime) {
      // Held too long: it goes off in your hand
      throwAiming = false;
      throwables.hidePreview();
      _throwVel.set(0, 0, 0);
      launchThrow(0.01);
      return;
    }
    setCookCountdown(Math.ceil(GRENADE.cookTime - cookTime));
  }
  throwables.showPreview(inventory.selectedThrowable, _throwFrom, _throwVel);
}

// Walls and closed doors shield the blast (world geometry only; glass doesn't)
const _blastFrom = new CANNON.Vec3();
const _blastTo = new CANNON.Vec3();
const _blastResult = new CANNON.RaycastResult();
const blastRayOpts = { collisionFilterMask: GROUP_WORLD, skipBackfaces: true };
function blastShielded(pos, x, y, z) {
  _blastFrom.set(pos.x, pos.y + 0.3, pos.z);
  _blastTo.set(x, y, z);
  _blastResult.reset();
  return world.raycastClosest(_blastFrom, _blastTo, blastRayOpts, _blastResult);
}

function onGrenadeExplode(pos, owner = null) {
  const R = GRENADE.radius;
  let anyHit = false, anyKill = false;
  const by = owner ?? localTarget.id;
  for (const z of net.isClient ? [] : zombieManager?.active ?? []) {
    if (z.dying) continue;
    const dx = z.body.position.x - pos.x, dz = z.body.position.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d >= R) continue;
    const shield = blastShielded(pos, z.body.position.x, 1.2, z.body.position.z) ? 0.15 : 1;
    const f = (1 - d / R) * shield;
    const dmg = THREE.MathUtils.lerp(GRENADE.minDamage, GRENADE.maxDamage, f) * shield;
    const inv = d > 1e-3 ? 1 / d : 0;
    z.killCause = "blast";
    const killed = zombieManager.damage(z, dmg, dx * inv * GRENADE.push * f, dz * inv * GRENADE.push * f, by);
    anyHit = true;
    anyKill ||= killed;
  }
  if (by === localTarget.id) {
    if (anyHit) showHitMarker(false, anyKill);
    if (anyKill) sfx.kill();
  }

  const px = characterBody.position.x - pos.x, pz = characterBody.position.z - pos.z;
  const pd = Math.hypot(px, pz);
  if (pd < GRENADE.playerRadius) {
    if (by !== localTarget.id) brNoteAttacker(by, "grenade", false);
    const shield = blastShielded(pos, characterBody.position.x, characterBody.position.y + 0.4, characterBody.position.z) ? 0.15 : 1;
    const f = (1 - pd / GRENADE.playerRadius) * shield;
    const k = pd > 1e-3 ? 8 * f / pd : 0;
    dealDamageToPlayer(GRENADE.playerMaxDamage * f, px * k, pz * k, 0.6, null, null, "blast");
  }
  cameraTrauma = Math.min(1, cameraTrauma + THREE.MathUtils.clamp(1 - pd / 35, 0, 1) * 0.8);
  sfx.explosion(pos);
  if (!net.isClient) zombieManager?.noise(pos.x, pos.z, GRENADE.alertRadius, "explosion");
}

// Zombies that walk through the flames catch fire and keep burning after they
// leave (ZombieManager.ignite); the ground fire itself adds a little on top.
const BURN_TIME_TOUCH  = 6;
const BURN_TIME_DIRECT = 9;

/** hostile: dragon fire (burns players, not monsters). */
function onFireTick(x, z, r, dt, owner = null, hostile = false) {
  const r2 = r * r;
  const by = owner ?? localTarget.id;
  for (const zb of net.isClient || hostile ? [] : zombieManager?.active ?? []) {
    if (zb.dying || zb.def.flying) continue;
    const dx = zb.body.position.x - x, dz = zb.body.position.z - z;
    if (dx * dx + dz * dz < r2) {
      zb.killCause = "fire";
      zombieManager.ignite(zb, BURN_TIME_TOUCH, by);
      zombieManager.damage(zb, MOLOTOV.zombieDps * dt * 0.35, 0, 0, by);
    }
  }
  const px = characterBody.position.x - x, pz = characterBody.position.z - z;
  const pr = r + CHARACTER_RADIUS;
  if (px * px + pz * pz < pr * pr && characterBody.position.y - FEET_OFFSET - groundHeight(x, z) < 1) {
    if (!hostile && by !== localTarget.id) brNoteAttacker(by, "molotov", false);
    dealDamageToPlayer(MOLOTOV.playerDps * dt, 0, 0, 0.08);
  }
}

// ─── Healing: medkits and Parle-G ─────────────────────────────────────────────
/**
 * kind: "medkit" | "biscuit", or nothing for H: a medkit when you're badly
 * hurt (below BISCUIT.medkitBelow), otherwise a biscuit, whichever you have.
 */
function useHeal(kind = null) {
  if (playerHealth <= 0) return;
  if (playerHealth >= MAX_HEALTH) { inventoryUI.feed("Health already full", "info"); return; }
  if (!kind) {
    const wantKit = playerHealth < BISCUIT.medkitBelow;
    kind = wantKit ? (inventory.medkits ? "medkit" : "biscuit") : (inventory.biscuits ? "biscuit" : "medkit");
  }
  const ok = kind === "medkit" ? inventory.takeMedkit() : inventory.takeBiscuit();
  if (!ok) { inventoryUI.feed(kind === "medkit" ? "No medkits" : "No Parle-G left", "info", kind); return; }
  const heal = kind === "medkit" ? MEDKIT.heal : BISCUIT.heal;
  playerHealth = Math.min(MAX_HEALTH, playerHealth + heal);
  // A Parle-G goes in the mouth; a medkit gets put on
  if (kind === "biscuit") {
    if (!soldier.handProps.eat) soldier.setHandProp("eat", cloneItem("biscuit"));
    playerAnim.gesture("eat", 1.5);
  }
  else playerAnim.clip("interact", 1.2);
  sfx.heal();
  inventoryUI.feed(`+${heal} health${kind === "biscuit" ? " · Parle-G" : ""}`, "medkit", kind);
}

// ─── Pickups ──────────────────────────────────────────────────────────────────
function pickupData(kind) {
  const def = WEAPONS[kind];
  if (def) return { ammo: def.magSize, reserve: isBR() ? BR_GUN_RESERVE[kind] : def.pickupReserve };
  if (GEAR[kind]?.durability) return { dur: GEAR[kind].durability };
  if (kind === "cash") return { count: CASH.note };
  return null;
}

/** Tries to move a world pickup into the inventory. Returns true if it was taken. */
/**
 * Takes a world pickup through LootActions (the same rules as the inventory
 * screen). manual: pressed E, so say why when it can't be taken; walking
 * over loot stays quiet.
 */
function collectPickup(entry, manual = false) {
  const res = lootActions.pickup(entry, { equip: true, auto: !manual });
  if (res.ok && res.msg) inventoryUI.feed(res.msg, entry.def.category, entry.kind);
  else if (!res.ok && manual && res.msg) inventoryUI.feed(res.msg, "info", entry.kind);
  return res.ok;
}

function interact() {
  if (pickups.nearestWeapon && !brAirborne() && !drive.on) collectPickup(pickups.nearestWeapon, true);
}

function updatePickups(delta) {
  // Feet height: only loot on your floor of a house can be picked up
  pickups.update(delta, focusPos.x, focusPos.z, brWatching() ? null : characterBody.position.y - FEET_OFFSET);
  const canLoot = playerHealth > 0 && !brAirborne() && !brWatching();
  if (canLoot) {
    for (let i = pickups.touching.length - 1; i >= 0; i--) collectPickup(pickups.touching[i]);
  }

  // Context prompts: weapon pickup, door, light switch
  let n = 0;
  if (canLoot) {
    const e = drive.on ? null : pickups.nearestWeapon;
    if (e) {
      promptRows[n++] = "E";
      promptRows[n++] = e.def.category === "gear"
        ? `${inventory.gear[GEAR[e.kind].slot] ? "Swap for" : "Wear"} ${e.def.label}`
        : e.def.category === "weapon" && inventory.has(e.kind) ? `Take ammo · ${e.def.label}` : `Pick up ${e.def.label}`;
    }
    const near = houses?.interaction(characterBody.position.x, characterBody.position.z, characterBody.position.y - FEET_OFFSET);
    nearDoor = near?.door ?? null;
    nearSwitch = near?.sw ?? null;
    if (nearDoor) {
      promptRows[n++] = "F";
      promptRows[n++] = nearDoor.doorOpen ? "Close door" : "Open door";
    }
    const gateHere = !nearDoor && !drive.on ? collegeGate?.interaction(characterBody.position.x, characterBody.position.z) : null;
    nearGatePart = gateHere?.part ?? null;
    if (gateHere) {
      promptRows[n++] = "F";
      promptRows[n++] = gateHere.label;
    }
    if (nearSwitch) {
      promptRows[n++] = "L";
      promptRows[n++] = nearSwitch.lightOn ? "Turn lights off" : "Turn lights on";
    }
    nearShop = null;
    if (!drive.on) {
      const p = characterBody.position;
      for (const s of shops) if (Math.hypot(s.front.x - p.x, s.front.z - p.z) < SHOP_RANGE) { nearShop = s; break; }
    }
    if (nearShop) {
      promptRows[n++] = "B";
      promptRows[n++] = `Shop · ${fmtRupees(inventory.cash)}`;
    }
    if (climb.offer) {
      promptRows[n++] = "Space";
      promptRows[n++] = climb.offer === "wall" ? "Climb over the wall" : "Jump through the window";
    }
    const car = drive.car ?? nearestVehicle();
    if (car) {
      if (drive.on) {
        promptRows[n++] = "V";
        promptRows[n++] = "Get out";
      } else if (car.driver === null) {
        promptRows[n++] = "V";
        promptRows[n++] = `Drive the ${car.spec.label}${car.empty ? " (no petrol)" : ""}`;
      }
      if (inventory.fuelCans > 0 && car.fuel < car.spec.fuelMax - 1) {
        promptRows[n++] = "T";
        promptRows[n++] = `Fill petrol (${inventory.fuelCans} can${inventory.fuelCans > 1 ? "s" : ""})`;
      }
    }
  } else {
    nearDoor = nearSwitch = nearShop = null;
  }
  // Walked away (or died): the shop closes
  if (shopUI.open && !nearShop) setShopOpen(false);
  shopUI.update(inventory.cash);
  inventoryUI.setPrompts(promptRows, n);
}

// ─── Doors & lights ───────────────────────────────────────────────────────────
const promptRows = [];
let nearDoor = null;
let nearGatePart = null;   // "gate" | "booth": the college gate's lanes or its guard booth door
let nearSwitch = null;

function useDoor(open) {
  if (nearDoor && houses.setDoor(nearDoor, open)) {
    playerAnim.clip("interact", 0.8);
    makeNoise(nearDoor.doorWorld.x, nearDoor.doorWorld.z, open ? 9 : 12, "door");
    net.send({ t: "door", h: houses.houses.indexOf(nearDoor), o: open });
  }
}

function useGate(part) {
  const open = collegeGate.toggle(part);
  playerAnim.clip("interact", 0.8);
  sfx.doorBang({ x: collegeGate.x, y: groundHeight(collegeGate.x, collegeGate.z) + 1.5, z: collegeGate.z });
  makeNoise(collegeGate.x, collegeGate.z, part === "gate" ? 20 : 9, "door");
  net.send({ t: "gate", p: part, o: open });
}

function useLightSwitch() {
  if (!nearSwitch) return;
  playerAnim.clip("interact", 0.6, 0.8);
  houses.toggleLight(nearSwitch);
  net.send({ t: "light", h: houses.houses.indexOf(nearSwitch.house), f: nearSwitch.index, on: nearSwitch.lightOn });
}

function dropWeapon(id) {
  const res = lootActions.move({ from: "weapon", id }, { to: "ground" });
  if (res.msg) inventoryUI.feed(res.msg, "info", id);
}

// Zombie loot: one roll per kill
const DROP_TABLE = [
  ["ammo", 0.16],
  ["grenade", 0.05],
  ["molotov", 0.05],
  ["medkit", 0.045],
  ["gun", 0.025],
  ["gear", 0.02],
  ["attachment", 0.03],
];
const DROP_GEAR = ["helmet1", "vest1", "backpack1", "helmet2", "vest2", "backpack2"];
const DROP_ATTACHMENTS = Object.keys(ATTACHMENTS);
const DROP_GUNS = ["shotgun", "rifle", "sniper", "smg"];

/** Floor height for something dropped at (x, z) by someone with their feet at y. */
function floorY(x, z, feetY) {
  const g = groundHeight(x, z);
  return houses ? houses.surfaceAt(x, z, feetY + 0.3, g) : g;
}

function spawnDrop(k, x, z, life, y = groundHeight(x, z), data = pickupData(k)) {
  pickups.spawn(k, x, z, data, life, null, y);
  net.send({ t: "drop", k, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), l: life, ...packLoot(data) });
}

const BOSS_STASH   = ["sniper", "rifle", "medkit", "medkit", "ammo", "ammo", "grenade", "molotov", "helmet3", "scope4x"];
const DRAGON_STASH = ["medkit", "medkit", "ammo", "ammo", "ammo", "grenade", "vest3", "backpack3"];

function rollZombieDrop(zombie) {
  const p0 = zombie.body.position;
  // Rupees: bosses always pay, the rest now and then
  const pay = CASH.monster[zombie.type] ?? CASH.monster.walker;
  if (zombie.def.boss || zombie.def.bossBar || Math.random() < CASH.monsterChance) {
    const a = Math.random() * Math.PI * 2;
    const x = p0.x + Math.cos(a) * 0.9, z = p0.z + Math.sin(a) * 0.9;
    spawnDrop("cash", x, z, DROP_LIFETIME, floorY(x, z, zombie.root.position.y), { count: pay });
  }
  const stash = zombie.def.boss ? BOSS_STASH : zombie.def.bossBar ? DRAGON_STASH : null;
  if (stash) {
    // The Warlord and dragons drop a stash
    stash.forEach((k, i) => {
      const a = (i / stash.length) * Math.PI * 2;
      const x = p0.x + Math.cos(a) * 2.6, z = p0.z + Math.sin(a) * 2.6;
      spawnDrop(k, x, z, DROP_LIFETIME * 2, floorY(x, z, zombie.root.position.y));
    });
    return;
  }
  // Tougher monsters drop more often
  let r = Math.random() / (zombie.def.bigBody ? 3 : zombie.gun ? 1.6 : 1);
  for (const [kind, chance] of DROP_TABLE) {
    if (r < chance) {
      const pickFrom = { gun: DROP_GUNS, gear: DROP_GEAR, attachment: DROP_ATTACHMENTS }[kind];
      const k = pickFrom ? pickFrom[(Math.random() * pickFrom.length) | 0] : kind;
      const p = zombie.body.position;
      spawnDrop(k, p.x, p.z, DROP_LIFETIME, floorY(p.x, p.z, zombie.root.position.y));
      return;
    }
    r -= chance;
  }
}

// Placed world loot: deterministic, like the rest of the scatter
const STARTER_LOOT = [
  ["shotgun", -2.5, 7], ["rifle", 2.5, 7],
  ["grenade", -1.5, 10], ["molotov", 1.5, 10], ["ammo", 0, 12],
  ["helmet1", -3.5, 12], ["vest1", 3.5, 12], ["backpack1", 0, 14.5], ["reddot", -1.8, 14], ["grip", 1.8, 14],
  ["fuel", -12, -12], // next to the auto-rickshaw
];
const WORLD_LOOT = {
  pistol: 1, smg: 2, shotgun: 3, rifle: 3, sniper: 3,
  ammo: 14, grenade: 10, molotov: 10, medkit: 8, fuel: 6, biscuit: 12, cash: 14,
  helmet1: 4, helmet2: 2, vest1: 4, vest2: 2, backpack1: 4, backpack2: 2,
  reddot: 3, scope4x: 2, compensator: 2, suppressor: 2, extmag: 3, grip: 2,
};
const _lootFrom = new CANNON.Vec3();
const _lootTo = new CANNON.Vec3();
const _lootResult = new CANNON.RaycastResult();
const lootRayOpts = { collisionFilterMask: GROUP_WORLD };

// True if nothing but bare ground is under (x, z): keeps loot out of houses, trees and stones
function isOpenGround(x, z) {
  for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    _lootFrom.set(x + ox, 40, z + oz);
    _lootTo.set(x + ox, -1, z + oz);
    _lootResult.reset();
    if (!world.raycastClosest(_lootFrom, _lootTo, lootRayOpts, _lootResult)) return false;
    // The heightfield's triangles and groundHeight()'s bilinear surface differ by a few cm
    if (_lootResult.hitPointWorld.y > groundHeight(x + ox, z + oz) + 0.3) return false;
  }
  return true;
}

const HOUSE_LOOT = ["ammo", "medkit", "grenade", "molotov", "ammo", "shotgun", "helmet1", "vest1", "backpack1", "reddot", "extmag", "biscuit", "cash", "biscuit"];
const CAVE_LOOT = ["rifle", "ammo", "medkit", "sniper", "grenade", "ammo", "molotov", "helmet3", "vest3", "backpack3", "scope4x", "suppressor"];

function spawnWorldLoot() {
  const lootRng = makeLCG(0x10070bad);
  // A little something inside every house
  const spot = new THREE.Vector3();
  houses?.houses.forEach((h, i) => {
    for (const s of houses.lootSpots(h)) {
      if (lootRng() < 0.35) continue;
      const kind = HOUSE_LOOT[(i * 3 + Math.floor(lootRng() * HOUSE_LOOT.length)) % HOUSE_LOOT.length];
      houses.lootSpot(h, s, spot);
      pickups.spawn(kind, spot.x, spot.z, pickupData(kind), Infinity, null, spot.y);
    }
  });
  for (const [kind, x, z] of STARTER_LOOT) pickups.spawn(kind, x, z, pickupData(kind));
  // The panchayat offices and town buildings have a little something too
  indiaBuildings?.lootSpots.forEach((sp, i) => {
    if (lootRng() < 0.4) return;
    const kind = HOUSE_LOOT[(i * 5 + Math.floor(lootRng() * HOUSE_LOOT.length)) % HOUSE_LOOT.length];
    pickups.spawn(kind, sp.x, sp.z, pickupData(kind), Infinity, null, sp.y);
  });
  // The caves are worth the walk: something in most chambers and junctions
  caves?.lootSpots.forEach((sp, i) => {
    if (lootRng() < 0.3) return;
    const kind = CAVE_LOOT[(i + Math.floor(lootRng() * CAVE_LOOT.length)) % CAVE_LOOT.length];
    pickups.spawn(kind, sp.x, sp.z, pickupData(kind), Infinity, null, sp.y);
  });
  for (const [kind, count] of Object.entries(WORLD_LOOT)) {
    for (let n = 0; n < count; n++) {
      for (let attempt = 0; attempt < 25; attempt++) {
        const a = lootRng() * Math.PI * 2;
        const r = 14 + Math.sqrt(lootRng()) * 76;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (!isOpenGround(x, z)) continue;
        pickups.spawn(kind, x, z, pickupData(kind));
        break;
      }
    }
  }
}

// ─── Inventory screen ─────────────────────────────────────────────────────────
let inventoryOpen = false;

function setInventoryOpen(open) {
  if (open === inventoryOpen) return;
  if (open && playerHealth <= 0) return;
  inventoryOpen = open;
  lootScreen.setOpen(open);
  if (open) {
    input.fire = false;
    input.aim = false;
    cancelThrow();
    releaseLock();
  } else if (playerHealth > 0) {
    requestLock();
  }
}

// Item icons: the game-icons.net set wherever it has the item, else a white
// silhouette rendered from the item's 3D model (each one is a render and a GPU
// read-back, so only the ones the set lacks are drawn)
const itemIcons = {};
const itemIcon = (id, opts) => gameItemIcon(id) ?? renderItemIcon(renderer, id, opts);
for (const id of WEAPON_ORDER) itemIcons[id] = itemIcon(id, { width: 160, height: 56 });
itemIcons.grenade = itemIcon("grenade", { width: 64, height: 64, yaw: 0.4 });
itemIcons.molotov = itemIcon("molotov", { width: 64, height: 64, yaw: 0.4 });
itemIcons.smoke   = itemIcon("smoke",   { width: 64, height: 64, yaw: 0.4 });
itemIcons.ammo    = itemIcon("ammo",    { width: 64, height: 64, yaw: 0.6, pitch: 0.35 });
itemIcons.fuel    = itemIcon("fuel",    { width: 64, height: 64, yaw: 0.5, pitch: 0.2 });
itemIcons.medkit  = itemIcon("medkit",  { width: 64, height: 64, yaw: 0.5, pitch: 0.2 });
itemIcons.biscuit = itemIcon("biscuit", { width: 64, height: 64, yaw: 0.5, pitch: 0.35 });
itemIcons.cash    = itemIcon("cash",    { width: 64, height: 64, yaw: 0.5, pitch: 0.45 });
for (const id of [...Object.keys(GEAR), ...Object.keys(ATTACHMENTS)]) {
  itemIcons[id] = itemIcon(id, { width: 64, height: 64, yaw: 0.6, pitch: 0.25 });
}
applyStaticIcons();
// Prompt rows show what the key does as an icon too (and that's all a phone shows)
const PROMPT_ICONS = { O: "door", E: "bag", V: "steering", B: "shop", Space: "jump", L: "flashlight", T: "fuel", H: "medkit" };
const inventoryUI = new InventoryUI({ inventory, icons: itemIcons, promptIcon: key => icon(PROMPT_ICONS[key] ?? "", "prompt-icon") });


// Mouse-wheel weapon carousel around the player. In solo it slows the world
// down while monsters are hunting you, so there's time to pick.
const weaponWheel = new WeaponWheel({ order: WEAPON_ORDER, icons: itemIcons, defs: WEAPONS });
const WHEEL_IDLE_EQUIP = 1.3;    // real seconds without scrolling before the pick is equipped
const WHEEL_SLOWMO = 0.2;        // world speed while choosing under threat
const WHEEL_THREAT_RANGE = 40;   // m: chasing / alerted monsters this close trigger it
let timeScale = 1;
const _wheelScreen = new THREE.Vector3();
// Short bullet-time moments (level cleared, headshot kills), solo only
const bulletTime = { t: 0, scale: 1 };
function slowFor(seconds, scale) {
  if (gameMode !== "solo" || net.connected || bench.on) return;
  // Overlapping moments keep the slower of the two
  bulletTime.scale = bulletTime.t > 0 ? Math.min(bulletTime.scale, scale) : scale;
  bulletTime.t = Math.max(bulletTime.t, seconds);
}

const killStreak = new KillStreak();
const confetti = new Confetti();
// XP, levels and daily challenges; the benchmark doesn't count
const progress = new Progress();
progress.enabled = !BENCH_ENABLED;
new ProgressUI(progress, {
  profile: document.getElementById("lobby-profile"),
  card: document.getElementById("lobby-progress"),
  onLevelUp: () => { postFx.kick(0.35, 0xffd27a); sfx.levelStart(); },
  onComplete: () => postFx.kick(0.22, 0x4dff88),
});
const NIGHT_DARKNESS = 0.5; // env.darkness above this counts as "at night"

/** Every kill credited to this player (solo, co-op, battle royale). */
function onLocalKill(headshot) {
  const r = killStreak.kill(headshot);
  progress.streak(killStreak.count);
  if (r.heal > 0 && !isBR() && playerHealth > 0) playerHealth = Math.min(MAX_HEALTH, playerHealth + r.heal);
  if (r.tier) {
    postFx.kick(r.tier.frenzy ? 0.4 : 0.22, r.tier.color);
  } else {
    postFx.kick(headshot ? 0.16 : 0.07, headshot ? 0xfff2d0 : 0xffffff);
  }
  // A headshot kill freezes the world for a heartbeat
  if (headshot) slowFor(0.12, 0.12);
}

function updatePostFx(realDt) {
  killStreak.update(gamePaused() ? 0 : realDt);
  const low = playerHealth > 0 && playerHealth < MAX_HEALTH * 0.4;
  postFx.update(realDt, {
    darkness: env.darkness,
    bloodMoon: env.bloodMoon,
    health: playerHealth / MAX_HEALTH,
    dead: playerHealth <= 0 && !brWatching(),
    slowmo: THREE.MathUtils.clamp((1 - timeScale) / (1 - WHEEL_SLOWMO), 0, 1),
    frenzy: killStreak.frenzy,
    cave: caveDepth,
    // Battle royale moments: outside the zone (deeper = stronger), and the skydive
    zone: isBR() && br.outside && playerHealth > 0 ? THREE.MathUtils.clamp(0.55 + br.outsideBy / 40, 0.55, 1) : 0,
    freefall: isBR() && br.flight === PHASE_FALL ? 1 : isBR() && br.flight === PHASE_CHUTE ? 0.25 : 0,
    // Faster as health drops
    heartbeat: low ? 0.5 + 0.5 * Math.sin(performance.now() / 1000 * (6 + 6 * (1 - playerHealth / (MAX_HEALTH * 0.4)))) : 0,
  });
}

function wheelAmmo(id) {
  const slot = inventory.weapons[id];
  if (!slot) return "";
  return slot.reserve === Infinity ? `${slot.ammo} / ∞` : `${slot.ammo} / ${slot.reserve}`;
}

function openWeaponWheel(dir) {
  weaponWheel.open(inventory.ownedWeapons, inventory.current, wheelAmmo);
  if (weaponWheel.turn(dir)) sfx.click();
}

/** Equips the front card (if it's a change) and closes the wheel. */
function confirmWeaponWheel() {
  if (!weaponWheel.isOpen) return;
  weaponWheel.close();
  equipWeapon(weaponWheel.selected);
}

function cancelWeaponWheel() {
  if (weaponWheel.isOpen) weaponWheel.close();
}

/** Slow motion only in solo: co-op and the BR share one clock between players. */
function wheelThreatened() {
  if (gameMode !== "solo" || net.isClient || bench.on || !zombieManager) return false;
  for (const m of zombieManager.active) {
    if (!m.dying && (m.state === "chase" || m.state === "alert") && m.distXZ < WHEEL_THREAT_RANGE) return true;
  }
  return false;
}

function updateWeaponWheel(realDt) {
  if (weaponWheel.isOpen && (playerHealth <= 0 || !isLocked() || drive.on || brAirborne() || inventoryOpen || worldMap.open)) {
    cancelWeaponWheel();
  }
  if (weaponWheel.isOpen && weaponWheel.idle > WHEEL_IDLE_EQUIP) confirmWeaponWheel();
  const slow = weaponWheel.isOpen && wheelThreatened();
  if (bulletTime.t > 0) bulletTime.t -= realDt;
  const target = Math.min(slow ? WHEEL_SLOWMO : 1, bulletTime.t > 0 ? bulletTime.scale : 1);
  // Ease in fast, ease back out a little slower, on real time
  timeScale += (target - timeScale) * Math.min(1, realDt * (target < timeScale ? 14 : 6));
  if (Math.abs(1 - timeScale) < 0.005) timeScale = 1;
  // Centre the ring on the player's chest
  _wheelScreen.set(characterRoot.position.x, characterRoot.position.y + 1.1, characterRoot.position.z).project(camera);
  weaponWheel.update(realDt,
    (_wheelScreen.x * 0.5 + 0.5) * innerWidth,
    (-_wheelScreen.y * 0.5 + 0.5) * innerHeight,
    slow);
}

const pickups = new Pickups(scene);

// Every item transfer (walk-over, E, the inventory screen) goes through here
const lootActions = new LootActions({
  inventory,
  pickups,
  spawnLoot: (kind, data, at) => {
    const p = characterBody.position, feet = p.y - FEET_OFFSET;
    // Dropped things land a step in front of you, on your floor of a house
    const x = at?.x ?? p.x + Math.sin(bodyYaw) * 1.4 + (Math.random() - 0.5) * 0.6;
    const z = at?.z ?? p.z + Math.cos(bodyYaw) * 1.4 + (Math.random() - 0.5) * 0.6;
    const y = at?.y ?? floorY(x, z, feet);
    const entry = net.connected ? spawnShared(kind, x, z, data, y) : pickups.spawn(kind, x, z, data, Infinity, null, y);
    // You're standing on it: don't walk it straight back into the backpack
    pickups.lockAuto(entry);
  },
  claim: claimLoot,
  player: () => _lootPlayer.set(characterBody.position.x, characterBody.position.y - FEET_OFFSET, characterBody.position.z),
  onChange: prev => {
    if (inventory.current !== prev) onWeaponChanged();
    else onWeaponChanged(false); // attachments change the held gun's stats (scope zoom, magazine)
  },
  notify: (msg, kind, icon) => inventoryUI.feed(msg, kind, icon),
  sfx,
});
const _lootPlayer = new THREE.Vector3();

const lootScreen = new LootScreen({
  root: document.getElementById("inventory"),
  inventory,
  actions: lootActions,
  icons: itemIcons,
  cb: {
    onUse: kind => { if (kind === "medkit" || kind === "biscuit") useHeal(kind); else if (kind === "fuel") refuelVehicle(); },
    onSelectThrowable: kind => { inventory.selectThrowable(kind); sfx.click(); },
  },
});
// Teammates / you see the gear you wear
let _gearVer = -1;
function syncGearModel() {
  if (inventory.version === _gearVer) return;
  _gearVer = inventory.version;
  const g = inventory.gearLevels();
  soldier.setGear(g);
  _gearCode = g.helmet * 100 + g.vest * 10 + g.backpack;
}
let _gearCode = 0;

// ─── Dukaan: buying with rupees ───────────────────────────────────────────────
// Stand at a town stall's counter and press B (or tap the prompt). The world
// keeps running while you shop, like the map. Purchases go straight into your
// pockets; gear you replace drops at your feet.
let shops = [];                  // world/Shops.js: [{ town, x, z, rot, front }]
let nearShop = null;
let shopHoldsPlay = false;       // the shop freed the mouse on desktop, but the game is still on

/** "" if `item` can be bought right now, otherwise a short reason. */
function whyNotBuy(item) {
  if (inventory.cash < item.price) return "Need more ₹";
  switch (item.give) {
    case "stack": {
      const n = item.n ?? 1;
      if (inventory.canAdd(item.id) >= n) return "";
      return inventory.count(item.id) + n > inventory.maxOf(item.id) ? "Carrying the max" : "Backpack full";
    }
    case "ammo": return !inventory.ownedWeapons.length ? "No gun" : inventory.ammoFull() ? "Ammo full" : "";
    case "gun": return inventory.has(item.id) && inventory.ammoFull() ? "Have it, ammo full" : "";
    case "gear": {
      const g = GEAR[item.id], cur = inventory.gear[g.slot];
      if (cur && GEAR[cur.id].level > g.level) return "Wearing better";
      if (cur?.id === item.id && (cur.dur ?? Infinity) >= (g.durability ?? 0)) return "Wearing it";
      return inventory._capacityWith(g.slot, item.id) < inventory.load ? "Backpack too full" : "";
    }
    case "attachment": return inventory.freeSlotFor(item.id) || inventory.room(item.id) >= 1 ? "" : "Backpack full";
  }
  return "";
}

function buyItem(id) {
  const item = SHOP_ITEMS.find(i => i.id === id);
  const why = item ? whyNotBuy(item) : "Not for sale";
  if (why) { sfx.click(); return { ok: false, msg: why }; }
  const prev = inventory.current;
  switch (item.give) {
    case "stack": inventory.addStack(item.id, item.n ?? 1); break;
    case "ammo": inventory.addAmmoCrate(); break;
    case "gun": {
      const isNew = !inventory.has(item.id);
      inventory.addWeapon(item.id, WEAPONS[item.id].magSize, WEAPONS[item.id].pickupReserve);
      if (isNew) inventory.equip(item.id);
      break;
    }
    case "gear": {
      const r = inventory.equipGear(item.id);
      if (r.error) return { ok: false, msg: r.error };
      if (r.prev) lootActions.spawnLoot(r.prev.id, { dur: r.prev.dur });
      break;
    }
    case "attachment": {
      const w = inventory.freeSlotFor(item.id);
      if (w) inventory.attach(w, item.id);
      else inventory.addStack(item.id, 1);
      break;
    }
  }
  inventory.spend(item.price);
  if (inventory.current !== prev) onWeaponChanged();
  else onWeaponChanged(false);
  sfx.pickup(item.give === "gun" || item.give === "gear");
  inventoryUI.feed(`Bought ${item.label} · ${fmtRupees(item.price)}`, "cash", item.id);
  return { ok: true, msg: `Bought ${item.label}` };
}

const shopUI = new ShopUI({ icons: itemIcons, buy: buyItem, canBuy: whyNotBuy, onClose: () => setShopOpen(false) });

function setShopOpen(open) {
  if (open === shopUI.open) return;
  if (open && (playerHealth <= 0 || !nearShop || drive.on)) return;
  shopUI.setOpen(open);
  shopUI.update(inventory.cash, true);
  if (open) {
    input.fire = false;
    input.aim = false;
    cancelThrow();
    touch?.reset();
    if (!IS_TOUCH && document.pointerLockElement === canvas) {
      shopHoldsPlay = true;
      document.exitPointerLock();
    }
  } else if (shopHoldsPlay) {
    shopHoldsPlay = false;
    requestLock();
  }
}

const fireFX = new FireFX(scene);
const smokeFX = new SmokeFX(scene);

// ─── Audio: listener, space, monsters, fires, landings ────────────────────────
const monsterAudio = new MonsterAudio(sfx);
const _earFwd = new THREE.Vector3();
const _earUp = new THREE.Vector3();
const _fireAt = { x: 0, y: 0, z: 0 };
let _wasOnGround = true, _fallSpeed = 0;

/** What feet hit at (x, feetY, z): house floors are wood, caves stone, the rest grass. */
function footSurface(x, feetY, z) {
  if (houses?.floorAt(x, feetY, z)) return "wood";
  if (caves?.inside(x, z, feetY) || indiaBuildings?.inside(x, z)) return "concrete";
  return "grass";
}

/** A point `dist` m away in a random direction (sounds from "out there"). */
function farPoint(dist) {
  const a = Math.random() * Math.PI * 2;
  return { x: camera.position.x + Math.cos(a) * dist, y: camera.position.y, z: camera.position.z + Math.sin(a) * dist };
}

function updateAudio(delta) {
  // The listener is the camera: turning your head turns the sound field
  camera.getWorldDirection(_earFwd);
  _earUp.setFromMatrixColumn(camera.matrixWorld, 1);
  sfx.setListener(camera.position, _earFwd, _earUp);
  const p = characterBody.position;
  sfx.setSpace(caveDepth > 0.3 ? "cave" : houses?.floorAt(p.x, p.y - FEET_OFFSET, p.z) ? "indoor" : "outdoor");
  if (zombieManager) monsterAudio.update(zombieManager.active, delta);
  // Burning ground crackles where it burns
  throwables.fires.forEach((f, i) => {
    if (!f.active && !f.sounding) return;
    f.sounding = f.active;
    _fireAt.x = f.x; _fireAt.y = groundHeight(f.x, f.z) + 0.5; _fireAt.z = f.z;
    sfx.fireLoop(`fire${i}`, _fireAt, f.active ? Math.min(1, f.time) : 0);
  });
  // Landing from a jump or a fall: both feet at once, louder the harder
  if (onGround && !_wasOnGround && _fallSpeed > 3 && playerHealth > 0 && !drive.on) {
    const s = footSurface(p.x, p.y - FEET_OFFSET, p.z), v = Math.min(1.3, _fallSpeed / 7);
    sfx.footstep(s, v);
    sfx.footstep(s, v * 0.8, null, 0.9);
  }
  _fallSpeed = onGround ? 0 : Math.max(_fallSpeed, -characterBody.velocity.y);
  _wasOnGround = onGround;
}

// Standing in smoke: the screen fills with its colour (the puffs alone leave
// gaps where they cross the near plane). DOM only changes with the value.
const smokeOverlayEl = document.getElementById("smoke-overlay");
const _smokeColor = new THREE.Color();
let _smokeShown = -1, _smokeHex = "";
function updateSmokeOverlay(light) {
  const d = Math.round(smokeFX.density(camera.position, _smokeColor) * 20) / 20;
  if (d !== _smokeShown) {
    _smokeShown = d;
    smokeOverlayEl.style.opacity = `${d * 0.88}`;
  }
  if (d > 0) {
    const hex = _smokeColor.multiplyScalar(0.55 + 0.45 * light).getHexString();
    if (hex !== _smokeHex) { _smokeHex = hex; smokeOverlayEl.style.background = `#${hex}`; }
  }
}
const gameHud = new GameHUD();

// Monster gunfire (gunners, Warlord plasma, dragon fire). Walls block it; windows don't.
const enemyFire = new EnemyFire({
  scene,
  world,
  effects,
  sfx,
  getTargets,
  onHitPlayer: (target, dmg, sx, sz) => onPlayerHit(target, dmg, 0, 0, 0.18, sx, sz),
});
enemyFire.onBoltImpact = (gun, pos) => onBoltImpact(gun, pos);

weather.onThunder = strength => {
  sfx.thunder(strength);
  cameraTrauma = Math.min(1, cameraTrauma + strength * 0.12);
};
env.onNightfall = blood => {
  if (playerHealth <= 0) return;
  if (blood) gameHud.showBanner({ title: "BLOOD MOON", sub: "Night falls", text: "Something is wrong with the moon tonight.", color: "#ff3a22", duration: 4.5 });
  else gameHud.showBanner({ title: "NIGHTFALL", sub: "Stay in the light", color: "#8ea4d8", duration: 3 });
  sfx.howl(farPoint(70));
};

// ─── Player noise & visibility (what the monsters sense) ──────────────────────
let stepTimer = 0;
const STEP_NOISE = {          // radius (m) and seconds between footstep noises
  sprint: [17, 0.28],
  jog:    [8, 0.36],
  sneak:  [3.5, 0.5],         // aiming / walking slowly
};

function updatePlayerNoise(delta) {
  const speed = Math.hypot(moveVelocity.x, moveVelocity.z);
  let level = 0, step = null;
  if (playerHealth > 0 && onGround && speed > 0.6) {
    if (sprinting) { level = 3; step = STEP_NOISE.sprint; }
    else if (input.aim || speed < 3.6) { level = 1; step = STEP_NOISE.sneak; }
    else { level = 2; step = STEP_NOISE.jog; }
  }
  if (timeSinceShot < 0.5) level = 3;
  gameHud.setNoise(level);
  if (!step) { stepTimer = Math.min(stepTimer, 0.1); return; }
  stepTimer -= delta;
  if (stepTimer <= 0) {
    stepTimer = step[1];
    const p = characterBody.position, feetY = p.y - FEET_OFFSET;
    sfx.footstep(footSurface(p.x, feetY, p.z), (step === STEP_NOISE.sprint ? 1 : step === STEP_NOISE.jog ? 0.75 : 0.45) * Math.max(0.35, STANCES[stance].noise));
    // Rain drowns out footsteps
    makeNoise(characterBody.position.x, characterBody.position.z, step[0] * (1 - weather.rain * 0.35) * STANCES[stance].noise, "step");
  }
}

/**
 * Sight multiplier for monsters: sprinting stands out, a dark house hides
 * you, night hides you unless your flashlight is on, rain blurs everything.
 */
function playerVisibility() {
  let v = 1;
  if (sprinting) v *= 1.25;
  else if (Math.hypot(moveVelocity.x, moveVelocity.z) < 0.5) v *= 0.85;
  const floor = houses?.floorAt(characterBody.position.x, characterBody.position.y - FEET_OFFSET, characterBody.position.z);
  if (floor && !floor.lightOn) v *= 0.45;
  if (indiaBuildings?.inside(characterBody.position.x, characterBody.position.z)) v *= 0.7;
  v *= STANCES[stance].vis;
  v *= 1 - env.darkness * (torch.level > 0.5 ? 0.1 : 0.5);
  v *= 1 - weather.rain * 0.25;
  if (caveDepth > 0.05 && caves) {
    const p = characterBody.position;
    const lit = 1 - THREE.MathUtils.smoothstep(caves.nearestTorch(p.x, p.y, p.z), 3, 8);
    v *= 1 - caveDepth * 0.55 * (1 - lit) * (torch.level > 0.5 ? 0.25 : 1);
  }
  return v;
}

// ─── Levels ───────────────────────────────────────────────────────────────────
let director = null;

function onLevelStart(level) {
  if (net.isHost) net.send({ t: "lev", e: "start", n: level.n });
  const def = level.introduces ? MONSTER_TYPES[level.introduces] : null;
  gameHud.showBanner({
    title: `LEVEL ${level.n}`,
    sub: level.name,
    text: def ? `New threat: ${def.label}. ${def.blurb}` : "They're tougher now, and there are more of them.",
    color: def?.color ?? "#e2a42b",
    duration: 5.5,
  });
  sfx.levelStart();
}

function onLevelCleared(level) {
  if (net.isHost) net.send({ t: "lev", e: "clear", n: level.n });
  progress.levelCleared(level.n);
  // The last kill of a level plays out in slow motion, with a golden flash
  slowFor(1.6, 0.3);
  postFx.kick(0.45, 0xffd27a);
  confetti.celebrate("level");
  gameHud.showBanner({
    title: `LEVEL ${level.n} CLEARED`,
    sub: "Supplies dropped nearby",
    foot: "",
    color: "#4dff88",
    duration: 0,
  });
  sfx.levelCleared();
  // Reward: patch up and resupply around the player
  playerHealth = Math.min(MAX_HEALTH, playerHealth + 30);
  const supplies = ["ammo", "ammo", "medkit", level.n % 2 ? "grenade" : "molotov"];
  const unlockGun = ["shotgun", "rifle", "sniper"][level.n - 1];
  if (unlockGun && !inventory.has(unlockGun)) supplies.push(unlockGun);
  supplies.forEach((k, i) => {
    const a = (i / supplies.length) * Math.PI * 2 + 0.4;
    pickups.spawn(k, characterBody.position.x + Math.cos(a) * 3, characterBody.position.z + Math.sin(a) * 3, pickupData(k), 60);
  });
}

function onBossSpawn(boss) {
  if (net.isHost) net.send({ t: "lev", e: "boss", n: director.level.n });
  gameHud.showBanner({ title: "THE WARLORD", sub: "has entered the fight", color: boss.def.color, duration: 3.5 });
  // Clients only get the type, not the monster: the roar then comes from somewhere out there
  const at = boss.root?.position ?? farPoint(40);
  if (!sfx.voice("boss_roar", at, { ref: 30, rate: 0.8, vol: 1.2 })) sfx.growl(at, true);
}

function onDragonSpawn(dragon) {
  if (net.isHost) net.send({ t: "lev", e: "dragon", n: director.level.n });
  gameHud.showBanner({ title: "DRAGON", sub: "Something is circling above", text: "Get under a roof when it dives.", color: dragon.def.color, duration: 4 });
  sfx.dragonRoar(dragon.root?.position ?? farPoint(60));
}

// Dragon fireballs: a burst of flame where they land, and burning ground
let lastDragonFire = 0;
function onBoltImpact(gun, pos) {
  if (!gun.ignite) return;
  const y = Math.max(0.3, pos.y);
  fireFX.blast(pos.x, y, pos.z);
  const d = Math.hypot(pos.x - characterBody.position.x, pos.z - characterBody.position.z);
  sfx.explosion(pos, 0.55);
  cameraTrauma = Math.min(1, cameraTrauma + THREE.MathUtils.clamp(1 - d / 25, 0, 1) * 0.35);
  // One burning patch per burst is plenty (the fires are pooled)
  const now = performance.now();
  if (pos.y < 1.2 && now - lastDragonFire > 1500) {
    lastDragonFire = now;
    throwables.igniteAt(pos.x, pos.z, true);
  }
}

/** A dead dragon hits the ground. */
function onMonsterCrash(m) {
  const p = m.body.position;
  const d = Math.hypot(p.x - characterBody.position.x, p.z - characterBody.position.z);
  sfx.thud(p);
  cameraTrauma = Math.min(1, cameraTrauma + THREE.MathUtils.clamp(1 - d / 40, 0, 1) * 0.9);
  _vecA.set(p.x, 0.3, p.z);
  for (let i = 0; i < 4; i++) effects.impact(_vecA, Math.random() - 0.5, 1, Math.random() - 0.5, "dust", 14);
}

const KILL_VERB = { head: "HEADSHOT", blast: "BLOWN UP", fire: "BURNED", gun: "KILLED", road: "RUN OVER" };

function updateLevelHud() {
  if (!director?.level) return;
  gameHud.setLevel(director.level.n, director.level.name, director.killed, director.total);
  if (director.state === "cleared") gameHud.setBannerFoot(`Next level in ${director.countdown}`);
  const boss = zombieManager?.boss;
  gameHud.setBoss(boss?.def.label.toUpperCase(), boss ? Math.max(0, boss.health / boss.maxHealth) : null, boss?.def.color);
}

const throwables = new Throwables({
  scene,
  world,
  material: projectileMaterial,
  effects,
  fireFX,
  smokeFX,
  sfx,
  onSmoke: pos => sfx.smokeHiss(pos),
  onExplode: onGrenadeExplode,
  onIgnite: (x, z, hitZombie, owner) => {
    if (net.isClient) return; // the host's copy of this throw does the damage
    // A direct hit drenches the zombie: it burns longer
    if (hitZombie) zombieManager?.ignite(hitZombie, BURN_TIME_DIRECT, owner ?? localTarget.id);
    zombieManager?.noise(x, z, MOLOTOV.alertRadius, "explosion");
  },
  onFireTick,
});

const NO_PLAYERS = [];
const minimap = new Minimap(document.getElementById("minimap"), {
  zombies: () => zombieManager?.active ?? [],
  pickups: () => pickups.active,
  fires: () => throwables.fires,
  obstacles: () => mapObstacles,
  roads: () => roadLines,
  players: () => (isBR() ? NO_PLAYERS : remotePlayers.mapList()),
  zone: () => (isBR() && br.state === "match" ? br.zone : null),
  pins: () => pinList,
  fights: () => fightZones,
});

// ─── Red zones: players fighting ──────────────────────────────────────────────
// Battle royale matches: every player's shots are noted (yours, and everyone
// else's "shot" messages). Two or more different players firing within
// FIGHT_RADIUS of each other inside FIGHT_WINDOW s starts a red zone there: a
// red circle on both maps and a message with how far and which way it is. It
// fades FIGHT_LIFE s after the last shot in it.
const FIGHT_WINDOW = 8;          // s
const FIGHT_RADIUS = 70;         // m between two shooters that counts as one fight
const FIGHT_ZONE_R = 40;         // m: the red circle (later shots inside it keep it alive)
const FIGHT_LIFE   = 20;         // s after its last shot
const SHOT_NOTE_GAP = 0.5;       // s: an automatic gun is noted twice a second, not every bullet
const MAX_FIGHTS   = 6;
const shotLog = [];              // recent shots { id, x, z, t }
const fightZones = [];           // { x, z, r, last }
const _lastNoted = new Map();    // player id → time of their last noted shot
const redZoneEl = document.createElement("div");
redZoneEl.id = "redzone-alert";
document.body.append(redZoneEl);
let redZoneHide = 0;
const HEADING_8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function fightsOn() { return isBR() && br.state === "match"; }

/** A player fired at (x, z). id: their net id ("me" for you). */
function noteShot(id, x, z) {
  if (!fightsOn()) return;
  const t = performance.now() / 1000;
  if (t - (_lastNoted.get(id) ?? -99) < SHOT_NOTE_GAP) return;
  _lastNoted.set(id, t);
  while (shotLog.length && t - shotLog[0].t > FIGHT_WINDOW) shotLog.shift();

  // Inside a red zone already: keep it burning
  for (const f of fightZones) {
    if (Math.hypot(f.x - x, f.z - z) < f.r) { f.last = t; shotLog.push({ id, x, z, t }); return; }
  }
  // Somebody else fired near here lately: a new fight
  const other = shotLog.find(s => s.id !== id && Math.hypot(s.x - x, s.z - z) < FIGHT_RADIUS);
  shotLog.push({ id, x, z, t });
  if (!other) return;
  if (fightZones.length >= MAX_FIGHTS) fightZones.shift();
  const f = { x: (x + other.x) / 2, z: (z + other.z) / 2, r: FIGHT_ZONE_R, last: t };
  fightZones.push(f);
  announceRedZone(f);
}

function announceRedZone(f) {
  const me = mapMe();
  const dx = f.x - me.x, dz = f.z - me.z, d = Math.hypot(dx, dz);
  // World +Z is north and +X east (as on the maps)
  const dir = HEADING_8[Math.round(((Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360) / 45) % 8];
  redZoneEl.innerHTML = d < f.r
    ? "<b>⚠ RED ZONE</b> · A fight broke out right here"
    : `<b>⚠ RED ZONE</b> · Players fighting ${Math.round(d)} m ${dir}`;
  redZoneEl.classList.add("show");
  redZoneHide = performance.now() + 4500;
  sfx.click();
}

/** Ages the red zones out and hides the message. */
function updateFightZones(now) {
  if (redZoneHide && now > redZoneHide) { redZoneHide = 0; redZoneEl.classList.remove("show"); }
  if (!fightZones.length) return;
  if (!fightsOn()) { fightZones.length = 0; shotLog.length = 0; return; }
  const t = now / 1000;
  for (let i = fightZones.length - 1; i >= 0; i--) if (t - fightZones[i].last > FIGHT_LIFE) fightZones.splice(i, 1);
}

// ─── World map + pins ─────────────────────────────────────────────────────────
// M (or the map button) opens the full map; tap / click it to drop a pin. Your
// pin shows as a light pillar in the world, a marker with the distance, on the
// compass and the minimap. Co-op squads see each other's pins.
const PIN_COLOR = "#ffcc33";
const PIN_REACHED = 4;           // metres: arriving at your pin lifts it
const pinList = [];              // every pin, for the minimap
const _mapMe = { x: 0, z: 0, yaw: 0 };
function mapMe() {
  const w = brWatchedPlayer();
  _mapMe.x = focusPos.x;
  _mapMe.z = focusPos.z;
  _mapMe.yaw = w ? w.aimYaw : aimYaw;
  return _mapMe;
}
const worldMap = new WorldMap({
  me: mapMe,
  players: () => (isBR() ? NO_PLAYERS : remotePlayers.mapList()),
  obstacles: () => mapObstacles,
  fires: () => atmosphere.sources,
  vehicles: () => vehicles,
  br: () => (isBR() ? _mapState : null),
  height: (x, z) => (caves ? caves.mapHeight(x, z) : groundHeight(x, z)),
  caves: () => caveMapShapes,
  roads: () => roadLines,
  labels: () => townLabels,
  fights: () => fightZones,
}, {
  touch: IS_TOUCH,
  onPin: (x, z) => setPin("me", x, z, true),
  onClear: () => setPin("me", null, null, true),
  onClose: () => setMapOpen(false),
});
const waypoints = new Waypoints(scene);

/** x === null lifts the pin. id: "me" or a teammate's net id. */
function setPin(id, x, z, share = false) {
  const p = x === null ? null : {
    x, z,
    color: id === "me" ? (net.connected && !isBR() ? net.players.get(net.id)?.color ?? PIN_COLOR : PIN_COLOR) : net.players.get(id)?.color ?? "#ffffff",
    label: id === "me" ? null : net.players.get(id)?.name ?? null,
  };
  worldMap.setPin(id, p);
  waypoints.set(id, p);
  pinList.length = 0;
  for (const q of worldMap.pins.values()) pinList.push(q);
  if (id === "me" && p) sfx.click();
  // Squadmates see your pin; in the battle royale everyone's an enemy
  if (share && gameMode === "coop" && net.connected) net.send(p ? { t: "pin", x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 } : { t: "pin", c: 1 });
}

function setMapOpen(open) {
  if (open === worldMap.open) return;
  worldMap.setOpen(open);
  if (open) {
    // Let go of everything held: the map takes the whole screen
    input.fire = false;
    input.aim = false;
    cancelThrow();
    touch?.reset();
    // Desktop: free the mouse, so the map gets a real cursor (a crosshair over
    // the map, the arrow over its buttons). The game keeps running underneath.
    if (!IS_TOUCH && document.pointerLockElement === canvas) {
      mapHoldsPlay = true;
      document.exitPointerLock();
    }
  } else if (mapHoldsPlay) {
    // Closed with M or the Close button (both user gestures): take the mouse back to aim
    mapHoldsPlay = false;
    requestLock();
  }
}

function updatePins(now) {
  const me = mapMe();
  const mine = worldMap.myPin;
  if (mine && !brWatching() && Math.hypot(mine.x - me.x, mine.z - me.z) < PIN_REACHED) {
    setPin("me", null, null, true);
    inventoryUI.feed("You reached your pin", "info");
  }
  worldMap.update(now);
  waypoints.setVisible((isLocked() || brWatching()) && !lobby?.open && !worldMap.open);
  waypoints.update(now, me, camera);
}

// ─── Model Registry & Lil-GUI Controls ────────────────────────────────────────
const editableModels = {};

/**
 * perMeshColliders: one static box per mesh (fitted per wall/part, e.g. the WRL
 * house) instead of a single box around the whole model.
 */
function createEditableModel({
  id, name, object3D, initialParams, customUpdate = null, perMeshColliders = false, trunkCollider = false,
}) {
  object3D.traverse(child => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  object3D.scale.setScalar(1);
  object3D.rotation.set(0, 0, 0);
  object3D.updateWorldMatrix(true, true);

  const bbox = new THREE.Box3().setFromObject(object3D);
  const minY = bbox.min.y;
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const root = new THREE.Group();
  object3D.position.set(0, -minY, 0); // snap bottom base of model to root local Y=0
  root.add(object3D);
  scene.add(root);
  root.updateMatrixWorld(true);

  // Collider boxes in root space at scale 1: { c: centre, h: half extents }
  const boxes = [];
  const tmpBox = new THREE.Box3();
  if (perMeshColliders) {
    object3D.traverse(child => {
      if (!child.isMesh) return;
      tmpBox.setFromObject(child);
      if (tmpBox.isEmpty()) return;
      const h = tmpBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      if (Math.max(h.x, h.y, h.z) < 0.08) return; // door knobs, trim
      boxes.push({ c: tmpBox.getCenter(new THREE.Vector3()), h });
    });
  }
  if (trunkCollider) {
    // Trees: only the trunk is solid, so you can walk under the canopy
    tmpBox.setFromObject(root);
    const c = tmpBox.getCenter(new THREE.Vector3());
    const sz = tmpBox.getSize(new THREE.Vector3());
    boxes.push({ c: new THREE.Vector3(c.x, sz.y * 0.3, c.z), h: new THREE.Vector3(sz.x * 0.06, sz.y * 0.3, sz.z * 0.06) });
  }
  if (!boxes.length) {
    tmpBox.setFromObject(root);
    boxes.push({ c: tmpBox.getCenter(new THREE.Vector3()), h: tmpBox.getSize(new THREE.Vector3()).multiplyScalar(0.5) });
  }
  const modelCenter = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  // Colliders are measured: now bake the parts into one mesh per material
  mergeStaticMeshes(object3D);

  const body = new CANNON.Body({ mass: 0, material: staticMaterial });
  for (const b of boxes) body.addShape(new CANNON.Box(new CANNON.Vec3(b.h.x, b.h.y, b.h.z)), new CANNON.Vec3(b.c.x, b.c.y, b.c.z));
  world.addBody(body);

  const params = {
    posX: initialParams.posX ?? 0,
    posY: initialParams.posY ?? 0,
    posZ: initialParams.posZ ?? 0,
    rotY: initialParams.rotY ?? 0,
    scale: initialParams.scale ?? 1,
    visible: initialParams.visible ?? true,
  };

  function updateTransform() {
    root.position.set(params.posX, params.posY, params.posZ);
    root.rotation.y = THREE.MathUtils.degToRad(params.rotY);
    root.scale.setScalar(params.scale);
    root.visible = params.visible;

    if (customUpdate) {
      customUpdate(params);
      return;
    }
    const sc = params.scale;
    body.position.set(params.posX, params.posY, params.posZ);
    body.quaternion.setFromEuler(0, THREE.MathUtils.degToRad(params.rotY), 0);
    boxes.forEach((b, i) => {
      const shape = body.shapes[i];
      // Thin parts get a minimum thickness so nothing tunnels through them
      shape.halfExtents.set(Math.max(0.15, b.h.x * sc), Math.max(0.15, b.h.y * sc), Math.max(0.15, b.h.z * sc));
      // cannon collides against the convex polyhedron, not halfExtents: rebuild it
      shape.updateConvexPolyhedronRepresentation();
      shape.updateBoundingSphereRadius();
      body.shapeOffsets[i].set(b.c.x * sc, b.c.y * sc, b.c.z * sc);
    });
    body.updateBoundingRadius();
    body.aabbNeedsUpdate = true;
    body.collisionFilterGroup = params.visible ? GROUP_WORLD : 0;
  }

  updateTransform();

  const record = { id, name, root, body, params, updateTransform, size };
  // Live footprint for the minimap and zombie pathing; follows lil-gui edits
  const footprint = {
    type: "box",
    get rot() { return THREE.MathUtils.degToRad(params.rotY); },
    get x() {
      if (!params.visible) return 1e6;
      const r = this.rot;
      return params.posX + (modelCenter.x * Math.cos(r) + modelCenter.z * Math.sin(r)) * params.scale;
    },
    get z() {
      const r = this.rot;
      return params.posZ + (-modelCenter.x * Math.sin(r) + modelCenter.z * Math.cos(r)) * params.scale;
    },
    get w() { return size.x * params.scale; },
    get d() { return size.z * params.scale; },
    get hw() { return size.x * params.scale / 2; },
    get hd() { return size.z * params.scale / 2; },
  };
  if (trunkCollider) {
    mapObstacles.push({ type: "circle", get x() { return footprint.x; }, get z() { return footprint.z; }, get r() { return footprint.hw * 0.5; } });
  } else {
    mapObstacles.push(footprint);
    navObstacles.push(footprint);
  }
  editableModels[id] = record;
  return record;
}

function setupGui() {
  // The scene-tuning panel is a desktop tool; on phones it's hidden but its
  // listen() controllers would still poll every frame
  if (IS_TOUCH) return;
  const gui = new GUI({ title: "🎯 Scene Assets & Locations" });
  gui.close();

  const actions = {
    logCoordinates() {
      const result = {};
      for (const [id, m] of Object.entries(editableModels)) {
        result[id] = {
          name: m.name,
          posX: Number(m.params.posX.toFixed(2)),
          posY: Number(m.params.posY.toFixed(2)),
          posZ: Number(m.params.posZ.toFixed(2)),
          rotY: Number(m.params.rotY.toFixed(1)),
          scale: Number(m.params.scale.toFixed(2)),
          visible: m.params.visible,
          detectionRadius: m.params.detectionRadius ? Number(m.params.detectionRadius.toFixed(1)) : undefined,
          deaggroRadius: m.params.deaggroRadius ? Number(m.params.deaggroRadius.toFixed(1)) : undefined,
          chaseSpeed: m.params.chaseSpeed ? Number(m.params.chaseSpeed.toFixed(1)) : undefined,
          attackSpeed: m.params.attackSpeed ? Number(m.params.attackSpeed.toFixed(1)) : undefined,
          enableAI: m.params.enableAI,
        };
      }
      console.log("==========================================");
      console.log("📍 SCENE MODEL LOCATIONS (JSON):");
      console.log(JSON.stringify(result, null, 2));
      console.log("==========================================");
      alert("Model positions logged to Console (Press F12 to view and copy)!");
    }
  };

  gui.add(actions, "logCoordinates").name("📋 Log Coordinates to Console");

  for (const [id, model] of Object.entries(editableModels)) {
    const folder = gui.addFolder(model.name);
    folder.close();

    folder.add(model.params, "posX", -200, 200, 0.1).name("Position X").listen().onChange(model.updateTransform);
    folder.add(model.params, "posY", -10, 50, 0.1).name("Position Y (Floor = 0)").listen().onChange(model.updateTransform);
    folder.add(model.params, "posZ", -200, 200, 0.1).name("Position Z").listen().onChange(model.updateTransform);
    folder.add(model.params, "rotY", 0, 360, 1).name("Rotation Y (deg)").listen().onChange(model.updateTransform);
    folder.add(model.params, "scale", 0.01, 20, 0.01).name("Scale (From Floor)").listen().onChange(model.updateTransform);
    folder.add(model.params, "visible").name("Visible").listen().onChange(model.updateTransform);

  }

  if (zombieManager) {
    const zFolder = gui.addFolder("👹 Monsters & Levels");
    zFolder.close();
    zFolder.add(zombieManager.settings, "enableAI").name("🤖 Enable AI Behavior");
    const jump = { level: 1, go() { director.start(Math.max(1, Math.round(jump.level))); } };
    zFolder.add(jump, "level", 1, 20, 1).name("Level");
    zFolder.add(jump, "go").name("▶ Start that level");
    // Test spawns ~25 m in front of you (solo / host only)
    const spawnAhead = (type, dist) => {
      if (net.isClient) return;
      const x = characterBody.position.x + Math.sin(aimYaw) * dist, z = characterBody.position.z + Math.cos(aimYaw) * dist;
      const m = zombieManager.spawn(type, x, z, { homeX: characterBody.position.x, homeZ: characterBody.position.z, hunting: true });
      if (!m) inventoryUI.feed(`Couldn't spawn a ${MONSTER_TYPES[type].label} there`, "info");
    };
    const spawns = { hounds() { for (let i = 0; i < 3; i++) spawnAhead("hound", 22 + i * 2); }, dragon() { spawnAhead("dragon", 40); } };
    zFolder.add(spawns, "hounds").name("🐺 Spawn hellhound pack");
    zFolder.add(spawns, "dragon").name("🐉 Spawn dragon");
  }

  // Prevent pointer lock while interacting with lil-gui
  gui.domElement.addEventListener("mousedown", e => e.stopPropagation());
  gui.domElement.addEventListener("click", e => e.stopPropagation());
}

// ─── Zombie Manager (Pooled MD2 Instances) ────────────────────────────────────
let zombieManager = null;
let houses = null;
let roads = null;          // world/Roads.js, built in loadWorld()
let collegeGate = null;    // world/CollegeGate.js, placed in loadWorld()
let indiaModels = {};      // world/IndiaAssets.js: { rickshaw, thar, truck, … } (null where missing)
let townLabels = [];       // town names for the world map
let roadLines = [];        // road centrelines for the maps

// ─── Character GLTF Load ──────────────────────────────────────────────────────
async function loadCharacter() {
  await soldier.load(gltfLoader);
}

// ─── World Assets Load ────────────────────────────────────────────────────────
// One GLTF loader for everything, with meshopt decoding for the optimized assets
const gltfLoader = new GLTFLoader();
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

/**
 * Loads "<name>.opt.glb" (written by `npm run optimize-assets`) when present,
 * otherwise the original file. Missing files come back as Vite's index.html,
 * which fails to parse, so a failed load of the .opt file is the fallback signal.
 */
async function loadGLB(url) {
  const opt = url.replace(/\.glb$/, ".opt.glb");
  try {
    return await gltfLoader.loadAsync(opt);
  } catch {
    return gltfLoader.loadAsync(url);
  }
}

async function loadWorld() {
  const vrmlLoader = new VRMLLoader();
  const settle = p => p.then(v => v, err => { console.warn(err); return null; });

  // Fetch and parse everything at once instead of one model after another
  // (the dragon and the hellhound are monsters now: MonsterPool loads them)
  const downloads = Promise.all([
    settle(loadGLB("/models/autorickshaw_3d_model_free.glb")),
    settle(vrmlLoader.loadAsync("/models/house.wrl")),
    // ?v=: bump when the kit changes (/models is cached for a day, a stale kit would miss pieces)
    gltfLoader.loadAsync("/models/house/house-kit.glb?v=2"),
    loadGLB("/trees/old_tree_with_vine_3d_model_free.glb"),
    loadGLB("/trees/dreftwood tree.glb"),
    // Far-away versions (~20% of the triangles), made by `npm run optimize-assets`
    settle(gltfLoader.loadAsync("/trees/old_tree_with_vine_3d_model_free.lod1.glb")),
    settle(gltfLoader.loadAsync("/trees/dreftwood tree.lod1.glb")),
    settle(loadGLB("/models/msbecl_gate_final.glb")),
    loadIndiaModels(gltfLoader),
  ]);
  // The caves' heavy lifting (rock field, mesh, torches, baked light) needs no
  // terrain: do it while the models above are still downloading
  await new Promise(r => setTimeout(r, 0));
  precomputeCaves();
  const [autoGltf, wrlScene, houseKit, treeAGltf, treeBGltf, treeALod, treeBLod, gateGltf, india] = await downloads;
  loadMark("world downloaded");
  indiaModels = india;
  // The real Parle-G pack and ₹2000 notes replace the procedural ones (before any pickup is built)
  if (india.biscuit) setItemModel("biscuit", india.biscuit, 0.22);
  if (india.rupees) setItemModel("cash", india.rupees, 0.18);
  // Every tree clone shares these: one mesh per material instead of dozens of parts
  mergeStaticMeshes(treeAGltf.scene);
  mergeStaticMeshes(treeBGltf.scene);
  const lodA = treeLodTemplate(treeALod, treeAGltf.scene);
  const lodB = treeLodTemplate(treeBLod, treeBGltf.scene);


  if (wrlScene) {
    // VRMLLoader turns the file's Background node into 10 km sky/ground spheres.
    // They showed up as a pale wedge on the horizon and blew the collider up to 20 km.
    const sky = [];
    wrlScene.traverse(o => { if (o.isMesh && o.geometry?.parameters?.radius >= 5000) sky.push(o); });
    for (const o of sky) o.parent.remove(o);
    createEditableModel({
      id: "wrlHouse",
      name: "🏠 WRL House",
      object3D: wrlScene,
      initialParams: { posX: -35, posY: 0, posZ: -35, rotY: 0, scale: 1.0 },
      perMeshColliders: true, // a box per wall, floor and stair so it's solid like a real building
    });
  }

  // Enterable houses (Kenney kits): per-wall colliders, animated doors, light switches
  houses = new Houses({ scene, world, gltf: houseKit, sfx, material: staticMaterial, obstacles: navObstacles });

  // Scale that makes a model `mul` player heights tall
  const heightScale = (root, mul) => {
    root.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(root);
    return (CHARACTER_HEIGHT * mul) / ((b.max.y - b.min.y) || 1);
  };

  createEditableModel({
    id: "treeA",
    name: "🌳 Old Tree (Vine)",
    object3D: treeAGltf.scene.clone(true),
    initialParams: { posX: -12, posY: 0, posZ: -30, rotY: 0, scale: heightScale(treeAGltf.scene, 7) },
    trunkCollider: true,
  });

  createEditableModel({
    id: "treeB",
    name: "🪵 Driftwood Tree",
    object3D: treeBGltf.scene.clone(true),
    initialParams: { posX: 14, posY: 0, posZ: -32, rotY: 90, scale: heightScale(treeBGltf.scene, 5) },
    trunkCollider: true,
  });

  // Enable shadows on templates
  [treeAGltf.scene, treeBGltf.scene].forEach(root => {
    root.traverse(child => {
      if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
    });
  });

  const treeATemplate = treeAGltf.scene;
  const treeBTemplate = treeBGltf.scene;

  treeATemplate.scale.setScalar(1);
  treeATemplate.updateWorldMatrix(true, false);
  const treeABounds = new THREE.Box3().setFromObject(treeATemplate);
  const treeARawH   = treeABounds.max.y - treeABounds.min.y || 1;
  const treeASnapAtOne = -treeABounds.min.y;

  treeBTemplate.scale.setScalar(1);
  treeBTemplate.updateWorldMatrix(true, false);
  const treeBBounds = new THREE.Box3().setFromObject(treeBTemplate);
  const treeBRawH   = treeBBounds.max.y - treeBBounds.min.y || 1;
  const treeBSnapAtOne = -treeBBounds.min.y;

  const treeAScaleMin = CHARACTER_HEIGHT * TREE_A_HEIGHT_MUL[0] / treeARawH;
  const treeAScaleMax = CHARACTER_HEIGHT * TREE_A_HEIGHT_MUL[1] / treeARawH;
  const treeBScaleMin = CHARACTER_HEIGHT * TREE_B_HEIGHT_MUL[0] / treeBRawH;
  const treeBScaleMax = CHARACTER_HEIGHT * TREE_B_HEIGHT_MUL[1] / treeBRawH;

  // ── Towns and roads (world/Towns.js, world/Roads.js): the same map for every player
  roads = new Roads(ROAD_DEFS);
  // Where the rickshaws and Thars are parked, the dukaan stalls and the
  // Indian props stand (towns, trees, rocks and poles keep clear of them).
  // r: a radius round each one's footprint
  const parked = vehicleSpawns(roads);
  const stalls = shopSpots(roads);
  const props = propSpots(roads);
  const reserved = [
    ...parked.map(p => ({ x: p.x, z: p.z, r: VEHICLES[p.kind].length / 2 + 0.5 })),
    ...stalls.map(s => ({ x: s.x, z: s.z, r: 2.4 })),
    ...props,
  ];
  // Asked for every grass texel and tree / rock / pole candidate: a coarse grid keeps it to nearby spots
  const RES_CELL = 8, RES_PAD = 6, resGrid = new Map();
  const resKey = (ix, iz) => ix * 4096 + iz;
  for (const p of reserved) {
    const R = p.r + RES_PAD;
    for (let ix = Math.floor((p.x - R) / RES_CELL); ix <= Math.floor((p.x + R) / RES_CELL); ix++) {
      for (let iz = Math.floor((p.z - R) / RES_CELL); iz <= Math.floor((p.z + R) / RES_CELL); iz++) {
        const k = resKey(ix, iz);
        if (!resGrid.has(k)) resGrid.set(k, []);
        resGrid.get(k).push(p);
      }
    }
  }
  const nearParked = (x, z, pad) => {
    const list = pad <= RES_PAD ? resGrid.get(resKey(Math.floor(x / RES_CELL), Math.floor(z / RES_CELL))) : reserved;
    if (!list) return false;
    for (const p of list) if (Math.hypot(x - p.x, z - p.z) < p.r + pad) return true;
    return false;
  };
  const town = layoutTowns({
    roads, rng: makeLCG(0x7095a1), halfSize: houseHalfSize,
    blocked: (x, z, r) => caveBlocks(x, z, r),
    keepClear: [
      { x: 0, z: 0, r: 16 },                                   // spawn
      ...reserved.map(p => ({ x: p.x, z: p.z, r: p.r + 2.5 })), // parked vehicles, stalls, Indian props
      { x: COLLEGE_GATE.x, z: COLLEGE_GATE.z, r: COLLEGE_GATE.clear }, // the college gate over the North Road
      ...STARTER_LOOT.map(([, x, z]) => ({ x, z, r: 1.5 })),
      ...DEBRIS_SPOTS.map(([x, z]) => ({ x, z, r: 4 })),
      // The WRL house and the two hand-placed trees
      ...mapObstacles.map(o => ({ x: o.x, z: o.z, r: o.type === "circle" ? o.r + 2 : Math.hypot(o.w, o.d) / 2 + 2 })),
    ],
    heightAt: rawHeight,
  });
  const plateaus = town.plateaus;
  townLabels = town.labels;
  for (const h of town.houses) houses.add(h.x, h.z, h.rot, { type: h.kind, base: flatHeight(h.x, h.z, plateaus), tint: h.tint });
  for (const y of town.yards) houses.addCompound(y.x, y.z, y.rot, y.hw, y.hd, y.gateX, flatHeight(y.x, y.z, plateaus), y.tint);
  houses.finalize();
  mapObstacles.push(...houses.mapObstacles());

  // ── Rolling ground: towns on their own level plateaus, flat under every prop, hills in between
  const lvl = (x, z) => flatHeight(x, z, plateaus);
  const pads = [
    ...plateaus,
    { x: 0, z: 0, r: 16, fade: 14 },                                                         // spawn + starter loot
    ...reserved.map(p => ({ x: p.x, z: p.z, r: p.r + 1, fade: 6, y: lvl(p.x, p.z) })),        // parked vehicles, stalls, props
    { x: COLLEGE_GATE.x, z: COLLEGE_GATE.z, r: COLLEGE_GATE.width / 2 + 2, fade: 12, y: lvl(COLLEGE_GATE.x, COLLEGE_GATE.z) }, // level under the gate
  ];
  for (const o of mapObstacles) {
    if (o.house || o.wall || o.pole) continue;
    if (o.type === "box") pads.push({ x: o.x, z: o.z, r: Math.hypot(o.w, o.d) / 2 + 2.5, fade: 12, y: lvl(o.x, o.z) });
    else pads.push({ x: o.x, z: o.z, r: 3, fade: 6, y: lvl(o.x, o.z) }); // the two hand-placed trees
  }
  for (const [x, z] of DEBRIS_SPOTS) pads.push({ x, z, r: 3, fade: 6, y: lvl(x, z) });
  // Road profiles ride the padded ground, held level through the towns
  roads.setProfile((x, z) => flatHeight(x, z, pads), plateaus);
  roadLines = roads.mapLines();
  const propBoxes = mapObstacles.filter(o => o.type === "box" && !o.house && !o.wall);
  buildTerrain({
    scene, world, material: planeMaterial, physicsMaterial: groundMaterial, pads,
    renderStep: QUALITY.terrainStep,
    // Roads level the ground under them; the ground sinks to the cave floors under the massifs
    modify: (x, z, h) => caveTerrain(x, z, roads.modify(x, z, h)),
    tint: (x, z, c) => roads.tint(x, z, c),
    // No grass on roads, through floors, props, parked vehicles or rock; trimmed in yards
    grassMask: (x, z) => {
      if (houses.blocks(x, z, 1.5) || nearParked(x, z, 0.3)) return 0;
      if (roads.onRoad(x, z, 0.6)) return 0;
      for (const o of propBoxes) if (Math.hypot(x - o.x, z - o.z) < Math.hypot(o.w, o.d) / 2 + 1) return 0;
      return (0.55 + fbmGrass(x, z) * 0.45) * caveGrass(x, z) * (houses.inYard(x, z) ? 0.3 : 1);
    },
  });
  roads.buildMesh(scene);

  // The college gate across the North Road (after the terrain: it stands on it)
  if (gateGltf) {
    collegeGate = placeCollegeGate({
      gltf: gateGltf, scene, world, material: staticMaterial, roads, groundAt: groundHeight, mapObstacles, navObstacles,
    });
  }
  const nearGate = (x, z, pad) => !!collegeGate?.blocks(x, z, pad);

  // Dukaan stalls and the Indian props (after the terrain too)
  shops = buildShops({ scene, world, material: staticMaterial, spots: stalls, groundAt: groundHeight, mapObstacles, navObstacles });
  indiaBuildings = placeIndiaProps({
    scene, world, material: staticMaterial, spots: props, groundAt: groundHeight, mapObstacles, navObstacles,
    models: { truck: indiaModels.truck, panchayat: indiaModels.panchayat, townBuilding: indiaModels.townBuilding },
  });

  // Underground cave networks under rock massifs (world/Caves.js): needs the final terrain
  caves = new Caves({ scene, world, physicsMaterial: staticMaterial, lights: QUALITY.caveLights });
  caveMapShapes = caves.mapInfo();

  // Power poles along the roads (after the terrain: they stand on it)
  roads.buildPoles({
    scene, world, material: staticMaterial, mapObstacles, groundAt: groundHeight,
    blocked: (x, z) => houses.blocks(x, z, 1.2) || houses.inYard(x, z) || caveBlocks(x, z, 2) || nearGate(x, z, 1)
      || nearParked(x, z, 2)
      || DEBRIS_SPOTS.some(([dx, dz]) => Math.hypot(dx - x, dz - z) < 4)
      || STARTER_LOOT.some(([, lx, lz]) => Math.hypot(lx - x, lz - z) < 2),
  });

  // Big trees stay out of houses (a scattered tree used to land on one)
  const keepClear = (list, pad) => list.filter(({ x, z }) => !houses.blocks(x, z, pad) && !caveBlocks(x, z, pad + 4)
    && !roads.onRoad(x, z, pad) && !houses.inYard(x, z) && !nearGate(x, z, pad));
  const treeAPositions = keepClear(scatterPositions(TREE_A_COUNT, rng, SCATTER_RADIUS_MIN, SCATTER_RADIUS_MAX * 0.6, 8), 5);
  const treeBPositions = keepClear(scatterPositions(TREE_B_COUNT, rng, SCATTER_RADIUS_MIN, SCATTER_RADIUS_MAX * 0.6, 7), 4);

  for (const { x, z } of treeAPositions) {
    const scale = rngRange(rng, treeAScaleMin, treeAScaleMax);
    const rotY  = rng() * Math.PI * 2;
    const snapY = treeASnapAtOne * scale + groundHeight(x, z) - 0.2;
    const clone = treeWithLod(treeATemplate, lodA);
    clone.position.set(x, snapY, z);
    clone.rotation.y = rotY;
    clone.scale.setScalar(scale);
    scene.add(clone);
    freezeStatic(clone);
    addTreeCollider(x, snapY, z, rotY, scale, 0.18, 5.0, 2.8, 6.0);
  }

  for (const { x, z } of treeBPositions) {
    const scale = rngRange(rng, treeBScaleMin, treeBScaleMax);
    const rotY  = rng() * Math.PI * 2;
    const snapY = treeBSnapAtOne * scale + groundHeight(x, z) - 0.2;
    const clone = treeWithLod(treeBTemplate, lodB);
    clone.position.set(x, snapY, z);
    clone.rotation.y = rotY;
    clone.scale.setScalar(scale);
    scene.add(clone);
    freezeStatic(clone);
    addTreeCollider(x, snapY, z, rotY, scale, 0.22, 4.0, 2.2, 5.0);
  }

  // Burning wrecks: a few charred debris piles, each pouring smoke (listed
  // first so the fires are kept clear of the forest)
  const fireSpots = [];
  for (const [x, z] of DEBRIS_SPOTS) {
    if (houses.blocks(x, z, 4) || nearObstacle(x, z, 3)) continue;
    fireSpots.push({ x, y: groundHeight(x, z) + 0.15, z, scale: 0.75 });
    addDebrisPile(x, z);
  }
  atmosphere.setSources(fireSpots);

  // Drivable vehicles: the Thar uses a stand-in jeep until its model is in public/models/india/
  headlight = new THREE.SpotLight(0xffe6b8, 0, 52, 0.5, 0.5, 1.3);
  headlight.castShadow = false;
  scene.add(headlight, headlight.target);
  const vehicleModels = { rickshaw: indiaModels.rickshaw ?? autoGltf?.scene ?? null, thar: indiaModels.thar ?? null };
  parked.forEach((spawn, index) => {
    const src = vehicleModels[spawn.kind];
    if (spawn.kind === "rickshaw" && !src) return;
    const model = src ? src.clone(true) : standInJeep();
    // The old free rickshaw model (the fallback) points its nose along +X
    const modelYaw = spawn.kind === "rickshaw" && !indiaModels.rickshaw ? -Math.PI / 2 : null;
    const v = new Vehicle({ scene, world, kind: spawn.kind, model, material: staticMaterial, spawn, index, standIn: !src, modelYaw });
    vehicles[index] = v;
    mapObstacles.push(v.footprint);
  });

  // Stones: boulders are solid and the same everywhere; pebbles follow the quality setting
  const keepOff = (x, z, pad) => Math.hypot(x, z) < 15 || houses.blocks(x, z, pad + 2) || nearObstacle(x, z, pad)
    || caveBlocks(x, z, pad + 2) || roads.onRoad(x, z, pad + 1) || houses.inYard(x, z) || nearGate(x, z, pad)
    || nearParked(x, z, 3 + pad)
    || STARTER_LOOT.some(([, lx, lz]) => Math.hypot(lx - x, lz - z) < 2 + pad)
    || fireSpots.some(f => Math.hypot(f.x - x, f.z - z) < 4 + pad);
  scatterRocks({
    scene, world, material: staticMaterial, mapObstacles,
    boulderRng: makeLCG(0xb01de55), pebbleRng: makeLCG(0x9ebb1e5), coverRng: makeLCG(0xc0fe12),
    boulders: BOULDER_COUNT, pebbles: QUALITY.pebbles, cover: COVER_ROCK_COUNT, ringMin: 12, ringMax: 230,
    blocked: (x, z, r) => keepOff(x, z, r),
  });

  // The dead forest, sized against the player
  plantDeadForest({
    scene, world, material: staticMaterial, rng: makeLCG(0x5eedf0e5),
    count: DEAD_TREE_COUNT, playerHeight: CHARACTER_HEIGHT, heightMul: DEAD_TREE_HEIGHT_MUL,
    ringMin: 14, ringMax: 175, mapObstacles,
    blocked: (x, z) => Math.hypot(x, z) < 12 || houses.blocks(x, z, 4) || nearObstacle(x, z, 3.5) || caveBlocks(x, z, 4)
      || roads.onRoad(x, z, 3) || houses.inYard(x, z, -3) || nearGate(x, z, 2)
      || nearParked(x, z, 5)
      || STARTER_LOOT.some(([, lx, lz]) => Math.hypot(lx - x, lz - z) < 3)
      || fireSpots.some(s => Math.hypot(s.x - x, s.z - z) < 5),
  });
}

const DEBRIS_SPOTS = [[26, 12], [-31, 9], [9, -47], [-5, 39], [48, 30]];

// ─── Tree LOD ─────────────────────────────────────────────────────────────────
// The two tree models are ~85k and ~65k triangles: most of the frame's
// triangles, twice over with shadows. Past TREE_LOD_DIST a scattered tree
// switches to its *.lod1.glb (~20% of the triangles, same UVs) drawn with the
// full tree's material, so it costs no extra texture memory.
// ?lod=0 keeps full detail everywhere (A/B comparisons)
const TREE_LOD_DIST = new URLSearchParams(location.search).get("lod") === "0" ? Infinity : 45;

/** The LOD model merged and wearing the full tree's material, or null (missing file: full detail everywhere). */
function treeLodTemplate(gltf, full) {
  if (!gltf) return null;
  mergeStaticMeshes(gltf.scene);
  let material = null;
  full.traverse(o => { if (!material && o.isMesh) material = o.material; });
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    o.material = material;
    o.castShadow = true;
    o.receiveShadow = true;
  });
  return gltf.scene;
}

function treeWithLod(template, lodTemplate) {
  if (!lodTemplate) return template.clone(true);
  const lod = new THREE.LOD();
  lod.addLevel(template.clone(true), 0);
  lod.addLevel(lodTemplate.clone(true), TREE_LOD_DIST);
  return lod;
}

/** Patchy grass density: thick in places, thin in others. */
function fbmGrass(x, z) {
  return 0.5 + 0.5 * Math.sin(x * 0.045 + Math.sin(z * 0.06) * 2) * Math.cos(z * 0.05 + Math.sin(x * 0.03) * 2);
}

/** Rough clearance test against everything already on the minimap. */
function nearObstacle(x, z, pad) {
  for (const o of mapObstacles) {
    const r = o.type === "circle" ? o.r : Math.hypot(o.w, o.d) / 2;
    if (Math.hypot(o.x - x, o.z - z) < r + pad) return true;
  }
  return false;
}

// Charred logs around a fire spot (one instanced mesh for every pile)
const debrisLogs = [];
function addDebrisPile(x, z) {
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.random() * 0.5;
    debrisLogs.push({ x: x + Math.cos(a) * 0.35, z: z + Math.sin(a) * 0.35, rot: a, tilt: 0.25 + Math.random() * 0.3, len: 1 + Math.random() * 0.6 });
  }
  if (!addDebrisPile.mesh) {
    const mesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.09, 0.12, 1, 6).rotateZ(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x1a1210, roughness: 1, emissive: 0x3a0a00, emissiveIntensity: 0.6 }),
      40);
    mesh.count = 0;
    mesh.castShadow = true;
    scene.add(mesh);
    addDebrisPile.mesh = mesh;
  }
  const mesh = addDebrisPile.mesh, m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  mesh.count = Math.min(40, debrisLogs.length);
  debrisLogs.slice(0, 40).forEach((l, i) => {
    q.setFromEuler(e.set(0, l.rot, l.tilt));
    mesh.setMatrixAt(i, m4.compose(_vecA.set(l.x, groundHeight(l.x, l.z) + 0.12, l.z), q, _vecB.set(l.len, 1, 1)));
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}

// ─── Co-op multiplayer ────────────────────────────────────────────────────────
// One player in a room is the host: it runs the monsters + level director and
// streams them to the others. Everyone streams their own player state.
const net = new Net();
const NET_STATE_HZ = 20;
const NET_MONSTER_HZ = 12;
const NET_LEVEL_HZ = 2;
let netStateTimer = 0, netMonsterTimer = 0, netLevelTimer = 0, squadTimer = 0, wipeTimer = 0;
let myName = "Survivor";
let monsterSync = null;

const remotePlayers = new RemotePlayers({
  scene, world, loader: gltfLoader, effects, sfx, material: characterMaterial,
  capsule: { radius: CHARACTER_RADIUS, height: CAPSULE_HEIGHT },
  addCapsule: addCapsuleToBody,
});
// Smoke hides enemy name tags in the battle royale
remotePlayers.concealed = (from, to) => smokeFX.blocks(from, to);
// Teammates' and enemies' footsteps, from where they are
const _stepAt = { x: 0, y: 0, z: 0 };
remotePlayers.onStep = (p, x, feetY, z, vol) => {
  _stepAt.x = x; _stepAt.y = feetY + 0.1; _stepAt.z = z;
  sfx.footstep(footSurface(x, feetY, z), vol, _stepAt);
};

// What the monsters can target: you + every teammate
const localTarget = { id: 0, pos: characterBody.position, vel: characterBody.velocity, alive: true, vis: 1, local: true };
characterBody.playerTarget = localTarget;
const _allTargets = [];

function getTargets() {
  localTarget.alive = playerHealth > 0;
  localTarget.vis = playerVisibility();
  localTarget.aimOff = STANCES[stance].aimOff;
  localTarget.eyeOff = STANCES[stance].eyeOff;
  _allTargets.length = 0;
  _allTargets.push(localTarget);
  for (const t of remotePlayers.targets()) _allTargets.push(t);
  return _allTargets;
}

/** A monster hit a player: you take it directly, teammates get a message. */
function onPlayerHit(target, dmg, kx, kz, shake, sx, sz) {
  if (target.local) { dealDamageToPlayer(dmg, kx, kz, shake, sx, sz, "monster"); return; }
  // A teammate bleeds where everyone here can see it
  _bleedAt.set(target.pos.x, target.pos.y + 0.3, target.pos.z);
  effects.bleed(_bleedAt, target.pos.x - sx, target.pos.z - sz, Math.min(18, 5 + dmg * 0.4));
  net.send({ t: "hurt", to: target.id, d: +dmg.toFixed(1), kx: +kx.toFixed(2), kz: +kz.toFixed(2), sh: shake, sx: +sx.toFixed(2), sz: +sz.toFixed(2) });
}

/** Footsteps, gunfire, doors: the host's monsters hear everyone. */
function makeNoise(x, z, r, kind) {
  if (isBR()) return; // no monsters to hear it
  if (net.isClient) net.send({ t: "noise", to: "host", x: +x.toFixed(2), z: +z.toFixed(2), r, k: kind });
  else zombieManager?.noise(x, z, r, kind);
}

/** Your bullet hit a monster: host/solo apply it, clients ask the host. */
function hitMonster(m, dmg, px, pz) {
  if (net.isClient) {
    net.send({ t: "hit", to: "host", n: m.netId, d: +dmg.toFixed(1), px: +px.toFixed(2), pz: +pz.toFixed(2) });
    m.flashTimer = 0.07;
    m.mesh.material = m.mats.hit;
    return false;
  }
  return zombieManager.damage(m, dmg, px, pz, localTarget.id);
}

const _gunNames = new Map(Object.entries(ENEMY_GUNS).map(([k, v]) => [v, k]));
const _efFrom = new THREE.Vector3();
const _efTo = new THREE.Vector3();
const _vecA = new THREE.Vector3();
const _vecB = new THREE.Vector3();

// Host: replay monster gunfire on the clients
enemyFire.onFire = (gun, from, target, spread, sx, sz) => {
  if (!net.isHost || remotePlayers.count === 0) return;
  net.send({
    t: "ef", g: _gunNames.get(gun), s: +spread.toFixed(2), sx: +sx.toFixed(1), sz: +sz.toFixed(1),
    f: [+from.x.toFixed(2), +from.y.toFixed(2), +from.z.toFixed(2)],
    a: [+target.x.toFixed(2), +target.y.toFixed(2), +target.z.toFixed(2)],
  });
};

function updateSquadPlayerCount() {
  if (director) director.playerCount = 1 + remotePlayers.count;
}

function onConnected(welcome) {
  localTarget.id = net.id;
  for (const p of welcome.players) if (p.id !== net.id) remotePlayers.add(p);
  if (net.isClient) {
    // The host owns the monsters; ours become puppets of its snapshots
    zombieManager.clearAll();
    zombieManager.pool.setPuppetMode(true);
    inventoryUI.feed(`Joined room "${net.room}" · host: ${net.players.get(net.hostId)?.name ?? "?"}`, "info");
  } else {
    inventoryUI.feed(`Hosting room "${net.room}". Friends join with the same code.`, "info");
  }
  updateSquadPlayerCount();
}

function becomeHost() {
  if (isBR()) {
    // The match clock, zone and alive list are already here: just carry on
    inventoryUI.feed("You're hosting the match now", "info");
    brCheckWinner();
    return;
  }
  monsterSync?.becomeHost();
  updateSquadPlayerCount();
  // Pick the fight back up from the current level
  director.start(director.level?.n ?? 1);
  inventoryUI.feed("You're hosting the horde now", "info");
}

net.on("joined", msg => {
  remotePlayers.add(msg.p);
  inventoryUI.feed(`${msg.p.name} joined the fight`, "weapon");
  updateSquadPlayerCount();
  if (isBR()) {
    br.netTimer = 0; // send them the match state right away
    if (net.isHost) net.send({ t: "world", to: msg.p.id, doors: houses.houses.map(h => h.doorOpen), lights: houses.houses.map(h => h.floors.map(f => f.lightOn)), veh: vehiclesState(), gate: collegeGate && { ...collegeGate.state } });
    return;
  }
  if (net.isHost) {
    // Catch the newcomer up on doors and lights
    net.send({
      t: "world", to: msg.p.id,
      doors: houses.houses.map(h => h.doorOpen),
      lights: houses.houses.map(h => h.floors.map(f => f.lightOn)),
      veh: vehiclesState(),
      gate: collegeGate && { ...collegeGate.state },
    });
  }
});
net.on("left", msg => {
  const name = remotePlayers.players.get(msg.id)?.name ?? "A player";
  remotePlayers.remove(msg.id);
  if (worldMap.pins.has(msg.id)) setPin(msg.id, null);
  for (const v of vehicles) if (v.driver === msg.id) v.releaseRemote();
  inventoryUI.feed(`${name} left`, "info");
  updateSquadPlayerCount();
  if (isBR()) brOnPlayerLeft(msg.id);
});
net.on("host", msg => { if (msg.id === net.id) becomeHost(); });
net.on("disconnect", () => {
  if (isBR()) {
    brHud.showResult({ title: "DISCONNECTED", sub: "Lost the connection to the server", foot: "Reload the page to play again", color: "#ff4b3a" });
    return;
  }
  const wasClient = localTarget.id !== net.hostId;
  remotePlayers.clear();
  inventoryUI.feed("Disconnected from co-op: playing solo", "info");
  if (wasClient) becomeHost();
  updateSquadPlayerCount();
});

net.on("st", msg => remotePlayers.applyState(msg.from, msg));
net.on("pin", msg => {
  if (gameMode !== "coop") return;
  const fresh = !worldMap.pins.has(msg.from);
  setPin(msg.from, msg.c ? null : msg.x, msg.c ? null : msg.z);
  if (!msg.c && fresh) inventoryUI.feed(`${net.players.get(msg.from)?.name ?? "A teammate"} marked a spot`, "info");
});
net.on("shot", msg => {
  remotePlayers.shot(msg.from, msg);
  noteShot(msg.from, msg.f[0], msg.f[2]);
});
// A teammate reloading, eating, opening a door, flinching, vaulting
net.on("anim", msg => {
  const s = remotePlayers.players.get(msg.from)?.soldier;
  if (!s) return;
  if (msg.g) s.playGesture(msg.g, msg.d);
  else if (msg.c) s.playClip(msg.c, msg.d, msg.w ?? 1);
});
net.on("hurt", msg => dealDamageToPlayer(msg.d, msg.kx, msg.kz, msg.sh, msg.sx, msg.sz, "monster"));
net.on("throw", msg => {
  throwables.throw(msg.k, _vecA.set(msg.o[0], msg.o[1], msg.o[2]), _vecB.set(msg.v[0], msg.v[1], msg.v[2]), msg.from, msg.c ?? 0, msg.f);
});
net.on("door", msg => { const h = houses.houses[msg.h]; if (h) houses.setDoor(h, msg.o); });
net.on("gate", msg => collegeGate?.setState(msg.p, msg.o));
net.on("light", msg => {
  const f = houses.houses[msg.h]?.floors[msg.f ?? 0];
  if (f && f.lightOn !== msg.on) houses.toggleLight(f);
});
net.on("world", msg => {
  if (msg.gate) for (const part of ["gate", "booth"]) collegeGate?.setState(part, msg.gate[part], true);
  msg.doors.forEach((o, i) => { if (houses.houses[i]) houses.setDoor(houses.houses[i], o); });
  // Per house: [ground, upstairs] (a plain boolean from an older client: the ground floor)
  msg.lights.forEach((ons, i) => {
    [].concat(ons).forEach((on, fi) => {
      const f = houses.houses[i]?.floors[fi];
      if (f && f.lightOn !== on) houses.toggleLight(f);
    });
  });
  // Where every vehicle is parked ([[x, z, yaw, fuel], …]; an older host sends just the rickshaw's)
  const parkedNow = msg.veh && !Array.isArray(msg.veh[0]) ? [msg.veh] : msg.veh ?? [];
  parkedNow.forEach((p, i) => {
    const v = vehicles[i];
    if (!v || v.driver !== null || !p) return;
    [v.x, v.z, v.yaw, v.fuel] = p;
    v.place();
  });
});
net.on("drop", msg => pickups.spawn(msg.k, msg.x, msg.z, unpackLoot(msg), msg.l ?? Infinity, msg.i ?? null, msg.y ?? null));

// ── Shared loot: the host decides who gets it ────────────────────────────────
// Taking a shared pickup (battle royale loot, anyone's drops) asks the host
// first; the host grants the first claim and tells everyone it's gone, so two
// players can't both take one item. Solo / unshared loot is taken at once.
const lootClaims = new Map();  // id → { entry, apply, t } waiting for the host
const takenLoot = new Set();   // host: ids already given out

function claimLoot(entry, apply) {
  const id = entry.id;
  if (id === null || !net.connected) { apply(); return; }
  if (net.isHost) {
    if (takenLoot.has(id)) { pickups.release(entry); return; }
    takenLoot.add(id);
    net.send({ t: "take", i: id, by: net.id });
    apply();
    return;
  }
  if (lootClaims.has(id)) return;
  entry.pending = true;
  lootClaims.set(id, { entry, apply, t: performance.now() });
  net.send({ t: "claim", i: id, to: "host" });
}

net.on("claim", msg => {
  if (!net.isHost) return;
  if (takenLoot.has(msg.i)) { net.send({ t: "deny", i: msg.i, to: msg.from }); return; }
  takenLoot.add(msg.i);
  pickups.releaseById(msg.i);
  net.send({ t: "take", i: msg.i, by: msg.from });
});
net.on("take", msg => {
  if (net.isHost) takenLoot.add(msg.i);
  const c = lootClaims.get(msg.i);
  lootClaims.delete(msg.i);
  if (c && msg.by === net.id) { c.apply(); return; } // ours: apply() takes and releases it
  if (c) inventoryUI.feed("Someone else got there first", "info");
  pickups.releaseById(msg.i);
});
net.on("deny", msg => {
  const c = lootClaims.get(msg.i);
  lootClaims.delete(msg.i);
  if (!c) return;
  c.entry.pending = false;
  pickups.release(c.entry); // the host gave it to someone else
  inventoryUI.feed("Item no longer available", "info");
});
/** Claims the host never answered (it left mid-claim): let the loot be tried again. */
function expireLootClaims() {
  if (!lootClaims.size) return;
  const now = performance.now();
  for (const [id, c] of lootClaims) {
    if (now - c.t < 2500) continue;
    lootClaims.delete(id);
    c.entry.pending = false;
  }
}
net.on("kill", msg => {
  // c: how it died (killCause), from the host
  const m = monsterSync?.findPuppet(msg.n);
  killsThisLife++;
  progress.kill(m?.type, msg.c ?? "gun", env.darkness > NIGHT_DARKNESS);
  onLocalKill(msg.c === "head");
  showHitMarker(msg.c === "head", true);
  sfx.kill();
  if (m) gameHud.killFeed(m.def.label, "KILLED", m.def.color, false);
});

// Host-only inputs from clients
net.on("hit", msg => {
  if (!net.isHost) return;
  const m = zombieManager.active.find(x => x.netId === msg.n && !x.dying);
  if (m) zombieManager.damage(m, msg.d, msg.px, msg.pz, msg.from);
});
net.on("noise", msg => { if (net.isHost) zombieManager.noise(msg.x, msg.z, msg.r, msg.k); });

// Client-only: the host's world
net.on("mon", msg => { if (net.isClient) monsterSync?.apply(msg.d); });
net.on("ef", msg => {
  if (!net.isClient) return;
  const gun = ENEMY_GUNS[msg.g];
  if (gun) enemyFire.fire(gun, _efFrom.set(msg.f[0], msg.f[1], msg.f[2]), _efTo.set(msg.a[0], msg.a[1], msg.a[2]), msg.s, msg.sx, msg.sz, 1, true);
});
net.on("lvl", msg => {
  if (!net.isClient || !director) return;
  applyWorldClock(msg.hr, msg.wx);
  if (director.level?.n !== msg.n || director.level.total !== msg.tot) {
    // msg.tot already counts the host's Warlords and dragons
    director.level = { ...getLevel(msg.n), total: msg.tot, boss: 0, dragon: 0 };
  }
  director.state = msg.s;
  director.killed = msg.k;
  director.timer = msg.tm;
});
net.on("lev", msg => {
  if (!net.isClient) return;
  if (msg.e === "start") onLevelStart(getLevel(msg.n));
  else if (msg.e === "clear") onLevelCleared(getLevel(msg.n));
  else if (msg.e === "boss") onBossSpawn({ def: MONSTER_TYPES.boss });
  else if (msg.e === "dragon") onDragonSpawn({ def: MONSTER_TYPES.dragon });
});
net.on("wipe", () => {
  gameHud.showBanner({ title: "SQUAD WIPED", sub: "Restarting the level", color: "#ff4b3a", duration: 4 });
});

function netTick(delta) {
  if (!net.connected) return;
  netStateTimer -= delta;
  if (netStateTimer <= 0) {
    netStateTimer = 1 / NET_STATE_HZ;
    const b = characterBody.position, v = characterBody.velocity;
    net.send({
      t: "st",
      x: +b.x.toFixed(2), y: +b.y.toFixed(2), z: +b.z.toFixed(2),
      vx: +v.x.toFixed(2), vz: +v.z.toFixed(2),
      by: +bodyYaw.toFixed(3), ay: +aimYaw.toFixed(3), ap: +aimPitch.toFixed(3),
      aim: input.aim ? 1 : 0, fire: timeSinceShot < 0.15 ? 1 : 0,
      w: inventory.current, hp: Math.max(0, Math.round(playerHealth)), dead: playerHealth <= 0 ? 1 : 0,
      vis: +playerVisibility().toFixed(2), k: killsThisLife, sn: STANCE_RANK[stance], g: _gearCode || undefined,
      ph: isBR() ? (br.ghost ? PHASE_PLANE : br.flight) : PHASE_GROUND,
      veh: drive.on
        ? [+drive.car.x.toFixed(2), +drive.car.z.toFixed(2), +drive.car.yaw.toFixed(3), +drive.car.speed.toFixed(2), +drive.car.fuel.toFixed(1), drive.car.index]
        : undefined,
    });
  }
  if (!net.isHost) return;
  if (isBR()) { brNetTick(delta); return; }

  netMonsterTimer -= delta;
  if (netMonsterTimer <= 0 && remotePlayers.count > 0) {
    netMonsterTimer = 1 / NET_MONSTER_HZ;
    net.send({ t: "mon", d: monsterSync.snapshot() });
  }
  netLevelTimer -= delta;
  if (netLevelTimer <= 0 && director?.level) {
    netLevelTimer = 1 / NET_LEVEL_HZ;
    net.send({
      t: "lvl", n: director.level.n, s: director.state, k: director.killed, tot: director.total, tm: +director.timer.toFixed(1),
      hr: +env.hour.toFixed(3), wx: weather.state,
    });
  }
  // Whole squad down for a few seconds: restart the level
  if (director?.state === "fight" && getTargets().every(t => !t.alive)) {
    wipeTimer += delta;
    if (wipeTimer > 4) {
      wipeTimer = 0;
      director.restart();
      net.send({ t: "wipe" });
      gameHud.showBanner({ title: "SQUAD WIPED", sub: "Restarting the level", color: "#ff4b3a", duration: 4 });
    }
  } else {
    wipeTimer = 0;
  }
}

// ─── Squad panel (co-op) ──────────────────────────────────────────────────────
const squadEl = document.getElementById("squad");
let squadHtml = "";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function updateSquad(delta) {
  squadTimer -= delta;
  if (squadTimer > 0) return;
  squadTimer = 0.25;
  let html = "";
  if (net.connected && !isBR()) {
    const me = net.players.get(net.id);
    const rows = [{ name: myName, color: me?.color ?? "#fff", hp: Math.max(0, playerHealth), kills: killsThisLife, me: true }];
    for (const p of remotePlayers.players.values()) rows.push({ name: p.name, color: p.color, hp: p.hp, kills: p.kills, dead: p.dead });
    html = `<div class="squad-head">SQUAD · ${escapeHtml(net.room)}${net.ping ? ` · ${net.ping} ms` : ""}</div>` + rows.map(r => `
      <div class="squad-row${r.me ? " me" : ""}${r.dead || r.hp <= 0 ? " down" : ""}">
        <span class="squad-dot" style="background:${r.color}"></span>
        <span class="squad-name">${escapeHtml(r.name)}${r.me ? " (you)" : ""}</span>
        <span class="squad-hp"><i style="width:${Math.round(r.hp)}%;background:${r.color}"></i></span>
        <span class="squad-kills">${r.kills}</span>
      </div>`).join("");
  }
  if (html !== squadHtml) {
    squadHtml = html;
    squadEl.innerHTML = html;
  }
}

// ─── Vehicles: auto-rickshaws and Thars ───────────────────────────────────────
// vehicles/Vehicle.js. V gets in and out of the nearest one, W/S are throttle
// and brake/reverse, A/D steer, Space is the handbrake, and T pours in a petrol
// can (next to it, or while driving). Whoever drives simulates it and streams
// the pose in their `st` packets (with its index); everyone else smooths toward it.
//
// Where they're parked: the same list for every player (the index is the
// vehicle's network id). The first is hand-placed by the spawn; the rest sit
// on a road's shoulder in the towns, on `side` of the road.
const VEHICLE_SPAWNS = [
  { kind: "rickshaw", x: -16, z: -15, yaw: Math.atan2(16, 15) },     // Crossroads, facing the middle of the map
  { kind: "thar", road: "Highway", near: [-34, -3], side: -1 },       // Crossroads
  { kind: "rickshaw", road: "North Road", near: [4, 142], side: 1 },  // Ravencross
  { kind: "thar", road: "North Road", near: [1, 110], side: -1 },
  { kind: "rickshaw", road: "Highway", near: [134, -26], side: 1 },   // Ashford
  { kind: "thar", road: "Highway", near: [168, -33], side: -1 },
  { kind: "rickshaw", road: "North Road", near: [20, -134], side: 1 }, // Mill Creek
  { kind: "thar", road: "Highway", near: [-134, 11], side: -1 },      // Pine Hollow
  { kind: "rickshaw", road: "Highway", near: [-104, 5], side: 1 },
];
const PARK_OFFSET = 4.4;         // m from the road's centreline: on the shoulder, inside the power-pole line (5.9 m)
const SEATED_HIP = 0.95;         // soldier hip height above the feet
const vehicles = [];             // index = VEHICLE_SPAWNS index
let headlight = null;            // the one shared beam (Vehicle.aimHeadlight)
const drive = { on: false, car: null, lastMouse: 0, emptyNotice: 0 };
const _seat = new THREE.Vector3();
const _exit = { x: 0, z: 0 };
const _runOver = new Map();      // monster / player id → last hit (ms)
const vehicleHudEl = document.getElementById("vehicle-hud");
const vehSpeedEl = document.getElementById("veh-speed");
const vehFuelEl = document.getElementById("veh-fuel-fill");
const vehFuelValEl = document.getElementById("veh-fuel-val");
const vehHud = { shown: null, speed: -1, fuel: -1 };

/** Resolves the road-relative spawns into { kind, x, z, yaw } (needs the roads). */
function vehicleSpawns(roads) {
  return VEHICLE_SPAWNS.map(s => {
    if (!s.road) return s;
    const road = roads.byName(s.road);
    const at = roads.pointAt(road, roads.arcNear(road, s.near[0], s.near[1]));
    // Right of the direction of travel is (tz, −tx)
    return { kind: s.kind, x: at.x + at.tz * PARK_OFFSET * s.side, z: at.z - at.tx * PARK_OFFSET * s.side, yaw: Math.atan2(at.tx, at.tz) };
  });
}

/** True if a circle at (x, z) overlaps anything solid on the obstacle list (or the map edge). self: a vehicle to ignore. */
function solidAt(x, z, r, self = null) {
  if (Math.hypot(x, z) > PLAY_RADIUS - r) return true;
  if (caves?.solidAt(x, z, r)) return true;
  for (const o of mapObstacles) {
    if (o.vehicle) continue;
    const dx = x - o.x, dz = z - o.z;
    if (o.type === "circle") {
      const rr = o.r + r;
      if (dx * dx + dz * dz < rr * rr) return true;
      continue;
    }
    if (Math.abs(dx) > o.w + o.d + r || Math.abs(dz) > o.w + o.d + r) continue;
    // Into the box's frame (it is turned by rot about y)
    const c = Math.cos(o.rot), s = Math.sin(o.rot);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const qx = Math.max(Math.abs(lx) - o.w / 2, 0), qz = Math.max(Math.abs(lz) - o.d / 2, 0);
    if (qx * qx + qz * qz < r * r) return true;
  }
  // Other vehicles: a circle each is plenty for bumping (only checked while driving one)
  if (self) {
    for (const v of vehicles) {
      if (v === self) continue;
      const rr = v.spec.width * 0.6 + r, dx = x - v.x, dz = z - v.z;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
  }
  return false;
}

/** The closest vehicle you could get into (or refuel), or null. */
function nearestVehicle() {
  const px = characterBody.position.x, pz = characterBody.position.z;
  let best = null, bestD = Infinity;
  for (const v of vehicles) {
    const d = v.distanceTo(px, pz);
    if (d < v.spec.enterRange && d < bestD) { best = v; bestD = d; }
  }
  return best;
}

function toggleVehicle() {
  if (drive.on) { exitVehicle(); return; }
  const car = nearestVehicle();
  if (!car || playerHealth <= 0 || brAirborne() || climb.active) return;
  if (car.driver !== null) { inventoryUI.feed("Someone is already driving it", "info"); return; }
  drive.on = true;
  drive.car = car;
  car.driver = "local";
  car.remote = null;
  characterBody.collisionResponse = false; // the vehicle's box carries you
  soldier.seated = true;
  setStance("stand", true);
  cancelThrow();
  weapon.reloading = false;
  moveVelocity.set(0, 0, 0);
  knockbackVel.set(0, 0, 0);
  drive.lastMouse = 0;
  sfx.equip();
  inventoryUI.feed(car.empty
    ? `Out of petrol: find a petrol can, then ${IS_TOUCH ? "tap it in the hotbar" : "press T"}`
    : IS_TOUCH ? "Joystick: drive & steer · BRAKE · tap Get out" : "W/S drive · A/D steer · Space brake · V get out",
    car.empty ? "info" : "fuel", "fuel");
}

function exitVehicle() {
  if (!drive.on) return;
  const car = drive.car;
  drive.on = false;
  drive.car = null;
  soldier.seated = false;
  car.driver = null;
  car.speed = 0;
  car.yawRate = 0;
  car.exitSpot(solidAt, _exit);
  characterBody.collisionResponse = true;
  characterBody.position.set(_exit.x, groundHeight(_exit.x, _exit.z) + FEET_OFFSET + 0.05, _exit.z);
  characterBody.velocity.set(0, 0, 0);
  bodyYaw = car.yaw;
}

function refuelVehicle() {
  if (playerHealth <= 0) return;
  const car = drive.car ?? nearestVehicle();
  if (!car) { inventoryUI.feed("Stand next to a rickshaw or a Thar to fill it up", "info", "fuel"); return; }
  if (car.fuel >= car.spec.fuelMax - 1) { inventoryUI.feed("The tank is already full", "info", "fuel"); return; }
  if (!inventory.takeFuelCan()) { inventoryUI.feed("No petrol cans: they lie around the map", "info", "fuel"); return; }
  car.fuel = Math.min(car.spec.fuelMax, car.fuel + car.spec.canFuel);
  sfx.refuel();
  inventoryUI.feed(`Petrol: ${Math.round(car.fuel)}%`, "fuel", "fuel");
  net.send({ t: "vfuel", f: +car.fuel.toFixed(1), i: car.index });
}

/** Replaces the on-foot controller while you drive. */
function updateDriving(delta) {
  const car = drive.car;
  let throttle = 0, steer = 0;
  if (!inventoryOpen && playerHealth > 0) {
    throttle = (keys.forward ? 1 : 0) - (keys.backward ? 1 : 0);
    steer = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
    if (touch) {
      throttle = THREE.MathUtils.clamp(throttle + touch.moveY, -1, 1);
      steer = THREE.MathUtils.clamp(steer - touch.moveX, -1, 1);
    }
  }
  const now = performance.now() / 1000;
  if (throttle !== 0 && car.empty && now > drive.emptyNotice) {
    drive.emptyNotice = now + 4;
    sfx.sputter();
    inventoryUI.feed(`Out of petrol! ${IS_TOUCH ? "Tap the petrol can in the hotbar" : "Press T with a petrol can"}`, "info", "fuel");
  }
  const crash = car.drive(delta, { throttle, steer, handbrake: keys.jump }, solidAt);
  progress.drive(Math.abs(car.speed) * delta);
  jumpQueued = false;
  if (crash > 3) {
    cameraTrauma = Math.min(1, cameraTrauma + Math.min(0.7, crash * 0.05));
    sfx.thud(null, false);
    if (crash > 10) dealDamageToPlayer((crash - 10) * 3, 0, 0, 0.5);
  }
  // The camera swings in behind you unless you're looking around with the mouse
  if (now - drive.lastMouse > 1.2 && Math.abs(car.speed) > 1.5) {
    aimYaw += angleDiff(car.yaw, aimYaw) * (1 - Math.exp(-2.2 * delta));
    aimPitch += (-0.16 - aimPitch) * (1 - Math.exp(-2 * delta));
  }
  vehicleRunOver(car);
}

/** Driving into monsters (or other players, in the battle royale) hurts them. */
function vehicleRunOver(car) {
  const v = Math.abs(car.speed);
  if (v < 4) return;
  const now = performance.now();
  const dir = Math.sign(car.speed);
  const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
  const nose = car.spec.length * 0.33;
  const cx = car.x + fx * nose * dir, cz = car.z + fz * nose * dir;
  const hit = car.spec.width * 0.9;
  for (const z of zombieManager?.active ?? []) {
    if (z.dying || z.def.flying) continue;
    const p = z.body.position;
    const reach = hit + (z.capRadius ?? 0.4);
    if ((p.x - cx) ** 2 + (p.z - cz) ** 2 > reach * reach) continue;
    if (now - (_runOver.get(z) ?? 0) < 600) continue;
    _runOver.set(z, now);
    z.killCause = "road";
    hitMonster(z, v * car.spec.runOver * 2.8 * (z.def.bigBody ? 0.5 : 1), fx * dir * v * 0.5, fz * dir * v * 0.5);
    _vecA.set(p.x, p.y + 0.6, p.z);
    effects.impact(_vecA, fx * dir, 0.4, fz * dir, "blood", 14);
    sfx.thud(p, false);
    car.speed *= z.def.bigBody ? 0.4 : 0.8;
  }
  if (!isBR()) return;
  for (const t of remotePlayers.targets()) {
    if (!t.alive) continue;
    if ((t.pos.x - cx) ** 2 + (t.pos.z - cz) ** 2 > (hit + 0.35) ** 2) continue;
    if (now - (_runOver.get(t.id) ?? 0) < 700) continue;
    _runOver.set(t.id, now);
    net.send({ t: "pvp", to: t.id, d: Math.round(v * car.spec.runOver), hs: 0, w: "rickshaw", sx: +car.x.toFixed(1), sz: +car.z.toFixed(1) });
    showHitMarker(false, false);
    sfx.thud(t.pos, false);
  }
}

/** After the physics step: you ride in the seat. */
function vehicleAfterStep() {
  if (!drive.on) return;
  drive.car.seatWorld(_seat);
  characterBody.position.set(_seat.x, _seat.y - SEATED_HIP + FEET_OFFSET, _seat.z);
  characterBody.velocity.set(0, 0, 0);
  bodyYaw = drive.car.yaw;
  characterRoot.rotation.y = bodyYaw;
}

/** Every vehicle's pose and lamps; the shared headlight goes to the closest one that's lit. */
function updateVehicles(delta) {
  let lit = null, litD = Infinity;
  for (const v of vehicles) {
    v.update(delta, env.darkness);
    if (v.lightLevel > 0) {
      const d = v.distanceTo(camera.position.x, camera.position.z);
      if (d < litD) { lit = v; litD = d; }
    }
  }
  if (!headlight) return;
  if (lit) lit.aimHeadlight(headlight);
  else headlight.intensity = 0;
}

const _engineAt = { x: 0, y: 0, z: 0 };
/** Engine sound (yours, or the nearest someone else drives), and the speed / petrol gauge while you drive. */
function updateVehicleFx() {
  let car = drive.car, near = Infinity;
  if (!car) {
    for (const v of vehicles) {
      if (v.driver === null || v.fuel <= 0) continue;
      const d = v.distanceTo(camera.position.x, camera.position.z);
      if (d < 90 && d < near) { car = v; near = d; }
    }
  }
  const vol = car && car.driver !== null && car.fuel > 0 ? 1 : 0;
  if (car) { _engineAt.x = car.x; _engineAt.y = groundHeight(car.x, car.z) + 0.8; _engineAt.z = car.z; }
  sfx.setRickshaw(vol, car ? Math.min(1, Math.abs(car.speed) / car.spec.maxSpeed * 0.8 + car.throttle * 0.25) : 0,
    drive.on ? null : _engineAt, car?.spec.tone ?? 1);

  const show = drive.on;
  if (show !== vehHud.shown) {
    vehHud.shown = show;
    vehicleHudEl?.classList.toggle("visible", show);
    const name = document.getElementById("veh-name");
    if (show && name) name.textContent = drive.car.spec.label.toUpperCase();
  }
  if (!show) return;
  const kmh = Math.round(Math.abs(drive.car.speed) * 3.6);
  if (kmh !== vehHud.speed) {
    vehHud.speed = kmh;
    if (vehSpeedEl) vehSpeedEl.textContent = `${kmh}`;
  }
  const fuel = Math.ceil(drive.car.fuel);
  if (fuel !== vehHud.fuel) {
    vehHud.fuel = fuel;
    if (vehFuelEl) vehFuelEl.style.transform = `scaleX(${fuel / drive.car.spec.fuelMax})`;
    if (vehFuelValEl) vehFuelValEl.textContent = `${fuel}%`;
    vehicleHudEl?.classList.toggle("low", fuel <= 15);
  }
}

// Someone else driving, carried in their state packet: veh = [x, z, yaw, speed, fuel, index]
net.on("st", msg => {
  if (!vehicles.length) return;
  const car = msg.veh ? vehicles[msg.veh[5] ?? 0] : null;
  if (car) {
    if (drive.car === car) {
      // Both jumped in at once: the lower id keeps it
      if (msg.from > net.id) return;
      exitVehicle();
      inventoryUI.feed(`${remotePlayers.players.get(msg.from)?.name ?? "Someone"} is driving`, "info");
    }
    car.setRemote(msg.from, msg.veh[0], msg.veh[1], msg.veh[2], msg.veh[3], msg.veh[4]);
  }
  // Out of the one they were driving (or switched)
  for (const v of vehicles) if (v !== car && v.driver === msg.from) v.releaseRemote();
});
net.on("vfuel", msg => {
  const car = vehicles[msg.i ?? 0];
  if (!car) return;
  // A teammate topping it up: you hear it from the vehicle
  if (msg.f > car.fuel + 1) sfx.refuel({ x: car.x, y: groundHeight(car.x, car.z) + 0.8, z: car.z });
  car.fuel = msg.f;
});

/** [[x, z, yaw, fuel], …] of every vehicle, for late joiners. */
function vehiclesState() {
  return vehicles.map(v => [+v.x.toFixed(2), +v.z.toFixed(2), +v.yaw.toFixed(3), +v.fuel.toFixed(1)]);
}

/** Parks every vehicle back where it started (a new battle royale round). */
function resetVehicles() {
  for (const v of vehicles) v.reset();
}

/**
 * Cave tunnels curve up from the floor, and the capsule's frictionless sphere
 * contacts would let you ride up them. Unless you jumped, nothing in a tunnel
 * lifts you off the floor (the hill outside stays climbable).
 */
let jumpGrace = 0;
function keepOnCaveFloor(delta) {
  jumpGrace = Math.max(0, jumpGrace - delta);
  if (!caves || drive.on || jumpGrace > 0 || brAirborne()) return;
  const p = characterBody.position;
  const feet = p.y - FEET_OFFSET;
  const up = feet - groundHeight(p.x, p.z);
  if (up < 0.1 || up > 3.5 || !caves.inside(p.x, p.z, feet)) return;
  p.y -= Math.min(up, Math.max(0.05, up * 0.6));
  if (characterBody.velocity.y > 0) characterBody.velocity.y = 0;
}

/** Keeps you on the map and never under the ground. */
function keepInBounds() {
  const p = characterBody.position;
  const r = Math.hypot(p.x, p.z);
  if (r > PLAY_RADIUS) {
    p.x *= PLAY_RADIUS / r;
    p.z *= PLAY_RADIUS / r;
  }
  if (drive.on || (isBR() && (br.ghost || br.flight === PHASE_PLANE))) return;
  const g = groundHeight(p.x, p.z);
  if (p.y < g + FEET_OFFSET - 0.6) {
    p.y = g + FEET_OFFSET;
    if (characterBody.velocity.y < 0) characterBody.velocity.y = 0;
  }
}

// ─── Battle royale ────────────────────────────────────────────────────────────
// One player in the room hosts the match: it runs warm-up → countdown → match
// → results and owns the match clock. The plane route, zone circles and loot
// all come from the match seed (br/BattleRoyale.js), so a single `brstart`
// message builds the same match everywhere. Each player owns their own health:
// shooters send `pvp` damage to the victim, and the victim announces `elim`.
const brHud = new BrHud();
const zoneWall = new ZoneWall(scene);
const dropPlane = createPlane();
scene.add(dropPlane);
const myChute = createParachute();
characterRoot.add(myChute);

// What the camera, minimap, shadows and ground chunks centre on (you, or the player you're watching)
const focusPos = new THREE.Vector3(characterBody.position.x, characterBody.position.y, characterBody.position.z);
const GHOST_PARK = { x: 0, y: 60, z: 0 }; // a spectator's own (hidden) body waits up here

const br = {
  state: "warm",         // warm → count → match → end
  seed: 0,
  t: 0,                  // match clock (s)
  countdown: 0,
  endTimer: 0,
  route: null,
  circles: null,
  zone: { x: 0, z: 0, r: 0, nx: 0, nz: 0, nr: 0, phase: 0, shrinking: false, timeLeft: 0, dps: 0, final: false },
  flight: PHASE_GROUND,  // your drop phase
  fallTime: 0,
  vy: 0,
  skydive: 0,
  inMatch: false,        // dropped in this match and still standing
  ghost: false,          // joined mid-match: watch until the next one
  started: 0,
  alive: new Set(),      // player ids still standing
  placement: 0,
  spectating: null,
  outside: false,
  outsideBy: 0,
  zoneTick: 1,
  respawnTimer: 0,
  atkId: null, atkW: "", atkHs: false, atkAt: -99, // who hurt you last (kill credit)
  netTimer: 0,
  hudTimer: 0,
};
const _planePos = { x: 0, y: 0, z: 0 };
const _spawn = { x: 0, z: 0 };
const _lootSpot = new THREE.Vector3();
const _specIds = [];
const ELIM_VERB = { zone: "ZONE", self: "SELF", grenade: "FRAG", molotov: "BURNED", rickshaw: "RUN OVER" };

function brAirborne() { return isBR() && (br.ghost || br.flight !== PHASE_GROUND); }
function brFlying() { return brAirborne(); }
/** Watching the match instead of playing it (eliminated, or joined late). */
function brWatching() { return isBR() && br.state === "match" && (br.ghost || playerHealth <= 0); }

function brWatchedPlayer() {
  if (!isBR() || br.spectating === null) return null;
  const p = remotePlayers.players.get(br.spectating);
  return p?.hasState ? p : null;
}

function updateFocus(watched) {
  if (watched) focusPos.copy(watched.root.position);
  else focusPos.set(characterBody.position.x, characterBody.position.y, characterBody.position.z);
}

function brName(id) {
  if (id === net.id) return myName;
  return remotePlayers.players.get(id)?.name ?? net.players.get(id)?.name ?? "Player";
}
function brColor(id) { return net.players.get(id)?.color ?? "#e2a42b"; }

function brPickSpectate(dir) {
  _specIds.length = 0;
  for (const id of br.alive) if (id !== net.id && remotePlayers.players.get(id)?.hasState) _specIds.push(id);
  if (!_specIds.length) { br.spectating = null; return; }
  const n = _specIds.length, i = _specIds.indexOf(br.spectating);
  br.spectating = _specIds[(((i + dir) % n) + n) % n];
}

function brNoteAttacker(id, w, hs) {
  if (!isBR()) return;
  br.atkId = id; br.atkW = w; br.atkHs = hs; br.atkAt = clock.elapsedTime;
}

/** The sky is always a clear midday now, so there's no host clock or weather to follow. */
function applyWorldClock() {}

function enterBattleRoyale(welcome) {
  gameMode = "br";
  document.body.classList.add("mode-br");
  localTarget.id = net.id;
  remotePlayers.pvp = true;
  for (const p of welcome.players) if (p.id !== net.id) remotePlayers.add(p);
  zombieManager.clearAll();
  enemyFire.clear();
  brHud.setVisible(true);
  brEnterWarmup();
  inventoryUI.feed(net.isHost
    ? `You're the host. ${IS_TOUCH ? "Tap START MATCH" : "Press ENTER"} to start (alone is a practice drop)`
    : `Joined "${welcome.room.slice(3)}" · waiting for the host to start`, "info");
}

function brWarmSpawn() {
  const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 10;
  _spawn.x = Math.cos(a) * r;
  _spawn.z = Math.sin(a) * r;
}

/** Full health, fresh pockets (empty for the drop, a warm-up kit otherwise), at (x, y, z). */
function brResetPlayer(x, y, z, empty) {
  cancelClimb();
  exitVehicle();
  playerHealth = MAX_HEALTH;
  healthTrail = MAX_HEALTH;
  timeSinceHit = 99;
  damageFlash = 0;
  knockbackVel.set(0, 0, 0);
  characterBody.position.set(x, y, z);
  characterBody.velocity.set(0, 0, 0);
  moveVelocity.set(0, 0, 0);
  camPivot.set(x, y - FEET_OFFSET + cameraRig.pivotHeight, z);
  inventory.reset(empty);
  if (!empty) inventory.addThrowable("smoke", SMOKE.warmupKit); // try it out before the drop
  onWeaponChanged(false);
  cancelThrow();
  soldier.revive();
  setStance("stand", true);
  characterRoot.visible = true;
  br.atkAt = -99;
  br.vy = 0;
}

function brEnterWarmup() {
  br.state = "warm";
  br.t = 0; br.countdown = 0; br.endTimer = 0;
  br.inMatch = false; br.ghost = false; br.started = 0;
  br.alive.clear();
  br.route = null; br.circles = null;
  br.spectating = null; br.respawnTimer = 0; br.outside = false;
  br.flight = PHASE_GROUND;
  myChute.visible = false;
  zoneWall.hide();
  dropPlane.visible = false;
  throwables.clear();
  fireFX.clear();
  pickups.clear();
  takenLoot.clear(); // the next match's loot reuses the ids
  lootClaims.clear();
  brHud.hideResult();
  setMapOpen(false);
  brWarmSpawn();
  brResetPlayer(_spawn.x, groundHeight(_spawn.x, _spawn.z) + FEET_OFFSET + 0.02, _spawn.z, false);
  resetVehicles();
  killsThisLife = 0;
  progress.resetRun();
}

function brHostStart() {
  if (!net.isHost || (br.state !== "warm" && br.state !== "count")) return;
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const ids = [net.id, ...remotePlayers.players.keys()];
  net.send({ t: "brstart", seed, ids });
  brStartMatch(seed, ids, 0);
}

/** Everyone builds the match from the seed. ids: who's dropping; t: match time (late joiners). */
function brStartMatch(seed, ids, t) {
  br.state = "match";
  br.seed = seed;
  br.t = t;
  br.route = planeRoute(seed);
  br.circles = zoneCircles(seed);
  zoneAt(br.circles, t, br.zone);
  br.alive.clear();
  for (const id of ids) br.alive.add(id);
  br.started = ids.length;
  br.inMatch = br.alive.has(net.id);
  br.ghost = !br.inMatch;
  br.spectating = null; br.placement = 0; br.zoneTick = 1; br.netTimer = 0; br.outside = false;
  killsThisLife = 0;
  progress.resetRun();
  throwables.clear();
  fireFX.clear();
  pickups.clear();
  takenLoot.clear(); // the next match's loot reuses the ids
  lootClaims.clear();
  brSpawnLoot(seed);
  resetVehicles();
  brHud.hideResult();

  planeAt(br.route, t, _planePos);
  brResetPlayer(_planePos.x, _planePos.y - 2.5, _planePos.z, true);
  br.flight = br.inMatch ? PHASE_PLANE : PHASE_GROUND;
  myChute.visible = false;
  characterRoot.visible = false;
  // Look along the route, a little down, so you can pick your spot
  aimYaw = Math.atan2(br.route.dx, br.route.dz);
  aimPitch = -0.35;
  if (br.inMatch) {
    setMapOpen(true);
    gameHud.showBanner({ title: "DROP ZONE", sub: "Pick your spot", text: `${IS_TOUCH ? "JUMP" : "SPACE"} jumps. Land, loot, and stay inside the blue zone.`, color: "#4da3ff", duration: 5 });
    sfx.levelStart();
  } else {
    gameHud.showBanner({ title: "MATCH IN PROGRESS", sub: "You're spectating until the next one", color: "#4da3ff", duration: 4 });
  }
}

function brSpawnLoot(seed) {
  const spots = [];
  for (const h of houses.houses) {
    for (const s of houses.lootSpots(h)) {
      houses.lootSpot(h, s, _lootSpot);
      spots.push({ x: _lootSpot.x, y: _lootSpot.y, z: _lootSpot.z });
    }
  }
  for (const sp of caves?.lootSpots ?? []) spots.push({ x: sp.x, y: sp.y, z: sp.z });
  for (const sp of indiaBuildings?.lootSpots ?? []) spots.push({ x: sp.x, y: sp.y, z: sp.z });
  lootPlan(seed, spots, isOpenGround).forEach((it, i) => {
    pickups.spawn(it.kind, it.x, it.z, pickupData(it.kind), Infinity, `w${i}`, it.y ?? null);
  });
}

/** A pickup every player sees, and that disappears for everyone when taken. */
/** A pickup every player sees, and that disappears for everyone when taken. */
function spawnShared(k, x, z, data, y = groundHeight(x, z)) {
  const id = `${net.id}.${dropSeq++}`;
  const entry = pickups.spawn(k, x, z, data, Infinity, id, y);
  net.send({ t: "drop", k, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), i: id, ...packLoot(data) });
  return entry;
}
let dropSeq = 0;

/**
 * Pickup data on the wire. a: [ammo, reserve] of a gun (null reserve = ∞),
 * m: its attachments [optic, muzzle, mag, grip], c: stack count, d: armor durability.
 */
function packLoot(data) {
  if (!data) return {};
  const out = {};
  if (data.ammo !== undefined) out.a = [data.ammo, data.reserve === Infinity ? null : data.reserve];
  if (data.att && Object.values(data.att).some(Boolean)) out.m = [data.att.optic, data.att.muzzle, data.att.mag, data.att.grip];
  if (data.count) out.c = data.count;
  if (data.dur !== undefined && data.dur !== null) out.d = Math.round(data.dur);
  return out;
}
function unpackLoot(msg) {
  if (msg.a) {
    const m = msg.m ?? [];
    return { ammo: msg.a[0], reserve: msg.a[1] ?? Infinity, att: { optic: m[0] ?? null, muzzle: m[1] ?? null, mag: m[2] ?? null, grip: m[3] ?? null } };
  }
  if (msg.c) return { count: msg.c };
  if (msg.d !== undefined) return { dur: msg.d };
  return pickupData(msg.k);
}

/** Your loot spills out around your body for whoever gets there first. */
function brDropLoot() {
  const p = characterBody.position;
  const items = [];
  for (const id of inventory.ownedWeapons) {
    const s = inventory.weapons[id];
    items.push([id, { ammo: s.ammo, reserve: s.reserve, att: { ...s.att } }]);
  }
  for (const k of THROWABLE_ORDER) if (inventory.throwables[k] > 0) items.push([k, { count: inventory.throwables[k] }]);
  if (inventory.medkits) items.push(["medkit", { count: inventory.medkits }]);
  if (inventory.biscuits) items.push(["biscuit", { count: inventory.biscuits }]);
  if (inventory.cash) items.push(["cash", { count: inventory.cash }]);
  if (inventory.fuelCans) items.push(["fuel", { count: inventory.fuelCans }]);
  for (const [k, n] of Object.entries(inventory.bag)) if (n > 0) items.push([k, { count: n }]);
  for (const piece of Object.values(inventory.gear)) if (piece) items.push([piece.id, { dur: piece.dur }]);
  if (items.length) items.push(["ammo", null]);
  items.forEach(([k, data], i) => {
    const a = (i / items.length) * Math.PI * 2;
    const x = p.x + Math.cos(a) * 1.5, z = p.z + Math.sin(a) * 1.5;
    spawnShared(k, x, z, data, floorY(x, z, p.y - FEET_OFFSET));
  });
  inventory.reset(true);
  onWeaponChanged(false);
}

// ── The drop ─────────────────────────────────────────────────────────────────
function brJump() {
  planeAt(br.route, br.t, _planePos);
  br.flight = PHASE_FALL;
  br.fallTime = 0;
  br.vy = -3;
  // Out of the back ramp
  characterBody.position.set(_planePos.x - br.route.dx * 8, _planePos.y - 4, _planePos.z - br.route.dz * 8);
  characterBody.velocity.set(0, 0, 0);
  moveVelocity.set(br.route.dx * PLANE.speed * 0.3, 0, br.route.dz * PLANE.speed * 0.3);
  bodyYaw = aimYaw;
  characterRoot.visible = true;
  setMapOpen(false);
  sfx.throwWhoosh();
}

/** Nobody rides past the far edge of the zone: the route runs a little beyond it. */
function brMustEject() {
  if (br.t >= br.route.duration - 0.2) return true;
  if (br.t < br.route.duration / 2) return false;
  planeAt(br.route, br.t, _planePos);
  return Math.hypot(_planePos.x, _planePos.z) > PLANE.ejectRadius;
}

function brOpenChute() {
  br.flight = PHASE_CHUTE;
  myChute.visible = true;
  sfx.chuteOpen();
}

function brLand() {
  br.flight = PHASE_GROUND;
  br.vy = 0;
  myChute.visible = false;
  moveVelocity.x *= 0.3;
  moveVelocity.z *= 0.3;
  characterBody.velocity.y = 0;
  if (br.state === "match" && !inventory.current) inventoryUI.feed("Landed. Find a weapon!", "info");
}

/** Replaces the ground controller while in the plane, falling or under the chute. */
function brUpdateFlight(delta) {
  if (br.ghost || br.flight === PHASE_PLANE) {
    characterBody.velocity.set(0, 0, 0);
    if (!br.ghost && ((jumpQueued && br.t > PLANE.jumpDelay) || brMustEject())) brJump();
    jumpQueued = false;
    return;
  }
  let ix = 0, iz = 0;
  if (!inventoryOpen) {
    if (keys.forward)  iz += 1;
    if (keys.backward) iz -= 1;
    if (keys.right)    ix += 1;
    if (keys.left)     ix -= 1;
    if (touch) { ix += touch.moveX; iz += touch.moveY; }
  }
  let fwd, side, down, rate, fallRate;
  if (br.flight === PHASE_FALL) {
    br.fallTime += delta;
    fwd = iz > 0 ? FREEFALL.forward : iz < 0 ? -FREEFALL.back : FREEFALL.drift;
    side = ix * FREEFALL.side;
    down = iz > 0 ? FREEFALL.dive : FREEFALL.fall;
    rate = FREEFALL.steer;
    fallRate = 2.5;
    const height = characterBody.position.y - FEET_OFFSET - surfaceHeight(characterBody.position.x, characterBody.position.z);
    if (height < FREEFALL.chuteHeight || (jumpQueued && br.fallTime > FREEFALL.manualAfter)) brOpenChute();
  } else {
    fwd = iz * CHUTE.speed;
    side = ix * CHUTE.speed * 0.8;
    down = CHUTE.fall;
    rate = CHUTE.steer;
    fallRate = 4;
  }
  jumpQueued = false;

  // Camera-relative: forward = (sin yaw, cos yaw), right = (−cos yaw, sin yaw)
  const sy = Math.sin(aimYaw), cy = Math.cos(aimYaw);
  const k = 1 - Math.exp(-rate * delta);
  moveVelocity.x += ((fwd * sy - side * cy) - moveVelocity.x) * k;
  moveVelocity.z += ((fwd * cy + side * sy) - moveVelocity.z) * k;
  br.vy += (-down - br.vy) * (1 - Math.exp(-fallRate * delta));
  // The world step adds gravity on top; cancel it so the fall speed is what we chose
  characterBody.velocity.set(moveVelocity.x, br.vy - world.gravity.y * delta, moveVelocity.z);

  bodyYaw += angleDiff(aimYaw, bodyYaw) * (1 - Math.exp(-6 * delta));
  characterRoot.rotation.y = bodyYaw;
}

function brAfterStep(delta) {
  if (br.ghost) {
    characterBody.position.set(GHOST_PARK.x, GHOST_PARK.y, GHOST_PARK.z);
    characterBody.velocity.set(0, 0, 0);
  } else if (br.flight === PHASE_PLANE) {
    planeAt(br.route, br.t, _planePos);
    characterBody.position.set(_planePos.x, _planePos.y - 2.5, _planePos.z);
    characterBody.velocity.set(0, 0, 0);
  } else if ((br.flight === PHASE_FALL || br.flight === PHASE_CHUTE)
      && (onGround || characterBody.position.y < groundHeight(characterBody.position.x, characterBody.position.z) + FEET_OFFSET + 0.05)) {
    brLand();
  }
  br.skydive += ((br.flight === PHASE_FALL ? 1 : 0) - br.skydive) * (1 - Math.exp(-6 * delta));
  setSkydivePose(soldier.root, br.skydive);
  if (br.ghost || br.flight === PHASE_PLANE) characterRoot.visible = false;
}

function brUpdatePlane(delta) {
  const r = br.route;
  const show = br.t < r.duration + 5;
  dropPlane.visible = show;
  if (!show) return;
  const s = br.t * PLANE.speed; // keeps flying past the end of the route
  updatePlane(dropPlane, r.ax + r.dx * s, PLANE.altitude, r.az + r.dz * s, r.dx, r.dz, delta);
}

function brZoneDamage(delta) {
  if (!br.inMatch || playerHealth <= 0 || br.flight === PHASE_PLANE) { br.outside = false; return; }
  const z = br.zone;
  const d = Math.hypot(characterBody.position.x - z.x, characterBody.position.z - z.z);
  br.outside = d > z.r;
  br.outsideBy = d - z.r;
  if (!br.outside) { br.zoneTick = 0.6; return; }
  br.zoneTick -= delta;
  if (br.zoneTick <= 0) {
    br.zoneTick = 1;
    dealDamageToPlayer(z.dps, 0, 0, 0.12);
  }
}

// ── Eliminations & results ───────────────────────────────────────────────────
function brOnLocalDeath() {
  const recent = br.atkId !== null && clock.elapsedTime - br.atkAt < 10;
  const msg = {
    t: "elim", v: net.id,
    k: recent ? br.atkId : null,
    w: recent ? br.atkW : br.outside ? "zone" : "self",
    hs: recent && br.atkHs ? 1 : 0,
  };
  if (br.state === "match" && br.inMatch) {
    br.placement = br.alive.size;
    brDropLoot();
    releaseLock();
  } else {
    br.respawnTimer = BR_WARMUP_RESPAWN; // warm-up: straight back in
  }
  net.send(msg);
  brHandleElim(msg);
}

function brHandleElim({ v, k, w, hs }) {
  const vName = brName(v);
  const kName = k !== null && k !== undefined ? brName(k) : null;
  const verb = hs ? "HEADSHOT" : ELIM_VERB[w] ?? WEAPONS[w]?.short ?? "KILLED";
  gameHud.killFeed(kName ? `${kName} ▸ ${vName}` : vName, verb, brColor(kName ? k : v), !!hs);
  if (k === net.id && v !== net.id) {
    killsThisLife++;
    progress.pvpKill(!!hs);
    onLocalKill(!!hs);
    showHitMarker(!!hs, true);
    sfx.kill();
  }
  if (br.state !== "match" || !br.alive.has(v)) return;
  br.alive.delete(v);
  if (v === net.id) {
    br.inMatch = false;
    postFx.kick(0.4, 0xff2a1a);
    const place = br.placement || br.alive.size + 1;
    progress.brFinished(place, br.started);
    brHud.showResult({
      title: "ELIMINATED",
      sub: kName ? `by ${kName}` : w === "zone" ? "Caught outside the zone" : "",
      lines: [["PLACE", `#${place}`], ["KILLS", `${killsThisLife}`], ["PLAYERS", `${br.started}`], ["XP", `+${progress.runXp}`]],
      foot: br.alive.size ? "Spectating in a moment…" : "",
      color: "#ff4b3a",
      duration: 4.5,
    });
  }
  if (br.spectating === v) br.spectating = null;
  brCheckWinner();
}

/** Host: one player left (or nobody, in a practice drop) ends the match. */
function brCheckWinner() {
  if (!net.isHost || br.state !== "match") return;
  const n = br.alive.size;
  if (n === 0 || (br.started >= 2 && n === 1)) {
    const w = n === 1 ? br.alive.values().next().value : null;
    net.send({ t: "brend", w });
    brShowEnd(w);
  }
}

function brShowEnd(w) {
  br.state = "end";
  br.endTimer = BR_END_HOLD;
  br.inMatch = false;
  br.outside = false;
  zoneWall.hide();
  dropPlane.visible = false;
  if (w === net.id) progress.brFinished(1, br.started);
  const lines = [["KILLS", `${killsThisLife}`], ["PLAYERS", `${br.started}`], ["XP", `+${progress.runXp}`]];
  if (w === net.id) {
    brHud.showResult({ title: "WINNER", sub: "Last one standing", lines: [["PLACE", "#1"], ...lines], color: "#ffd84d" });
    postFx.kick(0.6, 0xffd27a);
    sfx.levelCleared();
    confetti.celebrate("victory");
  } else {
    brHud.showResult({
      title: w !== null ? "MATCH OVER" : "NO SURVIVORS",
      sub: w !== null ? `${brName(w)} is the last one standing` : "The zone took everyone",
      lines,
      color: "#6ab4ff",
    });
  }
}

function brOnPlayerLeft(id) {
  if (br.spectating === id) br.spectating = null;
  if (br.state === "match" && br.alive.delete(id)) brCheckWinner();
  if (net.isHost && br.state === "count" && remotePlayers.count === 0) br.state = "warm";
}

// ── Per frame ────────────────────────────────────────────────────────────────
function brUpdate(delta) {
  if (net.isHost) {
    // Someone else is here: count down to the drop
    if (br.state === "warm" && remotePlayers.count > 0) { br.state = "count"; br.countdown = BR_AUTO_START; br.netTimer = 0; }
    else if (br.state === "count" && remotePlayers.count === 0) { br.state = "warm"; br.netTimer = 0; }
  }
  if (br.state === "count") {
    br.countdown = Math.max(0, br.countdown - delta);
    if (net.isHost && br.countdown <= 0) brHostStart();
  }
  if (br.state === "match") {
    br.t += delta;
    zoneAt(br.circles, br.t, br.zone);
    zoneWall.set(br.zone.x, br.zone.z, br.zone.r, br.t);
    brUpdatePlane(delta);
    brZoneDamage(delta);
    // Out of the fight: follow somebody who's still in it
    if (brWatching() && !brHud.resultShown && (br.spectating === null || !br.alive.has(br.spectating))) brPickSpectate(1);
  }
  if (br.state === "end") {
    br.endTimer = Math.max(0, br.endTimer - delta);
    brHud.setResultFoot(`Next match in ${Math.ceil(br.endTimer)}`);
    if (net.isHost && br.endTimer <= 0) {
      net.send({ t: "brwarm" });
      brEnterWarmup();
    }
  }
  // Warm-up deaths don't count
  if ((br.state === "warm" || br.state === "count") && playerHealth <= 0) {
    br.respawnTimer -= delta;
    if (br.respawnTimer <= 0) {
      brWarmSpawn();
      brResetPlayer(_spawn.x, groundHeight(_spawn.x, _spawn.z) + FEET_OFFSET + 0.02, _spawn.z, false);
    }
  }
  const engine = dropPlane.visible ? THREE.MathUtils.clamp(1 - camera.position.distanceTo(dropPlane.position) / 320, 0, 1) : 0;
  sfx.setFlight(engine, br.flight === PHASE_FALL ? 1 : br.flight === PHASE_CHUTE ? 0.25 : 0);
}

/** Host: match state for everyone (and late joiners) twice a second. */
function brNetTick(delta) {
  br.netTimer -= delta;
  if (br.netTimer > 0 || remotePlayers.count === 0) return;
  br.netTimer = 0.5;
  net.send({
    t: "br", s: br.state, seed: br.seed, tm: +br.t.toFixed(2), cd: +br.countdown.toFixed(1),
    et: +br.endTimer.toFixed(1), al: [...br.alive], hr: +env.hour.toFixed(3), wx: weather.state,
  });
}

function brHint() {
  if (br.state !== "match" || !br.inMatch) return "";
  if (IS_TOUCH) {
    if (br.flight === PHASE_PLANE) return br.t < PLANE.jumpDelay ? "GET READY…" : "<kbd>JUMP</kbd> LEAVE THE PLANE";
    if (br.flight === PHASE_FALL) return br.fallTime > FREEFALL.manualAfter ? "<kbd>CHUTE</kbd> OPEN PARACHUTE · PUSH UP TO DIVE" : "PUSH THE JOYSTICK UP TO DIVE";
    if (br.flight === PHASE_CHUTE) return "JOYSTICK: STEER";
  }
  if (br.flight === PHASE_PLANE) return br.t < PLANE.jumpDelay ? "GET READY…" : "<kbd>SPACE</kbd> JUMP · <kbd>M</kbd> MAP";
  if (br.flight === PHASE_FALL) return br.fallTime > FREEFALL.manualAfter ? "<kbd>SPACE</kbd> OPEN PARACHUTE · <kbd>W</kbd> DIVE" : "<kbd>W</kbd> DIVE";
  if (br.flight === PHASE_CHUTE) return "<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> STEER";
  if (!inventory.current) return "FIND A WEAPON";
  return "";
}

const _mapNext = { x: 0, z: 0, r: 0 };
const _mapPlane = { x: 0, z: 0, dx: 0, dz: 0 };
const _mapState = { zone: null, next: null, route: null, plane: null };

function brUpdateHud(delta) {
  brHud.update(delta);
  const watched = brWatchedPlayer();
  br.hudTimer -= delta;
  if (br.hudTimer <= 0) {
    br.hudTimer = 0.1;
    const players = remotePlayers.count + 1;
    let status = "", kind = "", alive = null;
    if (br.state === "warm") {
      status = `${players}/${BR_MAX_PLAYERS} players · ${net.isHost ? (IS_TOUCH ? "tap START MATCH" : "press ENTER to start") : "waiting for the host"}`;
    } else if (br.state === "count") {
      status = `Match starts in ${Math.ceil(br.countdown)}${net.isHost ? (IS_TOUCH ? " · START MATCH: go now" : " · ENTER: start now") : ""}`;
      kind = "warn";
    } else if (br.state === "match") {
      alive = br.alive.size;
      const z = br.zone;
      if (z.final) { status = "Final zone"; kind = "danger"; }
      else if (z.shrinking) { status = `Zone shrinking · ${fmtClock(z.timeLeft)}`; kind = "danger"; }
      else { status = `Zone shrinks in ${fmtClock(z.timeLeft)}`; kind = "warn"; }
    } else {
      status = "Match over";
    }
    brHud.setTop(alive, killsThisLife, status, kind);
    const outside = br.state === "match" && br.outside && playerHealth > 0;
    brHud.setOutside(outside, outside ? `OUTSIDE THE ZONE · ${Math.ceil(br.outsideBy)} m · −${br.zone.dps} HP/s` : "");
    brHud.setHint(brHint());
    brHud.setSpectating(watched ? watched.name : null, watched?.color);
  }

  if (!worldMap.open) return;
  const inMatch = br.state === "match";
  _mapState.zone = inMatch ? br.zone : null;
  if (inMatch) {
    _mapNext.x = br.zone.nx; _mapNext.z = br.zone.nz; _mapNext.r = br.zone.nr;
  }
  _mapState.next = inMatch ? _mapNext : null;
  const planeUp = inMatch && br.t < br.route.duration;
  _mapState.route = planeUp ? br.route : null;
  if (planeUp) {
    planeAt(br.route, br.t, _planePos);
    _mapPlane.x = _planePos.x; _mapPlane.z = _planePos.z;
    _mapPlane.dx = br.route.dx; _mapPlane.dz = br.route.dz;
  }
  _mapState.plane = planeUp ? _mapPlane : null;
}

net.on("br", msg => {
  if (!isBR() || net.isHost) return;
  applyWorldClock(msg.hr, msg.wx);
  if (msg.s === "match") {
    // Missed the start (or joined late): build the match from the seed
    if (br.state !== "match" || br.seed !== msg.seed) brStartMatch(msg.seed, msg.al, msg.tm);
    else if (Math.abs(br.t - msg.tm) > 0.4) br.t = msg.tm;
  } else if (msg.s === "end") {
    if (br.state === "match") { br.state = "end"; br.inMatch = false; }
    br.endTimer = msg.et;
  } else {
    if (br.state === "match" || br.state === "end") brEnterWarmup();
    br.state = msg.s;
    br.countdown = msg.cd;
  }
});
net.on("brstart", msg => { if (isBR()) brStartMatch(msg.seed, msg.ids, 0); });
net.on("brend", msg => { if (isBR()) brShowEnd(msg.w ?? null); });
net.on("brwarm", () => { if (isBR()) brEnterWarmup(); });
net.on("elim", msg => { if (isBR()) brHandleElim(msg); });
// Someone shot you: you apply it (you own your health) and remember who for the kill credit
net.on("pvp", msg => {
  if (!isBR() || playerHealth <= 0 || br.ghost || br.flight === PHASE_PLANE) return;
  brNoteAttacker(msg.from, msg.w, !!msg.hs);
  dealDamageToPlayer(msg.d, 0, 0, msg.hs ? 0.5 : 0.25, msg.sx, msg.sz, msg.w === "rickshaw" ? "raw" : msg.hs ? "head" : "body");
});


// ─── Lobby ────────────────────────────────────────────────────────────────────
const lobby = new Lobby({
  onSolo(name) {
    myName = name;
    gameMode = "solo";
    lobby.hide();
  },
  async onCoop(name, room) {
    myName = name;
    const welcome = await net.connect(Net.defaultUrl(), name, room);
    gameMode = "coop";
    onConnected(welcome);
    lobby.hide();
  },
  async onBattleRoyale(name, room) {
    myName = name;
    // Battle royale rooms live apart from the co-op ones with the same code
    const welcome = await net.connect(Net.defaultUrl(), name, `br-${room}`.slice(0, 24));
    enterBattleRoyale(welcome);
    lobby.hide();
  },
});

// Graphics quality: applied at startup, so a change reloads the page
const qualityEl = document.getElementById("lobby-quality");
if (qualityEl) {
  qualityEl.value = QUALITY_SETTING;
  qualityEl.options[0].textContent = `Auto (${QUALITY_PRESETS[QUALITY_NAME].label} on this ${IS_TOUCH ? "device" : "PC"})`;
  if (IS_TOUCH) {
    qualityEl.options[1].textContent = "Battery saver: older phones, cooler, longer battery";
    qualityEl.options[2].textContent = "Balanced (recommended)";
    qualityEl.options[3].textContent = "High: flagship phones";
  }
  qualityEl.addEventListener("change", () => {
    saveQuality(qualityEl.value);
    location.reload();
  });
}

// ─── Main Loop ────────────────────────────────────────────────────────────────
let shadowFrame = 0;

/** Mountains + sky with a far camera, then the game scene on a fresh depth buffer. */
function renderFrame() {
  backdrop.update(camera, { fogColor: scene.fog.color, lightDir: env.lightDir, sun, hemi: hemiLight, darkness: env.darkness });
  postFx.begin();
  renderer.clear();
  backdrop.render(renderer);
  renderer.clearDepth();
  renderer.render(scene, camera);
  postFx.end();
}

let _animRunning = false;
let prevFeetY = 0;
let lastFrameAt = 0;

// ─── Phone frame cap ──────────────────────────────────────────────────────────
// "auto" aims for 60. If a phone can't hold it even at its lowest render
// scale, it settles on a steady 30 (an even 33 ms beats a frame rate that
// jumps between 35 and 60), and every so often tries 60 again, waiting longer
// after each failed try so it doesn't flip-flop.
const autoFps = { cap: 60, slowFor: 0, probeAt: 0, probing: false, wait: 30 };

/** Frames per second the game is held to (desktop: 0 = no cap). */
function frameCap() {
  if (!touch) return 60;
  const s = touch.settings.fps;
  return s === "30" ? 30 : s === "60" ? 60 : autoFps.cap;
}

function updateAutoFps(frameMs) {
  if (!touch || touch.settings.fps !== "auto" || !isLocked()) return;
  const now = performance.now() / 1000;
  if (autoFps.cap === 60) {
    // Slow (under ~42 FPS) with the resolution already as low as it goes
    const stuck = perf.avg > 24 && perf.ratio <= MIN_PIXEL_RATIO + 0.01;
    autoFps.slowFor = stuck ? autoFps.slowFor + frameMs / 1000 : 0;
    if (autoFps.slowFor > (autoFps.probing ? 4 : 6)) {
      autoFps.cap = 30;
      autoFps.slowFor = 0;
      if (autoFps.probing) autoFps.wait = Math.min(240, autoFps.wait * 2); // a failed try: wait longer
      autoFps.probing = false;
      autoFps.probeAt = now + autoFps.wait;
    } else if (autoFps.probing && now > autoFps.probeAt + 8) {
      autoFps.probing = false;   // held 60 through the try: stay
      autoFps.wait = 30;
    }
  } else if (now > autoFps.probeAt) {
    autoFps.cap = 60;
    autoFps.probing = true;
    autoFps.probeAt = now;
    perf.avg = 16.7;             // judge the try on fresh frames
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
// Backgrounded (Android app or browser tab): pause and silence everything;
// coming back shows the pause screen and a tap resumes. requestAnimationFrame
// already stops while hidden, and the frame delta is clamped on return.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (isLocked() && !bench.on) releaseLock();
    sfx.ctx?.suspend?.();
  } else if (sfx.ctx?.state === "suspended" && !hud.paused) {
    sfx.ctx.resume();
  }
});

// WebGL context lost (Android can drop it under memory pressure): say so and
// reload cleanly when it comes back, instead of a frozen black screen.
canvas.addEventListener("webglcontextlost", e => {
  e.preventDefault();
  _animRunning = false;
  const note = document.createElement("div");
  note.id = "context-lost";
  note.textContent = "Graphics were reset by the device. Reloading…";
  Object.assign(note.style, {
    position: "fixed", inset: 0, zIndex: 6000, display: "flex", alignItems: "center", justifyContent: "center",
    background: "#050303", color: "#e8dccb", font: "600 20px 'Segoe UI', sans-serif",
  });
  document.body.append(note);
  setTimeout(() => location.reload(), 2500);
});
canvas.addEventListener("webglcontextrestored", () => location.reload());
const clock = new THREE.Clock();

function animate() {
  if (!_animRunning) return;
  requestAnimationFrame(animate);
  const frameStart = performance.now();
  if (touch) {
    // Phones: at most 60 (or 30) frames a second. A 90/120 Hz screen would
    // otherwise get twice the work, heat the phone and throttle it.
    const minGap = 1000 / frameCap() - 2;
    if (frameStart - lastFrameAt < minGap) return;
    lastFrameAt = frameStart;
  }
  perfOverlay?.beginFrame(frameStart);
  // Count every pass of the frame (backdrop, scene, post), not just the last one
  if (perfOverlay) { renderer.info.autoReset = false; renderer.info.reset(); }
  if (bench.on) benchStep(frameStart);
  const rawDelta = clock.getDelta();
  const frameMs = rawDelta * 1000;
  const realDelta = Math.min(rawDelta, 0.05);
  updateWeaponWheel(realDelta);
  updatePostFx(realDelta);
  // Everything in the world runs on scaled time (slow motion while choosing a
  // weapon under threat); the camera and HUD stay on real time
  const delta = gamePaused() ? 0 : realDelta * timeScale;

  updateTouch();
  if (drive.on) {
    updateDriving(delta);
  } else if (brFlying()) {
    brUpdateFlight(delta);
  } else if (climb.active) {
    updateClimb(delta);
  } else {
    updateCharacterMovement(delta);
    applyGroundStickForce(delta);
  }
  // Pose + collider before the step, so it pushes whatever it drives into
  updateVehicles(delta);

  // At most two catch-up steps: a slow frame must not make the next one slower too
  world.step(1 / 60, delta, 2);

  checkGrounded();
  if (climb.active) climbAfterStep();
  else snapCharacterToGround();
  if (isBR()) brAfterStep(delta);
  vehicleAfterStep();
  keepInBounds();
  keepOnCaveFloor(delta);

  // The physics contact settles the body a centimetre or two up and down on
  // alternate frames: averaging two frames cancels that in the visible
  // character without lagging behind slopes (jumps and stairs pass through)
  const feetY = characterBody.position.y - FEET_OFFSET;
  const smoothY = Math.abs(feetY - prevFeetY) < 0.04 ? (feetY + prevFeetY) / 2 : feetY;
  prevFeetY = feetY;
  characterRoot.position.set(characterBody.position.x, smoothY, characterBody.position.z);

  houses?.update(delta, characterBody.position.x, characterBody.position.z);
  collegeGate?.update(delta);
  houses?.cull(camera);
  if (isBR()) {
    brUpdate(delta);
  } else if (net.isClient) {
    // Co-op client: mirror the host's monsters instead of simulating them
    monsterSync?.updatePuppets(delta, characterBody.position);
    regenPlayerHealth(5 * delta);
  } else {
    director?.update(delta);
    if (zombieManager) zombieManager.update(delta);
  }
  enemyFire.update(delta);
  remotePlayers.update(delta, camera, FEET_OFFSET);
  netTick(delta);
  updateSquad(delta);

  const watched = brWatchedPlayer();
  if (watched) updateSpectatorCamera(delta, watched);
  else updateThirdPersonCamera(realDelta);
  updateFocus(watched);
  updateSoldier(delta);
  if (!watched) applyFirstPersonCamera();
  updateWeapon(delta);
  updateThrowAim(delta);
  throwables.update(delta);
  if (zombieManager) fireFX.syncBodies(zombieManager.active, characterBody.position.x, characterBody.position.z);
  fireFX.update(delta);
  // Smoke dims with the daylight and underground, so it never glows at night
  const smokeLight = (1 - env.darkness * 0.7) * (1 - caveDepth * 0.6);
  smokeFX.update(delta, smokeLight);
  updateSmokeOverlay(smokeLight);
  updateAudio(delta);
  effects.update(delta);
  updatePickups(delta);
  inventoryUI.update();
  syncGearModel();
  expireLootClaims();
  if (inventoryOpen) lootScreen.update(realDelta);

  timeSinceHit += delta;
  cameraTrauma = Math.max(0, cameraTrauma - delta * 1.6);
  updatePlayerHealthUI(delta);
  updateThreatUI();
  updatePlayerNoise(delta);
  updateLevelHud();
  gameHud.update(delta);
  updateCombatHUD(delta);

  minimap.update(performance.now(), focusPos.x, focusPos.z, watched ? watched.aimYaw : aimYaw);
  updatePins(performance.now());
  updateFightZones(performance.now());
  if (isBR()) brUpdateHud(delta);

  updateMood(delta);
  updateVehicleFx();
  updateSunShadow();
  if (QUALITY.shadowEvery > 1 && ++shadowFrame % QUALITY.shadowEvery === 0) renderer.shadowMap.needsUpdate = true;
  perfOverlay?.markRender(performance.now());
  renderFrame();
  updateDynamicResolution(frameMs, performance.now() - frameStart);
  if (perfOverlay) perfOverlay.endFrame(performance.now(), perfCounts());
}

// ─── Performance overlay + benchmark (?perf=1 / ?bench=1) ─────────────────────
const perfOverlay = PERF_ENABLED ? new PerfOverlay(renderer) : null;
const _perfCounts = {};
function perfCounts() {
  const c = _perfCounts;
  const active = zombieManager?.active ?? [];
  let animated = 0;
  for (const m of active) if (!m.dying && m.distXZ < 80) animated++;
  c.monsters = active.length;
  c.monstersAnimated = animated;
  c.enemyBolts = enemyFire.bolts.reduce((n, b) => n + (b.active ? 1 : 0), 0);
  c.fires = throwables.fires.reduce((n, f) => n + (f.active ? 1 : 0), 0);
  c.pickups = pickups.active.length;
  c.bodies = world.bodies.length;
  c.quality = `${QUALITY_NAME} @ ${perf.ratio.toFixed(2)}× pixels`;
  c.fpsCap = touch ? `${touch.settings.fps} → ${frameCap()}` : "none";
  return c;
}

/**
 * Scripted benchmark, the same on every device: noon, no levels, the player
 * can't die. 3 s warm-up, 10 s of looking around, 20 s of combat with 20
 * monsters chasing and the gun firing in bursts. Results go to the overlay,
 * the console ("BENCH_RESULT {…}") and window.__benchResult.
 */
const bench = { on: false, t0: 0, phase: "", spawned: false, results: {} };
const BENCH_WARMUP = 3000, BENCH_EXPLORE = 10000, BENCH_COMBAT = 20000;

function startBenchmark() {
  bench.on = true;
  bench.t0 = performance.now();
  lobby.hide();
  startScreenEl?.classList.remove("visible");
  hud.paused = false;
  env.hour = 12;
  env.paused = true;
  for (const m of [...zombieManager.active]) zombieManager.pool.release(m);
  characterBody.position.set(0, groundHeight(0, 0) + FEET_OFFSET + 0.05, 0);
  characterBody.velocity.set(0, 0, 0);
  aimYaw = 0;
  aimPitch = -0.08;
}

function benchStep(now) {
  const t = now - bench.t0;
  playerHealth = MAX_HEALTH;
  inventory.weapons[inventory.current] && (inventory.weapons[inventory.current].ammo = 30);
  if (t < BENCH_WARMUP) { bench.phase = "warm-up"; aimYaw += 0.01; return; }
  if (bench.phase === "warm-up") { bench.phase = "explore"; perfOverlay.reset(); }
  if (t < BENCH_WARMUP + BENCH_EXPLORE) {
    aimYaw += 0.012;                       // a slow look around
    perfOverlay.extra.bench = "explore";
    return;
  }
  if (bench.phase === "explore") {
    bench.results.explore = perfOverlay.report().data;
    perfOverlay.reset();
    bench.phase = "combat";
    // 20 monsters in a ring, all hunting the player
    const types = ["walker", "runner", "walker", "listener"];
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2, r = 16 + (i % 4) * 5;
      const m = zombieManager.spawn(types[i % types.length], Math.sin(a) * r, Math.cos(a) * r);
      if (!m) continue;
      m.target = localTarget;
      m.state = "chase";
      m.hasLOS = true;
    }
  }
  if (t < BENCH_WARMUP + BENCH_EXPLORE + BENCH_COMBAT) {
    aimYaw += 0.008;
    // Bursts: 0.6 s on, 0.4 s off
    input.fire = (t % 1000) < 600;
    perfOverlay.extra.bench = "combat";
    return;
  }
  input.fire = false;
  bench.results.combat = perfOverlay.report().data;
  bench.on = false;
  env.paused = true;
  const summary = {
    userAgent: navigator.userAgent, quality: QUALITY_NAME, pixelRatio: +perf.ratio.toFixed(2),
    screen: `${innerWidth}×${innerHeight} @ dpr ${devicePixelRatio}`,
    ...Object.fromEntries(Object.entries(bench.results).map(([k, d]) => [k, {
      fps: +d.fps.toFixed(1), frameAvg: +d.frame.avg.toFixed(2), p50: +d.frame.p50.toFixed(2), p95: +d.frame.p95.toFixed(2),
      p99: +d.frame.p99.toFixed(2), worst: +d.frame.max.toFixed(1), spikesOver50ms: d.spikesOver50ms,
      logicAvg: +d.logic.avg.toFixed(2), logicP95: +d.logic.p95.toFixed(2), submitAvg: +d.submit.avg.toFixed(2),
      gpuAvg: d.gpu ? +d.gpu.avg.toFixed(2) : null, calls: d.calls, triangles: d.triangles, heapMB: d.heapMB && +d.heapMB.toFixed(1),
    }])),
  };
  window.__benchResult = summary;
  console.log("BENCH_RESULT " + JSON.stringify(summary));
  perfOverlay.extra.bench = "DONE (window.__benchResult)";
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  syncPostSize();
});

// ─── Boot Sequence ────────────────────────────────────────────────────────────
const loadingScreen = document.getElementById("loading-screen");
const loadingMsg    = document.getElementById("loading-message");

function setLoadMsg(text) { if (loadingMsg) loadingMsg.textContent = text; }

// Progress counts files across every loader (GLTF, MD2, textures, VRML)
const loadingBarEl = document.getElementById("loading-bar");
THREE.DefaultLoadingManager.onProgress = (_url, loaded, total) => {
  if (loadingBarEl) loadingBarEl.style.transform = `scaleX(${Math.min(1, loaded / Math.max(1, total))})`;
  setLoadMsg(`Loading assets… ${loaded} / ${total}`);
};

/**
 * Compiles every shader the game can need and uploads GPU resources while the
 * loading screen is still up, so the first muzzle flash, hit flash, burning
 * zombie or molotov doesn't stall a frame mid-fight.
 */
async function warmUpGpu() {
  const hidden = [];
  scene.traverse(o => {
    if (!o.visible) { hidden.push(o); o.visible = true; }
    // Loaded models too: a transparent double-sided material is otherwise drawn
    // twice (back faces, then front), re-resolving its shader both times
    for (const m of o.material ? [].concat(o.material) : []) if (m.transparent && m.side === THREE.DoubleSide) m.forceSinglePass = true;
  });
  fireFX.setWarmup(true);
  const compile = async () => {
    // Into the same target the game draws to: tone mapping and colour space
    // are part of each program, so the screen's variants would be the wrong ones
    postFx.begin();
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
    else renderer.compile(scene, camera);
    renderer.compile(backdrop.scene, backdrop.camera);
    renderer.setRenderTarget(null);
  };
  await compile();
  loadMark("warm-up: scene programs");
  // Monster hit / burn materials only appear on demand: compile them on one of each type
  for (const t of Object.values(zombieManager?.pool.types ?? {})) {
    const m = zombieManager.pool.all.find(x => x.type === t.type);
    if (!m) continue;
    for (const mat of [t.skinMats[0].hit, t.skinMats[0].burn]) {
      m.mesh.material = mat;
      await compile();
    }
    m.mesh.material = t.skinMats[0].base;
  }
  // Pooled monsters wait at y = −500, outside the shadow camera, so their
  // shadow-depth programs (skinned / morphed) would compile on first spawn.
  // Stand one of each type near the player for this render.
  const staged = [];
  for (const t of Object.values(zombieManager?.pool.types ?? {})) {
    const m = zombieManager.pool.all.find(x => x.type === t.type && !x.active);
    if (!m) continue;
    staged.push([m, m.root.position.clone()]);
    m.root.position.set(characterBody.position.x + staged.length * 2 - 8, 0, characterBody.position.z + 6);
    m.root.updateMatrixWorld(true);
  }
  // The shadow camera normally covers 25 m round the player, so trees and
  // both levels of every LOD would compile their shadow-depth programs the
  // first time they come near (a visible hitch). For this one render it
  // covers the whole map and every LOD level is shown.
  const sc = sun.shadow.camera;
  const box = [sc.left, sc.right, sc.top, sc.bottom, sc.far];
  sc.left = sc.bottom = -400; sc.right = sc.top = 400; sc.far = 800;
  sc.updateProjectionMatrix();
  const lods = [];
  scene.traverse(o => { if (o.isLOD) { lods.push(o); o.autoUpdate = false; for (const l of o.levels) l.object.visible = true; } });
  renderer.shadowMap.needsUpdate = true;
  houses?.warmup(true);
  loadMark("warm-up: monster variants");
  renderFrame(); // uploads textures + buffers, compiles shadow programs
  loadMark("warm-up: first frame (shadows, uploads)");
  houses?.warmup(false);
  [sc.left, sc.right, sc.top, sc.bottom, sc.far] = box;
  sc.updateProjectionMatrix();
  for (const o of lods) o.autoUpdate = true;
  for (const [m, p] of staged) {
    m.root.position.copy(p);
    m.root.updateMatrixWorld(true);
  }
  for (const o of hidden) o.visible = false;
  fireFX.setWarmup(false);
}

// Load timeline (?perf=1 prints it): ms since the page started, per phase
const _loadMarks = [];
function loadMark(name) { _loadMarks.push([name, Math.round(performance.now())]); }

async function boot() {
  try {
    zombieManager = new ZombieManager({
      scene,
      world,
      monsterMaterial,
      linDamping: MONSTER_LIN_DAMPING,
      angDamping: MONSTER_ANG_DAMPING,
      playerRadius: CHARACTER_RADIUS,
      getTargets,
      onPlayerHit,
      regenPlayerHealth,
      enemyFire,
      sfx,
      loadGLB,
    });
    zombieManager.onCrash = onMonsterCrash;

    loadMark("boot");
    // Soldier, zombies and the world download + parse in parallel
    await Promise.all([
      loadCharacter(),
      zombieManager.init(),
      loadWorld(),
    ]);
    onWeaponChanged(false);
    loadMark("world built");

    director = new LevelDirector({
      manager: zombieManager,
      // Spawns gather around a random living player
      getPlayerPos: () => {
        const alive = getTargets().filter(t => t.alive);
        return (alive.length ? alive[(Math.random() * alive.length) | 0] : localTarget).pos;
      },
      onLevelStart,
      onLevelCleared,
      onBossSpawn,
      onDragonSpawn,
    });
    zombieManager.onKill = zombie => {
      // Kill credit goes to whoever landed the last hit
      if (zombie.lastHitBy === null || zombie.lastHitBy === localTarget.id) {
        killsThisLife++;
        progress.kill(zombie.type, zombie.killCause ?? "gun", env.darkness > NIGHT_DARKNESS);
        onLocalKill(zombie.killCause === "head");
        gameHud.killFeed(zombie.def.label, KILL_VERB[zombie.killCause] ?? "KILLED", zombie.def.color, zombie.killCause === "head");
      } else net.send({ t: "kill", to: zombie.lastHitBy, n: zombie.netId, c: zombie.killCause });
      zombie.killCause = null;
      rollZombieDrop(zombie);
      director.onKill(zombie);
    };
    monsterSync = new MonsterSync(zombieManager, enemyFire);
    zombieManager.onSpotted = () => {
      // Sting only when the first monster notices you
      if (zombieManager.chasingCount === 0) sfx.spotted();
    };
    // Monsters walk around buildings, use doorways, and can't get through closed doors
    zombieManager.navigate = (zx, zz, tx, tz, out, big, zy, ty) => {
      // Through the cave tunnels when the monster or its target is in one; legs in the open use the houses' pathing
      // In or out of a panchayat office / town building: through its doorway
      const ib = indiaBuildings?.navigate(zx, zz, tx, tz, out, big, (ax, az, bx, bz, o) => houses.navigate(ax, az, bx, bz, o, big, zy, zy)) ?? -1;
      if (ib >= 0) return ib;
      const r = caves.navigate(zx, zz, tx, tz, out, big, zy, ty, (ax, az, bx, bz, o) => houses.navigate(ax, az, bx, bz, o, big, zy, zy));
      return r >= 0 ? r : houses.navigate(zx, zz, tx, tz, out, big, zy, ty);
    };
    // Flyers keep their altitude over the cave hills, not over the cave floors under them
    zombieManager.flyFloor = (x, z) => surfaceHeight(x, z);
    // House floors and stairs are walkable surfaces too (monsters follow you upstairs)
    zombieManager.surfaceAt = (x, z, y, ground) => houses.surfaceAt(x, z, y, ground);
    zombieManager.canSpawnAt = (x, z) => !houses.blocks(x, z) && !caveBlocks(x, z, 4) && !indiaBuildings?.blocks(x, z);
    zombieManager.onDoorBang = (x, z) => {
      sfx.doorBang({ x, y: groundHeight(x, z) + 1.2, z });
    };
    spawnWorldLoot();

    setLoadMsg("Preparing shaders…");
    updateThirdPersonCamera(1 / 60);
    await warmUpGpu();

    loadMark("ready");
    if (PERF_ENABLED) console.info("LOAD_MARKS " + JSON.stringify(_loadMarks));

    clock.getDelta();
    _animRunning = true;
    animate();

    setupGui();

    window.zombieManager = zombieManager;
    window.inventory = inventory;
    window.env = env;
    window.weather = weather; window.__dbg = { net, br, remotePlayers, characterBody, get houses() { return houses; }, get stance() { return stance; }, inventory, pickups, vehicles, toggleVehicle, refuelVehicle, drive, keys, groundHeight, setAim(y, p) { aimYaw = y; aimPitch = p; }, quality: QUALITY_NAME, renderer, get hp() { return playerHealth; }, setHp(v) { playerHealth = v; }, get shops() { return shops; }, mapObstacles, get kills() { return killsThisLife; } }; // TEMP-DBG
    deathScreenEl?.addEventListener("click", respawnPlayer);

    if (BENCH_ENABLED) startBenchmark();
    else lobby.show();
    // The inventory screen's 3D character loads in the background
    lootScreen.initPreview(gltfLoader);
    loadingScreen.classList.add("hidden");
    loadingScreen.addEventListener("transitionend", () => loadingScreen.remove(), { once: true });
  } catch (err) {
    console.error("Boot failure:", err);
    setLoadMsg("Failed to load. Check the console.");
  }
}

boot();
