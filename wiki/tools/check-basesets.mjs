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
/* STILL FNV-1a AT ITS CORE, with fmix32 on top — checked against the
 * algorithm's own published values so "we ported it consistently wrong" stays
 * out, and against the finalizer separately so a copy that drops the avalanche
 * (the striping bug) cannot pass by matching the core alone. */
{
  const core = (s2) => { let h = 0x811c9dc5; for (let i = 0; i < s2.length; i++) { h ^= s2.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
  const fmix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16; return h >>> 0; };
  ok(core("") === 2166136261 && core("a") === 3826002220,
    "the core is genuine FNV-1a/32, against the algorithm's own published values");
  ok(["", "a", "grass", "bts1|tile|1|4|9"].every((s2) => fnv1a(s2) === fmix(core(s2))),
    "and the published hash is that core through fmix32 — a copy that drops the avalanche fails here, not in the field");
}

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

/* ---- 1b. THE GROUND MUST NOT STRIPE (maintainer 2026-08-27: "the random tile
 * function when looking at a set often give me vertical stripes with the same
 * texture used vertically several tiles before changing tile ... Why would we
 * holding on to a tile to create vertical visible stripes?").
 *
 * It did, and the cause was in the SPEC, not the preview: FNV-1a's last byte
 * moves only the low bits while the pick reads h/2^32, and every key ends in
 * the coordinate that varies — so a cell matched the one BELOW it 89.2% of the
 * time against a 14.3% chance, in runs of 50. A hash without avalanche is
 * invisible in every unit test that checks one value at a time; only the field
 * shows it. So the field is what is measured here.
 *
 * Both axes, because fixing one by reordering the key would have moved the
 * defect to the other. */
{
  const N = 60;
  for (const members of [2, 4, 7, 10]) {
    const grid = [];
    for (let y = 0; y < N; y++) {
      const row = [];
      for (let x = 0; x < N; x++) row.push(pickWeighted(Array(members).fill(1), fnv1a(`bts1|tile|1|${x}|${y}`) / 4294967296));
      grid.push(row);
    }
    let right = 0, down = 0, tot = 0;
    for (let y = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++) {
      tot++;
      if (grid[y][x] === grid[y][x + 1]) right++;
      if (grid[y][x] === grid[y + 1][x]) down++;
    }
    const chance = 100 / members;
    const pr = 100 * right / tot, pd = 100 * down / tot;
    // Half again over chance is generous for 3,481 samples and nowhere near
    // the 6x the striping bug produced.
    ok(pr < chance * 1.5 && pd < chance * 1.5,
      `a ${members}-tile set does not stripe: neighbours match ${pr.toFixed(1)}% across and ${pd.toFixed(1)}% down, against ${chance.toFixed(1)}% by chance`);
    const hist = Array(members).fill(0);
    for (const row of grid) for (const v of row) hist[v]++;
    const lo = Math.min(...hist), hi = Math.max(...hist);
    ok(hi / lo < 1.35, `and every tile of it gets its share (${lo}-${hi} of ${N * N})`);
  }
}

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
/* ---- 3. CLEAN #0 CLEANS EVERY SURFACE, paving included (maintainer
 * 2026-08-27: "if I press on Brown Paving Stone and click on Clean #0 the
 * tiles doesn't become clean ... The idea with the big task was to normalize
 * and make all tile types work the same way"). Paving is the ground whose
 * after-art keeps its texture, so it is the one where inheriting the shipped
 * art instead of composing shows up — grass would pass either way. */
await p.goto(`${W}#/world/brown_paving_stone`, { waitUntil: "load" });
await p.waitForTimeout(2500);
const topColours = async () => p.evaluate(() => {
  const cv = document.querySelector(".grid .card canvas");
  if (!cv || !cv.width) return null;
  try {
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    const s2 = new Set();
    for (let y = 10; y < 26; y++) for (let x = 8; x < 56; x++) {
      const i = (y * cv.width + x) * 4;
      if (d[i + 3] > 200) s2.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
    return s2.size;
  } catch { return "tainted"; }
});
const passTo = async (name) => {
  await p.evaluate((n) => [...document.querySelectorAll('.ground-pass [data-bar="wiki-world-view"] button')].find((x) => x.textContent.trim() === n)?.click(), name);
  await p.waitForTimeout(500);
  await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /On top of/.test(x.textContent))?.click());
  await p.waitForTimeout(2200);
};
await passTo("Clean #0");
const cleanTop = await topColours();
ok(cleanTop === 1, `paving under Clean #0 composes a FLAT top — one colour, not its texture (${cleanTop})`);
await passTo("Set #1");
const setTop = await topColours();
ok(typeof setTop === "number" && setTop > 3, `and Set #1 puts the set's texture there (${setTop} colours)`);

/* ---- 4. A PAGE OF MANY GROUNDS OFFERS ONLY CLEAN/RAW (maintainer 2026-08-27:
 * "Some might have 1 some 3 some 8... The only safe option here is Clean #0
 * ... Raw") — and its cards obey the bar, not the stored set preference. */
await p.evaluate(() => { localStorage.setItem("wiki-world-view", "set:1"); });
await p.goto(`${W}#/world`, { waitUntil: "load" });
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(2800);
const over = await p.evaluate(() => ({
  chips: [...document.querySelectorAll('[data-bar="wiki-world-view"] button')].map((x) => x.textContent.trim() + (x.classList.contains("sel") ? "*" : "")),
  pavingComposed: (() => {
    const c = [...document.querySelectorAll(".grid .card")].find((x) => /Brown Paving/.test(x.textContent));
    const cv = c?.querySelector("canvas");
    if (!cv || !cv.width) return null;
    try {
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      const s2 = new Set();
      for (let y = 10; y < 26; y++) for (let x = 8; x < 56; x++) { const i = (y * cv.width + x) * 4; if (d[i + 3] > 200) s2.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); }
      return s2.size;
    } catch { return "tainted"; }
  })(),
}));
ok(over.chips.length === 2 && over.chips[0] === "Clean #0*" && over.chips[1] === "Raw",
  `the mixed-grounds overview offers exactly Clean #0 / Raw, Clean selected even with set:1 stored (${over.chips.join(" ")})`);
ok(over.pavingComposed === 1,
  `and its paving card obeys the bar — a flat clean top, not the stored set (${over.pavingComposed} colour)`);
/* ---- 5. OWN TOP OUTRANKS THE COMPOSITION (maintainer 2026-08-27: "I want a
 * new per tile option ... own top ... will have higher priority and be used
 * instead of swapping out the top to the base tile sets top"). The mirror of
 * the wall designation, for the other face — and the priority is the claim,
 * so it is proven on the resolved art path, not on the chip. */
const tSaves = [];
await p.route("**/api/wiki/save", (r) => { tSaves.push(r.request().postDataJSON()); r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
await p.goto(`${W}#/world/grass/ice`, { waitUntil: "load" });
await p.waitForTimeout(2800);
const topState = () => p.evaluate(() => {
  const card = document.querySelector(".world-cand");
  const row = [...card.querySelectorAll(".wall-mode")].find((r) => r.textContent.startsWith("Top"));
  return {
    chips: [...(row?.querySelectorAll("button") ?? [])].map((x) => x.textContent.trim() + (x.classList.contains("sel") ? "*" : "")),
    face: card.querySelector(".tile-preview")?.dataset.face ?? null,
  };
});
const t0 = await topState();
ok(t0.chips.join("/") === "base tile top*/own top",
  `every tile carries the Top designation, defaulting to the ground's surface (${t0.chips.join("/")})`);
ok(/^sub:/.test(t0.face ?? ""), `and by default the top IS composed (${String(t0.face).slice(0, 34)}…)`);
await p.evaluate(() => {
  const row = [...document.querySelector(".world-cand").querySelectorAll(".wall-mode")].find((r) => r.textContent.startsWith("Top"));
  [...row.querySelectorAll("button")].find((x) => x.textContent.trim() === "own top")?.click();
});
await p.waitForTimeout(1400);
const t1 = await topState();
ok(!/^sub:/.test(t1.face ?? "") && /_after\.webp$/.test(t1.face ?? ""),
  `own top wins over the composition — the tile draws its own art, no sub: (${String(t1.face).split("/").pop()})`);
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(900);
const tSave = tSaves.at(-1);
ok(tSave?.file === "tuning/tile_tops" && Object.values(tSave.set ?? {})[0]?.own_top === true,
  `and Commit posts own_top on the tile's own key (${Object.keys(tSave?.set ?? {})[0]})`);
await p.evaluate(() => {
  const row = [...document.querySelector(".world-cand").querySelectorAll(".wall-mode")].find((r) => r.textContent.startsWith("Top"));
  [...row.querySelectorAll("button")].find((x) => x.textContent.trim() === "base tile top")?.click();
});
await p.waitForTimeout(900);
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(900);
ok(Object.values(tSaves.at(-1)?.set ?? {})[0] === null,
  "setting it back DELETES the entry — the file only ever names the exceptions");
/* ---- 6. A TOPS MEMBER DRAWS WHAT THE AUDITION DRAWS (maintainer 2026-08-28,
 * on a Set #2 field glowing beside its clean ring: "Why is this ground so
 * bright? Didn't you normalize all tile tops to fit togather?"). The art WAS
 * normalized — in the published post pass — but memberArt's tops branch
 * predated it and still served the raw sheet, so one tile drew corrected in
 * the audition centre and 35 V-units brighter in the set field around it.
 * Asserted on the resolved path AND on pixels, against the clean plate the
 * eye compares it with. */
{
  const V = await p.evaluate(async () => {
    const tops = window.__wiki.state.data.worldMeta.tops ?? {};
    const ground = Object.keys(tops).find((g2) => (tops[g2] ?? []).some((c) => c.post));
    if (!ground) return { skip: true };
    const entry = tops[ground].find((c) => c.post);
    const art = window.__basesets.memberArt(ground, entry.id);
    const load = (u) => new Promise((r2) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => r2(i); i.onerror = () => r2(null); i.src = window.__basesets.assetUrl(u); });
    const meanV = async (u) => {
      const im = await load(u); if (!im) return null;
      const cv = document.createElement("canvas"); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(im, 0, 0);
      const d = cx.getImageData(0, 0, cv.width, cv.height).data;
      let s2 = 0, n = 0;
      for (let x = 0; x < cv.width; x++) {
        let t2 = -1, bo = -1;
        for (let y = 0; y < cv.height; y++) { if (d[(y * cv.width + x) * 4 + 3] > 8) { if (t2 < 0) t2 = y; bo = y; } }
        if (t2 < 0) continue;
        for (let y = t2; y <= bo - 17; y++) { const i2 = (y * cv.width + x) * 4; s2 += Math.max(d[i2], d[i2 + 1], d[i2 + 2]); n++; }
      }
      return n ? s2 / n : null;
    };
    return { ground, art, post: entry.post, raw: entry.id,
      memberV: await meanV(art), rawV: await meanV(entry.id),
      cleanV: await meanV(`tiles/plates/${ground}/clean.webp`) };
  });
  if (V.skip) { ok(false, "no tops sheet with a post pass — the fixture pool vanished"); }
  else {
    ok(V.art === V.post, `a tops set member resolves to the PUBLISHED post file, not the raw sheet (${String(V.art).split("/").pop()})`);
    ok(V.memberV != null && V.cleanV != null && Math.abs(V.memberV - V.cleanV) < 10,
      `and its drawn top sits WITH the clean colour (member V ${V.memberV?.toFixed(1)} vs clean ${V.cleanV?.toFixed(1)})`);
    ok(V.rawV != null && Math.abs(V.rawV - V.cleanV) > 15,
      `while the raw sheet it replaced really is the bright one — the fixture can see the bug (raw V ${V.rawV?.toFixed(1)})`);
  }
}
/* ---- 7. THE CLEAN TILE IS A FILE, NOT A COMPOSITE (maintainer 2026-08-28,
 * Grey Paving Stone's Clean #0 drawing a fully textured field). The old
 * sub: composite was correct when it worked — but its failure mode (a
 * tainted canvas on his phone) fell back to the plain textured after tile,
 * i.e. exactly the bug it existed to fix. The plate file cannot taint. */
{
  const clean = await p.evaluate(() => {
    const set0 = window.__basesets.groundSets("grey_paving_stone").find((s2) => s2.id === 0);
    return {
      art: window.__basesets.setCellArt(set0, 0, 0, "grey_paving_stone"),
      plate: window.__basesets.patternLib()?.plates?.grey_paving_stone?.clean ?? null,
    };
  });
  ok(clean.art === clean.plate && /\/clean\.webp$/.test(clean.art ?? ""),
    `Clean #0 draws the published clean plate itself — a plain file with no composite to fail (${clean.art})`);
  await p.goto(`${W}#/world/grey_paving_stone`, { waitUntil: "load" });
  await p.waitForTimeout(2600);
  const field = await p.evaluate(() => {
    const panel = [...document.querySelectorAll(".base-set")].find((x) => /Clean #0/.test(x.textContent));
    const cv = panel?.querySelector(".group-stage canvas");
    if (!cv?.width) return null;
    try {
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      const s2 = new Set();
      for (let y = Math.round(cv.height * 0.25); y < cv.height * 0.55; y++)
        for (let x = Math.round(cv.width * 0.3); x < cv.width * 0.7; x++) {
          const i = (y * cv.width + x) * 4; if (d[i + 3] > 200) s2.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        }
      return s2.size;
    } catch { return "tainted"; }
  });
  ok(field === 1, `and grey paving's Clean #0 field really is ONE colour on top — the ground he reported (${field})`);
}
ok(errs.length === 0, `no page errors (${errs[0] ?? "none"})`);
await b.close();

console.log(fails.length ? `\nBASE-TILE-SET CHECKS FAILED (${fails.length})` : "\nALL BASE-TILE-SET CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
