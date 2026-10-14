import * as THREE from "three";
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

const DEATH_CLIPS = ["death1", "death2", "death3"];
const PAIN_CLIPS  = ["pain1", "pain2", "pain3"];

const byPriority = (a, b) => a.priority - b.priority;
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
 */
export class ZombieManager {
  constructor({
    scene, world, monsterMaterial, linDamping, angDamping,
    playerRadius, getPlayerBody, canAttackPlayer, dealDamageToPlayer, regenPlayerHealth,
    enemyFire, sfx, getVisibility,
  }) {
    this.world = world;
    this.playerRadius = playerRadius;
    this.getPlayerBody = getPlayerBody;
    this.canAttackPlayer = canAttackPlayer ?? (() => true);
    this.dealDamageToPlayer = dealDamageToPlayer;
    this.regenPlayerHealth = regenPlayerHealth;
    this.enemyFire = enemyFire;
    this.sfx = sfx;
    this.getVisibility = getVisibility ?? (() => 1);

    this.pool = new MonsterPools({ scene, world, monsterMaterial, linDamping, angDamping });
    this.settings = { enableAI: true };

    this.kills = 0;
    this.chasingCount = 0;
    this.aliveCount = 0;
    this.boss = null;          // the living Warlord, for the HUD
    // Hooks (set by main.js / the level director)
    this.onKill = null;        // (monster)
    this.onSpotted = null;     // (monster) first time a monster spots the player
    this.onDoorBang = null;    // (x, z)
    this.navigate = null;      // (zx, zz, tx, tz, out, big) → 0 | 1 | 2
    this.canSpawnAt = null;    // (x, z) → bool

    this._chasers = [];
    this._roleTimer = 0;
    this._visibility = 1;
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

    m.damageMul = opts.damageMul ?? 1;
    m.speed = def.speed * (opts.speedMul ?? 1) * (0.88 + Math.random() * 0.24);
    m.attackTimer = Math.random() * m.attackInterval;
    m.circleDir = Math.random() < 0.5 ? -1 : 1;
    m.taunts = Math.random() < 0.35;
    m.isAttacker = false;
    m.nav = 0;
    m.navTimer = Math.random() * NAV_INTERVAL;
    m.navPoint ??= { x: 0, z: 0, fx: 0, fz: 0 };
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
    if (opts.hunting) this._investigate(m, m.homeX, m.homeZ);
    if (def.boss) this.boss = m;
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

  /** Returns true if this hit killed the monster. */
  damage(m, amount, pushX = 0, pushZ = 0) {
    if (!m?.active || m.dying) return false;
    m.health = Math.max(0, m.health - amount);
    m.flashTimer = HIT_FLASH_TIME;
    m.mesh.material = m.mats.hit;

    // Getting shot gives you away
    if (m.state !== "chase" && m.state !== "alert") {
      const p = this.getPlayerBody().position;
      this._spot(m, p.x, p.z);
    }

    if (m.health <= 0) {
      this.kill(m);
      return true;
    }
    const heavy = m.def.bigBody;
    m.staggerTimer = heavy ? STAGGER_TIME * 0.3 : STAGGER_TIME;
    const pushK = heavy ? 0.25 : 1;
    m.body.velocity.x += pushX * pushK;
    m.body.velocity.z += pushZ * pushK;
    if (!heavy || Math.random() < 0.2) {
      if (m.currentAnim !== "attack" || m.animLockTimer <= 0) {
        m.animLockTimer = 0;
        this._setAnimation(m, PAIN_CLIPS[(Math.random() * PAIN_CLIPS.length) | 0], 0.3);
      }
    }
    return false;
  }

  /** Sets a monster on fire for `duration` seconds (refreshes, never shortens). */
  ignite(m, duration) {
    if (!m?.active) return;
    const wasBurning = m.burnTimer > 0;
    m.burnTimer = Math.max(m.burnTimer ?? 0, duration);
    if (!wasBurning && !m.dying) this.damage(m, 1);
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
    this._setAnimation(m, DEATH_CLIPS[(Math.random() * DEATH_CLIPS.length) | 0], 99);
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

  _spot(m, x, z) {
    if (m.state === "chase" || m.state === "alert" || m.dying) return;
    m.state = "alert";
    m.stateTimer = m.def.boss ? 1.2 : SPOT_TIME;
    m.lastX = x; m.lastZ = z;
    m.lostTimer = 0;
    m.awareness = 1;
    m.markerTimer = 1.6;
    m.animLockTimer = 0;
    if (m.actions.point && Math.random() < 0.6) this._setAnimation(m, "point", m.stateTimer);
    const pp = this.getPlayerBody().position;
    this.sfx?.growl(Math.hypot(pp.x - m.body.position.x, pp.z - m.body.position.z), !!m.def.bigBody);
    this.onSpotted?.(m);
  }

  _canSee(m, pp, engaged) {
    const def = m.def;
    const p = m.body.position;
    const dx = pp.x - p.x, dz = pp.z - p.z;
    const dist = Math.hypot(dx, dz);
    const range = def.sight.range * (engaged ? 1.6 : 1) * this._visibility;
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
    _eyeFrom.set(p.x, def.height * 0.85, p.z);
    _eyeTo.set(pp.x, pp.y + 0.4, pp.z);
    _eyeRes.reset();
    if (this.world.raycastClosest(_eyeFrom, _eyeTo, losOpts, _eyeRes)) return 0;
    return peripheral * (1.5 - dist / range);
  }

  _sense(m, pp, tick) {
    const dist = m.distXZ;
    if (m.state === "chase") {
      m.hasLOS = this._canSee(m, pp, true) > 0;
      if (m.hasLOS || dist < TOUCH_RADIUS) {
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
    if (dist < TOUCH_RADIUS) { this._spot(m, pp.x, pp.z); return; }
    const seen = this._canSee(m, pp, false);
    if (seen > 0) {
      m.awareness += seen * 2.2 * tick;
      if (m.awareness >= 1) { this._spot(m, pp.x, pp.z); return; }
      if (m.awareness > 0.4 && m.state === "wander") this._investigate(m, pp.x, pp.z);
      else if (m.state !== "wander") { m.goalX = pp.x; m.goalZ = pp.z; }
    } else {
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

  _runAnim(m) {
    if (m.staggerTimer > 0) return;
    const v = Math.hypot(m.body.velocity.x, m.body.velocity.z);
    if (v > 0.3) {
      this._setAnimation(m, "run");
      this._setRunRate(m, THREE.MathUtils.clamp(v / 2.8, 0.3, 1.6) * 0.6);
    } else {
      this._setAnimation(m, "stand");
    }
  }

  /**
   * Walks toward (tx, tz), detouring around houses and through doorways.
   * Returns the nav code (2 = stuck at a closed door) and leaves the distance
   * to the target in m.goalDist.
   */
  _moveTo(m, tx, tz, speed, delta, bangDoors) {
    const p = m.body.position;
    if (this.navigate) {
      m.navTimer -= delta;
      const moved = Math.abs(m.navTarget.x - tx) + Math.abs(m.navTarget.z - tz) > 1.5;
      if (m.navTimer <= 0 || moved) {
        m.navTimer = NAV_INTERVAL;
        m.navTarget.x = tx; m.navTarget.z = tz;
        m.nav = this.navigate(p.x, p.z, tx, tz, m.navPoint, !!m.def.bigBody);
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
    if (d > 0.05) this._faceTowards(m, dx, dz, delta, 8);
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
      const pp = this.getPlayerBody().position;
      this._investigate(m, pp.x, pp.z); // smells you out eventually
      return;
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

  _updateAlert(m, delta, pp) {
    m.stateTimer -= delta;
    const p = m.body.position;
    this._steer(m, m.sepX * 0.3, m.sepZ * 0.3, delta);
    this._faceTowards(m, m.lastX - p.x, m.lastZ - p.z, delta, 10);
    if (m.stateTimer <= 0) {
      m.state = "chase";
      m.lostTimer = 0;
      m.hasLOS = this._canSee(m, pp, true) > 0;
      m.animLockTimer = 0;
    }
  }

  _meleeAttack(m, delta, dist, nx, nz) {
    const inRange = dist <= m.attackRange && m.staggerTimer <= 0 && this.canAttackPlayer();
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
      this.dealDamageToPlayer(mel.damage * m.damageMul, nx * mel.knock, nz * mel.knock, m.def.bigBody ? 0.7 : 0.45, p.x, p.z);
    }
    if (m.attackTimer >= m.attackInterval) m.attackTimer -= m.attackInterval;
    return true;
  }

  _updateChaseMelee(m, delta, pp) {
    const tracking = m.hasLOS || m.lostTimer < 1.5;
    const tx = tracking ? pp.x : m.lastX;
    const tz = tracking ? pp.z : m.lastZ;
    // Route around buildings / through doors first
    if (this.navigate) {
      m.navTimer -= delta;
      if (m.navTimer <= 0) {
        m.navTimer = NAV_INTERVAL;
        const p = m.body.position;
        m.nav = this.navigate(p.x, p.z, tx, tz, m.navPoint, !!m.def.bigBody);
      }
      if (m.nav) {
        m.isAttacker = false;
        this._moveTo(m, tx, tz, m.speed, delta, true);
        return;
      }
    }

    const p = m.body.position;
    const dx = tx - p.x, dz = tz - p.z;
    const dist = Math.hypot(dx, dz);
    const nx = dist > 1e-4 ? dx / dist : 0;
    const nz = dist > 1e-4 ? dz / dist : 0;
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
      if (v > 0.35) {
        this._setAnimation(m, "run");
        this._setRunRate(m, THREE.MathUtils.clamp(v / 2.8, 0.35, 1.8) * 0.6);
      } else {
        this._setAnimation(m, m.taunts && m.actions.taunt ? "taunt" : "stand");
      }
    }
  }

  _muzzlePos(m, out) {
    const r = THREE.MathUtils.degToRad(m.rotY);
    const fx = Math.sin(r), fz = Math.cos(r);
    const s = m.height / 2.43;
    const p = m.body.position;
    // Gun sits forward and to the monster's right, at chest height
    return out.set(p.x + fx * 0.55 * s - fz * 0.22 * s, m.height * 0.6, p.z + fz * 0.55 * s + fx * 0.22 * s);
  }

  _updateChaseRanged(m, delta, pp, playerSpeed) {
    const def = m.def;
    const gun = m.gun;
    const p = m.body.position;
    const dist = m.distXZ;
    const dx = pp.x - p.x, dz = pp.z - p.z;
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
    if (m.strafeTimer <= 0) { m.strafeTimer = 1.5 + Math.random() * 2.5; m.circleDir *= Math.random() < 0.6 ? -1 : 1; }
    const firing = m.gunPhase !== "cool";
    const strafe = (firing ? 0.6 : 1.4) * m.circleDir;
    this._steer(m, nx * radial - nz * strafe + m.sepX, nz * radial + nx * strafe + m.sepZ, delta);
    m.body.wakeUp();
    this._faceTowards(m, dx, dz, delta, firing ? 12 : 8);

    // Aim lags behind the target: moving targets are harder to hit
    const lag = 1 - Math.exp(-4 * delta);
    m.aimX += (pp.x - m.aimX) * lag;
    m.aimY += (pp.y + 0.15 - m.aimY) * lag;
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
      if (a.dying || a.distXZ > FAR_TIER) continue;
      const ap = a.body.position;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.dying) continue;
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
    body.position.y = m.visualOffY;
    const sink = THREE.MathUtils.clamp((m.dieTimer - CORPSE_HOLD_TIME) / CORPSE_SINK_TIME, 0, 1);
    m.root.position.set(body.position.x, -sink * CORPSE_SINK_DEPTH * (m.height / 2.43), body.position.z);
    m.root.rotation.y = THREE.MathUtils.degToRad(m.rotY);
    return m.dieTimer >= CORPSE_HOLD_TIME + CORPSE_SINK_TIME;
  }

  // Monsters walk on flat ground only; pinning Y means no amount of crowd
  // pressure can lift one onto the player or another monster.
  _pinToGround(m) {
    const body = m.body;
    body.position.y = m.visualOffY;
    body.velocity.y = 0;
    m.root.position.set(body.position.x, 0, body.position.z);
    m.root.rotation.y = THREE.MathUtils.degToRad(m.rotY);
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
    m.marker.position.set(m.body.position.x, m.height + 0.45 + bob, m.body.position.z);
    const s = (char === "!" ? 0.7 : 0.5) * Math.max(1, m.distXZ / 18);
    m.marker.scale.set(s, s, s);
  }

  update(delta) {
    const playerBody = this.getPlayerBody();
    if (!playerBody) return;
    const pp = playerBody.position;
    const playerSpeed = Math.hypot(playerBody.velocity.x, playerBody.velocity.z);
    this._visibility = this.getVisibility();
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
      m.distXZ = Math.hypot(pp.x - p.x, pp.z - p.z);
      m.engageRadius = this.playerRadius + m.capRadius + ENGAGE_GAP;
      m.attackRange = m.engageRadius + ATTACK_REACH * (m.def.bigBody ? 1.8 : 1);
      if (!this.settings.enableAI) continue;
      m.senseTimer -= delta;
      if (m.senseTimer <= 0) {
        const tick = m.distXZ > 45 ? SENSE_INTERVAL * 2.5 : SENSE_INTERVAL;
        m.senseTimer = tick;
        if (m.distXZ < FAR_TIER) this._sense(m, pp, tick);
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
          case "alert": this._updateAlert(m, delta, pp); break;
          case "chase":
            if (m.gun) this._updateChaseRanged(m, delta, pp, playerSpeed);
            else this._updateChaseMelee(m, delta, pp);
            break;
        }
      }
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

    for (const m of active) {
      if (m.dying || m.distXZ >= FAR_TIER) continue;
      m.mixer.update(delta);
      m.wMixer?.update(delta);
    }
    this.enemyFire?.endFrame();

    // The caller gates regen on time since the last hit
    this.regenPlayerHealth(5 * delta);
  }
}
