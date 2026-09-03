/* FADE TILES: both grounds on one top, reviewed on the transition pair page
 * (maintainer 2026-08-28: "tiles the map-agent can use to start warming up
 * the player for a new ground-type long before the transition happens ... I
 * want to be able to approve/reject/give stars and add a note to all tiles
 * like this ... at the bottom of the transition pair page").
 *
 * THE REAL INDEX, not a stub (the tiles agent published tiles/fades/index.json
 * on 2026-08-28 — tiles3/fade-tiles@1, 3,795 tiles). The stub this replaces
 * hid two things the data made real: the index keys each tile by its
 * GENERATION direction, so one unordered pair is TWO keys with disjoint
 * halves that must be merged ("both pages will ofc show the same tiles"),
 * and merged pairs reach 80 tiles, so the section paginates 12 at a time.
 * Only the no-index case still stubs — that is the world it tests.
 */
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const ROOT = new URL("../../", import.meta.url).pathname;
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

// ---- 0. the published index is sane, before any browser opens --------------
const IDX = JSON.parse(readFileSync(ROOT + "tiles/fades/index.json", "utf8"));
const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));   // ground types, for the uncovered-pair search
const grounds = (D.worldMeta?.groundTypes ?? []).map((g2) => g2.id);
const covered = (a, b2) => IDX.pairs[`${a}__to__${b2}`] || IDX.pairs[`${b2}__to__${a}`];
const nameOf = (id) => (D.worldMeta?.groundTypes ?? []).find((g2) => g2.id === id)?.name ?? id;
ok(IDX.schema === "tiles3/fade-tiles@1", `the index speaks the posted contract (${IDX.schema})`);
const allTiles = Object.values(IDX.pairs).flat();
ok(allTiles.every((t) => t.key && t.file && t.pct && Object.values(t.pct).every((v) => v >= 0 && v <= 100)
  && Math.abs(Object.values(t.pct).reduce((a, b) => a + b, 0) - 100) < 1),
  `every tile carries key, file and percentages that sum to 100 (${allTiles.length} tiles)`);
const gone = allTiles.filter((t) => !existsSync(ROOT + t.file));
ok(gone.length === 0, `every published file exists on disk (${gone.length ? gone[0].file : "all " + allTiles.length})`);

// The grass↔ice pair, merged the way the page must merge it.
const MERGED = [...(IDX.pairs["grass__to__ice"] ?? []), ...(IDX.pairs["ice__to__grass"] ?? [])];
ok(MERGED.length > 12 && (IDX.pairs["grass__to__ice"] ?? []).length > 0 && (IDX.pairs["ice__to__grass"] ?? []).length > 0,
  `grass↔ice is published as two orientation halves (${(IDX.pairs["grass__to__ice"] ?? []).length}+${(IDX.pairs["ice__to__grass"] ?? []).length}=${MERGED.length}) — the merge is what there is to test`);
const grassTop = Math.round(Math.max(...MERGED.map((t) => t.pct.grass)));
const iceTop = Math.round(Math.max(...MERGED.map((t) => t.pct.ice)));

const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = []; const saves = [];
p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.route("**/api/wiki/save", (r) => { saves.push(r.request().postDataJSON()); r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
await p.addInitScript(() => { localStorage.setItem("wiki-admin-token", "gate"); localStorage.setItem("ml-staging-base", "http://127.0.0.1:8903/"); });

const read = () => p.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent ?? "",
  pill: (() => { const t = [...document.querySelectorAll(".panel-title")].find((x) => /Fade tiles/.test(x.textContent)); return t ? t.querySelector(".pill")?.textContent.trim() : null; })(),
  panel: [...document.querySelectorAll(".panel-title")].map((x) => x.textContent.replace(/\s+/g, " ").trim()).find((x) => /Fade tiles/.test(x)) ?? null,
  rows: [...document.querySelectorAll(".fade-tile b")].map((x) => x.textContent.trim()),
  scenes: [...document.querySelectorAll(".fade-tile canvas")].filter((c) => c.width > 200).length,
  fb: document.querySelectorAll(".fade-tile .fb-row").length,
  more: [...document.querySelectorAll("button")].map((x) => x.textContent.trim()).find((x) => /^Show 12 more/.test(x)) ?? null,
}));

/* HIS OWN VERDICTS MUST NOT BE WHAT THIS GATE MEASURES (2026-09-02): the fade
 * list now puts unreviewed tiles first, so a pair he has partly reviewed
 * would reorder sections 1–3 by his week rather than by %. The pair's tile
 * verdicts are cleared in the page (never committed — save is captured)
 * before the first read, and re-applied deliberately in section 6. */
const clearPairVerdicts = () => p.evaluate((keys) => {
  const e = window.__wiki?.state?.feedback?.tiles?.entries; if (!e) return 0;
  let n = 0; for (const k of keys) if (e[k]) { delete e[k]; n++; } return n;
}, MERGED.map((x) => x.key));
const reopen = async (hash) => {
  await p.goto(`${W}#/world`, { waitUntil: "load" });   // leave the pair, so the visit's frozen order is dropped
  await p.waitForTimeout(800);
  await clearPairVerdicts();
  await p.evaluate((h2) => { location.hash = h2; }, hash);
  await p.waitForTimeout(5000);
};
// ---- 1. the section: MERGED, sorted by the page's first ground, paginated --
await p.goto(`${W}#/world/transition/grass__to__ice`, { waitUntil: "load" });
await p.waitForTimeout(5000);
await reopen("#/world/transition/grass__to__ice");
const g = await read();
ok(!!g.panel && /most grass first/.test(g.panel), `the pair page grows a Fade tiles section, sorted for ITS first ground (${g.panel})`);
ok(g.pill === String(MERGED.length),
  `the count is BOTH orientation halves merged — the index splits one pair across two keys (${g.pill} of ${MERGED.length})`);
ok(g.rows.length === 12 && g.rows[0].startsWith(`${grassTop}% grass`),
  `twelve at a time, the grass-heaviest of the whole merged pair first (${g.rows[0]})`);
ok(g.scenes === 12 && g.fb === 12, `each shown tile gets a wandering-edge field and the standard verdict row (${g.scenes} scenes, ${g.fb} rows)`);
ok(g.more === `Show 12 more (${MERGED.length - 12} left)`,
  `and the rest wait behind a button — eighty eager fields is a hung phone (${g.more})`);

// ---- 2. show more really shows more ---------------------------------------
await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /^Show 12 more/.test(x.textContent))?.click());
await p.waitForTimeout(3500);
const g2 = await read();
ok(g2.rows.length === 24 && g2.rows[0] === g.rows[0],
  `Show 12 more appends the next twelve without reshuffling the first (${g2.rows.length} rows)`);
const descOK = g2.rows.every((r, i) => i === 0 || parseInt(g2.rows[i - 1]) >= parseInt(r));
ok(descOK, "and the visible order is monotonically grass-descending across the page break");

// ---- 3. the reversed page: same merged tiles, the other way up -------------
await reopen("#/world/transition/ice__to__grass");
const i2 = await read();
ok(/^Ice/.test(i2.h1), `the reversed route keeps ITS orientation — the page is Ice ↔ grass, not renamed (${i2.h1})`);
ok(i2.pill === String(MERGED.length), `the reversed page shows the SAME merged set (${i2.pill} of ${MERGED.length})`);
ok(i2.rows.length >= 12 && i2.rows[0].startsWith(`${iceTop}% ice`),
  `…sorted by ice instead, and its ice-heaviest tile comes from whichever half holds it (${i2.rows[0]})`);

// ---- 4. majority-side placement -------------------------------------------
/* "Display the fade tile on the grass side if grass is >= 50% and on the ice
 * side if ice is > 50%." Probed through the scene's own cell audit. The audit
 * array grows per RENDER, so the truth is the last entry per tile. */
const sides = await p.evaluate(() => {
  const last = new Map();
  for (const t of window.__wikiFades ?? []) last.set(t.key, t);
  return [...last.values()];
});
ok(sides.length >= 12, `the scenes publish their cell audit, one per rendered tile (${sides.length})`);
/* ONCE, NEAR THE CENTRE, ON ITS OWN SIDE (maintainer 2026-08-28: "I also
 * only want to see 1 tile near the center (but on the current side of the
 * transition). The 'fade' tiles are not meant to be repeated like that!").
 * And ONE SHARED EDGE: "you should not randomize the 'A wandering edge'.
 * Keep it the same and somewhat centered" — every scene must walk the
 * identical boundary, clamped off the borders. */
const astray = sides.filter((t) => !(t.majorityCells > 0 && t.fadeOnMajority === 1 && t.fadeOnMinority === 0));
ok(astray.length === 0, astray.length
  ? `${astray[0].key}: fade tile astray (${astray[0].fadeOnMajority} on ${astray[0].majority} of ${astray[0].majorityCells} pure cells, ${astray[0].fadeOnMinority} on the minority side)`
  : `every audited scene shows the fade tile EXACTLY ONCE, on its majority side (${sides.length} scenes)`);
const walks = new Set(sides.map((t) => (t.walk ?? []).join(",")));
ok(walks.size === 1 && sides.every((t) => (t.walk ?? []).every((w) => w >= 2 && w <= 5)),
  `every scene walks the SAME edge, held off the borders (${[...walks][0]})`);
const far = sides.filter((t) => !(t.spot && t.spot.dist <= 2.6));
ok(far.length === 0, far.length
  ? `${far[0].key}: fade tile far from centre (${JSON.stringify(far[0].spot)})`
  : `and the tile stands near the centre of the field (max dist ${Math.max(...sides.map((t) => t.spot?.dist ?? 9))})`);

// ---- 4c. a pair the index does not cover SAYS SO (maintainer 2026-08-28,
// black_rock ↔ parquet floor: "doesn't render/show any fading tiles" — the
// silent absence read as a broken page) -------------------------------------
{
  /* THE UNCOVERED PAIR IS FOUND, NOT NAMED. black_rock↔parquet_floor was the
   * case in August; the tiles agent covered it on 2026-09-02 (spot fades, 203
   * pairs), and a gate pinned to one pair would then be asserting that their
   * work had not happened. Any ground pair the index lacks is the case. */
  // Only a PUBLISHED transition has a pair page at all (any other pair is
  // "Unknown transition"), so the case is an uncovered pair among those.
  const known = (D.worldMeta?.transitions ?? []).map((x) => [x.a, x.b]);
  const bare = known.find(([a, b2]) => !covered(a, b2)) ?? null;
  const [bareA, bareB] = bare ?? [null, null];
  ok(true, bareA ? `a published transition the index does not cover exists — ${bareA}↔${bareB} is the case under test`
    : `every published transition (${known.length}) is covered by the index — the empty-pair path has no live case today, so its assertion is skipped rather than faked`);
  if (bareA) {
  await p.goto(`${W}#/world/transition/${bareA}__to__${bareB}`, { waitUntil: "load" });
  await p.waitForTimeout(3000);
  const empt = await p.evaluate(() => {
    const t2 = [...document.querySelectorAll(".panel-title")].find((x) => /Fade tiles/.test(x.textContent));
    return { panel: !!t2, pill: t2?.querySelector(".pill")?.textContent.trim(),
      says: t2?.parentElement?.querySelector("p.muted")?.textContent ?? "" };
  });
  ok(empt.panel && empt.pill === "0" && /published no fade tiles/.test(empt.says),
    `an uncovered pair shows the section saying WHY it is empty (${empt.says.slice(0, 56)}…)`);
  }
  // back to a covered pair — section 5 stars a real fade card
  await p.goto(`${W}#/world/transition/ice__to__grass`, { waitUntil: "load" });
  await p.waitForTimeout(4000);
}

// ---- 4d. the World ledger names the pairs he has not touched (maintainer
// 2026-08-28: "if there is a pair that doesn't have a single accept/reject I
// must have missed it") ------------------------------------------------------
{
  // recomputed HERE from the index + the feedback the PAGE holds (the gate
  // serves feedback.tiles empty — see the /api/live/state route above — so
  // the disk file is not what the page is looking at), independently
  const fbDoc = { entries: await p.evaluate(() => window.__wiki?.state?.feedback?.tiles?.entries ?? {}) };
  const merged = new Map();
  for (const [k, list] of Object.entries(IDX.pairs)) {
    const g = k.split("__to__").sort().join("|");
    if (!merged.has(g)) merged.set(g, []);
    merged.get(g).push(...list.map((t) => t.key));
  }
  const withTiles = [...merged.entries()].filter(([, keys]) => keys.length);
  const expUntouched = withTiles.filter(([, keys]) => !keys.some((k2) => {
    const e = fbDoc.entries?.[k2];
    return e && (e.rating || e.status);
  })).length;
  await p.goto(`${W}#/world`, { waitUntil: "load" });
  await p.waitForTimeout(3500);
  const led = await p.evaluate(() => {
    const rows = [...document.querySelectorAll(".ledger-line, .ledger-row, div")]
      .find((x) => /Fade tiles/.test(x.textContent) && /untouched|carries|votes/.test(x.textContent));
    // THE FADE LINE'S OWN PILL. The World page also carries a bare "untouched"
    // pill on the tops line, and the first match on the page was that one.
    const pill = [...document.querySelectorAll(".pill")].map((x) => x.textContent.trim()).find((t2) => /^\d+ untouched$|^all visited$/.test(t2));
    const jumps = [...document.querySelectorAll(".ledger-jump button")].map((x) => x.textContent.trim()).filter((t2) => /↔/.test(t2));
    return { has: !!rows, pill, jumps };
  });
  ok(led.has, "the World ledger carries a Fade tiles line");
  ok(expUntouched === 0 ? led.pill === "all visited" : led.pill === `${expUntouched} untouched`,
    `its count is the truth recomputed from the index and his feedback (${led.pill} vs expected ${expUntouched})`);
  // A pair with nothing published is never offered as missed. Checked for
  // EVERY uncovered pair, by the ground names the ledger prints.
  const uncoveredNamed = (D.worldMeta?.transitions ?? []).filter((x) => !covered(x.a, x.b)).map((x) => [nameOf(x.a), nameOf(x.b)]);
  const offeredEmpty = led.jumps.filter((t2) => uncoveredNamed.some(([na, nb]) => new RegExp(na, "i").test(t2) && new RegExp(nb, "i").test(t2)));
  ok(offeredEmpty.length === 0,
    `a pair with nothing published is never offered as missed — there is nothing there to vote on (${uncoveredNamed.length} uncovered pairs checked${offeredEmpty.length ? "; offered: " + offeredEmpty[0] : ""})`);
  if (expUntouched > 0) {
    await p.evaluate(() => [...document.querySelectorAll(".ledger-jump button")].find((x) => /↔/.test(x.textContent))?.click());
    await p.waitForTimeout(3000);
    ok(await p.evaluate(() => /transition/.test(location.hash) && !!document.querySelector("h1")),
      "and its jump button lands on the pair page, fade review at the bottom");
  }
}

// ---- 5. verdicts ride the tiles feedback file on the tile's own key --------
await p.evaluate(() => { const r = document.querySelector(".fade-tile .fb-row"); r.querySelectorAll(".stars button")[3]?.click(); });
await p.waitForTimeout(500);
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(900);
const s2 = saves.at(-1);
ok(s2?.file === "feedback/tiles" && /^tiles\/fades\//.test(Object.keys(s2.set ?? {})[0] ?? ""),
  `a star commits to feedback/tiles on the tile's own stable key (${Object.keys(s2?.set ?? {})[0]})`);

// ---- 6. no index, no section ----------------------------------------------
const p2 = await ctx.newPage();
await p2.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p2.route("**/tiles/fades/index.json*", (r) => r.fulfill({ status: 404, body: "" }));
await p2.addInitScript(() => { localStorage.setItem("wiki-admin-token", "gate"); localStorage.setItem("ml-staging-base", "http://127.0.0.1:8903/"); });
await p2.goto(`${W}#/world/transition/grass__to__ice`, { waitUntil: "load" });
await p2.waitForTimeout(2600);
ok(await p2.evaluate(() => ![...document.querySelectorAll(".panel-title")].some((x) => /Fade tiles/.test(x.textContent))),
  "with no index (a world before the tiles agent published) the section simply is not there");
await p2.close();
ok(errs.length === 0, `no page errors (${errs[0] ?? "none"})`);

// ---- 6. unreviewed first, each block by %, and the order holds while he works
/* Maintainer 2026-09-02: "the same sorting, but unreviewed tiles should have a
 * higher sort order. So first comes the tiles I still have to approve/reject
 * (sorted individually the same way). Once the tiles I have still not
 * approved/rejected is over the already reviewed tiles will come (again
 * individually sorted by %)." */
{
  const byGrass = [...MERGED].sort((a, b2) => b2.pct.grass - a.pct.grass);
  const top2 = byGrass.slice(0, 2).map((x) => x.key);        // the two grass-heaviest get verdicts
  await p.goto(`${W}#/world`, { waitUntil: "load" });
  await p.waitForTimeout(800);
  await clearPairVerdicts();
  await p.evaluate((keys) => {
    const f = window.__wiki.state.feedback.tiles; f.entries ??= {};
    f.entries[keys[0]] = { status: "approved", updated_at: new Date().toISOString() };
    f.entries[keys[1]] = { status: "rejected", updated_at: new Date().toISOString() };
  }, top2);
  await p.evaluate(() => { location.hash = "#/world/transition/grass__to__ice"; });
  await p.waitForTimeout(5000);
  const rows = () => p.evaluate(() => ({
    pct: [...document.querySelectorAll(".fade-tile b")].map((x) => parseInt(x.textContent)),
    keys: [...document.querySelectorAll(".fade-tile .fade-key")].map((x) => x.title),
    reviewed: [...document.querySelectorAll(".fade-tile")].map((x) => x.classList.contains("reviewed")),
    divider: document.querySelector(".fade-divider")?.textContent ?? null,
    pill: [...document.querySelectorAll(".panel-title .pill")].map((x) => x.textContent.trim()).find((x) => /to review first|all reviewed/.test(x)) ?? null,
    probe: window.__wikiFadeOrder ?? null,
  }));
  // show everything so both blocks are on the page
  // To the END: 151 tiles is thirteen presses, and the seam sits at row 150.
  for (let i = 0; i < 24; i++) {
    const more = await p.evaluate(() => { const b2 = [...document.querySelectorAll("button")].find((x) => /^Show 12 more/.test(x.textContent)); if (b2) { b2.click(); return true; } return false; });
    if (!more) break;
    await p.waitForTimeout(2200);
  }
  const r6 = await rows();
  const firstDone = r6.reviewed.indexOf(true);
  ok(firstDone === MERGED.length - 2 && r6.reviewed.slice(firstDone).every(Boolean),
    `the two judged tiles sink below EVERY unreviewed one, however grass-heavy they are (reviewed block starts at row ${firstDone + 1} of ${r6.keys.length}; probe ${JSON.stringify(r6.probe)})`);
  ok(!top2.includes(r6.keys[0]) && r6.pct[0] === Math.round(byGrass[2].pct.grass),
    `so the page opens on the grass-heaviest tile still WAITING for a verdict (${r6.pct[0]}% grass)`);
  const desc = (a) => a.every((v, i) => i === 0 || a[i - 1] >= v);
  ok(desc(r6.pct.slice(0, firstDone)) && desc(r6.pct.slice(firstDone)),
    `each block keeps the % order on its own (unreviewed ${r6.pct[0]}→${r6.pct[firstDone - 1]}, reviewed ${r6.pct[firstDone]}→${r6.pct[r6.pct.length - 1]})`);
  ok(r6.keys.slice(firstDone).join() === top2.join(), `and the reviewed block is exactly the two he judged, grass-descending (${r6.keys.slice(firstDone).map((k) => k.split("/").pop()).join(", ")})`);
  ok(/already reviewed/.test(r6.divider ?? ""), `the seam between the blocks is named (“${r6.divider}”)`);
  ok(r6.pill === `${MERGED.length - 2} to review first`, `and the panel says how many are left (${r6.pill})`);
  // A verdict given mid-visit must not move the row under his thumb.
  const before = await rows();
  await p.evaluate(() => { const row = document.querySelector(".fade-tile"); [...row.querySelectorAll("button")].find((x) => /approve/.test(x.textContent))?.click(); });
  await p.waitForTimeout(2500);
  const after = await rows();
  ok(after.keys[0] === before.keys[0] && after.keys.join() === before.keys.join(),
    `approving the first tile leaves the order exactly where it was — it re-sorts on the next visit, not under his thumb (${after.keys[0].split("/").pop()} still first)`);
  ok(after.pill === `${MERGED.length - 3} to review first`, `while the count already says one fewer is left (${after.pill})`);
  await reopen("#/world/transition/grass__to__ice");
  const r7 = await rows();
  ok(r7.pill === `${MERGED.length} to review first` && r7.reviewed.indexOf(true) === -1,
    `coming back with the verdicts cleared, everything is unreviewed again and the order is the plain % order (${r7.pill})`);
}

// ---- 7. a save deletes ONLY what he deleted -------------------------------
/* 2026-09-02: 6,890 tile verdicts were erased server-side (a 1 MB file the
 * contents API returned without content). Auditing the client for a second
 * way to lose them found one: a save sent `null` for every touched id whose
 * value was absent — right after an explicit clear, catastrophic after the
 * document under him was replaced. Now only an id he actually cleared goes
 * out as a deletion; a touched-but-absent id is dropped from the save. */
{
  await reopen("#/world/transition/grass__to__ice");
  saves.length = 0;
  const key0 = await p.evaluate(() => document.querySelector(".fade-tile .fade-key")?.title ?? null);
  // (i) reject, then un-reject: an explicit clear IS a deletion
  await p.evaluate(() => { const row = document.querySelector(".fade-tile"); [...row.querySelectorAll("button")].find((x) => /✕/.test(x.textContent))?.click(); });
  await p.waitForTimeout(400);
  await p.evaluate(() => { const row = document.querySelector(".fade-tile"); [...row.querySelectorAll("button")].find((x) => /✕/.test(x.textContent))?.click(); });
  await p.waitForTimeout(400);
  // (ii) an id he never touched by hand, absent from the doc — as after a replaced document
  await p.evaluate(() => { const st = window.__wiki.state; (st.touched["feedback/tiles"] ??= new Set()).add("tiles/fades/never_cleared_by_him"); st.dirty.add("feedback/tiles"); });
  await p.evaluate(() => document.querySelector("#save-btn")?.click());
  await p.waitForTimeout(1500);
  const payload = saves.find((x) => x?.file === "feedback/tiles")?.set ?? {};
  ok(key0 && key0 in payload && payload[key0] === null, `an explicit un-reject is sent as a deletion (${key0?.split("/").pop()} → null)`);
  ok(!("tiles/fades/never_cleared_by_him" in payload), `a touched id he never cleared is NOT sent as a deletion (keys sent: ${Object.keys(payload).length})`);
}

// ---- 8. how much of each pair is LEFT, on the list, sortable ---------------
/* Maintainer 2026-09-02: "I have a hard time knowing how much fade tiles I
 * have left to review for a given tile pair ... It's very hard to click on
 * each pair to see if I have reviewed this already or not." */
{
  const grassPairs = Object.keys(IDX.pairs).filter((k) => k.split("__to__").includes("grass"));
  const perPair = new Map();
  for (const k of grassPairs) {
    const [a, b2] = k.split("__to__"); const g = [a, b2].sort().join("|");
    perPair.set(g, (perPair.get(g) ?? 0) + (IDX.pairs[k] ?? []).filter((x) => x.file && x.pct).length);
  }
  await p.goto(`${W}#/world`, { waitUntil: "load" });
  await p.waitForTimeout(800);
  // EVERY fade verdict goes, not just grass↔ice: the local harness has no
  // /api/live/state, so the page falls back to the repo's real feedback file
  // and every other grass pair still carries his verdicts.
  await p.evaluate(() => { const e = window.__wiki?.state?.feedback?.tiles?.entries ?? {}; for (const k of Object.keys(e)) if (k.startsWith("tiles/fades/")) delete e[k]; });
  // seed: grass↔ice fully reviewed, so it is the one pair with 0 left
  await p.evaluate((keys) => { const f = window.__wiki.state.feedback.tiles; f.entries ??= {}; for (const k of keys) f.entries[k] = { status: "approved", updated_at: "x" }; }, MERGED.map((x) => x.key));
  await p.evaluate(() => { try { localStorage.setItem("wiki-fade-order", "all"); } catch {} location.hash = "#/world/grass"; });
  await p.waitForTimeout(3500);
  await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /^Fade/.test(x.textContent.trim()))?.click());
  await p.waitForTimeout(2500);
  const rows = () => p.evaluate(() => [...document.querySelectorAll("a.trans-row")].map((r) => ({
    href: r.getAttribute("href"), text: r.querySelector(".fade-left")?.textContent ?? null,
    left: +(r.querySelector(".fade-left")?.dataset.left ?? -1), total: +(r.querySelector(".fade-left")?.dataset.total ?? -1) })));
  const r0 = await rows();
  ok(r0.length > 3 && r0.every((r) => r.text), `every neighbour on the Fade tab says how many fade tiles are left (${r0.length} rows, e.g. “${r0[0]?.text}”)`);
  const ice = r0.find((r) => /grass__to__ice|ice__to__grass/.test(r.href));
  ok(ice && ice.left === 0 && /all \d+ reviewed/.test(ice.text), `a fully reviewed pair says so (${ice?.text})`);
  const other = r0.find((r) => r.left > 0);
  ok(other && other.left === other.total && /of \d+ fades left/.test(other.text), `an unreviewed pair counts every tile as left (${other?.text})`);
  // the numbers are the index's numbers
  const wrong = r0.filter((r) => { const m = /transition\/([^_]+(?:_[^_]+)*)__to__(.+)$/.exec(r.href); if (!m) return false; const g = [m[1], m[2]].sort().join("|"); return perPair.has(g) && r.total !== perPair.get(g); });
  ok(wrong.length === 0, `each total is the merged index count for that pair (${wrong.length} wrong)`);
  // "most left first": ice (0 left) sinks to the bottom
  await p.evaluate(() => [...document.querySelectorAll('[data-bar="fade-order"] button')].find((x) => /most left first/.test(x.textContent))?.click());
  await p.waitForTimeout(2500);
  const r1 = await rows();
  const desc = r1.every((r, i) => i === 0 || r1[i - 1].left >= r.left);
  ok(desc && r1[r1.length - 1].left === 0, `"most left first" sorts by what is left, the finished pair last (${r1.map((r) => r.left).join(" ")})`);
  // "to review": the finished pair is gone
  await p.evaluate(() => [...document.querySelectorAll('[data-bar="fade-order"] button')].find((x) => /to review/.test(x.textContent))?.click());
  await p.waitForTimeout(2500);
  const r2 = await rows();
  ok(r2.length === r1.length - 1 && !r2.some((r) => /ice/.test(r.href)), `"to review" hides the finished pair (${r1.length} → ${r2.length} rows)`);
  // and the pair page's ‹ › walks that order: from the first row, "next" is the second row
  await p.evaluate((h2) => { location.hash = h2; }, r2[0].href);
  await p.waitForTimeout(3000);
  const nav = await p.evaluate(() => document.querySelector(".detail-nav a.nav-btn[title^='Next']")?.getAttribute("href") ?? null);
  ok(nav === r2[1]?.href, `the pair page's next follows the same order (${nav} vs ${r2[1]?.href})`);
  // ...and that link is a route the wiki actually serves (it was not: base "world/transitions")
  await p.evaluate((h2) => { location.hash = h2; }, nav);
  await p.waitForTimeout(3000);
  const landedNext = await p.evaluate(() => ({ h1: document.querySelector("h1")?.textContent ?? "", body: document.querySelector("#content")?.textContent?.slice(0, 40) ?? "" }));
  ok(/↔/.test(landedNext.h1), `and "next" lands on a real pair page, not a dead route (“${landedNext.h1 || landedNext.body}”)`);
  await p.evaluate(() => { try { localStorage.setItem("wiki-fade-order", "all"); } catch {} });
}

// ---- 9. a judged fade card wears its verdict ------------------------------
/* Maintainer 2026-09-03: "When I approved or rejected a tile before on the
 * fade page — the card border became green/red ... A review in queue/just
 * committed should have the card with a green/red border." Measured as the
 * card's computed outline colour against the resolved --good/--bad tokens,
 * and asserted BEFORE any commit — the tap is what must paint it. */
{
  await reopen("#/world/transition/grass__to__ice");
  const tok = await p.evaluate(() => {
    const el = document.createElement("span"); document.body.appendChild(el);
    const read = (v) => { el.style.color = `var(${v})`; return getComputedStyle(el).color; };
    const out = { good: read("--good"), bad: read("--bad") }; el.remove(); return out;
  });
  const card = (i) => p.evaluate((n) => {
    const c = [...document.querySelectorAll(".fade-tile")][n];
    const cs = getComputedStyle(c);
    return { cls: c.className, outline: cs.outlineColor, width: cs.outlineWidth };
  }, i);
  const before = await card(0);
  ok(!/picked|dropped/.test(before.cls), `an unjudged fade card wears no verdict outline (“${before.cls}”)`);
  await p.evaluate(() => { const r = document.querySelector(".fade-tile"); [...r.querySelectorAll(".verdict button")].find((x) => /approve/.test(x.textContent))?.click(); });
  await p.waitForTimeout(500);
  const ok1 = await card(0);
  ok(/picked/.test(ok1.cls) && ok1.outline === tok.good && parseFloat(ok1.width) >= 2,
    `approving paints the card GREEN immediately, before any commit (${ok1.outline} vs --good ${tok.good})`);
  await p.evaluate(() => { const r = document.querySelector(".fade-tile"); [...r.querySelectorAll(".verdict button")].find((x) => /remove/.test(x.textContent))?.click(); });
  await p.waitForTimeout(500);
  const no1 = await card(0);
  ok(/dropped/.test(no1.cls) && !/picked/.test(no1.cls) && no1.outline === tok.bad,
    `and rejecting paints it RED, never both at once (${no1.outline} vs --bad ${tok.bad})`);
  // ...and it survives leaving and coming back, which is what "since the tiles
  // agent looked at my review" means in practice.
  await p.evaluate(() => { location.hash = "#/world"; }); await p.waitForTimeout(900);
  await p.evaluate(() => { location.hash = "#/world/transition/grass__to__ice"; }); await p.waitForTimeout(4000);
  const kept = await p.evaluate(() => {
    const c = [...document.querySelectorAll(".fade-tile")].find((x) => /dropped/.test(x.className));
    return c ? { key: c.querySelector(".fade-key")?.title ?? null, outline: getComputedStyle(c).outlineColor } : null;
  });
  ok(kept && kept.outline === tok.bad, `the verdict outline is still there when he comes back (${kept?.key?.split("/").pop()})`);
  await p.evaluate(() => { const r = [...document.querySelectorAll(".fade-tile")].find((x) => /dropped/.test(x.className)); [...r.querySelectorAll(".verdict button")].find((x) => /remove/.test(x.textContent))?.click(); });
  await p.waitForTimeout(500);
}
await b.close();
console.log(fails.length ? `\nFADE CHECKS FAILED (${fails.length})` : "\nALL FADE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
