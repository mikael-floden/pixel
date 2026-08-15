// LOOK AHEAD, SO THE NEXT CLICK COSTS NOTHING.
//
// Maintainer, 2026-08-15: "When I fetch a tree and open its resource page I
// want all states to load in the background and also the tree on the
// next/prev-button page and all its states. This is to make the wiki faster
// and 'prepare' for what I might look at next. Same for opening a monster —
// all animations should load in case I click on a different animation or
// different direction, and also the monster on the next and prev page. Of
// course we should not reload something I have already loaded."
//
// Reviewing is a rhythm — open, click through the variants and directions,
// press ›, repeat — and every one of those clicks used to begin a download.
// What this gate holds: the look-ahead really covers the whole entity AND its
// two neighbours, a click after that costs zero requests, and nothing is ever
// fetched twice.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const ORIGIN = process.env.WIKI_URL ?? "http://127.0.0.1:8902";
const W = `${ORIGIN}/assets/wiki/site/index.html`;

const clipsOf = (e) => Object.values(e?.animations ?? {}).flatMap((a) => Object.values(a.dirs ?? {}));
// What the player would actually fetch for a clip: a strip is the whole
// animation in one file; a frame directory draws its first frame first.
const firstAsset = (c) => c.strip
  ?? `${c.framesDir}/${String(0).padStart(c.framePad ?? 1, "0")}.${c.frameExt ?? "png"}`;
const assetsOf = (e) => clipsOf(e).map(firstAsset).filter(Boolean);

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
let reqs = [];
p.on("request", (r) => { if (r.resourceType() === "image") reqs.push(r.url().replace(`${ORIGIN}/assets/`, "")); });
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});

// ------------------------------------------------------------------ scenery
// A piece with many states, so "all states" means something.
const tree = [...D.domains.objects].sort((a, b2) => Object.keys(b2.animations).length - Object.keys(a.animations).length)[0];
const list = D.domains.objects;
const at = list.findIndex((o) => o.id === tree.id);
const neighbours = [list[(at - 1 + list.length) % list.length], list[(at + 1) % list.length]];
await p.goto(`${W}#/objects/${tree.id}`, { waitUntil: "load" });
await p.waitForTimeout(4500);
const own = assetsOf(tree);
const gotOwn = own.filter((u) => reqs.includes(u));
console.log(`${tree.id}: ${Object.keys(tree.animations).length} states, ${gotOwn.length}/${own.length} warmed`);
ok(own.length > 3, `the test piece really has several states (${own.length} files)`);
ok(gotOwn.length === own.length, `every state of the open piece is fetched up front (${gotOwn.length}/${own.length})`);
for (const n of neighbours) {
  const na = assetsOf(n);
  const got = na.filter((u) => reqs.includes(u));
  console.log(`  neighbour ${n.id}: ${got.length}/${na.length}`);
  ok(got.length === na.length, `and every state of ${n.id === neighbours[0].id ? "the previous" : "the next"} piece too (${got.length}/${na.length})`);
}

// A CLICK AFTER THAT COSTS NOTHING. The warmed image is kept decoded, so the
// player neither re-requests nor re-decodes it.
let mark = reqs.length;
const states = await p.evaluate(() => [...document.querySelectorAll(".seg-states button")].map((x) => x.title));
for (const s of states.slice(1, 5)) {
  await p.evaluate((t) => [...document.querySelectorAll(".seg-states button")].find((x) => x.title === t)?.click(), s);
  await p.waitForTimeout(350);
}
console.log(`clicking through ${Math.min(4, states.length - 1)} more states:`, reqs.length - mark, "requests");
ok(reqs.length === mark, `switching state fetches nothing — it is already here (${reqs.length - mark} requests)`);

// PAGING ‹ › — the piece itself is warm; only the NEW neighbour is fetched.
mark = reqs.length;
await p.evaluate(() => [...document.querySelectorAll("button,a")].find((x) => x.textContent.trim() === "›")?.click());
await p.waitForTimeout(2500);
const after = reqs.slice(mark);
const nextPiece = list[(at + 1) % list.length];
const forNext = assetsOf(nextPiece).filter((u) => after.includes(u));
console.log("paging ›:", after.length, "requests;", forNext.length, "of them for the piece now on screen");
ok(forNext.length <= 1, `the piece you land on was already warm (${forNext.length} of its ${assetsOf(nextPiece).length} files re-requested — the page's own <img> thumbnail is allowed)`);
ok(after.length > 0, "and the look-ahead moves with you — the piece after it starts warming");

// NEVER TWICE. The whole point of the "we should not reload something I have
// already loaded" line: one URL, one fetch, for the player's own loads.
const dupes = reqs.filter((u, i) => reqs.indexOf(u) !== i);
const stripDupes = [...new Set(dupes)].filter((u) => !/\/(sprite|preview)\.(webp|png)$/.test(u));
console.log("repeat fetches:", dupes.length, "| of animation strips:", stripDupes.length, stripDupes.slice(0, 3));
ok(stripDupes.length === 0, `no animation file is ever fetched twice${stripDupes.length ? ` — ${stripDupes.slice(0, 2).join(", ")}` : ""}`);

// ----------------------------------------------------------------- monsters
// 5 states x 8 directions — the case where the old behaviour cost a fetch on
// every single click.
reqs = [];
const m = D.domains.monsters.find((x) => Object.keys(x.animations).length >= 4) ?? D.domains.monsters[0];
await p.goto(`${W}#/monsters/${m.id}`, { waitUntil: "load" });
await p.waitForTimeout(6000);
const ma = assetsOf(m);
const gotM = ma.filter((u) => reqs.includes(u));
console.log(`${m.id}: ${Object.keys(m.animations).length} states x 8 directions, ${gotM.length}/${ma.length} warmed`);
ok(gotM.length === ma.length, `every animation of the creature is warmed (${gotM.length}/${ma.length})`);
const mlist = D.domains.monsters;
const mi = mlist.findIndex((x) => x.id === m.id);
for (const n of [mlist[(mi - 1 + mlist.length) % mlist.length], mlist[(mi + 1) % mlist.length]]) {
  const na = assetsOf(n);
  ok(na.filter((u) => reqs.includes(u)).length === na.length, `and the whole of ${n.id}, one ‹ › away (${na.length} files)`);
}
mark = reqs.length;
await p.evaluate(() => [...document.querySelectorAll(".seg-states button")].pop()?.click());
await p.waitForTimeout(400);
await p.evaluate(() => [...document.querySelectorAll(".dirpad button")].find((x) => x.textContent === "NW")?.click());
await p.waitForTimeout(400);
await p.evaluate(() => [...document.querySelectorAll(".dirpad button")].find((x) => x.textContent === "W")?.click());
await p.waitForTimeout(700);
console.log("last state + two directions:", reqs.length - mark, "requests");
ok(reqs.length === mark, `clicking a different animation and turning it costs nothing (${reqs.length - mark} requests)`);

// THE READER'S OWN SETTINGS WIN. Data Saver means fetch the page, not the
// speculation.
const saver = await ctx.browser().newContext({ viewport: { width: 393, height: 851 } });
const sp = await saver.newPage();
const sreqs = [];
sp.on("request", (r) => { if (r.resourceType() === "image") sreqs.push(r.url()); });
await sp.addInitScript(() => {
  Object.defineProperty(navigator, "connection", { configurable: true, get: () => ({ saveData: true }) });
});
await sp.goto(`${W}#/objects/${tree.id}`, { waitUntil: "load" });
await sp.waitForTimeout(3500);
console.log("with Data Saver on:", sreqs.length, "image requests");
ok(sreqs.length > 0 && sreqs.length < own.length, `Data Saver gets the page and no look-ahead (${sreqs.length} requests vs ${own.length} files warmed otherwise)`);
await saver.close();

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL PREFETCH CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
