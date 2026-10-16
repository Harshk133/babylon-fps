// Battle royale HUD: alive / kills / zone status bar, the "outside the zone"
// overlay, context hints, the spectator bar and result screens. Also the big
// map (M), which every mode uses: zone, plane route, gunfire, and a pin you
// place by clicking / tapping. Builds its own DOM; setters only write when the
// value changes.

const MAP_WORLD_R = 265;   // metres from the map centre to its edge
const MAP_HZ = 12;

function el(tag, id, cls) {
  const e = document.createElement(tag);
  if (id) e.id = id;
  if (cls) e.className = cls;
  return e;
}

/** A map pin whose tip is at (x, y). */
export function drawPin(ctx, x, y, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffd84d";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-3, -6, -7, -9, -7, -14);
  ctx.arc(0, -14, 7, Math.PI, 0);
  ctx.bezierCurveTo(7, -9, 3, -6, 0, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#3a2a00";
  ctx.beginPath();
  ctx.arc(0, -14, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export class BrHud {
  constructor() {
    this.root = el("div", "br-hud");

    this.top = el("div", "br-top");
    this.aliveEl = el("span", null, "br-alive");
    this.killsEl = el("span", null, "br-kills");
    this.statusEl = el("div", null, "br-status");
    const stats = el("div", null, "br-stats");
    stats.append(this.aliveEl, this.killsEl);
    this.top.append(stats, this.statusEl);

    this.warn = el("div", "br-zone-warn");
    this.warnText = el("div", null, "br-warn-text");
    this.warn.append(this.warnText);

    this.hint = el("div", "br-hint");

    this.spec = el("div", "br-spec");
    this.specName = el("span", null, "br-spec-name");
    const specKeys = el("span", null, "br-spec-keys");
    specKeys.innerHTML = "<kbd>A</kbd><kbd>D</kbd> or click: next player";
    this.spec.append(el("span", null, "br-spec-label"), this.specName, specKeys);
    this.spec.firstChild.textContent = "SPECTATING";

    this.result = el("div", "br-result");
    this.resTitle = el("div", null, "br-res-title");
    this.resSub = el("div", null, "br-res-sub");
    this.resLines = el("div", null, "br-res-lines");
    this.resFoot = el("div", null, "br-res-foot");
    this.result.append(this.resTitle, this.resSub, this.resLines, this.resFoot);
    this._resultTimer = 0;

    this.map = el("div", "br-map");
    this.mapCanvas = document.createElement("canvas");
    const mapHead = el("div", null, "br-map-head");
    mapHead.innerHTML = "MAP <span class=\"br-map-tip\">Click / tap to pin a place</span>";
    this.clearPinBtn = el("button", null, "br-map-clear");
    this.clearPinBtn.type = "button";
    this.clearPinBtn.textContent = "Clear pin";
    const closeBtn = el("button", null, "br-map-close");
    closeBtn.type = "button";
    closeBtn.innerHTML = "<kbd>M</kbd> Close";
    mapHead.append(this.clearPinBtn, closeBtn);
    this.map.append(mapHead, this.mapCanvas);
    this.mapCtx = this.mapCanvas.getContext("2d");
    this.mapOpen = false;
    this._mapNext = 0;
    this._k = 1;
    this._c = 0;
    /** (x, z, pinHit) when the map is clicked; pinHit = the click landed on the current pin. */
    this.onMapClick = null;
    this.onClearPin = null;
    this.onClose = null;
    this.mapCanvas.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      const r = this.mapCanvas.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const x = (this._c - px) / this._k, z = (this._c - py) / this._k;
      const pin = this._lastPin;
      const hit = !!pin && Math.hypot(this._c - pin.x * this._k - px, this._c - pin.z * this._k - py) < 14;
      this.onMapClick?.(x, z, hit);
      this._mapNext = 0;
    });
    this.clearPinBtn.addEventListener("pointerdown", e => { e.stopPropagation(); this.onClearPin?.(); this._mapNext = 0; });
    closeBtn.addEventListener("pointerdown", e => { e.stopPropagation(); this.onClose?.(); });
    this.map.addEventListener("pointerdown", e => e.stopPropagation());

    this.root.append(this.warn, this.top, this.hint, this.spec, this.result);
    document.body.append(this.root, this.map); // the map works outside the battle royale too
    this._c = {};
  }

  _set(key, value, apply) {
    if (this._c[key] === value) return;
    this._c[key] = value;
    apply(value);
  }

  setVisible(on) {
    this._set("vis", on, v => this.root.classList.toggle("on", v));
    if (!on) { this.setMapOpen(false); this.hideResult(); }
  }

  /** kind: "" | "warn" | "danger" colours the status line. */
  setTop(alive, kills, status, kind = "") {
    this._set("alive", alive, v => { this.aliveEl.innerHTML = v === null ? "" : `<b>${v}</b> ALIVE`; });
    this._set("kills", kills, v => { this.killsEl.innerHTML = `<b>${v}</b> KILLS`; });
    this._set("status", status, v => { this.statusEl.textContent = v; });
    this._set("kind", kind, v => { this.statusEl.dataset.kind = v; });
  }

  setOutside(outside, text) {
    this._set("out", outside, v => this.warn.classList.toggle("on", v));
    if (outside) this._set("outText", text, v => { this.warnText.textContent = v; });
  }

  setHint(html) {
    this._set("hint", html, v => {
      this.hint.innerHTML = v;
      this.hint.classList.toggle("on", !!v);
    });
  }

  setSpectating(name, color) {
    this._set("spec", name, v => {
      this.spec.classList.toggle("on", !!v);
      if (v) this.specName.textContent = v;
    });
    if (name) this._set("specColor", color, v => this.specName.style.color = v);
  }

  /** duration 0 keeps it up until hideResult(). */
  showResult({ title, sub = "", lines = [], foot = "", color = "#e2a42b", duration = 0 }) {
    this.resTitle.textContent = title;
    this.resSub.textContent = sub;
    this.resLines.replaceChildren(...lines.map(([k, v]) => {
      const row = el("div", null, "br-res-row");
      const a = el("span"); a.textContent = k;
      const b = el("b"); b.textContent = v;
      row.append(a, b);
      return row;
    }));
    this.resFoot.textContent = foot;
    this.result.style.setProperty("--accent", color);
    this.result.classList.remove("on");
    void this.result.offsetWidth;
    this.result.classList.add("on");
    this._resultTimer = duration;
  }

  setResultFoot(text) {
    this._set("resFoot", text, v => { this.resFoot.textContent = v; });
  }

  hideResult() {
    this.result.classList.remove("on");
    this._resultTimer = 0;
  }

  get resultShown() { return this.result.classList.contains("on"); }

  setMapOpen(open) {
    if (open === this.mapOpen) return;
    this.mapOpen = open;
    this.map.classList.toggle("on", open);
    this._mapNext = 0;
  }

  update(delta) {
    if (this._resultTimer > 0) {
      this._resultTimer -= delta;
      if (this._resultTimer <= 0) this.result.classList.remove("on");
    }
  }

  /**
   * s: { zone, next, route, plane, me:{x,z,yaw}, obstacles, gunfire, pin }
   * zone / next: { x, z, r } or null. route: { ax, az, bx, bz } or null.
   * gunfire: [{ x, z, r, life }] recent shooting. pin: { x, z } or null.
   */
  drawMap(now, s) {
    if (!this.mapOpen || now < this._mapNext) return;
    this._mapNext = now + 1000 / MAP_HZ;
    const cv = this.mapCanvas;
    const css = cv.clientWidth || 440;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(css * dpr)) { cv.width = cv.height = Math.round(css * dpr); }
    const ctx = this.mapCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = css, c = S / 2, k = (S / 2 - 6) / MAP_WORLD_R;
    this._k = k;
    this._c = c;
    this._lastPin = s.pin;
    this.clearPinBtn.hidden = !s.pin;
    // North (+Z) up, east (−X) right, like the minimap compass
    const X = x => c - x * k, Y = z => c - z * k;

    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = "#1d2416";
    ctx.fillRect(0, 0, S, S);
    // Grid every 50 m
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = -250; g <= 250; g += 50) {
      ctx.moveTo(X(g), 0); ctx.lineTo(X(g), S);
      ctx.moveTo(0, Y(g)); ctx.lineTo(S, Y(g));
    }
    ctx.stroke();

    for (const o of s.obstacles) {
      if (o.type === "circle") {
        if (o.r < 1.5) continue;
        ctx.fillStyle = "rgba(90,120,60,0.45)";
        ctx.beginPath();
        ctx.arc(X(o.x), Y(o.z), Math.max(1.2, o.r * k), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.save();
        ctx.translate(X(o.x), Y(o.z));
        ctx.rotate(Math.PI - o.rot);
        ctx.fillStyle = "rgba(215,195,160,0.75)";
        ctx.fillRect(-o.w * k / 2, -o.d * k / 2, o.w * k, o.d * k);
        ctx.restore();
      }
    }

    if (s.zone) {
      // Everything outside the zone is tinted blue
      ctx.fillStyle = "rgba(40,110,255,0.32)";
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
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(X(s.next.x), Y(s.next.z), Math.max(0, s.next.r * k), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (s.route) {
      ctx.strokeStyle = "rgba(255,230,120,0.85)";
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
      ctx.moveTo(0, -9); ctx.lineTo(7, 5); ctx.lineTo(0, 2); ctx.lineTo(-7, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // Gunfire: red zones with how far away they are
    const pulse = 0.5 + 0.5 * Math.sin(now / 160);
    ctx.font = "600 15px 'Teko', 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const f of s.gunfire ?? []) {
      const fade = Math.min(1, f.life / 3);
      const r = Math.max(7, f.r * k);
      ctx.fillStyle = `rgba(255, 40, 30, ${(0.22 + pulse * 0.18) * fade})`;
      ctx.strokeStyle = `rgba(255, 70, 50, ${0.9 * fade})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(f.x), Y(f.z), r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (s.me) {
        ctx.fillStyle = `rgba(255, 210, 200, ${fade})`;
        ctx.fillText(`${Math.round(Math.hypot(f.x - s.me.x, f.z - s.me.z))} m`, X(f.x), Y(f.z) - r - 8);
      }
    }

    // Pin: a dashed route from you, the distance, and the marker
    if (s.pin && s.me) {
      ctx.strokeStyle = "#ffd84d";
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 6]);
      ctx.lineDashOffset = -now / 40;
      ctx.beginPath();
      ctx.moveTo(X(s.me.x), Y(s.me.z));
      ctx.lineTo(X(s.pin.x), Y(s.pin.z));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      drawPin(ctx, X(s.pin.x), Y(s.pin.z), 1.2);
      ctx.fillStyle = "#ffd84d";
      ctx.fillText(`${Math.round(Math.hypot(s.pin.x - s.me.x, s.pin.z - s.me.z))} m`, X(s.pin.x), Y(s.pin.z) + 12);
    }

    if (s.me) {
      ctx.save();
      ctx.translate(X(s.me.x), Y(s.me.z));
      // Heading: forward (sin yaw, cos yaw) in world → (−sin, −cos) on screen
      ctx.rotate(-s.me.yaw);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#e2a42b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -8); ctx.lineTo(6, 6); ctx.lineTo(0, 3); ctx.lineTo(-6, 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    // Compass letters
    ctx.font = "700 13px 'Teko', 'Segoe UI', sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("N", c, 12);
    ctx.fillText("S", c, S - 10);
    ctx.fillText("E", S - 10, c);
    ctx.fillText("W", 10, c);
  }
}
