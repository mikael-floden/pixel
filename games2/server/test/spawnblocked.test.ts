import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseWorld,
  buildTerrainGrid,
  stampSceneryCollision,
  findSpawn,
  ISO_GEOMETRY_MAPS3,
  CELL_WU,
  type SceneryBboxDoc,
  type SceneryHitboxDoc,
} from "@nangijala/shared";

// A REVIVING PLAYER MUST NEVER LAND INSIDE A TREE. `findSpawn` asked only
// whether the ground TYPE was standable, so scenery collision — which blocks
// thousands of perfectly standable grass cells — could drop a body in a trunk
// with no way out (maintainer 2026-08-29: "after dying I spawned like this and
// was stuck"). The world is the real one because the bug is a real map's.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const rel = (p: string) => join(REPO, p);
const NEEDS = [
  "maps2/worlds3/the_game/world.json",
  "games2/config/scenery-bbox.json",
  "live/tuning/scenery_hitbox.json",
];
const skip = NEEDS.some((p) => !existsSync(rel(p)));
const load = (p: string): any => JSON.parse(readFileSync(rel(p), "utf8"));

test("findSpawn never returns a cell scenery has blocked", { skip }, () => {
  const world = parseWorld(load("maps2/worlds3/the_game/world.json"));
  assert.ok(world, "the_game must parse");
  const grid = buildTerrainGrid(world!.width, world!.height, world!.rows, world!.props, world!.decks);
  const n = stampSceneryCollision(
    grid,
    world!.scenery ?? [],
    load("games2/config/scenery-bbox.json") as SceneryBboxDoc,
    (load("live/tuning/scenery_hitbox.json").overrides ?? {}) as SceneryHitboxDoc,
    ISO_GEOMETRY_MAPS3,
  );
  assert.ok(n > 500, `scenery must actually block something (blocked ${n}) or this gate is vacuous`);

  // The real respawn draw: placeAtSpawn jitters +-120 world units around the
  // world spawn and hands that to findSpawn.
  const [sx, sy] = world!.spawn ?? [world!.width / 2, world!.height / 2];
  const cx = sx * CELL_WU;
  const cy = sy * CELL_WU;
  let landedBlocked = 0;
  for (let i = 0; i < 4000; i++) {
    const jx = cx + ((i * 2654435761) % 241) - 120;
    const jy = cy + ((i * 40503) % 241) - 120;
    const s = findSpawn(grid, jx, jy);
    const c = Math.floor(s.x / CELL_WU);
    const r = Math.floor(s.y / CELL_WU);
    if (grid.blocked[r * grid.width + c]) landedBlocked++;
  }
  assert.equal(landedBlocked, 0, `${landedBlocked} of 4000 respawns landed inside a blocked cell`);
});
