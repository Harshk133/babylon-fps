// Stances: standing, crouching and prone ("lying on the ground"), as in PUBG.
// Lower stances move slower and quieter, are harder for monsters to spot, and
// are much harder to hit: the player's capsule shrinks, and both bullets
// (rays) and monster gunfire test against it, while monsters aim lower and
// lose sight of you behind a windowsill or a low wall. You can fire from any
// stance. Shared by the local player (main.js) and teammates (RemotePlayers).

export const STANCE_NAMES = ["stand", "crouch", "prone"];   // index = network code

export const STANCES = {
  //        move speed  camera pivot  capsule top sphere   monster aim / eye offsets   seen    heard
  stand:  { speed: 1,    eye: 1.55,   top: null,           aimOff: 0.15,  eyeOff: 0.4,   vis: 1,    noise: 1 },
  crouch: { speed: 0.5,  eye: 1.15,   top: -0.05,          aimOff: -0.25, eyeOff: -0.1,  vis: 0.7,  noise: 0.45 },
  prone:  { speed: 0.26, eye: 0.85,   top: -0.55,          aimOff: -0.6,  eyeOff: -0.45, vis: 0.45, noise: 0.25 },
};

/**
 * Shapes a capsule body built by addCapsuleToBody (sphere, cylinder, sphere,
 * centred on the body) for a stance. Crouched and prone, the cylinder is off
 * and the top sphere drops, so rays and bodies pass over where you were.
 * halfHeight: the standing top sphere's offset.
 */
export function setCapsuleStance(body, stance, halfHeight) {
  const s = STANCES[stance] ?? STANCES.stand;
  const standing = s.top === null;
  body.shapes[1].collisionResponse = standing;
  body.shapeOffsets[2].y = standing ? halfHeight : s.top;
  body.updateBoundingRadius();
  body.aabbNeedsUpdate = true;
}
