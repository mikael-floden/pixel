// THE PHONE'S BACK GESTURE PEELS ONE LAYER AT A TIME.
//
// Maintainer, 2026-08-13: "Opening the wiki and swipe back doesn't close the
// wiki. It exits the game. Swiping back when the wiki menu is open also
// doesn't close the wiki menu … If the wiki side menu is open back should mean
// back to the wiki. Another back should mean back to the game. Another back is
// ok to quit the game."
//
// The drawer is not a page, so back had nothing of ours to pop and left the
// game outright. wikipanel.ts now owns one history entry per visible layer.
// The subtle half is the OTHER way out: closing a layer by tapping the dark
// strip, pressing Escape or using the wiki's own control has to hand its entry
// back, or the player is left pressing back on entries that do nothing.
//
// Needs the game client (npm run dev:client). Without it this reports SKIP and
// exits 0 — the wiki's other gates only need the assets server, and this one
// must not turn a missing dev server into a red build.
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const GAME = process.env.GAME_URL ?? "http://127.0.0.1:5173";
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

let up = false;
try { up = (await fetch(GAME, { method: "GET" })).ok; } catch { up = false; }
if (!up) { console.log(`SKIP: no game client on ${GAME} — run "npm run dev:client" in games2/`); process.exit(0); }

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));

const boot = async () => { await p.goto(GAME, { waitUntil: "load" }); await p.waitForTimeout(6000); };
const frame = () => p.frames().find((f) => f.url().includes("/assets/wiki/site/"));
const state = async () => ({
  ...await p.evaluate(() => ({
    panel: !!document.querySelector(".ml-wikiroot"),
    menu: !!document.querySelector(".ml-wikiback.deep"),
    inGame: location.href.startsWith(location.origin),
  })),
  wiki: frame()?.url().split("index.html")[1] ?? null,
});
const openWiki = async () => {
  await p.evaluate(() => [...document.querySelectorAll("button,a")].find((x) => /Wiki/.test(x.textContent || ""))?.click());
  await p.waitForTimeout(2300);
};
// history.back(), never page.goBack(): an in-wiki hash change is an IFRAME
// navigation and fires no top-level load, so goBack() waits 30s for an event
// that never comes.
const back = async () => { await p.evaluate(() => history.back()); await p.waitForTimeout(1100); };
const openMenu = async () => { await frame().evaluate(() => document.querySelector("header button")?.click()); await p.waitForTimeout(900); };

await boot();
// 1. one layer, one back
await openWiki();
const opened = await state();
ok(opened.panel, "the wiki opens over the game");
await back();
const afterOne = await state();
ok(!afterOne.panel && afterOne.inGame, `one back closes the wiki and leaves you IN the game (panel ${afterOne.panel}, in game ${afterOne.inGame})`);

// 2. the nested ladder: menu → wiki → game, exactly as the dark strip does it
await openWiki();
await openMenu();
const m0 = await state();
ok(m0.panel && m0.menu, "the wiki's own menu opens as a second layer");
await back();
const m1 = await state();
ok(m1.panel && !m1.menu, `back #1 closes the MENU and stays in the wiki (panel ${m1.panel}, menu ${m1.menu})`);
await back();
const m2 = await state();
ok(!m2.panel && m2.inGame, `back #2 closes the wiki and returns to the game (panel ${m2.panel})`);

// 2b. A MENU LINK MUST ACTUALLY NAVIGATE — the maintainer's blocking bug
//     (2026-08-14: "I definitely clicked on Overview! and the page didn't
//     change!"). Same-origin frames share ONE joint session history; round
//     one had the parent pop an entry when the menu closed, and a nav click
//     had just stacked the new page on top — so the pop removed the
//     NAVIGATION and silently undid the click. Now the wiki owns the menu's
//     entry and menu links location.replace() it away.
await boot();
await openWiki();
await frame().evaluate(() => { location.hash = "#/objects"; });   // start somewhere that is not Overview
await p.waitForTimeout(1100);
await openMenu();
await frame().evaluate(() => [...document.querySelectorAll("#nav a")]
  .find((a) => /Overview/.test(a.textContent || ""))?.click());
await p.waitForTimeout(1000);
const nav1 = await state();
ok(nav1.panel && (nav1.wiki === "#/" || nav1.wiki === ""), `clicking Overview in the menu really lands on Overview (${JSON.stringify(nav1.wiki)})`);
ok(!nav1.menu, "and the menu closed with it");
await p.waitForTimeout(900);                                       // the old bug reverted a beat later
const nav2 = await state();
ok(nav2.wiki === "#/" || nav2.wiki === "", `and STAYS on Overview — nothing undoes the click (${JSON.stringify(nav2.wiki)})`);
await back();
const nav3 = await state();
ok(nav3.panel && nav3.wiki === "#/objects", `back from there returns to the page the menu was opened over (${nav3.wiki})`);

// 3. closing the menu BY HAND returns its entry — otherwise the next back is a
//    dead press and the player has to swipe twice to leave the wiki.
await boot();
await openWiki();
await openMenu();
await frame().evaluate(() => document.querySelector("header button")?.click());
await p.waitForTimeout(900);
const h0 = await state();
ok(h0.panel && !h0.menu, "the menu can still be closed by hand");
await back();
const h1 = await state();
ok(!h1.panel && h1.inGame, "and then ONE back closes the wiki — the menu's entry was handed back, not left dangling");

// 4. closing the PANEL by hand returns its entry too: the next back must leave
//    the game, not land on an entry that does nothing.
await openWiki();
await p.evaluate(() => document.querySelector(".ml-wikiback").click());
await p.waitForTimeout(900);
ok(!(await state()).panel, "the dark strip still closes the wiki");
await back();
const plainLeft = p.isClosed() ? { inGame: false } : await state().catch(() => ({ inGame: false }));
ok(!plainLeft.inGame, "and the back after it leaves the game, instead of pressing a dead entry");

// 4b. hand-closing AFTER browsing: the panel's entry is buried under the
//     wiki's own navigations, so the handback must wait for the iframe to be
//     discarded (which prunes them) — popping early would walk the wiki's
//     history from behind a closed drawer.
await boot();
await openWiki();
await frame().evaluate(() => { location.hash = "#/objects"; }); await p.waitForTimeout(900);
await frame().evaluate(() => { location.hash = "#/monsters"; }); await p.waitForTimeout(900);
await p.evaluate(() => document.querySelector(".ml-wikiback").click());
await p.waitForTimeout(1100);                                      // slide-out + cleanup
ok(!(await state()).panel, "the drawer hand-closes after a browse");
// KNOWN PAPERCUT, bounded: Chromium keeps a discarded iframe's joint-history
// entries (measured: history.length 5 before AND after removal), so the
// browsed pages leave inert entries behind a hand-close. They are invisible
// no-ops; the game must still be left within a few presses, never trapped.
let left = false;
for (let i = 0; i < 4 && !left; i++) {
  await back();
  left = p.isClosed() || !(await state().catch(() => ({ inGame: false }))).inGame;
}
ok(left, "backing out after a hand-close still leaves the game within 4 presses (inert entries tolerated)");

// 5. an in-wiki walk is the player's own history and is walked first, then the
//    drawer closes — the same order the wiki's ← crumb uses.
await boot();
await openWiki();
await frame().evaluate(() => { location.hash = "#/objects"; }); await p.waitForTimeout(1000);
await frame().evaluate(() => { location.hash = "#/monsters"; }); await p.waitForTimeout(1000);
const w0 = await state();
ok(w0.wiki === "#/monsters", `browsed two pages inside the wiki (${w0.wiki})`);
await back();
const w1 = await state();
ok(w1.panel && w1.wiki === "#/objects", `back walks the wiki's own pages first (${w1.wiki})`);
await back(); await back();
const w3 = await state();
ok(!w3.panel && w3.inGame, "and once the wiki has no history left, back closes the drawer");

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL BACK-GESTURE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
