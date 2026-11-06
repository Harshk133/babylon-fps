import * as THREE from "three";
import { createParachute } from "./BrVisuals.js";

// Battle royale supply drops: a crate on a parachute that falls from the sky
// onto a spot inside the zone. The host picks the time and place (main.js,
// brsd { i, x, z, t0 }); every client animates it from the shared match clock,
// so they all see the same fall. On landing it pops red smoke and the host
// spills its loot. Pooled: MAX_DROPS crates, nothing added or removed later.

export const DROP_HEIGHT = 140;   // m above the ground it appears
export const DROP_SPEED = 7;      // m/s under the canopy
export const DROP_FALL = DROP_HEIGHT / DROP_SPEED;
const MAX_DROPS = 4;
const LINGER = 60;                // s the empty crate stays after landing

const _crateMat = new THREE.MeshStandardMaterial({ color: 0x2f5d8c, roughness: 0.55, metalness: 0.35 });
const _bandMat = new THREE.MeshStandardMaterial({ color: 0xffc23d, roughness: 0.5, metalness: 0.2, emissive: 0x4a3200 });
const _beaconMat = new THREE.MeshBasicMaterial({ color: 0xff4b3a });

function buildCrate() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 1.4), _crateMat);
  body.position.y = 0.5;
  body.castShadow = true;
  g.add(body);
  // Gold straps round it and a lid rim
  for (const [w, d] of [[1.44, 0.16], [0.16, 1.44]]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(w, 1.02, d), _bandMat);
    band.position.y = 0.5;
    g.add(band);
  }
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 1.5), _crateMat);
  lid.position.y = 1.06;
  g.add(lid);
  // A blinking beacon on top
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), _beaconMat);
  beacon.position.y = 1.2;
  g.add(beacon);
  g.userData.beacon = beacon;
  g.userData.lid = lid;
  const chute = createParachute();
  chute.position.y = 1.2 + 4.4;
  chute.visible = true;
  g.add(chute);
  g.userData.chute = chute;
  g.visible = false;
  g.matrixWorldAutoUpdate = false;
  return g;
}

export class SupplyDrops {
  /** groundAt(x, z): the surface height to land on. onLand(drop): smoke, loot. */
  constructor(scene, groundAt, onLand) {
    this.groundAt = groundAt;
    this.onLand = onLand;
    this.drops = [];
    for (let i = 0; i < MAX_DROPS; i++) {
      const root = buildCrate();
      scene.add(root);
      this.drops.push({ root, active: false, id: -1, x: 0, z: 0, t0: 0, y0: 0, landed: false });
    }
  }

  /** A drop the host called: id, where, and the match time it appeared. */
  add(id, x, z, t0) {
    if (this.drops.some(d => d.active && d.id === id)) return null;
    const d = this.drops.find(q => !q.active) ?? this.drops.reduce((a, b) => (a.t0 < b.t0 ? a : b));
    d.active = true; d.id = id; d.x = x; d.z = z; d.t0 = t0;
    d.y0 = this.groundAt(x, z);
    d.landed = false;
    d.root.visible = true;
    d.root.matrixWorldAutoUpdate = true;
    d.root.userData.chute.visible = true;
    d.root.userData.lid.position.set(0, 1.06, 0);
    d.root.userData.lid.rotation.set(0, 0, 0);
    return d;
  }

  clear() {
    for (const d of this.drops) {
      d.active = false;
      d.root.visible = false;
      d.root.matrixWorldAutoUpdate = false;
    }
  }

  /** Active drops as [[id, x, z, t0], …] (the host's "br" packet, for late joiners). */
  state() {
    const out = [];
    for (const d of this.drops) if (d.active) out.push([d.id, +d.x.toFixed(1), +d.z.toFixed(1), +d.t0.toFixed(1)]);
    return out;
  }

  /** Seconds until drop id lands (0 once it has), or null. */
  eta(d, t) { return Math.max(0, d.t0 + DROP_FALL - t); }

  /** t: the match clock. */
  update(t) {
    for (const d of this.drops) {
      if (!d.active) continue;
      const age = t - d.t0;
      if (age > DROP_FALL + LINGER) { d.active = false; d.root.visible = false; d.root.matrixWorldAutoUpdate = false; continue; }
      const u = d.root.userData;
      if (age < DROP_FALL) {
        const y = d.y0 + DROP_HEIGHT * (1 - Math.max(0, age) / DROP_FALL);
        // Swings a little under the canopy
        d.root.position.set(d.x + Math.sin(age * 0.9) * 0.6, y, d.z + Math.cos(age * 0.7) * 0.6);
        d.root.rotation.set(Math.sin(age * 1.3) * 0.06, age * 0.15, Math.cos(age * 1.1) * 0.06);
      } else {
        if (!d.landed) {
          d.landed = true;
          d.root.position.set(d.x, d.y0, d.z);
          d.root.rotation.set(0, d.root.rotation.y, 0);
          u.chute.visible = false;
          // The lid's knocked off to one side
          u.lid.position.set(0.9, 0.35, 0.2);
          u.lid.rotation.set(0.2, 0.4, 1.2);
          this.onLand?.(d);
        }
      }
      u.beacon.visible = Math.floor(t * 2.5) % 2 === 0;
    }
  }
}
