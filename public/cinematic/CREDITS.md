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

## Bal Gopal artwork

`krishna_open.webp`, `krishna_closed.webp`, `krishna_mask.png`: the devotional artwork of Lord
Krishna with the universe in His mouth, by **@worldofluvan** (signature kept in the image),
supplied by the developer. Make sure you have the artist's permission before publishing the game.
Built with Blender's Python by `scripts/build-krishna-intro.py` from `src/krishna.jpg` (not
committed): `_open` is the artwork re-encoded, `_closed` has the mouth closed in a gentle smile
(skin diffused in, lips painted, chin lifted), `_mask` marks the mouth's inside and lips.
