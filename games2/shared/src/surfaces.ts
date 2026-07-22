// ============================================================================
// SURFACES — per-tile-category MATERIAL TABLE (walkability / speed / footstep)
// ============================================================================
//
// This is the ONE games2 file the ART agents may edit. When a maps2 world uses
// a tile category with NO entry here, the `check-surfaces` gate FAILS and the
// deploy is BLOCKED (prod stays on the previous revision). Rather than wait for
// the game agent, the tiles2 and maps2 agents are AUTHORISED to add the missing
// entry themselves — full runbook: games2/SURFACES.md. In short:
//
//   1. Add ONE line per category to the SURFACES object below. The failing
//      `check-surfaces` run prints a ready-to-paste, name-hinted proposal:
//        • solid                       → impassable OBJECT (tree, wall, spire…)
//        • ground(speed, "sound")      → TERRAIN you stand on (tune speed/sound;
//                                        sounds: grass/dirt/stone/sand/snow/ice/
//                                        wood/swamp/water)
//        • { standable:false, swimmable:true, speed:0.55, sound:"water" } → water
//   2. From games2/:  npm ci && npm run typecheck && npm test   — must be GREEN.
//      NEVER push red: a red push blocks EVERYONE's deploy, not just yours.
//   3. Commit + push to main (rebase on reject). That re-triggers the deploy,
//      now green, and prod rolls forward with your world + this entry.
//
// Edit ONLY this table (append entries; don't reflow existing lines — keeps the
// file conflict-light). The rest of the engine is in index.ts (game agent's).
//
// Walkability is governed by ELEVATION (how big a step you can take), not tile
// category. A tile's category is a separate axis: its SURFACE controls walk
// speed, footstep sound, and whether it's solid ground or swimmable water.

export interface Surface {
  standable: boolean; // solid ground you can walk/stand on
  swimmable: boolean; // water you can swim across (costs stamina — see stepStamina)
  speed: number; // walk-speed multiplier on this surface
  sound: string; // footstep sound id (for the future audio system, #9)
  stairs?: boolean; // transition tile: crossing it lets you walk a full 1-level step
}

const ground = (speed: number, sound: string): Surface => ({
  standable: true,
  swimmable: false,
  speed,
  sound,
});
const solid: Surface = { standable: false, swimmable: false, speed: 1, sound: "" }; // structures

/** Per-category surface properties. Unknown categories fall back to DEFAULT
 * (plain walkable ground) so new tiles the maps/tiles agents add never wall
 * players in or crash — they just walk normally until tuned here.
 * Road categories are matched by prefix (road_*) — see surfaceFor. */
export const SURFACES: Record<string, Surface> = {
  // liquids / hazards
  water: { standable: false, swimmable: true, speed: 0.55, sound: "water" },
  lava: solid, // deadly later; impassable for now
  // ground by feel
  grass: ground(1.0, "grass"),
  meadow: ground(1.0, "grass"),
  flowers: ground(0.95, "grass"),
  forest: ground(0.8, "grass"),
  jungle: ground(0.75, "grass"),
  mushroom_grove: ground(0.9, "grass"),
  savanna: ground(0.95, "grass"),
  wheat_field: ground(0.85, "grass"),
  farm: ground(0.95, "dirt"),
  vineyard: ground(0.9, "dirt"),
  dirt: ground(0.95, "dirt"),
  clay: ground(0.9, "dirt"),
  gravel: ground(0.95, "stone"),
  stone: ground(1.0, "stone"),
  mosaic_floor: ground(1.1, "stone"),
  sand: ground(0.8, "sand"),
  sand_bank: ground(0.8, "sand"),
  coral_sand: ground(0.8, "sand"),
  desert: ground(0.75, "sand"),
  snow: ground(0.7, "snow"),
  cliff_snow: ground(0.7, "snow"),
  tundra: ground(0.8, "snow"),
  permafrost: ground(0.9, "snow"),
  ice: ground(1.15, "ice"),
  crystal_ground: ground(1.0, "stone"),
  bog: ground(0.55, "swamp"),
  swamp: ground(0.5, "swamp"),
  // transitions
  stairs: { ...ground(0.9, "stone"), stairs: true },
  // solid structures (trees, monuments, towers) — you walk around them
  pine_tree: solid,
  pine_tree_v2: solid,
  oak_tree: solid,
  oak_tree_v2: solid,
  autumn_forest: ground(0.8, "grass"),
  big_boulder: solid,
  crystal_spire: solid,
  crystal_spire_v2: solid, // world-unused today; classified for night lighting
  ice_spire: solid,
  ice_spire_v2: solid,
  cliff_lava: solid, // freestanding maintainer test placement near spawn
  cliff_crystal_v2: solid, // dito — the "long" (base 120) tall profile
  cliff_gold: solid, // dito — emissive tall solid (glow-copy QA)
  // World-unused but EMISSIVE, so the demo world instantiates them (an
  // unclassified category defaults to walkable ground: no collision and the
  // player renders on top — demo stations 1-12/37-48). Same art profiles as
  // their classified siblings: tall pillars / one-level basalt-lava blocks.
  cliff_crystal: solid,
  cliff_gold_v2: solid,
  lava_ledge: solid,
  lava_ledge_v2: solid,
  obelisk: solid,
  obelisk_v2: solid,
  watchtower: solid,
  cactus: solid,
  // tiles2 materials (maps2 worlds) — terrain the player stands on (elevation
  // drives walls, not solidity); clear_water is swimmable like `water`.
  clear_water: { standable: false, swimmable: true, speed: 0.55, sound: "water" },
  saturated_grass: ground(1.0, "grass"),
  regular_snow: ground(0.7, "snow"),
  light_sand: ground(0.8, "sand"),
  lightdark_dirt: ground(0.95, "dirt"),
  stone_mountain: ground(1.0, "stone"),
  black_mountain: ground(1.0, "stone"),
  crystal_ice: ground(1.15, "ice"),
  wooden_balcony: ground(1.0, "wood"),
};
export const DEFAULT_SURFACE: Surface = ground(1.0, "grass");
const ROAD_SURFACE: Surface = ground(1.2, "stone");
export const VOID_SURFACE: Surface = { standable: false, swimmable: false, speed: 1.0, sound: "" };

export function surfaceFor(t: string): Surface {
  const s = SURFACES[t];
  if (s) return s;
  if (t.startsWith("road_")) return ROAD_SURFACE; // road_snow_turns, road_sand_… etc.
  return DEFAULT_SURFACE;
}

/** True when the category has an explicit SURFACES entry (or is a road_*).
 * Unknown categories silently default to plain walkable ground — which also
 * makes the night shader treat them as TERRAIN (walls, face shadows) instead
 * of a solid OBJECT (art + soft cast shadow only). New tree/boulder-like
 * categories from the tiles agent MUST be added to SURFACES or their block
 * shadow will stick out past their art again. */
export function isKnownSurface(t: string): boolean {
  return t in SURFACES || t.startsWith("road_");
}
