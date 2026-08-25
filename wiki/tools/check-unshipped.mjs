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
import { readFileSync } from "node:fs";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

const IMAGE = process.env.IMAGE_URL ?? "http://127.0.0.1:8902";
const REPO = process.env.REPO_URL ?? "http://127.0.0.1:8903";
const W = `${IMAGE}/assets/wiki/site/index.html`;

const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
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
// Each card carries TWO images since the per-tile before/after chip (the
// shipped face and its raw twin), so the claim is about IMAGES, not cards —
// comparing against the card count silently drifted into always-false.
ok(lvl1.srcs.length > 0 && lvl1.loaded === lvl1.srcs.length,
  `every face rendered (${lvl1.loaded}/${lvl1.srcs.length} images across ${lvl1.cards} cards)`);
const strays = lvl1.srcs.filter((s) => !s.startsWith(REPO));
ok(strays.length === 0, `all of it asked of the repo, not the image (${strays.length ? strays.join(" | ") : lvl1.srcs.length + " srcs, all " + REPO})`);

// 4. THE PAIR PAGE, the same way — this is where the "removed" wall appeared.
const type = await p.evaluate(() => document.querySelector("a.card")?.getAttribute("href"));
await p.goto(`${W}${type}`, { waitUntil: "load" });
await p.waitForTimeout(2500);
// The ground page opens on its set editor since 2026-08-25; the pairs are one
// tab over, and it is a PAIR page this gate needs.
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /On top of/.test(x.textContent))?.click());
await p.waitForTimeout(1400);
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

// 7. A MIXED DOMAIN — the image ships SOME of it — AND ART THAT IS NOT AN <img>.
//    Maintainer 2026-08-19: "when I restart the game and click on wiki … the
//    monsters not in the game will show an empty card. I then click on the
//    first empty card and back again and now all monsters display correctly."
//
//    Two things made that possible. The image ships 24 of 57 creatures, so
//    `monsters` is a SHIPPED domain with unshipped members — the per-domain
//    rule above cannot see them. And the Creatures overview draws its art as a
//    CSS background (one strip, swept by steps()), which cannot fire an `error`
//    event, so the whole ask-the-repo recovery every <img> gets was bypassed
//    and the card just stayed blank. His click was that recovery happening by
//    accident, on the creature page's <img>s.
//
//    THE ASSERTION IS ON THE COLD LOAD, WITH NO CLICKING — a page that heals
//    only after you visit something is the bug.
const shippedIds = new Set((D.domains.monsters ?? []).map((m) => m.id).slice(0, 24));
const p3 = await ctx.newPage();
p3.on("pageerror", (e) => errs.push(String(e)));
let monsterMiss = 0;
await p3.route(`${IMAGE}/assets/monsters/**`, (r) => {
  const id = new URL(r.request().url()).pathname.split("/assets/monsters/")[1].split("/")[0];
  if (shippedIds.has(id)) return r.continue();
  monsterMiss++; return r.fulfill({ status: 404, body: "not in this image" });
});
await p3.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p3.goto(`${W}#/monsters`, { waitUntil: "load" });
await p3.waitForTimeout(4500);
// DOES IT ACTUALLY DRAW? A background-image that 404s leaves the property set
// and the card empty, so reading the style proves nothing — each url is
// re-fetched here and asked to decode.
const cold = await p3.evaluate(async () => {
  const arts = [...document.querySelectorAll(".showcase-art")];
  const armed = arts.filter((a) => a.style.backgroundImage);
  let blank = 0;
  for (const a of armed) {
    const url = a.style.backgroundImage.slice(5, -2);
    const drew = await new Promise((res) => { const i = new Image(); i.onload = () => res(true); i.onerror = () => res(false); i.src = url; });
    if (!drew) blank++;
  }
  return {
    cards: document.querySelectorAll(".showcase-card").length,
    armed: armed.length, blank,
    fromRepo: armed.filter((a) => a.style.backgroundImage.includes("8903")).length,
    // The silent state this gate exists for: a card that was ASKED to paint and
    // then showed neither art nor a note. An un-armed card is lazy, not silent
    // — counting those made this read 52 on a page with nothing wrong.
    mute: arts.filter((a) => a.dataset.armed && !a.style.backgroundImage
      && !a.closest(".showcase")?.querySelector(".art-note")).length,
    notes: document.querySelectorAll(".showcase .art-note").length,
  };
});
console.log("creatures, cold:", JSON.stringify(cold), `| image 404s: ${monsterMiss}`);
ok(monsterMiss > 0, `the image refused the creatures it does not ship (${monsterMiss} × 404) — the test is not vacuous`);
ok(cold.armed > 0 && cold.blank === 0,
  `every card on screen actually draws, with no clicking (${cold.armed - cold.blank}/${cold.armed})`);
ok(cold.fromRepo > 0, `and the unshipped ones came from the repo (${cold.fromRepo} of ${cold.armed} armed)`);
ok(cold.mute === 0, `no card is silently empty — art or a note, never neither (${cold.mute})`);

// …AND WHEN THE ART IS NOWHERE, THE CARD SAYS SO. Same page with the repo dead
// too: the one outcome that must never be silence.
const p4 = await ctx.newPage();
p4.on("pageerror", (e) => errs.push(String(e)));
await p4.route(`${IMAGE}/assets/monsters/**`, (r) => {
  const id = new URL(r.request().url()).pathname.split("/assets/monsters/")[1].split("/")[0];
  return shippedIds.has(id) ? r.continue() : r.fulfill({ status: 404, body: "not in this image" });
});
await p4.route(`${REPO}/**monsters/**`, (r) => r.fulfill({ status: 503, body: "down" }));
await p4.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p4.goto(`${W}#/monsters`, { waitUntil: "load" });
await p4.waitForTimeout(6000);
const dark = await p4.evaluate(() => ({
  mute: [...document.querySelectorAll(".showcase-art")].filter((a) => a.dataset.armed
    && !a.style.backgroundImage && !a.closest(".showcase")?.querySelector(".art-note")).length,
  notes: [...document.querySelectorAll(".showcase .art-note")].map((n) => n.textContent.trim()),
  cards: document.querySelectorAll(".showcase-card").length,
}));
console.log("creatures, repo down:", JSON.stringify({ ...dark, notes: dark.notes.slice(0, 2) }));
ok(dark.notes.length > 0 || dark.cards < (D.domains.monsters ?? []).length,
  `art nowhere to be found is SAID, not shown as an empty box (${dark.notes.length} notes, ${dark.cards} cards left)`);
ok(!dark.notes.some((t) => /removed/i.test(t)),
  "and a 503 is never reported as the agent having deleted the creature");
ok(dark.mute === 0, `not one armed card sits blank and wordless even then (${dark.mute})`);

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nFAILED ${fails.length}` : "\nAll good.");
process.exit(fails.length ? 1 : 0);
