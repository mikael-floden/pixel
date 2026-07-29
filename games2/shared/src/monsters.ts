// Monsters — single source of truth shared by BOTH the server (authoritative
// spawning/roaming) and the client (rendering). Framework-free pure TS: no
// Colyseus, no Phaser.
//
// SPAWN ZONES ARE MAP DATA (maintainer 2026-07-29): the maps2 agent owns them.
// Every world ships `maps2/worlds/<name>/spawns.json` — `pixel-maps2/spawns@1`
// (spec: maps2/spec/SPAWNS.md) — polygon zones {id, monster, area, elev, num}.
// This module holds the PURE geometry/parsing half (schema types, even-odd
// point-in-polygon, polygon→cells); the terrain-aware half (which cells are
// actually standable at the zone's elevation band) is `buildZoneRuntimes` in
// ./index (it needs the grid helpers, which live there). The old hardcoded
// rectangles clustered near the player spawn ("fake debug areas") are GONE —
// this file replaced them when spawns@1 landed.
//
// Source CELL_WU from the dependency-free leaf, NOT the ./index barrel: index.ts
// re-exports THIS module, so importing ./index here would be a cycle.
import { CELL_WU } from "./units";

// One spawn zone from spawns@1. `area` is a SIMPLE polygon in TILE-CORNER
// coordinates (cell (x,y) spans corners (x,y)..(x+1,y+1)), implicitly closed;
// concave is fine, self-intersections are generator-asserted away. `elev` is
// the INTENDED walk surface band [min,max] in world LEVELS — a monster may
// stand at a cell on whichever surface (base OR deck) has its level in range.
// `num` is the zone's population (the game treats it as the concurrent cap).
export interface SpawnZone {
  id: string;
  monster: string;
  area: Array<[number, number]>;
  elev: [number, number];
  num: number;
}

/** Parse a spawns.json payload. Returns [] for anything that isn't a
 * well-formed pixel-maps2/spawns@1 document; malformed zones are skipped
 * individually so one bad entry can't drop a whole world's monsters. */
export function parseSpawns(json: unknown): SpawnZone[] {
  const doc = json as { schema?: string; zones?: unknown[] } | null;
  if (!doc || doc.schema !== "pixel-maps2/spawns@1" || !Array.isArray(doc.zones)) return [];
  const out: SpawnZone[] = [];
  for (const z of doc.zones as Array<Record<string, unknown>>) {
    if (!z || typeof z.id !== "string" || typeof z.monster !== "string") continue;
    const area = z.area as Array<[number, number]>;
    const elev = z.elev as [number, number];
    if (!Array.isArray(area) || area.length < 3) continue;
    if (!Array.isArray(elev) || elev.length !== 2) continue;
    const num = typeof z.num === "number" && z.num > 0 ? Math.floor(z.num) : 1;
    out.push({ id: z.id, monster: z.monster, area, elev: [elev[0], elev[1]], num });
  }
  return out;
}

/** Even-odd point-in-polygon (the spec's membership rule) against a zone's
 * tile-corner polygon. `px/py` are in the same corner-coordinate space —
 * pass cell centres (c+0.5, r+0.5) to test cell membership. */
export function pointInZone(zone: SpawnZone, px: number, py: number): boolean {
  const poly = zone.area;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** All grid cells whose CENTRE lies inside the zone polygon (clipped to the
 * world). Pure geometry — elevation/standability filtering happens against the
 * terrain grid in buildZoneRuntimes. */
export function zonePolygonCells(
  zone: SpawnZone,
  wCells: number,
  hCells: number,
): Array<{ c: number; r: number }> {
  let minC = Infinity;
  let minR = Infinity;
  let maxC = -Infinity;
  let maxR = -Infinity;
  for (const [x, y] of zone.area) {
    minC = Math.min(minC, x);
    maxC = Math.max(maxC, x);
    minR = Math.min(minR, y);
    maxR = Math.max(maxR, y);
  }
  const out: Array<{ c: number; r: number }> = [];
  const c0 = Math.max(0, Math.floor(minC));
  const c1 = Math.min(wCells - 1, Math.ceil(maxC) - 1);
  const r0 = Math.max(0, Math.floor(minR));
  const r1 = Math.min(hCells - 1, Math.ceil(maxR) - 1);
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) if (pointInZone(zone, c + 0.5, r + 0.5)) out.push({ c, r });
  return out;
}

/** The zone polygon's bounding box in WORLD UNITS (debug overlay publish). */
export function zoneBBox(zone: SpawnZone): { x0: number; y0: number; x1: number; y1: number } {
  let minC = Infinity;
  let minR = Infinity;
  let maxC = -Infinity;
  let maxR = -Infinity;
  for (const [x, y] of zone.area) {
    minC = Math.min(minC, x);
    maxC = Math.max(maxC, x);
    minR = Math.min(minR, y);
    maxR = Math.max(maxR, y);
  }
  return { x0: minC * CELL_WU, y0: minR * CELL_WU, x1: maxC * CELL_WU, y1: maxR * CELL_WU };
}

// Roam tuning ---------------------------------------------------------------

// Monsters walk slowly; scale player WALK_SPEED down for monster movement.
export const MONSTER_SPEED_SCALE = 0.6;

// Pause (ms) after arriving at a roam target before picking the next one. A
// random value in [MIN, MAX] gives natural, staggered idling.
export const MONSTER_ROAM_PAUSE_MS_MIN = 800;
export const MONSTER_ROAM_PAUSE_MS_MAX = 2600;

// Consider a roam target "reached" within this many world units (also used to
// avoid picking a next target that is trivially close to the current spot).
export const MONSTER_ARRIVE_RADIUS = CELL_WU * 0.5;

// A roam leg's reach: pick the next target within this many CELLS of the
// current spot so monsters mill about locally instead of beelining across a
// zone that can span half the map.
export const MONSTER_ROAM_RADIUS_CELLS = 6;

// Pick a random pause (ms) in the roam range using injected rng.
export function randomPauseMs(rng: () => number): number {
  return (
    MONSTER_ROAM_PAUSE_MS_MIN +
    rng() * (MONSTER_ROAM_PAUSE_MS_MAX - MONSTER_ROAM_PAUSE_MS_MIN)
  );
}
