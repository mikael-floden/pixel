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
 * EVERY NUMBER HERE WAS MEASURED, not guessed, against two failure metrics over
 * 120x16 cells of wall at four world rows (games2/scripts/wall-field.mjs):
 *
 *   colSeam   the most storeys a boundary keeps the SAME x. A long one IS the
 *             "whole column switching" the maintainer forbade.
 *   rowStripe the most cells a boundary keeps the SAME storey — the "per-storey
 *             stripe" he forbade.
 *
 * The shipping numbers, as `npx tsx games2/scripts/wall-field.mjs` prints them:
 * colSeam 5, rowStripe 16, patches averaging 7.0 cells across and 4.5 storeys
 * tall. Compare against the broken shapes below, whose colSeam ran 11-12.
 *
 * MEASURE OVER MANY ROWS, NOT ONE SLAB. Both metrics are worst-cases over a
 * sample, so a four-row sample tunes to one realisation of the noise: this set
 * was first tuned that way, scored colSeam 4, and scored 9 the moment the hash
 * changed underneath it. Twelve rows is what made the ranking stable. Three earlier shapes are recorded here as
 * one-liners because each looked obviously right and measured wrong:
 *   - Axis-aligned chunks, warp 2.6 against a 5.5-cell region: colSeam 12. Half
 *     a region of warp is not enough to bend a boundary off its plane; the wall
 *     switched by column, exactly the reported bug in a new costume.
 *   - Warp raised to the region size, no shear: colSeam still 11-12. A warp only
 *     wobbles a plane, it does not tilt one.
 *   - Shear in x and y only: colSeam fell to 4 but rowStripe hit 27-45, because
 *     the z-slabs were still horizontal. All three axes have to be sheared or
 *     one of the two forbidden seams survives.
 */

/** Region size in CELLS. Patches come out smaller than this (the warp cuts them
 *  up) — 14 measures to ~7.0 cells across. */
export const WALL_REGION_CELLS = 14;
/** What one STOREY is worth in cells. Sets how fast the field climbs. */
export const WALL_REGION_STOREY = 0.8;
/** How far the point is dragged before it is chunked, in cells. Comparable to
 *  the region size ON PURPOSE — at half of it the boundaries stay planar. */
export const WALL_WARP_CELLS = 11;
/** Base period of the warp noise, in cells. */
export const WALL_WARP_PERIOD = 29;
/** Octaves of warp noise and their amplitude falloff. THREE, not four: four
 *  measured worse on BOTH seams (colSeam 5, rowStripe 10 against 4 and 7) as
 *  well as costing a third more hashing, because the extra high-frequency
 *  wobble can park a boundary back on one column by accident. */
export const WALL_WARP_OCTAVES = 3;
export const WALL_WARP_PERSISTENCE = 0.65;

/* THE SHEAR — the thing that makes a boundary a diagonal instead of a plane.
 * Applied BEFORE the warp, so the lattice itself is tilted and the warp then
 * breaks the tilt up. Without it every boundary is a screen-axis line; with it
 * alone every boundary is a perfectly ruled diagonal at one slope, which reads
 * as drawn-with-a-ruler. Both are needed. */
/** Elevation into x and y: a boundary moves ~0.88 cells sideways per storey. */
export const WALL_SHEAR_Z = 1.1;
/** x into y and y into x, so a face along x and a face along y behave alike. */
export const WALL_SHEAR_XY = 0.45;
/** (x - y) into elevation: what tilts the horizontal slabs off the storey grid.
 *  Symmetric in the two wall directions by construction. */
export const WALL_SHEAR_ZX = 0.55;

/** Macro-region size in CELLS — one palette per massif. Wider than a typical
 *  mountain so a single cliff does not change stone family halfway up. */
export const WALL_PALETTE_CELLS = 44;
/** Tiles in a synthetic palette. Two reads as a checker, four as a quilt. */
export const WALL_PALETTE_N = 3;
/** Their weights: dominant, secondary, vein. 60/30/10 — the dominant tile IS
 *  the rock face, and the last one is the seam you notice. */
export const WALL_PALETTE_WEIGHTS: readonly number[] = [6, 3, 1];

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

/** Seeds for the three warp axes. Different seeds, identical coordinates — a
 *  coordinate offset would decorrelate them too, but only these survive a port
 *  unambiguously. */
const WARP_SEED_X = 0x5741_4c31; // "WAL1"
const WARP_SEED_Y = 0x5741_4c32;
const WARP_SEED_Z = 0x5741_4c33;

/** Fractal value noise: WALL_WARP_OCTAVES of vnoise3, each at twice the
 *  frequency and WALL_WARP_PERSISTENCE of the amplitude, normalised back to
 *  [0,1). One octave gives a warp that bends but does not wander. */
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
  /** The micro-region id — what picks the tile. */
  micro: string;
  /** The macro-region id — what picks the palette. */
  macro: string;
}

/** SHEAR, THEN WARP, THEN CHUNK — twice, at two scales.
 *
 *  `z` is the STOREY index, so the field is keyed on world position and
 *  elevation together and a patch boundary cuts across x, y and height. That is
 *  what the maps agent asked for, and it is also the only way to be safe from
 *  both forbidden seams at once: the shear tilts every lattice plane off both
 *  screen axes, and the warp stops the tilted planes from reading as ruled
 *  lines. Take either away and one of the two comes back — measured, see the
 *  tuning block. */
export function wallField(x: number, y: number, z: number): WallField {
  const zc = z * WALL_REGION_STOREY;
  const u = x + WALL_SHEAR_Z * zc + WALL_SHEAR_XY * y;
  const v = y + WALL_SHEAR_Z * zc + WALL_SHEAR_XY * x;
  const w = zc + WALL_SHEAR_ZX * (x - y);
  const p = 1 / WALL_WARP_PERIOD;
  const nx = x * p;
  const ny = y * p;
  const nz = zc * p;
  const wx = u + WALL_WARP_CELLS * (fbm3(nx, ny, nz, WARP_SEED_X) * 2 - 1);
  const wy = v + WALL_WARP_CELLS * (fbm3(nx, ny, nz, WARP_SEED_Y) * 2 - 1);
  const wz = w + WALL_WARP_CELLS * (fbm3(nx, ny, nz, WARP_SEED_Z) * 2 - 1);
  return {
    micro: `${Math.floor(wx / WALL_REGION_CELLS)},${Math.floor(wy / WALL_REGION_CELLS)},${Math.floor(wz / WALL_REGION_CELLS)}`,
    macro: `${Math.floor(wx / WALL_PALETTE_CELLS)},${Math.floor(wy / WALL_PALETTE_CELLS)},${Math.floor(wz / WALL_PALETTE_CELLS)}`,
  };
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
  const pal = wallPalette(pool, f.macro, keys, sigs);
  if (!pal.length) return -1;
  const w = WALL_PALETTE_WEIGHTS.slice(0, pal.length);
  const i = pickWeighted(w, unitHashStr(`wr1|tile|${pool}|${f.micro}`));
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
  field: [number, number, number, string, string][];
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
    [0,0,0,"-1,0,-1","-1,0,-1"],
    [1,0,0,"0,0,-1","0,0,-1"],
    [0,0,1,"-1,0,-1","-1,0,-1"],
    [37,214,5,"9,16,-7","3,5,-3"],
    [120,15,11,"9,5,4","3,1,1"],
    [393,393,40,"43,43,2","13,13,0"],
  ],
  palette: [
    ["grey_stone__over__grey_stone","0,0,0",74,[56,16,72]],
    ["grey_stone__over__grey_stone","1,-2,0",74,[17,32,24]],
    ["a__over__b","0,0,0",2,[1,0]],
    ["a__over__b","0,0,0",1,[0]],
  ],
  pick: [
    ["grey_stone__over__grey_stone",74,0,0,0,49],
    ["grey_stone__over__grey_stone",74,37,214,5,71],
    ["grey_stone__over__grey_stone",74,38,214,5,71],
    ["grey_stone__over__grey_stone",74,37,214,6,71],
    ["one__over__one",1,5,5,5,0],
    ["none__over__none",0,1,2,3,-1],
  ],
};
