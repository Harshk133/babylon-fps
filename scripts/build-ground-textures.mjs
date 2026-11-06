// Ground textures for the terrain shader, from Poly Haven (CC0, https://polyhaven.com):
//   grass  aerial_grass_rock         earth  red_laterite_soil_stones
//   rock   rocky_terrain_02          sand   aerial_beach_01
// The 1k colour + OpenGL normal JPEGs go in public/texture/ground/src/ (gitignored;
// see public/texture/ground/CREDITS.md for where they're from). This writes:
//   {grass,earth,rock,sand}.webp   colour, 1024², sRGB
//   normals_a.webp (512²)          grass normal XY in RG, earth normal XY in BA
//   normals_b.webp                 rock normal XY in RG, sand normal XY in BA
// (two normal maps per texture keeps the shader's sampler count down)
//
//   node scripts/build-ground-textures.mjs

import sharp from "sharp";
import path from "node:path";

const DIR = "public/texture/ground";
const SRC = path.join(DIR, "src");
const LAYERS = { grass: "aerial_grass_rock", earth: "red_laterite_soil_stones", rock: "rocky_terrain_02", sand: "aerial_beach_01" };
const SIZE = 1024;
const NSIZE = 512;   // normals: fine detail survives half size, and it quarters the download

for (const [name, id] of Object.entries(LAYERS)) {
  await sharp(path.join(SRC, `${id}_Diffuse.jpg`)).resize(SIZE, SIZE).webp({ quality: 82 }).toFile(path.join(DIR, `${name}.webp`));
  console.log(`${name}.webp`);
}

async function rg(id) {
  const { data } = await sharp(path.join(SRC, `${id}_nor_gl.jpg`)).resize(NSIZE, NSIZE).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return data; // RGB, 3 bytes a pixel
}
for (const [out, a, b] of [["normals_a", "grass", "earth"], ["normals_b", "rock", "sand"]]) {
  const A = await rg(LAYERS[a]), B = await rg(LAYERS[b]);
  const px = Buffer.alloc(NSIZE * NSIZE * 4);
  for (let i = 0, j = 0; i < NSIZE * NSIZE; i++, j += 3) {
    px[i * 4] = A[j]; px[i * 4 + 1] = A[j + 1]; px[i * 4 + 2] = B[j]; px[i * 4 + 3] = B[j + 1];
  }
  await sharp(px, { raw: { width: NSIZE, height: NSIZE, channels: 4 } }).webp({ quality: 80, alphaQuality: 80 }).toFile(path.join(DIR, `${out}.webp`));
  console.log(`${out}.webp`);
}
