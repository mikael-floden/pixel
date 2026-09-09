// ============================================================================
// SPAWNS3 — monsters live in a `pixel-maps3` world
// ============================================================================
//
// maps2/worlds3/the_game ships its spawn zones under `pixel-maps3/spawns@1`.
// The zone DOCUMENT is the shape the retired maps2/worlds tree shipped under
// `pixel-maps2/spawns@1` — the version rides with the WORLD schema, not with
// the zone shape — so `parseSpawns` reads both names. Before that it read one,
// returned [] for the other, and the_game joined with every zone and ZERO
// monsters: an island with no life in it, no error anywhere.
//
// Everything here is measured against the REAL files in the same test (counts
// are DERIVED, never transcribed), so the parser and the map data cannot drift
// apart quietly. There is deliberately NO sha256 pin on a spawns.json: the
// monster roster grows on its own and maps2 re-runs spawns.py after it, so a
// digest over that data would fail on maps2's pushes rather than on ours. The
// data-independent statement of "nothing changed" is the identity + schema-swap
// pair below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseWorld,
  buildTerrainGrid,
  parseSpawns,
  buildZoneRuntimes,
  zonePolygonCells,
  surfaceFor,
  type SpawnZone,
  type TerrainGrid,
} from "@nangijala/shared";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GAME3 = join(REPO, "maps2", "worlds3", "the_game");

const read = (p: string): any => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const game3 = read(join(GAME3, "spawns.json"));
const worldDoc = read(join(GAME3, "world.json"));

/** The world's terrain grid, exactly as WorldRoom builds it at room create.
 * Memoized: parsing the_game's world.json costs ~1s and four tests want the
 * same grid. */
let cached: TerrainGrid | null | undefined;
function gridOf(): TerrainGrid | null {
  if (cached === undefined) {
    const w = worldDoc ? parseWorld(worldDoc) : null;
    cached = w ? buildTerrainGrid(w.width, w.height, w.rows, w.props, w.decks) : null;
  }
  return cached;
}

// ---------------------------------------------------------------------------
// The shape claim the schema widening rests on
// ---------------------------------------------------------------------------

test("the_game's zone document is the spawns@1 shape, field for field", () => {
  if (!game3) {
    test.skip("maps2/worlds3/the_game/spawns.json missing");
    return;
  }
  assert.equal(game3.schema, "pixel-maps3/spawns@1");
  assert.deepEqual(Object.keys(game3).sort(), ["schema", "world", "zones"]);
  assert.equal(game3.world, "the_game");
  // Same zone keys, in the same ORDER, carrying the same value types on every
  // zone. Key order is not something a JSON parser cares about, but it is what
  // makes "one zone shape" a checkable statement rather than a hope.
  const shapes = new Set(
    game3.zones.map((z: Record<string, unknown>) =>
      Object.entries(z)
        .map(([k, v]) => `${k}:${Array.isArray(v) ? "array" : typeof v}`)
        .join(","),
    ),
  );
  assert.deepEqual([...shapes], ["id:string,monster:string,area:array,elev:array,num:number"]);
  assert.ok(game3.zones.length > 0, "the file ships zones");
  for (const z of game3.zones) {
    assert.equal(z.elev.length, 2, `${z.id}: elev is a [min,max] band`);
    assert.ok(z.elev.every((n: unknown) => Number.isInteger(n)), `${z.id}: elev is integers`);
    assert.ok(z.area.length >= 3, `${z.id}: area is a polygon`);
    for (const pt of z.area)
      assert.ok(
        Array.isArray(pt) && pt.length === 2 && pt.every((n: unknown) => Number.isInteger(n)),
        `${z.id}: every area vertex is an integer tile corner`,
      );
  }
});

// ---------------------------------------------------------------------------
// parseSpawns
// ---------------------------------------------------------------------------

test("parseSpawns accepts BOTH spawn schemas and nothing else", () => {
  const zones = [{ id: "a", monster: "poring", area: [[0, 0], [4, 0], [4, 4]], elev: [0, 2], num: 3 }];
  for (const schema of ["pixel-maps2/spawns@1", "pixel-maps3/spawns@1"])
    assert.equal(parseSpawns({ schema, zones }).length, 1, `${schema} must parse`);
  // The guard is what stops a different document being read as zones — an
  // unlisted schema is still [], including a plausible near-miss.
  for (const schema of [
    "pixel-maps3/world@1",
    "pixel-maps2/npcs@1",
    "pixel-maps4/spawns@1",
    "spawns@1",
    "",
  ])
    assert.deepEqual(parseSpawns({ schema, zones }), [], `${schema || "(empty)"} must be rejected`);
  assert.deepEqual(parseSpawns(null), []);
  assert.deepEqual(parseSpawns({ schema: "pixel-maps3/spawns@1" }), [], "no zones array");
  // Malformed zones are still skipped INDIVIDUALLY under the maps3 name, so
  // one bad entry cannot drop a whole world's monsters.
  const mixed = parseSpawns({
    schema: "pixel-maps3/spawns@1",
    zones: [
      ...zones,
      { id: "bad-no-monster", area: [[0, 0], [4, 0], [4, 4]], elev: [0, 2], num: 3 },
      { id: "bad-two-points", monster: "x", area: [[0, 0], [4, 0]], elev: [0, 2], num: 3 },
      { id: "bad-elev", monster: "x", area: [[0, 0], [4, 0], [4, 4]], elev: [0], num: 3 },
      { id: "b", monster: "frog", area: [[0, 0], [2, 0], [2, 2]], elev: [1, 1] },
    ],
  });
  assert.deepEqual(mixed.map((z) => z.id), ["a", "b"]);
  assert.equal(mixed[1].num, 1, "missing num still defaults to 1");
});

test("the parse is the IDENTITY on the live document, and the schema name is all that differs", () => {
  if (!game3) {
    test.skip("maps2/worlds3/the_game/spawns.json missing");
    return;
  }
  const zones = parseSpawns(game3);
  assert.equal(zones.length, game3.zones.length, "every zone in the file parses");
  assert.deepEqual(zones, game3.zones, "the parse returns the file's zones unchanged");
  // THE STATEMENT OF "NOTHING CHANGED": the same bytes under the other schema
  // name parse to the same zones — the monsters cannot have moved.
  assert.deepEqual(parseSpawns({ ...game3, schema: "pixel-maps2/spawns@1" }), zones, "schema-name independent");
});

// ---------------------------------------------------------------------------
// buildZoneRuntimes against maps3 terrain
// ---------------------------------------------------------------------------

test("every zone in the file resolves against maps3 terrain — every cell base OR deck, in band, enterable", () => {
  const grid = gridOf();
  if (!grid || !game3) {
    test.skip("maps2/worlds3/the_game missing");
    return;
  }
  assert.equal(grid.width, worldDoc.size.w, "the grid is the doc's own width");
  assert.equal(grid.height, worldDoc.size.h);
  const zones = parseSpawns(game3);
  const runtimes = buildZoneRuntimes(grid, zones);
  assert.equal(zones.length, game3.zones.length);
  assert.equal(
    runtimes.length,
    zones.length,
    "every zone must resolve — a dropped zone is map data disagreeing with itself",
  );
  // Each cell's `lvl` is the level of the surface that QUALIFIED it: the base
  // ground, or a deck (bridge span / roof) floating over it. Nothing else may
  // appear in the list.
  let base = 0;
  let deck = 0;
  for (const rt of runtimes) {
    const [lo, hi] = rt.zone.elev;
    assert.ok(rt.cells.length > 0, `${rt.zone.id}: a runtime with no cells must not be returned`);
    assert.equal(rt.cellSet.size, new Set(rt.cells.map((p): number => p.c + p.r * grid.width)).size);
    for (const { c, r, lvl } of rt.cells) {
      const i: number = r * grid.width + c;
      assert.ok(rt.cellSet.has(i), `${rt.zone.id}: cellSet is the roam clamp — it must hold every cell`);
      assert.ok(lvl >= lo && lvl <= hi, `${rt.zone.id}: (${c},${r}) at ${lvl} is outside [${lo},${hi}]`);
      if (grid.deck[i] === lvl) deck++;
      else {
        assert.ok(!grid.blocked[i], `${rt.zone.id}: (${c},${r}) is blocked`);
        assert.equal(grid.level[i], lvl, `${rt.zone.id}: (${c},${r}) is not the base surface`);
        assert.ok(surfaceFor(grid.type[i]).standable, `${rt.zone.id}: (${c},${r}) is not standable`);
        base++;
      }
    }
  }
  assert.ok(deck > 0, "the_game's cave/roof zones stand on DECKS — the base-or-deck branch must be exercised");
  assert.ok(base > deck, "most of an island's zone cells are ordinary ground");

  // WorldRoom.seedMonsters' own formula, so the count here IS the count that
  // reaches the room: `num` per zone, capped by the cells actually available.
  const seeded = runtimes.reduce((n, rt) => n + Math.min(rt.zone.num, rt.cells.length), 0);
  const wanted = zones.reduce((n, z) => n + z.num, 0);
  assert.equal(seeded, wanted, "no zone is so small that it caps its own population");
  const kinds = new Set(game3.zones.map((z: { monster: string }) => z.monster));
  assert.equal(new Set(runtimes.map((rt) => rt.zone.monster)).size, kinds.size, `all ${kinds.size} named kinds get a home`);
  console.log(`spawns3: ${zones.length} zones, ${kinds.size} kinds, ${seeded} monsters seeded, ${deck} deck cells / ${base} base cells`);
});

// ---------------------------------------------------------------------------
// WATER IS A PLAYER SANCTUARY
// ---------------------------------------------------------------------------

test("no zone runtime ever offers a swim cell", () => {
  const grid = gridOf();
  if (!grid || !game3) {
    test.skip("maps2/worlds3/the_game missing");
    return;
  }
  const runtimes = buildZoneRuntimes(grid, parseSpawns(game3));
  assert.ok(runtimes.length > 0, "nothing resolved");
  for (const rt of runtimes) {
    assert.equal(rt.canSwim, false, `${rt.zone.id}: canSwim is always false`);
    for (const { c, r, lvl } of rt.cells) {
      const i: number = r * grid.width + c;
      // A DECK over water is walkable (the bridge guard) — the base under it
      // is not the surface the monster is standing on. Everything else must
      // be dry land.
      if (grid.deck[i] === lvl) continue;
      assert.ok(
        !surfaceFor(grid.type[i]).swimmable,
        `${rt.zone.id}: (${c},${r}) is ${grid.type[i]} — a monster may never stand there`,
      );
    }
  }
});

test("a mostly-liquid polygon keeps only its dry cells; a pure deep_water one takes the shore or is dropped", () => {
  const grid = gridOf();
  if (!grid || !game3) {
    test.skip("maps2/worlds3/the_game missing");
    return;
  }
  const W = grid.width;
  const H = grid.height;
  // Cache the surface verdicts once — the pad scan below asks per cell over
  // the whole grid, and surfaceFor is a string lookup.
  const wet = new Uint8Array(W * H);
  const dry = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const s = surfaceFor(grid.type[i]);
    if (s.swimmable) wet[i] = 1;
    if (s.standable && !grid.blocked[i]) dry[i] = 1;
  }
  const swimmable = (i: number) => wet[i] === 1;

  // the_game is an island in open sea, so a zone drawn over the coast is
  // MOSTLY water. Its swim cells are simply not offered — the monsters keep
  // the dry remainder. (Under the retired water-zone rule such a zone became
  // a SWIMMING zone; the sanctuary makes it a shore zone instead.)
  const zones = parseSpawns(game3);
  const runtimes = buildZoneRuntimes(grid, zones);
  let wettest = { id: "", frac: 0, dry: 0 };
  for (const z of zones) {
    const poly = zonePolygonCells(z, W, H); // the polygon's cells, pre-filter
    const wet = poly.filter((p) => swimmable(p.r * W + p.c)).length;
    const frac = poly.length ? wet / poly.length : 0;
    if (frac > wettest.frac)
      wettest = { id: z.id, frac, dry: runtimes.find((x) => x.zone.id === z.id)!.cells.length };
  }
  assert.ok(wettest.frac > 0.5, `the wettest zone (${wettest.id}) should be majority water`);
  assert.ok(wettest.dry > 0, `${wettest.id} is majority water but keeps its dry cells`);

  // A polygon with NO dry cell at all: the shore-ring fallback, and its limit.
  // Both pads are DERIVED from the map (4-neighbour distance to the nearest
  // standable cell), so neither can go stale when maps2 regrows the island.
  const dist = new Int32Array(W * H).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < W * H; i++)
    if (dry[i]) {
      dist[i] = 0;
      q.push(i);
    }
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const c = i % W;
    const r = (i / W) | 0;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue;
      const j = nr * W + nc;
      if (dist[j] < 0) {
        dist[j] = dist[i] + 1;
        q.push(j);
      }
    }
  }
  const pad = (x: number, y: number): SpawnZone => ({
    id: `probe-${x}-${y}`,
    monster: "poring",
    area: [[x, y], [x + 4, y], [x + 4, y + 4], [x, y + 4]],
    elev: [0, 1],
    num: 3,
  });
  const allSwim = (x: number, y: number) => {
    for (let r = y; r < y + 4; r++)
      for (let c = x; c < x + 4; c++) if (!swimmable(r * W + c)) return false;
    return true;
  };
  const allDeep = (x: number, y: number) => {
    for (let r = y; r < y + 4; r++)
      for (let c = x; c < x + 4; c++) if (grid.type[r * W + c] !== "deep_water") return false;
    return true;
  };
  const padDist = (x: number, y: number) => {
    let b = Infinity;
    for (let r = y; r < y + 4; r++) for (let c = x; c < x + 4; c++) b = Math.min(b, dist[r * W + c]);
    return b;
  };
  // One all-liquid pad per land distance, nearest instance of each. A pad is
  // all-liquid exactly when every cell of it sits at land distance ≥ 1, which
  // is one array read instead of sixteen surface lookups.
  const pads = new Map<number, { x: number; y: number; deep: boolean }>();
  for (let y = 1; y < H - 5; y++)
    for (let x = 1; x < W - 5; x++) {
      if (dist[y * W + x] < 1) continue; // cheap reject on the pad's own corner
      if (!allSwim(x, y)) continue;
      const d = padDist(x, y);
      if (!pads.has(d)) pads.set(d, { x, y, deep: allDeep(x, y) });
    }
  assert.ok(pads.size > 8, "the_game must offer all-liquid pads at a range of distances from land");

  // THE SHORE RING REACHES EXACTLY 4 CELLS (measured here, not read off the
  // loop bound). Inside it a pond pad does not die — it adopts the nearest
  // standable ring, elev band relaxed by ±1 for the bank, and its monsters
  // live on the beach. Past it there is no shore to adopt.
  for (const [d, p] of [...pads].sort((a, b) => a[0] - b[0])) {
    if (d > 12) continue;
    const out = buildZoneRuntimes(grid, [pad(p.x, p.y)]);
    if (d <= 4) {
      assert.equal(out.length, 1, `a liquid pad ${d} from land takes its shore`);
      assert.ok(out[0].cells.length > 0);
      assert.equal(out[0].canSwim, false);
      for (const { c, r } of out[0].cells)
        assert.ok(surfaceFor(grid.type[r * W + c]).standable, "every shore-ring cell is dry land");
    } else {
      // OPEN WATER: no shore within reach, so the zone resolves to NOTHING and
      // is dropped (WorldRoom logs it and seeds no monster). The sanctuary
      // holds by producing no monster at all, never by producing a swimmer.
      assert.deepEqual(out, [], `a liquid pad ${d} from land is dropped, not made swimmable`);
    }
  }
  // The far ocean is deep_water specifically, and it is dropped.
  const ocean = [...pads.entries()].filter(([d, p]) => p.deep && d > 8);
  assert.ok(ocean.length > 0, "the_game has open deep_water far from any shore");
  for (const [, p] of ocean) assert.deepEqual(buildZoneRuntimes(grid, [pad(p.x, p.y)]), []);
});
