// FIND THE KIND OF THING YOU ARE LOOKING FOR.
//
// Maintainer, 2026-08-14: "On scenery it's hard to find the objects I'm
// looking for. Can you make a filter on type (TREE, WINDOW, MOUNTAIN_WALL,
// TOWN, IN-DOOR, NATURE, OTHER)? … I understand this data might not exist from
// the Scenery yet. But it should be owned by the scenery … One more thing! If
// I filter on TREES and click on a tree — 'next next next' should only display
// trees."
//
// The taxonomy lives in scenery/config/factory.json, one `type` per group, so
// the scenery agent can retype anything it disagrees with and the wiki simply
// follows. What this gate holds is (1) the data really comes from there and
// covers every piece, and (2) the filter reaches all the way into the pager —
// a filter that quietly stops applying when you click a card is worse than no
// filter, because you cannot see that it stopped.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const FACTORY = JSON.parse(readFileSync(new URL("../../scenery/config/factory.json", import.meta.url), "utf8"));
const objs = D.domains.objects ?? [];
const TYPES = ["TREE", "WINDOW", "MOUNTAIN_WALL", "TOWN", "INDOOR", "NATURE", "OTHER"];

// ------------------------------------------------ the data, and whose it is
const groups = FACTORY.groups ?? [];
const untyped = groups.filter((g) => !g.type);
console.log(`factory: ${groups.length} groups, vocabulary ${JSON.stringify(FACTORY.types?.values ?? null)}`);
ok(untyped.length === 0, `every group in the scenery catalog carries a type${untyped.length ? ` — missing on ${untyped.slice(0, 3).map((g) => g.id).join(", ")}` : ` (${groups.length})`}`);
ok(groups.every((g) => TYPES.includes(g.type)), "and every one of them is from the agreed vocabulary");
ok(JSON.stringify(FACTORY.types?.values) === JSON.stringify(TYPES), "which the config states outright, for whoever edits it next");
ok(!!FACTORY.types?._note, "with a note saying who added it and that the scenery domain owns it");

const noType = objs.filter((o) => !o.type);
ok(noType.length === 0, `every piece reaches the wiki with a type${noType.length ? ` — ${noType.slice(0, 3).map((o) => o.id).join(", ")}` : ` (${objs.length})`}`);
// The wiki must not be inventing them: a piece's type has to match its group's
// (or its own override), never a guess made in build.mjs.
const gType = new Map(groups.map((g) => [g.id, g.type]));
const mismatch = objs.filter((o) => gType.has(o.category) && o.type !== gType.get(o.category));
ok(mismatch.length === 0, `and it is the group's own type, not the wiki's opinion${mismatch.length ? ` — ${mismatch.slice(0, 3).map((o) => `${o.id}: ${o.type} vs ${gType.get(o.category)}`).join(", ")}` : ""}`);
const counts = Object.fromEntries(TYPES.map((t) => [t, objs.filter((o) => o.type === t).length]));
console.log("pieces by type:", JSON.stringify(counts));
ok(Object.values(counts).filter((n) => n > 0).length >= 6, "the types genuinely divide the domain — this is a filter, not a label");
ok(counts.OTHER < objs.length / 3, `and OTHER is not a dumping ground (${counts.OTHER} of ${objs.length})`);

// ------------------------------------------------------------------ the page
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  // An admin reads the REPO, not the image (wiki.js useStagingRoot, 2026-08-14).
  // The sandbox blocks browser egress, so point the staging base at this same
  // server's /assets — the identical code path, resolvable offline.
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

await p.goto(`${W}#/objects`, { waitUntil: "load" });
await p.waitForTimeout(2200);
const bars = await p.evaluate(() => [...document.querySelectorAll(".sortbar")].map((x) => [...x.querySelectorAll("button")].map((y) => y.textContent)));
console.log("type bar:", JSON.stringify(bars[0]));
ok(bars[0][0].startsWith("all "), "the type bar leads with everything");
ok(bars[0].length === Object.values(counts).filter((n) => n > 0).length + 1,
  `one chip per type that HAS pieces, plus all (${bars[0].length})`);
ok(bars[0].every((t) => /\d+$/.test(t)), `every chip carries its count (${bars[0].join(" | ")})`);
ok(!bars[0].some((t) => /_/.test(t)), "and reads as English — MOUNTAIN_WALL is “Mountain wall” here");

// PICKING A TYPE NARROWS THE PAGE.
await p.evaluate(() => [...document.querySelectorAll(".sortbar button")].find((x) => /^Trees/.test(x.textContent)).click());
await p.waitForTimeout(1300);
const picked = await p.evaluate(() => ({
  cards: document.querySelectorAll(".card").length,
  heads: [...document.querySelectorAll("h2")].map((x) => x.getAttribute("title")),
  sel: [...document.querySelectorAll(".sortbar-btn.sel")].map((x) => x.textContent),
}));
console.log("after picking Trees:", JSON.stringify({ cards: picked.cards, heads: picked.heads.slice(0, 5), sel: picked.sel }));
ok(picked.cards === counts.TREE, `only the trees are shown (${picked.cards} of ${objs.length})`);
ok(picked.heads.every((slug) => gType.get(slug) === "TREE"), `and only tree GROUPS have headings (${picked.heads.length})`);
// The review chips must recount inside the chosen type, or the two bars lie.
const reviewChip = picked.sel.find((t) => /^all /.test(t));
ok(reviewChip === `all ${counts.TREE}`, `the review chips recount within the type (“${reviewChip}”)`);

// "IF I FILTER ON TREES AND CLICK ON A TREE — NEXT NEXT NEXT SHOULD ONLY
// DISPLAY TREES." The whole point: the filter survives the click.
await p.evaluate(() => document.querySelector(".card").click());
await p.waitForTimeout(1700);
const walk = [];
for (let i = 0; i < 8; i++) {
  walk.push(await p.evaluate(() => ({
    id: location.hash.split("/").pop(),
    banner: document.querySelector(".queue-note")?.textContent ?? null,
  })));
  await p.evaluate(() => [...document.querySelectorAll("button,a")].find((x) => x.textContent.trim() === "›")?.click());
  await p.waitForTimeout(430);
}
const byId = new Map(objs.map((o) => [o.id, o]));
const walked = walk.map((x) => byId.get(x.id)?.type);
console.log("pager:", JSON.stringify(walk.map((x) => x.id)));
console.log("types:", JSON.stringify(walked));
ok(walked.every((t) => t === "TREE"), `eight presses of › and every one is a tree (${[...new Set(walked)].join(", ")})`);
ok(new Set(walk.map((x) => x.id)).size === walk.length, "each press moves to a different piece — it is walking, not stuck");
ok(/Trees only/.test(walk[0].banner ?? ""), `and the piece says WHY next is limited (“${walk[0].banner}”)`);

// A type with few pieces still pages correctly (wrap-around inside the set).
await p.goto(`${W}#/objects`, { waitUntil: "load" });
await p.waitForTimeout(1500);
await p.evaluate(() => [...document.querySelectorAll(".sortbar button")].find((x) => /^Windows/.test(x.textContent)).click());
await p.waitForTimeout(1200);
const winCards = await p.evaluate(() => document.querySelectorAll(".card").length);
ok(winCards === counts.WINDOW, `Windows narrows to its own ${counts.WINDOW} (${winCards})`);

// STICKY, like the review filter — he reviews across sessions.
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(1800);
const afterReload = await p.evaluate(() => [...document.querySelectorAll(".sortbar-btn.sel")].map((x) => x.textContent)[0]);
ok(/^Windows/.test(afterReload ?? ""), `the choice survives a reload (${afterReload})`);
// And one button gets everything back, whatever combination emptied the page.
await p.evaluate(() => { localStorage.setItem("wiki-obj-filter", "rejected"); location.reload(); });
await p.waitForTimeout(2000);
const empty = await p.evaluate(() => ({
  msg: document.querySelector(".empty-queue p")?.textContent ?? null,
  btn: document.querySelector(".empty-queue button")?.textContent ?? null,
}));
console.log("empty:", JSON.stringify(empty));
ok(!!empty.msg && /Windows/.test(empty.msg), `an empty combination names the type it emptied (“${empty.msg}”)`);
await p.evaluate(() => document.querySelector(".empty-queue button").click());
await p.waitForTimeout(1500);
const restored = await p.evaluate(() => document.querySelectorAll(".card").length);
ok(restored === objs.length, `and one button restores the whole domain — both axes (${restored})`);

// The public gets the finding aid too; it is not a review tool.
const pub = await b.newContext({ viewport: { width: 393, height: 851 } });
const pp = await pub.newPage();
const perrs = []; pp.on("pageerror", (e) => perrs.push(String(e)));
await pp.goto(`${W}#/objects`, { waitUntil: "load" });
await pp.waitForTimeout(2000);
const pubBars = await pp.evaluate(() => [...document.querySelectorAll(".sortbar")].map((x) => [...x.querySelectorAll("button")].map((y) => y.textContent)));
console.log("public bars:", JSON.stringify(pubBars));
ok(pubBars.length === 1, `a visitor sees the type bar and nothing else (${pubBars.length} bars)`);
ok(pubBars[0]?.some((t) => /^Trees/.test(t)), "and it is the type bar");
await pp.evaluate(() => [...document.querySelectorAll(".sortbar button")].find((x) => /^Trees/.test(x.textContent)).click());
await pp.waitForTimeout(1200);
ok(await pp.evaluate(() => document.querySelectorAll(".card").length) === counts.TREE, "which works for them too");
ok(perrs.length === 0, `no public page errors${perrs.length ? ` — ${perrs[0]}` : ""}`);
await pub.close();

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL TYPE-FILTER CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
