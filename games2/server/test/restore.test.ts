// WHERE A SAVED SPOT PUTS YOU BACK (maintainer 2026-09-13, "your engine sent me
// to the top of the mountain"): the surface you left, never a wall's top.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTerrainGrid, restoreSurface, CELL_WU, type TerrainGrid } from "@nangijala/shared";

/* Cave III's notch, as his 208.0,225.5 has it: a level-4 floor under a lid at
 * 24 (underside 9), a rock block at 24 standing in the floor — cols 8..10 of
 * rows 4..11 — and the open mountain top at 24 north of row 4. Col 8's west
 * edge is x = 8.0: floor(8.0) is the rock. */
const W = 16;
const H = 16;
function cave(): TerrainGrid {
  const rows = Array.from({ length: H }, (_, r) =>
    Array.from({ length: W }, (_, c) => ({ t: "grass", l: r < 4 || (r <= 11 && c >= 8 && c <= 10) ? 24 : 4 })),
  );
  const cells: { col: number; row: number }[] = [];
  for (let r = 4; r < H; r++) for (let c = 0; c < W; c++) if (!(r <= 11 && c >= 8 && c <= 10)) cells.push({ col: c, row: r });
  return buildTerrainGrid(W, H, rows, [], [{ level: 24, thickness: 15, cells }]);
}
const wu = (col: number, row: number) => [col * CELL_WU, row * CELL_WU] as const;

test("a spot saved on the floor comes back on the floor; one saved a hair inside the rock beside it comes back on the floor, not on the rock", () => {
  const g = cave();
  const onFloor = restoreSurface(g, ...wu(7.9, 5.5), 4);
  assert.deepEqual(onFloor, { x: 7.9 * CELL_WU, y: 5.5 * CELL_WU, elev: 4 });
  const edge = restoreSurface(g, ...wu(8.0, 5.5), 4);
  assert.ok(edge, "restored somewhere");
  assert.equal(edge.elev, 4, "the floor's level, not the block's 24");
  assert.equal(Math.floor(edge.x / CELL_WU), 7, "the floor cell west of the block");
  assert.equal(Math.floor(edge.y / CELL_WU), 5);
  // Deep in the block: the nearest floor cell, still at the saved level.
  const deep = restoreSurface(g, ...wu(9.5, 5.5), 4);
  assert.ok(deep && deep.elev === 4, `deep in the rock → the floor: ${JSON.stringify(deep)}`);
});

test("a lid-walker saved on the deck stays on it; no saved level means the base under the spot; nothing within three cells means spawn", () => {
  const g = cave();
  assert.deepEqual(restoreSurface(g, ...wu(5.5, 6.5), 24), { x: 5.5 * CELL_WU, y: 6.5 * CELL_WU, elev: 24 });
  assert.deepEqual(restoreSurface(g, ...wu(7.9, 5.5), undefined), { x: 7.9 * CELL_WU, y: 5.5 * CELL_WU, elev: 4 });
  assert.equal(restoreSurface(g, ...wu(5.5, 6.5), -20), null, "a level no surface is a walk from: the caller spawns");
});
