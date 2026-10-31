import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

// Post-processing, after three.js' webgl_postprocessing_advanced (bloom, film,
// bleach bypass, colorify, vignette, colour correction), folded into as few
// full-screen passes as possible: the scene renders into one HDR target,
// bloom (High only) adds onto it, and one grade pass does tone mapping, sRGB,
// chromatic aberration, colour grade, bleach bypass, vignette, flashes and
// film noise in a single read.
//
// The grade isn't a fixed look: it follows the game. Night bleaches and cools
// it, a blood moon reddens it, low health drains the colour and pulses red at
// the edges, the weapon wheel's slow motion goes cold with film lines, a kill
// streak frenzy goes hot and saturated, kills and cleared levels flash, death
// fades to grey. main.js feeds a state object to update() every frame.
//
// Battle royale moments ride the same pass (each one a uniform-gated branch,
// free while it's off): a radial speed blur with wind streaks in the skydive;
// a storm warp and crackling blue edges outside the zone; screen-space
// shockwave rings (nearby grenades, your eliminations, the zone starting to
// close, landing); a "signal lost" glitch when you're eliminated or switch
// who you watch; a drone-camera feed while spectating (barrel lens, phosphor
// tint, tracking band, corner brackets, blinking REC dot); letterbox bars and
// a teal / orange split tone for the final three; golden god rays on a win.

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uScale: { value: new THREE.Vector2(1, 1) },  // the part of the target the scene filled (dynamic resolution)
    toneMappingExposure: { value: 1 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uBleach: { value: 0 },
    uChroma: { value: 0 },
    uVig: { value: 0 },
    uVigColor: { value: new THREE.Color(0, 0, 0) },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uGrain: { value: 0 },
    uScan: { value: 0 },
    // Battle royale
    uRadial: { value: 0 },  // skydive zoom blur
    uLines: { value: 0 },   // skydive wind streaks
    uStorm: { value: 0 },   // outside the zone
    uGlitch: { value: 0 },  // signal lost / switching feeds
    uFeed: { value: 0 },    // spectator drone camera
    uBars: { value: 0 },    // final-circle letterbox
    uShow: { value: 0 },    // final-circle split tone
    uRays: { value: 0 },    // victory god rays
    // Shockwaves: x, y (screen uv), radius (screen heights), strength
    uWaves: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uWaveTint: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()] },
  },
  vertexShader: /* glsl */ `
    precision highp float;
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    attribute vec3 position;
    attribute vec2 uv;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uScale;
    uniform vec2 uRes;
    uniform float uTime;
    uniform float uSat;
    uniform float uContrast;
    uniform vec3 uTint;
    uniform float uBleach;
    uniform float uChroma;
    uniform float uVig;
    uniform vec3 uVigColor;
    uniform float uFlash;
    uniform vec3 uFlashColor;
    uniform float uGrain;
    uniform float uScan;
    uniform float uRadial;
    uniform float uLines;
    uniform float uStorm;
    uniform float uGlitch;
    uniform float uFeed;
    uniform float uBars;
    uniform float uShow;
    uniform float uRays;
    uniform vec4 uWaves[4];
    uniform vec3 uWaveTint[4];
    #include <tonemapping_pars_fragment>
    #include <colorspace_pars_fragment>
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    // The scene only filled the bottom-left uScale of the target; never read past it
    vec3 samp(vec2 uv) { return texture2D(tDiffuse, clamp(uv, 0.001, 0.999) * uScale).rgb; }

    void main() {
      float aspect = uRes.x / uRes.y;
      vec2 uv = vUv;
      vec2 c = vUv - 0.5;
      float edge = length(c * vec2(aspect, 1.0)) / length(vec2(aspect, 1.0) * 0.5);
      float lensMask = 1.0;

      // Drone camera: barrel lens (the corners fall off the glass)
      if (uFeed > 0.001) {
        float r2 = dot(c, c);
        uv = 0.5 + c * (1.0 + uFeed * (0.22 * r2 + 0.2 * r2 * r2)) / (1.0 + uFeed * 0.08);
        vec2 o = abs(uv - 0.5);
        lensMask = 1.0 - smoothstep(0.49, 0.5, max(o.x, o.y));
        // Tracking band rolling down the picture
        float band = 1.0 - smoothstep(0.0, 0.04, abs(uv.y - fract(1.0 - uTime * 0.09)));
        uv.x += band * (hash(vec2(floor(uv.y * uRes.y * 0.5), uTime)) - 0.5) * 0.025 * uFeed;
      }

      // Signal glitch: torn horizontal slices
      if (uGlitch > 0.001) {
        float h = hash(vec2(floor(uv.y * 22.0), floor(uTime * 24.0)));
        uv.x += (h - 0.5) * 0.16 * uGlitch * step(1.0 - 0.55 * uGlitch, h);
        uv.y += (hash(vec2(floor(uTime * 15.0), 3.1)) - 0.5) * 0.03 * uGlitch * step(0.7, h);
      }

      // Outside the zone: the air itself wobbles, harder toward the edges
      if (uStorm > 0.001) {
        uv += uStorm * (0.002 + 0.006 * edge) * vec2(
          sin(uv.y * 38.0 + uTime * 7.0) + 0.5 * sin(uv.y * 91.0 - uTime * 13.0),
          cos(uv.x * 31.0 - uTime * 5.0));
      }

      // Shockwaves: a refracting ring pushes the picture outward as it passes
      float ringGlow = 0.0;
      vec3 ringCol = vec3(0.0);
      for (int i = 0; i < 4; i++) {
        vec4 w = uWaves[i];
        if (w.w < 0.001) continue;
        vec2 dv = (vUv - w.xy) * vec2(aspect, 1.0);
        float dist = length(dv);
        float ring = dist - w.z;
        float t = exp(-ring * ring * 700.0);
        uv -= dv / max(dist, 1e-4) * ring * t * w.w * 0.9 / vec2(aspect, 1.0);
        ringGlow += t * w.w;
        ringCol += uWaveTint[i] * t * w.w;
      }

      // Chromatic aberration (stronger on shockwave rings), split sideways in a glitch
      float ch = uChroma + ringGlow * 6.0;
      vec2 off = (uv - 0.5) * ch / uRes.y * 2.0 + vec2(uGlitch * 0.012 + uFeed * 0.0015, 0.0);
      vec3 col;
      if (uRadial > 0.001) {
        // Skydive: eight taps toward the centre, a zoom blur that grows with speed
        vec2 dir = (uv - 0.5) * uRadial * 0.075;
        col = vec3(0.0);
        for (int i = 0; i < 8; i++) col += samp(uv - dir * (float(i) / 7.0));
        col *= 0.125;
      } else if (ch > 0.01 || uGlitch > 0.001 || uFeed > 0.001) {
        col = vec3(samp(uv + off).r, samp(uv).g, samp(uv - off).b);
      } else {
        col = samp(uv);
      }

      col = ACESFilmicToneMapping(col);
      col = sRGBTransferOETF(vec4(col, 1.0)).rgb;

      // Colour grade (display space)
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSat);
      col = (col - 0.5) * uContrast + 0.5;
      // Bleach bypass: the silver-retention look, overlay of the image on its own luminance
      vec3 lum = vec3(l);
      vec3 b1 = 2.0 * col * lum;
      vec3 b2 = 1.0 - 2.0 * (1.0 - col) * (1.0 - lum);
      vec3 bleach = mix(b1, b2, clamp(10.0 * (l - 0.45), 0.0, 1.0));
      col = mix(col, bleach, uBleach);
      col *= uTint;

      // Final circle: teal shadows, warm highlights
      if (uShow > 0.001) {
        vec3 split = mix(vec3(0.8, 1.0, 1.1), vec3(1.14, 1.0, 0.84), smoothstep(0.15, 0.75, l));
        col = mix(col, col * split, uShow);
      }

      // Vignette toward a colour (black, or blood red when hurt)
      col = mix(col, uVigColor, smoothstep(0.45, 1.05, edge) * uVig);

      // Outside the zone: crackling blue static at the edges
      if (uStorm > 0.001) {
        float sn = hash(floor(vUv * vec2(aspect, 1.0) * 90.0) + floor(uTime * 18.0));
        col += vec3(0.25, 0.55, 1.0) * step(0.955, sn) * smoothstep(0.6, 1.0, edge) * uStorm * 0.4;
      }

      // Shockwave rings catch a little light
      col += ringCol * 0.35;

      // Skydive: wind streaks raking out from the centre
      if (uLines > 0.001) {
        float seg = floor(atan(c.y, c.x + 1e-5) * 38.0);
        float h = hash(vec2(seg, floor(uTime * 14.0 + hash(vec2(seg, 1.0)) * 4.0)));
        float lines = step(0.86, h) * smoothstep(0.35, 0.95, edge);
        col = mix(col, vec3(0.92, 0.96, 1.0), lines * uLines * 0.35);
      }

      // Victory: slow golden rays from above the top of the screen
      if (uRays > 0.001) {
        vec2 rp = vec2(c.x * aspect, vUv.y - 1.15);
        float a = atan(rp.x, -rp.y);
        float rays = 0.5 + 0.5 * sin(a * 15.0 + uTime * 0.7) * sin(a * 7.0 - uTime * 0.45);
        rays *= 1.0 - smoothstep(0.2, 1.6, length(rp));
        col += vec3(1.0, 0.78, 0.35) * rays * uRays * 0.32;
      }

      // Flashes are stronger at the edges, so the crosshair stays readable
      col += uFlashColor * uFlash * (0.3 + 0.7 * edge);

      // Film: grain and rolling scanlines
      float n = hash(vUv * uRes + fract(uTime) * 91.7);
      col += (n - 0.5) * uGrain;
      col *= 1.0 - uScan * (0.5 + 0.5 * sin(vUv.y * uRes.y * 1.6 - uTime * 18.0));

      // Drone camera: phosphor monochrome, fine lines, corner brackets, blinking REC dot
      if (uFeed > 0.001) {
        float lf = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(0.62, 1.0, 0.84) * (lf * 1.08 + 0.03), uFeed * 0.8);
        col *= 1.0 - uFeed * 0.16 * (0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159));
        vec2 pp = vUv * uRes;
        vec2 e = min(pp, uRes - pp) - 0.07 * uRes.y;
        float len = 0.09 * uRes.y, th = max(1.5, 0.004 * uRes.y);
        float hor = step(0.0, e.y) * step(e.y, th) * step(0.0, e.x) * step(e.x, len);
        float ver = step(0.0, e.x) * step(e.x, th) * step(0.0, e.y) * step(e.y, len);
        col = mix(col, vec3(0.8, 1.0, 0.88), max(hor, ver) * uFeed * 0.85);
        vec2 rec = pp - vec2(0.115 * uRes.y, 0.885 * uRes.y);
        float recDot = (1.0 - smoothstep(0.011 * uRes.y, 0.014 * uRes.y, length(rec))) * step(0.45, fract(uTime * 0.8));
        col = mix(col, vec3(1.0, 0.16, 0.12), recDot * uFeed);
        col *= mix(1.0, lensMask, uFeed);
      }

      // Signal glitch: bright noisy slices
      if (uGlitch > 0.001) {
        float sl = step(0.82, hash(vec2(floor(vUv.y * 60.0), floor(uTime * 30.0))));
        col = mix(col, vec3(hash(vUv * uRes + uTime)), sl * uGlitch * 0.35);
      }

      // Final circle: letterbox bars slide in
      if (uBars > 0.001) {
        float b = uBars * 0.085;
        col *= smoothstep(b, b + 0.003, vUv.y) * smoothstep(b, b + 0.003, 1.0 - vUv.y);
      }

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const RED = new THREE.Color(0.42, 0.0, 0.01);
const BLACK = new THREE.Color(0.0, 0.0, 0.0);
const SLOW_VIG = new THREE.Color(0.0, 0.03, 0.08);

export class PostFX {
  /** mode: "off" | "grade" | "full" (grade + bloom). samples: MSAA for the scene target. */
  constructor(renderer, { mode = "grade", samples = 0 } = {}) {
    this.renderer = renderer;
    this.mode = mode;
    this.enabled = mode !== "off";
    if (!this.enabled) return;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // Half float keeps highlights above 1 for the bloom and the tone mapping
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples,
      depthBuffer: true,
    });
    this.target.texture.name = "PostFX.scene";

    this.bloom = mode === "full" ? new UnrealBloomPass(size.clone(), 0.4, 0.45, 0.85) : null;

    this.uniforms = THREE.UniformsUtils.clone(GradeShader.uniforms);
    this.material = new THREE.RawShaderMaterial({
      name: "PostFX.grade",
      uniforms: this.uniforms,
      vertexShader: GradeShader.vertexShader,
      fragmentShader: GradeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.uniforms.uRes.value.copy(size);

    // Smoothed grade, chased toward the targets every frame
    this.g = { sat: 1.06, contrast: 1.05, bleach: 0, chroma: 0, vig: 0, scan: 0, bloom: 0.4, red: 0 };
    this.tint = new THREE.Color(1, 1, 1);
    this.flash = 0;
    this.flashColor = new THREE.Color(1, 1, 1);
    this.hurtPulse = 0;
    this.time = 0;
    // Battle royale: eased levels, one-shot glitch, pooled shockwaves
    this.br = { radial: 0, lines: 0, storm: 0, feed: 0, bars: 0, show: 0, rays: 0 };
    this.glitchAmt = 0;
    this.waves = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, r: 0, speed: 0, strength: 0, life: 0, age: 1 }));
  }

  /** Drawing-buffer size (CSS size × pixel ratio). */
  setSize(width, height) {
    if (!this.enabled) return;
    this.target.setSize(width, height);
    this.bloom?.setSize(width, height);
    this.uniforms.uRes.value.set(width, height);
    this.setScale(this.scale ?? 1);
  }

  /** True when setScale() can change the render scale (no bloom: it reads the whole target). */
  get canScale() { return this.enabled && !this.bloom; }

  /**
   * Dynamic resolution without reallocating anything: the scene draws into
   * the bottom-left `s` of the target (viewport + scissor) and the grade pass
   * stretches that part over the screen. Changing it is free (no canvas or
   * target resize, so no hitch), unlike changing the pixel ratio.
   */
  setScale(s) {
    if (!this.enabled) return;
    this.scale = s;
    const t = this.target;
    const w = Math.max(1, Math.round(t.width * s)), h = Math.max(1, Math.round(t.height * s));
    t.viewport.set(0, 0, w, h);
    t.scissor.set(0, 0, w, h);
    t.scissorTest = s < 1;
    this.uniforms.uScale.value.set(w / t.width, h / t.height);
  }

  /** The scene draws into this (set it before compiling materials, so they match). */
  begin() {
    if (this.enabled) this.renderer.setRenderTarget(this.target);
  }

  /** Bloom, then the grade onto the screen. Call after drawing the scene. */
  end() {
    if (!this.enabled) return;
    const r = this.renderer;
    if (this.bloom) this.bloom.render(r, null, this.target);
    this.uniforms.tDiffuse.value = this.target.texture;
    this.uniforms.toneMappingExposure.value = r.toneMappingExposure;
    r.setRenderTarget(null);
    this.quad.render(r);
  }

  /** A flash of colour that fades in a fraction of a second. */
  kick(strength, color) {
    if (!this.enabled) return;
    if (strength >= this.flash) this.flashColor.set(color);
    this.flash = Math.min(0.8, Math.max(this.flash, strength));
  }

  /** Taking a hit: red edges and a jolt of aberration. */
  hurt(amount) {
    if (!this.enabled) return;
    this.hurtPulse = Math.min(1, this.hurtPulse + amount);
  }

  /** "Signal lost": torn, noisy slices that settle in a moment. */
  glitch(amount) {
    if (!this.enabled) return;
    this.glitchAmt = Math.min(1, Math.max(this.glitchAmt, amount));
  }

  /**
   * A refracting ring expanding from screen point (x, y) in 0..1 uv (y up).
   * speed in screen heights per second, life in seconds. Reuses the weakest slot.
   */
  shockwave(x, y, strength, color = 0xffffff, speed = 1.1, life = 0.7) {
    if (!this.enabled || strength <= 0.01) return;
    let w = this.waves[0];
    for (const o of this.waves) if (o.strength * (1 - o.age) < w.strength * (1 - w.age)) w = o;
    w.x = x; w.y = y; w.r = 0; w.speed = speed; w.life = life; w.age = 0;
    w.strength = Math.min(1, strength);
    this.uniforms.uWaveTint.value[this.waves.indexOf(w)].set(color);
  }

  /**
   * s: { darkness 0..1, bloodMoon, health 0..1, dead, slowmo 0..1, frenzy 0..1, heartbeat 0..1, cave 0..1, scope 0..1,
   *      battle royale: zone 0..1, freefall 0..1, fallSpeed 0..1, feed 0..1 (spectating), showdown 0..1, victory 0..1 }
   * dt: real (unscaled) seconds.
   */
  update(dt, s) {
    if (!this.enabled) return;
    this.time += dt;
    const g = this.g;

    // Targets for this frame
    let sat = 1.06, contrast = 1.05, bleach = 0, chroma = 0, vig = 0, scan = 0, red = 0, grainFeed = 0;
    let bloom = 0.32 + s.darkness * 0.25;
    _c1.setRGB(1, 1, 1);

    // Night: cooler, bleached; a blood moon reddens it
    bleach += s.darkness * 0.12;
    sat -= s.darkness * 0.12;
    if (s.bloodMoon) _c1.lerp(_c2.setRGB(1.18, 0.82, 0.78), s.darkness * 0.8);
    else _c1.lerp(_c2.setRGB(0.9, 0.97, 1.1), s.darkness * 0.6);

    // Underground: deeper edges, a touch of bleach (torchlight stays warm)
    if (s.cave > 0) {
      vig += 0.3 * s.cave;
      bleach += 0.1 * s.cave;
    }

    // Low health: the colour drains out, the edges throb red with the heartbeat
    const low = Math.max(0, 1 - s.health / 0.4);
    if (low > 0) {
      sat -= 0.6 * low;
      vig += (0.35 + 0.3 * s.heartbeat) * low;
      chroma += 1.2 * low;
      red = Math.max(red, low);
    }

    // Weapon-wheel slow motion: cold, desaturated, film lines
    if (s.slowmo > 0) {
      sat *= 1 - 0.55 * s.slowmo;
      _c1.lerp(_c2.setRGB(0.84, 0.95, 1.16), s.slowmo);
      chroma += 2.4 * s.slowmo;
      scan += 0.07 * s.slowmo;
      vig += 0.4 * s.slowmo;
    }

    // Kill-streak frenzy: hot and saturated, everything glows
    if (s.frenzy > 0) {
      sat += 0.45 * s.frenzy;
      contrast += 0.12 * s.frenzy;
      _c1.lerp(_c2.setRGB(1.14, 1.0, 0.84), s.frenzy * 0.8);
      chroma += 0.8 * s.frenzy;
      bloom += 0.55 * s.frenzy;
    }

    // Battle royale: caught outside the blue zone, it closes in cold and pulsing
    if (s.zone > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 5.5);
      sat -= 0.35 * s.zone;
      _c1.lerp(_c2.setRGB(0.72, 0.9, 1.3), 0.7 * s.zone);
      vig += (0.3 + 0.25 * pulse) * s.zone;
      chroma += (0.6 + 0.8 * pulse) * s.zone;
      bloom += 0.2 * s.zone;
    }
    // Freefall: wind-blur fringes and tunnel vision, eased off as the chute opens
    if (s.freefall > 0) {
      chroma += 2.2 * s.freefall;
      vig += 0.35 * s.freefall;
      contrast += 0.06 * s.freefall;
      sat += 0.08 * s.freefall;
    }

    // Looking down a scope: a little lens fringing at the edge of the glass, crisper contrast
    if (s.scope > 0) {
      chroma += 0.7 * s.scope;
      contrast += 0.04 * s.scope;
    }

    // Final circle: punchier, a touch warmer (the split tone and bars are in the shader)
    const show = s.showdown ?? 0;
    if (show > 0) {
      contrast += 0.1 * show;
      sat += 0.05 * show;
    }
    // Victory: a warm, glowing afterglow
    const victory = s.victory ?? 0;
    if (victory > 0) {
      _c1.lerp(_c2.setRGB(1.12, 1.02, 0.86), 0.6 * victory);
      bloom += 0.5 * victory;
      sat += 0.15 * victory;
    }
    // Spectating: the feed brings its own look, so drop the rest of the grade
    const feed = s.feed ?? 0;
    if (feed > 0) {
      vig *= 1 - feed;
      chroma *= 1 - feed;
      red *= 1 - feed;
      grainFeed = 0.05 * feed;
    }

    if (s.dead) { sat = 0; contrast = 1.18; vig = 0.7; red = 0; chroma = 0; scan = 0; _c1.setRGB(1, 1, 1); }

    const k = 1 - Math.exp(-6 * dt);
    g.sat += (sat - g.sat) * k;
    g.contrast += (contrast - g.contrast) * k;
    g.bleach += (bleach - g.bleach) * k;
    g.chroma += (chroma - g.chroma) * k;
    g.vig += (vig - g.vig) * k;
    g.scan += (scan - g.scan) * k;
    g.bloom += (bloom - g.bloom) * k;
    g.red += (red - g.red) * k;
    this.tint.lerp(_c1, k);

    // Battle royale levels: the skydive answers fast, moods ease in slower
    const b = this.br, kf = 1 - Math.exp(-8 * dt), ks = 1 - Math.exp(-2.5 * dt);
    const fall = s.fallSpeed ?? 0;
    b.radial += (fall - b.radial) * kf;
    b.lines += (fall * fall - b.lines) * kf;
    b.storm += ((s.zone ?? 0) - b.storm) * k;
    b.feed += (feed - b.feed) * ks;
    b.bars += (show - b.bars) * ks;
    b.show += (show - b.show) * ks;
    b.rays += (victory - b.rays) * ks;
    for (const key in b) if (b[key] < 0.002) b[key] = 0; // so the shader branches switch off
    this.glitchAmt = Math.max(0, this.glitchAmt - dt * 1.6);
    for (let i = 0; i < 4; i++) {
      const w = this.waves[i], uw = this.uniforms.uWaves.value[i];
      if (w.age >= 1) { uw.w = 0; continue; }
      w.age = Math.min(1, w.age + dt / w.life);
      w.r += w.speed * dt * (1.4 - w.age); // fast out, slowing as it fades
      const fade = 1 - w.age;
      uw.set(w.x, w.y, w.r, w.strength * fade * fade);
    }

    // Hits and flashes decay on their own
    this.hurtPulse = Math.max(0, this.hurtPulse - dt * 2.2);
    this.flash = Math.max(0, this.flash - dt * 3.2);

    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uSat.value = Math.max(0, g.sat);
    u.uContrast.value = g.contrast;
    u.uTint.value.copy(this.tint);
    u.uBleach.value = g.bleach;
    u.uChroma.value = g.chroma + this.hurtPulse * 3.5;
    u.uVig.value = Math.min(0.95, g.vig + this.hurtPulse * 0.55);
    const redness = Math.min(1, Math.max(g.red, this.hurtPulse * 1.5));
    u.uVigColor.value.copy(s.slowmo > 0.3 && redness < 0.3 ? SLOW_VIG : BLACK).lerp(RED, redness);
    u.uFlash.value = this.flash;
    u.uFlashColor.value.copy(this.flashColor);
    u.uGrain.value = 0.02 + g.scan * 0.4 + grainFeed + this.glitchAmt * 0.06;
    u.uScan.value = g.scan;
    u.uRadial.value = b.radial;
    u.uLines.value = b.lines;
    u.uStorm.value = b.storm;
    u.uGlitch.value = this.glitchAmt;
    u.uFeed.value = b.feed;
    u.uBars.value = b.bars;
    u.uShow.value = b.show;
    u.uRays.value = b.rays;
    if (this.bloom) this.bloom.strength = g.bloom + this.flash * 0.8;
  }
}
