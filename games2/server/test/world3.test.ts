// ============================================================================
// WORLD3 — the game can READ a `pixel-maps3/world@1` document
// ============================================================================
//
// maps2/worlds3/the_game is the tiles3 migration target: 512x512, semantics
// only, no baked tile art. Before parseWorld3 it fell through every parser and
// came back NULL, and the game silently loaded an empty 160x160 plain — a
// failure with no error message anywhere, which is why the read is gated here
// against the REAL file rather than a fixture.
//
// Every assertion below is checked against a direct read of the JSON in the
// same test, so the file and the parser can never drift apart quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Deck, ParsedWorld, WorldCell } from "@nangijala/shared";
import {
  parseWorld,
  parseWorld3,
  wallSideAt,
  surfaceFor,
  isKnownSurface,
  buildTerrainGrid,
} from "@nangijala/shared";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GAME3 = join(REPO, "maps2", "worlds3", "the_game", "world.json");
const ISLAND2 = join(REPO, "maps2", "worlds", "the_island2", "world.json");

const doc: any = existsSync(GAME3) ? JSON.parse(readFileSync(GAME3, "utf8")) : null;
const world: ParsedWorld | null = doc ? parseWorld(doc) : null;

test("parseWorld dispatches pixel-maps3/world@1 (it used to return null)", () => {
  if (!doc) return test.skip("maps2/worlds3/the_game missing");
  assert.equal(doc.schema, "pixel-maps3/world@1");
  assert.ok(world, "parseWorld must handle a maps3 doc; null falls back to an empty plain");
  assert.deepEqual(world, parseWorld3(doc), "the schema dispatch must reach parseWorld3");
});

test("size and spawn come from the doc, not the grid shape", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  assert.equal(world.width, doc.size.w);
  assert.equal(world.height, doc.size.h);
  assert.equal(world.width, 512);
  assert.equal(world.height, 512);
  assert.equal(world.rows.length, 512);
  assert.equal(world.rows[0].length, 512);
  assert.deepEqual(world.spawn, [doc.spawn[0], doc.spawn[1]]);
  // spawn is (col,row): reading it the other way lands in the sea.
  assert.equal(world.rows[doc.spawn[1]][doc.spawn[0]].t, "grass");
});

// THE ORIENTATION GATE. The grids are ROW-MAJOR [y][x], and a transposed island
// is plausible-looking terrain that never crashes — so it is measured, not
// assumed. `ground` and `level` transpose TOGETHER, so no comparison between
// them can tell the two readings apart; only cells with EXPLICIT x/y can, and
// wall cells are the sharpest: a wall cell is by definition under a cliff or
// house face, never at the sea-level floor.
test("grids are row-major [y][x] — measured on the wall cells", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  const cells = new Set<string>();
  for (const g of doc.walls) for (const c of g.cells) cells.add(`${c.x},${c.y}`);
  let atZeroYX = 0;
  let atZeroXY = 0;
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number);
    if (doc.level[y][x] === 0) atZeroYX++;
    if (doc.level[x][y] === 0) atZeroXY++;
  }
  assert.equal(cells.size, 3546);
  assert.equal(atZeroYX, 0, "read [y][x]: no wall cell sits at level 0 — walls stand under faces");
  assert.equal(atZeroXY, 854, "read [x][y]: 854 wall cells land on the sea floor — that reading is wrong");
  // …and the parser reads it the same way.
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number);
    assert.equal(world.rows[y][x].l, doc.level[y][x]);
    assert.ok(world.rows[y][x].l > 0);
  }
});

test("ground names come from grounds[] via ground[y][x]", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  assert.equal(doc.grounds.length, 13);
  // Every sample is a cell where ground[y][x] !== ground[x][y], so each one of
  // them also fails if the grid is read transposed.
  const samples: [number, number, string][] = [
    [376, 276, "black_rock"],
    [215, 284, "brown_paving_stone"],
    [262, 252, "dark_mud"],
    [327, 128, "deep_water"],
    [319, 160, "grass"],
    [211, 278, "grey_paving_stone"],
    [345, 215, "grey_stone"],
    [361, 279, "ice"],
    [318, 159, "light_beach"],
    [218, 310, "light_soil"],
    [212, 279, "parquet_floor"],
    [346, 225, "snow"],
    [315, 156, "water"],
  ];
  assert.equal(new Set(samples.map((s) => s[2])).size, 13, "one sample per ground the world uses");
  for (const [x, y, name] of samples) {
    assert.equal(doc.grounds[doc.ground[y][x]], name, `doc ${x},${y}`);
    assert.notEqual(doc.grounds[doc.ground[x][y]], name, `${x},${y} must be orientation-sensitive`);
    assert.equal(world.rows[y][x].t, name, `parsed ${x},${y}`);
  }
  // The ground TYPE replaces the tile path: a v3 cell names no art at all.
  assert.equal(world.rows[0][0].path, undefined);
  assert.equal(world.rows[0][0].v, 0);
  assert.equal(world.faceTiles, undefined);
  assert.equal(world.props, undefined);
});

test("every cell's ground and level round-trip the whole grid", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  let voids = 0;
  let minL = Infinity;
  let maxL = -Infinity;
  const used = new Set<string>();
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      const gi = doc.ground[y][x];
      const cell: WorldCell = world.rows[y][x];
      // -1 = VOID: `t: ""` is the engine's own "nothing here" (VOID_SURFACE).
      if (gi < 0) {
        voids++;
        assert.equal(cell.t, "");
      } else {
        assert.equal(cell.t, doc.grounds[gi]);
      }
      assert.equal(cell.l, doc.level[y][x]);
      used.add(cell.t);
      minL = Math.min(minL, cell.l);
      maxL = Math.max(maxL, cell.l);
    }
  }
  assert.equal(voids, 0, "the_game has no voids — the -1 branch is spec, not data");
  assert.equal(used.size, 13);
  assert.equal(minL, 0);
  assert.equal(maxL, 40, "levels are the same unit as world@1: 0..40");
});

test("decks carry ground→mat, kind verbatim, and lose no cell", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  assert.equal(doc.decks.length, 28);
  assert.equal(world.decks?.length, 28);
  const kinds: Record<string, number> = {};
  let cells = 0;
  for (const d of doc.decks) {
    kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
    cells += d.cells.length;
  }
  assert.deepEqual(kinds, { cave: 12, roof: 11, bridge: 5 });
  assert.equal(cells, 1051);
  assert.equal(world.decks!.reduce((n, d) => n + d.cells.length, 0), 1051, "no deck cell may be dropped");
  for (let i = 0; i < doc.decks.length; i++) {
    const src = doc.decks[i];
    const out: Deck = world.decks![i];
    assert.equal(out.kind, src.kind); // roof/cave = INDOORS in v3; carried through
    assert.equal(out.mat, src.ground); // mat:int became ground:string
    assert.equal(out.level, src.level);
    assert.equal(out.thickness, src.thickness);
    assert.deepEqual(out.cells[0], { col: src.cells[0].x, row: src.cells[0].y, flip: false });
  }
  // The decks reach the terrain grid: a bridge/roof slab is a second surface.
  const grid = buildTerrainGrid(world.width, world.height, world.rows, [], world.decks);
  const raised = grid.deck.filter((d) => d >= 0).length;
  assert.ok(raised > 500 && raised <= 1051, `deck cells in terrain: ${raised}`);
  // Every deck material must be a classified surface — a bridge you cross reads
  // its speed/sound from deckType, not from the water underneath.
  for (const d of world.decks!) assert.notEqual(d.mat, "");
});

test("walls override the face material per cell, and LATER WINS", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  assert.equal(doc.walls.length, 15);
  assert.equal(doc.walls.reduce((n: number, g: any) => n + g.cells.length, 0), 3691);
  const claims = new Map<string, string[]>();
  for (const g of doc.walls) {
    for (const c of g.cells) {
      const k = `${c.x},${c.y}`;
      const at = claims.get(k) ?? [];
      at.push(g.side);
      claims.set(k, at);
    }
  }
  assert.equal(claims.size, 3546, "3,691 claims over 3,546 distinct cells");
  assert.equal([...claims.values()].filter((v) => v.length > 1).length, 145);
  const contested = [...claims.entries()].filter(([, v]) => new Set(v).size > 1);
  assert.equal(contested.length, 71, "71 cells are claimed by groups naming DIFFERENT materials");
  assert.equal(Object.keys(world.wallSides!).length, 3546);
  // render3.py builds wall_over as a dict in array order, so the LAST group to
  // claim a cell decides its material. Reproduce that or 71 cells of the stone
  // house get clad in the wrong ground.
  for (const [k, sides] of claims) {
    const [x, y] = k.split(",").map(Number);
    assert.equal(wallSideAt(world, x, y), sides[sides.length - 1], `cell ${k}`);
  }
  assert.equal(wallSideAt(world, 211, 283), "brown_paving_stone", "group 13 overrides group 5's light_soil");
  // ART ONLY: the override must not disturb the cell's own ground or elevation.
  assert.equal(world.rows[283][211].t, doc.grounds[doc.ground[283][211]]);
  assert.equal(wallSideAt(world, 0, 0), "", "no override reads as empty, not undefined");
});

test("scenery is carried off-grid and blocks nothing", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  assert.equal(world.scenery?.length, doc.scenery.length);
  assert.equal(world.scenery!.length, 1388);
  assert.equal(world.scenery!.filter((p) => p.hflip).length, 599);
  assert.equal(world.scenery!.filter((p) => p.lit).length, 8);
  assert.deepEqual(world.scenery![0], {
    piece: doc.scenery[0].piece,
    x: doc.scenery[0].x,
    y: doc.scenery[0].y,
    hflip: !!doc.scenery[0].hflip,
    lit: !!doc.scenery[0].lit,
  });
  assert.ok(world.scenery!.some((p) => !Number.isInteger(p.x)), "scenery is off the tile grid");
  // No hitbox ships in scenery yet, so nothing is blocked — mapping these onto
  // `props` would wall the player out of 1,388 cells on a guess.
  const grid = buildTerrainGrid(world.width, world.height, world.rows, [], world.decks);
  assert.equal(grid.blocked.filter(Boolean).length, 0);
});

// The world DECLARES its liquids; SURFACES DECIDES what a liquid means for a
// player, because the engine owns movement. They must still agree — a ground
// the world calls liquid that the engine lets you walk on is a bug in one of
// them, and this is where it surfaces.
test("liquids[] and SURFACES agree on every ground the world uses", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  assert.deepEqual(world.liquids, ["water", "deep_water"]);
  for (const g of doc.grounds as string[]) {
    assert.equal(
      surfaceFor(g).swimmable,
      (doc.liquids as string[]).includes(g),
      `${g}: liquids[] and SURFACES.swimmable disagree`,
    );
    // A declared liquid is never standable, and every other ground is.
    assert.equal(surfaceFor(g).standable, !(doc.liquids as string[]).includes(g), `${g}: standable`);
  }
});

test("every ground the world uses has an explicit SURFACES entry", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  // Same contract check-surfaces.mjs runs over maps2/worlds — asserted here so
  // the maps3 world is classified BEFORE the day it becomes visible to the gate
  // and turns every agent's deploy red.
  const unknown = (doc.grounds as string[]).filter((g) => !isKnownSurface(g));
  assert.deepEqual(unknown, [], `unclassified grounds: ${unknown.join(", ")}`);
});

// world@1/world@2 IS THE LIVE GAME. The dispatch above must not have moved a
// single byte of the_island2's parse — the digest is the pre-change output.
test("parseWorld on the_island2 is byte-identical to before the maps3 dispatch", () => {
  if (!existsSync(ISLAND2)) return test.skip("maps2/worlds/the_island2 missing");
  const w = parseWorld(JSON.parse(readFileSync(ISLAND2, "utf8")))!;
  assert.ok(w);
  assert.equal(w.width, 248);
  assert.equal(w.height, 248);
  assert.deepEqual(w.spawn, [201, 120]);
  assert.equal(w.decks?.length, 18);
  assert.equal(w.props?.length, 72);
  assert.equal(Object.keys(w.faceTiles ?? {}).length, 8);
  // v2 keeps baking tile art; none of the maps3 fields may appear on it.
  assert.ok(w.rows[120][201].path, "world@1 cells still carry their baked tile path");
  assert.equal(w.liquids, undefined);
  assert.equal(w.wallSides, undefined);
  assert.equal(w.scenery, undefined);
  assert.equal(
    createHash("sha256").update(JSON.stringify(w)).digest("hex"),
    "dc355206615426c16866acc56b70007140dadc46f13a735f82df45c754d21cd0",
    "the_island2's parse changed — world@1/world@2 is the LIVE game",
  );
});
