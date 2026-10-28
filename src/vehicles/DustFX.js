import * as THREE from "three";

// Dust (and tyre smoke) kicked up behind vehicle wheels. One instanced
// billboard mesh holds a ring buffer of puffs; emit() writes one puff's
// start time, origin, drift and colour into the next slot, and the whole
// life (rise, spread, grow, fade) is computed in the vertex shader from one
// time uniform, like FireFX and SmokeFX. A puff that has lived out its life
// collapses to nothing, so nothing lingers. One draw call for every vehicle.

const MAX = 320;
const LIFE = 1.6;

const VERT = /* glsl */ `
  uniform float uTime;
  attribute vec4 aStart;   // xyz origin, w start time
  attribute vec4 aDrift;   // xyz velocity, w size
  attribute vec4 aTint;    // rgb colour, a opacity
  varying vec2 vUv;
  varying vec4 vTint;
  varying float vAlpha;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    float age = uTime - aStart.w;
    if (age < 0.0 || age > ${LIFE.toFixed(2)}) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float life = age / ${LIFE.toFixed(2)};
    // Thrown out fast, slowed by the air, then it just hangs and rises a little
    float k = 1.0 - exp(-age * 2.6);
    vec3 p = aStart.xyz + aDrift.xyz * (k / 2.6) + vec3(0.0, age * 0.35, 0.0);
    float size = aDrift.w * (0.45 + life * 1.6);
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    mvPosition.xy += position.xy * size;
    gl_Position = projectionMatrix * mvPosition;
    vUv = uv;
    vTint = aTint;
    vAlpha = aTint.a * smoothstep(0.0, 0.08, life) * (1.0 - life) * (1.0 - life);
    #include <fog_vertex>
  }
`;
const FRAG = /* glsl */ `
  uniform float uLight;
  varying vec2 vUv;
  varying vec4 vTint;
  varying float vAlpha;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    vec2 q = vUv - 0.5;
    float r = length(q) * 2.0;
    float a = (1.0 - smoothstep(0.35, 1.0, r)) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vTint.rgb * uLight * (0.85 + 0.25 * (1.0 - r)), a);
    #include <fog_fragment>
  }
`;

/** Puff colours by surface. */
export const DUST = {
  dirt:   [0.62, 0.5, 0.36, 0.75],
  dry:    [0.74, 0.63, 0.46, 0.7],
  sand:   [0.8, 0.72, 0.55, 0.6],
  smoke:  [0.62, 0.62, 0.62, 0.35],   // tyre smoke on asphalt
  splash: [0.75, 0.8, 0.8, 0.4],      // through shallow water
};

export class DustFX {
  constructor(scene) {
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute("position", base.getAttribute("position"));
    geo.setAttribute("uv", base.getAttribute("uv"));
    this.start = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4).fill(-1e4), 4);
    this.drift = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    for (const a of [this.start, this.drift, this.tint]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aStart", this.start);
    geo.setAttribute("aDrift", this.drift);
    geo.setAttribute("aTint", this.tint);
    geo.instanceCount = MAX;
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uLight: { value: 1 } }]);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, fog: true,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.next = 0;
    this.time = 0;
    this.dirty = false;
  }

  /** One puff at (x, y, z) drifting (vx, vy, vz), size metres, colour [r, g, b, a] (DUST). */
  emit(x, y, z, vx, vy, vz, size, color) {
    const i = this.next;
    this.next = (i + 1) % MAX;
    this.start.setXYZW(i, x, y, z, this.time);
    this.drift.setXYZW(i, vx, vy, vz, size);
    this.tint.setXYZW(i, color[0], color[1], color[2], color[3]);
    this.dirty = true;
  }

  /** Every frame. light: 0..1 scene brightness (so dust isn't glowing at night). */
  update(delta, light = 1) {
    this.time += delta;
    this.uniforms.uTime.value = this.time;
    this.uniforms.uLight.value = light;
    if (this.dirty) {
      this.start.needsUpdate = this.drift.needsUpdate = this.tint.needsUpdate = true;
      this.dirty = false;
    }
  }
}
