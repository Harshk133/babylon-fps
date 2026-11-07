// Where does the GPU time go? Loads the game in ?bench=1 mode, holds the
// camera still at spawn, and toggles groups of the scene off one at a time,
// measuring GPU time (EXT_disjoint_timer_query_webgl2) with each group on and
// off (A/B/A). Dev only.
//
//   node scripts/gpu-probe.mjs [--preset medium] [--url http://localhost:4179/]

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const PRESET = opt("preset", "medium");
let url = opt("url", null);
const PORT = 4179;
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);

let server = null;
if (!url) {
  server = spawn("npx.cmd", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore", shell: true });
  url = `http://localhost:${PORT}/`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch { /* wait */ } await new Promise(r => setTimeout(r, 500)); }
}

try {
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 1800000, args: ["--ignore-gpu-blocklist", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.evaluateOnNewDocument(p => { localStorage.setItem("babylon-fps:legal-ack-v4", "1"); localStorage.setItem("babylon-fps:quality", p); }, PRESET);
  await page.goto(`${url}?bench=1`, { timeout: 120000 });
  await page.waitForFunction(() => window.__dbg?.bench?.on, { timeout: 180000, polling: 500 });
  const out = await page.evaluate(async () => {
    const d = window.__dbg, po = d.perfOverlay, b = d.bench;
    b.on = false;                       // stop the scripted bench: we drive
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await wait(4000);
    d.setAim(0.6, -0.08);
    const gpu = async (ms = 1800) => { po.reset(); await wait(ms); const r = po.report().data; return { gpu: r.gpu?.avg ?? NaN, calls: r.calls, tris: r.triangles, submit: r.submit.avg }; };
    const res = [];
    const groups = new Map();
    for (const c of d.scene.children) {
      let key = c.name || c.type;
      if (c.isInstancedMesh || c.isMesh) key = (c.name || "mesh") + ":" + (c.material?.type ?? "");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    res.push({ name: "BASE", ...(await gpu()) });
    const togg = async (name, off, on) => {
      const a = await gpu(1200); off(); const x = await gpu(); on(); const a2 = await gpu(1200);
      const base = (a.gpu + a2.gpu) / 2;
      res.push({ name, base: +base.toFixed(2), without: +x.gpu.toFixed(2), saves: +(base - x.gpu).toFixed(2), callsSaved: a.calls - x.calls, trisSaved: a.tris - x.tris });
    };
    const sm = d.renderer.shadowMap, auto0 = sm.autoUpdate;
    await togg("SHADOW MAP (no updates)", () => {
      sm.autoUpdate = false;
      Object.defineProperty(sm, "needsUpdate", { configurable: true, get: () => false, set: () => {} });
    }, () => { delete sm.needsUpdate; sm.needsUpdate = false; sm.autoUpdate = auto0; });
    const pin = (u, v) => { const o = d.postFx.uniforms?.[u]; if (!o) return () => {}; Object.defineProperty(o, "value", { configurable: true, get: () => v, set: () => {} }); return () => { delete o.value; o.value = 0; }; };
    let un;
    await wait(6000);   // trees / lazy models settle
    const dom = [...document.body.children].filter(e => e.id !== "webgl" && e.id !== "perf-overlay" && !e.contains(document.getElementById("webgl"))).map(e => [e, e.style.display]);
    const frameAvg = async () => { po.reset(); await wait(2000); const r = po.report().data; return { gpu: +(r.gpu?.avg ?? NaN).toFixed(2), frame: +r.frame.avg.toFixed(2) }; };
    res.push({ name: "with HUD DOM", ...(await frameAvg()) });
    dom.forEach(([e]) => { e.style.display = "none"; });
    res.push({ name: "HUD DOM hidden", ...(await frameAvg()) });
    // which top-level elements are heavy: one at a time
    for (const [e, disp] of dom) {
      e.style.display = disp;
    }
    res.push({ name: "HUD DOM back", ...(await frameAvg()) });
    const heavy = [];
    for (const [e, disp] of dom) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const a = await frameAvg(); e.style.display = "none"; const b2 = await frameAvg(); e.style.display = disp;
      heavy.push({ name: "DOM #" + (e.id || e.className || e.tagName), saves: +(a.gpu - b2.gpu).toFixed(2), frameSaves: +(a.frame - b2.frame).toFixed(2) });
    }
    heavy.sort((x, y) => y.saves - x.saves);
    res.push(...heavy.slice(0, 10));
    const kids = d.scene.children.map(c => [c, c.visible]);
    await togg("WHOLE SCENE hidden (floor = backdrop + post + clears)", () => kids.forEach(([c]) => { c.visible = false; }), () => kids.forEach(([c, v]) => { c.visible = v; }));
    const sc0 = d.postFx.scale ?? 1;
    res.push({ name: "postFx.scale now", v: sc0 });
    const setS = v => { d.postFx.setScale(v); };
    // pin dynamic resolution off: the game would move it back
    const pf = d.postFx, orig = pf.setScale.bind(pf);
    pf.setScale = () => {};
    for (const v of [1, 0.6, 0.35]) { orig(v); res.push({ name: "scale " + v, ...(await gpu(2000)) }); }
    pf.setScale = orig; orig(sc0);
    await togg("POST unsharp (uSharp=0)", () => { un = pin("uSharp", 0); }, () => un());
    await togg("POST lens+CA (uLens=0)", () => { un = pin("uLens", 0); }, () => un());
    await togg("POST grain (uGrain=0)", () => { un = pin("uGrain", 0); }, () => un());
    await togg("BACKDROP pass", () => { d.backdrop.__r = d.backdrop.render; d.backdrop.render = () => {}; }, () => { d.backdrop.render = d.backdrop.__r; });
    // biggest groups by triangle count first
    const ranked = [...groups.entries()].map(([k, objs]) => {
      let tris = 0;
      for (const o of objs) o.traverse(m => { if (m.geometry?.index) tris += m.geometry.index.count / 3 * (m.isInstancedMesh ? m.count : 1); else if (m.geometry?.attributes?.position) tris += m.geometry.attributes.position.count / 3 * (m.isInstancedMesh ? m.count : 1); });
      return [k, objs, tris];
    }).sort((a, b) => b[2] - a[2]).slice(0, +(new URLSearchParams(location.search).get("groups") ?? 6));
    for (const [k, objs, tris] of ranked) {
      const vis = objs.map(o => o.visible);
      await togg(`${k} ×${objs.length} (~${Math.round(tris / 1000)}k tris)`, () => objs.forEach(o => { o.visible = false; }), () => objs.forEach((o, i) => { o.visible = vis[i]; }));
    }
    return res;
  });
  for (const r of out) console.log(JSON.stringify(r));
  await browser.close();
} finally {
  if (server) try { execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" }); } catch { /* gone */ }
}
