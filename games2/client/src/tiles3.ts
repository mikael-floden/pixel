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
 * WHAT IT RESOLVES, all of it render3's, all of it the maintainer's data: the
 * base tile set per REGION and member per CELL on every cell — land, liquid,
 * deck and raised alike; the SLOPE where a ground rises to itself; the FADE
 * band before a ground change; his once-in-a-while DETAILS; the composed Wang
 * BOUNDARY, which IS the cell's surface and is never drawn over it; the x-over-y
 * WALL stack, its course keyed on the wall's own side; and the deck slabs.
 *
 * WHAT STAYS OUTSIDE. Four of render3's decisions need PIXELS, and a pure
 * module has none: the storey pitch (measured off the wall art — pass
 * `storeyPitch`, and `measureStoreyPitch` below is the rule to measure it
 * with), the fade set's alien-palette guard (pass `fadeGuard`), the slope
 * library's frame check (pass `slopeGuard`), and conforming a 64x64 review tile
 * into 64x46 plate geometry (a `conform` art is reported as such; the loader
 * conforms it). Nothing here silently substitutes for one, and every one of
 * them is counted in `stats` when it is missing.
 *
 * AND WHAT IT ONLY NAMES. `topOnly` on a surface is render3's `top_face_only`,
 * a MASK and not a crop — the wall is a vertical extrusion under the diamond,
 * so no source rectangle expresses it. `TileArt.borrowedWall` is the face a
 * `top_only` review tile borrows from another. Both are rasters the draw layer
 * builds; this module says which.
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
/** Cells of fade band each side of a hard edge. The band is a real CHEBYSHEV
 *  distance band from ring 1: the boundary tile rides the corner lattice ON TOP
 *  of the cell, so ring 1 is still the surface's to dress. */
export const FADE_BAND = 2;
/** A detail roughly once per 56 field cells — "once in a while", overridable per
 *  ground by live/tuning/tile_details.json (`rate`), which publishes none today. */
export const DETAIL_FREQ = 1 / 56;
/** Set 0 is reserved, named Clean, and holds nothing but the clean member. It is
 *  never deleted — it is switched off by weight, so a ground can always draw. */
export const CLEAN_SET_ID = 0;
/** The indoor floor that lays as ONE BOARD per room — render3's own rule and
 *  the only ground it applies to. */
export const ROOM_FLOOR = "parquet_floor";
/** THE REGION IS A CHUNK: one set per ground per 24x24 block of cells. See
 *  `regionAt` for why it is not a connected component. */
export const REGION_CHUNK = 24;

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
  /** Every region id the window touches, in row-major discovery order. */
  ids: string[];
}

/** THE REGION RULE: A 24-CELL CHUNK OF ONE GROUND, id `<ground>@<x/24>,<y/24>`.
 *
 *  A region is what picks the SET, and its granularity is the consumer's call —
 *  the shared reference calls it "an opaque string owned by the world agent"
 *  (wiki/lib/basesets.mjs). CONNECTED COMPONENTS WERE THE WRONG CALL, and this
 *  is the bug that made the maintainer's set weights invisible: an island is one
 *  4-connected component per ground, so ONE set painted 98.7% of the_game's
 *  grass, 99.7% of its snow and 99.8% of its black_rock. A chunk is a LOCATION —
 *  independent of shape, of which window is being rendered, and of every other
 *  cell — so the same coordinates always draw the same set, and the map carries
 *  as many of his sets as he weighted (measured on the_game: the top set's share
 *  of grass 98.7% -> 75.1%, of snow 99.7% -> 41.3%, of grey_stone 80.5% ->
 *  41.9%). render3.py's `region_at`, to the character. */
export function regionAt(ground: string, x: number, y: number): string {
  return `${ground}@${Math.floor(x / REGION_CHUNK)},${Math.floor(y / REGION_CHUNK)}`;
}

/** Every region id a window touches, and the id of one cell's OWN ground. Kept
 *  as an object rather than a bare function because a consumer wants the list
 *  (a gate reports it, an atlas groups by it) and the id of a void cell must be
 *  the same "r0" render3's `region_of` returns. */
export function computeRegions(
  b: Bounds,
  groundAt: (x: number, y: number) => string | null,
): Regions {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let y = b.y0; y < b.y1; y++)
    for (let x = b.x0; x < b.x1; x++) {
      const g = groundAt(x, y);
      if (!g) continue;
      const id = regionAt(g, x, y);
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  return {
    ids,
    idAt(x: number, y: number): string {
      if (x < b.x0 || x >= b.x1 || y < b.y0 || y >= b.y1) return "r0";
      const g = groundAt(x, y);
      return g ? regionAt(g, x, y) : "r0";
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
 *  weight"; the caller draws clean.
 *
 *  THE PURE REFERENCE PICK, the form wiki/lib/basesets.mjs publishes and the
 *  test cross-checks against it. The resolver picks over the same weights with
 *  the maintainer's REJECTED members already dropped — see `Tiles3.pool`. */
export function pickMemberIndex(set: BaseSet | null | undefined, x: number, y: number): number {
  if (!set || !set.members.length) return -1;
  return pickWeighted(
    set.members.map((m) => m.weight),
    unitHash(`bts1|tile|${set.id}|${x}|${y}`),
  );
}

/** A MEMBER'S VERDICT KEY. A review member is keyed by its review key; a `tops`
 *  member's identity is its RAW path and not the post rendering of it, and a
 *  top-only tile has no pair, so its verdict rides the same path with a `#top`
 *  suffix. render3's `_member_key`. */
export function memberVerdictKey(tile: string): string {
  if (!tile || !/\.webp$/.test(tile)) return tile;
  const at = tile.indexOf("/post/");
  if (at < 0) return tile;
  const dir = tile.slice(0, at);
  const file = tile.slice(at + "/post/".length);
  const m = /^(tile_\d+)\.[0-9a-f]{8}\.webp$/.exec(file);
  return m ? `${dir}/${m[1]}.webp` : tile;
}

/** Repo-relative keys are compared stripped of their slashes, as render3 does. */
function strip(k: string): string {
  return k.replace(/^\/+/, "").replace(/\/+$/, "");
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
  /** THE MEMBER'S OWN ART. `file` is the same tile with its top FLATTENED to the
   *  ground's clean colour by the pair postprocess's design, so a set member
   *  drawn from it paints the flat palette: 236 of the maintainer's 340 members
   *  did, measured, and a grass field's mean top face came out EXACTLY
   *  palette.top. Every candidate publishes this; the plate is geometry and
   *  fallback only. */
  textured?: string;
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
  /** The feedback key his verdicts ride. A fade is APPROVED-ONLY: he has judged
   *  825 of the 3,575 tiles and an unjudged one is not a candidate either. */
  key?: string;
  edge_ground?: string;
  pct?: Record<string, number>;
}
/** tiles/fades/index.json — `tiles3/fade-tiles@1`. */
export interface FadesDoc {
  pairs?: Record<string, FadeTile[]>;
}

/** One candidate in a built fade pool: the art, his verdict key, how much of the
 *  other ground shows, and the stars he gave it (which weight the pick). */
export interface FadePoolTile {
  file: string;
  key: string;
  pct: number;
  rating: number;
  /** WHICH RULE LET THIS TILE IN. 1 = approved and inside the honest-mix
   *  window (the only tier that has ever shipped); 2 = approved but outside the
   *  window, taken ONLY because tier 1 was empty; 3 = listed-but-unjudged,
   *  taken only when `provisionalFades` is on. A whole pool is one tier. */
  tier: 1 | 2 | 3;
}

/** tiles/slopes/index.json — `tiles3/slopes@1`. A Wang set on ELEVATION (the
 *  bit means that corner is RAISED), in the same 64x46 frame as a plate, so a
 *  slope drops straight into the surface slot. Every published set is a 4px
 *  sub-storey grade: it softens the foot of a rise, it cannot bridge a 17px
 *  storey (storey-height sets are requested from the tiles agent). */
export interface SlopeSet {
  ground: string;
  /** `tiles/slopes/<ground>/<set>` — the verdict key's stem and the art root. */
  dir: string;
  complete?: boolean;
  /** Index-aligned, 16 long, content-hashed: `<dir>/post/<post_files[i]>`. */
  post_files?: string[];
}
export interface SlopesDoc {
  sets?: SlopeSet[];
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
  /** THE WALL THIS TILE BORROWS. The maintainer marked the tile `top_only`
   *  (live/tuning/tile_walls.json — its own face is unusable) and named the
   *  replacement in live/tuning/top_walls.json; the two files only mean anything
   *  together. The face is `path`'s art with THIS tile's band pasted over rows
   *  TOP_Y+2*DY.. — one raster the resolver names and does not draw. */
  borrowedWall?: { key: string; path: string };
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
  /** live/feedback/tiles.json `.entries` — the maintainer's verdicts. `status`
   *  gates every art source (a rejected set member, an unapproved fade, an
   *  unapproved slope tile is not a candidate) and `rating` weights the fade
   *  pool. */
  feedback?: Record<string, { status?: string; rating?: number }>;
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
  /** tiles/slopes/index.json. */
  slopes?: SlopesDoc;
  /** live/tuning/top_walls.json `.overrides` — the wall a `top_only` tile
   *  borrows. Useless without `wallOverrides`, and vice versa. */
  topWallOverrides?: Record<string, { wall?: string }>;
  /** live/tuning/tile_tops.json `.overrides` — `own_top` keeps the x-over-y
   *  tile's OWN top; the base-tile-set surface is not painted over it. */
  topOverrides?: Record<string, { own_top?: boolean }>;
  /** live/tuning/tile_details.json `.rate` — a per-ground detail rate. Nothing
   *  is published today; every ground uses DETAIL_FREQ. */
  detailRates?: Record<string, number>;
  /** The fade set's ALIEN-PALETTE GUARD, which is a pixel test render3 runs over
   *  the tile's own top diamond (80th percentile of the per-pixel distance to
   *  the nearer of the two palette tops, rejected above 78). A pure module
   *  cannot run it; pass it, or the pool keeps tiles render3 drops — measured on
   *  the parity fixture, 2 of 10 pools differ without it. */
  fadeGuard?: (file: string, field: string, other: string) => boolean;
  /** IS THIS SLOPE TILE THE 64x46 THE FRAME REQUIRES? render3 falls back to the
   *  flat plate for a mis-sized publication rather than masking a 30-row tile
   *  with a 46-row silhouette. Measured today: all 240 reachable (approved,
   *  complete-set) slope tiles are 64x46, so an absent guard changes nothing —
   *  but the library has shipped 122 short tiles before, and
   *  `stats.unguardedSlopes` counts every pick made without one. */
  slopeGuard?: (file: string) => boolean;
  /** LET UNJUDGED FADE ART SHIP (tier 3), and ONLY into pairs that would
   *  otherwise draw no fade at all. Default OFF, which is exactly today's
   *  picture: the fade layer is one the maintainer rates himself, and 1,800 of
   *  the 9,061 listed tiles are art he has never seen. Turning it on trades
   *  "this pair has a hard edge" for "this pair fades with art he has not
   *  vetted", and on `the_game` that lights up 2,230 band cells on the WATER
   *  side of the beach — the surface he has just said looks right. So it is a
   *  switch, not a default. */
  provisionalFades?: boolean;
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
  /** `<field>|<other>` for every ordered pair that was ASKED for a fade and had
   *  nothing to give — the hard edge the maintainer sees as "the fade does not
   *  work between these two". An empty pool used to be silent; it is the one
   *  failure of this layer that has no visible symptom of its own. */
  deadFadePairs: string[];
  /** Pairs served from tier 2 (approved art outside the 8..55 window). */
  widenedFadePairs: string[];
  /** Pairs served from tier 3 (unjudged art, `provisionalFades` only). */
  provisionalFadePairs: string[];
  /** Slope tiles taken without `slopeGuard`. */
  unguardedSlopes: number;
  /** Boundary cells whose Pair Lab pattern is not in tiles/patterns/index.json.
   *  Nonzero means the tiles agent has unpublished one of his pool shapes and
   *  those cells draw no boundary at all — render3 asserts on this at import,
   *  which a browser cannot do. */
  unpublishedMasks: number;
  /** Distinct indoor rooms found by the floor fill. */
  rooms: number;
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

/** Everything the resolver can hand the draw layer for one cell's TOP.
 *
 *  `topOnly` is `top_face_only(...)`: the wall region of the 64x46 art is
 *  DROPPED so the cell's own x-over-y wall shows through. It is set on a liquid
 *  (a liquid never shows a wall), on the cap of a wall column and on a deck
 *  slab. It is a MASK, not a crop — the wall is a vertical extrusion under the
 *  diamond, so no source rectangle expresses it. */
export type FieldArt =
  | { kind: "plate" | "conform" | "clean"; path: string; w: number; h: number; topOnly?: boolean }
  | { kind: "liquid"; topRGB: [number, number, number]; w: number; h: number; topOnly?: boolean };

export interface FadePick {
  other: string;
  /** Chebyshev ring at which the other ground was found: 1 or 2. */
  dist: number;
  /** `<field ground>|<other ground>`. */
  poolKey: string;
  index: number;
  /** The LCG's two draws: `u` decides WHETHER this cell fades at all, `v` picks
   *  from the pool. Recorded because they are the whole determinism. */
  u: number;
  v: number;
  file: string;
}

/** The resolved surface of one cell, before it is placed. `art` is what draws;
 *  the rest is the provenance a fixture and a gate check. */
export interface Surface3 {
  art: { kind: "plate" | "conform" | "clean"; path: string; w: number; h: number };
  set?: number;
  memberIndex?: number;
  plate?: PlateArt;
  slope?: SlopePick;
  fade?: FadePick;
  detail?: DetailPick;
  boundary?: Tiles3Boundary;
}

export interface SlopePick {
  /** The Wang-on-ELEVATION index: bit set = that corner is RAISED. 0 is flat
   *  (no slope), 15 a full plateau top. */
  index: number;
  /** `tiles/slopes/<ground>/<set>` — the set the chunk picked. */
  dir: string;
  file: string;
}

export interface DetailPick {
  index: number;
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
  /** A face is exposed: a down-screen neighbour is LOWER. NO EXPOSED FACE, NO
   *  WALL — a raised cell whose front neighbours sit at its own level shows no
   *  cliff, and drawing its x-over-x tile anyway painted the tile's wall band
   *  onto flat ground with nothing in front to cover it (the row of ticks along
   *  every road and field edge on a plateau). Such a cell is resolved as a
   *  FIELD cell: one surface, no column. */
  capped: true;
  cap: TileArt;
  mid: TileArt;
  /** The ground the repeated course is made of: THE WALL'S SIDE, always. Keying
   *  it on the top ground drew 407 cells whose courses were a different material
   *  from their own cap. */
  midGround: string;
  stack: WallStackStep[];
}

export interface Tiles3Cell {
  x: number;
  y: number;
  ground: string;
  level: number;
  /** The cell's OWN ground's region — `<ground>@<x/24>,<y/24>`. */
  region: string;
  /** Column origin: `sx` is the 64-box left edge, `sy` the box top at the cell's
   *  own level (before the tile's own TOP_Y offset). */
  sx: number;
  sy: number;
  /** "wall" only when a face is EXPOSED. Everything else — level 0, a liquid at
   *  any level, and a raised cell with no exposed face — draws one surface and
   *  no column, which is what "field" means to the draw layer. */
  kind: "field" | "wall";
  /** The base-tile-set pick behind the surface. Absent when a composed boundary
   *  IS the surface for its own ground's half — `boundary` carries both halves
   *  then. */
  set?: number;
  memberIndex?: number;
  plate?: PlateArt;
  /** The graded tile that replaced the flat plate: this ground rises to ITSELF
   *  beside the cell. */
  slope?: SlopePick;
  fade?: FadePick;
  detail?: DetailPick;
  /** THE TILE IS THE BOUNDARY. When the cell's own four corners hold exactly two
   *  grounds at one level, render3 draws the composed Wang tile INSTEAD of the
   *  plate — never over it, which is the zigzag seam one cell off the real edge.
   *  `art` still names the cell's own half so a draw layer that has not composed
   *  the boundary yet paints something coherent underneath it. */
  boundary?: Tiles3Boundary;
  /** The surface, and where its 64-box goes. */
  art?: FieldArt;
  pasteY?: number;
  wall?: WallColumn;
  /** The surface is painted at all. False only where the maintainer set
   *  `own_top` on the cap's review key: keep the x-over-y tile's own top. */
  dressed?: boolean;
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
  /** A THREE-GROUND JUNCTION STILL GETS A BOUNDARY: the rarest of the three is
   *  folded into the majority so the tile still blends. Falling back to the pure
   *  plate there drew the cell's raw diamond edge — a hard straight segment in
   *  the middle of an otherwise organic coastline. */
  folded: boolean;
  /** Only the top face of the composed tile is painted — a wall cap, a liquid. */
  topOnly?: boolean;
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
  /** A roof, a bridge and a cave lid are GROUND too: the slab top wears the
   *  maintainer's base tile set like any other surface (top face only, so the
   *  cap's own wall survives). No fade, no slope, no boundary — render3 dresses
   *  a deck straight from `plate_img`. */
  surface: PlateArt;
  surfaceSet: number;
  surfaceMember: number;
  surfaceY: number;
}

export interface Tiles3Window {
  frame: Frame;
  regions: Regions;
  /** Painter order: back to front in (x+y), then x — render3's own sweep. */
  cells: Tiles3Cell[];
  /** Every composed boundary in the window, in the same cell order. Each is the
   *  `boundary` of the cell it is anchored on. */
  boundaries: Tiles3Boundary[];
  decks: Tiles3DeckCell[];
}

/* -- the resolver ----------------------------------------------------------- */

export class Tiles3 {
  readonly stats: Tiles3Stats = {
    staleMembers: 0,
    unresolvedMembers: 0,
    unguardedFadePools: 0,
    deadFadePairs: [],
    widenedFadePairs: [],
    provisionalFadePairs: [],
    unguardedSlopes: 0,
    unpublishedMasks: 0,
    rooms: 0,
  };

  private data: Tiles3Data;
  private setCache = new Map<string, BaseSet[]>();
  private setPick = new Map<string, BaseSet>();
  private plateCache = new Map<string, PlateArt>();
  private candCache = new Map<string, ReviewCandidate[]>();
  private tileCache = new Map<string, TileArt>();
  private detailCache = new Map<string, string[]>();
  private fadeCache = new Map<string, FadePoolTile[]>();
  /** cell index -> its room's anchor index. Built once per world. */
  private roomAnchors: Map<number, number> | null = null;
  /** The view the current resolve is running against — the room fill reads it. */
  private curView: World3View | null = null;
  private texturedCache: Map<string, string> | null = null;
  private slopeCache: Map<string, SlopeSet[]> | null = null;
  private slopeTileCache = new Map<string, SlopePick | null>();
  private livePool = new Map<string, { weights: number[]; index: number[] }>();
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
    this.livePool.clear();
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

  /** A base_tile_sets member string -> the art that draws it, render3's ladder.
   *
   *  A member has two legal forms, and which art each resolves to is NOT a
   *  string rule but a lookup:
   *
   *    REVIEW KEY (`tiles/<pair>/<key8>`) -> the candidate's OWN `textured` art,
   *      CONFORMED into plate geometry. NEVER tiles/plates/<g>/<key8>.webp: that
   *      is the same tile flattened to the ground's clean colour by the pair
   *      postprocess's design, and reading it painted 236 of his 340 members
   *      flat — measured, a grass field's mean top face was EXACTLY palette.top.
   *      The plate is the fallback for a candidate with no textured pass.
   *    FILE (`....webp`) -> the art itself, conformed. render3 first probes
   *      tiles/plates/<ground>/<8-hex token>.webp for every hash token in the
   *      basename and prefers a published plate; that needs a directory listing,
   *      which a pure module has not got, so tiles/resolve.json answers it.
   *      Measured over all 104 file-form members: ZERO such plate exists, so the
   *      two rules agree on every member published today.
   *
   *  DISAGREEMENT, recorded 2026-08-29: tiles/resolve.json's `forms` still
   *  resolves a review key to the flattened plate, so it is STALE against
   *  render3 for all 236 review-key members and is only consulted for the file
   *  form and for the plate fallback. The index owner has been told. */
  memberArt(ground: string, member: string): PlateArt {
    const key = `${ground}|${member}`;
    const hit = this.plateCache.get(key);
    if (hit) return hit;
    const art = this.resolveMember(ground, member);
    this.plateCache.set(key, art);
    return art;
  }

  private resolveMember(ground: string, member: string): PlateArt {
    if (!/\.webp$/.test(member)) {
      const tex = this.texturedArt(member);
      if (tex) return { kind: "conform", path: tex, member, stale: false, w: TILE, h: PLATE_H };
    }
    const entry = this.data.memberResolve?.members?.[member];
    if (entry && typeof entry.art === "string" && entry.art)
      return {
        kind: entry.kind === "plate" ? "plate" : "conform",
        path: entry.art,
        member,
        stale: false,
        w: TILE,
        h: PLATE_H,
      };
    this.stats.staleMembers++;
    this.warn(
      `stale:${member}`,
      `tiles3: "${member}" is not in tiles/resolve.json — the index is STALE. ` +
        `Falling back to the documented forms rule; regenerate resolve.json.`,
    );
    const forms = this.memberArtFromForms(ground, member);
    if (forms) return forms;
    this.stats.unresolvedMembers++;
    this.warn(
      `unresolved:${member}`,
      `tiles3: "${member}" resolves to no art at all and will draw CLEAN. ` +
        `base_tile_sets references something that is not published.`,
    );
    return this.cleanPlate(ground);
  }

  /** THE MEMBER'S OWN ART for a review key: the candidate's published `textured`
   *  pass, from the review manifest. Both the full key and its 8-hex basename
   *  index it, as render3 does. */
  private texturedArt(key: string): string | null {
    if (!this.texturedCache) {
      const m = new Map<string, string>();
      for (const cell of Object.values(this.data.review?.cells ?? {}))
        for (const c of cell.candidates) {
          if (!c.textured) continue;
          const k = strip(c.key);
          m.set(k, c.textured);
          m.set(k.split("/").pop() as string, c.textured);
        }
      this.texturedCache = m;
    }
    return this.texturedCache.get(strip(key)) ?? null;
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
   *  member -> art. His rejections are applied to the member pool first. */
  plateAt(
    ground: string,
    region: string,
    x: number,
    y: number,
    /** The cell the MEMBER is picked at — the room's anchor for an indoor
     *  floor, this cell for everything else. */
    ax: number = x,
    ay: number = y,
  ): { set: BaseSet; memberIndex: number; art: PlateArt } {
    const set = this.setForRegion(ground, region);
    /* The rejected members are dropped ONCE per set, not per cell: this runs on
     * every cell of every window and twice more on every boundary, and the
     * filter+map form allocated four arrays each time. Same answer as
     * `pickMemberIndex(set, x, y, rejected)`, and the parity fixture proves it. */
    const pool = this.pool(ground, set);
    const i = pickWeighted(pool.weights, unitHash(`bts1|tile|${set.id}|${ax}|${ay}`));
    const memberIndex = i < 0 ? -1 : pool.index[i];
    const member = memberIndex >= 0 ? set.members[memberIndex] : null;
    const art =
      member && member.kind === "tile"
        ? this.memberArt(ground, member.tile)
        : this.cleanPlate(ground);
    return { set, memberIndex, art };
  }

  /** One set's members with HIS REJECTIONS ALREADY APPLIED: the weights to pick
   *  over, and where each lands in the set's full `members`.
   *
   *  His rejection outranks his set — a tile he put in a set and later rejected
   *  was still being drawn, and one such member was measured on the map. It is
   *  dropped BEFORE the weighted pick, so the survivors share its weight. Clean
   *  is never dropped: it is the member every set can always fall back to. */
  private pool(ground: string, set: BaseSet): { weights: number[]; index: number[] } {
    const k = `${ground}|${set.id}`;
    let p = this.livePool.get(k);
    if (!p) {
      p = { weights: [], index: [] };
      set.members.forEach((m, i) => {
        if (m.kind !== "clean" && this.memberRejected(m)) return;
        (p as { weights: number[]; index: number[] }).weights.push(m.weight);
        (p as { weights: number[]; index: number[] }).index.push(i);
      });
      this.livePool.set(k, p);
    }
    return p;
  }

  /** The same look at the cell's OWN region — every caller that has a ground and
   *  a cell and no opinion about regions. */
  plateFor(ground: string, x: number, y: number) {
    /* ONE PARQUET FLOOR PER ROOM. The SET still comes from this cell's own
     * region; only the MEMBER is asked for at the room's anchor, which is
     * render3's split exactly (`pick_set(ground, region)` then
     * `pick_member(chosen, ax, ay)`). Without it a floor is a patchwork that
     * changes underfoot (maintainer 2026-08-30, restated 08-29: "I said one
     * Parquet Floor per room!!!"). */
    const [ax, ay] = ground === ROOM_FLOOR ? this.roomAnchor(x, y) : [x, y];
    /* THE REGION COMES FROM THE ANCHOR TOO for an indoor floor. render3 takes
     * the SET from the cell's own 24-cell chunk and only the MEMBER from the
     * anchor, which lays two different boards in one room the moment it crosses
     * a chunk boundary — measured on the_game: 2 of 4 rooms in one window. The
     * rule is ONE FLOOR PER ROOM, so the whole room asks at the anchor: same
     * set, same member, one board. */
    return this.plateAt(ground, regionAt(ground, ax, ay), x, y, ax, ay);
  }

  /** The anchor cell of the room this one belongs to, or itself.
   *
   *  WORLD-SCOPED AND CACHED, where render3 fills rooms per RENDER WINDOW. A
   *  window-scoped anchor would move when the window moved, so a floor would
   *  relay itself as the player walked — the two agree for any room that fits
   *  inside a window, which every house does, and this cannot disagree with
   *  itself. Flood fill is 4-connected and the anchor is the lexicographic
   *  minimum by (x, y), matching python's `min()` over the coordinate tuples. */
  private roomAnchor(x: number, y: number): [number, number] {
    const view = this.curView;
    if (!view) return [x, y];
    if (!this.roomAnchors) {
      const W = view.width;
      const H = view.height;
      const m = new Map<number, number>();
      const seen = new Uint8Array(W * H);
      const stack: number[] = [];
      for (let sy = 0; sy < H; sy++) {
        for (let sx = 0; sx < W; sx++) {
          const si = sy * W + sx;
          if (seen[si] || view.groundAt(sx, sy) !== ROOM_FLOOR) continue;
          const comp: number[] = [];
          seen[si] = 1;
          stack.length = 0;
          stack.push(si);
          while (stack.length) {
            const i = stack.pop() as number;
            comp.push(i);
            const cx = i % W;
            const cy = (i - cx) / W;
            for (const [nx, ny] of [
              [cx + 1, cy],
              [cx - 1, cy],
              [cx, cy + 1],
              [cx, cy - 1],
            ]) {
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const ni = ny * W + nx;
              if (seen[ni] || view.groundAt(nx, ny) !== ROOM_FLOOR) continue;
              seen[ni] = 1;
              stack.push(ni);
            }
          }
          let ax = Infinity;
          let ay = Infinity;
          for (const i of comp) {
            const cx = i % W;
            const cy = (i - cx) / W;
            if (cx < ax || (cx === ax && cy < ay)) {
              ax = cx;
              ay = cy;
            }
          }
          const a = ay * W + ax;
          for (const i of comp) m.set(i, a);
        }
      }
      this.roomAnchors = m;
      this.stats.rooms = new Set(m.values()).size;
    }
    const a = this.roomAnchors.get(y * view.width + x);
    if (a === undefined) return [x, y];
    const ax = a % view.width;
    return [ax, (a - ax) / view.width];
  }

  /** Did he reject this member? The verdict rides the member's key, that key
   *  plus `#top`, or the raw tile string. */
  memberRejected(m: BaseMember): boolean {
    if (m.kind !== "tile" || !m.tile) return false;
    const fb = this.data.feedback ?? {};
    const k = memberVerdictKey(m.tile);
    for (const probe of [k, `${k}#top`, m.tile])
      if (fb[strip(probe)]?.status === "rejected") return true;
    return false;
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

  /** The candidate behind the x-over-y tile — same-over-same is the fallback. */
  overCandidate(top: string, side: string): ReviewCandidate {
    const c = this.approvedCandidate(top, side) ?? this.approvedCandidate(top, top);
    if (!c)
      throw new Error(
        `tiles3: no review cell for ${top} over ${side} (nor ${top} over ${top}) — ` +
          `the x-over-y matrix is the ONLY wall source and it has no tile`,
      );
    return c;
  }

  /** The x-over-y tile — THE ONLY WALL SOURCE. Falls back to same-over-same.
   *  Throws when neither exists: the matrix is the only wall source, and a
   *  missing entry is a hole in it, not something to paint around.
   *
   *  TOP_ONLY: when the maintainer marked this tile's own wall unusable, the
   *  face is replaced by the wall he chose for it in top_walls.json — the tile
   *  keeps its top and BORROWS a wall, which is the only thing the two files
   *  mean together. Without the pairing the mark was dead: it filtered a storey
   *  pool it could never match. */
  overTile(top: string, side: string): TileArt {
    const k = `over|${top}|${side}`;
    const hit = this.tileCache.get(k);
    if (hit) return hit;
    const c = this.overCandidate(top, side);
    const t: TileArt = { role: "over", top, side, key: c.key, path: c.file, w: TILE, h: TILE };
    if (this.topOnly(c.key)) {
      const lend = this.borrowedWall(c.key) ?? this.approvedCandidate(side, side);
      if (lend) t.borrowedWall = { key: lend.key, path: lend.file };
    }
    this.tileCache.set(k, t);
    return t;
  }

  /** live/tuning/tile_walls.json: this tile's own wall is unusable. */
  topOnly(key: string): boolean {
    return !!this.data.wallOverrides?.[strip(key)]?.top_only;
  }

  /** live/tuning/tile_tops.json: keep the x-over-y tile's OWN top; do not paint
   *  the base-tile-set surface over it. */
  ownTop(key: string): boolean {
    return !!this.data.topOverrides?.[strip(key)]?.own_top;
  }

  /** live/tuning/top_walls.json: the wall the maintainer picked for a `top_only`
   *  tile. The reference names `<cell>/<key8>`; the candidate it points at is
   *  looked up in the review matrix, never reconstructed as a path. */
  borrowedWall(key: string): ReviewCandidate | null {
    const ref = this.data.topWallOverrides?.[strip(key)]?.wall;
    if (!ref) return null;
    const parts = strip(ref).split("/");
    if (parts.length < 2) return null;
    const k8 = parts[parts.length - 1];
    const cell = this.data.review?.cells?.[parts[parts.length - 2]];
    if (!cell) return null;
    return cell.candidates.find((c) => strip(c.key).endsWith(`/${k8}`)) ?? null;
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

  /** THE MAINTAINER'S ONCE-IN-A-WHILE GROUND DETAILS — his `#top` approvals, in
   *  review-manifest order.
   *
   *  The wiki states the contract in his words: the roof glyph is "rating the
   *  TOP as a once-in-a-while ground detail", and a tile REJECTED AS A PAIR (bad
   *  wall) can still be a top-approved detail — the two reviews are independent
   *  by design. The art is the TEXTURED pass, not `file`: the pair postprocess
   *  flattens every top to the clean colour, which is WHY he has never seen most
   *  of them. A detail is CONFORMED like any other surface, so its foreign lava,
   *  ice or sand wall can never leak into a field. */
  detailPool(ground: string): string[] {
    let out = this.detailCache.get(ground);
    if (out) return out;
    out = [];
    const fb = this.data.feedback ?? {};
    for (const cell of Object.values(this.data.review?.cells ?? {})) {
      if (cell.top !== ground) continue;
      for (const c of cell.candidates) {
        if (fb[`${c.key}#top`]?.status !== "approved") continue;
        const rel = c.textured ?? c.before ?? c.file;
        if (rel) out.push(rel);
      }
    }
    this.detailCache.set(ground, out);
    return out;
  }

  /* -- slopes -------------------------------------------------------------- */

  /** THE SLOPE SETS A GROUND CAN DRAW, in `dir` order.
   *
   *  ONLY COMPLETE SETS: 9 of the 225 published sets ship fewer than 16 post
   *  files, and a Wang set indexed by a corner bitmask is an out-of-range read on
   *  a short one. ONLY JUDGED SETS: he has judged 15 of the 225, and picking
   *  across all 15 seeds per ground meant roughly 14 of every 15 slope tiles came
   *  from a set he had never seen ("I kinda got the feeling you used a slope I
   *  never approved"). */
  slopeSets(ground: string): SlopeSet[] {
    if (!this.slopeCache) {
      const by = new Map<string, SlopeSet[]>();
      for (const st of this.data.slopes?.sets ?? []) {
        if (!st.complete || (st.post_files?.length ?? 0) !== 16) continue;
        let any = false;
        for (let i = 0; i < 16 && !any; i++) any = this.slopeApproved(st.dir, i);
        if (!any) continue;
        const list = by.get(st.ground);
        if (list) list.push(st);
        else by.set(st.ground, [st]);
      }
      for (const list of by.values()) list.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
      this.slopeCache = by;
    }
    return this.slopeCache.get(ground) ?? [];
  }

  /** HIS VERDICT, PER TILE — verdicts are keyed `<set dir>/tile_NN`. */
  slopeApproved(dir: string, index: number): boolean {
    const k = `${strip(dir)}/tile_${String(index).padStart(2, "0")}`;
    return this.data.feedback?.[k]?.status === "approved";
  }

  /** The graded tile for this corner bitmask. The SEED is chosen per CHUNK, so a
   *  hillside keeps one boundary character for the same reason a base set does.
   *  Null for an unjudged ground (light_soil, and every ground with no approved
   *  set) and for the flat/full indices 0 and 15. */
  slopeTile(ground: string, index: number, x: number, y: number): SlopePick | null {
    const ck = `${ground}|${index}|${Math.floor(x / REGION_CHUNK)},${Math.floor(y / REGION_CHUNK)}`;
    const hit = this.slopeTileCache.get(ck);
    if (hit !== undefined) return hit;
    let out: SlopePick | null = null;
    if (index > 0 && index < 16) {
      const sets = this.slopeSets(ground).filter((st) => this.slopeApproved(st.dir, index));
      if (sets.length) {
        const st = sets[fnv1a(`slope|${ground}|${Math.floor(x / REGION_CHUNK)}|${Math.floor(y / REGION_CHUNK)}`) % sets.length];
        const file = `${st.dir}/post/${(st.post_files as string[])[index]}`;
        /* A MIS-SIZED PUBLICATION FALLS BACK TO THE FLAT PLATE, never crashes: a
         * 30-row tile cannot be masked by the 46-row silhouette. */
        if (this.data.slopeGuard) {
          if (this.data.slopeGuard(file)) out = { index, dir: st.dir, file };
        } else {
          this.stats.unguardedSlopes++;
          out = { index, dir: st.dir, file };
        }
      }
    }
    this.slopeTileCache.set(ck, out);
    return out;
  }

  /** THE SLOPE BITMASK for one cell: bit set when a cell touching that corner is
   *  HIGHER and made of the SAME ground. Corner order is the Wang order —
   *  NW, NE, SW, SE — and the bit is `8 >> i`. This is what makes a path uphill
   *  read as a climb instead of a stack of flat diamonds. */
  slopeIndexAt(
    g: (x: number, y: number) => string | null,
    L: (x: number, y: number) => number,
    ground: string,
    x: number,
    y: number,
    zl: number,
  ): number {
    /* Unrolled over the corner (i = 0..3 -> NW, NE, SW, SE) and the four cells
     * that touch it. Runs on every cell of every window, so it allocates
     * nothing: the array-of-pairs form cost 8 arrays per cell. */
    let idx = 0;
    for (let i = 0; i < 4; i++) {
      const cx = x + (i & 1);
      const cy = y + (i >> 1);
      for (let k = 0; k < 4; k++) {
        const ax = cx - 1 + (k & 1);
        const ay = cy - 1 + (k >> 1);
        if (L(ax, ay) > zl && g(ax, ay) === ground) {
          idx |= 8 >> i;
          break;
        }
      }
    }
    return idx;
  }

  /* -- fades --------------------------------------------------------------- */

  /** THE REAL FADE PRODUCT: top-only mix tiles placed BY EDGE_GROUND — the
   *  ground the tile's RIM belongs to — never by area majority (big rocks ON an
   *  ice sheet). Sorted by how much of the other ground shows.
   *
   *  APPROVED ONLY, and his rating rides the entry. He has judged 825 of the
   *  3,575 fade tiles (480 approved, 345 rejected) — a layer he actively rates,
   *  so an unjudged tile is not a candidate either; merely dropping the rejected
   *  ones still drew 151 tiles he had never seen.
   *
   *  8..55% is the honest-mix window: a ~0% tile is the source set's own idea of
   *  a pure field, a >60% one reads as the other ground with a rim, and 50/50 is
   *  the maintainer's never rule. */
  fadePool(field: string, other: string): FadePoolTile[] {
    const key = `${field}|${other}`;
    let out = this.fadeCache.get(key);
    if (out) return out;
    if (!this.data.fadeGuard) this.stats.unguardedFadePools++;
    /* THE TIERS, IN ORDER, AND THE FIRST NON-EMPTY ONE WINS OUTRIGHT. A pool is
     * never MIXED across tiers: a widened or provisional tile is a fallback for
     * a pair that has nothing, never a dilution of a pair that has something.
     *
     * Measured on tiles/fades/index.json + live/feedback/tiles.json, 2026-09-04:
     * of the 154 ordered pairs the band can ever ask for (the other side must be
     * solid), 138 answer at tier 1, 2 more at tier 2 (deep_water->light_beach,
     * water->dark_mud: every approved tile is a sub-8% mix), 13 more only at
     * tier 3, and exactly ONE — water->grey_paving_stone — has no art with the
     * right edge_ground at all and needs the tiles agent. */
    out = this.fadeTier(field, other, 1);
    if (!out.length) {
      out = this.fadeTier(field, other, 2);
      if (out.length) this.stats.widenedFadePairs.push(key);
    }
    if (!out.length && this.data.provisionalFades) {
      out = this.fadeTier(field, other, 3);
      if (out.length) this.stats.provisionalFadePairs.push(key);
    }
    if (!out.length) {
      /* NEVER SILENT AGAIN. This is the whole symptom of the missing-pair bug:
       * the band runs, finds nothing, and draws the plain field. */
      this.stats.deadFadePairs.push(key);
      this.warn(
        `deadfade:${key}`,
        `tiles3: no fade art for ${field} next to ${other} — that edge draws hard`,
      );
    }
    this.fadeCache.set(key, out);
    return out;
  }

  /** ONE TIER of `fadePool`, built from the same two index keys and the same
   *  edge_ground rule. `pct` is how much of `other` shows; 8..55 is the honest-
   *  mix window (a ~0% tile is the source set's own idea of a pure field, a
   *  >60% one reads as the other ground with a rim, and 50/50 is his never
   *  rule). Sorted by pct, which is the order the distance weighting expects. */
  private fadeTier(field: string, other: string, tier: 1 | 2 | 3): FadePoolTile[] {
    const out: FadePoolTile[] = [];
    const pairs = this.data.fades?.pairs ?? {};
    const fb = this.data.feedback ?? {};
    for (const pk of [`${field}__to__${other}`, `${other}__to__${field}`]) {
      for (const t of pairs[pk] ?? []) {
        if (t.edge_ground !== field) continue;
        const e = fb[t.key ?? ""];
        /* A REJECTED TILE IS NEVER A CANDIDATE AT ANY TIER. */
        if (e?.status === "rejected") continue;
        if (tier === 3 ? e?.status === "approved" : e?.status !== "approved") continue;
        const pct = t.pct?.[other] ?? 0;
        if (tier !== 2 && !(pct >= 8 && pct <= 55)) continue;
        if (tier === 2 && pct > 55) continue;
        if (this.data.fadeGuard && !this.data.fadeGuard(t.file, field, other)) continue;
        out.push({ file: t.file, key: t.key ?? "", pct, rating: Number(e?.rating) || 0, tier });
      }
    }
    out.sort((a, b) => a.pct - b.pct);
    return out;
  }

  /* -- the sweep ----------------------------------------------------------- */

  /** Everything the window draws, in render3's own painter order. The whole
   *  point of the module: one call from the world doc to the art. */
  resolveWindow(view: World3View): Tiles3Window {
    this.curView = view;
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
    const boundaries: Tiles3Boundary[] = [];
    for (let s = b.x0 + b.y0; s < b.x1 + b.y1 - 1; s++) {
      for (let x = Math.max(b.x0, s - b.y1 + 1); x < Math.min(b.x1, s - b.y0 + 1); x++) {
        const cell = this.resolveCell(view, frame, g, L, x, s - x);
        if (!cell) continue;
        cells.push(cell);
        if (cell.boundary) boundaries.push(cell.boundary);
      }
    }

    return { frame, regions, cells, boundaries, decks: this.deckCells(view, frame) };
  }

  /** ONE CELL, whole. render3's inner loop: a liquid draws its surface's top
   *  face and nothing else; a level-0 cell draws its Wang surface entire; a
   *  raised cell draws its wall column and then wears the surface on the cap —
   *  and a raised cell with NO EXPOSED FACE draws only the surface, which is a
   *  field cell in every sense the draw layer has. */
  resolveCell(
    view: World3View,
    frame: Frame,
    g: (x: number, y: number) => string | null,
    L: (x: number, y: number) => number,
    x: number,
    y: number,
  ): Tiles3Cell | null {
    const gr = g(x, y);
    if (!gr) return null;
    const zl = L(x, y);
    const cell: Tiles3Cell = {
      x,
      y,
      ground: gr,
      level: zl,
      region: regionAt(gr, x, y),
      sx: columnX(frame, x, y),
      sy: columnY(frame, x, y, zl),
      kind: "field",
    };

    if (view.isLiquid(gr)) {
      /* A LIQUID IS A GROUND WITH A SET TOO (water: 16 tiles, clean weight 0 —
       * he chose every one of them), and it was drawing a flat colour diamond
       * while being the largest surface on the map. Top face only: a liquid
       * never shows a wall. render3 takes `surface`, never `wang_surface` — no
       * quad touching a liquid composes a boundary. */
      /* WANG, NOT PLAIN — so a shore COMPOSES. `surface()` carries no fade, no
       * slope and no boundary, which is why a water cell used to meet a beach
       * with a hard diamond edge; `boundaryAt` now composes that quad, and the
       * two resolvers have to agree or `tiles3runtime`'s parity gate fails
       * (it did, on the_bay 392,357 — water/light_beach — which is exactly the
       * coastline he was asking about).
       *
       * Still `dress(..., true)`: a liquid never shows a wall, so its surface
       * and its boundary are both masked to the library top face. */
      this.dress(cell, this.wangSurface(view, frame, g, L, gr, x, y, zl), true);
      return cell;
    }
    if (zl === 0) {
      this.dress(cell, this.wangSurface(view, frame, g, L, gr, x, y, zl), false);
      return cell;
    }

    const frontLow = Math.min(L(x + 1, y), L(x, y + 1));
    const down: [number, number] = L(x + 1, y) <= L(x, y + 1) ? [x + 1, y] : [x, y + 1];
    const override = view.wallSideAt(x, y);
    let side = override ?? g(down[0], down[1]) ?? gr;
    /* Stone over its own body; water is never a wall material either. Only when
     * the maintainer has NOT named the side himself. */
    if (!override && (INDOOR_GROUNDS.includes(side) || view.isLiquid(side))) side = gr;

    const exposed = frontLow < zl;
    let dressed = true;
    if (exposed) {
      const cap = this.overTile(gr, side);
      /* The repeated course is the WALL's own material in every case — keying it
       * on the top ground drew 407 cells whose courses were a different material
       * from their own cap. */
      const mid = this.storeyTile(side);
      const stack: WallStackStep[] = [];
      for (let f = Math.max(0, frontLow); f <= zl; f++)
        stack.push({ storey: f, tile: f === zl ? cap : mid, y: columnY(frame, x, y, f) - TOP_Y });
      cell.kind = "wall";
      cell.wall = {
        side,
        frontLow,
        fx: down[0],
        fy: down[1],
        over: override !== null,
        capped: true,
        cap,
        mid,
        midGround: side,
        stack,
      };
      dressed = !this.ownTop(this.overCandidate(gr, side).key);
    }
    /* ...and the SURFACE goes on the cap: the wall is x-over-y art, the top is
     * the maintainer's set. TOP FACE ONLY at every raised level, exposed or not,
     * so the cap's own wall — the only lawful wall source — survives, and an
     * unexposed cell never paints a wall band onto flat ground. */
    this.dress(cell, this.wangSurface(view, frame, g, L, gr, x, y, zl), true);
    cell.dressed = dressed;
    return cell;
  }

  /** Record a resolved surface on the cell and work out where its box goes. A
   *  surface is always 64x46 plate geometry and always sits ON the cell's top
   *  vertex, whatever produced it. */
  private dress(cell: Tiles3Cell, srf: Surface3, topOnly: boolean): void {
    cell.set = srf.set;
    cell.memberIndex = srf.memberIndex;
    cell.plate = srf.plate;
    if (srf.slope) cell.slope = srf.slope;
    if (srf.fade) cell.fade = srf.fade;
    if (srf.detail) cell.detail = srf.detail;
    if (srf.boundary) cell.boundary = srf.boundary;
    cell.art = { ...srf.art, ...(topOnly ? { topOnly: true } : {}) };
    cell.pasteY = cell.sy;
  }

  /** THE COMPOSED BOUNDARY THIS CELL WEARS, or null. The Wang index is read from
   *  the four corners of the cell BEING DRAWN — `8*NW + 4*NE + 2*SW + 1*SE`, bit
   *  set = side_b, the ground later in the library's `side_order` — so 0 and 15
   *  are the pure field and draw no boundary. NO LIQUID may touch the quad on
   *  this cell's own plane: a coast is a hard edge, not a blend.
   *
   *  A CORNER OFF THIS CELL'S LEVEL IS NOT ON THIS TILE, so it carries this
   *  cell's own ground. That is the whole cross-level rule, and it falls out of
   *  where the raster goes: a composed boundary is drawn INSTEAD of this cell's
   *  plate, at this cell's own column and at `columnY(..., z0)` — one flat 64x46
   *  diamond on the plane z0. A corner one storey up is 15 px higher on screen
   *  and a corner one storey down is 15 px lower; neither has a single texel
   *  inside this box. Painting its ground into a quadrant of this diamond would
   *  put the ground at the FOOT of a cliff onto the cliff TOP (or the reverse),
   *  which is why the old rule refused the quad outright. But refusing the whole
   *  quad also threw away the corners that ARE on the plane: a terrace lip whose
   *  own top face carries a real grass/stone edge got a hard diamond edge purely
   *  because the fourth corner of its quad happened to step. Folding per corner
   *  keeps both halves of the truth — a cliff edge stays a hard edge (softened
   *  by the fade, which crosses levels), and a same-plane ground change blends
   *  wherever it actually is.
   *
   *  SAME-LEVEL QUADS ARE UNTOUCHED, TO THE CELL: every corner passes the level
   *  test, so the fold is the identity and the index, mask, plates and key are
   *  byte-for-byte what they were. Measured over the_game (262,144 cells):
   *  3,257 -> 3,563 boundaries, 306 added, 0 existing boundary lost and 0
   *  changed; 2,652 -> 2,916 distinct compositions world-wide.
   *
   *  DIVERGES FROM render3 (`wang_surface`, `len({L(*c)}) == 1`), deliberately
   *  and in the same direction the fade already went — see maps2's hand-off in
   *  the commit. The reference renderer draws one still image of a world nobody
   *  walks; the game is the thing he is looking at.
   *
   *  `topOnly` NEEDS NO NEW RULE: the raster replaces THIS cell's plate, so the
   *  cell's own level decides it exactly as before — level 0 keeps the full
   *  2,012-texel silhouette (`capWallToSurface`), raised is the 924-texel top
   *  face and the cap's x-over-y art is the wall. */
  boundaryAt(
    view: World3View,
    frame: Frame,
    g: (x: number, y: number) => string | null,
    L: (x: number, y: number) => number,
    x: number,
    y: number,
  ): {
    boundary: Tiles3Boundary;
    pa: { set: BaseSet; memberIndex: number; art: PlateArt };
    pb: { set: BaseSet; memberIndex: number; art: PlateArt };
    ownSide: "a" | "b";
  } | null {
    /* THE FAST PATH, and it is most of the map: four corners of ONE ground is a
     * pure field and composes nothing. Taken before a single allocation —
     * `boundaryAt` runs on every cell of every window and the quad/Set/sort form
     * cost eight objects per cell (measured: 93ms for a 64x64 streaming window,
     * 40 with the early-outs). */
    const g0 = g(x, y);
    const g1 = g(x + 1, y);
    const g2 = g(x, y + 1);
    const g3 = g(x + 1, y + 1);
    if (!g0 || !g1 || !g2 || !g3) return null;
    if (g0 === g1 && g0 === g2 && g0 === g3) return null;
    const z0 = L(x, y);
    /* THE LEVEL FOLD (see the doc comment): a corner that is not on this cell's
     * plane is not on this tile, so it votes with this cell's own ground. When
     * every corner shares the level this is the identity and nothing changes. */
    /* EVERY CORNER VOTES WITH ITS OWN GROUND, WHATEVER ITS LEVEL (maintainer
     * 2026-09-04: "FIX SO THE TRANSITION WORK ON HIGH GROUND!!").
     *
     * The quad used to FOLD an off-plane corner onto this cell's own ground, on
     * the geometric argument that a corner one storey away has no texel inside
     * this cell's flat 64x46 diamond. That is true, and it cost him the effect
     * he wants: measured over the_game, of the quads that genuinely contain a
     * ground change, 84.0% compose at level 0 but only 45.6% on raised ground —
     * because 60% of raised border quads span a level (level 0: 17%), and the
     * fold collapsed every one of them to a single ground. On a hill the ground
     * change IS the rim, so folding it away removed the transition exactly
     * where he was looking.
     *
     * The raster is still this cell's own: drawn at columnY(z0) and, above
     * level 0, masked to the top face. So what a cross-level quad now does is
     * carry the neighbouring ground's colour into the corner of THIS cell's top
     * surface — the material easing toward the edge, which is what a terrace
     * lip looks like — rather than painting anything into the drop. */
    let gs: (string | null)[] = [g0, g1, g2, g3];
    let folded = false;
    /* A THREE-GROUND JUNCTION STILL GETS A BOUNDARY. Falling back to the pure
     * plate there drew the cell's raw diamond edge — a hard straight segment
     * sitting in the middle of an otherwise organic coastline, which is what he
     * kept marking. The rarest of the three is folded into the majority it
     * already touches, so the tile still blends. Ties go to the ground seen
     * FIRST, which is what Counter.most_common does. */
    if (new Set(gs).size === 3) {
      const order: string[] = [];
      const n = new Map<string, number>();
      for (const v of gs as string[]) {
        if (!n.has(v)) order.push(v);
        n.set(v, (n.get(v) ?? 0) + 1);
      }
      const ranked = order.slice().sort((a, c) => (n.get(c) as number) - (n.get(a) as number));
      const keep = ranked.slice(0, 2);
      const odd = order.find((t) => !keep.includes(t)) as string;
      gs = (gs as string[]).map((t) => (t === odd ? keep[0] : t));
      folded = true;
    }
    const uniq = new Set(gs as string[]);
    if (uniq.size !== 2) return null;
    /* A COAST IS A TRANSITION, NOT A HARD EDGE (maintainer 2026-09-04).
     *
     * This refused any quad a liquid touched, on the rule "a coast is a hard
     * edge, not a blend" — and the shoreline is the most-looked-at ground
     * change in the game, so the rule was the reason he kept reporting that
     * transitions were missing at the water.
     *
     * The WIKI has been composing exactly this the whole time and he has been
     * approving it: its fade-review backdrop calls `transArt(a, b,
     * FADE_PATTERN, idx, ...)` for every cell of the scene with a and b set to
     * the pair under review — water and light_beach included — through the same
     * Wang masks and the same seam, with no liquid case anywhere in
     * `wiki/site/wiki.js`. His words on that picture: "It looks so good in the
     * wiki ... I think the wiki used very good fading masks when building that
     * preview." There is no reason the game should draw the same two grounds
     * differently from the tool he reviews them in.
     *
     * A LIQUID CELL'S BOUNDARY IS TOP FACE ONLY — see the `topOnly` below. That
     * is the one thing the old veto was really protecting: water has no wall,
     * and a full-silhouette raster on a water cell would paint a 1,088-texel
     * wall band into the sea. */
    void uniq;
    const sorted = [...uniq].sort();
    const [sa, sb] = this.sideRoles(sorted[0], sorted[1]);
    const index =
      8 * (gs[0] === sb ? 1 : 0) +
      4 * (gs[1] === sb ? 1 : 0) +
      2 * (gs[2] === sb ? 1 : 0) +
      1 * (gs[3] === sb ? 1 : 0);
    if (index === 0 || index === 15) return null;
    /* EACH HALF ASKS FOR ITS OWN GROUND'S REGION. Asking with the other ground's
     * region drew the neighbour from the wrong set. */
    const pa = this.plateFor(sa, x, y);
    const pb = this.plateFor(sb, x, y);
    return {
      pa,
      pb,
      ownSide: gs[0] === sb ? "b" : "a",
      boundary: {
        x,
        y,
        index,
        a: sa,
        b: sb,
        maskFrame: this.maskFrame(index, x, y, Tiles3.naturalPair(sa, sb)),
        pattern: Tiles3.maskFor(index, x, y, Tiles3.naturalPair(sa, sb)),
        plateA: pa.art,
        plateB: pb.art,
        setA: pa.set.id,
        memberA: pa.memberIndex,
        setB: pb.set.id,
        memberB: pb.memberIndex,
        folded,
        /* TOP FACE ONLY at every raised level, so the cap's own wall survives,
         * AND ON A LIQUID, which has no wall at all — `resolveCell` gives a
         * liquid `dress(..., true)` for the same reason, and a full-silhouette
         * raster here would paint a 1,088-texel wall band into the sea. The
         * raster replaces THIS cell's plate and is pasted at this cell's own
         * column and level, so the cell's own ground and level decide it
         * outright — a quad that spans levels or laps a shore changes nothing
         * here. */
        topOnly: z0 > 0 || view.isLiquid(g0) || undefined,
        sx: columnX(frame, x, y),
        sy: columnY(frame, x, y, z0),
        w: TILE,
        h: PLATE_H,
      },
    };
  }

  /** THE TILE IS THE BOUNDARY (the maintainer's Pair Lab model). His lab reads
   *  the Wang index from the four corners of the tile BEING DRAWN, so every tile
   *  is a Wang tile and 0/15 are the pure field. Drawing a field plate and then
   *  compositing a transition over it made the two fight — the field kept its
   *  hard diamond edge while the transition repainted the whole cell from a
   *  DIFFERENT set member, which is the zigzag seam one cell off the real edge.
   *  The composed tile is drawn INSTEAD of the plate, never over it. */
  private wangSurface(
    view: World3View,
    frame: Frame,
    g: (x: number, y: number) => string | null,
    L: (x: number, y: number) => number,
    gr: string,
    x: number,
    y: number,
    zl: number,
  ): Surface3 {
    const b = this.boundaryAt(view, frame, g, L, x, y);
    if (b) {
      /* `art` names the cell's OWN half of the composed tile, so a draw layer
       * that has not composed the boundary yet paints something coherent under
       * it — and the composed tile's alpha is the full silhouette, so where it
       * does compose, nothing of the half shows. */
      const own = b.ownSide === "b" ? b.pb : b.pa;
      return {
        art: { kind: own.art.kind, path: own.art.path, w: own.art.w, h: own.art.h },
        set: own.set.id,
        memberIndex: own.memberIndex,
        plate: own.art,
        boundary: b.boundary,
      };
    }
    return this.surface(view, g, L, gr, x, y, zl);
  }

  /** THE MAINTAINER'S SURFACE for this cell, AT ANY LEVEL: his base tile set,
   *  graded where the ground rises to itself, eased by a fade near a ground
   *  change, and once in a while one of his details. Until 2026-08-30 this ran
   *  only for level 0 — every raised cell, the whole massif, every terrace, the
   *  town shelf, drew the plain x-over-x review tile and ignored the sets he
   *  tunes. "I kinda expected everything from using the base tile sets." */
  private surface(
    view: World3View,
    g: (x: number, y: number) => string | null,
    L: (x: number, y: number) => number,
    gr: string,
    x: number,
    y: number,
    zl: number,
  ): Surface3 {
    const p = this.plateFor(gr, x, y);
    const out: Surface3 = {
      art: { kind: p.art.kind, path: p.art.path, w: p.art.w, h: p.art.h },
      set: p.set.id,
      memberIndex: p.memberIndex,
      plate: p.art,
    };

    const sidx = this.slopeIndexAt(g, L, gr, x, y, zl);
    if (sidx) {
      const sl = this.slopeTile(gr, sidx, x, y);
      if (sl) {
        out.slope = sl;
        out.art = { kind: "plate", path: sl.file, w: TILE, h: PLATE_H };
      }
    }

    /* THE FADE BAND: a REAL CHEBYSHEV DISTANCE BAND, ring 1 included, AND
     * ELEVATION IS ITS THIRD AXIS. Four axis cells at one ring was not a band,
     * and skipping ring 1 dropped the fade exactly where the drift is
     * strongest — the boundary tile rides the corner lattice ON TOP of this
     * cell, so ring 1 is still ours to dress.
     *
     * THE NEIGHBOUR NEED NOT SHARE THIS CELL'S LEVEL. render3 (and this port
     * until now) required `L(nb) === zl`, so the one place a ground change is
     * most visible — the lip of every terrace, every road shoulder that steps
     * up, every shore that climbs — was the one place that could never fade
     * (maintainer 2026-09-04: "the fade to work between all different ground
     * types and regardless of level/elevation").
     *
     * ELEVATION IS A THIRD AXIS OF THE SAME CHEBYSHEV BAND, at one cell per
     * level: `d = max(|dx|, |dy|, |dz|)`. It is one cell because on screen it
     * very nearly is — the measured stacking pitch is 15 px
     * (`measureStoreyPitch`) against DY = 14 px of vertical travel per cell of
     * Chebyshev distance — so d measures the neighbour's real remoteness in the
     * picture, which is the only thing a fade is about. That is what keeps a
     * grass shelf standing ten storeys over a beach from wearing sand (dz 10 >
     * FADE_BAND, no fade) while the one-storey terrace lip beside it fades
     * exactly like flat ground. Measured on the_game: 21,269 cells have a
     * differing solid ground with a published pool inside Chebyshev 2 at some
     * level; 12,322 have one at their OWN level (all the old rule could see),
     * 13,246 inside the 3D band, and the 8,023 the band still refuses are every
     * one of them three or more storeys away.
     *
     * SAME-LEVEL TERRAIN IS UNTOUCHED, to the cell: dz is 0 there, so d is the
     * old Chebyshev ring, and the square is walked in the order the ascending
     * ring loops walked it (ring r's cells keep their relative order and a
     * nearer candidate always displaces a further one), so the first candidate
     * at the winning distance is the same one. Measured on the_game, 1,852
     * fades -> 2,126: NOT ONE CELL LOST ITS FADE, and only 10 changed which
     * ground they fade toward — every one because a nearer cross-level
     * neighbour displaced a ring-2 same-level one, which is the rule doing its
     * job. 207 of the 2,126 are across a level change. */
    let near: [string, number] | null = null;
    let bestD = FADE_BAND + 1;
    for (let dy = -FADE_BAND; dy <= FADE_BAND; dy++)
      for (let dx = -FADE_BAND; dx <= FADE_BAND; dx++) {
        /* `r >= bestD` is the ascending-ring loop's early-out, kept: d is never
         * below r, and this runs on every cell of every window. */
        const r = Math.max(Math.abs(dx), Math.abs(dy));
        if (r === 0 || r >= bestD) continue;
        const og = g(x + dx, y + dy);
        if (!og || og === gr || view.isLiquid(og)) continue;
        const d = Math.max(r, Math.abs(L(x + dx, y + dy) - zl));
        if (d >= bestD) continue;
        /* THE NEAREST NEIGHBOUR THIS GROUND CAN ACTUALLY FADE TOWARD. The scan
         * used to take the nearest DIFFERING ground and then ask for its pool,
         * so a neighbour the library publishes no approved pair for silently
         * vetoed a further one that has one — no fallback, no fade, no counter.
         * `fadePool` is memoised per (field, other) and the `bestD` early-out
         * cuts the walk, so this is a Map hit on the few candidates that get
         * this far. Measured over the whole of the_game (262,144 cells, median
         * of 5): 474.1 ms against 472.4 ms for the old scan — inside the run
         * spread, and the fix alone is worth 85 more level-0 fades. */
        if (!this.fadePool(gr, og).length) continue;
        bestD = d;
        near = [og, d];
      }
    if (near) {
      const pool = this.fadePool(gr, near[0]);
      if (pool.length) {
        const rr = lcg((x * 73856093) ^ (y * 19349663));
        /* A FADE IS A SCATTERED EVENT, NOT A COAT OF PAINT. Stamping the band
         * solid put ONE tile on up to 1,357 cells — the repetition he ruled out.
         * The probability falls off with distance from the switch. */
        const bandPos = (FADE_BAND + 1 - near[1]) / (FADE_BAND + 1);
        const u = rr();
        /* NO TWO FADES TOUCH EDGE-ON — his own rule, and the lattice he keeps
         * photographing.
         *
         * A fade tile is PURE FIELD GROUND at its rim, with the scatter only in
         * the middle: measured, the perimeter ring of the library top face runs
         * up to 43.5 luma from the interior, and the rim's luma is exactly the
         * field's palette top. One such tile is a warm-up patch and reads as
         * one. TWO SIDE BY SIDE put their dark rims against each other, and a
         * band of them draws a continuous dark line down the diamond edges —
         * which is what he circles. Measured over the_game before this: of
         * 2,182 fade cells, 991 (45.4%) touched another edge-on and 1,410
         * (64.6%) touched one at all.
         *
         * He said it first, to the wiki (2026-08-28): "I also only want to see
         * 1 tile near the center ... The 'fade' tiles are not meant to be
         * repeated like that!"
         *
         * A cell keeps its fade only if its own draw is a STRICT LOCAL MINIMUM
         * among its four edge neighbours. That makes edge-on adjacency
         * impossible rather than unlikely — if A beats B then B cannot beat A —
         * and it is four extra LCG draws, no band scan, and order-independent,
         * so the resolver stays a pure function of the cell. */
        const drawAt = (cx: number, cy: number): number => lcg((cx * 73856093) ^ (cy * 19349663))();
        const lonely =
          u < drawAt(x + 1, y) && u < drawAt(x - 1, y) && u < drawAt(x, y + 1) && u < drawAt(x, y - 1);
        if (lonely && u <= 0.45 * bandPos) {
          /* Sample the WHOLE pool, weighted by his ratings, with the mix strength
           * tracking the distance. */
          const wts = pool.map((t) => (1.0 + 1.6 * t.rating) * (1.0 - Math.abs(t.pct / 60.0 - bandPos)));
          let tot = 0;
          for (const w of wts) if (w > 0) tot += w;
          if (!tot) tot = 1.0;
          const v = rr();
          let acc = v * tot;
          let pick = pool.length - 1;
          for (let i = 0; i < wts.length; i++) {
            acc -= Math.max(0, wts[i]);
            if (acc <= 0) {
              pick = i;
              break;
            }
          }
          const t = pool[Math.max(0, pick)];
          out.fade = { other: near[0], dist: near[1], poolKey: `${gr}|${near[0]}`, index: pick, u, v, file: t.file };
          /* THE FADE IS AN OVERLAY, NOT A REPLACEMENT — and this is the zigzag
           * he kept photographing after the art started shipping.
           *
           * It used to become `out.art`, so the cell drew the fade tile INSTEAD
           * of its own plate. But a fade tile is its FIELD'S FLAT PALETTE COLOUR
           * everywhere the scatter is not: measured over the real arts, 100% of
           * the 124 rim texels are within 10 of the ground's palette top, and
           * 45-54% of the whole 924-texel top face is. So the tile is a flat
           * patch with a bright middle, dropped into a field of TEXTURED member
           * plates — and its rim is a visible diamond outline against them. A
           * band of those outlines is the lattice.
           *
           * Now the cell keeps its own plate and the fade paints only the
           * texels that are NOT the field colour (`fadeOverlay`). The rim is
           * not drawn at all, so it cannot outline anything, and the scatter —
           * which is the entire point of a fade — lands on the real ground
           * exactly as the producer drew it. `cell.fade.file` already carries
           * the path; `cellArtPaths` names it so the loader and the shipped
           * closure both see it. */
          return out;
        }
      }
    }

    /* DETAILS: once in a while, one of his top-approved tops — but NEVER on an
     * indoor floor. A detail is a different tile, so one landing in a room is
     * one plank of the wrong board, and the rule is that a room is laid as ONE.
     * (render3 places no detail anywhere today: its branch is only reachable
     * while the field tile is still flat_tile(), and plate_img took the field
     * over. This keeps details where he asked for them and off the floor.) */
    if (gr === ROOM_FLOOR) return out;
    const dp = this.detailPool(gr);
    if (dp.length) {
      const rate = this.data.detailRates?.[gr] ?? DETAIL_FREQ;
      const rd = lcg((x * 83492791) ^ (y * 2654435761) ^ 0xd47a);
      if (rd() < rate) {
        const index = Math.trunc(rd() * dp.length) % dp.length;
        out.detail = { index, file: dp[index] };
        out.art = { kind: "conform", path: dp[index], w: TILE, h: PLATE_H };
      }
    }
    return out;
  }

  /** side_a / side_b for a pair, canonical via the pattern library's own
   *  side_order. An unknown ground sorts last (99). */
  sideRoles(a: string, b: string): [string, string] {
    const o = this.data.patterns.selection?.side_order ?? [];
    const ia = o.indexOf(a) < 0 ? 99 : o.indexOf(a);
    const ib = o.indexOf(b) < 0 ? 99 : o.indexOf(b);
    return ia <= ib ? [a, b] : [b, a];
  }

  /** THE MASK THIS BOUNDARY CELL WEARS — the maintainer's Pair Lab rule, which
   *  is what makes a road read as a road. Drawing ONE default everywhere is the
   *  reason roads came out as a single repeated squiggle: the library default is
   *  `a18_s4`, which sits in the VERTICAL pool, so every spoke direction wore
   *  the shape he tuned for the vertical one. render3 fixed exactly this
   *  (`mask_for`), and this is that function.
   *
   *  1. The pool is chosen by the DIRECTION the boundary runs ON SCREEN. His
   *     words: "0 deg -> the horizontal spoke; 24 deg -> the four diagonal
   *     spokes (the X); 88 deg -> the vertical spoke. 6 and 9 are saddles, two
   *     curves crossing in one tile, which is the crossing case and goes with
   *     the X."
   *  2. The pools are his, "arrived at by playing with this page".
   *  3. NO FLIPPING, ever: he traced the chevrons of stray dots running through
   *     open ground to mirrored tiles meeting unmirrored neighbours along a seam
   *     neither was drawn for.
   *  4. A ROAD EDGE MAY BE STRAIGHT; A COASTLINE MAY NOT. The pools were tuned
   *     on brown_paving_stone~light_soil — a made road — and two of the X pool's
   *     five masks cut a perfectly straight line. That is a kerb, and it reads
   *     as a ruled facet on a sand/grass edge, so the low-amplitude cuts are
   *     dropped when NEITHER ground is a made surface. */
  private static readonly POOL_OF: Record<number, "horiz" | "vert" | "x"> = {
    1: "horiz", 7: "horiz", 8: "horiz", 14: "horiz",
    2: "vert", 4: "vert", 11: "vert", 13: "vert",
    3: "x", 5: "x", 10: "x", 12: "x", 6: "x", 9: "x",
  };
  private static readonly MASK_POOLS: Record<string, string[]> = {
    x: ["a00_s3", "a00_s5", "a03_s5", "a21_s5", "a30_s1"],
    vert: ["a12_s4", "a18_s4", "a21_s4", "a23_s4"],
    horiz: ["a14_s5", "a15_s2", "a15_s6", "a18_s6", "a21_s2", "a24_s6"],
  };
  /** MADE surfaces, whose edge against nature is allowed to be STRAIGHT — the
   *  `x` pool is ["a00_s3", "a00_s5", "a03_s5", "a21_s5", "a30_s1"] and three of
   *  those five are amplitude <= 0.03, so a made pair draws a flat edge most of
   *  the time on the diagonal Wang indices. A paving stone or a floorboard laid
   *  by hand SHOULD meet the grass on a line.
   *
   *  LIGHT_SOIL IS NOT ONE OF THEM (maintainer 2026-09-04). It is dirt, and he
   *  photographed grass meeting it on a dead-straight edge: "I'M TALKING ABOUT
   *  THE TRANSITION FROM GRASS TO SOIL. WE HAVE NO TRANSITION HERE!" He was
   *  right and the transition WAS drawing — with a straight mask, which is
   *  indistinguishable from no transition at all. Measured over the_game before
   *  this: of the light_soil|grass boundaries sampled, 29 drew `a00_s5`, 28
   *  drew `a00_s3` and 25 drew `a03_s5` — 29% of the pair at amplitude <= 0.03,
   *  while every natural pair beside it (water|light_beach, light_beach|grass,
   *  dark_mud|grass, grey_stone|grass) drew 0.12-0.30 and reads as a blend.
   *
   *  DIVERGES FROM render3, whose MADE_GROUND (render3.py:140) still lists it —
   *  raised with maps2 on their board. */
  private static readonly MADE_GROUND = ["brown_paving_stone", "grey_paving_stone", "parquet_floor"];

  /** Is this pair NATURAL — neither side a made surface? */
  static naturalPair(ga: string, gb: string): boolean {
    return !(Tiles3.MADE_GROUND.includes(ga) || Tiles3.MADE_GROUND.includes(gb));
  }

  /** HIS OWN HASH, bit for bit, so a boundary lands where he saw it in the lab.
   *  Every product is reduced mod 2^32 before the xor because JS coerces xor
   *  operands to SIGNED int32 while Python xors the full integers and masks
   *  after — `>>> 0` on each term is what keeps the two identical. */
  static labHash(r: number, cc: number, k: number, salt = 1): number {
    const m = (a: number, b: number) => (a * b) % 4294967296;
    let h = ((m(r, 73856093) >>> 0) ^ (m(cc, 19349663) >>> 0) ^ (m(k, 83492791) >>> 0) ^ (m(salt, 2654435761) >>> 0)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /** The pattern id this cell's mask comes from. `render3.mask_for`. */
  static maskFor(index: number, x: number, y: number, natural = false): string {
    const full = Tiles3.MASK_POOLS[Tiles3.POOL_OF[index] ?? "horiz"];
    const wob = natural ? full.filter((pid) => Number(pid.slice(1, 3)) >= 12) : full;
    const pool = wob.length ? wob : full;
    return pool[Math.trunc(Tiles3.labHash(y, x, 1) * pool.length) % pool.length];
  }

  /** The frame of tiles/patterns/masks.webp this boundary blends through: the
   *  spoke pool's row for this cell, times the sheet width, plus the Wang index.
   *  Null when the chosen pattern is not published — the caller then draws no
   *  boundary rather than a wrong one. */
  maskFrame(index: number, x = 0, y = 0, natural = false): number | null {
    const id = Tiles3.maskFor(index, x, y, natural);
    const row = this.data.patterns.patterns?.find((p) => p.id === id)?.row;
    if (row === undefined) {
      this.stats.unpublishedMasks++;
      return null;
    }
    return row * (this.data.patterns.masks?.cols ?? 16) + index;
  }

  /** DECKS — roofs, bridges and the cave lid: a slab whose top rides at its own
   *  level with same-over-same wall bands down to its underside, and then WEARS
   *  THE MAINTAINER'S SET like any other ground. A cell whose down-screen
   *  neighbours are both deck is covered, so it needs no face and no thickness. */
  private deckCells(view: World3View, frame: Frame): Tiles3DeckCell[] {
    const out: Tiles3DeckCell[] = [];
    view.decks.forEach((dk, di) => {
      const cells = dk.cells
        .map((c) => [c.x, c.y] as [number, number])
        .sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[1] - b[1]);
      for (const [x, y] of cells) {
        if (x < frame.x0 || x >= frame.x1 || y < frame.y0 || y >= frame.y1) continue;
        out.push(this.deckCell(view, frame, dk, di, x, y));
      }
    });
    return out;
  }

  /** ONE deck cell, resolved. */
  deckCell(view: World3View, frame: Frame, dk: Deck3, di: number, x: number, y: number): Tiles3DeckCell {
    const dg = dk.ground || "grey_stone";
    const dl = Math.trunc(dk.level);
    const th = Math.trunc(dk.thickness ?? 1);
    const set = new Set(dk.cells.map((c) => c.y * view.width + c.x));
    const frontCovered = set.has(y * view.width + x + 1) && set.has((y + 1) * view.width + x);
    /* THE SLAB'S OWN THICKNESS, NOT A FORCED COURSE. `thickness` is "EXTRA face
     * tiles below the top; 0 = the top only" (shared/src/index.ts), and every
     * roof deck the_game ships declares 0 — `Math.max(1, th)` overrode the
     * contract and hung one extra storey under the whole front row. Over a wall
     * cell that course hides behind the wall and reads as the roof's fascia;
     * over a DOORWAY there is no wall under it, so it hung a full storey into
     * the opening and a 5-level door measured 4 (maps2 2026-09-03, from the
     * smithy door at 430,372 under a level-6 roof; render3.py fixed the same
     * line on 2026-08-30 and measures 5.07 levels of clear opening). */
    const lo = frontCovered ? dl : Math.max(0, dl - th);
    /* A cave lid is rock from underneath whatever its top is made of. */
    const body = dk.kind === "cave" && dg !== "black_rock" && dg !== "grey_stone" ? "grey_stone" : dg;
    const cap = frontCovered ? this.flatTile(dg) : this.overTile(dg, body);
    const mid = this.storeyTile(body);
    const stack: WallStackStep[] = [];
    for (let f = lo; f <= dl; f++)
      stack.push({ storey: f, tile: f === dl ? cap : mid, y: columnY(frame, x, y, f) - TOP_Y });
    const p = this.plateFor(dg, x, y);
    return {
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
      surface: p.art,
      surfaceSet: p.set.id,
      surfaceMember: p.memberIndex,
      surfaceY: columnY(frame, x, y, dl),
    };
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
