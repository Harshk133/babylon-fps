import "./style.css";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import GUI from "lil-gui";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLLoader } from "three/addons/loaders/VRMLLoader.js";
import { ZombieManager } from "./zombies/ZombieManager.js";
import { Soldier } from "./player/Soldier.js";
import { Effects } from "./combat/Effects.js";
import { Sfx } from "./combat/Sfx.js";
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
const TREE_A_COUNT       = 2;
const TREE_B_COUNT       = 1;
const HOUSE_SCALE        = 7.8;

const TREE_A_HEIGHT_MIN  = 10;
const TREE_A_HEIGHT_MAX  = 16;
const TREE_B_HEIGHT_MIN  = 8;
const TREE_B_HEIGHT_MAX  = 13;

const SCATTER_RADIUS_MIN = 18;
const SCATTER_RADIUS_MAX = 200;

// ─── Monster Settings ─────────────────────────────────────────────────────────
const MONSTER_HEIGHT_MULTIPLIER = 1.35; // Proportional relative to character (~2.43m)
const MONSTER_TARGET_HEIGHT     = CHARACTER_HEIGHT * MONSTER_HEIGHT_MULTIPLIER;
const MONSTER_MASS             = 120;
const ZOMBIE_PREWARM_COUNT     = 100;
const ZOMBIE_INITIAL_SPAWN     = 24;
const MONSTER_LIN_DAMPING      = 0.05; // Low damping so movement is fluid
const MONSTER_ANG_DAMPING      = 1.0;

// ─── Weapon (SMG) ─────────────────────────────────────────────────────────────
const WEAPON = {
  fireRate: 11,            // rounds per second
  magSize: 32,
  reloadTime: 1.7,
  damage: 25,              // zombies have 100 HP → 4 body shots
  headshotMultiplier: 4,   // headshots one-tap
  headHeight: 0.5,         // top N metres of a zombie count as head
  range: 150,
  spreadHip: 0.02,
  spreadAim: 0.003,
  spreadMove: 0.02,
  spreadAir: 0.04,
  bloomPerShot: 0.004,
  bloomMax: 0.03,
  bloomRecovery: 0.12,
  recoilPitch: 0.012,
  recoilYaw: 0.004,
  push: 1.2,               // shove applied to the zombie per hit
  alertRadius: 38,         // gunfire wakes zombies within this range
};

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

function dealDamageToPlayer(amount, knockX = 0, knockZ = 0) {
  if (playerHealth <= 0) return;
  playerHealth = Math.max(0, playerHealth - amount);
  sfx.hurt();
  timeSinceHit = 0;
  damageFlash  = Math.min(1, damageFlash + 0.7);
  cameraTrauma = Math.min(1, cameraTrauma + 0.45);
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
  if (deathKillsEl) deathKillsEl.textContent = `${killsThisLife}`;
  if (deathScreenEl) deathScreenEl.classList.add("visible");
  if (document.pointerLockElement) document.exitPointerLock();
}

function respawnPlayer() {
  playerHealth = MAX_HEALTH;
  healthTrail  = MAX_HEALTH;
  timeSinceHit = 99;
  knockbackVel.set(0, 0, 0);
  characterBody.position.set(0, FEET_OFFSET + 0.02, 0);
  characterBody.velocity.set(0, 0, 0);
  moveVelocity.set(0, 0, 0);
  camPivot.set(0, cameraRig.pivotHeight, 0);
  weapon.ammo = WEAPON.magSize;
  weapon.reloading = false;
  killsThisLife = 0;
  soldier.revive();
  for (const z of zombieManager?.active ?? []) { z.isChasing = false; z.isAttacker = false; }
  if (deathScreenEl) deathScreenEl.classList.remove("visible");
  canvas.requestPointerLock();
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

const hud = {
  paused: true,
  gap: -1, ammo: -1, reload: -1, kills: -1, low: null,
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

  if (weapon.ammo !== hud.ammo) {
    hud.ammo = weapon.ammo;
    if (ammoCountEl) ammoCountEl.textContent = `${weapon.ammo}`;
    const low = weapon.ammo <= WEAPON.magSize * 0.25;
    if (low !== hud.low) {
      hud.low = low;
      ammoCardEl?.classList.toggle("low", low);
    }
  }

  const reload = weapon.reloading ? Math.round((1 - weapon.reloadTimer / WEAPON.reloadTime) * 50) / 50 : -1;
  if (reload !== hud.reload) {
    hud.reload = reload;
    ammoCardEl?.classList.toggle("reloading", reload >= 0);
    if (reloadBarEl) reloadBarEl.style.transform = `scaleX(${Math.max(0, reload)})`;
  }

  if (killsThisLife !== hud.kills) {
    hud.kills = killsThisLife;
    if (killsEl) killsEl.textContent = `${killsThisLife}`;
  }

  const showStart = hud.paused && playerHealth > 0;
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
const FOG_COLOR = 0xb08468;

const scene = new THREE.Scene();
scene.background = makeSkyTexture();
scene.fog = new THREE.Fog(FOG_COLOR, 35, 190);

// Dusk gradient mapped as an equirect background so the horizon tracks the view
function makeSkyTexture() {
  const c = document.createElement("canvas");
  c.width = 4; c.height = 512;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0.0,  "#1f2b44");
  grad.addColorStop(0.3,  "#5d5a72");
  grad.addColorStop(0.46, "#d99a68");
  grad.addColorStop(0.5,  "#b08468");
  grad.addColorStop(0.56, "#3a2e2a");
  grad.addColorStop(1.0,  "#2a221f");
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.5, 220);

const canvas = document.getElementById("webgl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance", logarithmicDepthBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
world.addContactMaterial(new CANNON.ContactMaterial(staticMaterial, monsterMaterial, {
  friction: 0.2, restitution: 0,
  contactEquationStiffness: 1e7, contactEquationRelaxation: 3,
}));

// ─── Collider Helpers ─────────────────────────────────────────────────────────
function addTreeCollider(x, y, z, rotY, scale, trunkR, trunkH, crownR, crownY) {
  const body = new CANNON.Body({ mass: 0, material: staticMaterial });
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.01;
  body.sleepTimeLimit  = 0.1;

  const q = new CANNON.Quaternion();
  q.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI / 2);
  const trunk = new CANNON.Cylinder(trunkR * scale, trunkR * scale, trunkH * scale, 8);
  body.addShape(trunk, new CANNON.Vec3(0, (trunkH * scale) / 2, 0), q);

  const canopy = new CANNON.Sphere(crownR * scale);
  body.addShape(canopy, new CANNON.Vec3(0, crownY * scale, 0));

  body.position.set(x, y, z);
  body.quaternion.setFromEuler(0, rotY, 0);
  world.addBody(body);
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
}

function addCapsuleToBody(body, radius, height) {
  const hh = height / 2;
  const q = new CANNON.Quaternion();
  q.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI / 2); // Orient Z-axis cylinder to vertical Y-axis

  body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, -hh, 0));
  body.addShape(new CANNON.Cylinder(radius, radius, height, 12), new CANNON.Vec3(0, 0, 0), q);
  body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0,  hh, 0));
}

// ─── Ground ───────────────────────────────────────────────────────────────────
const textureLoader = new THREE.TextureLoader();
const grassTexture  = textureLoader.load("/texture/grass2.jpg");
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
scene.add(new THREE.HemisphereLight(0x9fb4d8, 0x4a3a2c, 0.9));
scene.add(new THREE.AmbientLight(0xffe2c8, 0.25));
const sun = new THREE.DirectionalLight(0xffc48a, 2.4);
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

function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ─── Input ────────────────────────────────────────────────────────────────────
const input = { fire: false, aim: false, firePressed: false };
const isLocked = () => document.pointerLockElement === canvas;

function setKey(code, pressed) {
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
    case "KeyR": if (pressed) startReload(); break;
  }
}
window.addEventListener("keydown", e => setKey(e.code, true));
window.addEventListener("keyup",   e => setKey(e.code, false));
canvas.addEventListener("click", () => {
  sfx.unlock();
  if (playerHealth > 0) canvas.requestPointerLock();
});
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
  if (alive) {
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

  if (jumpQueued && onGround && alive) {
    characterBody.velocity.y = JUMP_VELOCITY;
    onGround = false;
  }
  jumpQueued = false;

  // Facing: lock to the camera while moving or using the gun; when standing
  // still, only turn in place once the camera swings well past the shoulder.
  if (!alive) return;
  const engaged = movingInput || input.aim || input.fire || timeSinceShot < 0.6;
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
  sunTarget.position.set(fx, 0, fz);
  sun.position.set(fx + 30, 22, fz + 18); // low evening sun → longer shadows
  sun.shadow.camera.updateProjectionMatrix();
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
const weapon = { ammo: WEAPON.magSize, cooldown: 0, reloading: false, reloadTimer: 0, bloom: 0 };
let timeSinceShot = 99;
let killsThisLife = 0;

const _shotDir    = new THREE.Vector3();
const _muzzle     = new THREE.Vector3();
const _hitPoint   = new THREE.Vector3();
const _shotFrom   = new CANNON.Vec3();
const _shotTo     = new CANNON.Vec3();
const _shotResult = new CANNON.RaycastResult();
const shotOpts    = { collisionFilterMask: GROUP_WORLD | GROUP_ZOMBIE, skipBackfaces: true };

function startReload() {
  if (weapon.reloading || weapon.ammo === WEAPON.magSize || playerHealth <= 0) return;
  weapon.reloading = true;
  weapon.reloadTimer = WEAPON.reloadTime;
  sfx.reload(WEAPON.reloadTime);
}

function currentSpread() {
  const hSpeed = Math.hypot(characterBody.velocity.x, characterBody.velocity.z);
  const moving = THREE.MathUtils.clamp(hSpeed / JOG_SPEED, 0, 1);
  return THREE.MathUtils.lerp(WEAPON.spreadHip, WEAPON.spreadAim, aimBlend)
    + WEAPON.spreadMove * moving * (1 - aimBlend * 0.6)
    + (onGround ? 0 : WEAPON.spreadAir)
    + weapon.bloom;
}

function updateWeapon(delta) {
  weapon.cooldown = Math.max(0, weapon.cooldown - delta);
  weapon.bloom = Math.max(0, weapon.bloom - delta * WEAPON.bloomRecovery);
  timeSinceShot += delta;

  if (weapon.reloading) {
    weapon.reloadTimer -= delta;
    if (weapon.reloadTimer <= 0) {
      weapon.reloading = false;
      weapon.ammo = WEAPON.magSize;
    }
  }

  const pressed = input.firePressed;
  input.firePressed = false;
  if (!input.fire || playerHealth <= 0 || !isLocked() || sprinting || weapon.reloading) return;

  if (weapon.ammo <= 0) {
    if (pressed) sfx.click();
    startReload();
    return;
  }
  // Wait for the gun to come up so the first tracer leaves the barrel, not the hip
  if (soldier.aimWeight < 0.55 || weapon.cooldown > 0) return;

  fireShot();
  weapon.cooldown = 1 / WEAPON.fireRate;
}

function fireShot() {
  weapon.ammo--;
  timeSinceShot = 0;

  const spread = currentSpread();
  weapon.bloom = Math.min(WEAPON.bloomMax, weapon.bloom + WEAPON.bloomPerShot);

  camera.getWorldDirection(_shotDir);
  _shotDir.x += (Math.random() - 0.5) * 2 * spread;
  _shotDir.y += (Math.random() - 0.5) * 2 * spread;
  _shotDir.z += (Math.random() - 0.5) * 2 * spread;
  _shotDir.normalize();

  // Start the trace level with the player so nothing between camera and player gets hit
  const startT = Math.max(0,
    (camPivot.x - camera.position.x) * _shotDir.x +
    (camPivot.y - camera.position.y) * _shotDir.y +
    (camPivot.z - camera.position.z) * _shotDir.z);
  _shotFrom.set(
    camera.position.x + _shotDir.x * startT,
    camera.position.y + _shotDir.y * startT,
    camera.position.z + _shotDir.z * startT);
  _shotTo.set(
    _shotFrom.x + _shotDir.x * WEAPON.range,
    _shotFrom.y + _shotDir.y * WEAPON.range,
    _shotFrom.z + _shotDir.z * WEAPON.range);

  const hit = world.raycastClosest(_shotFrom, _shotTo, shotOpts, _shotResult);
  if (hit) _hitPoint.copy(_shotResult.hitPointWorld);
  else _hitPoint.set(_shotTo.x, _shotTo.y, _shotTo.z);

  soldier.getMuzzleWorldPosition(_muzzle);
  effects.muzzleFlash(_muzzle);
  effects.tracer(_muzzle, _hitPoint);
  sfx.gunshot();

  if (hit) {
    const zombie = _shotResult.body.zombie;
    if (zombie && zombieManager) {
      const headshot = _hitPoint.y > MONSTER_TARGET_HEIGHT - WEAPON.headHeight;
      const damage = WEAPON.damage * (headshot ? WEAPON.headshotMultiplier : 1);
      const killed = zombieManager.damage(zombie, damage, _shotDir.x * WEAPON.push, _shotDir.z * WEAPON.push);
      effects.impact(_hitPoint, -_shotDir.x, 0.3, -_shotDir.z, "blood", headshot ? 22 : 10);
      showHitMarker(headshot, killed);
      sfx.hit(headshot);
      if (killed) sfx.kill();
    } else {
      const n = _shotResult.hitNormalWorld;
      effects.impact(_hitPoint, n.x, n.y, n.z, "dust", 7);
    }
  }

  // Recoil: kick that recovers, plus a little permanent climb to manage
  const kick = WEAPON.recoilPitch * (1 - aimBlend * 0.45);
  recoilPitch += kick;
  recoilYaw   += (Math.random() - 0.5) * 2 * WEAPON.recoilYaw;
  aimPitch     = Math.min(cameraRig.pitchMax, aimPitch + kick * 0.25);
  cameraTrauma = Math.min(1, cameraTrauma + 0.05);

  zombieManager?.alert(characterBody.position.x, characterBody.position.z, WEAPON.alertRadius);
}

// ─── Model Registry & Lil-GUI Controls ────────────────────────────────────────
const editableModels = {};

function createEditableModel({ id, name, object3D, initialParams, customUpdate = null }) {
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

  // Static Cannon box body
  const body = new CANNON.Body({ mass: 0, material: staticMaterial });
  const halfX = Math.max(0.2, (size.x || 1) / 2);
  const halfY = Math.max(0.2, (size.y || 1) / 2);
  const halfZ = Math.max(0.2, (size.z || 1) / 2);
  const shape = new CANNON.Box(new CANNON.Vec3(halfX, halfY, halfZ));
  body.addShape(shape, new CANNON.Vec3(0, halfY, 0));
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
    } else {
      const curSX = Math.max(0.1, halfX * params.scale);
      const curSY = Math.max(0.1, halfY * params.scale);
      const curSZ = Math.max(0.1, halfZ * params.scale);

      body.position.set(params.posX, params.posY + curSY, params.posZ);
      body.quaternion.setFromEuler(0, THREE.MathUtils.degToRad(params.rotY), 0);
      if (body.shapes[0]) {
        body.shapes[0].halfExtents.set(curSX, curSY, curSZ);
        body.shapes[0].updateBoundingSphereRadius();
        body.updateBoundingRadius();
      }
    }
  }

  updateTransform();

  const record = { id, name, root, body, params, updateTransform, size };
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

  if (zombieManager) {
    const zFolder = gui.addFolder("👹 Zombie AI (Global)");
    zFolder.close();
    zFolder.add(zombieManager.settings, "enableAI").name("🤖 Enable AI Behavior");
    zFolder.add(zombieManager.settings, "detectionRadius", 1, 30, 0.5).name("🟡 Aggro Radius");
    zFolder.add(zombieManager.settings, "deaggroRadius", 3, 50, 0.5).name("🔵 Deaggro Radius");
    zFolder.add(zombieManager.settings, "chaseSpeed", 0.5, 10, 0.5).name("⚡ Chase Speed (m/s)");
    zFolder.add(zombieManager.settings, "attackSpeed", 0.5, 10, 0.5).name("⚔️ Attack Speed (m/s)");
    zFolder.add(zombieManager.settings, "maxHealth", 10, 500, 10).name("❤️ Max Health");
  }

  // Prevent pointer lock while interacting with lil-gui
  gui.domElement.addEventListener("mousedown", e => e.stopPropagation());
  gui.domElement.addEventListener("click", e => e.stopPropagation());
}

// ─── Zombie Manager (Pooled MD2 Instances) ────────────────────────────────────
let zombieManager = null;

// ─── Character GLTF Load ──────────────────────────────────────────────────────
async function loadCharacter() {
  await soldier.load(new GLTFLoader());
}

// ─── World Assets Load ────────────────────────────────────────────────────────
let _houseRawSize = null;

function placeHouse(template, x, z, rotY) {
  const clone = template.clone(true);
  clone.position.set(x, 0, z);
  clone.rotation.y = rotY;
  clone.scale.setScalar(HOUSE_SCALE);
  scene.add(clone);

  clone.updateWorldMatrix(true, false);
  const bounds  = new THREE.Box3().setFromObject(clone);
  const groundY = -bounds.min.y;
  clone.position.y = groundY;

  const s = _houseRawSize;
  addBoxCollider(x, groundY, z, rotY, HOUSE_SCALE, s.x, s.y, s.z, s.y / 2);
}

async function loadWorld() {
  const gltfLoader = new GLTFLoader();
  const vrmlLoader = new VRMLLoader();

  // 1. Load Gold Dragon GLB
  try {
    const dragonGltf = await gltfLoader.loadAsync("/models/dragon_gold.glb");
    createEditableModel({
      id: "dragon",
      name: "🐉 Gold Dragon",
      object3D: dragonGltf.scene,
      initialParams: { posX: 20, posY: 0, posZ: -20, rotY: 45, scale: 1.5 },
    });
  } catch (err) {
    console.warn("Could not load dragon_gold.glb:", err);
  }

  // 2. Load Autorickshaw GLB
  try {
    const autoGltf = await gltfLoader.loadAsync("/models/autorickshaw_3d_model_free.glb");
    createEditableModel({
      id: "autorickshaw",
      name: "🛺 Autorickshaw",
      object3D: autoGltf.scene,
      initialParams: { posX: -18, posY: 0, posZ: -18, rotY: 120, scale: 1.2 },
    });
  } catch (err) {
    console.warn("Could not load autorickshaw_3d_model_free.glb:", err);
  }

  // 3. Load WRL House
  try {
    const wrlScene = await vrmlLoader.loadAsync("/models/house.wrl");
    createEditableModel({
      id: "wrlHouse",
      name: "🏠 WRL House",
      object3D: wrlScene,
      initialParams: { posX: -35, posY: 0, posZ: -35, rotY: 0, scale: 1.0 },
    });
  } catch (err) {
    console.warn("Could not load house.wrl:", err);
  }

  // 4. Load Wooden House & Trees (Scatter Templates)
  const [houseGltf, treeAGltf, treeBGltf] = await Promise.all([
    gltfLoader.loadAsync("/models/rusty_roof_wooden_house_1_3d_model_free.glb"),
    gltfLoader.loadAsync("/trees/old_tree_with_vine_3d_model_free.glb"),
    gltfLoader.loadAsync("/trees/dreftwood tree.glb"),
  ]);

  // Create editable primary instances for tweaking
  createEditableModel({
    id: "woodenHouse",
    name: "🏡 Wooden House Primary",
    object3D: houseGltf.scene.clone(true),
    initialParams: { posX: 35, posY: 0, posZ: -35, rotY: 30, scale: HOUSE_SCALE },
  });

  createEditableModel({
    id: "treeA",
    name: "🌳 Old Tree (Vine)",
    object3D: treeAGltf.scene.clone(true),
    initialParams: { posX: -12, posY: 0, posZ: -30, rotY: 0, scale: 2.0 },
  });

  createEditableModel({
    id: "treeB",
    name: "🪵 Driftwood Tree",
    object3D: treeBGltf.scene.clone(true),
    initialParams: { posX: 14, posY: 0, posZ: -32, rotY: 90, scale: 2.0 },
  });

  // Enable shadows on templates
  [houseGltf.scene, treeAGltf.scene, treeBGltf.scene].forEach(root => {
    root.traverse(child => {
      if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
    });
  });

  const houseTemplate = houseGltf.scene;
  const treeATemplate = treeAGltf.scene;
  const treeBTemplate = treeBGltf.scene;

  houseTemplate.scale.setScalar(1);
  houseTemplate.updateWorldMatrix(true, false);
  const houseRawBounds = new THREE.Box3().setFromObject(houseTemplate);
  _houseRawSize = new THREE.Vector3();
  houseRawBounds.getSize(_houseRawSize);

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

  const treeAScaleMin = TREE_A_HEIGHT_MIN / treeARawH;
  const treeAScaleMax = TREE_A_HEIGHT_MAX / treeARawH;
  const treeBScaleMin = TREE_B_HEIGHT_MIN / treeBRawH;
  const treeBScaleMax = TREE_B_HEIGHT_MAX / treeBRawH;

  const housePositions = scatterPositions(HOUSE_COUNT, rng, SCATTER_RADIUS_MIN + 6,  SCATTER_RADIUS_MAX, 22);
  const treeAPositions = scatterPositions(TREE_A_COUNT, rng, SCATTER_RADIUS_MIN,      SCATTER_RADIUS_MAX, 6);
  const treeBPositions = scatterPositions(TREE_B_COUNT, rng, SCATTER_RADIUS_MIN,      SCATTER_RADIUS_MAX, 5);

  for (const { x, z } of housePositions) {
    placeHouse(houseTemplate, x, z, rng() * Math.PI * 2);
  }

  for (const { x, z } of treeAPositions) {
    const scale = rngRange(rng, treeAScaleMin, treeAScaleMax);
    const rotY  = rng() * Math.PI * 2;
    const snapY = treeASnapAtOne * scale;
    const clone = treeATemplate.clone(true);
    clone.position.set(x, snapY, z);
    clone.rotation.y = rotY;
    clone.scale.setScalar(scale);
    scene.add(clone);
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
    addTreeCollider(x, snapY, z, rotY, scale, 0.22, 4.0, 2.2, 5.0);
  }
}

// ─── Main Loop ────────────────────────────────────────────────────────────────
let _animRunning = false;
const clock = new THREE.Clock();

function animate() {
  if (!_animRunning) return;
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);

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

  if (zombieManager) zombieManager.update(delta);

  updateThirdPersonCamera(delta);
  updateSoldier(delta);
  updateWeapon(delta);
  effects.update(delta);

  timeSinceHit += delta;
  cameraTrauma = Math.max(0, cameraTrauma - delta * 1.6);
  updatePlayerHealthUI(delta);
  updateThreatUI();
  updateCombatHUD(delta);

  updateGroundChunks(characterBody.position.x, characterBody.position.z);
  updateSunShadow();
  renderer.render(scene, camera);
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

async function boot() {
  try {
    setLoadMsg("Loading soldier…");
    await loadCharacter();

    setLoadMsg("Loading zombies…");
    zombieManager = new ZombieManager({
      scene,
      world,
      monsterMaterial,
      targetHeight: MONSTER_TARGET_HEIGHT,
      mass: MONSTER_MASS,
      linDamping: MONSTER_LIN_DAMPING,
      angDamping: MONSTER_ANG_DAMPING,
      playerRadius: CHARACTER_RADIUS,
      getPlayerBody: () => characterBody,
      canAttackPlayer: () => playerHealth > 0,
      dealDamageToPlayer,
      regenPlayerHealth,
    });
    await zombieManager.init(ZOMBIE_PREWARM_COUNT);
    zombieManager.onKill = () => { killsThisLife++; };
    zombieManager.spawnRing(ZOMBIE_INITIAL_SPAWN, 0, 0, 26, 45);

    setLoadMsg("Loading world & 3D models…");
    await loadWorld();

    setLoadMsg("Starting scene…");
    clock.getDelta();
    _animRunning = true;
    animate();

    setupGui();

    window.zombieManager = zombieManager;
    deathScreenEl?.addEventListener("click", respawnPlayer);

    loadingScreen.classList.add("hidden");
    loadingScreen.addEventListener("transitionend", () => loadingScreen.remove(), { once: true });
  } catch (err) {
    console.error("Boot failure:", err);
    setLoadMsg("Failed to load. Check the console.");
  }
}

boot();
