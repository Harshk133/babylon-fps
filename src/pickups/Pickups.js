import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { PICKUP_KINDS } from "../combat/weapons.js";
import { groundHeight } from "../world/Terrain.js";
import { getItemTemplate } from "../items/ItemModels.js";

const MAX_ACTIVE      = 720;  // battle royale: ~430 placed (most in town houses) + every player's spilled loot
const INTERACT_RADIUS = 2.2;   // weapons, gear, attachments: shows the [E] prompt
const AUTO_RADIUS     = 1.4;   // ammo / throwables / medkits: walk over to collect
const BLINK_TIME      = 5;     // timed drops blink for their last few seconds
const FAR_SKIP        = 90;    // timed drops still count down this far away
const MODEL_RANGE     = 55;    // loot further away isn't drawn
const MODELS_PER_KIND = 96;    // instances per item kind within MODEL_RANGE
const OUTLINE_WIDTH   = 0.012; // m of white rim up close; it widens with distance so it stays readable

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _yAxis = new THREE.Vector3(0, 1, 0);

/**
 * White rim round loot lying on the ground: an inverted hull (back faces of
 * the model pushed out along smoothed normals), drawn unlit and unfogged.
 */
function makeOutlineMaterial() {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide, fog: false, toneMapped: false });
  mat.onBeforeCompile = shader => {
    shader.uniforms.uOutline = { value: OUTLINE_WIDTH };
    shader.vertexShader = "uniform float uOutline;\n" + shader.vertexShader.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      vec4 olWorld = modelMatrix * instanceMatrix * vec4(position, 1.0);
      float olDist = distance(olWorld.xyz, cameraPosition);
      transformed += normalize(normal) * uOutline * clamp(olDist * 0.18, 1.0, 6.0);`,
    );
  };
  mat.customProgramCacheKey = () => "loot-outline";
  return mat;
}

/** One position-only copy of the parts with normals averaged across hard edges, for the outline hull. */
function outlineGeometry(parts) {
  let verts = 0, idx = 0;
  for (const p of parts) { verts += p.attributes.position.count; idx += p.index.count; }
  const pos = new Float32Array(verts * 3), ind = new Uint32Array(idx);
  let vo = 0, io = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, vo * 3);
    const ia = p.index.array;
    for (let k = 0; k < ia.length; k++) ind[io + k] = ia[k] + vo;
    vo += p.attributes.position.count;
    io += ia.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(ind, 1));
  const welded = mergeVertices(g, 1e-4);
  welded.computeVertexNormals();
  return welded;
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
 * drawn through instanced meshes: per item kind one each for its metal, matte
 * and glass parts (part colours baked into vertex colours) plus one for its
 * white outline. Loot lies on the ground at a fixed random heading.
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

    // Item meshes, per kind: all built now so the loading screen compiles their shaders
    this.matteMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.72 });
    this.metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.7, roughness: 0.4 });
    this.outlineMat = makeOutlineMaterial();
    this.kindMeshes = {};     // kind → [InstancedMesh]
    for (const kind of Object.keys(PICKUP_KINDS)) {
      this.pools[kind] = [];
      this._kindMeshes(kind);
    }
  }

  _prepare(im, renderOrder) {
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.count = 0;
    im.frustumCulled = false;   // instances spread far apart; the bounds would be the template's
    im.castShadow = false;      // small loot doesn't need a shadow pass
    im.renderOrder = renderOrder;
    this.scene.add(im);
  }

  /**
   * Bakes a kind's model into instanced meshes, one per material class, in
   * ground space: guns, attachments, vests and backpacks laid on their side,
   * scaled, centred on x / z and resting on y = 0.
   */
  _kindMeshes(kind) {
    const def = PICKUP_KINDS[kind];
    const template = getItemTemplate(kind);
    template.updateMatrixWorld(true);
    const lieFlat = def.category === "weapon" || def.category === "attachment" || (def.category === "gear" && !kind.startsWith("helmet"));
    const pose = new THREE.Matrix4()
      .makeRotationX(lieFlat ? Math.PI / 2 : 0)   // on its side, so the profile faces up
      .multiply(new THREE.Matrix4().makeScale(def.scale, def.scale, def.scale));
    const box = new THREE.Box3(), partBox = new THREE.Box3();
    template.traverse(o => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      box.union(partBox.copy(o.geometry.boundingBox).applyMatrix4(_m.multiplyMatrices(pose, o.matrixWorld)));
    });
    const center = box.getCenter(new THREE.Vector3());
    const base = new THREE.Matrix4().makeTranslation(-center.x, -box.min.y + 0.01, -center.z).multiply(pose);
    const groups = { metal: [], matte: [], glass: [] };
    const all = [];
    let glassMat = null;
    template.traverse(o => {
      if (!o.isMesh) return;
      const part = bakedPart(o, _m.multiplyMatrices(base, o.matrixWorld));
      all.push(part);
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
      this._prepare(im, cls === "glass" ? 2 : 0);
      meshes.push(im);
    }
    const outline = new THREE.InstancedMesh(outlineGeometry(all), this.outlineMat, MODELS_PER_KIND);
    this._prepare(outline, 0);
    meshes.push(outline);
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
    entry.phase = 0;
    entry.spin = Math.random() * Math.PI * 2; // the heading it lies at
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

    this.nearestWeapon = null;
    this.touching.length = 0;
    let best = INTERACT_RADIUS * INTERACT_RADIUS;
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
      if (d2 > MODEL_RANGE * MODEL_RANGE) continue;

      if (shown) {
        _p.set(e.x, e.y, e.z);
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

    // An empty InstancedMesh still costs a draw call (and a shadow one): hide the kinds with nothing in range
    for (const kind in this.kindMeshes) {
      for (const im of this.kindMeshes[kind]) {
        im.visible = im.count > 0;
        if (im.count) im.instanceMatrix.needsUpdate = true;
      }
    }
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
