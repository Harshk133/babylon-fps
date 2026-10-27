// Aqua blood on the screen when you're hit (and a little spatter when you hit
// something up close), like blood on the camera lens: irregular splats with a
// spray of droplets and streaks flung one way, darker at the rim and glossy in
// the middle; bigger ones grow drips that run down the glass; a soft aqua glow
// creeps in from the side the hit came from; then it all thins out and fades.
//
// The splat shapes are drawn procedurally once (SPRITES variants) and stamped
// rotated / scaled; one 2D canvas over the game, its own requestAnimationFrame
// loop only while something is on it, pooled splats (no allocation per frame).

import { IS_TOUCH } from "../input/TouchControls.js";

const MAX_SPLATS = IS_TOUCH ? 22 : 34;
const SPRITES = 8;
const SPRITE_SIZE = 256;
const HOLD = 1.1;            // s at full strength
const FADE = 1.6;            // s fading out
const EDGE_LIFE = 1.4;       // s for the edge glow

// Liquid colours (aqua blood): rim, body, thin centre, sheen
const RIM = "rgba(0, 92, 98, 0.95)";
const BODY = "rgba(8, 170, 168, 0.74)";
const CORE = "rgba(80, 236, 224, 0.45)";

/** Deterministic-enough noise for a rim: a few sines with random phases. */
function rimNoise(n) {
  const waves = Array.from({ length: n }, (_, i) => ({ f: 2 + i * 2 + Math.floor(Math.random() * 3), a: (0.16 / (i + 1)) * (0.6 + Math.random() * 0.8), p: Math.random() * Math.PI * 2 }));
  return a => waves.reduce((s, w) => s + Math.sin(a * w.f + w.p) * w.a, 0);
}

/** An irregular blob path round (cx, cy), radius r. */
function blobPath(g, cx, cy, r, noise, squash = 1, rot = 0) {
  const n = 56;
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 + noise(a));
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr * squash;
    const px = cx + x * Math.cos(rot) - y * Math.sin(rot), py = cy + x * Math.sin(rot) + y * Math.cos(rot);
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
}

/** A tapered streak from (x0, y0) toward angle a, length len, width w. */
function streakPath(g, x0, y0, a, len, w) {
  const ca = Math.cos(a), sa = Math.sin(a), nx = -sa, ny = ca;
  g.beginPath();
  g.moveTo(x0 + nx * w, y0 + ny * w);
  g.quadraticCurveTo(x0 + ca * len * 0.6 + nx * w * 0.5, y0 + sa * len * 0.6 + ny * w * 0.5, x0 + ca * len, y0 + sa * len);
  g.quadraticCurveTo(x0 + ca * len * 0.6 - nx * w * 0.5, y0 + sa * len * 0.6 - ny * w * 0.5, x0 - nx * w, y0 - ny * w);
  g.closePath();
}

/**
 * One splat sprite: a main blob, a spray cone of droplets and streaks flung
 * along +x, all drawn as one liquid shape (dark rim, body, bright thin centre, sheen).
 */
function makeSplat() {
  const S = SPRITE_SIZE, c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  const cx = S * 0.36, cy = S * 0.5, R = S * (0.15 + Math.random() * 0.05);
  const shapes = [];   // functions that add a path at an inset (0 = full size)
  const main = rimNoise(5);
  const squash = 0.75 + Math.random() * 0.35, rot = (Math.random() - 0.5) * 0.6;
  shapes.push(k => blobPath(g, cx, cy, R * (1 - k), main, squash, rot));
  // A couple of lobes merged into the main blob
  for (let i = 0; i < 2 + ((Math.random() * 3) | 0); i++) {
    const a = (Math.random() - 0.5) * 2.4, d = R * (0.6 + Math.random() * 0.4), rr = R * (0.35 + Math.random() * 0.3);
    const nz = rimNoise(3);
    shapes.push(k => blobPath(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr * (1 - k), nz));
  }
  // Spray: streaks and droplets flung toward +x, smaller and sparser further out
  const streaks = 3 + ((Math.random() * 4) | 0);
  for (let i = 0; i < streaks; i++) {
    const a = (Math.random() - 0.5) * 1.1, len = R * (1.4 + Math.random() * 1.6), w = R * (0.06 + Math.random() * 0.1);
    shapes.push(k => streakPath(g, cx + Math.cos(a) * R * 0.6, cy + Math.sin(a) * R * 0.6, a, len * (1 - k * 0.5), w * (1 - k)));
  }
  const drops = 18 + ((Math.random() * 18) | 0);
  for (let i = 0; i < drops; i++) {
    const t = Math.random();
    const a = (Math.random() - 0.5) * (0.5 + t * 1.2);
    const d = R * (1.1 + t * t * 2.6);
    const rr = Math.max(1.2, R * (0.16 - t * 0.12) * (0.5 + Math.random()));
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d, sq = 0.6 + Math.random() * 0.4, ro = a;
    const nz = rimNoise(2);
    shapes.push(k => blobPath(g, x, y, rr * (1 - k * 0.8), nz, sq, ro));
  }
  // A few loose specks all round
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2, d = R * (1.2 + Math.random() * 1.6), rr = 1 + Math.random() * 2.2;
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    shapes.push(k => { g.beginPath(); g.arc(x, y, rr * (1 - k * 0.7), 0, Math.PI * 2); });
  }
  const fillAll = (style, k) => { g.fillStyle = style; for (const s of shapes) { s(k); g.fill(); } };
  fillAll(RIM, 0);
  fillAll(BODY, 0.08);
  fillAll(CORE, 0.45);
  // Liquid isn't flat: a few darker pools and thinner patches inside the main blob
  g.globalCompositeOperation = "source-atop";
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * Math.PI * 2, d = R * Math.random() * 0.8, rr = R * (0.18 + Math.random() * 0.3);
    const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d * squash;
    const m = g.createRadialGradient(px, py, 0, px, py, rr);
    const dark = i % 2 === 0;
    m.addColorStop(0, dark ? "rgba(0, 70, 76, 0.32)" : "rgba(150, 255, 245, 0.16)");
    m.addColorStop(1, "rgba(0, 0, 0, 0)");
    g.fillStyle = m;
    g.fillRect(px - rr, py - rr, rr * 2, rr * 2);
  }
  g.globalCompositeOperation = "source-over";
  // Wet sheen: a soft highlight up and to the left on the main blob
  const hx = cx - R * 0.35, hy = cy - R * 0.4 * squash;
  const sheen = g.createRadialGradient(hx, hy, 0, hx, hy, R * 0.55);
  sheen.addColorStop(0, "rgba(255, 255, 255, 0.55)");
  sheen.addColorStop(0.4, "rgba(220, 255, 250, 0.18)");
  sheen.addColorStop(1, "rgba(255, 255, 255, 0)");
  g.globalCompositeOperation = "source-atop";
  g.fillStyle = sheen;
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = "source-over";
  return c;
}

/** A small round-ish bead for the end of a drip. */
function makeBead() {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  const nz = rimNoise(2);
  blobPath(g, 16, 16, 9, nz, 1.15); g.fillStyle = RIM; g.fill();
  blobPath(g, 16, 16, 7.6, nz, 1.15); g.fillStyle = BODY; g.fill();
  const s = g.createRadialGradient(13, 12, 0, 13, 12, 6);
  s.addColorStop(0, "rgba(255,255,255,0.6)"); s.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = s; g.fillRect(0, 0, 32, 32);
  return c;
}

export class ScreenBlood {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "screen-blood";
    document.body.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.sprites = Array.from({ length: SPRITES }, makeSplat);
    this.bead = makeBead();
    this.splats = Array.from({ length: MAX_SPLATS }, () => ({
      alive: false, x: 0, y: 0, rot: 0, size: 0, sprite: 0, age: 0, life: 0,
      drips: [{ on: false, x: 0, y: 0, len: 0, max: 0, v: 0, w: 0 }, { on: false, x: 0, y: 0, len: 0, max: 0, v: 0, w: 0 }],
    }));
    this.next = 0;
    this.alive = 0;
    this.edge = { t: 0, angle: 0, strength: 0 };
    this.running = false;
    this._last = 0;
    this._resize();
    addEventListener("resize", () => this._resize());
  }

  _resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 1.5);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /**
   * strength 0..1. angle: where the hit came from, clockwise from straight
   * ahead (rad), or null for anywhere round the edges.
   */
  hit(strength, angle = null) {
    const s = Math.min(this.w, this.h);
    const side = angle ?? Math.random() * Math.PI * 2;
    // Where on the screen that side is (toward the edge, clear of the crosshair)
    const at = (spreadA, d0, d1) => {
      const a = side + (Math.random() - 0.5) * spreadA, d = d0 + Math.random() * (d1 - d0);
      return [this.w / 2 + Math.sin(a) * this.w * d, this.h / 2 - Math.cos(a) * this.h * d];
    };
    // One big splat flung outward on that side, then smaller spatter round it
    let [x, y] = at(0.5, 0.3, 0.42);
    this._spawn(x, y, s * (0.2 + strength * 0.16), Math.atan2(y - this.h / 2, x - this.w / 2), true);
    const extra = 1 + Math.round(strength * 4);
    for (let i = 0; i < extra; i++) {
      [x, y] = at(1.3, 0.22, 0.48);
      this._spawn(x, y, s * (0.08 + Math.random() * 0.11), Math.random() * Math.PI * 2, Math.random() < 0.3);
    }
    this.edge.t = EDGE_LIFE;
    this.edge.angle = side;
    this.edge.strength = Math.min(1, 0.35 + strength * 0.8);
    this._start();
  }

  /** A light spatter (you shot something close by). */
  splash(strength = 0.3) {
    const s = Math.min(this.w, this.h);
    const n = 1 + Math.round(strength * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, d = 0.25 + Math.random() * 0.2;
      this._spawn(this.w / 2 + Math.cos(a) * this.w * d, this.h / 2 + Math.sin(a) * this.h * d, s * (0.07 + Math.random() * 0.08), a, false);
    }
    this._start();
  }

  clear() {
    for (const p of this.splats) p.alive = false;
    this.alive = 0;
    this.edge.t = 0;
  }

  _spawn(x, y, size, rot, drips) {
    const p = this.splats[this.next];
    this.next = (this.next + 1) % MAX_SPLATS;
    if (!p.alive) this.alive++;
    p.alive = true;
    p.x = x; p.y = y; p.size = size; p.rot = rot;
    p.sprite = (Math.random() * SPRITES) | 0;
    p.flip = Math.random() < 0.5 ? -1 : 1;
    p.age = 0;
    p.life = HOLD + FADE + Math.random() * 0.6;
    for (const d of p.drips) {
      d.on = drips && size > 40 && Math.random() < 0.75;
      if (!d.on) continue;
      d.x = (Math.random() - 0.5) * size * 0.25;
      d.y = size * (0.05 + Math.random() * 0.1);
      d.len = 0;
      d.max = size * (0.25 + Math.random() * 0.5);
      d.v = size * (0.25 + Math.random() * 0.3);
      d.w = Math.max(1.4, size * (0.014 + Math.random() * 0.012));
    }
  }

  _start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    requestAnimationFrame(t => this._frame(t));
  }

  _frame(t) {
    const dt = Math.min(0.05, (t - this._last) / 1000);
    this._last = t;
    const g = this.ctx, dpr = this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Aqua glow creeping in from the side of the hit
    const e = this.edge;
    if (e.t > 0) {
      e.t -= dt;
      const k = Math.max(0, e.t / EDGE_LIFE);
      const a = e.strength * k * k * 0.55;
      const ex = this.w / 2 + Math.sin(e.angle) * this.w * 0.62, ey = this.h / 2 - Math.cos(e.angle) * this.h * 0.62;
      const grad = g.createRadialGradient(ex, ey, 0, ex, ey, Math.max(this.w, this.h) * 0.6);
      grad.addColorStop(0, `rgba(0, 150, 150, ${a})`);
      grad.addColorStop(0.45, `rgba(0, 110, 120, ${a * 0.45})`);
      grad.addColorStop(1, "rgba(0, 80, 90, 0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, this.w, this.h);
    }

    for (const p of this.splats) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) { p.alive = false; this.alive--; continue; }
      // Lands with a quick spread, holds, then thins away
      const grow = Math.min(1, p.age * 9);
      const scale = p.size * (0.82 + 0.18 * (1 - (1 - grow) * (1 - grow)));
      const fade = p.age < p.life - FADE ? 1 : (p.life - p.age) / FADE;
      g.globalAlpha = Math.max(0, fade) * 0.95;
      // Drips run down the glass (screen-down, whatever the splat's rotation)
      for (const d of p.drips) {
        if (!d.on) continue;
        if (p.age > 0.35 && d.len < d.max) {
          d.len = Math.min(d.max, d.len + d.v * dt);
          d.v *= Math.exp(-0.9 * dt);
        }
        if (d.len < 2) continue;
        const x0 = p.x + d.x, y0 = p.y + d.y;
        g.lineCap = "round";
        g.strokeStyle = RIM;
        g.lineWidth = d.w * 1.35;
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + d.len * 0.04, y0 + d.len); g.stroke();
        g.strokeStyle = BODY;
        g.lineWidth = d.w;
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + d.len * 0.04, y0 + d.len); g.stroke();
        const bs = d.w * 3.2;
        g.drawImage(this.bead, x0 + d.len * 0.04 - bs / 2, y0 + d.len - bs * 0.45, bs, bs * 1.15);
      }
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.scale(p.flip, 1);
      // The sprite's main blob sits at 36% across: put that on the hit point
      g.drawImage(this.sprites[p.sprite], -scale * 0.36, -scale * 0.5, scale, scale);
      g.restore();
    }
    g.globalAlpha = 1;
    if (this.alive > 0 || e.t > 0) requestAnimationFrame(tt => this._frame(tt));
    else {
      this.running = false;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}
