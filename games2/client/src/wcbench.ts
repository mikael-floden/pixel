/* DISK VS DRAW — THE ONE-TAP TEST ON HIS PHONE (Settings->Dev "Disk vs draw
 * test"; maintainer 2026-09-26: "I WANT TO KNOW IF ITS FASTER TO DRAW OR LOAD
 * FROM DISK?!" and "You should not assume it's faster without testing on my
 * phone!"). The scene draws the ground tiles nearest the view and times it;
 * this module is the other half — a picture saved to the phone's disk and
 * loaded back, each step timed where it runs (the frame thread, or the
 * browser's own threads), and the picture that came back compared with the
 * one that went in, texel for texel. Nothing is kept: the scratch database
 * is emptied when the test ends. */

const DB = "ml-wc-bench";
const STORE = "tiles";

export function benchDb(): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    const q = indexedDB.open(DB, 1);
    q.onupgradeneeded = () => q.result.createObjectStore(STORE);
    q.onsuccess = () => ok(q.result);
    q.onerror = () => no(q.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (st: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((ok, no) => {
    const t = db.transaction(STORE, mode);
    const q = fn(t.objectStore(STORE));
    t.oncomplete = () => ok(q.result);
    t.onerror = () => no(t.error);
    t.onabort = () => no(t.error);
  });
}

export const benchPut = (db: IDBDatabase, key: string, blob: Blob): Promise<IDBValidKey> => tx(db, "readwrite", (st) => st.put(blob, key));
export const benchGet = (db: IDBDatabase, key: string): Promise<Blob | undefined> => tx(db, "readonly", (st) => st.get(key) as IDBRequest<Blob | undefined>);
export const benchClear = (db: IDBDatabase): Promise<undefined> => tx(db, "readwrite", (st) => st.clear());

/** The picture as a lossless WebP (quality 1 is Chrome's lossless encoder;
 *  the test checks that on the phone rather than trusting it), encoded by the
 *  browser off the frame thread. */
export async function benchEncode(px: Uint8Array, w: number, h: number): Promise<Blob> {
  const oc = new OffscreenCanvas(w, h);
  const g = oc.getContext("2d");
  if (!g) throw new Error("no 2d context");
  const img = new ImageData(w, h);
  img.data.set(px);
  g.putImageData(img, 0, 0);
  return oc.convertToBlob({ type: "image/webp", quality: 1 });
}

/** Decoded by the browser off the frame thread, bytes as stored. */
export const benchDecode = (blob: Blob): Promise<ImageBitmap> =>
  createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });

export interface BenchTile {
  /** Drawing the tile: the first time (what was not cached is built) and again. */
  drawFirstMs: number;
  drawMs: number;
  /** Saving: the read off the GPU (frame thread) + encode and write (browser). */
  readMs: number;
  encodeMs: number;
  writeMs: number;
  /** Loading: read and decode (browser) + the upload (frame thread). */
  getMs: number;
  decodeMs: number;
  uploadMs: number;
  kb: number;
  /** Texels of the tile's diamond that came back different (0 = exact). */
  bad: number;
}

const median = (a: number[]): number => {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? b[b.length >> 1] : 0;
};

/** The medians over the tiles, and the one-line verdict he reads. */
export function benchSummary(t: BenchTile[]): { line: string; counts: Record<string, number> } {
  const m = (k: keyof BenchTile) => +median(t.map((x) => x[k])).toFixed(1);
  const draw = m("drawMs");
  const drawFirst = m("drawFirstMs");
  const loadFrame = m("uploadMs");
  const loadBg = +(m("getMs") + m("decodeMs")).toFixed(1);
  const saveFrame = m("readMs");
  const saveBg = +(m("encodeMs") + m("writeMs")).toFixed(1);
  const bad = t.reduce((n, x) => n + x.bad, 0);
  const faster = loadFrame < draw ? `disk is ${(draw / Math.max(0.05, loadFrame)).toFixed(0)}x cheaper on the frame` : `DRAWING is cheaper on the frame`;
  const line =
    `${t.length} tiles, medians — DRAW ${draw} ms on the frame (first time ${drawFirst}) | ` +
    `LOAD from disk ${loadFrame} ms on the frame + ${loadBg} ms in the background | ` +
    `SAVE ${saveFrame} ms on the frame + ${saveBg} ms in the background | ${m("kb")} KB a tile | ` +
    `${bad ? `NOT EXACT: ${bad} texels differ` : "exact: every texel came back the same"} — ${faster}`;
  return {
    line,
    counts: { wbN: t.length, wbDraw: draw, wbDraw1: drawFirst, wbLoad: loadFrame, wbLoadBg: loadBg, wbSave: saveFrame, wbSaveBg: saveBg, wbKb: m("kb"), wbBad: bad },
  };
}
