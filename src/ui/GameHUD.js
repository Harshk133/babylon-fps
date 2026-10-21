// Level / boss / damage-direction / noise / world-clock / kill-feed HUD.
// Every setter caches what it last wrote and only touches the DOM when the
// shown value changes.

import { icon } from "./gameIcons.js";

const HIT_POOL = 4;
const HIT_LIFE = 1.1;
const FEED_MAX = 5;
const FEED_LIFE = 4.5;
const PHASE_ICON = { Night: "moon", Dawn: "cloud", Day: "sun", Dusk: "cloud" };

/** A small tile of monochrome noise for the film-grain overlay. */
function grainDataUrl() {
  const c = document.createElement("canvas");
  c.width = c.height = 160;
  const g = c.getContext("2d");
  const img = g.createImageData(160, 160);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

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

    this.envEl = document.getElementById("env-hud");
    this.envIconEl = document.getElementById("env-icon");
    this.envTimeEl = document.getElementById("env-time");
    this.envPhaseEl = document.getElementById("env-phase");
    this.envWeatherEl = document.getElementById("env-weather");
    this.envTorchEl = document.getElementById("env-torch");
    this.killFeedEl = document.getElementById("kill-feed");
    this.feed = [];
    this.vignetteEl = document.getElementById("vignette");
    const grain = document.getElementById("grain");
    if (grain) grain.style.backgroundImage = `url(${grainDataUrl()})`;
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

  /** frac null hides the bar. color: the monster's accent. */
  setBoss(name, frac, color = "#7fd4ff") {
    const show = frac !== null && frac !== undefined;
    this._set("bossVisible", show, v => this.bossEl.classList.toggle("visible", v));
    if (!show) return;
    this._set("bossName", name, v => { this.bossNameEl.textContent = v; });
    this._set("bossColor", color, v => this.bossEl.style.setProperty("--boss", v));
    this._set("bossFrac", Math.round(frac * 200) / 200, v => { this.bossFillEl.style.transform = `scaleX(${v})`; });
  }

  /** Clock, phase, weather and flashlight, under the minimap. */
  setWorld(time, phase, weather, torchOn, bloodMoon) {
    if (!this.envEl) return;
    this._set("envTime", time, v => { this.envTimeEl.textContent = v; });
    this._set("envPhase", phase, v => {
      this.envPhaseEl.textContent = v;
      this.envIconEl.innerHTML = icon(PHASE_ICON[v] ?? "moon");
      this.envEl.dataset.phase = v.toLowerCase();
    });
    this._set("envWeather", weather, v => { this.envWeatherEl.textContent = v; });
    this._set("envTorch", torchOn, v => this.envTorchEl.classList.toggle("on", v));
    this._set("envBlood", bloodMoon, v => this.envEl.classList.toggle("blood", v));
  }

  /** 0 day … 1 night: deepens the vignette. */
  setDarkness(d) {
    this._set("dark", Math.round(d * 10) / 10, v => this.vignetteEl?.style.setProperty("--dark", `${v}`));
  }

  /** "HEADSHOT · Hellhound" in the top-right feed. */
  killFeed(label, verb, color, headshot) {
    if (!this.killFeedEl) return;
    const el = document.createElement("div");
    el.className = `kf-item${headshot ? " head" : ""}`;
    el.style.setProperty("--c", color);
    const v = document.createElement("span");
    v.className = "kf-verb";
    v.textContent = verb;
    const n = document.createElement("span");
    n.className = "kf-name";
    n.textContent = label;
    el.append(v, n);
    this.killFeedEl.prepend(el);
    this.feed.unshift({ el, life: FEED_LIFE });
    while (this.feed.length > FEED_MAX) this.feed.pop().el.remove();
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
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const f = this.feed[i];
      f.life -= delta;
      if (f.life <= 0) { f.el.remove(); this.feed.splice(i, 1); }
      else if (f.life < 0.5 && !f.out) { f.out = true; f.el.classList.add("out"); }
    }
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
