// THE STICKY TABLE (maintainer 2026-09-13, the spawn house: "When I'm running
// into the table in the middle I feel as if the table is more 'sticky' and I
// can't slide alongside it as I can with a wall ... if I instead run into the
// scenery object near the wall it behaves more like running into a wall. Does
// it have to do with the table's rotation?"). It does, twice over:
//  - a rect footprint facing SOUTH has its sides along the SCREEN axes — the
//    map's diagonals — and stepMovement's per-axis probes reach 15 wu toward
//    such a side, past the body's 12, so the tangent's half toward the side
//    was refused and the half away taken: a zig-zag off the table. The glide
//    now tries the tangent as ONE move first. The cupboard faces south-west,
//    its sides lie on the world axes, and it always slid.
//  - inside a house every cell wears the roof deck, so cellSolid() called the
//    table's cell walkable and walkHeading's wall rules took the table for a
//    wall. A footprint the heading pushes into is a prop, whatever the nav
//    layer says.
// Synthetic footprints (the world is re-authored constantly), his table's box.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHARACTER_BODY_PX,
  buildTerrainGrid, stampSceneryCollision, stepMovement, makeBlockedElev, makeSideBlocked, unstickFromSolids,
  walkHeading, wallContact, levelAtWorld, startEscapeRoute,
  CELL_WU, PLAYER_RADIUS, WALK_CLIMB, ISO_GEOMETRY_MAPS3, STUCK_ESCALATE_MS, ISO_DX, ISO_DY,
  type TerrainGrid, type SceneryBboxDoc, type SceneryHitboxDoc, type SlideMemo, type AutopilotTrip,
} from "@nangijala/shared";

const W = 30;
const H = 30;
/** One rect piece at cell (15,15) with his table's box (26 x 7.56 screen px),
 *  facing `dir` — south (the default) turns nothing, south-west turns the box
 *  onto the world axes like the cupboard. `roof` lays a deck over every cell,
 *  the way a house does. */
const roofDeck = () => {
  const cells: { col: number; row: number }[] = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) cells.push({ col: c, row: r });
  return [{ level: 6, thickness: 1, cells }];
};
function emptyWorld(roof = false): TerrainGrid {
  const rows = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ t: "grass", l: 0 })));
  return buildTerrainGrid(W, H, rows, [], roof ? roofDeck() : []);
}
/** `rx` is his table's 26 px by default; a long side (200) keeps a 45-tick
 *  slide on the side, where the rate is measured — his table is short enough
 *  that a body slides past its corner in ten ticks and then runs free. */
function tableWorld(dir?: string, roof = false, rx = 26): TerrainGrid {
  const grid = emptyWorld(roof);
  const bbox: SceneryBboxDoc = {
    pieces: { p: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } },
    boxes: { s: [0, 0, 100, 100, 100, 100] },
  };
  const hitbox: SceneryHitboxDoc = { "scenery/p": { boxes: [{ ax: 0, ay: -50, rx, ry: 7.56, shape: "rect", rot: 0 }] } };
  stampSceneryCollision(grid, [{ piece: "p", x: 15, y: 15, ...(dir ? { dir } : {}) }], bbox, hitbox, ISO_GEOMETRY_MAPS3);
  return grid;
}
/** The world point at (X, Y) of the footprint's own frame (X along the screen's
 *  horizontal, Y its vertical, in cells) — footprintPenetration's rotation. */
function at(grid: TerrainGrid, X: number, Y: number): { x: number; y: number } {
  const fp = grid.footprints!;
  const ox = (X + Y) / Math.SQRT2;
  const oy = (Y - X) / Math.SQRT2;
  return { x: (fp.cx[0] + ox) * CELL_WU, y: (fp.cy[0] + oy) * CELL_WU };
}
/** The body's Y in the footprint frame — its distance out from the south side is Y - q. */
function frameY(grid: TerrainGrid, x: number, y: number): number {
  const fp = grid.footprints!;
  const ox = x / CELL_WU - fp.cx[0];
  const oy = y / CELL_WU - fp.cy[0];
  return (ox + oy) / Math.SQRT2;
}

/** `travelled` is SCREEN pixels: the slide's law is a screen share, and the
 *  same world distance is a different length on screen per direction. */
interface Run { x: number; y: number; travelled: number; frozen: number; deflected: number; outs: string[] }
/** Hold a screen input from a point for `ticks` frames of 33 ms: the raw tick,
 *  or the client's way through walkHeading. */
function hold(grid: TerrainGrid, from: { x: number; y: number }, ax: number, ay: number, ticks: number, viaWalk: boolean): Run {
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  const ww = W * CELL_WU;
  const wh = H * CELL_WU;
  let x = from.x;
  let y = from.y;
  let t = 0;
  let trip: AutopilotTrip | null = null;
  const memo: SlideMemo = { ax: 0, ay: 0 };
  let travelled = 0;
  let frozen = 0;
  let deflected = 0;
  const outs = new Set<string>();
  for (let i = 0; i < ticks; i++) {
    t += 33;
    const elev = levelAtWorld(grid, x, y);
    let iax = ax;
    let iay = ay;
    if (viaWalk) {
      const r = walkHeading(grid, x, y, ax, ay, memo, { nowMs: t, trip, fromElev: elev, worldW: ww, worldH: wh });
      trip = r.trip;
      iax = r.ax;
      iay = r.ay;
      if (r.deflected) deflected++;
      outs.add(`${r.ax},${r.ay}`);
    }
    const ge = () => elev;
    const u = unstickFromSolids(grid, x, y, 80 * 0.033, undefined, elev);
    x = u.x;
    y = u.y;
    // The client's law per window: the thumb's slide share, a route's world axis (MoveOpts.screenSlide).
    const m = stepMovement(x, y, iax, iay, false, 0.033, makeBlockedElev(grid, walk, ge), 1, true, ww, wh, makeSideBlocked(grid, walk, ge), { screenSlide: trip === null });
    const moved = Math.hypot(m.x - x, m.y - y);
    travelled += Math.hypot((m.x - x - (m.y - y)) * ISO_DX, (m.x - x + (m.y - y)) * ISO_DY);
    if (moved < 0.05) frozen++;
    x = m.x;
    y = m.y;
  }
  return { x, y, travelled, frozen, deflected, outs: [...outs] };
}
const TICKS = 45;
/** The same input held on open ground from the same spot: the free run's world
 *  length depends on the direction (the screen speed is what is uniform), so
 *  every ratio below is against THIS, never a constant. */
const free = (ax: number, ay: number, from: { x: number; y: number }, roof = false) => hold(emptyWorld(roof), from, ax, ay, TICKS, false).travelled;
const touching = (grid: TerrainGrid) => at(grid, 0, grid.footprints!.q[0] + PLAYER_RADIUS / CELL_WU + 0.02); // just off the south side, screen-below it

test("the table faces south: its sides are the map's diagonals and it fills no nav cell; the walk never takes it for a wall, and a footprint under a roof is a PROP", () => {
  const g = tableWorld(undefined, true);
  const fp = g.footprints!;
  assert.equal(fp.n, 1);
  assert.equal(fp.rect[0], 1);
  assert.ok(Math.abs(fp.rsin[0]) < 1e-9, "south: no ground turn, the sides follow the screen axes");
  // At most its middle cell: the bake keeps NAV_SLACK_WU to spare, so a table
  // 52 px across fills one. The walk's rules never read it (below).
  assert.ok(g.blocked.filter(Boolean).length <= 1, `the table fills at most one nav cell (${g.blocked.filter(Boolean).length})`);
  const p = touching(g);
  // An axis probe against a diagonal side glides along it, so no axis is ever
  // refused: the wall rules have nothing to rule on, square on or at 45.
  assert.equal(wallContact(g, p.x, p.y, 0, -1, 0), null, "square on: the physics' business, not the walk's");
  assert.equal(wallContact(g, p.x, p.y, -1, -1, 0), null, "45 degrees in: the same");
  // The cupboard's turn puts its sides on the world axes; square on its south
  // side (world -y) the y axis IS refused, and under the roof — where
  // cellSolid calls every cell walkable — the contact must still say PROP.
  const c = tableWorld("south-west", true);
  const cf = c.footprints!;
  const cp = { x: cf.cx[0] * CELL_WU, y: (cf.cy[0] + cf.q[0] + PLAYER_RADIUS / CELL_WU + 0.02) * CELL_WU };
  const wc = wallContact(c, cp.x, cp.y, 1, -1, 0);
  assert.ok(wc && wc.refY && !wc.refX && wc.prop, `the cupboard square on, under the roof: ${JSON.stringify(wc)}`);
});

test("along the south side the body runs at the run's own pace and stays on the side; 45 degrees into it slides at the wall's share; square on it stands", () => {
  const g = tableWorld(undefined, false, 200);
  const p = touching(g);
  // Screen-left is the world diagonal (-1,+1): exactly along the south side.
  const along = hold(g, p, -1, 0, TICKS, false);
  const alongFree = free(-1, 0, p);
  assert.ok(along.frozen === 0, `along the side: frozen ${along.frozen} ticks`);
  assert.ok(along.travelled >= alongFree * 0.95, `along the side: ${(along.travelled / alongFree).toFixed(2)} of the run (0.70 with the per-axis halves)`);
  const out = frameY(g, along.x, along.y) - g.footprints!.q[0] - PLAYER_RADIUS / CELL_WU;
  assert.ok(out < 0.15, `still on the side, not drifted off it: ${out.toFixed(2)} cells out`);
  // Screen up-left is world -x: 45 degrees into the side in the WORLD — the
  // slide keeps the thumb's screen speed at the world cosine, 71% of the run
  // (the screen projection took 92% here and 40% for screen-up at the
  // cupboard below, the asymmetry he felt; 0.50 and drifting off the side
  // with the per-axis halves).
  const into = hold(g, p, -1, -1, TICKS, false);
  const intoFree = free(-1, -1, p);
  assert.ok(into.frozen === 0, `45 degrees in: frozen ${into.frozen} ticks`);
  assert.ok(into.travelled >= intoFree * 0.6 && into.travelled <= intoFree * 0.8, `world 45 in: ${(into.travelled / intoFree).toFixed(2)} of the run`);
  assert.ok(into.x < p.x - CELL_WU, `and it went the way the side runs (x ${((into.x - p.x) / CELL_WU).toFixed(2)} cells)`);
  const intoOut = frameY(g, into.x, into.y) - g.footprints!.q[0] - PLAYER_RADIUS / CELL_WU;
  assert.ok(intoOut < 0.15, `still on the side: ${intoOut.toFixed(2)} cells out`);
  // Square on: nothing to slide along.
  const square = hold(g, p, 0, -1, TICKS, false);
  assert.ok(square.travelled < 3, `square on stands (${square.travelled.toFixed(1)} wu)`);
});

test("the cupboard faces south-west: its sides lie on the world axes and always slid — still does", () => {
  const g = tableWorld("south-west");
  const fp = g.footprints!;
  assert.ok(Math.abs(Math.abs(fp.rsin[0]) - Math.SQRT1_2) < 1e-6, "a 45-degree ground turn");
  // In this frame the box's long side runs along world x; a body screen-below
  // the piece pushing screen-up (world (-1,-1)) slides along x with y refused.
  const p = { x: (fp.cx[0] + 0.6) * CELL_WU, y: (fp.cy[0] + fp.supY[0] * Math.SQRT2 + 0.2) * CELL_WU };
  // Fifteen ticks: the side is short, and a longer hold runs free past its end.
  const ticks = 15;
  const r = hold(g, p, 0, -1, ticks, false);
  assert.ok(r.frozen < 5, `cupboard, screen-up: frozen ${r.frozen} ticks`);
  // Screen-up is 45 degrees into a world-x side in the WORLD: the world
  // cosine, 71% of the run — the same share screen up-left gets at the table
  // above (the screen projection gave 40% here and 92% there).
  const fr = hold(emptyWorld(false), p, 0, -1, ticks, false).travelled;
  assert.ok(r.travelled >= fr * 0.6 && r.travelled <= fr * 0.8, `cupboard, screen-up: ${(r.travelled / fr).toFixed(2)} of the run on screen`);
});

/** THE PINCH (his 253.1,303.7): a cupboard's ellipse and a table's box a cell
 *  apart along world y, the way out west between them 20 wu wide at the cell's
 *  middle and open along its edge — so the cell is nav-OPEN (some body position
 *  exists in it) while no body walks THROUGH it. Both pieces face south. */
function pinchWorld(): TerrainGrid {
  const grid = emptyWorld(true);
  const bbox: SceneryBboxDoc = {
    pieces: { cup: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" }, tab: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } },
    boxes: { s: [0, 0, 100, 100, 100, 100] },
  };
  // ay 50 puts the box's centre on the placement itself.
  const hitbox: SceneryHitboxDoc = {
    "scenery/cup": { boxes: [{ ax: 0, ay: 50, rx: 30, ry: 6, rot: 0 }] },
    "scenery/tab": { boxes: [{ ax: 0, ay: 50, rx: 26, ry: 7.56, shape: "rect", rot: 0 }] },
  };
  stampSceneryCollision(grid, [{ piece: "cup", x: 15, y: 15.0 }, { piece: "tab", x: 15, y: 16.825 }], bbox, hitbox, ISO_GEOMETRY_MAPS3);
  return grid;
}

test("a nav-open cell the body cannot fit through: the escape is walked before it is taken, and the route goes round", () => {
  // Maintainer 2026-09-13, walking NW between the spawn house's cupboard and
  // table: "I can't fit through and was hoping the player would have tried to
  // run around using the nav system, but it doesn't". The nav layer answers
  // per cell, findPath threaded the cell, the follower stood on the first
  // step, the walk dropped the route and planned the same one every window.
  const g = pinchWorld();
  assert.ok(!g.blocked[15 * W + 15], "the pinch cell is nav-open: a body position exists along its edge");
  const p = { x: 16.4 * CELL_WU, y: 15.45 * CELL_WU };
  // The raw walk (no walkHeading) stands at the pinch: the body does not fit.
  const raw = hold(g, p, -1, -1, 60, false);
  assert.ok(raw.x / CELL_WU > 14.9, `raw walk stands at the pinch (x ${(raw.x / CELL_WU).toFixed(2)})`);
  // Through the walk: the escape's first route threads the pinch and is
  // refused by the proof, the cell is taken out, and the route round is taken.
  // (Without the proof — the tree before it — the same hold ends at x 14.5,
  // the follower dithering at the pinch for the whole 3 s.)
  // (120 ticks: the goal is 2 cells on and the honest walk then carries on
  // west; a longer hold reaches the world's margin and stands there. The
  // cupboard is thin, so the cell under its west half is closed and the way
  // round is a cell longer than it was.)
  const r = hold(g, p, -1, -1, 120, true);
  assert.ok(r.x / CELL_WU < 13.5, `round the pieces within 4 s (x ${(r.x / CELL_WU).toFixed(2)})`);
  assert.ok(r.frozen < 10, `stands only for the window before the escape (${r.frozen} ticks)`);
  assert.ok(r.deflected > 0, "the route did it");
  // The planner itself: the proof's re-plan keeps the route out of the pinch cell.
  const esc = startEscapeRoute(g, p.x, p.y, -1, -1, 1000, 0, 1, true);
  assert.ok(esc, "an escape route is planned");
  assert.ok(esc!.path.every((q) => !(Math.floor(q.x / CELL_WU) === 15 && Math.floor(q.y / CELL_WU) === 15)), `no waypoint in the pinch cell: ${esc!.path.map((q) => `(${(q.x / CELL_WU).toFixed(2)},${(q.y / CELL_WU).toFixed(2)})`).join(" ")}`);
});

/** A ROOF'S OVERHANG (his 273.3,186.0): a house's roof deck also covers a strip
 *  OUTSIDE its wall — cols 5..7 here, the wall at col 4 — and a brazier stands
 *  at the roof's edge on that strip. A body on the strip pressing east into the
 *  brazier has every way round out from under the roof. */
function overhangWorld(): TerrainGrid {
  const rows = Array.from({ length: H }, () => Array.from({ length: W }, (_, c) => ({ t: "grass", l: c === 4 ? 24 : 0 })));
  const cells: { col: number; row: number }[] = [];
  for (let r = 0; r < H; r++) for (let c = 0; c <= 7; c++) cells.push({ col: c, row: r });
  const grid = buildTerrainGrid(W, H, rows, [], [{ level: 24, thickness: 1, cells }]);
  const bbox: SceneryBboxDoc = { pieces: { p: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } }, boxes: { s: [0, 0, 100, 100, 100, 100] } };
  const hitbox: SceneryHitboxDoc = { "scenery/p": { boxes: [{ ax: 0, ay: 50, rx: 30, ry: 22, rot: 0 }] } };
  stampSceneryCollision(grid, [{ piece: "p", x: 8.2, y: 15.4 }], bbox, hitbox, ISO_GEOMETRY_MAPS3);
  return grid;
}

/** A ROOFED ROOM with its door in the south wall and a table in the middle:
 *  the case the roof rule was built for. Walls (level 24) ring cols 6..16 x
 *  rows 10..20, the door at (11,20), the roof over the room; the table sits at
 *  (11.5, 15.5) and the body presses WEST into it from the east. */
function roomWorld(): TerrainGrid {
  const rows = Array.from({ length: H }, (_, r) => Array.from({ length: W }, (_, c) => {
    const ring = ((c === 6 || c === 16) && r >= 10 && r <= 20) || ((r === 10 || r === 20) && c >= 6 && c <= 16);
    const door = c === 11 && r === 20;
    return { t: "grass", l: ring && !door ? 24 : 0 };
  }));
  const cells: { col: number; row: number }[] = [];
  for (let r = 11; r <= 19; r++) for (let c = 7; c <= 15; c++) cells.push({ col: c, row: r });
  cells.push({ col: 11, row: 20 });
  const grid = buildTerrainGrid(W, H, rows, [], [{ level: 24, thickness: 1, cells }]);
  const bbox: SceneryBboxDoc = { pieces: { p: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } }, boxes: { s: [0, 0, 100, 100, 100, 100] } };
  const hitbox: SceneryHitboxDoc = { "scenery/p": { boxes: [{ ax: 0, ay: 50, rx: 70, ry: 30, shape: "rect", rot: 0 }] } };
  stampSceneryCollision(grid, [{ piece: "p", x: 11.5, y: 15.5 }], bbox, hitbox, ISO_GEOMETRY_MAPS3);
  return grid;
}

test("a prop's escape crosses a roof's edge only AHEAD of the body: out from under the overhang, never through the door beside", () => {
  // Maintainer 2026-09-13 at 273.3,186.0 running SE: "I get stuck between
  // the scenery and the wall. I kinda expected the nav to run and navigate me
  // around, but it doesn't" — the old rule held every prop escape under the
  // roof it started under, and on the overhang every goal ahead is outside.
  const g = overhangWorld();
  const under = (x: number, y: number) => g.deck[Math.floor(y / CELL_WU) * g.width + Math.floor(x / CELL_WU)] >= 0;
  const p = { x: 6.6 * CELL_WU, y: 15.4 * CELL_WU };
  assert.ok(under(p.x, p.y), "the body starts under the roof's overhang");
  assert.equal(levelAtWorld(g, p.x, p.y), 0, "on the ground, not on the roof");
  const r = hold(g, p, 1, 1, 150, true); // screen down-right = world +x, into the brazier
  assert.ok(r.x / CELL_WU > 9.5, `round the brazier and on, out from under the roof (x ${(r.x / CELL_WU).toFixed(2)})`);
  assert.ok(r.frozen < 15, `never stands for long (${r.frozen} ticks)`);
  assert.ok(r.deflected > 0, "the escape did it");
  // The room: pressing west into the table, the door is BESIDE the ask. The
  // body stays under the roof for the whole hold — round the table, never
  // out through the door and round the outside.
  const room = roomWorld();
  const start = { x: 13.2 * CELL_WU, y: 15.5 * CELL_WU };
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  let x = start.x, y = start.y, t = 0, trip: AutopilotTrip | null = null, left = 0;
  const memo: SlideMemo = { ax: 0, ay: 0 };
  for (let i = 0; i < 150; i++) {
    t += 33;
    const elev = levelAtWorld(room, x, y);
    const w = walkHeading(room, x, y, -1, -1, memo, { nowMs: t, trip, fromElev: elev, worldW: W * CELL_WU, worldH: H * CELL_WU });
    trip = w.trip;
    const m = stepMovement(x, y, w.ax, w.ay, false, 0.033, makeBlockedElev(room, walk, () => elev), 1, true, W * CELL_WU, H * CELL_WU, makeSideBlocked(room, walk, () => elev), { screenSlide: trip === null });
    x = m.x; y = m.y;
    if (room.deck[Math.floor(y / CELL_WU) * room.width + Math.floor(x / CELL_WU)] < 0) left++;
  }
  assert.equal(left, 0, `the body left the roof ${left} ticks — the door beside the table was taken`);
});

test("through walkHeading, under the roof: the table never gets the wall's rules — the slide is the raw walk, square on the escape takes the body round", () => {
  const g = tableWorld(undefined, true);
  const p = touching(g);
  const along = hold(g, p, -1, 0, TICKS, true);
  assert.equal(along.deflected, 0, `along the side nothing deflects the walk (outputs ${along.outs.join(" ")})`);
  assert.ok(along.travelled >= free(-1, 0, p, true) * 0.95, `along the side at the run's pace: ${(along.travelled / free(-1, 0, p, true)).toFixed(2)}`);
  const into = hold(g, p, -1, -1, TICKS, true);
  assert.equal(into.deflected, 0, `45 degrees in: the natural slide, no straightening along a world axis (outputs ${into.outs.join(" ")})`);
  const square = hold(g, p, 0, -1, TICKS, true);
  assert.ok(square.deflected > 0 && square.travelled > 20, `square on: the escape moves it round (deflected ${square.deflected}, ${square.travelled.toFixed(0)} wu)`);
});

/* THE BRAZIER (maintainer 2026-09-13, his screenshot at 240.5,265.3 running
 * north-east — world -y — "the navigation doesn't kick in and help me around
 * the object"): a round footprint one cell north, walls west and south, open
 * east and beyond. The body's corner probe touched the brazier 30 wu from the
 * body's centre — past any contact query's reach — so it read as terrain, the
 * wall rules stood it still, and the planner's short way round (east, then
 * north) was never followed. Copied here: level-12 walls, a cave lid deck over
 * the floor (cellSolid calls a decked cell walkable, the other half of the
 * table's lesson), the brazier's own 15 px ellipse. */
function brazierPocket(): TerrainGrid {
  const rows = Array.from({ length: H }, (_, r) =>
    Array.from({ length: W }, (_, c) => ({ t: "dark_mud", l: c <= 9 || r >= 21 ? 12 : 0 })),
  );
  const cells: { col: number; row: number }[] = [];
  for (let r = 0; r < 21; r++) for (let c = 10; c < W; c++) cells.push({ col: c, row: r });
  const grid = buildTerrainGrid(W, H, rows, [], [{ level: 12, thickness: 0, cells }]);
  const bbox: SceneryBboxDoc = {
    pieces: { p: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } },
    boxes: { s: [0, 0, 100, 100, 100, 100] },
  };
  // ay 50: the box centre ON the anchor (the frame's foot), so the ellipse
  // lands where it is placed (the table fixture's -50 lifts its centre 3.6
  // cells up-screen, which touching() absorbs by reading the stamped centre;
  // here the walls matter).
  const hitbox: SceneryHitboxDoc = { "scenery/p": { boxes: [{ ax: 0, ay: 50, rx: 21, ry: 21 }] } };
  stampSceneryCollision(grid, [{ piece: "p", x: 10.53, y: 19.48 }], bbox, hitbox, ISO_GEOMETRY_MAPS3);
  return grid;
}

test("the brazier: a round footprint only the corner probe touches is a PROP, and the body is round it fast", () => {
  const g = brazierPocket();
  const fp = g.footprints!;
  assert.equal(fp.n, 1);
  assert.equal(fp.rect[0], 0, "an ellipse");
  assert.ok(Math.abs(fp.cx[0] - 10.53) < 0.3 && Math.abs(fp.cy[0] - 19.48) < 0.3, `placed in the pocket: (${fp.cx[0].toFixed(2)},${fp.cy[0].toFixed(2)})`);
  // His stuck spot, 0.43 cells east and 0.84 south of the brazier's centre:
  // the -y probe is refused through the lateral corner only.
  const p = { x: (fp.cx[0] + 0.43) * CELL_WU, y: (fp.cy[0] + 0.84) * CELL_WU };
  assert.ok(fp.cy[0] + 0.84 < 21 - 12 / CELL_WU, "and inside the pocket, off the south wall");
  const wc = wallContact(g, p.x, p.y, 1, -1, 0);
  assert.ok(wc && wc.refY && wc.prop, `refused through the corner, and a prop: ${JSON.stringify(wc)}`);
  // Held north from his spot: no progress, so within his window the escape
  // goes east and round — north of the brazier within two seconds, never
  // frozen for half of one.
  const r = hold(g, p, 1, -1, 60, true);
  assert.ok(r.y < (fp.cy[0] - 0.8) * CELL_WU, `round the brazier: row ${(r.y / CELL_WU).toFixed(2)} against its ${fp.cy[0].toFixed(2)}`);
  assert.ok(r.frozen < 15, `frozen ${r.frozen} of 60 ticks`);
  assert.equal(STUCK_ESCALATE_MS, 100, "the escape waits his tenth of a second");
});
