// Celebration confetti, after React Bits Pro's "Celebration Cursor": tumbling
// paper pieces with gravity, air drag (more when a piece falls flat), flutter
// (tilted pieces glide sideways), spin, gusts, edge-on shading and a sheen as
// they turn to the light. Corner cannons and bursts fire on a win; while a
// celebration runs and the mouse is free, moving it spills a trail and
// clicking fires a burst at the pointer.
//
// One 2D canvas over the page, its own requestAnimationFrame loop that only
// runs while pieces are alive, pooled pieces (no allocation per frame).

import { IS_TOUCH } from "../input/TouchControls.js";

const MAX_PIECES = IS_TOUCH ? 600 : 1600;
const GRAVITY = 420;          // px/s²: paper falls at 100–350 px/s once drag takes over
const LIFE = 6;               // s
const FADE = 0.25;            // last share of life spent fading
const SHADES = 12;            // pre-mixed brightness steps per colour
const SHAPES = ["rect", "strip", "circle", "rect", "triangle"];

export const CONFETTI_COLORS = {
  level: ["#4dff88", "#ffd27a", "#e8dccb", "#ff4b3a", "#e2a42b"],
  victory: ["#ffd84d", "#ffb52e", "#fff3c4", "#ff4b3a", "#b84dff", "#6ab4ff"],
};

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Colour at brightness b (0 dark … 1 base … up to 1.5 with sheen), as a CSS string. */
function shade([r, g, b], k) {
  const mix = (c) => (k <= 1 ? c * k : c + (255 - c) * (k - 1) * 2);
  return `rgb(${mix(r) | 0},${mix(g) | 0},${mix(b) | 0})`;
}

export class Confetti {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "confetti";
    document.body.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.pieces = Array.from({ length: MAX_PIECES }, () => ({ alive: false }));
    this.next = 0;            // ring index: the oldest piece is reused first
    this.alive = 0;
    this.running = false;
    this.time = 0;
    this.interactiveUntil = 0;   // performance.now() ms
    this._timers = [];
    this.setColors(CONFETTI_COLORS.level);
    this._resize();
    addEventListener("resize", () => this._resize());

    // Trail + click bursts, only while a celebration is on and the mouse is free
    this._lastX = null; this._lastY = 0; this._lastT = 0; this._trailAcc = 0;
    addEventListener("pointermove", e => this._onMove(e));
    addEventListener("pointerdown", e => {
      if (!this._interactive() || document.pointerLockElement) return;
      this.burst(e.clientX, e.clientY, -90, 60, 0.8);
    });
  }

  setColors(list) {
    this.palette = list.map(hex => {
      const rgb = hexToRgb(hex);
      const out = [];
      for (let i = 0; i <= SHADES; i++) out.push(shade(rgb, 0.35 + (i / SHADES) * 1.0));
      return out;
    });
  }

  _resize() {
    this.dpr = Math.min(devicePixelRatio || 1, IS_TOUCH ? 1.5 : 2);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  _interactive() { return performance.now() < this.interactiveUntil; }

  _onMove(e) {
    if (!this._interactive() || document.pointerLockElement) { this._lastX = null; return; }
    const now = performance.now();
    if (this._lastX !== null) {
      const dx = e.clientX - this._lastX, dy = e.clientY - this._lastY;
      const dt = Math.max(1, now - this._lastT) / 1000;
      this._trailAcc += Math.hypot(dx, dy) * 0.12;     // pieces per px travelled
      while (this._trailAcc >= 1) {
        this._trailAcc -= 1;
        const a = Math.random() * Math.PI * 2, s = 40 + Math.random() * 140;
        this._spawn(e.clientX, e.clientY, Math.cos(a) * s + dx / dt * 0.25, Math.sin(a) * s - 80 + dy / dt * 0.25, 0.8);
      }
    }
    this._lastX = e.clientX; this._lastY = e.clientY; this._lastT = now;
  }

  _spawn(x, y, vx, vy, sizeMul = 1) {
    const p = this.pieces[this.next];
    this.next = (this.next + 1) % MAX_PIECES;
    if (!p.alive) this.alive++;
    p.alive = true;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.age = 0;
    p.life = LIFE * (0.7 + Math.random() * 0.5);
    p.shape = SHAPES[(Math.random() * SHAPES.length) | 0];
    const size = 14 * (1 + (Math.random() - 0.5) * 0.8) * sizeMul * (IS_TOUCH ? 0.8 : 1);
    p.len = p.shape === "strip" ? size * 1.5 : size;
    p.wid = p.shape === "strip" ? size * 0.28 : p.shape === "rect" ? size * 0.55 : size;
    p.color = (Math.random() * this.palette.length) | 0;
    p.rot = Math.random() * Math.PI * 2;
    p.rotV = (Math.random() - 0.5) * 9;
    p.tilt = Math.random() * Math.PI * 2;                  // flip around its long axis
    p.tiltV = (4 + Math.random() * 8) * (Math.random() < 0.5 ? -1 : 1);
    p.phase = Math.random() * 100;
    this._start();
  }

  /** A burst from (x, y), screen px. angle: degrees, −90 = straight up. */
  burst(x, y, angle = -90, count = 120, power = 1, spread = 70) {
    const a0 = angle * Math.PI / 180, sp = spread * Math.PI / 180;
    for (let i = 0; i < count; i++) {
      const a = a0 + (Math.random() - 0.5) * sp;
      const s = (500 + Math.random() * 900) * power;
      this._spawn(x + (Math.random() - 0.5) * 10, y + (Math.random() - 0.5) * 10, Math.cos(a) * s, Math.sin(a) * s);
    }
  }

  /** Two cannons from the bottom corners, aimed up and inward. */
  cannons(count = 130, power = 1.25) {
    this.burst(0, this.h + 10, -62, count, power, 28);
    this.burst(this.w, this.h + 10, -118, count, power, 28);
  }

  /**
   * The whole show: cannons, a burst over the middle, a second volley.
   * kind: "level" | "victory" (gold-heavy and bigger).
   */
  celebrate(kind = "level") {
    for (const t of this._timers) clearTimeout(t);
    this._timers.length = 0;
    this.setColors(CONFETTI_COLORS[kind] ?? CONFETTI_COLORS.level);
    const big = kind === "victory";
    this.interactiveUntil = performance.now() + (big ? 12000 : 6000);
    this.cannons(big ? 160 : 110);
    const later = (ms, fn) => this._timers.push(setTimeout(fn, ms));
    later(350, () => this.burst(this.w / 2, this.h * 0.42, -90, big ? 160 : 90, 0.75, 360));
    later(900, () => this.cannons(big ? 120 : 70, 1.1));
    if (big) {
      later(1700, () => this.burst(this.w * 0.25, this.h * 0.35, -90, 90, 0.7, 360));
      later(2100, () => this.burst(this.w * 0.75, this.h * 0.35, -90, 90, 0.7, 360));
      later(3000, () => this.cannons(120, 1.2));
    }
  }

  clear() {
    for (const p of this.pieces) p.alive = false;
    this.alive = 0;
  }

  _start() {
    if (this.running) return;
    this.running = true;
    this._prev = performance.now();
    this.canvas.classList.add("on");
    requestAnimationFrame(this._frame);
  }

  _frame = (now) => {
    const dt = Math.min(0.05, (now - this._prev) / 1000);
    this._prev = now;
    this.time += dt;
    this._step(dt);
    this._draw();
    if (this.alive > 0) requestAnimationFrame(this._frame);
    else {
      this.running = false;
      this.canvas.classList.remove("on");
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  };

  _step(dt) {
    const t = this.time;
    // Gentle gusts: a slow sideways wave shared by every piece
    const gust = Math.sin(t * 0.7) * 40 + Math.sin(t * 1.9) * 18;
    for (const p of this.pieces) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life || p.y > this.h + 60) { p.alive = false; this.alive--; continue; }
      p.tilt += p.tiltV * dt;
      p.rot += p.rotV * dt;
      const face = Math.abs(Math.cos(p.tilt));              // 1 flat to the air … 0 edge-on
      // Drag: a flat piece catches the air, an edge-on one slices through
      const drag = 1.2 + 3 * face;
      p.vx += (gust - p.vx) * Math.min(1, drag * 0.5 * dt);
      p.vy += GRAVITY * dt;
      p.vy -= p.vy * Math.min(1, drag * dt);
      // Flutter: a tilted piece glides sideways as it falls
      p.vx += Math.sin(p.tilt) * Math.cos(p.tilt) * 520 * dt * (p.vy > 0 ? 1 : 0.3);
      p.x += p.vx * dt + Math.sin(t * 3 + p.phase) * 12 * dt;
      p.y += p.vy * dt;
    }
  }

  _draw() {
    const ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const p of this.pieces) {
      if (!p.alive) continue;
      const c = Math.cos(p.tilt);
      // Edge-on pieces are darker; facing the light (top-left) catches a sheen
      const light = 0.5 + 0.5 * Math.abs(c);
      const sheen = Math.max(0, c) ** 6 * 0.35;
      const level = Math.min(SHADES, Math.round((light * 0.65 + sheen) * SHADES));
      const fadeStart = p.life * (1 - FADE);
      ctx.globalAlpha = p.age > fadeStart ? 1 - (p.age - fadeStart) / (p.life * FADE) : 1;
      ctx.fillStyle = this.palette[p.color][level];
      const cr = Math.cos(p.rot), sr = Math.sin(p.rot);
      // Rotation in the screen plane, squashed along one axis by the flip
      const sy = Math.max(0.08, Math.abs(c));
      ctx.setTransform(cr * dpr, sr * dpr, -sr * sy * dpr, cr * sy * dpr, p.x * dpr, p.y * dpr);
      const hl = p.len / 2, hw = p.wid / 2;
      if (p.shape === "circle") {
        ctx.beginPath();
        ctx.arc(0, 0, hw * 0.6, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.shape === "triangle") {
        ctx.beginPath();
        ctx.moveTo(0, -hw * 0.7);
        ctx.lineTo(hw * 0.65, hw * 0.45);
        ctx.lineTo(-hw * 0.65, hw * 0.45);
        ctx.fill();
      } else {
        ctx.fillRect(-hl, -hw, p.len, p.wid);
      }
    }
    ctx.globalAlpha = 1;
  }
}
