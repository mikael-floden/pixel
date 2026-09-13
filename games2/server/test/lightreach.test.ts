// A LIGHT IS A CANDIDATE WHEN ITS POOL CAN TOUCH THE VIEW (maintainer
// 2026-09-13, the dungeon at day: "spotlight in the distance popping into
// existence ... directly influences lots of my camera view").
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIGHT_POOL_MAX_CELLS, LIGHT_POOL_MARGIN_PX, poolReachPx } from "../../client/src/lightreach";

test("the pool's reach is the iso ellipse the stamp is drawn with, per axis — the old box of R·dx a side was half the width", () => {
  const dx = 32;
  const dy = 14;
  const r16 = poolReachPx(16, dx, dy, LIGHT_POOL_MARGIN_PX);
  assert.ok(Math.abs(r16.x - (16 * Math.SQRT2 * dx + 128)) < 1e-9, `x ${r16.x}`);
  assert.ok(Math.abs(r16.y - (16 * Math.SQRT2 * dy + 128)) < 1e-9, `y ${r16.y}`);
  // The old reach for a 16-cell pool, R·dx + 128: 84 px short of the rim.
  assert.ok(r16.x - (16 * dx + 128) > 80, `the hearth's pool reached ${(r16.x - (16 * dx + 128)).toFixed(0)} px past the old box`);
  // Tall is not wide: the vertical reach is dy's share of the same circle.
  assert.ok(r16.y < r16.x);
  assert.deepEqual(poolReachPx(0, dx, dy), { x: 0, y: 0 });
  assert.deepEqual(poolReachPx(-3, dx, dy, 10), { x: 10, y: 10 }, "a negative radius (a shadow-free pool) is its magnitude's business, never a negative reach");
});

test("LIGHT_POOL_MAX_CELLS covers every light block the scenery domain publishes", (t) => {
  const root = join(process.cwd(), "..", "..", "scenery");
  if (!existsSync(root)) {
    t.skip("no scenery tree (the deploy's sparse checkout)");
    return;
  }
  let largest = 0;
  let seen = 0;
  for (const cat of readdirSync(root, { withFileTypes: true })) {
    if (!cat.isDirectory()) continue;
    for (const piece of readdirSync(join(root, cat.name), { withFileTypes: true })) {
      if (!piece.isDirectory()) continue;
      const f = join(root, cat.name, piece.name, "scenery.json");
      if (!existsSync(f)) continue;
      let doc: { light?: { strength?: number; radius?: number } };
      try {
        doc = JSON.parse(readFileSync(f, "utf8"));
      } catch {
        continue;
      }
      const l = doc.light;
      if (l && typeof l.radius === "number" && (l.strength ?? 0) > 0) {
        seen++;
        largest = Math.max(largest, l.radius);
      }
    }
  }
  assert.ok(seen > 0, "some lit pieces were read");
  assert.ok(largest <= LIGHT_POOL_MAX_CELLS, `a published radius of ${largest} exceeds LIGHT_POOL_MAX_CELLS ${LIGHT_POOL_MAX_CELLS} — raise the bound`);
});
