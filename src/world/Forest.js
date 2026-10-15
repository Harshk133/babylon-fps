import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// A dead forest: a few procedurally grown leafless trees (bent trunk,
// recursive gnarled branches), drawn as one InstancedMesh per variant, so
// over a hundred trees cost a handful of draw calls. Every tree gets a static
// trunk collider and a minimap footprint. Sizes are given in multiples of
// the player's height so the scale always reads right next to the soldier.

const VARIANTS     = 4;
const BASE_HEIGHT  = 10;     // metres, before per-tree scaling
const TRUNK_RADIUS = 0.34;
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const BARK_DARK = new THREE.Color(0x15110f);
const BARK_LIGHT = new THREE.Color(0x3b322b);

/** Tapered, bending limb from `start` along `dir`; recurses into side branches. */
function grow(out, rng, start, dir, length, radius, depth) {
  const segs = depth >= 2 ? 3 : 2;
  const p = start.clone();
  const d = dir.clone();
  let r = radius;
  const joints = [];
  for (let s = 0; s < segs; s++) {
    const len = length / segs;
    const r2 = r * 0.72;
    const geo = new THREE.CylinderGeometry(r2, r, len * 1.04, depth >= 2 ? 7 : 5, 1, true);
    geo.translate(0, len / 2, 0);
    geo.applyQuaternion(_q.setFromUnitVectors(_up, d));
    geo.translate(p.x, p.y, p.z);
    out.push(geo);
    p.addScaledVector(d, len);
    joints.push(p.clone(), d.clone(), r2);
    // Gnarl: wander a little, with a slight upward pull
    d.x += (rng() - 0.5) * 0.55;
    d.z += (rng() - 0.5) * 0.55;
    d.y += (rng() - 0.35) * 0.3;
    d.normalize();
    r = r2;
  }
  if (depth <= 0) return;
  const kids = depth >= 2 ? 3 : 2;
  for (let k = 0; k < kids; k++) {
    // Branch off from one of the joints, splaying outward and up
    const j = Math.min(segs - 1, Math.floor(rng() * segs * 0.6 + segs * 0.4)) * 3;
    const at = joints[j], parentDir = joints[j + 1], pr = joints[j + 2];
    const az = rng() * Math.PI * 2;
    const el = 0.35 + rng() * 0.55;
    const cd = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el))
      .lerp(parentDir, 0.25).normalize();
    grow(out, rng, at, cd, length * (0.48 + rng() * 0.2), pr * 0.85, depth - 1);
  }
}

function buildVariant(rng) {
  const parts = [];
  const trunkLen = BASE_HEIGHT * (0.5 + rng() * 0.12);
  grow(parts, rng, new THREE.Vector3(0, -0.3, 0), new THREE.Vector3((rng() - 0.5) * 0.15, 1, (rng() - 0.5) * 0.15).normalize(),
    trunkLen, TRUNK_RADIUS, 3);
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  // Darker toward the roots
  geo.computeBoundingBox();
  const top = geo.boundingBox.max.y;
  const pos = geo.getAttribute("position");
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.copy(BARK_DARK).lerp(BARK_LIGHT, THREE.MathUtils.clamp(pos.getY(i) / top, 0, 1) * 0.8 + rng() * 0.2);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return { geo, height: top };
}

/**
 * Plants `count` trees in a ring around the origin.
 *   rng: seeded random (deterministic layout)
 *   heightMul: [min, max] tree height in player heights
 *   blocked(x, z): true where a tree must not go (houses, props, loot, spawn)
 */
export function plantDeadForest({
  scene, world, material, rng, count, playerHeight, heightMul, ringMin, ringMax, blocked, mapObstacles,
}) {
  const variants = [];
  for (let v = 0; v < VARIANTS; v++) variants.push(buildVariant(rng));
  const bark = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true });

  const placed = [];
  const minSep = 4.5;
  for (let attempt = 0; attempt < count * 25 && placed.length < count; attempt++) {
    const a = rng() * Math.PI * 2;
    const r = ringMin + Math.sqrt(rng()) * (ringMax - ringMin);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (blocked(x, z)) continue;
    if (placed.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 < minSep * minSep)) continue;
    const v = (rng() * VARIANTS) | 0;
    const h = playerHeight * (heightMul[0] + rng() * (heightMul[1] - heightMul[0]));
    placed.push({ x, z, v, h, rot: rng() * Math.PI * 2, tx: (rng() - 0.5) * 0.08, tz: (rng() - 0.5) * 0.08 });
  }

  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(), eul = new THREE.Euler();
  const meshes = variants.map((variant, vi) => {
    const list = placed.filter(p => p.v === vi);
    const mesh = new THREE.InstancedMesh(variant.geo, bark, Math.max(1, list.length));
    mesh.count = list.length;
    list.forEach((p, i) => {
      const s = p.h / variant.height;
      pos.set(p.x, 0, p.z);
      quat.setFromEuler(eul.set(p.tx, p.rot, p.tz));
      scl.set(s * (0.9 + (i % 3) * 0.08), s, s * (0.9 + ((i + 1) % 3) * 0.08));
      mesh.setMatrixAt(i, m4.compose(pos, quat, scl));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    return mesh;
  });

  // Trunk colliders: one small static body each (a single compound body
  // would make every monster test against every trunk)
  for (const p of placed) {
    const s = p.h / variants[p.v].height;
    const r = TRUNK_RADIUS * s * 0.9;
    const trunkH = BASE_HEIGHT * 0.45 * s;
    const body = new CANNON.Body({ mass: 0, material });
    body.addShape(new CANNON.Cylinder(r * 0.8, r, trunkH, 8), new CANNON.Vec3(0, trunkH / 2, 0));
    body.position.set(p.x, 0, p.z);
    world.addBody(body);
    mapObstacles.push({ type: "circle", x: p.x, z: p.z, r: Math.max(0.6, r * 1.6) });
  }
  return { meshes, trees: placed };
}
