// THE WALL REGION FIELD. Walls used to draw ONE tile for the whole world —
// `approvedCandidate` returned cands[0] and `overTile` cached per (top, side),
// so all 74 approved grey_stone__over__grey_stone tiles rendered as one and, in
// the maps agent's words, "the mountain reads as wallpaper".
//
// The replacement has one hard constraint from the maintainer: "DON'T MAKE IT
// FEEL RANDOM. Organic is the key word here." He named the two ways it goes
// wrong, and both are geometric, so both are testable rather than a matter of
// taste. These tests are the difference between a rule that looks right in one
// screenshot and one that is right everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WALL_TEST_VECTORS,
  WALL_PALETTE_N,
  WALL_PALETTE_WEIGHTS,
  WALL_REGION_CELLS,
  WALL_STOREY_CELLS,
  hash3,
  vnoise3,
  fbm3,
  wallField,
  wallPalette,
  pickWallIndex,
} from "../../client/src/wallregion";

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
/** A pool of `n` unsignatured candidates — the free-draw path. */
const keysOf = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
/** Two sets that clear the gate and one that does not — the shape wallsets.json
 *  ships, with the gate exercised. */
const SETS = [
  { cost: 0.9, tiles: ["k3", "k7", "k11"] },
  { cost: 1.8, tiles: ["k2", "k5", "k9"] },
  { cost: 9, tiles: ["k0", "k1", "k4"] },
];

test("the published TEST_VECTORS reproduce — this is what a port is checked against", () => {
  for (const [i, j, k, s, want] of WALL_TEST_VECTORS.hash3) assert.equal(hash3(i, j, k, s), want, `hash3(${i},${j},${k},${s})`);
  for (const [x, y, z, s, want] of WALL_TEST_VECTORS.vnoise3) assert.equal(r6(vnoise3(x, y, z, s)), want, `vnoise3(${x},${y},${z})`);
  for (const [x, y, z, s, want] of WALL_TEST_VECTORS.fbm3) assert.equal(r6(fbm3(x, y, z, s)), want, `fbm3(${x},${y},${z})`);
  for (const [x, y, z, region] of WALL_TEST_VECTORS.field)
    assert.equal(wallField(x, y, z).region, region, `field(${x},${y},${z})`);
  for (const [pool, region, n, want] of WALL_TEST_VECTORS.palette)
    assert.deepEqual(wallPalette(pool, region, keysOf(n), SETS), want, `palette(${pool},${region},${n})`);
  for (const [pool, n, x, y, z, want] of WALL_TEST_VECTORS.pick)
    assert.equal(pickWallIndex(pool, keysOf(n), x, y, z, undefined, SETS), want, `pick(${pool},${n},${x},${y},${z})`);
});

test("hash3 does not collapse — the xor-then-multiply version returned 0 for every i===seed", () => {
  // The first cut was `h = imul(h ^ coord, PRIME)` per axis. When the xor came
  // out zero the multiply pinned the state at zero and both the seed and that
  // coordinate were lost: hash3(1,0,0,1) was exactly 0, and so was every other
  // (i === seed) pair. That is a whole family of collisions inside the noise,
  // and it would have surfaced as identically-patterned patches scattered over
  // the world with nothing in the picture to explain them.
  const seen = new Set<number>();
  let zeros = 0;
  for (let i = -40; i < 40; i++)
    for (let j = -40; j < 40; j++)
      for (const k of [-2, -1, 0, 1, 2, 7]) {
        const h = hash3(i, j, k, 0x5741_4c31);
        if (h === 0) zeros++;
        seen.add(h);
      }
  assert.equal(zeros, 0, "a lattice point hashed to exactly 0");
  assert.equal(seen.size, 80 * 80 * 6, "distinct lattice points collided");
  for (const s of [1, 7, 12345]) assert.notEqual(hash3(s, 0, 0, s), 0, `hash3(${s},0,0,${s}) collapsed`);
});

/* THE WALL IS A FLOOR STOOD ON ITS EDGE (maintainer 2026-09-07: "I feel you are
 * thinking too much in columns ... think the wall is tilted 90 degrees (becomes
 * floor). Of course you don't think on columns when it comes to today's
 * ground"), so the field is measured in world units with elevation scaled by
 * the real geometry, and both horizontal axes are treated like the vertical one.
 *
 * These replaced a "colSeam" and a "rowStripe" — the longest run of a boundary
 * along a column and along a storey. Those asked the wrong question twice: they
 * presume a constant-tile patch WITH an edge, which the ground's structure does
 * not produce, and they treat the wall's two axes as different kinds of thing,
 * which is the column-thinking itself. */
const PITCH_PX = 15;                            // one storey
const STEP_PX = Math.sqrt(32 * 32 + 14 * 14);   // one cell step along a face
const TALLEST = 40;                             // measured max face in the_game

test("a region is a BALL in world space — the field is isotropic", () => {
  // A storey is 15px against a 34.9px cell step, so elevation enters at 0.429.
  // Get that wrong and regions stretch: the first cut used 0.8, nearly twice
  // too tall, which made patches read as column-shaped and made a shear seem
  // necessary to fight the symptom. Measured in WORLD space, not on a face — a
  // face is only 17 cell-steps tall, so a region is always clipped there and
  // the shape has to be checked where it actually exists.
  const box = new Map<string, { lo: number[]; hi: number[] }>();
  const SPAN = 260;
  const STEP = 4;
  for (let x = 0; x < SPAN; x += STEP)
    for (let y = 0; y < SPAN; y += STEP)
      for (let zc = 0; zc < SPAN; zc += STEP) {
        const z = Math.round(zc / WALL_STOREY_CELLS);
        const r = wallField(x, y, z).region;
        const p = [x, y, zc];
        const b = box.get(r);
        if (!b) box.set(r, { lo: [...p], hi: [...p] });
        else for (let k = 0; k < 3; k++) { b.lo[k] = Math.min(b.lo[k], p[k]); b.hi[k] = Math.max(b.hi[k], p[k]); }
      }
    const asp: number[] = [];
  for (const b of box.values()) {
    if (b.lo.some((v) => v <= 0) || b.hi.some((v) => v >= SPAN - STEP)) continue; // clipped by the sample
    const e = [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]];
    asp.push(Math.max(...e) / Math.max(1, Math.min(...e)));
  }
  assert.ok(asp.length > 5, `too few unclipped regions to judge (${asp.length})`);
  const sorted = asp.sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(median < 3, `median region aspect ${median.toFixed(2)} — regions are stretched, not balls`);
});

test("ONE SET PER MASSIF — a region is larger than the tallest cliff, on purpose", () => {
  // The three tiles of a set are gated against each other, but two ADJACENT
  // SETS are not: nothing measures the join between a tile of set A and one of
  // set B, so a region boundary is the one place a bad seam can still appear.
  // Big regions make that boundary rare and put it between massifs, where a
  // change of rock is the point. This was 10 — small enough for the set to
  // change going UP a face — and that showed as a mismatched strip across one
  // cliff, which is the seam, not the feature.
  const tallestPx = TALLEST * PITCH_PX;
  const regionPx = WALL_REGION_CELLS * STEP_PX;
  assert.ok(
    regionPx > tallestPx,
    `a region is ${Math.round(regionPx)}px against a ${tallestPx}px cliff — a set could change partway up one`,
  );
});

test("THE MEMBER VARIES PER CELL, which is what removes the boundary", () => {
  // The ground's region edges are invisible because each CELL picks its own
  // member; the same is true here. A constant tile over a region would have an
  // edge, and an edge on a wall is either a column seam or a storey stripe —
  // there is no third option. Varying per cell removes the edge rather than
  // steering it. The share below is the chance two independent cells draw the
  // same slot under WALL_PALETTE_WEIGHTS, so it pins the mix, not just "varies".
  const total = WALL_PALETTE_WEIGHTS.reduce((s, w) => s + w, 0);
  const expected = WALL_PALETTE_WEIGHTS.reduce((s, w) => s + (w / total) ** 2, 0);
  let same = 0;
  let n = 0;
  for (const [dx, dy, dz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const)
    for (let y = 20; y < 50; y++)
      for (let x = 20; x < 70; x++)
        for (let z = 0; z < TALLEST; z += 3) {
          const a = pickWallIndex("grey_stone__over__grey_stone", keysOf(74), x, y, z, undefined, SETS);
          const b = pickWallIndex("grey_stone__over__grey_stone", keysOf(74), x + dx, y + dy, z + dz, undefined, SETS);
          if (a === b) same++;
          n++;
        }
  const share = same / n;
  assert.ok(
    Math.abs(share - expected) < 0.08,
    `neighbours matched ${(share * 100).toFixed(1)}% against the ${(expected * 100).toFixed(1)}% the weights imply`,
  );
});

test("a palette is distinct, ordered and bounded", () => {
  // Drawn WITHOUT replacement: a repeat would silently merge two weights, so
  // the 10% vein would vanish on some massifs and the rule would look like it
  // had failed intermittently.
  for (const macro of ["0,0,0", "1,-2,0", "5,5,5", "-3,7,-1"]) {
    const p = wallPalette("grey_stone__over__grey_stone", macro, keysOf(74), SETS);
    assert.equal(p.length, WALL_PALETTE_N);
    assert.ok(p.every((i) => [3, 7, 11, 2, 5, 9].includes(i)), "a gated-out set was used");
    assert.equal(new Set(p).size, p.length, `palette repeated a member at ${macro}`);
    for (const i of p) assert.ok(i >= 0 && i < 74, `palette index ${i} out of range`);
  }
  assert.deepEqual(wallPalette("a", "0,0,0", keysOf(1), SETS), [0], "a one-tile pool has one palette entry");
  assert.deepEqual(wallPalette("a", "0,0,0", keysOf(0), SETS), [], "an empty pool has an empty palette");
});

test("degenerate pools behave, and the whole rule is deterministic", () => {
  assert.equal(pickWallIndex("p", keysOf(0), 1, 2, 3), -1, "an empty pool must report -1, not pick 0");
  for (let z = 0; z < 5; z++) assert.equal(pickWallIndex("p", keysOf(1), 3, 4, z, undefined, SETS), 0, "a one-tile pool is the old behaviour");
  for (const [x, y, z] of [[0, 0, 0], [37, 214, 5], [393, 393, 40]] as const) {
    const a = pickWallIndex("grey_stone__over__grey_stone", keysOf(74), x, y, z, undefined, SETS);
    for (let n = 0; n < 3; n++)
      assert.equal(pickWallIndex("grey_stone__over__grey_stone", keysOf(74), x, y, z, undefined, SETS), a, "not deterministic");
  }
  // Different pools must not share a draw: the cap and the storey fill come
  // from different candidate lists and must be free to differ.
  const a = pickWallIndex("grass__over__grey_stone", keysOf(40), 10, 10, 2, undefined, SETS);
  const b = pickWallIndex("grey_stone__over__grey_stone", keysOf(40), 10, 10, 2, undefined, SETS);
  assert.ok(Number.isInteger(a) && Number.isInteger(b));
});
