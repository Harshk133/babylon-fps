import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SEA_Y, SEA_INLAND, TERRAIN_HALF, TERRAIN_GLSL, terrainUniforms, shoreRadius } from "./Terrain.js";

// Water: the sea round the island, the river and the ponds. One opaque
// MeshStandardMaterial (lit, fogged and tone-mapped like everything else),
// patched so the colour comes from the real depth: it samples the terrain
// height texture under each pixel (TERRAIN_GLSL), so shallows go muddy
// green, deep water dark teal, and a band of foam laps wherever the water
// meets the ground. Ripples are a cheap normal wobble. No transparency, so
// no overdraw and no sorting.

export const waterUniforms = { uTime: { value: 0 } };

let shared = null;

/** The one water material (sea, river and ponds all share its program). */
export function waterMaterial() {
  if (shared) return shared;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.18, metalness: 0.05 });
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, terrainUniforms, waterUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWaterPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vWaterPos;
        uniform float uTime;
        ${TERRAIN_GLSL}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float depth = vWaterPos.y - terrainH(vWaterPos.xz);
        if (max(abs(vWaterPos.x), abs(vWaterPos.z)) > ${(TERRAIN_HALF - 3).toFixed(1)}) depth = 9.0;
        vec3 shallow = vec3(0.42, 0.47, 0.33), mid = vec3(0.13, 0.36, 0.38), deep = vec3(0.03, 0.15, 0.22);
        // Inland water (above sea level: the river, the ponds) is silty brown-green
        float inland = step(${(SEA_Y + 0.05).toFixed(2)}, vWaterPos.y);
        shallow = mix(shallow, vec3(0.3, 0.27, 0.17), inland);
        mid = mix(mid, vec3(0.16, 0.2, 0.13), inland);
        deep = mix(deep, vec3(0.08, 0.11, 0.08), inland);
        vec3 wc = mix(shallow, mid, smoothstep(0.0, 1.4, depth));
        wc = mix(wc, deep, smoothstep(1.4, 6.0, depth));
        // Foam: a lapping band at the edge, broken up by moving stripes
        float lap = sin(depth * 18.0 - uTime * 2.2 + sin(vWaterPos.x * 0.21 + vWaterPos.z * 0.17) * 3.0);
        float foam = smoothstep(0.38, 0.0, depth) * (0.55 + 0.45 * lap) * (1.0 - inland * 0.6);
        diffuseColor.rgb = mix(wc, vec3(0.86, 0.9, 0.88), clamp(foam, 0.0, 1.0) * 0.75);`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        {
          vec2 p = vWaterPos.xz;
          float t = uTime;
          vec2 w = vec2(sin(p.x * 0.9 + t * 1.3) + sin(p.y * 1.3 - t * 1.1 + p.x * 0.4),
                        cos(p.y * 0.8 + t * 1.2) + sin(p.x * 1.1 + p.y * 0.6 + t * 0.9));
          normal = normalize(normal + (viewMatrix * vec4(w.x * 0.05, 0.0, w.y * 0.05, 0.0)).xyz);
        }`);
  };
  mat.customProgramCacheKey = () => "water";
  shared = mat;
  return mat;
}

/**
 * The sea: a flat ring at SEA_Y from just inside the waterline (the beach
 * hides that edge) out past the far plane; the backdrop's sea takes over
 * beyond. Its inner edge follows the coast, so it never reaches the cave
 * floors, which lie below sea level.
 */
export function buildSea(scene) {
  const A = 256, rings = [0, 0.04, 0.12, 0.3, 0.6, 1];
  const pos = [], idx = [];
  for (let i = 0; i <= A; i++) {
    const a = (i / A) * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
    const r0 = shoreRadius(cx, cz) - SEA_INLAND;
    for (const t of rings) {
      const r = r0 + (900 - r0) * t;
      pos.push(cx * r, 0, cz * r);
    }
  }
  const R = rings.length;
  for (let i = 0; i < A; i++) {
    for (let j = 0; j < R - 1; j++) {
      const a = i * R + j, b = a + 1, c = a + R, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  if (geo.attributes.normal.getY(0) < 0) { geo.index.array.reverse(); geo.computeVertexNormals(); }
  const mesh = new THREE.Mesh(geo, waterMaterial());
  mesh.position.y = SEA_Y;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);
  return mesh;
}

/**
 * Wooden fishing boats pulled up on the beach (the fishing village). spots:
 * [{ x, z, yaw }]. One merged mesh, and a box collider each (they're cover).
 */
export function buildBoats({ scene, world, material, spots, groundAt, mapObstacles }) {
  const hullCols = [0x2f6f8f, 0xb8402a, 0x2f7a4a, 0xd0a020].map(c => new THREE.Color(c));
  const parts = [];
  const add = (geo, color, m) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.deleteAttribute("uv");
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([color.r, color.g, color.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.applyMatrix4(m);
    parts.push(g);
  };
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const wood = new THREE.Color(0x7a5a3a), dark = new THREE.Color(0x3a2a1c);
  spots.forEach((s, i) => {
    const y = groundAt(s.x, s.z);
    // Tilted a little onto one side, as boats lie on sand
    q.setFromAxisAngle(up, s.yaw).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.12));
    m.compose(p.set(s.x, y + 0.05, s.z), q, one);
    // Hull: a box narrowed to a point at both ends (bow and stern), open on top
    const hull = new THREE.BoxGeometry(1.7, 0.8, 6.5, 1, 1, 6);
    const pos = hull.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      const z = pos.getZ(k) / 3.25;                       // −1 … 1 along the boat
      const taper = 1 - Math.pow(Math.abs(z), 2.2);
      const yb = pos.getY(k);
      pos.setX(k, pos.getX(k) * taper * (yb < 0 ? 0.6 : 1));
      pos.setY(k, yb + 0.4 + Math.abs(z) ** 2 * 0.35 * (yb > 0 ? 1 : 0));
    }
    hull.computeVertexNormals();
    add(hull, hullCols[i % hullCols.length], m);
    add(new THREE.BoxGeometry(1.2, 0.06, 4.2).translate(0, 0.75, 0), wood, m);       // thwart deck
    add(new THREE.CylinderGeometry(0.06, 0.08, 3.6, 6).translate(0, 2.4, 0.8), dark, m); // mast
    add(new THREE.BoxGeometry(0.08, 0.08, 2.2).translate(0, 3.4, 0.4), dark, m);      // spar
    const body = new CANNON.Body({ mass: 0, material });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.7, 0.45, 3.0)), new CANNON.Vec3(0, 0.45, 0));
    body.position.set(s.x, y, s.z);
    body.quaternion.setFromEuler(0, s.yaw, 0);
    world.addBody(body);
    mapObstacles.push({ type: "box", x: s.x, z: s.z, w: 1.4, d: 6, rot: s.yaw, boat: true });
  });
  if (!parts.length) return null;
  const geo = mergeGeometries(parts, false);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);
  return mesh;
}
