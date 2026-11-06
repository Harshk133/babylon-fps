# Ground textures

All four are from **Poly Haven** (https://polyhaven.com), released under **CC0 1.0** (public domain,
https://creativecommons.org/publicdomain/zero/1.0/): free for any use, commercial included, no
attribution required (credited anyway, in the game's Credits screen).

| Game layer | Poly Haven asset | URL |
| --- | --- | --- |
| grass | Aerial Grass Rock | https://polyhaven.com/a/aerial_grass_rock |
| earth | Red Laterite Soil Stones | https://polyhaven.com/a/red_laterite_soil_stones |
| rock | Rocky Terrain 02 | https://polyhaven.com/a/rocky_terrain_02 |
| sand | Aerial Beach 01 | https://polyhaven.com/a/aerial_beach_01 |

Downloaded at 1k (colour + OpenGL normal), 2026-11-06. Changes: colour resized to 1024² and
re-encoded as WebP; normal maps resized to 512² and packed two per RGBA WebP (normals_a: grass
XY + earth XY, normals_b: rock XY + sand XY). Made by `node scripts/build-ground-textures.mjs`
from the originals in `src/` (not committed).
