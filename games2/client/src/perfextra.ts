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

/** THE FELT LAG: one window's Event Timing entries, summarised. `delay` is
 *  INPUT DELAY — from the touch or pointer event's hardware timestamp to the
 *  moment its first handler ran, i.e. how long the main thread was busy (a
 *  frame, a ground slice, a collection) when he tapped; `dur` is that plus the
 *  handlers plus the next paint, the whole tap-to-pixel. `slow` counts events
 *  of 100 ms or more, where a tap starts to feel late. The observer only
 *  delivers entries over its 16 ms threshold, so `n` counts NOTICEABLE events,
 *  not taps: a window with n 0 was a window where every tap was answered
 *  inside a frame. */
export function inputSummary(entries: readonly { name: string; startTime: number; processingStart: number; duration: number }[]): {
  n: number;
  slow: number;
  delayP50: number;
  delayP90: number;
  delayMax: number;
  durP50: number;
  durP90: number;
  durMax: number;
  worst: string;
} {
  const delays = entries.map((e) => Math.max(0, e.processingStart - e.startTime));
  const durs = entries.map((e) => e.duration);
  const d = quantiles(delays);
  const u = quantiles(durs);
  let worst = "";
  let worstMs = -1;
  for (const e of entries)
    if (e.duration > worstMs) {
      worstMs = e.duration;
      worst = `${e.name} ${e.duration.toFixed(0)}ms`;
    }
  return {
    n: entries.length,
    slow: durs.filter((x) => x >= 100).length,
    delayP50: d.p50,
    delayP90: d.p90,
    delayMax: d.max,
    durP50: u.p50,
    durP90: u.p90,
    durMax: u.max,
    worst,
  };
}

/** THE PIXELS A TRIANGLES BATCH COVERS — the GPU's bill in the only unit a
 *  tiler pays in. `view` is the pipeline's vertex buffer as floats, `stride`
 *  the floats per vertex, `posOff` where the position sits in a vertex; every
 *  consecutive triple is one triangle (Phaser's quads are two of them, so a
 *  quad/tri mix reads exactly). Screen pixels on the main frame, texture
 *  pixels inside a DynamicTexture bracket — both are fill. */
export function triFillPx(view: ArrayLike<number>, vertexCount: number, stride: number, posOff: number): number {
  let px = 0;
  const n = vertexCount - (vertexCount % 3);
  for (let i = 0; i < n; i += 3) {
    const a = i * stride + posOff;
    const b = a + stride;
    const c = b + stride;
    const x0 = view[a];
    const y0 = view[a + 1];
    const cross = (view[b] - x0) * (view[c + 1] - y0) - (view[c] - x0) * (view[b + 1] - y0);
    px += cross < 0 ? -cross : cross;
  }
  return px * 0.5;
}

/** THE SECTION GROUPS the long-frame census reads by. A frame that spreads 45
 *  ms over six sections is "unattributed" section by section and plainly
 *  "the occluder rebuild ran in a ground-slice frame" group by group. `engine`
 *  is Phaser's own pre-update, `hooks` the scene's UPDATE listeners (the
 *  ambient mount), `busy` the gap held by a task that is not our frame, `idle`
 *  the gap spent waiting for the compositor (GPU-bound when it dominates). */
const SECTION_GROUPS: Record<string, string> = {
  redrawGround: "ground", repaintCells: "ground", groundSlice: "ground", landRepaint: "ground",
  rebuildOccluders: "occ", occWalkInc: "occ", occCull: "occ", occNear: "occ", coverIndex: "occ", rebuildScenery: "occ",
  lighting: "light", litPass: "light", litObjects: "light", litCoverSurf: "light", litPick: "light", litAtmo: "light", litWeather: "light", litShapeJobs: "light",
  avatarLoop: "sim", monsterLoop: "sim", stepNpcs: "sim", overlays: "sim", prefetch: "sim", artTick: "sim",
  render: "render", depthSort: "render",
  glBegin: "gl", glEnd: "gl",
  preUpdate: "engine", hooks: "hooks",
  gapBusy: "busy", gapIdle: "idle",
};
export function sectionGroup(key: string): string {
  return SECTION_GROUPS[key] ?? (key.startsWith("lit") ? "light" : "misc");
}
