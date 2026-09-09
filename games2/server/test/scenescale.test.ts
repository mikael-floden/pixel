import { test } from "node:test";
import assert from "node:assert/strict";
import { fitSprite } from "../../client/src/scenery3";

/* THE SCALE IS THE PIECE'S, NOT THE DRAWN SPRITE'S.
 *
 * `world_px_height` describes the PIECE. Deriving the fit from whatever sprite
 * is being drawn forces every rotation and state to exactly that height and
 * throws the size difference between them away — and a rotation shows the top
 * face, so it is naturally taller and gets squashed SMALLER. Measured over
 * the_game's rotations: 20 of 29 piece+facing combinations more than 5% off,
 * 8 more than 15%, worst cupboards_and_shelves/cupboard_008 south-west with a
 * 92px base against a 121px rotation, +32%.
 *
 * It is also what pulled the footprint outline off its art: the collision stamp
 * scales the published ellipse by the BASE sprite's bbox, so a placement drawn
 * at any other scale wears an outline of the wrong size in the wrong place
 * (maintainer 2026-09-02: "the hitboxes doesn't align with the big hitbox
 * review I did in the wiki"). The maps2 agent hit the same trap in render3
 * first and posted the warning; this is the games2 half of it. */
test("a rotation is drawn at the PIECE's scale, keeping its own proportions", () => {
  const canvas = { w: 128, h: 128 };
  const wantH = 46; // the piece's world_px_height
  // cupboard_008's real numbers: a 92px base and a 121px south-west rotation.
  const base: [number, number, number, number] = [10, 10, 70, 102]; // 60 x 92
  const rot: [number, number, number, number] = [8, 4, 76, 125]; // 68 x 121

  const asBase = fitSprite(base, canvas, wantH, 100, 100, false, 92);
  assert.equal(asBase.h, wantH, "the base sprite still lands exactly on world_px_height");

  const rotated = fitSprite(rot, canvas, wantH, 100, 100, false, 92);
  const naive = fitSprite(rot, canvas, wantH, 100, 100, false);
  assert.equal(naive.h, wantH, "the old rule squashed the rotation to the piece height");
  assert.ok(
    rotated.h > naive.h,
    `a taller rotation must draw TALLER than the base, not be squashed to it (${rotated.h} vs ${naive.h})`,
  );
  // 121/92 = 1.315, so the rotation should stand about 31% taller than the base.
  const ratio = rotated.h / asBase.h;
  assert.ok(
    Math.abs(ratio - 121 / 92) < 0.03,
    `the rotation keeps its own proportion to the piece (got ${ratio.toFixed(3)}, want ${(121 / 92).toFixed(3)})`,
  );
  // One k on both axes — within the rounding, since w and h are each rint()ed
  // to whole pixels independently and a 68x121 crop cannot land both exactly.
  assert.ok(
    Math.abs(rotated.kx - rotated.ky) / rotated.ky < 0.02,
    `one scale on both axes (kx ${rotated.kx.toFixed(4)} vs ky ${rotated.ky.toFixed(4)})`,
  );
});

test("omitting the base height is exactly the old behaviour", () => {
  const canvas = { w: 64, h: 64 };
  const bb: [number, number, number, number] = [4, 6, 60, 58];
  const a = fitSprite(bb, canvas, 40, 50, 50, false);
  const b = fitSprite(bb, canvas, 40, 50, 50, false, 52); // 58-6 = its own height
  assert.deepEqual({ ...a }, { ...b }, "passing its own bbox height changes nothing");
});
