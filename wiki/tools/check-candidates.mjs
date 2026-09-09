#!/usr/bin/env node
/* A NEW MONSTER IS JUDGED ON ITS 8 DIRECTIONS BEFORE IT EARNS ANIMATIONS
 * (maintainer 2026-09-09: "the first step before generating a monster is
 * generating a character in 8 directions. If you are happy with this
 * character you can go on and generate all animations needed. So we need a
 * way for me to see and review monsters in this early 8 dir only state.")
 *
 * Drives the two pages on a 393px phone against the local harness:
 *   node wiki/tools/serve-assets.mjs 8902   (+ serve-repo.mjs 8903 for admin)
 *   node wiki/tools/check-candidates.mjs
 * Asserts: the Creatures page carries the door with the unjudged count; the
 * list shows every candidate under "all" and only the unjudged under the
 * default chip; a candidate page shows all 8 facings as loaded images, two
 * per row; approve writes a verdict stamped with the candidate's version and
 * moves it out of "to judge"; redo and remove are on the row; a verdict
 * stamped with an OLDER version reads as "judge again". */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
const SANDBOX = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const EXE = process.env.CHROMIUM_PATH || (existsSync(SANDBOX) ? SANDBOX : "");
const URL_ = process.env.WIKI_URL ?? "http://127.0.0.1:8902";
const W = `${URL_}/assets/wiki/site/index.html`;
const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const CANDS = DATA.domains?.monsterCandidates ?? [];
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? "ok" : "FAIL"}: ${msg}`); if (!c) fails++; };
if (!CANDS.length) { console.log("no candidates in the registry — nothing to drive"); process.exit(0); }

const b = await chromium.launch(EXE ? { executablePath: EXE } : {});
const ctx = await b.newContext({ viewport: { width: 393, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  localStorage.removeItem("wiki-cand-filter");
});
const shot = process.env.SHOT_DIR;

await p.goto(`${W}#/monsters`, { waitUntil: "load" });
await p.waitForTimeout(2500);
const door = await p.evaluate(() => document.querySelector(".cand-entry")?.textContent ?? null);
ok(door && /\d+ of \d+ new designs/.test(door), `the Creatures page carries the door: "${door}"`);

await p.evaluate(() => { location.hash = "#/monsters/candidates"; });
await p.waitForTimeout(1200);
const list = await p.evaluate(() => ({
  chips: [...document.querySelectorAll('[data-bar="wiki-cand-filter"] .sortbar-btn')].map((x) => x.textContent.trim()),
  sel: document.querySelector('[data-bar="wiki-cand-filter"] .sortbar-btn.sel')?.dataset.sort,
  cards: document.querySelectorAll(".cand-card").length,
}));
console.log("list:", JSON.stringify(list));
ok(list.chips.length === 5 && list.sel === "pending", `five filter chips, "to judge" selected by default (${list.chips.join(" | ")})`);
if (shot) await p.screenshot({ path: `${shot}/cand-list.png` });
await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-cand-filter"] .sortbar-btn')].find((x) => x.dataset.sort === "all")?.click());
await p.waitForTimeout(600);
const nAll = await p.evaluate(() => document.querySelectorAll(".cand-card").length);
ok(nAll === CANDS.length, `"all" shows every candidate (${nAll} of ${CANDS.length})`);

// The first card the page lists is the one he would tap.
const firstId = await p.evaluate(() => document.querySelector(".cand-card")?.getAttribute("href")?.split("/").pop());
const cand = CANDS.find((c) => c.id === firstId);
ok(!!cand, `the first card opens a candidate the registry knows (${firstId})`);
await p.evaluate((id) => { location.hash = `#/monsters/candidates/${id}`; }, firstId);
await p.waitForTimeout(2500);
const det = await p.evaluate(() => {
  const imgs = [...document.querySelectorAll(".cand-dir img")];
  const rows = new Set(imgs.map((i) => Math.round(i.getBoundingClientRect().top)));
  return {
    n: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    dirs: [...document.querySelectorAll(".cand-dir")].map((f) => f.dataset.dir),
    rows: rows.size, w: imgs[0]?.getBoundingClientRect().width,
    // The GRID stays inside the phone; the document's own width is not this
    // page's to answer (the footer stamp already pokes 4px past it).
    wide: (() => { const g = document.querySelector(".cand-dirs"); return g.getBoundingClientRect().right > document.documentElement.clientWidth + 1 || g.scrollWidth > g.clientWidth; })(),
    cols: getComputedStyle(document.querySelector(".cand-dirs")).getPropertyValue("--cand-cols").trim(),
    buttons: [...document.querySelectorAll(".cand-judge .verdict button")].map((x) => x.textContent.trim()),
    stars: document.querySelectorAll(".cand-judge .stars button, .cand-judge .star").length,
  };
});
console.log("detail:", JSON.stringify(det));
ok(det.n === 8 && det.loaded === 8, `all 8 facings are on the page and loaded (${det.loaded}/${det.n})`);
ok(det.cols === "2" ? det.rows === 4 : det.rows === 8, `mirror pairs side by side when two fit, stacked when they don't (${det.cols} column(s), ${det.rows} rows, ${det.w}px each)`);
ok(det.dirs.join(",") === "south,north,east,west,south-east,south-west,north-east,north-west", `in mirror-pair order (${det.dirs.join(" ")})`);
ok(!det.wide, "the facings never poke past a 393px phone");
ok(det.buttons.length === 3 && /approve/.test(det.buttons[0]) && /remove/.test(det.buttons[1]) && /redo/.test(det.buttons[2]), `approve / remove / redo on the row (${det.buttons.join(" | ")})`);
if (shot) await p.screenshot({ path: `${shot}/cand-detail.png` });

// APPROVE stamps the version and leaves the queue.
await p.evaluate(() => [...document.querySelectorAll(".cand-judge .verdict button")].find((x) => /approve/.test(x.textContent))?.click());
await p.waitForTimeout(400);
const entry = await p.evaluate((path) => JSON.parse(JSON.stringify(window.__wiki?.state?.feedback?.monsters?.entries?.[path] ?? null)), cand.path);
console.log("entry:", JSON.stringify(entry));
ok(entry && entry.status === "approved" && entry.version === cand.version && entry.rating === 1,
  `approve writes {status: approved, version: ${cand.version}, rating: 1} under ${cand.path}`);
await p.evaluate(() => { location.hash = "#/monsters/candidates"; });
await p.waitForTimeout(800);
await p.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-cand-filter"] .sortbar-btn')].find((x) => x.dataset.sort === "pending")?.click());
await p.waitForTimeout(600);
const stillPending = await p.evaluate((id) => !![...document.querySelectorAll(".cand-card")].find((a) => a.getAttribute("href").endsWith(`/${id}`)), firstId);
ok(!stillPending, "and the approved one has left \"to judge\"");

// A verdict on an OLDER version is a verdict on art that no longer exists.
await p.evaluate((path) => { const e = window.__wiki.state.feedback.monsters.entries[path]; e.version = (e.version ?? 1) - 1; }, cand.path);
await p.evaluate((id) => { location.hash = `#/monsters/candidates/${id}`; }, firstId);
await p.waitForTimeout(1200);
const stale = await p.evaluate(() => ({
  pill: [...document.querySelectorAll(".pill")].some((x) => /judge again/.test(x.textContent)),
  approved: !!document.querySelector(".cand-judge .verdict button.approved"),
}));
ok(stale.pill && !stale.approved, `an older-version verdict reads as "judge again" and the approve button is not lit (${JSON.stringify(stale)})`);

console.log(`page errors: ${errors.length ? errors.join(" | ").slice(0, 300) : "none"}`);
ok(!errors.length, "no page errors");
await b.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL CANDIDATE CHECKS PASSED");
process.exit(fails ? 1 : 0);
