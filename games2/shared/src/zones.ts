// zones.ts — THE ZONE GRID (spec/ZONES.md). Pure geometry shared by the server
// (which room owns a position, when a body nears a border) and the client
// (which zone room to join first, which path a zone is served on).
//
// A world is cut into cols x rows equal rectangles of whole cells; a zone id
// is `row * cols + col`. WHOLE_WORLD (-1) means "one room for the map", which
// is every world without a config entry and every test that names no zone.

export const WHOLE_WORLD = -1;

export interface ZoneCfg {
  cols: number;
  rows: number;
  /** zone id (or "*") → URL path prefix the zone's room is served on; "" = same origin. */
  routes?: Record<string, string>;
}

export interface ZoneGrid {
  cols: number;
  rows: number;
  /** zone width/height in WORLD UNITS (whole cells) */
  zw: number;
  zh: number;
  /** world extent in world units */
  w: number;
  h: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number;
}

/** The grid for a world of wCells x hCells (CELL_WU world units per cell). */
export function zoneGrid(cfg: ZoneCfg, wCells: number, hCells: number, cellWu: number): ZoneGrid {
  const cols = Math.max(1, Math.floor(cfg.cols));
  const rows = Math.max(1, Math.floor(cfg.rows));
  return {
    cols,
    rows,
    zw: Math.ceil(wCells / cols) * cellWu,
    zh: Math.ceil(hCells / rows) * cellWu,
    w: wCells * cellWu,
    h: hCells * cellWu,
  };
}

/** The zone containing a world-unit position (clamped onto the map). */
export function zoneAt(g: ZoneGrid, x: number, y: number): number {
  const c = Math.min(g.cols - 1, Math.max(0, Math.floor(x / g.zw)));
  const r = Math.min(g.rows - 1, Math.max(0, Math.floor(y / g.zh)));
  return r * g.cols + c;
}

/** A zone's rectangle in world units, half-open, clipped to the map. */
export function zoneRect(g: ZoneGrid, id: number): Rect {
  const c = id % g.cols;
  const r = Math.floor(id / g.cols);
  return {
    x0: c * g.zw,
    y0: r * g.zh,
    x1: Math.min(g.w, (c + 1) * g.zw),
    y1: Math.min(g.h, (r + 1) * g.zh),
  };
}

/** The up-to-eight zones sharing an edge or a corner with `id`. */
export function zoneNeighbours(g: ZoneGrid, id: number): number[] {
  const c = id % g.cols;
  const r = Math.floor(id / g.cols);
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const cc = c + dc;
      const rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= g.cols || rr >= g.rows) continue;
      out.push(rr * g.cols + cc);
    }
  return out;
}

/** Chebyshev distance from a point to a rectangle: 0 inside. */
export function distToRect(rect: Rect, x: number, y: number): number {
  const dx = x < rect.x0 ? rect.x0 - x : x >= rect.x1 ? x - rect.x1 + 1 : 0;
  const dy = y < rect.y0 ? rect.y0 - y : y >= rect.y1 ? y - rect.y1 + 1 : 0;
  return Math.max(dx, dy);
}

/** Inside the rectangle and within `band` of one of its edges — the border
 *  band a room publishes as ghosts. An edge on the map's own boundary does
 *  not count: nothing lies beyond it. */
export function nearEdge(rect: Rect, g: ZoneGrid, x: number, y: number, band: number): boolean {
  if (x < rect.x0 || y < rect.y0 || x >= rect.x1 || y >= rect.y1) return false;
  return (
    (rect.x0 > 0 && x - rect.x0 < band) ||
    (rect.y0 > 0 && y - rect.y0 < band) ||
    (rect.x1 < g.w && rect.x1 - x <= band) ||
    (rect.y1 < g.h && rect.y1 - y <= band)
  );
}

/** The URL path prefix a zone's room is served on ("" = the page's origin). */
export function zoneRoute(cfg: ZoneCfg | null | undefined, id: number): string {
  const routes = cfg?.routes;
  if (!routes) return "";
  return routes[String(id)] ?? routes["*"] ?? "";
}
