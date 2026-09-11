/* A FALLING FEATHER — the pure half, so `server/test/feathers.test.ts` can pin
 * the motion and feathers.ts only pools sprites.
 *
 * WHAT MAKES IT READ AS A FEATHER rather than as dropped litter is that it
 * does NOT fall straight. It sinks slowly and swings side to side, and the
 * swing and the tilt are the same motion: a feather leans into the direction
 * it is sliding and flips over at the end of each swing. So the horizontal
 * offset is a sine and the tilt frame is the SIGN OF ITS DERIVATIVE — one
 * function, which is why the two can never disagree on screen.
 *
 * Pixel-art rules: the swing is rounded to whole pixels and the tilt is three
 * drawn frames, never a rotation. A rotated 4-px sprite resamples into mush.
 */

/** How fast it sinks, px per second. A feather takes its time. */
export const FALL_SPEED = 16;
/** THE WINGBEAT THAT KNOCKS IT LOOSE. A flushed bird is STANDING ON THE
 *  GROUND — that is what "low enough to be spooked" means — so a feather shed
 *  at its altitude has nowhere to fall and simply appears lying there, which
 *  is the whole effect missing (measured: 7 birds flushed, 9 feathers shed, 0
 *  of them sank). The bird beats its wings hard to get up, and the feather
 *  goes UP with it before it starts down. That kick is where the fall comes
 *  from, and it is why a feather from a standing bird still flutters. */
export const LIFT_MS = 420;
export const LIFT_PX: readonly [number, number] = [10, 19];
/** The swing: how far to each side, and how long a full left-right-left takes. */
export const SWING_AMP: readonly [number, number] = [3, 7];
export const SWING_MS: readonly [number, number] = [800, 1500];
/** Once down, how long it lies there before it fades, and the fade itself. */
export const REST_MS: readonly [number, number] = [2200, 4800];
export const FADE_MS = 900;
/** Nothing sheds from higher than this: only a LOW bird is spooked, and a
 *  feather from the cruising altitude would fall for half a minute. */
export const MAX_ALT = 46;

export const TILT_LEFT = 0;
export const TILT_FLAT = 1;
export const TILT_RIGHT = 2;
export type Tilt = 0 | 1 | 2;

/** How far it has sunk, px, in `t` ms of falling. */
export function fallen(t: number): number {
  return (Math.max(0, t) / 1000) * FALL_SPEED;
}

/** ITS HEIGHT ABOVE THE GROUND at age `t`: carried up by the wingbeat to a
 *  peak, then sinking at FALL_SPEED until it touches down. `alt0` is the
 *  bird's own altitude when it shed (usually 0 — it was standing). */
export function height(t: number, alt0: number, kick: number): number {
  const base = Math.max(0, Math.min(MAX_ALT, alt0));
  if (t <= 0) return base;
  if (t < LIFT_MS) {
    const u = t / LIFT_MS;
    return base + kick * (1 - (1 - u) * (1 - u)); // ease out to the peak
  }
  return Math.max(0, base + kick - fallen(t - LIFT_MS));
}

/** When it touches down, ms. */
export function landAt(alt0: number, kick: number): number {
  const base = Math.max(0, Math.min(MAX_ALT, alt0));
  return LIFT_MS + ((base + kick) / FALL_SPEED) * 1000;
}

/** The swing, in whole px either side of where it was shed. */
export function swing(t: number, amp: number, periodMs: number, phase: number): number {
  return Math.round(amp * Math.sin((t / periodMs) * 2 * Math.PI + phase));
}

/** THE TILT IS THE SWING'S DERIVATIVE — leaning into the slide, flat at the
 *  turn. Sharing one phase is what keeps the drawn lean and the drawn motion
 *  from disagreeing. */
export function tilt(t: number, periodMs: number, phase: number): Tilt {
  const v = Math.cos((t / periodMs) * 2 * Math.PI + phase);
  if (v > 0.35) return TILT_RIGHT;
  if (v < -0.35) return TILT_LEFT;
  return TILT_FLAT;
}

/** Total life of one feather: the lift, the fall, the rest, the fade. */
export function featherLife(alt0: number, kick: number, restMs: number): number {
  return landAt(alt0, kick) + restMs + FADE_MS;
}

/** Opacity at age `t`: solid while it falls and lies, then out. */
export function featherAlpha(t: number, alt0: number, kick: number, restMs: number): number {
  const life = featherLife(alt0, kick, restMs);
  if (t < 0 || t >= life) return 0;
  const fadeFrom = life - FADE_MS;
  if (t <= fadeFrom) return 1;
  return 1 - (t - fadeFrom) / FADE_MS;
}

/** Where it is at age `t`, RELATIVE TO WHERE IT WAS SHED (the bird's drawn
 *  position), and whether it has come to rest. `dy` is positive downward, so
 *  it goes NEGATIVE during the wingbeat lift. */
export function featherAt(
  t: number,
  alt0: number,
  kick: number,
  amp: number,
  periodMs: number,
  phase: number,
): { dx: number; dy: number; tilt: Tilt; down: boolean } {
  const base = Math.max(0, Math.min(MAX_ALT, alt0));
  const land = landAt(alt0, kick);
  if (t >= land) {
    // it settles where the swing left it, and stops moving
    return { dx: swing(land, amp, periodMs, phase), dy: base, tilt: TILT_FLAT, down: true };
  }
  return {
    dx: swing(t, amp, periodMs, phase),
    dy: base - height(t, alt0, kick),
    tilt: tilt(t, periodMs, phase),
    down: false,
  };
}
