/* TILES 3.0 RUNTIME — the STREAMING half of the resolver: one cell in, drawable
 * blits out, with nothing whole-world about it except the two things that must
 * be.
 *
 * `tiles3.ts` proves the resolution and publishes `resolveWindow`, a sweep that
 * allocates per cell and costs ~420ms over the_game — right for a gate, wrong
 * for a frame. This module is the same decisions taken ONE CELL AT A TIME out
 * of the resolver's own public primitives (`plateAt`, `flatTile`, `overTile`,
 * `storeyTile`, `fadePool`, `detailPool`, `sideRoles`, `maskFrame`,
 * `columnX/columnY`), so a camera window resolves in the microseconds a redraw
 * has. `server/test/tiles3runtime.test.ts` asserts cell for cell, boundary for
 * boundary and deck for deck that it returns EXACTLY what `resolveWindow`
 * returns — that equality is the whole licence for this file to exist.
 *
 * TWO THINGS STAY WHOLE-WORLD, and both are correctness, not performance:
 *
 *   REGIONS. The set that paints a ground is picked per REGION, and a region id
 *   is `<ground>@<x/24>,<y/24>` — a CHUNK, so it is a pure function of the
 *   coordinates and a camera window can never change it. `Regions` is still
 *   built over the whole doc because a consumer wants the LIST of ids; the
 *   lookup itself needs no table.
 *
 *   THE GROUND LOOKUP. render3 renders the whole map, so its `g()` is clamped
 *   to the whole map. Clamping to a camera window would cut regions, fade bands
 *   and boundaries at the screen edge — art that changes when you scroll. The
 *   bounds are therefore the world's, and the streaming is done by the CALLER
 *   asking about the cells it needs.
 *
 * NO PHASER IMPORT, NO DOM TYPES. What it needs from the host — a texture
 * manager, a loader, a canvas — is declared structurally (tiles3draw already
 * declares the first and third), so the whole module is provable under node.
 */

import {
  Tiles3,
  computeRegions,
  type BaseTileSetsDoc,
  type Bounds,
  type Deck3,
  type FadesDoc,
  type Frame,
  type GroundType,
  type MemberResolveDoc,
  type PatternsDoc,
  type Regions,
  type ReviewManifest,
  type SlopesDoc,
  type TileArt,
  type Tiles3Boundary,
  type Tiles3Cell,
  type Tiles3Data,
  type Tiles3DeckCell,
  type World3View,
} from "./tiles3";
import {
  artKey,
  assetPath,
  patternSheetPaths,
  plateKey,
  type PatternSheets,
  type TextureManagerLike,
  type Tiles3Blit,
  type Tiles3Textures,
  type UrlRoute,
} from "./tiles3draw";

/* -- the world, as the resolver reads it ------------------------------------ */

/** The shape `viewFromParsed` needs — `ParsedWorld` structurally, so this module
 *  never imports the engine's own types (and a raw doc's arrays would not
 *  satisfy it: the client parses before it renders). */
export interface ParsedLike {
  width: number;
  height: number;
  rows: { t: string; l: number }[][];
  liquids?: string[];
  wallSides?: Record<number, string>;
  decks?: { kind?: string; mat?: string; level: number; thickness: number; cells: { col: number; row: number }[] }[];
}

/** A `World3View` over the ALREADY-PARSED world, not over the raw document.
 *  `parseWorld3` is lossless for everything the resolver reads (ground name in
 *  `t`, level in `l`, liquids, wallSides, decks), so re-fetching world.json to
 *  hand `viewFromDoc` a second copy would cost a 3.6 MB download to learn what
 *  the client already holds. */
export function viewFromParsed(w: ParsedLike, bounds?: Partial<Bounds>): World3View {
  const liquids = new Set<string>(w.liquids ?? []);
  let maxLevel = 0;
  for (const row of w.rows) for (const c of row) if (c.l > maxLevel) maxLevel = c.l;
  const decks: Deck3[] = (w.decks ?? []).map((d) => ({
    kind: d.kind,
    ground: d.mat,
    level: d.level,
    thickness: d.thickness,
    cells: d.cells.map((c) => ({ x: c.col, y: c.row })),
  }));
  return {
    x0: bounds?.x0 ?? 0,
    y0: bounds?.y0 ?? 0,
    x1: bounds?.x1 ?? w.width,
    y1: bounds?.y1 ?? w.height,
    width: w.width,
    height: w.height,
    maxLevel,
    groundAt(x, y) {
      if (x < 0 || x >= w.width || y < 0 || y >= w.height) return null;
      const t = w.rows[y]?.[x]?.t;
      return t ? t : null;
    },
    levelAt(x, y) {
      return x >= 0 && x < w.width && y >= 0 && y < w.height ? w.rows[y]?.[x]?.l ?? 0 : 0;
    },
    isLiquid: (g) => liquids.has(g),
    wallSideAt: (x, y) => w.wallSides?.[y * w.width + x] || null,
    decks,
  };
}

/* -- per-cell resolution ---------------------------------------------------- */

/** The resolver's decisions for ONE cell, ONE lattice corner or ONE deck cell.
 *  Every method here is a line-for-line port of the matching arm of
 *  `Tiles3.resolveWindow`, and the gate proves the two agree. */
export class Tiles3World {
  readonly view: World3View;
  readonly tiles: Tiles3;
  readonly frame: Frame;
  readonly regions: Regions;
  readonly bounds: Bounds;
  /** The patterns index, for the boundary's `pattern` id. Passed rather than
   *  read back off `Tiles3` — the resolver keeps its data private, and the one
   *  field wanted here is the same object the caller already handed it. */
  private readonly patterns: PatternsDoc;
  /** Deck cells by `y * width + x`, so a draw pass does not rescan 979 cells. */
  private deckAt = new Map<number, number[]>();

  constructor(o: { view: World3View; tiles: Tiles3; frame: Frame; patterns: PatternsDoc; bounds?: Bounds }) {
    this.view = o.view;
    this.tiles = o.tiles;
    this.frame = o.frame;
    this.patterns = o.patterns;
    this.bounds = o.bounds ?? { x0: o.view.x0, y0: o.view.y0, x1: o.view.x1, y1: o.view.y1 };
    this.regions = computeRegions(this.bounds, (x, y) => this.g(x, y));
    this.view.decks.forEach((dk, di) => {
      for (const c of dk.cells) {
        const k = c.y * this.view.width + c.x;
        const list = this.deckAt.get(k);
        if (list) list.push(di);
        else this.deckAt.set(k, [di]);
      }
    });
  }

  /** render3's `g()`: null outside the bounds. Bound once — the resolver takes
   *  it as a callback and a fresh arrow per cell would allocate per frame. */
  readonly gf = (x: number, y: number): string | null => {
    const b = this.bounds;
    return x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 ? this.view.groundAt(x, y) : null;
  };

  /** render3's `L()`: NOT bounds-clamped — a cliff at the edge still knows how
   *  far it drops. */
  readonly Lf = (x: number, y: number): number => this.view.levelAt(x, y);

  g(x: number, y: number): string | null {
    return this.gf(x, y);
  }

  L(x: number, y: number): number {
    return this.Lf(x, y);
  }

  /** Everything one cell draws. Null for void / out of bounds.
   *
   *  DELEGATED, not re-implemented: `Tiles3.resolveCell` IS the arm of
   *  `resolveWindow` that resolves a cell, so the streaming path and the sweep
   *  cannot drift by construction. The window this file resolves against is the
   *  WHOLE world (see the header), so `g` is clamped to `bounds` and never to a
   *  camera. */
  cell(x: number, y: number): Tiles3Cell | null {
    return this.tiles.resolveCell(this.view, this.frame, this.gf, this.Lf, x, y);
  }

  /** THE COMPOSED BOUNDARY this cell wears, for a draw pass that composes it in
   *  its own layer. Same call `resolveCell` makes. */
  boundary(x: number, y: number): Tiles3Boundary | null {
    const b = this.bounds;
    if (x < b.x0 || y < b.y0 || x >= b.x1 || y >= b.y1) return null;
    return this.tiles.boundaryAt(this.view, this.frame, this.gf, this.Lf, x, y)?.boundary ?? null;
  }

  /** The deck cells standing on one world cell, resolved. A world cell can carry
   *  more than one deck, and the order is the document's. */
  decks(x: number, y: number): Tiles3DeckCell[] {
    const dis = this.deckAt.get(y * this.view.width + x);
    if (!dis) return [];
    const b = this.bounds;
    if (x < b.x0 || x >= b.x1 || y < b.y0 || y >= b.y1) return [];
    return dis.map((di) => this.tiles.deckCell(this.view, this.frame, this.view.decks[di], di, x, y));
  }
}

/* -- the host: loading art on demand ---------------------------------------- */

/** Structurally satisfied by `Phaser.Loader.LoaderPlugin`. */
export interface LoaderLike {
  image(key: string, url: string): unknown;
  isLoading(): boolean;
  start(): void;
  once(event: string, cb: () => void): unknown;
  /** EVERY file as it finishes — success or error — with its key. Without it
   *  `pending` can only settle when a whole batch lands, which makes the
   *  loading bar a staircase: measured on the_game, the 140-file terrain batch
   *  held the bar at 54% for 8 s and then jumped it to 100% (maintainer
   *  2026-09-02: "it loads 55% and the last 45% goes super fast"). Optional —
   *  a caller that does not offer it still settles per batch, exactly as
   *  before. */
  onFile?(cb: (key: string) => void): unknown;
}

/** THE STREAMING ART CACHE. A draw pass asks for the files a window needs; this
 *  queues the ones that are not resident, starts the loader at most once per
 *  pass, and calls `onBatch(paths)` when a batch lands so the caller can repaint
 *  what those files were wanted for.
 *
 *  A PATH IS REQUESTED ONCE, EVER. A 404 (a stale index, an unpublished tile)
 *  would otherwise re-fire on every redraw the cell is on screen — the requested
 *  set is the tombstone, exactly as `SceneryPieces` does for manifests. */
export class Tiles3Loader {
  /** `done` counts FILES, so `requested - done` is honest progress mid-batch;
   *  `pending` is kept as its mirror because the loading hold and the probes
   *  read it. */
  readonly stats = { requested: 0, batches: 0, pending: 0, done: 0 };
  /** Keys this loader asked for and has not seen finish. The scene shares its
   *  Phaser loader with the SCENERY art, so a file event has to be matched
   *  against what THIS loader queued or terrain progress counts someone else's
   *  files. */
  private inflight = new Set<string>();
  private asked = new Set<string>();
  private queued: string[] = [];

  constructor(
    private o: {
      loader: LoaderLike;
      textures: TextureManagerLike;
      route?: UrlRoute;
      onBatch: (paths: string[]) => void;
    },
  ) {
    this.o.loader.onFile?.((key) => {
      if (!this.inflight.delete(key)) return; // scenery art, or a stray
      this.stats.done = Math.min(this.stats.requested, this.stats.done + 1);
      this.stats.pending = Math.max(0, this.stats.requested - this.stats.done);
    });
  }

  /** Queue one repo-relative art file if it is neither resident nor asked for.
   *  Returns true when the texture is ALREADY drawable. */
  need(path: string | null | undefined): boolean {
    if (!path) return false;
    const key = artKey(path);
    if (this.o.textures.exists(key)) return true;
    if (!this.asked.has(path)) {
      this.asked.add(path);
      this.queued.push(path);
    }
    return false;
  }

  /** Is this path still coming — queued or in flight? False for a resident
   *  texture and for a tombstoned (404) path, which will never land. */
  wanted(path: string): boolean {
    return this.inflight.has(artKey(path)) || this.queued.includes(path);
  }

  /** Files asked for and not yet started (`flush()` starts them). */
  get queuedCount(): number {
    return this.queued.length;
  }

  /** NOTHING QUEUED AND NOTHING IN FLIGHT — every path `need()` has been shown
   *  is resident, or tombstoned by a 404 that will not be asked for again.
   *  `stats.pending` alone is not this: `need()` only queues, and the queue does
   *  not become pending until `flush()`, so pending is 0 in the window between a
   *  pass and its flush with art still owed. */
  get idle(): boolean {
    return this.queued.length === 0 && this.stats.pending === 0;
  }

  /** Files finished of files asked for, 0..1 — the loading bar's terrain half. */
  get progress(): number {
    return this.stats.requested ? this.stats.done / this.stats.requested : 1;
  }

  /** Start the queued batch, if any. Safe to call every pass. */
  flush(): void {
    if (!this.queued.length) return;
    const batch = this.queued;
    this.queued = [];
    this.stats.requested += batch.length;
    this.stats.pending = Math.max(0, this.stats.requested - this.stats.done);
    for (const path of batch) {
      const key = artKey(path);
      this.inflight.add(key);
      this.o.loader.image(key, routeUrl(path, this.o.route));
    }
    /* THE BATCH RECONCILES what the per-file events did not. Every file of this
     * batch is finished by now, so `done` may be pulled up to the count at
     * flush time — which also makes the whole thing self-healing when a caller
     * offers no `onFile` at all (then this IS the accounting, as before). */
    const upTo = this.stats.requested;
    this.o.loader.once("complete", () => {
      this.stats.batches++;
      for (const path of batch) this.inflight.delete(artKey(path));
      this.stats.done = Math.max(this.stats.done, Math.min(upTo, this.stats.requested));
      this.stats.pending = Math.max(0, this.stats.requested - this.stats.done);
      this.o.onBatch(batch);
    });
    if (!this.o.loader.isLoading()) this.o.loader.start();
  }
}

const routeUrl = (path: string, r?: UrlRoute): string => {
  const g = r?.gameUrl ?? ((u: string) => u);
  const v = r?.withV ?? ((u: string) => u);
  return v(g(assetPath(path)));
};

/* -- the documents the resolver reads --------------------------------------- */

/** Every file `Tiles3Data` is built from, as repo-relative paths. They are
 *  fetched as JSON, not imported: `live/tuning/base_tile_sets.json` and
 *  `live/feedback/tiles.json` are the LIVE channel — the maintainer edits them
 *  from the wiki and the world must follow without a redeploy. */
export const TILES3_DOCS = {
  resolve: "tiles/resolve.json",
  groundTypes: "tiles/ground_types.json",
  patterns: "tiles/patterns/index.json",
  review: "tiles/review/manifest.json",
  fades: "tiles/fades/index.json",
  slopes: "tiles/slopes/index.json",
  baseTileSets: "live/tuning/base_tile_sets.json",
  basePromotions: "live/tuning/base_tiles.json",
  tileWalls: "live/tuning/tile_walls.json",
  topWalls: "live/tuning/top_walls.json",
  tileTops: "live/tuning/tile_tops.json",
  feedback: "live/feedback/tiles.json",
} as const;

export type Tiles3DocKey = keyof typeof TILES3_DOCS;

/** Repo-relative -> the URL to fetch, staged and version-pinned. */
export function docUrl(path: string, route?: UrlRoute): string {
  return routeUrl(path, route);
}

/** The three pattern sheets a composed boundary needs, from the patterns index.
 *  World-independent — they load once at boot. */
export function sheetPaths(patterns: PatternsDoc): string[] {
  const p = patternSheetPaths(patterns);
  return [p.silhouette, p.masks, p.border];
}

/** Assemble `Tiles3Data` from the fetched documents. A missing document is not
 *  fatal for any of them individually — the resolver degrades to clean art and
 *  says so — but `patterns` and `groundTypes` decide geometry and colour, so
 *  they are required and a null return means "do not render this world as
 *  maps3". */
export function tiles3DataFrom(
  docs: Partial<Record<Tiles3DocKey, any>>,
  storeyPitch: number,
  warn?: (m: string) => void,
): Tiles3Data | null {
  const groundTypes = docs.groundTypes?.grounds as Record<string, GroundType> | undefined;
  const patterns = docs.patterns as PatternsDoc | undefined;
  if (!groundTypes || !patterns) return null;
  return {
    baseTileSets: (docs.baseTileSets ?? {}) as BaseTileSetsDoc,
    memberResolve: (docs.resolve ?? {}) as MemberResolveDoc,
    groundTypes,
    patterns,
    storeyPitch,
    review: docs.review as ReviewManifest | undefined,
    feedback: docs.feedback?.entries,
    wallOverrides: docs.tileWalls?.overrides,
    basePromotions: docs.basePromotions?.overrides,
    fades: docs.fades as FadesDoc | undefined,
    slopes: docs.slopes as SlopesDoc | undefined,
    topWallOverrides: docs.topWalls?.overrides,
    topOverrides: docs.tileTops?.overrides,
    /* NO live/tuning/tile_details.json: the wiki has never published it, and a
     * document in TILES3_DOCS is fetched on every world load — a permanent 404
     * per boot to read a rate that does not exist. `Tiles3Data.detailRates` is
     * wired and every ground uses DETAIL_FREQ until the file appears; add the
     * path above on the day it does (render3 reads `.rate`). */
    /* NO FADE GUARD IN THE GAME, and it is a known, measured difference. The
     * guard is a PIXEL test over each candidate fade tile's own top diamond
     * (80th percentile distance to the nearer palette top, rejected above 78),
     * so running it needs the art decoded — and the pool has to be built to know
     * which art to fetch. Measured on the parity fixture: 2 of 10 pools keep a
     * tile render3 drops. That is a wrong tile inside a 1-cell fade band, never
     * a hole, and `Tiles3.stats.unguardedFadePools` counts it. */
    warn,
  };
}

/* -- draw ops --------------------------------------------------------------- */

/** THE ORDER RENDER3 PAINTS IN, per cell: the surface (a plate, a composed
 *  boundary, a fade, a liquid diamond) and then, for a level change, the
 *  x-over-y wall stack — whole tiles, one per storey, lowest exposed first.
 *
 *  `cut` truncates the column at a level (indoor mode's cut-away). The tile at
 *  the top of a TRUNCATED stack is a FACE, never the cap: the cap carries the
 *  cell's own top diamond and reads as a lid on a wall stump — the same rule
 *  the world@2 branch has carried since the cut-away shipped. */
export function cellBlits(
  t3: Tiles3Textures,
  tex: TextureManagerLike,
  cell: Tiles3Cell,
  cut?: number,
): Tiles3Blit[] {
  // A field cell is level 0 (or a liquid): it has no column, so a cut cannot
  // shorten it and the unconstrained path IS the constrained one.
  if (cell.kind === "field" || cut === undefined) return t3.opsForCell(cell);
  const w = cell.wall;
  if (!w) return [];
  const hi = Math.min(cell.level, cut);
  if (hi < 0) return [];
  const out: Tiles3Blit[] = [];
  for (const s of w.stack) {
    if (s.storey > hi) continue;
    const tile: TileArt = s.storey === hi && hi < cell.level ? w.mid : s.tile;
    const key = tile.path ? artKey(tile.path) : null;
    if (!key || !tex.exists(key)) continue;
    out.push({ key, x: cell.sx, y: s.y, sx: 0, sy: 0, sw: tile.w, sh: tile.h, role: "wall" });
  }
  return out;
}

/** Every repo-relative art file one resolved cell can draw — what the loader is
 *  asked for BEFORE the blits are taken, so the next redraw has it. */
export function cellArtPaths(cell: Tiles3Cell, out: (p: string) => void): void {
  if (cell.kind === "field") {
    if (cell.art && cell.art.kind !== "liquid") out(cell.art.path);
    return;
  }
  if (cell.wall) for (const s of cell.wall.stack) if (s.tile.path) out(s.tile.path);
}

export function boundaryArtPaths(b: Tiles3Boundary, out: (p: string) => void): void {
  out(b.plateA.path);
  out(b.plateB.path);
}

export function deckArtPaths(d: Tiles3DeckCell, out: (p: string) => void): void {
  for (const s of d.stack) if (s.tile.path) out(s.tile.path);
}

/** The drawable texture key for a cell's SURFACE — what an occluder copy of
 *  that cell must draw. Null while the art is still loading. */
export function surfaceKey(t3: Tiles3Textures, tex: TextureManagerLike, cell: Tiles3Cell): string | null {
  if (cell.kind === "wall") {
    const cap = cell.wall?.stack[cell.wall.stack.length - 1]?.tile;
    if (!cap?.path) return null;
    const k = artKey(cap.path);
    return tex.exists(k) ? k : null;
  }
  const art = cell.art;
  if (!art) return null;
  if (art.kind === "liquid") return t3.liquid(art.topRGB);
  /* `topOnly` too: an occluder copy that drew the unmasked tile would put the
   * wall band back on the water this pass exists to keep clean. */
  /* EVERY plate goes through the factory now: a level-0 plate has its wall band
   * repainted in its own surface colour, and drawing the raw file here would put
   * the dark band back on exactly the edges the cap exists to hide. */
  return t3.plate(art, cell.ground);
}

/** The repeated storey tile's key for a cell's column — the FACE an occluder
 *  stacks below the cap. */
export function faceKey(tex: TextureManagerLike, cell: Tiles3Cell): string | null {
  const p = cell.wall?.mid.path;
  if (!p) return null;
  const k = artKey(p);
  return tex.exists(k) ? k : null;
}
