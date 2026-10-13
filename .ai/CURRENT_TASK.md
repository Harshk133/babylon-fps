# Current Task

Implement zombie pooling.

## Goal

Support approximately 100 active zombie instances without creating
and destroying Three.js objects repeatedly.

## Existing System

Zombie logic currently lives in:

src/main.js

Relevant existing functions:

- loadMonster()
- updateMonster()
- setMonsterAnimation()

Relevant objects:

- monsterRoot
- monsterBody
- monsterMixer

## Requirements

Create:

ZombieManager
ZombiePool

Do not rewrite player movement.

Do not rewrite world loading.

Do not change camera controls.

Preserve existing zombie animations.

## Performance Requirements

- reuse zombie objects
- avoid repeated GLTF loading
- avoid repeated AnimationMixer creation
- avoid unnecessary Cannon bodies
- avoid per-frame allocations

## Acceptance Criteria

- spawn 50 zombies
- kill zombies
- reuse dead zombies
- no visible zombie state leakage
- animations reset correctly
- health resets
- position resets
- physics resets