// THE SCENERY SEAM an ambient effect hangs on — `ambient/runtime/scenery.ts`.
//
// Two things that a screenshot cannot show and that were both wrong in the
// shipped game until 2026-09-21, when the maintainer reported "I have never
// seen a dragonfly ever in this game":
//
//  1. EVERY PIECE IS DRAWN TWICE — a base image on the painter line and an
//     opaque LIT COPY at ~900_001+ — so the raw display list said 20 waterline
//     pieces where the marsh had drawn 10, and a population tuned per piece
//     came out double.
//  2. The lit copy is what is SEEN, so a mark in the ambient band (~900_000.0x)
//     is painted over by the very piece it belongs to. `litDepth` is how an
//     attached effect sorts in front of it — the same number `lightsInView`
//     carries for the sparks and the moths.
//
// Pure arithmetic over the probe's own record shape: no Phaser, no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ABOVE_LIT, LIT_BAND, SRC_LIFT, pairPieces } from "../../ambient/runtime/scenery";

const WATERLINE = new Set(["reed_beds", "cattail_clumps", "water_lily_clumps"]);

/** One drawn image as `__ml.objectsIn` reports it. */
const img = (o: {
  key: string; depth: number; x: number; y: number; w?: number; h?: number; alpha?: number; frame?: string;
}) => ({ frame: "s3c:11,7,77,83", w: 78, h: 84, alpha: 1, ...o });

/** A piece as the game draws it: the base, then its lit copy. `litDepth()` in
 *  WorldScene is `900_001 + baseDepth * 1e-5` — reproduced here so the test
 *  fails if the two bands are ever allowed to meet. */
const drawn = (key: string, x: number, y: number, base: number) => [
  img({ key, depth: base, x, y }),
  img({ key, depth: LIT_BAND + base * 1e-5, x, y }),
];

test("a piece drawn twice is reported ONCE, with its lit copy's depth", () => {
  const raw = [
    ...drawn("s3:reed_beds/reed_bed_007/sprite.webp", 8670, 5120, 5401.708),
    ...drawn("s3:reed_beds/reed_bed_007/sprite.webp", 8730, 5180, 5415.214),
  ];
  const out = pairPieces(raw, WATERLINE);
  assert.equal(out.length, 2, "two reed beds, not four images");
  assert.equal(out[0].category, "reed_beds");
  assert.equal(out[0].cx, 8670 + 78 / 2);
  assert.equal(out[0].footY, 5120 + 84);
  for (const p of out) {
    assert.ok(p.litDepth !== null, "the copy is what a mark sorts against");
    assert.ok((p.litDepth as number) >= LIT_BAND, "and it is in the lit band");
  }
  // ...and the two pieces are DISTINGUISHABLE, or a per-piece sort is a lie.
  assert.notEqual(out[0].litDepth, out[1].litDepth);
});

test("a mark on the piece's litDepth draws over the piece and under the next one", () => {
  const out = pairPieces(
    [
      ...drawn("s3:reed_beds/reed_bed_007/sprite.webp", 8670, 5120, 5401.708),
      ...drawn("s3:reed_beds/reed_bed_007/sprite.webp", 8730, 5180, 5415.214),
    ],
    WATERLINE,
  );
  const [near, far] = out;
  const mark = (near.litDepth as number) + SRC_LIFT;
  assert.ok(mark > (near.litDepth as number), "in front of its own reed");
  assert.ok(mark < (far.litDepth as number), "and never in front of the next reed along");
  // Six flies' worth of self-sorting still fits inside one painter pixel.
  assert.ok(mark + 6e-6 < (far.litDepth as number));
});

test("a piece with no lit copy reports null, and the caller goes above the band", () => {
  const raw = [img({ key: "s3:cattail_clumps/cattail_clump_005/sprite.webp", depth: 5301.2, x: 10, y: 20 })];
  const out = pairPieces(raw, WATERLINE);
  assert.equal(out.length, 1);
  assert.equal(out[0].litDepth, null);
  // The fallback is above every copy the_game can produce (~900_001.12) and
  // below the target rings (900_001.44).
  assert.ok(ABOVE_LIT > LIT_BAND + 0.12 && ABOVE_LIT < 900_001.44);
});

test("a copy alone still counts as a piece — a base rebuilt for one frame loses nothing", () => {
  const raw = [img({ key: "s3:reed_beds/reed_bed_007/sprite.webp", depth: LIT_BAND + 0.054, x: 1, y: 2 })];
  const out = pairPieces(raw, WATERLINE);
  assert.equal(out.length, 1);
  assert.equal(out[0].litDepth, LIT_BAND + 0.054);
});

test("only the asked-for categories, and nothing that is not a scenery key", () => {
  const raw = [
    ...drawn("s3:trees/tree_017/sprite.webp", 0, 0, 5000),
    ...drawn("s3:reed_beds/reed_bed_007/sprite.webp", 10, 10, 5001),
    img({ key: "amb-dfly0_0", depth: 900_000.085, x: 10, y: 10, w: 7, h: 3 }),
    img({ key: "t3:ground/xyz", depth: 10, x: 10, y: 10 }),
  ];
  const out = pairPieces(raw, WATERLINE);
  assert.deepEqual(out.map((p) => p.category), ["reed_beds"]);
});

test("a piece dissolving with the roof cut is not somewhere to perch", () => {
  const raw = [
    img({ key: "s3:reed_beds/reed_bed_007/sprite.webp", depth: 5401.7, x: 0, y: 0, alpha: 0.3 }),
    img({ key: "s3:reed_beds/reed_bed_007/sprite.webp", depth: LIT_BAND + 0.054, x: 0, y: 0, alpha: 0.3 }),
  ];
  assert.equal(pairPieces(raw, WATERLINE).length, 0);
});

test("two pieces at the same box are not merged into one", () => {
  // Degenerate but it must not LOSE one: same key, same rect, two of each.
  const raw = [
    img({ key: "s3:water_lily_clumps/water_lily_clump_001/sprite.webp", depth: 5100, x: 5, y: 5 }),
    img({ key: "s3:water_lily_clumps/water_lily_clump_001/sprite.webp", depth: 5100, x: 5, y: 5 }),
    img({ key: "s3:water_lily_clumps/water_lily_clump_001/sprite.webp", depth: LIT_BAND + 0.051, x: 5, y: 5 }),
    img({ key: "s3:water_lily_clumps/water_lily_clump_001/sprite.webp", depth: LIT_BAND + 0.051, x: 5, y: 5 }),
  ];
  assert.equal(pairPieces(raw, WATERLINE).length, 2);
});
