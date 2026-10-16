import * as THREE from "three";
import { terrainUniforms, TERRAIN_GLSL } from "./Terrain.js";

// Tall grass tufts around the camera, entirely on the GPU: every tuft has a
// fixed random spot in a square that wraps around the camera (like the rain),
// sits on the terrain via the height texture, is thinned by the grass-density
// channel (none in houses or on props) and sways with the wind. The CPU only
// updates a handful of uniforms per frame; the count scales with quality.

const BOX = 64;          // tufts wrap within this square around the camera

function bladeTexture() {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 128;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 64, 128);
  for (let i = 0; i < 9; i++) {
    const x = 6 + i * 6.5 + Math.random() * 3;
    const lean = (Math.random() - 0.5) * 22;
    const top = 6 + Math.random() * 40;
    const w = 2.2 + Math.random() * 2;
    g.fillStyle = "#fff";
    g.beginPath();
    g.moveTo(x - w, 128);
    g.quadraticCurveTo(x + lean * 0.3, 70, x + lean, top);
    g.quadraticCurveTo(x + lean * 0.3 + w * 0.5, 70, x + w, 128);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.generateMipmaps = true;
  return tex;
}

const VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  ${TERRAIN_GLSL}
  attribute vec4 aRand;
  uniform vec3 uCam;
  uniform float uTime;
  uniform float uWind;
  varying vec2 vUv;
  varying float vShade;
  void main() {
    vec2 wp = aRand.xy * ${BOX.toFixed(1)};
    wp -= ${BOX.toFixed(1)} * floor((wp - uCam.xz) / ${BOX.toFixed(1)} + 0.5);
    vec4 ts = terrainSample(wp);
    float dist = length(wp - uCam.xz);
    // Thinned by the density map, shrunk to nothing at the edge of the box (no popping)
    float keep = step(aRand.w, ts.g);
    float s = keep * smoothstep(${(BOX * 0.5).toFixed(1)}, ${(BOX * 0.36).toFixed(1)}, dist);
    if (s <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(0.0); vShade = 0.0; return; }
    float h = (0.55 + aRand.z * 0.7) * s;
    float w = (0.7 + aRand.z * 0.4) * s;
    float ang = aRand.w * 37.0;
    float ca = cos(ang), sa = sin(ang);
    vec3 local = vec3(position.x * w, position.y * h, position.z * w);
    local.xz = vec2(local.x * ca - local.z * sa, local.x * sa + local.z * ca);
    // Sway: tips only, a slow gust plus a faster flutter
    float tip = position.y * position.y;
    float gust = sin(uTime * 1.3 + wp.x * 0.15 + wp.y * 0.11) * (0.12 + uWind * 0.06);
    float flutter = sin(uTime * 4.1 + aRand.x * 40.0) * 0.04;
    local.x += (gust + flutter) * tip;
    local.z += (gust * 0.6) * tip;
    vec3 p = vec3(wp.x, ts.r - 0.05, wp.y) + local;
    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    vUv = uv;
    vShade = 0.75 + aRand.z * 0.35;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform sampler2D uMap;
  uniform vec3 uLow;
  uniform vec3 uHigh;
  uniform vec3 uLight;
  varying vec2 vUv;
  varying float vShade;
  void main() {
    if (texture2D(uMap, vUv).a < 0.5) discard;
    vec3 c = mix(uLow, uHigh, vUv.y) * uLight * vShade;
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/** Three crossed quads, x ∈ [−.5, .5], y ∈ [0, 1]. */
function tuftGeometry() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const q = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateY((i / 3) * Math.PI);
    parts.push(q);
  }
  const pos = [], uv = [], idx = [];
  let base = 0;
  for (const q of parts) {
    pos.push(...q.getAttribute("position").array);
    uv.push(...q.getAttribute("uv").array);
    for (const k of q.index.array) idx.push(k + base);
    base += q.getAttribute("position").count;
    q.dispose();
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

export class Grass {
  constructor(scene, count) {
    const geo = tuftGeometry();
    const rand = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      rand[i * 4] = Math.random();
      rand[i * 4 + 1] = Math.random();
      rand[i * 4 + 2] = Math.random();
      rand[i * 4 + 3] = Math.random();
    }
    geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(rand, 4));
    geo.instanceCount = count;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsLib.fog,
        ...terrainUniforms,
        uMap: { value: bladeTexture() },
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uWind: { value: 1 },
        uLow: { value: new THREE.Color(0x2a3318) },
        uHigh: { value: new THREE.Color(0x8a8c4a) },
        uLight: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = count > 0;
    scene.add(this.mesh);
    this._time = 0;
  }

  /** light: overall brightness colour from the day/night lights. wind: m/s. wet: 0..1 darkens. */
  update(delta, camPos, light, wind, wet) {
    this._time += delta;
    const u = this.material.uniforms;
    u.uTime.value = this._time;
    u.uCam.value.copy(camPos);
    u.uWind.value = wind;
    u.uLight.value.copy(light).multiplyScalar(1 - wet * 0.25);
  }
}
