import * as THREE from "three";
import * as CANNON from "cannon-es";
import { mergeStaticMeshes } from "./MergeStatic.js";
import { GROUP_WORLD } from "../physicsGroups.js";

// Dukaan stalls: a wooden counter under a striped tarp with shelves of
// biscuit packets and bottles, and a "DUKAAN" board. One in every named town,
// on the roadside facing the road. Walk up to the counter and press B to buy
// (src/economy/Shop.js). All the stalls are merged into one mesh per material
// (a handful of draw calls for the lot).

/** Where they stand: on a road, near a point, on a side of it (+1 = right of travel), metres off the centreline. */
export const SHOP_SPOTS = [
  { town: "Crossroads", road: "North Road", near: [8, 28], side: 1 },
  { town: "Ravencross", road: "North Road", near: [2, 122], side: 1 },
  { town: "Ashford", road: "Highway", near: [146, -29], side: -1 },
  { town: "Mill Creek", road: "North Road", near: [23, -144], side: -1 },
  { town: "Pine Hollow", road: "Highway", near: [-116, 7], side: 1 },
];
const OFFSET = 8.2;        // m from the road's centreline: past the power poles (5.9 m)
const W = 3.0, D = 1.6;    // stall footprint (front faces the road)
export const SHOP_RANGE = 3.4;

/** Resolves SHOP_SPOTS against the roads: [{ town, x, z, rot }] (rot turns its front, local +Z, toward the road). */
export function shopSpots(roads) {
  return SHOP_SPOTS.map(s => {
    const road = roads.byName(s.road);
    const at = roads.pointAt(road, roads.arcNear(road, s.near[0], s.near[1]));
    // Right of travel is (tz, −tx); the stall faces back toward the road
    const nx = at.tz * s.side, nz = -at.tx * s.side;
    return { town: s.town, x: at.x + nx * OFFSET, z: at.z + nz * OFFSET, rot: Math.atan2(-nx, -nz) };
  });
}

function boardTexture() {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#1f5f3a";
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = "#f2c94c";
  g.lineWidth = 8;
  g.strokeRect(6, 6, 500, 116);
  g.fillStyle = "#fff4d6";
  g.font = "bold 64px 'Arial Black', Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("दुकान · DUKAAN", 256, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function tarpTexture() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 8;
  const g = c.getContext("2d");
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? "#e8e0cf" : "#2f6fd1";
    g.fillRect(i * 16, 0, 16, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** One stall, facing +Z, origin on the ground at its centre. */
function buildStall(mats) {
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  };
  // Counter and back wall
  add(new THREE.BoxGeometry(W, 1.0, 0.6), mats.wood, 0, 0.5, D / 2 - 0.3);
  add(new THREE.BoxGeometry(W + 0.1, 0.06, 0.7), mats.woodDk, 0, 1.03, D / 2 - 0.3);
  add(new THREE.BoxGeometry(W, 2.3, 0.1), mats.woodDk, 0, 1.15, -D / 2 + 0.05);
  // Shelves with biscuit packets and bottles
  for (const y of [1.15, 1.65]) {
    add(new THREE.BoxGeometry(W - 0.2, 0.04, 0.32), mats.wood, 0, y, -D / 2 + 0.25);
    for (let i = 0; i < 9; i++) {
      const x = -W / 2 + 0.3 + i * 0.3;
      if ((i + (y > 1.4 ? 1 : 0)) % 3 === 0) add(new THREE.CylinderGeometry(0.05, 0.05, 0.24, 8), mats.bottle, x, y + 0.14, -D / 2 + 0.25);
      else add(new THREE.BoxGeometry(0.22, 0.07, 0.1), i % 2 ? mats.parle : mats.red, x, y + 0.06, -D / 2 + 0.25);
    }
  }
  // Corner posts, tarp roof sloping toward the road, and the board
  for (const [x, z] of [[-W / 2, D / 2], [W / 2, D / 2], [-W / 2, -D / 2], [W / 2, -D / 2]]) {
    add(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 6), mats.woodDk, x, 1.25, z);
  }
  add(new THREE.BoxGeometry(W + 0.5, 0.04, D + 0.9), mats.tarp, 0, 2.5, 0.25, 0.16);
  add(new THREE.BoxGeometry(2.4, 0.5, 0.05), mats.board, 0, 2.95, -D / 2 + 0.08);
  return g;
}

/**
 * Builds every stall. spots: shopSpots(); groundAt(x, z): the terrain.
 * Returns [{ town, x, z, rot, front: { x, z } }] (front: where you stand to buy).
 */
export function buildShops({ scene, world, material, spots, groundAt, mapObstacles, navObstacles }) {
  const mats = {
    wood: new THREE.MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.85 }),
    woodDk: new THREE.MeshStandardMaterial({ color: 0x5a3a20, roughness: 0.9 }),
    tarp: new THREE.MeshStandardMaterial({ map: tarpTexture(), roughness: 0.9 }),
    board: new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.6 }),
    parle: new THREE.MeshStandardMaterial({ color: 0xf4d34a, roughness: 0.5 }),
    red: new THREE.MeshStandardMaterial({ color: 0xd8262e, roughness: 0.5 }),
    bottle: new THREE.MeshStandardMaterial({ color: 0x3a8a3a, roughness: 0.3, metalness: 0.1 }),
  };
  const template = buildStall(mats);
  const all = new THREE.Group();
  const out = [];
  for (const s of spots) {
    const y = groundAt(s.x, s.z);
    const stall = template.clone(true);
    stall.position.set(s.x, y, s.z);
    stall.rotation.y = s.rot;
    all.add(stall);

    // Solid: the counter-and-wall block (you buy from the front, you can't walk through)
    const body = new CANNON.Body({ mass: 0, material, collisionFilterGroup: GROUP_WORLD });
    body.addShape(new CANNON.Box(new CANNON.Vec3(W / 2, 1.25, D / 2)), new CANNON.Vec3(0, 1.25, 0));
    body.position.set(s.x, y, s.z);
    body.quaternion.setFromEuler(0, s.rot, 0);
    world.addBody(body);
    const o = { type: "box", x: s.x, z: s.z, rot: s.rot, w: W, d: D, hw: W / 2, hd: D / 2, shop: true };
    mapObstacles.push(o);
    navObstacles.push(o);

    const fx = s.x + Math.sin(s.rot) * (D / 2 + 1.0), fz = s.z + Math.cos(s.rot) * (D / 2 + 1.0);
    out.push({ ...s, front: { x: fx, z: fz } });
  }
  // One mesh per material for every stall together
  mergeStaticMeshes(all);
  scene.add(all);
  all.updateMatrixWorld(true);
  all.traverse(o => { o.matrixAutoUpdate = false; });
  return out;
}
