import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTerrainGrid,
  canEnterElev,
  resolveElevAt,
  CELL_WU,
  WALK_CLIMB,
} from "@nangijala/shared";

// A deck's slab [level - thickness, level] is SOLID: nothing moves through it.
// The maps2 cave carves the east mountain of the_island2 into a level-0 floor
// under kind:"cave" roof decks that carry the original surface (level 24-40,
// thickness = level - 8, so the slab underside sits 8 levels over the floor).
// Before deckBot, a surface walker stepping into a too-high roof ledge was
// offered the cave FLOOR as a free drop — and fell through 24+ levels of rock.
//
// The strip below models a slice of that cave, plus a classic bridge:
//   col 0: uncarved mountain bench, base level 24 (solid rock, no deck)
//   col 1: carved — deck 24 (thickness 16 → underside 8), floor 0
//   col 2: carved — deck 28 (thickness 20 → underside 8), floor 0
//   col 3: cave mouth front — plain grass, level 0
//   col 4: water, bridge deck at 4 (thickness 0 → underside 4)
function caveGrid() {
  const rows = [
    [
      { t: "stone_mountain", l: 24 },
      { t: "stone_mountain", l: 0 },
      { t: "regular_snow", l: 0 },
      { t: "saturated_grass", l: 0 },
      { t: "clear_water", l: 0 },
    ],
  ];
  const decks = [
    { level: 24, thickness: 16, cells: [{ col: 1, row: 0 }] },
    { level: 28, thickness: 20, cells: [{ col: 2, row: 0 }] },
    { level: 4, thickness: 0, cells: [{ col: 4, row: 0 }] },
  ];
  return buildTerrainGrid(5, 1, rows, [], decks);
}

const ctx = { maxClimb: WALK_CLIMB, canSwim: false };
const at = (col: number) => (col + 0.5) * CELL_WU;
const y = 0.5 * CELL_WU;

test("roof walker cannot fall through a higher roof step (the cave hazard)", () => {
  const g = caveGrid();
  // On the deck at 24 (col 1), stepping toward the deck at 28 (col 2): the deck
  // is too high to walk, and the level-0 floor is sealed by the slab.
  const r = canEnterElev(g, 24, at(1), y, at(2), y, ctx);
  assert.equal(r.ok, false);
});

test("uncarved bench onto adjacent carved roof at the same level walks", () => {
  const g = caveGrid();
  const r = canEnterElev(g, 24, at(0), y, at(1), y, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.elev, 24); // stays on the surface, exactly as before the carve
});

test("cave floor stays walkable under roofs of different heights", () => {
  const g = caveGrid();
  const r = canEnterElev(g, 0, at(1), y, at(2), y, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.elev, 0);
});

test("walking out of / into the mouth at grade works", () => {
  const g = caveGrid();
  const out = canEnterElev(g, 0, at(2), y, at(3), y, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.elev, 0);
  const back = canEnterElev(g, 0, at(3), y, at(2), y, ctx);
  assert.equal(back.ok, true);
  assert.equal(back.elev, 0);
});

test("roof walker resolves to the roof, floor walker to the floor", () => {
  const g = caveGrid();
  assert.equal(resolveElevAt(g, 24, at(1), y, ctx), 24);
  assert.equal(resolveElevAt(g, 0, at(1), y, ctx), 0);
});

test("bridges are unaffected: swim under a thickness-0 span", () => {
  const g = caveGrid();
  // A swimmer at elevation 0 passes under the level-4 bridge (underside 4 > 0).
  const r = canEnterElev(g, 0, at(3), y, at(4), y, { ...ctx, canSwim: true });
  assert.equal(r.ok, true);
  assert.equal(r.elev, 0);
  // A non-swimmer is refused by the water, not the slab — same as always.
  const dry = canEnterElev(g, 0, at(3), y, at(4), y, ctx);
  assert.equal(dry.ok, false);
});
