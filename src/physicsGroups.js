// Collision filter groups shared by the player, zombies, raycasts and the world.
// Bodies that don't set a group (ground, houses, trees) default to WORLD.
export const GROUP_WORLD  = 1;
export const GROUP_PLAYER = 2;
export const GROUP_ZOMBIE = 4;
export const GROUP_PROJECTILE = 8; // grenades / molotovs: hit world + zombies, pass through the player
export const GROUP_GLASS  = 16; // window panes: block the player + zombies, but not bullets, grenades or the camera
export const GROUP_NONE   = 0; // dying zombies: no contacts, invisible to bullets
