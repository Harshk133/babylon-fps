import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import "./intro.css";
import { DivineArtifact } from "./DivineArtifact.js";
import { Cosmos } from "./Cosmos.js";
import { WorldFlight } from "./WorldFlight.js";
import { TitleReveal } from "./TitleReveal.js";
import { IntroAudio } from "./IntroAudio.js";

// The opening cinematic: one continuous journey from a divine artifact, into
// the universe within it, out through a multiverse, a galaxy cluster and the
// solar system, down onto India and, through the clouds, onto the game's own
// map, ending on the title. The conductor: it owns the clock, the cues, every
// camera move, the fades and the UI; main.js calls frame() each frame and
// either lets it draw the cosmos (renderCosmos) or renders the game world as
// usual with this camera, then renderOverlay() for the title.
//
// It never touches gameplay state: main.js ignores game input while it runs,
// and nothing connects to a room until it's over (onDone). Skippable at any
// point (the button, Esc), replayable from Settings.

/** Plays when the game starts (unless the player turned it off in Settings, or followed an invite link). */
export const AUTO_PLAY_INTRO = true;

// The cue sheet (seconds): shots, transitions and the score's entries
export const CUES = {
  start: 0, artifact: 1.5, flute: 3.2, vision: 12, vision_through: 19.2,
  multiverse: 20.2, multiverse_through: 30, galaxy: 31, galaxy_through: 40.2,
  solar: 41.2, earth_dive: 50.5, india: 51.5, drone_end: 60, world: 58.6, title: 80, end: 94,
};

const ss = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);
const lerp = THREE.MathUtils.lerp;
const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
/** 0 → 1 → 0 over [a, b] peak [b, c] → d. */
const bell = (t, a, b, c, d) => (t < b ? ss(t, a, b) : 1 - ss(t, c, d));

// Sky palettes by shot: [deep, mid, highlight]
const PAL = {
  divine: [new THREE.Color(0.9, 0.6, 0.25), new THREE.Color(0.06, 0.1, 0.38), new THREE.Color(1.0, 0.55, 0.15)],
  vision: [new THREE.Color(0.25, 0.15, 0.6), new THREE.Color(0.18, 0.08, 0.5), new THREE.Color(0.9, 0.7, 0.35)],
  multi: [new THREE.Color(0.18, 0.1, 0.55), new THREE.Color(0.35, 0.12, 0.6), new THREE.Color(0.2, 0.75, 0.95)],
  cluster: [new THREE.Color(0.04, 0.04, 0.12), new THREE.Color(0.1, 0.08, 0.3), new THREE.Color(0.55, 0.5, 0.9)],
  solar: [new THREE.Color(0.02, 0.02, 0.05), new THREE.Color(0.04, 0.05, 0.12), new THREE.Color(0.5, 0.48, 0.6)],
};
const _a = new THREE.Color(), _b = new THREE.Color(), _c = new THREE.Color();
function palette(cosmos, from, to, k, bright) {
  _a.copy(PAL[from][0]).lerp(PAL[to][0], k);
  _b.copy(PAL[from][1]).lerp(PAL[to][1], k);
  _c.copy(PAL[from][2]).lerp(PAL[to][2], k);
  cosmos.setPalette(_a, _b, _c, bright);
}

export class CinematicIntro {
  /**
   * renderer, postFx (render/PostFX.js), sfx (Sfx), world: the game's scene,
   * camera, groundHeight, chunks, env; flightPath: WorldFlight path; title;
   * tagline; lite: reduced graphics.
   */
  constructor({ renderer, postFx, sfx, world, flightPath, title, tagline, lite = false }) {
    this.renderer = renderer;
    this.postFx = postFx;
    this.sfx = sfx;
    this.world = world;
    this.flightPath = flightPath;
    this.title = title;
    this.tagline = tagline;
    this.lite = lite;
    this.active = false;
    this.mode = null;          // "begin" | "cosmos" | "world" | "finish"
    this.t = 0;
    this.postFall = 0;         // main.js adds it to PostFX's zoom blur (speed)
    this.muted = false;
    this.speed = 1;            // playback rate (1; tools can freeze a frame with 0)
    this._camVel = new THREE.Vector3();
    this._prevCam = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._buildUi();
    this._onKey = e => this._key(e);
    this._onResize = () => { this.cosmos?.resize(); this.titleFx?.resize(); };
  }

  // ── UI ──────────────────────────────────────────────────────────────────────
  _buildUi() {
    const ui = this.ui = document.createElement("div");
    ui.id = "cinematic";
    ui.innerHTML = `
      <div class="cn-fade"></div>
      <div class="cn-bar cn-top"></div><div class="cn-bar cn-bottom"></div>
      <div class="cn-vignette"></div>
      <div class="cn-title-ui">
        <p class="cn-tagline"></p>
      </div>
      <div class="cn-controls">
        <button class="cn-sound" type="button">🔊 Click for sound</button>
        <button class="cn-mute" type="button" aria-label="Mute">🔊</button>
        <button class="cn-skip" type="button">Skip intro <kbd>Esc</kbd></button>
      </div>`;
    document.body.append(ui);
    this.fadeEl = ui.querySelector(".cn-fade");
    this.soundEl = ui.querySelector(".cn-sound");
    this.titleUi = ui.querySelector(".cn-title-ui");
    ui.querySelector(".cn-tagline").textContent = this.tagline;
    this.vignette = ui.querySelector(".cn-vignette");
    ui.querySelector(".cn-skip").addEventListener("click", e => { e.stopPropagation(); this.skip(); });
    const mute = ui.querySelector(".cn-mute");
    mute.addEventListener("click", e => {
      e.stopPropagation();
      this.muted = !this.muted;
      mute.textContent = this.muted ? "🔇" : "🔊";
      this.audio?.setMuted(this.muted);
    });
    // The browser holds sound back until the page is clicked: any click (or key) turns it on
    ui.addEventListener("pointerdown", e => {
      e.stopPropagation();
      if (e.target.closest(".cn-skip") || e.target.closest(".cn-mute")) return;
      this._enableSound();
    });
    for (const t of ["mousedown", "click", "wheel", "touchstart"]) ui.addEventListener(t, e => e.stopPropagation(), { passive: true });
  }

  _fade(alpha, color = "#000") {
    this.fadeEl.style.background = color;
    this.fadeEl.style.opacity = alpha.toFixed(3);
  }

  // ── Flow ────────────────────────────────────────────────────────────────────
  /** Plays straight away. onDone runs once it's over or skipped. */
  play(onDone) {
    if (this.active) return;
    this.onDone = onDone;
    this.active = true;
    this.t = 0;
    document.body.classList.add("cinematic-on");
    this.ui.classList.add("on");
    this.titleUi.classList.remove("on");
    this._fade(1);
    window.addEventListener("keydown", this._onKey, true);
    window.addEventListener("resize", this._onResize);
    // Build now (the planet textures load while the first shots play), and roll
    this._build();
    this._start();
  }

  _build() {
    if (this.cosmos) return;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    pmrem.dispose();
    this.cosmos = new Cosmos({ lite: this.lite });
    this.artifact = new DivineArtifact({ envMap: this.envRT.texture, lite: this.lite });
    this.cosmos.scene.add(this.artifact.group);
    this.titleFx = new TitleReveal({ title: this.title, envMap: this.envRT.texture, lite: this.lite });
    this.flight = new WorldFlight({ world: this.world, path: this.flightPath, lite: this.lite });
    // Compile the cosmos's programs now, not on the frame each set piece first appears
    for (const g of [this.cosmos.multiverse, this.cosmos.cluster, this.cosmos.solar]) g.visible = true;
    try { this.renderer.compile(this.cosmos.scene, this.cosmos.camera); } catch { /* compiled on first draw instead */ }
    for (const g of [this.cosmos.multiverse, this.cosmos.cluster, this.cosmos.solar]) g.visible = false;
    this._onResize();
  }

  _start() {
    this.mode = "cosmos";
    this.t = 0;
    this.audio = new IntroAudio(this.sfx);
    this.scored = false;
    // Sound starts now if the page already has the user's go-ahead (a click while it
    // loaded); otherwise on the first click or key, joining the score where it would be
    this.sfx.unlock();
    const ctx = this.sfx.ctx;
    if (ctx?.state === "running") this._score();
    else {
      ctx?.resume?.().then(() => { if (ctx.state === "running") this._score(); }).catch(() => {});
      this.soundEl.classList.add("on");
    }
  }

  _enableSound() {
    if (this.scored || !this.active || this.mode === "finish") return;
    this.sfx.unlock();
    const ctx = this.sfx.ctx;
    if (!ctx) return;
    (ctx.state === "running" ? Promise.resolve() : ctx.resume()).then(() => this._score()).catch(() => {});
  }

  _score() {
    if (this.scored || !this.active || !this.audio || this.mode === "finish") return;
    this.scored = true;
    this.soundEl.classList.remove("on");
    this.audio.play(CUES, this.t);
    this.audio.setMuted(this.muted);
  }

  _key(e) {
    if (!this.active) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.code === "Escape") { this.skip(); return; }
    this._enableSound();
  }

  skip() {
    if (!this.active || this.mode === "finish") return;
    this.finish(0.45);
  }

  /** Fade to black, put everything back, hand over to the game. */
  finish(fade = 0.9) {
    if (this.mode === "finish") return;
    this.mode = "finish";
    this.finishAt = performance.now() + fade * 1000;
    this.finishFade = fade;
    this.audio?.stop(fade + 0.4);
  }

  _end() {
    this.active = false;
    this.mode = null;
    window.removeEventListener("keydown", this._onKey, true);
    window.removeEventListener("resize", this._onResize);
    this.flight?.end();
    this.postFall = 0;
    this.ui.classList.remove("on");
    document.body.classList.remove("cinematic-on");
    this._fade(0);
    // Free everything the intro made; the game keeps running with its own camera
    this.artifact?.dispose();
    this.cosmos?.dispose();
    this.titleFx?.dispose();
    this.envRT?.dispose();
    this.artifact = this.cosmos = this.titleFx = this.flight = this.envRT = null;
    this.audio = null;
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }

  // ── Every frame ─────────────────────────────────────────────────────────────
  /** Advances the intro. Returns "cosmos" (call renderCosmos), "world" (render the game, then renderOverlay) or null. */
  frame(dt) {
    if (!this.active) return null;
    if (this.mode === "finish") {
      const left = (this.finishAt - performance.now()) / 1000;
      this._fade(1 - Math.max(0, left) / this.finishFade);
      if (left <= 0) { this._end(); return null; }
      return this.t < CUES.world ? (this.t > 0 ? "cosmos" : null) : "world";
    }
    this.t += dt * this.speed;
    const t = this.t;
    if (t < CUES.world) {
      this.mode = "cosmos";
      this._cosmosShot(t, dt);
      return "cosmos";
    }
    if (this.mode !== "world") {
      this.mode = "world";
      this.flight.begin();
    }
    this._worldShot(t, dt);
    if (t > CUES.title + 7.5) this.finish(1.4);
    return "world";
  }

  renderCosmos() {
    const r = this.renderer;
    this.postFx.begin();
    r.clear();
    r.render(this.cosmos.scene, this.cosmos.camera);
    this.postFx.end();
  }

  renderOverlay() {
    if (this.titleFx && this.t >= CUES.title - 2) this.titleFx.render(this.renderer);
  }

  // ── Shots ───────────────────────────────────────────────────────────────────
  _cosmosShot(t, dt) {
    const C = this.cosmos, cam = C.camera, A = this.artifact;
    const showMulti = t > CUES.multiverse - 0.5 && t < CUES.galaxy + 0.3;
    const showCluster = t > CUES.galaxy - 0.5 && t < CUES.solar + 0.3;
    const showSolar = t > CUES.solar - 0.5;
    C.multiverse.visible = showMulti;
    C.cluster.visible = showCluster;
    C.solar.visible = showSolar;
    A.group.visible = t < CUES.multiverse + 0.3;
    let fov = 38, flash = 0, flashCol = "#fff2d0", fadeBlack = 0, streak = 0;
    this._prevCam.copy(cam.position);

    if (t < CUES.multiverse) {
      // 01-02: the artifact forms; the image appears; the universe opens within it; through it
      const form = ss(t, CUES.artifact, 7.5), reveal = ss(t, 5, 10.5), vision = ss(t, CUES.vision, 18.2), glow = ss(t, 18.4, 19.6);
      A.update(t, { form, reveal, vision, glow });
      let z;
      if (t < CUES.vision) z = lerp(19, 9.2, easeInOut(Math.min(1, t / CUES.vision)));
      else z = lerp(9.2, 0.35, Math.pow(ss(t, CUES.vision, 19.7), 2.2));
      const drift = 1 - ss(t, CUES.vision, 17);
      cam.position.set(Math.sin(t * 0.12) * 0.6 * drift, 0.25 * drift + Math.sin(t * 0.09) * 0.2 * drift, z);
      cam.up.set(0, 1, 0);
      cam.lookAt(0, 0, 0);
      fov = lerp(36, 64, ss(t, 15, 19.7));
      const k = ss(t, 11, 18);
      palette(C, "divine", "vision", k, ss(t, 2.5, 8) * (0.22 + 0.45 * k));
      C.starUniforms.uAlpha.value = ss(t, 6, 13);
      fadeBlack = 1 - ss(t, 0, 2.2);
      flash = bell(t, 18.9, 19.7, 19.8, 20.6);
    } else if (t < CUES.galaxy) {
      // 03: the multiverse: faster and faster between universes, into the last one
      const k = (t - CUES.multiverse) / (CUES.galaxy - CUES.multiverse);
      const u = Math.min(1, Math.pow(k, 1.75) * 1.02);
      const path = C.multiversePath;
      path.getPointAt(Math.min(1, u), cam.position);
      const ahead = path.getPointAt(Math.min(1, u + 0.04), this._v);
      const into = ss(k, 0.82, 1);
      this._w.copy(ahead).lerp(C.finalBubble.position, into);
      cam.position.lerp(C.finalBubble.position, Math.pow(into, 2) * 0.92);
      cam.up.set(0, 1, 0);
      cam.lookAt(this._w);
      cam.rotateZ(Math.sin(k * Math.PI * 2) * 0.08);
      for (const b of C.bubbles) b.material.uniforms.uAlpha.value = ss(t, CUES.multiverse, CUES.multiverse + 1.6);
      fov = lerp(52, 78, k);
      palette(C, "vision", "multi", ss(k, 0, 0.3), 0.7);
      C.starUniforms.uAlpha.value = 1;
      streak = ss(k, 0.15, 0.6);
      flash = bell(t, 29.7, 30.4, 30.5, 31.3);
    } else if (t < CUES.solar) {
      // 04: the galaxy cluster: across the cosmic web, then down into one spiral galaxy
      const k = (t - CUES.galaxy) / (CUES.solar - CUES.galaxy);
      const e = easeInOut(k);
      const P = [[0, 420, 1900], [260, 220, 900], [140, 90, 380], [70, 20, 120], [36, 4, 24]];
      const f = e * (P.length - 1), i = Math.min(P.length - 2, Math.floor(f)), r = f - i;
      cam.position.set(lerp(P[i][0], P[i + 1][0], r), lerp(P[i][1], P[i + 1][1], r), lerp(P[i][2], P[i + 1][2], r));
      cam.up.set(0, 1, 0);
      cam.lookAt(this._v.set(0, 0, 0).lerp(this._w.set(30, 0, 10), ss(k, 0.7, 1)));
      C.galaxyUniforms.uAlpha.value = ss(t, CUES.galaxy, CUES.galaxy + 1.5) * (1 - ss(k, 0.75, 0.95));
      fov = lerp(55, 42, e);
      palette(C, "multi", "cluster", ss(k, 0, 0.25), 0.55);
      streak = (1 - ss(k, 0, 0.25)) * 0.8;
      flash = bell(t, 39.8, 40.5, 40.6, 41.6);
      flashCol = "#fff7e6";
    } else if (t < CUES.india) {
      // 05: in from the outer solar system: past Saturn, Jupiter and Mars, to Earth
      const k = (t - CUES.solar) / (CUES.india - CUES.solar);
      const end = this._v.copy(C.india).multiplyScalar(C.R * 3.2).add(C.E);
      if (!this._solarPath) {
        this._solarPath = new THREE.CatmullRomCurve3([
          new THREE.Vector3(-6, 6, 70), new THREE.Vector3(28, 8, -130), new THREE.Vector3(-70, 24, -660),
          new THREE.Vector3(26, -2, -1560), new THREE.Vector3(0, 8, -2240), end.clone(),
        ], false, "centripetal");
      }
      const u = easeInOut(k);
      this._solarPath.getPointAt(u, cam.position);
      const ahead = this._solarPath.getPointAt(Math.min(1, u + 0.05), this._w);
      ahead.lerp(C.E, ss(k, 0.55, 0.95));
      cam.up.set(0, 1, 0);
      cam.lookAt(ahead);
      fov = lerp(50, 40, k);
      palette(C, "cluster", "solar", ss(k, 0, 0.2), 0.45);
      C.starUniforms.uAlpha.value = 1;
      fadeBlack = 0;
    } else {
      // 06: Earth to India: a satellite's descent onto the Deccan, then into the clouds
      const k = (t - CUES.india) / (CUES.world - CUES.india);
      const e = easeInOut(Math.min(1, k));
      const alt = lerp(3.2, 1.014, e);
      cam.position.copy(C.india).multiplyScalar(C.R * alt).add(C.E);
      // Looking down at India, tilting toward the horizon (northward) as it gets low
      const target = this._v.copy(C.india).multiplyScalar(C.R).add(C.E);
      target.y += C.R * 0.06 * ss(k, 0.5, 1);
      cam.up.set(0, 1, 0);
      cam.lookAt(target);
      fov = lerp(40, 58, ss(k, 0.4, 1));
      palette(C, "solar", "solar", 0, 0.45);
      C.starUniforms.uAlpha.value = 1 - ss(k, 0.4, 0.8);
      flash = ss(t, CUES.world - 2.2, CUES.world - 0.3);
      flashCol = "#ffffff";
    }
    cam.fov = fov;
    cam.updateProjectionMatrix();
    // Speed: drives the warp streaks and PostFX's zoom blur
    if (dt > 0) this._camVel.subVectors(cam.position, this._prevCam).divideScalar(dt);
    if (this._camVel.lengthSq() > 4e6) this._camVel.setScalar(0); // (a cut, not a move)
    C.streakUniforms.uLen.value = 0.05 * streak;
    C.streaks.visible = streak > 0.01;
    this.postFall = Math.min(0.8, streak * 0.9 + (t > CUES.india ? ss(t, CUES.world - 3, CUES.world) * 0.4 : 0));
    C.update(t, this._camVel);
    // Letterbox for the cosmic shots
    this.ui.classList.toggle("bars", t > 0.5);
    if (flash > 0) this._fade(flash, flashCol);
    else this._fade(fadeBlack, "#000");
  }

  _worldShot(t, dt) {
    const k = (t - CUES.world) / (CUES.title - CUES.world);
    if (k < 1) {
      const speed = this.flight.update(Math.max(0, k), dt);
      this.postFall = Math.min(0.16, speed / 600);
    } else {
      this.flight.hold(t - CUES.title, dt);
      this.postFall = 0;
    }
    // Out of the white of the clouds
    this._fade(1 - ss(t, CUES.world, CUES.world + 1.8), "#ffffff");
    // The title: a darker frame, the metal letters, the tagline, then the prompt
    const tt = t - CUES.title;
    this.titleFx.update(tt);
    this.vignette.style.opacity = (ss(tt, -1.5, 1.5) * 0.85).toFixed(3);
    this.titleUi.classList.toggle("on", tt > 1.2);
    this.ui.classList.toggle("bars", tt < 0);
  }
}
