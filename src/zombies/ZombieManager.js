import * as THREE from "three";
import { ZombiePool } from "./ZombiePool.js";
import { GROUP_NONE } from "../physicsGroups.js";

// ─── Crowd / melee tuning ─────────────────────────────────────────────────────
const MAX_ATTACKERS       = 5;    // zombies allowed in the inner melee ring at once
const ENGAGE_GAP          = 0.2;  // gap kept between zombie and player capsules
const ATTACK_REACH        = 0.55; // extra reach beyond the engage ring for a hit to land
const WAIT_RING_OFFSET    = 2.2;  // how far outside the melee ring the waiting crowd circles
const SEPARATION_PADDING  = 0.15; // extra spacing between zombie capsules
const SEPARATION_STRENGTH = 4.0;
const STEER_ACCEL         = 9.0;  // exp-blend rate toward desired velocity
const ROLE_REFRESH_TIME   = 0.2;  // seconds between melee-slot reassignments
const HIT_DAMAGE          = 5;
const HIT_KNOCKBACK       = 5.5;

// ─── Reactions / death ────────────────────────────────────────────────────────
const HIT_FLASH_TIME    = 0.07;
const STAGGER_TIME      = 0.22;
const CORPSE_HOLD_TIME  = 2.5;  // lie on the ground before sinking
const CORPSE_SINK_TIME  = 1.5;
const CORPSE_SINK_DEPTH = 1.2;

// ─── Distance tiers (see CLAUDE.md performance rules) ─────────────────────────
const NEAR_TIER  = 15;
const MID_TIER   = 40;
const FAR_TIER   = 80;
const MID_TICK   = 0.1;
const FAR_TICK   = 0.5;

const DEATH_CLIPS = ["death1", "death2", "death3"];
const PAIN_CLIPS  = ["pain1", "pain2", "pain3"];

const byPriority = (a, b) => a.priority - b.priority;

export class ZombieManager {
  constructor({
    scene,
    world,
    monsterMaterial,
    targetHeight,
    mass,
    linDamping,
    angDamping,
    playerRadius,
    getPlayerBody,
    canAttackPlayer,
    dealDamageToPlayer,
    regenPlayerHealth,
  }) {
    this.playerRadius = playerRadius;
    this.getPlayerBody = getPlayerBody;
    this.canAttackPlayer = canAttackPlayer ?? (() => true);
    this.dealDamageToPlayer = dealDamageToPlayer;
    this.regenPlayerHealth = regenPlayerHealth;

    this.pool = new ZombiePool({
      scene,
      world,
      monsterMaterial,
      targetHeight,
      mass,
      linDamping,
      angDamping,
    });

    this.settings = {
      detectionRadius: 15.0,
      deaggroRadius: 24.0,
      chaseSpeed: 2.8,
      attackSpeed: 2.0,
      enableAI: true,
      maxHealth: 100,
      // Horde spawner
      maxAlive: 40,
      spawnInterval: 2.5,
      minSpawnInterval: 0.8,
      spawnDistMin: 32,
      spawnDistMax: 48,
    };

    this.kills = 0;
    this.spawnCount = 0;
    this.chasingCount = 0;
    this.aliveCount = 0;
    this.onKill = null;
    this._spawnTimer = 0;
    this._elapsed = 0;

    this._chasers = [];
    this._roleTimer = 0;
    this._attackInterval = 1.4;
  }

  async init(prewarmCount = 100) {
    await this.pool.loadAssets();
    this.pool.prewarm(prewarmCount);

    const attackClip = this.pool.all[0]?.actions.attack?.getClip();
    if (attackClip) this._attackInterval = attackClip.duration / 0.55;

    // Inner ring sits just outside the touching distance of the two capsules,
    // so attackers never push into the player and get resolved on top of them.
    this.engageRadius = this.playerRadius + this.pool.capRadius + ENGAGE_GAP;
    this.attackRange = this.engageRadius + ATTACK_REACH;
    this.waitRadius = this.engageRadius + WAIT_RING_OFFSET;
    this.separationRadius = this.pool.capRadius * 2 + SEPARATION_PADDING;
  }

  get active() {
    return this.pool.active;
  }

  get activeCount() {
    return this.pool.active.length;
  }

  get poolStats() {
    return {
      active: this.pool.active.length,
      inactive: this.pool.inactive.length,
      total: this.pool.all.length,
      kills: this.kills,
    };
  }

  spawn(x, z, overrides = {}) {
    const health = overrides.health ?? this.settings.maxHealth;
    const maxHealth = overrides.maxHealth ?? this.settings.maxHealth;
    const zombie = this.pool.acquire(x, z, { health, maxHealth });
    if (zombie) {
      this.spawnCount++;
      zombie.attackTimer = Math.random() * this._attackInterval;
      zombie.circleDir = Math.random() < 0.5 ? -1 : 1;
      zombie.taunts = Math.random() < 0.4;
      zombie.speedMul = 0.8 + Math.random() * 0.5;
      zombie.rotY = Math.random() * 360;
    }
    return zombie;
  }

  spawnRing(count, centerX, centerZ, minRadius, maxRadius) {
    const spawned = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const radius = minRadius + ((i % 3) / 2) * (maxRadius - minRadius);
      const x = centerX + Math.cos(angle) * radius;
      const z = centerZ + Math.sin(angle) * radius;
      const zombie = this.spawn(x, z);
      if (zombie) spawned.push(zombie);
    }
    return spawned;
  }

  /** Returns true if this hit killed the zombie. */
  damage(zombie, amount, pushX = 0, pushZ = 0) {
    if (!zombie?.active || zombie.dying) return false;
    zombie.health = Math.max(0, zombie.health - amount);
    zombie.isChasing = true;
    zombie.flashTimer = HIT_FLASH_TIME;
    zombie.mesh.material = this.pool.hitMaterial;

    if (zombie.health <= 0) {
      this.kill(zombie);
      return true;
    }

    // Flinch: brief slowdown and a shove along the bullet direction
    zombie.staggerTimer = STAGGER_TIME;
    zombie.body.velocity.x += pushX;
    zombie.body.velocity.z += pushZ;
    if (zombie.currentAnim !== "attack" || zombie.animLockTimer <= 0) {
      zombie.animLockTimer = 0;
      this._setAnimation(zombie, PAIN_CLIPS[(Math.random() * PAIN_CLIPS.length) | 0], 0.3);
    }
    return false;
  }

  kill(zombie) {
    if (!zombie?.active || zombie.dying) return;
    zombie.dying = true;
    zombie.dieTimer = 0;
    zombie.isChasing = false;
    zombie.isAttacker = false;
    zombie.body.collisionFilterGroup = GROUP_NONE;
    zombie.body.velocity.set(0, 0, 0);
    zombie.animLockTimer = 0;
    this._setAnimation(zombie, DEATH_CLIPS[(Math.random() * DEATH_CLIPS.length) | 0], 99);
    this.kills++;
    this.onKill?.(zombie);
  }

  /** Gunfire is loud: wake every zombie within radius. */
  alert(x, z, radius) {
    const r2 = radius * radius;
    for (const zombie of this.pool.active) {
      if (zombie.dying || zombie.isChasing) continue;
      const p = zombie.body.position;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz <= r2) zombie.isChasing = true;
    }
  }

  _updateSpawner(delta, playerPos) {
    const s = this.settings;
    this._elapsed += delta;
    this._spawnTimer -= delta;
    if (this._spawnTimer > 0 || this.aliveCount >= s.maxAlive) return;

    // Pressure ramps up over ~5 minutes
    const ramp = Math.min(1, this._elapsed / 300);
    this._spawnTimer = THREE.MathUtils.lerp(s.spawnInterval, s.minSpawnInterval, ramp);

    const angle = Math.random() * Math.PI * 2;
    const dist = s.spawnDistMin + Math.random() * (s.spawnDistMax - s.spawnDistMin);
    const zombie = this.spawn(playerPos.x + Math.cos(angle) * dist, playerPos.z + Math.sin(angle) * dist);
    if (zombie) zombie.isChasing = true;
  }

  /** Returns true once the corpse has fully sunk and can go back to the pool. */
  _updateDying(zombie, delta) {
    zombie.dieTimer += delta;
    if (zombie.flashTimer > 0) {
      zombie.flashTimer -= delta;
      if (zombie.flashTimer <= 0) zombie.mesh.material = this.pool.material;
    }
    const body = zombie.body;
    body.velocity.set(0, 0, 0);
    body.position.y = zombie.visualOffY;
    const sink = THREE.MathUtils.clamp((zombie.dieTimer - CORPSE_HOLD_TIME) / CORPSE_SINK_TIME, 0, 1);
    zombie.root.position.set(body.position.x, -sink * CORPSE_SINK_DEPTH, body.position.z);
    zombie.root.rotation.y = THREE.MathUtils.degToRad(zombie.rotY);
    return zombie.dieTimer >= CORPSE_HOLD_TIME + CORPSE_SINK_TIME;
  }

  killRandom() {
    const active = this.pool.active;
    if (active.length === 0) return null;
    const zombie = active[(Math.random() * active.length) | 0];
    this.kill(zombie);
    return zombie;
  }

  _setAnimation(zombie, animName, minDuration = 0) {
    if (zombie.currentAnim === animName) return;
    if (zombie.animLockTimer > 0) return;

    const oldAction = zombie.actions[zombie.currentAnim];
    const newAction = zombie.actions[animName];
    if (newAction) {
      if (oldAction && oldAction !== newAction) oldAction.fadeOut(0.2);
      newAction.reset().fadeIn(0.2).play();
      zombie.currentAnim = animName;
      if (minDuration > 0) zombie.animLockTimer = minDuration;
    }
  }

  _faceTowards(zombie, dx, dz, delta, rate) {
    const targetAngle = Math.atan2(dx, dz);
    const currentAngle = THREE.MathUtils.degToRad(zombie.rotY);
    let diff = targetAngle - currentAngle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    zombie.rotY = THREE.MathUtils.radToDeg(currentAngle + diff * Math.min(1.0, delta * rate));
  }

  // Closest chasers get a melee slot; the rest circle on an outer ring.
  // Current attackers get a bias so roles don't flicker between frames.
  _assignRoles() {
    const chasers = this._chasers;
    for (const z of chasers) z.priority = z.distXZ - (z.isAttacker ? 1.5 : 0);
    chasers.sort(byPriority);
    for (let i = 0; i < chasers.length; i++) chasers[i].isAttacker = i < MAX_ATTACKERS;
  }

  _accumulateSeparation() {
    const chasers = this._chasers;
    const sepR = this.separationRadius;
    const sepR2 = sepR * sepR;

    for (const z of chasers) {
      z.sepX = 0;
      z.sepZ = 0;
    }
    for (let i = 0; i < chasers.length; i++) {
      const a = chasers[i];
      const ap = a.body.position;
      for (let j = i + 1; j < chasers.length; j++) {
        const b = chasers[j];
        const bp = b.body.position;
        let ox = ap.x - bp.x;
        let oz = ap.z - bp.z;
        const d2 = ox * ox + oz * oz;
        if (d2 >= sepR2) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-4) {
          // Perfectly overlapping — split along an arbitrary per-pair axis
          ox = (a.id & 1) ? 1 : -1;
          oz = (b.id & 1) ? 1 : -1;
          d = 1;
        }
        const push = ((sepR - d) / sepR) * SEPARATION_STRENGTH / d;
        a.sepX += ox * push;
        a.sepZ += oz * push;
        b.sepX -= ox * push;
        b.sepZ -= oz * push;
      }
    }
  }

  _steer(zombie, desiredX, desiredZ, delta) {
    const v = zombie.body.velocity;
    const blend = 1 - Math.exp(-STEER_ACCEL * delta);
    v.x += (desiredX - v.x) * blend;
    v.z += (desiredZ - v.z) * blend;
  }

  _updateChaser(zombie, delta, playerPos) {
    const settings = this.settings;
    const p = zombie.body.position;
    const dx = playerPos.x - p.x;
    const dz = playerPos.z - p.z;
    const dist = zombie.distXZ;
    const nx = dist > 1e-4 ? dx / dist : 0;
    const nz = dist > 1e-4 ? dz / dist : 0;

    const ringRadius = zombie.isAttacker ? this.engageRadius : this.waitRadius;
    const radialError = dist - ringRadius;

    // Arrive at the ring: full speed when far, ease in close, back off if inside it.
    const chaseSpeed = settings.chaseSpeed * zombie.speedMul * (zombie.staggerTimer > 0 ? 0.25 : 1);
    let radialSpeed;
    if (radialError > 0) radialSpeed = Math.min(chaseSpeed, radialError * 3.0);
    else radialSpeed = Math.max(-settings.attackSpeed, radialError * 6.0);

    let desiredX = nx * radialSpeed + zombie.sepX;
    let desiredZ = nz * radialSpeed + zombie.sepZ;

    // Waiting zombies stalk around the player instead of queueing in a line
    const nearRing = Math.abs(radialError) < 1.0;
    if (!zombie.isAttacker && nearRing && !zombie.taunts) {
      const circle = 0.7 * zombie.circleDir;
      desiredX += -nz * circle;
      desiredZ += nx * circle;
    }

    this._steer(zombie, desiredX, desiredZ, delta);
    zombie.body.wakeUp();
    this._faceTowards(zombie, dx, dz, delta, 10.0);

    const speed = Math.hypot(zombie.body.velocity.x, zombie.body.velocity.z);
    const inAttackRange =
      zombie.isAttacker && dist <= this.attackRange && zombie.staggerTimer <= 0 && this.canAttackPlayer();

    if (inAttackRange) {
      this._setAnimation(zombie, "attack", 0.8);
      const prev = zombie.attackTimer;
      zombie.attackTimer += delta;
      // Damage lands mid-swing; player can still dodge out of reach before then
      const hitTime = this._attackInterval * 0.5;
      if (prev < hitTime && zombie.attackTimer >= hitTime && dist <= this.attackRange) {
        this.dealDamageToPlayer(HIT_DAMAGE, nx * HIT_KNOCKBACK, nz * HIT_KNOCKBACK);
      }
      if (zombie.attackTimer >= this._attackInterval) zombie.attackTimer -= this._attackInterval;
    } else if (zombie.staggerTimer <= 0) {
      zombie.attackTimer = Math.min(zombie.attackTimer, this._attackInterval * 0.3);
      if (speed > 0.35) {
        this._setAnimation(zombie, "run");
        zombie.actions.run?.setEffectiveTimeScale(
          THREE.MathUtils.clamp(speed / settings.chaseSpeed, 0.35, 1.3) * 0.6
        );
      } else {
        this._setAnimation(zombie, zombie.taunts && zombie.actions.taunt ? "taunt" : "stand");
      }
    }
  }

  _updateIdle(zombie, delta) {
    this._setAnimation(zombie, "stand");
    this._steer(zombie, 0, 0, delta);
  }

  // Zombies walk on flat ground only; pinning Y means no amount of crowd
  // pressure can lift one onto the player or another zombie.
  _pinToGround(zombie) {
    const body = zombie.body;
    body.position.y = zombie.visualOffY;
    body.velocity.y = 0;
    zombie.root.position.set(body.position.x, 0, body.position.z);
    zombie.root.rotation.y = THREE.MathUtils.degToRad(zombie.rotY);
  }

  update(delta) {
    const playerBody = this.getPlayerBody();
    if (!playerBody) return;
    const playerPos = playerBody.position;
    const settings = this.settings;
    const chasers = this._chasers;
    chasers.length = 0;

    // 0. Corpses (iterate backwards: finished ones are released from the pool)
    const active = this.pool.active;
    let alive = 0;
    for (let i = active.length - 1; i >= 0; i--) {
      const zombie = active[i];
      if (!zombie.dying) { alive++; continue; }
      if (zombie.mixer) zombie.mixer.update(delta);
      if (this._updateDying(zombie, delta)) this.pool.release(zombie);
    }
    this.aliveCount = alive;
    this._updateSpawner(delta, playerPos);

    // 1. Perception + distance tiers
    for (const zombie of this.pool.active) {
      if (zombie.dying) continue;
      const p = zombie.body.position;
      const dist = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
      zombie.distXZ = dist;

      if (!zombie.isChasing && dist <= settings.detectionRadius) zombie.isChasing = true;
      else if (zombie.isChasing && dist > settings.deaggroRadius) {
        zombie.isChasing = false;
        zombie.isAttacker = false;
      }

      if (zombie.isChasing && settings.enableAI) chasers.push(zombie);
    }
    this.chasingCount = chasers.length;

    // 2. Crowd coordination
    this._roleTimer -= delta;
    if (this._roleTimer <= 0) {
      this._roleTimer = ROLE_REFRESH_TIME;
      this._assignRoles();
    }
    this._accumulateSeparation();

    // 3. Per-zombie behaviour
    for (const zombie of this.pool.active) {
      if (zombie.dying) continue;
      if (zombie.animLockTimer > 0) zombie.animLockTimer -= delta;
      if (zombie.staggerTimer > 0) zombie.staggerTimer -= delta;
      if (zombie.flashTimer > 0) {
        zombie.flashTimer -= delta;
        if (zombie.flashTimer <= 0) zombie.mesh.material = this.pool.material;
      }

      if (zombie.isChasing && settings.enableAI) {
        this._updateChaser(zombie, delta, playerPos);
      } else {
        const dist = zombie.distXZ;
        if (dist > FAR_TIER) {
          if (zombie.body.sleepState !== 2) zombie.body.sleep();
          continue;
        }
        const tick = dist > MID_TIER ? FAR_TICK : dist > NEAR_TIER ? MID_TICK : 0;
        zombie.aiTimer = (zombie.aiTimer ?? 0) - delta;
        if (zombie.aiTimer > 0) {
          this._pinToGround(zombie);
          continue;
        }
        zombie.aiTimer = tick;
        this._updateIdle(zombie, Math.max(delta, tick));
      }
      this._pinToGround(zombie);
    }

    for (const zombie of this.pool.active) {
      if (!zombie.dying && zombie.mixer && zombie.distXZ < FAR_TIER) zombie.mixer.update(delta);
    }

    // The caller gates regen on time since the last hit
    this.regenPlayerHealth(5 * delta);
  }
}
