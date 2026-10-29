// Looking down a magnified scope (OPTICS[…].scope, see src/combat/weapons.js):
// the live game view fills the lens (the camera itself zooms, main.js), and this
// overlay draws everything around and on it: the dark tube round the lens, the
// rim with its inner shadow and a glint of glass, the reticle for that optic
// (inline SVG, crisp at any size), and a range readout and breath bar.
// Red dot / holographic sights don't zoom into a scope: their reticle replaces
// the crosshair at the shoulder aim (aimReticle()).
//
// Nothing here runs per frame unless something changed: update() writes to the
// DOM only while the scope moves in or out, or when the range / breath shown
// changes. The reticle markup is built once per optic.

const NS = 'xmlns="http://www.w3.org/2000/svg" viewBox="-100 -100 200 200" preserveAspectRatio="xMidYMid meet"';
const INK = "#0b0b0b", RED = "#ff2b1c";

/** Reticles: lens radius = 100 units. */
const RETICLES = {
  // 2x: fine cross with a gap, heavy posts at the edge, a red centre dot
  x2: () => `
    <g stroke="${INK}" fill="none">
      <path d="M-100 0H-68M68 0H100M0 68V100M0 -100V-68" stroke-width="3"/>
      <path d="M-68 0H-9M9 0H68M0 9V68M0 -68V-9" stroke-width="0.7"/>
      <path d="M-34 -2.5V2.5M34 -2.5V2.5M-2.5 34H2.5M-2.5 -34H2.5" stroke-width="0.7"/>
    </g>
    <circle r="1.5" fill="${RED}" filter="url(#glow)"/>`,
  // 4x ACOG: red chevron, bullet-drop ladder under it with its ranges
  acog: () => {
    const bars = [[16, 10, 4], [25, 8, 5], [33, 6.4, 6], [41, 5, 7], [49, 3.8, 8]];
    return `
    <g stroke="${INK}" fill="none">
      <path d="M-100 0H-62M62 0H100" stroke-width="3"/>
      <path d="M-62 0H-24M24 0H62" stroke-width="0.7"/>
      <path d="M0 9V54" stroke-width="0.7"/>
      ${bars.map(([y, w]) => `<path d="M${-w} ${y}H${w}" stroke-width="0.8"/>`).join("")}
    </g>
    <g fill="${INK}" font-family="Arial, sans-serif" font-size="4.6" font-weight="700">
      ${bars.map(([y, w, n]) => `<text x="${w + 2}" y="${y + 1.6}">${n}</text>`).join("")}
    </g>
    <path d="M-5.5 6.5L0 0L5.5 6.5" stroke="${RED}" stroke-width="1.6" fill="none" stroke-linejoin="round" filter="url(#glow)"/>`;
  },
  // 6x: fine cross with mil ticks, posts beyond, a small red dot
  x6: () => {
    let ticks = "";
    for (let i = 10; i <= 50; i += 10) {
      const l = i % 20 === 0 ? 3.4 : 2;
      ticks += `M${i} ${-l}V${l}M${-i} ${-l}V${l}M${-l} ${i}H${l}M${-l} ${-i}H${l}`;
    }
    return `
    <g stroke="${INK}" fill="none">
      <path d="M-100 0H-58M58 0H100M0 58V100M0 -100V-58" stroke-width="3.2"/>
      <path d="M-58 0H-2M2 0H58M0 2V58M0 -58V-2" stroke-width="0.5"/>
      <path d="${ticks}" stroke-width="0.5"/>
    </g>
    <circle r="1" fill="${RED}" filter="url(#glow)"/>`;
  },
  // 8x (sniper): duplex cross, mil marks and numbers, range bars below the centre
  mil: () => {
    let ticks = "", nums = "";
    for (let i = 7.5, n = 1; i <= 52.5; i += 7.5, n++) {
      const l = n % 2 === 0 ? 3.6 : 2.1;
      ticks += `M${i} ${-l}V${l}M${-i} ${-l}V${l}M${-l} ${-i}H${l}`;
      if (n % 2 === 0) nums += `<text x="${i}" y="-5.5" text-anchor="middle">${n}</text><text x="${-i}" y="-5.5" text-anchor="middle">${n}</text>`;
    }
    const range = [[11, 7, "2"], [19, 5.6, "3"], [27, 4.4, "4"], [35, 3.4, "5"], [43, 2.6, "6"]];
    return `
    <g stroke="${INK}" fill="none">
      <path d="M-100 0H-55M55 0H100M0 55V100M0 -100V-55" stroke-width="3.6"/>
      <path d="M-55 0H55M0 -55V3M0 46V55" stroke-width="0.42"/>
      <path d="${ticks}" stroke-width="0.42"/>
      ${range.map(([y, w]) => `<path d="M${-w} ${y}H${w}" stroke-width="0.55"/>`).join("")}
      <path d="M0 3V46" stroke-width="0.42"/>
    </g>
    <g fill="${INK}" font-family="Arial, sans-serif" font-size="3.4" font-weight="700">
      ${nums}
      ${range.map(([y, w, t]) => `<text x="${w + 1.6}" y="${y + 1.2}">${t}</text>`).join("")}
    </g>
    <circle r="0.55" fill="${INK}"/>`;
  },
};

/** Shoulder-aim reticles (red dot / holographic), 64 units across. */
const AIM_RETICLES = {
  dot: `<circle r="2.2" fill="${RED}" filter="url(#glow)"/>`,
  holo: `<g fill="none" stroke="${RED}" filter="url(#glow)"><circle r="17" stroke-width="1.4"/>
    <path d="M0 -17V-12M0 12V17M-17 0H-12M12 0H17" stroke-width="1.4"/></g><circle r="1.6" fill="${RED}" filter="url(#glow)"/>`,
};
const GLOW = `<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.6" result="b"/>
  <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;

export class ScopeOverlay {
  /** blur: blur the world round the lens (backdrop-filter: desktop, higher quality only). */
  constructor({ blur = false } = {}) {
    const el = this.el = document.createElement("div");
    el.id = "scope-overlay";
    el.innerHTML = `
      <div class="scope-housing"></div>
      ${blur ? '<div class="scope-blur"></div>' : ""}
      <div class="scope-lens">
        <svg class="scope-reticle" ${NS}></svg>
        <div class="scope-glass"></div>
        <span class="scope-name"></span>
        <span class="scope-range"></span>
        <div class="scope-breath"><i></i></div>
      </div>`;
    document.body.append(el);
    this.reticleEl = el.querySelector(".scope-reticle");
    this.nameEl = el.querySelector(".scope-name");
    this.rangeEl = el.querySelector(".scope-range");
    this.breathEl = el.querySelector(".scope-breath");
    this.breathBar = this.breathEl.firstElementChild;

    const aim = this.aimEl = document.createElement("div");
    aim.id = "optic-reticle";
    aim.innerHTML = `<svg ${NS.replace("-100 -100 200 200", "-32 -32 64 64")}></svg>`;
    document.body.append(aim);
    this.aimSvg = aim.firstElementChild;

    this.optic = null;
    this.lens = 0.8;
    this.k = -1;
    this.shown = false;
    this.range = -1;
    this.breath = -1;
    this.breathOn = null;
    this.aimKind = undefined;
    this._cache = new Map();
    this._resize = () => this._size();
    window.addEventListener("resize", this._resize);
  }

  /** The magnified optic in use (an OPTICS entry + its id), or null. */
  setOptic(id, def) {
    if (this.optic === id) return;
    this.optic = id;
    if (!def) return;
    let svg = this._cache.get(def.reticle);
    if (!svg) { svg = GLOW + (RETICLES[def.reticle] ?? RETICLES.x2)(); this._cache.set(def.reticle, svg); }
    this.reticleEl.innerHTML = svg;
    this.nameEl.textContent = def.name;
    this.lens = def.lens ?? 0.8;
    this.el.style.setProperty("--housing", String(def.housing ?? 0.9));
    this._size();
  }

  _size() {
    this.el.style.setProperty("--lens", `${Math.round(Math.min(innerWidth, innerHeight) * 0.5 * this.lens)}px`);
  }

  /**
   * k: 0..1 how far into the scope (main.js scopeBlend). range: metres to what the
   * reticle is on (null: nothing in range). breath: 0..1 left; holding: Shift held.
   */
  update(k, range, breath, holding) {
    k = k < 0.002 ? 0 : k > 0.998 ? 1 : k;
    if (Math.abs(k - this.k) > 0.004 || (k !== this.k && (k === 0 || k === 1))) {
      this.k = k;
      // The tube rises to the eye: the lens opens out from a bit too big, the view fades in
      const e = k * k * (3 - 2 * k);
      const vis = Math.min(1, Math.max(0, (k - 0.25) / 0.6));
      this.el.style.setProperty("--k", vis.toFixed(3));
      this.el.style.setProperty("--s", (1.3 - 0.3 * e).toFixed(3));
      const on = vis > 0;
      if (on !== this.shown) { this.shown = on; this.el.classList.toggle("on", on); }
    }
    if (!this.shown) return;
    const r = range == null ? -1 : Math.round(range);
    if (r !== this.range) { this.range = r; this.rangeEl.textContent = r < 0 ? "— m" : `${r} m`; }
    const b = Math.round(breath * 50) / 50;
    if (b !== this.breath) { this.breath = b; this.breathBar.style.transform = `scaleX(${b})`; }
    const showBreath = holding || b < 1;
    if (showBreath !== this.breathOn) { this.breathOn = showBreath; this.breathEl.classList.toggle("on", showBreath); }
  }

  /** The shoulder-aim reticle of a red dot / holo sight ("dot" | "holo"), or null. */
  aimReticle(kind) {
    if (kind === this.aimKind) return;
    this.aimKind = kind;
    if (kind) this.aimSvg.innerHTML = GLOW + AIM_RETICLES[kind];
    this.aimEl.classList.toggle("on", !!kind);
  }

  dispose() {
    window.removeEventListener("resize", this._resize);
    this.el.remove();
    this.aimEl.remove();
  }
}
