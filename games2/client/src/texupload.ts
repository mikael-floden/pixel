/** WHAT IT COSTS THE MAIN THREAD TO GET AN IMAGE INTO GPU MEMORY.
 *
 * WHY THIS EXISTS. The maintainer's standing theory is that running into a new
 * area lags because art is being loaded — and specifically that BIG art
 * (scenery, big monsters) costs more than small art (tiles). Measured on the
 * library he is right about the sizes: against a flat 64x64 tile (4,096 px), a
 * scenery piece is 5x that at the median, 16x at p90 and 45x at the max, and a
 * monster strip reaches 381,024 px — 1.5 MB of RGBA.
 *
 * AND NOTHING IN THIS GAME MEASURED IT. `netperf.ts` times the FETCH, which for
 * a cached file is queue depth and disk; `texFam` COUNTS texture adds. Neither
 * touches the decode or the upload, which is the part that runs on the frame
 * thread — so every argument made against the theory so far was made with data
 * that does not measure it. This does.
 *
 * `createTextureFromSource` IS THE ONE CHOKEPOINT. Every TextureSource that
 * reaches WebGL goes through it (TextureSource.init, all three branches), so
 * wrapping it once catches plate, boundary, character frame, monster strip,
 * scenery piece, cover atlas and composed raster alike — with no call site to
 * keep in sync and nothing to forget when a new art path is added.
 *
 * It is a MEASUREMENT, so it must not become the thing it measures: one wrap,
 * one `performance.now()` pair per upload, and a bounded sample array.
 */

interface Up {
  n: number;
  ms: number;
  px: number;
  samples: number[];
  worst: { ms: number; w: number; h: number }[];
}

const zero = (): Up => ({ n: 0, ms: 0, px: 0, samples: [], worst: [] });
let up = zero();
let installed = false;

/** Uploads kept for the percentiles. A long run adds a few thousand textures;
 *  the cap is there so a pathological session cannot grow this without bound. */
const MAX_SAMPLES = 4000;
/** An upload at or over this is worth naming individually — a frame is 16.7 ms
 *  and this is the claim under test. */
const SLOW_MS = 4;

/** Wrap the renderer's texture upload. Idempotent, and a no-op on Canvas
 *  (there is no GPU upload to time) or if the method is ever renamed. */
export function installTexUploadProbe(renderer: unknown): void {
  if (installed) return;
  const r = renderer as { createTextureFromSource?: (...a: unknown[]) => unknown } | null;
  if (!r || typeof r.createTextureFromSource !== "function") return;
  installed = true;
  const orig = r.createTextureFromSource.bind(r);
  r.createTextureFromSource = (...args: unknown[]) => {
    const t0 = performance.now();
    const out = orig(...args);
    const ms = performance.now() - t0;
    /* Dimensions come from the SOURCE when it has them and from the explicit
     * width/height otherwise — `createTextureFromSource(null, w, h)` is the
     * render-target path and carries no source at all. */
    const src = args[0] as { width?: number; height?: number } | null;
    const w = Math.round((src?.width as number) || (args[1] as number) || 0);
    const h = Math.round((src?.height as number) || (args[2] as number) || 0);
    up.n++;
    up.ms += ms;
    up.px += w * h;
    if (up.samples.length < MAX_SAMPLES) up.samples.push(ms);
    if (ms >= SLOW_MS) {
      up.worst.push({ ms: +ms.toFixed(1), w, h });
      if (up.worst.length > 120) up.worst.splice(0, 60);
    }
    return out;
  };
}

const pct = (sorted: number[], p: number) =>
  sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2) : 0;

/** Take and RESET the window's uploads. One call per beacon. */
export function texUploadTake(secs: number): {
  stats: Record<string, number | boolean>;
  worst: string[];
} {
  const s = up.samples.slice().sort((a, b) => a - b);
  const stats = {
    /** Uploads this window, and the total MAIN-THREAD milliseconds they cost.
     *  `msPerSec` against a 1000 ms second is the share of the frame budget
     *  this theory is asking for. */
    n: up.n,
    ms: +up.ms.toFixed(1),
    msPerSec: +(up.ms / Math.max(1, secs)).toFixed(2),
    mpx: +(up.px / 1e6).toFixed(2),
    p50: pct(s, 0.5),
    p90: pct(s, 0.9),
    p99: pct(s, 0.99),
    max: s.length ? +s[s.length - 1].toFixed(1) : 0,
    /** Uploads at or over 4 ms — the ones that could visibly cost a frame. */
    slow: up.worst.length,
    installed,
  };
  const worst = up.worst
    .slice()
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10)
    .map((w) => `${w.ms}ms ${w.w}x${w.h} (${((w.w * w.h) / 1000).toFixed(0)}kpx)`);
  up = zero();
  return { stats, worst };
}
