import * as THREE from "three";
import { Soldier } from "../player/Soldier.js";

// The character in the middle of the inventory screen: a second Soldier
// (same model, animations, gun and gear meshes as yours) in its own little
// scene, drawn by its own renderer into the screen's canvas. It never enters
// the game world or the physics, and it only renders while the screen is open.
// Drag to turn it.

const TURN_SPEED = 0.012; // rad per pixel dragged
const CREW_SPACING = 0.95; // m between friends standing in the lobby
const HEAD_HEIGHT = 1.98;  // m: where their name tag goes
const CREW_MIN_DIST = 5.4; // m: far enough back that the name tags fit above their heads
const _head = new THREE.Vector3();

export class CharacterPreview {
  /** canvas: the element to draw into. */
  constructor(canvas) {
    this.canvas = canvas;
    this.ready = false;
    this.yaw = -0.45;       // three-quarter view, like the reference screens
    this._size = [0, 0];
    this._drag = null;
    this.crew = [];         // friends standing with you in the lobby: [Soldier]
    this.layoutVersion = 0; // changes whenever someone's place on screen does

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
    const floor = this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
    scene.add(floor);
    this._floors = [floor];

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

  /** Friends who stand with you (Soldiers already loaded); [] puts you back on your own. */
  setCrew(soldiers) {
    if (!this.ready) return;
    for (const s of this.crew) if (!soldiers.includes(s)) this.scene.remove(s.root);
    this.crew = soldiers;
    // A shallow arc, you in the middle (left of the middle with an even number)
    const n = soldiers.length + 1, me = Math.floor((n - 1) / 2);
    const everyone = [...soldiers.slice(0, me), this.soldier, ...soldiers.slice(me)];
    while (this._floors.length < n) {
      const f = this.floor.clone();
      this.scene.add(f);
      this._floors.push(f);
    }
    this._floors.forEach((f, i) => { f.visible = i < n; });
    everyone.forEach((s, i) => {
      const off = i - (n - 1) / 2;
      const x = off * CREW_SPACING, z = -Math.abs(off) * 0.28;
      if (s.root.parent !== this.scene) this.scene.add(s.root);
      s.root.position.set(x, 0, z);
      s.root.rotation.y = s === this.soldier ? this.yaw : -off * 0.22;
      this._floors[i].position.set(x, 0, z);
    });
    this._span = n > 1 ? (n - 1) * CREW_SPACING + 1 : 0;
    this._frame();
  }

  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h || (w === this._size[0] && h === this._size[1])) return;
    this._size = [w, h];
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this._frame();
  }

  /** Keeps everyone in frame in tall or wide boxes. */
  _frame() {
    const a = this.camera.aspect;
    const alone = Math.max(4.2, 3.4 / Math.min(1, a * 1.6));
    const fit = this._span ? (this._span / 2) / (Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * a) + 0.6 : 0;
    this.camera.position.z = this._span ? Math.max(alone, fit, CREW_MIN_DIST) : alone;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.layoutVersion++;
  }

  /** Where a soldier's head is on the canvas: { x, y }, each 0..1 from the top left. */
  headOnScreen(soldier) {
    _head.set(soldier.root.position.x, HEAD_HEIGHT, soldier.root.position.z).project(this.camera);
    return { x: (_head.x + 1) / 2, y: (1 - _head.y) / 2 };
  }

  _pose(dt) {
    this.soldier.root.rotation.y = this.yaw;
    this._still(this.soldier, dt);
    for (const s of this.crew) this._still(s, dt);
  }

  _still(s, dt) {
    s.root.updateWorldMatrix(true, false);
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
