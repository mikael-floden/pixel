/* SCENERY CONTACT — the ambient occlusion where a piece's ART meets the ground
 * (maintainer 2026-09-17, six marked screenshots: beds' feet, a table's LEGS
 * only, a barrel's base, a fireplace's base line, lamp posts, rocks' whole
 * base, cart wheels, a scarecrow's pole, a maypole's base — "a scenery object
 * placed in the world doesn't look like it actually touches the ground").
 *
 * WHAT TOUCHES THE GROUND IS THE SILHOUETTE'S BOTTOM, not the hitbox: per
 * column of the drawn crop, the lowest opaque row; the footline is the lowest
 * of those, and a column is in contact when its own bottom sits within a few
 * px of the footline. A table's legs reach the footline and the top's
 * underside between them sits half the sprite higher — legs only; a bed's
 * posts stand a few px below its frame — posts only; a rock, a barrel and a
 * fireplace are opaque all along their base — the whole base. Every contact
 * column splats a soft ground-hugging blob at its bottom pixel; the stamp is
 * a black RGBA raster with the blob coverage in alpha, the crop's width, the
 * crop's height plus a pad below the footline so the blob reaches the ground
 * IN FRONT of the piece.
 *
 * RENDERED INTO THE LIGHT FIELD (nightlight.ts: a world-anchored render
 * texture beside the glow field, sampled by the night pass and multiplied
 * into every light term of a GROUND pixel). No sprite of its own, so no
 * z-order rule of its own: the field lies under every lit copy exactly as
 * every other shadow does (his rule: "This should render into the shadow we
 * already have and don't add new/more complexity").
 *
 * CACHE LAW: one raster per (art, crop) under a content key with a version
 * tag, never rewritten; two placements of one crop share one stamp. Pure (no
 * Phaser): server/test/scenerycontact.test.ts runs it headless. */
import type { ShapePixels } from "./scenerylight";

export const CONTACT_VERSION = 1;
/** Alpha a texel needs to count as art. */
const CONTACT_ALPHA_MIN = 48;
/** How far above the footline a column's bottom may sit and still touch,
 *  as a share of the crop's height (2..6 px): a bed's posts stand ~3-5 px
 *  below its frame at the shipped scales, a table's top ~half a sprite. */
const CONTACT_TOL_FRAC = 0.04;
/** The blob's horizontal radius as a share of the crop's height (2..7 px),
 *  squashed to CONTACT_SQUASH vertically — the ground is foreshortened. */
const CONTACT_R_FRAC = 0.06;
const CONTACT_SQUASH = 0.55;

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
  const r = clamp(Math.round(cut.sh * CONTACT_R_FRAC), 2, 7);
  const ry = Math.max(1, Math.round(r * CONTACT_SQUASH));
  const pad = ry * 2;
  const w = cut.sw;
  const h = cut.sh + pad;
  const data = new Uint8Array(w * h * 4);
  const points: { x: number; y: number }[] = [];
  for (let x = 0; x < w; x++) {
    const b = bottoms[x];
    if (b < 0 || b < footY - tol) continue;
    points.push({ x, y: b });
    // A soft ellipse at the column's bottom: full at the centre, gone at the rim.
    for (let yy = Math.max(0, b - ry); yy <= Math.min(h - 1, b + ry); yy++) {
      for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
        const dx = (xx - x) / (r + 0.5);
        const dy = (yy - b) / (ry + 0.5);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= 1) continue;
        const t = 1 - d;
        const a = Math.round(255 * t * t * (3 - 2 * t));
        const i = (yy * w + xx) * 4 + 3;
        if (a > data[i]) data[i] = a;
      }
    }
  }
  if (!points.length) return null;
  return { w, h, pad, data, points, footY };
}
