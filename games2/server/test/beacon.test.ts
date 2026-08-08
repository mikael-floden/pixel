// THE DESTINATION BEACON MARKS WHERE YOU WILL ACTUALLY ARRIVE (maintainer
// 2026-08-08: "I stand outside the house and click to walk to a location
// inside the house. The player walks into the house, but not to the
// target-nav-symbol. The player walks to a spot that is under the
// target-nav-symbol").
//
// A tap resolves against WHAT IS DRAWN. From outside, the house's roof slab is
// drawn, so a tap on the house resolves to the roof — level 6 — and that is the
// `goalLevel` the trip carries. But there are no stairs, so the route falls
// back to its best-effort rim: the floor of that very same cell. The walk was
// therefore always correct; the BEACON was lifted to `goalLevel * lh` and hung
// 96px — about a character — over the player's head.
//
// The cell cannot answer this on its own (it has both a base and a deck), so
// findPath now reports the LAYER its route actually ended on, and the trip
// carries it as `endLevel` beside the unchanged `goalLevel` wish.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorld, buildTerrainGrid, startTrip, CELL_WU } from "@nangijala/shared";

const here = dirname(fileURLToPath(import.meta.url));
const world = parseWorld(
  JSON.parse(readFileSync(join(here, "..", "..", "..", "maps2", "worlds", "the_island2", "world.json"), "utf8")),
)!;
const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
const at = (c: number, r: number) => r * grid.width + c;

test("a tap on a roof you cannot climb beacons on the floor you actually reach", () => {
  const i = at(178, 117);
  assert.equal(grid.level[i], 0, "the world moved — 178,117 is no longer the house floor");
  assert.equal(grid.deck[i], 6, "178,117 no longer carries the house's roof slab");

  // The maintainer's own trip: standing outside, tapping the house.
  const trip = startTrip(
    grid, 181.3 * CELL_WU, 120.4 * CELL_WU, 178.5 * CELL_WU, 117.5 * CELL_WU,
    false, 0, 0, /* goalLevel: the roof, because that is what is drawn */ 6,
  );
  assert.ok(trip, "no route into the house at all");
  // The WALK was never wrong — it ends at the tapped spot, on the floor.
  assert.ok(Math.hypot(trip!.target.x - 178.5 * CELL_WU, trip!.target.y - 117.5 * CELL_WU) < CELL_WU,
    "the route no longer ends under the tapped point");
  assert.equal(trip!.goalLevel, 6, "the tapped level must be carried as-is — a stall replan re-aims for it");
  assert.equal(trip!.endLevel, 0,
    "the trip claims to end on the roof it cannot reach — the beacon floats 96px over the player");
});

test("a tap on a deck you CAN reach still beacons on the deck", () => {
  // The bridge at 143,108 (deck level 4) — reachable from either bank. This is
  // the case the lift exists for, and hiding it would be the opposite bug: "a
  // target on top of a cliff stays visible".
  assert.equal(grid.deck[at(143, 108)], 4, "the world moved — 143,108 is no longer the bridge deck");
  for (const [c, r] of [[138, 108], [143, 112]] as Array<[number, number]>) {
    const trip = startTrip(
      grid, c * CELL_WU, r * CELL_WU, 143.5 * CELL_WU, 108.5 * CELL_WU,
      false, 0, grid.level[at(c, r)], 4,
    );
    assert.ok(trip, `no route onto the bridge from ${c},${r}`);
    assert.equal(trip!.endLevel, 4,
      `the route from ${c},${r} climbs onto the bridge but the beacon would drop to the water below it`);
  }
});

test("every waypoint carries the level of the surface it stands on", () => {
  // Not just the last one: the field is what makes the end honest, so it must
  // be filled from the search's own layer rather than guessed afterwards.
  const trip = startTrip(
    grid, 138 * CELL_WU, 108 * CELL_WU, 143.5 * CELL_WU, 108.5 * CELL_WU, false, 0, 4, 4,
  );
  assert.ok(trip && trip.path.length > 2, "no multi-waypoint route to check");
  const missing = trip!.path.filter((p) => (p as { lvl?: number }).lvl === undefined);
  assert.equal(missing.length, 0, `${missing.length} of ${trip!.path.length} waypoints carry no level`);
});
