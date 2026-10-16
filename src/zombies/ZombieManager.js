import * as THREE from "three";
import { groundHeight } from "../world/Terrain.js";
import * as CANNON from "cannon-es";
import { MonsterPools } from "./MonsterPool.js";
import { ENEMY_GUNS } from "./MonsterTypes.js";
import { GROUP_NONE, GROUP_WORLD } from "../physicsGroups.js";

// ─── Crowd / melee tuning ─────────────────────────────────────────────────────
const MAX_ATTACKERS       = 5;    // melee monsters allowed in the inner ring at once
const ENGAGE_GAP          = 0.2;  // gap kept between monster and player capsules
const ATTACK_REACH        = 0.55; // extra reach beyond the engage ring for a hit to land
const WAIT_RING_OFFSET    = 2.2;  // how far outside the melee ring the waiting crowd circles
const SEPARATION_PADDING  = 0.15;
const SEPARATION_STRENGTH = 4.0;
const STEER_ACCEL         = 9.0;  // exp-blend rate toward desired velocity
const ROLE_REFRESH_TIME   = 0.2;
const NAV_INTERVAL        = 0.15; // seconds between path re-plans per monster

// ─── Reactions / death ────────────────────────────────────────────────────────
const HIT_FLASH_TIME    = 0.07;
const STAGGER_TIME      = 0.22;
const CORPSE_HOLD_TIME  = 2.5;
const CORPSE_SINK_TIME  = 1.5;
const CORPSE_SINK_DEPTH = 1.2;
const BURN_DPS          = 26;
const CORPSE_BURN_TIME  = 3.0;
const TARGET_CENTRE     = 0.9;  // a player target's pos is its body centre, this far above its feet

// ─── Senses ───────────────────────────────────────────────────────────────────
const SENSE_INTERVAL   = 0.25; // seconds between sight checks (each is a raycast)
const TOUCH_RADIUS     = 3.0;  // always noticed this close, whatever the senses
const LOSE_TIME        = 5;    // seconds without seeing/hearing the player before searching
const SPOT_TIME        = 0.65; // "!" reaction pause before charging
const LOOK_TIME        = 3.2;  // looking around at an investigated spot
const BORED_TIME       = 45;   // wandering this long without a lead → they smell you out
const WANDER_SPEED     = 0.38; // × type speed
const INVESTIGATE_SPEED = 0.7;
const SEARCH_SPEED     = 0.85;
const MARKER_RANGE     = 55;

// ─── Distance tiers (see CLAUDE.md performance rules) ─────────────────────────
const FAR_TIER  = 80;
const ANIM_NEAR = 25;   // animation updates every frame closer than this
const ANIM_MID  = 50;   // every 2nd frame up to here, every 3rd beyond

// ─── Creatures (hound / dragon) ───────────────────────────────────────────────
const PACK_RADIUS     = 34;   // a hound that spots you calls the pack within this
const FLY_LERP        = 1.1;  // altitude change rate (exp-blend)
const FALL_GRAVITY    = 18;   // dead flyers drop out of the sky
const ROLL_TIME       = 0.45; // procedural death: time to keel over

const byPriority = (a, b) => a.priority - b.priority;
const pick = list => list[(Math.random() * list.length) | 0];
const _eyeFrom = new CANNON.Vec3();
const _eyeTo = new CANNON.Vec3();
const _eyeRes = new CANNON.RaycastResult();
const losOpts = { collisionFilterMask: GROUP_WORLD, skipBackfaces: true }; // glass doesn't block sight
const _muzzle = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _laserEnd = new THREE.Vector3();

/**
 * Monster AI. Every monster runs a small state machine driven by its senses:
 *
 *   wander ─ sees a bit / hears ─▶ investigate ("?") ─ spots ─▶ alert ("!") ─▶ chase
 *      ▲                                                                      │
 *      └──────────────── search (last known position) ◀── loses you ─────────┘
 *
 * Sight needs range + field of view + line of sight (walls block, glass
 * doesn't) and builds an awareness meter. Hearing reacts to noise() events:
 * footsteps, gunfire, explosions, doors. "hunter" types (Listeners) charge
 * straight at what they hear. Gunners and the Warlord fight at range.
 *
 * Co-op: monsters choose among several targets (getTargets()), each
 *   { id, pos:{x,y,z}, vel:{x,z}, alive, vis, local }
 * and report hits through onPlayerHit(target, damage, kx, kz, shake, srcX, srcZ).
 */
export class ZombieManager {
  constructor({
    scene, world, monsterMaterial, linDamping, angDamping,
    playerRadius, getTargets, onPlayerHit, regenPlayerHealth,
    enemyFire, sfx, loadGLB,
  }) {
    this.world = world;
    this.playerRadius = playerRadius;
    this.getTargets = getTargets;
    this.onPlayerHit = onPlayerHit;
    this.regenPlayerHealth = regenPlayerHealth;
    this.enemyFire = enemyFire;
    this.sfx = sfx;
    this._targets = [];
    this._netId = 0;

    this.pool = new MonsterPools({ scene, world, monsterMaterial, linDamping, angDamping, loadGLB });
    this.settings = { enableAI: true };

    this.kills = 0;
    this.chasingCount = 0;
    this.aliveCount = 0;
    this.boss = null;          // the living Warlord (or dragon), for the HUD bar
    this.scentMul = 1;         // rain washes scent out (set by main.js)
    // Hooks (set by main.js / the level director)
    this.onKill = null;        // (monster)
    this.onSpotted = null;     // (monster) first time a monster spots the player
    this.onDoorBang = null;    // (x, z)
    this.onCrash = null;       // (monster) a dead flyer hit the ground
    this.navigate = null;      // (zx, zz, tx, tz, out, big, zy, ty) → 0 | 1 | 2 (zy / ty: feet heights)
    this.surfaceAt = null;
    this._animFrame = 0;     // (x, z, feetY, terrainY) → height walked on (house floors, stairs)
    this.canSpawnAt = null;    // (x, z) → bool

    this._chasers = [];
    this._roleTimer = 0;
    this._time = 0;
  }

  _localDist(x, z) {
    const me = this._localTarget();
    return me ? Math.hypot(me.pos.x - x, me.pos.z - z) : 30;
  }

  /** True if a bullet hitting world point p struck the head. */
  isHeadshot(m, p, headHeight) {
    if (m.headSphere) {
      const h = m.headSphere;
      const r = THREE.MathUtils.degToRad(m.rotY);
      const hx = m.body.position.x + Math.sin(r) * h.z;
      const hz = m.body.position.z + Math.cos(r) * h.z;
      const hy = m.root.position.y + h.y;
      return Math.hypot(p.x - hx, p.y - hy, p.z - hz) < h.r * 1.2;
    }
    return p.y - m.root.position.y > m.height - headHeight * (m.height / 2.43);
  }

  _nearestTarget(x, z, onlyAlive = true) {
    let best = null, bd = Infinity;
    for (const t of this._targets) {
      if (onlyAlive && !t.alive) continue;
      const d = (t.pos.x - x) ** 2 + (t.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  _localTarget() {
    return this._targets.find(t => t.local) ?? this._targets[0];
  }

  async init() {
    await this.pool.load();
  }

  get active() { return this.pool.active; }

  // ── Spawning ────────────────────────────────────────────────────────────────

  /**
   * opts: hpMul, damageMul, speedMul, homeX/homeZ (where it wanders), hunting
   * (start out investigating toward home instead of idling).
   */
  spawn(type, x, z, opts = {}) {
    if (this.canSpawnAt && !this.canSpawnAt(x, z)) return null;
    const def = this.pool.types[type]?.def;
    if (!def) return null;
    const hp = Math.round(def.hp * (opts.hpMul ?? 1));
    const m = this.pool.acquire(type, x, z, hp);
    if (!m) return null;

    m.netId = ++this._netId;
    m.target = null;
    m.lastHitBy = null;
    m.damageMul = opts.damageMul ?? 1;
    m.speed = def.speed * (opts.speedMul ?? 1) * (0.88 + Math.random() * 0.24);
    m.attackTimer = Math.random() * m.attackInterval;
    m.circleDir = Math.random() < 0.5 ? -1 : 1;
    m.taunts = Math.random() < 0.35;
    m.isAttacker = false;
    m.nav = 0;
    m.navTimer = Math.random() * NAV_INTERVAL;
    m.navPoint ??= { x: 0, z: 0, fx: 0, fz: 0 };
    m.surfY = null;          // floor height it last walked on (set by _pinToGround)
    m.navTarget ??= { x: 0, z: 0 };
    m.state = "wander";
    m.stateTimer = 0;
    m.awareness = 0;
    m.senseTimer = Math.random() * SENSE_INTERVAL;
    m.hasLOS = false;
    m.lostTimer = 0;
    m.boredTimer = 0;
    m.markerTimer = 0;
    m.homeX = opts.homeX ?? x;
    m.homeZ = opts.homeZ ?? z;
    m.goalX = x; m.goalZ = z;
    m.lastX = x; m.lastZ = z;
    m.wanderTimer = 0;
    m.gun = m.def.ranged ? ENEMY_GUNS[m.def.ranged.gun ?? m.weaponId] : null;
    m.gunPhase = "cool";
    m.gunTimer = 1 + Math.random();
    m.shotsLeft = 0;
    m.aimX = x; m.aimY = 1; m.aimZ = z;
    m.strafeTimer = 0;
    m.pounceCd = 1 + Math.random() * 2;
    m.pounceT = 0;
    if (opts.hunting) this._investigate(m, m.homeX, m.homeZ);
    if (def.boss || def.bossBar) this.boss = m;
    return m;
  }

  /** Puts a living monster back in the pool without counting a kill (leash). */
  recycle(m) {
    if (!m?.active) return;
    if (this.boss === m) this.boss = null;
    this.pool.release(m);
  }

  clearAll() {
    for (let i = this.pool.active.length - 1; i >= 0; i--) this.pool.release(this.pool.active[i]);
    this.boss = null;
  }

  // ── Damage ──────────────────────────────────────────────────────────────────

  /** Returns true if this hit killed the monster. byId: the player who did it (kill credit + aggro). */
  damage(m, amount, pushX = 0, pushZ = 0, byId = null) {
    if (!m?.active || m.dying) return false;
    m.health = Math.max(0, m.health - amount);
    m.flashTimer = HIT_FLASH_TIME;
    m.mesh.material = m.mats.hit;
    if (byId !== null) m.lastHitBy = byId;

    // Getting shot gives the shooter away
    if (m.state !== "chase" && m.state !== "alert") {
      const t = this._targets.find(x => x.id === m.lastHitBy && x.alive)
        ?? this._nearestTarget(m.body.position.x, m.body.position.z);
      if (t) this._spot(m, t.pos.x, t.pos.z, t);
    }

    if (m.health <= 0) {
      this.kill(m);
      return true;
    }
    const heavy = m.def.bigBody;
    m.staggerTimer = heavy ? STAGGER_TIME * 0.3 : STAGGER_TIME;
    if (m.pounceT > 0) return false; // mid-leap: no flinch, no shove
    const pushK = heavy ? 0.25 : 1;
    m.body.velocity.x += pushX * pushK;
    m.body.velocity.z += pushZ * pushK;
    const pains = m.kind.painClips;
    if (pains.length && (!heavy || Math.random() < 0.2)) {
      if (m.currentAnim !== "attack" || m.animLockTimer <= 0) {
        m.animLockTimer = 0;
        this._setAnimation(m, pick(pains), 0.3);
      }
    }
    return false;
  }

  /** Sets a monster on fire for `duration` seconds (refreshes, never shortens). */
  ignite(m, duration, byId = null) {
    if (!m?.active) return;
    const wasBurning = m.burnTimer > 0;
    m.burnTimer = Math.max(m.burnTimer ?? 0, duration);
    if (!wasBurning && !m.dying) this.damage(m, 1, 0, 0, byId);
  }

  kill(m) {
    if (!m?.active || m.dying) return;
    if (m.burnTimer > 0) m.burnTimer = Math.max(m.burnTimer, CORPSE_BURN_TIME);
    m.dying = true;
    m.dieTimer = 0;
    m.isAttacker = false;
    m.state = "dead";
    m.marker.visible = false;
    m.body.collisionFilterGroup = GROUP_NONE;
    m.body.velocity.set(0, 0, 0);
    m.animLockTimer = 0;
    m.pounceT = 0;
    const deaths = m.kind.deathClips;
    if (deaths.length) {
      this._setAnimation(m, pick(deaths), 99);
    } else {
      // No death clip: flinch, freeze, then keel over (flyers drop out of the sky first)
      m.deathStyle = m.def.flying ? "fall" : "roll";
      m.deathT = 0;
      m.rollT = 0;
      m.fallV = 0;
      m.rollSide = Math.random() < 0.5 ? -1 : 1;
      if (m.kind.painClips.length) this._setAnimation(m, m.kind.painClips[0], 99);
      if (m.def.voice === "dragon") this.sfx?.dragonRoar(this._localDist(m.body.position.x, m.body.position.z), true);
      else if (m.def.voice === "hound") this.sfx?.yelp(this._localDist(m.body.position.x, m.body.position.z));
    }
    if (this.boss === m) this.boss = null;
    this.kills++;
    this.onKill?.(m);
  }

  // ── Hearing ─────────────────────────────────────────────────────────────────

  /**
   * A noise at (x, z) audible within `radius` metres (scaled per monster by
   * its hearing). kind: "step" | "shot" | "explosion" | "door".
   */
  noise(x, z, radius, kind) {
    for (const m of this.pool.active) {
      if (m.dying) continue;
      const p = m.body.position;
      const r = radius * m.def.hearing;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > r) continue;
      if (m.state === "chase") {
        // Keeps tracking by ear even without line of sight
        m.lastX = x; m.lastZ = z;
        m.lostTimer = Math.min(m.lostTimer, kind === "step" ? 1.5 : 0);
        continue;
      }
      if (m.state === "alert") continue;
      const unmistakable = (kind === "shot" && d < r * 0.45) || (kind === "explosion" && d < r * 0.55);
      if (m.def.hunter && kind !== "door") this._spot(m, x, z);
      else if (unmistakable) this._spot(m, x, z);
      else {
        m.awareness = Math.min(0.9, m.awareness + (kind === "step" ? 0.15 : 0.45));
        this._investigate(m, x, z);
      }
    }
  }

  // ── States ──────────────────────────────────────────────────────────────────

  _investigate(m, x, z) {
    m.state = "investigate";
    m.goalX = x + (Math.random() - 0.5) * 3;
    m.goalZ = z + (Math.random() - 0.5) * 3;
    m.stateTimer = 0;
    m.boredTimer = 0;
  }

  /** quiet: a pack member answering the call (no extra howl). */
  _spot(m, x, z, target = null, quiet = false) {
    if (m.state === "chase" || m.state === "alert" || m.dying) return;
    const def = m.def;
    m.target = target ?? this._nearestTarget(x, z);
    m.state = "alert";
    m.stateTimer = def.boss || def.flying ? 1.2 : def.pack ? 0.35 : SPOT_TIME;
    m.lastX = x; m.lastZ = z;
    m.lostTimer = 0;
    m.awareness = 1;
    m.markerTimer = 1.6;
    m.animLockTimer = 0;
    if (m.actions.point && Math.random() < 0.6) this._setAnimation(m, "point", m.stateTimer);
    const d = this._localDist(m.body.position.x, m.body.position.z);
    if (def.voice === "hound") { if (!quiet) this.sfx?.howl(d); }
    else if (def.voice === "dragon") this.sfx?.dragonRoar(d);
    else this.sfx?.growl(d, !!def.bigBody);
    this.onSpotted?.(m);
    // Pack hunters: one spots you, the rest nearby come running
    if (def.pack) {
      const p = m.body.position;
      for (const o of this.pool.active) {
        if (o === m || o.type !== m.type || o.dying) continue;
        if (Math.hypot(o.body.position.x - p.x, o.body.position.z - p.z) < PACK_RADIUS) this._spot(o, x, z, m.target, true);
      }
    }
  }

  /** t: a target. Returns 0 if unseen, else how clearly (0..1.5). */
  _canSee(m, t, engaged) {
    if (!t?.alive) return 0;
    const pp = t.pos;
    const def = m.def;
    const p = m.body.position;
    const dx = pp.x - p.x, dz = pp.z - p.z;
    const dist = Math.hypot(dx, dz);
    const range = def.sight.range * (engaged ? 1.6 : 1) * (t.vis ?? 1);
    if (dist > range) return 0;
    let peripheral = 1;
    if (!engaged && dist > 0.1) {
      const r = THREE.MathUtils.degToRad(m.rotY);
      const cos = (dx * Math.sin(r) + dz * Math.cos(r)) / dist;
      if (cos < Math.cos(THREE.MathUtils.degToRad(def.sight.fov / 2))) {
        if (dist > range * 0.3) return 0;
        peripheral = 0.35; // something moved at the edge of vision
      }
    }
    _eyeFrom.set(p.x, m.root.position.y + def.height * 0.85, p.z);
    _eyeTo.set(pp.x, pp.y + (t.eyeOff ?? 0.4), pp.z); // lower when crouched / prone (Stance.js)
    _eyeRes.reset();
    if (this.world.raycastClosest(_eyeFrom, _eyeTo, losOpts, _eyeRes)) return 0;
    return peripheral * (1.5 - dist / range);
  }

  /** Scent: the nearest living player within the type's scent radius (walls and darkness don't matter). */
  _smell(m) {
    const r = (m.def.scent ?? 0) * this.scentMul;
    if (r <= 0) return null;
    const p = m.body.position;
    const t = this._nearestTarget(p.x, p.z);
    return t && Math.hypot(t.pos.x - p.x, t.pos.z - p.z) < r ? t : null;
  }

  _sense(m, tick) {
    const p = m.body.position;
    if (m.state === "chase") {
      let t = m.target;
      if (!t?.alive || !this._targets.includes(t)) {
        t = m.target = this._nearestTarget(p.x, p.z);
        if (!t) { m.state = "search"; m.goalX = m.lastX; m.goalZ = m.lastZ; m.stateTimer = 0; return; }
      }
      // Switch to a much closer teammate if one is in plain view
      const dCur = Math.hypot(t.pos.x - p.x, t.pos.z - p.z);
      for (const o of this._targets) {
        if (o === t || !o.alive) continue;
        if (Math.hypot(o.pos.x - p.x, o.pos.z - p.z) < dCur * 0.6 && this._canSee(m, o, true) > 0) { t = m.target = o; break; }
      }
      const pp = t.pos;
      const dist = Math.hypot(pp.x - p.x, pp.z - p.z);
      m.hasLOS = this._canSee(m, t, true) > 0;
      if (m.hasLOS || dist < TOUCH_RADIUS || this._smell(m) === t) {
        m.lastX = pp.x; m.lastZ = pp.z;
        m.lostTimer = 0;
      } else {
        m.lostTimer += tick;
        if (m.lostTimer > LOSE_TIME) {
          m.state = "search";
          m.goalX = m.lastX; m.goalZ = m.lastZ;
          m.stateTimer = 0;
          m.isAttacker = false;
        }
      }
      return;
    }
    if (m.state === "alert") return;
    m.hasLOS = false;
    // Scent builds awareness fast and leads the way, even blind
    const scent = this._smell(m);
    if (scent) {
      m.awareness += tick * 1.6;
      if (m.awareness >= 1) { this._spot(m, scent.pos.x, scent.pos.z, scent); return; }
      if (m.state === "wander") this._investigate(m, scent.pos.x, scent.pos.z);
      else { m.goalX = scent.pos.x; m.goalZ = scent.pos.z; }
    }
    // Whoever is closest or most visible
    let seen = 0, best = null;
    for (const t of this._targets) {
      if (!t.alive) continue;
      if (Math.hypot(t.pos.x - p.x, t.pos.z - p.z) < TOUCH_RADIUS) { this._spot(m, t.pos.x, t.pos.z, t); return; }
      const v = this._canSee(m, t, false);
      if (v > seen) { seen = v; best = t; }
    }
    if (seen > 0) {
      const pp = best.pos;
      m.awareness += seen * 2.2 * tick;
      if (m.awareness >= 1) { this._spot(m, pp.x, pp.z, best); return; }
      if (m.awareness > 0.4 && m.state === "wander") this._investigate(m, pp.x, pp.z);
      else if (m.state !== "wander") { m.goalX = pp.x; m.goalZ = pp.z; }
    } else if (!scent) {
      m.awareness = Math.max(0, m.awareness - 0.25 * tick);
    }
  }

  // ── Movement helpers ────────────────────────────────────────────────────────

  _setAnimation(m, name, minDuration = 0) {
    if (m.currentAnim === name) return;
    if (m.animLockTimer > 0) return;
    const next = m.actions[name];
    if (!next) return;
    const prev = m.actions[m.currentAnim];
    if (prev && prev !== next) prev.fadeOut(0.2);
    next.reset().fadeIn(0.2).play();
    if (m.wActions) {
      m.wActions[m.currentAnim]?.fadeOut(0.2);
      m.wActions[name]?.reset().fadeIn(0.2).play();
    }
    m.currentAnim = name;
    if (minDuration > 0) m.animLockTimer = minDuration;
  }

  _setRunRate(m, rate) {
    m.actions.run?.setEffectiveTimeScale(rate);
    m.wActions?.run?.setEffectiveTimeScale(rate);
  }

  _faceTowards(m, dx, dz, delta, rate) {
    const target = Math.atan2(dx, dz);
    const cur = THREE.MathUtils.degToRad(m.rotY);
    let diff = target - cur;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    m.rotY = THREE.MathUtils.radToDeg(cur + diff * Math.min(1, delta * rate));
  }

  _steer(m, dx, dz, delta) {
    const v = m.body.velocity;
    const blend = 1 - Math.exp(-STEER_ACCEL * delta);
    v.x += (dx - v.x) * blend;
    v.z += (dz - v.z) * blend;
  }

  /** Run-clip speed for a ground speed v. GLB creatures say at what speed their clip plays at 1×. */
  _runRate(m, v, lo = 0.3, hi = 1.6) {
    const ref = m.def.runRef;
    return ref ? THREE.MathUtils.clamp(v / ref, 0.6, 1.5) : THREE.MathUtils.clamp(v / 2.8, lo, hi) * 0.6;
  }

  /** Walk / run / idle for a ground speed v (walk only for types with a walk clip). */
  _locomotion(m, v, idle = "stand") {
    const def = m.def;
    if (v <= 0.3) { this._setAnimation(m, idle); return; }
    if (m.actions.walk && v < def.walkMax) {
      this._setAnimation(m, "walk");
      m.actions.walk.setEffectiveTimeScale(THREE.MathUtils.clamp(v / def.walkRef, 0.5, 1.6));
      return;
    }
    this._setAnimation(m, "run");
    this._setRunRate(m, this._runRate(m, v));
  }

  _runAnim(m) {
    if (m.staggerTimer > 0) return;
    this._locomotion(m, Math.hypot(m.body.velocity.x, m.body.velocity.z));
  }

  /**
   * Walks toward (tx, tz), detouring around houses and through doorways.
   * Returns the nav code (2 = stuck at a closed door) and leaves the distance
   * to the target in m.goalDist.
   */
  _moveTo(m, tx, tz, speed, delta, bangDoors) {
    const p = m.body.position;
    if (this.navigate && !m.def.flying) {
      m.navTimer -= delta;
      const moved = Math.abs(m.navTarget.x - tx) + Math.abs(m.navTarget.z - tz) > 1.5;
      if (m.navTimer <= 0 || moved) {
        m.navTimer = NAV_INTERVAL;
        m.navTarget.x = tx; m.navTarget.z = tz;
        // navTY: the chase's target feet height (else stay on this floor)
        m.nav = this.navigate(p.x, p.z, tx, tz, m.navPoint, !!m.def.bigBody, m.root.position.y, m.navTY ?? m.root.position.y);
      }
    } else m.nav = 0;
    const wx = m.nav ? m.navPoint.x : tx;
    const wz = m.nav ? m.navPoint.z : tz;
    const dx = wx - p.x, dz = wz - p.z;
    const d = Math.hypot(dx, dz);
    m.goalDist = Math.hypot(tx - p.x, tz - p.z);
    m.body.wakeUp();

    if (m.nav === 2 && d < 1.3) {
      this._steer(m, m.sepX * 0.5, m.sepZ * 0.5, delta);
      this._faceTowards(m, m.navPoint.fx - p.x, m.navPoint.fz - p.z, delta, 8);
      if (bangDoors && m.staggerTimer <= 0) {
        this._setAnimation(m, "attack", 0.8);
        const prev = m.attackTimer;
        m.attackTimer += delta;
        const hitTime = m.attackInterval * 0.5;
        if (prev < hitTime && m.attackTimer >= hitTime) this.onDoorBang?.(m.navPoint.fx, m.navPoint.fz);
        if (m.attackTimer >= m.attackInterval) m.attackTimer -= m.attackInterval;
      } else if (m.staggerTimer <= 0) {
        this._setAnimation(m, "stand");
      }
      return 2;
    }
    const s = speed * (m.staggerTimer > 0 ? 0.25 : 1);
    const k = d > 1e-4 ? Math.min(s, d * 3) / d : 0;
    this._steer(m, dx * k + m.sepX, dz * k + m.sepZ, delta);
    if (d > 0.05) this._faceTowards(m, dx, dz, delta, m.def.flying ? 2.5 : 8);
    this._runAnim(m);
    return m.nav;
  }

  _lookAround(m, delta) {
    this._steer(m, m.sepX * 0.3, m.sepZ * 0.3, delta);
    m.rotY += Math.sin(m.stateTimer * 1.7 + m.id) * 70 * delta;
    if (m.staggerTimer <= 0) this._setAnimation(m, "stand");
  }

  // ── Behaviours ──────────────────────────────────────────────────────────────

  _updateWander(m, delta) {
    m.boredTimer += delta;
    if (m.boredTimer > BORED_TIME) {
      const t = this._nearestTarget(m.body.position.x, m.body.position.z);
      if (t) { this._investigate(m, t.pos.x, t.pos.z); return; } // smells you out eventually
      m.boredTimer = 0;
    }
    m.wanderTimer -= delta;
    if (m.wanderTimer <= 0) {
      m.wanderTimer = 4 + Math.random() * 5;
      if (Math.random() < 0.35) {
        m.goalX = m.body.position.x; m.goalZ = m.body.position.z; // pause
      } else {
        const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 10;
        m.goalX = m.homeX + Math.cos(a) * r;
        m.goalZ = m.homeZ + Math.sin(a) * r;
      }
    }
    const p = m.body.position;
    if (Math.hypot(m.goalX - p.x, m.goalZ - p.z) < 0.8) {
      this._steer(m, m.sepX * 0.3, m.sepZ * 0.3, delta);
      if (m.staggerTimer <= 0) this._setAnimation(m, m.taunts && m.actions.taunt && m.wanderTimer > 3 ? "taunt" : "stand");
      return;
    }
    this._moveTo(m, m.goalX, m.goalZ, m.speed * WANDER_SPEED, delta, false);
  }

  _updateInvestigate(m, delta, speedMul, lookTime) {
    if (m.stateTimer > 0) {
      // Arrived: look around, then give up
      m.stateTimer += delta;
      this._lookAround(m, delta);
      if (m.stateTimer > lookTime) {
        m.state = "wander";
        m.homeX = m.goalX; m.homeZ = m.goalZ;
        m.wanderTimer = 0;
        m.awareness *= 0.5;
      }
      return;
    }
    const nav = this._moveTo(m, m.goalX, m.goalZ, m.speed * speedMul, delta, false);
    if (m.goalDist < 1.4 || nav === 2) m.stateTimer = 0.001;
  }

  _updateAlert(m, delta) {
    m.stateTimer -= delta;
    const p = m.body.position;
    this._steer(m, m.sepX * 0.3, m.sepZ * 0.3, delta);
    this._faceTowards(m, m.lastX - p.x, m.lastZ - p.z, delta, 10);
    if (m.stateTimer <= 0) {
      m.state = "chase";
      m.lostTimer = 0;
      m.hasLOS = this._canSee(m, m.target, true) > 0;
      m.animLockTimer = 0;
    }
  }

  _meleeAttack(m, delta, dist, nx, nz) {
    // No biting through a floor or ceiling: the target must be on about the same level
    const level = m.target ? Math.abs(m.target.pos.y - TARGET_CENTRE - m.root.position.y) < 1.7 : false;
    const inRange = dist <= m.attackRange && m.staggerTimer <= 0 && m.target?.alive && level;
    if (!inRange) {
      m.attackTimer = Math.min(m.attackTimer, m.attackInterval * 0.3);
      return false;
    }
    this._setAnimation(m, "attack", 0.8);
    const rate = m.def.melee.rate;
    const prev = m.attackTimer;
    m.attackTimer += delta * rate;
    const hitTime = m.attackInterval * 0.5;
    if (prev < hitTime && m.attackTimer >= hitTime) {
      const mel = m.def.melee;
      const p = m.body.position;
      this.onPlayerHit(m.target, mel.damage * m.damageMul, nx * mel.knock, nz * mel.knock, m.def.bigBody ? 0.7 : 0.45, p.x, p.z);
    }
    if (m.attackTimer >= m.attackInterval) m.attackTimer -= m.attackInterval;
    return true;
  }

  _updateChaseMelee(m, delta) {
    const pp = m.target.pos;
    const tracking = m.hasLOS || m.lostTimer < 1.5;
    const tx = tracking ? pp.x : m.lastX;
    const tz = tracking ? pp.z : m.lastZ;
    if (m.pounceT > 0 && this._updatePounce(m, delta)) return;
    // Route around buildings / through doors first
    if (this.navigate) {
      m.navTimer -= delta;
      if (m.navTimer <= 0) {
        m.navTimer = NAV_INTERVAL;
        const p = m.body.position;
        // Feet heights, so monsters take the stairs to someone on the other floor
        m.navTY = tracking ? pp.y - TARGET_CENTRE : m.root.position.y;
        m.nav = this.navigate(p.x, p.z, tx, tz, m.navPoint, !!m.def.bigBody, m.root.position.y, m.navTY);
      }
      if (m.nav) {
        m.isAttacker = false;
        m.navTY = tracking ? pp.y - TARGET_CENTRE : m.root.position.y;
        this._moveTo(m, tx, tz, m.speed, delta, true);
        m.navTY = null;
        return;
      }
    }

    const p = m.body.position;
    const dx = tx - p.x, dz = tz - p.z;
    const dist = Math.hypot(dx, dz);
    const nx = dist > 1e-4 ? dx / dist : 0;
    const nz = dist > 1e-4 ? dz / dist : 0;
    if (m.def.pounce && tracking && m.hasLOS && this._tryPounce(m, dist, nx, nz)) return;
    const ring = m.isAttacker ? m.engageRadius : m.engageRadius + WAIT_RING_OFFSET;
    const err = dist - ring;
    const speed = m.speed * (m.staggerTimer > 0 ? 0.25 : 1);
    const radial = err > 0 ? Math.min(speed, err * 3) : Math.max(-2, err * 6);
    let vx = nx * radial + m.sepX;
    let vz = nz * radial + m.sepZ;
    if (!m.isAttacker && Math.abs(err) < 1 && !m.taunts) {
      vx += -nz * 0.7 * m.circleDir;
      vz += nx * 0.7 * m.circleDir;
    }
    this._steer(m, vx, vz, delta);
    m.body.wakeUp();
    this._faceTowards(m, dx, dz, delta, 10);
    if (tracking && m.isAttacker && this._meleeAttack(m, delta, dist, nx, nz)) return;
    if (m.staggerTimer <= 0) {
      const v = Math.hypot(m.body.velocity.x, m.body.velocity.z);
      if (v > 0.35 && !m.actions.walk) {
        this._setAnimation(m, "run");
        this._setRunRate(m, this._runRate(m, v, 0.35, 1.8));
      } else {
        this._locomotion(m, v, m.taunts && m.actions.taunt ? "taunt" : "stand");
      }
    }
  }

  // ── Pounce (hounds) ─────────────────────────────────────────────────────────

  _tryPounce(m, dist, nx, nz) {
    const pc = m.def.pounce;
    if (m.pounceCd > 0 || m.staggerTimer > 0 || dist < pc.min || dist > pc.max) return false;
    m.pounceT = pc.time;
    m.pounceX = nx; m.pounceZ = nz;
    m.pounceHit = false;
    m.rotY = THREE.MathUtils.radToDeg(Math.atan2(nx, nz));
    m.animLockTimer = 0;
    this._setAnimation(m, "jump", pc.time);
    const jump = m.actions.jump;
    jump?.setEffectiveTimeScale(jump.getClip().duration / (pc.time * 1.6));
    this.sfx?.snarl(this._localDist(m.body.position.x, m.body.position.z));
    return true;
  }

  /** The leap: flies straight along the launch direction and bites once on contact. */
  _updatePounce(m, delta) {
    const pc = m.def.pounce;
    m.pounceT -= delta;
    m.body.wakeUp();
    m.body.velocity.x = m.pounceX * pc.speed;
    m.body.velocity.z = m.pounceZ * pc.speed;
    const t = m.target;
    if (!m.pounceHit && t?.alive) {
      const p = m.body.position;
      const dx = t.pos.x - p.x, dz = t.pos.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < m.engageRadius + 0.45) {
        m.pounceHit = true;
        const inv = d > 1e-4 ? 1 / d : 0;
        this.onPlayerHit(t, pc.damage * m.damageMul, dx * inv * pc.knock, dz * inv * pc.knock, 0.6, p.x, p.z);
        m.pounceT = Math.min(m.pounceT, 0.12); // land on them, don't sail through
      }
    }
    if (m.pounceT <= 0) {
      m.pounceT = 0;
      m.pounceCd = pc.cooldown[0] + Math.random() * (pc.cooldown[1] - pc.cooldown[0]);
      m.animLockTimer = 0;
      m.body.velocity.x *= 0.2;
      m.body.velocity.z *= 0.2;
    }
    return true;
  }

  _muzzlePos(m, out) {
    const r = THREE.MathUtils.degToRad(m.rotY);
    const fx = Math.sin(r), fz = Math.cos(r);
    const p = m.body.position;
    const mz = m.def.muzzle;
    if (mz) return out.set(p.x + fx * mz.z, m.root.position.y + mz.y, p.z + fz * mz.z); // mouth (dragon)
    const s = m.height / 2.43;
    // Gun sits forward and to the monster's right, at chest height
    return out.set(p.x + fx * 0.55 * s - fz * 0.22 * s, m.root.position.y + m.height * 0.6, p.z + fz * 0.55 * s + fx * 0.22 * s);
  }

  _updateChaseRanged(m, delta) {
    const def = m.def;
    const gun = m.gun;
    const pp = m.target.pos;
    const playerSpeed = Math.hypot(m.target.vel.x, m.target.vel.z);
    const p = m.body.position;
    const dx = pp.x - p.x, dz = pp.z - p.z;
    const dist = Math.hypot(dx, dz);
    const nx = dist > 1e-4 ? dx / dist : 0, nz = dist > 1e-4 ? dz / dist : 0;

    // Bosses still swing when you get close
    if (def.boss && dist < m.attackRange + 0.5 && m.hasLOS) {
      this._steer(m, m.sepX, m.sepZ, delta);
      this._faceTowards(m, dx, dz, delta, 8);
      this._meleeAttack(m, delta, dist, nx, nz);
      return;
    }

    if (!m.hasLOS || dist > gun.range) {
      m.gunPhase = "cool";
      m.gunTimer = Math.min(m.gunTimer, 0.5);
      const tx = m.hasLOS ? pp.x : m.lastX, tz = m.hasLOS ? pp.z : m.lastZ;
      this._moveTo(m, tx, tz, m.speed, delta, false);
      return;
    }

    // Hold a firing band, strafing so they're not sitting ducks
    const band = def.ranged;
    let radial = 0;
    if (dist > band.max) radial = Math.min(m.speed, (dist - band.max) * 2);
    else if (dist < band.min) radial = -Math.min(m.speed, (band.min - dist) * 2);
    m.strafeTimer -= delta;
    if (m.strafeTimer <= 0) {
      m.strafeTimer = def.flying ? 5 + Math.random() * 4 : 1.5 + Math.random() * 2.5;
      m.circleDir *= Math.random() < 0.6 ? -1 : 1;
    }
    const firing = m.gunPhase !== "cool";
    // Flyers orbit wide and only face you to breathe; walkers sidestep
    const strafe = (def.flying ? m.speed * (firing ? 0.35 : 0.9) : firing ? 0.6 : 1.4) * m.circleDir;
    this._steer(m, nx * radial - nz * strafe + m.sepX, nz * radial + nx * strafe + m.sepZ, delta);
    m.body.wakeUp();
    if (def.flying && !firing) this._faceTowards(m, m.body.velocity.x, m.body.velocity.z, delta, 2.5);
    else this._faceTowards(m, dx, dz, delta, def.flying ? 4 : firing ? 12 : 8);

    // Aim lags behind the target: moving targets are harder to hit
    const lag = 1 - Math.exp(-4 * delta);
    m.aimX += (pp.x - m.aimX) * lag;
    m.aimY += (pp.y + (m.target.aimOff ?? 0.15) - m.aimY) * lag; // chest height for the target's stance
    m.aimZ += (pp.z - m.aimZ) * lag;

    m.gunTimer -= delta;
    if (m.gunPhase === "cool") {
      if (m.gunTimer <= 0) { m.gunPhase = "aim"; m.gunTimer = gun.aimTime; }
    } else if (m.gunPhase === "aim") {
      if (m.gunTimer <= 0) { m.gunPhase = "fire"; m.shotsLeft = gun.burst; m.gunTimer = 0; }
    } else {
      while (m.gunTimer <= 0 && m.shotsLeft > 0) {
        this._muzzlePos(m, _muzzle);
        _aim.set(m.aimX, m.aimY, m.aimZ);
        const spreadMul = 1 + dist / 22 + playerSpeed / 5;
        this.enemyFire.fire(gun, _muzzle, _aim, spreadMul, p.x, p.z, m.damageMul);
        m.shotsLeft--;
        m.gunTimer += gun.interval;
      }
      if (m.shotsLeft <= 0) {
        m.gunPhase = "cool";
        m.gunTimer = gun.cooldown[0] + Math.random() * (gun.cooldown[1] - gun.cooldown[0]);
      }
    }

    if (m.staggerTimer <= 0) {
      if (firing) this._setAnimation(m, "attack");
      else this._runAnim(m);
    }
  }

  // ── Crowd ───────────────────────────────────────────────────────────────────

  _assignRoles() {
    const chasers = this._chasers;
    for (const z of chasers) {
      z.priority = z.distXZ - (z.isAttacker ? 1.5 : 0) + (z.nav ? 1000 : 0) + (z.gun ? 2000 : 0);
    }
    chasers.sort(byPriority);
    for (let i = 0; i < chasers.length; i++) chasers[i].isAttacker = i < MAX_ATTACKERS && !chasers[i].gun;
  }

  _accumulateSeparation() {
    const list = this.pool.active;
    for (const z of list) { z.sepX = 0; z.sepZ = 0; }
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.dying || a.distXZ > FAR_TIER || a.def.flying) continue;
      const ap = a.body.position;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.dying || b.def.flying) continue;
        const sepR = a.capRadius + b.capRadius + SEPARATION_PADDING;
        const bp = b.body.position;
        let ox = ap.x - bp.x, oz = ap.z - bp.z;
        const d2 = ox * ox + oz * oz;
        if (d2 >= sepR * sepR) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-4) { ox = (a.id & 1) ? 1 : -1; oz = (b.id & 1) ? 1 : -1; d = 1; }
        const push = ((sepR - d) / sepR) * SEPARATION_STRENGTH / d;
        // Heavier monsters shove lighter ones aside
        const wa = b.def.mass / (a.def.mass + b.def.mass), wb = 1 - wa;
        a.sepX += ox * push * wa * 2; a.sepZ += oz * push * wa * 2;
        b.sepX -= ox * push * wb * 2; b.sepZ -= oz * push * wb * 2;
      }
    }
  }

  // ── Per frame ───────────────────────────────────────────────────────────────

  _updateDying(m, delta) {
    m.dieTimer += delta;
    if (m.burnTimer > 0) m.burnTimer -= delta;
    if (m.flashTimer > 0) {
      m.flashTimer -= delta;
      if (m.flashTimer <= 0) m.mesh.material = m.burnTimer > 0 ? m.mats.burn : m.mats.base;
    }
    const body = m.body;
    body.velocity.set(0, 0, 0);
    // Corpses stay on the floor they died on; falling flyers drop to the terrain
    const g = m.def.flying || m.surfY === null ? groundHeight(body.position.x, body.position.z) : m.surfY;
    body.position.y = g + m.visualOffY;
    let lift = 0;
    if (m.deathStyle) {
      lift = this._proceduralDeath(m, delta);
      if (m.flyY > 0) m.dieTimer = 0; // the corpse timer starts when it lands
    }
    const sink = THREE.MathUtils.clamp((m.dieTimer - CORPSE_HOLD_TIME) / CORPSE_SINK_TIME, 0, 1);
    m.root.position.set(body.position.x, g + m.flyY + lift - sink * CORPSE_SINK_DEPTH * (m.height / 2.43), body.position.z);
    m.root.rotation.y = THREE.MathUtils.degToRad(m.rotY);
    return m.dieTimer >= CORPSE_HOLD_TIME + CORPSE_SINK_TIME;
  }

  /**
   * Death for models without a death clip: the flinch freezes, flyers drop
   * and crash, then the body keels over onto its side. Returns the height to
   * lift the root so the rolled body rests on the ground instead of in it.
   */
  _proceduralDeath(m, delta) {
    m.deathT += delta;
    if (m.deathT > 0.3) m.mixer.timeScale = 0;
    if (m.flyY > 0) {
      m.fallV -= FALL_GRAVITY * delta;
      m.flyY = Math.max(0, m.flyY + m.fallV * delta);
      m.bank += m.rollSide * delta * 1.5; // tumbling
      m.root.rotation.z = m.bank;
      if (m.flyY === 0) {
        m.rollT = 0;
        this.onCrash?.(m);
      }
      return 0;
    }
    m.rollT = (m.rollT ?? 0) + delta;
    const k = Math.min(1, m.rollT / ROLL_TIME);
    const roll = m.rollSide * (Math.PI / 2) * k * k;
    m.root.rotation.z = m.bank + (roll - m.bank) * k;
    return Math.abs(Math.sin(m.root.rotation.z)) * m.capRadius * 0.45;
  }

  // Monsters walk on the terrain surface (groundHeight); pinning Y means no
  // amount of crowd pressure can lift one onto the player or another monster.
  // Flyers hold their altitude (flyY) above the ground the same way.
  /** Height walked on at (x, z) for something with its feet at y: terrain, or a house floor / stairs. */
  _surface(x, z, y) {
    const g = groundHeight(x, z);
    return this.surfaceAt ? this.surfaceAt(x, z, y, g) : g;
  }

  _pinToGround(m) {
    const body = m.body;
    const g = m.def.flying ? groundHeight(body.position.x, body.position.z)
      : this._surface(body.position.x, body.position.z, m.root.position.y);
    m.surfY = g;
    body.position.y = g + m.visualOffY + m.flyY;
    body.velocity.y = 0;
    m.root.position.set(body.position.x, g + m.flyY, body.position.z);
    m.root.rotation.y = THREE.MathUtils.degToRad(m.rotY);
    m.root.rotation.z = m.bank;
    this.pool.orient(m);
  }

  /** Altitude (cruise high, drop low to breathe fire) and banking into turns. */
  _updateFlight(m, delta) {
    const fl = m.def.flying;
    const attacking = m.state === "chase" && m.gunPhase !== "cool";
    const want = (attacking ? fl.dive : fl.altitude) + Math.sin(this._time * 0.9 + m.id) * 0.7;
    m.flyY += (want - m.flyY) * (1 - Math.exp(-FLY_LERP * delta));
    let turn = m.rotY - (m.prevRotY ?? m.rotY);
    turn = ((turn + 540) % 360) - 180;
    m.prevRotY = m.rotY;
    const bank = THREE.MathUtils.clamp(-turn / Math.max(delta, 1e-3) * 0.012, -0.55, 0.55);
    m.bank += (bank - m.bank) * (1 - Math.exp(-3 * delta));
  }

  _updateMarker(m, delta) {
    if (m.markerTimer > 0) m.markerTimer -= delta;
    let char = null;
    if (m.markerTimer > 0) char = "!";
    else if (m.state === "investigate" || m.state === "search" || (m.state === "wander" && m.awareness > 0.3)) char = "?";
    const show = char && m.distXZ < MARKER_RANGE;
    m.marker.visible = !!show;
    if (!show) return;
    m.marker.material = this.pool.markerMats[char];
    const bob = char === "!" ? Math.sin(m.markerTimer * 18) * 0.06 : 0;
    m.marker.position.set(m.body.position.x, m.root.position.y + m.height + 0.45 + bob, m.body.position.z);
    const s = (char === "!" ? 0.7 : 0.5) * Math.max(1, m.distXZ / 18);
    m.marker.scale.set(s, s, s);
  }

  update(delta) {
    const targets = this._targets = this.getTargets();
    if (!targets.length) return;
    this._time += delta;
    this.enemyFire?.beginFrame();

    // 0. Corpses (iterate backwards: finished ones go back to the pool)
    const active = this.pool.active;
    let alive = 0;
    for (let i = active.length - 1; i >= 0; i--) {
      const m = active[i];
      if (!m.dying) { alive++; continue; }
      m.mixer.update(delta);
      m.wMixer?.update(delta);
      if (this._updateDying(m, delta)) this.pool.release(m);
    }
    this.aliveCount = alive;

    // 1. Senses + bookkeeping
    const chasers = this._chasers;
    chasers.length = 0;
    for (const m of active) {
      if (m.dying) continue;
      const p = m.body.position;
      // Distance to the nearest player drives level-of-detail, markers and leashing
      let nd = Infinity;
      for (const t of targets) nd = Math.min(nd, (t.pos.x - p.x) ** 2 + (t.pos.z - p.z) ** 2);
      m.distXZ = Math.sqrt(nd);
      m.engageRadius = this.playerRadius + m.capRadius + ENGAGE_GAP;
      m.attackRange = m.engageRadius + ATTACK_REACH * (m.def.bigBody ? 1.8 : 1);
      if (!this.settings.enableAI) continue;
      m.senseTimer -= delta;
      if (m.senseTimer <= 0) {
        const tick = m.distXZ > 45 ? SENSE_INTERVAL * 2.5 : SENSE_INTERVAL;
        m.senseTimer = tick;
        if (m.distXZ < FAR_TIER) this._sense(m, tick);
      }
      if (m.state === "chase" || m.state === "alert") chasers.push(m);
    }
    this.chasingCount = chasers.length;

    // 2. Crowd coordination
    this._roleTimer -= delta;
    if (this._roleTimer <= 0) {
      this._roleTimer = ROLE_REFRESH_TIME;
      this._assignRoles();
    }
    this._accumulateSeparation();

    // 3. Per-monster behaviour
    for (const m of active) {
      if (m.dying) continue;
      if (m.animLockTimer > 0) m.animLockTimer -= delta;
      if (m.staggerTimer > 0) m.staggerTimer -= delta;
      if (m.pounceCd > 0) m.pounceCd -= delta;
      if (m.pounceT > 0 && m.state !== "chase") m.pounceT = 0;
      if (m.flashTimer > 0) {
        m.flashTimer -= delta;
        if (m.flashTimer <= 0) m.mesh.material = m.burnTimer > 0 ? m.mats.burn : m.mats.base;
      }
      if (m.burnTimer > 0) {
        m.burnTimer -= delta;
        m.health -= BURN_DPS * delta;
        if (m.flashTimer <= 0) m.mesh.material = m.burnTimer > 0 ? m.mats.burn : m.mats.base;
        if (m.health <= 0) { this.kill(m); continue; }
      }

      if (!this.settings.enableAI) {
        this._steer(m, 0, 0, delta);
      } else if (m.distXZ > FAR_TIER && m.state === "wander") {
        if (m.body.sleepState !== 2) m.body.sleep();
        this._pinToGround(m);
        continue;
      } else {
        switch (m.state) {
          case "wander": this._updateWander(m, delta); break;
          case "investigate": this._updateInvestigate(m, delta, INVESTIGATE_SPEED, LOOK_TIME); break;
          case "search": this._updateInvestigate(m, delta, SEARCH_SPEED, LOOK_TIME + 1.5); break;
          case "alert": this._updateAlert(m, delta); break;
          case "chase":
            if (!m.target?.alive) { m.target = this._nearestTarget(m.body.position.x, m.body.position.z); }
            if (!m.target) { m.state = "search"; m.stateTimer = 0; m.goalX = m.lastX; m.goalZ = m.lastZ; break; }
            if (m.gun) this._updateChaseRanged(m, delta);
            else this._updateChaseMelee(m, delta);
            break;
        }
      }
      if (m.def.flying) this._updateFlight(m, delta);
      this._pinToGround(m);
      this._updateMarker(m, delta);

      // Aiming laser: warns you a shot is coming
      if (m.gun && m.state === "chase" && m.gunPhase !== "cool" && m.hasLOS) {
        this._muzzlePos(m, _muzzle);
        _laserEnd.set(m.aimX, m.aimY, m.aimZ).sub(_muzzle).normalize().multiplyScalar(Math.min(60, m.distXZ + 6)).add(_muzzle);
        const strength = m.gunPhase === "fire" ? 1 : 1 - Math.max(0, m.gunTimer) / m.gun.aimTime;
        this.enemyFire.laser(_muzzle, _laserEnd, strength);
      }
    }

    // Animation LOD: every frame up close, every 2nd frame past ANIM_NEAR,
    // every 3rd past ANIM_MID (with the skipped time, so the clips keep pace)
    this._animFrame = (this._animFrame + 1) % 6;
    for (const m of active) {
      if (m.dying || m.distXZ >= FAR_TIER) continue;
      m.animDt = (m.animDt ?? 0) + delta;
      const every = m.distXZ < ANIM_NEAR || m.def.flying ? 1 : m.distXZ < ANIM_MID ? 2 : 3;
      if ((this._animFrame + m.netId) % every !== 0) continue;
      m.mixer.update(m.animDt);
      m.wMixer?.update(m.animDt);
      m.animDt = 0;
    }
    this.enemyFire?.endFrame();

    // The caller gates regen on time since the last hit
    this.regenPlayerHealth(5 * delta);
  }
}
