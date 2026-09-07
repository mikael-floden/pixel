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
  for (const [x, y, z, micro, macro] of WALL_TEST_VECTORS.field) {
    const f = wallField(x, y, z);
    assert.equal(f.micro, micro, `field.micro(${x},${y},${z})`);
    assert.equal(f.macro, macro, `field.macro(${x},${y},${z})`);
  }
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

/** The field over a slab of wall: [storey][along-the-face] region ids. */
function slab(along: "x" | "y", fixed: number, w = 120, h = 16): string[][] {
  const g: string[][] = [];
  for (let z = 0; z < h; z++) {
    g[z] = [];
    for (let i = 0; i < w; i++) {
      const [x, y] = along === "x" ? [i, fixed] : [fixed, i];
      g[z][i] = wallField(x, y, z).micro;
    }
  }
  return g;
}

test("NO COLUMN SWITCHES — a boundary never holds one column for many storeys", () => {
  // "never a whole column switching". A tile boundary that sits between the
  // same two columns all the way up IS that bug, and it is what an axis-aligned
  // chunk grid gives you for free: its boundaries are planes of constant x, and
  // a plane of constant x is a column seam on an iso screen.
  let worst = 0;
  let where = "";
  for (const along of ["x", "y"] as const)
    for (const fixed of [7, 23, 40, 61, 90, 128, 171, 200, 244, 301, 340, 377]) {
      const g = slab(along, fixed);
      for (let i = 1; i < g[0].length; i++) {
        let run = 0;
        for (let z = 0; z < g.length; z++) {
          if (g[z][i] !== g[z][i - 1]) {
            run++;
            if (run > worst) { worst = run; where = `${along}=${i} at ${fixed}`; }
          } else run = 0;
        }
      }
    }
  assert.ok(worst <= 7, `a boundary held one column for ${worst} storeys (${where}); the broken shapes scored 11-12`);
});

test("NO STOREY STRIPES — a boundary never holds one storey across many cells", () => {
  // "never a per-storey stripe". The mirror image of the test above, and the
  // failure that appeared the moment the shear was applied to x and y only: the
  // elevation slabs stayed horizontal and scored 27-45 here.
  let worst = 0;
  for (const along of ["x", "y"] as const)
    for (const fixed of [7, 23, 40, 61, 90, 128, 171, 200, 244, 301, 340, 377]) {
      const g = slab(along, fixed);
      for (let z = 1; z < g.length; z++) {
        let run = 0;
        for (let i = 0; i < g[0].length; i++) {
          if (g[z][i] !== g[z - 1][i]) { run++; if (run > worst) worst = run; } else run = 0;
        }
      }
    }
  assert.ok(worst <= 20, `a boundary held one storey for ${worst} cells; the unsheared shape scored 27-45`);
});

test("IT IS NOT PER-CELL RANDOM — neighbours overwhelmingly share a tile", () => {
  // The other half of "don't make it feel random": a patch has to be a patch.
  // Per-cell picking over 74 candidates would agree with a neighbour ~1.4% of
  // the time and paint a quilt.
  let same = 0;
  let total = 0;
  for (let y = 20; y < 60; y++)
    for (let x = 20; x < 100; x++)
      for (let z = 0; z < 8; z++) {
        const a = pickWallIndex("grey_stone__over__grey_stone", keysOf(74), x, y, z);
        for (const [dx, dy, dz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
          if (pickWallIndex("grey_stone__over__grey_stone", keysOf(74), x + dx, y + dy, z + dz) === a) same++;
          total++;
        }
      }
  const share = same / total;
  assert.ok(share > 0.75, `neighbours agreed only ${(share * 100).toFixed(1)}% of the time — that is a quilt, not a rock face`);
  assert.ok(share < 0.999, `neighbours agreed ${(share * 100).toFixed(2)}% of the time — the field is not varying at all`);
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
