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

/* The reference compose, straight from the index: out = mask ? B : A. */
function refCompose(row, idx, A, B) {
  const out = new Uint32Array(FW * FH);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const i = y * FW + x;
    if (!((sil.pix[i] >>> 24) > 0)) continue;
    out[i] = maskBit(row, idx, x, y) ? B.pix[i] : A.pix[i];
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
];
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
  // Reconstruct the reference from the SAME plates the browser picked.
  const [, frame, pa, pb] = got.path.slice(4).split("|");
  const A = decodeWebP(readFileSync(ROOT + pa)), B = decodeWebP(readFileSync(ROOT + pb));
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
  let inNW = 0, matchG = 0;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const i = y * FW + x;
    if (!maskBit(row, 8, x, y)) continue;
    inNW++;
    const v = G.pix[i];
    if (got.px[i * 4] === ((v >> 16) & 255) && got.px[i * 4 + 1] === ((v >> 8) & 255) && got.px[i * 4 + 2] === (v & 255)) matchG++;
  }
  // The NW-alone region of a00_s3 measures 242 px; the floor guards against a
  // degenerate mask making the claim vacuous, not against normal variation.
  ok(inNW > 150 && matchG === inNW,
    `polarity: every pixel of the NW corner region is GRASS on the composed tile (${matchG}/${inNW}) — swapped sides would fail this at 0`);
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
ok(r0[0].chips.join("/") === "Clean #0/Set #1" && r0[1].chips.join("/") === "Clean #0",
  `each side lists exactly its own ground's COMPOSED passes, no Raw among them (${r0[0].chips.join("/")} | ${r0[1].chips.join("/")})`);
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

ok(errs.length === 0, `no page errors (${errs[0] ?? "none"})`);
await b.close();
console.log(fails.length ? `\nTRANS-COMPOSE CHECKS FAILED (${fails.length})` : "\nALL TRANS-COMPOSE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
