// THE OUTLINE'S HAND-OVER PROTOCOL (tiles3 EDGE_HANDOVER; maintainer 2026-09-26:
// "You just need a protocol for where the line should be handed over/meet and
// you will have 0 gaps!"): on the_game, every cell with neighbour lines paints
// the same VISIBLE texels from the protocol's bits (each neighbour's edges that
// touch a corner it shares with the cell) as from every neighbour edge. A texel
// a later same-level neighbour paints over is not the cell's to show and is not
// compared. Flat cells and composed ramps alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3 } from "../../client/src/tiles3.js";
import { buildRampPixels, edgeTopPixels, patternSheetPaths, patternSheets, type Pixels } from "../../client/src/tiles3draw.js";
import { viewFromParsed } from "../../client/src/tiles3runtime.js";
import { parseWorld } from "../../shared/src/index";
// @ts-expect-error — plain JS helper
import { imgRGBA } from "../../scripts/imagelib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const load = (rel: string) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));
const WORLD = join(REPO, "maps2/worlds3/the_game/world.json");
const NEEDS = ["tiles/ground_types.json", "tiles/patterns/index.json", "live/tuning/base_tile_sets.json", "tiles/resolve.json"];
const skip = NEEDS.some((p) => !existsSync(join(REPO, p))) || !existsSync(WORLD) ? "the tiles or the world are not checked out" : false;

test("the_game's outlines from the hand-over protocol equal those from every neighbour edge, in every visible texel", { skip }, () => {
  const PAT = load("tiles/patterns/index.json");
  const p = patternSheetPaths(PAT);
  const img = (rel: string): Pixels => { const i = imgRGBA(join(REPO, rel)) as { width: number; height: number; data: ArrayLike<number> }; return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) }; };
  const S = patternSheets(PAT, img(p.silhouette), img(p.masks), img(p.border));
  const plate: Pixels = { w: S.fw, h: S.fh, data: new Uint8ClampedArray(S.fw * S.fh * 4) };
  for (let i = 0; i < S.fw * S.fh; i++) if (S.libTop[i] > 0 || (i >= S.fw && S.libTop[i - S.fw] > 0)) plate.data.fill(255, i * 4, i * 4 + 4);
  const t = new Tiles3({ baseTileSets: load("live/tuning/base_tile_sets.json"), memberResolve: load("tiles/resolve.json"), groundTypes: load("tiles/ground_types.json").grounds, patterns: PAT, storeyPitch: 15, footBoundary: true, deckBoundary: true, slopeHeight: 1, warn: () => {} } as ConstructorParameters<typeof Tiles3>[0]);
  const parsed = parseWorld(JSON.parse(readFileSync(WORLD, "utf8")))!;
  const view = viewFromParsed(parsed as never);
  const g = (x: number, y: number) => (x >= 0 && y >= 0 && x < parsed.width && y < parsed.height ? view.groundAt(x, y) : null);
  const L = (x: number, y: number) => view.levelAt(x, y);
  const area = (px: number, py: number) => px >= 0 && py >= 0 && px < S.fw && py < S.fh && (S.libTop[py * S.fw + px] > 0 || (py > 0 && S.libTop[(py - 1) * S.fw + px] > 0));
  (globalThis as { __edgeDebug?: boolean }).__edgeDebug = true;
  let flat = 0, ramps = 0;
  const bad: string[] = [];
  const combos = new Set<string>();
  try {
    for (let y = 0; y < parsed.height; y++)
      for (let x = 0; x < parsed.width; x++) {
        const all = t.edgeNb(g, L, x, y, view, true);
        if (!all) continue;
        const nb = t.edgeNb(g, L, x, y, view);
        const e = t.edgeSet(g, L, x, y, view);
        const geo = t.edgeGeom(g, L, x, y);
        if (geo) ramps++;
        else flat++;
        combos.add(`${geo ? geo.mask + "," + geo.lh : 0}|${e?.top ?? 0}|${nb}`);
        const base = geo ? buildRampPixels(S, plate, geo.mask, geo.lh, plate, false) : plate;
        const a = edgeTopPixels(S, base, e?.top ?? 0, geo || undefined, 0, all);
        const b = edgeTopPixels(S, base, e?.top ?? 0, geo || undefined, 0, nb);
        const oy = geo ? geo.lh : 0;
        const later = ([[1, 0], [0, 1], [1, 1], [1, -1]] as [number, number][]).filter(([dx, dy]) => g(x + dx, y + dy) && L(x + dx, y + dy) === L(x, y)).map(([dx, dy]) => [(dx - dy) * 32, (dx + dy) * 14]);
        let d = 0;
        for (let i = 0; i < a.data.length; i += 4) {
          const k = i / 4, px = k % a.w, py = Math.floor(k / a.w) - oy;
          if (later.some(([ox, oy2]) => area(px - ox, py - oy2))) continue;
          if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) d++;
        }
        if (d && bad.length < 5) bad.push(`${x},${y}: ${d} texels (${all} -> ${nb})`);
      }
  } finally {
    delete (globalThis as { __edgeDebug?: boolean }).__edgeDebug;
  }
  assert.deepEqual(bad, []);
  assert.ok(flat > 10000 && ramps > 500, `${flat} flat cells and ${ramps} ramps with neighbour lines checked`);
  console.log(`edgeprotocol: ${flat} flat + ${ramps} ramp cells identical; ${combos.size} distinct outlines in the whole world`);
});
