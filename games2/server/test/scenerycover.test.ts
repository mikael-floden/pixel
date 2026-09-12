// THE TREE OVER THE HOUSE (maintainer 2026-09-12): an outside piece whose drawn
// box lies over half the room's floor fades out while the room is entered; a
// smaller one keeps its black silhouette. The measure is pure (scenerycover.ts):
// the scene projects the room's floor cells and hands the points over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { roomCoverFraction, coversRoom, SCENERY_COVER_FADE } from "../../client/src/scenerycover";

/** A 4x3 room of floor cells laid out on a plain grid, 10 px apart. */
const room = () => {
  const pts = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) pts.push({ x: 100 + c * 10, y: 100 + r * 10 });
  return pts; // 12 cells
};

test("the cover share is the room's floor cells under the piece's box", () => {
  const cells = room();
  assert.equal(roomCoverFraction({ x: 0, y: 0, w: 50, h: 50 }, cells), 0, "a box beside the room covers nothing");
  assert.equal(roomCoverFraction({ x: 90, y: 90, w: 100, h: 100 }, cells), 1, "a box over the whole room covers it all");
  // Two of the three rows: 8 of 12 cells.
  assert.ok(Math.abs(roomCoverFraction({ x: 95, y: 95, w: 40, h: 20 }, cells) - 8 / 12) < 1e-12, "two rows of four");
  // One column: 3 of 12.
  assert.ok(Math.abs(roomCoverFraction({ x: 95, y: 95, w: 10, h: 40 }, cells) - 3 / 12) < 1e-12, "one column of three");
  // The box's far edges are exclusive, its near edges inclusive: a cell ON the
  // right edge is outside, one on the left edge inside.
  assert.equal(roomCoverFraction({ x: 100, y: 100, w: 10, h: 10 }, cells), 1 / 12, "a cell on the near edge counts, one on the far edge does not");
  assert.equal(roomCoverFraction({ x: 100, y: 100, w: 0, h: 10 }, cells), 0, "an empty box covers nothing");
  assert.equal(roomCoverFraction({ x: 100, y: 100, w: 50, h: 50 }, []), 0, "no room, no cover");
});

test("half the house is the line: the spawn tree fades, a bush at the door keeps its silhouette", () => {
  const cells = room();
  const canopy = roomCoverFraction({ x: 95, y: 95, w: 40, h: 20 }, cells); // 8 of 12
  const bush = roomCoverFraction({ x: 95, y: 115, w: 20, h: 20 }, cells); // 2 of 12
  assert.ok(canopy >= SCENERY_COVER_FADE && coversRoom(canopy), `the canopy over ${(canopy * 100).toFixed(0)}% of the floor fades out`);
  assert.ok(bush < SCENERY_COVER_FADE && !coversRoom(bush), `the bush over ${(bush * 100).toFixed(0)}% keeps the effect`);
  assert.equal(coversRoom(SCENERY_COVER_FADE), true, "exactly half is enough");
  assert.equal(coversRoom(SCENERY_COVER_FADE - 1e-9), false);
});
