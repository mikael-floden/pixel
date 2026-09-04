/* TILES 3.0 DRAW LAYER — the ordered blits a resolved cell paints, and the two
 * PIXEL operations the resolver deliberately only names.
 *
 * `tiles3.ts` answers "what draws on this cell" and stops at the edge of
 * pixels: it reports a boundary as (Wang index, mask frame, plate A, plate B)
 * and a `conform` plate as "64x64 art that is not plate geometry yet". Both
 * need a raster. This module owns exactly those two rasters, the texture KEYS
 * everything lands under, and the translation from a resolved window to a list
 * of draw operations a streaming renderer can execute per cell.
 *
 * THE SPEC is `maps2/pipeline/render3.py` (`composed_boundary`,
 * `conformed_plate`) plus `tiles/patterns/index.json`, which publishes the
 * compose recipe and the seam the renderer must not skip. Where render3 and the
 * pattern library disagree the disagreement is named at the line it affects.
 *
 * NO SCENE STATE, NO PHASER IMPORT, NO DOM TYPES. Everything this module needs
 * from the host is declared structurally below (`TextureManagerLike`,
 * `CanvasLike`), so a Phaser `TextureManager` and an `HTMLCanvasElement` both
 * satisfy it by shape and the whole module is provable under node with a
 * ~30-line fake. The pixel core (`composeBoundary`, `conformPlate`) touches no
 * host at all: it is `Pixels` in, `Pixels` out.
 *
 * WHAT IT DRAWS IS WHAT tiles3.ts RESOLVES, and render3 has moved on since the
 * parity fixture that pins the resolver: it now dresses a wall CAP and a LIQUID
 * with the maintainer's set through `top_face_only(surface())`, it has SLOPE
 * tiles (tiles/slopes), its fade band is a probabilistic Chebyshev scan from
 * ring 1 where the resolver's is an axis scan from ring 2, its storey course is
 * keyed on the wall's side rather than the cell's ground, and its DETAIL_FREQ
 * is 1/56 against the resolver's 1/48. Every one of those is a RESOLUTION
 * decision and belongs in tiles3.ts and its fixture, not here: this module
 * paints whatever comes out. When the resolver catches up, nothing in this file
 * changes — a new art kind arrives as another `PlateArt` and composes the same.
 *
 * THE CACHE LAW (CLAUDE.md, absolute). Every key here is derived from the
 * CONTENT that went into the texture — the ground pair, the mask frame, the
 * plate identities, the palette colour — never from a cell coordinate and never
 * from a mutable name. Two cells with the same inputs share one texture; a
 * changed input mints a NEW key and cannot overwrite the old one. That is also
 * what makes eviction safe: an evicted key rebuilt later is byte-identical, so
 * a page holding the old texture and a page rebuilding it can never disagree.
 */

import {
  DX,
  DY,
  TILE,
  TOP_Y,
  PLATE_H,
  LIQUID_TILE_GROUNDS,
  hexRGB,
  type PatternsDoc,
  type Tiles3Boundary,
  type Tiles3Cell,
  type Tiles3DeckCell,
  type Tiles3Window,
  type TileArt,
} from "./tiles3";

/* -- pixels ----------------------------------------------------------------- */

/** A decoded RGBA raster, row-major, 4 bytes per pixel — the currency of the
 *  pixel core. Same layout as `ImageData` and as `imagelib.mjs`'s `imgRGBA`, so
 *  either side can be handed straight in. */
export interface Pixels {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

export function newPixels(w: number, h: number): Pixels {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

/** Python's `numpy.rint`: HALF TO EVEN. NOT `Math.round`, and the difference is
 *  visible: at the seam's tone 0.82 the channel values 25/75/125/175/225 land
 *  exactly on .5, where rint gives the even neighbour and Math.round gives the
 *  larger one. The wiki's own compose gate discriminates on precisely those
 *  values (wiki/tools/check-transcompose.mjs), so a Math.round here would make
 *  every game screenshot argue with the wiki's preview of the same tile. */
export function rint(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/* -- the pattern library ---------------------------------------------------- */

/** `tiles/patterns/*` as the draw layer needs it: the silhouette that IS every
 *  plate's and every composed tile's alpha, the Wang mask sheet, and the seam
 *  (border) sheet. All three are strictly binary alpha — measured 0 partial
 *  pixels in all of masks.webp (289,728 set), borders.webp (29,032) and
 *  silhouette.webp (2,012) — so the sampling threshold cannot matter and both
 *  of the producers' thresholds (`> 127` in render3, `> 0` in
 *  transition_patterns.border_of) give the same bits. */
export interface PatternSheets {
  /** Frame size, from the index — 64x46. */
  fw: number;
  fh: number;
  /** Frames per sheet row — 16, one per Wang index. */
  cols: number;
  /** The silhouette's alpha byte per pixel, `fw*fh` long. Copied verbatim into
   *  a composed tile's alpha: render3 assigns the CHANNEL, not a threshold. */
  sil: Uint8Array;
  /** True where the composed tile takes side_b. `frame` is the FLAT frame index
   *  `pattern.row * cols + wangIndex` that `Tiles3.maskFrame()` returns. */
  maskBit(frame: number, x: number, y: number): boolean;
  /** True on the 1px seam. Empty on frames 0 and 15 of every pattern, so a
   *  field of one ground carries no marks and never reads as a grid. */
  borderBit(frame: number, x: number, y: number): boolean;
  /** `border.tone` — each side darkened to this much of ITS OWN colour. */
  tone: number;
  /** The library's top face (`transition_render.top_face` over the
   *  silhouette), and its complement inside the silhouette: the wall. A
   *  conformed plate fills the wall from the ground's palette. */
  libTop: Uint8Array;
  libWall: Uint8Array;
}

/** The three sheets a draw layer must have, as repo-relative paths, straight
 *  out of the patterns index — never spelled out here, because the index is
 *  what a republish changes. */
export function patternSheetPaths(doc: PatternsDoc): { silhouette: string; masks: string; border: string } {
  const d = doc as unknown as {
    silhouette?: { file?: string };
    masks?: { file?: string };
    border?: { file?: string };
  };
  return {
    silhouette: d.silhouette?.file ?? "tiles/patterns/silhouette.webp",
    masks: d.masks?.file ?? "tiles/patterns/masks.webp",
    border: d.border?.file ?? "tiles/patterns/borders.webp",
  };
}

/** THE TOP FACE FROM A SILHOUETTE, not from a rhombus equation — the port of
 *  `transition_render.top_face`. The wall is a vertical extrusion of constant
 *  depth, so per column the top face is everything above the last WALL_D rows.
 *  The equation this replaces was a pixel short at every extreme and counted a
 *  whole ring of genuine top face as wall. */
export const WALL_D = 17;

export function topFaceMask(w: number, h: number, alpha: (i: number) => boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let lo = -1;
    let hi = -1;
    for (let y = 0; y < h; y++) {
      if (!alpha(y * w + x)) continue;
      if (lo < 0) lo = y;
      hi = y;
    }
    if (lo < 0) continue;
    /* `m[ys.min() : ys.max()-WALL_D+1]` — a numpy slice, so the last row kept
     * is ys.max()-WALL_D and an empty range is empty, not inverted. */
    for (let y = lo; y <= hi - WALL_D; y++) if (alpha(y * w + x)) out[y * w + x] = 1;
  }
  return out;
}

/** Build the sheets from three decoded rasters. `masks` and `border` are the
 *  whole 1024x828 sheets; frames are cut by index. */
export function patternSheets(doc: PatternsDoc, silhouette: Pixels, masks: Pixels, border: Pixels): PatternSheets {
  const d = doc as unknown as {
    masks?: { frame_w?: number; frame_h?: number; cols?: number };
    border?: { tone?: number };
  };
  const fw = d.masks?.frame_w ?? TILE;
  const fh = d.masks?.frame_h ?? PLATE_H;
  const cols = d.masks?.cols ?? 16;
  const tone = d.border?.tone ?? 0.82;
  if (silhouette.w !== fw || silhouette.h !== fh)
    throw new Error(`tiles3draw: silhouette is ${silhouette.w}x${silhouette.h}, the index declares ${fw}x${fh}`);
  const sil = new Uint8Array(fw * fh);
  for (let i = 0; i < fw * fh; i++) sil[i] = silhouette.data[i * 4 + 3];
  const libTop = topFaceMask(fw, fh, (i) => sil[i] > 0);
  const libWall = new Uint8Array(fw * fh);
  for (let i = 0; i < fw * fh; i++) libWall[i] = sil[i] > 0 && !libTop[i] ? 1 : 0;
  const bit = (sheet: Pixels, frame: number, x: number, y: number): boolean => {
    const r0 = Math.floor(frame / cols) * fh;
    const c0 = (frame % cols) * fw;
    const px = c0 + x;
    const py = r0 + y;
    if (px < 0 || py < 0 || px >= sheet.w || py >= sheet.h) return false;
    return sheet.data[(py * sheet.w + px) * 4 + 3] > 127;
  };
  return {
    fw,
    fh,
    cols,
    sil,
    tone,
    libTop,
    libWall,
    maskBit: (frame, x, y) => bit(masks, frame, x, y),
    borderBit: (frame, x, y) => bit(border, frame, x, y),
  };
}

/* -- 1. THE COMPOSED BOUNDARY ----------------------------------------------- */

/** THE ONE GENUINELY NEW THING IN V3. In world@1 a boundary between two grounds
 *  was a pre-baked transition tile — one blit, one file per pair. Here it is
 *  COMPOSED, which is why 18 boundary shapes x 16 Wang masks over per-ground
 *  plates cover all 105 pairs with no per-pair art at all:
 *
 *      out.rgb   = mask ? plateB : plateA      (render3.composed_boundary)
 *      out.alpha = the published silhouette
 *      then every SEAM pixel is darkened to `tone` of what it already is.
 *
 *  THE SEAM IS NOT OPTIONAL, and it is the one place render3 and the tiles
 *  library disagree: `composed_boundary` draws the two-line version and never
 *  reads borders.webp, while the library that publishes the sheet states the
 *  rule in the file itself — "THE SEAM, 1px on each side, and it is NOT
 *  optional - a transition without it is a 0-100 hard cut, which is not what
 *  the generator drew" (tiles/patterns/index.json, maintainer verdict
 *  2026-08-27), and the wiki draws it that way in the preview the maintainer
 *  reviews from. The library wins: the game must draw what he approved, and a
 *  render3 still-render is not what players look at. Pass `seam: false` to get
 *  render3's literal output for a pixel diff against it.
 *
 *  ONE MASK SERVES BOTH SIDES because the seam DARKENS what is already there —
 *  each side comes out a darker shade of ITS OWN ground, never a blend. The
 *  border frames are symmetric under the polarity flip (0 of 423,936 px differ,
 *  measured across all 18 patterns), so a consumer that flips the mask frame
 *  must NOT flip the border.
 *
 *  Both plates must already be plate geometry (fw x fh). A raw 64x64 review
 *  tile substituted here puts 928 of 2012 px in the wrong alpha, silently —
 *  run it through `conformPlate` first, which is what `PlateArt.kind ===
 *  "conform"` is telling the loader. */
export function composeBoundary(
  sheets: PatternSheets,
  frame: number,
  plateA: Pixels,
  plateB: Pixels,
  opts?: { seam?: boolean },
): Pixels {
  const { fw, fh, sil, tone } = sheets;
  for (const [name, p] of [
    ["a", plateA],
    ["b", plateB],
  ] as const)
    if (p.w !== fw || p.h !== fh)
      throw new Error(`tiles3draw: plate ${name} is ${p.w}x${p.h}, composition needs ${fw}x${fh} plate geometry`);
  const seam = opts?.seam !== false;
  const out = newPixels(fw, fh);
  const o = out.data;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const i = y * fw + x;
      const a = sil[i];
      /* RGB IS ZERO OUTSIDE THE SILHOUETTE. render3 leaves whatever the plates
       * held there; it is invisible either way (alpha 0), and a canvas texture
       * round-trips premultiplied and would zero it anyway — so zeroing here is
       * what the GPU sees, stated. */
      if (a === 0) continue;
      const src = sheets.maskBit(frame, x, y) ? plateB.data : plateA.data;
      let r = src[i * 4];
      let g = src[i * 4 + 1];
      let b = src[i * 4 + 2];
      if (seam && sheets.borderBit(frame, x, y)) {
        r = rint(r * tone);
        g = rint(g * tone);
        b = rint(b * tone);
      }
      o[i * 4] = r;
      o[i * 4 + 1] = g;
      o[i * 4 + 2] = b;
      o[i * 4 + 3] = a;
    }
  }
  return out;
}

/** A FADE OVERLAY'S KEY. Distinct from the conformed plate of the same file:
 *  it is a DIFFERENT PICTURE (the field texels are transparent), and two
 *  pictures must never share a key. */
export function fadeKey(path: string, ground: string): string {
  return `t3d:${ground}|${path}`;
}

/** HOW CLOSE TO THE GROUND'S OWN TOP COLOUR COUNTS AS "FIELD", and therefore
 *  as not-scatter. Measured over the real fade arts: 100% of the 124 rim texels
 *  sit within 10 of the palette top, while the scatter is tens of units away —
 *  a wide gap, so the threshold is not delicate. */
export const FADE_FIELD_TOL = 10;

/** THE SCATTER ONLY. Conform the fade tile as usual, then make every texel that
 *  IS the field's own colour transparent, so what lands on the cell is the
 *  producer's scatter and nothing else.
 *
 *  This is what stops a fade from outlining its own diamond. Drawn as a
 *  replacement, a fade tile is a flat palette-coloured patch — 100% of its rim,
 *  45-54% of its whole top face — dropped among TEXTURED member plates, and its
 *  rim reads as an edge against every neighbour. Drawn as an overlay, there is
 *  no rim to read: the field texels are simply absent and the cell's own plate
 *  shows through them. */
export function fadeOverlay(sheets: PatternSheets, src: Pixels, topRGB: readonly [number, number, number], wallRGB: readonly [number, number, number]): Pixels {
  const { fw, fh, libTop } = sheets;
  const out = conformPlate(sheets, src, wallRGB);
  const d = out.data;
  for (let i = 0; i < fw * fh; i++) {
    if (!libTop[i]) {
      // the wall band is the cell's own business; an overlay never paints it
      d[i * 4 + 3] = 0;
      continue;
    }
    if (d[i * 4 + 3] === 0) continue;
    const dr = d[i * 4] - topRGB[0];
    const dg = d[i * 4 + 1] - topRGB[1];
    const db = d[i * 4 + 2] - topRGB[2];
    if (Math.sqrt(dr * dr + dg * dg + db * db) <= FADE_FIELD_TOL) d[i * 4 + 3] = 0;
  }
  return out;
}

/* -- 2. CONFORMING 64x64 ART INTO PLATE GEOMETRY ---------------------------- */

/** A fixed 64x46 window ANCHORED AT THE ART'S TOP ROW — the port of
 *  `transition_post._crop_to_art`. Not the alpha bbox: a tile whose lowest row
 *  happens to be empty would come out 45 rows and the composer indexes base and
 *  mask with one mask, so a single row of disagreement is an index error. Rows
 *  past the source are transparent, which is correct for the row a short tile
 *  is missing. */
export function cropToArt(src: Pixels, fw: number, fh: number): Pixels {
  let ymin = -1;
  for (let y = 0; y < src.h && ymin < 0; y++)
    for (let x = 0; x < src.w; x++)
      if (src.data[(y * src.w + x) * 4 + 3] > 0) {
        ymin = y;
        break;
      }
  const out = newPixels(fw, fh);
  if (ymin < 0) return out;
  for (let y = 0; y < fh; y++) {
    const sy = ymin + y;
    if (sy >= src.h) break;
    for (let x = 0; x < fw && x < src.w; x++) {
      const si = (sy * src.w + x) * 4;
      const di = (y * fw + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

/** THE LAWFUL CONFORMER — `transition_patterns.plate()` followed by
 *  `render3.conformed_plate`'s wall fill, in one pass.
 *
 *  WHY IT EXISTS: `tiles/plates` is built only from APPROVED REVIEW CELLS, but
 *  104 of the 340 members in live/tuning/base_tile_sets.json point at art from
 *  tiles/tops and tiles/base_candidates, for which no plate exists. Using that
 *  art verbatim is NOT the fix — a review tile is 64x64 with its own ragged
 *  silhouette, a plate is 64x46 with the library's byte-exact one, and straight
 *  composition puts 928 of 2012 px in the wrong alpha (tiles agent, measured).
 *
 *  THE STEPS, each of which is load-bearing:
 *   1. crop to the fixed window at the art's top row (`cropToArt`);
 *   2. per column, extend the art's own colour UP from the first top-face row
 *      and DOWN from the last opaque row, so every silhouette pixel outside the
 *      source's ragged edge has a real colour instead of landing on nothing;
 *   3. the library's top face is ONE ROW DEEPER than a review tile's, and that
 *      row is taken from the source's own SURFACE, not from what it drew there
 *      — which is its BRIM, the overhang belonging to the side material. Left
 *      alone it ships the neighbour's colour inside the ground: 234,789 px,
 *      6.9% of all top-face pixels, and after tiling it reads as a DIAMOND
 *      WIREFRAME over any textured field;
 *   4. a column with no art at all is filled from the NEAREST column that has
 *      some, ties going LEFT (Python's `min` keeps the first minimum in
 *      ascending order). Skipping it and setting alpha anyway ships an opaque
 *      black stripe;
 *   5. alpha := the published silhouette, wall := the ground's palette wall
 *      colour, rgb := 0 outside the silhouette.
 *
 *  Verified by its author over a review tile: reproduces the published plate
 *  byte for byte, 0 px differing, alpha == the silhouette, 2012 opaque. */
export function conformPlate(sheets: PatternSheets, src: Pixels, wallRGB: readonly [number, number, number]): Pixels {
  const { fw, fh, sil, libTop, libWall } = sheets;
  const a = cropToArt(src, fw, fh);
  const out = newPixels(fw, fh);
  out.data.set(a.data);
  const opaque = (i: number): boolean => a.data[i * 4 + 3] > 0;
  const top = topFaceMask(fw, fh, opaque);
  const empty: number[] = [];
  const copyRGB = (di: number, si: number) => {
    out.data[di * 4] = a.data[si * 4];
    out.data[di * 4 + 1] = a.data[si * 4 + 1];
    out.data[di * 4 + 2] = a.data[si * 4 + 2];
  };
  for (let x = 0; x < fw; x++) {
    let tLo = -1;
    let tHi = -1;
    let cLo = -1;
    let cHi = -1;
    for (let y = 0; y < fh; y++) {
      const i = y * fw + x;
      if (top[i]) {
        if (tLo < 0) tLo = y;
        tHi = y;
      }
      if (opaque(i)) {
        if (cLo < 0) cLo = y;
        cHi = y;
      }
    }
    if (tLo < 0 || cLo < 0) {
      empty.push(x);
      continue;
    }
    for (let y = 0; y < tLo; y++) copyRGB(y * fw + x, tLo * fw + x);
    for (let y = cHi + 1; y < fh; y++) copyRGB(y * fw + x, cHi * fw + x);
    for (let y = tHi + 1; y < fh; y++) if (libTop[y * fw + x]) copyRGB(y * fw + x, tHi * fw + x);
    /* AND THE HOLES *INSIDE* THE COLUMN — THE ZIGZAG.
     *
     * The three loops above extend a column OUTWARD: above its top face, below
     * its silhouette, and into the row the library's top face runs deeper than
     * the source's. None of them reaches a texel that is transparent BETWEEN
     * opaque ones, and the alpha pass below then forces every silhouette texel
     * opaque. So that texel ships the RGB the source stored UNDER its
     * transparency — preserved byte-for-byte by the repo's `exact=True` WebP
     * law — as a solid pixel of a colour nobody chose.
     *
     * A base tile's columns are solid, so it never shows. A FADE tile is a
     * scatter (patches/spots/piles/lumps) that is full of holes by
     * construction, so it always can — which is exactly where the maintainer
     * put it: "On this screenshot I got the zigzag on the fade-tiles only."
     * Measured over his window (the_game, 416.9/340.8): 18 of 66 fade arts,
     * 153 texels, 65 cells, every one on rows 1-15 — the diamond's upper ramp
     * — and every one dark against its own ground: (89,59,46) on grass,
     * (78,101,70) on light_soil, (84,57,33) on light_beach. A dark dotted line
     * one texel wide tracing the tile diamonds.
     *
     * Fill from the nearest row in this same column that the source did paint.
     * This only ever writes a texel that no rule painted, so nothing already
     * correct can move.
     *
     * The python reference has the same gap: transition_patterns.plate() fixes
     * only the EMPTY-column case and claims "every silhouette pixel has a real
     * colour" on the strength of it. Raised with the tiles agent — until they
     * land it, render3's output and the client's disagree on these texels. */
    for (let y = tLo; y <= cHi; y++) {
      const i = y * fw + x;
      if (sil[i] === 0 || libWall[i] || opaque(i)) continue;
      if (y > tHi && libTop[i]) continue; // already taken from tHi above
      let up = -1;
      let dn = -1;
      for (let k = y - 1; k >= tLo; k--)
        if (opaque(k * fw + x)) {
          up = k;
          break;
        }
      for (let k = y + 1; k <= cHi; k++)
        if (opaque(k * fw + x)) {
          dn = k;
          break;
        }
      const from = up < 0 ? dn : dn < 0 ? up : y - up <= dn - y ? up : dn;
      if (from >= 0) copyRGB(i, from * fw + x);
    }
  }
  if (empty.length) {
    const isEmpty = new Set(empty);
    for (const x of empty) {
      let srcX = -1;
      let best = Infinity;
      for (let c = 0; c < fw; c++) {
        if (isEmpty.has(c)) continue;
        const d = Math.abs(c - x);
        if (d < best) {
          best = d;
          srcX = c;
        }
      }
      if (srcX < 0) continue;
      for (let y = 0; y < fh; y++) {
        const di = (y * fw + x) * 4;
        const si = (y * fw + srcX) * 4;
        out.data[di] = out.data[si];
        out.data[di + 1] = out.data[si + 1];
        out.data[di + 2] = out.data[si + 2];
      }
    }
  }
  for (let i = 0; i < fw * fh; i++) {
    if (libWall[i]) {
      out.data[i * 4] = wallRGB[0];
      out.data[i * 4 + 1] = wallRGB[1];
      out.data[i * 4 + 2] = wallRGB[2];
    }
    if (sil[i] > 0) {
      out.data[i * 4 + 3] = 255;
    } else {
      out.data[i * 4] = 0;
      out.data[i * 4 + 1] = 0;
      out.data[i * 4 + 2] = 0;
      out.data[i * 4 + 3] = 0;
    }
  }
  return out;
}

/** A PLATE'S WALL BAND, REPAINTED IN ITS OWN SURFACE COLOUR.
 *
 *  The maintainer's dots measure EXACTLY (171,146,116) — light_beach's palette
 *  wall — on a (234,210,173) top, one texel wide, at diamond edges. That band
 *  sits directly under the edge and is ~25% darker than the surface, so it is
 *  what makes a one-texel error VISIBLE. It is never legitimately visible
 *  itself: a raised cell is `topOnly` and the band is masked off (the cap's
 *  x-over-y art is the wall); at level 0 nothing exists below, `exposed` is
 *  provably false, and the band is overdraw the tiles in front cover (32 rows
 *  against a 14-row lattice step). So its colour is free.
 *
 *  696adf092d did this for CONFORM plates only and his next screenshot still
 *  measured that colour — the rest come from CLEAN plates, whose band is the
 *  art file's own pixels. Hence a raster-level repaint, which reaches both. */
export function capWallToSurface(sheets: PatternSheets, src: Pixels): Pixels {
  const { fw, fh, libTop, libWall } = sheets;
  const a = src.w === fw && src.h === fh ? src : cropToArt(src, fw, fh);
  const out = newPixels(fw, fh);
  out.data.set(a.data);
  for (let x = 0; x < fw; x++) {
    let bottom = -1;
    for (let y = 0; y < fh; y++) if (libTop[y * fw + x]) bottom = y;
    if (bottom < 0) continue;
    const from = bottom * fw + x;
    if (a.data[from * 4 + 3] === 0) continue;
    for (let y = 0; y < fh; y++) {
      const i2 = y * fw + x;
      if (!libWall[i2] || a.data[i2 * 4 + 3] === 0) continue;
      for (let c = 0; c < 4; c++) out.data[i2 * 4 + c] = a.data[from * 4 + c];
    }
  }
  return out;
}

/** render3's `top_face_only`: the surface's TOP FACE alone, the wall band
 *  dropped so the cell's own x-over-y wall shows through — and on a liquid, so
 *  that nothing shows there at all. THE WALL IS NEVER THE SURFACE'S.
 *
 *  Measured on the_game's water plates: the band is 1088 px against a 924 px
 *  top face, RGB(76,138,152) against (126,183,199) — more than half of every
 *  tile, and darker than the water it sits under. Painting it tiled a dark
 *  lattice across the whole sea and left a hard line along the shore, where the
 *  last band has no cell in front of it to cover it up.
 *
 *  Zeroed, not cropped: the result keeps 64x46 plate geometry so it pastes at
 *  the offset every other surface does. */
export function topFaceOnly(sheets: PatternSheets, src: Pixels, opts?: { margin?: boolean }): Pixels {
  const { fw, fh, libTop } = sheets;
  const a = cropToArt(src, fw, fh);
  const out = newPixels(fw, fh);
  for (let i = 0; i < fw * fh; i++) {
    if (!libTop[i]) continue;
    out.data[i * 4] = a.data[i * 4];
    out.data[i * 4 + 1] = a.data[i * 4 + 1];
    out.data[i * 4 + 2] = a.data[i * 4 + 2];
    out.data[i * 4 + 3] = a.data[i * 4 + 3];
  }
  /* ONE ROW OF MARGIN, REPLICATED FROM THE SURFACE — never the wall band.
   *
   * A top face is the 29-row diamond and the ground lays tiles at dy=14, so two
   * neighbours interlock with an overlap of EXACTLY ONE ROW. Every other ground
   * keeps its whole 46-row plate — wall included — and overlaps by seventeen;
   * a tiles2 world's tile art is 64 px tall and overlaps by forty-nine, which
   * is why the old maps never had a seam to get wrong at all (maintainer
   * 2026-09-03, the_island2 beside the_game: "0 zigzag. it just works"). A
   * top-face-only plate is the ONLY thing in the game with zero slack, and at a
   * one-row interlock any single missing row is a line of whatever lies behind
   * the sea. That is the class, and it is why only liquids still show it.
   *
   * So each column carries ONE more row, and it is a COPY OF THAT COLUMN'S OWN
   * BOTTOM SURFACE PIXEL. Copying the art's next row instead — the plate's wall
   * band — is what put 76 wall texels per plate back onto the sea: (76,138,152)
   * against a (126,183,199) top face, i.e. the dark dotted line itself, and the
   * maintainer's device measured 146 px of exactly that colour along the tile
   * edges with ZERO background texels in the same sample. Replicating the
   * surface cannot do that in either direction: where the tile in front covers
   * the row it is invisible, and where nothing covers it the sea is one pixel
   * deeper. `topFaceOnly` therefore still carries no wall pixel anywhere —
   * pinned by its gate, which the wall-copying version failed. */
  if (opts?.margin === false) return out;
  for (let x = 0; x < fw; x++) {
    let bottom = -1;
    for (let y = 0; y < fh; y++) if (libTop[y * fw + x]) bottom = y;
    if (bottom < 0 || bottom + 1 >= fh) continue;
    const from = bottom * fw + x;
    if (out.data[from * 4 + 3] === 0) continue;
    const to = (bottom + 1) * fw + x;
    for (let c = 0; c < 4; c++) out.data[to * 4 + c] = out.data[from * 4 + c];
  }
  return out;
}

/** A liquid's flat-colour diamond — render3's `flat_tile` for the four liquid
 *  grounds, which never show a wall. 64x64 with the diamond hung from TOP_Y, so
 *  it pastes at the same offset a review tile does.
 *
 *  THE MASK IS THE SHEETS' OWN TOP FACE, never a formula. The hand-derived
 *  `trunc(DX * (1 - |y-DY| / DY))` diamond does NOT TILE: its half-widths step
 *  32,30,28,25,... (32/14 per row, truncated) and its first row is empty, so a
 *  field of them laid on the iso step leaks a regular diagonal lattice of
 *  single pixels along every edge — 30 per tile, 252 px per 100x100 of sea
 *  (2.5%), each showing the dark page ground through. That is the maintainer's
 *  "zigzag pattern at the tile edge on all water tiles" (2026-09-03).
 *
 *  And it is the SEA'S ORDINARY PATH, not a fallback: `water` ships
 *  `base_tiles: []` with no `tiles/base_candidates/water` set, so `surface()`
 *  can never resolve a plate for a water cell and every one of them paints this
 *  diamond. `sheets.libTop` is the same top-face mask every real plate wears —
 *  29 rows that OVERLAP their neighbours by one, hence gapless by construction
 *  (measured: 0 holes, against 30 for the formula). Its widest row lands on
 *  TOP_Y + DY exactly where the formula's did, so the water does not move. */
export function liquidDiamond(rgb: readonly [number, number, number], sheets: PatternSheets): Pixels {
  const { fw, fh, libTop } = sheets;
  const out = newPixels(TILE, TILE);
  for (let y = 0; y < fh; y++) {
    const dy = TOP_Y + y;
    if (dy >= TILE) break;
    for (let x = 0; x < fw && x < TILE; x++) {
      if (!libTop[y * fw + x]) continue;
      const i = (dy * TILE + x) * 4;
      out.data[i] = rgb[0];
      out.data[i + 1] = rgb[1];
      out.data[i + 2] = rgb[2];
      out.data[i + 3] = 255;
    }
  }
  return out;
}

/* -- keys ------------------------------------------------------------------- */

/** Texture key for a repo-relative art file. THE SAME `t2:<path>` NAMESPACE the
 *  world@1/world@2 renderer already uses (client/src/maps.ts `pathTileKey`),
 *  deliberately: a tiles3 plate and a tiles2 tile are both identified by their
 *  path, a path can never collide across the two, and every existing draw site
 *  that resolves a texture by path keeps working with no branch on schema.
 *  Kept as its own function rather than an import so this module stays free of
 *  the DOM-typed graph maps.ts pulls in — the two definitions are one line and
 *  the parity is asserted in the gate. */
export function artKey(path: string): string {
  return "t2:" + path;
}

/** Repo-relative path -> served URL. `/assets/<path>` is what the game image
 *  publishes; `gameUrl` (staging.ts) rewrites it to the CDN for a staged world
 *  and `withV` pins it to the build sha. Both are injected rather than imported
 *  for the same reason `artKey` is inlined; `windowArtLoads` takes them and
 *  WorldScene passes the real pair. */
export function assetPath(path: string): string {
  return "/assets/" + path.replace(/^\/+/, "");
}

/** Any resolved surface that names a file: a `PlateArt`, or the non-liquid arm
 *  of a `FieldArt`. A liquid is painted and never comes through here. */
export interface PlateLike {
  kind: string;
  path: string;
  /** render3's `top_face_only` — paint the top face, drop the wall band. Set on
   *  a liquid, whose surface never shows a wall. Part of the plate's CONTENT,
   *  so it is in the key: a masked raster and the full tile are two different
   *  pictures behind one path, and sharing a key between them is exactly the
   *  cache bug that served whole wrong tiles in render3 (`never key a cache on
   *  id()`). */
  topOnly?: boolean;
}

/** THE CONTENT IDENTITY OF ONE PLATE — what actually went into its pixels, and
 *  therefore what a composed texture's key must carry. A published plate or a
 *  clean plate is fully identified by its path; a CONFORMED plate is identified
 *  by its path AND its ground, because the ground supplies the wall colour and
 *  the same art conformed for two grounds is two different rasters. */
export function plateSourceId(art: PlateLike, ground: string): string {
  const id = art.kind === "conform" ? `c:${ground}:${art.path}` : `p:${art.path}`;
  return art.topOnly ? `t:${id}` : id;
}

/** Where a plate's DRAWABLE texture lands. A published/clean plate is drawn
 *  straight from its loaded file, so it keeps the plain art key and is never
 *  copied; a conformed plate is a derived raster and gets its own. */
export function plateKey(art: PlateLike, ground: string): string {
  const base = art.kind === "conform" ? `t3c:${ground}|${art.path}` : artKey(art.path);
  return art.topOnly ? `t3f:${base}` : base;
}

/** The composed boundary's key: mask frame + both plate identities + the pass.
 *  NOT THE CELL. Measured on the_game: 6,266 boundaries share 2,248
 *  compositions (2.79x), and a 64x64-cell streaming window's 192 share 123
 *  (1.56x) — a per-cell key would rasterise every one of them from scratch, and
 *  a cell coordinate in a key is the cache bug this repo does not survive.
 *
 *  SIDES ARE NOT SORTED HERE. `Tiles3Boundary` already carries them in the
 *  library's canonical `side_order`, so which ground is side_b is decided
 *  upstream; sorting the key would let two callers agree on a key while drawing
 *  the boundary opposite ways round. */
export function boundaryKey(
  frame: number,
  idA: string,
  idB: string,
  seam = true,
  topOnly = false,
  noWall = false,
): string {
  /* `topOnly` IS PART OF THE KEY, because it is part of the PICTURE: a raised
   * boundary is masked to its 924-texel top face and a level-0 one carries the
   * full 2012-texel silhouette. Same frame, same plates, two different rasters
   * — so they must never share a key. (Cache safety is absolute here: two
   * pictures under one name is the one bug this repo does not survive.)
   *
   * `noWall` rides for the same reason and no other: it adds the margin row, so
   * a top-face-only raster with it is 988 texels and one without is 924. Two
   * pictures, two names. */
  return `t3x:${frame}|${idA}|${idB}${seam ? "" : "|noseam"}${topOnly ? "|top" : ""}${noWall ? "|m" : ""}`;
}

/** A painted liquid diamond, keyed by the colour that IS its content. */
export function liquidKey(rgb: readonly [number, number, number]): string {
  return `t3l:${rgb[0]},${rgb[1]},${rgb[2]}`;
}

/** The boundary key for a resolved boundary, or null when the pattern library
 *  has no frame for it (`maskFrame` null — an unpublished pattern). A caller
 *  that gets null draws nothing there and the two flats meet hard, which is the
 *  pre-3.0 look, not a hole. */
export function boundaryKeyFor(b: Tiles3Boundary, seam = true): string | null {
  if (b.maskFrame === null) return null;
  return boundaryKey(
    b.maskFrame,
    plateSourceId(b.plateA, b.a),
    plateSourceId(b.plateB, b.b),
    seam,
    !!b.topOnly,
    !!b.noWall,
  );
}

/* -- the load list ---------------------------------------------------------- */

/** One art file to load, and the key it must land under. */
export interface Tiles3Load {
  /** Texture key — `artKey(path)`. */
  key: string;
  /** Repo-relative path, for diagnostics and for the atlas index. */
  path: string;
  /** The URL to fetch, already routed through staging + the version pin. */
  url: string;
}

export interface UrlRoute {
  /** staging.ts `gameUrl` — identity for every normal player, the CDN base for
   *  a staged world. */
  gameUrl?: (url: string) => string;
  /** assetver.ts `withV` — the deploy sha pin. */
  withV?: (url: string) => string;
}

const routeUrl = (path: string, r?: UrlRoute): string => {
  const g = r?.gameUrl ?? ((u: string) => u);
  const v = r?.withV ?? ((u: string) => u);
  return v(g(assetPath(path)));
};

/** EVERY ART FILE A WINDOW OF CELLS NEEDS, and the key each lands under —
 *  the whole load list for a streaming renderer, deduplicated.
 *
 *  It includes the SOURCE art of a `conform` plate (the conformed raster is
 *  derived from it at build time, so the file itself must be resident) and the
 *  source plates of every boundary. It does NOT include the three pattern
 *  sheets: those are world-independent and load once at boot — see
 *  `patternSheetLoads`. A liquid cell contributes nothing; its diamond is
 *  painted, not fetched. */
export function windowArtLoads(win: Tiles3Window, route?: UrlRoute): Tiles3Load[] {
  const out = new Map<string, Tiles3Load>();
  const add = (path: string | undefined | null) => {
    if (!path || out.has(path)) return;
    out.set(path, { key: artKey(path), path, url: routeUrl(path, route) });
  };
  for (const c of win.cells) {
    if (c.art && c.art.kind !== "liquid") add(c.art.path);
    if (c.wall) for (const s of c.wall.stack) add(s.tile.path);
  }
  for (const b of win.boundaries) {
    add(b.plateA.path);
    add(b.plateB.path);
  }
  for (const d of win.decks) for (const s of d.stack) add(s.tile.path);
  return [...out.values()];
}

/** The pattern library's three sheets, which every composed boundary needs and
 *  no world varies. Load once at boot, before the first boundary composes. */
export function patternSheetLoads(doc: PatternsDoc, route?: UrlRoute): Tiles3Load[] {
  const p = patternSheetPaths(doc);
  return [p.silhouette, p.masks, p.border].map((path) => ({
    key: artKey(path),
    path,
    url: routeUrl(path, route),
  }));
}

/* -- draw operations -------------------------------------------------------- */

/** One blit. `sx/sy/sw/sh` is the SOURCE crop — a fade is the top
 *  `TOP_Y + 2*DY + 2` rows of a 64x64 file and nothing below — and `x/y` is the
 *  destination in the frame's own pixel space (`Frame.canvas`), which a
 *  streaming renderer offsets by its own window origin. */
export interface Tiles3Blit {
  key: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** What produced this op — for the depth sort, the occluder pass and QA. */
  role: "surface" | "wall" | "boundary" | "deck" | "fade";
}

/** The ops for one resolved cell, in render3's own order: a field cell is ONE
 *  op; a wall cell is its stack, lowest exposed storey first and the cap last,
 *  so the courses build a solid block under the top. A liquid's diamond is a
 *  painted texture keyed by its colour (`liquidKey`), which is why nothing
 *  downstream needs a special case for it. */
export function cellOps(cell: Tiles3Cell): Tiles3Blit[] {
  if (cell.kind === "field") {
    const art = cell.art;
    if (!art) return [];
    const key = art.kind === "liquid" ? liquidKey(art.topRGB) : plateKey(art, cell.ground);
    const ops: Tiles3Blit[] = [
      { key, x: cell.sx, y: cell.pasteY ?? cell.sy, sx: 0, sy: 0, sw: art.w, sh: art.h, role: "surface" },
    ];
    /* ...AND THE FADE'S SCATTER ON TOP OF IT. A fade no longer replaces the
     * plate (see the resolver): it paints only the texels that are not the
     * field's own colour, so the cell keeps its member art and the fade tile
     * has no rim to outline the diamond with. */
    if (cell.fade) {
      ops.push({
        key: fadeKey(cell.fade.file, cell.ground),
        x: cell.sx,
        y: cell.pasteY ?? cell.sy,
        sx: 0,
        sy: 0,
        sw: TILE,
        sh: PLATE_H,
        role: "fade",
      });
    }
    return ops;
  }
  const w = cell.wall;
  if (!w) return [];
  const ops = w.stack.map((s) => tileBlit(s.tile, cell.sx, s.y, "wall"));
  /* AND THE SURFACE GOES ON THE CAP. `cell.dressed` is the resolver saying the
   * over-tile does NOT own its top face, so the maintainer's own set surface
   * belongs on it — which is how a raised cell gets a fade, a slope or a
   * boundary at all. It was a DEAD FLAG: set at tiles3.ts:1691 and read
   * nowhere, so every exposed raised cell drew its wall stack and threw the
   * resolved surface away. Measured over the_game: 3,670 wall cells, ALL 3,670
   * flagged `dressed`, and 288 resolved fades (14.1% of every fade in the
   * world) discarded with them — which is the maintainer's "the transition/fade
   * also doesn't work on levels other than the first 0-level".
   *
   * It goes at the cell's own top vertex, exactly where a field cell's surface
   * goes, and it is `topOnly` (the resolver set that at the same line), so it
   * is masked to the library top face and cannot paint a wall band over the
   * cap's own x-over-y art. */
  if (cell.dressed && cell.art && cell.art.kind !== "liquid") {
    const art = cell.art;
    ops.push({
      key: plateKey(art, cell.ground),
      x: cell.sx,
      y: cell.pasteY ?? cell.sy,
      sx: 0,
      sy: 0,
      sw: art.w,
      sh: art.h,
      role: "surface",
    });
    /* ...and its fade too, for the same reason a field cell gets one: the cap
     * wears the maintainer's set, so it wears the scatter that eases into the
     * next ground. 88 cliff-edge fades were resolved and never drawn without
     * this. */
    if (cell.fade) {
      ops.push({
        key: fadeKey(cell.fade.file, cell.ground),
        x: cell.sx,
        y: cell.pasteY ?? cell.sy,
        sx: 0,
        sy: 0,
        sw: TILE,
        sh: PLATE_H,
        role: "fade",
      });
    }
  }
  return ops;
}

/** A deck's slab: same-over-same courses down to its underside, cap on top. */
export function deckOps(d: Tiles3DeckCell): Tiles3Blit[] {
  return d.stack.map((s) => tileBlit(s.tile, d.sx, s.y, "deck"));
}

/** The composed boundary, on the corner lattice over the flats. Null when the
 *  pattern is unpublished — see `boundaryKeyFor`. */
export function boundaryOp(b: Tiles3Boundary, seam = true): Tiles3Blit | null {
  const key = boundaryKeyFor(b, seam);
  if (!key) return null;
  return { key, x: b.sx, y: b.sy, sx: 0, sy: 0, sw: b.w, sh: b.h, role: "boundary" };
}

function tileBlit(t: TileArt, x: number, y: number, role: Tiles3Blit["role"]): Tiles3Blit {
  /* A wall or deck course that names no file is a painted liquid diamond — the
   * resolver's `flat_tile` for a liquid ground, which always carries `topRGB`.
   * The grey is render3's own fallback for a ground with neither a palette top
   * nor a base colour, and reaching it means ground_types is incomplete. */
  const key = t.path ? artKey(t.path) : liquidKey(t.topRGB ?? [128, 128, 128]);
  return { key, x, y, sx: 0, sy: 0, sw: t.w, sh: t.h, role };
}

/** THE WHOLE WINDOW in render3's pass order: every cell (already painter-sorted
 *  back to front by the resolver), then the boundaries on the lattice above
 *  them, then the decks. Scenery is not terrain and is not here.
 *
 *  This is the convenience path for an atlas build or a gate. A STREAMING
 *  renderer should call `cellOps` per cell instead: this allocates one array
 *  per cell and the whole-world sweep behind it is ~1s (measured, 512x512),
 *  which is fine for a bake and not for a frame. */
export function windowOps(win: Tiles3Window, seam = true): Tiles3Blit[] {
  const out: Tiles3Blit[] = [];
  for (const c of win.cells) for (const op of cellOps(c)) out.push(op);
  for (const b of win.boundaries) {
    const op = boundaryOp(b, seam);
    if (op) out.push(op);
  }
  for (const d of win.decks) for (const op of deckOps(d)) out.push(op);
  return out;
}

/* -- the texture factory ---------------------------------------------------- */

/** Phaser's `Textures.FilterMode.NEAREST`, which is **1** — `LINEAR` is 0, so a
 *  plausible-looking 0 here silently sets the exact filter this constant exists
 *  to avoid (phaser/src/textures/const.js; the gate re-reads that file rather
 *  than trusting this line). Inlined rather than imported so the module stays
 *  Phaser-free and node-provable.
 *
 *  IT MUST BE SET EXPLICITLY ON EVERY CANVAS TEXTURE. `addCanvas` does NOT
 *  inherit the game's `pixelArt` setting the way a loaded image does, and
 *  LINEAR smears pixel art into a soft halo at any fractional camera zoom. This
 *  repo has paid for that twice — see `ringTextureFor` and `initCoverSurfaces`
 *  in WorldScene.ts, both of which carry the same note. */
export const NEAREST = 1;

export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}
export interface Ctx2DLike {
  createImageData(w: number, h: number): ImageDataLike;
  putImageData(d: ImageDataLike, x: number, y: number): void;
  getImageData(x: number, y: number, w: number, h: number): ImageDataLike;
  drawImage(src: unknown, dx: number, dy: number): void;
}
/** Structurally satisfied by `HTMLCanvasElement`. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(id: "2d", opts?: unknown): Ctx2DLike | null;
}
/** Structurally satisfied by `Phaser.Textures.TextureManager`. */
export interface TextureManagerLike {
  exists(key: string): boolean;
  get(key: string): { getSourceImage(): unknown } | undefined;
  addCanvas(key: string, source: CanvasLike): { setFilter(mode: number): unknown } | null;
  /** REGISTER A COMPOSITION FROM RAW BYTES — no canvas, no readback.
   *
   * Wired only under WebGL (Phaser's `addUint8Array` is WebGL-only), which is
   * why it is optional and why the canvas path below is kept: the tests and any
   * canvas fallback still go through it. Measured cost of the canvas path per
   * composed texture, and it is 91-97% of a composition on his phone: a new
   * <canvas> element, a 2D context, createImageData + putImageData, and then
   * Phaser's `addCanvas` builds a CanvasTexture which immediately does a full
   * `getImageData` READBACK of the canvas it was just handed and retains that
   * ImageData for the texture's life (CanvasTexture.js:86,118) — a GPU->CPU
   * round trip per composition, on a context created without
   * `willReadFrequently`, and three retained copies of every raster (canvas +
   * ImageData + GPU) against a deliberately unbounded cache that reached 7,867
   * textures in his beacon. `addUint8Array` uploads the bytes once and keeps
   * one. Filtering is not a risk: `createUint8ArrayTexture` hardcodes
   * gl.NEAREST for both min and mag (WebGLRenderer.js), which is the pixel-art
   * rule this repo enforces everywhere. */
  addRaw?(key: string, data: Uint8Array, w: number, h: number): unknown | null;
  remove(key: string): unknown;
}

export interface Tiles3TexturesOpts {
  textures: TextureManagerLike;
  sheets: PatternSheets;
  /** `tiles/ground_types.json .grounds` — the palette wall colour a conformed
   *  plate fills with. */
  groundTypes: Record<string, { palette?: { wall?: string; top?: string }; base_color?: string }>;
  /** Defaults to `document.createElement("canvas")`. Injected so the whole
   *  factory is provable under node. */
  canvas?: (w: number, h: number) => CanvasLike;
  /** Draw render3's literal two-line boundary instead of the library's seamed
   *  one. For a pixel diff against render3 only — see `composeBoundary`. */
  seam?: boolean;
  /** Cap on live COMPOSED textures (boundaries + conformed plates + diamonds);
   *  0 or absent means unbounded. Eviction is least-recently-used and is safe
   *  ONLY because every key is content-derived: a rebuilt key is byte-identical
   *  to the one dropped. Measured on the_game so a cap can be chosen honestly:
   *  a 64x64-cell window peaks at 405 distinct compositions, a 96x96 one at
   *  831, and the whole 512x512 world holds 2,248 — at 64x46 RGBA (11,776 B a
   *  tile) that is 4.5 MB, 9.3 MB and 25.2 MB of canvas.
   *
   *  THE TRAP: eviction calls `textures.remove`, which pulls the texture out
   *  from under any Sprite still pointing at it. Safe for a renderer that blits
   *  into a RenderTexture and drops the reference; NOT safe while a live
   *  GameObject holds the key. Leave it unbounded unless you know which. */
  limit?: number;
}

export interface Tiles3TexturesStats {
  /** Compositions actually rasterised. */
  built: number;
  /** Milliseconds spent building (composing + uploading) — the streaming stall. */
  buildMs: number;
  /** Requests served by an already-registered texture. */
  reused: number;
  /** Live composed textures right now. */
  live: number;
  /** Textures dropped by the LRU. */
  evicted: number;
  /** Requests that could not build because a source texture was not loaded. */
  missing: number;
  /** Of `built`, the ones that were composed BOUNDARIES. Measured on the_game:
   *  a fresh ground window around the spawn needs 128-287 distinct boundary
   *  compositions and only 5-9 plate ones, so this is very nearly all of it. */
  builtBoundary: number;
  /** Boundary compositions REFUSED because the frame's compose budget was
   *  spent. Each one draws its plain plate instead and is repainted by
   *  `t3retryBoundaries` when a later frame's budget affords it. */
  deferred: number;
}

/**
 * THE COMPOSED-TEXTURE FACTORY. Give it a key's inputs; it returns the key,
 * having built and registered the texture the first time and done nothing every
 * time after. It holds no scene, no camera and no world — only its own cache —
 * so the same instance serves the streaming renderer, the occluder pass and an
 * atlas bake.
 */
export class Tiles3Textures {
  readonly stats: Tiles3TexturesStats = { built: 0, buildMs: 0, reused: 0, live: 0, evicted: 0, missing: 0, builtBoundary: 0, deferred: 0 };
  /** Ops `opsForCell` DROPPED because their texture was not registered. It has
   *  always dropped them silently; nothing counted it, so "a tile simply never
   *  drew" was invisible to every probe. The maintainer's artefact is bare
   *  ground fill INSIDE the painted field on a FULL paint (build 4a02b7a24,
   *  legacy path — no scroll, band, landing repaint or prefetch runs), and with
   *  a 32-row overlap between neighbours the only way to expose the background
   *  is an op that never drew. This counts them. */
  droppedOps = 0;
  /** DIAGNOSTIC: paint a MAGENTA diamond where an op was dropped instead of
   *  leaving the background showing (the maintainer's own idea, sharpened —
   *  "clear the screen with pink before we draw, then we know if the pixels are
   *  still pink"). A zigzag that turns magenta IS dropped ops; one that stays
   *  dark is something else and this whole line of enquiry is wrong. Off by
   *  default; Settings -> "dropped ops". */
  debugDrops = false;

  private o: Tiles3TexturesOpts;
  /** key -> nothing; a Map because insertion order IS the LRU order. */
  /* THE COMPOSE BUDGET — what stops a fresh window from freezing the game.
   *
   * A composition costs 6.0-9.6 ms on the maintainer's phone (measured off his
   * beacon: composeMs/composed over the 20 worst frames; games2/CLAUDE.md's
   * "2-4 ms on a phone" was optimistic by 2-4x). The ground pass composed every
   * boundary a window needed SYNCHRONOUSLY, so his worst frames read
   * redrawGround 1244 ms / 113 compositions and groundSlice 770 ms / 87 — a
   * freeze of over a second, and the single largest thing in the whole report.
   * It is worst exactly where he plays: measured over 100 windows of the_game,
   * a window needs 15 distinct boundary compositions at the map's median but
   * 128-287 around the spawn (441,364).
   *
   * So the pass gets a wall-clock allowance per frame. A composition already
   * under way always finishes — this bounds how many START, not how long one
   * takes — so the allowance is deliberately SMALLER than one composition:
   * spending it means his phone starts exactly one per frame while this
   * machine, where a composition is ~0.45 ms, starts a dozen. The budget tunes
   * itself to the device instead of encoding one.
   *
   * ONLY BOUNDARIES ARE REFUSED, because only they have a correct fallback: a
   * cell whose transition is not composed yet draws THE PLAIN PLATE it would
   * otherwise replace — the pre-3.0 look, two grounds meeting hard, and never
   * a hole (the same answer this path already gives while a source plate is
   * still streaming). A refused PLATE would leave the cell with no art at all,
   * so plates are never budgeted; they are 5-9 per window and cached for the
   * session, so they cost nothing to leave alone. */
  private composeBudgetMs = Infinity;
  private composeSpent = 0;

  private mine = new Map<string, true>();
  private pix = new Map<string, Pixels | null>();

  constructor(opts: Tiles3TexturesOpts) {
    this.o = opts;
  }

  /** The composed boundary for one resolved boundary, registered and keyed.
   *  Null when the pattern has no frame or a source plate has not loaded — the
   *  caller draws no boundary there and the flats meet hard, which is the
   *  pre-3.0 look and never a hole. */
  boundary(b: Tiles3Boundary): string | null {
    const key = boundaryKeyFor(b, this.o.seam !== false);
    if (!key) return null;
    // THE BUDGET, and the ONE place it is enforced. An already-composed key is
    // free and is always answered — refusing a cache hit would make the ground
    // flicker between plate and transition as the camera moved.
    if (this.composeSpent >= this.composeBudgetMs && !this.o.textures.exists(key)) {
      this.stats.deferred++;
      return null;
    }
    const before = this.stats.built;
    const out = this.ensure(key, () => {
      const a = this.platePixels(b.plateA, b.a);
      const bb = this.platePixels(b.plateB, b.b);
      if (!a || !bb) return null;
      const out = composeBoundary(this.o.sheets, b.maskFrame as number, a, bb, { seam: this.o.seam !== false });
      /* A COMPOSED BOUNDARY IS TOP FACE ONLY, ALWAYS — and this is the
       * maintainer's zigzag on the beach (2026-09-03).
       *
       * A boundary is a SURFACE blend on the corner lattice and has no lawful
       * wall source at any level: at a raised level the cap's own x-over-y art
       * is the wall (which is why the resolver already sets `topOnly` there),
       * and at level 0 there is no wall and nothing below to hide. But the flag
       * was DEAD on this path — nothing here read it and `boundaryKeyFor` never
       * carried it — so every boundary in the game painted its whole 46-row
       * plate, wall band included.
       *
       * That is fatal here and nowhere else, because of PAINTER ORDER: cells,
       * then boundaries, then decks. A cell's own wall band is harmless — the
       * cells in front are painted after it and cover it (measured: 0 texels
       * uncovered). A boundary is painted AFTER every cell, so its wall band
       * lands on top of the very tiles that would have hidden it, and only a
       * LATER BOUNDARY can cover it. Boundaries exist only where the Wang index
       * is mixed, so along a transition band most of that wall band is covered
       * by nothing at all — a partial, dotted chevron rather than a solid
       * course, which is exactly the "zag zag zag" he photographed.
       *
       * MEASURED on his own cell (458.9,378.8 of the_game, every cell level 0):
       * all 112 boundaries in the window keep the band; a real
       * light_beach<->grass composition is 1088/1088 OPAQUE wall texels of
       * which 800 are exactly (171,146,116) — light_beach's palette wall. On
       * his screenshot the dots measure 0.750/0.747/0.779 of the sand beside
       * them, and light_beach wall/top is 0.7500/0.7449/0.7785. Divide out the
       * evening light and they are (171,146,116) on (228,196,149). His words
       * were exact: "it's the edge right before the wall begins."
       *
       * NO MARGIN ROW here, unlike a liquid's: a boundary paints last, over a
       * cell that has already painted its own top AND wall, so there is no hole
       * to fill and one extra row would only bleed the blend a pixel into the
       * tile in front.
       *
       * WHY NO OTHER SURFACE SHOWS THIS: open water composes no boundary at all
       * ("NO LIQUID may touch the quad — a coast is a hard edge"), which is why
       * the sea's zigzag was a different defect (its own zero-slack top-face
       * interlock, fixed in 55f1d43b) and why fixing it left the beach alone;
       * and a tiles2 world has no composed boundaries whatsoever, which is why
       * the_island2 has never shown it ("0 zigzag. it just works").
       *
       * The key needs no new input: it is a runtime Phaser texture key that
       * never names a file (`boundaryArtPaths` names the SOURCES, which do not
       * move), so one key still maps to one picture and no cache can hold a
       * stale one. */
      /* A LEVEL-0 TRANSITION TILE KEEPS ITS WALL BAND — and its absence was the
       * maintainer's zigzag, proven by his own test (2026-09-04).
       *
       * The draw loop takes ONE of the two, never both:
       *     if (bop && cell.kind === "field") <transition tile> else <plate>
       * so a masked boundary paints 924 texels where the plate it replaces
       * paints 2012. Those 1088 texels are painted by NOTHING, and the "0
       * texels uncovered" coverage measurement does not hold for them because
       * it was taken with every cell painting a full plate. He asked for a
       * magenta ground clear; with it on, his screenshot carries 396 magenta
       * pixels in 76 chains, 195 runs of exactly 2 screen px — one texel at
       * zoom 2 — on diamond-edge slopes. The zigzag was never a dark tile. It
       * was bare ground. His words: "as if the transition tiles doesn't have a
       * wall. Ofc they must have a wall."
       *
       * WHY IT WAS MASKED, and why that is no longer the trade: boundaries used
       * to be a SEPARATE PASS drawn after every cell, so their wall band landed
       * on top of the very tiles that would have hidden it and showed as a dark
       * course. They are drawn WITH their cell now, in the same painter order
       * as a plate, so the cells in front cover this band exactly as they cover
       * a plate's. `capWallToSurface` then makes the trade free: the band is
       * repainted from each column's own bottom top-face texel, so even a texel
       * that does peek is the surface's own colour and cannot read as a course.
       *
       * A RAISED boundary stays masked: there the cap's own x-over-y art IS the
       * wall, which is what `topOnly` has always meant here. The two are
       * different pictures, so `boundaryKey` carries the flag. */
      /* THE MARGIN ROW GOES ON EXACTLY WHAT HAS NOTHING UNDER IT. A liquid on
       * the flat draws no wall column, so its composed tile is the one raster
       * with zero slack at the dy=14 interlock and it carries the replicated
       * row the surface plate has always carried — without it the shallow sea
       * one row up shows through as a dotted line along every diamond edge,
       * which is what he photographed swimming over the deep-water rim. A
       * raised cap keeps `margin: false`: its own wall column is drawn beneath
       * and the extra row would paint surface over the course. */
      return b.topOnly
        ? topFaceOnly(this.o.sheets, out, { margin: !!b.noWall })
        : capWallToSurface(this.o.sheets, out);
    });
    if (this.stats.built !== before) this.stats.builtBoundary++;
    return out;
  }

  /** Hand a finished raster to the texture manager. Raw bytes where the
   *  renderer allows it (see `addRaw`); a canvas otherwise. */
  private registerRaster(key: string, px: Pixels): boolean {
    const tm = this.o.textures;
    if (tm.addRaw) {
      // A ZERO-COPY VIEW: Phaser tests `source instanceof Uint8Array`, and a
      // Uint8ClampedArray is not one, so the view is required — but it shares
      // the same buffer and copies nothing.
      const u8 =
        px.data instanceof Uint8Array
          ? px.data
          : new Uint8Array(px.data.buffer, px.data.byteOffset, px.data.byteLength);
      if (tm.addRaw(key, u8, px.w, px.h)) return true;
      // Fall through: a rejected key or a renderer that could not take it is
      // better served by the canvas than by a missing tile.
    }
    const cv = (this.o.canvas ?? domCanvas)(px.w, px.h);
    cv.width = px.w;
    cv.height = px.h;
    const ctx = cv.getContext("2d");
    if (!ctx) return false;
    const id = ctx.createImageData(px.w, px.h);
    id.data.set(px.data);
    ctx.putImageData(id, 0, 0);
    tm.addCanvas(key, cv)?.setFilter(NEAREST);
    return true;
  }

  /** Arm this frame's compose allowance (see `composeBudgetMs`). `Infinity`
   *  composes without limit — what the join paint runs under, behind the
   *  loading screen, so the first world he sees is whole. */
  armCompose(ms: number): void {
    this.composeBudgetMs = ms;
    this.composeSpent = 0;
  }

  /** The drawable texture key for a resolved plate: the plain art key for a
   *  published or clean plate (nothing is built), the conformed raster's own
   *  key otherwise. */
  plate(art: PlateLike, ground: string): string | null {
    const key = plateKey(art, ground);
    /* A published or clean plate is drawn straight from its loaded file and is
     * never copied — UNLESS it is top-only, which is a different picture and so
     * a built raster under its own key. */
    if (art.kind !== "conform" && !art.topOnly) {
      /* THE CAPPED RASTER IF IT CAN BE BUILT, THE RAW FILE IF IT CANNOT.
       * cc2b41c975 forced the build and returned null when the pixel readback
       * failed — which dropped the op and put TILE-SIZED black holes across the
       * whole map. The fallback makes this strictly no worse than drawing the
       * file: worst case is exactly today's picture. */
      const capped = this.ensure(`t3s:${key}`, () => this.platePixels(art, ground));
      if (capped) return capped;
      return this.o.textures.exists(key) ? key : null;
    }
    return this.ensure(key, () => this.platePixels(art, ground));
  }

  /** THE FADE SCATTER for one file on one ground, built once and cached. Null
   *  while the fade art has not decoded — the cell then draws its plain plate,
   *  which is the pre-fade look and never a hole. */
  fade(path: string, ground: string): string | null {
    const key = fadeKey(path, ground);
    return this.ensure(key, () => {
      const src = this.sourcePixels(artKey(path));
      if (!src) return null;
      return fadeOverlay(this.o.sheets, src, this.topRGB(ground), this.wallRGB(ground));
    });
  }

  /** A liquid's painted diamond. */
  liquid(rgb: readonly [number, number, number]): string {
    const key = liquidKey(rgb);
    return this.ensure(key, () => liquidDiamond(rgb, this.o.sheets)) ?? key;
  }

  /** THE STREAMING ENTRY POINT: one cell in, DRAWABLE blits out. Every op it
   *  returns has a registered texture — a composed one built on the spot, a
   *  plain one already loaded — so the renderer draws the list as it stands and
   *  never has to test a key. An op whose art has not loaded is DROPPED rather
   *  than substituted: a hole this frame is a hole, and the next window fills
   *  it; a fallback tile is a wrong picture that nothing ever corrects. */
  opsForCell(cell: Tiles3Cell): Tiles3Blit[] {
    const out: Tiles3Blit[] = [];
    for (const op of cellOps(cell)) {
      /* THE SURFACE OP CARRIES THE ART, whatever the cell's kind — a raised
       * cell's cap wears one too (see cellOps). Keyed off the ROLE, not the
       * kind, or a wall cell's surface would take the raw-file branch and skip
       * the conform/top-face path its `topOnly` art requires. */
      /* A FADE OP BUILDS ITS OVERLAY — the scatter with the field texels
       * transparent. Dropped like any other op if its art has not landed. */
      if (op.role === "fade") {
        const f = cell.fade;
        const built = f ? this.fade(f.file, cell.ground) : null;
        if (built) out.push(op.key === built ? op : { ...op, key: built });
        else this.droppedOps++;
        continue;
      }
      const art = op.role === "surface" ? cell.art : undefined;
      let key: string | null;
      /* A LIQUID NEVER SHOWS A WALL — enforced HERE, not trusted from a flag.
       *
       * The last branch draws the art's RAW key, wall band and all, and it is
       * reached whenever `topOnly` is not set. The resolver does set it for a
       * liquid, but the maintainer's device says something gets through: his
       * ground texture carries 146 px of (76,138,152) — `water`'s palette WALL
       * colour, against a top face of (126,183,199) — laid along the tile edges
       * as the dotted zigzag he has been reporting all day, with ZERO
       * background-coloured texels in the same sample. So it was never a hole;
       * it is a water tile's own wall, drawn where it should have been masked.
       * (His readings also cleared the alternatives: `nonInt` 0 — no op on a
       * fractional texel — and no `t3c:water` conform texture and no composed
       * boundary exists to have painted it.)
       *
       * The rule is already stated three times in this file and in the
       * resolver; a ground in LIQUID_TILE_GROUNDS now takes the top-face path
       * whatever its art says, so no future resolver change can leak a wall
       * onto the sea again. */
      const liquidGround = LIQUID_TILE_GROUNDS.includes(cell.ground);
      if (art && art.kind === "liquid") key = this.liquid(art.topRGB);
      else if (art && (art.kind === "conform" || art.topOnly || liquidGround))
        // a CONFORM repaints its own wall band and must keep it (see plateKey's
        // note); only a liquid ground is forced onto the top-face path.
        key = this.plate(liquidGround ? { ...art, topOnly: true } : art, cell.ground);
      /* EVERY FIELD ART GOES THROUGH `plate()`, INCLUDING A PUBLISHED OR CLEAN
       * ONE — and this is the LAND zigzag (2026-09-04).
       *
       * This branch used to draw `op.key`, the raw file, for any field art that
       * was not conform, not topOnly and not a liquid ground. That is exactly a
       * level-0 published or clean plate, and it meant `capWallToSurface` —
       * written to neutralise the wall band, and applied inside `platePixels`
       * — NEVER RAN ON THE CELLS IT WAS WRITTEN FOR. Measured on
       * tiles/plates/light_beach/clean.webp: the raw file carries 1088 texels
       * of exactly (171,146,116), light_beach's palette wall; the capped raster
       * carries 0.
       *
       * A level-0 cell has nothing below it, so its wall band is never
       * legitimate art — it is only ever the ~25%-darker course that makes a
       * one-texel coverage error VISIBLE. The cell in front covers almost all
       * of it, so what shows is a short broken run along a diamond edge, which
       * is what the maintainer photographed: measured off his screenshot at
       * 442.2,382.2, 633 texels of exactly (171,146,116) in 116 chevrons, every
       * one 2 screen px tall at camera zoom 2 — one texel — on diamond-edge
       * slopes repeating every 64 px, which is DX at that zoom.
       *
       * The branch condition IS his localisation, which is how it was found: a
       * raised cell is `topOnly` and takes the masked path, a liquid takes the
       * liquid path, and he reports the artefact 100% absent on both and
       * present only on level-0 land. A tiles2 world has no such plate at all,
       * which is why the_island2 never showed it.
       *
       * `plate()` keeps its own fallback to the raw file when the readback
       * fails, so this cannot reintroduce the tile-sized black holes of
       * cc2b41c975: worst case is exactly the old picture. A WALL cell keeps
       * the raw path — `art` is undefined there, and a wall course must draw
       * its own art. */
      else if (art) key = this.plate(art, cell.ground);
      else key = this.o.textures.exists(op.key) ? op.key : null;
      if (!key) {
        this.droppedOps++;
        // ...and, while the switch is on, draw the hole instead of leaving it.
        if (this.debugDrops) key = this.liquid([255, 0, 255]);
      }
      if (key) out.push(key === op.key ? op : { ...op, key });
    }
    return out;
  }

  /** A flat diamond in PLATE geometry (fw x fh, `libTop` at its own rows) —
   *  NOT `liquidDiamond`, which builds TILE x TILE with the diamond hung at
   *  TOP_Y. Drawn at a plate's own y those two are ten rows apart, and the
   *  first cut of the underlay used the liquid one: every grass cell's backing
   *  poked out below its plate and into the beach, which the maintainer
   *  measured as (20,82,59) — grass's palette top — specks inside the sand.
   *  Same geometry as the art it backs, or it is not a backing. */
  private flatPlate(rgb: readonly [number, number, number]): string {
    const key = `t3u:${rgb[0]},${rgb[1]},${rgb[2]}`;
    return (
      this.ensure(key, () => {
        const { fw, fh, sil } = this.o.sheets;
        const out = newPixels(fw, fh);
        for (let i = 0; i < fw * fh; i++) {
          /* THE WHOLE SILHOUETTE, not just the top face. The underlay is
           * insurance against a hole, and a hole is any texel of the plate's
           * 2,012-texel footprint that nothing paints — his magenta ground
           * clear found 144 of them in one frame, in runs of exactly one texel
           * on diamond-edge slopes. Filling only `libTop` (924) left the other
           * 1,088 uninsurable. It is drawn FIRST and only when nothing else
           * covers the cell, so the extra rows are either painted over by the
           * cell in front or are the hole they exist to fill. */
          if (!sil[i]) continue;
          out.data[i * 4] = rgb[0];
          out.data[i * 4 + 1] = rgb[1];
          out.data[i * 4 + 2] = rgb[2];
          out.data[i * 4 + 3] = 255;
        }
        return out;
      }) ?? key
    );
  }

  /** A FLAT DIAMOND OF THE CELL'S OWN GROUND COLOUR, to draw UNDER its art.
   *
   *  Insurance against a hole. Whatever fails to draw above it — a dropped op,
   *  a cell the pass never issued, a one-texel seam nobody has explained — then
   *  exposes the ground's own colour instead of the render texture's
   *  background, which is what the maintainer photographs as a dotted dark line
   *  along tile edges. It cannot change a correct pixel: the art above is
   *  opaque across its whole silhouette.
   *
   *  Uses the liquid diamond, which is already a cached flat diamond per RGB
   *  and exactly the right shape (a plate's own top-face mask). */
  groundUnderlay(cell: Tiles3Cell): Tiles3Blit | null {
    const g = this.o.groundTypes[cell.ground];
    const hex = g?.palette?.top ?? g?.base_color;
    if (!hex) return null;
    const key = this.flatPlate(hexRGB(hex));
    return { key, x: cell.sx, y: cell.pasteY ?? cell.sy, sx: 0, sy: 0, sw: TILE, sh: PLATE_H, role: "surface" };
  }

  /** The composed boundary as a drawable blit, or null. */
  opsForBoundary(b: Tiles3Boundary): Tiles3Blit | null {
    const op = boundaryOp(b, this.o.seam !== false);
    if (!op) return null;
    return this.boundary(b) ? op : null;
  }

  /** A deck's slab. Its courses are plain x-over-x art; nothing composes. */
  opsForDeck(d: Tiles3DeckCell): Tiles3Blit[] {
    return deckOps(d).filter((op) => this.o.textures.exists(op.key));
  }

  /** Drop every composed texture whose key is not in `keep`. The owner calls
   *  this between streaming windows, when it knows no GameObject holds one. */
  evictExcept(keep: Set<string>): number {
    let n = 0;
    for (const key of [...this.mine.keys()]) {
      if (keep.has(key)) continue;
      this.drop(key);
      n++;
    }
    return n;
  }

  /** Forget cached source pixels (not the textures). Call when the art behind a
   *  key is replaced — a live base_tile_sets push, an atlas swap. */
  clearSources(): void {
    this.pix.clear();
  }

  private ensure(key: string, build: () => Pixels | null): string | null {
    if (this.o.textures.exists(key)) {
      if (this.mine.has(key)) {
        this.mine.delete(key);
        this.mine.set(key, true); // LRU touch
      }
      this.stats.reused++;
      return key;
    }
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    const px = build();
    if (!px) {
      this.stats.missing++;
      return null;
    }
    if (!this.registerRaster(key, px)) {
      this.stats.missing++;
      return null;
    }
    this.mine.set(key, true);
    this.stats.built++;
    const ms = typeof performance !== "undefined" ? performance.now() - t0 : 0;
    this.stats.buildMs += ms;
    // Plate compositions spend the budget too — they are part of the same
    // frame — they are just never refused by it.
    this.composeSpent += ms;
    this.stats.live = this.mine.size;
    const limit = this.o.limit ?? 0;
    if (limit > 0) {
      while (this.mine.size > limit) {
        const oldest = this.mine.keys().next().value as string | undefined;
        if (oldest === undefined || oldest === key) break;
        this.drop(oldest);
      }
    }
    return key;
  }

  private drop(key: string): void {
    this.mine.delete(key);
    this.o.textures.remove(key);
    this.stats.evicted++;
    this.stats.live = this.mine.size;
  }

  /** A resolved plate as pixels, conforming when the resolver asked for it.
   *
   *  A NULL IS NEVER CACHED. Null means "the art is not resident YET", and a
   *  streaming renderer asks again the moment the batch lands — caching it
   *  would make every plate that missed its first frame miss forever, and the
   *  boundaries built from it would be permanently absent from the map with no
   *  error anywhere. Only real pixels are memoised. */
  private platePixels(art: PlateLike, ground: string): Pixels | null {
    const key = plateKey(art, ground);
    const hit = this.pix.get(key);
    if (hit) return hit;
    let out: Pixels | null = null;
    if (art.kind === "conform") {
      const src = this.sourcePixels(artKey(art.path));
      out = src ? conformPlate(this.o.sheets, src, this.wallRGB(ground)) : null;
    } else {
      out = this.sourcePixels(artKey(art.path));
    }
    /* LAST, over the conformed raster too: conforming REPAINTS the wall band
     * from the ground palette, so masking first would hand it back. */
    /* CAP FIRST, THEN MASK — and the order is the whole point.
     *
     * `topFaceOnly` keeps ONE MARGIN ROW past the library top face, so a
     * raised surface that skipped the cap shipped one row of its art's REAL
     * wall band: a 1-texel dark line along the lower diamond edges, on every
     * raised cell. Measured off his screenshot at 439.5,364.5, the line runs
     * 0.784/0.700/0.599 of the sand beside it, against light_soil's palette
     * wall over its top at 0.781/0.702/0.595 — the same colour to a rounding
     * step, in 340 runs of exactly 2 screen px, which is one texel at zoom 2.
     *
     * It went unnoticed while only a handful of cells took this path. Making a
     * cliff edge wear its surface put 3,670 more cells on it, and the line
     * came back with them. Capping first repaints that band from each column's
     * own bottom top-face texel, so the margin row is the SURFACE's colour and
     * cannot read as a course whatever the mask keeps. */
    if (out && art.topOnly) out = topFaceOnly(this.o.sheets, capWallToSurface(this.o.sheets, out));
    else if (out) out = capWallToSurface(this.o.sheets, out);
    if (out) this.pix.set(key, out);
    return out;
  }

  /** Decoded pixels behind a loaded texture. A texture whose source is already
   *  a canvas (every atlas-sliced tile is) is read from its own context; an
   *  <img> is drawn into a scratch canvas first. */
  private sourcePixels(key: string): Pixels | null {
    const hit = this.pix.get(key);
    if (hit) return hit; // see platePixels: a null is "not loaded yet", never a cache entry
    let out: Pixels | null = null;
    const src = this.o.textures.get(key)?.getSourceImage() as
      | (CanvasLike & { naturalWidth?: number; naturalHeight?: number })
      | undefined;
    if (src) {
      const w = src.naturalWidth || src.width;
      const h = src.naturalHeight || src.height;
      if (w > 0 && h > 0) {
        let ctx: Ctx2DLike | null = typeof src.getContext === "function" ? src.getContext("2d") : null;
        if (!ctx) {
          const cv = (this.o.canvas ?? domCanvas)(w, h);
          cv.width = w;
          cv.height = h;
          ctx = cv.getContext("2d");
          ctx?.drawImage(src, 0, 0);
        }
        const id = ctx?.getImageData(0, 0, w, h);
        if (id) out = { w, h, data: new Uint8ClampedArray(id.data) };
      }
    }
    if (out) this.pix.set(key, out);
    return out;
  }

  /** THE COLOUR A CONFORMED PLATE PAINTS ITS WALL BAND — the ground's own TOP,
   *  not its wall. This is the maintainer's zigzag fix, and it is his own
   *  instruction: "make sure the tile in front covers it… why do you have to
   *  make it so exact?" — answered by making exactness stop mattering.
   *
   *  A conformed plate's wall band is NEVER legitimately visible. At a raised
   *  level the cell is `topOnly`, so the band is masked off entirely and the
   *  cap's own x-over-y art is the wall. At level 0 nothing exists below, so
   *  `exposed` is provably false and the band is pure overdraw the tiles in
   *  front cover (measured: 32 rows of overlap against a 14-row lattice step,
   *  0 uncovered texels). Its colour is therefore FREE — and it was the one
   *  thing that made a one-row leak VISIBLE, because it sits directly under the
   *  diamond's lower edge and is 25% darker than the surface. Measured on his
   *  screen: the dots are exactly (171,146,116) on (228,196,149) — light_beach's
   *  palette wall on its top.
   *
   *  Painting the band in the TOP colour makes any leak the ground's own colour,
   *  i.e. invisible, whatever caused it — a placement slip, a late tile, a cull,
   *  a crop. Nine hours went into finding which of those it is; this stops
   *  needing to know. Free by construction: no new texture keys, no extra
   *  compositions (a conform is already a built raster), and nothing that is
   *  ever drawn changes colour.
   *
   *  IF THE BAND EVER BECOMES VISIBLE — a renderer that draws a flat cell's wall
   *  — this must go back to `palette.wall` and the leak fixed properly. */
  private wallRGB(ground: string): [number, number, number] {
    const g = this.o.groundTypes[ground];
    return hexRGB(g?.palette?.top ?? g?.palette?.wall ?? g?.base_color ?? "#808080");
  }

  /** THE GROUND'S OWN TOP COLOUR — what a fade tile paints everywhere its
   *  scatter is not, and therefore what `fadeOverlay` makes transparent. */
  private topRGB(ground: string): [number, number, number] {
    const g = this.o.groundTypes[ground];
    return hexRGB(g?.palette?.top ?? g?.base_color ?? "#808080");
  }
}

function domCanvas(w: number, h: number): CanvasLike {
  const d = (globalThis as { document?: { createElement(tag: string): CanvasLike } }).document;
  if (!d) throw new Error("tiles3draw: no document — pass a canvas factory");
  const c = d.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
