/**
 * Consume the maps agent's isometric world (pixel/maps/world/world.json) and the
 * tile sets (pixel/tiles/<category>/tile_NN.png). Mirrors the geometry the maps
 * pipeline documents (maps/pipeline/tileset.py + render.py):
 *
 *   screen_x = origin_x + (col - row) * grid_dx
 *   screen_y = origin_y + (col + row) * grid_dy   - level * level_height
 *
 * Draw back-to-front by (col+row, row); within a raised cell stack from level 0
 * up so the side faces build a solid block and the top shows its diamond.
 */

export type Cell = WorldCell;

export interface World {
  width: number;
  height: number;
  rows: Cell[][];
  pois: { x: number; y: number; label: string; tile?: string }[];
}

import { ISO_DX, ISO_DY, WorldCell, parseWorld } from "@nangijala/shared";

// Measured from the tile "house format" (64px / 28deg / 50% side faces).
// If the tiles agent changes that format, re-measure (tileset.measure_geometry).
// dx/dy live in shared/ (ISO_DX/ISO_DY) because screen-relative input math on
// the server must use the exact same projection ratio.
export const MAP_GEOMETRY = { tile: 64, dx: ISO_DX, dy: ISO_DY, lh: 19, margin: 8 };

export async function loadWorld(): Promise<World | null> {
  try {
    const res = await fetch("/assets/maps/world/world.json");
    if (!res.ok) return null;
    return parseWorld(await res.json());
  } catch {
    return null;
  }
}

export function tileKey(t: string, v: number): string {
  return `tile:${t}:${v}`;
}

/** client/public/tile-bases.json — per-variant lowest opaque row of each tile
 * art, measured at build time (scripts/build-tile-bases.mjs). groundBase is
 * the same measure for plain grass (how deep a flat tile's skirt reaches);
 * groundTop is grass's top vertex row (the surface diamond starts there). */
export interface TileBases {
  format: string;
  groundBase: number;
  groundTop?: number;
  categories: Record<string, number[]>;
}

/** Lift for tall tile art. Tall sets are NOT uniform — "extra long" variants
 * fill the 128px canvas (cliff_lava, spires, trees, waterfalls) while "long"
 * ones stop ~8px short (cliff_gold) — so a constant lift (imgH-64, the
 * fallback when metadata is missing) buried the full-canvas kind.
 *
 * SOLID structures stand ON their cell: their bottom V is anchored to the
 * surface diamond's BOTTOM VERTEX, so the drawn footprint aligns with the
 * collision diamond exactly (playtester overlay check). Terrain art instead
 * aligns its base with a flat ground tile's skirt (it IS ground). */
export function artLift(
  bases: TileBases | null,
  t: string,
  v: number,
  imgH: number,
  solid = false,
): number {
  const base = bases?.categories[t]?.[v];
  if (base !== undefined && bases) {
    // +3 seat: tile edges are drawn slightly inside their geometric diamond,
    // so a mathematically exact V-on-vertex placement leaves a 1-3px grass
    // seam along the base edges — the pillar reads as HOVERING (measured
    // live; playtester report). Sinking the V a hair into the fronting art
    // reads as standing on it.
    //
    // The V-anchor is for TALL structure art only (imgH > 64). A solid
    // category with flat ground-format art — lava lakes are solid because
    // they're impassable — IS ground and must sit in the grid like ground:
    // V-anchoring lava lifted 1,155 lake cells 18px off the world (review
    // finding).
    const anchor = solid && imgH > 64
      ? (bases.groundTop ?? bases.groundBase - 8) + 2 * MAP_GEOMETRY.dy + 3
      : bases.groundBase;
    return Math.max(0, base - anchor);
  }
  return Math.max(0, imgH - 64);
}

export function tileUrl(t: string, v: number): string {
  return `/assets/tiles/${t}/tile_${String(v).padStart(2, "0")}.png`;
}

/** The distinct (category, variant) tiles the world actually uses. */
export function distinctTiles(world: World): { t: string; v: number }[] {
  const seen = new Map<string, { t: string; v: number }>();
  for (const row of world.rows) for (const c of row) seen.set(`${c.t}:${c.v}`, { t: c.t, v: c.v });
  return [...seen.values()];
}

/** Cells in painter's order (back-to-front): by (col+row), then row. */
export function drawOrder(world: World): { x: number; y: number; cell: Cell }[] {
  const out: { x: number; y: number; cell: Cell }[] = [];
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const cell = world.rows[y]?.[x];
      if (cell) out.push({ x, y, cell });
    }
  }
  out.sort((a, b) => a.x + a.y - (b.x + b.y) || a.y - b.y);
  return out;
}

export function canvasSize(world: World): { w: number; h: number; ox: number; oy: number; maxLevel: number } {
  const { dx, dy, lh, margin, tile } = MAP_GEOMETRY;
  let maxLevel = 0;
  for (const row of world.rows) for (const c of row) if (c.l > maxLevel) maxLevel = c.l;
  return {
    w: (world.width + world.height) * dx + margin * 2,
    h: (world.width + world.height) * dy + tile + maxLevel * lh + margin * 2,
    ox: (world.height - 1) * dx + margin,
    oy: maxLevel * lh + margin,
    maxLevel,
  };
}
