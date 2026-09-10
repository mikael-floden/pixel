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
  CREST_ROWS,
  D_MAX,
  FOOT_UNDER,
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

/** THE CREST ROWS THE GAME PAINTS, per column, read out of its own band.
 *
 *  A crest pixel is opaque and its colour is the LIQUID LERPED TOWARD WHITE —
 *  detected as a lerp rather than by the published constants, so the games
 *  agent may re-tune how far each row lifts without this test caring, while
 *  moving the crest itself still fails it.
 *
 *  The band's top rows are painted crest-coloured too and are COVERED by the
 *  face sprite (2026-09-10, so a fractional device scale cannot show a dark
 *  seam where the two draw paths meet). The foam wants the rows you can
 *  actually see, which are the bottom of that run — asserted below as exactly
 *  that, so a change to FOOT_UNDER moves both or fails here. */
function gameCrestRuns(walls: readonly { dir: "ul" | "ur" | "uu"; wall: readonly [number, number, number] }[]) {
  const px = footBand(walls, PITCH, WATER);
  const runs = new Map<number, number[]>();
  const lerpT = (v: number, from: number) => (v - from) / (255 - from);
  for (let y = 0; y < TOP_ROWS; y++)
    for (let x = 0; x < TILE; x++) {
      const i = (y * TILE + x) * 4;
      if (px.data[i + 3] !== 255) continue;
      const t = [0, 1, 2].map((k) => lerpT(px.data[i + k], WATER[k]));
      if (t.some((v) => v <= 0.02 || v >= 0.98)) continue; // the water itself, or white
      if (Math.max(...t) - Math.min(...t) > 0.06) continue; // not on the water->white line
      if (!runs.has(x)) runs.set(x, []);
      runs.get(x)!.push(y);
    }
  for (const v of runs.values()) v.sort((a, b) => a - b);
  return runs;
}

test("the foam's crest is the VISIBLE part of the game's crest, column by column", () => {
  const combos: { dir: "ul" | "ur" | "uu" }[][] = [
    [{ dir: "ul" }],
    [{ dir: "ur" }],
    [{ dir: "uu" }],
    [{ dir: "ul" }, { dir: "ur" }],
    [{ dir: "ul" }, { dir: "uu" }],
    [{ dir: "ur" }, { dir: "uu" }],
    [{ dir: "ul" }, { dir: "ur" }, { dir: "uu" }],
  ];
  for (const dirs of combos) {
    const label = dirs.map((d) => d.dir).join("+");
    const runs = gameCrestRuns(dirs.map((d) => ({ ...d, wall: WALLRGB })));
    assert.ok(runs.size > 0, `${label}: the game paints a crest`);
    const mine = new Map<number, number[]>();
    for (const i of crestPixels(Object.fromEntries(dirs.map((d) => [d.dir, true])), PITCH)) {
      const x = i % TILE;
      if (!mine.has(x)) mine.set(x, []);
      mine.get(x)!.push(Math.floor(i / TILE));
    }
    for (const v of mine.values()) v.sort((a, b) => a - b);
    for (const [x, run] of runs) {
      // the run is contiguous: it is one band, not scattered pixels
      for (let k = 1; k < run.length; k++)
        assert.equal(run[k], run[k - 1] + 1, `${label} col ${x}: the game's crest run is contiguous`);
      /* THE FOAM'S CREST IS A SUFFIX OF THE GAME'S RUN, and it drops at most
       * the covered rows. Stated this way rather than as a fixed slice
       * because a run can be clipped at EITHER end: for an up-left or
       * up-right wall the band starts exactly at the diamond's upper edge
       * (DY*(1-(u+DX)/DX) IS DY*|u|/DX), but for the straight-up wall it
       * starts a row or two ABOVE the diamond, so at the flanks the covered
       * rows are clipped away and the whole visible run is crest. A fixed
       * `slice(FOOT_UNDER)` demanded nothing at uu column 29, where the game
       * paints two rows and both are visible. */
      const got = mine.get(x) ?? [];
      assert.ok(run.length <= FOOT_UNDER + CREST_ROWS, `${label} col ${x}: the game's crest is ${run.length} rows, expected at most ${FOOT_UNDER + CREST_ROWS}`);
      assert.deepEqual(got, run.slice(run.length - got.length), `${label} col ${x}: foam crest ${got.join(",")} is not the bottom of the game's run ${run.join(",")}`);
      assert.ok(run.length - got.length <= FOOT_UNDER, `${label} col ${x}: foam drops ${run.length - got.length} rows of the game's crest, at most ${FOOT_UNDER} are covered`);
      if (run.length === FOOT_UNDER + CREST_ROWS)
        assert.equal(got.length, CREST_ROWS, `${label} col ${x}: a complete run shows exactly ${CREST_ROWS} crest rows`);
    }
    // and the foam claims no column the game does not paint
    for (const x of mine.keys()) assert.ok(runs.has(x), `${label} col ${x}: foam paints a column the game leaves alone`);
  }
});

test("the crest sits two rows under the shared edge at this pitch", () => {
  // At column 20 the up-left edge is at row 5.03, so the crest is rows 7 and 8
  // (measured on the_game at cell 280,235: the lifted rows were 7 and 8).
  const rows = crestPixels({ ul: true }, PITCH).filter((i) => i % TILE === 20).map((i) => Math.floor(i / TILE));
  assert.deepEqual(rows, [7, 8]);
});

test("a wall's own material never changes what the foam calls the crest", () => {
  // Each wall now brings its own colour (2026-09-09, so the material change
  // falls on the vertical through a corner). The crest is the LIQUID lifted,
  // so it must be identical whatever the walls are made of.
  const a = gameCrestRuns([{ dir: "ul", wall: [80, 80, 82] }, { dir: "ur", wall: [200, 170, 120] }]);
  const b = gameCrestRuns([{ dir: "ul", wall: [30, 90, 40] }, { dir: "ur", wall: [240, 240, 240] }]);
  assert.deepEqual([...a.entries()].map(([k, v]) => [k, v.join(",")]), [...b.entries()].map(([k, v]) => [k, v.join(",")]));
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
