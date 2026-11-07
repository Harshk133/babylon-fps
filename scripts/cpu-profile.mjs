// CPU profile of the benchmark's combat phase (or explore with --phase explore),
// aggregated by function self time and by file. Dev only.
//   node scripts/cpu-profile.mjs [--preset medium] [--phase combat] [--phone]
import { spawn, execSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true); };
const PRESET = opt("preset", "medium"), PHASE = opt("phase", "combat"), PHONE = !!opt("phone", false);
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const DEV = !!opt("dev", false);   // dev server: unminified names (slower, but readable)
const PORT = DEV ? 4180 : 4179;
const server = spawn("npx.cmd", DEV ? ["vite", "--port", String(PORT), "--strictPort"] : ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore", shell: true });
const url = `http://localhost:${PORT}/`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
try {
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 1800000, args: ["--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  if (PHONE) await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2.5, isMobile: true, hasTouch: true });
  else await page.setViewport({ width: 1600, height: 900 });
  await page.evaluateOnNewDocument(p => { localStorage.setItem("babylon-fps:legal-ack-v4", "1"); localStorage.setItem("babylon-fps:quality", p); }, PRESET);
  await page.goto(url + "?bench=" + (["crowd", "fx", "town", "drive"].includes(PHASE) ? "full" : "1") + (PHONE ? "&touch=1" : ""), { timeout: 120000 });
  await page.waitForFunction(ph => window.__dbg?.bench?.phase === ph, { timeout: 300000, polling: 200 }, PHASE);
  const cdp = await page.createCDPSession();
  if (PHONE) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await new Promise(r => setTimeout(r, 2000));
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await new Promise(r => setTimeout(r, 7000));
  const { profile } = await cdp.send("Profiler.stop");
  await browser.close();
  mkdirSync("bench-results", { recursive: true });
  writeFileSync(`bench-results/profile-${PHASE}-${PRESET}${PHONE ? "-phone" : ""}.cpuprofile`, JSON.stringify(profile));
  // self time per node
  const dt = new Map();
  for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
  const total = profile.timeDeltas.reduce((a, b) => a + b, 0);
  const byFn = new Map(), byFile = new Map();
  for (const n of profile.nodes) {
    const t = dt.get(n.id) ?? 0; if (!t) continue;
    const cf = n.callFrame, file = (cf.url.split("/").pop().split("?")[0] || "(native)").replace(/-[A-Za-z0-9_]{8}\.js$/, ".js");
    const k = `${cf.functionName || "(anon)"}  ${file}:${cf.lineNumber + 1}`;
    byFn.set(k, (byFn.get(k) ?? 0) + t); byFile.set(file, (byFile.get(file) ?? 0) + t);
  }
  const pct = t => (100 * t / total).toFixed(1).padStart(5) + "%";
  console.log(`total ${(total / 1000).toFixed(0)} ms sampled\n-- by file --`);
  for (const [k, t] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(pct(t), k);
  console.log("-- by function (self) --");
  for (const [k, t] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 45)) console.log(pct(t), k);
} finally { try { execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" }); } catch {} }
