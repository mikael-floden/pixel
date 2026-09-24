// WEATHER IS ORDINARY AMBIENT, SERVER-ACTIVATED (maintainer 2026-09-18: "All
// ambient effects will be controlled by the server ... Weather is an ambient
// effect like every other ambient effect except it has more criteria for what
// other weather effects it can run side by side with").
//
// Pinned here, because none of it is visible in a screenshot:
//  1. THE MATRIX — which effects may share the sky — is symmetric, keeps
//     precipitation one-at-a-time, and encodes the physical rules stated in
//     shared/src/ambient.ts (thunder never with snow, mist never in wind, ...).
//  2. THE ROLLER never emits an incompatible set, honours the zone's weights
//     as shares of time, and is deterministic for a given random stream —
//     every zone room of a world must land on the same sky.
//  3. THE MOVE DID NOT RESTYLE ANYTHING: the per-effect particle table and
//     the gloom a single weather grades to are the old per-index numbers,
//     written out literally; the ease reproduces WorldScene's old inline roll
//     frame for frame.
//  4. THE OLD RING still means what it meant (17 gates drive __ml.weather(i)).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ZONE, EPISODE_S, LEGACY_INDEX, PRECIPITATION, WEATHER_EFFECTS, WEATHER_UNIVERSE,
  compatible, conflictsOf, isCompatibleSet, packAmbient, rollAmbient, rollZoneSet, seededRnd, unpackAmbient,
} from "@nangijala/shared";
import { conflictClosure } from "../../ambient/runtime/types.js";
import {
  CLOUD_OF, DIM_OF, GLOOM_SNAP, GLOOM_TAU_S, easeGloom, forceGloom, forcedGloom, gloomField, gloomTarget, newGloom,
  setGloomField, snapGloom,
} from "../../ambient/weather/gloom.js";
import { gloomOnlyRow } from "../../ambient/weather/gloomrow.js";
import {
  MAX_DROPS, PRECIP, REF_AREA, SNOW_MELTING, SNOW_RESTING, SNOW_WATER_MELT,
  areaScale, cfgByIdx, cfgByName, easeShown, fallWeight, gustAt, makeRand, placeFall,
  snowLanding, splashAt, streakRot, targetCount, weatherDescriptors,
} from "../../ambient/weather/precip.js";
import { precipShown, setPrecipShown } from "../../ambient/runtime/precipstate.js";

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

/* ---- 1. the matrix --------------------------------------------------------- */

test("the matrix is symmetric over the whole weather universe", () => {
  for (const a of WEATHER_UNIVERSE)
    for (const b of WEATHER_UNIVERSE) assert.equal(compatible(a, b), compatible(b, a), `${a}/${b}`);
  assert.deepEqual([...WEATHER_UNIVERSE], [...WEATHER_EFFECTS, "thunder"]);
});

test("precipitation is one at a time; everything else pairs by the stated physics", () => {
  const p = [...PRECIPITATION];
  for (const a of p) for (const b of p) if (a !== b) assert.equal(compatible(a, b), false, `${a} with ${b}`);
  // thunder: under any rain, under a dry sky, never with snow
  for (const r of ["drizzle", "rain", "heavyrain", "storm"]) assert.equal(compatible("thunder", r), true, r);
  assert.equal(compatible("thunder", "snow"), false);
  assert.equal(compatible("thunder", "cloudy"), true);
  // mist: still damp air only
  for (const ok of ["cloudy", "drizzle", "rain"]) assert.equal(compatible("mist", ok), true, ok);
  for (const no of ["heavyrain", "storm", "snow", "windy"]) assert.equal(compatible("mist", no), false, no);
  // windy: not with mist, not with a storm that has its own gusts
  assert.equal(compatible("windy", "storm"), false);
  assert.equal(compatible("windy", "snow"), true, "a blizzard is allowed");
  // cloudy: cover goes with anything
  for (const x of WEATHER_UNIVERSE) assert.equal(compatible("cloudy", x), true, x);
  // LEAVES FALL ON A DRY SKY (maintainer 2026-09-24: through rain a 13 px leaf
  // is "a raindrop ... very big ... as if falling close to the camera")
  for (const wet of ["drizzle", "rain", "heavyrain", "storm", "snow"]) assert.equal(compatible("leaves", wet), false, `leaves with ${wet}`);
  for (const dry of ["cloudy", "mist", "windy", "thunder"]) assert.equal(compatible("leaves", dry), true, `leaves with ${dry}`);
});

test("a feature's `conflicts` is the matrix, and the runtime closure agrees", () => {
  const feats = weatherDescriptors().map((d) => ({
    name: d.name, conflicts: d.conflicts, init() {}, update() {}, debug: () => ({}), dispose() {},
  }));
  assert.equal(feats.length, 6, "six particle weathers (cloudy and mist are gloom-only rows built in weather.ts)");
  for (const f of feats) assert.deepEqual([...f.conflicts].sort(), conflictsOf(f.name, WEATHER_UNIVERSE).sort(), f.name);
  const m = conflictClosure(feats);
  assert.ok(m.get("rain")?.has("snow") && m.get("snow")?.has("rain"), "rain/snow, both ways");
  assert.ok(!m.get("rain")?.has("cloudy"), "rain may sit under cloud");
});

/* ---- 2. the roller --------------------------------------------------------- */

test("the roller never emits an incompatible set, over many rolls and every weight it is given", () => {
  const rnd = lcg(7);
  for (let i = 0; i < 4000; i++) {
    const set = rollAmbient(DEFAULT_ZONE, rnd);
    assert.ok(isCompatibleSet(set), `roll ${i} emitted ${set.join("+")}`);
    assert.ok(set.filter((n) => PRECIPITATION.has(n)).length <= 1, `two precipitations: ${set}`);
    for (const n of set) assert.ok(WEATHER_UNIVERSE.includes(n), `unknown effect ${n}`);
    assert.deepEqual(set, [...set].sort(), "the wire form is sorted");
  }
});

test("weights are SHARES OF TIME: a 12% rain rains about 12% of rolls, and 0 never", () => {
  const rnd = lcg(11);
  const N = 20000;
  const seen: Record<string, number> = {};
  for (let i = 0; i < N; i++) for (const n of rollAmbient(DEFAULT_ZONE, rnd)) seen[n] = (seen[n] ?? 0) + 1;
  for (const n of PRECIPITATION) {
    const want = DEFAULT_ZONE[n] ?? 0;
    const got = (seen[n] ?? 0) / N;
    assert.ok(Math.abs(got - want) < 0.015, `${n}: ${got.toFixed(3)} of rolls, weight ${want}`);
  }
  const dryZone = { cloudy: 1 };
  for (let i = 0; i < 200; i++) assert.deepEqual(rollAmbient(dryZone, rnd), ["cloudy"], "a zone that never rains never rains");
  assert.deepEqual(rollAmbient({}, rnd), [], "no weights, clear sky");
});

test("a conflict drops the EXTRA, never the precipitation the zone rolled", () => {
  // force every extra on: with heavy rain rolled, mist must yield, cloudy and thunder may stay
  const always = () => 0; // rnd()=0 -> first precipitation wins, every extra passes its chance
  const set = rollAmbient({ heavyrain: 1, mist: 1, cloudy: 1, thunder: 1, windy: 1 }, always);
  assert.ok(set.includes("heavyrain"));
  assert.ok(!set.includes("mist"), "mist cannot lie in heavy rain");
  assert.ok(set.includes("cloudy") && set.includes("thunder"));
  assert.ok(isCompatibleSet(set));
});

test("a zone that rolls leaves AND rain keeps the rain and loses the leaves — on the server, for every stream", () => {
  // the woods carry leaves at 90; a wet window there must not rain fat slow
  // leaves through the streaks (maintainer 2026-09-24). Independent draws
  // are their own coin, so both come up together often — the matrix trims.
  // the roller's own generator (mulberry32): makeRand's FIRST draw is
  // seed*16807/2^31, tiny for small seeds, so every rain lottery would win
  let both = 0, leavesAlone = 0, rainAlone = 0;
  for (let i = 0; i < 400; i++) {
    const rnd = seededRnd(1000 + i);
    const set = rollZoneSet({ rain: 0.9, leaves: 0.9, cloudy: 0.5 }, [["drizzle", "rain", "heavyrain", "storm", "snow", "windy"]], rnd);
    const r = set.includes("rain"), l = set.includes("leaves");
    if (r && l) both++;
    if (l && !r) leavesAlone++;
    if (r && !l) rainAlone++;
    assert.ok(isCompatibleSet(set), set.join(","));
  }
  assert.equal(both, 0, "leaves and rain in one window");
  assert.ok(rainAlone > 200 && leavesAlone > 10, `rain ${rainAlone}, leaves alone ${leavesAlone}: the precipitation the zone rolled wins`);
});

test("the same random stream gives the same sky — every zone room must agree", () => {
  const a = lcg(99), b = lcg(99);
  for (let i = 0; i < 50; i++) assert.deepEqual(rollAmbient(DEFAULT_ZONE, a), rollAmbient(DEFAULT_ZONE, b));
  assert.ok(EPISODE_S[0] >= 120 && EPISODE_S[1] > EPISODE_S[0], "an episode is minutes, not frames");
});

test("the wire form round-trips and tolerates junk", () => {
  assert.equal(packAmbient(["rain", "cloudy", "rain"]), "cloudy,rain");
  assert.deepEqual([...unpackAmbient("cloudy,rain")].sort(), ["cloudy", "rain"]);
  assert.deepEqual([...unpackAmbient("")], []);
  assert.deepEqual([...unpackAmbient(undefined)], []);
  assert.deepEqual([...unpackAmbient(" rain , ,snow ")].sort(), ["rain", "snow"]);
});

/* ---- 3. nothing was restyled ----------------------------------------------- */

test("every precipitation keeps the exact table it had in weatherfx.ts", () => {
  const OLD: Record<number, { count: number; vy: [number, number]; vx: number; alpha: number; scaleY: number }> = {
    3: { count: 90,  vy: [300, 390], vx: -15,  alpha: 0.34, scaleY: 0.6 },
    4: { count: 260, vy: [620, 760], vx: -70,  alpha: 0.45, scaleY: 1 },
    5: { count: 520, vy: [700, 880], vx: -120, alpha: 0.52, scaleY: 1.25 },
    6: { count: 660, vy: [760, 960], vx: -250, alpha: 0.56, scaleY: 1.4 },
    7: { count: 240, vy: [55, 95],   vx: 0,    alpha: 0.9,  scaleY: 1 },
    8: { count: 110, vy: [15, 60],   vx: -200, alpha: 0.95, scaleY: 1 },
  };
  for (const [idx, o] of Object.entries(OLD)) {
    const c = cfgByIdx(Number(idx));
    assert.ok(c, `weather ${idx} lost its config`);
    assert.equal(c.count, o.count); assert.deepEqual(c.vy, o.vy); assert.equal(c.vx, o.vx);
    assert.equal(c.alpha, o.alpha); assert.equal(c.scaleY, o.scaleY);
  }
  assert.equal(PRECIP.length, 6);
  assert.deepEqual(PRECIP.filter((c) => c.lightning).map((c) => c.name), ["storm"]);
  assert.deepEqual(PRECIP.filter((c) => c.splash).map((c) => c.name), ["drizzle", "rain", "heavyrain", "storm"]);
  assert.equal(cfgByName("storm")?.idx, 6);
});

test("a single weather grades the light exactly as its old index did", () => {
  // the old WEATHER_CLOUD / WEATHER_DIM tables, by index, verbatim
  const OLD_CLOUD: Record<number, number> = { 1: 1, 3: 0.35, 4: 0.7, 5: 1, 6: 1, 7: 0.4, 8: 0.25 };
  const OLD_DIM: Record<number, number> = { 3: 0.05, 4: 0.12, 5: 0.22, 6: 0.34, 7: 0.05 };
  for (let idx = 0; idx < LEGACY_INDEX.length; idx++) {
    const g = gloomTarget(LEGACY_INDEX[idx]);
    assert.equal(g.cloud, OLD_CLOUD[idx] ?? 0, `cloud at old index ${idx}`);
    assert.equal(g.dim, OLD_DIM[idx] ?? 0, `dim at old index ${idx}`);
    assert.equal(g.mist, idx === 2 ? 1 : 0, `mist at old index ${idx}`);
  }
  assert.deepEqual({ ...CLOUD_OF }, { cloudy: 1, drizzle: 0.35, rain: 0.7, heavyrain: 1, storm: 1, snow: 0.4, windy: 0.25 });
  assert.deepEqual({ ...DIM_OF }, { drizzle: 0.05, rain: 0.12, heavyrain: 0.22, storm: 0.34, snow: 0.05 });
});

test("several weathers at once take the STRONGEST of each term, never the sum", () => {
  const g = gloomTarget(["cloudy", "drizzle", "thunder"]);
  assert.equal(g.cloud, 1, "cloudy's full cover, not 1 + 0.35");
  assert.equal(g.dim, 0.05, "drizzle's gloom");
  assert.equal(g.mist, 0);
  assert.equal(gloomTarget(["mist", "rain"]).mist, 1);
  assert.equal(gloomTarget([]).cloud, 0);
});

test("easeGloom reproduces WorldScene's old inline roll, frame for frame, past the snap", () => {
  // WorldScene before the move: ca = 1-exp(-(dt/1000)/4); cloud and mist snap
  // inside 0.005; dim does not. Storm's dim (0.34) reaches the snap band only
  // after ~4*ln(0.34/0.005) = 17 s, so a short loop cannot see the difference
  // — a mutant that added a snap to dim passed a 600-frame version of this.
  let cloud = 0, mist = 0, dim = 0;
  const g = newGloom();
  const active = ["storm"];
  for (let f = 0; f < 3000; f++) {
    const delta = 16 + (f % 5);
    const ca = 1 - Math.exp(-(delta / 1000) / 4);
    cloud += (1 - cloud) * ca; if (Math.abs(cloud - 1) < 0.005) cloud = 1;
    mist += (0 - mist) * ca; if (Math.abs(mist - 0) < 0.005) mist = 0;
    dim += (0.34 - dim) * ca;
    easeGloom(g, active, delta);
    assert.ok(Math.abs(g.cloud - cloud) < 1e-12 && Math.abs(g.mist - mist) < 1e-12 && Math.abs(g.dim - dim) < 1e-12, `frame ${f}`);
  }
  assert.equal(g.cloud, 1, "cloud snapped");
  assert.notEqual(g.dim, 0.34, "dim must NOT snap — it multiplies the whole ambient");
  assert.equal(GLOOM_TAU_S, 4); assert.equal(GLOOM_SNAP, 0.005);
  assert.deepEqual(snapGloom(newGloom(), ["heavyrain"]), { cloud: 1, dim: 0.22, mist: 0 });
});

test("with the zone field in force the sky grades by each weather's weight at my feet and the mist by its cover of the view", () => {
  // THE BOUNDARY (2026-09-20): my cell's set is a step; the field is the ramp.
  try {
    assert.equal(gloomField(), null);
    setGloomField({ at: { cloudy: 0.5, rain: 0.25 }, mistInView: 0.3 });
    const g = gloomTarget(["storm"]); // the active set is not read while the field rules
    assert.equal(g.cloud, 0.5, "half way across the cloudy line: half the cover (rain's 0.7 x 0.25 loses)");
    assert.ok(Math.abs(g.dim - 0.12 * 0.25) < 1e-12, "a quarter of the rain's gloom");
    assert.equal(g.mist, 0.3, "the mist scalar is its cover of the VIEW — the mask does the rest");
    assert.deepEqual(snapGloom(newGloom(), ["storm"]), { cloud: 0.5, dim: 0.03, mist: 0.3 }, "a join snaps to the same");
    // the forced rows union with the field, whole
    forceGloom("mist", true);
    assert.equal(gloomTarget([]).mist, 1, "a forced mist is whole");
    forceGloom("mist", false);
    // a field with nothing at my feet and no mist in view: clear, whatever my cell's set says
    setGloomField({ at: {}, mistInView: 0 });
    assert.deepEqual(gloomTarget(["storm", "mist"]), { cloud: 0, dim: 0, mist: 0 });
    // weights are clamped to 0..1 and an effect that grades nothing (thunder) grades nothing
    setGloomField({ at: { thunder: 1, cloudy: 2 }, mistInView: 4 });
    assert.deepEqual(gloomTarget([]), { cloud: 1, dim: 0, mist: 1 });
    setGloomField({ at: { cloudy: -1 }, mistInView: -2 });
    assert.deepEqual(gloomTarget([]), { cloud: 0, dim: 0, mist: 0 });
    // released: the active set rules again
    setGloomField(null);
    assert.equal(gloomTarget(["storm"]).cloud, 1, "no field: the active set");
  } finally {
    setGloomField(null);
    for (const n of forcedGloom()) forceGloom(n, false);
  }
});

test("a row forced on in Settings reaches the gloom — and releasing it cannot brighten what the world rolled", () => {
  // THE MAINTAINER'S MIST (2026-09-19). For two days the mist row's switch
  // wrote a set only the precipitation features read, so flipping it did
  // nothing — and no zone assigned it either, so nothing else could show it.
  try {
    assert.deepEqual(forcedGloom(), []);
    assert.equal(gloomTarget([]).mist, 0, "nothing forced, nothing rolled: clear");
    forceGloom("mist", true);
    assert.equal(gloomTarget([]).mist, 1, "forced mist hazes a clear sky");
    assert.deepEqual(snapGloom(newGloom(), []), { cloud: 0, dim: 0, mist: 1 }, "...on a join too");
    const g = newGloom();
    for (let f = 0; f < 2000; f++) easeGloom(g, [], 16); // 32 s: past 4*ln(1/0.005) = 21 s
    assert.equal(g.mist, 1, "...and the ease reaches it");
    // A UNION: the server's storm keeps its whole grade under a forced mist,
    // and taking the force away leaves the storm exactly as it was.
    assert.deepEqual(gloomTarget(["storm"]), { cloud: 1, dim: 0.34, mist: 1 });
    forceGloom("mist", false);
    assert.deepEqual(gloomTarget(["storm"]), { cloud: 1, dim: 0.34, mist: 0 }, "release removes only the force");
    // a forced precipitation brings its sky with it — a storm forced on to
    // look at it does not fall out of a clear blue sky
    forceGloom("storm", true);
    assert.deepEqual(gloomTarget([]), { cloud: 1, dim: 0.34, mist: 0 });
    forceGloom("storm", false);
    assert.deepEqual(forcedGloom(), []);
  } finally {
    for (const n of forcedGloom()) forceGloom(n, false);
  }
});

test("the gloom-only rows do what their switches say, and report it", () => {
  // THE ROW THE GAME REGISTERS (weather.ts builds cloudy and mist from this),
  // loaded here as itself — the factory around it cannot be imported in node.
  const mist = gloomOnlyRow("mist");
  const cloudy = gloomOnlyRow("cloudy");
  try {
    assert.equal((mist.debug() as { gain: number }).gain, 0);
    assert.ok(mist.conflicts!.includes("windy"), "the matrix still forbids mist under wind");
    mist.setForced!(true);
    assert.equal((mist.debug() as { gain: number }).gain, 1, "the row reports the force");
    assert.equal(gloomTarget([]).mist, 1, "...and the gloom has it");
    cloudy.setForced!(true);
    assert.equal(gloomTarget([]).cloud, 1, "cloudy greys the sky when forced");
    // suppression (manual mode, row off) is NOT passed to the gloom: the
    // light is never optional. Only releasing the force clears it.
    mist.setSuppressed!(true);
    assert.equal(gloomTarget([]).mist, 1);
    mist.setForced!(false);
    cloudy.setForced!(false);
    assert.deepEqual(gloomTarget([]), { cloud: 0, dim: 0, mist: 0 });
    mist.setForced!(true);
    mist.dispose();
    assert.equal(gloomTarget([]).mist, 0, "a disposed row leaves no ghost haze");
  } finally {
    for (const n of forcedGloom()) forceGloom(n, false);
  }
});

/* ---- 3b. the boundary: where a drop is drawn ----------------------------- */

test("a drop is placed uniformly over the sheet, lands where the wind takes it, and steps across the line where its fall crosses it", () => {
  // the zone is x >= 500 with a 100 px ramp; a storm blows left 150 px in one fall
  const weightAt = (x: number) => Math.max(0, Math.min(1, (x - 500) / 100));
  const rnd = makeRand(11);
  let inside = 0, outside = 0, fadeOut = 0;
  for (let i = 0; i < 400; i++) {
    const p = placeFall(rnd, 0, 1000, 0, 400, -150, weightAt);
    assert.ok(p.x0 >= 0 && p.x0 <= 1000, `starts on the sheet (x0 ${p.x0.toFixed(0)})`);
    assert.ok(Math.abs(p.xl - (p.x0 - 150)) < 1e-9, "lands the drift downwind of the start");
    assert.ok(Math.abs(p.w - weightAt(p.xl)) < 1e-9 && Math.abs(p.w0 - weightAt(p.x0)) < 1e-9, "carries the field at both ends");
    if (p.w0 > 0.98 && p.w > 0.98) inside++;
    if (p.w0 < 0.02 && p.w < 0.02) outside++;
    if (p.w0 > 0.5 && p.w < 0.02) {
      fadeOut++;
      // the crossing is where the field reaches the midway value between the ends
      const xMid = 500 + ((p.w0 + p.w) / 2) * 100;
      assert.ok(Math.abs(p.x0 + (p.xl - p.x0) * p.pc - xMid) < 150 / 32 + 1e-9, `crossing at ${(p.x0 - 150 * p.pc).toFixed(0)}, the field's midway at ${xMid.toFixed(0)}`);
    }
  }
  // uniform over 0..1000 blown 150 left: a quarter start AND land inside (x0 >= 748), half start
  // and land outside (x0 < 502), and the band between is blown out across the line — none lost
  assert.ok(inside > 75 && inside < 130 && outside > 165 && outside < 235, `inside ${inside}, outside ${outside}`);
  assert.ok(fadeOut > 15, `${fadeOut} drops blown out across the line`);
  // an explicit fall: start at x 450 (weight 0), land at 700 (weight 1): the field's midway 0.5 is at x 550 -> pc 0.4
  const one = placeFall(() => 0.45, 0, 1000, 0, 400, 250, weightAt);
  assert.ok(Math.abs(one.xl - 700) < 1e-9 && Math.abs(one.x0 - 450) < 1e-9 && one.w0 === 0 && one.w === 1);
  assert.ok(Math.abs(one.pc - 0.4) < 1 / 32, `pc ${one.pc}`);
  // the step: the start weight before the crossing, the landing weight after, midway at it
  const half = 40 / 250;
  assert.equal(fallWeight(0, 1, 0.4, half, 0), 0);
  assert.equal(fallWeight(0, 1, 0.4, half, 0.4 - half), 0);
  assert.ok(Math.abs(fallWeight(0, 1, 0.4, half, 0.4) - 0.5) < 1e-9);
  assert.equal(fallWeight(0, 1, 0.4, half, 0.4 + half), 1);
  assert.equal(fallWeight(0, 1, 0.4, half, 1), 1);
  assert.ok(fallWeight(0, 1, 0.4, half, 0.36) > 0.05 && fallWeight(0, 1, 0.4, half, 0.36) < 0.45, "a smooth rise, not a cliff");
  // falling out: 1 -> 0.3 steps down at its crossing
  assert.equal(fallWeight(1, 0.3, 0.7, half, 0.5), 1);
  assert.ok(Math.abs(fallWeight(1, 0.3, 0.7, half, 1) - 0.3) < 1e-9);
  // ends that do not cross a line run linearly; clamped progress
  assert.ok(Math.abs(fallWeight(0.9, 1, 0.5, half, 0.5) - 0.95) < 1e-9);
  assert.equal(fallWeight(0, 1, 0.4, half, -1), 0); assert.equal(fallWeight(0, 1, 0.4, half, 2), 1);
  // no field: both ends 0, no crossing, nothing drawn
  const none = placeFall(makeRand(3), 0, 1000, 0, 400, -150, () => 0);
  assert.deepEqual([none.w, none.w0, none.pc], [0, 0, 0.5]);
});

test("the count is the FULL view's whatever share of it the zone covers — the curtain is drawn where the field is on", () => {
  const rain = cfgByName("rain")!;
  assert.equal(targetCount(rain, 520, 700), rain.count, "the reference view");
  assert.equal(targetCount(rain, 1040, 700), rain.count * 2);
  assert.equal(targetCount(null, 520, 700), 0);
});

test("six sheets publish their own density and the environment reads the heaviest", () => {
  setPrecipShown("rain", 0); setPrecipShown("snow", 0);
  assert.equal(precipShown(), 0);
  setPrecipShown("rain", 30);
  setPrecipShown("snow", 120);
  assert.equal(precipShown(), 120, "the summit's snow, not the valley's rain");
  setPrecipShown("snow", 0);
  assert.equal(precipShown(), 30, "a sheet that stopped is not counted");
  setPrecipShown("rain", 0);
  assert.equal(precipShown(), 0);
});

/* ---- 4. the old ring, for the gates --------------------------------------- */

test("LEGACY_INDEX means what WEATHER_NAMES meant, in order", () => {
  assert.equal(LEGACY_INDEX.length, 9);
  assert.deepEqual(LEGACY_INDEX.map((r) => r.join("+")), ["", "cloudy", "mist", "drizzle", "rain", "heavyrain", "storm", "snow", "windy"]);
  for (const row of LEGACY_INDEX) assert.ok(isCompatibleSet(row));
});

/* ---- the particle arithmetic, unchanged ----------------------------------- */

test("density, tilt, gust, snow and splash arithmetic are as they were", () => {
  assert.equal(areaScale(520, 700), 1); assert.equal(areaScale(99999, 99999), 3); assert.equal(REF_AREA, 520 * 700);
  assert.equal(targetCount(null, 520, 700), 0); assert.equal(targetCount(cfgByName("storm"), 520, 700), 660);
  assert.ok(targetCount(cfgByName("storm"), 99999, 99999) <= MAX_DROPS * 1.5);
  const storm = cfgByName("storm")!;
  assert.ok(Math.abs(streakRot(storm, storm.vx)) > 0.1); assert.equal(streakRot(cfgByName("snow")!, -50), 0);
  let min = Infinity, max = -Infinity;
  for (let t = 0; t < 400; t += 0.013) { const g = gustAt(t, true); min = Math.min(min, g); max = Math.max(max, g); }
  assert.ok(min >= -0.1001 && min < 0 && max <= 1.4001 && max > 1.3, "the gust envelope [-0.10, 1.40] — it briefly reverses, as it always did");
  assert.equal(gustAt(12.3, false), 1);
  const rnd = makeRand(3);
  assert.deepEqual(snowLanding(true, rnd), { state: SNOW_MELTING, dur: SNOW_WATER_MELT });
  const land = snowLanding(false, rnd); assert.equal(land.state, SNOW_RESTING); assert.ok(land.dur >= 2500 && land.dur <= 6000);
  let prev = Infinity;
  for (let p = 0; p <= 1; p += 0.05) { const v = splashAt(p, 2); assert.ok(Math.abs(v.sy - v.sx * 0.5) < 1e-9 && v.a <= prev + 1e-9); prev = v.a; }
  let shown = 0; for (let f = 0; f < 2000; f++) shown = easeShown(shown, 260, 16);
  assert.ok(Math.abs(shown - 260) < 0.5 && easeShown(0, 260, 16) < 5);
});
