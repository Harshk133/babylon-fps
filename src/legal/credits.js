// Every third-party asset the game ships, with its author, source and licence, and
// the game's disclaimer. One place: the Credits & Legal screen (src/ui/LegalScreen.js)
// is built from it. Adding an asset? Add it here too (CC BY needs title, author,
// source, licence and a note of the changes).
//
// Audited 2026-10-31 from the files themselves (Sketchfab exports carry author /
// licence / source in asset.extras) and the licence files next to them.

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
      { what: "Indian cookie (インドのクッキー)", who: "seirogan", licence: "CC BY 4.0", url: SF("1e19b60d29994ff08e5b37e4c0592604"), changes: "Simplified from 77k to ~2k triangles. " + OPT },
      { what: "Indian 2000 rupees notes", who: "varun pal", licence: "CC BY 4.0", url: SF("indian-2000-rupees-notes-a273c3495d644057ac4618a7c319340d"), changes: OPT },
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
    note: "Every recording is public domain. The clips were cut, layered, levelled and converted for the game. Rain, wind, engines and interface sounds are synthesized in code.",
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
    title: "Made for this game",
    note: "Built for the game and owned by its developer: the CSE building, the college gate, the water towers, the chaiwala, the city, villages, caves, terrain, roads, fields and procedural props, the stand-in vehicles, every shader and effect, and all the rider, mount and vehicle animation.",
    items: [],
  },
];

/** The disclaimer, as { heading, text } paragraphs. */
export const DISCLAIMER = [
  { heading: "A work of fiction", text: "This game and its world are fictional. Its towns, institutions, organisations, characters and events are invented or used in a fictional way. Any resemblance to real people, living or dead, or to real events is coincidental. Places that resemble real ones are a backdrop only and do not suggest any endorsement by them." },
  { heading: "Trademarks", text: "Vehicle, product, brand and company names or likenesses that appear in the game belong to their respective owners. They appear as generic everyday props in a fictional setting; their owners are not affiliated with, and do not sponsor or endorse, this game." },
  { heading: "Banknotes", text: "Money in the game is a stylised in-game item for scoring and trading inside the game only. It is not legal tender and is not meant to reproduce or imitate real currency." },
  { heading: "Third-party content", text: "The game uses models, sounds, icons, fonts and software made by other people under the licences listed in Credits. Their authors keep all rights in their work. Changes made for the game are noted there. Listing an author does not mean they endorse this game." },
  { heading: "Content", text: "Contains fantasy violence against monsters and, in Battle Royale, other players. It's a game: nothing in it is meant to promote violence in real life." },
  { heading: "Rights holders", text: "If you believe something in this game uses your work without permission, contact the developer and it will be reviewed and, where appropriate, credited properly or removed." },
];
