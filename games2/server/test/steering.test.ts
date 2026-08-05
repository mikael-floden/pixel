import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTerrainGrid,
  steerAssist,
  stepMovement,
  makeBlocked,
  makeSideBlocked,
  screenToWorldVector,
  TerrainGrid,
  CELL_WU,
  WALK_CLIMB,
} from "@nangijala/shared";

// ---------------------------------------------------------------------------
// Steer assist — the direct-input corner dodge. NOT navigation: it may only
// look at the tiles beside the ONE solid cell being run into, deflect toward
// the CLOSEST open side, and otherwise leave the input alone. These tests
// drive the pure shared function plus a real stepMovement integration loop
// (the same shape predictAndSend uses), so the feel is pinned headlessly.
// ---------------------------------------------------------------------------

/** Flat 16x16 grass world with solid props at the given cells. */
function world(props: { col: number; row: number }[], wall?: { c: number; r: number; l: number }[]): TerrainGrid {
  const rows: { t: string; l?: number }[][] = [];
  for (let r = 0; r < 16; r++) {
    rows.push([]);
    for (let c = 0; c < 16; c++) {
      const w = wall?.find((x) => x.c === c && x.r === r);
      rows[r].push({ t: "grass", l: w?.l ?? 0 });
    }
  }
  return buildTerrainGrid(16, 16, rows, props);
}

/** The 8-way SCREEN input whose world vector best matches a world direction. */
function screenFor(wx: number, wy: number): { ax: number; ay: number } {
  let best = { ax: 0, ay: 0 };
  let bestDot = -Infinity;
  for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const w = screenToWorldVector(ax, ay);
    const l = Math.hypot(w.x, w.y) || 1;
    const dot = (w.x * wx + w.y * wy) / l;
    if (dot > bestDot) {
      bestDot = dot;
      best = { ax, ay };
    }
  }
  return best;
}

const worldDirOf = (inp: { ax: number; ay: number }) => {
  const w = screenToWorldVector(inp.ax, inp.ay);
  const l = Math.hypot(w.x, w.y) || 1;
  return { x: w.x / l, y: w.y / l };
};

// Prop at cell (8,8); its west face is x = 8*32 = 256.
const PROP = { col: 8, row: 8 };

test("head-on into a prop, leaning north: assist deflects to the NORTH side", () => {
  const g = world([PROP]);
  // Player just west of the prop face, slightly NORTH of its centreline.
  const x = 8 * CELL_WU - 14;
  const y = 8.35 * CELL_WU;
  const east = screenFor(1, 0);
  const out = steerAssist(g, x, y, east.ax, east.ay);
  assert.ok(out, "assist fires");
  const d = worldDirOf(out!);
  assert.ok(d.y < -0.9 && Math.abs(d.x) < 0.1, `deflects world-north, got (${d.x.toFixed(2)},${d.y.toFixed(2)})`);
});

test("leaning south picks the SOUTH side (closest wins)", () => {
  const g = world([PROP]);
  const out = steerAssist(g, 8 * CELL_WU - 14, 8.65 * CELL_WU, screenFor(1, 0).ax, screenFor(1, 0).ay);
  assert.ok(out, "assist fires");
  const d = worldDirOf(out!);
  assert.ok(d.y > 0.9, `deflects world-south, got (${d.x.toFixed(2)},${d.y.toFixed(2)})`);
});

test("closest side solid: falls back to the OTHER side", () => {
  // Second prop immediately NORTH of the target prop: north lane closed.
  const g = world([PROP, { col: 8, row: 7 }]);
  const out = steerAssist(g, 8 * CELL_WU - 14, 8.35 * CELL_WU, screenFor(1, 0).ax, screenFor(1, 0).ay);
  assert.ok(out, "assist still fires via the south side");
  const d = worldDirOf(out!);
  assert.ok(d.y > 0.9, `deflects world-south instead, got (${d.x.toFixed(2)},${d.y.toFixed(2)})`);
});

test("a solid WALL (both sides solid): no assist — run into it honestly", () => {
  const g = world([{ col: 8, row: 7 }, PROP, { col: 8, row: 9 }]);
  const out = steerAssist(g, 8 * CELL_WU - 14, 8.5 * CELL_WU, screenFor(1, 0).ax, screenFor(1, 0).ay);
  assert.equal(out, null);
});

test("free ground ahead: no assist (input untouched while moving)", () => {
  const g = world([PROP]);
  const out = steerAssist(g, 4 * CELL_WU, 4 * CELL_WU, screenFor(1, 0).ax, screenFor(1, 0).ay);
  assert.equal(out, null);
});

test("a 2-level elevation ledge ahead is NOT an object: no assist (auto-jump's domain)", () => {
  const g = world([], [{ c: 8, r: 8, l: WALK_CLIMB + 1 }]);
  const out = steerAssist(g, 8 * CELL_WU - 14, 8.5 * CELL_WU, screenFor(1, 0).ax, screenFor(1, 0).ay);
  assert.equal(out, null);
});

test("wall-slide stays untouched: screen-cardinal input sliding along a prop still moves", () => {
  const g = world([PROP]);
  // Screen-right = world diagonal (SE): x-axis blocked by the prop face,
  // y-axis free — the classic slide. It moves, so the assist must stay out.
  const x = 8 * CELL_WU - 14;
  const y = 8.5 * CELL_WU;
  const out = steerAssist(g, x, y, 1, 0);
  assert.equal(out, null, "slide input left alone");
});

// The end-to-end feel: hold "east" from west of the prop, slightly off-centre,
// and integrate the REAL movement with the assist applied per tick exactly
// like predictAndSend. The player must round the corner and end up EAST of
// the prop, never entering its cell, within a few simulated seconds.
test("integration: holding east rounds the prop corner and continues east", () => {
  const g = world([PROP]);
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  let x = 7 * CELL_WU;
  let y = 8.3 * CELL_WU; // clips the prop's north corner region
  const east = screenFor(1, 0);
  const dt = 1 / 20;
  let assisted = 0;
  for (let t = 0; t < 8 / dt; t++) {
    let { ax, ay } = east;
    const a = steerAssist(g, x, y, ax, ay);
    if (a) {
      ax = a.ax;
      ay = a.ay;
      assisted++;
    }
    const r = stepMovement(
      x, y, ax, ay, true, dt,
      makeBlocked(g, walk), 1, true, 16 * CELL_WU, 16 * CELL_WU,
      makeSideBlocked(g, walk),
    );
    x = r.x;
    y = r.y;
    assert.ok(
      !(Math.floor(x / CELL_WU) === PROP.col && Math.floor(y / CELL_WU) === PROP.row),
      "never inside the prop cell",
    );
    if (x > (PROP.col + 1.5) * CELL_WU) break; // cleanly past the object
  }
  assert.ok(assisted > 0, "the assist engaged at least once");
  assert.ok(
    x > (PROP.col + 1.5) * CELL_WU,
    `ended east of the prop (x=${(x / CELL_WU).toFixed(2)} cells, want > ${PROP.col + 1.5})`,
  );
});

test("integration: dead into a 3-prop wall stays honestly stuck", () => {
  const g = world([{ col: 8, row: 7 }, PROP, { col: 8, row: 9 }]);
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  let x = 7.2 * CELL_WU;
  let y = 8.5 * CELL_WU;
  const east = screenFor(1, 0);
  const dt = 1 / 20;
  for (let t = 0; t < 3 / dt; t++) {
    let { ax, ay } = east;
    const a = steerAssist(g, x, y, ax, ay);
    if (a) {
      ax = a.ax;
      ay = a.ay;
    }
    const r = stepMovement(
      x, y, ax, ay, true, dt,
      makeBlocked(g, walk), 1, true, 16 * CELL_WU, 16 * CELL_WU,
      makeSideBlocked(g, walk),
    );
    x = r.x;
    y = r.y;
  }
  assert.ok(x < 8 * CELL_WU, "still west of the wall");
  assert.ok(Math.abs(y - 8.5 * CELL_WU) < CELL_WU * 0.6, "not silently detoured sideways");
});
