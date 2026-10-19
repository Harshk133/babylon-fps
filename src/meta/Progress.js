// Player progression: XP and levels, plus three daily challenges (easy,
// medium, hard) that everyone gets on the same calendar day. Pure state kept
// in localStorage; ProgressUI listens through the on* callbacks. main.js
// reports what happened (kills, cleared levels, battle royale results,
// distance driven) and never touches the numbers itself.

const KEY = "babylon-fps:progress";

/** XP for a kill, by monster type; headshots add HEADSHOT_XP. */
const KILL_XP = { walker: 10, runner: 12, listener: 12, gunner: 15, hound: 15, brute: 25, dragon: 150, boss: 200 };
const HEADSHOT_XP = 5;
export const XP = {
  levelCleared: n => 40 + 15 * n,
  pvpKill: 50,
  pvpHeadshot: 15,
  brPlayed: 40,      // finishing a real match (2+ players)
  brPerBeaten: 20,   // per player you outlasted
  brWin: 150,
  allDailies: 150,   // all three of the day's challenges
};

/** XP to go from `level` to the next one. */
export function levelCost(level) { return 100 + 40 * level; }

export const RANKS = [
  [1, "Fresh Meat"], [5, "Survivor"], [10, "Scavenger"], [15, "Hunter"],
  [20, "Slayer"], [30, "Warlord's Bane"], [40, "Legend"], [50, "Undying"],
];
export function rankName(level) {
  let name = RANKS[0][1];
  for (const [l, n] of RANKS) if (level >= l) name = n;
  return name;
}

/**
 * Challenge catalogue. stat: the counter it watches. n / xp: per tier
 * (easy, medium, hard; null = not offered at that tier). max: progress is
 * the best single value (a streak, a level) instead of a running total.
 * step: progress notifications every `step` units (distance). {s} / {es}
 * pluralise for n ≠ 1. br: needs a
 * battle royale match, so at most one of these per day.
 */
const CHALLENGES = [
  { id: "kills",    stat: "kills",      text: "Kill {n} monsters",                     n: [30, 75, 150],  xp: [100, 200, 350] },
  { id: "heads",    stat: "headshots",  text: "Land {n} headshot kills",               n: [10, 25, 50],   xp: [100, 220, 380] },
  { id: "night",    stat: "nightKills", text: "Kill {n} monsters at night",            n: [15, 40, 80],   xp: [120, 240, 400] },
  { id: "fire",     stat: "fireKills",  text: "Burn {n} monsters with molotovs",       n: [5, 12, 25],    xp: [100, 200, 350] },
  { id: "blast",    stat: "blastKills", text: "Blow up {n} monsters with grenades",    n: [5, 12, 25],    xp: [100, 200, 350] },
  { id: "road",     stat: "roadKills",  text: "Run over {n} monsters in the rickshaw", n: [3, 8, 15],     xp: [100, 220, 380] },
  { id: "hounds",   stat: "houndKills", text: "Kill {n} Hellhounds",                   n: [4, 10, 20],    xp: [110, 220, 380] },
  { id: "brutes",   stat: "bruteKills", text: "Kill {n} Brutes",                       n: [2, 5, 10],     xp: [110, 220, 380] },
  { id: "gunners",  stat: "gunnerKills",text: "Kill {n} Gunners",                      n: [5, 12, 25],    xp: [110, 220, 380] },
  { id: "dragon",   stat: "dragonKills",text: "Bring down {n} Gold Dragon{s}",            n: [null, null, 1], xp: [0, 0, 450] },
  { id: "warlord",  stat: "bossKills",  text: "Kill {n} Warlord{s}",                      n: [null, null, 1], xp: [0, 0, 450] },
  { id: "levels",   stat: "levels",     text: "Clear {n} levels",                      n: [2, 4, 7],      xp: [100, 220, 400] },
  { id: "streak",   stat: "streak",     text: "Reach a {n} kill streak",               n: [3, 5, 8],      xp: [100, 200, 350], max: true },
  { id: "drive",    stat: "drive",      text: "Drive the rickshaw {n} m",              n: [500, 1500, 3000], xp: [80, 160, 280], step: 100 },
  { id: "brplay",   stat: "brPlayed",   text: "Play {n} Battle Royale match{es}",        n: [1, 3, 5],      xp: [100, 220, 380], br: true },
  { id: "brkills",  stat: "brKills",    text: "Eliminate {n} players in Battle Royale",n: [1, 3, 6],      xp: [120, 250, 420], br: true },
  { id: "brwin",    stat: "brWins",     text: "Win {n} Battle Royale match{es}",           n: [null, 1, 2],   xp: [0, 300, 500],   br: true },
];
const BY_ID = Object.fromEntries(CHALLENGES.map(c => [c.id, c]));
export const TIER_NAMES = ["Easy", "Medium", "Hard"];
const REROLLS_PER_DAY = 1;

/** "2026-10-19" in the player's own time zone: dailies turn over at local midnight. */
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function yesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dayKey(d);
}

/** Small seeded RNG so the same day deals the same challenges. */
function rngFor(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function candidates(tier, taken, rand) {
  const brTaken = taken.some(id => BY_ID[id].br);
  const list = CHALLENGES.filter(c => c.n[tier] !== null && !taken.includes(c.id) && !(brTaken && c.br));
  return list[Math.floor(rand() * list.length)];
}

function dealDay(day) {
  const rand = rngFor(day);
  const taken = [];
  return [0, 1, 2].map(tier => {
    const c = candidates(tier, taken, rand);
    taken.push(c.id);
    return { id: c.id, tier, p: 0, done: false };
  });
}

export class Progress {
  constructor() {
    this.enabled = true;
    /** (amount, reason) — every XP gain. */
    this.onXp = null;
    /** (challenge view, justCompleted) — progress moved on a daily. */
    this.onChallenge = null;
    /** (level) */
    this.onLevelUp = null;
    /** () — anything shown in the lobby card changed. */
    this.onChange = null;
    /** XP earned since the last resetRun() (a life, a match). */
    this.runXp = 0;
    this._load();
    this._rollDay();
    this._saveTimer = 0;
    addEventListener("pagehide", () => this._flush());
  }

  // ── State ──────────────────────────────────────────────────────────────────
  _load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch { /* private mode / bad JSON */ }
    this.xp = Math.max(0, +s?.xp || 0);
    this.day = s?.day ?? "";
    this.daily = Array.isArray(s?.daily) ? s.daily.filter(d => BY_ID[d?.id]) : [];
    this.rerolls = s?.rerolls ?? REROLLS_PER_DAY;
    this.bonusClaimed = !!s?.bonus;
    this.dayStreak = { days: s?.streak?.days ?? 0, last: s?.streak?.last ?? "" };
  }

  _save() {
    // Kills can come several a second; write at most once a second
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this._flush(), 1000);
  }

  _flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = 0;
    const s = { xp: this.xp, day: this.day, daily: this.daily, rerolls: this.rerolls, bonus: this.bonusClaimed, streak: this.dayStreak };
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
  }

  /** New calendar day: deal fresh challenges. Returns true if it turned over. */
  _rollDay() {
    const today = dayKey();
    if (this.day === today && this.daily.length === 3) return false;
    this.day = today;
    this.daily = dealDay(today);
    this.rerolls = REROLLS_PER_DAY;
    this.bonusClaimed = false;
    // A streak survives only if yesterday had a completed challenge
    if (this.dayStreak.last !== today && this.dayStreak.last !== yesterdayKey()) this.dayStreak.days = 0;
    this._save();
    this.onChange?.();
    return true;
  }

  // ── Read-only views for the UI ─────────────────────────────────────────────
  /** Current level, XP into it and the cost of the next one. */
  get level() { return this._levelInfo().level; }
  _levelInfo() {
    let level = 1, rest = this.xp;
    while (rest >= levelCost(level) && level < 999) { rest -= levelCost(level); level++; }
    return { level, into: rest, need: levelCost(level) };
  }
  levelInfo() { return this._levelInfo(); }

  /** The day's challenges with their text filled in. */
  challenges() {
    this._rollDay();
    return this.daily.map(d => this._view(d));
  }
  _view(d) {
    const c = BY_ID[d.id];
    const n = c.n[d.tier];
    return {
      id: d.id, tier: d.tier, tierName: TIER_NAMES[d.tier],
      text: c.text.replace("{n}", n.toLocaleString()).replace("{es}", n === 1 ? "" : "es").replace("{s}", n === 1 ? "" : "s"),
      p: Math.min(d.p, n), n, xp: c.xp[d.tier], done: d.done, br: !!c.br,
    };
  }

  /** ms until the challenges turn over (local midnight). */
  msToReset() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return next - now;
  }

  canReroll(i) { return this.rerolls > 0 && !!this.daily[i] && !this.daily[i].done; }

  /** Swap challenge i for another of the same tier (one per day). */
  reroll(i) {
    this._rollDay();
    if (!this.canReroll(i)) return false;
    const d = this.daily[i];
    const taken = this.daily.filter((_, j) => j !== i).map(x => x.id).concat(d.id);
    const c = candidates(d.tier, taken, Math.random);
    if (!c) return false;
    this.daily[i] = { id: c.id, tier: d.tier, p: 0, done: false };
    this.rerolls--;
    this._save();
    this.onChange?.();
    return true;
  }

  // ── Events from the game ───────────────────────────────────────────────────
  resetRun() { this.runXp = 0; }

  /**
   * A monster kill credited to this player. type: MONSTER_TYPES key.
   * cause: "head" | "gun" | "blast" | "fire" | "road". night: env darkness.
   */
  kill(type, cause, night) {
    if (!this.enabled) return;
    const head = cause === "head";
    this._gain((KILL_XP[type] ?? 10) + (head ? HEADSHOT_XP : 0), head ? "Headshot" : "Kill");
    this._add("kills", 1);
    if (head) this._add("headshots", 1);
    if (night) this._add("nightKills", 1);
    if (cause === "fire") this._add("fireKills", 1);
    if (cause === "blast") this._add("blastKills", 1);
    if (cause === "road") this._add("roadKills", 1);
    if (type) this._add(`${type}Kills`, 1);
  }

  /** A battle royale elimination by this player. */
  pvpKill(headshot) {
    if (!this.enabled) return;
    this._gain(XP.pvpKill + (headshot ? XP.pvpHeadshot : 0), "Elimination");
    this._add("brKills", 1);
    if (headshot) this._add("headshots", 1);
  }

  /** The running kill streak (KillStreak.count) after a kill. */
  streak(count) {
    if (this.enabled) this._add("streak", count);
  }

  levelCleared(n) {
    if (!this.enabled) return;
    this._gain(XP.levelCleared(n), `Level ${n} cleared`);
    this._add("levels", 1);
  }

  /** Where this player finished a battle royale match of `players`. */
  brFinished(place, players) {
    if (!this.enabled || players < 2) return; // practice drops don't count
    this._gain(XP.brPlayed + XP.brPerBeaten * (players - place) + (place === 1 ? XP.brWin : 0),
      place === 1 ? "Victory" : `#${place} of ${players}`);
    this._add("brPlayed", 1);
    if (place === 1) this._add("brWins", 1);
  }

  /** Metres driven in the rickshaw (called every frame while driving). */
  drive(metres) {
    if (this.enabled && metres > 0) this._add("drive", metres);
  }

  _gain(amount, reason) {
    if (amount <= 0) return;
    const before = this.level;
    this.xp += amount;
    this.runXp += amount;
    this._save();
    this.onXp?.(amount, reason);
    const after = this.level;
    if (after > before) this.onLevelUp?.(after);
    this.onChange?.();
  }

  _add(stat, amount) {
    if (this._rollDay()) return this._add(stat, amount);
    for (const d of this.daily) {
      const c = BY_ID[d.id];
      if (d.done || c.stat !== stat) continue;
      const n = c.n[d.tier];
      const step = c.step ?? 1;
      const before = Math.floor(d.p / step);
      d.p = c.max ? Math.max(d.p, amount) : d.p + amount;
      if (d.p >= n) {
        d.done = true;
        d.p = n;
        this._completed(d, c);
      } else if (Math.floor(d.p / step) !== before) {
        this.onChallenge?.(this._view(d), false);
        this._save();
      }
    }
  }

  _completed(d, c) {
    const today = dayKey();
    if (this.dayStreak.last !== today) {
      this.dayStreak.days = this.dayStreak.last === yesterdayKey() ? this.dayStreak.days + 1 : 1;
      this.dayStreak.last = today;
    }
    this.onChallenge?.(this._view(d), true);
    this._gain(c.xp[d.tier], "Challenge complete");
    if (!this.bonusClaimed && this.daily.every(x => x.done)) {
      this.bonusClaimed = true;
      this._gain(XP.allDailies, "All dailies done");
    }
    this._save();
  }
}
