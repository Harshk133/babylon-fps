import * as THREE from "three";
import { groundHeight } from "../world/Terrain.js";
import * as CANNON from "cannon-es";
import { MD2Loader } from "three/addons/loaders/MD2Loader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { GROUP_ZOMBIE, GROUP_PLAYER, GROUP_PROJECTILE } from "../physicsGroups.js";
import { MODELS, WEAPON_MODELS, GLB_MODELS, MONSTER_TYPES } from "./MonsterTypes.js";

const POOL_HIDE_Y = -500;
// Parked bodies each get their own spot on a line far outside the map. All at
// one point, the physics broadphase saw ~150 bodies overlapping and walked
// every pair of them on every step.
const PARK_X0 = -4000, PARK_GAP = 6;
let parkCount = 0;
const MD2_FPS = 10;

// The MD2s merge death1..3 / pain1..3 into single clips; split them back out
const SUBCLIPS = {
  death: [["death1", 0, 6], ["death2", 6, 12], ["death3", 12, 20]],
  pain:  [["pain1", 0, 4], ["pain2", 4, 8], ["pain3", 8, 12]],
};
const ONE_SHOT = new Set([
  "death1", "death2", "death3", "pain1", "pain2", "pain3", "point", "salute", "wave", "flip", "jump",
]);
const BASE_RATES = { attack: 0.55, run: 0.6, stand: 0.8 };
const _yAxis = new CANNON.Vec3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

function addCapsuleToBody(body, radius, height) {
  const hh = height / 2;
  // cannon-es Cylinder is already Y-aligned (no rotation, or it lies sideways)
  body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, -hh, 0));
  body.addShape(new CANNON.Cylinder(radius, radius, height, 12), new CANNON.Vec3(0, 0, 0));
  body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, hh, 0));
}

function splitClips(animations) {
  const clips = [];
  for (const clip of animations ?? []) {
    const parts = SUBCLIPS[clip.name];
    if (!parts) { clips.push(clip); continue; }
    for (const [name, start, end] of parts) clips.push(THREE.AnimationUtils.subclip(clip, name, start, end, MD2_FPS));
  }
  return clips;
}

function makeActions(mixer, clips, rates = BASE_RATES) {
  const actions = {};
  for (const clip of clips) {
    const a = mixer.clipAction(clip);
    if (ONE_SHOT.has(clip.name)) {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
    } else {
      a.setLoop(THREE.LoopRepeat, Infinity);
    }
    if (rates[clip.name]) a.setEffectiveTimeScale(rates[clip.name]);
    actions[clip.name] = a;
  }
  return actions;
}

// "?" / "!" awareness markers drawn once and shared by every monster
function makeMarkerTexture(char, color) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.font = "900 54px 'Segoe UI', system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineWidth = 8;
  g.strokeStyle = "rgba(0,0,0,0.85)";
  g.strokeText(char, 32, 34);
  g.fillStyle = color;
  g.fillText(char, 32, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * One pool per monster type, all sharing loaded geometry, skins and weapons.
 * Inactive monsters are hidden at y = −500 and asleep; acquire/release never
 * add or remove scene objects or physics bodies.
 *
 * Two kinds of model: the MD2 humanoids (body + weapon meshes, capsule body)
 * and skinned GLB creatures (hound, dragon) cloned per instance with
 * SkeletonUtils, with a compound sphere hitbox that turns with the monster.
 */
export class MonsterPools {
  /** loadGLB(url) → gltf, for the skinned GLB monsters. */
  constructor({ scene, world, monsterMaterial, linDamping, angDamping, loadGLB }) {
    this.scene = scene;
    this.world = world;
    this.monsterMaterial = monsterMaterial;
    this.linDamping = linDamping;
    this.angDamping = angDamping;
    this.loadGLB = loadGLB;
    this.types = {};      // type → shared data
    this.inactive = {};   // type → monster[]
    this.active = [];
    this.all = [];
    this.markerMats = {
      "?": new THREE.SpriteMaterial({ map: makeMarkerTexture("?", "#ffd23a"), depthTest: false, transparent: true }),
      "!": new THREE.SpriteMaterial({ map: makeMarkerTexture("!", "#ff3b2f"), depthTest: false, transparent: true }),
    };
  }

  async load() {
    const loader = new MD2Loader();
    const texLoader = new THREE.TextureLoader();
    const loadTex = url => new Promise(resolve => texLoader.load(url, t => { t.colorSpace = THREE.SRGBColorSpace; resolve(t); }, undefined, () => resolve(null)));

    // Bodies, skins, weapons and GLB creatures, all in parallel
    const bodies = {};
    const skins = {};
    const weapons = {};
    const glbs = {};
    const jobs = [];
    for (const [name, m] of Object.entries(MODELS)) {
      jobs.push(loader.loadAsync(m.body).then(g => { bodies[name] = g; }));
    }
    for (const def of Object.values(MONSTER_TYPES)) {
      if (def.glb) {
        if (!(def.glb in glbs) && this.loadGLB) {
          glbs[def.glb] = null;
          // A missing model only removes that monster type, not the whole game
          jobs.push(this.loadGLB(GLB_MODELS[def.glb].url).then(g => { glbs[def.glb] = g; }, err => console.warn(err)));
        }
        continue;
      }
      for (const skin of def.skins) {
        const url = MODELS[def.model].skinDir + skin;
        if (!(url in skins)) { skins[url] = null; jobs.push(loadTex(url).then(t => { skins[url] = t; })); }
      }
      for (const w of def.weapons ?? []) {
        if (w in weapons) continue;
        weapons[w] = null;
        const wm = WEAPON_MODELS[w];
        jobs.push(Promise.all([loader.loadAsync(wm.model), loadTex(wm.skin)]).then(([g, t]) => {
          weapons[w] = { geometry: g, clips: splitClips(g.animations), material: new THREE.MeshLambertMaterial({ map: t }) };
        }));
      }
    }
    await Promise.all(jobs);

    const prepared = {};
    for (const [type, def] of Object.entries(MONSTER_TYPES)) {
      if (def.glb) {
        const gltf = glbs[def.glb];
        if (!gltf) continue;
        prepared[def.glb] ??= this._prepareGlb(gltf, GLB_MODELS[def.glb]);
        this.types[type] = this._glbType(type, def, prepared[def.glb]);
        this._fillPool(type);
        continue;
      }
      const geometry = bodies[def.model];
      geometry.computeBoundingBox();
      const rawBB = geometry.boundingBox;
      const rawHeight = (rawBB.max.y - rawBB.min.y) || 1;
      const capRadius = def.height * def.radius;
      const skinMats = def.skins.map(s => {
        const map = skins[MODELS[def.model].skinDir + s];
        return {
          base: new THREE.MeshLambertMaterial({ map }),
          // Swapped in for a few frames when a bullet lands
          hit: new THREE.MeshLambertMaterial({ map, emissive: new THREE.Color(0xff2a10), emissiveIntensity: 0.9 }),
          // Charred + glowing while on fire
          burn: new THREE.MeshLambertMaterial({ map, color: new THREE.Color(0x5a4a40), emissive: new THREE.Color(0xff5a10), emissiveIntensity: 0.35 }),
        };
      });
      const clips = splitClips(geometry.animations);
      const attackClip = clips.find(c => c.name === "attack");
      this.types[type] = {
        type, def, geometry, clips, rawBB, rawHeight, skinMats,
        weapons: (def.weapons ?? []).map(w => ({ id: w, ...weapons[w] })),
        scale: def.height / rawHeight,
        capRadius,
        capHeight: Math.max(0.01, def.height - capRadius * 2),
        bodyCentreY: def.height / 2,
        attackInterval: attackClip ? attackClip.duration / BASE_RATES.attack : 1.4,
        rates: BASE_RATES,
        painClips: SUBCLIPS.pain.map(c => c[0]),
        deathClips: SUBCLIPS.death.map(c => c[0]),
      };
      this._fillPool(type);
    }
  }

  _fillPool(type) {
    const t = this.types[type];
    this.inactive[type] = [];
    for (let i = 0; i < t.def.pool; i++) {
      const m = t.glb ? this._createGlbInstance(type) : this._createInstance(type, i);
      m.parkX = PARK_X0 - parkCount++ * PARK_GAP;
      this._deactivate(m);
      this.inactive[type].push(m);
      this.all.push(m);
    }
  }

  /**
   * Normalises a skinned GLB once: posed on the first frame of its standing
   * clip, turned so the head (relative to the pelvis) faces +Z, feet on y = 0
   * and centred on the body. Returns a holder to clone per instance.
   */
  _prepareGlb(gltf, spec) {
    const src = gltf.scene;
    const pivot = new THREE.Group();
    pivot.add(src);
    const holder = new THREE.Group();
    holder.add(pivot);

    const mixer = new THREE.AnimationMixer(src);
    const stand = gltf.animations.find(c => c.name === spec.clips.stand);
    if (stand) { mixer.clipAction(stand).play(); mixer.setTime(0); }
    holder.updateMatrixWorld(true);

    let head = null, pelvis = null;
    src.traverse(o => {
      if (!o.isBone) return;
      if (!head && /head/i.test(o.name)) head = o;
      if (!pelvis && /pelvis|hips/i.test(o.name)) pelvis = o;
    });
    if (head && pelvis) {
      const d = head.getWorldPosition(_v1).sub(pelvis.getWorldPosition(_v2));
      pivot.rotation.y = -Math.atan2(d.x, d.z);
      holder.updateMatrixWorld(true);
    }
    const box = new THREE.Box3().setFromObject(holder, true);
    const c = box.getCenter(new THREE.Vector3());
    pivot.position.set(-c.x, -box.min.y, -c.z);
    mixer.stopAllAction();
    mixer.uncacheRoot(src);

    let mesh = null;
    holder.traverse(o => {
      if (!o.isMesh) return;
      if (o.isSkinnedMesh) mesh ??= o;
      o.castShadow = true;
      o.receiveShadow = true;
    });

    // The AI's clip names, each its own clip object so two names can share
    // one source clip (the dragon's run and attack) without sharing an action
    const clips = [];
    for (const [name, clipName] of Object.entries(spec.clips)) {
      const clip = gltf.animations.find(a => a.name === clipName);
      if (!clip) continue;
      const copy = clip.clone();
      copy.name = name;
      clips.push(copy);
    }
    return { holder, mesh, clips, rawHeight: (box.max.y - box.min.y) || 1 };
  }

  _glbType(type, def, prep) {
    const base = prep.mesh.material;
    const hit = base.clone();
    hit.emissive = new THREE.Color(0xff2a10);
    hit.emissiveMap = null;
    hit.emissiveIntensity = 0.9;
    const burn = base.clone();
    burn.color = new THREE.Color(0x4a3a32);
    burn.emissive = new THREE.Color(0xff5a10);
    burn.emissiveMap = null;
    burn.emissiveIntensity = 0.35;
    const rates = def.rates ?? {};
    const attackClip = prep.clips.find(c => c.name === "attack");
    const names = new Set(prep.clips.map(c => c.name));
    return {
      type, def, glb: prep, clips: prep.clips, skinMats: [{ base, hit, burn }],
      rawBB: null, rawHeight: prep.rawHeight,
      weapons: [],
      scale: def.height / prep.rawHeight,
      capRadius: def.sepRadius,
      bodyCentreY: def.bodyY,
      attackInterval: attackClip ? attackClip.duration / (rates.attack ?? 1) : 1.2,
      rates,
      painClips: ["pain1", "pain2", "pain3"].filter(n => names.has(n)),
      deathClips: ["death1", "death2", "death3"].filter(n => names.has(n)),
    };
  }

  _createGlbInstance(type) {
    const t = this.types[type];
    const def = t.def;
    const root = new THREE.Group();
    root.scale.setScalar(t.scale);
    const model = SkeletonUtils.clone(t.glb.holder);
    root.add(model);
    let mesh = null;
    model.traverse(o => {
      if (!o.isSkinnedMesh) return;
      mesh ??= o;
      // Bounds come from the bind pose; spread wings and leaps leave them
      o.frustumCulled = false;
    });
    mesh.material = t.skinMats[0].base;
    const mixer = new THREE.AnimationMixer(model);
    const actions = makeActions(mixer, t.clips, t.rates);
    this.scene.add(root);

    const marker = new THREE.Sprite(this.markerMats["?"]);
    marker.scale.set(0.55, 0.55, 0.55);
    marker.visible = false;
    marker.renderOrder = 5;
    this.scene.add(marker);

    const body = new CANNON.Body({
      mass: def.mass,
      material: this.monsterMaterial,
      linearDamping: this.linDamping,
      angularDamping: this.angDamping,
      fixedRotation: true,
      allowSleep: true,
      collisionFilterGroup: GROUP_ZOMBIE,
    });
    // Flyers only touch players and grenades, never houses or tree crowns
    if (def.flying) body.collisionFilterMask = GROUP_PLAYER | GROUP_PROJECTILE;
    let headSphere = null;
    for (const [r, y, z, isHead] of def.hitbox) {
      body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, y - def.bodyY, z));
      if (isHead) headSphere = { r, y, z };
    }
    body.position.set(0, POOL_HIDE_Y, 0);
    this.world.addBody(body);

    const m = {
      id: this.all.length,
      type, def, kind: t,
      active: false,
      health: 100, maxHealth: 100,
      root, mesh, mixer, actions, wMesh: null, wMixer: null, wActions: null, weaponId: null,
      marker, mats: t.skinMats[0],
      body,
      height: def.height,
      capRadius: t.capRadius,
      visualOffY: t.bodyCentreY,
      attackInterval: t.attackInterval,
      headSphere,
      orientBody: true, // the compound hitbox turns with the monster
      flyY: 0, bank: 0,
      currentAnim: "stand",
      animLockTimer: 0,
      rotY: 0,
    };
    body.zombie = m; // lets bullet raycasts map a hit body back to its monster
    return m;
  }

  _createInstance(type, i) {
    const t = this.types[type];
    const root = new THREE.Group();
    root.scale.setScalar(t.scale);

    const mesh = new THREE.Mesh(t.geometry, t.skinMats[0].base);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.rotation.y = -Math.PI / 2;
    mesh.position.y = -t.rawBB.min.y;
    root.add(mesh);
    const mixer = new THREE.AnimationMixer(mesh);
    const actions = makeActions(mixer, t.clips);

    // Weapon: a second MD2 mesh with the same frame names, driven in lockstep
    let wMesh = null, wMixer = null, wActions = null, weapon = null;
    if (t.weapons.length) {
      weapon = t.weapons[i % t.weapons.length];
      wMesh = new THREE.Mesh(weapon.geometry, weapon.material);
      wMesh.castShadow = true;
      wMesh.rotation.y = -Math.PI / 2;
      wMesh.position.y = -t.rawBB.min.y;
      root.add(wMesh);
      wMixer = new THREE.AnimationMixer(wMesh);
      wActions = makeActions(wMixer, weapon.clips);
    }
    this.scene.add(root);

    const marker = new THREE.Sprite(this.markerMats["?"]);
    marker.scale.set(0.55, 0.55, 0.55);
    marker.visible = false;
    marker.renderOrder = 5;
    this.scene.add(marker);

    const body = new CANNON.Body({
      mass: t.def.mass,
      material: this.monsterMaterial,
      linearDamping: this.linDamping,
      angularDamping: this.angDamping,
      fixedRotation: true,
      allowSleep: true,
      collisionFilterGroup: GROUP_ZOMBIE,
    });
    addCapsuleToBody(body, t.capRadius, t.capHeight);
    body.position.set(0, POOL_HIDE_Y, 0);
    this.world.addBody(body);

    const m = {
      id: this.all.length,
      type, def: t.def, kind: t,
      active: false,
      health: 100, maxHealth: 100,
      root, mesh, mixer, actions, wMesh, wMixer, wActions, weaponId: weapon?.id ?? null,
      marker, mats: t.skinMats[0],
      body,
      height: t.def.height,
      capRadius: t.capRadius,
      visualOffY: t.bodyCentreY,
      attackInterval: t.attackInterval,
      headSphere: null,
      orientBody: false,
      flyY: 0, bank: 0,
      currentAnim: "stand",
      animLockTimer: 0,
      rotY: 90,
    };
    body.zombie = m; // lets bullet raycasts map a hit body back to its monster
    return m;
  }

  /**
   * Co-op clients only mirror the host's monsters: bodies become kinematic
   * (moved by snapshots, never pushed) but still block players and bullets.
   */
  setPuppetMode(on) {
    for (const m of this.all) {
      const b = m.body;
      b.type = on ? CANNON.Body.KINEMATIC : CANNON.Body.DYNAMIC;
      b.mass = on ? 0 : m.def.mass;
      b.updateMassProperties();
      b.velocity.set(0, 0, 0);
    }
  }

  /** Free slots for a type (0 for a type whose model failed to load). */
  available(type) {
    return this.inactive[type]?.length ?? 0;
  }

  /** weaponId / skinIndex: match a specific look (co-op clients mirroring the host). */
  acquire(type, x, z, health, weaponId = null, skinIndex = null) {
    const list = this.inactive[type];
    if (!list?.length) return null;
    let i = list.length - 1;
    if (weaponId !== null) {
      const j = list.findIndex(q => q.weaponId === weaponId);
      if (j >= 0) i = j;
    }
    const m = list.splice(i, 1)[0];
    this._activate(m, x, z, health, skinIndex);
    this.active.push(m);
    return m;
  }

  release(m) {
    const i = this.active.indexOf(m);
    if (i >= 0) this.active.splice(i, 1);
    this._deactivate(m);
    this.inactive[m.type].push(m);
  }

  /** Turns a compound hitbox to the monster's facing. */
  orient(m) {
    if (m.orientBody) m.body.quaternion.setFromAxisAngle(_yAxis, THREE.MathUtils.degToRad(m.rotY));
  }

  _resetAnimations(m) {
    m.mixer.timeScale = 1;
    for (const a of Object.values(m.actions)) { a.stop(); a.reset(); }
    if (m.wActions) for (const a of Object.values(m.wActions)) { a.stop(); a.reset(); }
    m.currentAnim = "stand";
    m.animLockTimer = 0;
    m.actions.stand?.play();
    m.wActions?.stand?.play();
  }

  _activate(m, x, z, health, skinIndex = null) {
    const t = m.kind;
    m.active = true;
    m.health = health;
    m.maxHealth = health;
    m.dying = false;
    m.dieTimer = 0;
    m.staggerTimer = 0;
    m.flashTimer = 0;
    m.burnTimer = 0;
    m.hbTrail = 1;
    m.skinIndex = skinIndex ?? ((Math.random() * t.skinMats.length) | 0);
    m.mats = t.skinMats[m.skinIndex % t.skinMats.length];
    m.mesh.material = m.mats.base;
    m.body.collisionFilterGroup = GROUP_ZOMBIE;
    m.rotY = Math.random() * 360;
    m.flyY = m.def.flying?.altitude ?? 0;
    m.bank = 0;
    m.deathStyle = null;
    m.pounceT = 0;
    this._resetAnimations(m);
    m.body.velocity.set(0, 0, 0);
    m.body.angularVelocity.set(0, 0, 0);
    if (!m.body.world) this.world.addBody(m.body);
    const g = groundHeight(x, z);
    m.body.position.set(x, g + m.visualOffY + m.flyY, z);
    this.orient(m);
    m.body.wakeUp();
    m.root.visible = true;
    m.root.matrixWorldAutoUpdate = true;
    m.marker.matrixWorldAutoUpdate = true;
    m.root.rotation.set(0, THREE.MathUtils.degToRad(m.rotY), 0);
    m.root.position.set(x, g + m.flyY, z);
  }

  _deactivate(m) {
    m.active = false;
    m.health = 0;
    m.burnTimer = 0;
    for (const a of Object.values(m.actions)) { a.stop(); a.reset(); }
    if (m.wActions) for (const a of Object.values(m.wActions)) { a.stop(); a.reset(); }
    m.currentAnim = "stand";
    m.animLockTimer = 0;
    m.body.velocity.set(0, 0, 0);
    m.body.angularVelocity.set(0, 0, 0);
    m.body.position.set(m.parkX ?? 0, POOL_HIDE_Y, 0);
    m.body.aabbNeedsUpdate = true; // a sleeping body's box isn't refreshed otherwise
    m.body.sleep();
    // Out of the physics world while pooled: even asleep, every body is sorted
    // and swept by the broadphase each step (100+ parked monsters cost more
    // than the 20 alive ones). Only the THREE side has to stay in the scene.
    if (m.body.world) this.world.removeBody(m.body);
    m.root.visible = false;
    m.root.position.set(0, POOL_HIDE_Y, 0);
    m.root.rotation.set(0, 0, 0);
    m.marker.visible = false;
    // Parked: skip its (bone-heavy) subtree in the scene's matrix update
    m.root.updateMatrixWorld(true);
    m.root.matrixWorldAutoUpdate = false;
    m.marker.matrixWorldAutoUpdate = false;
  }
}
