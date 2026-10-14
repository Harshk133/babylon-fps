// Level / boss / damage-direction / noise HUD. Every setter caches what it
// last wrote and only touches the DOM when the shown value changes.

const HIT_POOL = 4;
const HIT_LIFE = 1.1;

export class GameHUD {
  constructor() {
    this.levelEl = document.getElementById("level-hud");
    this.levelNumEl = document.getElementById("level-num");
    this.levelNameEl = document.getElementById("level-name");
    this.levelBarEl = document.getElementById("level-bar");
    this.levelCountEl = document.getElementById("level-count");

    this.bannerEl = document.getElementById("banner");
    this.bannerTitleEl = document.getElementById("banner-title");
    this.bannerSubEl = document.getElementById("banner-sub");
    this.bannerTextEl = document.getElementById("banner-text");
    this.bannerFootEl = document.getElementById("banner-foot");
    this._bannerTimer = 0;

    this.bossEl = document.getElementById("boss-bar");
    this.bossNameEl = document.getElementById("boss-name");
    this.bossFillEl = document.getElementById("boss-fill");

    this.noiseEl = document.getElementById("noise-meter");

    const dir = document.getElementById("damage-dir");
    this.hits = [];
    for (let i = 0; i < HIT_POOL; i++) {
      const el = document.createElement("div");
      el.className = "hit-arc";
      dir.append(el);
      this.hits.push({ el, life: 0 });
    }
    this._hitIndex = 0;
    this._cache = {};
  }

  _set(key, value, apply) {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    apply(value);
  }

  setLevel(n, name, killed, total) {
    this._set("lvVisible", n > 0, v => this.levelEl.classList.toggle("visible", v));
    if (n <= 0) return;
    this._set("lvNum", n, v => { this.levelNumEl.textContent = `LEVEL ${v}`; });
    this._set("lvName", name, v => { this.levelNameEl.textContent = v; });
    this._set("lvCount", `${killed}/${total}`, () => {
      this.levelCountEl.textContent = `${Math.max(0, total - killed)} left`;
      this.levelBarEl.style.transform = `scaleX(${total ? killed / total : 0})`;
    });
  }

  /** { title, sub, text, foot, color, duration } — duration 0 keeps it up. */
  showBanner({ title, sub = "", text = "", foot = "", color = "#e2a42b", duration = 4 }) {
    this.bannerTitleEl.textContent = title;
    this.bannerSubEl.textContent = sub;
    this.bannerTextEl.textContent = text;
    this.bannerFootEl.textContent = foot;
    this.bannerEl.style.setProperty("--accent", color);
    this.bannerEl.classList.remove("visible");
    void this.bannerEl.offsetWidth; // restart the entrance animation
    this.bannerEl.classList.add("visible");
    this._bannerTimer = duration;
    this._cache.foot = foot;
  }

  setBannerFoot(text) {
    this._set("foot", text, v => { this.bannerFootEl.textContent = v; });
  }

  hideBanner() {
    this.bannerEl.classList.remove("visible");
    this._bannerTimer = 0;
  }

  /** frac null hides the bar. */
  setBoss(name, frac) {
    const show = frac !== null && frac !== undefined;
    this._set("bossVisible", show, v => this.bossEl.classList.toggle("visible", v));
    if (!show) return;
    this._set("bossName", name, v => { this.bossNameEl.textContent = v; });
    this._set("bossFrac", Math.round(frac * 200) / 200, v => { this.bossFillEl.style.transform = `scaleX(${v})`; });
  }

  /** angle: radians clockwise from straight ahead (0 = in front of you). */
  hitFrom(angle, strength = 1) {
    const h = this.hits[this._hitIndex];
    this._hitIndex = (this._hitIndex + 1) % HIT_POOL;
    h.life = HIT_LIFE;
    h.el.style.transform = `rotate(${angle}rad)`;
    h.el.style.opacity = `${Math.min(1, 0.45 + strength)}`;
    h.el.classList.add("on");
  }

  /** 0 silent · 1 quiet · 2 normal · 3 loud */
  setNoise(level) {
    this._set("noise", level, v => { this.noiseEl.dataset.level = `${v}`; });
  }

  update(delta) {
    if (this._bannerTimer > 0) {
      this._bannerTimer -= delta;
      if (this._bannerTimer <= 0) this.bannerEl.classList.remove("visible");
    }
    for (const h of this.hits) {
      if (h.life <= 0) continue;
      h.life -= delta;
      if (h.life <= 0) {
        h.el.classList.remove("on");
      } else {
        const o = Math.round(Math.min(1, h.life / (HIT_LIFE * 0.6)) * 20) / 20;
        if (h.lastO !== o) { h.lastO = o; h.el.style.opacity = `${o}`; }
      }
    }
  }
}
