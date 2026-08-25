/* BASE TILE SETS: the model, the pick, and the two copies that must not drift.
 *
 * Three things are proven here, all of them things that fail SILENTLY:
 *
 * 1. THE BROWSER'S topSub AND wiki/lib/topsub.mjs AGREE PIXEL FOR PIXEL. The
 *    wiki composes in a canvas and the reference composes in Node; two copies
 *    of one rule drift, and the drift shows up as a ground that looks slightly
 *    different in the wiki than in whatever ports the reference. The first
 *    browser copy aligned on the tile APEX instead of the wall foot and was
 *    wrong by a row on most tiles — it passed every check that only looked at
 *    one tile, because on that tile the two answers agree.
 *
 * 2. THE BROWSER'S PICK MATCHES wiki/lib/basesets.mjs, which is the spec the
 *    game and the tiles agent port. If they disagree, the wiki previews a
 *    ground the game will not draw — and nothing errors.
 *
 * 3. THE PICK IS DETERMINISTIC AND HONOURS ZERO. A weight of 0 has to mean
 *    never, for a set ("the weight for using this set is 0") and for the clean
 *    member ("Setting this to 0% will always draw with texture") alike.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
import { decodeWebP } from "../lib/webp-pixels.mjs";
import { topSubPixels } from "../lib/topsub.mjs";
import { fnv1a, pickWeighted, setsFor, pickMember, TEST_VECTORS } from "../lib/basesets.mjs";

const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const ROOT = new URL("../../", import.meta.url).pathname;
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const REPO = process.env.REPO_URL ?? "http://127.0.0.1:8903/";

// ---- 0. the spec's own vectors still describe the spec ---------------------
ok(TEST_VECTORS.fnv1a.every(([s, v]) => fnv1a(s) === v),
  `the published hash vectors match the implementation (${TEST_VECTORS.fnv1a.length})`);
ok(TEST_VECTORS.pickWeighted.every(([ws, u, i]) => pickWeighted(ws, u) === i),
  `and the published pick vectors too (${TEST_VECTORS.pickWeighted.length})`);
// FNV-1a's own published constants, so "we ported it consistently wrong" is out.
ok(fnv1a("") === 2166136261 && fnv1a("a") === 3826002220,
  "and it really is FNV-1a/32, against the algorithm's own published values");

// ---- 1. the model's rules --------------------------------------------------
const empty = setsFor({}, "grass");
ok(empty.length === 1 && empty[0].id === 0 && empty[0].name === "Clean",
  `a ground with no entry still has Clean #0 — there is no "no sets" state (${empty.length})`);
const doc = { grounds: { grass: { sets: [
  { id: 2, name: "Lawn", weight: 0, members: [{ kind: "clean", weight: 1 }, { kind: "tile", id: "t2", tile: "b.webp", weight: 1 }] },
  { id: 1, name: "Meadow", weight: 3, members: [{ kind: "clean", weight: 0 }, { kind: "tile", id: "t1", tile: "a.webp", weight: 2 }] },
] } } };
const sets = setsFor(doc, "grass");
ok(sets.map((s) => s.id).join(",") === "0,1,2",
  `sets read back in id order with Clean inserted (${sets.map((s) => s.id).join(",")})`);
ok(sets.every((s) => s.members[0].kind === "clean"),
  "every set carries exactly one clean member, so 0% is always expressible");
// ZERO MEANS NEVER, both levels. The old base-tile weight clamped to a 0.1
// floor, which made "never" impossible to say at all.
const meadow = sets.find((s) => s.id === 1);
ok([0, 0.5, 0.999].every((u) => pickWeighted(meadow.members.map((m) => m.weight), u) === 1),
  "a clean weight of 0 is never picked, at any roll");
ok(pickWeighted(sets.map((s) => s.weight), 0.999) !== 2,
  "and a set weight of 0 is never picked either");
// DETERMINISM: the same cell always resolves to the same tile, or the ground
// shimmers between reloads and every screenshot argues with the last one.
const a1 = pickMember(meadow, 4, 7), a2 = pickMember(meadow, 4, 7);
ok(a1 === a2 || JSON.stringify(a1) === JSON.stringify(a2), "the same cell resolves to the same member every time");

// ---- 2. the browser copies agree with the reference ------------------------
const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 412, height: 900 } });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript((repo) => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", repo);
}, REPO);
await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p.waitForTimeout(2200);

const HASHES = ["", "a", "grass", "bts1|set|grass|r0", "bts1|tile|1|0|0", "bts1|tile|7|13|29"];
const PICKS = [[[1, 1], 0.5], [[0, 5], 0.0], [[3, 1], 0.74], [[3, 1], 0.76], [[0, 0], 0.5], [[2, 0, 1], 0.99]];
const browser = await p.evaluate(([hs, ps]) => ({
  hashes: hs.map((s) => window.__basesets.fnv1a(s)),
  picks: ps.map(([ws, u]) => window.__basesets.pickWeighted(ws, u)),
}), [HASHES, PICKS]);
ok(HASHES.every((s, i) => browser.hashes[i] === fnv1a(s)),
  `the browser's hash matches the spec on every input (${browser.hashes.length})`);
ok(PICKS.every(([ws, u], i) => browser.picks[i] === pickWeighted(ws, u)),
  `and so does its weighted pick, including the all-zero case (${browser.picks.join(",")})`);

/* THE COMPOSITOR, ACROSS THE TWO IMPLEMENTATIONS. Real repo art, several pairs,
 * compared byte for byte — the check the apex/wall-foot bug would have failed
 * on every tile but the one it was developed against. */
/* FIXTURES CHOSEN SO THE COMPARISON CAN SEE A ONE-ROW ERROR — measured, not
 * assumed. The first four pairs here were picked by hand and the gate passed
 * with the alignment deliberately broken, because three of them had apex and
 * wall-foot offsets that AGREE (nothing to see) and the fourth's base tile had
 * a top face with 0.0% row-to-row change (a shift moves nothing). A fixture
 * that cannot show the defect is worse than no fixture: it reports safety.
 *
 * `apex` and `foot` are the two candidate alignments; they must DIFFER, or the
 * wrong rule produces the right answer. `structure` is the share of top-face
 * pixels differing from the pixel below them; near zero and a row shift is
 * invisible whatever the offset. Both are re-measured below and asserted, so a
 * republished tile that flattens one of these fails loudly instead of quietly
 * blinding the check. Only 3 cells in the whole review set qualify. */
const PAIRS = [
  { keep: "tiles/review/grass__over__grass/0_after.webp", take: "tiles/base_candidates/grass/grass__to__grey_paving_stone__a18_s6.webp", apex: 8, foot: 9, structure: 0.819 },
  { keep: "tiles/review/grass__over__slime/0_after.webp", take: "tiles/base_candidates/grass/grass__to__grey_paving_stone__a18_s6.webp", apex: 8, foot: 9, structure: 0.819 },
  { keep: "tiles/review/ice__over__lava/0_after.webp", take: "tiles/base_candidates/ice/grass__to__ice__a14_s5.webp", apex: 10, foot: 9, structure: 0.481 },
  // Plus ordinary pairs, so the check also covers the common case.
  { keep: "tiles/review/light_soil__over__light_soil/0_after.webp", take: "tiles/base_candidates/light_soil/deep_water__to__light_soil__a14_s5.webp" },
  { keep: "tiles/review/snow__over__snow/0_after.webp", take: "tiles/base_candidates/snow/light_soil__to__snow__a00_s5.webp" },
];
const columnSpans = ({ w, h, pix }) => {
  const top = new Int16Array(w).fill(-1), bot = new Int16Array(w).fill(-1);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if ((pix[y * w + x] >>> 24) > 0) { if (top[x] < 0) top[x] = y; bot[x] = y; }
  return { top, bot };
};
const modeOf = (a) => { const m = new Map(); for (const v of a) m.set(v, (m.get(v) ?? 0) + 1); return [...m].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0]; };
function topStructure(d) {
  const s = columnSpans(d); let n = 0, c = 0;
  for (let x = 0; x < d.w; x++) {
    if (s.top[x] < 0) continue;
    for (let y = s.top[x]; y < s.bot[x] - 17; y++) { n++; if ((d.pix[y * d.w + x] & 0xffffff) !== (d.pix[(y + 1) * d.w + x] & 0xffffff)) c++; }
  }
  return n ? c / n : 0;
}
let agreed = 0, worst = 0, worstPair = "";
for (const pair of PAIRS) {
  const keepP = pair.keep, takeP = pair.take;
  const keep = decodeWebP(readFileSync(ROOT + keepP));
  const take = decodeWebP(readFileSync(ROOT + takeP));
  // A DISCRIMINATING FIXTURE STAYS DISCRIMINATING. Re-measure rather than trust
  // the numbers written above — the art is republished by another agent.
  if (pair.apex != null) {
    const sk = columnSpans(keep), st = columnSpans(take);
    const dTop = [], dBot = [];
    for (let x = 0; x < keep.w; x++) { if (sk.top[x] < 0 || st.top[x] < 0) continue; dTop.push(sk.top[x] - st.top[x]); dBot.push(sk.bot[x] - st.bot[x]); }
    const a = modeOf(dTop), f = modeOf(dBot), s2 = topStructure(take);
    ok(a === pair.apex && f === pair.foot && a !== f && s2 > 0.2,
      `${keepP.split("/")[2]} can still SEE a one-row error (apex ${a} vs foot ${f}, base top ${(s2 * 100).toFixed(1)}% structured)`);
  }
  const ref = topSubPixels(keep, take);
  const got = await p.evaluate(async ([k, t2]) => {
    const load = (u) => new Promise((r) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => r(i); i.onerror = () => r(null); i.src = window.__basesets.assetUrl(u); });
    const [a, c] = await Promise.all([load(k), load(t2)]);
    if (!a || !c) return { err: "load" };
    const cv = window.__basesets.topSub(a, c);
    if (!cv) return { err: "null" };
    const d = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
    return { w: cv.width, h: cv.height, px: [...d] };
  }, [keepP, takeP]);
  if (got.err) { ok(false, `${keepP.split("/")[2]}: the browser could not compose (${got.err})`); continue; }
  let diff = 0;
  for (let i = 0; i < ref.pix.length; i++) {
    const v = ref.pix[i];
    const r = got.px[i * 4], g = got.px[i * 4 + 1], bl = got.px[i * 4 + 2], al = got.px[i * 4 + 3];
    // The reference is 0xAARRGGBB; canvas data is RGBA bytes. Transparent
    // pixels carry undefined RGB in both, so only alpha is compared there.
    if (al !== (v >>> 24)) { diff++; continue; }
    if (al > 0 && (r !== ((v >> 16) & 255) || g !== ((v >> 8) & 255) || bl !== (v & 255))) diff++;
  }
  if (diff === 0) agreed++;
  if (diff > worst) { worst = diff; worstPair = keepP; }
}
ok(agreed === PAIRS.length,
  `the browser and wiki/lib/topsub.mjs compose the same pixels on all ${PAIRS.length} pairs (worst ${worst} px${worstPair ? " on " + worstPair : ""})`);
ok(errs.length === 0, `no page errors (${errs[0] ?? "none"})`);
await b.close();

console.log(fails.length ? `\nBASE-TILE-SET CHECKS FAILED (${fails.length})` : "\nALL BASE-TILE-SET CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
