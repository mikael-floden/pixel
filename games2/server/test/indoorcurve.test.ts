// THE DOORWAY CROSSING'S CURVES (client/src/indoorcurve.ts) — what a screenshot
// cannot assert and a browser gate can only sample: the furniture's opacity
// against the roof's on every point of both crossings, and what one ease bills
// of a frame's wall clock, replayed over the frame lengths his phone's beacon
// records on a cold start.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INDOOR_FLIP_STEP_CAP_MS,
  INDOOR_STEP_CAP_MS,
  aboveCutAlphaOf,
  debrisAlphaOf,
  easeStepMs,
  indoorGradeOf,
  replayCrossing,
  roofedAlphaOf,
} from "../../client/src/indoorcurve.js";

const mixes = Array.from({ length: 101 }, (_, i) => i / 100);

test("entering, the furniture arrives with the room's light: its alpha is the grade at every mix", () => {
  for (const m of mixes) assert.equal(roofedAlphaOf(m, true), indoorGradeOf(m, true), `mix ${m}`);
  assert.equal(indoorGradeOf(2 / 3, true), 1, "the light lands at mix 2/3");
  assert.equal(debrisAlphaOf(1 / 3, true), 0, "the roof is gone by mix 1/3");
});

test("leaving, the furniture is gone when the roof is opaque, and never brighter than the room's light", () => {
  let solidRoofFrames = 0;
  for (const m of mixes) {
    const a = roofedAlphaOf(m, false);
    const d = debrisAlphaOf(m, false);
    const g = indoorGradeOf(m, false);
    assert.ok(a <= g + 1e-12, `mix ${m}: furniture ${a} over the grade ${g}`);
    assert.ok(a <= 1 - d + 1e-12, `mix ${m}: furniture ${a} showing through a roof at ${d}`);
    if (d >= 1) {
      solidRoofFrames++;
      assert.equal(a, 0, `mix ${m}: the roof is solid and a piece of furniture still wears ${a} — his half-transparent table on the roof`);
    }
  }
  assert.ok(solidRoofFrames >= 60, `the roof is solid for the last two thirds of the roll (${solidRoofFrames} of 101 samples)`);
  // The old rule — the grade alone — is what this arm is red on: at mix 1/2 the
  // roof has been solid since mix 2/3 and the grade is still 0.25.
  assert.equal(indoorGradeOf(0.5, false), 0.25);
  assert.equal(debrisAlphaOf(0.5, false), 1);
  assert.equal(roofedAlphaOf(0.5, false), 0);
  // ...and it is still a fade, not a switch: no step of the mix moves it by more than a hundredth per hundredth.
  for (let i = 1; i < mixes.length; i++) {
    const step = Math.abs(roofedAlphaOf(mixes[i], false) - roofedAlphaOf(mixes[i - 1], false));
    assert.ok(step <= 0.031, `mix ${mixes[i]}: a jump of ${step.toFixed(3)} in one hundredth of the roll`);
  }
});

test("what stands on the lid keeps the complement of the grade", () => {
  for (const m of mixes) {
    assert.equal(aboveCutAlphaOf(m, true), 1 - indoorGradeOf(m, true));
    assert.equal(aboveCutAlphaOf(m, false), 1 - indoorGradeOf(m, false));
  }
});

test("one ease bills the frame's wall clock, capped: the flip's own frame at the small cap, every other frame at the large one", () => {
  assert.equal(easeStepMs(490, 2), INDOOR_FLIP_STEP_CAP_MS, "the flip frame's update");
  assert.equal(easeStepMs(490, 1), INDOOR_FLIP_STEP_CAP_MS, "the flip frame's render");
  assert.equal(easeStepMs(300, 0), 300, "a slow frame after the flip bills what it took");
  assert.equal(easeStepMs(3000, 0), INDOOR_STEP_CAP_MS, "a tab wakeup or a GC pause is capped");
  assert.equal(easeStepMs(17, 0), 17);
  assert.equal(easeStepMs(-5, 0), 0, "a clock that ran backwards bills nothing");
  assert.ok(INDOOR_FLIP_STEP_CAP_MS < INDOOR_STEP_CAP_MS);
});

/** His beacon's cold window: the flip frame at 490 ms, three more long frames
 *  while the room's art decodes, then the phone's usual 17 ms. */
const COLD = [490, 300, 300, 300, ...Array.from({ length: 120 }, () => 17)];
/** A slower device, or a colder cache: the flip, then a run of 200 ms frames. */
const SLOW = [490, ...Array.from({ length: 12 }, () => 200), ...Array.from({ length: 120 }, () => 17)];
/** A warm crossing: only the flip frame is long. */
const WARM = [490, ...Array.from({ length: 120 }, () => 17)];

test("a cold start's crossing lands its light with its last long frame; the old rule crawled on after them", () => {
  // The frames bound the crossing: nothing can land before the frame that
  // draws it. On the cold window the light now lands WITH the last long frame
  // (490 + 3 x 300 = 1390 ms) instead of 255 ms of 17 ms frames later.
  const now = replayCrossing(COLD, true);
  const old = replayCrossing(COLD, true, 1, 60);
  assert.equal(now.landedAtMs, 1390, `the light landed ${now.landedAtMs} ms after the flip`);
  assert.ok(old.landedAtMs !== null && old.landedAtMs >= 1600, `the old rule's landing, for the record: ${old.landedAtMs} ms`);
  // The first blended frame is the same picture on both rules: the flip frame
  // itself bills the small cap either way.
  assert.equal(now.mix[0], old.mix[0]);
  // Where the frames stay slow the rule buys a whole second: the light lands
  // at the fourth frame (1090 ms) where the old cap needed the ninth (2090).
  const slow = replayCrossing(SLOW, true);
  const slowOld = replayCrossing(SLOW, true, 1, 60);
  assert.equal(slow.landedAtMs, 1090, `on 200 ms frames the light landed ${slow.landedAtMs} ms after the flip`);
  assert.equal(slowOld.landedAtMs, 2090, `the old rule's landing on 200 ms frames: ${slowOld.landedAtMs} ms`);
  // Leaving is the same story.
  const out = replayCrossing(SLOW, false);
  const outOld = replayCrossing(SLOW, false, 1, 60);
  assert.ok(out.landedAtMs !== null && outOld.landedAtMs !== null && outOld.landedAtMs - out.landedAtMs >= 600, `leaving: ${out.landedAtMs} vs ${outOld.landedAtMs} ms`);
});

test("a warm crossing is untouched: same first frame, the landing within one frame of the old rule", () => {
  const now = replayCrossing(WARM, true);
  const old = replayCrossing(WARM, true, 1, 60);
  assert.equal(now.mix[0], old.mix[0]);
  assert.ok(now.landedAtMs !== null && old.landedAtMs !== null);
  assert.ok(Math.abs(now.landedAtMs - old.landedAtMs) <= 17, `landings ${now.landedAtMs} vs ${old.landedAtMs} ms`);
  // ...and the roof still dissolves over several frames after the flip, not in one.
  let framesWithRoof = 0;
  for (const m of now.mix) if (debrisAlphaOf(m, true) > 0.05) framesWithRoof++;
  assert.ok(framesWithRoof >= 4, `the roof took ${framesWithRoof} blended frames to dissolve`);
});

test("no single frame crosses a whole curve: a three-second stall moves the mix by less than half its remaining distance", () => {
  const stall = replayCrossing([490, 3000], true);
  assert.ok(stall.mix[1] < 0.6, `after a 3 s stall the mix is ${stall.mix[1].toFixed(3)}`);
});
