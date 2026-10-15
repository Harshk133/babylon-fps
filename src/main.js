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
import { Minimap } from "./ui/Minimap.js";
import { Houses, HOUSE_LOOT_SPOTS } from "./world/Houses.js";
import { EnemyFire } from "./combat/EnemyFire.js";
import { LevelDirector } from "./zombies/LevelDirector.js";
import { MONSTER_TYPES } from "./zombies/MonsterTypes.js";
import { GameHUD } from "./ui/GameHUD.js";
import { HealthBars } from "./ui/HealthBars.js";
import { Environment } from "./world/Environment.js";
import { Weather } from "./world/Weather.js";
import { Atmosphere } from "./world/Atmosphere.js";
import { plantDeadForest } from "./world/Forest.js";
import { Net } from "./net/Net.js";
import { RemotePlayers } from "./net/RemotePlayers.js";
import { MonsterSync } from "./net/MonsterSync.js";
import { Lobby } from "./net/Lobby.js";
import { ENEMY_GUNS, getLevel } from "./zombies/MonsterTypes.js";
import {
  WEAPONS, WEAPON_ORDER, HEAD_HEIGHT, GRENADE, MOLOTOV, MEDKIT, THROWABLES,
} from "./combat/weapons.js";
import { Inventory } from "./inventory/Inventory.js";
import { InventoryUI } from "./inventory/InventoryUI.js";
import { Pickups } from "./pickups/Pickups.js";
import { renderItemIcon } from "./items/ItemModels.js";
import { GROUP_WORLD, GROUP_PLAYER, GROUP_ZOMBIE } from "./physicsGroups.js";

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
const MOVE_ACCEL          = 14;    // exp-blend rates: a little weight, still responsive
const MOVE_DECEL          = 12;
const AIR_CONTROL         = 2;
const ROTATION_SPEED      = 16;
const GROUND_CHUNK_SIZE   = 48;
const GROUND_CHUNK_RADIUS = 5;
const GRASS_TILE_SIZE     = 2;
const SHADOW_FRUSTUM_SIZE = 25;

// ─── World Scatter Settings ───────────────────────────────────────────────────
const HOUSE_COUNT        = 2;
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
const currentDef = () => WEAPONS[inventory.current];

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

  const low = Math.round(THREE.MathUtils.clamp((40 - playerHealth) / 40, 0, 1) * 20) / 20;
  if (low !== hudCache.low) {
    hudCache.low = low;
    if (lowHealthEl) lowHealthEl.style.opacity = `${low}`;
  }
}

function updateThreatUI() {
  const n = zombieManager ? zombieManager.chasingCount : 0;
  if (n === hudCache.threat) return;
  hudCache.threat = n;
  if (threatCountEl) threatCountEl.textContent = `${n}`;
  if (threatEl) threatEl.classList.toggle("active", n > 0);
}

/** srcX / srcZ: where the hit came from (shows the red direction arc). */
function dealDamageToPlayer(amount, knockX = 0, knockZ = 0, shake = 0.45, srcX = null, srcZ = null) {
  if (playerHealth <= 0) return;
  playerHealth = Math.max(0, playerHealth - amount);
  if (srcX !== null) {
    const dx = srcX - characterBody.position.x, dz = srcZ - characterBody.position.z;
    // Angle clockwise from the camera's forward: right = (−cos, sin), forward = (sin, cos)
    const right = dx * -Math.cos(aimYaw) + dz * Math.sin(aimYaw);
    const fwd = dx * Math.sin(aimYaw) + dz * Math.cos(aimYaw);
    gameHud.hitFrom(Math.atan2(right, fwd), amount / 15);
  }
  sfx.hurt();
  timeSinceHit = 0;
  damageFlash  = Math.min(1, damageFlash + Math.max(0.25, shake * 1.5));
  cameraTrauma = Math.min(1, cameraTrauma + shake);
  knockbackVel.x += knockX;
  knockbackVel.z += knockZ;
  if (playerHealth <= 0) onPlayerDeath();
}

function regenPlayerHealth(amount) {
  if (playerHealth > 0 && playerHealth < MAX_HEALTH && timeSinceHit > REGEN_DELAY) {
    playerHealth = Math.min(MAX_HEALTH, playerHealth + amount);
  }
}

function onPlayerDeath() {
  cameraTrauma = 1;
  soldier.die();
  sfx.hurt();
  cancelThrow();
  setInventoryOpen(false);
  if (deathKillsEl) deathKillsEl.textContent = `${killsThisLife}`;
  if (deathScreenEl) deathScreenEl.classList.add("visible");
  if (document.pointerLockElement) document.exitPointerLock();
}

function respawnPlayer() {
  playerHealth = MAX_HEALTH;
  healthTrail  = MAX_HEALTH;
  timeSinceHit = 99;
  knockbackVel.set(0, 0, 0);
  // Co-op: come back next to a living teammate
  const mate = net.connected ? remotePlayers.targets().find(t => t.alive) : null;
  const sx = mate ? mate.pos.x + 2 : 0, sz = mate ? mate.pos.z + 2 : 0;
  characterBody.position.set(sx, FEET_OFFSET + 0.02, sz);
  characterBody.velocity.set(0, 0, 0);
  moveVelocity.set(0, 0, 0);
  camPivot.set(sx, cameraRig.pivotHeight, sz);
  inventory.reset();
  onWeaponChanged(false);
  throwables.clear();
  fireFX.clear();
  enemyFire.clear();
  killsThisLife = 0;
  soldier.revive();
  if (!net.connected) director?.restart(); // solo: same level, from the top
  if (deathScreenEl) deathScreenEl.classList.remove("visible");
  requestLock();
}

function requestLock() {
  // Newer browsers return a promise that rejects if the lock is refused
  const p = canvas.requestPointerLock();
  if (p && p.catch) p.catch(() => {});
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
  const hideCrosshair = sprinting || playerHealth <= 0;
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
  if (inventory.current !== hud.weapon) {
    hud.weapon = inventory.current;
    hud.ammo = -1;
    if (ammoWeaponEl) ammoWeaponEl.textContent = def.short;
    // One pip per round in the magazine
    ammoCardEl?.style.setProperty("--pips", `${def.magSize}`);
  }
  if (slot.ammo !== hud.ammo) {
    hud.ammo = slot.ammo;
    if (ammoCountEl) ammoCountEl.textContent = `${slot.ammo}`;
    if (ammoPipsEl) ammoPipsEl.style.clipPath = `inset(0 ${100 - (slot.ammo / def.magSize) * 100}% 0 0)`;
    const low = slot.ammo <= Math.max(1, def.magSize * 0.25);
    if (low !== hud.low) {
      hud.low = low;
      ammoCardEl?.classList.toggle("low", low);
    }
  }
  if (slot.reserve !== hud.reserve) {
    hud.reserve = slot.reserve;
    if (ammoReserveEl) ammoReserveEl.textContent = `/ ${slot.reserve === Infinity ? "∞" : slot.reserve}`;
  }

  const reload = weapon.reloading ? Math.round((1 - weapon.reloadTimer / def.reloadTime) * 50) / 50 : -1;
  if (reload !== hud.reload) {
    hud.reload = reload;
    ammoCardEl?.classList.toggle("reloading", reload >= 0);
    if (reloadBarEl) reloadBarEl.style.transform = `scaleX(${Math.max(0, reload)})`;
  }

  if (killsThisLife !== hud.kills) {
    hud.kills = killsThisLife;
    if (killsEl) killsEl.textContent = `${killsThisLife}`;
  }

  const showStart = hud.paused && playerHealth > 0 && !inventoryOpen && !lobby?.open;
  if (showStart !== hud.shownPaused) {
    hud.shownPaused = showStart;
    startScreenEl?.classList.toggle("visible", showStart);
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
scene.fog = new THREE.Fog(0xb08468, 35, 190);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.5, 220);

const canvas = document.getElementById("webgl");
// No logarithmic depth: near/far of 0.5/220 doesn't need it, and log depth
// writes gl_FragDepth, which disables early-Z for every pixel in the scene.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);

// ─── Dynamic resolution ───────────────────────────────────────────────────────
// Drops the render scale when frames run long and creeps back up when there's
// headroom, so a heavy moment (big horde, explosions) costs sharpness, not FPS.
const MAX_PIXEL_RATIO = Math.min(window.devicePixelRatio, 1.5);
const MIN_PIXEL_RATIO = Math.min(0.65, MAX_PIXEL_RATIO);
const perf = { ratio: MAX_PIXEL_RATIO, avg: 16.7, slow: 0, fast: 0 };
renderer.setPixelRatio(perf.ratio);

function updateDynamicResolution(frameMs) {
  perf.avg += (Math.min(frameMs, 100) - perf.avg) * 0.05;
  if (perf.avg > 20) { perf.slow += frameMs; perf.fast = 0; }
  else if (perf.avg < 14) { perf.fast += frameMs; perf.slow = 0; }
  else { perf.slow = 0; perf.fast = 0; }

  let next = perf.ratio;
  if (perf.slow > 600) next = Math.max(MIN_PIXEL_RATIO, perf.ratio - 0.1);
  else if (perf.fast > 3000) next = Math.min(MAX_PIXEL_RATIO, perf.ratio + 0.05);
  if (next !== perf.ratio) {
    perf.ratio = next;
    perf.slow = 0;
    perf.fast = 0;
    renderer.setPixelRatio(next);
  }
}
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const effects = new Effects(scene);
const sfx = new Sfx();

// ─── Physics World ────────────────────────────────────────────────────────────
const world = new CANNON.World();
world.gravity.set(0, -20, 0); // Earth gravity
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;
world.solver.iterations = 8;
world.solver.tolerance = 0.0001;

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
grassTexture.repeat.set(GROUND_CHUNK_SIZE / GRASS_TILE_SIZE, GROUND_CHUNK_SIZE / GRASS_TILE_SIZE);
grassTexture.colorSpace  = THREE.SRGBColorSpace;
grassTexture.anisotropy  = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
grassTexture.minFilter   = THREE.LinearMipmapLinearFilter;
grassTexture.magFilter   = THREE.LinearFilter;
grassTexture.generateMipmaps = true;

const planeMaterial = new THREE.MeshStandardMaterial({
  map: grassTexture, roughness: 0.95, metalness: 0.02,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});

const sharedChunkGeo = new THREE.PlaneGeometry(GROUND_CHUNK_SIZE, GROUND_CHUNK_SIZE, 1, 1);
const groundChunks = new Map();
let activeGroundCenter = { x: NaN, z: NaN };

function groundChunkKey(cx, cz) { return `${cx},${cz}`; }
function getGroundChunkCoord(wx, wz) {
  return { x: Math.floor(wx / GROUND_CHUNK_SIZE), z: Math.floor(wz / GROUND_CHUNK_SIZE) };
}
function createGroundChunk(cx, cz) {
  const key = groundChunkKey(cx, cz);
  if (groundChunks.has(key)) return;
  const mesh = new THREE.Mesh(sharedChunkGeo, planeMaterial);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(cx * GROUND_CHUNK_SIZE + GROUND_CHUNK_SIZE * 0.5, 0, cz * GROUND_CHUNK_SIZE + GROUND_CHUNK_SIZE * 0.5);
  mesh.receiveShadow = true;
  freezeStatic(mesh);
  scene.add(mesh);
  groundChunks.set(key, mesh);
}
function removeGroundChunk(key) {
  const mesh = groundChunks.get(key);
  if (!mesh) return;
  scene.remove(mesh);
  groundChunks.delete(key);
}
function updateGroundChunks(fx, fz) {
  const { x: cx, z: cz } = getGroundChunkCoord(fx, fz);
  if (cx === activeGroundCenter.x && cz === activeGroundCenter.z) return;
  activeGroundCenter = { x: cx, z: cz };
  const needed = new Set();
  for (let dx = -GROUND_CHUNK_RADIUS; dx <= GROUND_CHUNK_RADIUS; dx++) {
    for (let dz = -GROUND_CHUNK_RADIUS; dz <= GROUND_CHUNK_RADIUS; dz++) {
      const key = groundChunkKey(cx + dx, cz + dz);
      needed.add(key);
      createGroundChunk(cx + dx, cz + dz);
    }
  }
  for (const key of groundChunks.keys()) {
    if (!needed.has(key)) removeGroundChunk(key);
  }
}

// Rigid ground collision body
const groundBody = new CANNON.Body({ mass: 0, material: groundMaterial });
groundBody.addShape(new CANNON.Plane());
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(groundBody);

updateGroundChunks(0, 0);

// ─── Lighting ─────────────────────────────────────────────────────────────────
// Colours and intensities are set every frame by the day/night cycle
const hemiLight = new THREE.HemisphereLight(0x9fb4d8, 0x4a3a2c, 0.9);
const ambientLight = new THREE.AmbientLight(0xffe2c8, 0.25);
scene.add(hemiLight, ambientLight);
const sun = new THREE.DirectionalLight(0xffc48a, 2.4); // the moon at night
sun.position.set(6, 12, 4);
sun.castShadow = true;
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

const env = new Environment({ scene, renderer, lights: { hemi: hemiLight, ambient: ambientLight, sun } });
const weather = new Weather(scene);
const atmosphere = new Atmosphere(scene);
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

// ─── Camera Rig (over-the-shoulder) ───────────────────────────────────────────
// Aim direction = (sin yaw·cos pitch, sin pitch, cos yaw·cos pitch); +pitch looks up.
const cameraRig = {
  pivotHeight: 1.55,
  hip:    { distance: 2.6,  shoulder: 0.55, height: 0.12, fov: 62 },
  aim:    { distance: 1.25, shoulder: 0.5,  height: 0.06, fov: 42 },
  sprint: { distance: 3.0,  shoulder: 0.45, height: 0.15, fov: 70 },
  followXZ: 16, followY: 9,
  pitchMin: -1.2, pitchMax: 1.0,
  sensitivity: 0.0022, aimSensitivity: 0.0012,
};
let aimYaw = 0, aimPitch = -0.12;
let aimBlend = 0, sprintBlend = 0;
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
const isLocked = () => document.pointerLockElement === canvas;

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
    if (code === "Escape" && inventoryOpen) { setInventoryOpen(false); return; }
    if (!playing) return;
    if (code in SLOT_KEYS) {
      const id = WEAPON_ORDER.find(w => WEAPONS[w].slot === SLOT_KEYS[code]);
      if (inventory.has(id)) equipWeapon(id);
      else inventoryUI.feed(`${WEAPONS[id].name} not found yet`, "info");
    }
    switch (code) {
      case "KeyR": startReload(); break;
      case "KeyE": interact(); break;
      case "KeyG": beginThrow(); break;
      case "KeyQ": cycleThrowable(); break;
      case "KeyH": useMedkit(); break;
      case "KeyO": useDoor(true); break;
      case "KeyC": useDoor(false); break;
      case "KeyL": useLightSwitch(); break;
      case "KeyF": toggleTorch(); break;
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
  if (playerHealth > 0 && !inventoryOpen && !lobby?.open) requestLock();
});
let wheelCooldown = 0;
window.addEventListener("wheel", e => {
  if (!isLocked() || playerHealth <= 0 || e.deltaY === 0) return;
  const now = performance.now();
  if (now < wheelCooldown) return;
  wheelCooldown = now + 120;
  const prev = inventory.current;
  inventory.cycle(e.deltaY > 0 ? 1 : -1);
  if (inventory.current !== prev) onWeaponChanged();
}, { passive: true });
canvas.addEventListener("mousedown", e => {
  if (!isLocked()) return;
  if (e.button === 0) { input.fire = true; input.firePressed = true; }
  if (e.button === 2) input.aim = true;
});
window.addEventListener("mouseup", e => {
  if (e.button === 0) input.fire = false;
  if (e.button === 2) input.aim = false;
});
window.addEventListener("contextmenu", e => e.preventDefault());
document.addEventListener("pointerlockchange", () => {
  if (!isLocked()) { input.fire = false; input.aim = false; }
  hud.paused = !isLocked();
  // The first level starts when you first click into the game
  // (co-op clients follow the host's levels instead)
  if (isLocked() && director && director.state === "idle" && !net.isClient) director.start(1);
});
document.addEventListener("mousemove", e => {
  if (!isLocked()) return;
  const s = THREE.MathUtils.lerp(cameraRig.sensitivity, cameraRig.aimSensitivity, aimBlend);
  aimYaw   -= e.movementX * s;
  aimPitch -= e.movementY * s;
  aimPitch  = THREE.MathUtils.clamp(aimPitch, cameraRig.pitchMin, cameraRig.pitchMax);
});

// ─── Ground Check ─────────────────────────────────────────────────────────────
function checkGrounded() {
  onGround = false;
  rayOrigin.set(characterBody.position.x, characterBody.position.y + 0.05,          characterBody.position.z);
  rayTo    .set(characterBody.position.x, characterBody.position.y - FEET_OFFSET - 0.45, characterBody.position.z);
  const hit = world.raycastClosest(rayOrigin, rayTo, groundRayOpts, rayResult);
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
  rayOrigin.set(characterBody.position.x, characterBody.position.y + 0.05,          characterBody.position.z);
  rayTo    .set(characterBody.position.x, characterBody.position.y - FEET_OFFSET - 0.45, characterBody.position.z);
  if (world.raycastClosest(rayOrigin, rayTo, groundRayOpts, rayResult)) {
    const d = rayResult.distance - FEET_OFFSET;
    if (Math.abs(d) < GROUND_SNAP_DISTANCE) characterBody.position.y -= d;
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
  }
  const len = Math.hypot(ix, iz);
  const movingInput = len > 0;
  if (movingInput) { ix /= len; iz /= len; }

  sprinting = alive && keys.run && iz > 0.5 && !input.fire && !input.aim;

  let speed = 0;
  if (sprinting) {
    speed = SPRINT_SPEED;
  } else if (movingInput) {
    const ax = Math.abs(ix), az = Math.abs(iz);
    speed = (az * (iz >= 0 ? JOG_SPEED : BACKPEDAL_SPEED) + ax * STRAFE_SPEED) / (ax + az);
    if (input.aim) speed *= AIM_MOVE_MULTIPLIER;
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

  if (jumpQueued && onGround && alive) {
    characterBody.velocity.y = JUMP_VELOCITY;
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

function updateSoldier(delta) {
  characterRoot.updateMatrixWorld(true);
  const vx = characterBody.velocity.x - knockbackVel.x;
  const vz = characterBody.velocity.z - knockbackVel.z;
  const sy = Math.sin(bodyYaw), cy = Math.cos(bodyYaw);
  const alive = playerHealth > 0;
  soldier.update(delta, {
    localForward: onGround ? vx * sy + vz * cy : 0,
    localRight:   onGround ? -vx * cy + vz * sy : 0,
    aiming: alive && !sprinting && (input.aim || input.fire || timeSinceShot < 0.5),
    firing: timeSinceShot < 0.12,
    aimYawOffset: angleDiff(aimYaw + recoilYaw, bodyYaw),
    aimPitch: aimPitch + recoilPitch,
  });
}

// ─── Shadow / Camera ──────────────────────────────────────────────────────────
function updateSunShadow() {
  const fx = characterBody.position.x, fz = characterBody.position.z;
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
const DRY_GROUND = { roughness: 0.95, color: new THREE.Color(0xffffff) };
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
    inventoryUI.feed("Night falls. F toggles your flashlight (they can see it)", "info");
  }
  const want = torch.on && playerHealth > 0 ? 1 : 0;
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

function updateMood(delta) {
  indoor =!!houses?.houseAt(camera.position.x, camera.position.z);
  env.update(delta, camera, weather);
  weather.update(delta, camera.position, indoor);
  atmosphere.update(delta, camera.position, {
    mist: Math.max(env.darkness * 0.8, weather.rain * 0.6),
    fogColor: scene.fog.color,
    wind: weather.wind,
    rain: weather.rain,
  });
  healthBars.update(delta, zombieManager?.active ?? [], characterBody.position);
  updateTorch(delta);

  // Rain soaks the ground (darker, glossier); it dries slowly
  wetness += ((weather.rain > 0.15 ? 1 : 0) - wetness) * (1 - Math.exp(-(weather.rain > 0.15 ? 0.08 : 0.02) * delta));
  planeMaterial.roughness = THREE.MathUtils.lerp(DRY_GROUND.roughness, WET_GROUND.roughness, wetness);
  planeMaterial.color.copy(DRY_GROUND.color).lerp(WET_GROUND.color, wetness);
  // Rain hides your scent from the hounds
  if (zombieManager) zombieManager.scentMul = 1 - weather.rain * 0.35;

  sfx.setAmbience(weather.rain, Math.min(1, weather.wind / 4.5), env.darkness, indoor);
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
  const { hip, aim, sprint } = cameraRig;
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(hip[key], aim[key], aimBlend), sprint[key], sprintBlend);
}

function updateThirdPersonCamera(delta) {
  const alive = playerHealth > 0;
  aimBlend    += ((input.aim && alive && !sprinting ? 1 : 0) - aimBlend) * (1 - Math.exp(-12 * delta));
  sprintBlend += ((sprinting ? 1 : 0) - sprintBlend) * (1 - Math.exp(-4 * delta));

  // Critically-damped style follow: tight on XZ, softer on Y so jumps/steps don't jolt
  const kxz = 1 - Math.exp(-cameraRig.followXZ * delta);
  const ky  = 1 - Math.exp(-cameraRig.followY * delta);
  camPivot.x += (characterBody.position.x - camPivot.x) * kxz;
  camPivot.z += (characterBody.position.z - camPivot.z) * kxz;
  camPivot.y += (characterBody.position.y - FEET_OFFSET + cameraRig.pivotHeight - camPivot.y) * ky;

  recoilPitch *= Math.exp(-10 * delta);
  recoilYaw   *= Math.exp(-12 * delta);
  const yaw   = aimYaw + recoilYaw;
  const pitch = THREE.MathUtils.clamp(aimPitch + recoilPitch, cameraRig.pitchMin, cameraRig.pitchMax);
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
  if (world.raycastClosest(camRayFrom, camRayTo, camRayOpts, camRayResult)) {
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
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
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
  sfx.reload(def.reloadTime);
}

function equipWeapon(id) {
  if (inventory.equip(id)) onWeaponChanged();
}

/** Syncs the held model, camera zoom and weapon timers to inventory.current. */
function onWeaponChanged(withSound = true) {
  const def = currentDef();
  soldier.setWeapon(inventory.current);
  cameraRig.aim.fov = def.aimFov;
  weapon.reloading = false;
  weapon.bloom = 0;
  weapon.cooldown = 0;
  weapon.switchTimer = withSound ? SWITCH_TIME : 0;
  if (withSound) sfx.equip();
}

function currentSpread() {
  const def = currentDef();
  const hSpeed = Math.hypot(characterBody.velocity.x, characterBody.velocity.z);
  const moving = THREE.MathUtils.clamp(hSpeed / JOG_SPEED, 0, 1);
  return THREE.MathUtils.lerp(def.spreadHip, def.spreadAim, aimBlend)
    + def.spreadMove * moving * (1 - aimBlend * 0.6)
    + (onGround ? 0 : def.spreadAir)
    + weapon.bloom;
}

function updateWeapon(delta) {
  const def = currentDef();
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
      sfx.click();
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
  sfx.gunshot(def.sound);

  let anyHit = false, anyHead = false, anyKill = false;
  shotPoints.length = 0;
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
    if (zombie && zombieManager) {
      const headshot = zombieManager.isHeadshot(zombie, _hitPoint, HEAD_HEIGHT);
      const damage = def.damage * (headshot ? def.headshotMultiplier : 1);
      zombie.killCause = headshot ? "head" : "gun";
      const killed = hitMonster(zombie, damage, _shotDir.x * def.push, _shotDir.z * def.push);
      const blood = def.pellets > 1 ? 4 : headshot ? 22 : 10;
      effects.impact(_hitPoint, -_shotDir.x, 0.3, -_shotDir.z, "blood", blood);
      anyHit = true;
      anyHead ||= headshot;
      anyKill ||= killed;
    } else {
      const n = _shotResult.hitNormalWorld;
      effects.impact(_hitPoint, n.x, n.y, n.z, "dust", def.pellets > 1 ? 3 : 7);
    }
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
  if (net.connected) {
    net.send({ t: "shot", w: def.sound, f: [+_muzzle.x.toFixed(2), +_muzzle.y.toFixed(2), +_muzzle.z.toFixed(2)], h: shotPoints });
  }
}

// ─── Throwables (grenade / molotov) ───────────────────────────────────────────
let throwAiming   = false;
let throwCooldown = 0;
const _throwFrom  = new THREE.Vector3();
const _throwVel   = new THREE.Vector3();

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
  if (throwCooldown > 0 || throwAiming) return;
  const kind = inventory.selectedThrowable;
  if (inventory.throwables[kind] <= 0) {
    inventoryUI.feed(`No ${THROWABLES[kind].name}s — press Q to switch`, "info", kind);
    return;
  }
  throwAiming = true;
  weapon.reloading = false;
}

function releaseThrow() {
  if (!throwAiming) return;
  throwAiming = false;
  throwables.hidePreview();
  if (playerHealth <= 0) return;
  const kind = inventory.takeThrowable();
  if (!kind) return;
  computeThrow();
  throwables.throw(kind, _throwFrom, _throwVel, localTarget.id);
  if (net.connected) {
    net.send({
      t: "throw", k: kind,
      o: [_throwFrom.x, _throwFrom.y, _throwFrom.z].map(v => +v.toFixed(3)),
      v: [_throwVel.x, _throwVel.y, _throwVel.z].map(v => +v.toFixed(3)),
    });
  }
  throwCooldown = THROW_COOLDOWN;
}

function cancelThrow() {
  throwAiming = false;
  throwables.hidePreview();
}

function cycleThrowable() {
  const kind = inventory.cycleThrowable();
  sfx.click();
  inventoryUI.feed(`${THROWABLES[kind].name} ready (${inventory.throwables[kind]})`, "throwable", kind);
}

function updateThrowAim(delta) {
  throwCooldown = Math.max(0, throwCooldown - delta);
  if (!throwAiming) return;
  if (playerHealth <= 0 || !isLocked()) { cancelThrow(); return; }
  computeThrow();
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
    const shield = blastShielded(pos, characterBody.position.x, characterBody.position.y + 0.4, characterBody.position.z) ? 0.15 : 1;
    const f = (1 - pd / GRENADE.playerRadius) * shield;
    const k = pd > 1e-3 ? 8 * f / pd : 0;
    dealDamageToPlayer(GRENADE.playerMaxDamage * f, px * k, pz * k, 0.6);
  }
  cameraTrauma = Math.min(1, cameraTrauma + THREE.MathUtils.clamp(1 - pd / 35, 0, 1) * 0.8);
  sfx.explosion(pd);
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
  if (px * px + pz * pz < pr * pr && characterBody.position.y - FEET_OFFSET < 1) {
    dealDamageToPlayer(MOLOTOV.playerDps * dt, 0, 0, 0.08);
  }
}

// ─── Medkits ──────────────────────────────────────────────────────────────────
function useMedkit() {
  if (playerHealth <= 0) return;
  if (playerHealth >= MAX_HEALTH) { inventoryUI.feed("Health already full", "info"); return; }
  if (!inventory.takeMedkit()) { inventoryUI.feed("No medkits", "info"); return; }
  playerHealth = Math.min(MAX_HEALTH, playerHealth + MEDKIT.heal);
  sfx.heal();
  inventoryUI.feed(`+${MEDKIT.heal} health`, "medkit");
}

// ─── Pickups ──────────────────────────────────────────────────────────────────
function pickupData(kind) {
  const def = WEAPONS[kind];
  if (def) return { ammo: def.magSize, reserve: def.pickupReserve };
  return null;
}

/** Tries to move a world pickup into the inventory. Returns true if it was taken. */
function collectPickup(entry) {
  const { kind, def } = entry;
  let res = null;
  switch (def.category) {
    case "weapon": {
      res = inventory.addWeapon(kind, entry.data.ammo, entry.data.reserve);
      if (!res) { inventoryUI.feed(`${def.label}: ammo full`, "info", kind); return false; }
      if (res.isNew) {
        equipWeapon(kind);
        res.msg = `Picked up ${def.label}`;
      }
      break;
    }
    case "ammo":      res = inventory.addAmmoCrate(); break;
    case "throwable": res = inventory.addThrowable(kind, entry.data?.count ?? 1); break;
    case "medkit":    res = inventory.addMedkit(); break;
  }
  if (!res) return false;
  pickups.release(entry);
  sfx.pickup(def.category === "weapon");
  inventoryUI.feed(res.msg, def.category, kind);
  return true;
}

function interact() {
  if (pickups.nearestWeapon) collectPickup(pickups.nearestWeapon);
}

function updatePickups(delta) {
  pickups.update(delta, characterBody.position.x, characterBody.position.z);
  if (playerHealth > 0) {
    for (let i = pickups.touching.length - 1; i >= 0; i--) collectPickup(pickups.touching[i]);
  }

  // Context prompts: weapon pickup, door, light switch
  let n = 0;
  if (playerHealth > 0) {
    const e = pickups.nearestWeapon;
    if (e) {
      promptRows[n++] = "E";
      promptRows[n++] = inventory.has(e.kind) ? `Take ammo · ${e.def.label}` : `Pick up ${e.def.label}`;
    }
    const near = houses?.interaction(characterBody.position.x, characterBody.position.z);
    nearDoor = near?.door ?? null;
    nearSwitch = near?.sw ?? null;
    if (nearDoor) {
      promptRows[n++] = nearDoor.doorOpen ? "C" : "O";
      promptRows[n++] = nearDoor.doorOpen ? "Close door" : "Open door";
    }
    if (nearSwitch) {
      promptRows[n++] = "L";
      promptRows[n++] = nearSwitch.lightOn ? "Turn lights off" : "Turn lights on";
    }
  } else {
    nearDoor = nearSwitch = null;
  }
  inventoryUI.setPrompts(promptRows, n);
}

// ─── Doors & lights ───────────────────────────────────────────────────────────
const promptRows = [];
let nearDoor = null;
let nearSwitch = null;

function useDoor(open) {
  if (nearDoor && houses.setDoor(nearDoor, open)) {
    makeNoise(nearDoor.doorWorld.x, nearDoor.doorWorld.z, open ? 9 : 12, "door");
    net.send({ t: "door", h: houses.houses.indexOf(nearDoor), o: open });
  }
}

function useLightSwitch() {
  if (!nearSwitch) return;
  houses.toggleLight(nearSwitch);
  net.send({ t: "light", h: houses.houses.indexOf(nearSwitch), on: nearSwitch.lightOn });
}

function dropWeapon(id) {
  const prev = inventory.current;
  const slot = inventory.removeWeapon(id);
  if (!slot) return;
  pickups.spawn(id,
    characterBody.position.x + Math.sin(bodyYaw) * 1.3,
    characterBody.position.z + Math.cos(bodyYaw) * 1.3,
    { ammo: slot.ammo, reserve: slot.reserve });
  inventoryUI.feed(`Dropped ${WEAPONS[id].name}`, "info", id);
  if (inventory.current !== prev) onWeaponChanged();
}

// Zombie loot: one roll per kill
const DROP_TABLE = [
  ["ammo", 0.16],
  ["grenade", 0.05],
  ["molotov", 0.05],
  ["medkit", 0.045],
  ["gun", 0.025],
];
const DROP_GUNS = ["shotgun", "rifle", "sniper", "smg"];

function spawnDrop(k, x, z, life) {
  pickups.spawn(k, x, z, pickupData(k), life);
  net.send({ t: "drop", k, x: +x.toFixed(2), z: +z.toFixed(2), l: life });
}

const BOSS_STASH   = ["sniper", "rifle", "medkit", "medkit", "ammo", "ammo", "grenade", "molotov"];
const DRAGON_STASH = ["medkit", "medkit", "ammo", "ammo", "ammo", "grenade"];

function rollZombieDrop(zombie) {
  const p0 = zombie.body.position;
  const stash = zombie.def.boss ? BOSS_STASH : zombie.def.bossBar ? DRAGON_STASH : null;
  if (stash) {
    // The Warlord and dragons drop a stash
    stash.forEach((k, i) => {
      const a = (i / stash.length) * Math.PI * 2;
      spawnDrop(k, p0.x + Math.cos(a) * 2.6, p0.z + Math.sin(a) * 2.6, DROP_LIFETIME * 2);
    });
    return;
  }
  // Tougher monsters drop more often
  let r = Math.random() / (zombie.def.bigBody ? 3 : zombie.gun ? 1.6 : 1);
  for (const [kind, chance] of DROP_TABLE) {
    if (r < chance) {
      const k = kind === "gun" ? DROP_GUNS[(Math.random() * DROP_GUNS.length) | 0] : kind;
      const p = zombie.body.position;
      spawnDrop(k, p.x, p.z, DROP_LIFETIME);
      return;
    }
    r -= chance;
  }
}

// Placed world loot: deterministic, like the rest of the scatter
const STARTER_LOOT = [
  ["shotgun", -2.5, 7], ["rifle", 2.5, 7],
  ["grenade", -1.5, 10], ["molotov", 1.5, 10], ["ammo", 0, 12],
];
const WORLD_LOOT = {
  pistol: 1, smg: 2, shotgun: 3, rifle: 3, sniper: 3,
  ammo: 14, grenade: 10, molotov: 10, medkit: 8,
};
const _lootFrom = new CANNON.Vec3();
const _lootTo = new CANNON.Vec3();
const _lootResult = new CANNON.RaycastResult();
const lootRayOpts = { collisionFilterMask: GROUP_WORLD };

// True if nothing but bare ground is under (x, z) — keeps loot out of houses/trees
function isOpenGround(x, z) {
  for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    _lootFrom.set(x + ox, 40, z + oz);
    _lootTo.set(x + ox, -1, z + oz);
    _lootResult.reset();
    if (!world.raycastClosest(_lootFrom, _lootTo, lootRayOpts, _lootResult)) return false;
    if (_lootResult.hitPointWorld.y > 0.05) return false;
  }
  return true;
}

const HOUSE_LOOT = ["ammo", "medkit", "grenade", "molotov", "ammo", "shotgun"];

function spawnWorldLoot() {
  const lootRng = makeLCG(0x10070bad);
  // A little something inside every house
  const spot = new THREE.Vector3();
  houses?.houses.forEach((h, i) => {
    for (const [lx, lz] of HOUSE_LOOT_SPOTS) {
      if (lootRng() < 0.35) continue;
      const kind = HOUSE_LOOT[(i * 3 + Math.floor(lootRng() * HOUSE_LOOT.length)) % HOUSE_LOOT.length];
      houses._toWorld(h, lx, lz, spot);
      pickups.spawn(kind, spot.x, spot.z, pickupData(kind));
    }
  });
  for (const [kind, x, z] of STARTER_LOOT) pickups.spawn(kind, x, z, pickupData(kind));
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
  inventoryUI.setOpen(open);
  if (open) {
    input.fire = false;
    input.aim = false;
    cancelThrow();
    if (document.pointerLockElement) document.exitPointerLock();
  } else if (playerHealth > 0) {
    requestLock();
  }
}

// Item icons are rendered from the same 3D models once at startup
const itemIcons = {};
for (const id of WEAPON_ORDER) itemIcons[id] = renderItemIcon(renderer, id, { width: 160, height: 56 });
itemIcons.grenade = renderItemIcon(renderer, "grenade", { width: 64, height: 64, yaw: 0.4 });
itemIcons.molotov = renderItemIcon(renderer, "molotov", { width: 64, height: 64, yaw: 0.4 });
itemIcons.ammo    = renderItemIcon(renderer, "ammo",    { width: 64, height: 64, yaw: 0.6, pitch: 0.35 });

const inventoryUI = new InventoryUI({
  inventory,
  icons: itemIcons,
  onEquip: id => equipWeapon(id),
  onDrop: id => dropWeapon(id),
  onSelectThrowable: kind => { inventory.selectThrowable(kind); sfx.click(); },
  onUseMedkit: () => useMedkit(),
  onClose: () => setInventoryOpen(false),
});

const pickups = new Pickups(scene);

const fireFX = new FireFX(scene);
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
  sfx.howl(80);
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
    // Rain drowns out footsteps
    makeNoise(characterBody.position.x, characterBody.position.z, step[0] * (1 - weather.rain * 0.35), "step");
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
  const h = houses?.houseAt(characterBody.position.x, characterBody.position.z);
  if (h && !h.lightOn) v *= 0.45;
  v *= 1 - env.darkness * (torch.level > 0.5 ? 0.1 : 0.5);
  v *= 1 - weather.rain * 0.25;
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
  sfx.growl(0, true);
}

function onDragonSpawn(dragon) {
  if (net.isHost) net.send({ t: "lev", e: "dragon", n: director.level.n });
  gameHud.showBanner({ title: "DRAGON", sub: "Something is circling above", text: "Get under a roof when it dives.", color: dragon.def.color, duration: 4 });
  sfx.dragonRoar(25);
}

// Dragon fireballs: a burst of flame where they land, and burning ground
let lastDragonFire = 0;
function onBoltImpact(gun, pos) {
  if (!gun.ignite) return;
  const y = Math.max(0.3, pos.y);
  fireFX.blast(pos.x, y, pos.z);
  const d = Math.hypot(pos.x - characterBody.position.x, pos.z - characterBody.position.z);
  sfx.explosion(d + 25);
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
  sfx.thud(d);
  cameraTrauma = Math.min(1, cameraTrauma + THREE.MathUtils.clamp(1 - d / 40, 0, 1) * 0.9);
  _vecA.set(p.x, 0.3, p.z);
  for (let i = 0; i < 4; i++) effects.impact(_vecA, Math.random() - 0.5, 1, Math.random() - 0.5, "dust", 14);
}

const KILL_VERB = { head: "HEADSHOT", blast: "BLOWN UP", fire: "BURNED", gun: "KILLED" };

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
  sfx,
  onExplode: onGrenadeExplode,
  onIgnite: (x, z, hitZombie, owner) => {
    if (net.isClient) return; // the host's copy of this throw does the damage
    // A direct hit drenches the zombie: it burns longer
    if (hitZombie) zombieManager?.ignite(hitZombie, BURN_TIME_DIRECT, owner ?? localTarget.id);
    zombieManager?.noise(x, z, MOLOTOV.alertRadius, "explosion");
  },
  onFireTick,
});

const minimap = new Minimap(document.getElementById("minimap"), {
  zombies: () => zombieManager?.active ?? [],
  pickups: () => pickups.active,
  fires: () => throwables.fires,
  obstacles: () => mapObstacles,
  players: () => remotePlayers.mapList(),
});

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

  const wFolder = gui.addFolder("🌗 Time & Weather");
  wFolder.close();
  wFolder.add(env, "hour", 0, 23.99, 0.01).name("Hour").listen();
  wFolder.add(env, "timeScale", 0, 20, 0.1).name("Time speed");
  wFolder.add(env, "bloodMoon").name("Blood moon").listen();
  const wx = { state: weather.state };
  wFolder.add(wx, "state", ["clear", "overcast", "drizzle", "rain", "storm"]).name("Weather").onChange(s => weather.set(s));
  wFolder.add(weather, "locked").name("Hold weather");

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
  const [autoGltf, wrlScene, houseKit, treeAGltf, treeBGltf] = await Promise.all([
    settle(loadGLB("/models/autorickshaw_3d_model_free.glb")),
    settle(vrmlLoader.loadAsync("/models/house.wrl")),
    gltfLoader.loadAsync("/models/house/house-kit.glb"),
    loadGLB("/trees/old_tree_with_vine_3d_model_free.glb"),
    loadGLB("/trees/dreftwood tree.glb"),
  ]);

  if (autoGltf) {
    createEditableModel({
      id: "autorickshaw",
      name: "🛺 Autorickshaw",
      object3D: autoGltf.scene,
      initialParams: { posX: -18, posY: 0, posZ: -18, rotY: 120, scale: 1.2 },
    });
  }
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
  houses.add(35, -35, THREE.MathUtils.degToRad(30));
  // One close to spawn with its door facing the start
  houses.add(-13, 20, Math.atan2(13, -20));

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

  const housePositions = scatterPositions(HOUSE_COUNT, rng, SCATTER_RADIUS_MIN + 6,  SCATTER_RADIUS_MAX, 22);
  for (const { x, z } of housePositions) {
    houses.add(x, z, rng() * Math.PI * 2);
  }
  mapObstacles.push(...houses.mapObstacles());

  // Big trees stay out of houses (a scattered tree used to land on one)
  const keepClear = (list, pad) => list.filter(({ x, z }) => !houses.blocks(x, z, pad));
  const treeAPositions = keepClear(scatterPositions(TREE_A_COUNT, rng, SCATTER_RADIUS_MIN, SCATTER_RADIUS_MAX * 0.6, 8), 5);
  const treeBPositions = keepClear(scatterPositions(TREE_B_COUNT, rng, SCATTER_RADIUS_MIN, SCATTER_RADIUS_MAX * 0.6, 7), 4);

  for (const { x, z } of treeAPositions) {
    const scale = rngRange(rng, treeAScaleMin, treeAScaleMax);
    const rotY  = rng() * Math.PI * 2;
    const snapY = treeASnapAtOne * scale;
    const clone = treeATemplate.clone(true);
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
    const snapY = treeBSnapAtOne * scale;
    const clone = treeBTemplate.clone(true);
    clone.position.set(x, snapY, z);
    clone.rotation.y = rotY;
    clone.scale.setScalar(scale);
    scene.add(clone);
    freezeStatic(clone);
    addTreeCollider(x, snapY, z, rotY, scale, 0.22, 4.0, 2.2, 5.0);
  }

  // Burning wrecks: the autorickshaw plus a few charred debris piles, each
  // pouring smoke (the first so the fires are kept clear of the forest)
  const fireSpots = [];
  const rick = editableModels.autorickshaw?.params;
  if (rick?.visible) fireSpots.push({ x: rick.posX, y: 0.6, z: rick.posZ, scale: 1 });
  for (const [x, z] of DEBRIS_SPOTS) {
    if (houses.blocks(x, z, 4) || nearObstacle(x, z, 3)) continue;
    fireSpots.push({ x, y: 0.15, z, scale: 0.75 });
    addDebrisPile(x, z);
  }
  atmosphere.setSources(fireSpots);

  // The dead forest, sized against the player
  plantDeadForest({
    scene, world, material: staticMaterial, rng: makeLCG(0x5eedf0e5),
    count: DEAD_TREE_COUNT, playerHeight: CHARACTER_HEIGHT, heightMul: DEAD_TREE_HEIGHT_MUL,
    ringMin: 14, ringMax: 175, mapObstacles,
    blocked: (x, z) => Math.hypot(x, z) < 12 || houses.blocks(x, z, 4) || nearObstacle(x, z, 3.5)
      || STARTER_LOOT.some(([, lx, lz]) => Math.hypot(lx - x, lz - z) < 3)
      || fireSpots.some(s => Math.hypot(s.x - x, s.z - z) < 5),
  });
}

const DEBRIS_SPOTS = [[26, 12], [-31, 9], [9, -47], [-5, 39], [48, 30]];

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
    mesh.setMatrixAt(i, m4.compose(_vecA.set(l.x, 0.12, l.z), q, _vecB.set(l.len, 1, 1)));
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

// What the monsters can target: you + every teammate
const localTarget = { id: 0, pos: characterBody.position, vel: characterBody.velocity, alive: true, vis: 1, local: true };
characterBody.playerTarget = localTarget;
const _allTargets = [];

function getTargets() {
  localTarget.alive = playerHealth > 0;
  localTarget.vis = playerVisibility();
  _allTargets.length = 0;
  _allTargets.push(localTarget);
  for (const t of remotePlayers.targets()) _allTargets.push(t);
  return _allTargets;
}

/** A monster hit a player: you take it directly, teammates get a message. */
function onPlayerHit(target, dmg, kx, kz, shake, sx, sz) {
  if (target.local) dealDamageToPlayer(dmg, kx, kz, shake, sx, sz);
  else net.send({ t: "hurt", to: target.id, d: +dmg.toFixed(1), kx: +kx.toFixed(2), kz: +kz.toFixed(2), sh: shake, sx: +sx.toFixed(2), sz: +sz.toFixed(2) });
}

/** Footsteps, gunfire, doors: the host's monsters hear everyone. */
function makeNoise(x, z, r, kind) {
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
  if (net.isHost) {
    // Catch the newcomer up on doors and lights
    net.send({
      t: "world", to: msg.p.id,
      doors: houses.houses.map(h => h.doorOpen),
      lights: houses.houses.map(h => h.lightOn),
    });
  }
});
net.on("left", msg => {
  const name = remotePlayers.players.get(msg.id)?.name ?? "A player";
  remotePlayers.remove(msg.id);
  inventoryUI.feed(`${name} left`, "info");
  updateSquadPlayerCount();
});
net.on("host", msg => { if (msg.id === net.id) becomeHost(); });
net.on("disconnect", () => {
  const wasClient = localTarget.id !== net.hostId;
  remotePlayers.clear();
  inventoryUI.feed("Disconnected from co-op: playing solo", "info");
  if (wasClient) becomeHost();
  updateSquadPlayerCount();
});

net.on("st", msg => remotePlayers.applyState(msg.from, msg));
net.on("shot", msg => remotePlayers.shot(msg.from, msg, characterBody.position));
net.on("hurt", msg => dealDamageToPlayer(msg.d, msg.kx, msg.kz, msg.sh, msg.sx, msg.sz));
net.on("throw", msg => {
  throwables.throw(msg.k, _vecA.set(msg.o[0], msg.o[1], msg.o[2]), _vecB.set(msg.v[0], msg.v[1], msg.v[2]), msg.from);
});
net.on("door", msg => { const h = houses.houses[msg.h]; if (h) houses.setDoor(h, msg.o); });
net.on("light", msg => { const h = houses.houses[msg.h]; if (h && h.lightOn !== msg.on) houses.toggleLight(h); });
net.on("world", msg => {
  msg.doors.forEach((o, i) => { if (houses.houses[i]) houses.setDoor(houses.houses[i], o); });
  msg.lights.forEach((on, i) => { const h = houses.houses[i]; if (h && h.lightOn !== on) houses.toggleLight(h); });
});
net.on("drop", msg => pickups.spawn(msg.k, msg.x, msg.z, pickupData(msg.k), msg.l));
net.on("kill", msg => {
  killsThisLife++;
  showHitMarker(false, true);
  sfx.kill();
  const m = monsterSync?.findPuppet(msg.n);
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
      vis: +playerVisibility().toFixed(2), k: killsThisLife,
    });
  }
  if (!net.isHost) return;

  netMonsterTimer -= delta;
  if (netMonsterTimer <= 0 && remotePlayers.count > 0) {
    netMonsterTimer = 1 / NET_MONSTER_HZ;
    net.send({ t: "mon", d: monsterSync.snapshot() });
  }
  netLevelTimer -= delta;
  if (netLevelTimer <= 0 && director?.level) {
    netLevelTimer = 1 / NET_LEVEL_HZ;
    net.send({ t: "lvl", n: director.level.n, s: director.state, k: director.killed, tot: director.total, tm: +director.timer.toFixed(1) });
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
  if (net.connected) {
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

// ─── Lobby ────────────────────────────────────────────────────────────────────
const lobby = new Lobby({
  onSolo(name) {
    myName = name;
    lobby.hide();
  },
  async onCoop(name, room) {
    myName = name;
    const welcome = await net.connect(Net.defaultUrl(), name, room);
    onConnected(welcome);
    lobby.hide();
  },
});

// ─── Main Loop ────────────────────────────────────────────────────────────────
let _animRunning = false;
const clock = new THREE.Clock();

function animate() {
  if (!_animRunning) return;
  requestAnimationFrame(animate);
  const rawDelta = clock.getDelta();
  const frameMs = rawDelta * 1000;
  const delta = Math.min(rawDelta, 0.05);

  updateCharacterMovement(delta);
  applyGroundStickForce(delta);

  world.step(1 / 60, delta, 3);

  checkGrounded();
  snapCharacterToGround();

  characterRoot.position.set(
    characterBody.position.x,
    characterBody.position.y - FEET_OFFSET,
    characterBody.position.z
  );

  houses?.update(delta, characterBody.position.x, characterBody.position.z);
  if (net.isClient) {
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

  updateThirdPersonCamera(delta);
  updateSoldier(delta);
  updateWeapon(delta);
  updateThrowAim(delta);
  throwables.update(delta);
  if (zombieManager) fireFX.syncBodies(zombieManager.active, characterBody.position.x, characterBody.position.z);
  fireFX.update(delta);
  effects.update(delta);
  updatePickups(delta);
  inventoryUI.update();

  timeSinceHit += delta;
  cameraTrauma = Math.max(0, cameraTrauma - delta * 1.6);
  updatePlayerHealthUI(delta);
  updateThreatUI();
  updatePlayerNoise(delta);
  updateLevelHud();
  gameHud.update(delta);
  updateCombatHUD(delta);

  minimap.update(performance.now(), characterBody.position.x, characterBody.position.z, aimYaw);

  updateMood(delta);
  updateGroundChunks(characterBody.position.x, characterBody.position.z);
  updateSunShadow();
  renderer.render(scene, camera);
  updateDynamicResolution(frameMs);
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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
  scene.traverse(o => { if (!o.visible) { hidden.push(o); o.visible = true; } });
  fireFX.setWarmup(true);
  const compile = () => (renderer.compileAsync ? renderer.compileAsync(scene, camera) : renderer.compile(scene, camera));
  await compile();
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
  renderer.render(scene, camera); // uploads textures + buffers, compiles shadow programs
  for (const [m, p] of staged) {
    m.root.position.copy(p);
    m.root.updateMatrixWorld(true);
  }
  for (const o of hidden) o.visible = false;
  fireFX.setWarmup(false);
}

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

    // Soldier, zombies and the world download + parse in parallel
    await Promise.all([
      loadCharacter(),
      zombieManager.init(),
      loadWorld(),
    ]);
    onWeaponChanged(false);

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
        gameHud.killFeed(zombie.def.label, KILL_VERB[zombie.killCause] ?? "KILLED", zombie.def.color, zombie.killCause === "head");
      } else net.send({ t: "kill", to: zombie.lastHitBy, n: zombie.netId });
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
    zombieManager.navigate = (zx, zz, tx, tz, out, big) => houses.navigate(zx, zz, tx, tz, out, big);
    zombieManager.canSpawnAt = (x, z) => !houses.blocks(x, z);
    zombieManager.onDoorBang = (x, z) => {
      sfx.doorBang(Math.hypot(x - characterBody.position.x, z - characterBody.position.z));
    };
    spawnWorldLoot();

    setLoadMsg("Preparing shaders…");
    updateThirdPersonCamera(1 / 60);
    await warmUpGpu();

    clock.getDelta();
    _animRunning = true;
    animate();

    setupGui();

    window.zombieManager = zombieManager;
    window.inventory = inventory;
    window.env = env;
    window.weather = weather;
    deathScreenEl?.addEventListener("click", respawnPlayer);

    lobby.show();
    loadingScreen.classList.add("hidden");
    loadingScreen.addEventListener("transitionend", () => loadingScreen.remove(), { once: true });
  } catch (err) {
    console.error("Boot failure:", err);
    setLoadMsg("Failed to load. Check the console.");
  }
}

boot();
