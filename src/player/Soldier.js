import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { cloneItem } from "../items/ItemModels.js";
import { WEAPON_ORDER } from "../combat/weapons.js";
import { CHARACTERS, PALETTES, decodeAvatar, savedAvatar } from "./Avatar.js";
import { loadAnimations, loadCharacter, cloneCharacter, clipSetFor } from "./MixamoAssets.js";

// A player's body: one of the Mixamo characters (Avatar.js) animated from the
// shared clip library (MixamoAssets.js). The same class plays you, teammates,
// battle royale bots and the inventory preview.
//
// Animation is layered, every layer's weights eased toward their targets so
// nothing snaps:
//   base       lower body: idle / walk / run / sprint by ground speed (each
//              clip played at the rate that matches it, all on one phase so
//              the feet never slide or skip), walk-back / reversed run going
//              backwards, crouch-walk, and sideways the legs turn toward the
//              movement (up to ±70°) while the spine turns back to the aim.
//              Upper body: with a gun, the rifle pose (low ready → aim → fire
//              by aim and trigger); empty-handed, the same clips as the legs.
//   stances    prone (lie / crawl) and swimming (tread / swim) are whole-body.
//   overlays   upper body, faded in and out: reload, throw (held wind-up,
//              then the release), drink / eat / heal.
//   overrides  whole body (legs only with a gun up): jump take-off, air and
//              landing, hard landing after a long fall, climb / vault, death
//              (picked by where the shot came from).
//   procedural after the clips: the spine turns the gun onto the aim, hips
//              turned for strafing, legs bent in a driving seat, the arm
//              reaching over the shoulder to swap guns, a wounded hunch, a
//              flinch when hit, the hand reaching for a door.
// Only actions with weight are kept playing (an idle mixer action still costs).

const SMG_URL = "/models/soldier/smg.glb";   // the held SMG model ("Submachine Gun", CC0, Quaternius)
const WEAPON_LENGTH = 0.55;
const WEAPON_GRIP   = new THREE.Vector3(-0.05, -0.25, 0);  // grip point in raw SMG units
const WEAPON_MUZZLE = new THREE.Vector3(2.3, 0.58, 0);     // muzzle point in raw SMG units
// Where the left wrist goes on each gun: metres along the barrel from the grip, and below the
// bore (the palm and fingers wrap under from there). The arm reaches there by IK (the rifle clips were made for a longer gun).
const SUPPORT = {
  pistol:  { along: 0.0,  below: 0.03 },   // cupping the right hand
  smg:     { along: 0.17, below: 0.0 },
  shotgun: { along: 0.3,  below: 0.0 },
  rifle:   { along: 0.27, below: 0.0 },
  sniper:  { along: 0.3,  below: 0.01 },
};

// Vanguard: the lightest download (one 1024 texture set), for anyone who hasn't chosen
const DEFAULT_AVATAR = { char: 0, top: 0, bottom: 0, shoes: 0, hair: 0 };

// Blends are critically damped springs (rad/s): they start and settle gently,
// with no snap at either end, and never overshoot
const BLEND_RATE  = 13;     // action weights
const STANCE_RATE = 9;
const AIM_RATE    = 22;     // raising / lowering the gun
const AIM_PITCH   = [-0.75, 0.85];
const HIP_YAW_MAX = 0.95;   // rad the legs turn toward a sideways move
const BACK_IN     = 1.85;   // rad off forward where the legs switch to backwards…
const BACK_OUT    = 1.6;    // …and back to forwards (hysteresis: no flip-flopping on a diagonal)
const LOCO = ["walk", "run", "sprint", "walk_back", "crouch_walk", "run_rev", "crouch_rev"];
const SWAP_TIME   = 0.5;    // s to swing a gun off the back
// Clip segments (fractions of the clip) used for the game's moves
const SEG = {
  throwHold: 0.42, throwFrom: 0.45, throwTo: 0.8,
  drinkFrom: 0.22, drinkTo: 0.62,
  climbFrom: 0.2, climbTo: 0.98, vaultFrom: 0.32, vaultTo: 0.85,
  jumpUp: 0.32, jumpApex: 0.5, jumpLand: 0.7, jumpEnd: 0.95,
  landFrom: 0.45, landTo: 0.95,
};
// Gestures with nothing in the hands: the gun goes on the back meanwhile
const GUN_AWAY = new Set(["eat", "drink", "heal", "throw", "vault", "climb"]);
// Upper-body clip overlays (gesture → clip)
const OVERLAY = { reload: "reload", throw: "throw", eat: "drink", drink: "drink", heal: "drink" };
const DEATHS = { front: "death_front", back: "death_back", right: "death_right", left: "death", head_front: "death_head_front", head_back: "death_head_back" };

const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _qStep = new THREE.Quaternion();
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3(), _v7 = new THREE.Vector3(), _v8 = new THREE.Vector3();
const _m0 = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0), _xAxis = new THREE.Vector3(1, 0, 0);
const GEAR_MATS = [0x5b6338, 0x9a8458, 0x2a2c2f].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0.05 }));
const STRAP_MAT = new THREE.MeshStandardMaterial({ color: 0x1d1e1c, roughness: 0.9 });

/** One step of a critically damped spring toward target (exact for a constant target). */
function spring(st, key, vkey, target, omega, dt) {
  const x = st[key] - target, v = st[vkey];
  const e = Math.exp(-omega * dt), tmp = (v + omega * x) * dt;
  st[key] = target + (x + tmp) * e;
  st[vkey] = (v - omega * tmp) * e;
}
/** The same, value in vals[key] and velocity in vels[key]. */
function spring2(vals, vels, key, target, omega, dt) {
  const x = vals[key] - target, v = vels[key];
  const e = Math.exp(-omega * dt), tmp = (v + omega * x) * dt;
  vals[key] = target + (x + tmp) * e;
  vels[key] = (v - omega * tmp) * e;
}
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

/** 0 → 1 over [a, a + ramp], back to 0 over [b − ramp, b]. */
function bump(k, a, b, ramp = 0.15) {
  return THREE.MathUtils.smoothstep(k, a, a + ramp) * (1 - THREE.MathUtils.smoothstep(k, b - ramp, b));
}

/**
 * Turns a bone by a world-space rotation. Only the bone's own matrices are
 * refreshed: getWorldQuaternion() brings its parents up to date on the way,
 * and the frame's scene update redoes the children anyway (refreshing the
 * whole subtree here, ten times a frame over 65–130 bones, was most of the cost).
 */
function rotateBoneInWorld(bone, worldDelta) {
  if (!bone) return;
  bone.getWorldQuaternion(_q0).premultiply(worldDelta);
  bone.parent.getWorldQuaternion(_q1).invert();
  bone.quaternion.copy(_q1.multiply(_q0));
  bone.updateWorldMatrix(false, false);
}
function turnBone(bone, axis, angle) {
  if (!bone || Math.abs(angle) < 1e-4) return;
  rotateBoneInWorld(bone, _qStep.setFromAxisAngle(axis, angle));
}

/** Shows / hides a part; a hidden one leaves its bone (hidden objects still cost a matrix update). */
function showPart(obj, on) {
  obj.visible = on;
  if (!on && obj.parent) { obj.userData.home = obj.parent; obj.parent.remove(obj); }
  else if (on && !obj.parent && obj.userData.home) obj.userData.home.add(obj);
}

let _smg = null;
function loadSmg(loader) {
  _smg ??= loader.loadAsync(SMG_URL).catch(err => { _smg = null; throw err; });
  return _smg;
}

export class Soldier {
  /** avatar: { char, top, bottom, shoes, hair }, its packed code, or nothing (your saved look). */
  constructor({ avatar = null } = {}) {
    this.avatar = typeof avatar === "number" ? decodeAvatar(avatar) : avatar ?? savedAvatar() ?? { ...DEFAULT_AVATAR };
    this.root = new THREE.Group();
    this.model = null;
    this.weapon = null;           // the hand holder
    this.guns = {};               // id → { model, back, muzzle }
    this.currentGun = "smg";
    this.backGun = null;          // the gun slung on the back
    this.muzzle = new THREE.Object3D();
    this.mixer = null;

    this.dead = false;
    this.seated = false;
    this.stance = "stand";
    this.aimWeight = 0;
    this.shootWeight = 0;
    this.sw = { stand: 1, crouch: 0, prone: 0, swim: 0 };   // eased stance weights
    this.swv = { stand: 0, crouch: 0, prone: 0, swim: 0 };  // …and their spring velocities
    this.aimV = 0;
    this.freq = 0; this.freqV = 0; // locomotion cycles per second (eased, so a stop finishes the step)
    this.backwards = false;
    this.hipYawV = 0;
    this.phase = 0;               // locomotion cycle (forward clips)
    this.hipYaw = 0;
    this.air = { t: 0, on: false, land: null };            // jump / landing state

    this.gesture = null;          // { name, t, dur }
    this.oneShot = null;          // procedural "interact" / "hit": { name, t, dur, weight }
    this.handProps = {};
    this.gear = { helmet: 0, vest: 0, backpack: 0 };
    this.gearMeshes = { helmet: [], vest: [], backpack: [] };
    this.firstPerson = false;
    this.woundW = 0;
    this.swap = null;             // { t, from, to }
    this.lod = 0;
  }

  async load(loader = new GLTFLoader()) {
    this._loader = loader;
    const def = CHARACTERS[this.avatar.char] ?? CHARACTERS[0];
    const [tpl, anims, smg] = await Promise.all([loadCharacter(loader, def), loadAnimations(loader), loadSmg(loader)]);
    this.def = def;
    this.tpl = tpl;
    this.anims = anims;
    this.clips = clipSetFor(tpl, anims);

    const model = cloneCharacter(tpl);
    const s = def.height / tpl.height;
    model.scale.setScalar(s);
    model.position.y = -tpl.floor * s;
    this.model = model;
    this.root.add(model);
    this.meshes = [];
    model.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = false;
      this.meshes.push(o);
    });
    this._applyLook();

    const bone = n => model.getObjectByName(n);
    this.b = {
      hips: bone("Hips"), spine: bone("Spine"), spine1: bone("Spine1"), spine2: bone("Spine2"),
      neck: bone("Neck"), head: bone("Head"), headTop: bone("HeadTop_End"),
      lArm: bone("LeftArm"), rArm: bone("RightArm"), lFore: bone("LeftForeArm"), rFore: bone("RightForeArm"),
      lHand: bone("LeftHand"), rHand: bone("RightHand"), rPalm: bone("RightHandMiddle1"),
      lUpLeg: bone("LeftUpLeg"), rUpLeg: bone("RightUpLeg"), lLeg: bone("LeftLeg"), rLeg: bone("RightLeg"),
      lFoot: bone("LeftFoot"),
    };
    // Every bone's rest transform, to go back to it (skeleton.pose() would rebuild the bones
    // from bind-time world matrices, which don't include this model's scale)
    this._rest = [];
    model.traverse(o => { if (o.isBone) this._rest.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]); });
    this.root.updateMatrixWorld(true);
    // Metres per unit of the clips' (retargeted) hips motion, for speed matching
    this.unit = this.b.hips.parent.getWorldScale(_v0).y;
    this.clipSpeed = name => (this.clips.speed[name] ?? 1) * this.unit;
    // Skinned bounds don't follow the animation: one generous sphere round the body
    for (const m of this.meshes) {
      const worldScale = m.getWorldScale(_v1).x || 1;
      m.boundingSphere = new THREE.Sphere(_v0.set(0, def.height * 0.5, 0).applyMatrix4(_m0.copy(m.matrixWorld).invert()), def.height * 1.1 / worldScale);
    }

    this.mixer = new THREE.AnimationMixer(model);
    this._buildActions();
    this._buildGear();
    this._attachWeapons(smg.scene);
    this.setWeapon(this.currentGun);
  }

  // ── Looks ──────────────────────────────────────────────────────────────────
  /**
   * A new look. Colours change in place; another character swaps the model once
   * it has downloaded (the old one stays until then), keeping gun, gear and props.
   */
  async setAvatar(avatar) {
    const a = typeof avatar === "number" ? decodeAvatar(avatar) : { ...avatar };
    const sameChar = a.char === this.avatar.char;
    this.avatar = a;
    if (!this.model) return;
    if (sameChar) { this._applyLook(); return; }
    const def = CHARACTERS[a.char] ?? CHARACTERS[0];
    await loadCharacter(this._loader, def);
    if (this.avatar !== a) return;        // changed again meanwhile
    // Everything below runs before the next frame (the files are all cached now)
    const gun = this.currentGun, back = this.backGun, gear = { ...this.gear }, fp = this.firstPerson, lod = this.lod;
    const props = Object.entries(this.handProps);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.root.remove(this.model);
    for (const [, obj] of props) obj.removeFromParent();
    this.model = this.mixer = null;
    this.acts = this._byKey = this._shown = this._clipOwner = null;
    this.guns = {};
    this.gearMeshes = { helmet: [], vest: [], backpack: [] };
    this.gear = { helmet: 0, vest: 0, backpack: 0 };
    this.swap = null;
    this.firstPerson = false;
    this.lod = 0;
    this.currentGun = gun;
    await this.load(this._loader);
    this.backGun = back;
    this.setGear(gear);
    this.setFirstPerson(fp);
    this.setDetail(lod);
    for (const [g, obj] of props) this.setHandProp(g, obj);
    if (this.dead) { this.dead = false; this.die(); }
  }

  _applyLook() {
    const a = this.avatar, parts = this.def.parts;
    for (const m of this.meshes) {
      let color = null;
      if (parts) {
        for (const [slot, name] of Object.entries(parts)) if (m.name.startsWith(name)) color = PALETTES[slot][a[slot]] ?? 0xffffff;
      } else if (this.def.outfit) color = PALETTES.outfit[a.top] ?? 0xffffff;
      if (color === null) continue;
      for (const mat of [].concat(m.material)) mat.color.setHex(color);
    }
  }

  /** 0: full detail, 1: the far mesh (~25% of the triangles). Same skeleton and animation. */
  setDetail(level) {
    if (level === this.lod || !this.tpl.lod) return;
    this.lod = level;
    for (const m of this.meshes) {
      m.userData.full ??= m.geometry;
      const far = this.tpl.lod[m.name];
      m.geometry = level && far ? far : m.userData.full;
    }
  }

  // ── Animation set-up ───────────────────────────────────────────────────────
  /** Creates the actions for the clips there are (again when more arrive: existing ones are kept). */
  _buildActions() {
    const { full, upper, lower } = this.clips;
    this.acts ??= [];
    this._byKey ??= new Map();
    this._actsVersion = this.clips.version;
    // The mixer keeps one action per clip: a clip used under two keys (the rifle idle and the
    // empty-handed idle, running forward and in reverse) gets an alias clip sharing its
    // tracks, or the two would fight over one action's time and weight every frame (a flicker)
    const aliases = this.clips.alias ??= new Map();
    const owner = this._clipOwner ??= new Map();
    const make = (map, name, key = name) => {
      let clip = map.get(name);
      if (!clip) return null;
      const id = `${key}|${clip.name}`;
      if (this._byKey.has(id)) return this._byKey.get(id);
      if (owner.has(clip) && owner.get(clip) !== key) {
        if (!aliases.has(id)) aliases.set(id, new THREE.AnimationClip(id, clip.duration, clip.tracks));
        clip = aliases.get(id);
      }
      owner.set(clip, key);
      const a = this.mixer.clipAction(clip);
      a.enabled = true;
      a.setLoop(THREE.LoopRepeat, Infinity);
      const e = { a, w: 0, v: 0, target: 0, dur: clip.duration, key, playing: false };
      this.acts.push(e);
      this._byKey.set(id, e);
      return e;
    };
    const BASE = ["relax", "idle", "walk", "run", "sprint", "walk_back", "crouch_idle", "crouch_walk"];
    this.L = {}; this.U = {};
    for (const n of BASE) { this.L[n] = make(lower, n); this.U[n] = make(upper, n); }
    // Running / crouch-walking backwards plays the forward clip in reverse: its own action,
    // so switching direction never jumps a playing clip to another time
    for (const [n, src] of [["run_rev", "run"], ["crouch_rev", "crouch_walk"]]) {
      this.L[n] = make(lower, src, n); this.U[n] = make(upper, src, `${n}_u`);
    }
    this.footPhase = this._footPhases();
    this.R = { idle: make(upper, "idle", "rifle"), aim: make(upper, "aim"), fire: make(upper, "fire") };
    this.O = {};
    for (const n of ["reload", "throw", "drink"]) this.O[n] = make(upper, n, `o_${n}`);
    this.F = {};
    for (const n of ["prone_idle", "prone_crawl", "tread", "swim", "climb", "jump", "land", ...Object.values(DEATHS), "death", "dying"]) {
      if (!this.F[n]) this.F[n] = make(full, n, `f_${n}`);
    }
    this.FL = { jump: make(lower, "jump", "l_jump"), land: make(lower, "land", "l_land") };
    for (const e of [this.R.fire]) if (e) e.a.timeScale = 1.4;
    // The gun comes up quickly (a shot from the hip shouldn't wait for it)
    for (const e of [this.R.idle, this.R.aim, this.R.fire]) if (e) e.rate = 22;
  }

  /**
   * Where in each locomotion clip the left foot is furthest forward (0..1), so
   * walk, run, sprint, crouch-walk and walk-back all step on the same phase:
   * blending clips that are on opposite feet is what made the legs flicker.
   * Measured once per character on a scratch mixer.
   */
  _footPhases() {
    if (this.tpl.footPhase) return this.tpl.footPhase;
    const out = {}, lf = this.b.lFoot ?? this.model.getObjectByName("LeftFoot"), rf = this.model.getObjectByName("RightFoot");
    if (!lf || !rf) return (this.tpl.footPhase = out);
    const tmp = new THREE.AnimationMixer(this.model);
    const inv = new THREE.Matrix4();
    for (const n of ["walk", "run", "sprint", "walk_back", "crouch_walk"]) {
      const clip = this.clips.lower.get(n);
      if (!clip) continue;
      const act = tmp.clipAction(clip).play();
      let best = -Infinity, at = 0;
      const N = 48;
      for (let i = 0; i < N; i++) {
        act.time = (i / N) * clip.duration;
        tmp.update(0);
        this.model.updateMatrixWorld(true);
        inv.copy(this.model.matrixWorld).invert();
        const dz = lf.getWorldPosition(_v0).applyMatrix4(inv).z - rf.getWorldPosition(_v1).applyMatrix4(inv).z;
        if (dz > best) { best = dz; at = i / N; }
      }
      act.stop();
      out[n] = at;
    }
    tmp.stopAllAction();
    tmp.uncacheRoot(this.model);
    this._restPose();
    return (this.tpl.footPhase = out);
  }

  // ── Gear: helmet, vest, backpack, measured off the bind pose ───────────────
  _buildGear() {
    const tpl = this.tpl, b = this.b;
    this.model.updateMatrixWorld(true);
    const wp = (bn, out = new THREE.Vector3()) => bn.getWorldPosition(out);
    const shL = wp(b.lArm), shR = wp(b.rArm), neckP = wp(b.neck), abdP = wp(b.spine), chestP = wp(b.spine2);
    const across = shL.clone().sub(shR).setY(0).normalize();
    const fwd = new THREE.Vector3().crossVectors(across, _up);
    if (fwd.z < 0) fwd.negate();
    const side = new THREE.Vector3().crossVectors(_up, fwd);
    const frame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, _up, fwd));
    const toFrame = frame.clone().invert();
    const half = shL.distanceTo(shR) * 0.5;
    // Torso extent (body vertices between waist and neck, arms left out): once per character
    if (!tpl.torso) {
      const tMin = new THREE.Vector3(Infinity, Infinity, Infinity), tMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity), v = new THREE.Vector3();
      for (const m of this.meshes) {
        if (!m.isSkinnedMesh) continue;
        const n = m.geometry.attributes.position.count;
        for (let i = 0; i < n; i += 3) {
          m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
          if (v.y < abdP.y || v.y > neckP.y) continue;
          v.sub(chestP).applyQuaternion(toFrame);
          if (Math.abs(v.x) > half * 0.92) continue;
          tMin.min(v); tMax.max(v);
        }
      }
      tpl.torso = Number.isFinite(tMin.x)
        ? { cx: (tMin.x + tMax.x) / 2, cz: (tMin.z + tMax.z) / 2, w: tMax.x - tMin.x, d: tMax.z - tMin.z, back: tMin.z }
        : { cx: 0, cz: 0, w: half * 1.6, d: half * 0.9, back: -half * 0.45 };
    }
    const torso = tpl.torso, width = torso.w, height = (neckP.y - abdP.y) * 0.95;
    this.torso = torso;
    const place = (g, x, y, z) => {
      g.quaternion.copy(frame);
      g.position.set(x, 0, z).applyQuaternion(frame).add(chestP);
      g.position.y = y;
    };
    const headP = wp(b.head), topP = b.headTop ? wp(b.headTop) : headP.clone().add(new THREE.Vector3(0, 0.22, 0));
    const headH = topP.y - headP.y || 0.22;
    const r = headH * 0.62;
    const domeGeo = new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52);
    const brimGeo = new THREE.CylinderGeometry(r * 1.06, r * 1.1, r * 0.12, 18, 1, true);
    const vestGeo = new THREE.BoxGeometry(width * 1.1, height * 0.74, torso.d * 1.18);
    const pouchGeo = new THREE.BoxGeometry(width * 0.24, height * 0.17, torso.d * 0.2);
    const strapGeo = new THREE.BoxGeometry(width * 1.04, height * 0.06, torso.d * 1.12);
    const rollGeo = new THREE.CylinderGeometry(width * 0.16, width * 0.16, width * 0.95, 10).rotateZ(Math.PI / 2);
    for (let lv = 1; lv <= 3; lv++) {
      const mat = GEAR_MATS[lv - 1];
      const helmet = new THREE.Group();
      helmet.add(new THREE.Mesh(domeGeo, mat));
      const brim = new THREE.Mesh(brimGeo, mat);
      brim.position.y = r * 0.02;
      helmet.add(brim);
      helmet.position.set((headP.x + topP.x) / 2, headP.y + headH * 0.55, (headP.z + topP.z) / 2 + headH * 0.04);
      this._wear(helmet, b.head, "helmet");

      const vest = new THREE.Group();
      vest.add(new THREE.Mesh(vestGeo, mat));
      for (const x of [-0.3, 0, 0.3]) {
        const pouch = new THREE.Mesh(pouchGeo, lv === 3 ? STRAP_MAT : GEAR_MATS[Math.max(0, lv - 2)]);
        pouch.position.set(x * width, -height * 0.14, torso.d * 0.62);
        vest.add(pouch);
      }
      place(vest, torso.cx, abdP.y + height * 0.5, torso.cz);
      this._wear(vest, b.spine2, "vest");

      const depth = torso.d * (0.45 + 0.15 * lv);
      const pack = new THREE.Group();
      const bag = new THREE.Mesh(new THREE.BoxGeometry(width * 0.85, height * (0.62 + 0.1 * lv), depth), mat);
      bag.position.z = -depth / 2;
      pack.add(bag);
      const strap = new THREE.Mesh(strapGeo, STRAP_MAT);
      strap.position.set(0, height * 0.12, torso.cz - torso.back);
      pack.add(strap);
      if (lv === 3) {
        const roll = new THREE.Mesh(rollGeo, GEAR_MATS[1]);
        roll.position.set(0, height * (0.62 + 0.3) / 2 + width * 0.12, -depth / 2);
        pack.add(roll);
      }
      place(pack, torso.cx, abdP.y + height * 0.55, torso.back - torso.d * 0.02);
      this._wear(pack, b.spine2, "backpack");
    }
    // Where a slung gun sits: on the back, outside a backpack's straps
    this._backFrame = { frame, chestP: chestP.clone(), torso, height, abdY: abdP.y };
  }

  _wear(group, bone, slot) {
    group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    this.model.add(group);
    group.updateMatrixWorld(true);
    bone.attach(group);
    this.gearMeshes[slot].push(group);
    showPart(group, false);
  }

  setGear(levels) {
    for (const slot of ["helmet", "vest", "backpack"]) {
      const lv = levels?.[slot] ?? 0;
      if (this.gear[slot] === lv) continue;
      this.gear[slot] = lv;
      this.gearMeshes[slot].forEach((m, i) => showPart(m, i === lv - 1 && !(slot === "helmet" && this.firstPerson)));
    }
  }

  /** First person (indoors): the head the camera sits in shrinks away (it's part of the body mesh). */
  setFirstPerson(on) {
    if (this.firstPerson === on) return;
    this.firstPerson = on;
    if (this.b?.head) this.b.head.scale.setScalar(on ? 0.001 : 1);
    const lv = this.gear.helmet;
    this.gearMeshes.helmet.forEach((m, i) => showPart(m, i === lv - 1 && !on));
  }

  getHeadWorldPosition(out) {
    const bn = this.b?.head ?? this.root;
    bn.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(bn.matrixWorld);
  }

  // ── Guns: in the right hand (fitted to the aiming pose) and slung on the back
  _attachWeapons(smgScene) {
    const b = this.b;
    // Pose the skeleton the way the game layers a standing aim: the idle's legs and hips
    // under the aiming clip's upper body (the aim clip's own hips stand turned ~35° away)
    const tmp = new THREE.AnimationMixer(this.model);
    const aimU = this.clips.upper.get("aim"), idleL = this.clips.lower.get("idle");
    for (const [c, t] of [[aimU, 0.3], [idleL, 0]]) if (c) { const a = tmp.clipAction(c).play(); a.time = c.duration * t; }
    tmp.update(0);
    this.root.updateMatrixWorld(true);

    const hand = new THREE.Group();
    const scaleOf = obj => { const bb = new THREE.Box3().setFromObject(obj); const sz = bb.getSize(_v0); return WEAPON_LENGTH / Math.max(sz.x, sz.y, sz.z); };
    const gunScale = scaleOf(smgScene);
    const build = holder => {
      const out = {};
      const smg = smgScene.clone(true);
      smg.scale.multiplyScalar(gunScale);
      smg.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
      holder.add(smg);
      out.smg = { model: smg, muzzle: WEAPON_MUZZLE.clone().multiplyScalar(gunScale) };
      const grip = WEAPON_GRIP.clone().multiplyScalar(gunScale);
      for (const id of WEAPON_ORDER) {
        if (id === "smg") continue;
        const m = cloneItem(id);
        m.position.copy(grip);
        holder.add(m);
        out[id] = { model: m, muzzle: grip.clone().add(m.userData.muzzle) };
      }
      for (const g of Object.values(out)) showPart(g.model, false);
      return out;
    };
    const inHand = build(hand);
    hand.add(this.muzzle);

    // Every gun's barrel is its +X (the SMG model and ItemModels alike). The aim clip aims
    // straight ahead, so in this pose the barrel goes along the body's forward, level, with
    // the grip in the right palm. (Not along palm → left hand: the support hand sits well
    // off the barrel line in Mixamo's rifle poses, which turned the gun 45–65° to the left.)
    const palm = b.rHand.getWorldPosition(new THREE.Vector3());
    if (b.rPalm) palm.lerp(b.rPalm.getWorldPosition(_v1), 0.6);
    const toward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.root.getWorldQuaternion(_q0)).setY(0).normalize();
    const yAxis = _up.clone().sub(toward.clone().multiplyScalar(_up.dot(toward))).normalize();
    const zAxis = new THREE.Vector3().crossVectors(toward, yAxis);
    const gunQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(toward, yAxis, zAxis));
    this._gripLocal = WEAPON_GRIP.clone().multiplyScalar(gunScale);
    const gripOff = this._gripLocal.clone().applyQuaternion(gunQ);
    const gunWorld = new THREE.Matrix4().compose(palm.sub(gripOff), gunQ, new THREE.Vector3(1, 1, 1));
    const local = b.rHand.matrixWorld.clone().invert().multiply(gunWorld);
    local.decompose(hand.position, hand.quaternion, hand.scale);
    b.rHand.add(hand);
    this.weapon = hand;
    // The barrel in the hand's frame (the spine aim turns it onto the crosshair)
    this.barrel = new THREE.Vector3(1, 0, 0);
    tmp.stopAllAction();
    tmp.uncacheRoot(this.model);

    // Back sling, in the bind pose: muzzle down toward the right hip, top of the gun outward
    this.mixer.stopAllAction();
    for (const e of this.acts) e.a.stop();
    this._restPose();
    const back = new THREE.Group();
    const bf = this._backFrame;
    const barrel = new THREE.Vector3(-0.5, -0.86, 0).normalize().applyQuaternion(bf.frame);
    const outward = new THREE.Vector3(0, 0, -1).applyQuaternion(bf.frame);
    const bz = new THREE.Vector3().crossVectors(barrel, outward);
    const backQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(barrel, outward, bz));
    const centre = new THREE.Vector3(bf.torso.cx, 0, bf.torso.back - 0.07).applyQuaternion(bf.frame).add(bf.chestP);
    centre.y = bf.abdY + bf.height * 0.45;
    back.quaternion.copy(backQ);
    back.position.copy(centre).addScaledVector(barrel, -0.28);
    this.model.add(back);
    back.updateMatrixWorld(true);
    b.spine2.attach(back);
    const onBack = build(back);
    for (const id of Object.keys(inHand)) this.guns[id] = { model: inHand[id].model, back: onBack[id].model, muzzle: inHand[id].muzzle };
  }

  /** Bones back to their rest transforms. */
  _restPose() {
    for (const [bone, p, q, sc] of this._rest) { bone.position.copy(p); bone.quaternion.copy(q); bone.scale.copy(sc); }
    this.root.updateMatrixWorld(true);
  }

  /** The gun in the hand (null: empty hands). The one it replaces goes on the back, with a reach over the shoulder. */
  setWeapon(id) {
    if (id !== null && !this.guns[id]) return;
    const from = this.currentGun;
    if (from === id) { if (id) this.muzzle.position.copy(this.guns[id].muzzle); this._showGuns(); return; }
    if (from && id && this.mixer && !this.dead) this.swap = { t: 0, from, to: id, switched: false };
    if (from) this.backGun = from;
    this.currentGun = id;
    if (!this.swap) this._showGuns();
    if (id) this.muzzle.position.copy(this.guns[id].muzzle);
  }

  /** Which gun shows where: the held one in the hand (or on the back while the hands are busy), the other on the back. */
  _showGuns() {
    if (!this.mixer) return;
    const busy = this._handsBusy();
    const swapping = this.swap && !this.swap.switched;
    const inHand = busy ? null : swapping ? this.swap.from : this.currentGun;
    let onBack = busy ? this.currentGun ?? this.backGun : swapping ? this.swap.to : this.backGun;
    if (onBack === inHand) onBack = null;
    if (this._shown?.hand === inHand && this._shown?.back === onBack) return;
    this._shown = { hand: inHand, back: onBack };
    for (const [gid, g] of Object.entries(this.guns)) {
      showPart(g.model, gid === inHand);
      showPart(g.back, gid === onBack);
    }
  }

  _handsBusy() {
    const g = this.gesture;
    return this.seated || this.sw.swim > 0.5 || (g && GUN_AWAY.has(g.name)) || this.dead;
  }

  getMuzzleWorldPosition(out) { return this.muzzle.getWorldPosition(out); }

  // ── Events ─────────────────────────────────────────────────────────────────
  /**
   * info (optional): { from: "front" | "back" | "left" | "right", head } picks
   * the death; without it, one of the general ones.
   */
  die(info = null) {
    if (this.dead) return;
    this.dead = true;
    this.gesture = null;
    this.swap = null;
    let name = info?.from ? DEATHS[info.head && (info.from === "front" || info.from === "back") ? `head_${info.from}` : info.from] : null;
    if (!name || !this.F?.[name]) name = ["death", "dying", "death_front"][Math.floor(Math.random() * 3)];
    this.deathAct = this.F?.[name] ?? null;
    if (this.deathAct) {
      const a = this.deathAct.a;
      a.reset().setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.timeScale = 1;
    }
    this._showGuns();
  }

  revive() {
    this.dead = false;
    if (this.deathAct) { this.deathAct.a.setLoop(THREE.LoopRepeat, Infinity); this.deathAct.target = 0; }
    this.deathAct = null;
    this._showGuns();
  }

  /** Procedural one-shots: "interact" (a door, a switch, a pickup), "hit" / "hit2" (a flinch). */
  playClip(key, dur = null, weight = 1) {
    if (this.dead) return;
    this.oneShot = { name: key, t: 0, dur: dur ?? 0.6, weight };
  }

  /**
   * A move that takes dur seconds: "reload", "throw", "eat" / "drink" / "heal",
   * "climb", "vault" (clips), or "swap" (handled by setWeapon).
   */
  playGesture(name, dur) {
    if (this.dead) return;
    this.gesture = { name, t: 0, dur: Math.max(0.2, dur) };
    const o = OVERLAY[name] && this.O[OVERLAY[name]];
    if (o) o.a.reset();
    const f = (name === "climb" || name === "vault") && this.F.climb;
    if (f) f.a.reset();
    this._showGuns();
  }

  /** Something held in the right hand while a gesture plays (a Parle-G packet while eating). */
  setHandProp(gesture, obj) {
    obj.userData.baseScale ??= obj.scale.clone();
    obj.scale.copy(obj.userData.baseScale);
    obj.visible = false;
    obj.traverse(o => { if (o.isMesh) o.castShadow = false; });
    this.b?.rHand?.add(obj);
    obj.position.set(0, 0.08 / (this.model?.scale.x || 1), 0.04 / (this.model?.scale.x || 1));
    obj.scale.multiplyScalar(1 / (this.model?.scale.x || 1));
    this.handProps[gesture] = obj;
  }

  stopGesture(name = null) {
    if (!name || this.gesture?.name === name) this.gesture = null;
    this._showGuns();
  }

  // ── Every frame ────────────────────────────────────────────────────────────
  /**
   * s: { localForward, localRight (m/s, the body's frame), aiming (bool),
   *      firing, aimYawOffset, aimPitch, health 0..1, air 0..1 (airborne),
   *      swim (bool), throwHold (bool: the throw is wound up), noSpine }
   */
  update(delta, s) {
    if (!this.mixer) return;
    // The rest of the clips arrived (deaths, swimming, climbing…): their actions too
    if (this.anims.version !== this._actsVersion) {
      this.clips = clipSetFor(this.tpl, this.anims);
      this._buildActions();
    }
    const dt = Math.min(delta, 0.1);
    const g = this.gesture;
    if (g) { g.t += dt; if (g.t >= g.dur) { this.gesture = null; this._showGuns(); } }
    const os = this.oneShot;
    if (os) { os.t += dt; if (os.t >= os.dur) this.oneShot = null; }
    if (this.swap) {
      this.swap.t += dt;
      if (!this.swap.switched && this.swap.t >= SWAP_TIME * 0.5) { this.swap.switched = true; this._showGuns(); }
      if (this.swap.t >= SWAP_TIME) { this.swap = null; this._showGuns(); }
    }
    for (const n in this.handProps) this.handProps[n].visible = this.gesture?.name === n;
    this.woundW += ((1 - THREE.MathUtils.smoothstep(s.health ?? 1, 0.22, 0.6)) - this.woundW) * (1 - Math.exp(-3 * dt));

    // Stances
    // (swimming clips come with the extra set: until then, the standing ones)
    const want = s.swim && this.F.tread ? "swim" : this.seated ? "stand" : this.stance;
    for (const k in this.sw) {
      spring2(this.sw, this.swv, k, k === want ? 1 : 0, STANCE_RATE, dt);
    }
    const wasBusy = this._busyFlag;
    this._busyFlag = this._handsBusy();
    if (wasBusy !== this._busyFlag) this._showGuns();

    for (const e of this.acts) e.target = 0;
    const speed = Math.hypot(s.localForward, s.localRight);
    const armed = !!this.currentGun && !this._busyFlag;
    const aimTarget = armed && (s.aiming || (g && g.name === "reload")) ? 1 : 0;
    spring(this, "aimWeight", "aimV", aimTarget, AIM_RATE, dt);
    this.aimWeight = THREE.MathUtils.clamp(this.aimWeight, 0, 1);
    this.shootWeight += ((s.firing && armed ? 1 : 0) - this.shootWeight) * (1 - Math.exp(-20 * dt));

    if (this.dead) {
      if (this.deathAct) this.deathAct.target = 1;
      this._blend(dt, 9);
      this.mixer.update(dt);
      return;
    }

    // ── Base: lower body by speed and direction; upper body rifle or the same clips
    const base = this.sw.stand + this.sw.crouch;
    const angle = speed > 0.15 ? Math.atan2(s.localRight, s.localForward) : 0;
    if (speed < 0.15) this.backwards = false;
    else if (Math.abs(angle) > BACK_IN) this.backwards = true;
    else if (Math.abs(angle) < BACK_OUT) this.backwards = false;
    const backwards = this.backwards;
    const idleW = 1 - THREE.MathUtils.smoothstep(speed, 0.12, 0.7);
    const crouch = this.sw.crouch / (base || 1);
    const standW = (1 - crouch) * base, crouchW = crouch * base;
    const tgt = this._tgt ??= {};
    for (const k in tgt) tgt[k] = 0;
    const add = (name, w) => { if (w > 1e-4) tgt[name] = (tgt[name] ?? 0) + w; };
    const restName = armed ? "idle" : "relax";
    add(restName, idleW * standW);
    add("crouch_idle", idleW * crouchW);
    const move = 1 - idleW;
    // Cycles per second that put a clip's stride on the ground speed
    const stride = n => this.clipSpeed(n) * (this.L[n]?.dur ?? 1);
    let freq = 0;
    if (move > 0) {
      if (!backwards) {
        const t1 = THREE.MathUtils.smoothstep(speed, 1.7, 4.4), t2 = THREE.MathUtils.smoothstep(speed, 5.8, 7.6);
        const wWalk = (1 - t1), wRun = t1 * (1 - t2), wSprint = t1 * t2;
        add("walk", wWalk * move * standW); add("run", wRun * move * standW); add("sprint", wSprint * move * standW);
        add("crouch_walk", move * crouchW);
        freq = (wWalk / stride("walk") + wRun / stride("run") + wSprint / stride("sprint")) * speed * (1 - crouch)
          + crouch * speed / stride("crouch_walk");
      } else {
        const runBack = THREE.MathUtils.smoothstep(speed, 1.9, 3.2);
        add("walk_back", (1 - runBack) * move * standW);
        add("run_rev", runBack * move * standW);
        add("crouch_rev", move * crouchW);
        freq = speed * ((1 - crouch) * ((1 - runBack) / stride("walk_back") + runBack / stride("run")) + crouch / stride("crouch_walk"));
      }
      freq = Math.min(freq, 3.2);
    }
    // Eased: starting off picks the stride up, stopping lets the step finish instead of freezing it
    spring(this, "freq", "freqV", freq, 10, dt);
    this.phase = (this.phase + dt * Math.max(0, this.freq)) % 1;
    const fp = this.footPhase ?? {};
    for (const name of [restName, "crouch_idle", ...LOCO]) {
      const L = this.L[name];
      if (!L) continue;
      L.target = tgt[name] ?? 0;
      // Every stepping clip runs on the one phase, lined up by footfall (fading-out ones too)
      if (LOCO.includes(name)) {
        L.manual = true;
        const src = name === "run_rev" ? "run" : name === "crouch_rev" ? "crouch_walk" : name;
        const off = fp[src] ?? 0;
        const k = name === src ? this.phase + off : off - this.phase;
        L.time = (k - Math.floor(k)) * L.dur;
      } else L.manual = false;
    }
    // Hips turn toward a sideways move (the spine turns back to the aim below)
    const yawTarget = move > 0.3 && this.sw.prone < 0.5 && this.sw.swim < 0.5
      ? THREE.MathUtils.clamp(backwards ? wrapAngle(angle - Math.PI) : angle, -HIP_YAW_MAX, HIP_YAW_MAX) : 0;
    spring(this, "hipYaw", "hipYawV", yawTarget, 9, dt);

    // Upper body: overlays first (they take a share of it)
    let overlay = 0, overlayAct = null, overlayTime = 0;
    if (g && OVERLAY[g.name] && this.O[OVERLAY[g.name]]) {
      overlayAct = this.O[OVERLAY[g.name]];
      const k = g.t / g.dur;
      overlay = Math.min(1, g.t / 0.15, (g.dur - g.t) / 0.25);
      if (g.name === "reload") overlayTime = k * overlayAct.dur;
      else if (g.name === "throw") overlayTime = THREE.MathUtils.lerp(SEG.throwFrom, SEG.throwTo, k) * overlayAct.dur;
      else overlayTime = THREE.MathUtils.lerp(SEG.drinkFrom, SEG.drinkTo, k) * overlayAct.dur;
    } else if (s.throwHold && this.O.throw) {
      overlayAct = this.O.throw;
      overlay = 1;
      overlayTime = SEG.throwHold * overlayAct.dur;
    }
    this._throwHoldW = s.throwHold ? 1 : 0;
    if (overlayAct) { overlayAct.target = overlay; overlayAct.manual = true; overlayAct.time = overlayTime; }
    const upperRest = 1 - overlay;
    if (armed) {
      const aim = aimTarget, shoot = s.firing ? 1 : 0;
      if (this.R.idle) this.R.idle.target = (1 - aim) * upperRest * base;
      if (this.R.aim) this.R.aim.target = aim * (1 - shoot) * upperRest * base;
      if (this.R.fire) this.R.fire.target = aim * shoot * upperRest * base;
    } else {
      for (const name of [restName, "crouch_idle", ...LOCO]) {
        const U = this.U[name];
        if (!U) continue;
        U.target = (tgt[name] ?? 0) * upperRest;
        U.manual = this.L[name]?.manual ?? false;
        U.time = this.L[name]?.time ?? 0;
      }
    }

    // Whole-body stances: prone and swimming
    const crawlRate = n => Math.min(3, speed / Math.max(0.05, this.clipSpeed(n)));
    if (this.sw.prone > 1e-3) {
      const mv = THREE.MathUtils.smoothstep(speed, 0.08, 0.3);
      const pi = this.F.prone_idle, pc = this.F.prone_crawl;
      if (pi) pi.target = this.sw.prone * (1 - mv);
      if (pc) { pc.target = this.sw.prone * mv; pc.a.timeScale = (backwards ? -1 : 1) * Math.max(0.6, crawlRate("prone_crawl")); }
    }
    if (this.sw.swim > 1e-3) {
      const mv = THREE.MathUtils.smoothstep(speed, 0.2, 0.7);
      if (this.F.tread) this.F.tread.target = this.sw.swim * (1 - mv);
      if (this.F.swim) { this.F.swim.target = this.sw.swim * mv; this.F.swim.a.timeScale = Math.max(0.7, crawlRate("swim")); }
    }

    // ── Overrides: jump / landing, climb / vault
    const override = this._overrides(dt, s, armed);
    if (override.w > 0) {
      const keepUpper = override.lowerOnly;
      for (const e of this.acts) {
        if (e === override.act) continue;
        const isUpper = e.key in UPPER_KEYS || e.key.startsWith("o_") || e.key === "rifle" || e.key === "aim" || e.key === "fire";
        if (keepUpper && isUpper) continue;
        e.target *= 1 - override.w;
      }
      override.act.target = override.w;
      override.act.manual = true;
      override.act.time = override.time;
    }

    this._blend(dt, BLEND_RATE);
    this.mixer.update(dt);
    this._procedural(dt, s, armed, speed);
  }

  /** Jump and landing (from s.air), climb and vault (gestures). → { act, w, time, lowerOnly } */
  _overrides(dt, s, armed) {
    const g = this.gesture;
    const none = { act: null, w: 0, time: 0, lowerOnly: false };
    if (g && (g.name === "climb" || g.name === "vault") && this.F.climb) {
      const k = g.t / g.dur;
      const [a, b] = g.name === "climb" ? [SEG.climbFrom, SEG.climbTo] : [SEG.vaultFrom, SEG.vaultTo];
      return { act: this.F.climb, w: Math.min(1, g.t / 0.12, (g.dur - g.t) / 0.2), time: THREE.MathUtils.lerp(a, b, k) * this.F.climb.dur, lowerOnly: false };
    }
    if (this.sw.prone > 0.5 || this.sw.swim > 0.5 || this.seated) { this.air.on = false; this.air.land = null; return none; }
    const air = this.air, inAir = (s.air ?? 0) > 0.5;
    const pick = name => (armed ? this.FL[name] : this.F[name]) ?? this.F[name];
    if (inAir) {
      if (!air.on) { air.on = true; air.t = 0; air.land = null; }
      air.t += dt;
      const j = pick("jump");
      if (!j) return none;
      const k = Math.min(1, air.t / 0.35);
      const time = THREE.MathUtils.lerp(SEG.jumpUp, SEG.jumpApex, k) * j.dur;
      return { act: j, w: Math.min(1, air.t / 0.08), time, lowerOnly: armed };
    }
    if (air.on) {
      // Touchdown: a long fall lands hard (a crouch on impact), a hop just bends the knees
      air.on = false;
      air.land = { t: 0, hard: air.t > 1.1 };
      air.land.dur = air.land.hard ? 0.85 : 0.32;
    }
    if (air.land) {
      const L = air.land;
      L.t += dt;
      if (L.t >= L.dur) { air.land = null; return none; }
      const act = L.hard ? pick("land") : pick("jump");
      if (!act) return none;
      const k = L.t / L.dur;
      const [a, b] = L.hard ? [SEG.landFrom, SEG.landTo] : [SEG.jumpLand, SEG.jumpEnd];
      return { act, w: Math.min(1, (L.dur - L.t) / 0.18), time: THREE.MathUtils.lerp(a, b, k) * act.dur, lowerOnly: armed };
    }
    return none;
  }

  /** Eases every action toward its target; plays the ones with weight, stops the rest. */
  _blend(dt, rate) {
    for (const e of this.acts) {
      spring(e, "w", "v", e.target, e.rate ?? rate, dt);
      if (e.w < 0) { e.w = 0; e.v = 0; }
      if (e.target === 0 && e.w < 0.002) { e.w = 0; e.v = 0; }
      const a = e.a;
      if (e.w > 0) {
        if (!e.playing) { a.play(); e.playing = true; }
        a.setEffectiveWeight(e.w);
        if (e.manual) { a.time = e.time; a.timeScale = 0; }
        else if (a.timeScale === 0) a.timeScale = 1;
      } else if (e.playing) {
        a.stop();
        e.playing = false;
      }
    }
  }

  /**
   * The support hand onto the gun (two-bone IK on the left arm): bend the elbow so the
   * wrist can reach the gun's support point, then swing the upper arm to it. Off while
   * the left hand is doing something else (reload, throw, eat, swap, swim).
   */
  _leftHandIK(dt, armed) {
    const b = this.b, g = this.gesture, sup = SUPPORT[this.currentGun];
    const on = armed && sup && !this.swap && !(g && OVERLAY[g.name]) && this.sw.swim < 0.5 && !this.dead;
    const st = this._ik ??= { w: 0, v: 0 };
    spring(st, "w", "v", on ? 1 : 0, 14, dt);
    const w = Math.min(1, st.w);
    if (w < 0.01 || !sup || !b.lArm || !b.lFore || !b.lHand || !this.weapon) return;
    // Target: along the barrel from the grip, under the bore
    this.weapon.getWorldQuaternion(_q1);
    const dir = _v0.set(1, 0, 0).applyQuaternion(_q1);
    const down = _v1.set(0, -1, 0).applyQuaternion(_q1);
    const T = this.weapon.localToWorld(_v2.copy(this._gripLocal)).addScaledVector(dir, sup.along).addScaledVector(down, sup.below);
    const A = b.lArm.getWorldPosition(_v3), B = b.lFore.getWorldPosition(_v4), C = b.lHand.getWorldPosition(_v5);
    const la = A.distanceTo(B), lb = B.distanceTo(C);
    const d = THREE.MathUtils.clamp(A.distanceTo(T), Math.abs(la - lb) + 1e-3, la + lb - 1e-3);
    // Elbow: the angle at B that puts the wrist d from the shoulder
    const ba = _v6.subVectors(A, B).normalize(), bc = _v7.subVectors(C, B).normalize();
    const cur = Math.acos(THREE.MathUtils.clamp(ba.dot(bc), -1, 1));
    const want = Math.acos(THREE.MathUtils.clamp((la * la + lb * lb - d * d) / (2 * la * lb), -1, 1));
    const axis = _v8.crossVectors(bc, ba);
    if (axis.lengthSq() > 1e-8) {
      _qStep.setFromAxisAngle(axis.normalize(), (cur - want) * w);
      rotateBoneInWorld(b.lFore, _qStep);
    }
    // Shoulder: swing the arm so shoulder → wrist points at the target
    b.lHand.getWorldPosition(C);
    _qStep.setFromUnitVectors(_v6.subVectors(C, A).normalize(), _v7.subVectors(T, A).normalize());
    rotateBoneInWorld(b.lArm, _q3.identity().slerp(_qStep, w));   // (_q0 / _q1 are rotateBoneInWorld's own)
  }

  // ── Procedural layer (after the clips) ─────────────────────────────────────
  _procedural(dt, s, armed, speed) {
    const b = this.b;
    this.root.getWorldQuaternion(_q2);
    const side = _v0.copy(_xAxis).applyQuaternion(_q2);          // the body's left (+x), right-handed
    const fwd = _v1.set(0, 0, 1).applyQuaternion(_q2);

    // Strafing: hips toward the move, chest back toward the aim
    if (Math.abs(this.hipYaw) > 1e-3) {
      turnBone(b.hips, _up, this.hipYaw);
      turnBone(b.spine, _up, -this.hipYaw * 0.55);
      turnBone(b.spine1, _up, -this.hipYaw * 0.45);
    }

    // Driving: thighs forward, shins down
    if (this.seated) {
      for (const leg of [b.lUpLeg, b.rUpLeg]) turnBone(leg, side, -1.45);
      for (const leg of [b.lLeg, b.rLeg]) turnBone(leg, side, 1.5);
    }

    // Badly hurt: hunched, a limp
    const wound = this.woundW * this.sw.stand;
    if (wound > 0.01) {
      turnBone(b.spine1, side, 0.22 * wound);
      turnBone(b.neck, side, 0.18 * wound);
      if (speed > 0.5) turnBone(b.rUpLeg, side, 0.25 * wound * Math.max(0, Math.sin(this.phase * Math.PI * 2)));
    }

    // The gun onto the aim: turn the spine so the barrel points where the camera looks.
    // Yaw about the world's up and pitch about the level axis across the aim, never the
    // shortest arc (that rolls the shoulders). Weighted by how far the aim pose has
    // actually blended in, so the correction never runs ahead of the clip.
    const rifle = (this.R.aim?.w ?? 0) + (this.R.fire?.w ?? 0);
    const posed = THREE.MathUtils.smoothstep(Math.min(1, rifle / Math.max(0.3, this.sw.stand + this.sw.crouch)), 0, 0.75);
    const aimW = posed * (this.sw.stand + this.sw.crouch + this.sw.prone * 0.6) * (this.swap ? 0.4 : 1);
    if (armed && aimW > 0.01 && !s.noSpine && this.weapon) {
      // Followed by a very quick spring: a flick of the mouse turns the chest, not a one-frame snap
      // Aim at the point under the crosshair (seen from the gun), else along the camera
      let yawIn = s.aimYawOffset ?? 0, pitchIn = s.aimPitch ?? 0;
      if (s.aimPoint) {
        const d = this.weapon.getWorldPosition(_v3).sub(s.aimPoint).negate().applyQuaternion(_q0.copy(_q2).invert());
        yawIn = Math.atan2(d.x, d.z);
        pitchIn = Math.atan2(d.y, Math.hypot(d.x, d.z));
      }
      const st = this._aimS ??= { y: yawIn, yv: 0, p: pitchIn, pv: 0 };
      spring(st, "y", "yv", yawIn, 32, dt);
      spring(st, "p", "pv", pitchIn, 32, dt);
      const pitch = THREE.MathUtils.clamp(st.p, AIM_PITCH[0] * (this.sw.prone > 0.5 ? 0.3 : 1), AIM_PITCH[1]);
      const yaw = st.y;
      // Desired barrel direction in world space (body frame: yaw about up, then pitch)
      const want = _v2.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).applyQuaternion(_q2);
      const wantYaw = Math.atan2(want.x, want.z), wantPitch = Math.asin(THREE.MathUtils.clamp(want.y, -1, 1));
      const across = _v4.set(want.z, 0, -want.x).normalize();   // level, across the aim (pitching about it raises the barrel)
      // A few passes: turning the spine also swings the gun round the chest, so one
      // pass leaves a remainder when the clip's gun is far off (strafing, firing)
      for (let iter = 0; iter < 3; iter++) {
        this.weapon.getWorldQuaternion(_q1);
        const cur = _v3.copy(this.barrel).applyQuaternion(_q1);
        const flat = Math.hypot(cur.x, cur.z);
        const k = aimW;
        const dYaw = flat > 0.2 ? THREE.MathUtils.clamp(wrapAngle(wantYaw - Math.atan2(cur.x, cur.z)), -0.9, 0.9) * k : 0;
        const dPitch = THREE.MathUtils.clamp(wantPitch - Math.asin(THREE.MathUtils.clamp(cur.y, -1, 1)), -0.9, 0.9) * k;
        turnBone(b.spine, _up, dYaw * 0.3);
        turnBone(b.spine1, _up, dYaw * 0.35);
        turnBone(b.spine2, _up, dYaw * 0.35);
        turnBone(b.spine1, across, -dPitch * 0.5);
        turnBone(b.spine2, across, -dPitch * 0.5);
      }
    }

    this._leftHandIK(dt, armed);
    side.copy(_xAxis).applyQuaternion(_q2);   // (the IK used these vectors)
    fwd.set(0, 0, 1).applyQuaternion(_q2);

    // Swapping guns: the right hand reaches over the shoulder to the sling and back
    if (this.swap) {
      const k = this.swap.t / SWAP_TIME;
      const reach = Math.sin(Math.min(1, k) * Math.PI);
      turnBone(b.rArm, side, -1.9 * reach);
      turnBone(b.rArm, _up, -0.5 * reach);
      turnBone(b.rFore, side, -1.2 * reach);
    }

    // Procedural one-shots: reach for a door / switch, flinch when hit
    const os = this.oneShot;
    if (os) {
      const k = os.t / os.dur, w = bump(k, 0, 1, 0.25) * os.weight;
      if (os.name === "interact") {
        turnBone(b.rArm, side, -1.0 * w);
        turnBone(b.rFore, side, -0.4 * w);
      } else {
        const hard = os.name === "hit2" ? 1.6 : 1;
        turnBone(b.spine1, side, -0.22 * w * hard);
        turnBone(b.neck, side, -0.25 * w * hard);
        turnBone(b.spine, fwd, 0.08 * w * hard);
      }
    }
  }
}

// Action keys that belong to the upper body (kept when a jump only takes the legs)
const UPPER_KEYS = { rifle: 1, aim: 1, fire: 1, o_reload: 1, o_throw: 1, o_drink: 1 };
