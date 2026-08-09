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
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorld, buildTerrainGrid, startTrip, startBestTrip, tripLength, CELL_WU } from "@nangijala/shared";

const here = dirname(fileURLToPath(import.meta.url));
const world = parseWorld(
  JSON.parse(readFileSync(join(here, "..", "..", "..", "maps2", "worlds", "the_island2", "world.json"), "utf8")),
)!;
const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
const at = (c: number, r: number) => r * grid.width + c;
const wu = (n: number) => n * CELL_WU;

test("the route reports the LEVEL it really ended on, not the one that was asked for", () => {
  const i = at(178, 117);
  assert.equal(grid.level[i], 0, "the world moved — 178,117 is no longer the house floor");
  assert.equal(grid.deck[i], 6, "178,117 no longer carries the house's roof slab");

  // Asking for the roof from the road: the search falls back to its best-effort
  // rim, which is the floor of that same cell. Without endLevel the caller
  // cannot tell that apart from success, and that is the whole bug.
  const roof = startTrip(grid, wu(184.5), wu(122.5), wu(178.5), wu(117.5), false, 0, 0, 6);
  assert.ok(roof, "no route toward the house at all");
  assert.equal(roof!.goalLevel, 6, "the tapped level must be carried as-is — a stall replan re-aims for it");
  assert.equal(roof!.endLevel, 0, "the trip claims to have reached a roof it never got onto");
});

test("the two readings of one click are the SAME PIXEL, and the reachable one wins", () => {
  // THE PROJECTION: screen y = (col+row)*ISO_DY - level*LEVEL_PX. So the ground
  // drawn at a level-6 slab's pixel is 6*16/15 = 6.4 cells up-screen — a
  // DIFFERENT CELL that lands on the SAME PIXEL. That is what makes "walk on
  // top of it or under it" one click with two meanings, and it is why choosing
  // between them never moves the beacon (maintainer 2026-08-08: "now you move
  // the marker to a spot I didn't click on").
  const roof = { c: 178.5, r: 117.5, lvl: 6 };
  const shift = (roof.lvl * 16) / 15;              // cells of (col+row) per 6 levels
  const under = { c: roof.c - shift / 2, r: roof.r - shift / 2, lvl: 0 };
  const screenY = (p: { c: number; r: number; lvl: number }) => (p.c + p.r) * 15 - p.lvl * 16;
  assert.ok(Math.abs(screenY(roof) - screenY(under)) < 0.01,
    "the fixture's two readings do not sit on the same pixel — nothing here is ambiguous");

  const trip = startBestTrip(grid, wu(184.5), wu(122.5), false, 0, 0, [
    { x: wu(roof.c), y: wu(roof.r), goalLevel: roof.lvl },     // what is DRAWN there
    { x: wu(under.c), y: wu(under.r), goalLevel: under.lvl },  // what is under it
  ]);
  assert.ok(trip, "no route at all");
  // Rule 1: the roof has no ramp from the road, so it was never what was meant.
  assert.equal(trip!.goalLevel, under.lvl,
    "the walk still targets the unreachable roof, so it stops a storey under the marker");
  assert.equal(trip!.endLevel, under.lvl, "the chosen reading is one the walker cannot reach either");
  // ...and it ends on the GROUND READING's column, not the roof cell's.
  assert.ok(Math.hypot(trip!.target.x - wu(under.c), trip!.target.y - wu(under.r)) < CELL_WU * 1.5,
    `the walk ended at ${(trip!.target.x / 32).toFixed(1)},${(trip!.target.y / 32).toFixed(1)}, ` +
      `not at the ground under the finger (${under.c.toFixed(1)},${under.r.toFixed(1)})`);
});

test("a roof you CAN reach still wins when it is the shorter walk", () => {
  // From the mountain shoulder at level 6 the roof is a few steps away, while
  // the floor beneath it means walking back down and round to the door. This is
  // the case rule 1 alone cannot decide — both candidates arrive.
  const from: [number, number] = [173.5, 113.5];
  assert.equal(grid.level[at(173, 113)], 6, "the mountain shoulder moved");

  const up = startTrip(grid, wu(from[0]), wu(from[1]), wu(177.5), wu(117.5), false, 0, 6, 6);
  const down = startTrip(grid, wu(from[0]), wu(from[1]), wu(177.5), wu(117.5), false, 0, 6, 0);
  assert.ok(up && down, "one of the two readings has no route at all");
  assert.equal(up!.endLevel, 6, "the roof is not actually reachable from the shoulder — fixture is wrong");
  const upLen = tripLength(wu(from[0]), wu(from[1]), up!.path);
  const downLen = tripLength(wu(from[0]), wu(from[1]), down!.path);
  assert.ok(upLen < downLen,
    `the fixture does not discriminate: roof ${upLen.toFixed(0)}wu vs floor ${downLen.toFixed(0)}wu`);

  // Offer the GROUND first, so only distance can pick the roof.
  const trip = startBestTrip(grid, wu(from[0]), wu(from[1]), false, 0, 6,
    [{ x: wu(177.5), y: wu(117.5), goalLevel: 0 }, { x: wu(177.5), y: wu(117.5), goalLevel: 6 }]);
  assert.equal(trip!.goalLevel, 6,
    `the shorter walk (roof, ${upLen.toFixed(0)}wu) lost to the longer one (floor, ${downLen.toFixed(0)}wu)`);
});

test("the drawn surface keeps ties, and a single candidate is unchanged", () => {
  // Only a STRICT improvement displaces the incumbent, so offering the same
  // level twice cannot flip the answer.
  const a = startBestTrip(grid, wu(184.5), wu(122.5), false, 0, 0,
    [{ x: wu(178.5), y: wu(117.5), goalLevel: 0 }, { x: wu(178.5), y: wu(117.5), goalLevel: 0 }]);
  assert.equal(a!.goalLevel, 0, "a tie changed the answer");
  // And with nothing to compare against, this is exactly startTrip.
  const solo = startBestTrip(grid, wu(184.5), wu(122.5), false, 0, 0, [{ x: wu(178.5), y: wu(117.5), goalLevel: 6 }]);
  const plain = startTrip(grid, wu(184.5), wu(122.5), wu(178.5), wu(117.5), false, 0, 0, 6);
  assert.equal(solo!.goalLevel, plain!.goalLevel, "a single candidate no longer behaves like startTrip");
  assert.equal(solo!.path.length, plain!.path.length, "a single candidate re-planned differently");
});

test("every waypoint carries the level of the surface it stands on", () => {
  const trip = startTrip(grid, wu(138), wu(108), wu(143.5), wu(108.5), false, 0, 4, 4);
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
