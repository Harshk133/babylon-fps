import * as THREE from "three";
import { PICKUP_KINDS } from "../combat/weapons.js";
import { groundHeight } from "../world/Terrain.js";
import { cloneItem, getItemTemplate } from "../items/ItemModels.js";

const HIDE_Y          = -500;
const HOVER_HEIGHT    = 0.6;
const MAX_ACTIVE      = 240;  // battle royale scatters a lot of loot
const INTERACT_RADIUS = 2.2;   // weapons: shows the [E] prompt
const AUTO_RADIUS     = 1.4;   // ammo / throwables / medkits: walk over to collect
const BLINK_TIME      = 5;     // timed drops blink for their last few seconds
const FAR_SKIP        = 90;    // don't animate (or draw) pickups this far away

const CATEGORY_COLOR = {
  weapon:    0xffa630,
  ammo:      0xffe066,
  throwable: 0xff5a3a,
  medkit:    0x4dff88,
  fuel:      0x37e0c8,
};

function makeBeamTexture() {
  const c = document.createElement("canvas");
  c.width = 1; c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.7, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0.9)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Pooled world pickups. Entries are created per kind on first need and then
 * reused forever: release only hides them, so nothing is added to or removed
 * from the scene in steady state.
 */
export class Pickups {
  constructor(scene) {
    this.scene = scene;
    this.pools = {};          // kind → entry[]
    this.active = [];
    this.nearestWeapon = null;
    this.touching = [];       // consumables within AUTO_RADIUS this frame
    this.byId = new Map();    // network id → entry (battle royale loot shared by every player)
    this._time = 0;

    this._ringGeo = new THREE.RingGeometry(0.38, 0.58, 32).rotateX(-Math.PI / 2);
    this._beamGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8, 1, true).translate(0, 1.3, 0);
    const beamTex = makeBeamTexture();
    this._ringMats = {};
    this._beamMats = {};
    for (const [cat, color] of Object.entries(CATEGORY_COLOR)) {
      this._ringMats[cat] = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide,
      });
      this._beamMats[cat] = new THREE.MeshBasicMaterial({
        color, map: beamTex, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
    }

    // Model offsets so each item spins around its own centre
    this._centers = {};
    for (const kind of Object.keys(PICKUP_KINDS)) {
      const box = new THREE.Box3().setFromObject(getItemTemplate(kind));
      this._centers[kind] = box.getCenter(new THREE.Vector3());
      this.pools[kind] = [];
    }
  }

  _create(kind) {
    const def = PICKUP_KINDS[kind];
    const root = new THREE.Group();
    const spinner = new THREE.Group();
    const model = cloneItem(kind);
    model.scale.setScalar(def.scale);
    // Floating loot doesn't need to cost a shadow-pass draw per part
    model.traverse(o => { o.castShadow = false; });
    model.position.copy(this._centers[kind]).multiplyScalar(-def.scale);
    spinner.add(model);
    // Guns lie at a slight tilt so they read well from the third-person camera
    if (def.category === "weapon") spinner.rotation.z = 0.15;
    root.add(spinner);

    const ring = new THREE.Mesh(this._ringGeo, this._ringMats[def.category]);
    ring.position.y = 0.03;
    ring.renderOrder = 1;
    root.add(ring);
    const beam = new THREE.Mesh(this._beamGeo, this._beamMats[def.category]);
    beam.renderOrder = 1;
    root.add(beam);

    root.position.y = HIDE_Y;
    root.visible = false;
    this.scene.add(root);

    const entry = { kind, def, root, spinner, active: false, x: 0, z: 0, life: Infinity, data: null, phase: 0, id: null };
    this.pools[kind].push(entry);
    return entry;
  }

  /**
   * kind: key of PICKUP_KINDS. data: { ammo, reserve } for guns, { count } for throwables.
   * life: seconds before it despawns (Infinity for placed world loot).
   * id: optional network id, so a pickup taken by one player vanishes for all.
   */
  spawn(kind, x, z, data = null, life = Infinity, id = null) {
    if (this.active.length >= MAX_ACTIVE || !this.pools[kind]) return null;
    if (id !== null && this.byId.has(id)) return null;
    let entry = this.pools[kind].find(e => !e.active) ?? this._create(kind);
    entry.active = true;
    entry.x = x;
    entry.z = z;
    entry.life = life;
    entry.data = data;
    entry.id = id;
    if (id !== null) this.byId.set(id, entry);
    entry.phase = Math.random() * Math.PI * 2;
    entry.root.position.set(x, groundHeight(x, z), z);
    entry.root.visible = true;
    entry.spinner.rotation.y = entry.phase;
    this.active.push(entry);
    return entry;
  }

  release(entry) {
    if (!entry.active) return;
    entry.active = false;
    entry.root.visible = false;
    entry.root.position.y = HIDE_Y;
    if (entry.id !== null) { this.byId.delete(entry.id); entry.id = null; }
    const i = this.active.indexOf(entry);
    if (i >= 0) this.active.splice(i, 1);
    if (this.nearestWeapon === entry) this.nearestWeapon = null;
  }

  releaseById(id) {
    const e = this.byId.get(id);
    if (e) this.release(e);
  }

  clear() {
    for (let i = this.active.length - 1; i >= 0; i--) this.release(this.active[i]);
  }

  update(delta, px, pz) {
    this._time += delta;
    const pulse = 0.55 + Math.sin(this._time * 4) * 0.2;
    for (const cat in this._ringMats) this._ringMats[cat].opacity = pulse;

    this.nearestWeapon = null;
    this.touching.length = 0;
    let best = INTERACT_RADIUS * INTERACT_RADIUS;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      const dx = e.x - px, dz = e.z - pz;
      const d2 = dx * dx + dz * dz;
      const near = d2 <= FAR_SKIP * FAR_SKIP;
      if (e.life !== Infinity) {
        e.life -= delta;
        if (e.life <= 0) { this.release(e); continue; }
        e.root.visible = near && (e.life > BLINK_TIME || Math.sin(e.life * 18) > -0.3);
      } else {
        e.root.visible = near;
      }
      if (!near) continue;

      e.phase += delta;
      e.spinner.rotation.y += delta * 1.3;
      e.spinner.position.y = HOVER_HEIGHT + Math.sin(e.phase * 2.2) * 0.08;

      if (e.def.category === "weapon") {
        if (d2 < best) { best = d2; this.nearestWeapon = e; }
      } else if (d2 < AUTO_RADIUS * AUTO_RADIUS) {
        this.touching.push(e);
      }
    }
  }
}
