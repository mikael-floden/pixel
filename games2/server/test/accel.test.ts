// THE ACCELERATION RAMP (maintainer 2026-09-13: "The player's acceleration from
// standing still to running fast is way way way too fast right now. It kinda
// feels like we go from 0% to 100% on a single frame. Create a slider for this
// and make the new default 5x as slow as today"). Shared accelStep; the factor
// rides per input (InputMessage.ac) so prediction, replay and the server agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accelStep, ACCEL_S_DEFAULT, ACCEL_S_MIN, ACCEL_S_MAX,
  walkHeading, buildTerrainGrid, stepMovement, makeBlocked, makeSideBlocked, WALK_CLIMB, CELL_WU,
  type TerrainGrid, type SlideMemo, type AutopilotTrip,
} from "@nangijala/shared";

test("rest to full speed in the dial's time, linearly; released, it falls at the same rate; 0 is today's instant law", () => {
  assert.equal(ACCEL_S_MIN, 0);
  assert.ok(ACCEL_S_MAX >= 1);
  // HIS NUMBER, not the arithmetic it came from: "5x as slow as today" gave
  // 0.17 (five frames of 33 ms) and he then tuned it by feel to 0.21
  // (2026-09-18). A taste verdict is pinned exactly, so a later refactor that
  // moves the dial has to come back through him.
  assert.equal(ACCEL_S_DEFAULT, 0.21, `default ${ACCEL_S_DEFAULT} s is his tuned ramp`);
  let f = 0;
  const T = 5 * 0.033;
  const path: number[] = [];
  for (let i = 0; i < 6; i++) {
    f = accelStep(f, true, 0.033, T);
    path.push(f);
  }
  assert.ok(Math.abs(path[0] - 0.2) < 1e-9 && Math.abs(path[3] - 0.8) < 1e-9, `a fifth a frame: ${path.map((v) => v.toFixed(2)).join(" ")}`);
  assert.equal(path[4], 1, "full speed on the fifth frame");
  assert.equal(path[5], 1, "and it stays there");
  // Released: down at the same rate, so a press within the ramp resumes.
  assert.ok(Math.abs(accelStep(1, false, T / 2, T) - 0.5) < 1e-9, "half the ramp after half its time released");
  assert.equal(accelStep(0.1, false, 1, T), 0, "and never below rest");
  // The instant law: 0 on the dial.
  assert.equal(accelStep(0, true, 0.016, 0), 1, "instant: full speed on the first frame");
  assert.equal(accelStep(1, false, 0.016, 0), 0, "instant: rest at once");
  // Garbage in stays inside [0, 1].
  assert.equal(accelStep(7, true, 0.01, T), 1);
  assert.equal(accelStep(NaN, true, 0.033, T), 0.2);
});

test("the window is integrated under the ramp's MEAN over it — the exact integral of a linear ramp", () => {
  // The client previews the not-yet-sent tail under (start + end) / 2 and
  // stamps the window with that number (InputMessage.ac); the same number
  // integrated once over the window covers what a fine integration would.
  const T = ACCEL_S_DEFAULT;
  for (const [f0, dt] of [[0, 0.05], [0.3, 0.05], [0.5, 0.02], [0.9, 0.016]] as const) {
    const fEnd = accelStep(f0, true, dt, T);
    const mean = (f0 + fEnd) / 2;
    let fine = 0;
    let f: number = f0;
    const n = 1000;
    for (let i = 0; i < n; i++) {
      const g = accelStep(f, true, dt / n, T);
      fine += ((f + g) / 2) * (dt / n);
      f = g;
    }
    assert.ok(Math.abs(fine - mean * dt) < 1e-9, `from ${f0} over ${dt}s: mean ${mean.toFixed(4)} x dt vs fine ${fine.toFixed(6)}`);
  }
});

test("accelerating out of rest is not stuck: the escape's progress window scales with the commanded speed", () => {
  // Open ground, a one-second ramp on the dial, held screen-down at a walk
  // with the speed dial at its floor (0.5x). Without the share, the first
  // window sees half the rate's ask and plans an escape across nothing; with
  // it, none is planned. (At 1.2x a walk's first 132 ms window covers 0.985
  // wu against an ask of 0.924 and passes by a hair — the share is what keeps
  // that from being luck.)
  const W = 40;
  const H = 40;
  const rows = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ t: "grass", l: 0 })));
  const grid: TerrainGrid = buildTerrainGrid(W, H, rows, [], []);
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  const run = (withShare: boolean) => {
    let x = 20 * CELL_WU;
    let y = 20 * CELL_WU;
    let f = 0;
    let t = 0;
    let trip: AutopilotTrip | null = null;
    const memo: SlideMemo = { ax: 0, ay: 0 };
    let escapes = 0;
    for (let i = 0; i < 40; i++) {
      t += 33;
      const fEnd = accelStep(f, true, 0.033, 1.0);
      const r = walkHeading(grid, x, y, 0, 1, memo, {
        nowMs: t, trip, fromElev: 0, worldW: W * CELL_WU, worldH: H * CELL_WU, stuckMs: 100,
        ...(withShare ? { speedFrac: fEnd } : {}),
      });
      if (r.trip && !trip) escapes++;
      trip = r.trip;
      const m = stepMovement(x, y, r.ax, r.ay, false, 0.033, makeBlocked(grid, walk), 0.5 * ((f + fEnd) / 2), true, W * CELL_WU, H * CELL_WU, makeSideBlocked(grid, walk), { screenSlide: trip === null });
      x = m.x;
      y = m.y;
      f = fEnd;
    }
    return escapes;
  };
  assert.ok(run(false) > 0, "without the share a slow ramp reads as stuck (the reason the share exists)");
  assert.equal(run(true), 0, "with it, accelerating across open ground plans nothing");
});
