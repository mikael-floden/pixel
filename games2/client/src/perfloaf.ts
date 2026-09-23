/** WHERE A LONG FRAME'S TIME WENT, BY THE BROWSER'S OWN ACCOUNT — Long
 *  Animation Frames (`PerformanceObserver`, type `long-animation-frame`,
 *  Chrome 123+; absent elsewhere, and `state` says so).
 *
 *  WHY. The section timers bill what runs inside `update()` and the render,
 *  and the MessageChannel probe splits the rest into busy and idle — but
 *  neither can NAME a foreign task, and 20 of the 22 long frames in his 22:53
 *  window were "unattributed": no section owned a quarter of them. A
 *  long-animation-frame entry is the browser's ledger of the same frame: when
 *  the rendering update began (`renderStart` — everything before it was tasks
 *  that ran first: a socket patch, a worker landing, a timer, an input
 *  handler), when style and layout began (between the two are the rAF
 *  callbacks, i.e. OUR frame), and the end (style + layout + paint + commit —
 *  the DOM's own bill, the HUD's), plus every script over 5 ms with the API
 *  that invoked it. So each long frame splits into `pre` (foreign tasks
 *  before our frame), `raf` (our frame) and `dom`, and `by` names the
 *  invokers ("WebSocket.onmessage", "Worker.onmessage",
 *  "TimerHandler:setTimeout", "FrameRequestCallback") with their ms.
 *
 *  What it cannot see is GPU time: a frame the main thread spent WAITING for
 *  the compositor is short here and long in the beacon's `gapIdle`. That
 *  pairing is the GPU-bound signature, which is why both are sent.
 *
 *  Installed with the beacon (`installLoaf`), read per window (`loafTake`) and
 *  matched to a worst-frame record by time (`loafAt`): the entry for a frame
 *  arrives AFTER the frame closed, so the record cannot carry it at once —
 *  the report attaches it when it is built. */

/** The raw entry's fields, as the spec names them (lib.dom has no type yet). */
export interface LoafRaw {
  startTime: number;
  duration: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  blockingDuration?: number;
  scripts?: readonly {
    invoker?: string;
    invokerType?: string;
    sourceURL?: string;
    duration?: number;
    forcedStyleAndLayoutDuration?: number;
  }[];
}

/** One long frame, split. `by` is invoker -> ms, longest first, at most 6. */
export interface LoafSplit {
  t0: number;
  t1: number;
  ms: number;
  pre: number;
  raf: number;
  dom: number;
  block: number;
  forced: number;
  by: [string, number][];
}

const INVOKER_MAX = 40;
const BY_MAX = 6;
const RING = 96;

/** An invoker name a report can carry: an element's id or a long URL adds
 *  nothing to "which API", so both are cut. */
export function invokerName(s: { invoker?: string; invokerType?: string; sourceURL?: string }): string {
  let name = s.invoker || "";
  if (!name && s.sourceURL) name = s.sourceURL.replace(/^.*\//, "");
  if (!name) name = s.invokerType || "?";
  // "BUTTON#ml-settings.onclick" -> "BUTTON.onclick", "IMG[src=blob:...].onload"
  // -> "IMG.onload": the element and its URL are not the cost.
  name = name.replace(/\[[^\]]*\]?/, "").replace(/#[^.]*/, "");
  return name.length > INVOKER_MAX ? name.slice(0, INVOKER_MAX) : name;
}

/** Pure: the browser's timestamps into the three buckets. When no rendering
 *  update happened inside the entry (`renderStart` 0) the whole duration was
 *  tasks; when style/layout never started, the rest after `renderStart` is
 *  the rAF callbacks. */
export function loafSplit(e: LoafRaw): LoafSplit {
  const t0 = e.startTime;
  const t1 = e.startTime + e.duration;
  const rs = e.renderStart || 0;
  const sl = e.styleAndLayoutStart || 0;
  let pre = e.duration;
  let raf = 0;
  let dom = 0;
  if (rs > 0) {
    pre = Math.max(0, rs - t0);
    if (sl > 0) {
      raf = Math.max(0, sl - rs);
      dom = Math.max(0, t1 - sl);
    } else raf = Math.max(0, t1 - rs);
  }
  const by = new Map<string, number>();
  let forced = 0;
  for (const s of e.scripts ?? []) {
    const n = invokerName(s);
    by.set(n, (by.get(n) ?? 0) + (s.duration ?? 0));
    forced += s.forcedStyleAndLayoutDuration ?? 0;
  }
  const r1 = (v: number) => +v.toFixed(1);
  return {
    t0,
    t1,
    ms: r1(e.duration),
    pre: r1(pre),
    raf: r1(raf),
    dom: r1(dom),
    block: r1(e.blockingDuration ?? 0),
    forced: r1(forced),
    by: [...by.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, BY_MAX)
      .map(([k, v]) => [k, r1(v)]),
  };
}

let state: "off" | "on" | "unsupported" | "error" = "off";
let installed = false;
const win = { n: 0, ms: 0, pre: 0, raf: 0, dom: 0, block: 0, forced: 0 };
const winBy: Record<string, { n: number; ms: number }> = {};
const ring: LoafSplit[] = [];

function record(s: LoafSplit): void {
  win.n++;
  win.ms += s.ms;
  win.pre += s.pre;
  win.raf += s.raf;
  win.dom += s.dom;
  win.block += s.block;
  win.forced += s.forced;
  for (const [k, ms] of s.by) {
    const b = (winBy[k] ??= { n: 0, ms: 0 });
    b.n++;
    b.ms += ms;
  }
  ring.push(s);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
}

/** Start observing. `armed` gates recording (the beacon's own switch) so an
 *  unarmed session pays for nothing but the observer's existence. */
export function installLoaf(armed: () => boolean): void {
  if (installed) return;
  installed = true;
  try {
    const types = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes;
    if (!types || !types.includes("long-animation-frame")) {
      state = "unsupported";
      return;
    }
    const po = new PerformanceObserver((list) => {
      if (!armed()) return;
      for (const e of list.getEntries()) record(loafSplit(e as unknown as LoafRaw));
    });
    // The entry type is newer than lib.dom's union of names.
    (po as unknown as { observe(o: unknown): void }).observe({ type: "long-animation-frame", buffered: false });
    state = "on";
  } catch {
    state = "error";
  }
}

/** The window's totals and the invokers, longest first; resets the window. */
export function loafTake(): {
  loaf: { state: string; n: number; ms: number; pre: number; raf: number; dom: number; block: number; forced: number };
  loafBy: Record<string, { n: number; ms: number }>;
} {
  const r1 = (v: number) => +v.toFixed(1);
  const loaf = { state, n: win.n, ms: r1(win.ms), pre: r1(win.pre), raf: r1(win.raf), dom: r1(win.dom), block: r1(win.block), forced: r1(win.forced) };
  const loafBy = Object.fromEntries(
    Object.entries(winBy)
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, 10)
      .map(([k, v]) => [k, { n: v.n, ms: r1(v.ms) }]),
  );
  win.n = win.ms = win.pre = win.raf = win.dom = win.block = win.forced = 0;
  for (const k in winBy) delete winBy[k];
  return { loaf, loafBy };
}

/** The recorded long frame that overlaps [t0, t1] most (performance.now()
 *  clock, the same the entries use), compact — or null when none does. */
export function loafAt(t0: number, t1: number): { pre: number; raf: number; dom: number; by: [string, number][] } | null {
  let best: LoafSplit | null = null;
  let bestOv = 0;
  for (const s of ring) {
    const ov = Math.min(t1, s.t1) - Math.max(t0, s.t0);
    if (ov > bestOv) {
      bestOv = ov;
      best = s;
    }
  }
  return best ? { pre: best.pre, raf: best.raf, dom: best.dom, by: best.by.slice(0, 3) } : null;
}

/** The observer's state, for a probe. */
export const loafState = (): string => state;
