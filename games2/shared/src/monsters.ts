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

// Static fallback ONLY (open/gridless worlds): the tidy ring_test cluster. The
// REAL areas are computed per-world by spawnAreasNear() below so monsters always
// appear next to the player whatever world loads — see the note above.
export const SPAWN_AREAS: SpawnArea[] = [
  areaFromCells("area_poring", "poring", 43, 66, 48, 69),
  areaFromCells("area_forest_poring", "forest_poring", 50, 66, 55, 69),
  areaFromCells("area_ice_poring", "ice_poring", 57, 66, 62, 69),
  areaFromCells("area_lava_poring", "lava_poring", 43, 71, 48, 74),
  areaFromCells("area_sand_poring", "sand_poring", 50, 71, 55, 74),
  areaFromCells("area_water_poring", "water_poring", 57, 71, 62, 74),
];

// Area geometry used by spawnAreasNear: six 6x4-cell rects laid out as a tidy
// 3-wide x 2-tall grid with 1-cell gaps (block = 20x9 cells).
const AREA_W = 6;
const AREA_H = 4;
const AREA_GAP = 1;
const GRID_COLS = 3;
const GRID_ROWS = 2;

// Compute the 6 spawn areas on standable LAND clustered right next to a world's
// spawn point, so the monsters always appear near the player REGARDLESS of which
// world loads (demo_lost, ring_test, the_island2, …). Deterministic — a fixed
// grid scan, no RNG — so the server and any mirror agree exactly.
//
// `isLand(x,y)` (WORLD UNITS) must be true only for standable, non-water,
// non-solid ground. Strategy, best-first:
//   1. a tidy 3x2 block whose every cell (+1-cell margin) is land, closest to spawn;
//   2. else the 6 closest non-overlapping all-land 6x4 rects (greedy);
//   3. else (little/no land, e.g. an open world) a tidy grid centred on spawn,
//      unchecked — keeps monsters visible instead of off-map.
export function spawnAreasNear(
  spawnX: number,
  spawnY: number,
  worldW: number,
  worldH: number,
  isLand: (x: number, y: number) => boolean,
): SpawnArea[] {
  const sc = Math.floor(spawnX / CELL_WU);
  const sr = Math.floor(spawnY / CELL_WU);
  const wCells = Math.max(1, Math.round(worldW / CELL_WU));
  const hCells = Math.max(1, Math.round(worldH / CELL_WU));
  const kinds = MONSTER_KINDS;

  const cellLand = (c: number, r: number): boolean =>
    c >= 0 &&
    r >= 0 &&
    c < wCells &&
    r < hCells &&
    isLand((c + 0.5) * CELL_WU, (r + 0.5) * CELL_WU);

  const fromTopLefts = (tl: Array<{ c: number; r: number }>): SpawnArea[] =>
    tl.map((p, i) =>
      areaFromCells(
        `area_${kinds[i]}`,
        kinds[i],
        p.c,
        p.r,
        p.c + AREA_W - 1,
        p.r + AREA_H - 1,
      ),
    );

  const gridTopLefts = (C: number, R: number): Array<{ c: number; r: number }> => {
    const out: Array<{ c: number; r: number }> = [];
    for (let rr = 0; rr < GRID_ROWS; rr++)
      for (let cc = 0; cc < GRID_COLS; cc++)
        out.push({ c: C + cc * (AREA_W + AREA_GAP), r: R + rr * (AREA_H + AREA_GAP) });
    return out;
  };

  // A rectangle of W x H cells at (c0,r0) is all-land including a 1-cell margin.
  const rectLand = (c0: number, r0: number, W: number, H: number): boolean => {
    for (let c = c0 - 1; c < c0 + W + 1; c++)
      for (let r = r0 - 1; r < r0 + H + 1; r++) if (!cellLand(c, r)) return false;
    return true;
  };

  // 1) Tidy 3x2 block closest to spawn.
  const BW = GRID_COLS * AREA_W + (GRID_COLS - 1) * AREA_GAP; // 20
  const BH = GRID_ROWS * AREA_H + (GRID_ROWS - 1) * AREA_GAP; // 9
  {
    const RAD = 48;
    let best: { C: number; R: number; d: number } | null = null;
    for (let C = sc - RAD; C <= sc + 2; C++)
      for (let R = sr - RAD; R <= sr + RAD; R++) {
        if (!rectLand(C, R, BW, BH)) continue;
        const d = Math.hypot(C + BW / 2 - sc, R + BH / 2 - sr);
        if (!best || d < best.d) best = { C, R, d };
      }
    if (best) return fromTopLefts(gridTopLefts(best.C, best.R));
  }

  // 2) Greedy: the 6 closest non-overlapping all-land 6x4 rects to spawn.
  {
    const RAD = 64;
    const cands: Array<{ c: number; r: number; d: number }> = [];
    for (let c0 = sc - RAD; c0 <= sc + RAD; c0++)
      for (let r0 = sr - RAD; r0 <= sr + RAD; r0++) {
        if (!rectLand(c0, r0, AREA_W, AREA_H)) continue;
        cands.push({ c: c0, r: r0, d: Math.hypot(c0 + AREA_W / 2 - sc, r0 + AREA_H / 2 - sr) });
      }
    cands.sort((a, b) => a.d - b.d || a.c - b.c || a.r - b.r);
    const overlap = (a: { c: number; r: number }, b: { c: number; r: number }): boolean =>
      !(
        a.c + AREA_W + AREA_GAP <= b.c ||
        b.c + AREA_W + AREA_GAP <= a.c ||
        a.r + AREA_H + AREA_GAP <= b.r ||
        b.r + AREA_H + AREA_GAP <= a.r
      );
    const picked: Array<{ c: number; r: number }> = [];
    for (const cd of cands) {
      if (picked.length >= kinds.length) break;
      if (picked.every((p) => !overlap(p, cd))) picked.push({ c: cd.c, r: cd.r });
    }
    if (picked.length === kinds.length) return fromTopLefts(picked);
  }

  // 3) Last resort: a tidy grid centred on spawn, land unchecked.
  const C0 = Math.max(0, Math.min(wCells - BW, sc - Math.floor(BW / 2)));
  const R0 = Math.max(0, Math.min(hCells - BH, sr - Math.floor(BH / 2)));
  return fromTopLefts(gridTopLefts(C0, R0));
}

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
