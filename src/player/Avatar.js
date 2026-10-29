// Player looks: which Mixamo character, and the colours of its clothes.
//
// CHARACTERS: the bodies (files made by tools/mixamo; see MixamoAssets.js).
// `parts` maps a clothing slot to the mesh that is that garment, for the
// characters built from separate pieces (Remy: top, trousers, shoes, hair);
// the rest are one mesh and change colour as a whole outfit (`outfit`).
// height: metres, so they don't all stand exactly the same.
//
// An avatar is { char, top, bottom, shoes, hair } (indices), packed into one
// small integer for the network (`st.av`). Players who never chose get one
// picked from their id, so a squad doesn't look like clones.

export const CHARACTERS = [
  { id: "vanguard", label: "Vanguard", gender: "m", height: 1.82, outfit: true },
  { id: "remy",     label: "Remy",     gender: "m", height: 1.78, parts: { top: "Tops", bottom: "Bottoms", shoes: "Shoes", hair: "Hair" } },
  { id: "ch15",     label: "Kabir",    gender: "m", height: 1.8,  outfit: true },
  { id: "medea",    label: "Meera",    gender: "f", height: 1.7,  outfit: true },
];

/** Colour choices per slot (0 = the original texture, untinted). */
export const PALETTES = {
  top:    [0xffffff, 0x6e8b5a, 0x3b5f8a, 0xa8423a, 0x2b2b2e, 0xc9a256, 0x7a5a9a, 0xd9d4c7],
  bottom: [0xffffff, 0x3a4048, 0x5b6338, 0x2a3b5c, 0x6b5440, 0x1f1f22, 0x8a7a60, 0x4a2d2d],
  shoes:  [0xffffff, 0x1d1d1f, 0x6b4a2e, 0x8a8f96, 0xa3332c, 0x2f4f6f, 0xd8d0c0, 0x3d5a3d],
  hair:   [0xffffff, 0x1b1410, 0x4a2f1e, 0x8a6a3a, 0x2a2a2a, 0x6b3a2a, 0xc8b08a, 0x5a5a62],
  // Whole-outfit tint for one-piece characters: gentle, so skin stays skin
  outfit: [0xffffff, 0xe8f0e0, 0xe0e6f2, 0xf2e2dc, 0xe6e6e6, 0xf0e8d4, 0xe8def0, 0xf2f2e8],
};
const SLOTS = ["top", "bottom", "shoes", "hair"];

export function encodeAvatar(a) {
  return (a.char & 7) | (a.top & 7) << 3 | (a.bottom & 7) << 6 | (a.shoes & 7) << 9 | (a.hair & 7) << 12;
}

export function decodeAvatar(code) {
  code |= 0;
  return {
    char: Math.min(CHARACTERS.length - 1, code & 7),
    top: code >> 3 & 7, bottom: code >> 6 & 7, shoes: code >> 9 & 7, hair: code >> 12 & 7,
  };
}

/** A look picked from an id (a player who never chose, a bot): the same on every machine. */
export function avatarFromId(id) {
  let h = 2166136261;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const r = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
  return { char: Math.floor(r() * CHARACTERS.length), top: 1 + Math.floor(r() * 7), bottom: 1 + Math.floor(r() * 7), shoes: Math.floor(r() * 8), hair: Math.floor(r() * 8) };
}

const KEY = "babylon-fps:avatar";
/** The local player's saved look, or null if they never picked one. */
export function savedAvatar() {
  try { const v = localStorage.getItem(KEY); return v === null ? null : decodeAvatar(+v); } catch { return null; }
}
export function saveAvatar(a) {
  try { localStorage.setItem(KEY, String(encodeAvatar(a))); } catch { /* storage blocked: it lasts this session */ }
}

export { SLOTS };
