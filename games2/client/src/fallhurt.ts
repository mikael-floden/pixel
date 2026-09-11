// ============================================================================
// THE FALL FLINCH — its GOT-HIT FRAME lands on the frame the feet do
// ============================================================================
//
// A cliff fall is billed on impact (server `fallPend`), and its patch reaches
// the client a round trip after that, so a flinch triggered by `hitSeq` starts
// with the body already on the ground — and then spends its wind-up frames
// there before folding. The maintainer watched it and said (2026-09-11): "I
// feel the players 'take dmg' animation is not in sync with the frame we hit
// the ground ... start the animation a little bit earlier so the 'hit' frame is
// in sync with hitting the ground ... play the animation a bit faster so
// starting it earlier doesn't look too bad in the air. The combination will
// make this perfect."
//
// Both of those, and they are ONE number each:
//
//   RATE  the fall's flinch runs FALL_HURT_RATE× the combat rate. Combat's own
//         ANIM_FPS.hurt is untouched — 16 fps is his round-7 tuning for being
//         punched, where there is no air to cross.
//   LEAD  the clip starts `hurtLeadMs` early — the frames BEFORE the got-hit
//         frame, at that rate. At the shipped numbers: 3 frames of a 5-frame
//         clip at 24 fps, so 125 ms of bracing in the air over a 208 ms clip.
//
// HIS FRAME, counted HIS WAY: "the 4th frame is the 'got hit frame'" — index 3,
// the doubled-over pose carrying the impact mark (0-2 stand, lean and hunch).
// Clamped to the clip, so art with fewer frames leads by what it has rather
// than by longer than it lasts.
//
// Pure, and split out of WorldScene.ts, so the arithmetic that has to hold —
// the got-hit frame is the frame on screen at touchdown — is unit-tested
// instead of eyeballed (server/test/collision.test.ts).

/** The fall flinch's playback rate, as a multiple of the combat flinch's. */
export const FALL_HURT_RATE = 1.5;

/** The got-hit frame, 0-based: the maintainer's 4th. */
export const HURT_IMPACT_FRAME = 3;

/** Frames before the got-hit frame in a clip of `frames`, clamped to it. */
export function hurtLeadFrames(frames: number): number {
  return Math.min(HURT_IMPACT_FRAME, Math.max(0, Math.floor(frames) - 1));
}

/** How early the clip must START for its got-hit frame to be on screen the
 *  instant the feet land. */
export function hurtLeadMs(frames: number, baseFps: number, rate: number = FALL_HURT_RATE): number {
  return (hurtLeadFrames(frames) / (baseFps * rate)) * 1000;
}

/** Which frame of the clip is on screen `ms` after it started — the same floor
 *  Phaser's animation clock does. Past the end returns `frames` (finished). */
export function hurtFrameAt(ms: number, frames: number, baseFps: number, rate: number = FALL_HURT_RATE): number {
  return Math.floor((ms / 1000) * baseFps * rate);
}

/** The whole clip's length at the fall rate. */
export function hurtClipMs(frames: number, baseFps: number, rate: number = FALL_HURT_RATE): number {
  return (Math.floor(frames) / (baseFps * rate)) * 1000;
}
