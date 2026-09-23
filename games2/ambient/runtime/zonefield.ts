import { type AmbientZone, type AmbientZoneDoc, CELL_WU, resolveAmbientAt, unpackZoneTable, zoneHolds } from "@nangijala/shared";

/* THE ZONE FIELD — "is effect X on HERE", for any point an effect draws at,
 * with a soft edge (maintainer 2026-09-20: "It should not suddenly start to
 * snow. I should walk into an area/zone that is already snowing ... I can
 * stand outside a zone and see effects like a crab on the other side, but
 * not on this side ... It's ok to make the boundary softer (no hard
 * transitions)").
 *
 * WHAT WAS THERE BEFORE: the server rolls a set per zone (shared/ambientzones
 * .ts) and the scene resolves it at MY cell into `env.active` — one answer for
 * the whole screen. Only the weather rows and the episodes even read it; every
 * field feature (crabs, ants, spiders, gnats, moths, ...) ran wherever its own
 * world gate was met, zones or not, so maps2's shares for them changed nothing
 * on screen. A boundary needs a field: the same resolver, asked per CELL,
 * memoised, blurred a cell each way and read bilinearly, so a feature can ask
 * "how much is X on at this drawn point" and get 0 outside, 1 well inside, and
 * a ramp two cells wide across the line.
 *
 * THE SERVER'S ANSWER, NEVER A SECOND RULE: `resolveAmbientAt` from shared/
 * is the exact function the server rolls with and the scene resolves my cell
 * with; this only asks it more often. A cell's answer is cached until the
 * packed table changes (a zone re-rolled), which is the only time it can.
 *
 * ISO PIXELS IN, CELLS INSIDE: everything a feature holds is a DRAWN point
 * (the scene's iso plane), and the cell under a drawn point depends on the
 * terrain's height there — a summit six levels up is drawn ~100 px above its
 * own cell. So the mapping goes through the game's picker (`__ml.pickAt`,
 * injected as `pick`), memoised per 16x8 px bucket: a particle asks once per
 * bucket it crosses, not once per frame.
 *
 * NO ZONES, NO BOUNDARY: with no doc, or when the room's sky rules (a forced
 * set, or a table not yet received), every weight is 1 — today's behaviour
 * exactly, so a world without ambient.json changes nothing. */

export interface ZonePick {
  col: number;
  row: number;
  lvl: number;
  /** Position inside the cell, 0..1 along col and row. */
  fx: number;
  fy: number;
}

export interface ZoneSource {
  doc: AmbientZoneDoc | null;
  /** The world's table as the room sent it (shared packZoneTable form). */
  packed: string;
  /** The room's sky rules instead of the zones (forced, or zoneless). */
  roomSky: boolean;
}

/** Blur radius in CELLS around a cell: the boundary ramp is ~2·FEATHER+1
 *  cells wide. One cell each way reads as "softer, no hard transition"
 *  without smearing a zone's shape. */
export const FEATHER_CELLS = 1;
/** The picker memo's bucket, in iso px: half a cell's width and height. */
export const BUCKET_W = 16;
export const BUCKET_H = 7;
/** Buckets held before the picker memo is dropped whole (a walk across the
 *  world must not grow it without bound). */
export const BUCKET_CAP = 6000;
/** The coverage sampler's grid over the view. */
export const COVER_COLS = 8;
export const COVER_ROWS = 6;

export interface ZoneCoverage {
  /** Is the effect on anywhere in the view (max weight > 0)? */
  any: boolean;
  /** Mean weight over the samples — the share of the view it covers. */
  mean: number;
  max: number;
  n: number;
}

export class ZoneField {
  private doc: AmbientZoneDoc | null = null;
  private table = new Map<string, string>();
  private packed = "";
  private roomSky = true;
  private version = 0;
  /** Per cell: the resolved set, and the ids of the zones holding the cell —
   *  what a re-roll of one zone must drop, and only that. */
  private cells = new Map<number, { set: ReadonlySet<string>; zones: readonly string[] }>();
  /** Per effect, per blurred cell: the value, and the union of the zones its
   *  window read. NUMERIC KEYS (cellKey below): a string key was built and
   *  hashed on every lookup, and a tick makes ~13,000 of them. */
  private blur = new Map<string, Map<number, { v: number; zones: readonly string[] }>>();
  /* THE PICKER MEMO IN TWO GENERATIONS (games-perf 2026-09-23). It used to
   * be cleared WHOLE at the cap, and the mist raster alone holds 2,560
   * buckets: every few seconds of walking the next tick re-picked the whole
   * raster and re-resolved its cells in one frame. Now the young generation
   * rotates into the old one at half the cap and a hit in the old one is
   * promoted, so the working set stays hot and the total never exceeds the
   * cap. */
  private picks = new Map<number, ZonePick | null>();
  private picksOld = new Map<number, ZonePick | null>();
  /** Every zone's bounding box over its polygon, built once per doc: a cell
   *  tests the zones whose box holds it — one to three — instead of all of
   *  them (measured his run: ~96 zones, two polygon passes per cell miss, and
   *  the tick that walks the raster's leading edge was 15-55 ms). */
  private boxes: { z: AmbientZone; x0: number; y0: number; x1: number; y1: number }[] = [];
  /** The last raster before its fill passes: the mask is anchored to the world
   *  in whole sample steps, so the next tick's rect is this one shifted by
   *  whole samples — the overlap is copied and only the new edge is looked
   *  up (a still camera looks nothing up; a walking one ~40 samples a tick,
   *  not 2,560). */
  private rasterMemo: { name: string; cols: number; rows: number; stepX: number; stepY: number; x: number; y: number; version: number; raw: Uint8Array; known: Uint8Array } | null = null;
  private readonly feather: number;
  stats = { picks: 0, resolves: 0, refreshes: 0, pruned: 0 };

  constructor(
    private readonly source: () => ZoneSource | null,
    private readonly pick: (isoX: number, isoY: number) => ZonePick | null,
    feather = FEATHER_CELLS,
  ) {
    this.feather = Math.max(0, Math.floor(feather));
  }

  /** Re-read the source. Returns true when the answer changed (a new table,
   *  a doc landing, the room taking over) — the memos are dropped then. */
  refresh(): boolean {
    let s: ZoneSource | null = null;
    try { s = this.source(); } catch { s = null; }
    const doc = s?.doc ?? null;
    const packed = s?.packed ?? "";
    const roomSky = !s || !doc || s.roomSky || packed === "";
    if (doc === this.doc && packed === this.packed && roomSky === this.roomSky) return false;
    const next = unpackZoneTable(packed);
    if (doc === this.doc && roomSky === this.roomSky && this.doc) {
      /* ONE ZONE RE-ROLLED, NOT THE WORLD. With ~96 zones phased ten minutes
       * apart a window closes somewhere every ~6 s (measured: 8 refreshes in
       * 40 s), and dropping every memo each time would have the field
       * re-resolving the whole view for every re-roll anywhere on the map.
       * Only the cells a CHANGED zone holds are dropped. */
      const changed = new Set<string>();
      for (const [id, set] of next) if (this.table.get(id) !== set) changed.add(id);
      for (const id of this.table.keys()) if (!next.has(id)) changed.add(id);
      for (const [k, c] of this.cells) if (c.zones.some((z) => changed.has(z))) this.cells.delete(k);
      for (const m of this.blur.values()) for (const [k, b] of m) if (b.zones.some((z) => changed.has(z))) m.delete(k);
      this.stats.pruned += changed.size;
    } else {
      this.cells.clear();
      this.blur.clear();
    }
    if (doc !== this.doc) this.boxes = doc ? doc.zones.map((z) => zoneBox(z)) : [];
    this.doc = doc;
    this.packed = packed;
    this.table = next;
    this.roomSky = roomSky;
    this.version++;
    this.rasterMemo = null;
    this.stats.refreshes++;
    return true;
  }

  /** Zones decide (a doc is in and the table has been received); otherwise
   *  the room's sky rules and every weight reads 1. */
  get ruled(): boolean {
    return !this.roomSky && this.doc !== null;
  }

  /** The current table version — bumps whenever a memo was dropped. */
  get tableVersion(): number {
    return this.version;
  }

  /** The zone doc as read (null when none) and a zone's current packed set. */
  get zones(): AmbientZoneDoc | null {
    return this.doc;
  }
  setOf(zoneId: string): string {
    return this.table.get(zoneId) ?? "";
  }

  /** What is on at a cell — the server's own resolution, memoised. */
  activeAt(col: number, row: number, lvl: number): ReadonlySet<string> {
    return this.cell(col, row, lvl).set;
  }

  private cell(col: number, row: number, lvl: number): { set: ReadonlySet<string>; zones: readonly string[] } {
    if (!this.ruled || !this.doc) return NONE;
    const key = cellKey(col, row, lvl);
    const hit = this.cells.get(key);
    if (hit) return hit;
    this.stats.resolves++;
    /* THE ZONES THAT CAN HOLD THIS CELL, by box first, polygon once. The
     * server's rule then runs over exactly those (its own zoneHolds on one to
     * three zones is the second pass it always made — now over three, not
     * ninety-six), and its answer is unchanged: a zone outside its own box
     * never held the cell. */
    const cx = col + 0.5;
    const cy = row + 0.5;
    const holding: AmbientZone[] = [];
    for (const b of this.boxes) {
      if (cx < b.x0 || cx > b.x1 || cy < b.y0 || cy > b.y1) continue;
      if (zoneHolds(b.z, col, row, lvl)) holding.push(b.z);
    }
    const set: ReadonlySet<string> = holding.length
      ? new Set(resolveAmbientAt({ ...this.doc, zones: holding }, this.table, col, row, lvl))
      : EMPTY;
    const zones = holding.map((z) => z.id);
    const rec = { set, zones };
    this.cells.set(key, rec);
    return rec;
  }

  on(name: string, col: number, row: number, lvl: number): boolean {
    return this.activeAt(col, row, lvl).has(name);
  }

  /** The effect's presence blurred over (2·feather+1)² cells around this one,
   *  0..1 — the value the bilinear read below interpolates. The neighbours
   *  are asked at THIS cell's level: a boundary on a terrace stays on it. */
  blurred(name: string, col: number, row: number, lvl: number): number {
    return this.blurIn(this.blurMap(name), name, col, row, lvl);
  }

  private blurMap(name: string): Map<number, { v: number; zones: readonly string[] }> {
    let m = this.blur.get(name);
    if (!m) {
      m = new Map();
      this.blur.set(name, m);
    }
    return m;
  }

  private blurIn(m: Map<number, { v: number; zones: readonly string[] }>, name: string, col: number, row: number, lvl: number): number {
    const key = cellKey(col, row, lvl);
    const hit = m.get(key);
    if (hit !== undefined) return hit.v;
    const f = this.feather;
    let on = 0;
    let n = 0;
    const zones = new Set<string>();
    for (let dr = -f; dr <= f; dr++)
      for (let dc = -f; dc <= f; dc++) {
        n++;
        const c = this.cell(col + dc, row + dr, lvl);
        if (c.set.has(name)) on++;
        for (const z of c.zones) zones.add(z);
      }
    const v = on / n;
    m.set(key, { v, zones: [...zones] });
    return v;
  }

  /** The cell under a drawn point, through the picker memo. */
  cellAt(isoX: number, isoY: number): ZonePick | null {
    const key = (Math.floor(isoY / BUCKET_H) + KOFF) * KMUL + (Math.floor(isoX / BUCKET_W) + KOFF);
    let hit = this.picks.get(key);
    if (hit !== undefined) return hit;
    hit = this.picksOld.get(key);
    if (hit !== undefined) {
      this.remember(key, hit); // promoted: still in use, so it survives the next rotation
      return hit;
    }
    this.stats.picks++;
    let p: ZonePick | null = null;
    try { p = this.pick(isoX, isoY); } catch { p = null; }
    this.remember(key, p);
    return p;
  }

  /** Into the young generation; at half the cap the young becomes the old and
   *  the old is dropped, so the two together never exceed BUCKET_CAP. */
  private remember(key: number, p: ZonePick | null): void {
    this.picks.set(key, p);
    if (this.picks.size >= BUCKET_CAP / 2) {
      this.picksOld = this.picks;
      this.picks = new Map();
    }
  }

  /** HOW MUCH IS `name` ON AT THIS DRAWN POINT, 0..1. One where zones do not
   *  rule; zero where the picker cannot place the point; else the blurred
   *  presence read bilinearly between the four nearest cell centres. */
  weightAt(name: string, isoX: number, isoY: number): number {
    if (!this.ruled) return 1;
    const p = this.cellAt(isoX, isoY);
    if (!p) return 0;
    // bilinear between cell CENTRES: the point's offset from its cell's centre
    const u = p.fx - 0.5;
    const v = p.fy - 0.5;
    const c0 = u < 0 ? p.col - 1 : p.col;
    const r0 = v < 0 ? p.row - 1 : p.row;
    const t = u < 0 ? u + 1 : u;
    const s = v < 0 ? v + 1 : v;
    const m = this.blurMap(name);
    const top = this.blurIn(m, name, c0, r0, p.lvl) * (1 - t) + this.blurIn(m, name, c0 + 1, r0, p.lvl) * t;
    const bot = this.blurIn(m, name, c0, r0 + 1, p.lvl) * (1 - t) + this.blurIn(m, name, c0 + 1, r0 + 1, p.lvl) * t;
    return top * (1 - s) + bot * s;
  }

  /** The effect's presence over a view rectangle (iso px), sampled on a grid:
   *  `any` gates a feature on when its zone is anywhere on screen, `mean` is
   *  the share of the view it covers (what a sheet scales its count by). */
  coverage(name: string, view: { x: number; y: number; width: number; height: number }): ZoneCoverage {
    if (!this.ruled) return { any: true, mean: 1, max: 1, n: 0 };
    let sum = 0;
    let max = 0;
    let n = 0;
    for (let j = 0; j < COVER_ROWS; j++)
      for (let i = 0; i < COVER_COLS; i++) {
        const x = view.x + view.width * ((i + 0.5) / COVER_COLS);
        const y = view.y + view.height * ((j + 0.5) / COVER_ROWS);
        const w = this.weightAt(name, x, y);
        sum += w;
        if (w > max) max = w;
        n++;
      }
    return { any: max > 0.001, mean: n ? sum / n : 0, max, n };
  }

  /** THE FIELD OVER A RECTANGLE, AS BYTES: `cols` x `rows` samples at the
   *  centres of a grid over `rect` (iso px), row 0 at the top, 255 = fully
   *  on. A shader multiplies its effect by this (the mist banks, unit 2 of
   *  the boundaries), reading it bilinearly between samples, so the raster is
   *  coarse — half a cell per sample is more than the three-cell ramp needs.
   *  All 255 where zones do not rule. */
  raster(name: string, rect: { x: number; y: number; width: number; height: number }, cols: number, rows: number): Uint8Array {
    const out = new Uint8Array(cols * rows);
    if (!this.ruled) { out.fill(255); return out; }
    /* A SAMPLE THE PICKER CANNOT PLACE IS UNKNOWN, NOT ZERO. weightAt answers
     * 0 where no cell lies under the drawn point — right for a particle
     * asking "am I in the zone", a LIE in a raster: sky over a ridge, and the
     * cliff faces at a level boundary, punched 0-holes straight through the
     * middle of a zone. Measured deep inside the south-eastern green, holes
     * pulled the fade down to 0.892 where it should be whole. So they are
     * filled from their known neighbours instead (four passes, which closes
     * anything up to ~2 cells across); whatever is still unknown stays 0, and
     * the mist pass never reads it — it paints only where its march FOUND a
     * surface, which is the same test that failed the pick. */
    const known = new Uint8Array(cols * rows);
    /* THE OVERLAP WITH THE LAST RASTER IS COPIED. Sample i of this rect is
     * sample i+di of the last one when the rect moved by whole steps (the
     * mount snaps it so), so only the samples that entered the rect are
     * looked up; the fill passes below run on the whole grid either way and
     * give the bytes a full computation would. */
    const stepX = rect.width / cols;
    const stepY = rect.height / rows;
    const m = this.rasterMemo;
    let di = 0;
    let dj = 0;
    let reuse = false;
    if (m && m.name === name && m.cols === cols && m.rows === rows && m.version === this.version && Math.abs(m.stepX - stepX) < 1e-9 && Math.abs(m.stepY - stepY) < 1e-9) {
      di = Math.round((rect.x - m.x) / stepX);
      dj = Math.round((rect.y - m.y) / stepY);
      reuse =
        Math.abs(rect.x - (m.x + di * stepX)) < 1e-6 * stepX &&
        Math.abs(rect.y - (m.y + dj * stepY)) < 1e-6 * stepY &&
        Math.abs(di) < cols &&
        Math.abs(dj) < rows;
    }
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (reuse) {
          const si = i + di;
          const sj = j + dj;
          if (si >= 0 && si < cols && sj >= 0 && sj < rows) {
            const sk = sj * cols + si;
            out[k] = m!.raw[sk];
            known[k] = m!.known[sk];
            continue;
          }
        }
        const x = rect.x + rect.width * ((i + 0.5) / cols);
        const y = rect.y + rect.height * ((j + 0.5) / rows);
        if (this.cellAt(x, y)) { out[k] = Math.round(255 * this.weightAt(name, x, y)); known[k] = 1; }
      }
    this.rasterMemo = { name, cols, rows, stepX, stepY, x: rect.x, y: rect.y, version: this.version, raw: out.slice(), known: known.slice() };
    for (let pass = 0; pass < 4; pass++) {
      let filled = 0;
      const was = known.slice();
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i;
          if (was[k]) continue;
          let sum = 0, n = 0;
          if (i > 0 && was[k - 1]) { sum += out[k - 1]; n++; }
          if (i < cols - 1 && was[k + 1]) { sum += out[k + 1]; n++; }
          if (j > 0 && was[k - cols]) { sum += out[k - cols]; n++; }
          if (j < rows - 1 && was[k + cols]) { sum += out[k + cols]; n++; }
          if (n) { out[k] = Math.round(sum / n); known[k] = 1; filled++; }
        }
      if (!filled) break;
    }
    return out;
  }

  debug() {
    return {
      ruled: this.ruled,
      zones: this.doc?.zones.length ?? 0,
      table: this.table.size,
      version: this.version,
      cells: this.cells.size,
      blur: [...this.blur.values()].reduce((n, m) => n + m.size, 0),
      buckets: this.picks.size + this.picksOld.size,
      feather: this.feather,
      ...this.stats,
    };
  }
}

const EMPTY: ReadonlySet<string> = new Set();
const NONE = { set: EMPTY, zones: [] as readonly string[] };

/** A cell, or a picker bucket, as ONE NUMBER: col and row within ±2^20 (a
 *  world is 394 cells; a bucket 16 px), level within ±512 — under 2^53, so
 *  exact. A Map keyed by numbers neither allocates nor hashes a string per
 *  lookup, and a tick makes ~13,000 lookups. */
const KMUL = 1 << 21;
const KOFF = 1 << 20;
const cellKey = (col: number, row: number, lvl: number): number => ((lvl + 512) * KMUL + (row + KOFF)) * KMUL + (col + KOFF);

/** A zone's bounding box over its polygon's vertices, in cell units. */
function zoneBox(z: AmbientZone): { z: AmbientZone; x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of z.area) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { z, x0, y0, x1, y1 };
}

/** The picker probe as a `pick`: `__ml.pickAt` answers in WORLD UNITS (32 to
 *  the cell) and the cell's level; the fractional part is the position inside
 *  the cell the bilinear read needs. */
export function pickFromProbe(): (isoX: number, isoY: number) => ZonePick | null {
  return (isoX, isoY) => {
    const ml = (globalThis as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const f = ml?.pickAt as undefined | ((x: number, y: number) => { x: number; y: number; lvl: number } | null);
    if (!f) return null;
    const p = f(isoX, isoY);
    if (!p) return null;
    const cx = p.x / CELL_WU;
    const cy = p.y / CELL_WU;
    const col = Math.floor(cx);
    const row = Math.floor(cy);
    return { col, row, lvl: Math.round(p.lvl), fx: cx - col, fy: cy - row };
  };
}

/** The scene's zone state as a `source` (`__ml.ambientZoneState`). */
export function sourceFromProbe(): () => ZoneSource | null {
  return () => {
    const ml = (globalThis as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const f = ml?.ambientZoneState as undefined | (() => ZoneSource | null);
    return f ? f() : null;
  };
}
