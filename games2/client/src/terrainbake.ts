/** TERRAIN BAKE — the raised terrain of a chunk drawn ONCE into an atlas, one
 *  image per depth-row segment, instead of one sprite per course, cap, deck and
 *  boundary every frame.
 *
 *  WHY. His 16:50 run on 0b274482 (Mali-G715): 2,200-5,600 occluder sprites
 *  in a 4,000-10,000-object display list, re-sorted (2.0 ms), re-culled
 *  (1.0 ms) and re-submitted (the bulk of render's 3.0 ms) every frame, 18-27
 *  megapixels of fill a frame (stacked courses overlap; a tiler pays for every
 *  quad), 16,433 live textures. Maintainer 2026-09-24: "I'm fully sold ...
 *  Let's do the entire work ... without changing the look and feel!"
 *
 *  THE INVARIANT THAT MAKES IT EXACT. Every occluder image on one diagonal row
 *  `v` shares one base depth (`oy + v*dy + dy`, see tiles3Occluders) and the
 *  row's images are ordered inside an epsilon band (OCC_DEPTH_EPS, 40 slots a
 *  cell, u wrapped at 128) that no body ever enters (bodies sit ≥ +0.01 above
 *  a base). So a row's images can be composited once, in that same order,
 *  into a texture and drawn as ONE quad at the row's depth: every body sorts
 *  against the quad exactly as it sorted against the images, the cover raster
 *  erases the quad's texels exactly as it erased theirs (it reads bounds,
 *  depth and texture, nothing else — coverDrawOccluders), the night shader
 *  never sees sprites (per-pixel surface resolve from world data), and the
 *  meta records the depth rule and the cover lines read are still produced by
 *  the walk. Compositing is premultiplied "over", which is associative, so a
 *  band over the ground equals its images over the ground.
 *
 *  A SEGMENT, NOT A ROW: a row is split where cells are not adjacent (a gap
 *  between two mountains), where the atlas would overflow, and at the u%128
 *  wrap (the live path's slot order restarts there; the split keeps the
 *  segment order equal to the image order). Each segment's frame is trimmed
 *  to its ops' union, so the fill the GPU pays is the terrain's own area —
 *  the overlapping courses of a column collapse to one layer at bake time.
 *
 *  THE LIVE PATH STAYS. A chunk bakes only when every cell's art has landed
 *  (a cell the walk reports `incomplete` is still streaming; the chunk retries
 *  later) and the indoor cut-away is off (the mask rewrites columns per room —
 *  those cells draw live, as today). An edited cell dirties its chunk: the
 *  chunk's cells draw live from the next rebuild and the chunk re-bakes in
 *  sliced work, then swaps back (maintainer: "a changed part of the map
 *  renders the old way while old static parts render in a more efficient
 *  way"). Off (`?bake=0`, Settings→Dev "terrain bake") every chunk is live —
 *  the A/B and the fallback; `verify-bake.mjs` holds the two ways to the same
 *  texels.
 *
 *  COST SHAPE. A chunk walk is the resolver over 256 cells, sliced under
 *  BAKE_MS a frame; the draw is a DynamicTexture bracket per slice, ended
 *  with a blit scissored to the rect it painted (the ground's bracket-tax fix,
 *  groundEndDraw) on a pooled 1024x1024 capture (capturepool.ts: one entry
 *  per SIZE, so every atlas is the same size). Atlases are content-addressed
 *  by generation (`bake:<cx>,<cy>:<gen>`): a re-bake writes a NEW texture and
 *  the old one goes only after the new images stand — nothing is ever
 *  rewritten under a name an image still holds. Resident atlases are capped
 *  (BAKE_MAX_ATLASES), far chunks evicted by last use.
 *
 *  Pure parts (chunk math, segmenting, packing) are tested headless in
 *  terrainbake.test.ts; the baker needs a scene. */

import type Phaser from "phaser";
import { BAKE_CHUNK, BAKE_ATLAS_W, BAKE_ATLAS_H, BAKE_MAX_PAGES, BAKE_MS, BAKE_MAX_ATLASES, BAKE_RETRY_MS, buildSegments, chunkKey, chunksInWindow, packShelves, slotOf, type BakeOp, type BakeSegment } from "./terrainbakecore";
export * from "./terrainbakecore";

/* ------------------------------------------------------------ the baker --- */

/** What a walk hands the bake for one cell (see tiles3Occluders' sink). */
export interface BakeSink {
  op(key: string, x: number, y: number, role: string): void;
  /** Art still streaming, an op the factory could not give: the cell — and
   *  so its chunk — cannot bake yet. */
  incomplete(): void;
}

export interface BakeHost {
  scene: Phaser.Scene;
  worldW: number;
  worldH: number;
  /** oy + v*dy + dy — the row's base depth in the live path. */
  baseDepth(v: number): number;
  eps: number;
  /** Walk ONE cell's terrain ops into the sink: no view cull, no pool, no
   *  incremental state — the same op list the live walk would create images
   *  for. Returns false when the cell has no column (nothing to bake). */
  walkCell(col: number, row: number, sink: BakeSink): void;
  /** Texture size by key (the op's image size); null when it does not exist. */
  sizeOf(key: string): { w: number; h: number } | null;
  /** A chunk just became baked (or live again): the scene drops (or will
   *  re-walk) the live images of these cells. */
  onChunk(cells: number[], baked: boolean): void;
  /** Cells the indoor cut-away masks right now — those chunks stay live. */
  masked(col: number, row: number): boolean;
}

type Img = Phaser.GameObjects.Image;

interface Chunk {
  cx: number;
  cy: number;
  key: number;
  state: "pending" | "walking" | "waiting" | "drawing" | "baked" | "live";
  /** Walk cursor (cell index within the chunk) while walking. */
  cursor: number;
  ops: BakeOp[];
  /** Cells the walk reported incomplete (art streaming): they draw LIVE
   *  inside a baked chunk, and the chunk re-bakes when they land. */
  liveCells: Set<number>;
  /** The live set of the bake that stands (to know when a re-walk gained). */
  bakedLive: Set<number>;
  /** A signature of the ops the standing bake drew: a re-walk that produces
   *  the same one keeps the bake, a different one re-bakes. */
  sig: number;
  /** A cell of a standing bake changed under it (a boundary landed): re-walk. */
  stale: boolean;
  /** The retry interval, doubled per idle re-walk up to BAKE_RETRY_MAX_MS. */
  retryMs: number;
  segs: BakeSegment[];
  pages: string[];
  pageSize: number;
  drawCursor: number;
  images: Img[];
  gen: number;
  wantedAt: number;
  /** Distance of the chunk to the wanted window's centre, in chunks. */
  dist: number;
  retryAt: number;
  /** Why it is live rather than baked, for the beacon. */
  why: string;
  bakeMs: number;
}

export interface BakeRow {
  on: number;
  chunks: number;
  baked: number;
  live: number;
  waiting: number;
  /** Cells drawn live inside baked chunks (art still streaming). */
  liveCells: number;
  images: number;
  atlases: number;
  /** Walk + draw ms spent this window, and the worst single frame's. */
  ms: number;
  peakMs: number;
  bakes: number;
  evicted: number;
  dirtied: number;
  /** Ops composited this window and the largest chunk's op count. */
  ops: number;
  opsMax: number;
  unbakeable: number;
}

/** The atlas sizes a chunk may take, smallest first: a sparse chunk pays for
 *  a sparse atlas. Each is one capture-pool entry. */
const ATLAS_SIZES = [256, 512, BAKE_ATLAS_W];
/** Ops per segment below which a chunk is not worth baking (stays live). */
const BAKE_SPARSE_RATIO = 2;
/** The retry interval's ceiling for a standing bake whose live cells never land. */
const BAKE_RETRY_MAX_MS = 30000;

/** A signature of an op list: order-sensitive (the order is the picture). */
function opsSignature(ops: readonly BakeOp[]): number {
  let h = 2166136261 >>> 0;
  const mix = (n: number) => {
    h ^= n & 0xffff;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= (n >>> 16) & 0xffff;
    h = Math.imul(h, 16777619) >>> 0;
  };
  mix(ops.length);
  for (const op of ops) {
    for (let i = 0; i < op.key.length; i++) mix(op.key.charCodeAt(i));
    mix(op.x | 0);
    mix(op.y | 0);
    mix(op.v);
  }
  return h;
}

export class TerrainBake {
  private chunks = new Map<number, Chunk>();
  private wanted = new Set<number>();
  private gen = 0;
  private userOn = true;
  private suspended = false;
  /** Every band image alive, for the cull and the cover index. */
  images: Img[] = [];
  private win = { ms: 0, peak: 0, bakes: 0, evicted: 0, dirtied: 0, ops: 0, opsMax: 0, unbakeable: 0 };

  constructor(private readonly host: BakeHost) {}

  /** Baking right now: the user's switch, and not suspended. */
  get enabled(): boolean {
    return this.userOn && !this.suspended;
  }

  get on(): boolean {
    return this.userOn;
  }

  /** The Settings switch. Off: every chunk goes live at once (its images and
   *  atlases go); the scene re-walks the window on its next rebuild. */
  setEnabled(on: boolean): void {
    if (on === this.userOn) return;
    this.userOn = on;
    if (!this.enabled) for (const c of [...this.chunks.values()]) this.drop(c, "off");
  }

  /** THE INDOOR CUT-AWAY SUSPENDS THE BAKE: the mask rewrites every column
   *  (roofs and upper storeys cut per room), and a band image cannot be cut.
   *  Indoors every chunk draws live, as today; outdoors again, chunks bake
   *  again. Entering a house is a drop + re-bake, sliced. */
  suspend(on: boolean): void {
    if (on === this.suspended) return;
    this.suspended = on;
    if (!this.enabled) for (const c of [...this.chunks.values()]) this.drop(c, "indoors");
  }

  /** Is this cell drawn by a band image (so the live walk creates none)? A
   *  cell the chunk left live (its art was streaming at bake time) is not. */
  owns(col: number, row: number): boolean {
    if (!this.enabled) return false;
    const c = this.chunks.get(chunkKey(Math.floor(col / BAKE_CHUNK), Math.floor(row / BAKE_CHUNK)));
    return !!c && c.state === "baked" && !c.bakedLive.has(row * this.host.worldW + col);
  }

  /** The rebuild's window: chunks to have baked, nearest the window's centre
   *  first. A chunk that went live for a reason that has passed (the switch,
   *  indoors, an eviction) is pending again. Chunks outside are candidates
   *  for eviction. */
  want(u0: number, u1: number, v0: number, v1: number): void {
    const now = performance.now();
    this.wanted.clear();
    if (!this.enabled) return;
    const list = chunksInWindow(u0, u1, v0, v1, this.host.worldW, this.host.worldH);
    const ccol = (u0 + u1 + v0 + v1) / 4 / BAKE_CHUNK;
    const crow = (v0 + v1 - u0 - u1) / 4 / BAKE_CHUNK;
    for (const [cx, cy] of list) {
      const k = chunkKey(cx, cy);
      this.wanted.add(k);
      let c = this.chunks.get(k);
      if (!c) {
        c = { cx, cy, key: k, state: "pending", cursor: 0, ops: [], liveCells: new Set(), bakedLive: new Set(), sig: 0, stale: false, retryMs: BAKE_RETRY_MS, segs: [], pages: [], pageSize: 0, drawCursor: 0, images: [], gen: 0, wantedAt: now, dist: 0, retryAt: 0, why: "", bakeMs: 0 };
        this.chunks.set(k, c);
      }
      c.wantedAt = now;
      c.dist = Math.hypot(cx + 0.5 - ccol, cy + 0.5 - crow);
      if (c.state === "live" && (c.why === "off" || c.why === "indoors" || c.why === "evicted" || c.why === "edited")) {
        c.state = "pending";
        c.retryAt = 0;
      }
    }
    this.evict();
  }

  /** A cell's ops changed under a standing bake (a boundary or a deck
   *  transition landed on it — the ground pass's own repair): the chunk is
   *  re-walked when its turn comes and re-baked if the ops differ, with the
   *  standing bands drawn meanwhile — never a drop. Cheap when the chunk is
   *  not baked (nothing to do). */
  refresh(col: number, row: number): void {
    const c = this.chunks.get(chunkKey(Math.floor(col / BAKE_CHUNK), Math.floor(row / BAKE_CHUNK)));
    if (!c || c.state !== "baked" || c.stale) return;
    c.stale = true;
    c.retryAt = 0;
  }

  /** An edit at (col,row) (or anything within `radius` cells of it): the
   *  chunks touched draw live from the scene's next rebuild and bake again. */
  dirty(col: number, row: number, radius = 2): number {
    let n = 0;
    const seen = new Set<number>();
    for (let r = row - radius; r <= row + radius; r++)
      for (let c = col - radius; c <= col + radius; c++) {
        if (c < 0 || r < 0 || c >= this.host.worldW || r >= this.host.worldH) continue;
        const k = chunkKey(Math.floor(c / BAKE_CHUNK), Math.floor(r / BAKE_CHUNK));
        if (seen.has(k)) continue;
        seen.add(k);
        const ch = this.chunks.get(k);
        if (!ch) continue;
        this.drop(ch, "edited");
        ch.state = "pending";
        ch.retryAt = 0;
        n++;
      }
    this.win.dirtied += n;
    return n;
  }

  /** Do a slice of work: walk, pack, draw. Called once per frame. */
  step(budgetMs = BAKE_MS): void {
    if (!this.enabled) return;
    const t0 = performance.now();
    const deadline = t0 + budgetMs;
    let guard = 64;
    while (performance.now() < deadline && guard-- > 0) {
      const c = this.pick();
      if (!c) break;
      this.advance(c, deadline);
    }
    const spent = performance.now() - t0;
    this.win.ms += spent;
    if (spent > this.win.peak) this.win.peak = spent;
  }

  private pick(): Chunk | null {
    // A chunk mid-flight first (its slices carry state), then the nearest one
    // that is pending, or waiting with its retry due.
    const now = performance.now();
    let best: Chunk | null = null;
    for (const k of this.wanted) {
      const c = this.chunks.get(k);
      if (!c) continue;
      if (c.state === "walking" || c.state === "drawing") return c;
      const due = c.state === "pending" || ((c.state === "waiting" || (c.state === "baked" && (c.bakedLive.size > 0 || c.stale))) && c.retryAt <= now);
      if (due && (!best || c.dist < best.dist)) best = c;
    }
    return best;
  }

  private advance(c: Chunk, deadline: number): void {
    const host = this.host;
    if (c.state === "pending" || c.state === "waiting" || c.state === "baked") {
      // A baked chunk here is one re-walked for the cells it left live.
      c.state = "walking";
      c.cursor = 0;
      c.ops = [];
      c.liveCells = new Set();
      c.why = "";
    }
    if (c.state === "walking") {
      const n = BAKE_CHUNK * BAKE_CHUNK;
      let masked = false;
      let cellIncomplete = false;
      const sink: BakeSink = {
        op: () => {},
        incomplete: () => {
          cellIncomplete = true;
        },
      };
      while (c.cursor < n && performance.now() < deadline) {
        const i = c.cursor++;
        const col = c.cx * BAKE_CHUNK + (i % BAKE_CHUNK);
        const row = c.cy * BAKE_CHUNK + Math.floor(i / BAKE_CHUNK);
        if (col >= host.worldW || row >= host.worldH) continue;
        if (host.masked(col, row)) {
          masked = true;
          break;
        }
        const u = col - row;
        const v = col + row;
        const idx = row * host.worldW + col;
        let oi = 0;
        const mine: BakeOp[] = [];
        cellIncomplete = false;
        sink.op = (key, x, y, role) => {
          const sz = host.sizeOf(key);
          if (!sz) {
            cellIncomplete = true;
            return;
          }
          // The live sprite draws at the floor of its position (roundPixels);
          // the band draws its texels at the same whole pixel.
          mine.push({ key, x: Math.floor(x), y: Math.floor(y), v, u, i: oi++, w: sz.w, h: sz.h, role });
        };
        host.walkCell(col, row, sink);
        // A cell whose art is streaming draws live inside the baked chunk and
        // the chunk re-walks when the retry comes due.
        if (cellIncomplete) c.liveCells.add(idx);
        else for (const op of mine) c.ops.push(op);
      }
      if (masked) {
        this.finishLive(c, "masked", true);
        return;
      }
      if (c.cursor < n) return; // more cells next frame
      // A re-walk of a standing bake that found the same ops keeps the bake
      // (and backs its retry off); a different picture re-bakes.
      const sig = opsSignature(c.ops);
      if (c.images.length && sig === c.sig && c.liveCells.size >= c.bakedLive.size) {
        c.state = "baked";
        c.stale = false;
        c.retryMs = Math.min(BAKE_RETRY_MAX_MS, c.retryMs * 2);
        c.retryAt = performance.now() + c.retryMs;
        c.ops = [];
        return;
      }
      c.sig = sig;
      // Walked whole: segment and pack into the smallest atlas that takes it.
      c.segs = buildSegments(c.ops, (v) => host.baseDepth(v), host.eps, BAKE_ATLAS_W, BAKE_ATLAS_H);
      /* A SPARSE CHUNK STAYS LIVE: a segment of one op is the sprite it
       * replaces, so an atlas for it buys VRAM and a copy and no fewer
       * objects (a village chunk: ~22 sprites in ~15 rows). The bake is for
       * the mountain, where a row of columns is 60 sprites and one quad. */
      if (c.ops.length < BAKE_SPARSE_RATIO * c.segs.length) {
        this.finishLive(c, `sparse (${c.ops.length} ops in ${c.segs.length} segments)`, false);
        return;
      }
      let pages = 0;
      let size = 0;
      for (const sz of ATLAS_SIZES) {
        pages = packShelves(c.segs, sz, sz, sz === BAKE_ATLAS_W ? BAKE_MAX_PAGES : 1);
        if (!c.segs.some((s) => s.page < 0)) {
          size = sz;
          break;
        }
      }
      if (!size) {
        this.win.unbakeable++;
        this.finishLive(c, `overflow (${c.segs.length} segments, ${c.ops.length} ops)`, false);
        return;
      }
      // The new generation stands beside the old one until its images do.
      const old = { images: c.images, pages: c.pages };
      c.images = [];
      c.gen = ++this.gen;
      c.pages = [];
      c.pageSize = size;
      const scene = host.scene;
      for (let p = 0; p < pages; p++) {
        const key = `bake:${c.cx},${c.cy}:${c.gen}:${p}`;
        const dt = scene.textures.addDynamicTexture(key, size, size);
        if (!dt) {
          c.images = old.images;
          for (const k of c.pages) scene.textures.remove(k);
          c.pages = old.pages;
          this.finishLive(c, "no atlas", false);
          return;
        }
        dt.setFilter(1); // NEAREST — addDynamicTexture does not inherit pixelArt (initCoverSurfaces)
        for (let s = 0; s < c.segs.length; s++) {
          const seg = c.segs[s];
          if (seg.page !== p) continue;
          dt.add(`s${s}`, 0, seg.ax, seg.ay, seg.x1 - seg.x0, seg.y1 - seg.y0);
        }
        c.pages.push(key);
      }
      (c as unknown as { old: typeof old }).old = old;
      c.state = "drawing";
      c.drawCursor = 0;
      c.bakeMs = 0;
    }
    if (c.state === "drawing") {
      const t0 = performance.now();
      const scene = host.scene;
      // One bracket per page per slice: the segments of this page drawn
      // until the deadline, then a blit scissored to their union.
      let page = -1;
      let dt: Phaser.Textures.DynamicTexture | null = null;
      let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
      const end = () => {
        if (dt) endDrawScissored(scene, dt, rx0, ry0, rx1, ry1);
        dt = null;
        rx0 = ry0 = Infinity;
        rx1 = ry1 = -Infinity;
      };
      while (c.drawCursor < c.segs.length) {
        const seg = c.segs[c.drawCursor];
        if (seg.page !== page) {
          end();
          page = seg.page;
          dt = scene.textures.get(c.pages[page]) as Phaser.Textures.DynamicTexture;
          dt.beginDraw();
        }
        const offx = seg.ax - seg.x0;
        const offy = seg.ay - seg.y0;
        for (const op of seg.ops) dt!.batchDraw(op.key, op.x + offx, op.y + offy);
        rx0 = Math.min(rx0, seg.ax);
        ry0 = Math.min(ry0, seg.ay);
        rx1 = Math.max(rx1, seg.ax + (seg.x1 - seg.x0));
        ry1 = Math.max(ry1, seg.ay + (seg.y1 - seg.y0));
        this.win.ops += seg.ops.length;
        c.drawCursor++;
        if (performance.now() >= deadline) break;
      }
      end();
      c.bakeMs += performance.now() - t0;
      if (c.drawCursor < c.segs.length) return;
      // Drawn whole: the band images stand, the old generation and the cells'
      // live images go.
      for (let s = 0; s < c.segs.length; s++) {
        const seg = c.segs[s];
        const im = scene.add.image(seg.x0, seg.y0, c.pages[seg.page], `s${s}`).setOrigin(0, 0).setDepth(seg.depth);
        (im as unknown as { bakeChunk: number }).bakeChunk = c.key;
        c.images.push(im);
      }
      const old = (c as unknown as { old?: { images: Img[]; pages: string[] } }).old;
      if (old) {
        for (const im of old.images) im.destroy();
        for (const k of old.pages) if (scene.textures.exists(k)) scene.textures.remove(k);
        (c as unknown as { old?: unknown }).old = undefined;
      }
      c.state = "baked";
      c.stale = false;
      c.bakedLive = c.liveCells;
      c.liveCells = new Set();
      c.retryMs = BAKE_RETRY_MS;
      c.retryAt = performance.now() + c.retryMs;
      this.win.bakes++;
      if (c.ops.length > this.win.opsMax) this.win.opsMax = c.ops.length;
      c.ops = []; // the atlas holds them now
      c.segs = [];
      this.rebuildImages();
      host.onChunk(this.cellsOf(c, c.bakedLive), true);
    }
  }

  /** The walk found the chunk unbakeable now (masked) or ever (overflow). */
  private finishLive(c: Chunk, why: string, retry: boolean): void {
    const hadImages = c.images.length > 0;
    if (hadImages) this.drop(c, why);
    c.state = retry ? "waiting" : "live";
    c.why = why;
    c.retryAt = performance.now() + BAKE_RETRY_MS;
    c.ops = [];
    c.segs = [];
  }

  private cellsOf(c: Chunk, except?: Set<number>): number[] {
    const out: number[] = [];
    const W = this.host.worldW;
    for (let r = 0; r < BAKE_CHUNK; r++)
      for (let q = 0; q < BAKE_CHUNK; q++) {
        const col = c.cx * BAKE_CHUNK + q;
        const row = c.cy * BAKE_CHUNK + r;
        if (col >= W || row >= this.host.worldH) continue;
        const k = row * W + col;
        if (except?.has(k)) continue;
        out.push(k);
      }
    return out;
  }

  /** A baked chunk goes live: its images and atlases are released, the scene
   *  told to re-walk its cells. */
  private drop(c: Chunk, why: string): void {
    const wasBaked = c.state === "baked";
    for (const im of c.images) im.destroy();
    c.images = [];
    const scene = this.host.scene;
    for (const key of c.pages) if (scene.textures.exists(key)) scene.textures.remove(key);
    const old = (c as unknown as { old?: { images: Img[]; pages: string[] } }).old;
    if (old) {
      for (const im of old.images) im.destroy();
      for (const k of old.pages) if (scene.textures.exists(k)) scene.textures.remove(k);
      (c as unknown as { old?: unknown }).old = undefined;
    }
    c.pages = [];
    c.segs = [];
    c.ops = [];
    c.bakedLive = new Set();
    c.sig = 0;
    c.stale = false;
    c.retryMs = BAKE_RETRY_MS;
    c.state = "live";
    c.why = why;
    this.rebuildImages();
    if (wasBaked) this.host.onChunk(this.cellsOf(c), false);
  }

  private evict(): void {
    let resident = 0;
    const far: Chunk[] = [];
    for (const c of this.chunks.values()) {
      if (c.pages.length) resident += c.pages.length;
      if (!this.wanted.has(c.key)) far.push(c);
    }
    if (resident <= BAKE_MAX_ATLASES) {
      // Unwanted chunks with no atlas are just forgotten.
      for (const c of far) if (!c.pages.length && c.state !== "baked") this.chunks.delete(c.key);
      return;
    }
    far.sort((a, b) => a.wantedAt - b.wantedAt);
    for (const c of far) {
      if (resident <= BAKE_MAX_ATLASES) break;
      resident -= c.pages.length;
      this.drop(c, "evicted");
      this.chunks.delete(c.key);
      this.win.evicted++;
    }
  }

  private rebuildImages(): void {
    const out: Img[] = [];
    for (const c of this.chunks.values()) for (const im of c.images) if (im.scene) out.push(im);
    this.images = out;
  }

  /** Everything goes (scene shutdown, world change). */
  destroy(): void {
    for (const c of [...this.chunks.values()]) this.drop(c, "destroyed");
    this.chunks.clear();
    this.wanted.clear();
    this.images = [];
  }

  /** The beacon's row; resets the window's counters. */
  take(): BakeRow {
    let baked = 0, live = 0, waiting = 0, atlases = 0, liveCells = 0;
    for (const c of this.chunks.values()) {
      if (c.state === "baked") {
        baked++;
        liveCells += c.bakedLive.size;
      } else if (c.state === "waiting") waiting++;
      else live++;
      atlases += c.pages.length;
    }
    const w = this.win;
    const row: BakeRow = {
      on: this.enabled ? 1 : 0, chunks: this.chunks.size, baked, live, waiting, liveCells, images: this.images.length, atlases,
      ms: +w.ms.toFixed(1), peakMs: +w.peak.toFixed(2), bakes: w.bakes, evicted: w.evicted, dirtied: w.dirtied, ops: w.ops, opsMax: w.opsMax, unbakeable: w.unbakeable,
    };
    this.win = { ms: 0, peak: 0, bakes: 0, evicted: 0, dirtied: 0, ops: 0, opsMax: 0, unbakeable: 0 };
    return row;
  }

  /** For probes: the chunks' states. */
  states(): { cx: number; cy: number; state: string; why: string; images: number; pages: number; size: number; liveCells: number; stale: boolean; bakeMs: number; dist: number }[] {
    return [...this.chunks.values()].map((c) => ({ cx: c.cx, cy: c.cy, state: c.state, why: c.why, images: c.images.length, pages: c.pages.length, size: c.pageSize, liveCells: c.state === "baked" ? c.bakedLive.size : c.liveCells.size, stale: c.stale, bakeMs: +c.bakeMs.toFixed(1), dist: +c.dist.toFixed(1) }));
  }
}

/** End a DynamicTexture bracket with a blit scissored to the painted rect —
 *  the ground's bracket-tax fix (groundEndDraw), for the atlas: without it
 *  every slice copies the whole 1024x1024 capture (1 Mpx) into the atlas. On
 *  a non-WebGL renderer or an empty rect it is the stock endDraw. */
export function endDrawScissored(scene: Phaser.Scene, dt: Phaser.Textures.DynamicTexture, x0: number, y0: number, x1: number, y1: number): void {
  const renderer = scene.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer & { endCapture(): Phaser.Renderer.WebGL.RenderTarget; resetScissor(): void; resetViewport(): void };
  const target = dt.renderTarget;
  const ok = !!target && scene.game.renderer.type === 2 /* Phaser.WEBGL */ && Number.isFinite(x0) && x1 > x0 && y1 > y0;
  if (!ok) {
    dt.endDraw();
    return;
  }
  const gl = renderer.gl;
  const capture = renderer.endCapture();
  const sx0 = Math.max(0, Math.floor(x0));
  const sy0 = Math.max(0, Math.floor(y0));
  const sx1 = Math.min(dt.width, Math.ceil(x1));
  const sy1 = Math.min(dt.height, Math.ceil(y1));
  if (sx1 > sx0 && sy1 > sy0) {
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(sx0, sy0, sx1 - sx0, sy1 - sy0);
    const util = renderer.pipelines.setUtility();
    util.blitFrame(capture, target!, 1, false, false, false, dt.isSpriteTexture);
  }
  renderer.resetScissor();
  renderer.resetViewport();
  (dt as unknown as { dirty: boolean; isDrawing: boolean }).dirty = true;
  (dt as unknown as { dirty: boolean; isDrawing: boolean }).isDrawing = false;
}

/* ---------------------------------------------------------------- parity --- */

export interface ParityResult {
  ok: boolean;
  error?: string;
  w: number;
  h: number;
  /** Texels that differ, and the largest channel delta among them. */
  diff: number;
  maxDelta: number;
  ops: number;
  images: number;
  chunks: number;
  /** PNG data URLs (the ops drawn directly, the bands, the diff) when asked. */
  pngOps?: string;
  pngBands?: string;
  pngDiff?: string;
}

/** THE PARITY: the baked chunks' ops drawn DIRECTLY in the live path's order
 *  against their band images, both into a view-sized texture, compared texel
 *  by texel with gl.readPixels. The two must be equal: the bake changes how
 *  many quads the terrain is, never a texel (`verify-bake.mjs`). The view is
 *  in world px (the camera's worldView); the compositing is the same
 *  premultiplied "over" the frame renders with. */
export function bakeParity(
  bake: TerrainBake,
  host: BakeHost,
  view: { x: number; y: number; width: number; height: number },
  png = false,
): ParityResult {
  const scene = host.scene;
  const out: ParityResult = { ok: false, w: 0, h: 0, diff: 0, maxDelta: 0, ops: 0, images: 0, chunks: 0 };
  if (scene.game.renderer.type !== 2) return { ...out, error: "not webgl" };
  const vx = Math.floor(view.x);
  const vy = Math.floor(view.y);
  const W = Math.min(2048, Math.ceil(view.width) + 2);
  const H = Math.min(2048, Math.ceil(view.height) + 2);
  if (W < 2 || H < 2) return { ...out, error: "empty view" };
  out.w = W;
  out.h = H;
  // The baked chunks whose band images touch the view, and their cells' ops.
  const bakedImgs: Img[] = [];
  const seen = new Set<number>();
  for (const im of bake.images) {
    if (!im.scene || !im.frame) continue; // a destroyed image (a chunk dropped between two frames)
    if (im.x + im.displayWidth < vx || im.x > vx + W || im.y + im.displayHeight < vy || im.y > vy + H) continue;
    bakedImgs.push(im);
  }
  const ops: BakeOp[] = [];
  const cells: number[] = [];
  for (const im of bakedImgs) {
    const st = (im as unknown as { bakeChunk?: number }).bakeChunk;
    if (st === undefined || seen.has(st)) continue;
    seen.add(st);
    const cx = st % 4096;
    const cy = (st - cx) / 4096;
    for (let r = 0; r < BAKE_CHUNK; r++)
      for (let q = 0; q < BAKE_CHUNK; q++) {
        const col = cx * BAKE_CHUNK + q;
        const row = cy * BAKE_CHUNK + r;
        if (col >= host.worldW || row >= host.worldH) continue;
        cells.push(row * host.worldW + col);
      }
  }
  out.chunks = seen.size;
  out.images = bakedImgs.length;
  for (const k of cells) {
    const col = k % host.worldW;
    const row = (k - col) / host.worldW;
    // A cell the chunk left live (its art was streaming at bake time) is a
    // sprite in both worlds: not part of what the bands must equal.
    if (!bake.owns(col, row)) continue;
    const u = col - row;
    const v = col + row;
    let i = 0;
    host.walkCell(col, row, {
      op: (key, x, y, role) => {
        const sz = host.sizeOf(key);
        if (sz) ops.push({ key, x: Math.floor(x), y: Math.floor(y), v, u, i: i++, w: sz.w, h: sz.h, role });
      },
      incomplete: () => {},
    });
  }
  out.ops = ops.length;
  // The live path's depths: base + (slot(u) + i) * eps, drawn low to high.
  ops.sort((a, b) => host.baseDepth(a.v) + (slotOf(a.u) + a.i) * host.eps - (host.baseDepth(b.v) + (slotOf(b.u) + b.i) * host.eps) || a.u - b.u || a.i - b.i);
  bakedImgs.sort((a, b) => a.depth - b.depth);
  const mk = (key: string) => {
    if (scene.textures.exists(key)) scene.textures.remove(key);
    const dt = scene.textures.addDynamicTexture(key, W, H);
    dt?.setFilter(1);
    return dt;
  };
  const A = mk("bake:parity:ops");
  const B = mk("bake:parity:bands");
  if (!A || !B) return { ...out, error: "no scratch texture" };
  // Phaser may widen the texture (an odd 417 became 418): the texels decide.
  const W2 = A.width;
  const H2 = A.height;
  out.w = W2;
  out.h = H2;
  try {
    A.clear();
    A.beginDraw();
    for (const op of ops) A.batchDraw(op.key, op.x - vx, op.y - vy);
    A.endDraw();
    B.clear();
    B.beginDraw();
    for (const im of bakedImgs) B.batchDraw(im.frame, im.x - vx, im.y - vy);
    B.endDraw();
    const pa = readTexels(scene, A);
    const pb = readTexels(scene, B);
    if (!pa || !pb) return { ...out, error: "readback failed" };
    if (pa.length !== W2 * H2 * 4 || pb.length !== pa.length)
      return { ...out, error: `readback ${pa.length}/${pb.length} bytes for ${W2}x${H2} (textures ${A.width}x${A.height}, ${B.width}x${B.height})` };
    let diff = 0;
    let maxDelta = 0;
    const d = png ? new Uint8ClampedArray(W2 * H2 * 4) : null;
    for (let p = 0; p < W2 * H2; p++) {
      const o = p * 4;
      const dd = Math.max(Math.abs(pa[o] - pb[o]), Math.abs(pa[o + 1] - pb[o + 1]), Math.abs(pa[o + 2] - pb[o + 2]), Math.abs(pa[o + 3] - pb[o + 3]));
      if (dd > 0) {
        diff++;
        if (dd > maxDelta) maxDelta = dd;
        if (d) {
          d[o] = 255;
          d[o + 1] = 0;
          d[o + 2] = 255;
          d[o + 3] = 255;
        }
      } else if (d) {
        // The agreeing texel, dimmed, so the diff reads in context.
        d[o] = pa[o] >> 2;
        d[o + 1] = pa[o + 1] >> 2;
        d[o + 2] = pa[o + 2] >> 2;
        d[o + 3] = 255;
      }
    }
    out.diff = diff;
    out.maxDelta = maxDelta;
    out.ok = diff === 0;
    if (png) {
      out.pngOps = texelsToPng(pa, W2, H2);
      out.pngBands = texelsToPng(pb, W2, H2);
      out.pngDiff = texelsToPng(d!, W2, H2);
    }
  } finally {
    scene.textures.remove("bake:parity:ops");
    scene.textures.remove("bake:parity:bands");
  }
  return out;
}

/** A DynamicTexture's texels, top row first (gl.readPixels is bottom-up). */
function readTexels(scene: Phaser.Scene, dt: Phaser.Textures.DynamicTexture): Uint8ClampedArray | null {
  const r = scene.game.renderer as unknown as {
    gl?: WebGLRenderingContext;
    pushFramebuffer?: (fb: unknown, u?: boolean, s?: boolean) => void;
    popFramebuffer?: () => void;
  };
  const fb = (dt as unknown as { renderTarget?: { framebuffer?: unknown } }).renderTarget?.framebuffer;
  if (!r.gl || !fb || !r.pushFramebuffer || !r.popFramebuffer) return null;
  const gl = r.gl;
  const W = dt.width;
  const H = dt.height;
  const px = new Uint8Array(W * H * 4);
  try {
    r.pushFramebuffer(fb, false, false);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    r.popFramebuffer();
  } catch {
    try {
      r.popFramebuffer();
    } catch {
      /* already popped */
    }
    return null;
  }
  const out = new Uint8ClampedArray(W * H * 4);
  const rowBytes = W * 4;
  for (let y = 0; y < H; y++) out.set(px.subarray((H - 1 - y) * rowBytes, (H - y) * rowBytes), y * rowBytes);
  return out;
}

function texelsToPng(px: Uint8ClampedArray, W: number, H: number): string {
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  if (!ctx) return "";
  ctx.putImageData(new ImageData(px as unknown as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0);
  return cv.toDataURL("image/png");
}
