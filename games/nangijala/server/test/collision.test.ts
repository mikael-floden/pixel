import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stepMovement,
  buildTerrainGrid,
  makeBlocked,
  isWalkableTerrain,
  isBlockedAtWorld,
  findSpawn,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  WALK_SPEED,
} from "@nangijala/shared";

// A tiny 3×3 world: walkable centre column, water on the left/right columns.
//   W . W
//   W . W
//   W . W
function grid3x3() {
  const rows = [
    [{ t: "water" }, { t: "grass" }, { t: "water" }],
    [{ t: "water" }, { t: "grass" }, { t: "water" }],
    [{ t: "water" }, { t: "grass" }, { t: "water" }],
  ];
  return buildTerrainGrid(3, 3, rows);
}

const CELL_W = WORLD_WIDTH / 3;
const CELL_H = WORLD_HEIGHT / 3;
const centreX = CELL_W * 1.5; // middle column centre
const centreY = CELL_H * 1.5;

test("terrain categories: water/castle block, ground walks, unknown walks", () => {
  assert.equal(isWalkableTerrain("water"), false);
  assert.equal(isWalkableTerrain("castle"), false);
  assert.equal(isWalkableTerrain("grass"), true);
  assert.equal(isWalkableTerrain("brick_road"), true);
  assert.equal(isWalkableTerrain("some_new_tile"), true); // default walkable
});

test("isBlockedAtWorld maps world coords to cells and treats outside as blocked", () => {
  const g = grid3x3();
  assert.equal(isBlockedAtWorld(g, centreX, centreY), false); // centre column
  assert.equal(isBlockedAtWorld(g, CELL_W * 0.5, centreY), true); // left water column
  assert.equal(isBlockedAtWorld(g, -10, centreY), true); // outside the map
});

test("stepMovement without a blocker is unchanged (open world)", () => {
  const r = stepMovement(100, 100, 1, 0, false, 0.5);
  assert.equal(r.x, 100 + WALK_SPEED * 0.5);
  assert.equal(r.y, 100);
});

test("stepMovement stops at a wall instead of entering it", () => {
  const g = grid3x3();
  const blocked = makeBlocked(g);
  // Stand at the centre column, walk east toward the water column with a big dt.
  const r = stepMovement(centreX, centreY, 1, 0, true, 5, blocked);
  assert.equal(r.y, centreY, "no vertical drift");
  assert.ok(!isBlockedAtWorld(g, r.x, r.y), "never ends inside a blocked cell");
  assert.ok(r.x < CELL_W * 2, "did not cross into the water column");
});

test("stepMovement slides along a wall (blocked axis drops, free axis moves)", () => {
  const g = grid3x3();
  const blocked = makeBlocked(g);
  // Push diagonally into the east wall: X is blocked, Y should still advance.
  const y0 = CELL_H * 1.2;
  const r = stepMovement(centreX, y0, 1, 1, false, 0.5, blocked);
  assert.ok(r.y > y0, "slides downward along the wall");
  assert.ok(!isBlockedAtWorld(g, r.x, r.y), "stays on walkable ground");
});

test("findSpawn returns an open walkable cell, never water", () => {
  const g = grid3x3();
  const s = findSpawn(g);
  assert.equal(isBlockedAtWorld(g, s.x, s.y), false);
  // Only the centre column has walkable cells here.
  assert.ok(s.x > CELL_W && s.x < CELL_W * 2, "spawns in the walkable centre column");
});
