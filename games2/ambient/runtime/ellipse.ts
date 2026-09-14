/* A RING ON THIS GROUND IS AN ELLIPSE — shared by every feature that draws one
 * (fish/ rings on a lake, drips/ splash rings on a cave floor).
 *
 * The iso projection maps a world circle to a screen ellipse squashed by
 * dy/dx = 14/32, and a feature drawing a circle would read as a hoop standing
 * up out of the ground. Same arithmetic the game uses for a body's shadow
 * ellipse; the ratio is the projection's, not taste.
 *
 * Pixel art rules apply: a ring is rasterised at a WHOLE-PIXEL radius and drawn
 * at scale 1 on integer positions, so a growing ring steps radius by radius
 * rather than sliding sub-pixel — a handful of small textures generated once,
 * not one texture scaled up. Lived in fish/rings.ts until drips/ needed it too
 * (2026-09-12); rings.ts re-exports it unchanged.
 */

/** Screen squash of the iso projection: ISO_DY / ISO_DX. */
export const RING_RY = 14 / 32;

/** The 1-px outline of an iso ellipse of x-radius `rx`, as offsets from its
 *  centre. Closed and 8-connected: sampled along BOTH axes and unioned, so
 *  there is no gap where the curve turns (a single-axis sweep leaves the top
 *  and bottom of a flat ellipse open). */
export function ellipsePixels(rx: number): { ry: number; px: [number, number][] } {
  const ry = Math.max(1, Math.round(rx * RING_RY));
  const seen = new Set<number>();
  const px: [number, number][] = [];
  const put = (x: number, y: number) => {
    const k = (x + 64) * 256 + (y + 64);
    if (seen.has(k)) return;
    seen.add(k);
    px.push([x, y]);
  };
  for (let x = -rx; x <= rx; x++) {
    const y = Math.round(ry * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2)));
    put(x, y);
    put(x, -y);
  }
  for (let y = -ry; y <= ry; y++) {
    const x = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y / ry) ** 2)));
    put(x, y);
    put(-x, y);
  }
  return { ry, px };
}
