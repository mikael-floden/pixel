// THE LIGHT SLOT LEDGER — who may occupy the shader's 12 point-light slots.
//
// The night shader renders at most MAX_SHADER_LIGHTS (12) real lights — the
// ones with attenuation, LOS shadows, face Lambert and elevation awareness.
// Everything else (overflow emission, remote players' effects) falls back to
// the additive glow-stamp field, which is unlimited but is ambience, not
// illumination. The ledger (maintainer 2026-08-12) fixes the layout so no
// system can starve another:
//
//   1 slot  — the LOCAL player's own torch (remote torches are never lights:
//             "a player can only ever see its own torch")
//   1 slot  — the AMBIENT agent (fireflies, birds, whatever they dream up)
//   1 slot  — the local player's own SPELLS (future)
//   1 slot  — MONSTER battle effects against the local player (future)
//   8 slots — the WORLD: the campfire scenery object + emissive tiles/props +
//             the coming scenery objects. This is the number the maps agent
//             designs against: no spot on any map may be reachable by more
//             than 8 world light pools at once (a light affects the scene
//             before its source is on screen, so the audit window is the
//             viewport GROWN by each light's radius).
//
// The reservations are STRICT, not opportunistic: an empty torch slot is not
// lent to the world, because a loan would mean a world light pops off the
// moment the torch is struck. The world budget is 8, always.
//
// This module is the write-side API for the reserved slots. WorldScene reads
// it every frame; the owning agents import the setters. Setting `null`
// releases the slot (it simply stays empty — reservations don't shrink).

import type { ShaderLight } from "./nightlight";

export const RESERVED_LIGHT_SLOTS = 4;
export const WORLD_LIGHT_SLOTS = 8; // MAX_SHADER_LIGHTS - RESERVED_LIGHT_SLOTS

const reserved: {
  ambient: ShaderLight | null;
  selfFx: ShaderLight | null;
  monsterFx: ShaderLight | null;
} = { ambient: null, selfFx: null, monsterFx: null };

/** AMBIENT AGENT: your reserved light. One light, yours alone, never evicted.
 * Position in grid cells (col/row/z like every ShaderLight), radius in cells,
 * color may exceed 1 (the shader clamps the multiply at 1.25, so overbright
 * widens the hot plateau — the campfire trick). Call with null to put it out. */
export function setAmbientLight(l: ShaderLight | null) {
  reserved.ambient = l;
}

/** FUTURE: the local player's own spell effects. Reserved now so the budget
 * holds the day it ships — do not repurpose. */
export function setSelfFxLight(l: ShaderLight | null) {
  reserved.selfFx = l;
}

/** FUTURE: monster battle effects aimed at the local player. Reserved now so
 * the budget holds the day it ships — do not repurpose. */
export function setMonsterFxLight(l: ShaderLight | null) {
  reserved.monsterFx = l;
}

/** WorldScene's read side — one call per frame. */
export function reservedLights(): {
  ambient: ShaderLight | null;
  selfFx: ShaderLight | null;
  monsterFx: ShaderLight | null;
} {
  return reserved;
}
