// Packs every sound in public/sounds/ (<group>_<n>.ogg, listed in
// manifest.json) into one file, so the game makes one request for its ~120
// samples instead of one each (on a phone, each request costs a round trip).
//
//   public/sounds/pack.bin   the .ogg files back to back
//   public/sounds/pack.json  { group: [[offset, length], …], … }
//
// Sfx.preload() reads the pack and slices it; without it, it falls back to
// the separate files. Runs before every build (npm "prebuild").
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("public/sounds");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const index = {};
const parts = [];
let offset = 0;
for (const [group, n] of Object.entries(manifest)) {
  index[group] = [];
  for (let i = 0; i < n; i++) {
    const file = path.join(dir, `${group}_${i}.ogg`);
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    index[group].push([offset, buf.length]);
    parts.push(buf);
    offset += buf.length;
  }
}
fs.writeFileSync(path.join(dir, "pack.bin"), Buffer.concat(parts));
fs.writeFileSync(path.join(dir, "pack.json"), JSON.stringify(index));
console.log(`pack-sounds: ${parts.length} sounds, ${(offset / 1024).toFixed(0)} KB`);
