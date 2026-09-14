/* THE COMPOSE WORKER — the ground ahead of the player is prepared OFF THE
 * FRAME THREAD (maintainer 2026-09-12: "a background thread that prepares the
 * world you are next to enter"; "You must not do everything on the main
 * thread!").
 *
 * A boundary transition or a fade overlay is pure pixel math over 64x46
 * rasters (`composeBoundary`, `fadeOverlay`, `conformPlate`), and what made a
 * composition cost 3-10 ms on his phone was never the math: it was reading the
 * decoded plate back out of the browser (`sourcePixels`: a canvas draw and a
 * getImageData that stalls on the GPU) and, before `addRaw`, the canvas
 * registration. Here the worker fetches the plate itself (a cache hit — the
 * ground loader has asked for the same file), decodes it with
 * `createImageBitmap`, reads it through an OffscreenCanvas, composes, and posts
 * the raster back with its buffer transferred; the main thread's whole cost is
 * one `texImage2D` of 11,776 bytes.
 *
 * THE SAME CODE ON BOTH THREADS. `buildPlatePixels` and `buildBoundaryPixels`
 * are the functions the main-thread factory composes with, so a raster from
 * here is the raster the frame thread would have built; `__ml.composeWorker
 * ({audit:true})` proves it byte for byte on the live game. The main thread
 * never waits: a composition still in flight draws the plain plate, exactly as
 * a budget-refused one did, and lands through the same owed-cell retry. */
import type { PatternsDoc } from "./tiles3";
import {
  buildBoundaryPixels,
  buildPlatePixels,
  fadeOverlay,
  patternSheets,
  type ComposeJob,
  type ComposeSide,
  type PatternSheets,
  type Pixels,
} from "./tiles3draw";

export interface ComposeInit {
  type: "init";
  gen: number;
  patterns: PatternsDoc;
  /** The three pattern sheets, as URLs the MAIN thread routed (staging + the
   *  version pin live there and nowhere else). */
  sheets: { silhouette: string; masks: string; border: string };
}
export interface ComposeReq {
  type: "compose";
  gen: number;
  jobs: ComposeJob[];
}
export type ComposeIn = ComposeInit | ComposeReq;
export type ComposeOut =
  | { type: "ready"; gen: number; ms: number }
  | { type: "failed"; gen: number; error: string }
  | { type: "composed"; gen: number; key: string; w: number; h: number; data: ArrayBuffer; ms: number }
  | { type: "miss"; gen: number; key: string; error: string };

let gen = 0;
let sheets: PatternSheets | null = null;
/** Decoded sources by URL, and conformed plates by identity — the worker's own
 *  copies of what `Tiles3Textures.pix` holds on the frame thread. */
const raw = new Map<string, Promise<Pixels>>();
const plates = new Map<string, Promise<Pixels>>();

const post = (m: ComposeOut, transfer?: Transferable[]): void => {
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(m, transfer);
};

function decode(url: string): Promise<Pixels> {
  let p = raw.get(url);
  if (!p) {
    p = (async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      const bmp = await createImageBitmap(await r.blob());
      const w = bmp.width;
      const h = bmp.height;
      const cv = new OffscreenCanvas(w, h);
      const ctx = cv.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) throw new Error("no 2d context in the worker");
      ctx.drawImage(bmp, 0, 0);
      const id = ctx.getImageData(0, 0, w, h);
      bmp.close();
      return { w, h, data: new Uint8ClampedArray(id.data) };
    })();
    raw.set(url, p);
    p.catch(() => raw.delete(url)); // a failed fetch is asked again next time, never cached
  }
  return p;
}

function plate(side: ComposeSide): Promise<Pixels> {
  const id = `${side.topOnly ? "t:" : ""}${side.kind === "conform" ? `c:${side.wall.join(",")}:` : "p:"}${side.path}`;
  let p = plates.get(id);
  if (!p) {
    p = decode(side.url).then((src) => buildPlatePixels(sheets!, { kind: side.kind, path: side.path, topOnly: side.topOnly }, src, side.wall));
    plates.set(id, p);
    p.catch(() => plates.delete(id));
  }
  return p;
}

async function init(msg: ComposeInit): Promise<void> {
  const t0 = performance.now();
  gen = msg.gen;
  sheets = null;
  raw.clear();
  plates.clear();
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function")
    throw new Error("no OffscreenCanvas or createImageBitmap in this worker");
  const [sil, masks, border] = await Promise.all([decode(msg.sheets.silhouette), decode(msg.sheets.masks), decode(msg.sheets.border)]);
  if (msg.gen !== gen) return;
  sheets = patternSheets(msg.patterns, sil, masks, border);
  post({ type: "ready", gen, ms: performance.now() - t0 });
}

async function compose(g: number, j: ComposeJob): Promise<void> {
  try {
    if (!sheets) throw new Error("not ready");
    let px: Pixels;
    let t0: number;
    // `ms` is the compose alone: a batch's jobs all wait on the same few
    // decodes, and counting that wait per job would sum overlapping time.
    if (j.kind === "fade") {
      const src = await decode(j.side.url);
      if (g !== gen) return;
      t0 = performance.now();
      px = fadeOverlay(sheets, src, j.top, j.side.wall);
    } else {
      const [a, b] = await Promise.all([plate(j.a), plate(j.b)]);
      if (g !== gen) return;
      t0 = performance.now();
      px = buildBoundaryPixels(sheets, { maskFrame: j.frame, topOnly: j.topOnly, noWall: j.noWall }, a, b, j.seam);
    }
    const data = px.data.buffer as ArrayBuffer;
    post({ type: "composed", gen: g, key: j.key, w: px.w, h: px.h, data, ms: performance.now() - t0 }, [data]);
  } catch (e) {
    post({ type: "miss", gen: g, key: j.key, error: String((e as Error)?.message ?? e) });
  }
}

self.onmessage = (ev: MessageEvent<ComposeIn>) => {
  const m = ev.data;
  if (m.type === "init") init(m).catch((e) => post({ type: "failed", gen: m.gen, error: String((e as Error)?.message ?? e) }));
  else if (m.type === "compose" && m.gen === gen) for (const j of m.jobs) void compose(m.gen, j);
};
