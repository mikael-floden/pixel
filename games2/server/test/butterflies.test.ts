// BUTTERFLIES — what makes the movement a butterfly's rather than a bee's.
//
// None of this is judgeable from a still: the bob, the uneven beat and the
// hard turns ARE the effect, and each of them has a way of being subtly wrong
// that still looks fine in a screenshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOB_PX,
  DRIFT_RAD_S,
  HOME_R,
  HOME_TURN,
  LAND_MS,
  WING_CLOSED,
  WING_HALF,
  WING_OPEN,
  bob,
  homePull,
  settleAlt,
  settleLife,
  settled,
  speedAt,
  steer,
  wing,
} from "../../ambient/butterflies/flight.js";

test("THE BODY BOBS WITH THE BEAT, in whole pixels, always upward", () => {
  const amp = BOB_PX[1];
  let top = 0;
  let bottom = 0;
  const seen = new Set<number>();
  for (let t = 0; t < 1000; t += 5) {
    const b = bob(t, 180, 0.2, amp);
    assert.ok(Number.isInteger(b), `whole pixels (${b})`);
    assert.ok(b <= 0, "the bob lifts the body, never sinks it below the flight line");
    assert.ok(b >= -amp, `within the amplitude (${b})`);
    top = Math.min(top, b);
    bottom = Math.max(bottom, b);
    seen.add(b);
  }
  assert.equal(top, -amp, "it reaches the top of the beat");
  assert.equal(bottom, 0, "and comes back to the line");
  assert.ok(seen.size >= 3, "it passes through the middle rather than snapping between two heights");
});

test("the bob and the wings share one clock", () => {
  // the body is at its highest while the wings are coming up, not at a random
  // offset: one phase drives both, so they can never drift apart
  const period = 200;
  const phase = 0.1;
  let highT = 0;
  let high = 0;
  for (let t = 0; t < period; t += 1) {
    const b = bob(t, period, phase, 4);
    if (b < high) {
      high = b;
      highT = t;
    }
  }
  const atTop = wing(highT, period, phase);
  assert.notEqual(atTop, WING_CLOSED, "the wings are not already shut at the top of the bob");
});

test("THE BEAT IS UNEVEN: open is held longest, shut is brief", () => {
  const n = { [WING_OPEN]: 0, [WING_HALF]: 0, [WING_CLOSED]: 0 } as Record<number, number>;
  for (let t = 0; t < 2000; t += 1) n[wing(t, 200, 0)]++;
  assert.ok(n[WING_OPEN] > n[WING_HALF], "open is held longer than half");
  assert.ok(n[WING_HALF] > n[WING_CLOSED], "and half longer than shut");
  // all three are actually used, or the flutter has no silhouette change
  for (const w of [WING_OPEN, WING_HALF, WING_CLOSED]) assert.ok(n[w] > 0, `frame ${w} is used`);
  // and it is periodic
  assert.equal(wing(0, 200, 0), wing(200, 200, 0));
});

test("the speed pulses with the beat and never stops or bolts", () => {
  const base = 20;
  let lo = Infinity;
  let hi = 0;
  for (let t = 0; t < 600; t += 2) {
    const v = speedAt(base, t, 180, 0.3);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  assert.ok(lo > base * 0.5, `it never nearly stops (${lo.toFixed(1)})`);
  assert.ok(hi < base * 1.6, `and never bolts (${hi.toFixed(1)})`);
  assert.ok(hi - lo > base * 0.3, "but it does pulse");
});

test("A FLICK IS A CHANGE OF MIND, not a curve", () => {
  // between flicks the heading drifts slowly; a flick turns it hard at once
  const drifted = steer(1, 100, 1, 0);
  assert.ok(Math.abs(drifted - 1) <= DRIFT_RAD_S * 0.1 + 1e-9, "the drift is gentle");
  const flicked = steer(1, 100, 0, 1.2);
  assert.ok(Math.abs(flicked - 1) > 1, "a flick is a real turn");
  // drift and flick compose, and nothing wraps or explodes
  assert.ok(Number.isFinite(steer(1, 16, -1, -1.7)));
});

test("a settle goes down, sits with the wings shut, and comes back up", () => {
  const cruise = 24;
  const hold = 1200;
  assert.equal(settleAlt(0, hold, cruise), cruise, "it starts at cruise");
  assert.ok(settleAlt(LAND_MS / 2, hold, cruise) < cruise, "it is on the way down");
  assert.equal(settleAlt(LAND_MS, hold, cruise), 0, "it reaches the ground");
  assert.equal(settleAlt(LAND_MS + hold / 2, hold, cruise), 0, "and stays there");
  assert.ok(settleAlt(LAND_MS + hold + LAND_MS / 2, hold, cruise) > 0, "then lifts");
  assert.equal(settleAlt(settleLife(hold), hold, cruise), cruise, "back to cruise exactly at the end");
  // the wings are shut ONLY while it is actually down
  assert.equal(settled(LAND_MS / 2, hold), false);
  assert.equal(settled(LAND_MS + 10, hold), true);
  assert.equal(settled(LAND_MS + hold + 10, hold), false);
});

test("IT WORKS A PATCH: inside its patch nothing pulls, outside it bends back", () => {
  // inside: a boundary, never a leash — a butterfly in the middle of the
  // meadow must be free to wander wherever the flicks take it
  for (const r of [0, 1, HOME_R - 1, HOME_R]) assert.equal(homePull(0.3, r, 0, 16), 0, `no pull at ${r}`);

  // outside: the turn is toward home and no bigger than the rate allows
  const dt = 100;
  const cap = HOME_TURN * (dt / 1000) + 1e-9;
  // home is due EAST (+x) and it is flying west: the pull must be non-zero
  const west = homePull(Math.PI, HOME_R * 3, 0, dt);
  assert.notEqual(west, 0, "a butterfly far from home and flying away is pulled back");
  assert.ok(Math.abs(west) <= cap, `the pull respects HOME_TURN (${west})`);

  // it closes the angle rather than opening it
  // the shortest way round, signed: JS's % keeps the sign of the left operand,
  // so a plain modulo does NOT normalise a negative angle into the range
  const wrap = (a: number) => {
    let d = a % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };
  const shut = (h: number) => {
    const t = homePull(h, 0, HOME_R * 2, dt); // home due +y
    const gap = (a: number) => Math.abs(wrap(Math.PI / 2 - a));
    return gap(h + t) <= gap(h) + 1e-9;
  };
  for (const h of [0, 1, 2, 3, 4, 5, 6]) assert.ok(shut(h), `the pull turns toward home from ${h}`);

  // and it is proportional: further out pulls harder, up to the cap
  const near = Math.abs(homePull(Math.PI, HOME_R * 1.2, 0, dt));
  const far = Math.abs(homePull(Math.PI, HOME_R * 4, 0, dt));
  assert.ok(far > near, `further out pulls harder (${near.toFixed(4)} -> ${far.toFixed(4)})`);
  assert.ok(far <= cap, "but never past the cap");

  // A BUTTERFLY ALREADY HEADED HOME IS NOT STEERED: the pull is a correction,
  // not a rail, or the flight straightens into a homing missile
  assert.equal(homePull(0, HOME_R * 5, 0, dt), 0, "no turn when it is already pointed at home");
});
