# Babylon FPS Agent Instructions

## Before editing

Read:

.ai/PROJECT.md
.ai/ARCHITECTURE.md
.ai/CURRENT_TASK.md

Only inspect additional files when required.

## Rules

- Preserve working gameplay.
- JavaScript only.
- Three.js only.
- cannon-es remains the physics engine.
- Avoid unnecessary rewrites.
- Avoid unnecessary dependencies.
- Avoid per-frame allocations.
- Reuse Three.js resources.
- Use object pooling for frequently spawned objects.
- Keep zombie AI scalable.
- Keep HUD updates efficient.

## After editing

Run:

npm run build

Then report:

- files changed
- features implemented
- build status
- performance considerations
- remaining issues