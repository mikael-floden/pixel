// THE LIGHT-RESOLUTION SLIDER'S CURVE. The dial is a fraction of the canvas the
// three full-screen light passes render at, and its cost is the SQUARE of it,
// so the quantity the maintainer is hunting for — where the field gets too
// coarse to hide — is a RATIO, not a difference. The travel is geometric for
// that reason (maintainer 2026-09-07, after the old 25% floor: "I can't see any
// difference in the game... can you make the slider go even lower just so I can
// see where I can detect it being too low"). Linear travel would bury the whole
// interesting region in the bottom fifth of the track.
//
// These are pure functions; the module's storage/location reads are wrapped and
// fall back to the default under Node, so it imports cleanly here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIGHT_SCALE_MIN,
  LIGHT_SCALE_MAX,
  LIGHT_SCALE_STEPS,
  lightScaleFromSlider,
  sliderFromLightScale,
  snapLightScale,
  lightScaleLabel,
} from "../../client/src/lightscale";

test("the track spans the whole range, ends included", () => {
  assert.equal(lightScaleFromSlider(0), LIGHT_SCALE_MIN);
  assert.equal(lightScaleFromSlider(1), LIGHT_SCALE_MAX);
  // Out-of-range drags clamp rather than extrapolating off the end.
  assert.equal(lightScaleFromSlider(-0.5), LIGHT_SCALE_MIN);
  assert.equal(lightScaleFromSlider(9), LIGHT_SCALE_MAX);
});

test("position and scale round-trip through each other", () => {
  for (let k = 0; k <= LIGHT_SCALE_STEPS; k++) {
    const p = k / LIGHT_SCALE_STEPS;
    const v = lightScaleFromSlider(p);
    assert.ok(
      Math.abs(sliderFromLightScale(v) - p) < 1 / LIGHT_SCALE_STEPS,
      `p=${p} -> ${v} -> ${sliderFromLightScale(v)}`,
    );
  }
});

test("EVERY step is a distinct value — no dead travel", () => {
  // A slider that prints the same number across three positions reads as
  // broken, which is exactly the report this control has to survive.
  const seen = new Set<number>();
  for (let k = 0; k <= LIGHT_SCALE_STEPS; k++) seen.add(lightScaleFromSlider(k / LIGHT_SCALE_STEPS));
  assert.equal(seen.size, LIGHT_SCALE_STEPS + 1, `${LIGHT_SCALE_STEPS + 1} steps collapsed to ${seen.size}`);
  const labels = new Set([...seen].map((v) => lightScaleLabel(v)));
  assert.equal(labels.size, seen.size, "two steps print the same readout");
});

test("steps are a constant RATIO, and the hunt gets half the track", () => {
  const a = lightScaleFromSlider(0);
  const b = lightScaleFromSlider(1 / LIGHT_SCALE_STEPS);
  const c = lightScaleFromSlider(2 / LIGHT_SCALE_STEPS);
  assert.ok(Math.abs(b / a - c / b) < 0.01, `ratios differ: ${b / a} vs ${c / b}`);
  // Half the travel below ~14%: the region worth searching, not a sliver.
  assert.ok(lightScaleFromSlider(0.5) < 0.15, `midpoint is ${lightScaleFromSlider(0.5)}`);
});

test("snapping is idempotent and survives a localStorage round-trip", () => {
  // The value is persisted as a string; a float that re-reads off-grid would
  // drift a step further every reload.
  for (const raw of [0.02, 0.037, 0.25, 0.5, 0.777, 1]) {
    const once = snapLightScale(raw);
    assert.equal(snapLightScale(once), once, `not idempotent at ${raw}`);
    assert.equal(snapLightScale(Number(String(once))), once, `does not survive storage at ${raw}`);
  }
});

test("the readout names the FRAGMENT count, which is the square", () => {
  // 50% reads like half the work and is a quarter of it; that is the whole
  // reason the second number is printed.
  assert.match(lightScaleLabel(0.5), /^50% · 25% of the pixels$/);
  assert.match(lightScaleLabel(1), /full/);
  // Under 10% a whole-percent readout would print several steps identically.
  assert.match(lightScaleLabel(LIGHT_SCALE_MIN), /^2\.0% · 0\.04% of the pixels$/);
});
