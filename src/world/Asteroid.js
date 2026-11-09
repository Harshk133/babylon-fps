import * as THREE from "three";

// The doomsday asteroid: the burning rock crossing the sky (drawn in the backdrop
// scene, so the game camera's short far plane can't clip it) and the crater it
// leaves. The timing, the blast and the earthquake are in main.js.

export const ASTEROID_FLIGHT = 9;   // seconds from first sight to impact
const FROM = new THREE.Vector3(1050, 820, 620);   // where it comes from, relative to the impact
const CRATER_R = 30;

export class Asteroid {
  constructor({ backdropScene, scene, groundAt }) {
    this.scene = scene;
    this.groundAt = groundAt;
    const geo = new THREE.IcosahedronGeometry(1, 3);
    const p = geo.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      v.multiplyScalar(1 + 0.2 * Math.sin(v.x * 4.3) * Math.cos(v.y * 3.7 + v.z * 2.9));
      p.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    this.rockGeo = geo;
    this.group = new THREE.Group();
    this.group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.55, 0.12), fog: false })));
    const glow = new THREE.Mesh(new THREE.SphereGeometry(1.5, 18, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 0.5, 0.06), transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    const tail = new THREE.Mesh(new THREE.ConeGeometry(1.15, 7, 16, 1, true).translate(0, -3.5, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 0.5, 0.1), transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    this.tail = tail;
    this.group.add(glow, tail);
    this.group.visible = false;
    backdropScene.add(this.group);
    this.target = new THREE.Vector3();
    this.crater = null;
  }

  aim(x, z) {
    this.target.set(x, this.groundAt(x, z), z);
    this.group.visible = true;
    this.place(0);
    // The tail streams back along the way it came
    this.tail.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), FROM.clone().normalize());
  }

  /** k: 0 at first sight … 1 at impact; it gets faster as it comes. */
  place(k) {
    const f = 1 - k * k * k * 0.25 - k * 0.75;
    this.group.position.copy(this.target).addScaledVector(FROM, Math.max(0, f));
    this.group.scale.setScalar(26 + k * 18);
    this.group.rotation.x = k * 5;
    this.group.rotation.z = k * 3;
    this.tail.parent === this.group && this.tail.quaternion.set(0, 0, 0, 1);
  }

  hide() { this.group.visible = false; }

  /** The hole it leaves: scorched ground with a raised rim, the glowing rock half buried in the middle. */
  makeCrater(x, z) {
    this.clearCrater();
    const rings = 16, segs = 72, pos = [], col = [], idx = [];
    const c = new THREE.Color(), burnt = new THREE.Color(0x120d0a), earth = new THREE.Color(0x4a3524), lava = new THREE.Color(2.2, 0.55, 0.08);
    for (let r = 0; r <= rings; r++) {
      const t = r / rings, R = 0.5 + t * CRATER_R * 1.55;
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2, wob = 1 + 0.09 * Math.sin(a * 5) + 0.05 * Math.sin(a * 13);
        const px = x + Math.cos(a) * R * wob, pz = z + Math.sin(a) * R * wob;
        const rim = Math.exp(-((t - 0.62) ** 2) / 0.018) * 4.6;
        pos.push(px, this.groundAt(px, pz) + 0.25 + rim * (t < 1 ? 1 - Math.pow(t, 16) : 0), pz);
        c.copy(t < 0.15 ? lava : burnt).lerp(earth, Math.max(0, (t - 0.45) * 1.8));
        if (t > 0.92) c.lerp(earth, (t - 0.92) / 0.08);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segs; s++) {
        const a = r * (segs + 1) + s, b = a + segs + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const bowl = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    bowl.receiveShadow = true;
    const rock = new THREE.Mesh(this.rockGeo, new THREE.MeshStandardMaterial({ color: 0x1b1512, roughness: 0.95, emissive: 0xff5a10, emissiveIntensity: 1.1 }));
    rock.scale.setScalar(8);
    rock.position.set(x, this.groundAt(x, z) + 1, z);
    rock.castShadow = true;
    this.crater = new THREE.Group();
    this.crater.add(bowl, rock);
    this.scene.add(this.crater);
  }

  clearCrater() {
    if (!this.crater) return;
    this.scene.remove(this.crater);
    this.crater.children[0].geometry.dispose();
    this.crater = null;
  }
}
