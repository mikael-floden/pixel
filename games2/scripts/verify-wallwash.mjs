// THE WALL WASH: how a torch's light lies ALONG a wall, read off the pixels.
//
// The maintainer, at night with a torch beside a house wall (2026-09-11), drew
// three things: BLUE — a hard vertical seam at every tile edge along the lit
// wall; RED — the bottom course of the wall darker than the courses above it;
// and "the light doesn't travel very long along the wall ... only the wall very
// close to the player is lit up". Each was a specific line in the night shader
// (per-cell Lambert lateral, the LOS march's bilinear skirt, a hard-coded
// cosine exponent) and each is asserted here on the RAW light field.
//
// HOW: plant a probe light 0.4 cells in front of a long straight wall on
// the_game (the house he stood at), switch the night pass to test pattern 5
// (the light field composited opaque, so the screenshot IS the field, free of
// the art under it), and sample luma on the FACE at known (col, z) points:
//   * SEAM   — along the run at mid-height, 8 samples per tile: the biggest
//              step between neighbours must be a small fraction of the run's
//              whole range. A per-cell term shows up as a step at the tile edge
//              the size of a whole tile's worth of falloff.
//   * BASE   — per tile, the bottom quarter of the face against the middle:
//              the foot must not be darker than the course above it beyond the
//              seam AO's own 25% (which is geometric and stays).
//   * REACH  — where along the run the wash falls to half its peak, in cells,
//              against where the pool halves on flat ground by its own
//              attenuation (0.29 r): the wall must keep at least 3/4 of it.
// GEOMETRY IS SELF-CHECKED FIRST with test pattern 4 (faces RED, tops GREEN):
// every face sample point must read red, or the sampling is wrong and no luma
// it reads means anything.
//
// Needs the dev stack (npm run dev). PORT overrides vite's port.
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = process.env.PORT || "5173";
const WRAP = process.env.WRAP; // pin the dial (0..1) for an A/B; default = the shipped default

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const VW = 1600, VH = 1000;
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
// Boot problems (a GLSL compile error kills the scene before __ml exists) must
// be SEEN, not timed out on.
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errs.push(`${m.type()}: ${m.text().slice(0, 400)}`); });
process.on("exit", () => { if (errs.length) console.error("--- page console ---\n" + errs.slice(0, 25).join("\n")); });
await page.goto(`http://localhost:${PORT}/#the_game`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, { timeout: 40000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 40000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.__ml.noAggro?.(true));
await page.evaluate(() => window.__ml.timeOfDay("night", true));
// THE DEPTH FOG IS OFF FOR THE MEASUREMENT. It is a separate NORMAL-blend
// overlay composited ABOVE the night field and posterized into cel bands, so
// every luma read through it carries the fog's steps as well as the light's
// (the first cuts of this file read the fog's bands as a lighting seam).
// The fog has its own gate (verify-depthfog.mjs); this one is about the light.
await page.evaluate(() => window.__ml.depthFog?.(0));
if (WRAP !== undefined) await page.evaluate((w) => window.__ml.wallWrap(w), Number(WRAP));
const wrap = await page.evaluate(() => (window.__ml.wallWrap ? window.__ml.wallWrap() : "n/a (pre-dial build)"));

// A LONG STRAIGHT WALL WITH FLAT GROUND IN FRONT, from the world itself: the
// +row face (the lower-LEFT face on screen) of a run of cells at one level with
// the cell below each (row+1) at one lower level, RUN cells long, nothing
// higher in the two rows in front. The house he stood beside is the first hit
// near 250,308; the scan finds it rather than trusting the coordinates.
const RUN = 5;
const wall = await page.evaluate((RUN) => {
  const W = window.__ml.worldSize?.() ?? null;
  const lv = (c, r) => window.__ml.levelAt(c * 32 + 16, r * 32 + 16);
  const near = [[250, 308], [200, 300], [300, 200], [150, 150]];
  for (const [nc, nr] of near)
    for (let r = nr - 25; r < nr + 25; r++)
      for (let c = nc - 25; c < nc + 25 - RUN; c++) {
        const top = lv(c, r);
        const g = lv(c, r + 1);
        if (!(top - g >= 3 && top - g <= 8)) continue;
        let ok = true;
        for (let k = 0; k < RUN && ok; k++) {
          if (lv(c + k, r) !== top) ok = false;
          if (lv(c + k, r + 1) !== g || lv(c + k, r + 2) !== g) ok = false;
        }
        if (ok) return { c, r, top, g };
      }
  return null;
}, RUN);
if (!wall) {
  fail("no straight wall run found near the maintainer's spots");
  await browser.close();
  process.exit(1);
}
const H = wall.top - wall.g;
console.log(`wall: cells ${wall.c}..${wall.c + RUN - 1}, row ${wall.r}, ${H} storeys over level ${wall.g}; wrap ${wrap}`);

// Stand the player in front of the middle of the run so the camera frames it,
// and plant the probe light 0.4 cells in front of the plane there. The plane
// of the +row face is y = r + 1; "in front" is +row.
const midC = wall.c + RUN / 2;
// THE PLAYER STANDS OFF THE RUN, to its left and two rows out: the body's lit
// sprite composites ABOVE the light field, and a sample under it reads the
// character, not the wall (the first cut measured an 80-luma "seam" that was
// the player's head). The probe light still sits mid-run. The camera follows
// the body, so the run has to fit to its right — hence the wide viewport.
// Two cells left of the run, a row and a half out: at the harness zoom the
// body is ~200 px wide, so this clears the first sample column, and standing
// close keeps the wall's TOP on the canvas (further out pushes it off the top).
const STAND = { col: wall.c - 2.0, row: wall.r + 1.6 };
await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [STAND.col, STAND.row]);
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 60000 });
// The camera LERPS to a teleport; sample only once the run has settled on
// screen: the first and last cells both inside the view, the wall's top row
// clear of the canvas edge, two consecutive reads within a px.
let lastCs = null, cs0 = null, cs1 = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(500);
  cs0 = await page.evaluate(([c, r]) => window.__ml.cellScreen(c, r), [wall.c, wall.r]);
  cs1 = await page.evaluate(([c, r]) => window.__ml.cellScreen(c, r), [wall.c + RUN - 1, wall.r]);
  const settled = cs0 && lastCs && Math.abs(cs0.x - lastCs.x) < 1 && Math.abs(cs0.y - lastCs.y) < 1;
  if (settled && cs0.x > 60 && cs1 && cs1.x + 40 * cs1.zoom < VW - 60 && cs0.y > 40 && cs0.y < VH - 300) break;
  lastCs = cs0;
}
console.log(`run on screen: first cell ${JSON.stringify(cs0 && { x: Math.round(cs0.x), y: Math.round(cs0.y), zoom: cs0.zoom })}, last cell x ${cs1 && Math.round(cs1.x)}`);
const meCs = await page.evaluate(([c, r]) => window.__ml.cellScreen(Math.floor(c), Math.floor(r)), [STAND.col, STAND.row]);
if (!cs0 || cs0.y <= 40) fail("the wall's top is off the canvas — the band would be truncated");
if (meCs && cs0 && meCs.x + 60 * meCs.zoom > cs0.x) fail(`the player's body (x ${Math.round(meCs.x)}) overlaps the run's first cell (x ${Math.round(cs0.x)})`);
// The light at the START of the run, so REACH is measured over the whole run
// to its right rather than half a run either side.
const FRONT = Number(process.env.FRONT ?? 0.4); // cells in front of the plane (A/B: 2.0 makes the skirt rule inert)
const RADIUS = Number(process.env.RADIUS ?? 6); // A/B: 60 flattens the attenuation across the run
const LIGHT = { col: wall.c + 0.5, row: wall.r + 1 + FRONT, radius: RADIUS };
await page.evaluate(
  ({ col, row, radius, g }) => window.__ml.probeLight(col, row, g + 0.55, radius),
  { ...LIGHT, g: wall.g },
);
await page.waitForTimeout(600);

/** THE FACE IS FOUND, NOT DERIVED. The +row face of cell (c, r) spans, in
 *  world px, from the cell anchor's x (its LEFT diamond corner) to x + 32 (its
 *  BOTTOM corner) — that much is the projection and is exact. WHERE it starts
 *  and ends vertically is read off test pattern 4, which paints face pixels
 *  RED: for each screen column we scan down from the cell anchor and take the
 *  contiguous red run as the face. Anything derived from lh, the art's
 *  diamond row or the camera's y would be an assumption the luma would then
 *  quietly be wrong about — the first cut of this file made exactly that
 *  mistake and measured 0 of 63 samples on a face. */
let calShot = null;
const faceSpan = async (c, s) => {
  const cs = await page.evaluate(([c, r]) => window.__ml.cellScreen(c, r), [c, wall.r]);
  if (!cs) return null;
  const x = cs.x + 32 * s * cs.zoom;
  // THE TALLEST RED RUN IN THE WINDOW, NOT THE FIRST: the anchor is the tile
  // art box's top-left, and a storey of the terrace BEHIND the run can paint a
  // sliver of its own face just above this cell's lip. The first cut took the
  // first run and measured a 24 px sliver of the wrong face for a 3-storey
  // wall (and every "seam" it reported was that sliver's edge).
  let top = null, bot = null, best = null;
  const y0 = cs.y - 8 * cs.zoom, y1 = cs.y + 160 * cs.zoom;
  for (let y = y0; y <= y1; y += 1) {
    const px = y < y1 ? calShot.at(x, y) : null;
    const red = px && px[0] > 150 && px[1] < 100;
    if (red && top === null) top = y;
    if (red) bot = y;
    else if (top !== null) {
      if (!best || bot - top > best.bot - best.top) best = { x, top, bot };
      top = bot = null;
    }
  }
  return best;
};
/** Screen px of a point ON the face: `s` along it, `q` down it (0 lip, 1 foot). */
const facePt = async (c, r, s, q) => {
  const f = await faceSpan(c, s);
  if (!f) return null;
  return { x: f.x, y: f.top + (f.bot - f.top) * q };
};

const shoot = async (pattern) => {
  await page.evaluate((t) => window.__ml.nightCal(0, 1, t), pattern);
  await page.waitForTimeout(500);
  const buf = await page.screenshot();
  if (process.env.SHOT) {
    const fs = await import("node:fs");
    fs.writeFileSync(`${process.env.SHOT}/wallwash-pattern${pattern}.png`, buf);
  }
  const png = PNG.sync.read(buf);
  const dpr = png.width / VW;
  return {
    png,
    at: (x, y) => {
      const X = Math.round(x * dpr), Y = Math.round(y * dpr);
      if (X < 0 || Y < 0 || X >= png.width || Y >= png.height) return null;
      const i = (Y * png.width + X) * 4;
      return [png.data[i], png.data[i + 1], png.data[i + 2]];
    },
  };
};

// 1) GEOMETRY SELF-CHECK: pattern 4 paints faces red. Every point we intend to
//    read must be a face pixel, or the numbers below are about the wrong thing.
calShot = await shoot(4);
let onFace = 0, total = 0;
const heights = [];
for (let k = 0; k < RUN; k++)
  for (const s of [0.2, 0.5, 0.8]) {
    total++;
    const f = await faceSpan(wall.c + k, s);
    if (!f) continue;
    onFace++;
    heights.push(f.bot - f.top);
  }
const hMed = heights.length ? heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)] : 0;
console.log(`geometry: ${onFace}/${total} columns show a face band (pattern 4); median band ${hMed.toFixed(0)}px for ${H} storeys`);
if (onFace < total * 0.9) fail(`only ${onFace}/${total} sampled columns show a face — the wall is not where the scan thinks`);
if (hMed < H * 8) fail(`the face band is only ${hMed.toFixed(0)}px tall for ${H} storeys — not a wall`);

// DIAGNOSTIC: PATTERN=6 paints fract(pos.x), fract(pos.y) and the distance to
// light 0 — the shader's own idea of where each face pixel sits on the plane.
if (process.env.PATTERN === "6") {
  const d6 = await shoot(6);
  for (const q of [0.15, 0.5, 0.85]) {
    const rr = [], gg = [], bb = [];
    for (let k = 0; k < RUN; k++)
      for (let i = 0; i < 8; i++) {
        const pt = await facePt(wall.c + k, wall.r, (i + 0.5) / 8, q);
        const px = pt && d6.at(pt.x, pt.y);
        rr.push(px ? px[0] : -1); gg.push(px ? px[1] : -1); bb.push(px ? px[2] : -1);
      }
    console.log(`pattern6 q=${q} fract(pos.x): ` + rr.join(" "));
    console.log(`pattern6 q=${q} fract(z)    : ` + gg.join(" "));
    console.log(`pattern6 q=${q} gateFade   : ` + bb.join(" "));
  }
  await page.evaluate(() => window.__ml.nightCal(0, 1, 0));
  await browser.close();
  process.exit(0);
}
// 2) THE FIELD.
const fld = await shoot(5);
const luma = (px) => (px ? 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2] : NaN);

// SEAM: along the run at mid-height, 8 per tile, toward +col from the light.
const prof = [];
for (let k = 0; k < RUN; k++)
  for (let i = 0; i < 8; i++) {
    const s = (i + 0.5) / 8;
    const pt = await facePt(wall.c + k, wall.r, s, 0.5);
    prof.push({ cell: wall.c + k, s, x: wall.c + k + s, l: luma(fld.at(pt.x, pt.y)) });
  }
const peak = Math.max(...prof.map((p) => p.l));
const floor = Math.min(...prof.map((p) => p.l));
const range = peak - floor;
// THE RUN'S ENDS ARE NOT SEAMS: the first and last quarter-tile sit at the
// corners where the wall turns, and the corner blend (pickR) legitimately
// mixes in the other face there — measured as a 16-luma brightening over the
// final 1/8 cell at wrap 1.0. The tile EDGES inside the run are the seams.
let worstStep = 0, worstAt = "";
for (let i = 3; i < prof.length - 2; i++) {
  const d = Math.abs(prof[i].l - prof[i - 1].l);
  if (d > worstStep) { worstStep = d; worstAt = `${prof[i - 1].x.toFixed(2)}->${prof[i].x.toFixed(2)}`; }
}
console.log("profile q=0.5 (luma per 1/8 cell, from cell " + wall.c + "): " + prof.map((p) => Math.round(p.l)).join(" "));
for (const q of [0.15, 0.85]) {
  const pr = [];
  for (let k = 0; k < RUN; k++)
    for (let i = 0; i < 8; i++) {
      const pt = await facePt(wall.c + k, wall.r, (i + 0.5) / 8, q);
      pr.push(pt ? Math.round(luma(fld.at(pt.x, pt.y))) : -1);
    }
  console.log(`profile q=${q}: ` + pr.join(" "));
}
console.log(`seam: run range ${range.toFixed(1)} luma, worst neighbour step ${worstStep.toFixed(1)} at x ${worstAt} (${((worstStep / Math.max(range, 1)) * 100).toFixed(0)}% of range)`);
// A whole-tile step (the per-cell term) is ~15-25% of the range; a smooth
// per-pixel taper stays under ~6% per 1/8-tile sample.
if (range > 20 && worstStep > range * 0.08) fail(`a ${worstStep.toFixed(1)}-luma step between neighbouring samples along the wall — a seam`);

// BASE: per tile, the foot (q 0.85) against the middle (q 0.5).
const base = [];
for (let k = 0; k < RUN; k++) {
  const mid = luma(fld.at(...Object.values(await facePt(wall.c + k, wall.r, 0.5, 0.5))));
  const foot = luma(fld.at(...Object.values(await facePt(wall.c + k, wall.r, 0.5, 0.85))));
  base.push({ cell: wall.c + k, mid: +mid.toFixed(1), foot: +foot.toFixed(1), ratio: mid > 8 ? +(foot / mid).toFixed(2) : null });
}
console.log("base (foot/mid per tile):", base.map((b) => `${b.cell}:${b.ratio ?? "-"}`).join(" "));
// The seam AO legitimately takes up to 25% off the last ~5px; sampling at
// q 0.85 sits above most of that. A skirt-shadowed foot reads 0.2-0.5.
for (const b of base) if (b.ratio !== null && b.ratio < 0.62) fail(`tile ${b.cell}: the foot of the wall is ${Math.round((1 - b.ratio) * 100)}% darker than its middle — the wall is shadowing its own base`);

// REACH: half-peak distance along the run from the light, in cells, AGAINST
// THE POOL'S OWN: a point light falls as (1 - d/r)^2, so on flat ground it is
// at half strength r * (1 - sqrt(0.5)) = 0.29 r out — 1.76 cells for this
// radius-6 probe. The wall can never reach further than the ground does; the
// complaint is the wall reaching much LESS ("only the wall very close to the
// player is lit"), so the gate is the ratio, not an absolute cell count (the
// first cut asked for r/3 = 2 cells, which the ground itself cannot meet).
const lit = prof.filter((p) => p.x >= LIGHT.col).sort((a, b) => a.x - b.x);
const half = lit.find((p) => p.l <= floor + range * 0.5);
const reach = half ? half.x - LIGHT.col : RUN;
const groundReach = LIGHT.radius * (1 - Math.sqrt(0.5));
console.log(`reach: wash falls to half its range ${reach.toFixed(2)} cells along the wall; the pool halves on flat ground at ${groundReach.toFixed(2)} (ratio ${(reach / groundReach).toFixed(2)})`);
if (reach < groundReach * 0.75) fail(`the wash dies within ${reach.toFixed(2)} cells of the light, under 3/4 of the pool's own ${groundReach.toFixed(2)} — "only the wall very close to the player is lit"`);

console.log(JSON.stringify({ wrap, range: +range.toFixed(1), worstStepPct: +((worstStep / Math.max(range, 1)) * 100).toFixed(1), reach: +reach.toFixed(2), reachRatio: +(reach / groundReach).toFixed(2), base: base.map((b) => b.ratio) }));
await page.evaluate(() => window.__ml.nightCal(0, 1, 0));
await browser.close();
