// Back returns the reader to the story they were reading, on the page they
// were reading, not to the top of the page.
import { createRequire } from "node:module";
// playwright-core lives in games2/node_modules; ESM resolves bare specifiers
// against the importing file, not the cwd.
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await (await b.newContext({ viewport: { width: 426, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const look = () => p.evaluate(() => {
  const c = document.querySelector(".story-card");
  return { y: Math.round(scrollY), h1: document.querySelector("h1")?.textContent,
    cardTop: c ? Math.round(c.getBoundingClientRect().top) : null,
    page: c?.querySelector(".detail-count")?.textContent ?? null,
    bar: Math.round(document.querySelector("#topbar")?.getBoundingClientRect().height ?? 0) };
});

// --- 1. the maintainer's exact walk: read a story, turn to page 2, follow a
//        "Read next" to another creature, press Back.
await p.goto(W + "#/monsters/tree_stump", { waitUntil: "load" });
await p.waitForTimeout(1500);
await p.evaluate(() => document.querySelector(".story-card .page-rail .nav-btn:last-child").click());
await p.waitForTimeout(400);
const reading = await look();
console.log("reading:", JSON.stringify(reading));
ok(reading.page?.startsWith("2 /"), `turned to story page 2 (${reading.page})`);

const dest = await p.evaluate(() => {
  const a = document.querySelector(".story-card .see-also .drop-row");
  const href = a.getAttribute("href"); a.click(); return href;
});
await p.waitForTimeout(1200);
const away = await look();
console.log(`followed ${dest} → ${away.h1} @ y=${away.y}`);
ok(away.h1 !== reading.h1, `the link went somewhere else (${away.h1})`);

await p.goBack({ waitUntil: "load" });
await p.waitForTimeout(1200);
const back = await look();
console.log("after Back:", JSON.stringify(back));
ok(back.h1 === reading.h1, `Back returns to ${reading.h1}`);
ok(back.y > 0, `Back does NOT land at the top (y=${back.y})`);
ok(back.page === reading.page, `the story is on the page it was left on (${back.page})`);
ok(Math.abs(back.cardTop - reading.cardTop) <= 4,
  `the story card sits where it did (${back.cardTop} vs ${reading.cardTop})`);

// --- 2. Forward again returns to the target, top-of-story as the link promised
await p.goForward({ waitUntil: "load" });
await p.waitForTimeout(1200);
const fwd = await look();
console.log("after Forward:", JSON.stringify(fwd));
ok(fwd.h1 === away.h1, `Forward returns to ${away.h1}`);

// --- 3. the ordinary case: a list, an entry, and Back to your place in the list
await p.goto(W + "#/monsters", { waitUntil: "load" });
await p.waitForTimeout(1200);
await p.evaluate(() => scrollTo(0, 1400));
await p.waitForTimeout(250);
const listY = (await look()).y;
await p.evaluate(() => [...document.querySelectorAll("a[href^='#/monsters/']")].find((a) => a.getBoundingClientRect().top > 0).click());
await p.waitForTimeout(1000);
const opened = await look();
ok(opened.y === 0, "opening a creature from the list starts at its top");
await p.goBack({ waitUntil: "load" });
await p.waitForTimeout(1000);
const backList = await look();
console.log(`list: ${listY} → creature → Back ${backList.y}`);
ok(Math.abs(backList.y - listY) <= 4, `Back keeps your place in the list (${backList.y} vs ${listY})`);

// --- 4. a fresh page still starts at the top (no stale spot leaking in)
await p.goto(W + "#/monsters/tree_stump", { waitUntil: "load" });
await p.waitForTimeout(1200);
await p.evaluate(() => { location.hash = "#/items"; });
await p.waitForTimeout(900);
ok((await look()).y === 0, "an ordinary forward navigation still starts at the top");

// --- 5. the maintainer's literal walk: Stumpling → a creature it points at (an
//        ENTITY link, which lands mid-page on the target's own story) → Back.
//        DATA-DRIVEN: the lore agent rewrites who points at whom, and pinning a
//        specific pair (it was Sprigling until lore v2) fails on their content,
//        not on this behaviour. Any entity link exercises the same rule.
const entityLink = () => p.evaluate(() =>
  [...document.querySelectorAll(".story-card .see-also a")]
    .map((a) => a.getAttribute("href"))
    .find((hr) => /^#\/(monsters|characters|items|tiles|objects)\//.test(hr)) ?? null);
await p.goto(W + "#/monsters/tree_stump", { waitUntil: "load" });
await p.waitForTimeout(1500);
await p.evaluate(() => document.querySelector(".story-card .page-rail .nav-btn:last-child").click());
await p.waitForTimeout(400);
const st = await look();
const hop1 = await entityLink();
ok(!!hop1, `Stumpling's story points at an entity (${hop1})`);
await p.evaluate((hr) => document.querySelector(`.story-card .see-also a[href="${hr}"]`).click(), hop1);
await p.waitForTimeout(1300);
const sp = await look();
console.log(`Stumpling(${st.page}) → ${sp.h1}: y=${sp.y}, card at ${sp.cardTop}`);
ok(sp.h1 && sp.h1 !== "Stumpling", `the entity link opens ${sp.h1}`);
ok(sp.cardTop !== null && Math.abs(sp.cardTop - sp.bar) <= 20, `it lands ON ${sp.h1}'s story (card at ${sp.cardTop}, topbar ${sp.bar})`);
await p.goBack({ waitUntil: "load" });
await p.waitForTimeout(1300);
const st2 = await look();
console.log("Back →", JSON.stringify(st2));
ok(st2.h1 === "Stumpling" && st2.page === st.page && Math.abs(st2.cardTop - st.cardTop) <= 4,
  `Back lands on Stumpling's story, page ${st.page}, where it was`);

// --- 6. a three-deep trail unwinds one page at a time
await p.evaluate((hr) => document.querySelector(`.story-card .see-also a[href="${hr}"]`).click(), hop1);
await p.waitForTimeout(1200);
const midName = (await look()).h1;
await p.evaluate(() => document.querySelector(".story-card .see-also a").click());
await p.waitForTimeout(1200);
const deep = await look();
await p.goBack({ waitUntil: "load" }); await p.waitForTimeout(1100);
const mid = await look();
await p.goBack({ waitUntil: "load" }); await p.waitForTimeout(1100);
const home = await look();
console.log(`trail: Stumpling → ${midName} → ${deep.h1} | back: ${mid.h1}@${mid.y} → ${home.h1}@${home.y}`);
ok(mid.h1 === midName && mid.y > 0, `first Back → ${midName}, still on its story (y=${mid.y})`);
ok(home.h1 === "Stumpling" && home.page === st.page, `second Back → Stumpling, page ${home.page}`);

console.log("page errors:", errs.length ? errs : "none");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL BACK CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
