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
//   overlays   upper body, faded in and out: reload, drink / eat / heal.
//   overrides  whole body (legs only with a gun up): jump take-off, air and
//              landing, hard landing after a long fall, climb / vault, death
//              (picked by where the shot came from).
//   procedural after the clips: the spine turns the gun onto the aim, hips
//              turned for strafing, legs bent in a driving seat, the right
//              hand (arm IK) putting guns into the back slings and drawing
//              them, and the whole throw (gun away, the throwable out of the
//              pouch, pin, wind-up, swing, follow-through, gun back), a
//              wounded hunch, a flinch when hit, the hand reaching for a door.
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
// Guns into and out of the back sling, throwables out of the hip pouch (s). The right hand
// is driven along curves by arm IK; a gun follows the hand and settles exactly into the sling
const HOLSTER_TIME = 0.3;   // the held gun over the shoulder into the sling
const DRAW_TIME    = 0.36;  // a gun off the sling, over the shoulder into both hands
export const SWAP_TIME = HOLSTER_TIME + DRAW_TIME;
const REACH_TIME   = 0.22;  // the empty hand back to the sling (after a throw)
const FETCH_TIME   = 0.5;   // to the pouch, the throwable out, the pin pulled in front of the chest, up into the wind-up
export const THROW_RECOVER = REACH_TIME + DRAW_TIME * 0.75;   // s after the throw gesture until the gun is up again
// The throw itself is procedural (the Mixamo throw is a full-body pitch with no overhand
// wind-up): over the shoulder to the release point in front of the head by this fraction of
// the gesture, then the follow-through across to the left hip
const THROW_RELEASE = 0.36;
/** Seconds the parachute landing plays (main.js holds you still for most of it). */
export const LAND_FROM_HEIGHT = 1.35;
// Clip segments (fractions of the clip) used for the game's moves
const SEG = {
  drinkFrom: 0.22, drinkTo: 0.62,
  climbFrom: 0.2, climbTo: 0.98, vaultFrom: 0.32, vaultTo: 0.85,
  jumpUp: 0.32, jumpApex: 0.5, jumpLand: 0.7, jumpEnd: 0.95,
  landFrom: 0.45, landTo: 0.95,
  chuteFrom: 0.26, chuteTo: 0.96,   // the landing from height: the last of the fall, the impact crouch, standing up
};
// Gestures with nothing in the hands: the gun goes on the back meanwhile
// (throwing stows the gun itself: see _updateToss)
const GUN_AWAY = new Set(["eat", "drink", "heal", "vault", "climb"]);
// Upper-body clip overlays (gesture → clip)
const OVERLAY = { reload: "reload", eat: "drink", drink: "drink", heal: "drink" };
const DEATHS = { front: "death_front", back: "death_back", right: "death_right", left: "death", head_front: "death_head_front", head_back: "death_head_back" };

const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _qStep = new THREE.Quaternion();
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3(), _v7 = new THREE.Vector3(), _v8 = new THREE.Vector3();
const _m0 = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0), _xAxis = new THREE.Vector3(1, 0, 0);
const GEAR_MATS = [0x5b6338, 0x9a8458, 0x2a2c2f].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0.05 }));
const STRAP_MAT = new THREE.MeshStandardMaterial({ color: 0x1d1e1c, roughness: 0.9 });

// Detailed helmets and backpacks (items/GearModels.js), once they've loaded; every soldier
// with a body re-fits its gear then (until then, and for any that's missing, the stand-ins)
let _gearModels = null;
const _live = new Set();
export function setGearModels(lib) {
  _gearModels = lib;
  for (const s of _live) s._rebuildGear();
}

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

const _ia = new THREE.Vector3(), _ib = new THREE.Vector3(), _ic = new THREE.Vector3(), _id = new THREE.Vector3(), _ie = new THREE.Vector3(), _if = new THREE.Vector3();
const _iq = new THREE.Quaternion(), _iq2 = new THREE.Quaternion();
/**
 * Two-bone IK: bends the elbow so the wrist can reach T (world), swings the upper arm onto
 * it, then turns the arm round the shoulder → target line so the elbow points along pole
 * (a world direction), by pw. w blends it all over the clip's pose.
 */
function armIK(upper, fore, hand, T, w, pole = null, pw = 1) {
  if (!upper || !fore || !hand || w < 0.01) return;
  const A = upper.getWorldPosition(_ia), B = fore.getWorldPosition(_ib), C = hand.getWorldPosition(_ic);
  const la = A.distanceTo(B), lb = B.distanceTo(C);
  const d = THREE.MathUtils.clamp(A.distanceTo(T), Math.abs(la - lb) + 1e-3, la + lb - 1e-3);
  const ba = _id.subVectors(A, B).normalize(), bc = _ie.subVectors(C, B).normalize();
  const cur = Math.acos(THREE.MathUtils.clamp(ba.dot(bc), -1, 1));
  const want = Math.acos(THREE.MathUtils.clamp((la * la + lb * lb - d * d) / (2 * la * lb), -1, 1));
  const axis = _if.crossVectors(bc, ba);
  if (axis.lengthSq() > 1e-8) rotateBoneInWorld(fore, _iq.setFromAxisAngle(axis.normalize(), (cur - want) * w));
  hand.getWorldPosition(C);
  _iq.setFromUnitVectors(_id.subVectors(C, A).normalize(), _ie.subVectors(T, A).normalize());
  rotateBoneInWorld(upper, _iq2.identity().slerp(_iq, w));
  if (!pole || pw < 0.01) return;
  const line = _id.subVectors(T, A).normalize();
  const e = _ie.subVectors(fore.getWorldPosition(B), A);
  e.addScaledVector(line, -e.dot(line));
  const p = _if.copy(pole).addScaledVector(line, -pole.dot(line));
  if (e.lengthSq() < 1e-8 || p.lengthSq() < 1e-8) return;
  e.normalize(); p.normalize();
  const ang = Math.atan2(_ic.crossVectors(e, p).dot(line), e.dot(p));
  rotateBoneInWorld(upper, _iq.setFromAxisAngle(line, ang * w * pw));
}

/** Quadratic Bézier a → b pulled toward c (out must not be one of them). */
function bezier(out, a, c, b, u) {
  const v = 1 - u;
  return out.set(0, 0, 0).addScaledVector(a, v * v).addScaledVector(c, 2 * u * v).addScaledVector(b, u * u);
}
const ease = u => { u = THREE.MathUtils.clamp(u, 0, 1); return u * u * (3 - 2 * u); };
const _h = Array.from({ length: 14 }, () => new THREE.Vector3());
const _hq0 = new THREE.Quaternion(), _hq1 = new THREE.Quaternion(), _hm0 = new THREE.Matrix4();

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
    this.carried = null;          // guns actually carried (null: not told, anything goes)
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
    this.swap = null;             // { t, from, to, switched, start, grab }: holster one gun, draw the other
    this.toss = null;             // { phase, t, gun, kind, start, grab, g }: a grenade / smoke / molotov in hand
    this.tossKind = "grenade";    // what a throw without a hold (someone else's) shows in the hand
    this._lastHand = new THREE.Vector3();   // where the right hand was last driven (the body's frame)
    this._ikOn = false;
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
    _live.add(this);
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
    for (const obj of Object.values(this._tossProps ?? {})) obj.removeFromParent();
    this._tossProps = null; this._propShown = null;
    this.toss = null;
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
      const layer = map === full ? "f" : map === lower ? "l" : "u";
      const e = { a, w: 0, v: 0, target: 0, dur: clip.duration, key, layer, playing: false };
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
      const hm = _gearModels?.[`helmet${lv}`];
      const domeX = (headP.x + topP.x) / 2, domeY = headP.y + headH * 0.55, domeZ = (headP.z + topP.z) / 2 + headH * 0.04;
      if (hm) {
        // The real helmet: a little wider than the head, its crown where the dome's is
        const k = (r * 2.25) / Math.max(hm.size.x, hm.size.z) * hm.fit;
        const m = hm.model.clone(true);
        m.scale.setScalar(k);
        helmet.add(m);
        helmet.quaternion.copy(frame);
        helmet.position.set(domeX, domeY + r * 1.02 - hm.size.y * k, domeZ);
      } else {
        helmet.add(new THREE.Mesh(domeGeo, mat));
        const brim = new THREE.Mesh(brimGeo, mat);
        brim.position.y = r * 0.02;
        helmet.add(brim);
        helmet.position.set(domeX, domeY, domeZ);
      }
      this._wear(helmet, b.head, "helmet");

      const vest = new THREE.Group();
      const vm = _gearModels?.[`vest${lv}`];
      if (vm) {
        // The real vest, worn over this torso: waist to the top of the shoulders, out past the
        // chest and back, and across to the shoulders (the measured torso is the body itself)
        const m = vm.model.clone(true);
        const span = neckP.y - abdP.y;
        m.scale.set(Math.max(width * 1.25, half * 2) / vm.size.x, span * 1.25 / vm.size.y, torso.d * 1.45 / vm.size.z).multiplyScalar(vm.fit);
        vest.add(m);
        place(vest, torso.cx, abdP.y + span * 0.55, torso.cz);
        this._vestBack = torso.d * 0.22;   // how far its back plate stands off the back
      } else {
        vest.add(new THREE.Mesh(vestGeo, mat));
        for (const x of [-0.3, 0, 0.3]) {
          const pouch = new THREE.Mesh(pouchGeo, lv === 3 ? STRAP_MAT : GEAR_MATS[Math.max(0, lv - 2)]);
          pouch.position.set(x * width, -height * 0.14, torso.d * 0.62);
          vest.add(pouch);
        }
        place(vest, torso.cx, abdP.y + height * 0.5, torso.cz);
      }
      this._wear(vest, b.spine2, "vest");

      const depth = torso.d * (0.45 + 0.15 * lv);
      const pack = new THREE.Group();
      const pm = _gearModels?.[`backpack${lv}`];
      if (pm) {
        // The real pack at its own proportions, bigger by level (the biggest nearly the width of
        // the back, waist to shoulders): its back panel flat on the back, centred on the spine,
        // carried by the mid spine (the chest bone leans and twists the most when aiming)
        const k = Math.min(width * (0.78 + 0.1 * (lv - 1)) / pm.bag.w, height * (0.7 + 0.12 * (lv - 1)) / pm.bag.h) * pm.fit;
        const m = pm.model.clone(true);
        m.scale.setScalar(k);
        // (a holder, so a vest under it can push it out: setGear)
        const holder = new THREE.Group();
        holder.add(m);
        pack.add(holder);
        pack.userData.holder = holder;
        place(pack, torso.cx, abdP.y + height * 0.5, torso.back + 0.01);
        this._wear(pack, b.spine1, "backpack");
        continue;
      }
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

  /** This body is gone for good (a player who left): it stops taking gear updates. */
  release() { _live.delete(this); }

  /**
   * Builds the gear again (the detailed models arrived), measured off the bind pose with
   * the body at the origin facing +Z, as at load; then back to how it was.
   */
  _rebuildGear() {
    if (!this.model) return;
    const levels = { ...this.gear }, fp = this.firstPerson;
    for (const list of Object.values(this.gearMeshes)) for (const g of list) { g.removeFromParent(); g.userData.home = null; }
    this.gearMeshes = { helmet: [], vest: [], backpack: [] };
    this.gear = { helmet: 0, vest: 0, backpack: 0 };
    const root = this.root, pos = root.position.clone(), quat = root.quaternion.clone(), parent = root.parent;
    parent?.remove(root);
    root.position.set(0, 0, 0);
    root.quaternion.identity();
    this.firstPerson = false;
    this._restPose();
    this._buildGear();
    root.position.copy(pos);
    root.quaternion.copy(quat);
    parent?.add(root);
    root.updateMatrixWorld(true);
    this.setGear(levels);
    this.setFirstPerson(fp);
  }

  _wear(group, bone, slot) {
    group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    // Placed in world space (metres): attached from there, not added under the model first
    // (its 0.01 scale would read those metres as centimetres: tiny, at the feet)
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
    // A detailed vest's back plate under the backpack: the pack sits on it, not in it
    const shift = this.gear.vest && _gearModels?.[`vest${this.gear.vest}`] ? this._vestBack ?? 0 : 0;
    for (const g of this.gearMeshes.backpack) if (g.userData.holder) g.userData.holder.position.z = -shift;
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

    // Back slings, in the bind pose: diagonal across the back, the grip up behind the right
    // shoulder (where the right hand reaches over for it), muzzle down toward the left hip,
    // top of the gun outward. The second one sits just outside the first: the gun put away
    // for a throw while the spare stays slung.
    this._holdLocal = { p: hand.position.clone(), q: hand.quaternion.clone(), s: hand.scale.clone() };
    this.mixer.stopAllAction();
    for (const e of this.acts) e.a.stop();
    this._restPose();
    const bf = this._backFrame;
    const barrel = new THREE.Vector3(0.5, -0.86, 0).normalize().applyQuaternion(bf.frame);
    const outward = new THREE.Vector3(0, 0, -1).applyQuaternion(bf.frame);
    const bz = new THREE.Vector3().crossVectors(barrel, outward);
    const backQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(barrel, outward, bz));
    const centre = new THREE.Vector3(bf.torso.cx, 0, bf.torso.back - 0.07).applyQuaternion(bf.frame).add(bf.chestP);
    centre.y = bf.abdY + bf.height * 0.45;
    this.slings = [];
    const onBack = [0, 1].map(i => {
      const back = new THREE.Group();
      back.quaternion.copy(backQ);
      back.position.copy(centre).addScaledVector(barrel, -0.28 + i * 0.05).addScaledVector(outward, i * 0.07);
      b.spine2.attach(back);   // (from world space, like the gear)
      this.slings.push(back);
      return build(back);
    });
    for (const id of Object.keys(inHand)) this.guns[id] = { model: inHand[id].model, back: onBack.map(o => o[id].model), muzzle: inHand[id].muzzle };
  }

  /** Bones back to their rest transforms. */
  _restPose() {
    for (const [bone, p, q, sc] of this._rest) { bone.position.copy(p); bone.quaternion.copy(q); bone.scale.copy(sc); }
    this.root.updateMatrixWorld(true);
  }

  /**
   * The gun in the hand (null: empty hands). The right hand carries the old one over the
   * shoulder into the sling, takes the new one off it and brings it round into both hands.
   */
  setWeapon(id) {
    if (id !== null && !this.guns[id]) return;
    let from = this.currentGun;
    // A gun that's gone (dropped, or a battle royale drop emptying your hands) isn't put away: it just goes
    if (from && this.carried && !this.carried.has(from)) {
      from = null;
      this.currentGun = null;
      this.swap = null;
    }
    if (from === id) { if (id) this.muzzle.position.copy(this.guns[id].muzzle); this._showGuns(); return; }
    const sw = this.swap;
    if (sw && !sw.switched) {
      // Still putting the first gun away: draw this one instead
      sw.to = id;
    } else if (this.mixer && !this.dead && !this.toss && !this._handsBusy()) {
      // (Changed mind while drawing: put that one back from about where the hand is)
      const t = sw ? Math.max(0, HOLSTER_TIME * (1 - (sw.t - HOLSTER_TIME) / DRAW_TIME)) : 0;
      this.swap = { t, from, to: id, switched: false, start: null, grab: null };
    }
    if (from) this.backGun = sw && !sw.switched ? sw.from ?? from : from;
    this.currentGun = id;
    this._showGuns();
    if (id) this.muzzle.position.copy(this.guns[id].muzzle);
  }

  /**
   * The guns you have (ids; null: unknown). One you no longer have leaves the sling, and the
   * hand if it's held; the next setWeapon draws without putting anything away.
   */
  setCarried(ids) {
    this.carried = ids ? new Set(ids) : null;
    if (!this.carried) return;
    let changed = false;
    if (this.backGun && !this.carried.has(this.backGun)) { this.backGun = null; changed = true; }
    const sw = this.swap;
    if (sw && sw.to && !this.carried.has(sw.to)) { sw.to = null; changed = true; }
    if (changed) this._showGuns();
  }

  /**
   * Which gun shows where: in the hand, in the main sling (the spare, or the one about to
   * be drawn) and in the outer sling (put away for a throw, or for both hands while busy).
   */
  _showGuns() {
    if (!this.mixer) return;
    const sw = this.swap, T = this.toss, cur = this.currentGun;
    let hand = cur, a = this.backGun, b = null;
    if (this._handsBusy()) { hand = null; a = cur ?? this.backGun; b = cur ? this.backGun : null; }
    else if (sw) { hand = sw.switched ? sw.to : sw.from; a = sw.switched ? sw.from : sw.to; }
    else if (T) {
      const away = this._tossAway();
      hand = T.phase === "stow" ? T.gun : away ? null : cur;
      b = away ? T.gun : null;
    }
    if (a === hand) a = null;
    if (b === hand || b === a) b = null;
    const sh = this._shown;
    if (sh && sh.hand === hand && sh.a === a && sh.b === b) return;
    this._shown = { hand, a, b };
    for (const [gid, g] of Object.entries(this.guns)) {
      showPart(g.model, gid === hand);
      showPart(g.back[0], gid === a);
      showPart(g.back[1], gid === b);
    }
  }

  /** The gun is off the hand for a throw (put away, the throwable out). */
  _tossAway() {
    const T = this.toss;
    return !!T && T.phase !== "stow" && T.phase !== "draw";
  }

  /** The throwable is out and wound up, ready to go (or there is no animation to wait for). */
  get throwReady() {
    return !this.mixer || this.dead || !this.toss || this.toss.phase === "ready";
  }

  /**
   * A throw, start to finish (s.throwHold: the throw is being held; the "throw" gesture: the
   * release): stow — the gun over the shoulder into the outer sling; fetch — the hand down
   * to the hip pouch, the throwable out, the off hand pulls the pin in front of the chest,
   * up into the wind-up; ready — held there, leaning with the aim; throw — the swing, the
   * throwable leaving the hand at THROW_RELEASE; reach — back over the shoulder; draw.
   * Someone else's throw arrives as the gesture alone and starts at "throw".
   */
  _updateToss(dt, s) {
    const g = this.gesture, throwing = g?.name === "throw";
    let T = this.toss;
    if (T && (this._handsBusy() || this.dead)) { this.toss = null; this._showTossProp(null); this._showGuns(); return; }
    if (!T) {
      if (!(s.throwHold || throwing) || this._handsBusy() || this.dead || !this.mixer) return;
      // A swap under way gives way: whichever gun is in the hand is the one put away
      const sw = this.swap;
      const gun = sw ? (sw.switched ? sw.to : sw.from) : this.currentGun;
      this.swap = null;
      T = this.toss = { phase: throwing ? "throw" : gun ? "stow" : "fetch", t: 0, gun, kind: this.tossKind, start: this._handAt(), grab: null, g: throwing ? g : null };
      this._showGuns();
    }
    if (s.throwKind) T.kind = s.throwKind;
    T.t += dt;
    const next = phase => { T.phase = phase; T.t = 0; T.start = this._handAt(); T.grab = null; this._showGuns(); };
    switch (T.phase) {
      case "stow": if (T.t >= HOLSTER_TIME) next("fetch"); break;
      case "fetch": if (throwing) { T.g = g; next("throw"); } else if (T.t >= FETCH_TIME) next("ready"); break;
      case "ready":
        if (throwing) { T.g = g; next("throw"); }
        else if (!s.throwHold) next("reach");        // called off: put it away
        break;
      case "throw":
        if (!throwing || g !== T.g) next("reach");
        break;
      case "reach":
        if (throwing && g !== T.g) { T.g = g; next("throw"); }
        else if (s.throwHold && T.t > 0.05) next("fetch");
        else if (T.t >= REACH_TIME) {
          if (this.currentGun) next("draw");
          else { this.toss = null; this._showGuns(); }
        }
        break;
      case "draw":
        if (s.throwHold) {
          // Another throw straight away: the gun goes back from where it is
          const k = Math.min(1, T.t / DRAW_TIME);
          next("stow");
          T.gun = this.currentGun;
          T.t = HOLSTER_TIME * (1 - k);
        } else if (T.t >= DRAW_TIME) { this.toss = null; this._showGuns(); }
        break;
    }
  }

  /** Where the right hand was last driven to (the body's frame), to start the next move from; null: from the clip. */
  _handAt() {
    return this._ikOn ? this._lastHand.clone() : null;
  }

  /** The throwable shown in the right hand (null: none). */
  _showTossProp(kind) {
    if (this._propShown === kind) return;
    const props = this._tossProps ??= {};
    if (this._propShown && props[this._propShown]) props[this._propShown].visible = false;
    this._propShown = kind;
    if (!kind || !this.b?.rHand) return;
    let o = props[kind];
    if (!o) {
      try { o = cloneItem(kind); } catch { return; }
      const k = 1 / (this.model?.scale.x || 1);
      o.traverse(c => { if (c.isMesh) c.castShadow = false; });
      o.position.set(0, 0.08 * k, 0.04 * k);
      o.scale.multiplyScalar(k);
      this.b.rHand.add(o);
      props[kind] = o;
    }
    o.visible = true;
  }

  /** Seconds from the start of a throw gesture of dur seconds to the frame the throwable leaves the hand. */
  throwReleaseDelay(dur) {
    return dur * THROW_RELEASE;
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
    this.toss = null;
    this._showTossProp(null);
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
    const sw = this.swap;
    if (sw) {
      sw.t += dt;
      // The hand is at the sling: the old gun stays there, the new one comes away with the hand
      if (!sw.switched && sw.t >= HOLSTER_TIME) { sw.switched = true; sw.start = this._handAt(); sw.grab = null; this._showGuns(); }
      if (sw.t >= SWAP_TIME || this._handsBusy() || this.dead) { this.swap = null; this._showGuns(); }
    }
    this._updateToss(dt, s);
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
    const armed = !!this.currentGun && !this._busyFlag && !this._tossAway();
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
      else overlayTime = THREE.MathUtils.lerp(SEG.drinkFrom, SEG.drinkTo, k) * overlayAct.dur;
    }
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

  /** Touchdown from a parachute: the landing-from-height clip (impact crouch, then up). */
  landFromHeight(dur = LAND_FROM_HEIGHT) {
    this.air.on = false;
    this.air.land = { t: 0, hard: true, chute: true, dur };
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
      // Off a parachute the whole body lands (the gun, if any, stays on the upper body)
      const act = L.chute && !armed ? this.F.land : L.hard ? pick("land") : pick("jump");
      if (!act) return none;
      const k = L.t / L.dur;
      const [a, b] = L.chute ? [SEG.chuteFrom, SEG.chuteTo] : L.hard ? [SEG.landFrom, SEG.landTo] : [SEG.jumpLand, SEG.jumpEnd];
      return { act, w: Math.min(1, L.t / 0.08, (L.dur - L.t) / (L.chute ? 0.35 : 0.18)), time: THREE.MathUtils.lerp(a, b, k) * act.dur, lowerOnly: armed };
    }
    return none;
  }

  /**
   * Eases every action toward its target; plays the ones with weight, stops the rest.
   * The mixer fills whatever a bone's weights leave short of 1 with the bind pose (a
   * T-pose), and blends easing at different rates (the rifle pose is quicker than the
   * legs) can dip below 1 mid-transition: so each half of the body is topped back up.
   */
  _blend(dt, rate) {
    let full = 0, lower = 0, upper = 0;
    for (const e of this.acts) {
      spring(e, "w", "v", e.target, e.rate ?? rate, dt);
      if (e.w < 0) { e.w = 0; e.v = 0; }
      if (e.target === 0 && e.w < 0.002) { e.w = 0; e.v = 0; }
      if (e.layer === "f") full += e.w; else if (e.layer === "l") lower += e.w; else upper += e.w;
    }
    const room = Math.max(0, 1 - full);
    const kLower = lower > 0.02 && lower < room ? room / lower : 1;
    const kUpper = upper > 0.02 && upper < room ? room / upper : 1;
    for (const e of this.acts) {
      const a = e.a;
      if (e.w > 0) {
        if (!e.playing) { a.play(); e.playing = true; }
        a.setEffectiveWeight(e.w * (e.layer === "l" ? kLower : e.layer === "u" ? kUpper : 1));
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
    const on = armed && sup && !this.swap && !this.toss && !(g && OVERLAY[g.name]) && this.sw.swim < 0.5 && !this.dead;
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

  /**
   * The right hand through a swap or a throw: arm IK along curves between the clip's hand,
   * the top of the shoulder, a sling's grip, the hip pouch, the chest and the throw's
   * wind-up, release and follow-through points. A gun going away settles from the grip into
   * its sling pose exactly (then the slung model takes over, no pop); a gun coming off is
   * carried from where it lay and turns into the grip on the way. Also: the throwable in the
   * hand, the off hand pulling the pin and then pointing at the target, the chest winding up
   * and whipping round into the throw.
   */
  _handsProcedural(dt, s, left, fwd) {
    const b = this.b, sw = this.swap, T = this.toss, h = this.weapon, hl = this._holdLocal;
    const g = this.gesture, sm = THREE.MathUtils.smoothstep;
    const ph = T?.phase;
    // How far through the swing (0..1)
    const k = ph === "throw" ? (g?.name === "throw" ? Math.min(1, g.t / g.dur) : 1) : 0;
    const pitch = THREE.MathUtils.clamp(s.aimPitch ?? 0, -0.45, 0.9);

    // The body: winding up turns the chest right and back (further back for a long lob),
    // the swing whips it round to the left and over the front foot
    const body = this._tossBody ??= { yaw: 0, yv: 0, lean: 0, lv: 0 };
    let yawT = 0, leanT = 0, rate = 9;
    if (ph === "ready" || (ph === "fetch" && T.t > FETCH_TIME * 0.75)) { yawT = -0.42; leanT = -0.1 - pitch * 0.3; }
    else if (ph === "throw") {
      const e = sm(k, 0.05, 0.6);
      yawT = THREE.MathUtils.lerp(-0.42, 0.38, e);
      leanT = THREE.MathUtils.lerp(-0.1 - pitch * 0.3, 0.3 - pitch * 0.15, e);
      rate = 30;
    }
    spring(body, "yaw", "yv", yawT, rate, dt);
    spring(body, "lean", "lv", leanT, rate, dt);
    if (Math.abs(body.yaw) > 1e-3 || Math.abs(body.lean) > 1e-3) {
      turnBone(b.spine, _up, body.yaw * 0.3);
      turnBone(b.spine1, _up, body.yaw * 0.35);
      turnBone(b.spine2, _up, body.yaw * 0.35);
      turnBone(b.spine1, left, body.lean * 0.5);
      turnBone(b.spine2, left, body.lean * 0.5);
    }

    // The throwable: out of the pouch until it leaves the hand on the release
    let prop = false;
    if (ph === "ready") prop = true;
    else if (ph === "fetch") prop = T.t / FETCH_TIME > 0.3;
    else if (ph === "throw") prop = k < THROW_RELEASE;
    this._showTossProp(prop ? T.kind : null);

    // The off hand points at the target through the wind-up, tucks in for the swing
    const lw = this._leftToss ??= { w: 0, v: 0 };
    spring(lw, "w", "v", ph === "ready" || (ph === "fetch" && T.t > FETCH_TIME * 0.8) || (ph === "throw" && k < 0.75) ? 1 : 0, 12, dt);

    this._ikOn = false;
    if ((!sw && !T && lw.w < 0.01) || !b.rArm || !b.rFore || !b.rHand || !this.slings) return;

    const right = _h[0].copy(left).negate();
    const shoulder = b.rArm.getWorldPosition(_h[1]);
    const over = _h[2].copy(shoulder).addScaledVector(_up, 0.34).addScaledVector(right, 0.06).addScaledVector(fwd, -0.03);
    const clipHand = b.rHand.getWorldPosition(_h[3]);
    const target = _h[4];
    const startOf = st => {
      if (!st.start) st.start = this.root.worldToLocal(clipHand.clone());
      return this.root.localToWorld(_h[5].copy(st.start));
    };
    const gripOf = sl => sl.localToWorld(_h[6].copy(this._gripLocal));
    // Elbow out and up when reaching over the shoulder
    const poleOver = _h[7].copy(right).addScaledVector(_up, 0.6).addScaledVector(fwd, 0.15);
    // Wound up: the throwable behind the right ear
    const holdP = () => _h[10].copy(shoulder).addScaledVector(_up, 0.13).addScaledVector(fwd, -0.2).addScaledVector(right, 0.06);
    let w = 0, pole = poleOver, pw = 1, dock = 0, carry = -1, slot = null, pin = 0;
    const st = sw ?? T;
    // A move that starts where the last one left the hand keeps its elbow; one that starts
    // from the clip's pose eases the elbow in
    const fromIK = !!st?.start;

    if (sw) {
      slot = this.slings[0];
      if (!sw.switched) {
        const u = sw.t / HOLSTER_TIME;
        bezier(target, startOf(sw), over, gripOf(slot), ease(u));
        if (sw.from) dock = sm(u, 0.55, 1);
        pw = fromIK ? 1 : sm(u, 0, 0.3);
      } else {
        const u = (sw.t - HOLSTER_TIME) / DRAW_TIME;
        bezier(target, startOf(sw), over, clipHand, ease(u));
        if (sw.to) carry = ease((u - 0.1) / 0.75);
        pw = 1 - sm(u, 0.6, 1);
      }
      w = 1;
    } else if (ph === "stow" || ph === "reach") {
      slot = this.slings[1];
      const u = T.t / (ph === "stow" ? HOLSTER_TIME : REACH_TIME);
      bezier(target, startOf(T), over, gripOf(slot), ease(u));
      if (ph === "stow" && T.gun) dock = sm(u, 0.55, 1);
      pw = fromIK ? 1 : sm(u, 0, 0.3);
      w = 1;
    } else if (ph === "draw") {
      slot = this.slings[1];
      const u = T.t / DRAW_TIME;
      bezier(target, startOf(T), over, clipHand, ease(u));
      carry = ease((u - 0.1) / 0.75);
      pw = 1 - sm(u, 0.6, 1);
      w = 1;
    } else if (ph === "fetch") {
      // Down to the pouch on the right hip, the throwable up in front of the chest (the pin),
      // then up and back into the wind-up
      const u = T.t / FETCH_TIME;
      const pouch = b.hips.getWorldPosition(_h[8]).addScaledVector(right, 0.19).addScaledVector(fwd, 0.07).addScaledVector(_up, -0.04);
      const chest = b.spine2.getWorldPosition(_h[9]).addScaledVector(fwd, 0.3).addScaledVector(right, 0.06).addScaledVector(_up, -0.1);
      const polePouch = _h[11].copy(right).addScaledVector(fwd, -0.4);
      const poleChest = _h[12].copy(right).multiplyScalar(0.7).addScaledVector(_up, -0.7);
      if (u < 0.3) {
        const e = ease(u / 0.3), a = startOf(T);
        bezier(target, a, _h[13].addVectors(a, pouch).multiplyScalar(0.5).addScaledVector(right, 0.15), pouch, e);
        pole = poleOver.lerp(polePouch, e);
        pw = fromIK ? 1 : sm(u / 0.3, 0, 0.4);
      } else if (u < 0.55) {
        const e = ease((u - 0.3) / 0.25);
        bezier(target, pouch, _h[13].addVectors(pouch, chest).multiplyScalar(0.5).addScaledVector(fwd, 0.12), chest, e);
        pole = polePouch.lerp(poleChest, e);
      } else if (u < 0.75) {
        target.copy(chest);
        pole = poleChest;
      } else {
        const e = ease((u - 0.75) / 0.25);
        bezier(target, chest, _h[13].copy(chest).addScaledVector(_up, 0.3), holdP(), e);
        pole = poleChest.lerp(poleOver, e);
      }
      w = 1;
      // The off hand comes over and pulls the pin (lights the rag) while it's at the chest
      pin = bump((u - 0.45) / 0.37, 0, 1, 0.35);
    } else if (ph === "ready") {
      target.copy(holdP());
      w = 1;
    } else if (ph === "throw") {
      // Accelerating over the shoulder to the release point in front of the head (where the
      // throwable is launched from), then slowing across the body to the left hip
      const a = startOf(T);
      const rel = _h[8].copy(shoulder).addScaledVector(fwd, 0.4).addScaledVector(_up, 0.2).addScaledVector(right, 0.02);
      if (k < THROW_RELEASE) {
        const u = k / THROW_RELEASE;
        bezier(target, a, _h[9].copy(shoulder).addScaledVector(_up, 0.36).addScaledVector(fwd, 0.02).addScaledVector(right, 0.04), rel, u * u);
      } else {
        const u = (k - THROW_RELEASE) / (1 - THROW_RELEASE);
        const follow = b.hips.getWorldPosition(_h[11]).addScaledVector(fwd, 0.3).addScaledVector(left, 0.12).addScaledVector(_up, 0.05);
        bezier(target, rel, _h[12].copy(rel).addScaledVector(fwd, 0.2).addScaledVector(_up, -0.15), follow, 1 - (1 - u) * (1 - u));
        pole = poleOver.lerp(_h[13].copy(right).addScaledVector(_up, -0.4).addScaledVector(fwd, -0.2), ease(u));
      }
      pw = fromIK ? 1 : sm(k, 0, 0.2);
      w = 1;
    }

    if (w > 0) {
      armIK(b.rArm, b.rFore, b.rHand, target, w, pole, pw);
      this._ikOn = true;
      this.root.worldToLocal(this._lastHand.copy(target));
    }
    if (b.lArm && b.lFore && b.lHand) {
      if (pin > 0.01) {
        const at = b.rHand.getWorldPosition(_h[8]).addScaledVector(_up, 0.07).addScaledVector(left, 0.03);
        armIK(b.lArm, b.lFore, b.lHand, at, pin, _h[9].copy(left).addScaledVector(_up, -0.5), 1);
      }
      if (lw.w > 0.01) {
        const ls = b.lArm.getWorldPosition(_h[8]);
        const point = _h[9].copy(ls).addScaledVector(fwd, 0.5 * Math.cos(pitch)).addScaledVector(_up, 0.08 + 0.5 * Math.sin(pitch)).addScaledVector(left, 0.05);
        const tuck = b.spine2.getWorldPosition(_h[10]).addScaledVector(left, 0.2).addScaledVector(fwd, 0.15).addScaledVector(_up, -0.12);
        point.lerp(tuck, ph === "throw" ? sm(k, 0.05, 0.4) : 0);
        armIK(b.lArm, b.lFore, b.lHand, point, lw.w, _h[11].copy(left).addScaledVector(_up, -0.6), 1);
      }
    }

    // The gun: into the sling (blended in world space onto the slung pose), or off it
    // (carried as grabbed, turning into the grip)
    if (!h || !hl || !slot || (dock <= 0 && carry < 0)) return;
    b.rHand.updateWorldMatrix(true, false);
    slot.updateWorldMatrix(true, false);
    const P = _h[10], S = _h[11], P2 = _h[12], S2 = _h[13];
    if (dock > 0) {
      _hm0.compose(hl.p, hl.q, hl.s).premultiply(b.rHand.matrixWorld).decompose(P, _hq0, S);
      slot.matrixWorld.decompose(P2, _hq1, S2);
      P.lerp(P2, dock); _hq0.slerp(_hq1, dock); S.lerp(S2, dock);
      _hm0.compose(P, _hq0, S).premultiply(_m0.copy(b.rHand.matrixWorld).invert());
      _hm0.decompose(h.position, h.quaternion, h.scale);
    } else {
      if (!st.grab) {
        _hm0.copy(b.rHand.matrixWorld).invert().multiply(slot.matrixWorld);
        st.grab = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() };
        _hm0.decompose(st.grab.p, st.grab.q, st.grab.s);
      }
      h.position.lerpVectors(st.grab.p, hl.p, carry);
      h.quaternion.slerpQuaternions(st.grab.q, hl.q, carry);
      h.scale.lerpVectors(st.grab.s, hl.s, carry);
    }
    this._holderMoved = true;
  }

  // ── Procedural layer (after the clips) ─────────────────────────────────────
  _procedural(dt, s, armed, speed) {
    const b = this.b;
    // The gun back on the grip (carried into / out of a sling last frame); the aim and the support hand read it
    const hl = this._holdLocal;
    if (this._holderMoved && this.weapon && hl) {
      this.weapon.position.copy(hl.p); this.weapon.quaternion.copy(hl.q); this.weapon.scale.copy(hl.s);
      this._holderMoved = false;
    }
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
    const aimW = posed * (this.sw.stand + this.sw.crouch + this.sw.prone * 0.6) * (this.swap || this.toss ? 0.4 : 1);
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

    this._handsProcedural(dt, s, side, fwd);

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
