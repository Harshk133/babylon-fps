// Motion smoothness A/B inside one build: walks the player in a straight line
// with uneven frame times (a random 0..jitter ms of extra work per frame, like
// a real game's varying load) and measures how evenly the drawn character and
// the camera move: the coefficient of variation of per-frame speed (0 = even).
// Runs with render interpolation on, then off (window.__noInterp). Dev only.
//   node scripts/smooth-probe.mjs [--jitter 12] [--hz 60]
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const JITTER = +opt("jitter", 12);
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const server = spawn("npx.cmd", ["vite", "preview", "--port", "4181", "--strictPort"], { stdio: "ignore", shell: true });
const url = "http://localhost:4181/";
for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
try {
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 600000, args: ["--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => { localStorage.setItem("babylon-fps:legal-ack-v4", "1"); localStorage.setItem("babylon-fps:quality", "low"); });
  await page.goto(url + "?bench=1", { timeout: 120000 });
  await page.waitForFunction(() => window.__dbg?.bench?.on, { timeout: 180000, polling: 300 });
  const out = await page.evaluate(async (JITTER) => {
    const d = window.__dbg, wait = ms => new Promise(r => setTimeout(r, ms));
    d.bench.on = false;
    await wait(3000);
    // Uneven frame cost: busy-wait a random 0..JITTER ms at the start of each frame
    let jit = true;
    const burn = () => { if (!jit) return; const end = performance.now() + Math.random() * JITTER; while (performance.now() < end); requestAnimationFrame(burn); };
    requestAnimationFrame(burn);
    const run = async (noInterp) => {
      const body = [];
      window.__noInterp = noInterp;
      // Same clear stretch every time: back to the start, then walk
      d.keys.forward = false;
      d.characterBody.position.set(START[0], d.groundHeight(START[0], START[1]) + 1.2, START[1]);
      d.characterBody.velocity.set(0, 0, 0);
      await wait(700);
      d.setAim(DIR, -0.08);
      d.keys.forward = true;
      await wait(800);
      const cam = [], root = [], ts = [];
      await new Promise(res => {
        const t0 = performance.now();
        const f = now => {
          try {
            ts.push(now);
            cam.push([d.camera.position.x, d.camera.position.z]);
            root.push([d.characterRoot.position.x, d.characterRoot.position.z]);
            body.push([d.characterBody.position.x, d.characterBody.position.z]);
          } catch { res(); return; }
          if (now - t0 < 2500) requestAnimationFrame(f); else res();
        };
        requestAnimationFrame(f);
      });
      d.keys.forward = false;
      await wait(600);
      const cv = arr => {
        const v = [];
        for (let i = 2; i < arr.length; i++) {
          const dt = (ts[i] - ts[i - 1]) / 1000;
          if (dt > 0) v.push(Math.hypot(arr[i][0] - arr[i - 1][0], arr[i][1] - arr[i - 1][1]) / dt);
        }
        const m = v.reduce((a, b) => a + b, 0) / v.length;
        return +(Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / m).toFixed(3);
      };
      const gaps = []; for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
      gaps.sort((a, b) => a - b);
      return { interp: !noInterp, frames: ts.length, gapP10: +gaps[Math.floor(gaps.length * 0.1)].toFixed(1), gapP90: +gaps[Math.floor(gaps.length * 0.9)].toFixed(1), characterCV: cv(root), cameraCV: cv(cam), physicsBodyCV: cv(body), metres: +Math.hypot(root.at(-1)[0] - root[0][0], root.at(-1)[1] - root[0][1]).toFixed(1) };
    };
    const res = [];
    const START = [0, -6], DIR = Math.PI;      // from the spawn, south along the road
    for (let k = 0; k < 3; k++) { res.push(await run(false)); res.push(await run(true)); }
    jit = false;
    return res;
  }, JITTER);
  for (const r of out) console.log(JSON.stringify({ jitter: JITTER, ...r }));
  await browser.close();
} finally { try { execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" }); } catch {} }
