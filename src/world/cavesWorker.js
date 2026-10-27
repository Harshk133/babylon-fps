// Builds the cave rock off the main thread (rock field, surface mesh, colours,
// occlusion, torch placement, baked torchlight: ~1 s on a desktop, several on a
// phone), while the main thread parses the models arriving. See
// Caves.precomputeCavesData() / adoptCavesData().
import { precomputeCavesData } from "./Caves.js";

const { nets, transfer } = precomputeCavesData();
self.postMessage({ nets }, transfer);
