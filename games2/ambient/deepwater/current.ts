import { CELL_WU, DEEP_CURRENT_MAX, ISO_DX, ISO_DY } from "@nangijala/shared";

// The PHASER-FREE half of the deep-water effect: turning the game's deep-sea
// current into something drawable. Split out of deepwater.ts so it can be
// unit-tested — deepwater.ts imports Phaser, which needs a DOM, and the two
// things here that MUST stay honest (the projection and the strength ramp) are
// pure arithmetic.
//
// THE CURRENT IS FLAT, THE PICTURE IS ISO. `deepCurrentAt` (shared, integrated
// by both the server and the client's prediction) answers in FLAT world space:
// a unit vector toward the map centre plus wu/s. Everything this agent draws
// lives in the DRAWN iso-projected space the camera shows. Projecting is not a
// nicety — a flat "north" and a drawn "north" are different directions on
// screen, so foam drawn along the raw vector would stream visibly askew from
// the way the player is actually being pushed.

/** One flow, ready to draw: unit direction in DRAWN space, drawn px/s, and the
 * 0..1 strength the look scales by. */
export interface DrawnFlow {
  ux: number;
  uy: number;
  /** Drawn pixels per second — what the player sees the sea move at. */
  speed: number;
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
 * it is what makes the foam stream at the rate the swimmer is actually dragged
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
  return {
    ux: d.x / len,
    uy: d.y / len,
    speed: cur.speed * len, // |flat dir| is 1, so the projection's length IS the scale
    strength: Math.max(0, Math.min(1, cur.speed / DEEP_CURRENT_MAX)),
  };
}

// The 8 drawn directions the streak art is rasterised for: the 4 screen
// cardinals plus the 4 SHALLOW iso tile axes (ISO_DX:ISO_DY, not screen-45) —
// the same 8 the character and flock art use, so foam lies along the same
// grid the world is drawn on. Index order is the array's own; art is generated
// per index, so only `dir8` and the generator have to agree.
const D = Math.hypot(ISO_DX, ISO_DY);
export const FLOW_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [ISO_DX / D, ISO_DY / D],
  [0, 1],
  [-ISO_DX / D, ISO_DY / D],
  [-1, 0],
  [-ISO_DX / D, -ISO_DY / D],
  [0, -1],
  [ISO_DX / D, -ISO_DY / D],
];

/** Nearest of the 8 drawn directions to a unit vector, by dot product. Art is
 * quantised because pixel art may not be rotated to arbitrary angles — a
 * free-rotated 1px streak resamples into a dotted grey smear. The motion
 * itself stays continuous; only which of the 8 sprites is drawn snaps. */
export function dir8(ux: number, uy: number): number {
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < FLOW_DIRS.length; i++) {
    const dot = ux * FLOW_DIRS[i][0] + uy * FLOW_DIRS[i][1];
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  }
  return best;
}

/** The direction index a CREST lies along: across the flow.
 *
 * The 8 drawn directions correspond to 8 EVENLY spaced FLAT directions (the
 * four flat cardinals and the four flat diagonals), so stepping two round the
 * ring is exactly a quarter turn IN THE WORLD — which is what a wave crest is:
 * a line across its own travel over the sea.
 *
 * It will NOT look like 90 degrees on screen, and should not. The iso
 * projection is not conformal: a world right angle draws as roughly 47 degrees
 * along the tile axes, for the same reason a square tile draws as a rhombus.
 * Measuring the drawn angle and "fixing" it to a right angle would tilt every
 * swell off the water plane and make the sea look like a pane of glass. */
export const crossDir8 = (flowIdx: number): number => (flowIdx + 2) % 8;

/** Rasterise a 1px line of `len` pixels along direction `i`, as [x,y] offsets
 * from a top-left origin, plus the size of the bitmap that holds it. Bresenham
 * on the quantised direction: cardinals come out as clean runs and the tile
 * axes as the same 32:14 stagger the terrain itself is drawn with. */
export function rasterLine(i: number, len: number): { px: [number, number][]; w: number; h: number } {
  const [dx, dy] = FLOW_DIRS[i];
  const pts: [number, number][] = [];
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (let s = 0; s < len; s++) {
    const x = Math.round(dx * s);
    const y = Math.round(dy * s);
    const last = pts[pts.length - 1];
    if (last && last[0] === x && last[1] === y) continue; // the stagger repeats a cell
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
