/** THE DEPTH SORT, FROM THE LAST SORT'S ORDER (maintainer 2026-09-25: "Stop
 *  redoing work that doesn't change").
 *
 *  Phaser sorts the whole display list every frame something moved:
 *  `StableSort(list, (a, b) => a._depth - b._depth)`, i.e. V8's TimSort with a
 *  JS comparator and two megamorphic `_depth` reads per comparison, plus a
 *  work-array copy of the list. On his phone that is 0.9-3.3 ms a frame over
 *  a 5-13.5k list, and 11-30 ms on a frame a rebuild appended hundreds of
 *  images to — while a frame changes the depth of p50 19 objects of 4,277
 *  (p90 47; headless at 224,246 with ambient and monsters on).
 *
 *  So the last sort's order and depths are kept and the list is walked
 *  against them once: an object met in that order at the depth it was sorted
 *  at is in place (the REMAINDER); an object whose depth changed, or that was
 *  added since, is DIRTY.
 *  - THE STEADY FRAME (nothing added or removed, a few depths changed): each
 *    dirty object's final index is found by binary search over the last
 *    order, and only the WINDOWS between the dirty objects' old and new
 *    indices are rewritten — everything outside them provably keeps its
 *    index. No pass writes the whole list.
 *  - A FRAME THAT ADDED OR REMOVED OBJECTS (a rebuild, a despawn): the dirty
 *    objects are sorted among themselves and merged with the remainder into
 *    the list. Removals (Phaser's remove, `destroyBatch`'s in-place filter,
 *    `debrisReturn`) keep the remainder in order.
 *  Nothing is deferred and nothing is sliced: the same frame gets the same
 *  order with less work.
 *
 *  WHY IT IS EXACTLY PHASER'S ORDER. A stable sort by depth orders the list by
 *  the key (depth, index in the list as the sort found it), and that key is
 *  total. The remainder is sorted by that key — its depths are unchanged, it
 *  is a subsequence of the last sorted order, and its relative order is its
 *  current order — and the dirty set is sorted by it explicitly. The one
 *  sequence sorted by a total key is unique: the merge and the windows both
 *  produce it. The depths are READ, not tracked: a depth written by any path,
 *  setter or not, is seen, because the walk compares every object's `_depth`
 *  with the depth it was sorted at. A NaN depth (which Phaser's comparator
 *  orders arbitrarily) and a last order that did not come out sorted fall
 *  back to Phaser's own sort.
 *
 *  An insertion sort was rejected here on 2026-09-12 (1.05 ms/frame against
 *  Phaser's 0.85): it re-read every depth through a comparator and paid a
 *  rebuild's appends one shift at a time. A first cut of this one that merged
 *  into a buffer and copied the whole list back measured no faster than
 *  Phaser's (0.29 against 0.25 ms at 4,277 objects): the full copy costs what
 *  the comparator did. Hence the windows.
 *
 *  `__ml.sortParity(true)` runs Phaser's sort on a copy after every fast
 *  sort and counts disagreeing objects (the gate: verify-fastsort.mjs). */

export interface Depthed {
  _depth: number;
}

/** THE MEMBERSHIP STAMP: an object is in the last order iff its `__fsm` is
 *  this sorter's token. A number on the object, not a WeakSet: measured, the
 *  WeakSet's add was half of a rebuild frame's sort (the identity hash and
 *  the ephemeron table), which made the merge slower than Phaser's sort. */
interface Stamped {
  __fsm?: number;
}
let tokens = 0;

export interface FastSortStats {
  /** Sorts asked for (the list's sort flag was up). */
  sorts: number;
  /** Answered by the walk alone: nothing added or removed, no depth changed. */
  noop: number;
  /** Answered by rewriting windows (a steady frame). */
  window: number;
  /** Answered by a merge (objects were added or removed). */
  merge: number;
  /** Answered by Phaser's sort (no valid last order, a NaN depth). */
  native: number;
  /** Dirty objects over all window and merge sorts, and the most in one. */
  dirty: number;
  maxDirty: number;
  /** List slots rewritten by window sorts (the work the windows kept small). */
  windowSlots: number;
  /** Time spent per kind of answer, ms (the walk included). */
  noopMs: number;
  windowMs: number;
  mergeMs: number;
}
const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Past this share of the list dirty, a steady frame merges instead. */
const WINDOW_MAX_SHARE = 8;

export class FastDepthSort<T extends Depthed> {
  /** The last sorted order and the depth each object had in it. */
  private prev: T[] = [];
  private prevDepth = new Float64Array(256);
  /** The buffers a merge writes the next order into; swapped with prev after. */
  private next: T[] = [];
  private nextDepth = new Float64Array(256);
  /** Stamped on every object in `prev` (see Stamped) — read only where the
   *  walk meets an object that is not the next one in `prev`. Kept exact: a
   *  stamp is cleared the moment the walk passes its object; a reset takes a
   *  new token, which unstamps every object at once. */
  private token = ++tokens;
  private valid = false;
  /* THE SCRATCH, grown by doubling, never shrunk: depths and list indices
   * only — the objects themselves are read back out of the list, which is not
   * written until the new order is known, so the scratch holds no object
   * except the window buffer, cleared after use. */
  private remDepth = new Float64Array(256);
  private remIdx = new Int32Array(256);
  private dirtDepth = new Float64Array(64);
  private dirtIdx = new Int32Array(64);
  private ord = new Int32Array(64);
  private tmp = new Int32Array(64);
  private newPos = new Int32Array(64);
  private lo = new Int32Array(64);
  private hi = new Int32Array(64);
  private byLo = new Int32Array(64);
  private isDirty = new Uint8Array(256);
  private win: T[] = [];
  private winDepth = new Float64Array(256);
  private keyBuf = new Float64Array(64);
  private tmpKey(k: number): Float64Array {
    if (this.keyBuf.length < k) this.keyBuf = new Float64Array(Math.max(k, this.keyBuf.length * 2));
    return this.keyBuf;
  }

  readonly stats: FastSortStats = { sorts: 0, noop: 0, window: 0, merge: 0, native: 0, dirty: 0, maxDirty: 0, windowSlots: 0, noopMs: 0, windowMs: 0, mergeMs: 0 };

  /** Forget the last order: the next sort is Phaser's (a switch flipped, a scene restarted). */
  reset(): void {
    this.valid = false;
    this.prev.length = 0;
    this.next.length = 0;
    this.token = ++tokens;
  }

  /** Sort `list` in place into exactly the order `native(list)` gives
   *  (Phaser's stable depth sort). */
  sort(list: T[], native: (list: T[]) => void): void {
    this.stats.sorts++;
    const n = list.length;
    if (!this.valid) {
      this.nativeSort(list, native);
      return;
    }
    const t0 = now();
    this.room(n);
    const prev = this.prev;
    const prevDepth = this.prevDepth;
    /* THE STEADY WALK: the list is the last order, object for object, and
     * only depths may have moved. Leaves at the first object out of place. */
    let k = 0;
    let same = n === prev.length;
    if (same) {
      for (let i = 0; i < n; i++) {
        const o = list[i];
        if (prev[i] !== o) {
          same = false;
          break;
        }
        const d = o._depth;
        if (d !== prevDepth[i]) k = this.dirty(k, d, i);
      }
    }
    if (same) {
      if (k === 0) {
        this.stats.noop++;
        this.stats.noopMs += now() - t0;
        return;
      }
      if (this.hasNaN(k)) {
        this.nativeSort(list, native);
        return;
      }
      if (k * WINDOW_MAX_SHARE <= n && this.windows(list, k)) {
        this.stats.windowMs += now() - t0;
        return;
      }
      // Too many, or windows too wide: the merge, from a full walk.
    }
    this.mergeSort(list, native);
    this.stats.mergeMs += now() - t0;
  }

  /** A NaN depth among the dirty: Phaser's comparator orders it arbitrarily,
   *  so only Phaser's own sort can reproduce it. */
  private hasNaN(k: number): boolean {
    const dd = this.dirtDepth;
    for (let t = 0; t < k; t++) if (dd[t] !== dd[t]) return true;
    return false;
  }

  private nativeSort(list: T[], native: (list: T[]) => void): void {
    native(list);
    this.snapshot(list);
    this.stats.native++;
  }

  /** THE STEADY FRAME: `k` dirty objects (depth changed, nothing added or
   *  removed). Each one's final index, from a binary search over the last
   *  order; the windows its move sweeps, merged where they overlap; only
   *  those slots rewritten. False (nothing written) when the windows would
   *  cover more than half the list — the merge is then no dearer. */
  private windows(list: T[], k: number): boolean {
    const n = list.length;
    const prev = this.prev;
    const prevDepth = this.prevDepth;
    const dirtDepth = this.dirtDepth;
    const dirtIdx = this.dirtIdx;
    const ord = this.ord;
    for (let t = 0; t < k; t++) ord[t] = t;
    this.sortDirty(k);
    const newPos = this.newPos;
    const lo = this.lo;
    const hi = this.hi;
    /* FINAL INDEX of the t-th dirty object in key order: t, plus the remainder
     * objects whose key (depth, index) is below its key. Those are every slot
     * of the last order whose OLD key is below it — one binary search, the old
     * keys being strictly increasing — less the dirty objects' own old slots
     * among them. */
    for (let t = 0; t < k; t++) {
      const q = ord[t];
      const dd = dirtDepth[q];
      const di = dirtIdx[q];
      let a = 0;
      let b = n;
      while (a < b) {
        const mid = (a + b) >>> 1;
        const pd = prevDepth[mid];
        if (pd < dd || (pd === dd && mid < di)) a = mid + 1;
        else b = mid;
      }
      // The dirty objects' OLD keys ascend with their list index (the last
      // order is sorted), so those below this key are a prefix: a second search.
      let c = 0;
      let e = k;
      while (c < e) {
        const mid = (c + e) >>> 1;
        const pu = dirtIdx[mid];
        const od = prevDepth[pu];
        if (od < dd || (od === dd && pu < di)) c = mid + 1;
        else e = mid;
      }
      const p = t + a - c;
      newPos[t] = p;
      lo[t] = p < di ? p : di;
      hi[t] = p < di ? di : p;
    }
    // The windows by their low end, overlapping ones merged: slots outside
    // every window keep their object.
    const byLo = this.byLo;
    for (let t = 0; t < k; t++) byLo[t] = t;
    if (k <= 64) {
      for (let i = 1; i < k; i++) {
        const v = byLo[i];
        let p = i - 1;
        while (p >= 0 && lo[byLo[p]] > lo[v]) {
          byLo[p + 1] = byLo[p];
          p--;
        }
        byLo[p + 1] = v;
      }
    } else {
      // Many windows: sort (lo, t) pairs packed into one float — lo < 2^31, t < 2^21.
      const key = this.tmpKey(k);
      for (let t = 0; t < k; t++) key[t] = lo[t] * 2097152 + t;
      key.subarray(0, k).sort();
      for (let t = 0; t < k; t++) byLo[t] = key[t] % 2097152;
    }
    let slots = 0;
    {
      let cl = lo[byLo[0]];
      let ch = hi[byLo[0]];
      for (let i = 1; i < k; i++) {
        const t = byLo[i];
        if (lo[t] <= ch) {
          if (hi[t] > ch) ch = hi[t];
        } else {
          slots += ch - cl + 1;
          cl = lo[t];
          ch = hi[t];
        }
      }
      slots += ch - cl + 1;
    }
    if (slots * 2 > n) return false;

    const isDirty = this.isDirty;
    for (let u = 0; u < k; u++) isDirty[dirtIdx[u]] = 1;
    const win = this.win;
    const winDepth = this.winDepth;
    // Each window: its remainder objects (in order) merged with its dirty ones
    // (in key order) — the dirty ones of a window are exactly those whose
    // move lies inside it, so its key-ordered run of `ord` is taken whole.
    let i = 0;
    while (i < k) {
      let cl = lo[byLo[i]];
      let ch = hi[byLo[i]];
      let j = i + 1;
      while (j < k && lo[byLo[j]] <= ch) {
        if (hi[byLo[j]] > ch) ch = hi[byLo[j]];
        j++;
      }
      // The window's dirty objects are byLo[i..j); their key order is their
      // order in `ord`, i.e. ascending t (byLo holds t's, which are key ranks).
      let t0 = k;
      let t1 = -1;
      for (let x = i; x < j; x++) {
        const t = byLo[x];
        if (t < t0) t0 = t;
        if (t > t1) t1 = t;
      }
      // Dirty ranks inside a window are contiguous (a window holds every
      // dirty object whose final index falls in it, and final indices ascend
      // with rank), so t0..t1 is the window's whole dirty set.
      let w = 0;
      let t = t0;
      for (let p = cl; p <= ch; p++) {
        if (isDirty[p]) continue;
        const pd = prevDepth[p];
        while (t <= t1) {
          const q = ord[t];
          const dd = dirtDepth[q];
          if (dd < pd || (dd === pd && dirtIdx[q] < p)) {
            win[w] = list[dirtIdx[q]];
            winDepth[w] = dd;
            w++;
            t++;
          } else break;
        }
        win[w] = list[p];
        winDepth[w] = pd;
        w++;
      }
      for (; t <= t1; t++, w++) {
        const q = ord[t];
        win[w] = list[dirtIdx[q]];
        winDepth[w] = dirtDepth[q];
      }
      for (let x = 0; x < w; x++) {
        const o = win[x];
        list[cl + x] = o;
        prev[cl + x] = o;
        prevDepth[cl + x] = winDepth[x];
        win[x] = undefined as unknown as T;
      }
      i = j;
    }
    for (let u = 0; u < k; u++) isDirty[dirtIdx[u]] = 0;
    this.stats.window++;
    this.stats.dirty += k;
    if (k > this.stats.maxDirty) this.stats.maxDirty = k;
    this.stats.windowSlots += slots;
    return true;
  }

  /** OBJECTS WERE ADDED OR REMOVED (or too many depths moved): the full walk
   *  splits the list into the remainder and the dirty objects, the dirty are
   *  sorted by (depth, index) and merged with the remainder into the list. */
  private mergeSort(list: T[], native: (list: T[]) => void): void {
    const n = list.length;
    const prev = this.prev;
    const prevDepth = this.prevDepth;
    const m = prev.length;
    const remDepth = this.remDepth;
    const remIdx = this.remIdx;
    const token = this.token;
    let j = 0;
    let r = 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const o = list[i];
      if (j < m && prev[j] === o) {
        const d = o._depth;
        if (d === prevDepth[j]) {
          remDepth[r] = d;
          remIdx[r] = i;
          r++;
        } else k = this.dirty(k, d, i);
        j++;
        continue;
      }
      if ((o as Stamped).__fsm !== token) {
        // Added since the last sort (or passed over as below): placed by its depth.
        k = this.dirty(k, o._depth, i);
        continue;
      }
      // Further on in the last order: everything passed over left the list —
      // or moved behind this object, and is then met above as an added one.
      let p = j;
      while (p < m && prev[p] !== o) p++;
      if (p === m) {
        // Not ahead after all (a stamp out of step): place it by its depth.
        (o as Stamped).__fsm = 0;
        k = this.dirty(k, o._depth, i);
        continue;
      }
      for (; j < p; j++) (prev[j] as Stamped).__fsm = 0;
      const d = o._depth;
      if (d === prevDepth[j]) {
        remDepth[r] = d;
        remIdx[r] = i;
        r++;
      } else k = this.dirty(k, d, i);
      j++;
    }
    for (; j < m; j++) (prev[j] as Stamped).__fsm = 0;
    if (this.hasNaN(k)) {
      this.nativeSort(list, native);
      return;
    }
    this.stats.merge++;
    this.stats.dirty += k;
    if (k > this.stats.maxDirty) this.stats.maxDirty = k;

    const ord = this.ord;
    for (let t = 0; t < k; t++) ord[t] = t;
    this.sortDirty(k);

    // Merge the two by (depth, index) into `next`, then write it into the list.
    const next = this.next;
    const nextDepth = this.nextDepth;
    const dirtDepth = this.dirtDepth;
    const dirtIdx = this.dirtIdx;
    let a = 0;
    let b = 0;
    let w = 0;
    while (a < r && b < k) {
      const q = ord[b];
      const ra = remDepth[a];
      const db = dirtDepth[q];
      if (ra < db || (ra === db && remIdx[a] < dirtIdx[q])) {
        next[w] = list[remIdx[a]];
        nextDepth[w] = ra;
        a++;
      } else {
        const o = list[dirtIdx[q]];
        next[w] = o;
        nextDepth[w] = db;
        (o as Stamped).__fsm = token;
        b++;
      }
      w++;
    }
    for (; a < r; a++, w++) {
      next[w] = list[remIdx[a]];
      nextDepth[w] = remDepth[a];
    }
    for (; b < k; b++, w++) {
      const q = ord[b];
      const o = list[dirtIdx[q]];
      next[w] = o;
      nextDepth[w] = dirtDepth[q];
      (o as Stamped).__fsm = token;
    }
    next.length = n;
    for (let i = 0; i < n; i++) list[i] = next[i];
    // The merged order is the next sort's last order.
    this.next = prev;
    this.nextDepth = prevDepth;
    this.prev = next;
    this.prevDepth = nextDepth;
  }

  /** Take Phaser's result as the last order: every depth read once, and
   *  checked non-decreasing — a list that did not come out sorted (NaN) keeps
   *  the next sort Phaser's too. */
  private snapshot(list: T[]): void {
    const n = list.length;
    this.room(n);
    const prev = this.prev;
    const prevDepth = this.prevDepth;
    const token = (this.token = ++tokens);
    let ok = true;
    let last = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = list[i];
      const d = o._depth;
      if (!(d >= last)) ok = false; // NaN or out of order
      last = d;
      prev[i] = o;
      prevDepth[i] = d;
      (o as Stamped).__fsm = token;
    }
    prev.length = n;
    this.valid = ok;
    if (!ok) this.reset();
  }

  private dirty(k: number, d: number, i: number): number {
    this.dirtDepth[k] = d;
    this.dirtIdx[k] = i;
    return k + 1;
  }

  /** Stable sort of `ord[0..k)` by `dirtDepth` (the index breaks ties because
   *  the dirty objects were collected in list order): insertion for a few,
   *  a bottom-up merge for a rebuild's hundreds. No comparator callback. */
  private sortDirty(k: number): void {
    const key = this.dirtDepth;
    let src = this.ord;
    if (k <= 24) {
      for (let i = 1; i < k; i++) {
        const v = src[i];
        const kv = key[v];
        let p = i - 1;
        while (p >= 0 && key[src[p]] > kv) {
          src[p + 1] = src[p];
          p--;
        }
        src[p + 1] = v;
      }
      return;
    }
    let dst = this.tmp;
    for (let width = 1; width < k; width *= 2) {
      for (let lo = 0; lo < k; lo += 2 * width) {
        const mid = Math.min(lo + width, k);
        const hi = Math.min(lo + 2 * width, k);
        let a = lo;
        let b = mid;
        let w = lo;
        while (a < mid && b < hi) dst[w++] = key[src[b]] < key[src[a]] ? src[b++] : src[a++];
        while (a < mid) dst[w++] = src[a++];
        while (b < hi) dst[w++] = src[b++];
      }
      const t = src;
      src = dst;
      dst = t;
    }
    if (src !== this.ord) this.ord.set(src.subarray(0, k));
  }

  /** Grow every scratch array to hold `n` objects. */
  private room(n: number): void {
    if (this.remDepth.length < n) {
      let c = this.remDepth.length;
      while (c < n) c *= 2;
      this.remDepth = new Float64Array(c);
      this.remIdx = new Int32Array(c);
      this.isDirty = new Uint8Array(c);
      this.winDepth = new Float64Array(c);
      const pd = new Float64Array(c);
      pd.set(this.prevDepth.subarray(0, Math.min(this.prevDepth.length, c)));
      this.prevDepth = pd;
      this.nextDepth = new Float64Array(c);
    }
    if (this.dirtDepth.length < n) {
      let c = this.dirtDepth.length;
      while (c < n) c *= 2;
      this.dirtDepth = new Float64Array(c);
      this.dirtIdx = new Int32Array(c);
      this.ord = new Int32Array(c);
      this.tmp = new Int32Array(c);
      this.newPos = new Int32Array(c);
      this.lo = new Int32Array(c);
      this.hi = new Int32Array(c);
      this.byLo = new Int32Array(c);
    }
  }
}
