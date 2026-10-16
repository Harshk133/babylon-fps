// On-screen controls for phones and tablets, laid out like PUBG Mobile /
// Free Fire: a floating joystick on the left (push it to the top edge to
// sprint), drag anywhere on the right to look, a big fire button you can also
// drag to aim while shooting, and buttons for the rest. Buttons speak the same
// key codes as the keyboard (onKey("KeyR", true)), so the game logic is shared.

const STICK_RADIUS = 56;      // px the knob can travel
const DEAD = 0.32;            // fraction of the radius before a direction counts
const SPRINT_AT = 0.92;       // pushed this far up = sprint

export function isTouchDevice() {
  if (new URLSearchParams(location.search).has("touch")) return true;
  return matchMedia("(pointer: coarse)").matches || (navigator.maxTouchPoints > 0 && !matchMedia("(pointer: fine)").matches);
}

/**
 * Buttons: [id, label, key code | action, mode, title]
 *   mode "hold": key down while pressed (throw aim, handbrake/jump)
 *   mode "tap":  key down + up on press
 */
const BUTTONS = [
  ["fire",   "",       "fire",        "fire",  "Fire (drag to aim)"],
  ["fireL",  "",       "fire",        "fire",  "Fire"],
  ["aim",    "",       "aim",         "act",   "Aim down sights"],
  ["jump",   "",       "Space",       "hold",  "Jump / handbrake"],
  ["reload", "",       "KeyR",        "tap",   "Reload"],
  ["throw",  "",       "KeyG",        "hold",  "Hold to aim, let go to throw"],
  ["swapT",  "⇄",      "KeyQ",        "tap",   "Grenade / Molotov"],
  ["swapW",  "",       "cycle",       "act",   "Next weapon"],
  ["heal",   "+",      "KeyH",        "tap",   "Medkit"],
  ["torch",  "",       "KeyF",        "tap",   "Flashlight"],
  ["map",    "MAP",    "KeyM",        "tap",   "Map"],
  ["bag",    "BAG",    "Tab",         "tap",   "Inventory"],
  ["gyro",   "GYRO",   "gyro",        "act",   "Aim by turning the phone"],
  ["pause",  "❚❚",     "pause",       "act",   "Pause"],
  ["start",  "START",  "Enter",       "tap",   "Start the match"],
];

const ICONS = {
  fire: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 1v5M12 18v5M1 12h5M18 12h5" stroke="currentColor" stroke-width="2"/></svg>',
  fireL: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/></svg>',
  aim: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6" stroke="currentColor" stroke-width="1.8"/></svg>',
  jump: '<svg viewBox="0 0 24 24"><path d="M12 4l7 8h-4v7H9v-7H5z" fill="currentColor"/></svg>',
  reload: '<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M20 3v6h-6" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  throw: '<svg viewBox="0 0 24 24"><circle cx="12" cy="14" r="6" fill="currentColor"/><rect x="10" y="4" width="4" height="4" fill="currentColor"/><path d="M14 5l4-2" stroke="currentColor" stroke-width="2"/></svg>',
  swapW: '<svg viewBox="0 0 24 24"><path d="M3 9h14l-3-3M21 15H7l3 3" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>',
  torch: '<svg viewBox="0 0 24 24"><path d="M7 3h10l-2 6H9z M9 9h6v12H9z" fill="currentColor"/></svg>',
};

export class TouchControls {
  /**
   * cb: { onKey(code, down), onLook(dx, dy), onFire(down), onAction(name), onTap() }
   */
  constructor(cb) {
    this.cb = cb;
    this.enabled = true;
    this.root = document.createElement("div");
    this.root.id = "touch";
    this._shown = {};

    // Right side: drag to look (under the buttons)
    this.look = this._el("div", "tc-look");
    // Left side: floating joystick
    this.stickZone = this._el("div", "tc-stick-zone");
    this.stickBase = this._el("div", "tc-stick-base");
    this.stickKnob = this._el("div", "tc-stick-knob");
    this.stickBase.append(this.stickKnob);
    this.stickZone.append(this.stickBase);
    this.root.append(this.look, this.stickZone);

    this.buttons = {};
    for (const [id, label, key, mode, title] of BUTTONS) {
      const b = this._el("button", `tc-btn tc-${id}`);
      b.type = "button";
      b.title = title;
      b.innerHTML = ICONS[id] ?? `<span>${label}</span>`;
      b.dataset.key = key;
      b.dataset.mode = mode;
      this.root.append(b);
      this.buttons[id] = b;
      this._bindButton(b, key, mode);
    }
    document.body.append(this.root);

    this._stick = { id: null, ox: 0, oy: 0, keys: { KeyW: false, KeyS: false, KeyA: false, KeyD: false, ShiftLeft: false } };
    this._lookP = null;
    this._bindStick();
    this._bindLook();
  }

  _el(tag, cls) {
    const e = document.createElement(tag);
    e.className = cls;
    return e;
  }

  // ── Buttons ─────────────────────────────────────────────────────────────────
  _bindButton(b, key, mode) {
    let pid = null, lx = 0, ly = 0;
    b.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      if (pid !== null) return;
      pid = e.pointerId;
      b.setPointerCapture(pid);
      b.classList.add("down");
      lx = e.clientX; ly = e.clientY;
      if (mode === "fire") this.cb.onFire(true);
      else if (mode === "act") this.cb.onAction(key);
      else this.cb.onKey(key, true);
      if (mode === "tap") this.cb.onKey(key, false);
    });
    // The fire buttons double as a look pad, like the mobile shooters
    b.addEventListener("pointermove", e => {
      if (e.pointerId !== pid || mode !== "fire") return;
      this.cb.onLook(e.clientX - lx, e.clientY - ly);
      lx = e.clientX; ly = e.clientY;
    });
    const up = e => {
      if (e.pointerId !== pid) return;
      pid = null;
      b.classList.remove("down");
      if (mode === "fire") this.cb.onFire(false);
      else if (mode === "hold") this.cb.onKey(key, false);
    };
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("contextmenu", e => e.preventDefault());
  }

  // ── Joystick ────────────────────────────────────────────────────────────────
  _bindStick() {
    const z = this.stickZone, s = this._stick;
    z.addEventListener("pointerdown", e => {
      e.preventDefault();
      if (s.id !== null) return;
      s.id = e.pointerId;
      z.setPointerCapture(s.id);
      // Floating: the stick appears under the thumb
      const r = z.getBoundingClientRect();
      s.ox = e.clientX; s.oy = e.clientY;
      this.stickBase.style.left = `${e.clientX - r.left}px`;
      this.stickBase.style.top = `${e.clientY - r.top}px`;
      this.stickBase.classList.add("active");
      this._moveStick(0, 0);
    });
    z.addEventListener("pointermove", e => {
      if (e.pointerId !== s.id) return;
      this._moveStick(e.clientX - s.ox, e.clientY - s.oy);
    });
    const up = e => {
      if (e.pointerId !== s.id) return;
      s.id = null;
      this.stickBase.classList.remove("active");
      this._moveStick(0, 0);
    };
    z.addEventListener("pointerup", up);
    z.addEventListener("pointercancel", up);
  }

  _moveStick(dx, dy) {
    const d = Math.hypot(dx, dy);
    const k = d > STICK_RADIUS ? STICK_RADIUS / d : 1;
    this.stickKnob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    const nx = (dx * k) / STICK_RADIUS, ny = (dy * k) / STICK_RADIUS;
    const want = {
      KeyW: ny < -DEAD,
      KeyS: ny > DEAD,
      KeyA: nx < -DEAD,
      KeyD: nx > DEAD,
      // Push all the way up to run
      ShiftLeft: ny < -SPRINT_AT && Math.abs(nx) < 0.5,
    };
    for (const code in want) {
      if (want[code] !== this._stick.keys[code]) {
        this._stick.keys[code] = want[code];
        this.cb.onKey(code, want[code]);
      }
    }
    this.stickBase.classList.toggle("sprint", want.ShiftLeft);
  }

  // ── Look pad ────────────────────────────────────────────────────────────────
  _bindLook() {
    const l = this.look;
    l.addEventListener("pointerdown", e => {
      e.preventDefault();
      if (this._lookP) return;
      l.setPointerCapture(e.pointerId);
      this._lookP = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, t: performance.now() };
    });
    l.addEventListener("pointermove", e => {
      const p = this._lookP;
      if (!p || e.pointerId !== p.id) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      p.moved += Math.abs(dx) + Math.abs(dy);
      this.cb.onLook(dx, dy);
    });
    const up = e => {
      const p = this._lookP;
      if (!p || e.pointerId !== p.id) return;
      this._lookP = null;
      if (p.moved < 12 && performance.now() - p.t < 300) this.cb.onTap();
    };
    l.addEventListener("pointerup", up);
    l.addEventListener("pointercancel", up);
  }

  /** Lets go of everything (pause, death, inventory). */
  releaseAll() {
    this._moveStick(0, 0);
    this._stick.id = null;
    this.stickBase.classList.remove("active");
    this._lookP = null;
    for (const b of Object.values(this.buttons)) b.classList.remove("down");
  }

  /** Shows the controls while playing; hides them on menus. */
  setActive(on) {
    this._set("active", on, v => this.root.classList.toggle("on", v));
    if (!on) this.releaseAll();
  }

  /** Shows / hides one button (map only in battle royale, start only for the host…). */
  show(id, on) {
    this._set(`b:${id}`, on, v => this.buttons[id].classList.toggle("hidden", !v));
  }

  /** Highlights a toggle button (aim held, gyro on, flashlight on). */
  lit(id, on) {
    this._set(`l:${id}`, on, v => this.buttons[id].classList.toggle("lit", v));
  }

  _set(key, value, apply) {
    if (this._shown[key] === value) return;
    this._shown[key] = value;
    apply(value);
  }
}
