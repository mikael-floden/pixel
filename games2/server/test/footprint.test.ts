import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTerrainGrid, stampSceneryCollision, stepMovement, makeBlocked, makeSideBlocked,
  makeBlockedElev, canEnterElev, isBlockedAtWorld, resolveElevAt, footprintBlocks,
  footprintContact, screenToWorldVector, findSpawn,
  CELL_WU, PLAYER_RADIUS, WALK_CLIMB, MIN_FOOTPRINT_SEMI, ISO_GEOMETRY_MAPS3,
  type TerrainGrid, type SceneryBboxDoc, type SceneryHitboxDoc, type BlockedFn,
} from "@nangijala/shared";

/* THE ELLIPSE IS THE COLLISION, THE CELLS ARE ONLY THE NAV LAYER.
 *
 * The maintainer, 2026-08-30: "you have turned the ellipse into cells. This is
 * why it doesn't match the perfect collision I drew! ... So a small object will
 * have a small ellipse and that object might be invisible for the nav system
 * because the player will be able to run by that object by sliding around the
 * object. So the show hitbox button should show both what the nav navigates
 * around and the real ellipse hitbox."
 *
 * These gates are on a SYNTHETIC footprint, not on the shipped world: the world
 * is re-authored constantly and the invariant is about the SHAPE, not about any
 * one tree. `stampSceneryCollision` is driven through its real public inputs so
 * the frame-pixel arithmetic is exercised too. */

const W = 30;
const H = 30;
const GEOM = ISO_GEOMETRY_MAPS3;
/** A world with one piece whose hitbox ellipse is `rx` x `ry` FRAME px, placed
 *  at cell (cx, cy). k = wph/bboxHeight = 1 here, so frame px == screen px. */
function oneFootprint(rx: number, ry: number, at: { x: number; y: number }[]): TerrainGrid {
  const rows = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ t: "grass", l: 0 })));
  const grid = buildTerrainGrid(W, H, rows, [], []);
  const bbox: SceneryBboxDoc = {
    pieces: { p: { wph: 100, sprite: "s" } },
    boxes: { s: [0, 0, 100, 100, 100, 100] }, // bx0,by0,bx1,by1,frameW,frameH
  };
  const hitbox: SceneryHitboxDoc = { "scenery/p": { boxes: [{ ax: 0, ay: -50, rx, ry }] } };
  stampSceneryCollision(grid, at.map((a) => ({ piece: "p", x: a.x, y: a.y })), bbox, hitbox, GEOM);
  return grid;
}
const walk = { maxClimb: WALK_CLIMB, canSwim: true };
const DIRS: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];
/** How far inside the DRAWN ellipse (gauge < 1) the body ever gets, running at
 *  it from `dir`, offset `lat` wu sideways. */
function closestGauge(grid: TerrainGrid, j: number, ax: number, ay: number, lat: number): number {
  const fp = grid.footprints!;
  const v = screenToWorldVector(ax, ay);
  const l = Math.hypot(v.x, v.y);
  const ux = v.x / l;
  const uy = v.y / l;
  let x = fp.cx[j] * CELL_WU - ux * 3 * CELL_WU - uy * lat;
  let y = fp.cy[j] * CELL_WU - uy * 3 * CELL_WU + ux * lat;
  const bl = makeBlocked(grid, walk);
  const sb = makeSideBlocked(grid, walk);
  let worst = Infinity;
  for (let i = 0; i < 90; i++) {
    const r = stepMovement(x, y, ax, ay, true, 0.033, bl, 1, true, W * CELL_WU, H * CELL_WU, sb);
    x = r.x;
    y = r.y;
    const ox = x / CELL_WU - fp.cx[j];
    const oy = y / CELL_WU - fp.cy[j];
    worst = Math.min(worst, Math.hypot(((ox - oy) * GEOM.dx) / fp.rx[j], ((ox + oy) * GEOM.dy) / fp.ry[j]));
  }
  return worst;
}

test("the drawn ellipse is kept, and it is what the body collides with", () => {
  const grid = oneFootprint(40, 17, [{ x: 15, y: 15 }]);
  const fp = grid.footprints!;
  assert.equal(fp.n, 1, "the footprint must survive the stamp");
  assert.equal(fp.rx[0], 40);
  assert.equal(fp.ry[0], 17); // published semi-axes, unrounded, in SCREEN px
  // p and q are the SAME ellipse read as the world ellipse it is the image of.
  assert.ok(Math.abs(fp.p[0] - 40 / (GEOM.dx * Math.SQRT2)) < 1e-12);
  assert.ok(Math.abs(fp.q[0] - 17 / (GEOM.dy * Math.SQRT2)) < 1e-12);
  // Running at it from any direction and any offset, the body never gets in.
  for (const [ax, ay] of DIRS)
    for (const lat of [-16, -8, 0, 8, 16]) {
      const g = closestGauge(grid, 0, ax, ay, lat);
      assert.ok(g >= 1, `stick (${ax},${ay}) offset ${lat}: body reached gauge ${g.toFixed(2)} — inside the drawn ellipse`);
    }
});

test("a footprint too small to fill a cell blocks NO cell, and still stops the body", () => {
  // 4 frame px of semi-axis: under half a cell in world terms.
  const grid = oneFootprint(9, 4, [{ x: 15.5, y: 15.5 }]);
  const nav = grid.blocked.filter(Boolean).length;
  assert.equal(nav, 0, "a small piece must be invisible to the NAV layer");
  assert.equal(grid.footprints!.n, 1, "…but present as a real ellipse");
  for (const [ax, ay] of DIRS) {
    const g = closestGauge(grid, 0, ax, ay, 0);
    assert.ok(g >= 1, `stick (${ax},${ay}): ran through the small footprint (gauge ${g.toFixed(2)})`);
  }
});

test("no footprint is thinner than the probe lattice can see", () => {
  const grid = oneFootprint(1, 1, [{ x: 15, y: 15 }]);
  const fp = grid.footprints!;
  assert.ok(fp.p[0] * CELL_WU >= MIN_FOOTPRINT_SEMI - 1e-9, `world semi-axis ${fp.p[0] * CELL_WU}`);
  assert.ok(fp.q[0] * CELL_WU >= MIN_FOOTPRINT_SEMI - 1e-9, `world semi-axis ${fp.q[0] * CELL_WU}`);
});

test("the nav layer is a UNION question: two pieces close a cell neither closes alone", () => {
  /* The maintainer's own second case: "trees stand so close the ellipse from
   * the two trees leave no opening for the player to pass through." A per-piece
   * rule cannot answer that; a lattice over the union can. */
  const alone = oneFootprint(40, 17, [{ x: 15, y: 15 }]).blocked.filter(Boolean).length;
  const pair = oneFootprint(40, 17, [{ x: 15, y: 15 }, { x: 15, y: 17 }]).blocked.filter(Boolean).length;
  assert.equal(alone, 1, "one piece this size fills exactly its own cell");
  assert.ok(pair > 2 * alone, `two pieces 2 cells apart blocked ${pair} cells; separately they block ${2 * alone}`);
});

test("scenery never touches propBlocked, and never touches the surface a body stands on", () => {
  const grid = oneFootprint(40, 17, [{ x: 15, y: 15 }]);
  assert.equal(grid.propBlocked.filter(Boolean).length, 0, "scenery is not terrain");
  assert.ok(grid.blocked.filter(Boolean).length > 0, "…but it IS in the nav layer (F7: this array may never go silently empty)");
  // F2: a body standing INSIDE a footprint still stands on the floor. Anything
  // else pops its elevation on a spawn, a landing or a knockback.
  const cx = grid.footprints!.cx[0] * CELL_WU;
  const cy = grid.footprints!.cy[0] * CELL_WU;
  assert.ok(footprintBlocks(grid, cx, cy, 0), "the centre really is inside the ellipse");
  assert.equal(resolveElevAt(grid, 0, cx, cy, walk), 0, "a footprint is scenery ON ground, not an absence of ground");
});

test("both probe funnels see the footprint, so the detectors and the tick agree (F1)", () => {
  const grid = oneFootprint(40, 17, [{ x: 15, y: 15 }]);
  const fp = grid.footprints!;
  const step = 3;
  let checked = 0;
  for (let x = (fp.cx[0] - 3) * CELL_WU; x < (fp.cx[0] + 3) * CELL_WU; x += step) {
    for (let y = (fp.cy[0] - 3) * CELL_WU; y < (fp.cy[0] + 3) * CELL_WU; y += step) {
      const viaPoint = isBlockedAtWorld(grid, x, y);
      const viaTick = !canEnterElev(grid, 0, x, y, x, y, walk).ok;
      assert.equal(viaTick, viaPoint, `disagreement at ${x},${y}`);
      checked++;
    }
  }
  assert.ok(checked > 1000, `only ${checked} points compared`);
});

test("the glide slides a body around a footprint that per-axis resolution stops dead", () => {
  const grid = oneFootprint(40, 17, [{ x: 15, y: 15 }]);
  const bl = makeBlockedElev(grid, walk, () => 0);
  const sb = makeSideBlocked(grid, walk);
  // The SAME predicates with the contact normal stripped off — that is exactly
  // what a caller who rolls their own predicate gets, and what this code did
  // before the glide existed.
  const noGlide: BlockedFn = (a, b, c, d) => bl(a, b, c, d);
  const noGlideSide: BlockedFn = (a, b, c, d) => sb(a, b, c, d);
  const fp = grid.footprints!;
  let better = 0;
  let worse = 0;
  for (const [ax, ay] of DIRS) {
    for (const lat of [-20, -12, -6, 6, 12, 20]) {
      const v = screenToWorldVector(ax, ay);
      const l = Math.hypot(v.x, v.y);
      const ux = v.x / l;
      const uy = v.y / l;
      const run = (b: BlockedFn, s: BlockedFn) => {
        let x = fp.cx[0] * CELL_WU - ux * 3 * CELL_WU - uy * lat;
        let y = fp.cy[0] * CELL_WU - uy * 3 * CELL_WU + ux * lat;
        const x0 = x;
        const y0 = y;
        for (let i = 0; i < 90; i++) {
          const r = stepMovement(x, y, ax, ay, false, 0.033, b, 1, true, W * CELL_WU, H * CELL_WU, s);
          x = r.x;
          y = r.y;
        }
        return (x - x0) * ux + (y - y0) * uy;
      };
      const off = run(noGlide, noGlideSide);
      const on = run(bl, sb);
      if (on > off + 1) better++;
      if (on < off - 1) worse++;
    }
  }
  assert.equal(worse, 0, `${worse} approaches went BACKWARDS with the glide on`);
  assert.ok(better >= 8, `the glide only helped ${better} of 48 approaches — it is not doing its job`);
});

test("findSpawn never puts a body inside a footprint", () => {
  const at: { x: number; y: number }[] = [];
  for (let c = 4; c < 26; c += 2) for (let r = 4; r < 26; r += 2) at.push({ x: c + 0.5, y: r + 0.5 });
  const grid = oneFootprint(30, 13, at);
  for (let i = 0; i < 400; i++) {
    const s = findSpawn(grid, (3 + (i % 24)) * CELL_WU, (3 + ((i * 7) % 24)) * CELL_WU);
    assert.equal(footprintBlocks(grid, s.x, s.y, PLAYER_RADIUS), false,
      `spawn ${s.x.toFixed(1)},${s.y.toFixed(1)} is inside a footprint`);
  }
});

test("the contact normal points OUT of the shape it belongs to", () => {
  const grid = oneFootprint(40, 17, [{ x: 15, y: 15 }]);
  const fp = grid.footprints!;
  for (let a = 0; a < 32; a++) {
    const th = (a / 32) * 2 * Math.PI;
    const x = (fp.cx[0] + Math.cos(th) * 0.9) * CELL_WU;
    const y = (fp.cy[0] + Math.sin(th) * 0.9) * CELL_WU;
    const hit = footprintContact(grid, x, y, PLAYER_RADIUS);
    if (!hit) continue;
    // Stepping ALONG the normal must strictly reduce the penetration.
    const out = footprintContact(grid, x + hit.nx * 2, y + hit.ny * 2, PLAYER_RADIUS);
    assert.ok(!out || out.depth < hit.depth - 1e-9,
      `normal at angle ${a} does not lead out (${hit.depth} -> ${out?.depth})`);
  }
});
