// ============================================================================
// HOW FAST TO CHASE A REMOTE BODY — paced to how fast its positions ARRIVE
// ============================================================================
//
// Maintainer, 2026-09-22: "I still feel the monsters in my own zone to way way
// smoother vs monsters in a neighbouring zone."
//
// MEASURED (server/test/ghostrate.test.ts): a monster in his own room arrives
// at 20 Hz — the colyseus patch rate. A monster in a NEIGHBOURING room arrives
// as a ghost on that room's edge snapshot, and a room with no client in it
// runs its sim inside the idle gate, so it publishes at 2.33 Hz. An 8.6x
// difference in how often the body's position is new.
//
// The renderer eased BOTH with one constant, `k = min(1, dt * 12)` — an
// exponential chase with tau = 1/12 = 83 ms, which is ~95% converged in 250
// ms. That is a good filter for a 50 ms source and the WRONG SHAPE for a 430
// ms one: it arrives, races to the target in 250 ms, and then SITS STILL for
// the remaining 180 ms until the next sample. Glide, freeze, jump, repeat —
// which is what "way way smoother" is measuring.
//
// So the rate is tied to the arrival rate instead of to a constant, and the
// tie is chosen so that A 20 Hz SOURCE COMES OUT AT EXACTLY 12. Nothing in his
// own zone changes by a single pixel; only a source slower than the tick eases
// slower, which is the whole point. That equality is arm 1 of the gate and is
// the reason this is safe to put in the path that draws every remote body.
//
// NOT interpolation between two buffered samples with a playout delay, which
// is the textbook answer and was rejected here: it renders a whole arrival
// interval in the past, so a ghost would sit 430 ms behind the truth and you
// would swing at where it used to be — and cross-border combat is a thing
// (spec/ZONES.md). An exponential chase paced to the source lags by ~one tau
// and never stalls, which buys the smoothness without buying the latency.

/** Today's constant, and the rate this whole file is calibrated to hold. */
export const CHASE_RATE_AT_FULL = 12;
/** The rate that constant was tuned for: the colyseus patch rate. */
export const FULL_HZ = 20;
/** A floor, so a body whose source has gone quiet still closes the gap rather
 *  than creeping across the screen for a second and a half. */
export const MIN_HZ = 2;
/** Above this, a silence is a PAUSE, not a slow sample rate. A roaming monster
 *  stands still for MONSTER_ROAM_PAUSE_MS (800-2600 ms) between legs, and a
 *  position that has not changed for that long says nothing about how fast the
 *  next one will arrive. Folding a pause into the estimate made a monster
 *  resume its walk at a crawl. */
export const MAX_GAP_MS = 900;
/** How much each new interval moves the estimate. Low, because one late
 *  packet is not a rate change and a body that visibly changes speed mid-walk
 *  reads worse than one that is consistently a little behind. */
export const GAP_EMA = 0.2;

/** Fold one observed interval into the running estimate. `prev` of 0 means no
 *  estimate yet. An interval longer than MAX_GAP_MS is a pause and is
 *  IGNORED — the previous estimate stands. */
export function trackGap(prevMs: number, sinceMs: number): number {
  if (!(sinceMs > 0) || sinceMs > MAX_GAP_MS) return prevMs;
  if (!(prevMs > 0)) return sinceMs;
  return prevMs * (1 - GAP_EMA) + sinceMs * GAP_EMA;
}

/** Samples per second implied by a gap estimate. No estimate = assume the
 *  tick, i.e. behave exactly as the old code did until something is known. */
export function arrivalHz(gapMs: number): number {
  if (!(gapMs > 0)) return FULL_HZ;
  return Math.min(FULL_HZ, Math.max(MIN_HZ, 1000 / gapMs));
}

/** The exponential-chase rate for a source arriving at `hz`.
 *  remoteChaseRate(FULL_HZ) === CHASE_RATE_AT_FULL, exactly. */
export function remoteChaseRate(hz: number): number {
  const h = Math.min(FULL_HZ, Math.max(MIN_HZ, hz));
  return (CHASE_RATE_AT_FULL / FULL_HZ) * h;
}
