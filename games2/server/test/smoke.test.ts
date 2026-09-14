// FIRE SMOKE — the discrimination and the shape of a puff, pinned.
//
// What a screenshot cannot see and would be wrong forever: a lantern smoking
// (it is a fire, and it is behind glass), a column that climbs at a constant
// rate (that reads as a floating dot), a puff that is switched off instead of
// thinning, and a grey with colour in it. All arithmetic, all here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURL_HZ,
  CURL_PX,
  GAP_MS,
  MAX_PUFFS,
  PER_FIRE,
  PUFF_LIFE,
  RISE0,
  RISE_DRAG,
  SPREAD_PX,
  WIND_X,
  WIND_Y,
  driftX,
  driftY,
  nextGap,
  puffAlpha,
  puffSize,
  riseY,
  smokeTint,
  smokes,
  weight,
} from "../../ambient/smoke/plume.js";

test("an OPEN fire smokes; a lantern and every glow do not", () => {
  // the scenery domain's published vocabulary, counted over the shipped pieces
  assert.equal(smokes("fire/open"), true, "63 pieces");
  assert.equal(smokes("fire/ember"), true, "19 pieces — a bed of coals is the smokiest thing in the game");
  assert.equal(smokes("fire/enclosed"), false, "60 pieces — a lantern's flame is behind glass");
  for (const k of ["glow/bio", "glow/magic", "glow/mineral", "glow/water", "none"])
    assert.equal(smokes(k), false, `${k} is not a fire at all`);
  // and nothing derived from a missing or reshaped field
  assert.equal(smokes(null), false);
  assert.equal(smokes(undefined), false);
  assert.equal(smokes(""), false);
  assert.equal(smokes("firelight"), false, "a prefix test, not a substring one");
});

test("a puff rises, and gives up as it cools", () => {
  const life = PUFF_LIFE[0];
  const up = RISE0[0];
  assert.equal(riseY(0, life, up), 0);
  let prev = 0;
  let firstStep = 0;
  let lastStep = 0;
  for (let t = 50; t <= life; t += 50) {
    const y = riseY(t, life, up);
    const step = y - prev;
    assert.ok(y > prev, `climbs at ${t}ms`);
    if (t === 50) firstStep = step;
    lastStep = step;
    prev = y;
  }
  assert.ok(lastStep < firstStep, `slows: ${lastStep.toFixed(3)} px/step against ${firstStep.toFixed(3)} at the flame`);
  assert.ok(prev > 25, `and gets clear of the piece — ${prev.toFixed(1)} px over its life`);
  assert.ok(RISE_DRAG > 0 && RISE_DRAG < 1);
});

test("it leans on the cloud wind, and the rise always wins", () => {
  assert.ok(WIND_X > WIND_Y * 1.5, "the wind is mostly across the screen, as the clouds are");
  const life = PUFF_LIFE[1];
  const up = RISE0[0];
  // over a whole life, the climb must beat the down-screen component many times over
  assert.ok(riseY(life, life, up) > driftY(life) * 5, "a column, not a smear");
  // and the lean is real, not a rounding error
  assert.ok(driftX(life, 0, 0, 0, 0) > 8, `the wind carries it ${driftX(life, 0, 0, 0, 0).toFixed(1)} px`);
});

test("it CURLS — the column bends instead of standing like a post", () => {
  const life = PUFF_LIFE[1];
  const curl = CURL_PX[1];
  const hz = CURL_HZ[0];
  // with the wind and spread removed, the curl alone must swing both ways
  let lo = Infinity;
  let hi = -Infinity;
  for (let t = 0; t <= life; t += 40) {
    const x = driftX(t, curl, 0, hz, 0) - WIND_X * (t / 1000);
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  assert.ok(hi > 1, `swings one way (${hi.toFixed(1)} px)`);
  assert.ok(lo < -1, `and back the other (${lo.toFixed(1)} px)`);
  // neighbours in the column share a phase, so they bend TOGETHER
  const a = driftX(600, curl, 1.2, hz, 0);
  const b = driftX(600, curl, 1.25, hz, 0);
  assert.ok(Math.abs(a - b) < 0.5, "two puffs a breath apart bend as one ribbon");
});

test("the column is tight at the flame and loose at the top", () => {
  const life = PUFF_LIFE[0];
  const near = Math.abs(driftX(120, 0, 0, 0, SPREAD_PX) - WIND_X * 0.12);
  const far = Math.abs(driftX(life, 0, 0, 0, SPREAD_PX) - WIND_X * (life / 1000));
  assert.ok(far > near + 0.5, `spreads with age (${near.toFixed(2)} px near the flame, ${far.toFixed(2)} at the top)`);
});

test("a puff thickens out of the flame and thins away — never switched off", () => {
  const life = PUFF_LIFE[0];
  assert.equal(puffAlpha(-1, life), 0);
  assert.equal(puffAlpha(life, life), 0, "gone at the end of its life, not cut");
  assert.equal(puffAlpha(0, life), 0, "and it is not there before it is there");
  const early = puffAlpha(life * 0.03, life);
  const mid = puffAlpha(life * 0.25, life);
  const late = puffAlpha(life * 0.9, life);
  assert.ok(early < mid * 0.6, `thickens out of the flame (${early.toFixed(3)} against ${mid.toFixed(3)})`);
  assert.ok(late < mid * 0.4, `then thins away (${late.toFixed(3)} against ${mid.toFixed(3)})`);
  // monotone down after the peak: no flicker in the middle of a wisp
  let peakAt = 0;
  for (let t = 0; t < life; t += 10) if (puffAlpha(t, life) > puffAlpha(peakAt, life)) peakAt = t;
  let prev = puffAlpha(peakAt, life);
  for (let t = peakAt + 10; t < life; t += 10) {
    const a = puffAlpha(t, life);
    assert.ok(a <= prev + 1e-9, `falls after its peak (${t}ms)`);
    prev = a;
  }
  assert.ok(prev < 0.05, "and arrives at nothing");
});

test("a puff gathers and then falls apart", () => {
  const life = PUFF_LIFE[0];
  assert.equal(puffSize(0, life), 1, "one pixel at the flame");
  assert.equal(puffSize(life * 0.5, life), 3, "biggest in the middle of its life");
  assert.equal(puffSize(life * 0.95, life), 1, "and back to a speck as it thins");
  for (let t = 0; t <= life; t += 25) {
    const s = puffSize(t, life);
    assert.ok(s === 1 || s === 2 || s === 3, `whole-pixel art only, got ${s}`);
  }
});

test("the grey is grey — no colour, and it DARKENS in daylight", () => {
  for (const sun of [0, 0.25, 0.5, 0.75, 1]) {
    const c = smokeTint(sun);
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    assert.equal(r, g, `sun ${sun}: neutral`);
    assert.equal(g, b, `sun ${sun}: neutral`);
    // HSV saturation of a pure grey is 0, well under the background cap of 0.45
    assert.ok(r >= 60 && r <= 130, `sun ${sun}: a smoke grey, got ${r}`);
  }
  // The case the effect exists for is a fire on SUNLIT ground, and a pale grey
  // over lit terrain is invisible (measured: 5.8 luma). A plume against a
  // bright day is dark.
  assert.ok(
    ((smokeTint(1) >> 16) & 255) < ((smokeTint(0) >> 16) & 255) - 20,
    "darker in daylight, by a margin that can be seen",
  );
});

test("it is the DAY case, and it never switches off", () => {
  assert.ok(weight(1) > weight(0), "stronger by day — a fire must read as burning at noon");
  assert.ok(weight(0) > 0.2, "but a fire burns all night too");
  assert.ok(weight(1) <= 1);
});

test("the emitter is bounded and its gaps are short enough to read as a line", () => {
  assert.ok(GAP_MS[1] < 200, "a column, not a string of beads");
  assert.ok(PER_FIRE > 8 && PER_FIRE <= 24, "thin — his word");
  assert.ok(MAX_PUFFS >= PER_FIRE && MAX_PUFFS <= 120);
  let seed = 11;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const seen = new Set<number>();
  for (let i = 0; i < 300; i++) {
    const g = nextGap(rnd);
    assert.ok(g >= GAP_MS[0] && g <= GAP_MS[1], `gap ${g} outside its band`);
    seen.add(Math.round(g));
  }
  assert.ok(seen.size > 40, "two fires never lock into step");
});
