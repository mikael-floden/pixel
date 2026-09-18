// THE PLAYER'S PUSH IS THE PLAYER'S UNTIL CORNERED (docs/movement.md).
// Maintainer 2026-09-18, running bottom-right into the hearth house's east
// wall at 334.6,232.3: "the nav system kicks in and runs the character out
// the door! This feels too extreme... let the player's input control the
// character until the very end/corner". A stick within the nav slide angle of
// a terrain wall's NORMAL plans nothing while the slide along the wall still
// moves; at the dial's 0 every stall is the nav's, as before.
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
  wallContact,
  wallAngleDeg,
  CELL_WU,
  WALK_CLIMB,
  ISO_GEOMETRY_MAPS3,
  NAV_SLIDE_DEG_DEFAULT,
  type SlideMemo,
  type AutopilotTrip,
  type TerrainGrid,
} from "@nangijala/shared";
import { sceneryBbox } from "../src/rooms/WorldRoom.js";
import { sceneryHitboxOverrides } from "../src/live.js";

/** Hold the stick for `ticks` frames of 33 ms the way predictAndSend does. */
function hold(grid: TerrainGrid, col: number, row: number, s: { ax: number; ay: number }, heading: { ax: number; ay: number }, ticks: number, navSlideDeg: number) {
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  let x = col * CELL_WU;
  let y = row * CELL_WU;
  let elev = levelAtWorld(grid, x, y);
  let t = 0;
  let trip: AutopilotTrip | null = null;
  const memo: SlideMemo = { ax: 0, ay: 0 };
  const ww = grid.width * CELL_WU;
  const wh = grid.height * CELL_WU;
  const path: { col: number; row: number; ax: number; ay: number; planned: boolean }[] = [];
  let planned = 0;
  for (let i = 0; i < ticks; i++) {
    t += 33;
    const r = walkHeading(grid, x, y, s.ax, s.ay, memo, { nowMs: t, trip, fromElev: elev, worldW: ww, worldH: wh, navSlideDeg, heading });
    if (r.trip && !trip) planned++;
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
    path.push({ col: x / CELL_WU, row: y / CELL_WU, ax: wax, ay: way, planned: !!r.trip });
  }
  return { path, planned };
}

test("the_game's hearth house at 334.6,232.3: a push into the east wall stays in the room; at 0° the nav walks out (skipped without the world tree)", (t) => {
  const file = join(process.cwd(), "..", "..", "maps2", "worlds3", "the_game", "world.json");
  if (!existsSync(file)) return t.skip("no world tree in this checkout");
  const world = parseWorld(JSON.parse(readFileSync(file, "utf8")));
  const grid = buildTerrainGrid(world!.width, world!.height, world!.rows, world!.props, world!.decks);
  stampSceneryCollision(grid, world!.scenery ?? [], sceneryBbox(), sceneryHitboxOverrides(), ISO_GEOMETRY_MAPS3);
  const inRoom = (p: { col: number; row: number }) => p.col >= 330 && p.col < 336 && p.row >= 230 && p.row < 235;
  // His push: bottom-right on screen, at the east wall (col 335), the thumb a
  // hair below the diagonal — a stick always leans; the 8-way key is (1,1).
  const stick = { ax: 1, ay: 1 };
  const heading = { ax: 1, ay: 1.2 };
  const w = wallContact(grid, 334.6 * CELL_WU, 232.3 * CELL_WU, heading.ax, heading.ay, levelAtWorld(grid, 334.6 * CELL_WU, 232.3 * CELL_WU));
  assert.ok(w && !w.prop && w.tangent, `the push meets a terrain wall with a tangent: ${JSON.stringify(w)}`);
  const lineDeg = wallAngleDeg(heading.ax, heading.ay, w!.tangent!.x, w!.tangent!.y);
  const offNormal = 90 - Math.min(lineDeg, 180 - lineDeg);
  console.log(`push (1,1) at the east wall: ${offNormal.toFixed(0)}° off the normal (dial ${NAV_SLIDE_DEG_DEFAULT})`);
  assert.ok(offNormal <= NAV_SLIDE_DEG_DEFAULT, "his push is within the dial of the normal");
  const held = hold(grid, 334.6, 232.3, stick, heading, 90, NAV_SLIDE_DEG_DEFAULT);
  const last = held.path[held.path.length - 1];
  console.log(`dial ${NAV_SLIDE_DEG_DEFAULT}: ends at ${last.col.toFixed(2)},${last.row.toFixed(2)} after 3 s, routes planned ${held.planned}`);
  assert.equal(held.planned, 0, "no route is planned while the push is within the dial and the slide is not cornered");
  assert.ok(held.path.every(inRoom), "the body stays in the room");
  // The dial at 0: yesterday's behaviour — the nav takes the stall and walks the body out of the room.
  const zero = hold(grid, 334.6, 232.3, stick, heading, 240, 0);
  const lastZ = zero.path[zero.path.length - 1];
  console.log(`dial 0: ends at ${lastZ.col.toFixed(2)},${lastZ.row.toFixed(2)} after 8 s, routes planned ${zero.planned}`);
  assert.ok(zero.planned >= 1 && !inRoom(lastZ), "at 0 the nav plans and walks the body out of the room — his complaint");
});
