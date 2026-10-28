import * as THREE from "three";

// A few real point lights shared by every light-making thing in the game.
//
// Each point light in the scene is compiled into every lit shader and costs
// every lit pixel, even at intensity 0 (three.js's forward renderer loops
// over all of them). The muzzle flash, grenade blasts, molotov fires, the
// burning wreck, house lamps and cave torches used to own one or more each:
// up to 9 on Medium. Now they own *virtual* lights (ordinary PointLights
// kept out of the scene, driven exactly as before) and adopt() them here;
// once a frame update() copies the ones that matter most (priority, how
// bright, how close to the camera) into SIZE real lights. Fewer lights: every
// lit shader compiles faster at load and shades cheaper every frame.

export class LightPool {
  constructor() {
    this.real = [];
    this.virtual = [];   // { light, priority }
    this._pick = [];
    this._score = [];
  }

  /** Creates the real lights (call once, before anything compiles). */
  attach(scene, size) {
    for (let i = 0; i < size; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 1.5);
      l.position.set(0, -500, 0);
      scene.add(l);
      this.real.push(l);
    }
    return this;
  }

  /**
   * Registers a module's own light (instead of adding it to the scene).
   * priority: how much it matters when lights run short (blast 3 … house lamp 1).
   */
  adopt(light, priority = 1) {
    light.parent?.remove(light);
    this.virtual.push({ light, priority });
    return light;
  }

  /** Every frame, after the modules have set their lights: the best ones go to the real lights. */
  update(cx, cy, cz) {
    const pick = this._pick, score = this._score, n = this.real.length;
    pick.length = 0; score.length = 0;
    for (const v of this.virtual) {
      const l = v.light;
      if (!(l.intensity > 0.001)) continue;
      const dx = l.position.x - cx, dy = l.position.y - cy, dz = l.position.z - cz;
      const reach = l.distance || 20;
      const s = v.priority * Math.min(1, l.intensity) / (1 + (dx * dx + dy * dy + dz * dz) / (reach * reach));
      // Keep the n best (n is tiny: insertion into a sorted short list)
      let i = pick.length;
      if (i === n && s <= score[n - 1]) continue;
      if (i < n) { pick.push(l); score.push(s); }
      else i = n - 1;
      while (i > 0 && score[i - 1] < s) { pick[i] = pick[i - 1]; score[i] = score[i - 1]; i--; }
      pick[i] = l; score[i] = s;
    }
    for (let i = 0; i < n; i++) {
      const r = this.real[i], src = pick[i];
      if (!src) { if (r.intensity !== 0) r.intensity = 0; continue; }
      r.position.copy(src.position);
      r.color.copy(src.color);
      r.intensity = src.intensity;
      r.distance = src.distance;
      r.decay = src.decay;
    }
  }
}

export const lightPool = new LightPool();
