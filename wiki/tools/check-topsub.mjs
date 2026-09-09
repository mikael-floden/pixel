// DOES THE TOP SUBSTITUTION KEEP THE WALL, AND ONLY THE WALL?
//
// wiki/lib/topsub.mjs pastes a base tile's top face onto a review tile so the
// "On top of" cards show the reviewed WALL under the ground the maintainer
// actually configured as a base tile set. Two ways that can go wrong are
// invisible in a thumbnail and fatal on the page: the silhouette drifting by a
// pixel (these tiles butt against their neighbours in an iso lattice, so one
// stray column of alpha is a hole in the ground), and the wall picking up the
// new material (which repaints the one thing the page exists to judge).
//
// So this proves it on real repo art — six hand-picked (review tile, base tile)
// pairs in detail, then every cell's rank-0 tile as a sweep. Numbers are
// printed, not just verdicts: an "ok" that cannot say how many pixels it moved
// is not evidence.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeWebP } from "../lib/webp-pixels.mjs";
import { topSubPixels, alignTiles, columnSpans, WALL_D } from "../lib/topsub.mjs";

const ROOT = new URL("../../", import.meta.url);
const fails = [];
const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const load = (rel) => decodeWebP(readFileSync(new URL(rel, ROOT)));

// A cell is "X over Y" (top X, wall Y), so the base tile comes from ground X's
// own candidates — that is the substitution the wiki will make. Three of the
// six keep tiles are X-over-X, whose tops are one palette colour by design and
// are therefore the strictest evidence that the top really was replaced. The
// base tiles are the most textured candidate each ground has (a set may also
// hold a deliberately clean member — snow's whole shelf is near-uniform, and
// the numbers below say so).
const PAIRS = [
  ["tiles/review/grass__over__dark_mud/0_after.webp",        "tiles/base_candidates/grass/grass__to__slime__a00_s3.webp"],
  ["tiles/review/grass__over__grass/0_after.webp",           "tiles/base_candidates/grass/grass__to__slime__a14_s5.webp"],
  ["tiles/review/ice__over__lava/3_after.webp",              "tiles/base_candidates/ice/grass__to__ice__a14_s5.webp"],
  ["tiles/review/light_soil__over__light_soil/0_after.webp", "tiles/base_candidates/light_soil/grey_stone__to__light_soil__a14_s5.webp"],
  ["tiles/review/light_beach__over__deep_water/0_after.webp","tiles/base_candidates/light_beach/grass__to__light_beach__a00_s5.webp"],
  ["tiles/review/snow__over__snow/0_after.webp",             "tiles/base_candidates/snow/grass__to__snow__a15_s2.webp"],
];

// The pipeline's definition restated here, so the gate does not inherit its
// answer from the thing it is testing: per column, opaque rows from the topmost
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
const pct = (n, d) => (d ? (100 * n / d).toFixed(1) : "0.0") + "%";
const dominance = (hist, n) => Math.max(...hist.values()) / n;

/* Silhouette, wall and determinism — the three invariants that must hold for
 * every pair, whatever the art looks like. Returns the counts so the caller can
 * print them or total them up. */
function invariants(keep, take, out, face) {
  let alphaDiff = 0, gained = 0, lost = 0, opaque = 0, wall = 0, wallDiff = 0, faceN = 0, holes = 0;
  for (let i = 0; i < keep.pix.length; i++) {
    const a = keep.pix[i] >>> 24, b = out.pix[i] >>> 24;
    if (a !== b) { alphaDiff++; if (a === 0) gained++; else lost++; }
    if (!a) continue;
    opaque++;
    if (!b) holes++;
    if (face[i]) faceN++;
    else { wall++; if (out.pix[i] !== keep.pix[i]) wallDiff++; }
  }
  // Sampling outside the base tile's own top face is how a hole or a stripe of
  // the WRONG material would arrive, since alpha itself is copied.
  const srcFace = topFaceMask(take), srcColours = new Set();
  for (let i = 0; i < take.pix.length; i++) if (srcFace[i]) srcColours.add(rgb(take.pix[i]));
  let foreign = 0;
  for (let i = 0; i < keep.pix.length; i++) if (face[i] && !srcColours.has(rgb(out.pix[i]))) foreign++;
  const again = topSubPixels(keep, take);
  let drift = 0;
  for (let i = 0; i < out.pix.length; i++) if (out.pix[i] !== again.pix[i]) drift++;
  return { alphaDiff, gained, lost, opaque, wall, wallDiff, faceN, holes, foreign, drift, srcColours: srcColours.size };
}

// ---------------------------------------------------------------- the pairs
for (const [keepRel, takeRel] of PAIRS) {
  const keep = load(keepRel), take = load(takeRel);
  console.log(`\n${keepRel.split("/").slice(2).join("/")}  <-  ${takeRel.split("/").pop()}`);
  console.log(`  keep ${keep.w}x${keep.h}, take ${take.w}x${take.h}`);

  const al = alignTiles(keep, take);
  const kS = columnSpans(keep), tS = columnSpans(take);
  const apexOf = (s) => Math.min(...[...s.top].filter((v) => v >= 0));
  console.log(`  align: dx ${al.dx}, dy ${al.dy} off the wall foot, ${al.agree}/${al.cols} columns agreeing`
    + ` — the apex would have said ${apexOf(kS) - apexOf(tS)}`);

  const out = topSubPixels(keep, take);
  const face = topFaceMask(keep);
  ok(out.w === keep.w && out.h === keep.h, `output is the review tile's size (${out.w}x${out.h})`);

  const v = invariants(keep, take, out, face);
  ok(v.alphaDiff === 0, `silhouette identical: ${v.opaque} opaque px, ${v.alphaDiff} alpha bytes differ (${v.gained} gained, ${v.lost} lost)`);
  ok(v.wallDiff === 0, `wall untouched: ${v.wall} wall px, ${v.wallDiff} differ`);

  // THE TOP REALLY CHANGED. An X-over-X top is ~95% one colour by design; a
  // real ground surface pasted over it cannot be.
  let changed = 0, extended = 0;
  const oldH = new Map(), newH = new Map();
  for (let x = 0; x < keep.w; x++) {
    const sx = x - al.dx;
    if (kS.top[x] < 0 || sx < 0 || sx >= take.w || tS.top[sx] < 0) continue;
    const sTop = tS.top[sx], sBot = Math.max(sTop, tS.bot[sx] - WALL_D);
    for (let y = kS.top[x]; y <= kS.bot[x] - WALL_D; y++) {
      const i = y * keep.w + x;
      if (!face[i]) continue;
      const sy = y - al.dy;
      if (sy < sTop || sy > sBot) extended++;          // answered by _extend_base's rule
      if (out.pix[i] !== keep.pix[i]) changed++;
      const a = rgb(keep.pix[i]), b = rgb(out.pix[i]);
      oldH.set(a, (oldH.get(a) ?? 0) + 1);
      newH.set(b, (newH.get(b) ?? 0) + 1);
    }
  }
  const oldDom = dominance(oldH, v.faceN), newDom = dominance(newH, v.faceN);
  console.log(`  top face ${v.faceN} px: ${changed} changed (${pct(changed, v.faceN)}), `
    + `${extended} answered by extension (${pct(extended, v.faceN)})`);
  console.log(`  colours ${oldH.size} -> ${newH.size}, commonest colour ${pct(oldDom * v.faceN, v.faceN)} -> ${pct(newDom * v.faceN, v.faceN)}`
    + ` (base's own top face has ${v.srcColours})`);
  ok(changed > v.faceN * 0.9, `the top face was replaced, not nudged (${pct(changed, v.faceN)})`);
  ok(newH.size > oldH.size, `the new top carries more colours than the old (${oldH.size} -> ${newH.size})`);
  ok(newDom < 0.95, `the new top is not one flat colour (commonest ${pct(newDom * v.faceN, v.faceN)}, was ${pct(oldDom * v.faceN, v.faceN)})`);

  ok(v.holes === 0, `no transparent pixel inside the silhouette (${v.holes})`);
  ok(v.foreign === 0, `every substituted pixel came from the base tile's own top face (${v.foreign} did not)`);
  ok(v.drift === 0, `two runs agree byte for byte (${v.drift} px differ)`);
}

// ---------------------------------------------------------------- the sweep
// The invariants again over every cell's rank-0 tile, because the six pairs
// above are hand-picked and the atypical silhouettes are exactly the ones that
// would break alignment: a deep-water cell pools its wall foot flat across the
// middle columns and votes a different dy.
console.log("\nSWEEP — every review cell's rank-0 after-tile against one grass candidate");
const REVIEW = fileURLToPath(new URL("tiles/review/", ROOT));
const sweepTake = load("tiles/base_candidates/grass/grass__to__slime__a00_s3.webp");
let n = 0, badAlpha = 0, badWall = 0, badHole = 0, badForeign = 0, badDrift = 0, unchanged = 0;
const dyHist = new Map();
let minAgree = 64, worstExt = 0, worstCell = "";
for (const cell of readdirSync(REVIEW).filter((d) => d.includes("__over__")).sort()) {
  let keep;
  try { keep = load(`tiles/review/${cell}/0_after.webp`); } catch { continue; }
  const out = topSubPixels(keep, sweepTake);
  const face = topFaceMask(keep);
  const v = invariants(keep, sweepTake, out, face);
  const al = alignTiles(keep, sweepTake);
  dyHist.set(al.dy, (dyHist.get(al.dy) ?? 0) + 1);
  if (al.agree < minAgree) minAgree = al.agree;
  n++;
  if (v.alphaDiff) badAlpha++;
  if (v.wallDiff) badWall++;
  if (v.holes) badHole++;
  if (v.foreign) badForeign++;
  if (v.drift) badDrift++;
  let changed = 0;
  for (let i = 0; i < keep.pix.length; i++) if (face[i] && out.pix[i] !== keep.pix[i]) changed++;
  if (changed < v.faceN * 0.9) unchanged++;
  // How much of the top face the base tile could not answer from its own art
  // and had to have extended. High only where the review tile is not the
  // standard block at all.
  const kS = columnSpans(keep), tS = columnSpans(sweepTake);
  let ext = 0;
  for (let x = 0; x < keep.w; x++) {
    const sx = x - al.dx;
    if (kS.top[x] < 0 || sx < 0 || sx >= sweepTake.w || tS.top[sx] < 0) continue;
    const sTop = tS.top[sx], sBot = Math.max(sTop, tS.bot[sx] - WALL_D);
    for (let y = kS.top[x]; y <= kS.bot[x] - WALL_D; y++)
      if (face[y * keep.w + x] && (y - al.dy < sTop || y - al.dy > sBot)) ext++;
  }
  if (ext / v.faceN > worstExt) { worstExt = ext / v.faceN; worstCell = cell; }
}
console.log(`  ${n} cells; dy voted ${[...dyHist].sort((a, b) => b[1] - a[1]).map(([d, c]) => `${d}x${c}`).join(" ")}`
  + `; weakest column agreement ${minAgree}/64`);
console.log(`  most extension needed: ${pct(worstExt, 1)} of the top face on ${worstCell}`
  + ` — a deformed silhouette (2584 opaque px against the standard 1998), where repeating the`
  + ` boundary pixel is the only honest answer`);
ok(badAlpha === 0, `silhouette identical on every cell (${badAlpha} broken)`);
ok(badWall === 0, `wall byte-identical on every cell (${badWall} broken)`);
ok(badHole === 0, `no transparent hole on any cell (${badHole} broken)`);
ok(badForeign === 0, `no pixel sourced outside the base tile's top face (${badForeign} broken)`);
ok(badDrift === 0, `deterministic on every cell (${badDrift} broken)`);
ok(unchanged === 0, `the top face was replaced on every cell (${unchanged} left mostly alone)`);

console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL TOPSUB CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
