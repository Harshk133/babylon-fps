import { icon } from "./gameIcons.js";

/**
 * The battle royale's two twists on screen (rules live in main.js):
 * - Most Wanted: a red chip under the zone bar. Who's wanted, their bounty, how
 *   far their last revealed spot is; or, when it's you, when you're revealed next.
 * - Revenge Run: a purple countdown and vignette while you're a revenant.
 * Touches the DOM only when a shown value changes.
 */
export class BrEdgeHud {
  constructor() {
    this.root = document.createElement("div");
    this.root.id = "br-edge";
    this.root.innerHTML = `
      <div class="bre-wanted">
        <span class="bre-ico">${icon("skull")}</span>
        <span class="bre-text"><b class="bre-title"></b><small class="bre-sub"></small></span>
        <span class="bre-bounty"></span>
      </div>
      <div class="bre-nemesis">
        <span class="bre-ico">${icon("nemesis")}</span>
        <span class="bre-text"><b class="bre-ntitle"></b><small class="bre-nsub"></small></span>
      </div>
      <div class="bre-revenge">
        <span class="bre-rtitle">REVENGE RUN</span>
        <span class="bre-clock"></span>
        <small class="bre-rsub">Get one kill to be reborn</small>
      </div>`;
    document.body.append(this.root);
    this.vignette = document.createElement("div");
    this.vignette.id = "revenge-vignette";
    document.body.append(this.vignette);
    this.wanted = this.root.querySelector(".bre-wanted");
    this.title = this.root.querySelector(".bre-title");
    this.sub = this.root.querySelector(".bre-sub");
    this.bounty = this.root.querySelector(".bre-bounty");
    this.revenge = this.root.querySelector(".bre-revenge");
    this.clock = this.root.querySelector(".bre-clock");
    this.nemesis = this.root.querySelector(".bre-nemesis");
    this.ntitle = this.root.querySelector(".bre-ntitle");
    this.nsub = this.root.querySelector(".bre-nsub");
    this._c = {};
  }

  _set(node, key, value) {
    if (this._c[key] === value) return;
    this._c[key] = value;
    node.textContent = value;
  }
  _toggle(node, key, cls, on) {
    if (this._c[key] === on) return;
    this._c[key] = on;
    node.classList.toggle(cls, on);
  }

  /**
   * w: null, or { self, name, bounty, dist (m, or null), next (s to the next reveal) }.
   * rev: null, or { t (s left), urgent }.
   * nem: null, or { name, kills (times they've killed you), dist (m), dir ("NE"…) }.
   */
  update(w, rev, nem = null) {
    this._toggle(this.nemesis, "nv", "on", !!nem);
    if (nem) {
      this._set(this.ntitle, "nt", `NEMESIS · ${nem.name}`);
      this._set(this.nsub, "ns", `${Math.round(nem.dist / 10) * 10} m ${nem.dir} · killed you ${nem.kills}×`);
      this._toggle(this.nemesis, "nc", "close", nem.dist < 60);
    }
    this._toggle(this.wanted, "wv", "on", !!w);
    if (w) {
      this._toggle(this.wanted, "ws", "self", w.self);
      this._set(this.title, "wt", w.self ? "YOU ARE MOST WANTED" : `MOST WANTED · ${w.name}`);
      this._set(this.sub, "wsub", w.self
        ? `Revealed to everyone in ${Math.max(0, Math.ceil(w.next))}s · +15% damage`
        : w.dist === null ? "Waiting for a fix…" : `Last seen ${Math.round(w.dist)} m away · kill to claim`);
      this._set(this.bounty, "wb", w.bounty);
    }
    this._toggle(this.revenge, "rv", "on", !!rev);
    this._toggle(this.vignette, "vv", "on", !!rev);
    if (rev) {
      const s = Math.max(0, Math.ceil(rev.t));
      this._set(this.clock, "rc", `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
      this._toggle(this.revenge, "ru", "urgent", rev.urgent);
    }
  }

  hide() { this.update(null, null, null); }
}
