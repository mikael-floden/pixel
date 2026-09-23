// SLOPES: a one-level rise is a walkable incline where its ground has a RAMP
// set; two levels stay a cliff and a jump (maintainer 2026-09-19). The
// arithmetic behind it — the ramp's height field, the set classification, the
// exact-one-level corner mask and the pick — proven without a world or a GPU.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3, PLATE_H, RAMP_MIN_PX, isRampSet, rampHeight, viewFromDoc } from "../../client/src/tiles3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const load = (rel: string) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));

// SKIPPED, NOT FAILED, WHEN THE DATA IS ABSENT. The deploy's test job
// sparse-checks-out games2 + characters2 + live and no tiles/, so the three
// arms that read the real sets skip there and run in CI's full checkout — the
// suite's own guard (tiles3.test.ts). Without it, ENOENT on tiles/slopes/index.json
// refused deploy #4372 and the slope engine stayed unshipped (2026-09-20).
const NEEDS = [
  "tiles/slopes/index.json",
  "tiles/ground_types.json",
  "tiles/resolve.json",
  "tiles/patterns/index.json",
  "tiles/review/manifest.json",
  "tiles/tops/index.json",
  "tiles/fades/index.json",
  "live/tuning/base_tile_sets.json",
  "live/tuning/base_tiles.json",
  "live/tuning/tile_walls.json",
  "live/tuning/top_walls.json",
  "live/tuning/tile_tops.json",
  "live/feedback/tiles.json",
];
const MISSING = NEEDS.filter((p) => !existsSync(join(REPO, p)));
const skip = MISSING.length ? `not checked out: ${MISSING.join(", ")}` : false;

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

test("a set is a ramp from RAMP_MIN_PX up; every published set (elevation 4) is a bump", { skip }, () => {
  assert.equal(isRampSet({ elevation: 4 }), false);
  assert.equal(isRampSet({}), false);
  assert.equal(isRampSet({ elevation: RAMP_MIN_PX }), true);
  assert.equal(isRampSet({ elevation: 15 }), true);
  const sets = load("tiles/slopes/index.json").sets as { elevation?: number }[];
  assert.ok(sets.length > 100);
  assert.equal(sets.filter(isRampSet).length, 0, "no published set is a ramp yet — the storey-height sets are his generation");
});

function resolver(extraSets: object[], approvals: Record<string, { status: string }>, footBoundary = false) {
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
    footBoundary,
    warn: () => {},
  } as ConstructorParameters<typeof Tiles3>[0]);
}

const RAMP = {
  schema: "tiles3/slopes@1", kind: "slope_set", ground: "grass", elevation: 15, step_slope: 1, n_tiles: 16, complete: true,
  size: [64, 61], dir: "tiles/slopes/grass/ramp_test", post_files: Array.from({ length: 16 }, (_, i) => `tile_${String(i).padStart(2, "0")}.png`),
};
const approveAll = (dir: string) => Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`${dir}/tile_${String(i).padStart(2, "0")}`, { status: "approved" }]));

test("the corner mask: exact-one-level counts a corner only for a cell one level up; the bump mask for any higher cell", { skip }, () => {
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

test("the pick: a ground with an approved storey-height set draws the RAMP in its taller frame; without one, the bump as before", { skip }, () => {
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

// ============================================================================
// THE FOOT YIELDS TO HIS PUBLISHED SLOPE AT A ONE-LEVEL RISE (maintainer
// 2026-09-23: "use the slope tiles we have already generated and make a 1
// level jump look like 2 0.5 level jumps ... used as often as possible for a 1
// level increase so the 2 level jump stands out"). With the game's wall-foot
// rule ON, as it runs in the client, every lower cell of a pure one-level
// same-ground rise that has an approved tile wears its slope and composes no
// foot; a cliff foot (a corner two or more up) keeps its foot transition.
const WORLD = join(REPO, "maps2/worlds3/the_game/world.json");
test("on the_game, with the foot on: a one-level rise wears the slope, a cliff foot keeps its transition", { skip: skip || (!existsSync(WORLD) && "no world") }, () => {
  const t = resolver([], {}, true);
  const view = viewFromDoc(JSON.parse(readFileSync(WORLD, "utf8")));
  const out = t.resolveWindow(view);
  const g = (x: number, y: number) => view.groundAt(x, y);
  const L = (x: number, y: number) => view.levelAt(x, y);
  let rises = 0, risesWrong: string[] = [], cliffFeet = 0;
  for (const c of out.cells) {
    const gr = g(c.x, c.y);
    if (!gr || view.isLiquid(gr)) continue;
    const one = t.bumpInclineFor(g, L, gr, c.x, c.y, c.level);
    const any = t.slopeIndexAt(g, L, gr, c.x, c.y, c.level);
    // A genuine two-ground quad still composes its boundary, by law — so the
    // rise arm gates only on cells whose whole 8-ring is this one ground.
    let pure = true;
    for (let dy = -1; dy <= 1 && pure; dy++) for (let dx = -1; dx <= 1; dx++) if (g(c.x + dx, c.y + dy) !== gr) { pure = false; break; }
    if (one && pure) {
      rises++;
      if (!c.slope || c.slope.index !== one || c.boundary) risesWrong.push(`${c.x},${c.y} L${c.level} ${gr}: slope ${c.slope?.index ?? "-"} boundary ${c.boundary ? "yes" : "no"}`);
    } else if (any && !t.slopeIndexAt(g, L, gr, c.x, c.y, c.level, true) && c.boundary) cliffFeet++;
  }
  assert.deepEqual(risesWrong.slice(0, 8), [], `${risesWrong.length} of ${rises} one-level rises do not wear their slope`);
  assert.ok(rises >= 100, `the world has enough one-level rises to gate on (${rises})`);
  assert.ok(cliffFeet >= 1, "a cliff foot still composes its transition (the contrast)");
  console.log(`slopes: ${rises} one-level rises wear the slope with the foot on; ${cliffFeet} cliff feet keep their transition`);
});
