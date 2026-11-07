// Development performance overlay and benchmark. Off unless the page address
// has ?perf=1 (overlay) or ?bench=1 (overlay + a scripted 30 s benchmark), so
// production play pays nothing but a couple of flag checks per frame.
//
// What it measures, and what it can't:
//   frame      — time between frames (what the player feels), percentiles + worst spike
//   logic      — JavaScript time for the game update (physics, AI, animation, HUD)
//   submit     — JavaScript time inside renderer.render: building and issuing draw
//                calls. This is CPU time, NOT GPU execution time.
//   gpu        — real GPU time per frame, only where the browser exposes
//                EXT_disjoint_timer_query_webgl2 (many Android Chromes / WebViews
//                do, desktop Chrome usually doesn't). Shown as "n/a" otherwise.
//   draw calls / triangles / geometries / textures from renderer.info,
//   JS heap where performance.memory exists (Chromium only).

const params = new URLSearchParams(location.search);
export const PERF_ENABLED = params.has("perf") || params.has("bench");
export const BENCH_ENABLED = params.has("bench");

const RING = 600;           // frames kept for percentiles (≈ 10 s at 60 FPS)
const PANEL_HZ = 4;

// Where the frame's JavaScript goes. main.js calls mark(name) after each part
// of the frame; the time since the previous mark is booked to that name.
export const SECTIONS = ["input", "move", "physics", "postStep", "world", "ai", "remote", "net", "camera",
  "soldier", "weapons", "fx", "pickups", "hud", "minimap", "mood", "submit"];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export class PerfOverlay {
  /** renderer: THREE.WebGLRenderer. */
  constructor(renderer) {
    this.renderer = renderer;
    this.frame = new Float32Array(RING);
    this.logic = new Float32Array(RING);
    this.submit = new Float32Array(RING);
    this.gpu = [];
    this.n = 0;
    this.i = 0;
    this.last = 0;
    this.counts = {};
    this.extra = {};
    this._next = 0;
    this._sorted = new Float32Array(RING);
    this.sec = {};
    this._secNow = {};
    for (const n of SECTIONS) { this.sec[n] = new Float32Array(RING); this._secNow[n] = 0; }
    this._mark = 0;
    this.substeps = new Uint8Array(RING);
    this.net = null;          // Net instance, for traffic rates
    this._netPrev = null;
    this._netAt = 0;
    this.netRate = null;
    this.hitches = [];        // frames over 100 ms: when, how long, and where the JS time went
    this._t0 = performance.now();

    // GPU timer queries (optional)
    const gl = renderer.getContext();
    this.gl = gl;
    this.timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    this.queries = [];
    this.activeQuery = null;

    this.el = document.createElement("pre");
    this.el.id = "perf-overlay";
    Object.assign(this.el.style, {
      position: "fixed", left: "6px", top: "50%", transform: "translateY(-50%)", zIndex: 5000,
      margin: 0, padding: "6px 8px", background: "rgba(0,0,0,0.72)", color: "#c8f7c8",
      font: "11px/1.35 ui-monospace, Consolas, monospace", pointerEvents: "none", whiteSpace: "pre",
      borderRadius: "4px", maxWidth: "46vw",
    });
    document.body.append(this.el);
  }

  /** Call at the very start of the frame. */
  beginFrame(now) {
    if (this.last) {
      this.frame[this.i] = now - this.last;
      this._frameStart = now;
    }
    this.last = now;
    this._mark = now;
    for (const n of SECTIONS) this._secNow[n] = 0;
  }

  /** Books the time since the previous mark to `name` (a SECTIONS entry). */
  mark(name) {
    const t = performance.now();
    this._secNow[name] += t - this._mark;
    this._mark = t;
  }

  /** Physics sub-steps taken this frame. */
  steps(n) { this.substeps[this.i] = n; }

  /** Logic done, about to render. */
  markRender(now) {
    this._logic = now - (this._frameStart ?? now);
    this._renderStart = now;
    if (this.timerExt && !this.activeQuery) {
      const gl = this.gl;
      const q = gl.createQuery();
      gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
      this.activeQuery = q;
    }
  }

  /** Render calls issued. */
  endFrame(now, counts) {
    if (this.activeQuery) {
      this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
      this.queries.push(this.activeQuery);
      this.activeQuery = null;
    }
    this._pollGpu();
    this.logic[this.i] = this._logic ?? 0;
    this.submit[this.i] = now - (this._renderStart ?? now);
    this._secNow.submit = this.submit[this.i];
    for (const n of SECTIONS) this.sec[n][this.i] = this._secNow[n];
    const fm = this.frame[this.i];
    if (fm > 100 && this.hitches.length < 40) {
      let top = "", topMs = 0;
      for (const n of SECTIONS) if (this._secNow[n] > topMs) { topMs = this._secNow[n]; top = n; }
      const progs = this.renderer.info.programs?.length ?? 0, tex = this.renderer.info.memory.textures, geo = this.renderer.info.memory.geometries;
      this.hitches.push({ at: +((now - this._t0) / 1000).toFixed(1), ms: +fm.toFixed(0), logic: +(this._logic ?? 0).toFixed(1), submit: +this.submit[this.i].toFixed(1),
        top, topMs: +topMs.toFixed(1), newPrograms: progs - (this._progs ?? progs), newTextures: tex - (this._tex ?? tex), newGeometries: geo - (this._geo ?? geo), note: this.note ?? "" });
    }
    {
      this._progs = this.renderer.info.programs?.length ?? 0;
      this._tex = this.renderer.info.memory.textures;
      this._geo = this.renderer.info.memory.geometries;
    }
    this.i = (this.i + 1) % RING;
    this.n = Math.min(RING, this.n + 1);
    this.counts = counts;
    // The frame's totals (read later, after the next frame's reset, they'd be 0)
    this.calls = this.renderer.info.render.calls;
    this.triangles = this.renderer.info.render.triangles;
    if (now >= this._next) {
      this._next = now + 1000 / PANEL_HZ;
      this._sampleNet(now);
      this.el.textContent = this.report().text;
    }
  }

  _sampleNet(now) {
    const st = this.net?.stats;
    if (!st) return;
    if (this._netPrev && now > this._netAt) {
      const s = (now - this._netAt) / 1000, p = this._netPrev;
      this.netRate = {
        inMsgs: (st.inMsgs - p.inMsgs) / s, inKB: (st.inBytes - p.inBytes) / 1024 / s,
        outMsgs: (st.outMsgs - p.outMsgs) / s, outKB: (st.outBytes - p.outBytes) / 1024 / s,
        parseMs: (st.parseMs - p.parseMs) / s, ping: this.net.ping,
      };
    }
    this._netPrev = { ...st };
    this._netAt = now;
  }

  _pollGpu() {
    const gl = this.gl, ext = this.timerExt;
    if (!ext) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    while (this.queries.length) {
      const q = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) {
        this.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        if (this.gpu.length > RING) this.gpu.shift();
      }
      gl.deleteQuery(q);
      this.queries.shift();
    }
  }

  _stats(arr) {
    const n = this.n;
    const s = this._sorted.subarray(0, n);
    s.set(n === RING ? arr : arr.subarray(0, n));
    s.sort();
    let sum = 0;
    for (let k = 0; k < n; k++) sum += s[k];
    return { avg: n ? sum / n : 0, p50: percentile(s, 0.5), p95: percentile(s, 0.95), p99: percentile(s, 0.99), max: n ? s[n - 1] : 0 };
  }

  /** Snapshot of everything (also used by the benchmark). */
  report() {
    const r = this.renderer.info;
    const f = this._stats(this.frame), l = this._stats(this.logic), s = this._stats(this.submit);
    let gpu = null;
    if (this.gpu.length) {
      const g = [...this.gpu].sort((a, b) => a - b);
      gpu = { avg: g.reduce((a, b) => a + b, 0) / g.length, p95: percentile(g, 0.95) };
    }
    const heap = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
    let spikes = 0, long33 = 0, steps = 0;
    for (let k = 0; k < this.n; k++) {
      if (this.frame[k] > 50) spikes++;
      if (this.frame[k] > 33.4) long33++;
      steps += this.substeps[k];
    }
    // 1% low: the average FPS over the slowest 1% of frames
    const sortedF = this._sorted.subarray(0, this.n);   // the scratch buffer _stats() also uses
    sortedF.set(this.n === RING ? this.frame : this.frame.subarray(0, this.n));
    sortedF.sort();
    const worstN = Math.max(1, Math.floor(this.n / 100));
    let worstSum = 0;
    for (let k = this.n - worstN; k < this.n; k++) worstSum += sortedF[k] || 0;
    const low1 = worstSum > 0 ? 1000 / (worstSum / worstN) : 0;
    const sections = {};
    for (const n of SECTIONS) {
      const a = this.sec[n];
      let sum = 0, max = 0;
      for (let k = 0; k < this.n; k++) { sum += a[k]; if (a[k] > max) max = a[k]; }
      sections[n] = { avg: this.n ? sum / this.n : 0, max };
    }
    const data = {
      fps: f.avg ? 1000 / f.avg : 0, low1, frame: f, logic: l, submit: s, gpu, spikesOver50ms: spikes, framesOver33ms: long33,
      substepsPerFrame: this.n ? steps / this.n : 0, sections, net: this.netRate, hitches: this.hitches.slice(),
      calls: this.calls ?? r.render.calls, triangles: this.triangles ?? r.render.triangles, geometries: r.memory.geometries, textures: r.memory.textures,
      programs: r.programs?.length ?? 0, heapMB: heap,
      ...this.counts, ...this.extra,
    };
    const fx = v => v.toFixed(1);
    const lines = [
      `FPS ${fx(data.fps)}   frame ms avg ${fx(f.avg)} p50 ${fx(f.p50)} p95 ${fx(f.p95)} p99 ${fx(f.p99)} max ${fx(f.max)}`,
      `1% low ${fx(low1)} FPS   >33ms ${long33}   >50ms ${spikes} (last ${this.n} frames)`,
      `logic (JS update) avg ${fx(l.avg)} p95 ${fx(l.p95)} ms`,
      `render submit (CPU) avg ${fx(s.avg)} p95 ${fx(s.p95)} ms`,
      `GPU time ${gpu ? `avg ${fx(gpu.avg)} p95 ${fx(gpu.p95)} ms (timer query)` : "n/a (no timer query here)"}`,
      `draw calls ${data.calls}   triangles ${(data.triangles / 1000).toFixed(0)}k   programs ${data.programs}`,
      `geometries ${data.geometries}   textures ${data.textures}   heap ${heap ? fx(heap) + " MB" : "n/a"}`,
      `physics sub-steps/frame ${data.substepsPerFrame.toFixed(2)}`,
      "── ms per frame: avg / max ──",
      ...SECTIONS.filter(n => sections[n].max > 0.05).map(n => `  ${n.padEnd(9)} ${fx(sections[n].avg).padStart(5)} / ${fx(sections[n].max)}`),
      ...(this.netRate ? [`net in ${this.netRate.inMsgs.toFixed(0)}/s ${this.netRate.inKB.toFixed(1)} KB/s  out ${this.netRate.outMsgs.toFixed(0)}/s ${this.netRate.outKB.toFixed(1)} KB/s  parse ${this.netRate.parseMs.toFixed(1)} ms/s  ping ${this.netRate.ping} ms`] : []),
      ...Object.entries({ ...this.counts, ...this.extra }).map(([k, v]) => `${k} ${typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : v}`),
    ];
    return { data, text: lines.join("\n") };
  }

  /** Clears the history (the benchmark does this after its warm-up). */
  reset() {
    this.hitches.length = 0;
    this.n = 0;
    this.i = 0;
    this.gpu.length = 0;
  }
}
