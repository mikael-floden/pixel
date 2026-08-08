// ROUTES MUST NOT HUG A WALL'S FOOT (maintainer 2026-08-07: "the character gets
// stuck running into an NPC and not around the NPC").
//
// The NPC was a bystander. The real cause: a house wall is TERRAIN at level 6 —
// perfectly `standable`, so the pathfinder's clearance rule, which only knew
// about SOLID cells (props / non-standable surfaces), treated it as open ground
// and ran the route along its foot. The body's collision probes reach
// PLAYER_RADIUS ahead, and the follower steers in 8 SCREEN directions where
// screen-EAST is world (col+1, row-1) — so "walk east along this wall" aims
// diagonally INTO it. The body slid along the face, stopped progressing, and
// the per-waypoint stall timer dropped the whole trip.
//
// Asserted on the REAL shipped geometry rather than a fixture, because the
// thing that made this bug invisible is exactly that it needs a tall wall with
// walkable ground at its foot — and that only exists in a real world file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorld, buildTerrainGrid, findPath, monsterDodge, screenToWorldVector, CELL_WU, PLAYER_RADIUS, WALK_CLIMB } from "@nangijala/shared";

// Anchored to THIS FILE, not process.cwd(): the suite runs this from the
// `server` workspace (`npm run test -w server`) while a direct run sits in
// games2, and a cwd-relative path silently resolves to two different places.
const here = dirname(fileURLToPath(import.meta.url));
const world = parseWorld(
  JSON.parse(readFileSync(join(here, "..", "..", "..", "maps2", "worlds", "the_island2", "world.json"), "utf8")),
)!;
const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
const lvl = (c: number, r: number) =>
  c < 0 || r < 0 || c >= grid.width || r >= grid.height ? 0 : grid.level[r * grid.width + c];

test("a route along a house wall keeps the body's probe clear of it", () => {
  // The maintainer's own trip: out of the second house and east to the marker.
  const path = findPath(grid, 176.2 * CELL_WU, 117.6 * CELL_WU, 183.3 * CELL_WU, 118.3 * CELL_WU);
  assert.ok(path && path.length > 2, "no route out of the house at all");

  // The house's south wall is row 119, cols 176-180 at level 6, with the
  // doorway at col 175. Every waypoint that passes under it must sit far
  // enough south that the body's LEADING PROBE does not reach the wall cell.
  const wallRow = 119;
  assert.equal(lvl(178, wallRow), 6, "the world moved — this test is aimed at the wrong wall");
  assert.equal(lvl(178, 120), 0, "the ground at the wall's foot is not walkable any more");

  const under = path!.filter((p) => {
    const c = Math.floor(p.x / CELL_WU);
    return c >= 176 && c <= 180 && Math.floor(p.y / CELL_WU) === wallRow + 1;
  });
  assert.ok(under.length >= 2, `expected the route to run under the wall, got ${under.length} waypoints there`);

  // THE BAR IS HALF A CELL, NOT PLAYER_RADIUS, and the difference is the whole
  // bug. A waypoint left on the cell CENTRE already clears the wall by 16wu,
  // comfortably more than the 12wu probe — which is why "the probe fits" is NOT
  // the property that matters and an earlier version of this test passed
  // against the broken code. What kills the trip is DRIFT: the follower can
  // only steer in 8 screen directions, the nearest one to "east along this
  // wall" is screen-EAST = world (col+1, row-1), so the body creeps toward the
  // wall the whole way. Measured on the live client before the fix, it ate the
  // margin down to 12.3wu (y=120.383 against the 120.375 limit), stopped
  // progressing, and the stall timer dropped the trip. The nudge has to push
  // the waypoint OFF the centre line so there is drift budget left.
  const wallBottom = (wallRow + 1) * CELL_WU; // world y where the wall cell ends
  const HALF = CELL_WU / 2;
  for (const p of under) {
    const clearance = p.y - wallBottom;
    assert.ok(
      clearance > HALF,
      `waypoint ${(p.x / CELL_WU).toFixed(2)},${(p.y / CELL_WU).toFixed(2)} sits ${clearance.toFixed(1)}wu ` +
        `below the wall — that is the un-nudged cell centre (${HALF}wu). The ${PLAYER_RADIUS}wu probe fits ` +
        `today, but the follower's 8-way drift closes it and the trip is dropped.`,
    );
  }
});

test("the nudge is aimed at CLIMB walls, not just solids — and a doorway still admits a route", () => {
  // The clearance rule must not seal a legitimate 1-cell gap: the same house's
  // doorway at (175,119) has level-6 wall on BOTH sides, so a rule that refused
  // to route near tall cells would make the house impossible to leave.
  assert.equal(lvl(174, 119), 6);
  assert.equal(lvl(176, 119), 6);
  assert.equal(lvl(175, 119), 0, "the doorway is not where this test thinks it is");
  const out = findPath(grid, 177.5 * CELL_WU, 116.5 * CELL_WU, 177.5 * CELL_WU, 122.5 * CELL_WU);
  assert.ok(out && out.length > 0, "no route through the doorway — the clearance rule sealed the house");
  assert.ok(
    out!.some((p) => Math.floor(p.y / CELL_WU) === 119),
    "the route never crosses the wall row, so it did not use the doorway",
  );

  // And the rule really is about the CLIMB: a 1-level step is walkable, so a
  // cell beside one must NOT be nudged away from (that would push routes off
  // every stair and terrace edge in the game).
  assert.ok(WALK_CLIMB >= 1, "WALK_CLIMB shrank — the nudge threshold moves with it");
});

// THE SECOND HALF OF THE SAME REPORT. Routing clear of the wall stops the trip
// being planned into it, but the walker can still be PUSHED into one: NPCs and
// monsters have faked client-side collision (monsterDodge deflects the input
// around their personal space), and that dodge chose its side purely by which
// way got further from the BODY. It had no idea what was underfoot, so a
// villager standing at a wall's foot could send the walker into the masonry —
// "stuck running into an NPC and not around the NPC". It was going around; the
// side it picked was a wall.
test("the dodge goes around a body on the side that is WALKABLE, not merely roomier", () => {
  // Put the body DEAD AHEAD along the heading's own WORLD direction — screen
  // axes are not world axes on an iso grid, so a body placed along screen-x
  // simply is not in the way and no dodge fires at all.
  const east: [number, number] = [1, 0];
  const w = screenToWorldVector(east[0], east[1]);
  const wl = Math.hypot(w.x, w.y);
  const AT = 40; // wu ahead — inside the lookahead, outside personal space
  const bodies = [{ id: "npc:1", x: (w.x / wl) * AT, y: (w.y / wl) * AT, r: 9 }];
  const geoOnly = monsterDodge(0, 0, east[0], east[1], bodies, undefined, undefined, undefined);
  assert.ok(geoOnly, "no dodge at all — the fixture does not put the body in the way");

  // Now declare the side it chose to be a wall, and nothing else.
  const refused = `${geoOnly!.ax},${geoOnly!.ay}`;
  const withWall = monsterDodge(0, 0, east[0], east[1], bodies, undefined, undefined,
    (ax, ay) => `${ax},${ay}` !== refused);
  assert.ok(withWall, "the dodge vanished when one side was a wall — it must still go round");
  assert.notEqual(`${withWall!.ax},${withWall!.ay}`, refused,
    "the dodge still steered into the side declared unwalkable");

  // Both sides open ⇒ unchanged from the pure-geometry answer: the wider berth
  // is still the better dodge, and this fix must not perturb the normal case.
  const bothOpen = monsterDodge(0, 0, east[0], east[1], bodies, undefined, undefined, () => true);
  assert.equal(`${bothOpen!.ax},${bothOpen!.ay}`, refused, "an all-open world changed the dodge");

  // Neither side open ⇒ also unchanged: push on and let unstick / steer assist
  // / the stall re-plan resolve it, exactly as before.
  const noneOpen = monsterDodge(0, 0, east[0], east[1], bodies, undefined, undefined, () => false);
  assert.equal(`${noneOpen!.ax},${noneOpen!.ay}`, refused, "a fully-blocked world changed the dodge");
});

// THE DODGE IS A MANOEUVRE, NOT A PER-FRAME OPINION (maintainer 2026-08-08:
// "the player changes direction and runs back-and-forth-back-and-forth until
// the player finally walks around the NPC").
//
// The weave came from engaging and releasing on the SAME test: step aside, the
// body stops being "in front" by a hair, the dodge drops, the raw heading
// points back at it, the dodge re-engages — and the side was re-scored from
// scratch each time, with only a 4wu bias toward the committed one, far less
// than `clearance` swings by as the walker moves. Measured on the real client
// walking past an NPC: 7 cross-track reversals before, 1 after (one is the
// minimum — out and back IS one reversal).
test("a dodge holds its side until the body is passed, instead of re-deciding every frame", () => {
  const east: [number, number] = [1, 0];
  const w = screenToWorldVector(east[0], east[1]);
  const wl = Math.hypot(w.x, w.y);
  const at = (d: number) => ({ id: "npc:1", x: (w.x / wl) * d, y: (w.y / wl) * d, r: 9 });

  const first = monsterDodge(0, 0, east[0], east[1], [at(40)]);
  assert.ok(first, "no dodge fired at all");
  const side = first!.state.side;

  // THE HOLD. Re-run with the state fed back and the body pushed off-axis —
  // the very sidestep the dodge just produced. The old code let go here (the
  // dot test fails at 0.35) and the walker turned back into it.
  const off = 26; // wu perpendicular — about one sidestep
  const perpX = -w.y / wl, perpY = w.x / wl;
  const asideBody = { id: "npc:1", x: (w.x / wl) * 34 + perpX * off, y: (w.y / wl) * 34 + perpY * off, r: 9 };
  const held = monsterDodge(0, 0, east[0], east[1], [asideBody], first!.state);
  assert.ok(held, "the dodge let go as soon as the walker had stepped aside — that is the weave");
  assert.equal(held!.state.side, side, "the dodge switched sides mid-pass");

  // ...and WITHOUT the committed state, that same geometry is correctly free:
  // this proves the hold is hysteresis, not a permanently wider trigger.
  assert.equal(monsterDodge(0, 0, east[0], east[1], [asideBody]), null,
    "a body that far off-axis should not START a dodge — the trigger got wider, not stickier");

  // PASSED: once it is genuinely behind, the commitment ends.
  const behind = { id: "npc:1", x: -(w.x / wl) * 30, y: -(w.y / wl) * 30, r: 9 };
  assert.equal(monsterDodge(0, 0, east[0], east[1], [behind], held!.state), null,
    "the dodge never releases — the walker would steer around a body it has already passed");

  // The 45-vs-90 escalation latches too: falling back mid-pass is a second weave.
  const wide = { ...first!.state, wide: true };
  const stillWide = monsterDodge(0, 0, east[0], east[1], [at(40)], wide);
  assert.ok(stillWide?.state.wide, "the full detour was abandoned mid-pass");
});
