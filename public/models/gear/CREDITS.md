# Helmet, vest and backpack models

All seven are from Sketchfab under the Creative Commons Attribution 4.0
International licence (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/).
The licence allows use in a public and commercial game, with credit, a link to
the licence and a note of what was changed. The game shows these credits on its
start screen.

| File | Model | Author | Source |
|---|---|---|---|
| helmet_1 | M1 Helmet | Melvin Stubbe | https://sketchfab.com/3d-models/m1-helmet-6d7929b10c994db0b6b39e35b379bfbd |
| helmet_2 | Hełm wz. 2005 (Helmet model 2005) | Armored Wave | https://sketchfab.com/3d-models/hem-wz-2005-helmet-model-2005-3bef9733977142599dc2275cf889fcef |
| helmet_3 | Combat helmet K6-3 | shamanoff | https://sketchfab.com/3d-models/combat-helmet-k6-3-94701874d8b949718708b018c8d4f61d |
| vest_1 | Military Armor 3D Model | Exactly | https://sketchfab.com/3d-models/military-armor-3d-model-7cab57de2b844a60a43af4fd8b61a4a4 |
| backpack_1 | Military Tactical Backpack | Liam3D | https://sketchfab.com/3d-models/military-tactical-backpack-9fa2da2c42234b58896e8d23393cac24 |
| backpack_2 | Low Poly Game Ready Military Tactical Backpack | DanlyVostok | https://sketchfab.com/3d-models/low-poly-game-ready-military-tactical-backpack-95a4fc7300584384b56ce3add58dbc9f |
| backpack_3 | Tactical Explorer Backpack | yronthal | https://sketchfab.com/3d-models/tactical-explorer-backpack-adc0e037e7ce458ebd5418ba8f30d22b |

**Changes made** (the `*.opt.glb` files the game loads, built by
`npm run optimize-assets`): materials converted from specular-glossiness to
metal-roughness, parts joined per material, meshes simplified (backpack_3 to
about 6k triangles, vest_1 from 21k to about 12k), geometry quantized and meshopt-compressed, textures resized
to 512 px and re-encoded as WebP. In the game they're turned, scaled and placed
to fit each character (the vest is stretched to each torso), the vest is
tinted per level, and they're also drawn as loot on the ground.

The original downloads (`*.glb` without `.opt`) stay on the developer's machine
and aren't committed.
