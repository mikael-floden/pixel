// DOES THE TOP SUBSTITUTION KEEP THE WALL AND ONLY THE WALL?
//
// wiki/lib/topsub.mjs pastes a base tile's top face onto a review tile so the
// "On top of" cards show the reviewed WALL under the ground the maintainer
// actually configured as a base tile set. Two ways that can go wrong are
// invisible in a thumbnail and fatal on the page: the silhouette drifting by a
// pixel (the tiles butt against their neighbours in an iso lattice, so one
// stray column of alpha is a hole in the ground), and the wall picking up the
// new material (which would repaint the very thing the page exists to judge).
//
// So this proves, on real repo art across six (review tile, base tile) pairs:
// alpha byte-identical, wall byte-identical, the top genuinely replaced, every
// substituted pixel sourced from an opaque top-face pixel, and the whole thing
// deterministic. Numbers are printed, not just verdicts — an "ok" that cannot
// show how many pixels it moved is not evidence.
import { readFileSync } from "node:fs";
import { decodeWebP } from "../lib/webp-pixels.mjs";
import { topSubPixels, alignTiles, columnSpans, WALL_D } from "../lib/topsub.mjs";

const ROOT = new URL("../../", import.meta.url);
const fails = [];
const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const load = (rel) => decodeWebP(readFileSync(new URL(rel, ROOT)));

// A cell is "X over Y" (top X, wall Y), so the base tile comes from ground X's
// own candidates — that is the substitution the wiki will actually make. Three
// of the six are X-over-X, whose tops are a single palette colour by design and
// are therefore the strictest test that the top really changed.
const PAIRS = [
  ["tiles/review/grass__over__dark_mud/0_after.webp",       "tiles/base_candidates/grass/dark_mud__to__grass__a00_s3.webp"],
  ["tiles/review/grass__over__grass/0_after.webp",          "tiles/base_candidates/grass/dark_mud__to__grass__a18_s6.webp"],
  ["tiles/review/snow__over__snow/0_after.webp",            "tiles/base_candidates/snow/grass__to__snow__a14_s5.webp"],
  ["tiles/review/ice__over__lava/0_after.webp",             "tiles/base_candidates/ice/grass__to__ice__a12_s4.webp"],
  ["tiles/review/light_soil__over__light_soil/0_after.webp","tiles/base_candidates/light_soil/brown_paving_stone__to__light_soil__a00_s3.webp"],
  ["tiles/review/light_beach__over__deep_water/0_after.webp","tiles/base_candidates/light_beach/grass__to__light_beach__a15_s6.webp"],
];

// The pipeline's own definition, restated here so the gate does not inherit a
// bug from the thing it is testing: per column, opaque rows from the topmost
// down to (bottommost - WALL_D + 1).
function topFaceMask(img) {
  const { top, bot } = columnSpans(img);
  const m = new Uint8Array(img.w * img.h);
  for (let x = 0; x < img.w; x++) {
    if (top[x] < 0) continue;
    for (let y = top[x]; y <= bot[x] - WALL_D; y++)
      if (img.pix[y * img.w + x] >>> 24) m[y * img.w + x] = 1;
  }
  return m;
}
const rgb = (p) => p & 0xffffff;
const share = (n, d) => (d ? (100 * n / d).toFixed(1) : "0.0") + "%";

for (const [keepRel, takeRel] of PAIRS) {
  const keep = load(keepRel), take = load(takeRel);
  const cell = keepRel.split("/")[2], base = takeRel.split("/").pop();
  console.log(`\n${cell} <- ${base}`);
  console.log(`  keep ${keep.w}x${keep.h}, take ${take.w}x${take.h}`);

  const al = alignTiles(keep, take);
  const kS = columnSpans(keep), tS = columnSpans(take);
  console.log(`  align: dx ${al.dx}, dy ${al.dy} from the wall foot `
    + `(${al.agree}/${al.cols} columns agree); apex would say `
    + `${Math.min(...[...kS.top].filter((v) => v >= 0)) - Math.min(...[...tS.top].filter((v) => v >= 0))}`);

  const out = topSubPixels(keep, take);
  ok(out.w === keep.w && out.h === keep.h, `output is the review tile's size (${out.w}x${out.h})`);

  // 1. SILHOUETTE — not one pixel added or lost, alpha byte for byte.
  let alphaDiff = 0, gained = 0, lost = 0;
  for (let i = 0; i < keep.pix.length; i++) {
    const a = keep.pix[i] >>> 24, b = out.pix[i] >>> 24;
    if (a !== b) { alphaDiff++; if (a === 0) gained++; if (b === 0) lost++; }
  }
  let opaque = 0;
  for (const p of keep.pix) if (p >>> 24) opaque++;
  ok(alphaDiff === 0, `silhouette identical: ${opaque} opaque px, ${alphaDiff} alpha bytes differ (${gained} gained, ${lost} lost)`);

  // 2. WALL — every opaque pixel outside the top face is byte-identical.
  const face = topFaceMask(keep);
  let wall = 0, wallDiff = 0, faceN = 0;
  for (let i = 0; i < keep.pix.length; i++) {
    if (!(keep.pix[i] >>> 24)) continue;
    if (face[i]) { faceN++; continue; }
    wall++;
    if (out.pix[i] !== keep.pix[i]) wallDiff++;
  }
  ok(wallDiff === 0, `wall untouched: ${wall} wall px, ${wallDiff} differ (top face is ${faceN} px)`);

  // 3. THE TOP REALLY CHANGED. An X-over-X top is ~95% one colour by design;
  //    a replaced top carrying a real texture cannot be.
  let changed = 0;
  const oldC = new Set(), newC = new Set();
  const oldHist = new Map(), newHist = new Map();
  for (let i = 0; i < keep.pix.length; i++) {
    if (!face[i]) continue;
    if (out.pix[i] !== keep.pix[i]) changed++;
    const a = rgb(keep.pix[i]), b = rgb(out.pix[i]);
    oldC.add(a); newC.add(b);
    oldHist.set(a, (oldHist.get(a) ?? 0) + 1);
    newHist.set(b, (newHist.get(b) ?? 0) + 1);
  }
  const domin = (h) => Math.max(...h.values()) / faceN;
  console.log(`  top: ${changed}/${faceN} px changed (${share(changed, faceN)}), `
    + `colours ${oldC.size} -> ${newC.size}, `
    + `commonest colour ${share(domin(oldHist) * faceN, faceN)} -> ${share(domin(newHist) * faceN, faceN)}`);
  ok(changed > faceN * 0.5, `most of the top face was replaced (${share(changed, faceN)})`);
  ok(newC.size > oldC.size, `the new top carries more colours than the old (${oldC.size} -> ${newC.size})`);
  ok(domin(newHist) < 0.95, `the new top is not one flat colour (commonest ${share(domin(newHist) * faceN, faceN)})`);

  // 4. NO HOLE. Alpha is copied, so a hole could only arrive as a colour
  //    sampled from outside the base tile's own top face — check the source,
  //    not just the alpha.
  const srcFace = topFaceMask(take);
  const srcColours = new Set();
  for (let i = 0; i < take.pix.length; i++) if (srcFace[i]) srcColours.add(rgb(take.pix[i]));
  let holes = 0, foreign = 0;
  for (let i = 0; i < keep.pix.length; i++) {
    if (!(keep.pix[i] >>> 24)) continue;
    if ((out.pix[i] >>> 24) === 0) holes++;
    if (face[i] && !srcColours.has(rgb(out.pix[i]))) foreign++;
  }
  ok(holes === 0, `no transparent pixel inside the silhouette (${holes})`);
  ok(foreign === 0, `every substituted pixel came from the base tile's own top face (${foreign} did not, of ${srcColours.size} source colours)`);

  // 5. DETERMINISM — the wiki, the game and a screenshot must not argue.
  const again = topSubPixels(keep, take);
  let drift = 0;
  for (let i = 0; i < out.pix.length; i++) if (out.pix[i] !== again.pix[i]) drift++;
  ok(drift === 0, `二 runs agree byte for byte (${drift} px differ)`);
}

console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL TOPSUB CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
