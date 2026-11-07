// Static model merging. Sketchfab / VRML exports arrive as dozens of small
// meshes (the vine tree is 32, the WRL house 216), and every one is a draw call
// in the main pass and another in the shadow pass. On a phone that submission
// cost, not the triangle count, is what sets the frame rate. This bakes every
// static mesh under a root into one mesh per distinct material, in the root's
// own space, so the root can still be moved, scaled and cloned as before.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const ATTRS = ["position", "normal", "uv", "color"];
const _rel = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

/** Plain Float32 copy of the attributes we keep (meshopt output is quantized / interleaved). */
export function toFloatGeometry(src) {
  const pos = src.attributes.position;
  if (!pos) return null;
  const out = new THREE.BufferGeometry();
  for (const name of ATTRS) {
    const a = src.attributes[name];
    if (!a) continue;
    const n = a.itemSize, arr = new Float32Array(a.count * n);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) arr[i * n + k] = a.getComponent(i, k);
    out.setAttribute(name, new THREE.BufferAttribute(arr, n));
  }
  // mergeGeometries wants all indexed or none: index everything
  const count = src.index ? src.index.count : pos.count;
  const idx = new Uint32Array(count);
  for (let i = 0; i < count; i++) idx[i] = src.index ? src.index.getX(i) : i;
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/** Materials that look the same merge together (VRML gives every shape its own copy). */
function materialKey(m) {
  return [
    m.type, m.color?.getHexString(), m.emissive?.getHexString(), m.map?.uuid, m.normalMap?.uuid,
    m.roughness, m.metalness, m.opacity, m.transparent, m.side, m.vertexColors, m.alphaTest, m.flatShading,
  ].join("|");
}

// Shared stand-ins for plain-coloured materials (flatten): the colour moves into
// the vertices, so every part that only differs by colour is one draw call, and
// every model flattened this way shares the same few materials (fewer program
// and uniform switches too)
const _flatMats = new Map();
function flatMaterial(m) {
  const r = Math.round((m.roughness ?? 1) * 4) / 4, mt = Math.round((m.metalness ?? 0) * 4) / 4;
  const key = `${r}|${mt}|${m.side}|${!!m.flatShading}`;
  let out = _flatMats.get(key);
  if (!out) {
    out = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: r, metalness: mt, side: m.side, flatShading: !!m.flatShading });
    out.name = `flat ${key}`;
    _flatMats.set(key, out);
  }
  return out;
}
/** A material with nothing but a colour (no texture, transparency, glow or vertex colours of its own). */
function isPlain(m) {
  return m && m.isMeshStandardMaterial && !m.map && !m.normalMap && !m.roughnessMap && !m.metalnessMap && !m.aoMap
    && !m.emissiveMap && !m.alphaMap && !m.transparent && !(m.alphaTest > 0) && !m.vertexColors
    && (!m.emissive || m.emissive.getHex() === 0 || m.emissiveIntensity === 0) && (m.opacity ?? 1) >= 1;
}
function paint(geo, color) {
  const n = geo.attributes.position.count, arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = color.r; arr[i * 3 + 1] = color.g; arr[i * 3 + 2] = color.b; }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute("uv");
}

/**
 * Merges every visible, static mesh under root. Skinned, morphed, instanced and
 * multi-material meshes are left as they are. Returns how many draw calls went away.
 * opts.flatten: plain-coloured materials become vertex colours on shared
 * materials (roughness / metalness rounded to quarters), and line segments
 * merge into one per root (vertex colours too).
 */
export function mergeStaticMeshes(root, opts = {}) {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const meshes = [], lines = [];
  let others = 0;
  root.traverse(o => {
    if (o === root) return;
    const mergeable = o.isMesh && o.visible && !o.isSkinnedMesh && !o.isInstancedMesh
      && !o.morphTargetInfluences && !Array.isArray(o.material);
    if (mergeable) meshes.push(o);
    else if (opts.flatten && o.isLineSegments && o.visible && o.material?.isLineBasicMaterial && !o.material.transparent) lines.push(o);
    else if (o.isMesh || o.isLight || o.isCamera || o.isSprite || o.isPoints || o.isLine) others++;
  });
  if (meshes.length < 2) return mergeLines(root, lines);

  const groups = new Map(); // key → { material, geos, cast, receive }
  for (const o of meshes) {
    const geo = toFloatGeometry(o.geometry);
    if (!geo) continue;
    _rel.multiplyMatrices(_inv, o.matrixWorld);
    geo.applyMatrix4(_rel);
    // A mirrored part was drawn with flipped culling; baked in, it needs flipped winding
    if (_rel.determinant() < 0) {
      const ix = geo.index.array;
      for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
    }
    let material = o.material;
    if (opts.flatten && isPlain(material)) {
      paint(geo, material.color);
      material = flatMaterial(material);
    }
    const sig = ATTRS.map(n => (geo.attributes[n] ? `${n}${geo.attributes[n].itemSize}` : "")).join("");
    const key = `${material === o.material ? materialKey(material) : material.uuid}#${sig}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { material, geos: [], cast: false, receive: false });
    g.geos.push(geo);
    g.cast ||= o.castShadow;
    g.receive ||= o.receiveShadow;
  }

  // Everything mergeable is replaced; empty groups left behind go too (they'd
  // still cost a matrix update every frame)
  for (const o of meshes) o.removeFromParent();
  if (!others && !lines.length) root.clear();
  let made = 0;
  for (const g of groups.values()) {
    const geo = g.geos.length === 1 ? g.geos[0] : mergeGeometries(g.geos, false);
    if (!geo) continue;
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, g.material);
    mesh.castShadow = g.cast;
    mesh.receiveShadow = g.receive;
    root.add(mesh);
    made++;
  }
  return meshes.length - made + mergeLines(root, lines);
}

const _lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
/** Line segments under root into one (their colours in the vertices). Returns draw calls saved. */
function mergeLines(root, lines) {
  if (lines.length < 2) return 0;
  const geos = [];
  for (const l of lines) {
    let g = l.geometry.index ? l.geometry.toNonIndexed() : l.geometry.clone();
    const pos = g.attributes.position;
    const out = new THREE.BufferGeometry();
    const p = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { p[i * 3] = pos.getX(i); p[i * 3 + 1] = pos.getY(i); p[i * 3 + 2] = pos.getZ(i); }
    out.setAttribute("position", new THREE.BufferAttribute(p, 3));
    _rel.multiplyMatrices(_inv, l.matrixWorld);
    out.applyMatrix4(_rel);
    const c = l.material.color, col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    out.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geos.push(out);
    if (g !== l.geometry) g.dispose();
  }
  for (const l of lines) l.removeFromParent();
  const merged = new THREE.LineSegments(mergeGeometries(geos, false), _lineMat);
  merged.geometry.computeBoundingSphere();
  root.add(merged);
  return lines.length - 1;
}
