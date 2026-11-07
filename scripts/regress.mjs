// Functional checks for the performance work (dev only): runs the production
// build headless and asserts things that must still behave the same.
//   node scripts/regress.mjs [--shots]   (--shots saves screenshots to bench-results/shots/)
//
//  1. physics: static bodies live in the grid, not world.bodies; rays still hit
//     the terrain, a house wall and a crate; a crate broken leaves the grid and
//     comes back on restore
//  2. walls: walking into a house wall stops you
//  3. vehicles: getting into a Thar and out again; it moves when driven
//  4. interpolation: the drawn character is never more than a step from the body
//  5. overlays: lobby / death screen / legal hidden with visibility after fading
//  6. no page errors
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const SHOTS = process.argv.includes("--shots");
const DIST = (() => { const i = process.argv.indexOf("--dist"); return i < 0 ? "dist" : process.argv[i + 1]; })();
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const server = spawn("npx.cmd", ["vite", "preview", "--port", "4182", "--strictPort", "--outDir", DIST], { stdio: "ignore", shell: true });
const url = "http://localhost:4182/";
for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch { /* wait */ } await new Promise(r => setTimeout(r, 500)); }

let failed = 0;
const check = (name, ok, info = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  " + info : ""}`); if (!ok) failed++; };

try {
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 600000, args: ["--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => { localStorage.setItem("babylon-fps:legal-ack-v4", "1"); localStorage.setItem("babylon-fps:quality", "low"); });

  // ── Lobby first (no bench): the overlays
  await page.goto(url, { timeout: 120000 });
  await page.waitForFunction(() => window.__dbg?.world, { timeout: 180000, polling: 300 });
  await new Promise(r => setTimeout(r, 1500));
  const ov = await page.evaluate(() => {
    const vis = id => { const e = document.getElementById(id); return e ? getComputedStyle(e).visibility : "none"; };
    return { lobby: vis("lobby"), lobbyShown: document.getElementById("lobby")?.classList.contains("visible"), death: vis("death-screen"), legal: vis("legal") };
  });
  check("lobby visible while shown", !ov.lobbyShown || ov.lobby === "visible", JSON.stringify(ov));
  check("death screen hidden", ov.death === "hidden");
  check("legal screen hidden (accepted)", ov.legal === "hidden");
  if (SHOTS) { mkdirSync("bench-results/shots", { recursive: true }); await page.screenshot({ path: "bench-results/shots/lobby.png" }); }

  // ── Into the game through the bench (no lobby, can't die), then drive it ourselves
  await page.goto(url + "?bench=1", { timeout: 120000 });
  await page.waitForFunction(() => window.__dbg?.bench?.on, { timeout: 180000, polling: 300 });
  await page.evaluate(() => { window.__dbg.bench.on = false; });
  await new Promise(r => setTimeout(r, 2500));
  const lobbyHidden = await page.evaluate(() => getComputedStyle(document.getElementById("lobby")).visibility);
  check("lobby hidden after start (visibility)", lobbyHidden === "hidden", lobbyHidden);

  const phys = await page.evaluate(() => {
    const d = window.__dbg, W = d.world, C = W.bodies[0].position.constructor;
    const statics = W.broadphase.staticBodies;
    const out = { moving: W.bodies.length, statics: statics.length, staticInBodies: W.bodies.filter(b => b.type === 2).length };
    // cannon's RaycastResult isn't exported to the page: a stand-in with the same interface
    class RR { constructor() { this.rayFromWorld = new C(); this.rayToWorld = new C(); this.hitNormalWorld = new C(); this.hitPointWorld = new C(); this.reset(); }
      reset() { this.hasHit = false; this.shape = null; this.body = null; this.hitFaceIndex = -1; this.distance = -1; this.shouldStop = false; }
      abort() { this.shouldStop = true; }
      set(f, t, n, p, s, b, dist) { this.rayFromWorld.copy(f); this.rayToWorld.copy(t); this.hitNormalWorld.copy(n); this.hitPointWorld.copy(p); this.shape = s; this.body = b; this.distance = dist; } }
    const ray = (a, b) => { const r = new RR(); const hit = W.raycastClosest(new C(...a), new C(...b), { skipBackfaces: true }, r); return { hit, r }; };
    // straight down at the spawn: the terrain
    const g = d.groundHeight(3, 3);
    const down = ray([3, g + 20, 3], [3, g - 5, 3]);
    out.downHit = down.hit; out.downBodyStatic = down.r.body?.type === 2; out.downY = +(down.r.hitPointWorld.y).toFixed(2); out.groundY = +g.toFixed(2);
    // a crate: break it, the ray passes; restore, it's back
    const cr = d.crates?.list?.find(c => !c.broken);
    if (cr) {
      const a = [cr.x, cr.y + 3, cr.z], b = [cr.x, cr.y - 1, cr.z];
      const r1 = ray(a, b); out.crateHit1 = r1.r.body?.crate === cr.i;
      d.crates.break(cr.i, 0, 0, 0, false);
      const r2 = ray(a, b); out.crateHitBroken = r2.r.body?.crate === cr.i; out.crateInGridBroken = statics.includes(cr.body);
      d.crates.restore(cr.i);
      const r3 = ray(a, b); out.crateHit3 = r3.r.body?.crate === cr.i; out.crateInGridRestored = statics.includes(cr.body);
    }
    return out;
  });
  check("static bodies kept out of world.bodies", phys.staticInBodies === 0 && phys.statics > 100, JSON.stringify({ moving: phys.moving, statics: phys.statics }));
  check("ray down hits the static terrain", phys.downHit && phys.downBodyStatic && Math.abs(phys.downY - phys.groundY) < 0.6, `hit y ${phys.downY} ground ${phys.groundY}`);
  check("ray hits a crate", phys.crateHit1 === true);
  check("broken crate: gone from the grid and rays", phys.crateHitBroken === false && phys.crateInGridBroken === false);
  check("restored crate: back in the grid and rays", phys.crateHit3 === true && phys.crateInGridRestored === true);

  // ── Walk into a house wall: you stop at it
  const wall = await page.evaluate(async () => {
    const d = window.__dbg, wait = ms => new Promise(r => setTimeout(r, ms));
    const H = d.houses;
    const list = H?.houses ?? [];
    const h = list.find(x => Math.hypot(x.x, x.z) < 200) ?? list[0];
    if (!h) return { skipped: true };
    // Start 9 m behind the house (the side away from its door), walk at its centre
    let ax = h.x - h.doorWorld.x, az = h.z - h.doorWorld.z; const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
    const bx = h.x + ax * 9, bz = h.z + az * 9;
    d.characterBody.position.set(bx, d.groundHeight(bx, bz) + 1.2, bz);
    d.characterBody.velocity.set(0, 0, 0);
    await wait(500);
    d.setAim(Math.atan2(h.x - bx, h.z - bz), -0.05);
    d.keys.forward = true;
    await wait(3500);
    d.keys.forward = false;
    const p = d.characterBody.position;
    return { start: 9, distNow: +Math.hypot(p.x - h.x, p.z - h.z).toFixed(2), inside: !!H.houseAt?.(p.x, p.z) };
  });
  check("walking into a house's back wall stops you", wall.skipped || (wall.distNow > 2 && !wall.inside), JSON.stringify(wall));

  // ── Interpolation: the drawn character stays within a step of the body while walking
  const interp = await page.evaluate(async () => {
    const d = window.__dbg, wait = ms => new Promise(r => setTimeout(r, ms));
    d.characterBody.position.set(0, d.groundHeight(0, -6) + 1.2, -6);
    await wait(400);
    d.setAim(Math.PI, -0.08);
    d.keys.forward = true;
    let worst = 0;
    await new Promise(res => { const t0 = performance.now(); const f = now => { const dx = d.characterRoot.position.x - d.characterBody.position.x, dz = d.characterRoot.position.z - d.characterBody.position.z; worst = Math.max(worst, Math.hypot(dx, dz)); if (now - t0 < 2000) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    d.keys.forward = false;
    // teleport: no streak (the drawn position follows within a frame or two)
    d.characterBody.position.set(40, d.groundHeight(40, 40) + 1.2, 40);
    await wait(120);
    // drawn vs body (the body itself may slide a little on the slope it landed on)
    const gap = Math.hypot(d.characterRoot.position.x - d.characterBody.position.x, d.characterRoot.position.z - d.characterBody.position.z);
    return { worstLag: +worst.toFixed(3), afterTeleport: +gap.toFixed(2) };
  });
  check("drawn character within one step of the body", interp.worstLag < 0.25, JSON.stringify(interp));
  check("teleport doesn't streak", interp.afterTeleport < 0.25);

  // ── A vehicle: in, drive, out
  const veh = await page.evaluate(async () => {
    const d = window.__dbg, wait = ms => new Promise(r => setTimeout(r, ms));
    const car = d.vehicles.find(v => v.kind === "thar" && !v.wrecked);
    if (!car) return { skipped: true };
    d.characterBody.position.set(car.x + 1.6, d.groundHeight(car.x + 1.6, car.z) + 1.2, car.z);
    await wait(500);
    const x0 = car.x, z0 = car.z;
    d.toggleVehicle();
    await wait(300);
    const inCar = d.drive.on;
    d.keys.forward = true;
    await wait(2000);
    d.keys.forward = false;
    const moved = Math.hypot(car.x - x0, car.z - z0);
    await wait(1500);
    d.toggleVehicle();
    await wait(400);
    let meshes = 0; car.root.traverse(o => { if (o.isMesh) meshes++; });
    return { inCar, moved: +moved.toFixed(1), outAgain: !d.drive.on, meshes };
  });
  check("get into a Thar", veh.skipped || veh.inCar, JSON.stringify(veh));
  check("it drives", veh.skipped || veh.moved > 2);
  check("get out again", veh.skipped || veh.outAgain);
  if (SHOTS) {
    await page.evaluate(async () => {
      const d = window.__dbg, wait = ms => new Promise(r => setTimeout(r, ms));
      const car = d.vehicles.find(v => v.kind === "thar");
      d.characterBody.position.set(car.x + 5, d.groundHeight(car.x + 5, car.z + 5) + 1.2, car.z + 5);
      await wait(300);
      d.setAim(Math.atan2(car.x - (car.x + 5), car.z - (car.z + 5)), -0.15);
      await wait(1200);
    });
    await page.screenshot({ path: "bench-results/shots/thar.png" });
    await page.evaluate(async () => {
      const d = window.__dbg, wait = ms => new Promise(r => setTimeout(r, ms));
      const car = d.vehicles.find(v => v.kind === "tractor") ?? d.vehicles.find(v => v.kind === "sportbike");
      d.characterBody.position.set(car.x + 4, d.groundHeight(car.x + 4, car.z + 4) + 1.2, car.z + 4);
      await wait(300);
      d.setAim(Math.atan2(-4, -4), -0.15);
      await wait(1200);
    });
    await page.screenshot({ path: "bench-results/shots/tractor.png" });
  }

  const unexpected = errors.filter(e => !/favicon|404|net::ERR|WebSocket/i.test(e));
  check("no page errors", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
  await browser.close();
} finally {
  try { execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" }); } catch { /* gone */ }
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
