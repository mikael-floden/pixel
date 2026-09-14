/* THE FLUSH CHANNEL — one feature tells another that a flock just went up.
 *
 * `feathers/` needs the exact moment and place a bird panicked off the ground,
 * and `birds/` is the only thing that knows. Features may not import each
 * other (ambient/README.md: folder isolation beats DRY), so the fact travels
 * through here: birds EMITS, anything interested LISTENS, and neither knows
 * the other exists.
 *
 * It carries no state and no history. A listener that is not mounted misses
 * nothing it could have used, and an emit with nobody listening costs one
 * empty loop — so `birds/` runs identically whether or not `feathers/` is in
 * the registry, which is the rule every ambient integration follows.
 */

/** One bird leaving the ground in a panic: where its sprite was DRAWN, the
 *  ground point under it, and which of the eight designs it is. */
export interface FlushEvent {
  /** Drawn position in world px (the ground point lifted by the altitude). */
  x: number;
  y: number;
  /** The ground point it was over, which is where anything it drops lands. */
  gx: number;
  gy: number;
  /** Altitude above that ground point, px. */
  alt: number;
  /** Which of the eight bird designs — a listener may colour by species. */
  type: number;
  /** THE BIRD'S OWN PLUMAGE, sampled from its art (`plumageOf`), or null when
   *  the sheet could not be read. Anything it drops is tinted from this: a
   *  hand-picked palette made a red bird shed a white feather. */
  colour: number | null;
}

type Listener = (e: FlushEvent) => void;

const listeners = new Set<Listener>();
let sources = 0;

/** A feature that CAN emit a flush says so while it is running.
 *
 *  This exists for one decision: `feathers/` shows nothing at all without a
 *  flock, so when it is selected ALONE in Settings it sheds a demo feather to
 *  prove the row works — and it must NOT do that while real birds are
 *  overhead about to provide the real thing. `forced` cannot tell those apart
 *  (MANUAL mode forces every enabled field), so the flock declares itself. */
export function setFlushSource(on: boolean): void {
  sources = Math.max(0, sources + (on ? 1 : -1));
}

/** Is anything currently able to flush? */
export function hasFlushSource(): boolean {
  return sources > 0;
}

/** Subscribe; the returned function unsubscribes (call it in `dispose`). */
export function onFlush(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Announce one bird's panic take-off. Fenced: a listener that throws must
 *  never take the flock down with it. */
export function emitFlush(e: FlushEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* an ambient listener is decoration; the flock keeps flying */
    }
  }
}

/** Test seam: how many listeners are attached. */
export function flushListeners(): number {
  return listeners.size;
}
