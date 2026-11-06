import * as THREE from "three";

// Power poles a vehicle knocks down (world/Roads.js builds them). A pole hit
// hard enough topples away from the hit over FALL_TIME s, its wires come down
// with it, and where they land they stay live for LIVE_TIME s: blue-white arcs
// crawl over the ground, sparks spit, it buzzes and cracks, a cold light
// flickers, and anyone standing in it gets shocked (onShock, main.js applies
// the damage). The pole's instance in the split meshes is hidden and a single
// mesh of the same geometry plays the fall. A falling pole is shared on the
// net (main.js: pole { i, dx, dz }), so everyone sees the same one go down.

const FALL_TIME = 1.25;
export const LIVE_TIME = 45;
export const LIVE_RADIUS = 3.2;
const ARCS = 7;             // jagged bolts per live patch
const ARC_PTS = 7;
const MAX_FALLEN = 6;       // fallen poles animated / live at once (older ones just lie there)

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3(), _axis = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3(0, 0, 0), ONE = new THREE.Vector3(1, 1, 1);

export class PowerLines {
  /**
   * poles: what Roads.buildPoles returned. groundAt(x, z). effects: Effects (sparks).
   * lightPool: LightPool (a flickering light per live patch). sfx: Sfx.
   */
  constructor({ scene, world, poles, groundAt, effects, lightPool, sfx }) {
    this.scene = scene;
    this.world = world;
    this.poles = poles;
    this.groundAt = groundAt;
    this.effects = effects;
    this.sfx = sfx;
    this.fallen = [];
    this.onShock = null;   // (x, z, radius, dt) → main.js hurts whoever stands there
    this.time = 0;
    // Pooled falling poles and live patches
    this.pool = [];
    const arcMat = new THREE.LineBasicMaterial({ color: 0xbfefff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < MAX_FALLEN; i++) {
      const mesh = new THREE.Mesh(poles.poleGeo, poles.material);
      mesh.castShadow = true;
      mesh.visible = false;
      scene.add(mesh);
      const drum = new THREE.Mesh(poles.drumGeo, poles.material);
      drum.visible = false;
      mesh.add(drum);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(ARCS * (ARC_PTS - 1) * 2 * 3), 3));
      const arcs = new THREE.LineSegments(geo, arcMat);
      arcs.frustumCulled = false;
      arcs.visible = false;
      scene.add(arcs);
      const light = lightPool.adopt(new THREE.PointLight(0x9fdcff, 0, 14, 1.8), 1.6);
      this.pool.push({ mesh, drum, arcs, light, pole: null });
    }
    this._sound = { x: 0, y: 0, z: 0 };
  }

  /** The pole a vehicle just hit (from its mapObstacles entry), knocked over along (dx, dz). False if it was already down. */
  knock(pole, dx, dz) {
    if (!pole || pole.down) return false;
    const l = Math.hypot(dx, dz) || 1;
    pole.down = { dx: dx / l, dz: dz / l, t: 0 };
    this._hide(pole, true);
    this.world.removeBody(pole.body);
    pole.obstacle.r = 0.01;
    // A pooled mesh plays the fall (the oldest live one is recycled)
    let slot = this.pool.find(s => !s.pole);
    if (!slot) {
      slot = this.fallen.shift();
      if (slot.pole) this._settle(slot.pole, slot);
    }
    slot.pole = pole;
    slot.mesh.visible = true;
    slot.drum.visible = !!pole.transformer;
    slot.arcs.visible = false;
    this.fallen.push(slot);
    this._place(slot, 0);
    this._sound.x = pole.x; this._sound.y = pole.y + 3; this._sound.z = pole.z;
    this.sfx.poleCrash(this._sound);
    return true;
  }

  /** Every pole standing again (a new battle royale match). */
  restoreAll() {
    for (const p of this.poles) {
      if (!p.down) continue;
      p.down = null;
      this._hide(p, false);
      this.world.addBody(p.body);
      p.obstacle.r = 0.25;
      this._wires(p);
    }
    for (const s of this.pool) {
      s.pole = null;
      s.mesh.visible = false;
      s.arcs.visible = false;
      s.light.intensity = 0;
      this.sfx.loop(`live${this.pool.indexOf(s)}`, "synth:buzz", this._sound, 0);
    }
    this.fallen.length = 0;
  }

  /** Indices and directions of the fallen poles (late joiners). */
  state() {
    const out = [];
    for (const p of this.poles) if (p.down) out.push([p.index, +p.down.dx.toFixed(2), +p.down.dz.toFixed(2)]);
    return out;
  }

  /** Down already, without the show (a late joiner catching up). */
  setDown(index, dx, dz) {
    const p = this.poles[index];
    if (!p || p.down) return;
    this.knock(p, dx, dz);
    p.down.t = FALL_TIME + LIVE_TIME;   // long dead
  }

  _hide(p, hidden) {
    for (const [src, idx] of [[this.poles.mesh, p.index], [this.poles.drums, p.drumIndex]]) {
      if (idx === undefined) continue;
      const to = src.userData.splitTo?.[idx];
      const [mesh, i] = to ?? [src, idx];
      _q.setFromAxisAngle(_up, p.yaw);
      _m.compose(_p.set(p.x, p.y - 0.1, p.z), _q, hidden ? ZERO : ONE);
      mesh.setMatrixAt(i, _m);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** The pole's pose k (0 standing .. 1 flat on the ground). */
  _place(slot, k) {
    const p = slot.pole, d = p.down;
    const angle = (Math.PI / 2 - 0.08) * k;
    _axis.set(d.dz, 0, -d.dx);           // tip toward (dx, dz)
    _q.setFromAxisAngle(_up, p.yaw);
    _q2.setFromAxisAngle(_axis, angle);
    _q.premultiply(_q2);
    slot.mesh.position.set(p.x, p.y - 0.1, p.z);
    slot.mesh.quaternion.copy(_q);
    slot.mesh.updateMatrix();
  }

  /** Where the fallen pole's top (and the wires) ended up. */
  _top(p, out) {
    const h = this.poles.armY;
    out.x = p.x + p.down.dx * h;
    out.z = p.z + p.down.dz * h;
    out.y = this.groundAt(out.x, out.z) + 0.15;
    return out;
  }

  /** Rebuilds the two spans touching pole p: sagging between standing poles, slumped to the ground where one is down. */
  _wires(p) {
    const W = this.poles.wires;
    if (!W) return;
    const arr = W.geometry.attributes.position.array;
    const SUB = this.poles.wireSub, sag = this.poles.wireSag, armY = this.poles.armY;
    const end = (q, off, out) => {
      if (q.down && q.down.t >= FALL_TIME * 0.6) {
        this._top(q, out);
        out.x += Math.cos(q.yaw) * off; out.z -= Math.sin(q.yaw) * off;
        out.down = true;
      } else {
        out.x = q.x + Math.cos(q.yaw) * off; out.z = q.z - Math.sin(q.yaw) * off; out.y = q.y + armY + 0.18;
        out.down = false;
      }
      return out;
    };
    const A = {}, B = {};
    for (const span of [p.spanIn, p.spanOut?.spanIn]) {
      if (!span) continue;
      const a = span.from, b = span === p.spanIn ? p : p.spanOut;
      let v = span.start * 3;
      for (const off of [-0.68, 0, 0.68]) {
        end(a, off, A); end(b, off, B);
        // Slumped: the wire lies along the ground for most of the way from the fallen end
        const down = A.down || B.down;
        for (let k = 0; k < SUB; k++) {
          for (const t of [k / SUB, (k + 1) / SUB]) {
            const x = A.x + (B.x - A.x) * t, z = A.z + (B.z - A.z) * t;
            let y = A.y + (B.y - A.y) * t - 4 * sag * t * (1 - t);
            if (down) y = Math.max(this.groundAt(x, z) + 0.05, y - 4 * sag * 2.5 * t * (1 - t));
            arr[v++] = x; arr[v++] = y; arr[v++] = z;
          }
        }
      }
    }
    W.geometry.attributes.position.needsUpdate = true;
  }

  update(dt) {
    this.time += dt;
    for (let n = 0; n < this.fallen.length; n++) {
      const slot = this.fallen[n], p = slot.pole;
      if (!p) continue;
      const d = p.down;
      const was = d.t;
      d.t += dt;
      if (was < FALL_TIME) {
        // Accelerating like a real fall (it creeps, then slams)
        const k = Math.min(1, d.t / FALL_TIME);
        this._place(slot, k * k);
        if (was < FALL_TIME * 0.6 && d.t >= FALL_TIME * 0.6) this._wires(p);
        if (d.t >= FALL_TIME) {
          this._wires(p);
          const top = this._top(p, _p);
          for (let i = 0; i < 6; i++) this.effects.impact(top, Math.random() - 0.5, 1, Math.random() - 0.5, "dust", 10);
        }
        continue;
      }
      const live = d.t < FALL_TIME + LIVE_TIME;
      const key = `live${this.pool.indexOf(slot)}`;
      const top = this._top(p, this._sound);
      if (!live) {
        if (slot.arcs.visible) { slot.arcs.visible = false; slot.light.intensity = 0; this.sfx.loop(key, "synth:buzz", top, 0); }
        continue;
      }
      // Live wires: a buzz, crackling arcs, sparks and a flickering cold light; it fades out at the end
      const fade = Math.min(1, (FALL_TIME + LIVE_TIME - d.t) / 6);
      this.sfx.loop(key, "synth:buzz", top, 0.6 * fade, { ref: 3, wet: 0.1 });
      slot.arcs.visible = Math.random() < 0.85;
      if (slot.arcs.visible) this._arcs(slot, top);
      slot.light.position.set(top.x, top.y + 0.4, top.z);
      slot.light.intensity = (Math.random() < 0.3 ? 0 : 2 + Math.random() * 5) * fade;
      if (Math.random() < dt * 5) {
        this.effects.impact(_p.set(top.x + (Math.random() - 0.5) * 2, top.y, top.z + (Math.random() - 0.5) * 2), Math.random() - 0.5, 1.2, Math.random() - 0.5, "dust", 4);
        if (Math.random() < 0.5) this.sfx.zap(top, 0.6 * fade);
      }
      this.onShock?.(top.x, top.z, LIVE_RADIUS, dt);
    }
  }

  /** New jagged bolts over the live patch (a few times a second they jump about). */
  _arcs(slot, c) {
    const arr = slot.arcs.geometry.attributes.position.array;
    let v = 0;
    for (let a = 0; a < ARCS; a++) {
      const ang = Math.random() * Math.PI * 2, len = 0.6 + Math.random() * LIVE_RADIUS * 0.8;
      let x = c.x + (Math.random() - 0.5) * 0.6, z = c.z + (Math.random() - 0.5) * 0.6, y = c.y;
      const sx = Math.cos(ang) * len / (ARC_PTS - 1), sz = Math.sin(ang) * len / (ARC_PTS - 1);
      for (let i = 1; i < ARC_PTS; i++) {
        const nx = x + sx + (Math.random() - 0.5) * 0.35, nz = z + sz + (Math.random() - 0.5) * 0.35;
        const ny = this.groundAt(nx, nz) + 0.06 + Math.random() * 0.25;
        arr[v++] = x; arr[v++] = y; arr[v++] = z;
        arr[v++] = nx; arr[v++] = ny; arr[v++] = nz;
        x = nx; y = ny; z = nz;
      }
    }
    slot.arcs.geometry.attributes.position.needsUpdate = true;
  }

  _settle(p, slot) {
    // A recycled slot: the old pole stays down, drawn by nothing (its instance is hidden): show it lying there
    // by putting it back as a static fallen instance is overkill: leave it hidden, the wires stay slumped
    slot.light.intensity = 0;
    slot.arcs.visible = false;
  }
}
