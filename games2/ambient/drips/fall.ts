/* CAVE DRIPS — the pure half. No Phaser, no DOM: the timeline of one drip point
 * (a drop swells at the ceiling, lets go, falls, splashes, and the next one
 * starts forming) and the geometry of its splash are arithmetic here so
 * `server/test/drips.test.ts` can pin them, and drips.ts only pools sprites
 * and reads the clock.
 *
 * WHAT A CAVE DRIP IS, at this scale: a POINT that keeps dripping. One drop is
 * four pixels and gone in a third of a second; what the eye reads is that the
 * same spot on the floor takes a drop every few seconds, and the ring it leaves.
 * So the unit is a SPOUT with a period, not a rain of independent drops, and
 * a spout lives as long as its floor cell is on screen.
 *
 * THE FALL IS SCREEN GRAVITY. The room's underside is `__ml.indoor().ceiling`
 * (levels) and the floor is the room's elevation, so the drop starts
 * (ceiling - floor) x LH px above its landing point — in the cut-away the
 * ceiling is not drawn, so the drop appears out of the dark above the walls,
 * which is exactly where a cave's ceiling is. It falls under a constant
 * acceleration and takes about a third of a second over 90 px; a drop that
 * glided down at one speed read as a floating mote.
 *
 * THE SPLASH IS AN ISO ELLIPSE (runtime/ellipse.ts), small — a drop is not a
 * stone — at whole-pixel radii, with a one-frame flash at impact so the eye
 * catches the moment even at a phone's frame rate.
 */

/** Px per level (ISO_GEOMETRY_MAPS3.lh); the fall height is levels x this. */
export const LH = 15;
/** The fall height in LEVELS is clamped to this: a room reporting no ceiling
 *  still drips from somewhere, and a 30-level mountain does not drop water
 *  from off the top of the screen. */
export const FALL_LEVELS: [number, number] = [2, 6];
/** How long a drop swells at the ceiling before it lets go. */
export const HANG_MS: [number, number] = [700, 2200];
/** Screen gravity, px/s^2 — 90 px in ~0.48 s. */
export const FALL_G = 780;
/** The splash: ring life, radii (world px along x), the impact flash, specks. */
export const SPLASH_MS = 360;
export const RING_R0 = 1;
export const RING_RMAX = 5;
export const FLASH_MS = 80;
export const SPECK_N = 2;
export const SPECK_MS = 260;
/** Ms from one drop's release to the next, per spout — and each interval is
 *  jittered so two spouts never lock into step. */
export const PERIOD: [number, number] = [2200, 6500];
export const PERIOD_JITTER = 0.25;

export type Phase = "hang" | "fall" | "splash" | "wait";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** THE INDOOR GAIN IS THE OUTDOOR GAIN'S MIRROR. Every outdoor feature fades
 *  on `ctx.outdoor`, an eased copy of the game's own indoor crossing; a feature
 *  that lives under a roof multiplies by 1 - that, so it fades IN as the roof
 *  is cut away and OUT on the way back into the open, frame for frame with the
 *  room itself. One number, never a second controller that could drift. */
export function indoorGain(outdoor: number): number {
  return 1 - clamp01(outdoor);
}

/** IS THIS CELL UNDER A CAVE? The world doc's decks carry a KIND — `roof` over
 *  a house, `bridge`, `cave` for a hollow in the rock — and `__ml.t3at` reports
 *  the slabs over a cell with it. A house has a ceiling too, and a cottage that
 *  drips is a leak, not a mood; so the slab over the floor must be a cave's.
 *  Absent or reshaped data reads as "not a cave": no drips, never an error. */
export function isCaveDecks(
  decks: ReadonlyArray<{ kind?: string | null; level?: number }> | null | undefined,
  floorLvl: number,
): boolean {
  if (!Array.isArray(decks)) return false;
  return decks.some((d) => d && d.kind === "cave" && typeof d.level === "number" && d.level > floorLvl);
}

/** Px from the ceiling to the floor: (ceiling - floor) levels x LH, clamped. A
 *  missing ceiling (older probe, no deck data) falls from the clamp's middle. */
export function fallHeightPx(ceilingLvl: number | null | undefined, floorLvl: number | null | undefined): number {
  const [lo, hi] = FALL_LEVELS;
  const levels =
    typeof ceilingLvl === "number" && typeof floorLvl === "number" && Number.isFinite(ceilingLvl - floorLvl)
      ? ceilingLvl - floorLvl
      : (lo + hi) / 2;
  return Math.round(Math.min(hi, Math.max(lo, levels)) * LH);
}

/** How long a drop takes to fall `h` px under FALL_G. */
export function fallMs(h: number): number {
  return Math.sqrt((2 * Math.max(0, h)) / FALL_G) * 1000;
}

/** Px fallen after `t` ms — accelerating, never past the floor. */
export function fallY(t: number, h: number): number {
  const s = Math.max(0, t) / 1000;
  return Math.min(h, 0.5 * FALL_G * s * s);
}

/** The hanging drop's size in px: a pixel while it forms, two once it has
 *  swelled (the second half of the hang) — the swell is what says "about to
 *  fall" before anything moves. */
export function hangSize(t: number, hang: number): 1 | 2 {
  return t >= hang * 0.45 ? 2 : 1;
}

/** ...and its opacity: brightens out of nothing over the first half of the
 *  hang and holds, so it is never switched on. */
export function hangAlpha(t: number, hang: number): number {
  if (t < 0) return 0;
  return Math.pow(clamp01(t / Math.max(1, hang * 0.5)), 0.7) * 0.9;
}

/** The splash ring's radius at an age, in world px along x. Decelerating and
 *  whole-pixel, like the fish's, but a drop's ring: at most RING_RMAX. */
export function ringR(age: number): number {
  const t = clamp01(age / SPLASH_MS);
  return Math.max(RING_R0, Math.round(RING_R0 + (RING_RMAX - RING_R0) * Math.pow(t, 0.6)));
}

/** ...and its opacity: a quick attack (a line, not a fade-in), then decay to
 *  nothing by SPLASH_MS. */
export function ringAlpha(age: number): number {
  if (age < 0 || age >= SPLASH_MS) return 0;
  const t = age / SPLASH_MS;
  return Math.min(1, t / 0.12) * Math.pow(1 - t, 1.2);
}

/** The impact flash: full at the moment of contact, gone in FLASH_MS. */
export function flashAlpha(age: number): number {
  if (age < 0 || age >= FLASH_MS) return 0;
  return 1 - age / FLASH_MS;
}

/** One splash speck: thrown up and to one side, back down — whole pixels, so
 *  it hops rather than glides. Two specks, left and right. */
export function speckAt(i: number, age: number): { dx: number; dy: number; alive: boolean } {
  if (age < 0 || age >= SPECK_MS) return { dx: 0, dy: 0, alive: false };
  const t = age / SPECK_MS;
  const side = i % 2 === 0 ? 1 : -1;
  const reach = 2 + Math.floor(i / 2);
  return {
    dx: Math.round(side * reach * t),
    // up then down: a symmetric hop in screen y that PEAKS at two whole pixels
    // (the first curve peaked at 1.36 and rounded to one — a speck that hops one
    // pixel reads as a stationary dot) and is back on the floor at the end
    dy: -Math.round(2.4 * 4 * t * (1 - t)),
    alive: true,
  };
}

/** The next interval from one release to the next, jittered. */
export function nextPeriod(rnd: () => number): number {
  const base = PERIOD[0] + rnd() * (PERIOD[1] - PERIOD[0]);
  return Math.round(base * (1 + (rnd() * 2 - 1) * PERIOD_JITTER));
}

/** The phase boundaries of one drop from the start of its hang, so a pool can
 *  step a spout with one clock: hang, then fall, then splash, then wait until
 *  the period is up (the wait is never negative — a slow period still leaves
 *  the ring its whole life). */
export function timeline(hang: number, h: number, period: number): { fallAt: number; splashAt: number; doneAt: number; nextAt: number } {
  const fallAt = hang;
  const splashAt = fallAt + fallMs(h);
  const doneAt = splashAt + SPLASH_MS;
  return { fallAt, splashAt, doneAt, nextAt: Math.max(doneAt, fallAt + period) };
}

/** Which phase a spout is in at `t` ms into its cycle. */
export function phaseAt(t: number, tl: { fallAt: number; splashAt: number; doneAt: number; nextAt: number }): Phase {
  if (t < tl.fallAt) return "hang";
  if (t < tl.splashAt) return "fall";
  if (t < tl.doneAt) return "splash";
  return "wait";
}
