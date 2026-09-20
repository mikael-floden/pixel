/** THE DOORWAY CROSSING'S CURVES — pure functions of the eased indoor mix, so
 *  the crossfade can be reasoned about (and gated) without a browser.
 *
 *  ONE SUBSTRATE, THREE CURVES. `mix` is the raw exponential roll (0 outdoors,
 *  1 indoors; INDOOR_TAU; his speed dial multiplies its rate). Everything that
 *  crosses is a function of the mix and never of the clock, so the dial and a
 *  starved frame stretch the whole crossing together and its proportions hold:
 *
 *    grade   — the LIGHT: the outside fading to black, the room's ambient, every
 *              CPU light gain. 1.5x the roll (maintainer 2026-08-13: "a bit
 *              faster" than the roll, deliberately NOT roof-fast — everything
 *              at 3x read as one big snap). Lands at mix 2/3 entering, 1/3
 *              leaving; the leaving landing is when the real repaint swaps in.
 *    debris  — the COVER: the roof slab and the wall bands the cut removes,
 *              rebuilt as world-anchored images. 3x the roll (his: 2x was not
 *              enough); entering, opaque at the flip and gone by mix 1/3;
 *              leaving, opaque by mix 2/3 and held through the landing. Its
 *              whole job is hiding the repaint seams, and seams hide better
 *              the less time they get.
 *    roofed  — the FURNITURE under the cut roof (base sprite, lit copy, fog):
 *              a subject of the crossing, not cover. Entering it arrives with
 *              the room's light (the grade — on the debris' curve it stood
 *              solid a third of a roll before the room was lit, maintainer
 *              2026-09-18). LEAVING IT IS GONE WHEN THE ROOF IS OPAQUE: the
 *              lit copy draws above the darkness overlay and the base sprite
 *              sorts against the roof's own rows, so anything of it left at
 *              the grade (0.5 with the roof already solid, 0.38 in his frame)
 *              is a half-transparent table standing ON the roof (maintainer
 *              2026-09-20: "it looks a bit ugly that we can see the scenery
 *              through the roof during the animation ... the outdoor to
 *              indoor fade looks much better"). So it wears the LESSER of the
 *              grade and the debris' complement — entering that is the grade
 *              (the roof dissolves faster than the light lands), leaving it is
 *              the roof's complement, 0 from mix 2/3 on.
 *    aboveCut — what stands ON the lid (a chimney, a tree on a cave's mountain):
 *              the complement of the grade, the way the roof's LIGHT goes.
 *
 *  THE ROLL BILLS WALL CLOCK, CAPPED — and the cap has two sizes. Phaser's
 *  loop delta is smoothed and clamped, so the roll advanced per FRAME until
 *  2026-09-18 and a starved device crawled through the crossing; now each ease
 *  bills the real elapsed time. The FLIP'S OWN FRAME is the exception: its
 *  repaint (the ground RT, ~3,900 occluders, the debris) is the crossing's
 *  own cost, 150-490 ms on his phone, and it must not be spent as fade time
 *  — the roof would be gone before the first blended frame. That frame bills
 *  INDOOR_FLIP_STEP_CAP_MS across the two eases that see it (its update, then
 *  its render). EVERY OTHER FRAME BILLS WHAT IT TOOK, up to INDOOR_STEP_CAP_MS:
 *  with the 60 ms cap on every frame a cold start — the first minute after a
 *  restart, when his beacon shows 150-500 ms frames while the art decodes —
 *  billed a 300 ms frame as 60 and stretched the 0.4 s crossing to 1.5-2 s
 *  (maintainer 2026-09-20: "the house is at first lighten up differently and
 *  a bit later it get the real lights"; the same walk a minute later was
 *  right, and every re-entry after it). Measured on the beacon's cold window
 *  (490, 300, 300, 300 ms, then 17 ms frames): the light lands 1.65 s after
 *  the flip on the old rule and 0.8 s on this one, with the first blended
 *  frame at the same place in both. The large cap still refuses a tab wakeup
 *  or a multi-second GC pause the whole curve in one step (≤ 49% of the
 *  remaining distance per frame).
 */

export const INDOOR_TAU = 0.45;
export const INDOOR_DEBRIS_RATE = 3;
export const INDOOR_GRADE_RATE = 1.5;
/** The most wall clock an ease may bill while the flip's own frame is being
 *  paid for (its update and its render: the two eases after a flip). */
export const INDOOR_FLIP_STEP_CAP_MS = 60;
/** ...and on any other frame: a slow device gets the crossing at its tuned
 *  length in fewer frames, and a stall still cannot cross a whole curve. */
export const INDOOR_STEP_CAP_MS = 300;
/** How many eases after a flip bill at the flip cap. */
export const INDOOR_FLIP_EASES = 2;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The LIGHT grade, 0..1, for a raw mix and the geometric state. */
export function indoorGradeOf(mix: number, inside: boolean): number {
  const R = INDOOR_GRADE_RATE;
  return clamp01(inside ? R * mix : R * mix - (R - 1));
}

/** The debris (cover) layer's opacity, 0..1. */
export function debrisAlphaOf(mix: number, inside: boolean): number {
  const D = INDOOR_DEBRIS_RATE;
  return clamp01(inside ? 1 - D * mix : D * (1 - mix));
}

/** The furniture under the cut roof: base sprite, lit copy and fog alike. */
export function roofedAlphaOf(mix: number, inside: boolean): number {
  const g = indoorGradeOf(mix, inside);
  return inside ? g : Math.min(g, 1 - debrisAlphaOf(mix, inside));
}

/** What stands on the lid: the complement of the light grade. */
export function aboveCutAlphaOf(mix: number, inside: boolean): number {
  return clamp01(1 - indoorGradeOf(mix, inside));
}

/** What one ease bills of the wall clock that passed since the last one. */
export function easeStepMs(rawMs: number, flipEasesLeft: number): number {
  const cap = flipEasesLeft > 0 ? INDOOR_FLIP_STEP_CAP_MS : INDOOR_STEP_CAP_MS;
  return Math.max(0, Math.min(cap, rawMs));
}

/** One step of the roll: the exponential ease toward `to` over `stepMs` at
 *  `speed`x, snapped when within 0.005 so it settles exactly. */
export function rollMix(mix: number, to: 0 | 1, stepMs: number, speed = 1): number {
  const k = 1 - Math.exp(-((stepMs / 1000) * speed) / INDOOR_TAU);
  let next = mix + (to - mix) * k;
  if (Math.abs(next - to) < 0.005) next = to;
  return next;
}

/** Replay a crossing over a list of frame lengths (ms, wall clock) from the
 *  flip, billing each as the scene does; returns the mix after each frame and
 *  the wall-clock time at which the light grade lands (null if it never does).
 *  The instrument for the step-cap rule: no browser, no Phaser. */
export function replayCrossing(frames: number[], inside: boolean, speed = 1, capEveryFrameMs?: number): { mix: number[]; landedAtMs: number | null } {
  let mix = inside ? 0 : 1;
  let t = 0;
  let flipEases = INDOOR_FLIP_EASES;
  const out: number[] = [];
  let landed: number | null = null;
  for (const raw of frames) {
    t += raw;
    const step = capEveryFrameMs !== undefined ? Math.max(0, Math.min(capEveryFrameMs, raw)) : easeStepMs(raw, flipEases);
    if (flipEases > 0) flipEases--;
    mix = rollMix(mix, inside ? 1 : 0, step, speed);
    out.push(mix);
    const g = indoorGradeOf(mix, inside);
    if (landed === null && (inside ? g >= 1 : g <= 0)) landed = t;
  }
  return { mix: out, landedAtMs: landed };
}
