// Mixamo FBX downloads → GLB, in the browser (three's FBXLoader + GLTFExporter),
// saved through the dev server (tools/mixamo/devPlugin.mjs) into
// public/models/mixamo/raw/. `npm run optimize-assets` then shrinks them
// (simplified meshes, WebP textures, meshopt) into public/models/mixamo/*.opt.glb.
//
//   characters/<file>.fbx → raw/char_<id>.glb   mesh + skeleton, no clips, standard materials
//   characters/<file>.glb → the same, for glTF characters rigged by Mixamo's auto-rigger
//                           (bone names like "Hips_01" → "Hips"). A rig made elsewhere
//                           won't fit the clips: upload the model to Mixamo to rig it.
//   anims/*.fbx           → raw/anims.glb        bare skeleton + the clips needed from the start
//                           raw/anims_extra.glb  the rest (deaths, swimming, climbing…), fetched after it
//
// Bone names lose Mixamo's "mixamorig:" / "mixamorig2" prefix everywhere
// ("Hips", "Spine1", "LeftHand"…), so any clip drives any character. Root
// motion is kept here; the game strips it (or uses it, for the wall climb).
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

// Character file → id (see src/player/Characters.js for what the game does with them)
const CHARACTERS = {
  "Double Dagger Stab.fbx": "vanguard",
  "Double Dagger Stab (1).fbx": "remy",
  "Double Dagger Stab (2).fbx": "ch15",
  "Double Dagger Stab (3).fbx": "medea",
};
// Animation file → clip name
const ANIMS = {
  "Rifle Idle.fbx": "idle",
  "Walking.fbx": "walk",
  "Fast Run.fbx": "run",
  "Sprint.fbx": "sprint",
  "Walking Backwards.fbx": "walk_back",
  "Left Strafe.fbx": "strafe_left",
  "Right Strafe Walking.fbx": "strafe_right",
  "Jumping.fbx": "jump",
  "Rifle Aiming Idle.fbx": "aim",
  "Firing Rifle.fbx": "fire",
  "Reloading.fbx": "reload",
  "Crouching Idle.fbx": "crouch_idle",
  "Crouched Walking.fbx": "crouch_walk",
  "Prone Idle.fbx": "prone_idle",
  "Prone Forward.fbx": "prone_crawl",
  "Sprint To Wall Climb.fbx": "climb",
  "Swimming.fbx": "swim",
  "Treading Water.fbx": "tread",
  "Goalie Throw.fbx": "throw",
  "Drinking.fbx": "drink",
  "Hard Landing.fbx": "land",
  // Deaths: picked by where the killing shot came from
  "Death From The Front.fbx": "death_front",
  "Death From The Back.fbx": "death_back",
  "Death From Right.fbx": "death_right",
  "Death From Front Headshot.fbx": "death_head_front",
  "Death From Back Headshot.fbx": "death_head_back",
  "Death.fbx": "death",
  "Dying.fbx": "dying",
};

const out = document.getElementById("out");
const log = s => { out.textContent += s + "\n"; console.log(s); };
// "mixamorig:Hips" / "mixamorig2Hips" / "Hips_01" → "Hips"
const plain = name => name.replace(/^mixamorig\d*:?/, "").replace(/_\d+$/, "");
// Clips the game needs from the first frame (the rest go in anims_extra.glb)
const CORE = new Set(["idle", "walk", "run", "sprint", "walk_back", "aim", "fire", "reload", "crouch_idle", "crouch_walk", "prone_idle", "prone_crawl", "jump", "drink"]);

async function save(name, data) {
  const r = await fetch(`/__mixamo/save/${encodeURIComponent(name)}`, { method: "POST", body: data });
  if (!r.ok) throw new Error(`save ${name}: ${r.status}`);
  log(`  saved raw/${name} (${(data.byteLength / 1048576).toFixed(2)} MB)`);
}

/** Loads an FBX and waits for its embedded textures to decode (the exporter needs the pixels). */
async function loadFbx(url) {
  // onLoad: the file and every texture its parse started have finished
  const manager = new THREE.LoadingManager();
  const ready = new Promise(r => { manager.onLoad = r; });
  const obj = await new FBXLoader(manager).loadAsync(url);
  await Promise.race([ready, new Promise(r => setTimeout(r, 60000))]);
  return obj;
}

/** Phong (what FBX gives) → standard: colour and normal maps; hair and lashes cut out, not blended. */
function toStandard(m) {
  const cutout = m.transparent || /hair|lash/i.test(m.name);
  return new THREE.MeshStandardMaterial({
    name: m.name,
    color: m.color, map: m.map ?? null,
    normalMap: m.normalMap ?? null,
    roughness: 0.78, metalness: 0,
    alphaTest: cutout ? 0.5 : 0, transparent: false,
    side: cutout ? THREE.DoubleSide : THREE.FrontSide,
  });
}

/**
 * One group per material: the FBX import can split a mesh into hundreds of
 * groups (Ch15: 264), which the exporter writes as a primitive (a draw call) each.
 */
function compactGroups(geo) {
  if (!geo.groups.length) return;
  if (!geo.index) {
    const n = geo.attributes.position.count, idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const src = geo.index.array, byMat = new Map();
  for (const g of geo.groups) {
    if (!byMat.has(g.materialIndex)) byMat.set(g.materialIndex, []);
    byMat.get(g.materialIndex).push(src.subarray(g.start, g.start + g.count));
  }
  const total = [...byMat.values()].flat().reduce((a, s) => a + s.length, 0);
  const dst = new Uint32Array(total);
  geo.clearGroups();
  let at = 0;
  for (const [mat, slices] of [...byMat.entries()].sort((a, b) => a[0] - b[0])) {
    const start = at;
    for (const s of slices) { dst.set(s, at); at += s.length; }
    geo.addGroup(start, at - start, mat);
  }
  geo.setIndex(new THREE.BufferAttribute(dst, 1));
}

/**
 * One skeleton for the whole character: some exports give each skinned mesh
 * its own copy of the bones (Vanguard: the visor), and a clip only drives the
 * copy it finds first. Every mesh is rebound to the biggest mesh's bones (by
 * name) and the spare copies are removed.
 */
function unifySkeletons(obj) {
  const skinned = [];
  obj.traverse(o => { if (o.isSkinnedMesh) skinned.push(o); });
  if (skinned.length < 2) return;
  const main = skinned.reduce((a, b) => (b.geometry.attributes.position.count > a.geometry.attributes.position.count ? b : a));
  const byName = new Map(main.skeleton.bones.map(b => [b.name, b]));
  const spareRoots = new Set();
  for (const m of skinned) {
    if (m === main || m.skeleton.bones.every(b => byName.get(b.name) === b)) continue;
    const bones = m.skeleton.bones.map(b => byName.get(b.name) ?? b);
    for (const b of m.skeleton.bones) {
      if (byName.get(b.name) === b) continue;
      let r = b;
      while (r.parent && r.parent.isBone) r = r.parent;
      spareRoots.add(r);
    }
    m.bind(new THREE.Skeleton(bones, m.skeleton.boneInverses), m.bindMatrix);
  }
  for (const r of spareRoots) if (!byName.has(r.name) || byName.get(r.name) !== r) r.parent?.remove(r);
}


const exporter = new GLTFExporter();
const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const list = await (await fetch("/__mixamo/list")).json();
const loaderOnly = new FBXLoader();

for (const file of list.characters) {
  const id = CHARACTERS[file];
  if (!id) { log(`skip ${file} (not in CHARACTERS)`); continue; }
  log(`character ${file} → ${id}`);
  const url = `/models/mixamo/characters/${encodeURIComponent(file)}`;
  const isGlb = /\.glb$/i.test(file);
  const obj = isGlb ? (await gltfLoader.loadAsync(url)).scene : await loadFbx(url);
  obj.animations = [];
  unifySkeletons(obj);
  obj.traverse(o => {
    if (o.isBone) o.name = plain(o.name);
    if (o.isMesh) {
      compactGroups(o.geometry);
      o.material = Array.isArray(o.material) ? o.material.map(toStandard) : toStandard(o.material);
    }
  });
  const glb = await exporter.parseAsync(obj, { binary: true, maxTextureSize: 2048, onlyVisible: false });
  await save(`char_${id}.glb`, glb);
}

// Animations: the first file's bare skeleton carries every clip
let skeleton = null;
const clips = [];
for (const file of list.anims) {
  const name = ANIMS[file];
  if (!name) { log(`skip ${file} (not in ANIMS)`); continue; }
  const obj = await loaderOnly.loadAsync(`/models/mixamo/anims/${encodeURIComponent(file)}`);
  const clip = obj.animations[0];
  clip.name = name;
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf(".");
    t.name = plain(t.name.slice(0, dot)) + t.name.slice(dot);
  }
  clips.push(clip);
  log(`clip ${file} → ${name} (${clip.duration.toFixed(2)} s, ${clip.tracks.length} tracks)`);
  if (!skeleton) {
    skeleton = obj;
    const meshes = [];
    obj.traverse(o => { if (o.isBone) o.name = plain(o.name); if (o.isMesh) meshes.push(o); });
    for (const m of meshes) m.parent.remove(m);
  }
}
if (skeleton) {
  await save("anims.glb", await exporter.parseAsync(skeleton, { binary: true, animations: clips.filter(c => CORE.has(c.name)) }));
  await save("anims_extra.glb", await exporter.parseAsync(skeleton, { binary: true, animations: clips.filter(c => !CORE.has(c.name)) }));
}
log("done");
window.__done = true;
