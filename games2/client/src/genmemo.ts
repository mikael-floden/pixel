/** A BOUNDED MEMO IN TWO GENERATIONS — for a per-object answer where a WeakMap
 *  is the obvious choice and, on this heap, the wrong one.
 *
 *  A WeakMap entry is an EPHEMERON: the collector may mark its value only once
 *  its key is known live, so every major collection has to iterate the tables
 *  to a fixpoint, and when one table's values hold another's keys (a cell's
 *  ops name its art, the art is a key of the plate-key memo) the iteration
 *  runs round after round. Measured with V8's own trace (--trace-gc-nvp,
 *  headless, a 1 MB young generation like a phone's, a 60 s walk through new
 *  ground): tiles3draw's four per-cell memos held 19,925 ephemerons, and a
 *  full collection spent 102.5 ms of its 202 ms pause in `mark.ephemeron`,
 *  with V8 falling back to its linear algorithm (more than ten rounds).
 *
 *  Here the memo holds its keys STRONGLY, which the collector marks like any
 *  Map, and bounds itself instead: the young generation rotates into the old
 *  at half the cap and the old is dropped whole, so the two never hold more
 *  than `cap` entries, and a hit in the old is promoted so what is still in
 *  use survives the rotation. An answer a caller no longer asks for (its key
 *  evicted from the cell cache) is let go a generation later rather than at
 *  the next collection. The working set must fit the young generation, or a
 *  rotation drops what the next paint asks again. `undefined` is not a value
 *  (it reads as a miss). */
export class GenMemo<K, V> {
  private young = new Map<K, V>();
  private old = new Map<K, V>();
  /** How many times the young generation has rotated — a cap too small for
   *  the working set shows as a rotation per paint. */
  rotations = 0;

  constructor(readonly cap: number) {}

  get(k: K): V | undefined {
    const y = this.young.get(k);
    if (y !== undefined) return y;
    const o = this.old.get(k);
    if (o !== undefined) this.set(k, o); // still in use: it survives the next rotation
    return o;
  }

  set(k: K, v: V): void {
    this.young.set(k, v);
    if (this.young.size >= this.cap / 2) {
      this.old = this.young;
      this.young = new Map();
      this.rotations++;
    }
  }

  /** Entries held, both generations (a promoted key counts twice). */
  get size(): number {
    return this.young.size + this.old.size;
  }

  clear(): void {
    this.young = new Map();
    this.old = new Map();
  }
}
