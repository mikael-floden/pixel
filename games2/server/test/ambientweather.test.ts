// WEATHER IS AMBIENT (maintainer 2026-09-17, full ownership). Three things
// are pinned here, because all three are invisible in a screenshot and would
// be wrong forever:
//
//  1. THE MOVE DID NOT RESTYLE THE WEATHER. Every number came out of
//     client/src/weatherfx.ts and WorldScene; the old values are written out
//     literally below and compared, so a port that quietly retuned the rain
//     fails rather than shipping.
//  2. THE GLOOM IS FRAME-IDENTICAL. curCloud/curPrecipDim/curMist fed the
//     NIGHT SHADER's ambient. They are ambient's now and eased by a pure
//     function, and this reproduces WorldScene's old inline ease step for
//     step over a long roll.
//  3. THE RAIN TYPES CANNOT OVERLAP. Two locks: structural (one weather index)
//     and declared (`conflicts`, symmetric via conflictClosure) for MANUAL
//     mode, where a player can force effects on by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WEATHER_NAMES } from "@nangijala/shared";
import { conflictClosure } from "../../ambient/runtime/types.js";
import {
  GLOOM_SNAP, GLOOM_TAU_S, WEATHER_CLOUD, WEATHER_DIM, WEATHER_MIST_IDX,
  easeGloom, gloomTarget, newGloom, snapGloom,
} from "../../ambient/weather/gloom.js";
import {
  MAX_DROPS, PRECIP, REF_AREA, SNOW_WATER_MELT, SNOW_MELTING, SNOW_RESTING,
  areaScale, cfgByIdx, cfgByName, easeShown, gustAt, makeRand, snowLanding,
  splashAt, streakRot, targetCount, weatherDescriptors,
} from "../../ambient/weather/precip.js";

/* ---- 1. the port did not restyle anything ------------------------------- */

test("every precipitation keeps the exact table it had in weatherfx.ts", () => {
  // verbatim from the deleted client/src/weatherfx.ts PRECIP map
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
    assert.ok(c, `weather ${idx} (${WEATHER_NAMES[Number(idx)]}) lost its config in the move`);
    assert.equal(c.count, o.count);
    assert.deepEqual(c.vy, o.vy);
    assert.equal(c.vx, o.vx);
    assert.equal(c.alpha, o.alpha);
    assert.equal(c.scaleY, o.scaleY);
  }
  assert.equal(PRECIP.length, 6);
});

test("each feature is bound to its own WEATHER_NAMES index, and only the wet ones exist", () => {
  // Clear (0), Cloudy (1) and Mist (2) draw no particles — they are gloom only
  assert.equal(cfgByIdx(0), null);
  assert.equal(cfgByIdx(1), null);
  assert.equal(cfgByIdx(2), null);
  for (const c of PRECIP) assert.ok(WEATHER_NAMES[c.idx], `idx ${c.idx} is not a weather`);
  assert.equal(cfgByName("storm")?.idx, 6);
  assert.equal(cfgByName("snow")?.idx, 7);
  // only the storm flashes, and only rain splashes
  assert.deepEqual(PRECIP.filter((c) => c.lightning).map((c) => c.name), ["storm"]);
  assert.deepEqual(PRECIP.filter((c) => c.splash).map((c) => c.name), ["drizzle", "rain", "heavyrain", "storm"]);
  assert.deepEqual(PRECIP.filter((c) => c.gust).map((c) => c.name), ["storm", "windy"]);
});

test("density follows the view area, capped both ends", () => {
  assert.equal(areaScale(520, 700), 1, "the reference view is exactly 1x");
  assert.ok(Math.abs(areaScale(1040, 700) - 2) < 1e-9);
  assert.equal(areaScale(99999, 99999), 3, "a zoomed-out view cannot ask for an unbounded sheet");
  assert.equal(targetCount(null, 520, 700), 0, "no weather, no drops");
  assert.equal(targetCount(cfgByName("storm"), 520, 700), 660);
  assert.ok(targetCount(cfgByName("storm"), 99999, 99999) <= MAX_DROPS * 1.5);
  assert.equal(REF_AREA, 520 * 700);
});

test("rain tilts into its own fall; snow and leaves never rotate", () => {
  const storm = cfgByName("storm")!;
  assert.ok(Math.abs(streakRot(storm, storm.vx)) > 0.1, "a rain streak leans");
  assert.equal(streakRot(cfgByName("snow")!, -50), 0);
  assert.equal(streakRot(cfgByName("windy")!, -200), 0);
});

test("the gust is one shared number, so every streak leans together", () => {
  // 0.65 + 0.55*sin + 0.2*sin, so the exact envelope is [-0.10, 1.40] — the
  // gust DIPS BELOW ZERO for a sliver of its cycle and the wind briefly blows
  // back the other way. That is weatherfx.ts's own behaviour, carried over
  // deliberately: this move was not allowed to restyle the weather. Pinned so
  // a future retune is a decision rather than an accident.
  let min = Infinity, max = -Infinity;
  for (let t = 0; t < 400; t += 0.013) {
    const g = gustAt(t, true);
    min = Math.min(min, g);
    max = Math.max(max, g);
  }
  assert.ok(min >= -0.1001 && min < 0, `the gust should just reverse, got min ${min}`);
  assert.ok(max <= 1.4001 && max > 1.3, `gust max ${max} outside its envelope`);
  assert.equal(gustAt(12.3, false), 1, "no gust means no modulation at all");
  assert.notEqual(gustAt(0, true), gustAt(3.4, true), "the gust has to actually move");
});

test("snow melts on contact with water instead of lying on it", () => {
  const rnd = makeRand(3);
  const onWater = snowLanding(true, rnd);
  assert.equal(onWater.state, SNOW_MELTING);
  assert.equal(onWater.dur, SNOW_WATER_MELT);
  const onLand = snowLanding(false, rnd);
  assert.equal(onLand.state, SNOW_RESTING);
  assert.ok(onLand.dur >= 2500 && onLand.dur <= 6000, `rest ${onLand.dur} outside SNOW_REST`);
});

test("a splash ripple is an ISO ellipse that only ever fades", () => {
  let prev = Infinity;
  for (let p = 0; p <= 1; p += 0.05) {
    const v = splashAt(p, 2);
    assert.ok(Math.abs(v.sy - v.sx * 0.5) < 1e-9, "the ring must be squashed, not a circle");
    assert.ok(v.a <= prev + 1e-9, "a ripple never brightens");
    prev = v.a;
  }
  assert.ok(splashAt(1, 2).a < 1e-9, "and it is gone at the end of its life");
});

/* ---- 2. the gloom is frame-identical to WorldScene's old ease ------------ */

test("the gloom tables are the ones the night shader always had", () => {
  assert.deepEqual({ ...WEATHER_CLOUD }, { 1: 1, 3: 0.35, 4: 0.7, 5: 1, 6: 1, 7: 0.4, 8: 0.25 });
  assert.deepEqual({ ...WEATHER_DIM }, { 3: 0.05, 4: 0.12, 5: 0.22, 6: 0.34, 7: 0.05 });
  assert.equal(WEATHER_MIST_IDX, 2);
  assert.equal(GLOOM_TAU_S, 4);
  assert.equal(GLOOM_SNAP, 0.005);
  // clear sky grades nothing
  assert.deepEqual(gloomTarget(0), { cloud: 0, dim: 0, mist: 0 });
  // mist is the only weather that raises banks
  assert.equal(gloomTarget(2).mist, 1);
  for (const i of [0, 1, 3, 4, 5, 6, 7, 8]) assert.equal(gloomTarget(i).mist, 0, `weather ${i} must not mist`);
});

test("easeGloom reproduces WorldScene's old inline roll, frame for frame", () => {
  // WorldScene, before the move:
  //   const ca = 1 - Math.exp(-(delta/1000)/4)
  //   curCloud += (cloudTo - curCloud) * ca;  if |d| < 0.005 -> snap
  //   curMist  += (mistTo  - curMist ) * ca;  if |d| < 0.005 -> snap
  //   curPrecipDim += (dimTo - curPrecipDim) * ca;   // NO snap, deliberately
  let cloud = 0, mist = 0, dim = 0;
  const g = newGloom();
  const idx: number = 6; // Storm: clouded 1, dim 0.34, no mist
  // LONG ENOUGH TO REACH THE SNAP. `cloud` and `mist` snap inside 0.005 of
  // target; `dim` deliberately does not. Storm's dim rolls 0 -> 0.34, so the
  // threshold is only crossed after ~4*ln(0.34/0.005) = 17 s of world time.
  // A 600-frame (~11 s) loop never got there, and a mutant that ADDED a snap
  // to `dim` passed this test — measured. 3000 frames is ~54 s.
  for (let f = 0; f < 3000; f++) {
    const delta = 16 + (f % 5); // a jittery frame clock, like a real one
    const ca = 1 - Math.exp(-(delta / 1000) / 4);
    const cloudTo = WEATHER_CLOUD[idx] ?? 0;
    cloud += (cloudTo - cloud) * ca;
    if (Math.abs(cloud - cloudTo) < 0.005) cloud = cloudTo;
    const mistTo = idx === 2 ? 1 : 0;
    mist += (mistTo - mist) * ca;
    if (Math.abs(mist - mistTo) < 0.005) mist = mistTo;
    const dimTo = WEATHER_DIM[idx] ?? 0;
    dim += (dimTo - dim) * ca;

    easeGloom(g, idx, delta);
    assert.ok(Math.abs(g.cloud - cloud) < 1e-12, `frame ${f}: cloud ${g.cloud} vs ${cloud}`);
    assert.ok(Math.abs(g.mist - mist) < 1e-12, `frame ${f}: mist ${g.mist} vs ${mist}`);
    assert.ok(Math.abs(g.dim - dim) < 1e-12, `frame ${f}: dim ${g.dim} vs ${dim}`);
  }
  assert.ok(g.dim > 0.33, "a storm really is gloomy by the end of the roll");
  assert.notEqual(g.dim, gloomTarget(6).dim, "dim must NOT snap — it multiplies the whole ambient, and a snap there is a visible step in a dark scene");
  assert.equal(g.cloud, gloomTarget(6).cloud, "cloud DOES snap, as it always did");
});

test("a join SNAPS the grade — you never ease in from clear sky", () => {
  const g = snapGloom(newGloom(), 5);
  assert.deepEqual(g, gloomTarget(5));
  assert.equal(g.dim, 0.22);
});

/* ---- 3. the rain types cannot overlap ------------------------------------ */

test("every weather declares every other as a conflict, symmetrically", () => {
  // Built from the same descriptors weather.ts maps onto its features, so
  // this is the real rule — the Phaser layer is not importable under node
  // (it pulls in the composer, which wants Vite's import.meta.env).
  const feats = weatherDescriptors().map((d) => ({
    name: d.name, conflicts: d.conflicts,
    init() {}, update() {}, debug: () => ({}), dispose() {},
  }));
  assert.equal(feats.length, 6);
  const names = feats.map((f) => f.name);
  assert.deepEqual(names, ["drizzle", "rain", "heavyrain", "storm", "snow", "windy"]);
  const m = conflictClosure(feats);
  for (const a of names)
    for (const b of names) {
      if (a === b) continue;
      assert.ok(m.get(a)?.has(b), `${a} may not run with ${b}, but does not say so`);
      assert.ok(m.get(b)?.has(a), `the closure is not symmetric for ${a}/${b}`);
    }
});

test("STRUCTURAL exclusion: one weather index can satisfy at most one feature", () => {
  // The lock that holds in AUTO, where conflicts are not consulted at all.
  for (let idx = 0; idx < WEATHER_NAMES.length; idx++) {
    const wanted = PRECIP.filter((c) => c.idx === idx);
    assert.ok(wanted.length <= 1, `weather ${idx} would drive ${wanted.length} sheets at once`);
  }
});

test("the shown count eases in rather than popping, and settles", () => {
  let shown = 0;
  for (let f = 0; f < 2000; f++) shown = easeShown(shown, 260, 16);
  assert.ok(Math.abs(shown - 260) < 0.5, `never reached its density: ${shown}`);
  // one frame in never jumps most of the way there
  assert.ok(easeShown(0, 260, 16) < 5, "a weather must not pop on in one frame");
});
