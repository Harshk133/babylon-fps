import * as THREE from "three";

const TRACER_POOL     = 32;
const ENEMY_FLASHES   = 8;
const TRACER_LIFE     = 0.06;
const PARTICLE_COUNT  = 400;
const PARTICLE_HIDE_Y = -1000;
const FLASH_LIFE      = 0.05;
const FLAME_COUNT     = 200; // only the flying molotov rag uses these now
const BLAST_LIFE      = 0.35;

const BLOOD = [new THREE.Color(0x7a0606), new THREE.Color(0xa00d0d), new THREE.Color(0x4a0303)];
const DUST  = [new THREE.Color(0x8a7a5c), new THREE.Color(0x6b5c45), new THREE.Color(0xb5a27c)];
const SPARK = [new THREE.Color(0xffd27a), new THREE.Color(0xffa040)];

function makeFlashTexture() {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,230,1)");
  grad.addColorStop(0.25, "rgba(255,200,90,0.9)");
  grad.addColorStop(1, "rgba(255,120,20,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // A few spikes so it doesn't read as a plain blob
  g.globalCompositeOperation = "lighter";
  g.strokeStyle = "rgba(255,220,140,0.8)";
  g.lineWidth = 6;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    g.beginPath();
    g.moveTo(size / 2, size / 2);
    g.lineTo(size / 2 + Math.cos(a) * size * 0.48, size / 2 + Math.sin(a) * size * 0.48);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSoftTexture() {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Effects {
  constructor(scene) {
    // ── Muzzle flash: sprite + one persistent light (never added/removed → no shader recompiles)
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeFlashTexture(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    }));
    this.flash.visible = false;
    scene.add(this.flash);
    this.flashLight = new THREE.PointLight(0xffb060, 0, 7, 2);
    scene.add(this.flashLight);
    this.flashTimer = 0;

    // ── Tracers: unit-length boxes along +Z, scaled to the shot length
    const tracerGeo = new THREE.BoxGeometry(0.018, 0.018, 1);
    tracerGeo.translate(0, 0, 0.5);
    this.tracers = [];
    for (let i = 0; i < TRACER_POOL; i++) {
      const mesh = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({
        color: 0xffe0a0,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }));
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }
    this.tracerIndex = 0;

    // ── Particles: one Points object, CPU-integrated
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    for (let i = 0; i < PARTICLE_COUNT; i++) positions[i * 3 + 1] = PARTICLE_HIDE_Y;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.07,
      vertexColors: true,
      sizeAttenuation: true,
      depthWrite: false,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.pPos = positions;
    this.pCol = colors;
    this.pVel = new Float32Array(PARTICLE_COUNT * 3);
    this.pLife = new Float32Array(PARTICLE_COUNT);
    this.pNext = 0;
    this.pAlive = 0;

    // ── Flames: additive soft points that rise and cool from yellow to red to nothing.
    // Shared by molotov fires, flying molotov rags and grenade fireballs.
    const fPos = new Float32Array(FLAME_COUNT * 3);
    const fCol = new Float32Array(FLAME_COUNT * 3);
    for (let i = 0; i < FLAME_COUNT; i++) fPos[i * 3 + 1] = PARTICLE_HIDE_Y;
    const fGeo = new THREE.BufferGeometry();
    fGeo.setAttribute("position", new THREE.BufferAttribute(fPos, 3).setUsage(THREE.DynamicDrawUsage));
    fGeo.setAttribute("color", new THREE.BufferAttribute(fCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.flames = new THREE.Points(fGeo, new THREE.PointsMaterial({
      size: 0.6,
      map: makeSoftTexture(),
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }));
    this.flames.frustumCulled = false;
    scene.add(this.flames);
    this.fPos = fPos;
    this.fCol = fCol;
    this.fVel = new Float32Array(FLAME_COUNT * 3);
    this.fLife = new Float32Array(FLAME_COUNT);
    this.fMax = new Float32Array(FLAME_COUNT);
    this.fNext = 0;
    this.fAlive = false;

    // ── Explosion: big flash sprite + one persistent light
    this.blast = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.flash.material.map,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    }));
    this.blast.visible = false;
    scene.add(this.blast);
    // Enemy muzzle flashes: sprites only (no lights → no per-pixel cost)
    this.enemyFlashes = [];
    for (let i = 0; i < ENEMY_FLASHES; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flash.material.map, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
      }));
      s.visible = false;
      scene.add(s);
      this.enemyFlashes.push({ sprite: s, life: 0 });
    }
    this.enemyFlashIndex = 0;

    this.blastLight = new THREE.PointLight(0xff9a40, 0, 28, 1.6);
    scene.add(this.blastLight);
    this.blastTimer = 0;
  }

  flame(x, y, z, vx, vy, vz, life) {
    const i = this.fNext;
    this.fNext = (this.fNext + 1) % FLAME_COUNT;
    const i3 = i * 3;
    this.fPos[i3] = x;
    this.fPos[i3 + 1] = y;
    this.fPos[i3 + 2] = z;
    this.fVel[i3] = vx;
    this.fVel[i3 + 1] = vy;
    this.fVel[i3 + 2] = vz;
    this.fLife[i] = life;
    this.fMax[i] = life;
    this.fAlive = true;
  }

  enemyFlash(pos, color = 0xffb060) {
    const f = this.enemyFlashes[this.enemyFlashIndex];
    this.enemyFlashIndex = (this.enemyFlashIndex + 1) % ENEMY_FLASHES;
    f.sprite.position.copy(pos);
    f.sprite.material.color.setHex(color);
    f.sprite.material.rotation = Math.random() * Math.PI * 2;
    const s = 0.35 + Math.random() * 0.2;
    f.sprite.scale.set(s, s, s);
    f.sprite.visible = true;
    f.life = FLASH_LIFE * 1.4;
  }

  /** Flash, light and debris. The fireball + smoke column come from FireFX. */
  explosion(pos) {
    this.blast.position.copy(pos);
    this.blast.position.y += 0.6;
    this.blast.material.rotation = Math.random() * Math.PI * 2;
    this.blast.visible = true;
    this.blastLight.position.copy(this.blast.position);
    this.blastLight.position.y += 1;
    this.blastTimer = BLAST_LIFE;

    for (let n = 0; n < 30; n++) this._emit(pos, 0, 1, 0, 9, DUST, 0.8 + Math.random() * 0.6);
    for (let n = 0; n < 24; n++) this._emit(pos, 0, 1, 0, 12, SPARK, 0.4 + Math.random() * 0.4);
  }

  muzzleFlash(pos) {
    this.flash.position.copy(pos);
    const s = 0.16 + Math.random() * 0.12;
    this.flash.scale.set(s, s, s);
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    this.flash.visible = true;
    this.flashLight.position.copy(pos);
    this.flashLight.intensity = 6;
    this.flashTimer = FLASH_LIFE;
  }

  tracer(from, to, color = 0xffe0a0) {
    const t = this.tracers[this.tracerIndex];
    this.tracerIndex = (this.tracerIndex + 1) % TRACER_POOL;
    t.mesh.material.color.setHex(color);
    t.mesh.position.copy(from);
    t.mesh.lookAt(to);
    t.mesh.scale.set(1, 1, from.distanceTo(to));
    t.mesh.material.opacity = 1;
    t.mesh.visible = true;
    t.life = TRACER_LIFE;
  }

  /** kind: "blood" | "dust" */
  impact(pos, nx, ny, nz, kind, count) {
    const palette = kind === "blood" ? BLOOD : DUST;
    const speed = kind === "blood" ? 3.2 : 2.2;
    for (let n = 0; n < count; n++) this._emit(pos, nx, ny, nz, speed, palette, 0.5 + Math.random() * 0.4);
    if (kind === "dust") {
      for (let n = 0; n < 4; n++) this._emit(pos, nx, ny, nz, 5, SPARK, 0.15);
    }
  }

  _emit(pos, nx, ny, nz, speed, palette, life) {
    const i = this.pNext;
    this.pNext = (this.pNext + 1) % PARTICLE_COUNT;
    const i3 = i * 3;
    this.pPos[i3] = pos.x;
    this.pPos[i3 + 1] = pos.y;
    this.pPos[i3 + 2] = pos.z;
    const sp = speed * (0.4 + Math.random() * 0.8);
    this.pVel[i3]     = (nx + (Math.random() - 0.5) * 1.4) * sp;
    this.pVel[i3 + 1] = (ny + Math.random() * 0.9) * sp;
    this.pVel[i3 + 2] = (nz + (Math.random() - 0.5) * 1.4) * sp;
    const c = palette[(Math.random() * palette.length) | 0];
    this.pCol[i3] = c.r;
    this.pCol[i3 + 1] = c.g;
    this.pCol[i3 + 2] = c.b;
    this.pLife[i] = life;
    this.pAlive = PARTICLE_COUNT;
  }

  update(delta) {
    if (this.flashTimer > 0) {
      this.flashTimer -= delta;
      if (this.flashTimer <= 0) {
        this.flash.visible = false;
        this.flashLight.intensity = 0;
      }
    }

    for (const f of this.enemyFlashes) {
      if (f.life <= 0) continue;
      f.life -= delta;
      if (f.life <= 0) f.sprite.visible = false;
    }

    if (this.blastTimer > 0) {
      this.blastTimer -= delta;
      const t = Math.max(0, this.blastTimer / BLAST_LIFE);
      const s = 7 - t * 4;
      this.blast.scale.set(s, s, s);
      this.blast.material.opacity = t;
      this.blastLight.intensity = 60 * t * t;
      if (this.blastTimer <= 0) {
        this.blast.visible = false;
        this.blastLight.intensity = 0;
      }
    }

    if (this.fAlive) this._updateFlames(delta);

    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= delta;
      if (t.life <= 0) t.mesh.visible = false;
      else t.mesh.material.opacity = t.life / TRACER_LIFE;
    }

    if (this.pAlive === 0) return;
    let anyAlive = false;
    const pos = this.pPos, vel = this.pVel, life = this.pLife;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      if (life[i] <= 0) continue;
      const i3 = i * 3;
      life[i] -= delta;
      if (life[i] <= 0) {
        pos[i3 + 1] = PARTICLE_HIDE_Y;
        continue;
      }
      anyAlive = true;
      vel[i3 + 1] -= 14 * delta;
      pos[i3]     += vel[i3] * delta;
      pos[i3 + 1] += vel[i3 + 1] * delta;
      pos[i3 + 2] += vel[i3 + 2] * delta;
      if (pos[i3 + 1] < 0.02) {
        // Settle on the ground instead of falling through it
        pos[i3 + 1] = 0.02;
        vel[i3] *= 0.5; vel[i3 + 1] = 0; vel[i3 + 2] *= 0.5;
      }
    }
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    if (!anyAlive) this.pAlive = 0;
  }

  _updateFlames(delta) {
    const pos = this.fPos, vel = this.fVel, col = this.fCol, life = this.fLife, max = this.fMax;
    const damp = Math.exp(-2.5 * delta);
    let any = false;
    for (let i = 0; i < FLAME_COUNT; i++) {
      if (life[i] <= 0) continue;
      const i3 = i * 3;
      life[i] -= delta;
      if (life[i] <= 0) {
        pos[i3 + 1] = PARTICLE_HIDE_Y;
        col[i3] = col[i3 + 1] = col[i3 + 2] = 0;
        continue;
      }
      any = true;
      vel[i3] *= damp;
      vel[i3 + 1] = vel[i3 + 1] * damp + 4 * delta; // hot air rises
      vel[i3 + 2] *= damp;
      pos[i3]     += vel[i3] * delta;
      pos[i3 + 1] += vel[i3 + 1] * delta;
      pos[i3 + 2] += vel[i3 + 2] * delta;
      // Additive blending: fading to black is fading out
      const t = life[i] / max[i];
      col[i3]     = Math.min(1, t * 1.6);
      col[i3 + 1] = t * t * 0.7;
      col[i3 + 2] = t * t * t * 0.15;
    }
    const geo = this.flames.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    if (!any) this.fAlive = false;
  }
}
