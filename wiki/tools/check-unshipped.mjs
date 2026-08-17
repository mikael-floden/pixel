// A DOMAIN THE IMAGE DOES NOT CARRY MUST STILL WORK — AND MUST NEVER READ AS DELETED.
//
// Maintainer, 2026-08-17: "We use the repo for unreleased content to make the
// GCP bill less expensive. Once it's in the game it will be part of the game."
// So `tiles` (3.0) is in the repo and NOT in the deployed image, every
// /assets/tiles/** path 404s in production, and that 404 says nothing at all
// about whether the file exists.
//
// The wiki got that wrong in the worst possible way and he watched it happen:
// the World section first read "0 ground types · 0 pairs" (a failed manifest
// fetch EMPTIED the live list and then refused to retry), and then filled with
// cards saying "removed — the agent acted on this" for 56 pairs of tiles that
// were all sitting in the repo. Two defects, one arrangement.
//
// This gate reproduces production exactly: an ORIGIN THAT 404s /assets/tiles/**
// (the image) and a SECOND origin that serves them (the repo). It is the only
// way to test this — against a dev server that happens to have every domain on
// disk, the bug is invisible.
//
//   node wiki/tools/check-unshipped.mjs
//   IMAGE_URL   the wiki under test          (default http://127.0.0.1:8902)
//   REPO_URL    the stand-in for the repo    (default http://127.0.0.1:8903)
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

const IMAGE = process.env.IMAGE_URL ?? "http://127.0.0.1:8902";
const REPO = process.env.REPO_URL ?? "http://127.0.0.1:8903";
const W = `${IMAGE}/assets/wiki/site/index.html`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));

// THE IMAGE, AS DEPLOYED: it has no idea what tiles/ is.
const asked = { image: 0, repo: 0 };
await p.route(`${IMAGE}/assets/tiles/**`, (r) => { asked.image++; return r.fulfill({ status: 404, body: "not in this image" }); });
await p.route(`${REPO}/assets/tiles/**`, (r) => { asked.repo++; return r.continue(); });
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript((repo) => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${repo}/assets/`);
  localStorage.removeItem("wiki-world-filter");
}, REPO);

await p.goto(`${W}#/world`, { waitUntil: "load" });
await p.waitForTimeout(3000);
const lvl1 = await p.evaluate(() => ({
  cards: document.querySelectorAll("a.card").length,
  gone: [...document.querySelectorAll(".art-note")].map((n) => n.textContent.trim()),
  srcs: [...document.querySelectorAll("a.card img")].map((i) => i.currentSrc || i.src).filter(Boolean),
  loaded: [...document.querySelectorAll("a.card img")].filter((i) => i.complete && i.naturalWidth > 0).length,
  empty: /No pairs generated yet/i.test(document.querySelector("#content")?.innerText ?? ""),
}));
console.log("world index:", JSON.stringify({ cards: lvl1.cards, loaded: lvl1.loaded, gone: lvl1.gone.slice(0, 3), asked }));

// 1. THE SECTION IS NOT EMPTY. The manifest 404s at the image, so this is
//    exactly the path that reported "0 ground types · 0 pairs".
ok(lvl1.cards > 0 && !lvl1.empty, `the ground types are there even though the image has no tiles/ (${lvl1.cards} types)`);
// 2. NOTHING IS "REMOVED". The art is in the repo; the image simply does not
//    ship it, which is the arrangement and not a deletion.
ok(!lvl1.gone.some((t) => /removed/i.test(t)), `and not one card claims the agent removed it (${lvl1.gone.length ? lvl1.gone.join(", ") : "no notes at all"})`);
// 3. THE ART ACTUALLY DREW, from the repo.
ok(lvl1.loaded === lvl1.cards, `every face rendered (${lvl1.loaded}/${lvl1.cards})`);
const strays = lvl1.srcs.filter((s) => !s.startsWith(REPO));
ok(strays.length === 0, `all of it asked of the repo, not the image (${strays.length ? strays.join(" | ") : lvl1.srcs.length + " srcs, all " + REPO})`);

// 4. THE PAIR PAGE, the same way — this is where the "removed" wall appeared.
const type = await p.evaluate(() => document.querySelector("a.card")?.getAttribute("href"));
await p.goto(`${W}${type}`, { waitUntil: "load" });
await p.waitForTimeout(2500);
const pair = await p.evaluate(() => document.querySelector("a.card")?.getAttribute("href"));
await p.goto(`${W}${pair}`, { waitUntil: "load" });
await p.waitForTimeout(3200);
const lvl3 = await p.evaluate(() => ({
  tiles: document.querySelectorAll(".world-cand").length,
  gone: [...document.querySelectorAll(".art-note")].map((n) => n.textContent.trim()),
  // NOT getImageData: art fetched from another origin taints the canvas, which
  // is exactly the situation under test. Size is what can be read, and a scene
  // only gets sized once its images have decoded.
  canvases: [...document.querySelectorAll(".world-cand canvas")].map((cv) => cv.width),
}));
console.log("pair page:", JSON.stringify({ ...lvl3, canvases: lvl3.canvases.slice(0, 4) }));
ok(lvl3.tiles > 0, `the pair's tiles are listed (${lvl3.tiles})`);
ok(!lvl3.gone.some((t) => /removed/i.test(t)), "and none of them reads as removed either");
ok(lvl3.canvases.length > 0 && lvl3.canvases.every((n) => n > 60),
  `every preview composed from repo art (${lvl3.canvases.length} canvases, narrowest ${Math.min(...lvl3.canvases)}px)`);

// 5. NON-VACUOUS: the image really was refusing, and the repo really served.
ok(asked.image > 0, `the image WAS asked for tiles at least once and refused (${asked.image} × 404)`);
ok(asked.repo > 0, `and the repo answered (${asked.repo} requests)`);

// 6. A FAILED MANIFEST FETCH KEEPS THE BAKED LIST. Kill both origins for
//    tiles/: the live refresh cannot land, and the section must still show what
//    the build knew rather than emptying itself.
const p2 = await ctx.newPage();
p2.on("pageerror", (e) => errs.push(String(e)));
await p2.route(`${IMAGE}/assets/tiles/**`, (r) => r.fulfill({ status: 404, body: "no" }));
await p2.route(`${REPO}/assets/tiles/**`, (r) => r.fulfill({ status: 503, body: "down" }));
await p2.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p2.goto(`${W}#/world`, { waitUntil: "load" });
await p2.waitForTimeout(3000);
const blind = await p2.evaluate(() => ({
  cards: document.querySelectorAll("a.card").length,
  empty: /No pairs generated yet/i.test(document.querySelector("#content")?.innerText ?? ""),
  counts: document.querySelector("#content p.muted")?.textContent ?? "",
}));
console.log("both origins down:", JSON.stringify(blind));
ok(blind.cards > 0 && !blind.empty,
  `with the manifest unreachable the BUILD's list still stands (${blind.cards} types) — a bad response never empties the section`);

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nFAILED ${fails.length}` : "\nAll good.");
process.exit(fails.length ? 1 : 0);
