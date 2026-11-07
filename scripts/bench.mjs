// Repeatable benchmark runs: starts `vite preview` on the production build (or
// uses --url), opens the game in the installed Chrome / Edge through
// puppeteer-core, runs the in-game ?bench scenario and collects
// window.__benchResult. Results go to bench-results/<date>-<commit>-<label>.json
// and a markdown table on stdout.
//
//   node scripts/bench.mjs                         desktop 1600×900, auto preset, 3 runs
//   node scripts/bench.mjs --preset medium --runs 2
//   node scripts/bench.mjs --phone                 844×390 @ dpr 2.5, touch, CPU ×4
//   node scripts/bench.mjs --scenario full         ?bench=full (all scenarios)
//   node scripts/bench.mjs --url http://localhost:5173/   (dev server already running)
//   node scripts/bench.mjs --label before          tag the output file
//   node scripts/bench.mjs --headful               visible window (real vsync / compositor)
//
// Dev only: nothing here ships with the game.

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};

const RUNS = +opt("runs", 3);
const PRESET = opt("preset", "auto");
const PHONE = !!opt("phone", false);
const SCENARIO = opt("scenario", "1");
const LABEL = opt("label", "");
const HEADFUL = !!opt("headful", false);
const DIST = opt("dist", "dist");         // which build to serve (e.g. dist-base for A/B runs)
const PORT = 4179;
let url = opt("url", null);

const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const executablePath = opt("browser", BROWSERS.find(p => existsSync(p)));
if (!executablePath) throw new Error("No Chrome / Edge found: pass --browser <path>");

let server = null;
async function startServer() {
  if (url) return;
  if (DIST === "dist" && (!existsSync("dist/index.html") || opt("build", false))) {
    console.log("building…");
    execSync("npm run build", { stdio: "inherit" });
  }
  server = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", DIST], { stdio: "pipe", shell: true });
  url = `http://localhost:${PORT}/`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("vite preview did not start");
}

async function runOnce(browser, n) {
  const page = await browser.newPage();
  if (PHONE) {
    await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2.5, isMobile: true, hasTouch: true });
    const cdp = await page.createCDPSession();
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  } else {
    await page.setViewport({ width: 1600, height: 900 });
  }
  const logs = [];
  page.on("console", m => { const t = m.text(); if (/error|BENCH_RESULT/i.test(t)) logs.push(t); });
  page.on("pageerror", e => logs.push("pageerror: " + e.message));
  await page.evaluateOnNewDocument((preset) => {
    try {
      localStorage.setItem("babylon-fps:legal-ack-v4", "1");
      if (preset !== "auto") localStorage.setItem("babylon-fps:quality", preset);
      else localStorage.removeItem("babylon-fps:quality");
    } catch { /* fine */ }
  }, PRESET);
  const q = new URLSearchParams({ bench: SCENARIO });
  if (PHONE) q.set("touch", "1");
  const t0 = Date.now();
  await page.goto(`${url}?${q}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => window.__benchResult, { timeout: 30 * 60 * 1000, polling: 1000 });
  const result = await page.evaluate(() => window.__benchResult);
  result.wallSeconds = Math.round((Date.now() - t0) / 1000);
  if (logs.some(l => /error/i.test(l) && !/BENCH_RESULT/.test(l))) console.log("page errors:", logs.filter(l => !/BENCH_RESULT/.test(l)).slice(0, 5));
  if (logs.some(l => /error/i.test(l) && !/BENCH_RESULT/.test(l))) result.errors = logs.filter(l => !/BENCH_RESULT/.test(l)).slice(0, 10);
  await page.close();
  console.log(`run ${n + 1}/${RUNS} done in ${result.wallSeconds}s`);
  return result;
}

function median(xs) {
  const s = xs.filter(x => typeof x === "number").sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

function table(results) {
  const scenarios = Object.keys(results[0]).filter(k => results[0][k] && typeof results[0][k] === "object" && "fps" in results[0][k]);
  const cols = ["fps", "low1", "p50", "p95", "p99", "worst", "over33ms", "spikesOver50ms", "logicAvg", "submitAvg", "gpuAvg", "calls", "triangles", "heapMB", "substeps"];
  const lines = [`| scenario | ${cols.join(" | ")} |`, `|${"---|".repeat(cols.length + 1)}`];
  for (const sc of scenarios) {
    lines.push(`| ${sc} | ${cols.map(c => median(results.map(r => r[sc]?.[c])) ?? "–").join(" | ")} |`);
  }
  // Section breakdown (median of each section's average)
  lines.push("", "ms per frame by section (median of runs):", "");
  const names = Object.keys(results[0][scenarios[0]]?.sections ?? {});
  lines.push(`| scenario | ${names.join(" | ")} |`, `|${"---|".repeat(names.length + 1)}`);
  for (const sc of scenarios) lines.push(`| ${sc} | ${names.map(n => median(results.map(r => r[sc]?.sections?.[n])) ?? "–").join(" | ")} |`);
  return lines.join("\n");
}

try {
  await startServer();
  const browser = await puppeteer.launch({
    executablePath, headless: !HEADFUL, protocolTimeout: 40 * 60 * 1000,
    args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--autoplay-policy=no-user-gesture-required",
      "--window-size=1600,900"],
  });
  const results = [];
  for (let n = 0; n < RUNS; n++) results.push(await runOnce(browser, n));
  await browser.close();
  let commit = "nogit";
  try { commit = execSync("git rev-parse --short HEAD").toString().trim(); } catch { /* fine */ }
  mkdirSync("bench-results", { recursive: true });
  const name = `bench-results/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${commit}${LABEL ? "-" + LABEL : ""}-${PHONE ? "phone" : "desktop"}-${PRESET}.json`;
  writeFileSync(name, JSON.stringify({ preset: PRESET, phone: PHONE, scenario: SCENARIO, dist: DIST, results }, null, 2));
  console.log(`\n${name}\n`);
  console.log(`quality ${results[0].quality} · ${results[0].screen} · ${results[0].gpu ?? ""}\n`);
  console.log(table(results));
} finally {
  if (server) {
    if (process.platform === "win32") { try { execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" }); } catch { /* gone */ } }
    else server.kill();
  }
}
