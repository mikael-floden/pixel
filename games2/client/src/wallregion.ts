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

/** Region size in CELLS — one palette per area.
 *
 *  NOT the ground's 24, and the reason is the surface's shape rather than taste.
 *  A wall face is at most 40 storeys, and 40 * WALL_STOREY_CELLS is 17.2 cell
 *  steps, so a 24-cell region is TALLER THAN THE TALLEST CLIFF IN THE WORLD:
 *  the palette could then only ever change sideways, which is a vertical
 *  boundary, which is the column-shaped result this rule exists to avoid — the
 *  ground's number reintroducing the ground's blind spot on a surface with a
 *  short axis. At 10 a tall face crosses one or two regions going up, and the
 *  median 4-storey wall still sits comfortably inside one, which is right: a
 *  low wall should be one stone. */
export const WALL_REGION_CELLS = 10;
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

/** A tile's look, as `wall-signatures.py` measures it: mean luminance 0-255,
 *  contrast 0-99, and a directional term -100..100 (positive = horizontal
 *  layering, negative = vertical cracking). */
export type WallSig = readonly [number, number, number];
/** One pool's signatures, by the candidate key's last path segment. */
export type WallSigs = Readonly<Record<string, WallSig>>;

/** HOW DIFFERENT TWO WALL TILES LOOK, normalised so the terms are comparable.
 *
 *  Luminance is weighted hardest because a bright tile abutting a dark one is
 *  the seam you see from across the map; the directional term is next, because
 *  it is what separates a layered face from a cracked one and those two read as
 *  different ROCK, not as one rock in two moods. Measured over the approved
 *  grey_stone pool the ranges are lum 80.6-119.2, contrast 30.2-44.4 and
 *  direction -0.48..+0.35, so contrast is genuinely the least informative of
 *  the three and is weighted accordingly. */
export function sigDistance(a: WallSig, b: WallSig): number {
  const dl = (a[0] - b[0]) / 255;
  const dc = (a[1] - b[1]) / 99;
  const da = (a[2] - b[2]) / 200;
  return Math.sqrt(1.0 * dl * dl + 0.35 * dc * dc + 0.8 * da * da);
}

/** How many nearest neighbours the palette may draw its minority tiles from.
 *  Small enough that they match the dominant, large enough that two massifs
 *  with the same dominant still differ. */
export const WALL_PALETTE_NEIGHBOURS = 8;

/** THE PALETTE FOR ONE MASSIF — the dominant stone plus tiles that LOOK LIKE
 *  IT. Entry 0 is the dominant.
 *
 *  Approval is not compatibility. The maintainer approved 74 grey_stone walls,
 *  meaning each is good art, not that any two belong side by side — composited,
 *  their mean luminance spans 80.6 to 119.2 and one of them is horizontally
 *  layered where the rest are vertically cracked, so an arbitrary pair abutting
 *  makes a hard seam down the cliff. That IS the "random" look the rule exists
 *  to avoid, so the palette is drawn from a NEIGHBOURHOOD in signature space:
 *  a dominant chosen freely, then its nearest look-alikes.
 *
 *  WITHOUT SIGNATURES it falls back to a free draw over the whole pool. That is
 *  the honest degradation — variety with no coherence guarantee — and it is what
 *  a pool the generator has never seen gets, rather than no variety at all.
 *
 *  Drawn WITHOUT REPLACEMENT either way: a repeat would silently merge two
 *  weights, so the 10% vein would vanish on some massifs and the rule would
 *  look like it had failed intermittently.
 *
 *  This whole function is the stand-in for a hand-made wall base set. When the
 *  tiles agent ships one, its members and weights replace this and nothing else
 *  in the file changes. */
export function wallPalette(pool: string, macro: string, keys: readonly string[], sigs?: WallSigs): number[] {
  const n = keys.length;
  const k = Math.min(WALL_PALETTE_N, n);
  if (n <= 0) return [];
  const draw = (from: number[], salt: string, want: number): number[] => {
    const bag = from.slice();
    const out: number[] = [];
    for (let d = 0; d < want && d < bag.length; d++) {
      const rest = bag.length - d;
      let j = d + Math.floor(unitHashStr(`wr1|pal|${pool}|${macro}|${salt}|${d}`) * rest);
      if (j >= bag.length) j = bag.length - 1; // float crumb at the top
      const t = bag[d];
      bag[d] = bag[j];
      bag[j] = t;
      out.push(bag[d]);
    }
    return out;
  };
  const all = [];
  for (let i = 0; i < n; i++) all.push(i);
  const dom = draw(all, "dom", 1)[0];
  if (k === 1) return [dom];
  const ds = sigs?.[keys[dom]];
  if (!ds) return draw(all, "free", k);
  // The nearest look-alikes to the dominant, then a free draw among them.
  const near = all
    .filter((i) => i !== dom && sigs[keys[i]])
    .map((i) => ({ i, d: sigDistance(ds, sigs[keys[i]]) }))
    .sort((a, b) => (a.d === b.d ? a.i - b.i : a.d - b.d))
    .slice(0, WALL_PALETTE_NEIGHBOURS)
    .map((e) => e.i);
  if (near.length < k - 1) return draw(all, "free", k);
  return [dom, ...draw(near, "near", k - 1)];
}

/** WHICH APPROVED TILE PAINTS THIS CELL — the whole rule, in one call.
 *
 *  `pool` names the candidate list (with a marker when the storey filter has
 *  removed `top_only` tiles) so two different pools cannot share a palette
 *  draw. `keys` is the pool's candidate keys, in order; the return is an index
 *  into it, or -1 when it is empty.
 *
 *  A one-candidate pool returns 0 for every cell, which is the old behaviour
 *  and is correct: with one tile there is nothing to vary. */
export function pickWallIndex(
  pool: string,
  keys: readonly string[],
  x: number,
  y: number,
  z: number,
  /** A precomputed `wallField(x, y, z)`. The caller passes one when it is
   *  memoising; omitted, it is computed here. Passing a field for a DIFFERENT
   *  cell would silently paint the wrong tile, so a caller passes the one it
   *  just looked up under the same key and nothing else. */
  field?: WallField,
  sigs?: WallSigs,
): number {
  const n = keys.length;
  if (n <= 0) return -1;
  if (n === 1) return 0;
  const f = field ?? wallField(x, y, z);
  const pal = wallPalette(pool, f.region, keys, sigs);
  if (!pal.length) return -1;
  /* THE MEMBER IS PER CELL, exactly as the ground's is — not per region. A
   * constant tile over a region is a patch, a patch has edges, and edges on a
   * wall are either column seams or storey stripes; there is no third option,
   * which is why the first version of this file spent all its effort shaping
   * them. Varying per cell removes the edge instead of steering it, and it is
   * what makes a ground region boundary invisible today. The palette changes
   * slowly underneath, which is where "a path of different stone running
   * through a cliff" actually lives. */
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
    [37,214,5,"3,21,0"],
    [120,15,11,"12,1,0"],
    [393,393,40,"39,39,1"],
  ],
  palette: [
    ["grey_stone__over__grey_stone","0,0,0",74,[56,16,72]],
    ["grey_stone__over__grey_stone","1,-2,0",74,[17,32,24]],
    ["a__over__b","0,0,0",2,[1,0]],
    ["a__over__b","0,0,0",1,[0]],
  ],
  pick: [
    ["grey_stone__over__grey_stone",74,0,0,0,49],
    ["grey_stone__over__grey_stone",74,37,214,5,53],
    ["grey_stone__over__grey_stone",74,38,214,5,5],
    ["grey_stone__over__grey_stone",74,37,214,6,5],
    ["one__over__one",1,5,5,5,0],
    ["none__over__none",0,1,2,3,-1],
  ],
};
