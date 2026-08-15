// EVERY SECTION PAGE HAS A WAY BACK UP TO OVERVIEW.
//
// Maintainer, 2026-08-14: "When you stand on Creatures, Races, Scenery, Music
// etc (a top headline). You have no back button to get to Overview the way you
// can go back from a Scenery entity to the Scenery overview. A similar
// 'breadcrumb back' button/navigation link will make the wiki easier to
// navigate."
//
// Entity pages have had their "← Scenery" crumb since the start; the section
// pages were the one rung of the ladder with nothing above them, so the only
// route home was the ☰ menu. The crumb lives in sectionHead(), which every
// section page opens with — so this gate walks the NAV's own list rather than
// a list typed in here: a section added later is covered automatically, and a
// section that somehow stops using sectionHead fails loudly.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
// Admin, so the admin-only sections (Parameters) are covered too — a Game
// Master navigates them as much as anyone.
const p = await (await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  // An admin reads the REPO, not the image (wiki.js useStagingRoot, 2026-08-14).
  // The sandbox blocks browser egress, so point the staging base at this same
  // server's /assets — the identical code path, resolvable offline.
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});

// The sections the wiki itself advertises, read off its own nav.
await p.goto(`${W}#/`, { waitUntil: "load" });
await p.waitForTimeout(1700);
const slugs = await p.evaluate(() => [...document.querySelectorAll("#nav a")]
  .map((a) => a.getAttribute("href"))
  .filter((h) => h && h !== "#/")
  .map((h) => h.replace("#/", "")));
console.log("sections from the wiki's own nav:", slugs.join(", "));
ok(slugs.length >= 8, `the nav advertises the whole ladder (${slugs.length} sections)`);

// THE NAV AND THE OVERVIEW TILES ARE ONE ORDER (SECTION_ORDER feeds both), and
// Races leads it — "feels like humans must be sorted before monsters"
// (maintainer 2026-08-14). Two lists that can disagree eventually do.
const tileOrder = await p.evaluate(() => [...document.querySelectorAll("#content a[href^='#/']")]
  .map((a) => a.getAttribute("href").replace("#/", ""))
  .filter((h) => h && h !== ""));
const firstTiles = tileOrder.filter((x, i) => tileOrder.indexOf(x) === i).slice(0, slugs.length);
console.log("overview tiles :", firstTiles.join(", "));
ok(slugs[0] === "characters" && slugs[1] === "monsters",
  `the menu puts Races before Creatures (${slugs.slice(0, 2).join(", ")})`);
ok(JSON.stringify(firstTiles) === JSON.stringify(slugs),
  "and the Overview tiles run in exactly the same order as the menu");

const seen = [];
for (const slug of slugs) {
  await p.goto(`${W}#/${slug}`, { waitUntil: "load" });
  await p.waitForTimeout(1200);
  seen.push(await p.evaluate(() => {
    const c = document.querySelector(".crumb");
    const h1 = document.querySelector("h1");
    return {
      h1: h1?.textContent ?? null,
      text: c?.textContent ?? null,
      href: c?.getAttribute("href") ?? null,
      // The crumb must sit ABOVE the headline, like it does on an entity page.
      aboveTitle: !!(c && h1 && c.getBoundingClientRect().bottom <= h1.getBoundingClientRect().top + 2),
    };
  }));
}
for (const s of seen) console.log(`      ${String(s.h1).padEnd(14)} ${JSON.stringify(s.text)} -> ${s.href}`);
const missing = slugs.filter((_, i) => !seen[i].text);
ok(missing.length === 0, `every section page carries a crumb${missing.length ? ` — missing on: ${missing.join(", ")}` : ` (all ${slugs.length})`}`);
ok(seen.every((s) => s.href === "#/"), "and every one of them points at Overview");
ok(seen.every((s) => /Overview/.test(s.text ?? "")), `and says where it goes ("${seen[0]?.text}")`);
ok(seen.every((s) => s.aboveTitle), "sitting above the headline, exactly like an entity page's crumb");

// It must actually navigate — a crumb that looks right and does nothing is the
// bug in a nicer costume.
await p.goto(`${W}#/objects`, { waitUntil: "load" });
await p.waitForTimeout(1300);
await p.evaluate(() => document.querySelector(".crumb").click());
await p.waitForTimeout(900);
const landed = await p.evaluate(() => ({ hash: location.hash, h1: document.querySelector("h1")?.textContent }));
console.log("after clicking it:", JSON.stringify(landed));
ok(landed.hash === "#/" && /Nangijala/.test(landed.h1 ?? ""), `clicking it lands on Overview (${landed.h1})`);

// The entity crumb is untouched — it still points at its own section, not home.
await p.goto(`${W}#/objects`, { waitUntil: "load" });
await p.waitForTimeout(1300);
await p.evaluate(() => document.querySelector(".card")?.click());
await p.waitForTimeout(1500);
const ent = await p.evaluate(() => {
  const c = document.querySelector(".crumb");
  return { text: c?.textContent ?? null, href: c?.getAttribute("href") ?? null };
});
console.log("entity crumb:", JSON.stringify(ent));
ok(ent.href === "#/objects", `an entity page still goes back to its SECTION, not to Overview (${ent.href})`);

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL CRUMB CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
