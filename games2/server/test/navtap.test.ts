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
  CELL_WU, PLAYER_RADIUS, WALK_CLIMB, WALL_STANDOFF, MONSTER_ROAM_MAX_NODES, surfaceFor,
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
  // The axis runs from (14.7,16.3) to (16.3,14.7): it crosses (15,15) edge to
  // edge and ENDS inside (14,16) and (16,14), where a body goes round the tip.
  assert.ok(g.blocked[15 * W + 15] && g.sceneryBlocked?.[15 * W + 15], "the cell the axis crosses is closed");
  for (const [c, r] of [[14, 16], [16, 14], [14, 15], [16, 16], [13, 17], [17, 13], [15, 16], [16, 15]]) assert.ok(!g.blocked[r * W + c], `cell ${c},${r} at the rail's end or beside it stays open`);
  // His tap: from the rail's north-west side to the path just past it.
  const from = { x: 15.2 * CELL_WU, y: 14.6 * CELL_WU };
  const to = { x: 16.5 * CELL_WU, y: 15.5 * CELL_WU, goalLevel: 0 };
  const trip = startBestTrip(g, from.x, from.y, true, 0, 0, [to]);
  assert.ok(trip, "a trip is planned");
  assert.ok(trip!.path.every((p) => !inCell(p, 15, 15)), `no waypoint across the rail: ${trip!.path.map(cells).join(" ")}`);
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
  // 297.7,199.4 -> the path: the pocket's exits are a hairline and the wall
  // corridor past the post; the walked proof keeps the route to what the
  // body walks, and the tap arrives (round the house) without standing.
  const from2 = { x: 297.7 * CELL_WU, y: 199.4 * CELL_WU };
  const to2 = { x: 302.4 * CELL_WU, y: 201.6 * CELL_WU, goalLevel: 0 };
  const trip2 = startBestTrip(g, from2.x, from2.y, true, 0, 0, [to2]);
  assert.ok(trip2, "a trip is planned out of the pocket");
  const r2 = follow(g, trip2!, from2.x, from2.y, 400, ww, wh);
  assert.ok(Math.hypot(r2.x - to2.x, r2.y - to2.y) < CELL_WU * 1.25, `out of the pocket and there within 13 s: ended ${cells(r2)} done=${r2.done} flips=${r2.flips} frozen=${r2.maxFrozen}`);
  assert.ok(r2.maxFrozen < 45, `never stands for long (${r2.maxFrozen} frozen ticks)`);
});

/** THE PROVEN PATHFINDER IS THE PLAYER'S, AND SO ARE ITS COSTS (maintainer
 *  2026-09-21: "the new accurate pathfinder was meant for the player"). A
 *  monster's roam leg is planned BUDGETED (MONSTER_ROAM_MAX_NODES) and with
 *  `canSwim` false, because water is the player's sanctuary. The stall re-plan
 *  of 61a04fdd1e passed NEITHER, whoever planned the trip: a land monster that
 *  stalled was handed a route across water it can never enter, walked to the
 *  shore, netted nothing, stalled again a second later and burned another
 *  UNBUDGETED search with a walked proof on it — on the server's 20 Hz tick,
 *  307 monsters in the_game. The trip now remembers what it was planned under
 *  and the re-plan keeps it; the walked proof stays the tap's. */
function lakeWorld(): TerrainGrid {
  // Grass, a lake across rows 12-16, and ONE dry cell wide corridor at column
  // 15 — with the pinch pieces standing in it, so the only dry way south is
  // one the nav layer threads per cell and the BODY cannot pass. Avoid that
  // cell and there is no dry route at all: the re-plan's `canSwim` decides
  // whether the monster is sent into the lake or gives the leg up.
  const rows = Array.from({ length: H }, (_, r) =>
    Array.from({ length: W }, (_, c) => ({ t: r >= 12 && r <= 16 && c !== 15 ? "water" : "grass", l: 0 })),
  );
  const g = buildTerrainGrid(W, H, rows, [], []);
  const bbox: SceneryBboxDoc = {
    pieces: { cup: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" }, tab: { wph: 100, cpx: CHARACTER_BODY_PX, sprite: "s" } },
    boxes: { s: [0, 0, 100, 100, 100, 100] },
  };
  const hitbox: SceneryHitboxDoc = {
    "scenery/cup": { boxes: [{ ax: 0, ay: 50, rx: 25, ry: 6, rot: 0 }] },
    "scenery/tab": { boxes: [{ ax: 0, ay: 50, rx: 26, ry: 7.56, shape: "rect", rot: 0 }] },
  };
  stampSceneryCollision(g, [{ piece: "cup", x: 15, y: 15.0 }, { piece: "tab", x: 15, y: 16.7 }], bbox, hitbox, ISO_GEOMETRY_MAPS3);
  return g;
}
const wet = (g: TerrainGrid, p: { x: number; y: number }) =>
  surfaceFor(g.type[Math.floor(p.y / CELL_WU) * W + Math.floor(p.x / CELL_WU)]).swimmable;

test("a monster's trip remembers its own limits, and its stall re-plan keeps them: never a route through water it cannot enter", () => {
  const g = lakeWorld();
  g.navPass = undefined; // cells only, as the tests above: the route threads the pinch
  const from = { x: 15.5 * CELL_WU, y: 9.0 * CELL_WU };
  const to = { x: 15.5 * CELL_WU, y: 22.0 * CELL_WU };
  const trip = startTrip(g, from.x, from.y, to.x, to.y, false, 0, 0, undefined, MONSTER_ROAM_MAX_NODES, false);
  assert.ok(trip, "a dry route south exists through the corridor");
  assert.ok(trip!.path.every((p) => !wet(g, p)), `the first route is dry: ${trip!.path.map(cells).join(" ")}`);

  // Walk it into the pinch. The body may not enter water either, so what the
  // stall re-plan decides is the whole of what happens next.
  const walk = { maxClimb: WALK_CLIMB, canSwim: false };
  const memo: SlideMemo = { ax: 0, ay: 0 };
  const dt = 1 / 30;
  let x = from.x;
  let y = from.y;
  let t = 0;
  let wetPath = 0;
  for (let i = 0; i < 400; i++) {
    t += dt * 1000;
    const d = stepAutopilot(g, trip!, x, y, t, W * CELL_WU, H * CELL_WU, 0);
    if (trip!.path.some((p) => wet(g, p))) wetPath++;
    if (d.done) break;
    let ax = d.ax;
    let ay = d.ay;
    if ((ax !== 0 || ay !== 0) && bodyStalled(g, x, y, ax, ay, 0)) {
      const sl = slideAlong(g, x, y, ax, ay, memo, 0);
      if (sl) { ax = sl.ax; ay = sl.ay; }
    } else { memo.ax = 0; memo.ay = 0; }
    const ge = () => 0;
    const m = stepMovement(x, y, ax, ay, false, dt, makeBlockedElev(g, walk, ge), surfaceAtWorldElev(g, x, y, 0).speed, true, W * CELL_WU, H * CELL_WU, makeSideBlocked(g, walk, ge), { screenSlide: false });
    x = m.x;
    y = m.y;
  }
  assert.ok((trip!.replans ?? 0) >= 1, `the body stalled at the pinch and re-planned (replans ${trip!.replans})`);
  // The limits themselves, asserted after the behaviour they produce.
  assert.equal(trip!.maxNodes, MONSTER_ROAM_MAX_NODES, "the trip carries the budget it was planned under");
  assert.equal(trip!.canSwim, false, "...and that it may not swim");
  assert.equal(wetPath, 0, `no re-plan ever routed the monster into the lake (${wetPath} ticks holding a wet route; unbudgeted, findPath swims by default)`);
  assert.ok(!wet(g, { x, y }), `and the body never stood in water (ended ${cells({ x, y })})`);
  console.log(`# navtap: the monster stalled ${trip!.replans} time(s) at the pinch, named ${(trip!.avoid?.size ?? 0)} cell(s) and ${(trip!.avoidSteps?.size ?? 0)} step(s), and never took to the water`);
});

// ============================================================================
// A RIM IS NEVER UNDER THE LID THE GOAL STANDS ON (maintainer 2026-09-23: an
// unreachable tap on the mountain over the dungeon ran the player into the
// dungeon). A cave: floor cells at 0 under a cave lid at 20, walled by rock
// at 20, open to the south. The lid is unreachable; the floor under it is
// two steps in. The best effort toward the lid must stop OUTSIDE the cave,
// and a tap that means the floor itself (a house from its door) still arrives.
test("an unreachable spot on a lid never best-efforts to the floor under it; the floor itself still arrives", () => {
  const W = 9, H = 12;
  const rows = Array.from({ length: H }, (_, r) => Array.from({ length: W }, (_, c) => {
    const rock = r >= 2 && r <= 6 && c >= 2 && c <= 6 && !(c === 4 && r >= 3); // a 5x5 block with a corridor at col 4 open south
    return { t: "grass", l: rock ? 20 : 0 };
  }));
  const decks = [{ level: 20, thickness: 0, mat: "grass", cells: [3, 4, 5].map((r) => ({ col: 4, row: r })) }];
  const g = buildTerrainGrid(W, H, rows, [], decks);
  const cx = (c: number) => (c + 0.5) * CELL_WU;
  const from = { x: cx(4), y: cx(10) };
  // The lid over (4,4): unreachable. Old rim: (4,4) itself on the floor.
  const onLid = startTrip(g, from.x, from.y, cx(4), cx(4), true, 0, 0, 20);
  assert.ok(onLid, "a best-effort trip exists");
  const endRow = Math.floor(onLid!.target.y / CELL_WU);
  assert.ok(endRow >= 6, `the rim toward the lid stops outside the cave (row ${endRow}), never on the floor under it`);
  // The floor under the lid, meant on purpose (a house from its door): arrives.
  const inside = startTrip(g, from.x, from.y, cx(4), cx(4), true, 0, 0, 0);
  assert.ok(inside && Math.abs(inside.endLevel ?? 0) < 0.5 && Math.floor(inside.target.y / CELL_WU) === 4, "the floor itself is still a destination");
  // And the tap's two readings together (startBestTrip): the floor arrives and wins.
  const both = startBestTrip(g, from.x, from.y, true, 0, 0, [{ x: cx(4), y: cx(4), goalLevel: 20 }, { x: cx(4), y: cx(4), goalLevel: 0 }]);
  assert.ok(both && Math.floor(both.target.y / CELL_WU) === 4, "with the floor offered as a reading, it wins as before");
});

// ============================================================================
// THE ESCAPE MAY GO SEVERAL TILES BACK INTO A BARE WALL, ONE INTO A ROOFED
// ONE (maintainer 2026-09-23, holding the stick up the mountain at
// 218.9,250.7: "the player get stuck over and over again in a Ʌ ... inside a
// house walking into a corner feels like a player decision. When outdoors and
// trying to run up a mountain that has to contain a lot of Ʌ I feel the player
// should navigate up the mountain more flawlessly"). The iso ground runs a
// screen-horizontal wall as a staircase of notches, and every sideways tile
// along it is a tile back on one world axis of an up-screen push; the way up
// from level 9 needs three, and the one-tile rule threw the found route away.
// A house's wall stands under its roof deck, a mountain's does not — judged by
// the wall, not the body: the spawn house's OUTSIDE corner (wallcorner.test.ts,
// held DOWN) keeps its one tile and the body still runs into it and stays.
import {
  walkHeading, hopIntoWall, ESCAPE_RETREAT_CELLS, ESCAPE_RETREAT_OPEN_CELLS, escapeRetreatCells,
  JUMP_CLIMB, JUMP_MS, JUMP_COOLDOWN_MS, JUMP_SPEED_FACTOR,
  NAV_HELP_MS_DEFAULT, NAV_SLIDE_DEG_DEFAULT, WALL_ASSIST_DEG_DEFAULT, type HopMemo,
} from "@nangijala/shared";

test("the escape's retreat allowance: one tile into a roofed wall, more into a bare one", () => {
  const rows = Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => ({ t: "grass", l: r === 2 ? 6 : 0 }))); // a wall row at level 6
  const roofed = buildTerrainGrid(8, 8, rows, [], [{ level: 6, thickness: 0, mat: "grass", cells: [{ col: 3, row: 2 }, { col: 4, row: 2 }] }]);
  const bare = buildTerrainGrid(8, 8, rows, [], []);
  // The body at (4,3) pressing screen-up (world -x,-y): the cells ahead are (3,3), (4,2), (3,2).
  assert.equal(escapeRetreatCells(roofed, 4.5 * CELL_WU, 3.5 * CELL_WU, -0.7, -0.7, 0), ESCAPE_RETREAT_CELLS, "the house's wall under its roof: one tile");
  assert.equal(escapeRetreatCells(bare, 4.5 * CELL_WU, 3.5 * CELL_WU, -0.7, -0.7, 0), ESCAPE_RETREAT_OPEN_CELLS, "the mountain's bare wall: the open allowance");
  assert.equal(escapeRetreatCells(roofed, 4.5 * CELL_WU, 3.5 * CELL_WU, -0.7, -0.7, 6), ESCAPE_RETREAT_OPEN_CELLS, "standing level with it, nothing ahead is a wall");
  assert.ok(ESCAPE_RETREAT_OPEN_CELLS >= 3, "the mountain's way up needs three");
});

/** Hold a screen input for `secs` on the real tick — the hold brain, the
 *  auto-jump, the movement step and the elevation resolve, as the client
 *  runs them — and report where the feet end up and the longest stand. */
function holdStick(g: TerrainGrid, ww: number, wh: number, cx: number, cy: number, elev0: number, ax: number, ay: number, secs: number) {
  let x = cx * CELL_WU, y = cy * CELL_WU, elev = elev0;
  let trip: AutopilotTrip | null = null;
  const memo: SlideMemo = { ax: 0, ay: 0 };
  const hop: HopMemo = { hop: null };
  let jumpUntil = -1, jumpReadyAt = -1, maxLevel = elev;
  let sx = x, sy = y, st = 0, worstStall = 0;
  const dt = 1 / 60;
  for (let t = 0; t < secs * 1000; t += 1000 * dt) {
    const r = walkHeading(g, x, y, ax, ay, memo, {
      nowMs: t, trip, fromElev: elev, worldW: ww, worldH: wh, heading: { ax, ay },
      wallAssistDeg: WALL_ASSIST_DEG_DEFAULT, navSlideDeg: NAV_SLIDE_DEG_DEFAULT, stuckMs: NAV_HELP_MS_DEFAULT, speedFrac: 1,
    });
    trip = r.trip;
    const canJump = t >= jumpUntil && t >= jumpReadyAt;
    const h = hopIntoWall(g, x, y, r.ax, r.ay, elev, t, canJump, hop, true);
    if (h.jump) { jumpUntil = t + JUMP_MS; jumpReadyAt = jumpUntil + JUMP_COOLDOWN_MS; }
    const jumping = t < jumpUntil;
    const ctx = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
    const u = unstickFromSolids(g, x, y, 80 * dt, undefined, elev); x = u.x; y = u.y;
    const m = stepMovement(x, y, h.ax, h.ay, true, dt, makeBlockedElev(g, ctx, () => elev), jumping ? JUMP_SPEED_FACTOR : 1, true, ww, wh, makeSideBlocked(g, ctx, () => elev), { screenSlide: trip === null });
    x = m.x; y = m.y;
    elev = resolveElevAt(g, elev, x, y, ctx);
    maxLevel = Math.max(maxLevel, elev);
    if (Math.hypot(x - sx, y - sy) > CELL_WU * 0.5) { sx = x; sy = y; st = t; }
    else worstStall = Math.max(worstStall, t - st);
  }
  return { x: x / CELL_WU, y: y / CELL_WU, elev, maxLevel, worstStall };
}

test("on the_game: holding the stick up from 218.9,250.7 climbs the mountain instead of standing in its notches", { skip: MISSING.length ? `not checked out: ${MISSING.join(", ")}` : false }, async (t) => {
  const { g, ww, wh } = await realGrid();
  const c = Math.floor(218.9), r = Math.floor(250.7);
  if (g.level[r * g.width + c] !== 4 || g.level[(r - 3) * g.width + c - 4] !== 9) return t.skip("the mountain at 214-219,247-251 has been re-authored");
  const res = holdStick(g, ww, wh, 218.9, 250.7, 4, 0, -1, 15);
  // Measured with the one-tile rule: stood at 214.5,247.4 on level 9 for the
  // whole run. With the open-terrain allowance: level 32 in 15 s, two escapes.
  assert.ok(res.maxLevel >= 20, `15 s of holding up reaches the high ground (got level ${res.maxLevel}, ended ${res.x.toFixed(1)},${res.y.toFixed(1)} L${res.elev})`);
  assert.ok(res.worstStall < 4000, `never stands in a notch for long (worst ${(res.worstStall / 1000).toFixed(1)} s)`);
});
