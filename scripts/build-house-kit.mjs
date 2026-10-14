// Packs the Kenney Building Kit + Furniture Kit pieces in public/models/house/source/
// into one public/models/house/house-kit.glb, so the game
// fetches a single file. Every piece becomes a top-level node named
// "b_<file>" (building) or "f_<file>" (furniture); the door's open/close
// animation clips are preserved.
//
//   npm run build-house-kit
import { readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { NodeIO, Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { mergeDocuments, dedup, prune, unpartition } from "@gltf-transform/functions";

const SRC = "public/models/house/source";
const OUT = "public/models/house/house-kit.glb";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const target = new Document();
const kitScene = target.createScene("kit");

for (const [dir, prefix] of [["building", "b"], ["furniture", "f"]]) {
  for (const file of readdirSync(join(SRC, dir)).filter(f => f.endsWith(".glb")).sort()) {
    const src = await io.read(join(SRC, dir, file));
    const name = `${prefix}_${basename(file, ".glb")}`;
    // Wrap each piece's scene roots in one named node
    const srcScene = src.getRoot().listScenes()[0];
    const wrapper = src.createNode(name);
    for (const child of srcScene.listChildren()) {
      srcScene.removeChild(child);
      wrapper.addChild(child);
    }
    srcScene.addChild(wrapper);
    const map = mergeDocuments(target, src);
    for (const scene of src.getRoot().listScenes()) {
      const merged = map.get(scene);
      for (const child of merged.listChildren()) kitScene.addChild(child);
      merged.dispose();
    }
  }
}
target.getRoot().setDefaultScene(kitScene);

// No quantize/meshopt: quantization compensates through node transforms, which
// would move the animated door's hinge pivot. The pieces are tiny anyway.
await target.transform(dedup(), prune(), unpartition());
await io.write(OUT, target);
console.log(`wrote ${OUT}: ${kitScene.listChildren().length} pieces, ${target.getRoot().listAnimations().length} clips`);
