// Battle royale rules. Pure data + maths, no Three.js: every client derives
// the plane route, the zone circles and the loot layout from the same match
// seed, so the host only has to share the seed and the match clock.

export const BR_MAX_PLAYERS = 100;       // the relay's room limit
export const BR_AUTO_START  = 25;         // seconds of countdown once 2+ players are in
export const BR_END_HOLD    = 12;         // results screen before the next warm-up
export const BR_WARMUP_RESPAWN = 3;       // dying in the warm-up just puts you back

// ── The drop ──────────────────────────────────────────────────────────────────
export const PLANE = {
  altitude: 95,        // metres
  speed: 34,           // m/s
  halfLength: 500,     // route runs from −halfLength to +halfLength along its line
  maxOffset: 150,      // how far the route may pass from the centre of the map
  jumpDelay: 1.5,      // seconds before the door opens
  ejectRadius: 360,    // past the centre, everyone still aboard is pushed out here (well inside the first zone)
};
export const FREEFALL = {
  fall: 20, dive: 34,           // m/s down: normal / holding W
  forward: 17, back: 6, side: 9, drift: 3,
  steer: 2.2,                   // exp-blend rate toward the target velocity
  chuteHeight: 32,              // the chute opens on its own at this height
  manualAfter: 0.8,             // seconds of freefall before Space opens the chute
};
export const CHUTE = { fall: 5.5, speed: 9, steer: 1.6 };

// ── The zone ──────────────────────────────────────────────────────────────────
export const ZONE_START_RADIUS = 470;
/** wait: seconds before it moves · shrink: seconds to close to `radius` · dps outside. */
export const ZONE_PHASES = [
  { wait: 100, shrink: 70, radius: 260, dps: 1 },
  { wait: 70, shrink: 55, radius: 150, dps: 2 },
  { wait: 50, shrink: 40, radius: 95,  dps: 3 },
  { wait: 40, shrink: 35, radius: 58,  dps: 5 },
  { wait: 32, shrink: 30, radius: 30,  dps: 8 },
  { wait: 25, shrink: 25, radius: 12,  dps: 12 },
  { wait: 20, shrink: 25, radius: 0,   dps: 20 },
];
const FINAL_DPS = 25;

// ── Player-vs-player damage (weapons.js numbers are tuned for monster HP) ────
export const PVP_DAMAGE = { pistol: 20, smg: 15, shotgun: 12, rifle: 23, sniper: 88 };
export const PVP_HEADSHOT = { pistol: 1.8, smg: 1.6, shotgun: 1.4, rifle: 1.8, sniper: 2.5 };
/** Above this height over the feet a hit is a headshot. */
export const PVP_HEAD_Y = 1.45;

// ── Loot ─────────────────────────────────────────────────────────────────────
/**
 * Ground loot scattered over open country: kind → count. Most loot is
 * indoors (BR_HOUSE_LOOT on every house, shed, shop and cave spot); this is
 * only enough to make a long run across the fields worth a detour.
 */
export const BR_FIELD_LOOT = {
  pistol: 8, smg: 3, shotgun: 3, rifle: 2, sniper: 1,
  ammo: 18, grenade: 5, molotov: 5, smoke: 6, medkit: 8, fuel: 16, biscuit: 20, cash: 24,
  helmet1: 3, vest1: 3, backpack1: 3,
  reddot: 1, holo: 1, scope2x: 1, compensator: 1, extmag: 1,
};
/** What a house spot can roll (weighted by repeats). */
export const BR_HOUSE_LOOT = ["ammo", "ammo", "medkit", "medkit", "grenade", "molotov", "smoke", "helmet1", "vest1", "backpack1", "helmet2", "vest2", "reddot", "holo", "scope2x", "scope4x", "scope6x", "extmag", "grip", "smg", "shotgun", "rifle", "pistol", "sniper", "fuel", "biscuit", "biscuit", "cash", "cash"];
export const BR_LOOT_RADIUS = 420;
/** Spare rounds that come with a gun found on the ground. */
export const BR_GUN_RESERVE = { pistol: 24, smg: 64, shotgun: 10, rifle: 45, sniper: 6 };

// ── Seeded random ────────────────────────────────────────────────────────────
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Straight route across the map: { ax, az, bx, bz, dx, dz, length, duration }. */
export function planeRoute(seed) {
  const rng = makeRng(seed ^ 0x51a7e);
  const a = rng() * Math.PI * 2;
  const dx = Math.cos(a), dz = Math.sin(a);
  const off = (rng() * 2 - 1) * PLANE.maxOffset;
  const cx = -dz * off, cz = dx * off; // a point on the route, sideways from the centre
  const L = PLANE.halfLength;
  return {
    ax: cx - dx * L, az: cz - dz * L,
    bx: cx + dx * L, bz: cz + dz * L,
    dx, dz,
    length: L * 2,
    duration: (L * 2) / PLANE.speed,
  };
}

/** Plane position at match time t (clamped to the route). */
export function planeAt(route, t, out) {
  const s = Math.min(1, Math.max(0, t / route.duration));
  out.x = route.ax + (route.bx - route.ax) * s;
  out.z = route.az + (route.bz - route.az) * s;
  out.y = PLANE.altitude;
  return out;
}

/** Circle per phase boundary: circles[0] is the starting zone, circles[i+1] the end of phase i. */
export function zoneCircles(seed) {
  const rng = makeRng(seed ^ 0x2073e);
  const circles = [{ x: 0, z: 0, r: ZONE_START_RADIUS }];
  for (const p of ZONE_PHASES) {
    const prev = circles[circles.length - 1];
    // The next circle always sits fully inside the current one
    const room = Math.max(0, prev.r - p.radius) * 0.9;
    const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * room;
    let x = prev.x + Math.cos(a) * d, z = prev.z + Math.sin(a) * d;
    // …and stays over the part of the map that has things on it
    const far = Math.hypot(x, z), lim = 330;
    if (far > lim) { x *= lim / far; z *= lim / far; }
    circles.push({ x, z, r: p.radius });
  }
  return circles;
}

/**
 * Zone at match time t. Writes { x, z, r, nx, nz, nr, phase, shrinking,
 * timeLeft, dps, final } into out.
 */
export function zoneAt(circles, t, out) {
  let t0 = 0;
  for (let i = 0; i < ZONE_PHASES.length; i++) {
    const p = ZONE_PHASES[i], a = circles[i], b = circles[i + 1];
    out.nx = b.x; out.nz = b.z; out.nr = b.r;
    out.phase = i;
    out.dps = p.dps;
    out.final = false;
    if (t < t0 + p.wait) {
      out.x = a.x; out.z = a.z; out.r = a.r;
      out.shrinking = false;
      out.timeLeft = t0 + p.wait - t;
      return out;
    }
    if (t < t0 + p.wait + p.shrink) {
      const s = (t - t0 - p.wait) / p.shrink;
      out.x = a.x + (b.x - a.x) * s;
      out.z = a.z + (b.z - a.z) * s;
      out.r = a.r + (b.r - a.r) * s;
      out.shrinking = true;
      out.timeLeft = t0 + p.wait + p.shrink - t;
      return out;
    }
    t0 += p.wait + p.shrink;
  }
  const last = circles[circles.length - 1];
  out.x = out.nx = last.x; out.z = out.nz = last.z; out.r = out.nr = last.r;
  out.phase = ZONE_PHASES.length;
  out.shrinking = false;
  out.timeLeft = 0;
  out.dps = FINAL_DPS;
  out.final = true;
  return out;
}

/**
 * Loot layout for a match: [{ kind, x, z }]. `isOpen(x, z)` rejects spots on
 * colliders; `houseSpots` are world positions inside houses.
 */
export function lootPlan(seed, houseSpots, isOpen) {
  const rng = makeRng(seed ^ 0x100ed);
  const out = [];
  for (const s of houseSpots) {
    if (rng() < 0.12) continue;
    out.push({ kind: BR_HOUSE_LOOT[Math.floor(rng() * BR_HOUSE_LOOT.length)], x: s.x, y: s.y, z: s.z });
  }
  for (const [kind, count] of Object.entries(BR_FIELD_LOOT)) {
    for (let n = 0; n < count; n++) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const a = rng() * Math.PI * 2;
        const r = 6 + Math.sqrt(rng()) * (BR_LOOT_RADIUS - 6);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (!isOpen(x, z)) continue;
        out.push({ kind, x, z });
        break;
      }
    }
  }
  return out;
}

export function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
