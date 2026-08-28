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

// ---- 1. the section: MERGED, sorted by the page's first ground, paginated --
await p.goto(`${W}#/world/transition/grass__to__ice`, { waitUntil: "load" });
await p.waitForTimeout(5000);
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
await p.goto(`${W}#/world/transition/ice__to__grass`, { waitUntil: "load" });
await p.waitForTimeout(5000);
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
await b.close();
console.log(fails.length ? `\nFADE CHECKS FAILED (${fails.length})` : "\nALL FADE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
