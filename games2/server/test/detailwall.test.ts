// ============================================================================
// A DETAIL NEVER SHOWS ITS WALL
// ============================================================================
//
// "A detail should never be able to show its wall" (maintainer 2026-09-13).
//
// A plate is 64x46: a 29-row top-face diamond plus a 17-row WALL BAND under it.
// At every raised level and on every liquid the surface is `topOnly` and the
// band is masked off, so the cell's own x-over-y courses are the wall. At LEVEL
// 0 the band is drawn — nothing exists below, so it is never legitimate art,
// and `capWallToSurface` repaints it in the tile's own surface colour precisely
// because a one-texel coverage error along a diamond edge makes it visible (the
// 633 texels of light_beach's palette wall in 116 chevrons he photographed on
// 2026-09-04).
//
// A detail used to REPLACE the plate, so that band was the DETAIL'S colour — a
// dark rock or a puddle smeared 17 rows down into the ground. Now a detail is
// an overlay: the cell keeps its member plate, and the detail is drawn top face
// only with no margin row. These tests hold both halves of that — the raster
// carries no texel below the top face, and the resolver keeps the member plate
// as the cell's art so something still paints the band.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3, viewFromDoc, isoFrame, regionAt, TILE, PLATE_H, type World3View } from "../../client/src/tiles3";
import { detailOverlay, detailKey, conformPlate, cellOps, patternSheets, type Pixels } from "../../client/src/tiles3draw";
// @ts-expect-error — plain .mjs helper shared with the build scripts
import { imgRGBA } from "../../scripts/imagelib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const rel = (p: string) => join(REPO, p);
const load = (p: string): any => JSON.parse(readFileSync(rel(p), "utf8"));

const SHEET_FILES = ["tiles/patterns/index.json", "tiles/tops/index.json", "live/feedback/tiles.json", "maps2/worlds3/the_game/world.json", "tiles/review/manifest.json", "tiles/resolve.json", "tiles/ground_types.json", "live/tuning/base_tile_sets.json", "tiles/slopes/index.json"];
const MISSING = SHEET_FILES.filter((p) => !existsSync(rel(p)));

/** The real pattern sheets, decoded — `detailOverlay` needs the library's own
 *  top-face mask and silhouette, never a guess at the geometry. */
function sheets(): any {
  const doc = load("tiles/patterns/index.json");
  const paths = {
    silhouette: doc.silhouette?.file ?? doc.silhouette,
    masks: doc.masks?.file ?? doc.masks,
    border: doc.border?.file ?? doc.border,
  };
  const px = (p: string): Pixels => {
    const { width, height, data } = imgRGBA(rel(p)) as { width: number; height: number; data: Uint8Array };
    return { w: width, h: height, data: new Uint8ClampedArray(data) } as unknown as Pixels;
  };
  return patternSheets(doc, px(paths.silhouette), px(paths.masks), px(paths.border));
}

/** Every detail file the_game can actually draw, with its ground. */
function placedDetails(limit: number): { ground: string; file: string }[] {
  const t = new Tiles3({
    baseTileSets: load("live/tuning/base_tile_sets.json"), memberResolve: load("tiles/resolve.json"),
    groundTypes: load("tiles/ground_types.json").grounds, patterns: load("tiles/patterns/index.json"),
    review: load("tiles/review/manifest.json"), tops: load("tiles/tops/index.json"),
    feedback: load("live/feedback/tiles.json").entries, slopes: load("tiles/slopes/index.json"),
    storeyPitch: 15, warn: () => {},
  });
  const doc = load("maps2/worlds3/the_game/world.json");
  const view: World3View = viewFromDoc(doc);
  const frame = isoFrame(view, view.maxLevel, 15);
  const liquids = new Set<string>(doc.liquids ?? []);
  const g = (x: number, y: number) => { const gr = view.groundAt(x, y); return gr && !liquids.has(gr) ? gr : null; };
  const L = (x: number, y: number) => view.levelAt(x, y);
  const seen = new Map<string, { ground: string; file: string }>();
  for (let y = 0; y < view.height && seen.size < limit; y++)
    for (let x = 0; x < view.width && seen.size < limit; x++) {
      const c = t.resolveCell(view, frame, g, L, x, y);
      if (c?.detail) seen.set(`${c.ground}|${c.detail.file}`, { ground: c.ground, file: c.detail.file });
    }
  return [...seen.values()];
}

test("a detail overlay carries no texel outside the top face", { skip: !!MISSING.length }, () => {
  const sh = sheets();
  const { fw, fh, libTop } = sh;
  const gt = load("tiles/ground_types.json").grounds;
  const hex = (s: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
  const details = placedDetails(40);
  assert.ok(details.length >= 20, `only ${details.length} distinct details placed — the sample is too thin to gate on`);
  let checked = 0;
  let topTexels = 0;
  for (const { ground, file } of details) {
    const { width, height, data } = imgRGBA(rel(file)) as { width: number; height: number; data: Uint8Array };
    const src = { w: width, h: height, data: new Uint8ClampedArray(data) } as unknown as Pixels;
    const wall = hex(gt[ground]?.palette?.wall ?? "#000000");
    const over = detailOverlay(sh, src, wall);
    assert.equal(over.w, fw);
    assert.equal(over.h, fh);
    let outside = 0;
    let inside = 0;
    for (let i = 0; i < fw * fh; i++) {
      const a = over.data[i * 4 + 3];
      if (libTop[i]) { if (a > 0) inside++; } else if (a > 0) outside++;
    }
    assert.equal(outside, 0, `${file} on ${ground}: ${outside} texels below its top face`);
    assert.ok(inside > 800, `${file} on ${ground}: only ${inside} opaque top-face texels — it would not cover the member plate`);
    // ...and it is not the same picture as the conformed plate of the same
    // file, which is why it has its own key.
    const plate = conformPlate(sh, src, wall);
    let band = 0;
    for (let i = 0; i < fw * fh; i++) if (!libTop[i] && plate.data[i * 4 + 3] > 0) band++;
    assert.ok(band > 0, `${file}: its conformed plate has no band at all — the comparison is vacuous`);
    checked++;
    topTexels += inside;
  }
  assert.equal(detailKey("a/b.webp", "grass") === detailKey("a/b.webp", "snow"), false, "a detail overlay is keyed per ground");
  console.log(`    ${checked} distinct details: 0 texels below the top face, ${Math.round(topTexels / checked)} opaque top-face texels each`);
});

test("the cell keeps its own plate under a detail, and the detail draws over it", { skip: !!MISSING.length }, () => {
  const t = new Tiles3({
    baseTileSets: load("live/tuning/base_tile_sets.json"), memberResolve: load("tiles/resolve.json"),
    groundTypes: load("tiles/ground_types.json").grounds, patterns: load("tiles/patterns/index.json"),
    review: load("tiles/review/manifest.json"), tops: load("tiles/tops/index.json"),
    feedback: load("live/feedback/tiles.json").entries, slopes: load("tiles/slopes/index.json"),
    storeyPitch: 15, warn: () => {},
  });
  const doc = load("maps2/worlds3/the_game/world.json");
  const view: World3View = viewFromDoc(doc);
  const frame = isoFrame(view, view.maxLevel, 15);
  const liquids = new Set<string>(doc.liquids ?? []);
  const g = (x: number, y: number) => { const gr = view.groundAt(x, y); return gr && !liquids.has(gr) ? gr : null; };
  const L = (x: number, y: number) => view.levelAt(x, y);
  let withDetail = 0;
  let level0 = 0;
  for (let y = 0; y < view.height; y++)
    for (let x = 0; x < view.width; x++) {
      const c = t.resolveCell(view, frame, g, L, x, y);
      if (!c?.detail) continue;
      withDetail++;
      // THE CELL'S ART IS ITS OWN GROUND'S, never the detail file: that is what
      // puts the ground's band under the diamond instead of the detail's. (A
      // liquid art carries no path and never reaches here — liquids are skipped
      // above — so reading it as a pathed art is sound.)
      const artPath = (c.art as { path?: string } | undefined)?.path;
      assert.notEqual(artPath, c.detail.file, `${x},${y}: the detail is still the cell's art`);
      const p = t.plateFor(c.ground, x, y);
      assert.equal(artPath, p.art.path, `${x},${y}: the cell's art is not its member plate`);
      if (c.level === 0) {
        level0++;
        assert.ok(!c.art?.topOnly, `${x},${y}: a level-0 cell must keep its band, or the detail leaves a seam`);
      }
      // ...and the ops draw both, the detail after the plate.
      const ops = cellOps(c);
      const iPlate = ops.findIndex((o) => o.role === "surface");
      const iDetail = ops.findIndex((o) => o.role === "detail");
      assert.ok(iPlate >= 0, `${x},${y}: no surface op`);
      assert.ok(iDetail > iPlate, `${x},${y}: the detail op does not draw over the plate (plate ${iPlate}, detail ${iDetail})`);
      assert.equal(ops[iDetail].key, detailKey(c.detail.file, c.ground));
      assert.equal(ops[iDetail].sw, TILE);
      assert.equal(ops[iDetail].sh, PLATE_H);
    }
  assert.ok(withDetail > 100, `only ${withDetail} details on the_game`);
  assert.ok(level0 > 50, `only ${level0} of them at level 0 — the case the band rule is about`);
  console.log(`    ${withDetail} details on the_game (${level0} at level 0), every one an overlay over its own member plate`);
});
