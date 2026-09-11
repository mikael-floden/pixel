// THE WALL LIGHT WRAP — how far a torch's light travels ALONG a wall.
//
// A face takes a Lambert term, pow(cos, exponent), where cos is the grazing
// angle between the light and the wall plane. Physically that exponent is 1,
// and it crushes grazing light: a torch held close to a wall lights a cell of
// it while its ground pool spreads four or five, because the ground takes no
// angle term at all. The shader shipped 0.45 as a first softening, and the
// maintainer still found it too much (2026-09-11: "I understand this from a
// physics perspective ... but I feel this effect is a bit too extreme so only
// the wall very close to the player is lit up"). So the exponent is his dial.
//
// The dial reads as WRAP, 0..1: 0 is the physical cosine, 1 is no angle
// falloff at all (the wall lit like the ground beside it), and the exponent is
// simply 1 - wrap. The front gate keeps back faces dark at every setting.
// Default 0.7 -> pow 0.3: a notch softer than the 0.45 he called too extreme,
// with the whole range under his thumb. Consumed every frame by nightlight.ts
// (uWallWrap); nothing else reads it.

import { makeDial } from "./dial";

export const WALL_WRAP_MIN = 0;
export const WALL_WRAP_MAX = 1;
export const WALL_WRAP_DEFAULT = 0.7;

const dial = makeDial({
  key: "ml-wall-wrap",
  min: WALL_WRAP_MIN,
  max: WALL_WRAP_MAX,
  def: WALL_WRAP_DEFAULT,
  decimals: 2,
  label: "Wall light wrap",
  text: (v) => (v <= 0.0001 ? "0.00 (physical)" : v >= 0.9999 ? "1.00 (no falloff)" : v.toFixed(2)),
  resetTitle: "back to the default wrap",
});

/** The dial, 0..1. */
export const wallWrap = () => dial.get();
export const setWallWrap = (v: number) => dial.set(v);
export const ensureWallWrapDial = () => dial.ensure();

/** THE SHADER'S EXPONENT for the current dial: pow(cos, this). Clamped away
 *  from 0 so the GLSL pow never sees pow(0, 0) — undefined on some GPUs. */
export function wallWrapExponent(): number {
  return Math.max(0.02, 1 - dial.get());
}
