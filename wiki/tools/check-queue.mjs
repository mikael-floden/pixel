// THE SCENERY REVIEW QUEUE: sort by newest, filter by verdict, and the choice
// HOLDS when you walk into a piece.
//
// Maintainer, 2026-08-13: "As an admin I should be able to sort the Scenery on
// the latest generated content first or/and with a approved/unapproved filter.
// This is to make it easier to review. If I put a filter at the overview that
// filter should hold when clicking on a Scenery and press next next next. It
// must also be visible that the filter is active while inside the scenery
// entity page (so I understand why not all scenery is available when pressing
// next)."
//
// The verdicts are INJECTED here rather than clicked: the live store is the
// maintainer's own review data, a gate must never write to it, and at the time
// this was written every piece was unreviewed anyway (the scenery agent had
// just culled and regenerated the domain, so the standing verdicts pointed at
// paths that no longer existed). Injecting is also the only way to prove the
// filters NARROW rather than merely render.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const D = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const objs = D.domains.objects ?? [];
// Newest first, by the build's own `added` — the order the page must produce.
const byNew = [...objs].sort((a, b) => String(b.added ?? "").localeCompare(String(a.added ?? "")));
ok(objs.every((o) => o.added), `every piece carries an added date (${objs.filter((o) => !o.added).length} without)`);
ok(new Set(objs.map((o) => o.added)).size > 5,
  `and the dates actually differ, or "newest first" is meaningless (${new Set(objs.map((o) => o.added)).size} distinct)`);

// Three approved, four rejected, the rest unreviewed — chosen from across the
// newest order so the filters cannot pass by accident of position.
const APPROVED = [byNew[1], byNew[5], byNew[40]].map((o) => o.path);
const REJECTED = [byNew[0], byNew[6], byNew[41], byNew[80]].map((o) => o.path);
// Each verdict is dated AFTER the art it judges — a verdict older than its
// piece now means "about the art that used to be here", which is a different
// case entirely and is exercised on its own below.
const entries = {};
const after = (path) => new Date(Date.parse(objs.find((o) => o.path === path).added) + 3600e3).toISOString();
for (const p of APPROVED) entries[p] = { status: "approved", updated_at: after(p) };
for (const p of REJECTED) entries[p] = { status: "rejected", updated_at: after(p) };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await (await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
let injected = 0;
await p.route("**/api/live/state", async (route) => {
  const j = JSON.parse(await (await route.fetch()).text());
  const f = j.feedback ?? (j.feedback = {});
  f.objects = { format: "pixel-wiki-feedback@1", domain: "objects", updated_at: "", entries };
  injected++;
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
});
await p.addInitScript(() => localStorage.setItem("wiki-admin-token", "gate"));

// ALWAYS reload. A hash-only goto does not re-navigate, so the live state —
// including the verdicts injected above — is never refetched, and assertions
// about them pass while describing a page that never saw them.
const go = async (hash) => {
  await p.goto(`${W}${hash}`, { waitUntil: "load" });
  await p.reload({ waitUntil: "load" });
  await p.waitForTimeout(1700);
};
const pick = async (v) => { await p.evaluate((s) => document.querySelector(`[data-sort="${s}"]`)?.click(), v); await p.waitForTimeout(800); };
const overview = () => p.evaluate(() => ({
  bars: [...document.querySelectorAll(".sortbar")].map((r) => [...r.querySelectorAll("button")].map((x) => (x.classList.contains("sel") ? "*" : "") + x.textContent).join(" ")),
  heads: document.querySelectorAll("h2").length,
  names: [...document.querySelectorAll(".card-name")].map((x) => x.textContent),
  note: [...document.querySelectorAll("p.muted")].map((x) => x.textContent).find((t) => /of \d+ pieces/.test(t)) ?? "",
}));

await go("#/objects");
ok(injected > 0, `the injected verdicts really were served (${injected}x)`);
const base = await overview();
ok(base.bars.length === 2, `admin gets both a sort row and a filter row (${base.bars.join(" | ")})`);
ok(base.heads > 3, `the default is still the grouped view (${base.heads} group headings)`);
ok(base.names.length === objs.length, `showing everything by default (${base.names.length}/${objs.length})`);

// --- newest first
await pick("newest");
const nw = await overview();
console.log("newest:", JSON.stringify({ heads: nw.heads, first: nw.names.slice(0, 3) }));
ok(nw.heads === 0, "newest-first drops the group headings — the order cuts across groups");
ok(JSON.stringify(nw.names) === JSON.stringify(byNew.map((o) => o.name)),
  `and the grid is in exact added-date order (first: ${nw.names[0]})`);

// --- each verdict filter narrows to exactly its set
for (const [f, want] of [["approved", APPROVED], ["rejected", REJECTED]]) {
  await pick(f);
  const v = await overview();
  const wantNames = byNew.filter((o) => want.includes(o.path)).map((o) => o.name);
  ok(JSON.stringify(v.names) === JSON.stringify(wantNames),
    `"${f}" shows exactly those ${want.length} (${v.names.length} shown)`);
  ok(/of \d+ pieces/.test(v.note), `and says how many of the domain that is — "${v.note.slice(0, 46)}…"`);
}
await pick("unreviewed");
const un = await overview();
ok(un.names.length === objs.length - APPROVED.length - REJECTED.length,
  `"unreviewed" is everything not yet judged (${un.names.length} = ${objs.length} − ${APPROVED.length + REJECTED.length})`);

// --- A VERDICT BELONGS TO THE ART IT WAS GIVEN ON.
// The scenery agent deletes rejected pieces and regenerates them AT THE SAME
// PATH, and the feedback store is keyed by path — so new art inherited the old
// piece's judgement and vanished from the review queue. The maintainer caught
// it as "How can only 3 scenery items be unreviewed when the scenery-agent
// have been working for hours on new content?" — 20 of the 237 were carrying
// his verdict on art he had never seen.
{
  const victim = byNew.find((o) => !APPROVED.includes(o.path) && !REJECTED.includes(o.path) && o.added);
  const before = new Date(Date.parse(victim.added) - 3600e3).toISOString();  // judged an HOUR before this art arrived
  entries[victim.path] = { status: "rejected", updated_at: before };
  await go("#/objects");
  await pick("all");
  const seen = await p.evaluate((id) => {
    const card = [...document.querySelectorAll(".card")].find((c) => c.getAttribute("href") === `#/objects/${id}`);
    return { badges: [...card.querySelectorAll(".card-badges .pill")].map((x) => x.textContent) };
  }, victim.id);
  ok(seen.badges.includes("re-review") && !seen.badges.includes("remove"),
    `a verdict older than the art reads "re-review", never as a live decision (${seen.badges.join(", ") || "none"})`);
  await pick("rejected");
  const rej = await overview();
  ok(!rej.names.includes(victim.name),
    `and it is NOT counted as rejected — that call was about a piece that no longer exists (${rej.names.length} shown)`);
  await pick("unreviewed");
  const un2 = await overview();
  ok(un2.names.includes(victim.name), "it is back in the review queue, which is the whole point");
  ok(un2.names.length === objs.length - APPROVED.length - REJECTED.length,
    `the queue counts it exactly once (${un2.names.length})`);
  await go(`#/objects/${victim.id}`);
  const banner = await p.evaluate(() => document.querySelector(".stale-verdict")?.textContent ?? null);
  console.log("stale banner:", JSON.stringify(banner));
  ok(banner && /re-review/.test(banner) && /regenerated since/.test(banner),
    "and its own page says so above the approve/remove buttons");
  delete entries[victim.path];
  await go("#/objects");                   // back to a page that HAS the sort bar
}

// --- THE FILTER HOLDS INSIDE A PIECE. This is the request's core: ‹ › must
//     walk the filtered set, in the filtered order, and say that it is.
await pick("approved");
await p.evaluate(() => document.querySelector(".card").click());
await p.waitForTimeout(1500);
const walk = [];
for (let i = 0; i < 4; i++) {                        // 4 steps over 3 pieces = wraps
  walk.push(await p.evaluate(() => ({
    name: document.querySelector(".obj-title")?.getAttribute("title"),
    count: document.querySelector(".detail-count")?.textContent?.trim(),
    note: document.querySelector(".queue-note")?.textContent ?? null,
    outside: !!document.querySelector(".queue-note .pill.err"),
  })));
  await p.evaluate(() => [...document.querySelectorAll("a,button")].find((x) => x.textContent.trim() === "›")?.click());
  await p.waitForTimeout(430);
}
console.log("walk:", JSON.stringify(walk.map((w) => `${w.count} ${w.name}`)));
const approvedNames = byNew.filter((o) => APPROVED.includes(o.path)).map((o) => o.name);
ok(walk.every((w) => w.count.endsWith(`/ ${APPROVED.length}`)),
  `the pager counts only the filtered set (${walk.map((w) => w.count).join(", ")})`);
ok(walk.slice(0, 3).every((w, i) => w.name === approvedNames[i]),
  "and steps through them in the filtered order");
ok(walk[3].name === walk[0].name, "wrapping past the end returns to the first of the set, not the domain");
ok(walk.every((w) => w.note && /filtered/.test(w.note) && /approved only/.test(w.note)),
  `every page says WHY next is limited — "${walk[0].note}"`);
ok(walk.every((w) => !w.outside), "and none of them is flagged as outside the filter");

// A piece reached from outside the filter keeps a working pager and says so —
// otherwise Next silently vanishes on any link or search hit.
const stray = byNew.find((o) => REJECTED.includes(o.path));
await go(`#/objects/${stray.id}`);
const s = await p.evaluate(() => ({
  nav: !!document.querySelector(".detail-nav"),
  count: document.querySelector(".detail-count")?.textContent?.trim(),
  outside: !!document.querySelector(".queue-note .pill.err"),
  note: document.querySelector(".queue-note")?.textContent ?? null,
}));
console.log("stray:", JSON.stringify(s));
ok(s.nav && s.count === `1 / ${APPROVED.length + 1}`, `a piece outside the filter keeps its pager (${s.count})`);
ok(s.outside, "and is labelled as outside the current filter");

// --- AN EMPTY FILTER MUST NEVER READ AS MISSING ART.
// The filter is sticky, and it can legitimately empty the page: the maintainer
// judged the whole domain, the scenery agent deleted what he rejected, and
// "needs review" fell to 0 — so the Scenery page he returned to was blank and
// he reported "I can't see more scenery art" (2026-08-13). Every chip now
// carries its count, and an empty result explains itself and offers the way
// out. Simulated by approving EVERYTHING, which is the state he was in.
{
  const saved = { ...entries };
  for (const o of objs) entries[o.path] = { status: "approved", updated_at: after(o.path) };
  await go("#/objects");
  await pick("unreviewed");
  const e = await p.evaluate(() => ({
    cards: document.querySelectorAll(".card").length,
    msg: document.querySelector(".empty-queue p")?.textContent ?? null,
    btn: document.querySelector(".empty-queue button")?.textContent ?? null,
    chips: [...(document.querySelectorAll(".sortbar")[1]?.querySelectorAll("button") ?? [])].map((x) => x.textContent),
  }));
  console.log("empty queue:", JSON.stringify(e));
  ok(e.cards === 0 && !!e.msg, "an empty filter says WHY it is empty instead of showing a blank page");
  ok(/still here/.test(e.msg), `and says the art is not gone — "${e.msg?.slice(0, 60)}…"`);
  ok(e.chips.some((c) => c === `all ${objs.length}`) && e.chips.some((c) => c === "needs review 0"),
    `every chip carries its count, so the pieces are never unaccounted for (${e.chips.join(" | ")})`);
  ok(!!e.btn && new RegExp(`${objs.length}`).test(e.btn), `and one button restores the full domain ("${e.btn}")`);
  await p.evaluate(() => document.querySelector(".empty-queue button").click());
  await p.waitForTimeout(600);
  const back = await p.evaluate(() => ({ cards: document.querySelectorAll(".card").length, sel: [...document.querySelectorAll(".sortbar-btn.sel")].map((x) => x.textContent) }));
  ok(back.cards === objs.length && back.sel.some((s) => s.startsWith("all")),
    `pressing it really does bring everything back (${back.cards} pieces)`);
  // Put back exactly what the next section expects: the real verdicts, the
  // "approved" filter, and a piece page to reload.
  for (const k of Object.keys(entries)) delete entries[k];
  Object.assign(entries, saved);
  await p.evaluate(() => localStorage.setItem("wiki-obj-filter", "approved"));
  await go(`#/objects/${stray.id}`);
}

// --- survives a reload, and the public never sees any of it
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(1500);
ok(!!(await p.evaluate(() => document.querySelector(".queue-note"))), "the filter survives a reload");
const pub = await (await b.newContext({ viewport: { width: 393, height: 851 } })).newPage();
await pub.goto(`${W}#/objects`, { waitUntil: "load" });
await pub.waitForTimeout(1700);
const pv = await pub.evaluate(() => ({ bars: document.querySelectorAll(".sortbar").length, cards: document.querySelectorAll(".card").length, note: !!document.querySelector(".queue-note") }));
console.log("public:", JSON.stringify(pv));
ok(pv.bars === 0 && !pv.note, "no sort or filter controls for the public");
ok(pv.cards === objs.length, `and the public still sees the whole domain (${pv.cards}/${objs.length})`);

console.log("page errors:", errs.length ? errs : "none");
if (errs.length) fails.push("errors");
await b.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL QUEUE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
