// THE GPU'S OWN CLOCK, when the browser lends it (EXT_disjoint_timer_query_webgl2).
//
// Every CPU instrument in the beacon ends at gl.flush: a frame that takes 6 ms
// of JavaScript and 25 ms on the tiler reads as "6 ms, unattributed 19" — and
// the capture-target realloc that WAS the running-into-a-new-area lag hid
// there for a week, because the driver queues allocations and bills them in
// the GPU process (docs/perf.md). This wraps Phaser's render in a
// TIME_ELAPSED query per frame and reads the results a few frames later, so a
// window can say how many GPU ms a frame really cost. Availability is the
// browser's call (Chrome grants the WebGL1 form on some Android drivers and
// withholds it on others; Safari never), which is why the block always
// carries `avail` and `reason` — "no numbers" must not read as "0 ms".
//
// Only while the beacon is on: a query per frame is cheap but not free.

interface Ext {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
  // The WebGL1 form of the extension carries the query API itself.
  createQueryEXT?: () => WebGLQuery;
  deleteQueryEXT?: (q: WebGLQuery) => void;
  beginQueryEXT?: (target: number, q: WebGLQuery) => void;
  endQueryEXT?: (target: number) => void;
  getQueryObjectEXT?: (q: WebGLQuery, pname: number) => unknown;
  QUERY_RESULT_AVAILABLE_EXT?: number;
  QUERY_RESULT_EXT?: number;
}

/* PHASER 3 RENDERS ON WEBGL1 (WebGL2 is Phaser 4), so the context on his phone
 * is WebGL1 and the extension that matters is `EXT_disjoint_timer_query`, whose
 * query API lives on the extension object; the `_webgl2` form is tried first
 * for any context that is WebGL2 anyway. Both are the browser's to grant. */
let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
let ext: Ext | null = null;
let isGl2 = false;
let armed: (() => boolean) | null = null;
let active: WebGLQuery | null = null;
let inflight: WebGLQuery[] = [];
let samples: number[] = [];
let disjoint = 0;
let skipped = 0;
let reason = "not installed";
let installed = false;

const q = {
  create: (): WebGLQuery | null => (isGl2 ? (gl as WebGL2RenderingContext).createQuery() : ext!.createQueryEXT!()),
  del: (x: WebGLQuery): void => (isGl2 ? (gl as WebGL2RenderingContext).deleteQuery(x) : ext!.deleteQueryEXT!(x)),
  begin: (x: WebGLQuery): void => (isGl2 ? (gl as WebGL2RenderingContext).beginQuery(ext!.TIME_ELAPSED_EXT, x) : ext!.beginQueryEXT!(ext!.TIME_ELAPSED_EXT, x)),
  end: (): void => (isGl2 ? (gl as WebGL2RenderingContext).endQuery(ext!.TIME_ELAPSED_EXT) : ext!.endQueryEXT!(ext!.TIME_ELAPSED_EXT)),
  available: (x: WebGLQuery): boolean =>
    isGl2
      ? (gl as WebGL2RenderingContext).getQueryParameter(x, (gl as WebGL2RenderingContext).QUERY_RESULT_AVAILABLE) === true
      : ext!.getQueryObjectEXT!(x, ext!.QUERY_RESULT_AVAILABLE_EXT!) === true,
  result: (x: WebGLQuery): number =>
    Number(isGl2 ? (gl as WebGL2RenderingContext).getQueryParameter(x, (gl as WebGL2RenderingContext).QUERY_RESULT) : ext!.getQueryObjectEXT!(x, ext!.QUERY_RESULT_EXT!)),
};

/** Hook Phaser's render bracket. Idempotent; the `on` getter gates per frame. */
export function installGpuTimer(
  renderer: { gl?: WebGLRenderingContext | WebGL2RenderingContext },
  events: { on(ev: string, fn: () => void): unknown },
  preRender: string,
  postRender: string,
  on: () => boolean,
): void {
  armed = on;
  if (installed) return;
  installed = true;
  const g = renderer.gl;
  if (!g) { reason = "no gl"; return; }
  isGl2 = typeof WebGL2RenderingContext !== "undefined" && g instanceof WebGL2RenderingContext;
  let e: Ext | null = null;
  if (isGl2) e = g.getExtension("EXT_disjoint_timer_query_webgl2") as Ext | null;
  if (!e) {
    e = g.getExtension("EXT_disjoint_timer_query") as Ext | null;
    if (e && typeof e.beginQueryEXT === "function") isGl2 = false;
    else e = null;
  }
  if (!e) { reason = isGl2 ? "no EXT_disjoint_timer_query_webgl2" : "webgl1: no EXT_disjoint_timer_query"; return; }
  gl = g;
  ext = e;
  reason = "ok";
  events.on(preRender, () => {
    if (!gl || !ext || !armed || !armed()) return;
    poll();
    if (active || inflight.length >= 8) { skipped++; return; } // never two active, never unbounded
    let x: WebGLQuery | null = null;
    try {
      x = q.create();
      if (!x) return;
      q.begin(x);
      active = x;
    } catch {
      if (x) try { q.del(x); } catch {}
    }
  });
  events.on(postRender, () => {
    if (!gl || !ext || !active) return;
    try {
      q.end();
      inflight.push(active);
    } catch {
      try { q.del(active); } catch {}
    }
    active = null;
  });
}

function poll(): void {
  if (!gl || !ext) return;
  const keep: WebGLQuery[] = [];
  for (const x of inflight) {
    let ready = false;
    try {
      ready = q.available(x);
    } catch {
      ready = true;
    }
    if (!ready) { keep.push(x); continue; }
    try {
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) disjoint++;
      else samples.push(q.result(x) / 1e6);
    } catch {}
    try { q.del(x); } catch {}
  }
  inflight = keep;
}

/** The window's GPU frame times, and the reason when there are none. */
export function gpuTimerTake(): Record<string, number | boolean | string> {
  const s = samples.slice().sort((a, b) => a - b);
  const pick = (q: number) => (s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(2) : 0);
  const out = {
    avail: reason === "ok",
    reason,
    n: s.length,
    p50: pick(0.5),
    p90: pick(0.9),
    p99: pick(0.99),
    max: s.length ? +s[s.length - 1].toFixed(2) : 0,
    meanMs: s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) : 0,
    disjoint,
    skipped,
  };
  samples = [];
  disjoint = 0;
  skipped = 0;
  return out;
}
