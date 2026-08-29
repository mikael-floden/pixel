import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseWorld, buildTerrainGrid, deepCurrentAt, surfaceFor,
  CELL_WU, WALK_SPEED, RUN_SPEED,
  DEEP_CURRENT_MAX, DEEP_CURRENT_RAMP_CELLS, DEEP_WATER_GROUND,
} from "@nangijala/shared";

// DEEP WATER IS THE END OF THE WORLD, and it must bound the map WITHOUT ever
// refusing a move — a wall reads as a bug, a current reads as weather
// (maintainer 2026-08-29).
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const W = join(REPO, "maps2/worlds3/the_game/world.json");
const skip = !existsSync(W);

test("the current outruns the strongest stroke, so the far sea is unreachable", { skip }, () => {
  const world = parseWorld(JSON.parse(readFileSync(W, "utf8")));
  assert.ok(world);
  const grid = buildTerrainGrid(world!.width, world!.height, world!.rows, world!.props, world!.decks);

  const swimRun = RUN_SPEED * surfaceFor(DEEP_WATER_GROUND).speed;
  assert.ok(DEEP_CURRENT_MAX > swimRun, `current ${DEEP_CURRENT_MAX} must beat a running swim ${swimRun}`);

  // Walk every cell once: land and shallows must be free, and deep cells must
  // ramp from nothing at the shore to full strength further out.
  let deep = 0, free = 0, full = 0, onLand = 0;
  for (let r = 0; r < grid.height; r++) {
    for (let c = 0; c < grid.width; c++) {
      const x = (c + 0.5) * CELL_WU;
      const y = (r + 0.5) * CELL_WU;
      const cur = deepCurrentAt(grid, x, y);
      if (grid.type[r * grid.width + c] !== DEEP_WATER_GROUND) {
        if (cur) onLand++;
        continue;
      }
      deep++;
      if (!cur) free++;
      else {
        assert.ok(cur.speed > 0 && cur.speed <= DEEP_CURRENT_MAX + 1e-6, `speed ${cur.speed}`);
        assert.ok(Math.abs(Math.hypot(cur.dx, cur.dy) - 1) < 1e-9, "direction must be a unit vector");
        if (cur.speed >= DEEP_CURRENT_MAX - 1e-6) full++;
      }
    }
  }
  assert.equal(onLand, 0, `${onLand} land/shallow cells carried a current`);
  assert.ok(deep > 1000, `the world must actually have open sea (deep cells ${deep})`);
  assert.ok(free > 0, "the shoreline must stay swimmable");
  assert.ok(full > 0, "the far sea must reach full strength");
  console.log(`      deep cells ${deep}: ${free} free shallows, ${full} at full strength`);
});

test("the current pushes TOWARD the map centre, from every side", { skip }, () => {
  const world = parseWorld(JSON.parse(readFileSync(W, "utf8")));
  const grid = buildTerrainGrid(world!.width, world!.height, world!.rows, world!.props, world!.decks);
  const cx = (grid.width * CELL_WU) / 2;
  const cy = (grid.height * CELL_WU) / 2;
  let checked = 0;
  for (let r = 0; r < grid.height; r += 7) {
    for (let c = 0; c < grid.width; c += 7) {
      const x = (c + 0.5) * CELL_WU;
      const y = (r + 0.5) * CELL_WU;
      const cur = deepCurrentAt(grid, x, y);
      if (!cur) continue;
      // moving along the current must strictly reduce the distance to centre
      const before = Math.hypot(cx - x, cy - y);
      const after = Math.hypot(cx - (x + cur.dx), cy - (y + cur.dy));
      assert.ok(after < before, `at ${c},${r} the current did not point inward`);
      checked++;
    }
  }
  assert.ok(checked > 50, `too few sampled deep cells (${checked})`);
});
