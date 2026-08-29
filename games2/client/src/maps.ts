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
  /** maps3: the world's own projection (see geometryFor). Absent on v1/v2. */
  iso?: IsoGeometry;
  /** maps3: the grounds the world declares liquid. */
  liquids?: string[];
  /** maps3: per-cell wall-BODY override, keyed row*width+col. */
  wallSides?: Record<number, string>;
  /** maps3: off-grid set dressing (scenery3 draws it). */
  scenery?: { piece: string; x: number; y: number; hflip?: boolean; lit?: boolean }[];
}

import { ISO_DX, ISO_DY, LEVEL_PX, isoOf, WorldCell, WorldProp, Deck, parseWorld } from "@nangijala/shared";
import type { IsoGeometry } from "@nangijala/shared";
import { gameUrl, resolveStagingBase, fetchSoon } from "./staging";
import { isoFrame, columnX, columnY, DX as R3_DX, DY as R3_DY } from "./tiles3";

export type { WorldProp, Deck };

/** True when this world is a `pixel-maps3/world@1` world: cells name a ground
 * TYPE and no art, and the art is resolved at draw time (tiles3). The `iso`
 * field is the marker because parseWorld3 is the only producer of it. */
export function isMaps3World(world: World): boolean {
  return !!world.iso;
}

// maps2/tiles2 geometry: top diamond 30px×64px, grid steps dx=32/dy=15, one
// elevation level = 16px face (LEVEL_PX). dx/dy live in shared/ (ISO_DX/ISO_DY)
// because screen-relative input math on the server must use the same ratio.
export const MAP_GEOMETRY = { tile: 64, dx: ISO_DX, dy: ISO_DY, lh: LEVEL_PX, margin: 8 };

/** THE GEOMETRY A WORLD DRAWS AT. `MAP_GEOMETRY` is the DEFAULT (tiles2's
 * 32/15/16); a maps3 world publishes its own `iso` (32/14/15) through
 * `parseWorld3`, and every projection in the client reads THIS rather than the
 * module constant. A world@1/world@2 world has no `iso`, so it gets exactly the
 * object above and its pixels cannot move. */
export type MapGeometry = typeof MAP_GEOMETRY;
export function geometryFor(world?: { iso?: IsoGeometry } | null): MapGeometry {
  const g = isoOf(world);
  if (g.dx === MAP_GEOMETRY.dx && g.dy === MAP_GEOMETRY.dy && g.lh === MAP_GEOMETRY.lh) return MAP_GEOMETRY;
  return { ...MAP_GEOMETRY, dx: g.dx, dy: g.dy, lh: g.lh };
}

// The default world when the player hasn't picked one — the_island2, the world
// closest to the real game (maintainer 2026-07-23). It's the preselected pick on
// a fresh join (no stored choice) AND the top row of the picker (see
// orderWorlds). The maps agent adds worlds under maps2/worlds/<name>/; a world
// becomes playable + selectable once it has a world.json (see worlds.json,
// built by scripts/build-worlds.mjs).
export const DEFAULT_WORLD = "the_island2";

/* -- WHICH TREE A WORLD LIVES IN ------------------------------------------- */
// `maps2/worlds` holds world@1/world@2; `maps2/worlds3` holds
// pixel-maps3/world@1 (semantics only — tiles3 resolves its art at draw time).
// Both parse through the same `parseWorld`, so the tree is the ONLY difference
// the client has to carry, and it carries it here so every world-file URL in
// the client comes from one place.
const WORLD_ROOT_DEFAULT = "maps2/worlds";

// Name -> tree, learned from worlds.json / the staging policy at boot. A name
// nobody registered answers with the DEFAULT root, which is byte-for-byte the
// URL this module built before worlds3 existed — so a stale caller, a probe or
// a remembered v2 world is unaffected.
const worldRoots = new Map<string, string>();

/** Record a world's tree. Called by loadWorldsList/stagingWorlds as the picker
 *  learns them; harmless to call twice with the same value. */
export function setWorldRoot(name: string, root: string | null | undefined): void {
  if (root && /^maps2\/worlds3?$/.test(root)) worldRoots.set(name, root);
}

export function worldRoot(name: string): string {
  return worldRoots.get(name) ?? WORLD_ROOT_DEFAULT;
}

/** Served URL for one file of one world. Goes through gameUrl at the call
 *  sites (this returns the IMAGE-relative form, which gameUrl maps to the CDN
 *  when a staging world is active). */
export function worldFileUrl(name: string, file: string): string {
  return `/assets/${worldRoot(name)}/${name.replace(/[^a-z0-9_-]/gi, "")}/${file}`;
}

export function worldUrl(name: string): string {
  return worldFileUrl(name, "world.json");
}

/* -- THE MAP TAB'S IMAGE, AND WHERE THE PLAYER IS ON IT --------------------- */
// A world's map image is a RENDER, so the "you are here" dot must be placed by
// THAT renderer's projection. Two renderers ship two images under two names:
//
//   world@1/@2  maps2/pipeline/render2.py  render_overview/_origin  minimap.webp
//   maps3       maps2/pipeline/render3.py  render()                 overview.webp
//
// The URL and the projection therefore branch on the same fact — `iso` is set
// only by parseWorld3 — and both live here because `worldFileUrl` is the one
// place a world-file URL is built and `geometryFor` is the one place a world's
// projection is read.
//
// PERCENTAGES ARE SCALE-INVARIANT, which is why neither renderer's output
// scaling appears below: render2 saves at scale 0.5 capped to 2000-2400px wide,
// render3 at min(0.5, 16300/fw) (WebP hard-limits a side to 16383px). Only the
// FULL canvas origin and size matter, and both are exact integers.

/** The live feed the Map tab reads from `window.__ml.minimap()` (WorldScene). */
export interface MinimapFeed {
  /** World id — resolved to a URL through `worldFileUrl`, never concatenated. */
  world: string;
  /** Grid width in cells. */
  w: number;
  /** Grid height in cells. */
  h: number;
  /** The world's tallest terrain level: BOTH renderers lift the canvas origin
   *  by it, so the dot is wrong everywhere without it. */
  maxL: number;
  /** Local player's fractional cell (fx / CELL_WU). */
  col: number;
  /** Local player's fractional cell (fy / CELL_WU). */
  row: number;
  /** Terrain level under the player — the iso dot lifts with the ground. */
  level: number;
  /** The world's own projection when a maps3 renderer drew it (`World.iso`);
   *  absent on world@1/@2, which is what selects render2's overview below. */
  iso?: IsoGeometry;
}

/** render2's canvas margin (`MARGIN`); the 40/64/80 pads below are its own. */
const R2_MARGIN = 12;

/** Cell -> fraction of render2's overview canvas (world@1/@2). */
function maps2DotFrac(m: MinimapFeed): [number, number] {
  const { dx, dy, lh } = MAP_GEOMETRY;
  const ox = (m.h - 1) * dx + R2_MARGIN;
  const oy = m.maxL * lh + 40 + R2_MARGIN;
  const fullW = (m.w + m.h) * dx + R2_MARGIN * 2;
  const fullH = (m.w + m.h) * dy + 64 + m.maxL * lh + 80;
  // render2 pastes a cell's 64-box at (ox + (x-y)*dx, oy + (x+y)*dy - L*lh) and
  // a tiles2 top diamond is 64 wide x 30 tall from that box's row 0, so the
  // diamond's CENTRE is +dx across and +dy down.
  return [
    (ox + (m.col - m.row) * dx + dx) / fullW,
    (oy + (m.col + m.row) * dy - m.level * lh + dy) / fullH,
  ];
}

/** Cell -> fraction of render3's overview canvas (maps3). */
function maps3DotFrac(m: MinimapFeed): [number, number] {
  // render3's origin, from the client's PROVEN replica of it rather than a
  // second copy of the constants: `isoFrame` is render3.render()'s ox/oy/canvas
  // for a window, and the map image is the window x0=y0=0, x1=w, y1=h. Note it
  // takes BOTH pitches — the origin's headroom is render3's literal WALL (17),
  // the per-level lift is the MEASURED storey pitch (`iso.lh`, 15).
  const f = isoFrame({ x0: 0, y0: 0, x1: m.w, y1: m.h }, m.maxL, geometryFor(m).lh);
  const [fullW, fullH] = f.canvas;
  // columnX is the cell's 64-box LEFT edge and columnY is its top diamond's
  // APEX row (a 64x46 plate's row 0 IS the apex — the same anchor scenery3
  // derives its placements from). The diamond is 64x28 on this lattice, so its
  // CENTRE is +DX across and +DY down.
  return [
    (columnX(f, m.col, m.row) + R3_DX) / fullW,
    (columnY(f, m.col, m.row, m.level) + R3_DY) / fullH,
  ];
}

/** Player cell (col,row) at terrain `level` -> [x%, y%] of the world's map
 *  image. Clamped, because `fx/fy` can ease a hair past the rim. */
export function minimapDotPct(m: MinimapFeed): [number, number] {
  const [fx, fy] = m.iso ? maps3DotFrac(m) : maps2DotFrac(m);
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return [clamp(fx) * 100, clamp(fy) * 100];
}

/** The world's map-tab image, in the order to try it. render2 writes
 *  `minimap.webp` beside a world@1/@2 world; render3 writes `overview.webp`
 *  beside a maps3 one — a different tree AND a different filename, both of them
 *  resolved here through `worldFileUrl`. The `.png` second entry is the
 *  format-agnostic probe the Map tab has always done, so no domain has to hand
 *  us a format.
 *
 *  DELIBERATELY UNVERSIONED (no `withV`): these names are STABLE and the art
 *  behind them is regenerable, so the URL must never carry a one-year
 *  `immutable` grant. Unstamped, the server answers `no-cache`
 *  (server/src/cachepolicy.ts) and a regenerated map is picked up on the next
 *  load; for a staging world `gameUrl` rewrites it to the sha-pinned CDN, where
 *  a cached copy can only ever be the whole of one commit. When maps2 moves
 *  these outputs to hashed names + an index, THIS is the function that reads
 *  the index — nothing else in the client names the file. */
export function mapImageUrls(w: { world: string; iso?: IsoGeometry }): string[] {
  const stem = w.iso ? "overview" : "minimap";
  return [".webp", ".png"].map((ext) => gameUrl(worldFileUrl(w.world, stem + ext)));
}

/** Learn every world's TREE from the built manifest, with none of the picker's
 *  admin/staging round trips — for callers that need only the URL mapping. */
export async function loadWorldRoots(): Promise<void> {
  try {
    const res = await fetchSoon("/worlds.json", 8000, { cache: "no-cache" });
    if (!res.ok) return;
    const list = (await res.json()) as WorldInfo[];
    if (Array.isArray(list)) for (const w of list) setWorldRoot(w.name, w.root);
  } catch {}
}

export async function loadWorld(name: string = DEFAULT_WORLD): Promise<World | null> {
  try {
    const res = await fetch(gameUrl(worldUrl(name)));
    if (!res.ok) return null;
    return parseWorld(await res.json());
  } catch {
    return null;
  }
}

/** NAMED INDOOR PLACES (maps2 `places.json`, schema pixel-maps2/places@1): the
 * maps agent labels the interiors — "the_cave", "meadow_house" — so the game
 * can react to WHERE the player is standing rather than re-deriving it from
 * geometry. The composer uses it to put a specific score inside a specific
 * room (maintainer 2026-08-08: cave4 inside the_cave, day or night).
 *
 * Returned as a cell lookup because that is the only question anyone asks of
 * it — "what am I standing in?" — and a 472-cell polygon test per frame would
 * be silly when a Map hit is O(1). Missing file is not an error: a world may
 * simply have no named places, and the game must not care. */
export type PlaceLookup = { at(cx: number, cy: number): string | null; ids: string[] };

export async function loadPlaces(name: string = DEFAULT_WORLD): Promise<PlaceLookup | null> {
  const url = gameUrl(worldFileUrl(name, "places.json"));
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const doc = (await res.json()) as { places?: { id?: string; cells?: [number, number][] }[] };
    const byCell = new Map<number, string>();
    const ids: string[] = [];
    for (const p of doc.places ?? []) {
      if (!p?.id || !Array.isArray(p.cells)) continue;
      ids.push(p.id);
      // One integer key per cell — cheaper than a string and collision-free for
      // any world under 65536 cells wide.
      for (const c of p.cells) if (Array.isArray(c)) byCell.set(((c[0] | 0) << 16) | (c[1] & 0xffff), p.id);
    }
    if (!byCell.size) return null;
    return { at: (cx, cy) => byCell.get(((cx | 0) << 16) | (cy & 0xffff)) ?? null, ids };
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
  /** A DEV map: offered only to a signed-in admin (build-worlds marks
   * anything outside config/publish.json's userWorlds). */
  dev?: boolean;
  /** Not in this image at all — joined via the staging path (staging.ts
   * client-side, WorldRoom's GitHub fallback server-side). */
  staging?: boolean;
  /** The tree this world's files live in: "maps2/worlds" (world@1/@2, the
   * default and therefore omitted) or "maps2/worlds3" (pixel-maps3). */
  root?: string;
}

/** The list of playable worlds for the selector, DEFAULT_WORLD first. Falls back
 * to just the default when the manifest is missing (older build / maps agent
 * hasn't run yet). */
export async function loadWorldsList(): Promise<WorldInfo[]> {
  try {
    const res = await fetchSoon("/worlds.json", 8000, { cache: "no-cache" });
    if (res.ok) {
      const list = (await res.json()) as WorldInfo[];
      if (Array.isArray(list) && list.length) {
        // Register every entry's tree BEFORE any filtering — worldUrl() and the
        // sidecar fetches read this map, and a world dropped from the offered
        // list can still be re-entered from `ml-last-choice`.
        for (const w of list) setWorldRoot(w.name, w.root);
        // DEV MAPS are shipped so they WORK (the server reads world.json off
        // disk — a map the image lacks cannot be joined at all) but they are
        // not the game. An end user is offered only `userWorlds`; a signed-in
        // admin gets everything, which is how the maintainer keeps testing
        // house_demo/glow_test on the live site with no laptop.
        //
        // Fail CLOSED: any error, no token, or a server that says no ⇒ the
        // player-facing list. The gate is a product boundary, not a security
        // one (the repo is public and the maps are readable on GitHub) — the
        // point is that the game never OFFERS them.
        //
        // DEV BUILDS ARE EXEMPT. `npm run dev` is the harness every verify gate
        // drives, and those gates call __mlSelect.pickWorld() to reach
        // house_demo / glow_test / monster_demo. Filtering there would not make
        // anything safer (it is localhost against the working tree) and would
        // silently break the whole gate suite.
        if (import.meta.env.DEV) return orderWorlds(list);
        if (!(await isAdmin())) return orderWorlds(list.filter((w) => !w.dev));
        // ADMIN: also offer the STAGING worlds — dev maps that are not in this
        // image at all (config/publish.json ships only userWorlds since
        // 2026-08-15). Their names come from the committed policy via the
        // staging CDN; joining one streams its data from the repo (staging.ts
        // client-side, WorldRoom's GitHub fallback server-side). Any failure
        // here just means the picker shows what the image has.
        return orderWorlds([...list, ...(await stagingWorlds(new Set(list.map((w) => w.name))))]);
      }
    }
  } catch {}
  return [{ name: DEFAULT_WORLD, label: "The Island2" }];
}

/** Dev worlds the image does NOT carry, from the committed publish policy. */
async function stagingWorlds(have: Set<string>): Promise<WorldInfo[]> {
  try {
    const base = await resolveStagingBase();
    if (!base) return [];
    const res = await fetchSoon(`${base}games2/config/publish.json`, 2500);
    if (!res.ok) return [];
    // TWO LISTS, ONE PER TREE. `devWorlds` names maps2/worlds entries,
    // `devWorlds3` names maps2/worlds3 (pixel-maps3) ones — kept apart because
    // the name alone cannot say which directory holds the world, and both the
    // client's fetches and shipset's policy check need to know.
    const policy = (await res.json()) as { devWorlds?: string[]; devWorlds3?: string[] };
    const from = (names: unknown, root: string): WorldInfo[] =>
      (Array.isArray(names) ? names : [])
        .filter((n): n is string => typeof n === "string" && /^[a-z0-9_-]+$/i.test(n) && !have.has(n))
        .map((n) => {
          setWorldRoot(n, root);
          return {
            name: n,
            label: n.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
            dev: true,
            staging: true,
            preview: null,
            root,
          };
        });
    return [...from(policy.devWorlds, "maps2/worlds"), ...from(policy.devWorlds3, "maps2/worlds3")];
  } catch {
    return [];
  }
}

/** Is this browser signed in as the game designer? Asks the SERVER — the token
 * in localStorage is only a claim, and the server is the thing that can check
 * the HMAC. Cached for the page's lifetime: the picker asks once at boot. */
let adminCache: Promise<boolean> | null = null;
function isAdmin(): Promise<boolean> {
  if (adminCache) return adminCache;
  adminCache = (async () => {
    try {
      const token = localStorage.getItem("wiki-admin-token");
      if (!token) return false;
      const res = await fetchSoon("/api/wiki/me", 3000, {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) return false;
      return !!(await res.json())?.admin;
    } catch {
      return false;
    }
  })();
  return adminCache;
}

/** Put DEFAULT_WORLD (the world closest to the real game) at the TOP of the
 * picker, keeping every other world in its manifest order. No-op if it's already
 * first or absent. */
function orderWorlds(list: WorldInfo[]): WorldInfo[] {
  const i = list.findIndex((w) => w.name === DEFAULT_WORLD);
  return i <= 0 ? list : [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
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
  const { dx, dy, lh, margin, tile } = geometryFor(world);
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
