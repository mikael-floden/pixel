// THE RESOLUTION DIAL'S STEPS AND LABELS (client/src/resolution.ts). The slider
// is a list of fractions of the device's backing — 1, 2/3, 1/2, 1/3, 1/4, 1/8
// (maintainer 2026-09-12: the halvings, then "add a 2/3 and 1/3 resolution …
// it still gives the user more options") — and the readout names each as the
// fraction and the pixels it means, in the same units the light dial uses.
// Pure functions; the module's storage read is wrapped, so it imports under Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RENDER_RES_STEPS,
  fractionText,
  renderResFromSlider,
  resFractionLabel,
  setFullBacking,
  sliderFromRenderRes,
  snapRenderRes,
} from "../../client/src/resolution";

test("the steps are the six fractions, full first, strictly falling", () => {
  assert.deepEqual([...RENDER_RES_STEPS], [1, 2 / 3, 0.5, 1 / 3, 0.25, 0.125]);
  for (let i = 1; i < RENDER_RES_STEPS.length; i++) assert.ok(RENDER_RES_STEPS[i] < RENDER_RES_STEPS[i - 1]);
});

test("the slider's top is full resolution and every stop round-trips", () => {
  assert.equal(renderResFromSlider(1), 1);
  assert.equal(renderResFromSlider(0), 0.125);
  for (const s of RENDER_RES_STEPS) assert.equal(renderResFromSlider(sliderFromRenderRes(s)), s);
  // A stored value off the grid snaps to the nearest step.
  assert.equal(snapRenderRes(0.7), 2 / 3);
  assert.equal(snapRenderRes(0.3), 1 / 3);
  assert.equal(snapRenderRes(3), 1);
});

test("labels name the fraction the way he asked for it", () => {
  assert.equal(fractionText(1), "1/1");
  assert.equal(fractionText(2 / 3), "2/3");
  assert.equal(fractionText(0.5), "1/2");
  assert.equal(fractionText(1 / 3), "1/3");
  assert.equal(fractionText(0.25), "1/4");
  assert.equal(fractionText(0.125), "1/8");
  // The light dial's products: a whole reciprocal stays whole, the rest get
  // one decimal, and a third of two thirds is a third again.
  assert.equal(fractionText(0.02), "1/50");
  assert.equal(fractionText(0.37), "1/2.7");
  assert.equal(fractionText((2 / 3) * 0.5), "1/3");
  setFullBacking(1079, 1404);
  assert.equal(resFractionLabel(2 / 3), "2/3 719×936");
  assert.equal(resFractionLabel(1 / 3), "1/3 360×468");
  assert.equal(resFractionLabel(0.5), "1/2 540×702");
});
