// HOW CLOSE THE BODY GETS TO A WALL, FROM EVERY DIRECTION (docs/movement.md).
// The forward probe stops a head-on walk PLAYER_RADIUS short of a wall; the
// LATERAL probes read solids only (so a wall beside the path cannot wedge a
// cliff descent), so a body carried any lateral offset it liked along a wall —
// walk down the free column beside a wall that starts further on and the wall
// simply appears at your shoulder, 5.2wu away where a head-on run stops at
// 12.3-14.0 (maintainer 2026-09-15: "walking around a corner I sometimes can
// get much closer to the wall than if I run straight into a wall ... the
// players TORCH doesn't even light it up and it looks bad").
//
// HIS OWN SPOT IS THIS ELBOW, exactly: col 250 of the_game is level 4 through
// row 279 and level 12 from row 280 down, so the 8-storey face at the 250/251
// boundary BEGINS beside a body walking down col 251. He stood at 251.0,282 —
// his centre ON the plane — where running at the same face rests him at
// 251.2-251.4. The grid below is that corner, synthetic so the test needs no
// world tree.
//
// The fix is a STANDOFF, not a tighter probe: unstickFromSolids keeps the body
// WALL_STANDOFF off any face it cannot walk up, so the state is corrected
// where a refused move would wedge every corner. This holds that, and holds
// the three things the standoff must not break: a door still passes, a
// corridor centres instead of railing, and a rim stays forgiving.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTerrainGrid,
  stepMovement,
  makeBlockedElev,
  makeSideBlocked,
  unstickFromSolids,
  levelAtWorld,
  walkHeading,
  CELL_WU,
  WALK_CLIMB,
  ISO_DX,
  ISO_DY,
  PLAYER_RADIUS,
  WALL_STANDOFF,
  type SlideMemo,
  type AutopilotTrip,
  type TerrainGrid,
} from "@nangijala/shared";

const W = 24;
const H = 24;

/** The SCREEN unit vector whose world direction is (wx,wy). */
const screenFor = (wx: number, wy: number) => {
  const ax = ((wx - wy) * ISO_DX) / 2;
  const ay = ((wx + wy) * ISO_DY) / 2;
  const len = Math.hypot(ax, ay);
  return { ax: ax / len, ay: ay / len };
};

/** Hold one stick for `ticks` frames of 33 ms, driven the way predictAndSend
 *  drives it: the rescue first, then the movement step. `standoff` false drops
 *  the elevation from the rescue call — the pre-fix rescue, the bisect arm. */
function hold(
  grid: TerrainGrid,
  col: number,
  row: number,
  s: { ax: number; ay: number },
  ticks: number,
  standoff = true,
) {
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  let x = col * CELL_WU;
  let y = row * CELL_WU;
  let elev = levelAtWorld(grid, x, y);
  let t = 0;
  let trip: AutopilotTrip | null = null;
  const memo: SlideMemo = { ax: 0, ay: 0 };
  const ww = grid.width * CELL_WU;
  const wh = grid.height * CELL_WU;
  const path: { x: number; y: number }[] = [];
  for (let i = 0; i < ticks; i++) {
    t += 33;
    const r = walkHeading(grid, x, y, s.ax, s.ay, memo, { nowMs: t, trip, fromElev: elev, worldW: ww, worldH: wh });
    trip = r.trip;
    const wax = r.deflected ? r.ax : s.ax;
    const way = r.deflected ? r.ay : s.ay;
    const u = unstickFromSolids(grid, x, y, 80 * 0.033, undefined, standoff ? elev : undefined);
    x = u.x;
    y = u.y;
    const m = stepMovement(x, y, wax, way, true, 0.033, makeBlockedElev(grid, walk, () => elev), 1, true, ww, wh, makeSideBlocked(grid, walk, () => elev), { screenSlide: true });
    x = m.x;
    y = m.y;
    elev = levelAtWorld(grid, x, y);
    path.push({ x, y });
  }
  return { x, y, path, col: x / CELL_WU, row: y / CELL_WU };
}

const WALLX = 6 * CELL_WU; // the plane of every wall below: cells 6+ are raised

/** One long wall: every cell from col 6 east is a 6-storey wall. */
function longWall(): TerrainGrid {
  const rows = Array.from({ length: H }, () => Array.from({ length: W }, (_, c) => ({ t: "grass", l: c >= 6 ? 6 : 0 })));
  return buildTerrainGrid(W, H, rows, [], []);
}

/** THE ELBOW: the same wall, but only from row 10 down — so its face BEGINS
 *  beside a body walking down the free column, which is his corner. */
function elbow(): TerrainGrid {
  const rows = Array.from({ length: H }, (_, r) => Array.from({ length: W }, (_, c) => ({ t: "grass", l: c >= 6 && r >= 10 ? 6 : 0 })));
  return buildTerrainGrid(W, H, rows, [], []);
}

/** The closest the body's centre ever came to the wall plane while beside the
 *  face (row 10 and below), and where it came to rest. */
function beside(path: { x: number; y: number }[]): number {
  let best = Infinity;
  for (const q of path) if (q.y >= 10 * CELL_WU && q.x < WALLX) best = Math.min(best, WALLX - q.x);
  return best;
}

test("running straight at a wall rests PLAYER_RADIUS short of it, from every heading", () => {
  for (const [name, s] of [
    ["world +x", screenFor(1, 0)],
    ["world +x +0.3y", screenFor(1, 0.3)],
    ["screen down (+x +y)", screenFor(1, 1)],
    ["screen right (+x -y)", screenFor(1, -1)],
  ] as const) {
    const r = hold(longWall(), 3, 5.5, s, 300);
    const clr = WALLX - r.x;
    assert.ok(clr >= PLAYER_RADIUS - 0.01, `${name}: rests ${clr.toFixed(2)}wu off the wall, inside PLAYER_RADIUS`);
    assert.ok(clr <= PLAYER_RADIUS + 2.5, `${name}: rests ${clr.toFixed(2)}wu off the wall — further than one substep past the probe`);
  }
});

test("a wall met AROUND ITS CORNER ends up as far away as one met head-on", () => {
  const down = screenFor(0, 1);
  // Walking down the wall's own column: the face appears at the shoulder.
  const r = hold(elbow(), 6.5, 6, down, 400);
  assert.ok(WALLX - r.x >= WALL_STANDOFF - 0.01, `at rest ${(WALLX - r.x).toFixed(2)}wu off the face, inside the standoff`);
  assert.ok(beside(r.path) >= 10, `came within ${beside(r.path).toFixed(2)}wu of the face while running past its corner`);
  // THE BUG, with the standoff off: the body rails along the face at 5.2wu.
  const bug = hold(elbow(), 6.5, 6, down, 400, false);
  assert.ok(beside(bug.path) < 6, `bisect: without the standoff the body should hug the face (got ${beside(bug.path).toFixed(2)}wu)`);
});

test("hugging the plane before the wall begins: the push frees the body inside 200 ms", () => {
  const down = screenFor(0, 1);
  const r = hold(elbow(), 5.99, 8, down, 200);
  const held = r.path.filter((q) => q.y >= 10 * CELL_WU && WALLX - q.x < WALL_STANDOFF - 0.05).length;
  assert.ok(held <= 6, `${held} ticks (${held * 33} ms) spent inside the standoff — the push is speed-limited, not instant`);
  assert.ok(WALLX - r.x >= WALL_STANDOFF - 0.01, `at rest ${(WALLX - r.x).toFixed(2)}wu off the face`);
});

test("a centre exactly ON the plane is pushed out — his 251.0", () => {
  const grid = longWall();
  const y = 12 * CELL_WU;
  let x = WALLX; // dead on the face, where the clamp gives no direction
  for (let i = 0; i < 20; i++) x = unstickFromSolids(grid, x, y, 80 * 0.033, undefined, 0).x;
  assert.ok(WALLX - x >= WALL_STANDOFF - 0.01, `stayed ${(WALLX - x).toFixed(2)}wu off the face`);
  // A body OVER the wall is resolveElevAt's, not the rescue's: left alone.
  const inside = WALLX + CELL_WU / 2;
  assert.equal(unstickFromSolids(grid, inside, y, 80 * 0.033, undefined, 0).x, inside);
});

test("a one-cell door still passes, from every offset across it", () => {
  const DC = 11;
  const DR = 13;
  const ring = () => {
    const rows = Array.from({ length: H }, (_, r) =>
      Array.from({ length: W }, (_, c) => {
        const wall = ((c === 7 || c === 14) && r >= 7 && r <= 13) || ((r === 7 || r === 13) && c >= 7 && c <= 14);
        return { t: "grass", l: wall && !(c === DC && r === DR) ? 6 : 0 };
      }),
    );
    return buildTerrainGrid(W, H, rows, [], []);
  };
  for (const off of [0, 0.15, 0.3, -0.15, -0.3]) {
    const r = hold(ring(), DC + 0.5 + off, 15, screenFor(0, -1), 300);
    assert.ok(r.row < DR, `from col ${(DC + 0.5 + off).toFixed(2)} the body never got through the door (rest ${r.col.toFixed(2)},${r.row.toFixed(2)})`);
  }
});

test("a one-cell corridor centres the body instead of railing it along one wall", () => {
  const corridor = () => {
    const rows = Array.from({ length: H }, () => Array.from({ length: W }, (_, c) => ({ t: "grass", l: c === 5 || c === 7 ? 6 : 0 })));
    return buildTerrainGrid(W, H, rows, [], []);
  };
  for (const startCol of [6.05, 6.5, 6.95]) {
    const r = hold(corridor(), startCol, 4, screenFor(0, 1), 200);
    const west = r.x - 6 * CELL_WU;
    const east = 7 * CELL_WU - r.x;
    assert.ok(west >= WALL_STANDOFF - 0.01 && east >= WALL_STANDOFF - 0.01, `from col ${startCol}: rests ${west.toFixed(1)}wu / ${east.toFixed(1)}wu between the walls`);
  }
});

test("a DESCENT stays forgiving, and a step you can walk up pushes nothing", () => {
  // A plateau: cols 0..5 at level 6, cols 6+ at level 0. A body standing on
  // the plateau 2wu from the rim must not be shoved back from the drop.
  const rim = buildTerrainGrid(
    W,
    H,
    Array.from({ length: H }, () => Array.from({ length: W }, (_, c) => ({ t: "grass", l: c >= 6 ? 0 : 6 }))),
    [],
    [],
  );
  const x = WALLX - 2;
  const y = 10 * CELL_WU;
  const u = unstickFromSolids(rim, x, y, 80 * 0.033, undefined, 6);
  assert.equal(u.x, x, "the rescue pushed a body back from a rim it may overhang");
  assert.equal(u.y, y, "the rescue moved a body standing at a rim");
  // A 1-level step is a walk, not a wall.
  const step = buildTerrainGrid(
    W,
    H,
    Array.from({ length: H }, () => Array.from({ length: W }, (_, c) => ({ t: "grass", l: c >= 6 ? WALK_CLIMB : 0 }))),
    [],
    [],
  );
  const v = unstickFromSolids(step, x, y, 80 * 0.033, undefined, 0);
  assert.equal(v.x, x, "the rescue pushed a body away from a step it can walk up");
});
