// Full-screen world map (M / the map button): a shaded-relief picture of the
// terrain, buildings, trees, the rickshaw, teammates, the battle royale zone
// and drop plane, and pins. Tap / click the map to drop your pin, tap it again
// to lift it; drag to pan, pinch / wheel / ± to zoom.
//
// On desktop, opening it frees the captured mouse (main.js setMapOpen) so it
// works with the real cursor, while the game keeps running underneath, as in
// PUBG. Builds its own DOM and only redraws while open.

import { groundHeight, PLAY_RADIUS, SEA_Y } from "../world/Terrain.js";
import { ICON_PATHS, icon } from "./gameIcons.js";

const WORLD_R   = 520;   // metres from the map centre to its edge at zoom 1
const RELIEF_PX = 1280;  // terrain picture resolution (rendered once, on first open; opts.reliefPx overrides)
const GRID     = 100;    // m: the lettered grid squares (A-J west to east, 1-10 north to south)
const GRID_COLS = "ABCDEFGHIJ";
/** Vehicle kind → icon and badge colour. */
const VEHICLE_ICON = {
  thar: ["jeep", "#8fbf4a"], rickshaw: ["rickshaw", "#ffd23a"], tractor: ["tractor", "#ff7a2e"],
  sportbike: ["bike", "#4db8ff"], motorbike: ["bike", "#4db8ff"],
};
// Relief colours by height (0 = the lowest land, 1 = the highest): lush lowland,
// grassland, dry upland, brown hills, bare rock
const HYPSO = [[0, [74, 108, 56]], [0.22, [96, 122, 64]], [0.45, [132, 132, 80]], [0.7, [146, 116, 82]], [1, [176, 166, 150]]];
const _paths = new Map();
/** A game-icons path (512 × 512) as a Path2D, cached. */
function iconPath(name) {
  let p = _paths.get(name);
  if (!p && ICON_PATHS[name]) _paths.set(name, p = new Path2D(ICON_PATHS[name]));
  return p ?? null;
}
function hypso(t, out) {
  for (let i = 1; i < HYPSO.length; i++) {
    const [t1, c1] = HYPSO[i];
    if (t > t1 && i < HYPSO.length - 1) continue;
    const [t0, c0] = HYPSO[i - 1], k = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
    out[0] = c0[0] + (c1[0] - c0[0]) * k; out[1] = c0[1] + (c1[1] - c0[1]) * k; out[2] = c0[2] + (c1[2] - c0[2]) * k;
    return out;
  }
  return out;
}
const REDRAW_HZ = 20;
const PIN_HIT   = 24;    // px: tapping this close to your own pin lifts it
const DRAG_PX   = 8;     // a press that moves further than this pans instead of pinning
const ZOOM_MAX  = 6;
const HEADINGS  = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

/** Compass bearing (0 = north, clockwise) from a to b, in the minimap's convention (north +Z, east −X). */
export function bearingDeg(ax, az, bx, bz) {
  let d = (-Math.atan2(bx - ax, bz - az) * 180) / Math.PI;
  if (d < 0) d += 360;
  return d;
}

export function headingName(deg) {
  return HEADINGS[Math.round(deg / 45) % 8];
}

export class WorldMap {
  /**
   * sources (all optional except me): functions returning live state.
   *   me()        → { x, z, yaw }
   *   players()   → [{ x, z, yaw, color, dead }]   teammates
   *   obstacles() → [{ type:"box", x, z, w, d, rot } | { type:"circle", x, z, r }]
   *   fires()     → [{ x, z }]                       burning wrecks
   *   vehicles()  → [{ x, z, kind }]
   *   br()        → { zone, next, route, plane } | null
   *   fights()    → [{ x, z, r }]                    red zones: players fighting
   *   height(x,z) → surface height for the relief (default: groundHeight)
   *   surface(x,z) → [r, g, b] (0..255) to paint there instead (water, fields), or null
   *   caves()     → [{ name, x, z, tunnels: [[ax, az, bx, bz]], mouths: [{ x, z }] }]
   * opts: { touch, onPin(x, z), onClear(), onClose() }
   */
  constructor(sources, opts = {}) {
    this.sources = sources;
    this.opts = opts;
    this.open = false;
    this.pins = new Map();   // id → { x, z, color, label }; "me" is yours
    this.zoom = 1;
    this.cx = 0;
    this.cz = 0;
    this._ptrs = new Map();
    this._tap = null;
    this._pinch = null;
    this._next = 0;
    this._relief = null;
    this._info = "";
    this._build();
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  _build() {
    const touch = !!this.opts.touch;
    const root = this.root = el("div");
    root.id = "world-map";
    const frame = el("div", "wm-frame");
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    const zoom = el("div", "wm-zoom",
      '<button data-act="in" aria-label="Zoom in">+</button>' +
      '<button data-act="out" aria-label="Zoom out">−</button>' +
      '<button data-act="me" aria-label="Centre on me">◎</button>');
    frame.append(this.canvas, zoom);

    const side = el("aside", "wm-side");
    side.innerHTML = `
      <div class="wm-title">MAP</div>
      <div class="wm-pin"><span class="wm-pin-dot"></span><span class="wm-pin-text">No pin set</span></div>
      <p class="wm-help">${touch
        ? "Tap the map to drop a pin, tap it again to remove it.<br>Drag to move, pinch or ± to zoom."
        : "<kbd>Click</kbd> drop a pin · <kbd>Right-click</kbd> remove<br><kbd>Drag</kbd> move · <kbd>Wheel</kbd> zoom · <kbd>M</kbd> close"}</p>
      <div class="wm-legend">
        <span><i class="lg-me"></i>You</span>
        <span><i class="lg-mate"></i>Squad</span>
        <span><i class="lg-house"></i>Building</span>
        <span><i class="lg-tree"></i>Tree / rock</span>
        <span><i class="lg-fire"></i>Fire</span>
        <span><b class="lg-veh" style="--c:#8fbf4a">${icon("jeep")}</b>Car</span>
        <span><b class="lg-veh" style="--c:#4db8ff">${icon("bike")}</b>Bike</span>
        <span><b class="lg-veh" style="--c:#ffd23a">${icon("rickshaw")}</b>Rickshaw</span>
        <span><b class="lg-veh" style="--c:#ff7a2e">${icon("tractor")}</b>Tractor</span>
        <span><b class="lg-veh wreck" style="--c:#6c6c6c">${icon("jeep")}</b>Wrecked</span>
        <span><b class="lg-veh" style="--c:#ffc23d">${icon("parachute")}</b>Supply drop</span>
      </div>
      <div class="wm-buttons">
        <button data-act="clear" class="wm-ghost">Remove pin</button>
        <button data-act="close">Close</button>
      </div>`;
    this.pinText = side.querySelector(".wm-pin-text");
    this.pinDot = side.querySelector(".wm-pin-dot");
    this.clearBtn = side.querySelector('[data-act="clear"]');
    root.append(frame, side);
    document.body.append(root);

    root.addEventListener("click", e => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "in") this.zoomBy(1.6);
      else if (act === "out") this.zoomBy(1 / 1.6);
      else if (act === "me") this.centreOnMe();
      else if (act === "clear") this.clearMine();
      else if (act === "close") this.opts.onClose?.();
    });
    // Nothing on the map should reach the game underneath
    for (const type of ["pointerdown", "pointermove", "pointerup", "mousedown", "contextmenu"]) {
      root.addEventListener(type, e => e.stopPropagation());
    }
    root.addEventListener("contextmenu", e => e.preventDefault());

    const cv = this.canvas;
    cv.addEventListener("pointerdown", e => this._down(e));
    cv.addEventListener("pointermove", e => this._move(e));
    cv.addEventListener("pointerup", e => this._up(e));
    cv.addEventListener("pointercancel", e => { this._ptrs.delete(e.pointerId); this._tap = null; this._pinch = null; });
    cv.addEventListener("wheel", e => {
      e.preventDefault();
      const p = this._local(e);
      this.zoomBy(e.deltaY < 0 ? 1.25 : 0.8, p.x, p.y);
    }, { passive: false });
  }

  setOpen(open) {
    if (open === this.open) return;
    this.open = open;
    this.root.classList.toggle("on", open);
    this._ptrs.clear();
    this._tap = this._pinch = null;
    if (open) {
      if (!this._relief) this._relief = this._buildRelief();   // (finishes the background build, if it started)
      this._next = 0;
    }
  }

  // ── View ────────────────────────────────────────────────────────────────────

  _size() { return this.canvas.clientWidth || 360; }
  _k() { return (this._size() / 2) / (WORLD_R / this.zoom); }   // px per metre
  _X(x) { return this._size() / 2 - (x - this.cx) * this._k(); }
  _Y(z) { return this._size() / 2 - (z - this.cz) * this._k(); }
  _toWorld(px, py) {
    const k = this._k(), h = this._size() / 2;
    return { x: this.cx - (px - h) / k, z: this.cz - (py - h) / k };
  }

  _clampView() {
    const lim = WORLD_R * (1 - 1 / this.zoom);
    this.cx = Math.max(-lim, Math.min(lim, this.cx));
    this.cz = Math.max(-lim, Math.min(lim, this.cz));
  }

  /** Zoom around a screen point (default: the centre), keeping it under the finger. */
  zoomBy(f, px = this._size() / 2, py = this._size() / 2) {
    const before = this._toWorld(px, py);
    this.zoom = Math.max(1, Math.min(ZOOM_MAX, this.zoom * f));
    const after = this._toWorld(px, py);
    this.cx += before.x - after.x;
    this.cz += before.z - after.z;
    this._clampView();
    this._next = 0;
  }

  _pan(dx, dy) {
    const k = this._k();
    this.cx += dx / k;
    this.cz += dy / k;
    this._clampView();
    this._next = 0;
  }

  centreOnMe() {
    const me = this.sources.me();
    if (this.zoom < 2.5) this.zoom = 2.5;
    this.cx = me.x;
    this.cz = me.z;
    this._clampView();
    this._next = 0;
  }

  // ── Pins ────────────────────────────────────────────────────────────────────

  /** pin: { x, z, color, label } or null. */
  setPin(id, pin) {
    if (pin) this.pins.set(id, pin);
    else this.pins.delete(id);
    this._next = 0;
  }

  get myPin() { return this.pins.get("me") ?? null; }

  clearMine() {
    if (!this.pins.has("me")) return;
    this.setPin("me", null);
    this.opts.onClear?.();
  }

  /** A tap / click at canvas px: lift your pin if it's under the finger, else drop it here. */
  _tapAt(px, py) {
    const mine = this.myPin;
    if (mine && Math.hypot(this._X(mine.x) - px, this._Y(mine.z) - py) < PIN_HIT) { this.clearMine(); return; }
    let { x, z } = this._toWorld(px, py);
    const r = Math.hypot(x, z), max = PLAY_RADIUS - 2;
    if (r > max) { x *= max / r; z *= max / r; }
    this.opts.onPin?.(x, z);
  }

  // ── Real pointers (touch, and the mouse when it isn't captured) ─────────────

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    const s = this._size() / (r.width || 1);
    return { x: (e.clientX - r.left) * s, y: (e.clientY - r.top) * s };
  }

  _down(e) {
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const p = this._local(e);
    this._ptrs.set(e.pointerId, p);
    if (this._ptrs.size === 1) {
      this._tap = { x: p.x, y: p.y, moved: false, button: e.button };
    } else if (this._ptrs.size === 2) {
      const [a, b] = [...this._ptrs.values()];
      this._tap = null;
      this._pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
    }
  }

  _move(e) {
    const prev = this._ptrs.get(e.pointerId);
    if (!prev) return;
    const p = this._local(e);
    this._ptrs.set(e.pointerId, p);
    if (this._ptrs.size === 2 && this._pinch) {
      const [a, b] = [...this._ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      this.zoomBy(d / this._pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      this._pinch.d = d;
      return;
    }
    const t = this._tap;
    if (!t) return;
    if (!t.moved && Math.hypot(p.x - t.x, p.y - t.y) > DRAG_PX) t.moved = true;
    if (t.moved) this._pan(p.x - prev.x, p.y - prev.y);
  }

  _up(e) {
    this._ptrs.delete(e.pointerId);
    const t = this._tap;
    if (this._ptrs.size < 2) this._pinch = null;
    if (!t || this._ptrs.size) return;
    this._tap = null;
    if (t.moved) return;
    if (t.button === 2) this.clearMine();
    else this._tapAt(t.x, t.y);
  }

  // ── Terrain picture ─────────────────────────────────────────────────────────

  /** Shaded relief of the heightmap, lit from the north-west. Rendered once. */
  /** The whole relief now (what's left of it, if prebuild() already did some). */
  _buildRelief() {
    const job = this._reliefJob ??= this._reliefSteps();
    let r;
    while (!(r = job.next()).done);
    this._reliefJob = null;
    return r.value;
  }

  /**
   * Builds the relief in slices of about budgetMs, so opening the map for the
   * first time costs nothing mid-fight. Call it while the game idles; returns
   * true once the picture is ready.
   */
  prebuild(budgetMs = 3) {
    if (this._relief) return true;
    const job = this._reliefJob ??= this._reliefSteps();
    const end = performance.now() + budgetMs;
    while (performance.now() < end) {
      const r = job.next();
      if (r.done) { this._relief = r.value; this._reliefJob = null; return true; }
    }
    return false;
  }

  /** The relief picture, a few rows per step (a generator: prebuild / _buildRelief drive it). */
  *_reliefSteps() {
    const N = this.opts.reliefPx ?? RELIEF_PX;
    const cv = document.createElement("canvas");
    cv.width = cv.height = N;
    const g = cv.getContext("2d");
    const img = g.createImageData(N, N);
    const step = (WORLD_R * 2) / N;
    const h = new Float32Array(N * N);
    const height = this.sources.height ?? groundHeight;
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < N; j++) {
      const z = WORLD_R - (j + 0.5) * step;
      for (let i = 0; i < N; i++) {
        const x = WORLD_R - (i + 0.5) * step;
        const v = height(x, z);
        h[j * N + i] = v;
        // Height range of the playable land only (the edge ridges would wash it out)
        if (Math.hypot(x, z) < PLAY_RADIUS && v > SEA_Y + 0.5) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
      if ((j & 7) === 7) yield;
    }
    const span = Math.max(1, hi - lo);
    // Light from the upper left of the picture, a little above the horizon (classic hill shading)
    const Lx = -0.52, Ly = 0.68, Lz = -0.52;
    const col = [0, 0, 0];
    const d = img.data;
    for (let j = 0; j < N; j++) {
      const z = WORLD_R - (j + 0.5) * step;
      const jn = Math.min(N - 1, j + 1), jp = Math.max(0, j - 1);
      for (let i = 0; i < N; i++) {
        const k = j * N + i, o = k * 4;
        const x = WORLD_R - (i + 0.5) * step;
        const v = h[k];
        // Water has its own colour and lies flat: no shading
        const paint = this.sources.surface?.(x, z);
        if (paint && paint[3]) {
          d[o] = paint[0]; d[o + 1] = paint[1]; d[o + 2] = paint[2]; d[o + 3] = 255;
          continue;
        }
        const ip = Math.max(0, i - 1), inn = Math.min(N - 1, i + 1);
        const gx = (h[j * N + inn] - h[j * N + ip]) / (2 * step);
        const gz = (h[jn * N + i] - h[jp * N + i]) / (2 * step);
        // Surface normal (-gx, 1, -gz) against the light; flat ground comes out at 1
        const len = Math.sqrt(gx * gx + 1 + gz * gz);
        const diffuse = Math.max(0, (-gx * Lx + Ly - gz * Lz) / len);
        const slope = 1 - 1 / len;                       // 0 flat .. 1 cliff
        let shade = 0.32 + 0.68 * (diffuse / Ly);
        shade *= 1 - slope * 0.25;
        const t = Math.max(0, Math.min(1, (v - lo) / span));
        hypso(t, col);
        // Steep ground shows bare earth and rock
        if (slope > 0.08) {
          const r = Math.min(1, (slope - 0.08) * 3) * 0.6;
          col[0] += (150 - col[0]) * r; col[1] += (128 - col[1]) * r; col[2] += (104 - col[2]) * r;
        }
        // Sand along the shore
        if (v < SEA_Y + 1.4 && v > SEA_Y - 0.5) {
          const r = 1 - Math.max(0, v - SEA_Y) / 1.4;
          col[0] += (204 - col[0]) * r; col[1] += (188 - col[1]) * r; col[2] += (140 - col[2]) * r;
        }
        // Fields keep their own colours (shaded with the land under them)
        if (paint) { col[0] = paint[0]; col[1] = paint[1]; col[2] = paint[2]; }
        // Contour lines where the height crosses a 5 m step (every 25 m bolder)
        const vr = h[j * N + inn], vd = h[jn * N + i];
        let line = 1;
        if (Math.floor(v / 25) !== Math.floor(vr / 25) || Math.floor(v / 25) !== Math.floor(vd / 25)) line = 0.72;
        else if (Math.floor(v / 5) !== Math.floor(vr / 5) || Math.floor(v / 5) !== Math.floor(vd / 5)) line = 0.88;
        // A little grain so big flat areas don't look like plastic
        const grain = 0.975 + ((((i * 73856093) ^ (j * 19349663)) >>> 0) % 1000) / 1000 * 0.05;
        const dim = Math.hypot(x, z) > PLAY_RADIUS ? 0.42 : 1;
        const m = shade * line * grain * dim;
        d[o]     = Math.min(255, col[0] * m);
        d[o + 1] = Math.min(255, col[1] * m);
        d[o + 2] = Math.min(255, col[2] * m);
        d[o + 3] = 255;
      }
      if ((j & 7) === 7) yield;
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  update(now) {
    if (!this.open || now < this._next) return;
    this._next = now + 1000 / REDRAW_HZ;
    const cv = this.canvas, S = this._size();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(S * dpr)) cv.width = cv.height = Math.round(S * dpr);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = this._k();
    const X = x => this._X(x), Y = z => this._Y(z);
    const me = this.sources.me();

    ctx.fillStyle = "#0b0d09";
    ctx.fillRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._relief, X(WORLD_R), Y(WORLD_R), WORLD_R * 2 * k, WORLD_R * 2 * k);

    // Grid: the lettered 100 m squares, and finer lines when zoomed in
    const cell = this.zoom >= 3 ? 25 : this.zoom >= 1.8 ? 50 : 100;
    if (cell < GRID) {
      ctx.strokeStyle = "rgba(255, 245, 225, 0.07)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let g = -500; g <= 500; g += cell) {
        if (g % GRID === 0) continue;
        ctx.moveTo(X(g), 0); ctx.lineTo(X(g), S);
        ctx.moveTo(0, Y(g)); ctx.lineTo(S, Y(g));
      }
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255, 245, 225, 0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = -500; g <= 500; g += GRID) {
      ctx.moveTo(X(g), 0); ctx.lineTo(X(g), S);
      ctx.moveTo(0, Y(g)); ctx.lineTo(S, Y(g));
    }
    ctx.stroke();

    // The edge of the playable world
    ctx.strokeStyle = "rgba(255, 90, 60, 0.55)";
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.arc(X(0), Y(0), PLAY_RADIUS * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Roads: a dark casing and a pale top, like a road atlas
    for (const r of this.sources.roads?.() ?? []) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const [w, col] of [[r.width * k + 3, "rgba(24, 18, 12, 0.8)"], [r.width * k, "#b9ad96"]]) {
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(2.5, w);
        ctx.beginPath();
        for (let i = 0; i < r.pts.length; i += 2) {
          const x = X(r.pts[i]), y = Y(r.pts[i + 1]);
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        if (r.closed) ctx.closePath();
        ctx.stroke();
      }
    }

    // Buildings, trees, rocks
    for (const o of this.sources.obstacles?.() ?? []) {
      if (o.x > 1e5 || o.vehicle) continue; // hidden editable model; the rickshaw gets its own icon
      if (o.type === "circle") {
        if (o.r < 0.6) continue;
        ctx.fillStyle = o.r > 1.4 ? "rgba(30, 44, 22, 0.75)" : "rgba(150, 145, 130, 0.65)";
        ctx.beginPath();
        ctx.arc(X(o.x), Y(o.z), Math.max(1.3, o.r * k * 0.8), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.save();
        ctx.translate(X(o.x), Y(o.z));
        ctx.rotate(Math.PI - o.rot);
        // Yard walls are thin lines; buildings at least a few pixels
        const min = o.wall ? 1.2 : 3;
        const w = Math.max(min, o.w * k), d = Math.max(min, o.d * k);
        ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
        ctx.fillRect(-w / 2 + 1.5, -d / 2 + 1.5, w, d);
        ctx.fillStyle = "#d9c9a8";
        ctx.strokeStyle = "#3a2c1e";
        ctx.lineWidth = 1;
        ctx.fillRect(-w / 2, -d / 2, w, d);
        ctx.strokeRect(-w / 2, -d / 2, w, d);
        ctx.restore();
      }
    }

    for (const f of this.sources.fires?.() ?? []) {
      const r = Math.max(3, 2.5 * k);
      const grad = ctx.createRadialGradient(X(f.x), Y(f.z), 0, X(f.x), Y(f.z), r * 1.8);
      grad.addColorStop(0, "rgba(255, 180, 70, 0.95)");
      grad.addColorStop(1, "rgba(255, 60, 10, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(X(f.x), Y(f.z), r * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Cave networks: the tunnels under the hills, dashed, and their mouths
    for (const c of this.sources.caves?.() ?? []) {
      ctx.strokeStyle = "rgba(20, 14, 10, 0.75)";
      ctx.lineWidth = Math.max(2, 4.5 * k);
      ctx.lineCap = "round";
      ctx.setLineDash([Math.max(3, 5 * k), Math.max(3, 4 * k)]);
      ctx.beginPath();
      for (const [ax, az, bx, bz] of c.tunnels) { ctx.moveTo(X(ax), Y(az)); ctx.lineTo(X(bx), Y(bz)); }
      ctx.stroke();
      ctx.setLineDash([]);
      for (const m of c.mouths) {
        const mx = X(m.x), my = Y(m.z);
        ctx.fillStyle = "#120c08";
        ctx.strokeStyle = "#e2a42b";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(mx, my + 2, 5, Math.PI, 0);
        ctx.lineTo(mx + 5, my + 4);
        ctx.lineTo(mx - 5, my + 4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.font = "500 13px 'Teko', 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255, 236, 200, 0.85)";
      ctx.fillText(c.name.toUpperCase(), X(c.x), Y(c.z));
    }

    // Town names
    ctx.textAlign = "center";
    for (const t of this.sources.labels?.() ?? []) {
      const size = Math.round(Math.min(26, 15 + 3 * this.zoom));
      ctx.font = `600 ${size}px 'Teko', 'Segoe UI', sans-serif`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(10, 8, 6, 0.85)";
      ctx.fillStyle = "#fff4dc";
      const ly = Y(t.z) - 18;
      ctx.strokeText(t.name.toUpperCase(), X(t.x), ly);
      ctx.fillText(t.name.toUpperCase(), X(t.x), ly);
    }

    // Vehicles: an icon badge per kind with a health ring (grey with a cross when wrecked).
    // In the battle royale, ones someone else is driving stay off the map (that would give them away).
    const hideDriven = this.sources.hideDriven?.();
    const vr = Math.max(8, Math.min(13, 6 + 2.2 * this.zoom));
    for (const car of this.sources.vehicles?.() ?? []) {
      if (hideDriven && car.driver !== null && car.driver !== "local") continue;
      this._drawVehicle(ctx, X(car.x), Y(car.z), car, vr);
    }

    // Grid letters along the top, numbers down the left (call out "F6")
    ctx.font = "600 13px 'Teko', 'Segoe UI', sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(10, 12, 8, 0.55)";
    ctx.fillRect(0, 0, S, 16);
    ctx.fillRect(0, 16, 16, S - 16);
    ctx.fillStyle = "rgba(255, 240, 210, 0.9)";
    for (let c = 0; c < 10; c++) {
      const gx = X(500 - (c + 0.5) * GRID);
      if (gx > 20 && gx < S - 4) ctx.fillText(GRID_COLS[c], gx, 8.5);
      const gy = Y(500 - (c + 0.5) * GRID);
      if (gy > 22 && gy < S - 4) ctx.fillText(`${c + 1}`, 8, gy);
    }

    this._drawBr(ctx, X, Y, k, S);

    // Route to your pin, then every pin
    const mine = this.myPin;
    if (mine) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(X(me.x), Y(me.z));
      ctx.lineTo(X(mine.x), Y(mine.z));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const [id, p] of this.pins) if (id !== "me") this._drawPin(ctx, X(p.x), Y(p.z), p.color, p.label);
    if (mine) this._drawPin(ctx, X(mine.x), Y(mine.z), mine.color, null, true);

    // Teammates, then you
    for (const t of this.sources.players?.() ?? []) this._arrow(ctx, X(t.x), Y(t.z), t.yaw, t.dead ? "#777" : t.color, 6);
    this._arrow(ctx, X(me.x), Y(me.z), me.yaw, "#fff", 8, "#e2a42b");

    // Compass letters and the scale bar
    ctx.font = "600 15px 'Teko', 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillText("N", S / 2, 12);
    ctx.fillText("S", S / 2, S - 10);
    ctx.fillText("E", S - 10, S / 2);
    ctx.fillText("W", 10, S / 2);
    const bar = cell * k;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(10, S - 30, bar + 16, 20);
    ctx.fillStyle = "#fff";
    ctx.fillRect(18, S - 18, bar, 3);
    ctx.textAlign = "left";
    ctx.fillText(`${cell} m`, 20, S - 25);

    this._updateInfo(me);
  }

  _drawBr(ctx, X, Y, k, S) {
    // Red zones: wherever players are fighting
    for (const f of this.sources.fights?.() ?? []) {
      ctx.fillStyle = "rgba(255, 40, 20, 0.25)";
      ctx.strokeStyle = "#ff3b2a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(f.x), Y(f.z), Math.max(6, f.r * k), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffd9d2";
      ctx.font = "600 12px Teko, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("RED ZONE", X(f.x), Y(f.z) - Math.max(6, f.r * k) - 4);
    }
    const s = this.sources.br?.();
    if (!s) return;
    if (s.zone) {
      ctx.fillStyle = "rgba(40, 110, 255, 0.3)";
      ctx.beginPath();
      ctx.rect(0, 0, S, S);
      ctx.arc(X(s.zone.x), Y(s.zone.z), Math.max(0, s.zone.r * k), 0, Math.PI * 2, true);
      ctx.fill("evenodd");
      ctx.strokeStyle = "#4da3ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(s.zone.x), Y(s.zone.z), Math.max(0, s.zone.r * k), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (s.next) {
      ctx.strokeStyle = "#fff";
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(X(s.next.x), Y(s.next.z), Math.max(0, s.next.r * k), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (s.route) {
      ctx.strokeStyle = "rgba(255, 230, 120, 0.85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 6]);
      ctx.beginPath();
      ctx.moveTo(X(s.route.ax), Y(s.route.az));
      ctx.lineTo(X(s.route.bx), Y(s.route.bz));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (s.plane) {
      ctx.save();
      ctx.translate(X(s.plane.x), Y(s.plane.z));
      ctx.rotate(Math.atan2(-s.plane.dx, s.plane.dz));
      ctx.fillStyle = "#ffe066";
      ctx.beginPath();
      ctx.moveTo(0, -10); ctx.lineTo(8, 6); ctx.lineTo(0, 2); ctx.lineTo(-8, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /** Map-pin shape whose point sits on (x, y). */
  _drawPin(ctx, x, y, color, label, mine = false) {
    const r = mine ? 9 : 7;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.6, r * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.strokeStyle = "#140c06";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-r * 0.4, -r * 0.9, -r, -r * 1.3, -r, -r * 2);
    ctx.arc(0, -r * 2, r, Math.PI, 0);
    ctx.bezierCurveTo(r, -r * 1.3, r * 0.4, -r * 0.9, 0, 0);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#140c06";
    ctx.beginPath();
    ctx.arc(0, -r * 2, r * 0.38, 0, Math.PI * 2);
    ctx.fill();
    if (label) {
      ctx.font = "600 13px 'Teko', 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#fff";
      ctx.fillText(label, 0, -r * 3.3);
    }
    ctx.restore();
  }

  /** A vehicle badge: coloured disc with its icon, a ring for its health, a cross when wrecked. */
  _drawVehicle(ctx, x, y, car, r) {
    const [name, colour] = VEHICLE_ICON[car.kind] ?? VEHICLE_ICON.thar;
    const frac = car.healthFrac ?? 1, wrecked = frac <= 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath();
    ctx.arc(1, 1.5, r + 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = wrecked ? "#5a5a5a" : colour;
    ctx.strokeStyle = "#140c06";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const p = iconPath(name);
    if (p) {
      const s = (r * 1.45) / 512;
      ctx.save();
      ctx.translate(-r * 0.725, -r * 0.725);
      ctx.scale(s, s);
      ctx.fillStyle = wrecked ? "#2a2a2a" : "#15110a";
      ctx.fill(p);
      ctx.restore();
    }
    // Health: a ring round the badge, green to red
    if (!wrecked && frac < 0.999) {
      ctx.strokeStyle = frac > 0.5 ? "#7ee05a" : frac > 0.25 ? "#ffc23d" : "#ff4b3a";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, r + 2.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
      ctx.stroke();
    }
    if (wrecked) {
      ctx.strokeStyle = "#ff4b3a";
      ctx.lineWidth = 2.5;
      const c = r * 0.75;
      ctx.beginPath();
      ctx.moveTo(-c, -c); ctx.lineTo(c, c);
      ctx.moveTo(c, -c); ctx.lineTo(-c, c);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Heading arrow; yaw is world yaw (forward = (sin, cos)), drawn north-up. */
  _arrow(ctx, x, y, yaw, fill, s, stroke = "rgba(0,0,0,0.85)") {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-yaw);
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.75, s * 0.75);
    ctx.lineTo(0, s * 0.35);
    ctx.lineTo(-s * 0.75, s * 0.75);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }

  _updateInfo(me) {
    const p = this.myPin;
    let info = "No pin set";
    if (p) {
      const d = Math.hypot(p.x - me.x, p.z - me.z);
      info = `${Math.round(d)} m · ${headingName(bearingDeg(me.x, me.z, p.x, p.z))}`;
    }
    if (info === this._info) return;
    this._info = info;
    this.pinText.textContent = info;
    this.pinDot.style.background = p ? p.color : "transparent";
    this.clearBtn.disabled = !p;
  }
}
