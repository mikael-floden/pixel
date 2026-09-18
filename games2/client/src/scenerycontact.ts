/* SCENERY CONTACT — the ambient occlusion where a piece's ART meets the ground
 * (maintainer 2026-09-17, six marked screenshots: beds' feet, a table's LEGS
 * only, a barrel's base, a fireplace's base line, lamp posts, rocks' whole
 * base, cart wheels, a scarecrow's pole, a maypole's base — "a scenery object
 * placed in the world doesn't look like it actually touches the ground").
 *
 * WHAT TOUCHES THE GROUND IS THE SILHOUETTE'S BOTTOM ALONG THE ISO GROUND
 * LINE, not the hitbox: per column of the drawn crop, the lowest opaque row;
 * the footline is the lowest of those, and the ground line is the iso V
 * through the footline columns — it rises CONTACT_ISO_SLOPE px per column
 * away from them, the way a box's base edges recede on a 2:1 grid. A column
 * is in contact when its own bottom sits within a few px of that line. A
 * bed's or a cupboard's whole base V touches (before, 2026-09-18, only the
 * few columns within tolerance of the ONE lowest point did, and every box
 * wore a single blob at its front corner — his three red circles at
 * 305.9,227.6: "totally misplaced"); a table's top between its legs sits
 * half the sprite above the line — legs only; a rock, a barrel and a
 * fireplace are opaque all along their base — the whole base; a tree's
 * canopy is far above its trunk's line — trunk only. Every contact column
 * splats a soft ground-hugging blob at its bottom pixel; the stamp is a WHITE
 * RGBA raster with the blob coverage in alpha (white so the draw's tint can
 * carry the piece's floor height — see nightlight.ts), the crop's width, the
 * crop's height plus a pad below the footline so the blob reaches the ground
 * IN FRONT of the piece.
 *
 * RENDERED INTO THE LIGHT FIELD (nightlight.ts: a world-anchored render
 * texture beside the glow field, sampled by the night pass and multiplied
 * into every light term of a GROUND pixel AT THE PIECE'S FLOOR HEIGHT — a
 * roof drawn over the furniture is a level or more above it and takes
 * nothing; before, walking out of a house painted the beds' blobs onto the
 * roof). No sprite of its own, so no z-order rule of its own: the field lies
 * under every lit copy exactly as every other shadow does (his rule: "This
 * should render into the shadow we already have and don't add new/more
 * complexity").
 *
 * CACHE LAW: one raster per (art, crop) under a content key with a version
 * tag, never rewritten; two placements of one crop share one stamp. Pure (no
 * Phaser): server/test/scenerycontact.test.ts runs it headless. */
import type { ShapePixels } from "./scenerylight";

export const CONTACT_VERSION = 3;
/** Alpha a texel needs to count as art. */
const CONTACT_ALPHA_MIN = 48;
/** How far above the footline a column's bottom may sit and still touch,
 *  as a share of the crop's height (2..6 px): a bed's posts stand ~3-5 px
 *  below its frame at the shipped scales, a table's top ~half a sprite. */
const CONTACT_TOL_FRAC = 0.04;
/** How fast the iso ground line rises per column away from the footline
 *  columns: the 2:1 grid's base edge (a box's front corner is its lowest
 *  point and its sides climb half a px per px). */
export const CONTACT_ISO_SLOPE = 0.5;
/** A column within this many px of the footline is a footline column — the
 *  base's own jaggies, not a rise. */
const CONTACT_FOOT_JAG = 1;
/** The blob's horizontal radius as a share of the crop's height (6..18 px),
 *  squashed to CONTACT_SQUASH vertically — the ground is foreshortened.
 *  A SHADOW, NOT A DRAWN LINE: at 10% (5 px on a rock) the union of blobs
 *  was a thin band whose darkest pixels traced the base outline's every
 *  jaggy — in the light-only render it read as a hand-drawn squiggle under
 *  each rock (maintainer 2026-09-18: "It looks as if you took my drawings").
 *  Wider, with a flat core (CONTACT_CORE of the radius at full coverage) and
 *  the contact line smoothed over CONTACT_SMOOTH columns, it is one soft
 *  patch under the base. */
const CONTACT_R_FRAC = 0.16;
const CONTACT_SQUASH = 0.5;
const CONTACT_CORE = 0.35;
const CONTACT_SMOOTH = 2;
/** Coverage at the contact pixel itself: the floor under a piece is darker,
 *  never black (maintainer 2026-09-18: "The idea is to make the floor
 *  darker, but not black! If it was black we could have added it to the
 *  texture itself"). With his dial at 0.5 the darkest pixel is 0.5 * 0.7. */
const CONTACT_PEAK = 0.7;
/** A run of non-contact columns this short between two contact columns is
 *  base too — a hearth slab's step, a notch in a rock's outline (a gap in
 *  the line along a fireplace's base, his red mark at 331.8,233.6). */
const CONTACT_GAP_FRAC = 0.08;

export interface ContactCut {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface ContactStampData {
  w: number;
  /** The crop's height plus `pad` rows below the footline. */
  h: number;
  pad: number;
  data: Uint8Array;
  /** The contact points, in crop px (x from the crop's left, y from its top). */
  points: { x: number; y: number }[];
  /** The footline: the lowest opaque row of the crop, from its top. */
  footY: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function contactStampKey(artKey: string, cut: ContactCut): string {
  return `s3ct:${artKey}@v${CONTACT_VERSION}:${cut.sx},${cut.sy},${cut.sw},${cut.sh}`;
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

export function buildContactStamp(px: ShapePixels, cut: ContactCut): ContactStampData | null {
  const bottoms = contactBottoms(px, cut);
  let footY = -1;
  for (let i = 0; i < bottoms.length; i++) if (bottoms[i] > footY) footY = bottoms[i];
  if (footY < 0) return null;
  const tol = clamp(Math.round(cut.sh * CONTACT_TOL_FRAC), 2, 6);
  const r = clamp(Math.round(cut.sh * CONTACT_R_FRAC), 6, 18);
  const maxGap = clamp(Math.round(cut.sw * CONTACT_GAP_FRAC), 2, 8);
  const ry = Math.max(1, Math.round(r * CONTACT_SQUASH));
  const pad = ry * 2;
  const w = cut.sw;
  const h = cut.sh + pad;
  const data = new Uint8Array(w * h * 4);
  const points: { x: number; y: number }[] = [];
  // THE ISO GROUND LINE: the distance from each column to the nearest
  // footline column, swept left-to-right then right-to-left.
  const dist = new Float64Array(w).fill(Infinity);
  for (let x = 0, last = -Infinity; x < w; x++) {
    if (bottoms[x] >= footY - CONTACT_FOOT_JAG) last = x;
    dist[x] = x - last;
  }
  for (let x = w - 1, last = Infinity; x >= 0; x--) {
    if (bottoms[x] >= footY - CONTACT_FOOT_JAG) last = x;
    dist[x] = Math.min(dist[x], last - x);
  }
  const contactY = new Float64Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    const b = bottoms[x];
    if (b < 0 || b < footY - dist[x] * CONTACT_ISO_SLOPE - tol) continue;
    contactY[x] = b;
  }
  // Short gaps between contact columns are base too: bridged along the line
  // between their neighbours.
  for (let x = 1; x < w; x++) {
    if (contactY[x] >= 0 || contactY[x - 1] < 0) continue;
    let e = x;
    while (e < w && contactY[e] < 0) e++;
    if (e >= w || e - x > maxGap) { x = e; continue; }
    const y0 = contactY[x - 1], y1 = contactY[e];
    for (let g = x; g < e; g++) contactY[g] = y0 + ((y1 - y0) * (g - x + 1)) / (e - x + 1);
    x = e;
  }
  // The line is smoothed along the base (a mean over the contact columns
  // within CONTACT_SMOOTH), so the outline's own jaggies do not imprint.
  const lineY = new Float64Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    if (contactY[x] < 0) continue;
    let sum = 0, n = 0;
    for (let k = Math.max(0, x - CONTACT_SMOOTH); k <= Math.min(w - 1, x + CONTACT_SMOOTH); k++) {
      if (contactY[k] < 0) continue;
      sum += contactY[k];
      n++;
    }
    lineY[x] = sum / n;
  }
  for (let x = 0; x < w; x++) {
    if (lineY[x] < 0) continue;
    const b = Math.round(lineY[x]);
    points.push({ x, y: b });
    // A soft ellipse at the column's bottom: CONTACT_PEAK across the core,
    // gone at the rim, a smooth fall-off between.
    for (let yy = Math.max(0, b - ry); yy <= Math.min(h - 1, b + ry); yy++) {
      for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
        const dx = (xx - x) / (r + 0.5);
        const dy = (yy - b) / (ry + 0.5);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= 1) continue;
        const t = Math.min(1, (1 - d) / (1 - CONTACT_CORE));
        const a = Math.round(255 * CONTACT_PEAK * t * t * (3 - 2 * t));
        const i = (yy * w + xx) * 4;
        if (a > data[i + 3]) {
          data[i] = data[i + 1] = data[i + 2] = 255; // white: the draw tints it with the floor height
          data[i + 3] = a;
        }
      }
    }
  }
  if (!points.length) return null;
  return { w, h, pad, data, points, footY };
}
