// Pins out in the world: a light pillar standing on each pin (pooled, always in
// the scene so it never compiles a shader mid-game), an on-screen marker with
// the distance that sticks to the screen edge when the pin is off to the side,
// and the PUBG-style compass tape along the top of the screen with every pin's
// bearing on it. DOM is only written when a value it shows changes.

import * as THREE from "three";
import { groundHeight } from "../world/Terrain.js";
import { bearingDeg } from "./WorldMap.js";

const MAX_PINS    = 8;
const PILLAR_H    = 70;
const COMPASS_FOV = 120;  // degrees of heading shown across the tape
const COMPASS_HZ  = 20;
const EDGE_PAD    = 34;   // px kept between an edge-clamped marker and the screen edge
const LABELS = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };

const _v = new THREE.Vector3();

function pillarTexture() {
  const c = document.createElement("canvas");
  c.width = 1; c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0.95)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Waypoints {
  constructor(scene) {
    const tex = pillarTexture();
    const pillarGeo = new THREE.CylinderGeometry(0.45, 0.45, PILLAR_H, 10, 1, true).translate(0, PILLAR_H / 2, 0);
    const ringGeo = new THREE.RingGeometry(0.9, 1.25, 32).rotateX(-Math.PI / 2);
    this.slots = [];
    for (let i = 0; i < MAX_PINS; i++) {
      const common = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, fog: false };
      const pillar = new THREE.Mesh(pillarGeo, new THREE.MeshBasicMaterial({ ...common, map: tex, opacity: 0.6 }));
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ ...common, opacity: 0.8 }));
      ring.position.y = 0.08;
      const root = new THREE.Group();
      root.add(pillar, ring);
      root.visible = false;
      pillar.renderOrder = ring.renderOrder = 3;
      scene.add(root);

      const mark = document.createElement("div");
      mark.className = "wp-mark";
      mark.innerHTML = '<i></i><span></span>';
      document.body.append(mark);
      this.slots.push({ id: null, root, pillar, ring, mark, text: mark.querySelector("span"), shown: "", pos: "", color: "" });
    }
    this.pins = new Map();

    // Compass tape
    this.compass = document.createElement("div");
    this.compass.id = "compass";
    this.compassCanvas = document.createElement("canvas");
    this.compassDeg = document.createElement("div");
    this.compassDeg.className = "cp-deg";
    this.compass.append(this.compassCanvas, this.compassDeg);
    document.body.append(this.compass);
    this.cctx = this.compassCanvas.getContext("2d");
    this._cNext = 0;
    this._cKey = "";
    this._degText = "";
    this.visible = true;
    // The tape is drawn once: redraw it when the HUD font (Teko) has arrived
    document.fonts?.ready.then(() => { this._tape = null; this._cKey = ""; });
  }

  /** pin: { x, z, color, label } or null. Same ids as WorldMap ("me" is yours). */
  set(id, pin) {
    if (pin) this.pins.set(id, pin);
    else this.pins.delete(id);
    // Give every pin a pooled slot
    const ids = [...this.pins.keys()].slice(0, MAX_PINS);
    this.slots.forEach((s, i) => {
      const pid = ids[i] ?? null;
      s.id = pid;
      const p = pid !== null ? this.pins.get(pid) : null;
      s.root.visible = !!p;
      if (!p) { s.mark.classList.remove("on"); s.shown = ""; return; }
      s.root.position.set(p.x, groundHeight(p.x, p.z), p.z);
      s.pillar.material.color.set(p.color);
      s.ring.material.color.set(p.color);
      if (s.color !== p.color) { s.color = p.color; s.mark.style.setProperty("--c", p.color); }
      s.mark.classList.toggle("mine", pid === "me");
    });
    this._cKey = "";
  }

  setVisible(on) {
    if (on === this.visible) return;
    this.visible = on;
    this.compass.classList.toggle("off", !on);
    for (const s of this.slots) if (s.id !== null) s.mark.classList.toggle("on", on && s.shown !== "");
  }

  /** me: { x, z, yaw } (yaw: forward = (sin, cos)). */
  update(now, me, camera) {
    const W = innerWidth, H = innerHeight;
    for (const s of this.slots) {
      if (s.id === null) continue;
      const p = this.pins.get(s.id);
      const dist = Math.hypot(p.x - me.x, p.z - me.z);
      // The pillar fades out as you arrive, so it doesn't fill the screen
      s.pillar.material.opacity = Math.min(0.6, Math.max(0.12, (dist - 4) / 30));
      if (!this.visible) continue;

      // Screen position of a point a little above the ground at the pin
      _v.set(p.x, s.root.position.y + 1.6, p.z).project(camera);
      let sx = (_v.x * 0.5 + 0.5) * W, sy = (-_v.y * 0.5 + 0.5) * H;
      const behind = _v.z > 1;
      const off = behind || sx < EDGE_PAD || sx > W - EDGE_PAD || sy < EDGE_PAD || sy > H - EDGE_PAD;
      if (off) {
        // Push it to the screen edge in the pin's direction (mirrored when behind)
        let dx = sx - W / 2, dy = sy - H / 2;
        if (behind) { dx = -dx; dy = -dy; }
        const t = Math.min((W / 2 - EDGE_PAD) / Math.abs(dx || 1e-6), (H / 2 - EDGE_PAD) / Math.abs(dy || 1e-6));
        sx = W / 2 + dx * t;
        sy = H / 2 + dy * t;
      }
      const shown = dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(1)} km`;
      if (shown !== s.shown) { s.shown = shown; s.text.textContent = shown; }
      const pos = `${Math.round(sx)},${Math.round(sy)},${off ? 1 : 0}`;
      if (pos !== s.pos) {
        s.pos = pos;
        s.mark.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px)`;
        s.mark.classList.toggle("edge", off);
      }
      s.mark.classList.add("on");
    }
    if (this.visible) this._drawCompass(now, me);
  }

  /** Ticks and letters for −FOV/2 … 360 + FOV/2 degrees, so any heading's window fits. */
  _buildTape(w, h, dpr, pxPerDeg) {
    const tape = document.createElement("canvas");
    const span = 360 + COMPASS_FOV;
    tape.width = Math.ceil(span * pxPerDeg * dpr);
    tape.height = Math.round(h * dpr);
    const ctx = tape.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (let d = -COMPASS_FOV / 2; d <= 360 + COMPASS_FOV / 2; d += 5) {
      const deg = ((d % 360) + 360) % 360;
      const x = (d + COMPASS_FOV / 2) * pxPerDeg;
      const label = LABELS[deg];
      const major = deg % 15 === 0;
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = label ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, h - 1);
      ctx.lineTo(x, h - (label ? 9 : major ? 7 : 4));
      ctx.stroke();
      if (label || major) {
        ctx.font = label ? "600 15px 'Teko', 'Segoe UI', sans-serif" : "500 11px 'Teko', 'Segoe UI', sans-serif";
        ctx.fillStyle = label === "N" ? "rgb(255,90,70)" : label ? "#fff" : "rgba(255,255,255,0.6)";
        ctx.fillText(label ?? String(deg), x, h - 12);
      }
    }
    return tape;
  }

  _drawCompass(now, me) {
    if (now < this._cNext) return;
    let heading = (-me.yaw * 180) / Math.PI % 360;
    if (heading < 0) heading += 360;
    let key = heading.toFixed(1);
    for (const p of this.pins.values()) key += `|${Math.round(bearingDeg(me.x, me.z, p.x, p.z))}`;
    if (key === this._cKey) return;
    this._cKey = key;
    this._cNext = now + 1000 / COMPASS_HZ;

    const cv = this.compassCanvas;
    const w = cv.clientWidth || 300, h = cv.clientHeight || 30;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); this._tape = null; }
    const ctx = this.cctx;
    const pxPerDeg = w / COMPASS_FOV;
    const rel = d => { let r = (d - heading) % 360; if (r > 180) r -= 360; if (r < -180) r += 360; return r; };
    // The ticks and letters are drawn once onto a long tape; each update just
    // slides it under the window (the CSS mask fades its ends)
    this._tape ??= this._buildTape(w, h, dpr, pxPerDeg);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(this._tape, Math.round(heading * pxPerDeg * dpr), 0, cv.width, cv.height, 0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Pins: a drop in their colour at their bearing (pinned to the tape's ends when outside)
    for (const p of this.pins.values()) {
      const r = rel(bearingDeg(me.x, me.z, p.x, p.z));
      const x = w / 2 + Math.max(-COMPASS_FOV / 2, Math.min(COMPASS_FOV / 2, r)) * pxPerDeg;
      const cx = Math.max(6, Math.min(w - 6, x));
      ctx.fillStyle = p.color;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx, 12);
      ctx.lineTo(cx - 5, 4);
      ctx.arc(cx, 4, 5, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    const deg = String(Math.round(heading) % 360).padStart(3, "0");
    if (deg !== this._degText) { this._degText = deg; this.compassDeg.textContent = deg; }
  }
}
