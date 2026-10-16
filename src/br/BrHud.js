// Battle royale HUD: alive / kills / zone status bar, the "outside the zone"
// overlay, context hints, the spectator bar and result screens (the big map is
// ui/WorldMap.js). Builds its own DOM; every setter only writes when the value changes.

import { IS_TOUCH } from "../input/TouchControls.js";

function el(tag, id, cls) {
  const e = document.createElement(tag);
  if (id) e.id = id;
  if (cls) e.className = cls;
  return e;
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
    specKeys.innerHTML = IS_TOUCH ? "◀ ▶ or tap: next player" : "<kbd>A</kbd><kbd>D</kbd> or click: next player";
    this.spec.append(el("span", null, "br-spec-label"), this.specName, specKeys);
    this.spec.firstChild.textContent = "SPECTATING";

    this.result = el("div", "br-result");
    this.resTitle = el("div", null, "br-res-title");
    this.resSub = el("div", null, "br-res-sub");
    this.resLines = el("div", null, "br-res-lines");
    this.resFoot = el("div", null, "br-res-foot");
    this.result.append(this.resTitle, this.resSub, this.resLines, this.resFoot);
    this._resultTimer = 0;

    this.root.append(this.warn, this.top, this.hint, this.spec, this.result);
    document.body.append(this.root);
    this._c = {};
  }

  _set(key, value, apply) {
    if (this._c[key] === value) return;
    this._c[key] = value;
    apply(value);
  }

  setVisible(on) {
    this._set("vis", on, v => this.root.classList.toggle("on", v));
    if (!on) this.hideResult();
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

  update(delta) {
    if (this._resultTimer > 0) {
      this._resultTimer -= delta;
      if (this._resultTimer <= 0) this.result.classList.remove("on");
    }
  }
}
