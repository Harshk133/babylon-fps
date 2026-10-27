import * as THREE from "three";
import * as CANNON from "cannon-es";
import { Soldier } from "../player/Soldier.js";
import { GROUP_PLAYER, GROUP_NONE } from "../physicsGroups.js";
import { createParachute, setSkydivePose } from "../br/BrVisuals.js";
import { STANCES, STANCE_NAMES, setCapsuleStance } from "../player/Stance.js";

// Teammates in co-op: an animated Soldier per remote player, driven by the
// state packets they send (~20 Hz) and smoothed between packets. Each one gets
// a floating name tag (name in their colour + health bar) and a kinematic
// capsule so monsters can collide with, see and shoot them.

const POS_SMOOTH  = 14;    // exp rate toward the latest (extrapolated) position
const MAX_EXTRAP  = 0.25;  // seconds of dead reckoning between packets
const TAG_HEIGHT  = 2.25;  // metres above the feet
const PVP_TAG_RANGE = 45;  // battle royale: enemy names only show up close (and not through walls)

// Drop phase from the state packet (battle royale)
export const PHASE_GROUND = 0, PHASE_PLANE = 1, PHASE_FALL = 2, PHASE_CHUTE = 3;

function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function drawTag(ctx, name, color, hpFrac, dead) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.font = "800 40px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  ctx.strokeText(name, W / 2, 34);
  ctx.fillStyle = dead ? "#8a8a8a" : color;
  ctx.fillText(name, W / 2, 34);
  // Health bar
  const bw = 220, bh = 12, bx = (W - bw) / 2, by = 70;
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(bx - 3, by - 3, bw + 6, bh + 6);
  ctx.fillStyle = hpFrac > 0.35 ? color : "#ff4b3a";
  ctx.fillRect(bx, by, bw * Math.max(0, hpFrac), bh);
  if (dead) {
    ctx.font = "900 22px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "#ff4b3a";
    ctx.strokeText("DOWN", W / 2, 106);
    ctx.fillText("DOWN", W / 2, 106);
  }
}

export class RemotePlayers {
  /**
   * capsule: { radius, height, feetOffset }; addCapsule(body, r, h) builds the
   * same compound capsule as the local player.
   */
  constructor({ scene, world, loader, effects, sfx, material, capsule, addCapsule }) {
    this.scene = scene;
    this.world = world;
    this.loader = loader;
    this.effects = effects;
    this.sfx = sfx;
    this.material = material;
    this.capsule = capsule;
    this.addCapsule = addCapsule;
    this.players = new Map();
    this._pvp = false;
    /** (player, x, feetY, z, vol 0..1) → plays a footfall there (set by main.js). */
    this.onStep = null;
    /** (from, to) → true if a smoke cloud hides the line between them (set by main.js). */
    this.concealed = null;
    this._targets = [];
    this._v = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._hit = new THREE.Vector3();
  }

  add({ id, name, color }) {
    if (this.players.has(id)) return this.players.get(id);
    const root = new THREE.Group();
    root.position.set(0, -500, 0);
    this.scene.add(root);

    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 128;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: this._pvp, transparent: true }));
    tag.renderOrder = 10;
    tag.visible = false;
    this.scene.add(tag);

    const body = new CANNON.Body({
      mass: 0, type: CANNON.Body.KINEMATIC, material: this.material,
      collisionFilterGroup: GROUP_PLAYER, fixedRotation: true,
    });
    this.addCapsule(body, this.capsule.radius, this.capsule.height);
    body.position.set(0, -500, 0);
    this.world.addBody(body);

    const chute = createParachute();
    root.add(chute);

    const p = {
      id, name, color, root, tag, tex, ctx: canvas.getContext("2d"), body,
      soldier: null, ready: false, hasState: false,
      // latest packet + smoothed values
      tx: 0, ty: 0, tz: 0, vx: 0, vz: 0, extrap: 0,
      bodyYaw: 0, aimYaw: 0, aimPitch: 0, aim: false, fire: false, weapon: "smg",
      hp: 100, dead: false, vis: 1, kills: 0, phase: PHASE_GROUND, chute, skydive: 0,
      tagKey: "", stance: "stand",
      target: {
        id, pos: body.position, vel: { x: 0, z: 0 }, alive: false, vis: 1, local: false, name,
        aimOff: STANCES.stand.aimOff, eyeOff: STANCES.stand.eyeOff,
      },
    };
    body.playerTarget = p.target;
    this.players.set(id, p);

    const soldier = new Soldier();
    soldier.load(this.loader).then(() => {
      if (!this.players.has(id)) return;
      root.add(soldier.root);
      soldier.setWeapon(p.weapon);
      soldier.stance = p.stance;
      if (p.dead) soldier.die();
      p.soldier = soldier;
      p.ready = true;
    });
    return p;
  }

  remove(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.scene.remove(p.root);
    this.scene.remove(p.tag);
    p.tag.material.map.dispose();
    p.tag.material.dispose();
    this.world.removeBody(p.body);
    this.players.delete(id);
  }

  clear() {
    for (const id of [...this.players.keys()]) this.remove(id);
  }

  get count() { return this.players.size; }

  /** Battle royale: everyone is an enemy, so name tags stop showing through walls. */
  set pvp(on) {
    this._pvp = on;
    for (const p of this.players.values()) {
      p.tag.material.depthTest = on;
      p.tag.material.needsUpdate = true;
    }
  }
  get pvp() { return this._pvp; }

  /** Latest state packet from a teammate. */
  applyState(id, s) {
    const p = this.players.get(id);
    if (!p) return;
    if (!p.hasState) {
      // First packet: snap instead of gliding in from nowhere
      p.body.position.set(s.x, s.y, s.z);
      p.hasState = true;
    }
    p.tx = s.x; p.ty = s.y; p.tz = s.z;
    p.vx = s.vx; p.vz = s.vz;
    p.extrap = 0;
    p.bodyYaw = s.by; p.aimYaw = s.ay; p.aimPitch = s.ap;
    p.aim = !!s.aim; p.fire = !!s.fire;
    p.hp = s.hp; p.vis = s.vis ?? 1; p.kills = s.k ?? 0;
    if (s.w !== p.weapon) { p.weapon = s.w; p.soldier?.setWeapon(s.w); }
    const dead = !!s.dead;
    if (dead !== p.dead) {
      p.dead = dead;
      if (dead) p.soldier?.die(); else p.soldier?.revive();
    }
    // Crouched / prone: smaller capsule (harder to hit), lower aim point for the monsters
    const stance = STANCE_NAMES[s.sn ?? 0] ?? "stand";
    if (stance !== p.stance) {
      p.stance = stance;
      setCapsuleStance(p.body, stance, this.capsule.height / 2);
      if (p.soldier) p.soldier.stance = stance;
      p.target.aimOff = STANCES[stance].aimOff;
      p.target.eyeOff = STANCES[stance].eyeOff;
    }
    // g: worn gear as helmet·100 + vest·10 + backpack levels
    p.gearCode = s.g ?? 0;
    p.phase = s.ph ?? PHASE_GROUND;
    p.driving = !!s.veh;
    if (p.soldier) p.soldier.seated = p.driving;
    // Dead players and players still in the plane can't be hit
    p.body.collisionFilterGroup = dead || p.phase === PHASE_PLANE ? GROUP_NONE : GROUP_PLAYER;
    p.target.alive = !dead && p.hasState && p.phase !== PHASE_PLANE;
    p.target.vis = p.vis;
  }

  /** A teammate fired: muzzle flash, tracers, gunshot. */
  shot(id, msg) {
    const p = this.players.get(id);
    if (p?.ready) p.soldier.getMuzzleWorldPosition(this._muzzle);
    else this._muzzle.set(msg.f[0], msg.f[1], msg.f[2]);
    this.effects.enemyFlash(this._muzzle, 0xffc070);
    for (let i = 0; i + 2 < msg.h.length; i += 3) {
      this._hit.set(msg.h[i], msg.h[i + 1], msg.h[i + 2]);
      this.effects.tracer(this._muzzle, this._hit);
    }
    // From their muzzle, so you hear which side they're shooting from
    this.sfx.gunshot(msg.w, msg.s ? 0.32 : 0.9, this._muzzle); // s: suppressed
  }

  /**
   * Footfalls from their speed, on the same rhythm as your own (sprint / jog /
   * sneak), quieter crouched; prone crawling, flying and driving make none.
   */
  _footsteps(p, delta, feetY) {
    const speed = Math.hypot(p.vx, p.vz);
    if (p.dead || p.driving || p.phase !== PHASE_GROUND || p.stance === "prone" || speed < 0.8 || Math.abs(p.vy ?? 0) > 3) {
      p.stepT = Math.min(p.stepT ?? 0, 0.1);
      return;
    }
    p.stepT = (p.stepT ?? 0) - delta;
    if (p.stepT > 0) return;
    const sprint = speed > 5.5, jog = speed > 3.6;
    p.stepT = sprint ? 0.28 : jog ? 0.36 : 0.5;
    const vol = (sprint ? 1 : jog ? 0.75 : 0.4) * (p.stance === "crouch" ? 0.5 : 1);
    this.onStep?.(p, p.root.position.x, feetY, p.root.position.z, vol);
  }

  /** Minimap entries { x, z, yaw, color, dead } (reused array). */
  mapList() {
    const out = (this._map ??= []);
    out.length = 0;
    for (const p of this.players.values()) {
      if (!p.hasState) continue;
      const e = (p.mapEntry ??= { x: 0, z: 0, yaw: 0, color: p.color, dead: false });
      e.x = p.body.position.x; e.z = p.body.position.z; e.yaw = p.root.rotation.y; e.dead = p.dead;
      out.push(e);
    }
    return out;
  }

  /** AI targets for the monsters (reused array). */
  targets() {
    const out = this._targets;
    out.length = 0;
    for (const p of this.players.values()) if (p.hasState) out.push(p.target);
    return out;
  }

  update(delta, camera, feetOffset) {
    const k = 1 - Math.exp(-POS_SMOOTH * delta);
    for (const p of this.players.values()) {
      if (!p.hasState) continue;
      // Dead reckoning between packets, then smooth toward it
      if (p.extrap < MAX_EXTRAP) {
        p.tx += p.vx * delta;
        p.tz += p.vz * delta;
        p.extrap += delta;
      }
      const b = p.body.position;
      b.x += (p.tx - b.x) * k;
      b.y += (p.ty - b.y) * k;
      b.z += (p.tz - b.z) * k;
      p.target.vel.x = p.vx;
      p.target.vel.z = p.vz;
      p.body.aabbNeedsUpdate = true;

      p.root.position.set(b.x, b.y - feetOffset, b.z);
      p.root.rotation.y += angleDiff(p.bodyYaw, p.root.rotation.y) * k;
      const inPlane = p.phase === PHASE_PLANE;
      this._footsteps(p, delta, b.y - feetOffset);
      p.root.visible = !inPlane;
      p.chute.visible = p.phase === PHASE_CHUTE;
      p.skydive += ((p.phase === PHASE_FALL ? 1 : 0) - p.skydive) * (1 - Math.exp(-6 * delta));
      if (p.ready) setSkydivePose(p.soldier.root, p.skydive);

      if (p.ready) {
        if (p.gearCode !== p.gearShown) {
          p.gearShown = p.gearCode;
          const g = p.gearCode;
          p.soldier.setGear({ helmet: Math.floor(g / 100), vest: Math.floor(g / 10) % 10, backpack: g % 10 });
        }
        p.root.updateMatrixWorld(true);
        const yaw = p.root.rotation.y;
        const sy = Math.sin(yaw), cy = Math.cos(yaw);
        p.soldier.update(delta, {
          localForward: p.vx * sy + p.vz * cy,
          localRight: -p.vx * cy + p.vz * sy,
          aiming: !p.dead && (p.aim || p.fire || p.stance === "prone"),
          firing: p.fire,
          aimYawOffset: angleDiff(p.aimYaw, yaw),
          aimPitch: p.aimPitch,
          health: p.hp / 100,
        });
      }

      // Battle royale: no name tag or health bar over enemies
      if (this._pvp) { p.tag.visible = false; continue; }

      // Name tag: readable size at any distance, redrawn only when it changes
      const key = `${Math.round(p.hp / 5)}|${p.dead}`;
      if (key !== p.tagKey) {
        p.tagKey = key;
        drawTag(p.ctx, p.name, p.color, p.hp / 100, p.dead);
        p.tex.needsUpdate = true;
      }
      p.tag.position.set(b.x, b.y - feetOffset + TAG_HEIGHT, b.z);
      const dist = camera.position.distanceTo(p.tag.position);
      // In PvP smoke hides enemies' names too (concealed: camera → tag passes through a cloud)
      p.tag.visible = !inPlane && (!this._pvp || (dist < PVP_TAG_RANGE && !this.concealed?.(camera.position, p.tag.position)));
      const s = THREE.MathUtils.clamp(dist * 0.055, 0.9, 5);
      p.tag.scale.set(s * 2.5, s, 1);
    }
  }
}
