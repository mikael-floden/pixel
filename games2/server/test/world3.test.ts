// ============================================================================
// WORLD3 — the game can READ a `pixel-maps3/world@1` document
// ============================================================================
//
// maps2/worlds3/the_game is THE world: 394x394 (the land plus a sea margin),
// semantics only, no baked tile art. Before parseWorld3 it fell through every
// parser and came back NULL, and the game silently loaded an empty 160x160
// plain — a failure with no error message anywhere, which is why the read is
// gated here against the REAL file rather than a fixture.
//
// Every assertion below is checked against a direct read of the JSON in the
// same test, so the file and the parser can never drift apart quietly. Counts
// that are pinned as numbers are MEASURED on the shipped doc and say so; a maps2
// re-export moves them and the assertion names what moved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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
  surfaceAtWorld,
  VOID_SURFACE,
  CELL_WU,
} from "@nangijala/shared";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GAME3 = join(REPO, "maps2", "worlds3", "the_game", "world.json");

const doc: any = existsSync(GAME3) ? JSON.parse(readFileSync(GAME3, "utf8")) : null;
const world: ParsedWorld | null = doc ? parseWorld(doc) : null;
const W: number = doc?.size?.w ?? 0;
const H: number = doc?.size?.h ?? 0;

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
  assert.equal(world.rows.length, doc.size.h);
  assert.equal(world.rows[0].length, doc.size.w);
  assert.equal(doc.ground.length, doc.size.h, "the ground grid has one row per doc row");
  assert.equal(doc.ground[0].length, doc.size.w);
  assert.deepEqual(world.spawn, [doc.spawn[0], doc.spawn[1]]);
  // spawn is (col,row): reading it the other way lands in the sea.
  assert.equal(world.rows[doc.spawn[1]][doc.spawn[0]].t, "grass");
  assert.ok(surfaceFor(world.rows[doc.spawn[0]][doc.spawn[1]].t).swimmable || world.rows[doc.spawn[0]][doc.spawn[1]].t === "",
    "the transposed spawn must NOT be dry land, or this gate cannot tell the two readings apart");
});

// THE ORIENTATION GATE. The grids are ROW-MAJOR [y][x], and a transposed island
// is plausible-looking terrain that never crashes — so it is measured, not
// assumed. `ground` and `level` transpose TOGETHER, so no comparison between
// them can tell the two readings apart; only cells with EXPLICIT x/y can, and
// wall cells are the sharpest: a wall cell stands under a cliff or house FACE.
// Read [y][x], the only wall cells at level 0 are cave-floor cells under a cave
// ceiling's face (60 of 5,453, every one under a deck); read [x][y], 1,162 land
// on open sea floor.
test("grids are row-major [y][x] — measured on the wall cells", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  const grid = buildTerrainGrid(world.width, world.height, world.rows, [], world.decks);
  const cells = new Set<string>();
  for (const g of doc.walls) for (const c of g.cells) cells.add(`${c.x},${c.y}`);
  let atZeroYX = 0;
  let atZeroXY = 0;
  let zeroUnderCeiling = 0;
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number);
    if (doc.level[y][x] === 0) {
      atZeroYX++;
      if (grid.deck[y * grid.width + x] >= 0) zeroUnderCeiling++;
    }
    if (doc.level[x][y] === 0) atZeroXY++;
  }
  assert.equal(cells.size, 5453, "distinct wall cells (measured)");
  assert.equal(atZeroYX, 60, "read [y][x]: 60 wall cells sit at level 0 (measured)");
  assert.equal(zeroUnderCeiling, atZeroYX, "…and every one of them is a cave floor under its ceiling's face");
  assert.equal(atZeroXY, 1162, "read [x][y]: 1,162 wall cells land on the sea floor — that reading is wrong");
  assert.ok(atZeroXY > 10 * atZeroYX, "the two readings must stay far apart or the gate is blunt");
  // …and the parser reads it the same way.
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number);
    assert.equal(world.rows[y][x].l, doc.level[y][x]);
  }
});

test("ground names come from grounds[] via ground[y][x]", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  assert.equal(doc.grounds.length, 15, "grounds the doc declares (measured)");
  // Every sample is a cell where ground[y][x] !== ground[x][y], so each one of
  // them also fails if the grid is read transposed. One per declared ground.
  const samples: [number, number, string][] = [
    [226, 71, "black_rock"],
    [109, 151, "brown_paving_stone"],
    [225, 71, "dark_mud"],
    [200, 20, "deep_water"],
    [211, 33, "grass"],
    [244, 82, "grey_stone"],
    [216, 144, "ice"],
    [210, 32, "light_beach"],
    [222, 71, "light_soil"],
    [96, 161, "parquet_floor"],
    [259, 93, "snow"],
    [207, 29, "water"],
    [104, 166, "grey_paving_stone"],
    [234, 184, "lava"],
    [275, 155, "slime"],
  ];
  assert.deepEqual(new Set(samples.map((s) => s[2])), new Set(doc.grounds), "one sample per ground the doc declares");
  for (const [x, y, name] of samples) {
    assert.equal(doc.grounds[doc.ground[y][x]], name, `doc ${x},${y}`);
    assert.notEqual(doc.grounds[doc.ground[x][y]], name, `${x},${y} must be orientation-sensitive`);
    assert.equal(world.rows[y][x].t, name, `parsed ${x},${y}`);
  }
  // The ground TYPE is the whole cell: a v3 cell names no art, no variant.
  assert.equal(world.rows[doc.spawn[1]][doc.spawn[0]].v, 0);
  assert.equal(world.rows[doc.spawn[1]][doc.spawn[0]].r, undefined);
  assert.equal(world.props, undefined, "scenery is off-grid; a v3 world places no grid props");
});

test("every cell's ground and level round-trip the whole grid, voids included", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  let voids = 0;
  let minL = Infinity;
  let maxL = -Infinity;
  const used = new Set<string>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
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
  // The sea margin around the land box is VOID (maps2 2026-09-09: "the canvas
  // is the land plus a sea margin"): 735 cells, and a void is not ground.
  assert.equal(voids, 735, "void cells (measured)");
  assert.ok(voids > 0, "the -1 branch is data here, not just spec");
  // A void cell is neither ground nor water: surfaceAtWorld answers VOID_SURFACE
  // for `t: ""`, so nobody can stand or swim in the sea margin.
  const grid = buildTerrainGrid(world.width, world.height, world.rows, [], world.decks);
  const vy = doc.ground.findIndex((row: number[]) => row.some((g) => g < 0));
  const vx = doc.ground[vy].findIndex((g: number) => g < 0);
  const v = surfaceAtWorld(grid, (vx + 0.5) * CELL_WU, (vy + 0.5) * CELL_WU);
  assert.deepEqual(v, VOID_SURFACE, "a void cell resolves to VOID_SURFACE");
  assert.ok(!v.standable && !v.swimmable, "nobody stands or swims in the margin");
  assert.equal(used.size, doc.grounds.length + 1, "every declared ground is used, plus the void");
  assert.equal(minL, 0);
  assert.equal(maxL, 46, "levels are the same unit as before: 0..46, the tallest roof deck's own level (measured)");
});

test("decks carry ground→mat, kind verbatim, and lose no cell", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  assert.equal(doc.decks.length, 28, "decks (measured)");
  assert.equal(world.decks?.length, doc.decks.length);
  const kinds: Record<string, number> = {};
  let cells = 0;
  for (const d of doc.decks) {
    kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
    cells += d.cells.length;
  }
  assert.deepEqual(kinds, { cave: 12, roof: 11, bridge: 5 }, "deck kinds (measured)");
  assert.equal(cells, 1414, "deck cells (measured)");
  assert.equal(world.decks!.reduce((n, d) => n + d.cells.length, 0), cells, "no deck cell may be dropped");
  for (let i = 0; i < doc.decks.length; i++) {
    const src = doc.decks[i];
    const out: Deck = world.decks![i];
    assert.equal(out.kind, src.kind); // roof/cave = INDOORS in v3; carried through
    assert.equal(out.mat, src.ground); // mat:int became ground:string
    assert.equal(out.level, src.level);
    assert.equal(out.thickness, src.thickness);
    assert.deepEqual(out.cells[0], { col: src.cells[0].x, row: src.cells[0].y, flip: false });
  }
  // The decks reach the terrain grid: a bridge/roof slab is a second surface
  // wherever it floats ABOVE its base. A roof laps its own walls and a summit
  // bridge sits at its own base level — those cells are one surface, not an
  // overpass, and buildTerrainGrid keeps no deck there (1,056 of 1,414).
  const grid = buildTerrainGrid(world.width, world.height, world.rows, [], world.decks);
  const raised = grid.deck.filter((d) => d >= 0).length;
  assert.equal(raised, 1056, `deck cells in terrain (measured): ${raised}`);
  assert.ok(raised > cells / 2 && raised < cells, "most, not all, deck cells float over their base");
  // Every deck material must be a classified surface — a bridge you cross reads
  // its speed/sound from deckType, not from the water underneath.
  for (const d of world.decks!) assert.ok(isKnownSurface(d.mat), `deck material ${d.mat} is classified`);
});

test("walls override the face material per cell, and LATER WINS", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  assert.equal(doc.walls.length, 21, "wall groups (measured)");
  assert.equal(doc.walls.reduce((n: number, g: any) => n + g.cells.length, 0), 5460, "wall claims (measured)");
  const claims = new Map<string, string[]>();
  for (const g of doc.walls) {
    for (const c of g.cells) {
      const k = `${c.x},${c.y}`;
      const at = claims.get(k) ?? [];
      at.push(g.side);
      claims.set(k, at);
    }
  }
  assert.equal(claims.size, 5453, "5,460 claims over 5,453 distinct cells (measured)");
  assert.equal([...claims.values()].filter((v) => v.length > 1).length, 7, "cells claimed twice (measured)");
  const contested = [...claims.entries()].filter(([, v]) => new Set(v).size > 1);
  assert.equal(contested.length, 2, "cells claimed by groups naming DIFFERENT materials (measured)");
  assert.ok(contested.length > 0, "a contested cell is what makes the later-wins rule testable");
  assert.equal(Object.keys(world.wallSides!).length, claims.size);
  // render3.py builds wall_over as a dict in array order, so the LAST group to
  // claim a cell decides its material. Reproduce that or the contested cells
  // get clad in the wrong ground.
  for (const [k, sides] of claims) {
    const [x, y] = k.split(",").map(Number);
    assert.equal(wallSideAt(world, x, y), sides[sides.length - 1], `cell ${k}`);
  }
  for (const [k, sides] of contested) {
    const [x, y] = k.split(",").map(Number);
    assert.notEqual(wallSideAt(world, x, y), sides[0], `cell ${k}: the FIRST claimant must lose`);
    // ART ONLY: the override must not disturb the cell's own ground or elevation.
    assert.equal(world.rows[y][x].t, doc.grounds[doc.ground[y][x]]);
    assert.equal(world.rows[y][x].l, doc.level[y][x]);
  }
  assert.equal(wallSideAt(world, 0, 0), "", "no override reads as empty, not undefined");
});

test("scenery is carried off-grid, and buildTerrainGrid alone blocks nothing", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  assert.equal(world.scenery?.length, doc.scenery.length);
  assert.equal(world.scenery!.length, 1294, "placements (measured)");
  assert.equal(world.scenery!.filter((p) => p.hflip).length, 252, "mirrored placements (measured)");
  assert.equal(world.scenery!.filter((p) => p.lit).length, 143, "lit placements (measured)");
  assert.equal(world.scenery!.filter((p) => p.state).length, 1099, "placements naming a variation (measured)");
  assert.equal(world.scenery!.filter((p) => p.dir).length, 52, "placements naming a facing (measured)");
  assert.equal(world.scenery!.filter((p) => p.hflip).length, doc.scenery.filter((p: any) => p.hflip).length);
  assert.equal(world.scenery!.filter((p) => p.state).length, doc.scenery.filter((p: any) => p.state).length);
  assert.equal(world.scenery!.filter((p) => p.dir).length, doc.scenery.filter((p: any) => p.dir).length);
  const first = world.scenery![0];
  assert.equal(first.piece, doc.scenery[0].piece);
  assert.equal(first.x, doc.scenery[0].x);
  assert.equal(first.y, doc.scenery[0].y);
  assert.equal(first.hflip, !!doc.scenery[0].hflip);
  assert.equal(first.lit, !!doc.scenery[0].lit);
  assert.equal(first.state, doc.scenery[0].state);
  assert.equal(first.dir, doc.scenery[0].dir);
  assert.ok(world.scenery!.some((p) => !Number.isInteger(p.x)), "scenery is off the tile grid");
  // Collision is a SEPARATE stamp (stampSceneryCollision, from the hitbox docs)
  // that the server and client both run; the terrain grid itself never blocks
  // a cell for a placement, so parsing 1,294 pieces walls nobody in.
  const grid = buildTerrainGrid(world.width, world.height, world.rows, [], world.decks);
  assert.equal(grid.blocked.filter(Boolean).length, 0);
});

// The world DECLARES its liquids; SURFACES DECIDES what a liquid means for a
// player, because the engine owns movement. They must still agree — a ground
// the world calls liquid that the engine lets you walk on is a bug in one of
// them, and this is where it surfaces.
test("liquids[] and SURFACES agree on every ground the world uses", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  assert.deepEqual(
    world.liquids,
    ["water", "deep_water", "lava"],
    "maps2/worlds3/the_game/world.json `liquids`: lava swims and burns (SURFACES.lava) — maps2 owns the list (board request 2026-09-06)",
  );
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
  // The contract check-surfaces.mjs enforces at deploy — asserted here so the
  // world is classified before the day an unclassified ground turns every
  // agent's deploy red.
  const unknown = (doc.grounds as string[]).filter((g) => !isKnownSurface(g));
  assert.deepEqual(unknown, [], `unclassified grounds: ${unknown.join(", ")}`);
});
