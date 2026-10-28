import * as THREE from "three";
import * as CANNON from "cannon-es";
import { groundHeight } from "../world/Terrain.js";
import { GROUP_VEHICLE } from "../physicsGroups.js";
import { mergeStaticMeshes } from "../world/MergeStatic.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Drivable vehicles: the auto-rickshaw, the Mahindra Thar and a tractor. Arcade handling
// (bicycle-model steering, no wheel physics): a vehicle follows the terrain by
// sampling the ground under its wheels, and is stopped by anything on the
// obstacle list (houses, trees, boulders). A kinematic box carries it in the
// physics world, so it shoves monsters and players aside (bullets pass
// through: the driver can be shot).
//
// They run on petrol: driving burns fuel, and an empty tank won't move. Petrol
// cans top it up. At night the headlights come on while someone drives.
//
// In co-op / battle royale the driver simulates it and streams the pose; the
// others smooth toward it (setRemote).

/**
 * Per-kind handling and layout. Local frame: +z forward, +x left, y up; origin
 * on the ground at the centre. seat: the driver's hips. lamps / tails:
 * headlight and tail-light spots. wheels: front / rear axle z and half track.
 * hits: collision probe circles along the length (z) and their radius.
 * box: collider half extents [x, y, z] and centre height. modelYaw: turn that
 * points the loaded model's nose at +z. tone: engine pitch (Sfx.setRickshaw).
 * grip: sideways grip on asphalt (x g; the surface scales it, see drive()).
 * slide: how fast it breaks into a slide past the grip. steerRate: how quickly
 * the wheel turns. dust: puffs per m/s per wheel on loose ground (emitDust).
 * spin: wheels built and spun by the vehicle itself [x, z, radius, width, front].
 */
export const VEHICLES = {
  rickshaw: {
    label: "auto-rickshaw",
    length: 2.7, width: 1.4,
    maxSpeed: 15,         // m/s (~54 km/h)
    reverseSpeed: 5, accel: 5.5, brake: 13, coast: 1.4,
    maxSteer: 0.6, wheelBase: 1.75,
    fuelMax: 100, fuelStart: 35, burn: 0.85, idleBurn: 0.05, canFuel: 50,
    enterRange: 3.2, headlight: 130,
    seat: [0, 0.66, 0.38],
    lamps: [[0, 0.98, 1.3]],
    tails: [[-0.45, 0.5, -1.36], [0.45, 0.5, -1.36]],
    wheels: { front: 1.0, rear: -0.78, track: 0.62 },
    hits: { z: [-0.85, 0, 0.85], r: 0.72 },
    box: [0.66, 0.8, 1.3, 0.85],
    modelYaw: Math.PI,           // the Sketchfab tuk-tuk (public/models/india/autorickshaw.glb) faces −Z
    runOver: 5, tone: 1,
    grip: 0.8, slide: 0.12, steerRate: 7, dust: 1.0,
  },
  thar: {
    label: "Thar",
    length: 4.43, width: 2.1,   // the real Thar Roxx: 4.43 m long, 1.92 m tall
    maxSpeed: 24,         // m/s (~86 km/h)
    reverseSpeed: 7, accel: 7.5, brake: 16, coast: 1.6,
    maxSteer: 0.55, wheelBase: 2.71,
    fuelMax: 100, fuelStart: 55, burn: 1.1, idleBurn: 0.06, canFuel: 40,
    enterRange: 4.21, headlight: 170,
    seat: [-0.47, 1.05, 0.06],   // right-hand drive
    lamps: [[0.69, 1.13, 2.19], [-0.69, 1.13, 2.19]],
    tails: [[0.89, 1.05, -2.24], [-0.89, 1.05, -2.24]],
    wheels: { front: 1.44, rear: -1.31, track: 0.91 },
    hits: { z: [-1.5, 0, 1.5], r: 1.11 },
    box: [1.05, 1.05, 2.21, 1.11],
    modelYaw: Math.PI / 2,       // the Sketchfab Thar Roxx is modelled nose along −X
    runOver: 7, tone: 0.68,
    grip: 0.95, slide: 0.14, steerRate: 7, dust: 1.4,
  },
  tractor: {
    label: "tractor",
    length: 3.7, width: 1.95,
    maxSpeed: 11,         // m/s (~40 km/h): heavy and geared low
    reverseSpeed: 4, accel: 3.4, brake: 7.5, coast: 0.9,
    maxSteer: 0.62, wheelBase: 2.05,
    fuelMax: 100, fuelStart: 70, burn: 0.7, idleBurn: 0.05, canFuel: 45,
    enterRange: 3.6, headlight: 120,
    seat: [0, 1.38, -0.62],
    lamps: [[0.34, 1.22, 1.74], [-0.34, 1.22, 1.74]],
    tails: [[0.62, 1.12, -1.5], [-0.62, 1.12, -1.5]],
    wheels: { front: 1.2, rear: -0.85, track: 0.82 },
    hits: { z: [-1.05, 0, 1.15], r: 0.98 },
    box: [0.97, 0.95, 1.85, 1.0],
    runOver: 6, tone: 0.5,
    // Loose rear end: a sharp turn at speed on dirt swings the back out
    grip: 0.72, slide: 0.2, steerRate: 4, dust: 2.4,
    spin: [[0.86, -0.85, 0.78, 0.46, false], [-0.86, -0.85, 0.78, 0.46, false], [0.74, 1.2, 0.44, 0.28, true], [-0.74, 1.2, 0.44, 0.28, true]],
  },
};

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, "YXZ");

/** A plain low-poly jeep, used for the Thar until its model is in public/models/india/. */
export function standInJeep() {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0x2b3a2a, roughness: 0.6, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.8 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.2, metalness: 0.4 });
  const box = (w, h, d, x, y, z, m) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); g.add(o); };
  box(1.86, 0.62, 3.9, 0, 0.82, 0, paint);          // body
  box(1.8, 0.62, 2.1, 0, 1.43, -0.55, paint);       // cabin
  box(1.7, 0.5, 0.05, 0, 1.45, 0.52, glass);        // windscreen
  box(1.9, 0.18, 0.2, 0, 0.55, 2.0, dark);          // bumpers
  box(1.9, 0.18, 0.2, 0, 0.55, -2.0, dark);
  const wheel = new THREE.CylinderGeometry(0.4, 0.4, 0.32, 14).rotateZ(Math.PI / 2);
  for (const [x, z] of [[0.82, 1.3], [-0.82, 1.3], [0.82, -1.18], [-0.82, -1.18]]) {
    const w = new THREE.Mesh(wheel, dark); w.position.set(x, 0.4, z); g.add(w);
  }
  return g;
}

/**
 * A plain farm tractor (no brand): bonnet, cab frame, big rear wheels.
 * The wheels are not in it: VEHICLES.tractor.spin has the vehicle build and turn them.
 */
export function standInTractor() {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xb3261e, roughness: 0.55, metalness: 0.25 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x3a3c3e, roughness: 0.5, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1c1d, roughness: 0.85 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.9 });
  const box = (w, h, d, x, y, z, m) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); g.add(o); return o; };
  const cyl = (r, h, x, y, z, m, rotX = 0) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), m); o.position.set(x, y, z); o.rotation.x = rotX; g.add(o); return o; };
  box(0.78, 0.7, 1.75, 0, 1.0, 0.75, paint);            // bonnet
  box(0.8, 0.12, 1.8, 0, 1.4, 0.73, paint);              // its lid
  box(0.7, 0.45, 0.1, 0, 0.98, 1.66, dark);              // grille
  box(0.64, 0.5, 1.5, 0, 0.6, 0.55, metal);              // engine block / frame
  box(0.95, 0.6, 1.0, 0, 0.85, -0.55, metal);            // gearbox under the seat
  for (const sx of [-1, 1]) {
    box(0.5, 0.08, 1.3, 0.86 * sx, 1.62, -0.85, paint);  // rear mudguards
    box(0.06, 0.5, 1.3, 0.62 * sx, 1.36, -0.85, paint);
    box(0.06, 1.7, 0.08, 0.6 * sx, 2.25, -1.25, dark);   // roll frame posts
  }
  box(1.26, 0.08, 0.08, 0, 3.08, -1.25, dark);            // ...and its top bar
  box(1.4, 0.06, 1.25, 0, 3.12, -0.75, paint);            // sun canopy
  for (const sx of [-1, 1]) box(0.05, 0.05, 0.8, 0.6 * sx, 3.08, -0.85, dark);
  box(0.52, 0.12, 0.48, 0, 1.25, -0.62, seatMat);         // seat
  box(0.5, 0.45, 0.1, 0, 1.5, -0.88, seatMat);
  cyl(0.035, 0.55, 0, 1.55, -0.05, dark, -0.6);           // steering column
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.025, 6, 16), dark);
  wheel.position.set(0, 1.78, -0.2); wheel.rotation.x = -Math.PI / 2 + 0.6; g.add(wheel);
  cyl(0.05, 1.0, 0.28, 1.85, 1.15, metal);                // exhaust stack
  cyl(0.07, 0.14, 0.28, 2.38, 1.15, dark);
  box(1.6, 0.12, 0.12, 0, 0.55, 1.6, metal);              // front axle
  box(0.4, 0.14, 0.2, 0, 0.5, -1.62, metal);              // tow hitch
  return g;
}

const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 });
const rimMat = new THREE.MeshStandardMaterial({ color: 0xc8a020, roughness: 0.5, metalness: 0.4 });

/** A wheel the vehicle builds and turns itself (spec.spin): tyre, rim and lugs, merged. */
function spinWheel(r, w) {
  const parts = [new THREE.CylinderGeometry(r, r, w, 16).rotateZ(Math.PI / 2)];
  // Lugs, so you can see it turning
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    parts.push(new THREE.BoxGeometry(w * 1.02, 0.07, r * 0.32).rotateX(-a).translate(0, Math.cos(a) * r, Math.sin(a) * r));
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(mergeGeometries(parts.map(p => p.toNonIndexed()), false), tyreMat));
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 10).rotateZ(Math.PI / 2), rimMat));
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export class Vehicle {
  /**
   * kind: a VEHICLES key. model: THREE.Object3D (a loaded glTF scene, or
   * standInJeep()). spawn: { x, z, yaw }. index: its place in the world's
   * vehicle list (sent over the network). modelYaw: overrides the spec's (a
   * different model of the same vehicle).
   */
  constructor({ scene, world, kind, model, material, spawn, index = 0, standIn = false, modelYaw = null }) {
    this.kind = kind;
    this.spec = VEHICLES[kind];
    this.index = index;
    this.spawn = spawn;
    const S = this.spec;
    this.root = new THREE.Group();
    this.root.rotation.order = "YXZ";
    scene.add(this.root);

    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const holder = new THREE.Group();
    holder.add(model);
    if (!standIn) model.rotation.y = modelYaw ?? S.modelYaw;
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(new THREE.Vector3());
    const s = standIn ? 1 : S.length / (size.z || 1);
    const c = box.getCenter(new THREE.Vector3());
    // Centred on x/z, wheels on the ground
    holder.scale.setScalar(s);
    holder.position.set(-c.x * s, -box.min.y * s, -c.z * s);
    mergeStaticMeshes(holder); // one draw call per material, not per part
    this.root.add(holder);
    this.height = size.y * s;

    // Wheels the vehicle turns itself (steer group > spinning tyre)
    this.spinners = [];
    for (const [x, z, r, w, front] of S.spin ?? []) {
      const steer = new THREE.Group();
      steer.position.set(x, r, z);
      const tyre = spinWheel(r, w);
      steer.add(tyre);
      this.root.add(steer);
      this.spinners.push({ steer, tyre, r, front });
    }

    // Lamps just glow; the beam is a shared spotlight lent out by main.js (aimHeadlight),
    // since every light in the scene costs every pixel, lit or not
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0x444033, emissive: 0xfff0c8, emissiveIntensity: 0 });
    const lampGeo = new THREE.SphereGeometry(0.085, 12, 8);
    for (const p of S.lamps) {
      const lamp = new THREE.Mesh(lampGeo, this.lampMat);
      lamp.position.set(p[0], p[1], p[2] + 0.04);
      this.root.add(lamp);
    }
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2010, emissiveIntensity: 0 });
    const tailGeo = new THREE.BoxGeometry(0.1, 0.06, 0.03);
    for (const p of S.tails) {
      const tail = new THREE.Mesh(tailGeo, this.tailMat);
      tail.position.set(p[0], p[1], p[2]);
      this.root.add(tail);
    }

    this.body = new CANNON.Body({
      mass: 0, type: CANNON.Body.KINEMATIC, material,
      collisionFilterGroup: GROUP_VEHICLE,
    });
    this.body.addShape(new CANNON.Box(new CANNON.Vec3(S.box[0], S.box[1], S.box[2])), new CANNON.Vec3(0, S.box[3], 0));
    this.body.vehicle = this;
    world.addBody(this.body);

    // Footprint for the minimap (and skipped by our own collision test)
    const self = this;
    this.footprint = {
      type: "box", vehicle: true, w: S.width, d: S.length,
      get x() { return self.x; }, get z() { return self.z; }, get rot() { return self.yaw; },
    };

    this.seat = new THREE.Vector3(...S.seat);
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
    this.slip = 0;            // m/s sideways (+ = to the left): the slide
    this.skid = 0;            // how hard it's sliding (dust, tyre smoke)
    this._dust = 0;
    this.fuel = this.spec.fuelStart;
    this.driver = null;
    this.throttle = 0;
    this.remote = null;
    this._pose(0);
    this._settle = 0.5; // the next update places the collider
  }

  get empty() { return this.fuel <= 0; }

  /** Ground pose from the wheels: height, pitch and roll. */
  _pose(delta) {
    const { front, rear: back, track } = this.spec.wheels;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const fx = sy, fz = cy;          // forward
    const lx = cy, lz = -sy;         // left
    const hF = groundHeight(this.x + fx * front, this.z + fz * front);
    const hL = groundHeight(this.x + fx * back + lx * track, this.z + fz * back + lz * track);
    const hR = groundHeight(this.x + fx * back - lx * track, this.z + fz * back - lz * track);
    const rear = (hL + hR) / 2;
    const pitch = Math.atan2(hF - rear, front - back);
    // Leans out of a slide (a little body roll you can feel)
    const roll = Math.atan2(hL - hR, track * 2) - this.slip * 0.035;
    const y = rear + (hF - rear) * (-back / (front - back));
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
   * Local driving. input: { throttle −1..1, steer −1..1 (+ = left), handbrake,
   * grip: surface grip ×, 1 on asphalt (dirt, sand and water are lower) }.
   * blocked(x, z, r): true if a circle there hits something solid.
   * Returns the speed lost in a crash (0 if none).
   *
   * Steering is a bicycle model. When a turn asks for more sideways force than
   * the tyres have (spec.grip × surface × g), the difference pushes the
   * vehicle outward as `slip`, which the tyres then scrub off: a drift. The
   * handbrake loosens the grip and lets the back step out.
   */
  drive(delta, input, blocked) {
    const R = this.spec;
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
    this.steer += (steerTarget - this.steer) * (1 - Math.exp(-(R.steerRate ?? 7) * delta));
    const grip = (R.grip ?? 0.9) * (input.grip ?? 1) * (input.handbrake ? 0.5 : 1);
    let yawRate = (v * Math.tan(this.steer)) / R.wheelBase;
    // Sliding: the turn wants v·ω of sideways acceleration, the tyres give grip·g
    const want = v * yawRate, have = grip * 9.8;
    if (Math.abs(want) > have) {
      this.slip -= Math.sign(want) * (Math.abs(want) - have) * (R.slide ?? 0.15) * delta;
      if (input.handbrake) yawRate *= 1.15;
    }
    this.slip *= Math.exp(-grip * 2.6 * delta);
    if (Math.abs(this.slip) < 0.01) this.slip = 0;
    this.skid = Math.abs(this.slip);
    const yaw = this.yaw + yawRate * delta;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const nx = this.x + (sy * v + cy * this.slip) * delta;
    const nz = this.z + (cy * v - sy * this.slip) * delta;

    let crash = 0;
    // Already wedged into something (parked, spawned or synced there): let it drive out, or it would never move again
    const wedged = this._blockedAt(this.x, this.z, this.yaw, blocked);
    if (!wedged && this._blockedAt(nx, nz, yaw, blocked)) {
      crash = Math.abs(v);
      this.speed = -v * 0.25; // bounce back a little
      this.yawRate = 0;
      this.slip = 0;
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
    const { z: probes, r } = this.spec.hits;
    for (const o of probes) if (blocked(x + sy * o, z + cy * o, r, this)) return true;
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
      this.throttle = Math.min(1, Math.abs(r.speed) / this.spec.maxSpeed + 0.2);
    }
    // A parked vehicle nobody touches doesn't need re-posing every frame
    const moving = this.driver !== null || this._settle > 0;
    if (moving) {
      this._pose(delta);
      this._settle = this.driver !== null ? 0.5 : this._settle - delta;
    }

    if (moving) {
      // Collider follows; its velocity lets it push bodies it drives into
      const b = this.body;
      b.position.set(this.x, this.y, this.z);
      _q.setFromEuler(_e.set(-this.pitch, this.yaw, this.roll));
      b.quaternion.set(_q.x, _q.y, _q.z, _q.w);
      b.velocity.set(Math.sin(this.yaw) * this.speed, 0, Math.cos(this.yaw) * this.speed);
      b.angularVelocity.set(0, this.yawRate, 0);
      b.aabbNeedsUpdate = true;
    }

    for (const w of this.spinners) {
      w.tyre.rotation.x += (this.speed / w.r) * delta;
      if (w.front) w.steer.rotation.y = this.steer;
    }

    const on = this.driver !== null && this.fuel > 0;
    const want = on && darkness > 0.4 ? 1 : 0;
    if (want || this.lightLevel > 0.001) {
      this.lightLevel += (want - this.lightLevel) * (1 - Math.exp(-8 * delta));
      if (!want && this.lightLevel < 0.002) this.lightLevel = 0;
    }
    this.lampMat.emissiveIntensity = 0.3 * (on ? 1 : 0) + 3 * this.lightLevel;
    this.tailMat.emissiveIntensity = 1.5 * this.lightLevel;
  }

  /** Points a (shared) spotlight out of this vehicle's lamps, at its current brightness. */
  aimHeadlight(light) {
    const [, y, z] = this.spec.lamps[0];
    this.root.updateMatrixWorld();
    light.position.set(0, y, z).applyMatrix4(this.root.matrixWorld);
    light.target.position.set(0, 0.1, z + 14).applyMatrix4(this.root.matrixWorld);
    light.target.updateMatrixWorld();
    light.intensity = this.spec.headlight * this.lightLevel;
  }

  /**
   * Dust behind the rear wheels. fx: DustFX. surface: { amount: 0 (asphalt)
   * ... 1 (loose dirt), color, smoke } (DUST colours). Faster and sliding means
   * more; on asphalt only a slide makes (tyre) smoke. Capped per frame.
   */
  emitDust(fx, delta, surface) {
    const sp = Math.abs(this.speed);
    const R = this.spec;
    const rate = Math.max(0, sp - 1.2) * (R.dust ?? 1) * surface.amount + this.skid * (surface.amount > 0 ? 10 : 6);
    if (rate <= 0.05) { this._dust = 0; return; }
    this._dust = Math.min(6, this._dust + rate * 2 * delta);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const { rear, track } = R.wheels;
    const big = 0.7 + R.width * 0.25;
    while (this._dust >= 1) {
      this._dust -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = this.x + sy * (rear - 0.3) + cy * track * side;
      const z = this.z + cy * (rear - 0.3) - sy * track * side;
      const back = -0.3 * this.speed, out = (Math.random() - 0.5) * 1.6 - this.slip * 0.4;
      fx.emit(
        x, this.y + 0.25, z,
        sy * back + cy * out, 0.6 + Math.random() * 0.6, cy * back - sy * out,
        big * (0.8 + Math.random() * 0.5) * (1 + this.skid * 0.12),
        surface.amount > 0 ? surface.color : surface.smoke,
      );
    }
  }

  /** Re-pose and re-place the collider now (after a teleport: reset, a late joiner's world state). */
  place() {
    this._settle = 0.5;
  }

  /** World position of the driver's hips. */
  seatWorld(out) {
    this.root.updateMatrixWorld();
    return out.copy(this.seat).applyMatrix4(this.root.matrixWorld);
  }

  distanceTo(x, z) { return Math.hypot(this.x - x, this.z - z); }

  /** A free spot next to the vehicle to step out to: driver's side, the other side, then behind. */
  exitSpot(blocked, out) {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const side = this.spec.width / 2 + 0.8, back = this.spec.length / 2 + 0.9;
    const first = this.spec.seat[0] < 0 ? -1 : 1; // the driver's door
    const spots = [[cy * side * first, -sy * side * first], [-cy * side * first, sy * side * first], [-sy * back, -cy * back], [sy * (back + 0.2), cy * (back + 0.2)]];
    for (const [dx, dz] of spots) {
      if (!blocked(this.x + dx, this.z + dz, 0.45)) { out.x = this.x + dx; out.z = this.z + dz; return out; }
    }
    out.x = this.x + spots[0][0]; out.z = this.z + spots[0][1];
    return out;
  }
}
