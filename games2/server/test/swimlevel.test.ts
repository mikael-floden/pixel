// ============================================================================
// WATER LIES FLAT, THE BODY'S HALF — the swim verdict of a corner one storey down
// ============================================================================
//
// The ground under a point is its nearest CORNER's, not its cell's, so a player
// standing in the water quadrant of a beach cell swims and one in the beach
// quadrant of a water cell stands (maintainer 2026-09-09: "The player must use
// this boundary to know where it has to swim and where it can stand"). The fold
// let any corner within one storey vote — and a sea one storey below is still
// within one storey, so the quadrant of a shore STEP nearest the water read as
// water and the body swam a level above the sea: "Why do I swim one stair up?"
// (maintainer 2026-09-11 at 277.6, 269.5 on the_game; relayed by maps2).
//
// A LIQUID corner now votes only at the cell's own level — the twin of the rule
// tiles3 `boundaryAt` got the same day, which is why it matters: that tile draws
// no water at all now, so a body swimming on it contradicts the picture. A LAND
// corner keeps the one-storey vote: the beach quadrant of a water cell is still
// standable, and that shore tile is still drawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTerrainGrid, surfaceAtWorld, surfaceFor, parseWorld, CELL_WU } from "@nangijala/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD = join(HERE, "..", "..", "..", "maps2", "worlds3", "the_game", "world.json");

/** A 3x3 world: the east column is water at `seaLevel`, the rest land at `landLevel`. */
function shore(landLevel: number, seaLevel: number) {
  const rows = Array.from({ length: 3 }, (_, r) =>
    Array.from({ length: 3 }, (_, c) => (c === 2 ? { t: "water", l: seaLevel } : { t: "dark_mud", l: landLevel })),
  );
  return buildTerrainGrid(3, 3, rows);
}
/** The point inside cell (c,r) nearest its (c+1, r) corner — the quadrant the fold answers for. */
const eastQuadrant = (c: number, r: number): [number, number] => [(c + 0.75) * CELL_WU, (r + 0.5) * CELL_WU];

test("a land cell one storey above the sea does not swim in its water quadrant", () => {
  // His case: land at level 1, water at 0. The quadrant nearest the water is
  // land — you are standing on the step, and the step's tile draws no water.
  const step = shore(1, 0);
  const [x, y] = eastQuadrant(1, 1);
  const s = surfaceAtWorld(step, x, y);
  assert.equal(s.swimmable, false, "the quadrant still swims one storey above the sea");
  assert.equal(s.standable, true);
  assert.equal(s.speed, surfaceFor("dark_mud").speed, "and it is the cell's own ground, so its own speed");
  // A sea one storey ABOVE the land folds the same way: the rule is the cell's
  // own level, not "below it".
  const under = shore(0, 1);
  assert.equal(surfaceAtWorld(under, ...eastQuadrant(1, 1)).swimmable, false);
});

test("at the water's own level the boundary still decides where you swim", () => {
  // The 2026-09-09 rule, unchanged: same level, the quadrant nearest the water
  // swims even though the cell is beach.
  const flat = shore(0, 0);
  assert.equal(surfaceAtWorld(flat, ...eastQuadrant(1, 1)).swimmable, true, "the shore quadrant must still swim");
  // ...and the cell centre is always the cell's own ground.
  assert.equal(surfaceAtWorld(flat, 1.5 * CELL_WU, 1.5 * CELL_WU).standable, true);
});

test("a LAND corner one storey up still votes, so the sea keeps its standable beach quadrant", () => {
  // The mirror world: the WEST column is water, the rest is land one storey up.
  // The quadrant of the water cell (0,1) nearest its east corner (1,1) is the
  // land's — the shore tile drawn from the water's side, and the rule the fold
  // exists for. Only a LIQUID corner is refused off-level.
  const rows = Array.from({ length: 3 }, (_, r) =>
    Array.from({ length: 3 }, (_, c) => (c === 0 ? { t: "water", l: 0 } : { t: "dark_mud", l: 1 })),
  );
  const grid = buildTerrainGrid(3, 3, rows);
  const s = surfaceAtWorld(grid, 0.75 * CELL_WU, 1.5 * CELL_WU);
  assert.equal(s.standable, true, "a land corner one storey up must still vote on a water cell");
  assert.equal(s.swimmable, false);
  // Two storeys up is beyond the fold for land as well.
  const far = buildTerrainGrid(3, 3, Array.from({ length: 3 }, (_, r) =>
    Array.from({ length: 3 }, (_, c) => (c === 0 ? { t: "water", l: 0 } : { t: "dark_mud", l: 2 })),
  ));
  assert.equal(surfaceAtWorld(far, 0.75 * CELL_WU, 1.5 * CELL_WU).swimmable, true, "a land corner two storeys up must not vote");
});

test("on the_game, no land cell swims off a liquid corner that stands off its level", { skip: !existsSync(WORLD) }, () => {
  const parsed: any = parseWorld(JSON.parse(readFileSync(WORLD, "utf8")));
  assert.ok(parsed, "the_game must parse");
  const grid = buildTerrainGrid(parsed.width, parsed.height, parsed.rows, parsed.props ?? [], parsed.decks ?? []);
  // HIS OWN SPOT, to the coordinate he stood on.
  const his = surfaceAtWorld(grid, 277.6 * CELL_WU, 269.5 * CELL_WU);
  assert.equal(his.swimmable, false, "277.6,269.5 still swims — the shore step he photographed");
  assert.equal(his.standable, true);
  // ...and every other quadrant of the same shape.
  let steps = 0;
  let swimming = 0;
  let shoreAtLevel = 0;
  for (let r = 0; r < grid.height - 1; r++)
    for (let c = 0; c < grid.width - 1; c++) {
      const i = r * grid.width + c;
      const t = grid.type[i];
      if (!t || surfaceFor(t).swimmable) continue;
      for (const [dc, dr] of [[1, 0], [0, 1], [1, 1]] as const) {
        const j = (r + dr) * grid.width + (c + dc);
        const tj = grid.type[j];
        if (!tj || !surfaceFor(tj).swimmable) continue;
        const dz = Math.abs(grid.level[j] - grid.level[i]);
        if (dz > 1) continue;
        const x = (c + (dc ? 0.75 : 0.25)) * CELL_WU;
        const y = (r + (dr ? 0.75 : 0.25)) * CELL_WU;
        const swims = surfaceAtWorld(grid, x, y).swimmable;
        if (dz === 1) {
          steps++;
          if (swims) swimming++;
        } else if (swims) shoreAtLevel++;
      }
    }
  assert.ok(steps >= 9, `the_game has ${steps} shore-step quadrants — maps2 counted 8 cells, the gate cannot see the bug it exists for`);
  assert.equal(swimming, 0, `${swimming} of ${steps} shore-step quadrants still swim above the sea`);
  assert.ok(shoreAtLevel > 0, "no quadrant swims at the water's own level — the corner rule itself is gone");
  console.log(`    the_game: ${steps} shore-step quadrants, none swimming; ${shoreAtLevel} quadrants still swim at the water's own level`);
});
