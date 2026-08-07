// Every ambient effect is an OUTDOOR effect (birds, bats, pollen, fireflies,
// leaves, sandstorm, thunder, water glints). The game now lets the player walk
// into a house or cave and cuts the roof away — so the ambience has to stop, or
// it keeps falling through the room.
//
// The stop shipped as a SNAP built as a controller that could fade, because
// the game's in/out crossing was itself a cut and was planned to become a fade.
// THAT DAY CAME (2026-08-07): the game now eases `indoorMix` on INDOOR_TAU and
// the outside world fades to black on it, so the maintainer asked for the
// ambience to fade with it. Two things are worth pinning now:
//   1. the shipped duration MATCHES the game's own crossing — the whole point
//      of the handoff was that the two can never drift apart;
//   2. the fade path actually WORKS, at any injected duration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTDOOR_FADE_MS, OutdoorGain, readIndoor } from "../../ambient/runtime/outdoor.js";

// WorldScene's INDOOR_TAU (seconds) and the roll it drives:
//   game   k = 1 - exp(-dt_s / TAU)
//   here   k = 1 - exp(-(dt_ms / fadeMs) * 3)      =>  fadeMs = 3 * TAU * 1000
const INDOOR_TAU_S = 0.35;

test("ships as a FADE that matches the game's own crossing, frame for frame", () => {
  // Rounded: 3 * 0.35 * 1000 is 1049.9999999999998 in binary floating point,
  // and the constant is written as the integer a human would read.
  assert.equal(OUTDOOR_FADE_MS, Math.round(3 * INDOOR_TAU_S * 1000),
    "the ambient fade must be the game's INDOOR_TAU roll in this class's units");
  // Same flip, same dt, same curve — asserted against the game's formula, so a
  // change to either side that is not mirrored fails here rather than on screen.
  const g = new OutdoorGain();
  let game = 1; // the game's own (1 - indoorMix) for an outside cell
  for (const dt of [16.7, 16.7, 33, 100, 250]) {
    g.step(dt, true);
    game += (0 - game) * (1 - Math.exp(-(dt / 1000) / INDOOR_TAU_S));
    if (Math.abs(game - 0) < 0.005) game = 0;
    assert.ok(Math.abs(g.value - game) < 1e-9, `dt ${dt}: gain ${g.value} vs game ${game}`);
  }
});

test("a fade still LANDS: enough steps and it is fully off, then fully on again", () => {
  const g = new OutdoorGain();
  for (let i = 0; i < 200; i++) g.step(16.7, true);
  assert.equal(g.value, 0, "settles exactly on 0, not asymptotically");
  for (let i = 0; i < 200; i++) g.step(16.7, false);
  assert.equal(g.value, 1, "and exactly on 1 coming back out");
});

test("defaults to OUTDOORS so a missing indoor probe never suppresses ambience", () => {
  // No window at all (node): readIndoor must not throw and must answer "outside".
  assert.equal(readIndoor(), false);
  const g = new OutdoorGain();
  assert.equal(g.step(16, readIndoor()), 1);
});

test("readIndoor is fenced: absent, malformed and THROWING probes all read outdoors", () => {
  const w = globalThis as { window?: unknown };
  const had = "window" in globalThis;
  const prev = w.window;
  try {
    w.window = {};
    assert.equal(readIndoor(), false, "no __ml");
    w.window = { __ml: {} };
    assert.equal(readIndoor(), false, "no indoor probe");
    w.window = { __ml: { indoor: () => ({}) } };
    assert.equal(readIndoor(), false, "probe without the field");
    w.window = { __ml: { indoor: () => null } };
    assert.equal(readIndoor(), false, "probe returning null");
    w.window = { __ml: { indoor: () => { throw new Error("boom"); } } };
    assert.equal(readIndoor(), false, "probe that throws");
    // Only an explicit true counts.
    w.window = { __ml: { indoor: () => ({ indoor: true }) } };
    assert.equal(readIndoor(), true);
    w.window = { __ml: { indoor: () => ({ indoor: false }) } };
    assert.equal(readIndoor(), false);
  } finally {
    if (had) w.window = prev;
    else delete w.window;
  }
});

test("the FADE path works — so turning the snap into a fade really is one constant", () => {
  const g = new OutdoorGain(300);
  assert.equal(g.value, 1);
  // Partway through the crossing the gain must be strictly between the ends —
  // that is the whole property the effects' draw paths were threaded for.
  g.step(50, true);
  assert.ok(g.value > 0 && g.value < 1, `expected a partial gain, got ${g.value}`);
  const mid = g.value;
  g.step(50, true);
  assert.ok(g.value < mid, "should keep falling toward 0");
  // And it must SETTLE exactly, not asymptote (the clamp).
  for (let i = 0; i < 200; i++) g.step(16, true);
  assert.equal(g.value, 0);
  // Symmetric on the way back out.
  g.step(50, false);
  assert.ok(g.value > 0 && g.value < 1, "fades back in too");
  for (let i = 0; i < 200; i++) g.step(16, false);
  assert.equal(g.value, 1);
});

test("a fade is frame-rate independent: same wall time, same gain", () => {
  // Otherwise the crossing would look different on a phone than on a desktop.
  const fine = new OutdoorGain(300);
  const coarse = new OutdoorGain(300);
  for (let t = 0; t < 300; t += 5) fine.step(5, true);
  for (let t = 0; t < 300; t += 50) coarse.step(50, true);
  assert.ok(
    Math.abs(fine.value - coarse.value) < 0.03,
    `frame rate changed the crossing: ${fine.value} vs ${coarse.value}`,
  );
});
