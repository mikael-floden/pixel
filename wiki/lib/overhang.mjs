// DID THE POSTPROCESS REPAINT THE OVERHANG?
//
// Maintainer 2026-08-22, painting on a screenshot of deep water over grass: "I
// have painted RED on the overhang that should be deep_water, but currently is
// green/grass. I also marked in purple what should be grass so you don't take
// too much."
//
// He had made the same report once before, on dark mud over slime, and the
// tiles agent's fix_left_wall.py quotes it: "The overhang should be brown, but
// the wall marked with blue should still be green." That fix PROTECTS the brim
// on the face it repairs — but it is one cell's repair, and nothing measures
// whether the brim survived anywhere else.
//
// The wiki's card had no way to show him the problem either. It printed
// "overhang 1.00", which is true and useless: `overhang` counts how much of
// the top SPILLED over the edge, and every one of those pixels spilled — they
// just ship in the wall's colour. The agent's own `clarity` is closer (it asks
// whether the fringe can be told apart from the wall at all) but it sits at a
// median of 0.35 across cross-material tiles, so it cannot separate "these two
// materials look alike" from "the postprocess took it".
//
// So this asks the one question his red line asks, by comparing the two passes
// the agent already publishes:
//
//   drawn = share of the brim that reads as the TOP material in the BEFORE
//   kept  = share of the same pixels that still do in the AFTER
//
// Both are measured against anchors taken from that tile's own pixels in that
// pass — the top face for "top", the wall well below the brim for "wall" — so
// nothing depends on a palette file or on the two passes sharing colours.
// A tile the generator never draped (low `drawn`) is not this measurement's
// business; the signal is drawn HIGH and kept LOW.
//
// Measured across 3,690 tiles in ~3s, which is why it runs on every build.
import { readFileSync, existsSync } from "node:fs";
import { decodeWebP } from "./webp-pixels.mjs";

const BAND = 6;          // fix_left_wall measured the real brim at 6 rows of 17
const DEEP_FROM = 8;     // wall anchor starts clear of the brim
const DEEP_TO = 18;
const rgbOf = (v) => [(v >> 16) & 255, (v >> 8) & 255, v & 255];
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** → { drawn, kept, band } in 0..1, or null when the tile cannot answer:
 *  no before pass, mismatched sizes, no flat top, too small a brim, or a
 *  same-material tile whose halves cannot be told apart. */
export function measureOverhang(root, artRel, rawRel) {
  if (!artRel || !rawRel) return null;
  if (!existsSync(root + artRel) || !existsSync(root + rawRel)) return null;
  let A, R;
  try {
    A = decodeWebP(readFileSync(root + artRel));
    R = decodeWebP(readFileSync(root + rawRel));
  } catch { return null; }
  if (!A || !R || A.w !== R.w || A.h !== R.h) return null;
  const opaqueA = (x, y) => (A.pix[y * A.w + x] >>> 24) >= 200;
  const opaqueR = (x, y) => (R.pix[y * R.w + x] >>> 24) >= 200;
  // the flat top colour the postprocess settled on
  const counts = new Map(); let opaque = 0;
  for (let i = 0; i < A.pix.length; i++) {
    if ((A.pix[i] >>> 24) < 200) continue; opaque++;
    const k = A.pix[i] & 0xffffff; counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] / opaque < 0.15) return null;
  const clean = top[0];
  // Per column: the contiguous top-face run from the crown, then the brim just
  // under it and a wall sample well below it.
  const band = [], deep = [], face = [];
  for (let x = 0; x < A.w; x++) {
    let y = 0;
    while (y < A.h && !opaqueA(x, y)) y++;
    let run = -1;
    for (; y < A.h && opaqueA(x, y) && (A.pix[y * A.w + x] & 0xffffff) === clean; y++) run = y;
    if (run < 0) continue;
    for (let k = 1; k <= BAND && run + k < A.h; k++) {
      if (opaqueA(x, run + k) && opaqueR(x, run + k)) band.push([x, run + k]);
    }
    for (let k = DEEP_FROM; k <= DEEP_TO && run + k < A.h; k++) {
      if (opaqueA(x, run + k) && opaqueR(x, run + k)) deep.push([x, run + k]);
    }
    for (let yy = 0; yy <= run; yy++) if (opaqueA(x, yy)) face.push([x, yy]);
  }
  if (band.length < 20 || deep.length < 20 || face.length < 20) return null;
  const meanOf = (list, IMG) => {
    const s = [0, 0, 0];
    for (const [x, y] of list) {
      const c = rgbOf(IMG.pix[y * IMG.w + x]);
      s[0] += c[0]; s[1] += c[1]; s[2] += c[2];
    }
    return [s[0] / list.length, s[1] / list.length, s[2] / list.length];
  };
  const rTop = meanOf(face, R), rWall = meanOf(deep, R);
  const aTop = meanOf(face, A), aWall = meanOf(deep, A);
  // The two halves have to be distinguishable in BOTH passes, or "reads as the
  // top material" means nothing. Same-over-same tiles land here and drop out.
  if (dist2(rTop, rWall) < 300 || dist2(aTop, aWall) < 300) return null;
  let drawn = 0, kept = 0;
  for (const [x, y] of band) {
    const r = rgbOf(R.pix[y * R.w + x]);
    const a = rgbOf(A.pix[y * A.w + x]);
    if (dist2(r, rTop) < dist2(r, rWall)) drawn++;
    if (dist2(a, aTop) < dist2(a, aWall)) kept++;
  }
  return { drawn: drawn / band.length, kept: kept / band.length, band: band.length };
}
