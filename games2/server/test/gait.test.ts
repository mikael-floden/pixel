// WALK OR RUN FOLLOWS THE BODY'S ACTUAL SPEED (maintainer 2026-09-13: "when it
// comes to the player running into a wall the player movement is not that much
// so the player should here not run. The player should walk. The switch from
// when the player walk/run depends on the player's speed after the collision
// with the wall has been done and the v was cut and ended up as a small
// sliding"). The shared rule both sides ask: the client for its predicted body,
// the server per input for everyone else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gaitRunning, GAIT_RUN_ON, GAIT_RUN_OFF, WALK_SPEED, RUN_SPEED, PLAYER_SPEED_DEFAULT } from "@nangijala/shared";

const walk = WALK_SPEED * PLAYER_SPEED_DEFAULT;
const run = RUN_SPEED * PLAYER_SPEED_DEFAULT;

test("a free run runs; a run the wall cut to a crawl walks", () => {
  assert.equal(gaitRunning(false, run, walk), true, "free running");
  assert.equal(gaitRunning(true, run * 0.71, walk), true, "sliding at 45 degrees along a wall is still a run");
  assert.equal(gaitRunning(true, run * 0.3, walk), false, "cut to a crawl: walk");
  assert.equal(gaitRunning(true, 0, walk), false, "square on, going nowhere: walk");
});

test("hysteresis: the line is crossed going up at GAIT_RUN_ON and going down at GAIT_RUN_OFF, never flickering between", () => {
  assert.ok(GAIT_RUN_ON > 1 && GAIT_RUN_OFF < 1 && GAIT_RUN_OFF < GAIT_RUN_ON);
  const between = walk * (GAIT_RUN_ON + GAIT_RUN_OFF) / 2;
  assert.equal(gaitRunning(false, between, walk), false, "walking at a walk's pace stays a walk");
  assert.equal(gaitRunning(true, between, walk), true, "running at a walk's pace stays a run");
  assert.equal(gaitRunning(false, walk * GAIT_RUN_ON, walk), true);
  assert.equal(gaitRunning(true, walk * GAIT_RUN_OFF - 1e-9, walk), false);
});
