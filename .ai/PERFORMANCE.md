# Babylon FPS Performance Rules

## Primary Target

Browser desktop game.

Target approximately:

60 FPS where hardware permits.

## Main Bottlenecks To Watch

1. Zombie AI
2. Animation mixers
3. Cannon physics
4. Draw calls
5. Shadow rendering
6. Large textures
7. Object creation
8. Garbage collection
9. DOM updates
10. Asset loading

## Zombie Rules

Never create unlimited zombies.

Use:

ZombiePool

instead of:

new zombie → scene.add()
death → scene.remove()
new zombie → scene.add()

Reuse zombie instances.

## AI Frequency

Suggested:

0–15m:
high frequency

15–40m:
medium frequency

40–80m:
low frequency

80m+:
sleep/deactivate expensive logic

## Physics

Do not create complex rigid-body interactions between every zombie.

Prefer:

- lightweight steering
- simple collision
- spatial queries
- pooled objects

## Rendering

Use:

- capped pixel ratio
- frustum culling
- LOD
- selective shadows
- shared materials
- shared geometries
- instancing for repeated static objects

## Hot Loop Rules

Avoid:

new Vector3()
new Raycaster()
new Array()
filter()
map()
sort()

inside large per-frame loops.

Reuse objects.

## DOM

Do not update HUD DOM every frame unless value changed.

Fast-changing debug metrics should update approximately 5–10 times/sec.