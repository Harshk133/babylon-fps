# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Babylon FPS is a browser-based survival zombie FPS built with **Three.js**, **cannon-es**, **Vite**, and plain JavaScript ES modules. Do NOT migrate to React, Next.js, TypeScript, or Babylon.js unless explicitly requested.

## Commands

```bash
npm run dev       # Start dev server (http://localhost:5173)
npm run build     # Production build → dist/
npm run preview   # Preview the production build locally
npm run optimize-assets            # Build *.opt.glb / *.opt.jpg next to heavy assets in public/
npm run optimize-assets -- --force # Rebuild them all
npm run build-house-kit            # Pack public/models/house/source/** into house-kit.glb
npm run coop                       # Dev server on the LAN (vite --host); co-op relay at /ws
npm run coop:preview               # Same, but a production build
npm run relay                      # Standalone relay (PORT, default 8787) for hosting elsewhere
```

No test runner is configured.

## Architecture

### Entry point

`src/main.js` — monolithic file containing the render loop, physics world, player, camera, input, animation, lighting, and world-asset loading. It is intentionally large; modularize incrementally, not all at once.

### Monster system (`src/zombies/`)

Monsters are the Quake 2 MD2 player models from the three.js examples (`webgl_loader_md2`, `webgl_loader_md2_control`), stored in `public/models/md2/{ratamahatta,ogro}/` with several skins and separate MD2 weapon meshes.

- **`MonsterTypes.js`** holds pure data: `MONSTER_TYPES` (walker, runner, listener, gunner, brute, boss), with model, skins, weapons, height, HP, speed, melee, `sight` {range, fov}, `hearing` multiplier, `hunter`, `ranged`, `bigBody`, and pool size. It also defines `ENEMY_GUNS` (hitscan machinegun/shotgun, bolt blaster/plasma) and `getLevel(n)` (6 hand-made levels, then scaling).
- **`MonsterPool.js` (`MonsterPools`)** loads every body, skin and weapon once and prewarms one pool per type. Each instance has body mesh + mixer, an optional weapon mesh + mixer playing the same clip names (as `MD2Character` does), a capsule body, a "?"/"!" marker sprite, and per-skin `mats` {base, hit, burn}. `acquire(type, …)` / `release(m)`, with no scene add/remove.
- **`ZombieManager`** (targets come from `getTargets()`; see Co-op) runs a state machine per monster: wander → investigate ("?") → alert ("!", point animation and growl) → chase → search (last known position) → wander.
  - Sight: range × player visibility, FOV cone, and a line-of-sight raycast on `GROUP_WORLD` (glass doesn't block it). It builds an awareness meter and is throttled to `SENSE_INTERVAL`.
  - Hearing: `noise(x, z, radius, kind)` for `"step" | "shot" | "explosion" | "door"`. Hunter types (Listeners) charge at noises; others investigate them.
  - Ranged types hold a distance band, strafe, and fire in phases: cool → aim (red laser via `EnemyFire.laser`) → burst. Their aim lags the target.
  - Melee uses the attacker ring. Big bodies can't enter houses (`navigate(..., big)`).
  - Hooks: `onKill`, `onSpotted`, `onDoorBang`, `navigate`, `canSpawnAt`.
- **`LevelDirector.js`** runs intro → fight → cleared (intermission) → next level. It handles opening wave, spawn pacing, type mix from availability, the boss at `bossAt`, re-centring wanderer homes on the player, and recycling wanderers past 115 m. Kills are counted per `levelId`. The first level starts on first pointer lock, and death restarts the level.
- **`src/combat/EnemyFire.js`** holds pooled bolts (dodgeable, wall-checked, optional splash), hitscan rays on `GROUP_WORLD | GROUP_PLAYER` with coloured tracers, and aiming lasers (`beginFrame` / `laser` / `endFrame`).
- **`src/ui/GameHUD.js`** draws the level bar, banners, boss bar, damage-direction arcs (`dealDamageToPlayer(..., srcX, srcZ)`) and the noise meter. In `main.js`, `updatePlayerNoise()` emits footsteps (sprint 17 m, jog 8 m, sneak/aim 3.5 m) and `playerVisibility()` (sprint ×1.25, still ×0.85, dark house ×0.45).

### Co-op multiplayer (`server/`, `src/net/`)

- **`server/relay.mjs`** is a dumb WebSocket relay: rooms (max 8), names and colours, host election (the longest-connected player takes over if the host leaves), and forwarding (`to: id | "host"`, or everyone else). It's attached to the Vite dev/preview server at `/ws` by the plugin in `vite.config.js`, so the game and the relay share one origin. It can also run standalone.
- **`Net`** is the client (`on(type, fn)`, `send(msg)`, `isHost` / `isClient`). **`Lobby`** handles name and room entry (`?room=` prefills it), solo or co-op.
- **Authority:** the host runs `ZombieManager` + `LevelDirector` and streams `mon` snapshots (`MonsterSync`, 12 Hz: 12 numbers per monster) plus `lvl` (2 Hz) and `lev` events. Clients turn their pools into kinematic puppets (`pool.setPuppetMode(true)`), never run AI, and send `hit` / `noise` to the host. Every player streams `st` (20 Hz). `RemotePlayers` renders teammates (Soldier + name-tag sprite + kinematic capsule whose `body.playerTarget` makes them targetable).
- **Targets:** `ZombieManager` / `EnemyFire` take `getTargets()` (local + remote players) and report hits through `onPlayerHit(target, …)`, which sends `hurt` to a remote target. Monsters pick the seen/nearest player and switch to a much closer visible one.
- **Shared events:** `shot` (teammate tracers and sound), `throw` (every client simulates it; only the host's copy damages monsters, each client damages its own player), `door` / `light` / `world` (state for late joiners), `drop` (host-rolled loot), `kill` (credit to `lastHitBy`), `ef` (host's monster gunfire replayed as `visualOnly`), `wipe`.
- **Horde scaling:** `LevelDirector.playerCount` multiplies totals (+65% per extra player), max alive (+55%, cap 40) and Warlords (+1 at 3+ players). In co-op, death respawns you next to a teammate; the level restarts only when the whole squad is down for 4 s.

### Deployment

See `DEPLOY.md`. The game goes on Vercel (`vercel.json`) and the relay on Render (`render.yaml`, `server/package.json`), because Vercel can't hold WebSockets. `VITE_RELAY_URL` (build-time) points the client at the relay; unset, it uses the dev server's `/ws`. The relay's `ALLOWED_ORIGINS` limits which sites may connect. Only optimized runtime assets are committed (see `.gitignore` / `.vercelignore`), about 8 MB. `Soldier.js` and `loadGLB()` load `*.opt.glb` first.

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

- Hitscan from the camera through the crosshair (one ray per pellet) (`world.raycastClosest`, mask `GROUP_WORLD | GROUP_ZOMBIE`). Monster bodies carry `body.zombie` back-references. Hits in the top `HEAD_HEIGHT` (scaled by monster height) are headshots.
- `Effects` holds pooled tracers, one muzzle-flash sprite with a persistent point light (never added or removed, so no shader recompiles), and a single `Points` particle buffer.
- `Sfx` synthesizes all sounds with WebAudio, so there are no audio assets.
- Collision groups live in `src/physicsGroups.js`. Dying zombies switch to `GROUP_NONE`.
- `ZombieManager` handles hit flash, stagger and pain clips, death clips (the MD2 death/pain sequences are split into `death1..3` / `pain1..3`), corpse sinking then pool release, gunfire `alert()`, and a spawner that keeps `maxAlive` zombies around the player.

### Weapons, items & inventory

- **`src/combat/weapons.js`** holds pure data: `WEAPONS` (pistol, smg, shotgun, rifle, sniper; per-gun fire rate, mag, reserve, spread, recoil, pellets, aim FOV, sound profile), `THROWABLES`, `MEDKIT`, `GRENADE` / `MOLOTOV` tuning, and `PICKUP_KINDS`. Rebalance here.
- **`src/items/ItemModels.js`** builds low-poly procedural models (all guns except the held SMG GLB, plus grenade, molotov, ammo crate, medkit) with shared geometry/materials. Gun frame: origin is the grip, +X is the barrel, `userData.muzzle` is the barrel tip. `renderItemIcon()` renders white silhouettes for HUD icons once at boot.
- **`Inventory`** (`src/inventory/`) is pure state: one of each gun with its own `ammo` / `reserve`, throwable counts, and medkits. Every change bumps `version`. **`InventoryUI`** builds the hotbar, pickup prompt, pickup feed and the Tab inventory screen, and touches the DOM only when `version` changes.
- **`Pickups`** (`src/pickups/`) keeps pooled world pickups per kind. Entries are created on first need and hidden (not removed) on release. Guns need **E**; ammo, throwables and medkits are collected by walking over them. World loot is placed deterministically in `spawnWorldLoot()` (`main.js`), skipping spots over colliders, and zombies roll `DROP_TABLE` on death (timed drops).
- **`Throwables`** (`src/combat/Throwables.js`) uses a pool of physics projectiles (`GROUP_PROJECTILE`: hits world and zombies, passes through the player). Grenades explode on a fuse. Molotovs shatter on the first `collide` and leave a fire zone, with a scorch decal and a persistent light. Damage reaches `main.js` through `onExplode` / `onFireTick`. Hold **G** to show the trajectory arc and release to throw; **Q** switches type.
- `Soldier.setWeapon(id)` swaps the held model and muzzle. The procedural guns sit on the SMG's grip point.
- **`FireFX`** (`src/combat/FireFX.js`) is GPU fire and smoke modelled on three.js `webgpu_particles`, written as a WebGL `ShaderMaterial` on instanced billboards. Each particle's whole life (rise, drift, spin, grow, colour ramp, fade) is computed in the vertex shader from one shared time uniform and per-instance random attributes, so the CPU only moves emitter centres. It has pooled `ground` (molotov puddle), `body` (burning zombie), and one-shot `blast` (grenade) emitters. The shaders include the logdepth and fog chunks.
- Burning: `ZombieManager.ignite(zombie, seconds)` sets `burnTimer`. Burning zombies take `BURN_DPS` after leaving the flames, switch to the charred `burnMaterial`, and corpses smoulder. `FireFX.syncBodies()` keeps a body emitter on every burning zombie.
- `Effects` keeps a small CPU flame buffer (the flying molotov rag) plus the explosion flash sprite and one persistent light.

### Houses (`src/world/Houses.js`)

Enterable houses built from Kenney's CC0 Building Kit and Furniture Kit. The source GLBs and licences are in `public/models/house/source/`, and `npm run build-house-kit` packs them into one `house-kit.glb` (top-level nodes `b_<piece>` / `f_<piece>`; the door keeps its `open` / `close` clips).

- Every house shares one layout (`WALLS`, `FURNITURE`, `CEILING_LAMPS`). Static pieces are merged into one mesh per material once and reused, so a house is about 10 draw calls. Houses are scaled ×`HOUSE_SCALE` (1.2) so 2.4 m zombies fit through doors and under ceilings. `_toLocal()` / `_toWorld()` convert between world metres and kit units, and all layout constants are in kit units.
- Physics: one compound static body per house with a 0.4 m thick box per wall section (doorway jambs plus lintel; windows framed). Window holes are separate `GROUP_GLASS` bodies: they block the player and zombies but not bullets, grenades, the camera or grenade blasts. The door leaf is a kinematic box synced from the animated `door` node. Furniture gets oriented boxes. Everything uses the frictionless `staticMaterial`.
- Interaction: **O** / **C** open and close the nearest door (plays the kit clip; reversing mid-swing mirrors the time). **L** toggles the light switch inside (lever flips, lamp emissive on). Two shared point lights go to the nearest lit houses. Prompts are shown through `InventoryUI.setPrompts()`.
- Zombie pathing: `ZombieManager.navigate` is set to `houses.navigate()`, re-planned every 0.15 s per zombie. Zombies route around houses and editable props (`navObstacles`) via corner waypoints, line up with the doorway before walking through, and at a closed door return `2`: they bang on it (`onDoorBang` sound) and never attack through walls. `canSpawnAt` keeps spawns out of houses. `doorAssist()` nudges the player toward the door centreline.
- Grenade damage is shielded (×0.15) when a `GROUP_WORLD` ray from the blast to the target is blocked.

### Minimap (`src/ui/Minimap.js`)

A rotating radar on a 2D canvas, top right. It draws zombies (pulsing when chasing, orange when burning), pickups by category, fires, and obstacle footprints from `mapObstacles` (filled in by `addBoxCollider`, `addTreeCollider`, and live getters on editable models). Off-map weapons get edge arrows. It redraws at 30 Hz, not every frame. lil-gui is moved to the top-left in CSS.

## Performance Rules

- **Assets:** run `npm run optimize-assets` after adding or replacing a heavy model. `loadGLB()` loads `<name>.opt.glb` (meshopt-compressed, simplified, WebP textures) and falls back to the original. The script's `prune: true` mode uses meshoptimizer's Prune flag with a sloppy fallback for foliage triangle soups (the trees went from 6.3M to about 250k indices).
- **Loading:** the soldier, zombies and world download in parallel. `warmUpGpu()` compiles every program while the loading screen is up, including the zombie hit and burn materials and the fire shaders, so nothing compiles mid-fight.
- **Rendering:** no `logarithmicDepthBuffer` (it kills early-Z). Dynamic resolution (`updateDynamicResolution`) scales the pixel ratio between about 0.65 and min(dpr, 1.5) based on frame time. Static props and ground chunks call `freezeStatic()` (`matrixAutoUpdate = false`). Pickups don't cast shadows. At most 2 fire point lights, shared across molotov fires.
- VRML imports: strip the `Background` sky spheres (radius 10000), or they swallow the bounding box and collider.
- **cannon-es `Cylinder` is Y-aligned.** Don't rotate it 90° on X (old cannon.js habit): that lays capsules and tree trunks sideways.
- cannon `Box` collides with its convex polyhedron: after changing `halfExtents` call `updateConvexPolyhedronRepresentation()`. `createEditableModel()` does, and supports `perMeshColliders` (the WRL house) and `trunkCollider` (trees).
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
