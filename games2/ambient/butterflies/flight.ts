/* A BUTTERFLY'S FLIGHT — the pure half, so `server/test/butterflies.test.ts`
 * can pin what makes it a butterfly and butterflies.ts only pools sprites.
 *
 * At four pixels a butterfly is not a shape, it is a WAY OF MOVING, and three
 * things carry it:
 *
 *   THE BOB. The body rises and falls with every wingbeat. This is the single
 *   strongest cue — a mark that slides level across the grass reads as a bee
 *   however it is drawn — and it is why the beat drives the vertical offset
 *   here rather than being a separate animation.
 *
 *   THE FLICK. A butterfly does not turn, it CHANGES ITS MIND: short runs
 *   broken by sudden hard turns. A smoothly curving path reads as a bird.
 *
 *   THE BEAT IS UNEVEN. Equal frames at an equal rate read as a machine, so
 *   the open frame is held longer than the closed one and the period itself
 *   wanders per butterfly.
 *
 * Pixel-art rules: the bob is whole pixels and the wings are three drawn
 * frames whose SILHOUETTE WIDTH changes (5 px open, 3 half, 1 closed), which
 * is what makes a flutter legible at this size. No rotation, ever.
 */

export const WING_CLOSED = 0;
export const WING_HALF = 1;
export const WING_OPEN = 2;
export type Wing = 0 | 1 | 2;

/** Wingbeat period, ms. Fast, and different per butterfly. */
export const BEAT_MS: readonly [number, number] = [150, 240];
/** How far the body rises over a beat, px. */
export const BOB_PX: readonly [number, number] = [2, 4];

/** THE BEAT IS UNEVEN: the wings are OPEN for about half the cycle, half-way
 *  for a third, and fully closed only briefly. An even three-way split ticks
 *  like a metronome. */
export function wing(t: number, periodMs: number, phase: number): Wing {
  const u = ((t / periodMs + phase) % 1 + 1) % 1;
  if (u < 0.46) return WING_OPEN;
  if (u < 0.8) return WING_HALF;
  return WING_CLOSED;
}

/** The body's rise over the beat, in whole px ABOVE the flight line (so it is
 *  returned negative, screen y going down). Highest as the wings close. */
export function bob(t: number, periodMs: number, phase: number, amp: number): number {
  const u = ((t / periodMs + phase) % 1 + 1) % 1;
  return -Math.round(amp * Math.sin(u * Math.PI));
}

/** How long between hard turns, ms. */
export const FLICK_MS: readonly [number, number] = [260, 900];
/** How far a flick turns, radians. Big enough to read as a change of mind. */
export const FLICK_RAD: readonly [number, number] = [0.5, 1.7];
/** And the gentle drift between flicks, radians per second. */
export const DRIFT_RAD_S = 0.9;

/** The heading after `dt` ms of drift, and a flick of `turn` when one is due.
 *  Kept pure so the test can drive it with a fixed sequence. */
export function steer(h: number, dt: number, drift: number, turn: number): number {
  return h + drift * DRIFT_RAD_S * (dt / 1000) + turn;
}

/** Ground speed, px/s. A butterfly is slow, and it slows further as it
 *  climbs — the pulse is what stops it looking towed. */
export const SPEED: readonly [number, number] = [14, 30];
export function speedAt(base: number, t: number, periodMs: number, phase: number): number {
  const u = ((t / periodMs + phase) % 1 + 1) % 1;
  return base * (0.72 + 0.55 * Math.max(0, Math.sin(u * Math.PI)));
}

/* IT WORKS A PATCH. A butterfly placed on grass and left to drift ends up over
 * the dirt path and the paved yard beside it — measured, 30 of 155 sampled
 * positions on a mixed view. The fix is not a per-frame ground probe (two
 * probes a butterfly a frame; `groundSoundAt` is a placement call and says so)
 * but the behaviour real butterflies have: they stay around the flowers they
 * found. Past HOME_R from the spot it was placed on, the drift bends back. */
export const HOME_R = 70;
/** How hard it bends back, rad/s, at its strongest. */
export const HOME_TURN = 1.6;

/** The extra turn over `dt` ms that pulls a butterfly back to its patch.
 *  `dx`/`dy` point FROM the butterfly TO home, in GROUND-PLANE px (the caller
 *  undoes the iso squash first, or the pull is lopsided). Zero inside the
 *  patch, so it is a boundary and never a leash. */
export function homePull(h: number, dx: number, dy: number, dt: number): number {
  const r = Math.hypot(dx, dy);
  if (r <= HOME_R) return 0;
  const want = Math.atan2(dy, dx);
  let diff = (want - h) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  const strength = Math.min(1, (r - HOME_R) / HOME_R);
  const most = HOME_TURN * strength * (dt / 1000);
  return Math.max(-most, Math.min(most, diff));
}

/** Flight altitude above the ground, px: low, and it settles now and then. */
export const ALT: readonly [number, number] = [7, 34];
/** A settle: down to the ground, wings shut, for a moment. */
export const SETTLE_EVERY: readonly [number, number] = [4000, 14000];
export const SETTLE_MS: readonly [number, number] = [700, 2400];
/** How long the drop and the lift take. */
export const LAND_MS = 420;

/** Altitude while settling: down over LAND_MS, held, then back up. `t` is ms
 *  since the settle began and `hold` its held length. */
export function settleAlt(t: number, hold: number, cruise: number): number {
  if (t <= 0) return cruise;
  if (t < LAND_MS) return cruise * (1 - t / LAND_MS);
  if (t < LAND_MS + hold) return 0;
  const up = t - LAND_MS - hold;
  if (up < LAND_MS) return cruise * (up / LAND_MS);
  return cruise;
}

/** Total length of one settle. */
export function settleLife(hold: number): number {
  return LAND_MS + hold + LAND_MS;
}

/** Sitting still with the wings shut is the whole point of a settle: a
 *  butterfly on the ground is a thin sliver, not a flapping thing. */
export function settled(t: number, hold: number): boolean {
  return t >= LAND_MS && t < LAND_MS + hold;
}
