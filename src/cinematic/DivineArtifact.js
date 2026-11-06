import * as THREE from "three";

// Scene 01-02: the divine artifact and the cosmic vision within it.
//
// A circular artifact of old gold: an ornate lathed rim, an engraved mandala
// band (lotus petals, paisleys, beads: drawn once on a canvas, then used as the
// colour, roughness and glow of a metallic ring), 108 beads like a japa mala,
// sixteen lotus petals, and a slow orbit of golden motes. Inside it, a
// devotional image of Lord Krishna: serene, dignified, in the traditional
// iconography (blue complexion, peacock-feather crown, yellow pitambara,
// makara kundala, vaijayanti mala, a bansuri) as a graceful profile in an
// aura. If public/cinematic/krishna.webp exists (commissioned or properly
// licensed artwork), it's shown instead of the drawn image.
//
// The vision (uVision 0..1): the universe appears *within* the divine form:
// stars and nebulae fill the figure from the heart outward, then the whole
// disc, before the camera passes through into it. The figure is never
// distorted: the cosmos is revealed inside it, with reverence.

const TAU = Math.PI * 2;

// ── The engraved mandala band ───────────────────────────────────────────────
function mandalaCanvas(size = 2048) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const C = size / 2;
  g.translate(C, C);
  const R0 = size * 0.36, R1 = size * 0.5;   // the band's inner / outer radius (matches the ring UVs)
  // Base metal with fine radial brushing
  const base = g.createRadialGradient(0, 0, R0, 0, 0, R1);
  base.addColorStop(0, "#6b4a12"); base.addColorStop(0.5, "#c8962e"); base.addColorStop(1, "#7a5414");
  g.fillStyle = base;
  g.beginPath(); g.arc(0, 0, R1, 0, TAU); g.arc(0, 0, R0, 0, TAU, true); g.fill();
  g.globalAlpha = 0.08;
  for (let i = 0; i < 1400; i++) {
    const a = Math.random() * TAU;
    g.strokeStyle = Math.random() < 0.5 ? "#fff3c8" : "#3a2405";
    g.beginPath(); g.moveTo(Math.cos(a) * R0, Math.sin(a) * R0); g.lineTo(Math.cos(a) * R1, Math.sin(a) * R1); g.stroke();
  }
  g.globalAlpha = 1;
  const ring = (r, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke(); };
  // Border rings
  for (const [r, w] of [[R0 + 6, 5], [R0 + 18, 2], [R1 - 8, 6], [R1 - 22, 2]]) ring(r, w, "#ffe7a3");
  // Lotus petals round the inner edge
  const petals = 32, pr = R0 + 22;
  for (let i = 0; i < petals; i++) {
    g.save();
    g.rotate((i / petals) * TAU);
    g.beginPath();
    g.moveTo(pr, 0);
    g.quadraticCurveTo(pr + 70, -34, pr + 120, 0);
    g.quadraticCurveTo(pr + 70, 34, pr, 0);
    g.fillStyle = "#e9b949"; g.fill();
    g.strokeStyle = "#5a3a0a"; g.lineWidth = 3; g.stroke();
    g.beginPath(); g.moveTo(pr + 12, 0); g.lineTo(pr + 100, 0); g.strokeStyle = "#fff0bf"; g.lineWidth = 2; g.stroke();
    g.restore();
  }
  // Paisleys (keri) and beads in the middle course
  const kr = (R0 + R1) / 2 + 36, n = 24;
  for (let i = 0; i < n; i++) {
    g.save();
    g.rotate((i / n) * TAU + 0.06);
    g.translate(kr, 0);
    g.rotate(Math.PI / 2);
    g.beginPath();
    g.moveTo(0, 26);
    g.bezierCurveTo(-30, 10, -26, -30, 4, -34);
    g.bezierCurveTo(22, -36, 30, -12, 12, -6);
    g.bezierCurveTo(26, 8, 14, 26, 0, 26);
    g.fillStyle = "#f4cf6a"; g.fill();
    g.strokeStyle = "#4a2f08"; g.lineWidth = 3; g.stroke();
    g.beginPath(); g.arc(2, -16, 7, 0, TAU); g.fillStyle = "#1e5bb0"; g.fill();
    g.restore();
    g.save();
    g.rotate(((i + 0.5) / n) * TAU);
    g.beginPath(); g.arc(kr, 0, 9, 0, TAU); g.fillStyle = "#fff4cf"; g.fill();
    g.restore();
  }
  // Fine dots round the outer course
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * TAU;
    g.beginPath(); g.arc(Math.cos(a) * (R1 - 15), Math.sin(a) * (R1 - 15), 3.2, 0, TAU); g.fillStyle = "#fff2c4"; g.fill();
  }
  return c;
}

// ── The devotional image ────────────────────────────────────────────────────
/**
 * Lord Krishna as a serene profile (facing right), drawn with care: the aura,
 * the hair and crown with its peacock feather, a calm closed-eye expression,
 * the pitambara over the shoulders, the garland, and a bansuri across the
 * bottom of the circle. Returns { art, mask } canvases: the full image, and
 * the figure alone (alpha) where the universe will appear.
 */
function divineCanvases(size = 1024) {
  const art = document.createElement("canvas");
  art.width = art.height = size;
  const g = art.getContext("2d");
  const S = size / 1024;
  g.scale(S, S);
  // Background: deep indigo night with a golden-blue aura behind the head
  const bg = g.createRadialGradient(512, 512, 0, 512, 512, 520);
  bg.addColorStop(0, "#1b2a6b"); bg.addColorStop(0.55, "#0c1440"); bg.addColorStop(1, "#04061a");
  g.fillStyle = bg; g.fillRect(0, 0, 1024, 1024);
  const aura = g.createRadialGradient(520, 520, 40, 520, 520, 380);
  aura.addColorStop(0, "rgba(255,226,140,0.7)"); aura.addColorStop(0.35, "rgba(255,190,80,0.32)");
  aura.addColorStop(0.62, "rgba(90,150,255,0.28)"); aura.addColorStop(1, "rgba(40,60,160,0)");
  g.fillStyle = aura; g.beginPath(); g.arc(520, 520, 380, 0, TAU); g.fill();
  // Fine rays of the halo
  g.save(); g.translate(520, 520);
  for (let i = 0; i < 72; i++) {
    g.rotate(TAU / 72);
    g.fillStyle = i % 2 ? "rgba(255,230,160,0.10)" : "rgba(255,240,190,0.18)";
    g.beginPath(); g.moveTo(150, -3); g.lineTo(330, -1); g.lineTo(330, 1); g.lineTo(150, 3); g.fill();
  }
  g.restore();
  // A halo ring
  g.strokeStyle = "rgba(255,226,150,0.9)"; g.lineWidth = 4;
  g.beginPath(); g.arc(520, 520, 210, 0, TAU); g.stroke();
  g.strokeStyle = "rgba(255,226,150,0.35)"; g.lineWidth = 2;
  g.beginPath(); g.arc(520, 520, 228, 0, TAU); g.stroke();

  const figure = new Path2D();
  // Shoulders and chest
  figure.moveTo(250, 1024);
  figure.bezierCurveTo(262, 900, 330, 820, 432, 790);
  figure.lineTo(470, 752);                                  // back of the neck
  figure.bezierCurveTo(470, 720, 462, 690, 452, 660);       // nape
  // back of the head (under the hair)
  figure.bezierCurveTo(420, 610, 418, 520, 452, 482);
  figure.lineTo(588, 476);                                  // brow line under the crown
  // forehead, brow, nose, lips, chin
  figure.bezierCurveTo(600, 492, 604, 516, 600, 532);
  figure.bezierCurveTo(606, 544, 616, 560, 626, 578);       // nose bridge to tip
  figure.bezierCurveTo(628, 586, 620, 592, 610, 594);       // under the nose
  figure.bezierCurveTo(614, 600, 616, 606, 610, 612);       // upper lip
  figure.bezierCurveTo(614, 618, 614, 624, 606, 630);       // lower lip
  figure.bezierCurveTo(608, 646, 600, 660, 584, 666);       // chin
  figure.bezierCurveTo(570, 672, 560, 690, 560, 712);       // jaw to throat
  figure.bezierCurveTo(564, 740, 580, 770, 640, 800);       // front of the neck to the chest
  figure.bezierCurveTo(720, 840, 770, 920, 790, 1024);
  figure.closePath();

  // Skin: the traditional blue, lit from the aura behind (rim light)
  g.save();
  const skin = g.createLinearGradient(430, 470, 640, 900);
  skin.addColorStop(0, "#3f6fd8"); skin.addColorStop(0.5, "#2b4fb5"); skin.addColorStop(1, "#1a3488");
  g.shadowColor = "rgba(255,214,120,0.95)"; g.shadowBlur = 26;
  g.fillStyle = skin; g.fill(figure);
  g.restore();
  g.save(); g.clip(figure);
  const sheen = g.createLinearGradient(640, 500, 520, 560);
  sheen.addColorStop(0, "rgba(160,200,255,0.55)"); sheen.addColorStop(1, "rgba(160,200,255,0)");
  g.fillStyle = sheen; g.fillRect(400, 460, 260, 260);
  g.restore();

  // Hair falling behind the neck, in soft dark-blue locks
  g.save();
  g.strokeStyle = "#0b1238"; g.lineCap = "round";
  for (let i = 0; i < 9; i++) {
    g.lineWidth = 14 - i;
    g.beginPath();
    g.moveTo(448 + i * 3, 520 + i * 6);
    g.bezierCurveTo(400 - i * 4, 600 + i * 8, 440, 690, 392 - i * 6, 790 + i * 10);
    g.stroke();
  }
  g.restore();

  // The eye: closed in peace, a long lotus-petal line, and the brow above
  g.strokeStyle = "#0a1236"; g.lineCap = "round";
  g.lineWidth = 4; g.beginPath(); g.moveTo(566, 552); g.quadraticCurveTo(584, 562, 600, 552); g.stroke();
  g.lineWidth = 2; g.beginPath(); g.moveTo(600, 552); g.lineTo(608, 548); g.stroke();
  for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(572 + i * 6, 558); g.lineTo(570 + i * 6, 565); g.lineWidth = 1.4; g.stroke(); }
  g.lineWidth = 4; g.beginPath(); g.moveTo(560, 530); g.quadraticCurveTo(584, 518, 604, 528); g.stroke();
  // Tilak on the brow
  g.strokeStyle = "#ffe7a0"; g.lineWidth = 3;
  g.beginPath(); g.moveTo(598, 500); g.lineTo(600, 524); g.stroke();
  g.fillStyle = "#e0353d"; g.beginPath(); g.arc(600, 526, 3, 0, TAU); g.fill();
  // A gentle smile line
  g.strokeStyle = "rgba(10,18,54,0.7)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(598, 622); g.quadraticCurveTo(604, 625, 609, 621); g.stroke();

  // Crown (mukut): tiers of gold with jewels
  const crown = new Path2D();
  crown.moveTo(446, 486);
  crown.lineTo(594, 480);
  crown.lineTo(586, 440);
  crown.bezierCurveTo(580, 400, 560, 370, 536, 340);
  crown.lineTo(522, 300);
  crown.lineTo(508, 340);
  crown.bezierCurveTo(480, 372, 458, 410, 450, 446);
  crown.closePath();
  const gold = g.createLinearGradient(440, 300, 600, 490);
  gold.addColorStop(0, "#fff1b0"); gold.addColorStop(0.4, "#e8b23c"); gold.addColorStop(0.75, "#b17914"); gold.addColorStop(1, "#ffe08a");
  g.save(); g.shadowColor = "rgba(255,210,110,0.9)"; g.shadowBlur = 18;
  g.fillStyle = gold; g.fill(crown); g.restore();
  g.strokeStyle = "#6a4308"; g.lineWidth = 2.5; g.stroke(crown);
  for (const [y, w] of [[470, 140], [440, 120], [404, 92], [372, 60]]) {
    g.strokeStyle = "#fff4c8"; g.lineWidth = 2; g.beginPath(); g.moveTo(520 - w / 2, y); g.lineTo(520 + w / 2, y - 3); g.stroke();
  }
  for (const [x, y, c] of [[520, 455, "#d9263c"], [492, 424, "#1f8f6a"], [548, 424, "#1f8f6a"], [520, 392, "#d9263c"], [520, 338, "#ffffff"]]) {
    g.fillStyle = c; g.beginPath(); g.arc(x, y, 6, 0, TAU); g.fill();
    g.strokeStyle = "#fff4c8"; g.lineWidth = 1.5; g.stroke();
  }

  // The peacock feather, rising from the back of the crown
  g.save();
  g.translate(470, 380);
  g.rotate(-0.55);
  // Barbs
  for (let i = 0; i < 70; i++) {
    const t = i / 70, y = -t * 240;
    const w = 26 + 34 * Math.sin(Math.PI * Math.min(1, t * 1.15));
    g.strokeStyle = `rgba(${60 + t * 80},${150 + t * 60},${90 + t * 40},0.55)`;
    g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(0, y); g.quadraticCurveTo(-w * 0.6, y - 10, -w, y - 26); g.stroke();
    g.beginPath(); g.moveTo(0, y); g.quadraticCurveTo(w * 0.6, y - 10, w, y - 26); g.stroke();
  }
  g.strokeStyle = "#d7c27a"; g.lineWidth = 3; g.beginPath(); g.moveTo(0, 30); g.lineTo(0, -250); g.stroke();
  // The eye of the feather
  const eye = [[34, 46, "#2a8f5a"], [26, 36, "#d8b23a"], [19, 27, "#1fa6a0"], [12, 18, "#123c9c"], [6, 9, "#08123a"]];
  for (const [rx, ry, col] of eye) { g.fillStyle = col; g.beginPath(); g.ellipse(0, -232, rx, ry, 0, 0, TAU); g.fill(); }
  g.restore();

  // Makara kundala: the ear ornament
  g.fillStyle = "#f2c14e"; g.beginPath(); g.arc(478, 594, 13, 0, TAU); g.fill();
  g.strokeStyle = "#7a4c0a"; g.lineWidth = 2; g.stroke();
  g.fillStyle = "#d9263c"; g.beginPath(); g.arc(478, 594, 5, 0, TAU); g.fill();
  g.strokeStyle = "#f2c14e"; g.lineWidth = 3; g.beginPath(); g.moveTo(478, 607); g.quadraticCurveTo(470, 630, 482, 642); g.stroke();

  // Pitambara: yellow silk over the shoulders, with a gold border
  const silk = new Path2D();
  silk.moveTo(262, 1024);
  silk.bezierCurveTo(270, 930, 330, 850, 430, 812);
  silk.bezierCurveTo(500, 860, 600, 880, 700, 860);
  silk.bezierCurveTo(740, 900, 770, 960, 782, 1024);
  silk.closePath();
  const yel = g.createLinearGradient(300, 820, 760, 1024);
  yel.addColorStop(0, "#ffd84a"); yel.addColorStop(0.5, "#f2b51d"); yel.addColorStop(1, "#d48a0c");
  g.fillStyle = yel; g.fill(silk);
  g.strokeStyle = "#b8251f"; g.lineWidth = 7; g.stroke(silk);
  g.strokeStyle = "#ffe9a0"; g.lineWidth = 2.5; g.stroke(silk);
  // Folds
  g.strokeStyle = "rgba(160,90,6,0.45)"; g.lineWidth = 3;
  for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(360 + i * 80, 860 + i * 6); g.quadraticCurveTo(380 + i * 80, 940, 350 + i * 85, 1024); g.stroke(); }

  // Vaijayanti mala: the garland of flowers
  for (let i = 0; i <= 22; i++) {
    const t = i / 22;
    const x = 440 + t * 260, y = 820 + Math.sin(t * Math.PI) * 120;
    g.fillStyle = ["#ffffff", "#e8343e", "#ffd34a", "#f28a2b"][i % 4];
    g.beginPath(); g.arc(x, y, 9, 0, TAU); g.fill();
  }

  // The bansuri across the bottom of the circle
  g.save();
  g.translate(512, 930);
  g.rotate(-0.06);
  const fl = g.createLinearGradient(0, -10, 0, 10);
  fl.addColorStop(0, "#f6e2a6"); fl.addColorStop(1, "#a9822f");
  g.fillStyle = fl;
  g.fillRect(-300, -9, 600, 18);
  g.fillStyle = "#b8251f";
  for (const x of [-270, -250, 250, 270]) g.fillRect(x, -10, 8, 20);
  g.fillStyle = "#3a2405";
  for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(-120 + i * 40, 0, 4.5, 0, TAU); g.fill(); }
  g.restore();

  // The mask: the figure, crown and feather, where the universe will appear
  const mask = document.createElement("canvas");
  mask.width = mask.height = 512;
  const m = mask.getContext("2d");
  m.scale(0.5, 0.5);
  m.fillStyle = "#fff";
  m.fill(figure);
  m.fill(crown);
  // Soften its edge: blur a copy back over it (untransformed)
  const sharp = document.createElement("canvas");
  sharp.width = sharp.height = 512;
  sharp.getContext("2d").drawImage(mask, 0, 0);
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, 512, 512);
  m.filter = "blur(4px)";
  m.drawImage(sharp, 0, 0);
  return { art, mask };
}

// ── Shaders ─────────────────────────────────────────────────────────────────
export const NOISE_GLSL = `
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
`;

const DISC_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const DISC_FRAG = `
  uniform sampler2D tArt, tMask;
  uniform float uTime, uVision, uReveal, uGlow;
  varying vec2 vUv;
  ${NOISE_GLSL}
  // A miniature universe: violet-blue nebula, golden filaments and stars
  vec3 cosmos(vec2 p, float t) {
    vec3 q = vec3(p * 2.2, t * 0.05);
    float n = fbm(q + fbm(q * 1.7 + 3.0));
    float n2 = fbm(q * 3.1 - t * 0.03);
    vec3 col = mix(vec3(0.03, 0.02, 0.12), vec3(0.24, 0.12, 0.62), smoothstep(0.35, 0.8, n));
    col = mix(col, vec3(0.1, 0.45, 0.95), smoothstep(0.55, 0.9, n2) * 0.7);
    col += vec3(1.0, 0.75, 0.35) * pow(smoothstep(0.62, 0.95, n * n2 * 1.6), 2.0) * 1.4;
    // Stars
    vec2 g = floor(p * 90.0), fr = fract(p * 90.0) - 0.5;
    float h = fract(sin(dot(g, vec2(12.9898, 78.233))) * 43758.5453);
    float star = step(0.93, h) * smoothstep(0.18, 0.0, length(fr)) * (0.6 + 0.4 * sin(t * 2.0 + h * 40.0));
    col += vec3(0.9, 0.95, 1.0) * star * 2.0;
    // A galaxy's bright core turning at the heart of it
    float r = length(p - vec2(0.02, -0.05));
    float a = atan(p.y + 0.05, p.x - 0.02);
    float arms = pow(0.5 + 0.5 * sin(a * 2.0 - log(r + 0.02) * 6.0 + t * 0.4), 3.0) * smoothstep(0.6, 0.0, r);
    col += vec3(0.85, 0.75, 1.0) * arms * 0.8 + vec3(1.0, 0.85, 0.55) * smoothstep(0.12, 0.0, r) * 2.0;
    return col;
  }
  void main() {
    vec2 c = vUv - 0.5;
    float r = length(c) * 2.0;
    if (r > 1.0) discard;
    vec3 art = texture2D(tArt, vUv).rgb;
    float m = texture2D(tMask, vUv).r;
    vec3 uni = cosmos(c * 2.0, uTime);
    // The universe opens inside the form, from the heart outward, then fills the circle
    float heart = length(c - vec2(0.03, -0.1));
    float R = uVision * 0.95;
    float inside = (1.0 - smoothstep(R - 0.1, R, heart)) * m * step(0.001, uVision);
    float whole = smoothstep(0.65, 1.0, uVision);
    vec3 form = mix(art, uni * 1.3 + vec3(0.25, 0.35, 0.9) * 0.12, inside);
    // The outline of the form stays, glowing gold, while the cosmos fills it
    float edge = m * (1.0 - m) * 4.0;
    form += vec3(1.0, 0.8, 0.4) * edge * inside * 0.9;
    vec3 col = mix(form, uni * 1.5, whole);
    col *= uReveal * 0.72;
    col += vec3(1.0, 0.85, 0.55) * uGlow * 1.6 * smoothstep(1.0, 0.0, r);
    // Soft vignette into the rim
    col *= smoothstep(1.0, 0.92, r) * 0.25 + 0.75;
    gl_FragColor = vec4(col, 1.0);
  }`;

const RAYS_FRAG = `
  uniform float uTime, uAlpha;
  varying vec2 vUv;
  void main() {
    vec2 c = vUv - 0.5;
    float r = length(c), a = atan(c.y, c.x);
    float rays = pow(0.5 + 0.5 * sin(a * 18.0 + uTime * 0.15), 6.0) * 0.6 + pow(0.5 + 0.5 * sin(a * 7.0 - uTime * 0.1), 8.0) * 0.5;
    float fall = smoothstep(0.5, 0.08, r);
    vec3 col = mix(vec3(1.0, 0.72, 0.3), vec3(0.35, 0.55, 1.0), smoothstep(0.1, 0.45, r));
    gl_FragColor = vec4(col * rays * fall * uAlpha * 0.09, 1.0);
  }`;

const MOTE_VERT = `
  attribute float aSeed;
  uniform float uTime, uSize, uAlpha;
  varying float vA;
  void main() {
    vec3 p = position;
    float t = uTime * (0.15 + aSeed * 0.2) + aSeed * 50.0;
    p += vec3(sin(t), cos(t * 0.8), sin(t * 0.6)) * 0.15;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.5 + aSeed) * (300.0 / -mv.z);
    vA = uAlpha * (0.5 + 0.5 * sin(uTime * 2.0 + aSeed * 30.0));
  }`;
const MOTE_FRAG = `
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vec3(1.0, 0.8, 0.45) * a * vA * 0.75, 1.0);
  }`;

export class DivineArtifact {
  constructor({ envMap, lite = false }) {
    this.group = new THREE.Group();
    const disposables = this.disposables = [];
    const keep = o => { disposables.push(o); return o; };

    // Rim: an ornate profile turned on a lathe (beads, a raised band, a lip)
    const prof = [];
    const R = 3.0;
    const pts = [[-0.32, -0.02], [-0.3, 0.06], [-0.22, 0.12], [-0.16, 0.1], [-0.1, 0.16], [0, 0.2], [0.1, 0.16], [0.16, 0.1], [0.22, 0.12], [0.3, 0.06], [0.32, -0.02]];
    for (const [dx, dz] of pts) prof.push(new THREE.Vector2(R + dx, dz));
    const rimGeo = keep(new THREE.LatheGeometry(prof, lite ? 96 : 192));
    rimGeo.rotateX(Math.PI / 2);
    const goldMat = keep(new THREE.MeshStandardMaterial({ color: 0xd8a640, metalness: 1, roughness: 0.26, envMap, envMapIntensity: 1.3 }));
    const rim = new THREE.Mesh(rimGeo, goldMat);
    this.group.add(rim);
    const inner = new THREE.Mesh(keep(new THREE.TorusGeometry(2.36, 0.07, 16, lite ? 96 : 192)), goldMat);
    this.group.add(inner);

    // The engraved band (canvas: colour, glow; brighter in the raised motifs)
    const mc = mandalaCanvas(lite ? 1024 : 2048);
    const tex = keep(new THREE.CanvasTexture(mc));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const bandGeo = keep(new THREE.RingGeometry(2.36, 3.28, lite ? 96 : 192, 1));
    // Ring UVs → the canvas's polar layout (inner radius 0.36, outer 0.5 of the canvas)
    const uv = bandGeo.attributes.uv, pos = bandGeo.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), r = Math.hypot(x, y), a = Math.atan2(y, x);
      const k = 0.36 + ((r - 2.36) / (3.28 - 2.36)) * 0.14;
      uv.setXY(i, 0.5 + Math.cos(a) * k, 0.5 + Math.sin(a) * k);
    }
    this.bandMat = keep(new THREE.MeshStandardMaterial({ map: tex, metalness: 0.9, roughness: 0.32, envMap, envMapIntensity: 1.1, emissive: 0xffc860, emissiveMap: tex, emissiveIntensity: 0 }));
    this.bandUniforms = { uSweep: { value: -1 } };
    this.bandMat.onBeforeCompile = sh => {
      sh.uniforms.uSweep = this.bandUniforms.uSweep;
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vLocal;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvLocal = position;");
      // A slow highlight sweeping round the engravings
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vLocal;\nuniform float uSweep;")
        .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
          float ang = atan(vLocal.y, vLocal.x) / 6.2831853 + 0.5;
          float sweep = smoothstep(0.08, 0.0, abs(fract(ang - uSweep) - 0.5) - 0.42);
          totalEmissiveRadiance *= 0.35 + sweep * 2.2;`);
    };
    const band = new THREE.Mesh(bandGeo, this.bandMat);
    band.position.z = 0.02;
    this.group.add(band);

    // 108 beads, like a japa mala, round the inside
    const bead = keep(new THREE.SphereGeometry(0.055, 12, 8));
    const beads = new THREE.InstancedMesh(bead, goldMat, 108);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 108; i++) {
      const a = (i / 108) * TAU;
      m.makeTranslation(Math.cos(a) * 2.27, Math.sin(a) * 2.27, 0.06);
      beads.setMatrixAt(i, m);
    }
    this.group.add(beads);

    // Sixteen lotus petals round the outside, extruded
    const petal = new THREE.Shape();
    petal.moveTo(0, 0);
    petal.quadraticCurveTo(0.22, 0.32, 0, 0.62);
    petal.quadraticCurveTo(-0.22, 0.32, 0, 0);
    const petalGeo = keep(new THREE.ExtrudeGeometry(petal, { depth: 0.05, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2, curveSegments: 10 }));
    const petals = new THREE.InstancedMesh(petalGeo, goldMat, 16);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      m.makeRotationZ(a - Math.PI / 2).setPosition(Math.cos(a) * 3.25, Math.sin(a) * 3.25, -0.05);
      petals.setMatrixAt(i, m);
    }
    this.group.add(petals);

    // The inner disc: the devotional image, and the universe within it
    const { art, mask } = divineCanvases(lite ? 1024 : 1024);
    this.artTex = keep(new THREE.CanvasTexture(art));
    this.artTex.colorSpace = THREE.SRGBColorSpace;
    this.maskTex = keep(new THREE.CanvasTexture(mask));
    // Artwork supplied by the developer (commissioned / licensed) replaces the drawn image
    new THREE.TextureLoader().load("/cinematic/krishna.webp", t => {
      t.colorSpace = THREE.SRGBColorSpace;
      this.discMat.uniforms.tArt.value = t;
      keep(t);
    }, undefined, () => { /* not there: the drawn image stays */ });
    this.discMat = keep(new THREE.ShaderMaterial({
      uniforms: { tArt: { value: this.artTex }, tMask: { value: this.maskTex }, uTime: { value: 0 }, uVision: { value: 0 }, uReveal: { value: 0 }, uGlow: { value: 0 } },
      vertexShader: DISC_VERT, fragmentShader: DISC_FRAG,
    }));
    this.disc = new THREE.Mesh(keep(new THREE.CircleGeometry(2.3, 128)), this.discMat);
    this.disc.position.z = 0.01;
    this.group.add(this.disc);

    // God rays behind it
    this.raysMat = keep(new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 } },
      vertexShader: DISC_VERT, fragmentShader: RAYS_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const rays = new THREE.Mesh(keep(new THREE.PlaneGeometry(26, 26)), this.raysMat);
    rays.position.z = -1.5;
    this.group.add(rays);

    // Golden motes orbiting it
    const N = lite ? 900 : 2400;
    const p = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = Math.random() * TAU, r = 3.6 + Math.random() * 1.8 * Math.random();
      p[i * 3] = Math.cos(a) * r; p[i * 3 + 1] = Math.sin(a) * r; p[i * 3 + 2] = (Math.random() - 0.5) * 0.8;
      seed[i] = Math.random();
    }
    const mg = keep(new THREE.BufferGeometry());
    mg.setAttribute("position", new THREE.BufferAttribute(p, 3));
    mg.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    this.moteMat = keep(new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSize: { value: 0.09 }, uAlpha: { value: 0 } },
      vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.motes = new THREE.Points(mg, this.moteMat);
    this.group.add(this.motes);

    // A warm key light and a cool fill so the gold reads
    this.key = new THREE.PointLight(0xffd59a, 0, 30, 1.2);
    this.key.position.set(3, 4, 6);
    this.fill = new THREE.PointLight(0x6f8cff, 0, 30, 1.2);
    this.fill.position.set(-5, -3, 4);
    this.group.add(this.key, this.fill);
    this.rim = rim;
    this.parts = [rim, inner, band, beads, petals];
  }

  /**
   * t: seconds since the intro began. form 0..1 (the artifact assembling),
   * reveal 0..1 (the image appearing), vision 0..1 (the universe within),
   * glow 0..1 (light flooding out as the camera passes through).
   */
  update(t, { form, reveal, vision, glow }) {
    const e = 1 - Math.pow(1 - form, 3);
    this.group.rotation.z = (1 - e) * 1.4 + t * 0.012;
    this.rim.scale.setScalar(0.6 + 0.4 * e);
    for (const p of this.parts) p.visible = form > 0.001;
    this.key.intensity = 16 * e;
    this.fill.intensity = 7 * e;
    this.bandMat.emissiveIntensity = 0.06 + 0.18 * reveal;
    this.bandUniforms.uSweep.value = t * 0.06;
    this.discMat.uniforms.uTime.value = t;
    this.discMat.uniforms.uReveal.value = reveal;
    this.discMat.uniforms.uVision.value = vision;
    this.discMat.uniforms.uGlow.value = glow;
    this.raysMat.uniforms.uTime.value = t;
    this.raysMat.uniforms.uAlpha.value = Math.min(1, form * 1.2) * (0.5 + 0.5 * reveal) + glow * 3;
    this.moteMat.uniforms.uTime.value = t;
    this.moteMat.uniforms.uAlpha.value = Math.min(1, t / 4);
    this.motes.rotation.z = -t * 0.03;
  }

  dispose() {
    for (const d of this.disposables) d.dispose?.();
    this.disposables.length = 0;
  }
}
