// A BRIDGE IS MADE OF WHAT IT IS MADE OF, not of the water it spans.
//
// Speed comes from the surface under the feet, and that was read from the BASE
// terrain — which under a bridge is the water or chasm the bridge crosses. So
// crossing a plank/snow/dirt walkway ran at SWIM speed (maintainer 2026-08-09:
// "I don't want players to run slower over bridges. The ground type decides the
// speed as normal").
//
// Driven off the REAL the_island2 world.json rather than a hand-built fixture:
// the bug only exists where a deck actually sits over water, and a fixture that
// asserts the rule would not have caught the shipped map changing under it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWorld,
  buildTerrainGrid,
  surfaceAtWorld,
  surfaceAtWorldElev,
  surfaceFor,
  CELL_WU,
} from "@nangijala/shared";

const here = dirname(fileURLToPath(import.meta.url));
const world = parseWorld(
  JSON.parse(readFileSync(join(here, "..", "..", "..", "maps2", "worlds", "the_island2", "world.json"), "utf8")),
)!;
const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props ?? [], world.decks ?? []);
const at = (col: number, row: number) => ({ x: (col + 0.5) * CELL_WU, y: (row + 0.5) * CELL_WU });

test("the deck's own material is carried per cell", () => {
  const deckCells = grid.deck.map((d, i) => (d >= 0 ? i : -1)).filter((i) => i >= 0);
  assert.ok(deckCells.length > 0, "the_island2 ships decks");
  const typed = deckCells.filter((i) => grid.deckType[i]);
  assert.equal(typed.length, deckCells.length, "every deck cell knows what it is made of");
});

test("a bridge over water runs at the BRIDGE's speed, not the water's", () => {
  // Every deck cell whose BASE is swimmable — i.e. the ones the bug was about.
  const overWater = grid.deck
    .map((d, i) => ({ i, d }))
    .filter(({ i, d }) => d >= 0 && surfaceFor(grid.type[i] || "").swimmable);
  assert.ok(overWater.length > 0, "the_island2 has a bridge spanning water");

  let checked = 0;
  for (const { i, d } of overWater) {
    const col = i % grid.width;
    const row = (i - col) / grid.width;
    const p = at(col, row);
    const onDeck = surfaceAtWorldElev(grid, p.x, p.y, d);
    const deckMat = surfaceFor(grid.deckType[i]);
    assert.equal(onDeck.speed, deckMat.speed, `deck cell ${col},${row} must run at its own material's speed`);
    assert.equal(onDeck.swimmable, false, `deck cell ${col},${row} is a walkway, not a swim`);
    // ...and the water is still down there for anyone under the span.
    const under = surfaceAtWorldElev(grid, p.x, p.y, grid.level[i]);
    assert.equal(under.swimmable, true, `under the span at ${col},${row} is still water`);
    checked++;
  }
  assert.ok(checked >= 1);
});

test("a cell with no deck is byte-identical to surfaceAtWorld", () => {
  // The whole point of an elevation-aware lookup is that it changes NOTHING
  // anywhere else — every world@1 map has no decks at all.
  let n = 0;
  for (let i = 0; i < grid.deck.length && n < 4000; i += 37) {
    if (grid.deck[i] >= 0) continue;
    const col = i % grid.width;
    const row = (i - col) / grid.width;
    const p = at(col, row);
    const a = surfaceAtWorld(grid, p.x, p.y);
    const b = surfaceAtWorldElev(grid, p.x, p.y, grid.level[i]);
    assert.deepEqual(b, a, `no-deck cell ${col},${row} must resolve exactly as before`);
    n++;
  }
  assert.ok(n > 100, `sampled ${n} deck-free cells`);
});
