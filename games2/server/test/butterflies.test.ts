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
import {
  BODY_PX,
  PAINTED_PX,
  RARE_LIFT,
  SPECIES,
  MAX_DARK_PAIRS,
  WING_PAIRS,
  bodyColour,
  darkPairs,
  drawnDarkShare,
  pickSpecies,
  weightOf,
} from "../../ambient/butterflies/species.js";

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

/* THE COLOURS ARE THE MAINTAINER'S TABLE (2026-09-11), not a palette I chose.
 * His verdict on the first cut was "I like the effect/animation but not the
 * butterfly color... you made them blue and yellow" — so these tests guard the
 * table itself, which is the part that is his and must not drift. */

test("HIS TABLE IS THE TABLE: the ten mixes, his percentages, his order", () => {
  const want = [
    ["brown_black", 22, 0.3],
    ["black_orange", 18, 0.6],
    ["brown_orange", 15, 0.65],
    ["green_black", 12, 0.3],
    ["yellow_black", 11, 0.4],
    ["blue_black", 8, 0.45],
    ["white_black", 7, 0.25],
    ["red_black", 4, 0.5],
    ["purple_black", 2, 0.4],
    ["green_blue", 1, 0.5],
  ] as const;
  assert.equal(SPECIES.length, want.length, "ten mixes");
  want.forEach(([key, base, darkShare], i) => {
    assert.equal(SPECIES[i].key, key, `row ${i} is ${key}, in his order`);
    assert.equal(SPECIES[i].base, base, `${key} keeps his percentage`);
    assert.equal(SPECIES[i].darkShare, darkShare, `${key} keeps his mix`);
  });
});

test("RED AND PURPLE CARRY THE 1.2x LIFT, and nothing else does", () => {
  assert.equal(RARE_LIFT, 1.2, "his number");
  for (const s of SPECIES) {
    const lifted = s.key === "red_black" || s.key === "purple_black";
    assert.equal(weightOf(s), s.base * (lifted ? RARE_LIFT : 1), `${s.key} weight`);
  }
  // the lift is a nudge, not a promotion: they stay the two rarest of the
  // nine black-paired mixes, or "rare colour you are pleased to see" is lost
  const ranked = [...SPECIES].sort((a, b) => weightOf(b) - weightOf(a)).map((s) => s.key);
  assert.equal(ranked[0], "brown_black", "brown is still the commonest");
  assert.equal(ranked[ranked.length - 1], "green_blue", "green+blue is still the rarest");
  assert.ok(ranked.indexOf("red_black") > ranked.indexOf("white_black"), "red is still rarer than white");
  assert.ok(ranked.indexOf("purple_black") > ranked.indexOf("red_black"), "purple is still rarer than red");
});

test("picking reproduces his frequencies", () => {
  const n = 200_000;
  const hit = new Map(SPECIES.map((s) => [s.key, 0]));
  for (let i = 0; i < n; i++) hit.set(pickSpecies(i / n).key, hit.get(pickSpecies(i / n).key) + 1);
  const total = SPECIES.reduce((a, s) => a + weightOf(s), 0);
  for (const s of SPECIES) {
    const got = (hit.get(s.key) / n) * 100;
    const want = (weightOf(s) / total) * 100;
    assert.ok(Math.abs(got - want) < 0.5, `${s.key}: drew ${got.toFixed(2)}%, table says ${want.toFixed(2)}%`);
  }
  // every mix must be reachable — a rounding bug that swallowed green+blue
  // (1%) would still pass a chi-square on the common ones
  for (const s of SPECIES) assert.ok(hit.get(s.key) > 0, `${s.key} can come up at all`);
  // and the ends of the range are in range
  assert.equal(pickSpecies(0).key, SPECIES[0].key);
  assert.ok(SPECIES.includes(pickSpecies(0.999999)));
  assert.ok(SPECIES.includes(pickSpecies(1)), "1 is clamped, not undefined");
});

test("THE MARKING NEVER EATS THE BUTTERFLY", () => {
  /* His split counts the veins and borders of a real butterfly, and there are
   * no veins at five pixels across: spending 60% of them on black gives a
   * black blob with two orange specks, which is a fly. So the split sets HOW
   * MUCH MARKING and his ORDER is what must survive, not his absolute area. */
  const byShare = [...SPECIES].sort((a, b) => a.darkShare - b.darkShare);
  for (let i = 1; i < byShare.length; i++)
    assert.ok(
      drawnDarkShare(byShare[i]) >= drawnDarkShare(byShare[i - 1]),
      `${byShare[i].key} (his ${byShare[i].darkShare}) is drawn lighter than ${byShare[i - 1].key} (his ${byShare[i - 1].darkShare})`,
    );
  // the ends are distinguishable: his lightest mix is not drawn like his darkest
  assert.ok(drawnDarkShare(byShare[byShare.length - 1]) > drawnDarkShare(byShare[0]), "the range has not collapsed");

  // THE BUTTERFLY'S OWN COLOUR KEEPS THE WINGS. Whatever the mix, most wing
  // pixels are the bright colour — that is what makes it a red butterfly
  // rather than a black one with red on it.
  for (const s of SPECIES) {
    const dark = 2 * darkPairs(s.darkShare);
    assert.ok(dark <= 2 * MAX_DARK_PAIRS, `${s.key} respects the marking cap`);
    assert.ok(10 - dark >= 4, `${s.key}: only ${10 - dark} wing pixels left in its own colour`);
  }
  // the body is always dark, so nothing is ever wholly bright
  for (const s of SPECIES) assert.ok(drawnDarkShare(s) >= BODY_PX / PAINTED_PX, `${s.key} has a dark body`);
  assert.equal(darkPairs(0), 0, "an unmarked mix darkens no pair");
  assert.equal(darkPairs(1), MAX_DARK_PAIRS, "and the heaviest marking stops at the cap");
  assert.ok(MAX_DARK_PAIRS < WING_PAIRS, "the cap is a cap");
});

test("THE BODY JOINS THE WINGS, it is not a bar through them", () => {
  /* Twice now a body painted a flat dark colour has split the creature in two
   * on screen — near-black over grass, then the mix's own black under brown
   * wings. It is blended back toward the wing, so it is the darkest part of
   * the butterfly and still the same creature. */
  const luma = (c) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
  for (const s of SPECIES) {
    const b = bodyColour(s);
    assert.ok(luma(b) < luma(s.bright), `${s.key}: the body is darker than the wing`);
    assert.ok(luma(b) > luma(s.dark) - 1e-9, `${s.key}: the body is no darker than the marking`);
    // and it is genuinely pulled toward the wing, not just the dark colour
    if (s.dark !== s.bright) assert.notEqual(b, s.dark, `${s.key}: the body is not the flat marking colour`);
    /* Close enough to the wing to read as one creature — as a RATIO, not an
     * absolute gap: a white butterfly's body is 108 luma below its wing and
     * looks right, a green one's is 75 below and would not, because what the
     * eye judges is the contrast between them, not the arithmetic. */
    const ratio = luma(b) / luma(s.bright);
    assert.ok(ratio >= 0.4, `${s.key}: the body sits at ${(ratio * 100) | 0}% of the wing's brightness — a hole, not a body`);
    assert.ok(ratio < 1, `${s.key}: and it is still darker`);
  }
});

test("every mix is two TELLABLE colours: the dark one is actually darker", () => {
  const luma = (c) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
  for (const s of SPECIES) {
    assert.notEqual(s.bright, s.dark, `${s.key} is a mix of two colours`);
    assert.ok(luma(s.dark) < luma(s.bright), `${s.key}: the dark half is darker (${luma(s.dark) | 0} vs ${luma(s.bright) | 0})`);
    // and far enough apart to read as a marking rather than a compression
    // artefact at four pixels tall
    assert.ok(luma(s.bright) - luma(s.dark) > 25, `${s.key}: the two halves are ${(luma(s.bright) - luma(s.dark)) | 0} luma apart`);
    // pixel art: never pure black, never pure white
    assert.notEqual(s.dark, 0x000000);
    assert.notEqual(s.bright, 0xffffff);
  }
});
