import "./style.css";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import GUI from "lil-gui";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLLoader } from "three/addons/loaders/VRMLLoader.js";
import { ZombieManager } from "./zombies/ZombieManager.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const WALK_SPEED          = 20;
const RUN_SPEED           = 40;
const JUMP_VELOCITY       = 5.5;
const MOUSE_SENSITIVITY   = 0.002;
const CHARACTER_HEIGHT    = 1.8;
const CHARACTER_RADIUS    = 0.35;
const CAPSULE_HEIGHT      = CHARACTER_HEIGHT - CHARACTER_RADIUS * 2;
const CAPSULE_HALF_HEIGHT = CAPSULE_HEIGHT / 2;
const FEET_OFFSET         = CAPSULE_HALF_HEIGHT + CHARACTER_RADIUS;
const GROUND_SNAP_DISTANCE = 0.08;
const MOVE_ACCEL          = 55;
const MOVE_DECEL          = 70;
const ROTATION_SPEED      = 14;
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
const ZOMBIE_INITIAL_SPAWN     = 50;
const MONSTER_LIN_DAMPING      = 0.05; // Low damping so movement is fluid
const MONSTER_ANG_DAMPING      = 1.0;
const MONSTER_DEFAULT_CHASE_SPEED = 4.5; // Slow, natural creepy zombie march speed (m/s)

// ─── Player Health System ─────────────────────────────────────────────────────
let playerHealth     = 100;
const MAX_HEALTH     = 100;
const damageOverlayEl = document.getElementById("damage-overlay");
const healthFillEl    = document.getElementById("health-bar-fill");
const healthValEl     = document.getElementById("health-val");

function updatePlayerHealthUI() {
  const pct = Math.max(0, Math.min(100, playerHealth));
  if (healthFillEl) healthFillEl.style.width = `${pct}%`;
  if (healthValEl)  healthValEl.textContent = `${Math.ceil(pct)} / 100`;
}

function dealDamageToPlayer(amount) {
  playerHealth = Math.max(0, playerHealth - amount);
  updatePlayerHealthUI();

  if (damageOverlayEl) {
    damageOverlayEl.style.opacity = "1";
    setTimeout(() => {
      if (damageOverlayEl) damageOverlayEl.style.opacity = "0";
    }, 120);
  }
}

function regenPlayerHealth(amount) {
  if (playerHealth < MAX_HEALTH) {
    playerHealth = Math.min(MAX_HEALTH, playerHealth + amount);
    updatePlayerHealthUI();
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
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 60, 200);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.5, 220);

const canvas = document.getElementById("webgl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance", logarithmicDepthBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = true;

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

const contactDefaults = {
  friction: 0.85, restitution: 0,
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
world.addContactMaterial(new CANNON.ContactMaterial(characterMaterial, monsterMaterial, {
  friction: 0.2, restitution: 0,
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
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xfff2d6, 1.1);
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
});
addCapsuleToBody(characterBody, CHARACTER_RADIUS, CAPSULE_HEIGHT);
characterBody.position.set(0, FEET_OFFSET + 0.02, 0);
world.addBody(characterBody);

// ─── Camera ───────────────────────────────────────────────────────────────────
const cameraPivot  = new THREE.Vector3();
const cameraTarget = new THREE.Vector3();
const cameraRight  = new THREE.Vector3();
let cameraYaw   = Math.PI;
let cameraPitch = 0.25;
let onGround    = false;
let jumpQueued  = false;

const cameraRig = {
  distance: 2.7, offsetX: -0.15, offsetY: 0.18,
  lookAtY: 0.86, smooth: 1.0, fov: 58,
  pitchMin: -0.35, pitchMax: 1.1,
};

// ─── Movement Helpers ─────────────────────────────────────────────────────────
const movement                  = new THREE.Vector3();
const forward                   = new THREE.Vector3();
const right                     = new THREE.Vector3();
const desiredVelocity           = new THREE.Vector3();
const currentHorizontalVelocity = new CANNON.Vec3();
const groundContactNormal       = new CANNON.Vec3(0, 1, 0);
const rayOrigin                 = new CANNON.Vec3();
const rayTo                     = new CANNON.Vec3();
const rayResult                 = new CANNON.RaycastResult();

// ─── Animation ────────────────────────────────────────────────────────────────
let mixer      = null;
let jumpActive = false;
const actions      = {};
const animWeights  = { idle: 1, walk: 0, run: 0 };
const LOCOMOTION_CLIPS    = ["idle", "walk", "run"];
const ANIM_BLEND_SPEED    = 7.5;
const WALK_RUN_BLEND_SPEED = 5.5;

// ─── Input ────────────────────────────────────────────────────────────────────
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
  }
}
window.addEventListener("keydown", e => setKey(e.code, true));
window.addEventListener("keyup",   e => setKey(e.code, false));
canvas.addEventListener("click",   () => canvas.requestPointerLock());
document.addEventListener("mousemove", e => {
  if (document.pointerLockElement !== canvas) return;
  cameraYaw   -= e.movementX * MOUSE_SENSITIVITY;
  cameraPitch -= e.movementY * MOUSE_SENSITIVITY;
  cameraPitch  = THREE.MathUtils.clamp(cameraPitch, cameraRig.pitchMin, cameraRig.pitchMax);
});

// ─── Animation Helpers ────────────────────────────────────────────────────────
function isMovingInput() { return keys.forward || keys.backward || keys.left || keys.right; }

function setActionWeight(action, weight) {
  if (!action) return;
  const w = THREE.MathUtils.clamp(weight, 0, 1);
  action.enabled = true;
  action.setEffectiveWeight(w);
  if (w > 0.001) action.play();
}

function updateCharacterAnimation(delta) {
  if (!mixer || !actions.idle) return;
  const hSpeed     = Math.hypot(characterBody.velocity.x, characterBody.velocity.z);
  const movingInput = isMovingInput();

  if (onGround) jumpActive = false;

  if (jumpActive && actions.jump && !onGround) {
    setActionWeight(actions.jump, 1);
    setActionWeight(actions.idle, 0);
    setActionWeight(actions.walk, 0);
    setActionWeight(actions.run,  0);
    return;
  }
  if (actions.jump) setActionWeight(actions.jump, 0);

  let tIdle = 0, tWalk = 0, tRun = 0;
  if (!movingInput)  tIdle = 1;
  else if (keys.run) tRun  = 1;
  else               tWalk = 1;

  const ib = 1 - Math.exp(-ANIM_BLEND_SPEED     * delta);
  const gb = 1 - Math.exp(-WALK_RUN_BLEND_SPEED * delta);
  animWeights.idle = THREE.MathUtils.lerp(animWeights.idle, tIdle, ib);
  animWeights.walk = THREE.MathUtils.lerp(animWeights.walk, tWalk, gb);
  animWeights.run  = THREE.MathUtils.lerp(animWeights.run,  tRun,  gb);

  const sum    = animWeights.idle + animWeights.walk + animWeights.run || 1;
  const iW     = animWeights.idle / sum;
  const wW     = animWeights.walk / sum;
  const rW     = animWeights.run  / sum;

  setActionWeight(actions.idle, iW);
  setActionWeight(actions.walk, wW);
  setActionWeight(actions.run,  rW);

  if (actions.walk && actions.run && wW > 0.05 && rW > 0.05) {
    const wc = actions.walk.getClip(), rc = actions.run.getClip();
    if (wc.duration > 0 && rc.duration > 0)
      actions.run.time = ((actions.walk.time / wc.duration) * rc.duration) % rc.duration;
  }
  if (actions.walk && wW > 0.05)
    actions.walk.setEffectiveTimeScale(THREE.MathUtils.clamp(hSpeed / WALK_SPEED, 0.85, 1.25));
  if (actions.run  && rW > 0.05)
    actions.run.setEffectiveTimeScale (THREE.MathUtils.clamp(hSpeed / RUN_SPEED,  0.85, 1.25));
}

// ─── Ground Check ─────────────────────────────────────────────────────────────
function checkGrounded() {
  onGround = false;
  rayOrigin.set(characterBody.position.x, characterBody.position.y + 0.05,          characterBody.position.z);
  rayTo    .set(characterBody.position.x, characterBody.position.y - FEET_OFFSET - 0.45, characterBody.position.z);
  const hit = world.raycastClosest(rayOrigin, rayTo, { skipBackfaces: true }, rayResult);
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
  characterBody.applyForce(new CANNON.Vec3(
    -groundContactNormal.x * f, -groundContactNormal.y * f, -groundContactNormal.z * f
  ));
}

function snapCharacterToGround() {
  if (!onGround) return;
  rayOrigin.set(characterBody.position.x, characterBody.position.y + 0.05,          characterBody.position.z);
  rayTo    .set(characterBody.position.x, characterBody.position.y - FEET_OFFSET - 0.45, characterBody.position.z);
  if (world.raycastClosest(rayOrigin, rayTo, { skipBackfaces: true }, rayResult)) {
    const d = rayResult.distance - FEET_OFFSET;
    if (Math.abs(d) < GROUND_SNAP_DISTANCE) characterBody.position.y -= d;
  }
  if (characterBody.velocity.y < 0) characterBody.velocity.y = 0;
}

// ─── Movement ─────────────────────────────────────────────────────────────────
const _targetVelocity = new CANNON.Vec3();

function updateCharacterMovement(delta) {
  forward.set(Math.sin(cameraYaw), 0, Math.cos(cameraYaw)).normalize();
  right.set(forward.z, 0, -forward.x).normalize();

  movement.set(0, 0, 0);
  if (keys.forward)  movement.add(forward);
  if (keys.backward) movement.sub(forward);
  if (keys.left)     movement.sub(right);
  if (keys.right)    movement.add(right);

  const movingInput = movement.lengthSq() > 0.001;
  if (movingInput) movement.normalize();

  const speed = keys.run ? RUN_SPEED : WALK_SPEED;
  desiredVelocity.copy(movement).multiplyScalar(speed);

  currentHorizontalVelocity.set(characterBody.velocity.x, 0, characterBody.velocity.z);
  _targetVelocity.set(desiredVelocity.x, 0, desiredVelocity.z);

  const blend = 1 - Math.exp(-(movingInput ? MOVE_ACCEL : MOVE_DECEL) * delta);
  currentHorizontalVelocity.x += (_targetVelocity.x - currentHorizontalVelocity.x) * blend;
  currentHorizontalVelocity.z += (_targetVelocity.z - currentHorizontalVelocity.z) * blend;
  if (!movingInput && currentHorizontalVelocity.lengthSquared() < 0.04)
    currentHorizontalVelocity.set(0, 0, 0);

  characterBody.velocity.x = currentHorizontalVelocity.x;
  characterBody.velocity.z = currentHorizontalVelocity.z;

  if (jumpQueued && onGround) {
    characterBody.velocity.y = JUMP_VELOCITY;
    onGround   = false;
    jumpActive = true;
    if (actions.jump) {
      actions.jump.reset();
      actions.jump.setLoop(THREE.LoopOnce, 1);
      actions.jump.clampWhenFinished = true;
      actions.jump.enabled = true;
      actions.jump.setEffectiveWeight(1);
      actions.jump.play();
    }
  }
  jumpQueued = false;

  if (movingInput) {
    const tRot    = Math.atan2(movement.x, movement.z);
    const tBlend  = 1 - Math.exp(-ROTATION_SPEED * delta);
    characterRoot.rotation.y = THREE.MathUtils.lerp(characterRoot.rotation.y, tRot, tBlend);
  }
}

// ─── Shadow / Camera ──────────────────────────────────────────────────────────
function updateSunShadow() {
  const fx = characterBody.position.x, fz = characterBody.position.z;
  sunTarget.position.set(fx, 0, fz);
  sun.position.set(fx + 24, 34, fz + 16);
  sun.shadow.camera.updateProjectionMatrix();
}

function updateThirdPersonCamera() {
  cameraPivot.set(characterBody.position.x, characterBody.position.y + cameraRig.lookAtY, characterBody.position.z);
  const cosPitch = Math.cos(cameraPitch);
  cameraRight.set(Math.cos(cameraYaw), 0, -Math.sin(cameraYaw)).normalize();
  cameraTarget.set(
    cameraPivot.x + Math.sin(cameraYaw) * cosPitch          * cameraRig.distance + cameraRight.x * cameraRig.offsetX,
    cameraPivot.y + Math.sin(cameraPitch)                    * cameraRig.distance + cameraRig.offsetY,
    cameraPivot.z + Math.cos(cameraYaw) * cosPitch           * cameraRig.distance + cameraRight.z * cameraRig.offsetX
  );
  camera.position.copy(cameraTarget);
  camera.lookAt(cameraPivot);
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
  const loader = new GLTFLoader();
  const gltf   = await loader.loadAsync("/models/model_all.glb");
  const model  = gltf.scene;

  model.traverse(child => {
    if (child.isMesh) { child.castShadow = true; child.receiveShadow = false; }
  });

  const bounds = new THREE.Box3().setFromObject(model);
  const size   = new THREE.Vector3();
  bounds.getSize(size);
  model.scale.setScalar(CHARACTER_HEIGHT / size.y);
  bounds.setFromObject(model);
  model.position.y = -bounds.min.y;
  characterRoot.add(model);

  mixer = new THREE.AnimationMixer(model);
  for (const clip of gltf.animations) {
    const action = mixer.clipAction(clip);
    action.enabled = false;
    action.setEffectiveWeight(0);
    action.setEffectiveTimeScale(1);
    if (clip.name === "jump") { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
    else                      { action.setLoop(THREE.LoopRepeat, Infinity); }
    actions[clip.name] = action;
  }
  for (const name of LOCOMOTION_CLIPS) {
    const a = actions[name]; if (!a) continue;
    a.enabled = true; a.play();
  }
  if (actions.idle) actions.idle.setEffectiveWeight(1);
  animWeights.idle = 1; animWeights.walk = 0; animWeights.run = 0;
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
  updateCharacterAnimation(delta);

  characterRoot.position.set(
    characterBody.position.x,
    characterBody.position.y - FEET_OFFSET,
    characterBody.position.z
  );

  if (mixer) mixer.update(delta);
  if (zombieManager) zombieManager.update(delta);

  updateGroundChunks(characterBody.position.x, characterBody.position.z);
  updateSunShadow();
  updateThirdPersonCamera();
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
    setLoadMsg("Loading character…");
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
      getPlayerBody: () => characterBody,
      dealDamageToPlayer,
      regenPlayerHealth,
    });
    await zombieManager.init(ZOMBIE_PREWARM_COUNT);
    zombieManager.spawnRing(ZOMBIE_INITIAL_SPAWN, -6.43, 127.8, 8, 35);

    setLoadMsg("Loading world & 3D models…");
    await loadWorld();

    setLoadMsg("Starting scene…");
    clock.getDelta();
    _animRunning = true;
    animate();

    setupGui();

    window.zombieManager = zombieManager;

    loadingScreen.classList.add("hidden");
    loadingScreen.addEventListener("transitionend", () => loadingScreen.remove(), { once: true });
  } catch (err) {
    console.error("Boot failure:", err);
    setLoadMsg("Failed to load. Check the console.");
  }
}

boot();
