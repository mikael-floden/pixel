// THE GROUND-DETAILS DIAL (client/src/detailrate.ts): one detail in every N
// field cells, N on a geometric track from every cell to one in ten thousand
// (maintainer 2026-09-12: "make the range here kinda big, both in min and max"),
// snapped to whole cells so "1 in 56" means exactly that. Pure functions; the
// storage read is wrapped, so it imports under Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DETAIL_EVERY_DEFAULT,
  DETAIL_EVERY_MAX,
  DETAIL_EVERY_MIN,
  DETAIL_EVERY_STEPS,
  detailEveryFromSlider,
  detailEveryLabel,
  sliderFromDetailEvery,
  snapDetailEvery,
} from "../../client/src/detailrate";

test("the track spans every cell to one in ten thousand, ends included", () => {
  assert.equal(detailEveryFromSlider(1), DETAIL_EVERY_MIN);
  assert.equal(detailEveryFromSlider(0), DETAIL_EVERY_MAX);
  assert.equal(detailEveryFromSlider(-1), DETAIL_EVERY_MAX);
  assert.equal(detailEveryFromSlider(2), DETAIL_EVERY_MIN);
  assert.equal(DETAIL_EVERY_DEFAULT, 56, "the rate the game always rolled (DETAIL_FREQ)");
});

test("the steps are whole cells, strictly rising down the track, and round-trip", () => {
  let prev = 0;
  for (let k = 0; k <= DETAIL_EVERY_STEPS; k++) {
    const n = detailEveryFromSlider(1 - k / DETAIL_EVERY_STEPS);
    assert.equal(n, Math.round(n));
    assert.ok(n >= prev, `step ${k}: ${n} < ${prev}`);
    prev = n;
    const p = sliderFromDetailEvery(n);
    assert.ok(Math.abs(detailEveryFromSlider(p) - n) <= Math.max(1, n * 0.02), `${n} -> ${p} -> ${detailEveryFromSlider(p)}`);
  }
  assert.equal(snapDetailEvery(56), 56);
  assert.equal(snapDetailEvery(0), DETAIL_EVERY_MIN);
  assert.equal(snapDetailEvery(1e9), DETAIL_EVERY_MAX);
});

test("labels read as he does", () => {
  assert.equal(detailEveryLabel(1), "every cell");
  assert.equal(detailEveryLabel(56), "1 in 56");
  assert.equal(detailEveryLabel(10000), "1 in 10,000");
});
