// FOOT ANCHOR measurement, shared by the character and NPC manifest builders.
// Moved VERBATIM out of build-manifest.mjs (2026-08-06) when NPCs needed the
// same anchor: an NPC drawn on a guessed origin floats exactly the way the
// monsters did before their art-measured round. Byte-identical characters.json
// is the acceptance test for the move.
//
// NB: scripts/manifest.mjs must list this file in BUILDER_DEPS, or editing the
// measurement silently fails to invalidate the manifest cache — that exact
// hole is documented there and cost a round of wrong foot anchors once.
import { imgAlpha } from "./imagelib.mjs";

/** Lowest row of the figure with real mass (>=3 opaque px) — the ground line.
 * NOT the single lowest pixel: a 1-2px toe tip / anti-alias speck dragged the
 * old anchor below the soles, so characters read as hovering. */
export function soleOf(png) {
  const { w, h, opaque } = png;
  for (let y = h - 1; y >= 0; y--) {
    let n = 0;
    for (let x = 0; x < w && n < 3; x++) if (opaque(x, y)) n++;
    if (n >= 3) return y;
  }
  return -1;
}

/** 8-connected blobs of opaque pixels in the bottom `band` rows above `sole`
 * — the feet (plus whatever legs/hem dip into the band). Returns
 * {minX, maxX, maxY, size} per blob. */
export function bandBlobs(png, sole, band) {
  const { w, opaque } = png;
  const y0 = Math.max(0, sole - band + 1);
  const bandH = sole - y0 + 1;
  const label = new Int32Array(w * bandH).fill(-1);
  const blobs = [];
  for (let by = 0; by < bandH; by++)
    for (let x = 0; x < w; x++) {
      if (label[by * w + x] >= 0 || !opaque(x, y0 + by)) continue;
      const id = blobs.length;
      const blob = { minX: x, maxX: x, maxY: y0 + by, size: 0 };
      const stack = [[x, by]];
      label[by * w + x] = id;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        blob.size++;
        if (cx < blob.minX) blob.minX = cx;
        if (cx > blob.maxX) blob.maxX = cx;
        if (y0 + cy > blob.maxY) blob.maxY = y0 + cy;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= bandH) continue;
            if (label[ny * w + nx] >= 0 || !opaque(nx, y0 + ny)) continue;
            label[ny * w + nx] = id;
            stack.push([nx, ny]);
          }
      }
      blobs.push(blob);
    }
  return blobs;
}

export const blobCenter = (b) => (b.minX + b.maxX + 1) / 2; // pixel x spans [x, x+1)

/**
 * Measure the FOOT ANCHOR of a frame: the point BETWEEN the two feet at sole
 * level — where the character contacts the ground. The game pins this to the
 * collision position, so the drop-shadow (which marks the true world position)
 * sits centred between the drawn feet, and the feet meet edges/walls exactly.
 *
 * We look at a SOLE BAND (the bottom ~9% of the frame — tall enough to catch
 * BOTH feet even when a 3/4-view pose sets one sole a few px higher than the
 * other), collapse it to a per-column "is there a sole pixel here" mask, split
 * that into contiguous runs = the feet, and take the MIDPOINT BETWEEN the outer
 * two feet's centres. This is robust to unequal foot size and to a centred
 * ponytail/dress hem (a middle run never moves the outermost centres). The old
 * method — bounding-box midpoint of only the bottom 4 rows — saw just the lower
 * foot in angled poses and skewed the anchor up to ±5px sideways per direction,
 * so the shadow drifted out from between the feet as the character turned.
 */
export function footAnchor(framePath) {
  const png = imgAlpha(framePath);
  if (!png) return null;
  const { w, h, opaque } = png;
  let top = -1;
  for (let y = 0; y < h && top < 0; y++) {
    for (let x = 0; x < w; x++) {
      if (opaque(x, y)) {
        top = y;
        break;
      }
    }
  }
  const sole = soleOf(png);
  if (sole < 0) return null;
  // The anchor is the point BETWEEN the feet, per the maintainer's spec: each
  // foot counts as its geometric CENTER — the midpoint of its toe-to-heel
  // span, NOT the toes, NOT the heels, NOT a mass centroid (mass skews toward
  // the chunkier foot) — and the anchor is midway between the two feet.
  //
  // Feet are found as 2D connected blobs in the bottom band (~10px — tall
  // enough that a 3/4-view back foot drawn a few px higher by perspective is
  // still seen; column runs alone would merge staggered feet). A blob only
  // counts as a PLANTED foot if it reaches within 6px of the sole line —
  // side-view back legs whose foot hides behind the front foot are ignored.
  const band = Math.max(8, Math.round(h * 0.09)); // ≈10px at 112
  const planted = bandBlobs(png, sole, band)
    .filter((b) => b.size >= 4 && b.maxY >= sole - 6)
    .sort((a, b) => a.minX + a.maxX - (b.minX + b.maxX));
  if (!planted.length) return null;
  // Two (or more) planted blobs = the feet: outermost two centres (a middle
  // blob — a hem, a tail — never moves the anchor). One blob = feet touching
  // or overlapping; its own centre is already between them.
  const first = planted[0];
  const last = planted[planted.length - 1];
  const ax = (blobCenter(first) + blobCenter(last)) / 2;
  // Depth: each foot's own ground line (bottom edge), averaged — for a
  // staggered 3/4 stance the anchor sits between the front and back foot —
  // then lifted ~2.5px from the toe line to mid-foot (centre of the foot,
  // not the toes; the playtester's green dot).
  const ay = (first.maxY + last.maxY + 2) / 2 - h * 0.022;
  return {
    x: +(ax / w).toFixed(4),
    y: +(ay / h).toFixed(4),
    top: +(Math.max(0, top) / h).toFixed(4),
  };
}
