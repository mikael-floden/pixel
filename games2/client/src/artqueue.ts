/* THE ART QUEUE — every texture the live world streams in, in PRIORITY order,
 * turned into a GPU texture under a BYTE BUDGET PER FRAME (maintainer
 * 2026-09-12: "We must figure out what is the max we can load/frame without
 * the game lagging at all!").
 *
 * WHY. Measured on his phone across four runs: every slow frame (24 of 24,
 * 15 of 15, 45 of 48) carried a GPU texture upload, and the uploads were
 * monster strips — a 256-px kind is 40 MB of textures, and the game queued
 * the combat strips of all 57 kinds at launch (1,312 files, 416 MB) with the
 * network deciding how many landed in one frame: 564 MB in one 30 s window,
 * 12 MB in one frame. The loader's "two in flight" bounded the COUNT per
 * frame, never the BYTES, and a 1 MB strip is the whole frame on a Mali.
 *
 * HOW. A job is fetched and DECODED off the main thread first (`img.decode()`),
 * so the only main-thread cost left is the upload itself; decoded images wait
 * in `ready` until the frame's budget admits them. `tick()` runs once per
 * frame: it pays last frame's overshoot, then adds jobs — highest priority
 * first — until the frame has spent its budget. One file bigger than the
 * budget still goes in one piece (a texture cannot be half-uploaded) and the
 * overshoot is charged to the frames after it, so the AVERAGE holds at the
 * budget whatever the file sizes. RAM is bounded too: fetching pauses while
 * more than `readyCapBytes` of decoded pixels are waiting.
 *
 * WHAT GOES THROUGH IT: everything streamed behind the live world — monster
 * body strips when a kind appears, combat strips when a fight starts,
 * characters' deferred states, NPC idles, scenery animation frames. NOT the
 * boot batch (behind the loading bar) and NOT the ground art (its own loader
 * and its own budget). The budget is a Settings dial while his phone finds
 * the number (`ml-upload-kb`, beacon `run.uploadKb`), then it is pinned. */
import Phaser from "phaser";

export interface ArtJob {
  /** Texture key to create. A key that already exists is never fetched. */
  key: string;
  /** Absolute URL, already routed (`withV`). */
  url: string;
  /** Lower runs first; equal priorities keep request order. */
  prio: number;
  /** A horizontal strip → `addSpriteSheet`; otherwise `addImage`. */
  sheet?: { frameWidth: number; frameHeight: number };
  /** Called once the texture exists (ok) or the fetch failed (not ok). */
  onLanded?: (key: string, ok: boolean) => void;
}

interface Pending extends ArtJob {
  seq: number;
  img?: HTMLImageElement;
  bytes: number;
}

export interface ArtQueueStats {
  /** Requested and not yet a texture: waiting for a fetch, fetching, or ready. */
  queued: number;
  fetching: number;
  ready: number;
  readyKb: number;
  /** Since the last `take()`. */
  landed: number;
  failed: number;
  landedKb: number;
  /** The biggest single frame's upload since the last `take()`, in KB. */
  frameKbMax: number;
  /** Frames since the last `take()` in which at least one texture was added. */
  frames: number;
}

/** THE DIAL — KB of texture per frame. 0 means unbounded (the old behaviour:
 *  whatever arrived became a texture on arrival). Persisted so the phone
 *  keeps its number across launches. */
export const UPLOAD_KB_STEPS = [64, 128, 256, 512, 0] as const;
export const UPLOAD_KB_DEFAULT = 128;
const KEY = "ml-upload-kb";

export function uploadKb(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return UPLOAD_KB_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : UPLOAD_KB_DEFAULT;
  } catch {
    return UPLOAD_KB_DEFAULT;
  }
}

export function setUploadKb(kb: number): void {
  try {
    localStorage.setItem(KEY, String(kb));
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
}

export class ArtQueue {
  /** KB per frame; 0 = unbounded. Read live from the dial by the scene. */
  budgetKb = uploadKb();
  private pending = new Map<string, Pending>();
  private readyList: Pending[] = [];
  private fetching = 0;
  private readyBytes = 0;
  private seq = 0;
  /** Bytes still owed from a frame that overshot its budget. */
  private debt = 0;
  private stats: ArtQueueStats = { queued: 0, fetching: 0, ready: 0, readyKb: 0, landed: 0, failed: 0, landedKb: 0, frameKbMax: 0, frames: 0 };

  constructor(
    private readonly textures: Phaser.Textures.TextureManager,
    private readonly opts: { fetchParallel: number; readyCapBytes: number } = { fetchParallel: 4, readyCapBytes: 48 * 1024 * 1024 },
  ) {}

  /** Queue a texture. False when it already exists or is already queued
   *  (the callback still fires for a queued key when it lands). */
  request(job: ArtJob): boolean {
    if (this.textures.exists(job.key)) return false;
    const have = this.pending.get(job.key);
    if (have) {
      // A second asker raises the priority and chains its callback.
      if (job.prio < have.prio) have.prio = job.prio;
      if (job.onLanded) {
        const prev = have.onLanded;
        have.onLanded = prev
          ? (k, ok) => {
              prev(k, ok);
              job.onLanded!(k, ok);
            }
          : job.onLanded;
      }
      return false;
    }
    this.pending.set(job.key, { ...job, seq: this.seq++, bytes: 0 });
    return true;
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }

  /** Once per frame, from the scene's update. */
  tick(): void {
    this.startFetches();
    const budget = this.budgetKb > 0 ? this.budgetKb * 1024 : Infinity;
    // Pay last frame's overshoot before adding anything.
    this.debt = Math.max(0, this.debt - budget);
    if (this.debt > 0 || !this.readyList.length) return;
    this.readyList.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    let spent = 0;
    let frameBytes = 0;
    while (this.readyList.length && spent < budget) {
      const job = this.readyList.shift()!;
      this.readyBytes -= job.bytes;
      this.pending.delete(job.key);
      const ok = this.add(job);
      spent += job.bytes;
      frameBytes += job.bytes;
      if (ok) {
        this.stats.landed++;
        this.stats.landedKb += job.bytes / 1024;
      } else this.stats.failed++;
      job.onLanded?.(job.key, ok);
    }
    if (frameBytes > 0) {
      this.stats.frames++;
      this.stats.frameKbMax = Math.max(this.stats.frameKbMax, frameBytes / 1024);
    }
    if (spent > budget) this.debt = spent - budget;
  }

  /** The live state without resetting anything (the `__ml.art()` probe). */
  peek(): ArtQueueStats & { budgetKb: number; debtKb: number } {
    return { ...this.stats, budgetKb: this.budgetKb, debtKb: Math.round(this.debt / 1024), queued: this.pending.size, fetching: this.fetching, ready: this.readyList.length, readyKb: Math.round(this.readyBytes / 1024) };
  }

  /** Read and reset the window's counters; the live sizes stay. */
  take(): ArtQueueStats {
    const out = { ...this.stats, queued: this.pending.size, fetching: this.fetching, ready: this.readyList.length, readyKb: Math.round(this.readyBytes / 1024) };
    this.stats.landed = 0;
    this.stats.failed = 0;
    this.stats.landedKb = 0;
    this.stats.frameKbMax = 0;
    this.stats.frames = 0;
    return out;
  }

  private add(job: Pending): boolean {
    if (!job.img) return false;
    if (this.textures.exists(job.key)) return true; // someone else made it meanwhile
    try {
      if (job.sheet) this.textures.addSpriteSheet(job.key, job.img, { frameWidth: job.sheet.frameWidth, frameHeight: job.sheet.frameHeight });
      else this.textures.addImage(job.key, job.img);
      return this.textures.exists(job.key);
    } catch {
      return false;
    }
  }

  private startFetches(): void {
    if (this.fetching >= this.opts.fetchParallel || this.readyBytes >= this.opts.readyCapBytes) return;
    // The highest-priority jobs not yet fetching or ready.
    const candidates: Pending[] = [];
    for (const p of this.pending.values()) if (!p.img && p.bytes === 0) candidates.push(p);
    if (!candidates.length) return;
    candidates.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    for (const job of candidates) {
      if (this.fetching >= this.opts.fetchParallel || this.readyBytes >= this.opts.readyCapBytes) break;
      this.fetch(job);
    }
  }

  private fetch(job: Pending): void {
    this.fetching++;
    job.bytes = -1; // in flight (never 0 again, so it is not re-picked)
    const img = new Image();
    img.decoding = "async";
    const done = (ok: boolean) => {
      this.fetching--;
      if (!this.pending.has(job.key)) return; // dropped meanwhile
      if (!ok) {
        this.pending.delete(job.key);
        this.stats.failed++;
        job.onLanded?.(job.key, false);
        return;
      }
      job.img = img;
      job.bytes = Math.max(1, img.naturalWidth * img.naturalHeight * 4);
      this.readyBytes += job.bytes;
      this.readyList.push(job);
    };
    img.onerror = () => done(false);
    img.onload = () => {
      // DECODE OFF THE MAIN THREAD, so the upload is a copy and nothing else.
      const p = typeof img.decode === "function" ? img.decode() : Promise.resolve();
      p.then(
        () => done(true),
        () => done(true), // a decode() rejection still leaves a drawable image on most browsers
      );
    };
    img.src = job.url;
  }
}
