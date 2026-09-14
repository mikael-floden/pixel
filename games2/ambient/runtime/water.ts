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
/* Reached through `globalThis`, never as a bare `window`: outside a browser —
 * a worker, the node test harness — a bare `window` is a ReferenceError, not a
 * catchable property miss, and this module is unit-tested under node. */
const ml = (): ML | undefined => (globalThis as { window?: { __ml?: ML } }).window?.__ml;

/* LAVA IS WATER TO THE GAME'S PROBE, AND THAT IS THE TRAP THIS MODULE EXISTS
 * TO CLOSE (maintainer 2026-09-14, with the screenshot: crabs walking the
 * shore of a lava lake). `isWaterAtScreen` answers `!standable && swimmable`,
 * and `shared/src/surfaces.ts` gives lava BOTH of those — plus `sound:
 * "water"`, so `groundSoundAt` calls it water as well. Every field is a
 * lake's except `harm`.
 *
 * Measured at the lava lake by the old code: 42 of 52 sampled molten points
 * answered `waterAtScreen` true, `crabs/` had a 480 px "shoreline" colony,
 * `fish/` reported lakeFrac 0.28 with four rises spawned, and `water/` was
 * painting three wavelets and a moon glint on molten rock.
 *
 * So `waterAt` means WATER YOU COULD SWIM IN — harmless — because that is what
 * every ambient effect has ever meant by it, and a feature written next year
 * should inherit the right answer without knowing lava exists. Anything that
 * genuinely wants "any liquid" asks `swimmableAt`. */

/** Any swimmable surface drawn here, INCLUDING lava. Almost certainly not
 *  what you want — see `waterAt`. */
export function swimmableAt(wx: number, wy: number): boolean {
  const f = ml()?.waterAtScreen as undefined | ((x: number, y: number) => boolean);
  if (!f) return false;
  try {
    return !!f(wx, wy);
  } catch {
    return false;
  }
}

/* WHAT LIQUID IS UNDER A POINT, remembered per cell.
 *
 * THE TWO PROBES DISAGREE, and that is the whole difficulty. `waterAtScreen`
 * walks the drawn faces top-down and answers about the FRONT-MOST one;
 * `pickAt` resolves the cell you would stand in. At the edge of a lava lake
 * they differ — measured, a point 16 px off the crab colony's home answered
 * `waterAtScreen` TRUE while `pickAt` + `surfaceAt` called it stone,
 * swimmable false, harm 0. A harm check hung on `pickAt` alone therefore
 * passed the very pixels the colony was anchored to.
 *
 * So harmless water needs BOTH probes to agree, and the disagreement cases
 * resolve to "not water". For placing creatures that is the conservative
 * answer and the right one: a shoreline edge pixel where the game itself is
 * of two minds is not somewhere to anchor anything.
 *
 * A cell's surface never changes at runtime, so this is paid once per cell. */
const liquid = new Map<string, { swim: boolean; harm: number }>();
const LIQUID_CACHE_MAX = 4096;

function liquidAt(wx: number, wy: number): { swim: boolean; harm: number } | null {
  const m = ml();
  const pick = m?.pickAt as undefined | ((x: number, y: number) => { x: number; y: number } | null);
  const surf = m?.surfaceAt as undefined
    | ((x: number, y: number) => { swimmable?: boolean; harm?: number } | null);
  if (!pick || !surf) return null;
  try {
    const p = pick(wx, wy);
    if (!p) return null;
    const key = `${Math.round(p.x)},${Math.round(p.y)}`;
    const hit = liquid.get(key);
    if (hit) return hit;
    const s = surf(p.x, p.y);
    if (!s) return null;
    const out = { swim: !!s.swimmable, harm: s.harm ?? 0 };
    if (liquid.size >= LIQUID_CACHE_MAX) liquid.clear();
    liquid.set(key, out);
    return out;
  } catch {
    return null;
  }
}

/** Does the liquid here HURT to be in? (lava's `harm`.) */
export function burnsAt(wx: number, wy: number): boolean {
  return (liquidAt(wx, wy)?.harm ?? 0) > 0;
}

/** WATER AN AMBIENT EFFECT MEANS: swimmable, harmless, and both probes agree.
 *  Lava answers false here even though the game's own probe calls it water. */
export function waterAt(wx: number, wy: number): boolean {
  // the cheap probe first: most of the world is not liquid at all
  if (!swimmableAt(wx, wy)) return false;
  const l = liquidAt(wx, wy);
  // no picker at all (an older build) keeps the old, permissive behaviour;
  // a picker that ANSWERS and disagrees is believed over the draw probe
  if (!l) return !ml()?.pickAt;
  return l.swim && l.harm === 0;
}

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
