// DRAGONFLIES — what makes one a dragonfly and not the butterfly beside it.
//
// They share a sky, so the tests here are mostly about the CONTRAST: a
// butterfly bobs, drifts and never stops; a dragonfly is parked, then a
// straight line at speed, then parked again. None of that is judgeable from
// a still, and each has a way of being subtly wrong that still screenshots
// fine.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLUR,
  BODIES,
  DART,
  HOVER,
  JITTER_PX,
  PERCH,
  WING_BLUR,
  WING_OUT,
  dartAt,
  dartMs,
  facing,
  hoverJitter,
  perchAlt,
  wingOf,
} from "../../ambient/dragonflies/dart.js";
import { MAX_SAT, luma, saturation } from "../../ambient/runtime/palette.js";

test("THE DART IS A STRAIGHT LINE AT ONE SPEED — no easing, or it is a bee", () => {
  const ms = 400;
  // equal time steps cover equal distance, the whole way
  const step = (a: number, b: number) => dartAt(b, ms) - dartAt(a, ms);
  const first = step(0, 40);
  for (let t = 0; t + 40 <= ms; t += 40) {
    assert.ok(Math.abs(step(t, t + 40) - first) < 1e-9, `constant speed at ${t}ms`);
  }
  // AND IT ARRIVES AT FULL TILT: the last step is exactly as big as the first.
  // An eased ending is the single thing that would make this read as a bee
  // hovering in, so it is asserted rather than left to the eye.
  assert.ok(Math.abs(step(ms - 40, ms) - first) < 1e-9, "it does not slow into the stop");
});

test("it stops DEAD, and stays stopped", () => {
  assert.equal(dartAt(0, 300), 0);
  assert.equal(dartAt(300, 300), 1);
  assert.equal(dartAt(301, 300), 1, "clamped, not overshooting past its target");
  assert.equal(dartAt(99999, 300), 1);
  assert.equal(dartAt(-5, 300), 0, "and never before it started");
  assert.equal(dartAt(10, 0), 1, "a zero-length dart is simply already over");
});

test("a longer or slower dart takes longer", () => {
  assert.ok(dartMs(100, 200) > dartMs(50, 200), "further takes longer");
  assert.ok(dartMs(100, 100) > dartMs(100, 200), "slower takes longer");
  assert.equal(dartMs(200, 200), 1000, "200 px at 200 px/s is a second");
  assert.ok(Number.isFinite(dartMs(50, 0)), "a zero speed does not divide by zero");
});

test("THE HOVER IS PARKED, not drifting: whole pixels, tiny, and it comes back", () => {
  const seen = new Set<number>();
  let maxX = 0;
  let maxY = 0;
  for (let t = 0; t < 6000; t += 10) {
    const j = hoverJitter(t, 0.3);
    assert.ok(Number.isInteger(j.x) && Number.isInteger(j.y), "whole pixels — a sub-pixel wobble is a blur");
    maxX = Math.max(maxX, Math.abs(j.x));
    maxY = Math.max(maxY, Math.abs(j.y));
    seen.add(j.x);
  }
  assert.ok(maxX <= Math.ceil(JITTER_PX), `it holds its point (max ${maxX} px)`);
  assert.ok(maxY <= Math.ceil(JITTER_PX), `vertically too (max ${maxY} px)`);
  // it must actually move, and both ways, or it is a sprite someone forgot
  assert.ok(seen.has(0), "it passes through its own point");
  assert.ok([...seen].some((v) => v > 0) && [...seen].some((v) => v < 0), "and wobbles either side of it");
  // deterministic: the same age and phase is the same offset, every time
  assert.deepEqual(hoverJitter(1234, 0.7), hoverJitter(1234, 0.7));
  // and two dragonflies do not twitch in unison
  assert.notDeepEqual(hoverJitter(1234, 0.1), hoverJitter(1234, 0.9));
});

test("THE WINGS NEVER FOLD — that is the butterfly, not this", () => {
  assert.equal(wingOf(HOVER), WING_BLUR, "a held hover is still beating");
  assert.equal(wingOf(DART), WING_BLUR, "and a dart certainly is");
  assert.equal(wingOf(PERCH), WING_OUT, "at rest they resolve, held OUT");
  // there is no third state: a dragonfly has nowhere to put folded wings
  assert.equal(new Set([wingOf(HOVER), wingOf(DART), wingOf(PERCH)]).size, 2);
});

test("it faces along its dart and does not spin on noise", () => {
  assert.equal(facing(10, -1), 1, "a move right turns it right");
  assert.equal(facing(-10, 1), -1, "and left, left");
  assert.equal(facing(0, -1), -1, "a still frame keeps the heading it had");
  assert.equal(facing(0.2, 1), 1, "and so does a sub-pixel twitch");
  assert.equal(facing(0.2, -1), -1, "whichever way it was already facing");
});

test("settling onto a reed is straight, and it reaches both ends", () => {
  assert.equal(perchAlt(0, 200, 20, 0), 20, "it starts at cruise");
  assert.equal(perchAlt(200, 200, 20, 0), 0, "and reaches the reed");
  assert.equal(perchAlt(100, 200, 20, 0), 10, "halfway at half time — no easing here either");
  assert.equal(perchAlt(999, 200, 20, 0), 0, "clamped at the end");
  assert.equal(perchAlt(0, 200, 0, 20), 0, "and it lifts off the same way");
  assert.equal(perchAlt(200, 200, 0, 20), 20);
});

test("MUTED, by the domain's cap — a background effect, not a jewel", () => {
  /* Real darters are electric blue and scarlet. His note on the butterflies —
   * "no extreme/vibrant colors, this is a background effect" — was not about
   * butterflies, so these are held to the same number. */
  for (const c of BODIES) {
    assert.ok(saturation(c) <= MAX_SAT, `body #${c.toString(16)} is ${(saturation(c) * 100) | 0}% saturated`);
  }
  assert.ok(saturation(BLUR) <= MAX_SAT, "and so is the wing blur");
  // a real dragonfly's wing is something you see the reeds through: the blur
  // must be PALER than every body it crosses, or it reads as a drawn pair
  for (const c of BODIES) assert.ok(luma(BLUR) > luma(c) + 20, `the blur reads over #${c.toString(16)}`);
  // four tellably different species, not one colour four times
  assert.equal(new Set(BODIES).size, BODIES.length, "the species are distinct");
});
