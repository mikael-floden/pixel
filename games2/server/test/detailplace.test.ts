// ============================================================================
// WHERE A GROUND DETAIL MAY LAND — never on a ramp, never touching another
// ============================================================================
//
// A detail is "a tile that doesn't look good repeated, but look very good alone"
// (maintainer 2026-09-13), placed once in a while by a per-cell roll against the
// Settings dial. Two placements broke that, measured on the_game at the default
// 1 in 56: 28 of 860 details sat on a SLOPE cell and replaced its graded ramp
// tile, and 101 had another detail touching them (at 1 in 10: 156 and 2,365).
//
// The rules: a slope cell keeps its slope; among the raw winners of an 8-ring
// the smallest roll keeps its detail and the others yield — symmetric and
// order-free, so the worker, a streaming window and a full sweep agree with no
// shared state, and at the dial's top the field packs to about one cell in nine
// and never adjacent. The synthetic arms are data-free and run in the deploy
// gate; the last arm reads the_game and skips without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3, viewFromDoc, isoFrame, type World3View, type Tiles3Cell } from "../../client/src/tiles3";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const rel = (p: string) => join(REPO, p);

/** A resolver with one ground, "grass", holding a two-tile detail library. */
function bare(rate: number): Tiles3 {
  const dir = "tiles/tops/grass/sheet_00_detail_00000";
  return new Tiles3({
    baseTileSets: { grounds: {} },
    memberResolve: { members: {} } as any,
    groundTypes: {} as any,
    patterns: {} as any,
    tops: { sheets: [{ ground: "grass", flavour: "detail", dir, tiles: ["tile_00.webp", "tile_01.webp"], post_files: ["tile_00.aaaaaaaa.webp", "tile_01.bbbbbbbb.webp"] }] } as any,
    feedback: { [`${dir}/tile_00.webp#top`]: { status: "approved" }, [`${dir}/tile_01.webp#top`]: { status: "approved" } },
    storeyPitch: 15,
    detailRate: rate,
    warn: () => {},
  });
}
function flat(n: number): World3View {
  return {
    x0: 0, y0: 0, x1: n, y1: n, width: n, height: n, maxLevel: 8,
    groundAt: (x, y) => (x < 0 || y < 0 || x >= n || y >= n ? null : "grass"),
    levelAt: () => 0,
    isLiquid: () => false,
    wallSideAt: () => null,
    decks: [],
  };
}
function sweep(t: Tiles3, view: World3View, order: "forward" | "backward" = "forward"): Map<string, Tiles3Cell> {
  const frame = isoFrame(view, view.maxLevel, 15);
  const g = (x: number, y: number) => view.groundAt(x, y);
  const L = (x: number, y: number) => view.levelAt(x, y);
  const out = new Map<string, Tiles3Cell>();
  const xs = [...Array(view.width).keys()];
  const ys = [...Array(view.height).keys()];
  if (order === "backward") { xs.reverse(); ys.reverse(); }
  for (const y of ys) for (const x of xs) {
    const c = t.resolveCell(view, frame, g, L, x, y);
    if (c) out.set(`${x},${y}`, c);
  }
  return out;
}
function touching(cells: Map<string, Tiles3Cell>): number {
  let pairs = 0;
  for (const c of cells.values()) {
    if (!c.detail) continue;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]] as const)
      if (cells.get(`${c.x + dx},${c.y + dy}`)?.detail) pairs++;
  }
  return pairs;
}

test("no two details touch, at any density, and the answer does not depend on resolve order", () => {
  const view = flat(64);
  for (const every of [1, 4, 10, 56]) {
    const t = bare(1 / every);
    const cells = sweep(t, view);
    const n = [...cells.values()].filter((c) => c.detail).length;
    assert.equal(touching(cells), 0, `1 in ${every}: ${touching(cells)} touching pairs`);
    assert.ok(n > 0, `1 in ${every}: no detail at all`);
    // ORDER-FREE: a streaming window resolves cells in whatever order the
    // camera asks; the rule must not care.
    const back = sweep(bare(1 / every), view, "backward");
    for (const [k, c] of cells) assert.equal(!!back.get(k)?.detail, !!c.detail, `${k} differs with the sweep order at 1 in ${every}`);
    if (every === 1) {
      // The dial's top: every cell wins its roll, the field packs to the local
      // minima of the hash — about one in nine — and is never tiled.
      const share = n / cells.size;
      assert.ok(share > 1 / 14 && share < 1 / 6, `at N = 1 the packed density is 1 in ${(1 / share).toFixed(1)}, expected about 1 in 9`);
    }
    if (every === 56) assert.ok(n >= 25, `1 in 56 on 4,096 cells placed only ${n}`);
  }
});

test("the dial still steers the density monotonically", () => {
  const view = flat(96);
  let last = Infinity;
  for (const every of [1, 2, 4, 10, 30, 56, 200]) {
    const n = [...sweep(bare(1 / every), view).values()].filter((c) => c.detail).length;
    assert.ok(n <= last, `1 in ${every} placed ${n}, more than the denser stop (${last})`);
    last = n;
  }
});

const NEEDS = ["maps2/worlds3/the_game/world.json", "tiles/ground_types.json", "tiles/patterns/index.json", "tiles/review/manifest.json", "tiles/resolve.json", "tiles/tops/index.json", "tiles/slopes/index.json", "live/tuning/base_tile_sets.json", "live/feedback/tiles.json"];
const MISSING = NEEDS.filter((p) => !existsSync(rel(p)));
test("on the_game, no detail sits on a ramp and none touches another", { skip: !!MISSING.length }, () => {
  const load = (p: string): any => JSON.parse(readFileSync(rel(p), "utf8"));
  const t = new Tiles3({
    baseTileSets: load("live/tuning/base_tile_sets.json"), memberResolve: load("tiles/resolve.json"),
    groundTypes: load("tiles/ground_types.json").grounds, patterns: load("tiles/patterns/index.json"),
    review: load("tiles/review/manifest.json"), tops: load("tiles/tops/index.json"),
    feedback: load("live/feedback/tiles.json").entries, slopes: load("tiles/slopes/index.json"),
    storeyPitch: 15, warn: () => {},
  });
  const doc = load("maps2/worlds3/the_game/world.json");
  const view = viewFromDoc(doc);
  const liquids = new Set<string>(doc.liquids ?? []);
  const land: World3View = { ...view, groundAt: (x, y) => { const g = view.groundAt(x, y); return g && !liquids.has(g) ? g : null; } };
  const cells = sweep(t, land);
  const det = [...cells.values()].filter((c) => c.detail);
  const onSlope = det.filter((c) => c.slope).length;
  assert.equal(onSlope, 0, `${onSlope} details replaced a ramp's graded tile`);
  assert.equal(touching(cells), 0, `${touching(cells)} pairs of details touch`);
  assert.ok(det.length >= 500, `only ${det.length} details on the_game at the default rate — the rules folded too much (860 before them)`);
  console.log(`    the_game at 1 in 56: ${det.length} details over ${cells.size} land cells, none on a ramp, none touching`);
});
