/** WHAT THE NETWORK AND THE DISK CACHE ACTUALLY COST, PER ASSET FAMILY.
 *
 * WHY THIS EXISTS. The maintainer's question was the right one and nothing in
 * the game could answer it: when we run into a new area, are we ASKING for art
 * we already have? The headless answer was worthless — the dev server serves no
 * `/asset-index.json` and sets no `Cache-Control` at all, so a harness measures
 * a caching story the shipped game does not have. This measures the real one,
 * on his phone, in production.
 *
 * `transferSize === 0` IS THE ANSWER. The browser reports zero bytes
 * transferred for a resource it served from its own cache without touching the
 * network — so `cached` vs `net` below is a direct read of "did we ask for it
 * again", not an inference from request counts. (It also reads 0 for an opaque
 * cross-origin response, which cannot happen here: every asset is same-origin.
 * A STAGING world's CDN URLs are the one exception and land in `other`.)
 *
 * AND `duration` IS THE COST HE IS HUNTING. A cache hit is not free: the bytes
 * still come off disk and still decode, and decode scales with PIXELS, not
 * with the compressed size — measured on the library, a scenery piece is 5x a
 * 64x64 tile at the median and 45x at the max. So a family's `p90`/`max`
 * duration with `net` at zero is exactly "how long the disk read and decode
 * took", which is the number the off-thread-decode question turns on.
 *
 * A PerformanceObserver, NOT `getEntriesByType`: the resource buffer holds 250
 * entries by default and silently drops the rest, and a run into fresh terrain
 * fetches far more than that in one beacon window. Draining continuously also
 * means the accumulators are per-window by construction.
 */

/** URL prefix -> bucket. First match wins. */
const FAMILIES: ReadonlyArray<readonly [string, string]> = [
  ["/assets/scenery/", "scenery"],
  ["/assets/tiles/", "tiles3"],
  ["/assets/monsters/", "monsters"],
  ["/assets/characters2/", "chars"],
  ["/assets/items/", "items"],
  ["/assets/maps2/", "maps"],
  ["/assets/live/", "live"],
  ["/atlases/", "atlas"],
];

/** Durations kept per family for the percentiles. Capped because a long run
 *  into fresh terrain can fetch thousands of files in one window and this array
 *  is pure instrumentation — it must never become the thing that allocates. */
const MAX_SAMPLES = 3000;

interface Acc {
  n: number;
  cached: number;
  net: number;
  bytes: number;
  decoded: number;
  slow: number;
  ms: number[];
}

const accs = new Map<string, Acc>();
let observer: PerformanceObserver | null = null;
let started = false;
/** Slowest single resources of the window, for naming names — a 40 ms load is
 *  worth seeing as a FILE, not only as a percentile. */
let worst: { url: string; ms: number; kb: number; cached: boolean }[] = [];

const acc = (fam: string): Acc => {
  let a = accs.get(fam);
  if (!a) accs.set(fam, (a = { n: 0, cached: 0, net: 0, bytes: 0, decoded: 0, slow: 0, ms: [] }));
  return a;
};

const familyOf = (url: string): string | null => {
  for (const [prefix, fam] of FAMILIES) if (url.includes(prefix)) return fam;
  return null;
};

/** A load that would threaten a frame if it landed on the main thread. */
const SLOW_MS = 8;

function record(e: PerformanceResourceTiming): void {
  const fam = familyOf(e.name);
  if (!fam) return;
  const a = acc(fam);
  const ms = e.duration;
  a.n++;
  /* `transferSize` counts response HEADERS too, so a 304 revalidation is a
   * small non-zero number, not zero — which is the distinction we want: a
   * revalidated file DID cost a round trip and belongs in `net`. */
  if (e.transferSize > 0) a.net++;
  else a.cached++;
  a.bytes += e.transferSize || 0;
  a.decoded += e.decodedBodySize || 0;
  if (ms >= SLOW_MS) a.slow++;
  if (a.ms.length < MAX_SAMPLES) a.ms.push(ms);
  if (ms >= SLOW_MS) {
    worst.push({
      url: e.name.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "").slice(-70),
      ms: +ms.toFixed(1),
      kb: +(((e.decodedBodySize || e.transferSize || 0) / 1024).toFixed(1)),
      cached: !(e.transferSize > 0),
    });
    if (worst.length > 200) worst.splice(0, 100);
  }
}

/** Start observing. Idempotent, and safe where PerformanceObserver is absent. */
export function netPerfStart(): void {
  if (started) return;
  started = true;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) record(e as PerformanceResourceTiming);
    });
    observer.observe({ type: "resource", buffered: true });
  } catch {
    observer = null; // no observer: the beacon block simply stays empty
  }
}

const pct = (sorted: number[], p: number): number =>
  sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : 0;

export interface NetFamilyStat {
  /** Resources of this family that finished in the window. */
  n: number;
  /** Served from the browser's own cache with NO network at all. */
  cached: number;
  /** Cost a request — a real download OR a 304 revalidation. */
  net: number;
  /** Bytes over the wire (headers included). */
  kb: number;
  /** Bytes after decompression — what actually had to be read and decoded. */
  decKb: number;
  /** Loads at or over 8 ms. */
  slow: number;
  p50: number;
  p90: number;
  max: number;
}

/** Take and RESET the window's stats. Called once per beacon. */
export function netPerfTake(): {
  fams: Record<string, NetFamilyStat>;
  worst: string[];
} {
  const fams: Record<string, NetFamilyStat> = {};
  for (const [fam, a] of accs) {
    const sorted = a.ms.slice().sort((x, y) => x - y);
    fams[fam] = {
      n: a.n,
      cached: a.cached,
      net: a.net,
      kb: +(a.bytes / 1024).toFixed(1),
      decKb: +(a.decoded / 1024).toFixed(1),
      slow: a.slow,
      p50: pct(sorted, 0.5),
      p90: pct(sorted, 0.9),
      max: sorted.length ? +sorted[sorted.length - 1].toFixed(1) : 0,
    };
  }
  const top = worst
    .slice()
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 12)
    .map((w) => `${w.ms}ms ${w.cached ? "cache" : "NET"} ${w.kb}kb ${w.url}`);
  accs.clear();
  worst = [];
  return { fams, worst: top };
}
