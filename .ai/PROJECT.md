# Babylon FPS

## Project

Babylon FPS is a browser-based survival zombie FPS.

The game is built with:

- Three.js
- cannon-es
- Vite
- JavaScript ES modules

Do NOT migrate to:
- React
- Next.js
- TypeScript
- Babylon.js

unless explicitly requested.

## Current Gameplay

The game currently has:

- 3D player
- FPS/third-person camera system
- WASD movement
- sprint
- jump
- pointer lock
- Cannon physics
- player collision
- static world collision
- dynamic ground chunks
- animated player
- zombie/monster
- zombie detection
- zombie chase
- zombie attack
- player health
- damage overlay
- basic HUD
- environment models
- loading screen

## Game Goal

Transform the prototype into a scalable survival zombie FPS.

Core loop:

Player
→ zombies spawn
→ zombies chase
→ player shoots
→ zombies die
→ score increases
→ waves become harder
→ player eventually dies
→ game over
→ restart

## Performance Goal

The game must support large zombie populations.

Target:

- 25 zombies: smooth
- 50 zombies: smooth
- 75 zombies: playable
- 100 zombies: architectural stress target

Performance is more important than unnecessary visual complexity.

## Important Rules

1. Do not rewrite working systems unnecessarily.
2. Inspect existing code before modifying it.
3. Reuse existing Three.js resources.
4. Avoid per-frame allocations.
5. Avoid unnecessary physics bodies.
6. Use pooling for zombies.
7. Use distance-based AI updates.
8. Use LOD where useful.
9. Keep HUD updates efficient.
10. Measure performance before optimizing blindly.