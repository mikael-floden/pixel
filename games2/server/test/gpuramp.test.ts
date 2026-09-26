// THE GPU RAMP'S CPU HALF (client/src/tiles3gpu.ts `rampShapeOf` /
// `rampFromShape`): every composed ramp the_game draws, rebuilt from its shape
// and shade table the way the GPU pass reads them, must equal
// `buildRampPixels` BYTE FOR BYTE. The GPU half is the browser gate
// (scripts/verify-gpucompose.mjs); this pins the geometry and the rounding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3, PLATE_H, hexRGB } from "../../client/src/tiles3.js";
import { buildBoundaryPixels, buildPlatePixels, buildRampPixels, patternSheetPaths, patternSheets, type Pixels } from "../../client/src/tiles3draw.js";
import { Tiles3World, viewFromParsed } from "../../client/src/tiles3runtime.js";
import { rampFromShape, rampShapeOf } from "../../client/src/tiles3gpu.js";
import { parseWorld, ISO_GEOMETRY_MAPS3 } from "../../shared/src/index";
// @ts-expect-error — plain JS helper
import { imgRGBA } from "../../scripts/imagelib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const load = (rel: string) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));
const WORLD = join(REPO, "maps2/worlds3/the_game/world.json");
const NEEDS = ["tiles/ground_types.json", "tiles/patterns/index.json", "live/tuning/base_tile_sets.json", "live/feedback/tiles.json"];
const skip = NEEDS.some((p) => !existsSync(join(REPO, p))) || !existsSync(WORLD) ? "the tiles or the world are not checked out" : false;

function resolver(slopeHeight: number) {
  return new Tiles3({
    baseTileSets: load("live/tuning/base_tile_sets.json"),
    memberResolve: load("tiles/resolve.json"),
    groundTypes: load("tiles/ground_types.json").grounds,
    patterns: load("tiles/patterns/index.json"),
    review: load("tiles/review/manifest.json"),
    tops: load("tiles/tops/index.json"),
    feedback: load("live/feedback/tiles.json").entries,
    wallOverrides: load("live/tuning/tile_walls.json").overrides,
    basePromotions: load("live/tuning/base_tiles.json").overrides,
    fades: load("tiles/fades/index.json"),
    slopes: existsSync(join(REPO, "tiles/slopes/index.json")) ? load("tiles/slopes/index.json") : { sets: [] },
    topWallOverrides: load("live/tuning/top_walls.json").overrides,
    topOverrides: load("live/tuning/tile_tops.json").overrides,
    storeyPitch: 15,
    footBoundary: true,
    slopeHeight,
    warn: () => {},
  } as ConstructorParameters<typeof Tiles3>[0]);
}

test("every composed ramp of the_game, rebuilt from its GPU shape and shade table, is buildRampPixels byte for byte", { skip }, () => {
  const pat = load("tiles/patterns/index.json");
  const paths = patternSheetPaths(pat);
  const img = new Map<string, Pixels>();
  const px = (rel: string): Pixels => {
    let p = img.get(rel);
    if (!p) {
      const i = imgRGBA(join(REPO, rel)) as { width: number; height: number; data: Uint8Array };
      img.set(rel, (p = { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) }));
    }
    return p;
  };
  const sheets = patternSheets(pat, px(paths.silhouette), px(paths.masks), px(paths.border));
  const gt = load("tiles/ground_types.json").grounds;
  const wall = (g: string) => hexRGB(gt[g]?.palette?.wall ?? "#000000");
  const parsed = parseWorld(JSON.parse(readFileSync(WORLD, "utf8")))!;
  const view = viewFromParsed(parsed as never);
  const frame = { x0: 0, y0: 0, x1: parsed.width, y1: parsed.height, ox: 0, oy: 0, pitch: ISO_GEOMETRY_MAPS3.lh, canvas: [1, 1] } as never;
  let ramps = 0, onBoundary = 0, texels = 0;
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const height of [1, 0.5, 0.25]) {
    const w = new Tiles3World({ view, tiles: resolver(height), frame, patterns: pat });
    for (let y = 0; y < parsed.height; y++)
      for (let x = 0; x < parsed.width; x++) {
        const c = w.cell(x, y);
        const art = c?.art as { kind?: string; from?: string; fromKind?: string; mask?: number; h?: number; bnd?: never } | undefined;
        if (!art || art.kind !== "ramp" || !art.from) continue;
        const sig = JSON.stringify([art, c!.ground]);
        if (seen.has(sig)) continue;
        seen.add(sig);
        const src = px(art.from);
        let top = art.fromKind === "conform" ? buildPlatePixels(sheets, { kind: "conform", path: art.from } as never, src, wall(c!.ground)) : src;
        const bnd = art.bnd as { plateA: { path: string; kind?: string }; plateB: { path: string; kind?: string }; a: string; b: string } | undefined;
        if (bnd) {
          const plate = (p: { path: string; kind?: string }, g: string) => buildPlatePixels(sheets, p as never, px(p.path), wall(g));
          top = buildBoundaryPixels(sheets, bnd as never, plate(bnd.plateA, bnd.a), plate(bnd.plateB, bnd.b), true);
          onBoundary++;
        }
        const lh = Math.max(0, (art.h ?? PLATE_H) - PLATE_H);
        const mask = art.mask ?? 0;
        const want = buildRampPixels(sheets, top, mask, lh, src, false);
        const shape = rampShapeOf(sheets, mask, lh, top, src, false);
        const got = rampFromShape(shape, top, src);
        ramps++;
        texels += want.data.length / 4;
        let diff = 0;
        for (let i = 0; i < want.data.length; i++) if (want.data[i] !== got.data[i]) diff++;
        if (diff || want.w !== got.w || want.h !== got.h) bad.push(`${x},${y} (${c!.ground}, mask ${mask}, lh ${lh}${bnd ? ", on a transition" : ""}): ${diff} bytes`);
      }
  }
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} of ${ramps} ramps differ`);
  assert.ok(ramps >= 50, `${ramps} distinct ramps compared (${onBoundary} on a transition, ${texels} texels)`);
  console.log(`gpuramp: ${ramps} distinct ramps (${onBoundary} on a transition, ${texels} texels) identical`);
});
