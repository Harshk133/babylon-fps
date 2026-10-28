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
  }

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
    this.i = (this.i + 1) % RING;
    this.n = Math.min(RING, this.n + 1);
    this.counts = counts;
    // The frame's totals (read later, after the next frame's reset, they'd be 0)
    this.calls = this.renderer.info.render.calls;
    this.triangles = this.renderer.info.render.triangles;
    if (now >= this._next) {
      this._next = now + 1000 / PANEL_HZ;
      this.el.textContent = this.report().text;
    }
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
    const spikes = (() => { let c = 0; for (let k = 0; k < this.n; k++) if (this.frame[k] > 50) c++; return c; })();
    const data = {
      fps: f.avg ? 1000 / f.avg : 0, frame: f, logic: l, submit: s, gpu, spikesOver50ms: spikes,
      calls: this.calls ?? r.render.calls, triangles: this.triangles ?? r.render.triangles, geometries: r.memory.geometries, textures: r.memory.textures,
      programs: r.programs?.length ?? 0, heapMB: heap,
      ...this.counts, ...this.extra,
    };
    const fx = v => v.toFixed(1);
    const lines = [
      `FPS ${fx(data.fps)}   frame ms avg ${fx(f.avg)} p50 ${fx(f.p50)} p95 ${fx(f.p95)} p99 ${fx(f.p99)} max ${fx(f.max)}`,
      `spikes >50ms ${spikes} (last ${this.n} frames)`,
      `logic (JS update) avg ${fx(l.avg)} p95 ${fx(l.p95)} ms`,
      `render submit (CPU) avg ${fx(s.avg)} p95 ${fx(s.p95)} ms`,
      `GPU time ${gpu ? `avg ${fx(gpu.avg)} p95 ${fx(gpu.p95)} ms (timer query)` : "n/a (no timer query here)"}`,
      `draw calls ${data.calls}   triangles ${(data.triangles / 1000).toFixed(0)}k   programs ${data.programs}`,
      `geometries ${data.geometries}   textures ${data.textures}   heap ${heap ? fx(heap) + " MB" : "n/a"}`,
      ...Object.entries({ ...this.counts, ...this.extra }).map(([k, v]) => `${k} ${typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : v}`),
    ];
    return { data, text: lines.join("\n") };
  }

  /** Clears the history (the benchmark does this after its warm-up). */
  reset() {
    this.n = 0;
    this.i = 0;
    this.gpu.length = 0;
  }
}
