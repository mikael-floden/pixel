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
  ESCAPE_MIN_PROGRESS_CELLS,
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

/** THE BIG HOUSE (his 310,234): a ring wall cols 3..18 x rows 7..13, the door at
 *  (9,13), and a ROOF deck over the interior and the door cell, so the door
 *  post (10,13) is the one undecked level-6 cell beside the way out. */
const BIG_DOOR = { c: 9, r: 13 };
function bigHouse(roof: boolean): TerrainGrid {
  const rows = Array.from({ length: H }, (_, r) =>
    Array.from({ length: W }, (_, c) => {
      const ring = ((c === 3 || c === 18) && r >= 7 && r <= 13) || ((r === 7 || r === 13) && c >= 3 && c <= 18);
      const door = c === BIG_DOOR.c && r === BIG_DOOR.r;
      return { t: "grass", l: ring && !door ? 6 : 0 };
    }),
  );
  const cells: { col: number; row: number }[] = [];
  for (let r = 8; r <= 12; r++) for (let c = 4; c <= 17; c++) cells.push({ col: c, row: r });
  cells.push({ col: BIG_DOOR.c, row: BIG_DOOR.r });
  return buildTerrainGrid(W, H, rows, [], roof ? [{ level: 6, thickness: 1, cells }] : []);
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
  /** The longest run of ticks the body moved less than 0.05 wu: a stand. */
  still: number;
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
  let still = 0;
  let stillRun = 0;
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
    // The thumb's window: the slide is the screen share (MoveOpts.screenSlide).
    const m = stepMovement(x, y, wax, way, false, 0.033, makeBlockedElev(grid, walk, ge), 1, true, ww, wh, makeSideBlocked(grid, walk, ge), { screenSlide: true });
    // SCREEN pixels: the slide's law is a screen share (docs/movement.md).
    travelled += Math.hypot((m.x - x - (m.y - y)) * ISO_DX, (m.x - x + (m.y - y)) * ISO_DY);
    if (Math.hypot(m.x - x, m.y - y) < 0.05) still = Math.max(still, ++stillRun);
    else stillRun = 0;
    x = m.x;
    y = m.y;
    elev = levelAtWorld(grid, x, y);
    minCol = Math.min(minCol, x / CELL_WU);
    maxRow = Math.max(maxRow, y / CELL_WU);
  }
  return { col: x / CELL_WU, row: y / CELL_WU, minCol, maxRow, deflected, trips, outs, travelled, still };
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
  // inside his default 10 — and snaps to the down-left key, the very pair
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
  near(straight.travelled, free.travelled, free.travelled * 0.02, "straightened run travels the free run's screen distance");
  // 45 degrees (world) is past the dial: the heading is walked as it is and
  // the wall takes the slide's share — the thumb's screen speed at the WORLD
  // cosine, 71% of the run for this lean, which is screen-down (it slid at the
  // run's own screen speed under the world-axis rule and at 40% under the
  // screen projection: the cliff asymmetry he felt, both ways round).
  // (45 ticks: a free screen-down run from col 1 reaches the field's own wall
  // after five cells, and the reference must not slide too.)
  const diag = hold(grid, x0, 2, 0, 1, 45, lean(45));
  assert.equal(diag.deflected, 0, "45 degrees: never straightened");
  const diagFree = hold(grid, 1, 2, 0, 1, 45).travelled;
  assert.ok(diag.travelled > diagFree * 0.6 && diag.travelled < diagFree * 0.8, `screen-down into a wall along +y: ${(diag.travelled / diagFree).toFixed(2)} of the run, world cos 45`);
  assert.ok(diag.row > 2 + 0.5, `and moving along the wall (row ${diag.row.toFixed(2)})`);
  // 65 degrees (world), 25 from square on: the world cosine, 42% of the run
  // along the wall — a push that is not square on slides. (The screen
  // projection stood this one: its screen direction was past a right angle
  // from the wall's screen line, the same artefact that stood a body on the
  // spawn house's door post.)
  const steep = hold(grid, x0, 2, 0, 1, 60, lean(65));
  assert.equal(steep.deflected, 0, "never straightened");
  const steepFree = hold(grid, 1, 2, 0, 1, 60).travelled;
  assert.ok(steep.travelled > steepFree * 0.3 && steep.travelled < steepFree * 0.55, `65 degrees in: ${(steep.travelled / steepFree).toFixed(2)} of the run, world cos 65`);
  // The dial at zero: even 10 degrees is walked as it is.
  const off = hold(grid, x0, 2, -1, 1, 60, lean(10), 0);
  assert.equal(off.deflected, 0, "dial at 0: nothing is straightened");
  // Square on: no tangent, no help, no motion.
  const square = hold(grid, x0, 2, 1, 1, 60);
  assert.equal(square.deflected, 0);
  near(square.travelled, 0, 2, "square on: the honest stop");
});

test("beside the door under the roof, a lean that drifts the body onto the door post: out through the door, never a stand", () => {
  // Maintainer 2026-09-13, the big house: "if I run into the wall and so the nav
  // try to navigate me out of the house the player stops (only sometimes) on
  // the door edge". Held into the south wall a few cells from the door with
  // the finger leaned a little either way, the leaned heading's x axis drifted
  // the body under the post, the y move was refused, and the x remainder's
  // SCREEN share was zero (99 screen degrees off the thumb) — a stand for the
  // length of the hold, while the exact key walked through. And with every
  // escape held under the roof, the nav had no route out. The world cosine
  // slides the remainder, and a terrain wall's escape may leave the house:
  // all twelve holds are out in about a second, none stands.
  const grid = bigHouse(true);
  const leanScreen = (deg: number) => {
    const a = Math.atan2(1, -1) + (deg * Math.PI) / 180; // screen down-left, turned
    return { ax: Math.cos(a), ay: Math.sin(a) };
  };
  for (const [col, row] of [[12.1, 11.4], [11.6, 10.9], [12.5, 12.1], [10.6, 11.6]] as const) {
    for (const deg of [-12, 0, 12]) {
      const r = hold(grid, col, row, -1, 1, 90, deg ? leanScreen(deg) : undefined);
      assert.ok(r.row > BIG_DOOR.r + 1, `from (${col},${row}) lean ${deg}: out of the house in 3 s (row ${r.row.toFixed(2)})`);
      assert.ok(r.still < 6, `from (${col},${row}) lean ${deg}: never stands (${r.still} ticks still)`);
    }
  }
  // The same holds with no roof: the escape and the walk are the same, so the
  // roof is not a rule of its own — a terrain escape leaves it, a prop's (the
  // table under it, sceneryslide.test.ts) never does.
  const open = bigHouse(false);
  const r = hold(open, 12.1, 11.4, -1, 1, 90, leanScreen(-12));
  assert.ok(r.row > BIG_DOOR.r + 1 && r.still < 6, `open house: out (row ${r.row.toFixed(2)}), ${r.still} still`);
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
  assert.equal(WALL_ASSIST_DEG_DEFAULT, 10, "his number, 2026-09-13");
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
  assert.equal(STUCK_ESCALATE_MS, 100, "the escape waits his 0.1 s by default");
});

/** THE PLATEAU'S NOTCH (his 285.6,208.6, 2026-09-13): a level-4 plateau whose
 *  west edge steps one column at row 9 — cols >= 11 for rows 2..8, cols >= 10
 *  for rows 9..14 — so a body at (10.6, 8.6) holding screen-DOWN (the world
 *  diagonal +col +row) meets the hill on both axes, and the way on lies one
 *  tile west, down col 9, and out past the plateau's foot at row 15. */
function notch(): TerrainGrid {
  const rows = Array.from({ length: H }, (_, r) =>
    Array.from({ length: W }, (_, c) => ({
      t: "grass",
      l: (r >= 2 && r <= 8 && c >= 11) || (r >= 9 && r <= 14 && c >= 10) ? 4 : 0,
    })),
  );
  return buildTerrainGrid(W, H, rows, [], []);
}

test("held DOWN into the plateau's notch: no goal ahead is standable, and the escape still gets the body south — one tile west, down the side, on past the foot", () => {
  const grid = notch();
  const h = hold(grid, 10.6, 8.6, 0, 1, 240);
  assert.ok(h.trips > 0, "an escape was taken");
  assert.ok(h.maxRow > 15, `past the plateau's foot: maxRow ${h.maxRow.toFixed(2)}`);
  assert.ok(h.minCol >= 9, `one tile west at most: minCol ${h.minCol.toFixed(2)}`);
  assert.ok(h.still < 60, `no stand of 2 s: ${h.still} frames`);
  // The endless wall is unchanged: an escape must get ON, and the rim beside
  // the body is no progress — square into it the body stands.
  const sq = screenFor(1, 0);
  const w = hold(field(6), 5.4, 12, sq.ax, sq.ay, 120);
  assert.equal(w.trips, 0, "square into an endless wall: no route, the body stands");
  assert.equal(ESCAPE_MIN_PROGRESS_CELLS, 2);
});
