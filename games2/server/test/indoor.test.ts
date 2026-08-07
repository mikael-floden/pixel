// Indoors: the roof flood fill, the wall-dominance bar and the room-size floor
// (shared/src/indoor.ts).
// Fixtures are hand-built grids run through the real buildTerrainGrid, so the
// deck/deckBot sentinels under test are the ones the game actually gets. The
// bottom third of the file is REAL-WORLD: it sweeps every shipped world that
// ships decks, pins the counter-examples that ratio-alone cannot reject, and
// pins the elev precondition against the_island2's own bridges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTerrainGrid,
  parseWorld,
  findIndoorSpace,
  roofAbove,
  canEnterElev,
  CELL_WU,
  MAX_ROOF_CELLS,
  MIN_ROOM_CELLS,
  INDOOR_WALL_RATIO,
  INDOOR_DEPTH,
  type TerrainGrid,
  type ParsedWorld,
} from "@nangijala/shared";

const HERE = dirname(fileURLToPath(import.meta.url)); // games2/server/test
const REPO = join(HERE, "..", "..", ".."); // pixel repo root
const WORLDS = join(REPO, "maps2", "worlds");

const at = (g: TerrainGrid, col: number, row: number) => row * g.width + col;
const cellsOf = (g: TerrainGrid, s: Set<number>) =>
  [...s].map((i) => `(${i % g.width},${(i - (i % g.width)) / g.width})`).sort();

/** Loose deck shape — what buildTerrainGrid actually reads. Fixtures and the
 * mutated-real-world counter-examples both build these. */
type DeckIn = { level: number; thickness?: number; cells: { col: number; row: number }[] };

function loadWorld(name: string): ParsedWorld | null {
  const path = join(WORLDS, name, "world.json");
  if (!existsSync(path)) return null;
  return parseWorld(JSON.parse(readFileSync(path, "utf8")));
}

const gridOf = (w: ParsedWorld) => buildTerrainGrid(w.width, w.height, w.rows, w.props, w.decks ?? []);

/** A 5x6 map holding one 5x5 house: a ring of level-`wall` cells around a 3x3
 * level-0 floor, one door gap in the south wall at (2,4), and open level-0
 * ground along row 5. The roof deck (level `roof`, thickness 0) covers the
 * whole 5x5 footprint.
 *
 * `roof === wall` (the default) is how the_island2's house is authored, and it
 * is the EASY case: buildTerrainGrid keeps a deck only where it is ABOVE the
 * base (`d.level > level[i]`), so the wall cells end up carrying no deck at all
 * and the roof set can only be the interior. Raise the roof over its walls and
 * the wall cells DO carry the deck — that is the case that used to swallow the
 * walls into the roof set (see the roof-above-its-walls test).
 *
 * Its 3x3 floor + doorway is 10 roof cells, comfortably over MIN_ROOM_CELLS. */
function houseGrid(wall = 6, roof = 6, props: { col: number; row: number }[] = []): TerrainGrid {
  const rows: { t: string; l: number }[][] = [];
  for (let r = 0; r < 6; r++) {
    const row: { t: string; l: number }[] = [];
    for (let c = 0; c < 5; c++) {
      const isWall = r <= 4 && (r === 0 || r === 4 || c === 0 || c === 4);
      const door = r === 4 && c === 2;
      row.push({ t: "saturated_grass", l: isWall && !door ? wall : 0 });
    }
    rows.push(row);
  }
  const cells = [];
  for (let r = 0; r <= 4; r++) for (let c = 0; c < 5; c++) cells.push({ col: c, row: r });
  return buildTerrainGrid(5, 6, rows, props, [{ level: roof, thickness: 0, cells }]);
}

/** A 3x3 pier over water, with the_island2's exact fringe: 6 grass BANKS at the
 * deck's own level (4 levels up from a swimmer, so walls) and 6 open WATER
 * cells (entrances). wallRatio is exactly 0.50 — the highest any shipped bridge
 * reaches, and the point the wall bar used to be pinned to. */
function pierGrid(): TerrainGrid {
  const bank = new Set(["1,0", "2,0", "3,0", "0,1", "0,2", "0,3"]); // north + west fringe
  const rows: { t: string; l: number }[][] = [];
  for (let r = 0; r < 5; r++) {
    const row: { t: string; l: number }[] = [];
    for (let c = 0; c < 5; c++) {
      const isBank = bank.has(`${c},${r}`);
      row.push({ t: isBank ? "saturated_grass" : "clear_water", l: isBank ? 4 : 0 });
    }
    rows.push(row);
  }
  const cells = [];
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) cells.push({ col: c, row: r });
  return buildTerrainGrid(5, 5, rows, [], [{ level: 4, thickness: 0, cells }]);
}

test("roofAbove: a slab overhead is a roof, its own deck is not", () => {
  const g = houseGrid();
  assert.equal(roofAbove(g, 2, 2, 0), 6, "standing on the floor, roof at level 6");
  assert.equal(roofAbove(g, 2, 2, 6), null, "standing ON the roof: sky above");
  assert.equal(roofAbove(g, 0, 0, 0), null, "a wall cell carries no deck at all");
  assert.equal(roofAbove(g, 2, 5, 0), null, "open ground outside the house");
  assert.equal(roofAbove(g, -1, 2, 0), null, "off the west edge");
  assert.equal(roofAbove(g, 2, 99, 0), null, "off the south edge");
});

test("a 3x3 room with one door is indoors", () => {
  const g = houseGrid();
  const s = findIndoorSpace(g, 2, 2, 0);
  assert.ok(s, "player under the roof gets a space");
  assert.equal(s.indoor, true);
  assert.equal(s.roofLevel, 6);
  assert.equal(s.capped, false);
  // 3x3 floor + the doorway cell (which is also under the roof).
  assert.equal(s.roof.size, 10);
  assert.ok(s.roof.has(at(g, 2, 4)), "the doorway is under the roof");
  // Outline: 3 north + 3 west + 3 east + 2 south wall cells + the ground cell
  // in front of the door.
  assert.equal(s.fringe.size, 12);
  assert.equal(s.entrances.size, 1, "one way out");
  assert.ok(s.entrances.has(at(g, 2, 5)), "the ground in front of the door");
  assert.equal(s.wallRatio, 11 / 12);
});

test("left/right walls follow the (col+1,row) / (col,row+1) screen mapping", () => {
  const g = houseGrid();
  const s = findIndoorSpace(g, 2, 2, 0)!;
  // Down-RIGHT on screen is (col+1,row): the WEST wall column (col 0) has the
  // room on its right face. Down-LEFT is (col,row+1): the NORTH wall row
  // (row 0) has the room on its left face. (0,0) is neither — its two inward
  // sides are (1,0) and (0,1), both walls, not roof.
  // (1,4) is in there too: it is the south wall stub whose down-right
  // neighbour is the DOORWAY cell (2,4), which is under the roof — so it shows
  // the door a wall face, which is exactly the jamb you want drawn.
  assert.deepEqual(cellsOf(g, s.wallRight), ["(0,1)", "(0,2)", "(0,3)", "(1,4)"]);
  assert.deepEqual(cellsOf(g, s.wallLeft), ["(1,0)", "(2,0)", "(3,0)"]);
  // The east and south walls are real walls (they count for the wall rule) but
  // show the room no camera-facing face, so they are in neither set.
  for (const [c, r] of [[4, 1], [4, 2], [4, 3], [3, 4]] as const) {
    const i = at(g, c, r);
    assert.ok(s.fringe.has(i), `(${c},${r}) is fringe`);
    assert.ok(!s.wallLeft.has(i) && !s.wallRight.has(i), `(${c},${r}) draws no inward face`);
  }
  // A corner that DOES face in: put the probe on the north-west corner of the
  // roof set from outside. (0,0)'s right neighbour (1,0) is wall, so nothing.
  assert.ok(!s.wallRight.has(at(g, 0, 0)));
});

test("an open canopy (a 1-wide bridge) is NOT indoors", () => {
  // 13x3 flat ground, a 9-cell span at level 4 over the middle row. The span is
  // deliberately over MIN_ROOM_CELLS so this test is about the WALL rule alone
  // — the size floor must not be what saves it.
  const rows = Array.from({ length: 3 }, () =>
    Array.from({ length: 13 }, () => ({ t: "saturated_grass", l: 0 })),
  );
  const span = [2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => ({ col: c, row: 1 }));
  const g = buildTerrainGrid(13, 3, rows, [], [{ level: 4, thickness: 0, cells: span }]);
  const s = findIndoorSpace(g, 6, 1, 0);
  assert.ok(s);
  assert.equal(s.roof.size, 9, "the span, and only the span");
  assert.ok(s.roof.size >= MIN_ROOM_CELLS, "big enough to be a room — only the wall rule can refuse it");
  assert.equal(s.entrances.size, s.fringe.size, "you can step off it anywhere");
  assert.equal(s.wallRatio, 0);
  assert.equal(s.indoor, false, "walking under a bridge must not trigger indoor mode");

  // Same span, but through a canyon: the flanking cells are a 10-level cliff,
  // so the walls dominate and the space IS a tunnel. The rule is about
  // enclosure, not about the word "bridge".
  const canyon = rows.map((row, r) =>
    row.map((cell, c) => ({ ...cell, l: r === 1 ? 0 : c >= 1 && c <= 11 ? 10 : 0 })),
  );
  const t = findIndoorSpace(buildTerrainGrid(13, 3, canyon, [], [{ level: 14, thickness: 0, cells: span }]), 6, 1, 0);
  assert.ok(t);
  assert.equal(t.roof.size, 9);
  assert.equal(t.wallRatio, 18 / 20, "18 cliff cells, 2 open ends");
  assert.ok(t.indoor, `a covered canyon is indoors (ratio ${t.wallRatio})`);
});

test("a player standing on the roof — or inside the slab — is not indoors", () => {
  const g = houseGrid();
  assert.equal(findIndoorSpace(g, 2, 2, 6), null, "on the roof");
  // A thick cave ceiling: deck 24, thickness 16 => underside at 8. Under it is
  // indoors; at or above the underside you are in the rock, not in a room.
  const rows = [[{ t: "stone_mountain", l: 0 }, { t: "stone_mountain", l: 0 }]];
  const cave = buildTerrainGrid(2, 1, rows, [], [
    { level: 24, thickness: 16, cells: [{ col: 0, row: 0 }, { col: 1, row: 0 }] },
  ]);
  assert.ok(findIndoorSpace(cave, 0, 0, 0), "on the cave floor");
  assert.equal(findIndoorSpace(cave, 0, 0, 8), null, "at the slab underside");
  assert.equal(findIndoorSpace(cave, 0, 0, 24), null, "on top of the mountain");
});

test("the flood fill does not leak through a doorway or into the next house", () => {
  // Two 5x5 houses side by side in an 11x6 map, one open column between them,
  // identical roofs at level 6. Standing in the west house must not pull the
  // east house's cells in.
  const rows: { t: string; l: number }[][] = [];
  for (let r = 0; r < 6; r++) {
    const row: { t: string; l: number }[] = [];
    for (let c = 0; c < 11; c++) {
      const inWest = c <= 4 && r <= 4;
      const inEast = c >= 6 && r <= 4;
      const base = inWest ? c : inEast ? c - 6 : -1;
      const wall = base >= 0 && (r === 0 || r === 4 || base === 0 || base === 4);
      const door = r === 4 && base === 2;
      row.push({ t: "saturated_grass", l: wall && !door ? 6 : 0 });
    }
    rows.push(row);
  }
  const deckCells = [];
  for (let r = 0; r <= 4; r++) for (const c of [0, 1, 2, 3, 4, 6, 7, 8, 9, 10]) deckCells.push({ col: c, row: r });
  const g = buildTerrainGrid(11, 6, rows, [], [{ level: 6, thickness: 0, cells: deckCells }]);

  const west = findIndoorSpace(g, 2, 2, 0)!;
  assert.equal(west.indoor, true);
  assert.equal(west.roof.size, 10, "west interior + its doorway only");
  for (const i of west.roof) assert.ok(i % 11 <= 4, `cell ${i % 11} stayed west of the gap`);
  assert.ok(!west.roof.has(at(g, 8, 2)), "the east house is a separate space");
  // The fill also never escaped through the door into the open ground.
  assert.ok(!west.roof.has(at(g, 2, 5)));
  const east = findIndoorSpace(g, 8, 2, 0)!;
  assert.equal(east.indoor, true);
  assert.equal(east.roof.size, 10);
});

test("adjacent ceilings at different levels are one space; roofLevel stays the player's own", () => {
  // A cave slice: two cells, ceilings at 24 and 28 (undersides 8 and 8).
  const rows = [[
    { t: "stone_mountain", l: 0 },
    { t: "stone_mountain", l: 0 },
    { t: "saturated_grass", l: 0 },
  ]];
  const g = buildTerrainGrid(3, 1, rows, [], [
    { level: 24, thickness: 16, cells: [{ col: 0, row: 0 }] },
    { level: 28, thickness: 20, cells: [{ col: 1, row: 0 }] },
  ]);
  const s = findIndoorSpace(g, 0, 0, 0)!;
  assert.equal(s.roof.size, 2, "both ceilings are over the same head");
  assert.equal(s.roofLevel, 24, "the slab the player is actually under");
  assert.equal(findIndoorSpace(g, 1, 0, 0)!.roofLevel, 28);
});

test("the flood fill is bounded by the visited cap", () => {
  const N = 40;
  const rows = Array.from({ length: N }, () =>
    Array.from({ length: N }, () => ({ t: "saturated_grass", l: 0 })),
  );
  const cells = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cells.push({ col: c, row: r });
  const g = buildTerrainGrid(N, N, rows, [], [{ level: 4, thickness: 0, cells }]);

  const capped = findIndoorSpace(g, 20, 20, 0, { maxCells: 100 })!;
  assert.equal(capped.capped, true);
  assert.equal(capped.roof.size, 100, "not one cell past the budget");
  assert.equal(capped.indoor, false, "a truncated fill fails OUTDOORS");
  // With room to run it covers the whole decked map — and a roof with no
  // fringe at all (it runs off every edge) is enclosed by definition.
  const full = findIndoorSpace(g, 20, 20, 0)!;
  assert.equal(full.capped, false);
  assert.equal(full.roof.size, N * N);
  assert.equal(full.fringe.size, 0);
  assert.equal(full.indoor, true);
  assert.ok(MAX_ROOF_CELLS >= N * N, "the default budget covers this map");
});

// ---------------------------------------------------------------------------
// (1) the wall-dominance bar sits in the MEASURED gap between bridges and rooms
// ---------------------------------------------------------------------------

test("the wall bar sits mid-gap: 0.20 over the worst bridge, 0.23 under the lowest room", () => {
  assert.equal(INDOOR_WALL_RATIO, 0.7, "the bar itself");
  // The two ends of the measured gap, from the all-worlds sweep at the bottom
  // of this file. If either of these ever moves, re-centre the constant.
  const HIGHEST_BRIDGE = 0.5; // the_island2's 3x3 piers
  const LOWEST_ROOM = 0.9286; // the_island2's house, 13/14
  assert.ok(INDOOR_WALL_RATIO - HIGHEST_BRIDGE >= 0.19, "clear of every shipped bridge");
  assert.ok(LOWEST_ROOM - INDOOR_WALL_RATIO >= 0.22, "under every shipped room");

  // The pier the old 0.5 bar was pinned to: it is now 0.20 clear, not one
  // fringe cell clear, so the strict comparison is no longer load-bearing here.
  const g = pierGrid();
  const s = findIndoorSpace(g, 2, 2, 0)!;
  assert.equal(s.roof.size, 9, "the 3x3 span, and only the span");
  assert.equal(s.fringe.size, 12);
  assert.equal(s.entrances.size, 6, "six open water cells to swim out through");
  assert.equal(s.wallRatio, 0.5);
  assert.equal(s.indoor, false, "half-open is not a room");

  // The comparison stays STRICT, so a fringe that lands exactly ON the bar is
  // still refused. A 4x6 hall has a 20-cell fringe; open exactly 6 of them and
  // the ratio is 14/20 = 0.7 on the nose, with 24 roof cells so the size floor
  // cannot be what refuses it.
  const open = new Set(["1,0", "2,0", "3,0", "4,0", "5,1", "5,2"]); // north side + 2 east cells
  const tieRows = Array.from({ length: 8 }, (_, r) =>
    Array.from({ length: 6 }, (_, c) => {
      const inner = c >= 1 && c <= 4 && r >= 1 && r <= 6;
      return { t: "saturated_grass", l: inner || open.has(`${c},${r}`) ? 0 : 6 };
    }),
  );
  const tieDeck: DeckIn = {
    level: 6,
    thickness: 0,
    cells: [1, 2, 3, 4, 5, 6].flatMap((r) => [1, 2, 3, 4].map((c) => ({ col: c, row: r }))),
  };
  const tie = findIndoorSpace(buildTerrainGrid(6, 8, tieRows, [], [tieDeck]), 2, 3, 0)!;
  assert.equal(tie.roof.size, 24, "well over the size floor");
  assert.equal(tie.fringe.size, 20, "4 north + 4 south + 6 west + 6 east");
  assert.equal(tie.entrances.size, 6);
  assert.equal(tie.wallRatio, 0.7, "EXACTLY on the bar");
  assert.equal(tie.indoor, false, "a tie is not a majority — the comparison is strict");
});

// ---------------------------------------------------------------------------
// (2) a roof ABOVE its walls must not swallow the walls into the roof set
// ---------------------------------------------------------------------------

test("a roof raised above its own walls is still a room", () => {
  // The floor is level 0 and the player stands on it; the walls are 5-6 levels
  // up, so they are geometry the player cannot be inside — wall, not floor,
  // whether or not the roof deck happens to cover them too.
  for (const [wall, roof] of [[6, 7], [5, 6], [6, 8]] as const) {
    const g = houseGrid(wall, roof);
    const s = findIndoorSpace(g, 2, 2, 0);
    assert.ok(s, `walls ${wall} / roof ${roof}: there is a slab overhead`);
    assert.equal(s.roofLevel, roof);
    assert.equal(s.roof.size, 10, `walls ${wall} / roof ${roof}: 3x3 floor + doorway, no walls`);
    for (const i of s.roof) assert.equal(g.level[i], 0, "every roof cell is floor the player could stand on");
    assert.equal(s.fringe.size, 12, `walls ${wall} / roof ${roof}: the wall ring + the front step`);
    assert.equal(s.entrances.size, 1, "one way out");
    assert.equal(s.entrances.has(at(g, 2, 5)), true, "the ground in front of the door");
    assert.equal(s.wallRatio, 11 / 12);
    assert.equal(s.indoor, true, `walls ${wall} / roof ${roof} is indoors`);
  }
});

// ---------------------------------------------------------------------------
// (3) the entrance predicate respects solid geometry
// ---------------------------------------------------------------------------

test("a solid rock end cap is a wall, not a door (the tunnel fixture)", () => {
  // A stretch of mountain. The middle cells carry a ceiling slab [8,24] you can
  // walk under; the two end caps carry a slab [0,24] — solid rock all the way
  // to the floor, which canEnterElev refuses to walk into. The old level-only
  // predicate saw two cells at the player's own level and called them doors.
  const tunnel = (walkable: number) => {
    const n = walkable + 2;
    const rows = [Array.from({ length: n }, () => ({ t: "stone_mountain", l: 0 }))];
    const mid = Array.from({ length: walkable }, (_, k) => ({ col: k + 1, row: 0 }));
    return buildTerrainGrid(n, 1, rows, [], [
      { level: 24, thickness: 16, cells: mid },
      { level: 24, thickness: 24, cells: [{ col: 0, row: 0 }, { col: n - 1, row: 0 }] },
    ]);
  };

  const g = tunnel(3);
  assert.equal(g.deckBot[0], 0, "the end cap's slab reaches the floor");
  const s = findIndoorSpace(g, 2, 0, 0)!;
  assert.equal(s.roof.size, 3, "only the walkable stretch is under the ceiling");
  assert.equal(s.fringe.size, 2, "the two end caps");
  assert.equal(s.entrances.size, 0, "there is no way out of a sealed tunnel");
  assert.equal(s.wallRatio, 1, "both end caps count as WALL — the point of this fixture");
  assert.equal(s.indoor, false, "…but 3 cells is a nook, not a room: below MIN_ROOM_CELLS");

  // The same sealed tunnel, long enough to be a room. Same wallRatio, opposite
  // verdict — which is exactly what the size floor is for.
  const big = findIndoorSpace(tunnel(MIN_ROOM_CELLS), 2, 0, 0)!;
  assert.equal(big.roof.size, MIN_ROOM_CELLS);
  assert.equal(big.entrances.size, 0);
  assert.equal(big.wallRatio, 1);
  assert.equal(big.indoor, true, "a rock tunnel you can walk down IS indoors");
});

test("a prop standing in the doorway is a wall, not a door", () => {
  const g = houseGrid(6, 6, [{ col: 2, row: 5 }]); // a barrel on the front step
  assert.equal(g.blocked[at(g, 2, 5)], true);
  const s = findIndoorSpace(g, 2, 2, 0)!;
  assert.equal(s.roof.size, 10, "the prop is outside the house and changes no roof cell");
  assert.equal(s.fringe.size, 12);
  assert.equal(s.entrances.size, 0, "you cannot walk out through the barrel");
  assert.equal(s.wallRatio, 1);
  // Same house without the barrel: one door. (Guards against the fixture
  // itself, not just the rule.)
  assert.equal(findIndoorSpace(houseGrid(), 2, 2, 0)!.entrances.size, 1);
});

test("the entrance predicate agrees with the real canEnterElev", () => {
  // The module keeps an index-space TWIN of canEnterElev's base-surface branch
  // (indoor.ts standingOpen) because it must stay a leaf. This pins the twin to
  // the original: a 3x1 strip, a ceiling over the middle cell, and cell 0 given
  // every shape of "can I be there" the movement code distinguishes. Elevation
  // stays 0 and every deck sits well above it, so canEnterElev's base/deck
  // choice is never ambiguous and `elev === level` means "it picked the base".
  const climb = 2;
  const cases: { name: string; t: string; l: number; prop?: boolean; deck?: [number, number]; joins?: true }[] = [
    { name: "flat grass", t: "saturated_grass", l: 0 },
    { name: "a 1-level step", t: "saturated_grass", l: 1 },
    { name: "a 6-level wall", t: "saturated_grass", l: 6 },
    { name: "open water", t: "clear_water", l: 0 },
    { name: "a solid tree", t: "tree", l: 0 },
    { name: "a prop on the ground", t: "saturated_grass", l: 0, prop: true },
    { name: "solid rock to the floor", t: "stone_mountain", l: 0, deck: [24, 24] },
    { name: "a prop under a ceiling", t: "stone_mountain", l: 0, prop: true, deck: [24, 16] },
    // Walkable ground under its own ceiling is not fringe at all — it is more
    // ROOM, and the fill joins it. (The one case where "can I be there" means
    // the cell is inside, not an exit.)
    { name: "ground under a high ceiling", t: "stone_mountain", l: 0, deck: [24, 16], joins: true },
  ];
  for (const cse of cases) {
    const rows = [[
      { t: cse.t, l: cse.l },
      { t: "stone_mountain", l: 0 },
      { t: "stone_mountain", l: 0 },
    ]];
    const decks: DeckIn[] = [{ level: 24, thickness: 16, cells: [{ col: 1, row: 0 }] }];
    if (cse.deck) decks.push({ level: cse.deck[0], thickness: cse.deck[1], cells: [{ col: 0, row: 0 }] });
    const g = buildTerrainGrid(3, 1, rows, cse.prop ? [{ col: 0, row: 0 }] : [], decks);
    const s = findIndoorSpace(g, 1, 0, 0, { climb })!;
    if (cse.joins) {
      assert.ok(s.roof.has(0), `${cse.name}: cell 0 is more room`);
      assert.ok(!s.fringe.has(0));
      continue;
    }
    assert.ok(s.fringe.has(0), `${cse.name}: cell 0 is fringe`);
    // The real rule, straight out of index.ts: can a mover at elev 0 in the
    // middle cell step onto cell 0's BASE surface, and is the step small
    // enough either way to be a way out?
    const mid = (c: number) => (c + 0.5) * CELL_WU;
    const r = canEnterElev(g, 0, mid(1), mid(0), mid(0), mid(0), { maxClimb: climb, canSwim: true });
    const expected = r.ok && Math.abs(r.elev - g.level[0]) < 1e-9 && Math.abs(g.level[0] - 0) <= climb;
    assert.equal(s.entrances.has(0), expected, `${cse.name}: entrance iff the movement code lets you out`);
  }
});

// ---------------------------------------------------------------------------
// (4) roofAbove rejects coordinates that are not cells
// ---------------------------------------------------------------------------

test("roofAbove returns null (never undefined) for a non-cell coordinate", () => {
  const g = houseGrid();
  for (const [c, r] of [[1.6, 2], [2, 2.5], [NaN, 2], [2, NaN], [Infinity, 2]] as const) {
    const v = roofAbove(g, c, r, 0);
    assert.equal(v, null, `roofAbove(${c},${r}) is null`);
    assert.notEqual(typeof v, "undefined", `roofAbove(${c},${r}) is not undefined`);
  }
  assert.equal(roofAbove(g, 2, 2, NaN), null, "a non-finite elevation is not a place to stand");
  // ...and findIndoorSpace's `=== null` guard therefore actually fires.
  for (const [c, r] of [[1.6, 2], [NaN, 2]] as const) {
    assert.equal(findIndoorSpace(g, c, r, 0), null, `findIndoorSpace(${c},${r}) is null`);
  }
  assert.equal(findIndoorSpace(g, 2, 2, NaN), null);
});

// ---------------------------------------------------------------------------
// (5) an unusable maxCells falls back to the default
// ---------------------------------------------------------------------------

test("an invalid maxCells falls back to the default budget", () => {
  const g = houseGrid();
  const full = findIndoorSpace(g, 2, 2, 0)!;
  for (const maxCells of [NaN, 0, -5, Infinity, -Infinity]) {
    const s = findIndoorSpace(g, 2, 2, 0, { maxCells })!;
    assert.equal(s.capped, false, `maxCells ${maxCells}: not capped`);
    assert.equal(s.roof.size, full.roof.size, `maxCells ${maxCells}: the whole room`);
    assert.equal(s.indoor, true, `maxCells ${maxCells}: still a room`);
  }
  // A real budget still binds.
  const tight = findIndoorSpace(g, 2, 2, 0, { maxCells: 3 })!;
  assert.equal(tight.capped, true);
  assert.equal(tight.roof.size, 3);
});

// ---------------------------------------------------------------------------
// (6) what is (and is not) in wallLeft / wallRight — the sets OVERLAP
// ---------------------------------------------------------------------------

test("wallLeft/wallRight hold the FAR walls only; the near walls are fringe minus entrances minus the UNION", () => {
  const g = houseGrid();
  const s = findIndoorSpace(g, 2, 2, 0)!;
  // The TRUE relationship: entrances is disjoint from both wall sets, but the
  // two wall sets OVERLAP at corners — so the near walls are the fringe minus
  // the entrances minus the UNION of the two, never minus their sizes summed.
  const near = [...s.fringe].filter((i) => !s.entrances.has(i) && !s.wallLeft.has(i) && !s.wallRight.has(i));
  const union = new Set([...s.wallLeft, ...s.wallRight]);
  for (const i of union) assert.ok(!s.entrances.has(i), "an opening is never a wall face");
  assert.equal(s.entrances.size + union.size + near.length, s.fringe.size, "fringe = entrances + far walls + near walls");
  // wallRight = the room's up-LEFT (west) side: its DOWN-RIGHT neighbour is in.
  for (const i of s.wallRight) assert.ok(s.roof.has(i + 1), "wallRight's (col+1,row) is inside");
  for (const i of s.wallLeft) assert.ok(s.roof.has(i + g.width), "wallLeft's (col,row+1) is inside");
  // The near (down-screen) walls are the east + south ones — real walls for the
  // enclosure rule, no drawn inward face, so nothing to cull.
  assert.deepEqual(cellsOf(g, new Set(near)), ["(3,4)", "(4,1)", "(4,2)", "(4,3)"]);
  assert.ok(s.wallRatio > INDOOR_WALL_RATIO, "and they still count toward enclosure");
  // This fixture happens to have NO corner in both sets, which is exactly why
  // the old subtraction identity survived here — see the cave test below.
  assert.equal([...s.wallLeft].filter((i) => s.wallRight.has(i)).length, 0);
});

test("the_island2 cave: the two wall sets overlap only at INSIDE corners", () => {
  const world = loadWorld("the_island2");
  if (!world) return test.skip("maps2/worlds/the_island2 missing");
  const grid = gridOf(world);
  // Inside the east-mountain cave: 12 touching deck slabs, one 472-cell space.
  const s = findIndoorSpace(grid, 120, 70, 0)!;
  assert.equal(s.roof.size, 472, "the whole connected cave");
  assert.equal(s.fringe.size, 267);
  assert.equal(s.entrances.size, 4);
  assert.equal(s.wallLeft.size, 80);
  assert.equal(s.wallRight.size, 73);
  const both = [...s.wallLeft].filter((i) => s.wallRight.has(i));
  assert.equal(both.length, 7, "7 cells show the room BOTH of their drawn faces");
  // …and every one of them is an INSIDE corner — a nub of rock the cave wraps
  // around, so BOTH lower neighbours are interior. (Maintainer 2026-08-06: "a
  // corner is perfectly covered both to the right and to the left" — true of a
  // room's OWN corner, which is why that one is in neither set; this is the
  // opposite shape.) A cell in both sets is by definition one whose down-right
  // AND down-left neighbours are both roof, so assert the whole local picture.
  for (const j of both) {
    const c = j % grid.width;
    const r = (j - c) / grid.width;
    assert.ok(!s.roof.has(j), `(${c},${r}) is fringe, not roof`);
    assert.ok(s.roof.has(r * grid.width + c + 1), `(${c},${r}) down-right is interior`);
    assert.ok(s.roof.has((r + 1) * grid.width + c), `(${c},${r}) down-left is interior`);
    // The nub points UP-screen: at least one of its up-screen neighbours is
    // NOT interior, else it would be surrounded and could not be fringe.
    assert.ok(
      !s.roof.has(r * grid.width + c - 1) || !s.roof.has((r - 1) * grid.width + c),
      `(${c},${r}) is a nub poking in, not an enclosed hole`,
    );
  }
  // The identity the interface used to document is arithmetically wrong here.
  const near = [...s.fringe].filter((i) => !s.entrances.has(i) && !s.wallLeft.has(i) && !s.wallRight.has(i));
  assert.equal(near.length, 117, "the true near-wall count");
  assert.equal(s.fringe.size - s.entrances.size - s.wallLeft.size - s.wallRight.size, 110,
    "…which the old subtraction under-counts by exactly the inside-corner overlap");
  // The identity that IS true, on the real geometry.
  const union = new Set([...s.wallLeft, ...s.wallRight]);
  assert.equal(s.entrances.size + union.size + near.length, s.fringe.size);
  assert.equal(s.indoor, true, "and it is very much a room");
});

// ---------------------------------------------------------------------------
// (7) the room-size floor — the counter-examples ratio alone cannot reject
// ---------------------------------------------------------------------------

test("MIN_ROOM_CELLS sits between the biggest tiny span and the smallest shipped room", () => {
  assert.equal(MIN_ROOM_CELLS, 8);
  assert.ok(MIN_ROOM_CELLS > 4, "clear of the largest tiny-span counter-example (4 cells)");
  assert.ok(MIN_ROOM_CELLS < 13, "clear of the smallest shipped interior (the_island2's house, 13 cells)");
});

test("tiny spans that clear the wall bar are still NOT rooms", () => {
  // Every one of these reads indoor === true on wall ratio alone. All of them
  // are 3 roof cells or fewer, and all of them are things you walk under.
  const cases: { name: string; grid: TerrainGrid; col: number; row: number; roof: number; ratio: number }[] = [];

  // A 3-cell bridge over a narrow ravine: 6 cliff cells beside it, the ravine
  // floor open at both ends.
  cases.push({
    name: "a 3-cell bridge over a narrow ravine",
    grid: buildTerrainGrid(
      5, 6,
      Array.from({ length: 6 }, () => Array.from({ length: 5 }, (_, c) => ({ t: "saturated_grass", l: c === 2 ? 0 : 8 }))),
      [],
      [{ level: 8, thickness: 0, cells: [1, 2, 3].map((r) => ({ col: 2, row: r })) }],
    ),
    col: 2, row: 2, roof: 3, ratio: 0.75,
  });

  // A 2-cell arch over a 2-cell gully: a sealed pit, ratio a perfect 1.00.
  cases.push({
    name: "a 2-cell arch over a 2-cell gully",
    grid: buildTerrainGrid(
      5, 5,
      Array.from({ length: 5 }, (_, r) =>
        Array.from({ length: 5 }, (_, c) => ({ t: "saturated_grass", l: c === 2 && (r === 2 || r === 3) ? 0 : 8 }))),
      [],
      [{ level: 8, thickness: 0, cells: [{ col: 2, row: 2 }, { col: 2, row: 3 }] }],
    ),
    col: 2, row: 2, roof: 2, ratio: 1,
  });

  // A bridge over a dead-end inlet: water poking into the shore, land on three
  // sides, one way out to the open sea.
  cases.push({
    name: "a bridge over a dead-end inlet, shore on three sides",
    grid: buildTerrainGrid(
      5, 7,
      Array.from({ length: 7 }, (_, r) =>
        Array.from({ length: 5 }, (_, c) =>
          c === 2 && r <= 3 ? { t: "clear_water", l: 0 } : { t: "saturated_grass", l: 4 })),
      [],
      [{ level: 4, thickness: 0, cells: [1, 2, 3].map((r) => ({ col: 2, row: r })) }],
    ),
    col: 2, row: 2, roof: 3, ratio: 0.875,
  });

  for (const c of cases) {
    const s = findIndoorSpace(c.grid, c.col, c.row, 0)!;
    assert.ok(s, `${c.name}: there is a slab overhead`);
    assert.equal(s.roof.size, c.roof, `${c.name}: roof size`);
    assert.equal(s.wallRatio, c.ratio, `${c.name}: wall ratio`);
    assert.ok(s.wallRatio > INDOOR_WALL_RATIO, `${c.name}: it CLEARS the wall bar — only the size floor refuses it`);
    assert.ok(s.roof.size < MIN_ROOM_CELLS, `${c.name}: too small to be a room`);
    assert.equal(s.indoor, false, `${c.name}: OUTDOORS`);
  }
});

test("the_island2's own pier, stretched or narrowed, is still a bridge", () => {
  // Both of these are the REAL 3x3 pier (deck at cols 118-120, rows 182-184,
  // level 4 over a level-0 water channel) with one small edit — and both read
  // indoor === true against a 0.5 bar.
  const world = loadWorld("the_island2");
  if (!world) return test.skip("maps2/worlds/the_island2 missing");
  const decks = world.decks!;
  const pier = decks.findIndex((d) => d.cells.some((c) => c.col === 119 && c.row === 183));
  assert.ok(pier >= 0, "found the pier deck");
  assert.equal(decks[pier].kind, "bridge");

  const withDecks = (ds: DeckIn[], rows = world.rows) =>
    buildTerrainGrid(world.width, world.height, rows, world.props, ds);
  const asIs = decks as unknown as DeckIn[];

  // Baseline: the shipped pier is exactly on the old bar.
  const real = findIndoorSpace(withDecks(asIs), 119, 183, 0)!;
  assert.equal(real.roof.size, 9);
  assert.equal(real.wallRatio, 0.5);
  assert.equal(real.indoor, false);

  // One row longer over the same channel: 14 fringe, still 6 water cells.
  const longer = asIs.map((d, i) =>
    i !== pier ? d : { ...d, cells: [...d.cells, ...[118, 119, 120].map((col) => ({ col, row: 185 }))] });
  const s1 = findIndoorSpace(withDecks(longer), 119, 183, 0)!;
  assert.equal(s1.roof.size, 12);
  assert.equal(s1.wallRatio, 8 / 14, "0.5714 — over the old 0.5 bar");
  assert.ok(s1.roof.size >= MIN_ROOM_CELLS, "big enough to be a room: only the wall bar can refuse it");
  assert.equal(s1.indoor, false, "still a bridge");

  // The channel narrowed by one column (col 118 becomes bank): 10 fringe, 4
  // water cells. The deck cell over the new bank is dropped by buildTerrainGrid
  // (a deck at its own base level is not an overpass), so the span is 2x3.
  const narrowed = world.rows.map((row, y) =>
    row.map((cell, x) => (x === 118 && y >= 179 && y <= 189 ? { ...cell, t: "saturated_grass", l: 4 } : cell)));
  const s2 = findIndoorSpace(withDecks(asIs, narrowed), 119, 183, 0)!;
  assert.equal(s2.roof.size, 6);
  assert.equal(s2.wallRatio, 0.6, "over the old 0.5 bar");
  assert.equal(s2.indoor, false, "still a bridge");
});

// ---------------------------------------------------------------------------
// (8) the elev PRECONDITION: elev must be a resolved surface at that cell
// ---------------------------------------------------------------------------

test("an elevation that is not a surface at this cell returns null, not a room", () => {
  const world = loadWorld("the_island2");
  if (!world) return test.skip("maps2/worlds/the_island2 missing");
  const grid = gridOf(world);

  // The level-36 span at cols 100-106, rows 44-45, over level-0 open water.
  // Standing ON the water (the resolved base surface) is an ordinary bridge.
  const ground = findIndoorSpace(grid, 100, 44, 0)!;
  assert.ok(ground, "the water under the span is a real surface");
  assert.equal(ground.wallRatio, 1 / 3, "mostly open water — nowhere near a room");
  assert.equal(ground.indoor, false);

  // Three levels up is INSIDE THE OPEN AIR under the span — no surface. The
  // water is then 3 levels below, past ENTRANCE_CLIMB, so every fringe cell
  // reads as a wall and the space would report wallRatio 1.0 and indoor true.
  for (const elev of [1, 3, 12, 35]) {
    assert.equal(findIndoorSpace(grid, 100, 44, elev), null,
      `elev ${elev} under the level-36 span is not a surface`);
  }
  // Nor is anything under the 3x3 pier except the water itself.
  assert.ok(findIndoorSpace(grid, 119, 183, 0), "elev 0 IS the pier's water surface");
  for (const elev of [1, 2, 3]) {
    assert.equal(findIndoorSpace(grid, 119, 183, elev), null, `elev ${elev} under the pier is not a surface`);
  }

  // NOTHING roofed on any bridge in the world is reachable at a non-surface
  // elevation any more. (Measured before the fix: 1348 roofed (cell,elev)
  // pairs, 1051 of them INDOOR.)
  let offSurface = 0;
  for (const d of world.decks ?? []) {
    if (d.kind !== "bridge") continue;
    for (const c of d.cells) {
      for (let e = 0; e <= d.level; e++) {
        if (Math.abs(grid.level[c.row * grid.width + c.col] - e) < 1e-9) continue;
        if (findIndoorSpace(grid, c.col, c.row, e) !== null) offSurface++;
      }
    }
  }
  assert.equal(offSurface, 0, "no space is reported at an elevation the player cannot stand on");
});

test("the precondition tolerates float noise but not a real level step", () => {
  const g = houseGrid();
  assert.ok(findIndoorSpace(g, 2, 2, 0), "the floor itself");
  assert.ok(findIndoorSpace(g, 2, 2, 1e-9), "a hair of interpolation noise still stands on the floor");
  assert.ok(findIndoorSpace(g, 2, 2, -1e-9), "…in both directions");
  assert.equal(findIndoorSpace(g, 2, 2, 0.5), null, "half a level up is not a surface");
  assert.equal(findIndoorSpace(g, 2, 2, 3), null, "and neither is mid-air");
});

// ---------------------------------------------------------------------------
// (9) the REAL WORLDS — every shipped world that ships decks
// ---------------------------------------------------------------------------

/** Every world.json under maps2/worlds that carries a `decks` array. */
function deckedWorlds(): { name: string; world: ParsedWorld }[] {
  if (!existsSync(WORLDS)) return [];
  const out: { name: string; world: ParsedWorld }[] = [];
  for (const name of readdirSync(WORLDS).sort()) {
    const world = loadWorld(name);
    if (world?.decks?.length) out.push({ name, world });
  }
  return out;
}

test("the_island2: standing under the house roof is indoors", () => {
  const world = loadWorld("the_island2");
  if (!world) return test.skip("maps2/worlds/the_island2 missing");
  const grid = gridOf(world);

  // The island's one kind:"roof" deck is the house at cols 198-203, rows
  // 113-117: level-6 walls with a level-0 floor and a door gap at (201,117).
  const s = findIndoorSpace(grid, 200, 115, 0);
  assert.ok(s, "there is a roof over the house floor");
  assert.equal(s.indoor, true, `house is indoors (wall ratio ${s.wallRatio})`);
  assert.equal(s.roofLevel, 6);
  assert.equal(s.capped, false);
  // 13 cells — the SMALLEST real interior in any shipped world, and the number
  // MIN_ROOM_CELLS has to stay clear of.
  assert.equal(s.roof.size, 13, "the smallest shipped interior");
  assert.ok(s.roof.size > MIN_ROOM_CELLS, "…still over the size floor");
  assert.equal(s.wallRatio, 13 / 14);
  assert.ok(s.entrances.size >= 1, "the house has a way out");
  assert.ok(s.wallLeft.size + s.wallRight.size >= 1, "and camera-facing walls to cut away");
  // Out on the grass in front of the house there is no roof at all.
  assert.equal(findIndoorSpace(grid, 200, 120, 0), null);
});

test("every shipped world: no bridge cell is indoors, every roof/cave space is", () => {
  const worlds = deckedWorlds();
  const names = worlds.map((w) => w.name);
  for (const want of ["occlusion_test", "the_island", "the_island2"]) {
    assert.ok(names.includes(want), `${want} ships decks; swept ${names.join(",")}`);
  }

  const bad: string[] = [];
  const seen = new Map<string, { cells: number; worst: number; best: number }>();
  for (const { name, world } of worlds) {
    const grid = gridOf(world);
    for (const d of world.decks ?? []) {
      for (const c of d.cells) {
        const i = c.row * grid.width + c.col;
        // Stand on the cell's own resolved BASE surface — the precondition.
        // (Roof decks also cover their wall cells, where the deck is dropped
        // for sitting at base level and there is nothing to be under.)
        const s = findIndoorSpace(grid, c.col, c.row, grid.level[i]);
        if (!s) continue;
        const key = `${name}/${d.kind}`;
        const acc = seen.get(key) ?? { cells: 0, worst: 1, best: 0 };
        acc.cells++;
        acc.worst = Math.min(acc.worst, s.wallRatio);
        acc.best = Math.max(acc.best, s.wallRatio);
        seen.set(key, acc);
        const want = d.kind !== "bridge";
        if (s.indoor !== want) {
          bad.push(`${key} (${c.col},${c.row}) indoor ${s.indoor} want ${want} — ratio ${s.wallRatio.toFixed(4)}, roof ${s.roof.size}`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], "every deck cell agrees with its kind");

  // The sweep must actually have covered the geometry we think it did — an
  // empty sweep would pass the assertion above vacuously. These are the cells
  // you can stand UNDER (a roof deck also covers its wall cells, where the deck
  // is dropped for sitting at base level and there is nothing to be under).
  const counts = Object.fromEntries([...seen].map(([k, v]) => [k, v.cells]));
  for (const [key, want] of Object.entries({
    "occlusion_test/roof": 49,
    "occlusion_test/bridge": 30,
    "the_island/bridge": 36,
    "the_island2/bridge": 96,
    "the_island2/roof": 13,
    "the_island2/cave": 472,
  })) {
    assert.equal(counts[key], want, `${key}: cells swept`);
  }
  // And the measured gap INDOOR_WALL_RATIO sits in the middle of.
  const bridgeMax = Math.max(...[...seen].filter(([k]) => k.endsWith("/bridge")).map(([, v]) => v.best));
  const roomMin = Math.min(...[...seen].filter(([k]) => !k.endsWith("/bridge")).map(([, v]) => v.worst));
  assert.equal(bridgeMax, 0.5, "the worst shipped bridge");
  assert.ok(Math.abs(roomMin - 13 / 14) < 1e-9, "the best-open shipped room");
  assert.ok(bridgeMax < INDOOR_WALL_RATIO && INDOOR_WALL_RATIO < roomMin, "the bar is inside the gap");
  assert.ok(INDOOR_WALL_RATIO - bridgeMax > 0.19 && roomMin - INDOOR_WALL_RATIO > 0.22, "…with margin on both sides");
});

// ---------------------------------------------------------------------------
// DEPTH — the second way in (maintainer 2026-08-06: "if you continue to make
// the bridge wider at some point it's not a bridge - it's a tunnel/water cave…
// it would be really cool to swim into a water cave and the outside turns
// dark"). The wall ratio cannot see this case: a covered channel keeps both
// ends open however long it runs, so its ratio stays flat while it plainly
// becomes an interior. INDOOR_DEPTH asks where you are standing instead.
// ---------------------------------------------------------------------------

/** A covered water channel: `len` rows of 5-wide water (level 0) between two
 * level-4 banks, roofed at level 4 over the water only, open at both ends.
 * WIDE on purpose — a narrow one is wall-dominated and the ratio rule already
 * catches it; this is the shape that defeats the ratio. */
function channelGrid(len: number): TerrainGrid {
  const w = 7;
  const h = len + 2;
  const rows: { t: string; l: number }[][] = [];
  for (let r = 0; r < h; r++) {
    const row: { t: string; l: number }[] = [];
    for (let c = 0; c < w; c++) {
      const bank = c === 0 || c === 6;
      row.push({ t: bank ? "saturated_grass" : "clear_water", l: bank ? 4 : 0 });
    }
    rows.push(row);
  }
  const cells = [];
  for (let r = 1; r <= len; r++) for (let c = 1; c <= 5; c++) cells.push({ col: c, row: r });
  return buildTerrainGrid(w, h, rows, [], [{ level: 4, thickness: 0, cells }]);
}

test("a wide covered channel: shallow is a bridge, deep is a water cave", () => {
  const g = channelGrid(10);

  // At the mouth you can still see out — this must read OUTDOORS however long
  // the channel is behind you.
  const mouth = findIndoorSpace(g, 3, 2, 0);
  assert.ok(mouth);
  assert.equal(mouth.roof.size, 50, "5 wide x 10 long");
  assert.ok(mouth.roof.size >= MIN_ROOM_CELLS, "big enough — only the two ways IN can refuse it");
  assert.equal(mouth.entrances.size, 10, "five open water cells at each end");
  assert.ok(
    mouth.wallRatio < INDOOR_WALL_RATIO,
    `the ratio rule cannot see this shape (${mouth.wallRatio.toFixed(4)}) — that is the point`,
  );
  assert.equal(mouth.depth, 2, "two cells in from the open end");
  assert.equal(mouth.indoor, false, "still a bridge you are stepping under");

  // Swim on and the SAME space turns into a cave around you.
  const deep = findIndoorSpace(g, 3, 5, 0);
  assert.ok(deep);
  assert.equal(deep.roof.size, mouth.roof.size, "same space, different cell");
  assert.equal(deep.wallRatio, mouth.wallRatio, "…and the same ratio — depth is the only thing that moved");
  assert.equal(deep.depth, 5);
  assert.ok(deep.depth >= INDOOR_DEPTH);
  assert.ok(deep.indoor, "deep under a wide roof is a water cave");

  // The boundary is exactly INDOOR_DEPTH, and it is a property of the CELL.
  for (const [row, depth] of [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]] as const) {
    const s = findIndoorSpace(g, 3, row, 0);
    assert.ok(s);
    assert.equal(s.depth, depth, `row ${row}`);
    assert.equal(s.indoor, depth >= INDOOR_DEPTH, `row ${row} at depth ${depth}`);
  }
});

test("a short covered channel is a bridge at every cell", () => {
  // Six rows: the deepest cell is 3 from an end, one short of INDOOR_DEPTH.
  const g = channelGrid(6);
  for (let r = 1; r <= 6; r++) {
    const s = findIndoorSpace(g, 3, r, 0);
    assert.ok(s);
    assert.ok(s.depth < INDOOR_DEPTH, `row ${r} depth ${s.depth}`);
    assert.equal(s.indoor, false, `row ${r}: still a bridge`);
  }
  // …and it is genuinely the depth rule doing the refusing, not the ratio or
  // the size floor, both of which are unchanged from the 10-row case.
  const s = findIndoorSpace(g, 3, 3, 0);
  assert.ok(s);
  assert.ok(s.roof.size >= MIN_ROOM_CELLS, "30 cells");
  assert.ok(s.wallRatio < INDOOR_WALL_RATIO);
});

test("depth is 1 at the doorway and grows inward; a sealed space is infinite", () => {
  // The house: its door cell is depth 1, the far corner deeper. (It is indoors
  // throughout on the WALL rule — depth is not what carries it.)
  const g = houseGrid();
  const door = findIndoorSpace(g, 2, 4, 0); // the doorway cell itself
  assert.ok(door);
  assert.equal(door.depth, 1, "one step from the opening");
  assert.ok(door.indoor, "carried by the wall rule, not by depth");
  const back = findIndoorSpace(g, 1, 1, 0); // far corner
  assert.ok(back);
  assert.ok(back.depth > door.depth, `back ${back.depth} vs door ${door.depth}`);

  // No entrances at all: nothing to walk out to, so the depth is infinite.
  // (The wall rule already calls this indoors — the point is that depth does
  // not read 0 and quietly cancel it.)
  const sealed = findIndoorSpace(channelSealed(), 3, 5, 0);
  assert.ok(sealed);
  assert.equal(sealed.entrances.size, 0);
  assert.equal(sealed.wallRatio, 1);
  assert.equal(sealed.depth, Number.POSITIVE_INFINITY);
  assert.ok(sealed.indoor);
});

/** The 10-row channel with both ends walled off by level-4 rock: a sealed room. */
function channelSealed(): TerrainGrid {
  const w = 7;
  const len = 10;
  const h = len + 2;
  const rows: { t: string; l: number }[][] = [];
  for (let r = 0; r < h; r++) {
    const row: { t: string; l: number }[] = [];
    for (let c = 0; c < w; c++) {
      const wall = c === 0 || c === 6 || r === 0 || r === h - 1;
      row.push({ t: wall ? "stone_mountain" : "clear_water", l: wall ? 4 : 0 });
    }
    rows.push(row);
  }
  const cells = [];
  for (let r = 1; r <= len; r++) for (let c = 1; c <= 5; c++) cells.push({ col: c, row: r });
  return buildTerrainGrid(w, h, rows, [], [{ level: 4, thickness: 0, cells }]);
}

test("INDOOR_DEPTH clears every bridge the game ships", () => {
  // The constant's whole justification: no shipped bridge cell is ever more
  // than 3 cells from daylight, so the depth rule cannot fire on one. If a
  // future world authors a deeper span, this fails and the bar gets re-tuned
  // against the new distribution (or the span really is a tunnel).
  const worst = new Map<string, number>();
  for (const { name, world } of deckedWorlds()) {
    const grid = gridOf(world);
    for (const d of world.decks ?? []) {
      for (const c of d.cells) {
        const i = c.row * grid.width + c.col;
        const s = findIndoorSpace(grid, c.col, c.row, grid.level[i]);
        if (!s || !Number.isFinite(s.depth)) continue;
        const key = `${name}/${d.kind}`;
        worst.set(key, Math.max(worst.get(key) ?? 0, s.depth));
      }
    }
  }
  const bridges = [...worst].filter(([k]) => k.endsWith("/bridge"));
  assert.ok(bridges.length >= 3, `swept ${bridges.length} bridge decks`);
  const deepestBridge = Math.max(...bridges.map(([, v]) => v));
  assert.equal(deepestBridge, 3, "occlusion_test's wide test span is the deepest shipped bridge");
  assert.ok(deepestBridge < INDOOR_DEPTH, "…and the bar sits above it");
  // Interiors DO go deep — the rule is not vacuous.
  const rooms = [...worst].filter(([k]) => !k.endsWith("/bridge"));
  assert.ok(
    rooms.every(([, v]) => v >= INDOOR_DEPTH),
    `every shipped interior reaches INDOOR_DEPTH: ${JSON.stringify(Object.fromEntries(rooms))}`,
  );
});

test("a room's OWN corners are in neither wall set — they only show their top", () => {
  // Maintainer 2026-08-06: "The only side a corner shows is top … A corner is
  // perfectly covered both to the right and to the left." Correct, and stronger
  // than the code needs to be: the fringe is 4-CONNECTED, so a cell diagonally
  // off a room's corner touches the room at a point only and is never collected
  // at all. Pinned on a clean square room so a future 8-connected fringe (an
  // easy "improvement" to reach for) fails right here.
  const W = 7;
  const rows = Array.from({ length: W }, (_, r) =>
    Array.from({ length: W }, (_, c) => {
      const wall = c === 0 || c === W - 1 || r === 0 || r === W - 1;
      return { t: wall ? "stone_mountain" : "saturated_grass", l: wall ? 6 : 0 };
    }),
  );
  const cells = [];
  for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) cells.push({ col: c, row: r });
  const g = buildTerrainGrid(W, W, rows, [], [{ level: 6, thickness: 0, cells }]);
  const s = findIndoorSpace(g, 3, 3, 0);
  assert.ok(s);
  assert.equal(s.roof.size, 25, "the 5x5 floor; the level-6 ring is wall, not roof");
  assert.equal(s.fringe.size, 20, "the wall ring MINUS its four corners");
  for (const [name, c, r] of [["N", 0, 0], ["E", W - 1, 0], ["W", 0, W - 1], ["S", W - 1, W - 1]] as const) {
    const j = r * W + c;
    assert.equal(s.fringe.has(j), false, `${name} corner is not even fringe`);
    assert.equal(s.wallLeft.has(j), false, `${name} corner shows no left face inward`);
    assert.equal(s.wallRight.has(j), false, `${name} corner shows no right face inward`);
  }
  // With no inside corners anywhere, the two sets are disjoint here — the
  // overlap is a property of concave geometry, not of rooms.
  assert.equal([...s.wallLeft].filter((j) => s.wallRight.has(j)).length, 0);
  assert.equal(s.wallLeft.size, 5);
  assert.equal(s.wallRight.size, 5);
});
