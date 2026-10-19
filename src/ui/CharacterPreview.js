import * as THREE from "three";
import { Soldier } from "../player/Soldier.js";

// The character in the middle of the inventory screen: a second Soldier
// (same model, animations, gun and gear meshes as yours) in its own little
// scene, drawn by its own renderer into the screen's canvas. It never enters
// the game world or the physics, and it only renders while the screen is open.
// Drag to turn it.

const TURN_SPEED = 0.012; // rad per pixel dragged

export class CharacterPreview {
  /** canvas: the element to draw into. */
  constructor(canvas) {
    this.canvas = canvas;
    this.ready = false;
    this.yaw = -0.45;       // three-quarter view, like the reference screens
    this._size = [0, 0];
    this._drag = null;

    canvas.addEventListener("pointerdown", e => {
      this._drag = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", e => {
      if (this._drag === null) return;
      this.yaw += (e.clientX - this._drag) * TURN_SPEED;
      this._drag = e.clientX;
    });
    const end = () => { this._drag = null; };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  /** Loads the model (loader: the game's GLTFLoader) and compiles the shaders once, at boot. */
  async init(loader) {
    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    renderer.setClearColor(0x000000, 0);

    const scene = this.scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xe8eeff, 0x4a3828, 2.4));
    const key = new THREE.DirectionalLight(0xfff1dc, 3.4);
    key.position.set(2, 3.5, 4);
    const fill = new THREE.DirectionalLight(0xc8d8ff, 1.2);
    fill.position.set(-3, 1.5, 3);
    const rim = new THREE.DirectionalLight(0xffb070, 2.6);
    rim.position.set(-2.5, 3, -3.5);
    scene.add(key, fill, rim);
    // A soft floor disc so the soldier stands on something
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
    scene.add(floor);

    this.camera = new THREE.PerspectiveCamera(26, 1, 0.1, 30);
    this.camera.position.set(0, 1.05, 4.6);
    this.camera.lookAt(0, 0.92, 0);

    this.soldier = new Soldier();
    await this.soldier.load(loader);
    scene.add(this.soldier.root);
    this.ready = true;
    this._resize();
    this._pose(0);
    renderer.compile(scene, this.camera);
  }

  /** Mirrors your held gun and worn gear. */
  sync(weaponId, gearLevels) {
    if (!this.ready) return;
    if (this.soldier.currentGun !== weaponId) this.soldier.setWeapon(weaponId ?? null);
    this.soldier.setGear(gearLevels);
  }

  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h || (w === this._size[0] && h === this._size[1])) return;
    this._size = [w, h];
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole soldier in frame in tall or wide boxes
    this.camera.position.z = Math.max(4.2, 3.4 / Math.min(1, this.camera.aspect * 1.6));
    this.camera.updateProjectionMatrix();
  }

  _pose(dt) {
    const s = this.soldier;
    s.root.rotation.y = this.yaw;
    s.update(dt, {
      localForward: 0, localRight: 0, aiming: false, firing: false,
      aimYawOffset: 0, aimPitch: 0,
    });
  }

  /** dt: real seconds. Call every frame while the screen is open. */
  render(dt) {
    if (!this.ready) return;
    this._resize();
    this._pose(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
