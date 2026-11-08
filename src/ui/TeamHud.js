// Team play HUD (Duo / Squad): the knocked screen with its bleed-out bar, the
// quick chat menu and the voice chip. The roster itself is the #squad panel
// (updateSquad in main.js). Setters only touch the DOM when the value changes.

import "./team.css";
import { QUICK_CHAT } from "../br/Teams.js";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const QUICK_SHOW = 6;   // s the quick chat menu stays up

export class TeamHud {
  /** cb: { onQuick(index) } */
  constructor(cb) {
    this.cb = cb;
    this.quickOpen = false;
    this._quickT = 0;
    this._c = {};

    const k = this.knock = el("div", "tm-knock");
    k.id = "tm-knock";
    this.knockTitle = el("div", "tm-knock-title", "KNOCKED");
    const bar = el("div", "tm-knock-bar");
    this.knockFill = el("i");
    bar.append(this.knockFill);
    this.knockText = el("div", "tm-knock-text");
    k.append(this.knockTitle, bar, this.knockText);

    const q = this.quick = el("div", "tm-quick");
    q.id = "tm-quick";
    q.append(el("div", "tm-quick-head", "QUICK CHAT"));
    QUICK_CHAT.forEach((line, i) => {
      const row = el("button", "tm-quick-row");
      row.type = "button";
      row.dataset.q = i;
      row.append(el("kbd", null, `${i + 1}`), el("span", null, line.text));
      q.append(row);
    });
    q.addEventListener("pointerdown", e => {
      const row = e.target.closest("[data-q]");
      e.stopPropagation();
      if (row) this._pick(+row.dataset.q);
    });

    this.voice = el("div", "tm-voice");
    this.voice.id = "tm-voice";
    this.voiceDot = el("i");
    this.voiceText = el("span");
    this.voice.append(this.voiceDot, this.voiceText);

    document.body.append(k, q, this.voice);
  }

  _set(key, value, apply) {
    if (this._c[key] === value) return;
    this._c[key] = value;
    apply(value);
  }

  /** In a Duo / Squad match: body.in-team shows the touch buttons and chips. */
  setVisible(on) {
    this._set("vis", on, v => document.body.classList.toggle("in-team", v));
    if (!on) { this.setKnocked(null); this.closeQuick(); this.setVoice(null); }
  }

  /** null, or { frac: bleed-out 0..1, text, reviving }. */
  setKnocked(info) {
    this._set("kn", !!info, v => { this.knock.classList.toggle("on", v); document.body.classList.toggle("knocked", v); });
    if (!info) return;
    this._set("knF", Math.round(info.frac * 200), v => { this.knockFill.style.width = `${v / 2}%`; });
    this._set("knT", info.text, v => { this.knockText.textContent = v; });
    this._set("knR", !!info.reviving, v => this.knock.classList.toggle("reviving", v));
  }

  openQuick() {
    this.quickOpen = true;
    this._quickT = QUICK_SHOW;
    this.quick.classList.add("on");
  }

  closeQuick() {
    this.quickOpen = false;
    this.quick.classList.remove("on");
  }

  toggleQuick() { if (this.quickOpen) this.closeQuick(); else this.openQuick(); }

  /** A number key (0-based) while the menu is open. */
  pickKey(i) {
    if (!this.quickOpen || i < 0 || i >= QUICK_CHAT.length) return false;
    this._pick(i);
    return true;
  }

  _pick(i) {
    this.closeQuick();
    this.cb.onQuick(i);
  }

  /** null hides it. kind: "live" (mic is sending) | "ready" | "muted" | "error". */
  setVoice(state) {
    this._set("vo", state ? `${state.kind}|${state.text}` : "", v => {
      this.voice.classList.toggle("on", !!v);
      if (!state) return;
      this.voice.dataset.kind = state.kind;
      this.voiceText.textContent = state.text;
    });
  }

  update(delta) {
    if (this.quickOpen && (this._quickT -= delta) <= 0) this.closeQuick();
  }
}
