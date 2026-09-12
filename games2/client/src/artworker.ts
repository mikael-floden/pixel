/* THE ART QUEUE'S DECODER, ON ANOTHER CORE (docs/perf.md, THE ART QUEUE
 * DECODES ON A WORKER AND UPLOADS IN BANDS).
 *
 * WHY. The queue used to hand `texImage2D` an <img> it had already `decode()`d,
 * and Chrome decodes the WebP AGAIN inside that call — every time, for every
 * strip: measured 5.8-9.2 ms of main thread per monster strip headless and
 * 4.5-8.9 ms on his phone (the beacon's `texUp.p90/max`), i.e. one whole frame
 * per landing, which is exactly the "every slow frame carried a texture upload"
 * the byte budget was built to bound and could not, because the atom was the
 * decode, not the bytes. An ImageBitmap made from the file's bytes HERE, on a
 * worker, is already pixels: the main thread's `texSubImage2D` of a 128 KB
 * band is a copy, measured 0.0-0.2 ms, and the budget finally means what it
 * says.
 *
 * WHAT ELSE HAPPENS HERE. `artBounds` (WorldScene) measures each frame's
 * opaque box on first use by drawing the source into a canvas — a second
 * decode per frame on the main thread. The pixels are in hand here, so the
 * boxes are measured once, off the main thread, and travel with the bands.
 * The other alpha readers (the outline, the foam clamp) ask for a frame's
 * alpha on demand (`alpha`), and the last few decoded files stay here for it.
 *
 * THE MAIN THREAD BUILDS EVERY URL (staging rewrites `/assets/**` onto a CDN;
 * this file must never re-derive one). Nothing here touches WebGL: a worker
 * has none, so the upload stays with the queue. */

export interface ArtWorkerLoad {
  type: "load";
  id: number;
  url: string;
  /** Bytes per band (the queue's per-frame budget); 0 = one band, the whole image. */
  bandBytes: number;
  sheet?: { frameWidth: number; frameHeight: number };
}
export interface ArtWorkerOk {
  type: "ok";
  id: number;
  w: number;
  h: number;
  /** Rows per band (the last band may be shorter). */
  rows: number;
  /** Frames in the sheet (1 for a plain image), and their opaque boxes in
   *  FRAME px — x0, y0, x1, y1 per frame, exclusive ends, exactly what
   *  `artBounds` measures (alpha > 16; an empty frame is its whole box). */
  frames: number;
  bounds: Int32Array;
  /** The whole image's box at alpha > 0 — `alphaBBox`'s rule (scenery3.ts),
   *  which `sceneryArtFit` crops a still by; x0 y0 x1 y1 exclusive, or all
   *  -1 for a fully transparent image (alphaBBox answers null). */
  bbox0: Int32Array;
  bands: ImageBitmap[];
}
export interface ArtWorkerErr {
  type: "err";
  id: number;
  error: string;
}
/** A FRAME'S ALPHA ON DEMAND (Smooth 5): a rectangle of a file this worker
 *  already decoded for its bands — the outline and the foam clamp read alpha
 *  and used to read the GL texture back inside the frame for it (63 and 32 ms
 *  on his phone). The bytes are in the HTTP cache; the last few decoded files
 *  stay here, so a marked body's frames cost one decode per file. */
export interface ArtWorkerAlpha {
  type: "alpha";
  id: number;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ArtWorkerAlphaOk {
  type: "alpha";
  id: number;
  w: number;
  h: number;
  /** The rectangle's alpha, row-major, one byte per texel. */
  a: Uint8Array;
}
export type ArtWorkerIn = ArtWorkerLoad | ArtWorkerAlpha;
export type ArtWorkerOut = ArtWorkerOk | ArtWorkerErr | ArtWorkerAlphaOk;

/** Premultiplied HERE, so the upload under Phaser's
 *  `UNPACK_PREMULTIPLY_ALPHA_WEBGL true` is a copy and not a conversion; the
 *  colour-space rule is the browser default, the same rule the <img> path
 *  uploaded under. Gate: `__ml.artParity(key)` reads both textures back. */
const OPTS: ImageBitmapOptions = { premultiplyAlpha: "premultiply", colorSpaceConversion: "default" };
/** artBounds' own alpha threshold. */
const ALPHA_MIN = 16;

function post(m: ArtWorkerOut, transfer?: Transferable[]): void {
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(m, transfer);
}

/** THE LAST FEW DECODED FILES, kept for the alpha readers (a marked body asks
 *  for its frames one after another; a strip that just landed is asked for
 *  first). Bounded: the oldest is closed when a fifth arrives. */
const RECENT_MAX = 4;
const recent = new Map<string, ImageBitmap>();
function remember(url: string, whole: ImageBitmap): void {
  const had = recent.get(url);
  if (had && had !== whole) had.close();
  recent.delete(url);
  recent.set(url, whole);
  while (recent.size > RECENT_MAX) {
    const first = recent.keys().next().value as string;
    recent.get(first)?.close();
    recent.delete(first);
  }
}
async function wholeOf(url: string): Promise<ImageBitmap> {
  const hit = recent.get(url);
  if (hit && hit.width > 0) {
    recent.delete(url);
    recent.set(url, hit); // most recent again
    return hit;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const whole = await createImageBitmap(await res.blob(), OPTS);
  remember(url, whole);
  return whole;
}

/** The frame grid is Phaser's SpriteSheet parser's: whole frames only, left to
 *  right then top to bottom, no margin or spacing (the queue passes none). */
function boundsOf(whole: ImageBitmap, sheet?: { frameWidth: number; frameHeight: number }): { frames: number; bounds: Int32Array; bbox0: Int32Array } {
  const w = whole.width;
  const h = whole.height;
  const fw = sheet ? sheet.frameWidth : w;
  const fh = sheet ? sheet.frameHeight : h;
  const perRow = Math.max(1, Math.floor(w / fw));
  const perCol = Math.max(1, Math.floor(h / fh));
  const frames = sheet ? perRow * perCol : 1;
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(whole, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  // alphaBBox's box: any alpha above 0, over the whole image.
  const bbox0 = new Int32Array([-1, -1, -1, -1]);
  {
    let l = w, t = h, r = -1, b = -1;
    for (let y = 0; y < h; y++) {
      let p = y * w * 4 + 3;
      for (let x = 0; x < w; x++, p += 4)
        if (d[p] !== 0) {
          if (x < l) l = x;
          if (x > r) r = x;
          if (y < t) t = y;
          if (y > b) b = y;
        }
    }
    if (r >= 0) {
      bbox0[0] = l;
      bbox0[1] = t;
      bbox0[2] = r + 1;
      bbox0[3] = b + 1;
    }
  }
  const out = new Int32Array(frames * 4);
  for (let i = 0; i < frames; i++) {
    const ox = (i % perRow) * fw;
    const oy = Math.floor(i / perRow) * fh;
    const cw = Math.min(fw, w - ox);
    const ch = Math.min(fh, h - oy);
    let x0 = cw;
    let y0 = ch;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < ch; y++) {
      let p = ((oy + y) * w + ox) * 4 + 3;
      for (let x = 0; x < cw; x++, p += 4)
        if (d[p] > ALPHA_MIN) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    }
    const o = i * 4;
    if (x1 >= x0) {
      out[o] = x0;
      out[o + 1] = y0;
      out[o + 2] = x1 + 1;
      out[o + 3] = y1 + 1;
    } else {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = cw;
      out[o + 3] = ch;
    }
  }
  return { frames, bounds: out, bbox0 };
}

async function load(m: ArtWorkerLoad): Promise<void> {
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") throw new Error("no OffscreenCanvas");
    const whole = await wholeOf(m.url);
    const w = whole.width;
    const h = whole.height;
    if (!w || !h) throw new Error("empty image");
    const { frames, bounds, bbox0 } = boundsOf(whole, m.sheet);
    const rows = m.bandBytes > 0 ? Math.max(1, Math.min(h, Math.floor(m.bandBytes / (w * 4)))) : h;
    const bands: ImageBitmap[] = [];
    for (let y = 0; y < h; y += rows) bands.push(await createImageBitmap(whole, 0, y, w, Math.min(rows, h - y), OPTS));
    // `whole` stays in `recent` for the alpha readers (bounded there).
    post({ type: "ok", id: m.id, w, h, rows, frames, bounds, bbox0, bands }, [bounds.buffer, bbox0.buffer, ...bands]);
  } catch (e) {
    post({ type: "err", id: m.id, error: String((e as Error)?.message ?? e) });
  }
}

async function alpha(m: ArtWorkerAlpha): Promise<void> {
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") throw new Error("no OffscreenCanvas");
    const whole = await wholeOf(m.url);
    const w = Math.max(0, Math.min(m.w, whole.width - m.x));
    const h = Math.max(0, Math.min(m.h, whole.height - m.y));
    if (!w || !h) throw new Error("empty rectangle");
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(whole, m.x, m.y, w, h, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const a = new Uint8Array(w * h);
    for (let i = 0, q = 3; i < a.length; i++, q += 4) a[i] = d[q];
    post({ type: "alpha", id: m.id, w, h, a }, [a.buffer]);
  } catch (e) {
    post({ type: "err", id: m.id, error: String((e as Error)?.message ?? e) });
  }
}

self.onmessage = (ev: MessageEvent<ArtWorkerIn>) => {
  if (ev.data?.type === "load") void load(ev.data);
  else if (ev.data?.type === "alpha") void alpha(ev.data);
};
