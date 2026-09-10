// FISH RISES — the geometry and the timeline, pinned.
//
// The two things that would be invisible in a screenshot and wrong forever:
// a ring drawn as a CIRCLE (it must be squashed by the iso projection, or it
// stands up out of the lake like a hoop), and a ring that is not CLOSED (a
// single-axis sweep leaves the top and bottom of a flat ellipse open, which
// reads as two arcs rather than a ripple). Both are asserted here rather than
// judged by eye.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACK_MS,
  FLICK_MS,
  RING_LIFE,
  RING_R0,
  RING_RMAX,
  RING_RY,
  SPLASH_MS,
  SPLASH_N,
  backAlpha,
  ellipsePixels,
  flickAlpha,
  ringAlpha,
  ringBirths,
  ringR,
  riseLife,
  splashAt,
} from "../../ambient/fish/rings.js";

test("a ring is an iso ellipse, not a circle", () => {
  assert.equal(RING_RY, 14 / 32, "the squash is the projection's own dy/dx");
  for (let r = 2; r <= RING_RMAX; r++) {
    const { ry, px } = ellipsePixels(r);
    assert.equal(ry, Math.max(1, Math.round(r * RING_RY)));
    assert.ok(ry < r, `r${r}: an ellipse, flatter than it is wide`);
    // it reaches its extremes on both axes
    assert.ok(px.some(([x, y]) => x === r && y === 0), `r${r}: reaches +x`);
    assert.ok(px.some(([x, y]) => x === -r && y === 0), `r${r}: reaches -x`);
    assert.ok(px.some(([x, y]) => y === ry && Math.abs(x) <= 1), `r${r}: reaches +y`);
    assert.ok(px.some(([x, y]) => y === -ry && Math.abs(x) <= 1), `r${r}: reaches -y`);
    // no pixel outside the ellipse's own box, and none repeated
    assert.equal(new Set(px.map(([x, y]) => `${x},${y}`)).size, px.length, `r${r}: no duplicate pixels`);
    for (const [x, y] of px) assert.ok(Math.abs(x) <= r && Math.abs(y) <= ry, `r${r}: (${x},${y}) inside the box`);
  }
});

test("a ring is CLOSED: every pixel touches the next one round the curve", () => {
  for (let r = 2; r <= RING_RMAX; r++) {
    const { px } = ellipsePixels(r);
    const set = new Set(px.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of px) {
      let n = 0;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          if ((dx || dy) && set.has(`${x + dx},${y + dy}`)) n++;
      assert.ok(n >= 2, `r${r}: (${x},${y}) has ${n} neighbours — the ring is broken there`);
    }
  }
});

test("the ring grows, whole pixel by whole pixel, and never past its reach", () => {
  let prev = -1;
  const seen = new Set<number>();
  for (let age = 0; age <= RING_LIFE; age += 10) {
    const r = ringR(age);
    assert.ok(Number.isInteger(r), `radius ${r} is a whole pixel`);
    assert.ok(r >= prev, `the ring never shrinks (${prev} -> ${r} at ${age} ms)`);
    assert.ok(r >= RING_R0 && r <= RING_RMAX, `radius ${r} within [${RING_R0}, ${RING_RMAX}]`);
    prev = r;
    seen.add(r);
  }
  assert.equal(ringR(0), RING_R0);
  assert.equal(ringR(RING_LIFE), RING_RMAX);
  // a later ring is smaller and fainter than the lead, or nested rings pile up
  for (let k = 1; k < 3; k++) {
    assert.ok(ringR(RING_LIFE, k) < ringR(RING_LIFE, k - 1), `ring ${k} is smaller than ring ${k - 1}`);
    assert.ok(ringAlpha(RING_LIFE * 0.3, k) < ringAlpha(RING_LIFE * 0.3, k - 1), `ring ${k} is fainter`);
    assert.ok(ringR(RING_LIFE, k) >= RING_R0, "and never smaller than the smallest art");
  }
  // it does not jump: every radius between the two ends is actually drawn
  for (let r = RING_R0; r <= RING_RMAX; r++) assert.ok(seen.has(r), `radius ${r} is passed through`);
});

test("a ring fades to nothing and stays there; nothing draws before it is born", () => {
  assert.equal(ringAlpha(-1), 0);
  assert.equal(ringAlpha(RING_LIFE), 0);
  assert.equal(ringAlpha(RING_LIFE + 500), 0);
  assert.ok(ringAlpha(RING_LIFE * 0.1) > 0.5, "it appears as a line rather than fading in");
  let prev = 1;
  for (let age = RING_LIFE * 0.2; age < RING_LIFE; age += 20) {
    const a = ringAlpha(age);
    assert.ok(a <= prev + 1e-9, `alpha never rises after the attack (${prev} -> ${a})`);
    assert.ok(a >= 0 && a <= 1, `alpha ${a} in range`);
    prev = a;
  }
});

test("the fish shows itself briefly, the tail follows the back, and both end", () => {
  assert.equal(backAlpha(-1), 0);
  assert.ok(backAlpha(BACK_MS * 0.3) > 0.5, "the fin is up early in the rise");
  assert.equal(backAlpha(BACK_MS), 0, "and gone after BACK_MS");
  assert.equal(flickAlpha(BACK_MS - 1), 0, "the tail never shows while the fin is up");
  assert.ok(flickAlpha(BACK_MS + 5) > 0.5, "it flicks right after");
  assert.equal(flickAlpha(BACK_MS + FLICK_MS), 0);
});

test("a rise is bounded, and its last ring finishes inside its life", () => {
  for (const splashy of [false, true]) {
    const births = ringBirths(splashy);
    const life = riseLife(splashy);
    assert.ok(births.length >= 2, "a rise leaves more than one ring");
    for (let i = 1; i < births.length; i++) assert.ok(births[i] > births[i - 1], "rings are born in order");
    assert.equal(life, births[births.length - 1] + RING_LIFE);
    // bounded, and short enough that a pool slot turns over: the ripple was
    // lengthened to 1.5 s because at 1 s it was gone before the eye found it
    assert.ok(life <= 2400, `a rise is over quickly (${life} ms)`);
    // every ring is finished by the time the rise is retired
    for (const b of births) assert.equal(ringAlpha(life - b), 0);
  }
  assert.equal(ringBirths(true).length, 3, "a splashy rise leaves the extra ring");
});

test("splash specks go up, come down, and land back near the rise", () => {
  for (let i = 0; i < SPLASH_N; i++) {
    assert.equal(splashAt(i, 0).alive, false, "nothing is thrown before the fish breaks the surface");
    assert.equal(splashAt(i, SPLASH_MS + 100).alive, false, "and it is over");
    let minDy = 0;
    let maxAbsDx = 0;
    for (let age = 60; age < 60 + SPLASH_MS; age += 10) {
      const s = splashAt(i, age);
      assert.ok(s.alive);
      assert.ok(Number.isInteger(s.dx) && Number.isInteger(s.dy), "whole pixels only");
      minDy = Math.min(minDy, s.dy);
      maxAbsDx = Math.max(maxAbsDx, Math.abs(s.dx));
    }
    assert.ok(minDy <= -3, `speck ${i} rises off the surface (peak ${minDy})`);
    assert.ok(maxAbsDx <= 12 && minDy >= -20, `speck ${i} stays near its rise`);
  }
  // they fan out to both sides rather than all going one way
  const late = Array.from({ length: SPLASH_N }, (_, i) => splashAt(i, 60 + SPLASH_MS * 0.8).dx);
  assert.ok(late.some((d) => d > 0) && late.some((d) => d < 0), "the splash fans both ways");
});
