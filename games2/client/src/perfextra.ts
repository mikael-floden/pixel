// SMALL INSTRUMENTS FOR THE PERF BEACON that need no scene: a fixed CPU
// benchmark (the throttling proxy), the frame-time histogram and the display
// rate read off the frame intervals. Pure functions, tested headless.

/** THE THROTTLING PROXY. The same 400,000 xorshift steps every window, timed:
 *  a phone that is hot runs them slower, and a window whose ms went up while
 *  the game's own sections did not is the phone slowing, not the game. ~1 ms
 *  on a laptop, 3-8 ms on a phone — once per 30 s window, sent as `cpu`. */
export function cpuScoreMs(): number {
  const t0 = performance.now();
  let x = 0x9e3779b9 >>> 0;
  for (let i = 0; i < 400000; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
  }
  // Keep the loop alive under any optimiser: the result is folded into the
  // time by an amount too small to matter (0 or 1e-6).
  return +(performance.now() - t0 + (x === 0 ? 1e-6 : 0)).toFixed(2);
}

/** Frame intervals bucketed the way a player feels them: ≤17 ms smooth, ≤34
 *  a dropped frame, ≤50 a stutter, ≤100 a hitch, over that a freeze. */
export function frameHist(frames: readonly number[]): { le17: number; le34: number; le50: number; le100: number; gt100: number; mean: number } {
  const h = { le17: 0, le34: 0, le50: 0, le100: 0, gt100: 0, mean: 0 };
  let sum = 0;
  for (const f of frames) {
    sum += f;
    if (f <= 17) h.le17++;
    else if (f <= 34) h.le34++;
    else if (f <= 50) h.le50++;
    else if (f <= 100) h.le100++;
    else h.gt100++;
  }
  h.mean = frames.length ? +(sum / frames.length).toFixed(2) : 0;
  return h;
}

/** The display rate the game is actually pacing at, read off the FAST frames:
 *  the 15th-percentile interval is a frame that waited only for vsync, so its
 *  reciprocal is the refresh the browser is handing out — 60, 90, 120, or 30
 *  when it has throttled the tab. 0 when there are too few frames to say. */
export function rafHz(frames: readonly number[]): number {
  if (frames.length < 20) return 0;
  const s = frames.slice().sort((a, b) => a - b);
  const p15 = s[Math.floor(s.length * 0.15)];
  if (!(p15 > 0)) return 0;
  const hz = 1000 / p15;
  for (const r of [30, 60, 90, 120, 144]) if (Math.abs(hz - r) / r < 0.12) return r;
  return Math.round(hz);
}

/** p50/p90/p99/max/n of a sample list, for any block that carries one. */
export function quantiles(samples: readonly number[]): { n: number; p50: number; p90: number; p99: number; max: number } {
  const s = samples.slice().sort((a, b) => a - b);
  const pick = (q: number) => (s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1) : 0);
  return { n: s.length, p50: pick(0.5), p90: pick(0.9), p99: pick(0.99), max: s.length ? +s[s.length - 1].toFixed(1) : 0 };
}
