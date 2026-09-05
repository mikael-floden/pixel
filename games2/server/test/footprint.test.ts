import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHARACTER_BODY_PX,
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
    pieces: { p: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } },
    boxes: { s: [0, 0, 100, 100, 100, 100] }, // bx0,by0,bx1,by1,frameW,frameH
  };
  const hitbox: SceneryHitboxDoc = { "scenery/p": { boxes: [{ ax: 0, ay: -50, rx, ry }] } };
  stampSceneryCollision(grid, at.map((a) => ({ piece: "p", x: a.x, y: a.y })), bbox, hitbox, GEOM);
  return grid;
}
/** The same world, with the box published as a RECTANGLE. */
function oneRectFootprint(rx: number, ry: number, at: { x: number; y: number }[], shape = "rect"): TerrainGrid {
  const rows = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ t: "grass", l: 0 })));
  const grid = buildTerrainGrid(W, H, rows, [], []);
  const bbox: SceneryBboxDoc = {
    pieces: { p: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } },
    boxes: { s: [0, 0, 100, 100, 100, 100] },
  };
  const hitbox: SceneryHitboxDoc = { "scenery/p": { boxes: [{ ax: 0, ay: -50, rx, ry, shape }] } };
  stampSceneryCollision(grid, at.map((a) => ({ piece: "p", x: a.x, y: a.y })), bbox, hitbox, GEOM);
  return grid;
}
/** World point at (fu, fv) of the footprint's own half-extents, through the
 *  SAME rotation footprintPenetration uses (X = (ox-oy)/R2, Y = (ox+oy)/R2). */
function atFraction(grid: TerrainGrid, j: number, fu: number, fv: number): { x: number; y: number } {
  const fp = grid.footprints!;
  const R2 = Math.SQRT2;
  const X = fu * fp.p[j];
  const Y = fv * fp.q[j];
  const ox = (X + Y) / R2;
  const oy = (Y - X) / R2;
  return { x: (fp.cx[j] + ox) * CELL_WU, y: (fp.cy[j] + oy) * CELL_WU };
}

/* A RECTANGLE COLLIDES AS A RECTANGLE — its CORNERS are solid.
 *
 * live/tuning/scenery_hitbox.json publishes `shape: "rect"` on 571 boxes (every
 * bed, cupboard and shelf; 547 of them the wiki's own alpha-placed default) and
 * the game read none of it: every footprint collided as the ellipse INSCRIBED
 * in the published box, so a body walked into all four corners of every one of
 * them and the collision overlay drew an ellipse over a rectangle (maintainer
 * 2026-09-05: "I know the bed and shelf is a rect hitbox and not an ellipse").
 *
 * (0.9, 0.9) of the half-extents is the discriminating point: gauge sqrt(1.62)
 * = 1.27 puts it OUTSIDE the ellipse and inside the rect. The ellipse arm is
 * asserted too, so the test cannot pass by blocking everything. */
test("a rect footprint blocks its corners and an ellipse does not", () => {
  const RX = 40;
  const RY = 20;
  const rect = oneRectFootprint(RX, RY, [{ x: 15.5, y: 15.5 }]);
  const ell = oneFootprint(RX, RY, [{ x: 15.5, y: 15.5 }]);
  assert.equal(rect.footprints!.n, 1);
  assert.equal(ell.footprints!.n, 1);
  assert.equal(rect.footprints!.rect[0], 1);
  assert.equal(ell.footprints!.rect[0], 0);
  // Same geometry both ways — only the shape flag differs.
  assert.equal(rect.footprints!.p[0], ell.footprints!.p[0]);
  assert.equal(rect.footprints!.q[0], ell.footprints!.q[0]);
  for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as [number, number][]) {
    const c = atFraction(rect, 0, su * 0.9, sv * 0.9);
    assert.equal(footprintBlocks(rect, c.x, c.y, 0), true, `rect corner ${su},${sv}`);
    assert.equal(footprintBlocks(ell, c.x, c.y, 0), false, `ellipse corner ${su},${sv}`);
  }
  // The centre is inside both, and a point well outside is inside neither.
  const mid = atFraction(rect, 0, 0, 0);
  assert.equal(footprintBlocks(rect, mid.x, mid.y, 0), true);
  assert.equal(footprintBlocks(ell, mid.x, mid.y, 0), true);
  const out = atFraction(rect, 0, 1.6, 1.6);
  assert.equal(footprintBlocks(rect, out.x, out.y, 0), false);
  assert.equal(footprintBlocks(ell, out.x, out.y, 0), false);
  // An unknown/absent shape stays an ellipse — the default must not change.
  const other = oneRectFootprint(RX, RY, [{ x: 15.5, y: 15.5 }], "ellipse");
  assert.equal(other.footprints!.rect[0], 0);
});

/* THE BUCKET MUST REACH THE CORNERS TOO. A rect's world-axis support is
 * (p+q)/sqrt(2), strictly larger than the ellipse's sqrt((p^2+q^2)/2), so
 * bucketing a rect by the ellipse's formula leaves its corners in cells the
 * query never looks at — the body walks through them and every assertion above
 * still passes, because footprintBlocks would never be handed the footprint.
 * Asserted from the OUTSIDE: the corner cell must list the footprint. */
test("a rect footprint is bucketed into the cells its corners reach", () => {
  const grid = oneRectFootprint(56, 28, [{ x: 15.5, y: 15.5 }]);
  const fp = grid.footprints!;
  for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as [number, number][]) {
    const c = atFraction(grid, 0, su * 0.99, sv * 0.99);
    const col = Math.floor(c.x / CELL_WU);
    const row = Math.floor(c.y / CELL_WU);
    const i = row * grid.width + col;
    const listed: number[] = [];
    for (let k = fp.start[i]; k < fp.start[i + 1]; k++) listed.push(fp.items[k]);
    assert.ok(listed.includes(0), `corner cell ${col},${row} must list the footprint`);
  }
});

/** A rect placed with a FACING, and optionally per-facing overrides. */
function oneTurnedRect(
  rx: number, ry: number, dir: string,
  extra: Record<string, unknown> = {},
  at = { x: 15.5, y: 15.5 },
): TerrainGrid {
  const rows = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ t: "grass", l: 0 })));
  const grid = buildTerrainGrid(W, H, rows, [], []);
  const bbox: SceneryBboxDoc = {
    pieces: { p: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } },
    boxes: { s: [0, 0, 100, 100, 100, 100] },
  };
  const hitbox: SceneryHitboxDoc = {
    "scenery/p": { boxes: [{ ax: 0, ay: -50, rx, ry, shape: "rect", ...extra } as never] },
  };
  stampSceneryCollision(grid, [{ piece: "p", x: at.x, y: at.y, dir }], bbox, hitbox, GEOM);
  return grid;
}
/** A world point at (fu, fv) of the footprint's half-extents IN THE BOX'S OWN
 *  TURNED AXES — the frame footprintPenetration tests in. */
function atBoxFraction(grid: TerrainGrid, j: number, fu: number, fv: number): { x: number; y: number } {
  const fp = grid.footprints!;
  const R2 = Math.SQRT2;
  const U = fu * fp.p[j];
  const V = fv * fp.q[j];
  const X = U * fp.rcos[j] - V * fp.rsin[j];
  const Y = U * fp.rsin[j] + V * fp.rcos[j];
  const ox = (X + Y) / R2;
  const oy = (Y - X) / R2;
  return { x: (fp.cx[j] + ox) * CELL_WU, y: (fp.cy[j] + oy) * CELL_WU };
}

/* A RECT IS A GROUND RECTANGLE, AND THE FACING TURNS IT.
 *
 * wiki.js `rectCorners`: the edges follow the two GROUND axes, so a turned piece
 * projects to a PARALLELOGRAM. The first cut of this collided (and drew) a
 * SCREEN-aligned box, which is right only for an unturned south piece — every
 * turned bed got a box that did not follow the furniture (maintainer
 * 2026-09-05, beside the wiki's own render: "you just drew a box at the bottom
 * bed corner ... I can walk straight up on the bed"). */
test("a rect turns with its facing, and south is the unturned box", () => {
  /* LONG in the (X, Y) frame, or the test cannot tell a turn from a square:
   * p/q = 0.4375 * rx/ry, so 48x16 is only 1.3:1 and the turned box's far
   * corner still falls inside the unturned one. 96x14 is 3:1. */
  const south = oneTurnedRect(96, 14, "south");
  const se = oneTurnedRect(96, 14, "south-east");
  assert.equal(south.footprints!.rect[0], 1);
  assert.equal(se.footprints!.rect[0], 1);
  // south = 0 degrees on the ground; south-east = -45.
  assert.ok(Math.abs(south.footprints!.rcos[0] - 1) < 1e-12, "south is unturned");
  assert.ok(Math.abs(south.footprints!.rsin[0]) < 1e-12);
  assert.ok(Math.abs(se.footprints!.rsin[0] + Math.SQRT1_2) < 1e-9, "south-east turns -45");
  // The SIZE is unchanged by the turn — only the orientation.
  assert.ok(Math.abs(se.footprints!.p[0] - south.footprints!.p[0]) < 1e-12);
  assert.ok(Math.abs(se.footprints!.q[0] - south.footprints!.q[0]) < 1e-12);
  // A point at the corner of each box's OWN axes is inside that box...
  for (const g of [south, se]) {
    for (const [su, sv] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as [number, number][]) {
      const c = atBoxFraction(g, 0, su * 0.9, sv * 0.9);
      assert.equal(footprintBlocks(g, c.x, c.y, 0), true);
    }
  }
  // ...and the turn really moves the shape: a point far along the LONG axis of
  // the turned box is outside the unturned one, and vice versa.
  const far = atBoxFraction(se, 0, 0.95, 0);
  assert.equal(footprintBlocks(se, far.x, far.y, 0), true, "inside the turned box");
  assert.equal(footprintBlocks(south, far.x, far.y, 0), false, "outside the unturned one");
});

/* THE PER-FACING OVERRIDES ARE READ. The art's anchor is not the same point on
 * every facing, so the wiki stores placement per facing and size as an opt-in
 * exception; reading only the base ax/ay/rx/ry put every turned piece's box in
 * the wrong place at the wrong size. */
test("pos_by_dir moves a rect and size_by_dir resizes it, per facing", () => {
  const base = oneTurnedRect(40, 20, "south-east");
  const moved = oneTurnedRect(40, 20, "south-east", { pos_by_dir: { "south-east": { ax: 0, ay: -20 } } });
  const dy = Math.abs(moved.footprints!.cy[0] - base.footprints!.cy[0])
    + Math.abs(moved.footprints!.cx[0] - base.footprints!.cx[0]);
  assert.ok(dy > 0.2, `pos_by_dir must move the box (moved ${dy.toFixed(3)} cells)`);
  // A facing with no entry of its own keeps the base placement.
  const other = oneTurnedRect(40, 20, "south", { pos_by_dir: { "south-east": { ax: 0, ay: -20 } } });
  const un = oneTurnedRect(40, 20, "south");
  assert.equal(other.footprints!.cx[0], un.footprints!.cx[0]);
  assert.equal(other.footprints!.cy[0], un.footprints!.cy[0]);

  const big = oneTurnedRect(40, 20, "south", { size_by_dir: { south: { rx: 80, ry: 20 } } });
  assert.ok(big.footprints!.p[0] > un.footprints!.p[0] * 1.9, "size_by_dir must resize it");
  assert.equal(big.footprints!.q[0], un.footprints!.q[0]);
});

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

// ============================================================================
// THE RECORD THE WIKI SHOWS IS THE RECORD THE BODY HITS
// ============================================================================
//
// A piece names its variations in UPPER_SNAKE and the placement copies that
// verbatim (`"state": "NOT_LIT_4"`); the wiki writes its override key in LOWER
// (`#not_lit_4`) — all 3,689 state-keyed records are lower, not one is upper.
// So an exact-case lookup matches nothing, and the stamp's last-resort scan
// ("any variation of this piece") then serves a box the maintainer drew for a
// DIFFERENT variation. He caught it with the wiki open beside the game on
// driftwood_log_901 NOT_LIT_4 — own record a wide flat rx 27 / ry 12.5, served
// #not_lit_1's 24 x 24 circle: "It's not the same hitbox!"
//
// Measured on the_game before the fix: of 486 placements carrying a state, 0
// reached their own record and 376 were served another variation's.
test("a variation's own hitbox wins over another variation's", () => {
  const doc: SceneryHitboxDoc = {
    // Only lower-case keys exist, which is what the wiki actually writes. The
    // circle is FIRST so a document-order scan finds it before the right one.
    "scenery/p#not_lit_1": { boxes: [{ ax: 0, ay: -50, rx: 24, ry: 24 }] },
    "scenery/p#not_lit_4": { boxes: [{ ax: 0, ay: -50, rx: 27, ry: 12.5 }] },
  };
  const stamp = (state?: string) => {
    const rows = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ t: "grass", l: 0 })));
    const grid = buildTerrainGrid(W, H, rows, [], []);
    const bbox: SceneryBboxDoc = {
      pieces: { p: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } },
      boxes: { s: [0, 0, 100, 100, 100, 100] },
    };
    stampSceneryCollision(grid, [{ piece: "p", x: 15, y: 15, state }], bbox, doc, ISO_GEOMETRY_MAPS3);
    const f: any = grid.footprints;
    return { rx: f.rx[0], ry: f.ry[0] };
  };

  // THE BUG, stated as the ratio so the frame->world scaling cannot mask it:
  // not_lit_1 is a circle and not_lit_4 is 2.16:1. Reading the wrong record is
  // therefore visible without knowing the scale factor at all.
  const four = stamp("NOT_LIT_4");
  assert.ok(
    Math.abs(four.rx / four.ry - 27 / 12.5) < 1e-9,
    `NOT_LIT_4 got ${four.rx.toFixed(2)} x ${four.ry.toFixed(2)} — that is another variation's box`,
  );
  const one = stamp("NOT_LIT_1");
  assert.ok(Math.abs(one.rx / one.ry - 1) < 1e-9, "NOT_LIT_1 is the circle it was drawn as");
  // AND THE ARM THAT KEEPS THIS HONEST: the two records really are different
  // shapes, so the assertion above cannot pass by both resolving to the same
  // record — which is exactly how the bug looked.
  assert.ok(Math.abs(four.rx / four.ry - one.rx / one.ry) > 1, "the fixture's two variations must differ");

  // A state nobody tuned still gets SOMETHING (the waystone_009 rule: a piece
  // with no footprint is worse than an approximate one) — the last resort.
  const none = stamp("NOT_LIT_9");
  assert.ok(none.rx > 0 && none.ry > 0, "an untuned variation falls back rather than losing its hitbox");
});
