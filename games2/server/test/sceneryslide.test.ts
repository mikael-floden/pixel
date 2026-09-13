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
  walkHeading, wallContact, levelAtWorld,
  CELL_WU, PLAYER_RADIUS, WALK_CLIMB, ISO_GEOMETRY_MAPS3,
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
    const m = stepMovement(x, y, iax, iay, false, 0.033, makeBlockedElev(grid, walk, ge), 1, true, ww, wh, makeSideBlocked(grid, walk, ge));
    const moved = Math.hypot(m.x - x, m.y - y);
    travelled += moved;
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
  assert.equal(g.blocked.filter(Boolean).length, 0, "the table blocks no nav cell — cellSolid could never have seen it");
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
  // Screen up-left is world -x: 45 degrees into the side. The wall takes its share.
  const into = hold(g, p, -1, -1, TICKS, false);
  const intoFree = free(-1, -1, p);
  assert.ok(into.frozen === 0, `45 degrees in: frozen ${into.frozen} ticks`);
  assert.ok(into.travelled >= intoFree * 0.65 && into.travelled <= intoFree * 0.8, `45 degrees in: ${(into.travelled / intoFree).toFixed(2)} of the run — the tangent's share, cos 45 (0.50 and drifting off the side with the per-axis halves)`);
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
  const r = hold(g, p, 0, -1, TICKS, false);
  assert.ok(r.frozen < 5, `cupboard, screen-up: frozen ${r.frozen} ticks`);
  assert.ok(r.travelled >= free(0, -1, p) * 0.5, `cupboard, screen-up: ${(r.travelled / free(0, -1, p)).toFixed(2)} of the run`);
});

test("through walkHeading, under the roof: the table gets the tree rules, never the wall's — the slide is the raw walk, square on the body is not left standing", () => {
  const g = tableWorld(undefined, true);
  const p = touching(g);
  const along = hold(g, p, -1, 0, TICKS, true);
  assert.equal(along.deflected, 0, `along the side nothing deflects the walk (outputs ${along.outs.join(" ")})`);
  assert.ok(along.travelled >= free(-1, 0, p, true) * 0.95, `along the side at the run's pace: ${(along.travelled / free(-1, 0, p, true)).toFixed(2)}`);
  const into = hold(g, p, -1, -1, TICKS, true);
  assert.equal(into.deflected, 0, `45 degrees in: the natural slide, no straightening along a world axis (outputs ${into.outs.join(" ")})`);
  const square = hold(g, p, 0, -1, TICKS, true);
  assert.ok(square.deflected > 0 && square.travelled > 20, `square on: the tree rules move it round (deflected ${square.deflected}, ${square.travelled.toFixed(0)} wu)`);
});
