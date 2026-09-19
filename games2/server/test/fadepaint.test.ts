// ============================================================================
// FADE PAINT — the fade is a DENSITY, not a rule: a taste with a tail, his 10%
// brush, and a road that is ten times harder per ring, never a wall
// ============================================================================
//
// The maintainer, once the area numbers were honest (2026-09-19): "mostly use
// the tiles with less than 10% grass when placing grass on sand. The tiles
// close to 50/50 should be used much much less. And when they do occur you must
// know you have to place 5x 10% grass to get the same amount of grass." On the
// equal-paint rule that first shipped for it: "I guess that rule kinda works,
// but that was not what I said! I was talking on 'grass density / area'. I
// don't like hard rules, you just need to know what % you paint with so you
// can make a nice fade! ... it's all about not creating hard rules to always
// allow for the unlikely to happen. Once this demo map is complete we will
// start on the real map that is 50x this size! If you don't allow for rare
// things to sometimes happen the entire world will look the same!" And on
// roads: "It looks really dumb when we have a big chunk of grass in the middle
// of the road. If people walk here grass can't grow here!"
//
// Measured over the_game at his dials, the walls this replaces: rings 3-4 wore
// not one tile at 40%+, grass on a road never left the edge cell, and a 2% tile
// was picked 25x a 50% one. The unit half below is exact arithmetic on
// `fadePick`; the world half is the census at his dials, skipped (not failed)
// where the sparse deploy checkout has no tiles/ or maps2/worlds3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3, fadePick, viewFromDoc, TRODDEN, GROWS, FADE_TUNE_GAME, FADE_BRUSH, type FadePoolTile } from "../../client/src/tiles3";
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
function sweep(pos: number, falloff: number, paint: boolean, pool: readonly FadePoolTile[] = POOL, n = 100000): number[] {
  const counts = pool.map(() => 0);
  for (let i = 0; i < n; i++) counts[fadePick(pool, pos, falloff, (i + 0.5) / n, paint)]++;
  return counts;
}
const near = (a: number, b: number, tol: number) => Math.abs(a / b - 1) < tol;

test("his brush: every tile at or under 10% is one brush, a denser tile counts by what it paints", () => {
  assert.equal(FADE_BRUSH, 10, "the brush is the 10% he named");
  const [a2, a5, a10, a20, a50] = sweep(1, 4, true);
  // Under the brush there is no ladder: a 2% tile is not 5x a 10% one (that
  // was the 1/area rule he called "not what I said").
  assert.ok(near(a2, a10, 0.01) && near(a5, a10, 0.01), `2%, 5% and 10% are one brush: ${[a2, a5, a10]}`);
  // Over it the accounting: "you have to place 5x 10% grass to get the same
  // amount" — one 50% tile stands where five 10% ones would, one 20% where two.
  assert.ok(near(a10 / a50, 5, 0.02), `10% : 50% is 5 : 1, got ${(a10 / a50).toFixed(3)}`);
  assert.ok(near(a10 / a20, 2, 0.02), `10% : 20% is 2 : 1, got ${(a10 / a20).toFixed(3)}`);
  assert.ok(near(a20 * 20, a50 * 50, 0.02), "so the other ground a cell lays down is the brush's whichever came up");
  // ...and the dense tile is still THERE at the edge, where it belongs.
  assert.ok(a50 > 0.03 * (a2 + a5 + a10 + a20 + a50), `the 50/50 chunk is rare at the edge, not gone: ${a50}`);
});

test("no wall: past the taste's centre a tile is rare, never impossible", () => {
  // pos = 1/reach at the far ring; with falloff 4 the centre sits on the
  // sparsest tile and the 50% tile is a full span past it.
  const c = sweep(0.25, 4, true);
  const n = c.reduce((a, b) => a + b, 0);
  assert.ok(c[4] > 0, `the 50/50 chunk far out is the rare thing he wants to exist: ${c}`);
  assert.ok(c[4] < 0.01 * n, `...and rare: ${c[4]} of ${n}`);
  assert.ok(c[0] > c[1] && c[1] > c[2] && c[2] > c[3] && c[3] > c[4], `sparsest first at the far end: ${c}`);
  // Half way out the same tile is more welcome, and at the edge it is on the centre.
  const mid = sweep(0.5, 4, true);
  assert.ok(mid[4] > c[4], "the tail widens toward the edge");
  // falloff 1 (the resolver's constant) lifts the far centre to areaMin + span/4:
  // the 20% tile sits on it and the 50% one is nearer — a gentler falloff lets
  // denser tiles further out.
  const d = sweep(0.25, 1, true);
  assert.ok(d[3] > c[3] && d[4] > c[4], "a gentler falloff lets denser tiles further out");
});

test("render3's picture is the one he ruled out: the edge targets the densest tile", () => {
  // Kept, because the parity fixture pins it and the game never sets it.
  const c = sweep(1, 4, false);
  assert.equal(c[4], 100000, `paint off: every ring-1 pick is the 50% tile, got ${c}`);
});

test("a sub-1% tile (tier 2 waives the floor) is the brush too, and does not swallow the pick", () => {
  const tiny: FadePoolTile[] = [{ file: "t0", key: "k", area: 0.2, rating: 0, tier: 2 }, ...POOL.map((p) => ({ ...p, tier: 2 as const }))];
  const counts = sweep(1, 4, true, tiny, 10000);
  assert.ok(near(counts[0], counts[1], 0.02), `0.2% and 2% are one brush, got ${counts[0]} : ${counts[1]}`);
  assert.ok(counts[0] < 0.3 * counts.reduce((a, b) => a + b, 0), `the sub-1% tile must not swallow the pool: ${counts}`);
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
type Row = ReturnType<typeof census>[number];
const share = (rows: Row[], f: (r: Row) => boolean) => rows.filter(f).length / Math.max(1, rows.length);

test("at his dials the world is mostly sparse fades, the 50/50 chunk is rare everywhere and absent nowhere", { skip: !!MISSING.length }, () => {
  const now = census(true);
  const was = census(false);
  assert.ok(now.length > 2000, `only ${now.length} fades placed`);
  const ring1 = now.filter((r) => r.dist === 1);
  const far = now.filter((r) => r.dist >= 3);
  // Measured 2026-09-19: 54% under 10% (render3's picture: 31%), 3.3% at 40%+
  // (was 17.5%); at ring 1, 42% under 10% (was 0%) and 7% at 40%+ (was 61%).
  // The margins are wide, so a re-published index moves the numbers without
  // moving the gate.
  assert.ok(share(now, (r) => r.area < 10) > 0.45, `under-10% share ${share(now, (r) => r.area < 10).toFixed(2)}`);
  assert.ok(share(now, (r) => r.area >= 40) < 0.08, `40%+ share ${share(now, (r) => r.area >= 40).toFixed(2)}`);
  assert.ok(share(ring1, (r) => r.area >= 40) < 0.15, `ring-1 40%+ share ${share(ring1, (r) => r.area >= 40).toFixed(2)}`);
  assert.ok(share(ring1, (r) => r.area < 10) > 0.3, `ring-1 under-10% share ${share(ring1, (r) => r.area < 10).toFixed(2)}`);
  // THE RARE THING EXISTS: rings 3-4 wear a 40%+ tile now and then (16 of
  // 1,153 measured, 1 in 72; the ceiling allowed none) — and only now and then.
  const farDense = far.filter((r) => r.area >= 40).length;
  assert.ok(farDense > 0, "a 50/50 chunk at the far end of the band must be possible, or the 50x map looks the same everywhere");
  assert.ok(farDense < 0.05 * far.length, `...and rare: ${farDense} of ${far.length} far-ring fades at 40%+`);
  // The contrast this gate exists for: render3's picture at the same dials puts
  // the densest tiles on the edge.
  const ring1was = was.filter((r) => r.dist === 1);
  assert.ok(share(ring1was, (r) => r.area >= 40) > 0.4, `paint off should crowd the edge with 40%+ tiles: ${share(ring1was, (r) => r.area >= 40).toFixed(2)}`);
  console.log(
    `fade paint: ${now.length} fades, ${(100 * share(now, (r) => r.area < 10)).toFixed(0)}% under 10% (render3 ${(100 * share(was, (r) => r.area < 10)).toFixed(0)}%), ` +
      `${(100 * share(now, (r) => r.area >= 40)).toFixed(1)}% at 40%+ (render3 ${(100 * share(was, (r) => r.area >= 40)).toFixed(1)}%); ` +
      `ring 1 mean ${(ring1.reduce((s, r) => s + r.area, 0) / ring1.length).toFixed(1)}% (render3 ${(ring1was.reduce((s, r) => s + r.area, 0) / ring1was.length).toFixed(1)}%); ` +
      `rings 3-4: ${farDense} of ${far.length} at 40%+`,
  );
});

test("a road keeps its grass at the edge — ten times harder per ring, never a wall — and mud still tracks onto the middle", { skip: !!MISSING.length }, () => {
  const now = census(true);
  const grassOnRoad = now.filter((r) => TRODDEN.has(r.field) && GROWS.has(r.other));
  assert.ok(grassOnRoad.length > 20, `only ${grassOnRoad.length} grass fades on roads — the rule has nothing to act on`);
  const edge = grassOnRoad.filter((r) => r.dist === 1);
  const inward = grassOnRoad.filter((r) => r.dist >= 2);
  // Some blades past the edge cell (3 of 59 measured; the wall had 0), never
  // most of them — and never the big chunk in the middle of the road.
  assert.ok(inward.length > 0, "grass past a road's edge cell must be rare, not impossible");
  assert.ok(inward.length < 0.25 * grassOnRoad.length, `${inward.length} of ${grassOnRoad.length} grass fades on roads sit past the edge cell`);
  assert.ok(inward.every((r) => r.area < 40), `a 40%+ chunk in the middle of a road: ${JSON.stringify(inward.filter((r) => r.area >= 40))}`);
  // The edge cell tastes like the far end of the band: mostly the sparsest
  // tiles the pool has (2 of 56 at 40%+ measured — the verge encroaching, rarely).
  assert.ok(share(edge, (r) => r.area <= r.areaMin + r.span / 2) > 0.85, `road edge: ${(100 * share(edge, (r) => r.area <= r.areaMin + r.span / 2)).toFixed(0)}% in the sparse half of the pool`);
  // Mud tracked onto the road is not growth: it still reaches the middle cell
  // (38 measured, as many as before the rule).
  const mudInward = now.filter((r) => TRODDEN.has(r.field) && !GROWS.has(r.other) && r.dist >= 2);
  assert.ok(mudInward.length >= 20, `only ${mudInward.length} non-growth fades past a road's edge cell`);
  // ...and the old picture did put grass there (30 of 89, measured 2026-09-19).
  const was = census(false).filter((r) => TRODDEN.has(r.field) && GROWS.has(r.other));
  assert.ok(was.some((r) => r.dist >= 2), "paint off: grass reached the middle of the road before this rule");
  console.log(`road: ${grassOnRoad.length} grass fades, ${inward.length} past the edge cell (max ${Math.max(...inward.map((r) => r.area)).toFixed(1)}%), ${mudInward.length} non-growth fades inward`);
});
