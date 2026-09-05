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
import {
  parseWorld, buildTerrainGrid, findPath, monsterDodge, screenToWorldVector, bodyStandoff,
  startTrip, stepAutopilot, stepMovement, makeBlockedElev, makeSideBlocked,
  CELL_WU, PLAYER_RADIUS, WALK_CLIMB, WALK_SPEED,
} from "@nangijala/shared";

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

  // ...but the 45-vs-90 ESCALATION must NOT latch, and that distinction is the
  // whole difference between a detour and a circle. A 90° rotation on the
  // 8-way ring is exactly perpendicular: zero progress toward the waypoint, so
  // the body stays exactly as far ahead as it was and the release above can
  // never come true. Latching it made the walker orbit (maintainer 2026-08-08:
  // "the player runs a full circle around the NPC"). Held SIDE, free MAGNITUDE.
  const wide = { ...first!.state, wide: true };
  const relaxed = monsterDodge(0, 0, east[0], east[1], [at(40)], wide);
  assert.ok(relaxed, "the dodge dropped its blocker");
  assert.equal(relaxed!.state.side, side, "the side stopped being held");
  assert.equal(relaxed!.state.wide, false,
    "the 90° detour latched — that is the orbit, not a dodge");
});


// A DODGE NEVER TRADES PROGRESS FOR CLEARANCE, and only emits a heading it has
// actually checked.
//
// Two failures met here. The openness probe used to test only the two 45°
// rotations while emitting the 90° one when the slip was tight — a heading
// nothing had checked — and held by the hysteresis that parked the walker
// against the house wall for a full second. And the 90° rotation itself has
// zero progress toward the waypoint, so it is only ever right when the walker
// is ALREADY inside the personal space and simply has to step out.
test("a dodge only emits a heading it checked, and keeps making progress", () => {
  const east: [number, number] = [1, 0];
  const w = screenToWorldVector(east[0], east[1]);
  const wl = Math.hypot(w.x, w.y);
  const at = (d: number) => ({ id: "npc:1", x: (w.x / wl) * d, y: (w.y / wl) * d, r: 9 });
  // Personal space is 9 + 9 + 6 = 24wu, so 40wu is a normal approach and 18wu
  // is already inside it.
  const far = [at(40)];

  const pref = monsterDodge(0, 0, east[0], east[1], far, undefined, undefined, () => true);
  assert.ok(pref, "no dodge fired at all");
  // Progress is measured against the RAW heading: a 90° ring rotation off east
  // is (0,±1), whose dot with (1,0) is exactly 0 — the orbit.
  const progress = (r: { ax: number; ay: number }) =>
    (r.ax * east[0] + r.ay * east[1]) / (Math.hypot(r.ax, r.ay) || 1);
  assert.ok(progress(pref!) > 0.5, "the normal-approach dodge already gives up progress");

  // Wall off exactly what it prefers: it must pick something else, that
  // something must be open, and it must STILL make progress (i.e. it gives up
  // the side, not the forward motion — a static wall cannot chatter, an orbit
  // never ends).
  const open = (ax: number, ay: number) => !(ax === pref!.ax && ay === pref!.ay);
  const out = monsterDodge(0, 0, east[0], east[1], far, undefined, undefined, open);
  assert.ok(out, "the dodge vanished when its preferred heading was walled");
  assert.ok(open(out!.ax, out!.ay),
    "the dodge emitted the very heading it was told is a wall — that is the stall");
  assert.ok(progress(out!) > 0.5, "the fallback traded forward progress — that is the circle");

  // Inside the personal space the 90° step-out IS allowed: that is the one
  // case a person really does sidestep, and it cannot persist because the step
  // itself opens the distance.
  const inside = monsterDodge(0, 0, east[0], east[1], [at(18)], undefined, undefined, () => true);
  assert.ok(inside, "no dodge fired from inside the personal space");
  assert.ok(inside!.state.wide, "a walker already inside the body cannot step out sideways");
});

// THE WALKER MUST NOT ORBIT SOMEBODY STANDING ON ITS WAYPOINT (maintainer
// 2026-08-08: "instead of running around the NPC the player runs a full circle
// around the NPC. This looks so funny and insanely wrong!").
//
// Routes are planned on the terrain grid, which knows nothing about bodies, so
// a waypoint lands on the NPC regularly. The dodge then keeps the walker out of
// that spot while the autopilot keeps steering at it, and the resultant of "go
// there" and "not through her" is a CIRCLE at personal-space radius. Neither
// half was wrong, which is why tuning either one only moved the symptom —
// measured on the maintainer's own walk, 231° of sweep around her.
//
// Replayed at 60Hz through the real brain, because that fight only exists when
// stepAutopilot, monsterDodge and stepMovement all run against real geometry.
test("a body standing on the route is passed, not orbited", () => {
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  const worldW = grid.width * CELL_WU;
  const worldH = grid.height * CELL_WU;
  const npc = { id: "npc:aurelia", x: 178.5 * CELL_WU, y: 120.5 * CELL_WU, r: 9 };

  // 9 (npc) + (9 + 6) * MONSTER_DODGE_TIGHTEN(0.85). A GUARD, not a behaviour
  // check: it fires when the clearance moves so this fixture's geometry gets
  // re-examined rather than silently measuring nothing.
  assert.equal(bodyStandoff(npc.x, npc.y, [npc]), 21.75,
    "personal space moved — this test's geometry no longer matches the dodge's");
  assert.equal(bodyStandoff(npc.x + 100, npc.y, [npc]), 0, "a free point reported occupied");

  const trip = (from: [number, number], to: [number, number]) => {
    let x = from[0] * CELL_WU, y = from[1] * CELL_WU;
    const t0 = startTrip(grid, x, y, to[0] * CELL_WU, to[1] * CELL_WU, false, 0);
    assert.ok(t0, "no route at all");
    const blocked = makeBlockedElev(grid, walk, () => 0);
    const sideB = makeSideBlocked(grid, walk);
    let state: ReturnType<typeof monsterDodge> extends null ? never : any;
    let swept = 0, bearing = Math.atan2(y - npc.y, x - npc.x), arrived = false, t = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 20; i++) {
      const d = stepAutopilot(grid, t0!, x, y, t * 1000, worldW, worldH, 0,
        (wx, wy) => bodyStandoff(wx, wy, [npc]));
      if (d.done) { arrived = true; break; }
      let { ax, ay } = d;
      const open = (hax: number, hay: number) => {
        const r = stepMovement(x, y, hax, hay, false, 0.08, blocked, 1, true, worldW, worldH, sideB);
        return Math.hypot(r.x - x, r.y - y) > WALK_SPEED * 0.08 * 0.35;
      };
      const dodge = monsterDodge(x, y, ax, ay, [npc], state, undefined, open);
      if (dodge) { ax = dodge.ax; ay = dodge.ay; state = dodge.state; } else state = undefined;
      const r = stepMovement(x, y, ax, ay, false, dt, blocked, 1, true, worldW, worldH, sideB);
      x = r.x; y = r.y; t += dt;
      // Sweep is accumulated only while the DODGE is engaged, so the route's
      // own curve around the house (which sweeps plenty on its own) can't be
      // mistaken for an orbit.
      if (dodge) {
        const b = Math.atan2(y - npc.y, x - npc.x);
        let db = b - bearing;
        while (db > Math.PI) db -= 2 * Math.PI;
        while (db < -Math.PI) db += 2 * Math.PI;
        swept += db;
      }
      bearing = Math.atan2(y - npc.y, x - npc.x);
    }
    return { arrived, deg: Math.abs((swept * 180) / Math.PI), t };
  };

  // Passing her: walking round somebody sweeps at most half a turn — beyond
  // 180° you are going round the back, which is the circle.
  for (const [label, from, to] of [
    ["out of the house", [176.2, 117.6], [183.3, 118.3]],
    ["back into it", [183.3, 118.3], [176.2, 117.6]],
  ] as Array<[string, [number, number], [number, number]]>) {
    const r = trip(from, to);
    assert.ok(r.arrived, `${label}: never arrived`);
    assert.ok(r.deg < 180, `${label}: swept ${r.deg.toFixed(0)}° around her — that is an orbit`);
  }

  // ...and tapping the ground she is STANDING on ends the trip beside her,
  // rather than circling until the 1.5s stall timer bails it out.
  const onto = trip([176.2, 117.6], [178.5, 120.5]);
  assert.ok(onto.arrived, "a trip onto an occupied spot never ended");
  assert.ok(onto.t < 3.5, `took ${onto.t.toFixed(2)}s to give up on an occupied spot`);
  assert.ok(onto.deg < 90, `swept ${onto.deg.toFixed(0)}° around the spot before settling`);
});
