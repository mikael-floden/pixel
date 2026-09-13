// LANDING DUST — what makes a puff read as an impact rather than a firework.
//
// None of this is judgeable from a still: the specks going OUT instead of up,
// stalling instead of sailing, and every one of them ending on the floor are
// the effect, and each has a way of being wrong that still looks fine frozen.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALPHA,
  FALL_V_FULL,
  ISO_SQUASH,
  LIFE_MS,
  SPECKS,
  powerOf,
  puffDone,
  puffLife,
  speckAt,
  speckCount,
} from "../../ambient/dust/puff.js";

const ring = (n: number, t: number, power: number, life: number) =>
  Array.from({ length: n }, (_, i) => speckAt(i, n, t, power, (i * 0.37) % 1, life));

test("THE SPECKS GO OUT, NOT UP — that is what makes it an impact", () => {
  const n = 8;
  const life = puffLife(1);
  const at = ring(n, 160, 1, life);
  const out = Math.max(...at.map((s) => Math.hypot(s.x, s.y / ISO_SQUASH)));
  const up = Math.max(...at.map((s) => s.alt));
  assert.ok(out > up * 2, `the ring is wider than it is tall (out ${out.toFixed(1)}, up ${up.toFixed(1)})`);
  assert.ok(up > 0, "but it does leave the floor");
});

test("THE RING IS ISO: it is a circle on the ground, not a hoop standing up", () => {
  // taken far enough out that every speck has travelled
  const at = ring(16, 300, 1, puffLife(1));
  const wide = Math.max(...at.map((s) => Math.abs(s.x)));
  const tall = Math.max(...at.map((s) => Math.abs(s.y)));
  assert.ok(wide > tall, "wider than tall");
  const ratio = tall / wide;
  assert.ok(
    Math.abs(ratio - ISO_SQUASH) < 0.12,
    `squashed by the ground plane, not by eye (${ratio.toFixed(2)} vs ${ISO_SQUASH.toFixed(2)})`,
  );
});

test("it stalls rather than sailing: drag, not a straight line", () => {
  const life = puffLife(1);
  const d = (t: number) => Math.hypot(speckAt(0, 8, t, 1, 0.5, life).x, speckAt(0, 8, t, 1, 0.5, life).y / ISO_SQUASH);
  const first = d(80) - d(0);
  const later = d(400) - d(320);
  assert.ok(first > 0 && later > 0, "it keeps moving outward the whole time");
  assert.ok(later < first * 0.5, `and slows hard (${first.toFixed(1)} px then ${later.toFixed(1)} px)`);
});

test("EVERY SPECK ENDS ON THE FLOOR IT CAME FROM", () => {
  for (const power of [0, 0.3, 0.7, 1]) {
    const life = puffLife(power);
    for (const s of ring(speckCount(power), life, power, life)) {
      assert.equal(s.alt, 0, `a speck is back on the ground when the puff ends (power ${power})`);
    }
    // and it is never below it at any age
    for (let t = 0; t <= life; t += 10)
      for (const s of ring(6, t, power, life)) assert.ok(s.alt >= 0, `never under the floor (t=${t})`);
  }
});

test("A FALL IS NOT A HOP: one dial drives count, spread and life together", () => {
  assert.equal(powerOf(0), 0, "a hop has no fall speed");
  assert.equal(powerOf(FALL_V_FULL), 1, "and the full drop saturates");
  assert.ok(powerOf(FALL_V_FULL / 2) > 0.4 && powerOf(FALL_V_FULL / 2) < 0.6, "with a straight ramp between");
  assert.equal(powerOf(FALL_V_FULL * 10), 1, "clamped, so a long drop is not a hundred specks");

  const soft = speckCount(0);
  const hard = speckCount(1);
  assert.equal(soft, SPECKS[0]);
  assert.equal(hard, SPECKS[1]);
  assert.ok(hard > soft, "a drop throws more than a hop");
  assert.equal(puffLife(0), LIFE_MS[0]);
  assert.equal(puffLife(1), LIFE_MS[1]);
  assert.ok(puffLife(1) > puffLife(0), "and it hangs longer");
  /* The SPREAD moves with it too, or a heavy landing is just a denser hop —
   * and each is measured at ITS OWN end of life, not at a shared instant. A
   * hop lives 300 ms and a fall 700, so comparing both at t=250 compares
   * their speeds mid-flight (1.27x) rather than how far each actually throws
   * the dust (1.9x), which is the thing that reads. */
  const wide = (p: number) => Math.max(...ring(8, puffLife(p), p, puffLife(p)).map((s) => Math.abs(s.x)));
  assert.ok(wide(1) > wide(0) * 1.6, `a drop throws it further (${wide(0).toFixed(1)} -> ${wide(1).toFixed(1)})`);
});

test("it fades out, never in, and never flashes brighter than it started", () => {
  const life = puffLife(0.5);
  let prev = Infinity;
  for (let t = 0; t <= life; t += 20) {
    const a = speckAt(0, 6, t, 0.5, 0.5, life).alpha;
    assert.ok(a <= ALPHA + 1e-9, `never brighter than its start (${a})`);
    assert.ok(a <= prev + 1e-9, "and only ever dimmer");
    prev = a;
  }
  assert.ok(speckAt(0, 6, life, 0.5, 0.5, life).alpha < 1e-9, "gone by the end");
  assert.equal(puffDone(life, life), true);
  assert.equal(puffDone(life - 1, life), false);
});

test("the ring is EVEN but not a clock face", () => {
  const n = 10;
  const life = puffLife(1);
  const bear = ring(n, 200, 1, life).map((s) => Math.atan2(s.y / ISO_SQUASH, s.x));
  const sorted = [...bear].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((b, i) => b - sorted[i]);
  const even = (Math.PI * 2) / n;
  // every speck has its own sector — no two on top of each other
  assert.ok(Math.min(...gaps) > even * 0.2, "no two specks stack up");
  // but they are not on the exact spokes of a dial
  assert.ok(gaps.some((g) => Math.abs(g - even) > 1e-6), "the ring is nudged off the dial");
});
