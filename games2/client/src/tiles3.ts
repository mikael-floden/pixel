/* TILES 3.0 RESOLVER — "which art draws on this cell", as a pure function.
 *
 * A `pixel-maps3/world@1` document stores SEMANTICS ONLY: a ground type per
 * cell, a level per cell, decks, walls, scenery. No tile ids, no art paths. The
 * art is resolved at DRAW time, and this module is that resolution — the ground
 * runtime, the occluder pass, the atlas builder and every future consumer call
 * it, so it is pure, synchronous, dependency-free and provable: no Phaser, no
 * DOM, no fs, no fetch. Every document it reads is handed in.
 *
 * THE SPEC IS `maps2/pipeline/render3.py`, because it is what draws the map.
 * Where a doc and render3 disagree, render3 wins and the disagreement is called
 * out at the line it affects. The pick itself is the wiki's shared reference
 * (`wiki/lib/basesets.mjs`) ported to the bit and proven against its own
 * TEST_VECTORS in server/test/tiles3.test.ts; the whole module is proven cell
 * for cell against server/test/fixtures/tiles3-parity.json, which was generated
 * out of render3 itself.
 *
 * WHAT STAYS OUTSIDE. Three of render3's decisions need PIXELS, and a pure
 * module has none: the storey pitch (measured off the wall art — pass
 * `storeyPitch`, and `measureStoreyPitch` below is the rule to measure it
 * with), the fade set's alien-palette guard (pass `fadeGuard`), and conforming
 * a 64x64 base-candidate into 64x46 plate geometry (a `conform` art is reported
 * as such; the loader conforms it). Nothing here silently substitutes for one.
 */

/* -- geometry (render3 / tiles/docs/GEOMETRY.md) ---------------------------- */

/** Half tile width / the v3 lattice pitch. DY is 14: at 15 the lattice does not
 *  close and each boundary leaks a 1px wall band. */
export const DX = 32;
export const DY = 14;
/** The wall band of one storey IN THE ART. It is NOT the stacking pitch — see
 *  `measureStoreyPitch` — but it IS what the render3 canvas origin uses. */
export const WALL = 17;
export const TILE = 64;
/** Row of the 64-box where a review tile's top diamond starts. */
export const TOP_Y = 10;
/** A plate is the top face plus its wall: 64x46, byte-exact silhouette alpha. */
export const PLATE_H = 46;
/** Cells of fade band each side of a hard edge. Ring 1 belongs to the composed
 *  boundary tile, so only ring 2 ever matches at FADE_BAND 2. */
export const FADE_BAND = 2;
/** A detail roughly once per 48 field cells. */
export const DETAIL_FREQ = 1 / 48;
/** Set 0 is reserved, named Clean, and holds nothing but the clean member. It is
 *  never deleted — it is switched off by weight, so a ground can always draw. */
export const CLEAN_SET_ID = 0;

/** A wall's side is the ground at its FOOT — but an indoor floor is never a
 *  wall's body: a stone wall whose foot stands on parquet is still stone.
 *  render3 hardcodes this set; it is not read from ground_types. */
export const INDOOR_GROUNDS: readonly string[] = [
  "parquet_floor",
  "brown_paving_stone",
  "grey_paving_stone",
];

/** The grounds `flat_tile` paints as a bare colour diamond with NO wall. This is
 *  render3's own tuple and is deliberately NOT the world doc's `liquids` list:
 *  the doc's list decides which cells skip the plate, this one decides what a
 *  flat tile of that ground looks like. A world may mark fewer. */
export const LIQUID_TILE_GROUNDS: readonly string[] = ["water", "deep_water", "lava", "slime"];

/* -- the hash and the weighted pick (port of wiki/lib/basesets.mjs) ---------- */

/** FNV-1a/32 THEN MurmurHash3's fmix32. Both halves are required: FNV-1a alone
 *  does not avalanche at the tail, and our keys end in the coordinate that
 *  varies ("…|<x>|<y>"), so consecutive rows landed in the same bucket — 89.2%
 *  of cells matched the one below against a 14.3% chance, which is the vertical
 *  striping the maintainer reported. Proven against basesets.mjs TEST_VECTORS. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** A hash in [0,1). 2^32 as the divisor, so the value can reach 0 but never 1
 *  and the last bucket cannot be skipped by rounding. */
export function unitHash(str: string): number {
  return fnv1a(str) / 4294967296;
}

/** Weighted pick over non-negative weights, given u in [0,1). Weights are RAW
 *  and normalised here, so adding a tile does not rescale the others and 0 keeps
 *  meaning never. Returns -1 when nothing can be picked; the caller decides the
 *  fallback. */
export function pickWeighted(weights: readonly number[], u: number): number {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (!(total > 0)) return -1;
  let acc = 0;
  const target = u * total;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i] > 0 ? weights[i] : 0;
    if (target < acc) return i;
  }
  /* Only reachable on floating-point crumbs at the top of the range. Fall to the
   * last POSITIVE weight, not the last index — the last index may be a
   * zero-weight member, and "never" has to mean never even here. */
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}

/** render3's `_rng`: a 32-bit LCG (Numerical Recipes constants). The fade and
 *  detail seeds exceed 32 bits before the mask — `(x*73856093) ^ (y*19349663)`
 *  is up to 2^45 — but every product stays under 2^53, so JS's ToInt32 on `^`
 *  takes the same low 32 bits Python's `& 0xffffffff` does. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/* -- the measured storey pitch ---------------------------------------------- */

/** THE STACKING PITCH, measured off the x-over-x wall art — the port of
 *  `tiles/pipeline/render.py wall_height` over `clean_top.top_mask`. Do not
 *  hardcode it: the doc says 17, the art measures 15, and a pitch one row too
 *  large exposes ~114px of each lower floor's top per tile, which is the bright
 *  stripe across every cliff at every storey. Returns 0 when the tile has no
 *  opaque pixels; render3 falls back to 16 on 0.
 *
 *  `opaque(x,y)` is alpha > 128 — the same threshold palette_snap uses, one
 *  step stricter than imagelib's > 64. */
export function measureStoreyPitch(
  w: number,
  h: number,
  opaque: (x: number, y: number) => boolean,
): number {
  let x0 = -1;
  let x1 = -1;
  const colTop: number[] = new Array(w).fill(-1);
  const colBot: number[] = new Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (!opaque(x, y)) continue;
      if (colTop[x] < 0) colTop[x] = y;
      colBot[x] = y;
    }
    if (colTop[x] >= 0) {
      if (x0 < 0) x0 = x;
      x1 = x;
    }
  }
  if (x0 < 0) return 0;
  /* The top face is stepped out from the two SIDE CORNERS at the grid's own
   * pitch, 14 rows per 32 columns — not fitted as a diamond. A 2:1 staircase
   * falls 16 rows per 32 and breaks by 2px at every seam. */
  const ly = colTop[x0];
  const ry = colTop[x1];
  let pitch = Infinity;
  const topBot: number[] = new Array(w).fill(-1);
  for (let x = x0; x <= x1; x++) {
    const dl = roundHalfEven((DY * (x - x0)) / DX);
    const dr = roundHalfEven((DY * (x1 - x)) / DX);
    const ty = Math.max(ly - dl, ry - dr);
    const by = Math.min(ly + 1 + dl, ry + 1 + dr); // CORNER_DROP 1 => a 2px corner
    if (by < ty) continue;
    for (let y = Math.min(by, h - 1); y >= ty; y--) {
      if (y >= 0 && opaque(x, y)) {
        topBot[x] = y;
        break;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    if (topBot[x] < 0 || colBot[x] < 0) continue;
    /* MINIMUM across columns: the wall is a row shorter at the tile's left and
     * right corners than in the middle, and a pitch that fits the tallest column
     * still leaks at the shortest. */
    pitch = Math.min(pitch, colBot[x] - topBot[x]);
  }
  return pitch === Infinity ? 0 : pitch;
}

/** Python's round(): HALF TO EVEN. `round(14*24/32)` is 10.5 -> 10, where
 *  Math.round gives 11 — a one-column error in the top mask at 24 columns from
 *  a corner. */
function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/* -- regions ---------------------------------------------------------------- */

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Regions {
  /** render3's `region_of`: "r0" for a cell with no region (void, or outside). */
  idAt(x: number, y: number): string;
  /** Every region id in the window, in flood-fill discovery order. */
  ids: string[];
}

/** THE REGION RULE: 4-connected same-ground components, id
 *  `<ground>@<minx>,<miny>` where the minimum is the LEXICOGRAPHIC minimum over
 *  the component's (x,y) TUPLES — the smallest x, and among those the smallest
 *  y. It is NOT (min x, min y) computed separately: those coincide on a
 *  rectangle and diverge on every real coastline, and picking the wrong one
 *  re-keys the set hash and repaints the whole world.
 *
 *  REGIONS ARE WINDOW-LOCAL. `groundAt` is read only inside the window, exactly
 *  as render3's `g()` returns None outside it, so a component that leaves the
 *  window is cut at the edge and a port that passes a different window gets
 *  different ids. */
export function computeRegions(
  b: Bounds,
  groundAt: (x: number, y: number) => string | null,
): Regions {
  const w = Math.max(0, b.x1 - b.x0);
  const h = Math.max(0, b.y1 - b.y0);
  const ids: string[] = [];
  const owner = new Int32Array(w * h).fill(-1);
  const ground: (string | null)[] = new Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) ground[y * w + x] = groundAt(b.x0 + x, b.y0 + y);
  const queue = new Int32Array(w * h);
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const start = sy * w + sx;
      if (owner[start] >= 0) continue;
      const g = ground[start];
      if (!g) continue;
      const id = ids.length;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      owner[start] = id;
      let minX = sx;
      let minY = sy;
      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx < minX || (cx === minX && cy < minY)) {
          minX = cx;
          minY = cy;
        }
        const nbs = [cx + 1 < w ? cur + 1 : -1, cx > 0 ? cur - 1 : -1, cy + 1 < h ? cur + w : -1, cy > 0 ? cur - w : -1];
        for (const nb of nbs) {
          if (nb < 0 || owner[nb] >= 0 || ground[nb] !== g) continue;
          owner[nb] = id;
          queue[tail++] = nb;
        }
      }
      ids.push(`${g}@${b.x0 + minX},${b.y0 + minY}`);
    }
  }
  return {
    ids,
    idAt(x: number, y: number): string {
      if (x < b.x0 || x >= b.x1 || y < b.y0 || y >= b.y1) return "r0";
      const o = owner[(y - b.y0) * w + (x - b.x0)];
      return o < 0 ? "r0" : ids[o];
    },
  };
}

/* -- base tile sets --------------------------------------------------------- */

export interface RawMember {
  kind?: string;
  id?: string;
  tile?: string;
  weight?: number;
}
export interface RawSet {
  id?: number;
  name?: string;
  weight?: number;
  members?: RawMember[];
}
/** live/tuning/base_tile_sets.json — `pixel-wiki-base-tile-sets@1`. LIVE: the
 *  maintainer edits it from the wiki and the game follows without a redeploy, so
 *  it is read at runtime and never baked into a build (`setBaseTileSets`). */
export interface BaseTileSetsDoc {
  grounds?: Record<string, { sets?: RawSet[] } | undefined>;
}

export type BaseMember =
  | { kind: "clean"; weight: number }
  | { kind: "tile"; id: string | null; tile: string; weight: number };

export interface BaseSet {
  id: number;
  name: string;
  weight: number;
  members: BaseMember[];
}

/** The sets of one ground, always with Clean present and always sorted by id, so
 *  every reader sees the same order whatever the file happens to hold. A ground
 *  with no entry at all still gets Clean — the model has no "no sets" state. */
export function setsFor(doc: BaseTileSetsDoc | null | undefined, ground: string): BaseSet[] {
  const raw = doc?.grounds?.[ground]?.sets;
  const list: RawSet[] = Array.isArray(raw) ? raw.slice() : [];
  if (!list.some((s) => s && s.id === CLEAN_SET_ID)) {
    list.push({
      id: CLEAN_SET_ID,
      name: "Clean",
      weight: 1,
      members: [{ kind: "clean", weight: 1 }],
    });
  }
  return list
    .filter((s) => s && Number.isInteger(s.id) && (s.id as number) >= 0)
    .sort((a, b) => (a.id as number) - (b.id as number))
    .map((s) => ({
      id: s.id as number,
      name: typeof s.name === "string" && s.name ? s.name : s.id === CLEAN_SET_ID ? "Clean" : "Set",
      weight: Math.max(0, Number(s.weight) || 0),
      members: normaliseMembers(s.id as number, s.members),
    }));
}

/** Clean is a MEMBER, not a flag beside the members — it carries the same kind
 *  of weight a tile does, so "always textured" is 0 and "always clean" is the
 *  only positive weight. Every set carries exactly one, at index 0; set 0
 *  carries nothing else. */
function normaliseMembers(setId: number, members: RawMember[] | undefined): BaseMember[] {
  const src = Array.isArray(members) ? members : [];
  const tiles: BaseMember[] =
    setId === CLEAN_SET_ID
      ? []
      : src
          .filter((m) => m && m.kind === "tile" && typeof m.tile === "string" && m.tile)
          .map((m) => ({
            kind: "tile" as const,
            id: typeof m.id === "string" ? m.id : null,
            tile: m.tile as string,
            weight: Math.max(0, Number(m.weight) || 0),
          }));
  const clean = src.find((m) => m && m.kind === "clean");
  const cleanWeight = clean ? Math.max(0, Number(clean.weight) || 0) : tiles.length ? 0 : 1;
  return [{ kind: "clean", weight: cleanWeight }, ...tiles];
}

/** WHICH SET PAINTS THIS REGION — one set for a whole area, which is what keeps
 *  the area coherent. Picking per cell would shuffle three different grasses
 *  into one meadow and undo the point of grouping them. Every weight 0 falls
 *  back to Clean rather than to nothing. */
export function pickSet(sets: BaseSet[], ground: string, region: string): BaseSet {
  const i = pickWeighted(
    sets.map((s) => s.weight),
    unitHash(`bts1|set|${ground}|${region}`),
  );
  if (i >= 0) return sets[i];
  const clean = sets.find((s) => s.id === CLEAN_SET_ID);
  return clean ?? sets[0];
}

/** WHICH MEMBER FILLS THIS CELL — per cell, which is what makes the field vary.
 *  Keyed by the SET ID and not by its position, so deleting another set does not
 *  repaint a field nobody touched. -1 is the sentinel for "no member has
 *  weight"; the caller draws clean. */
export function pickMemberIndex(set: BaseSet | null | undefined, x: number, y: number): number {
  if (!set || !set.members.length) return -1;
  return pickWeighted(
    set.members.map((m) => m.weight),
    unitHash(`bts1|tile|${set.id}|${x}|${y}`),
  );
}

/* -- member -> art (tiles/resolve.json) ------------------------------------- */

/** tiles/resolve.json — `tiles3/member-resolve@1`, published BECAUSE
 *  re-implementing the string rule made 104 of 340 members silently draw flat
 *  clean.webp in render3 while the wiki drew them correctly. Read the data. */
export interface MemberResolveDoc {
  members?: Record<string, { kind?: string; art?: string }>;
}

export interface PlateArt {
  /** `plate` — a published 64x46 plate, load it as is. `conform` — 64x64 review
   *  or base-candidate art with NO published plate: the loader must run the
   *  tiles agent's conformer (top face through `plate()`, wall filled from the
   *  ground's palette, alpha set to the silhouette) before drawing it. Using it
   *  verbatim puts 928 of 2012px in the wrong alpha. `clean` — the ground's flat
   *  colour plate. */
  kind: "plate" | "conform" | "clean";
  /** Repo-relative file to load. */
  path: string;
  /** The base_tile_sets member string behind it, null for clean. */
  member: string | null;
  /** True when resolve.json did not list the member and the documented `forms`
   *  rule had to be applied instead — the index is STALE, not the member
   *  invalid. Counted and warned, never silently degraded. */
  stale: boolean;
  w: number;
  h: number;
}

/* -- the review matrix, the flats, the fades -------------------------------- */

export interface ReviewCandidate {
  key: string;
  file: string;
  before?: string;
}
export interface ReviewCell {
  top: string;
  side: string;
  candidates: ReviewCandidate[];
}
/** tiles/review/manifest.json — the x-over-y matrix. */
export interface ReviewManifest {
  cells?: Record<string, ReviewCell>;
}

export interface GroundType {
  base_color?: string;
  palette?: { top?: string; wall?: string };
  base_tiles?: string[];
}

export interface FadeTile {
  file: string;
  edge_ground?: string;
  pct?: Record<string, number>;
}
/** tiles/fades/index.json — `tiles3/fade-tiles@1`. */
export interface FadesDoc {
  pairs?: Record<string, FadeTile[]>;
}

/** tiles/patterns/index.json — the Wang mask sheet a boundary blend samples,
 *  and the canonical `side_order` that decides which ground is side_b. */
export interface PatternsDoc {
  selection?: { side_order?: string[]; default_pattern?: string };
  patterns?: { id: string; row: number }[];
  masks?: { file?: string; frame_w?: number; frame_h?: number; cols?: number };
}

export interface TileArt {
  role: "over" | "storey" | "flat";
  ground?: string;
  top?: string;
  side?: string;
  /** The review key. Absent on a flat tile taken from ground_types base_tiles or
   *  from a live promotion, which name a path and not a key. */
  key?: string;
  /** Repo-relative file, absent on a painted liquid diamond. */
  path?: string;
  painted?: "liquid_diamond";
  topRGB?: [number, number, number];
  w: number;
  h: number;
}

/* -- the data this resolver reads ------------------------------------------- */

export interface Tiles3Data {
  /** live/tuning/base_tile_sets.json. LIVE — see `setBaseTileSets`. */
  baseTileSets: BaseTileSetsDoc;
  /** tiles/resolve.json. */
  memberResolve: MemberResolveDoc;
  /** tiles/ground_types.json `.grounds`. */
  groundTypes: Record<string, GroundType>;
  /** tiles/patterns/index.json — `side_order` (which ground is side_b) and the
   *  mask sheet a boundary samples. Passed whole: the pattern row and the sheet
   *  geometry are the same file's data, and a boundary needs all of it. */
  patterns: PatternsDoc;
  /** MEASURED off the x-over-x wall art with `measureStoreyPitch`. Not 16, not
   *  WALL. */
  storeyPitch: number;
  /** tiles/review/manifest.json — needed for walls, flats and details. */
  review?: ReviewManifest;
  /** live/feedback/tiles.json `.entries` — the maintainer's approvals. */
  feedback?: Record<string, { status?: string }>;
  /** live/tuning/tile_walls.json `.overrides` — `top_only` keeps a top that
   *  repeats badly out of a storey fill. */
  wallOverrides?: Record<string, { top_only?: boolean }>;
  /** live/tuning/base_tiles.json `.overrides` — the maintainer's promoted base
   *  tiles, keyed by review key. */
  basePromotions?: Record<string, { type?: string }>;
  /** tiles/base_candidates/<ground>/index.json, by ground — only consulted when
   *  a promoted key is not in the review manifest. */
  baseCandidates?: Record<string, { candidates?: { id?: string; file: string }[] }>;
  /** tiles/fades/index.json. */
  fades?: FadesDoc;
  /** The fade set's ALIEN-PALETTE GUARD, which is a pixel test render3 runs over
   *  the tile's own top diamond (80th percentile of the per-pixel distance to
   *  the nearer of the two palette tops, rejected above 78). A pure module
   *  cannot run it; pass it, or the pool keeps tiles render3 drops — measured on
   *  the parity fixture, 2 of 10 pools differ without it. */
  fadeGuard?: (file: string, field: string, other: string) => boolean;
  /** Where a stale index or an unresolvable member is reported. Defaults to
   *  console.warn; the counters in `stats` are always kept. */
  warn?: (message: string) => void;
}

export interface Tiles3Stats {
  /** Members resolve.json did not list — the file is stale. */
  staleMembers: number;
  /** Members that resolved to nothing at all and drew clean. In render3 this is
   *  FATAL, because a silent fall-through to clean.webp is a real file that
   *  passes every existence check and only looks "flatter than it should". */
  unresolvedMembers: number;
  /** Fade pools built without `fadeGuard`. */
  unguardedFadePools: number;
}

/* -- the world the resolver reads ------------------------------------------- */

export interface Deck3 {
  kind?: string;
  ground?: string;
  level: number;
  thickness?: number;
  cells: { x: number; y: number }[];
}

export interface World3View extends Bounds {
  /** World size and the doc-wide maximum level — the canvas origin uses the
   *  WHOLE doc's maximum, not the window's. */
  width: number;
  height: number;
  maxLevel: number;
  /** The ground name at a world cell, or null for void / off-world. Read only
   *  inside the window by the resolver, matching render3's `g()`. */
  groundAt(x: number, y: number): string | null;
  /** The level at a world cell; 0 off-world. NOT window-clamped — render3's
   *  `L()` reads the whole doc, which is how a cliff at the window edge still
   *  knows how far it drops. */
  levelAt(x: number, y: number): number;
  isLiquid(ground: string): boolean;
  /** The `walls[]` group override: the ground this cell's face is drawn OVER. */
  wallSideAt(x: number, y: number): string | null;
  decks: Deck3[];
}

/** A `World3View` over a raw `pixel-maps3/world@1` document. */
export function viewFromDoc(doc: any, bounds?: Partial<Bounds>): World3View {
  const width: number = doc.size.w;
  const height: number = doc.size.h;
  const names: string[] = doc.grounds;
  const grid: number[][] = doc.ground;
  const level: number[][] = doc.level;
  const liquids = new Set<string>(doc.liquids ?? []);
  const wallOver = new Map<number, string>();
  for (const w of doc.walls ?? [])
    for (const c of w.cells) {
      // BOUNDS-CHECK BEFORE FLATTENING. The key is y*width+x, so an out-of-range
      // cell does not fail — it ALIASES onto a real one (x=-1,y=5 and x=511,y=4
      // both give 2559 at width 512) and silently repaints that cell's wall
      // body. render3.py is immune by construction (a Python dict keyed on the
      // raw tuple); we are not, so the guard is the port's job. Same rule and
      // same reason as parseWorld3's wallSides table in shared/src/world3.ts.
      // LATER WINS on a legitimately double-claimed cell — 71 of the_game's
      // cells are claimed by groups that disagree, and array order decides,
      // matching render3's overwrite-on-assignment.
      if (!Number.isInteger(c.x) || !Number.isInteger(c.y)) continue;
      if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) continue;
      wallOver.set(c.y * width + c.x, w.side);
    }
  let maxLevel = 0;
  for (const row of level) for (const v of row) if (v > maxLevel) maxLevel = v;
  return {
    x0: bounds?.x0 ?? 0,
    y0: bounds?.y0 ?? 0,
    x1: bounds?.x1 ?? width,
    y1: bounds?.y1 ?? height,
    width,
    height,
    maxLevel,
    groundAt(x, y) {
      if (x < 0 || x >= width || y < 0 || y >= height) return null;
      const i = grid[y][x];
      return i >= 0 ? names[i] : null;
    },
    levelAt(x, y) {
      return x >= 0 && x < width && y >= 0 && y < height ? level[y][x] : 0;
    },
    isLiquid: (g) => liquids.has(g),
    wallSideAt: (x, y) => wallOver.get(y * width + x) ?? null,
    decks: doc.decks ?? [],
  };
}

/* -- the iso frame ---------------------------------------------------------- */

export interface Frame extends Bounds {
  ox: number;
  oy: number;
  /** The MEASURED stacking pitch. */
  pitch: number;
  canvas: [number, number];
}

/** render3's canvas origin. `oy` uses WALL (17) and the WHOLE doc's maximum
 *  level, not the measured pitch and not the window's maximum: it is headroom
 *  above the tallest column, not a stacking step. */
export function isoFrame(b: Bounds, worldMaxLevel: number, pitch: number): Frame {
  return {
    ...b,
    ox: (b.y1 - 1 - b.y0) * DX + 8,
    oy: worldMaxLevel * WALL + 24,
    pitch,
    canvas: [
      (b.x1 - b.x0 + (b.y1 - b.y0)) * DX + 16,
      (b.x1 - b.x0 + (b.y1 - b.y0)) * DY + worldMaxLevel * WALL + 120,
    ],
  };
}

/** Screen x of a cell's column (its 64-box left edge). */
export function columnX(f: Frame, x: number, y: number): number {
  return f.ox + (x - f.x0 - (y - f.y0)) * DX - DX;
}

/** Screen y of one storey of a cell's column, at the MEASURED pitch. */
export function columnY(f: Frame, x: number, y: number, storey: number): number {
  return f.oy + (x - f.x0 + (y - f.y0)) * DY - storey * f.pitch;
}

/* -- what a cell draws ------------------------------------------------------ */

export type FieldArt =
  | { kind: "plate" | "conform" | "clean" | "fade" | "flat"; path: string; w: number; h: number }
  | { kind: "liquid"; topRGB: [number, number, number]; w: number; h: number };

export interface FadePick {
  other: string;
  /** Ring distance at which the other ground was found. */
  dist: number;
  /** `<field ground>|<other ground>`. */
  poolKey: string;
  index: number;
  /** The LCG's first draw — the jitter. */
  u: number;
  file: string;
}

export interface WallStackStep {
  storey: number;
  tile: TileArt;
  /** Paste y of the whole 64-box. */
  y: number;
}

export interface WallColumn {
  /** The ground the face is drawn OVER. */
  side: string;
  frontLow: number;
  fx: number;
  fy: number;
  /** The cell is in a `walls[]` group, so `side` is the maintainer's, not the
   *  neighbour's. */
  over: boolean;
  /** A face is exposed: the down-screen neighbour is lower. */
  capped: boolean;
  cap: TileArt;
  mid: TileArt;
  midGround: string;
  stack: WallStackStep[];
}

export interface Tiles3Cell {
  x: number;
  y: number;
  ground: string;
  level: number;
  region: string;
  /** Column origin: `sx` is the 64-box left edge, `sy` the box top at the cell's
   *  own level (before the tile's own TOP_Y offset). */
  sx: number;
  sy: number;
  kind: "field" | "wall";
  /** Field cells only, and only when the ground is not a liquid. */
  set?: number;
  memberIndex?: number;
  plate?: PlateArt;
  fade?: FadePick;
  detail?: { index: number; file: string };
  /** What is actually drawn on a field cell, and where. */
  art?: FieldArt;
  pasteY?: number;
  wall?: WallColumn;
}

export interface Tiles3Boundary {
  x: number;
  y: number;
  /** The Wang index, 8*NW + 4*NE + 2*SW + 1*SE with bit set = side_b. */
  index: number;
  a: string;
  b: string;
  /** The mask sheet frame to blend through: `pattern.row * cols + index`. The
   *  blend itself is three draws — `rgb = mask ? plateB : plateA`, `alpha =
   *  the silhouette` — and belongs to whoever owns pixels. */
  maskFrame: number | null;
  pattern: string | null;
  plateA: PlateArt;
  plateB: PlateArt;
  setA: number;
  memberA: number;
  setB: number;
  memberB: number;
  sx: number;
  sy: number;
  w: number;
  h: number;
}

export interface Tiles3DeckCell {
  deck: number;
  kind: string | null;
  ground: string;
  level: number;
  thickness: number;
  x: number;
  y: number;
  frontCovered: boolean;
  lo: number;
  body: string;
  cap: TileArt;
  mid: TileArt;
  sx: number;
  stack: WallStackStep[];
}

export interface Tiles3Window {
  frame: Frame;
  regions: Regions;
  /** Painter order: back to front in (x+y), then x — render3's own sweep. */
  cells: Tiles3Cell[];
  boundaries: Tiles3Boundary[];
  decks: Tiles3DeckCell[];
}

/* -- the resolver ----------------------------------------------------------- */

export class Tiles3 {
  readonly stats: Tiles3Stats = { staleMembers: 0, unresolvedMembers: 0, unguardedFadePools: 0 };

  private data: Tiles3Data;
  private setCache = new Map<string, BaseSet[]>();
  private setPick = new Map<string, BaseSet>();
  private plateCache = new Map<string, PlateArt>();
  private candCache = new Map<string, ReviewCandidate[]>();
  private tileCache = new Map<string, TileArt>();
  private detailCache = new Map<string, string[]>();
  private fadeCache = new Map<string, FadeTile[]>();
  private warned = new Set<string>();

  constructor(data: Tiles3Data) {
    this.data = data;
  }

  /** Swap in a freshly pushed live/tuning/base_tile_sets.json. The maintainer
   *  edits the ground's look from the wiki and expects the world to follow
   *  without a redeploy, so nothing derived from it may outlive it. */
  setBaseTileSets(doc: BaseTileSetsDoc): void {
    this.data = { ...this.data, baseTileSets: doc };
    this.setCache.clear();
    this.setPick.clear();
    this.plateCache.clear();
  }

  private warn(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    const w = this.data.warn ?? ((m: string) => console.warn(m));
    w(message);
  }

  /* -- the pick ------------------------------------------------------------ */

  setsFor(ground: string): BaseSet[] {
    let s = this.setCache.get(ground);
    if (!s) {
      s = setsFor(this.data.baseTileSets, ground);
      this.setCache.set(ground, s);
    }
    return s;
  }

  setForRegion(ground: string, region: string): BaseSet {
    const k = `${ground}|${region}`;
    let s = this.setPick.get(k);
    if (!s) {
      s = pickSet(this.setsFor(ground), ground, region);
      this.setPick.set(k, s);
    }
    return s;
  }

  /* -- member -> art ------------------------------------------------------- */

  /** The clean plate: the ground's flat palette colour in plate geometry. */
  cleanPlate(ground: string): PlateArt {
    return {
      kind: "clean",
      path: `tiles/plates/${ground}/clean.webp`,
      member: null,
      stale: false,
      w: TILE,
      h: PLATE_H,
    };
  }

  /** A base_tile_sets member string -> the art that draws it, FROM THE DATA.
   *
   *  Missing from `members` means resolve.json is STALE, not that the member is
   *  invalid: fall back to the documented `forms` rule, count it and say so.
   *
   *  DISAGREEMENT, recorded 2026-08-29: render3 additionally prefers a PUBLISHED
   *  plate whose 8-hex filename matches a hash token in a `file` member's
   *  basename, and only conforms when there is none. That branch needs a
   *  directory listing, which a pure module has not got — so the index decides,
   *  and the index is right today: over all 340 member references the two rules
   *  agree on every one. If the tiles agent ever publishes such a plate,
   *  resolve.json has to publish it too. */
  memberArt(ground: string, member: string): PlateArt {
    const key = `${ground}|${member}`;
    const hit = this.plateCache.get(key);
    if (hit) return hit;
    const entry = this.data.memberResolve?.members?.[member];
    let art: PlateArt;
    if (entry && typeof entry.art === "string" && entry.art) {
      art = {
        kind: entry.kind === "plate" ? "plate" : "conform",
        path: entry.art,
        member,
        stale: false,
        w: TILE,
        h: PLATE_H,
      };
    } else {
      this.stats.staleMembers++;
      this.warn(
        `stale:${member}`,
        `tiles3: "${member}" is not in tiles/resolve.json — the index is STALE. ` +
          `Falling back to the documented forms rule; regenerate resolve.json.`,
      );
      const forms = this.memberArtFromForms(ground, member);
      if (forms) {
        art = forms;
      } else {
        this.stats.unresolvedMembers++;
        this.warn(
          `unresolved:${member}`,
          `tiles3: "${member}" resolves to no art at all and will draw CLEAN. ` +
            `base_tile_sets references something that is not published.`,
        );
        art = this.cleanPlate(ground);
      }
    }
    this.plateCache.set(key, art);
    return art;
  }

  /** resolve.json's own `forms`, for when the index is stale. The plate form's
   *  directory is THE CELL'S GROUND (render3), which the doc words as "group 1
   *  before '__over__'" — identical for every member published today, since no
   *  member is listed under a ground other than its own. */
  private memberArtFromForms(ground: string, member: string): PlateArt | null {
    const plate = /^tiles\/([^/]+)\/([0-9a-f]{8})$/.exec(member);
    if (plate) {
      return {
        kind: "plate",
        path: `tiles/plates/${ground}/${plate[2]}.webp`,
        member,
        stale: true,
        w: TILE,
        h: PLATE_H,
      };
    }
    if (/\.webp$/.test(member)) {
      return { kind: "conform", path: member, member, stale: true, w: TILE, h: PLATE_H };
    }
    return null;
  }

  /** The maintainer's ground look for one cell: SET per region, MEMBER per cell,
   *  member -> art. */
  plateAt(
    ground: string,
    region: string,
    x: number,
    y: number,
  ): { set: BaseSet; memberIndex: number; art: PlateArt } {
    const set = this.setForRegion(ground, region);
    const memberIndex = pickMemberIndex(set, x, y);
    const member = memberIndex >= 0 ? set.members[memberIndex] : null;
    const art =
      member && member.kind === "tile"
        ? this.memberArt(ground, member.tile)
        : this.cleanPlate(ground);
    return { set, memberIndex, art };
  }

  /* -- the review matrix --------------------------------------------------- */

  /** The wiki's own rule: the maintainer's approved candidates first, then the
   *  rest in rank order. */
  candidates(top: string, side: string): ReviewCandidate[] {
    const k = `${top}__over__${side}`;
    let out = this.candCache.get(k);
    if (out) return out;
    const cell = this.data.review?.cells?.[k];
    if (!cell) {
      out = [];
    } else {
      const fb = this.data.feedback ?? {};
      const approved = cell.candidates.filter((c) => fb[c.key]?.status === "approved");
      const rest = cell.candidates.filter((c) => !approved.includes(c));
      out = [...approved, ...rest];
    }
    this.candCache.set(k, out);
    return out;
  }

  /** The approved candidate, else rank 0. For a STOREY fill (the repeated wall
   *  below the cap), candidates the maintainer flagged `top_only` are skipped: a
   *  top that repeats poorly vertically needs same-over-same backup. */
  approvedCandidate(top: string, side: string, storey = false): ReviewCandidate | null {
    let cands = this.candidates(top, side);
    if (storey) {
      const ov = this.data.wallOverrides ?? {};
      const rest = cands.filter((c) => !ov[c.key]?.top_only);
      cands = rest.length ? rest : cands;
    }
    return cands[0] ?? null;
  }

  /** The x-over-y tile — THE ONLY WALL SOURCE. Falls back to same-over-same.
   *  Throws when neither exists: the matrix is the only wall source, and a
   *  missing entry is a hole in it, not something to paint around. */
  overTile(top: string, side: string): TileArt {
    const k = `over|${top}|${side}`;
    const hit = this.tileCache.get(k);
    if (hit) return hit;
    const c = this.approvedCandidate(top, side) ?? this.approvedCandidate(top, top);
    if (!c)
      throw new Error(
        `tiles3: no review cell for ${top} over ${side} (nor ${top} over ${top}) — ` +
          `the x-over-y matrix is the ONLY wall source and it has no tile`,
      );
    const t: TileArt = { role: "over", top, side, key: c.key, path: c.file, w: TILE, h: TILE };
    this.tileCache.set(k, t);
    return t;
  }

  /** The repeated storey below a cap: same-over-same, honouring `top_only`. */
  storeyTile(ground: string): TileArt {
    const k = `storey|${ground}`;
    const hit = this.tileCache.get(k);
    if (hit) return hit;
    const c = this.approvedCandidate(ground, ground, true);
    if (!c) throw new Error(`tiles3: no same-over-same review cell for ${ground}`);
    const t: TileArt = { role: "storey", ground, key: c.key, path: c.file, w: TILE, h: TILE };
    this.tileCache.set(k, t);
    return t;
  }

  /** A FIELD tile, by the law's ladder: liquids paint a flat-colour diamond with
   *  NO wall; `base_tiles` in ground_types wins next; then the maintainer's live
   *  promotion; otherwise the approved same-over-same review tile, whose top is
   *  already flattened to the clean palette colour and whose wall is the real
   *  x-over-x art for wherever a rim exposes it. */
  flatTile(ground: string): TileArt {
    const k = `flat|${ground}`;
    const hit = this.tileCache.get(k);
    if (hit) return hit;
    const g = this.data.groundTypes[ground] ?? {};
    let t: TileArt;
    if (LIQUID_TILE_GROUNDS.includes(ground)) {
      t = {
        role: "flat",
        ground,
        painted: "liquid_diamond",
        topRGB: hexRGB(g.palette?.top ?? g.base_color ?? "#808080"),
        w: TILE,
        h: TILE,
      };
    } else {
      const canon = g.base_tiles ?? [];
      let path: string | null = canon.length ? canon[0] : null;
      if (!path) path = this.promotedBaseTile(ground);
      if (!path) {
        const c = this.approvedCandidate(ground, ground);
        if (!c) throw new Error(`tiles3: no same-over-same review cell for ${ground}`);
        path = c.file;
      }
      t = { role: "flat", ground, path, w: TILE, h: TILE };
    }
    this.tileCache.set(k, t);
    return t;
  }

  /** The maintainer's promoted base tile (live/tuning/base_tiles.json), looked
   *  up first in the review manifest — where the promotion prefers the
   *  BEFORE image, the textured pass — and then in the ground's
   *  base_candidates index. */
  private promotedBaseTile(ground: string): string | null {
    const promos = Object.keys(this.data.basePromotions ?? {}).filter(
      (k) => this.data.basePromotions?.[k]?.type === ground,
    );
    if (!promos.length) return null;
    let path: string | null = null;
    for (const cell of Object.values(this.data.review?.cells ?? {}))
      for (const c of cell.candidates) if (c.key === promos[0]) path = c.before ?? c.file;
    if (path) return path;
    for (const c of this.data.baseCandidates?.[ground]?.candidates ?? [])
      if (c.id === promos[0] || c.file.endsWith(`${promos[0]}.webp`)) return c.file;
    return null;
  }

  /** Top-approved detail tiles for a ground: the maintainer's `#top` approvals
   *  in the raw (pre-flattening) pass. The pool is empty for most grounds and
   *  the field never reaches for one today — see `resolveWindow`. */
  detailPool(ground: string): string[] {
    let out = this.detailCache.get(ground);
    if (out) return out;
    out = [];
    const fb = this.data.feedback ?? {};
    for (const cell of Object.values(this.data.review?.cells ?? {})) {
      if (cell.top !== ground) continue;
      for (const c of cell.candidates)
        if (fb[`${c.key}#top`]?.status === "approved") out.push(c.before ?? c.file);
    }
    this.detailCache.set(ground, out);
    return out;
  }

  /* -- fades --------------------------------------------------------------- */

  /** The REAL fade product: top-only mix tiles placed BY EDGE_GROUND — the
   *  ground the tile's RIM belongs to — never by area majority (big rocks ON an
   *  ice sheet). Sorted by how much of the other ground shows.
   *
   *  8..55% is the honest-mix window: a ~0% tile is the source set's own idea of
   *  a pure field, a >60% one reads as the other ground with a rim, and 50/50 is
   *  the maintainer's never rule. */
  fadePool(field: string, other: string): FadeTile[] {
    const key = `${field}|${other}`;
    let out = this.fadeCache.get(key);
    if (out) return out;
    out = [];
    const pairs = this.data.fades?.pairs ?? {};
    if (!this.data.fadeGuard) this.stats.unguardedFadePools++;
    for (const pk of [`${field}__to__${other}`, `${other}__to__${field}`]) {
      for (const t of pairs[pk] ?? []) {
        if (t.edge_ground !== field) continue;
        const pct = t.pct?.[other] ?? 0;
        if (!(pct >= 8 && pct <= 55)) continue;
        if (this.data.fadeGuard && !this.data.fadeGuard(t.file, field, other)) continue;
        out.push(t);
      }
    }
    out.sort((a, b) => (a.pct?.[other] ?? 0) - (b.pct?.[other] ?? 0));
    this.fadeCache.set(key, out);
    return out;
  }

  /* -- the sweep ----------------------------------------------------------- */

  /** Everything the window draws, in render3's own painter order. The whole
   *  point of the module: one call from the world doc to the art. */
  resolveWindow(view: World3View): Tiles3Window {
    const b: Bounds = { x0: view.x0, y0: view.y0, x1: view.x1, y1: view.y1 };
    const frame = isoFrame(b, view.maxLevel, this.data.storeyPitch);
    const inWindow = (x: number, y: number): boolean =>
      x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1;
    /* render3's `g()`: window-clamped. Its `L()` is not — a cliff at the window
     * edge still knows how far it drops. */
    const g = (x: number, y: number): string | null =>
      inWindow(x, y) ? view.groundAt(x, y) : null;
    const L = (x: number, y: number): number => view.levelAt(x, y);
    const regions = computeRegions(b, g);

    const cells: Tiles3Cell[] = [];
    for (let s = b.x0 + b.y0; s < b.x1 + b.y1 - 1; s++) {
      for (let x = Math.max(b.x0, s - b.y1 + 1); x < Math.min(b.x1, s - b.y0 + 1); x++) {
        const y = s - x;
        const gr = g(x, y);
        if (!gr) continue;
        const zl = L(x, y);
        const region = regions.idAt(x, y);
        const cell: Tiles3Cell = {
          x,
          y,
          ground: gr,
          level: zl,
          region,
          sx: columnX(frame, x, y),
          sy: columnY(frame, x, y, zl),
          kind: "field",
        };
        cells.push(cell);
        const liquid = view.isLiquid(gr);
        if (zl === 0 || liquid) {
          let art: FieldArt;
          if (liquid) {
            const t = this.flatTile(gr);
            art = {
              kind: "liquid",
              topRGB: t.topRGB ?? [128, 128, 128],
              w: t.w,
              h: t.h,
            };
          } else {
            const p = this.plateAt(gr, region, x, y);
            cell.set = p.set.id;
            cell.memberIndex = p.memberIndex;
            cell.plate = p.art;
            art = { kind: p.art.kind, path: p.art.path, w: p.art.w, h: p.art.h };
            const fade = this.fadeAt(g, L, gr, x, y, zl, view);
            if (fade) {
              cell.fade = fade;
              /* A fade tile's WALL is explicitly meaningless (the index says so),
               * so it is cropped to the top diamond and a flat field never grows
               * a stray wall. */
              art = { kind: "fade", path: fade.file, w: TILE, h: TOP_Y + 2 * DY + 2 };
            }
            /* render3 places a DETAIL only while the field tile is still
             * `flat_tile(ground)` — and since plate_img took the field over
             * (2026-08-29) it never is, so no detail is ever placed. Kept as the
             * same condition rather than deleted: promote a ground back to a
             * flat tile and details return with no edit here. */
            if (art.kind === "flat") {
              const d = this.detailAt(gr, x, y);
              if (d) {
                cell.detail = d;
                art = { kind: "flat", path: d.file, w: TILE, h: TILE };
              }
            }
          }
          cell.art = art;
          /* A 46px plate sits ON the cell's top vertex; anything 64-tall (the
           * liquid diamond, a cropped fade) hangs from TOP_Y. */
          cell.pasteY = cell.sy - (!liquid && art.h === PLATE_H ? 0 : TOP_Y);
          continue;
        }
        cell.kind = "wall";
        cell.wall = this.wallColumn(view, frame, g, L, gr, x, y, zl);
      }
    }

    return {
      frame,
      regions,
      cells,
      boundaries: this.boundaries(frame, regions, g, L),
      decks: this.deckCells(view, frame),
    };
  }

  /** THE FADE BAND: within FADE_BAND cells of a different SOLID ground at the
   *  same level, ease the change with the fades product. Ring 1 belongs to the
   *  composed boundary tile, so the scan starts at ring 2. */
  private fadeAt(
    g: (x: number, y: number) => string | null,
    L: (x: number, y: number) => number,
    gr: string,
    x: number,
    y: number,
    zl: number,
    view: World3View,
  ): FadePick | null {
    let near: [string, number] | null = null;
    for (let r = 2; r <= FADE_BAND && !near; r++) {
      for (const [dx, dy] of [
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ]) {
        const og = g(x + dx, y + dy);
        if (og && og !== gr && !view.isLiquid(og) && L(x + dx, y + dy) === zl) {
          near = [og, r];
          break;
        }
      }
    }
    if (!near) return null;
    const pool = this.fadePool(gr, near[0]);
    if (!pool.length) return null;
    const u = lcg((x * 73856093) ^ (y * 19349663))();
    const hi = pool.length - 1;
    // Nearer the edge -> stronger mix; jittered so the band is not a stripe.
    const bandPos = (FADE_BAND + 1 - near[1]) / (FADE_BAND + 1);
    const index = Math.max(0, Math.min(hi, Math.trunc((bandPos * 0.55 + u * 0.3 - 0.15) * hi)));
    return {
      other: near[0],
      dist: near[1],
      poolKey: `${gr}|${near[0]}`,
      index,
      u,
      file: pool[index].file,
    };
  }

  private detailAt(ground: string, x: number, y: number): { index: number; file: string } | null {
    const pool = this.detailPool(ground);
    if (!pool.length) return null;
    if (!(lcg((x * 83492791) ^ (y * 2654435761))() < DETAIL_FREQ)) return null;
    const index = Math.trunc(lcg(x * 31 + y)() * pool.length) % pool.length;
    return { index, file: pool[index] };
  }

  /** THE WALL STACK for a level change: the rim cell draws its OVER-tile (its
   *  own ground over the ground at the face's foot, i.e. the down-screen lower
   *  neighbour), then one same-over-same storey per exposed level below it.
   *  WHOLE TILES, not bands, at the MEASURED pitch. */
  private wallColumn(
    view: World3View,
    frame: Frame,
    g: (x: number, y: number) => string | null,
    L: (x: number, y: number) => number,
    gr: string,
    x: number,
    y: number,
    zl: number,
  ): WallColumn {
    const frontLow = Math.min(L(x + 1, y), L(x, y + 1));
    const down = L(x + 1, y) <= L(x, y + 1) ? [x + 1, y] : [x, y + 1];
    const override = view.wallSideAt(x, y);
    let side = override ?? g(down[0], down[1]) ?? gr;
    /* Stone over its own body; water is never a wall material either. Only when
     * the maintainer has NOT named the side himself. */
    if (!override && (INDOOR_GROUNDS.includes(side) || view.isLiquid(side))) side = gr;
    const capped = frontLow < zl;
    const cap = capped ? this.overTile(gr, side) : this.flatTile(gr);
    const midGround = override ? side : gr;
    const mid = this.storeyTile(midGround);
    const stack: WallStackStep[] = [];
    for (let f = Math.max(0, frontLow); f <= zl; f++)
      stack.push({ storey: f, tile: f === zl ? cap : mid, y: columnY(frame, x, y, f) - TOP_Y });
    return {
      side,
      frontLow,
      fx: down[0],
      fy: down[1],
      over: override !== null,
      capped,
      cap,
      mid,
      midGround,
      stack,
    };
  }

  /** side_a / side_b for a pair, canonical via the pattern library's own
   *  side_order. An unknown ground sorts last (99). */
  sideRoles(a: string, b: string): [string, string] {
    const o = this.data.patterns.selection?.side_order ?? [];
    const ia = o.indexOf(a) < 0 ? 99 : o.indexOf(a);
    const ib = o.indexOf(b) < 0 ? 99 : o.indexOf(b);
    return ia <= ib ? [a, b] : [b, a];
  }

  /** The frame of tiles/patterns/masks.webp a Wang index blends through, for the
   *  library's default pattern (a consumer with no maintainer preference draws
   *  that one). Null when the pattern is not in the doc. */
  maskFrame(index: number): number | null {
    const id = this.data.patterns.selection?.default_pattern;
    const row = this.data.patterns.patterns?.find((p) => p.id === id)?.row;
    if (row === undefined) return null;
    return row * (this.data.patterns.masks?.cols ?? 16) + index;
  }

  /** THE CORNER LATTICE, over the flats: a tile drawn at corner (x,y) blends
   *  cells (x,y), (x+1,y), (x,y+1), (x+1,y+1) when all four share a level and
   *  hold exactly two grounds. Index = 8*NW + 4*NE + 2*SW + 1*SE with bit 1
   *  meaning side_b — the ground LATER in side_order. 0 and 15 are one material
   *  either way and are skipped.
   *
   *  THE TRAP, and it is render3's behaviour so it is the behaviour: BOTH plates
   *  are resolved at the ANCHOR cell's region and the ANCHOR's x,y. The side
   *  that is not the anchor's own ground therefore gets a set picked from a
   *  region it does not belong to, and neither plate need match the plate the
   *  blended cells themselves drew. */
  private boundaries(
    frame: Frame,
    regions: Regions,
    g: (x: number, y: number) => string | null,
    L: (x: number, y: number) => number,
  ): Tiles3Boundary[] {
    const { x0, y0, x1, y1 } = frame;
    const out: Tiles3Boundary[] = [];
    for (let s = x0 + y0; s < x1 + y1 - 2; s++) {
      for (let x = Math.max(x0, s - y1 + 2); x < Math.min(x1 - 1, s - y0 + 1); x++) {
        const y = s - x;
        const quad: [number, number][] = [
          [x, y],
          [x + 1, y],
          [x, y + 1],
          [x + 1, y + 1],
        ];
        const gs = quad.map((q) => g(q[0], q[1]));
        if (gs.some((v) => v === null)) continue;
        const uniq = [...new Set(gs as string[])];
        if (uniq.length !== 2) continue;
        if (new Set(quad.map((q) => L(q[0], q[1]))).size !== 1) continue;
        const sorted = uniq.slice().sort();
        const [sa, sb] = this.sideRoles(sorted[0], sorted[1]);
        const index =
          8 * (gs[0] === sb ? 1 : 0) +
          4 * (gs[1] === sb ? 1 : 0) +
          2 * (gs[2] === sb ? 1 : 0) +
          1 * (gs[3] === sb ? 1 : 0);
        if (index === 0 || index === 15) continue;
        const region = regions.idAt(x, y);
        const pa = this.plateAt(sa, region, x, y);
        const pb = this.plateAt(sb, region, x, y);
        out.push({
          x,
          y,
          index,
          a: sa,
          b: sb,
          maskFrame: this.maskFrame(index),
          pattern: this.data.patterns.selection?.default_pattern ?? null,
          plateA: pa.art,
          plateB: pb.art,
          setA: pa.set.id,
          memberA: pa.memberIndex,
          setB: pb.set.id,
          memberB: pb.memberIndex,
          /* The tile's apex sits on the quad's shared corner: render3 offsets the
           * paste by -DY and then back by +DY, which is the column top itself. */
          sx: columnX(frame, x, y),
          sy: columnY(frame, x, y, L(x, y)),
          w: TILE,
          h: PLATE_H,
        });
      }
    }
    return out;
  }

  /** DECKS — roofs, bridges and the cave lid: a slab whose top rides at its own
   *  level with same-over-same wall bands down to its underside. A cell whose
   *  down-screen neighbours are both deck is covered, so it needs no face and no
   *  thickness. */
  private deckCells(view: World3View, frame: Frame): Tiles3DeckCell[] {
    const out: Tiles3DeckCell[] = [];
    view.decks.forEach((dk, di) => {
      const dg = dk.ground || "grey_stone";
      const dl = Math.trunc(dk.level);
      const th = Math.trunc(dk.thickness ?? 1);
      const cells = dk.cells
        .map((c) => [c.x, c.y] as [number, number])
        .sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[1] - b[1]);
      const set = new Set(cells.map(([x, y]) => y * view.width + x));
      for (const [x, y] of cells) {
        if (x < frame.x0 || x >= frame.x1 || y < frame.y0 || y >= frame.y1) continue;
        const frontCovered =
          set.has(y * view.width + x + 1) && set.has((y + 1) * view.width + x);
        const lo = frontCovered ? dl : Math.max(0, dl - Math.max(1, th));
        /* A cave lid is rock from underneath whatever its top is made of. */
        const body =
          dk.kind === "cave" && dg !== "black_rock" && dg !== "grey_stone" ? "grey_stone" : dg;
        const cap = frontCovered ? this.flatTile(dg) : this.overTile(dg, body);
        const mid = this.storeyTile(body);
        const stack: WallStackStep[] = [];
        for (let f = lo; f <= dl; f++)
          stack.push({ storey: f, tile: f === dl ? cap : mid, y: columnY(frame, x, y, f) - TOP_Y });
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
          sx: columnX(frame, x, y),
          stack,
        });
      }
    });
    return out;
  }
}

/** "#rrggbb" -> [r,g,b]. */
export function hexRGB(h: string): [number, number, number] {
  const s = h.replace("#", "");
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}
