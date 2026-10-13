import * as THREE from "three";
import * as CANNON from "cannon-es";
import { MD2Loader } from "three/addons/loaders/MD2Loader.js";
import { GROUP_ZOMBIE } from "../physicsGroups.js";

const POOL_HIDE_Y = -500;
const MD2_FPS = 10;

// The MD2 merges death1..3 / pain1..3 into single clips; split them back out
const SUBCLIPS = {
  death: [["death1", 0, 6], ["death2", 6, 12], ["death3", 12, 20]],
  pain:  [["pain1", 0, 4], ["pain2", 4, 8], ["pain3", 8, 12]],
};
const ONE_SHOT = new Set(["death1", "death2", "death3", "pain1", "pain2", "pain3"]);

function addCapsuleToBody(body, radius, height) {
  const hh = height / 2;
  const q = new CANNON.Quaternion();
  q.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI / 2);

  body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, -hh, 0));
  body.addShape(new CANNON.Cylinder(radius, radius, height, 12), new CANNON.Vec3(0, 0, 0), q);
  body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, hh, 0));
}

function makeCheckerTexture() {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const on = (((x >> 3) ^ (y >> 3)) & 1) === 0;
      data[i] = on ? 80 : 180;
      data[i + 1] = on ? 140 : 100;
      data[i + 2] = on ? 40 : 30;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

export class ZombiePool {
  constructor({ scene, world, monsterMaterial, targetHeight, mass, linDamping, angDamping }) {
    this.scene = scene;
    this.world = world;
    this.monsterMaterial = monsterMaterial;
    this.targetHeight = targetHeight;
    this.mass = mass;
    this.linDamping = linDamping;
    this.angDamping = angDamping;

    this.inactive = [];
    this.active = [];
    this.all = [];

    this.geometry = null;
    this.material = null;
    this.rawBB = null;
    this.rawHeight = 1;
    this.scaledHeight = targetHeight;
    this.bodyCentreY = targetHeight / 2;
    this.capRadius = 0;
    this.capHeight = 0;
  }

  async loadAssets() {
    const geometry = await new Promise((resolve, reject) => {
      new MD2Loader().load("/models/monster.md2", resolve, undefined, reject);
    });

    let skinTexture = await new Promise((resolve) => {
      new THREE.TextureLoader().load(
        "/texture/ratamahatta.png",
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          resolve(tex);
        },
        undefined,
        () => resolve(null)
      );
    });
    if (!skinTexture) skinTexture = makeCheckerTexture();

    this.geometry = geometry;
    this.material = new THREE.MeshLambertMaterial({ map: skinTexture });
    // Swapped in for a few frames when a bullet lands
    this.hitMaterial = new THREE.MeshLambertMaterial({
      map: skinTexture,
      emissive: new THREE.Color(0xff2a10),
      emissiveIntensity: 0.9,
    });

    this.clips = [];
    for (const clip of geometry.animations ?? []) {
      const parts = SUBCLIPS[clip.name];
      if (!parts) { this.clips.push(clip); continue; }
      for (const [name, start, end] of parts) {
        this.clips.push(THREE.AnimationUtils.subclip(clip, name, start, end, MD2_FPS));
      }
    }

    geometry.computeBoundingBox();
    this.rawBB = geometry.boundingBox;
    this.rawHeight = (this.rawBB.max.y - this.rawBB.min.y) || 1;

    const scale = this.targetHeight / this.rawHeight;
    this.scaledHeight = this.rawHeight * scale;
    this.bodyCentreY = this.scaledHeight / 2;
    this.capRadius = this.scaledHeight * 0.22;
    this.capHeight = Math.max(0.01, this.scaledHeight - this.capRadius * 2);
  }

  prewarm(count) {
    for (let i = 0; i < count; i++) {
      const zombie = this._createInstance(i);
      this._deactivate(zombie);
      this.inactive.push(zombie);
      this.all.push(zombie);
    }
  }

  acquire(x, z, { health = 100, maxHealth = 100 } = {}) {
    const zombie = this.inactive.pop();
    if (!zombie) return null;

    this._activate(zombie, x, z, health, maxHealth);
    this.active.push(zombie);
    return zombie;
  }

  release(zombie) {
    const idx = this.active.indexOf(zombie);
    if (idx >= 0) this.active.splice(idx, 1);

    this._deactivate(zombie);
    this.inactive.push(zombie);
  }

  _createInstance(id) {
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.rotation.y = -Math.PI / 2;
    mesh.position.y = -this.rawBB.min.y;

    const root = new THREE.Group();
    const initialScale = this.targetHeight / this.rawHeight;
    root.scale.setScalar(initialScale);
    root.add(mesh);
    this.scene.add(root);

    const body = new CANNON.Body({
      mass: this.mass,
      material: this.monsterMaterial,
      linearDamping: this.linDamping,
      angularDamping: this.angDamping,
      fixedRotation: true,
      allowSleep: true,
      collisionFilterGroup: GROUP_ZOMBIE,
    });
    addCapsuleToBody(body, this.capRadius, this.capHeight);
    body.position.set(0, POOL_HIDE_Y, 0);
    this.world.addBody(body);

    const actions = {};
    let mixer = null;
    if (this.clips.length > 0) {
      mixer = new THREE.AnimationMixer(mesh);
      for (const clip of this.clips) {
        const action = mixer.clipAction(clip);
        if (ONE_SHOT.has(clip.name)) {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        } else {
          action.setLoop(THREE.LoopRepeat, Infinity);
        }
        actions[clip.name] = action;
      }
      if (actions.attack) actions.attack.setEffectiveTimeScale(0.55);
      if (actions.run) actions.run.setEffectiveTimeScale(0.6);
      if (actions.stand) actions.stand.setEffectiveTimeScale(0.8);
    }

    const zombie = {
      id,
      active: false,
      health: 100,
      maxHealth: 100,
      root,
      mesh,
      mixer,
      actions,
      body,
      visualOffY: this.bodyCentreY,
      currentAnim: "stand",
      animLockTimer: 0,
      isChasing: false,
      isAttacker: false,
      attackTimer: 0,
      distXZ: 0,
      priority: 0,
      sepX: 0,
      sepZ: 0,
      aiTimer: 0,
      circleDir: 1,
      taunts: false,
      speedMul: 1,
      dying: false,
      dieTimer: 0,
      staggerTimer: 0,
      flashTimer: 0,
      rotY: 90,
    };
    body.zombie = zombie; // lets bullet raycasts map a hit body back to its zombie
    return zombie;
  }

  _resetAnimations(zombie) {
    for (const action of Object.values(zombie.actions)) {
      action.stop();
      action.reset();
    }
    zombie.currentAnim = "stand";
    zombie.animLockTimer = 0;
    const stand = zombie.actions.stand;
    if (stand) stand.play();
  }

  _activate(zombie, x, z, health, maxHealth) {
    zombie.active = true;
    zombie.health = health;
    zombie.maxHealth = maxHealth;
    zombie.isChasing = false;
    zombie.isAttacker = false;
    zombie.attackTimer = 0;
    zombie.aiTimer = 0;
    zombie.dying = false;
    zombie.dieTimer = 0;
    zombie.staggerTimer = 0;
    zombie.flashTimer = 0;
    zombie.mesh.material = this.material;
    zombie.body.collisionFilterGroup = GROUP_ZOMBIE;
    zombie.rotY = 90;

    this._resetAnimations(zombie);

    zombie.body.velocity.set(0, 0, 0);
    zombie.body.angularVelocity.set(0, 0, 0);
    zombie.body.position.set(x, zombie.visualOffY, z);
    zombie.body.wakeUp();

    zombie.root.visible = true;
    zombie.root.rotation.y = THREE.MathUtils.degToRad(zombie.rotY);
    zombie.root.position.set(x, 0, z);
  }

  _deactivate(zombie) {
    zombie.active = false;
    zombie.isChasing = false;
    zombie.isAttacker = false;
    zombie.health = 0;

    for (const action of Object.values(zombie.actions)) {
      action.stop();
      action.reset();
    }
    zombie.currentAnim = "stand";
    zombie.animLockTimer = 0;

    zombie.body.velocity.set(0, 0, 0);
    zombie.body.angularVelocity.set(0, 0, 0);
    zombie.body.position.set(0, POOL_HIDE_Y, 0);
    zombie.body.sleep();

    zombie.root.visible = false;
    zombie.root.position.set(0, POOL_HIDE_Y, 0);
  }
}
