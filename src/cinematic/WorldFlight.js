import * as THREE from "three";
import { cloudTexture } from "./Cosmos.js";

// Scene 07: down through the clouds onto the real game map, and a drone
// flyover. This drives the GAME's own camera over the GAME's own scene (main.js
// renders it as always); nothing here is a stand-in. The path is a Catmull-Rom
// spline through points main.js picks from the world (the city, the river, the
// crossroads, the college gate, the CSE building), eased so it accelerates out
// of the descent and settles at the end, banking into its turns, never lower
// than CLEAR m above the ground. For the high shots the world's draw distance,
// far plane and fog are opened up (and put back by end()).

const CLEAR = 16;

export class WorldFlight {
  /**
   * world: { scene, camera, groundHeight(x, z), chunks, env, fog }
   * path: [{ p: [x, h, z], look: [x, h, z] }, …] (h: metres above the ground, for both)
   */
  constructor({ world, path, lite = false }) {
    this.w = world;
    this.lite = lite;
    const pos = path.map(k => new THREE.Vector3(k.p[0], world.groundHeight(k.p[0], k.p[2]) + k.p[1], k.p[2]));
    const look = path.map(k => new THREE.Vector3(k.look[0], world.groundHeight(k.look[0], k.look[2]) + (k.look[1] ?? 0), k.look[2]));
    this.pos = new THREE.CatmullRomCurve3(pos, false, "centripetal");
    this.look = new THREE.CatmullRomCurve3(look, false, "centripetal");
    this.roll = 0;
    this._p = new THREE.Vector3();
    this._l = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
  }

  begin() {
    const { scene, camera, chunks, env } = this.w;
    this.saved = {
      far: camera.far, fov: camera.fov, fogNear: scene.fog.near, fogFar: scene.fog.far, range: chunks.range,
      hour: env.hour, up: camera.up.clone(),
    };
    chunks.range = this.lite ? 900 : 1500;
    chunks.update(0, 0, 0, true);
    camera.far = 4500;
    camera.updateProjectionMatrix();
    // The clouds it falls through
    const tex = this.cloudTex = cloudTexture();
    this.clouds = new THREE.Group();
    const start = this.pos.getPointAt(0);
    const n = this.lite ? 22 : 40;
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.55, fog: false }));
      const a = Math.random() * Math.PI * 2, r = 60 + Math.sqrt(Math.random()) * 420;
      s.position.set(start.x + Math.cos(a) * r, start.y - 40 - Math.random() * 200, start.z + Math.sin(a) * r);
      s.scale.setScalar(70 + Math.random() * 110);
      this.clouds.add(s);
    }
    scene.add(this.clouds);
  }

  /** k: 0..1 through the flight. Returns the camera's speed (m/s) for motion blur. */
  update(k, dt) {
    const { camera, groundHeight, scene } = this.w;
    // Fast out of the clouds, steady over the island, a long gentle settle at the end
    const e = k < 0.5 ? 0.5 * Math.pow(2 * k, 1.35) : 1 - 0.5 * Math.pow(2 * (1 - k), 2.2);
    const u = Math.min(1, Math.max(0, e));
    this.pos.getPointAt(u, this._p);
    this.look.getPointAt(Math.min(1, u + 0.01), this._l);
    const minY = groundHeight(this._p.x, this._p.z) + CLEAR;
    if (this._p.y < minY) this._p.y = minY;
    const moved = camera.position.distanceTo(this._p);
    camera.position.copy(this._p);
    camera.up.set(0, 1, 0);
    camera.lookAt(this._l);
    // Bank into the turns (from how fast the heading is changing)
    const t0 = this.pos.getTangentAt(Math.max(0, u - 0.01), this._a), t1 = this.pos.getTangentAt(Math.min(1, u + 0.01), this._b);
    const turn = Math.atan2(t0.x * t1.z - t0.z * t1.x, t0.x * t1.x + t0.z * t1.z);
    const want = THREE.MathUtils.clamp(-turn * 6, -0.22, 0.22);
    this.roll += (want - this.roll) * Math.min(1, dt * 2.5);
    camera.rotateZ(this.roll);
    camera.fov = THREE.MathUtils.lerp(62, 48, u);
    camera.updateProjectionMatrix();
    // Haze: far and thin up high, the game's own close to the ground
    const alt = this._p.y - groundHeight(this._p.x, this._p.z);
    const hi = THREE.MathUtils.smoothstep(alt, 60, 500);
    // (up high the haze also hides the far edge of the sea)
    scene.fog.near = THREE.MathUtils.lerp(260, 420, hi);
    scene.fog.far = THREE.MathUtils.lerp(1300, 1500, hi);
    // The clouds thin out once it's through them
    if (this.clouds) {
      const o = THREE.MathUtils.smoothstep(alt, 160, 380);
      for (const s of this.clouds.children) s.material.opacity = 0.55 * o;
      this.clouds.visible = o > 0.01;
    }
    this.w.chunks.update(dt, this._p.x, this._p.z);
    return dt > 0 ? moved / dt : 0;
  }

  /** Where the flight ended: the title holds here with a slow drift. */
  hold(t, dt) {
    const { camera } = this.w;
    this.pos.getPointAt(1, this._p);
    this.look.getPointAt(1, this._l);
    // A slow push in and a touch of rise
    const k = Math.min(1, t / 14);
    camera.position.copy(this._p).lerp(this._l, 0.05 * k);
    camera.position.y += 1.5 * k;
    camera.up.set(0, 1, 0);
    camera.lookAt(this._l);
    this.roll *= Math.max(0, 1 - dt * 2);
    camera.rotateZ(this.roll);
  }

  end() {
    const { scene, camera, chunks, env } = this.w;
    if (this.clouds) {
      scene.remove(this.clouds);
      for (const s of this.clouds.children) s.material.dispose();
      this.cloudTex.dispose();
      this.clouds = null;
    }
    if (!this.saved) return;
    camera.far = this.saved.far;
    camera.fov = this.saved.fov;
    camera.up.copy(this.saved.up);
    camera.updateProjectionMatrix();
    scene.fog.near = this.saved.fogNear;
    scene.fog.far = this.saved.fogFar;
    chunks.range = this.saved.range;
    env.hour = this.saved.hour;
    this.saved = null;
  }
}
