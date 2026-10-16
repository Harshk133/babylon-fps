import * as THREE from "three";
import * as CANNON from "cannon-es";
import { groundHeight } from "../world/Terrain.js";
import { GROUP_VEHICLE } from "../physicsGroups.js";

// The drivable auto-rickshaw. Arcade handling (bicycle-model steering, no
// wheel physics): it follows the terrain by sampling the ground under its
// three wheels, and is stopped by anything on the obstacle list (houses,
// trees, boulders). A kinematic box carries it in the physics world, so it
// shoves monsters and players aside (bullets pass through: it's open-sided).
//
// It runs on petrol: driving burns fuel, and an empty tank won't move. Petrol
// cans top it up. At night the headlight comes on while someone drives.
//
// In co-op / battle royale the driver simulates it and streams the pose; the
// others smooth toward it (setRemote).

export const RICKSHAW = {
  length: 2.7,          // metres, nose to tail
  maxSpeed: 15,         // m/s (~54 km/h)
  reverseSpeed: 5,
  accel: 5.5,
  brake: 13,
  coast: 1.4,           // deceleration with no throttle
  maxSteer: 0.6,        // rad
  wheelBase: 1.75,
  fuelMax: 100,
  fuelStart: 35,
  burn: 0.85,           // fuel/s at full throttle
  idleBurn: 0.05,       // fuel/s with the engine running
  enterRange: 3.2,
  canFuel: 50,          // one petrol can
  headlight: 130,       // spot intensity
};

// Local frame: +z forward, +x left, y up; origin on the ground at the centre
const SEAT = new THREE.Vector3(0, 0.66, 0.38);       // driver's hips
const LAMP = new THREE.Vector3(0, 0.98, 1.3);
const WHEEL_FRONT = 1.0, WHEEL_REAR = -0.78, TRACK = 0.62;
const HIT_CIRCLES = [-0.85, 0, 0.85];                 // collision probes along the length
const HIT_RADIUS = 0.72;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, "YXZ");

export class Rickshaw {
  /** gltf: the loaded autorickshaw; spawn: { x, z, yaw }. */
  constructor({ scene, world, gltf, material, spawn }) {
    this.spawn = spawn;
    this.root = new THREE.Group();
    this.root.rotation.order = "YXZ";
    scene.add(this.root);

    // The model is 1 unit long along +x with the nose at +x: turn it to face +z and size it
    const model = gltf.scene;
    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const holder = new THREE.Group();
    holder.add(model);
    model.rotation.y = -Math.PI / 2;
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(new THREE.Vector3());
    const s = RICKSHAW.length / (size.z || 1);
    const c = box.getCenter(new THREE.Vector3());
    // Centred on x/z, wheels on the ground
    holder.scale.setScalar(s);
    holder.position.set(-c.x * s, -box.min.y * s, -c.z * s);
    this.root.add(holder);
    this.height = size.y * s;

    // Headlight: always in the scene (intensity 0 when off) so switching it never recompiles shaders
    this.light = new THREE.SpotLight(0xffe6b8, 0, 48, 0.5, 0.5, 1.3);
    this.light.position.copy(LAMP);
    this.light.target.position.set(0, 0.1, 14);
    this.light.castShadow = false;
    this.root.add(this.light, this.light.target);
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0x444033, emissive: 0xfff0c8, emissiveIntensity: 0 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 8), this.lampMat);
    lamp.position.copy(LAMP).add(_v.set(0, 0, 0.04));
    this.root.add(lamp);
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2010, emissiveIntensity: 0 });
    for (const x of [-0.45, 0.45]) {
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.03), this.tailMat);
      tail.position.set(x, 0.5, -1.36);
      this.root.add(tail);
    }

    this.body = new CANNON.Body({
      mass: 0, type: CANNON.Body.KINEMATIC, material,
      collisionFilterGroup: GROUP_VEHICLE,
    });
    this.body.addShape(new CANNON.Box(new CANNON.Vec3(0.66, 0.8, 1.3)), new CANNON.Vec3(0, 0.85, 0));
    this.body.vehicle = this;
    world.addBody(this.body);

    // Footprint for the minimap (and skipped by our own collision test)
    const self = this;
    this.footprint = {
      type: "box", vehicle: true, w: 1.4, d: RICKSHAW.length,
      get x() { return self.x; }, get z() { return self.z; }, get rot() { return self.yaw; },
    };

    this.driver = null;        // null, "local", or a remote player id
    this.lightLevel = 0;
    this.throttle = 0;
    this.reset();
  }

  reset() {
    this.x = this.spawn.x;
    this.z = this.spawn.z;
    this.yaw = this.spawn.yaw;
    this.speed = 0;
    this.steer = 0;
    this.yawRate = 0;
    this.fuel = RICKSHAW.fuelStart;
    this.driver = null;
    this.throttle = 0;
    this.remote = null;
    this._pose(0);
  }

  get empty() { return this.fuel <= 0; }

  /** Ground pose from the three wheels: height, pitch and roll. */
  _pose(delta) {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const fx = sy, fz = cy;          // forward
    const lx = cy, lz = -sy;         // left
    const hF = groundHeight(this.x + fx * WHEEL_FRONT, this.z + fz * WHEEL_FRONT);
    const hL = groundHeight(this.x + fx * WHEEL_REAR + lx * TRACK, this.z + fz * WHEEL_REAR + lz * TRACK);
    const hR = groundHeight(this.x + fx * WHEEL_REAR - lx * TRACK, this.z + fz * WHEEL_REAR - lz * TRACK);
    const rear = (hL + hR) / 2;
    const pitch = Math.atan2(hF - rear, WHEEL_FRONT - WHEEL_REAR);
    const roll = Math.atan2(hL - hR, TRACK * 2);
    const y = rear + (hF - rear) * (-WHEEL_REAR / (WHEEL_FRONT - WHEEL_REAR));
    if (delta > 0) {
      // A little suspension: ease into the new pose
      const k = 1 - Math.exp(-14 * delta);
      this.y += (y - this.y) * k;
      this.pitch += (pitch - this.pitch) * k;
      this.roll += (roll - this.roll) * k;
    } else {
      this.y = y; this.pitch = pitch; this.roll = roll;
    }
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.set(-this.pitch, this.yaw, this.roll);
  }

  /**
   * Local driving. input: { throttle −1..1, steer −1..1 (+ = left), handbrake }.
   * blocked(x, z, r): true if a circle there hits something solid.
   * Returns the speed lost in a crash (0 if none).
   */
  drive(delta, input, blocked) {
    const R = RICKSHAW;
    const t = this.fuel > 0 ? input.throttle : 0;
    this.throttle = Math.abs(t);
    let v = this.speed;
    if (t > 0) {
      if (v < -0.3) v += R.brake * delta;
      else v += R.accel * t * delta * (1 - Math.max(0, v) / R.maxSpeed);
    } else if (t < 0) {
      if (v > 0.3) v -= R.brake * delta;
      else v = Math.max(-R.reverseSpeed, v - R.accel * 0.6 * delta);
    } else {
      v -= Math.sign(v) * Math.min(Math.abs(v), R.coast * delta);
    }
    if (input.handbrake) v -= Math.sign(v) * Math.min(Math.abs(v), R.brake * 1.4 * delta);
    // Hills: slows you going up, speeds you up coming down
    v -= Math.sin(this.pitch) * 9.8 * 0.55 * delta;
    v = Math.max(-R.reverseSpeed, Math.min(R.maxSpeed, v));

    const steerTarget = input.steer * R.maxSteer * (1 - 0.5 * Math.min(1, Math.abs(v) / R.maxSpeed));
    this.steer += (steerTarget - this.steer) * (1 - Math.exp(-7 * delta));
    const yawRate = (v * Math.tan(this.steer)) / R.wheelBase;
    const yaw = this.yaw + yawRate * delta;
    const nx = this.x + Math.sin(yaw) * v * delta;
    const nz = this.z + Math.cos(yaw) * v * delta;

    let crash = 0;
    if (this._blockedAt(nx, nz, yaw, blocked)) {
      crash = Math.abs(v);
      this.speed = -v * 0.25; // bounce back a little
      this.yawRate = 0;
    } else {
      this.x = nx; this.z = nz; this.yaw = yaw;
      this.speed = v;
      this.yawRate = yawRate;
    }
    // Petrol: idling sips, throttle gulps
    if (this.fuel > 0) {
      this.fuel = Math.max(0, this.fuel - (R.idleBurn + R.burn * this.throttle * (0.5 + 0.5 * Math.abs(v) / R.maxSpeed)) * delta);
    }
    return crash;
  }

  _blockedAt(x, z, yaw, blocked) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    for (const o of HIT_CIRCLES) if (blocked(x + sy * o, z + cy * o, HIT_RADIUS)) return true;
    return false;
  }

  /** Someone else is driving: their latest pose. */
  setRemote(id, x, z, yaw, speed, fuel) {
    if (this.driver !== id) {
      this.driver = id;
      if (!this.remote) { this.x = x; this.z = z; this.yaw = yaw; }
    }
    this.remote = { x, z, yaw, speed, age: 0 };
    this.fuel = fuel;
  }

  /** The remote driver got out (or left): park where it is. */
  releaseRemote() {
    this.driver = null;
    this.remote = null;
    this.speed = 0;
    this.yawRate = 0;
  }

  /**
   * Every frame, after drive() / setRemote(). Places the model and the
   * collider, and runs the lights. darkness: 0 day … 1 night.
   */
  update(delta, darkness) {
    const r = this.remote;
    if (r && this.driver !== "local") {
      // Dead-reckon between packets, then ease toward it
      r.age += delta;
      if (r.age < 0.3) { r.x += Math.sin(r.yaw) * r.speed * delta; r.z += Math.cos(r.yaw) * r.speed * delta; }
      const k = 1 - Math.exp(-12 * delta);
      const prevX = this.x, prevZ = this.z;
      this.x += (r.x - this.x) * k;
      this.z += (r.z - this.z) * k;
      let dy = (r.yaw - this.yaw) % (Math.PI * 2);
      if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * k;
      this.speed = delta > 0 ? Math.hypot(this.x - prevX, this.z - prevZ) / delta * Math.sign(r.speed || 1) : 0;
      this.throttle = Math.min(1, Math.abs(r.speed) / RICKSHAW.maxSpeed + 0.2);
    }
    this._pose(delta);

    // Collider follows; its velocity lets it push bodies it drives into
    const b = this.body;
    b.position.set(this.x, this.y, this.z);
    _q.setFromEuler(_e.set(-this.pitch, this.yaw, this.roll));
    b.quaternion.set(_q.x, _q.y, _q.z, _q.w);
    b.velocity.set(Math.sin(this.yaw) * this.speed, 0, Math.cos(this.yaw) * this.speed);
    b.angularVelocity.set(0, this.yawRate, 0);
    b.aabbNeedsUpdate = true;

    const on = this.driver !== null && this.fuel > 0;
    const want = on && darkness > 0.4 ? 1 : 0;
    this.lightLevel += (want - this.lightLevel) * (1 - Math.exp(-8 * delta));
    this.light.intensity = RICKSHAW.headlight * this.lightLevel;
    this.lampMat.emissiveIntensity = 0.3 * (on ? 1 : 0) + 3 * this.lightLevel;
    this.tailMat.emissiveIntensity = 1.5 * this.lightLevel;
  }

  /** World position of the driver's hips. */
  seatWorld(out) {
    this.root.updateMatrixWorld();
    return out.copy(SEAT).applyMatrix4(this.root.matrixWorld);
  }

  distanceTo(x, z) { return Math.hypot(this.x - x, this.z - z); }

  /** A free spot next to the rickshaw to step out to: left side, right side, then behind. */
  exitSpot(blocked, out) {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const spots = [[cy * 1.5, -sy * 1.5], [-cy * 1.5, sy * 1.5], [-sy * 2.2, -cy * 2.2], [sy * 2.4, cy * 2.4]];
    for (const [dx, dz] of spots) {
      if (!blocked(this.x + dx, this.z + dz, 0.45)) { out.x = this.x + dx; out.z = this.z + dz; return out; }
    }
    out.x = this.x + spots[0][0]; out.z = this.z + spots[0][1];
    return out;
  }
}
