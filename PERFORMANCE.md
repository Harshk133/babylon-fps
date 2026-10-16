# Performance: profiler, benchmark, profiles

## Profiler overlay

Add `?perf=1` to the page address. A panel on the left shows, over the last
~10 s of frames:

| Line | Meaning |
|---|---|
| FPS, frame ms avg / p50 / p95 / p99 / max | time between frames, what the player feels |
| spikes >50ms | frames that took longer than 50 ms (visible hitches) |
| logic (JS update) | JavaScript for the game update: physics, AI, animation, HUD |
| render submit (CPU) | JavaScript inside `renderer.render`: building and issuing draw calls. **CPU time, not GPU time** |
| GPU time | real GPU time from `EXT_disjoint_timer_query_webgl2`, only where the browser exposes it; otherwise "n/a" |
| draw calls, triangles, programs, geometries, textures | `renderer.info` |
| heap | `performance.memory` (Chromium only) |
| monsters, monstersAnimated, enemyBolts, fires, pickups, bodies | live object counts |
| quality, fpsCap | preset and current render scale; frame cap setting → cap in force |

Without the flag none of this exists (two flag checks per frame).

## Benchmark

Add `?bench=1` (it also turns the overlay on). It runs a fixed 33 s scenario,
the same on every device: noon, no level director, the player can't die.

1. 3 s warm-up (not measured)
2. 10 s **explore**: standing at spawn, slowly looking around
3. 20 s **combat**: 20 monsters spawned in a ring chase the player, the gun fires in bursts

The result is printed to the console as `BENCH_RESULT {…}`, kept in
`window.__benchResult`, and the overlay says DONE.

### On an Android phone

- **Browser:** open `https://babylon-fps.vercel.app/?bench=1&touch=1` in Chrome, landscape, and wait for DONE.
- **The APK:** connect the phone with USB debugging on, open `chrome://inspect` on the PC,
  inspect the app's WebView, and in its console run `location.search = "?bench=1"`.
  Read `window.__benchResult` there when the overlay says DONE.
- Run it 3 times per build (results vary by a few FPS between runs), with the phone at room
  temperature, on charge or above 50% battery, the same graphics preset each time.
- Compare builds with the same phone, preset and app version of Chrome / WebView.
- For long sessions (memory growth, thermal throttling), use `?perf=1` and play
  15–20 minutes; watch heap and FPS over time. Android Studio's profiler (CPU,
  memory, energy) attaches to the debug APK as well.

## Graphics profiles (phones)

The lobby's Graphics picker. "Auto" chooses from the GPU (`detectPhoneQuality`).

| Profile | Render scale | MSAA | Shadows | Grass / rain / mist | Point lights |
|---|---|---|---|---|---|
| Battery saver (`low`) | 0.85–1.25× | off | off | 1600 / 1500 / 18 | 3 |
| Balanced (`medium`) | 1.0–1.4× | on | every frame | 3800 / 2800 / 30 | 4 |
| High (`high`) | 1.1–1.75× | on | every frame | 7000 / 4500 / 45 | 5 |

Touch settings (⚙) → Frame rate: **Auto** (60; settles on a steady 30 when 60
can't be held at the lowest render scale, retries 60 later with back-off),
60, or 30 (battery saver).

## A/B switches

- `?lod=0`: full-detail trees everywhere (compare against the default LOD).

## Measured (headless Chrome, phone viewport 844×390 @ dpr 2.5, CPU throttled 4×, software GPU)

This is emulation, not a phone: the "GPU" is SwiftShader running on the CPU,
so GPU timings only show relative changes. Numbers from `?bench=1`.

Balanced (`medium`), before → after this optimisation pass:

| | explore before | explore after | combat before | combat after |
|---|---|---|---|---|
| draw calls | 203 | 107–131 | 277 | 107–132 |
| triangles | 892k | 709–738k | 750k | 442–466k |
| render submit (CPU) avg | 6.2 ms | 4.0–5.2 ms | 9.5 ms | 6.2–7.2 ms |
| logic avg | 5.0 ms | 4.3–5.1 ms | 8.0 ms | 6.2–7.2 ms |
| FPS | 48.5 | 46.3–48.6 | 41.8 | 44.8–45.5 |
| p95 frame | 32.0 ms | 31.8–32.4 ms | 42.7 ms | 34.8–36.3 ms |

High: worst frame 194 ms → 50 ms (explore) and 267 ms → 57 ms (combat) after
the shadow-shader warm-up fix; explore FPS 31.8 → 46.7.

Not yet measured on a real Android device.
