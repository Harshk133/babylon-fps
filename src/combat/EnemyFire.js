import * as THREE from "three";
import { groundHeight } from "../world/Terrain.js";
import * as CANNON from "cannon-es";
import { GROUP_WORLD, GROUP_PLAYER } from "../physicsGroups.js";

// Monster gunfire: instant hitscan rays (machinegun / shotgun) with tracers,
// slow glowing bolts you can dodge (blaster / Warlord plasma), and the red
// aiming lasers that warn you a gunner is about to fire. Everything pooled.

const BOLT_POOL   = 48;
const BOLT_LIFE   = 3.5;
const LASER_POOL  = 16;
const PLAYER_R    = 0.35;
const PLAYER_H    = 1.8;

const _from = new CANNON.Vec3();
const _to = new CANNON.Vec3();
const _res = new CANNON.RaycastResult();
const shotOpts = { collisionFilterMask: GROUP_WORLD | GROUP_PLAYER, skipBackfaces: true };
const wallOpts = { collisionFilterMask: GROUP_WORLD, skipBackfaces: true };
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _hit = new THREE.Vector3();

function makeGlowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.85)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class EnemyFire {
  /**
   * getTargets(): players [{ pos (body centre, feet at y − 0.9), alive, local }].
   * Player bodies carry body.playerTarget so hitscan rays know who they hit.
   * onHitPlayer(target, damage, fromX, fromZ): apply damage + hit direction.
   */
  constructor({ scene, world, effects, sfx, getTargets, onHitPlayer }) {
    this.world = world;
    this.effects = effects;
    this.sfx = sfx;
    this.getTargets = getTargets;
    this.onHitPlayer = onHitPlayer;

    const glow = makeGlowTexture();
    this.bolts = [];
    for (let i = 0; i < BOLT_POOL; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
      }));
      sprite.visible = false;
      scene.add(sprite);
      this.bolts.push({ sprite, active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, gun: null, srcX: 0, srcZ: 0 });
    }

    const laserGeo = new THREE.BoxGeometry(0.012, 0.012, 1).translate(0, 0, 0.5);
    this.lasers = [];
    for (let i = 0; i < LASER_POOL; i++) {
      const mesh = new THREE.Mesh(laserGeo, new THREE.MeshBasicMaterial({
        color: 0xff2a1a, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.lasers.push(mesh);
    }
    this._laserUsed = 0;
    this._time = 0;
    this._visual = false;
    this.onFire = null;
    this.onBoltImpact = null; // (gun, pos, visualOnly) — dragon fireballs set the ground alight
  }

  /** Distance from the local player (for sound volume). */
  _playerFeetDist(x, z) {
    const t = this.getTargets().find(q => q.local);
    return t ? Math.hypot(t.pos.x - x, t.pos.z - z) : 30;
  }

  // ── Lasers ──────────────────────────────────────────────────────────────────

  beginFrame() { this._laserUsed = 0; }

  /** Draws an aiming laser this frame. strength 0..1 (brighter just before firing). */
  laser(from, to, strength) {
    if (this._laserUsed >= LASER_POOL) return;
    const m = this.lasers[this._laserUsed++];
    m.position.copy(from);
    m.lookAt(to);
    m.scale.set(1, 1, from.distanceTo(to));
    m.material.opacity = 0.18 + 0.5 * strength * (0.75 + 0.25 * Math.sin(this._time * 40));
    m.visible = true;
  }

  endFrame() {
    for (let i = this._laserUsed; i < LASER_POOL; i++) this.lasers[i].visible = false;
  }

  // ── Shots ───────────────────────────────────────────────────────────────────

  /**
   * Fires one trigger pull of `gun` from `from` toward `target` (THREE.Vector3s).
   * spreadMul widens the cone (distance, target movement).
   */
  /**
   * visualOnly: co-op clients replay the host's shots for looks; the host has
   * already applied the damage. onFire(gun, from, target, spreadMul, srcX, srcZ)
   * lets the host broadcast real shots.
   */
  fire(gun, from, target, spreadMul, srcX, srcZ, damageMul = 1, visualOnly = false) {
    this._dmgMul = damageMul;
    this._visual = visualOnly;
    if (!visualOnly) this.onFire?.(gun, from, target, spreadMul, srcX, srcZ);
    const dist = this._playerFeetDist(srcX, srcZ);
    this.sfx.gunshot(gun.sound, Math.max(0.12, 0.85 / (1 + dist * 0.06)));
    this.effects.enemyFlash(from, gun.tracer ?? gun.color);
    if (gun.kind === "bolt") {
      _a.subVectors(target, from).normalize();
      this._jitter(_a, (gun.spread ?? 0.015) * spreadMul);
      this._spawnBolt(gun, from, _a, srcX, srcZ);
      return;
    }
    for (let i = 0; i < gun.pellets; i++) {
      _a.subVectors(target, from).normalize();
      this._jitter(_a, gun.spread * spreadMul);
      this._hitscan(gun, from, _a, srcX, srcZ);
    }
  }

  _jitter(dir, s) {
    dir.x += (Math.random() - 0.5) * 2 * s;
    dir.y += (Math.random() - 0.5) * 2 * s * 0.6;
    dir.z += (Math.random() - 0.5) * 2 * s;
    dir.normalize();
  }

  _hitscan(gun, from, dir, srcX, srcZ) {
    _from.set(from.x, from.y, from.z);
    _to.set(from.x + dir.x * gun.range, from.y + dir.y * gun.range, from.z + dir.z * gun.range);
    _res.reset();
    if (this.world.raycastClosest(_from, _to, shotOpts, _res)) {
      _hit.set(_res.hitPointWorld.x, _res.hitPointWorld.y, _res.hitPointWorld.z);
      const target = _res.body.playerTarget;
      if (target) {
        if (target.alive && !this._visual) this.onHitPlayer(target, gun.damage * this._dmgMul, srcX, srcZ);
      } else {
        const n = _res.hitNormalWorld;
        this.effects.impact(_hit, n.x, n.y, n.z, "dust", 4);
      }
    } else {
      _hit.set(_to.x, _to.y, _to.z);
    }
    this.effects.tracer(from, _hit, gun.tracer);
  }

  _spawnBolt(gun, from, dir, srcX, srcZ) {
    const b = this.bolts.find(x => !x.active) ?? this.bolts.reduce((p, q) => (p.life < q.life ? p : q));
    b.active = true;
    b.gun = gun;
    b.life = BOLT_LIFE;
    b.pos.copy(from);
    b.vel.copy(dir).multiplyScalar(gun.speed);
    b.srcX = srcX;
    b.srcZ = srcZ;
    b.dmgMul = this._dmgMul;
    b.direct = false;
    b.visual = this._visual;
    b.sprite.material.color.setHex(gun.color);
    b.sprite.scale.setScalar(gun.radius * (gun.trail ? 4 : 5));
    b.trailTimer = 0;
    b.sprite.position.copy(from);
    b.sprite.visible = true;
  }

  _endBolt(b, explode) {
    b.active = false;
    b.sprite.visible = false;
    if (!explode) return;
    this.effects.impact(b.pos, 0, 1, 0, "dust", 8);
    const g = b.gun;
    this.onBoltImpact?.(g, b.pos, b.visual);
    if (g.splash > 0 && !b.direct && !b.visual) {
      for (const t of this.getTargets()) {
        if (!t.alive) continue;
        const p = t.pos;
        const d = Math.hypot(p.x - b.pos.x, p.z - b.pos.z);
        const dy = Math.abs((p.y - 0.9 + PLAYER_H / 2) - b.pos.y);
        if (d < g.splash && dy < 2) this.onHitPlayer(t, g.damage * b.dmgMul * 0.5 * (1 - d / g.splash), b.srcX, b.srcZ);
      }
    }
  }

  clear() {
    for (const b of this.bolts) if (b.active) this._endBolt(b, false);
    for (const l of this.lasers) l.visible = false;
  }

  update(delta) {
    this._time += delta;
    const targets = this.getTargets();
    for (const b of this.bolts) {
      if (!b.active) continue;
      b.life -= delta;
      if (b.life <= 0) { this._endBolt(b, false); continue; }
      _a.copy(b.pos);
      b.pos.addScaledVector(b.vel, delta);
      _b.copy(b.pos);
      // Fireballs shed flames as they fly
      if (b.gun.trail) {
        b.trailTimer -= delta;
        while (b.trailTimer <= 0) {
          b.trailTimer += 0.012;
          const s = b.gun.radius;
          this.effects.flame(
            b.pos.x + (Math.random() - 0.5) * s, b.pos.y + (Math.random() - 0.5) * s, b.pos.z + (Math.random() - 0.5) * s,
            -b.vel.x * 0.08 + (Math.random() - 0.5), 0.8 + Math.random(), -b.vel.z * 0.08 + (Math.random() - 0.5),
            0.25 + Math.random() * 0.2);
        }
      }

      // Players: closest approach of this step's segment to each player's axis
      let hitPlayer = false;
      const sx = _b.x - _a.x, sz = _b.z - _a.z;
      const len2 = sx * sx + sz * sz || 1e-6;
      for (const tg of targets) {
        if (!tg.alive) continue;
        const pp = tg.pos, feet = pp.y - 0.9;
        const t = THREE.MathUtils.clamp(((pp.x - _a.x) * sx + (pp.z - _a.z) * sz) / len2, 0, 1);
        const cx = _a.x + sx * t, cz = _a.z + sz * t, cy = _a.y + (_b.y - _a.y) * t;
        if (Math.hypot(pp.x - cx, pp.z - cz) < PLAYER_R + b.gun.radius && cy > feet && cy < feet + PLAYER_H) {
          b.pos.set(cx, cy, cz);
          if (!b.visual) this.onHitPlayer(tg, b.gun.damage * b.dmgMul, b.srcX, b.srcZ);
          hitPlayer = true;
          break;
        }
      }
      if (hitPlayer) {
        b.direct = true; // no extra splash on top of a direct hit
        this._endBolt(b, true);
        continue;
      }
      // Walls / ground
      _from.set(_a.x, _a.y, _a.z);
      _to.set(_b.x, _b.y, _b.z);
      _res.reset();
      if (_b.y < groundHeight(_b.x, _b.z) + 0.05 || this.world.raycastClosest(_from, _to, wallOpts, _res)) {
        if (_res.hasHit) b.pos.set(_res.hitPointWorld.x, _res.hitPointWorld.y, _res.hitPointWorld.z);
        this._endBolt(b, true);
        continue;
      }
      b.sprite.position.copy(b.pos);
    }
  }
}
