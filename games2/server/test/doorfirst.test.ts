// A DOOR WITHIN REACH WINS OVER THE ESCAPE ROUTE (docs/movement.md). Standing
// two cells outside a house's south wall with the doorway ONE cell to the side,
// held straight at the wall: the door-finder deflects toward the door within
// the first window (165 ms measured), then rule 0's escape fires — sliding
// sideways to the door makes no progress along the ask — and its route runs
// the body west and round the whole house (maintainer 2026-09-17, 299.3,199.1
// at the_game's house: "the door is literally next to the player. Why navigate
// around the house when the player obviously missed the door and want to enter
// it"). The escape asks the door-finder first: a door in reach is the intent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTerrainGrid,
  parseWorld,
  stampSceneryCollision,
  stepMovement,
  makeBlockedElev,
  makeSideBlocked,
  unstickFromSolids,
  levelAtWorld,
  walkHeading,
  worldAxisToScreenInput,
  startTrip,
  stepAutopilot,
  bodyStalled,
  slideAlong,
  CELL_WU,
  WALK_CLIMB,
  ISO_GEOMETRY_MAPS3,
  DOOR_BESIDE_CELLS,
  STICK_LEAN_DEFAULT,
  leanHeading,
  type SlideMemo,
  type AutopilotTrip,
  type TerrainGrid,
} from "@nangijala/shared";
import { sceneryBbox } from "../src/rooms/WorldRoom.js";
import { sceneryHitboxOverrides } from "../src/live.js";

/** Hold the stick for `ticks` frames of 33 ms the way predictAndSend does. */
function hold(grid: TerrainGrid, col: number, row: number, s: { ax: number; ay: number }, ticks: number) {
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  let x = col * CELL_WU;
  let y = row * CELL_WU;
  let elev = levelAtWorld(grid, x, y);
  let t = 0;
  let trip: AutopilotTrip | null = null;
  const memo: SlideMemo = { ax: 0, ay: 0 };
  const ww = grid.width * CELL_WU;
  const wh = grid.height * CELL_WU;
  const path: { col: number; row: number; ax: number; ay: number }[] = [];
  for (let i = 0; i < ticks; i++) {
    t += 33;
    const r = walkHeading(grid, x, y, s.ax, s.ay, memo, { nowMs: t, trip, fromElev: elev, worldW: ww, worldH: wh });
    trip = r.trip;
    const wax = r.deflected ? r.ax : s.ax;
    const way = r.deflected ? r.ay : s.ay;
    const u = unstickFromSolids(grid, x, y, 80 * 0.033, undefined, elev);
    x = u.x;
    y = u.y;
    const m = stepMovement(x, y, wax, way, true, 0.033, makeBlockedElev(grid, walk, () => elev), 1, true, ww, wh, makeSideBlocked(grid, walk, () => elev), { screenSlide: true });
    x = m.x;
    y = m.y;
    elev = levelAtWorld(grid, x, y);
    path.push({ col: x / CELL_WU, row: y / CELL_WU, ax: wax, ay: way });
  }
  return path;
}

/** How many times the walked heading turned back on itself along the run —
 *  a body that goes through a doorway turns a few times at most; one that
 *  alternates every window between the raw heading and a sideways nudge
 *  turns dozens (maintainer 2026-09-17: "the player start to jitter and change
 *  direction back and forth super fast"). */
function reversals(path: { ax: number; ay: number }[]): number {
  let n = 0;
  for (let i = 2; i < path.length; i++) {
    const a = path[i - 2], b = path[i - 1], c = path[i];
    const turnedBack = (a.ax !== b.ax || a.ay !== b.ay) && c.ax === a.ax && c.ay === a.ay && (b.ax !== c.ax || b.ay !== c.ay);
    if (turnedBack) n++;
  }
  return n;
}

/** His house, synthetic: a 6-storey shell with its doorway at (300,197) in
 *  the south wall, the floor inside, open ground outside — the_game's rows
 *  195-203 at cols 295-306 as measured. */
function house(): TerrainGrid {
  const W = 320;
  const H = 210;
  const rows = Array.from({ length: H }, (_, r) =>
    Array.from({ length: W }, (_, c) => {
      const westWall = c === 296 && r >= 191 && r <= 197;
      const eastWall = c === 303 && r >= 191 && r <= 197;
      const northWall = r === 191 && c >= 296 && c <= 303;
      const southWall = r === 197 && c >= 296 && c <= 303 && c !== 300;
      return { t: "grass", l: westWall || eastWall || northWall || southWall ? 6 : 0 };
    }),
  );
  return buildTerrainGrid(W, H, rows, [], []);
}

const INTO_THE_WALL = worldAxisToScreenInput(0, -1); // straight at the south wall

function assertThroughTheDoor(path: { col: number; row: number; ax: number; ay: number }[], what: string) {
  const westMost = Math.min(...path.map((p) => p.col));
  const end = path[path.length - 1];
  const inside = path.findIndex((p) => p.row < 197);
  const flips = reversals(path);
  assert.ok(flips <= 3, `${what}: the heading turned back on itself ${flips} times on the way in — the jitter at the jamb`);
  assert.ok(westMost > 298.5, `${what}: the body was routed round the house — it went west to col ${westMost.toFixed(2)} (the door is at col 300)`);
  assert.ok(inside >= 0 && inside * 33 <= 2500, `${what}: not through the door within 2.5 s (first inside at ${inside < 0 ? "never" : inside * 33 + " ms"}; rest at ${end.col.toFixed(2)},${end.row.toFixed(2)})`);
}

test("beside the door, held into the wall: through the door, never round the house", () => {
  assertThroughTheDoor(hold(house(), 299.3, 199.1, INTO_THE_WALL, 120), "synthetic house");
  // From the other side of the door too — the finder's mirror.
  assertThroughTheDoor(hold(house(), 300.7, 199.1, INTO_THE_WALL, 120), "synthetic house, east of the door");
});

/** A short free-standing wall, its opening four cells along: round the near
 *  end is the shorter walk, and the shorter walk wins — the door has no
 *  precedence (maintainer: "It should be the same priority. Closest path
 *  around the object should win"). */
function shortWall(): TerrainGrid {
  const W = 320;
  const H = 210;
  const rows = Array.from({ length: H }, (_, r) =>
    Array.from({ length: W }, (_, c) => ({ t: "grass", l: r === 197 && c >= 297 && c <= 303 && c !== 300 ? 6 : 0 })),
  );
  return buildTerrainGrid(W, H, rows, [], []);
}

test("a door four cells along a short wall loses to the wall's end one cell away: the shorter walk wins", () => {
  const path = hold(shortWall(), 296.6, 199.1, INTO_THE_WALL, 120);
  const eastMost = Math.max(...path.map((p) => p.col));
  const past = path.findIndex((p) => p.row < 197);
  assert.ok(eastMost < 299.5, `the body went for the door (east to col ${eastMost.toFixed(2)}) instead of round the wall's end`);
  assert.ok(past >= 0 && past * 33 <= 2500, `not past the wall within 2.5 s (first past at ${past < 0 ? "never" : past * 33 + " ms"})`);
});

test("the_game's house from 298.6,199.6: no heading jitter at the jamb (skipped without the world tree)", (t) => {
  // The spot the harness scan found (2026-09-17): the slide to the door ran
  // nine ticks, the next window read it as no progress, the door-finder was
  // quiet (forward open) and a ROUTE through the doorway was committed — its
  // follower alternated right / up-right every tick toward a waypoint between
  // the two. His words: "jitter and change direction back and forth super fast".
  const file = join(process.cwd(), "..", "..", "maps2", "worlds3", "the_game", "world.json");
  if (!existsSync(file)) return t.skip("no world tree in this checkout");
  const world = parseWorld(JSON.parse(readFileSync(file, "utf8")));
  const grid = buildTerrainGrid(world!.width, world!.height, world!.rows, world!.props, world!.decks);
  stampSceneryCollision(grid, world!.scenery ?? [], sceneryBbox(), sceneryHitboxOverrides(), ISO_GEOMETRY_MAPS3);
  const path = hold(grid, 298.6, 199.6, INTO_THE_WALL, 120);
  let changes = 0;
  for (let i = 1; i < path.length; i++) if (path[i].ax !== path[i - 1].ax || path[i].ay !== path[i - 1].ay) changes++;
  assert.ok(changes <= 4, `the walked heading changed ${changes} times in 4 s on the way through the door (the jitter at the jamb)`);
  assertThroughTheDoor(path, "the_game from 298.6,199.6");
});

/* THE SLIDE TAKES THE DOOR BESIDE IT (maintainer 2026-09-18, 298.9,198.4:
 * "I'm very very close to the door/entrance and still the player runs around
 * the house to the left!"). Screen-UP into the south wall is 27 degrees off
 * that wall's normal — inside his slide angle — so the push was the player's
 * and the slide carried the body west along the whole wall and round the
 * house: never stalled, so the door-finder never looked, and the door lay
 * one cell AGAINST the lean, which the finder never takes. Now a push into a
 * wall with a doorway within DOOR_BESIDE_CELLS behind the lean is a push
 * through that doorway: the deflection is sideways AND forward, committed
 * until the body's centre crosses the wall's line (releasing the moment the
 * doorway opened ahead drifted the body back onto the jamb, two headings
 * alternating every tick), then the player's own push walks on. The thumb
 * is modelled as the client does it: the 8-way snap plus the finger's lean
 * (leanHeading, STICK_LEAN_DEFAULT). */
function holdThumb(grid: TerrainGrid, col: number, row: number, deg: number, ticks: number) {
  const rad = (deg * Math.PI) / 180;
  const ax = Math.round(Math.cos(rad));
  const ay = Math.round(Math.sin(rad));
  const heading = leanHeading(ax, ay, deg, STICK_LEAN_DEFAULT, ISO_GEOMETRY_MAPS3);
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  let x = col * CELL_WU;
  let y = row * CELL_WU;
  let elev = levelAtWorld(grid, x, y);
  let t = 0;
  let trip: AutopilotTrip | null = null;
  const memo: SlideMemo = { ax: 0, ay: 0 };
  const ww = grid.width * CELL_WU;
  const wh = grid.height * CELL_WU;
  const path: { col: number; row: number; ax: number; ay: number }[] = [];
  for (let i = 0; i < ticks; i++) {
    t += 33;
    const r = walkHeading(grid, x, y, ax, ay, memo, { nowMs: t, trip, fromElev: elev, worldW: ww, worldH: wh, heading });
    trip = r.trip;
    const wax = r.deflected ? r.ax : heading.ax;
    const way = r.deflected ? r.ay : heading.ay;
    const u = unstickFromSolids(grid, x, y, 80 * 0.033, undefined, elev);
    x = u.x;
    y = u.y;
    const m = stepMovement(x, y, wax, way, true, 0.033, makeBlockedElev(grid, walk, () => elev), 1, true, ww, wh, makeSideBlocked(grid, walk, () => elev), { screenSlide: true });
    x = m.x;
    y = m.y;
    elev = levelAtWorld(grid, x, y);
    path.push({ col: x / CELL_WU, row: y / CELL_WU, ax: wax, ay: way });
  }
  return path;
}

test("screen-up into the south wall one cell west of the door: through the door, never round the house, and the push is the player's again inside", () => {
  for (const [grid, what] of [[house(), "synthetic house"]] as [TerrainGrid, string][]) {
    for (const deg of [-110, -90, -70]) {
      const path = holdThumb(grid, 298.9, 198.4, deg, 60);
      const inside = path.findIndex((p) => p.row < 197);
      // (the way TO the door; inside, screen-up walks up-left by design)
      const westMost = Math.min(...path.slice(0, inside < 0 ? path.length : inside).map((p) => p.col));
      const end = path[path.length - 1];
      const flips = reversals(path);
      let changes = 0;
      for (let i = 1; i < path.length; i++) if (path[i].ax !== path[i - 1].ax || path[i].ay !== path[i - 1].ay) changes++;
      assert.ok(westMost > 298.5, `${what} ${deg}°: routed round the house — west to col ${westMost.toFixed(2)}`);
      assert.ok(inside >= 0 && inside * 33 <= 1500, `${what} ${deg}°: not through the door within 1.5 s (${inside < 0 ? "never" : inside * 33 + " ms"})`);
      assert.ok(flips <= 3 && changes <= 4, `${what} ${deg}°: the heading dithered (${flips} reversals, ${changes} changes)`);
      // inside, the push is the player's: screen-up walks up-LEFT, not on east
      assert.ok(end.col < 300.2 && end.row < 196.5, `${what} ${deg}°: the deflection outlived the doorway — rest at ${end.col.toFixed(2)},${end.row.toFixed(2)}`);
    }
  }
  // Two cells west of the door the doorway is further than DOOR_BESIDE_CELLS behind
  // the lean: the honest slide, west along the wall.
  assert.ok(DOOR_BESIDE_CELLS < 2);
  const far = holdThumb(house(), 297.9, 198.4, -90, 60);
  assert.ok(Math.min(...far.map((p) => p.col)) < 297, "two cells from the door the slide is the player's own");
  assert.equal(far.findIndex((p) => p.row < 197 && p.col > 299.5), -1, "and it does not go through the door");
});

test("the_game's house, screen-up from 298.9,198.4: through the door, not round the house (skipped without the world tree)", (t) => {
  const file = join(process.cwd(), "..", "..", "maps2", "worlds3", "the_game", "world.json");
  if (!existsSync(file)) return t.skip("no world tree in this checkout");
  const world = parseWorld(JSON.parse(readFileSync(file, "utf8")));
  const grid = buildTerrainGrid(world!.width, world!.height, world!.rows, world!.props, world!.decks);
  stampSceneryCollision(grid, world!.scenery ?? [], sceneryBbox(), sceneryHitboxOverrides(), ISO_GEOMETRY_MAPS3);
  const path = holdThumb(grid, 298.9, 198.4, -90, 60);
  const inside = path.findIndex((p) => p.row < 197);
  const westMost = Math.min(...path.slice(0, inside < 0 ? path.length : inside).map((p) => p.col));
  assert.ok(westMost > 298.5, `routed round the house — west to col ${westMost.toFixed(2)}`);
  assert.ok(inside >= 0 && inside * 33 <= 1500, `not through the door within 1.5 s (${inside < 0 ? "never" : inside * 33 + " ms"})`);
  assert.ok(reversals(path) <= 3, `the heading dithered ${reversals(path)} times`);
});

test("the_game's house at 299.3,199.1 (skipped without the world tree)", (t) => {
  const file = join(process.cwd(), "..", "..", "maps2", "worlds3", "the_game", "world.json");
  if (!existsSync(file)) return t.skip("no world tree in this checkout");
  const world = parseWorld(JSON.parse(readFileSync(file, "utf8")));
  assert.ok(world, "parseWorld");
  const grid = buildTerrainGrid(world!.width, world!.height, world!.rows, world!.props, world!.decks);
  stampSceneryCollision(grid, world!.scenery ?? [], sceneryBbox(), sceneryHitboxOverrides(), ISO_GEOMETRY_MAPS3);
  assertThroughTheDoor(hold(grid, 299.3, 199.1, INTO_THE_WALL, 120), "the_game");
});

/** The TAP path, as the client drives it (driveAutopilot + the tap-slide
 *  floor): a trip from `from` to `to`, stepped with the real movement tick;
 *  the walked heading per tick. */
function drive(grid: TerrainGrid, from: [number, number], to: [number, number], ticks: number) {
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  let x = from[0] * CELL_WU;
  let y = from[1] * CELL_WU;
  let elev = levelAtWorld(grid, x, y);
  const ww = grid.width * CELL_WU;
  const wh = grid.height * CELL_WU;
  const trip = startTrip(grid, x, y, to[0] * CELL_WU, to[1] * CELL_WU, false, 0, elev, levelAtWorld(grid, to[0] * CELL_WU, to[1] * CELL_WU));
  assert.ok(trip, "a trip was planned");
  const tapSlide: SlideMemo = { ax: 0, ay: 0 };
  const path: { col: number; row: number; ax: number; ay: number }[] = [];
  let t = 0;
  for (let i = 0; i < ticks; i++) {
    t += 33;
    const d = stepAutopilot(grid, trip!, x, y, t, ww, wh, elev);
    if (d.done) break;
    let ax = d.ax, ay = d.ay;
    if ((ax !== 0 || ay !== 0) && bodyStalled(grid, x, y, ax, ay, elev)) {
      const sl = slideAlong(grid, x, y, ax, ay, tapSlide, elev);
      if (sl) { ax = sl.ax; ay = sl.ay; }
    } else { tapSlide.ax = 0; tapSlide.ay = 0; }
    const u = unstickFromSolids(grid, x, y, 80 * 0.033, undefined, elev);
    x = u.x; y = u.y;
    const m = stepMovement(x, y, ax, ay, false, 0.033, makeBlockedElev(grid, walk, () => elev), 1, true, ww, wh, makeSideBlocked(grid, walk, () => elev), { screenSlide: true });
    x = m.x; y = m.y;
    elev = levelAtWorld(grid, x, y);
    path.push({ col: x / CELL_WU, row: y / CELL_WU, ax, ay });
  }
  return path;
}

test("the_game's hearth house at 333,234 by TAP from the street: through the door, no jitter (skipped without the world tree)", (t) => {
  // Maintainer 2026-09-17 (333.0,235.1, build 5c682beb5): "the player starts
  // to jitter and change direction back and forth super fast when the player
  // navigates onto a house (the player starts to jitter at the door entrance)".
  const file = join(process.cwd(), "..", "..", "maps2", "worlds3", "the_game", "world.json");
  if (!existsSync(file)) return t.skip("no world tree in this checkout");
  const world = parseWorld(JSON.parse(readFileSync(file, "utf8")));
  const grid = buildTerrainGrid(world!.width, world!.height, world!.rows, world!.props, world!.decks);
  stampSceneryCollision(grid, world!.scenery ?? [], sceneryBbox(), sceneryHitboxOverrides(), ISO_GEOMETRY_MAPS3);
  for (const from of [[333.0, 236.6], [332.2, 236.2], [334.0, 236.4]] as [number, number][]) {
    const path = drive(grid, from, [333.0, 232.6], 240);
    let changes = 0;
    for (let i = 1; i < path.length; i++) if (path[i].ax !== path[i - 1].ax || path[i].ay !== path[i - 1].ay) changes++;
    const inside = path.findIndex((p) => p.row < 234);
    const flips = reversals(path);
    console.log(`tap from ${from}: ${path.length} ticks, ${changes} heading changes, ${flips} reversals, inside at ${inside < 0 ? "never" : inside * 33 + " ms"}; rest ${path[path.length - 1].col.toFixed(2)},${path[path.length - 1].row.toFixed(2)}`);
    assert.ok(inside >= 0 && inside * 33 <= 4000, `from ${from}: not through the door within 4 s`);
    assert.ok(flips <= 3, `from ${from}: the heading turned back on itself ${flips} times — the jitter at the door`);
    assert.ok(changes <= 8, `from ${from}: the walked heading changed ${changes} times on the way in`);
  }
});
