// Every third-party asset the game ships, with its author, source and licence, and
// the game's disclaimer. One place: the Credits & Legal screen (src/ui/LegalScreen.js)
// is built from it. Adding an asset? Add it here too (CC BY needs title, author,
// source, licence and a note of the changes).
//
// Audited 2026-10-31 from the files themselves (Sketchfab exports carry author /
// licence / source in asset.extras) and the licence files next to them.
// Re-checked 2026-11-06: the college workshop, the new CSE building and water
// tower models, crash effects, wooden crates, the new HUD icons (lorc,
// delapouite: already credited) and the battle royale twists add no
// third-party assets.

/** Where rights holders reach the developer (shown on the disclaimer when set). */
export const LEGAL_CONTACT = "";

export const LICENCES = {
  "CC BY 4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC BY 3.0": "https://creativecommons.org/licenses/by/3.0/",
  "CC0 1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
  "MIT": "https://opensource.org/license/mit",
  "SIL OFL 1.1": "https://openfontlicense.org/",
  "Apache 2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  "Mixamo terms": "https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html",
};

const SF = id => `https://sketchfab.com/3d-models/${id}`;
const OPT = "Optimized for the game: simplified and quantized geometry, textures resized and re-encoded as WebP.";

/**
 * Credit groups: { title, note?, items: [{ what, who, licence, url?, changes? }] }.
 * licence is a LICENCES key (or free text for the odd one).
 */
export const CREDIT_GROUPS = [
  {
    title: "3D models · Sketchfab",
    items: [
      { what: "Autorikshaw - Indian Tuk Tuk", who: "bhagathartworks", licence: "CC BY 4.0", url: SF("autorikshaw-indian-tuk-tuk-5775d012693741008acff9dad410e92d"), changes: OPT },
      { what: "Mahindra - Thar Roxx", who: "ansari_studios", licence: "CC BY 4.0", url: SF("mahindra-thar-roxx-f85210fe98774b7fab1199d8ee151ead"), changes: "Simplified from 223k to ~15k triangles. " + OPT },
      { what: "Indian Truck", who: "AFJAL ANSARI", licence: "CC BY 4.0", url: SF("indian-truck-8c7650b96d6846de8cc54391ab16cf20"), changes: "Simplified from 208k triangles, textures at 256 px. " + OPT },
      { what: "Panchayat building game asset", who: "nayan pachori", licence: "CC BY 4.0", url: SF("panchayat-building-game-asset-dbe13724c0c5446084313dce5a98a1d8"), changes: "A doorway cut in and a furnished room built inside. " + OPT },
      { what: "Town Building", who: "nayan pachori", licence: "CC BY 4.0", url: SF("town-building-b441ed4dac864c089435f76ba055d7ab"), changes: "A doorway cut in and a furnished room built inside. " + OPT },
      { what: "Dragon Gold", who: "Prof.v7x", licence: "CC BY 4.0", url: SF("dragon-gold-22d93739c43d44c9804402b689c402d2"), changes: "Rescaled, re-posed and simplified. " + OPT },
      { what: "Zombie Dog animation", who: "hino", licence: "CC BY 4.0", url: SF("zombie-dog-animation-cfe2c0015d284edd9d826a4e266080e2"), changes: "Rescaled and re-posed. " + OPT },
      { what: "Old Tree With Vine 3d model free", who: "iGauravRajput", licence: "CC BY 4.0", url: SF("old-tree-with-vine-3d-model-free-7d883d233be94b1f8569d489baa4c9bf"), changes: "Simplified, with a lighter distance LOD. " + OPT },
      { what: "Autorickshaw 3d model free (fallback model)", who: "iGauravRajput", licence: "CC BY 4.0", url: SF("autorickshaw-3d-model-free-b6434fe6dd1647af83120763767844a8"), changes: "Simplified. " + OPT },
      { what: "M1 Helmet", who: "Melvin Stubbe", licence: "CC BY 4.0", url: SF("m1-helmet-6d7929b10c994db0b6b39e35b379bfbd"), changes: "Converted to metal-roughness, joined, simplified, fitted to each character. " + OPT },
      { what: "Hełm wz. 2005 (Helmet model 2005)", who: "Armored Wave", licence: "CC BY 4.0", url: SF("hem-wz-2005-helmet-model-2005-3bef9733977142599dc2275cf889fcef"), changes: "Converted, joined, simplified, fitted to each character. " + OPT },
      { what: "Combat helmet K6-3", who: "shamanoff", licence: "CC BY 4.0", url: SF("combat-helmet-k6-3-94701874d8b949718708b018c8d4f61d"), changes: "Converted, joined, simplified, fitted to each character. " + OPT },
      { what: "Military Armor 3D Model", who: "Exactly", licence: "CC BY 4.0", url: SF("military-armor-3d-model-7cab57de2b844a60a43af4fd8b61a4a4"), changes: "Simplified from 21k to ~12k triangles, stretched to each torso, tinted per level. " + OPT },
      { what: "Military Tactical Backpack", who: "Liam3D", licence: "CC BY 4.0", url: SF("military-tactical-backpack-9fa2da2c42234b58896e8d23393cac24"), changes: "Converted, joined, simplified, fitted to each character. " + OPT },
      { what: "Low Poly Game Ready Military Tactical Backpack", who: "DanlyVostok", licence: "CC BY 4.0", url: SF("low-poly-game-ready-military-tactical-backpack-95a4fc7300584384b56ce3add58dbc9f"), changes: "Converted, joined, fitted to each character. " + OPT },
      { what: "Tactical Explorer Backpack", who: "yronthal", licence: "CC BY 4.0", url: SF("tactical-explorer-backpack-adc0e037e7ce458ebd5418ba8f30d22b"), changes: "Simplified to ~6k triangles, fitted to each character. " + OPT },
    ],
  },
  {
    title: "3D models · Poly Pizza",
    items: [
      { what: "Motorcycle (sport bike)", who: "Paul Spooner", licence: "CC BY 3.0", url: "https://poly.pizza/m/1yfyze7uGxS", changes: "Wheels separated so they turn; rescaled. " + OPT },
      { what: "Military Motorbike", who: "Zsky", licence: "CC BY 3.0", url: "https://poly.pizza/m/9SwnIlPjNv", changes: "Wheels separated so they turn; rescaled. " + OPT },
      { what: "Submachine Gun", who: "Quaternius", licence: "CC0 1.0", url: "https://poly.pizza/m/7ehatxr7FY" },
    ],
  },
  {
    title: "Characters & animation",
    note: "Characters and animations from Adobe Mixamo, used under Adobe's Mixamo terms (free for use in games; the original files are not redistributed). The rider, swim, climb and many other moves are layered procedurally on top in the game's own code.",
    items: [
      { what: "Player characters and animation clips", who: "Adobe Mixamo", licence: "Mixamo terms", url: "https://www.mixamo.com" },
      { what: "Ratamahatta (monster model and skins, Quake II player model)", who: "Brian Collins", licence: "Quake II community model, no formal licence (via the three.js examples)", url: "https://threejs.org/examples/#webgl_loader_md2" },
      { what: "Ogro (monster model, Quake II player model)", who: "Magarnigal · skins by Ogro_Fix and Deranged", licence: "Quake II community model, no formal licence (via the three.js examples)", url: "https://threejs.org/examples/#webgl_loader_md2_control" },
    ],
  },
  {
    title: "Ground textures · Poly Haven",
    note: "Public domain (CC0) PBR textures from Poly Haven. Resized, re-encoded as WebP and their normal maps packed two to a texture for the game.",
    items: [
      { what: "Aerial Grass Rock", who: "Poly Haven", licence: "CC0 1.0", url: "https://polyhaven.com/a/aerial_grass_rock" },
      { what: "Red Laterite Soil Stones", who: "Poly Haven", licence: "CC0 1.0", url: "https://polyhaven.com/a/red_laterite_soil_stones" },
      { what: "Rocky Terrain 02", who: "Poly Haven", licence: "CC0 1.0", url: "https://polyhaven.com/a/rocky_terrain_02" },
      { what: "Aerial Beach 01", who: "Poly Haven", licence: "CC0 1.0", url: "https://polyhaven.com/a/aerial_beach_01" },
    ],
  },
  {
    title: "Kits, icons & fonts",
    items: [
      { what: "Building Kit, Furniture Kit (houses)", who: "Kenney", licence: "CC0 1.0", url: "https://kenney.nl/assets" },
      { what: "Game icons", who: "caro-asercion, darkzaitzev, delapouite, guard13007, lorc, sbed, skoll", licence: "CC BY 3.0", url: "https://game-icons.net", changes: "Recoloured and resized for the HUD." },
      { what: "Teko, Creepster", who: "Indian Type Foundry; Sideshow (Google Fonts)", licence: "SIL OFL 1.1", url: "https://fonts.google.com" },
      { what: "Special Elite", who: "Astigmatic (Google Fonts)", licence: "Apache 2.0", url: "https://fonts.google.com/specimen/Special+Elite" },
    ],
  },
  {
    title: "Sound",
    note: "Every recording is public domain. The clips were cut, layered, levelled and converted for the game. The horror score, engines, tyre skids, brakes, wind, heartbeat, breathing, electric buzz, rain and interface sounds are synthesized live in code (made for the game).",
    items: [
      { what: "The Free Firearm Sound Library", who: "Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney", licence: "CC0 1.0", url: "https://opengameart.org/content/the-free-firearm-sound-library" },
      { what: "Gun reload sounds", who: "SpringySpringo", licence: "CC0 1.0", url: "https://opengameart.org/content/gun-reload-sounds" },
      { what: "Impact Sounds, RPG Audio, Sci-fi Sounds, Interface Sounds", who: "Kenney", licence: "CC0 1.0", url: "https://kenney.nl/assets" },
      { what: "Zombies Sound Pack", who: "artisticdude", licence: "CC0 1.0", url: "https://opengameart.org/content/zombies-sound-pack" },
      { what: "80 CC0 Creature SFX #2", who: "rubberduck", licence: "CC0 1.0", url: "https://opengameart.org/content/80-cc0-creture-sfx-2" },
      { what: "Dog sounds", who: "pauliuw", licence: "CC0 1.0", url: "https://opengameart.org/content/dog-sounds" },
      { what: "CC0 Deep Monster Roar", who: "trazzz123", licence: "CC0 1.0", url: "https://opengameart.org/content/cc0-deep-monster-roar" },
      { what: "Large Wings Flap, Fire crackling", who: "AntumDeluge", licence: "CC0 1.0", url: "https://opengameart.org/content/large-wings-flap" },
      { what: "Glass break", who: "Till Behrend", licence: "CC0 1.0", url: "https://opengameart.org/content/glass-break" },
    ],
  },
  {
    title: "Software",
    items: [
      { what: "three.js", who: "three.js authors", licence: "MIT", url: "https://github.com/mrdoob/three.js" },
      { what: "cannon-es", who: "pmndrs", licence: "MIT", url: "https://github.com/pmndrs/cannon-es" },
      { what: "meshoptimizer", who: "Arseny Kapoulkine", licence: "MIT", url: "https://github.com/zeux/meshoptimizer" },
      { what: "lil-gui", who: "George Michael Brower", licence: "MIT", url: "https://github.com/georgealways/lil-gui" },
      { what: "Capacitor", who: "Ionic", licence: "MIT", url: "https://capacitorjs.com" },
    ],
  },
  {
    title: "Ideas and examples",
    note: "Effects and interface pieces modelled on these examples and written for the game. Listing them does not mean their authors endorse this game.",
    items: [
      { what: "three.js examples: geometry cube (wooden crates), MD2 loader, post-processing, GPU particles", who: "three.js authors", licence: "MIT", url: "https://threejs.org/examples/" },
      { what: "Circular Carousel and Celebration Cursor (ideas for the weapon wheel and confetti)", who: "React Bits", licence: "Design reference only", url: "https://reactbits.dev" },
    ],
  },
  {
    title: "Made for this game",
    note: "Built for the game and owned by its developer: the CSE building, the college workshop, the college gate, the water towers, the chaiwala, the city, villages, caves, terrain, roads, fields and procedural props, the wooden crates and their texture, the made-up Taara money and Krunchu Biscuits, the toolkit, spanner and supply-drop crate, the stand-in vehicles, every shader and effect (crash sparks, smoke, fire, blood, post-processing), the kick, punch, rider, mount and vehicle animation, and the game's own rules: Most Wanted bounties, Revenge Run, supply drops, Nemesis rivals and vehicle repairs.",
    items: [],
  },
];

/** The disclaimer, as { heading, text } paragraphs. */
export const DISCLAIMER = [
  { heading: "A work of fiction", text: "This game and its world are fictional. Its towns, institutions, organisations, characters and events are invented or used in a fictional way. Any resemblance to real people, living or dead, or to real events is coincidental. Places that resemble real ones are a backdrop only and do not suggest any endorsement by them." },
  { heading: "Trademarks", text: "Vehicle, product, brand and company names or likenesses that appear in the game belong to their respective owners. They appear as generic everyday props in a fictional setting; their owners are not affiliated with, and do not sponsor or endorse, this game." },
  { heading: "Game money", text: "The game's money, the Taara (✦), is made up. It isn't modelled on any real currency, and its notes are a simple invented prop, not a picture or copy of any real banknote. Taara, bounties and every reward are in-game items only: they have no real value, can't be bought, sold, cashed out or exchanged for real money, and are not legal tender anywhere. No central bank or government is affiliated with, or endorses, this game." },
  { heading: "No real-money play", text: "There is no real-money purchase, betting or gambling in the game. Shops, bounties, crates and loot use in-game money and items only." },
  { heading: "Third-party content", text: "The game uses models, sounds, icons, fonts and software made by other people under the licences listed in Credits. Their authors keep all rights in their work. Changes made for the game are noted there. Listing an author does not mean they endorse this game." },
  { heading: "Content", text: "Contains fantasy violence against monsters and, in Battle Royale, other players, including unarmed kicks and punches, bounties on players and players returning as revenants. It's a game: nothing in it is meant to promote violence in real life." },
  { heading: "Photosensitivity warning", text: "A small number of people may have seizures when exposed to flashing lights or patterns. This game has flashes (gunfire, explosions, lightning, electric sparks, screen effects) and fast motion. If you or anyone in your family has epilepsy, talk to a doctor before playing, and stop at once if you feel dizzy, see altered vision, twitch or feel disoriented." },
  { heading: "Play responsibly", text: "Take breaks. Keep the volume at a safe level, especially with headphones. Don't play while driving or when you need to be aware of your surroundings." },
  { heading: "Privacy", text: "The game has no accounts and asks for no personal information. Your settings, progress, look and keys stay in your own browser (local storage). In multiplayer, the callsign you choose, your position and actions in the game, and your chat messages are relayed to the other players in your room and are not stored by the game after you leave. Don't share personal information in your callsign or the chat. The web host and relay server may keep standard technical logs (such as IP addresses) as all websites do." },
  { heading: "Chat and other players", text: "Chat and callsigns are written by players, not by the developer, who doesn't monitor them and isn't responsible for them. Be respectful: no harassment, hate, threats, spam or illegal content. Leave a room if anyone makes you uncomfortable." },
  { heading: "Bots", text: "Battle royale rooms can be filled with computer-controlled players (bots) when that setting is on. They have player-like names and may chat; they are not real people." },
  { heading: "No warranty", text: "The game is provided \"as is\", free of charge, without warranty of any kind. The developer is not liable for any loss or damage arising from playing it, to the extent the law allows." },
  { heading: "Rights holders", text: "If you believe something in this game uses your work without permission, contact the developer and it will be reviewed and, where appropriate, credited properly or removed." },
];
