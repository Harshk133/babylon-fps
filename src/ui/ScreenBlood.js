// Aqua blood drops on the screen when you're hit (and a few when you hit
// something up close): glossy beads that land with a splash, trickle down a
// little leaving a thin trail, and fade. The side the hit came from gets most
// of them.
//
// One 2D canvas over the game with its own requestAnimationFrame loop that
// runs only while drops are alive; drops are pooled. Each drop is drawn from a
// pre-rendered bead sprite (no gradients built per frame).

import { IS_TOUCH } from "../input/TouchControls.js";

const MAX_DROPS = IS_TOUCH ? 40 : 70;
const LIFE = 2.6;             // s
const FADE = 0.45;            // last share of life spent fading
const SPRITE = 96;            // bead sprite size (px)

function beadSprite() {
  const c = document.createElement("canvas");
  c.width = c.height = SPRITE;
  const g = c.getContext("2d");
  const r = SPRITE / 2;
  // Body: deep aqua rim, brighter middle
  let grad = g.createRadialGradient(r * 0.85, r * 0.8, r * 0.1, r, r, r * 0.95);
  grad.addColorStop(0, "rgba(150,255,242,0.55)");
  grad.addColorStop(0.5, "rgba(20,215,205,0.62)");
  grad.addColorStop(0.86, "rgba(0,125,140,0.85)");
  grad.addColorStop(1, "rgba(0,90,105,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(r, r, r * 0.95, 0, Math.PI * 2);
  g.fill();
  // Specular highlight
  grad = g.createRadialGradient(r * 0.68, r * 0.62, 0, r * 0.68, r * 0.62, r * 0.32);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(r * 0.68, r * 0.62, r * 0.32, 0, Math.PI * 2);
  g.fill();
  return c;
}

export class ScreenBlood {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "screen-blood";
    document.body.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.sprite = beadSprite();
    this.drops = Array.from({ length: MAX_DROPS }, () => ({ alive: false, x: 0, y: 0, r: 0, life: 0, vy: 0, y0: 0, splash: [] }));
    this.next = 0;
    this.alive = 0;
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
    const n = Math.round(4 + strength * 14);
    const s = Math.min(this.w, this.h);
    for (let i = 0; i < n; i++) {
      let x, y;
      if (angle !== null && Math.random() < 0.8) {
        // Toward the side the hit came from, near the edge
        const a = angle + (Math.random() - 0.5) * 1.1;
        const d = 0.32 + Math.random() * 0.2;
        x = this.w / 2 + Math.sin(a) * this.w * d;
        y = this.h / 2 - Math.cos(a) * this.h * d;
      } else {
        // Round the edges, clear of the crosshair
        const a = Math.random() * Math.PI * 2, d = 0.25 + Math.random() * 0.25;
        x = this.w / 2 + Math.cos(a) * this.w * d;
        y = this.h / 2 + Math.sin(a) * this.h * d;
      }
      // Mostly fine specks, now and then a big drop
      const big = Math.random() < 0.18 + strength * 0.2;
      this._spawn(x, y, s * (big ? 0.016 + Math.random() * (0.012 + strength * 0.014) : 0.004 + Math.random() * 0.007));
    }
    this._start();
  }

  /** A light spray (you shot something close by). */
  splash(strength = 0.3) {
    this.hit(strength * 0.5, null);
  }

  clear() {
    for (const d of this.drops) d.alive = false;
    this.alive = 0;
  }

  _spawn(x, y, r) {
    const d = this.drops[this.next];
    this.next = (this.next + 1) % MAX_DROPS;
    if (!d.alive) this.alive++;
    d.alive = true;
    d.x = x; d.y = y; d.y0 = y; d.r = r;
    d.life = LIFE * (0.7 + Math.random() * 0.5);
    d.max = d.life;
    // Big drops run down the glass, small ones stay put
    d.vy = r > 9 ? 8 + Math.random() * 22 : 0;
    d.splash.length = 0;
    const k = 3 + (Math.random() * 4 | 0);
    for (let i = 0; i < k; i++) {
      const a = Math.random() * Math.PI * 2, dist = r * (1.1 + Math.random() * 1.4);
      d.splash.push(Math.cos(a) * dist, Math.sin(a) * dist, r * (0.15 + Math.random() * 0.3));
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
    for (const d of this.drops) {
      if (!d.alive) continue;
      d.life -= dt;
      if (d.life <= 0) { d.alive = false; this.alive--; continue; }
      d.y += d.vy * dt;
      d.vy *= Math.exp(-0.9 * dt);
      const age = d.max - d.life;
      const k = d.life / d.max;
      g.globalAlpha = Math.min(1, k / FADE) * 0.92;
      // Trail left by a running drop
      if (d.y - d.y0 > 2) {
        g.fillStyle = "rgba(20,200,195,0.45)";
        g.fillRect(d.x - d.r * 0.18, d.y0, d.r * 0.36, d.y - d.y0);
      }
      // Lands with a little squash, then settles; running drops stretch into a teardrop
      const pop = Math.min(1, age * 14);
      const r = d.r * (0.6 + 0.4 * pop) * (1 + Math.max(0, 0.25 - age) * 1.2);
      const stretch = 1.05 + Math.min(0.5, d.vy * 0.02);
      g.drawImage(this.sprite, d.x - r, d.y - r * stretch * 1.2, r * 2, r * 2 * stretch);
      for (let i = 0; i < d.splash.length; i += 3) {
        const sr = d.splash[i + 2] * pop;
        g.drawImage(this.sprite, d.x + d.splash[i] * pop - sr, d.y0 + d.splash[i + 1] * pop - sr, sr * 2, sr * 2);
      }
    }
    g.globalAlpha = 1;
    if (this.alive > 0) requestAnimationFrame(tt => this._frame(tt));
    else {
      this.running = false;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}
