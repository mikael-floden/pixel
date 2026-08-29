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
 *   is `<ground>@<lexicographic minimum cell>` over a 4-connected component.
 *   Computed over a camera window instead, a meadow gets a different id (and so
 *   a different set, and so different art) every time the window moves — the
 *   ground would visibly reshuffle as you walk. So the flood fill runs ONCE
 *   over the whole doc at load (measured: 27ms on the_game's 512x512) and every
 *   cell reads its id from that.
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
  columnX,
  columnY,
  lcg,
  DY,
  DETAIL_FREQ,
  FADE_BAND,
  INDOOR_GROUNDS,
  PLATE_H,
  TILE,
  TOP_Y,
  type BaseTileSetsDoc,
  type Bounds,
  type Deck3,
  type FadePick,
  type FadesDoc,
  type FieldArt,
  type Frame,
  type GroundType,
  type MemberResolveDoc,
  type PatternsDoc,
  type Regions,
  type ReviewManifest,
  type TileArt,
  type Tiles3Boundary,
  type Tiles3Cell,
  type Tiles3Data,
  type Tiles3DeckCell,
  type WallColumn,
  type WallStackStep,
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

  /** render3's `g()`: null outside the bounds. */
  g(x: number, y: number): string | null {
    const b = this.bounds;
    return x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 ? this.view.groundAt(x, y) : null;
  }

  /** render3's `L()`: NOT bounds-clamped — a cliff at the edge still knows how
   *  far it drops. */
  L(x: number, y: number): number {
    return this.view.levelAt(x, y);
  }

  /** Everything one cell draws. Null for void / out of bounds. */
  cell(x: number, y: number): Tiles3Cell | null {
    const gr = this.g(x, y);
    if (!gr) return null;
    const zl = this.L(x, y);
    const region = this.regions.idAt(x, y);
    const cell: Tiles3Cell = {
      x,
      y,
      ground: gr,
      level: zl,
      region,
      sx: columnX(this.frame, x, y),
      sy: columnY(this.frame, x, y, zl),
      kind: "field",
    };
    const liquid = this.view.isLiquid(gr);
    if (zl === 0 || liquid) {
      let art: FieldArt;
      if (liquid) {
        const t = this.tiles.flatTile(gr);
        art = { kind: "liquid", topRGB: t.topRGB ?? [128, 128, 128], w: t.w, h: t.h };
      } else {
        const p = this.tiles.plateAt(gr, region, x, y);
        cell.set = p.set.id;
        cell.memberIndex = p.memberIndex;
        cell.plate = p.art;
        art = { kind: p.art.kind, path: p.art.path, w: p.art.w, h: p.art.h };
        const fade = this.fadeAt(gr, x, y, zl);
        if (fade) {
          cell.fade = fade;
          art = { kind: "fade", path: fade.file, w: TILE, h: TOP_Y + 2 * DY + 2 };
        }
        if (art.kind === "flat") {
          const d = this.detailAt(gr, x, y);
          if (d) {
            cell.detail = d;
            art = { kind: "flat", path: d.file, w: TILE, h: TILE };
          }
        }
      }
      cell.art = art;
      cell.pasteY = cell.sy - (!liquid && art.h === PLATE_H ? 0 : TOP_Y);
      return cell;
    }
    cell.kind = "wall";
    cell.wall = this.wallColumn(gr, x, y, zl);
    return cell;
  }

  /** THE FADE BAND — the axis scan from ring 2 (ring 1 belongs to the composed
   *  boundary tile). Port of `Tiles3.fadeAt`. */
  private fadeAt(gr: string, x: number, y: number, zl: number): FadePick | null {
    let near: [string, number] | null = null;
    for (let r = 2; r <= FADE_BAND && !near; r++) {
      for (const [dx, dy] of [
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ]) {
        const og = this.g(x + dx, y + dy);
        if (og && og !== gr && !this.view.isLiquid(og) && this.L(x + dx, y + dy) === zl) {
          near = [og, r];
          break;
        }
      }
    }
    if (!near) return null;
    const pool = this.tiles.fadePool(gr, near[0]);
    if (!pool.length) return null;
    const u = lcg((x * 73856093) ^ (y * 19349663))();
    const hi = pool.length - 1;
    const bandPos = (FADE_BAND + 1 - near[1]) / (FADE_BAND + 1);
    const index = Math.max(0, Math.min(hi, Math.trunc((bandPos * 0.55 + u * 0.3 - 0.15) * hi)));
    return { other: near[0], dist: near[1], poolKey: `${gr}|${near[0]}`, index, u, file: pool[index].file };
  }

  private detailAt(ground: string, x: number, y: number): { index: number; file: string } | null {
    const pool = this.tiles.detailPool(ground);
    if (!pool.length) return null;
    if (!(lcg((x * 83492791) ^ (y * 2654435761))() < DETAIL_FREQ)) return null;
    const index = Math.trunc(lcg(x * 31 + y)() * pool.length) % pool.length;
    return { index, file: pool[index] };
  }

  /** THE WALL STACK. Port of `Tiles3.wallColumn`. */
  private wallColumn(gr: string, x: number, y: number, zl: number): WallColumn {
    const frontLow = Math.min(this.L(x + 1, y), this.L(x, y + 1));
    const down = this.L(x + 1, y) <= this.L(x, y + 1) ? [x + 1, y] : [x, y + 1];
    const override = this.view.wallSideAt(x, y);
    let side = override ?? this.g(down[0], down[1]) ?? gr;
    if (!override && (INDOOR_GROUNDS.includes(side) || this.view.isLiquid(side))) side = gr;
    const capped = frontLow < zl;
    const cap = capped ? this.tiles.overTile(gr, side) : this.tiles.flatTile(gr);
    const midGround = override ? side : gr;
    const mid = this.tiles.storeyTile(midGround);
    const stack: WallStackStep[] = [];
    for (let f = Math.max(0, frontLow); f <= zl; f++)
      stack.push({ storey: f, tile: f === zl ? cap : mid, y: columnY(this.frame, x, y, f) - TOP_Y });
    return { side, frontLow, fx: down[0], fy: down[1], over: override !== null, capped, cap, mid, midGround, stack };
  }

  /** THE CORNER LATTICE. Port of `Tiles3.boundaries`, for the ONE corner whose
   *  north-west cell is (x,y). Null when the quad is not a two-ground,
   *  one-level quad — which is most of the map. */
  boundary(x: number, y: number): Tiles3Boundary | null {
    const b = this.bounds;
    // The sweep's own ranges: a corner needs (x+1, y+1) inside the bounds.
    if (x < b.x0 || y < b.y0 || x >= b.x1 - 1 || y >= b.y1 - 1) return null;
    const quad: [number, number][] = [
      [x, y],
      [x + 1, y],
      [x, y + 1],
      [x + 1, y + 1],
    ];
    const gs = quad.map((q) => this.g(q[0], q[1]));
    if (gs.some((v) => v === null)) return null;
    const uniq = [...new Set(gs as string[])];
    if (uniq.length !== 2) return null;
    if (new Set(quad.map((q) => this.L(q[0], q[1]))).size !== 1) return null;
    const sorted = uniq.slice().sort();
    const [sa, sb] = this.tiles.sideRoles(sorted[0], sorted[1]);
    const index =
      8 * (gs[0] === sb ? 1 : 0) +
      4 * (gs[1] === sb ? 1 : 0) +
      2 * (gs[2] === sb ? 1 : 0) +
      1 * (gs[3] === sb ? 1 : 0);
    if (index === 0 || index === 15) return null;
    const region = this.regions.idAt(x, y);
    const pa = this.tiles.plateAt(sa, region, x, y);
    const pb = this.tiles.plateAt(sb, region, x, y);
    return {
      x,
      y,
      index,
      a: sa,
      b: sb,
      maskFrame: this.tiles.maskFrame(index),
      pattern: this.patterns.selection?.default_pattern ?? null,
      plateA: pa.art,
      plateB: pb.art,
      setA: pa.set.id,
      memberA: pa.memberIndex,
      setB: pb.set.id,
      memberB: pb.memberIndex,
      sx: columnX(this.frame, x, y),
      sy: columnY(this.frame, x, y, this.L(x, y)),
      w: TILE,
      h: PLATE_H,
    };
  }

  /** The deck cells standing on one world cell, resolved. Port of
   *  `Tiles3.deckCells` for a single (x,y) — a world cell can carry more than
   *  one deck, and the order is the document's. */
  decks(x: number, y: number): Tiles3DeckCell[] {
    const dis = this.deckAt.get(y * this.view.width + x);
    if (!dis) return [];
    const b = this.bounds;
    if (x < b.x0 || x >= b.x1 || y < b.y0 || y >= b.y1) return [];
    const out: Tiles3DeckCell[] = [];
    for (const di of dis) {
      const dk = this.view.decks[di];
      const dg = dk.ground || "grey_stone";
      const dl = Math.trunc(dk.level);
      const th = Math.trunc(dk.thickness ?? 1);
      const set = new Set(dk.cells.map((c) => c.y * this.view.width + c.x));
      const frontCovered = set.has(y * this.view.width + x + 1) && set.has((y + 1) * this.view.width + x);
      const lo = frontCovered ? dl : Math.max(0, dl - Math.max(1, th));
      const body = dk.kind === "cave" && dg !== "black_rock" && dg !== "grey_stone" ? "grey_stone" : dg;
      const cap = frontCovered ? this.tiles.flatTile(dg) : this.tiles.overTile(dg, body);
      const mid = this.tiles.storeyTile(body);
      const stack: WallStackStep[] = [];
      for (let f = lo; f <= dl; f++)
        stack.push({ storey: f, tile: f === dl ? cap : mid, y: columnY(this.frame, x, y, f) - TOP_Y });
      out.push({
        deck: di,
        kind: dk.kind ?? null,
        ground: dg,
        level: dl,
        thickness: th,
        x,
        y,
        frontCovered,
        lo,
        body,
        cap,
        mid,
        sx: columnX(this.frame, x, y),
        stack,
      });
    }
    return out;
  }
}

/* -- the host: loading art on demand ---------------------------------------- */

/** Structurally satisfied by `Phaser.Loader.LoaderPlugin`. */
export interface LoaderLike {
  image(key: string, url: string): unknown;
  isLoading(): boolean;
  start(): void;
  once(event: string, cb: () => void): unknown;
}

/** THE STREAMING ART CACHE. A draw pass asks for the files a window needs; this
 *  queues the ones that are not resident, starts the loader at most once per
 *  pass, and calls `onBatch` when a batch lands so the caller can repaint.
 *
 *  A PATH IS REQUESTED ONCE, EVER. A 404 (a stale index, an unpublished tile)
 *  would otherwise re-fire on every redraw the cell is on screen — the requested
 *  set is the tombstone, exactly as `SceneryPieces` does for manifests. */
export class Tiles3Loader {
  readonly stats = { requested: 0, batches: 0, pending: 0 };
  private asked = new Set<string>();
  private queued: string[] = [];

  constructor(
    private o: {
      loader: LoaderLike;
      textures: TextureManagerLike;
      route?: UrlRoute;
      onBatch: () => void;
    },
  ) {}

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

  /** Start the queued batch, if any. Safe to call every pass. */
  flush(): void {
    if (!this.queued.length) return;
    const batch = this.queued;
    this.queued = [];
    this.stats.requested += batch.length;
    this.stats.pending += batch.length;
    for (const path of batch) this.o.loader.image(artKey(path), routeUrl(path, this.o.route));
    this.o.loader.once("complete", () => {
      this.stats.batches++;
      this.stats.pending = Math.max(0, this.stats.pending - batch.length);
      this.o.onBatch();
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
  baseTileSets: "live/tuning/base_tile_sets.json",
  basePromotions: "live/tuning/base_tiles.json",
  tileWalls: "live/tuning/tile_walls.json",
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
  if (art.kind === "conform") return t3.plate(art, cell.ground);
  const k = plateKey(art, cell.ground);
  return tex.exists(k) ? k : null;
}

/** The repeated storey tile's key for a cell's column — the FACE an occluder
 *  stacks below the cap. */
export function faceKey(tex: TextureManagerLike, cell: Tiles3Cell): string | null {
  const p = cell.wall?.mid.path;
  if (!p) return null;
  const k = artKey(p);
  return tex.exists(k) ? k : null;
}
