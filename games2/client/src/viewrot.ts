/**
 * VIEW ROTATION — the world drawn with W, S or E up.
 *
 * RENDER-ONLY BY DESIGN. Simulation, prediction, collision and everything sent
 * to the server stay in SERVER space; only what is DRAWN is rotated. The ground
 * resolver, scenery and the night/shadow pass are built from a rotated copy of
 * the world document, and entities are projected through the same rotation.
 * So a rotation can draw something in the wrong place, but it cannot move the
 * player, desync the server or change a single gameplay rule.
 *
 * WHY THE ART NEEDS NOTHING NEW: a Wang boundary tile is indexed by which of its
 * four SCREEN corners carry the upper ground (8*NW + 4*NE + 2*SW + 1*SE). Rotate
 * the data and the resolver computes the permuted index itself and fetches a
 * tile that already exists — 283 of 284 transition sets carry all 16 masks, and
 * the convention holds in the pixels at 96.46% of 18,039 sampled corners.
 * Measured: a tile warped 90 degrees matches its rotational partner no better
 * than an unrelated tile (45.29 vs 45.37 / 255), so the art is SCREEN-lit, and
 * rotating the data under a fixed sun keeps every shadow falling the same way
 * on screen at every orientation.
 *
 * One quarter-turn clockwise: cell (x, y) of a W x H grid -> (H-1-y, x) of an
 * H x W grid; a continuous point (cell (x,y) spans [x,x+1)) -> (H-y, x); a grid
 * displacement (dx, dy) -> (-dy, dx). `k` counts quarter-turns, 0..3.
 */

export type ViewRot = 0 | 1 | 2 | 3;

export function normRot(k: number): ViewRot {
  return ((((Math.round(k) % 4) + 4) % 4) as ViewRot);
}

/** One quarter-turn of a cell index in a grid `h` rows tall. */
function cell1(x: number, y: number, h: number): [number, number] {
  return [h - 1 - y, x];
}
/** One quarter-turn of a continuous point in a grid `h` rows tall. */
function point1(x: number, y: number, h: number): [number, number] {
  return [h - y, x];
}

/** Cell (x, y) of the SERVER grid (w x h) -> its cell in the view grid. */
export function rotCell(x: number, y: number, k: ViewRot, w: number, h: number): [number, number] {
  let W = w, H = h;
  for (let i = 0; i < k; i++) { [x, y] = cell1(x, y, H); [W, H] = [H, W]; }
  return [x, y];
}

/** Cell (x, y) of the VIEW grid -> the same cell in the SERVER grid (w x h):
 *  the exact inverse of rotCell. One turn is (x', y') = (h-1-y, x), so
 *  (x, y) = (y', h-1-x'); undone in reverse, each against the grid it started from. */
export function unrotCell(x: number, y: number, k: ViewRot, w: number, h: number): [number, number] {
  for (let i = k - 1; i >= 0; i--) {
    const H = i % 2 === 0 ? h : w;
    [x, y] = [y, H - 1 - x];
  }
  return [x, y];
}

/** A continuous SERVER point (in cells) -> the view grid. */
export function rotPoint(x: number, y: number, k: ViewRot, w: number, h: number): [number, number] {
  let W = w, H = h;
  for (let i = 0; i < k; i++) { [x, y] = point1(x, y, H); [W, H] = [H, W]; }
  return [x, y];
}

/** A continuous VIEW point (in cells) -> the server grid. The exact inverse of
 *  rotPoint: (x', y') = (H - y, x)  =>  (x, y) = (y', H - x'), per turn. */
export function unrotPoint(x: number, y: number, k: ViewRot, w: number, h: number): [number, number] {
  // Undo the turns in reverse; the grid the i-th turn started from is w x h
  // for even i and h x w for odd i.
  for (let i = k - 1; i >= 0; i--) {
    const H = i % 2 === 0 ? h : w;
    [x, y] = [y, H - x];
  }
  return [x, y];
}

/** A grid displacement (a direction, a velocity) SERVER -> view. */
export function rotVec(dx: number, dy: number, k: ViewRot): [number, number] {
  for (let i = 0; i < k; i++) [dx, dy] = [-dy, dx];
  return [dx, dy];
}
/** A grid displacement VIEW -> server. */
export function unrotVec(dx: number, dy: number, k: ViewRot): [number, number] {
  for (let i = 0; i < k; i++) [dx, dy] = [dy, -dx];
  return [dx, dy];
}

/** The 8 facings in ring order. A quarter-turn clockwise is +2 in this ring:
 *  a displacement (dx,dy) -> (-dy,dx), and with +col = screen south-east and
 *  +row = screen south-west, south-east -> south-west -> north-west -> ... */
export const DIRS8 = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"] as const;
export type Dir8 = (typeof DIRS8)[number];

/** A facing SERVER -> view. Unknown names pass through untouched. */
export function rotDir8(name: string, k: ViewRot): string {
  const i = (DIRS8 as readonly string[]).indexOf(name);
  return i < 0 ? name : DIRS8[(i + 2 * k) % 8];
}

/** The facings the scenery domain publishes rotations for (shared/world3.ts
 *  SCENERY_FACINGS). A directed piece turned to anything else would show its
 *  BACK — which has no art — so the rotated view leaves it out. */
const CAMERA_FACINGS = new Set(["south", "south-east", "south-west"]);

export interface RotateStats { hiddenPieces: number; /** indices (in doc.scenery) of pieces the view must not draw */ hiddenIdx?: number[] }

/**
 * The world document (pixel-maps3/world@1, as fetched) rotated `k` quarter-turns
 * clockwise. Returns a NEW document; the input is never touched, and k = 0
 * returns the input itself. Every positional field the parser reads is turned:
 * the ground and level grids, spawn, land, and the cells of decks, walls, ramps
 * and rooms; scenery points and their facings.
 */
export function rotateWorldDoc(doc: any, k: ViewRot, stats?: RotateStats): any {
  if (!doc || k === 0) return doc;
  const w: number = doc.size?.w ?? doc.ground?.[0]?.length ?? 0;
  const h: number = doc.size?.h ?? doc.ground?.length ?? 0;
  const ow = k % 2 === 0 ? w : h; // the rotated grid's width
  const oh = k % 2 === 0 ? h : w;
  const grid = (g: any[][] | undefined, fill: number): number[][] => {
    const out: number[][] = Array.from({ length: oh }, () => new Array(ow).fill(fill));
    if (!Array.isArray(g)) return out;
    for (let y = 0; y < h; y++) {
      const row = g[y];
      if (!row) continue;
      for (let x = 0; x < w; x++) {
        const [nx, ny] = rotCell(x, y, k, w, h);
        out[ny][nx] = row[x];
      }
    }
    return out;
  };
  const cells = (list: any[] | undefined) =>
    (Array.isArray(list) ? list : []).map((c: any) => {
      if (!Number.isFinite(c?.x) || !Number.isFinite(c?.y)) return c;
      const [x, y] = rotCell(c.x, c.y, k, w, h);
      return { ...c, x, y };
    });
  const groups = (list: any[] | undefined) => (Array.isArray(list) ? list : []).map((e: any) => ({ ...e, cells: cells(e?.cells) }));
  // A directed piece turned to face AWAY has no art for that side. It is kept
  // in place (so every index still joins the server's scenery and footprints)
  // and reported, so the drawn view can leave it out.
  const hiddenIdx: number[] = [];
  const scenery = (Array.isArray(doc.scenery) ? doc.scenery : []).map((p: any, i: number) => {
    const [x, y] = rotPoint(Number(p?.x), Number(p?.y), k, w, h);
    if (typeof p?.dir !== "string") return { ...p, x, y };
    const dir = rotDir8(p.dir, k);
    if (!CAMERA_FACINGS.has(dir)) { hiddenIdx.push(i); return { ...p, x, y }; }
    return { ...p, x, y, dir };
  });
  if (stats) { stats.hiddenPieces = hiddenIdx.length; stats.hiddenIdx = hiddenIdx; }
  const out: any = { ...doc, size: { ...(doc.size ?? {}), w: ow, h: oh } };
  out.ground = grid(doc.ground, -1);
  out.level = grid(doc.level, 0);
  out.decks = groups(doc.decks);
  out.walls = groups(doc.walls);
  out.ramps = groups(doc.ramps);
  out.rooms = groups(doc.rooms);
  out.scenery = scenery;
  if (Array.isArray(doc.spawn) && doc.spawn.length >= 2) {
    const [sx, sy] = rotCell(doc.spawn[0], doc.spawn[1], k, w, h);
    out.spawn = [sx, sy, ...doc.spawn.slice(2)];
  }
  if (doc.land && Number.isFinite(doc.land.x0)) {
    const a = rotCell(doc.land.x0, doc.land.y0, k, w, h);
    const b = rotCell(doc.land.x1, doc.land.y1, k, w, h);
    out.land = { ...doc.land, x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
  }
  return out;
}

/** The scenery footprints (shared SceneryFootprints) as the ROTATED view sees
 *  them — for the night pass, which stamps scenery shadows into the view's
 *  heightmap. Collision keeps the server-space original. Footprints live in the
 *  map's diagonal frame (p along (1,-1)/sqrt2, q along (1,1)/sqrt2), where one
 *  quarter-turn maps (X, Y) -> (-Y, X): an ellipse swaps its semi-axes and its
 *  supports; a rectangle keeps its own axes, turns its angle by +90 degrees and
 *  swaps its supports. Centres turn as points. The spatial index (start/items)
 *  is server-keyed and is not carried: nothing that reads the view copy uses it. */
export function rotFootprints<T extends {
  n: number; cx: Float64Array; cy: Float64Array; rx: Float64Array; ry: Float64Array;
  p: Float64Array; q: Float64Array; rect: Uint8Array; rcos: Float64Array; rsin: Float64Array;
  supX: Float64Array; supY: Float64Array;
}>(fp: T, k: ViewRot, w: number, h: number): T {
  if (k === 0) return fp;
  const out = { ...fp } as T;
  for (const key of ["cx", "cy", "rx", "ry", "p", "q", "rcos", "rsin", "supX", "supY"] as const)
    (out as Record<string, unknown>)[key] = new Float64Array(fp[key]);
  const odd = k % 2 === 1;
  for (let j = 0; j < fp.n; j++) {
    const [x, y] = rotPoint(fp.cx[j], fp.cy[j], k, w, h);
    out.cx[j] = x; out.cy[j] = y;
    if (odd) {
      [out.supX[j], out.supY[j]] = [fp.supY[j], fp.supX[j]];
      if (!fp.rect[j]) { [out.p[j], out.q[j]] = [fp.q[j], fp.p[j]]; [out.rx[j], out.ry[j]] = [fp.ry[j], fp.rx[j]]; }
    }
    if (fp.rect[j]) {
      let c = fp.rcos[j], s = fp.rsin[j];
      for (let i = 0; i < k; i++) [c, s] = [-s, c];
      out.rcos[j] = c; out.rsin[j] = s;
    }
  }
  return out;
}
