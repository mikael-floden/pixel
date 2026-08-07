// Every ambient effect is an OUTDOOR effect (birds, bats, pollen, fireflies,
// leaves, sandstorm, thunder, water glints). The game now lets the player walk
// into a house or cave and cuts the roof away — so the ambience has to stop, or
// it keeps falling through the room.
//
// The maintainer asked for the stop to be IMMEDIATE but built as a controller
// that could fade, because the in/out crossing itself is planned to become a
// fade. That makes two things worth pinning:
//   1. the shipped behaviour really is a hard 1 -> 0 (no fade snuck in);
//   2. the fade path actually WORKS — otherwise "flip one constant" is an
//      untested promise that only gets discovered on the day someone flips it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTDOOR_FADE_MS, OutdoorGain, readIndoor } from "../../ambient/runtime/outdoor.js";

test("ships as a SNAP: one step indoors is fully off, whatever the frame time", () => {
  assert.equal(OUTDOOR_FADE_MS, 0, "shipped crossing is a cut, not a fade");
  for (const dt of [1, 16.7, 100, 500]) {
    const g = new OutdoorGain();
    assert.equal(g.value, 1, "starts outdoors");
    assert.equal(g.step(dt, true), 0, `dt ${dt}: should be off after one step`);
    assert.equal(g.step(dt, false), 1, `dt ${dt}: should be back on after one step`);
  }
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
