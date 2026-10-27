import * as THREE from "three";
import * as CANNON from "cannon-es";
import { WEAPONS, GEAR, MEDKIT, BISCUIT } from "../combat/weapons.js";
import { PLANE, FREEFALL, CHUTE, PVP_DAMAGE, PVP_HEADSHOT, PVP_HEAD_Y, BR_GUN_RESERVE, planeAt } from "./BattleRoyale.js";
import { PHASE_GROUND, PHASE_PLANE, PHASE_FALL, PHASE_CHUTE } from "../net/RemotePlayers.js";
import { STANCE_NAMES } from "../player/Stance.js";
import { GROUP_WORLD, GROUP_PLAYER, GROUP_GLASS } from "../physicsGroups.js";

// Battle royale bots: seven AI players in every match, so a lone player (or a
// small room) still gets a real fight. The host simulates them; to everyone
// else they're remote players like any other (same soldier, animations, hit
// capsule, kill feed, spectating), sent as one compact "bots" packet at 10 Hz.
//
// A bot drops from the plane toward a loot spot, loots (guns it likes better,
// armour, ammo, heals, throwables), keeps inside the zone, hunts and fights
// whoever it sees (line of sight, a field of view, reaction time, aim that
// settles while it tracks you, strafing, crouching, reloads), throws grenades
// and molotovs at people hiding, heals when it's safe, opens doors, and takes
// a free vehicle when the zone is far. Skill varies per bot.

export const BOT_COUNT = 7;
const BOT_PREFIX = "bot:";

const NAMES = [
  "Raju_OP", "SniperSingh", "Chintu.exe", "BhaiJaan99", "DesiGhost", "PinkyPro", "Golu_Gamer", "Bunty420",
  "LallanTop", "KaaliBillee", "Sher_Khan", "Tinku_YT", "MadMonk", "ChaiSutta", "Babu_Rao", "Pappu_Pro",
  "VeerZara", "Gabbar07", "Mogambo", "ThakurSaab", "Rocky_Bhai", "Dhoni_7", "Kalia", "NinjaNikhil",
];
const COLORS = ["#ff7b54", "#5ad1ff", "#ffd23f", "#9cff6b", "#ff6bd6", "#b28cff", "#6bffd8", "#ffa94d"];

// Weapons a bot prefers, worst to best (index = preference)
const GUN_RANK = { pistol: 1, shotgun: 2, smg: 3, rifle: 4, sniper: 3.5 };
// Where it likes to fight from, per gun (m)
const RANGE = { pistol: [6, 26], shotgun: [3, 12], smg: [6, 30], rifle: [10, 55], sniper: [25, 90] };

const SIGHT = 85;            // m
const FOV_COS = Math.cos(1.25);
const THINK = 0.25;          // s between decisions
const RUN = 5.6, JOG = 3.8, CREEP = 1.8;
const STEP_CHECK = 0.75;     // m ahead for the wall probe
const PICK_RANGE = 1.3;
const LOOT_LOOK = 55;        // m: loot it walks to
const CAR_LOOK = 28;
const SEAT_UP = 0.55;
const HEAL_TIME = { medkit: 2.6, biscuit: 1.4 };
const THROW_ANGLE = 0.62;
const GRAVITY = 20;

const _from = new CANNON.Vec3(), _to = new CANNON.Vec3(), _res = new CANNON.RaycastResult();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _v = new THREE.Vector3();
const losOpts = { collisionFilterMask: GROUP_WORLD, skipBackfaces: true };
const wallOpts = { collisionFilterMask: GROUP_WORLD | GROUP_GLASS, skipBackfaces: true };
const shotOpts = { collisionFilterMask: GROUP_WORLD | GROUP_PLAYER, skipBackfaces: true };

function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;

export function isBotId(id) { return typeof id === "string" && id.startsWith(BOT_PREFIX); }

export class Bots {
  /**
   * g: what the bots need from the game (main.js): world, net, remotePlayers,
   * pickups, houses, vehicles, throwables, br, feetOffset and helper functions
   * (see main.js where it's built).
   */
  constructor(g) {
    this.g = g;
    this.list = [];
    this.byId = new Map();
    this._netT = 0;
    this._nav = { x: 0, z: 0, fx: 0, fz: 0 };
    this._targets = [];
    this._pvp = new Map();
  }

  get count() { return this.list.length; }

  // ── Roster ──────────────────────────────────────────────────────────────
  /** Host: seven bots with fresh names join the room (as remote players). */
  spawnAll() {
    this.clear();
    const names = [...NAMES].sort(() => Math.random() - 0.5);
    for (let i = 0; i < BOT_COUNT; i++) this._add(`${BOT_PREFIX}${i + 1}`, names[i], COLORS[i % COLORS.length]);
  }

  _add(id, name, color, from = null) {
    const p = this.g.remotePlayers.add({ id, name, color });
    const b = {
      id, name, color, p,
      skill: 0.35 + Math.random() * 0.55,
      x: from?.x ?? 0, y: from?.y ?? 0, z: from?.z ?? 0, vx: 0, vz: 0,
      yaw: 0, aimYaw: 0, aimPitch: 0, stance: 0, phase: PHASE_GROUND, vy: 0,
      hp: 100, dead: false, kills: 0,
      weapon: null, guns: {}, gear: { helmet: 0, vest: 0, backpack: 0 }, armor: { helmet: 0, vest: 0 },
      throws: { grenade: 0, molotov: 0, smoke: 0 }, heals: { medkit: 0, biscuit: 0 },
      mode: "idle", goal: null, pick: null, enemy: null, seenFor: 0, lastSeen: null, lastSeenAt: -99,
      think: Math.random() * THINK, fireCd: 0, burst: 0, reloadT: 0, healT: 0, healKind: null,
      strafe: 1, strafeT: 0, throwCd: 3 + Math.random() * 4, hitAt: -99, aimErr: 0.2,
      target: null, car: null, carT: 0, stuckT: 0, lastX: 0, lastZ: 0, jumpAt: 0, drop: null,
      aiming: false, firing: 0, respawnT: 0,
      skip: new Map(), stuckN: 0, escapeT: 0, escX: 0, escZ: 0,
    };
    this.list.push(b);
    this.byId.set(id, b);
    return b;
  }

  clear() {
    for (const b of this.list) {
      if (b.car) this._leaveCar(b);
      this.g.remotePlayers.remove(b.id);
    }
    this.list.length = 0;
    this.byId.clear();
  }

  /** New host after the old one left: take over the bots it was running (with what they're carrying unknown). */
  adopt() {
    if (this.list.length) return;
    for (const [id, p] of this.g.remotePlayers.players) {
      if (!isBotId(id)) continue;
      const b = this._add(id, p.name, p.color, { x: p.body.position.x, y: p.body.position.y - this.g.feetOffset, z: p.body.position.z });
      b.hp = p.hp; b.dead = p.dead; b.phase = p.phase;
      b.weapon = p.weapon && WEAPONS[p.weapon] ? p.weapon : null;
      if (b.weapon) b.guns[b.weapon] = { mag: WEAPONS[b.weapon].magSize, reserve: BR_GUN_RESERVE[b.weapon] ?? 30 };
      b.mode = b.dead ? "dead" : "loot";
      b.drop = { x: b.x, z: b.z, along: 0 };
    }
  }

  // ── Match flow (host) ───────────────────────────────────────────────────
  /** Warm-up: everyone back on their feet near the spawn, armed for practice, not shooting. */
  onWarmup() {
    for (const b of this.list) {
      this._resetKit(b, true);
      const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 16;
      this._placeOnGround(b, Math.cos(a) * r, Math.sin(a) * r);
      b.mode = "warm";
    }
  }

  /** The match starts: aboard the plane, empty-handed, each with a drop spot in mind. */
  onMatch() {
    const route = this.g.br.route;
    const spots = this.g.dropSpots();
    for (const b of this.list) {
      this._resetKit(b, false);
      b.phase = PHASE_PLANE;
      b.mode = "plane";
      // A spot near the route (most land close to it, a few go far)
      let best = null;
      for (let k = 0; k < 12; k++) {
        const s = spots[(Math.random() * spots.length) | 0];
        if (!s) break;
        const along = (s.x - route.ax) * route.dx + (s.z - route.az) * route.dz;
        const side = Math.abs((s.x - route.ax) * -route.dz + (s.z - route.az) * route.dx);
        if (along < 60 || along > PLANE.halfLength * 2 - 40) continue;
        const score = side + Math.random() * 60;
        if (!best || score < best.score) best = { x: s.x, z: s.z, along, score };
      }
      best ??= { x: route.ax + route.dx * PLANE.halfLength, z: route.az + route.dz * PLANE.halfLength, along: PLANE.halfLength };
      b.drop = best;
      // Jump when the plane is this far short of the spot along the route
      b.jumpAt = Math.max(PLANE.jumpDelay + 0.5, (best.along - 55 - Math.random() * 40) / PLANE.speed);
    }
  }

  _resetKit(b, warm) {
    if (b.car) this._leaveCar(b);
    b.hp = 100; b.dead = false; b.kills = 0;
    b.guns = {}; b.weapon = null;
    b.gear = { helmet: 0, vest: 0, backpack: 0 }; b.armor = { helmet: 0, vest: 0 };
    b.throws = { grenade: 0, molotov: 0, smoke: 0 }; b.heals = { medkit: 0, biscuit: 0 };
    b.enemy = null; b.pick = null; b.goal = null; b.lastSeen = null; b.healT = 0; b.reloadT = 0;
    b.skip.clear(); b.stuckN = 0; b.escapeT = 0;
    b.stance = 0; b.vx = b.vz = 0; b.vy = 0; b.phase = PHASE_GROUND;
    if (warm) {
      const w = ["smg", "rifle", "shotgun", "pistol"][(Math.random() * 4) | 0];
      b.guns[w] = { mag: WEAPONS[w].magSize, reserve: 90 };
      b.weapon = w;
    }
    b.p.soldier?.revive();
  }

  _placeOnGround(b, x, z) {
    b.x = x; b.z = z;
    b.y = this.g.groundHeight(x, z);
    b.phase = PHASE_GROUND;
  }

  // ── Per frame (host) ────────────────────────────────────────────────────
  update(delta) {
    const br = this.g.br;
    if (!this.list.length || delta <= 0) return;
    this._gatherTargets();
    for (const b of this.list) {
      if (br.state === "match" && br.alive.has(b.id) === false && !b.dead) { b.dead = true; b.mode = "dead"; }
      if (b.dead) {
        if (br.state !== "match" && (b.respawnT -= delta) <= 0) { this._resetKit(b, true); this._placeOnGround(b, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30); b.mode = "warm"; }
      } else if (b.phase === PHASE_PLANE) this._plane(b, delta);
      else if (b.phase === PHASE_FALL || b.phase === PHASE_CHUTE) this._fall(b, delta);
      else if (b.car) this._drive(b, delta);
      else this._ground(b, delta);
      this._publish(b);
    }
  }

  /** Who can be shot: you, other humans, other bots (positions are capsule centres). */
  _gatherTargets() {
    const out = this._targets;
    out.length = 0;
    const me = this.g.localTarget();
    if (me) out.push(me);
    for (const [id, p] of this.g.remotePlayers.players) {
      if (!p.hasState || p.dead || p.phase !== PHASE_GROUND) continue;
      const bot = this.byId.get(id);
      if (bot && (bot.dead || bot.phase !== PHASE_GROUND)) continue;
      const e = (p._botTarget ??= { id, x: 0, y: 0, z: 0, bot: !!bot, body: p.body, still: 0 });
      e.x = p.body.position.x; e.y = p.body.position.y; e.z = p.body.position.z;
      e.speed = Math.hypot(p.vx, p.vz);
      out.push(e);
    }
  }

  // ── The drop ────────────────────────────────────────────────────────────
  _plane(b, delta) {
    const br = this.g.br;
    planeAt(br.route, br.t, _v);
    b.x = _v.x; b.z = _v.z; b.y = _v.y - 2;
    const pastEject = Math.hypot(_v.x, _v.z) > PLANE.ejectRadius && br.t > br.route.duration * 0.5;
    if (br.t >= b.jumpAt || pastEject) {
      b.phase = PHASE_FALL;
      b.vy = -4;
      b.x -= br.route.dx * 6; b.z -= br.route.dz * 6;
      b.yaw = Math.atan2(b.drop.x - b.x, b.drop.z - b.z);
    }
  }

  _fall(b, delta) {
    const g = this.g;
    const ground = g.groundHeight(b.x, b.z);
    const dx = b.drop.x - b.x, dz = b.drop.z - b.z, d = Math.hypot(dx, dz);
    const chute = b.phase === PHASE_CHUTE;
    const speed = chute ? CHUTE.speed : FREEFALL.forward;
    const want = Math.min(speed, d * 1.2);
    const k = 1 - Math.exp(-(chute ? CHUTE.steer : FREEFALL.steer) * delta);
    b.vx += ((d > 0.5 ? dx / d : 0) * want - b.vx) * k;
    b.vz += ((d > 0.5 ? dz / d : 0) * want - b.vz) * k;
    // Dive when it's nearly over the spot, glide when it's still far
    const vyWant = chute ? -CHUTE.fall : d < (b.y - ground) * 0.6 ? -FREEFALL.dive : -FREEFALL.fall;
    b.vy += (vyWant - b.vy) * (1 - Math.exp(-3 * delta));
    b.x += b.vx * delta; b.z += b.vz * delta; b.y += b.vy * delta;
    if (Math.abs(b.vx) + Math.abs(b.vz) > 0.5) b.yaw = Math.atan2(b.vx, b.vz);
    b.aimYaw = b.yaw; b.aimPitch = -0.4;
    if (!chute && b.y - ground < FREEFALL.chuteHeight + Math.random() * 8) b.phase = PHASE_CHUTE;
    if (b.y <= ground + 0.05) {
      b.y = ground;
      b.phase = PHASE_GROUND;
      b.vx = b.vz = b.vy = 0;
      b.mode = "loot";
      b.think = 0;
    }
  }

  // ── On the ground ───────────────────────────────────────────────────────
  _ground(b, delta) {
    const g = this.g, br = g.br;
    const match = br.state === "match";
    b.fireCd -= delta; b.throwCd -= delta; b.strafeT -= delta;
    b.firing = Math.max(0, b.firing - delta);

    // Zone: hurts outside, like everyone else
    if (match && br.zone && b.phase === PHASE_GROUND) {
      const zd = Math.hypot(b.x - br.zone.x, b.z - br.zone.z);
      if (zd > br.zone.r) {
        b.zoneT = (b.zoneT ?? 1) - delta;
        if (b.zoneT <= 0) { b.zoneT = 1; this._hurt(b, br.zone.dps, null, "zone", false, null, null, true); if (b.dead) return; }
      }
    }

    // Reloading / healing take their time
    if (b.reloadT > 0) {
      b.reloadT -= delta;
      if (b.reloadT <= 0) {
        const gun = b.guns[b.weapon], def = WEAPONS[b.weapon];
        const n = Math.min(def.magSize - gun.mag, gun.reserve);
        gun.mag += n; gun.reserve -= n;
      }
    }
    if (b.healT > 0) {
      b.healT -= delta;
      if (b.healT <= 0 && b.healKind) {
        b.heals[b.healKind]--;
        b.hp = Math.min(100, b.hp + (b.healKind === "medkit" ? MEDKIT.heal : BISCUIT.heal));
        b.healKind = null;
      }
    }

    b.think -= delta;
    if (b.think <= 0) { b.think = THINK * (0.8 + Math.random() * 0.4); this._decide(b); }

    // Combat: track and shoot
    let speed = 0, gx = null, gz = null;
    const e = b.enemy;
    if (e && match) {
      const dx = e.x - b.x, dz = e.z - b.z, d = Math.hypot(dx, dz);
      const want = Math.atan2(dx, dz);
      const turn = (3 + b.skill * 6) * delta;
      b.aimYaw += THREE.MathUtils.clamp(angleDiff(want, b.aimYaw), -turn, turn);
      const dy = e.y - (b.y + 1.5);
      b.aimPitch = Math.atan2(dy, Math.max(1, d));
      b.yaw = b.aimYaw;
      b.aiming = true;
      b.seenFor += delta;
      // Aim settles while it keeps you in view, jumps when you move fast
      b.aimErr = Math.max(0.012 + (1 - b.skill) * 0.03, b.aimErr - delta * (0.08 + b.skill * 0.12)) + (e.speed ?? 0) * 0.0015;
      const reaction = 0.55 - b.skill * 0.35;
      const facing = Math.abs(angleDiff(want, b.aimYaw)) < 0.12;
      if (b.weapon && b.reloadT <= 0 && b.healT <= 0 && b.seenFor > reaction && facing && b.fireCd <= 0) this._fire(b, e, d);
      // Keep its distance band, strafe across your sights
      const [near, far] = RANGE[b.weapon] ?? [8, 25];
      const fwd = d > far ? 1 : d < near ? -1 : 0;
      if (b.strafeT <= 0) { b.strafeT = 0.7 + Math.random() * 1.4; b.strafe = Math.random() < 0.5 ? -1 : 1; if (Math.random() < 0.25) b.stance = b.stance ? 0 : 1; }
      const sx = Math.cos(want), sz = -Math.sin(want);
      gx = b.x + (dx / (d || 1)) * fwd * 4 + sx * b.strafe * 3;
      gz = b.z + (dz / (d || 1)) * fwd * 4 + sz * b.strafe * 3;
      speed = b.stance ? CREEP : JOG;
    } else {
      b.aiming = false;
      b.stance = 0;
      if (b.healT > 0) b.stance = 1;
      else if (b.pick?.active) { gx = b.pick.x; gz = b.pick.z; speed = RUN; }
      else if (b.goal) { gx = b.goal.x; gz = b.goal.z; speed = b.mode === "warm" ? JOG * 0.7 : RUN; }
    }
    if (gx !== null && b.healT <= 0) this._walk(b, gx, gz, speed, delta);
    else { b.vx = b.vz = 0; }
    if (!e && (Math.abs(b.vx) + Math.abs(b.vz) > 0.3)) { b.yaw = Math.atan2(b.vx, b.vz); b.aimYaw += angleDiff(b.yaw, b.aimYaw) * (1 - Math.exp(-6 * delta)); b.aimPitch *= 0.9; }

    // Pick up what it walked onto
    if (b.pick?.active && Math.hypot(b.pick.x - b.x, b.pick.z - b.z) < PICK_RANGE) this._take(b, b.pick);
    // Into the car it walked to
    if (b.mode === "car" && b.wantCar && !b.wantCar.driver && Math.hypot(b.wantCar.x - b.x, b.wantCar.z - b.z) < 3) this._enterCar(b, b.wantCar);
  }

  /** What to do next: fight, heal, loot, drive, head for the zone. */
  _decide(b) {
    const g = this.g, br = g.br;
    const match = br.state === "match";
    const now = g.now();
    // Enemies in sight
    let best = null, bestD = Infinity;
    if (match && b.weapon) {
      for (const t of this._targets) {
        if (t.id === b.id) continue;
        const dx = t.x - b.x, dz = t.z - b.z, d = Math.hypot(dx, dz);
        if (d > SIGHT || d > bestD) continue;
        // Behind it: only if close or it was just shot
        const cos = (dx * Math.sin(b.yaw) + dz * Math.cos(b.yaw)) / (d || 1);
        if (cos < FOV_COS && d > 6 && now - b.hitAt > 2) continue;
        if (!this._sees(b, t)) continue;
        best = t; bestD = d;
      }
    }
    if (best) {
      if (b.enemy?.id !== best.id) { b.seenFor = 0; b.aimErr = 0.12 + (1 - b.skill) * 0.15; }
      b.enemy = best;
      b.lastSeen = { x: best.x, y: best.y, z: best.z };
      b.lastSeenAt = now;
      b.mode = "fight";
      // A molotov at someone close and holding still
      if (b.throws.molotov && b.throwCd <= 0 && bestD > 7 && bestD < 22 && (best.speed ?? 0) < 1 && Math.random() < 0.3) this._throw(b, "molotov", best);
      return;
    }
    b.enemy = null;
    // Lost them: a grenade where they were, then go and look
    if (match && b.lastSeen && now - b.lastSeenAt < 5) {
      const d = Math.hypot(b.lastSeen.x - b.x, b.lastSeen.z - b.z);
      if (b.throws.grenade && b.throwCd <= 0 && d > 8 && d < 32) this._throw(b, "grenade", b.lastSeen);
      if (now - b.lastSeenAt < 3.5) { b.goal = b.lastSeen; b.mode = "hunt"; return; }
    }
    // Heal when it's quiet
    if (b.hp < 70 && b.healT <= 0 && now - b.lastSeenAt > 3 && now - b.hitAt > 2) {
      const kind = b.hp < 50 && b.heals.medkit ? "medkit" : b.heals.biscuit ? "biscuit" : b.heals.medkit ? "medkit" : null;
      if (kind) {
        b.healT = HEAL_TIME[kind]; b.healKind = kind;
        g.gesture(b.id, kind === "biscuit" ? "eat" : null, kind === "biscuit" ? 1.4 : 1.2);
        return;
      }
    }
    // Reload when nothing's going on
    const gun = b.weapon && b.guns[b.weapon];
    if (gun && gun.mag < WEAPONS[b.weapon].magSize * 0.5 && gun.reserve > 0 && b.reloadT <= 0) this._reload(b);

    if (b.mode === "warm") {
      if (!b.goal || Math.hypot(b.goal.x - b.x, b.goal.z - b.z) < 2) {
        const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 24;
        b.goal = { x: Math.cos(a) * r, z: Math.sin(a) * r };
      }
      return;
    }
    if (!match) return;

    // The zone: inside the next circle with room to spare
    const zone = br.zone;
    let zoneGoal = null;
    if (zone) {
      const zd = Math.hypot(b.x - zone.x, b.z - zone.z);
      const margin = zone.shrinking || zone.timeLeft < 25 ? 0.55 : 0.8;
      if (zd > zone.r * margin) {
        const a = Math.atan2(b.z - zone.z, b.x - zone.x) + (Math.random() - 0.5) * 0.6;
        const r = zone.r * (0.25 + Math.random() * 0.3);
        zoneGoal = { x: zone.x + Math.cos(a) * r, z: zone.z + Math.sin(a) * r, far: zd - zone.r * margin };
      }
    }
    // A free car when the zone is far away
    if (zoneGoal && zoneGoal.far > 90 && b.weapon && !b.car) {
      const car = g.vehicles.find(v => !v.driver && v.fuel > 8 && Math.hypot(v.x - b.x, v.z - b.z) < CAR_LOOK);
      if (car) { b.mode = "car"; b.wantCar = car; b.goal = { x: car.x, z: car.z }; b.pick = null; b.driveTo = zoneGoal; return; }
    }
    // Loot worth having nearby (more eager while it's poorly equipped)
    const needy = !b.weapon || b.gear.vest < 2 || b.heals.medkit + b.heals.biscuit < 2;
    if (!zoneGoal || zoneGoal.far < 25 || !b.weapon) {
      const pick = this._bestPickup(b, needy ? LOOT_LOOK : 25);
      if (pick) { b.pick = pick; b.mode = "loot"; b.goal = null; return; }
    }
    b.pick = null;
    if (zoneGoal) { b.goal = zoneGoal; b.mode = "zone"; return; }
    // Roam: toward the next town / loot spots, a little way at a time
    if (!b.goal || Math.hypot(b.goal.x - b.x, b.goal.z - b.z) < 3 || b.mode !== "roam") {
      const spots = g.dropSpots();
      const s = spots[(Math.random() * spots.length) | 0];
      const zr = zone ? zone.r * 0.7 : 200;
      b.goal = s && (!zone || Math.hypot(s.x - zone.x, s.z - zone.z) < zr) ? { x: s.x, z: s.z } : { x: (zone?.x ?? 0) + (Math.random() - 0.5) * zr, z: (zone?.z ?? 0) + (Math.random() - 0.5) * zr };
      b.mode = "roam";
    }
  }

  /** Line of sight from its eyes to the target's chest: no wall, no smoke. */
  _sees(b, t) {
    const g = this.g;
    _a.set(b.x, b.y + (b.stance ? 1.05 : 1.55), b.z);
    _b.set(t.x, t.y + 0.35, t.z);
    if (g.concealed(_a, _b)) return false;
    _from.set(_a.x, _a.y, _a.z); _to.set(_b.x, _b.y, _b.z);
    _res.reset();
    return !g.world.raycastClosest(_from, _to, losOpts, _res);
  }

  _bestPickup(b, range) {
    let best = null, bestScore = 0;
    const now = this.g.now();
    for (const e of this.g.pickups.active) {
      if (e.pending || !e.active) continue;
      if ((b.skip.get(e.uid) ?? 0) > now) continue; // couldn't get to it a moment ago
      const d = Math.hypot(e.x - b.x, e.z - b.z);
      if (d > range || Math.abs(e.y - b.y) > 2.5) continue;
      const v = this._worth(b, e.kind);
      if (v <= 0) continue;
      const score = v / (4 + d);
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  /** How much it wants an item (0: not at all). */
  _worth(b, kind) {
    if (WEAPONS[kind]) {
      const have = b.weapon ? GUN_RANK[b.weapon] : 0;
      if (b.guns[kind]) return 1.5; // its ammo
      return GUN_RANK[kind] > have ? 10 + GUN_RANK[kind] * 2 : 0;
    }
    if (kind === "ammo") return b.weapon && b.guns[b.weapon].reserve < WEAPONS[b.weapon].magSize * 3 ? 4 : 0.5;
    const gear = GEAR[kind];
    if (gear) {
      if (gear.slot === "backpack") return gear.level > b.gear.backpack ? 2 : 0;
      return gear.level > b.gear[gear.slot] ? 6 + gear.level * 2 : 0;
    }
    if (kind === "medkit") return b.heals.medkit < 3 ? 4 : 0;
    if (kind === "biscuit") return b.heals.biscuit < 5 ? 2.5 : 0;
    if (kind === "grenade" || kind === "molotov") return b.throws[kind] < 3 ? 3 : 0;
    if (kind === "smoke") return b.throws.smoke < 1 ? 0.6 : 0;
    return 0;
  }

  _take(b, e) {
    const g = this.g;
    const kind = e.kind, data = e.data;
    if (!g.takeLoot(e, b.id)) { b.pick = null; return; }
    if (WEAPONS[kind]) {
      const gun = b.guns[kind];
      const ammo = data?.ammo ?? WEAPONS[kind].magSize, reserve = data?.reserve === Infinity ? 60 : data?.reserve ?? BR_GUN_RESERVE[kind] ?? 30;
      if (gun) gun.reserve += ammo + reserve;
      else {
        b.guns[kind] = { mag: ammo, reserve };
        if (!b.weapon || GUN_RANK[kind] > GUN_RANK[b.weapon]) b.weapon = kind;
      }
    } else if (kind === "ammo") {
      for (const w of Object.keys(b.guns)) b.guns[w].reserve += WEAPONS[w].magSize * 2;
    } else if (GEAR[kind]) {
      const gear = GEAR[kind];
      b.gear[gear.slot] = gear.level;
      if (gear.slot !== "backpack") b.armor[gear.slot] = data?.dur ?? gear.durability;
    } else if (kind === "medkit" || kind === "biscuit") b.heals[kind] += data?.count ?? 1;
    else if (b.throws[kind] !== undefined) b.throws[kind] += data?.count ?? 1;
    g.gesture(b.id, null, 0.6);
    b.pick = null;
    b.think = 0;
  }

  /** Walks toward (gx, gz): pathing round houses (doors too), a wall probe, unsticking. */
  _walk(b, gx, gz, speed, delta) {
    const g = this.g;
    // Escaping after getting stuck: straight out along a free line for a moment
    if (b.escapeT > 0) {
      b.escapeT -= delta;
      gx = b.x + b.escX * 4; gz = b.z + b.escZ * 4;
    }
    const nav = this._nav;
    const r = g.navigate(b.x, b.z, gx, gz, nav, b.y, b.y);
    let tx = gx, tz = gz;
    if (r === 1 || r === 2) { tx = nav.x; tz = nav.z; }
    if (r === 2) g.openDoorAt(nav.fx ?? nav.x, nav.fz ?? nav.z, b.y);
    let dx = tx - b.x, dz = tz - b.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.2) { b.vx = b.vz = 0; return; }
    dx /= d; dz /= d;
    // A wall right ahead: try turning off a little, then more
    let ok = false;
    for (const turn of [0, 0.5, -0.5, 1.1, -1.1, 1.8, -1.8]) {
      const c = Math.cos(turn), s = Math.sin(turn);
      const ux = dx * c + dz * s, uz = -dx * s + dz * c;
      if (!this._blocked(b, ux, uz)) { dx = ux; dz = uz; ok = true; break; }
    }
    const v = ok ? Math.min(speed, d / Math.max(delta, 1e-3)) : 0;
    b.vx = dx * v; b.vz = dz * v;
    b.x += b.vx * delta; b.z += b.vz * delta;
    const ground = g.groundHeight(b.x, b.z);
    b.y = g.surfaceAt(b.x, b.z, b.y, ground);
    // Stuck (furniture, a corner, loot it can't reach): give up on that item for a
    // while and back out along the freest line; if even that fails, step clear
    b.stuckT += delta;
    if (b.stuckT > 1.5) {
      if (Math.hypot(b.x - b.lastX, b.z - b.lastZ) < 0.6 && speed > 0) {
        b.stuckN++;
        if (b.pick) b.skip.set(b.pick.uid, g.now() + 30);
        b.pick = null;
        this._escape(b, b.stuckN > 4);
      } else b.stuckN = 0;
      b.stuckT = 0; b.lastX = b.x; b.lastZ = b.z;
    }
  }

  /** Picks the direction with the longest free run and walks it (force: hop 1.5 m that way regardless). */
  _escape(b, force) {
    let best = 0, bx = 1, bz = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + Math.random() * 0.3;
      const ux = Math.cos(a), uz = Math.sin(a);
      let free = 0;
      for (const step of [0.75, 1.5, 3]) {
        _from.set(b.x, b.y + 0.9, b.z);
        _to.set(b.x + ux * step, b.y + 0.9, b.z + uz * step);
        _res.reset();
        if (this.g.world.raycastClosest(_from, _to, wallOpts, _res)) break;
        free = step;
      }
      if (free > best) { best = free; bx = ux; bz = uz; }
    }
    b.escX = bx; b.escZ = bz;
    b.escapeT = 1.2;
    b.goal = { x: b.x + bx * 6, z: b.z + bz * 6 };
    if (force) {
      b.x += bx * 1.5; b.z += bz * 1.5;
      b.y = this.g.surfaceAt(b.x, b.z, b.y, this.g.groundHeight(b.x, b.z));
      b.stuckN = 0;
    }
  }

  _blocked(b, ux, uz) {
    const g = this.g;
    for (const h of [0.55, 1.3]) {
      _from.set(b.x, b.y + h, b.z);
      _to.set(b.x + ux * STEP_CHECK, b.y + h, b.z + uz * STEP_CHECK);
      _res.reset();
      if (g.world.raycastClosest(_from, _to, wallOpts, _res)) return true;
    }
    return false;
  }

  // ── Shooting ────────────────────────────────────────────────────────────
  _reload(b) {
    const def = WEAPONS[b.weapon];
    b.reloadT = def.reloadTime * 1.1;
    this.g.gesture(b.id, "reload", b.reloadT);
  }

  _fire(b, e, dist) {
    const g = this.g;
    const def = WEAPONS[b.weapon], gun = b.guns[b.weapon];
    if (gun.mag <= 0) {
      if (gun.reserve > 0) this._reload(b);
      else { b.weapon = Object.keys(b.guns).find(w => b.guns[w].mag + b.guns[w].reserve > 0) ?? null; }
      return;
    }
    gun.mag--;
    // Bursts, then a breath (semi-auto guns at a human pace)
    b.burst++;
    const auto = def.auto;
    const maxBurst = auto ? 3 + ((Math.random() * 5) | 0) : 1;
    b.fireCd = 1 / def.fireRate * (auto ? 1 : 1.6 + Math.random());
    if (b.burst >= maxBurst) { b.burst = 0; b.fireCd += 0.25 + Math.random() * 0.5 * (1.2 - b.skill); }
    b.firing = 0.15;

    // From its eye (where the gun points), at the chest with the current error
    const own = b.p.body, ownGroup = own.collisionFilterGroup;
    own.collisionFilterGroup = 0;
    _a.set(b.x, b.y + (b.stance ? 1.05 : 1.5), b.z);
    const hits = [];
    this._pvp.clear();
    let head = false;
    for (let i = 0; i < def.pellets; i++) {
      const err = b.aimErr + (def.pellets > 1 ? def.spreadHip : def.spreadHip * 0.4) + (Math.hypot(b.vx, b.vz) > 1 ? 0.012 : 0);
      // At the chest, now and then the head (better shots go for it more)
      _b.set(e.x - _a.x, e.y + (Math.random() < 0.12 + b.skill * 0.1 ? 0.62 : 0.25) - _a.y, e.z - _a.z).normalize();
      _b.x += gauss() * err; _b.y += gauss() * err * 0.7; _b.z += gauss() * err;
      _b.normalize();
      _from.set(_a.x, _a.y, _a.z);
      _to.set(_a.x + _b.x * def.range, _a.y + _b.y * def.range, _a.z + _b.z * def.range);
      _res.reset();
      if (!g.world.raycastClosest(_from, _to, shotOpts, _res)) {
        hits.push(r2(_to.x), r2(_to.y), r2(_to.z));
        continue;
      }
      const p = _res.hitPointWorld;
      hits.push(r2(p.x), r2(p.y), r2(p.z));
      const victim = _res.body.playerTarget;
      if (!victim) { g.impact(p, _res.hitNormalWorld, "dust"); continue; }
      const hs = p.y - (_res.body.position.y - g.feetOffset) > PVP_HEAD_Y;
      head ||= hs;
      const dmg = (PVP_DAMAGE[b.weapon] ?? 15) * (hs ? PVP_HEADSHOT[b.weapon] ?? 1.5 : 1);
      this._pvp.set(victim.id, (this._pvp.get(victim.id) ?? 0) + dmg);
      g.impact(p, { x: -_b.x, y: 0.3, z: -_b.z }, "blood");
    }
    own.collisionFilterGroup = ownGroup;
    for (const [id, dmg] of this._pvp) g.hitPlayer(id, dmg, head, b.id, b.weapon, b.x, b.z);
    g.botShot(b.id, def, _a, hits);
  }

  _throw(b, kind, at) {
    const g = this.g;
    b.throws[kind]--;
    b.throwCd = 6 + Math.random() * 6;
    _a.set(b.x, b.y + 1.6, b.z);
    const dx = at.x - b.x, dz = at.z - b.z, d = Math.max(3, Math.hypot(dx, dz));
    const dy = (at.y ?? b.y) - _a.y;
    const c = Math.cos(THROW_ANGLE), t = Math.tan(THROW_ANGLE);
    const den = 2 * c * c * (d * t - dy);
    const speed = den > 0 ? Math.min(24, Math.sqrt(GRAVITY * d * d / den)) * (0.94 + Math.random() * 0.12) : 18;
    _b.set(dx / d * c * speed, Math.sin(THROW_ANGLE) * speed, dz / d * c * speed);
    g.botThrow(b.id, kind, _a, _b);
    g.gesture(b.id, null, 0.7);
  }

  // ── Vehicles ────────────────────────────────────────────────────────────
  _enterCar(b, car) {
    car.driver = b.id;
    car.remote = null;
    b.car = car;
    b.carT = 0;
    b.mode = "drive";
    b.enemy = null;
  }

  _leaveCar(b) {
    const car = b.car;
    if (!car) return;
    car.driver = null;
    car.speed = 0;
    car.yawRate = 0;
    const s = car.exitSpot ? car.exitSpot(this.g.solidAt, _v) : null;
    b.x = s?.x ?? car.x + 2; b.z = s?.z ?? car.z;
    b.y = this.g.groundHeight(b.x, b.z);
    b.car = null;
    b.mode = "zone";
    b.think = 0;
  }

  _drive(b, delta) {
    const car = b.car, goal = b.driveTo;
    b.carT += delta;
    const dx = goal.x - car.x, dz = goal.z - car.z, d = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz);
    const diff = angleDiff(want, car.yaw);
    const steer = THREE.MathUtils.clamp(diff * 2, -1, 1);
    const throttle = d < 12 ? 0.2 : Math.abs(diff) > 0.9 ? 0.45 : 1;
    const crash = car.drive(delta, { throttle: b.reverseT > 0 ? -0.8 : throttle, steer: b.reverseT > 0 ? -steer : steer, handbrake: false }, this.g.solidAt);
    if (crash > 3) b.reverseT = 1.2;
    b.reverseT = Math.max(0, (b.reverseT ?? 0) - delta);
    car.seatWorld(_v);
    b.x = _v.x; b.z = _v.z; b.y = _v.y - SEAT_UP;
    b.yaw = car.yaw; b.aimYaw = car.yaw; b.aimPitch = 0;
    b.vx = Math.sin(car.yaw) * car.speed; b.vz = Math.cos(car.yaw) * car.speed;
    // Out at the destination, when it's dry, after a long time, or when someone's shooting at it
    if (d < 18 || car.fuel <= 0 || b.carT > 60 || this.g.now() - b.hitAt < 0.5) this._leaveCar(b);
  }

  // ── Getting hurt ────────────────────────────────────────────────────────
  /**
   * Damage to bot `id` (host): by: attacker id (null for the zone), w: weapon /
   * cause, hs: headshot, sx / sz: where the attacker stood (for its reaction).
   */
  damage(id, dmg, hs, by, w, sx = null, sz = null) {
    const b = this.byId.get(id);
    if (!b) return;
    this._hurt(b, dmg, by, w, hs, sx, sz, false);
  }

  _hurt(b, dmg, by, w, hs, sx, sz, raw) {
    if (b.dead || b.phase === PHASE_PLANE || this.g.br.state === "end") return;
    // Armour soaks its share, like a player's
    if (!raw) {
      const slot = hs ? "helmet" : w === "grenade" || w === "molotov" ? null : "vest";
      if (slot && b.gear[slot] && b.armor[slot] > 0) {
        const stop = dmg * GEAR[`${slot}${b.gear[slot]}`].reduce;
        b.armor[slot] -= stop * 1.6;
        if (b.armor[slot] <= 0) b.gear[slot] = 0;
        dmg -= Math.min(stop, dmg * 0.75);
      }
    }
    b.hp -= dmg;
    b.hitAt = this.g.now();
    // It turns toward whoever's shooting (and remembers where they were)
    if (sx !== null && by !== null) {
      b.lastSeen = { x: sx, y: b.y + 1, z: sz };
      b.lastSeenAt = b.hitAt;
      if (!b.enemy) b.yaw = b.aimYaw = Math.atan2(sx - b.x, sz - b.z);
      b.think = Math.min(b.think, 0.1);
    }
    if (b.car && b.hp > 0) this._leaveCar(b);
    this.g.flinch(b.id, dmg);
    if (b.hp <= 0) this._die(b, by, w, hs);
  }

  _die(b, by, w, hs) {
    const g = this.g;
    b.hp = 0;
    b.dead = true;
    b.mode = "dead";
    b.enemy = null;
    b.vx = b.vz = 0;
    b.respawnT = 3;
    if (b.car) this._leaveCar(b);
    if (by && this.byId.has(by)) this.byId.get(by).kills++;
    // Its kit spills out for whoever gets there first
    const items = [];
    for (const [w2, gun] of Object.entries(b.guns)) items.push([w2, { ammo: gun.mag, reserve: gun.reserve, att: { optic: null, muzzle: null, mag: null, grip: null } }]);
    for (const k of ["grenade", "molotov", "smoke"]) if (b.throws[k] > 0) items.push([k, { count: b.throws[k] }]);
    for (const k of ["medkit", "biscuit"]) if (b.heals[k] > 0) items.push([k, { count: b.heals[k] }]);
    for (const slot of ["helmet", "vest", "backpack"]) if (b.gear[slot]) items.push([`${slot}${b.gear[slot]}`, { dur: b.armor[slot] ?? GEAR[`${slot}${b.gear[slot]}`].durability }]);
    if (items.length && g.br.state === "match") g.spill(items, b.x, b.y, b.z);
    g.botEliminated(b.id, by, w, hs);
  }

  /** A grenade went off (host): bots in reach take the blast. */
  blast(pos, by, radius, maxDamage) {
    for (const b of this.list) {
      if (b.dead || b.phase !== PHASE_GROUND) continue;
      const d = Math.hypot(b.x - pos.x, b.z - pos.z);
      if (d >= radius) continue;
      const shield = this.g.shielded(pos, b.x, b.y + 1.2, b.z) ? 0.15 : 1;
      this._hurt(b, maxDamage * (1 - d / radius) * shield, by === b.id ? null : by, "grenade", false, pos.x, pos.z, false);
    }
  }

  /** Molotov fire under (x, z) (host). */
  burn(x, z, r, dps, dt, by) {
    for (const b of this.list) {
      if (b.dead || b.phase !== PHASE_GROUND) continue;
      if (Math.hypot(b.x - x, b.z - z) < r + 0.35 && b.y - this.g.groundHeight(x, z) < 1) {
        this._hurt(b, dps * dt, by === b.id ? null : by, "molotov", false, null, null, false);
        if (!b.dead && this.g.now() - (b.fleeAt ?? -9) > 1) {
          b.fleeAt = this.g.now();
          const a = Math.atan2(b.z - z, b.x - x);
          b.goal = { x: b.x + Math.cos(a) * 6, z: b.z + Math.sin(a) * 6 };
        }
      }
    }
  }

  // ── State out ───────────────────────────────────────────────────────────
  /** The bot's state as a remote player packet, applied here and sent to everyone. */
  _publish(b) {
    const g = this.g;
    const s = (b.state ??= {});
    s.i = b.id; s.n = b.name; s.c = b.color;
    s.x = r2(b.x); s.y = r2(b.y + g.feetOffset); s.z = r2(b.z);
    s.vx = r1(b.vx); s.vz = r1(b.vz);
    s.by = r2(b.yaw); s.ay = r2(b.aimYaw); s.ap = r2(b.aimPitch);
    s.aim = b.aiming ? 1 : 0; s.fire = b.firing > 0 ? 1 : 0;
    s.hp = Math.max(0, Math.round(b.hp)); s.k = b.kills;
    s.w = b.weapon; s.dead = b.dead ? 1 : 0;
    s.sn = b.stance; s.ph = b.phase;
    s.g = b.gear.helmet * 100 + b.gear.vest * 10 + b.gear.backpack;
    s.veh = b.car ? [r2(b.car.x), r2(b.car.z), r2(b.car.yaw), r1(b.car.speed), Math.round(b.car.fuel), g.vehicles.indexOf(b.car)] : undefined;
    g.remotePlayers.applyState(b.id, s);
  }

  /** Host: everyone's bots, 10 times a second. */
  netTick(delta) {
    if (!this.list.length) return;
    this._netT -= delta;
    if (this._netT > 0) return;
    this._netT = 0.1;
    this.g.net.send({ t: "bots", l: this.list.map(b => b.state).filter(Boolean) });
  }

  /** Not the host: the host's bots as remote players (and the vehicles they drive). */
  applyNet(msg) {
    const g = this.g;
    for (const s of msg.l ?? []) {
      if (!isBotId(s.i)) continue;
      if (!g.remotePlayers.players.has(s.i)) g.remotePlayers.add({ id: s.i, name: s.n, color: s.c });
      g.remotePlayers.applyState(s.i, s);
      const car = s.veh ? g.vehicles[s.veh[5]] : null;
      if (car) car.setRemote(s.i, s.veh[0], s.veh[1], s.veh[2], s.veh[3], s.veh[4]);
      for (const v of g.vehicles) if (v !== car && v.driver === s.i) v.releaseRemote();
    }
  }
}
