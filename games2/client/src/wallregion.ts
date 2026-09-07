/** THE WALL REGION FIELD — which of the maintainer's approved wall tiles paints
 *  a given cell of a cliff, and where the tile is allowed to change.
 *
 * THE BUG THIS REPLACES: `approvedCandidate` returned `cands[0]` and `overTile`
 * cached per (top, side), so all 74 approved `grey_stone__over__grey_stone`
 * tiles rendered as ONE. Every mountain in the world wore the same face and the
 * maps agent's verdict was exact: "the mountain reads as wallpaper".
 *
 * WHAT IT MUST NOT BECOME (maintainer, and the whole point): "DON'T MAKE IT
 * FEEL RANDOM. Organic is the key word here." Three specific failures are named
 * and this rule is shaped to make each of them impossible:
 *
 *   - PER-CELL RANDOM is a quilt. The tile is chosen per REGION, so a patch is
 *     many cells across and a wall reads as one rock face.
 *   - A WHOLE COLUMN SWITCHING is what an axis-aligned chunk grid gives you:
 *     its boundaries are planes of constant x or y, which on an iso screen are
 *     exactly a column seam. The sample point is DOMAIN-WARPED before it is
 *     chunked, so no boundary is a plane and none is vertical.
 *   - A PER-STOREY STRIPE is what you get if elevation dominates the field. One
 *     storey is worth WALL_REGION_STOREY cells, so a region spans ~7 storeys —
 *     taller than most cliffs — and the boundary crosses height slowly.
 *
 * The shape is the GROUND'S, which is what the maps agent asked for ("set per
 * region, member per cell, my weights"), one scale up because a wall has no
 * sets yet:
 *
 *   PALETTE per macro-region  — WALL_PALETTE_N tiles drawn from the approved
 *                               pool, so one massif wears one family of stone
 *                               and the next massif can wear another. This is
 *                               the slot a real "wall base set" drops into when
 *                               the tiles agent builds one; delete the synthetic
 *                               palette then, keep everything else.
 *   TILE per micro-region     — one of the palette, weighted so the first is
 *                               dominant. That is what makes a minority tile
 *                               read as "a path of different stone running
 *                               diagonally through a cliff" rather than as
 *                               half the mountain.
 *
 * BOTH SCALES COME FROM ONE WARPED POINT, so the second costs nothing.
 *
 * PORTABILITY IS THE POINT. render3.py and the wiki must resolve the same tile
 * for the same cell or the game, the preview and the wiki disagree about what
 * the world looks like — the exact class of bug `basesets.mjs` TEST_VECTORS
 * exist to prevent. Everything here is integer hashing plus double arithmetic:
 * no transcendentals, no Math.random, no iteration order dependence. Port it and
 * check it against WALL_TEST_VECTORS at the bottom.
 */

/* -- tuning ------------------------------------------------------------------
 * THE WALL IS A SURFACE, NOT A GRID OF COLUMNS (maintainer 2026-09-07: "I feel
 * you are thinking too much in columns ... think the wall is tilted 90 degrees
 * (becomes floor). Of course you don't think on columns when it comes to
 * today's ground"). Every number below follows from that, and the first version
 * of this file got both of the following wrong by reasoning in storeys and
 * columns instead of in the surface they make.
 *
 * 1. THE STOREY SCALE IS MEASURED GEOMETRY, NOT A DIAL. A storey is 15px tall
 *    (ISO_GEOMETRY_MAPS3.lh) and one cell step along a wall face is
 *    sqrt(32^2 + 14^2) = 34.9px, so a storey is 0.429 of a step. Anything else
 *    stretches the field on the face: the first cut used 0.8, nearly twice too
 *    tall, which is exactly what made patches read as column-shaped and made a
 *    shear necessary to fight the symptom. At the true ratio a patch is round
 *    on the wall and no axis needs defending.
 * 2. WALLS ARE MUCH TALLER THAN THEY LOOK IN A TEST. Measured over the_game's
 *    4,551 exposed wall cells: median 4 storeys, p90 14, p99 36, max 40 — a
 *    600px face, 17.2 cell-steps tall. The first metrics ran on a 16-storey
 *    slab and so never saw a mountain at all.
 *
 * The structure is then THE GROUND'S, because that is the thing the maintainer
 * pointed at and it is already right: a SET per REGION keeps an area coherent,
 * a MEMBER per CELL varies the field, and his weights decide the mix. On a wall
 * the set is the palette and the member is the tile. Per-cell members are what
 * make a region boundary invisible on the ground, and they do the same here —
 * which is why this file no longer has, or needs, a shear, a micro-region, or a
 * "colSeam" metric. There is no constant-tile patch left to have a shape.
 */

/** WHAT ONE STOREY IS WORTH IN CELL STEPS. Measured, not tuned: 15px of storey
 *  against a 34.9px cell step along a face. Changing it stretches the field on
 *  the wall — raise it and patches elongate vertically until they read as
 *  columns, lower it and they band by storey. */
export const WALL_STOREY_CELLS = 0.429;

/** Region size in CELLS — ONE SET PER MASSIF, deliberately much larger than a
 *  cliff rather than smaller.
 *
 *  The set's three tiles are gated against each other, but two ADJACENT SETS
 *  are not: nothing measures the join between a tile of set A and a tile of set
 *  B, so a region boundary is the one place a bad seam can still appear. Making
 *  regions big makes that boundary rare and puts it between massifs, where a
 *  change of rock is the point — rather than every ~10 cells across the face of
 *  one, which is where it showed as a mismatched strip. All the variety inside
 *  a cliff comes from the per-cell member, which is gated.
 *
 *  Earlier this was 10, chosen so the set could change going UP a tall face.
 *  That was the column-thinking surviving one more round: a cliff wants ONE
 *  rock, and a set changing partway up it is the seam, not the feature. */
export const WALL_REGION_CELLS = 40;
/** How far the point is dragged before it is chunked, in cells. The ground does
 *  not warp at all — it does not need to, because a region boundary there is
 *  invisible under the per-cell members. A wall changes its whole palette at
 *  one, which is a bigger jump, so it is bent into something organic rather
 *  than left as a plane. */
export const WALL_WARP_CELLS = 9;
/** Base period of the warp noise, in cells. */
export const WALL_WARP_PERIOD = 31;
/** Octaves of warp noise and their amplitude falloff. */
export const WALL_WARP_OCTAVES = 3;
export const WALL_WARP_PERSISTENCE = 0.65;

/** Tiles in a synthetic palette. Two reads as a checker, four as a quilt. */
export const WALL_PALETTE_N = 3;
/** Their weights, per CELL: dominant, secondary, accent. The dominant IS the
 *  rock; the other two are the grain in it. */
export const WALL_PALETTE_WEIGHTS: readonly number[] = [12, 4, 1];

/* -- hashing ---------------------------------------------------------------- */

const U32 = 4294967296;

/** A 32-bit avalanche of three integer lattice coordinates and a seed. NOT the
 *  string FNV-1a the base-tile pick uses: this runs per storey per wall cell on
 *  every ground repaint, and building a key string there would put allocation
 *  in the middle of the frame this repo is currently trying to shorten.
 *  Inputs are taken modulo 2^32, so a warped coordinate that lands just below
 *  zero hashes the same in both languages (JS `|0` then `>>>0`, Python
 *  `& 0xffffffff`). */
export function hash3(i: number, j: number, k: number, seed: number): number {
  /* MULTIPLY-ADD, THEN AVALANCHE. The obvious `h = imul(h ^ coord, PRIME)` per
   * axis is what this used to be and it is broken: when the xor comes out zero
   * the multiply pins the state at zero and BOTH the seed and that coordinate
   * are gone. `hash3(1, 0, 0, 1)` returned exactly 0, and so did every other
   * (i === seed) pair — a whole family of collisions inside the noise, which
   * would have shown up as identically-patterned patches scattered across the
   * world with no way to guess why. Caught by reading the generated vectors. */
  let h = (seed | 0) >>> 0;
  h = (h + Math.imul(i | 0, 0x8da6b343)) >>> 0;
  h = (h + Math.imul(j | 0, 0xd8163841)) >>> 0;
  h = (h + Math.imul(k | 0, 0xcb1ab31f)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Trilinear value noise in [0,1). Smoothstep on each axis, so the field is
 *  continuous and its gradient is continuous — a warp built on a discontinuous
 *  field would tear the region boundary into steps, which is the grid look
 *  again by another route. */
export function vnoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const c = (di: number, dj: number, dk: number) => hash3(xi + di, yi + dj, zi + dk, seed) / U32;
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * u;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * u;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * u;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

/* -- the field -------------------------------------------------------------- */

/** Seeds for the three warp axes. */
const WARP_SEED_X = 0x5741_4c31; // "WAL1"
const WARP_SEED_Y = 0x5741_4c32;
const WARP_SEED_Z = 0x5741_4c33;

/** Fractal value noise: WALL_WARP_OCTAVES of vnoise3, each at twice the
 *  frequency and WALL_WARP_PERSISTENCE of the amplitude, normalised back to
 *  [0,1). One octave bends a boundary; three make it wander. */
export function fbm3(x: number, y: number, z: number, seed: number): number {
  let acc = 0;
  let amp = 1;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < WALL_WARP_OCTAVES; o++) {
    acc += amp * vnoise3(x * f, y * f, z * f, seed + o * 7919);
    norm += amp;
    amp *= WALL_WARP_PERSISTENCE;
    f *= 2;
  }
  return acc / norm;
}

export interface WallField {
  /** The region id — what picks the palette. */
  region: string;
}

/** THE REGION A CELL BELONGS TO — warp the point, then chunk it, ALL THREE AXES
 *  IN THE SAME UNITS.
 *
 *  Elevation enters as `z * WALL_STOREY_CELLS`, which is the measured ratio of
 *  a storey to a cell step, so the field is isotropic in what the eye actually
 *  sees. A region is therefore a ball in world space, and a ball cut by a wall
 *  face — in any direction, without this function knowing which way the face
 *  runs — is a round patch on that face. That is the whole reason there is no
 *  shear here any more: nothing is stretched, so no axis needs defending. */
export function wallField(x: number, y: number, z: number): WallField {
  const zc = z * WALL_STOREY_CELLS;
  const p = 1 / WALL_WARP_PERIOD;
  const nx = x * p;
  const ny = y * p;
  const nz = zc * p;
  const wx = x + WALL_WARP_CELLS * (fbm3(nx, ny, nz, WARP_SEED_X) * 2 - 1);
  const wy = y + WALL_WARP_CELLS * (fbm3(nx, ny, nz, WARP_SEED_Y) * 2 - 1);
  const wz = zc + WALL_WARP_CELLS * (fbm3(nx, ny, nz, WARP_SEED_Z) * 2 - 1);
  const R = WALL_REGION_CELLS;
  return { region: `${Math.floor(wx / R)},${Math.floor(wy / R)},${Math.floor(wz / R)}` };
}

/* -- the pick --------------------------------------------------------------- */

/** Weighted pick over non-negative weights given u in [0,1). The same rule and
 *  the same edge cases as tiles3's `pickWeighted`, restated here so this module
 *  is a standalone port target with nothing to import. */
function pickWeighted(weights: readonly number[], u: number): number {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (!(total > 0)) return -1;
  let acc = 0;
  const target = u * total;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i] > 0 ? weights[i] : 0;
    if (target < acc) return i;
  }
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}

/** A unit float from a string, FNV-1a/32 + fmix32 — the base-tile pick's hash,
 *  used here for the two picks whose key is a NAME (pool identity, region id)
 *  rather than a lattice point. */
export function unitHashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / U32;
}

/** One measured set from `wallsets.json`: tiles that JOIN well, and how badly
 *  the worst join in the set shows. */
export interface WallSet {
  cost: number;
  tiles: readonly string[];
}

/** THE GATE. A set is only used when its worst join is at most this many times
 *  the art's OWN texture step — i.e. the seam is no more visible than the
 *  cracks already in the stone.
 *
 *  It exists because for most pools NO good trio exists: measured over all 199
 *  pools with three or more approved walls, the best set's cost is 0.75 at the
 *  bottom and 11.97 at the top, median 3.52. At 2.0 exactly 40 pools qualify —
 *  including the ones a mountain is made of, grey_stone and black_rock — and
 *  the other 159 fall back to ONE tile, which is the old behaviour and is the
 *  right answer for them: no variety beats a visible seam, and the maintainer
 *  should not have to police that by eye. Raise it only against a picture. */
export const WALL_SET_MAX_COST = 2.0;

/** THE PALETTE FOR ONE REGION — one measured SET, mapped onto this pool's
 *  candidate list. Entry 0 is the dominant.
 *
 *  WHAT THIS REPLACED, AND WHY. The first version scored each tile with a
 *  global signature — mean luminance, contrast, directional energy — and drew
 *  look-alikes. It was taste dressed as measurement and it is measurably
 *  worthless for the job: across the 5,402 ordered pairs of approved
 *  grey_stone walls that signature's distance correlates with the real seam
 *  cost at +0.105, and the 200 pairs it called most similar had a median seam
 *  of 2.09 against a pool median of 1.91 — it picked slightly WORSE than
 *  chance. A global descriptor cannot see a join. The maintainer caught it in a
 *  render before the numbers did: "in the image you sent me I can already tell
 *  you the bottom center tiles look misplaced."
 *
 *  Sets now come from wall-sets.py, which composites every ordered pair exactly
 *  as the game stacks them and measures the luminance step across the join
 *  against the step the tiles show inside themselves. A tile's join WITH ITSELF
 *  is in the score, because the dominant repeats against itself far more often
 *  than against anything else.
 *
 *  Returns a single index when no set clears the gate — no variety, no seam. */
export function wallPalette(
  pool: string,
  region: string,
  keys: readonly string[],
  sets?: readonly WallSet[],
): number[] {
  const n = keys.length;
  if (n <= 0) return [];
  const usable: number[][] = [];
  for (const set of sets ?? []) {
    if (set.cost > WALL_SET_MAX_COST) continue;
    const idx: number[] = [];
    for (const t of set.tiles) {
      const at = keys.indexOf(t);
      if (at >= 0) idx.push(at);
    }
    // A set whose tiles are not all in THIS pool is not this pool's set — the
    // storey filter can remove one, and a partial set is a different set.
    if (idx.length === set.tiles.length && idx.length > 1) usable.push(idx);
  }
  if (!usable.length) return [0]; // the old behaviour, deliberately
  const pick = Math.floor(unitHashStr(`wr1|set|${pool}|${region}`) * usable.length);
  return usable[Math.min(pick, usable.length - 1)];
}

/** WHICH APPROVED TILE PAINTS THIS CELL — the whole rule, in one call. */
export function pickWallIndex(
  pool: string,
  keys: readonly string[],
  x: number,
  y: number,
  z: number,
  /** A precomputed `wallField(x, y, z)`, when the caller is memoising. */
  field?: WallField,
  sets?: readonly WallSet[],
): number {
  const n = keys.length;
  if (n <= 0) return -1;
  if (n === 1) return 0;
  const f = field ?? wallField(x, y, z);
  const pal = wallPalette(pool, f.region, keys, sets);
  if (pal.length <= 1) return pal[0] ?? 0;
  /* THE MEMBER IS PER CELL, exactly as the ground's is — not per region. A
   * constant tile over a region is a patch, a patch has edges, and an edge on a
   * wall is either a column seam or a storey stripe; there is no third option.
   * Varying per cell removes the edge instead of steering it, and it is what
   * makes a ground region boundary invisible today. */
  const w = WALL_PALETTE_WEIGHTS.slice(0, pal.length);
  const i = pickWeighted(w, unitHashStr(`wr1|tile|${pool}|${x}|${y}|${z}`));
  return pal[i >= 0 ? i : 0];
}

/* -- test vectors ----------------------------------------------------------- */

/** PROVE A PORT WITHOUT READING THIS FILE. render3.py and the wiki must
 *  reproduce every line or the game, the preview and the wiki will disagree
 *  about which stone a cell wears — the same class of bug basesets.mjs's
 *  TEST_VECTORS exist to prevent, and the reason the maps agent asked for
 *  vectors in the first place. Regenerate with games2/scripts/wall-vectors.mjs. */
export const WALL_TEST_VECTORS: {
  hash3: [number, number, number, number, number][];
  vnoise3: [number, number, number, number, number][];
  fbm3: [number, number, number, number, number][];
  field: [number, number, number, string][];
  palette: [string, string, number, number[]][];
  pick: [string, number, number, number, number, number][];
} = {
  hash3: [
    [0,0,0,1,1364076727],
    [1,0,0,1,609303115],
    [0,1,0,1,4222228470],
    [0,0,1,1,1194506052],
    [-1,-1,-1,1,2314441001],
    [123,456,7,1463897137,3666960045],
    [4294967295,0,0,7,391211354],
  ],
  vnoise3: [
    [0,0,0,1,0.317599],
    [0.5,0.5,0.5,1,0.458244],
    [1.25,-2.75,3.5,1,0.527028],
    [10.1,20.2,30.3,1463897139,0.267224],
  ],
  fbm3: [
    [0,0,0,1,0.479412],
    [0.5,0.5,0.5,1,0.493022],
    [1.25,-2.75,3.5,1463897138,0.543485],
  ],
  field: [
    [0,0,0,"-1,0,-1"],
    [1,0,0,"0,0,-1"],
    [0,0,1,"-1,0,-1"],
    [37,214,5,"0,5,0"],
    [120,15,11,"3,0,0"],
    [393,393,40,"9,9,0"],
  ],
  palette: [
    ["grey_stone__over__grey_stone","0,0,0",74,[3,7,11]],
    ["grey_stone__over__grey_stone","1,-2,0",74,[2,5,9]],
    ["a__over__b","0,0,0",2,[0]],
    ["a__over__b","0,0,0",1,[0]],
  ],
  pick: [
    ["grey_stone__over__grey_stone",74,0,0,0,3],
    ["grey_stone__over__grey_stone",74,37,214,5,7],
    ["grey_stone__over__grey_stone",74,38,214,5,3],
    ["grey_stone__over__grey_stone",74,37,214,6,3],
    ["one__over__one",1,5,5,5,0],
    ["none__over__none",0,1,2,3,-1],
  ],
};
