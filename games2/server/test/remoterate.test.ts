// ============================================================================
// A REMOTE BODY IS CHASED AT THE RATE ITS POSITIONS ARRIVE
// ============================================================================
//
// Maintainer, 2026-09-22: "I still feel the monsters in my own zone to way way
// smoother vs monsters in a neighbouring zone. Do you know why?"
//
// MEASURED, server/test/ghostrate.test.ts: 20 Hz in his own room against
// 2.33 Hz for a ghost of a neighbouring room (that room has no client, so its
// sim is inside the idle gate). One eased constant served both.
//
// ARM 3 IS THE ONE THAT PAYS FOR THE FILE. It simulates the actual chase at 60
// fps against a 2.33 Hz source and counts the frames on which the body is
// EFFECTIVELY STATIONARY while its target has not yet been refreshed — the
// freeze between the glide and the jump. The old constant stalls for a large
// fraction of every interval; the paced rate stalls on none of it. The other
// arms exist so that fix cannot be bought with a regression somewhere else.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trackGap, arrivalHz, remoteChaseRate,
  CHASE_RATE_AT_FULL, FULL_HZ, MIN_HZ, MAX_GAP_MS,
} from "../../client/src/remoterate.js";

/** Run the exponential chase at 60 fps against a source that refreshes every
 *  `intervalMs`, and report what fraction of frames were effectively frozen.
 *  `rateFor` picks the chase rate, so the OLD and NEW rules run the same rig. */
function simulate(intervalMs: number, rateFor: (hz: number) => number, seconds = 4) {
  const dt = 1 / 60;
  const speedWu = 120;            // a walking monster, world units per second
  let target = 0, shown = 0, sinceSample = 0;
  let frozen = 0, frames = 0, maxStep = 0;
  const hz = 1000 / intervalMs;
  const k0 = rateFor(hz);
  for (let t = 0; t < seconds; t += dt) {
    sinceSample += dt * 1000;
    if (sinceSample >= intervalMs) { sinceSample -= intervalMs; target += speedWu * (intervalMs / 1000); }
    const before = shown;
    shown += (target - shown) * Math.min(1, dt * k0);
    const step = shown - before;
    // SKIP THE FIRST SECOND. Before the first sample lands the target has not
    // moved, so a still body is correct, not a stall — counting it charged
    // BOTH rules a flat ~11% and buried the difference being measured.
    if (t < 1) continue;
    frames++;
    if (step > maxStep) maxStep = step;
    // "Frozen" = this frame moved less than a twentieth of what a body
    // travelling at the true speed would have moved. That is the stall the eye
    // reads as a stutter, not a rounding threshold.
    if (step < (speedWu * dt) / 20) frozen++;
  }
  return { frozenPct: (frozen / frames) * 100, maxStep, peakOverMean: maxStep / (speedWu * dt) };
}

test("arm 1: a 20 Hz source comes out at EXACTLY today's constant", () => {
  // The safety property. Everything in his own zone — local monsters, remote
  // players in the same room — is drawn by this path, and none of it may move
  // by a pixel because of this change.
  assert.equal(remoteChaseRate(FULL_HZ), CHASE_RATE_AT_FULL);
  assert.equal(remoteChaseRate(999), CHASE_RATE_AT_FULL, "clamped, never FASTER than today");
  assert.equal(arrivalHz(0), FULL_HZ, "no estimate yet behaves exactly as the old code");
  assert.equal(remoteChaseRate(arrivalHz(1000 / 20)), CHASE_RATE_AT_FULL);
});

test("arm 2: a ghost's measured 2.33 Hz eases proportionally slower", () => {
  const hz = arrivalHz(430);                       // the measured ghost interval
  assert.ok(Math.abs(hz - 2.33) < 0.05, `expected ~2.33 Hz, got ${hz}`);
  const r = remoteChaseRate(hz);
  assert.ok(r > 1.2 && r < 1.6, `expected ~1.4, got ${r}`);
  // tau must EXCEED the arrival interval, which is the whole mechanism: the
  // body is still travelling when the next sample lands, so it never stalls.
  const tauMs = 1000 / r;
  assert.ok(tauMs > 430, `tau ${tauMs.toFixed(0)} ms must outlast the 430 ms interval`);
});

test("arm 3: the stall the maintainer can see — old rule vs new", () => {
  const OLD = () => CHASE_RATE_AT_FULL;            // one constant for everything
  const NEW = (hz: number) => remoteChaseRate(hz);
  const ghostOld = simulate(430, OLD);
  const ghostNew = simulate(430, NEW);
  const localOld = simulate(50, OLD);
  const localNew = simulate(50, NEW);
  console.log(`[remoterate] ghost 2.33Hz  frozen frames: old ${ghostOld.frozenPct.toFixed(1)}%  new ${ghostNew.frozenPct.toFixed(1)}%`);
  console.log(`[remoterate] ghost 2.33Hz  peak/mean step: old ${ghostOld.peakOverMean.toFixed(2)}  new ${ghostNew.peakOverMean.toFixed(2)}`);
  console.log(`[remoterate] local 20Hz    frozen frames: old ${localOld.frozenPct.toFixed(1)}%  new ${localNew.frozenPct.toFixed(1)}%`);

  assert.ok(ghostOld.frozenPct > 10, `the old rule should visibly stall; measured ${ghostOld.frozenPct.toFixed(1)}%`);
  assert.ok(ghostNew.frozenPct < 1, `the paced rate must not stall; measured ${ghostNew.frozenPct.toFixed(1)}%`);
  // ...and the burst it stalls between is a lurch: peak frame step against the
  // mean. Lower is smoother; this is the number the eye actually grades.
  assert.ok(ghostNew.peakOverMean < ghostOld.peakOverMean,
    `new peak/mean ${ghostNew.peakOverMean.toFixed(2)} should beat old ${ghostOld.peakOverMean.toFixed(2)}`);
  // A LOCAL monster is untouched — same rig, same numbers, both rules.
  assert.equal(localNew.frozenPct.toFixed(3), localOld.frozenPct.toFixed(3));
  assert.equal(localNew.maxStep.toFixed(6), localOld.maxStep.toFixed(6));
});

test("arm 4: a ROAM PAUSE is not a sample rate", () => {
  // A monster stands still for MONSTER_ROAM_PAUSE_MS (800-2600 ms) between
  // legs. Folding that silence into the estimate would make it resume at a
  // crawl, which is a worse bug than the one being fixed.
  let gap = 0;
  for (let i = 0; i < 12; i++) gap = trackGap(gap, 50);   // a healthy 20 Hz body
  const healthy = gap;
  assert.ok(Math.abs(healthy - 50) < 1);
  gap = trackGap(gap, 2400);                               // ...then a long pause
  assert.equal(gap, healthy, "a pause longer than MAX_GAP_MS leaves the estimate alone");
  assert.equal(trackGap(gap, MAX_GAP_MS + 1), gap);
  assert.ok(trackGap(gap, MAX_GAP_MS - 1) > gap, "a long-but-plausible interval still counts");
  assert.equal(remoteChaseRate(arrivalHz(gap)), CHASE_RATE_AT_FULL, "it resumes at full pace");
});

test("arm 5: the estimate is bounded at both ends", () => {
  assert.equal(trackGap(0, 0), 0, "no sample, no estimate");
  assert.equal(trackGap(0, -5), 0, "a negative interval is ignored");
  assert.equal(trackGap(0, 120), 120, "the first interval seeds it outright");
  assert.equal(arrivalHz(100000), MIN_HZ, "a very slow source is floored, never zero");
  assert.ok(remoteChaseRate(0) > 0, "the rate is never zero — a body always closes its gap");
  assert.equal(remoteChaseRate(MIN_HZ / 2), remoteChaseRate(MIN_HZ), "clamped below too");
});
