// LAVA IS WATER TO THE GAME'S PROBE. That sentence is the whole reason
// `ambient/runtime/water.ts` exists, and this file is what stops it coming
// back.
//
// `isWaterAtScreen` answers `!standable && swimmable`, and
// `shared/src/surfaces.ts` gives lava BOTH of those — plus `sound: "water"`.
// Every field of lava's surface record is a lake's except `harm`. Measured at
// the world's lava lake before the fix: 42 of 52 molten sample points answered
// `waterAtScreen` true, `crabs/` had strung a colony along a 480 px
// "shoreline", `fish/` reported lakeFrac 0.28, and `water/` was painting
// wavelets and a moon glint on molten rock. The maintainer saw it and asked
// "Why did you place crabs near the lava?".
//
// The SECOND thing pinned here is the part that made the obvious fix wrong.
// A harm check hung on `pickAt` alone still passed the colony, because THE TWO
// PROBES DISAGREE at a lava edge: `waterAtScreen` walks the drawn faces and
// answers about the front-most one, `pickAt` resolves the cell you would stand
// in. 16 px off the colony's home, measured live, `waterAtScreen` said TRUE
// while `pickAt` + `surfaceAt` said stone / swimmable false / harm 0. So
// harmless water needs BOTH probes to AGREE, and every disagreement resolves
// to "not water".
import { test } from "node:test";
import assert from "node:assert/strict";
import { burnsAt, swimmableAt, waterAt } from "../../ambient/runtime/water.js";

type Surface = { swimmable?: boolean; harm?: number; sound?: string };
type Cell = { water: boolean; surface: Surface | null };

const w = globalThis as { window?: unknown };

/** Install a world where each world-unit x maps to its own cell, so the
 *  module's per-cell memo never crosses two cases. */
function world(cells: Record<number, Cell>, opts: { picker?: boolean } = {}) {
  const picker = opts.picker !== false;
  let surfaceCalls = 0;
  const ml: Record<string, unknown> = {
    waterAtScreen: (x: number) => !!cells[x]?.water,
  };
  if (picker) {
    ml.pickAt = (x: number, y: number) => (cells[x] ? { x, y } : null);
    ml.surfaceAt = (x: number) => {
      surfaceCalls++;
      return cells[x]?.surface ?? null;
    };
  }
  w.window = { __ml: ml };
  return { surfaceCalls: () => surfaceCalls };
}

const lake = (x: number): Record<number, Cell> => ({
  [x]: { water: true, surface: { swimmable: true, harm: 0, sound: "water" } },
});
// lava's REAL record, copied from shared/src/surfaces.ts
const lava = (x: number): Record<number, Cell> => ({
  [x]: { water: true, surface: { swimmable: true, harm: 4, sound: "water" } },
});

test("a lake is water; LAVA IS NOT, though the game's own probe calls it water", () => {
  world(lake(10));
  assert.equal(waterAt(10, 0), true, "a real lake must still be water");

  world(lava(20));
  // the trap, asserted from the failing side: the raw probe says yes
  assert.equal(swimmableAt(20, 0), true, "the game's probe calls lava water — that is the premise");
  assert.equal(waterAt(20, 0), false, "lava must not be water to an ambient effect");
  assert.equal(burnsAt(20, 0), true);
  assert.equal(burnsAt(10, 0), false);
});

test("the two probes disagreeing resolves to NOT water — the case that beat the first fix", () => {
  // exactly what was measured 16 px off the crab colony's home
  world({ 30: { water: true, surface: { swimmable: false, harm: 0, sound: "stone" } } });
  assert.equal(swimmableAt(30, 0), true, "the draw probe says water");
  assert.equal(
    waterAt(30, 0),
    false,
    "a pixel the game itself is of two minds about is not somewhere to anchor a creature",
  );
});

test("dry land is not water, and costs no second probe", () => {
  const h = world({ 40: { water: false, surface: { swimmable: false, harm: 0 } } });
  assert.equal(waterAt(40, 0), false);
  assert.equal(h.surfaceCalls(), 0, "most of the world is dry — the cheap probe must gate the pair");
});

test("the second probe is paid ONCE PER CELL, not once per call", () => {
  const h = world(lake(50));
  for (let i = 0; i < 25; i++) waterAt(50, 0);
  assert.equal(h.surfaceCalls(), 1, "a cell's surface never changes at runtime");
});

test("an older build with no picker keeps the old permissive answer", () => {
  world(lake(60), { picker: false });
  assert.equal(waterAt(60, 0), true);
  // ...but a picker that ANSWERS NOTHING is believed, not worked around
  world({ 70: { water: true, surface: null } });
  assert.equal(waterAt(70, 0), false);
  assert.equal(burnsAt(70, 0), false, "unknown is not burning");
});

test("no probe surface at all, and a throwing one, answer false rather than crash", () => {
  w.window = {};
  assert.equal(waterAt(80, 0), false);
  assert.equal(swimmableAt(80, 0), false);
  assert.equal(burnsAt(80, 0), false);

  w.window = {
    __ml: {
      waterAtScreen: () => { throw new Error("boom"); },
      pickAt: () => { throw new Error("boom"); },
      surfaceAt: () => { throw new Error("boom"); },
    },
  };
  assert.equal(waterAt(90, 0), false);
  assert.equal(swimmableAt(90, 0), false);
  assert.equal(burnsAt(90, 0), false);

  delete w.window;
});
