// The college campus round the cricket ground, traced from a north-up satellite
// view of the real campus (left as pixel coordinates so it can be re-checked
// against the picture). Pure data and geometry: no three.js, so node scripts
// can read it too. Campus.js builds it; main.js keeps the rest of the world off it.
//
// Mapping: one uniform scale, north up, picture east → world +X (the same
// sense the gate, the CSE building and the workshop were placed in), the
// gate's spot in the picture on the gate (COLLEGE_GATE: 6, 72).
//
// What is NOT built here: the gate, the CSE building and the workshop already
// stand (and stay where they are). The picture's west road and the gate loop's
// west half are the North Road in the game; roads and buildings reaching into
// the CSE building's or the workshop's grounds are cut back to them.

export const SCALE = 0.55;                    // m per picture pixel
const U0 = 96, V0 = 485;                      // the gate in the picture
const X0 = 6, Z0 = 72;                        // the gate in the world

/** Picture pixel (u right, v down) → world [x, z]. */
export function px(u, v) { return [X0 + (u - U0) * SCALE, Z0 + (V0 - v) * SCALE]; }

/** Grounds that already stand: nothing of the campus goes inside these. */
export const KEEP_OUT = [
  { name: "CSE Building", x: -50, z: 216, r: 50 },
  { name: "College Workshop", x: 66, z: 270, r: 40 },
];

// North Road centreline x at z (its control points; the curve stays within ~1 m)
const NORTH = [[6, 70], [2, 128], [0, 170], [6, 232], [8, 300]];
export function northRoadX(z) {
  if (z <= NORTH[0][1]) return NORTH[0][0];
  for (let i = 1; i < NORTH.length; i++) {
    const [x0, z0] = NORTH[i - 1], [x1, z1] = NORTH[i];
    if (z <= z1) return x0 + (x1 - x0) * (z - z0) / (z1 - z0);
  }
  return NORTH[NORTH.length - 1][0];
}

// ── Roads (picture px). Ends on the North Road are snapped onto it. ─────────
const ROADS_PX = [
  // North of the ground, from the workshop's grounds round the north-east corner
  { name: "College Road North", pts: [[213, 130], [260, 140], [330, 155], [362, 166], [376, 186]] },
  // East of the ground, down to the back wall
  { name: "College Road East", pts: [[376, 186], [378, 240], [377, 282], [374, 340], [372, 385], [362, 430], [354, 486]] },
  // Into the eastern blocks
  { name: "College Road Quarters", pts: [[377, 282], [420, 283], [462, 284]] },
  // The diagonal from the workshop down to the North Road
  { name: "College Road Diagonal", pts: [[86, 268], [120, 234], [160, 192], [185, 160], [213, 130]], west: true },
  // West side of the ground
  { name: "College Road Ground", pts: [[160, 192], [185, 207], [198, 230], [198, 300], [197, 340], [197, 361]] },
  // South of the ground, from the North Road to the east road
  { name: "College Road South", pts: [[86, 341], [100, 343], [150, 352], [200, 362], [250, 370], [300, 376], [374, 386]], west: true },
  // In front of the main building
  { name: "College Road Main", pts: [[86, 407], [108, 411], [150, 413], [250, 416], [360, 420], [374, 421]], west: true },
  // The gate loop's east half (its west half is the North Road)
  { name: "College Road Gate", pts: [[86, 463], [116, 456], [127, 440], [121, 422], [108, 411]], west: true },
];

/** Splits a world polyline where it runs inside any KEEP_OUT disc. */
function clip(pts) {
  const out = [];
  let cur = [];
  const inside = ([x, z]) => KEEP_OUT.some(k => Math.hypot(x - k.x, z - k.z) < k.r);
  // Resample every 2 m so the cut is close to the disc's edge
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
    for (let k = i ? 1 : 0; k <= n; k++) {
      const p = [ax + (bx - ax) * k / n, az + (bz - az) * k / n];
      if (inside(p)) { if (cur.length > 1) out.push(cur); cur = []; }
      else cur.push(p);
    }
  }
  if (cur.length > 1) out.push(cur);
  // Keep the control points only (plus the cut ends) so the curve stays smooth
  return out.map(seg => seg.filter((p, j) => j === 0 || j === seg.length - 1 || j % 6 === 0));
}

/** Road definitions for world/Roads.js (open polylines, world metres). */
export const CAMPUS_ROADS = [];
for (const r of ROADS_PX) {
  const w = r.pts.map(([u, v]) => px(u, v));
  // A west end on the North Road: onto its centreline, so the asphalt joins
  if (r.west) w[0][0] = northRoadX(w[0][1]);
  clip(w).forEach((pts, i) => CAMPUS_ROADS.push({ name: i ? `${r.name} ${i + 1}` : r.name, points: pts, campus: true }));
}

// ── Buildings ────────────────────────────────────────────────────────────────
// parts: axis-aligned rectangles [u0, v0, u1, v1] in the picture, or, with
// `at` and `rot` (degrees clockwise on the map), rectangles [u0, v0, u1, v1]
// in px round `at`. floors: storeys (the picture can't tell: a plausible
// guess from the roofs). verandah: a covered corridor along the first part's
// n / s / e / w side. tint: wall paint.
const PAINT = { cream: 0xf1e3c3, ochre: 0xe9cf98, peach: 0xf0cfb2, white: 0xf3f0e8, buff: 0xe6d9bf };
const BUILDINGS_PX = [
  // The stepped block south-west of the ground: four wings in a stair along the diagonal
  { name: "Stepped Block", floors: 2, tint: "cream", parts: [[108, 318, 138, 336], [124, 300, 154, 318], [140, 282, 170, 300], [156, 262, 188, 282]] },
  // Two blocks facing each other across a courtyard, between the south road and the main road
  { name: "South Block A", floors: 2, tint: "ochre", verandah: "s", parts: [[106, 357, 136, 369]] },
  { name: "South Block B", floors: 2, tint: "ochre", verandah: "n", parts: [[106, 383, 136, 399]] },
  // The main building south of the main road: a long front with three wings to the back
  { name: "Main Building", floors: 3, tint: "cream", verandah: "n", porch: true, parts: [[180, 434, 336, 448], [182, 448, 200, 480], [250, 448, 268, 480], [318, 448, 336, 480]] },
  { name: "Admin Block", floors: 2, tint: "white", verandah: "n", parts: [[136, 462, 170, 484]] },
  { name: "East Block", floors: 2, tint: "buff", parts: [[366, 436, 388, 470]] },
  // East of the east road: cross-shaped blocks round courtyards of trees, and smaller ones behind
  { name: "East Court 1", floors: 2, tint: "white", parts: [[402, 216, 458, 258], [414, 200, 446, 274]] },
  { name: "East Court 2", floors: 2, tint: "white", parts: [[402, 294, 456, 326], [414, 291, 444, 336]] },
  { name: "East Court 3", floors: 2, tint: "white", at: [420, 378], rot: 25, parts: [[-24, -16, 24, 16], [-14, -28, 14, 28]] },
  { name: "East House 1", floors: 2, tint: "peach", parts: [[482, 214, 504, 258]] },
  { name: "East House 2", floors: 2, tint: "peach", parts: [[470, 272, 504, 304]] },
  { name: "East House 3", floors: 2, tint: "buff", parts: [[546, 230, 588, 288]] },
  { name: "Pump House", floors: 1, tint: "buff", parts: [[502, 419, 518, 431]] },
];

/**
 * Buildings in world metres: { name, x, z, rot, floors, tint, verandah, porch,
 * parts: [{ x, z, w, d }] in the building's frame (local +X east / +Z north
 * before rot) }. rot follows three.js (about +Y): local (lx, lz) → world
 * (x + lx cos + lz sin, z − lx sin + lz cos).
 */
export const CAMPUS_BUILDINGS = BUILDINGS_PX.map(b => {
  const rot = (b.rot ?? 0) * Math.PI / 180;   // clockwise on the north-up map = +rot here (+X east)
  let cx, cz;
  if (b.at) [cx, cz] = px(b.at[0], b.at[1]);
  else {
    // Centre of the union's bounding box
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const [a, c, e, f] of b.parts) { u0 = Math.min(u0, a); v0 = Math.min(v0, c); u1 = Math.max(u1, e); v1 = Math.max(v1, f); }
    [cx, cz] = px((u0 + u1) / 2, (v0 + v1) / 2);
  }
  const parts = b.parts.map(([a, c, e, f]) => {
    const w = (e - a) * SCALE, d = (f - c) * SCALE;
    if (b.at) return { x: (a + e) / 2 * SCALE, z: -(c + f) / 2 * SCALE, w, d };
    const [x, z] = px((a + e) / 2, (c + f) / 2);
    return { x: x - cx, z: z - cz, w, d };
  });
  return { name: b.name, x: cx, z: cz, rot, floors: b.floors, tint: PAINT[b.tint], verandah: b.verandah ?? null, porch: !!b.porch, parts };
});

// ── The cricket ground ───────────────────────────────────────────────────────
const [FX, FZ] = px(287, 262);
/** The oval (the boundary rope), the pitch along the long axis (north-south). */
export const CRICKET = { x: FX, z: FZ, rx: 42, rz: 55, rope: 0.94, pitchL: 20.12, pitchW: 3.05, square: [12, 26] };
/** The open ground between the roads round it (picture: the brown field). */
export const FIELD_POLY = [[222, 147], [330, 162], [366, 176], [369, 300], [367, 376], [300, 370], [204, 356], [204, 236], [196, 212]].map(([u, v]) => px(u, v));
/** The red-earth strip south of the ground, by the south road. */
export const RED_STRIP = [[268, 383], [364, 391], [364, 397], [268, 390]].map(([u, v]) => px(u, v));

// ── Boundary wall and the campus's extent ───────────────────────────────────
// From the gate's east pillar along the south, up the east side, a corner cut
// off by the Outer Ring, and along the north to the workshop's grounds. The
// west side is the North Road. gaps: openings (world [x, z], half width m).
export const WALL = [[111, 485], [130, 489], [600, 489], [600, 194], [528, 128], [380, 104], [300, 92]].map(([u, v]) => px(u, v));
export const WALL_GAPS = [{ at: px(354, 489), hw: 4.5 }];   // the back gate, at the east road's end
/** The campus (for keeping houses, fields, plots, scattered trees and rocks out): the wall closed along the North Road. */
export const AREA = [[102, 486], ...[[130, 489], [600, 489], [600, 194], [528, 128], [380, 104], [300, 92]], [250, 84], [102, 84]].map(([u, v]) => px(u, v));

// ── Trees (picture px): clusters [u, v, radius, count] and rows [[u0, v0], [u1, v1], count]
export const TREE_CLUSTERS = [
  [150, 225, 18, 8], [118, 285, 12, 4], [176, 318, 14, 5], [92, 300, 8, 2],   // round the stepped block
  [176, 384, 16, 7], [148, 392, 8, 2],                                        // between the south and main roads
  [430, 238, 6, 2], [428, 312, 5, 1], [420, 378, 5, 1],                       // the courtyards
  [470, 320, 18, 5], [522, 250, 14, 4], [535, 355, 24, 7], [462, 410, 14, 4], [560, 440, 20, 5], [440, 465, 16, 4],
  [300, 120, 14, 4], [350, 128, 10, 3], [460, 150, 22, 6], [550, 170, 18, 4],
  [212, 485, 10, 3], [290, 485, 8, 2], [124, 438, 4, 1], [345, 455, 8, 2],
];
export const TREE_ROWS = [
  [[222, 400], [356, 404], 11],    // along the south road, by the red strip
  [[389, 196], [389, 420], 10],    // east side of the east road
  [[208, 238], [208, 340], 6],     // west edge of the ground
  [[140, 425], [350, 428], 9],     // in front of the main building
  [[590, 205], [590, 470], 8],     // inside the east wall
  [[140, 478], [600, 482], 14],    // inside the south wall
];

// ── Queries ──────────────────────────────────────────────────────────────────
export function inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** Distance from (x, z) to a polygon's edge. */
export function polyEdgeDist(x, z, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j], [bx, bz] = poly[i];
    const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
    d = Math.min(d, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return d;
}
/** Inside the campus, grown by pad metres. */
export function inCampusArea(x, z, pad = 0) {
  if (inPoly(x, z, AREA)) return true;
  return pad > 0 && polyEdgeDist(x, z, AREA) < pad;
}
export const AREA_BOX = AREA.reduce((b, [x, z]) => ({ x0: Math.min(b.x0, x), x1: Math.max(b.x1, x), z0: Math.min(b.z0, z), z1: Math.max(b.z1, z) }),
  { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity });
