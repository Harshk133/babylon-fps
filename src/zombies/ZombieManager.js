import * as THREE from "three";
import { ZombiePool } from "./ZombiePool.js";

export class ZombieManager {
  constructor({
    scene,
    world,
    monsterMaterial,
    targetHeight,
    mass,
    linDamping,
    angDamping,
    getPlayerBody,
    dealDamageToPlayer,
    regenPlayerHealth,
  }) {
    this.getPlayerBody = getPlayerBody;
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
      chaseSpeed: 2.0,
      attackSpeed: 2.0,
      enableAI: true,
      maxHealth: 100,
    };

    this.kills = 0;
    this.spawnCount = 0;
  }

  async init(prewarmCount = 100) {
    await this.pool.loadAssets();
    this.pool.prewarm(prewarmCount);
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
    if (zombie) this.spawnCount++;
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

  damage(zombie, amount) {
    if (!zombie?.active) return false;
    zombie.health = Math.max(0, zombie.health - amount);
    if (zombie.health <= 0) {
      this.kill(zombie);
      return true;
    }
    return false;
  }

  kill(zombie) {
    if (!zombie?.active) return;
    this.pool.release(zombie);
    this.kills++;
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

  _updateZombie(zombie, delta, playerPos) {
    if (zombie.animLockTimer > 0) zombie.animLockTimer -= delta;

    const settings = this.settings;
    const mPos = zombie.body.position;
    const pPos = playerPos;

    const dx = pPos.x - mPos.x;
    const dz = pPos.z - mPos.z;
    const distXZ = Math.hypot(dx, dz);

    if (!zombie.isChasing && distXZ <= settings.detectionRadius) {
      zombie.isChasing = true;
    } else if (zombie.isChasing && distXZ > settings.deaggroRadius) {
      zombie.isChasing = false;
    }

    if (zombie.isChasing && settings.enableAI) {
      const targetAngle = Math.atan2(dx, dz);
      const currentAngle = zombie.root.rotation.y;
      let diff = targetAngle - currentAngle;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      zombie.root.rotation.y = currentAngle + diff * Math.min(1.0, delta * 10.0);
      zombie.rotY = THREE.MathUtils.radToDeg(zombie.root.rotation.y);

      const ATTACK_TRIGGER_RANGE = 1.1;
      const MIN_MELEE_GAP = 0.2;
      const inAttackRange =
        distXZ <= ATTACK_TRIGGER_RANGE ||
        (zombie.currentAnim === "attack" && distXZ <= ATTACK_TRIGGER_RANGE + 0.4);

      if (inAttackRange) {
        this._setAnimation(zombie, "attack", 0.8);

        const nx = distXZ > 0.001 ? dx / distXZ : 0;
        const nz = distXZ > 0.001 ? dz / distXZ : 0;

        if (distXZ > MIN_MELEE_GAP) {
          const stepSpeed = Math.min(settings.attackSpeed, 1.0);
          zombie.body.position.x += nx * stepSpeed * delta;
          zombie.body.position.z += nz * stepSpeed * delta;
          zombie.body.velocity.x = nx * stepSpeed;
          zombie.body.velocity.z = nz * stepSpeed;
        } else {
          zombie.body.velocity.x = 0;
          zombie.body.velocity.z = 0;
        }
        zombie.body.wakeUp();
        this.dealDamageToPlayer(10 * delta);
      } else {
        this._setAnimation(zombie, "run");
        const nx = dx / distXZ;
        const nz = dz / distXZ;
        const currentSpeed = settings.chaseSpeed;

        zombie.body.position.x += nx * currentSpeed * delta;
        zombie.body.position.z += nz * currentSpeed * delta;
        zombie.body.velocity.x = nx * currentSpeed;
        zombie.body.velocity.z = nz * currentSpeed;
        zombie.body.wakeUp();
      }
    } else {
      this._setAnimation(zombie, "stand");
      zombie.body.velocity.x *= 0.85;
      zombie.body.velocity.z *= 0.85;
    }

    zombie.root.position.set(
      zombie.body.position.x,
      zombie.body.position.y - zombie.visualOffY,
      zombie.body.position.z
    );
    zombie.root.rotation.y = THREE.MathUtils.degToRad(zombie.rotY);
  }

  update(delta) {
    const playerBody = this.getPlayerBody();
    if (!playerBody) return;

    let anyChasing = false;

    for (const zombie of this.pool.active) {
      this._updateZombie(zombie, delta, playerBody.position);
      if (zombie.isChasing) anyChasing = true;
    }

    for (const zombie of this.pool.active) {
      if (zombie.mixer) zombie.mixer.update(delta);
    }

    if (!anyChasing) this.regenPlayerHealth(5 * delta);
  }
}
