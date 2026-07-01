import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stepMovement,
  buildTerrainGrid,
  makeBlocked,
  canEnter,
  surfaceFor,
  surfaceAtWorld,
  levelAtWorld,
  isStandableAtWorld,
  findSpawn,
  stepStamina,
  WALK_CLIMB,
  JUMP_CLIMB,
  MAX_STAMINA,
  SWIM_DRAIN,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  WALK_SPEED,
} from "@nangijala/shared";

// A 3×3 world. Centre column is grass; left column water; the right column is a
// raised grass wall (elevation 1) — a 1-level ledge you can't walk up.
//   W  g   G1
//   W  g   G1
//   W  g   G1
function grid3x3() {
  const g = (l = 0) => ({ t: "grass", l });
  const w = { t: "water", l: 0 };
  const rows = [
    [w, g(0), g(1)],
    [w, g(0), g(1)],
    [w, g(0), g(1)],
  ];
  return buildTerrainGrid(3, 3, rows);
}

const CELL_W = WORLD_WIDTH / 3;
const CELL_H = WORLD_HEIGHT / 3;
const midX = CELL_W * 1.5; // centre (grass, l0)
const midY = CELL_H * 1.5;
const rightX = CELL_W * 2.5; // raised grass wall (l1)

test("surface table: speeds, swimmable water, unknown defaults to walkable", () => {
  assert.equal(surfaceFor("water").swimmable, true);
  assert.equal(surfaceFor("water").standable, false);
  assert.equal(surfaceFor("brick_road").speed > surfaceFor("sand").speed, true);
  assert.equal(surfaceFor("totally_new_tile").standable, true); // default walkable
});

test("surfaceAtWorld / levelAtWorld map world coords to cells", () => {
  const g = grid3x3();
  assert.equal(surfaceAtWorld(g, midX, midY).standable, true);
  assert.equal(surfaceAtWorld(g, CELL_W * 0.5, midY).swimmable, true); // water column
  assert.equal(levelAtWorld(g, rightX, midY), 1); // raised column
  assert.equal(isStandableAtWorld(g, CELL_W * 0.5, midY), false); // water not standable
});

test("walking cannot climb a 1-level ledge (Option 2B)", () => {
  const g = grid3x3();
  const walk = { maxClimb: WALK_CLIMB, canSwim: false };
  assert.equal(canEnter(g, midX, midY, rightX, midY, walk), false); // l0 -> l1 blocked
  const jump = { maxClimb: JUMP_CLIMB, canSwim: false };
  assert.equal(canEnter(g, midX, midY, rightX, midY, jump), true); // jump crosses it
});

test("water is enterable only when swimming is allowed", () => {
  const g = grid3x3();
  const noSwim = { maxClimb: WALK_CLIMB, canSwim: false };
  const swim = { maxClimb: WALK_CLIMB, canSwim: true };
  const waterX = CELL_W * 0.5;
  assert.equal(canEnter(g, midX, midY, waterX, midY, noSwim), false);
  assert.equal(canEnter(g, midX, midY, waterX, midY, swim), true);
});

test("stepMovement stops at the ledge when walking, slides along it", () => {
  const g = grid3x3();
  const blocked = makeBlocked(g, { maxClimb: WALK_CLIMB, canSwim: false });
  // Walk east into the raised wall with a big dt: X blocked, stays in mid column.
  const r = stepMovement(midX, midY, 1, 0, true, 5, blocked);
  assert.ok(r.x < CELL_W * 2, "did not climb onto the l1 wall");
});

test("surface speed multiplier scales distance", () => {
  const slow = stepMovement(100, 100, 1, 0, false, 1, undefined, 0.5).x - 100;
  const full = stepMovement(100, 100, 1, 0, false, 1, undefined, 1).x - 100;
  assert.equal(full, WALK_SPEED);
  assert.equal(slow, WALK_SPEED * 0.5);
});

test("findSpawn returns standable open land, never water", () => {
  const g = grid3x3();
  const s = findSpawn(g);
  assert.equal(isStandableAtWorld(g, s.x, s.y), true);
});

test("stepStamina drains in water, drowns at zero, regenerates on land", () => {
  const drain = stepStamina(MAX_STAMINA, true, 1);
  assert.equal(drain.stamina, MAX_STAMINA - SWIM_DRAIN);
  assert.equal(drain.drowned, false);

  const drowned = stepStamina(5, true, 1); // 5 - 20*1 <= 0
  assert.equal(drowned.stamina, 0);
  assert.equal(drowned.drowned, true);

  const regen = stepStamina(50, false, 1);
  assert.ok(regen.stamina > 50 && regen.stamina <= MAX_STAMINA);
  assert.equal(regen.drowned, false);
});
