// ONE TAP, TWO MEANINGS — RESOLVED BY ROUTING BOTH (maintainer 2026-08-08:
// "the user always walks as close as he/she can get to the marker... we resolve
// it by path distance so we always try both and see which one is shorter").
//
// A cell with a slab over it shows the deck and the ground beneath it at the
// SAME screen pixel. Picking by what is DRAWN on top gets it wrong whenever the
// top is out of reach: tapping the house from the road resolves to the roof,
// six levels up with no ramp, so the walk fell back to the floor and stopped a
// storey below the marker. Two rules, in order:
//   1. Arriving beats giving up short — "the house I'm clicking on doesn't even
//      have a valid route to get on top of it, so it must have meant the
//      underside".
//   2. Among candidates that arrive, the shorter WALK wins.
//
// The real-world fixture is the_game's SPAWN HOUSE, derived from the world doc:
// the roof deck nearest the declared spawn, its interior cell nearest the
// deck's centroid, and the spawn itself as where the finger's owner stands. A
// reshaped town moves the numbers, not the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorld, buildTerrainGrid, startTrip, startBestTrip, tripLength, isoOf, CELL_WU } from "@nangijala/shared";

const here = dirname(fileURLToPath(import.meta.url));
const WORLD_PATH = join(here, "..", "..", "..", "maps2", "worlds3", "the_game", "world.json");
// The deploy's test job sparse-checks-out no world tree: every test skips
// (never throws) when the_game is absent, so `world` is null there.
const world = existsSync(WORLD_PATH) ? parseWorld(JSON.parse(readFileSync(WORLD_PATH, "utf8"))) : null;
const SKIP = "maps2/worlds3/the_game missing";
const grid = world ? buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks) : null!;
const at = (c: number, r: number) => r * grid.width + c;
const wu = (n: number) => n * CELL_WU;
const iso = world ? isoOf(world) : isoOf(null);

/** The spawn house: the roof deck whose footprint lies nearest the declared
 *  spawn, and the interior cell (level-0 floor UNDER the slab) nearest its
 *  centroid — the cell a finger lands on when tapping the middle of the roof. */
function spawnHouse() {
  const spawn = world!.spawn!;
  const house = world!.decks!
    .filter((d) => d.kind === "roof" && d.cells.some((c) => grid.deck[at(c.col, c.row)] === d.level && grid.level[at(c.col, c.row)] === 0))
    .map((d) => ({ d, dist: Math.min(...d.cells.map((c) => Math.hypot(c.col - spawn[0], c.row - spawn[1]))) }))
    .sort((a, b) => a.dist - b.dist)[0]?.d;
  assert.ok(house, "the_game ships no roof deck over a level-0 floor near its spawn");
  const interior = house.cells.filter((c) => grid.deck[at(c.col, c.row)] === house.level && grid.level[at(c.col, c.row)] === 0);
  const cen = interior.reduce((a, c) => ({ col: a.col + c.col / interior.length, row: a.row + c.row / interior.length }), { col: 0, row: 0 });
  const roofCell = [...interior].sort((a, b) => Math.hypot(a.col - cen.col, a.row - cen.row) - Math.hypot(b.col - cen.col, b.row - cen.row))[0];
  const ROOF = { c: roofCell.col + 0.5, r: roofCell.row + 0.5, lvl: house.level };
  const FROM: [number, number] = [spawn[0] + 0.5, spawn[1] + 0.5];
  return { house, roofCell, ROOF, FROM };
}
const fx = world ? spawnHouse() : null;
const { house, roofCell, ROOF, FROM } = fx ?? ({} as ReturnType<typeof spawnHouse>);

test("the route reports the LEVEL it really ended on, not the one that was asked for", (t) => {
  if (!world) return t.skip(SKIP);
  const i = at(roofCell.col, roofCell.row);
  assert.equal(grid.level[i], 0, "the house floor is not at level 0");
  assert.equal(grid.deck[i], house.level, "the floor cell no longer carries the house's roof slab");

  // Asking for the roof from the spawn: the search falls back to its best-effort
  // rim, which is the floor of that same cell (through the door). Without
  // endLevel the caller cannot tell that apart from success, and that is the
  // whole bug.
  const roof = startTrip(grid, wu(FROM[0]), wu(FROM[1]), wu(ROOF.c), wu(ROOF.r), false, 0, 0, house.level);
  assert.ok(roof, "no route toward the house at all");
  assert.equal(roof!.goalLevel, house.level, "the tapped level must be carried as-is — a stall replan re-aims for it");
  assert.equal(roof!.endLevel, 0, "the trip claims to have reached a roof it never got onto");
});

test("the two readings of one click are the SAME PIXEL, and the reachable one wins", (t) => {
  if (!world) return t.skip(SKIP);
  // THE PROJECTION: screen y = (col+row)*dy - level*lh. So the ground drawn at
  // a level-L slab's pixel is L*lh/dy cells up-screen — a DIFFERENT CELL that
  // lands on the SAME PIXEL. That is what makes "walk on top of it or under it"
  // one click with two meanings, and it is why choosing between them never
  // moves the beacon (maintainer 2026-08-08: "now you move the marker to a spot
  // I didn't click on"). The projection is the world's own (tiles3: dy 14, lh
  // 15), read through isoOf so the fixture follows the renderer.
  const shift = (ROOF.lvl * iso.lh) / iso.dy; // cells of (col+row) for L levels
  const under = { c: ROOF.c - shift / 2, r: ROOF.r - shift / 2, lvl: 0 };
  const screenY = (p: { c: number; r: number; lvl: number }) => (p.c + p.r) * iso.dy - p.lvl * iso.lh;
  assert.ok(Math.abs(screenY(ROOF) - screenY(under)) < 0.01,
    "the fixture's two readings do not sit on the same pixel — nothing here is ambiguous");
  const ui = at(Math.floor(under.c), Math.floor(under.r));
  assert.equal(grid.level[ui], 0, "the ground reading is not level-0 ground — the town moved");
  assert.equal(grid.deck[ui], -1, "the ground reading sits under another slab — the fixture is not two-valued");

  const trip = startBestTrip(grid, wu(FROM[0]), wu(FROM[1]), false, 0, 0, [
    { x: wu(ROOF.c), y: wu(ROOF.r), goalLevel: ROOF.lvl },     // what is DRAWN there
    { x: wu(under.c), y: wu(under.r), goalLevel: under.lvl },  // what is under it
  ]);
  assert.ok(trip, "no route at all");
  // Rule 1: the roof has no ramp from the ground, so it was never what was meant.
  assert.equal(trip!.goalLevel, under.lvl,
    "the walk still targets the unreachable roof, so it stops a storey under the marker");
  assert.equal(trip!.endLevel, under.lvl, "the chosen reading is one the walker cannot reach either");
  // ...and it ends on the GROUND READING's column, not the roof cell's.
  assert.ok(Math.hypot(trip!.target.x - wu(under.c), trip!.target.y - wu(under.r)) < CELL_WU * 1.5,
    `the walk ended at ${(trip!.target.x / 32).toFixed(1)},${(trip!.target.y / 32).toFixed(1)}, ` +
      `not at the ground under the finger (${under.c.toFixed(1)},${under.r.toFixed(1)})`);
});

test("a roof you CAN reach still wins when it is the shorter walk", (t) => {
  if (!world) return t.skip(SKIP);
  // From the house's own WALL TOP — level-6 terrain the slab laps at its own
  // level, so the deck is dropped there and the wall cell is plain ground a
  // roof-walker stands on — the roof is a step away and the floor route does
  // not exist (the only way down is a damaging drop, which findPath refuses:
  // the no-fall law). RULE 1 decides: the roof — the reading you can actually
  // reach — wins. Rule 2 (shorter walk among candidates that BOTH arrive)
  // lives in the synthetic fixture below, where both readings are safely
  // reachable by construction.
  const wall = house.cells.find((c) => grid.deck[at(c.col, c.row)] === -1 && grid.level[at(c.col, c.row)] === house.level);
  assert.ok(wall, "the house has no wall cell at the roof's own level to stand on");
  const from: [number, number] = [wall!.col + 0.5, wall!.row + 0.5];

  const up = startTrip(grid, wu(from[0]), wu(from[1]), wu(ROOF.c), wu(ROOF.r), false, 0, house.level, house.level);
  const down = startTrip(grid, wu(from[0]), wu(from[1]), wu(ROOF.c), wu(ROOF.r), false, 0, house.level, 0);
  assert.ok(up && down, "one of the two readings has no route at all");
  assert.equal(up!.endLevel, house.level, "the roof is not actually reachable from its own wall top — fixture is wrong");
  assert.notEqual(down!.endLevel, 0,
    "the floor arrived from the wall top — only a damaging fall could do that, the no-fall law is off");

  // Offer the GROUND first, so only "arriving beats giving up" can pick the roof.
  const trip = startBestTrip(grid, wu(from[0]), wu(from[1]), false, 0, house.level,
    [{ x: wu(ROOF.c), y: wu(ROOF.r), goalLevel: 0 }, { x: wu(ROOF.c), y: wu(ROOF.r), goalLevel: house.level }]);
  assert.equal(trip!.goalLevel, house.level, "the reading that ARRIVES (the roof) lost to one that gives up short");
});

test("rule 2: among two readings that BOTH arrive, the shorter walk wins", () => {
  // Synthetic, because a shipped house is one-sided: its roof and floor are
  // reachable from DISJOINT regions (the descent from the wall top is a
  // damaging hop). Here a level-4 slab has a stairs ramp, so both readings
  // arrive safely: from the ramp top the roof is a couple of steps, the floor
  // beneath means walking back down and around — only the trip LENGTH can
  // decide, which is exactly rule 2.
  const rows: { t: string; l?: number }[][] = [];
  for (let r = 0; r < 20; r++) {
    rows.push([]);
    for (let c = 0; c < 20; c++) rows[r].push({ t: "grass", l: 0 });
  }
  for (let i = 0; i < 4; i++) rows[8][12 + i] = { t: "stairs", l: 3 - i }; // ramp: 12,8=3 … 15,8=0
  const deck = {
    kind: "roof",
    mat: "grass",
    level: 4,
    thickness: 1,
    cells: [] as { col: number; row: number; flip: boolean }[],
  };
  for (let r = 7; r <= 10; r++)
    for (let c = 8; c <= 11; c++) deck.cells.push({ col: c, row: r, flip: false });
  const g2 = buildTerrainGrid(20, 20, rows, [], [deck]);
  const from: [number, number] = [12.5, 8.5]; // standing on the ramp top (level 3)
  const up2 = startTrip(g2, wu(from[0]), wu(from[1]), wu(10.5), wu(8.5), false, 0, 3, 4);
  const down2 = startTrip(g2, wu(from[0]), wu(from[1]), wu(10.5), wu(8.5), false, 0, 3, 0);
  assert.ok(up2 && down2, "one of the two readings has no route at all");
  assert.equal(up2!.endLevel, 4, "the ramp does not reach the slab — fixture is wrong");
  assert.equal(down2!.endLevel, 0, "the floor under the slab is not reachable — fixture is wrong");
  const upLen2 = tripLength(wu(from[0]), wu(from[1]), up2!.path);
  const downLen2 = tripLength(wu(from[0]), wu(from[1]), down2!.path);
  assert.ok(upLen2 < downLen2,
    `the fixture does not discriminate: roof ${upLen2.toFixed(0)}wu vs floor ${downLen2.toFixed(0)}wu`);
  // Offer the GROUND first, so only distance can pick the roof.
  const trip2 = startBestTrip(g2, wu(from[0]), wu(from[1]), false, 0, 3,
    [{ x: wu(10.5), y: wu(8.5), goalLevel: 0 }, { x: wu(10.5), y: wu(8.5), goalLevel: 4 }]);
  assert.equal(trip2!.goalLevel, 4,
    `the shorter walk (roof, ${upLen2.toFixed(0)}wu) lost to the longer one (floor, ${downLen2.toFixed(0)}wu)`);
});

test("the drawn surface keeps ties, and a single candidate is unchanged", (t) => {
  if (!world) return t.skip(SKIP);
  // Only a STRICT improvement displaces the incumbent, so offering the same
  // level twice cannot flip the answer.
  const a = startBestTrip(grid, wu(FROM[0]), wu(FROM[1]), false, 0, 0,
    [{ x: wu(ROOF.c), y: wu(ROOF.r), goalLevel: 0 }, { x: wu(ROOF.c), y: wu(ROOF.r), goalLevel: 0 }]);
  assert.equal(a!.goalLevel, 0, "a tie changed the answer");
  // And with nothing to compare against, this is exactly startTrip.
  const solo = startBestTrip(grid, wu(FROM[0]), wu(FROM[1]), false, 0, 0, [{ x: wu(ROOF.c), y: wu(ROOF.r), goalLevel: house.level }]);
  const plain = startTrip(grid, wu(FROM[0]), wu(FROM[1]), wu(ROOF.c), wu(ROOF.r), false, 0, 0, house.level);
  assert.equal(solo!.goalLevel, plain!.goalLevel, "a single candidate no longer behaves like startTrip");
  assert.equal(solo!.path.length, plain!.path.length, "a single candidate re-planned differently");
});

test("every waypoint carries the level of the surface it stands on", (t) => {
  if (!world) return t.skip(SKIP);
  // Round the house from the spawn to the ground reading — a multi-waypoint
  // walk on the town's level-0 ground.
  const shift = (ROOF.lvl * iso.lh) / iso.dy;
  const trip = startTrip(grid, wu(FROM[0]), wu(FROM[1]), wu(ROOF.c - shift / 2), wu(ROOF.r - shift / 2), false, 0, 0, 0);
  assert.ok(trip && trip.path.length > 2, "no multi-waypoint route to check");
  const missing = trip!.path.filter((p) => (p as { lvl?: number }).lvl === undefined);
  assert.equal(missing.length, 0, `${missing.length} of ${trip!.path.length} waypoints carry no level`);
});

// NOTE — no test here for the "neither candidate arrives" tie-break (nearest
// miss beats shortest path, since a route that gives up after three steps has
// the shortest path of all). The rule is in startBestTrip and is plainly more
// defensible than what it replaced, but every fixture tried on the shipped
// world had both candidates missing by the same 40wu, so nothing here PROVES
// it. Do not read its absence as coverage.
