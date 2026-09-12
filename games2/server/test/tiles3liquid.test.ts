// ============================================================================
// WATER LIES FLAT — a liquid corner votes on a boundary only at the cell's level
// ============================================================================
//
// `boundaryAt` lets a quad corner within BOUNDARY_STEP (one storey) of the
// drawing cell vote its own ground: a terrace rim or a stair is the same surface
// continuing, and the maintainer wants that eased. Water is not: one storey of
// tolerance composed the sea into the top face of the step ABOVE it — water
// running up a stair, on a cell a whole level clear of it (maintainer
// 2026-09-11, ringing the bottom step of a shore staircase at 277,269: "The
// ground on that stair has fucking water on it!"; 8 cells of the_game, every one
// land at level 1 beside water at 0). So a LIQUID corner votes only when its
// level equals the drawing cell's; a land corner keeps the one-storey vote, and
// a water cell still composes its land corner — the shore tile that is "not 100%
// water or 100% beach" (2026-09-09). render3's `wang_surface` carries the same
// clause (maps2, 2026-09-11); the parity fixture holds the two equal.
//
// The synthetic arms are data-free and run in the deploy gate's sparse checkout;
// the last arm reads the_game and skips without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3, viewFromDoc, isoFrame, BOUNDARY_STEP, type World3View } from "../../client/src/tiles3";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const rel = (p: string) => join(REPO, p);

/** A resolver with no art at all: the vote is pure, and a boundary it returns
 *  names its grounds and index even when no mask sheet is published. */
function bare(): Tiles3 {
  return new Tiles3({ baseTileSets: { grounds: {} }, memberResolve: { members: {} } as any, groundTypes: {} as any, patterns: {} as any, storeyPitch: 15, warn: () => {} });
}

function synthView(o: { size: number; level: (x: number, y: number) => number; ground: (x: number, y: number) => string }): World3View {
  const n = o.size;
  return {
    x0: 0, y0: 0, x1: n, y1: n, width: n, height: n, maxLevel: 8,
    groundAt: (x, y) => (x < 0 || y < 0 || x >= n || y >= n ? null : o.ground(x, y)),
    levelAt: (x, y) => (x < 0 || y < 0 || x >= n || y >= n ? 0 : o.level(x, y)),
    isLiquid: (g) => g === "water",
    wallSideAt: () => null,
    decks: [],
  };
}

/** The shore: land up-left of the x + y = 7 diagonal, water down-right of it,
 *  each at its own level. Cell (3,3) is land whose east, south and south-east
 *  corners are water; cell (4,4) is water whose own corner is land-free but
 *  whose quad is pure water; cell (3,4) is water with a land corner at (3,4)?
 *  No — (3,4) is 7, water. The land cell with water corners is (3,3); the
 *  water cell with a land corner is (2,5)... simpler: read the quads below. */
function shore(landLevel: number, waterLevel: number) {
  const land = (x: number, y: number) => x + y < 7;
  const view = synthView({
    size: 12,
    level: (x, y) => (land(x, y) ? landLevel : waterLevel),
    ground: (x, y) => (land(x, y) ? "dark_mud" : "water"),
  });
  const frame = isoFrame(view, view.maxLevel, 15);
  const g = (x: number, y: number) => view.groundAt(x, y);
  const L = (x: number, y: number) => view.levelAt(x, y);
  const at = (x: number, y: number) => bare().boundaryAt(view, frame, g, L, x, y);
  return { view, at };
}

const pairOf = (b: NonNullable<ReturnType<Tiles3["boundaryAt"]>>) => [b.boundary.a, b.boundary.b].sort();

test("a land cell one storey above the water keeps the water out of its top face", () => {
  assert.equal(BOUNDARY_STEP, 1, "the arm below assumes the one-storey rule");
  // The maintainer's step: dark_mud at level 1, the sea at level 0. The land
  // cell (3,3) has water on its east (4,3), south (3,4) and south-east (4,4)
  // corners, all one storey below — within BOUNDARY_STEP, so the old rule
  // composed water into it. Now every liquid corner folds to the cell's own
  // ground and the step draws its plain mud plate.
  const step = shore(1, 0);
  assert.equal(step.at(3, 3), null, "water one storey below the step composed into it");
  assert.equal(step.at(2, 4), null, "the same along the diagonal");
  // A liquid corner ABOVE the cell folds the same way: the rule is "at the
  // cell's own level", not "below it".
  const pool = shore(0, 1);
  assert.equal(pool.at(3, 3), null, "water one storey above the land composed into it");
});

test("at the water's own level the shore still composes, from both sides", () => {
  const beach = shore(0, 0);
  const b = beach.at(3, 3);
  assert.ok(b, "a land cell beside water at its own level composes the shore");
  assert.deepEqual(pairOf(b!), ["dark_mud", "water"]);
  assert.ok(b!.boundary.index !== 0 && b!.boundary.index !== 15);
  assert.equal(b!.boundary.topOnly, undefined, "a level-0 land cell keeps its full silhouette");
  // The WATER cell whose quad reaches the land: (4,2) is water (6? no: 4+2=6 is
  // land). Take (5,3): 8 → water; its corners (6,3) 9, (5,4) 9, (6,4) 10 are all
  // water. The water cell that SEES land is one whose up-left corner is its own
  // and whose other corners... a water cell's quad extends down-right, away
  // from the land, so on this diagonal no water cell composes; flip the world.
  const flipped = (landLevel: number, waterLevel: number) => {
    const water = (x: number, y: number) => x + y < 7;
    const view = synthView({
      size: 12,
      level: (x, y) => (water(x, y) ? waterLevel : landLevel),
      ground: (x, y) => (water(x, y) ? "water" : "dark_mud"),
    });
    const frame = isoFrame(view, view.maxLevel, 15);
    return (x: number, y: number) => bare().boundaryAt(view, frame, (a, c) => view.groundAt(a, c), (a, c) => view.levelAt(a, c), x, y);
  };
  // Water up-left, land down-right: the water cell (3,3) has land on its
  // east, south and south-east corners. Same level: it composes the shore...
  const same = flipped(0, 0)(3, 3);
  assert.ok(same, "a water cell beside land at its own level composes the shore");
  assert.deepEqual(pairOf(same!), ["dark_mud", "water"]);
  assert.equal(same!.boundary.topOnly, true, "a liquid cell's boundary is top face only");
  assert.equal(same!.boundary.noWall, true, "...and wears no wall");
  // ...and a LAND corner one storey up still votes on the water cell (land
  // keeps the one-storey rule: the sea composes the beach step above it, the
  // shore tile that is "not 100% water or 100% beach"), while the land cell on
  // the other side of that same edge keeps the water out (the arm above).
  const stepped = flipped(1, 0)(3, 3);
  assert.ok(stepped, "a land corner one storey up still composes on the water cell");
  assert.deepEqual(pairOf(stepped!), ["dark_mud", "water"]);
  // Two storeys up is beyond BOUNDARY_STEP for land too.
  assert.equal(flipped(2, 0)(3, 3), null, "land two storeys up does not vote");
});

const NEEDS = ["maps2/worlds3/the_game/world.json", "tiles/ground_types.json", "tiles/patterns/index.json", "tiles/review/manifest.json", "tiles/resolve.json", "live/tuning/base_tile_sets.json", "live/feedback/tiles.json"];
const MISSING = NEEDS.filter((p) => !existsSync(rel(p)));
test("on the_game, no land cell composes a liquid that stands off its own level", { skip: !!MISSING.length }, () => {
  const load = (p: string): any => JSON.parse(readFileSync(rel(p), "utf8"));
  const doc = load("maps2/worlds3/the_game/world.json");
  const t = new Tiles3({
    baseTileSets: load("live/tuning/base_tile_sets.json"),
    memberResolve: load("tiles/resolve.json"),
    groundTypes: load("tiles/ground_types.json").grounds,
    patterns: load("tiles/patterns/index.json"),
    review: load("tiles/review/manifest.json"),
    feedback: load("live/feedback/tiles.json").entries,
    storeyPitch: 15,
    warn: () => {},
  });
  const view = viewFromDoc(doc);
  const frame = isoFrame(view, view.maxLevel, 15);
  const g = (x: number, y: number) => view.groundAt(x, y);
  const L = (x: number, y: number) => view.levelAt(x, y);
  let steps = 0; // land cells with a liquid corner within one storey but off their level
  let composedLiquid = 0;
  let shore = 0; // land cells with a liquid corner AT their level, which still compose
  for (let y = 0; y < view.height - 1; y++)
    for (let x = 0; x < view.width - 1; x++) {
      const g0 = g(x, y);
      if (!g0 || view.isLiquid(g0)) continue;
      const z0 = L(x, y);
      let off = false;
      let on = false;
      for (const [cx, cy] of [[x + 1, y], [x, y + 1], [x + 1, y + 1]] as const) {
        const gv = g(cx, cy);
        if (!gv || !view.isLiquid(gv)) continue;
        const dz = Math.abs(L(cx, cy) - z0);
        if (dz === 0) on = true;
        else if (dz <= BOUNDARY_STEP) off = true;
      }
      if (!off && !on) continue;
      const b = t.boundaryAt(view, frame, g, L, x, y);
      if (off) {
        steps++;
        if (b && (view.isLiquid(b.boundary.a) || view.isLiquid(b.boundary.b))) composedLiquid++;
      } else if (b && (view.isLiquid(b.boundary.a) || view.isLiquid(b.boundary.b))) shore++;
    }
  assert.ok(steps >= 8, `the_game has ${steps} shore steps — maps2 counted 8, the gate cannot see the bug it exists for`);
  assert.equal(composedLiquid, 0, `${composedLiquid} of ${steps} steps still compose the liquid below them`);
  assert.ok(shore > 0, "the shore at the water's own level must still compose, or the rule folded too much");
  console.log(`    the_game: ${steps} land cells with a liquid corner off their level, none composing it; ${shore} shore cells at the water's level still compose`);
});
