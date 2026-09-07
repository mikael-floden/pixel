/* THE GLINT — sunlight or moonlight caught on moving water.
 *
 * One shape, one palette, TWO features: the lake chop (`water/`) sparkles on a
 * pond, and the seaward current (`deepwater/`) rides the same glint along its
 * crests. They live here so the two cannot drift apart — the maintainer asked
 * for exactly the lake's glimmer out at sea (2026-09-07: "I want the same
 * bright sparks as we have in regular water ... A small part of the wave should
 * be able to glimmer in very bright/close to white"), and "the same" has to
 * mean the same art, not a second one that looks similar today.
 *
 * The frames are a PLUS WITH ONE ARM MISSING, then shrunk, then a point: an
 * in-place animated twinkle rather than a sliding object. Painted pure white
 * and TINTED per mark to the sun or moon colour, drawn ADDITIVE.
 */
export const GLINT_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[1, 0], [1, 1], [1, 2], [2, 1]], // full T (missing left)
  [[1, 1], [2, 1]], // shrunk
  [[1, 1]], // point
];
export const GLINT_SIZE = 3;

/** Reflection look for the current time of day. `strength` 0..1 scales glint
 * count + brightness; `tint` is the sparkle colour; `moon` marks the night
 * look. Amber at dawn/dusk, white at noon, cool and gentler after dark. */
export function reflection(env: { sun: number; night: number; cloud: number }): {
  tint: number;
  strength: number;
  moon: boolean;
} {
  const lerpC = (a: number, b: number, t: number) => {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    const m = (x: number, y: number) => Math.round(x + (y - x) * t) & 255;
    return (m(ar, br) << 16) | (m(ag, bg) << 8) | m(ab, bb);
  };
  if (env.sun > 0.12) {
    const tint = lerpC(0xffcf94, 0xfff4da, Math.min(1, env.sun));
    return { tint, strength: (0.35 + 0.65 * env.sun) * (1 - 0.5 * env.cloud), moon: false };
  }
  return { tint: 0xd2e2ff, strength: 0.5 * env.night * (1 - 0.6 * env.cloud), moon: true };
}
