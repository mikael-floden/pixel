// Monsters — single source of truth shared by BOTH the server (authoritative
// spawning/roaming) and the client (rendering). Framework-free pure TS: no
// Colyseus, no Phaser. Server and client import these constants/helpers so the
// monster kinds, spawn-area geometry, and roam tuning can never drift.
//
// This round is WALK/ROAM ONLY. Monsters (the poring family) hop around inside
// fixed rectangular spawn areas placed on walkable LAND near the player spawn of
// the_island2 (grid spawn cell [218,135]). The rectangles are fake debug areas
// for now — later the maps agent owns real spawn areas.

// Source CELL_WU from the dependency-free leaf, NOT the ./index barrel: index.ts
// re-exports THIS module at the end of its body, so importing ./index here would
// be a cycle and CELL_WU would be in the temporal dead zone when SPAWN_AREAS is
// built below (ReferenceError at module init). The leaf has no such ordering.
import { CELL_WU } from "./units";

// The 6 monster folder ids under /home/user/pixel/monsters/<id>/ (the poring
// family). MUST match monsters/config/roster.json order/ids exactly. Also the
// manifest keys and the `kind` field carried on each synced Monster.
export const MONSTER_KINDS = [
  "poring",
  "forest_poring",
  "ice_poring",
  "lava_poring",
  "sand_poring",
  "water_poring",
] as const;

export type MonsterKind = (typeof MONSTER_KINDS)[number];

// A rectangular spawn area in WORLD UNITS (AABB, x0<=x1, y0<=y1). Exactly one
// monster `kind` spawns inside, capped at `max`. Monsters pick roam targets
// within these bounds and never leave.
export interface SpawnArea {
  id: string;
  kind: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  max: number;
}

// Per-area cap. Porings are slow hoppers; a few per area reads well and is
// cheap to simulate.
const MAX_PER_AREA = 3;

// The 6 verified spawn rectangles. Computed from the_island2/world.json by
// scanning collision/mat grids near the player spawn cell [218,135]: every cell
// of every rect is collision==0 AND material != clear_water (24/24 standable
// land each, verified). Laid out as a tidy 3-wide x 2-tall grid of 6x4-cell
// rects with 1-cell gaps, so all 6 are visible together. World-unit bounds use
// cell corners: x0=c0*CELL_WU, x1=(c1+1)*CELL_WU (likewise rows for y).
//
// grid cells (col,row inclusive) -> world units:
//   poring        cols 196..201 rows 127..130  -> (6272,4064,6464,4192)
//   forest_poring cols 203..208 rows 127..130  -> (6496,4064,6688,4192)
//   ice_poring    cols 210..215 rows 127..130  -> (6720,4064,6912,4192)
//   lava_poring   cols 196..201 rows 131..134  -> (6272,4192,6464,4320)
//   sand_poring   cols 203..208 rows 131..134  -> (6496,4192,6688,4320)
//   water_poring  cols 210..215 rows 131..134  -> (6720,4192,6912,4320)
function areaFromCells(
  id: string,
  kind: MonsterKind,
  c0: number,
  r0: number,
  c1: number,
  r1: number,
): SpawnArea {
  return {
    id,
    kind,
    x0: c0 * CELL_WU,
    y0: r0 * CELL_WU,
    x1: (c1 + 1) * CELL_WU,
    y1: (r1 + 1) * CELL_WU,
    max: MAX_PER_AREA,
  };
}

export const SPAWN_AREAS: SpawnArea[] = [
  areaFromCells("area_poring", "poring", 196, 127, 201, 130),
  areaFromCells("area_forest_poring", "forest_poring", 203, 127, 208, 130),
  areaFromCells("area_ice_poring", "ice_poring", 210, 127, 215, 130),
  areaFromCells("area_lava_poring", "lava_poring", 196, 131, 201, 134),
  areaFromCells("area_sand_poring", "sand_poring", 203, 131, 208, 134),
  areaFromCells("area_water_poring", "water_poring", 210, 131, 215, 134),
];

// Roam tuning ---------------------------------------------------------------

// Porings hop slowly; scale player WALK_SPEED down for monster movement.
export const MONSTER_SPEED_SCALE = 0.6;

// Pause (ms) after arriving at a roam target before picking the next one. A
// random value in [MIN, MAX] gives natural, staggered idling.
export const MONSTER_ROAM_PAUSE_MS_MIN = 800;
export const MONSTER_ROAM_PAUSE_MS_MAX = 2600;

// Consider a roam target "reached" within this many world units (also used to
// avoid picking a next target that is trivially close to the current spot).
export const MONSTER_ARRIVE_RADIUS = CELL_WU * 0.5;

// Keep spawned/roam points this far inside the area edge so a 48px sprite's
// visual footprint stays over land and off the rectangle border.
export const MONSTER_AREA_INSET = CELL_WU * 0.5;

// Helpers (pure, deterministic — rng injected) ------------------------------

// Uniform random point strictly inside `area`, inset from the edges. `rng`
// returns [0,1) (inject Math.random on the server, or a seeded PRNG in tests).
export function randomPointInArea(
  area: SpawnArea,
  rng: () => number,
): { x: number; y: number } {
  const inset = Math.min(
    MONSTER_AREA_INSET,
    (area.x1 - area.x0) / 2,
    (area.y1 - area.y0) / 2,
  );
  const lx = area.x0 + inset;
  const hx = area.x1 - inset;
  const ly = area.y0 + inset;
  const hy = area.y1 - inset;
  return {
    x: lx + rng() * (hx - lx),
    y: ly + rng() * (hy - ly),
  };
}

// Clamp a point into the area's (inset) bounds.
export function clampToArea(
  area: SpawnArea,
  x: number,
  y: number,
): { x: number; y: number } {
  const inset = Math.min(
    MONSTER_AREA_INSET,
    (area.x1 - area.x0) / 2,
    (area.y1 - area.y0) / 2,
  );
  const lx = area.x0 + inset;
  const hx = area.x1 - inset;
  const ly = area.y0 + inset;
  const hy = area.y1 - inset;
  return {
    x: Math.max(lx, Math.min(hx, x)),
    y: Math.max(ly, Math.min(hy, y)),
  };
}

// Is (x,y) within the area's AABB (edges inclusive; no inset)?
export function areaContains(area: SpawnArea, x: number, y: number): boolean {
  return x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1;
}

// Pick a random pause (ms) in the roam range using injected rng.
export function randomPauseMs(rng: () => number): number {
  return (
    MONSTER_ROAM_PAUSE_MS_MIN +
    rng() * (MONSTER_ROAM_PAUSE_MS_MAX - MONSTER_ROAM_PAUSE_MS_MIN)
  );
}
