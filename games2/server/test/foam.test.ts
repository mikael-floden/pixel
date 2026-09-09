// SEA FOAM sits on the game's own lines, and this is what pins it there.
//
// Two lines. The wall's foot is the games agent's `footBand`: it paints two
// crest rows lifted toward white under a face that goes into the water, and the
// foam's `crestPixels` is that loop ported. Rather than trust the port, this
// COMPOSES THE GAME'S BAND and reads the crest back out of it by colour, then
// demands the two pixel sets be identical — if the games agent ever moves the
// crest, this test fails before the maintainer sees foam floating off his line.
// The coast is the seam in a composed Wang tile: a synthetic mask here, the
// published sheet in the browser gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { footBand } from "../../client/src/tiles3draw.js";
import {
  BRIGHT,
  D_MAX,
  FRAMES,
  NONE,
  SOFT,
  TILE,
  TOP_ROWS,
  bakeCell,
  coastPixels,
  crestPixels,
  diamondTop,
  foamAt,
  nearestEdge,
  phase,
  waterBits,
} from "../../ambient/foam/raster.js";

const PITCH = 15; // the_game's measured storey
const WATER: [number, number, number] = [74, 152, 161];
const WALLRGB: [number, number, number] = [80, 80, 82];

/** The crest the GAME paints: pixels of footBand whose colour is the water
 *  lifted toward white (FOOT_CREST 0.5 and 0.22 — anything lifted at all). */
function gameCrest(walls: string): Set<number> {
  const px = footBand(walls, WALLRGB, PITCH, WATER);
  const out = new Set<number>();
  for (let y = 0; y < TOP_ROWS; y++)
    for (let x = 0; x < TILE; x++) {
      const i = (y * TILE + x) * 4;
      if (px.data[i + 3] === 0) continue;
      const [r, g, b] = [px.data[i], px.data[i + 1], px.data[i + 2]];
      // lifted toward white: every channel above the water AND above the sunk wall
      if (r > WATER[0] + 20 && g > WATER[1] + 20 && b > WATER[2] + 15) out.add(y * TILE + x);
    }
  return out;
}

test("the crest is the game's crest, pixel for pixel, for every wall combination", () => {
  const combos: [string, { ul?: boolean; ur?: boolean; uu?: boolean }][] = [
    ["ul", { ul: true }],
    ["ur", { ur: true }],
    ["uu", { uu: true }],
    ["ul+ur", { ul: true, ur: true }],
    ["ul+uu", { ul: true, uu: true }],
    ["ur+uu", { ur: true, uu: true }],
    ["ul+ur+uu", { ul: true, ur: true, uu: true }],
  ];
  for (const [walls, foot] of combos) {
    const mine = new Set(crestPixels(foot, PITCH));
    const game = gameCrest(walls);
    assert.ok(game.size > 0, `${walls}: the game paints a crest`);
    const missing = [...game].filter((i) => !mine.has(i));
    const extra = [...mine].filter((i) => !game.has(i));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${walls}: crest parity (game ${game.size}, foam ${mine.size})`);
  }
});

test("the crest sits two rows under the shared edge at this pitch", () => {
  // At column 20 the up-left edge is at row 5.03, so the crest is rows 7 and 8
  // (measured on the_game at cell 280,235: the lifted rows were 7 and 8).
  const rows = crestPixels({ ul: true }, PITCH).filter((i) => i % TILE === 20).map((i) => Math.floor(i / TILE));
  assert.deepEqual(rows, [7, 8]);
});

test("coast pixels are water pixels with land beside them, inside the top face", () => {
  const top = diamondTop();
  // a synthetic seam: water where px + py*2 > 60 (a diagonal cut)
  const water = waterBits(top, false, (px, py) => px + py * 2 > 60, true);
  const coast = coastPixels(water, top);
  assert.ok(coast.length > 20, "a diagonal seam across the face yields a line of coast pixels");
  for (const i of coast) {
    const px = i % TILE, py = Math.floor(i / TILE);
    assert.equal(water[i], 1, "a coast pixel is water");
    const land = [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]].some(
      ([x, y]) => x >= 0 && y >= 0 && x < TILE && y < TOP_ROWS && top[y * TILE + x] && !water[y * TILE + x],
    );
    assert.ok(land, `(${px},${py}) touches land`);
  }
  // the diamond's own outline is not a coast: a pure water tile has none
  assert.equal(coastPixels(waterBits(top, true, null, false), top).length, 0);
});

test("a water/water seam and a pure cell carry no coast", () => {
  const top = diamondTop();
  assert.equal(coastPixels(waterBits(top, true, null, true), top).length, 0);
});

test("the animation loops, stays in its band, and never paints past the swash on land", () => {
  const edges = [{ x: 100, y: 50, hard: 0 as const }];
  // d < -1 (deep on land) is never foam; d in [-1,0) only during contact
  for (let k = 0; k < FRAMES; k++) {
    const u = k / FRAMES;
    for (let X = 90; X < 110; X++) for (let Y = 40; Y < 60; Y++) {
      assert.equal(foamAt(-2, false, X, Y, u), NONE);
      assert.equal(foamAt(D_MAX + 1, false, X, Y, u), NONE);
      assert.equal(foamAt(D_MAX + 1, true, X, Y, u), NONE);
    }
  }
  // loop: frame FRAMES is frame 0
  for (let X = 0; X < 40; X++) assert.equal(foamAt(2, false, X, 7, 0), foamAt(2, false, X, 7, 1));
  // something is drawn somewhere in the cycle for a pixel on the line
  let lit = 0;
  for (let k = 0; k < FRAMES; k++) if (foamAt(0.5, false, 12, 34, k / FRAMES) !== NONE) lit++;
  assert.ok(lit > 0, "the line is wet at some point of the cycle");
  // and a wall's contact is BRIGHT on the crest
  let bright = 0;
  for (let k = 0; k < FRAMES; k++) if (foamAt(0.5, true, 12, 34, k / FRAMES) === BRIGHT) bright++;
  assert.ok(bright > 0, "the wall's crest goes bright when the wave hits");
  void SOFT;
  void nearestEdge(0, 0, edges);
});

test("the phase is continuous: neighbouring pixels are nearly in step", () => {
  for (let X = 0; X < 500; X += 7)
    for (let Y = 0; Y < 300; Y += 5) {
      const a = phase(X, Y), b = phase(X + 1, Y);
      const d = Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
      assert.ok(d < 0.05, `phase jumps ${d.toFixed(3)} between (${X},${Y}) and its neighbour`);
    }
});

test("bakeCell keeps foam within reach of an edge, off invisible pixels, and trims the sheet", () => {
  const top = diamondTop();
  const water = waterBits(top, true, null, false);
  // a crest along the up-left edge of a cell at (1000, 500)
  const edges = crestPixels({ ul: true }, PITCH).map((i) => ({ x: 1000 + (i % TILE), y: 500 + Math.floor(i / TILE), hard: 1 as const }));
  const hidden = (X: number) => X >= 1000 + 40; // pretend a plateau covers the right side
  const bake = bakeCell({ sx: 1000, sy: 500, water, top, edges, visible: (X) => !hidden(X), waterRGB: WATER });
  assert.ok(bake, "a cell with a crest bakes");
  assert.equal(bake!.frames, FRAMES);
  assert.ok(bake!.w <= TILE && bake!.h <= TOP_ROWS);
  assert.ok(bake!.bx + bake!.w <= 40, `nothing baked on the covered side (bbox reaches ${bake!.bx + bake!.w})`);
  // every painted pixel is within D_MAX of an edge
  for (let k = 0; k < FRAMES; k++)
    for (let y = 0; y < bake!.h; y++)
      for (let x = 0; x < bake!.w; x++) {
        const o = (y * (bake!.w * FRAMES) + k * bake!.w + x) * 4;
        if (bake!.data[o + 3] === 0) continue;
        const n = nearestEdge(1000 + bake!.bx + x, 500 + bake!.by + y, edges);
        assert.ok(n && n.d <= D_MAX, `painted pixel (${x},${y}) frame ${k} is off the band`);
      }
});
