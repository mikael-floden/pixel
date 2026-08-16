// TWO TILE SYSTEMS, SIDE BY SIDE — "Tiles OLD" and "World".
//
// Maintainer, 2026-08-16: "The tiles agent is working in what we call Tiles
// 3.0. This is placed in the new /tiles folder. When the new tile system is
// complete the old /tiles2 will be removed. This however is a big task and we
// will need the wiki in order to know if /tiles (3.0) works. Can you in the
// wiki have two tiles systems/pages? Tiles OLD and World? World is the new
// Tiles 3.0 system (/tiles). I will have to review the new system to make it
// good."
//
// So the NEW system takes the good name, and the review surface is built
// around the question the tiles agent's own manifest asks: for each "A over B"
// pair it offers two or three candidates ranked by a measured wall score, and
// asks which one to keep. `tiles/review/manifest.json` says what a verdict
// means — "`tile_id` is the PixelLab generation a rejection should delete … A
// DELETED cell is tombstoned and never regenerated, unlike a rejected one" —
// so verdicts ride that manifest's OWN keys, in the `tiles` feedback file the
// agent already reads.
//
// The two audiences are NOT the same here, and that is deliberate: a player
// sees one ground section, still called World, holding the tiles the game
// actually renders. "Tiles OLD" is a migration word that means nothing to a
// reader, and an unfinished ground system in the encyclopedia is a promise the
// game cannot keep.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const CELLS = DATA.domains.world ?? [];
const MAN = JSON.parse(readFileSync(new URL("../../tiles/review/manifest.json", import.meta.url), "utf8"));
console.log(`manifest: ${Object.keys(MAN.cells ?? {}).length} cells | data.json: ${CELLS.length} | candidates: ${DATA.counts.world_candidates}`);

// THE BUILD IS THE AGENT'S DATA, NOT THE WIKI'S OPINION. Every number the page
// shows has to come back to the manifest, or his verdict would be about a
// ranking nobody else can reproduce.
ok(CELLS.length > 0, `the build reads the tiles agent's review manifest (${CELLS.length} pairs)`);
ok(CELLS.length === Object.keys(MAN.cells).length, "every cell in the manifest becomes a pair in the wiki");
const flat = CELLS.flatMap((c) => c.candidates);
ok(flat.every((c) => /^tiles\/[a-z0-9_]+__over__[a-z0-9_]+\/\d+$/.test(c.key)),
  `every candidate keeps the MANIFEST's own key, so a verdict names what the agent named (${flat[0]?.key})`);
ok(flat.every((c) => c.art?.startsWith("tiles/review/")), "and points at the art the agent published");
ok(flat.every((c) => typeof c.wallScore === "number"), "carrying the agent's measured wall score");
ok(CELLS.every((c) => c.candidates.every((x, i, a) => i === 0 || a[i - 1].wallScore >= x.wallScore)),
  "in the agent's own ranked order — best first");
ok(!!DATA.worldMeta?.accept?.min_wall_score, `and the acceptance bar it ranks against (${DATA.worldMeta?.accept?.min_wall_score})`);
// The score on the page must be the score in the manifest, to the decimal.
const one = CELLS[0], manOne = MAN.cells[one.id];
ok(one.candidates.every((c, i) => c.wallScore === manOne.candidates[i].wall_score),
  `scores match the manifest exactly (${one.id}: ${one.candidates.map((c) => c.wallScore).join(", ")})`);

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const posted = [];
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.route("**/api/wiki/save", async (r) => {
  posted.push(JSON.parse(r.request().postData() || "{}"));
  await r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
});
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  localStorage.removeItem("wiki-world-filter");
});

const nav = () => p.evaluate(() => [...document.querySelectorAll("#nav a")].map((a) => a.textContent.replace(/\d+$/, "").trim()));

// ------------------------------------------------------------- 1. two systems
await p.goto(`${W}#/`, { waitUntil: "load" });
await p.waitForTimeout(2200);
const adminNav = await nav();
console.log("admin nav:", JSON.stringify(adminNav));
ok(adminNav.includes("World") && adminNav.includes("Tiles OLD"),
  "the Game Master gets BOTH ground sections — World and Tiles OLD");
ok(adminNav.indexOf("World") < adminNav.indexOf("Tiles OLD"),
  "with the new system first — the one being replaced is not the one you reach first");

// ------------------------------------------------------------- 2. the pairs
await p.goto(`${W}#/world`, { waitUntil: "load" });
await p.waitForTimeout(2200);
// Cards below the fold keep their art lazy, so "does every pair draw?" has to
// ask for the whole grid first — otherwise it measures the viewport.
await p.evaluate(() => document.querySelectorAll('img[loading="lazy"]').forEach((im) => { im.loading = "eager"; }));
await p.waitForTimeout(1200);
const list = await p.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent,
  cards: document.querySelectorAll("a.card").length,
  first: document.querySelector("a.card .card-name")?.textContent,
  hrefs: [...document.querySelectorAll("a.card")].map((a) => a.getAttribute("href")).slice(0, 3),
  art: [...document.querySelectorAll("a.card img")].filter((i) => i.complete && i.naturalWidth > 0).length,
  filters: [...document.querySelectorAll(".sortbar button")].map((x) => x.textContent.trim()),
}));
console.log("World overview:", JSON.stringify(list));
ok(list.h1 === "World", `the new system is the section called World (“${list.h1}”)`);
ok(list.cards === CELLS.length, `every pair is listed (${list.cards}/${CELLS.length})`);
ok(list.art === list.cards, `and every one of them draws its tile (${list.art}/${list.cards})`);
ok(/ over /.test(list.first ?? ""), `named as the pair it is (“${list.first}”)`);
ok(list.hrefs.every((h) => h.startsWith("#/world/")), "each opens its own page");
ok(list.filters.some((f) => /not reviewed/.test(f)), `with a review filter to find the work (${list.filters.join(" | ")})`);

// ------------------------------------------------------------- 3. the review
const cell = CELLS.find((c) => c.candidates.length > 1) ?? CELLS[0];
await p.goto(`${W}#/world/${cell.id}`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const page = await p.evaluate(() => ({
  h1: document.querySelector("h1")?.textContent,
  cands: document.querySelectorAll(".world-cand").length,
  art: [...document.querySelectorAll(".world-cand img")].filter((i) => i.complete && i.naturalWidth > 0).length,
  scores: [...document.querySelectorAll(".world-cand .card-name")].map((x) => x.textContent.trim()),
  metrics: document.querySelector(".world-cand .metric-row")?.textContent ?? "",
  verdicts: document.querySelectorAll(".world-cand .verdict").length,
  pairVerdict: [...document.querySelectorAll(".detail-head button")].map((x) => x.textContent).join("|"),
  prompt: !!document.querySelector(".world-prompt"),
  pager: document.querySelector(".detail-count")?.textContent ?? null,
}));
console.log("cell page:", JSON.stringify(page));
ok(page.cands === cell.candidates.length, `every generation of the pair is shown (${page.cands})`);
ok(page.art === page.cands, `each drawing its own tile (${page.art}/${page.cands})`);
ok(page.verdicts === page.cands, "each with its OWN verdict — the candidate is the review unit");
ok(/tiling/.test(page.metrics) && /discretion/.test(page.metrics) && /structure/.test(page.metrics),
  `and the measurements behind its rank, named (“${page.metrics.trim()}”)`);
ok(/wall \d/.test(page.scores[0] ?? ""), `with the score itself on the card (“${page.scores[0]}”)`);
ok(/drop this pair/.test(page.pairVerdict), "the PAIR has its own verdict too — tombstone it, never regenerate");
ok(page.prompt, "and the prompt that produced it is there to read");
ok(/\d+ \/ \d+/.test(page.pager ?? ""), `‹ › walks the pairs (${page.pager})`);

// A verdict must land on the manifest's key, in the file the agent reads.
await p.evaluate(() => document.querySelector(".world-cand .verdict button")?.click());
await p.waitForTimeout(300);
await p.evaluate(() => [...document.querySelectorAll("#savebar button")].find((x) => /Commit/.test(x.textContent))?.click());
await p.waitForTimeout(1200);
console.log("posted:", JSON.stringify(posted[0] ?? null).slice(0, 240));
ok(posted[0]?.file === "feedback/tiles",
  `the verdict goes to the feedback file the tiles agent reads (${posted[0]?.file})`);
const keys = Object.keys(posted[0]?.set ?? {});
ok(keys.length === 1 && keys[0] === cell.candidates[0].key,
  `keyed exactly as the manifest keyed it (${keys[0]})`);
ok(!keys.some((k) => k.startsWith("tiles2/")), "and cannot collide with Tiles OLD, whose ids all start tiles2/");

// ------------------------------------------------------------- 4. the player
// He asked for a migration surface, not a change to the encyclopedia.
const pub = await ctx.newPage();
await pub.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":false}' }));
await pub.addInitScript(() => localStorage.removeItem("wiki-admin-token"));
await pub.goto(`${W}#/`, { waitUntil: "load" });
await pub.waitForTimeout(2000);
const pubNav = await pub.evaluate(() => [...document.querySelectorAll("#nav a")].map((a) => a.textContent.replace(/\d+$/, "").trim()));
console.log("player nav:", JSON.stringify(pubNav));
ok(!pubNav.includes("Tiles OLD"), "a player is never shown the migration word “Tiles OLD”");
ok(pubNav.includes("World"), "they still have a World section");
ok(pubNav.filter((n) => n === "World").length === 1, "exactly one ground section, not two half-built ones");
const pubTiles = await pub.evaluate(() => {
  const a = [...document.querySelectorAll("#nav a")].find((x) => /^World/.test(x.textContent));
  return a?.getAttribute("href");
});
ok(pubTiles === "#/tiles", `and it is the one the game actually renders (${pubTiles})`);

ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ") || "none"})`);
await b.close();
console.log(fails.length ? `\nFAILED ${fails.length}` : "\nAll good.");
process.exit(fails.length ? 1 : 0);
