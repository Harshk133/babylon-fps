import * as THREE from "three";
import { lightPool } from "../render/LightPool.js";
import { groundHeight } from "../world/Terrain.js";
import * as CANNON from "cannon-es";
import { cloneItem } from "../items/ItemModels.js";
import { GROUP_WORLD, GROUP_ZOMBIE, GROUP_PROJECTILE, GROUP_NONE } from "../physicsGroups.js";
import { GRENADE, MOLOTOV, SMOKE } from "./weapons.js";
import { QUALITY } from "../quality.js";

const POOL        = 8;
const RADIUS      = 0.08;
const HIDE_Y      = -500;
const MAX_FIRES   = 5;        // molotovs + dragon fire
const FIRE_LIGHTS = QUALITY.fireLights; // persistent lights shared by the fires (each costs per-pixel)
const ARC_POINTS  = 64;
const ARC_STEP    = 1 / 30;
const ITEM_SCALE  = 1.6;      // thrown items are a bit oversized so they read in flight

const _v = new THREE.Vector3();
const _arcFrom = new CANNON.Vec3();
const _arcTo = new CANNON.Vec3();
const _arcResult = new CANNON.RaycastResult();
const _arcOpts = { collisionFilterMask: GROUP_WORLD, skipBackfaces: true };

/**
 * Grenades, molotovs and smoke grenades: pooled physics projectiles, molotov
 * fire zones, and the hold-to-aim trajectory preview. Damage is applied
 * through callbacks so this module doesn't need to know about zombies or the
 * player. Smoke clouds live in SmokeFX; onSmoke(pos, color) plays the sound.
 */
export class Throwables {
  constructor({ scene, world, material, effects, fireFX, smokeFX, sfx, onExplode, onIgnite, onFireTick, onSmoke }) {
    this.world = world;
    this.effects = effects;
    this.fireFX = fireFX;
    this.smokeFX = smokeFX;
    this.onSmoke = onSmoke;
    this.sfx = sfx;
    this.onExplode = onExplode;
    this.onIgnite = onIgnite;
    this.onFireTick = onFireTick;
    this.gravity = -world.gravity.y;

    this.projectiles = [];
    for (let i = 0; i < POOL; i++) {
      const body = new CANNON.Body({
        mass: 0.4,
        material,
        shape: new CANNON.Sphere(RADIUS),
        linearDamping: 0.01,
        angularDamping: 0.5,
        collisionFilterGroup: GROUP_NONE,
        collisionFilterMask: 0,
      });
      body.position.set(0, HIDE_Y, 0);
      world.addBody(body);
      body.sleep();

      const holder = new THREE.Group();
      const meshes = { grenade: cloneItem("grenade"), molotov: cloneItem("molotov"), smoke: cloneItem("smoke") };
      for (const m of Object.values(meshes)) {
        m.scale.setScalar(ITEM_SCALE);
        m.visible = false;
        holder.add(m);
      }
      holder.visible = false;
      scene.add(holder);

      const p = { body, holder, meshes, kind: null, active: false, age: 0, shatter: false, landed: false, hitZombie: null, clink: 0 };
      body.addEventListener("collide", e => {
        if (!p.active || p.age <= 0.03) return;
        if (p.kind === "grenade") p.landed = true;
        if (p.kind !== "molotov") {
          // Grenades and smoke cans clink as they bounce (not on every tiny roll)
          const v = body.velocity.length();
          if (v > 1.5 && p.age - p.clink > 0.12) {
            p.clink = p.age;
            this.sfx.bounce(body.position, v / 6);
          }
          return;
        }
        p.shatter = true;
        if (e.body?.zombie) p.hitZombie = e.body.zombie;
      });
      this.projectiles.push(p);
    }

    // Molotov fires: GPU flames (FireFX), a scorch decal, and a light when one is free
    const scorchGeo = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);
    this.lights = [];
    for (let i = 0; i < FIRE_LIGHTS; i++) {
      const light = new THREE.PointLight(0xff7a2a, 0, 16, 1.6);
      light.position.set(0, HIDE_Y, 0);
      lightPool.adopt(light, 2);
      this.lights.push(light);
    }
    this.fires = [];
    for (let i = 0; i < MAX_FIRES; i++) {
      const scorch = new THREE.Mesh(scorchGeo, new THREE.MeshBasicMaterial({
        color: 0x0a0604, transparent: true, opacity: 0, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
      scorch.scale.setScalar(MOLOTOV.radius * 1.1);
      scorch.position.set(0, HIDE_Y, 0);
      scene.add(scorch);
      this.fires.push({ active: false, x: 0, z: 0, time: 0, tick: 0, light: null, scorch, born: 0 });
    }

    // Trajectory preview
    const arcPos = new Float32Array(ARC_POINTS * 3);
    const arcGeo = new THREE.BufferGeometry();
    arcGeo.setAttribute("position", new THREE.BufferAttribute(arcPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.arc = new THREE.Line(arcGeo, new THREE.LineBasicMaterial({
      color: 0xffe2a0, transparent: true, opacity: 0.85, depthWrite: false, fog: false,
    }));
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    this.arc.renderOrder = 2;
    scene.add(this.arc);
    this.arcPos = arcPos;

    this.marker = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffe2a0, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, fog: false,
    });
    this.marker.add(new THREE.Mesh(new THREE.RingGeometry(0.22, 0.32, 24).rotateX(-Math.PI / 2), ringMat));
    this.radiusRing = new THREE.Mesh(
      new THREE.RingGeometry(0.96, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xff6a3a, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, fog: false,
      }));
    this.marker.add(this.radiusRing);
    this.marker.visible = false;
    this.marker.renderOrder = 2;
    scene.add(this.marker);
  }

  /**
   * origin / velocity: THREE.Vector3-likes (copied). owner: thrower's player id
   * (kill credit). color: smoke colour index (SMOKE_COLORS), picked by the thrower.
   * fuse: seconds a grenade has left (it was cooked in the hand).
   */
  throw(kind, origin, velocity, owner = null, color = 0, fuse = GRENADE.fuse) {
    const p = this.projectiles.find(q => !q.active)
      ?? this.projectiles.reduce((a, b) => (a.age > b.age ? a : b));
    if (p.active) this._deactivate(p);

    p.kind = kind;
    p.active = true;
    p.age = 0;
    p.shatter = false;
    p.landed = false;
    p.hitZombie = null;
    p.clink = 0;
    p.owner = owner;
    p.color = color;
    p.fuse = fuse;
    for (const k in p.meshes) p.meshes[k].visible = k === kind;
    p.holder.visible = true;

    const b = p.body;
    b.collisionFilterGroup = GROUP_PROJECTILE;
    b.collisionFilterMask = GROUP_WORLD | GROUP_ZOMBIE;
    b.position.set(origin.x, origin.y, origin.z);
    b.velocity.set(velocity.x, velocity.y, velocity.z);
    b.angularVelocity.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 6, -8 - Math.random() * 6);
    b.quaternion.set(0, 0, 0, 1);
    b.wakeUp();
    this.sfx.throwWhoosh();
  }

  _deactivate(p) {
    p.active = false;
    p.holder.visible = false;
    const b = p.body;
    b.collisionFilterGroup = GROUP_NONE;
    b.collisionFilterMask = 0;
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    b.position.set(0, HIDE_Y, 0);
    b.sleep();
  }

  /**
   * Burning ground from something other than a molotov (dragon fireballs).
   * hostile fires burn players but not monsters.
   */
  igniteAt(x, z, hostile = true) {
    this._ignite(x, z, null, null, hostile);
  }

  _ignite(x, z, hitZombie, owner, hostile = false) {
    const f = this.fires.find(q => !q.active) ?? this.fires.reduce((a, b) => (a.time < b.time ? a : b));
    if (f.active) this._endFire(f);
    f.active = true;
    f.x = x;
    f.z = z;
    f.time = MOLOTOV.duration;
    f.tick = 0;
    f.born = performance.now();
    f.owner = owner;
    f.hostile = hostile;
    const g = groundHeight(x, z);
    f.scorch.position.set(x, g + 0.06, z);
    f.scorch.material.opacity = 0.4;
    this.fireFX.ground(x, z, MOLOTOV.radius, MOLOTOV.duration);

    // Take a free light, or the one lighting the oldest fire
    let light = this.lights.find(l => !this.fires.some(q => q.light === l));
    if (!light) {
      const oldest = this.fires.filter(q => q.light && q !== f).sort((a, b) => a.born - b.born)[0];
      light = oldest.light;
      oldest.light = null;
    }
    f.light = light;
    light.position.set(x, g + 1.2, z);

    if (hostile) return;
    this.sfx.glassBreak({ x, y: g + 0.3, z });
    this.onIgnite?.(x, z, hitZombie, owner);
  }

  _endFire(f) {
    f.active = false;
    if (f.light) { f.light.intensity = 0; f.light = null; }
  }

  clear() {
    for (const p of this.projectiles) if (p.active) this._deactivate(p);
    this.smokeFX?.clear();
    for (const f of this.fires) {
      this._endFire(f);
      f.scorch.material.opacity = 0;
    }
    this.hidePreview();
  }

  update(delta) {
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.age += delta;
      const b = p.body;
      if (p.landed) {
        // A grenade stops dead where it lands (no bouncing or rolling off the target); it can only drop straight down
        b.velocity.set(0, Math.min(0, b.velocity.y), 0);
        b.angularVelocity.set(0, 0, 0);
      }
      p.holder.position.set(b.position.x, b.position.y, b.position.z);
      p.holder.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);

      if (p.kind === "molotov") {
        // Burning rag trail
        _v.set(0, 0.18 * ITEM_SCALE, 0).applyQuaternion(p.holder.quaternion).add(p.holder.position);
        this.effects.flame(_v.x, _v.y, _v.z, (Math.random() - 0.5) * 0.4, 0.6, (Math.random() - 0.5) * 0.4, 0.25);
        if (p.shatter || p.age > MOLOTOV.maxFlight || b.position.y < groundHeight(b.position.x, b.position.z) - 1) {
          const x = b.position.x, z = b.position.z, hit = p.hitZombie, owner = p.owner;
          this._deactivate(p);
          this._ignite(x, z, hit, owner);
        }
      } else if (p.kind === "smoke") {
        if (p.age < SMOKE.fuse) continue;
        const x = b.position.x, z = b.position.z, color = p.color;
        _v.set(x, groundHeight(x, z), z);
        this._deactivate(p);
        this.smokeFX?.spawn(_v.x, _v.y, _v.z, color);
        this.onSmoke?.(_v, color);
      } else if (p.age >= p.fuse) {
        _v.set(b.position.x, Math.max(groundHeight(b.position.x, b.position.z) + 0.1, b.position.y), b.position.z);
        const owner = p.owner;
        this._deactivate(p);
        this.effects.explosion(_v);
        this.fireFX.blast(_v.x, _v.y, _v.z);
        this.onExplode?.(_v, owner);
      }
    }

    for (const f of this.fires) {
      if (!f.active) continue;
      f.time -= delta;
      if (f.time <= 0) {
        this._endFire(f);
        continue;
      }
      const strength = Math.min(1, f.time); // fade over the last second
      if (f.light) f.light.intensity = (11 + Math.sin(f.time * 23) * 2.5 + Math.sin(f.time * 37) * 2) * strength;
      f.scorch.material.opacity = 0.4 * Math.min(1, f.time / 2 + 0.3);

      f.tick -= delta;
      while (f.tick <= 0) {
        f.tick += MOLOTOV.tick;
        this.onFireTick?.(f.x, f.z, MOLOTOV.radius, MOLOTOV.tick, f.owner, f.hostile);
      }
    }
  }

  /** Draws the predicted flight path. origin / velocity: THREE.Vector3. */
  showPreview(kind, origin, velocity) {
    const g = this.gravity;
    let px = origin.x, py = origin.y, pz = origin.z;
    let vx = velocity.x, vy = velocity.y, vz = velocity.z;
    const pos = this.arcPos;
    let count = 0;
    let landed = false;
    for (let i = 0; i < ARC_POINTS; i++) {
      pos[count * 3] = px; pos[count * 3 + 1] = py; pos[count * 3 + 2] = pz;
      count++;
      const nx = px + vx * ARC_STEP, ny = py + vy * ARC_STEP, nz = pz + vz * ARC_STEP;
      vy -= g * ARC_STEP;
      _arcFrom.set(px, py, pz);
      _arcTo.set(nx, ny, nz);
      _arcResult.reset();
      if (this.world.raycastClosest(_arcFrom, _arcTo, _arcOpts, _arcResult)) {
        const h = _arcResult.hitPointWorld;
        pos[count * 3] = h.x; pos[count * 3 + 1] = h.y; pos[count * 3 + 2] = h.z;
        count++;
        landed = true;
        break;
      }
      px = nx; py = ny; pz = nz;
    }
    const geo = this.arc.geometry;
    geo.setDrawRange(0, count);
    geo.attributes.position.needsUpdate = true;
    this.arc.visible = true;

    const last = (count - 1) * 3;
    this.marker.visible = landed;
    this.marker.position.set(pos[last], pos[last + 1] + 0.04, pos[last + 2]);
    this.radiusRing.scale.setScalar(kind === "grenade" ? GRENADE.radius : kind === "smoke" ? SMOKE.radius : MOLOTOV.radius);
  }

  hidePreview() {
    this.arc.visible = false;
    this.marker.visible = false;
  }
}
