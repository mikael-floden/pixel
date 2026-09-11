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
  octantRunDeg,
  screenToWorldVector,
  vectorToDirection,
  STICK_LEAN_DEFAULT,
  OCTANT_HALF_DEG,
} from "@nangijala/shared";

const deg = (v: { ax: number; ay: number }) => (Math.atan2(v.ay, v.ax) * 180) / Math.PI;
/** The screen-frame angle of an 8-way key vector. */
const snapOf = (ax: number, ay: number) => (Math.atan2(ay, ax) * 180) / Math.PI;
/** Shortest signed difference a..b, in (-180, 180]. */
const diff = (a: number, b: number) => ((b - a + 540) % 360) - 180;

test("the dial ships at HIS 0.85, and 0 is still today's snap to the pixel", () => {
  assert.equal(STICK_LEAN_DEFAULT, 0.85, "his number off the slider — not a placeholder");
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
  // …and the shipped default leans nearly all the way: at the sector edge it
  // reaches 0.85 of the half-gap to the neighbour's run heading.
  for (let oct = 0; oct < 8; oct++) {
    const ax = Math.round(Math.cos((oct * Math.PI) / 4));
    const ay = Math.round(Math.sin((oct * Math.PI) / 4));
    const snap = snapOf(ax, ay);
    for (const off of [-OCTANT_HALF_DEG, -9, 9, OCTANT_HALF_DEG]) {
      const full = diff(octantRunDeg(oct), deg(leanHeading(ax, ay, snap + off, 1)));
      const def = diff(octantRunDeg(oct), deg(leanHeading(ax, ay, snap + off, STICK_LEAN_DEFAULT)));
      assert.ok(Math.abs(def - STICK_LEAN_DEFAULT * full) < 1e-9, `octant ${oct} ${off}deg off: the default is ${STICK_LEAN_DEFAULT} of the full lean`);
    }
  }
});

test("1.0 is continuous round the circle, anchored on the octants' REAL run headings", () => {
  // A diagonal press runs the GRID AXIS (23.6deg off horizontal on 32x14),
  // not 45deg — so that is where the finger centred in the sector must run.
  for (let oct = 0; oct < 8; oct++) {
    const ax = Math.round(Math.cos((oct * Math.PI) / 4));
    const ay = Math.round(Math.sin((oct * Math.PI) / 4));
    const snap = snapOf(ax, ay);
    const centred = leanHeading(ax, ay, snap, 1);
    assert.ok(Math.abs(diff(octantRunDeg(oct), deg(centred))) < 1e-9, `octant ${oct}: finger centred runs the octant's own heading`);
    const wKey = screenToWorldVector(ax, ay);
    const wLean = screenToWorldVector(centred.ax, centred.ay);
    assert.ok(Math.hypot(wKey.x - wLean.x, wKey.y - wLean.y) < 1e-6, `octant ${oct}: the same world move as the key press`);
  }
  // Both sides of every sector edge meet, and the run is monotonic in the
  // finger's angle — the "no jump anywhere" that IS "full 360".
  let prev: number | null = null;
  for (let phi = -180; phi < 180; phi += 0.5) {
    const oct = Math.round(phi / 45);
    const ax = Math.round(Math.cos((oct * Math.PI) / 4));
    const ay = Math.round(Math.sin((oct * Math.PI) / 4));
    const h = deg(leanHeading(ax, ay, phi, 1));
    if (prev !== null) {
      const step = diff(prev, h);
      assert.ok(step >= -1e-9 && step < 3, `finger ${phi}deg: run stepped ${step.toFixed(2)}deg`);
    }
    prev = h;
  }
  for (let oct = 0; oct < 8; oct++) {
    const edge = oct * 45 + OCTANT_HALF_DEG;
    const lo = leanHeading(Math.round(Math.cos((oct * Math.PI) / 4)), Math.round(Math.sin((oct * Math.PI) / 4)), edge, 1);
    const n = oct + 1;
    const hi = leanHeading(Math.round(Math.cos((n * Math.PI) / 4)), Math.round(Math.sin((n * Math.PI) / 4)), edge, 1);
    assert.ok(Math.abs(diff(deg(lo), deg(hi))) < 1e-9, `sector edge at ${edge}deg: ${deg(lo).toFixed(2)} vs ${deg(hi).toFixed(2)}`);
  }
});

test("a LEANED heading is never a diagonal press: the grid-axis lock leaves it alone", () => {
  // The bug of 2026-09-11: "both components non-zero" read every lean as a
  // diagonal and snapped a near-north walk onto a grid axis — NE/NW runs
  // while the sprite faced N.
  const key = screenToWorldVector(1, -1); // W+D: locked onto the axis
  assert.ok(Math.abs(key.x) < 1e-9 || Math.abs(key.y) < 1e-9, "an exact diagonal press still locks");
  const lean = leanHeading(0, -1, -80, 1); // N, finger 10deg toward NE
  const w = screenToWorldVector(lean.ax, lean.ay);
  const wN = screenToWorldVector(0, -1);
  const ang = Math.atan2(w.y, w.x) - Math.atan2(wN.y, wN.x);
  assert.ok(Math.abs(ang) > 0.02 && Math.abs(ang) < 0.5, `a leaned N moves a little off N in the world, not onto an axis (${((ang * 180) / Math.PI).toFixed(1)}deg)`);
  assert.ok(Math.abs(w.x) > 1e-3 && Math.abs(w.y) > 1e-3, "and is not axis-locked");
});

test("0.5 gives HALF the lean, on both sides of a threshold — his example", () => {
  // Walking NE on screen is up+right: ax +1, ay -1 (screen y is DOWN). N runs
  // at -90deg; the NE PRESS runs the grid axis, octantRunDeg(7) = -23.6deg.
  // A finger just short of the N/NE threshold sits at about -68deg and snaps
  // to N; one hair past it snaps to NE.
  const N = { ax: 0, ay: -1 };
  const NE = { ax: 1, ay: -1 };
  const neRun = octantRunDeg(7);
  const meet = -90 + 0.5 * diff(-90, neRun); // where both sides meet at 1.0
  // "we can change the direction somewhat to NE": still snapped N, leaning NE.
  const beforeSnap = deg(leanHeading(N.ax, N.ay, -68, 0.5));
  assert.ok(beforeSnap > -90 && beforeSnap < meet, `leaning off N toward NE, got ${beforeSnap.toFixed(1)}deg`);
  // "…and when the threshold is reached and we run NE instead we will run
  // somewhat to N": now snapped NE, leaning back toward N.
  const afterSnap = deg(leanHeading(NE.ax, NE.ay, -67, 0.5));
  assert.ok(afterSnap < neRun && afterSnap > meet, `leaning off NE back toward N, got ${afterSnap.toFixed(1)}deg`);
  // THE TWO HEADINGS STRADDLE THE THRESHOLD AND ARE CLOSER than the raw snap
  // (|-90 - neRun| = 66deg): the snap still happens, it no longer teleports.
  const jump = Math.abs(diff(beforeSnap, afterSnap));
  assert.ok(jump < Math.abs(diff(-90, neRun)) * 0.55, `crossing the threshold jumped ${jump.toFixed(1)}deg`);
  // Half of the full lean, to the degree, either side.
  const fullBefore = deg(leanHeading(N.ax, N.ay, -68, 1));
  const fullAfter = deg(leanHeading(NE.ax, NE.ay, -67, 1));
  assert.ok(Math.abs(diff(-90, beforeSnap) - 0.5 * diff(-90, fullBefore)) < 1e-9, "half the lean off N");
  assert.ok(Math.abs(diff(neRun, afterSnap) - 0.5 * diff(neRun, fullAfter)) < 1e-9, "half the lean off NE");
});

test("THE FACING FOLLOWS THE RUN: the key's octant or the neighbour it leans toward, never a third", () => {
  const OCTS = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
  let checked = 0;
  for (let oct = 0; oct < 8; oct++) {
    const ax = Math.round(Math.cos((oct * Math.PI) / 4));
    const ay = Math.round(Math.sin((oct * Math.PI) / 4));
    const snap = snapOf(ax, ay);
    for (const lean of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1])
      for (let off = -OCTANT_HALF_DEG; off <= OCTANT_HALF_DEG; off += 1.5) {
        const v = leanHeading(ax, ay, snap + off, lean);
        const got = vectorToDirection(v.ax, v.ay);
        const nb = OCTS[(((oct + (off >= 0 ? 1 : -1)) % 8) + 8) % 8];
        assert.ok(got === OCTS[oct] || got === nb, `octant ${oct}, lean ${lean}, ${off.toFixed(1)}deg off faced ${got}`);
        // And always within 22.5deg of where the body goes.
        const faceDeg = OCTS.indexOf(got!) * 45; // +y down: SE is +45
        assert.ok(Math.abs(diff(faceDeg, deg(v))) <= OCTANT_HALF_DEG + 1e-6, `facing ${got} is ${diff(faceDeg, deg(v)).toFixed(1)}deg off the run`);
        checked++;
      }
  }
  assert.ok(checked > 1500, `only ${checked} combinations swept`);
  // At 0 the facing IS the key's octant, every time.
  for (let oct = 0; oct < 8; oct++) {
    const ax = Math.round(Math.cos((oct * Math.PI) / 4));
    const ay = Math.round(Math.sin((oct * Math.PI) / 4));
    for (const off of [-22, 0, 22]) assert.equal(vectorToDirection(...(Object.values(leanHeading(ax, ay, snapOf(ax, ay) + off, 0)) as [number, number])), OCTS[oct]);
  }
  console.log(`stick lean: facing followed the run across ${checked} (octant, dial, bearing) combinations`);
});

test("the residual can never swing into the next octant, however wrong the bearing", () => {
  // The snapped vector arrives from the synthesized KEYS while the bearing is
  // read off the pointer, so a hair of disagreement at a boundary is possible.
  // Clamped, the worst case is "leans to the sector edge".
  for (const bogus of [80, 179, -179, 400, -400]) {
    const v = leanHeading(1, 0, bogus, 1);
    const side = diff(0, bogus) >= 0 ? 1 : -1;
    const most = 0.5 * Math.abs(diff(0, octantRunDeg(side)));
    assert.ok(
      Math.abs(diff(0, deg(v))) <= most + 1e-9,
      `bearing ${bogus} leaned ${deg(v).toFixed(1)}deg off a 0deg snap (at most ${most.toFixed(1)})`,
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
