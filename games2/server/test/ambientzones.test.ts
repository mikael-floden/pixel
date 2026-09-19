// ZONE AMBIENT (maintainer 2026-09-18: "pick up the map-agent's ambient zones
// and implement them in sync with all players on the server. If an ambient
// effect should exist 30% of the time in an area that means over a long
// period of time the effect will be present 30% of the time. No fast
// switching! Hold an ambient effect active for ~10min!").
//
// Pinned here, because none of it is visible in a screenshot:
//  1. THE ROLL IS A FUNCTION OF THE CLOCK: two machines, two rooms, a restart
//     — the same table for the same second; a zone holds its set for a
//     whole AMBIENT_HOLD_S window and its windows are phased by id.
//  2. THE SHARES ARE HIT: over many windows an effect is on for its share of
//     the time, an exclusive group's members sum to the group's on-time, and
//     no window ever holds an incompatible pair.
//  3. THE POINT RULE: the largest share owns the effect, cave zones gate on
//     elev, the world zone's effects are on everywhere, conflicts keep the
//     larger share; the wire form round-trips.
//  4. THE REAL DOC (maps2/worlds3/the_game/ambient.json) parses whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AMBIENT_HOLD_S, AmbientZoneDoc, ambientTableAt, hashStr, isCompatibleSet, packZoneTable,
  parseAmbientZones, pointInArea, resolveAmbientAt, rollZoneSet, seededRnd, unpackZoneTable,
  zoneSetAt, zoneWindow, zonesAt,
} from "@nangijala/shared";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REAL = join(REPO, "maps2", "worlds3", "the_game", "ambient.json");

/** A small world: a province over everything, a marsh inside it, a cave under
 *  the marsh's south half at levels 4..6, and the world zone. */
const DOC: AmbientZoneDoc = parseAmbientZones({
  schema: "pixel-maps3/ambient@1",
  world: "t",
  size: 20,
  exclusive: [["drizzle", "rain", "heavyrain", "storm", "snow", "windy"], ["birds", "bats"], ["fireflies", "pollen"]],
  zones: [
    { id: "world", name: "w", kind: "world", area: [[0, 0], [20, 0], [20, 20], [0, 20]], cells: 400,
      effects: { foam: 100, water: 100 } },
    { id: "province", name: "p", kind: "province", area: [[0, 0], [20, 0], [20, 20], [0, 20]], cells: 400,
      effects: { rain: 18, drizzle: 25, windy: 8, birds: 20 } },
    { id: "marsh", name: "m", kind: "marsh", area: [[4, 4], [12, 4], [12, 12], [4, 12]], cells: 64,
      effects: { gnats: 85, fireflies: 90, birds: 35, drizzle: 25, rain: 12, thunder: 40 } },
    { id: "mountain", name: "mt", kind: "province", area: [[10, 0], [20, 0], [20, 20], [10, 20]], cells: 200,
      effects: { snow: 35, windy: 25 } },
    { id: "cave", name: "c", kind: "cave", elev: [4, 6], area: [[4, 8], [12, 8], [12, 12], [4, 12]], cells: 32,
      effects: { spiders: 90, bats: 40 } },
  ],
})!;

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

/* ---- 1. the clock is the sync -------------------------------------------- */

test("the table is a pure function of the clock: same second, same table, on any machine", () => {
  const t0 = 1_800_000_000_000;
  const a = packZoneTable(ambientTableAt(DOC, t0));
  const b = packZoneTable(ambientTableAt(DOC, t0 + 999));
  assert.equal(a, b, "within a second nothing turns");
  assert.equal(a, packZoneTable(ambientTableAt(parseAmbientZones(JSON.parse(JSON.stringify({
    schema: "pixel-maps3/ambient@1", world: "t", size: 20, exclusive: DOC.exclusive, zones: DOC.zones,
  })))!, t0)), "a re-parsed doc rolls identically");
});

test("a zone holds its set for a whole window, and its windows are phased by its id", () => {
  const z = DOC.zones[2]; // marsh
  const phase = hashStr(z.id) % AMBIENT_HOLD_S;
  const start = (12345 * AMBIENT_HOLD_S - phase) * 1000; // the exact start of window 12345
  assert.equal(zoneWindow(z.id, start), 12345);
  assert.equal(zoneWindow(z.id, start - 1), 12344, "one ms earlier is the previous window");
  const set = zoneSetAt(z, DOC, start).join(",");
  for (let t = 0; t < AMBIENT_HOLD_S * 1000; t += 60_000)
    assert.equal(zoneSetAt(z, DOC, start + t).join(","), set, `held at +${t / 1000}s`);
  // the province's window does not start at the same second (phase differs)
  assert.notEqual(hashStr("province") % AMBIENT_HOLD_S, phase);
  // a change lands somewhere in the world far more often than every 10 min
  let turns = 0;
  let prev = packZoneTable(ambientTableAt(DOC, start));
  for (let t = 1000; t <= AMBIENT_HOLD_S * 1000; t += 1000) {
    const cur = packZoneTable(ambientTableAt(DOC, start + t));
    if (cur !== prev) turns++;
    prev = cur;
  }
  assert.ok(turns >= 3 && turns <= DOC.zones.length, `zones turned ${turns} times over one window`);
});

/* ---- 2. the shares are hit --------------------------------------------------- */

test("over many windows an effect is on for its share of the time; a group sums; never incompatible", () => {
  const z = DOC.zones[2]; // marsh: gnats 85, fireflies 90, birds 35, drizzle 25, rain 12, thunder 40
  const N = 20_000;
  const on: Record<string, number> = {};
  for (let w = 0; w < N; w++) {
    const set = zoneSetAt(z, DOC, (w * AMBIENT_HOLD_S - (hashStr(z.id) % AMBIENT_HOLD_S)) * 1000 + 5000);
    assert.ok(isCompatibleSet(set), `window ${w}: ${set.join("+")}`);
    assert.ok(!(set.includes("drizzle") && set.includes("rain")), "one weather at a time");
    for (const n of set) on[n] = (on[n] ?? 0) + 1;
  }
  const share = (n: string) => (on[n] ?? 0) / N;
  assert.ok(Math.abs(share("gnats") - 0.85) < 0.02, `gnats ${share("gnats")}`);
  assert.ok(Math.abs(share("fireflies") - 0.9) < 0.02, `fireflies ${share("fireflies")}`);
  assert.ok(Math.abs(share("birds") - 0.35) < 0.02, `birds ${share("birds")}`);
  assert.ok(Math.abs(share("drizzle") - 0.25) < 0.02, `drizzle ${share("drizzle")}`);
  assert.ok(Math.abs(share("rain") - 0.12) < 0.02, `rain ${share("rain")}`);
  assert.ok(Math.abs(share("drizzle") + share("rain") - 0.37) < 0.02, "the group's on-time is the sum of its shares");
  // thunder never with snow (matrix) — the marsh has no snow, so thunder is its own coin
  assert.ok(Math.abs(share("thunder") - 0.4) < 0.02, `thunder ${share("thunder")}`);
});

test("a group summing past 100 is normalised: something of it is always on", () => {
  const rnd = lcg(3);
  for (let i = 0; i < 500; i++) {
    const set = rollZoneSet({ birds: 0.8, bats: 0.6 }, [["birds", "bats"]], rnd);
    assert.equal(set.length, 1, set.join("+"));
  }
  // and the matrix drops an independent that cannot join a group winner (thunder under snow)
  const always1 = () => 0.0; // r=0 picks the first member, and every coin lands
  assert.deepEqual(rollZoneSet({ snow: 0.5, thunder: 0.9 }, [["snow"]], always1), ["snow"]);
});

test("seededRnd and hashStr are stable (the wire between machines)", () => {
  assert.equal(hashStr("marsh-the-western-marsh"), hashStr("marsh-the-western-marsh"));
  assert.notEqual(hashStr("a"), hashStr("b"));
  const r = seededRnd(42);
  const seq = [r(), r(), r()];
  const r2 = seededRnd(42);
  assert.deepEqual([r2(), r2(), r2()], seq);
  for (const v of seq) assert.ok(v >= 0 && v < 1);
});

/* ---- 3. the point rule -------------------------------------------------------- */

test("even-odd containment on cell centres; elev gates a cave; the zones under a cell", () => {
  assert.ok(pointInArea(DOC.zones[2].area, 4.5, 4.5), "the first cell of the marsh");
  assert.ok(!pointInArea(DOC.zones[2].area, 3.5, 4.5), "the cell west of it");
  assert.ok(!pointInArea(DOC.zones[2].area, 12.5, 4.5), "the corner vertex belongs to the next cell");
  const ids = (col: number, row: number, elev: number) => zonesAt(DOC, col, row, elev).map((z) => z.id);
  assert.deepEqual(ids(5, 5, 0), ["world", "province", "marsh"]);
  assert.deepEqual(ids(5, 9, 0), ["world", "province", "marsh"], "over the cave at ground level: not in it");
  assert.deepEqual(ids(5, 9, 5), ["world", "province", "marsh", "cave"], "in the cave at its level");
  assert.deepEqual(ids(5, 9, 7), ["world", "province", "marsh"], "a level above the cave's band");
  assert.deepEqual(ids(15, 15, 0), ["world", "province", "mountain"]);
});

test("the largest share owns an effect; the world zone is on everywhere; conflicts keep the larger share", () => {
  // hand-made table: every zone has everything on
  const all = new Map<string, string>();
  for (const z of DOC.zones) all.set(z.id, Object.keys(z.effects).sort().join(","));
  // marsh cell: drizzle is the marsh's (25 = province's 25, marsh smaller → marsh owns), rain the province's
  // (18 > 12); drizzle 25 beats rain 18 in the weather group; birds (marsh 35) beats bats (cave, not here)
  assert.deepEqual(resolveAmbientAt(DOC, all, 5, 5, 0), ["birds", "drizzle", "fireflies", "foam", "gnats", "thunder", "water"]);
  // in the cave: bats 40 beats birds 35; spiders join
  assert.deepEqual(resolveAmbientAt(DOC, all, 5, 9, 5), ["bats", "drizzle", "fireflies", "foam", "gnats", "spiders", "thunder", "water"]);
  // mountain cell: snow 35 beats drizzle 25 and windy 25/8; the world zone still gives foam+water
  assert.deepEqual(resolveAmbientAt(DOC, all, 15, 15, 0), ["birds", "foam", "snow", "water"]);
  // an effect is on only if ON IN ITS OWNER: rain on in the marsh but off in the province → off (the
  // province owns rain, 18 > 12); birds on in the province but off in the marsh → off (the marsh owns birds, 35 > 20)
  const t = new Map(all);
  t.set("province", "birds");
  t.set("marsh", "rain,gnats");
  assert.deepEqual(resolveAmbientAt(DOC, t, 5, 5, 0), ["foam", "gnats", "water"]);
  // and on in the owner while off elsewhere → on
  t.set("province", "rain");
  t.set("marsh", "gnats");
  assert.deepEqual(resolveAmbientAt(DOC, t, 5, 5, 0), ["foam", "gnats", "rain", "water"]);
  // a zone missing from the table contributes nothing
  t.delete("world");
  assert.deepEqual(resolveAmbientAt(DOC, t, 5, 5, 0), ["gnats", "rain"]);
});

test("over many windows a point under two weather provinces snows far more often than it rains, never both", () => {
  // the spec's example: wet west (rain 18) + mountain weather (snow 35). The mountain's snow (35) and
  // windy (25) own their conflicts over the province's rain (18), so rain is on only in windows where
  // neither is: 18% × (1 − 0.35 − 0.25) ≈ 7% — snow keeps its 35% exactly (measured 6.6% / 35%).
  let rain = 0, snow = 0, both = 0;
  const N = 6000;
  for (let w = 0; w < N; w++) {
    const set = resolveAmbientAt(DOC, ambientTableAt(DOC, w * AMBIENT_HOLD_S * 1000 + 7000), 15, 15, 0);
    assert.ok(isCompatibleSet(set), set.join("+"));
    if (set.includes("rain")) rain++;
    if (set.includes("snow")) snow++;
    if (set.includes("rain") && set.includes("snow")) both++;
  }
  assert.equal(both, 0, "never both");
  assert.ok(Math.abs(snow / N - 0.35) < 0.03, `snow ${snow / N}`);
  assert.ok(rain / N > 0.04 && rain / N < 0.10, `rain ${rain / N} (18% trimmed by the snow and wind it loses to)`);
});

test("the wire form round-trips, in id order, empty sets included", () => {
  const t = new Map([["b", "rain,thunder"], ["a", ""], ["c", "gnats"]]);
  const packed = packZoneTable(t);
  assert.equal(packed, "a=;b=rain,thunder;c=gnats");
  assert.deepEqual([...unpackZoneTable(packed)], [["a", ""], ["b", "rain,thunder"], ["c", "gnats"]]);
  assert.equal(unpackZoneTable("").size, 0);
  assert.equal(unpackZoneTable(null).size, 0);
});

test("the parser refuses what is not an ambient@1 doc and drops an empty or shapeless zone", () => {
  assert.equal(parseAmbientZones(null), null);
  assert.equal(parseAmbientZones({ schema: "pixel-maps3/spawns@1", zones: [] }), null);
  const d = parseAmbientZones({
    schema: "pixel-maps3/ambient@1", zones: [
      { id: "ok", area: [[0, 0], [1, 0], [1, 1]], effects: { gnats: 50, bad: "x", zero: 0, big: 500 } },
      { id: "line", area: [[0, 0], [1, 0]], effects: { gnats: 50 } },
      { id: "nothing", area: [[0, 0], [1, 0], [1, 1]], effects: {} },
    ],
  })!;
  assert.deepEqual(d.zones.map((z) => z.id), ["ok"]);
  assert.deepEqual(d.zones[0].effects, { gnats: 50, big: 100 });
});

/* ---- 4. the real doc ------------------------------------------------------------- */

test("maps2/worlds3/the_game/ambient.json parses whole and resolves at the hearth house", { skip: !existsSync(REAL) && "no ambient.json" }, () => {
  const doc = parseAmbientZones(JSON.parse(readFileSync(REAL, "utf8")))!;
  assert.ok(doc, "parses");
  assert.ok(doc.zones.length >= 80, `${doc.zones.length} zones`);
  assert.equal(doc.zones.filter((z) => z.id === "world").length, 1);
  const table = ambientTableAt(doc, 1_800_000_000_000);
  assert.equal(table.size, doc.zones.length);
  const packed = packZoneTable(table);
  assert.ok(packed.length < 6000, `wire form ${packed.length} bytes`);
  // the hearth house (299,198): ONE surface place besides the world (maps2's
  // law of 2026-09-19 — a cell is one place, weather is a place's signature
  // or a door, never a province), carrying one signature and a door;
  // foam/water come from the world zone
  const here = zonesAt(doc, 299, 198, 0);
  const ids = here.map((z) => z.id);
  assert.ok(ids.includes("world"), ids.join());
  const places = here.filter((z) => z.id !== "world" && !z.elev);
  assert.equal(places.length, 1, `one place at the hearth house: ${ids.join()}`);
  const shares = Object.values(places[0].effects);
  assert.equal(shares.filter((v) => v >= 85).length, 1, `one signature: ${JSON.stringify(places[0].effects)}`);
  assert.ok(shares.some((v) => v === 0.5), `a door left open: ${JSON.stringify(places[0].effects)}`);
  const set = resolveAmbientAt(doc, table, 299, 198, 0);
  assert.ok(set.includes("foam") && set.includes("water"), set.join());
  assert.ok(isCompatibleSet(set), set.join("+"));
});
