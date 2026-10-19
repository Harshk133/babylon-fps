// Rotating radar-style minimap drawn on a 2D canvas. Player is always centred
// and facing up; the world turns around them. Redrawn at a capped rate (not
// every frame) and only touches the heading DOM when it changes.

const MAP_RANGE   = 60;    // metres from centre to edge
const REDRAW_HZ   = navigator.maxTouchPoints > 0 && matchMedia("(pointer: coarse)").matches ? 20 : 30; // phones: 20
const EDGE_RANGE  = 160;   // weapon pickups this close but off-map get an edge marker
const LAYER_MOVE  = 8;     // metres you can move before the static layer is redrawn
const CARDINALS   = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
const HEADINGS    = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

const CAT_COLOR = {
  weapon:    "#ffa630",
  ammo:      "#ffe066",
  throwable: "#ff5a3a",
  medkit:    "#4dff88",
  fuel:      "#37e0c8",
};

export class Minimap {
  /**
   * sources: functions returning live lists, so the minimap never owns game state.
   *   zombies()   → [{ body:{position}, state, def:{color, bigBody, boss}, dying, burnTimer }]
   *   pickups()   → [{ x, z, def:{category} }]
   *   fires()     → [{ active, x, z, time }]
   *   obstacles() → [{ type:"box", x, z, w, d, rot } | { type:"circle", x, z, r }]
   *   pins()      → [{ x, z, color }]   map pins (kept on the rim when out of range)
   */
  constructor(root, sources) {
    this.sources = sources;
    this.canvas = root.querySelector("canvas");
    this.headingEl = root.querySelector(".mm-heading");
    this.coordsEl = root.querySelector(".mm-coords");
    this.ctx = this.canvas.getContext("2d");
    this._next = 0;
    this._heading = "";
    this._coords = "";
    this._resize();
    window.addEventListener("resize", () => this._resize());
  }

  _resize() {
    const css = this.canvas.clientWidth || 200;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(css * dpr);
    this.canvas.height = Math.round(css * dpr);
    this.scale = dpr;
    this.size = css;
    this._next = 0;
    this._layer = null; // redraw the static layer at the new size
  }

  /** px, pz: player position. yaw: camera yaw (forward = (sin yaw, cos yaw)). */
  update(now, px, pz, yaw) {
    if (now < this._next) return;
    this._next = now + 1000 / REDRAW_HZ;

    const ctx = this.ctx;
    const S = this.size;
    const c = S / 2;
    const R = c - 16;                 // map disc radius; the rim holds the compass
    const k = R / MAP_RANGE;          // px per metre
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    // World → map: right = (−cos, sin), forward = (sin, cos); forward is up
    const mx = (x, z) => c + ((x - px) * -cy + (z - pz) * sy) * k;
    const my = (x, z) => c - ((x - px) * sy + (z - pz) * cy) * k;

    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.clearRect(0, 0, S, S);

    // ── Disc background
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.clip();
    const bg = ctx.createRadialGradient(c, c, 0, c, c, R);
    bg.addColorStop(0, "rgba(38, 30, 22, 0.88)");
    bg.addColorStop(1, "rgba(12, 9, 7, 0.92)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, S, S);

    // Grid, trees, rocks and buildings: one pre-drawn north-up layer, turned
    // to the heading (redrawn only after you've moved a few metres)
    const L = this._staticLayer(px, pz, k);
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(yaw);
    ctx.drawImage(L.canvas, (px - L.x) * k - L.half, (pz - L.z) * k - L.half, L.half * 2, L.half * 2);
    ctx.restore();

    // Range rings
    ctx.strokeStyle = "rgba(255, 220, 180, 0.1)";
    for (const r of [20, 40]) {
      ctx.beginPath();
      ctx.arc(c, c, r * k, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ── Live obstacles: house doors (open / shut) and the rickshaw
    for (const o of this.sources.obstacles()) {
      if (!o.door && !o.vehicle) continue;
      const dx = o.x - px, dz = o.z - pz;
      if (dx * dx + dz * dz > (MAP_RANGE + 30) ** 2) continue;
      const ox = mx(o.x, o.z), oy = my(o.x, o.z);
      if (o.type === "circle") {
        ctx.fillStyle = "rgba(110, 140, 80, 0.32)";
        ctx.beginPath();
        ctx.arc(ox, oy, Math.max(2, o.r * k), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.save();
        ctx.translate(ox, oy);
        // In this rotated frame canvas x = the object's local X, canvas y = its local Z
        ctx.rotate(Math.PI + yaw - o.rot);
        ctx.fillStyle = "rgba(210, 190, 160, 0.26)";
        ctx.strokeStyle = "rgba(240, 220, 190, 0.45)";
        ctx.fillRect(-o.w * k / 2, -o.d * k / 2, o.w * k, o.d * k);
        ctx.strokeRect(-o.w * k / 2, -o.d * k / 2, o.w * k, o.d * k);
        if (o.door) {
          ctx.strokeStyle = o.door.open ? "#4dff88" : "#ff5a3a";
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo((o.door.x - o.door.half) * k, o.door.z * k);
          ctx.lineTo((o.door.x + o.door.half) * k, o.door.z * k);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        ctx.restore();
      }
    }

    // ── Battle royale zone: blue outside the safe circle, next circle dashed white
    const zone = this.sources.zone?.();
    if (zone) {
      const zx = mx(zone.x, zone.z), zy = my(zone.x, zone.z);
      ctx.fillStyle = "rgba(40, 110, 255, 0.3)";
      ctx.beginPath();
      ctx.rect(0, 0, S, S);
      ctx.arc(zx, zy, Math.max(0, zone.r * k), 0, Math.PI * 2, true);
      ctx.fill("evenodd");
      ctx.strokeStyle = "#4da3ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(zx, zy, Math.max(0, zone.r * k), 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(mx(zone.nx, zone.nz), my(zone.nx, zone.nz), Math.max(0, zone.nr * k), 0, Math.PI * 2);
      ctx.stroke();
      // Outside the next circle: a line toward its centre
      if (Math.hypot(zone.nx - px, zone.nz - pz) > zone.nr) {
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(mx(zone.nx, zone.nz), my(zone.nx, zone.nz));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }

    // ── Fires
    for (const f of this.sources.fires()) {
      if (!f.active) continue;
      const fx = mx(f.x, f.z), fy = my(f.x, f.z);
      const r = 3.4 * k * (1 + Math.sin(now / 120) * 0.08);
      const grad = ctx.createRadialGradient(fx, fy, 0, fx, fy, r * 1.6);
      grad.addColorStop(0, "rgba(255, 170, 60, 0.9)");
      grad.addColorStop(0.5, "rgba(255, 90, 20, 0.5)");
      grad.addColorStop(1, "rgba(255, 60, 10, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(fx, fy, r * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Pickups (diamonds)
    const R2 = (MAP_RANGE * 1.02) ** 2;
    const edges = [];
    for (const p of this.sources.pickups()) {
      const dx = p.x - px, dz = p.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) {
        if (p.def.category === "weapon" && d2 < EDGE_RANGE * EDGE_RANGE) edges.push(p);
        continue;
      }
      const ix = mx(p.x, p.z), iy = my(p.x, p.z);
      const s = p.def.category === "weapon" ? 4.2 : 3.2;
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      this._diamond(ix, iy + 1, s + 1.2);
      ctx.fillStyle = CAT_COLOR[p.def.category];
      this._diamond(ix, iy, s);
    }

    // ── Zombies
    const pulse = 0.5 + Math.sin(now / 160) * 0.5;
    for (const z of this.sources.zombies()) {
      const zp = z.body.position;
      const dx = zp.x - px, dz = zp.z - pz;
      if (dx * dx + dz * dz > R2) continue;
      const zx = mx(zp.x, zp.z), zy = my(zp.x, zp.z);
      if (z.dying) {
        ctx.fillStyle = "rgba(120, 40, 30, 0.6)";
        ctx.fillRect(zx - 1.5, zy - 1.5, 3, 3);
        continue;
      }
      const hunting = z.state === "chase" || z.state === "alert";
      const size = z.def.flying ? 6 : z.def.boss ? 5 : z.def.bigBody ? 3.8 : 2.6;
      if (hunting) {
        ctx.strokeStyle = `rgba(255, 60, 40, ${0.25 + pulse * 0.35})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(zx, zy, size + 2 + pulse * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Type colour; dimmer while they haven't noticed you
      ctx.globalAlpha = hunting ? 1 : 0.55;
      ctx.fillStyle = z.burnTimer > 0 ? "#ffa13a" : z.def.color;
      ctx.beginPath();
      if (z.def.flying) {
        // Flyers: a triangle, so you know to look up
        ctx.moveTo(zx, zy - size);
        ctx.lineTo(zx + size, zy + size * 0.75);
        ctx.lineTo(zx - size, zy + size * 0.75);
        ctx.closePath();
      } else {
        ctx.arc(zx, zy, hunting ? size + 0.5 : size, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // ── Teammates: arrows in their colour (grey when down)
    for (const t of this.sources.players?.() ?? []) {
      const dx = t.x - px, dz = t.z - pz;
      let tx = mx(t.x, t.z), ty = my(t.x, t.z);
      const off = dx * dx + dz * dz > R2;
      if (off) {
        // Pin to the rim so you always know which way your squad is
        const a = Math.atan2(ty - c, tx - c);
        tx = c + Math.cos(a) * (R - 6); ty = c + Math.sin(a) * (R - 6);
      }
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(yaw - t.yaw); // world yaw → screen, same frame as the player arrow
      ctx.fillStyle = t.dead ? "#777" : t.color;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(4.5, 5);
      ctx.lineTo(0, 2.5);
      ctx.lineTo(-4.5, 5);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.restore();
    }

    // ── Pins: a drop on the map, or on the rim pointing the way
    for (const p of this.sources.pins?.() ?? []) {
      const dx = p.x - px, dz = p.z - pz;
      let qx = mx(p.x, p.z), qy = my(p.x, p.z);
      if (dx * dx + dz * dz > (MAP_RANGE * 0.92) ** 2) {
        const a = Math.atan2(qy - c, qx - c);
        qx = c + Math.cos(a) * (R - 9); qy = c + Math.sin(a) * (R - 9);
      }
      ctx.fillStyle = p.color;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(qx, qy + 6);
      ctx.lineTo(qx - 4.5, qy - 1);
      ctx.arc(qx, qy - 1.5, 4.5, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // ── View cone + player arrow
    const cone = ctx.createRadialGradient(c, c, 0, c, c, R);
    cone.addColorStop(0, "rgba(255, 236, 200, 0.22)");
    cone.addColorStop(1, "rgba(255, 236, 200, 0)");
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, R, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.restore(); // end disc clip

    // Edge markers for weapons just off the map
    for (const p of edges) {
      const dx = (p.x - px) * -cy + (p.z - pz) * sy;
      const dy = -((p.x - px) * sy + (p.z - pz) * cy);
      const a = Math.atan2(dy, dx);
      const ex = c + Math.cos(a) * (R - 5), ey = c + Math.sin(a) * (R - 5);
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(a);
      ctx.fillStyle = CAT_COLOR.weapon;
      ctx.beginPath();
      ctx.moveTo(4, 0);
      ctx.lineTo(-3, -3.5);
      ctx.lineTo(-3, 3.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(c, c);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#e2a42b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // ── Rim: bezel + compass ticks + cardinals (rotate with heading)
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(226, 164, 43, 0.7)";
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.beginPath();
    ctx.arc(c, c, R + 4, 0, Math.PI * 2);
    ctx.stroke();

    // Heading in compass degrees: 0 = +Z (north), clockwise toward −X (east)
    const headingRad = -yaw;
    for (let deg = 0; deg < 360; deg += 15) {
      const a = (deg * Math.PI) / 180 - headingRad - Math.PI / 2;
      const major = deg % 45 === 0;
      const r0 = R + 2, r1 = R + (major ? 8 : 5);
      ctx.strokeStyle = major ? "rgba(255, 240, 220, 0.7)" : "rgba(255, 240, 220, 0.3)";
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
      ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.font = "800 11px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [label, deg] of CARDINALS) {
      const a = (deg * Math.PI) / 180 - headingRad - Math.PI / 2;
      const lx = c + Math.cos(a) * (R + 1), ly = c + Math.sin(a) * (R + 1);
      ctx.fillStyle = "rgba(10, 6, 4, 0.9)";
      ctx.beginPath();
      ctx.arc(lx, ly, 7.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = label === "N" ? "#ff4b3a" : "#f2e6d8";
      ctx.fillText(label, lx, ly + 0.5);
    }

    // ── Heading readout (DOM, only when changed)
    let deg = Math.round(((headingRad * 180) / Math.PI) % 360);
    if (deg < 0) deg += 360;
    const heading = `${HEADINGS[Math.round(deg / 45) % 8]} ${String(deg).padStart(3, "0")}°`;
    if (heading !== this._heading) {
      this._heading = heading;
      this.headingEl.textContent = heading;
    }
    const coords = `${Math.round(-px)}, ${Math.round(pz)}`;
    if (coords !== this._coords) {
      this._coords = coords;
      this.coordsEl.textContent = coords;
    }
  }

  /** North-up layer of the grid and static obstacles around (px, pz), reused while you stay near. */
  _staticLayer(px, pz, k) {
    const L = this._layer;
    if (L && L.k === k && Math.hypot(px - L.x, pz - L.z) < LAYER_MOVE) return L;
    const half = MAP_RANGE * 1.5 * k;          // covers the disc at any heading, plus the drift
    const dpr = this.scale;
    const canvas = L?.canvas ?? document.createElement("canvas");
    const size = Math.ceil(half * 2 * dpr);
    if (canvas.width !== size) canvas.width = canvas.height = size;
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, half * 2, half * 2);
    // North-up, east (−X) to the right, like the big map
    const X = x => half - (x - px) * k, Y = z => half - (z - pz) * k;
    const reach = MAP_RANGE * 1.5 + 5;

    g.strokeStyle = "rgba(255, 230, 200, 0.06)";
    g.lineWidth = 1;
    g.beginPath();
    for (let gx = Math.floor((px - reach) / 10) * 10; gx <= px + reach; gx += 10) { g.moveTo(X(gx), 0); g.lineTo(X(gx), half * 2); }
    for (let gz = Math.floor((pz - reach) / 10) * 10; gz <= pz + reach; gz += 10) { g.moveTo(0, Y(gz)); g.lineTo(half * 2, Y(gz)); }
    g.stroke();

    // Roads under everything
    for (const r of this.sources.roads?.() ?? []) {
      g.lineCap = "round";
      g.lineJoin = "round";
      for (const [w, col] of [[r.width * k + 2, "rgba(20, 16, 12, 0.55)"], [r.width * k, "rgba(150, 142, 128, 0.42)"]]) {
        g.strokeStyle = col;
        g.lineWidth = Math.max(2, w);
        g.beginPath();
        for (let i = 0; i < r.pts.length; i += 2) {
          const x = X(r.pts[i]), y = Y(r.pts[i + 1]);
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        if (r.closed) g.closePath();
        g.stroke();
      }
    }

    for (const o of this.sources.obstacles()) {
      if (o.door || o.vehicle || o.pole) continue;
      if (Math.abs(o.x - px) > reach || Math.abs(o.z - pz) > reach) continue;
      if (o.type === "circle") {
        g.fillStyle = "rgba(110, 140, 80, 0.32)";
        g.beginPath();
        g.arc(X(o.x), Y(o.z), Math.max(2, o.r * k), 0, Math.PI * 2);
        g.fill();
      } else {
        g.save();
        g.translate(X(o.x), Y(o.z));
        g.rotate(Math.PI - o.rot);
        g.fillStyle = "rgba(210, 190, 160, 0.26)";
        g.strokeStyle = "rgba(240, 220, 190, 0.45)";
        g.fillRect(-o.w * k / 2, -o.d * k / 2, o.w * k, o.d * k);
        g.strokeRect(-o.w * k / 2, -o.d * k / 2, o.w * k, o.d * k);
        g.restore();
      }
    }
    return (this._layer = { canvas, x: px, z: pz, k, half });
  }

  _diamond(x, y, s) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s, y);
    ctx.lineTo(x, y + s);
    ctx.lineTo(x - s, y);
    ctx.closePath();
    ctx.fill();
  }
}
