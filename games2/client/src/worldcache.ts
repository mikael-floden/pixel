/* CACHE WORLD RENDERING — THE PHONE KEEPS THE WORLD IT HAS DRAWN
 * (maintainer 2026-09-26: "Why can't the player maintain a world image cache
 * it draws on its own?"; his choice for the Settings->Dev button "Cache world
 * rendering": the phone keeps what it drew, and on disk too; his rule for the
 * disk: "only if it's faster to read the cache from disk VS redrawing the
 * image"). OFF BY DEFAULT: nothing here runs until the button is on, and off
 * is today's code path exactly.
 *
 * WHAT A TILE IS. The world is cut into TILES of WC_TILE x WC_TILE cells (8,
 * the terrain bake's chunk: its cliff layers fit a 1024^2 page, 16 did not).
 * A tile's PICTURE is the ground texture's texels whose level-0 cell (the cell
 * under the texel's CENTRE, at level 0) is one of the tile's — the tiles
 * partition the plane, so every texel belongs to exactly one picture: a
 * 512x224 box of which the diamond is the tile's (on his phone at rest the
 * view is 360x495 world px: a tile is ~1.4 views wide, half a view tall).
 * What a picture holds is whatever the paint left there — the tile's own
 * ground, and the tall columns in FRONT of it rising over it.
 *
 * WHEN A PICTURE IS TAKEN. Only when every texel of it is final: the whole box
 * inside the ground texture, and no cell whose art can reach the box owed
 * anything (art still loading, a composition deferred, a slice not painted,
 * an indoor cut). The scene answers that (`WcHost.final`); this module never
 * guesses. Taken on the GPU — the box copied out of the ground texture into a
 * slot of a pooled atlas page and the texels outside the diamond erased —
 * never read back to the CPU.
 *
 * WHEN A PICTURE IS USED. A paint of the ground skips every cell whose tile is
 * cached AND whose every tile its art can reach is cached too (`groundSkips`,
 * `cellReach`: the cell's own column up to its tile's highest storey, grown by
 * a tile each way — the band pass's own bound), then draws each cached picture
 * that meets its rect LAST, over its diamond: a live neighbour's spill into
 * the tile is covered by the texels the picture took, and a skipped cell's
 * texels come from the picture. The ground texture is opaque (a whole-texture
 * fill first), so a picture's diamond replaces exactly and its clear corners
 * leave the rest alone. Identical to painting the cells, texel for texel — the
 * render A/B gate holds that.
 *
 * WHAT MAKES A PICTURE WRONG, and each one drops it: an EDIT (the tiles its
 * resolver region and fade reach can change, and every tile those reach —
 * `dirtyEdit`), a DIAL (seam, transitions, fade, detail, slope: `flush`), a
 * lost GL CONTEXT (`contextLost`), INDOORS (the cut rewrites columns:
 * `suspend`, used and taken again outside). A VIEW TURN draws another grid:
 * pictures are kept per orientation and only the current one is used.
 *
 * WHAT IT COSTS AND HOLDS. WC_CAP_BYTES (96 MB) of pages — 8 pictures to a
 * 1024x1024 page, 192 pictures, ~12,000 cells, ~60 of his views; beyond it
 * the pictures farthest from the ground texture go. One page allocated a
 * frame at most, WC_TAKES_PER_FRAME pictures taken a frame at most. */

/** The Settings->Dev switch "Cache world rendering" (`ml-worldcache`, "1" on).
 *  Off by default; a page without storage reads as off. No URL parameter:
 *  his game is installed on his home screen. */
const SWITCH = "ml-worldcache";
export function wcSwitchOn(): boolean {
  try {
    return (globalThis as { localStorage?: { getItem(k: string): string | null } }).localStorage?.getItem(SWITCH) === "1";
  } catch {
    return false;
  }
}
export function setWcSwitch(on: boolean): void {
  try {
    (globalThis as { localStorage?: { setItem(k: string, v: string): void } }).localStorage?.setItem(SWITCH, on ? "1" : "0");
  } catch {
    /* no storage: the switch lasts this page */
  }
}
/** A page's texture key. */
export const wcPageKey = (page: number): string => `wc:page:${page}`;

/** Cells a tile side: the terrain bake's chunk. */
export const WC_TILE = 8;
/** Bytes of pages (RGBA) the cache may hold. */
export const WC_CAP_BYTES = 96 * 1024 * 1024;
/** A picture this far outside the ground texture is kept before the cap. */
export const WC_KEEP_PX = 512;
/** Pictures taken a frame at most (each one copy and one erase on the GPU). */
export const WC_TAKES_PER_FRAME = 1;
/** The atlas page: 2 x 4 slots of a 512x224 box. */
export const WC_PAGE = 1024;
/** Candidates asked `final` a frame at most, and the frames a refused one
 *  waits before it is asked again — the ask walks the owed ledgers, and while
 *  art streams nearly every candidate is refused. */
export const WC_FINAL_ASKS = 4;
export const WC_REFUSED_WAIT = 15;
/** A resolver region (tiles3 `regionAt`): an edit re-resolves its own 24-cell
 *  region; the fade reads up to its reach (his dial, 4) and the boundary rules
 *  two, so an edit re-resolves this many cells each way beyond itself. */
const EDIT_REGION = 24;
const EDIT_NEAR = 6;

/** THE COLUMN BOUND the tight band pass trusts (drawTiles3Ground `reaches`,
 *  verified texel-identical by verify-groundbracket): a cell's art lies in
 *  [columnX, columnX + tile] x [columnY(top) - topY - lh, columnY(0) + tile +
 *  lh], grown by a tile each way (an op is at most a tile). On the level-0
 *  lattice columnX = ox + (c - r - 1)·dx and columnY(s) = oy - topY + (c + r)·dy
 *  - s·pitch (tiles3 `columnX`/`columnY`). */
export interface WcColumn {
  tile: number;
  topY: number;
  lh: number;
  pitch: number;
}

export interface WcRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The level-0 lattice in world px: cell (c, r)'s top vertex is
 *  (ox + (c - r)·dx, oy + (c + r)·dy) — tiles3's frame (`f.ox = iso.ox + DX`,
 *  `f.oy = iso.oy + TOP_Y`). */
export interface WcFrame {
  ox: number;
  oy: number;
  dx: number;
  dy: number;
}

/** One number per tile per orientation (rot 0..3; tiles within +-2^20). */
export const tileKeyOf = (rot: number, tx: number, ty: number): number => (rot * 2048 + (ty + 1024)) * 2048 + (tx + 1024);

/** A tile's level-0 diamond box — its picture's rectangle, in world px. */
export function tileBoxOf(tx: number, ty: number, f: WcFrame): WcRect {
  const n = WC_TILE;
  const c0 = tx * n;
  const r0 = ty * n;
  return {
    x0: Math.floor(f.ox + (c0 - (r0 + n)) * f.dx),
    y0: Math.floor(f.oy + (c0 + r0) * f.dy),
    x1: Math.ceil(f.ox + (c0 + n - r0) * f.dx),
    y1: Math.ceil(f.oy + (c0 + r0 + 2 * n) * f.dy),
  };
}

/** The level-0 cell under a world point: the lattice inverted, floored. */
export function cellUnder(x: number, y: number, f: WcFrame): [number, number] {
  const a = (x - f.ox) / f.dx;
  const b = (y - f.oy) / f.dy;
  return [Math.floor((a + b) / 2), Math.floor((b - a) / 2)];
}

/** The tile range whose boxes can meet a world rectangle: the cells under its
 *  corners, a tile of margin each way. */
export function tileRangeOfRect(r: WcRect, f: WcFrame): [number, number, number, number] {
  const a0 = (r.x0 - f.ox) / f.dx;
  const a1 = (r.x1 - f.ox) / f.dx;
  const b0 = (r.y0 - f.oy) / f.dy;
  const b1 = (r.y1 - f.oy) / f.dy;
  const n = WC_TILE;
  return [Math.floor((a0 + b0) / 2 / n) - 1, Math.floor((a1 + b1) / 2 / n) + 1, Math.floor((b0 - a1) / 2 / n) - 1, Math.floor((b1 - a0) / 2 / n) + 1];
}

/** WHICH TEXELS OF A TILE'S BOX ARE THE TILE'S: 1 where the level-0 cell under
 *  the texel's centre is one of its cells. The box of every tile has the same
 *  mask when the frame's origin is whole; the scene erases where this is 0. */
export function tileMask(tx: number, ty: number, f: WcFrame): { w: number; h: number; mask: Uint8Array } {
  const b = tileBoxOf(tx, ty, f);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const mask = new Uint8Array(w * h);
  const c0 = tx * WC_TILE;
  const r0 = ty * WC_TILE;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [c, r] = cellUnder(b.x0 + x + 0.5, b.y0 + y + 0.5, f);
      if (c >= c0 && c < c0 + WC_TILE && r >= r0 && r < r0 + WC_TILE) mask[y * w + x] = 1;
    }
  return { w, h, mask };
}

/** THE TILES A CELL'S ART CAN REACH, as (dtx, dty) offsets from its own
 *  tile, flat: every tile whose diamond meets the cell's grown column
 *  (WcColumn) with its top at storey `top`. It depends only on the cell's
 *  place (i, j) in its tile and the storey — the lattice repeats every WC_TILE
 *  cells — so a cache computes it once per (place, storey).
 *
 *  EXACT BY SEPARATING AXES. In lattice units (a = (x - ox)/dx, b = (y -
 *  oy)/dy) the grown column is an axis-aligned rectangle, and tile (u, v) is
 *  the texels whose level-0 cell (`cellUnder`) is one of its 64: a+b in [16u,
 *  16u + 16), b-a in [16v, 16v + 16) — a square turned 45 degrees. Two convex
 *  polygons meet unless one of their four edge normals separates them;
 *  touching counts as meeting, so the list can only be too long, never short. */
export function cellReach(i: number, j: number, top: number, f: WcFrame, col: WcColumn): Int8Array {
  const n = WC_TILE;
  const s = 2 * n;
  // the grown column, relative to the tile's first cell
  const a0 = i - j - 1 - col.tile / f.dx;
  const a1 = i - j - 1 + (2 * col.tile) / f.dx;
  const b0 = i + j + (-2 * col.topY - top * col.pitch - col.lh - col.tile) / f.dy;
  const b1 = i + j + (-col.topY + 2 * col.tile + col.lh) / f.dy;
  const out: number[] = [];
  for (let u = Math.floor((a0 + b0) / s) - 1; u <= Math.ceil((a1 + b1) / s) + 1; u++)
    for (let v = Math.floor((b0 - a1) / s) - 1; v <= Math.ceil((b1 - a0) / s) + 1; v++) {
      if (s * u > a1 + b1 || s * u + s < a0 + b0) continue; // the a+b normal
      if (s * v > b1 - a0 || s * v + s < b0 - a1) continue; // the b-a normal
      if (n * (u - v) - n > a1 || n * (u - v) + n < a0) continue; // the a normal
      if (n * (u + v) > b1 || n * (u + v) + 2 * n < b0) continue; // the b normal
      out.push(u, v);
    }
  return Int8Array.from(out);
}

/** The tiles a cell edit can change: its resolver region and the
 *  neighbourhood the boundary and fade rules read — as a tile range. */
export function editTiles(col: number, row: number): [number, number, number, number] {
  const rx0 = Math.floor(col / EDIT_REGION) * EDIT_REGION;
  const ry0 = Math.floor(row / EDIT_REGION) * EDIT_REGION;
  const c0 = Math.min(rx0, col - EDIT_NEAR);
  const c1 = Math.max(rx0 + EDIT_REGION - 1, col + EDIT_NEAR);
  const r0 = Math.min(ry0, row - EDIT_NEAR);
  const r1 = Math.max(ry0 + EDIT_REGION - 1, row + EDIT_NEAR);
  const n = WC_TILE;
  return [Math.floor(c0 / n), Math.floor(c1 / n), Math.floor(r0 / n), Math.floor(r1 / n)];
}

const meets = (a: WcRect, b: WcRect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inside = (a: WcRect, b: WcRect): boolean => a.x0 >= b.x0 && a.y0 >= b.y0 && a.x1 <= b.x1 && a.y1 <= b.y1;
/** How far apart two rectangles are (0 when they meet), along the worse axis. */
const gapOf = (a: WcRect, b: WcRect): number => Math.max(0, a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1);

/** A slot in a page: where a picture lives on the GPU. */
export interface WcSlot {
  page: number;
  x: number;
  y: number;
}

/** What the scene does for the cache (WorldScene). */
export interface WcHost {
  /** The level-0 lattice of the ground texture. */
  frame: WcFrame;
  /** The column bound a cell's art keeps to (see WcColumn). */
  column: WcColumn;
  /** The highest storey any cell of this tile draws to (its doc and resolved
   *  levels and its decks, plus one for a ramp's rise), asked at the take. */
  topOf(tx: number, ty: number): number;
  /** Every texel of this tile's box is final in the ground texture, whose world
   *  rectangle is `ground` (see the header). */
  final(tx: number, ty: number, box: WcRect): boolean;
  /** Allocate page `page` (WC_PAGE square). False: not now (one a frame). */
  addPage(page: number): boolean;
  /** Copy the box out of the ground texture into the slot and erase the texels
   *  outside the tile's diamond. False: it could not (the scene says why). */
  take(tx: number, ty: number, box: WcRect, slot: WcSlot): boolean;
  /** The slot's texels are free again (cleared before the next take). */
  release(slot: WcSlot): void;
  /** Let a page go (the cache is off, flushed or lost). */
  dropPage(page: number): void;
}

interface Tile {
  key: number;
  rot: number;
  tx: number;
  ty: number;
  box: WcRect;
  slot: WcSlot;
  used: number;
  /** The tile's highest storey, when taken (WcHost.topOf). */
  top: number;
}

export interface WcPicture {
  page: number;
  x: number;
  y: number;
  box: WcRect;
}

export class WorldCache {
  private tiles = new Map<number, Tile>();
  private pages: { slots: boolean[] }[] = [];
  private rot = 0;
  private suspended = false;
  private clock = 0;
  private ground: WcRect | null = null;
  /** cellReach per storey: 64 places each. */
  private reach = new Map<number, Int8Array[]>();
  /** A refused candidate's key -> the clock before which it is not asked. */
  private refused = new Map<number, number>();
  /** Slots per page and their positions. */
  private readonly slotW: number;
  private readonly slotH: number;
  private readonly perRow: number;
  private readonly perPage: number;
  readonly stats = { taken: 0, dropped: 0, drawn: 0, refusedFinal: 0, refusedTake: 0 };

  constructor(
    private readonly host: WcHost,
    private readonly capBytes = WC_CAP_BYTES,
  ) {
    const b = tileBoxOf(0, 0, host.frame);
    this.slotW = b.x1 - b.x0;
    this.slotH = b.y1 - b.y0;
    this.perRow = Math.max(1, Math.floor(WC_PAGE / this.slotW));
    this.perPage = this.perRow * Math.max(1, Math.floor(WC_PAGE / this.slotH));
  }

  get size(): number {
    return this.tiles.size;
  }

  /** Bytes of pages held (RGBA). */
  get bytes(): number {
    return this.pages.length * WC_PAGE * WC_PAGE * 4;
  }

  /** The reach offsets of place (i, j) at storey `top` (cellReach, memoised). */
  reachOf(i: number, j: number, top: number): Int8Array {
    let per = this.reach.get(top);
    if (!per) {
      per = [];
      for (let q = 0; q < WC_TILE * WC_TILE; q++) per.push(cellReach(q % WC_TILE, Math.floor(q / WC_TILE), top, this.host.frame, this.host.column));
      this.reach.set(top, per);
    }
    return per[j * WC_TILE + i];
  }

  /** The ground paint skips this cell: its tile is cached, and so is every
   *  tile its art can reach — its column up to the tile's highest storey. */
  groundSkips(col: number, row: number): boolean {
    if (this.suspended) return false;
    const tx = Math.floor(col / WC_TILE);
    const ty = Math.floor(row / WC_TILE);
    const t = this.tiles.get(tileKeyOf(this.rot, tx, ty));
    if (!t) return false;
    const off = this.reachOf(col - tx * WC_TILE, row - ty * WC_TILE, t.top);
    for (let k = 0; k < off.length; k += 2) if (!this.tiles.has(tileKeyOf(this.rot, tx + off[k], ty + off[k + 1]))) return false;
    return true;
  }

  /** The pictures a paint of this world rectangle draws LAST — every cached
   *  tile of the current orientation whose box meets it. */
  pictures(r: WcRect): WcPicture[] {
    const out: WcPicture[] = [];
    if (this.suspended) return out;
    const [tx0, tx1, ty0, ty1] = tileRangeOfRect(r, this.host.frame);
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.tiles.get(tileKeyOf(this.rot, tx, ty));
        if (!t || !meets(t.box, r)) continue;
        t.used = this.clock;
        out.push({ page: t.slot.page, x: t.slot.x, y: t.slot.y, box: t.box });
      }
    this.stats.drawn += out.length;
    return out;
  }

  /** Once a frame: the ground texture's world rectangle. Tiles wholly inside
   *  it whose texels are final are taken, WC_TAKES_PER_FRAME at most, nearest
   *  its centre first — WC_FINAL_ASKS asked at most, a refused one resting
   *  WC_REFUSED_WAIT frames; then the cap holds. */
  step(ground: WcRect): void {
    this.clock++;
    this.ground = ground;
    if (this.suspended) return;
    const f = this.host.frame;
    const [tx0, tx1, ty0, ty1] = tileRangeOfRect(ground, f);
    const mx = (ground.x0 + ground.x1) / 2;
    const my = (ground.y0 + ground.y1) / 2;
    const cand: { tx: number; ty: number; box: WcRect; d: number }[] = [];
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.tiles.get(tileKeyOf(this.rot, tx, ty));
        if (t) {
          t.used = this.clock; // in the ground texture: in use
          continue;
        }
        const box = tileBoxOf(tx, ty, f); // only the uncached allocate: this runs every frame
        if (!inside(box, ground)) continue;
        cand.push({ tx, ty, box, d: Math.hypot((box.x0 + box.x1) / 2 - mx, (box.y0 + box.y1) / 2 - my) });
      }
    cand.sort((a, b) => a.d - b.d);
    if (this.refused.size > 1024) this.refused.clear();
    let taken = 0;
    let asked = 0;
    for (const c of cand) {
      if (taken >= WC_TAKES_PER_FRAME || asked >= WC_FINAL_ASKS) break;
      const key = tileKeyOf(this.rot, c.tx, c.ty);
      if ((this.refused.get(key) ?? 0) > this.clock) continue;
      asked++;
      if (!this.host.final(c.tx, c.ty, c.box)) {
        this.stats.refusedFinal++;
        this.refused.set(key, this.clock + WC_REFUSED_WAIT);
        continue;
      }
      const slot = this.freeSlot();
      if (!slot) break; // no page this frame
      if (!this.host.take(c.tx, c.ty, c.box, slot)) {
        this.stats.refusedTake++;
        this.pages[slot.page].slots[this.slotIndex(slot)] = false;
        continue;
      }
      this.refused.delete(key);
      this.tiles.set(key, { key, rot: this.rot, tx: c.tx, ty: c.ty, box: c.box, slot, used: this.clock, top: this.host.topOf(c.tx, c.ty) });
      this.stats.taken++;
      taken++;
    }
    this.trim();
  }

  private slotIndex(s: WcSlot): number {
    return Math.floor(s.y / this.slotH) * this.perRow + Math.floor(s.x / this.slotW);
  }

  /** A free slot, marked used; a new page when every page is full and the cap
   *  allows one (the host may refuse: one allocation a frame). */
  private freeSlot(): WcSlot | null {
    for (let p = 0; p < this.pages.length; p++) {
      const slots = this.pages[p].slots;
      for (let i = 0; i < slots.length; i++)
        if (!slots[i]) {
          slots[i] = true;
          return { page: p, x: (i % this.perRow) * this.slotW, y: Math.floor(i / this.perRow) * this.slotH };
        }
    }
    if (this.bytes + WC_PAGE * WC_PAGE * 4 > this.capBytes) {
      // at the cap: the least recently used picture outside the keep margin gives its slot
      const victim = this.oldest();
      if (!victim) return null;
      this.drop(victim);
      return this.freeSlot();
    }
    const p = this.pages.length;
    if (!this.host.addPage(p)) return null;
    this.pages.push({ slots: new Array(this.perPage).fill(false) });
    return this.freeSlot();
  }

  /** The least recently used tile not in or near the ground texture. */
  private oldest(): Tile | null {
    let best: Tile | null = null;
    for (const t of this.tiles.values()) {
      if (t.rot === this.rot && this.ground && gapOf(t.box, this.ground) <= WC_KEEP_PX) continue;
      if (!best || t.used < best.used) best = t;
    }
    return best;
  }

  private drop(t: Tile): void {
    this.tiles.delete(t.key);
    this.pages[t.slot.page].slots[this.slotIndex(t.slot)] = false;
    this.host.release(t.slot);
    this.stats.dropped++;
  }

  /** Over the cap (a cap lowered, pages from before): the oldest go first. */
  private trim(): void {
    while (this.bytes > this.capBytes) {
      const p = this.pages.length - 1;
      for (const t of [...this.tiles.values()]) if (t.slot.page === p) this.drop(t);
      this.pages.pop();
      this.host.dropPage(p);
    }
  }

  /** A CELL EDIT: every tile it can change (`editTiles`) and every tile THEIR
   *  cells' art reaches up to storey `top` (the world's highest, so the old
   *  art and the new are both inside it) let their pictures go: they hold the
   *  old texels, and are taken again from the repainted ground once final.
   *  Tile numbers are the server grid's at rot 0; a turned view's tiles are
   *  dropped whole, since its grid maps the edit elsewhere. */
  dirtyEdit(col: number, row: number, top: number): number {
    const [tx0, tx1, ty0, ty1] = editTiles(col, row);
    const hit = new Set<number>();
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++)
        for (let q = 0; q < WC_TILE * WC_TILE; q++) {
          const off = this.reachOf(q % WC_TILE, Math.floor(q / WC_TILE), top);
          for (let k = 0; k < off.length; k += 2) hit.add(tileKeyOf(0, tx + off[k], ty + off[k + 1]));
        }
    let n = 0;
    for (const t of [...this.tiles.values()])
      if (t.rot !== 0 || hit.has(t.key)) {
        this.drop(t);
        n++;
      }
    return n;
  }

  /** A dial changed what the terrain draws: every picture goes. */
  flush(): void {
    for (const t of [...this.tiles.values()]) this.drop(t);
  }

  /** A LOST GL CONTEXT took every page's texels: every picture and page goes,
   *  and they are taken again from the repainted ground. Never a blank one. */
  contextLost(): void {
    this.tiles.clear();
    this.refused.clear();
    for (let p = this.pages.length - 1; p >= 0; p--) this.host.dropPage(p);
    this.pages = [];
  }

  /** The view turned: pictures of this orientation are used and taken now;
   *  the others wait for their turn (the cap still counts them). */
  setRot(rot: number): void {
    this.rot = ((rot % 4) + 4) % 4;
  }

  /** Indoors the cut rewrites columns: nothing is used or taken. */
  suspend(on: boolean): boolean {
    if (this.suspended === on) return false;
    this.suspended = on;
    return true;
  }

  /** The button went off: every picture and page goes. */
  destroy(): void {
    this.contextLost();
  }

  /** One picture of this orientation, a different one each call (the
   *  pages' check walks them all in turn), or null. */
  samplePicture(): WcPicture | null {
    let i = 0;
    let first: Tile | null = null;
    const want = this.sampleAt++;
    for (const t of this.tiles.values()) {
      if (t.rot !== this.rot) continue;
      if (!first) first = t;
      if (i++ === want % Math.max(1, this.tiles.size)) return { page: t.slot.page, x: t.slot.x, y: t.slot.y, box: t.box };
    }
    return first ? { page: first.slot.page, x: first.slot.x, y: first.slot.y, box: first.box } : null;
  }
  private sampleAt = 0;

  /** Pictures held (this orientation / all), pages, MB, and the counters. */
  take(): { tiles: number; here: number; pages: number; mb: number } & WorldCache["stats"] {
    let here = 0;
    for (const t of this.tiles.values()) if (t.rot === this.rot) here++;
    return { tiles: this.tiles.size, here, pages: this.pages.length, mb: +(this.bytes / 1048576).toFixed(1), ...this.stats };
  }
}
