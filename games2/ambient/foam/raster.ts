/* SEA FOAM — the pure half. No Phaser, no DOM, no window: everything here is
 * arithmetic over byte arrays so that `server/test/foam.test.ts` can pin it and
 * the browser feature (foam.ts) only has to fetch, cache and draw.
 *
 * THE LINE BETWEEN MOVING WATER AND LAND is drawn by the game in two places,
 * and the foam has to sit on exactly those pixels or it reads as a sticker:
 *
 *   1. THE COAST — a composed Wang boundary tile whose two sides are a liquid
 *      and a ground. The seam is not in any grid: it is in the MASK SHEET the
 *      tiles domain publishes (tiles/patterns/masks.webp, frame =
 *      pattern.row * 16 + wangIndex, alpha 255 = side_b). A coast pixel is a
 *      water-side pixel of the tile's TOP FACE with a land-side 4-neighbour.
 *      The mask covers the wall band too, so the top face is cut with the
 *      library silhouette's first 29 rows (frame 15 of any row IS the
 *      silhouette; the index says so and it is measured identical).
 *
 *   2. THE WALL FOOT — a liquid cell whose up-left / up-right / straight-up
 *      neighbour is a higher wall whose lowest front is this cell's level. The
 *      game paints a band there (tiles3draw `footBand`): FOOT_UNDER rows that
 *      the face sprite covers, then the CREST lifted toward white, then the
 *      wall sinking through the water. `crestPixels` is that loop ported, and
 *      it keeps only the rows the face does not cover.
 *      `server/test/foam.test.ts` composes the game's own band and asserts the
 *      foam's crest is the bottom of it, column by column — if the games agent
 *      moves the line, the test says so, and it already has (2026-09-10: the
 *      covered rows became crest-coloured too and each wall now brings its own
 *      material, so the old pixel-for-pixel equality was wrong twice over).
 *      FOOT_UNDER CANCELS OUT here — it shifts the band's start and the kept
 *      rows by the same amount — so changing it alone cannot move the foam;
 *      WALL and CREST_ROWS can, and the test fails on both.
 *
 * Every pixel of the foam is a function of (distance from the nearest edge,
 * whether that edge is a wall, the pixel's WORLD position, the loop time).
 * World position is what makes it continuous across cells: two cells baked
 * separately still agree along their shared edge because nothing in the
 * function knows where a cell begins. */

export const TILE = 64;
export const PLATE_H = 46;
export const TOP_ROWS = 29; // the diamond: rows 0..28 of the plate
export const DX = 32;
export const DY = 14;
/** tiles3's review-art wall band (rows under a course's diamond) and the
 *  games agent's FOOT_UNDER (rows the band starts above the face's end). Both
 *  are the game's numbers, replicated: the crest is at band rows
 *  FOOT_UNDER..FOOT_UNDER+1 and the band starts WALL - pitch - FOOT_UNDER rows
 *  below the shared edge. The parity test is what keeps these honest. */
export const WALL = 17;
export const FOOT_UNDER = 2;
export const CREST_ROWS = 2;

/** THE LOOP. Frames are baked per cell and every cell steps the same frame at
 *  the same time, so a longer loop costs texture, not CPU. 20 frames at 150 ms
 *  is a 3.0 s swell — a beach breathes about that fast in this art's scale —
 *  and at that rate the front travels roughly a pixel a frame, which is the
 *  whole-pixel step the maintainer wants ("moves in full pixels, not sub-px
 *  translation"). */
export const FRAMES = 20;
export const FRAME_MS = 150;

/** How far offshore the foam ever reaches, in screen px along x. The iso
 *  projection squashes y by 14/32, so distance is measured with y weighted:
 *  a band 7 px wide along a "vertical" coast is about 4 px tall along a
 *  "horizontal" one, the way a ring drawn on this ground is an ellipse. Not
 *  the full 2.29 the projection says — that made the diagonal edges (which is
 *  most edges) too thin to read at two screen pixels per world pixel. */
export const D_MAX = 8;
export const Y_WEIGHT = 1.7;
/** The wave's furthest point out, per edge kind. A wall throws the water back
 *  so its foam is nearer and denser; a beach lets it run. */
const FAR_SOFT = 7;
const FAR_HARD = 6;

export type Bits = Uint8Array; // 1 per pixel, TILE wide

/* ---- geometry ---------------------------------------------------------- */

/** The top face from the library silhouette: rows 0..28 of a full frame. */
export function topFaceOf(silhouette: Bits): Bits {
  const out = new Uint8Array(TILE * TOP_ROWS);
  for (let py = 0; py < TOP_ROWS; py++)
    for (let px = 0; px < TILE; px++) out[py * TILE + px] = silhouette[py * TILE + px] ? 1 : 0;
  return out;
}

/** A plain diamond, for a caller with no sheet (tests, the fallback): the
 *  continuous 64x28 diamond footBand itself uses. */
export function diamondTop(): Bits {
  const out = new Uint8Array(TILE * TOP_ROWS);
  for (let py = 0; py < TOP_ROWS; py++)
    for (let px = 0; px < TILE; px++) {
      const u = px + 0.5 - DX;
      const y = py + 0.5;
      const upper = (DY * Math.abs(u)) / DX;
      if (y >= upper && y <= 2 * DY - upper) out[py * TILE + px] = 1;
    }
  return out;
}

/** WHICH TOP-FACE PIXELS ARE WATER. `maskBit` is null for a pure cell (all of
 *  the top face is the cell's own ground); for a boundary it answers side_b,
 *  and `waterIsB` says which side the liquid is. */
export function waterBits(
  top: Bits,
  own: boolean,
  maskBit: ((px: number, py: number) => boolean) | null,
  waterIsB: boolean,
): Bits {
  const out = new Uint8Array(TILE * TOP_ROWS);
  for (let py = 0; py < TOP_ROWS; py++)
    for (let px = 0; px < TILE; px++) {
      const i = py * TILE + px;
      if (!top[i]) continue;
      if (!maskBit) {
        out[i] = own ? 1 : 0;
        continue;
      }
      out[i] = maskBit(px, py) === waterIsB ? 1 : 0;
    }
  return out;
}

/** THE COAST: water pixels of the top face with a land pixel beside them (4-
 *  neighbourhood, inside the top face). The diamond's own outline is NOT a
 *  coast — the neighbouring tile continues the water there. Packed py*64+px. */
export function coastPixels(water: Bits, top: Bits): number[] {
  const out: number[] = [];
  const land = (px: number, py: number) => {
    if (px < 0 || py < 0 || px >= TILE || py >= TOP_ROWS) return false;
    const i = py * TILE + px;
    return !!top[i] && !water[i];
  };
  for (let py = 0; py < TOP_ROWS; py++)
    for (let px = 0; px < TILE; px++) {
      const i = py * TILE + px;
      if (!water[i]) continue;
      if (land(px - 1, py) || land(px + 1, py) || land(px, py - 1) || land(px, py + 1)) out.push(i);
    }
  return out;
}

/** THE CREST the game paints at a wall's foot — tiles3draw `footBand`, the
 *  same loop, keeping only the rows it lifts toward white. `walls` is the
 *  cell's `foot` directions; `pitch` the world's storey (15 on the_game). */
export function crestPixels(walls: { ul?: boolean; ur?: boolean; uu?: boolean }, pitch: number): number[] {
  const centres: [number, number][] = [];
  if (walls.ul) centres.push([-DX, 0]);
  if (walls.ur) centres.push([DX, 0]);
  if (walls.uu) centres.push([0, -DY]);
  const out: number[] = [];
  if (!centres.length) return out;
  const hang = WALL - pitch - FOOT_UNDER;
  for (let px = 0; px < TILE; px++) {
    const u = px + 0.5 - DX;
    const upper = (DY * Math.abs(u)) / DX;
    const lower = 2 * DY - upper;
    for (let py = 0; py < TOP_ROWS; py++) {
      const y = py + 0.5;
      if (y < upper || y > lower) continue;
      let d = Infinity;
      let covered = false;
      for (const [cx, cy] of centres) {
        const uw = Math.abs(u - cx);
        if (uw > DX) continue;
        const bottom = cy + DY * (1 - uw / DX) + hang;
        const dd = y - bottom;
        if (dd < 0) {
          covered = true;
          break;
        }
        if (dd < d) d = dd;
      }
      if (covered) continue;
      const row = Math.floor(d);
      if (row >= FOOT_UNDER && row < FOOT_UNDER + CREST_ROWS) out.push(py * TILE + px);
    }
  }
  return out;
}

/* ---- the field --------------------------------------------------------- */

export interface Edge {
  /** World px (the plate's own frame: sx + px, sy + py). */
  x: number;
  y: number;
  /** 1 = a wall's crest, 0 = a coast. */
  hard: 0 | 1;
}

/** Edges bucketed by world x so a pixel asks only the columns within reach:
 *  a coastal cell's neighbourhood carries a few hundred edge pixels and the
 *  bake asks for every one of ~3,000 top-face pixels — the brute force was
 *  most of a 5 ms bake (measured), this is a tenth of it. */
export const BUCKET = 8;
export class EdgeIndex {
  private readonly b = new Map<number, Edge[]>();
  readonly size: number;
  constructor(edges: Edge[]) {
    this.size = edges.length;
    for (const e of edges) {
      const k = Math.floor(e.x / BUCKET);
      const list = this.b.get(k);
      if (list) list.push(e);
      else this.b.set(k, [e]);
    }
  }
  /** Nearest edge in the weighted metric: { d, hard }, or null past D_MAX. */
  nearest(X: number, Y: number): { d: number; hard: 0 | 1 } | null {
    let best = D_MAX * D_MAX + 1e-6;
    let hard: 0 | 1 = 0;
    let found = false;
    const k0 = Math.floor((X - D_MAX) / BUCKET);
    const k1 = Math.floor((X + D_MAX) / BUCKET);
    for (let k = k0; k <= k1; k++) {
      const list = this.b.get(k);
      if (!list) continue;
      for (const e of list) {
        const dy = (Y - e.y) * Y_WEIGHT;
        if (dy > D_MAX || dy < -D_MAX) continue;
        const dx = X - e.x;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) {
          best = d2;
          hard = e.hard;
          found = true;
        }
      }
    }
    return found ? { d: Math.sqrt(best), hard } : null;
  }
}

/** Nearest edge in the weighted metric: { d, hard }, or null past D_MAX. */
export function nearestEdge(X: number, Y: number, edges: Edge[]): { d: number; hard: 0 | 1 } | null {
  return new EdgeIndex(edges).nearest(X, Y);
}

/* ---- the animation ----------------------------------------------------- */

const frac = (v: number) => v - Math.floor(v);

/** A per-pixel constant in [0,1): integer hash of the WORLD position and a
 *  salt. Static on purpose — the gaps in the front and the grain of the
 *  residue stay where they are while the wave moves through them, which is
 *  what foam streaks do. */
export function hash(x: number, y: number, salt: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinear value noise on the integer lattice, [0,1). */
export function noise(x: number, y: number, salt: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const sx = smooth(x - x0);
  const sy = smooth(y - y0);
  const a = hash(x0, y0, salt);
  const b = hash(x0 + 1, y0, salt);
  const c = hash(x0, y0 + 1, salt);
  const d = hash(x0 + 1, y0 + 1, salt);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** WHEN THE WAVE ARRIVES HERE. A slow field over the world, two or three
 *  cells across, so a stretch of coast surges as one coherent band and the
 *  next bay is out of step with it. Continuous, so two cells baked apart
 *  agree at their seam. */
export function phase(X: number, Y: number): number {
  return frac(noise(X / 150, Y / 80, 1) + 0.2 * noise(X / 48, Y / 28, 2));
}

export const NONE = 0;
export const SOFT = 1;
export const BRIGHT = 2;
export type Foam = 0 | 1 | 2;

/* THE LOOK IS WIND WAKER (maintainer 2026-09-09, on the first cut: "First
 * looks best. Think Zelda wind waker. The effect should almost look 'vector
 * graphics', but also like pixel art"). Every mark is a SOLID contour of the
 * distance field — the edge band, the crest lines, a pale one-pixel halo on
 * each in place of any dither — and the only breaks are long dashes cut by
 * slow noise, the way a drawn line breaks, never per pixel. The first cut's
 * dissolve-into-grain phase is gone: the frames he did not pick were the
 * grainy ones.
 *
 * WHAT HE PICKED FROM THE SECOND CUT decides the cycle: on the beach, the
 * frame with the hugging band AND a second clean line a few pixels out ("the
 * most interesting"); on the wall, the frame where the crest had swelled thick
 * and bright ("looks best"). So those are not moments the loop passes
 * through, they are most of it:
 *   - a TRAIN of crest lines is always in flight, TRAIN of them spaced evenly
 *     over the loop, each sliding in from `far` a pixel a frame with a pale
 *     halo, so a second contour is always out there;
 *   - the EDGE BAND (one pixel of white on the water side, with its halo) SWELLS
 *     to two or three pixels as each crest arrives and relaxes slowly enough
 *     that the swollen state is about half the time — taller and longer on a
 *     wall, and over a beach it runs one pixel onto the sand. */
const TRAIN = 2;
const RELAX = 0.22; // of the loop, after each arrival

export function foamAt(d: number, hard: boolean, X: number, Y: number, u: number): Foam {
  return foamCore(d, hard, phase(X, Y), grain(X, Y, 1), grain(X, Y, 2), grain(X, Y, 3), u);
}

/** Slow noise for the breaks in a line: features 10-20 px long, so a gap is a
 *  gap in a drawn line, not a speckle. */
export function grain(X: number, Y: number, which: number): number {
  return which === 1 ? noise(X / 16, Y / 9, 5) : which === 2 ? noise(X / 24, Y / 14, 6) : noise(X / 13, Y / 8, 7);
}

/** The same, with the pixel's constants — phase and the three grains —
 *  computed once by the caller: a bake evaluates every pixel FRAMES times. */
export function foamCore(d: number, hard: boolean, ph: number, n1: number, n2: number, n3: number, u: number): Foam {
  const v = frac(u + ph);
  const far = hard ? FAR_HARD : FAR_SOFT;
  let swell = 0;
  let line: Foam = NONE;
  for (let k = 0; k < TRAIN; k++) {
    const w = frac(v + k / TRAIN); // this crest's progress: 0 far out, 1 arriving
    const f = far * Math.pow(1 - w, 1.15);
    swell = Math.max(swell, 1 - f / 2.5, w < RELAX ? 1 - w / RELAX : 0);
    if (line === NONE && f > 0.8 && n1 > 0.28) {
      if (Math.abs(d - f) < 0.55) line = BRIGHT;
      else if (Math.abs(d - f) < 1.25 && n3 > 0.3) line = SOFT;
    }
  }
  const wEdge = (hard ? 1.2 : 1.0) + (hard ? 2.2 : 1.4) * swell + 0.4 * n2;
  if (d < 0) return !hard && d >= -1 && swell > 0.7 ? BRIGHT : NONE; // the swash
  if (d < wEdge) return BRIGHT;
  if (d < wEdge + 1) return SOFT; // the halo
  return line;
}

/* ---- the bake ---------------------------------------------------------- */

export interface BakeInput {
  /** The cell's plate origin in world px. */
  sx: number;
  sy: number;
  /** Water pixels of this cell's top face (waterBits). */
  water: Bits;
  /** The top face itself — the swash runs one pixel onto land, so land pixels
   *  of the face are candidates too. */
  top: Bits;
  /** Every edge within reach, this cell's and its neighbours', world px. */
  edges: Edge[];
  /** Is this cell the front-most surface drawn at that world pixel? */
  visible: (X: number, Y: number) => boolean;
  /** The liquid's top colour — foam is that colour lifted toward white. */
  waterRGB: readonly [number, number, number];
  frames?: number;
}

export interface Bake {
  /** The band's bounding box in the plate frame, and the sheet: `frames`
   *  frames of w x h RGBA side by side. */
  bx: number;
  by: number;
  w: number;
  h: number;
  frames: number;
  data: Uint8ClampedArray;
  /** Foam candidates (pixels within reach of an edge, drawn at all). */
  count: number;
}

/** Foam colour: the liquid lifted toward white — the same rule the game uses
 *  for the crest, further along. */
export function foamRGB(water: readonly [number, number, number], level: Foam): [number, number, number] {
  const k = level === BRIGHT ? 0.93 : 0.62;
  return [
    Math.round(water[0] + (255 - water[0]) * k),
    Math.round(water[1] + (255 - water[1]) * k),
    Math.round(water[2] + (255 - water[2]) * k),
  ];
}

export function bakeCell(inp: BakeInput): Bake | null {
  const frames = inp.frames ?? FRAMES;
  // 1. the candidates: every top-face pixel within reach of an edge
  const cand: { px: number; py: number; d: number; hard: boolean; ph: number; h1: number; h2: number; h3: number }[] = [];
  const index = new EdgeIndex(inp.edges);
  for (let py = 0; py < TOP_ROWS; py++)
    for (let px = 0; px < TILE; px++) {
      const i = py * TILE + px;
      if (!inp.top[i]) continue;
      const X = inp.sx + px;
      const Y = inp.sy + py;
      const n = index.nearest(X, Y);
      if (!n) continue;
      const isWater = !!inp.water[i];
      // Land takes the swash only: one pixel from a COAST, never from a wall.
      if (!isWater && (n.hard || n.d > 1.2)) continue;
      if (!inp.visible(X, Y)) continue;
      cand.push({ px, py, d: isWater ? n.d : -1, hard: !!n.hard, ph: phase(X, Y), h1: grain(X, Y, 1), h2: grain(X, Y, 2), h3: grain(X, Y, 3) });
    }
  if (!cand.length) return null;
  let x0 = TILE, y0 = TOP_ROWS, x1 = -1, y1 = -1;
  for (const c of cand) {
    if (c.px < x0) x0 = c.px;
    if (c.px > x1) x1 = c.px;
    if (c.py < y0) y0 = c.py;
    if (c.py > y1) y1 = c.py;
  }
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const data = new Uint8ClampedArray(w * frames * h * 4);
  const bright = foamRGB(inp.waterRGB, BRIGHT);
  const soft = foamRGB(inp.waterRGB, SOFT);
  for (let k = 0; k < frames; k++) {
    const u = k / frames;
    for (const c of cand) {
      const level = foamCore(c.d, c.hard, c.ph, c.h1, c.h2, c.h3, u);
      if (level === NONE) continue;
      const rgb = level === BRIGHT ? bright : soft;
      const o = ((c.py - y0) * (w * frames) + k * w + (c.px - x0)) * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
  }
  return { bx: x0, by: y0, w, h, frames, data, count: cand.length };
}
