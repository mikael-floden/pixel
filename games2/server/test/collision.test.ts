import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stepMovement,
  buildTerrainGrid,
  makeBlocked,
  makeDrops,
  makeSideBlocked,
  canEnter,
  surfaceFor,
  surfaceAtWorld,
  levelAtWorld,
  isStandableAtWorld,
  findSpawn,
  stepStamina,
  WALK_CLIMB,
  JUMP_CLIMB,
  PLAYER_RADIUS,
  integrateFall,
  parseWorld,
  MAX_STAMINA,
  SWIM_DRAIN,
  CELL_WU,
  WALK_SPEED,
  ISO_DX,
  ISO_DY,
} from "@nangijala/shared";

// A 3×3 world. Centre column is grass; left column water; the right column is a
// raised grass wall (elevation 1) — a 1-level ledge you can't walk up.
//   W  g   G1
//   W  g   G1
//   W  g   G1
function grid3x3() {
  const g = (l = 0) => ({ t: "grass", l });
  const w = { t: "water", l: 0 };
  const rows = [
    [w, g(0), g(1)],
    [w, g(0), g(1)],
    [w, g(0), g(1)],
  ];
  return buildTerrainGrid(3, 3, rows);
}

// A cell is exactly CELL_WU world units wide/tall (independent of grid size),
// so cell N's centre is (N+0.5)*CELL_WU.
const CELL_W = CELL_WU;
const CELL_H = CELL_WU;
const midX = CELL_W * 1.5; // centre (grass, l0)
const midY = CELL_H * 1.5;
const rightX = CELL_W * 2.5; // raised grass wall (l1)

test("surface table: speeds, swimmable water, unknown defaults to walkable", () => {
  assert.equal(surfaceFor("water").swimmable, true);
  assert.equal(surfaceFor("water").standable, false);
  assert.equal(surfaceFor("brick_road").speed > surfaceFor("sand").speed, true);
  assert.equal(surfaceFor("totally_new_tile").standable, true); // default walkable
});

test("surfaceAtWorld / levelAtWorld map world coords to cells", () => {
  const g = grid3x3();
  assert.equal(surfaceAtWorld(g, midX, midY).standable, true);
  assert.equal(surfaceAtWorld(g, CELL_W * 0.5, midY).swimmable, true); // water column
  assert.equal(levelAtWorld(g, rightX, midY), 1); // raised column
  assert.equal(isStandableAtWorld(g, CELL_W * 0.5, midY), false); // water not standable
});

test("walking cannot climb a 1-level ledge (Option 2B)", () => {
  const g = grid3x3();
  const walk = { maxClimb: WALK_CLIMB, canSwim: false };
  assert.equal(canEnter(g, midX, midY, rightX, midY, walk), false); // l0 -> l1 blocked
  const jump = { maxClimb: JUMP_CLIMB, canSwim: false };
  assert.equal(canEnter(g, midX, midY, rightX, midY, jump), true); // jump crosses it
});

test("falling down is always allowed — only climbing needs the jump", () => {
  const g = grid3x3();
  const walk = { maxClimb: WALK_CLIMB, canSwim: false };
  // Standing on the l1 wall, walking off the edge down to l0 just works.
  assert.equal(canEnter(g, rightX, midY, midX, midY, walk), true);
  // Even a big drop is fine (raise the wall to l3 and step down).
  g.level[g.width * 1 + 2] = 3; // middle-right cell -> l3
  assert.equal(canEnter(g, rightX, midY, midX, midY, walk), true);
  // But the reverse (l0 -> l3) is unclimbable even while jumping.
  const jump = { maxClimb: JUMP_CLIMB, canSwim: false };
  assert.equal(canEnter(g, midX, midY, rightX, midY, jump), false);
});

test("water is enterable only when swimming is allowed", () => {
  const g = grid3x3();
  const noSwim = { maxClimb: WALK_CLIMB, canSwim: false };
  const swim = { maxClimb: WALK_CLIMB, canSwim: true };
  const waterX = CELL_W * 0.5;
  assert.equal(canEnter(g, midX, midY, waterX, midY, noSwim), false);
  assert.equal(canEnter(g, midX, midY, waterX, midY, swim), true);
});

test("stepMovement stops at the ledge when walking, slides along it", () => {
  const g = grid3x3();
  const blocked = makeBlocked(g, { maxClimb: WALK_CLIMB, canSwim: false });
  // Walk east into the raised wall with a big dt: X blocked, stays in mid column.
  const r = stepMovement(midX, midY, 1, 0, true, 5, blocked);
  assert.ok(r.x < CELL_W * 2, "did not climb onto the l1 wall");
});

test("collision probes the leading edge: feet stop PLAYER_RADIUS before a wall", () => {
  const g = grid3x3();
  const blocked = makeBlocked(g, { maxClimb: WALK_CLIMB, canSwim: false });
  // Start near the wall and creep in ~5-unit ticks until stopped.
  let x = CELL_W * 2 - 60;
  const dt = 5 / WALK_SPEED; // ≈5 world units per step
  for (let i = 0; i < 100; i++) {
    const r = stepMovement(x, midY, 1, 0, false, dt, blocked);
    if (r.x === x) break;
    x = r.x;
  }
  assert.ok(x <= CELL_W * 2 - PLAYER_RADIUS + 1e-6, `stopped at ${x}, wall at ${CELL_W * 2}`);
  assert.ok(x > CELL_W * 2 - PLAYER_RADIUS - 6, "but close to the wall, not far away");
});

test("surface speed multiplier scales distance", () => {
  const slow = stepMovement(100, 100, 1, 0, false, 1, undefined, 0.5).x - 100;
  const full = stepMovement(100, 100, 1, 0, false, 1, undefined, 1).x - 100;
  assert.equal(full, WALK_SPEED);
  assert.equal(slow, WALK_SPEED * 0.5);
});

test("findSpawn returns standable open land, never water", () => {
  const g = grid3x3();
  const s = findSpawn(g);
  assert.equal(isStandableAtWorld(g, s.x, s.y), true);
});

test("screen-relative input: Up moves straight up on screen (world x,y both decrease)", () => {
  // Screen up = decrease (col+row) with (col−row) constant → world x,y equal −.
  const r = stepMovement(800, 800, 0, -1, false, 1, undefined, 1, true);
  const dx = r.x - 800;
  const dy = r.y - 800;
  assert.ok(dx < 0 && dy < 0, "moves toward −x,−y in world space");
  assert.ok(Math.abs(dx - dy) < 1e-6, "equal components → vertical on screen");
  assert.equal(r.dir, "north", "faces the direction the player sees");
  // Screen-projected movement: sx ∝ (dx−dy) = 0 (no sideways drift), sy < 0.
  assert.ok(Math.abs(dx - dy) < 1e-6);
});

test("screen-relative input: Right moves straight right on screen", () => {
  const r = stepMovement(800, 800, 1, 0, false, 1, undefined, 1, true);
  const dx = r.x - 800;
  const dy = r.y - 800;
  assert.ok(dx > 0 && dy < 0, "world +x,−y");
  assert.ok(Math.abs(dx + dy) < 1e-6, "opposite components → horizontal on screen");
  assert.equal(r.dir, "east");
});

test("screen speed is uniform: Up, Right and diagonals all move equally fast on screen", () => {
  const screenSpeed = (ax: number, ay: number) => {
    const r = stepMovement(800, 800, ax, ay, false, 1, undefined, 1, true);
    const dx = r.x - 800;
    const dy = r.y - 800;
    // Project the world displacement back to screen pixels (per iso geometry).
    return Math.hypot((dx - dy) * ISO_DX, (dx + dy) * ISO_DY);
  };
  const up = screenSpeed(0, -1);
  const right = screenSpeed(1, 0);
  const diag = screenSpeed(1, 1);
  assert.ok(Math.abs(up - right) < 1e-6, `up ${up} == right ${right}`);
  assert.ok(Math.abs(diag - right) < 1e-6, `diag ${diag} == right ${right}`);
  assert.ok(up > 0);
});

test("parseWorld reads the bigworld@1 index-array schema", () => {
  const json = {
    schema: "pixel-maps/bigworld@1",
    w: 2,
    h: 2,
    categories: ["water", "grass", "stairs"],
    climates: ["sea", "plain"],
    terr: [
      [0, 1],
      [1, 2],
    ],
    variant: [
      [3, 0],
      [1, 0],
    ],
    level: [
      [0, 0],
      [1, 1],
    ],
    climate: [
      [0, 1],
      [1, 1],
    ],
    pois: [{ x: 1, y: 1, label: "Somewhere", tile: "obelisk" }],
  };
  const w = parseWorld(json)!;
  assert.equal(w.width, 2);
  assert.deepEqual(w.rows[0][0], { t: "water", v: 3, l: 0, r: "sea" });
  assert.deepEqual(w.rows[1][1], { t: "stairs", v: 0, l: 1, r: "plain" });
  assert.equal(w.pois[0].label, "Somewhere");
  // Legacy rows schema still parses.
  const legacy = parseWorld({ width: 1, height: 1, rows: [[{ t: "grass", v: 0, l: 0 }]] })!;
  assert.equal(legacy.rows[0][0].t, "grass");
});

test("stairs allow walking a full 1-level step without a jump", () => {
  const rows = [[{ t: "grass", l: 0 }, { t: "stairs", l: 1 }, { t: "grass", l: 1 }]];
  const g = buildTerrainGrid(3, 1, rows);
  const walk = { maxClimb: WALK_CLIMB, canSwim: false };
  const cw = CELL_WU;
  const ch = CELL_WU;
  // grass l0 -> stairs l1: allowed while walking (the stairs are the ramp).
  assert.equal(canEnter(g, cw * 0.5, ch * 0.5, cw * 1.5, ch * 0.5, walk), true);
  // stairs l1 -> grass l1: flat, fine.
  assert.equal(canEnter(g, cw * 1.5, ch * 0.5, cw * 2.5, ch * 0.5, walk), true);
});

test("walking off a ledge is forgiving: reach the rim, no early snap, no teleport", () => {
  // Wide row so SPAWN_MARGIN never clamps: cells 0..4 grass l1, cell 5 grass l0.
  const rows = [[1, 1, 1, 1, 1, 0].map((l) => ({ t: "grass", l }))];
  const g = buildTerrainGrid(6, 1, rows);
  const blocked = makeBlocked(g, { maxClimb: WALK_CLIMB, canSwim: true });
  const edge = CELL_WU * 5; // boundary between cell 4 (l1) and cell 5 (l0)
  const midY = CELL_WU / 2;
  const step = 2 / WALK_SPEED; // ~2 world units per tick

  // Walk east in small ticks. The player must be able to get RIGHT UP to the
  // rim (old code force-committed the fall a full PLAYER_RADIUS early), and no
  // single tick may TELEPORT the anchor (each step advances ≈ its walk length,
  // never a snap past the rim).
  let x = edge - 40;
  let reachedRim = false;
  for (let i = 0; i < 60 && x < edge - 1; i++) {
    const r = stepMovement(x, midY, 1, 0, false, step, blocked, 1, false);
    assert.ok(r.x - x <= 2 + 1e-6, `teleported ${r.x - x}u in one tick at ${x}`);
    x = r.x;
    if (x > edge - PLAYER_RADIUS) reachedRim = true; // got inside the old "overhang" band
  }
  assert.ok(reachedRim, "walked right up to the rim (no early fall commit)");

  // Standing at the rim and stepping once more crosses onto the lower cell —
  // the descent itself is animated client-side, but the anchor just walks over.
  const r = stepMovement(edge - 1, midY, 1, 0, false, step, blocked, 1, false);
  assert.ok(r.x >= edge, "one more step walks off the ledge onto the lower ground");
});

test("makeDrops: the canonical fall predicate (cliff yes, stairs/small step no)", () => {
  // grass l2 | grass l1 | stairs l1 | grass l0
  const rows = [[{ t: "grass", l: 2 }, { t: "grass", l: 1 }, { t: "stairs", l: 1 }, { t: "grass", l: 0 }]];
  const g = buildTerrainGrid(4, 1, rows);
  const drops = makeDrops(g);
  const c = (n: number) => CELL_WU * (n + 0.5);
  const y = CELL_WU / 2;
  assert.equal(drops(c(1), y, c(0), y), true, "l2→l1 is a fall"); // full level down
  assert.equal(drops(c(3), y, c(2), y), false, "stepping OFF stairs to l0 is a ramp, not a fall");
  assert.equal(drops(c(0), y, c(1), y), false, "l1→l2 is a climb up, never a fall");
});

test("integrateFall: a cliff drop falls under gravity (animated, not a snap)", () => {
  const lh = 16; // one elevation level in px
  let s = { elev: 2 * lh, fallV: 0, falling: false }; // standing 2 levels up
  const target = 0; // ground below
  const seq = [s.elev];
  let frames = 0;
  const dt = 1 / 60;
  while (s.elev > target && frames < 200) {
    s = integrateFall(s, target, dt, lh);
    seq.push(s.elev);
    frames++;
  }
  // Passed through several intermediate heights (a teleport would be 1 frame)…
  const distinct = new Set(seq.map((e) => e.toFixed(2)));
  assert.ok(distinct.size >= 4, `expected an animated descent, got ${distinct.size} heights`);
  // …strictly downward…
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] <= seq[i - 1] + 1e-9, "elevation only descends");
  // …lands exactly on the ground, in a fraction of a second, and clears the flag.
  assert.equal(s.elev, 0);
  assert.equal(s.falling, false);
  assert.ok(frames < 30, `a 2-level fall should land quickly, took ${frames} frames`);
});

test("integrateFall: up-steps snap, gentle down-steps ease (stairs are not falls)", () => {
  const lh = 16;
  // Climbing up (e.g. landing a jump on a higher cell) snaps instantly.
  const up = integrateFall({ elev: 0, fallV: 0, falling: false }, lh, 1 / 60, lh);
  assert.deepEqual(up, { elev: lh, fallV: 0, falling: false });
  // A half-level step down (stairs) eases smoothly and never enters free-fall.
  let s = { elev: 0.5 * lh, fallV: 0, falling: false };
  for (let i = 0; i < 30; i++) s = integrateFall(s, 0, 1 / 60, lh);
  assert.ok(!s.falling, "a stairs-sized step never triggers a gravity fall");
  assert.ok(Math.abs(s.elev) < 0.5, "eases down onto the lower step");
});

test("auto-jump rule: a 1-level wall auto-hops; a 2-level wall / prop / flat do not", () => {
  // cells: l0 | l1 | l2 | l0(+prop). The client auto-jumps exactly when a walk
  // is blocked by height but a jump would clear it: !canEnter(walk)&&canEnter(jump).
  const rows = [[{ t: "grass", l: 0 }, { t: "grass", l: 1 }, { t: "grass", l: 2 }, { t: "grass", l: 0 }]];
  const g = buildTerrainGrid(4, 1, rows, [{ col: 3, row: 0 }]); // prop on the last cell
  const y = CELL_WU / 2;
  const walk = { maxClimb: WALK_CLIMB, canSwim: true };
  const jump = { maxClimb: JUMP_CLIMB, canSwim: true };
  const c = (n: number) => CELL_WU * (n + 0.5);
  const autoJump = (fromCell: number, toCell: number) =>
    !canEnter(g, c(fromCell), y, c(toCell), y, walk) && canEnter(g, c(fromCell), y, c(toCell), y, jump);
  assert.equal(autoJump(0, 1), true, "l0→l1 (1-level wall) auto-jumps");
  assert.equal(autoJump(0, 2), false, "l0→l2 (2-level wall) does NOT auto-jump");
  assert.equal(autoJump(0, 3), false, "into a solid prop does NOT auto-jump");
  assert.equal(autoJump(1, 1), false, "flat ground does NOT auto-jump");
});

test("a placed prop makes its cell solid (movement in is refused)", () => {
  // Flat 3×1 grass; a prop stands on the middle cell (col 1). Walking east from
  // cell 0 must stop before entering cell 1 — the prop is an obstacle.
  const rows = [[{ t: "grass", l: 0 }, { t: "grass", l: 0 }, { t: "grass", l: 0 }]];
  const g = buildTerrainGrid(3, 1, rows, [{ col: 1, row: 0 }]);
  assert.equal(isStandableAtWorld(g, CELL_WU * 1.5, CELL_WU * 0.5), false, "prop cell not standable");
  assert.equal(isStandableAtWorld(g, CELL_WU * 0.5, CELL_WU * 0.5), true, "plain cell standable");
  assert.equal(
    canEnter(g, CELL_WU * 0.5, CELL_WU * 0.5, CELL_WU * 1.5, CELL_WU * 0.5, { maxClimb: JUMP_CLIMB, canSwim: true }),
    false,
    "cannot enter a prop cell even while jumping",
  );
  // Integrating movement east, the player never ends up standing on the prop.
  const blocked = makeBlocked(g, { maxClimb: WALK_CLIMB, canSwim: true });
  let x = CELL_WU * 0.5;
  const midY = CELL_WU / 2;
  for (let i = 0; i < 80; i++) {
    const r = stepMovement(x, midY, 1, 0, false, 2 / WALK_SPEED, blocked, 1, false);
    if (Math.abs(r.x - x) < 1e-6) break;
    x = r.x;
  }
  assert.ok(x < CELL_WU, `stopped before the prop cell (x=${x}, cell boundary ${CELL_WU})`);
});

test("cleanupRoads: stubs dissolve, roads unify to their majority style", () => {
  // One long road (5 cells) with a minority style in the middle, plus a
  // 2-cell orphan stub elsewhere.
  const g = (t: string, v = 0) => ({ t, v, l: 0 });
  const rows = [
    [
      g("road_dirt_grass_straight", 1),
      g("road_dirt_grass_straight", 1),
      g("road_sand_straight", 2),
      g("road_dirt_grass_turns", 3),
      g("road_dirt_grass_straight", 1),
    ],
    [g("grass"), g("grass"), g("grass"), g("grass"), g("grass")],
    [g("road_sand_straight", 2), g("road_sand_straight", 2), g("grass"), g("grass"), g("grass")],
  ];
  const w = parseWorld({ width: 5, height: 3, rows })!;
  // Majority style wins along the long road…
  assert.equal(w.rows[0][2].t, "road_dirt_grass_straight");
  // …reusing only variants that exist in the map for that category.
  assert.ok([1].includes(w.rows[0][2].v));
  // Turns keep their suffix.
  assert.equal(w.rows[0][3].t, "road_dirt_grass_turns");
  // The 2-cell stub dissolves into surrounding ground.
  assert.equal(w.rows[2][0].t, "grass");
  assert.equal(w.rows[2][1].t, "grass");
});

test("stepStamina drains in water, drowns at zero, regenerates on land", () => {
  const drain = stepStamina(MAX_STAMINA, true, 1);
  assert.equal(drain.stamina, MAX_STAMINA - SWIM_DRAIN);
  assert.equal(drain.drowned, false);

  const drowned = stepStamina(5, true, 1); // 5 - 20*1 <= 0
  assert.equal(drowned.stamina, 0);
  assert.equal(drowned.drowned, true);

  const regen = stepStamina(50, false, 1);
  assert.ok(regen.stamina > 50 && regen.stamina <= MAX_STAMINA);
  assert.equal(regen.drowned, false);
});

test("no wedging at an inside cliff corner (stuck-walking-downhill bug)", () => {
  // A 2×2 low pocket with HIGH walls east (col 2) and south (row 2) — the
  // inside corner a player stands in right after descending a ledge near its
  // corner. Wedged spot: within the forward probe (PLAYER_RADIUS) of the east
  // wall AND within a lateral probe (0.75×PLAYER_RADIUS) of the south wall.
  // With full-rule corner probes BOTH axes were vetoed by the wall beside the
  // path and the player froze; lateral probes are solids-only now.
  const g = (l = 0) => ({ t: "grass", l });
  const rows = [
    [g(0), g(0), g(1)],
    [g(0), g(0), g(1)],
    [g(1), g(1), g(1)],
  ];
  const grid = buildTerrainGrid(3, 3, rows);
  const ctx = { maxClimb: WALK_CLIMB, canSwim: true };
  const blocked = makeBlocked(grid, ctx);
  const side = makeSideBlocked(grid, ctx);
  const x0 = 2 * CELL_WU - 6;
  const y0 = 2 * CELL_WU - 6;
  const step = (ax: number, ay: number) =>
    stepMovement(x0, y0, ax, ay, false, 0.2, blocked, 1, false, undefined, undefined, side);
  // Escaping along either axis must actually move…
  assert.ok(step(-1, 0).x < x0 - 1, "walks west out of the corner");
  assert.ok(step(0, -1).y < y0 - 1, "walks north out of the corner");
  // …while the forward centre probe still stops walking INTO the walls.
  assert.ok(step(1, 0).x <= x0 + 1e-6, "cannot walk east up the wall");
  assert.ok(step(0, 1).y <= y0 + 1e-6, "cannot walk south up the wall");
});
