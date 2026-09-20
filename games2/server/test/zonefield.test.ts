// THE ZONE FIELD — "is effect X on here", per drawn point, with a soft edge.
//
// What a screenshot cannot pin: that the answer inside a zone is the SERVER'S
// answer (resolveAmbientAt, not a second rule), that the edge is a ramp and not
// a step, that it is monotone across the line, that a re-rolled table drops
// every memo, and that a world without zones changes nothing. The picker is
// injected as the identity on a flat world, so cells are cells.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AMBIENT_SCHEMA, CELL_WU, parseAmbientZones, type AmbientZoneDoc } from "@nangijala/shared";
import {
  BUCKET_CAP, FEATHER_CELLS, ZoneField, type ZonePick, type ZoneSource,
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

test("a re-rolled table drops every memo; an unchanged one keeps them", () => {
  const { f, s } = field({});
  assert.equal(f.weightAt("rain", ...iso(15.5, 15.5)), 1);
  const cells = f.debug().cells;
  assert.ok(cells > 0);
  assert.equal(f.refresh(), false, "same table: nothing to drop");
  assert.equal(f.debug().cells, cells);
  s.packed = "wet=gnats;dry=gnats;deep=drips"; // the wet zone's window lost its rain
  assert.equal(f.refresh(), true);
  assert.equal(f.debug().cells, 0, "memos dropped");
  assert.equal(f.weightAt("rain", ...iso(15.5, 15.5)), 0, "...and the new answer is read");
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
  const after = f.debug();
  assert.ok(after.cells < before.cells, `some cells dropped (${before.cells} -> ${after.cells})`);
  assert.ok(after.cells > 0, "...but not the wet zone's, which did not change");
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
