/** THE TERRAIN BAKE'S PURE PARTS — chunk math, the depth-row segments in the
 *  live path's order, the shelf packer. No DOM, no Phaser: tested headless
 *  (server/test/terrainbake.test.ts); terrainbake.ts re-exports them and adds
 *  the scene-coupled baker. */

/** Cells per chunk side. 8: a dense chunk of 6-storey columns is ~0.7 Mpx of
 *  art (64 x 154 px a column), which fits one 1024^2 atlas; 16 needed 2.5
 *  Mpx and overflowed at the mountain (measured: 31 segments, 448 ops). An
 *  edit dirties 64 cells of walk. */
export const BAKE_CHUNK = 8;
/** ONE atlas size for every chunk — the capture pool keys its render targets
 *  by size, so one size is one pooled entry (4 MB) however many chunks bake. */
export const BAKE_ATLAS_W = 1024;
export const BAKE_ATLAS_H = 1024;
/** Atlases a chunk may spread over before it is declared unbakeable (live). */
export const BAKE_MAX_PAGES = 2;
/** Per-frame budget for walking and drawing, ms. ONE, honoured per cell and
 *  per segment: the first unit of work past the deadline ends the slice (2,
 *  checked only between chunks, let a phone frame run 36-84 ms). */
export const BAKE_MS = 1;
/** Resident atlases before the least recently wanted chunk is evicted. */
export const BAKE_MAX_ATLASES = 24;
/** A chunk with cells left live (their art streaming) is walked again after
 *  this long, doubling to BAKE_RETRY_MAX_MS while nothing lands. */
export const BAKE_RETRY_MS = 3000;
export const BAKE_RETRY_MAX_MS = 30000;
/** A standing bake a landed transition refreshed re-walks no sooner than this
 *  after its last walk: landings come per frame while streaming, and a
 *  re-walk per landing was a 64-cell walk per frame. */
export const BAKE_REFRESH_MIN_MS = 5000;
/** The atlas pool's warm target per size, filled ONE atlas per idle frame
 *  (a frame the bake had nothing else to do): a bake then finds its pages
 *  pooled instead of allocating them in the frame it packs (a 1024 texture
 *  and its framebuffer are the one unit the bake cannot slice). */
export const BAKE_WARM: ReadonlyArray<readonly [number, number]> = [[BAKE_ATLAS_W, 2], [512, 4], [256, 4]];
/** Slots per cell in the live path's depth epsilon band (tiles3Occluders). */
export const BAKE_SLOTS = 40;
export const BAKE_U_WRAP = 128;

/* ---------------------------------------------------------------- pure --- */

export interface BakeOp {
  key: string;
  x: number;
  y: number;
  /** Diagonal row (col + row): the depth row. */
  v: number;
  /** Diagonal (col - row): the order along the row. */
  u: number;
  /** The op's index inside its cell's walk (the live path's seq++). */
  i: number;
  w: number;
  h: number;
  role: string;
}

export interface BakeSegment {
  v: number;
  u0: number;
  u1: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The live path's depth of the segment's first op: base + slot(u0)*eps. */
  depth: number;
  ops: BakeOp[];
  /** Atlas page and placement, after packing. */
  page: number;
  ax: number;
  ay: number;
}

export const chunkOf = (col: number, row: number): [number, number] => [Math.floor(col / BAKE_CHUNK), Math.floor(row / BAKE_CHUNK)];
export const chunkKey = (cx: number, cy: number): number => cy * 4096 + cx;

/** The live path's slot base for a cell on diagonal `u`. */
export function slotOf(u: number): number {
  return (((u % BAKE_U_WRAP) + BAKE_U_WRAP) % BAKE_U_WRAP) * BAKE_SLOTS;
}

/** The chunks whose cells can lie in the diagonal window [u0,u1]x[v0,v1]
 *  (col = (u+v)/2, row = (v-u)/2), clipped to the world. */
export function chunksInWindow(u0: number, u1: number, v0: number, v1: number, worldW: number, worldH: number): [number, number][] {
  const c0 = Math.max(0, Math.floor((u0 + v0) / 2));
  const c1 = Math.min(worldW - 1, Math.ceil((u1 + v1) / 2));
  const r0 = Math.max(0, Math.floor((v0 - u1) / 2));
  const r1 = Math.min(worldH - 1, Math.ceil((v1 - u0) / 2));
  const out: [number, number][] = [];
  if (c1 < c0 || r1 < r0) return out;
  for (let cy = Math.floor(r0 / BAKE_CHUNK); cy <= Math.floor(r1 / BAKE_CHUNK); cy++)
    for (let cx = Math.floor(c0 / BAKE_CHUNK); cx <= Math.floor(c1 / BAKE_CHUNK); cx++) out.push([cx, cy]);
  return out;
}

/** Group a chunk's ops into depth-row segments in the live path's order.
 *  `baseDepth(v)` is the row's base (oy + v*dy + dy); `eps` OCC_DEPTH_EPS.
 *  A segment breaks where the next cell is not the row's next (u + 2), at the
 *  u%128 wrap, and where its box would exceed `maxW` — so every segment fits
 *  an atlas shelf. Ops inside a segment keep (u, i) order = the live order. */
export function buildSegments(ops: readonly BakeOp[], baseDepth: (v: number) => number, eps: number, maxW: number, maxH: number): BakeSegment[] {
  const byRow = new Map<number, BakeOp[]>();
  for (const op of ops) {
    let a = byRow.get(op.v);
    if (!a) byRow.set(op.v, (a = []));
    a.push(op);
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  const out: BakeSegment[] = [];
  for (const v of rows) {
    const list = byRow.get(v)!;
    list.sort((a, b) => a.u - b.u || a.i - b.i);
    let seg: BakeSegment | null = null;
    let lastU = NaN;
    for (const op of list) {
      const wrap = !Number.isNaN(lastU) && slotOf(op.u) < slotOf(lastU);
      const gap = !Number.isNaN(lastU) && op.u !== lastU && op.u !== lastU + 2;
      let nx0 = op.x, ny0 = op.y, nx1 = op.x + op.w, ny1 = op.y + op.h;
      if (seg) {
        nx0 = Math.min(seg.x0, nx0);
        ny0 = Math.min(seg.y0, ny0);
        nx1 = Math.max(seg.x1, nx1);
        ny1 = Math.max(seg.y1, ny1);
      }
      const tooBig = !!seg && op.u !== lastU && (nx1 - nx0 > maxW || ny1 - ny0 > maxH);
      if (!seg || wrap || gap || tooBig) {
        seg = { v, u0: op.u, u1: op.u, x0: op.x, y0: op.y, x1: op.x + op.w, y1: op.y + op.h, depth: baseDepth(v) + slotOf(op.u) * eps, ops: [], page: -1, ax: 0, ay: 0 };
        out.push(seg);
      } else {
        seg.x0 = nx0;
        seg.y0 = ny0;
        seg.x1 = nx1;
        seg.y1 = ny1;
      }
      seg.ops.push(op);
      seg.u1 = op.u;
      lastU = op.u;
    }
  }
  return out;
}

/** Shelf-pack the segments' boxes into pages of W x H. Sorted by height so a
 *  shelf wastes little; a box wider than W or taller than H is unplaceable.
 *  Returns the number of pages used; `page` is -1 on a segment that did not
 *  fit within `maxPages`. */
export function packShelves(segs: BakeSegment[], W: number, H: number, maxPages: number): number {
  const order = segs.map((s, idx) => idx).sort((a, b) => segs[b].y1 - segs[b].y0 - (segs[a].y1 - segs[a].y0) || segs[b].x1 - segs[b].x0 - (segs[a].x1 - segs[a].x0));
  let page = 0;
  let shelfY = 0;
  let shelfH = 0;
  let x = 0;
  for (const idx of order) {
    const s = segs[idx];
    const w = s.x1 - s.x0;
    const h = s.y1 - s.y0;
    s.page = -1;
    if (w > W || h > H || w <= 0 || h <= 0) continue;
    if (x + w > W) {
      // next shelf
      shelfY += shelfH;
      shelfH = 0;
      x = 0;
    }
    if (shelfY + h > H) {
      // next page
      page++;
      shelfY = 0;
      shelfH = 0;
      x = 0;
      if (page >= maxPages) return page;
    }
    s.page = page;
    s.ax = x;
    s.ay = shelfY;
    x += w;
    if (h > shelfH) shelfH = h;
  }
  return page + 1;
}

