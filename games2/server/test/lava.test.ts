// LAVA BUBBLES AND ASH — the discrimination, the timing and the colour, pinned.
//
// What a screenshot cannot see and would be wrong forever: water bubbling like
// lava (the surface table answers this, not a ground name), a dome that pops
// the instant it appears, a spark that sails away instead of falling back into
// the pool, ash that climbs out of the glow it is only visible against, and a
// bubble the same colour as the pool it sits on.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASH,
  ASH_LIFE,
  ASH_REACH,
  ASH_RISE,
  CRUST_MS,
  CRUST_R0,
  CRUST_RMAX,
  HOT,
  PERIOD,
  POP_MS,
  SPARK_MS,
  SPARK_N,
  SWELL_MS,
  ashAlpha,
  ashX,
  ashY,
  crustAlpha,
  crustR,
  crustTint,
  domeAlpha,
  domeR,
  domeTint,
  isLava,
  mix,
  nextPeriod,
  phaseAt,
  popAlpha,
  sparkAt,
  timeline,
} from "../../ambient/lava/molten.js";

// the shipped surface table, so the discrimination is tested against the real
// records rather than against invented ones
import { SURFACES } from "@nangijala/shared";

test("lava is the liquid that BURNS — from the surface table, not a name", () => {
  assert.equal(isLava(SURFACES.lava), true, "the game's one harmful liquid");
  assert.equal(isLava(SURFACES.water), false, "water bubbles are bubbles/'s job");
  assert.equal(isLava(SURFACES.deep_water), false);
  assert.equal(isLava(SURFACES.grass), false, "not even a liquid");
  // a second molten liquid would work on the day it is added, with no edit
  assert.equal(isLava({ swimmable: true, harm: 1 }), true);
  // ...and something harmful you can WALK on is not a pool
  assert.equal(isLava({ swimmable: false, harm: 9 }), false);
  assert.equal(isLava(null), false);
  assert.equal(isLava(undefined), false);
  assert.equal(isLava({}), false);
});

test("no other shipped surface reads as lava", () => {
  const molten = Object.entries(SURFACES).filter(([, s]) => isLava(s)).map(([k]) => k);
  assert.deepEqual(molten, ["lava"], `exactly one molten liquid ships today, got ${molten.join(", ")}`);
});

test("a dome swells slowly and HOLDS before it bursts", () => {
  const swell = SWELL_MS[0];
  const hold = 200;
  assert.ok(swell >= 600, "molten rock is viscous — a fast bubble reads as boiling soup");
  assert.equal(domeAlpha(0, swell, hold), 0, "not there before it is there");
  assert.ok(domeAlpha(swell * 0.5, swell, hold) > 0.4);
  assert.equal(domeAlpha(swell, swell, hold), 1, "full while the skin stretches");
  assert.equal(domeAlpha(swell + hold - 1, swell, hold), 1, "...for the whole hold");
  assert.equal(domeAlpha(swell + hold, swell, hold), 0, "and then it is gone — it burst");
  // the dome grows, in whole pixels, and never shrinks
  let prev = 0;
  for (let t = 0; t <= swell; t += 25) {
    const r = domeR(t, swell);
    assert.equal(r, Math.round(r), "whole pixels only");
    assert.ok(r >= prev, "never shrinks");
    prev = r;
  }
  assert.ok(domeR(swell, swell) > domeR(0, swell), "it did grow");
  assert.ok(domeR(swell, swell) <= 3, "thin — a dome, not a balloon");
});

test("the burst is brief and the crust spreads and fades", () => {
  assert.ok(POP_MS < 300, "a burst, not an explosion");
  assert.equal(popAlpha(0), 1);
  assert.equal(popAlpha(POP_MS), 0);
  assert.equal(crustR(0), CRUST_R0);
  assert.equal(crustR(CRUST_MS), CRUST_RMAX);
  let prev = CRUST_R0;
  for (let t = 0; t <= CRUST_MS; t += 20) {
    const r = crustR(t);
    assert.ok(r >= prev, "the ring never shrinks");
    prev = r;
  }
  assert.equal(crustAlpha(-1), 0);
  assert.equal(crustAlpha(CRUST_MS), 0, "gone at the end, not cut");
  assert.ok(crustAlpha(CRUST_MS * 0.1) > 0.7, "a quick attack: a ring, not a fade-in");
  assert.ok(crustAlpha(CRUST_MS * 0.7) < crustAlpha(CRUST_MS * 0.2), "then fades");
});

test("every spark falls BACK into the pool", () => {
  assert.ok(SPARK_N > 0 && SPARK_N <= 4, "a few, not a fountain");
  for (let i = 0; i < SPARK_N; i++) {
    assert.equal(sparkAt(i, -1).alive, false);
    assert.equal(sparkAt(i, SPARK_MS).alive, false);
    let peak = 0;
    for (let t = 0; t < SPARK_MS; t += 10) peak = Math.min(peak, sparkAt(i, t).dy);
    assert.ok(peak <= -3, `spark ${i} clears the surface (peak ${peak}px)`);
    // it ENDS on the surface it came from — a spark that sails off the top of
    // the screen is an ember, and embers/ is a different effect
    const last = sparkAt(i, SPARK_MS - 10);
    assert.ok(last.dy > peak * 0.5, `spark ${i} is on its way back down (${last.dy} against a peak of ${peak})`);
  }
  const l = sparkAt(0, SPARK_MS * 0.5).dx;
  const r = sparkAt(1, SPARK_MS * 0.5).dx;
  assert.ok(l * r < 0, "thrown both ways, not all one side");
});

test("a vent's phases meet without gap, and two vents never lock into step", () => {
  const tl = timeline(1000, 200, 5000);
  assert.equal(tl.popAt, 1200);
  assert.ok(tl.doneAt > tl.popAt);
  assert.equal(tl.nextAt, 1200 + 5000);
  assert.equal(phaseAt(0, tl), "swell");
  assert.equal(phaseAt(1199, tl), "swell");
  assert.equal(phaseAt(1200, tl), "pop");
  assert.equal(phaseAt(tl.doneAt, tl), "wait");
  // a period too short for the crust never cuts the crust short
  const quick = timeline(1000, 200, 10);
  assert.equal(quick.nextAt, quick.doneAt);
  let seed = 3;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const seen = new Set<number>();
  for (let i = 0; i < 300; i++) {
    const p = nextPeriod(rnd);
    assert.ok(p >= PERIOD[0] * 0.69 && p <= PERIOD[1] * 1.31, `period ${p} outside its jittered band`);
    seen.add(p);
  }
  assert.ok(seen.size > 150, "jittered, so a pool does not pulse");
});

test("ash rises slowly and is gone before it leaves the glow", () => {
  const life = ASH_LIFE[1];
  const up = ASH_RISE[1];
  assert.ok(up < 20, "ash off a pond drifts; it is not a chimney");
  assert.equal(ashY(0, life, up), 0);
  let prev = 0;
  for (let t = 20; t <= life; t += 20) {
    const y = ashY(t, life, up);
    assert.ok(y >= prev, "never sinks");
    prev = y;
  }
  assert.equal(ashAlpha(-1, life, up), 0);
  assert.equal(ashAlpha(life, life, up), 0);
  assert.ok(ashAlpha(life * 0.02, life, up) < ashAlpha(life * 0.2, life, up), "thickens out of the pool");
  // THE GLOW RULE: by the time a mote is ASH_REACH px up it is invisible, so
  // its alpha has to be gone before then — a dark speck on dark rock is not a
  // subtle effect, it is an absent one.
  for (let t = 0; t <= life; t += 10) {
    const h = ashY(t, life, up);
    if (h >= ASH_REACH) assert.equal(ashAlpha(t, life, up), 0, `${h.toFixed(1)}px up: past the glow, must be gone`);
  }
  // and it sways as well as drifting
  let lo = Infinity;
  let hi = -Infinity;
  for (let t = 0; t <= life; t += 20) {
    const x = ashX(t, 3, 0, 0.5) - (42 * 0.14 * t) / 1000;
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  assert.ok(hi > 0.8 && lo < -0.8, `sways both ways (${lo.toFixed(1)}..${hi.toFixed(1)})`);
});

test("the marks depart from the pool's colour in BOTH directions", () => {
  const LAVA = 0xfd5a02; // tiles/ground_types.json lava.palette.top
  const WALL = 0xa73211; // ...and its wall, the cooled skin
  const lum = (c: number) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
  const dome0 = domeTint(LAVA, 0);
  const dome1 = domeTint(LAVA, 1);
  assert.ok(lum(dome0) > lum(LAVA) + 20, `a new dome is hotter than the pool (${lum(dome0).toFixed(0)} vs ${lum(LAVA).toFixed(0)})`);
  assert.ok(lum(dome1) > lum(dome0), "and hotter still as its skin stretches");
  assert.ok(lum(crustTint(WALL)) < lum(LAVA) - 20, "the crust is cooler and darker than the pool");
  assert.ok(lum(ASH) < lum(WALL), "and ash is darker than the crust");
  // the hot end is a yellow-white, never blue: molten rock has no blue in it
  assert.ok(((HOT >> 16) & 255) >= ((HOT >> 8) & 255) && ((HOT >> 8) & 255) > (HOT & 255), "warm all the way up");
  // mix is a plain channel lerp and stays in gamut
  assert.equal(mix(0x000000, 0xffffff, 0), 0x000000);
  assert.equal(mix(0x000000, 0xffffff, 1), 0xffffff);
  assert.equal(mix(0x000000, 0xffffff, 0.5), 0x808080);
  assert.equal(mix(0xfd5a02, 0xffffff, -5), 0xfd5a02, "clamped");
});
