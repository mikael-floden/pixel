// ============================================================================
// TILES3 RUNTIME — the per-cell path IS the proven sweep, cell for cell
// ============================================================================
//
// `client/src/tiles3.ts` is proven against render3 by tiles3.test.ts, and its
// proof runs through ONE entry point: `resolveWindow`, a whole-window sweep
// that allocates per cell (~420ms on the_game). A streaming renderer cannot
// call it per frame, so `client/src/tiles3runtime.ts` takes the same decisions
// one cell at a time out of the resolver's public primitives — and a port of a
// port is exactly where a world starts rendering beautifully and wrongly.
//
// So this gate closes the loop: for the fixture's own windows, resolve every
// cell, every lattice corner and every deck cell BOTH ways and require deep
// equality. Nothing here re-states render3; it states that the fast path and
// the proven path are the same path.
//
// SKIPPED, NOT FAILED, WHEN THE DATA IS ABSENT — same guard as tiles3.test.ts
// (the deploy's test job sparse-checks-out neither maps2/worlds3 nor tiles/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Tiles3,
  isoFrame,
  measureStoreyPitch,
  viewFromDoc,
  type Tiles3Data,
  type World3View,
  type Deck3,
} from "../../client/src/tiles3";
import { Tiles3World, viewFromParsed } from "../../client/src/tiles3runtime";
import { parseWorld } from "@nangijala/shared";
// @ts-expect-error — plain .mjs helper shared with the build scripts
import { imgRGBA } from "../../scripts/imagelib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const rel = (p: string) => join(REPO, p);
const FIXTURE = join(HERE, "fixtures", "tiles3-parity.json");
const NEEDS = [
  "maps2/worlds3/the_game/world.json",
  "tiles/resolve.json",
  "tiles/ground_types.json",
  "tiles/patterns/index.json",
  "tiles/review/manifest.json",
  "tiles/fades/index.json",
  "live/tuning/base_tile_sets.json",
  "live/tuning/base_tiles.json",
  "live/tuning/tile_walls.json",
  "live/feedback/tiles.json",
];
const MISSING = [FIXTURE, ...NEEDS.map(rel)].filter((p) => !existsSync(p));
const load = (p: string): any => JSON.parse(readFileSync(rel(p), "utf8"));
const F: any = MISSING.length ? null : JSON.parse(readFileSync(FIXTURE, "utf8"));
const doc: any = F ? load(F.world.path) : null;

if (MISSING.length) {
  test(`tiles3 runtime parity SKIPPED — not in this checkout: ${MISSING.map((m) => m.replace(REPO + "/", "")).join(", ")}`, () => {
    assert.ok(true);
  });
}

/* THE SAME DATA THE RESOLVER'S OWN GATE BUILDS, minus the fade guard: the game
 * cannot run it (it is a pixel test over art the pool has not fetched yet), so
 * the runtime and the sweep are compared under the game's own conditions. Both
 * sides get the identical `Tiles3` instance, so a guard difference cannot hide
 * a port difference. */
function data(storeyPitch: number): Tiles3Data {
  const groundTypes = load("tiles/ground_types.json").grounds;
  return {
    baseTileSets: load("live/tuning/base_tile_sets.json"),
    memberResolve: load("tiles/resolve.json"),
    groundTypes,
    patterns: load("tiles/patterns/index.json"),
    storeyPitch,
    review: load("tiles/review/manifest.json"),
    feedback: load("live/feedback/tiles.json").entries,
    wallOverrides: load("live/tuning/tile_walls.json").overrides,
    basePromotions: load("live/tuning/base_tiles.json").overrides,
    fades: load("tiles/fades/index.json"),
    warn: () => {},
  };
}

function pitchOf(t: Tiles3): number {
  const art = t.overTile("grey_stone", "grey_stone");
  const { width, height, data: px } = imgRGBA(rel(art.path as string)) as {
    width: number;
    height: number;
    data: Uint8Array;
  };
  return measureStoreyPitch(width, height, (x, y) => px[(y * width + x) * 4 + 3] > 128) || 16;
}

test("the per-cell runtime resolves exactly what the proven sweep resolves", { skip: !!MISSING.length }, () => {
  const pitch = pitchOf(new Tiles3(data(1)));
  assert.equal(pitch, 15, "the measured pitch is the one the sweep is proven at");
  const tiles = new Tiles3(data(pitch));
  let cells = 0;
  let walls = 0;
  let bounds = 0;
  let decks = 0;

  for (const w of F.windows) {
    const b = { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 };
    const view: World3View = viewFromDoc(doc, b);
    const sweep = tiles.resolveWindow(view);
    const rt: Tiles3World = new Tiles3World({
      view,
      tiles,
      frame: isoFrame(b, view.maxLevel, pitch),
      patterns: load("tiles/patterns/index.json"),
      bounds: b,
    });
    assert.deepEqual(rt.regions.ids, sweep.regions.ids, `${w.name} region ids`);

    for (const c of sweep.cells) {
      assert.deepEqual(rt.cell(c.x, c.y), c, `${w.name} cell ${c.x},${c.y}`);
      cells++;
      if (c.kind === "wall") walls++;
    }
    // And every cell the sweep did NOT emit must resolve to nothing.
    for (let y = b.y0; y < b.y1; y++)
      for (let x = b.x0; x < b.x1; x++)
        if (!sweep.cells.some((c) => c.x === x && c.y === y))
          assert.equal(rt.cell(x, y), null, `${w.name} void ${x},${y}`);

    const byCorner = new Map<string, unknown>();
    for (const bd of sweep.boundaries) byCorner.set(`${bd.x},${bd.y}`, bd);
    for (let y = b.y0; y < b.y1; y++)
      for (let x = b.x0; x < b.x1; x++) {
        const mine = rt.boundary(x, y);
        const theirs = byCorner.get(`${x},${y}`) ?? null;
        assert.deepEqual(mine, theirs, `${w.name} boundary ${x},${y}`);
        if (mine) bounds++;
      }

    const deckByCell = new Map<string, unknown[]>();
    for (const d of sweep.decks) {
      const k = `${d.x},${d.y}`;
      deckByCell.set(k, [...(deckByCell.get(k) ?? []), d]);
    }
    for (let y = b.y0; y < b.y1; y++)
      for (let x = b.x0; x < b.x1; x++) {
        const mine = rt.decks(x, y);
        assert.deepEqual(mine, deckByCell.get(`${x},${y}`) ?? [], `${w.name} decks ${x},${y}`);
        decks += mine.length;
      }
  }
  assert.ok(cells >= 3000, `the comparison must cover the fixture (saw ${cells} cells)`);
  assert.ok(walls > 0 && bounds > 0 && decks > 0, `walls ${walls}, boundaries ${bounds}, decks ${decks}`);
});

/* THE VIEW THE GAME ACTUALLY USES is built from the PARSED world, not from the
 * raw document — the client parses before it renders and re-fetching 3.6 MB to
 * hand `viewFromDoc` a second copy would be absurd. So the two views have to
 * answer identically for every cell, every deck and every wall override. */
test("viewFromParsed answers exactly what viewFromDoc answers", { skip: !!MISSING.length }, () => {
  const raw = viewFromDoc(doc);
  const parsed = viewFromParsed(parseWorld(doc)!);
  assert.equal(parsed.width, raw.width);
  assert.equal(parsed.height, raw.height);
  assert.equal(parsed.maxLevel, raw.maxLevel);
  let overrides = 0;
  let liquid = 0;
  for (let y = 0; y < raw.height; y++)
    for (let x = 0; x < raw.width; x++) {
      const g = raw.groundAt(x, y);
      assert.equal(parsed.groundAt(x, y), g, `ground ${x},${y}`);
      assert.equal(parsed.levelAt(x, y), raw.levelAt(x, y), `level ${x},${y}`);
      const o = raw.wallSideAt(x, y);
      assert.equal(parsed.wallSideAt(x, y), o, `wall side ${x},${y}`);
      if (o) overrides++;
      if (g && raw.isLiquid(g)) liquid++;
    }
  assert.ok(overrides > 0 && liquid > 0, `overrides ${overrides}, liquid cells ${liquid}`);
  assert.equal(parsed.decks.length, raw.decks.length);
  parsed.decks.forEach((d, i) => {
    const r = raw.decks[i];
    assert.equal(d.kind, r.kind, `deck ${i} kind`);
    assert.equal(d.ground, r.ground, `deck ${i} ground`);
    assert.equal(d.level, r.level, `deck ${i} level`);
    assert.equal(d.thickness, r.thickness, `deck ${i} thickness`);
    assert.deepEqual(d.cells, r.cells, `deck ${i} cells`);
  });
});

/* THE TWO TRANSITIONS THE GAME ADDS ON TOP OF render3's PICTURE (maintainer
 * 2026-09-09): a NATURE WALL'S FOOT composes ground<->face like any two
 * grounds ("When a nature wall (not a house, etc) intersect the ground we
 * should make the ground a transition/boundary tile"), and a DECK SLAB
 * composes transitions at its own level ("The ground up here also look very
 * sharp and has no transition/boundary tiles", on the cave lid). Both are
 * `Tiles3Data` flags, OFF by default so the parity fixtures above hold; the
 * game turns them on. Synthetic world: the shape is the invariant, not any one
 * cliff of the_game. */
function synthView(o: {
  size: number;
  level: (x: number, y: number) => number;
  ground: (x: number, y: number) => string;
  side?: (x: number, y: number) => string | null;
  decks?: Deck3[];
}): World3View {
  const n = o.size;
  return {
    x0: 0, y0: 0, x1: n, y1: n, width: n, height: n, maxLevel: 8,
    groundAt: (x, y) => (x < 0 || y < 0 || x >= n || y >= n ? null : o.ground(x, y)),
    levelAt: (x, y) => (x < 0 || y < 0 || x >= n || y >= n ? 0 : o.level(x, y)),
    isLiquid: (g) => g === "water",
    wallSideAt: (x, y) => o.side?.(x, y) ?? null,
    decks: o.decks ?? [],
  };
}
const inBlock = (x: number, y: number) => x >= 2 && x <= 7 && y >= 2 && y <= 7;

test("a nature wall's foot composes a ground<->face transition; a house's does not", { skip: !!MISSING.length }, () => {
  const pitch = 15;
  const mk = (extra: Partial<Tiles3Data>) => new Tiles3({ ...data(pitch), ...extra });
  const cliff = synthView({
    size: 16,
    level: (x, y) => (inBlock(x, y) ? 6 : 0),
    ground: (x, y) => (inBlock(x, y) ? "grey_stone" : "grass"),
    side: (x, y) => (inBlock(x, y) ? "dark_mud" : null),
  });
  const frame = isoFrame(cliff, cliff.maxLevel, pitch);
  const g = (x: number, y: number) => cliff.groundAt(x, y);
  const L = (x: number, y: number) => cliff.levelAt(x, y);
  // OFF: the foot of a cliff on a pure field composes nothing (render3's picture).
  assert.equal(mk({}).boundaryAt(cliff, frame, g, L, 8, 4), null, "flag off: no transition at the foot");
  // ON: the cell under the cliff's left face wears dark_mud<->grass, the face's
  // side on its up-screen corners (NW + SW: the edge it shares with the wall).
  const t = mk({ footBoundary: true });
  const b = t.boundaryAt(cliff, frame, g, L, 8, 4);
  assert.ok(b, "flag on: the foot composes");
  const pair = [b!.boundary.a, b!.boundary.b].sort();
  assert.deepEqual(pair, ["dark_mud", "grass"], "the face's side against the cell's ground");
  const mudBit = (i: number) => (b!.boundary.b === "dark_mud" ? (b!.boundary.index & i) !== 0 : (b!.boundary.index & i) === 0);
  assert.ok(mudBit(8) && mudBit(2) && !mudBit(4) && !mudBit(1), `NW and SW are the face's (index ${b!.boundary.index})`);
  assert.equal(b!.ownSide === "b" ? b!.boundary.b : b!.boundary.a, "grass", "the cell's own half is its own ground");
  // The lattice is shared: the next foot cell down agrees on the corner between them.
  const b2 = t.boundaryAt(cliff, frame, g, L, 8, 5);
  assert.ok(b2, "the next foot cell composes too");
  const bit = (bb: NonNullable<typeof b>, i: number) => (bb.boundary.index & i) !== 0;
  assert.equal(bit(b2!, 8), bit(b!, 2), "corner (8,5) votes the same in both cells that share it");
  // A cell two rows out from the wall is untouched.
  assert.equal(t.boundaryAt(cliff, frame, g, L, 10, 4), null, "no foot two cells out");
  // A HOUSE keeps its hard edge: a wall whose side is an indoor floor...
  const house = synthView({ ...{ size: 16, level: cliff.levelAt, ground: cliff.groundAt as any }, side: (x, y) => (inBlock(x, y) ? "parquet_floor" : null) });
  assert.equal(t.boundaryAt(house, frame, (x, y) => house.groundAt(x, y), (x, y) => house.levelAt(x, y), 8, 4), null, "an indoor-floor side is a house wall");
  // ...or whose cell carries a roof deck.
  const roofed = synthView({
    size: 16, level: cliff.levelAt, ground: cliff.groundAt as any, side: (x, y) => (inBlock(x, y) ? "dark_mud" : null),
    // The whole block is the house: every wall cell is a roof-deck cell, as
    // the_game's wall rings are.
    decks: [{ kind: "roof", level: 6, thickness: 0, ground: "brown_paving_stone",
      cells: Array.from({ length: 36 }, (_, i) => ({ x: 2 + (i % 6), y: 2 + Math.floor(i / 6) })) }],
  });
  assert.equal(t.boundaryAt(roofed, frame, (x, y) => roofed.groundAt(x, y), (x, y) => roofed.levelAt(x, y), 8, 4), null, "a roofed wall is a house wall");
});

test("a deck slab composes transitions at its own level, with its own anchored member", { skip: !!MISSING.length }, () => {
  const pitch = 15;
  const A: Deck3 = { kind: "cave", level: 6, thickness: 2, ground: "black_rock", cells: [] };
  const B: Deck3 = { kind: "cave", level: 6, thickness: 2, ground: "grey_stone", cells: [] };
  for (let y = 2; y <= 5; y++) for (let x = 2; x <= 9; x++) (x <= 5 ? A : B).cells.push({ x, y });
  const view = synthView({ size: 16, level: () => 0, ground: () => "grass", decks: [A, B] });
  const frame = isoFrame(view, view.maxLevel, pitch);
  const off = new Tiles3(data(pitch)).deckCell(view, frame, A, 0, 5, 3);
  assert.equal(off.boundary, undefined, "flag off: a slab is its one surface");
  const on = new Tiles3({ ...data(pitch), deckBoundary: true });
  const edge = on.deckCell(view, frame, A, 0, 5, 3);
  assert.ok(edge.boundary, "flag on: the slab cell at the seam composes");
  assert.deepEqual([edge.boundary!.a, edge.boundary!.b].sort(), ["black_rock", "grey_stone"]);
  assert.equal(edge.boundary!.topOnly, true, "top face only — the slab's own courses are its wall");
  assert.equal(edge.boundary!.sy, edge.surfaceY, "pasted where the surface is");
  assert.equal(edge.boundary!.sx, edge.sx);
  // The slab's own half is the ONE member the whole slab wears.
  const own = edge.boundary!.a === "black_rock" ? [edge.boundary!.setA, edge.boundary!.memberA] : [edge.boundary!.setB, edge.boundary!.memberB];
  assert.deepEqual(own, [edge.surfaceSet, edge.surfaceMember], "the transition's slab half is the slab's member");
  // A cell inside the slab, away from any seam, stays pure; the grass 6 levels
  // down never reaches the lattice.
  assert.equal(on.deckCell(view, frame, A, 0, 3, 3).boundary, undefined, "no seam inside the slab");
  assert.equal(on.deckCell(view, frame, A, 0, 2, 2).boundary, undefined, "the rim over a 6-level drop is a hard edge");
});
