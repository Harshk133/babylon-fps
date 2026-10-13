# Gameplay Design

## Genre

Survival Zombie FPS

## Player

Health:
100

Player should have:

- movement
- sprint
- jump
- weapon
- ammo
- reload
- damage
- death

## Zombies

### Normal

Medium health
Medium speed
Medium damage

### Fast

Low health
High speed
Low damage

### Tank

High health
Low speed
High damage

## Waves

Wave difficulty increases through:

- zombie count
- spawn rate
- zombie speed
- zombie health
- zombie damage
- special zombie probability

## Combat

Weapons use hitscan where appropriate.

Raycast should originate from camera.

Zombie hit targets should be maintained separately from unrelated world meshes.

## Scoring

Kills increase score.

Headshots give additional score.

Wave completion can provide bonus score.

## Game States

MENU
LOADING
PLAYING
PAUSED
GAME_OVERASSE