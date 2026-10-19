import * as THREE from "three";
import { PICKUP_KINDS } from "../combat/weapons.js";
import { groundHeight } from "../world/Terrain.js";
import { getItemTemplate } from "../items/ItemModels.js";

const HOVER_HEIGHT    = 0.6;
const MAX_ACTIVE      = 720;  // battle royale: ~430 placed (most in town houses) + every player's spilled loot
const INTERACT_RADIUS = 2.2;   // weapons, gear, attachments: shows the [E] prompt
const AUTO_RADIUS     = 1.4;   // ammo / throwables / medkits: walk over to collect
const BLINK_TIME      = 5;     // timed drops blink for their last few seconds
const FAR_SKIP        = 90;    // don't animate (or draw) pickups this far away
const MODEL_RANGE     = 40;    // past this only the light beam is drawn
const MODELS_PER_KIND = 96;    // instances per item kind within MODEL_RANGE

const CATEGORY_COLOR = {
  weapon:     0xffa630,
  gear:       0x5aa8ff,
  attachment: 0xb98cff,
  ammo:      0xffe066,
  throwable: 0xff5a3a,
  medkit:    0x4dff88,
  fuel:      0x37e0c8,
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

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

/** A plain Float32 copy of a part with its material colour baked into the vertices. */
function bakedPart(mesh, matrix) {
  const src = mesh.geometry;
  const g = new THREE.BufferGeometry();
  for (const name of ["position", "normal"]) {
    const a = src.attributes[name];
    const arr = new Float32Array(a.count * 3);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < 3; k++) arr[i * 3 + k] = a.getComponent(i, k);
    g.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  const n = src.attributes.position.count, col = new Float32Array(n * 3), mc = mesh.material.color;
  for (let i = 0; i < n; i++) { col[i * 3] = mc.r; col[i * 3 + 1] = mc.g; col[i * 3 + 2] = mc.b; }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const count = src.index ? src.index.count : n;
  const idx = new Uint32Array(count);
  for (let i = 0; i < count; i++) idx[i] = src.index ? src.index.getX(i) : i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g.applyMatrix4(matrix);
}

/**
 * World pickups. Entries are plain records (pooled per kind); everything is
 * drawn through instanced meshes: one for every light beam, one for every
 * ring, and per item kind one each for its metal, matte and glass parts, with
 * the part colours baked into vertex colours. A field of loot costs a dozen
 * draw calls instead of six per item.
 */
export class Pickups {
  constructor(scene) {
    this.scene = scene;
    this.pools = {};          // kind → entry[]
    this.active = [];
    this.nearestWeapon = null; // nearest E-pickup (gun, gear, attachment) this frame
    this.touching = [];       // consumables within AUTO_RADIUS this frame
    this._uid = 0;            // every spawn gets a fresh uid, so a stale UI row can't take a reused entry
    this.byId = new Map();    // network id → entry (battle royale loot shared by every player)
    this._time = 0;

    const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true };
    this.beams = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8, 1, true).translate(0, 1.3, 0),
      new THREE.MeshBasicMaterial({ ...additive, map: makeBeamTexture(), opacity: 0.55, fog: false }),
      MAX_ACTIVE);
    this.rings = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.38, 0.58, 32).rotateX(-Math.PI / 2).translate(0, 0.03, 0),
      new THREE.MeshBasicMaterial({ ...additive, opacity: 0.7 }),
      MAX_ACTIVE);
    for (const im of [this.beams, this.rings]) this._prepare(im, 1, true);

    // Item meshes, per kind: all built now so the loading screen compiles their shaders
    this.matteMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.72 });
    this.metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.7, roughness: 0.4 });
    this.kindMeshes = {};     // kind → [InstancedMesh]
    for (const kind of Object.keys(PICKUP_KINDS)) {
      this.pools[kind] = [];
      this._kindMeshes(kind);
    }
  }

  _prepare(im, renderOrder, colored) {
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (colored) im.setColorAt(0, _c.set(0xffffff));
    im.count = 0;
    im.frustumCulled = false;   // instances spread far apart; the bounds would be the template's
    im.castShadow = false;      // floating loot doesn't need a shadow pass
    im.renderOrder = renderOrder;
    this.scene.add(im);
  }

  /** Bakes a kind's model (scale, centring, gun tilt) into instanced meshes, one per material class. */
  _kindMeshes(kind) {
    const def = PICKUP_KINDS[kind];
    const template = getItemTemplate(kind);
    template.updateMatrixWorld(true);
    const center = new THREE.Box3().setFromObject(template).getCenter(new THREE.Vector3());
    // spinner space: tilt (guns) · scale · −centre
    const base = new THREE.Matrix4()
      .makeRotationZ(def.category === "weapon" ? 0.15 : 0)   // guns lie tilted so they read from the camera
      .multiply(new THREE.Matrix4().makeScale(def.scale, def.scale, def.scale))
      .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
    const groups = { metal: [], matte: [], glass: [] };
    let glassMat = null;
    template.traverse(o => {
      if (!o.isMesh) return;
      const part = bakedPart(o, _m.multiplyMatrices(base, o.matrixWorld));
      if (o.material.transparent) { groups.glass.push(part); glassMat = o.material; }
      else if (o.material.metalness >= 0.5) groups.metal.push(part);
      else groups.matte.push(part);
    });
    const meshes = [];
    for (const [cls, parts] of Object.entries(groups)) {
      if (!parts.length) continue;
      const geo = parts.length === 1 ? parts[0] : mergeParts(parts);
      const mat = cls === "glass" ? glassMat : cls === "metal" ? this.metalMat : this.matteMat;
      const im = new THREE.InstancedMesh(geo, mat, MODELS_PER_KIND);
      this._prepare(im, cls === "glass" ? 2 : 0, false);
      meshes.push(im);
    }
    return (this.kindMeshes[kind] = meshes);
  }

  /**
   * kind: key of PICKUP_KINDS. data: { ammo, reserve } for guns, { count } for throwables.
   * life: seconds before it despawns (Infinity for placed world loot).
   * id: optional network id, so a pickup taken by one player vanishes for all.
   * y: floor height (upstairs in a house); default the terrain at (x, z).
   */
  spawn(kind, x, z, data = null, life = Infinity, id = null, y = null) {
    if (this.active.length >= MAX_ACTIVE || !this.pools[kind]) return null;
    if (id !== null && this.byId.has(id)) return null;
    let entry = this.pools[kind].find(e => !e.active);
    if (!entry) {
      entry = { kind, def: PICKUP_KINDS[kind], active: false, x: 0, y: 0, z: 0, life: Infinity, data: null, phase: 0, spin: 0, id: null };
      this.pools[kind].push(entry);
    }
    entry.active = true;
    entry.uid = ++this._uid;
    entry.pending = false;    // claimed from the host, waiting for its answer
    entry.dropLock = false;   // you just dropped it: no walk-over pickup until you step away
    entry.x = x;
    entry.z = z;
    entry.y = y ?? groundHeight(x, z);
    entry.life = life;
    entry.data = data;
    entry.id = id;
    if (id !== null) this.byId.set(id, entry);
    entry.phase = Math.random() * Math.PI * 2;
    entry.spin = entry.phase;
    this.active.push(entry);
    return entry;
  }

  release(entry) {
    if (!entry.active) return;
    entry.active = false;
    if (entry.id !== null) { this.byId.delete(entry.id); entry.id = null; }
    const i = this.active.indexOf(entry);
    if (i >= 0) this.active.splice(i, 1);
    if (this.nearestWeapon === entry) this.nearestWeapon = null;
  }

  /**
   * Something you just dropped: walking over it won't pick it back up until
   * you've stepped out of reach once (E and the inventory screen still can).
   */
  lockAuto(entry) {
    if (entry) entry.dropLock = true;
  }

  releaseById(id) {
    const e = this.byId.get(id);
    if (e) this.release(e);
  }

  clear() {
    for (let i = this.active.length - 1; i >= 0; i--) this.release(this.active[i]);
  }

  /**
   * Loot within `r` m of (px, pz) on the same floor as feet height py,
   * nearest first, into `out` (the inventory screen's vicinity list).
   */
  near(px, pz, py, r, out) {
    out.length = 0;
    for (const e of this.active) {
      if (e.pending) continue;
      const d2 = (e.x - px) ** 2 + (e.z - pz) ** 2;
      if (d2 > r * r || (py !== null && Math.abs(e.y - py) > 1.4)) continue;
      e.dist = Math.sqrt(d2);
      out.push(e);
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  /** py: the player's feet height (only loot on the same floor can be picked up). */
  update(delta, px, pz, py = null) {
    this._time += delta;
    this.rings.material.opacity = 0.55 + Math.sin(this._time * 4) * 0.2;

    this.nearestWeapon = null;
    this.touching.length = 0;
    let best = INTERACT_RADIUS * INTERACT_RADIUS;
    let nBeam = 0, nRing = 0;
    for (const kind in this.kindMeshes) for (const im of this.kindMeshes[kind]) im.count = 0;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      const dx = e.x - px, dz = e.z - pz;
      const d2 = dx * dx + dz * dz;
      if (e.life !== Infinity) {
        e.life -= delta;
        if (e.life <= 0) { this.release(e); continue; }
      }
      if (d2 > FAR_SKIP * FAR_SKIP) continue;
      // Timed drops blink for their last seconds
      const shown = e.life > BLINK_TIME || Math.sin(e.life * 18) > -0.3;
      const color = CATEGORY_COLOR[e.def.category];
      if (shown) {
        _p.set(e.x, e.y, e.z);
        this.beams.setMatrixAt(nBeam, _m.makeTranslation(_p.x, _p.y, _p.z));
        this.beams.setColorAt(nBeam++, _c.set(color));
      }
      // Far loot: just the beam
      if (d2 > MODEL_RANGE * MODEL_RANGE) continue;

      e.phase += delta;
      e.spin += delta * 1.3;
      if (shown) {
        this.rings.setMatrixAt(nRing, _m.makeTranslation(e.x, e.y, e.z));
        this.rings.setColorAt(nRing++, _c.set(color));
        _p.set(e.x, e.y + HOVER_HEIGHT + Math.sin(e.phase * 2.2) * 0.08, e.z);
        _m.compose(_p, _q.setFromAxisAngle(_yAxis, e.spin), _s);
        for (const im of this.kindMeshes[e.kind]) {
          if (im.count < MODELS_PER_KIND) im.setMatrixAt(im.count++, _m);
        }
      }
      if (py !== null && Math.abs(e.y - py) > 1.4) continue; // the other floor of a house
      if (e.pending) continue;

      if (e.dropLock && d2 > (AUTO_RADIUS + 0.6) ** 2) e.dropLock = false;
      if (e.def.interact) {
        if (d2 < best) { best = d2; this.nearestWeapon = e; }
      } else if (d2 < AUTO_RADIUS * AUTO_RADIUS && !e.dropLock) {
        this.touching.push(e);
      }
    }

    this.beams.count = nBeam;
    this.rings.count = nRing;
    for (const im of [this.beams, this.rings]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    for (const kind in this.kindMeshes) for (const im of this.kindMeshes[kind]) if (im.count) im.instanceMatrix.needsUpdate = true;
  }
}

/** Merges baked parts (same attributes: position, normal, color; indexed). */
function mergeParts(parts) {
  let verts = 0, idx = 0;
  for (const p of parts) { verts += p.attributes.position.count; idx += p.index.count; }
  const pos = new Float32Array(verts * 3), nor = new Float32Array(verts * 3), col = new Float32Array(verts * 3), ind = new Uint32Array(idx);
  let vo = 0, io = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, vo * 3);
    nor.set(p.attributes.normal.array, vo * 3);
    col.set(p.attributes.color.array, vo * 3);
    const ia = p.index.array;
    for (let k = 0; k < ia.length; k++) ind[io + k] = ia[k] + vo;
    vo += p.attributes.position.count;
    io += ia.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(ind, 1));
  return g;
}
