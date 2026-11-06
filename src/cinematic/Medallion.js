import * as THREE from "three";
import gsap from "gsap";

// Scene 01-02: the bronze medallion, and the universe in Krishna's mouth.
//
// A heavy, antique circular artifact at the heart of an enormous radial
// mechanism: a dark charcoal-bronze funnel engraved with thousands of fine
// radial grooves running out to the edges of the screen, smoke drifting across
// it, golden dust in the light. The medallion is built as separate 3D layers:
//   outer   a lathed bronze frame with a fluted crown of ribs and embossed bosses
//   band    an engraved ring (lotus petals, a chevron lattice, keri and rosettes,
//           a rope twist: drawn once on a canvas as colour, bump and roughness)
//   rope    a twisted rope of bronze, then 108 beads like a japa mala
//   inner   the inner bronze lip, stepping down to the artwork
//   art     the devotional image of Lord Krishna, recessed in the centre
// Bal Gopal first smiles, mouth closed (public/cinematic/krishna_closed.webp,
// made by scripts/build-krishna-intro.py from the supplied artwork); then the
// mouth opens (krishna_open.webp, the artwork as it is) and, as Mother Yashoda
// saw it (Srimad Bhagavatam 10.8), the whole universe is within. The rings
// part and fly outward, and the camera goes in through the mouth, into the
// cosmos (Cosmos.js takes over).
//
// One GSAP timeline (paused, seeked by the conductor's clock, so skipping and
// late sound stay exact) drives the light, the reveal, the rings and the camera.

const TAU = Math.PI * 2;

// Timing of this shot (seconds from the start of the intro). CinematicIntro's
// CUES must agree: vision = OPEN, vision_through = THROUGH.
export const MEDALLION = { EMERGE: 2.5, CLOSE: 10.5, LOCK: 13.4, OPEN: 16, PART: 18.2, THROUGH: 23.2 };

// The artwork's geometry (source pixels of krishna_*.webp, 736 × 918)
const IMG_W = 736, IMG_H = 918;
const ART_C = [378, 410], ART_R = 360;   // the circle of the picture shown in the disc
const MOUTH = [392, 514];
const DISC_R = 2.08;
/** The mouth in the medallion's local coordinates. */
export const MOUTH_LOCAL = new THREE.Vector3(((MOUTH[0] - ART_C[0]) / ART_R) * DISC_R, (-(MOUTH[1] - ART_C[1]) / ART_R) * DISC_R, 0);

export const NOISE_GLSL = `
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
  float fbm3(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++) { s += a * noise(p); p *= 2.07; a *= 0.5; } return s; }
`;

// ── Procedural textures ─────────────────────────────────────────────────────
function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Aged metal: tiling colour (patina in the low spots) and roughness. */
function patinaCanvases(size = 512) {
  const rnd = seeded(11);
  const col = document.createElement("canvas"), rough = document.createElement("canvas");
  col.width = col.height = rough.width = rough.height = size;
  const gc = col.getContext("2d"), gr = rough.getContext("2d");
  gc.fillStyle = "#b07a3c"; gc.fillRect(0, 0, size, size);
  gr.fillStyle = "#6a6a6a"; gr.fillRect(0, 0, size, size);
  // Blotches of darker oxidation and worn bright spots, wrapped so it tiles
  for (let i = 0; i < 260; i++) {
    const x = rnd() * size, y = rnd() * size, r = 6 + rnd() * 46, dark = rnd() < 0.7;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      const g = gc.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g.addColorStop(0, dark ? "rgba(40,24,10,0.22)" : "rgba(255,214,150,0.16)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      gc.fillStyle = g; gc.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      const h = gr.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      h.addColorStop(0, dark ? "rgba(230,230,230,0.25)" : "rgba(20,20,20,0.25)");
      h.addColorStop(1, "rgba(0,0,0,0)");
      gr.fillStyle = h; gr.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  // Fine scratches
  for (let i = 0; i < 900; i++) {
    const x = rnd() * size, y = rnd() * size, a = rnd() * TAU, l = 4 + rnd() * 26;
    gc.strokeStyle = rnd() < 0.5 ? "rgba(255,230,180,0.08)" : "rgba(30,18,6,0.1)";
    gc.lineWidth = 0.7;
    gc.beginPath(); gc.moveTo(x, y); gc.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); gc.stroke();
  }
  return { col, rough };
}

/**
 * The engraved band, in polar layout: the ring's UVs map radius RIN..1 of the
 * canvas half-size onto the ring's inner..outer radius. Returns the height
 * (white raised, black cut) and the colour derived from it.
 */
const RIN = 0.6;
function bandCanvases(size) {
  const h = document.createElement("canvas");
  h.width = h.height = size;
  const g = h.getContext("2d");
  const C = size / 2;
  g.translate(C, C);
  const R = s => C * (RIN + (1 - RIN) * s);   // band coordinate s 0 (inner) .. 1 (outer) → px
  g.fillStyle = "#8c8c8c";
  g.beginPath(); g.arc(0, 0, C, 0, TAU); g.fill();
  const ring = (s, w, c) => { g.strokeStyle = c; g.lineWidth = w; g.beginPath(); g.arc(0, 0, R(s), 0, TAU); g.stroke(); };
  const at = (a, s, fn) => { g.save(); g.rotate(a); g.translate(R(s), 0); g.rotate(Math.PI / 2); fn(); g.restore(); };
  const u = size / 2048;   // stroke scale

  // Raised dividing fillets with cut lines either side
  for (const s of [0.035, 0.31, 0.35, 0.64, 0.68, 0.94]) { ring(s, 9 * u, "#dcdcdc"); ring(s - 0.012, 2.5 * u, "#1c1c1c"); ring(s + 0.012, 2.5 * u, "#1c1c1c"); }
  // Beaded course at the inner edge
  for (let i = 0; i < 200; i++) at((i / 200) * TAU, 0.012, () => { g.fillStyle = "#e8e8e8"; g.beginPath(); g.arc(0, 0, 5.5 * u, 0, TAU); g.fill(); });
  // Lotus petals: 48, double outlined, a vein down each
  const pL = R(0.29) - R(0.06);
  for (let i = 0; i < 48; i++) {
    at((i / 48) * TAU, 0.06, () => {
      g.rotate(Math.PI);
      const w = (TAU * R(0.17)) / 48 * 0.5;
      const petal = (k) => { g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(-w * k, -pL * 0.25, -w * 0.8 * k, -pL * 0.8, 0, -pL * k); g.bezierCurveTo(w * 0.8 * k, -pL * 0.8, w * k, -pL * 0.25, 0, 0); };
      petal(1); g.fillStyle = "#d2d2d2"; g.fill(); g.strokeStyle = "#141414"; g.lineWidth = 3 * u; g.stroke();
      petal(0.72); g.fillStyle = "#f0f0f0"; g.fill(); g.strokeStyle = "#3a3a3a"; g.lineWidth = 2 * u; g.stroke();
      g.beginPath(); g.moveTo(0, -pL * 0.08); g.lineTo(0, -pL * 0.62); g.strokeStyle = "#2a2a2a"; g.lineWidth = 2 * u; g.stroke();
    });
    // a small drop between petals
    at(((i + 0.5) / 48) * TAU, 0.24, () => { g.fillStyle = "#e0e0e0"; g.beginPath(); g.arc(0, 0, 6 * u, 0, TAU); g.fill(); });
  }
  // The geometric course: a chevron lattice with dots in the triangles
  const n = 96, s0 = 0.38, s1 = 0.61;
  g.lineWidth = 4 * u; g.strokeStyle = "#ececec";
  for (const [a0, b0] of [[s0, s1], [s1, s0]]) {
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * TAU, s = i % 2 ? a0 : b0;
      const x = Math.cos(a) * R(s), y = Math.sin(a) * R(s);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  g.lineWidth = 1.6 * u; g.strokeStyle = "#1a1a1a";
  for (const [a0, b0] of [[s0 + 0.02, s1 - 0.02], [s1 - 0.02, s0 + 0.02]]) {
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * TAU, s = i % 2 ? a0 : b0;
      const x = Math.cos(a) * R(s), y = Math.sin(a) * R(s);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  for (let i = 0; i < n; i++) {
    for (const [off, s] of [[0, 0.43], [0.5, 0.56]]) at(((i + off) / n) * TAU, s, () => { g.fillStyle = "#f4f4f4"; g.beginPath(); g.arc(0, 0, 7 * u, 0, TAU); g.fill(); g.strokeStyle = "#222"; g.lineWidth = 1.5 * u; g.stroke(); });
  }
  // Keri (paisleys) alternating with eight-petal rosettes
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * TAU;
    if (i % 2 === 0) {
      at(a, 0.81, () => {
        const k = 1.05 * u;
        g.scale(k, k);
        g.beginPath();
        g.moveTo(0, 44); g.bezierCurveTo(-52, 18, -44, -52, 6, -58); g.bezierCurveTo(38, -60, 50, -22, 20, -10); g.bezierCurveTo(44, 14, 24, 44, 0, 44);
        g.fillStyle = "#e6e6e6"; g.fill(); g.strokeStyle = "#151515"; g.lineWidth = 4; g.stroke();
        g.beginPath(); g.moveTo(0, 30); g.bezierCurveTo(-30, 12, -26, -36, 4, -40); g.strokeStyle = "#333"; g.lineWidth = 2; g.stroke();
        g.beginPath(); g.arc(4, -26, 9, 0, TAU); g.fillStyle = "#fafafa"; g.fill(); g.strokeStyle = "#222"; g.stroke();
      });
    } else {
      at(a, 0.81, () => {
        const r = 30 * u;
        for (let p = 0; p < 8; p++) {
          g.save(); g.rotate((p / 8) * TAU);
          g.beginPath(); g.ellipse(0, -r * 0.62, r * 0.22, r * 0.5, 0, 0, TAU);
          g.fillStyle = "#e4e4e4"; g.fill(); g.strokeStyle = "#1a1a1a"; g.lineWidth = 2 * u; g.stroke();
          g.restore();
        }
        g.beginPath(); g.arc(0, 0, r * 0.26, 0, TAU); g.fillStyle = "#fbfbfb"; g.fill(); g.stroke();
      });
    }
  }
  // Rope twist round the outer edge
  for (let i = 0; i < 260; i++) {
    at((i / 260) * TAU, 0.97, () => {
      g.rotate(0.7);
      g.beginPath(); g.ellipse(0, 0, 4 * u, 13 * u, 0, 0, TAU);
      g.fillStyle = "#e2e2e2"; g.fill(); g.strokeStyle = "#1a1a1a"; g.lineWidth = 2 * u; g.stroke();
    });
  }
  // Colour from height: cut lines dark with old grime, raised work worn bright
  const col = document.createElement("canvas");
  col.width = col.height = size;
  const hc = g.getImageData(0, 0, size, size), d = hc.data;
  const cc = col.getContext("2d"), out = cc.createImageData(size, size), o = out.data;
  const rnd = seeded(5);
  const lo = [42, 24, 10], mid = [132, 86, 40], hi = [214, 160, 84];
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] / 255, k = v < 0.55 ? v / 0.55 : (v - 0.55) / 0.45, a = v < 0.55 ? lo : mid, b = v < 0.55 ? mid : hi;
    const n = 0.9 + rnd() * 0.2;
    o[i] = (a[0] + (b[0] - a[0]) * k) * n; o[i + 1] = (a[1] + (b[1] - a[1]) * k) * n; o[i + 2] = (a[2] + (b[2] - a[2]) * k) * n; o[i + 3] = 255;
  }
  cc.putImageData(out, 0, 0);
  return { height: h, col };
}

/** Ring UVs → the polar canvas (radius RIN..1 of its half-size over rIn..rOut). */
function polarUv(geo, rIn, rOut) {
  const uv = geo.attributes.uv, pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), r = Math.hypot(x, y), a = Math.atan2(y, x);
    const k = 0.5 * (RIN + (1 - RIN) * (r - rIn) / (rOut - rIn));
    uv.setXY(i, 0.5 + Math.cos(a) * k, 0.5 + Math.sin(a) * k);
  }
}

// ── Shaders ─────────────────────────────────────────────────────────────────
const VERT = `
  varying vec2 vUv; varying vec3 vPos; varying vec3 vWorld;
  void main() {
    vUv = uv; vPos = position;
    vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

// The enormous grooved mechanism: a shallow bronze funnel round the medallion
const FUNNEL_FRAG = `
  uniform float uTime, uLight, uGlow, uOpen, uSlope, uR0;
  uniform vec3 uKey, uCam;
  varying vec2 vUv; varying vec3 vPos; varying vec3 vWorld;
  ${NOISE_GLSL}
  // A groove profile: returns (depth 0..1, side -1..1) for coordinate g with N per turn
  vec2 groove(float g, float g2, float width) {
    float fw = max(min(fwidth(g), fwidth(g2)), 1e-4);
    float f = fract(g) - 0.5;
    float d = abs(f);
    float cut = 1.0 - smoothstep(width - fw, width + fw, d);
    return vec2(cut, sign(f));
  }
  void main() {
    vec2 p = vPos.xy;
    float r = length(p);
    float a = atan(p.y, p.x), a2 = atan(-p.y, -p.x);
    vec3 n0 = normalize(vec3(-uSlope * p / max(r, 1e-3), 1.0));
    vec3 tang = vec3(-p.y, p.x, 0.0) / max(r, 1e-3);
    // Major grooves, and fine hairlines between them
    vec2 G1 = groove(a / 6.2831853 * 300.0, a2 / 6.2831853 * 300.0, 0.09);
    vec2 G2 = groove(a / 6.2831853 * 1200.0, a2 / 6.2831853 * 1200.0, 0.07);
    // Concentric seams where the plates of the mechanism meet
    float lr = log(max(r - uR0 + 1.0, 1.0)) * 3.2;
    float fwr = max(fwidth(lr), 1e-4);
    float seam = 1.0 - smoothstep(0.02 - fwr, 0.02 + fwr, abs(fract(lr) - 0.5) - 0.48 + 0.02);
    // Plates: some grooves break and step at the seams
    float plate = floor(lr);
    float wob = noise(vec3(floor(a / 6.2831853 * 300.0) * 0.37, plate * 3.1, 1.0));
    float g1 = G1.x * step(0.12, wob);
    vec3 n = normalize(n0 + tang * (G1.y * g1 * 0.9 + G2.y * G2.x * 0.25));
    // Metal: dark charcoal bronze with grain and patina
    float grain = fbm(vec3(a * 40.0, r * 0.6, 2.0));
    float pat = fbm(vec3(p * 0.18, 5.0));
    vec3 base = mix(vec3(0.030, 0.026, 0.022), vec3(0.085, 0.062, 0.040), pat) * (0.75 + 0.5 * grain);
    vec3 V = normalize(uCam - vWorld);
    vec3 L = normalize(uKey - vWorld);
    vec3 H = normalize(L + V);
    float diff = max(dot(n, L), 0.0);
    float spec = pow(max(dot(n, H), 0.0), 34.0);
    // Anisotropic brushing along the grooves: a soft streak of light
    float aniso = pow(1.0 - abs(dot(normalize(H - n * dot(H, n)), tang)), 6.0) * 0.6;
    vec3 col = base * (0.25 + diff * 0.9) + vec3(0.42, 0.31, 0.2) * (spec * 0.45 + aniso * 0.06) * (1.0 - g1 * 0.85);
    col *= 1.0 - g1 * 0.55 - G2.x * 0.15 - seam * 0.5;
    col += vec3(0.5, 0.33, 0.16) * seam * 0.05 * diff;
    // Falloff away from the centre, and the warm glow of the medallion on the metal near it
    float fall = exp(-max(r - uR0, 0.0) * 0.085);
    col *= uLight * (0.25 + 0.75 * fall);
    col += vec3(0.8, 0.5, 0.22) * uGlow * exp(-max(r - uR0, 0.0) * 0.7) * (0.35 + 0.65 * (1.0 - g1)) * 0.22;
    // The mechanism turning as the circle opens: rings of light running outward
    float run = smoothstep(0.0, 1.0, uOpen) * pow(0.5 + 0.5 * sin(lr * 6.2831 - uTime * 9.0), 8.0) * fall;
    col += vec3(1.0, 0.7, 0.35) * run * 0.35 * (1.0 - g1);
    gl_FragColor = vec4(col, 1.0);
  }`;

// Smoke drifting through the light
const SMOKE_FRAG = `
  uniform float uTime, uAlpha, uSeed, uGlow;
  varying vec2 vUv; varying vec3 vPos; varying vec3 vWorld;
  ${NOISE_GLSL}
  void main() {
    vec2 q = vUv - 0.5;
    float edge = smoothstep(0.5, 0.18, length(q * vec2(1.0, 1.6)));
    vec3 s = vec3(vUv * vec2(2.4, 1.4) + vec2(uTime * 0.018 + uSeed, uTime * 0.006), uTime * 0.03 + uSeed * 7.0);
    float n = fbm3(s + fbm3(s * 1.7 + 4.0) * 0.8);
    float d = smoothstep(0.42, 0.85, n) * edge;
    vec3 col = mix(vec3(0.055, 0.048, 0.042), vec3(0.33, 0.24, 0.15), smoothstep(0.5, 0.95, n));
    col += vec3(0.5, 0.3, 0.12) * uGlow * smoothstep(0.6, 1.0, n) * 0.4;
    gl_FragColor = vec4(col, d * uAlpha);
  }`;

// God rays: soft shafts from above, and a halo behind the medallion
const RAYS_FRAG = `
  uniform float uTime, uAlpha, uHalo;
  varying vec2 vUv; varying vec3 vPos; varying vec3 vWorld;
  ${NOISE_GLSL}
  void main() {
    vec2 c = vUv - 0.5;
    float r = length(c), a = atan(c.y, c.x);
    float rays = pow(0.5 + 0.5 * sin(a * 22.0 + uTime * 0.05), 5.0) * 0.5 + pow(0.5 + 0.5 * sin(a * 9.0 - uTime * 0.04 + 1.3), 9.0) * 0.6;
    rays *= 0.6 + 0.6 * noise(vec3(a * 6.0, uTime * 0.1, 0.0));
    float fall = smoothstep(0.5, 0.06, r);
    float halo = exp(-pow((r - 0.075) * 26.0, 2.0)) * 0.6 + exp(-r * 14.0) * 0.5;
    // (drawn over everything: kept off the medallion's face, it glows round its edge)
    float off = smoothstep(0.07, 0.082, r);
    vec3 col = vec3(1.0, 0.68, 0.32) * (rays * fall * uAlpha * 0.025 + halo * uHalo * 0.16) * off;
    gl_FragColor = vec4(col, 1.0);
  }`;

// Golden dust
const DUST_VERT = `
  attribute float aSeed;
  uniform float uTime, uSize, uAlpha, uRush;
  varying float vA;
  void main() {
    vec3 p = position;
    float t = uTime * (0.08 + aSeed * 0.12) + aSeed * 60.0;
    p += vec3(sin(t * 1.3) * 0.6, mod(uTime * (0.05 + aSeed * 0.08) + aSeed * 9.0, 9.0) - 4.5, cos(t) * 0.5);
    // The circle opening: everything streams outward from the centre
    p.xy *= 1.0 + uRush * (0.5 + aSeed);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.35 + aSeed * aSeed * 1.6) * (300.0 / max(-mv.z, 0.5));
    vA = uAlpha * (0.45 + 0.55 * sin(uTime * (1.0 + aSeed * 2.0) + aSeed * 40.0)) * smoothstep(0.3, 2.0, -mv.z);
  }`;
const DUST_FRAG = `
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vec3(1.0, 0.76, 0.42) * a * a * max(vA, 0.0), 1.0);
  }`;

// The artwork: the smile, the mouth opening, the universe within
const ART_FRAG = `
  uniform sampler2D tClosed, tOpen, tMask;
  uniform float uTime, uReveal, uOpen, uVision, uSweep, uGlow, uLoaded;
  varying vec2 vUv; varying vec3 vPos; varying vec3 vWorld;
  ${NOISE_GLSL}
  const vec2 IMG = vec2(${IMG_W}.0, ${IMG_H}.0);
  const vec2 C = vec2(${ART_C[0]}.0, ${ART_C[1]}.0);
  const float RAD = ${ART_R}.0;
  const vec2 M = vec2(${MOUTH[0]}.0, ${MOUTH[1]}.0);
  vec2 toUv(vec2 p) { return vec2(p.x / IMG.x, 1.0 - p.y / IMG.y); }
  float sm(float t) { t = clamp(t, 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
  // The chin's lift in the closed picture (scripts/build-krishna-intro.py: JAW)
  float jaw(vec2 p) {
    float sx = clamp((p.x - 238.0) / 310.0, 0.0, 1.0);
    float bx = pow(abs(sin(3.14159265 * sx)), 1.5);
    return 24.0 * bx * sm((p.y - 468.0) / 88.0) * sm((700.0 - p.y) / 88.0);
  }
  // The universe: a golden heart, violet and indigo clouds, stars and a turning galaxy
  vec3 cosmos(vec2 p, float t) {
    vec3 q = vec3(p * 1.4, t * 0.05);
    float n = fbm(q + fbm(q * 1.7 + 3.0));
    float n2 = fbm(q * 2.6 - t * 0.04);
    vec3 col = mix(vec3(0.02, 0.012, 0.06), vec3(0.28, 0.1, 0.5), smoothstep(0.35, 0.8, n));
    col = mix(col, vec3(0.08, 0.28, 0.75), smoothstep(0.55, 0.9, n2) * 0.6);
    col += vec3(1.0, 0.7, 0.3) * pow(smoothstep(0.6, 0.95, n * n2 * 1.6), 2.0) * 1.6;
    for (int k = 0; k < 2; k++) {
      float sc = k == 0 ? 60.0 : 150.0;
      vec2 g = floor(p * sc), fr = fract(p * sc) - 0.5;
      float h = fract(sin(dot(g, vec2(12.9898, 78.233)) + float(k) * 3.1) * 43758.5453);
      float star = step(0.94, h) * smoothstep(0.22, 0.0, length(fr)) * (0.6 + 0.4 * sin(t * 2.0 + h * 40.0));
      col += vec3(0.95, 0.92, 1.0) * star * (k == 0 ? 2.6 : 1.2);
    }
    float r = length(p);
    float a = atan(p.y, p.x);
    float arms = pow(0.5 + 0.5 * sin(a * 2.0 - log(r + 0.03) * 5.0 + t * 0.5), 3.0) * smoothstep(0.9, 0.0, r);
    col += vec3(0.9, 0.75, 1.0) * arms * 0.7 + vec3(1.0, 0.86, 0.55) * smoothstep(0.2, 0.0, r) * 2.4;
    return col;
  }
  void main() {
    vec2 q = (vUv - 0.5) * 2.0;
    float r = length(q);
    vec2 p = C + vec2(q.x, -q.y) * RAD;
    // Closed, smiling; the chin easing down as the mouth opens
    vec3 closed = texture2D(tClosed, toUv(vec2(p.x, p.y - jaw(p) * uOpen))).rgb;
    vec3 open = texture2D(tOpen, toUv(p)).rgb;
    vec4 m = texture2D(tMask, toUv(p));
    float cy = mix(493.0, 514.0, sm(uOpen));
    vec2 rr = vec2(mix(52.0, 78.0, sm(uOpen)), max(0.5, 74.0 * uOpen));
    float e = length((p - vec2(M.x, cy)) / rr);
    float wipe = (1.0 - smoothstep(0.78, 1.0, e)) * step(0.002, uOpen);
    vec3 col = mix(closed, open, wipe);
    // Warm the picture into the bronze world, a little
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, lum * vec3(1.08, 0.93, 0.78), 0.12);
    // Inside the mouth: the universe, glowing
    vec2 cp = (p - M) / 120.0;
    vec3 uni = cosmos(cp, uTime);
    float inside = m.r * wipe;
    col = mix(col, col * 0.3 + uni * 0.85, inside * smoothstep(0.15, 0.7, uOpen));
    // A slow sheen of light across the glass-like face of the art, and the divine illumination
    float sweep = exp(-pow((q.x * 0.7 + q.y * 0.7 - uSweep) * 3.2, 2.0));
    col += vec3(1.0, 0.86, 0.6) * sweep * 0.07;
    col *= uReveal * mix(0.25, 1.0, uLoaded);
    // The vision: the universe opens out from His mouth until it is all there is
    float d = length(p - M) / 900.0;
    float R = uVision * 1.1;
    float vis = 1.0 - smoothstep(R - 0.06, R, d);
    float rim = exp(-pow((d - R) * 45.0, 2.0)) * step(0.001, uVision) * (1.0 - smoothstep(0.85, 1.0, uVision));
    col = mix(col, uni, vis);
    col += vec3(1.0, 0.78, 0.4) * rim * 0.8;
    // Light from the mouth spilling over the face
    col += vec3(1.0, 0.75, 0.38) * uGlow * exp(-length(p - M) / 70.0) * (1.0 - m.r * wipe * (1.0 - vis));
    // Shadow where the frame's lip overhangs the art
    col *= mix(0.45, 1.0, smoothstep(1.0, 0.86, r) * (1.0 - vis) + vis);
    // once it's all universe, its edge melts into the cosmos behind
    col *= mix(1.0, smoothstep(1.0, 0.7, r), vis);
    gl_FragColor = vec4(col, 1.0);
  }`;

// ── The medallion ───────────────────────────────────────────────────────────
export class Medallion {
  /** scene: where the lights go (stable light count for every program); envMap: a PMREM environment. */
  constructor({ scene, envMap, lite = false }) {
    this.group = new THREE.Group();
    this.scene = scene;
    const disposables = this.disposables = [];
    const keep = o => { disposables.push(o); return o; };
    const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3();

    // Materials: aged bronze; brighter worn gold for the beads and crests
    const pat = patinaCanvases(lite ? 256 : 512);
    const patCol = keep(new THREE.CanvasTexture(pat.col)), patRough = keep(new THREE.CanvasTexture(pat.rough));
    patCol.colorSpace = THREE.SRGBColorSpace;
    for (const t of [patCol, patRough]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 1); }
    const bronze = this.bronze = keep(new THREE.MeshPhysicalMaterial({
      color: 0xa8784a, map: patCol, roughnessMap: patRough, metalness: 1, roughness: 0.42,
      envMap, envMapIntensity: 0.4, clearcoat: 0.12, clearcoatRoughness: 0.5, side: THREE.DoubleSide,
    }));
    const gold = keep(new THREE.MeshPhysicalMaterial({ color: 0xb08a50, metalness: 1, roughness: 0.34, envMap, envMapIntensity: 0.5, side: THREE.DoubleSide }));
    const dark = keep(new THREE.MeshPhysicalMaterial({ color: 0x5a3a1c, metalness: 1, roughness: 0.55, envMap, envMapIntensity: 0.35, side: THREE.DoubleSide }));

    // Layer 1: the outer frame, lathed (a stepped, rounded bezel), with its fluted crown
    const lathe = (pts, segs) => {
      const g = keep(new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(r, z)), segs));
      g.rotateX(Math.PI / 2);
      return g;
    };
    const segs = lite ? 128 : 256;
    this.outer = new THREE.Group();
    const outerProf = [[3.62, -0.05], [3.6, 0.06], [3.54, 0.14], [3.48, 0.16], [3.44, 0.13], [3.38, 0.16], [3.3, 0.3], [3.2, 0.36], [3.1, 0.34], [3.04, 0.27], [3.0, 0.22], [2.98, 0.12]];
    // (lathe profiles run inner→outer for outward normals: reverse)
    this.outer.add(new THREE.Mesh(lathe(outerProf.slice().reverse(), segs), bronze));
    // Fluted crown: ribs lying across the bezel's rounded top
    const ribGeo = keep(new THREE.CapsuleGeometry(0.03, 0.2, 3, 8));
    const ribs = new THREE.InstancedMesh(ribGeo, gold, lite ? 120 : 180);
    for (let i = 0; i < ribs.count; i++) {
      const a = (i / ribs.count) * TAU;
      q4.setFromEuler(new THREE.Euler(0, 0, a - Math.PI / 2));
      const tilt = new THREE.Quaternion().setFromAxisAngle(v3.set(Math.cos(a + Math.PI / 2), Math.sin(a + Math.PI / 2), 0), 0.55);
      q4.premultiply(tilt);
      m4.compose(v3.set(Math.cos(a) * 3.39, Math.sin(a) * 3.39, 0.2), q4, s3.set(1, 1, 1));
      ribs.setMatrixAt(i, m4);
    }
    this.outer.add(ribs);
    // Embossed bosses round the inner slope of the frame
    const bossGeo = keep(new THREE.SphereGeometry(0.06, 14, 10));
    bossGeo.scale(1, 1, 0.55);
    const bosses = new THREE.InstancedMesh(bossGeo, gold, 72);
    for (let i = 0; i < 72; i++) {
      const a = ((i + 0.5) / 72) * TAU;
      m4.makeTranslation(Math.cos(a) * 3.1, Math.sin(a) * 3.1, 0.36);
      bosses.setMatrixAt(i, m4);
    }
    this.outer.add(bosses);
    // A dark channel between the frame and the engraved band
    this.outer.add(new THREE.Mesh(lathe([[2.98, 0.12], [2.97, 0.02], [2.95, 0.0]].reverse(), segs), dark));

    // Layer 2: the engraved band, slightly conical (its inner edge set back)
    const band = bandCanvases(lite ? 1536 : 2048);
    const bandCol = keep(new THREE.CanvasTexture(band.col)), bandH = keep(new THREE.CanvasTexture(band.height));
    bandCol.colorSpace = THREE.SRGBColorSpace;
    bandCol.anisotropy = bandH.anisotropy = 8;
    this.bandMat = keep(new THREE.MeshPhysicalMaterial({
      map: bandCol, bumpMap: bandH, bumpScale: 3.2, roughnessMap: bandH, roughness: 0.62, metalness: 1,
      envMap, envMapIntensity: 0.6, color: 0xffffff,
    }));
    // (roughnessMap reads G: raised work is brighter = rougher here; flip it so worn crests shine)
    this.bandMat.onBeforeCompile = sh => {
      sh.fragmentShader = sh.fragmentShader.replace("#include <roughnessmap_fragment>",
        `float roughnessFactor = roughness;
         #ifdef USE_ROUGHNESSMAP
           vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
           roughnessFactor *= mix(1.35, 0.55, texelRoughness.g);
         #endif`);
    };
    const bandGeo = keep(new THREE.RingGeometry(2.5, 2.97, segs, 4));
    polarUv(bandGeo, 2.5, 2.97);
    { const pos = bandGeo.attributes.position; for (let i = 0; i < pos.count; i++) { const r = Math.hypot(pos.getX(i), pos.getY(i)); pos.setZ(i, 0.02 + (r - 2.5) * 0.18); } bandGeo.computeVertexNormals(); }
    this.band = new THREE.Group();
    this.band.add(new THREE.Mesh(bandGeo, this.bandMat));

    // Layer 3: a twisted bronze rope, then 108 beads
    this.rope = new THREE.Group();
    const twistGeo = keep(new THREE.SphereGeometry(1, 10, 6));
    const twists = new THREE.InstancedMesh(twistGeo, bronze, lite ? 140 : 200);
    for (let i = 0; i < twists.count; i++) {
      const a = (i / twists.count) * TAU;
      q4.setFromEuler(new THREE.Euler(0, 0, a));
      q4.multiply(new THREE.Quaternion().setFromAxisAngle(v3.set(1, 0, 0), 0.8));
      m4.compose(v3.set(Math.cos(a) * 2.46, Math.sin(a) * 2.46, 0.06), q4, s3.set(0.035, 0.085, 0.035));
      twists.setMatrixAt(i, m4);
    }
    this.rope.add(twists);
    this.rope.add(new THREE.Mesh(lathe([[2.52, 0.03], [2.5, 0.0], [2.38, 0.0], [2.36, 0.03]].reverse(), segs), dark));
    const beadGeo = keep(new THREE.SphereGeometry(0.052, 14, 10));
    const beads = new THREE.InstancedMesh(beadGeo, gold, 108);
    for (let i = 0; i < 108; i++) {
      const a = (i / 108) * TAU;
      m4.makeTranslation(Math.cos(a) * 2.315, Math.sin(a) * 2.315, 0.05);
      beads.setMatrixAt(i, m4);
    }
    this.rope.add(beads);

    // Layer 4: the inner bronze lip, stepping down to the recessed artwork
    this.inner = new THREE.Group();
    this.inner.add(new THREE.Mesh(lathe([[2.26, 0.0], [2.25, 0.08], [2.21, 0.13], [2.16, 0.12], [2.12, 0.06], [2.1, -0.05], [2.09, -0.1]].reverse(), segs), bronze));

    // The artwork, recessed
    const black = keep(new THREE.DataTexture(new Uint8Array([10, 8, 12, 255]), 1, 1));
    black.needsUpdate = true;
    this.artUniforms = {
      tClosed: { value: black }, tOpen: { value: black }, tMask: { value: black },
      uTime: { value: 0 }, uReveal: { value: 0 }, uOpen: { value: 0 }, uVision: { value: 0 }, uSweep: { value: -2 }, uGlow: { value: 0 }, uLoaded: { value: 0 },
    };
    const loader = new THREE.TextureLoader();
    let loaded = 0;
    const load = (name, key, srgb) => keep(loader.load("/cinematic/" + name, t => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 8;
      this.artUniforms[key].value = t;
      if (++loaded === 3) this.artUniforms.uLoaded.value = 1;
    }));
    load("krishna_closed.webp", "tClosed", true);
    load("krishna_open.webp", "tOpen", true);
    load("krishna_mask.png", "tMask", false);
    this.artMat = keep(new THREE.ShaderMaterial({ uniforms: this.artUniforms, vertexShader: VERT, fragmentShader: ART_FRAG }));
    this.art = new THREE.Mesh(keep(new THREE.CircleGeometry(DISC_R + 0.02, 160)), this.artMat);
    this.art.position.z = -0.1;

    this.medal = new THREE.Group();
    this.medal.add(this.outer, this.band, this.rope, this.inner, this.art);
    this.layers = [this.inner, this.rope, this.band, this.outer];
    this.group.add(this.medal);

    // The mechanism round it: a shallow funnel of radial grooves out past the screen's edges
    this.funnelUniforms = {
      uTime: { value: 0 }, uLight: { value: 0 }, uGlow: { value: 0 }, uOpen: { value: 0 }, uSlope: { value: 0.34 }, uR0: { value: 3.55 },
      uKey: { value: new THREE.Vector3(-6, 9, 9) }, uCam: { value: new THREE.Vector3() },
    };
    const fGeo = keep(new THREE.RingGeometry(3.55, 80, 160, 60));
    { const pos = fGeo.attributes.position; for (let i = 0; i < pos.count; i++) { const r = Math.hypot(pos.getX(i), pos.getY(i)); pos.setZ(i, -0.04 + (r - 3.55) * 0.34); } }
    this.funnel = new THREE.Mesh(fGeo, keep(new THREE.ShaderMaterial({
      uniforms: this.funnelUniforms, vertexShader: VERT, fragmentShader: FUNNEL_FRAG,
    })));
    this.group.add(this.funnel);

    // Halo and god rays behind the medallion
    this.raysMat = keep(new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 }, uHalo: { value: 0 } },
      vertexShader: VERT, fragmentShader: RAYS_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    const rays = new THREE.Mesh(keep(new THREE.PlaneGeometry(48, 48)), this.raysMat);
    rays.position.z = 0.4;
    rays.renderOrder = 4;
    this.group.add(rays);
    this.rays = rays;

    // Smoke: slow banks drifting across the mechanism, a few in front of the medallion's foot
    this.smoke = [];
    const smokeGeo = keep(new THREE.PlaneGeometry(1, 1));
    const banks = lite ? [[-7, -4.5, 3, 18, 7], [7, -5, 4.5, 16, 6], [0, 6, 2, 22, 8], [-9, 3, 5, 14, 6]]
      : [[-7, -4.5, 3, 18, 7], [7, -5, 4.5, 16, 6], [0, 6, 2, 22, 8], [-9, 3, 5, 14, 6], [9, 2, 1.5, 15, 7], [2, -6.5, 6.5, 20, 6], [-3, -3, 8.5, 12, 5]];
    banks.forEach(([x, y, z, w, h], i) => {
      const mat = keep(new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 }, uSeed: { value: i * 1.73 }, uGlow: { value: 0 } },
        vertexShader: VERT, fragmentShader: SMOKE_FRAG, transparent: true, depthWrite: false,
      }));
      const s = new THREE.Mesh(smokeGeo, mat);
      s.position.set(x, y, z);
      s.scale.set(w, h, 1);
      s.userData.base = s.position.clone();
      s.renderOrder = 2;
      this.smoke.push(s);
      this.group.add(s);
    });

    // Golden dust
    const N = lite ? 1400 : 3600;
    const p = new Float32Array(N * 3), seed = new Float32Array(N);
    const rnd = seeded(3);
    for (let i = 0; i < N; i++) {
      p[i * 3] = (rnd() - 0.5) * 30; p[i * 3 + 1] = (rnd() - 0.5) * 18; p[i * 3 + 2] = -1 + rnd() * 16;
      seed[i] = rnd();
    }
    const dg = keep(new THREE.BufferGeometry());
    dg.setAttribute("position", new THREE.BufferAttribute(p, 3));
    dg.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    this.dustMat = keep(new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSize: { value: 0.05 }, uAlpha: { value: 0 }, uRush: { value: 0 } },
      vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.dust = new THREE.Points(dg, this.dustMat);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 3;
    this.group.add(this.dust);

    // Lights, in the scene itself so every program sees the same lights all intro long
    this.key = new THREE.DirectionalLight(0xffe6c8, 0);
    this.key.position.set(-5, 8, 9);
    this.rim = new THREE.PointLight(0xffc890, 0, 40, 1.4);   // circles the medallion: the reveal
    this.fill = new THREE.PointLight(0x8090ff, 0, 30, 1.5);
    this.fill.position.set(6, -4, 6);
    this.glowLight = new THREE.PointLight(0xffc070, 0, 12, 1.6);   // from the art / the mouth
    this.glowLight.position.set(MOUTH_LOCAL.x, MOUTH_LOCAL.y, 1.2);
    scene.add(this.key, this.key.target, this.rim, this.fill, this.glowLight);

    this._buildTimeline();
  }

  /** The shot's state, tweened by the timeline. cam: position, look target, fov, roll. */
  _buildTimeline() {
    const M = MEDALLION;
    const S = this.S = {
      light: 0, glow: 0, dust: 0, smoke: 0, rays: 0, halo: 0,
      form: 0, reveal: 0, sweep: -2.2, open: 0, vision: 0, mouthGlow: 0, part: 0, rush: 0, spin: 1,
      key: 0, rim: 0, fill: 0, rimA: -2.4,
      cx: 0, cy: -9.5, cz: 17, lx: 0, ly: -9.8, lz: 4, fov: 34, roll: 0.06,
    };
    const tl = this.tl = gsap.timeline({ paused: true, defaults: { ease: "power2.inOut" } });
    // STEP 1: out of darkness, the mechanism catches the light; dust; a faint glow at the centre
    tl.to(S, { light: 0.55, duration: 4.5, ease: "power1.inOut" }, 0.4)
      .to(S, { dust: 1, duration: 4, ease: "sine.inOut" }, 0.8)
      .to(S, { smoke: 1, duration: 5, ease: "sine.inOut" }, 0.5)
      .to(S, { glow: 0.35, halo: 0.4, duration: 3, ease: "sine.in" }, 1.6)
      // the camera starts low along the grooves and cranes up to the medallion
      .to(S, { cy: -2.6, cz: 25, ly: -0.2, lz: 0, roll: 0, duration: 7.4, ease: "power2.inOut" }, 0.6)
      .to(S, { cy: 0, cz: 26.5, ly: 0, duration: 3.2, ease: "sine.inOut" }, 8);
    // STEP 2: the medallion emerges through light and shadow; the rings turn and settle
    tl.to(S, { form: 1, duration: 4.2, ease: "power2.out" }, M.EMERGE)
      .to(S, { key: 1.3, fill: 0.35, duration: 4, ease: "sine.inOut" }, M.EMERGE)
      .fromTo(S, { rim: 0 }, { rim: 16, duration: 2.2, ease: "sine.out" }, M.EMERGE + 0.4)
      .to(S, { rimA: Math.PI * 1.15, duration: 7.5, ease: "power1.inOut" }, M.EMERGE + 0.4)
      .to(S, { rim: 6, duration: 3, ease: "sine.inOut" }, M.EMERGE + 4.5)
      .to(S, { light: 1, rays: 1, glow: 0.6, halo: 0.7, duration: 4, ease: "sine.inOut" }, M.EMERGE + 1.5)
      .to(S, { reveal: 1, duration: 3.5, ease: "sine.inOut" }, M.EMERGE + 3)
      .to(S, { sweep: 2.4, duration: 3.2, ease: "sine.inOut" }, M.EMERGE + 5.2);
    // STEP 3: the close-up; the rings lock into place
    tl.to(S, { cx: 0.04, cy: -0.25, cz: 8.4, lx: 0.03, ly: -0.2, lz: 0, fov: 36, duration: 5.6, ease: "power2.inOut" }, M.CLOSE)
      .to(S, { spin: 0, duration: 2.9, ease: "power3.out" }, M.CLOSE)
      .to(S, { rays: 0.7, halo: 1, duration: 4 }, M.CLOSE)
      .to(S, { sweep: -2.2, duration: 3.4, ease: "sine.inOut" }, M.LOCK + 0.2);
    // STEP 4: He opens His mouth: golden light, the universe within; the rings part
    tl.to(S, { open: 1, duration: 1.9, ease: "power2.inOut" }, M.OPEN)
      .to(S, { mouthGlow: 0.7, duration: 1.6, ease: "sine.in" }, M.OPEN + 0.5)
      .to(S, { cx: MOUTH_LOCAL.x, cy: MOUTH_LOCAL.y + 0.05, cz: 6.8, lx: MOUTH_LOCAL.x, ly: MOUTH_LOCAL.y, fov: 38, duration: 2.6, ease: "sine.inOut" }, M.OPEN)
      .to(S, { part: 1, duration: 4.6, ease: "power2.in" }, M.PART)
      .to(S, { spin: -6, duration: 4.6, ease: "power2.in" }, M.PART)
      .to(S, { rush: 1, duration: 4.4, ease: "power2.in" }, M.PART + 0.4)
      .to(S, { vision: 1, duration: 4.0, ease: "power1.in" }, M.PART + 0.6)
      .to(S, { light: 0, smoke: 0, rays: 0, halo: 0, key: 0, fill: 0, rim: 0, duration: 3.4, ease: "sine.in" }, M.PART + 1.2)
      // STEP 5: into the mouth, into the universe
      .to(S, { cz: 0.3, cy: MOUTH_LOCAL.y, fov: 72, duration: M.THROUGH - M.PART + 0.2, ease: "power2.in" }, M.PART)
      .to(S, { mouthGlow: 2.2, duration: 1.2, ease: "power2.in" }, M.THROUGH - 1.2);
    tl.time(0);
  }

  /** t: intro seconds. Applies the timeline, the mechanical rotation, and the camera. */
  update(t, camera) {
    this.tl.time(Math.min(t, this.tl.duration()));
    const S = this.S;
    const time = t;
    // The rings: heavy, ratcheting turns in alternate directions, easing to a lock
    const ratchet = (period, step, phase) => {
      const k = (time + phase) / period, i = Math.floor(k), f = k - i;
      const e = f < 0.5 ? 0 : (f - 0.5) * 2;   // still half the time, then a turn
      const ease = 1 - Math.pow(1 - e, 3) + Math.sin(e * Math.PI) * 0.06;  // a small overshoot as it seats
      return (i + ease) * step;
    };
    const s = S.spin, form = S.form;
    const settle = (1 - form) * 2.2;  // turns in from further round as it forms
    this.outer.rotation.z = ratchet(2.6, 0.07, 0) * Math.max(0, s) + settle * 0.5 + time * 0.01 * s;
    this.band.rotation.z = -ratchet(3.1, 0.11, 0.7) * Math.max(0, s) - settle * 0.8 - time * 0.4 * Math.min(0, s) * 0.1;
    this.rope.rotation.z = ratchet(2.2, 0.05, 1.3) * Math.max(0, s) + settle * 1.1;
    this.inner.rotation.z = -ratchet(3.6, 0.04, 0.2) * Math.max(0, s) - settle * 0.3;
    // As it opens they spin up and fly outward, each in turn
    const P = S.part;
    this.layers.forEach((g, i) => {
      const k = THREE.MathUtils.clamp(P * 1.35 - i * 0.12, 0, 1);
      const e = k * (2 - k) * k;
      g.scale.setScalar(1 + e * (2.6 + i * 1.3));
      g.position.z = e * (2.5 + i * 1.6);
      g.rotation.z += e * (i % 2 ? -1 : 1) * (0.8 + i * 0.3) + (s < 0 ? s * (time - MEDALLION.PART) * 0.05 * (i % 2 ? 1 : -1) : 0);
    });
    // Forming: from the dark, the layers rise into place from behind
    const fe = 1 - Math.pow(1 - form, 3);
    this.medal.position.z = -2.5 * (1 - fe);
    this.medal.visible = form > 0.001;
    this.bronze.envMapIntensity = 0.4 * fe;
    this.bandMat.envMapIntensity = 0.45 * fe;

    // Art
    const A = this.artUniforms;
    A.uTime.value = time;
    A.uReveal.value = S.reveal;
    A.uOpen.value = S.open;
    A.uVision.value = S.vision;
    A.uSweep.value = S.sweep;
    A.uGlow.value = S.mouthGlow * 0.12;
    this.art.scale.setScalar(1 + S.part * S.part * 1.6);

    // Lights
    this.key.intensity = S.key;
    this.rim.intensity = S.rim;
    this.rim.position.set(Math.cos(S.rimA) * 5.5, Math.sin(S.rimA) * 5.5, 2.2);
    this.fill.intensity = S.fill;
    this.glowLight.intensity = S.mouthGlow * 5 + S.reveal * 1.2;

    // Background, smoke, dust, rays
    const F = this.funnelUniforms;
    F.uTime.value = time;
    F.uLight.value = S.light;
    F.uGlow.value = S.glow + S.mouthGlow * 0.4;
    F.uOpen.value = S.part;
    F.uKey.value.set(Math.cos(S.rimA) * 7 - 4, Math.sin(S.rimA) * 7 + 6, 10);
    for (const sm of this.smoke) {
      const u = sm.material.uniforms;
      u.uTime.value = time;
      u.uAlpha.value = S.smoke * 0.85;
      u.uGlow.value = S.glow;
      sm.position.x = sm.userData.base.x + Math.sin(time * 0.05 + u.uSeed.value) * 1.2;
    }
    this.dustMat.uniforms.uTime.value = time;
    this.dustMat.uniforms.uAlpha.value = S.dust;
    this.dustMat.uniforms.uRush.value = S.rush * S.rush * 3;
    this.raysMat.uniforms.uTime.value = time;
    this.raysMat.uniforms.uAlpha.value = S.rays;
    this.raysMat.uniforms.uHalo.value = S.halo;

    // Camera: a slow handheld drift on top of the moves, gone as we dive in
    if (camera) {
      const drift = 1 - THREE.MathUtils.smoothstep(time, MEDALLION.OPEN, MEDALLION.PART);
      camera.position.set(S.cx + Math.sin(time * 0.31) * 0.12 * drift, S.cy + Math.sin(time * 0.23 + 1) * 0.08 * drift, S.cz);
      camera.up.set(0, 1, 0);
      camera.lookAt(S.lx, S.ly, S.lz);
      camera.rotateZ(S.roll);
      camera.fov = S.fov;
      camera.updateProjectionMatrix();
      F.uCam.value.copy(camera.position);
    }
  }

  /** Lights out (when the shot is over: the lights stay in the scene at 0). */
  dim() {
    this.key.intensity = this.rim.intensity = this.fill.intensity = this.glowLight.intensity = 0;
  }

  dispose() {
    this.tl.kill();
    this.scene.remove(this.key, this.key.target, this.rim, this.fill, this.glowLight);
    for (const d of this.disposables) d.dispose?.();
    this.disposables.length = 0;
  }
}
