# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Babylon FPS is a browser-based survival zombie FPS built with **Three.js**, **cannon-es**, **Vite**, and plain JavaScript ES modules. Do NOT migrate to React, Next.js, TypeScript, or Babylon.js unless explicitly requested.

## Commands

```bash
npm run dev       # Start dev server (http://localhost:5173)
npm run build     # Production build → dist/
npm run preview   # Preview the production build locally
```

No test runner is configured.

## Architecture

### Entry point

`src/main.js` — monolithic file containing the render loop, physics world, player, camera, input, animation, lighting, and world-asset loading. It is intentionally large; modularize incrementally, not all at once.

### Zombie system (`src/zombies/`)

The zombie system is fully separated from `main.js`:

- **`ZombiePool`** — allocates and reuses a fixed set of MD2-based zombie instances (mesh + physics body + mixer). Inactive zombies are hidden at Y = −500 and put to sleep. `acquire(x, z)` / `release(zombie)` are the public API.
- **`ZombieManager`** — owns a `ZombiePool` and a shared `settings` object (detectionRadius, chaseSpeed, etc.). `update(delta)` drives per-zombie AI (detect → chase → attack) and all animation mixers. Damage to/from the player is passed via callbacks at construction time.

### Physics (`cannon-es`)

Four named `CANNON.Material` instances: `ground`, `character`, `static`, `monster`. Contact materials between them are registered at startup in `main.js`. All static world objects (houses, trees) use mass-0 bodies with the `static` material. Player uses a capsule compound body (two spheres + cylinder). Zombies also use capsule bodies but with zero friction on ground contact so steering remains direct.

### Ground

Infinite tiled ground rendered as a chunked grid (`GROUND_CHUNK_SIZE = 48`). The chunk grid updates every frame based on player position; a single flat `CANNON.Plane` covers all physics. Grass texture is shared across all chunk meshes via a single `THREE.MeshStandardMaterial`.

### World assets

`loadWorld()` in `main.js` loads GLB/WRL models and registers them in `editableModels` via `createEditableModel()`. Each editable model gets a lil-gui folder for live position/rotation/scale tuning. The "Log Coordinates to Console" button prints JSON of all positions so they can be hardcoded.

Scatter positions use a seeded LCG RNG (`makeLCG(0xdeadbeef)`) so the world layout is deterministic across reloads.

### Player (`src/player/Soldier.js` + `main.js`)

Over-the-shoulder camera with pointer lock: smoothed pivot follow, hip/aim/sprint rig presets blended by `aimBlend`/`sprintBlend`, boom collision via a cannon raycast against `GROUP_WORLD`, recoil + trauma shake. WASD is camera-relative; the body faces the aim direction (strafe mode). The controller owns `moveVelocity` and writes it to the body every frame, so player contacts are frictionless. Knockback is a separate decaying velocity added on top.

`Soldier` splits each clip into lower-body (legs/hips) and upper-body (Abdomen and children) actions. Legs blend Idle_Gun / Run / Run_Back / Run_Left / Run_Right by local velocity on a shared phase. The upper body cross-fades from locomotion to Idle_Gun_Pointing / Idle_Gun_Shoot when aiming or firing. A procedural spine twist (abdomen + chest) then points the gun along the camera yaw/pitch. The SMG is aligned to the right hand once at load, using the pointing pose.

### Combat (`src/combat/`)

- Hitscan from the camera through the crosshair (`world.raycastClosest`, mask `GROUP_WORLD | GROUP_ZOMBIE`). Zombie bodies carry `body.zombie` back-references. Hits above `MONSTER_TARGET_HEIGHT - WEAPON.headHeight` are headshots.
- `Effects` holds pooled tracers, one muzzle-flash sprite with a persistent point light (never added or removed, so no shader recompiles), and a single `Points` particle buffer.
- `Sfx` synthesizes all sounds with WebAudio, so there are no audio assets.
- Collision groups live in `src/physicsGroups.js`. Dying zombies switch to `GROUP_NONE`.
- `ZombieManager` handles hit flash, stagger and pain clips, death clips (the MD2 death/pain sequences are split into `death1..3` / `pain1..3`), corpse sinking then pool release, gunfire `alert()`, and a spawner that keeps `maxAlive` zombies around the player.

## Performance Rules

- **No per-frame heap allocation** in hot loops — reuse `THREE.Vector3`, `CANNON.Vec3`, etc.
- **Zombie pool only** — never `scene.add()` / `scene.remove()` per spawn/death.
- **AI distance tiers**: run full AI logic only for zombies within ~15 m; reduce update frequency at 15–40 m; skip or sleep at 80 m+.
- **HUD DOM** — only update when the displayed value actually changes.
- Shared geometry and materials across zombie instances; shared chunk geometry across ground tiles.
- Shadow map is 1024×1024; shadow frustum tracks the player rather than being world-wide.

## Asset paths

Static assets live in `public/` and are served at the root (`/models/…`, `/texture/…`, `/trees/…`). The Vite config sets `publicDir: "public"`. `public/` is gitignored.

Player assets (CC0, by Quaternius, via poly.pizza):
- `models/soldier/soldier.glb` is "Soldier": https://poly.pizza/m/oAArCNHjFB
- `models/soldier/smg.glb` is "Submachine Gun": https://poly.pizza/m/7ehatxr7FY

## Scene tuning workflow

1. `npm run dev`, open browser, use the lil-gui panel (top-right) to position/scale models.
2. Click "Log Coordinates to Console" → copy the JSON from DevTools.
3. Paste the coordinates back into `initialParams` in `loadWorld()`.
