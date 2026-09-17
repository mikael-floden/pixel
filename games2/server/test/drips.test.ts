// CAVE DRIPS — the timeline and the geometry, pinned.
//
// What a screenshot cannot see and would be wrong forever: a drop that glides
// down at one speed (it must accelerate), a ring that is a circle (it must be
// the iso ellipse), a drip point whose phases overlap or leave a gap, an
// "indoor gain" that is anything but the mirror of the outdoor one, and a
// cottage that drips (only a `cave` deck qualifies). All arithmetic, all here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ellipsePixels, RING_RY } from "../../ambient/runtime/ellipse.js";
import {
  FALL_LEVELS,
  FLASH_MS,
  HANG_MS,
  LH,
  PERIOD,
  PERIOD_JITTER,
  RING_R0,
  RING_RMAX,
  SPECK_MS,
  SPECK_N,
  SPLASH_MS,
  fallHeightPx,
  fallMs,
  fallY,
  flashAlpha,
  hangAlpha,
  hangSize,
  indoorGain,
  isCaveDecks,
  nextPeriod,
  phaseAt,
  ringAlpha,
  ringR,
  speckAt,
  timeline,
} from "../../ambient/drips/fall.js";

test("the indoor gain is the outdoor gain's mirror, clamped", () => {
  assert.equal(indoorGain(1), 0, "outdoors: nothing");
  assert.equal(indoorGain(0), 1, "under the roof: everything");
  assert.equal(indoorGain(0.25), 0.75, "mid-crossing: the complement, frame for frame");
  assert.equal(indoorGain(-3), 1);
  assert.equal(indoorGain(7), 0);
});

test("only a cave's slab qualifies — a house ceiling, a bridge, a slab below the floor do not", () => {
  assert.equal(isCaveDecks([{ kind: "cave", level: 12 }], 0), true);
  assert.equal(isCaveDecks([{ kind: "roof", level: 6 }], 0), false, "a cottage that drips is a leak");
  assert.equal(isCaveDecks([{ kind: "bridge", level: 4 }], 0), false);
  assert.equal(isCaveDecks([{ kind: "cave", level: 12 }], 12), false, "the lid you stand ON is not over you");
  assert.equal(isCaveDecks([{ kind: "roof", level: 6 }, { kind: "cave", level: 12 }], 0), true);
  assert.equal(isCaveDecks([], 0), false);
  assert.equal(isCaveDecks(null, 0), false, "no deck data reads as no cave, never as an error");
  assert.equal(isCaveDecks([{ kind: null, level: 3 }], 0), false);
});

test("the fall height is the room's own, in levels x LH, clamped", () => {
  assert.equal(LH, 15, "ISO_GEOMETRY_MAPS3.lh");
  assert.equal(fallHeightPx(6, 0), 6 * LH, "the mud cave: deck bottom 6 over floor 0");
  assert.equal(fallHeightPx(40, 0), FALL_LEVELS[1] * LH, "a mountain's underside does not drop water from off the screen");
  assert.equal(fallHeightPx(1, 0), FALL_LEVELS[0] * LH, "a low room still drips from somewhere");
  assert.equal(fallHeightPx(null, 0), Math.round(((FALL_LEVELS[0] + FALL_LEVELS[1]) / 2) * LH), "no ceiling reported: the clamp's middle");
  assert.equal(fallHeightPx(6, null), Math.round(((FALL_LEVELS[0] + FALL_LEVELS[1]) / 2) * LH));
});

test("a drop ACCELERATES and lands exactly on the floor", () => {
  const h = 90;
  const ms = fallMs(h);
  assert.ok(ms > 300 && ms < 600, `90 px in about half a second, got ${ms.toFixed(0)} ms`);
  let prev = 0;
  let prevStep = 0;
  for (let t = 20; t <= ms; t += 20) {
    const y = fallY(t, h);
    const step = y - prev;
    assert.ok(y >= prev, "never rises");
    assert.ok(step >= prevStep - 1e-9 || y === h, `each step longer than the last (${step.toFixed(2)} after ${prevStep.toFixed(2)})`);
    prev = y;
    prevStep = step;
  }
  assert.equal(fallY(ms, h), h, "on the floor at fallMs");
  assert.equal(fallY(ms + 500, h), h, "and never through it");
  assert.equal(fallY(0, h), 0);
});

test("the hanging drop brightens out of nothing and swells before it lets go", () => {
  const hang = HANG_MS[0];
  assert.equal(hangAlpha(0, hang), 0, "never switched on");
  assert.ok(hangAlpha(hang * 0.25, hang) > 0.3);
  assert.ok(hangAlpha(hang * 0.5, hang) >= hangAlpha(hang * 0.25, hang));
  assert.equal(hangAlpha(hang, hang), 0.9, "holds at its full brightness");
  assert.equal(hangSize(0, hang), 1);
  assert.equal(hangSize(hang * 0.44, hang), 1);
  assert.equal(hangSize(hang * 0.45, hang), 2, "swollen: the tell that it is about to fall");
  assert.equal(hangSize(hang, hang), 2);
});

test("the splash ring is a small iso ellipse at whole-pixel radii, a line that decays", () => {
  assert.equal(RING_RY, 14 / 32, "the squash is the projection's own dy/dx");
  assert.ok(RING_RMAX <= 6, "a drop, not a stone thrown in");
  assert.equal(ringR(0), RING_R0);
  assert.equal(ringR(SPLASH_MS), RING_RMAX);
  let prev = RING_R0;
  for (let a = 0; a <= SPLASH_MS; a += 10) {
    const r = ringR(a);
    assert.equal(r, Math.round(r), "whole pixels only");
    assert.ok(r >= prev, "never shrinks");
    prev = r;
  }
  for (let r = RING_R0 + 1; r <= RING_RMAX; r++) {
    const { ry, px } = ellipsePixels(r);
    assert.ok(ry < r, `r${r}: flatter than it is wide`);
    assert.ok(px.some(([x, y]) => x === r && y === 0) && px.some(([x, y]) => x === -r && y === 0), `r${r}: reaches both x extremes`);
    assert.ok(px.some(([x, y]) => y === ry && Math.abs(x) <= 1) && px.some(([x, y]) => y === -ry && Math.abs(x) <= 1), `r${r}: closed at top and bottom`);
  }
  assert.equal(ringAlpha(-1), 0);
  assert.ok(ringAlpha(SPLASH_MS * 0.12) >= 0.8, "a quick attack: a line, not a fade-in");
  assert.ok(ringAlpha(SPLASH_MS * 0.5) < ringAlpha(SPLASH_MS * 0.15), "then decays");
  assert.equal(ringAlpha(SPLASH_MS), 0, "gone at the end of its life");
});

test("the impact flash and the specks are short and end", () => {
  assert.equal(flashAlpha(0), 1);
  assert.ok(flashAlpha(FLASH_MS / 2) > 0 && flashAlpha(FLASH_MS / 2) < 1);
  assert.equal(flashAlpha(FLASH_MS), 0);
  assert.equal(SPECK_N, 2);
  for (let i = 0; i < SPECK_N; i++) {
    assert.equal(speckAt(i, -1).alive, false);
    assert.equal(speckAt(i, SPECK_MS).alive, false);
    let peak = 0;
    let far = 0;
    for (let a = 0; a < SPECK_MS; a += 10) {
      const s = speckAt(i, a);
      assert.ok(s.alive);
      peak = Math.min(peak, s.dy);
      far = Math.max(far, Math.abs(s.dx));
    }
    assert.ok(peak <= -2, `speck ${i} clears the floor (peak ${peak})`);
    assert.ok(far >= 2, `speck ${i} is thrown aside (${far} px)`);
  }
  const l = speckAt(0, SPECK_MS * 0.6).dx;
  const r = speckAt(1, SPECK_MS * 0.6).dx;
  assert.ok(l * r < 0, "left and right, not both one way");
});

test("one spout's phases meet without gap or overlap, and the period is respected", () => {
  const hang = 1000;
  const h = 90;
  const period = 4000;
  const tl = timeline(hang, h, period);
  assert.equal(tl.fallAt, hang);
  assert.equal(tl.splashAt, hang + fallMs(h));
  assert.equal(tl.doneAt, tl.splashAt + SPLASH_MS);
  assert.equal(tl.nextAt, hang + period, "the next drop forms `period` after this one let go");
  assert.equal(phaseAt(0, tl), "hang");
  assert.equal(phaseAt(hang - 1, tl), "hang");
  assert.equal(phaseAt(hang, tl), "fall");
  assert.equal(phaseAt(tl.splashAt, tl), "splash");
  assert.equal(phaseAt(tl.doneAt, tl), "wait");
  assert.equal(phaseAt(tl.nextAt - 1, tl), "wait");
  // A period too short for the ring's life never cuts the ring short.
  const quick = timeline(hang, h, 10);
  assert.equal(quick.nextAt, quick.doneAt);
});

test("periods are jittered inside their band and hangs stay in theirs", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const p = nextPeriod(rnd);
    assert.ok(p >= PERIOD[0] * 0.74 && p <= PERIOD[1] * 1.26, `period ${p} outside the jittered band`);
    seen.add(p);
  }
  assert.ok(seen.size > 100, "two spouts never lock into step");
  assert.ok(HANG_MS[0] > 0 && HANG_MS[1] > HANG_MS[0]);
});

/* THE DRIP RATE IS THE CYCLE, NOT `PERIOD` — and this is the arm that makes a
 * rate change deliver what it claims.
 *
 * A spout resets at `timeline().nextAt` = `hang + period`, so the gap a player
 * sees is HANG PLUS PERIOD. The band test above is measured against `PERIOD`
 * itself, so it passes whatever `PERIOD` is set to and can never notice a rate
 * that under-delivered; only a test written against the CYCLE can.
 *
 * Maintainer 2026-09-17: "It should drop a bit more often! Maybe 50% more
 * often!" The cycle was 1450 + 4350 = 5800 ms. Scaling `PERIOD` by the naive
 * 1/1.5 would have left 1450 + 2900 = 4350 ms — only 1.33x, because `hang`
 * owns a quarter of the cycle and does not shrink with it. */
const OLD_CYCLE_MS = 5800; // hang 1450 + period 4350, the rate he asked to raise
const ASKED = 1.5;

test("drips land 1.5x as often as they did — measured on the CYCLE", () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  let total = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const hang = HANG_MS[0] + rnd() * (HANG_MS[1] - HANG_MS[0]);
    const h = fallHeightPx(FALL_LEVELS[1], 0);
    total += timeline(hang, h, nextPeriod(rnd)).nextAt;
  }
  const cycle = total / N;
  const faster = OLD_CYCLE_MS / cycle;
  assert.ok(
    Math.abs(faster - ASKED) <= 0.04,
    `asked for ${ASKED}x as often, got ${faster.toFixed(3)}x (cycle ${cycle.toFixed(0)} ms)`,
  );
});

test("the period still GOVERNS the rate — it never sinks under the fall+splash floor", () => {
  // `nextAt` takes max(doneAt, hang + period). Once a period drops below
  // fallMs(h) + SPLASH_MS the cycle stops shortening with it, and the rate
  // silently stops responding to the dial. The tallest fall is the tight case.
  const tallest = fallHeightPx(FALL_LEVELS[1], 0);
  const floor = fallMs(tallest) + SPLASH_MS;
  const minJittered = PERIOD[0] * (1 - PERIOD_JITTER);
  assert.ok(
    minJittered > floor,
    `the shortest period ${minJittered.toFixed(0)} ms is under the ${floor.toFixed(0)} ms floor — the dial has stopped working`,
  );
});

test("the swell he likes is untouched: rate was bought from the wait, not the hang", () => {
  // Shortening HANG_MS would raise the rate too, by making the drop let go
  // sooner — a different LOOK, which is not what he asked for.
  assert.deepEqual(HANG_MS, [700, 2200]);
});
