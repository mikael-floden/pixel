// WALK OR RUN FOLLOWS THE BODY'S ACTUAL SPEED (maintainer 2026-09-13: "when it
// comes to the player running into a wall the player movement is not that much
// so the player should here not run. The player should walk. The switch from
// when the player walk/run depends on the player's speed after the collision
// with the wall has been done and the v was cut and ended up as a small
// sliding"; the same evening: "we switch from walking to running at too low
// velocity. The switch should come 50% closer to max speed"). The shared rule
// both sides ask: the client for its predicted body, the server per input for
// everyone else — on the body's SCREEN speed, which is one number for one pace
// whichever way the body goes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gaitRunning, gaitSpeed, screenToWorldVector, GAIT_RUN_ON, GAIT_RUN_OFF, WALK_SPEED, RUN_SPEED, PLAYER_SPEED_DEFAULT,
} from "@nangijala/shared";

const walk = WALK_SPEED * PLAYER_SPEED_DEFAULT;
const run = RUN_SPEED * PLAYER_SPEED_DEFAULT;

test("a free run runs; a run the wall cut to its slide walks — from a run as well as from a walk", () => {
  assert.equal(gaitRunning(false, run, walk), true, "free running");
  assert.equal(gaitRunning(true, run, walk), true, "still free running");
  // A cardinal key slides along a terrain wall at 71% of the run (the world
  // cosine, slideShare): the walk, whichever gait the body arrived with.
  assert.equal(gaitRunning(true, run * 0.71, walk), false, "sliding at 71%: a walk, even out of a run");
  assert.equal(gaitRunning(false, run * 0.71, walk), false, "sliding at 71%: a walk");
  assert.equal(gaitRunning(true, run * 0.42, walk), false, "65 degrees in, 42%: walk");
  assert.equal(gaitRunning(true, run * 0.3, walk), false, "cut to a crawl: walk");
  assert.equal(gaitRunning(true, 0, walk), false, "square on, going nowhere: walk");
  assert.equal(gaitRunning(false, run * 0.9, walk), true, "a run through thick grass at 90%: a run");
});

test("the line sits above the 71% plateau and below the run, with a band between and no plateau inside it", () => {
  const runWalks = RUN_SPEED / WALK_SPEED; // 2.5
  assert.ok(GAIT_RUN_OFF > 0.71 * runWalks + 0.02, `the run's edge ${GAIT_RUN_OFF} is above the cardinal slide's ${(0.71 * runWalks).toFixed(3)}`);
  assert.ok(GAIT_RUN_ON < runWalks, "the line is below the free run");
  assert.ok(GAIT_RUN_ON > GAIT_RUN_OFF, "on above off");
  // 50% closer to the run than the old line (1.15 walks, 46% of the run) is 73%; the line sits at 80%.
  assert.ok(GAIT_RUN_ON / runWalks >= 0.73, `the line at ${(GAIT_RUN_ON / runWalks * 100).toFixed(0)}% of the run`);
  const between = walk * (GAIT_RUN_ON + GAIT_RUN_OFF) / 2;
  assert.equal(gaitRunning(false, between, walk), false, "walking inside the band stays a walk");
  assert.equal(gaitRunning(true, between, walk), true, "running inside the band stays a run");
  assert.equal(gaitRunning(false, walk * GAIT_RUN_ON, walk), true);
  assert.equal(gaitRunning(true, walk * GAIT_RUN_OFF - 1e-9, walk), false);
});

test("gaitSpeed: a free step measures the walk's pace whichever way it goes; world units did not", () => {
  const dt = 0.033;
  const worldLens: number[] = [];
  for (const [ax, ay, name] of [[0, -1, "up"], [1, 0, "right"], [-1, -1, "up-left (a grid axis)"], [0.3, 0.95, "a leaned stick"]] as const) {
    const w = screenToWorldVector(ax, ay);
    const dx = w.x * WALK_SPEED * dt;
    const dy = w.y * WALK_SPEED * dt;
    assert.ok(Math.abs(gaitSpeed(dx, dy, dt) - WALK_SPEED) < 1e-6, `${name}: ${gaitSpeed(dx, dy, dt).toFixed(3)} for a walk of ${WALK_SPEED}`);
    worldLens.push(Math.hypot(dx, dy) / dt);
  }
  assert.ok(Math.max(...worldLens) / Math.min(...worldLens) > 2, `world units vary by direction: ${worldLens.map((v) => v.toFixed(0)).join(" ")}`);
  assert.equal(gaitSpeed(1, 1, 0), 0, "no time, no speed");
});
