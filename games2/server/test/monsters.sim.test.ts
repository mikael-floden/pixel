// Headless monster tests for the maps2 SPAWN ZONES (pixel-maps2/spawns@1).
// maps2 owns monster placement: every world ships worlds/<name>/spawns.json
// with polygon zones {id, monster, area, elev, num}. These tests cover the
// pure geometry (parseSpawns / pointInZone / zonePolygonCells), the
// terrain-aware resolution (buildZoneRuntimes — the SAME function WorldRoom
// uses), and a full headless roam: one monster driven through the server's
// exact brain+body loop on the REAL worlds' REAL zones, proving it stays in
// its zone, on valid ground, at a valid elevation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWorld,
  buildTerrainGrid,
  startTrip,
  stepAutopilot,
  stepMovement,
  makeBlockedElev,
  makeSideBlocked,
  surfaceAtWorld,
  resolveElevAt,
  TerrainGrid,
  CELL_WU,
  WALK_CLIMB,
  MONSTER_SPEED_SCALE,
  MONSTER_ROAM_RADIUS_CELLS,
  MONSTER_ROAM_PAUSE_MS_MIN,
  MONSTER_ROAM_PAUSE_MS_MAX,
  randomPauseMs,
  parseSpawns,
  pointInZone,
  zonePolygonCells,
  buildZoneRuntimes,
  monsterDodge,
  separationPush,
  screenToWorldVector,
  MONSTER_DODGE_LOOKAHEAD,
  MONSTER_DODGE_MARGIN,
  MONSTER_SEP_MARGIN,
  MONSTER_SEP_RELAX_SPEED,
  DEFAULT_MONSTER_RADIUS,
  PLAYER_BODY_RADIUS,
  type SpawnZone,
  type ZoneRuntime,
  type MonsterDodgeState,
} from "@nangijala/shared";

const HERE = dirname(fileURLToPath(import.meta.url)); // games2/server/test
const REPO = join(HERE, "..", "..", ".."); // pixel repo root

interface SimWorld {
  grid: TerrainGrid;
  worldW: number;
  worldH: number;
  zones: SpawnZone[];
  runtimes: ZoneRuntime[];
}

function loadMaps2World(name: string): SimWorld | null {
  const path = join(REPO, "maps2", "worlds", name, "world.json");
  if (!existsSync(path)) return null;
  const world = parseWorld(JSON.parse(readFileSync(path, "utf8")));
  if (!world) return null;
  const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
  const spawnsPath = join(REPO, "maps2", "worlds", name, "spawns.json");
  const zones = existsSync(spawnsPath)
    ? parseSpawns(JSON.parse(readFileSync(spawnsPath, "utf8")))
    : [];
  return {
    grid,
    worldW: world.width * CELL_WU,
    worldH: world.height * CELL_WU,
    zones,
    // Exactly what the server computes at room create.
    runtimes: buildZoneRuntimes(grid, zones),
  };
}

/** Deterministic mulberry32 — the SAME PRNG the server seeds from monsterSeed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — parseSpawns / pointInZone / zonePolygonCells
// ---------------------------------------------------------------------------

test("parseSpawns: accepts spawns@1, skips malformed zones, rejects other docs", () => {
  const good = {
    schema: "pixel-maps2/spawns@1",
    zones: [
      { id: "a", monster: "poring", area: [[0, 0], [4, 0], [4, 4]], elev: [0, 2], num: 3 },
      { id: "bad-no-monster", area: [[0, 0], [4, 0], [4, 4]], elev: [0, 2], num: 3 },
      { id: "bad-two-points", monster: "x", area: [[0, 0], [4, 0]], elev: [0, 2], num: 3 },
      { id: "b", monster: "frog", area: [[0, 0], [2, 0], [2, 2]], elev: [1, 1] }, // num defaults to 1
    ],
  };
  const zones = parseSpawns(good);
  assert.equal(zones.length, 2);
  assert.equal(zones[0].id, "a");
  assert.equal(zones[1].num, 1, "missing num defaults to 1");
  assert.deepEqual(parseSpawns({ schema: "something-else", zones: [] }), []);
  assert.deepEqual(parseSpawns(null), []);
  assert.deepEqual(parseSpawns({ schema: "pixel-maps2/spawns@1" }), []);
});

// An L-shape (concave): the 4x4 square minus its top-right 2x2 quadrant.
const L_ZONE: SpawnZone = {
  id: "L",
  monster: "poring",
  area: [[0, 0], [2, 0], [2, 2], [4, 2], [4, 4], [0, 4]],
  elev: [0, 99],
  num: 1,
};

test("pointInZone: even-odd membership incl. concave notches", () => {
  assert.ok(pointInZone(L_ZONE, 1, 1), "lower-left quadrant inside");
  assert.ok(pointInZone(L_ZONE, 1, 3), "left column inside");
  assert.ok(pointInZone(L_ZONE, 3, 3), "lower-right quadrant inside");
  assert.ok(!pointInZone(L_ZONE, 3, 1), "the notch (top-right) is OUTSIDE");
  assert.ok(!pointInZone(L_ZONE, 5, 2), "beyond the polygon is outside");
  assert.ok(!pointInZone(L_ZONE, -1, 2), "left of the polygon is outside");
});

test("zonePolygonCells: cells whose CENTRE is inside, clipped to the world", () => {
  const cells = zonePolygonCells(L_ZONE, 10, 10);
  // 4x4 square = 16 cells minus the 2x2 notch = 12.
  assert.equal(cells.length, 12);
  const key = (c: number, r: number) => `${c},${r}`;
  const set = new Set(cells.map((p) => key(p.c, p.r)));
  assert.ok(set.has(key(0, 0)) && set.has(key(1, 3)) && set.has(key(3, 3)));
  assert.ok(!set.has(key(2, 0)) && !set.has(key(3, 1)), "notch cells excluded");
  // Clipping: a polygon reaching past the world edge only yields in-world cells.
  const clipped: SpawnZone = { ...L_ZONE, area: [[-3, -3], [2, -3], [2, 2], [-3, 2]] };
  const cc = zonePolygonCells(clipped, 10, 10);
  assert.equal(cc.length, 4, "only the 2x2 in-world corner remains");
  for (const p of cc) assert.ok(p.c >= 0 && p.r >= 0);
});

test("randomPauseMs: within the configured range", () => {
  assert.ok(randomPauseMs(() => 0) === MONSTER_ROAM_PAUSE_MS_MIN);
  assert.ok(Math.abs(randomPauseMs(() => 1 - 1e-12) - MONSTER_ROAM_PAUSE_MS_MAX) < 1e-3);
  const rng = mulberry32(3);
  for (let i = 0; i < 1000; i++) {
    const v = randomPauseMs(rng);
    assert.ok(v >= MONSTER_ROAM_PAUSE_MS_MIN && v <= MONSTER_ROAM_PAUSE_MS_MAX);
  }
});

// ---------------------------------------------------------------------------
// buildZoneRuntimes against the REAL shipped zone files: every zone resolves,
// and every resolved cell truly satisfies the zone's contract on the grid.
// ---------------------------------------------------------------------------

for (const worldName of ["ring_test", "the_island2", "monster_demo"]) {
  test(`zones on ${worldName}: every shipped zone resolves to valid cells`, () => {
    const w = loadMaps2World(worldName);
    if (!w) return test.skip(`${worldName} missing`);
    assert.ok(w.zones.length > 0, `${worldName} ships spawn zones`);
    // The generator asserts >= num standable cells per zone before writing the
    // file — so every shipped zone must survive resolution.
    assert.equal(
      w.runtimes.length,
      w.zones.length,
      `all ${w.zones.length} zones have valid cells`,
    );
    for (const rt of w.runtimes) {
      const [lo, hi] = rt.zone.elev;
      assert.ok(rt.cells.length >= 1);
      for (const cell of rt.cells) {
        // Membership: the cell centre is inside the polygon.
        assert.ok(
          pointInZone(rt.zone, cell.c + 0.5, cell.r + 0.5),
          `${rt.zone.id}: cell (${cell.c},${cell.r}) centre inside polygon`,
        );
        // The qualifying surface level is inside the band…
        assert.ok(cell.lvl >= lo && cell.lvl <= hi, `${rt.zone.id}: lvl in band`);
        // …and it really is the base or the deck of that cell on the grid.
        const i = cell.r * w.grid.width + cell.c;
        const isBase = w.grid.level[i] === cell.lvl && !w.grid.blocked[i];
        const isDeck = w.grid.deck[i] === cell.lvl;
        assert.ok(isBase || isDeck, `${rt.zone.id}: lvl matches a real surface`);
        if (isBase && !isDeck) {
          const s = surfaceAtWorld(w.grid, (cell.c + 0.5) * CELL_WU, (cell.r + 0.5) * CELL_WU);
          assert.ok(
            s.standable || (s.swimmable && rt.canSwim),
            `${rt.zone.id}: base cell enterable (swim only in water zones)`,
          );
        }
      }
    }
  });
}

test("the_island2 layered zones: cave floor vs roof-deck zones share cells at different levels", () => {
  const w = loadMaps2World("the_island2");
  if (!w) return test.skip("the_island2 missing");
  // The spawns@1 headline case: somewhere in the file two zones resolve the
  // SAME cell at DIFFERENT levels (cave floor under a walkable roof deck).
  const byCell = new Map<number, Set<number>>();
  for (const rt of w.runtimes) {
    for (const cell of rt.cells) {
      const k = cell.r * w.grid.width + cell.c;
      if (!byCell.has(k)) byCell.set(k, new Set());
      byCell.get(k)!.add(cell.lvl);
    }
  }
  let layered = 0;
  for (const lvls of byCell.values()) if (lvls.size > 1) layered++;
  assert.ok(layered > 0, "at least one cell serves two zones at different levels");
});

// ---------------------------------------------------------------------------
// Headless roam: drive ONE monster through the SAME brain+body loop the server
// uses (zone-cell targets, canSwim per zone, cell-membership snap) on the REAL
// zones, and prove it stays in its zone on valid ground.
// ---------------------------------------------------------------------------

function roamOneMonster(
  w: SimWorld,
  rt: ZoneRuntime,
  seed: number,
  ticks: number,
): { moved: boolean; violations: string[]; trips: number } {
  const { grid, worldW, worldH } = w;
  const rng = mulberry32(seed);
  const ctx = { maxClimb: WALK_CLIMB, canSwim: rt.canSwim };
  const dt = 1 / 20; // 20 Hz tick
  let nowMs = 0;

  // Spawn exactly like seedMonsters: a random pre-validated zone cell.
  const cell0 = rt.cells[Math.floor(rng() * rt.cells.length)];
  let x = (cell0.c + 0.5 + (rng() - 0.5) * 0.5) * CELL_WU;
  let y = (cell0.r + 0.5 + (rng() - 0.5) * 0.5) * CELL_WU;
  let elev = cell0.lvl;
  let nextMoveAt = nowMs + Math.floor(rng() * 600);
  let trip = null as ReturnType<typeof startTrip>;
  let tripActive = false;

  const startX = x;
  const startY = y;
  const violations: string[] = [];
  let trips = 0;

  // Exactly WorldRoom.pickMonsterTarget: random zone cells, prefer local.
  const pickTarget = (): { x: number; y: number } => {
    const fc = x / CELL_WU;
    const fr = y / CELL_WU;
    let fallback: { x: number; y: number } | null = null;
    for (let i = 0; i < 8; i++) {
      const cell = rt.cells[Math.floor(rng() * rt.cells.length)];
      const p = { x: (cell.c + 0.5) * CELL_WU, y: (cell.r + 0.5) * CELL_WU };
      if (!fallback) fallback = p;
      const d = Math.hypot(cell.c + 0.5 - fc, cell.r + 0.5 - fr);
      if (d < 1) continue;
      if (d <= MONSTER_ROAM_RADIUS_CELLS) return p;
    }
    return fallback ?? { x, y };
  };

  for (let i = 0; i < ticks; i++) {
    nowMs += dt * 1000;

    if (!tripActive) {
      if (nowMs >= nextMoveAt) {
        const t = pickTarget();
        trip = startTrip(grid, x, y, t.x, t.y, false, nowMs, elev);
        tripActive = !!trip;
        if (!tripActive) nextMoveAt = nowMs + Math.floor(randomPauseMs(rng));
        else trips++;
      }
    }

    if (tripActive) {
      const a = stepAutopilot(grid, trip!, x, y, nowMs, worldW, worldH, elev);
      if (a.done) {
        tripActive = false;
        trip = null;
        nextMoveAt = nowMs + Math.floor(randomPauseMs(rng));
      } else {
        const surf = surfaceAtWorld(grid, x, y);
        const r = stepMovement(
          x,
          y,
          a.ax,
          a.ay,
          false,
          dt,
          makeBlockedElev(grid, ctx, () => elev),
          surf.speed * MONSTER_SPEED_SCALE,
          true,
          worldW,
          worldH,
          makeSideBlocked(grid, ctx),
        );
        x = r.x;
        y = r.y;
        elev = resolveElevAt(grid, elev, x, y, ctx);
      }
    }

    // Exactly WorldRoom's safety net: snap back on a polygon exit.
    const mc = Math.floor(x / CELL_WU);
    const mr = Math.floor(y / CELL_WU);
    if (!rt.cellSet.has(mc + mr * grid.width)) {
      let best = rt.cells[0];
      let bestD = Infinity;
      for (const cell of rt.cells) {
        const d = Math.hypot(cell.c - mc, cell.r - mr);
        if (d < bestD) {
          bestD = d;
          best = cell;
        }
      }
      x = (best.c + 0.5) * CELL_WU;
      y = (best.r + 0.5) * CELL_WU;
      elev = best.lvl;
      tripActive = false;
      trip = null;
      nextMoveAt = nowMs + Math.floor(randomPauseMs(rng));
    }

    // Invariants checked EVERY tick (post-snap, like the server's tick end).
    const cc = Math.floor(x / CELL_WU);
    const cr = Math.floor(y / CELL_WU);
    if (!rt.cellSet.has(cc + cr * grid.width)) {
      violations.push(`tick ${i}: outside zone at (${x.toFixed(1)},${y.toFixed(1)})`);
    }
    const s = surfaceAtWorld(grid, x, y);
    if (!s.standable && !(s.swimmable && rt.canSwim)) {
      violations.push(`tick ${i}: on invalid ground at (${x.toFixed(1)},${y.toFixed(1)})`);
    }
    const [lo, hi] = rt.zone.elev;
    if (elev < lo - 1 || elev > hi + 1) {
      violations.push(`tick ${i}: elev ${elev} left band [${lo},${hi}]`);
    }
  }

  const moved = Math.hypot(x - startX, y - startY) > 1 || trips > 0;
  return { moved, violations, trips };
}

for (const worldName of ["ring_test", "the_island2", "monster_demo"]) {
  test(`headless roam on ${worldName}: monsters stay in their zones on valid ground`, () => {
    const w = loadMaps2World(worldName);
    if (!w) return test.skip(`${worldName} missing`);
    assert.ok(w.runtimes.length > 0, "world has resolved zones");
    // A spread of zones per world: land, water (canSwim), deck/cave layers —
    // whatever the file ships, capped so the suite stays fast.
    const sample: ZoneRuntime[] = [];
    const water = w.runtimes.find((r) => r.canSwim);
    if (water) sample.push(water);
    for (const rt of w.runtimes) {
      if (sample.length >= 6) break;
      if (!sample.includes(rt)) sample.push(rt);
    }
    let anyMoved = false;
    for (let zi = 0; zi < sample.length; zi++) {
      const rt = sample[zi];
      const { moved, violations, trips } = roamOneMonster(w, rt, 1000 + zi * 77, 1200);
      assert.equal(
        violations.length,
        0,
        `${rt.zone.id} (${rt.zone.monster}): ${violations.length} violations — ${violations.slice(0, 3).join("; ")}`,
      );
      anyMoved = anyMoved || (moved && trips > 0);
    }
    assert.ok(anyMoved, "at least one sampled monster actually roamed");
  });
}

// ---------------------------------------------------------------------------
// Client-side soft monster collision (monsterDodge): the player's 8-way input
// slips around a monster's personal space — pure function, tested headlessly.
// ---------------------------------------------------------------------------

test("monsterDodge: deflects a heading that runs into a monster; leaves free headings alone", () => {
  const w = screenToWorldVector(1, 0); // screen-east's world direction
  const wl = Math.hypot(w.x, w.y);
  const ux = w.x / wl;
  const uy = w.y / wl;
  const ahead = (d: number) => ({ id: "m1", x: ux * d, y: uy * d });
  // Dead ahead inside the lookahead → deflect to a DIFFERENT 8-way input.
  const d1 = monsterDodge(0, 0, 1, 0, [ahead(18)]);
  assert.ok(d1, "blocking monster deflects");
  assert.ok(d1!.ax !== 1 || d1!.ay !== 0, "deflected input differs");
  assert.ok(Math.abs(d1!.ax) <= 1 && Math.abs(d1!.ay) <= 1, "still an 8-way input");
  // The deflected direction's probe ends FARTHER from the monster than the
  // straight line would — that's the whole point.
  const dv = screenToWorldVector(d1!.ax, d1!.ay);
  const dvl = Math.hypot(dv.x, dv.y);
  const clearStraight = Math.hypot(ahead(18).x - ux * 12, ahead(18).y - uy * 12);
  const clearDodged = Math.hypot(ahead(18).x - (dv.x / dvl) * 12, ahead(18).y - (dv.y / dvl) * 12);
  assert.ok(clearDodged > clearStraight, "dodge opens distance");
  // Behind → free.
  assert.equal(monsterDodge(0, 0, 1, 0, [{ id: "m", x: -ux * 15, y: -uy * 15 }]), null);
  // Personal space is radius-derived (v2): obstacle r + the dodger's own body
  // + the comfort margin; lookahead = max(base, personal + 20).
  const personal = DEFAULT_MONSTER_RADIUS + PLAYER_BODY_RADIUS + MONSTER_DODGE_MARGIN;
  const lookahead = Math.max(MONSTER_DODGE_LOOKAHEAD, personal + 20);
  // Beyond the lookahead → free.
  assert.equal(monsterDodge(0, 0, 1, 0, [ahead(lookahead + 5)]), null);
  // Far off the line (lateral miss) → free. Perpendicular of (ux,uy):
  const px = -uy;
  const py = ux;
  assert.equal(
    monsterDodge(0, 0, 1, 0, [
      { id: "m", x: ux * 16 + px * (personal + 6), y: uy * 16 + py * (personal + 6) },
    ]),
    null,
  );
  // No input → no dodge.
  assert.equal(monsterDodge(0, 0, 0, 0, [ahead(14)]), null);
});

test("monsterDodge: personal space scales with the obstacle's art radius", () => {
  const w = screenToWorldVector(1, 0);
  const wl = Math.hypot(w.x, w.y);
  const ux = w.x / wl;
  const uy = w.y / wl;
  // Same spot 60wu dead ahead: a mammoth-sized body (r=42 → personal 57,
  // lookahead 77) deflects the walker, a poring-sized one (r=13 → lookahead
  // 48) is still far enough to walk toward freely.
  const at60 = (r: number) => [{ id: "m", x: ux * 60, y: uy * 60, r }];
  assert.ok(monsterDodge(0, 0, 1, 0, at60(42)), "mammoth deflects from 60wu");
  assert.equal(monsterDodge(0, 0, 1, 0, at60(13)), null, "poring is ignored at 60wu");
  // Lateral pass: a line that grazes a poring clears a mammoth's flank only
  // with a real detour — the same offset misses one and hits the other.
  const px = -uy;
  const py = ux;
  const off = 30; // wu — outside poring personal (28), inside mammoth's (57)
  const graze = (r: number) => [{ id: "m", x: ux * 30 + px * off, y: uy * 30 + py * off, r }];
  assert.equal(monsterDodge(0, 0, 1, 0, graze(13)), null, "poring graze is free");
  assert.ok(monsterDodge(0, 0, 1, 0, graze(42)), "mammoth graze deflects");
});

test("separationPush: radius-aware positional relaxation, clamped, tie-broken", () => {
  const dt = 1 / 20;
  const maxStep = MONSTER_SEP_RELAX_SPEED * dt;
  // Two mammoths 30wu apart (target 42+42+margin): both push straight apart,
  // clamped to the per-tick cap (they must WALK apart, not teleport).
  const pair = [
    { x: 100, y: 100, r: 42 },
    { x: 130, y: 100, r: 42 },
  ];
  const a = separationPush(pair, 0, dt, 0)!;
  const b = separationPush(pair, 1, dt, 0)!;
  assert.ok(a && b, "both overlapping bodies push");
  assert.ok(a.dx < 0 && b.dx > 0, "pushes point apart along the centre line");
  assert.ok(Math.abs(a.dy) < 1e-9 && Math.abs(b.dy) < 1e-9, "no lateral drift");
  assert.ok(Math.hypot(a.dx, a.dy) <= maxStep + 1e-9, "push is clamped per tick");
  // Comfortable pair → no push at all.
  const far = [
    { x: 100, y: 100, r: 42 },
    { x: 100 + 42 + 42 + MONSTER_SEP_MARGIN + 1, y: 100, r: 42 },
  ];
  assert.equal(separationPush(far, 0, dt, 0), null);
  // EXACTLY stacked pair (the maintainer's two-mammoths-one-spot screenshot):
  // the tieBreak angle splits them deterministically instead of a 0/0 no-op.
  const stacked = [
    { x: 50, y: 50, r: 20 },
    { x: 50, y: 50, r: 20 },
  ];
  const s0 = separationPush(stacked, 0, dt, 0)!; // split along +x
  const s1 = separationPush(stacked, 1, dt, Math.PI)!; // split along -x
  assert.ok(s0 && s1, "stacked pair still separates");
  assert.ok(s0.dx > 0 && s1.dx < 0, "tie-break directions split the pair");
  // Mixed radii: a player body (r=9) inside a mammoth's space still pushes
  // the MONSTER out (the caller only ever moves monsters).
  const mixed = [
    { x: 0, y: 0, r: 42 },
    { x: 40, y: 0, r: PLAYER_BODY_RADIUS },
  ];
  assert.ok(separationPush(mixed, 0, dt, 0), "monster yields to a nearby player");
});

test("monsterDodge: commits to one side against the same blocker (hysteresis)", () => {
  const w = screenToWorldVector(0, 1);
  const wl = Math.hypot(w.x, w.y);
  const m = { id: "blocker", x: (w.x / wl) * 16, y: (w.y / wl) * 16 }; // dead centre ahead
  let state: MonsterDodgeState | undefined;
  const first = monsterDodge(0, 0, 0, 1, [m], state);
  assert.ok(first);
  state = first!.state;
  // Re-decide from slightly wobbled positions — the committed side must hold.
  for (const jitter of [0.4, -0.4, 0.6, -0.6]) {
    const again = monsterDodge(jitter, 0, 0, 1, [m], state);
    assert.ok(again, "still blocking");
    assert.equal(again!.state.side, state!.side, "side commitment holds through wobble");
    state = again!.state;
  }
});
