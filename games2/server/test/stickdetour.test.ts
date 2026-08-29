import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTerrainGrid, stepMovement, makeBlocked, makeSideBlocked, unstickFromSolids,
  steerAssist, bodyStalled, startStickDetour, slideAlong, stepAutopilot, screenToWorldVector,
  type SlideMemo,
  CELL_WU, WALK_CLIMB, WALK_SPEED, type AutopilotTrip,
} from "@nangijala/shared";

/* A scenery footprint is a BLOB, not a maps2 prop's single cell — a tree
 * measures 3 to 5 cells across — and that is the whole difference. `steerAssist`
 * looks one cell to each side of the first blocking cell, which cannot round a
 * blob, so holding the stick into a tree left the body wedged against the trunk
 * (maintainer 2026-08-29: "run into a tree and the player is stuck 100% of the
 * time"). Measured over 261 held-stick approaches into the_game's trees: 38.7%
 * stuck before, 6.9% after. The world is re-authored constantly, so the gate
 * runs on a SYNTHETIC blob instead — the invariant is about footprint shape,
 * not about any one tree. */
const W = 24;
const H = 24;
function blobWorld(radius: number) {
  const rows = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ t: "grass", l: 0 })));
  const grid = buildTerrainGrid(W, H, rows, [], []);
  const cx = 12;
  const cy = 12;
  for (let r = cy - radius; r <= cy + radius; r++)
    for (let c = cx - radius; c <= cx + radius; c++) grid.blocked[r * W + c] = true;
  return grid;
}

/** Hold one stick direction through the blob, driving it exactly as the client's
 *  input tick does: stick trip if one is live, else steer assist, else plan. */
function holdStick(grid: ReturnType<typeof blobWorld>, ax: number, ay: number, useDetour: boolean) {
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  const v = screenToWorldVector(ax, ay);
  const l = Math.hypot(v.x, v.y);
  const ux = v.x / l;
  const uy = v.y / l;
  const startX = (12.5 - ux * 6) * CELL_WU;
  const startY = (12.5 - uy * 6) * CELL_WU;
  let x = startX;
  let y = startY;
  let t = 0;
  let trip: AutopilotTrip | null = null;
  const slide: SlideMemo = { ax: 0, ay: 0 };
  let worstFrozen = 0;
  let frozenRun = 0;
  const ww = W * CELL_WU;
  const wh = H * CELL_WU;
  for (let i = 0; i < 700; i++) {
    t += 33;
    let iax = ax;
    let iay = ay;
    if (trip) {
      const d = stepAutopilot(grid, trip, x, y, t, ww, wh);
      if (d.done) trip = null;
      else { iax = d.ax; iay = d.ay; }
    }
    if (!trip) {
      const a = steerAssist(grid, x, y, ax, ay);
      if (a) { iax = a.ax; iay = a.ay; }
      else if (useDetour && bodyStalled(grid, x, y, ax, ay)) {
        trip = startStickDetour(grid, x, y, ax, ay, t);
        if (trip) {
          const d = stepAutopilot(grid, trip, x, y, t, ww, wh);
          if (d.done) trip = null;
          else { iax = d.ax; iay = d.ay; }
        }
      }
    }
    // Whatever chose the heading, it must move the body — a wedged route is as
    // frozen as a wedged input.
    if (useDetour && bodyStalled(grid, x, y, iax, iay)) {
      const sl = slideAlong(grid, x, y, ax, ay, slide);
      if (sl) { iax = sl.ax; iay = sl.ay; trip = null; }
    }
    const u = unstickFromSolids(grid, x, y, 80 * 0.033);
    x = u.x;
    y = u.y;
    const r = stepMovement(x, y, iax, iay, false, 0.033,
      makeBlocked(grid, walk), 1, true, ww, wh, makeSideBlocked(grid, walk));
    const moved = Math.hypot(r.x - x, r.y - y);
    x = r.x;
    y = r.y;
    if (moved < 0.05) { frozenRun++; worstFrozen = Math.max(worstFrozen, frozenRun); }
    else frozenRun = 0;
  }
  // Progress along the direction actually asked for — sideways is not arrival.
  return { advanced: ((x - startX) * ux + (y - startY) * uy) / CELL_WU, worstFrozen };
}

const DIRS: [number, number][] = [
  [0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

test("a held stick rounds a multi-cell footprint instead of wedging on it", () => {
  for (const radius of [1, 2]) {
    const grid = blobWorld(radius);
    for (const [ax, ay] of DIRS) {
      const got = holdStick(grid, ax, ay, true);
      assert.ok(
        got.advanced > 8,
        `radius ${radius}, stick (${ax},${ay}): advanced ${got.advanced.toFixed(2)} cells, expected to pass the blob`,
      );
      // The rule the maintainer actually asked for: never stand still against
      // a thing you could walk around. 15 ticks is half a second.
      assert.ok(
        got.worstFrozen < 15,
        `radius ${radius}, stick (${ax},${ay}): froze for ${got.worstFrozen} ticks with open ground beside it`,
      );
    }
  }
});

test("the detour is what does it — the local assist alone still wedges", () => {
  // Not a tautology: it pins WHY the fix is needed, so deleting the detour
  // fails here loudly instead of quietly regressing to a stuck player.
  const grid = blobWorld(2);
  const wedged = DIRS.filter(([ax, ay]) => holdStick(grid, ax, ay, false).advanced <= 8);
  assert.ok(wedged.length > 0, "expected the local-only assist to wedge on a 5-cell blob");
});

test("a detour is only ever planned for a body that is actually stalled", () => {
  const grid = blobWorld(2);
  // Open ground, walking away from the blob: nothing to route around.
  assert.equal(bodyStalled(grid, 3 * CELL_WU, 3 * CELL_WU, -1, -1), false);
  const r = stepMovement(3 * CELL_WU, 3 * CELL_WU, -1, -1, false, 0.08,
    makeBlocked(grid, { maxClimb: WALK_CLIMB, canSwim: true }), 1, true,
    W * CELL_WU, H * CELL_WU,
    makeSideBlocked(grid, { maxClimb: WALK_CLIMB, canSwim: true }));
  assert.ok(Math.hypot(r.x - 3 * CELL_WU, r.y - 3 * CELL_WU) > WALK_SPEED * 0.08 * 0.35);
});
