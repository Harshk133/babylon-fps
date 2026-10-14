import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { cloneItem } from "../items/ItemModels.js";
import { WEAPON_ORDER } from "../combat/weapons.js";

// Quaternius "Soldier" + "Submachine Gun" (both CC0, via poly.pizza)
const SOLDIER_URL = "/models/soldier/soldier.glb";
const WEAPON_URL  = "/models/soldier/smg.glb";

const WEAPON_LENGTH = 0.55;                                  // metres, muzzle to stock
const WEAPON_GRIP   = new THREE.Vector3(-0.05, -0.25, 0);    // grip point in raw gun units
const WEAPON_MUZZLE = new THREE.Vector3(2.3, 0.58, 0);       // muzzle point in raw gun units

const LOCO = ["idle", "fwd", "back", "left", "right"];
const LOCO_CLIPS = {
  idle:  "Idle_Gun",
  fwd:   "Run",
  back:  "Run_Back",
  left:  "Run_Left",
  right: "Run_Right",
};
const RUN_CLIP_SPEED = 5.0;   // ground speed (m/s) the run clips were authored for
const BLEND_RATE     = 10;
const AIM_PITCH_MIN  = -0.7;
const AIM_PITCH_MAX  = 0.8;

const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qId = new THREE.Quaternion();
const _qStep = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisY = new THREE.Vector3(0, 1, 0);
const _v0 = new THREE.Vector3();

function findClip(animations, name) {
  return animations.find(a => a.name === name || a.name.endsWith("|" + name));
}

// Split a clip by bone set so the legs and the upper body can play different clips
function filterClip(clip, boneNames, keep) {
  const tracks = clip.tracks.filter(t => boneNames.has(t.name.split(".")[0]) === keep);
  return new THREE.AnimationClip(`${clip.name}_${keep ? "upper" : "lower"}`, clip.duration, tracks);
}

function rotateBoneInWorld(bone, worldDelta) {
  // newWorld = delta * world  →  local = parentWorld⁻¹ * newWorld
  bone.getWorldQuaternion(_q0);
  _q0.premultiply(worldDelta);
  bone.parent.getWorldQuaternion(_q1).invert();
  bone.quaternion.copy(_q1.multiply(_q0));
  bone.updateMatrixWorld(true);
}

export class Soldier {
  constructor() {
    this.root = new THREE.Group();
    this.model = null;
    this.weapon = null;
    this.guns = {};              // id → { model, muzzle } in the hand-holder frame
    this.currentGun = "smg";
    this.muzzle = new THREE.Object3D();
    this.mixer = null;

    this.lower = {};
    this.upper = {};
    this.locoWeights = { idle: 1, fwd: 0, back: 0, left: 0, right: 0 };
    this.locoPhase = 0;
    this.aimWeight = 0;
    this.shootWeight = 0;
    this.dead = false;

    this._chestRef = new THREE.Quaternion(); // chest orientation (root-local) when aiming dead ahead
    this._spineDelta = new THREE.Quaternion();
  }

  async load(loader = new GLTFLoader()) {
    const [soldier, weapon] = await Promise.all([
      loader.loadAsync(SOLDIER_URL),
      loader.loadAsync(WEAPON_URL),
    ]);

    const model = soldier.scene;
    model.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false; // skinned bounds don't follow the animation
      }
    });
    this.model = model;
    this.root.add(model);

    this.abdomen = model.getObjectByName("Abdomen");
    this.chest   = model.getObjectByName("Chest");
    this.hand    = model.getObjectByName("WristR");
    this.palm    = model.getObjectByName("Middle1R");

    const upperBones = new Set();
    this.abdomen.traverse(o => upperBones.add(o.name));

    this.mixer = new THREE.AnimationMixer(model);
    const anims = soldier.animations;

    for (const key of LOCO) {
      const clip = findClip(anims, LOCO_CLIPS[key]);
      this.lower[key] = this._makeAction(filterClip(clip, upperBones, false));
      this.upper[key] = this._makeAction(filterClip(clip, upperBones, true));
    }
    const pointClip = findClip(anims, "Idle_Gun_Pointing");
    const shootClip = findClip(anims, "Idle_Gun_Shoot");
    this.aimAction   = this._makeAction(filterClip(pointClip, upperBones, true));
    this.shootAction = this._makeAction(filterClip(shootClip, upperBones, true));
    this.shootAction.timeScale = 1.6;

    this.deathAction = this.mixer.clipAction(findClip(anims, "Death"));
    this.deathAction.setLoop(THREE.LoopOnce, 1);
    this.deathAction.clampWhenFinished = true;

    for (const key of LOCO) {
      this.lower[key].timeScale = 0; // locomotion phase is driven manually so clips stay in sync
      this.upper[key].timeScale = 0;
    }

    this._attachWeapon(weapon.scene, pointClip);
    this._applyWeights();
  }

  _makeAction(clip) {
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.enabled = true;
    action.setEffectiveWeight(0);
    action.play();
    return action;
  }

  // Align the gun to the hand using the "pointing" pose: barrel along the
  // character's forward axis, grip in the palm. Stored hand-local afterwards.
  _attachWeapon(gun, pointClip) {
    gun.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });

    const bbox = new THREE.Box3().setFromObject(gun);
    const size = bbox.getSize(new THREE.Vector3());
    const scale = WEAPON_LENGTH / Math.max(size.x, size.y, size.z);

    const holder = new THREE.Group();
    gun.scale.multiplyScalar(scale);
    holder.add(gun);

    const muzzleLocal = WEAPON_MUZZLE.clone().multiplyScalar(scale);
    this.muzzle.position.copy(muzzleLocal);
    holder.add(this.muzzle);
    this.guns.smg = { model: gun, muzzle: muzzleLocal };

    // Every other gun is a procedural model built in a grip-origin frame
    // (+X barrel, +Y up), so it only needs moving onto the SMG's grip point.
    const gripLocal = WEAPON_GRIP.clone().multiplyScalar(scale);
    for (const id of WEAPON_ORDER) {
      if (id === "smg") continue;
      const model = cloneItem(id);
      model.position.copy(gripLocal);
      model.visible = false;
      holder.add(model);
      this.guns[id] = { model, muzzle: gripLocal.clone().add(model.userData.muzzle) };
    }

    // Pose the skeleton in the pointing clip at t=0 with the root at identity
    const tmpMixer = new THREE.AnimationMixer(this.model);
    tmpMixer.clipAction(pointClip).play();
    tmpMixer.update(0);
    this.model.updateMatrixWorld(true);

    // Desired gun world rotation: gun +X → model +Z (forward), gun +Y → up
    const gunWorldQ = new THREE.Quaternion().setFromAxisAngle(_axisY, -Math.PI / 2);
    const palmPos = new THREE.Vector3();
    this.hand.getWorldPosition(palmPos);
    palmPos.lerp(this.palm.getWorldPosition(new THREE.Vector3()), 0.6);
    const gripOffset = _v0.copy(WEAPON_GRIP).multiplyScalar(scale).applyQuaternion(gunWorldQ);
    const gunWorldPos = palmPos.sub(gripOffset);

    this.root.updateMatrixWorld(true);
    const handWorld = this.hand.matrixWorld.clone();
    const gunWorld = new THREE.Matrix4().compose(gunWorldPos, gunWorldQ, new THREE.Vector3(1, 1, 1));
    const local = handWorld.invert().multiply(gunWorld);
    local.decompose(holder.position, holder.quaternion, holder.scale);
    this.hand.add(holder);
    this.weapon = holder;

    // Reference chest orientation for procedural aim (root-local, root at identity)
    this.chest.getWorldQuaternion(this._chestRef);

    tmpMixer.stopAllAction();
    tmpMixer.uncacheRoot(this.model);
  }

  /** Shows the gun model for a weapon id and moves the muzzle to its barrel tip. */
  setWeapon(id) {
    if (!this.guns[id]) return;
    this.currentGun = id;
    for (const [gid, g] of Object.entries(this.guns)) g.model.visible = gid === id;
    this.muzzle.position.copy(this.guns[id].muzzle);
  }

  getMuzzleWorldPosition(out) {
    return this.muzzle.getWorldPosition(out);
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.deathAction.reset().setEffectiveWeight(1).play();
  }

  revive() {
    this.dead = false;
    this.deathAction.stop();
    this._applyWeights();
  }

  /**
   * @param {object} s
   *   localForward / localRight — velocity in the character's frame (m/s)
   *   aiming   — 0..1 target for the raised-gun upper body
   *   firing   — true while the trigger is held and a round left the barrel recently
   *   aimYawOffset — camera yaw minus body yaw (rad)
   *   aimPitch — camera pitch (rad, + is up)
   */
  update(delta, s) {
    if (!this.mixer) return;

    if (this.dead) {
      for (const key of LOCO) {
        this.lower[key].setEffectiveWeight(0);
        this.upper[key].setEffectiveWeight(0);
      }
      this.aimAction.setEffectiveWeight(0);
      this.shootAction.setEffectiveWeight(0);
      this.mixer.update(delta);
      return;
    }

    // Directional blend: cos² weights over the four run clips sum to 1
    const speed = Math.hypot(s.localForward, s.localRight);
    const t = {
      idle: 0,
      fwd: 0, back: 0, left: 0, right: 0,
    };
    const move = THREE.MathUtils.clamp(speed / 1.5, 0, 1);
    if (speed > 0.05) {
      const f = s.localForward / speed, r = s.localRight / speed;
      t.fwd   = (f > 0 ? f * f : 0) * move;
      t.back  = (f < 0 ? f * f : 0) * move;
      t.right = (r > 0 ? r * r : 0) * move;
      t.left  = (r < 0 ? r * r : 0) * move;
    }
    t.idle = 1 - move;

    const k = 1 - Math.exp(-BLEND_RATE * delta);
    for (const key of LOCO) this.locoWeights[key] += (t[key] - this.locoWeights[key]) * k;
    this.aimWeight   += ((s.aiming ? 1 : 0) - this.aimWeight) * (1 - Math.exp(-14 * delta));
    this.shootWeight += ((s.firing ? 1 : 0) - this.shootWeight) * (1 - Math.exp(-20 * delta));

    // Shared phase so feet don't skate while blending between directions
    const rate = THREE.MathUtils.clamp(speed / RUN_CLIP_SPEED, 0.75, 1.5);
    this.locoPhase = (this.locoPhase + delta * rate) % 1;
    for (const key of LOCO) {
      const lower = this.lower[key], upper = this.upper[key];
      const d = lower.getClip().duration;
      const time = key === "idle" ? (this.mixer.time % d) : this.locoPhase * d;
      lower.time = time;
      upper.time = time;
    }

    this._applyWeights();
    this.mixer.update(delta);

    if (!s.noSpine) this._applySpineAim(s.aimYawOffset, s.aimPitch);
  }

  _applyWeights() {
    const aim = this.aimWeight;
    for (const key of LOCO) {
      this.lower[key].setEffectiveWeight(this.locoWeights[key]);
      this.upper[key].setEffectiveWeight(this.locoWeights[key] * (1 - aim));
    }
    this.aimAction.setEffectiveWeight(aim * (1 - this.shootWeight));
    this.shootAction.setEffectiveWeight(aim * this.shootWeight);
  }

  // Twist abdomen + chest so the raised gun points along the camera's aim,
  // regardless of how the legs/hips are oriented by the run clips.
  _applySpineAim(yawOffset, pitch) {
    if (this.aimWeight < 0.01) return;
    this.root.updateMatrixWorld(true);

    const p = THREE.MathUtils.clamp(pitch, AIM_PITCH_MIN, AIM_PITCH_MAX);
    _qYaw.setFromAxisAngle(_axisY, yawOffset);
    _qPitch.setFromAxisAngle(_axisX, -p);
    this.root.getWorldQuaternion(_q2);
    // desired chest world = rootWorld * yaw * pitch * chestRef
    _q2.multiply(_qYaw).multiply(_qPitch).multiply(this._chestRef);

    this.chest.getWorldQuaternion(_q0);
    this._spineDelta.copy(_q2).multiply(_q0.invert());

    _qStep.copy(_qId).slerp(this._spineDelta, 0.5 * this.aimWeight);
    rotateBoneInWorld(this.abdomen, _qStep);
    rotateBoneInWorld(this.chest, _qStep);
  }
}
