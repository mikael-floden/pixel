import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveEmissive, lightKindOf, lightParams } from "../../client/src/scenerylights.js";

const W = 16, H = 24;
const frame = () => ({ w: W, h: H, data: new Uint8ClampedArray(W * H * 4) });
const put = (f: { w: number; data: Uint8ClampedArray }, x: number, y: number, r: number, g: number, b: number) => { const i = (y * f.w + x) * 4; f.data[i] = r; f.data[i + 1] = g; f.data[i + 2] = b; f.data[i + 3] = 255; };
// a dark post 2px wide from y=8 to the bottom, with a 4x4 lamp head at the top in the LIT frame
const post = (f: ReturnType<typeof frame>) => { for (let y = 8; y < H; y++) for (let x = 7; x < 9; x++) put(f, x, y, 60, 50, 40); };
const unlit = frame(); post(unlit); for (let y = 2; y < 6; y++) for (let x = 6; x < 10; x++) put(unlit, x, y, 70, 60, 50);
const lit = frame(); post(lit); for (let y = 2; y < 6; y++) for (let x = 6; x < 10; x++) put(lit, x, y, 255, 170, 60);

test("the pixels that differ between LIT and NOT_LIT are the light: centroid at the lamp head, warm colour, area 16", () => {
  const e = deriveEmissive(lit, unlit);
  assert.ok(e);
  assert.equal(e.area, 16);
  assert.equal(e.cx, 7.5);
  assert.equal(e.cy, 3.5);
  assert.deepEqual(e.color.map((v) => +v.toFixed(2)), [1, 0.67, 0.24]);
});

test("without a sibling, bright saturated pixels are the light; a dark post alone is none", () => {
  const e = deriveEmissive(lit);
  assert.ok(e && e.area === 16 && e.cy === 3.5);
  assert.equal(deriveEmissive(unlit), null, "nothing bright: no light");
});

test("kind by piece id, params campfire-anchored: a lamp flickers with shadows at ~2 cells, a crystal pulses shadow-free", () => {
  assert.equal(lightKindOf("streetlights/streetlight_011"), "flame");
  assert.equal(lightKindOf("crystals/crystal_012"), "glow");
  const e = deriveEmissive(lit, unlit)!;
  const lamp = lightParams(e, "flame");
  assert.equal(+lamp.radius.toFixed(2), 2.5, "2 + sqrt(16)/8");
  assert.equal(lamp.anim, 2);
  assert.equal(lamp.shadows, true);
  assert.ok(lamp.color[0] > 1 && lamp.color[0] <= 1.8, "overbright red channel, capped by the intensity");
  const crystal = lightParams({ ...e, area: 900 }, "glow");
  assert.equal(crystal.radius, 4.5, "capped under the campfire's 7");
  assert.equal(crystal.anim, 1);
  assert.equal(crystal.shadows, false);
});

import { lightFromBlock, CAMPFIRE_PEAK } from "../../client/src/scenerylights.js";
import { parseLight, lightBlockFor, hexToRgb01 } from "../../client/src/scenery3.js";

test("the manifest's light block parses: hex colour, clamps, per-state overrides inheriting the top block", () => {
  const l = parseLight({ strength: 0.5, color: "#ffd27a", radius: 4, states: { LIT_3: { strength: 0.4, radius: 3 }, LIT_9: { radius: 12, color: "#0ff" }, junk: "no" } })!;
  assert.ok(l);
  assert.deepEqual(l.color.map((v) => +v.toFixed(3)), [1, 0.824, 0.478]);
  assert.equal(l.radius, 4);
  assert.deepEqual(l.states.LIT_3, { strength: 0.4, color: l.color, radius: 3 }, "colour inherited from the top block");
  assert.equal(l.states.LIT_9.radius, 7, "capped at the campfire's 7");
  assert.deepEqual(l.states.LIT_9.color, [0, 1, 1], "#rgb shorthand");
  assert.equal(l.states.junk, undefined);
  assert.equal(parseLight(null), null);
  assert.equal(parseLight({ color: "#fff" }), null, "no strength/radius: unusable");
  assert.deepEqual(hexToRgb01("nonsense"), [1, 0.85, 0.6]);
});

test("a placement's light is its state's block, else the piece's, else the pixels", () => {
  const piece = { light: parseLight({ strength: 0.5, color: "#ffd27a", radius: 4, states: { LIT_3: { strength: 0.4, radius: 3 } } }) };
  assert.equal(lightBlockFor(piece, "LIT_3")!.radius, 3);
  assert.equal(lightBlockFor(piece, "LIT_1")!.radius, 4, "no state block: the piece's");
  assert.equal(lightBlockFor({ light: null }, "LIT_1"), null, "no block: derive from the pixels");
});

test("params from the block: radius as given to 7, colour as given, intensity = strength × the campfire's peak, steady", () => {
  const lamp = lightFromBlock({ strength: 0.5, color: [1, 0.824, 0.478], radius: 6.5 }, "flame")!;
  assert.equal(lamp.radius, 6.5);
  assert.equal(+lamp.color[0].toFixed(3), +(CAMPFIRE_PEAK * 0.5).toFixed(3), "peak channel = strength × 1.9");
  assert.equal(lamp.flicker, 0, "flicker is deferred by the maintainer — steady");
  assert.equal(lamp.shadows, true, "a lamp still casts shadows");
  assert.equal(lightFromBlock({ strength: 0, color: [1, 1, 1], radius: 3 }, "glow"), null, "strength 0 is no light");
  assert.equal(lightFromBlock({ strength: 1, color: [1, 1, 1], radius: 9 }, "glow")!.radius, 7);
});
