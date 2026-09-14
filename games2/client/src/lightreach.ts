/** THE POOL'S OWN SCREEN EXTENTS — a DOM-free module so the server's tests can
 *  read it (lightslots.ts re-exports; it imports nightlight's types, which pull
 *  the DOM into the server typecheck). */

/** The largest pool a scenery light publishes (`scenery.json` light blocks:
 *  the beacons at 16; derived defaults stop at 4.5). The bound the scenery
 *  build uses for a lit piece whose params are not resolved yet, and the
 *  reach its light query is inflated by. Gate: `server/test/lightreach.test.ts`
 *  scans the manifests. */
export const LIGHT_POOL_MAX_CELLS = 16;
/** Slack past the pool's rim before a light is a candidate at all (the old
 *  box carried the same 128 px). */
export const LIGHT_POOL_MARGIN_PX = 128;

/** A pool of R cells is a circle in the world and an iso ellipse on screen:
 *  √2·R·dx to either side, √2·R·dy up and down — the numbers its glow stamp is
 *  drawn with. The picker's old reach was R·dx a side, HALF the pool's width,
 *  so a hearth's pool was 84 px inside the view before its light was even a
 *  candidate; and the scenery build only knew a light once its SPRITE was
 *  within 200 px of the view, so a far brazier's light was born with its pool
 *  275 px inside the view and ramped up over all of it (maintainer
 *  2026-09-13, the dungeon at day: "spotlight in the distance popping into
 *  existence ... directly influences lots of my camera view"). A light is a
 *  candidate when its POOL can touch the view, sprite or no sprite. */
export function poolReachPx(radiusCells: number, dx: number, dy: number, marginPx = 0): { x: number; y: number } {
  const r = Math.max(0, radiusCells) * Math.SQRT2;
  return { x: r * dx + marginPx, y: r * dy + marginPx };
}
