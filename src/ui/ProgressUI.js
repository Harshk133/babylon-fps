// Shows Progress (src/meta/Progress.js): the level / XP / daily challenge
// card in the lobby, an XP ticker under the crosshair, and toasts for
// challenge progress, completed challenges and level-ups. The DOM is touched
// only when something happens (no per-frame work).

import { rankName, XP } from "../meta/Progress.js";

const TICKER_HOLD = 1600;   // ms the "+XP" ticker keeps adding up before fading
const TOAST_TIME = 2600;    // ms a progress toast stays
const BIG_TOAST_TIME = 4200;

function fmtReset(ms) {
  const m = Math.ceil(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

export class ProgressUI {
  /**
   * profile: the lobby's level / XP badge. card: the lobby's daily challenges.
   * onLevelUp(level) / onComplete(): game-side flourish (sound, flash).
   */
  constructor(progress, { profile, card, onLevelUp, onComplete } = {}) {
    this.p = progress;
    this.profile = profile;
    this.card = card;

    this.ticker = document.createElement("div");
    this.ticker.id = "xp-ticker";
    this.toasts = document.createElement("div");
    this.toasts.id = "xp-toasts";
    document.body.append(this.ticker, this.toasts);
    this._tickerSum = 0;
    this._tickerTimer = 0;
    this._toastById = new Map();

    progress.onXp = amount => this._tick(amount);
    progress.onChallenge = (c, done) => {
      if (done) {
        this._toast(`challenge-done-${c.id}`, "CHALLENGE COMPLETE", c.text, `+${c.xp} XP`, "done", BIG_TOAST_TIME);
        onComplete?.();
      } else {
        this._toast(c.id, c.text, null, `${Math.floor(c.p).toLocaleString()} / ${c.n.toLocaleString()}`, "", TOAST_TIME, c.p / c.n);
      }
    };
    progress.onLevelUp = level => {
      this._toast("level-up", `LEVEL ${level}`, rankName(level), "LEVEL UP", "level", BIG_TOAST_TIME);
      onLevelUp?.(level);
    };
    progress.onChange = () => this.renderCard();

    if (card) {
      card.addEventListener("click", e => {
        const btn = e.target.closest("[data-reroll]");
        if (btn) this.p.reroll(+btn.dataset.reroll);
      });
      this.renderCard();
      // The reset countdown only needs minutes
      setInterval(() => { if (card.offsetParent) this.renderCard(); }, 30000);
    }
  }

  // ── Lobby card ─────────────────────────────────────────────────────────────
  renderCard() {
    if (!this.card) return;
    const p = this.p;
    const { level, into, need } = p.levelInfo();
    const list = p.challenges();
    const done = list.filter(c => c.done).length;
    const rows = list.map((c, i) => `
      <li class="pg-ch${c.done ? " done" : ""}">
        <span class="pg-tier t${c.tier}">${c.tierName}</span>
        <span class="pg-text">${c.text}${c.br ? ' <em>BR</em>' : ""}</span>
        <span class="pg-reward">${c.done ? "✓" : `+${c.xp}`}</span>
        ${p.canReroll(i) ? `<button class="pg-reroll" data-reroll="${i}" title="Swap for another challenge (once a day)">↻</button>` : ""}
        <span class="pg-track"><i style="width:${(c.p / c.n) * 100}%"></i></span>
        <span class="pg-count">${Math.floor(c.p).toLocaleString()} / ${c.n.toLocaleString()}</span>
      </li>`).join("");
    const streak = p.dayStreak.days;
    if (this.profile) this.profile.innerHTML = `
      <div class="pg-badge" title="Level ${level}">${level}</div>
      <div class="pg-info">
        <div class="pg-rank">${rankName(level)}${streak > 1 ? `<span class="pg-streak" title="Days in a row with a finished challenge">${streak}-day streak</span>` : ""}</div>
        <div class="pg-bar"><i style="width:${(into / need) * 100}%"></i></div>
        <div class="pg-xp">${into.toLocaleString()} / ${need.toLocaleString()} XP to level ${level + 1}</div>
      </div>`;
    this.card.innerHTML = `
      <div class="pg-daily-head">
        <h2>Daily challenges <span class="pg-done">${done}/3</span></h2>
        <span class="pg-reset">New in ${fmtReset(p.msToReset())}</span>
      </div>
      <ul class="pg-list">${rows}</ul>
      <div class="pg-bonus${p.bonusClaimed ? " claimed" : ""}">${p.bonusClaimed ? "All three done. Come back tomorrow for new ones" : `Finish all three for +${XP.allDailies} XP bonus`}</div>`;
  }

  // ── In game ────────────────────────────────────────────────────────────────
  _tick(amount) {
    this._tickerSum += amount;
    this.ticker.textContent = `+${this._tickerSum} XP`;
    this.ticker.classList.remove("fade");
    this.ticker.classList.add("on");
    clearTimeout(this._tickerTimer);
    this._tickerTimer = setTimeout(() => {
      this.ticker.classList.add("fade");
      this._tickerSum = 0;
    }, TICKER_HOLD);
  }

  /** One toast per key: a newer update for the same challenge replaces the text. */
  _toast(key, title, sub, right, kind, time, frac = null) {
    let t = this._toastById.get(key);
    if (!t) {
      t = { el: document.createElement("div"), timer: 0 };
      t.el.innerHTML = `<div class="xt-row"><span class="xt-title"></span><span class="xt-right"></span></div><div class="xt-sub"></div><div class="xt-track"><i></i></div>`;
      this._toastById.set(key, t);
      this.toasts.prepend(t.el);
    }
    t.el.className = `xp-toast ${kind}`;
    t.el.querySelector(".xt-title").textContent = title;
    t.el.querySelector(".xt-right").textContent = right ?? "";
    const subEl = t.el.querySelector(".xt-sub");
    subEl.textContent = sub ?? "";
    subEl.hidden = !sub;
    const track = t.el.querySelector(".xt-track");
    track.hidden = frac === null;
    if (frac !== null) track.firstChild.style.width = `${Math.min(1, frac) * 100}%`;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      t.el.classList.add("out");
      t.timer = setTimeout(() => { t.el.remove(); this._toastById.delete(key); }, 400);
    }, time);
  }
}
