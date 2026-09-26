// The effects runtime — everything the game (or a viewer) imports.
//
//   import { createFx } from ".../effects/runtime/index.js";          // framework-free
//   import { createPhaserFx } from ".../effects/runtime/phaser.js";   // the game's Phaser 3 adapter
//   import LIBRARY from ".../effects/library/index.js";               // every effect
//
// The contract (coordinates, planes, depth, timing, speed, lights, events) is
// effects/docs/integration.md.

export { createFx, FxWorld, DEFAULT_STYLE, PLANE_ORDER } from "./fx.js";
export { FxGL, blendPremultiplied, viewMatrix } from "./gl.js";
export { defineEffect, tuneDefaults, STANDARD_TUNE, KINDS, PLANES, lv, lvq, lvs, tier, rgb, box } from "./define.js";
export { glsl, PRELUDE, VERT } from "./glsl.js";
