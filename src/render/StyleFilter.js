import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

// The cheat-code picture styles: cartoon, black and white, pencil sketch. It works
// on the finished frame (copied off the screen), so it looks the same whatever the
// PostFX quality is, and costs nothing while no style is on.

const MODES = { toon: 1, bw: 2, sketch: 3 };

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D tFrame;
  uniform vec2 uRes;
  uniform float uTime;
  uniform float uMode;
  uniform float uAmt;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  /** Sobel on brightness: how strong an edge runs through uv. */
  float edge(vec2 uv, float spread) {
    vec2 p = spread / uRes;
    float tl = luma(texture2D(tFrame, uv + vec2(-p.x, p.y)).rgb), t = luma(texture2D(tFrame, uv + vec2(0.0, p.y)).rgb), tr = luma(texture2D(tFrame, uv + p).rgb);
    float l = luma(texture2D(tFrame, uv - vec2(p.x, 0.0)).rgb), r = luma(texture2D(tFrame, uv + vec2(p.x, 0.0)).rgb);
    float bl = luma(texture2D(tFrame, uv - p).rgb), b = luma(texture2D(tFrame, uv - vec2(0.0, p.y)).rgb), br = luma(texture2D(tFrame, uv + vec2(p.x, -p.y)).rgb);
    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
    float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
    return sqrt(gx * gx + gy * gy);
  }

  /** Lines at an angle, one every spacing pixels, as ink 0..1 (a little uneven, like a hand). */
  float hatch(vec2 px, float angle, float spacing, float wobble) {
    float c = cos(angle), s = sin(angle);
    float d = px.x * c + px.y * s;
    float along = -px.x * s + px.y * c;
    d += sin(along * 0.03 + wobble) * 1.6;
    float t = abs(fract(d / spacing) - 0.5) * spacing;
    return 1.0 - smoothstep(0.35, 1.25, t);
  }

  vec3 cartoon(vec2 uv) {
    vec3 c = texture2D(tFrame, uv).rgb;
    // Flat bands of colour: brightness in a few steps, the hue left alone and pushed
    float l = max(luma(c), 0.0001);
    float band = (floor(pow(l, 0.8) * 5.0) + 0.55) / 5.0;
    vec3 flat_ = c / l * band;
    float grey = luma(flat_);
    flat_ = mix(vec3(grey), flat_, 1.6);
    float e = smoothstep(0.34, 0.62, edge(uv, 1.4));
    return mix(clamp(flat_, 0.0, 1.0), vec3(0.04, 0.03, 0.05), e);
  }

  vec3 noir(vec2 uv) {
    float l = luma(texture2D(tFrame, uv).rgb);
    l = smoothstep(0.03, 0.92, l);
    l = mix(l, l * l * (3.0 - 2.0 * l), 0.6);
    vec2 c = vUv - 0.5;
    l *= 1.0 - 0.75 * smoothstep(0.25, 0.8, length(c));
    l += (hash(vUv * uRes + fract(uTime) * 57.0) - 0.5) * 0.09;
    // Old film: a scratch now and then, the whole picture flickering a little
    float x = hash(vec2(floor(uTime * 12.0), 7.0));
    l += 0.14 * (1.0 - smoothstep(0.0, 0.0016, abs(vUv.x - x))) * step(0.72, hash(vec2(floor(uTime * 12.0), 2.0)));
    l *= 0.96 + 0.04 * hash(vec2(floor(uTime * 18.0), 1.0));
    return vec3(l);
  }

  vec3 sketch(vec2 uv) {
    // The lines redraw a few times a second, as if every frame was drawn by hand
    float beat = floor(uTime * 7.0);
    vec2 jitter = (vec2(hash(vec2(beat, 1.0)), hash(vec2(beat, 2.0))) - 0.5) * 1.8 / uRes;
    vec2 at = uv + jitter;
    float l = luma(texture2D(tFrame, at).rgb);
    vec2 px = vUv * uRes;
    float w = beat * 1.7;
    float ink = 0.0;
    if (l < 0.72) ink = max(ink, hatch(px, 0.78, 7.0, w) * 0.42);
    if (l < 0.48) ink = max(ink, hatch(px, -0.78, 6.0, w + 2.0) * 0.6);
    if (l < 0.28) ink = max(ink, hatch(px, 0.1, 4.5, w + 4.0) * 0.8);
    if (l < 0.13) ink = max(ink, hatch(px, 1.45, 3.5, w + 6.0) * 0.95);
    float outline = smoothstep(0.16, 0.5, edge(at, 1.2));
    ink = max(ink, outline * 0.95);
    float grain = hash(floor(px * 0.75)) * 0.05 + hash(floor(px * 0.17)) * 0.035;
    vec3 paper = vec3(0.95, 0.925, 0.86) - grain;
    return mix(paper, vec3(0.13, 0.13, 0.17), ink);
  }

  void main() {
    vec3 src = texture2D(tFrame, vUv).rgb;
    vec3 col = uMode < 1.5 ? cartoon(vUv) : uMode < 2.5 ? noir(vUv) : sketch(vUv);
    gl_FragColor = vec4(mix(src, col, uAmt), 1.0);
  }
`;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const _size = new THREE.Vector2();
const _origin = new THREE.Vector2(0, 0);

export class StyleFilter {
  constructor(renderer) {
    this.renderer = renderer;
    this.mode = null;       // "toon" | "bw" | "sketch" | null
    this.amt = 0;
    this.time = 0;
    this.shown = 0;         // what the shader is drawing while the old style fades out
    this.frame = null;
    this.material = new THREE.ShaderMaterial({
      name: "StyleFilter",
      uniforms: {
        tFrame: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 }, uMode: { value: 1 }, uAmt: { value: 0 },
      },
      vertexShader, fragmentShader, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  set(mode) { this.mode = mode; }

  /** Eases in and out (dt: real seconds). */
  update(dt) {
    this.time += dt;
    if (this.mode) this.shown = MODES[this.mode];
    const want = this.mode ? 1 : 0;
    this.amt += (want - this.amt) * (1 - Math.exp(-7 * dt));
    if (!want && this.amt < 0.004) this.amt = 0;
  }

  /** After the frame is finished on the screen. */
  render() {
    if (this.amt <= 0) return;
    const r = this.renderer, s = r.getDrawingBufferSize(_size);
    if (!this.frame || this.frame.image.width !== s.x || this.frame.image.height !== s.y) {
      this.frame?.dispose();
      this.frame = new THREE.FramebufferTexture(s.x, s.y);
      this.frame.minFilter = this.frame.magFilter = THREE.LinearFilter;
    }
    r.setRenderTarget(null);
    r.copyFramebufferToTexture(this.frame, _origin);
    const u = this.material.uniforms;
    u.tFrame.value = this.frame;
    u.uRes.value.copy(s);
    u.uTime.value = this.time;
    u.uMode.value = this.shown;
    u.uAmt.value = this.amt;
    this.quad.render(r);
  }
}
