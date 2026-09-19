// THE RELOCATION VEIL'S VERDICT (client/src/relocatehold.ts): when the loading
// screen a respawn raises may come down, as arithmetic. The scene feeds it the
// boot hold's own inputs; verify-respawnveil.mjs drives the whole thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  relocateVerdict,
  relocateProgress,
  RELOCATE_SETTLE_MS,
  RELOCATE_SOFT_MS,
  RELOCATE_HARD_MS,
  RELOCATE_JUMP_WAIT_MS,
  RELOCATE_VEIL_IN_MS,
  RELOCATE_ARRIVE_GRACE_MS,
} from "../../client/src/relocatehold";

const base = { askedAt: 1000, arrivedAt: 1600, painted: true, ready: true, readySince: 0 };

test("the ask waits for the black: the veil-in delay is longer than loading.ts's 0.4 s fade", () => {
  assert.ok(RELOCATE_VEIL_IN_MS >= 400, `the body must not move under a half-faded screen: ${RELOCATE_VEIL_IN_MS}`);
});

test("the grace for a body that did not need to move: past the veil-in and a round trip, well inside the no-answer backstop", () => {
  assert.ok(RELOCATE_ARRIVE_GRACE_MS > RELOCATE_VEIL_IN_MS + 500, `the grace must outlast the veil-in and a slow round trip: ${RELOCATE_ARRIVE_GRACE_MS}`);
  assert.ok(RELOCATE_ARRIVE_GRACE_MS < RELOCATE_JUMP_WAIT_MS / 2, "a living respawn at the spawn must not sit behind the veil until the backstop");
});

test("nothing lifts before the server's answer has landed — and a refused ask does not trap anyone", () => {
  const waiting = relocateVerdict({ ...base, arrivedAt: 0, now: 1000 + RELOCATE_JUMP_WAIT_MS - 1 });
  assert.equal(waiting.done, false);
  const gaveUp = relocateVerdict({ ...base, arrivedAt: 0, now: 1000 + RELOCATE_JUMP_WAIT_MS });
  assert.deepEqual([gaveUp.done, gaveUp.why], [true, "nojump"]);
});

test("ready must HOLD for the settle, and only painted-and-ready counts as ready", () => {
  // The first ready sample starts the clock; the settle has not passed.
  const first = relocateVerdict({ ...base, now: 2000 });
  assert.equal(first.done, false);
  assert.equal(first.readySince, 2000, "the clock starts on the first painted-and-ready sample");
  // Ready but NOT painted: the clock does not run — a pre-latch sample right
  // after the arrival reads idle before the repaint has even been requested
  // (the scene reports painted=true at once when the body did not move).
  const unpainted = relocateVerdict({ ...base, painted: false, now: 2000 });
  assert.equal(unpainted.readySince, 0);
  // A not-ready sample resets it.
  const reset = relocateVerdict({ ...base, ready: false, readySince: 2000, now: 2300 });
  assert.equal(reset.readySince, 0);
  // Held long enough: ready.
  const held = relocateVerdict({ ...base, readySince: 2000, now: 2000 + RELOCATE_SETTLE_MS });
  assert.deepEqual([held.done, held.why], [true, "ready"]);
  const almost = relocateVerdict({ ...base, readySince: 2000, now: 2000 + RELOCATE_SETTLE_MS - 1 });
  assert.equal(almost.done, false);
});

test("the soft deadline needs a painted ground; the hard one is the backstop", () => {
  const soft = relocateVerdict({ ...base, ready: false, now: 1600 + RELOCATE_SOFT_MS });
  assert.deepEqual([soft.done, soft.why], [true, "soft"]);
  const softUnpainted = relocateVerdict({ ...base, painted: false, ready: false, now: 1600 + RELOCATE_SOFT_MS });
  assert.equal(softUnpainted.done, false, "nothing painted: the soft deadline may not release onto a black world");
  const hard = relocateVerdict({ ...base, painted: false, ready: false, now: 1600 + RELOCATE_HARD_MS });
  assert.deepEqual([hard.done, hard.why], [true, "hard"]);
  assert.ok(RELOCATE_SOFT_MS < RELOCATE_HARD_MS);
});

test("a page that is unloading lifts at once", () => {
  assert.equal(relocateVerdict({ ...base, arrivedAt: 0, now: 1001, unloading: true }).why, "unloading");
});

test("the bar: a sliver before the answer, a third after it, then the streaming fraction, clamped", () => {
  assert.equal(relocateProgress({ arrived: false, want: 0, have: 0 }), 0.15);
  assert.equal(relocateProgress({ arrived: true, want: 0, have: 0 }), 0.95, "nothing to stream is fully streamed");
  assert.equal(relocateProgress({ arrived: true, want: 10, have: 0 }), 0.35);
  assert.equal(relocateProgress({ arrived: true, want: 10, have: 5 }), 0.65);
  assert.equal(relocateProgress({ arrived: true, want: 10, have: 30 }), 0.95, "landed past asked (a denominator that shrank) is clamped");
});
