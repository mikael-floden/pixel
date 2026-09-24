// THE ZONE FIELD — "is effect X on here", per drawn point, with a soft edge.
//
// What a screenshot cannot pin: that the answer inside a zone is the SERVER'S
// answer (resolveAmbientAt, not a second rule), that the edge is a ramp and not
// a step, that it is monotone across the line, that a re-rolled table drops
// every memo, and that a world without zones changes nothing. The picker is
// injected as the identity on a flat world, so cells are cells.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AMBIENT_SCHEMA, CELL_WU, parseAmbientZones, zonesAt, type AmbientZoneDoc } from "@nangijala/shared";
import {
  BLUR_MEMO_CAP, BUCKET_CAP, CELL_MEMO_CAP, FEATHER_CELLS, ZoneField, type ZonePick, type ZoneSource,
} from "../../ambient/runtime/zonefield.js";
import { PLACE_MIN, ZoneWatch } from "../../ambient/runtime/zoneplace.js";
import type { AmbientCtx } from "../../ambient/runtime/types.js";

const doc = (): AmbientZoneDoc =>
  parseAmbientZones({
    schema: AMBIENT_SCHEMA, world: "t", size: 64, exclusive: [["drizzle", "rain"]],
    zones: [
      { id: "wet", name: "the wet", kind: "marsh", area: [[10, 10], [20, 10], [20, 20], [10, 20]], effects: { rain: 100, gnats: 50 } },
      { id: "dry", name: "the dry", kind: "heath", area: [[30, 10], [40, 10], [40, 20], [30, 20]], effects: { gnats: 100 } },
      { id: "deep", name: "the pit", kind: "cave", area: [[10, 30], [20, 30], [20, 40], [10, 40]], elev: [0, 2], effects: { drips: 100 } },
    ],
  })!;

/** A flat world: the picker is the identity, cells are cells. */
const flat = (lvl = 0) => (x: number, y: number): ZonePick => {
  const cx = x / CELL_WU, cy = y / CELL_WU;
  const col = Math.floor(cx), row = Math.floor(cy);
  return { col, row, lvl, fx: cx - col, fy: cy - row };
};
const iso = (col: number, row: number) => [col * CELL_WU, row * CELL_WU] as const;

function field(src: Partial<ZoneSource> & { table?: string }, lvl = 0, feather = FEATHER_CELLS) {
  const s: ZoneSource = { doc: src.doc === undefined ? doc() : src.doc, packed: src.table ?? "wet=rain,gnats;dry=gnats;deep=drips", roomSky: !!src.roomSky };
  const f = new ZoneField(() => s, flat(lvl), feather);
  f.refresh();
  return { f, s };
}

test("inside a zone the answer is the server's own resolution", () => {
  const { f } = field({});
  assert.ok(f.ruled);
  assert.deepEqual([...f.activeAt(15, 15, 0)].sort(), ["gnats", "rain"]);
  assert.deepEqual([...f.activeAt(35, 15, 0)], ["gnats"]);
  assert.deepEqual([...f.activeAt(5, 5, 0)], [], "no zone here");
  assert.equal(f.on("rain", 15, 15, 0), true);
  assert.equal(f.on("rain", 35, 15, 0), false, "the dry zone rolled no rain");
  // the window said gnats but not rain in the wet zone this time
  const { f: g } = field({ table: "wet=gnats;dry=gnats;deep=drips" });
  assert.equal(g.on("rain", 15, 15, 0), false, "a zone that rolled it off is off, share or no share");
});

test("the weight is 1 well inside, 0 well outside, and a RAMP across the line — never a step", () => {
  const { f } = field({});
  assert.equal(f.weightAt("rain", ...iso(15.5, 15.5)), 1);
  assert.equal(f.weightAt("rain", ...iso(5.5, 15.5)), 0);
  assert.equal(f.weightAt("rain", ...iso(35.5, 15.5)), 0, "another zone, rain not rolled");
  // walk in along a row, a tenth of a cell at a time: monotone, and it takes
  // the middle values — a step function would jump 0 -> 1 in one sample
  let prev = 0; const seen: number[] = [];
  for (let c = 7; c <= 13; c += 0.1) {
    const w = f.weightAt("rain", ...iso(c, 15.5));
    assert.ok(w >= prev - 1e-9, `monotone at col ${c.toFixed(1)}: ${prev} -> ${w}`);
    prev = w; seen.push(w);
  }
  assert.ok(seen.some((w) => w > 0.2 && w < 0.8), `a ramp, not a step (${seen.map((w) => w.toFixed(2)).join(" ")})`);
  assert.equal(seen[0], 0); assert.equal(seen[seen.length - 1], 1);
  // the ramp is centred on the boundary: half-on at the line itself
  const atLine = f.weightAt("rain", ...iso(10, 15.5));
  assert.ok(atLine > 0.3 && atLine < 0.7, `half on at the line (${atLine.toFixed(2)})`);
  // ~2·feather+1 cells wide
  const from = seen.findIndex((w) => w > 0.01), to = seen.findIndex((w) => w > 0.99);
  const widthCells = (to - from) / 10;
  assert.ok(widthCells >= 1.5 && widthCells <= 2 * FEATHER_CELLS + 1.5, `ramp ${widthCells.toFixed(1)} cells wide`);
});

test("feather 0 is the hard cell edge, still bilinear between centres", () => {
  const { f } = field({}, 0, 0);
  assert.equal(f.weightAt("rain", ...iso(15.5, 15.5)), 1);
  assert.equal(f.weightAt("rain", ...iso(8.5, 15.5)), 0);
  const w = f.weightAt("rain", ...iso(10, 15.5));
  assert.ok(w > 0.4 && w < 0.6, `the line is halfway between the two centres (${w.toFixed(2)})`);
});

test("coverage: a view inside reads 1, outside 0, straddling about a half", () => {
  const { f } = field({});
  const view = (c0: number, r0: number, c1: number, r1: number) =>
    ({ x: c0 * CELL_WU, y: r0 * CELL_WU, width: (c1 - c0) * CELL_WU, height: (r1 - r0) * CELL_WU });
  const inside = f.coverage("rain", view(12, 12, 18, 18));
  assert.ok(inside.any && inside.mean > 0.99, JSON.stringify(inside));
  const outside = f.coverage("rain", view(0, 0, 6, 6));
  assert.ok(!outside.any && outside.mean === 0, JSON.stringify(outside));
  const half = f.coverage("rain", view(5, 12, 15, 18)); // half the view is wet
  assert.ok(half.any && half.mean > 0.3 && half.mean < 0.7, `straddling: ${JSON.stringify(half)}`);
  // "already raining on the other side": standing well outside, the far half is on
  const far = f.coverage("rain", view(2, 12, 12, 18));
  assert.ok(far.any && far.max > 0.9, `the zone is on screen from outside (${JSON.stringify(far)})`);
});

test("an elevation band: the cave's drips are on at its level and off above it", () => {
  const { f: low } = field({}, 1);
  assert.equal(low.on("drips", 15, 35, 1), true);
  assert.equal(low.weightAt("drips", ...iso(15.5, 35.5)), 1);
  const { f: high } = field({}, 5);
  assert.equal(high.on("drips", 15, 35, 5), false, "six levels up is not in the pit");
  assert.equal(high.weightAt("drips", ...iso(15.5, 35.5)), 0);
});

test("a re-rolled table drops every memo that read the zone; an unchanged one keeps them", () => {
  const { f, s } = field({});
  assert.equal(f.weightAt("rain", ...iso(15.5, 15.5)), 1);
  const r0 = f.debug().resolves;
  assert.ok(r0 > 0);
  assert.equal(f.refresh(), false, "same table: nothing to drop");
  assert.equal(f.weightAt("rain", ...iso(15.5, 15.5)), 1);
  assert.equal(f.debug().resolves, r0, "answered from memo");
  s.packed = "wet=gnats;dry=gnats;deep=drips"; // the wet zone's window lost its rain
  assert.equal(f.refresh(), true);
  assert.equal(f.weightAt("rain", ...iso(15.5, 15.5)), 0, "the new answer is read");
  assert.ok(f.debug().resolves > r0, "...by resolving the zone's cells again");
  assert.equal(f.weightAt("gnats", ...iso(15.5, 15.5)), 1);
});

test("a re-roll in ONE zone drops only the cells that zone holds — the rest of the world keeps its memos", () => {
  const { f, s } = field({});
  f.weightAt("rain", ...iso(15.5, 15.5)); // the wet zone's cells
  f.weightAt("gnats", ...iso(35.5, 15.5)); // the dry zone's cells
  f.weightAt("drips", ...iso(15.5, 35.5)); // the pit's cells (level 0: not held, but resolved)
  const before = f.debug();
  const resolvesBefore = before.resolves;
  s.packed = "wet=rain,gnats;dry=;deep=drips"; // only the DRY zone's window changed
  assert.equal(f.refresh(), true);
  assert.equal(f.debug().cells, before.cells, "a re-roll scans nothing: a memo is found stale when it is next touched");
  // the wet zone answers from memo (no new resolve); the dry zone re-resolves
  f.weightAt("rain", ...iso(15.5, 15.5));
  assert.equal(f.debug().resolves, resolvesBefore, "the untouched zone's cells were not re-resolved");
  assert.equal(f.weightAt("gnats", ...iso(35.5, 15.5)), 0, "the changed zone reads its new window");
  assert.ok(f.debug().resolves > resolvesBefore, "...by resolving again");
  assert.equal(f.debug().pruned, 1, "one zone changed");
});

test("a field effect is wanted when its zone is in view, and a spot is taken with the weight's own odds", () => {
  // ZoneWatch is what every critter reads (runtime/zoneplace.ts): the view's
  // coverage at the env cadence, and a stochastic accept so the POPULATION
  // thins across the feather instead of the sprites fading.
  const { f } = field({});
  const view = { x: 13 * CELL_WU, y: 13 * CELL_WU, width: 4 * CELL_WU, height: 4 * CELL_WU }; // well inside the wet zone
  const ctx = { zone: f, view } as unknown as AmbientCtx;
  const w = new ZoneWatch("rain");
  w.step(ctx, 1000);
  assert.equal(w.any, true);
  assert.ok(w.mean > 0.9, `deep inside the view is all zone (${w.mean})`);
  // a view far away: the zone is not on screen and nothing is wanted
  const away = { zone: f, view: { x: 40 * CELL_WU, y: 40 * CELL_WU, width: 4 * CELL_WU, height: 4 * CELL_WU } } as unknown as AmbientCtx;
  const w2 = new ZoneWatch("rain");
  w2.step(away, 1000);
  assert.equal(w2.any, false);
  assert.equal(w2.mean, 0);
  // the accept: always inside, never outside, and IN PROPORTION on the line
  const always = () => 0; // rnd below any positive weight
  assert.equal(w.accept(ctx, 15 * CELL_WU, 15 * CELL_WU, always), true);
  assert.equal(w.accept(ctx, 5 * CELL_WU, 15 * CELL_WU, always), false, "outside is outside however the dice fall");
  assert.equal(w.holds(ctx, 15 * CELL_WU, 15 * CELL_WU), true);
  assert.equal(w.holds(ctx, 5 * CELL_WU, 15 * CELL_WU), false);
  // ON THE ZONE'S OWN SIDE ONLY. The blur reads 0.667 on the first cell inside
  // a straight edge and 0.333 on the first one outside, so PLACE_MIN (a half)
  // is that line: below it nothing is placed however the dice fall, above it
  // the odds ARE the weight, which is the taper toward the edge from inside.
  const inLine = 10.5 * CELL_WU;   // the first cell inside the wet zone
  const outLine = 9.5 * CELL_WU;   // the first cell outside it
  const wIn = f.weightAt("rain", inLine, 15 * CELL_WU);
  const wOut = f.weightAt("rain", outLine, 15 * CELL_WU);
  assert.ok(wIn >= PLACE_MIN, `the inside edge is on the zone's side (${wIn})`);
  assert.ok(wOut > 0 && wOut < PLACE_MIN, `the outside edge is off it but not nothing (${wOut})`);
  assert.equal(w.accept(ctx, outLine, 15 * CELL_WU, always), false, "nothing is placed past the line, whatever the dice say");
  assert.equal(w.accept(ctx, inLine, 15 * CELL_WU, () => wIn - 0.01), true);
  assert.equal(w.accept(ctx, inLine, 15 * CELL_WU, () => wIn + 0.01), false, "and it thins toward the edge from the inside");
  assert.equal(w.holds(ctx, outLine, 15 * CELL_WU), true, "`holds` is the permissive twin: something already there is not killed at once");
  // no zones at all: everything is wanted everywhere, the old behaviour exactly
  const { f: sky } = field({ roomSky: true });
  const open = { zone: sky, view } as unknown as AmbientCtx;
  const w3 = new ZoneWatch("rain");
  w3.step(open, 1000);
  assert.equal(w3.any, true);
  assert.equal(w3.mean, 1);
  assert.equal(w3.accept(open, 5 * CELL_WU, 15 * CELL_WU, () => 0.99), true);
});

test("the raster is the field over a rectangle, row 0 at the top, 255 inside, 0 outside, the ramp between", () => {
  const { f } = field({});
  // 20 cells wide x 4 tall over the wet zone's west edge (col 10): cols 5..25, rows 12..16
  const rect = { x: 5 * CELL_WU, y: 12 * CELL_WU, width: 20 * CELL_WU, height: 4 * CELL_WU };
  const r = f.raster("rain", rect, 20, 4);
  assert.equal(r.length, 80);
  // sample centres: column i covers col 5 + i .. 6 + i, so i = 0..3 is well outside, 7.. is well inside
  assert.equal(r[0], 0); assert.equal(r[3], 0);
  assert.equal(r[8], 255); assert.equal(r[13], 255, "col 18.5: its 3x3 blur is all inside"); assert.equal(r[14], 170, "col 19.5: a third of its blur is past the east edge");
  const ramp = [r[4], r[5], r[6], r[7]];
  assert.ok(ramp.some((v) => v > 0 && v < 255), `middle values across the line: ${ramp.join(",")}`);
  for (let i = 1; i <= 13; i++) assert.ok(r[i] >= r[i - 1], "monotone into the zone (the rect crosses the east edge past col 18.5)");
  // every row reads the same across this flat band; a rect beyond the zone's east edge (col 20) falls back to 0
  for (let j = 1; j < 4; j++) assert.equal(r[j * 20 + 8], 255);
  const east = f.raster("rain", { x: 18 * CELL_WU, y: 12 * CELL_WU, width: 6 * CELL_WU, height: CELL_WU }, 6, 1);
  assert.equal(east[0], 255); assert.equal(east[5], 0);
  // unruled: all on
  const { f: sky } = field({ roomSky: true });
  assert.ok(sky.raster("rain", rect, 4, 2).every((v) => v === 255));
});

test("no zones, no boundary: the room's sky rules and every weight is 1", () => {
  const { f: none } = field({ doc: null });
  assert.ok(!none.ruled);
  assert.equal(none.weightAt("rain", ...iso(5.5, 5.5)), 1);
  assert.equal(none.coverage("crabs", { x: 0, y: 0, width: 100, height: 100 }).mean, 1);
  const { f: forced } = field({ roomSky: true });
  assert.ok(!forced.ruled, "a forced sky is the room's, not the zones'");
  assert.equal(forced.weightAt("rain", ...iso(5.5, 5.5)), 1);
  const { f: noTable } = field({ table: "" });
  assert.ok(!noTable.ruled, "before the table arrives the room's sky rules");
});

test("a point the picker cannot place weighs 0, and the picker memo is bounded", () => {
  const s: ZoneSource = { doc: doc(), packed: "wet=rain", roomSky: false };
  let calls = 0;
  const f = new ZoneField(() => s, (x, y) => { calls++; return y < 0 ? null : flat()(x, y); });
  f.refresh();
  assert.equal(f.weightAt("rain", 100, -50), 0);
  f.weightAt("rain", ...iso(15.5, 15.5)); f.weightAt("rain", ...iso(15.5, 15.5)); f.weightAt("rain", ...iso(15.51, 15.51));
  assert.equal(calls, 2, "the same bucket is picked once");
  for (let i = 0; i < BUCKET_CAP + 10; i++) f.cellAt(i * 40, 5);
  assert.ok(f.debug().buckets <= BUCKET_CAP, "the memo never outgrows its cap");
});

test("an EPISODE is on when its zone is in view, not when my cell is in it", async () => {
  /* THE DIRECTOR's half of the boundary (runtime/director.ts). Episodes —
   * birds, bats, leaves, sandstorm, thunder — are switched centrally, and the
   * switch used to read `env.active`, the set at MY CELL: the birds started
   * the moment I crossed the line instead of already wheeling over the far
   * side. Now the question is asked of the VIEW. */
  const { Director } = await import("../../ambient/runtime/director.js");
  const made: Record<string, boolean> = {};
  const episode = (name: string) => ({
    name, weight: () => 1, init() {}, update() {}, debug: () => ({}), dispose() {},
    setActive(on: boolean) { made[name] = on; },
  });
  const d = new Director([episode("birds"), episode("bats")] as never);
  const { f } = field({ doc: parseAmbientZones({
    schema: AMBIENT_SCHEMA, world: "t", size: 64, exclusive: [],
    zones: [{ id: "wood", name: "the wood", kind: "forest", area: [[10, 10], [20, 10], [20, 20], [10, 20]], effects: { birds: 100, bats: 100 } }],
  }), table: "wood=birds" });
  const env = { phase: "Day", active: new Set<string>() } as never;
  // the zone is on screen but my cell is nowhere near it: the birds are ON
  const seeing = { zone: f, view: { x: 12 * CELL_WU, y: 12 * CELL_WU, width: 4 * CELL_WU, height: 4 * CELL_WU } } as never;
  d.tick(env, seeing);
  assert.equal(made.birds, true, "its window rolled birds: on while I stand outside");
  assert.notEqual(made.bats, true, "the same zone did not roll bats: never switched on (untouched, so undefined)");
  // walk away until no bird zone is in view at all: they stop
  const away = { zone: f, view: { x: 40 * CELL_WU, y: 40 * CELL_WU, width: 4 * CELL_WU, height: 4 * CELL_WU } } as never;
  d.tick(env, away);
  assert.equal(made.birds, false, "no bird zone in view: the episode ends");
  // and with no field at all the old rule stands, exactly: the room's set
  const roomSet = { phase: "Day", active: new Set(["bats"]) } as never;
  d.tick(roomSet);
  assert.equal(made.bats, true, "zoneless: the active set rules, as it always did");
  assert.notEqual(made.birds, true, "and birds, absent from that set, stay off");
});

test("two episodes that cannot share a stage: the bigger presence in view wins", async () => {
  /* Asking the VIEW opens a conflict the CELL never had. The server resolves
   * one set per point, so birds and bats were never both on; a view can hold
   * a bird zone and a bat zone at once and then both want the stage. */
  const { Director } = await import("../../ambient/runtime/director.js");
  const made: Record<string, boolean> = {};
  const episode = (name: string, conflicts: string[]) => ({
    name, conflicts, weight: () => 1, init() {}, update() {}, debug: () => ({}), dispose() {},
    setActive(on: boolean) { made[name] = on; },
  });
  const d = new Director([episode("birds", ["bats"]), episode("bats", ["birds"])] as never);
  const doc2 = parseAmbientZones({
    schema: AMBIENT_SCHEMA, world: "t", size: 64, exclusive: [],
    zones: [
      { id: "wood", name: "the wood", kind: "forest", area: [[10, 10], [14, 10], [14, 20], [10, 20]], effects: { birds: 100 } },
      { id: "cave", name: "the cave", kind: "cave", area: [[16, 10], [30, 10], [30, 20], [16, 20]], effects: { bats: 100 } },
    ],
  });
  const { f } = field({ doc: doc2, table: "wood=birds;cave=bats" });
  const env = { phase: "Night", active: new Set<string>() } as never;
  // a view holding a sliver of the wood and most of the cave: bats win
  d.tick(env, { zone: f, view: { x: 13 * CELL_WU, y: 12 * CELL_WU, width: 12 * CELL_WU, height: 6 * CELL_WU } } as never);
  assert.equal(made.bats, true, "the bigger presence takes the stage");
  assert.notEqual(made.birds, true, "and the one it cannot share with waits");
  // turn the view around onto the wood: the birds take it and the bats stop
  d.tick(env, { zone: f, view: { x: 10 * CELL_WU, y: 12 * CELL_WU, width: 4 * CELL_WU, height: 6 * CELL_WU } } as never);
  assert.equal(made.birds, true);
  assert.equal(made.bats, false, "the loser is switched off, not left running");
});

/* THE TICK'S COST (games-perf 2026-09-23, his run: the mount's UPDATE
 * listener was 8.5-17.9 ms a frame, the env tick unmetered inside it). Three
 * things changed in the field and none of them may change an answer: a cell
 * asks only the zones whose bounding box holds it, the picker memo keeps its
 * working set across the cap, and a raster asked twice for the same
 * world-anchored rect is computed once. */
test("the box index changes no answer: every cell of a big concave zone reads as the server's own rule", () => {
  // A U-shaped zone: its box holds cells the polygon does not (the notch).
  const u = parseAmbientZones({
    schema: AMBIENT_SCHEMA, world: "t", size: 64, exclusive: [],
    zones: [
      { id: "u", name: "the u", kind: "marsh", area: [[10, 10], [30, 10], [30, 30], [24, 30], [24, 16], [16, 16], [16, 30], [10, 30]], effects: { gnats: 100 } },
      { id: "far", name: "the far", kind: "heath", area: [[50, 50], [60, 50], [60, 60], [50, 60]], effects: { gnats: 100 } },
    ],
  })!;
  const s: ZoneSource = { doc: u, packed: "u=gnats;far=gnats", roomSky: false };
  const f = new ZoneField(() => s, flat());
  f.refresh();
  let inside = 0, notch = 0;
  for (let row = 8; row < 33; row++)
    for (let col = 8; col < 33; col++) {
      const want = zonesAt(u, col, row, 0).length ? ["gnats"] : [];
      assert.deepEqual([...f.activeAt(col, row, 0)], want, `cell ${col},${row}`);
      if (want.length) inside++;
      else if (col >= 16 && col < 24 && row >= 16 && row < 30) notch++;
    }
  assert.ok(inside > 200 && notch === 8 * 14, `the notch (${notch} cells) is inside the box and outside the zone`);
  assert.deepEqual([...f.activeAt(55, 55, 0)], ["gnats"]);
  assert.deepEqual([...f.activeAt(40, 40, 0)], [], "between the two boxes: no zone");
});

test("the picker memo keeps its working set across the cap — no whole-memo drop, and never over the cap", () => {
  const s: ZoneSource = { doc: doc(), packed: "wet=rain", roomSky: false };
  let calls = 0;
  const f = new ZoneField(() => s, (x, y) => { calls++; return flat()(x, y); });
  f.refresh();
  // A working set of 200 buckets, asked again and again while a walk adds new
  // ones past the cap: the old memo dropped EVERYTHING at the cap and re-picked
  // the working set in one go; the generations keep what is still asked for.
  const ask = () => { for (let i = 0; i < 200; i++) f.cellAt(i * 40, 5); };
  ask();
  const base = calls;
  assert.equal(base, 200);
  for (let i = 0; i < BUCKET_CAP * 2; i++) {
    f.cellAt(100000 + i * 40, 5);
    if (i % 500 === 0) ask();
  }
  assert.ok(f.debug().buckets <= BUCKET_CAP, `the two generations together stay under the cap (${f.debug().buckets})`);
  const before = calls;
  ask();
  assert.equal(calls, before, "the working set was asked for all along, so it is still memoised");
});

test("a raster for the same world-anchored rect is computed once, and a new table computes it again", () => {
  const s: ZoneSource = { doc: doc(), packed: "wet=rain,gnats;dry=gnats;deep=drips", roomSky: false };
  const f = new ZoneField(() => s, flat());
  f.refresh();
  const rect = { x: 5 * CELL_WU, y: 12 * CELL_WU, width: 20 * CELL_WU, height: 4 * CELL_WU };
  const a = f.raster("rain", rect, 20, 4);
  const picks = f.stats.picks;
  const b = f.raster("rain", rect, 20, 4);
  assert.deepEqual([...b], [...a]);
  assert.equal(f.stats.picks, picks, "the second ask touched no memo");
  assert.notEqual(a, b, "a copy each time: the caller may keep or mutate its own");
  b[0] = 7;
  assert.equal(f.raster("rain", rect, 20, 4)[0], a[0], "a mutated copy does not leak into the memo");
  // a different rect, or a re-rolled table, is a fresh computation
  const c = f.raster("rain", { ...rect, x: rect.x + CELL_WU }, 20, 4);
  assert.notDeepEqual([...c], [...a]);
  s.packed = "wet=gnats;dry=gnats;deep=drips";
  assert.equal(f.refresh(), true);
  assert.ok(f.raster("rain", rect, 20, 4).every((v) => v === 0), "rain rolled off: the memo did not answer for the old table");
});

test("a re-roll looks up only the raster samples near the changed zone — the rest are copied, and the bytes equal a cold raster", () => {
  const { f, s } = field({});
  // cols 5..44 x rows 5..24, one sample per cell: the wet zone and the dry zone both in the rect
  const rect = { x: 5 * CELL_WU, y: 5 * CELL_WU, width: 40 * CELL_WU, height: 20 * CELL_WU };
  const cols = 40, rows = 20;
  const a = f.raster("gnats", rect, cols, rows);
  const at = (g: Uint8Array, col: number, row: number) => g[(row - 5) * cols + (col - 5)];
  assert.equal(at(a, 15, 15), 255, "the wet zone has gnats");
  assert.equal(at(a, 35, 15), 255, "so has the dry");
  const r0 = f.debug().resolves;
  const p0 = f.stats.picks;
  s.packed = "wet=rain,gnats;dry=;deep=drips"; // the dry zone's window closed
  assert.equal(f.refresh(), true);
  const b = f.raster("gnats", rect, cols, rows);
  assert.equal(at(b, 35, 15), 0, "the dry zone reads its new window");
  assert.equal(at(b, 15, 15), 255, "the wet zone is unchanged");
  const again = f.debug().resolves - r0;
  assert.ok(again > 0 && again < (cols * rows) / 2, `only the dry zone's cells were resolved again (${again} of ${cols * rows})`);
  assert.equal(f.stats.picks, p0, "no sample was picked again: the picker memo holds them all");
  const { f: cold } = field({ table: "wet=rain,gnats;dry=;deep=drips" });
  assert.deepEqual([...b], [...cold.raster("gnats", rect, cols, rows)], "byte for byte a cold raster of the new table");
  // and the next tick copies everything again: nothing stale is left behind
  const r1 = f.debug().resolves;
  const c = f.raster("gnats", rect, cols, rows);
  assert.deepEqual([...c], [...b]);
  assert.equal(f.debug().resolves, r1);
});

/* THE MEMOS ACROSS A HOP AND OVER A LONG WALK (games-perf 2026-09-23, his
 * 19:53 run: the blur memo reached 824k entries, a refresh pruned them all in
 * one 481 ms frame, and every zone hop — the room's sky ruling for the length
 * of the join, then the same table back — cleared everything and rebuilt the
 * mask cold). */
test("the room's sky taking over keeps the memos, and the same table coming back drops none of them", () => {
  const { f, s } = field({});
  f.weightAt("rain", ...iso(15.5, 15.5));
  f.weightAt("gnats", ...iso(35.5, 15.5));
  const d0 = f.debug();
  assert.ok(d0.cells > 0 && d0.blur > 0);
  // the hop: the new room has not sent its table yet
  s.roomSky = true;
  assert.equal(f.refresh(), true);
  assert.equal(f.ruled, false);
  assert.equal(f.weightAt("rain", ...iso(15.5, 15.5)), 1, "unruled: every weight reads 1");
  assert.equal(f.debug().cells, d0.cells, "the memos survive the room's sky");
  assert.equal(f.debug().blur, d0.blur);
  // the same table arrives: nothing re-rolled, nothing dropped, nothing re-resolved
  s.roomSky = false;
  assert.equal(f.refresh(), true);
  assert.equal(f.debug().cells, d0.cells);
  assert.equal(f.debug().pruned, 0);
  assert.equal(f.weightAt("rain", ...iso(15.5, 15.5)), 1);
  assert.equal(f.debug().resolves, d0.resolves, "answered from memo");
  // a zone that re-rolled during the hop is still pruned, and only it
  s.roomSky = true;
  f.refresh();
  s.packed = "wet=rain,gnats;dry=;deep=drips";
  s.roomSky = false;
  assert.equal(f.refresh(), true);
  assert.equal(f.debug().pruned, 1, "the dry zone changed while the sky ruled");
  assert.equal(f.weightAt("rain", ...iso(15.5, 15.5)), 1);
  assert.equal(f.debug().resolves, d0.resolves, "the wet zone's memos were kept");
  assert.equal(f.weightAt("gnats", ...iso(35.5, 15.5)), 0, "the dry zone reads its new window");
});

test("a fresh copy of the same doc — a room's own object — keeps the memos; a different doc drops them", () => {
  const { f, s } = field({});
  f.weightAt("rain", ...iso(15.5, 15.5));
  const d0 = f.debug();
  s.doc = doc(); // parsed again: a new object, the same zones
  assert.equal(f.refresh(), false, "same content, same table: nothing changed");
  assert.equal(f.debug().cells, d0.cells);
  assert.equal(f.weightAt("rain", ...iso(20.5, 15.5)), 1 / 3, "the feathered edge, outside the old outline");
  const other = doc();
  other.zones[0].area = [[10, 10], [22, 10], [22, 20], [10, 20]]; // the wet zone grew
  s.doc = other;
  assert.equal(f.refresh(), true);
  assert.equal(f.debug().cells, 0, "a changed outline is a new world: memos dropped");
  assert.equal(f.weightAt("rain", ...iso(20.5, 15.5)), 1, "...and the new outline is read");
});

test("the memos are bounded on a long walk, and what was just asked is still there", () => {
  const big = parseAmbientZones({
    schema: AMBIENT_SCHEMA, world: "t", size: 400, exclusive: [],
    zones: [{ id: "all", name: "all", kind: "marsh", area: [[0, 0], [400, 0], [400, 400], [0, 400]], effects: { gnats: 100 } }],
  })!;
  const s: ZoneSource = { doc: big, packed: "all=gnats", roomSky: false };
  let picks = 0;
  const f = new ZoneField(() => s, (x, y) => { picks++; return flat()(x, y); });
  f.refresh();
  for (let row = 0; row < 400; row += 2) for (let col = 0; col < 400; col += 2) f.weightAt("gnats", ...iso(col + 0.5, row + 0.5));
  const d = f.debug();
  assert.ok(d.cells <= CELL_MEMO_CAP, `cells ${d.cells}`);
  assert.ok(d.blur <= BLUR_MEMO_CAP, `blur ${d.blur}`);
  assert.ok(d.buckets <= BUCKET_CAP, `buckets ${d.buckets}`);
  assert.ok(d.cells > 1000 && d.blur > 1000, "and the memos are in use");
  // the last screen's worth is hot: asking it again resolves and picks nothing new
  const r0 = f.debug().resolves;
  const p0 = picks;
  for (let row = 380; row < 400; row += 2) for (let col = 380; col < 400; col += 2) f.weightAt("gnats", ...iso(col + 0.5, row + 0.5));
  assert.equal(f.debug().resolves, r0);
  assert.equal(picks, p0);
});

// ── THE TICK COSTS A BOUNDED AMOUNT (games-perf Task 2, 2026-09-24) ──────────

/** A flat world with an EDGE: beyond `size` cells there is no cell at all, so
 *  the raster has samples to fill from their neighbours. */
const bounded = (size: number) => (x: number, y: number): ZonePick | null => {
  const p = flat()(x, y);
  return p.col < 0 || p.row < 0 || p.col >= size || p.row >= size ? null : p;
};

test("a lattice window that moved by whole steps equals a cold raster byte for byte — the overlap copied, the edge looked up, the off-map samples filled", () => {
  const s: ZoneSource = { doc: doc(), packed: "wet=rain,gnats;dry=gnats;deep=drips", roomSky: false };
  const f = new ZoneField(() => s, bounded(64) as unknown as ReturnType<typeof flat>);
  f.refresh();
  const cols = 32, rows = 16;
  // half a cell per sample; the window reaches past the world's east edge (col 64) so a strip is off the map
  const rect0 = { x: 40 * CELL_WU, y: 8 * CELL_WU, width: 16 * CELL_WU, height: 8 * CELL_WU };
  const ref0 = new Uint8Array(cols * rows);
  const a = f.raster("gnats", rect0, cols, rows, ref0);
  const picks0 = f.stats.picks;
  const r0 = f.debug().resolves;
  for (const [dx, dy] of [[1, 0], [0, 1], [-2, 1], [3, -2], [0, 0]]) {
    const rect = { ...rect0, x: rect0.x + dx * (CELL_WU / 2), y: rect0.y + dy * (CELL_WU / 2) };
    const ref = new Uint8Array(cols * rows);
    const warm = f.raster("gnats", rect, cols, rows, ref);
    const { f: cold } = field({});
    const coldF = new ZoneField(() => s, bounded(64) as unknown as ReturnType<typeof flat>);
    coldF.refresh();
    const cref = new Uint8Array(cols * rows);
    assert.deepEqual([...warm], [...coldF.raster("gnats", rect, cols, rows, cref)], `bytes at shift ${dx},${dy}`);
    assert.deepEqual([...ref], [...cref], `floor refs at shift ${dx},${dy}`);
    void cold;
  }
  // the walk looked up only the edges: far fewer resolves than five cold rasters would need
  assert.ok(f.debug().resolves - r0 < cols * rows, `edge lookups only (${f.debug().resolves - r0} resolves for five shifted windows of ${cols * rows})`);
  assert.ok(f.stats.picks - picks0 < cols * rows, "and only the samples that entered were picked");
  assert.ok(a.length === cols * rows);
});

test("a standing camera pays a copy: the same lattice window answers without a pick or a resolve, floor refs included", () => {
  const { f } = field({});
  const cols = 64, rows = 40;
  const rect = { x: 0, y: 0, width: 48 * CELL_WU, height: 30 * CELL_WU };
  const ref1 = new Uint8Array(cols * rows);
  const a = f.raster("gnats", rect, cols, rows, ref1);
  const picks = f.stats.picks;
  const resolves = f.debug().resolves;
  const ref2 = new Uint8Array(cols * rows);
  const b = f.raster("gnats", rect, cols, rows, ref2);
  assert.deepEqual([...b], [...a]);
  assert.deepEqual([...ref2], [...ref1], "the floor refs ride the memo too");
  assert.equal(f.stats.picks, picks, "no sample picked");
  assert.equal(f.debug().resolves, resolves, "no cell resolved");
  assert.notEqual(a, b, "still a copy of its own");
});

test("coverage: an effect with no zone within reach of the view reads 0 without a cell resolved, the same view answers from the cache, and a re-rolled table clears it", () => {
  const { f, s } = field({});
  // the view over the wet zone (cols 10-20, rows 10-20): rain and gnats are there, drips only in the pit at rows 30-40
  const view = { x: 8 * CELL_WU, y: 8 * CELL_WU, width: 14 * CELL_WU, height: 14 * CELL_WU };
  const rain = f.coverage("rain", view);
  assert.ok(rain.any && rain.max === 1, "rain covers the view");
  const r0 = f.debug().resolves;
  const p0 = f.stats.picks;
  const drips = f.coverage("drips", view);
  assert.equal(drips.any, false);
  assert.equal(drips.max, 0);
  assert.equal(f.debug().resolves, r0, "no cell resolved for an effect with no zone in sight");
  assert.equal(f.stats.picks, p0, "and no sample picked again: the view's samples are shared");
  assert.equal(f.coverage("rain", view), rain, "the same view and table: the cached answer");
  s.packed = "wet=gnats;dry=gnats;deep=drips"; // rain rolled off in the wet zone
  assert.equal(f.refresh(), true);
  const after = f.coverage("rain", view);
  assert.notEqual(after, rain, "a new table is a new answer");
  assert.equal(after.any, false, "rain is off now");
  // a view elsewhere is its own answer
  const far = f.coverage("gnats", { ...view, x: 50 * CELL_WU, y: 50 * CELL_WU });
  assert.equal(far.any, false);
});
