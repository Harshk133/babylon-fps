// Touch controls for phones, tablets and the Android app: a floating move
// joystick (drag past the ring to lock sprint), drag-anywhere-right to look,
// PUBG-style fire / scope / jump / reload / throw buttons and gyro aiming.
//
// It never changes game state itself. main.js reads the analog state
// (moveX/moveY/sprint) every frame and gets everything else through callbacks,
// mostly `key(code, pressed)`, the same path the keyboard uses, so every action
// behaves exactly like its key.

import "./touch.css";
import { icon } from "../ui/gameIcons.js";

const SETTINGS_KEY = "babylon-fps:touch";
const DEG = Math.PI / 180;

/** Phones, tablets and the Capacitor app. ?touch=1 / ?touch=0 forces it (desktop testing). */
export const IS_TOUCH = (() => {
  const forced = new URLSearchParams(location.search).get("touch");
  if (forced === "1") return true;
  if (forced === "0") return false;
  if (window.Capacitor?.isNativePlatform?.()) return true;
  return navigator.maxTouchPoints > 0 && matchMedia("(pointer: coarse)").matches;
})();

/** Running inside the Android app (not a mobile browser). */
export const IS_NATIVE = !!window.Capacitor?.isNativePlatform?.();

const DEFAULTS = {
  look: 1.6,        // drag-to-look speed
  gyro: "always",   // "off" | "aim" (only while scoped) | "always"
  gyroSens: 1.6,    // camera degrees per degree the phone turns
  invertY: false,
  size: 1,          // button scale
  opacity: 0.8,
  fps: "auto",      // frame cap: "auto" (60, or a steady 30 when 60 can't be held), "60", "30"
};

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch { return { ...DEFAULTS }; }
}

// Button icons: the game-icons.net set (src/ui/gameIcons.js), like the rest of the HUD
const ICONS = Object.fromEntries(Object.entries({
  fire: "fire", scope: "scope", jump: "jump", crouch: "crouch", prone: "prone", reload: "reload",
  grenade: "grenade", swap: "swap", bag: "bag", torch: "flashlight", pause: "pause", gear: "gear",
  map: "map", gyro: "gyro", heal: "medkit", door: "door", drive: "steering", shop: "shop",
}).map(([k, name]) => [k, icon(name)]));

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

export class TouchControls {
  /**
   * cb: {
   *   key(code, pressed)   same as a keyboard key going down / up
   *   look(dx, dy)         drag look, in mouse-pixel units
   *   turn(yaw, pitch)     gyro look, radians
   *   fire(down), aim(on)
   *   hotbar(dataset)      a hotbar slot was tapped
   *   pause()              leave play (like Esc)
   *   unlock()             first touch: start audio
   * }
   */
  constructor(cb) {
    this.cb = cb;
    this.settings = loadSettings();
    this.moveX = 0;      // −1..1, + = right
    this.moveY = 0;      // −1..1, + = forward
    this.sprint = false;
    this.aimOn = false;
    this.gyroAvailable = false;

    this._ctx = null;
    this._shown = "";
    this._touches = new Map(); // pointerId → { kind, x, y, ... }
    this._joy = null;          // pointerId driving the joystick
    this._sprintLock = false;
    this._unlocked = false;

    document.body.classList.add("touch");
    if (IS_NATIVE) document.body.classList.add("native");
    this._build();
    this._applySettings();
    this._bindHud();
    this._bindGyro();
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  _build() {
    const root = this.root = el("div", null);
    root.id = "touch-ui";

    // Full-screen surface under the buttons: left part = joystick, the rest = look
    this.surface = el("div", "tc-surface");
    root.append(this.surface);

    // Joystick (floating: jumps to wherever your thumb lands in the left zone)
    this.joy = el("div", "tc-joy");
    this.joyKnob = el("div", "tc-joy-knob");
    this.joyLock = el("div", "tc-joy-lock", "<span>SPRINT</span>");
    this.joy.append(this.joyLock, this.joyKnob);
    root.append(this.joy);

    const play = this.play = el("div", "tc-group tc-play");
    const btn = (cls, icon, label) => {
      const b = el("div", `tc-btn ${cls}`, `${ICONS[icon] || ""}${label != null ? `<span class="tc-label">${label}</span>` : ""}`);
      play.append(b);
      return b;
    };
    this.fireR = btn("tc-fire", "fire");
    this.fireL = btn("tc-fire-l", "fire");
    this.scopeBtn = btn("tc-scope", "scope");
    this.jumpBtn = btn("tc-jump", "jump", "");
    this.crouchBtn = btn("tc-crouch", "crouch");
    this.proneBtn = btn("tc-prone", "prone");
    this.reloadBtn = btn("tc-reload", "reload");
    this.throwBtn = btn("tc-throw", "grenade");
    this.throwCount = el("span", "tc-badge", "0");
    this.throwBtn.append(this.throwCount);
    this.swapBtn = btn("tc-swap", "swap");
    this.healBtn = btn("tc-heal", "heal");
    this.healCount = el("span", "tc-badge", "0");
    this.healBtn.append(this.healCount);
    this.bagBtn = btn("tc-bag tc-small", "bag");
    this.torchBtn = btn("tc-torch tc-small", "torch");
    this.mapBtn = btn("tc-map tc-small", "map");
    this.gyroBtn = btn("tc-gyro tc-small", "gyro");
    this.pauseBtn = btn("tc-pause tc-small", "pause");
    this.startBtn = btn("tc-start tc-wide", null, "START MATCH");

    // While paused: settings
    const paused = this.paused = el("div", "tc-group tc-paused");
    this.gearBtn = el("div", "tc-btn tc-gear tc-small", ICONS.gear);
    paused.append(this.gearBtn);

    // While the inventory is open: a close button (no Tab key on a phone)
    const inv = this.inv = el("div", "tc-group tc-inv");
    this.invClose = el("div", "tc-btn tc-wide tc-inv-close", '<span class="tc-label">CLOSE ✕</span>');
    inv.append(this.invClose);

    // Spectating (battle royale): previous / next player and the map
    const spec = this.spec = el("div", "tc-group tc-spec");
    this.specPrev = el("div", "tc-btn tc-spec-prev", '<span class="tc-label">◀</span>');
    this.specNext = el("div", "tc-btn tc-spec-next", '<span class="tc-label">▶</span>');
    this.specMap = el("div", "tc-btn tc-small tc-spec-map", ICONS.map);
    spec.append(this.specPrev, this.specNext, this.specMap);

    root.append(play, paused, inv, spec, this._buildSettings());
    document.body.append(root);

    // Phones held upright get asked to turn sideways
    const rotate = el("div", null, '<div class="rotate-phone"></div><p>Turn your phone sideways</p>');
    rotate.id = "rotate-hint";
    document.body.append(rotate);

    this._bindSurface();
    this._bindButtons();
  }

  _buildSettings() {
    const s = this.settingsEl = el("div", "tc-settings");
    s.innerHTML = `
      <div class="tc-set-panel">
        <h2>TOUCH CONTROLS</h2>
        <label><span>Look speed <b data-out="look"></b></span><input type="range" data-k="look" min="0.4" max="4" step="0.1"></label>
        <label><span>Gyroscope</span>
          <select data-k="gyro">
            <option value="always">Always on</option>
            <option value="aim">Only while scoped</option>
            <option value="off">Off</option>
          </select>
        </label>
        <label><span>Gyro sensitivity <b data-out="gyroSens"></b></span><input type="range" data-k="gyroSens" min="0.3" max="4" step="0.1"></label>
        <label class="tc-check"><input type="checkbox" data-k="invertY"><span>Invert up / down</span></label>
        <label><span>Button size <b data-out="size"></b></span><input type="range" data-k="size" min="0.7" max="1.4" step="0.05"></label>
        <label><span>Button opacity <b data-out="opacity"></b></span><input type="range" data-k="opacity" min="0.3" max="1" step="0.05"></label>
        <label><span>Frame rate</span>
          <select data-k="fps">
            <option value="auto">Auto (60, steady 30 if the phone can't keep up)</option>
            <option value="60">60 FPS (smooth)</option>
            <option value="30">30 FPS (battery saver, cooler phone)</option>
          </select>
        </label>
        <p class="tc-gyro-note"></p>
        <div class="tc-set-row"><button data-act="reset" class="ghost">Defaults</button><button data-act="done">Done</button></div>
      </div>`;
    const write = () => {
      for (const input of s.querySelectorAll("[data-k]")) {
        const v = this.settings[input.dataset.k];
        if (input.type === "checkbox") input.checked = !!v;
        else input.value = v;
      }
      for (const out of s.querySelectorAll("[data-out]")) {
        const k = out.dataset.out;
        out.textContent = k === "opacity" ? `${Math.round(this.settings[k] * 100)}%` : `${(+this.settings[k]).toFixed(k === "size" ? 2 : 1)}×`;
      }
      s.querySelector(".tc-gyro-note").textContent = this.gyroAvailable ? "" : "No gyroscope reported yet: it starts once the phone moves. Some phones don't have one.";
    };
    s.addEventListener("input", e => {
      const k = e.target.dataset.k;
      if (!k) return;
      this.settings[k] = e.target.type === "checkbox" ? e.target.checked
        : e.target.tagName === "SELECT" ? e.target.value : parseFloat(e.target.value);
      this._saveSettings();
      write();
    });
    s.addEventListener("click", e => {
      const act = e.target.dataset?.act;
      if (act === "reset") { this.settings = { ...DEFAULTS }; this._saveSettings(); write(); }
      if (act === "done") this.showSettings(false);
      if (e.target === s) this.showSettings(false);
    });
    this._writeSettings = write;
    return s;
  }

  showSettings(open) {
    this._writeSettings();
    this.settingsEl.classList.toggle("on", open);
  }

  _saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
    this._applySettings();
  }

  _applySettings() {
    this.root.style.setProperty("--tc-size", this.settings.size);
    this.root.style.setProperty("--tc-opacity", this.settings.opacity);
    this._gyroIcon();
  }

  _gyroIcon() {
    this.gyroBtn.classList.toggle("on", this.settings.gyro !== "off");
    this.gyroBtn.dataset.mode = this.settings.gyro;
  }

  // ── Joystick + look surface ────────────────────────────────────────────────

  _joyRadius() { return 58 * this.settings.size; }

  /** Left 40% of the screen (below the top HUD strip) moves; everything else looks. */
  _inJoyZone(x, y) { return x < innerWidth * 0.4 && y > innerHeight * 0.28; }

  _bindSurface() {
    const s = this.surface;
    s.addEventListener("pointerdown", e => {
      this._firstTouch();
      e.preventDefault();
      if (this._joy === null && this._inJoyZone(e.clientX, e.clientY)) {
        this._sprintLock = false;
        const R = this._joyRadius();
        // Keep the whole ring on screen
        const cx = Math.max(R + 12, Math.min(innerWidth * 0.4, e.clientX));
        const cy = Math.max(R + 12, Math.min(innerHeight - R - 12, e.clientY));
        this._joy = e.pointerId;
        this._touches.set(e.pointerId, { kind: "joy", cx, cy });
        this.joy.classList.add("active");
        this.joy.style.left = `${cx}px`;
        this.joy.style.top = `${cy}px`;
        this._joyMove(e.clientX, e.clientY);
      } else {
        this._touches.set(e.pointerId, { kind: "look", x: e.clientX, y: e.clientY });
      }
      try { s.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    });
    s.addEventListener("pointermove", e => this._move(e));
    s.addEventListener("pointerup", e => this._end(e));
    s.addEventListener("pointercancel", e => this._end(e));
  }

  _joyMove(x, y) {
    const t = this._touches.get(this._joy);
    if (!t) return;
    const R = this._joyRadius();
    let dx = x - t.cx, dy = y - t.cy;
    const dist = Math.hypot(dx, dy);
    // Dragged well past the top of the ring: sprint (and lock it if released there)
    const sprintZone = dy < -R * 1.45 && Math.abs(dx) < -dy * 0.7;
    t.sprintZone = sprintZone;
    this.joyLock.classList.toggle("hot", sprintZone);
    if (dist > R) { dx *= R / dist; dy *= R / dist; }
    this.joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    let nx = dx / R, ny = -dy / R;
    const mag = Math.hypot(nx, ny);
    if (mag < 0.12) { nx = ny = 0; }
    else {
      // Remap past the dead zone: a light push walks, the edge runs
      const m = Math.min(1, 0.3 + 0.7 * (mag - 0.12) / 0.88) / mag;
      nx *= m; ny *= m;
    }
    this.moveX = nx;
    this.moveY = ny;
    this.sprint = sprintZone;
  }

  _move(e) {
    const t = this._touches.get(e.pointerId);
    if (!t) return;
    if (t.kind === "joy") { this._joyMove(e.clientX, e.clientY); return; }
    // look, fire and throw buttons all steer the camera while held (as in PUBG)
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    t.x = e.clientX; t.y = e.clientY;
    if (dx || dy) {
      const k = this.settings.look;
      this.cb.look(dx * k, dy * k * (this.settings.invertY ? -1 : 1));
    }
  }

  _end(e) {
    const t = this._touches.get(e.pointerId);
    if (!t) return;
    this._touches.delete(e.pointerId);
    if (t.kind === "joy") {
      this._joy = null;
      if (t.sprintZone) {
        this._sprintLock = true;
        this.moveX = 0; this.moveY = 1; this.sprint = true;
        this.joyKnob.style.transform = `translate(0px, ${-this._joyRadius()}px)`;
        this.joy.classList.add("locked");
      } else {
        this._releaseJoy();
      }
    } else if (t.up) {
      t.up();
    }
  }

  _releaseJoy() {
    this._sprintLock = false;
    this.moveX = this.moveY = 0;
    this.sprint = false;
    this.joy.classList.remove("active", "locked");
    this.joyLock.classList.remove("hot");
    this.joyKnob.style.transform = "";
    this.joy.style.left = "";
    this.joy.style.top = "";
  }

  // ── Buttons ────────────────────────────────────────────────────────────────

  /** down() on press; up() on release; look=true lets the finger steer the camera while held. */
  _hold(b, down, up, look = false) {
    b.addEventListener("pointerdown", e => {
      this._firstTouch();
      e.preventDefault();
      e.stopPropagation();
      try { b.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      b.classList.add("down");
      const t = { kind: look ? "look" : "btn", x: e.clientX, y: e.clientY, up: () => { b.classList.remove("down"); up?.(); } };
      this._touches.set(e.pointerId, t);
      down?.();
    });
    b.addEventListener("pointermove", e => this._move(e));
    b.addEventListener("pointerup", e => this._end(e));
    b.addEventListener("pointercancel", e => this._end(e));
  }

  _tapKey(b, code) {
    this._hold(b, () => this.cb.key(code, true), () => this.cb.key(code, false));
  }

  _bindButtons() {
    const cb = this.cb;
    this._hold(this.fireR, () => cb.fire(true), () => cb.fire(false), true);
    this._hold(this.fireL, () => cb.fire(true), () => cb.fire(false), true);
    this._hold(this.scopeBtn, () => this.setAim(!this.aimOn));
    this._tapKey(this.jumpBtn, "Space");
    this._tapKey(this.crouchBtn, "KeyC");
    this._tapKey(this.proneBtn, "KeyZ");
    this._tapKey(this.reloadBtn, "KeyR");
    this._hold(this.throwBtn, () => cb.key("KeyG", true), () => cb.key("KeyG", false), true);
    this._tapKey(this.swapBtn, "KeyQ");
    this._tapKey(this.healBtn, "KeyH");
    this._tapKey(this.bagBtn, "KeyI");
    this._tapKey(this.torchBtn, "KeyN");
    this._tapKey(this.mapBtn, "KeyM");
    this._tapKey(this.startBtn, "Enter");
    this._tapKey(this.specMap, "KeyM");
    this._tapKey(this.specPrev, "KeyA");
    this._tapKey(this.specNext, "KeyD");
    this._tapKey(this.invClose, "Escape");
    this._hold(this.gyroBtn, () => {
      // Quick toggle: off ⇄ the last mode you used (always by default)
      const s = this.settings;
      if (s.gyro === "off") s.gyro = s._lastGyro || "always";
      else { s._lastGyro = s.gyro; s.gyro = "off"; }
      this._saveSettings();
    });
    this.pauseBtn.addEventListener("click", () => cb.pause());
    this.gearBtn.addEventListener("click", e => { e.stopPropagation(); this.showSettings(true); });
  }

  setAim(on) {
    if (on === this.aimOn) return;
    this.aimOn = on;
    this.scopeBtn.classList.toggle("on", on);
    this.cb.aim(on);
  }

  /** Hotbar slots and the context prompts (pick up, doors, lights, rickshaw) become buttons. */
  _bindHud() {
    const hotbar = document.getElementById("hotbar");
    hotbar?.addEventListener("pointerdown", e => {
      const slot = e.target.closest("[data-hb]");
      if (!slot || !this._ctx?.playing) return;
      e.preventDefault();
      e.stopPropagation();
      this._firstTouch();
      this.cb.hotbar(slot.dataset);
    });
    const prompt = document.getElementById("pickup-prompt");
    prompt?.addEventListener("pointerdown", e => {
      const row = e.target.closest(".prompt-row");
      const key = row?.querySelector("kbd")?.textContent?.trim();
      if (!key || !this._ctx?.playing) return;
      e.preventDefault();
      e.stopPropagation();
      this._firstTouch();
      row.classList.add("down");
      setTimeout(() => row.classList.remove("down"), 150);
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
      this.cb.key(code, true);
      this.cb.key(code, false);
    });
  }

  _firstTouch() {
    if (this._unlocked) return;
    this._unlocked = true;
    this.cb.unlock?.();
    // iOS asks before it shares the gyroscope (Android doesn't)
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === "function") DME.requestPermission().catch(() => {});
  }

  // ── Gyroscope ──────────────────────────────────────────────────────────────

  _bindGyro() {
    let last = 0;
    window.addEventListener("devicemotion", e => {
      const r = e.rotationRate;
      if (!r || (r.alpha == null && r.beta == null)) return;
      this.gyroAvailable = true;
      const now = performance.now();
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      const ctx = this._ctx;
      const mode = this.settings.gyro;
      if (!dt || !ctx?.playing || !ctx.alive || mode === "off" || (mode === "aim" && !ctx.aiming)) return;

      // rotationRate is in the phone's own axes (deg/s). Turn it into yaw / pitch
      // for however the screen is rotated right now.
      const angle = ((screen.orientation?.angle ?? window.orientation ?? 0) + 360) % 360;
      const a = r.beta || 0, g = r.gamma || 0;
      let yaw, pitch;
      if (angle === 90)       { yaw = a;  pitch = -g; }
      else if (angle === 270) { yaw = -a; pitch = g; }
      else if (angle === 180) { yaw = -g; pitch = -a; }
      else                    { yaw = g;  pitch = a; }
      // Soft dead zone: hand tremor doesn't wobble the crosshair
      yaw = soft(yaw, 1.2);
      pitch = soft(pitch, 1.2);
      if (!yaw && !pitch) return;
      const k = this.settings.gyroSens * DEG * dt;
      this.cb.turn(yaw * k, pitch * k * (this.settings.invertY ? -1 : 1));
    });
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  /**
   * ctx: { playing, alive, aiming, inventoryOpen, lobby, spectating, br, canStart,
   *        driving, jumpLabel, throwCount, healCount, stance }. Only touches the DOM when
   *        something visible changes.
   */
  update(ctx) {
    this._ctx = ctx;
    if (!ctx.playing && (this._touches.size || this._joy !== null || this.aimOn)) this.reset();
    const sig = `${ctx.playing}|${ctx.alive}|${ctx.inventoryOpen}|${ctx.lobby}|${ctx.spectating}|${ctx.br}|${ctx.canStart}|${ctx.driving}|${ctx.jumpLabel}|${ctx.throwCount}|${ctx.healCount}|${ctx.airborne}|${ctx.stance}`;
    if (sig === this._shown) return;
    this._shown = sig;
    const r = this.root.classList;
    r.toggle("playing", ctx.playing && ctx.alive && !ctx.inventoryOpen);
    r.toggle("paused", !ctx.playing && !ctx.lobby && !ctx.inventoryOpen && ctx.alive);
    r.toggle("inv-open", ctx.inventoryOpen);
    r.toggle("spectating", ctx.spectating);
    r.toggle("br", ctx.br);
    r.toggle("can-start", ctx.canStart);
    r.toggle("driving", ctx.driving);
    r.toggle("airborne", ctx.airborne);
    this.jumpBtn.querySelector(".tc-label").textContent = ctx.jumpLabel;
    this.jumpBtn.style.display = ctx.jumpLabel ? "" : "none"; // nothing to do under the parachute
    this.throwCount.textContent = `${ctx.throwCount}`;
    this.throwBtn.classList.toggle("empty", ctx.throwCount === 0);
    this.healCount.textContent = `${ctx.healCount ?? 0}`;
    this.healBtn.classList.toggle("empty", !ctx.healCount);
    this.crouchBtn.classList.toggle("on", ctx.stance === "crouch");
    this.proneBtn.classList.toggle("on", ctx.stance === "prone");
  }

  /** Drop every held touch (pause, death, inventory). */
  reset() {
    for (const t of this._touches.values()) t.up?.();
    this._touches.clear();
    this._joy = null;
    this._releaseJoy();
    this.setAim(false);
    this.cb.fire(false);
  }
}

function soft(v, dead) {
  if (Math.abs(v) <= dead) return 0;
  return v - Math.sign(v) * dead;
}
