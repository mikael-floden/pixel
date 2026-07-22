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
  unstickFromSolids,
  makeBlocked,
  makeBlockedElev,
  makeSideBlocked,
  surfaceAtWorld,
  resolveElevAt,
  levelAtWorld,
  isBlockedAtWorld,
  screenToWorldVector,
  autoJumpWanted,
  findSpawn,
  findPath,
  TerrainGrid,
  CELL_WU,
  WALK_CLIMB,
  JUMP_CLIMB,
  JUMP_MS,
  JUMP_COOLDOWN_MS,
  JUMP_SPEED_FACTOR,
  MAX_INPUT_DT,
} from "@nangijala/shared";

// ---------------------------------------------------------------------------
// Headless trip simulator: the SAME brain (shared startTrip/stepAutopilot) and
// the SAME body (server integration: unstick + stepMovement + auto-jump model)
// walking real worlds at ~1000x real time. This is the navigation regression
// gate — a browser run (scripts/verify-longwalk.mjs) only re-proves the glue.
// Frame cadence is a PARAMETER: the worst historical bugs (the big-dt freeze,
// the run-speed waypoint orbit) only appear at laggy-phone frame times, which
// real-time browser tests reproduce slowly and flakily but this reproduces
// deterministically.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url)); // games2/server/test
const REPO = join(HERE, "..", "..", ".."); // pixel repo root

interface SimWorld {
  grid: TerrainGrid;
  worldW: number;
  worldH: number;
}

function loadMaps2World(name: string): SimWorld | null {
  const path = join(REPO, "maps2", "worlds", name, "world.json");
  if (!existsSync(path)) return null;
  const world = parseWorld(JSON.parse(readFileSync(path, "utf8")));
  if (!world) return null;
  return {
    grid: buildTerrainGrid(world.width, world.height, world.rows, world.props),
    worldW: world.width * CELL_WU,
    worldH: world.height * CELL_WU,
  };
}

/** Deterministic LCG — same recipe as the e2e scripts. */
function makeRand(seed: number): () => number {
  let rng = seed;
  return () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

interface TripResult {
  arrived: boolean;
  simSeconds: number;
  endDist: number;
  at: { x: number; y: number };
  target: { x: number; y: number };
  run: boolean;
}

/**
 * Simulate seeded random trips exactly like verify-longwalk.mjs, but in pure
 * math. `frameMs` is the autopilot/input cadence (16 = healthy 60fps phone,
 * 133 ≈ struggling phone, 400 ≈ throttled tab); integration is chunked to
 * MAX_INPUT_DT like the server does with real input packets.
 */
function simTrips(
  w: SimWorld,
  opts: { seed: number; trips: number; frameMs: number },
): TripResult[] {
  const rand = makeRand(opts.seed);
  const { grid, worldW, worldH } = w;
  const spawn = findSpawn(grid, worldW / 2, worldH / 2);
  let x = spawn.x;
  let y = spawn.y;
  let now = 0; // simulated ms
  let jumpUntil = -Infinity;
  let jumpReadyAt = 0;
  const results: TripResult[] = [];

  const integrate = (ax: number, ay: number, running: boolean, dtMs: number) => {
    let left = dtMs / 1000;
    while (left > 1e-9) {
      const eff = Math.min(left, MAX_INPUT_DT);
      left -= eff;
      const jumping = now < jumpUntil;
      const u = unstickFromSolids(grid, x, y, 80 * eff);
      x = u.x;
      y = u.y;
      const surf = surfaceAtWorld(grid, x, y);
      const ctx = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
      const r = stepMovement(
        x, y, ax, ay, running, eff,
        makeBlocked(grid, ctx),
        surf.speed * (jumping ? JUMP_SPEED_FACTOR : 1),
        true, // screen-relative input, like the real client
        worldW, worldH,
        makeSideBlocked(grid, ctx),
      );
      x = r.x;
      y = r.y;
      // Swimming is free now — no stamina drain, no drowning. Water is just
      // slower terrain; the autopilot routes through it freely.
    }
  };

  for (let i = 0; i < opts.trips; i++) {
    // Pick a reachable-looking target 15-35 cells away (same filter the e2e
    // and a real tap use: not a solid, standable or swimmable ground).
    let trip = null;
    let run = false;
    for (let tries = 0; tries < 30 && !trip; tries++) {
      const ang = rand() * Math.PI * 2;
      const d = (15 + rand() * 20) * CELL_WU;
      const tx = x + Math.cos(ang) * d;
      const ty = y + Math.sin(ang) * d;
      if (tx < 0 || ty < 0 || tx >= worldW || ty >= worldH) continue;
      if (isBlockedAtWorld(grid, tx, ty)) continue;
      const s = surfaceAtWorld(grid, tx, ty);
      if (!s.standable && !s.swimmable) continue;
      run = rand() > 0.5;
      trip = startTrip(grid, x, y, tx, ty, run, now);
    }
    if (!trip) continue; // hemmed in — same as the e2e's "no target found, skip"

    const budgetMs = 120_000; // simulated: any healthy trip is far shorter
    const t0 = now;
    let arrived = false;
    while (now - t0 < budgetMs) {
      const drive = stepAutopilot(grid, trip, x, y, now, worldW, worldH);
      if (drive.done) {
        arrived = true;
        break;
      }
      // Auto-jump mirror (WorldScene.maybeAutoJump): grounded + off cooldown,
      // walking INTO a 2-level ledge a jump could climb → hop.
      if ((drive.ax !== 0 || drive.ay !== 0) && now >= jumpUntil && now >= jumpReadyAt) {
        const wv = screenToWorldVector(drive.ax, drive.ay);
        if (autoJumpWanted(grid, x, y, wv.x, wv.y)) {
          jumpUntil = now + JUMP_MS;
          jumpReadyAt = jumpUntil + JUMP_COOLDOWN_MS;
        }
      }
      integrate(drive.ax, drive.ay, drive.running, opts.frameMs);
      now += opts.frameMs;
    }
    results.push({
      arrived,
      simSeconds: (now - t0) / 1000,
      endDist: Math.hypot(trip.target.x - x, trip.target.y - y),
      at: { x, y },
      target: { x: trip.target.x, y: trip.target.y },
      run,
    });
    now += 500; // settle between trips, like a player pausing
  }
  return results;
}

function assertAllArrive(results: TripResult[], label: string) {
  assert.ok(results.length >= 1, `${label}: at least one trip ran`);
  const fails = results.filter((r) => !(r.arrived && r.endDist < 40));
  const detail = fails
    .map((f) => `at (${f.at.x.toFixed(0)},${f.at.y.toFixed(0)}) target (${f.target.x.toFixed(0)},${f.target.y.toFixed(0)}) endDist=${f.endDist.toFixed(0)}wu run=${f.run} ${f.simSeconds.toFixed(1)}s`)
    .join("; ");
  assert.equal(fails.length, 0, `${label}: ${fails.length}/${results.length} trips failed — ${detail}`);
}

// Frame cadences: healthy phone, struggling phone, throttled tab. The 133ms+
// rows are the regression net for the big-dt freeze and the waypoint orbit.
for (const frameMs of [16, 133, 400]) {
  test(`sim: prop_demo trips arrive (frame ${frameMs}ms, 3 seeds)`, (t) => {
    const w = loadMaps2World("prop_demo");
    if (!w) return t.skip("maps2/worlds/prop_demo missing");
    for (const seed of [5, 21, 99]) {
      assertAllArrive(simTrips(w, { seed, trips: 12, frameMs }), `prop_demo seed=${seed} frame=${frameMs}`);
    }
  });
}

// glow_test: maps2's emissive showcase (dense props + elevation) — the
// successor of the retired tiles/ emission-demo station.
for (const frameMs of [16, 133]) {
  test(`sim: glow_test trips arrive (frame ${frameMs}ms, 2 seeds)`, (t) => {
    const w = loadMaps2World("glow_test");
    if (!w) return t.skip("maps2/worlds/glow_test missing");
    for (const seed of [5, 21]) {
      assertAllArrive(simTrips(w, { seed, trips: 10, frameMs }), `glow_test seed=${seed} frame=${frameMs}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Corner-cut fall gate (world@2 decks): tapping the top of a raised bridge/roof
// from the ground below must route the body UP the staircase and ONTO the deck
// — never let it cut a diagonal corner across the cliff beside the stairs and
// FALL into the gap under the bridge (maintainer: "the character doesn't
// respect sharp corners... tries to shortcut and falls"). The planned route no
// longer allows a diagonal whose destination OR flank drops >1 level, so the
// body follows a safe cardinal climb. This drives the REAL follower + body
// (unstick + stepMovement + resolveElevAt + auto-jump) tracking the surface
// ELEVATION every tick — the fall is `elev` collapsing to the base. All start
// cells + the deck are DERIVED from the world so the maps agent can reshape the
// bridge without editing this gate.
// ---------------------------------------------------------------------------

interface DeckClimbResult {
  arrived: boolean;
  endElev: number;
  fell: boolean; // dropped to the base gap AFTER starting the climb
  endDist: number;
  from: { c: number; r: number };
}

/** Drive one deck-aware trip from (fromX,fromY) onto the deck at `goalLevel`,
 *  tracking the surface elevation the SERVER would resolve each tick. `fell` =
 *  after climbing above L-2, the elevation ever collapsed back near the base. */
function simDeckClimb(
  grid: TerrainGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  goalLevel: number,
  frameMs: number,
): DeckClimbResult {
  const worldW = grid.width * CELL_WU;
  const worldH = grid.height * CELL_WU;
  let x = fromX;
  let y = fromY;
  let elev = levelAtWorld(grid, x, y);
  let now = 0;
  let jumpUntil = -Infinity;
  let jumpReadyAt = 0;
  const trip = startTrip(grid, x, y, toX, toY, true, now, elev, goalLevel);
  if (!trip) return { arrived: false, endElev: elev, fell: false, endDist: Infinity, from: { c: Math.floor(fromX / CELL_WU), r: Math.floor(fromY / CELL_WU) } };
  const climbTo = goalLevel - 2; // "has committed to the climb" threshold
  const fallFloor = 1.5; // elevation this low after climbing = fell into the gap
  let maxElev = elev;
  let fell = false;
  const integrate = (ax: number, ay: number, running: boolean, dtMs: number) => {
    let left = dtMs / 1000;
    while (left > 1e-9) {
      const eff = Math.min(left, MAX_INPUT_DT);
      left -= eff;
      const jumping = now < jumpUntil;
      const u = unstickFromSolids(grid, x, y, 80 * eff);
      x = u.x;
      y = u.y;
      const surf = surfaceAtWorld(grid, x, y);
      const ctx = { maxClimb: jumping ? JUMP_CLIMB : WALK_CLIMB, canSwim: true };
      const r = stepMovement(
        x, y, ax, ay, running, eff,
        makeBlockedElev(grid, ctx, () => elev),
        surf.speed * (jumping ? JUMP_SPEED_FACTOR : 1),
        true, worldW, worldH,
        makeSideBlocked(grid, ctx),
      );
      x = r.x;
      y = r.y;
      elev = resolveElevAt(grid, elev, x, y, ctx);
      maxElev = Math.max(maxElev, elev);
      if (maxElev >= climbTo && elev <= fallFloor) fell = true;
    }
  };
  const budget = 60_000;
  const t0 = now;
  let arrived = false;
  while (now - t0 < budget) {
    const drive = stepAutopilot(grid, trip, x, y, now, worldW, worldH, elev);
    if (drive.done) {
      arrived = true;
      break;
    }
    if ((drive.ax !== 0 || drive.ay !== 0) && now >= jumpUntil && now >= jumpReadyAt) {
      const wv = screenToWorldVector(drive.ax, drive.ay);
      if (autoJumpWanted(grid, x, y, wv.x, wv.y)) {
        jumpUntil = now + JUMP_MS;
        jumpReadyAt = jumpUntil + JUMP_COOLDOWN_MS;
      }
    }
    integrate(drive.ax, drive.ay, drive.running, frameMs);
    now += frameMs;
  }
  return {
    arrived,
    endElev: elev,
    fell,
    endDist: Math.hypot(trip.target.x - x, trip.target.y - y),
    from: { c: Math.floor(fromX / CELL_WU), r: Math.floor(fromY / CELL_WU) },
  };
}

/** Derive from a world: the highest deck's level, an interior goal cell (a deck
 *  cell floating over a lower base — the span, not a wall you step on from), and
 *  ground approach cells low enough to have climbed up (base ≤ 1) from which
 *  findPath actually climbs onto the deck. Returns null if the world has no such
 *  deck+approach (skip). */
function deckClimbSetup(grid: TerrainGrid, decks: { level: number; cells: { col?: number; row?: number; x?: number; y?: number }[] }[]) {
  const W = grid.width;
  const idx = (c: number, r: number) => r * W + c;
  const baseLvl = (c: number, r: number) => grid.level[idx(c, r)];
  const deckLvl = (c: number, r: number) => grid.deck[idx(c, r)];
  const wc = (c: number, r: number): [number, number] => [(c + 0.5) * CELL_WU, (r + 0.5) * CELL_WU];
  // Highest deck = the airborne bridge over the gap.
  let best: { level: number; cells: { c: number; r: number }[] } | null = null;
  for (const d of decks) {
    const cells = d.cells.map((c) => ({ c: (c.col ?? c.x)!, r: (c.row ?? c.y)! }));
    if (!best || d.level > best.level) best = { level: d.level, cells };
  }
  if (!best) return null;
  const L = best.level;
  const interior = best.cells.filter(({ c, r }) => deckLvl(c, r) >= 0);
  if (!interior.length) return null;
  // Goal: the interior cell NEAREST the deck's high entry edge (max base among
  // the footprint) — that's where the reported corner-cut happened, next to the
  // stairs. Fall back to the footprint centroid if there is no clear edge.
  const cen = best.cells.reduce((a, p) => ({ c: a.c + p.c / best!.cells.length, r: a.r + p.r / best!.cells.length }), { c: 0, r: 0 });
  interior.sort((a, b) => Math.hypot(a.c - cen.c, a.r - cen.r) - Math.hypot(b.c - cen.c, b.r - cen.r));
  const goal = interior[0];
  const [gx, gy] = wc(goal.c, goal.r);
  // Approach starts: low ground (base ≤ 1, walkable, not on a deck) within 16
  // cells of the goal, from which findPath climbs onto the deck (route reaches
  // ≥ L-WALK_CLIMB). Take the nearest handful — the different angles include the
  // corner-cutting diagonal approach that used to fall.
  const cand: { c: number; r: number; d: number }[] = [];
  let minC = W, maxC = 0, minR = grid.height, maxR = 0;
  for (const p of best.cells) { minC = Math.min(minC, p.c); maxC = Math.max(maxC, p.c); minR = Math.min(minR, p.r); maxR = Math.max(maxR, p.r); }
  for (let r = Math.max(1, minR - 16); r <= Math.min(grid.height - 2, maxR + 16); r++)
    for (let c = Math.max(1, minC - 16); c <= Math.min(W - 2, maxC + 16); c++) {
      if (deckLvl(c, r) >= 0 || grid.blocked[idx(c, r)] || baseLvl(c, r) > 1) continue;
      cand.push({ c, r, d: Math.hypot(c - goal.c, r - goal.r) });
    }
  cand.sort((a, b) => a.d - b.d);
  const starts: { c: number; r: number }[] = [];
  for (const s of cand) {
    if (starts.length >= 6) break;
    const [sx, sy] = wc(s.c, s.r);
    const path = findPath(grid, sx, sy, gx, gy, { canSwim: true, fromElev: 0, goalLevel: L });
    if (!path || path.length < 5) continue;
    const climbs = path.some((wp) => baseLvl(Math.floor(wp.x / CELL_WU), Math.floor(wp.y / CELL_WU)) >= L - WALK_CLIMB - 1e-9);
    if (climbs) starts.push({ c: s.c, r: s.r });
  }
  return starts.length ? { L, goal, gx, gy, starts } : null;
}

for (const frameMs of [16, 33, 133]) {
  test(`sim: occlusion_test climb onto bridge without falling (frame ${frameMs}ms)`, (t) => {
    const path = join(REPO, "maps2", "worlds", "occlusion_test", "world.json");
    if (!existsSync(path)) return t.skip("maps2/worlds/occlusion_test missing");
    const world = parseWorld(JSON.parse(readFileSync(path, "utf8")));
    if (!world) return t.skip("occlusion_test failed to parse");
    const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
    const setup = deckClimbSetup(grid, (world.decks ?? []) as any);
    if (!setup) return t.skip("occlusion_test has no deck+ground-approach to climb");
    const fails: string[] = [];
    for (const s of setup.starts) {
      const [sx, sy] = [(s.c + 0.5) * CELL_WU, (s.r + 0.5) * CELL_WU];
      const res = simDeckClimb(grid, sx, sy, setup.gx, setup.gy, setup.L, frameMs);
      const ok = res.arrived && !res.fell && res.endElev >= setup.L - 0.5 && res.endDist < 40;
      if (!ok)
        fails.push(
          `from (${s.c},${s.r}) -> deck (${setup.goal.c},${setup.goal.r})@${setup.L}: arrived=${res.arrived} fell=${res.fell} endElev=${res.endElev.toFixed(1)} endDist=${res.endDist.toFixed(0)}`,
        );
    }
    assert.equal(fails.length, 0, `${setup.starts.length} bridge approaches, ${fails.length} fell/failed — ${fails.join("; ")}`);
  });
}
