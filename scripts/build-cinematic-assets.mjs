// Planet textures for the opening cinematic (src/cinematic/), from Solar System Scope
// (https://www.solarsystemscope.com/textures/, CC BY 4.0, based on NASA imagery;
// see public/cinematic/CREDITS.md). The originals go in public/cinematic/src/
// (gitignored); this writes small WebP copies next to them. They're only fetched
// when the intro plays, never during a match.
//
//   node scripts/build-cinematic-assets.mjs

import sharp from "sharp";
import path from "node:path";

const DIR = "public/cinematic";
const SRC = path.join(DIR, "src");
const JOBS = [
  ["8k_earth_daymap.jpg", "earth_day.webp", 4096, 2048, 80],
  ["2k_earth_nightmap.jpg", "earth_night.webp", 2048, 1024, 70],
  ["2k_earth_clouds.jpg", "earth_clouds.webp", 2048, 1024, 72],
  ["2k_sun.jpg", "sun.webp", 1024, 512, 75],
  ["2k_jupiter.jpg", "jupiter.webp", 1024, 512, 75],
  ["2k_saturn.jpg", "saturn.webp", 1024, 512, 75],
  ["2k_mars.jpg", "mars.webp", 1024, 512, 75],
  ["2k_moon.jpg", "moon.webp", 1024, 512, 75],
];
for (const [src, out, w, h, q] of JOBS) {
  await sharp(path.join(SRC, src)).resize(w, h).webp({ quality: q }).toFile(path.join(DIR, out));
  console.log(out);
}
await sharp(path.join(SRC, "2k_saturn_ring_alpha.png")).resize(1024, 64).webp({ quality: 80, alphaQuality: 85 }).toFile(path.join(DIR, "saturn_ring.webp"));
console.log("saturn_ring.webp");
