/* A DRAGONFLY'S FLIGHT — the pure half, so `server/test/dragonflies.test.ts`
 * can pin what makes it a dragonfly and `dragonflies.ts` only pools sprites.
 *
 * IT IS THE OPPOSITE OF THE BUTTERFLY, and that contrast is the whole reason
 * to build it. A butterfly never stops: it bobs, it drifts, it changes its
 * mind. A dragonfly is STILL, then a STRAIGHT LINE, then still again. Three
 * states and nothing between them:
 *
 *   HOVER  — it holds one point in the air. Not drifting, not circling:
 *            parked, with a pixel of jitter so it reads as flight rather than
 *            as a sprite someone forgot to move.
 *   DART   — a straight segment at speed, ending dead. No easing out: a
 *            dragonfly arrives at full tilt and stops, which is the single
 *            most recognisable thing about it. Easing the ends turns it into
 *            a bee.
 *   PERCH  — settled on a reed tip or a lily with its wings still OUT (a
 *            butterfly folds its wings up; a dragonfly never does), for a
 *            good long while.
 *
 * The wings are a BLUR, not frames. At this size a beating wing is four
 * hundred a second — there is no pose to draw, only a smear, so the flying
 * frame carries a faint horizontal haze and the perched frame carries two
 * crisp pairs.
 */

/** Wing states: a blur in the air, held out at rest. */
export const WING_BLUR = 0;
export const WING_OUT = 1;
export type Wing = 0 | 1;

/** What it is doing. */
export const HOVER = 0;
export const DART = 1;
export const PERCH = 2;
export type Mode = 0 | 1 | 2;

/** How long it holds a hover, ms. */
export const HOVER_MS: readonly [number, number] = [700, 2600];
/** How long a perch lasts, ms — much longer than anything else it does. */
export const PERCH_MS: readonly [number, number] = [2600, 9000];
/** Dart speed, px/s on the ground plane. Fast: this is the fastest thing
 *  ambient draws, and it should read that way. */
export const DART_SPEED: readonly [number, number] = [150, 260];
/** How far one dart travels, px. */
export const DART_LEN: readonly [number, number] = [26, 96];
/** The hover's jitter, px — one pixel, occasionally two. */
export const JITTER_PX = 1.4;
/** Cruising height over the water, px. */
export const ALT: readonly [number, number] = [10, 26];
/** Ground-plane squash: a step is this much shorter down the screen. */
export const ISO_SQUASH = 14 / 32;

/** How long a dart of `len` px takes at `speed` px/s. */
export function dartMs(len: number, speed: number): number {
  return (Math.abs(len) / Math.max(1, speed)) * 1000;
}

/** How far along a dart at age `t`, 0..1. LINEAR ON PURPOSE — see the file
 *  note: easing the ends of the segment is what turns a dragonfly into a bee.
 *  It leaves at full speed and it stops dead. */
export function dartAt(t: number, ms: number): number {
  if (ms <= 0) return 1;
  return Math.max(0, Math.min(1, t / ms));
}

/** The hover's wobble at time `t`, in px. Deterministic from the phase so a
 *  dragonfly does not twitch differently every frame it is looked at, and
 *  WHOLE PIXELS, because a sub-pixel wobble at this size is a blur. */
export function hoverJitter(t: number, phase: number): { x: number; y: number } {
  const a = t / 1000 + phase * 10;
  return {
    x: Math.round(Math.sin(a * 5.7) * JITTER_PX),
    y: Math.round(Math.sin(a * 4.1 + 1.7) * JITTER_PX * 0.7),
  };
}

/** Which wing frame a mode draws. Perched is the ONLY time the wings resolve;
 *  everything else is a blur. */
export function wingOf(mode: Mode): Wing {
  return mode === PERCH ? WING_OUT : WING_BLUR;
}

/** A dragonfly faces along its dart and keeps that heading while it hovers —
 *  it does not spin on the spot. Returns -1 (left) or 1 (right) for the
 *  drawn flip, unchanged when the movement is too small to mean anything. */
export function facing(dx: number, was: number): number {
  if (Math.abs(dx) < 0.5) return was;
  return dx < 0 ? -1 : 1;
}

/** Altitude while settling onto a perch or lifting off it: `t` ms into a
 *  move of `ms`, between `from` and `to`. Straight, like everything else it
 *  does. */
export function perchAlt(t: number, ms: number, from: number, to: number): number {
  const u = ms <= 0 ? 1 : Math.max(0, Math.min(1, t / ms));
  return from + (to - from) * u;
}

/* THE COLOURS, here rather than in the feature so the tests can hold them to
 * the domain's saturation cap without pulling Phaser in.
 *
 * Real darters are vivid — electric blue, scarlet, metallic green — and his
 * game is not. "No extreme/vibrant colors. This is a background effect" was
 * the note on the butterflies and it is not about butterflies, so these are
 * slate, olive, dusty brown and a grey-teal. The WING BLUR is always paler
 * and fainter than the body it crosses: a wing you can see the reeds through
 * is what makes it read as beating rather than as a drawn pair. */
export const BODIES: readonly number[] = [0x5c6f7a, 0x6b7355, 0x7a6353, 0x55666b];
export const BLUR = 0xbfc7cc;
