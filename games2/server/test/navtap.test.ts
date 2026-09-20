// A TAP ROUTE IS WALKED BEFORE IT IS TAKEN, AND A LEGAL BODY POSITION IS ONE
// THE BODY MAY STAND IN (maintainer 2026-09-20, two reports beside the house:
// from 297.7,199.4 a tap route through a gap the body cannot fit, stuck; from
// 303.2,198.6 a tap through the fence line, "change direction back and forth").
// The shared brain, headless: synthetic grids first, the real grid where it is
// checked out (the deploy's test job has no world tree: those arms skip).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHARACTER_BODY_PX, buildTerrainGrid, stampSceneryCollision, ISO_GEOMETRY_MAPS3, startBestTrip, startTrip,
  stepAutopilot, bodyStalled, slideAlong, unstickFromSolids, stepMovement, makeBlockedElev, makeSideBlocked,
  levelAtWorld, resolveElevAt, surfaceAtWorldElev, footprintBlocks, parseWorld,
  CELL_WU, PLAYER_RADIUS, WALK_CLIMB, WALL_STANDOFF,
  type TerrainGrid, type SceneryBboxDoc, type SceneryHitboxDoc, type SlideMemo, type AutopilotTrip,
} from "@nangijala/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const W = 30;
const H = 30;

/** A grass world with a wall row at row 10 (level `wallLevel`), one gap cell
 *  at `door` if given, and one piece `rx` x `ry` (screen px; a rect when
 *  `rect`) at (15.5, pieceY) turned onto the world axes (dir south-west). The
 *  default 60 x 10 px is a slab as thick as the body, so the thin-axis rule
 *  (pass 3b) leaves it and the cell test alone answers. */
function world(o: { pieceY: number; wallLevel?: number; door?: number; rect?: boolean; rx?: number; ry?: number }): TerrainGrid {
  const wallLevel = o.wallLevel ?? 6;
  const rows = Array.from({ length: H }, (_, r) => Array.from({ length: W }, (_, c) => ({ t: "grass", l: r === 10 && c !== o.door ? wallLevel : 0 })));
  const g = buildTerrainGrid(W, H, rows, [], []);
  const bbox: SceneryBboxDoc = { pieces: { p: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } }, boxes: { s: [0, 0, 100, 100, 100, 100] } };
  const hitbox: SceneryHitboxDoc = { "scenery/p": { boxes: [{ ax: 0, ay: 50, rx: o.rx ?? 60, ry: o.ry ?? 10, ...(o.rect === false ? {} : { shape: "rect" }), rot: 0 }] } };
  stampSceneryCollision(g, [{ piece: "p", x: 15.5, y: o.pieceY, dir: "south-west" }], bbox, hitbox, ISO_GEOMETRY_MAPS3);
  return g;
}
/** The free body positions of a cell on a 16x16 lattice, and how many of them
 *  lie at least WALL_STANDOFF off the wall row above (row 10). */
function freeIn(g: TerrainGrid, c: number, r: number): { free: number; offWall: number } {
  let free = 0;
  let offWall = 0;
  for (let a = 0; a < 16; a++)
    for (let b = 0; b < 16; b++) {
      const x = (c + (b + 0.5) / 16) * CELL_WU;
      const y = (r + (a + 0.5) / 16) * CELL_WU;
      if (footprintBlocks(g, x, y, PLAYER_RADIUS, 0)) continue;
      free++;
      if (y - 11 * CELL_WU >= WALL_STANDOFF) offWall++;
    }
  return { free, offWall };
}

test("a body position inside a wall's standoff is not a legal one: the cell between the wall and a piece pressed to it is nav-closed", () => {
  // His 297.7,199.4: the route ran along the house wall through 299,198,
  // whose only free body positions lie within 12 wu of the wall — where the
  // rescue pushes a body off every tick. The old bake counted them.
  const g = world({ pieceY: 12.15 });
  const cell = 11 * W + 15;
  const f = freeIn(g, 15, 11);
  assert.ok(f.free > 0 && f.offWall === 0, `the fixture: free positions exist (${f.free}) and every one hugs the wall (${f.offWall} off it)`);
  assert.ok(g.blocked[cell] && g.sceneryBlocked?.[cell], "no legal body position: the cell is closed to the route");
  // The same piece one cell further out leaves room the body may stand in.
  const far = world({ pieceY: 13.15 });
  assert.ok(freeIn(far, 15, 11).offWall > 0 && !far.blocked[cell], "a cell with a legal position stays open");
  // A DOORWAY survives: a one-cell gap in the wall keeps 8 wu of legal centre
  // positions between the two standoffs.
  const door = world({ pieceY: 14.9, door: 15 });
  assert.ok(!door.blocked[10 * W + 15] && !door.blocked[cell], "a doorway and the cell in front of it stay open");
  // A ledge the body can HOP is not a wall (cellWallFrom: JUMP_CLIMB), so the
  // same cell beside a two-level step keeps its positions.
  const hop = world({ pieceY: 12.15, wallLevel: 2 });
  assert.ok(!hop.blocked[cell], "beside a hop-able ledge the cell stays open");
});

/** The spawn house's cupboard and table (sceneryslide.test.ts), the table 4 wu
 *  closer and the cupboard's ellipse 5 px shorter so it is not thin (pass 3b
 *  would wall its axis): the cell between them is nav-open along its west
 *  edge, and the gap at its middle is short of the body's 18 wu of probes
 *  from any approach (at sceneryslide's 16.825 a square approach slides
 *  through). */
function pinchWorld(tabY = 16.7): TerrainGrid {
  const rows = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ t: "grass", l: 0 })));
  const g = buildTerrainGrid(W, H, rows, [], []);
  const bbox: SceneryBboxDoc = {
    pieces: { cup: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" }, tab: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } },
    boxes: { s: [0, 0, 100, 100, 100, 100] },
  };
  const hitbox: SceneryHitboxDoc = {
    "scenery/cup": { boxes: [{ ax: 0, ay: 50, rx: 25, ry: 6, rot: 0 }] },
    "scenery/tab": { boxes: [{ ax: 0, ay: 50, rx: 26, ry: 7.56, shape: "rect", rot: 0 }] },
  };
  stampSceneryCollision(g, [{ piece: "cup", x: 15, y: 15.0 }, { piece: "tab", x: 15, y: tabY }], bbox, hitbox, ISO_GEOMETRY_MAPS3);
  return g;
}
const inCell = (p: { x: number; y: number }, c: number, r: number) => Math.floor(p.x / CELL_WU) === c && Math.floor(p.y / CELL_WU) === r;

/** The client's frame for a tap trip (WorldScene: driveAutopilot, the tap
 *  floor's slide, the rescue, the predicted step), at a phone's 33 ms. */
function follow(g: TerrainGrid, trip: AutopilotTrip, x: number, y: number, ticks: number, ww = W * CELL_WU, wh = H * CELL_WU) {
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  const memo: SlideMemo = { ax: 0, ay: 0 };
  const dt = 1 / 30;
  let elev = levelAtWorld(g, x, y);
  let t = 0;
  let done = false;
  let flips = 0;
  let frozen = 0;
  let maxFrozen = 0;
  let last = "";
  for (let i = 0; i < ticks; i++) {
    t += dt * 1000;
    const d = stepAutopilot(g, trip, x, y, t, ww, wh, elev);
    if (d.done) { done = true; break; }
    let ax = d.ax;
    let ay = d.ay;
    if ((ax !== 0 || ay !== 0) && bodyStalled(g, x, y, ax, ay, elev)) {
      const sl = slideAlong(g, x, y, ax, ay, memo, elev);
      if (sl) { ax = sl.ax; ay = sl.ay; }
    } else { memo.ax = 0; memo.ay = 0; }
    const u = unstickFromSolids(g, x, y, 80 * dt, undefined, elev);
    x = u.x; y = u.y;
    const ge = () => elev;
    const m = stepMovement(x, y, ax, ay, d.running, dt, makeBlockedElev(g, walk, ge), surfaceAtWorldElev(g, x, y, elev).speed, true, ww, wh, makeSideBlocked(g, walk, ge), { screenSlide: false });
    const moved = Math.hypot(m.x - x, m.y - y);
    x = m.x; y = m.y;
    elev = resolveElevAt(g, elev, x, y, walk);
    frozen = moved < 0.05 ? frozen + 1 : 0;
    maxFrozen = Math.max(maxFrozen, frozen);
    const k = `${ax},${ay}`;
    if (last && k !== last) flips++;
    last = k;
  }
  return { x, y, done, flips, maxFrozen };
}
const cells = (p: { x: number; y: number }) => `(${(p.x / CELL_WU).toFixed(2)},${(p.y / CELL_WU).toFixed(2)})`;

test("the passage layer: a pinch's edge holds no body, so the route goes round it unproven", () => {
  // The table 6 wu closer still: a 16 wu gap, past the passage tests'
  // tolerance (NAV_PASS_TOL_WU); the cell keeps its positions along the edge.
  const g = pinchWorld(16.5);
  assert.ok(!g.blocked[15 * W + 15], "the pinch cell is nav-open: a body position exists along its edge");
  const from = { x: 16.4 * CELL_WU, y: 15.45 * CELL_WU };
  const to = { x: 13.0 * CELL_WU, y: 15.45 * CELL_WU, goalLevel: 0 };
  const bare = startTrip(g, from.x, from.y, to.x, to.y, true, 0, 0, 0);
  assert.ok(bare && bare.path.every((p) => !inCell(p, 15, 15)), `no waypoint in the pinch cell: ${bare?.path.map(cells).join(" ")}`);
  const r = follow(g, bare!, from.x, from.y, 200);
  assert.ok(Math.hypot(r.x - to.x, r.y - to.y) < CELL_WU * 1.25, `arrives round the pieces: ended ${cells(r)} done=${r.done} flips=${r.flips}`);
});

test("a tap route is walked before it is taken: without the passage bits the route threads the pinch, and the proof plans round it", () => {
  const g = pinchWorld();
  g.navPass = undefined; // the nav layer of 2026-09-19: cells only
  const from = { x: 16.4 * CELL_WU, y: 15.45 * CELL_WU };
  const to = { x: 13.0 * CELL_WU, y: 15.45 * CELL_WU, goalLevel: 0 };
  // The nav layer's own answer, unproven: the route threads the pinch.
  const bare = startTrip(g, from.x, from.y, to.x, to.y, true, 0, 0, 0);
  assert.ok(bare && bare.path.some((p) => inCell(p, 15, 15)), `unproven, the route threads the pinch: ${bare?.path.map(cells).join(" ")}`);
  // The tap: proven by walking, re-planned round what the body stood at.
  const t0 = performance.now();
  const trip = startBestTrip(g, from.x, from.y, true, 0, 0, [to]);
  const ms = performance.now() - t0;
  assert.ok(trip, "a trip is planned");
  assert.ok(trip!.path.every((p) => !inCell(p, 15, 15)), `no waypoint in the pinch cell: ${trip!.path.map(cells).join(" ")}`);
  const r = follow(g, trip!, from.x, from.y, 200);
  assert.ok(Math.hypot(r.x - to.x, r.y - to.y) < CELL_WU * 1.25, `arrives round the pieces within 6.7 s: ended ${cells(r)} done=${r.done} flips=${r.flips}`);
  assert.ok(r.maxFrozen < 15, `never stands at the pinch (${r.maxFrozen} frozen ticks)`);
  console.log(`# navtap: the proven tap planned in ${ms.toFixed(1)} ms`);
});

test("a pinch beyond the proof's reach: the follower's stall re-plans round the cell it stood at, more than once if it must", () => {
  const g = pinchWorld();
  g.navPass = undefined; // cells only, as above
  const from = { x: 29.4 * CELL_WU, y: 15.45 * CELL_WU }; // 14 cells east: the proof's 2 s run never reaches the pinch
  const to = { x: 13.0 * CELL_WU, y: 15.45 * CELL_WU, goalLevel: 0 };
  const trip = startBestTrip(g, from.x, from.y, true, 0, 0, [to]);
  assert.ok(trip && trip.path.some((p) => inCell(p, 15, 15)), `the proof passes a route that pinches later: ${trip?.path.map(cells).join(" ")}`);
  const r = follow(g, trip!, from.x, from.y, 450);
  assert.ok(Math.hypot(r.x - to.x, r.y - to.y) < CELL_WU * 1.25, `arrives within 15 s: ended ${cells(r)} done=${r.done} flips=${r.flips} frozen=${r.maxFrozen}`);
  const named = (trip!.avoid?.size ?? 0) + (trip!.avoidSteps?.size ?? 0);
  assert.ok((trip!.replans ?? 0) >= 1 && named > 0, `the stall named what it stood at and re-planned (replans ${trip!.replans}, avoid ${[...(trip!.avoid ?? [])].join(",")}, steps ${[...(trip!.avoidSteps ?? [])].map((k) => `${Math.floor(k / (W * H))}>${k % (W * H)}`).join(",")})`);
});

/** His fence: a rect 103.6 x 8.4 screen px facing south — screen-horizontal,
 *  the world diagonal (1,-1) — at (15.5, 15.5). */
function railWorld(): TerrainGrid {
  const rows = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ t: "grass", l: 0 })));
  const g = buildTerrainGrid(W, H, rows, [], []);
  const bbox: SceneryBboxDoc = { pieces: { rail: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } }, boxes: { s: [0, 0, 100, 100, 100, 100] } };
  const hitbox: SceneryHitboxDoc = { "scenery/rail": { boxes: [{ ax: 0, ay: 50, rx: 51.8, ry: 4.2, shape: "rect", rot: 0 }] } };
  stampSceneryCollision(g, [{ piece: "rail", x: 15.5, y: 15.5 }], bbox, hitbox, ISO_GEOMETRY_MAPS3);
  return g;
}

test("a rail is a wall between the cells its axis runs through: they close, the route goes round its end, no stall needed", () => {
  const g = railWorld();
  // The axis runs from (14.7,16.3) to (16.3,14.7): cells (14,16), (15,15), (16,14).
  for (const [c, r] of [[14, 16], [15, 15], [16, 14]]) assert.ok(g.blocked[r * W + c] && g.sceneryBlocked?.[r * W + c], `cell ${c},${r} on the axis is closed`);
  for (const [c, r] of [[14, 15], [16, 16], [13, 17], [17, 13], [15, 16], [16, 15]]) assert.ok(!g.blocked[r * W + c], `cell ${c},${r} beside the rail stays open`);
  // His tap: from the rail's north-west side to the path just past it.
  const from = { x: 15.2 * CELL_WU, y: 14.6 * CELL_WU };
  const to = { x: 16.5 * CELL_WU, y: 15.5 * CELL_WU, goalLevel: 0 };
  const trip = startBestTrip(g, from.x, from.y, true, 0, 0, [to]);
  assert.ok(trip, "a trip is planned");
  assert.ok(trip!.path.every((p) => !inCell(p, 15, 15) && !inCell(p, 14, 16) && !inCell(p, 16, 14)), `no waypoint on the rail: ${trip!.path.map(cells).join(" ")}`);
  const r = follow(g, trip!, from.x, from.y, 300);
  assert.ok(Math.hypot(r.x - to.x, r.y - to.y) < CELL_WU * 1.25, `round the rail's end: ended ${cells(r)} done=${r.done} flips=${r.flips} frozen=${r.maxFrozen}`);
  assert.equal(trip!.replans ?? 0, 0, "the first route walks: no stall re-plan");
});

/** The real grid, stamped the way the server stamps it (the live hitbox
 *  document read from the repo; the deploy's sparse checkout has neither). */
const NEEDS = ["maps2/worlds3/the_game/world.json", "live/tuning/scenery_hitbox.json", "config/scenery-bbox.json"];
const MISSING = NEEDS.filter((p) => !existsSync(join(p.startsWith("config/") ? join(REPO, "games2") : REPO, p)));
async function realGrid(): Promise<{ g: TerrainGrid; ww: number; wh: number; scenery: { piece: string; x: number; y: number }[] }> {
  const { sceneryBbox } = await import("../src/rooms/WorldRoom.js");
  const doc = JSON.parse(readFileSync(join(REPO, "maps2/worlds3/the_game/world.json"), "utf8"));
  const hit = JSON.parse(readFileSync(join(REPO, "live/tuning/scenery_hitbox.json"), "utf8"));
  const world = parseWorld(doc)!;
  const g = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
  stampSceneryCollision(g, world.scenery ?? [], sceneryBbox(), hit.overrides, ISO_GEOMETRY_MAPS3);
  return { g, ww: world.width * CELL_WU, wh: world.height * CELL_WU, scenery: world.scenery ?? [] };
}
const placed = (scenery: { piece: string; x: number; y: number }[], piece: string, x: number, y: number) =>
  scenery.some((s) => s.piece === piece && Math.abs(s.x - x) < 0.05 && Math.abs(s.y - y) < 0.05);

test("on the_game: his fence at 303.7,199.7 is walked round, and the wall corridor at 299,198 is closed", { skip: MISSING.length ? `not checked out: ${MISSING.join(", ")}` : false }, async (t) => {
  const { g, ww, wh, scenery } = await realGrid();
  // The pieces as he reported them; re-authored scenery makes this arm moot.
  if (!placed(scenery, "fences/fence_006", 303.73, 199.65) || !placed(scenery, "lantern_posts/lantern_post_001", 299.63, 198.63) || !placed(scenery, "woodpiles/woodpile_008", 300.43, 199.88))
    return t.skip("the scenery beside the house has been re-placed");
  // 303.2,198.6 -> the path beyond the fence: the fence is a thin diagonal
  // rectangle that closes no cell, so the unproven route ran straight through
  // it and the follower changed direction back and forth at the rail.
  const from = { x: 303.2 * CELL_WU, y: 198.6 * CELL_WU };
  const to = { x: 304.5 * CELL_WU, y: 199.5 * CELL_WU, goalLevel: 0 };
  const trip = startBestTrip(g, from.x, from.y, true, 0, 0, [to]);
  assert.ok(trip, "a trip is planned");
  const r = follow(g, trip!, from.x, from.y, 300, ww, wh);
  assert.ok(Math.hypot(r.x - to.x, r.y - to.y) < CELL_WU * 1.25, `round the fence within 10 s: ended ${cells(r)} done=${r.done} flips=${r.flips} frozen=${r.maxFrozen}`);
  // 297.7,199.4: the corridor between the house wall and the lantern post
  // holds no legal body position (its free positions all hug the wall).
  assert.ok(g.blocked[198 * g.width + 299], "cell 299,198 is closed to the route");
});
