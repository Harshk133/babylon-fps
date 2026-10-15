import * as THREE from "three";

// Overhead monster health bars: every bar is one instance of a single
// billboarded quad, so they all draw in one call. Hellhounds and dragons
// (def.healthBar) always show theirs; other monsters once they're hurt.

const MAX_BARS   = 64;
const SHOW_RANGE = 48;   // metres
const TRAIL_RATE = 2.2;  // how fast the "recent damage" segment catches up

const VERT = /* glsl */ `
  attribute vec3 aPos;     // bar centre (world)
  attribute vec4 aData;    // hp, trail, width (m), alpha
  attribute vec3 aColor;   // type colour (frame accent)
  varying vec2 vUv;
  varying vec4 vData;
  varying vec3 vColor;
  varying vec2 vSize;
  void main() {
    vec4 mv = viewMatrix * vec4(aPos, 1.0);
    // Grow with distance so far bars stay readable
    float s = max(1.0, -mv.z / 16.0);
    vec2 size = vec2(aData.z, 0.11 + aData.z * 0.025) * s;
    mv.xy += position.xy * size;
    gl_Position = projectionMatrix * mv;
    vUv = uv;
    vData = aData;
    vColor = aColor;
    vSize = size;
  }
`;

const FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec4 vData;
  varying vec3 vColor;
  varying vec2 vSize;
  void main() {
    // Frame thickness in metres, so it stays even on wide and narrow bars
    vec2 px = vUv * vSize;
    float edge = min(min(px.x, vSize.x - px.x), min(px.y, vSize.y - px.y));
    float t = 0.022 * (vSize.y / 0.14);
    vec2 inner = (vUv * vSize - t) / max(vSize - 2.0 * t, 1e-4);
    vec3 col;
    float a = 0.85;
    if (edge < t) {
      col = mix(vec3(0.05), vColor, 0.55);
    } else if (inner.x < vData.x) {
      // Blood red that drains toward a dark ember as health falls
      vec3 hi = mix(vec3(0.95, 0.75, 0.2), vec3(0.95, 0.12, 0.08), smoothstep(0.65, 0.25, vData.x));
      col = mix(hi * 0.65, hi, inner.y);
    } else if (inner.x < vData.y) {
      col = vec3(1.0, 0.86, 0.7);
    } else {
      col = vec3(0.06, 0.03, 0.03);
      a = 0.6;
    }
    // Segment ticks every 10%
    if (edge >= t && fract(inner.x * 10.0) < 0.04 && inner.x < 0.99) col *= 0.55;
    gl_FragColor = vec4(col, a * vData.w);
  }
`;

export class HealthBars {
  constructor(scene) {
    const plane = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = plane.index;
    geo.setAttribute("position", plane.getAttribute("position"));
    geo.setAttribute("uv", plane.getAttribute("uv"));
    this.pos = new Float32Array(MAX_BARS * 3);
    this.data = new Float32Array(MAX_BARS * 4);
    this.color = new Float32Array(MAX_BARS * 3);
    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.dataAttr = new THREE.InstancedBufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aPos", this.posAttr);
    geo.setAttribute("aData", this.dataAttr);
    geo.setAttribute("aColor", this.colorAttr);
    geo.instanceCount = 0;
    this.geo = geo;

    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
    this._colors = new Map(); // css colour → THREE.Color
  }

  _color(css) {
    let c = this._colors.get(css);
    if (!c) { c = new THREE.Color(css); this._colors.set(css, c); }
    return c;
  }

  /** monsters: the active list (host or co-op puppets); viewer: {x, z}. */
  update(delta, monsters, viewer) {
    let n = 0;
    const k = 1 - Math.exp(-TRAIL_RATE * delta);
    for (const m of monsters) {
      if (n >= MAX_BARS) break;
      if (m.dying || !m.active) continue;
      const hp = Math.max(0, Math.min(1, m.health / m.maxHealth));
      if (m.hbTrail === undefined || m.hbTrail < hp) m.hbTrail = hp;
      m.hbTrail += (hp - m.hbTrail) * k;
      const def = m.def;
      if (def.boss || (!def.healthBar && hp >= 0.999)) continue;
      const p = m.body.position;
      const dx = p.x - viewer.x, dz = p.z - viewer.z;
      const d = Math.hypot(dx, dz);
      if (d > SHOW_RANGE) continue;
      const i3 = n * 3, i4 = n * 4;
      this.pos[i3] = p.x;
      this.pos[i3 + 1] = m.root.position.y + m.height + (def.flying ? 0.9 : 0.32);
      this.pos[i3 + 2] = p.z;
      this.data[i4] = hp;
      this.data[i4 + 1] = m.hbTrail;
      this.data[i4 + 2] = def.flying ? 2.6 : def.bigBody ? 1.2 : 0.85;
      this.data[i4 + 3] = Math.min(1, (SHOW_RANGE - d) / 8);
      const c = this._color(def.color);
      this.color[i3] = c.r; this.color[i3 + 1] = c.g; this.color[i3 + 2] = c.b;
      n++;
    }
    this.geo.instanceCount = n;
    if (n) {
      this.posAttr.addUpdateRange(0, n * 3);
      this.dataAttr.addUpdateRange(0, n * 4);
      this.colorAttr.addUpdateRange(0, n * 3);
      this.posAttr.needsUpdate = true;
      this.dataAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
    }
  }
}
