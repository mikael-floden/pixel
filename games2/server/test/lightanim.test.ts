// A CLIP'S LIGHT SWING IS BOUNDED AND EASED, WHATEVER THE DIAL
// (client/src/lightanim.ts). Maintainer 2026-09-17, the house at the hearth:
// the wall hanging beside the fire snapped bright/dark with the flame clip —
// "a real fire can't flip the light on a wall scenery this much".
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundLightFrame, easeLightFrame, atLightRest, LIGHT_FRAME_REST, LIGHT_ANIM_I_MIN, LIGHT_ANIM_I_MAX, LIGHT_ANIM_POS_MAX } from "../../client/src/lightframe.js";
const LIGHT_ANIM_DEFAULT = { intensity: 0.3, position: 0.12 }; // lightanim.ts's default, restated (that module owns the DOM dials)

test("the dial at its top cannot put the light out or double it", () => {
  const top = { intensity: 20, position: 20 };
  // A hearth's real frames: 0.85..1.25 (hearth_001 LIT_2/LIT_3).
  for (const f of [0.67, 0.85, 0.96, 1.0, 1.07, 1.15, 1.25]) {
    const t = boundLightFrame(f, 0, 0, top);
    assert.ok(t.i >= LIGHT_ANIM_I_MIN && t.i <= LIGHT_ANIM_I_MAX, `frame ${f} at 20x gives ${t.i}`);
  }
  assert.equal(boundLightFrame(0.85, 0, 0, top).i, LIGHT_ANIM_I_MIN, "a dim frame at 20x rests on the floor, not at 0.05");
  const off = boundLightFrame(1, 3, -2, top);
  assert.ok(Math.abs(off.dcol) <= LIGHT_ANIM_POS_MAX && Math.abs(off.drow) <= LIGHT_ANIM_POS_MAX, "the centre offset is bounded");
});

test("the default dial keeps its gentle swing", () => {
  const t = boundLightFrame(0.85, 0.5, 0, LIGHT_ANIM_DEFAULT);
  assert.ok(Math.abs(t.i - (1 - 0.15 * LIGHT_ANIM_DEFAULT.intensity)) < 1e-9, "inside the bound the dial applies as before");
  assert.ok(Math.abs(t.dcol - 0.5 * LIGHT_ANIM_DEFAULT.position) < 1e-9);
});

test("a frame step eases in, never snaps, and the clip's end eases back to rest", () => {
  const target = { i: LIGHT_ANIM_I_MAX, dcol: 0.3, drow: -0.3 };
  const one = easeLightFrame(LIGHT_FRAME_REST, target, 16);
  assert.ok(one.i > 1 && one.i < 1 + (target.i - 1) * 0.3, `one 16 ms frame moves part of the way (${one.i.toFixed(3)})`);
  let s = LIGHT_FRAME_REST;
  for (let k = 0; k < 30; k++) s = easeLightFrame(s, target, 16);
  assert.ok(Math.abs(s.i - target.i) < 0.02, "and lands within half a second");
  for (let k = 0; k < 40; k++) s = easeLightFrame(s, LIGHT_FRAME_REST, 16);
  assert.ok(atLightRest(s), `back at rest after the clip (${JSON.stringify(s)})`);
  assert.equal(easeLightFrame(LIGHT_FRAME_REST, target, 0).i, 1, "no time, no move");
});
