import * as THREE from "three";
import { MONSTER_TYPES, WEAPON_MODELS } from "../zombies/MonsterTypes.js";
import { GROUP_NONE, GROUP_ZOMBIE } from "../physicsGroups.js";

// Host → clients monster replication. The host runs the real AI and sends a
// compact snapshot ~12×/s; clients mirror it with kinematic "puppet"
// monsters (pooled like the real ones) that they can see, shoot and collide
// with. Clients never simulate AI: their hits are sent to the host.

export const TYPE_LIST = Object.keys(MONSTER_TYPES);
export const WEAPON_LIST = Object.keys(WEAPON_MODELS);
export const ANIMS = [
  "stand", "run", "attack", "pain1", "pain2", "pain3", "jump", "flip", "salute", "taunt",
  "wave", "point", "crstand", "crwalk", "crattack", "crpain", "crdeath", "death1", "death2", "death3",
];
const ANIM_INDEX = Object.fromEntries(ANIMS.map((a, i) => [a, i]));
const FIELDS = 12;

const F_DYING = 1, F_BURN = 2, F_QUESTION = 4, F_ALERT = 8, F_CHASE = 16, F_AIMING = 32;
const SMOOTH = 10;

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();

export class MonsterSync {
  constructor(manager, enemyFire) {
    this.mgr = manager;
    this.enemyFire = enemyFire;
    this.puppets = new Map(); // netId → monster
    this._buf = [];
  }

  // ── Host ────────────────────────────────────────────────────────────────────

  /** Flat number array: FIELDS values per monster. */
  snapshot() {
    const out = this._buf;
    out.length = 0;
    for (const m of this.mgr.active) {
      let flags = 0;
      if (m.dying) flags |= F_DYING;
      if (m.burnTimer > 0) flags |= F_BURN;
      if (m.markerTimer > 0) flags |= F_ALERT;
      else if (m.state === "investigate" || m.state === "search" || (m.state === "wander" && m.awareness > 0.3)) flags |= F_QUESTION;
      if (m.state === "chase" || m.state === "alert") flags |= F_CHASE;
      if (m.gun && m.state === "chase" && m.gunPhase !== "cool" && m.hasLOS) flags |= F_AIMING;
      const b = m.body.position;
      const rate = m.actions.run ? m.actions.run.getEffectiveTimeScale() : 0.6;
      out.push(
        m.netId,
        TYPE_LIST.indexOf(m.type),
        m.skinIndex ?? 0,
        m.weaponId ? WEAPON_LIST.indexOf(m.weaponId) : -1,
        Math.round(b.x * 100),
        Math.round(b.z * 100),
        Math.round(m.root.position.y * 100),
        Math.round(m.rotY) % 360,
        ANIM_INDEX[m.currentAnim] ?? 0,
        Math.round(rate * 100),
        flags,
        Math.max(0, Math.round((m.health / m.maxHealth) * 100)),
      );
    }
    return out;
  }

  // ── Client ──────────────────────────────────────────────────────────────────

  apply(d) {
    const mgr = this.mgr;
    const seen = new Set();
    let chasing = 0, alive = 0;
    mgr.boss = null;
    for (let i = 0; i + FIELDS <= d.length; i += FIELDS) {
      const nid = d[i];
      const type = TYPE_LIST[d[i + 1]];
      const x = d[i + 4] / 100, z = d[i + 5] / 100;
      let m = this.puppets.get(nid);
      if (!m) {
        const weapon = d[i + 3] >= 0 ? WEAPON_LIST[d[i + 3]] : null;
        m = mgr.pool.acquire(type, x, z, 100, weapon, d[i + 2]);
        if (!m) continue;
        m.netId = nid;
        m.burnTimer = 0;
        m.markerTimer = 0;
        this.puppets.set(nid, m);
      }
      seen.add(nid);
      m.tx = x; m.tz = z;
      m.ty = d[i + 6] / 100;
      m.trot = d[i + 7];
      const anim = ANIMS[d[i + 8]] ?? "stand";
      if (m.currentAnim !== anim) {
        m.animLockTimer = 0;
        mgr._setAnimation(m, anim);
      }
      if (anim === "run") mgr._setRunRate(m, d[i + 9] / 100);
      const flags = d[i + 10];
      if (flags & F_DYING) {
        if (!m.dying) {
          m.dying = true;
          m.body.collisionFilterGroup = GROUP_NONE;
        }
      } else {
        alive++;
        if (m.dying) { m.dying = false; m.body.collisionFilterGroup = GROUP_ZOMBIE; }
      }
      m.burnTimer = flags & F_BURN ? 1 : 0;
      m.state = flags & F_CHASE ? "chase" : flags & F_QUESTION ? "investigate" : "wander";
      m.marker.material = mgr.pool.markerMats[flags & F_ALERT ? "!" : "?"];
      m.showMarker = !!(flags & (F_ALERT | F_QUESTION)) && !(flags & F_DYING);
      m.aiming = !!(flags & F_AIMING);
      m.health = d[i + 11];
      m.maxHealth = 100;
      if (m.state === "chase") chasing++;
      if (m.def.boss && !m.dying) mgr.boss = m;
    }
    for (const [nid, m] of this.puppets) {
      if (!seen.has(nid)) {
        mgr.pool.release(m);
        this.puppets.delete(nid);
      }
    }
    mgr.chasingCount = chasing;
    mgr.aliveCount = alive;
  }

  findPuppet(nid) {
    return this.puppets.get(nid) ?? null;
  }

  /** Smooth puppets toward the latest snapshot and animate them. */
  updatePuppets(delta, viewer) {
    const mgr = this.mgr;
    const k = 1 - Math.exp(-SMOOTH * delta);
    this.enemyFire.beginFrame();
    for (const m of this.puppets.values()) {
      const b = m.body.position;
      b.x += (m.tx - b.x) * k;
      b.z += (m.tz - b.z) * k;
      b.y = m.visualOffY;
      m.body.aabbNeedsUpdate = true;
      let dr = (m.trot - m.rotY) % 360;
      if (dr > 180) dr -= 360; else if (dr < -180) dr += 360;
      m.rotY += dr * k;
      m.root.position.set(b.x, m.ty, b.z);
      m.root.rotation.y = THREE.MathUtils.degToRad(m.rotY);
      m.distXZ = Math.hypot(b.x - viewer.x, b.z - viewer.z);
      if (m.flashTimer > 0) {
        m.flashTimer -= delta;
        if (m.flashTimer <= 0) m.mesh.material = m.burnTimer > 0 ? m.mats.burn : m.mats.base;
      } else {
        m.mesh.material = m.burnTimer > 0 ? m.mats.burn : m.mats.base;
      }
      if (m.distXZ < 90) {
        m.mixer.update(delta);
        m.wMixer?.update(delta);
      }
      m.marker.visible = m.showMarker && m.distXZ < 55;
      if (m.marker.visible) {
        m.marker.position.set(b.x, m.height + 0.45, b.z);
        const s = 0.6 * Math.max(1, m.distXZ / 18);
        m.marker.scale.set(s, s, s);
      }
      // Gunner aiming laser, drawn along its facing
      if (m.aiming && !m.dying) {
        mgr._muzzlePos(m, _from);
        const r = THREE.MathUtils.degToRad(m.rotY);
        _to.set(_from.x + Math.sin(r) * 30, _from.y - 0.4, _from.z + Math.cos(r) * 30);
        this.enemyFire.laser(_from, _to, 0.8);
      }
    }
    this.enemyFire.endFrame();
  }

  /** Client → host promotion: drop the puppets and run the real thing. */
  becomeHost() {
    for (const m of this.puppets.values()) this.mgr.pool.release(m);
    this.puppets.clear();
    this.mgr.pool.setPuppetMode(false);
  }
}
