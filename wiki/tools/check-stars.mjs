// THE TILES WITH NO STAR — his inbox for the Tiles 3.0 review.
//
// Maintainer 2026-08-20: "I have now reviewed all tiles in the new /tiles and
// given 1 star to every tile that doesn't have an issue. The tiles-agent have
// fixed everything I rejected, so I need to be able to filter on tiles that
// doesn't have any stars ... Hmm that ofc makes NO-STAR a filter and not a
// sorting. Make it a filter ... If at least one tile inside a tiletype has
// null stars, that tile group is visible and not filtered out. If I click on
// that tile group I only see tiles with null stars. If I click on a tile 'next
// next next' will iterate all tiles with null stars ... I will jump from one
// tile group to another and the tile group headline has to be improved to
// mention 'x over y', not only X as we have today."
//
// The contract, which is one question asked at three grains:
//   1. FILTER, NOT SORT — the settled tiles are GONE from the list, at every
//      level, so neither scrolling nor ‹ › can walk into them.
//   2. IT CASCADES — overview keeps types holding an unrated tile, the type
//      page keeps that type's sets holding one, the set page shows only the
//      unrated tiles themselves.
//   3. ‹ › WALKS THE WHOLE INBOX, crossing ground types — and every headline
//      it lands on names the set in full ("X over y"), because "which set am
//      I in" stops being answered by the page you came from.
//   4. A STAR REMOVES ITS TILE THERE AND THEN, and finishing a set does not
//      yank the page out from under him.
//
// The ratings are written through the page's own __wiki.setFb into the live
// store IN MEMORY; /api/wiki/save is captured at the network boundary, so
// nothing here reaches the real one.
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const saves = [];
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.route("**/api/wiki/save", (r) => { saves.push(r.request().postDataJSON()); return r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  localStorage.setItem("wiki-world-stars", "all");
  localStorage.setItem("wiki-world-filter", "all");
});
await p.goto(`${W}#/world`, { waitUntil: "load" });
await p.waitForTimeout(3000);

// ---- the fixture: star EVERYTHING, then un-star a handful in two types ----
// This is his actual situation: a finished pass, then the agent's regenerated
// replacements landing with no rating at all.
const fixture = await p.evaluate(() => {
  const w = window.__wiki.state.data.domains.world;
  for (const c of w) for (const cand of c.candidates) window.__wiki.setFb("tiles", cand.key, { rating: 1 });
  const tops = [...new Set(w.map((c) => c.top))];
  const A = w.find((c) => c.top === tops[0]);
  const B = w.find((c) => c.top === tops[2]);
  A.candidates.slice(0, 3).forEach((cand) => window.__wiki.setFb("tiles", cand.key, { rating: null }));
  B.candidates.slice(0, 1).forEach((cand) => window.__wiki.setFb("tiles", cand.key, { rating: null }));
  window.__wiki.route();
  return {
    types: tops.length, pairs: w.length,
    tiles: w.reduce((n, c) => n + c.candidates.length, 0),
    A: { top: A.top, side: A.side, name: A.name, n: A.candidates.length },
    B: { top: B.top, side: B.side, name: B.name, n: B.candidates.length },
  };
});
console.log(`fixture: ${fixture.tiles} tiles in ${fixture.pairs} sets across ${fixture.types} ground types — 4 left unstarred, in 2 types`);
ok(fixture.types > 3 && fixture.tiles > 100, "the section is big enough for the filter to matter");

const pickStars = (mode) => p.evaluate((m) => {
  const btn = [...document.querySelectorAll(".sortbar-btn")].find((x) => (m === "unrated" ? /no stars/ : /^all /).test(x.textContent));
  btn?.click();
}, mode);
const read = () => p.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent ?? "",
  crumb: document.querySelector(".crumb")?.textContent ?? "",
  count: document.querySelector(".detail-count")?.textContent ?? "",
  nextTitle: document.querySelectorAll(".nav-btn")[1]?.getAttribute("title") ?? "",
  panel: document.querySelector(".panel-title")?.textContent ?? "",
  cards: [...document.querySelectorAll("a.card")].map((c) => ({
    name: c.querySelector(".card-name")?.textContent ?? "",
    sub: c.querySelector(".card-sub")?.textContent ?? "",
    pill: c.querySelector(".pill")?.textContent ?? "",
    href: c.getAttribute("href"),
  })),
  tiles: [...document.querySelectorAll(".world-cand")].map((t) => ({
    stars: [...t.querySelectorAll(".stars button")].filter((s) => s.classList.contains("lit")).length,
  })),
  bar: [...document.querySelectorAll(".sortbar-btn")].map((x) => x.textContent.trim()),
}));

// ---- 1. THE OVERVIEW, unfiltered then filtered ------------------------------
const before = await read();
ok(before.cards.length === fixture.types, `unfiltered, every ground type is listed (${before.cards.length})`);
await pickStars("unrated");
await p.waitForTimeout(600);
const ov = await read();
console.log(`overview: ${ov.cards.map((c) => `${c.name} [${c.pill}]`).join(", ")}`);
ok(ov.cards.length === 2, `the filter keeps ONLY the ground types holding an unstarred tile (${ov.cards.length} of ${fixture.types})`);
ok(ov.bar.some((t) => /no stars 2/.test(t)), `and the control counts them (${ov.bar.filter((t) => /stars|^all /.test(t)).join(" | ")})`);
ok(ov.cards.every((c) => /without a star/.test(c.pill)), `each card says how many it holds (${ov.cards.map((c) => c.pill).join(", ")})`);
// It is a FILTER, not a sort: the settled types are not merely further down.
ok(!ov.cards.some((c) => c.name === "Grass" && !/without a star/.test(c.pill)),
  "a fully starred ground type is GONE from the list, not sorted to the bottom");

// ---- 2. THE TYPE PAGE cascades ---------------------------------------------
await p.evaluate(() => document.querySelector("a.card")?.click());
await p.waitForTimeout(700);
const ty = await read();
console.log(`type page: ${ty.h1} — ${ty.cards.map((c) => c.name).join(", ")}`);
ok(ty.cards.length === 1, `inside a type, only the sets holding an unstarred tile (${ty.cards.length})`);
// His headline note: a card here can send him anywhere, so it names both halves.
ok(/ over /i.test(ty.cards[0].name),
  `and the set is named in full — "x over y", not just the wall (${ty.cards[0].name})`);
ok(/3 of \d+ without a star/.test(ty.cards[0].sub), `with the size of the job on it (${ty.cards[0].sub})`);

// ---- 3. THE SET PAGE shows only unstarred tiles -----------------------------
await p.evaluate(() => document.querySelector("a.card")?.click());
await p.waitForTimeout(1300);
const pr = await read();
console.log(`set page: ${pr.h1} | ${pr.count} | ${pr.panel}`);
ok(pr.tiles.length === 3, `only the unstarred tiles are shown (${pr.tiles.length} of ${fixture.A.n})`);
ok(pr.tiles.every((t) => t.stars === 0), "and every one of them really has no star");
ok(/ over /i.test(pr.h1), `the headline names the whole set (${pr.h1})`);
ok(/without a star/.test(pr.panel), `and the panel says what it is showing (${pr.panel})`);

// ---- 4. ‹ › WALKS THE INBOX, ACROSS GROUND TYPES ----------------------------
ok(pr.count === "1 / 2", `the pager counts the INBOX, not this type's sets (${pr.count})`);
ok(/ over /i.test(pr.nextTitle) && /without a star/.test(pr.nextTitle),
  `and names where › goes (${pr.nextTitle})`);
await p.evaluate(() => document.querySelectorAll(".nav-btn")[1]?.click());
await p.waitForTimeout(1300);
const nx = await read();
console.log(`after ›: ${nx.h1} | ${nx.count}`);
ok(nx.h1 !== pr.h1 && / over /i.test(nx.h1), `› lands on another set, named in full (${nx.h1})`);
ok(!nx.h1.startsWith(pr.h1.split(" over ")[0]),
  "…and it is in a DIFFERENT ground type — the pager crosses groups, which is the whole point");
ok(nx.tiles.length === 1 && nx.tiles.every((t) => t.stars === 0), `showing its one unstarred tile (${nx.tiles.length})`);

// ---- 5. A STAR REMOVES ITS TILE, AND FINISHING DOES NOT YANK THE PAGE -------
await p.evaluate(() => document.querySelector(".world-cand .stars button")?.click());
await p.waitForTimeout(600);
const done = await p.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent ?? "",
  tiles: document.querySelectorAll(".world-cand").length,
  hint: /Press ›/.test(document.querySelector("#content")?.innerText ?? ""),
  allStarred: /all starred/.test(document.querySelector("#content")?.innerText ?? ""),
}));
console.log(`after starring the last one: ${JSON.stringify(done)}`);
ok(done.tiles === 0, "starring a tile takes it out of the list on the spot");
ok(done.h1 === nx.h1, "…without moving him off the set he is standing on");
ok(done.hint && done.allStarred, "which says it is finished and points at › for the next one");

// ---- 6. IT IS A PREFERENCE, and turning it off restores everything ----------
await p.goto(`${W}#/world`, { waitUntil: "load" });
await p.waitForTimeout(2000);
const kept = await read();
ok(kept.cards.length === 1 || kept.cards.length === 2,
  `the choice survives navigation (${kept.cards.length} type(s) still listed)`);
await pickStars("all");
await p.waitForTimeout(600);
const back = await read();
ok(back.cards.length === fixture.types, `and turning it off brings every ground type back (${back.cards.length})`);

// ---- 7. NOT FOR PLAYERS -----------------------------------------------------
const pub = await ctx.newPage();
pub.on("pageerror", (e) => errs.push(String(e)));
await pub.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":false}' }));
await pub.addInitScript(() => { localStorage.removeItem("wiki-admin-token"); localStorage.setItem("wiki-world-stars", "unrated"); });
await pub.goto(`${W}#/world`, { waitUntil: "load" });
await pub.waitForTimeout(1800);
const seen = await pub.evaluate(() => ({
  cards: document.querySelectorAll("a.card").length,
  bar: [...document.querySelectorAll(".sortbar-btn")].map((x) => x.textContent),
}));
ok(seen.cards > 2 && !seen.bar.some((t) => /no stars/.test(t)),
  `a player gets no star control and the whole world (${seen.cards} grounds, ${seen.bar.length} controls)`);

ok(saves.length === 0, `nothing was committed by this gate (${saves.length} saves)`);
ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nSTAR-FILTER CHECKS FAILED (${fails.length})` : "\nALL STAR-FILTER CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
