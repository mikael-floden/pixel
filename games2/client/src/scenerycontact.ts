/* SCENERY CONTACT — the ambient occlusion where a piece's ART meets the ground
 * (maintainer 2026-09-17, six marked screenshots: beds' feet, a table's LEGS
 * only, a barrel's base, a fireplace's base line, lamp posts, rocks' whole
 * base, cart wheels, a scarecrow's pole, a maypole's base — "a scenery object
 * placed in the world doesn't look like it actually touches the ground").
 *
 * HIS RECIPE (2026-09-18, the hearth house at 304.3,232.9, red = the blobs
 * this replaced, green = the wanted line: "You have the hitbox and you have
 * the texture. Just offset the texture and remove the pixels that overlap
 * with texture. Remove pixels not touching the ground (study the hitbox for
 * perspective). Smooth/blur the remaining pixels and make them dark. Render
 * pixel perfect."), step for step:
 *  1. THE BAND: the art's silhouette dropped CONTACT_DROP texels, minus every
 *     texel the art itself covers — a thin line hugging the bottom of every
 *     edge of the drawing that faces the ground.
 *  2. THE GROUND: a band texel is kept only inside the piece's FOOTPRINT — the
 *     collision hitbox as the collision stamp and the lit copy read it (its
 *     screen ellipse, a margin out) — a table's top, a lamp's head and a
 *     tree's canopy hang far up-screen of the footprint and drop out; the
 *     legs, the pole and the trunk stay.
 *  3. THE BLUR: a small separable blur (wider along x — the ground is
 *     foreshortened), run AFTER the art's texels were removed, so the soft
 *     edge climbs one texel onto the art's own base as well as onto the floor
 *     (his: "ambient occlusion is visible both on the object and on the
 *     world/env when the object is in contact").
 *  4. DARK: the band's core at CONTACT_PEAK coverage; his dial (uContactAo)
 *     scales it in the night pass.
 *  5. PIXEL PERFECT: the stamp is the crop's own texel grid (one stamp texel
 *     per art texel, drawn at the art's scale into a FULL-resolution contact
 *     field — nightlight.ts; the glow field's half resolution smeared it).
 * Before (v3): soft ellipses along an iso ground line derived from the
 * silhouette alone — 6..18 px wide, a cell out from the art: "way off and too
 * big" (his red circles).
 *
 * RENDERED INTO THE LIGHT FIELD (nightlight.ts: a world-anchored render
 * texture beside the glow field, sampled by the night pass and multiplied
 * into every light term of a GROUND pixel AT THE PIECE'S FLOOR HEIGHT — a
 * roof drawn over the furniture is a level or more above it and takes
 * nothing). No sprite of its own, so no z-order rule of its own: the field
 * lies under every lit copy exactly as every other shadow does (his rule:
 * "This should render into the shadow we already have and don't add new/more
 * complexity").
 *
 * CACHE LAW: one raster per (art, crop, footprint) under a content key with a
 * version tag, never rewritten; two placements of one crop share one stamp.
 * Pure (no Phaser): server/test/scenerycontact.test.ts runs it headless. */
import type { ShapePixels } from "./scenerylight";

export const CONTACT_VERSION = 4;
/** Alpha a texel needs to count as art. */
const CONTACT_ALPHA_MIN = 48;
/** The band: the silhouette dropped this many texels (art texels, so it is
 *  the same thickness at every draw scale — "just slightly under the real
 *  texture"). */
export const CONTACT_DROP = 2;
/** Coverage at the band's core: dark, never black (maintainer 2026-09-18:
 *  "The idea is to make the floor darker, but not black!"); his dial
 *  multiplies it (0.5 by default). */
export const CONTACT_PEAK = 0.9;
/** The blur taps, x then y (normalised in use). */
const BLUR_X = [1, 2, 3, 2, 1];
const BLUR_Y = [1, 2, 1];
/** The footprint's margin: the band lies just OUTSIDE the outline the hitbox
 *  was fitted to, so the ellipse grows by this share of each semi-axis, at
 *  least CONTACT_FOOT_MARGIN_MIN texels. */
const CONTACT_FOOT_MARGIN = 0.3;
const CONTACT_FOOT_MARGIN_MIN = 3;
/** The iso ground line's rise per column away from the piece's lowest texel:
 *  the 2:1 grid's base edge (a box's front corner is its lowest point and its
 *  base edges climb half a texel per texel). */
export const CONTACT_ISO_SLOPE = 0.5;
/** How far ABOVE that line a column's lowest art may sit and still be a base
 *  (texels). Tight on purpose: at 4 a table's four legs all pass (their
 *  bottoms measured 45, 48, 51 and 59 against a line giving 46, 48.5, 51, 59)
 *  and a bed's blanket edge, 6 above its line, does not. */
const CONTACT_LINE_TOL = 4;
/** ...and how far above the FOOTPRINT's own front edge, as a share of its
 *  semi-axis (at least CONTACT_EDGE_TOL_MIN). Both tests must pass: the line
 *  alone admits a wide piece's high outer edge (a hearth's mantel overhangs
 *  its own base by half its width, and at that distance the line has climbed
 *  past it), the footprint alone admits a bed's frame underside. */
const CONTACT_EDGE_TOL_FRAC = 0.5;
const CONTACT_EDGE_TOL_MIN = 4;

export interface ContactCut {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** The piece's footprint on screen, in TEXTURE px (the frame the crop is cut
 *  from, the pack offset already applied): the hitbox ellipse's centre and
 *  semi-axes as the collision stamp and the lit copy read them. A rect's box
 *  is taken by its semi-axes too (its diamond lies inside that ellipse; the
 *  margin covers a turned one). */
export interface ContactFoot {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface ContactStampData {
  w: number;
  /** The crop's height plus `pad` rows below it. */
  h: number;
  pad: number;
  data: Uint8Array;
  /** Per contact column, its lowest band texel (crop px: x from the crop's
   *  left, y from its top) — the probe's "where is the contact". */
  points: { x: number; y: number }[];
  /** The footline: the lowest opaque row of the crop, from its top. */
  footY: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function contactStampKey(artKey: string, cut: ContactCut, foot?: ContactFoot): string {
  const f = foot ? `:${r2(foot.cx)},${r2(foot.cy)},${r2(foot.rx)},${r2(foot.ry)}` : "";
  return `s3ct:${artKey}@v${CONTACT_VERSION}:${cut.sx},${cut.sy},${cut.sw},${cut.sh}${f}`;
}

/** The lowest opaque row per column of the crop, -1 where the column is empty. */
export function contactBottoms(px: ShapePixels, cut: ContactCut): Int32Array {
  const out = new Int32Array(cut.sw).fill(-1);
  const x1 = Math.min(px.w, cut.sx + cut.sw);
  const y1 = Math.min(px.h, cut.sy + cut.sh);
  for (let x = Math.max(0, cut.sx); x < x1; x++) {
    for (let y = y1 - 1; y >= Math.max(0, cut.sy); y--) {
      if (px.data[(y * px.w + x) * 4 + 3] >= CONTACT_ALPHA_MIN) {
        out[x - cut.sx] = y - cut.sy;
        break;
      }
    }
  }
  return out;
}

export function buildContactStamp(px: ShapePixels, cut: ContactCut, foot?: ContactFoot): ContactStampData | null {
  const w = cut.sw;
  const sh = cut.sh;
  if (w <= 0 || sh <= 0) return null;
  const pad = CONTACT_DROP + (BLUR_Y.length >> 1);
  const h = sh + pad;
  // 1. The art's silhouette in the crop.
  const art = new Uint8Array(w * sh);
  let footY = -1;
  for (let y = 0; y < sh; y++) {
    const ty = cut.sy + y;
    if (ty < 0 || ty >= px.h) continue;
    for (let x = 0; x < w; x++) {
      const tx = cut.sx + x;
      if (tx < 0 || tx >= px.w) continue;
      if (px.data[(ty * px.w + tx) * 4 + 3] >= CONTACT_ALPHA_MIN) {
        art[y * w + x] = 1;
        if (y > footY) footY = y;
      }
    }
  }
  if (footY < 0) return null;
  // 2. The footprint in crop px: the hitbox, or the crop's bottom centre.
  // A BOX THAT DOES NOT OVERLAP THIS CROP IS NO BOX. The published boxes are
  // hand-placed per piece and per facing and a consumer can hand over the
  // wrong space; either way the answer must be a contact shadow under the
  // piece, never no shadow at all. The crop's bottom centre is the same
  // fallback the lit copy uses when a piece has no published box.
  const inCrop = foot && foot.cx - cut.sx > -foot.rx && foot.cx - cut.sx < w + foot.rx;
  const f = foot && inCrop
    ? { cx: foot.cx - cut.sx, cy: foot.cy - cut.sy, rx: Math.max(1, foot.rx), ry: Math.max(1, foot.ry) }
    : { cx: w / 2, cy: footY + 0.5, rx: w / 2, ry: Math.max(2, w / 4) };
  const ex = f.rx + Math.max(CONTACT_FOOT_MARGIN_MIN, f.rx * CONTACT_FOOT_MARGIN);
  const ey = f.ry + Math.max(CONTACT_FOOT_MARGIN_MIN, f.ry * CONTACT_FOOT_MARGIN);
  const tolEdge = Math.max(CONTACT_EDGE_TOL_MIN, ey * CONTACT_EDGE_TOL_FRAC);
  // THE GROUND LINE: the iso V through the piece's own lowest texel, which is
  // what a box standing on a 2:1 grid draws — the front corner lowest, both
  // base edges climbing CONTACT_ISO_SLOPE per column. The HITBOX gives the
  // horizontal span (a canopy wider than its trunk is out), the LINE gives the
  // height, because the published boxes are hand-placed and their front edge
  // disagrees with the art by several texels either way: measured on
  // tables/table_009, the ellipse's edge rejected two of the four legs while
  // the line fits all four to within 1 texel.
  let xFoot = 0;
  {
    const at: number[] = [];
    for (let x = 0; x < w; x++) { let low = -1; for (let y = sh - 1; y >= 0; y--) if (art[y * w + x]) { low = y; break; } if (low === footY) at.push(x); }
    xFoot = at.length ? at[at.length >> 1] : w >> 1;
  }
  // THE BAND: for each column, the CONTACT_DROP texels straight below that
  // column's OWN lowest art texel — the silhouette's outer lower outline
  // dropped, with everything the art covers already gone (his step 1: "offset
  // the texture and remove the pixels that overlap with texture"). Testing
  // only the texel CONTACT_DROP below each art texel instead put a band under
  // every overhang whose column had a gap — a table's top between its legs, a
  // bed's blanket edge, a rail (measured on tables/table_009 and beds/bed_001,
  // 2026-09-18). A column's lowest art is the only place the piece can meet
  // the floor.
  // ...AND IT MUST BE AT THE FOOTPRINT'S FRONT EDGE (his step 2: "Remove
  // pixels not touching the ground (study the hitbox for perspective)"): the
  // hitbox is the ground the piece occupies, so its LOWER boundary is the
  // contact line in screen space. A lowest-art texel more than `tol` above
  // that boundary is an overhang whose column happens to hold nothing below
  // it (the far half of a table's top), and it takes no band.
  const band = new Float32Array(w * h);
  const points: { x: number; y: number }[] = [];
  for (let x = 0; x < w; x++) {
    let low = -1;
    for (let y = sh - 1; y >= 0; y--) if (art[y * w + x]) { low = y; break; }
    if (low < 0) continue;
    const dxn = (x + 0.5 - f.cx) / ex;
    if (Math.abs(dxn) > 1) continue;                    // outside the footprint's span
    const line = footY - CONTACT_ISO_SLOPE * Math.abs(x - xFoot); // the base's own V
    if (low + 0.5 < line - CONTACT_LINE_TOL) continue;  // above the base line
    // ...and not above the footprint's own CENTRE row. Measured against the
    // front edge instead, a box placed with its centre AT the art's base (the
    // wiki's alpha-placed automatic boxes can be) rejected the middle of its
    // own base line, so the piece lost its contact entirely. The centre is the
    // one part of the box that is always inside the ground it describes.
    if (low + 0.5 < f.cy - tolEdge) continue;
    for (let k = 1; k <= CONTACT_DROP; k++) {
      const y = low + k;
      if (y >= h) break;
      band[y * w + x] = 1;
    }
    points.push({ x, y: Math.min(h - 1, low + CONTACT_DROP) });
  }
  if (!points.length) return null;
  // 3. The blur, x then y, over the band AND the art's texels beside it.
  const tmp = new Float32Array(w * h);
  const hx = BLUR_X.length >> 1;
  const sx = BLUR_X.reduce((a, b) => a + b, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -hx; k <= hx; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        s += band[y * w + xx] * BLUR_X[k + hx];
      }
      tmp[y * w + x] = s / sx;
    }
  }
  const out = new Float32Array(w * h);
  const hy = BLUR_Y.length >> 1;
  const sy = BLUR_Y.reduce((a, b) => a + b, 0);
  // THE NORMALISER IS A SOLID BAND'S OWN RESPONSE, not this stamp's maximum:
  // dividing by the maximum made a long straight base and a single narrow leg
  // equally dark, and it made the SAME piece darker or lighter depending on
  // what else was in its crop. With the constant, a wide base reads full and a
  // thin leg reads lighter, which is what contact shadow does.
  let norm = 0;
  for (let k = -hy; k <= hy; k++) {
    const row = k >= -CONTACT_DROP + 1 && k <= 0 ? 1 : 0; // inside a DROP-thick band
    norm += row * BLUR_Y[k + hy];
  }
  norm = Math.max(1e-6, norm / sy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -hy; k <= hy; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        s += tmp[yy * w + x] * BLUR_Y[k + hy];
      }
      out[y * w + x] = Math.min(1, s / sy / norm);
    }
  }

  // 4. Dark: the core at CONTACT_PEAK. White RGB — the draw's tint carries the
  // floor height (nightlight.ts).
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = Math.round(255 * CONTACT_PEAK * out[i]);
    if (a <= 0) continue;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
    data[i * 4 + 3] = a;
  }
  return { w, h, pad, data, points, footY };
}
