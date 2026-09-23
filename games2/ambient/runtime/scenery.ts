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
 * EVERY PIECE IS IN THAT LIST TWICE, and both copies matter here:
 *
 *  - the BASE image, drawn on the painter line under the darkness overlay
 *    (measured at the marsh: depth 5401.7 for a reed bed at row 226), and
 *  - an opaque LIT COPY at `litDepth` (~900_001+, tinted by the light where it
 *    stands), which is what is actually SEEN wherever there is any darkness to
 *    multiply — `litDepth(base) = 900_001 + base * 1e-5` in WorldScene.
 *
 * They share a texture key, a frame and a destination box exactly (measured at
 * the marsh, Day and Night: every group is a clean pair), so they are paired
 * HERE and a piece is reported ONCE. Counting the raw list said 20 waterline
 * pieces where the world had drawn 10, and a population tuned per piece then
 * came out double.
 *
 * `litDepth` is the reason the pairing is worth doing rather than just
 * de-duplicating: EVERY AMBIENT MARK SITS AT ~900_000.0x, just over the
 * darkness overlay, which is right for something lying on the ground and
 * exactly wrong for something attached to a piece — the piece's own lit copy
 * paints over it. The sparks and the moths paid for this on 2026-09-09
 * (maintainer, at his hearth: "you render the sparks and also the moths behind
 * the Scenery object so it's hard to see"), and `lightsInView` and
 * `ventsInView` carry `litDepth` for exactly that reason. The dragonflies were
 * written after that fix and hunted BEHIND their own reeds until this seam
 * carried the number too (measured at the reed bed: dragonfly 900_000.090
 * under a reed copy at 900_001.053).
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
  /** THE DEPTH OF ITS LIT COPY — what an attached mark sorts in front of.
   *  Null when the piece has no copy (no night shader, or the copy has not
   *  been built yet); the caller then has nothing to be in front OF. */
  litDepth: number | null;
}

interface RawObject {
  key: string;
  frame?: string;
  depth?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
}

/** The band `litDepth()` puts the lit copies in — WorldScene's
 *  `900_001 + baseDepth * 1e-5`. Everything below it is a base image on the
 *  painter line (the widest the_game can produce is ~11.7k px, so the two
 *  bands cannot meet). */
export const LIT_BAND = 900_001;

/** SORTED IN FRONT OF ITS OWN PIECE, by a tenth of a painter pixel. The lit
 *  band compresses painter depth by 1e-5, so this is a sort and not an
 *  override: anything genuinely nearer than the piece — the player walking in
 *  front of the reeds — still draws over the mark. (The embers' own constant,
 *  kept identical on purpose.) */
export const SRC_LIFT = 1e-6;

/** When there is no lit copy to sort against there is nothing to be in front
 *  OF, so go above the whole lit band: the widest painter line the_game can
 *  produce is ~11.7k px = 900_001.12, and the target rings and HP bars start
 *  at 900_001.44. (The embers' and moths' own constant.) */
export const ABOVE_LIT = 900_001.3;

/** Every visible piece of one of `categories` within `pad` px of `view`, each
 *  reported ONCE with the depth of its lit copy. Returns [] when the probe is
 *  missing, so a feature simply finds nothing rather than throwing on a build
 *  that does not publish it. */
/** Every scenery texture the game publishes is keyed "s3:<category>/…" — the
 *  one prefix `pairPieces` keeps, handed to the probe so it can skip the rest
 *  before paying for them. */
export const SCENERY_KEY_PREFIX = "s3:";

export function sceneryInView(
  view: Phaser.Geom.Rectangle | { x: number; y: number; width: number; height: number },
  categories: ReadonlySet<string>,
  pad = 48,
): SceneryPiece[] {
  /* `globalThis`, not `window`: `pairPieces` below is pure arithmetic and is
   * unit-tested from `server/test/`, whose tsconfig has no DOM lib — one
   * `window` in this file put a red on the server project. In a browser the
   * two are the same object. */
  const ml = (globalThis as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
  const f = ml?.objectsIn as undefined | ((x0: number, y0: number, x1: number, y1: number, keyPrefix?: string) => RawObject[]);
  if (!f) return [];
  const w = "width" in view ? view.width : (view as Phaser.Geom.Rectangle).width;
  const h = "height" in view ? view.height : (view as Phaser.Geom.Rectangle).height;
  let raw: RawObject[];
  try {
    /* ASK FOR THE PIECES, NOT FOR THE SCREEN. pairPieces keeps only textures
     * whose key starts "s3:", so handing the probe that prefix moves the test
     * ahead of its getBounds() and its record-building instead of behind
     * them. An older build whose probe ignores the extra argument still
     * answers the whole list and pairPieces filters it as it always did. */
    raw = f(view.x - pad, view.y - pad, view.x + w + pad, view.y + h + pad, SCENERY_KEY_PREFIX) ?? [];
  } catch {
    return [];
  }
  return pairPieces(raw, categories);
}

/** The pairing itself, split out so it is testable without a display list. */
export function pairPieces(raw: readonly RawObject[], categories: ReadonlySet<string>): SceneryPiece[] {
  /* One bucket per drawn box. A base image and its lit copy are the same
   * texture, the same frame and the same rectangle, so the box IS the identity
   * — and two DIFFERENT placements cannot share one, because they would be the
   * same pixels. Insertion order is kept so the answer is stable between
   * scans. */
  const groups = new Map<string, { base: RawObject[]; lit: RawObject[] }>();
  const order: string[] = [];
  for (const o of raw) {
    const key = String(o.key ?? "");
    if (!key.startsWith("s3:")) continue;
    const category = key.slice(3, key.indexOf("/", 3) >>> 0);
    if (!category || !categories.has(category)) continue;
    // a piece being faded out (the indoor crossfade) is not somewhere to perch
    if (typeof o.alpha === "number" && o.alpha < 0.5) continue;
    const id = `${key}|${o.frame ?? ""}|${o.x},${o.y},${o.w},${o.h}`;
    let g = groups.get(id);
    if (!g) {
      g = { base: [], lit: [] };
      groups.set(id, g);
      order.push(id);
    }
    ((o.depth ?? 0) >= LIT_BAND ? g.lit : g.base).push(o);
  }
  const out: SceneryPiece[] = [];
  for (const id of order) {
    const g = groups.get(id)!;
    const category = id.slice(3, id.indexOf("/", 3) >>> 0);
    /* PAIRED BY INDEX, and the count is the LONGER side: a piece always has a
     * base image and usually a lit copy, but a copy can exist alone for one
     * frame while the base is being rebuilt, and neither case may lose a
     * piece or invent one. */
    const n = Math.max(g.base.length, g.lit.length);
    for (let i = 0; i < n; i++) {
      const o = g.base[i] ?? g.lit[i];
      out.push({
        category,
        x: o.x,
        y: o.y,
        w: o.w,
        h: o.h,
        cx: o.x + o.w / 2,
        footY: o.y + o.h,
        litDepth: g.lit[i] ? (g.lit[i].depth as number) : null,
      });
    }
  }
  return out;
}
