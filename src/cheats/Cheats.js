// Cheat codes: type one while playing (or send it in the chat box, which is how
// phones enter them). This file only knows the codes and reads the keyboard;
// main.js ("Cheats") applies them and shares them with the whole room.
//
// The letters are ordinary game keys too, so once two letters in a row match the
// start of a code the rest of it stops triggering actions. That's why no code
// starts with a key that interrupts play (I inventory, Y chat, O quick chat, H heal, G grenade…).

const RESET_AFTER = 2500; // ms between letters before you're starting over

export const CHEATS = [
  { id: "toon",   code: "TOONED",     label: "Cartoon world",       color: "#ffb13d", toggle: true, filter: true },
  { id: "bw",     code: "NOIRFILM",   label: "Black and white",     color: "#e8e8e8", toggle: true, filter: true },
  { id: "sketch", code: "PENCILIT",   label: "Pencil sketch",       color: "#c9c2ae", toggle: true, filter: true },
  { id: "tank",   code: "STEELBEAST", label: "Battle tank",         color: "#7ee05a" },
  { id: "plane",  code: "WINGSUP",    label: "Bomber plane",        color: "#6ab4ff" },
  { id: "rain",   code: "ROCKRAIN",   label: "Meteor shower",       color: "#ff6a3d" },
  { id: "moon",   code: "ANTIGRAV",   label: "Moon gravity",        color: "#b48cff", toggle: true },
  { id: "heads",  code: "BOBBLEHEAD", label: "Giant heads",         color: "#ff6ad5", toggle: true },
  { id: "loot",   code: "LOCKNLOAD",  label: "Everyone fully armed", color: "#ffe14d" },
  { id: "speed",  code: "TURBOLEGS",  label: "Super speed",         color: "#4dd2ff", toggle: true },
  // More picture styles
  { id: "thermal", code: "THERMALEYE", label: "Thermal vision",     color: "#ff5a2a", toggle: true, filter: true },
  { id: "pixel",  code: "PIXELPAST",  label: "8-bit world",         color: "#7dff6a", toggle: true, filter: true },
  { id: "rainc",  code: "DATASTORM",  label: "Digital rain",        color: "#3dff7a", toggle: true, filter: true },
  { id: "neon",   code: "NEONGRID",   label: "Neon outlines",       color: "#ff3df0", toggle: true, filter: true },
  { id: "acid",   code: "ACIDTRIP",   label: "Kaleidoscope trip",   color: "#ffe14d", toggle: true, filter: true },
  { id: "comic",  code: "POPCOMIC",   label: "Pop-art comic",       color: "#ff4b3a", toggle: true, filter: true },
  { id: "ascii",  code: "ASCIIWORLD", label: "Text-mode world",     color: "#9cffb0", toggle: true, filter: true },
  { id: "xray",   code: "XRAYBONES",  label: "X-ray",               color: "#6ad8ff", toggle: true, filter: true },
  // Super-weapons: every gun in the room fires this instead of bullets
  { id: "rail",   code: "RAILSTRIKE", label: "Railgun",             color: "#5de8ff", toggle: true, weapon: true },
  { id: "hole",   code: "BLACKHOLE",  label: "Black hole launcher", color: "#c07bff", toggle: true, weapon: true },
  { id: "bolt",   code: "SKYBOLT",    label: "Chain lightning",     color: "#bcd0ff", toggle: true, weapon: true },
  { id: "swarm",  code: "SWARMFIRE",  label: "Rocket swarm",        color: "#ffa23d", toggle: true, weapon: true },
  // The end of the world
  { id: "doom",   code: "DOOMROCK",   label: "Asteroid strike",     color: "#ff3a1a" },
];

const BY_CODE = new Map(CHEATS.map(c => [c.code, c]));
export const CHEAT_BY_ID = new Map(CHEATS.map(c => [c.id, c]));

export class CheatReader {
  /** onCode(cheat): a code was completed. */
  constructor(onCode) {
    this.onCode = onCode;
    this.buf = "";
    this.at = 0;
  }

  /** A key went down in play. True if it's part of a code and shouldn't act as a game key. */
  key(code, now = performance.now()) {
    if (!/^Key[A-Z]$/.test(code)) return false;
    if (now - this.at > RESET_AFTER) this.buf = "";
    this.at = now;
    let s = this.buf + code[3];
    // Keep the longest tail that could still become a code
    while (s && !CHEATS.some(c => c.code.startsWith(s))) s = s.slice(1);
    this.buf = s;
    const hit = BY_CODE.get(s);
    if (hit) { this.buf = ""; this.onCode(hit); return true; }
    return s.length >= 2;
  }

  /** A whole code as text (the chat box). True if it was one. */
  text(t) {
    const hit = BY_CODE.get(t.replace(/\s+/g, "").toUpperCase());
    if (hit) this.onCode(hit);
    return !!hit;
  }
}
