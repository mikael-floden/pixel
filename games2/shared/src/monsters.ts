// Monsters — single source of truth shared by BOTH the server (authoritative
// spawning/roaming) and the client (rendering). Framework-free pure TS: no
// Colyseus, no Phaser. Server and client import these constants/helpers so the
// monster kinds, spawn-area geometry, and roam tuning can never drift.
//
// This round is WALK/ROAM ONLY. Monsters (the poring family) hop around inside
// fixed rectangular spawn areas placed on walkable LAND right next to the player
// spawn of ring_test — the DEFAULT world the server loads (WorldRoom
// DEFAULT_WORLD; grid spawn cell [63,75]). The maintainer wants every area close
// to spawn and off the water so all 6 kinds are testable at once. The rectangles
// are fake debug areas for now — later the maps agent owns real spawn areas.
// NOTE: these coords are ring_test-specific; if the default world changes, the
// areas must be re-placed on that world's land (server/test/monsters.sim.test.ts
// gates that they stay on standable land and never leave the area).

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

// The 6 verified spawn rectangles. Computed from ring_test/world.json by
// scanning the terrain grid near the player spawn cell [63,75]: every cell of
// every rect (plus a 1-cell margin) is standable LAND — not clear_water, not a
// solid prop — verified headlessly. ring_test's spawn sits on the WEST shore of
// the central lake, so the areas cluster on the land just NW/W of it. Laid out
// as a tidy 3-wide x 2-tall grid of 6x4-cell rects with 1-cell gaps (block cells
// 43..62 x 66..74, centre ~11 cells from spawn) so all 6 are visible together.
// World-unit bounds use cell corners: x0=c0*CELL_WU, x1=(c1+1)*CELL_WU (likewise
// rows for y).
//
// grid cells (col,row inclusive):
//   poring        cols 43..48 rows 66..69
//   forest_poring cols 50..55 rows 66..69
//   ice_poring    cols 57..62 rows 66..69
//   lava_poring   cols 43..48 rows 71..74
//   sand_poring   cols 50..55 rows 71..74
//   water_poring  cols 57..62 rows 71..74
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
  areaFromCells("area_poring", "poring", 43, 66, 48, 69),
  areaFromCells("area_forest_poring", "forest_poring", 50, 66, 55, 69),
  areaFromCells("area_ice_poring", "ice_poring", 57, 66, 62, 69),
  areaFromCells("area_lava_poring", "lava_poring", 43, 71, 48, 74),
  areaFromCells("area_sand_poring", "sand_poring", 50, 71, 55, 74),
  areaFromCells("area_water_poring", "water_poring", 57, 71, 62, 74),
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
