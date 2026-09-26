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
  withEdge,
  buildPlatePixels,
  fadeOverlay,
  patternSheets,
  type ComposeJob,
  type ComposeSide,
  type RampJob,
  type PatternSheets,
  type Pixels,
} from "./tiles3draw";
import { rampFullShape, shapeOf, SHADE_ROWS, type RampTile } from "./tiles3gpu";

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
/** THE GPU COMPOSITOR'S PREP (tiles3gpu GpuComposer), off the frame thread: a
 *  plate's pixels (decoded and conformed once, here, as for a boundary), a
 *  boundary's shape, a ramp's shape — each the same functions the frame
 *  thread would run, answered once per id. */
export type GpuPrepReq =
  | { kind: "plate"; id: string; side: ComposeSide }
  | { kind: "bshape"; key: string; job: Extract<ComposeJob, { kind: "boundary" }> }
  | { kind: "rshape"; key: string; job: RampJob };
export interface GpuPrep {
  type: "gpuprep";
  gen: number;
  reqs: GpuPrepReq[];
}
export type ComposeIn = ComposeInit | ComposeReq | GpuPrep;
export type ComposeOut =
  | { type: "ready"; gen: number; ms: number }
  | { type: "failed"; gen: number; error: string }
  | { type: "composed"; gen: number; key: string; w: number; h: number; data: ArrayBuffer; ms: number }
  | { type: "miss"; gen: number; key: string; error: string }
  | { type: "gpuplate"; gen: number; id: string; w: number; h: number; data: ArrayBuffer }
  | { type: "gpushape"; gen: number; key: string; data: ArrayBuffer }
  | { type: "gpurshape"; gen: number; key: string; h: number; map: ArrayBuffer; shades: ArrayBuffer }
  | { type: "gpumiss"; gen: number; id: string; error: string };

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
  const id = `${side.topOnly ? "t:" : ""}${side.rise ? `r${side.rise}:` : ""}${side.kind === "conform" ? `c:${side.wall.join(",")}:` : "p:"}${side.path}`;
  let p = plates.get(id);
  if (!p) {
    p = decode(side.url).then((src) => buildPlatePixels(sheets!, { kind: side.kind, path: side.path, topOnly: side.topOnly, rise: side.rise }, src, side.wall));
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
    } else if (j.kind === "plate") {
      // The memoised side raster, COPIED: the post below transfers the buffer,
      // and a transferred buffer is detached from the memo a boundary job
      // would read next.
      const p = await plate(j.side);
      if (g !== gen) return;
      t0 = performance.now();
      px = { w: p.w, h: p.h, data: new Uint8ClampedArray(p.data) };
    } else {
      const [a, b] = await Promise.all([plate(j.a), plate(j.b)]);
      if (g !== gen) return;
      t0 = performance.now();
      // ...with the cell's outline, as the main thread builds it (tiles3draw `withEdge`).
      px = withEdge(sheets, buildBoundaryPixels(sheets, { maskFrame: j.frame, topOnly: j.topOnly, noWall: j.noWall, slope: j.slope }, a, b, j.seam), j.edge);
    }
    const data = px.data.buffer as ArrayBuffer;
    post({ type: "composed", gen: g, key: j.key, w: px.w, h: px.h, data, ms: performance.now() - t0 }, [data]);
  } catch (e) {
    post({ type: "miss", gen: g, key: j.key, error: String((e as Error)?.message ?? e) });
  }
}

/** A plate's pixels as the GPU uploads them: conformed like a boundary's side,
 *  or the raw art (`kind` "raw": a ramp's band, a clean ramp's top). */
function gpuPlate(side: ComposeSide): Promise<Pixels> {
  return side.kind === "raw" ? decode(side.url) : plate(side);
}

async function gpuPrep(g: number, r: GpuPrepReq): Promise<void> {
  try {
    if (!sheets) throw new Error("not ready");
    if (r.kind === "plate") {
      const px = await gpuPlate(r.side);
      if (g !== gen) return;
      const data = new Uint8ClampedArray(px.data).buffer as ArrayBuffer; // a copy: the memo keeps its own
      post({ type: "gpuplate", gen: g, id: r.id, w: px.w, h: px.h, data }, [data]);
    } else if (r.kind === "bshape") {
      const [a, b] = r.job.slope ? await Promise.all([plate(r.job.a), plate(r.job.b)]) : [undefined, undefined];
      if (g !== gen) return;
      const data = new Uint8Array(shapeOf(sheets, r.job, a, b)).buffer as ArrayBuffer;
      post({ type: "gpushape", gen: g, key: r.key, data }, [data]);
    } else {
      const j = r.job;
      const band = await gpuPlate(j.band);
      const t: RampTile = j.top.kind === "plate" ? { job: j, band, top: await gpuPlate(j.top.side) } : { job: j, band, a: await plate(j.top.job.a), b: await plate(j.top.job.b) };
      if (g !== gen) return;
      const full = rampFullShape(sheets, t);
      // the shade of every top texel as VALUES: the frame thread keeps its own table
      const shades = new Float64Array(sheets.fw * 64 * 2).fill(-1);
      for (let y = 0; y < full.h; y++)
        for (let x = 0; x < full.shape.w; x++) {
          const r0 = full.shape.row[y * full.shape.w + x];
          if (r0 < 0) continue;
          const [srb, sg] = SHADE_ROWS[r0];
          shades[(y * sheets.fw + x) * 2] = srb;
          shades[(y * sheets.fw + x) * 2 + 1] = sg;
        }
      const map = new Uint8Array(full.map).buffer as ArrayBuffer;
      post({ type: "gpurshape", gen: g, key: r.key, h: full.h, map, shades: shades.buffer as ArrayBuffer }, [map, shades.buffer as ArrayBuffer]);
    }
  } catch (e) {
    post({ type: "gpumiss", gen: g, id: r.kind === "plate" ? r.id : r.key, error: String((e as Error)?.message ?? e) });
  }
}

self.onmessage = (ev: MessageEvent<ComposeIn>) => {
  const m = ev.data;
  if (m.type === "init") init(m).catch((e) => post({ type: "failed", gen: m.gen, error: String((e as Error)?.message ?? e) }));
  else if (m.type === "compose" && m.gen === gen) for (const j of m.jobs) void compose(m.gen, j);
  else if (m.type === "gpuprep" && m.gen === gen) for (const r of m.reqs) void gpuPrep(m.gen, r);
};
