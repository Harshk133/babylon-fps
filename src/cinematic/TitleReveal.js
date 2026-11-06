import * as THREE from "three";

// Scene 08: the game's title, as real 3D-lit metal over the game world. The
// letters are drawn once on a canvas (the game's own title and typeface, Teko),
// a height map is blurred from them and turned into a normal map (bevelled,
// embossed edges), and the plane is shaded as polished gold with environment
// reflections; stacked darker copies behind give it depth, and a light sweeps
// across at the reveal so a glint runs along the letters. Golden dust drifts in
// front. Drawn on top of the game's frame (an overlay scene).

function letterCanvas(text, w, h, font) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.textAlign = "center";
  g.textBaseline = "middle";
  let size = h * 0.78;
  g.font = `700 ${size}px ${font}`;
  while (g.measureText(text).width > w * 0.94 && size > 20) { size -= 4; g.font = `700 ${size}px ${font}`; }
  g.fillStyle = "#fff";
  g.fillText(text, w / 2, h * 0.54);
  return c;
}

/** Height (blurred letters) → tangent-space normal map. */
function normalCanvas(src, blur) {
  const w = src.width, h = src.height;
  const hc = document.createElement("canvas");
  hc.width = w; hc.height = h;
  const hg = hc.getContext("2d");
  hg.filter = `blur(${blur}px)`;
  hg.drawImage(src, 0, 0);
  const hd = hg.getImageData(0, 0, w, h).data;
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const og = out.getContext("2d");
  const img = og.createImageData(w, h), d = img.data;
  const H = (x, y) => hd[((Math.min(h - 1, Math.max(0, y)) * w) + Math.min(w - 1, Math.max(0, x))) * 4 + 3] / 255;
  const k = 5.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * k, dy = (H(x, y + 1) - H(x, y - 1)) * k;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      d[i] = (-dx / l * 0.5 + 0.5) * 255;
      d[i + 1] = (dy / l * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

export class TitleReveal {
  constructor({ title, envMap, lite = false }) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 100);
    this.camera.position.set(0, 0, 10);
    this.disposables = [];
    const keep = o => { this.disposables.push(o); return o; };
    const W = lite ? 1536 : 2048, H = Math.round(W / 4);
    const font = "Teko, 'Bahnschrift', 'Segoe UI', sans-serif";
    const letters = letterCanvas(title, W, H, font);
    const normal = keep(new THREE.CanvasTexture(normalCanvas(letters, lite ? 3 : 4)));
    normal.colorSpace = THREE.NoColorSpace;
    const alpha = keep(new THREE.CanvasTexture(letters));
    // Brushed gold with a darker engraved line inside each stroke
    const col = document.createElement("canvas");
    col.width = W; col.height = H;
    const cg = col.getContext("2d");
    const grad = cg.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#fff3c4"); grad.addColorStop(0.42, "#e0a93a"); grad.addColorStop(0.58, "#8f5c12"); grad.addColorStop(1, "#f6d27c");
    cg.fillStyle = grad;
    cg.fillRect(0, 0, W, H);
    cg.globalAlpha = 0.06;
    for (let i = 0; i < 900; i++) { cg.fillStyle = Math.random() < 0.5 ? "#fff" : "#000"; cg.fillRect(Math.random() * W, Math.random() * H, Math.random() * 90, 1); }
    const map = keep(new THREE.CanvasTexture(col));
    map.colorSpace = THREE.SRGBColorSpace;
    this.mat = keep(new THREE.MeshStandardMaterial({
      map, normalMap: normal, normalScale: new THREE.Vector2(1.4, 1.4), alphaMap: alpha, transparent: true,
      metalness: 1, roughness: 0.2, envMap, envMapIntensity: 1.6, depthWrite: false,
    }));
    const aspect = W / H, h = 1.55;
    const geo = keep(new THREE.PlaneGeometry(h * aspect, h));
    this.group = new THREE.Group();
    // Depth: darker copies stepped back and down, like an extruded block
    const depthMat = keep(new THREE.MeshStandardMaterial({ color: 0x3a2508, metalness: 0.8, roughness: 0.5, alphaMap: alpha, transparent: true, depthWrite: false, envMap, envMapIntensity: 0.6 }));
    const layers = lite ? 6 : 12;
    for (let i = layers; i >= 1; i--) {
      const m = new THREE.Mesh(geo, depthMat);
      m.position.set(i * 0.004, -i * 0.006, -i * 0.012);
      this.group.add(m);
    }
    this.face = new THREE.Mesh(geo, this.mat);
    this.group.add(this.face);
    this.scene.add(this.group);
    // Lights: a soft key, and the sweep
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.15));
    const key = new THREE.DirectionalLight(0xfff0d0, 1.6);
    key.position.set(-2, 3, 6);
    this.scene.add(key);
    this.sweep = new THREE.PointLight(0xfff4dc, 0, 6, 1.5);
    this.scene.add(this.sweep);
    // Golden dust
    const N = lite ? 300 : 800, p = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) p.set([(Math.random() - 0.5) * 14, (Math.random() - 0.5) * 7, Math.random() * 6 - 3], i * 3);
    const dg = keep(new THREE.BufferGeometry());
    dg.setAttribute("position", new THREE.BufferAttribute(p, 3));
    this.dustMat = keep(new THREE.PointsMaterial({ color: 0xffd48a, size: 0.035, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.dust = new THREE.Points(dg, this.dustMat);
    this.scene.add(this.dust);
    this.group.visible = false;
    this.t = 0;
  }

  /** t: seconds since the title began (negative before it). */
  update(t) {
    this.t = t;
    const on = t >= 0;
    this.group.visible = on;
    this.dustMat.opacity = THREE.MathUtils.smoothstep(t, -1.5, 1.5) * 0.85;
    this.dust.rotation.y = t * 0.02;
    this.dust.position.y = t * 0.03;
    if (!on) return;
    const k = THREE.MathUtils.smoothstep(t, 0, 1.6);
    this.mat.opacity = k;
    for (const m of this.group.children) if (m !== this.face) m.material.opacity = k;
    this.group.scale.setScalar(1.08 - 0.08 * (1 - Math.pow(1 - k, 3)));
    this.group.position.y = 0.55 + (1 - k) * -0.1;
    this.group.rotation.x = -0.06 + Math.sin(t * 0.4) * 0.015;
    this.group.rotation.y = Math.sin(t * 0.3) * 0.04;
    // The glint: a light crossing the letters once at the reveal, then slowly now and then
    const s = (t % 7) / 1.8;
    this.sweep.intensity = s < 1 ? 14 * Math.sin(s * Math.PI) : 0;
    this.sweep.position.set(THREE.MathUtils.lerp(-6, 6, Math.min(1, s)), 0.9, 1.2);
  }

  render(renderer) {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    // Keep the title inside narrow (portrait) screens
    this.camera.position.z = this.camera.aspect < 1.2 ? 10 * (1.2 / this.camera.aspect) : 10;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    for (const d of this.disposables) d.dispose?.();
    this.disposables.length = 0;
    this.scene.clear();
  }
}
