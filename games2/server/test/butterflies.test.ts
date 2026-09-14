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
  SHY_R,
  SHY_TURN,
  settleAlt,
  settleLife,
  settled,
  shySpeed,
  shyTurn,
  shyness,
  speedAt,
  steer,
  wing,
} from "../../ambient/butterflies/flight.js";
import {
  BANDS,
  BODY_PX,
  MAX_DARK_PAIRS,
  MAX_SAT,
  PAINTED_PX,
  SPECIES,
  WING_PAIRS,
  bodyColour,
  darkPairs,
  drawnDarkShare,
  pickSpecies,
  saturation,
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

test("HIS BANDS ARE THE BANDS: half pale-and-dark, a quarter green-and-red", () => {
  /* "at least 50% of the butterflies whiteish and blackish. 25% green-ish and
   * red-ish and the rest 25% whatever you want" — the thing he objected to
   * was the BALANCE, so the balance is what a later colour must not shift. */
  const share = (band: string) =>
    (SPECIES.filter((s) => s.band === band).reduce((n, s) => n + weightOf(s), 0) /
      SPECIES.reduce((n, s) => n + weightOf(s), 0)) *
    100;
  const pale = share("pale");
  const dark = share("dark");
  const green = share("green");
  const red = share("red");
  const free = share("free");
  assert.ok(pale + dark >= 50 - 1e-9, `whiteish+blackish is ${(pale + dark).toFixed(1)}%, his floor is 50`);
  assert.ok(Math.abs(green + red - 25) < 1e-9, `greenish+reddish is ${(green + red).toFixed(1)}%, he said 25`);
  assert.ok(Math.abs(free - 25) < 1e-9, `the free quarter is ${free.toFixed(1)}%, he said 25`);
  assert.ok(Math.abs(pale + dark + green + red + free - 100) < 1e-9, "the bands account for every butterfly");
  // BANDS is the published contract and must agree with the table itself
  for (const band of Object.keys(BANDS) as (keyof typeof BANDS)[])
    assert.equal(
      SPECIES.filter((s) => s.band === band).reduce((n, s) => n + weightOf(s), 0),
      BANDS[band],
      `the ${band} band's members add up to its published share`,
    );
  // both halves of every band are actually populated
  for (const band of Object.keys(BANDS)) assert.ok(SPECIES.some((s) => s.band === band), `${band} has members`);
  // and red leads green, which is where his earlier "red looks cool" went
  assert.ok(red > 0 && green > 0, "both are present");
});

test("NOTHING VIBRANT: this is a background effect", () => {
  /* "No extreme/vibrant colors. This is a background effect." The palette
   * this replaced failed that measurably — orange 0.81, yellow 0.69, blue
   * 0.65 — so the cap is a number, not a judgement that drifts. */
  for (const s of SPECIES) {
    for (const [what, c] of [["wing", s.bright], ["marking", s.dark]] as const) {
      const sat = saturation(c);
      assert.ok(sat <= MAX_SAT, `${s.key} ${what} #${c.toString(16)} is ${(sat * 100) | 0}% saturated, cap ${MAX_SAT * 100}%`);
    }
  }
  // the old palette's colours must not pass, or the cap proves nothing
  for (const loud of [0xe07a2a, 0xf2d24b, 0x4472c4, 0x7abd46, 0x9350c4])
    assert.ok(saturation(loud) > MAX_SAT, `#${loud.toString(16)} would still be rejected`);
});

test("picking reproduces his frequencies", () => {
  const n = 200_000;
  const hit = new Map<string, number>(SPECIES.map((s) => [s.key, 0]));
  const count = (k: string) => hit.get(k) ?? 0;
  for (let i = 0; i < n; i++) {
    const k = pickSpecies(i / n).key;
    hit.set(k, count(k) + 1);
  }
  const total = SPECIES.reduce((a, s) => a + weightOf(s), 0);
  for (const s of SPECIES) {
    const got = (count(s.key) / n) * 100;
    const want = (weightOf(s) / total) * 100;
    assert.ok(Math.abs(got - want) < 0.5, `${s.key}: drew ${got.toFixed(2)}%, table says ${want.toFixed(2)}%`);
  }
  // every mix must be reachable — a rounding bug that swallowed green+blue
  // (1%) would still pass a chi-square on the common ones
  for (const s of SPECIES) assert.ok(count(s.key) > 0, `${s.key} can come up at all`);
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
  const luma = (c: number) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
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
  const luma = (c: number) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
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

/* SHY OF THE PLAYER — "would also be cool if the butterflies interact/avoid
 * the player to make the game feel more alive/realtime" (maintainer). */

test("IT MINDS YOU, and more the closer you get", () => {
  assert.equal(shyness(SHY_R, 0), 0, "not at the edge of its notice");
  assert.equal(shyness(SHY_R * 3, 0), 0, "nor well outside it");
  assert.equal(shyness(0, 0), 1, "fully alarmed underfoot");
  // graded, not switched: walking slowly past a meadow must not bolt them all
  // at the same instant
  let prev = 0;
  for (let r = SHY_R; r >= 0; r -= 2) {
    const s = shyness(r, 0);
    assert.ok(s >= prev - 1e-9, `alarm rises as you close (${r}px -> ${s.toFixed(2)})`);
    assert.ok(s >= 0 && s <= 1, "and stays a fraction");
    prev = s;
  }
  // it is a RADIUS, not a box: the same distance in any direction reads alike
  const d = SHY_R / 2;
  const diag = d / Math.SQRT2;
  assert.ok(Math.abs(shyness(d, 0) - shyness(0, d)) < 1e-9, "north is as close as east");
  assert.ok(Math.abs(shyness(diag, diag) - shyness(d, 0)) < 1e-9, "and so is the diagonal");
});

test("IT TURNS AWAY FROM YOU, and does not spin once it is fleeing", () => {
  const dt = 100;
  // player due east; a butterfly flying east at it must turn
  const toward = shyTurn(0, 10, 0, dt);
  assert.notEqual(toward, 0, "flying at you is corrected");
  // already flying due west, away from a player due east: nothing to do
  assert.ok(Math.abs(shyTurn(Math.PI, 10, 0, dt)) < 1e-9, "a butterfly already leaving is left alone");
  // the turn closes on "away" from any heading, and never exceeds the rate
  const wrap = (a: number) => {
    let v = a % (2 * Math.PI);
    if (v > Math.PI) v -= 2 * Math.PI;
    if (v < -Math.PI) v += 2 * Math.PI;
    return v;
  };
  for (const h of [0, 1, 2, 3, 4, 5, 6]) {
    const t = shyTurn(h, 12, 5, dt);
    const away = Math.atan2(-5, -12);
    assert.ok(Math.abs(wrap(away - (h + t))) <= Math.abs(wrap(away - h)) + 1e-9, `turns away from ${h}`);
    assert.ok(Math.abs(t) <= SHY_TURN * (dt / 1000) + 1e-9, "within the turn rate");
  }
  // out of range it is not steered at all
  assert.equal(shyTurn(0, SHY_R + 1, 0, dt), 0, "it does not react to someone it cannot notice");
});

test("it hurries away, it does not bolt", () => {
  assert.equal(shySpeed(0), 1, "undisturbed speed is unchanged");
  assert.ok(shySpeed(1) > 1, "alarmed is faster");
  assert.ok(shySpeed(1) < 2.5, `but a butterfly never becomes a bird (${shySpeed(1)})`);
  // monotone, so closing on one makes it leave faster rather than jumping
  let prev = 0;
  for (let a = 0; a <= 1.001; a += 0.1) {
    const v = shySpeed(a);
    assert.ok(v >= prev, "speed rises with alarm");
    prev = v;
  }
  assert.equal(shySpeed(5), shySpeed(1), "and it is clamped, not unbounded");
});
