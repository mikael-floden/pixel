// SLOPES: a one-level rise is a walkable incline where its ground has a RAMP
// set; two levels stay a cliff and a jump (maintainer 2026-09-19). The
// arithmetic behind it — the ramp's height field, the set classification, the
// exact-one-level corner mask and the pick — proven without a world or a GPU.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3, PLATE_H, RAMP_MIN_PX, SYNTHETIC_RAMP_DIR, hexRGB, isRampSet, rampHeight, viewFromDoc } from "../../client/src/tiles3.js";
import { SLOPE_HEIGHT_DEFAULT, SLOPE_OFF, slopeHeight, slopeLabel } from "../../client/src/slopeheight.js";
import { buildBoundaryPixels, buildPlatePixels, buildRampPixels, patternSheetPaths, patternSheets, shiftDown, slopeLift, slopeTopOnly, topFaceOnly, type Pixels } from "../../client/src/tiles3draw.js";
import { cellArtPaths, dressKey, surfaceY, Tiles3World, viewFromParsed } from "../../client/src/tiles3runtime.js";
import { parseWorld, ISO_GEOMETRY_MAPS3 } from "../../shared/src/index";
// @ts-expect-error — plain .mjs helper shared with the build scripts
import { imgRGBA } from "../../scripts/imagelib.mjs";

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

test("rampHeight: an edge is a plane (1 on the raised edge, 0 on the far one), a corner a FOLD — min of its two inclines for one raised corner, max for three", () => {
  // 12 = NW+NE: the north edge is up (the higher cell lies north, v = 0).
  assert.equal(rampHeight(12, 0.5, 0), 1);
  assert.equal(rampHeight(12, 0.5, 1), 0);
  assert.equal(rampHeight(12, 0.2, 0.5), 0.5);
  assert.equal(rampHeight(12, 0.9, 0.25), 0.75);
  // 3 = SW+SE: the south edge is up.
  assert.equal(rampHeight(3, 0.5, 1), 1);
  assert.equal(rampHeight(3, 0.5, 0), 0);
  // 4 = NE alone: a convex ridge, min(u, 1 - v) — half height at the centre (the
  // bilinear saddle sagged to a quarter: his "shadow bumps" on every ridge, 2026-09-25).
  assert.equal(rampHeight(4, 0.5, 0.5), 0.5);
  assert.equal(rampHeight(4, 1, 0), 1);
  assert.equal(rampHeight(4, 0, 1), 0);
  assert.equal(rampHeight(4, 0.8, 0.5), 0.5, "the lower of the two inclines");
  assert.equal(rampHeight(4, 0.25, 0.1), 0.25);
  // 7 = all but NW: a concave valley, max(u, v).
  assert.equal(rampHeight(7, 0, 0), 0);
  assert.equal(rampHeight(7, 0.3, 0.6), 0.6);
  assert.equal(rampHeight(7, 1, 0), 1);
  // Each fold meets its neighbours: along the raised corner's two edges it is the edge ramp there.
  for (const t of [0, 0.25, 0.5, 1]) {
    assert.equal(rampHeight(4, 1, t), rampHeight(12, 1, t), "NE's east edge is the north ramp's");
    assert.equal(rampHeight(4, t, 0), rampHeight(5, t, 0), "NE's north edge is the east ramp's");
  }
  // The diagonal pairs stay bilinear.
  assert.equal(rampHeight(9, 0.5, 0.5), 0.5);
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

function resolver(extraSets: object[], approvals: Record<string, { status: string }>, footBoundary = false, forget?: string, slopeHeight = 0) {
  const groundTypes = load("tiles/ground_types.json").grounds;
  const slopes = load("tiles/slopes/index.json");
  const live = load("live/feedback/tiles.json").entries as Record<string, { status: string }>;
  // `forget` drops every live verdict under that key prefix: the unjudged-ground arm needs a ground with none.
  const kept = forget ? Object.fromEntries(Object.entries(live).filter(([k]) => !k.startsWith(forget))) : live;
  const feedback = { ...kept, ...approvals };
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
    slopeHeight,
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

// HIS SWITCH OFF IS THE DEFAULT (maintainer 2026-09-25: "We need a way in the
// game today to turn off this 'slope' feature becouse it's currently broken ...
// We are also running performance tests"): no slope of any kind — no half
// step, no cut, no ramp — and every rise is the plain stair.
test("his slope switch OFF (the default): no cell of the_game wears a slope, raise, cut or ramp; the half step at 4 px is the contrast", { skip: skip || (!existsSync(WORLD) && "no world") }, () => {
  assert.equal(SLOPE_HEIGHT_DEFAULT, SLOPE_OFF);
  assert.equal(slopeHeight(), SLOPE_OFF, "a fresh client (no stored value) starts with slopes off");
  assert.equal(slopeLabel(), "off");
  const view = viewFromDoc(JSON.parse(readFileSync(WORLD, "utf8")));
  const off = resolver([], {}, true, undefined, slopeHeight() / 100);
  assert.equal(off.rampsOn(), false);
  const worn = off.resolveWindow(view).cells.filter((c) => c.slope);
  assert.deepEqual(worn.slice(0, 5).map((c) => `${c.x},${c.y}`), [], `${worn.length} cells wear a slope with the switch off`);
  const halfStep = resolver([], {}, true, undefined, 0).resolveWindow(viewFromDoc(JSON.parse(readFileSync(WORLD, "utf8")))).cells.filter((c) => c.slope).length;
  assert.ok(halfStep >= 100, `the 4 px switch still wears the half step (${halfStep} cells)`);
});

/* -- both sides of the rise (maintainer 2026-09-24) ------------------------- */

test("on the_game: the higher cell of a one-level rise CUTS down to the half level wherever both sides can wear a tile, and every corner agrees", { skip: skip || (!existsSync(WORLD) && "no world") }, () => {
  const t = resolver([], {}, true);
  const view = viewFromDoc(JSON.parse(readFileSync(WORLD, "utf8")));
  const out = t.resolveWindow(view);
  const g = (x: number, y: number) => view.groundAt(x, y);
  const L = (x: number, y: number) => view.levelAt(x, y);
  const byCell = new Map<string, (typeof out.cells)[number]>();
  for (const c of out.cells) byCell.set(`${c.x},${c.y}`, c);
  // The height a cell claims for its corner i (NW 0, NE 1, SW 2, SE 3), in half levels.
  const claim = (c: (typeof out.cells)[number], i: number): number => {
    const bit = (c.slope?.index ?? 0) & (8 >> i);
    if (!c.slope || c.slope.ramp) return c.level * 2;
    if (c.slope.cut) return c.level * 2 - (bit ? 0 : 1);
    return c.level * 2 + (bit ? 1 : 0);
  };
  let cuts = 0, raises = 0, wrong: string[] = [], disagree: string[] = [], lonelyCut: string[] = [];
  for (const c of out.cells) {
    const sl = c.slope;
    if (!sl || sl.ramp) continue;
    if (sl.cut) {
      cuts++;
      if (sl.cut !== sl.rise || sl.index === 15) wrong.push(`${c.x},${c.y} cut ${sl.cut} rise ${sl.rise} index ${sl.index}`);
      // Every lowered corner meets a lower cell that raised it.
      for (let i = 0; i < 4; i++) {
        if (sl.index & (8 >> i)) continue;
        const cx = c.x + (i & 1), cy = c.y + (i >> 1);
        let met = false;
        for (let k = 0; k < 4 && !met; k++) {
          const n = byCell.get(`${cx - 1 + (k & 1)},${cy - 1 + (k >> 1)}`);
          if (n && n.level === c.level - 1 && n.slope && !n.slope.cut && !n.slope.ramp) {
            // which corner of n is this point? (dx,dy) from n's NW corner
            const ni = (cx - n.x) + 2 * (cy - n.y);
            if (n.slope.index & (8 >> ni)) met = true;
          }
        }
        if (!met) lonelyCut.push(`${c.x},${c.y} corner ${i}`);
      }
    } else raises++;
  }
  // Corner agreement: two cells at the same level touching one corner claim one height.
  for (const c of out.cells) {
    if (!c.slope || c.slope.ramp) continue;
    for (let i = 0; i < 4; i++) {
      const cx = c.x + (i & 1), cy = c.y + (i >> 1);
      for (let k = 0; k < 4; k++) {
        const n = byCell.get(`${cx - 1 + (k & 1)},${cy - 1 + (k >> 1)}`);
        if (!n || n === c || n.level !== c.level || g(n.x, n.y) !== g(c.x, c.y)) continue;
        // A raise beside a plate that wears nothing is the lip meeting a flat neighbour — the
        // bump has always done that; only a CUT must never face a plate that did not cut.
        if (!c.slope.cut && !n.slope?.cut) continue;
        const ni = (cx - n.x) + 2 * (cy - n.y);
        if (claim(c, i) !== claim(n, ni) && disagree.length < 6) disagree.push(`${c.x},${c.y} corner ${i} says ${claim(c, i)} but ${n.x},${n.y} corner ${ni} says ${claim(n, ni)} (L${L(c.x, c.y)})`);
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 6), [], `${wrong.length} malformed cuts`);
  assert.deepEqual(lonelyCut.slice(0, 6), [], `${lonelyCut.length} lowered corners with no raise under them`);
  assert.ok(cuts >= 50, `the world has cuts to gate on (${cuts})`);
  assert.ok(raises >= cuts, `raises (${raises}) are never fewer than cuts (${cuts}): a cut needs a raise, a raise needs no cut`);
  // A raise against a plate that did not cut is allowed (the lip meets the full face); a cut
  // against a same-level plate that did not cut is not — that is the disagreement list.
  assert.deepEqual(disagree, [], "two plates at one level disagree on a corner");
  console.log(`slopes: ${raises} cells raise, ${cuts} cells cut down to the half level`);
});

test("the parity path (footBoundary off, render3's rule set) still wears the any-higher bump and never cuts", { skip: skip || (!existsSync(WORLD) && "no world") }, () => {
  const t = resolver([], {});
  const view = viewFromDoc(JSON.parse(readFileSync(WORLD, "utf8")));
  const out = t.resolveWindow(view);
  const g = (x: number, y: number) => view.groundAt(x, y);
  const L = (x: number, y: number) => view.levelAt(x, y);
  let bumps = 0, cuts = 0, wrong = 0;
  for (const c of out.cells) {
    if (!c.slope) continue;
    if (c.slope.cut) cuts++;
    bumps++;
    const gr = g(c.x, c.y)!;
    if (c.slope.index !== t.slopeIndexAt(g, L, gr, c.x, c.y, c.level)) wrong++;
  }
  assert.equal(cuts, 0);
  assert.equal(wrong, 0);
  assert.ok(bumps >= 400, `bumps on the parity path (${bumps})`);
});

test("a cut's pick: the flat tile (0) is allowed, the full plateau (15) is not; a raise refuses 0", { skip }, () => {
  const t = resolver([], {});
  const p0 = t.slopeTile("grass", 0, 5, 5, false, true);
  assert.ok(p0 && p0.cut === p0.rise && p0.rise === 4 && p0.index === 0, JSON.stringify(p0));
  assert.equal(t.slopeTile("grass", 15, 5, 5, false, true), null);
  assert.equal(t.slopeTile("grass", 0, 5, 5), null);
  const p12 = t.slopeTile("grass", 12, 5, 5);
  assert.ok(p12 && p12.cut === 0 && p12.rise === 4);
});

test("slopeTopOnly keeps a slope tile's sunk flat part under the library diamond and drops its band; topFaceOnly clipped it", { skip }, () => {
  const pat = load("tiles/patterns/index.json");
  const paths = patternSheetPaths(pat);
  const px = (rel: string): Pixels => { const i = imgRGBA(join(REPO, rel)) as { width: number; height: number; data: Uint8Array }; return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) }; };
  const sheets = patternSheets(pat, px(paths.silhouette), px(paths.masks), px(paths.border));
  const idx = load("tiles/slopes/index.json");
  const st = idx.sets.find((s: any) => s.dir === "tiles/slopes/grass/a14_s02");
  // THE SET'S GEOMETRY, measured: the plateau (tile 15) tops the frame at row 0 like the
  // library diamond; the flat tile (0) tops it at row `elevation` — the flat part is SUNK.
  const topRow = (p: Pixels) => { for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (p.data[(y * p.w + x) * 4 + 3] > 0) return y; return -1; };
  let libTopRow = -1, libBottomRow = -1;
  for (let y = 0; y < sheets.fh; y++) for (let x = 0; x < sheets.fw; x++) if (sheets.libTop[y * sheets.fw + x]) { if (libTopRow < 0) libTopRow = y; libBottomRow = y; }
  assert.equal(libTopRow, 0);
  assert.equal(topRow(px(`${st.dir}/post/${st.post_files[15]}`)), 0, "the plateau tops the frame with the library diamond");
  assert.equal(topRow(px(`${st.dir}/post/${st.post_files[0]}`)), st.elevation, "the flat tile is sunk by the set's elevation");
  const src = px(`${st.dir}/post/${st.post_files[12]}`); // NW+NE on the plateau, SW+SE sunk
  const top = topFaceOnly(sheets, src), ext = slopeTopOnly(sheets, src, st.elevation);
  const opaqueRows = (p: Pixels, y0: number, y1: number) => { let n = 0; for (let y = y0; y <= y1; y++) for (let x = 0; x < p.w; x++) if (p.data[(y * p.w + x) * 4 + 3] > 0) n++; return n; };
  // The sunk flat's lower edges lie in the `elevation` rows under the diamond: kept by the
  // slope mask, dropped (all but the one margin row) by the plain one.
  assert.ok(opaqueRows(ext, libBottomRow + 2, libBottomRow + st.elevation) > 20, `the sunk rows survive (${opaqueRows(ext, libBottomRow + 2, libBottomRow + st.elevation)})`);
  assert.equal(opaqueRows(top, libBottomRow + 2, libBottomRow + st.elevation), 0);
  // The band below them is dropped by both.
  assert.equal(opaqueRows(ext, libBottomRow + st.elevation + 2, sheets.fh - 1), 0);
  assert.equal(opaqueRows(top, libBottomRow + 2, sheets.fh - 1), 0);
  // Inside the diamond both agree.
  let diff = 0;
  for (let y = libTopRow; y <= libBottomRow; y++) for (let x = 0; x < sheets.fw; x++) { const i = (y * sheets.fw + x) * 4; if (sheets.libTop[y * sheets.fw + x] && (top.data[i] !== ext.data[i] || top.data[i + 3] !== ext.data[i + 3])) diff++; }
  assert.equal(diff, 0);
});

test("the body's lift on a cut cell: rise x rampHeight(index) - cut drops from the level to the half level", { skip }, () => {
  const rise = 4, cut = 4, index = 12; // NW+NE stay up, SW+SE lowered
  const lift = (u: number, v: number) => rampHeight(index, u, v) * rise - cut;
  assert.equal(lift(0.5, 0), 0);
  assert.equal(lift(0.5, 1), -cut);
  assert.equal(lift(0.5, 0.5), -cut / 2);
});

/* -- every stair (maintainer 2026-09-24: "slopes on every single 1 level stair") -- */

test("an unjudged ground falls back to its first complete bump set; a rejected tile of it is refused; a ramp set never falls back", { skip }, () => {
  // light_soil with its live verdicts forgotten (he approved two sets of it on 2026-09-24).
  const NONE = "tiles/slopes/light_soil/";
  const t = resolver([], {}, true, NONE);
  assert.equal(resolver([], {}, false, NONE).slopeSets("light_soil").length, 0, "the parity path keeps render3's approved-only pools");
  assert.equal(t.slopeSets("light_soil").length, 1, "light_soil (no verdict) has its fallback set");
  const p = t.slopeTile("light_soil", 12, 0, 0);
  assert.ok(p && p.dir.startsWith("tiles/slopes/light_soil/"), JSON.stringify(p));
  // A verdict on any set of the ground retires the fallback: only approved tiles then.
  const judged = resolver([], { [`${p!.dir}/tile_03`]: { status: "approved" } }, true, NONE);
  assert.equal(judged.slopeSets("light_soil").length, 1);
  assert.equal(judged.slopeTile("light_soil", 12, 0, 0), null, "an approved set is gated tile by tile");
  assert.ok(judged.slopeTile("light_soil", 3, 0, 0));
  // A rejected tile of the fallback is refused.
  const rejected = resolver([], { [`${p!.dir}/tile_12`]: { status: "rejected" } }, true, NONE);
  assert.equal(rejected.slopeTile("light_soil", 12, 0, 0), null);
  assert.ok(rejected.slopeTile("light_soil", 10, 0, 0));
  // An unjudged storey-height set is not a candidate.
  assert.equal(resolver([RAMP], {}, true).slopeSets("grass", true).length, 0);
});

test("on the_game: a stair beside another ground on its plane wears the slope AS ITS SIDE of the composed boundary", { skip: skip || (!existsSync(WORLD) && "no world") }, () => {
  const t = resolver([], {}, true);
  const view = viewFromDoc(JSON.parse(readFileSync(WORLD, "utf8")));
  const out = t.resolveWindow(view);
  let both = 0, wrong: string[] = [];
  for (const c of out.cells) {
    if (!c.slope || !c.boundary || c.slope.ramp) continue;
    both++;
    const b = c.boundary;
    const sl = b.slope;
    if (!sl) { wrong.push(`${c.x},${c.y}: boundary without its slope`); continue; }
    const own = sl.side === "a" ? b.plateA : b.plateB;
    if (own.path !== c.slope.file || own.rise !== c.slope.rise) wrong.push(`${c.x},${c.y}: own side ${own.path} is not the slope ${c.slope.file}`);
    if (sl.lift !== (c.slope.cut ? 0 : c.slope.rise)) wrong.push(`${c.x},${c.y}: lift ${sl.lift} for cut ${c.slope.cut}`);
    if ((c.art as { path?: string } | undefined)?.path !== c.slope.file) wrong.push(`${c.x},${c.y}: the cell's own art is not the slope`);
  }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} wrong of ${both}`);
  assert.ok(both >= 300, `stairs beside another ground wear both (${both})`);
  console.log(`slopes: ${both} cells wear a slope inside a composed boundary`);
});

test("buildBoundaryPixels with a slope: the other side is shifted `lift` rows down, the mask sampled `lift` rows up, the sunk rows kept", { skip }, () => {
  const pat = load("tiles/patterns/index.json");
  const paths = patternSheetPaths(pat);
  const px = (rel: string): Pixels => { const i = imgRGBA(join(REPO, rel)) as { width: number; height: number; data: Uint8Array }; return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) }; };
  const sheets = patternSheets(pat, px(paths.silhouette), px(paths.masks), px(paths.border));
  const solid = (r: number, g: number, b: number): Pixels => { const p = { w: sheets.fw, h: sheets.fh, data: new Uint8ClampedArray(sheets.fw * sheets.fh * 4) }; for (let i = 0; i < sheets.fw * sheets.fh; i++) { p.data[i * 4] = r; p.data[i * 4 + 1] = g; p.data[i * 4 + 2] = b; p.data[i * 4 + 3] = 255; } return p; };
  const A = solid(200, 0, 0), B = solid(0, 0, 200);
  const frame = 1; // any published mask frame with both sides present
  const plain = buildBoundaryPixels(sheets, { maskFrame: frame, topOnly: true }, A, B, false);
  const lifted = buildBoundaryPixels(sheets, { maskFrame: frame, topOnly: true, slope: { side: "a", rise: 4, lift: 4 } }, A, B, false);
  const cut = buildBoundaryPixels(sheets, { maskFrame: frame, topOnly: true, slope: { side: "a", rise: 4, lift: 0 } }, A, B, false);
  const at = (p: Pixels, x: number, y: number) => Array.from(p.data.subarray((y * p.w + x) * 4, (y * p.w + x) * 4 + 4));
  // The cut composite is the plain composite with the sunk rows kept: identical inside the diamond.
  let diff = 0, kept = 0;
  for (let y = 0; y < sheets.fh; y++) for (let x = 0; x < sheets.fw; x++) {
    const i = y * sheets.fw + x;
    if (sheets.libTop[i]) { if (at(plain, x, y).join() !== at(cut, x, y).join()) diff++; }
    else if (y < sheets.fh && cut.data[i * 4 + 3] > 0 && plain.data[i * 4 + 3] === 0) kept++;
  }
  assert.equal(diff, 0, "the cut composite matches the plain one inside the diamond");
  assert.ok(kept > 20, `the sunk rows survive under the diamond (${kept})`);
  // The lifted composite: where the plain one shows B at (x, y), the lifted one shows B at (x, y + 4) — the mask moved
  // with the raster — and B's own pixels there come from B shifted down (a solid, so the same colour).
  let moved = 0, missed = 0;
  for (let y = 0; y + 4 < sheets.fh; y++) for (let x = 0; x < sheets.fw; x++) {
    const i = y * sheets.fw + x;
    if (!sheets.libTop[i] || !sheets.libTop[(y + 4) * sheets.fw + x]) continue;
    const isB = at(plain, x, y)[2] === 200;
    const liftedB = at(lifted, x, y + 4)[2] === 200;
    if (isB === liftedB) moved++; else missed++;
  }
  assert.ok(missed < moved / 50, `the mask curve rides with the raster (${moved} agree, ${missed} do not)`);
});

/* -- HIS "Black edges!" (2026-09-25, six screenshots on 12bebeab3) ---------------------------------------------- */

test("a slope boundary leaves a hole a hole: no (0,0,0,255) where its source is transparent, nothing moves, a flat boundary is untouched", { skip }, () => {
  const pat = load("tiles/patterns/index.json");
  const paths = patternSheetPaths(pat);
  const px = (rel: string): Pixels => { const i = imgRGBA(join(REPO, rel)) as { width: number; height: number; data: Uint8Array }; return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) }; };
  const sheets = patternSheets(pat, px(paths.silhouette), px(paths.masks), px(paths.border));
  const { fw, fh } = sheets;
  const solid = (r: number, g: number, b: number): Pixels => { const p = { w: fw, h: fh, data: new Uint8ClampedArray(fw * fh * 4) }; for (let i = 0; i < fw * fh; i++) { p.data[i * 4] = r; p.data[i * 4 + 1] = g; p.data[i * 4 + 2] = b; p.data[i * 4 + 3] = 255; } return p; };
  // The slope side as a published tile has it: its top rows empty (a sunk corner), the rest solid.
  const holed = solid(0, 200, 0);
  holed.data.fill(0, 0, fw * 4 * 4); // (0,0,0,0), as the published files hold a hole
  const A = solid(200, 0, 0);
  const black = (p: Pixels) => { let n = 0; for (let i = 0; i < fw * fh; i++) if (p.data[i * 4 + 3] && !p.data[i * 4] && !p.data[i * 4 + 1] && !p.data[i * 4 + 2]) n++; return n; };
  let totalHoles = 0, flatBlack = 0;
  for (const frame of [1, 28, 184, 282]) for (const lift of [0, 4]) {
    const out = buildBoundaryPixels(sheets, { maskFrame: frame, topOnly: true, slope: { side: "b", rise: 4, lift } }, A, holed, true);
    assert.equal(black(out), 0, `frame ${frame} lift ${lift}: a hole composed as black`);
    // Nothing moved: every texel the composite keeps is the one the solid composite has there.
    const full = buildBoundaryPixels(sheets, { maskFrame: frame, topOnly: true, slope: { side: "b", rise: 4, lift } }, A, solid(0, 200, 0), true);
    let same = 0, moved = 0, holes = 0;
    for (let i = 0; i < fw * fh; i++) {
      if (!out.data[i * 4 + 3]) { if (full.data[i * 4 + 3]) holes++; continue; }
      if (out.data.subarray(i * 4, i * 4 + 4).join() === full.data.subarray(i * 4, i * 4 + 4).join()) same++; else moved++;
    }
    assert.equal(moved, 0, `frame ${frame} lift ${lift}: ${moved} texels moved (the composite was re-cropped)`);
    assert.ok(same > 900, `frame ${frame} lift ${lift}: ${same} kept`);
    totalHoles += holes;
    // A flat boundary is render3's: alpha from the silhouette whatever its plates hold (the parity path).
    if (!lift) flatBlack += black(buildBoundaryPixels(sheets, { maskFrame: frame, topOnly: true }, A, holed, true)) + black(buildBoundaryPixels(sheets, { maskFrame: frame, topOnly: true }, holed, A, true));
  }
  assert.ok(totalHoles > 0, "the holed side was drawn somewhere, so the arm tests something");
  assert.ok(flatBlack > 0, "the flat compose is unchanged (parity): it still reads the silhouette's alpha");
});

test("on the_game at 0%: no slope boundary composes a black texel its sources do not hold", { skip: skip || (!existsSync(WORLD) && "no world") }, () => {
  const t = resolver([], {}, true);
  const pat = load("tiles/patterns/index.json");
  const paths = patternSheetPaths(pat);
  const px = (rel: string): Pixels => { const i = imgRGBA(join(REPO, rel)) as { width: number; height: number; data: Uint8Array }; return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) }; };
  const sheets = patternSheets(pat, px(paths.silhouette), px(paths.masks), px(paths.border));
  const gt = load("tiles/ground_types.json").grounds;
  const parsed = parseWorld(JSON.parse(readFileSync(WORLD, "utf8")))!;
  const view = viewFromParsed(parsed as never);
  const frame = { x0: 0, y0: 0, x1: parsed.width, y1: parsed.height, ox: 0, oy: 0, pitch: ISO_GEOMETRY_MAPS3.lh, canvas: [1, 1] } as never;
  const w = new Tiles3World({ view, tiles: t, frame, patterns: pat });
  const plates = new Map<string, Pixels>();
  const plate = (art: { path: string }, g: string): Pixels => {
    const k = JSON.stringify(art) + g;
    if (!plates.has(k)) plates.set(k, buildPlatePixels(sheets, art as never, px(art.path), hexRGB(gt[g].palette.wall)));
    return plates.get(k)!;
  };
  const blk = (p: Pixels, i: number) => p.data[i * 4 + 3] > 0 && !p.data[i * 4] && !p.data[i * 4 + 1] && !p.data[i * 4 + 2];
  let bounds = 0, bad = 0;
  const where: string[] = [];
  for (let y = 0; y < parsed.height; y++) for (let x = 0; x < parsed.width; x++) {
    const b = w.boundary(x, y);
    if (!b?.slope) continue;
    bounds++;
    const a = plate(b.plateA, b.a), bb = plate(b.plateB, b.b);
    const out = buildBoundaryPixels(sheets, b as never, a, bb, true);
    // The sources as the composer reads them: the other side shifted `lift` rows down.
    const sa = b.slope.lift && b.slope.side === "b" ? shiftDown(a, b.slope.lift) : a;
    const sb = b.slope.lift && b.slope.side === "a" ? shiftDown(bb, b.slope.lift) : bb;
    let n = 0;
    for (let i = 0; i < out.w * out.h; i++) if (blk(out, i) && !blk(sa, i) && !blk(sb, i)) n++;
    if (n) { bad++; if (where.length < 5) where.push(`${x},${y} ${b.a}|${b.b} lift ${b.slope.lift}: ${n}`); }
  }
  // 2026-09-25, before the fix: 482 of 485 slope boundaries, 87,372 black texels.
  assert.ok(bounds >= 400, `${bounds} slope boundaries on the_game`);
  assert.deepEqual(where, [], `${bad} of ${bounds} slope boundaries compose black out of a hole`);
});

test("the occluder pass anchors a raise's cap where the ground pass paints it: `rise` rows up (dressKey, surfaceY)", { skip }, () => {
  const art = { kind: "plate", path: "tiles/slopes/grass/a14_s02/post/tile_10.x.webp", w: 64, h: 46, topOnly: true, rise: 4 };
  const raise = { index: 10, dir: "d", file: art.path, ramp: false, h: 46, rise: 4, cut: 0 };
  const cut = { ...raise, index: 12, cut: 4 };
  const cell = (kind: "wall" | "field", slope: typeof raise | undefined) => ({ x: 1, y: 1, level: 3, ground: "grass", kind, dressed: true, art, slope, sx: 100, sy: 200, pasteY: 200, w: 64, h: 46 }) as any;
  const t3 = { plate: () => "key" } as any;
  assert.equal(slopeLift(cell("wall", raise)), 4);
  assert.equal(slopeLift(cell("wall", cut)), 0);
  assert.equal(slopeLift(cell("wall", undefined)), 0);
  assert.equal(dressKey(t3, cell("wall", raise))!.y, 196, "a dressed wall cap's sprite rides 4 rows up with its raise");
  assert.equal(dressKey(t3, cell("wall", cut))!.y, 200, "a cut stays at the level");
  assert.equal(dressKey(t3, cell("wall", undefined))!.y, 200);
  assert.equal(surfaceY(cell("field", raise)), 196, "a raised field cell's surface anchor rides up too");
  assert.equal(surfaceY(cell("field", cut)), 200);
  assert.equal(surfaceY(cell("field", undefined)), 200);
});

test("on the_game: the boundary the passes draw for a slope cell IS the cell's own — the foot yielded, the slope is its side — never a second evaluation", { skip: skip || (!existsSync(WORLD) && "no world") }, () => {
  const t = resolver([], {}, true);
  const parsed = parseWorld(JSON.parse(readFileSync(WORLD, "utf8")))!;
  const view = viewFromParsed(parsed as never);
  const frame = { x0: 0, y0: 0, x1: parsed.width, y1: parsed.height, ox: 0, oy: 0, pitch: ISO_GEOMETRY_MAPS3.lh, canvas: [1, 1] } as never;
  const w = new Tiles3World({ view, tiles: t, frame, patterns: load("tiles/patterns/index.json") });
  let slopes = 0, same = 0, foots = 0, wrong: string[] = [];
  for (let y = 240; y < 262; y++) for (let x = 284; x < 304; x++) {
    const c = w.cell(x, y);
    if (!c?.slope || c.slope.ramp) continue;
    slopes++;
    const b = w.boundary(x, y);
    const sig = (q: typeof b) => (q ? `${q.a}|${q.b}|${q.maskFrame}|${q.slope ? q.slope.side + q.slope.lift : "-"}|${q.plateA.path}|${q.plateB.path}` : "-");
    if (sig(b) === sig(c.boundary ?? null)) same++;
    else wrong.push(`${x},${y}: passes draw ${b ? "a boundary " + b.a + "/" + b.b : "nothing"} where the cell holds ${c.boundary ? c.boundary.a + "/" + c.boundary.b : "nothing"}`);
    // The raw rule, asked without the cell's options, composes the cliff foot on a raise: that is what used to be drawn.
    const raw = t.boundaryAt(view, frame as never, (a: number, bb: number) => view.groundAt(a, bb), (a: number, bb: number) => view.levelAt(a, bb), x, y)?.boundary ?? null;
    if (raw && !c.boundary) foots++;
  }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} of ${slopes} slope cells`);
  assert.ok(slopes >= 30 && same === slopes, `${same} of ${slopes}`);
  assert.ok(foots >= 5, `the raw rule would have composed a foot over ${foots} slopes here — the bug this pins`);
});

/* -- THE COMPOSED STOREY RAMP (maintainer 2026-09-24: "it doesn't stick up to make the 1 level step look less") -- */

test("the game rule: every one-level rise of a ground with no published storey set wears a composed ramp built from its member plate", { skip: skip || (!existsSync(WORLD) && "no world") }, () => {
  const t = resolver([], {}, true, undefined, 1);
  assert.equal(t.slopeSets("grass", true).length, 1, "grass has its composed ramp set");
  assert.equal(t.slopeSets("grass", true)[0].elevation, 15, "100%: the whole storey");
  assert.equal(resolver([], {}, true, undefined, 0.5).slopeSets("grass", true)[0].elevation, 8, "50%: half of it, a wall left above");
  assert.equal(resolver([], {}, true, undefined, 0.25).slopeSets("grass", true)[0].elevation, 4);
  assert.ok(t.slopeSets("grass", true)[0].dir.startsWith(SYNTHETIC_RAMP_DIR + "/"));
  assert.equal(resolver([], {}, true).slopeSets("grass", true).length, 0, "off, the half step stays");
  assert.equal(resolver([], {}).slopeSets("grass", true).length, 0, "never on the parity path");
  const view = viewFromDoc(JSON.parse(readFileSync(WORLD, "utf8")));
  const out = t.resolveWindow(view);
  const g = (x: number, y: number) => view.groundAt(x, y);
  const L = (x: number, y: number) => view.levelAt(x, y);
  let rises = 0, ramps = 0, wrong: string[] = [];
  const paths = new Set<string>();
  for (const c of out.cells) {
    const gr = g(c.x, c.y)!; if (view.isLiquid(gr)) continue;
    const one = t.slopeIndexAt(g, L, gr, c.x, c.y, c.level, true);
    if (!one || one === 15) continue;
    rises++;
    const sl = c.slope, art = c.art as { kind: string; path: string; h: number; from?: string; mask?: number } | undefined;
    if (!sl || !sl.ramp || !art || art.kind !== "ramp") { if (wrong.length < 5) wrong.push(`${c.x},${c.y} L${c.level} ${gr}: ${sl ? (sl.ramp ? "ramp but art " + art?.kind : "a bump") : "nothing"}`); continue; }
    ramps++;
    if (art.mask !== one || !art.from || !art.path.startsWith(SYNTHETIC_RAMP_DIR + "/") || art.h !== PLATE_H + 15) wrong.push(`${c.x},${c.y}: art ${JSON.stringify(art)} for mask ${one}`);
    cellArtPaths(c, (p) => paths.add(p));
  }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} wrong`);
  assert.ok(ramps >= 1500 && ramps === rises, `${ramps} ramps on ${rises} one-level rises`);
  assert.ok(![...paths].some((p) => p.startsWith(SYNTHETIC_RAMP_DIR + "/")), "the load list never names a virtual path");
  assert.ok([...paths].some((p) => /^tiles\//.test(p)), "the load list names the plates the ramps are built from");
  console.log(`slopes: ${ramps} composed ramps on the_game's ${rises} one-level rises`);
});

test("buildRampPixels: a raised corner's column tops out one storey higher, a flat corner's stays, no hole inside, the frame is 64 x 61", { skip }, () => {
  const pat = load("tiles/patterns/index.json");
  const paths = patternSheetPaths(pat);
  const px = (rel: string): Pixels => { const i = imgRGBA(join(REPO, rel)) as { width: number; height: number; data: Uint8Array }; return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) }; };
  const sheets = patternSheets(pat, px(paths.silhouette), px(paths.masks), px(paths.border));
  const plate = px("tiles/slopes/grass/a14_s02/post/" + load("tiles/slopes/index.json").sets.find((s: any) => s.dir === "tiles/slopes/grass/a14_s02").post_files[15]); // any 64x46 plate
  const LH = 15;
  const top = (p: Pixels, x: number) => { for (let y = 0; y < p.h; y++) if (p.data[(y * p.w + x) * 4 + 3] > 0) return y; return -1; };
  const flat = buildRampPixels(sheets, plate, 0, LH);
  const north = buildRampPixels(sheets, plate, 12, LH); // NW+NE raised: the back edge climbs
  assert.equal(flat.w, 64); assert.equal(flat.h, 46 + LH);
  assert.equal(top(flat, 32), top(plate, 32) + LH, "a flat ramp is the plate, LH rows down the frame");
  assert.equal(top(north, 32), top(plate, 32), "the raised top vertex stands a storey higher");
  // No transparent texel inside the lifted diamond of a raised column between its top and the flat plate's bottom row.
  let holes = 0;
  for (let x = 8; x < 56; x++) { const t0 = top(north, x); for (let y = t0; y < top(flat, x) + 12; y++) if (north.data[(y * 64 + x) * 4 + 3] === 0) holes++; }
  assert.equal(holes, 0);
});

/* -- the composed ramp's fixes (2026-09-24, "Why don't you fix the slope instead?") -- */

test("with the composed ramp on: the passes draw every ramp cell's own boundary, no half-step cut remains, no fade rides a ramp, and the height is in the key", { skip: skip || (!existsSync(WORLD) && "no world") }, () => {
  const t = resolver([], {}, true, undefined, 1);
  const parsed = parseWorld(JSON.parse(readFileSync(WORLD, "utf8")))!;
  const view = viewFromParsed(parsed as never);
  const frame = { x0: 0, y0: 0, x1: parsed.width, y1: parsed.height, ox: 0, oy: 0, pitch: ISO_GEOMETRY_MAPS3.lh, canvas: [1, 1] } as never;
  const w = new Tiles3World({ view, tiles: t, frame, patterns: load("tiles/patterns/index.json") });
  let ramps = 0, footBack = 0, cuts = 0, fades = 0, noH = 0;
  for (let y = 0; y < parsed.height; y++) for (let x = 0; x < parsed.width; x++) {
    const c = w.cell(x, y);
    if (!c) continue;
    if (c.slope?.cut) cuts++;
    if (!c.slope?.ramp) continue;
    ramps++;
    if (w.boundary(x, y) !== (c.boundary ?? null)) footBack++;
    if (c.fade) fades++;
    const path = (c.art as { path?: string } | undefined)?.path ?? "";
    if (!/\/h15\//.test(path)) noH++;
  }
  assert.ok(ramps >= 1500, `${ramps} ramps`);
  assert.equal(footBack, 0, "the passes get back a boundary the ramp cell did not resolve (the cliff-foot diamonds)");
  assert.equal(cuts, 0, "a half-step cut beside a full ramp sinks the top of the staircase");
  assert.equal(fades, 0, "a flat fade floats off a lifted ramp");
  assert.equal(noH, 0, "the ramp's height must be in its path, so in its texture key");
  const half = resolver([], {}, true, undefined, 0.5);
  const v2 = viewFromDoc(JSON.parse(readFileSync(WORLD, "utf8")));
  const o2 = half.resolveWindow(v2);
  const hp = o2.cells.find((c) => c.slope?.ramp)?.art as { path?: string } | undefined;
  assert.ok(hp && /\/h8\//.test(hp.path ?? ""), `50% keys its ramps h8: ${hp?.path}`);
});

test("buildRampPixels: no tone step where the incline meets the flat plate — the foot and the crest keep the plate's own colours", { skip }, () => {
  const pat = load("tiles/patterns/index.json");
  const paths = patternSheetPaths(pat);
  const px = (rel: string): Pixels => { const i = imgRGBA(join(REPO, rel)) as { width: number; height: number; data: Uint8Array }; return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) }; };
  const sheets = patternSheets(pat, px(paths.silhouette), px(paths.masks), px(paths.border));
  const plate = px("tiles/slopes/grass/a14_s02/post/" + load("tiles/slopes/index.json").sets.find((s: any) => s.dir === "tiles/slopes/grass/a14_s02").post_files[15]);
  const flat = buildRampPixels(sheets, plate, 0, 15);
  // Mask 0 is the plate itself, 15 rows down the frame: every top-face texel keeps its colour exactly.
  let diff = 0;
  for (let y = 0; y < 29; y++) for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 4, j = ((y + 15) * 64 + x) * 4;
    if (plate.data[i + 3] === 0) continue;
    if (plate.data[i] !== flat.data[j] || plate.data[i + 1] !== flat.data[j + 1] || plate.data[i + 2] !== flat.data[j + 2]) diff++;
  }
  assert.equal(diff, 0);
});

test("a composed ramp on a raised cell keeps its whole lifted surface and side faces and drops only the band below its level", { skip }, () => {
  const pat = load("tiles/patterns/index.json");
  const paths = patternSheetPaths(pat);
  const px = (rel: string): Pixels => { const i = imgRGBA(join(REPO, rel)) as { width: number; height: number; data: Uint8Array }; return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) }; };
  const sheets = patternSheets(pat, px(paths.silhouette), px(paths.masks), px(paths.border));
  const plate = px("tiles/slopes/grass/a14_s02/post/" + load("tiles/slopes/index.json").sets.find((s: any) => s.dir === "tiles/slopes/grass/a14_s02").post_files[15]);
  for (const mask of [10, 12, 3, 5, 1, 8, 7, 14]) {
    const full = buildRampPixels(sheets, plate, mask, 15);
    const top = buildRampPixels(sheets, plate, mask, 15, undefined, false);
    let edgeMoved = 0, band = 0, opaque = 0;
    for (let x = 0; x < 64; x++) {
      let flatBottom = -1;
      for (let y = 0; y < 29; y++) if (sheets.libTop[y * 64 + x]) flatBottom = y;
      const topRow = (p: Pixels) => { for (let y = 0; y < p.h; y++) if (p.data[(y * 64 + x) * 4 + 3] > 0) return y; return -1; };
      // The slope's upper outline — the lifted surface — is exactly the full raster's. A column whose
      // first texel already lies on the level line holds band only (the tips of this raw tile), and
      // a raised cell drops its band: nothing of the surface to compare there.
      const t0 = topRow(full);
      if (flatBottom >= 0 && t0 >= 0 && t0 < flatBottom + 15 && t0 !== topRow(top)) edgeMoved++;
      for (let y = 0; y < top.h; y++) { const i = (y * 64 + x) * 4; if (top.data[i + 3] > 0) { opaque++; if (flatBottom >= 0 && y > flatBottom + 15 + 1) band++; } }
    }
    assert.equal(edgeMoved, 0, `mask ${mask}: the lifted surface's outline moved in ${edgeMoved} columns`);
    assert.equal(band, 0, `mask ${mask}: ${band} band texels below the level on a raised cell`);
    assert.ok(opaque >= 924, `mask ${mask}: the whole top face survives (${opaque} texels)`);
  }
});
