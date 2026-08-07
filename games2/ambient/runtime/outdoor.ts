/** OUTDOOR GAIN — one dial that fades every ambient effect out when the player
 * steps inside (maintainer 2026-08-07).
 *
 * Every effect this agent ships is an OUTDOOR effect: birds, bats, pollen,
 * fireflies, leaves, sandstorm, thunder, water glints. They are drawn in world
 * space above the terrain, so when the player walks into a house or a cave the
 * game cuts the roof away and the weather keeps falling through the room. They
 * have to stop.
 *
 * WHY THIS IS A GAIN AND NOT AN `if (indoor) return`
 * The in/out transition SNAPS today, so this is a hard 1 -> 0 and an `if` would
 * look identical on screen. But the game plans to make that crossing a fade,
 * and at that point every effect must fade with it or the ambience will pop off
 * a beat before the room arrives. Writing it as a 0..1 gain now means the fade
 * costs one constant later instead of a pass over eight features — and the
 * partial values are already threaded through every draw path, so there is
 * nothing left to discover when it happens.
 *
 * TO TURN THE SNAP INTO A FADE, pick one:
 *   • set OUTDOOR_FADE_MS to the crossing's duration; or
 *   • better, once the game publishes a 0..1 crossing of its own, feed that
 *     straight in via `set()` — `__ml.indoor().mix` is already an eased blend
 *     (INDOOR_TAU) and is the natural source, so the two can never disagree
 *     about how far through the doorway the player is.
 * Nothing else has to change.
 */

/** Milliseconds for the gain to cross between outdoors (1) and indoors (0).
 *
 * TURNED ON 2026-08-07 by the game agent, on the maintainer's instruction —
 * this file's own documented handoff, taken up on the day it described. The
 * game's crossing is no longer a cut: WorldScene eases `indoorMix` on
 * INDOOR_TAU = 0.35s with the roll `k = 1 - exp(-dt_s / TAU)`, and the outside
 * world now fades to black on it instead of snapping. The maintainer, seeing
 * that land: "I really love how the game kinda fades into the 'in-door' view
 * and back again when you go out. The snapping is gone. ... please fade the
 * ambient effects in/out as well."
 *
 * 1050 IS NOT A TASTE NUMBER — it is that same roll, expressed in this class's
 * units. step() uses `k = 1 - exp(-(dt_ms / fadeMs) * 3)`, so fadeMs / 3 is the
 * time constant in ms: 3 * 0.35 * 1000 = 1050 makes the two curves IDENTICAL,
 * frame for frame. Both also step on the same boolean flip (the geometry
 * verdict, not the light blend), so the ambience and the world it hangs in can
 * never drift apart. If INDOOR_TAU ever moves, move this with it. */
export const OUTDOOR_FADE_MS = 1050;

/** Below this the gain is treated as fully off: effects skip their simulation
 * and hide their objects rather than drawing invisible ones every frame. */
export const OUTDOOR_EPS = 0.002;

export class OutdoorGain {
  /** 0..1 — multiply every ambient effect's opacity by this. Starts outdoors:
   * a world that never reports an indoor verdict behaves exactly as before. */
  value = 1;

  /** `fadeMs` is injectable so the fade path is REACHABLE AND TESTED even while
   * the shipped value is 0. The claim this whole file rests on — "flipping one
   * constant turns the snap into a fade" — is otherwise unfalsifiable until the
   * day someone flips it and finds out. */
  constructor(readonly fadeMs: number = OUTDOOR_FADE_MS) {}

  /** Advance toward the current verdict. `indoor` is the game's BOOLEAN
   * geometry state (`__ml.indoor().indoor`), not its light blend — the light
   * blend lags the geometry by design and effects must stop when the player is
   * actually inside, not when the room has finished lighting. */
  step(dt: number, indoor: boolean): number {
    const to = indoor ? 0 : 1;
    if (!(this.fadeMs > 0)) {
      this.value = to; // the snap
      return this.value;
    }
    // Exponential roll on the frame delta — the same idiom the game's own
    // cloud/mist/indoor blends use, with the settle clamp so it lands exactly.
    const k = 1 - Math.exp(-(dt / this.fadeMs) * 3);
    this.value += (to - this.value) * k;
    if (Math.abs(this.value - to) < 0.005) this.value = to;
    return this.value;
  }
}

/** Is the player inside a building/cave right now? Reads the game's `indoor`
 * probe, fenced like every other probe read: a world without indoor spaces (or
 * an older client) has no probe and reads as OUTDOORS, so ambience is never
 * silently suppressed by a missing dependency. */
export function readIndoor(): boolean {
  try {
    // Reached through globalThis, and INSIDE the try, on purpose. A bare
    // `window` would be a ReferenceError (not a catchable property miss)
    // wherever window is absent — a worker, a test harness, any non-DOM host —
    // and the mount calls this every frame OUTSIDE its safe() wrapper, so that
    // would take down the whole ambient tick. globalThis also keeps this file
    // free of DOM lib types, which is what lets it be unit-tested at all.
    // Only an explicit `true` counts as indoors.
    const w = (globalThis as { window?: { __ml?: Record<string, (...a: never[]) => unknown> } }).window;
    const r = (w?.__ml?.indoor as undefined | (() => { indoor?: boolean } | null))?.();
    return r?.indoor === true;
  } catch {
    return false;
  }
}
