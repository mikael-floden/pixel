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
  makeSideBlocked,
  surfaceAtWorld,
  isBlockedAtWorld,
  screenToWorldVector,
  autoJumpWanted,
  findSpawn,
  stepStamina,
  MAX_STAMINA,
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
  drownings: number;
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
  let stamina = MAX_STAMINA;
  let drownings = 0;
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
      // Swim stamina, exactly like WorldRoom.update: drain in water, recover
      // on land; at 0 you drown and respawn on the nearest land. An autopilot
      // that routes long swims turns trips into drown-teleports — the browser
      // caught this on glow_test before the sim modelled it.
      const st = stepStamina(stamina, surfaceAtWorld(grid, x, y).swimmable, eff);
      stamina = st.stamina;
      if (st.drowned) {
        const spot = findSpawn(grid, x, y);
        x = spot.x;
        y = spot.y;
        stamina = MAX_STAMINA;
        drownings++;
      }
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
      trip = startTrip(grid, x, y, tx, ty, run, now, { swimBudget: stamina });
    }
    if (!trip) continue; // hemmed in — same as the e2e's "no target found, skip"
    drownings = 0;

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
      // walking INTO a 1-level ledge a jump could climb → hop.
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
      drownings,
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
  const totalDrownings = results.reduce((a, r) => a + r.drownings, 0);
  assert.equal(totalDrownings, 0, `${label}: the autopilot drowned the player ${totalDrownings} time(s) — routes must avoid lethal swims`);
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
