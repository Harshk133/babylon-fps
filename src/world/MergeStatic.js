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

/**
 * Merges every visible, static mesh under root. Skinned, morphed, instanced and
 * multi-material meshes are left as they are. Returns how many draw calls went away.
 */
export function mergeStaticMeshes(root) {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const meshes = [];
  let others = 0;
  root.traverse(o => {
    if (o === root) return;
    const mergeable = o.isMesh && o.visible && !o.isSkinnedMesh && !o.isInstancedMesh
      && !o.morphTargetInfluences && !Array.isArray(o.material);
    if (mergeable) meshes.push(o);
    else if (o.isMesh || o.isLight || o.isCamera || o.isSprite || o.isPoints || o.isLine) others++;
  });
  if (meshes.length < 2) return 0;

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
    const sig = ATTRS.map(n => (geo.attributes[n] ? `${n}${geo.attributes[n].itemSize}` : "")).join("");
    const key = `${materialKey(o.material)}#${sig}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { material: o.material, geos: [], cast: false, receive: false });
    g.geos.push(geo);
    g.cast ||= o.castShadow;
    g.receive ||= o.receiveShadow;
  }

  // Everything mergeable is replaced; empty groups left behind go too (they'd
  // still cost a matrix update every frame)
  for (const o of meshes) o.removeFromParent();
  if (!others) root.clear();
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
  return meshes.length - made;
}
