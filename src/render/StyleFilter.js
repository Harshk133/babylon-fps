import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

// The cheat-code picture styles: cartoon, black and white, pencil sketch. It works
// on the finished frame (copied off the screen), so it looks the same whatever the
// PostFX quality is, and costs nothing while no style is on.

const MODES = { toon: 1, bw: 2, sketch: 3, thermal: 4, pixel: 5, rainc: 6, neon: 7, acid: 8, comic: 9, ascii: 10, xray: 11 };

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

  vec3 heat(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 a = mix(vec3(0.02, 0.0, 0.12), vec3(0.35, 0.0, 0.75), smoothstep(0.0, 0.25, t));
    a = mix(a, vec3(0.95, 0.05, 0.25), smoothstep(0.22, 0.5, t));
    a = mix(a, vec3(1.0, 0.72, 0.02), smoothstep(0.48, 0.78, t));
    return mix(a, vec3(1.0, 1.0, 0.9), smoothstep(0.76, 1.0, t));
  }

  vec3 thermal(vec2 uv) {
    float l = luma(texture2D(tFrame, uv).rgb);
    float e = edge(uv, 1.5);
    float n = hash(floor(vUv * uRes * 0.5) + fract(uTime) * 31.0) * 0.05;
    return heat(pow(l, 0.75) + e * 0.35 + n);
  }

  float bayer(vec2 p) {
    vec2 a = mod(floor(p), 4.0);
    float v = 0.0, s = 1.0;
    for (int i = 0; i < 2; i++) {
      vec2 q = floor(a / s) * 0.5;
      v = v * 0.25 + (mod(floor(a.x / s) + floor(a.y / s), 2.0) * 0.5 + mod(floor(a.y / s), 2.0) * 0.25);
      s *= 2.0;
    }
    return v;
  }

  vec3 pixelArt(vec2 uv) {
    float size = max(4.0, floor(uRes.y / 135.0));
    vec2 cell = floor(uv * uRes / size);
    vec3 c = texture2D(tFrame, (cell + 0.5) * size / uRes).rgb;
    float d = bayer(cell) - 0.5;
    return floor(c * 5.0 + d + 0.5) / 5.0;
  }

  vec3 digitalRain(vec2 uv) {
    float size = max(8.0, floor(uRes.y / 56.0));
    vec2 px = uv * uRes;
    vec2 cell = floor(px / size);
    float sp = 0.25 + hash(vec2(cell.x, 3.0)) * 0.6;
    float head = fract(uTime * sp + hash(vec2(cell.x, 9.0)));
    float pos = 1.0 - (cell.y + 0.5) * size / uRes.y;
    float behind = fract(head - pos + 1.0);
    float trail = pow(1.0 - behind, 5.0);
    vec2 g = floor(fract(px / size) * vec2(3.0, 5.0));
    float seed = floor(uTime * 7.0 * (0.4 + hash(cell)));
    float on = step(0.48, hash(g + cell * 7.0 + seed));
    float l = luma(texture2D(tFrame, (cell + 0.5) * size / uRes).rgb);
    vec3 base = vec3(0.0, l * 0.55, l * 0.12);
    vec3 glyph = mix(vec3(0.1, 1.0, 0.35), vec3(0.85, 1.0, 0.9), step(0.93, 1.0 - behind)) * on * trail * (0.45 + l * 1.5);
    float shape = smoothstep(0.08, 0.5, edge(uv, 1.6)) * 0.55;
    return base + glyph + vec3(0.1, 0.95, 0.35) * shape;
  }

  vec3 neonEdges(vec2 uv) {
    float e = smoothstep(0.14, 0.5, edge(uv, 1.3)), wide = smoothstep(0.14, 0.7, edge(uv, 3.6));
    float a = uTime * 0.7 + (vUv.x + vUv.y) * 4.0;
    vec3 hue = 0.5 + 0.5 * cos(a + vec3(0.0, 2.1, 4.2));
    float l = luma(texture2D(tFrame, uv).rgb);
    return vec3(0.015, 0.0, 0.05) + hue * (e * 1.3 + wide * 0.4) + vec3(0.05, 0.0, 0.12) * l;
  }

  vec3 kaleidoscope(vec2 uv) {
    vec2 p = uv - 0.5;
    p.x *= uRes.x / uRes.y;
    float r = length(p), a = atan(p.y, p.x) + uTime * 0.14;
    float sides = 8.0, w = 6.2831853 / sides;
    a = abs(mod(a, w) - w * 0.5);
    r += sin(r * 12.0 - uTime * 2.0) * 0.015;
    vec2 q = vec2(cos(a), sin(a)) * r;
    q.x /= uRes.x / uRes.y;
    vec3 c = texture2D(tFrame, clamp(q * 1.1 + 0.5, 0.002, 0.998)).rgb;
    float t = uTime * 0.9 + r * 4.0;
    mat3 hue = mat3(cos(t) * 0.5 + 0.5, 0.0, sin(t) * 0.5 + 0.5, sin(t) * 0.5 + 0.5, cos(t) * 0.5 + 0.5, 0.0, 0.0, sin(t) * 0.5 + 0.5, cos(t) * 0.5 + 0.5);
    return clamp(hue * c * 1.7, 0.0, 1.0);
  }

  vec3 popComic(vec2 uv) {
    vec3 c = texture2D(tFrame, uv).rgb;
    float l = luma(c);
    vec3 flatCol = floor(mix(vec3(l), c, 1.7) * 4.0 + 0.5) / 4.0;
    vec2 px = vUv * uRes;
    float size = max(6.0, floor(uRes.y / 95.0));
    vec2 r = mat2(0.707, -0.707, 0.707, 0.707) * px / size;
    float dot_ = length(fract(r) - 0.5);
    float ink = 1.0 - smoothstep(0.0, 0.08, dot_ - (1.0 - l) * 0.62);
    vec3 col = mix(clamp(flatCol, 0.0, 1.0) + 0.14, flatCol * 0.25, ink);
    return mix(col, vec3(0.02), smoothstep(0.3, 0.55, edge(uv, 1.5)));
  }

  float glyph(int n, vec2 p) {
    p = floor(p * vec2(-4.0, 4.0) + 2.5);
    if (clamp(p.x, 0.0, 4.0) == p.x && clamp(p.y, 0.0, 4.0) == p.y) {
      int a = int(p.x + 0.5) + 5 * int(p.y + 0.5);
      if (((n >> a) & 1) == 1) return 1.0;
    }
    return 0.0;
  }

  vec3 asciiArt(vec2 uv) {
    float size = max(8.0, floor(uRes.y / 75.0));
    vec2 px = uv * uRes;
    vec3 c = texture2D(tFrame, (floor(px / size) + 0.5) * size / uRes).rgb;
    float g = luma(c);
    int n = 4096;
    if (g > 0.2) n = 65600;
    if (g > 0.3) n = 332772;
    if (g > 0.4) n = 15255086;
    if (g > 0.5) n = 23385164;
    if (g > 0.6) n = 15252014;
    if (g > 0.7) n = 13199452;
    if (g > 0.8) n = 11512810;
    vec2 p = mod(px / (size * 0.5), 2.0) - vec2(1.0);
    return mix(c * 1.6, vec3(0.55, 1.0, 0.65), 0.45) * glyph(n, p);
  }

  vec3 xray(vec2 uv) {
    float l = 1.0 - luma(texture2D(tFrame, uv).rgb);
    float e = smoothstep(0.1, 0.5, edge(uv, 1.4));
    float scan = 0.92 + 0.08 * sin(vUv.y * uRes.y * 0.5 - uTime * 7.0);
    return (vec3(0.03, 0.13, 0.3) + vec3(0.3, 0.72, 1.0) * pow(l, 1.6) * 0.75 + vec3(0.7, 0.95, 1.0) * e) * scan;
  }

  void main() {
    vec3 src = texture2D(tFrame, vUv).rgb;
    vec3 col = uMode < 1.5 ? cartoon(vUv) : uMode < 2.5 ? noir(vUv) : uMode < 3.5 ? sketch(vUv)
      : uMode < 4.5 ? thermal(vUv) : uMode < 5.5 ? pixelArt(vUv) : uMode < 6.5 ? digitalRain(vUv)
      : uMode < 7.5 ? neonEdges(vUv) : uMode < 8.5 ? kaleidoscope(vUv) : uMode < 9.5 ? popComic(vUv)
      : uMode < 10.5 ? asciiArt(vUv) : xray(vUv);
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

  /** Compiles the shader ahead of time: the first cheat code shouldn't stall the game. */
  warm(camera) {
    const s = new THREE.Scene();
    s.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
    return this.renderer.compileAsync(s, camera);
  }

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
