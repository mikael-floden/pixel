import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stepMovement,
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
