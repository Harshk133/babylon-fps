import * as THREE from "three";
import * as CANNON from "cannon-es";
import { groundHeight } from "./Terrain.js";

// Stones: a few lumpy low-poly rock shapes, drawn as instanced meshes (one
// draw call per shape and size class). Boulders are solid (a sphere collider
// each, on the minimap and in the way of the auto-rickshaw); pebbles are
// decoration only, so their count can follow the quality setting.

const VARIANTS = 3;

function rockGeometry(rng) {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const pos = geo.getAttribute("position");
  const v = new THREE.Vector3();
  // Same lump for vertices shared between faces: key by rounded position
  const bumps = new Map();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let k = bumps.get(key);
    if (k === undefined) { k = 0.72 + rng() * 0.5; bumps.set(key, k); }
    v.multiplyScalar(k);
    v.y *= 0.62;
    if (v.y < -0.1) v.y *= 0.5; // flatter underside so it sits on the ground
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  // Lighter tops, darker undersides
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp(pos.getY(i) * 0.8 + 0.6, 0.35, 1);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = t;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
}

function instanced(scene, geos, material, list, castShadow) {
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  return geos.map((geo, vi) => {
    const mine = list.filter(r => r.v === vi);
    const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, mine.length));
    mesh.count = mine.length;
    mine.forEach((r, i) => {
      q.setFromEuler(e.set(r.tilt, r.rot, r.tilt * 0.5));
      mesh.setMatrixAt(i, m4.compose(p.set(r.x, r.y, r.z), q, s.set(r.s * r.sx, r.s, r.s * r.sz)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    return mesh;
  });
}

/**
 * boulderRng must be the same on every machine (boulders have colliders);
 * pebbleRng / pebbles may differ by quality.
 * blocked(x, z, r): true where a stone must not go.
 */
export function scatterRocks({
  scene, world, material, boulderRng, pebbleRng, boulders, pebbles, ringMin, ringMax, blocked, mapObstacles,
}) {
  const geos = [];
  for (let i = 0; i < VARIANTS; i++) geos.push(rockGeometry(boulderRng));
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x7a7570, roughness: 0.95, metalness: 0, flatShading: true, vertexColors: true });

  const place = (rng, count, rMin, rMax, solid) => {
    const out = [];
    for (let attempt = 0; attempt < count * 20 && out.length < count; attempt++) {
      const a = rng() * Math.PI * 2;
      const d = ringMin + Math.sqrt(rng()) * (ringMax - ringMin);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const s = rMin + rng() * (rMax - rMin);
      const r = { x, z, s, v: (rng() * VARIANTS) | 0, rot: rng() * Math.PI * 2, tilt: (rng() - 0.5) * 0.3, sx: 0.8 + rng() * 0.5, sz: 0.8 + rng() * 0.5 };
      if (blocked(x, z, s * 1.4 + 0.5)) continue;
      if (solid && out.some(o => Math.hypot(o.x - x, o.z - z) < o.s + s + 2)) continue;
      r.y = groundHeight(x, z) - s * 0.18;
      out.push(r);
    }
    return out;
  };

  const big = place(boulderRng, boulders, 0.9, 2.4, true);
  const small = place(pebbleRng, pebbles, 0.14, 0.45, false);
  instanced(scene, geos, rockMat, big, true);
  if (small.length) instanced(scene, geos, rockMat, small, false);

  for (const r of big) {
    const body = new CANNON.Body({ mass: 0, material });
    const rad = r.s * Math.max(r.sx, r.sz) * 0.8;
    body.addShape(new CANNON.Sphere(rad), new CANNON.Vec3(0, r.s * 0.1, 0));
    body.position.set(r.x, r.y, r.z);
    world.addBody(body);
    mapObstacles.push({ type: "circle", x: r.x, z: r.z, r: rad * 0.95, rock: true });
  }
  return { boulders: big, pebbles: small };
}
