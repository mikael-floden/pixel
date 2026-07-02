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

export interface Cell {
  t: string; // terrain / tile category (folder under pixel/tiles/)
  v: number; // tile variant index -> tile_0V.png
  l: number; // elevation level (stacked)
  r?: string; // region kind
}

export interface World {
  schema?: string;
  width: number;
  height: number;
  iteration?: number;
  seed?: number;
  regions?: { name: string; kind: string }[];
  rows: Cell[][];
}

import { ISO_DX, ISO_DY } from "@nangijala/shared";

// Measured from the tile "house format" (64px / 28deg / 50% side faces).
// If the tiles agent changes that format, re-measure (tileset.measure_geometry).
// dx/dy live in shared/ (ISO_DX/ISO_DY) because screen-relative input math on
// the server must use the exact same projection ratio.
export const MAP_GEOMETRY = { tile: 64, dx: ISO_DX, dy: ISO_DY, lh: 19, margin: 8 };

export async function loadWorld(): Promise<World | null> {
  try {
    const res = await fetch("/assets/maps/world/world.json");
    if (!res.ok) return null;
    const w = (await res.json()) as World;
    return w && Array.isArray(w.rows) ? w : null;
  } catch {
    return null;
  }
}

export function tileKey(t: string, v: number): string {
  return `tile:${t}:${v}`;
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
