/* COMPOSED TRANSITIONS: the browser's three canvas ops against the library's
 * reference rule, and POLARITY, proven with pixels.
 *
 * Two failure modes this exists for, both silent:
 *
 * 1. THE COMPOSE DRIFTS FROM THE RULE. The library publishes the reference in
 *    one line — out = where(mask, plate_b, plate_a); out.alpha = silhouette —
 *    and the browser implements it as drawImage + source-in + destination-over.
 *    Those must be the same function or the wiki previews a boundary the game
 *    will not draw.
 *
 * 2. POLARITY BACKWARDS. mask true = side_b, side_b = later in side_order.
 *    Swap the sides and every tile still renders beautifully — grass and rock
 *    simply trade places — so no eyeball catches it and only a pixel that
 *    knows which ground it should be can.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
import { decodeWebP } from "../lib/webp-pixels.mjs";

const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const ROOT = new URL("../../", import.meta.url).pathname;
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const REPO = process.env.REPO_URL ?? "http://127.0.0.1:8903/";
const LIB = JSON.parse(readFileSync(ROOT + "tiles/patterns/index.json", "utf8"));

const sil = decodeWebP(readFileSync(ROOT + LIB.silhouette.file));
const masks = decodeWebP(readFileSync(ROOT + LIB.masks.file));
const FW = LIB.masks.frame_w, FH = LIB.masks.frame_h;
const maskBit = (row, idx, x, y) => (masks.pix[(row * FH + y) * masks.w + idx * FW + x] >>> 24) > 0;

const bord = decodeWebP(readFileSync(ROOT + LIB.border.file));
const bordBit = (row, idx, x, y) => (bord.pix[(row * FH + y) * bord.w + idx * FW + x] >>> 24) > 0;
/* np.rint — half to EVEN, which is what transition_patterns.compose() applies
 * and is NOT Math.round: 25 * 0.82 = 20.5 rints to 20 and rounds to 21. */
const rint = (v) => { const f = Math.floor(v), d = v - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };
/* Per-column bottom of the silhouette; the wall is its last 17 rows. */
const silBot = new Int16Array(FW).fill(-1);
for (let x = 0; x < FW; x++) for (let y = 0; y < FH; y++) if ((sil.pix[y * FW + x] >>> 24) > 0) silBot[x] = y;
const isTopFace = (x, y) => silBot[x] >= 0 && y <= silBot[x] - 17;
/* A SIDE IS TWO SOURCES since 2026-08-28 (maintainer: "the transition should
 * work on the wall ... the same transition mask", "asking for wall help from
 * x-over-x doesn't mean we will change the top texture"): the ground's own
 * x-over-x tile for the WALL — the only wall that was ever art — and the
 * pass's face for the TOP. Both centre-aligned into plate framing. */
function sideArr(wallImg, faceImg, cleanImg) {
  const out = new Uint32Array(FW * FH);
  const cy = (img) => Math.round((FH - img.h) / 2);
  const wdy = cy(wallImg), fdy = cy(faceImg), cdy = cleanImg ? cy(cleanImg) : 0;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const i = y * FW + x;
    if (!((sil.pix[i] >>> 24) > 0)) continue;
    /* The browser's draw order, mirrored exactly: the wall tile under
     * everything, the face over it through the top-face mask, the face again
     * under it all as backfill. So a TOP pixel is the face where the face has
     * one and the WALL's own top where it does not (a review outline runs ±1
     * px from the silhouette, both ways); a WALL pixel is the wall where it
     * has one and the face where it does not. */
    const top2 = isTopFace(x, y);
    const wy = y - wdy, fy = y - fdy;
    const wallPx = wy >= 0 && wy < wallImg.h ? wallImg.pix[wy * wallImg.w + x] : 0;
    const facePx = fy >= 0 && fy < faceImg.h ? faceImg.pix[fy * faceImg.w + x] : 0;
    let v2 = top2
      ? ((facePx >>> 24) > 0 ? facePx : wallPx)
      : ((wallPx >>> 24) > 0 ? wallPx : facePx);
    // …and the ground's CLEAN PLATE under both, so a rim pixel neither source
    // covers is still THIS ground and never the other side's fill.
    if (!((v2 >>> 24) > 0) && cleanImg) {
      const cyy = y - cdy;
      if (cyy >= 0 && cyy < cleanImg.h) v2 = cleanImg.pix[cyy * cleanImg.w + x];
    }
    out[i] = v2;
  }
  return out;
}
/* The reference compose, straight from the index: out = mask ? B : A, then
 * every border pixel darkened to `tone` of what it already is. The seam is
 * NOT optional — "a transition without it is a 0-100 hard cut, which is not
 * what the generator drew" (tiles agent, maintainer verdict 2026-08-27). */
function refCompose(row, idx, A, B) {
  const out = new Uint32Array(FW * FH);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const i = y * FW + x;
    if (!((sil.pix[i] >>> 24) > 0)) continue;
    let v = maskBit(row, idx, x, y) ? B.pix[i] : A.pix[i];
    if (bordBit(row, idx, x, y)) {
      v = (((v >>> 24) << 24) | (rint(((v >> 16) & 255) * LIB.border.tone) << 16)
        | (rint(((v >> 8) & 255) * LIB.border.tone) << 8) | rint((v & 255) * LIB.border.tone)) >>> 0;
    }
    out[i] = v;
  }
  return out;
}

// ---- 0. the library's own invariants, so a republish cannot rot under us ---
ok(masks.w === LIB.masks.sheet_w && masks.h === LIB.masks.sheet_h,
  `the mask sheet is the size its index declares (${masks.w}x${masks.h})`);
{
  let holes = 0, strays = 0;
  const row = LIB.patterns.find((p) => p.id === LIB.selection.default_pattern).row;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const i = y * FW + x;
    const silOn = (sil.pix[i] >>> 24) > 0;
    if (maskBit(row, 15, x, y) !== silOn) holes++;
    if (maskBit(row, 0, x, y)) strays++;
  }
  ok(holes === 0 && strays === 0,
    `frame 15 is the silhouette and frame 0 is empty on the default pattern (${holes} holes, ${strays} strays)`);
}

/* THE SEAM'S OWN INVARIANTS. Frames 0 and 15 must be EMPTY on every pattern —
 * a field of ONE ground has to carry no marks at all, or the world reads as a
 * grid. And no border pixel may fall outside the silhouette. */
{
  let inPure = 0, outside = 0, onWall = 0, total = 0;
  const top = new Int16Array(FW).fill(-1), bot = new Int16Array(FW).fill(-1);
  for (let x = 0; x < FW; x++) for (let y = 0; y < FH; y++) if ((sil.pix[y * FW + x] >>> 24) > 0) { if (top[x] < 0) top[x] = y; bot[x] = y; }
  for (const pat of LIB.patterns) for (let idx = 0; idx < 16; idx++) {
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      if (!bordBit(pat.row, idx, x, y)) continue;
      total++;
      if (idx === 0 || idx === 15) inPure++;
      if (!((sil.pix[y * FW + x] >>> 24) > 0)) outside++;
      if (top[x] >= 0 && y > bot[x] - 17) onWall++;
    }
  }
  ok(inPure === 0, `a pure tile carries NO seam on any of the ${LIB.patterns.length} patterns — a field of one ground is not a grid (${inPure} px)`);
  ok(outside === 0, `and no seam pixel falls outside the silhouette (${outside})`);
  ok(onWall > total * 0.25, `a third of the seam is on the WALL, the vertical edge a cliff shows (${(100 * onWall / total).toFixed(1)}%)`);
}

// ---- 1. browser output == reference, on pairs of every flavour -------------
const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 412, height: 900 } });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript((repo) => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", repo);
}, REPO);
await p.goto(`${W}#/world/black_rock`, { waitUntil: "load" });
await p.waitForTimeout(2200);

/* Pairs chosen so the two plates DIFFER LOUDLY — a compose bug on two similar
 * plates is the blind-fixture trap again. grass/deep_water differ in every
 * channel; the parquet pair exercises a patterned plate. */
const CASES = [
  { a: "grass", b: "deep_water", pat: "a18_s4", idx: 3 },
  { a: "deep_water", b: "grass", pat: "a18_s4", idx: 12 },   // reversed naming, same pair
  { a: "parquet_floor", b: "lava", pat: "a00_s3", idx: 9 },
  { a: "black_rock", b: "snow", pat: "a30_s1", idx: 6 },
  /* THE ROUNDING FIXTURE. The four above cannot tell np.rint from Math.round:
   * they hold no seam pixel whose channel × tone lands exactly on .5, so both
   * roundings give the same answer and a wrong one would pass. Only channel
   * values 25, 75, 125, 175 and 225 discriminate; this pair carries one, and
   * `halfPx` below re-measures that it still does — a republished plate that
   * lost it would otherwise blind the check silently. */
  { a: "grass", b: "brown_paving_stone", pat: "a00_s3", idx: 1, halfPx: true },
];
// Channel values where v * tone has fractional part exactly .5, so half-to-even
// and half-up disagree. Derived, not typed.
const HALF = new Set();
for (let v = 0; v < 256; v++) { const q = v * LIB.border.tone; if (Math.abs(q - Math.floor(q) - 0.5) < 1e-9) HALF.add(v); }
for (const c of CASES) {
  const got = await p.evaluate(async ([a, b2, patId, idx]) => {
    const lib = window.__basesets.patternLib();
    const pat = lib.patterns.find((x) => x.id === patId);
    const path = window.__basesets.mixTile(a, b2, patId, idx, 0, 0);
    const cv = await new Promise((res) => {
      const [row, frame, pa, pb] = path.slice(4).split("|");
      window.__basesets.mixFor(+row, +frame, pa, pb, res);
    });
    if (!cv) return { err: "compose returned null", path };
    const d = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
    return { path, w: cv.width, h: cv.height, px: [...d], row: pat.row };
  }, [c.a, c.b, c.pat, c.idx]);
  if (got.err) { ok(false, `${c.a}__to__${c.b} ${c.pat}#${c.idx}: ${got.err}`); continue; }
  // Reconstruct the reference from the SAME sources the browser picked — a
  // side is now "tex2:<wall>::<face>", so both parts are decoded and split by
  // the top-face rule; a bare path decodes as its own wall and face.
  const [, frame, pa, pb] = got.path.slice(4).split("|");
  const sideOf = (path) => {
    if (path.startsWith("tex2:")) {
      const [wallP, faceP, cleanP] = path.slice(5).split("::");
      return sideArr(decodeWebP(readFileSync(ROOT + wallP)), decodeWebP(readFileSync(ROOT + faceP)),
        cleanP ? decodeWebP(readFileSync(ROOT + cleanP)) : null);
    }
    const d2 = decodeWebP(readFileSync(ROOT + path));
    return sideArr(d2, d2, null);
  };
  const A = { pix: sideOf(pa), w: FW, h: FH }, B = { pix: sideOf(pb), w: FW, h: FH };
  const ref = refCompose(got.row, +frame, A, B);
  let diff = 0, alphaBad = 0;
  for (let i = 0; i < ref.length; i++) {
    const al = got.px[i * 4 + 3], silOn = (sil.pix[i] >>> 24) > 0;
    if ((al > 0) !== silOn) { alphaBad++; continue; }
    if (!silOn) continue;
    const v = ref[i];
    if (got.px[i * 4] !== ((v >> 16) & 255) || got.px[i * 4 + 1] !== ((v >> 8) & 255) || got.px[i * 4 + 2] !== (v & 255)) diff++;
  }
  ok(diff === 0 && alphaBad === 0,
    `${c.a} ↔ ${c.b} ${c.pat} idx ${c.idx}: browser == reference, alpha == silhouette (${diff} rgb, ${alphaBad} alpha of 2012)`);
  /* THE SEAM IS REALLY THERE, and it only ever darkens. A composite that
   * matched a reference computed WITHOUT the seam would also read 0 differing
   * pixels, so the count and the direction are checked against the bare cut. */
  let seamPx = 0, darker = 0, lighter = 0;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const i = y * FW + x;
    if (!bordBit(got.row, +frame, x, y)) continue;
    seamPx++;
    const bare = maskBit(got.row, +frame, x, y) ? B.pix[i] : A.pix[i];
    const gr = got.px[i * 4], gg = got.px[i * 4 + 1], gb = got.px[i * 4 + 2];
    if (gr < ((bare >> 16) & 255) || gg < ((bare >> 8) & 255) || gb < (bare & 255)) darker++;
    if (gr > ((bare >> 16) & 255) || gg > ((bare >> 8) & 255) || gb > (bare & 255)) lighter++;
  }
  if (c.halfPx) {
    let half = 0;
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const i = y * FW + x;
      if (!bordBit(got.row, +frame, x, y)) continue;
      const bare = maskBit(got.row, +frame, x, y) ? B.pix[i] : A.pix[i];
      if (HALF.has((bare >> 16) & 255) || HALF.has((bare >> 8) & 255) || HALF.has(bare & 255)) half++;
    }
    ok(half > 0,
      `  and this pair can still tell np.rint from Math.round — ${half} seam px land on a .5 boundary (values ${[...HALF].join(",")})`);
  }
  ok(seamPx > 40 && darker === seamPx && lighter === 0,
    `  its ${seamPx}-px seam is drawn, every pixel darker than the bare cut and none lighter (${darker} darker, ${lighter} lighter)`);
}

/* ---- 2. POLARITY, against the ground truth: on the composed tile, the
 * corner a set bit names must hold the FIRST-NAMED ground's pixels. Sampled
 * at the library's own corner regions (frame 8 = NW alone, etc.), comparing
 * against each plate's colour at those pixels — the check that fails when the
 * sides are swapped and nothing else does. */
{
  const got = await p.evaluate(async () => {
    const path = window.__basesets.mixTile("grass", "deep_water", "a00_s3", 8, 0, 0);  // NW = grass only
    const cv = await new Promise((res) => {
      const [row, frame, pa, pb] = path.slice(4).split("|");
      window.__basesets.mixFor(+row, +frame, pa, pb, res);
    });
    const d = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
    return { path, px: [...d] };
  });
  const [, frame, pa, pb] = got.path.slice(4).split("|");
  // grass is later than deep_water in side_order, so grass = side_b and the
  // NW-only index keeps its bits: frame must be 8, plate_b must be grass.
  ok(+frame === 8 && /plates\/grass|base_candidates\/grass/.test(pb) && /deep_water/.test(pa),
    `side assignment: grass is side_b (later in side_order), frame stays 8 (frame ${frame}, b=${pb.split("/").slice(-2).join("/")})`);
  /* INDEPENDENT ground truth — the plate is resolved by the RULE (grass under
   * Clean = tiles/plates/grass/clean.webp), never parsed back out of the path
   * under test. Parsing the path made this check circular: with the sides
   * deliberately swapped it followed the swap and still matched 242/242. */
  const G = decodeWebP(readFileSync(ROOT + "tiles/plates/grass/clean.webp"));
  const row = LIB.patterns.find((x) => x.id === "a00_s3").row;
  let inNW = 0, matchG = 0, seamHere = 0;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const i = y * FW + x;
    if (!maskBit(row, 8, x, y)) continue;
    inNW++;
    /* SEAM PIXELS ARE STILL GRASS — a darker grass. Comparing them against the
     * plate's undarkened colour read 210 of 242 the moment the seam landed,
     * which is the check being right about a changed world, not a defect. The
     * expectation carries the seam so every pixel stays in the comparison
     * rather than 32 of them being excused from it. */
    const v = G.pix[i];
    const seam = bordBit(row, 8, x, y);
    if (seam) seamHere++;
    const ch = (c) => seam ? rint(c * LIB.border.tone) : c;
    if (got.px[i * 4] === ch((v >> 16) & 255) && got.px[i * 4 + 1] === ch((v >> 8) & 255) && got.px[i * 4 + 2] === ch(v & 255)) matchG++;
  }
  // The NW-alone region of a00_s3 measures 242 px; the floor guards against a
  // degenerate mask making the claim vacuous, not against normal variation.
  ok(inNW > 150 && matchG === inNW,
    `polarity: every pixel of the NW corner region is GRASS on the composed tile (${matchG}/${inNW}, ${seamHere} of them seam) — swapped sides would fail this at 0`);
}
/* ---- 3. HIS EXACT SCREENSHOT: Black Rock -> Transitions. A ground with ZERO
 * pregenerated pairs must show the full neighbour roster, composed — the empty
 * "Being generated" state is what he reported and what this page must never
 * show again while the library exists. */
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Transitions/.test(x.textContent))?.click());
await p.waitForTimeout(3000);
const br = await p.evaluate(() => ({
  rows: document.querySelectorAll("a.trans-row").length,
  canvases: document.querySelectorAll(".trans-row canvas").length,
  painted: [...document.querySelectorAll(".trans-row canvas")].filter((c) => {
    try {
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
      return false;
    } catch { return false; }
  }).length,
  beingGenerated: /Being generated/.test(document.body.textContent),
}));
const roster = Object.keys(LIB ? JSON.parse(readFileSync(ROOT + "tiles/plates/index.json", "utf8")).grounds : {}).filter((x) => x !== "black_rock").length;
ok(br.rows === roster && !br.beingGenerated,
  `Black Rock lists all ${roster} neighbours — the "Being generated" empty state is gone (${br.rows} rows)`);
ok(br.canvases >= br.rows * 4 && br.painted === br.canvases,
  `every strip is composed and every canvas actually painted (${br.painted}/${br.canvases})`);
/* ---- 4. TWO INDEPENDENT GROUPS, ONE PER TYPE, AND RAW BELONGS TO THE PAIR
 * (maintainer 2026-08-27: "we need two radio button groups on this page ...
 * How do you want to view tile type A? ... type B?" and then "when switching
 * between Raw and Clean #0 today both radio button group changes state").
 *
 * The second note forced the shape of the first: a raw transition tile is ONE
 * generated picture of both materials, so Raw inside a per-side group can only
 * ever move both groups. It is a pair-level control instead, and the side
 * groups became genuinely independent — which is what the split was for. */
await p.goto(`${W}#/world/transition/brown_paving_stone__to__grass`, { waitUntil: "load" });
await p.waitForTimeout(2600);
const rows = () => p.evaluate(() => [...document.querySelectorAll(".ground-pass")].map((r) => ({
  label: r.querySelector(".muted")?.textContent.trim(),
  idle: r.classList.contains("idle"),
  chips: [...r.querySelectorAll("button")].map((x) => x.textContent.trim()),
  off: [...r.querySelectorAll("button")].filter((x) => x.disabled).map((x) => x.textContent.trim()),
  sel: [...r.querySelectorAll("button")].find((x) => x.classList.contains("sel"))?.textContent.trim(),
})));
const r0 = await rows();
ok(r0.length === 3 && r0[0].label === "Brown Paving Stone" && r0[1].label === "Grass" && r0[2].label === "Tile art",
  `one group per type plus the pair's own source (${r0.map((x) => x.label).join(" / ")})`);
/* By SHAPE, not by his set count — he builds sets around the clock, and a gate
 * that reddens because the maintainer worked is a broken gate (this one listed
 * "Clean #0/Set #1" verbatim and failed the night he built seven). */
const wellFormed = (c) => c[0] === "Clean #0" && !c.includes("Raw") && c.slice(1).every((x) => /^Set #\d+$/.test(x));
ok(wellFormed(r0[0].chips) && wellFormed(r0[1].chips),
  `each side lists exactly its own ground's COMPOSED passes, no Raw among them (${r0[0].chips.length} vs ${r0[1].chips.length} chips)`);
ok(r0[2].chips.join("/") === "Composed/Raw", `and the pair carries Composed/Raw (${r0[2].chips.join("/")})`);

// INDEPENDENCE: moving one side moves nothing else. This is the whole ask.
await p.evaluate(() => { const r = [...document.querySelectorAll(".ground-pass")].find((x) => /Brown/.test(x.textContent)); [...r.querySelectorAll("button")].find((x) => x.textContent.trim() === "Set #1")?.click(); });
await p.waitForTimeout(1400);
const r1 = await rows();
ok(r1[0].sel === "Set #1" && r1[1].sel === "Clean #0" && r1[2].sel === "Composed",
  `picking a set on one side moves nothing else (${r1.map((x) => x.sel).join(" / ")})`);

/* RAW DISABLED WHERE THERE IS NONE ("If no raw is available for a type. Just
 * make the state/button disabled instead") — his screenshot's pair, which the
 * generator never produced. Disabled, not absent: the row keeps its shape. */
await p.goto(`${W}#/world/transition/brown_paving_stone__to__black_rock`, { waitUntil: "load" });
await p.waitForTimeout(2600);
const rNo = await rows();
ok(rNo[2].off.includes("Raw") && rNo[2].sel === "Composed",
  `a pair with no generated art has Raw DISABLED, Composed drawn (off: ${rNo[2].off.join(",") || "none"})`);

// A pair that WAS generated: Raw works, and selecting it dims the side groups
// without changing their selections — the picture moves, the controls do not.
await p.goto(`${W}#/world/transition/brown_paving_stone__to__light_soil`, { waitUntil: "load" });
await p.waitForTimeout(2600);
const before = await rows();
await p.evaluate(() => { const r = [...document.querySelectorAll(".ground-pass")].find((x) => /Tile art/.test(x.textContent)); [...r.querySelectorAll("button")].find((x) => x.textContent.trim() === "Raw")?.click(); });
await p.waitForTimeout(1600);
const after = await rows();
ok(after[2].sel === "Raw" && after[0].sel === before[0].sel && after[1].sel === before[1].sel,
  `Raw on a generated pair leaves both side selections untouched (${after[0].sel} / ${after[1].sel})`);
ok(after[0].idle && after[1].idle && !after[2].idle,
  "and dims them instead of hiding them — their choice does not apply to a generated tile");

// The preference survives, but the CHIP never lies: back on a pair with no raw
// it reads Composed, because Composed is what is drawn.
await p.goto(`${W}#/world/transition/brown_paving_stone__to__black_rock`, { waitUntil: "load" });
await p.waitForTimeout(2600);
const rBack = await rows();
ok(rBack[2].sel === "Composed" && rBack[2].off.includes("Raw"),
  `and with Raw still wanted, a pair without it shows Composed selected and Raw disabled (${rBack[2].sel})`);

/* ---- 5. A TOPS MEMBER COMPOSES WITHOUT LEAKING (maintainer 2026-08-28, on
 * his paving Set #5 in a grass transition: "I get a buggy paving stone with
 * grass wall stripes"). tiles/tops art is exact plate content CENTERED on a
 * 64x64 frame; drawn at (0,0) it sat 9 rows low, so wherever the mask wanted
 * the paving the top rows were transparent and destination-over filled them
 * from the OTHER side — grass, through the paving, everywhere.
 *
 * Checked per pixel against the tops file itself, foot-aligned and seamed —
 * and the probe that first checked this reported the fix broken because its
 * own argument names were swapped, so the sides here are spelled out. */
{
  const TOPS_PATH = (() => {
    try {
      const idx = JSON.parse(readFileSync(ROOT + "tiles/tops/index.json", "utf8"));
      const js = JSON.stringify(idx);
      const m = js.match(/tiles\/tops\/[^"]*post\/[^"]+\.webp/);
      if (m) return m[0];
    } catch { /* fall through */ }
    return "tiles/tops/brown_paving_stone/sheet_04_detail_54925/post/tile_05.36000560.webp";
  })();
  const tops = decodeWebP(readFileSync(ROOT + TOPS_PATH));
  ok(tops.w === 64 && tops.h === 64, `the tops fixture is the 64x64 framing under test (${tops.w}x${tops.h})`);
  const grassClean = "tiles/plates/grass/clean.webp";
  const row5 = LIB.patterns.find((x) => x.id === "a18_s4").row;
  const got5 = await p.evaluate(async ([row2, plateA_grass, plateB_tops]) => {
    const cv = await new Promise((res) => window.__basesets.mixFor(row2, 3, plateA_grass, plateB_tops, res));
    if (!cv) return { err: "null" };
    const d = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
    return { px: [...d] };
  }, [row5, grassClean, TOPS_PATH]);
  ok(!got5.err, "the composite builds");
  if (!got5.err) {
    let inB5 = 0, wrong5 = 0, alphaBad5 = 0;
    const topsShift = (tops.h - FH) / 2;      // centered framing: 9 for 64x64
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const i = y * FW + x;
      const silOn = (sil.pix[i] >>> 24) > 0;
      if ((got5.px[i * 4 + 3] > 0) !== silOn) alphaBad5++;
      if (!silOn || !maskBit(row5, 3, x, y)) continue;
      inB5++;
      const tv = tops.pix[(y + topsShift) * tops.w + x];
      const tone5 = bordBit(row5, 3, x, y) ? LIB.border.tone : 1;
      if (got5.px[i * 4] !== rint(((tv >> 16) & 255) * tone5)
        || got5.px[i * 4 + 1] !== rint(((tv >> 8) & 255) * tone5)
        || got5.px[i * 4 + 2] !== rint((tv & 255) * tone5)) wrong5++;
    }
    ok(inB5 > 800 && wrong5 === 0 && alphaBad5 === 0,
      `every pixel of the tops side IS the tops art, seam included — nothing leaks through from the other ground (${wrong5} wrong, ${alphaBad5} alpha, of ${inB5})`);
  }
}
/* ---- 6. THE WALL IS ART AND THE TOP IS STILL THE SET'S (maintainer
 * 2026-08-28: "asking for wall help from x-over-x doesn't mean we will change
 * the top texture. If I select Set #6 I should see the Set #6 base set top
 * textures ... the transition should work on the wall ... using the same
 * transition mask"). Proven on a PURE composed tile against both sources:
 * its wall pixels equal the ground's x-over-x tile's wall, its top pixels
 * equal the face — two different files, one tile, split exactly at the
 * top-face line. */
{
  const wallP = await p.evaluate(() => window.__basesets.xoverxArt("brown_paving_stone"));
  ok(!!wallP && /__over__brown_paving_stone\//.test(wallP), `the wall source is the ground's own x-over-x tile (${wallP})`);
  const pure = await p.evaluate(async () => {
    const path = window.__basesets.mixTile("brown_paving_stone", "grass", "a18_s4", 15, 0, 0);
    const cv = await new Promise((res) => { const [row2, fr, pa2, pb2] = path.slice(4).split("|"); window.__basesets.mixFor(+row2, +fr, pa2, pb2, res); });
    if (!cv) return { err: "null" };
    const d2 = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, 64, 46).data;
    return { path, px: [...d2] };
  });
  ok(!pure.err && /tex2:/.test(pure.path), `a composed side is dressed — tex2:<wall>::<face> (${pure.path.slice(4, 60)}…)`);
  if (!pure.err) {
    const wallImg = decodeWebP(readFileSync(ROOT + wallP));
    const segs = pure.path.split("|")[3].startsWith("tex2:") ? pure.path.split("|")[3].slice(5).split("::") : [null, null, null];
    const faceP = segs[1], cleanP2 = segs[2];
    const faceImg = decodeWebP(readFileSync(ROOT + faceP));
    const cleanImg2 = cleanP2 ? decodeWebP(readFileSync(ROOT + cleanP2)) : null;
    const wdy = Math.round((FH - wallImg.h) / 2), fdy = Math.round((FH - faceImg.h) / 2), cdy2 = cleanImg2 ? Math.round((FH - cleanImg2.h) / 2) : 0;
    let wallN = 0, wallBad = 0, topN = 0, topBad = 0;
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const i = y * FW + x;
      if (!((sil.pix[i] >>> 24) > 0)) continue;
      const top2 = isTopFace(x, y);
      const wy2 = y - wdy, fy2 = y - fdy;
      const wPx = wy2 >= 0 && wy2 < wallImg.h ? wallImg.pix[wy2 * wallImg.w + x] : 0;
      const fPx = fy2 >= 0 && fy2 < faceImg.h ? faceImg.pix[fy2 * faceImg.w + x] : 0;
      // Face first on the top, wall first on the wall — each backfilling the
      // other's rim, the browser's own draw order.
      let v = top2 ? ((fPx >>> 24) > 0 ? fPx : wPx) : ((wPx >>> 24) > 0 ? wPx : fPx);
      if (!((v >>> 24) > 0) && cleanImg2) { const cyy = y - cdy2; if (cyy >= 0 && cyy < cleanImg2.h) v = cleanImg2.pix[cyy * cleanImg2.w + x]; }
      /* A rim pixel NEITHER source covers is legitimately empty on both sides
       * — and comparing RGB there compares the junk lossless WebP keeps under
       * alpha 0 (exact=True preserves it, by repo law). Empty-vs-empty is
       * agreement; empty-vs-painted still fails. */
      if (!((v >>> 24) > 0) && pure.px[i * 4 + 3] === 0) continue;
      const okPx = pure.px[i * 4 + 3] > 0 && (v >>> 24) > 0
        && pure.px[i * 4] === ((v >> 16) & 255) && pure.px[i * 4 + 1] === ((v >> 8) & 255) && pure.px[i * 4 + 2] === (v & 255);
      if (top2) { topN++; if (!okPx) topBad++; } else { wallN++; if (!okPx) wallBad++; }
    }
    ok(wallN > 900 && wallBad === 0, `every wall pixel is the x-over-x tile's own wall (${wallBad} wrong of ${wallN})`);
    ok(topN > 800 && topBad === 0, `and every top pixel is still the chosen face — borrowing the wall changed no top texture (${topBad} wrong of ${topN})`);
  }
}
ok(errs.length === 0, `no page errors (${errs[0] ?? "none"})`);
await b.close();
console.log(fails.length ? `\nTRANS-COMPOSE CHECKS FAILED (${fails.length})` : "\nALL TRANS-COMPOSE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
