/* THE MIST MASK'S LATTICE — the world rectangle the zone field's mist raster
 * covers each env tick, and its sample step (mount.ts publishes the raster;
 * the game's mist pass reads it). Pure, so the tests hold the rule
 * (server/test/masklattice.test.ts).
 *
 * ANCHORED TO THE WORLD, NOT TO THE CAMERA. The samples are half a cell apart
 * and the field under them is a STEP function (a cell is in the zone or it is
 * not, blurred over 3x3 — so it moves in ninths). Hung off the view, every
 * sample slid as I walked and crossed cell lines constantly, so the fade
 * rippled by a ninth all over the screen at walking pace. Snapping the origin
 * to a whole sample step pins every sample to a fixed world point: the fade
 * then holds still while the camera moves through it, which is what a fog
 * bank does.
 *
 * A STEP IS KEPT WHILE THE LATTICE STILL HOLDS THE VIEW (games-perf
 * 2026-09-26). The camera zoom BREATHES with speed (WorldScene
 * updateChaseCam sheds up to CAM_ZOOM_OUT 0.32 of it at a run: the view grows
 * 1.47x), and the zone field's raster memo is keyed on the exact step, so a
 * new step is all 2,560 samples looked up in one tick. A step used to be kept
 * only while it covered the view PLUS the margin a new one is sized for,
 * which the run's zoom outgrows: on his screen (393x851 @2.75, a 360x495 view
 * at rest) that was four new lattices every run-and-stop (10 -> 12 -> 14 and
 * 22 -> 26 -> 32 on the way out, back down on the way in), each a whole
 * raster. What the margin must hold is the snap (under a step) and the
 * camera's travel until the next tick, so a step is kept while the lattice
 * holds the VIEW with a step and MASK_TRAVEL to spare on every side: the
 * resting lattice holds a whole run (92 px to spare at full zoom-out), and a
 * view that really changed — turned on its side, resized — still takes a new
 * one. A NEW step is chosen exactly as it always was (the view and its margin
 * over the columns, GROW headroom, whole Q units), so the resting lattice is
 * the one it always was, and a run keeps it instead of coarsening. */

export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** The steps in use, carried tick to tick (the hysteresis). 0 = none yet. */
export interface MaskLattice {
  stepX: number;
  stepY: number;
}

/** 64 x 40 over a view and a half is about half a cell per sample, and the
 *  ramp it has to draw is three cells wide. (32 x 20 was a cell per sample
 *  and his mist came out BLOCKY.) */
export const MASK_COLS = 64;
export const MASK_ROWS = 40;
/** A NEW step is sized for the view plus this much of it on each side. */
export const MASK_MARGIN = 0.25;
/** Steps are whole multiples of Q world px; a kept one is never more than
 *  SLACK times coarser than a new one needs; a new one has GROW headroom. */
export const MASK_STEP_Q = 2;
export const MASK_STEP_SLACK = 1.4;
export const MASK_STEP_GROW = 1.15;
/** World px of camera travel between env ticks a kept lattice must still
 *  hold on each side: a run crosses ~175 px/s of screen and ticks are at
 *  most ~133 ms apart at 30 fps (23 px). Past it the pass clamps to the edge
 *  texel, so this is headroom, not a wall. */
export const MASK_TRAVEL = 32;

/** One axis: `have` is kept while `n` steps of it hold `view` with a step of
 *  snap and MASK_TRAVEL each side and it is not SLACK times coarser than the
 *  view needs; otherwise the step a new lattice is sized with. */
export function latticeStep(have: number, view: number, n: number): number {
  const need = (view * (1 + 2 * MASK_MARGIN)) / n;
  if (have > 0 && have * n >= view + 2 * (have + MASK_TRAVEL) && have <= need * MASK_STEP_SLACK) return have;
  return Math.ceil((need * MASK_STEP_GROW) / MASK_STEP_Q) * MASK_STEP_Q;
}

/** This tick's lattice rect for the view: the steps updated in `lat`, the
 *  rect centred on the view and snapped to whole steps of the world. */
export function maskRect(view: MaskRect, lat: MaskLattice, cols = MASK_COLS, rows = MASK_ROWS): MaskRect {
  lat.stepX = latticeStep(lat.stepX, view.width, cols);
  lat.stepY = latticeStep(lat.stepY, view.height, rows);
  const w = lat.stepX * cols;
  const h = lat.stepY * rows;
  const x0 = view.x + (view.width - w) / 2;
  const y0 = view.y + (view.height - h) / 2;
  return {
    x: Math.floor(x0 / lat.stepX) * lat.stepX,
    y: Math.floor(y0 / lat.stepY) * lat.stepY,
    width: w,
    height: h,
  };
}
