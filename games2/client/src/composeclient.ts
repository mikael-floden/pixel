/** THE MAIN-THREAD SIDE OF THE COMPOSE WORKER (composeworker.ts). It owns the
 *  worker's lifetime, the generation that makes a stale raster harmless, the
 *  per-frame job batch (one postMessage a frame, not one a job) and the
 *  switch. It composes NOTHING itself: `Tiles3Textures` hands it a job and
 *  draws the plain plate until the raster lands, exactly as it did for a
 *  budget-refused composition — so a worker that never boots, dies, or is
 *  switched off leaves today's behaviour and nothing else.
 *
 *  THE SWITCH IS A SWITCH, not a query parameter (an installed PWA has no URL
 *  bar): `ml-compose-worker` in localStorage, `__ml.composeWorker(on?)`.
 *  DEFAULT ON — the fallback is the same picture a frame later. */
import type { PatternsDoc } from "./tiles3";
import type { ComposeJob, Pixels, RemoteComposer } from "./tiles3draw";
import type { ComposeOut } from "./composeworker";

const KEY = "ml-compose-worker";

export function composeWorkerEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setComposeWorkerEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage blocked — the flag lives for this session only */
  }
}

export interface ComposeWorkerStats {
  state: "off" | "booting" | "ready" | "failed" | "unsupported";
  error: string;
  bootMs: number;
  /** Jobs posted. */
  queued: number;
  /** Rasters that landed and were registered. */
  landed: number;
  /** Jobs the worker could not build (a fetch that failed, an unknown key). */
  missed: number;
  /** Worker-side milliseconds — time that did NOT happen on the frame thread. */
  workerMs: number;
  /** Frame-thread milliseconds spent registering rasters: the only cost this
   *  path adds to a frame, and the number that decides whether it was worth it. */
  applyMs: number;
  batches: number;
}

export class ComposeWorker implements RemoteComposer {
  private w: Worker | null = null;
  private gen = 0;
  private isReady = false;
  private batch: ComposeJob[] = [];
  private flushQueued = false;
  private onLand: ((key: string, px: Pixels, ms: number) => void) | null = null;
  private onMiss: ((key: string, error: string) => void) | null = null;
  readonly stats: ComposeWorkerStats = { state: "off", error: "", bootMs: 0, queued: 0, landed: 0, missed: 0, workerMs: 0, applyMs: 0, batches: 0 };

  ready(): boolean {
    return this.isReady;
  }

  onComposed(cb: (key: string, px: Pixels, ms: number) => void): void {
    this.onLand = cb;
  }

  onMissed(cb: (key: string, error: string) => void): void {
    this.onMiss = cb;
  }

  /** Boot (or re-boot) against a pattern library. Every raster still in flight
   *  from the previous generation is dropped on arrival. */
  init(opts: { patterns: PatternsDoc; sheets: { silhouette: string; masks: string; border: string } }): void {
    this.gen++;
    this.isReady = false;
    this.batch.length = 0;
    if (!composeWorkerEnabled()) {
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
        this.w = new Worker(new URL("./composeworker.ts", import.meta.url), { type: "module" });
        this.w.onmessage = (ev: MessageEvent<ComposeOut>) => this.onMessage(ev.data);
        // A worker that dies must not take the ground with it: the factory
        // falls back to composing on the frame thread the moment `ready()` is false.
        this.w.onerror = (e: ErrorEvent) => {
          this.isReady = false;
          this.stats.state = "failed";
          this.stats.error = String(e?.message || "worker error");
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

  /** Queue a job; the batch goes out on a microtask, so a ring step that names
   *  forty compositions costs one message. */
  compose(job: ComposeJob): void {
    if (!this.isReady || !this.w) return;
    this.batch.push(job);
    this.stats.queued++;
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushQueued = false;
    if (!this.w || !this.isReady || !this.batch.length) {
      this.batch.length = 0;
      return;
    }
    const jobs = this.batch;
    this.batch = [];
    this.stats.batches++;
    this.w.postMessage({ type: "compose", gen: this.gen, jobs });
  }

  stop(): void {
    this.w?.terminate();
    this.w = null;
    this.isReady = false;
    this.batch.length = 0;
  }

  private onMessage(m: ComposeOut): void {
    if (m.gen !== this.gen) return; // a stale generation: the factory it was built for is gone
    if (m.type === "ready") {
      this.isReady = true;
      this.stats.state = "ready";
      this.stats.bootMs = +m.ms.toFixed(1);
      return;
    }
    if (m.type === "failed") {
      this.isReady = false;
      this.stats.state = "failed";
      this.stats.error = m.error;
      return;
    }
    if (m.type === "miss") {
      this.stats.missed++;
      this.onMiss?.(m.key, m.error);
      return;
    }
    const t0 = performance.now();
    this.stats.workerMs += m.ms;
    this.onLand?.(m.key, { w: m.w, h: m.h, data: new Uint8ClampedArray(m.data) }, m.ms);
    this.stats.landed++;
    this.stats.applyMs += performance.now() - t0;
  }
}
