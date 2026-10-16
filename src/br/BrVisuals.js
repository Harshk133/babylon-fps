import * as THREE from "three";

// Battle royale props: the blue zone wall, the drop plane and parachutes.
// All of them are built once and only shown / moved afterwards.

const WALL_HEIGHT = 130;

/** The storm wall: an open cylinder with a fading, scrolling blue shader. */
export class ZoneWall {
  constructor(scene) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 160, 1, true).translate(0, 0.5, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x2f8cff) },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          float h = vUv.y;
          float fade = pow(1.0 - h, 1.7);
          float base = pow(1.0 - h, 40.0);
          // Slanted bands crawling up the wall
          float band = smoothstep(0.35, 0.5, abs(fract(vUv.x * 260.0 + h * 9.0 - uTime * 0.35) - 0.5));
          float a = fade * (0.22 + band * 0.16) + base * 0.6;
          vec3 col = uColor + vec3(0.35, 0.45, 0.6) * base;
          gl_FragColor = vec4(col, a * uOpacity);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  set(x, z, r, time) {
    const show = r > 0.4;
    this.mesh.visible = show;
    if (!show) return;
    this.mesh.position.set(x, -1, z);
    this.mesh.scale.set(r, WALL_HEIGHT, r);
    this.material.uniforms.uTime.value = time;
  }

  hide() { this.mesh.visible = false; }
}

/** A twin-prop cargo plane, built along +Z. */
export function createPlane() {
  const body = new THREE.MeshStandardMaterial({ color: 0x5f6a55, roughness: 0.65, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24282a, roughness: 0.8, metalness: 0.2 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fc4e0, roughness: 0.15, metalness: 0.6, emissive: 0x18303f });
  const red = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
  const green = new THREE.MeshBasicMaterial({ color: 0x2aff5a });

  const g = new THREE.Group();
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  add(new THREE.CylinderGeometry(1.6, 1.35, 18, 14).rotateX(Math.PI / 2), body, 0, 0, 0);
  add(new THREE.SphereGeometry(1.6, 14, 10).scale(1, 0.95, 1.7), body, 0, 0, 9);
  add(new THREE.ConeGeometry(1.35, 6, 14).rotateX(-Math.PI / 2), body, 0, 0.3, -12);
  add(new THREE.BoxGeometry(1.8, 0.6, 1.4), glass, 0, 0.95, 10.4);
  add(new THREE.BoxGeometry(28, 0.35, 3.8), body, 0, 0.9, 1.2);
  add(new THREE.BoxGeometry(10, 0.25, 2.2), body, 0, 0.7, -13.4);
  add(new THREE.BoxGeometry(0.3, 4.4, 2.8), body, 0, 2.6, -13.6);
  add(new THREE.BoxGeometry(0.5, 0.25, 0.5), red, -14, 0.9, 1.2);
  add(new THREE.BoxGeometry(0.5, 0.25, 0.5), green, 14, 0.9, 1.2);
  add(new THREE.BoxGeometry(3.2, 0.12, 4), dark, 0, -1.2, -9); // open cargo ramp

  const props = [];
  const propGeo = new THREE.BoxGeometry(3.6, 0.25, 0.08);
  for (const x of [-9, -5, 5, 9]) {
    add(new THREE.CylinderGeometry(0.6, 0.5, 3.4, 10).rotateX(Math.PI / 2), dark, x, 0.6, 2.4);
    const p = add(propGeo, dark, x, 0.6, 4.2);
    props.push(p);
  }
  g.userData.props = props;
  g.traverse(o => { o.castShadow = false; o.receiveShadow = false; });
  g.visible = false;
  return g;
}

/** Spins the props and points the plane along (dx, dz). */
export function updatePlane(plane, x, y, z, dx, dz, delta) {
  plane.position.set(x, y, z);
  plane.rotation.set(0, Math.atan2(dx, dz), Math.sin(performance.now() / 1400) * 0.03);
  for (const p of plane.userData.props) p.rotation.z += delta * 40;
}

// ── Parachutes ───────────────────────────────────────────────────────────────
let chuteShared = null;

function sharedChute() {
  if (chuteShared) return chuteShared;
  const c = document.createElement("canvas");
  c.width = 128; c.height = 4;
  const g = c.getContext("2d");
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? "#f2ead8" : "#e2552b";
    g.fillRect(i * 16, 0, 16, 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const canopy = new THREE.SphereGeometry(3.3, 24, 6, 0, Math.PI * 2, 0, Math.PI * 0.42).scale(1, 0.5, 1);
  const rimY = Math.cos(Math.PI * 0.42) * 3.3 * 0.5;
  const rimR = Math.sin(Math.PI * 0.42) * 3.3;
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * rimR, rimY, Math.sin(a) * rimR), new THREE.Vector3(0, -2.9, 0));
  }
  chuteShared = {
    canopy,
    canopyMat: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide }),
    lines: new THREE.BufferGeometry().setFromPoints(pts),
    lineMat: new THREE.LineBasicMaterial({ color: 0x222222 }),
  };
  return chuteShared;
}

/** A parachute whose harness point sits 1.5 m above its parent's origin (the feet). */
export function createParachute() {
  const s = sharedChute();
  const g = new THREE.Group();
  const canopy = new THREE.Mesh(s.canopy, s.canopyMat);
  canopy.castShadow = true;
  g.add(canopy, new THREE.LineSegments(s.lines, s.lineMat));
  g.position.y = 4.4;
  g.visible = false;
  return g;
}

/** Belly-down freefall pose (amount 0..1) on a Soldier root whose origin is the feet. */
export function setSkydivePose(soldierRoot, amount) {
  soldierRoot.rotation.x = 1.3 * amount;
  soldierRoot.position.y = 0.6 * amount;
}
