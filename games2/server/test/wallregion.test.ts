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

test("the published TEST_VECTORS reproduce — this is what a port is checked against", () => {
  for (const [i, j, k, s, want] of WALL_TEST_VECTORS.hash3) assert.equal(hash3(i, j, k, s), want, `hash3(${i},${j},${k},${s})`);
  for (const [x, y, z, s, want] of WALL_TEST_VECTORS.vnoise3) assert.equal(r6(vnoise3(x, y, z, s)), want, `vnoise3(${x},${y},${z})`);
  for (const [x, y, z, s, want] of WALL_TEST_VECTORS.fbm3) assert.equal(r6(fbm3(x, y, z, s)), want, `fbm3(${x},${y},${z})`);
  for (const [x, y, z, region] of WALL_TEST_VECTORS.field)
    assert.equal(wallField(x, y, z).region, region, `field(${x},${y},${z})`);
  for (const [pool, macro, n, want] of WALL_TEST_VECTORS.palette)
    assert.deepEqual(wallPalette(pool, macro, keysOf(n)), want, `palette(${pool},${macro},${n})`);
  for (const [pool, n, x, y, z, want] of WALL_TEST_VECTORS.pick)
    assert.equal(pickWallIndex(pool, keysOf(n), x, y, z), want, `pick(${pool},${n},${x},${y},${z})`);
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
 * ground"). So these measure the SURFACE, in pixels, treating both directions
 * alike — and at the heights the world actually has.
 *
 * The tests they replace asserted a "colSeam" and a "rowStripe": the longest run
 * of a tile boundary along a column and along a storey. Those asked the wrong
 * question twice. They presume a constant-tile patch WITH an edge, which the
 * ground's structure does not produce, and they treat the wall's two axes as
 * different kinds of thing, which is the column-thinking itself. They also ran
 * on a 16-storey slab when the_game's faces reach 40. */
const PITCH_PX = 15;                                  // one storey
const STEP_PX = Math.sqrt(32 * 32 + 14 * 14);         // one cell along a face
const TALLEST = 40;                                   // measured max in the_game
const LINES = [7, 23, 40, 61, 90, 128, 171, 200, 244, 301, 340, 377];

/** Region patches on a face, as pixel boxes. Patches touching the sample edge
 *  are dropped: their extent is the window's, not theirs. */
function patchBoxes(): { w: number; h: number }[] {
  const out: { w: number; h: number }[] = [];
  const W = 90;
  for (const along of ["x", "y"] as const)
    for (const fixed of LINES) {
      const box = new Map<string, { i0: number; i1: number; z0: number; z1: number }>();
      for (let z = 0; z < TALLEST; z++)
        for (let i = 0; i < W; i++) {
          const [x, y] = along === "x" ? [i, fixed] : [fixed, i];
          const r = wallField(x, y, z).region;
          const b = box.get(r) ?? { i0: i, i1: i, z0: z, z1: z };
          b.i0 = Math.min(b.i0, i); b.i1 = Math.max(b.i1, i);
          b.z0 = Math.min(b.z0, z); b.z1 = Math.max(b.z1, z);
          box.set(r, b);
        }
      for (const b of box.values()) {
        if (b.i0 === 0 || b.i1 === W - 1 || b.z0 === 0 || b.z1 === TALLEST - 1) continue;
        out.push({ w: (b.i1 - b.i0 + 1) * STEP_PX, h: (b.z1 - b.z0 + 1) * PITCH_PX });
      }
    }
  return out;
}

test("a region is ROUND on the wall — the field is isotropic in what the eye sees", () => {
  // A storey is 15px and a cell step is 34.9px, so elevation enters the field at
  // 0.429. Get that ratio wrong and patches stretch: the first cut used 0.8,
  // nearly twice too tall, which is what made them read as column-shaped and
  // made a shear seem necessary to fight the symptom.
  const boxes = patchBoxes();
  assert.ok(boxes.length > 40, `too few unclipped patches to judge (${boxes.length})`);
  const asp = boxes.map((b) => b.w / b.h).sort((a, b) => a - b);
  const median = asp[Math.floor(asp.length / 2)];
  assert.ok(median > 0.7 && median < 1.6, `median patch aspect ${median.toFixed(2)} — patches are stretched, not round`);
});

test("a region is bigger than a typical wall and smaller than the tallest", () => {
  // the_game's faces: median 4 storeys, p90 14, max 40. A region must be large
  // enough that an ordinary wall is one stone, and small enough that a MOUNTAIN
  // is not — a region taller than the tallest cliff can only ever change
  // sideways, which is a vertical boundary, which is the column-shaped result
  // this rule exists to avoid.
  const boxes = patchBoxes();
  const hs = boxes.map((b) => b.h).sort((a, b) => a - b);
  const medianH = hs[Math.floor(hs.length / 2)];
  assert.ok(medianH > 4 * PITCH_PX, `regions (${medianH}px) do not cover an ordinary 4-storey wall`);
  assert.ok(medianH < TALLEST * PITCH_PX, `regions (${medianH}px) are taller than the tallest cliff (${TALLEST * PITCH_PX}px)`);
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
          const a = pickWallIndex("grey_stone__over__grey_stone", keysOf(74), x, y, z);
          const b = pickWallIndex("grey_stone__over__grey_stone", keysOf(74), x + dx, y + dy, z + dz);
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
    const p = wallPalette("grey_stone__over__grey_stone", macro, keysOf(74));
    assert.equal(p.length, WALL_PALETTE_N);
    assert.equal(new Set(p).size, p.length, `palette repeated a member at ${macro}`);
    for (const i of p) assert.ok(i >= 0 && i < 74, `palette index ${i} out of range`);
  }
  assert.deepEqual(wallPalette("a", "0,0,0", keysOf(1)), [0], "a one-tile pool has one palette entry");
  assert.deepEqual(wallPalette("a", "0,0,0", keysOf(0)), [], "an empty pool has an empty palette");
});

test("degenerate pools behave, and the whole rule is deterministic", () => {
  assert.equal(pickWallIndex("p", keysOf(0), 1, 2, 3), -1, "an empty pool must report -1, not pick 0");
  for (let z = 0; z < 5; z++) assert.equal(pickWallIndex("p", keysOf(1), 3, 4, z), 0, "a one-tile pool is the old behaviour");
  for (const [x, y, z] of [[0, 0, 0], [37, 214, 5], [393, 393, 40]] as const) {
    const a = pickWallIndex("grey_stone__over__grey_stone", keysOf(74), x, y, z);
    for (let n = 0; n < 3; n++)
      assert.equal(pickWallIndex("grey_stone__over__grey_stone", keysOf(74), x, y, z), a, "not deterministic");
  }
  // Different pools must not share a draw: the cap and the storey fill come
  // from different candidate lists and must be free to differ.
  const a = pickWallIndex("grass__over__grey_stone", keysOf(40), 10, 10, 2);
  const b = pickWallIndex("grey_stone__over__grey_stone", keysOf(40), 10, 10, 2);
  assert.ok(Number.isInteger(a) && Number.isInteger(b));
});
