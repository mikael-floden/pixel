/**
 * Consume the maps2 agent's isometric worlds (maps2/worlds/<name>/world.json) and the
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
  /** maps2: player spawn cell (col,row). */
  spawn?: [number, number];
  /** maps2: per-material canonical plain base tile PNG for cliff faces. */
  faceTiles?: Record<string, string>;
  /** maps2 world@1: decorative objects (tall 64×128 tiles) placed on cells. */
  props?: WorldProp[];
  /** maps2 world@2: elevated walkable slabs (roofs, bridge decks). */
  decks?: Deck[];
}

import { ISO_DX, ISO_DY, LEVEL_PX, WorldCell, WorldProp, Deck, parseWorld } from "@nangijala/shared";

export type { WorldProp, Deck };

// maps2/tiles2 geometry: top diamond 30px×64px, grid steps dx=32/dy=15, one
// elevation level = 16px face (LEVEL_PX). dx/dy live in shared/ (ISO_DX/ISO_DY)
// because screen-relative input math on the server must use the same ratio.
export const MAP_GEOMETRY = { tile: 64, dx: ISO_DX, dy: ISO_DY, lh: LEVEL_PX, margin: 8 };

// The default world when the player hasn't picked one (matches the server's
// DEFAULT_WORLD). The maps agent adds worlds under maps2/worlds/<name>/; a world
// becomes playable + selectable once it has a world.json (see worlds.json,
// built by scripts/build-worlds.mjs).
export const DEFAULT_WORLD = "ring_test";

export function worldUrl(name: string): string {
  return `/assets/maps2/worlds/${name.replace(/[^a-z0-9_-]/gi, "")}/world.json`;
}

export async function loadWorld(name: string = DEFAULT_WORLD): Promise<World | null> {
  try {
    const res = await fetch(worldUrl(name));
    if (!res.ok) return null;
    return parseWorld(await res.json());
  } catch {
    return null;
  }
}

/** One selectable world (client/public/worlds.json, built by build-worlds.mjs). */
export interface WorldInfo {
  name: string;
  label: string;
  n?: number | null;
  schema?: string | null;
  spawn?: [number, number] | null;
  preview?: string | null;
}

/** The list of playable worlds for the selector. Falls back to just the default
 * when the manifest is missing (older build / maps agent hasn't run yet). */
export async function loadWorldsList(): Promise<WorldInfo[]> {
  try {
    const res = await fetch("/worlds.json", { cache: "no-cache" });
    if (res.ok) {
      const list = (await res.json()) as WorldInfo[];
      if (Array.isArray(list) && list.length) return list;
    }
  } catch {}
  return [{ name: DEFAULT_WORLD, label: "Ring Test" }];
}

/** Texture key for a cell's tile. maps2 bakes an explicit PNG path per cell, so
 * the key is derived from that path; the legacy (t,v) form is kept for the
 * legacy category+variant worlds (none shipped since the demo retired). */
export function tileKey(t: string, v: number): string {
  return `tile:${t}:${v}`;
}

/** Texture key for a maps2 explicit tile path ("tiles2/mat/base/…/tile_NN.png"). */
export function pathTileKey(path: string): string {
  return "t2:" + path;
}

/** Repo-relative asset path ("tiles2/…") → served URL ("/assets/tiles2/…"). */
export function assetUrl(path: string): string {
  return "/assets/" + path.replace(/^\/+/, "");
}

/** Texture key for a maps2 cell's TOP surface tile (its baked `path`). */
export function topKeyFor(cell: WorldCell): string | null {
  return cell.path ? pathTileKey(cell.path) : null;
}

/** Texture key for a maps2 cell's FACE (the stacked cliff below the surface):
 * the material's plain base tile, so terraces read as one wall. Falls back to
 * the cell's own top tile if no face tile is registered for the material. */
export function faceKeyFor(world: World, cell: WorldCell): string | null {
  const fp = world.faceTiles?.[cell.t];
  if (fp) return pathTileKey(fp);
  return cell.path ? pathTileKey(cell.path) : null;
}

/** Every unique tile PNG path the world references (per-cell tops + per-material
 * faces) — the set to preload as Phaser textures for a maps2 world. */
export function distinctTilePaths(world: World): string[] {
  const set = new Set<string>();
  for (const row of world.rows)
    for (const c of row) if (c?.path) set.add(c.path);
  for (const p of Object.values(world.faceTiles ?? {})) set.add(p);
  // world@2 decks: their top tiles (the face uses the material's faceTile).
  for (const d of world.decks ?? [])
    for (const c of d.cells) if (c.path) set.add(c.path);
  return [...set];
}

/** Every unique PROP tile PNG path the world places — the set to preload
 * alongside the ground tiles (props are tall 64×128 tiles keyed by path too). */
export function distinctPropPaths(world: World): string[] {
  const set = new Set<string>();
  for (const p of world.props ?? []) set.add(p.path);
  return [...set];
}

/** True when this world is a maps2 world (cells carry explicit tile paths). */
export function isMaps2World(world: World): boolean {
  return !!world.faceTiles || world.rows.some((r) => r.some((c) => c?.path));
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
  // Census roles (cliff/wall/spire/…) for categories that have one — cliff
  // and wall art is a solid FACE the night shader may treat as a column.
  roles?: Record<string, string>;
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
