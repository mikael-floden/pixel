// ONE TILE'S TOP FACE ON ANOTHER TILE'S WALL.
//
// The wiki's "On top of" page reviews WALLS: a cell named "X over Y" is top
// material X above a Y wall, and every verdict on that page is about the wall.
// Since the maintainer started configuring each ground's surface as a BASE TILE
// SET (wiki/lib/basesets.mjs, 2026-08-25) the top baked into a review tile is
// no longer the top the game will draw there, so the card has to show the
// reviewed wall under the ground he actually configured. That means: keep the
// review tile's silhouette and wall exactly, and replace its top face with the
// top face of a base tile he picked.
//
// THE GEOMETRY IS THE PIPELINE'S, NOT A FORMULA OF OUR OWN.
// tiles/pipeline/transition_render.py top_face(): per COLUMN, the top face is
// every opaque row from the topmost down to (bottommost - WALL_D + 1). Taken
// from the tile's own silhouette, never from a rhombus equation — the equation
// was a pixel short at every extreme and counted a genuine ring of top face as
// wall.
//
// Pixels are 0xAARRGGBB in a Uint32Array, the format wiki/lib/webp-pixels.mjs
// decodes to. Nothing is imported: the function is the unit the wiki, the gate
// and any future caller share.

/* The wall is a vertical extrusion of constant depth. (17 rows under every
 * column of a 64x46 tile — measured in transition_render.py, and the published
 * iso block in tiles/review/manifest.json carries the same wall_px: 17, so the
 * pipeline and the manifest agree and neither needs to be guessed.) */
export const WALL_D = 17;

/* Per column, the first and last opaque row; -1 for an empty column. Opaque is
 * alpha > 0, the same test top_face() applies. (Measured: 0 partial-alpha
 * pixels across all 5,838 review tiles and all 356 base candidates, so there is
 * no threshold to tune.) */
export function columnSpans({ w, h, pix }) {
  const top = new Int32Array(w).fill(-1);
  const bot = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++)
      if (pix[y * w + x] >>> 24) { if (top[x] < 0) top[x] = y; bot[x] = y; }
  return { top, bot };
}

/* ALIGN ON THE FOOT OF THE WALL, NOT ON THE APEX.
 *
 * The two tiles are the same diamond on different canvases: a review tile is
 * 64x64 with its apex at row 10 and its wall foot at row 54, a base candidate
 * is 64x46 cropped tight, apex at row 0 and foot at row 45. The canvas heights
 * (64 vs 46) do not give the offset — the real one is 9.
 *
 * The bottom edge is the anchor because the top face is DEFINED off it
 * (bot - WALL_D), so sharing a bottom is sharing the top-face/wall boundary,
 * and because it is the edge that actually survives the round trip. Measured
 * over all 5,838 review after-tiles against a base candidate: the mode of
 * (keepBot - takeBot) is 9 on 97.05% of tiles, 95.8% of all 373,632 columns
 * land on that same 9, and on 78.8% of tiles every one of the 64 columns
 * agrees — the bottom edge is a rigid translate.
 *
 * The apex is not. Generated tiles are not pixel-identical in outline to the
 * published grounds (2012 px against 1998 on dark_mud), and that difference is
 * all in the top edge: per-tile top-edge spread is >= 1 px on 5,838 of 5,838
 * tiles, and apex-matching answers 10 where the foot answers 9. What that one
 * pixel costs, measured on grass__over__dark_mud/0_after against a grass
 * candidate: at dy=9 all 910 of the review tile's top-face pixels land on a
 * real top-face pixel of the base, at dy=10 fifty of them fall off it, at dy=8
 * sixty-four, at dy=11 a hundred and ten.
 *
 * Measured per pair rather than hardcoded — 3% of review tiles sit elsewhere
 * (a deep-water cell pools its wall foot flat across the middle 20 columns).
 * `agree` is how many columns voted for the winner; a caller wanting to flag an
 * atypical silhouette reads it.
 */
export function alignTiles(keep, take) {
  const k = columnSpans(keep), t = columnSpans(take);
  const dx = (keep.w - take.w) >> 1;   // 0 for the repo (every tile is 64 wide,
                                       // diamond centred on x=31.5 in both);
                                       // keeps a future crop centred.
  const votes = new Map();
  for (let x = 0; x < keep.w; x++) {
    const sx = x - dx;
    if (k.bot[x] < 0 || sx < 0 || sx >= take.w || t.bot[sx] < 0) continue;
    const d = k.bot[x] - t.bot[sx];
    votes.set(d, (votes.get(d) ?? 0) + 1);
  }
  if (!votes.size) throw new Error("topsub: no column carries opaque pixels in both tiles");
  let dy = 0, agree = -1;
  // Ties go to the smaller shift, so the vote is a pure function of the pixels.
  for (const [d, n] of [...votes].sort((a, b) => a[0] - b[0]))
    if (n > agree) { dy = d; agree = n; }
  return { dx, dy, agree, cols: [...votes.values()].reduce((a, b) => a + b, 0) };
}

/* KEEP the first tile's wall, TAKE the second tile's top face.
 *
 * Returns a new image the size of `keep`. Alpha is copied from `keep` byte for
 * byte, so the silhouette cannot gain or lose a pixel; only the RGB of pixels
 * inside keep's own top face is replaced.
 *
 * EVERY PIXEL GETS A REAL ANSWER, by _extend_base()'s rule: the source row is
 * clamped into the source column's own top face, so rows above it repeat that
 * column's first top pixel. ("Copy the base in pixel-for-pixel and those 14
 * land on nothing, and come through as isolated strays: leaving a few edge
 * pixels like this looks like shit. If the goal is to make this tile clean -
 * make it clean.") The clamp stops at the source's top face rather than at its
 * silhouette — _extend_base runs on tiles of one size and never needed the
 * distinction — because sampling one row lower would paint the BASE tile's
 * wall into the new top, which is the one material that must not appear there.
 *
 * A column with no source (only reachable if the two silhouettes do not
 * overlap) keeps the review tile's own pixels: substituting nothing is a
 * visible seam, inventing a colour is a lie.
 */
export function topSubPixels(keep, take) {
  const { dx, dy } = alignTiles(keep, take);
  const k = columnSpans(keep), t = columnSpans(take);
  const out = new Uint32Array(keep.pix);
  for (let x = 0; x < keep.w; x++) {
    if (k.top[x] < 0) continue;
    const sx = x - dx;
    if (sx < 0 || sx >= take.w || t.top[sx] < 0) continue;
    const sTop = t.top[sx];
    // The source's last top-face row. A column shorter than the wall has no
    // top face of its own; its single boundary pixel answers for all of it.
    const sBot = Math.max(sTop, t.bot[sx] - WALL_D);
    const kBot = k.bot[x] - WALL_D;                 // keep's last top-face row
    for (let y = k.top[x]; y <= kBot; y++) {
      const i = y * keep.w + x;
      if (!(keep.pix[i] >>> 24)) continue;          // top_face() is m & alpha
      let sy = y - dy;
      if (sy < sTop) sy = sTop; else if (sy > sBot) sy = sBot;
      out[i] = ((keep.pix[i] & 0xff000000) | (take.pix[sy * take.w + sx] & 0x00ffffff)) >>> 0;
    }
  }
  return { w: keep.w, h: keep.h, pix: out };
}
