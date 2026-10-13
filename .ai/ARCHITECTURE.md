# Babylon FPS Architecture

## Current Entry Point

src/main.js

Currently contains most game systems.

This file is large and should gradually be modularized.

## Core Systems

### Rendering

Three.js scene
Three.js camera
WebGLRenderer
lighting
shadows
fog

### Physics

cannon-es

Used for:

- player
- static environment
- ground
- current zombie physics

Future zombie architecture should minimize expensive rigid-body simulation.

### Player

Current player systems include:

- movement
- jumping
- camera
- animation
- health

### Zombie

Current zombie system includes:

- model loading
- animation
- detection radius
- deaggression radius
- chase
- attack
- damage

Future architecture:

ZombieManager
→ ZombiePool
→ ZombieAI
→ ZombieSpawner

### World

Current world includes:

- dynamic ground chunks
- houses
- trees
- autorickshaw
- other GLB/WRL assets

### HUD

Currently:

- health bar
- health value
- damage overlay

Future:

- health
- ammo
- score
- wave
- zombie count
- kills
- crosshair
- hit marker
- game over