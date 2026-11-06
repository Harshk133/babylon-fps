import * as THREE from "three";

// Black tyre marks left on the ground by a sliding or hard-braking vehicle:
// short dark strips laid down every MARK_STEP m under each rear wheel, along
// the direction of travel, darker for a harder skid, fading out over LIFE s.
// One InstancedMesh ring buffer; the fade is done in the vertex / fragment
// shader from each strip's birth time, so the CPU only writes new strips.

const MAX = 900;
const LIFE = 30;           // s before a mark is gone
const MARK_STEP = 0.32;    // m between strips (they overlap into a line)

export class SkidMarks {
  /** groundAt(x, z): the surface to lie on (terrain plus the asphalt's lift). */
  constructor(scene, groundAt) {
    this.groundAt = groundAt;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.born = new Float32Array(MAX).fill(-1e6);
    this.dark = new Float32Array(MAX);
    geo.setAttribute("aBorn", new THREE.InstancedBufferAttribute(this.born, 1));
    geo.setAttribute("aDark", new THREE.InstancedBufferAttribute(this.dark, 1));
    this.time = { value: 0 };
    const mat = new THREE.MeshBasicMaterial({ color: 0x0b0a09, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.onBeforeCompile = shader => {
      shader.uniforms.uTime = this.time;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\nattribute float aBorn;\nattribute float aDark;\nuniform float uTime;\nvarying float vAlpha;\nvarying vec2 vUv2;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\nfloat age = uTime - aBorn;\nvAlpha = aDark * clamp(1.0 - age / ${LIFE.toFixed(1)}, 0.0, 1.0) * step(0.0, age);\nvUv2 = uv;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\nvarying float vAlpha;\nvarying vec2 vUv2;`)
        // Soft edges across the strip, a little rubber grain along it
        .replace("#include <dithering_fragment>", `#include <dithering_fragment>\nfloat edge = smoothstep(0.0, 0.3, vUv2.x) * smoothstep(1.0, 0.7, vUv2.x);\nfloat grain = 0.75 + 0.25 * fract(sin(dot(floor(vUv2 * vec2(6.0, 14.0)), vec2(12.9898, 78.233))) * 43758.5453);\ngl_FragColor.a *= vAlpha * edge * grain;`);
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.name = "skid-marks";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) this.mesh.setMatrixAt(i, zero);
    this.mesh.count = MAX;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.next = 0;
    this.last = new Map();   // vehicle → { x, z } where its last strips were laid
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._dirty = false;
    this._lastMark = -1e6;
    this._lo = MAX; this._hi = -1;   // slots written since the last upload
  }

  /** A vehicle skidding this frame with strength 0..1: strips under its rear wheels if it's moved on far enough. */
  mark(car, strength) {
    const prev = this.last.get(car);
    if (prev && Math.hypot(car.x - prev.x, car.z - prev.z) < MARK_STEP) return;
    if (!prev) { this.last.set(car, { x: car.x, z: car.z }); return; }
    // Along the way it actually moved (a slide runs sideways), not where it points
    const mx = car.x - prev.x, mz = car.z - prev.z, len = Math.hypot(mx, mz);
    prev.x = car.x; prev.z = car.z;
    if (len > 3) return;   // teleported / respawned
    const yaw = Math.atan2(mx, mz);
    const { rear, track } = car.spec.wheels;
    const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw);
    const width = car.kind === "tractor" ? 0.45 : 0.24;
    for (const side of [1, -1]) {
      const x = car.x + sy * rear + cy * track * side;
      const z = car.z + cy * rear - sy * track * side;
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      this._q.setFromAxisAngle(this._up, yaw);
      this._p.set(x - mx / 2, this.groundAt(x, z) + 0.02, z - mz / 2);
      this._s.set(width, 1, len + 0.08);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
      this.born[i] = this.time.value;
      this.dark[i] = 0.35 + strength * 0.5;
      this._lo = Math.min(this._lo, i);
      this._hi = Math.max(this._hi, i);
    }
    this._dirty = true;
    this._lastMark = this.time.value;
    this.mesh.visible = true;
  }

  /** A skid ended: the next one starts a fresh line (no strip bridging the gap). */
  lift(car) { this.last.delete(car); }

  update(t) {
    this.time.value = t;
    if (this._dirty) {
      // Upload only the slots written this frame (not the whole ring buffer)
      this._dirty = false;
      const lo = this._lo, n = this._hi - lo + 1;
      const im = this.mesh.instanceMatrix, ab = this.mesh.geometry.attributes.aBorn, ad = this.mesh.geometry.attributes.aDark;
      im.clearUpdateRanges(); ab.clearUpdateRanges(); ad.clearUpdateRanges();
      im.addUpdateRange(lo * 16, n * 16); ab.addUpdateRange(lo, n); ad.addUpdateRange(lo, n);
      im.needsUpdate = ab.needsUpdate = ad.needsUpdate = true;
      this._lo = MAX; this._hi = -1;
    }
    // Nothing laid for a whole lifetime: nothing to draw
    if (this.mesh.visible && t - this._lastMark > LIFE) this.mesh.visible = false;
  }
}
