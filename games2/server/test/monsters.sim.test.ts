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
  levelAtWorld,
  isStandableAtWorld,
  isBlockedAtWorld,
  findSpawn,
  TerrainGrid,
  CELL_WU,
  WALK_CLIMB,
  spawnAreasNear,
  MONSTER_KINDS,
  MONSTER_SPEED_SCALE,
  randomPointInArea,
  clampToArea,
  areaContains,
  randomPauseMs,
  MONSTER_ROAM_PAUSE_MS_MIN,
  MONSTER_ROAM_PAUSE_MS_MAX,
  MONSTER_AREA_INSET,
  type SpawnArea,
} from "@nangijala/shared";

const HERE = dirname(fileURLToPath(import.meta.url)); // games2/server/test
const REPO = join(HERE, "..", "..", ".."); // pixel repo root

interface SimWorld {
  grid: TerrainGrid;
  worldW: number;
  worldH: number;
  spawn: { x: number; y: number };
  areas: SpawnArea[];
}

function loadMaps2World(name: string): SimWorld | null {
  const path = join(REPO, "maps2", "worlds", name, "world.json");
  if (!existsSync(path)) return null;
  const world = parseWorld(JSON.parse(readFileSync(path, "utf8")));
  if (!world) return null;
  const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
  const worldW = world.width * CELL_WU;
  const worldH = world.height * CELL_WU;
  const spawn = world.spawn
    ? { x: world.spawn[0] * CELL_WU, y: world.spawn[1] * CELL_WU }
    : { x: worldW / 2, y: worldH / 2 };
  // Exactly what the server computes at room create.
  const areas = spawnAreasNear(spawn.x, spawn.y, worldW, worldH, (x, y) =>
    isStandableAtWorld(grid, x, y),
  );
  return { grid, worldW, worldH, spawn, areas };
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
// Pure helper unit tests — randomPointInArea / clampToArea / areaContains
// ---------------------------------------------------------------------------

// A concrete area set for the pure-helper tests: what spawnAreasNear lays out on
// open (all-land) ground around a spawn — six non-overlapping rects, one per
// kind, the SAME geometry the server computes per world.
const SAMPLE_AREAS: SpawnArea[] = spawnAreasNear(2000, 2000, 8000, 8000, () => true);

test("randomPointInArea: stays strictly inside the inset bounds", () => {
  const area = SAMPLE_AREAS[0];
  const rng = mulberry32(7);
  const inset = Math.min(
    MONSTER_AREA_INSET,
    (area.x1 - area.x0) / 2,
    (area.y1 - area.y0) / 2,
  );
  for (let i = 0; i < 5000; i++) {
    const p = randomPointInArea(area, rng);
    assert.ok(p.x >= area.x0 + inset - 1e-9 && p.x <= area.x1 - inset + 1e-9, "x inside inset");
    assert.ok(p.y >= area.y0 + inset - 1e-9 && p.y <= area.y1 - inset + 1e-9, "y inside inset");
    assert.ok(areaContains(area, p.x, p.y), "point is inside the AABB");
  }
});

test("randomPointInArea: uses the injected rng edges (min→low, max→high)", () => {
  const area = SAMPLE_AREAS[0];
  const inset = MONSTER_AREA_INSET;
  const low = randomPointInArea(area, () => 0);
  assert.ok(Math.abs(low.x - (area.x0 + inset)) < 1e-9);
  assert.ok(Math.abs(low.y - (area.y0 + inset)) < 1e-9);
  const high = randomPointInArea(area, () => 1 - 1e-12);
  assert.ok(Math.abs(high.x - (area.x1 - inset)) < 1e-6);
  assert.ok(Math.abs(high.y - (area.y1 - inset)) < 1e-6);
});

test("clampToArea: pulls outside points back into the inset rect", () => {
  const area = SAMPLE_AREAS[2];
  const inset = MONSTER_AREA_INSET;
  const c1 = clampToArea(area, area.x0 - 1000, area.y0 - 1000);
  assert.equal(c1.x, area.x0 + inset);
  assert.equal(c1.y, area.y0 + inset);
  const c2 = clampToArea(area, area.x1 + 1000, area.y1 + 1000);
  assert.equal(c2.x, area.x1 - inset);
  assert.equal(c2.y, area.y1 - inset);
  // An interior point is unchanged.
  const mid = { x: (area.x0 + area.x1) / 2, y: (area.y0 + area.y1) / 2 };
  const c3 = clampToArea(area, mid.x, mid.y);
  assert.deepEqual(c3, mid);
});

test("areaContains: AABB edges inclusive, outside excluded", () => {
  const area = SAMPLE_AREAS[0];
  assert.ok(areaContains(area, area.x0, area.y0));
  assert.ok(areaContains(area, area.x1, area.y1));
  assert.ok(!areaContains(area, area.x0 - 0.01, area.y0));
  assert.ok(!areaContains(area, area.x1 + 0.01, area.y1));
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

test("spawnAreasNear: 6 non-overlapping rects, one per monster kind", () => {
  assert.equal(SAMPLE_AREAS.length, 6);
  const kinds = new Set(SAMPLE_AREAS.map((a) => a.kind));
  for (const k of MONSTER_KINDS) assert.ok(kinds.has(k), `area for ${k}`);
  // Non-overlapping AABBs.
  for (let i = 0; i < SAMPLE_AREAS.length; i++) {
    for (let j = i + 1; j < SAMPLE_AREAS.length; j++) {
      const a = SAMPLE_AREAS[i];
      const b = SAMPLE_AREAS[j];
      const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      assert.ok(!overlap, `${a.id} and ${b.id} do not overlap`);
    }
  }
});

// ---------------------------------------------------------------------------
// Headless roam: run ONE monster through the SAME brain+body loop the server
// uses (startTrip / stepAutopilot / stepMovement) for many trips on the REAL
// maps2 worlds, using each world's OWN spawnAreasNear placement (what the server
// computes at room create), and prove a monster never leaves its area and never
// lands on non-standable / water ground. Runs on several worlds incl. demo_lost
// (the client's default pick) — hardcoded single-world coords put monsters
// off-map or in water on the others, the bug this now guards across the board.
// ---------------------------------------------------------------------------

function roamOneMonster(
  w: SimWorld,
  area: SpawnArea,
  seed: number,
  ticks: number,
): { moved: boolean; violations: string[]; trips: number } {
  const { grid, worldW, worldH } = w;
  const rng = mulberry32(seed);
  const ctx = { maxClimb: WALK_CLIMB, canSwim: false };
  const dt = 1 / 20; // 20 Hz tick
  let nowMs = 0;

  // Spawn exactly like seedMonsters: random in-area → findSpawn → clampToArea.
  const p0 = randomPointInArea(area, rng);
  const s0 = findSpawn(grid, p0.x, p0.y);
  const c0 = clampToArea(area, s0.x, s0.y);
  let x = c0.x;
  let y = c0.y;
  let elev = levelAtWorld(grid, x, y);
  let nextMoveAt = nowMs + Math.floor(rng() * 600);
  let trip = null as ReturnType<typeof startTrip>;
  let tripActive = false;

  const startX = x;
  const startY = y;
  const violations: string[] = [];
  let trips = 0;

  const pickTarget = (): { x: number; y: number } => {
    let fallback: { x: number; y: number } | null = null;
    for (let i = 0; i < 6; i++) {
      const raw = randomPointInArea(area, rng);
      const p = clampToArea(area, raw.x, raw.y);
      if (!fallback) fallback = p;
      if (Math.hypot(p.x - x, p.y - y) < CELL_WU) continue;
      if (isStandableAtWorld(grid, p.x, p.y)) return p;
    }
    return fallback ?? clampToArea(area, x, y);
  };

  for (let i = 0; i < ticks; i++) {
    nowMs += dt * 1000;

    if (!tripActive) {
      if (nowMs < nextMoveAt) {
        // paused
      } else {
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
        const c = clampToArea(area, x, y);
        x = c.x;
        y = c.y;
      }
    }

    // Invariants checked EVERY tick.
    if (!areaContains(area, x, y)) {
      violations.push(`tick ${i}: left area at (${x.toFixed(1)},${y.toFixed(1)})`);
    }
    if (!isStandableAtWorld(grid, x, y)) {
      violations.push(`tick ${i}: on non-standable ground at (${x.toFixed(1)},${y.toFixed(1)})`);
    }
    if (surfaceAtWorld(grid, x, y).swimmable) {
      violations.push(`tick ${i}: in water at (${x.toFixed(1)},${y.toFixed(1)})`);
    }
  }

  const moved = Math.hypot(x - startX, y - startY) > 1 || trips > 0;
  return { moved, violations, trips };
}

// Validate the PER-WORLD placement on several maps2 worlds — critically
// demo_lost (the client's default pick) plus ring_test / the_island2 — proving
// spawnAreasNear always lands the 6 areas on standable ground NEAR that world's
// spawn, and a monster roaming there never leaves its area or touches water.
// (Hardcoded single-world coords put monsters off-map / in water on the OTHER
// worlds — the bug this now guards across the board.)
for (const worldName of ["demo_lost", "ring_test", "the_island2"]) {
  test(`headless roam on ${worldName}: 6 areas on land near spawn, monsters stay in-area off-water`, () => {
    const w = loadMaps2World(worldName);
    assert.ok(w, `${worldName} world loads`);
    assert.equal(w!.areas.length, MONSTER_KINDS.length, "one area per monster kind");

    // Every area sits near the spawn (a screenful, not off-map).
    for (const area of w!.areas as SpawnArea[]) {
      const cx = (area.x0 + area.x1) / 2;
      const cy = (area.y0 + area.y1) / 2;
      const cells = Math.hypot(cx - w!.spawn.x, cy - w!.spawn.y) / CELL_WU;
      assert.ok(cells < 40, `${area.id} centre ${cells.toFixed(1)} cells from spawn (near)`);
    }

    for (let ai = 0; ai < w!.areas.length; ai++) {
      const area: SpawnArea = w!.areas[ai];
      // Sanity: the whole inset rect is standable land (no water) to begin with.
      const inset = MONSTER_AREA_INSET;
      for (let gx = area.x0 + inset; gx <= area.x1 - inset; gx += CELL_WU / 2) {
        for (let gy = area.y0 + inset; gy <= area.y1 - inset; gy += CELL_WU / 2) {
          assert.ok(
            isStandableAtWorld(w!.grid, gx, gy) && !surfaceAtWorld(w!.grid, gx, gy).swimmable,
            `${worldName} ${area.id} sample (${gx},${gy}) is standable land`,
          );
          assert.ok(!isBlockedAtWorld(w!.grid, gx, gy), `${worldName} ${area.id} sample not blocked`);
        }
      }

      // Roam three seeds × ~600 ticks (30s sim) each.
      let anyMoved = false;
      for (const seed of [1, 2, 3]) {
        const res = roamOneMonster(w!, area, seed * 100 + ai, 600);
        assert.equal(
          res.violations.length,
          0,
          `${worldName} ${area.id} seed ${seed}: ${res.violations.slice(0, 3).join("; ")}`,
        );
        if (res.moved) anyMoved = true;
      }
      assert.ok(anyMoved, `${worldName} ${area.id}: monster roamed over the window`);
    }
  });
}
