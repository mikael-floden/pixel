// THE WALL WALK (maintainer 2026-09-13, the spawn house's corner held down):
// running into a TERRAIN wall is the honest walk — straightened along it
// within the wall-assist angle, slid at the wall's own rate past it, stopped
// in a corner, steered only to a door that is not behind the run, and moved
// backwards only by the escape route and only one cell. Headless on the real
// shared tick, on a copy of the spawn house's levels, driven exactly as
// predictAndSend drives walkHeading (the leaned heading in, the deflection or
// the heading walked).
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
  wallContact,
  wallAngleDeg,
  hopIntoWall,
  routeRetreat,
  type SlideMemo,
  type AutopilotTrip,
  type HopMemo,
  type TerrainGrid,
  CELL_WU,
  WALK_CLIMB,
  ISO_DX,
  ISO_DY,
  WALL_ASSIST_DEG_DEFAULT,
  ESCAPE_RETREAT_CELLS,
  STUCK_ESCALATE_MS,
} from "@nangijala/shared";

/* The spawn house, copied from the_game around 296..303 x 191..197
 * (2026-09-13): a level-6 ring on a level-0 floor, six cells wide and five
 * tall, the door in the SOUTH wall two cells west of the south-east corner.
 * Here the ring is cols 7..14, rows 7..13 — col 7 is world 296, row 7 is world
 * 191 — so his two start spots (301.1,194.4) and (300.4,195.3) are (12.1,10.4)
 * and (11.4,11.3), the corner floor cell is (13,12), the door cell (11,13). */
const W = 22;
const H = 22;
const DOOR = { c: 11, r: 13 };
const START_A = { col: 12.1, row: 10.4 };
const START_B = { col: 11.4, row: 11.3 };
/** Where a body comes to rest in the south-east corner: PLAYER_RADIUS off both walls. */
const CORNER = { col: 13.62, row: 12.62 };
function house(): TerrainGrid {
  const rows = Array.from({ length: H }, (_, r) =>
    Array.from({ length: W }, (_, c) => {
      const ring = ((c === 7 || c === 14) && r >= 7 && r <= 13) || ((r === 7 || r === 13) && c >= 7 && c <= 14);
      const door = c === DOOR.c && r === DOOR.r;
      return { t: "grass", l: ring && !door ? 6 : 0 };
    }),
  );
  return buildTerrainGrid(W, H, rows, [], []);
}

/** A field with one long wall across x at col 6 (the hop test's field): a body
 *  against it rests PLAYER_RADIUS west of the line with 20 cells of room along it. */
function field(raised: number): TerrainGrid {
  const rows = Array.from({ length: 24 }, () => Array.from({ length: 12 }, (_, c) => ({ t: "grass", l: c >= 6 ? raised : 0 })));
  return buildTerrainGrid(12, 24, rows, [], []);
}

/** The SCREEN unit vector whose world direction is (wx,wy) — a leaned stick. */
const screenFor = (wx: number, wy: number) => {
  const ax = ((wx - wy) * ISO_DX) / 2;
  const ay = ((wx + wy) * ISO_DY) / 2;
  const len = Math.hypot(ax, ay);
  return { ax: ax / len, ay: ay / len };
};
/** A unit world push leaned `deg` degrees off +y (along the field's wall) toward +x (into it). */
const lean = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  return screenFor(Math.sin(a), Math.cos(a));
};

interface Held {
  col: number;
  row: number;
  minCol: number;
  maxRow: number;
  deflected: number;
  trips: number;
  outs: Set<string>;
  travelled: number;
}

/** Hold one stick from a spot for `ticks` frames of 33 ms, the client's way:
 *  the 8-way vector and the leaned heading go in; the deflection is walked as
 *  given, an undeflected answer walks the heading. */
function hold(
  grid: TerrainGrid,
  col: number,
  row: number,
  ax: number,
  ay: number,
  ticks: number,
  heading?: { ax: number; ay: number },
  wallAssistDeg?: number,
): Held {
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  let x = col * CELL_WU;
  let y = row * CELL_WU;
  let elev = levelAtWorld(grid, x, y);
  let t = 0;
  let trip: AutopilotTrip | null = null;
  const memo: SlideMemo = { ax: 0, ay: 0 };
  const ww = grid.width * CELL_WU;
  const wh = grid.height * CELL_WU;
  let minCol = col;
  let maxRow = row;
  let deflected = 0;
  let trips = 0;
  let travelled = 0;
  const outs = new Set<string>();
  for (let i = 0; i < ticks; i++) {
    t += 33;
    const r = walkHeading(grid, x, y, ax, ay, memo, {
      nowMs: t, trip, fromElev: elev, worldW: ww, worldH: wh, heading, wallAssistDeg,
    });
    trip = r.trip;
    if (trip) trips++;
    if (r.deflected) deflected++;
    outs.add(`${r.ax},${r.ay}`);
    const wax = r.deflected ? r.ax : (heading?.ax ?? ax);
    const way = r.deflected ? r.ay : (heading?.ay ?? ay);
    const ge = () => elev;
    const u = unstickFromSolids(grid, x, y, 80 * 0.033);
    x = u.x;
    y = u.y;
    const m = stepMovement(x, y, wax, way, false, 0.033, makeBlockedElev(grid, walk, ge), 1, true, ww, wh, makeSideBlocked(grid, walk, ge));
    travelled += Math.hypot(m.x - x, m.y - y);
    x = m.x;
    y = m.y;
    elev = levelAtWorld(grid, x, y);
    minCol = Math.min(minCol, x / CELL_WU);
    maxRow = Math.max(maxRow, y / CELL_WU);
  }
  return { col: x / CELL_WU, row: y / CELL_WU, minCol, maxRow, deflected, trips, outs, travelled };
}

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(2)} vs ${b.toFixed(2)}`);

test("held DOWN from both of his spots, the body runs into the corner and STAYS: no run to the right, no run back to the door", () => {
  const grid = house();
  for (const [name, s] of [["A", START_A], ["B", START_B]] as const) {
    // 13 s: several escalation windows, so an escape to the door would have fired.
    const r = hold(grid, s.col, s.row, 0, 1, 400);
    near(r.col, CORNER.col, 0.1, `${name}: at rest in the corner (col)`);
    near(r.row, CORNER.row, 0.1, `${name}: at rest in the corner (row)`);
    assert.equal(r.deflected, 0, `${name}: the walk was never deflected (outputs ${[...r.outs].join(" ")})`);
    assert.equal(r.trips, 0, `${name}: no escape route was ever committed`);
    assert.ok(r.minCol >= s.col - 0.01, `${name}: never a step west of the start (min col ${r.minCol.toFixed(2)})`);
  }
});

test("in the corner, the stick a hair off DOWN still only slides — and the natural slide is slower than the run", () => {
  const grid = house();
  // Screen-down leaned 8 degrees toward the right on the thumb: still a run
  // into the corner, walked at the wall's rate, never straightened — the
  // south wall's drawn direction is 66 degrees off the thumb here.
  const a = (98 * Math.PI) / 180;
  const heading = { ax: Math.cos(a), ay: Math.sin(a) };
  const r = hold(grid, START_A.col, START_A.row, 0, 1, 400, heading);
  near(r.col, CORNER.col, 0.1, "at rest in the corner (col)");
  near(r.row, CORNER.row, 0.1, "at rest in the corner (row)");
  assert.equal(r.deflected, 0);
  assert.equal(r.trips, 0);
});

test("bottom-LEFT from the corner: the door two cells along the south wall is SIDEWAYS, and the body is out of the house in under 3 s", () => {
  const grid = house();
  const r = hold(grid, CORNER.col, CORNER.row, -1, 1, 90);
  assert.ok(r.row > DOOR.r + 1, `outside the house after 3 s (row ${r.row.toFixed(2)}, the door is row ${DOOR.r})`);
  assert.ok(r.outs.has("-1,-1"), `steered west along the wall to the door (outputs ${[...r.outs].join(" ")})`);
  assert.equal(r.trips, 0, "the door-finder did it, not an escape route");
});

test("bottom-RIGHT from the corner: the door is behind the run — the honest wall, no help, no escape", () => {
  const grid = house();
  const r = hold(grid, CORNER.col, CORNER.row, 1, 1, 200);
  near(r.col, CORNER.col, 0.1, "still in the corner (col)");
  near(r.row, CORNER.row, 0.1, "still in the corner (row)");
  assert.equal(r.deflected, 0, `never deflected (outputs ${[...r.outs].join(" ")})`);
  assert.equal(r.trips, 0);
});

test("held DOWN toward the south wall with the door AHEAD-sideways: the slide along the wall carries the body out through it", () => {
  const grid = house();
  const r = hold(grid, 9.4, 11.3, 0, 1, 120);
  assert.ok(r.row > DOOR.r + 1, `outside after 4 s (row ${r.row.toFixed(2)})`);
  assert.equal(r.trips, 0);
});

test("the wall-assist angle: a lean within the dial runs STRAIGHT along the wall at full speed, a lean past it slides at the wall's rate", () => {
  const grid = field(6);
  const x0 = 6 - 12 / CELL_WU;
  // A stick 10 degrees (world) into the wall is 8 degrees off it on screen —
  // inside the default 30 — and snaps to the down-left key, the very pair
  // that locks onto +y: the answer is that pair, and it is DEFLECTED so the
  // caller does not lean it back into the wall.
  const straight = hold(grid, x0, 2, -1, 1, 60, lean(10));
  assert.equal(straight.deflected, 60, "every tick straightened");
  assert.deepEqual([...straight.outs], ["-1,1"], "the along-wall key pair");
  near(straight.col, x0, 0.02, "stayed on the wall line");
  // Sixty ticks of the free walk along +y (from col 3: col 1 sits in the
  // world-border margin and the clamp's shove would count as travel): the
  // full speed, not the slide's.
  const free = hold(grid, 3, 2, -1, 1, 60);
  near(straight.travelled, free.travelled, free.travelled * 0.02, "straightened run travels the free run's distance");
  // 65 degrees (world) is past the dial: the heading is walked as it is and
  // the wall takes its share — 0.61 of the run. (45 degrees is past it too,
  // but a world diagonal slid along an axis wall runs at the run's own screen
  // speed: the never-faster cap in stepMovement is what limits it.)
  const slid = hold(grid, x0, 2, 0, 1, 60, lean(65));
  assert.equal(slid.deflected, 0, "never straightened");
  assert.ok(slid.travelled < free.travelled * 0.8, `slower than the run (${(slid.travelled / free.travelled).toFixed(2)} of it)`);
  assert.ok(slid.row > 2 + 1, `and still moving along the wall (row ${slid.row.toFixed(2)})`);
  const diag = hold(grid, x0, 2, 0, 1, 60, lean(45));
  assert.equal(diag.deflected, 0, "45 degrees: never straightened either");
  // The dial at zero: even 10 degrees is walked as it is.
  const off = hold(grid, x0, 2, -1, 1, 60, lean(10), 0);
  assert.equal(off.deflected, 0, "dial at 0: nothing is straightened");
  // Square on: no tangent, no help, no motion.
  const square = hold(grid, x0, 2, 1, 1, 60);
  assert.equal(square.deflected, 0);
  near(square.travelled, 0, 1, "square on: the honest stop");
});

test("the hop waits for the angle: within the dial a lean into a JUMPABLE wall runs straight and never hops; past it the hop fires", () => {
  const grid = field(2);
  const x = 6 * CELL_WU - 12;
  const y = 2 * CELL_WU;
  const memo: SlideMemo = { ax: 0, ay: 0 };
  const hop: HopMemo = { hop: null };
  const opts = { nowMs: 33, trip: null, fromElev: 0, worldW: 12 * CELL_WU, worldH: 24 * CELL_WU };
  const inside = walkHeading(grid, x, y, -1, 1, memo, { ...opts, heading: lean(10) });
  assert.equal(inside.deflected, true);
  const noHop = hopIntoWall(grid, x, y, inside.ax, inside.ay, 0, 33, true, hop, true);
  assert.equal(noHop.jump, false, "straightened along the wall: nothing pushes into it");
  const past = walkHeading(grid, x, y, 0, 1, memo, { ...opts, heading: lean(45) });
  assert.equal(past.deflected, false);
  const hops = hopIntoWall(grid, x, y, lean(45).ax, lean(45).ay, 0, 33, true, hop, true);
  assert.equal(hops.jump, true, "past the angle the push into the wall is a hop");
});

test("wallContact and wallAngleDeg: which axis refuses, the tangent, and the angle on the thumb", () => {
  const grid = field(6);
  const x = 6 * CELL_WU - 12;
  const c = wallContact(grid, x, 2 * CELL_WU, lean(10).ax, lean(10).ay, 0);
  assert.ok(c && c.refX && !c.refY && !c.prop, `the wall across x: ${JSON.stringify(c)}`);
  assert.deepEqual(c!.tangent, { x: 0, y: 1 });
  assert.equal(wallContact(grid, 2 * CELL_WU, 2 * CELL_WU, 0, 1, 0), null, "open ground: no contact");
  // Square on (the right key locks onto +x): refused, no tangent.
  const sq = wallContact(grid, x, 2 * CELL_WU, 1, 1, 0);
  assert.ok(sq && sq.refX && sq.tangent === null);
  // The house corner refuses both axes.
  const h = house();
  const k = wallContact(h, CORNER.col * CELL_WU, CORNER.row * CELL_WU, 0, 1, 0);
  assert.ok(k && k.refX && k.refY && k.tangent === null, `the corner: ${JSON.stringify(k)}`);
  // Screen degrees: world +x is drawn 23.6 degrees below horizontal.
  near(wallAngleDeg(1, 0, 1, 0), 23.6, 0.1, "right key vs a wall along +x");
  near(wallAngleDeg(0, 1, 1, 0), 66.4, 0.1, "down key vs a wall along +x");
  near(wallAngleDeg(lean(10).ax, lean(10).ay, 0, 1), 8.4, 0.3, "a 10-degree world lean on the thumb");
  assert.equal(WALL_ASSIST_DEG_DEFAULT, 30);
});

test("the escape may reach one TILE back and no further: the house door is out of reach, a pocket's exit one tile aside is not", () => {
  const u = { x: Math.SQRT1_2, y: Math.SQRT1_2 }; // screen-down, a world diagonal
  const trip = (cells: [number, number][]) => ({ path: cells.map(([c, r]) => ({ x: c * CELL_WU, y: r * CELL_WU })) }) as unknown as AutopilotTrip;
  const x = CORNER.col * CELL_WU;
  const y = CORNER.row * CELL_WU;
  // The corner to the door: two cells west along the wall, then south — as
  // findPath draws it, the first point nudged off the wall.
  const door = routeRetreat(trip([[12.3, 12.3], [11.5, 12.5], [11.5, 13.5], [11.5, 14.5]]), x, y, u.x, u.y);
  assert.equal(door, 2, "the door route reaches two tiles back");
  assert.ok(door > ESCAPE_RETREAT_CELLS);
  // The dungeon pocket: one cell aside (nudged 0.2 further by the clearance),
  // then down the slot.
  const pocket = routeRetreat(trip([[12.3, 12.3], [12.3, 13.4], [12.5, 14.5]]), x, y, u.x, u.y);
  assert.equal(pocket, 1, "the pocket route reaches one tile back");
  assert.ok(pocket <= ESCAPE_RETREAT_CELLS);
  assert.equal(routeRetreat(trip([[14.5, 13.5], [15.5, 14.5]]), x, y, u.x, u.y), 0, "sideways and on: no retreat");
  // Along a world axis the other axis is sideways whatever it does.
  assert.equal(routeRetreat(trip([[9.5, 12.5], [9.5, 13.5]]), x, y, 0, 1), 0, "four tiles west of a run along +y: sideways");
  assert.equal(routeRetreat(trip([[13.5, 10.5]]), x, y, 0, 1), 2, "two tiles up against a run along +y");
  assert.ok(STUCK_ESCALATE_MS >= 1000, "the escape still waits its window");
});
