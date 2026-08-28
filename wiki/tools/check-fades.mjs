/* FADE TILES: both grounds on one top, reviewed on the transition pair page
 * (maintainer 2026-08-28: "tiles the map-agent can use to start warming up
 * the player for a new ground-type long before the transition happens ... I
 * want to be able to approve/reject/give stars and add a note to all tiles
 * like this ... at the bottom of the transition pair page").
 *
 * The index is the tiles agent's to publish (tiles/fades/index.json,
 * tiles3/fade-tiles@1 — schema posted to their board); this gate stubs it
 * with real top art, which is exactly how the section will meet the real
 * thing: read live, no wiki deploy between their push and his review.
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const ROOT = new URL("../../", import.meta.url).pathname;
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const sheet = readdirSync(ROOT + "tiles/tops/grass").find((d) => d.startsWith("sheet_"));
const files = readdirSync(`${ROOT}tiles/tops/grass/${sheet}/post`);
const STUB = { schema: "tiles3/fade-tiles@1", pairs: { "grass__to__ice": [
  { key: "tiles/fades/grass__to__ice/aaaa1111", file: `tiles/tops/grass/${sheet}/post/${files[0]}`, pct: { grass: 72.5, ice: 27.5 } },
  { key: "tiles/fades/grass__to__ice/bbbb2222", file: `tiles/tops/grass/${sheet}/post/${files[1]}`, pct: { grass: 31.0, ice: 69.0 } },
  { key: "tiles/fades/grass__to__ice/cccc3333", file: `tiles/tops/grass/${sheet}/post/${files[2]}`, pct: { grass: 55.0, ice: 45.0 } },
] } };

const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = []; const saves = [];
p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.route("**/api/wiki/save", (r) => { saves.push(r.request().postDataJSON()); r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
await p.route("**/tiles/fades/index.json*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(STUB) }));
await p.addInitScript(() => { localStorage.setItem("wiki-admin-token", "gate"); localStorage.setItem("ml-staging-base", "http://127.0.0.1:8903/"); });

const read = () => p.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent ?? "",
  panel: [...document.querySelectorAll(".panel-title")].map((x) => x.textContent.replace(/\s+/g, " ").trim()).find((x) => /Fade tiles/.test(x)) ?? null,
  rows: [...document.querySelectorAll(".fade-tile b")].map((x) => x.textContent.trim()),
  scenes: [...document.querySelectorAll(".fade-tile canvas")].filter((c) => c.width > 200).length,
  fb: document.querySelectorAll(".fade-tile .fb-row").length,
}));

// ---- 1. the section, sorted by the page's first ground ---------------------
await p.goto(`${W}#/world/transition/grass__to__ice`, { waitUntil: "load" });
await p.waitForTimeout(3500);
const g = await read();
ok(!!g.panel && /most grass first/.test(g.panel), `the pair page grows a Fade tiles section, sorted for ITS first ground (${g.panel})`);
ok(g.rows.length === 3 && g.rows[0].startsWith("73% grass") && g.rows[2].startsWith("31% grass"),
  `highest grass first on the grass page (${g.rows.join(" | ")})`);
ok(g.scenes === 3 && g.fb === 3, `each tile gets a wandering-edge field and the standard verdict row (${g.scenes} scenes, ${g.fb} rows)`);

// ---- 2. the reversed page: same tiles, the other way up --------------------
await p.goto(`${W}#/world/transition/ice__to__grass`, { waitUntil: "load" });
await p.waitForTimeout(3000);
const i2 = await read();
ok(/^Ice/.test(i2.h1), `the reversed route keeps ITS orientation — the page is Ice ↔ grass, not renamed (${i2.h1})`);
ok(i2.rows.length === 3 && i2.rows[0].startsWith("69% ice") && i2.rows[2].startsWith("28% ice"),
  `…and sorts the SAME tiles by ice instead (${i2.rows.join(" | ")})`);

// ---- 3. majority-side placement -------------------------------------------
/* "Display the fade tile on the grass side if grass is >= 50% and on the ice
 * side if ice is > 50%." Probed through the scene's own cell list: every pure
 * cell of the majority side must be the dressed fade tile, and no cell of the
 * minority side may be. */
/* The audit array grows per RENDER (hash navigation re-renders without a page
 * load), so the truth is the last entry per tile, not the raw list. */
const sides = await p.evaluate(() => {
  const last = new Map();
  for (const t of window.__wikiFades ?? []) last.set(t.key, t);
  return [...last.values()];
});
ok(sides.length === 3, `the scenes publish their cell audit, one per tile (${sides.length})`);
for (const t of sides) {
  ok(t.majorityCells > 0 && t.fadeOnMajority === t.majorityCells && t.fadeOnMinority === 0,
    `${t.key.split("/").pop()}: the fade tile fills the ${t.majority} side and never the other (${t.fadeOnMajority}/${t.majorityCells} there, ${t.fadeOnMinority} astray)`);
}

// ---- 4. verdicts ride the tiles feedback file on the tile's own key --------
await p.evaluate(() => { const r = document.querySelector(".fade-tile .fb-row"); r.querySelectorAll(".stars button")[3]?.click(); });
await p.waitForTimeout(500);
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(900);
const s2 = saves.at(-1);
ok(s2?.file === "feedback/tiles" && /^tiles\/fades\//.test(Object.keys(s2.set ?? {})[0] ?? ""),
  `a star commits to feedback/tiles on the tile's own stable key (${Object.keys(s2?.set ?? {})[0]})`);

// ---- 5. no index, no section ----------------------------------------------
const p2 = await ctx.newPage();
await p2.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p2.route("**/tiles/fades/index.json*", (r) => r.fulfill({ status: 404, body: "" }));
await p2.addInitScript(() => { localStorage.setItem("wiki-admin-token", "gate"); localStorage.setItem("ml-staging-base", "http://127.0.0.1:8903/"); });
await p2.goto(`${W}#/world/transition/grass__to__ice`, { waitUntil: "load" });
await p2.waitForTimeout(2600);
ok(await p2.evaluate(() => ![...document.querySelectorAll(".panel-title")].some((x) => /Fade tiles/.test(x.textContent))),
  "before the tiles agent publishes the index, the section simply is not there");
await p2.close();
ok(errs.length === 0, `no page errors (${errs[0] ?? "none"})`);
await b.close();
console.log(fails.length ? `\nFADE CHECKS FAILED (${fails.length})` : "\nALL FADE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
