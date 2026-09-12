// THE FALL'S SLOW FADES WITH THE NUMBER (maintainer 2026-09-12: "The slowdown
// after a fall is too long. Should only apply when the user hit the ground and
// fade away. Maybe last as long as the dmg number but also fade away"). A
// landing used to go through the hit stagger: SLOW_FACTOR flat for SLOW_MS
// (1.5 s), then full speed in one step. It is now its own factor — the
// stagger's depth the moment the feet are down, fading linearly to 1 over the
// damage number's float — and the 1.5 s stagger stays combat's, where it is
// the escape math. The live landing is measured in falldamage.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fallSlowAt, slowFactorAt, DMG_FLOAT_MS, FALL_SLOW_MS, SLOW_FACTOR, SLOW_MS } from "@nangijala/shared";

test("a landing's slow is the stagger's depth at impact and fades to 1 with the damage number", () => {
  const landed = 10_000;
  assert.equal(FALL_SLOW_MS, DMG_FLOAT_MS, "the slow lasts exactly as long as the number floats");
  assert.equal(fallSlowAt(landed, landed - 1), 1, "nothing before the feet are down — the fall itself is free");
  assert.equal(fallSlowAt(landed, landed), SLOW_FACTOR, "the impact is as deep as a hit");
  assert.ok(
    Math.abs(fallSlowAt(landed, landed + FALL_SLOW_MS / 2) - (SLOW_FACTOR + 1) / 2) < 1e-9,
    "halfway through the float, halfway back",
  );
  assert.equal(fallSlowAt(landed, landed + FALL_SLOW_MS), 1, "gone with the number");
  assert.equal(fallSlowAt(landed, landed + 10 * FALL_SLOW_MS), 1);
  let prev = 0;
  for (let t = 0; t <= FALL_SLOW_MS + 100; t += 10) {
    const f = fallSlowAt(landed, landed + t);
    assert.ok(f >= prev - 1e-12, `monotone at ${t} ms`);
    assert.ok(f >= SLOW_FACTOR && f <= 1, `within [SLOW_FACTOR, 1] at ${t} ms`);
    prev = f;
  }
  // The hit stagger is untouched: flat, and much longer than the float.
  assert.equal(slowFactorAt(landed, landed + FALL_SLOW_MS + 1), SLOW_FACTOR, "a HIT is still staggered past the float");
  assert.equal(slowFactorAt(landed, landed + SLOW_MS), 1);
  assert.ok(SLOW_MS > FALL_SLOW_MS, "the stagger outlasts the fall's slow — the escape math keeps it");
});
