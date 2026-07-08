import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stepMovement,
  screenToWorldVector,
  WALK_SPEED,
  RUN_SPEED,
  WORLD_WIDTH,
  SPAWN_MARGIN,
} from "@nangijala/shared";

test("stepMovement: idle input does not move", () => {
  const r = stepMovement(100, 100, 0, 0, false, 0.1);
  assert.deepEqual([r.x, r.y, r.moving, r.dir], [100, 100, false, null]);
});

test("stepMovement: walk east covers WALK_SPEED*dt", () => {
  const r = stepMovement(100, 100, 1, 0, false, 0.5);
  assert.equal(r.x, 100 + WALK_SPEED * 0.5);
  assert.equal(r.dir, "east");
  assert.equal(r.moving, true);
});

test("stepMovement: running is faster than walking", () => {
  const walk = stepMovement(100, 100, 1, 0, false, 0.5).x;
  const run = stepMovement(100, 100, 1, 0, true, 0.5).x;
  assert.ok(run - 100 > walk - 100);
  assert.equal(run, 100 + RUN_SPEED * 0.5);
});

test("stepMovement: diagonal is normalized (no speed boost)", () => {
  const r = stepMovement(400, 400, 1, 1, false, 1);
  const dist = Math.hypot(r.x - 400, r.y - 400);
  assert.ok(Math.abs(dist - WALK_SPEED) < 1e-6);
});

test("stepMovement: clamps to the world margin", () => {
  const r = stepMovement(WORLD_WIDTH - 10, 100, 1, 0, true, 5);
  assert.equal(r.x, WORLD_WIDTH - SPAWN_MARGIN);
});

test("screenToWorldVector: diagonal keys lock to a grid axis (corridor run)", () => {
  // Each of the four diagonal presses must snap to exactly ONE world axis, so
  // the player runs straight along a tile row/column.
  for (const [ix, iy] of [
    [-1, 1], // down-left
    [1, -1], // up-right
    [1, 1], // down-right
    [-1, -1], // up-left
  ] as const) {
    const w = screenToWorldVector(ix, iy);
    // Exactly one world component is non-zero → movement is along a grid axis.
    assert.ok((Math.abs(w.x) < 1e-9) !== (Math.abs(w.y) < 1e-9), `${ix},${iy} → single axis`);
  }
  // Single-key presses are NOT snapped — they keep their two-component
  // screen-cardinal world vector (up/down/left/right move between the axes).
  const single = screenToWorldVector(1, 0);
  assert.ok(Math.abs(single.x) > 1e-6 && Math.abs(single.y) > 1e-6, "single key unchanged");
});

test("stepMovement: diagonal press moves along a single world axis", () => {
  // With screenInput, holding down+left runs straight along +row (world y),
  // with no x drift — a corridor/bridge stays true.
  const r = stepMovement(400, 400, -1, 1, false, 1, undefined, 1, true);
  assert.ok(Math.abs(r.x - 400) < 1e-6, `no x drift (x=${r.x})`);
  assert.ok(r.y > 400, "advanced along +row");
});
