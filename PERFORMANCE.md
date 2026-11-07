# Performance: profiler, benchmark, profiles

## Profiler overlay

Add `?perf=1` to the page address. A panel on the left shows, over the last
~10 s of frames:

| Line | Meaning |
|---|---|
| FPS, frame ms avg / p50 / p95 / p99 / max | time between frames, what the player feels |
| 1% low, >33ms, >50ms | average FPS over the slowest 1 % of frames; frames over 33 / 50 ms (visible hitches) |
| logic (JS update) | JavaScript for the game update: physics, AI, animation, HUD |
| render submit (CPU) | JavaScript inside `renderer.render`: building and issuing draw calls. **CPU time, not GPU time** |
| GPU time | real GPU time from `EXT_disjoint_timer_query_webgl2`, only where the browser exposes it; otherwise "n/a" |
| draw calls, triangles, programs, geometries, textures | `renderer.info` |
| heap | `performance.memory` (Chromium only) |
| monsters, monstersAnimated, enemyBolts, fires, pickups, bodies | live object counts |
| physics sub-steps/frame | 60 Hz physics steps per frame (above 1: frames are slower than 60 FPS) |
| ms per frame: avg / max | where the frame's JavaScript goes, by section (`input`, `move`, `physics`, `postStep`, `world`, `ai`, `remote`, `net`, `camera`, `soldier`, `weapons`, `fx`, `pickups`, `hud`, `minimap`, `mood`, `submit`): `perfOverlay.mark(name)` in `animate()` books the time since the previous mark |
| net in / out | messages and KB per second, JSON parse time per second, ping (only in a room) |
| quality, pacing | preset and render scale; measured refresh rate, frame cap in force, PerfManager tiers and why |

Frames over 100 ms are logged with the section that took longest, the JS time
and whether new shader programs / textures / geometries appeared that frame
(`hitches` in the benchmark result): a hitch with no JS and no new programs
is the browser or another process, not the game.

Without the flag none of this exists (a few optional-chained calls per frame).

## Benchmark

Add `?bench=1` (it also turns the overlay on). It runs a fixed 33 s scenario,
the same on every device: noon, no level director, the player can't die.

1. 3 s warm-up (not measured)
2. 10 s **explore**: standing at spawn, slowly looking around
3. 20 s **combat**: 20 monsters spawned in a ring chase the player, the gun fires in bursts

`?bench=full` adds four more (about 85 s in all):

4. 15 s **crowd**: 24 soldiers running and shooting round you, fed through `remotePlayers.applyState` like teammates and bots (the battle royale's heaviest path)
5. 12 s **fx**: a grenade, molotov or smoke every 0.6 s round you, gun firing
6. 12 s **town**: the middle of Shivpur, looking round
7. 12 s **drive**: a Thar flat out, weaving

`?bench=soak` loops 2–7 for 15 minutes and logs heap, geometries, textures and
programs every minute (`soak` in the result): the leak check.

### From the command line (dev tools in `scripts/`, need `npm i` for puppeteer-core)

| Script | What it does |
|---|---|
| `npm run bench -- [--preset low] [--scenario full] [--runs 3] [--phone] [--dist dist-base] [--label x]` | builds if needed, serves `dist` (or another build, for A/B), runs the benchmark in the installed Chrome / Edge, writes `bench-results/*.json` and prints a table (median of runs) incl. the per-section breakdown |
| `node scripts/cpu-profile.mjs --phase combat\|crowd\|drive… [--dev]` | a 7 s CPU profile of one benchmark phase, summed by file and by function (`--dev`: the dev server, for readable names) |
| `node scripts/gpu-probe.mjs` | GPU time with each big scene group, the shadow pass, the backdrop and post settings toggled off in turn (needs the GPU timer query) |
| `node scripts/smooth-probe.mjs [--jitter 12]` | how evenly the drawn character and camera move on a straight walk under uneven frame times, render interpolation on vs off |
| `node scripts/regress.mjs [--shots]` | functional checks of the performance work (static bodies, rays, crates, walls, vehicles, interpolation, overlays, page errors) |

This machine's timings drift (other apps, thermal state), so compare builds by
alternating them (`--dist dist-base` against `dist`) in the same session, and
trust per-section numbers and draw-call counts over raw FPS.

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

## Graphics profiles

The lobby's Graphics picker (`src/quality.js`). "Auto" chooses from the device
(`detectQuality`: software renderers, ≤ 4 GB or ≤ 4 cores → Low; integrated →
Medium; else High; phones by GPU family, `detectPhoneQuality`). Auto never
picks Performance or Ultra. Auto on an integrated desktop GPU also drops the
post-processing pass (`IS_IGPU`; see the findings below).

| Profile | Desktop render scale | Shadows | Grass / rain / mist | Post |
|---|---|---|---|---|
| Performance | 0.5–0.7× | off | 900 / 1200 / 12 | off |
| Low | 0.5–0.85× | off | 2200 / 2500 / 35 | off |
| Medium | 0.6–1× | every 2nd frame | 6000 / 5500 / 60 | grade (off on auto + iGPU) |
| High | 0.65–1.5× | every frame | 12000 / 9000 / 90 | grade + bloom |
| Ultra | 0.75–2× | every frame, 2048² | 18000 / 12000 / 120 | grade + bloom |

Phones (`TOUCH_TUNING`): Battery saver (`low`) 0.85–1.25×, Balanced (`medium`)
1.0–1.4× with MSAA, High 1.1–1.75×; Performance and Ultra get their own tuning
too.

### Frame pacing and live tiers (`src/render/PerfManager.js`)

- **Refresh rate** is estimated from rAF gaps (a low percentile; below 55 Hz it
  assumes 60, since slow frames never show one vsync gap).
- **Frame cap**: always a whole divisor of the refresh rate, so frames are
  evenly spaced (60 on a 144 Hz screen would alternate 14 / 21 ms). Settings →
  Frame rate (desktop: Auto / Unlimited / 60 / 30; phones: Auto / 60 / 30).
  Auto starts at the screen's rate (phones: at most 60) and steps down one
  divisor when it can't be held (CPU-bound, or the render scale is already at
  its floor), then tries the level above again later, waiting longer after each
  failure. Desktops never go under ~60 by themselves.
- **Dynamic resolution**: as before (render scale on GPU-bound frames only).
- **Tiers**, judged once a second on the p90 frame time: down one after 3 s over
  budget × 1.15, back one after 10 s under budget × 0.8 (the wait doubles when a
  given-back tier is needed again within 15 s). Only knobs that change no shader
  program and no gameplay (`applyPerfTiers()` in main.js):

| Tier | GPU-bound (scale already at its floor) | CPU-bound |
|---|---|---|
| 1 | shadows redrawn every 2nd frame | soldier / monster animation LOD distances × 0.7 |
| 2 | grass and mist × 0.6, draw range 245 → 205 m (inside the fog) | shadows every 2nd frame, minimap 15 Hz |
| 3 | shadows every 4th frame, grass × 0.4 | animation LOD × 0.5 (light mesh and lite procedural pass sooner) |

Never touched: anything with a collider, enemy and player visibility, tracers,
muzzle flashes, projectiles, smoke cover, pickups. Grass only thins.

## A/B switches

- `?lod=0`: full-detail trees everywhere (compare against the default LOD).
- `window.__noInterp = true` (console): draw the player and monsters at their raw physics positions (no render interpolation).

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

## Desktop pass (Intel iGPU, D3D11, headless Chrome 1600×900, medium)

Measured with a headless harness (puppeteer-core, `?bench=1` / `?perf=1`); this
machine was busy, so FPS varied ±50% between identical runs and only the
deterministic numbers are reliable:

| | before | after |
|---|---|---|
| download | 12.4 MB | 10.8 MB (truck textures 256, panchayat / town building 512) |
| physics broadphase per step | 5.6 ms (SAP) | 0.35–0.45 ms (static grid, identical pairs) |
| empty instanced draw calls | ~30–90 per frame | ~1 |
| render scale on a CPU-bound frame | dropped to the 0.6 floor | stays at 1 |
| scene shader phase of the warm-up | 1.2–1.4 s | 0.8–1.1 s (`checkShaderErrors` off) |
| load to ready (warm) | 5–8 s | 5.1–5.7 s |

## Smoothness pass (2026-11): i5-6500 + Intel HD 530, 60 Hz, headless Chrome 1600×900

Found with the per-section profiler, CPU profiles (`scripts/cpu-profile.mjs`) and
GPU A/B toggles (`scripts/gpu-probe.mjs`); compared by alternating the old and
new builds in the same session. The machine was shared with other GPU work part
of the time, so raw FPS swings; per-section times, draw calls and the
alternating pairs are the reliable part.

| Finding (evidence) | Fix | Result |
|---|---|---|
| cannon walked all ~1500 static bodies several times per step (solver's own loop 4 % of the main thread at an empty spawn) | statics live only in the broadphase grid | physics 5.5 → 1.4 ms/frame (explore), 11.2 → 4.9 (combat), medium |
| world-map relief prebuild ran in frames, 8 rows per slice, far over its budget | one row per slice, `requestIdleCallback` only | 4.8–12 ms/frame for the first minute → ~0 |
| physics drawn at 60 Hz steps: uneven motion at any other frame rate | render interpolation (player, monsters) | walking speed spread 0.32–0.49 → 0.13–0.16 (`smooth-probe`) |
| parked vehicles: one draw per plain-coloured material + Collada lines (Thar 27 draws) | flatten colours, merge lines / lamps / tyres | draw calls at spawn ~330 → ~257 |
| `solidAt` scanned every map obstacle per probe | obstacle grid | ~8 % of the main thread while driving → negligible |
| 24 soldiers: forced whole-skeleton matrix updates, 3 aim passes + IK at any distance, full rate off screen | root-only update, `lite` far soldiers, off-screen every 4th frame | crowd 26.8 → 45.5 FPS, worst frame 474 → 42 ms |
| grade pass costs ~6.5 ms GPU on this iGPU (post quad + targets, not the shader math) | auto on an integrated desktop GPU: post off | (auto picks Low on this 4-core PC, so not exercised here) |
| hidden overlays still composited / animating, 4×-screen grain layer | `visibility: hidden` + paused animations, grain off with `lite-hud` | hiding the HUD DOM was worth up to ~6 ms of frame time |

Final alternating runs, **auto (= Low here)**, two pairs:

| | before | after |
|---|---|---|
| explore FPS / 1 % low | 56.3–56.7 / 24.8–25.3 | 58.1–58.5 / 30.2–30.8 |
| combat FPS / 1 % low | 44.2–44.5 / 14.0–16.5 | 51.9–56.2 / 21.9–27.9 |
| combat p99 / worst frame | 44.9–53.7 / 80.6–87.1 ms | 34.5–38.4 / 37.4–60 ms |
| logic (JS) explore / combat | 5.7 / 7.9–8.7 ms | 2.9–3.2 / 4.3–5.3 ms |
| physics combat | 4.7–5.4 ms | 1.4–2.3 ms |
| draw calls | ~245 | ~220 |

Full scenario on the new build (auto, quiet machine): explore 58.8, combat 54.9,
crowd 45.5, fx 55.1, town 56.3, drive 54.6 FPS. **Medium** (grade pass on) could
not be judged here: GPU time of the unchanged baseline moved between 21 and 60 ms
between runs (outside GPU load); the two alternating pairs disagreed.

**Soak** (`?bench=soak`, 15 min, auto): heap 225–298 MB, a sawtooth with no
upward trend; geometries 676 / textures 357 / programs 94 flat from minute 3 on.
No leak found.

Not measured: a real Android phone and a real multiplayer session (network
jitter; remote-player snapshot interpolation was therefore left unchanged).
