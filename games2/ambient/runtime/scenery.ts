import type Phaser from "phaser";

/* WHAT SCENERY IS ON SCREEN — the seam for effects that belong to a PIECE
 * rather than to the ground.
 *
 * `__ml.objectsIn(x0,y0,x1,y1)` hands back every drawn Image in a world-px
 * box, and a scenery piece carries its own path in its texture key:
 *
 *     s3:water_lily_clumps/water_lily_clump_001/sprite.webp
 *     s3:reed_beds/reed_bed_007/sprite.webp
 *
 * so the CATEGORY — the first path segment — is what a feature asks for. That
 * is the maps2 agent's own placement vocabulary, which means a feature keyed
 * to "reed_beds" picks up every reed bed the world gains later without a
 * second list to maintain.
 *
 * IT WALKS THE WHOLE DISPLAY LIST (measured: 1,072 objects in a busy view), so
 * this is a THROTTLED call — the same rule `lightsInView` carries for the
 * moths. Scan on a timer, keep the answer, never ask per frame.
 *
 * The key is truncated to 44 characters by the probe, which is why the match
 * is a PREFIX on the category and never on the piece id: a long enough path
 * loses its tail.
 */

export interface SceneryPiece {
  /** The category, e.g. "reed_beds" — the first segment of the piece path. */
  category: string;
  /** World px bounds as drawn. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The middle of the drawn piece, and its FOOT (where it meets the ground). */
  cx: number;
  footY: number;
}

interface RawObject {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
}

/** Every visible piece of one of `categories` within `pad` px of `view`.
 *  Returns [] when the probe is missing, so a feature simply finds nothing
 *  rather than throwing on a build that does not publish it. */
export function sceneryInView(
  view: Phaser.Geom.Rectangle | { x: number; y: number; width: number; height: number },
  categories: ReadonlySet<string>,
  pad = 48,
): SceneryPiece[] {
  const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
  const f = ml?.objectsIn as undefined | ((x0: number, y0: number, x1: number, y1: number) => RawObject[]);
  if (!f) return [];
  const w = "width" in view ? view.width : (view as Phaser.Geom.Rectangle).width;
  const h = "height" in view ? view.height : (view as Phaser.Geom.Rectangle).height;
  let raw: RawObject[];
  try {
    raw = f(view.x - pad, view.y - pad, view.x + w + pad, view.y + h + pad) ?? [];
  } catch {
    return [];
  }
  const out: SceneryPiece[] = [];
  for (const o of raw) {
    const key = String(o.key ?? "");
    if (!key.startsWith("s3:")) continue;
    const category = key.slice(3, key.indexOf("/", 3) >>> 0);
    if (!category || !categories.has(category)) continue;
    // a piece being faded out (the indoor crossfade) is not somewhere to perch
    if (typeof o.alpha === "number" && o.alpha < 0.5) continue;
    out.push({ category, x: o.x, y: o.y, w: o.w, h: o.h, cx: o.x + o.w / 2, footY: o.y + o.h });
  }
  return out;
}
