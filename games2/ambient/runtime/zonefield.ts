import { type AmbientZoneDoc, CELL_WU, resolveAmbientAt, unpackZoneTable, zoneHolds } from "@nangijala/shared";

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
  private cells = new Map<string, { set: ReadonlySet<string>; zones: readonly string[] }>();
  /** Per blurred cell: the value, and the union of the zones its window read. */
  private blur = new Map<string, { v: number; zones: readonly string[] }>();
  private picks = new Map<string, ZonePick | null>();
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
      for (const [k, b] of this.blur) if (b.zones.some((z) => changed.has(z))) this.blur.delete(k);
      this.stats.pruned += changed.size;
    } else {
      this.cells.clear();
      this.blur.clear();
    }
    this.doc = doc;
    this.packed = packed;
    this.table = next;
    this.roomSky = roomSky;
    this.version++;
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
    const key = `${col},${row},${lvl}`;
    const hit = this.cells.get(key);
    if (hit) return hit;
    this.stats.resolves++;
    const set = new Set(resolveAmbientAt(this.doc, this.table, col, row, lvl));
    const zones = this.doc.zones.filter((z) => zoneHolds(z, col, row, lvl)).map((z) => z.id);
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
    const key = `${name}|${col},${row},${lvl}`;
    const hit = this.blur.get(key);
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
    this.blur.set(key, { v, zones: [...zones] });
    return v;
  }

  /** The cell under a drawn point, through the picker memo. */
  cellAt(isoX: number, isoY: number): ZonePick | null {
    const key = `${Math.floor(isoX / BUCKET_W)},${Math.floor(isoY / BUCKET_H)}`;
    const hit = this.picks.get(key);
    if (hit !== undefined) return hit;
    if (this.picks.size >= BUCKET_CAP) this.picks.clear();
    this.stats.picks++;
    let p: ZonePick | null = null;
    try { p = this.pick(isoX, isoY); } catch { p = null; }
    this.picks.set(key, p);
    return p;
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
    const b = (c: number, r: number) => this.blurred(name, c, r, p.lvl);
    const top = b(c0, r0) * (1 - t) + b(c0 + 1, r0) * t;
    const bot = b(c0, r0 + 1) * (1 - t) + b(c0 + 1, r0 + 1) * t;
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
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const x = rect.x + rect.width * ((i + 0.5) / cols);
        const y = rect.y + rect.height * ((j + 0.5) / rows);
        const k = j * cols + i;
        if (this.cellAt(x, y)) { out[k] = Math.round(255 * this.weightAt(name, x, y)); known[k] = 1; }
      }
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
      blur: this.blur.size,
      buckets: this.picks.size,
      feather: this.feather,
      ...this.stats,
    };
  }
}

const EMPTY: ReadonlySet<string> = new Set();
const NONE = { set: EMPTY, zones: [] as readonly string[] };

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
