// THE EDGE OUTLINE (maintainer 2026-09-26: "a 1px near-black (somewhat
// transparent) border at every visible edge. Not around every tile, just around
// where the ground becomes wall or where a left wall becomes a right wall ...
// When a slope is at 100% no border should be drawn"). The rule is tiles3
// `edgeSet` (surface height at the corners, ramps included); the ink is baked
// into lined texture variants (tiles3draw `edgeTopPixels`, `edgeCoursePixels`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EDGE_E, EDGE_N, EDGE_NONE, EDGE_S, EDGE_W, Tiles3 } from "../../client/src/tiles3.js";
import { EDGE_ALPHA, EDGE_ALPHA_IN, EDGE_SHADE, EDGE_SHADE_IN, courseEdgeBits, edgeCoursePixels, edgeTopPixels, patternSheetPaths, patternSheets, type Pixels } from "../../client/src/tiles3draw.js";
// @ts-expect-error plain mjs
import { imgRGBA } from "../../scripts/imagelib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const load = (rel: string) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));
const NEEDS = ["tiles/ground_types.json", "tiles/patterns/index.json", "live/tuning/base_tile_sets.json", "tiles/resolve.json"];
const skip = NEEDS.some((p) => !existsSync(join(REPO, p))) ? "tiles not checked out" : false;

function resolver(slopeHeight: number) {
  return new Tiles3({
    baseTileSets: load("live/tuning/base_tile_sets.json"),
    memberResolve: load("tiles/resolve.json"),
    groundTypes: load("tiles/ground_types.json").grounds,
    patterns: load("tiles/patterns/index.json"),
    storeyPitch: 15,
    footBoundary: true,
    deckBoundary: true,
    slopeHeight,
    warn: () => {},
  } as ConstructorParameters<typeof Tiles3>[0]);
}
/** A grid of levels, all grass. */
const grid = (lv: number[][]) => ({
  g: (x: number, y: number) => (y >= 0 && y < lv.length && x >= 0 && x < lv[0].length ? "grass" : null),
  L: (x: number, y: number) => lv[y]?.[x] ?? 0,
});

test("a two-storey block on flat ground: rims on its outward edges, the foot behind the ground in front, the crease and the face ends", { skip }, () => {
  const t = resolver(-0.01); // slopes off: stairs everywhere
  // A 3x3 block two storeys up in a 7x7 field.
  const lv = Array.from({ length: 7 }, (_, y) => Array.from({ length: 7 }, (_, x) => (x >= 2 && x <= 4 && y >= 2 && y <= 4 ? 2 : 0)));
  const { g, L } = grid(lv);
  const e = (x: number, y: number) => t.edgeSet(g, L, x, y);
  assert.equal(e(3, 3), undefined, "the block's middle draws nothing");
  assert.equal(e(0, 0), undefined, "open ground draws nothing");
  // The block's south-east corner: rims on its +x and +y edges, and the crease where its left face turns into its right, down to the ground.
  const se = e(4, 4)!;
  assert.equal(se.top, EDGE_S | EDGE_E);
  assert.deepEqual(se.lo, [EDGE_NONE, 0, EDGE_NONE]);
  // The faces END at the block's other two front corners: the left face at the south-west cell's left corner, the right face at the north-east cell's right corner.
  assert.deepEqual(e(2, 4)!.lo, [0, EDGE_NONE, EDGE_NONE]);
  assert.deepEqual(e(4, 2)!.lo, [EDGE_NONE, EDGE_NONE, 0]);
  // Its north-west corner: the back rims (silhouette against the ground behind), no vertical on a face you cannot see.
  const nw = e(2, 2)!;
  assert.equal(nw.top, EDGE_N | EDGE_W);
  assert.deepEqual(nw.lo, [EDGE_NONE, EDGE_NONE, EDGE_NONE]);
  // A middle cell of the south side: its left face continues on both sides, so no vertical but the rim.
  const s = e(3, 4)!;
  assert.equal(s.top, EDGE_S);
  assert.deepEqual(s.lo, [EDGE_NONE, EDGE_NONE, EDGE_NONE]);
  // The ground in front of the block's south side: where the wall meets it is behind this cell — a back edge, the foot.
  assert.equal(e(3, 5)!.top, EDGE_N);
  // The ground behind the block (north of it): the block stands in front, its edge is hidden — nothing.
  assert.equal(e(3, 1), undefined);
  // A course of the corner column carries the verticals from its storey down to the ground.
  const cell = { edge: se } as never;
  assert.equal(courseEdgeBits(cell, 2), "2");
  assert.equal(courseEdgeBits(cell, 1), "2");
  assert.equal(courseEdgeBits(cell, 0), "", "the storey at ground level is under the ground in front");
});

test("a full (100%) ramp draws no border, and the terrace it climbs to meets it with none; a stair keeps its edges", { skip }, () => {
  // A one-storey terrace north of a strip of ground: a straight rise, every cell of the strip a ramp.
  const lv = Array.from({ length: 6 }, (_, y) => Array.from({ length: 8 }, () => (y <= 2 ? 1 : 0)));
  const { g, L } = grid(lv);
  const full = resolver(1);
  assert.ok(full.rampIndexFor(g, L, "grass", 3, 3, 0), "the cell below the rise is a ramp");
  assert.equal(full.edgeSet(g, L, 3, 3), undefined, "a 100% ramp draws no border");
  assert.equal((full.edgeSet(g, L, 3, 2)?.top ?? 0) & EDGE_S, 0, "the terrace's rim over a full ramp is not an edge: the surfaces meet");
  const stair = resolver(-0.01);
  assert.equal((stair.edgeSet(g, L, 3, 2)?.top ?? 0) & EDGE_S, EDGE_S, "slopes off: the terrace's rim is an edge");
  assert.equal((stair.edgeSet(g, L, 3, 3)?.top ?? 0) & EDGE_N, EDGE_N, "and the step below has its foot line");
  const half = resolver(0.5);
  assert.equal((half.edgeSet(g, L, 3, 2)?.top ?? 0) & EDGE_S, EDGE_S, "a 50% ramp leaves a riser: the rim above it is an edge");
});

test("the ink: the chosen edges only, the outer line on the last texel of art and a lighter inner line inside it; a course's corners and crease; the cap trimmed to the diamond", { skip }, () => {
  const PAT = load("tiles/patterns/index.json");
  const p = patternSheetPaths(PAT);
  const img = (rel: string): Pixels => {
    const i = imgRGBA(join(REPO, rel)) as { width: number; height: number; data: ArrayLike<number> };
    return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) };
  };
  const S = patternSheets(PAT, img(p.silhouette), img(p.masks), img(p.border));
  // A white top face in the library diamond, nothing else.
  const white: Pixels = { w: S.fw, h: S.fh, data: new Uint8ClampedArray(S.fw * S.fh * 4) };
  for (let i = 0; i < S.fw * S.fh; i++) if (S.libTop[i] > 0) white.data.fill(255, i * 4, i * 4 + 4);
  // On an all-white raster the tile's mean is white, so the line is white darkened: the same RELATIVE shade on any ground.
  const OUT = Math.round(255 * (1 - EDGE_ALPHA) + 255 * EDGE_SHADE * EDGE_ALPHA);
  const IN = Math.round(255 * (1 - EDGE_ALPHA_IN) + 255 * EDGE_SHADE_IN * EDGE_ALPHA_IN);
  const at = (a: Pixels, x: number, y: number) => a.data[(y * a.w + x) * 4];
  const e = edgeTopPixels(S, white, EDGE_E);
  for (let x = 0; x < S.fw; x++) {
    let last = -1;
    for (let y = 0; y < S.fh; y++) if (S.libTop[y * S.fw + x] > 0) last = y;
    if (last < 0) continue;
    // The down-right edge is the columns right of the bottom vertex; the vertex texel of the other edge is the next cell's.
    if (x >= 32) {
      assert.equal(at(e, x, last), OUT, `column ${x}: the outer line is the last texel`);
      if (S.libTop[(last - 1) * S.fw + x] > 0) assert.equal(at(e, x, last - 1), IN, `column ${x}: the inner line just inside it`);
    } else assert.equal(at(e, x, last), 255, `column ${x}: another edge, no ink`);
  }
  assert.deepEqual(Array.from(edgeTopPixels(S, white, 0).data), Array.from(white.data), "no mask, no ink");
  // A back edge whose art is rounded a texel past the diamond: that texel is cleared, nothing of the top outside the line.
  const round: Pixels = { w: white.w, h: white.h, data: new Uint8ClampedArray(white.data) };
  let top40 = 0;
  while (S.libTop[top40 * S.fw + 40] === 0) top40++;
  round.data.fill(255, ((top40 - 1) * S.fw + 40) * 4, ((top40 - 1) * S.fw + 40) * 4 + 4);
  const r = edgeTopPixels(S, round, EDGE_N);
  assert.equal(r.data[((top40 - 1) * S.fw + 40) * 4 + 3], 0);
  assert.equal(at(r, 40, top40), OUT);
  // A course: corners down the outermost texel with the inner line beside, the crease ONE column.
  const course: Pixels = { w: 64, h: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) };
  const c = edgeCoursePixels(S, course, "5");
  assert.equal(at(c, 0, 30), OUT);
  assert.equal(at(c, 1, 30), IN);
  assert.equal(at(c, 63, 30), OUT);
  assert.equal(at(c, 62, 30), IN);
  const k = edgeCoursePixels(S, course, "2");
  assert.equal(at(k, 31, 45), OUT);
  assert.equal(at(k, 32, 45), 255, "one texel wide");
  assert.equal(at(k, 31, 20), 255, "no crease above the bottom vertex");
  // Relative, not absolute: on a mid-grey course the outer line is that grey darkened by the same share.
  const grey: Pixels = { w: 64, h: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(128) };
  for (let i = 3; i < grey.data.length; i += 4) grey.data[i] = 255;
  assert.equal(at(edgeCoursePixels(S, grey, "1"), 0, 30), Math.round(128 * (1 - EDGE_ALPHA) + 128 * EDGE_SHADE * EDGE_ALPHA));
  // The cap's top face trimmed to the library diamond all round.
  const t = edgeCoursePixels(S, course, "8");
  assert.equal(t.data[(5 * 64 + 40) * 4 + 3], 0);
  assert.equal(t.data[(5 * 64 + 20) * 4 + 3], 0);
});

test("a plateau's outline painted in draw order is one closed line, one texel wide, joined only diagonally, whichever cell lands last", { skip }, () => {
  const PAT = load("tiles/patterns/index.json");
  const p = patternSheetPaths(PAT);
  const img = (rel: string): Pixels => {
    const i = imgRGBA(join(REPO, rel)) as { width: number; height: number; data: ArrayLike<number> };
    return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) };
  };
  const S = patternSheets(PAT, img(p.silhouette), img(p.masks), img(p.border));
  // A plate: the library diamond and its margin row, white.
  const plate: Pixels = { w: S.fw, h: S.fh, data: new Uint8ClampedArray(S.fw * S.fh * 4) };
  for (let i = 0; i < S.fw * S.fh; i++) if (S.libTop[i] > 0 || (i >= S.fw && S.libTop[i - S.fw] > 0)) plate.data.fill(255, i * 4, i * 4 + 4);
  const t = resolver(-0.01);
  // An irregular one-storey plateau: notches make every kind of vertex — V valleys, bottom V's, corner-touching cells.
  const shape = ["........", ".XXX.XX.", ".XXXXXX.", ".XX.XXX.", ".XXXX.X.", "..XXXXX.", "........"];
  const lv = shape.map((row) => [...row].map((c) => (c === "X" ? 1 : 0)));
  const { g, L } = grid(lv);
  const W = 8 * 64 + 128, H = 8 * 28 + 128;
  const canvas = new Uint8ClampedArray(W * H * 4);
  const cells: [number, number][] = [];
  for (let y = 0; y < lv.length; y++) for (let x = 0; x < lv[0].length; x++) if (lv[y][x]) cells.push([x, y]);
  // The painter's order: back to front, and along a row left to right.
  cells.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[0] - b[0]);
  (globalThis as { __edgeDebug?: boolean }).__edgeDebug = true;
  try {
    for (const [x, y] of cells) {
      const e = t.edgeSet(g, L, x, y);
      const nb = t.edgeNb(g, L, x, y);
      const px = edgeTopPixels(S, plate, e?.top ?? 0, undefined, 0, nb);
      const ox = (x - y) * 32 + 64 + 6 * 32, oy = (x + y) * 14 + 32;
      for (let j = 0; j < px.h; j++)
        for (let i = 0; i < px.w; i++) {
          const s = (j * px.w + i) * 4;
          if (px.data[s + 3] === 0) continue;
          const d = ((oy + j) * W + ox + i) * 4;
          canvas.set(px.data.subarray(s, s + 4), d);
        }
    }
  } finally {
    delete (globalThis as { __edgeDebug?: boolean }).__edgeDebug;
  }
  const red = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && canvas[(y * W + x) * 4] === 255 && canvas[(y * W + x) * 4 + 1] === 0;
  let n = 0;
  const bad: string[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!red(x, y)) continue;
      n++;
      let nb = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && red(x + dx, y + dy)) nb++;
      if (nb < 2) bad.push(`end ${x},${y}`);
      if (red(x + 1, y) && red(x, y + 1) && red(x + 1, y + 1)) bad.push(`2x2 ${x},${y}`);
      // An L (three texels of a 2x2): a join along the grid, not the diagonal.
      for (const [ax, ay] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) if (red(x + ax, y) && red(x, y + ay) && !red(x + ax, y + ay) && !(red(x - ax, y) || red(x, y - ay))) bad.push(`L ${x},${y}`);
    }
  if (process.env.DUMP) for (const b of bad.slice(0, 3)) { const [x0, y0] = b.split(" ")[1].split(",").map(Number); for (let y = y0 - 5; y <= y0 + 5; y++) { let row = ""; for (let x = x0 - 8; x <= x0 + 8; x++) row += red(x, y) ? "R" : canvas[(y * W + x) * 4 + 3] ? (canvas[(y * W + x) * 4 + 2] === 255 && canvas[(y * W + x) * 4] === 0 ? "B" : ".") : " "; console.log(b, row); } }
  assert.ok(n > 500, `the outline is drawn (${n} texels)`);
  assert.deepEqual(bad, [], "no end (a hole) and no doubled texel anywhere on the loop");
});
