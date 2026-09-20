// SLOPES: a one-level rise is a walkable incline where its ground has a RAMP
// set; two levels stay a cliff and a jump (maintainer 2026-09-19). The
// arithmetic behind it — the ramp's height field, the set classification, the
// exact-one-level corner mask and the pick — proven without a world or a GPU.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3, PLATE_H, RAMP_MIN_PX, isRampSet, rampHeight } from "../../client/src/tiles3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const load = (rel: string) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));

test("rampHeight is the bilinear blend of the corner bits: 1 on the raised edge, 0 on the far one, half way between", () => {
  // 12 = NW+NE: the north edge is up (the higher cell lies north, v = 0).
  assert.equal(rampHeight(12, 0.5, 0), 1);
  assert.equal(rampHeight(12, 0.5, 1), 0);
  assert.equal(rampHeight(12, 0.2, 0.5), 0.5);
  assert.equal(rampHeight(12, 0.9, 0.25), 0.75);
  // 3 = SW+SE: the south edge is up.
  assert.equal(rampHeight(3, 0.5, 1), 1);
  assert.equal(rampHeight(3, 0.5, 0), 0);
  // 4 = NE alone: a corner wedge, quarter height at the centre, full at the corner.
  assert.equal(rampHeight(4, 0.5, 0.5), 0.25);
  assert.equal(rampHeight(4, 1, 0), 1);
  assert.equal(rampHeight(4, 0, 1), 0);
  // Outside the cell the field clamps rather than extrapolates.
  assert.equal(rampHeight(12, 0.5, -3), 1);
  assert.equal(rampHeight(12, 0.5, 7), 0);
  // Continuity with the neighbours: the raised edge is the higher cell's level.
  for (const u of [0, 0.3, 0.7, 1]) assert.equal(rampHeight(12, u, 0), 1);
});

test("a set is a ramp from RAMP_MIN_PX up; every published set (elevation 4) is a bump", () => {
  assert.equal(isRampSet({ elevation: 4 }), false);
  assert.equal(isRampSet({}), false);
  assert.equal(isRampSet({ elevation: RAMP_MIN_PX }), true);
  assert.equal(isRampSet({ elevation: 15 }), true);
  const sets = load("tiles/slopes/index.json").sets as { elevation?: number }[];
  assert.ok(sets.length > 100);
  assert.equal(sets.filter(isRampSet).length, 0, "no published set is a ramp yet — the storey-height sets are his generation");
});

function resolver(extraSets: object[], approvals: Record<string, { status: string }>) {
  const groundTypes = load("tiles/ground_types.json").grounds;
  const slopes = load("tiles/slopes/index.json");
  const feedback = { ...load("live/feedback/tiles.json").entries, ...approvals };
  return new Tiles3({
    baseTileSets: load("live/tuning/base_tile_sets.json"),
    memberResolve: load("tiles/resolve.json"),
    groundTypes,
    patterns: load("tiles/patterns/index.json"),
    review: load("tiles/review/manifest.json"),
    tops: load("tiles/tops/index.json"),
    feedback,
    wallOverrides: load("live/tuning/tile_walls.json").overrides,
    basePromotions: load("live/tuning/base_tiles.json").overrides,
    fades: load("tiles/fades/index.json"),
    slopes: { ...slopes, sets: [...slopes.sets, ...extraSets] },
    topWallOverrides: load("live/tuning/top_walls.json").overrides,
    topOverrides: load("live/tuning/tile_tops.json").overrides,
    storeyPitch: 15,
    warn: () => {},
  } as ConstructorParameters<typeof Tiles3>[0]);
}

const RAMP = {
  schema: "tiles3/slopes@1", kind: "slope_set", ground: "grass", elevation: 15, step_slope: 1, n_tiles: 16, complete: true,
  size: [64, 61], dir: "tiles/slopes/grass/ramp_test", post_files: Array.from({ length: 16 }, (_, i) => `tile_${String(i).padStart(2, "0")}.png`),
};
const approveAll = (dir: string) => Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`${dir}/tile_${String(i).padStart(2, "0")}`, { status: "approved" }]));

test("the corner mask: exact-one-level counts a corner only for a cell one level up; the bump mask for any higher cell", () => {
  const t = resolver([], {});
  const g = () => "grass";
  // a 3x3 patch: centre at level 5, north row at 6, the north-east corner cell at 7
  const L = (x: number, y: number) => (y === 0 ? (x === 2 ? 7 : 6) : 5);
  assert.equal(t.slopeIndexAt(g, L, "grass", 1, 1, 5), 12, "bump mask: NW+NE (north row higher)");
  assert.equal(t.slopeIndexAt(g, L, "grass", 1, 1, 5, true), 12, "ramp mask: the north cell is exactly one up; the +2 diagonal adds nothing new");
  const L2 = (x: number, y: number) => (y === 0 ? 7 : 5); // a two-level cliff to the north
  assert.equal(t.slopeIndexAt(g, L2, "grass", 1, 1, 5), 12, "the bump still softens the foot of a cliff");
  assert.equal(t.slopeIndexAt(g, L2, "grass", 1, 1, 5, true), 0, "no ramp corner for a two-level rise: it stays a cliff and a jump");
  const gd = (x: number, y: number) => (y === 0 ? "grey_stone" : "grass");
  assert.equal(t.slopeIndexAt(gd, L, "grass", 1, 1, 5, true), 0, "another ground's rise is not this ground's ramp");
});

test("the pick: a ground with an approved storey-height set draws the RAMP in its taller frame; without one, the bump as before", () => {
  const withRamp = resolver([RAMP], approveAll(RAMP.dir));
  assert.equal(withRamp.slopeSets("grass").length, 1, "the one approved bump set for grass stays in the bump list");
  assert.equal(withRamp.slopeSets("grass", true).length, 1, "the ramp set is the ramp list");
  const r = withRamp.slopeTile("grass", 12, 0, 0, true);
  assert.ok(r && r.ramp === true && r.h === 61 && r.file.endsWith("/post/tile_12.png"), `ramp pick: ${JSON.stringify(r)}`);
  const b = withRamp.slopeTile("grass", 12, 0, 0);
  assert.ok(b && b.ramp === false && b.h === PLATE_H, `bump pick: ${JSON.stringify(b)}`);
  assert.equal(withRamp.slopeTile("grass", 15, 0, 0, true), null, "a full plateau top is no incline");
  const without = resolver([], {});
  assert.equal(without.slopeSets("grass", true).length, 0);
  assert.equal(without.slopeTile("grass", 12, 0, 0, true), null);
  const b2 = without.slopeTile("grass", 12, 0, 0);
  assert.ok(b2 && b2.ramp === false && b2.h === PLATE_H, "today's picture, byte for byte");
  // An unapproved ramp set is not a candidate — his verdict gates the incline like every slope tile.
  const unjudged = resolver([RAMP], {});
  assert.equal(unjudged.slopeSets("grass", true).length, 0);
});
