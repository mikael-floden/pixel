import { CELL_WU, DEEP_CURRENT_MAX, ISO_DX, ISO_DY } from "@nangijala/shared";

// The PHASER-FREE half of the deep-water effect: turning the game's deep-sea
// current into something drawable. Split out of deepwater.ts so it can be
// unit-tested — deepwater.ts imports Phaser, which needs a DOM, and the two
// things here that MUST stay honest (the projection and the strength ramp) are
// pure arithmetic.
//
// THE CURRENT IS FLAT, THE PICTURE IS ISO. `deepCurrentAt` (shared, integrated
// by both the server and the client's prediction) answers in FLAT world space:
// a unit vector toward the nearest mainland plus wu/s. Everything this agent
// draws lives in the DRAWN iso-projected space the camera shows. Projecting is not a
// nicety — a flat "north" and a drawn "north" are different directions on
// screen, so drift drawn along the raw vector would stream visibly askew from
// the way the player is actually being pushed.

/** One flow, ready to draw: unit direction in DRAWN space, drawn px/s, and the
 * 0..1 strength the look scales by. */
export interface DrawnFlow {
  ux: number;
  uy: number;
  /** The CREST's drawn unit direction: a quarter turn in the WORLD, projected. */
  cx: number;
  cy: number;
  /** Drawn pixels per second the current TRULY runs at (what drags the player). */
  speed: number;
  /** Drawn px per world unit along this heading — the projection's own scale,
   * 0.62 to 1.41 depending on direction. A look that picks its own rate still
   * multiplies by this, or marks on different headings drift out of step with
   * the water they are drawn on. */
  scale: number;
  /** 0..1 of DEEP_CURRENT_MAX: 0 in the free shallows, 1 out at sea. */
  strength: number;
}

/**
 * Project a FLAT world delta onto the drawn iso plane.
 *
 * x = (col - row) * ISO_DX, y = (col + row) * ISO_DY with col = wx / CELL_WU,
 * so the same delta covers a DIFFERENT drawn distance depending on heading —
 * measured with the shipped constants, 1.41x along one tile axis and 0.62x
 * along the other. That anisotropy is real (it is why a north-south walk
 * crosses more world per screen pixel than an east-west one), and reproducing
 * it is what makes the drift stream at the rate the swimmer is actually dragged
 * instead of merely near it.
 */
export function flatToDrawn(dx: number, dy: number): { x: number; y: number } {
  return {
    x: ((dx - dy) / CELL_WU) * ISO_DX,
    y: ((dx + dy) / CELL_WU) * ISO_DY,
  };
}

/**
 * A probe reading (`__ml.deepCurrentAtScreen`) turned into a drawable flow, or
 * null where there is no current — on land, on a lake, and in the free
 * shallows the shoreline keeps swimmable. Returns null for a degenerate vector
 * too, so a caller never divides by zero at the exact map centre.
 */
export function drawnFlow(cur: { dx: number; dy: number; speed: number } | null): DrawnFlow | null {
  if (!cur || !(cur.speed > 0)) return null;
  const d = flatToDrawn(cur.dx, cur.dy);
  const len = Math.hypot(d.x, d.y);
  if (!(len > 1e-6)) return null;
  // THE CREST IS A QUARTER TURN IN THE WORLD, TURNED THERE AND THEN PROJECTED.
  // Turning the DRAWN vector instead would be a quarter turn on screen, which
  // is a different line: the projection is not conformal, so a world right
  // angle draws as roughly 47 degrees along the tile axes — the same reason a
  // square tile draws as a rhombus. A screen-perpendicular crest stands off the
  // water plane and the sea reads as a pane of glass.
  const c = flatToDrawn(-cur.dy, cur.dx);
  const cl = Math.hypot(c.x, c.y) || 1;
  return {
    ux: d.x / len,
    uy: d.y / len,
    cx: c.x / cl,
    cy: c.y / cl,
    speed: cur.speed * len, // |flat dir| is 1, so the projection's length IS the scale
    scale: len,
    strength: Math.max(0, Math.min(1, cur.speed / DEEP_CURRENT_MAX)),
  };
}

/* ART IS RASTERISED AT ANY ANGLE, not snapped to the 8 tile directions
 * (maintainer 2026-09-07: "I like the lines to be drawn in any free rotation
 * (always forming a wave that represent the current at that location)"). The
 * current turns smoothly across the map — that IS the picture, and eight
 * directions drew a sea of eight tick-mark families instead.
 *
 * FREE ROTATION WITHOUT RESAMPLING. Pixel art may still never be ROTATED (a
 * rotated 1px line resamples into a dotted grey smear); what changes is that
 * the line is RASTERISED at the angle instead of being drawn at one of eight
 * and turned. Bresenham on whole pixels at any angle is exact pixel art — it
 * is how the terrain's own staircases are drawn — so the crest lands on the
 * world's pixel grid whatever direction it points.
 *
 * The ring is quantised only so the textures can be CACHED: 64 steps is 5.6
 * degrees, which moves the far end of the longest (53 px) crest by 2.6 px, and
 * the eye reads the family as continuous. Nothing else quantises — position,
 * speed and the direction a mark travels stay exact. */
export const ANGLE_STEPS = 64;

/** The nearest of the ANGLE_STEPS rasterised angles to a drawn unit vector. */
export function angleIndex(ux: number, uy: number): number {
  const a = Math.atan2(uy, ux) / (Math.PI * 2);
  return ((Math.round(a * ANGLE_STEPS) % ANGLE_STEPS) + ANGLE_STEPS) % ANGLE_STEPS;
}

/** The angle, in radians, that index rasterises at. */
export const angleOf = (i: number): number => (i / ANGLE_STEPS) * Math.PI * 2;

/** Rasterise a 1px line of `len` pixels along angle index `i`, as [x,y]
 * offsets from a top-left origin, plus the size of the bitmap that holds it.
 * Whole pixels only, and a repeated pixel is dropped rather than drawn twice
 * (a shallow angle steps the same cell more than once). */
export function rasterLine(i: number, len: number): { px: [number, number][]; w: number; h: number } {
  const a = angleOf(i);
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const pts: [number, number][] = [];
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (let s = 0; s < len; s++) {
    const x = Math.round(dx * s);
    const y = Math.round(dy * s);
    const last = pts[pts.length - 1];
    if (last && last[0] === x && last[1] === y) continue; // a shallow angle repeats a cell
    pts.push([x, y]);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    px: pts.map(([x, y]) => [x - minX, y - minY] as [number, number]),
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };
}
