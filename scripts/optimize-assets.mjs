// Shrinks the heavy world assets in public/ into "*.opt.glb" / "*.opt.jpg" next to
// the originals (which are left untouched). The game loads the .opt files when
// they exist and falls back to the originals otherwise.
//
//   npm run optimize-assets            # only (re)builds missing outputs
//   npm run optimize-assets -- --force # rebuild everything
//
// Per model: drop unused UV sets / tangents, weld + simplify (meshoptimizer),
// resize textures to WebP, quantize and meshopt-compress the geometry.
import { existsSync, statSync } from "node:fs";
import { NodeIO, TextureInfo } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  dedup, prune, weld, simplify, textureCompress, reorder, quantize, meshopt, resample, unpartition,
  compactPrimitive,
} from "@gltf-transform/functions";
import { MeshoptSimplifier, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";

// ratio: target fraction of indices kept; error: max deviation relative to mesh size
const MODELS = [
  { src: "public/trees/old_tree_with_vine_3d_model_free.glb", ratio: 0.04, error: 0.03, tex: 1024, prune: true },
  { src: "public/trees/dreftwood tree.glb",                   ratio: 0.06, error: 0.03, tex: 1024, prune: true },
  { src: "public/models/autorickshaw_3d_model_free.glb",      ratio: 0.1,  error: 0.01, tex: 1024 },
  { src: "public/models/rusty_roof_wooden_house_1_3d_model_free.glb", ratio: 0.5, error: 0.004, tex: 1024 },
  { src: "public/models/dragon_gold.glb",                     ratio: 0.5,  error: 0.004, tex: 1024 },
  // Hellhound: already low-poly; just WebP + quantize + meshopt
  { src: "public/models/zombie_dog_animation.glb",            ratio: 1,    error: 0,     tex: 1024 },
  // Player: keep only the clips Soldier.js plays (24 → 8), no simplification
  {
    src: "public/models/soldier/soldier.glb", ratio: 1, error: 0, tex: 1024,
    keepAnimations: ["Idle_Gun", "Run", "Run_Back", "Run_Left", "Run_Right", "Idle_Gun_Pointing", "Idle_Gun_Shoot", "Death"],
  },
];
const TEXTURES = [
  { src: "public/texture/grass2.jpg", size: 1024, quality: 82 },
];

const force = process.argv.includes("--force");
const optPath = (p, ext) => p.replace(/\.[^.]+$/, `.opt.${ext}`);
const mb = p => (statSync(p).size / 1048576).toFixed(1) + " MB";

/** Removes TEXCOORD_n sets no material reads, and tangents (three derives them). */
function stripUnusedAttributes() {
  return doc => {
    const used = new Set([0]);
    // Every TextureInfo (core + extension slots) records which UV set it samples
    for (const edge of doc.getGraph().listEdges()) {
      const child = edge.getChild();
      if (child instanceof TextureInfo) used.add(child.getTexCoord());
    }
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        for (const sem of prim.listSemantics()) {
          const m = /^TEXCOORD_(\d+)$/.exec(sem);
          if ((m && !used.has(Number(m[1]))) || sem === "TANGENT") prim.setAttribute(sem, null);
        }
      }
    }
  };
}

/**
 * Simplify with meshoptimizer's "Prune" flag, which also deletes small
 * disconnected pieces (individual leaves / vine strands) that ordinary edge
 * collapse can't touch. That's where nearly all of the tree triangles are.
 */
function simplifyPrune(ratio, error) {
  return doc => {
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const indices = prim.getIndices();
        const pos = prim.getAttribute("POSITION");
        if (!indices || !pos || prim.getMode() !== 4) continue;
        const src = new Uint32Array(indices.getArray());
        const positions = new Float32Array(pos.getArray());
        const target = Math.max(3, Math.floor((src.length * ratio) / 3) * 3);
        let [dst] = MeshoptSimplifier.simplify(src, positions, 3, target, error, ["Prune"]);
        // Triangle soup (no shared vertices) can't be edge-collapsed; fall back
        // to the topology-free clustering simplifier.
        if (dst.length > target * 2) [dst] = MeshoptSimplifier.simplifySloppy(src, positions, 3, null, target, error);
        indices.setArray(new Uint32Array(dst));
        compactPrimitive(prim);
      }
    }
  };
}

function countVerts(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) n += prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION").getCount();
  }
  return n;
}

await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder });

for (const m of MODELS) {
  const out = optPath(m.src, "glb");
  if (!existsSync(m.src)) { console.log(`skip (missing) ${m.src}`); continue; }
  if (existsSync(out) && !force) { console.log(`skip (exists)  ${out}`); continue; }
  const t0 = performance.now();
  const doc = await io.read(m.src);
  const before = countVerts(doc);
  if (m.keepAnimations) {
    for (const anim of doc.getRoot().listAnimations()) {
      const name = anim.getName().split("|").pop();
      if (!m.keepAnimations.includes(name)) anim.dispose();
    }
  }
  const steps = [stripUnusedAttributes(), dedup(), prune()];
  if (m.prune) {
    steps.push(weld(), simplifyPrune(m.ratio, m.error));
  } else if (m.ratio < 1) {
    steps.push(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: m.ratio, error: m.error, lockBorder: false }));
  }
  steps.push(
    resample(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [m.tex, m.tex], quality: 85 }),
    unpartition(),
    reorder({ encoder: MeshoptEncoder }),
    quantize(),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
  );
  await doc.transform(...steps);
  const after = countVerts(doc);
  await io.write(out, doc);
  console.log(`${m.src}\n  ${mb(m.src)} → ${mb(out)}   indices ${before.toLocaleString()} → ${after.toLocaleString()}   (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}

for (const t of TEXTURES) {
  const out = optPath(t.src, "jpg");
  if (!existsSync(t.src)) continue;
  if (existsSync(out) && !force) { console.log(`skip (exists)  ${out}`); continue; }
  await sharp(t.src).resize(t.size, t.size, { fit: "inside" }).jpeg({ quality: t.quality, mozjpeg: true }).toFile(out);
  console.log(`${t.src}\n  ${mb(t.src)} → ${mb(out)}`);
}
