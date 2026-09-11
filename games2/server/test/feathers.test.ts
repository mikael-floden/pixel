// FEATHERS — the fall, and the channel the flock speaks through.
//
// What a screenshot cannot judge: that the feather LEANS INTO ITS SLIDE. The
// swing and the tilt come from one sine (the tilt is its derivative), and if
// they ever disagreed the feather would lean the wrong way at every turn and
// read as litter rather than as a feather. That relationship is asserted here
// rather than by eye, along with the bounds nothing else would catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FADE_MS,
  FALL_SPEED,
  LIFT_MS,
  LIFT_PX,
  MAX_ALT,
  TILT_FLAT,
  TILT_LEFT,
  TILT_RIGHT,
  fallen,
  featherAlpha,
  featherAt,
  featherLife,
  height,
  landAt,
  swing,
  tilt,
} from "../../ambient/feathers/fall.js";
import { emitFlush, flushListeners, onFlush } from "../../ambient/runtime/flush.js";

test("THE WINGBEAT LIFTS IT FIRST — a feather from a STANDING bird still falls", () => {
  // The case that was broken: a flushed bird is on the ground, alt0 = 0, and
  // without the kick the feather had nowhere to fall (7 flushes, 9 feathers,
  // 0 of them sank). It must rise, then sink, then land.
  const kick = LIFT_PX[0];
  assert.equal(height(0, 0, kick), 0, "it starts at the bird");
  assert.ok(height(LIFT_MS * 0.5, 0, kick) > 3, "it is already up on the wingbeat");
  assert.ok(Math.abs(height(LIFT_MS, 0, kick) - kick) < 1e-9, "it peaks at the kick");
  assert.ok(height(LIFT_MS + 300, 0, kick) < kick, "then it sinks");
  const land = landAt(0, kick);
  assert.equal(height(land, 0, kick), 0, "and reaches the ground exactly at landAt");
  assert.ok(land > 800, `a feather takes its time (${Math.round(land)} ms)`);
  // it goes UP before it goes down, in the drawn offset too
  const up = featherAt(LIFT_MS * 0.6, 0, kick, 4, 1000, 0);
  assert.ok(up.dy < -2, `the shed feather rises off the bird (dy ${up.dy})`);
  const down = featherAt(land - 50, 0, kick, 4, 1000, 0);
  assert.ok(down.dy > up.dy, "and is lower again by the end");
});

test("it sinks at a steady rate and lands from any altitude", () => {
  assert.equal(fallen(0), 0);
  assert.equal(fallen(1000), FALL_SPEED);
  for (const alt of [0, 4, 12, 25, MAX_ALT]) {
    const kick = LIFT_PX[1];
    const land = landAt(alt, kick);
    assert.ok(Math.abs(height(land, alt, kick)) < 1e-9, `alt ${alt}: on the ground when it lands`);
    assert.ok(land > 200, `alt ${alt}: not an instant drop (${Math.round(land)} ms)`);
  }
  // a bird higher than MAX_ALT is not spooked, and nothing falls forever
  assert.equal(landAt(500, 10), landAt(MAX_ALT, 10));
});

test("THE TILT IS THE SWING'S DERIVATIVE: it leans the way it is sliding", () => {
  for (const period of [800, 1100, 1500])
    for (const phase of [0, 1.1, 2.7, 4.9]) {
      for (let t = 0; t < period * 2; t += 10) {
        const here = swing(t, 7, period, phase);
        const next = swing(t + 40, 7, period, phase);
        const lean = tilt(t, period, phase);
        if (next > here) assert.notEqual(lean, TILT_LEFT, `t=${t}: sliding right, must not lean left`);
        if (next < here) assert.notEqual(lean, TILT_RIGHT, `t=${t}: sliding left, must not lean right`);
      }
    }
});

test("the swing is whole pixels, stays within its amplitude, and turns both ways", () => {
  const amp = 6;
  let lo = 0;
  let hi = 0;
  for (let t = 0; t < 3000; t += 10) {
    const x = swing(t, amp, 1000, 0.4);
    assert.ok(Number.isInteger(x), "whole pixels only");
    assert.ok(Math.abs(x) <= amp, `|${x}| within the amplitude`);
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  assert.ok(lo <= -amp + 1 && hi >= amp - 1, `it swings to both sides (${lo}..${hi})`);
});

test("all three tilt frames are used over a swing", () => {
  const seen = new Set<number>();
  for (let t = 0; t < 1200; t += 10) seen.add(tilt(t, 1000, 0));
  assert.deepEqual([...seen].sort(), [TILT_LEFT, TILT_FLAT, TILT_RIGHT].sort());
});

test("a feather comes to rest on the ground and stops moving there", () => {
  const alt = 24;
  const kick = 12;
  const land = landAt(alt, kick);
  const a = featherAt(land + 5, alt, kick, 5, 1000, 0.3);
  const b = featherAt(land + 900, alt, kick, 5, 1000, 0.3);
  assert.ok(a.down && b.down, "it is down after it lands");
  assert.equal(a.dx, b.dx, "and does not slide about on the ground");
  assert.equal(a.dy, alt, "it rests exactly at the ground point it was shed over");
  assert.equal(a.tilt, TILT_FLAT, "lying flat, not on edge");
  const air = featherAt(land - 50, alt, kick, 5, 1000, 0.3);
  assert.equal(air.down, false);
  assert.ok(air.dy < alt, "still above the ground before it lands");
});

test("it is solid while it falls and lies, then fades out and stays gone", () => {
  const alt = 20;
  const kick = 14;
  const rest = 3000;
  const life = featherLife(alt, kick, rest);
  assert.equal(featherAlpha(-1, alt, kick, rest), 0);
  assert.equal(featherAlpha(0, alt, kick, rest), 1);
  assert.equal(featherAlpha(landAt(alt, kick) + rest, alt, kick, rest), 1, "solid right up to the fade");
  assert.ok(featherAlpha(life - FADE_MS / 2, alt, kick, rest) < 0.6, "half way through the fade it is going");
  assert.equal(featherAlpha(life, alt, kick, rest), 0);
  assert.equal(featherAlpha(life + 5000, alt, kick, rest), 0);
  // monotonic once it starts
  let prev = 1;
  for (let t = life - FADE_MS; t <= life; t += 20) {
    const a = featherAlpha(t, alt, kick, rest);
    assert.ok(a <= prev + 1e-9, "the fade never brightens");
    prev = a;
  }
});

test("the flush channel delivers, unsubscribes, and survives a throwing listener", () => {
  const before = flushListeners();
  const got: number[] = [];
  const offA = onFlush((e) => got.push(e.type));
  const offBad = onFlush(() => {
    throw new Error("an ambient listener blew up");
  });
  assert.equal(flushListeners(), before + 2);
  // the flock must not be taken down by a listener that throws
  assert.doesNotThrow(() => emitFlush({ x: 1, y: 2, gx: 1, gy: 9, alt: 7, type: 3 }));
  assert.deepEqual(got, [3]);
  offBad();
  offA();
  assert.equal(flushListeners(), before);
  // and nothing is delivered after unsubscribing
  emitFlush({ x: 0, y: 0, gx: 0, gy: 0, alt: 0, type: 5 });
  assert.deepEqual(got, [3]);
});
