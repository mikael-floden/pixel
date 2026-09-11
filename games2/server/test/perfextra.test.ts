// THE BEACON'S SMALL INSTRUMENTS (client/src/perfextra.ts): the histogram a
// player feels, the display rate read off the fast frames, the quantiles every
// sample block carries, and the fixed benchmark that is the throttling proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpuScoreMs, frameHist, rafHz, quantiles } from "../../client/src/perfextra";

test("the histogram buckets frames the way they are felt, and the mean is the mean", () => {
  const h = frameHist([10, 16.7, 17, 20, 34, 40, 50, 80, 100, 150, 1000]);
  assert.deepEqual(h, { le17: 3, le34: 2, le50: 2, le100: 2, gt100: 2, mean: +(1517.7 / 11).toFixed(2) });
  assert.deepEqual(frameHist([]), { le17: 0, le34: 0, le50: 0, le100: 0, gt100: 0, mean: 0 });
});

test("rafHz reads the refresh off the FAST frames, not the mean — a stuttering 60 Hz window is still 60", () => {
  const smooth60 = Array.from({ length: 200 }, () => 16.67);
  assert.equal(rafHz(smooth60), 60);
  // A quarter of the frames are hitches: the mean says 40 Hz, the vsync says 60.
  const stutter = smooth60.map((f, i) => (i % 4 === 0 ? 60 : f));
  assert.equal(rafHz(stutter), 60);
  assert.equal(rafHz(Array.from({ length: 200 }, () => 8.33)), 120);
  assert.equal(rafHz(Array.from({ length: 200 }, () => 33.3)), 30, "a tab the browser throttled");
  assert.equal(rafHz([16, 16, 16]), 0, "too few frames to say");
});

test("quantiles are the sample's own, rounded, and empty is zeros", () => {
  const q = quantiles(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.deepEqual(q, { n: 100, p50: 51, p90: 91, p99: 100, max: 100 });
  assert.deepEqual(quantiles([]), { n: 0, p50: 0, p90: 0, p99: 0, max: 0 });
});

test("the cpu benchmark is fixed work that takes real, bounded time", () => {
  // Not a repeatability assertion: under the full suite's load two
  // back-to-back runs differ by whatever the scheduler feels like (measured
  // 3x+), which is exactly the signal the proxy exists to carry, not a bug.
  for (let i = 0; i < 3; i++) {
    const ms = cpuScoreMs();
    assert.ok(ms > 0.02 && ms < 2000, `a run took ${ms} ms`);
  }
});
