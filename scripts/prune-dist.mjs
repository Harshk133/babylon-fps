// Before packaging the mobile app: Vite copies all of public/ into dist/,
// including the heavy original models that stay local and uncommitted (the
// game only loads the *.opt.* copies). This deletes from dist/ every public
// file that git doesn't track, plus the house-kit sources, so the APK carries
// only what the game uses (~13 MB instead of ~300 MB).
//
//   node scripts/prune-dist.mjs

import { execSync } from "node:child_process";
import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const tracked = new Set(
  execSync("git ls-files public", { encoding: "utf8" })
    .split("\n").filter(Boolean).map(p => p.replace(/^public\//, "")),
);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (!existsSync("dist")) {
  console.error("dist/ not found: run `vite build` first");
  process.exit(1);
}

let removed = 0, bytes = 0;
for (const file of walk("public")) {
  const rel = relative("public", file).split(sep).join("/");
  const unused = !tracked.has(rel) || rel.startsWith("models/house/source/");
  const target = join("dist", rel);
  if (unused && existsSync(target)) {
    bytes += statSync(target).size;
    rmSync(target);
    removed++;
  }
}
console.log(`prune-dist: removed ${removed} unused files (${(bytes / 1e6).toFixed(1)} MB) from dist/`);
