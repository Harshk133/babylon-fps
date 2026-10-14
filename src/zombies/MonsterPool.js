import * as THREE from "three";
import * as CANNON from "cannon-es";
import { MD2Loader } from "three/addons/loaders/MD2Loader.js";
import { GROUP_ZOMBIE } from "../physicsGroups.js";
import { MODELS, WEAPON_MODELS, MONSTER_TYPES } from "./MonsterTypes.js";

const POOL_HIDE_Y = -500;
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

function makeActions(mixer, clips) {
  const actions = {};
  for (const clip of clips) {
    const a = mixer.clipAction(clip);
    if (ONE_SHOT.has(clip.name)) {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
    } else {
      a.setLoop(THREE.LoopRepeat, Infinity);
    }
    if (BASE_RATES[clip.name]) a.setEffectiveTimeScale(BASE_RATES[clip.name]);
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
 */
export class MonsterPools {
  constructor({ scene, world, monsterMaterial, linDamping, angDamping }) {
    this.scene = scene;
    this.world = world;
    this.monsterMaterial = monsterMaterial;
    this.linDamping = linDamping;
    this.angDamping = angDamping;
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

    // Bodies, skins and weapons, all in parallel
    const bodies = {};
    const skins = {};
    const weapons = {};
    const jobs = [];
    for (const [name, m] of Object.entries(MODELS)) {
      jobs.push(loader.loadAsync(m.body).then(g => { bodies[name] = g; }));
    }
    for (const def of Object.values(MONSTER_TYPES)) {
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

    for (const [type, def] of Object.entries(MONSTER_TYPES)) {
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
      };
      this.inactive[type] = [];
      for (let i = 0; i < def.pool; i++) {
        const m = this._createInstance(type, i);
        this._deactivate(m);
        this.inactive[type].push(m);
        this.all.push(m);
      }
    }
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
      currentAnim: "stand",
      animLockTimer: 0,
      rotY: 90,
    };
    body.zombie = m; // lets bullet raycasts map a hit body back to its monster
    return m;
  }

  /** Free slots for a type. */
  available(type) {
    return this.inactive[type]?.length ?? 0;
  }

  acquire(type, x, z, health) {
    const m = this.inactive[type]?.pop();
    if (!m) return null;
    this._activate(m, x, z, health);
    this.active.push(m);
    return m;
  }

  release(m) {
    const i = this.active.indexOf(m);
    if (i >= 0) this.active.splice(i, 1);
    this._deactivate(m);
    this.inactive[m.type].push(m);
  }

  _resetAnimations(m) {
    for (const a of Object.values(m.actions)) { a.stop(); a.reset(); }
    if (m.wActions) for (const a of Object.values(m.wActions)) { a.stop(); a.reset(); }
    m.currentAnim = "stand";
    m.animLockTimer = 0;
    m.actions.stand?.play();
    m.wActions?.stand?.play();
  }

  _activate(m, x, z, health) {
    const t = m.kind;
    m.active = true;
    m.health = health;
    m.maxHealth = health;
    m.dying = false;
    m.dieTimer = 0;
    m.staggerTimer = 0;
    m.flashTimer = 0;
    m.burnTimer = 0;
    m.mats = t.skinMats[(Math.random() * t.skinMats.length) | 0];
    m.mesh.material = m.mats.base;
    m.body.collisionFilterGroup = GROUP_ZOMBIE;
    m.rotY = Math.random() * 360;
    this._resetAnimations(m);
    m.body.velocity.set(0, 0, 0);
    m.body.angularVelocity.set(0, 0, 0);
    m.body.position.set(x, m.visualOffY, z);
    m.body.wakeUp();
    m.root.visible = true;
    m.root.rotation.y = THREE.MathUtils.degToRad(m.rotY);
    m.root.position.set(x, 0, z);
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
    m.body.position.set(0, POOL_HIDE_Y, 0);
    m.body.sleep();
    m.root.visible = false;
    m.root.position.set(0, POOL_HIDE_Y, 0);
    m.marker.visible = false;
  }
}
