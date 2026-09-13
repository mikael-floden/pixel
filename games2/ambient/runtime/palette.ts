/* HOW MUCH COLOUR AN AMBIENT MARK MAY CARRY — a domain rule, not one
 * feature's taste.
 *
 * The maintainer rejected butterfly colour twice. The first time the answer
 * was "pick nicer colours", which is a judgement that drifts with whoever
 * writes the next feature. The second time he said what he actually meant:
 * "I don't want the butterflies to bring this much color into the game... No
 * extreme/vibrant colors. This is a background effect." That applies to
 * everything drawn here, so the cap lives in `runtime/` and every feature
 * that paints a creature measures against it.
 *
 * Measured on the palette he rejected: orange 0.81, yellow 0.69, blue 0.65,
 * green 0.63. Nothing shipped here goes over MAX_SAT, and the tests assert
 * both halves — that our own colours pass AND that his rejected ones would
 * not, so the cap can never quietly become a rubber stamp.
 */

/** The most colour an ambient mark may carry, as HSV saturation. */
export const MAX_SAT = 0.45;

/** HSV saturation of a packed RGB, 0..1 — how much COLOUR it carries. */
export function saturation(c: number): number {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  const hi = Math.max(r, g, b);
  return hi === 0 ? 0 : (hi - Math.min(r, g, b)) / hi;
}

/** Perceived brightness of a packed RGB, 0..255. */
export function luma(c: number): number {
  return 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
}

/** Is this colour quiet enough to draw in the background of his game? */
export function muted(c: number): boolean {
  return saturation(c) <= MAX_SAT;
}
