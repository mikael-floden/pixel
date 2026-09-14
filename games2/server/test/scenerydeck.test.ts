// ============================================================================
// SCENERY ON A DECK — a chimney stands ON the roof, not under it
// ============================================================================
//
// maps2 stands a chimney on a house roof over the fire inside (`spec/WORLD3.md`
// "scenery ON a roof"): a placement at the fire's own cell with `z` storeys
// lifting its feet to the roof's top. That cell is a ROOF cell, so
// `roofedCells` holds it and `buildPlacements` used to flag the placement
// `roofed` — indoor furniture, which the scene draws ONLY while that roof is
// cut away. A chimney would then be invisible from the street and visible from
// inside the room, which is exactly backwards.
//
// The rule: a `z` piece whose feet reach the deck's own top is `onDeck` — not
// `roofed`, and not on a `wall` either, so it sorts on its own painter line
// like a tree. A window or a wall hanging keeps everything it had, because its
// feet are BELOW the deck's top.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isoFrame } from "../../client/src/tiles3";
import { buildPlacements, roofedCells, anchorY, type ScenerySpec } from "../../client/src/scenery3";

const W = 24;
const H = 24;
const PITCH = 15; // ISO_GEOMETRY_MAPS3.lh — the measured storey
const frame = isoFrame({ x0: 0, y0: 0, x1: W, y1: H }, 12, PITCH);
/** One house: a room floor at level 2 under a roof deck at level 8. */
const ROOM = { x0: 8, y0: 8, x1: 12, y1: 12 };
const DECK_LEVEL = 8;
const FLOOR = 2;
const decks = [
  {
    kind: "roof",
    level: DECK_LEVEL,
    cells: (() => {
      const out: { x: number; y: number }[] = [];
      for (let y = ROOM.y0; y <= ROOM.y1; y++) for (let x = ROOM.x0; x <= ROOM.x1; x++) out.push({ x, y });
      return out;
    })(),
  },
];
const roofed = roofedCells(decks, W);
const levelAt = () => FLOOR;
const deckAt = (cx: number, cy: number) =>
  cx >= ROOM.x0 && cx <= ROOM.x1 && cy >= ROOM.y0 && cy <= ROOM.y1 ? DECK_LEVEL : -1;

function place(specs: ScenerySpec[], withDeck = true) {
  return buildPlacements(specs, {
    frame,
    levelAt,
    roofed,
    width: W,
    ...(withDeck ? { deckAt } : {}),
    bounds: { x0: 0, y0: 0, x1: W, y1: H },
  });
}

const CHIMNEY: ScenerySpec = { piece: "chimneys/chimney_002", x: 10.5, y: 9.5, z: DECK_LEVEL - FLOOR, dir: "south-east" };
const HANGING: ScenerySpec = { piece: "wall_hangings/wall_hanging_001", x: 10.5, y: 9.5, z: 2, dir: "south-east" };
const BED: ScenerySpec = { piece: "beds/bed_006", x: 10.5, y: 10.5 };

test("a z piece whose feet reach the deck's top is onDeck, not roofed", () => {
  const [p] = place([CHIMNEY]);
  assert.equal(p.onDeck, true, "the chimney stands on the roof");
  assert.equal(p.roofed, undefined, "...so it is NOT indoor furniture under it");
  assert.equal(p.wall, undefined, "...and it is not hanging on a wall face");
  assert.equal(p.z, CHIMNEY.z, "z is carried through for the cut's feet test");
});

test("its feet are drawn at the deck's top, not at the ground", () => {
  const [p] = place([CHIMNEY]);
  assert.equal(p.ay, anchorY(frame, CHIMNEY.x, CHIMNEY.y, DECK_LEVEL), "the feet stand on the roof");
  assert.notEqual(p.ay, anchorY(frame, CHIMNEY.x, CHIMNEY.y, FLOOR), "...a whole house above the floor");
  // The lift is the storey pitch times the storeys — the same arithmetic the
  // terrain draws its own columns with.
  assert.equal(
    anchorY(frame, CHIMNEY.x, CHIMNEY.y, FLOOR) - p.ay,
    (DECK_LEVEL - FLOOR) * PITCH,
    "six storeys of lift",
  );
});

test("A WALL HANGING IS UNTOUCHED: feet below the deck's top keep roofed + wall", () => {
  const [p] = place([HANGING]);
  assert.equal(p.onDeck, undefined, "it hangs inside the room, under the roof");
  assert.equal(p.roofed, true, "...so it is indoor furniture, shown by the cut-away");
  assert.ok(p.wall, "...and it hangs on a wall face, drawn at that column's depth");
  assert.equal(p.z, HANGING.z);
});

test("a piece on the floor under the roof is roofed, with or without a chimney beside it", () => {
  const [bed] = place([BED]);
  assert.equal(bed.roofed, true);
  assert.equal(bed.onDeck, undefined);
  assert.equal(bed.z, undefined, "no z at all: it stands on the floor");
});

test("WITHOUT deckAt nothing is onDeck — every existing world behaves as before", () => {
  const [chimney] = place([CHIMNEY], false);
  assert.equal(chimney.onDeck, undefined);
  assert.equal(chimney.roofed, true, "the old reading: a roof cell means under the roof");
  assert.ok(chimney.wall, "...and the old wall depth");
  const [hanging] = place([HANGING], false);
  assert.equal(hanging.roofed, true);
  assert.ok(hanging.wall);
});

test("a z piece OUTSIDE any deck is neither onDeck nor roofed (a window on a street wall)", () => {
  const [p] = place([{ piece: "windows/window_001", x: 4.5, y: 4.5, z: 1, dir: "south-west" }]);
  assert.equal(p.onDeck, undefined, "no deck at this cell");
  assert.equal(p.roofed, undefined);
  assert.ok(p.wall, "it still hangs on its wall");
});

test("the deck's top is the line: one storey short is under it, level with it is on it", () => {
  const under = place([{ ...CHIMNEY, z: DECK_LEVEL - FLOOR - 1 }])[0];
  assert.equal(under.onDeck, undefined, "a storey short of the roof is still inside");
  assert.equal(under.roofed, true);
  const over = place([{ ...CHIMNEY, z: DECK_LEVEL - FLOOR + 1 }])[0];
  assert.equal(over.onDeck, true, "and anything above the roof is on it");
  assert.equal(over.roofed, undefined);
});
