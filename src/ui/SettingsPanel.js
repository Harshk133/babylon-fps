import "./settings.css";
import { ACTIONS, GROUPS, keyName } from "../input/Bindings.js";

// Settings: gameplay switches and the keyboard layout. Opened from the lobby's
// top bar and the start / pause screen. The values live in localStorage
// (babylon-fps:settings); main.js reads `settings.get(name)` and hears
// `onChange(name, value)`.

const KEY = "babylon-fps:settings";
export const SETTING_DEFAULTS = {
  autoDoors: false,     // house and classroom doors open as you walk up and close behind you
  bots: false,          // battle royale bots in your room (anyone in the room turning them on brings them in)
  sound: true,          // every sound in the game
  volume: 0.9,          // master volume 0..1
  fps: "auto",          // desktop frame rate: "auto" | "max" | "60" | "30" (phones use the touch settings' own)
};

export class Settings {
  constructor() {
    this.values = { ...SETTING_DEFAULTS };
    try { Object.assign(this.values, JSON.parse(localStorage.getItem(KEY) ?? "{}")); } catch { /* defaults */ }
    this.listeners = [];
  }
  get(name) { return this.values[name]; }
  set(name, value) {
    if (this.values[name] === value) return;
    this.values[name] = value;
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* private mode */ }
    for (const fn of this.listeners) fn(name, value);
  }
  onChange(fn) { this.listeners.push(fn); }
}

const TOGGLES = [
  { id: "sound", title: "Sound", text: "Every sound in the game. Off mutes it all." },
  { id: "volume", title: "Volume", text: "Master volume.", range: true },
  { id: "autoDoors", title: "Auto-open doors", text: "Doors swing open as you walk up to them and shut behind you. Off: press the use key." },
  { id: "fps", title: "Frame rate", text: "Auto runs at your screen's rate and drops to an even half of it when the game can't keep up. Capped rates keep laptops cooler.", desktop: true,
    choices: [["auto", "Auto"], ["max", "Unlimited"], ["60", "60"], ["30", "30"]] },
  { id: "bots", title: "Bots in Battle Royale", text: "AI players fill your room. If anyone in the room turns this on, everyone in it plays with bots. Takes effect in the warm-up." },
];

export class SettingsPanel {
  /** opts: { settings, bindings, touch, onClose } */
  constructor({ settings, bindings, touch = false, onClose = null }) {
    this.settings = settings;
    this.bindings = bindings;
    this.touch = touch;
    this.onClose = onClose;
    this.capture = null;   // the action waiting for its new key
    this.el = document.createElement("div");
    this.el.id = "settings";
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "true");
    this.el.innerHTML = `
      <div class="st-card">
        <header class="st-head">
          <h2>SETTINGS</h2>
          <nav class="st-tabs">
            <button data-tab="game" class="on">Gameplay</button>
            ${touch ? "" : `<button data-tab="keys">Controls</button>`}
          </nav>
          <button class="st-close" aria-label="Close">✕</button>
        </header>
        <div class="st-body"></div>
        <footer class="st-foot"><span class="st-note"></span><button class="st-reset" hidden>Reset to defaults</button><button class="st-done">Done</button></footer>
      </div>`;
    document.body.append(this.el);
    this.body = this.el.querySelector(".st-body");
    this.note = this.el.querySelector(".st-note");
    this.resetBtn = this.el.querySelector(".st-reset");
    this.el.addEventListener("input", e => {
      const r = e.target.closest("[data-range]");
      if (!r) return;
      this.settings.set(r.dataset.range, +r.value / 100);
      const out = r.parentElement.querySelector("output");
      if (out) out.textContent = `${r.value}%`;
    });
    this.el.addEventListener("click", e => {
      const tab = e.target.closest("[data-tab]");
      if (tab) { this.tab(tab.dataset.tab); return; }
      const ch = e.target.closest("[data-choice]");
      if (ch) { this.settings.set(ch.dataset.choice, ch.dataset.val); this._render(); return; }
      const tog = e.target.closest("[data-toggle]");
      if (tog) { const id = tog.dataset.toggle; this.settings.set(id, !this.settings.get(id)); this._render(); return; }
      const bind = e.target.closest("[data-bind]");
      if (bind) { this._startCapture(bind.dataset.bind); return; }
      if (e.target.closest(".st-reset")) { this.bindings.reset(); this._say("Every key is back on its default"); this._render(); return; }
      if (e.target.closest(".st-close") || e.target.closest(".st-done") || e.target === this.el) this.close();
    });
    // Nothing in here reaches the game (pointer lock, the canvas, keys)
    for (const t of ["pointerdown", "mousedown", "click", "wheel", "touchstart"]) this.el.addEventListener(t, e => e.stopPropagation());
    window.addEventListener("keydown", e => {
      if (!this.isOpen) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.capture) { this._finishCapture(e.code); return; }
      if (e.code === "Escape") this.close();
    }, true);
    window.addEventListener("keyup", e => { if (this.isOpen) { e.stopImmediatePropagation(); } }, true);
    this.tab("game");
  }

  get isOpen() { return this.el.classList.contains("open"); }

  open(tab = null) {
    if (tab) this.tab(tab);
    this._render();
    this.el.classList.add("open");
  }

  close() {
    this.capture = null;
    this.el.classList.remove("open");
    this.onClose?.();
  }

  tab(name) {
    this.current = name;
    for (const b of this.el.querySelectorAll("[data-tab]")) b.classList.toggle("on", b.dataset.tab === name);
    this.resetBtn.hidden = name !== "keys";
    this._say("");
    this._render();
  }

  _say(text) { this.note.textContent = text; }

  _render() {
    if (this.current === "keys") {
      let html = `<p class="st-lead">Click a key, then press the new one. Taking a key that's in use swaps the two. Arrows, 1–5, Esc and Enter stay as they are.</p>`;
      for (const g of GROUPS) {
        html += `<h3>${g}</h3><div class="st-keys">`;
        for (const a of ACTIONS.filter(x => x.group === g)) {
          const waiting = this.capture === a.id;
          const changed = !this.bindings.isDefault(a.id);
          html += `<div class="st-key"><span>${a.label}</span><button data-bind="${a.id}" class="${waiting ? "wait" : ""}${changed ? " changed" : ""}">${waiting ? "Press a key…" : keyName(this.bindings.code(a.id))}</button></div>`;
        }
        html += `</div>`;
      }
      this.body.innerHTML = html;
      return;
    }
    let html = "";
    for (const t of TOGGLES) {
      if (t.desktop && this.touch) continue;
      if (t.choices) {
        const v = this.settings.get(t.id);
        html += `<div class="st-toggle st-choice"><span class="st-ttext"><b>${t.title}</b><small>${t.text}</small></span>
          <span class="st-seg">${t.choices.map(([val, label]) => `<button data-choice="${t.id}" data-val="${val}" class="${v === val ? "on" : ""}">${label}</button>`).join("")}</span></div>`;
        continue;
      }
      if (t.range) {
        const v = Math.round((this.settings.get(t.id) ?? 1) * 100);
        html += `<label class="st-toggle st-range"><span class="st-ttext"><b>${t.title}</b><small>${t.text}</small></span>
          <input type="range" min="0" max="100" step="1" value="${v}" data-range="${t.id}"><output>${v}%</output></label>`;
        continue;
      }
      const on = !!this.settings.get(t.id);
      html += `<button class="st-toggle${on ? " on" : ""}" data-toggle="${t.id}" role="switch" aria-checked="${on}">
        <span class="st-ttext"><b>${t.title}</b><small>${t.text}</small></span><span class="st-switch"><i></i></span></button>`;
    }
    this.body.innerHTML = html;
  }

  _startCapture(id) {
    this.capture = id;
    this._say("Press the new key (Esc cancels)");
    this._render();
  }

  _finishCapture(code) {
    const id = this.capture;
    this.capture = null;
    if (code === "Escape") { this._say(""); this._render(); return; }
    if (this.bindings.reserved(code)) { this._say(`${keyName(code)} is taken by the game: pick another`); this._render(); return; }
    const moved = this.bindings.set(id, code);
    const label = ACTIONS.find(a => a.id === id)?.label ?? id;
    this._say(moved
      ? `${label} → ${keyName(code)} · ${ACTIONS.find(a => a.id === moved)?.label} moved to ${keyName(this.bindings.code(moved))}`
      : `${label} → ${keyName(code)}`);
    this._render();
  }
}
