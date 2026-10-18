// Mouse-wheel weapon carousel: a 3D ring of weapon cards orbiting the player,
// modelled on React Bits' "Circular Carousel" (3D ring, bendable cards,
// momentum, snapping, click to focus), in plain DOM + CSS transforms.
// Scrolling turns the ring one card at a time; the front card is the pick.
// It owns no game state: main.js opens it, steps it, and equips on confirm.

const RADIUS = 250;          // px, ring radius before the screen-size scale
const TILT = -16;            // deg, ring leans back so the far side rises behind the player
const SPRING = 90;           // spin spring stiffness
const DAMP = 15;             // and its damping

export class WeaponWheel {
  /** order: every weapon id in slot order; icons/defs: id → icon URL / weapon def. */
  constructor({ order, icons, defs }) {
    this.order = order;
    this.step = 360 / order.length;
    this.isOpen = false;
    this.index = 0;          // selected card (index into order)
    this.angle = 0;          // shown ring angle, deg
    this.target = 0;         // angle the spring snaps to
    this.vel = 0;            // deg/s, also bends the cards
    this.idle = 0;           // real seconds since the last scroll
    this._fade = 0;          // 0 hidden … 1 shown
    this._owned = new Set();
    this._slow = -1;
    this._x = -1; this._y = -1; this._scale = -1;

    this.root = document.createElement("div");
    this.root.id = "weapon-wheel";
    this.root.innerHTML = `
      <div class="ww-slowmo"><span>TIME SLOWED</span></div>
      <div class="ww-anchor">
        <div class="ww-stage"><div class="ww-ring"></div></div>
        <div class="ww-label"><b></b><small></small></div>
        <div class="ww-hint">SCROLL · CLICK TO EQUIP · RIGHT-CLICK CANCEL</div>
      </div>`;
    this.anchorEl = this.root.querySelector(".ww-anchor");
    this.ringEl = this.root.querySelector(".ww-ring");
    this.slowEl = this.root.querySelector(".ww-slowmo");
    this.nameEl = this.root.querySelector(".ww-label b");
    this.ammoEl = this.root.querySelector(".ww-label small");

    this.cards = order.map((id, i) => {
      const el = document.createElement("div");
      el.className = "ww-card";
      el.innerHTML = `
        <div class="ww-face">
          <span class="ww-slot">${defs[id].slot}</span>
          <img src="${icons[id]}" alt="">
          <span class="ww-name">${defs[id].short}</span>
          <span class="ww-ammo"></span>
        </div>`;
      this.ringEl.append(el);
      return { id, el, base: i * this.step, ammoEl: el.querySelector(".ww-ammo"), op: -1, cls: "" };
    });
    document.body.append(this.root);
  }

  /** owned: ids the player carries; current: the held one; ammo(id) → "12 / 90". */
  open(owned, current, ammo) {
    this._owned = new Set(owned);
    this._ammo = ammo;
    const i = Math.max(0, this.order.indexOf(current));
    if (!this.isOpen) {
      this.index = i;
      // Spin in from a quarter turn away, so opening reads as the ring arriving
      this.target = -i * this.step;
      this.angle = this.target + 70;
      this.vel = 0;
    }
    for (const c of this.cards) {
      const has = this._owned.has(c.id);
      c.el.classList.toggle("locked", !has);
      c.ammoEl.textContent = has ? ammo(c.id) : "NOT FOUND";
    }
    this.isOpen = true;
    this.idle = 0;
    this.root.classList.add("open");
    this._label();
  }

  /** One notch: to the next owned weapon in that direction. Returns true if it moved. */
  turn(dir) {
    this.idle = 0;
    const n = this.order.length;
    for (let k = 1; k < n; k++) {
      const j = (this.index + dir * k + n * k) % n;
      if (!this._owned.has(this.order[j])) continue;
      this.index = j;
      this.target -= dir * this.step * k;   // keep spinning the same way, never the long way round
      this._label();
      return true;
    }
    return false;
  }

  get selected() { return this.order[this.index]; }

  close() {
    this.isOpen = false;
    this.root.classList.remove("open");
  }

  _label() {
    const id = this.selected;
    this.nameEl.textContent = this.cards[this.index].el.querySelector(".ww-name").textContent;
    this.ammoEl.textContent = this._ammo ? this._ammo(id) : "";
  }

  /**
   * realDt: unscaled frame time. (x, y): the player's chest on screen, px.
   * slow: whether the world is in slow motion right now.
   */
  update(realDt, x, y, slow) {
    this._fade += ((this.isOpen ? 1 : 0) - this._fade) * Math.min(1, realDt * 14);
    if (this.isOpen) this.idle += realDt;
    if (slow !== this._slow) { this._slow = slow; this.slowEl.classList.toggle("on", slow); }
    if (!this.isOpen && this._fade < 0.01) return;

    // Spring toward the snapped angle: momentum while spinning, a settle at the end
    const dt = Math.min(realDt, 0.05);
    this.vel += ((this.target - this.angle) * SPRING - this.vel * DAMP) * dt;
    this.angle += this.vel * dt;

    const scale = Math.min(1, Math.min(innerWidth, innerHeight) / 820) * (0.82 + 0.18 * this._fade);
    if (Math.abs(x - this._x) > 0.5 || Math.abs(y - this._y) > 0.5 || scale !== this._scale) {
      this._x = x; this._y = y; this._scale = scale;
      this.anchorEl.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
    }
    this.ringEl.style.transform = `rotateX(${TILT}deg) rotateY(${this.angle.toFixed(2)}deg)`;

    // Bend: cards lean against the spin, like the carousel's flexing cards
    const bend = Math.max(-28, Math.min(28, -this.vel * 0.05));
    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i];
      // How far round the ring this card is from the front (0 = facing you)
      let a = (c.base + this.angle) % 360;
      if (a > 180) a -= 360; else if (a < -180) a += 360;
      const front = Math.cos(a * Math.PI / 180);         // 1 front … −1 back
      const op = (0.18 + 0.82 * Math.max(0, front) ** 1.5) * this._fade;
      const s = i === this.index ? 1.12 : 0.9;
      c.el.style.transform =
        `rotateY(${c.base}deg) translateZ(${RADIUS}px) rotateY(${bend.toFixed(1)}deg) skewY(${(bend * 0.25).toFixed(1)}deg) scale(${s})`;
      if (Math.abs(op - c.op) > 0.01) { c.op = op; c.el.style.opacity = op.toFixed(2); }
      const cls = i === this.index ? "active" : "";
      if (cls !== c.cls) { c.cls = cls; c.el.classList.toggle("active", !!cls); }
    }
  }
}
