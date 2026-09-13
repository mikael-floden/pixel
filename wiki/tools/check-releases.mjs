#!/usr/bin/env node
/* WHAT HAS LANDED, AND WHO LANDED IT (maintainer 2026-09-13: "a new wiki top
 * section called 'Release Notes' … just the last 50 gitsha with commint
 * message and date (just so I as an admin can see more easily what has
 * landed). Also put the agent if you have that data").
 *
 * Three things this gate is here to stop:
 *   1. A PLAYER SEEING IT. Commit shas and agent names are the factory floor.
 *      adminOnly hides a section from the nav and the start page, and the
 *      route has to refuse a direct link too — Parameters learned that.
 *   2. A LIST THAT IS NOT THE DATA. Every row's sha must be the build's own
 *      list, in the build's own order, or the page is fiction.
 *   3. AN INVENTED AGENT. The only signal that cannot be wrong is the board
 *      file a commit wrote; this asserts the page agrees with it, and that a
 *      commit with no nameable agent shows its FOLDERS rather than a guess.
 *
 *   node wiki/tools/serve-assets.mjs 8902
 *   node wiki/tools/check-releases.mjs
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
const SANDBOX = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const EXE = process.env.CHROMIUM_PATH || (existsSync(SANDBOX) ? SANDBOX : "");
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? "ok" : "FAIL"}: ${msg}`); if (!c) fails++; };

const DOC = DATA.releases ?? {};
const COMMITS = DOC.commits ?? [];
ok(COMMITS.length > 0 && COMMITS.length <= 50, `the build carries a commit list (${COMMITS.length}, from ${DOC.from ?? "?"})`);
ok(DATA.counts?.releases === COMMITS.length, `and the section's count is that list (${DATA.counts?.releases})`);
ok(COMMITS.every((c) => /^[0-9a-f]{9}$/.test(c.sha) && !Number.isNaN(Date.parse(c.at)) && (c.subject ?? "").length),
  "every commit has a 9-char sha, a parseable date and a subject");
ok(new Set(COMMITS.map((c) => c.sha)).size === COMMITS.length, "no sha appears twice");
// Newest first — the order the page renders and the order he reads.
ok(COMMITS.every((c, i) => i === 0 || Date.parse(COMMITS[i - 1].at) >= Date.parse(c.at) - 60_000),
  "newest first (a minute of slack: a rebase can stamp two commits in either order)");

const b = await chromium.launch(EXE ? { executablePath: EXE } : {});
const ctx = await b.newContext({ viewport: { width: 393, height: 850 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));

// ---- 1. a PLAYER never sees it, by any route --------------------------------
await p.goto(`${W}#/releases`, { waitUntil: "load" });
await p.waitForTimeout(2200);
const asPlayer = await p.evaluate(() => ({
  rows: document.querySelectorAll(".rel-row").length,
  nav: [...document.querySelectorAll("#nav a")].some((a) => /Release Notes/.test(a.textContent)),
  tiles: [...document.querySelectorAll(".stat-tile")].some((a) => /Release Notes/.test(a.textContent)),
  heading: document.querySelector("h1")?.textContent ?? "",
}));
console.log("as a player:", JSON.stringify(asPlayer));
ok(!asPlayer.rows && !asPlayer.nav && !asPlayer.tiles,
  "a player gets no rows, no nav entry and no start tile — even on the direct link");
ok(/Nangijala Wiki/.test(asPlayer.heading), "…and lands on the Overview rather than a dead page");

// ---- 2. the Game Master's page ---------------------------------------------
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});
// RELOAD, never a second goto: the URL and the hash are the ones already
// showing, so `goto` is a same-document no-op — the init script never runs and
// the page stays a player's (measured: 0 rows, and every admin assertion red).
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(2600);
const page = await p.evaluate(() => ({
  rows: [...document.querySelectorAll(".rel-row")].map((r) => ({
    sha: r.querySelector(".rel-sha")?.textContent ?? "",
    when: r.querySelector(".rel-when")?.textContent ?? "",
    subject: r.querySelector(".rel-subject")?.textContent ?? "",
    agent: r.querySelector(".pill.rel-agent")?.textContent ?? null,
    where: r.querySelector(".pill.rel-where")?.textContent ?? null,
    href: r.querySelector("a.rel-sha")?.getAttribute("href") ?? null,
  })),
  days: [...document.querySelectorAll(".rel-panel .panel-title")].map((t) => t.textContent),
  nav: [...document.querySelectorAll("#nav a")].map((a) => a.textContent.trim()).filter((t) => /Release/.test(t)),
  tile: [...document.querySelectorAll(".stat-tile")].map((a) => a.textContent).find((t) => /Release Notes/.test(t)) ?? null,
  icon: (() => { const i = document.querySelector(".sect-head img"); return i ? { src: i.getAttribute("src"), w: i.naturalWidth, h: i.naturalHeight, drawn: i.clientWidth } : null; })(),
  intro: document.querySelector("p.muted")?.textContent ?? "",
  wide: document.documentElement.scrollWidth <= window.innerWidth,
}));
console.log("intro:", page.intro);
console.log("days:", JSON.stringify(page.days));
console.log("first row:", JSON.stringify(page.rows[0]));
ok(page.rows.length === COMMITS.length, `every commit in the build is a row (${page.rows.length} of ${COMMITS.length})`);
ok(page.rows.map((r) => r.sha).join() === COMMITS.map((c) => c.sha).join(), "in the build's own order, sha for sha");
ok(page.rows.every((r) => r.subject && /^\d{2}:\d{2}$/.test(r.when)), "each row carries its subject and the time it landed");
ok(page.rows.every((r) => r.agent || r.where), "and either the agent or the folders it changed — never neither");
ok(page.days.length >= 1 && page.days.every((d) => /\d+ commits?$/.test(d)), `grouped by day, each counted (${page.days.length} day panels)`);

// THE AGENT IS THE BOARD FILE. Rebuild the one signal that cannot be wrong,
// straight from the build's own data, and require the page to agree.
const boardTruth = COMMITS.filter((c) => c.agent && c.dirs?.length === 1 && c.dirs[0] === "coordination");
ok(boardTruth.length > 0, `${boardTruth.length} commits are pure board writes — the signal this rests on`);
const shown = new Map(page.rows.map((r) => [r.sha, r.agent]));
const wrong = boardTruth.filter((c) => shown.get(c.sha) !== c.agent);
ok(!wrong.length, `each one names its own agent on the page (${wrong.length} disagree)`);
const noAgent = COMMITS.filter((c) => !c.agent);
ok(noAgent.every((c) => shown.get(c.sha) === null),
  `and the ${noAgent.length} commits with no nameable agent show no agent chip — the folders instead`);

// ---- 3. the trimmings -------------------------------------------------------
ok(page.nav.length === 1 && page.nav[0].includes(String(COMMITS.length)),
  `the Game Master's nav carries it with its count (${page.nav.join("|")})`);
// The start page's tiles only exist ON the start page, so ask it there.
await p.goto(`${W}#/`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const tile = await p.evaluate(() => [...document.querySelectorAll(".stat-tile")]
  .map((a) => ({ href: a.getAttribute("href"), text: a.textContent.replace(/\s+/g, " ").trim() }))
  .find((t) => t.href === "#/releases") ?? null);
ok(tile && /commits/.test(tile.text), `and the start page has its tile (${tile?.text ?? "missing"})`);
// HIS PIXEL ART, AT A WHOLE MULTIPLE OF 48 — the icon law (wiki/README.md).
ok(page.icon && page.icon.w === 48 && page.icon.h === 48 && page.icon.drawn % 48 === 0,
  `the icon he drew is 48x48 and drawn at ${page.icon?.drawn}px (${page.icon?.src})`);
ok(!page.rows.some((r) => r.href) || page.rows.every((r) => !r.href || r.href.startsWith("https://github.com/")),
  "a sha links to the commit on the repo's own host, or to nothing at all");
ok(page.wide, "the page does not scroll sideways on a 393px phone");
console.log(`page errors: ${errors.length ? errors.join(" | ").slice(0, 300) : "none"}`);
ok(!errors.length, "no page errors");

if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT, fullPage: false });
await b.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL RELEASE-NOTES CHECKS PASSED");
process.exit(fails ? 1 : 0);
