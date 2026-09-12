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
 * HOW. A job is fetched and DECODED on a worker (`artworker.ts`), which hands
 * back the pixels as ImageBitmap BANDS of at most one frame's budget each,
 * plus every frame's opaque box (what `artBounds` used to measure with a
 * second decode). `tick()` runs once per frame and uploads bands, highest
 * priority first, until the frame has spent its budget; a strip becomes a
 * texture — and its `onLanded` fires — when its last band is in. THE BAND IS
 * A COPY: measured 0.0-0.2 ms per 128 KB against 5.8-9.2 ms for the old
 * `texImage2D` of an <img>, which Chrome re-decodes on every call (the same
 * 4.5-8.9 ms his phone's beacon reported as `texUp.p90/max`). A browser
 * without workers or ImageBitmaps, or a worker that dies, falls back to that
 * <img> path per job, where one file bigger than the budget still goes in
 * one piece and its overshoot is charged to the frames after it. RAM is
 * bounded too: fetching pauses while more than `readyCapBytes` of decoded
 * pixels are waiting, and a band is closed the moment it is uploaded.
 *
 * A CONTEXT RESTORE REFILLS. A banded texture has no source element for
 * Phaser to re-upload from (its wrapper holds no pixels — a closed bitmap
 * would throw inside Phaser's restore loop), so on RESTORE_WEBGL the queue
 * fetches every banded key again and uploads into the SAME wrapper, which
 * Phaser has just re-created blank at the right size.
 *
 * WHAT GOES THROUGH IT: everything streamed behind the live world — monster
 * body strips when a kind appears, combat strips when a fight starts,
 * characters' deferred states, NPC idles, scenery animation frames. NOT the
 * boot batch (behind the loading bar) and NOT the ground art (its own loader
 * and its own budget). The budget is a Settings dial while his phone finds
 * the number (`ml-upload-kb`, beacon `run.sim`), then it is pinned. */
import Phaser from "phaser";
import type { ArtWorkerIn, ArtWorkerOut } from "./artworker";
import { drawFrameInto } from "./framepixels";

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

type Wrapper = Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper;

interface Pending extends ArtJob {
  /** The key this job sits under in `pending` (a refill is `\0refill:<key>`). */
  pkey: string;
  seq: number;
  /** 0 = not fetched, -1 = in flight, else the decoded size in bytes. */
  bytes: number;
  /** The <img> path. */
  img?: HTMLImageElement;
  /** The worker path: bands still to upload from `bandAt` on, `rows` tall
   *  each (a closed band reports 0, so the height is kept here). */
  bands?: ImageBitmap[];
  bandAt: number;
  rows: number;
  w: number;
  h: number;
  frames: number;
  bounds?: Int32Array;
  bbox0?: Int32Array;
  /** The GL texture being filled; a refill fills an existing one. */
  wrapper?: Wrapper;
  refill?: Wrapper;
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
  /** Bands uploaded since the last `take()`, their total main-thread ms and the slowest one. */
  bands: number;
  bandMs: number;
  bandMax: number;
  /** 0 = the <img> path, 1 = the worker decodes, 2 = the worker failed (back to <img>). */
  worker: number;
  /** Jobs the worker refused (each fell back to the <img> path) and textures refilled after a context restore. */
  workerErrors: number;
  refilled: number;
}

/** THE DIAL — KB of texture per frame. 0 means unbounded (the old behaviour:
 *  whatever arrived became a texture on arrival). Persisted so the phone
 *  keeps its number across launches. */
export const UPLOAD_KB_STEPS = [64, 128, 256, 512, 0] as const;
export const UPLOAD_KB_DEFAULT = 128;
/** THE IDLE TIER: jobs at or past this priority are the art nobody needs yet
 *  (a present kind's fight strips before any fight, scenery animations) —
 *  they load "when nothing else is loading", and at a QUARTER of the dial,
 *  so a quiet minute does not spend the whole budget every frame on strips
 *  that may never play (measured: 265 MB in the first window at 128 KB a
 *  frame, most of it early fight art). A fight raising a strip's priority
 *  moves it out of this tier at once. */
export const ART_IDLE_PRIO = 7;
export const ART_IDLE_SHARE = 0.25;
const KEY = "ml-upload-kb";
const REFILL = "\0refill:";

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

/** THE BISECT: the Settings row "art worker" (the maintainer plays from an
 *  installed home-screen app, which has no address bar — a switch he cannot
 *  reach is no switch) and, for a browser tab, `?artworker=0|1`; both write
 *  `ml-art-worker`, read again at EVERY fetch so a tap takes effect on the
 *  next file without a reload. Off sends every job the <img> way, the path
 *  before 2026-09-12; what already landed stays as it is. */
export function artWorkerEnabled(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("artworker");
    if (q === "0" || q === "1") localStorage.setItem("ml-art-worker", q);
    return localStorage.getItem("ml-art-worker") !== "0";
  } catch {
    return true;
  }
}

export function setArtWorker(on: boolean): void {
  try {
    localStorage.setItem("ml-art-worker", on ? "1" : "0");
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
}

export function setUploadKb(kb: number): void {
  try {
    localStorage.setItem(KEY, String(kb));
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
}

type GLRenderer = Phaser.Renderer.WebGL.WebGLRenderer & {
  createTexture2D(
    mipLevel: number, minFilter: number, magFilter: number, wrapT: number, wrapS: number, format: number,
    pixels: object | null, width: number, height: number, pma?: boolean, forceSize?: boolean, flipY?: boolean,
  ): Wrapper;
};

export class ArtQueue {
  /** KB per frame; 0 = unbounded. Read live from the dial by the scene. */
  budgetKb = uploadKb();
  /** The scene's hook for a landed job's measured boxes: `bounds` is one
   *  x0 y0 x1 y1 per frame at alpha > 16 (artBounds' rule; `sheet` says the
   *  frames are numbered, else the one frame is `__BASE`), `bbox0` the whole
   *  image at alpha > 0 (alphaBBox's rule, all -1 when empty), with the
   *  image's size. Set once by the scene. */
  onBounds: ((key: string, frames: number, bounds: Int32Array, sheet: boolean, w: number, h: number, bbox0: Int32Array) => void) | null = null;
  private pending = new Map<string, Pending>();
  private readyList: Pending[] = [];
  /** The banded job a frame left half-uploaded; it goes first next frame. */
  private active: Pending | null = null;
  private fetching = 0;
  private readyBytes = 0;
  private seq = 0;
  /** Bytes still owed from a frame that overshot its budget (the <img> path). */
  private debt = 0;
  private stats: ArtQueueStats = {
    queued: 0, fetching: 0, ready: 0, readyKb: 0, landed: 0, failed: 0, landedKb: 0, frameKbMax: 0, frames: 0,
    bands: 0, bandMs: 0, bandMax: 0, worker: 0, workerErrors: 0, refilled: 0,
  };
  private readonly gl: GLRenderer | null;
  private worker: Worker | null = null;
  private workerState: "off" | "on" | "failed" = "off";
  private workerError = "";
  private jobsById = new Map<number, Pending>();
  private nextId = 1;
  /** Every banded texture alive: what a context restore refills, and what the
   *  parity probe compares. Dropped when the texture goes. */
  private uploaded = new Map<string, { url: string; w: number; h: number; sheet?: ArtJob["sheet"]; wrapper: Wrapper }>();

  constructor(
    private readonly textures: Phaser.Textures.TextureManager,
    renderer?: Phaser.Renderer.WebGL.WebGLRenderer | Phaser.Renderer.Canvas.CanvasRenderer | null,
    private readonly opts: { fetchParallel: number; readyCapBytes: number } = { fetchParallel: 4, readyCapBytes: 48 * 1024 * 1024 },
  ) {
    this.gl = renderer && renderer.type === Phaser.WEBGL ? (renderer as GLRenderer) : null;
  }

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
    this.pending.set(job.key, { ...job, pkey: job.key, seq: this.seq++, bytes: 0, bandAt: 0, rows: 0, w: 0, h: 0, frames: 0 });
    return true;
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }

  /** Did this texture land through the worker (bands, no source element)? */
  banded(key: string): boolean {
    return this.uploaded.has(key);
  }

  /** Once per frame, from the scene's update. `unbounded` while the loading
   *  screen is up: there is no frame to protect behind it, the scenery stills
   *  the hold waits for ride this queue, and the byte budget would only make
   *  the bar slower (the scene passes `!worldUp`, as the compose budget does). */
  tick(unbounded = false): void {
    this.startFetches();
    const budget = unbounded || this.budgetKb <= 0 ? Infinity : this.budgetKb * 1024;
    // Pay last frame's overshoot before adding anything.
    this.debt = Math.max(0, this.debt - budget);
    if (this.debt > 0 || !this.readyList.length) return;
    const active = this.active;
    this.readyList.sort((a, b) => (a === active ? -1 : b === active ? 1 : 0) || a.prio - b.prio || a.seq - b.seq);
    let spent = 0;
    let frameBytes = 0;
    while (this.readyList.length && spent < budget) {
      const job = this.readyList[0];
      // The idle tier stops at its share of the frame; anything above it is
      // sorted first, so once the head is idle art, the rest is too.
      if (job.prio >= ART_IDLE_PRIO && spent >= budget * ART_IDLE_SHARE) break;
      if (job.bands) {
        // A band goes in only if it fits what is left of the frame, unless
        // nothing has gone in yet (the budget is a bound, not an average). A
        // REFILL after a context restore is not budgeted: the art is already
        // missing from the screen, and the copies are all it costs.
        const next = job.bands[job.bandAt];
        if (!job.refill && frameBytes > 0 && next && next.width * next.height * 4 > budget - spent) break;
        const up = this.uploadBands(job, job.refill ? Infinity : budget - spent);
        if (!job.refill) spent += up;
        frameBytes += up;
        if (job.bandAt < job.bands.length) {
          this.active = job; // continues next frame, ahead of everything
          break;
        }
        this.active = null;
        this.readyList.shift();
        this.readyBytes -= job.bytes;
        this.pending.delete(job.pkey);
        const ok = this.finishBands(job);
        if (ok) {
          this.stats.landed++;
          this.stats.landedKb += job.bytes / 1024;
        } else this.stats.failed++;
        if (!job.refill) job.onLanded?.(job.key, ok);
        continue;
      }
      this.readyList.shift();
      this.readyBytes -= job.bytes;
      this.pending.delete(job.pkey);
      const ok = this.add(job);
      spent += job.bytes;
      frameBytes += job.bytes;
      if (ok) {
        this.stats.landed++;
        this.stats.landedKb += job.bytes / 1024;
      } else this.stats.failed++;
      job.onLanded?.(job.key, ok);
    }
    // The frame stats mean "under the budget": an unbounded frame behind the
    // loading screen is not one.
    if (frameBytes > 0 && !unbounded) {
      this.stats.frames++;
      this.stats.frameKbMax = Math.max(this.stats.frameKbMax, frameBytes / 1024);
    }
    if (spent > budget) this.debt = spent - budget;
  }

  /** The live state without resetting anything (the `__ml.art()` probe). */
  peek(): ArtQueueStats & { budgetKb: number; debtKb: number; workerError: string; banded: number; refillLeft: number } {
    let refillLeft = 0;
    for (const k of this.pending.keys()) if (k.startsWith(REFILL)) refillLeft++;
    return {
      ...this.stats, budgetKb: this.budgetKb, debtKb: Math.round(this.debt / 1024), queued: this.pending.size, fetching: this.fetching,
      ready: this.readyList.length, readyKb: Math.round(this.readyBytes / 1024), workerError: this.workerError, banded: this.uploaded.size, refillLeft,
    };
  }

  /** Read and reset the window's counters; the live sizes stay. */
  take(): ArtQueueStats {
    const out = { ...this.stats, queued: this.pending.size, fetching: this.fetching, ready: this.readyList.length, readyKb: Math.round(this.readyBytes / 1024) };
    this.stats.landed = 0;
    this.stats.failed = 0;
    this.stats.landedKb = 0;
    this.stats.frameKbMax = 0;
    this.stats.frames = 0;
    this.stats.bands = 0;
    this.stats.bandMs = 0;
    this.stats.bandMax = 0;
    this.stats.workerErrors = 0;
    this.stats.refilled = 0;
    return out;
  }

  /** After Phaser has rebuilt its wrappers (RESTORE_WEBGL, never the canvas
   *  event): every banded texture still alive is fetched again and uploaded
   *  into its own wrapper, ahead of everything else. */
  onContextRestored(): void {
    /* A job caught mid-upload lost the bands it had already put in (Phaser
     * re-created its wrapper blank): it goes back to the fetch, from band 0. */
    this.active = null;
    this.readyList = this.readyList.filter((job) => {
      if (!job.bands || job.bandAt === 0) return true;
      for (let i = job.bandAt; i < job.bands.length; i++) job.bands[i].close();
      this.readyBytes -= job.bytes;
      if (job.wrapper && !job.refill) this.gl?.deleteTexture(job.wrapper);
      job.bands = undefined;
      job.wrapper = undefined;
      job.bandAt = 0;
      job.bytes = 0; // re-picked by startFetches
      return false;
    });
    for (const [key, u] of this.uploaded) {
      if (!u.wrapper.webGLTexture || !this.textures.exists(key)) {
        this.uploaded.delete(key);
        continue;
      }
      const pkey = REFILL + key;
      if (this.pending.has(pkey)) continue;
      this.pending.set(pkey, { key, pkey, url: u.url, prio: -1, sheet: u.sheet, refill: u.wrapper, seq: this.seq++, bytes: 0, bandAt: 0, rows: 0, w: 0, h: 0, frames: 0 });
    }
  }

  /** THE PARITY PROBE (`__ml.artParity(key)`): the banded texture read back
   *  against the same file uploaded the old way — an <img> under
   *  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` — on the same context. `diff` is the
   *  number of differing bytes and `maxDelta` the largest difference. */
  async parity(key: string): Promise<{ w: number; h: number; equal: boolean; diff: number; maxDelta: number } | { error: string }> {
    const u = this.uploaded.get(key);
    const gl = this.gl?.gl;
    if (!u || !gl) return { error: u ? "no WebGL" : "not a banded texture" };
    const tex = u.wrapper.webGLTexture;
    if (!tex) return { error: "texture gone" };
    const read = (t: WebGLTexture): Uint8Array => {
      const fb = gl.createFramebuffer();
      const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const px = new Uint8Array(u.w * u.h * 4);
      gl.readPixels(0, 0, u.w, u.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
      gl.deleteFramebuffer(fb);
      return px;
    };
    const a = read(tex);
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("load failed"));
      img.src = u.url;
    });
    await img.decode();
    gl.activeTexture(gl.TEXTURE0);
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const ref = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, ref);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.bindTexture(gl.TEXTURE_2D, prev);
    const b = read(ref);
    gl.deleteTexture(ref);
    let diff = 0;
    let maxDelta = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d) {
        diff++;
        if (d > maxDelta) maxDelta = d;
      }
    }
    return { w: u.w, h: u.h, equal: diff === 0, diff, maxDelta };
  }

  /** THE READBACK PARITY (`__ml.artAlpha`): a banded frame's alpha through
   *  framepixels.ts (what artBounds, alphaMap and the outline read) against
   *  the same frame drawn from an <img> of the file. */
  async alphaParity(key: string, frame: number | string = 0): Promise<{ w: number; h: number; equal: boolean; diff: number } | { error: string }> {
    const u = this.uploaded.get(key);
    if (!u || !this.textures.exists(key)) return { error: "not a banded texture" };
    const tex = this.textures.get(key);
    const fr = (tex.frames as Record<string, Phaser.Textures.Frame | undefined>)[String(frame)];
    if (!fr) return { error: `no frame ${frame}` };
    const w = fr.cutWidth;
    const h = fr.cutHeight;
    const mk = () => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c.getContext("2d", { willReadFrequently: true })!;
    };
    const a = mk();
    if (!drawFrameInto(this.gl, a, fr, 0, 0)) return { error: "readback failed" };
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("load failed"));
      img.src = u.url;
    });
    const b = mk();
    b.drawImage(img, fr.cutX, fr.cutY, w, h, 0, 0, w, h);
    const da = a.getImageData(0, 0, w, h).data;
    const db = b.getImageData(0, 0, w, h).data;
    let diff = 0;
    for (let i = 3; i < da.length; i += 4) if (da[i] !== db[i]) diff++;
    return { w, h, equal: diff === 0, diff };
  }

  /** The parity of up to `n` banded textures, biggest first. */
  async parityAll(n = 6): Promise<Array<{ key: string } & Awaited<ReturnType<ArtQueue["parity"]>>>> {
    const keys = [...this.uploaded.entries()].sort((a, b) => b[1].w * b[1].h - a[1].w * a[1].h).slice(0, n).map(([k]) => k);
    const out = [];
    for (const key of keys) out.push({ key, ...(await this.parity(key)) });
    return out;
  }

  // ---- the <img> path -------------------------------------------------------

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
    if (this.fetching >= this.opts.fetchParallel) return;
    // The highest-priority jobs not yet fetching or ready. The RAM cap holds
    // new art back; a refill is art already on screen as a blank, so it is
    // fetched through the cap (it is bounded by the textures that exist).
    const capped = this.readyBytes >= this.opts.readyCapBytes;
    const candidates: Pending[] = [];
    for (const p of this.pending.values()) if (!p.img && !p.bands && p.bytes === 0 && (!capped || p.refill)) candidates.push(p);
    if (!candidates.length) return;
    candidates.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    for (const job of candidates) {
      if (this.fetching >= this.opts.fetchParallel) break;
      this.fetch(job);
    }
  }

  private fetch(job: Pending): void {
    if (artWorkerEnabled() ? this.workerBoot() : ((this.stats.worker = 0), false)) {
      const id = this.nextId++;
      this.jobsById.set(id, job);
      job.bytes = -1; // in flight (never 0 again, so it is not re-picked)
      this.fetching++;
      const m: ArtWorkerIn = { type: "load", id, url: job.url, bandBytes: this.budgetKb > 0 ? this.budgetKb * 1024 : 0, sheet: job.sheet };
      this.worker!.postMessage(m);
      return;
    }
    if (job.refill) {
      // No worker to refill through: the texture stays as Phaser restored it.
      this.pending.delete(job.pkey);
      return;
    }
    this.fetching++;
    job.bytes = -1;
    const img = new Image();
    img.decoding = "async";
    const done = (ok: boolean) => {
      this.fetching--;
      if (!this.pending.has(job.pkey)) return; // dropped meanwhile
      if (!ok) {
        this.pending.delete(job.pkey);
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

  // ---- the worker path ------------------------------------------------------

  private workerBoot(): boolean {
    if (this.workerState !== "off") {
      if (this.workerState === "on") this.stats.worker = 1; // the switch may have been off for a while
      return this.workerState === "on";
    }
    if (!this.gl || typeof Worker === "undefined" || typeof createImageBitmap === "undefined") {
      this.workerState = "failed";
      this.workerError = "unsupported";
      this.stats.worker = 2;
      return false;
    }
    try {
      this.worker = new Worker(new URL("./artworker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (ev: MessageEvent<ArtWorkerOut>) => this.onWorker(ev.data);
      /* A worker that dies must not take the art with it: an uncaught throw
       * inside it, or a module that fails to load at all (an old browser
       * without module workers reports it here, not at construction), sends
       * every job in flight back to the <img> path. */
      this.worker.onerror = (e: ErrorEvent) => this.workerFailed(String(e?.message || "worker error"));
      this.workerState = "on";
      this.stats.worker = 1;
      return true;
    } catch (e) {
      this.workerState = "failed";
      this.workerError = String((e as Error)?.message ?? e);
      this.stats.worker = 2;
      this.worker = null;
      return false;
    }
  }

  private workerFailed(err: string): void {
    this.workerState = "failed";
    this.workerError = err;
    this.stats.worker = 2;
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.worker = null;
    for (const job of this.jobsById.values()) {
      this.fetching--;
      job.bytes = 0; // re-picked by startFetches, now on the <img> path
    }
    this.jobsById.clear();
  }

  private onWorker(m: ArtWorkerOut): void {
    const job = this.jobsById.get(m.id);
    this.jobsById.delete(m.id);
    if (!job) {
      if (m.type === "ok") for (const b of m.bands) b.close();
      return;
    }
    this.fetching--;
    if (!this.pending.has(job.pkey) || this.pending.get(job.pkey) !== job) {
      if (m.type === "ok") for (const b of m.bands) b.close(); // dropped meanwhile
      return;
    }
    if (m.type === "err") {
      this.stats.workerErrors++;
      this.workerError = m.error;
      if (job.refill) this.pending.delete(job.pkey); // stays as Phaser restored it
      else job.bytes = 0; // this one file goes the <img> way
      return;
    }
    job.bands = m.bands;
    job.bandAt = 0;
    job.rows = m.rows;
    job.w = m.w;
    job.h = m.h;
    job.frames = m.frames;
    job.bounds = m.bounds;
    job.bbox0 = m.bbox0;
    job.bytes = Math.max(1, m.w * m.h * 4);
    this.readyBytes += job.bytes;
    this.readyList.push(job);
  }

  /** Upload bands from `bandAt` while the allowance lasts (the last band may
   *  overshoot it by less than one band). Returns the bytes uploaded. */
  private uploadBands(job: Pending, allowance: number): number {
    const bands = job.bands!;
    const r = this.gl!;
    const gl = r.gl;
    if (!job.wrapper) {
      if (job.refill) job.wrapper = job.refill;
      else {
        const pow = Phaser.Math.Pow2.IsSize(job.w, job.h);
        const wrap = pow ? gl.REPEAT : gl.CLAMP_TO_EDGE; // createTextureFromSource's own rule
        job.wrapper = r.createTexture2D(0, gl.NEAREST, gl.NEAREST, wrap, wrap, gl.RGBA, null, job.w, job.h, true, true, false);
      }
    }
    const tex = job.wrapper.webGLTexture;
    // A lost context (or a wrapper Phaser has not rebuilt yet): nothing is
    // consumed — the job waits at the head until the restore refetches or
    // resumes it (onContextRestored).
    if (!tex || gl.isContextLost()) return 0;
    let up = 0;
    gl.activeTexture(gl.TEXTURE0);
    const prev = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    let y = job.bandAt * job.rows;
    while (job.bandAt < bands.length) {
      const band = bands[job.bandAt];
      if (up > 0 && up + band.width * band.height * 4 > allowance) break;
      const tb = performance.now();
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, gl.RGBA, gl.UNSIGNED_BYTE, band);
      const ms = performance.now() - tb;
      this.stats.bands++;
      this.stats.bandMs += ms;
      if (ms > this.stats.bandMax) this.stats.bandMax = ms;
      up += band.width * band.height * 4;
      y += band.height;
      band.close();
      job.bandAt++;
    }
    gl.bindTexture(gl.TEXTURE_2D, prev);
    return up;
  }

  /** The last band is in: mipmaps where Phaser would make them, then the
   *  texture and its frames exactly as addSpriteSheet/addImage would. */
  private finishBands(job: Pending): boolean {
    const r = this.gl!;
    const gl = r.gl;
    const wrapper = job.wrapper;
    if (!wrapper || !wrapper.webGLTexture) return false;
    if (job.refill) {
      this.stats.refilled++;
      return true;
    }
    if (this.textures.exists(job.key)) {
      r.deleteTexture(wrapper); // someone else made it meanwhile
      return true;
    }
    if (Phaser.Math.Pow2.IsSize(job.w, job.h)) {
      gl.activeTexture(gl.TEXTURE0);
      const prev = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
      gl.bindTexture(gl.TEXTURE_2D, wrapper.webGLTexture);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, prev);
    }
    const texture = this.textures.create(job.key, wrapper, job.w, job.h);
    if (!texture) {
      r.deleteTexture(wrapper);
      return false;
    }
    if (job.sheet) {
      const parsers = (Phaser.Textures as unknown as { Parsers?: { SpriteSheet?: (t: Phaser.Textures.Texture, s: number, x: number, y: number, w: number, h: number, c: object) => unknown } }).Parsers;
      if (parsers?.SpriteSheet) parsers.SpriteSheet(texture, 0, 0, 0, job.w, job.h, { frameWidth: job.sheet.frameWidth, frameHeight: job.sheet.frameHeight });
      else {
        // The parser's own layout for a strip with no margin or spacing.
        texture.add("__BASE", 0, 0, 0, job.w, job.h);
        const fw = job.sheet.frameWidth;
        const fh = job.sheet.frameHeight;
        const perRow = Math.floor(job.w / fw);
        const total = perRow * Math.floor(job.h / fh);
        for (let i = 0; i < total; i++) texture.add(i, 0, (i % perRow) * fw, Math.floor(i / perRow) * fh, fw, fh);
      }
    } else texture.add("__BASE", 0, 0, 0, job.w, job.h);
    this.textures.emit(Phaser.Textures.Events.ADD, job.key, texture);
    this.textures.emit(Phaser.Textures.Events.ADD_KEY + job.key, texture);
    this.uploaded.set(job.key, { url: job.url, w: job.w, h: job.h, sheet: job.sheet, wrapper });
    if (job.bounds && job.bbox0 && this.onBounds) this.onBounds(job.key, job.frames, job.bounds, !!job.sheet, job.w, job.h, job.bbox0);
    return true;
  }
}
