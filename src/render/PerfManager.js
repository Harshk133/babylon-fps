// Frame pacing and adaptive quality, in one place.
//
// 1. Refresh rate. No browser API reports it, so it's read off the gaps
//    between requestAnimationFrame calls (a low percentile over a few seconds:
//    a slow frame stretches a gap to two vsyncs, never shortens one).
//
// 2. Frame cap. A cap only paces evenly if it divides the refresh rate: 60 on
//    a 144 Hz screen means alternating 2 and 3 vsyncs (14 / 21 ms, a judder),
//    and on a 90 Hz phone it came out as 45 anyway. So every cap is a whole
//    divisor of the measured rate (144 → 72 / 48, 120 → 60 / 40, 90 → 45).
//    "auto" starts at the highest level and steps down one divisor when the
//    device can't hold it (even pacing beats a frame rate that wobbles), then
//    tries the next level up again later, waiting longer after each failure.
//    Phones: at most 60 (heat and battery); desktops: never below ~60 by itself.
//
// 3. Dynamic resolution (moved here from main.js, same behaviour): render
//    scale down when GPU-bound frames run long, back up with headroom.
//
// 4. Tiers. When resolution is already at its floor (GPU-bound) or the frame
//    is CPU-bound (where resolution wouldn't help), it sheds work in steps,
//    one tier per few seconds at most, judged on the p90 frame time of the
//    last second (not single frames), with hysteresis and back-off. A tier
//    only touches knobs that don't change shader programs (no recompile
//    hitch) and never changes colliders or what an enemy can see: main.js's
//    applyPerfTiers() lists them.

const KNOWN_HZ = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240];
const GAPS = 240;              // rAF gaps kept for the refresh estimate
export const MAX_TIER = 3;

export class PerfManager {
  /**
   * opts: { touch, maxRatio, minRatio, canScale(), applyRatio(r), setting(): "auto"|"max"|"60"|"30",
   *         playing(): bool, resizeBlocked(): bool }
   */
  constructor(opts) {
    this.o = opts;
    this.touch = !!opts.touch;
    this.maxRatio = opts.maxRatio;
    this.minRatio = Math.min(opts.minRatio, opts.maxRatio);
    // Dynamic resolution state (as it was in main.js)
    this.ratio = opts.maxRatio;
    this.avg = 16.7;           // smoothed frame ms
    this.logic = 8;            // smoothed CPU ms
    this._slow = 0; this._fast = 0; this._upWait = 3000; this._raisedAt = -1e9;
    // Refresh estimate
    this._gaps = new Float32Array(GAPS);
    this._gapN = 0; this._gapI = 0;
    this._lastTick = 0;
    this._lastRender = 0;
    this.refresh = 0;          // Hz, 0 until known
    this._refreshCheck = 0;
    this._lowerSince = 0;
    // Auto cap: index into levels() (0 = the highest)
    this.autoLevel = 0;
    this._capSlow = 0;
    this._probeAt = 0;
    this._probing = false;
    this._probeWait = 30;
    // Tiers
    this.gpuTier = 0;
    this.cpuTier = 0;
    this.tierReason = "";
    this._win = new Float32Array(240);       // frame ms over the last second-ish
    this._winCpu = new Float32Array(240);
    this._winN = 0;
    this._winAt = 0;
    this._overFor = 0;                       // s the window has been over budget
    this._underFor = 0;
    this._tierWait = 10;                     // s under budget before giving a tier back
    this._tierRaisedAt = -1e9;
    this._sorted = new Float32Array(240);
    this._listeners = [];
  }

  /** fn(gpuTier, cpuTier) whenever a tier changes. */
  onTier(fn) { this._listeners.push(fn); }

  // ── Refresh rate ────────────────────────────────────────────────────────────

  _noteGap(gap) {
    if (gap <= 2 || gap > 60) return;
    this._gaps[this._gapI] = gap;
    this._gapI = (this._gapI + 1) % GAPS;
    this._gapN = Math.min(GAPS, this._gapN + 1);
  }

  _estimateRefresh(now) {
    if (this._gapN < 60 || now < this._refreshCheck) return;
    this._refreshCheck = now + 1000;
    const s = this._sorted.subarray(0, Math.min(this._gapN, 240));
    s.set(this._gaps.subarray(0, s.length));
    s.sort();
    const gap = s[Math.floor(s.length * 0.25)];      // a low percentile: one vsync (not the odd early tick)
    const hz = 1000 / gap;
    let best = KNOWN_HZ[0];
    for (const k of KNOWN_HZ) if (Math.abs(k - hz) < Math.abs(best - hz)) best = k;
    if (Math.abs(best - hz) / best > 0.08) best = Math.round(hz);
    // Slow frames never show a single vsync gap, so a low reading only means the
    // game is slow, not that the screen is: below 55 Hz assume 60 (true 30 Hz rAF,
    // iOS low-power mode, then simply never sees a skipped frame, which is right)
    if (best < 55) best = 60;
    if (!this.refresh || best > this.refresh) { this.refresh = best; this._lowerSince = 0; this.autoLevel = Math.min(this.autoLevel, this.levels().length - 1); }
    else if (best < this.refresh) {
      // Lower only once it's stayed lower a while (battery saver halving rAF, a moved window)
      if (!this._lowerSince) this._lowerSince = now;
      else if (now - this._lowerSince > 8000) { this.refresh = best; this._lowerSince = 0; this.autoLevel = 0; }
    } else this._lowerSince = 0;
  }

  /** Frame rates that pace evenly on this screen, highest first, within the mode's range. */
  levels() {
    const hz = this.refresh || 60;
    const out = [];
    for (let n = 1; n <= 8; n++) {
      const f = hz / n;
      if (this.touch ? f > 61 : false) continue;      // phones: never above 60
      if (f < (this.touch ? 29 : 55) && out.length) break;  // desktops keep ~60 or more by themselves
      out.push(f);
    }
    if (!out.length) out.push(hz);
    return out;
  }

  /** The cap in force, in FPS (0: none, every vsync). */
  get cap() {
    const s = this.o.setting();
    const hz = this.refresh;
    if (s === "max") return 0;
    if (!hz) return this.touch ? 60 : 0;               // not measured yet
    if (s === "60" || s === "30") {
      const want = +s;
      const n = Math.max(1, Math.round(hz / want));
      return hz / n;
    }
    const lv = this.levels();
    return lv[Math.min(this.autoLevel, lv.length - 1)];
  }

  /** Frame budget in ms for the cap in force (60 FPS when uncapped above 60). */
  get budget() {
    const c = this.cap || this.refresh || 60;
    return 1000 / Math.min(c, 60);
  }

  /**
   * Call first thing in every requestAnimationFrame callback. False: skip this
   * vsync (the cap), return straight away.
   */
  tick(now) {
    if (this._lastTick) this._noteGap(now - this._lastTick);
    this._lastTick = now;
    this._estimateRefresh(now);
    const cap = this.cap;
    const hz = this.refresh || 60;
    if (!cap || cap >= hz * 0.97) { this._lastRender = now; return true; }
    // Render on every n-th vsync: allow half a vsync of jitter
    const minGap = 1000 / cap - 500 / hz;
    if (now - this._lastRender < minGap) return false;
    this._lastRender = now;
    return true;
  }

  // ── Per frame, after rendering ──────────────────────────────────────────────

  /** frameMs: time since the last frame. cpuMs: JavaScript spent on it (logic + draw submission). */
  endFrame(frameMs, cpuMs) {
    this._dynamicResolution(frameMs, cpuMs);
    this._autoCap(frameMs);
    this._tiers(frameMs, cpuMs);
  }

  get cpuBound() { return this.logic > this.avg * 0.6; }

  /**
   * When the CPU eats most of the frame, a lower resolution would only blur
   * the picture without making it faster, so it stays sharp. With the grade
   * pass (canScale) a change only moves the viewport the scene draws into,
   * which is free; otherwise it reallocates the canvas and targets (a hitch),
   * so a raise that gets taken back within 8 s doubles the wait before the next.
   */
  _dynamicResolution(frameMs, cpuMs) {
    this.avg += (Math.min(frameMs, 100) - this.avg) * 0.05;
    this.logic += (Math.min(cpuMs, 100) - this.logic) * 0.05;
    const budget = this.budget;
    if (this.avg > budget * 1.2 && !this.cpuBound) { this._slow += frameMs; this._fast = 0; }
    else if (this.avg < budget * 0.84) { this._fast += frameMs; this._slow = 0; }
    else { this._slow = 0; this._fast = 0; }

    let next = this.ratio;
    const now = performance.now();
    if (this._slow > 600) {
      next = Math.max(this.minRatio, this.ratio - 0.1);
      if (next !== this.ratio && now - this._raisedAt < 8000) this._upWait = Math.min(60000, this._upWait * 2);
    } else if (this._fast > this._upWait) {
      next = Math.min(this.maxRatio, this.ratio + 0.05);
      if (next !== this.ratio) this._raisedAt = now;
    }
    if (next !== this.ratio && !this.o.canScale() && this.o.resizeBlocked?.()) { this._slow = this._fast = 0; return; }
    if (next !== this.ratio) {
      this.ratio = next;
      this._slow = 0;
      this._fast = 0;
      this.o.applyRatio(next);
    }
  }

  get atMinRatio() { return this.ratio <= this.minRatio + 0.01; }

  _autoCap(frameMs) {
    if (this.o.setting() !== "auto" || !this.o.playing() || !this.refresh) return;
    const lv = this.levels();
    const now = performance.now() / 1000;
    const level = Math.min(this.autoLevel, lv.length - 1);
    const budget = 1000 / lv[level];
    // Can't hold this level: frames clearly over its budget, with nothing left
    // to give (resolution at the floor, or the CPU is what's slow)
    const stuck = this.avg > budget * 1.25 && (this.atMinRatio || this.cpuBound || budget < 1000 / 61);
    if (level < lv.length - 1) {
      this._capSlow = stuck ? this._capSlow + frameMs / 1000 : 0;
      if (this._capSlow > (this._probing ? 4 : 6)) {
        this.autoLevel = level + 1;
        this._capSlow = 0;
        if (this._probing) this._probeWait = Math.min(240, this._probeWait * 2);   // a failed try: wait longer
        this._probing = false;
        this._probeAt = now + this._probeWait;
        return;
      }
    }
    if (this._probing && now > this._probeAt + 8) { this._probing = false; this._probeWait = 30; }  // held it: stay
    if (level > 0 && !this._probing && now > this._probeAt && this.avg < (1000 / lv[level - 1]) * 1.05) {
      this.autoLevel = level - 1;
      this._probing = true;
      this._probeAt = now;
    } else if (level > 0 && !this._probing && now > this._probeAt + this._probeWait) {
      // Try the next level up every so often anyway: the scene may have got lighter
      this.autoLevel = level - 1;
      this._probing = true;
      this._probeAt = now;
      this.avg = 1000 / lv[level - 1];
    }
  }

  _tiers(frameMs, cpuMs) {
    if (!this.o.playing()) { this._winN = 0; this._overFor = this._underFor = 0; return; }
    if (this._winN < this._win.length) {
      this._win[this._winN] = frameMs;
      this._winCpu[this._winN] = cpuMs;
      this._winN++;
    }
    const now = performance.now();
    if (now - this._winAt < 1000) return;
    const dt = Math.min(2, (now - this._winAt) / 1000);
    this._winAt = now;
    const n = this._winN;
    this._winN = 0;
    if (n < 10) return;
    const s = this._sorted.subarray(0, n);
    s.set(this._win.subarray(0, n));
    s.sort();
    const p90 = s[Math.floor(n * 0.9)];
    let cpu = 0;
    for (let k = 0; k < n; k++) cpu += this._winCpu[k];
    cpu /= n;
    const budget = this.budget;
    const cpuBound = cpu > budget * 0.8 || cpu > p90 * 0.65;
    if (p90 > budget * 1.15) { this._overFor += dt; this._underFor = 0; }
    else if (p90 < budget * 0.8) { this._underFor += dt; this._overFor = 0; }
    else { this._overFor = 0; this._underFor = 0; }

    if (this._overFor >= 3) {
      this._overFor = 0;
      if (cpuBound && this.cpuTier < MAX_TIER) { this.cpuTier++; this.tierReason = `CPU ${cpu.toFixed(1)} ms of ${p90.toFixed(1)}`; this._changed(now, true); }
      else if (!cpuBound && this.atMinRatio && this.gpuTier < MAX_TIER) { this.gpuTier++; this.tierReason = `GPU (p90 ${p90.toFixed(1)} ms at min scale)`; this._changed(now, true); }
    } else if (this._underFor >= this._tierWait && (this.gpuTier || this.cpuTier)) {
      this._underFor = 0;
      // Give back the most recent kind of saving first: GPU tiers cost more to look at
      if (this.gpuTier) this.gpuTier--; else this.cpuTier--;
      this.tierReason = `headroom (p90 ${p90.toFixed(1)} ms)`;
      this._raisedAt2 = now;
      this._changed(now, false);
    }
  }

  _changed(now, worse) {
    // A tier given back and needed again within 15 s: wait twice as long before the next give-back
    if (worse && now - (this._raisedAt2 ?? -1e9) < 15000) this._tierWait = Math.min(120, this._tierWait * 2);
    for (const fn of this._listeners) fn(this.gpuTier, this.cpuTier);
  }

  /** One line for the profiler overlay. */
  describe() {
    const c = this.cap;
    return `${this.refresh || "?"} Hz · cap ${c ? c.toFixed(c % 1 ? 1 : 0) : "none"} (${this.o.setting()}) · scale ${this.ratio.toFixed(2)} · tier gpu ${this.gpuTier} cpu ${this.cpuTier}${this.tierReason ? " · " + this.tierReason : ""}`;
  }
}
