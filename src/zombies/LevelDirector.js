import { getLevel, MONSTER_TYPES } from "./MonsterTypes.js";

const INTRO_TIME      = 4.5;  // banner before the first spawns
const CLEAR_TIME      = 12;   // intermission between levels
const SPAWN_RING_MIN  = 30;
const SPAWN_RING_MAX  = 50;
const LEASH           = 115;  // wanderers farther than this are recycled and respawn closer
const HOME_RADIUS     = 22;   // wanderers mill about within this of the player's area
const HOME_REFRESH    = 18;   // seconds between re-centring wanderers on the player's area

// Monsters that make an entrance partway through a level instead of
// spawning with the regular mix: level[count] of them once level[at] of the
// level's kills are done, from ring min..max metres away.
const SPECIALS = [
  { type: "boss",   count: "boss",   at: "bossAt",   min: 34, max: 42, cb: "onBossSpawn" },
  { type: "dragon", count: "dragon", at: "dragonAt", min: 45, max: 58, cb: "onDragonSpawn" },
];

/**
 * Runs the level loop: intro → fight → cleared (intermission) → next level.
 * Each level has a kill target, a cap on monsters alive at once, a spawn mix
 * (each level introduces a new type), and later Warlord bosses and dragons.
 *
 * Callbacks: onLevelStart(level), onFight(level), onLevelCleared(level),
 * onBossSpawn(monster), onDragonSpawn(monster).
 */
export class LevelDirector {
  constructor({ manager, getPlayerPos, onLevelStart, onFight, onLevelCleared, onBossSpawn, onDragonSpawn }) {
    this.manager = manager;
    this.getPlayerPos = getPlayerPos;
    this.cb = { onLevelStart, onFight, onLevelCleared, onBossSpawn, onDragonSpawn };
    this.state = "idle";
    this.level = null;
    this.playerCount = 1;       // co-op: bigger hordes for more players
    this.levelId = 0;
    this.killed = 0;
    this.spawned = 0;
    this.bossesSpawned = 0;     // all specials (Warlords + dragons) spawned this level
    this.specialSpawned = {};
    this.timer = 0;
    this._spawnTimer = 0;
    this._homeTimer = 0;
  }

  get total() {
    return this.level ? this.level.total + (this.level.boss ?? 0) + (this.level.dragon ?? 0) : 0;
  }

  get remaining() {
    return Math.max(0, this.total - this.killed);
  }

  /** Seconds left in the current intro / intermission. */
  get countdown() {
    return Math.max(0, Math.ceil(this.timer));
  }

  start(n) {
    this.manager.clearAll();
    // Co-op scaling: ~65% more monsters per extra player, more at once, extra Warlords
    const base = getLevel(n);
    const k = Math.max(1, this.playerCount);
    this.level = {
      ...base,
      total: Math.round(base.total * (1 + 0.65 * (k - 1))),
      maxAlive: Math.min(40, Math.round(base.maxAlive * (1 + 0.55 * (k - 1)))),
      boss: base.boss ? base.boss + (k >= 3 ? 1 : 0) : 0,
      // No dragon model, no dragons (or the level could never be cleared)
      dragon: this.manager.pool.types.dragon ? base.dragon ?? 0 : 0,
    };
    this.levelId++;
    this.killed = 0;
    this.spawned = 0;
    this.bossesSpawned = 0;
    this.specialSpawned = {};
    this.state = "intro";
    this.timer = INTRO_TIME;
    this.cb.onLevelStart?.(this.level);
  }

  /** After the player dies: same level, from the top. */
  restart() {
    this.start(this.level?.n ?? 1);
  }

  onKill(m) {
    if (m.levelId !== this.levelId || this.state !== "fight") return;
    this.killed++;
  }

  _pickType() {
    const mix = this.level.mix;
    let sum = 0;
    for (const [t, w] of Object.entries(mix)) if (this.manager.pool.available(t) > 0) sum += w;
    if (sum <= 0) return null;
    let r = Math.random() * sum;
    for (const [t, w] of Object.entries(mix)) {
      if (this.manager.pool.available(t) <= 0) continue;
      r -= w;
      if (r <= 0) return t;
    }
    return null;
  }

  _spawn(type, minR = SPAWN_RING_MIN, maxR = SPAWN_RING_MAX) {
    const pp = this.getPlayerPos();
    const lv = this.level;
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const r = minR + Math.random() * (maxR - minR);
      const ha = Math.random() * Math.PI * 2, hr = Math.random() * HOME_RADIUS;
      const m = this.manager.spawn(type, pp.x + Math.cos(a) * r, pp.z + Math.sin(a) * r, {
        hpMul: lv.hpMul,
        damageMul: lv.damageMul,
        speedMul: lv.speedMul,
        homeX: pp.x + Math.cos(ha) * hr,
        homeZ: pp.z + Math.sin(ha) * hr,
        hunting: Math.random() < 0.55, // about half head for your area straight away
      });
      if (m) {
        m.levelId = this.levelId;
        return m;
      }
    }
    return null;
  }

  update(delta) {
    if (this.state === "idle" || !this.level) return;
    this.timer -= delta;

    if (this.state === "intro") {
      if (this.timer <= 0) {
        this.state = "fight";
        // Opening wave
        const opening = Math.min(this.level.total, Math.ceil(this.level.maxAlive * 0.7));
        for (let i = 0; i < opening; i++) {
          const t = this._pickType();
          if (t && this._spawn(t)) this.spawned++;
        }
        this._spawnTimer = 2;
        this.cb.onFight?.(this.level);
      }
      return;
    }

    if (this.state === "cleared") {
      if (this.timer <= 0) this.start(this.level.n + 1);
      return;
    }

    // ── fight ──
    const lv = this.level;
    const mgr = this.manager;
    const pp = this.getPlayerPos();

    // Leash: far-off wanderers are recycled so they can respawn nearer
    for (let i = mgr.active.length - 1; i >= 0; i--) {
      const m = mgr.active[i];
      if (m.dying || m.state !== "wander" || m.def.boss || m.def.bossBar) continue;
      if (m.distXZ > LEASH) {
        mgr.recycle(m);
        this.spawned--;
      }
    }

    // Keep wanderers drifting around wherever the player is
    this._homeTimer -= delta;
    if (this._homeTimer <= 0) {
      this._homeTimer = HOME_REFRESH;
      for (const m of mgr.active) {
        if (m.dying || m.state !== "wander") continue;
        const a = Math.random() * Math.PI * 2, r = Math.random() * HOME_RADIUS;
        m.homeX = pp.x + Math.cos(a) * r;
        m.homeZ = pp.z + Math.sin(a) * r;
      }
    }

    // Warlord / dragon entrances
    for (const sp of SPECIALS) {
      const done = this.specialSpawned[sp.type] ?? 0;
      if (done >= (lv[sp.count] ?? 0) || this.killed < Math.floor(lv.total * (lv[sp.at] ?? 0.5))) continue;
      const m = this._spawn(sp.type, sp.min, sp.max);
      if (!m) continue;
      this.specialSpawned[sp.type] = done + 1;
      this.bossesSpawned++;
      this.spawned++;
      // They come straight for you
      mgr._spot(m, pp.x, pp.z);
      this.cb[sp.cb]?.(m);
    }

    // Regular spawns
    this._spawnTimer -= delta;
    const regularLeft = lv.total - (this.spawned - this.bossesSpawned);
    if (this._spawnTimer <= 0 && regularLeft > 0 && mgr.aliveCount < lv.maxAlive) {
      this._spawnTimer = Math.max(0.7, 2.4 - 0.12 * lv.n);
      const t = this._pickType();
      if (t && this._spawn(t)) this.spawned++;
    }

    if (this.killed >= this.total) {
      this.state = "cleared";
      this.timer = CLEAR_TIME;
      this.cb.onLevelCleared?.(lv);
    }
  }
}

export { MONSTER_TYPES };
