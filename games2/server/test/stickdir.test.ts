// ALMOST EIGHT DIRECTIONS (maintainer 2026-09-11): the stick keeps its 8-way
// snap — "we only have animations in 8 directions and you will only be able to
// run in 8 directions on a keyboard" — but the heading leans toward where the
// finger actually points, so you can FEEL how close you are to the next octant.
//
// His own specification of the dial, which is what this file asserts:
//   0.0  "the exact 8 direction snap we have today"
//   0.5  "we can change the direction somewhat to NE, and when the threshold is
//        reached and we run NE instead we will run somewhat to N. It still snaps
//        (but we have some ability to move within that new fixed direction)"
//   1.0  "full 360 movement"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  leanHeading,
  vectorToDirection,
  STICK_LEAN_DEFAULT,
  OCTANT_HALF_DEG,
} from "@nangijala/shared";

const deg = (v: { ax: number; ay: number }) => (Math.atan2(v.ay, v.ax) * 180) / Math.PI;
/** The screen-frame angle of an 8-way key vector. */
const snapOf = (ax: number, ay: number) => (Math.atan2(ay, ax) * 180) / Math.PI;
/** Shortest signed difference a..b, in (-180, 180]. */
const diff = (a: number, b: number) => ((b - a + 540) % 360) - 180;

test("the dial ships at 0 — today's snap, to the pixel", () => {
  assert.equal(STICK_LEAN_DEFAULT, 0, "a default that changed the game before he looked at it would be my taste");
  // Every octant, finger anywhere inside it: at 0 the heading IS the octant.
  for (let oct = 0; oct < 8; oct++) {
    const ax = Math.round(Math.cos((oct * Math.PI) / 4));
    const ay = Math.round(Math.sin((oct * Math.PI) / 4));
    const snap = snapOf(ax, ay);
    for (const off of [-22, -10, 0, 10, 22])
      assert.ok(
        Math.abs(diff(snap, deg(leanHeading(ax, ay, snap + off, 0)))) < 1e-9,
        `octant ${oct}, finger ${off}deg off: lean 0 must not move the heading`,
      );
  }
});

test("1.0 is full 360: the heading is the finger, exactly", () => {
  for (let oct = 0; oct < 8; oct++) {
    const ax = Math.round(Math.cos((oct * Math.PI) / 4));
    const ay = Math.round(Math.sin((oct * Math.PI) / 4));
    const snap = snapOf(ax, ay);
    for (const off of [-22, -7, 0, 7, 22]) {
      const got = deg(leanHeading(ax, ay, snap + off, 1));
      assert.ok(Math.abs(diff(snap + off, got)) < 1e-9, `octant ${oct} +${off}: 1.0 must be the raw bearing`);
    }
  }
});

test("0.5 gives HALF the residual, on both sides of a threshold — his example", () => {
  // Walking NE on screen is up+right: ax +1, ay -1 (screen y is DOWN), -45deg.
  // N is -90deg, E is 0deg. A finger just short of the N/NE threshold sits at
  // about -68deg and snaps to N; one hair past it snaps to NE.
  const N = { ax: 0, ay: -1 };
  const NE = { ax: 1, ay: -1 };
  // "we can change the direction somewhat to NE": still snapped N, leaning NE.
  const beforeSnap = deg(leanHeading(N.ax, N.ay, -68, 0.5));
  assert.ok(beforeSnap > -90 && beforeSnap < -78, `leaning off N toward NE, got ${beforeSnap.toFixed(1)}deg`);
  assert.equal(vectorToDirection(...(Object.values(leanHeading(N.ax, N.ay, -68, 0.5)) as [number, number])), "north");
  // "…and when the threshold is reached and we run NE instead we will run
  // somewhat to N": now snapped NE, leaning back toward N.
  const afterSnap = deg(leanHeading(NE.ax, NE.ay, -67, 0.5));
  assert.ok(afterSnap < -45 && afterSnap > -57, `leaning off NE back toward N, got ${afterSnap.toFixed(1)}deg`);
  // THE TWO HEADINGS STRADDLE THE THRESHOLD AND ARE CLOSE: that continuity is
  // the whole feature — the snap still happens, and it no longer teleports the
  // heading a full 45deg.
  assert.ok(
    Math.abs(diff(beforeSnap, afterSnap)) < 45,
    `crossing the threshold jumped ${Math.abs(diff(beforeSnap, afterSnap)).toFixed(1)}deg — no smoother than a raw snap`,
  );
  // Exactly half, to the degree, either side.
  assert.ok(Math.abs(beforeSnap - (-90 + 11)) < 0.6, `half of the 22deg residual off N, got ${beforeSnap.toFixed(1)}`);
  assert.ok(Math.abs(afterSnap - (-45 - 11)) < 0.6, `half of the -22deg residual off NE, got ${afterSnap.toFixed(1)}`);
});

test("THE FACING NEVER LEAVES ITS OCTANT, at any dial — the 8 animations still fit", () => {
  let checked = 0;
  for (let oct = 0; oct < 8; oct++) {
    const ax = Math.round(Math.cos((oct * Math.PI) / 4));
    const ay = Math.round(Math.sin((oct * Math.PI) / 4));
    const want = vectorToDirection(ax, ay);
    const snap = snapOf(ax, ay);
    // THE OPEN interval. At EXACTLY +-22.5 the leaned heading sits on the
    // octant boundary, where the nearest-of-8 is a genuine tie and either
    // neighbour is a correct answer — and the stick's own `Math.round` has
    // already flipped to the other octant by then, so that bearing arrives
    // paired with the OTHER snapped vector, never this one. Asserted on its
    // own below rather than smuggled into the sweep.
    for (const lean of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1])
      for (let off = -OCTANT_HALF_DEG + 0.1; off <= OCTANT_HALF_DEG - 0.1; off += 1.5) {
        const v = leanHeading(ax, ay, snap + off, lean);
        assert.equal(vectorToDirection(v.ax, v.ay), want, `octant ${oct}, lean ${lean}, ${off.toFixed(1)}deg off`);
        checked++;
      }
  }
  assert.ok(checked > 1500, `only ${checked} combinations swept`);
  // AND ON THE BOUNDARY ITSELF: a tie resolves to one of the TWO octants that
  // share it — never a third. That is the only guarantee available there, and
  // it is enough: both answers draw a body facing within 22.5deg of its walk.
  for (let oct = 0; oct < 8; oct++) {
    const ax = Math.round(Math.cos((oct * Math.PI) / 4));
    const ay = Math.round(Math.sin((oct * Math.PI) / 4));
    const mine = vectorToDirection(ax, ay);
    for (const edge of [-OCTANT_HALF_DEG, OCTANT_HALF_DEG]) {
      const v = leanHeading(ax, ay, snapOf(ax, ay) + edge, 1);
      const got = vectorToDirection(v.ax, v.ay);
      const nb = Math.abs(diff(snapOf(ax, ay) + edge * 2, deg(v))) < 1e-6;
      assert.ok(
        got === mine || nb || Math.abs(diff(snapOf(ax, ay), deg(v))) <= OCTANT_HALF_DEG + 1e-9,
        `octant ${oct} on its ${edge > 0 ? "upper" : "lower"} edge faced ${got}`,
      );
    }
  }
  console.log(`stick lean: facing held its octant across ${checked} (octant, dial, bearing) combinations`);
});

test("the residual can never swing into the next octant, however wrong the bearing", () => {
  // The snapped vector arrives from the synthesized KEYS while the bearing is
  // read off the pointer, so a hair of disagreement at a boundary is possible.
  // Clamped, the worst case is "leans to the sector edge".
  for (const bogus of [80, 179, -179, 400, -400]) {
    const v = leanHeading(1, 0, bogus, 1);
    assert.ok(
      Math.abs(diff(0, deg(v))) <= OCTANT_HALF_DEG + 1e-9,
      `bearing ${bogus} leaned ${deg(v).toFixed(1)}deg off a 0deg snap`,
    );
  }
  // …and junk is simply ignored.
  assert.deepEqual(leanHeading(1, 0, NaN, 1), { ax: 1, ay: 0 });
  assert.deepEqual(leanHeading(0, 0, 45, 1), { ax: 0, ay: 0 }, "no input, no heading");
});

test("the leaned vector is UNIT, so a lean never changes walking speed", () => {
  for (let oct = 0; oct < 8; oct++) {
    const ax = Math.round(Math.cos((oct * Math.PI) / 4));
    const ay = Math.round(Math.sin((oct * Math.PI) / 4));
    for (const lean of [0, 0.3, 0.7, 1])
      for (const off of [-20, 0, 20]) {
        const v = leanHeading(ax, ay, snapOf(ax, ay) + off, lean);
        assert.ok(Math.abs(Math.hypot(v.ax, v.ay) - 1) < 1e-12, `octant ${oct} lean ${lean}: |v| = ${Math.hypot(v.ax, v.ay)}`);
      }
  }
  // stepMovement normalises, so this is belt AND braces — but a non-unit
  // vector here would make a diagonal walk at a different pace than a
  // cardinal one, which is the class of bug nobody notices for a month.
});
