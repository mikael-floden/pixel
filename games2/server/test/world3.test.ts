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
// same test, so the file and the parser can never drift apart quietly. NO COUNT
// IS PINNED: this file used to carry the world's census as equalities ("5,609
// wall cells", "28 decks", "a lava cell at 234,184"), and the town grew — 6,171
// wall cells, 61 decks, black_rock over the old lava — so four gates failed
// about a map edit that broke nothing, every day, until the whole suite's reds
// were something to scroll past. The census is PRINTED on every run instead,
// where a human sees the world move; the assertions say what the PARSER must do
// at any size, with a floor so none of them can pass on an empty world.
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
// ceiling's face — every one of them under a deck; read [x][y], an order of
// magnitude more land on open sea floor.
//
// NO CENSUS PINS (the lesson the scenery gate at the foot of this file already
// paid for, applied here 2026-09-14): this counted 5,609 wall cells, the town
// grew to 6,171, and the suite went red on a map edit that broke nothing. The
// census is PRINTED instead — a human reading the run sees the world move, and
// the assertions say what the PARSER must do whatever size it is.
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
  console.log(`  ${cells.size} wall cells: at level 0, ${atZeroYX} read [y][x] (${zeroUnderCeiling} under a deck) vs ${atZeroXY} read [x][y]`);
  assert.ok(cells.size > 1000, `the world offers wall cells to measure (${cells.size})`);
  assert.equal(zeroUnderCeiling, atZeroYX, "read [y][x]: every wall cell at level 0 is a cave floor under its ceiling's face");
  assert.ok(atZeroXY > 10 * atZeroYX, `read [x][y] puts ${atZeroXY} wall cells on the sea floor — that reading is wrong, and the two must stay an order of magnitude apart or the gate is blunt`);
  // …and the parser reads it the same way.
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number);
    assert.equal(world.rows[y][x].l, doc.level[y][x]);
  }
});

test("ground names come from grounds[] via ground[y][x]", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  // ONE SAMPLE PER DECLARED GROUND, FOUND IN THE DOC rather than typed into it:
  // a cell where `ground[y][x]` is that ground and `ground[x][y]` is NOT, so
  // every sample fails on its own if the grid is read transposed. Typed, this
  // list pinned 15 grounds and a lava cell at 234,184 that is black_rock today —
  // the volcano moved and the gate failed about the wrong thing. Derived, it
  // covers whatever maps2 declares, including the grounds it adds next.
  const samples: [number, number, string][] = [];
  const missing: string[] = [];
  for (let gi = 0; gi < doc.grounds.length; gi++) {
    let found: [number, number, string] | null = null;
    for (let y = 0; y < H && !found; y++)
      for (let x = 0; x < W; x++)
        if (doc.ground[y][x] === gi && doc.ground[x]?.[y] !== gi) { found = [x, y, doc.grounds[gi]]; break; }
    if (found) samples.push(found);
    else missing.push(doc.grounds[gi]);
  }
  console.log(`  ${doc.grounds.length} grounds declared, ${samples.length} sampled at an orientation-sensitive cell`);
  // A ground laid only on the diagonal has no such cell — possible, never seen;
  // it would silently shrink this gate, so it is named rather than ignored.
  assert.deepEqual(missing, [], `every declared ground has an orientation-sensitive cell (${missing.join(", ")} did not)`);
  assert.ok(samples.length >= 10, `the world declares enough grounds to test (${samples.length})`);
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
  // is the land plus a sea margin"), and a void is not ground.
  console.log(`  ${voids} void cells; levels ${minL}..${maxL}`);
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
  // LEVELS ARE LEVELS, NOT PIXELS — the unit is what this asserts, and the
  // cross-check is the decks, which carry their own `level` and are built by a
  // different half of render3: the tallest terrain cell IS a deck's own level
  // (a roof laps its walls), so the two maxima meet. Pinning 46 instead only
  // said how tall the town happened to be.
  const deckMax = Math.max(...doc.decks.map((d: any) => d.level));
  assert.ok(maxL > 0 && deckMax > 0, `terrain ${maxL} and decks ${deckMax} both rise off the floor`);
  assert.equal(maxL, deckMax, "terrain levels and deck levels are one unit");
});

test("decks carry ground→mat, kind verbatim, and lose no cell", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  assert.equal(world.decks?.length, doc.decks.length, "every deck is carried");
  const kinds: Record<string, number> = {};
  let cells = 0;
  for (const d of doc.decks) {
    kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
    cells += d.cells.length;
  }
  console.log(`  ${doc.decks.length} decks (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ")}), ${cells} cells`);
  // THE KINDS ARE THE CONTRACT, not how many of each the town has built this
  // week (it was 12 caves / 11 roofs / 5 bridges; it is not any more). An
  // unknown kind is the failure that matters: `roof`/`cave` mean INDOORS to
  // everything downstream and `bridge` means an overpass, so a fourth word
  // here would be silently mis-rendered and mis-lit.
  assert.deepEqual(Object.keys(kinds).sort(), ["bridge", "cave", "roof"], "the deck kinds the engine knows, all present");
  assert.ok(cells > 500, `the world offers deck cells to check (${cells})`);
  assert.equal(world.decks!.reduce((n, d) => n + d.cells.length, 0), cells, "no deck cell may be dropped");
  for (let i = 0; i < doc.decks.length; i++) {
    const src = doc.decks[i];
    const out: Deck = world.decks![i];
    assert.equal(out.kind, src.kind); // roof/cave = INDOORS in v3; carried through
    assert.equal(out.mat, src.ground); // mat:int became ground:string
    assert.equal(out.side, src.side); // the course material when named (Deck.side); absent stays absent
    assert.equal(out.level, src.level);
    assert.equal(out.thickness, src.thickness);
    assert.deepEqual(out.cells[0], { col: src.cells[0].x, row: src.cells[0].y, flip: false });
  }
  // The decks reach the terrain grid: a bridge/roof slab is a second surface
  // wherever it floats ABOVE its base. A roof laps its own walls and a summit
  // bridge sits at its own base level — those cells are one surface, not an
  // overpass, and buildTerrainGrid keeps no deck there (1,198 of 1,556).
  const grid = buildTerrainGrid(world.width, world.height, world.rows, [], world.decks);
  const raised = grid.deck.filter((d) => d >= 0).length;
  console.log(`  ${raised} of ${cells} deck cells float over their base`);
  assert.ok(raised > cells / 2 && raised < cells, `most, not all, deck cells float over their base (${raised} of ${cells})`);
  // Every deck material must be a classified surface — a bridge you cross reads
  // its speed/sound from deckType, not from the water underneath.
  for (const d of world.decks!) assert.ok(isKnownSurface(d.mat), `deck material ${d.mat} is classified`);
});

test("walls override the face material per cell, and LATER WINS", () => {
  if (!world) return test.skip("maps2/worlds3/the_game missing");
  const totalClaims = doc.walls.reduce((n: number, g: any) => n + g.cells.length, 0);
  const claims = new Map<string, string[]>();
  for (const g of doc.walls) {
    for (const c of g.cells) {
      const k = `${c.x},${c.y}`;
      const at = claims.get(k) ?? [];
      at.push(g.side);
      claims.set(k, at);
    }
  }
  const twice = [...claims.values()].filter((v) => v.length > 1).length;
  const contested = [...claims.entries()].filter(([, v]) => new Set(v).size > 1);
  console.log(`  ${doc.walls.length} wall groups, ${totalClaims} claims over ${claims.size} cells: ${twice} claimed twice, ${contested.length} of those by groups naming DIFFERENT materials`);
  assert.ok(claims.size > 1000, `the world offers wall cells to check (${claims.size})`);
  assert.equal(claims.size, new Set([...claims.keys()]).size);
  assert.ok(totalClaims >= claims.size, "a claim count below the cell count means cells were invented");
  // THE CONTESTED CELLS ARE THE TEST. Without one, the later-wins loop below
  // passes on a world where no rule was ever exercised — so the day the map has
  // none, this gate says so rather than going quietly green.
  assert.ok(contested.length > 0, "no cell is claimed by two groups naming different materials — the later-wins rule is untested on this world");
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
  // NO CENSUS PINS HERE. This gate is about the PARSER, and the maps2 agent
  // places scenery continuously — pinning "1,340 placements" made a green suite
  // go red every time somebody planted a bush, and the number asserted nothing
  // about the parser anyway (it churned 1,294 -> 1,330 -> 1,340 -> 1,334 inside
  // one afternoon). What matters is that NOTHING IS LOST OR INVENTED between
  // the doc and the parsed world, which is the equalities below, plus a floor
  // so the test cannot pass on an empty world.
  assert.equal(world.scenery?.length, doc.scenery.length, "every placement is carried");
  assert.ok(world.scenery!.length > 500, `only ${world.scenery!.length} placements — the world lost its scenery`);
  for (const field of ["hflip", "lit", "state", "dir"] as const)
    assert.equal(
      world.scenery!.filter((p) => !!p[field]).length,
      doc.scenery.filter((p: Record<string, unknown>) => !!p[field]).length,
      `placements carrying \`${field}\``,
    );
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
  // a cell for a placement, so parsing 1,340 pieces walls nobody in.
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
