# Opening cinematic: planet textures

From **Solar System Scope** (https://www.solarsystemscope.com/textures/), licensed under
**Creative Commons Attribution 4.0** (https://creativecommons.org/licenses/by/4.0/); the maps are
based on NASA imagery. Credited in the game's Credits screen.

| File | Source |
| --- | --- |
| earth_day.webp | 8k_earth_daymap.jpg |
| earth_night.webp | 2k_earth_nightmap.jpg |
| earth_clouds.webp | 2k_earth_clouds.jpg |
| sun.webp, jupiter.webp, saturn.webp, mars.webp, moon.webp | 2k_*.jpg |
| saturn_ring.webp | 2k_saturn_ring_alpha.png |

Downloaded 2026-11-06. Changes: resized (Earth's day map to 4096×2048, the rest to 2048 or 1024
wide) and re-encoded as WebP by `node scripts/build-cinematic-assets.mjs` from the originals in
`src/` (not committed).

## Optional artwork

`krishna.webp` (not included): if you add commissioned or properly licensed artwork here, the intro
shows it inside the artifact instead of the image it draws in code. Credit its artist in
src/legal/credits.js.
