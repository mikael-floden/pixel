// THE HOP INTO THE WALL (maintainer 2026-09-12): a run leaned even slightly into
// a ledge a jump would clear must climb it and keep its angle — never slide
// along the wall "forever". Headless, on the real shared tick: the same
// stepMovement / makeBlockedElev / resolveElevAt the server integrates with and
// the client predicts with, under the server's own jump semantics (JUMP_CLIMB
// for JUMP_MS at JUMP_SPEED_FACTOR, then JUMP_COOLDOWN_MS), driven frame by
// frame by `hopIntoWall` exactly as predictAndSend drives it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoJumpProbe,
  autoJumpWanted,
  hopIntoWall,
  worldAxisToScreenInput,
  screenToWorldVector,
  buildTerrainGrid,
  makeBlockedElev,
  makeSideBlocked,
  resolveElevAt,
  stepMovement,
  unstickFromSolids,
  CELL_WU,
  PLAYER_RADIUS,
  HOP_INTO_MIN,
  ISO_DX,
  ISO_DY,
  JUMP_MS,
  JUMP_COOLDOWN_MS,
  JUMP_CLIMB,
  WALK_CLIMB,
  JUMP_SPEED_FACTOR,
  type HopMemo,
} from "@nangijala/shared";

/* A 12x24 field: columns 0-5 at level 0, columns 6-11 raised. The wall line is
 * x = 6 cells; a body against it rests PLAYER_RADIUS west of that line, and a
 * slide along it has 20 cells of room before the world's edge. */
const N = 12;
const M = 24;
const WALL_X = 6 * CELL_WU;
const field = (raised: number) => {
  const g = (l: number) => ({ t: "grass", l });
  const rows = Array.from({ length: M }, () => Array.from({ length: N }, (_, c) => g(c >= 6 ? raised : 0)));
  return buildTerrainGrid(N, M, rows);
};

/** The SCREEN input whose world direction is (wx,wy) — the inverse of the iso
 *  remap, normalised the way a leaned stick vector is. */
const screenFor = (wx: number, wy: number) => {
  const ax = ((wx - wy) * ISO_DX) / 2;
  const ay = ((wx + wy) * ISO_DY) / 2;
  const len = Math.hypot(ax, ay);
  return { ax: ax / len, ay: ay / len };
};
/** A unit world push leaned `deg` degrees off +y (along the wall) toward +x (into it). */
const lean = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  return screenFor(Math.sin(a), Math.cos(a));
};

/** Run the real tick for `ms` with a held input; report when the feet climbed. */
function run(grid: ReturnType<typeof field>, input: { ax: number; ay: number }, opts: { running?: boolean; lateral?: boolean; ms?: number } = {}) {
  const running = opts.running ?? true;
  const dt = 1 / 60;
  let x = WALL_X - PLAYER_RADIUS;
  let y = 2 * CELL_WU;
  let elev = 0;
  let jumpUntil = -1;
  let jumpReadyAt = -1;
  let jumps = 0;
  let climbedAt = -1;
  let steeredMs = 0;
  const memo: HopMemo = { hop: null };
  const W = N * CELL_WU;
  const H = M * CELL_WU;
  for (let t = 0; t < (opts.ms ?? 3000); t += 1000 * dt) {
    const canJump = t >= jumpUntil && t >= jumpReadyAt;
    const r = hopIntoWall(grid, x, y, input.ax, input.ay, elev, t, canJump, memo, opts.lateral ?? true);
    if (r.jump) {
      jumpUntil = t + JUMP_MS;
      jumpReadyAt = jumpUntil + JUMP_COOLDOWN_MS;
      jumps++;
    }
    if (r.ax !== input.ax || r.ay !== input.ay) steeredMs += 1000 * dt;
    const jumping = t < jumpUntil;
    const ctx = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
    const u = unstickFromSolids(grid, x, y, 80 * dt, undefined, elev);
    x = u.x;
    y = u.y;
    const m = stepMovement(
      x, y, r.ax, r.ay, running, dt,
      makeBlockedElev(grid, ctx, () => elev),
      jumping ? JUMP_SPEED_FACTOR : 1,
      true,
      W, H,
      makeSideBlocked(grid, ctx, () => elev),
    );
    x = m.x;
    y = m.y;
    elev = resolveElevAt(grid, elev, x, y, ctx);
    if (elev >= 1 && climbedAt < 0) climbedAt = t;
  }
  return { x, y, elev, jumps, climbedAt, steeredMs, y0: 2 * CELL_WU };
}

test("the lateral probe: a push leaned into a jumpable wall beside the run is a jump, a parallel one is not", () => {
  const g = field(2);
  const x = WALL_X - PLAYER_RADIUS;
  const y = 2 * CELL_WU;
  // The old probe, unchanged: along +y the wall is beside the run, so it never
  // fires — that is the slide this exists to end.
  assert.equal(autoJumpWanted(g, x, y, 0.1, 0.995), false, "the dominant-axis probe alone does not reach a wall beside the run");
  assert.equal(autoJumpWanted(g, x, y, 1, 0), true, "straight into the wall it still fires");
  const p = autoJumpProbe(g, x, y, 0.1, 0.995);
  assert.deepEqual(p, { jump: true, lateral: true, nx: 1, ny: 0 }, "a 6-degree lean into the wall is a LATERAL jump into +x");
  assert.equal(autoJumpProbe(g, x, y, 0, 1).jump, false, "exactly along the wall: not wanted");
  assert.equal(autoJumpProbe(g, x, y, -0.1, 0.995).jump, false, "leaning AWAY from the wall: not wanted");
  assert.equal(autoJumpProbe(g, x, y, HOP_INTO_MIN / 2, 1).jump, false, "inside the dead band: jitter, not a lean");
  assert.equal(autoJumpProbe(g, x, y, 0.1, 0.995, undefined, false).jump, false, "lateral off (the autopilot) keeps the old rule");
  assert.deepEqual(autoJumpProbe(g, x, y, 1, 0), { jump: true, lateral: false, nx: 1, ny: 0 }, "straight ahead is not lateral");
  assert.equal(autoJumpProbe(field(3), x, y, 0.1, 0.995).jump, false, "a 3-level wall is not jumpable, lean or not");
  assert.equal(autoJumpProbe(field(1), x, y, 0.1, 0.995).jump, false, "a 1-level step just walks up");
  // The wall on the other axis, for the y branch.
  assert.deepEqual(autoJumpProbe(g, y, x, 0.995, 0.1).jump, false, "no wall beside a run along +x here");
});

test("worldAxisToScreenInput is the exact key pair the grid-axis lock maps onto that world axis", () => {
  for (const [nx, ny] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const s = worldAxisToScreenInput(nx, ny);
    assert.ok(Math.abs(Math.abs(s.ax) - Math.abs(s.ay)) < 1e-9, "an exact diagonal, so the lock applies");
    // The lock answers the axis at the diagonal press's own iso pace (not a
    // unit vector), so compare the DIRECTION.
    const w = screenToWorldVector(s.ax, s.ay);
    assert.equal(Math.sign(w.x), nx, `(${nx},${ny}) x`);
    assert.equal(Math.sign(w.y), ny, `(${nx},${ny}) y`);
    assert.ok(Math.abs(nx ? w.y : w.x) < 1e-9, `(${nx},${ny}) is on the axis`);
  }
});

test("leaned into the wall, the run hops up in one jump and keeps its angle; without the hop it slides forever", () => {
  const g = field(2);
  const in6 = lean(6);
  const hop = run(g, in6);
  assert.ok(hop.climbedAt >= 0 && hop.climbedAt <= 700, `climbed within one jump window (at ${hop.climbedAt} ms)`);
  assert.equal(hop.jumps, 1, "one hop, not a series along the wall");
  assert.equal(hop.elev, 2, "on the upper platform at the end");
  assert.ok(hop.x > WALL_X, "past the wall line");
  assert.ok(hop.steeredMs <= JUMP_MS + 17, `steered for at most one window (${hop.steeredMs} ms)`);
  assert.ok(hop.y > hop.y0 + 150, `still running along its angle after the climb (${(hop.y - hop.y0).toFixed(0)} wu on)`);
  // The same input under the old rule: the body runs along the wall and never climbs.
  const slide = run(g, in6, { lateral: false });
  console.log(
    `hop: 6-degree lean climbed at ${hop.climbedAt.toFixed(0)} ms in ${hop.jumps} hop, steered ${hop.steeredMs.toFixed(0)} ms, ` +
      `${(hop.y - hop.y0).toFixed(0)} wu on at 3 s; old rule: elev ${slide.elev}, ${(slide.y - slide.y0).toFixed(0)} wu along the wall`,
  );
  assert.equal(slide.jumps, 0, "the dominant-axis probe never fires beside the wall");
  assert.equal(slide.elev, 0, "still on the low ground after 3 s");
  assert.ok(slide.x <= WALL_X - PLAYER_RADIUS + 1e-6, "pressed against the wall the whole way");
  assert.ok(slide.y > slide.y0 + 300, "sliding along it — the run the finger did not ask for");
});

test("walking (not running) climbs too; a parallel run never hops; a 3-level wall still slides", () => {
  const g = field(2);
  const walk = run(g, lean(10), { running: false });
  assert.equal(walk.jumps, 1, "one hop walking");
  assert.equal(walk.elev, 2, "walked up onto the platform");
  const parallel = run(g, screenFor(0, 1));
  assert.equal(parallel.jumps, 0, "a run held exactly along the wall is left alone");
  assert.equal(parallel.elev, 0);
  const tall = run(field(3), lean(10));
  assert.equal(tall.jumps, 0, "an unjumpable wall never hops");
  assert.equal(tall.elev, 0);
});

test("a hop lets go the moment the finger stops pushing into that wall", () => {
  const g = field(2);
  const x = WALL_X - PLAYER_RADIUS;
  const y = 2 * CELL_WU;
  const memo: HopMemo = { hop: null };
  const in6 = lean(6);
  const first = hopIntoWall(g, x, y, in6.ax, in6.ay, 0, 1000, true, memo);
  assert.equal(first.jump, true);
  assert.ok(memo.hop, "a lateral hop is remembered");
  assert.deepEqual({ ax: first.ax, ay: first.ay }, worldAxisToScreenInput(1, 0), "the run is steered into the wall");
  const held = hopIntoWall(g, x, y, in6.ax, in6.ay, 0, 1100, false, memo);
  assert.deepEqual({ ax: held.ax, ay: held.ay }, worldAxisToScreenInput(1, 0), "still steering while airborne and pushing");
  assert.equal(held.jump, false);
  const along = screenFor(0, 1);
  const off = hopIntoWall(g, x, y, along.ax, along.ay, 0, 1200, false, memo);
  assert.deepEqual({ ax: off.ax, ay: off.ay }, along, "parallel again: the angle is handed back at once");
  assert.equal(memo.hop, null, "and the hop is forgotten");
  // Climbing ends it as well, even mid-window.
  hopIntoWall(g, x, y, in6.ax, in6.ay, 0, 2000, true, memo);
  const up = hopIntoWall(g, x, y, in6.ax, in6.ay, 2, 2050, false, memo);
  assert.deepEqual({ ax: up.ax, ay: up.ay }, in6, "the feet climbed: the finger's angle is back");
  assert.equal(memo.hop, null);
});
