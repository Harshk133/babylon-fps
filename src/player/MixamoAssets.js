import * as THREE from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

// Loading and retargeting for the Mixamo characters (src/player/Soldier.js).
//
// Files (made by tools/mixamo/convert.html + `npm run optimize-assets`):
//   /models/mixamo/char_<id>.opt.glb   mesh + skeleton, bones named "Hips", "Spine"… (no clips)
//   /models/mixamo/char_<id>.lod1.glb  the same at ~25% of the triangles (far away)
//   /models/mixamo/anims.opt.glb       every clip on a bare skeleton
//
// Every file is fetched once and shared: each soldier clones the character's
// template (SkeletonUtils) and plays clips from its character's clip set.
//
// Clip preparation, once per clip (shared by every character):
//   - root motion out: the hips' forward / sideways travel over the clip is
//     removed (a linear trend, so the sway inside each step stays), keeping
//     the up-down bounce. Locomotion clips remember their travel speed, so the
//     game can play them at the rate that matches the ground speed.
//   - the wall climb also keeps its root motion as a curve: the climb move
//     follows the hands and feet on the wall.
// Then once per character: the hips' position keys are rescaled to that
// character's skeleton (Mixamo characters come in different units), tracks
// for bones the character doesn't have are dropped, and each clip is split
// into a lower-body (hips and legs) and an upper-body half for layering.

const ANIMS_URL = "/models/mixamo/anims.opt.glb";              // what the game needs from the start
const EXTRA_URL = "/models/mixamo/anims_extra.opt.glb";        // deaths, swimming, climbing, throwing…: after it
const LOWER = /^(Hips|LeftUpLeg|LeftLeg|LeftFoot|LeftToeBase|LeftToe_End|RightUpLeg|RightLeg|RightFoot|RightToeBase|RightToe_End)$/;

let _anims = null;
let _extra = null;
const _chars = new Map();     // id → Promise<template>

const trackBone = t => t.name.slice(0, t.name.lastIndexOf("."));

/**
 * The clip library: the core clips, loaded once. Resolves to { clips:
 * Map(name → clip), hipsY, speed: {name → units/s}, rootMotion, version };
 * loadExtraAnimations() adds the rest to the same object (version + 1).
 */
export function loadAnimations(loader) {
  _anims ??= loader.loadAsync(ANIMS_URL).then(gltf => {
    // Standing hips height of the clips' skeleton (idle, first frame): the reference for
    // every character's rescale, and the ceiling for the jump clips' hips
    const idleHips = gltf.animations.find(c => c.name === "idle")?.tracks.find(t => t.name === "Hips.position");
    const lib = { clips: new Map(), speed: {}, rootMotion: {}, hipsY: idleHips ? idleHips.values[1] : 100, version: 1 };
    prepareClips(gltf.animations, lib);
    return lib;
  }).catch(err => { _anims = null; throw err; });
  return _anims;
}

/** The rest of the clips (after the game has started): merged into the library. */
export function loadExtraAnimations(loader) {
  _extra ??= Promise.all([loadAnimations(loader), loader.loadAsync(EXTRA_URL)]).then(([lib, gltf]) => {
    prepareClips(gltf.animations, lib);
    lib.version++;
    return lib;
  }).catch(err => { _extra = null; throw err; });
  return _extra;
}

/** Root motion out (in place), travel speed and the climb's curve kept; scale tracks dropped. */
function prepareClips(list, lib) {
  for (const clip of list) {
    const hips = clip.tracks.find(t => t.name === "Hips.position");
    if (hips) {
      const v = hips.values, n = v.length / 3, T = hips.times[n - 1] || 1;
      const dx = v[(n - 1) * 3] - v[0], dz = v[(n - 1) * 3 + 2] - v[2];
      lib.speed[clip.name] = Math.hypot(dx, dz) / (clip.duration || 1);
      if (clip.name === "climb") {
        const rm = lib.rootMotion.climb = { times: Float32Array.from(hips.times), y: new Float32Array(n), z: new Float32Array(n) };
        for (let i = 0; i < n; i++) { rm.y[i] = v[i * 3 + 1] - v[1]; rm.z[i] = v[i * 3 + 2] - v[2]; }
      }
      // Linear trend out of x / z: in place, with the sway inside the cycle kept
      const out = new Float32Array(v);
      for (let i = 0; i < n; i++) {
        const k = hips.times[i] / T;
        out[i * 3] = v[i * 3] - dx * k;
        out[i * 3 + 2] = v[i * 3 + 2] - dz * k;
        // The physics does the jumping: the jump / landing clips keep their crouch but not their lift
        if (clip.name === "jump" || clip.name === "land") out[i * 3 + 1] = Math.min(v[i * 3 + 1], lib.hipsY);
      }
      // The climb also loses its climb: the game moves the body along rootMotion.climb
      if (clip.name === "climb") for (let i = 0; i < n; i++) out[i * 3 + 1] = v[1];
      hips.values = out;
    }
    clip.tracks = clip.tracks.filter(t => !t.name.endsWith(".scale"));
    lib.clips.set(clip.name, clip);
  }
  // An empty-handed idle: the first moments of the drinking clip (standing at ease)
  const drink = lib.clips.get("drink");
  if (drink && !lib.clips.has("relax")) lib.clips.set("relax", sampleClip(drink, "relax", 0, 22 / 30, 12));
}

/**
 * A stretch of a clip [t0, t1] as a new clip, every track sampled at n + 1 times
 * through its own interpolation. (AnimationUtils.subclip keeps only the keys
 * inside the range: an optimised track with no key there is dropped, and that
 * bone falls back to the bind pose, a T-pose.) Loops: the last sample is the first.
 */
function sampleClip(clip, name, t0, t1, n) {
  const span = t1 - t0, times = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) times[i] = (i / n) * span;
  const tracks = clip.tracks.map(t => {
    const interp = t.createInterpolant(), size = t.getValueSize(), values = new Float32Array((n + 1) * size);
    for (let i = 0; i <= n; i++) values.set(interp.evaluate(t0 + (i === n ? 0 : (i / n) * span)), i * size);
    return new t.constructor(t.name, times, values);
  });
  return new THREE.AnimationClip(name, span, tracks);
}

/**
 * A character's template, loaded once: { scene, lod (geometry by mesh name, or
 * null), height, hipsY, def }. scene stays in its bind pose; clone it per soldier.
 */
export function loadCharacter(loader, def) {
  if (!_chars.has(def.id)) {
    const base = `/models/mixamo/char_${def.id}`;
    const p = Promise.all([
      loader.loadAsync(`${base}.opt.glb`),
      loader.loadAsync(`${base}.lod1.glb`).catch(() => null),
    ]).then(([gltf, lodGltf]) => {
      const scene = gltf.scene;
      scene.updateMatrixWorld(true);
      const hips = scene.getObjectByName("Hips");
      // Height from the skinned vertices in the bind pose (bones and bounds of the nodes don't say)
      const box = new THREE.Box3(), v = new THREE.Vector3();
      scene.traverse(o => {
        if (!o.isSkinnedMesh) return;
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i += 7) { o.getVertexPosition(i, v); box.expandByPoint(v.applyMatrix4(o.matrixWorld)); }
      });
      const lod = {};
      lodGltf?.scene.traverse(o => { if (o.isMesh) lod[o.name] = o.geometry; });
      return {
        def, scene,
        lod: Object.keys(lod).length ? lod : null,
        height: box.max.y - box.min.y || 1,
        floor: box.min.y,
        hipsY: hips ? hips.position.y : 1,
        bones: new Set(collectBones(scene)),
        clipSets: null,
      };
    });
    p.catch(() => _chars.delete(def.id));
    _chars.set(def.id, p);
  }
  return _chars.get(def.id);
}

function collectBones(root) {
  const names = [];
  root.traverse(o => { if (o.isBone) names.push(o.name); });
  return names;
}

function scaled(track, k) {
  const c = track.clone();
  for (let i = 0; i < c.values.length; i++) c.values[i] *= k;
  return c;
}

/** Clones a template's scene for one soldier (its own skeleton and materials). */
export function cloneCharacter(template) {
  const scene = cloneSkinned(template.scene);
  scene.traverse(o => {
    if (!o.isMesh) return;
    o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
  });
  return scene;
}

/**
 * The clips retargeted to one character, built once per character:
 * { full, upper, lower } maps of name → AnimationClip, plus speed (m/s at
 * scale 1 per unit of the character's own height) and rootMotion.
 */
export function clipSetFor(template, anims) {
  if (template.clipSets?.version === anims.version) return template.clipSets;
  // Clip hips units → this character's hips units
  const ratio = template.hipsY / anims.hipsY;
  const set = template.clipSets ?? { full: new Map(), upper: new Map(), lower: new Map(), speed: {}, rootMotion: {} };
  const { full, upper, lower } = set;
  for (const [name, clip] of anims.clips) {
    if (full.has(name)) continue;   // built already (this runs again when the extra clips arrive)
    const tracks = [];
    for (const t of clip.tracks) {
      if (!template.bones.has(trackBone(t))) continue;   // a bone this character doesn't have
      tracks.push(t.name === "Hips.position" ? scaled(t, ratio) : t);
    }
    full.set(name, new THREE.AnimationClip(name, clip.duration, tracks));
    upper.set(name, new THREE.AnimationClip(`${name}.upper`, clip.duration, tracks.filter(t => !LOWER.test(trackBone(t)))));
    lower.set(name, new THREE.AnimationClip(`${name}.lower`, clip.duration, tracks.filter(t => LOWER.test(trackBone(t)))));
  }
  // Clip travel in the character's own units → metres is done by the soldier (it knows its scale)
  for (const [k, s] of Object.entries(anims.speed)) set.speed[k] = s * ratio;
  if (anims.rootMotion.climb && !set.rootMotion.climb) {
    const rm = anims.rootMotion.climb;
    set.rootMotion.climb = { times: rm.times, y: rm.y.map(x => x * ratio), z: rm.z.map(x => x * ratio) };
  }
  set.version = anims.version;
  template.clipSets = set;
  return set;
}
