// Kill streaks: kills close together build a streak, each tier gets a
// callout in the middle of the screen and a small reward, and from RAMPAGE on
// the player is in a "frenzy" (PostFX goes hot, kills heal a little). The best
// streak is remembered in localStorage, so there's always a number to beat.

const WINDOW = 4.5;          // s between kills to keep the streak alive
const FRENZY_TIME = 6;       // s of frenzy when a frenzy tier is reached
const FRENZY_EXTEND = 1.5;   // s each further kill adds
const BEST_KEY = "babylon-fps:bestStreak";

/** n: kills in the streak. heal: HP reward. frenzy: starts / refreshes the frenzy. */
const TIERS = [
  { n: 2,  name: "DOUBLE KILL",  color: "#e8dccb", heal: 0 },
  { n: 3,  name: "TRIPLE KILL",  color: "#e2a42b", heal: 5 },
  { n: 5,  name: "RAMPAGE",      color: "#ff7a2a", heal: 10, frenzy: true },
  { n: 8,  name: "MASSACRE",     color: "#ff4b3a", heal: 15, frenzy: true },
  { n: 12, name: "UNSTOPPABLE",  color: "#ff2a6a", heal: 20, frenzy: true },
  { n: 20, name: "GODLIKE",      color: "#b84dff", heal: 30, frenzy: true },
];

function loadBest() {
  try { return +localStorage.getItem(BEST_KEY) || 0; } catch { return 0; }
}

export class KillStreak {
  constructor() {
    this.count = 0;
    this.timer = 0;
    this.frenzyTimer = 0;
    this.best = loadBest();
    this._newBestShown = false;

    this.el = document.createElement("div");
    this.el.id = "streak";
    this.el.innerHTML = `<div class="streak-title"></div><div class="streak-sub"></div>`;
    this.titleEl = this.el.querySelector(".streak-title");
    this.subEl = this.el.querySelector(".streak-sub");
    this.counterEl = document.createElement("div");
    this.counterEl.id = "streak-counter";
    document.body.append(this.el, this.counterEl);
    this._shownCount = -1;
    this._shownFrenzy = false;
    this._calloutT = 0;
  }

  /** 0..1, eases out over the last second of the frenzy. */
  get frenzy() { return Math.min(1, this.frenzyTimer); }

  /**
   * A kill by the local player. Returns { tier, heal, newBest } with tier null
   * between tiers. heal includes the frenzy's per-kill heal.
   */
  kill(headshot) {
    this.count = this.timer > 0 ? this.count + 1 : 1;
    this.timer = WINDOW;
    let heal = 0;
    if (this.frenzyTimer > 0) { this.frenzyTimer += FRENZY_EXTEND; heal += 3; }

    const tier = TIERS.find(t => t.n === this.count) ?? null;
    let newBest = false;
    if (this.count > this.best) {
      this.best = this.count;
      try { localStorage.setItem(BEST_KEY, String(this.best)); } catch { /* private mode */ }
      // Only make a fuss once per streak, and not for tiny records
      if (this.count >= 3 && !this._newBestShown) { newBest = true; this._newBestShown = true; }
    }
    if (tier) {
      heal += tier.heal;
      if (tier.frenzy) this.frenzyTimer = Math.max(this.frenzyTimer, FRENZY_TIME);
      const parts = [];
      if (tier.heal) parts.push(`+${tier.heal} HP`);
      if (tier.frenzy) parts.push("FRENZY");
      if (newBest) parts.push("NEW RECORD");
      this._callout(tier.name, parts.join("  ·  "), tier.color);
    } else if (newBest) {
      this._callout("NEW RECORD", `${this.count} KILL STREAK`, "#4dff88");
    } else if (headshot && this.count >= 2) {
      this._callout("HEADSHOT", `${this.count} STREAK`, "#e8dccb", true);
    }
    return { tier, heal, newBest };
  }

  _callout(title, sub, color, small = false) {
    this.titleEl.textContent = title;
    this.subEl.textContent = sub;
    this.el.style.setProperty("--streak-color", color);
    this.el.classList.toggle("small", small);
    // Restart the pop animation
    this.el.classList.remove("show");
    void this.el.offsetWidth;
    this.el.classList.add("show");
    this._calloutT = 1.8;
  }

  reset() {
    this.count = 0;
    this.timer = 0;
    this.frenzyTimer = 0;
    this._newBestShown = false;
  }

  /** dt: real seconds (a streak shouldn't last longer in slow motion). */
  update(dt) {
    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer <= 0) { this.count = 0; this._newBestShown = false; }
    }
    if (this.frenzyTimer > 0) this.frenzyTimer = Math.max(0, this.frenzyTimer - dt);
    if (this._calloutT > 0) {
      this._calloutT -= dt;
      if (this._calloutT <= 0) this.el.classList.remove("show");
    }
    // The running counter under the crosshair, only from 2 kills up
    const shown = this.count >= 2 ? this.count : 0;
    if (shown !== this._shownCount) {
      this._shownCount = shown;
      this.counterEl.textContent = shown ? `×${shown}` : "";
      this.counterEl.classList.toggle("on", shown > 0);
    }
    const frenzy = this.frenzyTimer > 0;
    if (frenzy !== this._shownFrenzy) {
      this._shownFrenzy = frenzy;
      this.counterEl.classList.toggle("frenzy", frenzy);
    }
  }
}
