import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AmbientZone } from "@nangijala/shared";
import { CELL_WU, parseAmbientZones } from "@nangijala/shared";
import { FLOOR_SAMPLE_CAP, floorOwnerAt, packRef, REF_SCALE, zoneFloorLevel } from "../../ambient/runtime/zonefloor";

/* A ZONE'S FLOOR is the ground MIST_FRAG's pool measures from. Before it
 * existed the falloff measured from sea level and four of the world's five
 * 90%-mist zones painted nothing (the arm at the bottom is that measurement,
 * run against the shipped world so it cannot silently come back). */

const zone = (over: Partial<AmbientZone> = {}): AmbientZone => ({
  id: "z",
  name: "z",
  kind: "marsh",
  area: [[0, 0], [10, 0], [10, 10], [0, 10]],
  effects: { mist: 90 },
  ...over,
});

/** A level grid as a `levelAt`: world units in, the cell's level out. */
const grid = (f: (col: number, row: number) => number) => (wx: number, wy: number) =>
  f(Math.floor(wx / CELL_WU), Math.floor(wy / CELL_WU));

test("a zone on flat high ground floors at that ground — a mountain tarn is a misty place", () => {
  assert.equal(zoneFloorLevel(zone(), grid(() => 32), CELL_WU), 32);
  assert.equal(zoneFloorLevel(zone(), grid(() => 0), CELL_WU), 0);
});

test("the floor is the MEDIAN, so one stray low cell cannot drag the zone back to sea level", () => {
  // 10x10 cells: one at level 0, the rest at 12. A minimum would answer 0.
  const lv = grid((c, r) => (c === 3 && r === 4 ? 0 : 12));
  assert.equal(zoneFloorLevel(zone(), lv, CELL_WU), 12);
});

test("half at each of two levels takes the upper of the pair — the lower half pools full anyway", () => {
  // pool clamps at 1 below the floor, so the half beneath the median is fully
  // fogged and only the rises above it thin out.
  const lv = grid((_c, r) => (r < 5 ? 0 : 4));
  assert.equal(zoneFloorLevel(zone(), lv, CELL_WU), 4);
});

test("only the cells the polygon HOLDS are read — ground outside it never moves the floor", () => {
  const seen: string[] = [];
  const lv = (wx: number, wy: number) => {
    const c = Math.floor(wx / CELL_WU), r = Math.floor(wy / CELL_WU);
    seen.push(`${c},${r}`);
    return 5;
  };
  // an L, so its bounding box holds cells the polygon does not
  zoneFloorLevel(zone({ area: [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]] }), lv, CELL_WU);
  assert.ok(seen.length > 0);
  assert.ok(!seen.includes("3,3"), `the notch cell was read: ${seen.join(" ")}`);
  assert.ok(seen.includes("1,1"));
});

test("a huge zone is strided, not walked — the cap bounds the reads", () => {
  let n = 0;
  const lv = () => { n++; return 3; };
  const big = zone({ area: [[0, 0], [400, 0], [400, 400], [0, 400]] }); // 160k cells
  assert.equal(zoneFloorLevel(big, lv, CELL_WU, 1000), 3);
  assert.ok(n <= 1000 * 1.3, `read ${n} cells for a 160k-cell zone`);
  assert.ok(n > 100, `read only ${n} cells — the estimate needs a real sample`);
});

test("an absent level probe leaves the floor UNMEASURED, never at sea level", () => {
  // null must survive out of the function: the caller refuses to cache it.
  assert.equal(zoneFloorLevel(zone(), () => null, CELL_WU), null);
});

test("a degenerate polygon floors at 0 rather than throwing", () => {
  assert.equal(zoneFloorLevel(zone({ area: [[5, 5], [5, 5], [5, 5]] }), grid(() => 9), CELL_WU), 0);
});

test("the owner is the largest share, then the smaller zone, then the id", () => {
  const a = zone({ id: "a", effects: { mist: 20 }, cells: 500 });
  const b = zone({ id: "b", effects: { mist: 90 }, cells: 900 });
  const c = zone({ id: "c", effects: { mist: 90 }, cells: 100 });
  assert.equal(floorOwnerAt([a, b], "mist", 1, 1, 0)?.id, "b", "the larger share owns it");
  assert.equal(floorOwnerAt([b, c], "mist", 1, 1, 0)?.id, "c", "a tie goes to the smaller zone");
  assert.equal(floorOwnerAt([a, b], "snow", 1, 1, 0), null, "an effect no zone carries has no owner");
  assert.equal(floorOwnerAt([a], "mist", 99, 99, 0), null, "a cell outside every zone has no owner");
});

test("packRef round-trips a level through the mask's G byte and clamps", () => {
  for (const lvl of [0, 1, 2, 12, 32, 46]) assert.equal(packRef(lvl) / REF_SCALE, lvl);
  assert.equal(packRef(-5), 0);
  assert.equal(packRef(1000), 255);
  // the world tops out at 46 levels; the byte must hold it with room to spare
  assert.ok(46 * REF_SCALE < 255, "REF_SCALE cannot encode this world's levels");
});

test("the shipped world: every serious mist zone floors on its own ground", () => {
  const dir = join("..", "maps2", "worlds3", "the_game");
  if (!existsSync(join(dir, "ambient.json")) || !existsSync(join(dir, "world.json"))) return;
  const doc = parseAmbientZones(JSON.parse(readFileSync(join(dir, "ambient.json"), "utf8")));
  const world = JSON.parse(readFileSync(join(dir, "world.json"), "utf8")) as { level: number[][] };
  assert.ok(doc);
  const lv = grid((c, r) => world.level?.[r]?.[c] ?? 0);
  const pool = (z: number, floor: number) => Math.min(1, Math.max(0, 1 - (z - floor - 0.4) * 0.5));
  const serious = doc.zones.filter((z) => z.kind !== "world" && (z.effects.mist ?? 0) >= 50);
  assert.ok(serious.length >= 4, `only ${serious.length} serious mist zones`);
  for (const z of serious) {
    const floor = zoneFloorLevel(z, lv, CELL_WU, FLOOR_SAMPLE_CAP);
    assert.notEqual(floor, null, `${z.id} could not be measured`);
    assert.ok(floor !== null);
    // AT ITS OWN FLOOR the fog is full. Measuring from sea level instead gave
    // the tarn (floor 32) and the southern lake (median 12) exactly 0.
    assert.equal(pool(floor, floor), 1, `${z.id} does not pool on its own floor`);
    assert.ok(pool(floor, 0) < 1 === floor > 0.4, `${z.id}: sea-level pool disagrees with its floor ${floor}`);
  }
  // the one that always worked, and the one he reported, pinned by name
  const by = (id: string) => serious.find((z) => z.id === id)!;
  assert.equal(zoneFloorLevel(by("heath-the-south-eastern-green"), lv, CELL_WU), 0, "the heath was always at sea level");
  assert.ok((zoneFloorLevel(by("tarn-the-tarn"), lv, CELL_WU) ?? 0) > 20, "the tarn is a mountain lake");
  assert.ok((zoneFloorLevel(by("marsh-the-eastern-marsh"), lv, CELL_WU) ?? 0) >= 2, "his marsh sits above sea level");
});
