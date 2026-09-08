/** THE MAIN-THREAD SIDE OF THE GROUND RESOLVER WORKER (tiles3worker.ts).
 *
 * It owns the worker's lifetime, the generation counter that makes a stale
 * answer harmless, and the switch. It resolves NOTHING itself: every answer is
 * an optimisation the caller may ignore, which is what keeps this safe to ship
 * on the most bug-prone path in the game.
 *
 * THE SWITCH IS A SWITCH, not a query parameter (maintainer's standing rule: an
 * installed PWA has no URL bar, so a dev A/B that exists only as `?flag=` is
 * unreachable by the one person who tests this game). `ml-resolve-worker` in
 * localStorage, a Settings entry, and `__ml.resolveWorker(on?)`.
 *
 * DEFAULT ON, because the fallback is not a degraded picture — it is exactly
 * today's behaviour. Every path this feeds is a CACHE WARM: if the worker never
 * answers, is slow, fails to boot, or returns a stale generation, the main
 * thread resolves that cell itself on the frame that needs it, which is what it
 * does today with no worker at all.
 */
import type { Frame } from "./tiles3";
import type { Tiles3DocKey } from "./tiles3runtime";
import type { ResolvedCell, WorkerOut } from "./tiles3worker";

export type { ResolvedCell };

const KEY = "ml-resolve-worker";

/** OFF is remembered; anything else is on. Read per call so the Settings switch
 *  and a console poke agree without a reload. */
export function resolveWorkerEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true; // private mode / storage blocked: the feature, not the fallback
  }
}

export function setResolveWorkerEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage blocked — the flag lives for this session only */
  }
  window.dispatchEvent(new Event("ml-resolve-worker"));
}

export interface ResolveWorkerStats {
  /** Cells the worker resolved and the main thread accepted. */
  resolved: number;
  /** Cells the main thread asked for and has not been answered on yet. */
  inFlight: number;
  /** Answers thrown away because the resolver had been rebuilt under them. */
  stale: number;
  batches: number;
  /** Worker-side milliseconds — time that did NOT happen on the frame thread. */
  workerMs: number;
  /** Main-thread milliseconds spent applying answers. This is the only cost
   *  this feature ADDS to the frame, and it is the number that decides whether
   *  it was worth it. */
  applyMs: number;
  bootMs: number;
  regionMs: number;
  state: "off" | "booting" | "ready" | "failed" | "unsupported";
  error: string;
}

export class ResolveWorker {
  private w: Worker | null = null;
  private gen = 0;
  private ready = false;
  private failed = "";
  private pending = new Set<number>();
  private onCells: ((cells: ResolvedCell[], paths: string[]) => void) | null = null;
  readonly stats: ResolveWorkerStats = {
    resolved: 0, inFlight: 0, stale: 0, batches: 0,
    workerMs: 0, applyMs: 0, bootMs: 0, regionMs: 0, state: "off", error: "",
  };

  get isReady(): boolean {
    return this.ready && !!this.w;
  }

  /** Hand every answer here. The caller decides what to do with it; this class
   *  never touches the scene. */
  onResolved(cb: (cells: ResolvedCell[], paths: string[]) => void): void {
    this.onCells = cb;
  }

  /** (Re)build against a new resolver. Bumping the generation is what makes a
   *  message already in flight harmless: the live tuning channel can rebuild
   *  `Tiles3World` mid-session, and an answer resolved against the OLD
   *  documents would be a wrong picture rather than a slow one. */
  init(opts: {
    docUrls: Partial<Record<Tiles3DocKey, string>>;
    worldUrl: string;
    frame: Frame;
    pitch: number;
  }): void {
    this.gen++;
    this.pending.clear();
    this.ready = false;
    this.stats.inFlight = 0;
    if (!resolveWorkerEnabled()) {
      this.stop();
      this.stats.state = "off";
      return;
    }
    if (typeof Worker === "undefined") {
      this.stats.state = "unsupported";
      return;
    }
    try {
      if (!this.w) {
        this.w = new Worker(new URL("./tiles3worker.ts", import.meta.url), { type: "module" });
        this.w.onmessage = (ev: MessageEvent<WorkerOut>) => this.onMessage(ev.data);
        /* A worker that dies must not take the ground with it. `onerror` fires
         * for an uncaught throw inside the worker and for a module that fails
         * to load at all (an old browser without module workers reports it
         * here, not at construction). */
        this.w.onerror = (e: ErrorEvent) => {
          this.ready = false;
          this.failed = String(e?.message || "worker error");
          this.stats.state = "failed";
          this.stats.error = this.failed;
        };
      }
      this.stats.state = "booting";
      this.w.postMessage({ type: "init", gen: this.gen, ...opts });
    } catch (e) {
      this.w = null;
      this.stats.state = "failed";
      this.stats.error = String((e as Error)?.message ?? e);
    }
  }

  /** Ask for these cell indices. Cells already in flight are not re-sent — the
   *  ring re-queues the same strip as the camera drifts, and asking twice costs
   *  a whole second resolve for an answer already on its way. */
  request(cells: readonly number[]): number {
    if (!this.isReady || !cells.length) return 0;
    const fresh: number[] = [];
    for (const i of cells) if (!this.pending.has(i)) fresh.push(i);
    if (!fresh.length) return 0;
    for (const i of fresh) this.pending.add(i);
    this.stats.inFlight = this.pending.size;
    this.stats.batches++;
    const buf = Int32Array.from(fresh);
    this.w!.postMessage({ type: "resolve", gen: this.gen, cells: buf }, [buf.buffer]);
    return fresh.length;
  }

  stop(): void {
    this.w?.terminate();
    this.w = null;
    this.ready = false;
    this.pending.clear();
    this.stats.inFlight = 0;
  }

  private onMessage(m: WorkerOut): void {
    if (m.type === "ready") {
      if (m.gen !== this.gen) return;
      this.ready = true;
      this.stats.state = "ready";
      this.stats.bootMs = +m.ms.toFixed(1);
      this.stats.regionMs = +m.regionMs.toFixed(1);
      return;
    }
    if (m.type === "failed") {
      this.ready = false;
      this.stats.state = "failed";
      this.stats.error = m.error;
      return;
    }
    for (const c of m.cells) this.pending.delete(c.i);
    this.stats.inFlight = this.pending.size;
    if (m.gen !== this.gen) {
      this.stats.stale += m.cells.length;
      return;
    }
    this.stats.workerMs += m.ms;
    const t0 = performance.now();
    this.onCells?.(m.cells, m.paths);
    this.stats.applyMs += performance.now() - t0;
    this.stats.resolved += m.cells.length;
  }
}
