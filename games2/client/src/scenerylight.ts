/* SCENERY LIGHT — THE SHAPE MAP a scenery piece's lit copy is shaded with,
 * per texel (WorldScene.applyObjectLights + scenerylit.ts, the pipeline).
 *
 * A piece is a flat sprite; the maintainer wants the torch to light DIFFERENT
 * PARTS of a tree as he walks around it (2026-09-05). Nothing in the art says
 * which way a pixel faces, so a VOLUME is assumed from what the game already
 * knows about the piece, and a pseudo-normal per texel is derived from it ONCE
 * per texture and kept as an RGBA raster the pipeline samples beside the art:
 *
 *   - THE HITBOX (the wiki's published ellipse or ground rectangle) is the
 *     ground contact: an ellipse stands for a ROUNDED volume (a surface of
 *     revolution about the vertical through its centre — trunk, stone, pot);
 *     a rect for a BOX whose visible faces turn with the placement's facing
 *     (bed, table, cupboard), with a lid that faces up.
 *   - THE ALPHA SILHOUETTE says how wide the volume is at every height: the
 *     per-row half-width IS the radius of revolution — where it widens going
 *     up (a crown's underside) the surface faces DOWN, where it narrows toward
 *     the top it faces UP, and across a row the normal swings from −x at the
 *     left edge through +y (toward the viewer) to +x at the right. Measured
 *     (data phase): the silhouette is symmetric about the hitbox axis to
 *     0.03·2rx median, the width AT the hitbox row is 0.99·2rx — so the
 *     hitbox and the alpha agree on the base and the alpha alone carries the
 *     crown.
 *   - SMOOTHNESS IS THE LAW ("sudden pops/hard edges are bad"). The raw
 *     per-row width jitters 5% (13% max) and branch tiers flip its sign every
 *     few rows, so a normal from a short-window derivative STRIPED every
 *     crown (measured: adjacent-row mean nz jumped 0.40-0.49 on the real
 *     trees, bright/dark bands down the whole tree). The radius is therefore
 *     smoothed with a TRIPLE BOX of half-width S = h/19 rows (≈ a Gaussian of
 *     σ = S: 10 rows on a 192 px sprite) and differentiated over ±S rows —
 *     nz is then monotone-smooth while the per-row width still carries the
 *     silhouette across the row. The profile is PADDED clamp-to-edge below the
 *     last opaque row (the old window averaged the EMPTY rows under the art
 *     into the radius, so every ground-contact row faced DOWN and darkened the
 *     base against the ground it stands on) and tapers to 0 above the first,
 *     so the cap is a dome, not a cut.
 *
 * FRAME: X = screen right (cells along the map's (col−row) diagonal), Y =
 * toward the viewer (cells along (col+row)), Z = up (levels, weighted by
 * SHAPE_ZW into cell-equivalents — the ground shader's own vertical weight).
 * The same frame the pipeline lights in and the collision stamp's footprint
 * frame.
 *
 * ENCODING (RGBA8, A = 255 — Phaser uploads Uint8Array textures with
 * UNPACK_PREMULTIPLY_ALPHA, so data may never ride the alpha channel):
 *   R = N.x·0.5+0.5   G = N.z·0.5+0.5   B = depth toward the viewer, cells / SHAPE_DEPTH_CELLS
 * N.y = sqrt(1 − N.x² − N.z²) — a visible surface always faces the viewer
 * side, so it needs no channel. The B depth puts the front of a 1.5-cell crown
 * 1.5 cells nearer the torch than its axis.
 *
 * HFLIP is NOT a second map: Phaser mirrors a flipped image by swapping its
 * UVs, so the pipeline reads the mirrored texel and negates N.x (the vertex's
 * `flip` sign). Mirroring the art about the crop's centre mirrors the hitbox
 * (ax → −ax) with it, so the unflipped map IS the flipped volume seen in a
 * mirror — exact by symmetry (`decodeShape` is the twin of that read, pinned
 * by server/test/scenerylight.test.ts).
 *
 * CACHE LAW: a map is a generated raster registered under a key derived from
 * the art path, a version tag and the hitbox it was built from — content, no
 * placement, never rewritten. Two placements of one sprite share one map.
 *
 * BUILT IN ROW SLICES (`ShapeMapBuilder.step`): a 256² sprite took 18-26 ms in
 * one frame (measured: a hitch every time a willow scrolled in), so the caller
 * builds a few rows per frame within its budget. Pure (no Phaser): the
 * generator runs headless in the test.
 */

export const SHAPE_MAP_VERSION = 2;
/** B channel scale: depth toward the viewer, in cells, over this many cells. */
export const SHAPE_DEPTH_CELLS = 4;
/** One level in cell-equivalents for the NORMAL's frame — the ground shader's
 *  own distance weight (`dist = sqrt(|Δxy|² + ((lz − z)·0.6)²)`), so a
 *  normal's vertical component and the light vector's are in the same units. */
export const SHAPE_ZW = 0.6;
/** One level in cell-equivalents for the copy's ATTENUATION distance only.
 *  With the ground's 0.6 an 11-level crown stood 6.3 cell-equivalents from a
 *  radius-6 torch and went ambient-black (measured: the whole tree took 22% of
 *  the light the flat tint gave it — darker than before, the opposite of the
 *  ask). 0.15 keeps a crown top 1.6 cell-eq up: the trunk beside the torch is
 *  brightest, the crown falls off gently (measured headless: a side torch
 *  lights the whole tree at 0.75× the flat tint, in front 1.25×), the foot
 *  texel is the ground's own (at P.z = 0 the term is 0.55·w either way). */
export const SHAPE_ZW_ATT = 0.15;
/** The Lambert direction's horizontal length floor (cells): a torch held at
 *  the axis lights every side at the wrap level instead of flipping. */
export const SHAPE_AXIS_MIN = 0.25;
/** Cells over which a box's normal rolls from one visible face to the next. */
const RECT_BLEND = 0.12;

/** Half-width (rows) of each of the three box passes the radius profile is
 *  smoothed with, for a sprite of height h: σ ≈ S rows. */
export function smoothRows(h: number): number {
  return Math.max(2, Math.min(16, Math.round(h / 19)));
}

export interface ShapePixels {
  w: number;
  h: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** The hitbox in the sprite's OWN frame, unflipped: centre in frame px from
 *  the frame's top-left (frame centre + the wiki's ax/ay), semi-axes in frame
 *  px, and for a rect its ground turn in radians (shared `rectGroundRot` for
 *  the unflipped placement — the mirror handles hflip). */
export interface ShapeHitbox {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rect: boolean;
  theta: number;
}

/** Frame px → world units, for the sprite as DRAWN (fitSprite's kx/ky). */
export interface ShapeScale {
  /** frame px along screen-x → cells of X: kx / (dx·√2). */
  px2cell: number;
  /** frame px along screen-y → cells of depth (Y): ky / (dy·√2). */
  py2cell: number;
  /** frame px along screen-y → levels: ky / lh. */
  px2lvl: number;
}

export interface ShapeMap {
  w: number;
  h: number;
  /** RGBA8, w·h·4 — see the encoding above. */
  data: Uint8Array;
  /** Opaque texels written (the probe's "is there anything here"). */
  opaque: number;
  rect: boolean;
  /** The volume's widest radius, cells (the probe / a future LOD). */
  maxR: number;
}

/** The map's texture key: the art key with its family swapped for `s3n:`, the
 *  version and the hitbox + scale it was built from. */
export function shapeMapKey(artKey: string, hb: ShapeHitbox, sc: ShapeScale): string {
  const r = (v: number) => Math.round(v * 100) / 100;
  const sig = [r(hb.cx), r(hb.cy), r(hb.rx), r(hb.ry), hb.rect ? 1 : 0, r(hb.theta), r(sc.px2cell * 1000), r(sc.px2lvl * 1000)].join(",");
  return `${artKey.replace(/^s3:/, "s3n:")}@v${SHAPE_MAP_VERSION}:${sig}`;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const sstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Per-row silhouette: half-width and centre in frame px, 0 / NaN for an empty
 *  row. One alpha scan — the same cost as alphaBBox — per texture. */
export function alphaRowProfile(px: ShapePixels): { half: Float32Array; mid: Float32Array } {
  const half = new Float32Array(px.h);
  const mid = new Float32Array(px.h);
  const d = px.data;
  for (let y = 0; y < px.h; y++) {
    let l = -1;
    let r = -1;
    const row = y * px.w;
    for (let x = 0; x < px.w; x++) {
      if (d[(row + x) * 4 + 3] === 0) continue;
      if (l < 0) l = x;
      r = x;
    }
    if (l < 0) {
      half[y] = 0;
      mid[y] = NaN;
    } else {
      half[y] = (r - l + 1) / 2;
      mid[y] = (l + r + 1) / 2;
    }
  }
  return { half, mid };
}

/** One box pass of half-width S over `src`, indices clamped at both ends. */
function boxPass(src: Float32Array, S: number): Float32Array {
  const h = src.length;
  const out = new Float32Array(h);
  const n = 2 * S + 1;
  const at = (i: number) => src[i < 0 ? 0 : i >= h ? h - 1 : i];
  let acc = 0;
  for (let k = -S; k <= S; k++) acc += at(k);
  out[0] = acc / n;
  for (let y = 1; y < h; y++) {
    acc += at(y + S) - at(y - 1 - S);
    out[y] = acc / n;
  }
  return out;
}

/** The SMOOTHED radius and centre profiles (frame px) the volume is built
 *  from — see the header's smoothness law. Exported for the band probe. */
export function smoothProfile(
  prof: { half: Float32Array; mid: Float32Array },
  h: number,
  S: number,
  cx: number,
): { Rs: Float32Array; Ms: Float32Array; top: number; bot: number } {
  let top = h;
  let bot = -1;
  for (let y = 0; y < h; y++)
    if (prof.half[y] > 0) {
      if (y < top) top = y;
      bot = y;
    }
  const R0 = new Float32Array(h);
  const M0 = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    // Clamp-to-edge below the art, 0 above it (the cap tapers, the base does not).
    R0[y] = y < top ? 0 : y > bot ? prof.half[bot] : prof.half[y];
    M0[y] = R0[y] > 0 ? (prof.half[y] > 0 ? prof.mid[y] : prof.mid[bot]) * R0[y] : 0;
  }
  let Rs: Float32Array = R0;
  let Mw: Float32Array = M0;
  for (let i = 0; i < 3; i++) {
    Rs = boxPass(Rs, S);
    Mw = boxPass(Mw, S);
  }
  const Ms = new Float32Array(h);
  for (let y = 0; y < h; y++) Ms[y] = Rs[y] > 1e-6 ? Mw[y] / Rs[y] : cx;
  return { Rs, Ms, top, bot };
}

type Face = { nx: number; ny: number; xa: number; ya: number; xb: number; yb: number };

/** Builds the shape map for one sprite, a slice of rows at a time. */
export class ShapeMapBuilder {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
  opaque = 0;
  maxR = 0;
  /** Next row to write; h when done. */
  y = 0;
  private readonly px: ShapePixels;
  private readonly hb: ShapeHitbox;
  private readonly sc: ShapeScale;
  private readonly S: number;
  private readonly Rs: Float32Array;
  private readonly Ms: Float32Array;
  private readonly top: number;
  private readonly faces: Face[] = [];
  private readonly xMin: number;
  private readonly xMax: number;
  private readonly topBand: number;

  constructor(px: ShapePixels, hb: ShapeHitbox, sc: ShapeScale) {
    this.px = px;
    this.hb = hb;
    this.sc = sc;
    this.w = px.w;
    this.h = px.h;
    this.data = new Uint8Array(px.w * px.h * 4);
    this.S = smoothRows(px.h);
    const prof = smoothProfile(alphaRowProfile(px), px.h, this.S, hb.cx);
    this.Rs = prof.Rs;
    this.Ms = prof.Ms;
    this.top = prof.top;
    for (let y = 0; y < px.h; y++) {
      const r = this.Rs[y] * sc.px2cell;
      if (r > this.maxR) this.maxR = r;
    }
    // A BOX: its ground corners in the X/Y frame (cells), turned by theta, and
    // the faces the viewer can see (outward normal toward +Y). The stamp's own
    // frame: U = X·c + Y·s, V = Y·c − X·s, so X = U·c − V·s, Y = U·s + V·c.
    const p = hb.rx * sc.px2cell;
    const q = hb.ry * sc.py2cell;
    if (hb.rect) {
      const c = Math.cos(hb.theta);
      const s = Math.sin(hb.theta);
      const corner = (u: number, v: number) => [u * c - v * s, u * s + v * c] as const;
      const defs: [number, number, number, number, number, number][] = [
        // outward normal (u,v) then the two corners (u,v) of that edge
        [0, 1, p, q, -p, q],
        [0, -1, p, -q, -p, -q],
        [1, 0, p, q, p, -q],
        [-1, 0, -p, q, -p, -q],
      ];
      for (const [nu, nv, ua, va, ub, vb] of defs) {
        const [nx, ny] = corner(nu, nv);
        if (ny <= 0.02) continue; // edge-on or facing away
        let [xa, ya] = corner(ua, va);
        let [xb, yb] = corner(ub, vb);
        if (xa > xb) {
          [xa, xb] = [xb, xa];
          [ya, yb] = [yb, ya];
        }
        this.faces.push({ nx, ny, xa, ya, xb, yb });
      }
      this.faces.sort((A, B) => A.xa - B.xa);
    }
    this.xMin = this.faces.length ? this.faces[0].xa : -p;
    this.xMax = this.faces.length ? this.faces[this.faces.length - 1].xb : p;
    this.topBand = Math.max(2, 2 * hb.ry); // rows of "lid" under the art's top, frame px
  }

  get done(): boolean {
    return this.y >= this.h;
  }

  /** Write up to `rows` more rows; true when the map is complete. */
  step(rows: number): boolean {
    const { w, h, hb, sc, Rs, Ms, S, faces } = this;
    const d = this.px.data;
    const out = this.data;
    const yEnd = Math.min(h, this.y + rows);
    for (let y = this.y; y < yEnd; y++) {
      const Rc = Math.max(Rs[y] * sc.px2cell, 0.02);
      // dR/dz over ±S rows, cells per cell-equivalent of height: positive =
      // wider ABOVE (the underside of a crown), so the surface faces down.
      const ya = Math.max(0, y - S);
      const yb = Math.min(h - 1, y + S);
      const dz = (yb - ya) * sc.px2lvl * SHAPE_ZW;
      const dRdz = dz > 0 ? ((Rs[ya] - Rs[yb]) * sc.px2cell) / dz : 0;
      const lid = hb.rect ? sstep(0, 1, (this.top + this.topBand - y) / this.topBand) : 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] === 0) {
          out[i] = 128;
          out[i + 1] = 128;
          out[i + 2] = 0;
          out[i + 3] = 255;
          continue;
        }
        this.opaque++;
        let nx: number;
        let ny: number;
        let nz: number;
        let depth: number;
        if (!hb.rect) {
          const sx = clamp(((x + 0.5 - Ms[y]) * sc.px2cell) / Rc, -1, 1);
          const cy = Math.sqrt(Math.max(0, 1 - sx * sx));
          nx = sx;
          ny = cy;
          nz = -dRdz;
          depth = cy * Rc;
        } else {
          const X = (x + 0.5 - hb.cx) * sc.px2cell;
          let wx = 0;
          let wy = 0;
          let wsum = 0;
          let dep = 0;
          for (const f of faces) {
            const wgt = clamp((X - f.xa + RECT_BLEND) / (2 * RECT_BLEND), 0, 1) * clamp((f.xb + RECT_BLEND - X) / (2 * RECT_BLEND), 0, 1);
            if (wgt <= 0) continue;
            const t = clamp((X - f.xa) / Math.max(1e-6, f.xb - f.xa), 0, 1);
            wx += f.nx * wgt;
            wy += f.ny * wgt;
            dep += (f.ya + (f.yb - f.ya) * t) * wgt;
            wsum += wgt;
          }
          if (wsum > 0) {
            nx = wx / wsum;
            ny = wy / wsum;
            depth = dep / wsum;
          } else {
            // Overhang beyond the box's visible corners: roll toward the side.
            const left = X < this.xMin;
            const f = left ? faces[0] : faces[faces.length - 1];
            const over = left ? this.xMin - X : X - this.xMax;
            const e = sstep(0, 0.3, over);
            const fx = f ? f.nx : 0;
            const fy = f ? f.ny : 1;
            nx = fx * (1 - e) + (left ? -1 : 1) * e;
            ny = fy * (1 - e);
            depth = f ? (left ? f.ya : f.yb) : 0;
          }
          // THE LID: the top rows of a box face up, rolled in over the footprint's
          // own screen depth so the front edge never steps.
          nx *= 1 - lid;
          ny *= 1 - lid;
          nz = lid;
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        out[i] = Math.round(clamp(nx * 0.5 + 0.5, 0, 1) * 255);
        out[i + 1] = Math.round(clamp(nz * 0.5 + 0.5, 0, 1) * 255);
        out[i + 2] = Math.round(clamp(depth / SHAPE_DEPTH_CELLS, 0, 1) * 255);
        out[i + 3] = 255;
      }
    }
    this.y = yEnd;
    return this.y >= h;
  }

  result(): ShapeMap {
    return { w: this.w, h: this.h, data: this.data, opaque: this.opaque, rect: this.hb.rect, maxR: this.maxR };
  }
}

/** Build the whole shape map for one sprite in one go (tests, probes). */
export function buildShapeMap(px: ShapePixels, hb: ShapeHitbox, sc: ShapeScale): ShapeMap {
  const b = new ShapeMapBuilder(px, hb, sc);
  b.step(px.h);
  return b.result();
}

/** The normal and depth the pipeline reads for the texel at (x, y) of the
 *  DRAWN sprite — `flipX` mirrors the read and negates N.x exactly as the
 *  fragment does. The test's twin of `texture2D(uShapeSampler, uv)`. */
export function decodeShape(
  map: { w: number; h: number; data: Uint8Array },
  x: number,
  y: number,
  flipX = false,
): { nx: number; ny: number; nz: number; depth: number } {
  const xx = flipX ? map.w - 1 - x : x;
  const i = (y * map.w + xx) * 4;
  const nx = ((map.data[i] / 255) * 2 - 1) * (flipX ? -1 : 1);
  const nz = (map.data[i + 1] / 255) * 2 - 1;
  const ny = Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz));
  return { nx, ny, nz, depth: (map.data[i + 2] / 255) * SHAPE_DEPTH_CELLS };
}

/** The per-texel light the fragment adds for ONE light — the CPU twin of the
 *  pipeline's loop body (same attenuation with SHAPE_ZW_ATT against the texel's
 *  own position, same wrapped Lambert from the AXIS's horizontal direction to
 *  the light; flicker-free), for probes and the test. `N` and `P` in the
 *  shape frame; the light relative to the piece's hitbox centre (the axis)
 *  in the same frame (cells, cells, levels). */
export function shapeLightTerm(
  N: { nx: number; ny: number; nz: number },
  P: { x: number; y: number; z: number },
  L: { x: number; y: number; z: number; radius: number },
  wrap: number,
): { att: number; lam: number } {
  const dx = L.x - P.x;
  const dy = L.y - P.y;
  const dzl = L.z - P.z;
  const dist = Math.hypot(dx, dy, dzl * SHAPE_ZW_ATT);
  const r = Math.abs(L.radius);
  let att = clamp(1 - dist / r, 0, 1);
  att *= att;
  const dot = (N.nx * L.x + N.ny * L.y) / Math.max(Math.hypot(L.x, L.y), SHAPE_AXIS_MIN);
  const lam = L.radius < 0 ? 1 : clamp(dot * (1 - wrap) + wrap, 0, 1);
  return { att, lam };
}
