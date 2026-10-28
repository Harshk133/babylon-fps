import * as THREE from "three";
import { fbm, SEA_Y } from "./Terrain.js";

// Distant mountains. They live in their own scene, drawn first with a far
// camera, then the depth buffer is cleared and the game scene is drawn on top
// with its short far plane (220 m). So the mountains cost one cheap draw and
// don't make every tree and house past the fog get rendered too.
//
// The sky dome joins this scene. The mountains are lit by a few uniforms
// copied from the day/night lights (no real lights here) and fade into the
// fog colour with distance, keeping the hazy horror skyline at night.
//
// The map is an island: the range is a far mainland coast across open sea
// (it rises out of the water at INNER), and under everything is a sea-
// coloured floor that carries on from the game scene's water past its far plane.

const INNER = 1000;
const OUTER = 2000;
const RINGS = 18;

const VERT = /* glsl */ `
  attribute vec3 color;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying float vDist;
  varying float vH;
  void main() {
    vColor = color;
    vNormal = normal;
    vH = position.y;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vDist = length(wp.xz - cameraPosition.xz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const FRAG = /* glsl */ `
  uniform vec3 uFog;
  uniform vec3 uLightDir;
  uniform vec3 uLight;
  uniform vec3 uAmbient;
  uniform float uHaze;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying float vDist;
  varying float vH;
  void main() {
    float diff = max(dot(normalize(vNormal), uLightDir), 0.0);
    vec3 c = vColor * (uAmbient + uLight * diff);
    // Far ranges melt into the fog; the base is always hazier than the peaks
    float haze = clamp(uHaze + vDist / 2600.0 - vH / 900.0, 0.0, 0.94);
    gl_FragColor = vec4(mix(c, uFog, haze), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const _sea = new THREE.Color(0x1d4a55);

export class Backdrop {
  constructor({ segments = 160 }) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 2, OUTER * 1.5);

    // ── Mountain ring: radial rows × angular columns, height from a profile and ridged noise
    const cols = segments, rows = RINGS + 1;
    const pos = new Float32Array(rows * (cols + 1) * 3);
    const col = new Float32Array(rows * (cols + 1) * 3);
    const low = new THREE.Color(0x2c2a24), mid = new THREE.Color(0x4a4640), high = new THREE.Color(0x8a8a8e);
    const c = new THREE.Color();
    for (let j = 0; j < rows; j++) {
      const t = j / (rows - 1);
      const r = INNER + (OUTER - INNER) * Math.pow(t, 1.35);
      for (let i = 0; i <= cols; i++) {
        const a = (i / cols) * Math.PI * 2;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        // Rise from the border ridge to tall peaks, then fall away toward the horizon
        const profile = Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) * (1 - t * 0.45);
        const ridge = 1 - Math.abs(fbm(Math.cos(a) * 5 + 40, Math.sin(a) * 5 + t * 3, 4, 101) * 2 - 1);
        // Out of the sea at the inner edge, up into the range
        const y = SEA_Y - 4 + Math.min(1, t * 6) * 22 + profile * (60 + ridge * ridge * 210) + fbm(x / 60, z / 60, 3, 7) * 25 * Math.min(1, t * 6);
        const k = (j * (cols + 1) + i) * 3;
        pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
        const hN = Math.min(1, y / 240);
        c.copy(low).lerp(mid, Math.min(1, hN * 2)).lerp(high, Math.max(0, hN * 2 - 1.1));
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      }
    }
    const index = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i, b = a + 1, d = a + cols + 1, e = d + 1;
        index.push(a, b, d, b, e, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    this.uniforms = {
      uFog: { value: new THREE.Color() },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uLight: { value: new THREE.Color() },
      uAmbient: { value: new THREE.Color() },
      uHaze: { value: 0.35 },
    };
    this.mountains = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG }));
    this.mountains.frustumCulled = false;
    this.mountains.matrixAutoUpdate = false;
    this.scene.add(this.mountains);

    // The sea out to the horizon, under the gap between the game's far plane and the range (hazed into the fog)
    this.floorMat = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(OUTER * 1.4, 48).rotateX(-Math.PI / 2), this.floorMat);
    this.floor.position.y = SEA_Y;
    this.floor.matrixAutoUpdate = false;
    this.floor.updateMatrix();
    this.scene.add(this.floor);
  }

  /** Moves the sky dome in here so it is drawn first, behind the mountains. */
  adoptSky(sky) {
    sky.renderOrder = -10;
    this.scene.add(sky);
  }

  /** Copies the view and the day/night lighting. */
  update(camera, { fogColor, lightDir, sun, hemi, darkness }) {
    const cam = this.camera;
    cam.position.copy(camera.position);
    cam.quaternion.copy(camera.quaternion);
    if (cam.fov !== camera.fov || cam.aspect !== camera.aspect) {
      cam.fov = camera.fov;
      cam.aspect = camera.aspect;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    const u = this.uniforms;
    u.uFog.value.copy(fogColor);
    u.uLightDir.value.copy(lightDir).normalize();
    u.uLight.value.copy(sun.color).multiplyScalar(sun.intensity * 0.35);
    u.uAmbient.value.copy(hemi.color).multiplyScalar(hemi.intensity * 0.45);
    u.uHaze.value = 0.3 + darkness * 0.25;
    this.floorMat.color.copy(fogColor).lerp(_sea, 0.35 * (1 - darkness * 0.6));
  }

  render(renderer) {
    renderer.render(this.scene, this.camera);
  }
}
