/* THE CLIP LIGHT'S BOUND AND EASE — pure (no DOM), see lightanim.ts for the
 * dials that feed it. */
/* THE SWING IS BOUNDED AND EASED, WHATEVER THE DIAL. A clip's per-frame
 * intensities are art noise around 1 (a hearth's five frames read 0.85..1.25),
 * and the intensity dial multiplies the swing up to 20x: at that end a 0.85
 * frame is 1 + (−0.15 × 20) = −2, floored to 0.05 — the light goes out for
 * that frame and a wall hanging lit by it alone snaps bright/dark at 8 fps
 * (maintainer 2026-09-17, the house at the hearth: "a real fire can't flip the
 * light on a wall scenery this much while burning"; reproduced headless with
 * both dials at 20: the hanging's luma 38 → 54 → 44 → 38 across one play).
 * The applied intensity therefore lives in [LIGHT_ANIM_I_MIN, LIGHT_ANIM_I_MAX]
 * and the centre offset within LIGHT_ANIM_POS_MAX cells, and both EASE toward
 * the frame's target with LIGHT_ANIM_EASE_MS (a fire's brightness changes
 * continuously; an 8 fps step is a snap). The dials keep their range — past
 * ~3x they only reach the bound sooner. */
export const LIGHT_ANIM_I_MIN = 0.6;
export const LIGHT_ANIM_I_MAX = 1.5;
export const LIGHT_ANIM_POS_MAX = 0.35;
export const LIGHT_ANIM_EASE_MS = 90;

export interface LightFrameState {
  i: number;
  dcol: number;
  drow: number;
}

/** The frame's target through the dials, bounded. */
export function boundLightFrame(intensity: number, dcol: number, drow: number, tune: { intensity: number; position: number }): LightFrameState {
  const i = Math.max(LIGHT_ANIM_I_MIN, Math.min(LIGHT_ANIM_I_MAX, 1 + (intensity - 1) * tune.intensity));
  const lim = (v: number) => Math.max(-LIGHT_ANIM_POS_MAX, Math.min(LIGHT_ANIM_POS_MAX, v * tune.position));
  return { i, dcol: lim(dcol), drow: lim(drow) };
}

/** One step of the ease from `prev` toward `target` after `dtMs`. */
export function easeLightFrame(prev: LightFrameState, target: LightFrameState, dtMs: number): LightFrameState {
  const k = dtMs <= 0 ? 0 : 1 - Math.exp(-dtMs / LIGHT_ANIM_EASE_MS);
  return { i: prev.i + (target.i - prev.i) * k, dcol: prev.dcol + (target.dcol - prev.dcol) * k, drow: prev.drow + (target.drow - prev.drow) * k };
}

export const LIGHT_FRAME_REST: LightFrameState = { i: 1, dcol: 0, drow: 0 };
export const atLightRest = (s: LightFrameState): boolean => Math.abs(s.i - 1) < 0.004 && Math.abs(s.dcol) < 0.002 && Math.abs(s.drow) < 0.002;
