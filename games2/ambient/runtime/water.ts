/* THE WATER PROBES — where the swimmable surface is, and which kind it is.
 *
 * The game answers both questions and neither is derivable here: `water` and
 * `deep_water` carry IDENTICAL Surface records, so nothing but the deep-sea
 * current probe can tell a pond from the end of the world (the seam
 * `deepwater/` was given, WorldScene `deepCurrentAtScreen`).
 *
 * THE SPLIT IS A CONTRACT BETWEEN FEATURES, not a detail: `water/` draws the
 * lake chop, `deepwater/` the seaward current, and they must not overlap
 * (maintainer 2026-09-07: "the water effect we have on regular water can't be
 * used on deep_water also"). Anything new that draws on water inherits that
 * split, which is why the test lives here rather than in a third feature.
 *
 * `water/` and `deepwater/` still carry their own private copies from before
 * this module existed; they are identical in behaviour and can migrate the
 * next time either is opened. Nothing here reads a feature's state, so the
 * duplication is inert rather than a fork waiting to happen.
 *
 * Every read is fenced: a missing or throwing probe answers "not water", so a
 * feature quietly draws nothing rather than crashing on an older game build.
 */

type ML = Record<string, (...a: never[]) => unknown>;
const ml = (): ML | undefined => (window as unknown as { __ml?: ML }).__ml;

/** Any swimmable surface drawn at this screen point (lake, sea, lava). */
export function waterAt(wx: number, wy: number): boolean {
  const f = ml()?.waterAtScreen as undefined | ((x: number, y: number) => boolean);
  if (!f) return false;
  try {
    return !!f(wx, wy);
  } catch {
    return false;
  }
}

/** Does the OPEN SEA's current run here? A non-null, moving answer IS the open
 *  sea. The free shallows the shoreline keeps answer no, so a lake effect may
 *  run right up to where the drag starts. No probe (an older build) means no
 *  exclusion. */
export function deepAt(wx: number, wy: number): boolean {
  const f = ml()?.deepCurrentAtScreen as
    | undefined
    | ((x: number, y: number) => { dx: number; dy: number; speed: number } | null);
  if (!f) return false;
  try {
    const cur = f(wx, wy);
    return !!cur && cur.speed > 0;
  } catch {
    return false;
  }
}

/** LAKES AND SHALLOWS: water that is not the open sea. */
export function lakeAt(wx: number, wy: number): boolean {
  return waterAt(wx, wy) && !deepAt(wx, wy);
}

/** A random point of lake water in `view` with `margin` px of lake to each
 *  side and `marginY` above and below, or null after `tries`.
 *
 *  THE TWO MARGINS ARE NOT THE SAME NUMBER for anything that draws a shape:
 *  the iso projection squashes y by 14/32, so a mark that reaches 15 px along
 *  x reaches 7 down the screen, and asking for 15 px of water above it would
 *  refuse most of a real pond for clearance it never needed.
 *
 *  The margin is what keeps a mark off the SHORELINE and off a tile's hillside
 *  face — the probe resolves the front-most drawn surface, so a point one pixel
 *  inside an edge answers "water" while the pixels around it are sand or a
 *  cliff (the ambient water marks call it the hillside bug). Anything that
 *  draws a shape rather than a dot passes its own radius here. */
export function findLake(
  view: { x: number; y: number; width: number; height: number },
  rnd: () => number,
  margin: number,
  tries = 10,
  marginY = margin,
): { x: number; y: number } | null {
  for (let t = 0; t < tries; t++) {
    const x = Math.round(view.x + rnd() * view.width);
    const y = Math.round(view.y + rnd() * view.height);
    if (
      lakeAt(x, y) &&
      lakeAt(x + margin, y) &&
      lakeAt(x - margin, y) &&
      lakeAt(x, y + marginY) &&
      lakeAt(x, y - marginY)
    )
      return { x, y };
  }
  return null;
}
