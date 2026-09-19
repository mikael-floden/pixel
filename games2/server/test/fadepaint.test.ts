// ============================================================================
// FADE PAINT — the pick weighs what a tile PAINTS, and a road keeps its grass
// on the edge cell
// ============================================================================
//
// The maintainer, once the area numbers were honest (2026-09-19): "mostly use
// the tiles with less than 10% grass when placing grass on sand. The tiles
// close to 50/50 should be used much much less. And when they do occur you must
// know you have to place 5x 10% grass to get the same amount of grass." And:
// "It looks really dumb when we have a big chunk of grass in the middle of the
// road. If people walk here grass can't grow here!"
//
// Measured over the_game at his dials before this rule: every ring-1 cell
// TARGETED the densest tile in its pool (mean area 45.6%, 61% of edge fades at
// 40% or more, not one under 10%), and 30 of the 89 grass fades on roads sat on
// the middle cell of a 3-wide road. The unit half below is exact arithmetic on
// `fadePick`; the world half is the census at his dials, skipped (not failed)
// where the sparse deploy checkout has no tiles/ or maps2/worlds3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3, fadePick, viewFromDoc, TRODDEN, GROWS, FADE_TUNE_GAME, type FadePoolTile } from "../../client/src/tiles3";
import { TILES3_DOCS, tiles3DataFrom } from "../../client/src/tiles3runtime";
import { ISO_GEOMETRY_MAPS3 } from "../../shared/src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const WORLD = "maps2/worlds3/the_game/world.json";
const MISSING = [WORLD, ...Object.values(TILES3_DOCS)]
  .filter((p) => p !== "live/tuning/tile_details.json")
  .map((p) => join(REPO, p))
  .filter((p) => !existsSync(p));

/* A synthetic pool in area order, unrated, so the weight is the area rule alone. */
const POOL: FadePoolTile[] = [2, 5, 10, 20, 50].map((area, i) => ({ file: `t${area}`, key: `k${i}`, area, rating: 0, tier: 1 }));
/** Pick frequencies over a fine, deterministic sweep of the draw. */
function sweep(pos: number, falloff: number, paint: boolean, n = 100000): number[] {
  const counts = POOL.map(() => 0);
  for (let i = 0; i < n; i++) counts[fadePick(POOL, pos, falloff, (i + 0.5) / n, paint)]++;
  return counts;
}

test("the 5x law: at the edge a 10% tile is picked five times as often as a 50% one", () => {
  const c = sweep(1, 4, true);
  const [a2, a5, a10, a20, a50] = c;
  // 1/area, normalised: the sparsest tile is the mode, the 50/50 chunk the rarest.
  assert.ok(a2 > a5 && a5 > a10 && a10 > a20 && a20 > a50, `frequencies must fall with area: ${c}`);
  assert.ok(Math.abs(a10 / a50 - 5) < 0.02, `10% : 50% should be 5 : 1, got ${(a10 / a50).toFixed(3)}`);
  assert.ok(Math.abs(a2 / a50 - 25) < 0.1, `2% : 50% should be 25 : 1, got ${(a2 / a50).toFixed(3)}`);
  // ...which is exactly "you have to place 5x 10% grass to get the same amount":
  // every tile paints the same expected area.
  assert.ok(Math.abs(a10 * 10 - a50 * 50) / (a50 * 50) < 0.01, "equal paint per tile");
});

test("render3's picture is the one he ruled out: the edge targets the densest tile", () => {
  // Kept, because the parity fixture pins it and the game never sets it.
  const c = sweep(1, 4, false);
  assert.equal(c[4], 100000, `paint off: every ring-1 pick is the 50% tile, got ${c}`);
});

test("the far end of the band never wears a dense tile, and the ceiling is the falloff's", () => {
  // pos = 1/reach at the far ring; with falloff 4 the ceiling sits on the sparsest tile.
  const c = sweep(0.25, 4, true);
  assert.equal(c[4], 0, `a 50% tile past the ceiling and its half-span shoulder: ${c}`);
  assert.ok(c[0] > c[1] && c[1] > c[2] && c[2] > c[3], `sparsest first at the far end: ${c}`);
  // falloff 1 (the resolver's constant) lifts the far ceiling to areaMin + span/4:
  // the 20% tile is inside the shoulder now, the 50% one still is not.
  const d = sweep(0.25, 1, true);
  assert.equal(d[4], 0, `50% still over the shoulder at falloff 1: ${d}`);
  assert.ok(d[3] > c[3], "a gentler falloff lets denser tiles further out");
});

test("a sub-1% tile (tier 2 waives the floor) does not swallow the pick", () => {
  const tiny: FadePoolTile[] = [{ file: "t0", key: "k", area: 0.2, rating: 0, tier: 2 }, ...POOL.map((p) => ({ ...p, tier: 2 as const }))];
  const counts = tiny.map(() => 0);
  for (let i = 0; i < 10000; i++) counts[fadePick(tiny, 1, 4, (i + 0.5) / 10000, true)]++;
  // Clamped to 1/max(1, area): the 0.2% tile weighs exactly what a 1% tile
  // would — twice the 2% tile, never the ten times that 1/0.2 would give it.
  assert.ok(Math.abs(counts[0] / counts[1] - 2) < 0.02, `0.2% : 2% is 2 : 1 under the clamp, got ${(counts[0] / counts[1]).toFixed(3)}`);
  assert.ok(counts[0] < 0.6 * counts.reduce((a, b) => a + b, 0), `the sub-1% tile must not swallow the pool: ${counts}`);
});

/* -- the whole world, at his dials --------------------------------------- */

function census(paint: boolean) {
  const docs: any = {};
  for (const [k, p] of Object.entries(TILES3_DOCS)) {
    const f = join(REPO, p);
    if (existsSync(f)) docs[k] = JSON.parse(readFileSync(f, "utf8"));
  }
  const data = tiles3DataFrom(docs, ISO_GEOMETRY_MAPS3.lh, () => {})!;
  const t = new Tiles3({ ...data, fadeTune: { ...FADE_TUNE_GAME, paint }, warn: () => {} });
  const doc = JSON.parse(readFileSync(join(REPO, WORLD), "utf8"));
  const out = t.resolveWindow(viewFromDoc(doc));
  const rows: { field: string; other: string; dist: number; area: number; areaMin: number; span: number }[] = [];
  for (const c of out.cells) {
    if (!c.fade) continue;
    const pool = t.fadePool(c.ground, c.fade.other);
    rows.push({
      field: c.ground,
      other: c.fade.other,
      dist: c.fade.dist,
      area: pool[c.fade.index].area,
      areaMin: pool[0].area,
      span: Math.max(1, pool[pool.length - 1].area - pool[0].area),
    });
  }
  return rows;
}

test("at his dials the world is mostly sparse fades, the 50/50 chunks are rare, and the edge is no longer the densest ring", { skip: !!MISSING.length }, () => {
  const now = census(true);
  const was = census(false);
  const share = (rows: typeof now, f: (r: (typeof now)[number]) => boolean) => rows.filter(f).length / Math.max(1, rows.length);
  assert.ok(now.length > 2000, `only ${now.length} fades placed`);
  const ring1 = now.filter((r) => r.dist === 1);
  // Measured 2026-09-19: 63% under 10% (was 31%), 2% at 40%+ (was 17%); at ring
  // 1, 53% under 10% (was 0%) and 5.6% at 40%+ (was 61%). The margins below are
  // wide, so a re-published index moves the numbers without moving the gate.
  assert.ok(share(now, (r) => r.area < 10) > 0.45, `under-10% share ${share(now, (r) => r.area < 10).toFixed(2)}`);
  assert.ok(share(now, (r) => r.area >= 40) < 0.08, `40%+ share ${share(now, (r) => r.area >= 40).toFixed(2)}`);
  assert.ok(share(ring1, (r) => r.area >= 40) < 0.15, `ring-1 40%+ share ${share(ring1, (r) => r.area >= 40).toFixed(2)}`);
  assert.ok(share(ring1, (r) => r.area < 10) > 0.3, `ring-1 under-10% share ${share(ring1, (r) => r.area < 10).toFixed(2)}`);
  // The contrast this gate exists for: render3's picture at the same dials puts
  // the densest tiles on the edge.
  const ring1was = was.filter((r) => r.dist === 1);
  assert.ok(share(ring1was, (r) => r.area >= 40) > 0.4, `paint off should crowd the edge with 40%+ tiles: ${share(ring1was, (r) => r.area >= 40).toFixed(2)}`);
  console.log(
    `fade paint: ${now.length} fades, ${(100 * share(now, (r) => r.area < 10)).toFixed(0)}% under 10% (was ${(100 * share(was, (r) => r.area < 10)).toFixed(0)}%), ` +
      `${(100 * share(now, (r) => r.area >= 40)).toFixed(1)}% at 40%+ (was ${(100 * share(was, (r) => r.area >= 40)).toFixed(1)}%); ` +
      `ring 1 mean ${(ring1.reduce((s, r) => s + r.area, 0) / ring1.length).toFixed(1)}% (was ${(ring1was.reduce((s, r) => s + r.area, 0) / ring1was.length).toFixed(1)}%)`,
  );
});

test("a road wears grass on its edge cell only, and only the sparsest tiles the pool has", { skip: !!MISSING.length }, () => {
  const now = census(true);
  const grassOnRoad = now.filter((r) => TRODDEN.has(r.field) && GROWS.has(r.other));
  assert.ok(grassOnRoad.length > 20, `only ${grassOnRoad.length} grass fades on roads — the rule has nothing to act on`);
  for (const r of grassOnRoad) {
    assert.equal(r.dist, 1, `${r.field}|${r.other}: grass on the middle of a road (ring ${r.dist})`);
    // The far end of the band: the sparsest tile, at most half a span over it.
    assert.ok(r.area <= r.areaMin + r.span / 2 + 1e-9, `${r.field}|${r.other}: a ${r.area}% chunk where the pool's sparsest is ${r.areaMin}%`);
  }
  // Mud tracked onto the road is not growth: it still reaches the middle cell.
  const mudOnRoad = now.filter((r) => TRODDEN.has(r.field) && !GROWS.has(r.other));
  assert.ok(mudOnRoad.some((r) => r.dist >= 2), "a non-growth ground should still fade onto a road's middle cell");
  // ...and the old picture did put grass there (30 of 89, measured 2026-09-19).
  const was = census(false).filter((r) => TRODDEN.has(r.field) && GROWS.has(r.other));
  assert.ok(was.some((r) => r.dist >= 2), "paint off: grass reached the middle of the road before this rule");
});
