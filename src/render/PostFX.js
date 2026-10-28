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
    #include <tonemapping_pars_fragment>
    #include <colorspace_pars_fragment>
    varying vec2 vUv;

    void main() {
      vec2 c = vUv - 0.5;
      vec3 col;
      // Chromatic aberration: red and blue pulled apart toward the edges
      // (the scene only filled the bottom-left uScale of the target)
      vec2 suv = vUv * uScale;
      if (uChroma > 0.01) {
        vec2 off = c * uChroma / uRes.y * 2.0 * uScale;
        col = vec3(texture2D(tDiffuse, suv + off).r, texture2D(tDiffuse, suv).g, texture2D(tDiffuse, suv - off).b);
      } else {
        col = texture2D(tDiffuse, suv).rgb;
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

      // Vignette toward a colour (black, or blood red when hurt)
      float d = length(c * vec2(uRes.x / uRes.y, 1.0)) / length(vec2(uRes.x / uRes.y, 1.0) * 0.5);
      col = mix(col, uVigColor, smoothstep(0.45, 1.05, d) * uVig);

      // Flashes are stronger at the edges, so the crosshair stays readable
      col += uFlashColor * uFlash * (0.3 + 0.7 * d);

      // Film: grain and rolling scanlines
      float n = fract(sin(dot(vUv * uRes + fract(uTime) * 91.7, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * uGrain;
      col *= 1.0 - uScan * (0.5 + 0.5 * sin(vUv.y * uRes.y * 1.6 - uTime * 18.0));

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

  /**
   * s: { darkness 0..1, bloodMoon, health 0..1, dead, slowmo 0..1, frenzy 0..1, heartbeat 0..1, cave 0..1 }
   * dt: real (unscaled) seconds.
   */
  update(dt, s) {
    if (!this.enabled) return;
    this.time += dt;
    const g = this.g;

    // Targets for this frame
    let sat = 1.06, contrast = 1.05, bleach = 0, chroma = 0, vig = 0, scan = 0, red = 0;
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
    u.uGrain.value = 0.02 + g.scan * 0.4;
    u.uScan.value = g.scan;
    if (this.bloom) this.bloom.strength = g.bloom + this.flash * 0.8;
  }
}
