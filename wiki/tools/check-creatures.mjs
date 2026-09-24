// The Creatures overview: sortable, and "will it come for me" at a glance
// (maintainer 2026-08-06 — sort on level and/or aggressive, and replace the
// habitat text with a red "aggressive" pill).
//
// AGGRESSION IS LIVE DATA, not a build-time snapshot: a monster attacks on
// sight only when its aggro radius is above zero, the tuning default is 0, and
// the wiki can edit that radius at runtime. So the pill is derived from the
// same live doc the page reads, and this gate derives its expectation from
// live/tuning/monsters.json rather than from a list someone typed here.
//
// THE SHOWCASE REDESIGN (2026-08-18) MOVED BOTH THINGS THIS GATE READS, and a
// stale selector is how a gate goes quiet without going red: `.thumb-chip` had
// stopped existing, so every card's level read 0 and "by level is hardest
// first" was comparing 0 ≥ 0 fifty-seven times. Level now rides the art as
// `.showcase-level` and the marks stack in `.showcase-marks`. Both reads below
// assert they found something before they judge it.
//
// AND ONLY THE AGGRESSIVE ONES ARE MARKED NOW: a green "calm" on 48 of 57
// cards answered the question by shouting at everybody, so absence is the calm
// and the WORD moved to the creature's own page — which this gate follows it
// to, or the green half of "red and green at a glance" would go unchecked.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const ROOT = new URL("../../", import.meta.url).pathname;
const D = JSON.parse(readFileSync(join(ROOT, "wiki/site/data.json"), "utf8"));
const T = JSON.parse(readFileSync(join(ROOT, "live/tuning/monsters.json"), "utf8"));
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };

const statOf = (id) => ({ ...(T.defaults ?? {}), ...(T.monsters?.[id] ?? {}) });
const aggro = (id) => Number(statOf(id).aggro_radius_wu ?? 0) > 0;
const lvl = (id) => Number(statOf(id).level ?? 0);
const roster = D.domains.monsters;
/* A PLAYER IS NOT SHOWN STAGING ART. `creatures()` hides every `pending`
 * design from anyone who is not the Game Master, so the roster this first,
 * logged-out pass may assert against is the SHELF — the finished creatures —
 * not the whole library. (The gate read `roster` and went red at 86/147 the
 * day "in the making" grew past a handful; an expectation that counts art the
 * page is right not to draw is a false alarm, and a gate nobody believes is
 * worse than no gate.) */
const shelf = roster.filter((m) => !m.pending);
const expectAggro = shelf.filter((m) => aggro(m.id)).length;
console.log(`roster: ${roster.length} creatures, ${expectAggro} with an aggro radius above 0`);
ok(expectAggro > 0 && expectAggro < shelf.length,
  "the roster has both kinds, so the two pills are actually distinguishable");

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await (await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
await p.goto(`${W}#/monsters`, { waitUntil: "load" });
await p.waitForTimeout(2400);

const read = () => p.evaluate(() => ({
  buttons: [...document.querySelectorAll(".sortbar-btn")].map((x) => ({ id: x.dataset.sort, sel: x.classList.contains("sel") })),
  cards: [...document.querySelectorAll(".card")].map((c) => {
    const lvl = c.querySelector(".showcase-level");
    const marks = [...c.querySelectorAll(".showcase-marks .pill")];
    const agg = marks.find((x) => x.textContent === "aggressive");
    return {
      name: c.querySelector(".card-name")?.textContent,
      // null, NOT 0, when the chip is missing — a missing level must fail the
      // sort check rather than sort perfectly among other missing levels.
      level: lvl ? Number((lvl.textContent ?? "").replace(/\D+/g, "")) : null,
      marks: marks.map((x) => x.textContent),
      aggressive: !!agg,
      aggCls: agg?.className ?? null,
      text: c.textContent,
    };
  }),
}));

// ---- the mark ------------------------------------------------------------
let v = await read();
ok(v.cards.length === shelf.length, `every finished creature is carded (${v.cards.length}/${shelf.length}, ${roster.length - shelf.length} still in the making)`);
const nameToId = new Map(roster.map((m) => [m.name, m.id]));
// BOTH DIRECTIONS. A card must carry the mark when its live radius is above
// zero and must NOT carry it otherwise — "absence is the calm" is only true if
// the absence is checked as hard as the presence.
const bad = v.cards.filter((c) => {
  const id = nameToId.get(c.name); if (!id) return true;
  if (c.aggressive !== aggro(id)) return true;
  return c.aggressive && !(c.aggCls ?? "").includes("err");
});
ok(bad.length === 0, `every card's mark matches its live aggro radius${bad.length ? ` — ${bad.slice(0, 4).map((c) => `${c.name}=${c.aggressive ? "aggressive" : "unmarked"}`).join(", ")}` : ""}`);
const marked = v.cards.filter((c) => c.aggressive).length;
ok(marked === expectAggro, `${expectAggro} marked aggressive, the other ${shelf.length - expectAggro} left unmarked (${marked})`);
ok(!v.cards.some((c) => c.marks.includes("calm")),
  "and nothing on the overview says \"calm\" — the quiet ones are quiet");
// The one mark that survived beside it: a creature in no world at all is a
// different fact from a calm one, and it is derived from the SAME place the
// page reads it (data.json's world roll-up), both directions again.
const spawned = (id) => !!D.world?.monsters?.[id];
const wrongSpawn = v.cards.filter((c) => {
  const id = nameToId.get(c.name); if (!id) return true;
  return c.marks.includes("not spawned") === spawned(id);
});
const unplaced = shelf.filter((m) => !spawned(m.id)).length;
ok(wrongSpawn.length === 0,
  `"not spawned" marks exactly the ${unplaced} creatures no world places${wrongSpawn.length ? ` — off on ${wrongSpawn.slice(0, 3).map((c) => c.name).join(", ")}` : ""}`);
// RED — and GREEN where the word went, or half the claim would go unchecked.
const aggColour = await p.evaluate(() => {
  const el = [...document.querySelectorAll(".showcase-marks .pill")].find((x) => x.textContent === "aggressive");
  return el && getComputedStyle(el).color;
});
const chan = (s) => (s ?? "").match(/\d+/g)?.map(Number) ?? [0, 0, 0];
ok(chan(aggColour)[0] > chan(aggColour)[1], `"aggressive" is red-dominant (${aggColour})`);
// The habitat text it replaced must be gone from the card.
ok(!v.cards.some((c) => /habitat|roaming/.test(c.text)),
  "the habitat/roaming line is off the overview card");

// ---- and "calm" is spelled out on the creature's own page -----------------
const calmId = roster.map((m) => m.id).find((id) => !aggro(id));
await p.goto(`${W}#/monsters/${calmId}`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const calm = await p.evaluate(() => {
  const el = [...document.querySelectorAll(".spawn-line .pill")].find((x) => x.textContent === "calm");
  return el ? { found: true, colour: getComputedStyle(el).color, title: el.title } : { found: false };
});
ok(calm.found, `a calm creature says so in words on its own page (${calmId})`);
ok(chan(calm.colour)[1] > chan(calm.colour)[0], `and "calm" is green-dominant there (${calm.colour})`);
ok(/fights back/.test(calm.title ?? ""), "with the rule in its tooltip, not just a colour");
const aggId = roster.map((m) => m.id).find((id) => aggro(id));
await p.goto(`${W}#/monsters/${aggId}`, { waitUntil: "load" });
await p.waitForTimeout(1800);
const hunts = await p.evaluate(() =>
  [...document.querySelectorAll(".spawn-line .pill")].some((x) => x.textContent === "aggressive"));
ok(hunts, `and an aggressive one says so on its page too (${aggId})`);
await p.goto(`${W}#/monsters`, { waitUntil: "load" });
await p.waitForTimeout(2000);
v = await read();

// ---- the sorts -----------------------------------------------------------
const names = (x) => x.cards.map((c) => c.name);
ok(v.buttons.find((x) => x.id === "name")?.sel, "default sort is by name");
const asc = names(v);
ok(asc.every((n, i) => i === 0 || asc[i - 1].localeCompare(n) <= 0), `and it really is A–Z (${asc.slice(0, 3).join(", ")}…)`);

await p.evaluate(() => document.querySelector("[data-sort=level]").click());
await p.waitForTimeout(500);
v = await read();
const lv = v.cards.map((c) => c.level);
// READ THE LEVEL BEFORE TRUSTING THE ORDER. This is the check that went
// vacuous: every card reported 0 through a dead selector, and 0 ≥ 0 holds
// however badly the page is sorted.
ok(lv.every((n) => Number.isFinite(n)) && new Set(lv).size > 1,
  `the level really is on the card (${new Set(lv).size} distinct levels, e.g. ${lv.slice(0, 5).join(", ")})`);
ok(lv.every((n, i) => i === 0 || lv[i - 1] >= n), `by level is hardest first (${lv.slice(0, 5).join(" ≥ ")}…)`);
// …and it is the LIVE level, not a build-time copy.
const wrongLv = v.cards.filter((c) => nameToId.get(c.name) && c.level !== lvl(nameToId.get(c.name)));
ok(wrongLv.length === 0, `and each level is the tuned one${wrongLv.length ? ` — ${wrongLv.slice(0, 3).map((c) => `${c.name}=${c.level}`).join(", ")}` : ""}`);

await p.evaluate(() => document.querySelector("[data-sort=threat]").click());
await p.waitForTimeout(500);
v = await read();
const flags = v.cards.map((c) => c.aggressive);
ok(flags.lastIndexOf(true) < flags.indexOf(false) || !flags.includes(false),
  `aggressive first puts all ${expectAggro} before the calm ones`);
const aggLv = v.cards.filter((c) => c.aggressive).map((c) => c.level);
ok(aggLv.every((n, i) => i === 0 || aggLv[i - 1] >= n), `and orders them hardest first (${aggLv.join(" ≥ ")})`);

// ---- the choice sticks ---------------------------------------------------
await p.reload({ waitUntil: "load" });
await p.waitForTimeout(2200);
v = await read();
ok(v.buttons.find((x) => x.id === "threat")?.sel, "the chosen sort survives a reload");

// ---- THE SHADOW QUEUE (maintainer 2026-08-22: "If I login with admin the
// monster page should make it possible to filter by 'no shadow set'. This is
// to be able to know what I have already fixed.")
//
// ITS OWN ADMIN CONTEXT. Everything above this line runs as a PLAYER — that is
// what makes those checks meaningful — and the shadow filter is admin-only, so
// borrowing that page would only ever prove the bar is absent.
//
// The expectation is DERIVED from live/tuning/monsters.json, not typed here: a
// shadow is set when the monster carries its own rx/ry, so the counts move on
// their own as he works and this gate never needs editing.
const setIds = (D.domains.monsters ?? []).filter((m) => {
  const sh = T.monsters?.[m.id]?.shadow;
  return sh && sh.rx > 0 && sh.ry > 0;
}).map((m) => m.id);
const total = (D.domains.monsters ?? []).length;
const expNone = total - setIds.length;
ok(setIds.length > 0 && expNone > 0,
  `the roster has both kinds, so the filter is actually distinguishable (${setIds.length} tuned, ${expNone} not)`);
const actx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
const pa = await actx.newPage();
const aerrs = []; pa.on("pageerror", (e) => aerrs.push(String(e)));
await pa.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await pa.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  localStorage.removeItem("wiki-monster-shadow");
});
await pa.goto(`${W}#/monsters`, { waitUntil: "load" });
await pa.waitForSelector('[data-bar="wiki-monster-shadow"] button', { timeout: 15000 }).catch(() => {});
await pa.waitForTimeout(1200);
const shadowBar = () => pa.evaluate(() => {
  const btns = [...document.querySelectorAll('[data-bar="wiki-monster-shadow"] button')];
  return {
    chips: btns.map((x) => x.textContent.trim()),
    sel: btns.find((x) => x.classList.contains("sel"))?.textContent.trim() ?? "",
    cards: document.querySelectorAll(".showcase-card").length,
  };
});
let sv = await shadowBar();
/* CHIPS ARE FOUND BY LABEL, NEVER BY INDEX. This row grows — "in the making"
 * and "complete" joined it on 2026-09-18 — and a positional read turns every
 * addition into a red gate about something that is working. What must hold is
 * that the queue chips are PRESENT and carry the LIVE counts. */
const chipFor = (label) => sv.chips.find((c) => c.startsWith(`${label} `)) ?? "";
ok(["all", "no shadow", "shadow set"].every((l) => chipFor(l)),
  `the admin gets a shadow filter — all / no shadow / shadow set (${sv.chips.join(" | ") || "no bar"})`);
ok(chipFor("no shadow") === `no shadow ${expNone}` && chipFor("shadow set") === `shadow set ${setIds.length}`,
  `and the counts come from the LIVE tuning doc, not a snapshot (${expNone} unset, ${setIds.length} set)`);
ok(sv.sel.startsWith("all") && sv.cards === total, `it opens unfiltered (${sv.cards} of ${total}, on "${sv.sel}")`);

/* ---- "REVIEW NEEDED" (maintainer 2026-09-24: "the monster-agent usually
 * start with 10 monsters at a time and it's hard for me to find them", then on
 * the first cut, a sort composed with "in the making": "doesn't seem to work
 * and changes depending on how I click. Feels buggy").
 *
 * A FILTER chip with a GLOBAL count, always present for the Game Master, and
 * the order inside it is NEWEST ART FIRST — the facing's own generated_at —
 * so the batch the agent just finished is the top and the unstamped backlog
 * the bottom. The expectation is derived from the SAME two files the page
 * reads, never a number typed here. Then ‹ › walks the batch and only the
 * batch, the count reads "n / owed", and a verdict entered mid-walk does not
 * reorder it under him. */
const FB = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, "live/feedback/monsters.json"), "utf8")).entries ?? {}; }
  catch { return {}; }
})();
const facetStale = (m, st, dir, e) => {
  const hh = m?.animations?.[st]?.dirs?.[dir]?.h;
  return !(!e.art || !hh) && e.art !== hh && e.art !== m.artHash;
};
const owedOf = (m) => {
  let n = 0, at = "";
  for (const [st, a] of Object.entries(m.animations ?? {})) {
    if (a?.still) continue;                       // the base is looked at, not judged
    for (const [dir, clip] of Object.entries(a?.dirs ?? {})) {
      const e = FB[`${m.path}#${st}#${dir}`] ?? {};
      const judged = !!(e.status || e.rating), stale = judged && facetStale(m, st, dir, e);
      if (judged && !stale) continue;
      // Same three-way key as the page: the stamp, else the verdict a
      // regeneration outdated, else nothing (the backlog).
      const key = clip?.at ?? (stale ? e.updated_at ?? "" : "");
      n++; if (key > at) at = key;
    }
  }
  return { n, at };
};
const expOwed = roster.filter((m) => owedOf(m).n > 0);
const owedIds = new Set(expOwed.map((m) => m.id));
ok(expOwed.length > 0 && expOwed.length < roster.length,
  `the roster has both kinds, so the queue is actually distinguishable (${expOwed.length} owe a verdict, ${roster.length - expOwed.length} settled)`);
sv = await shadowBar();
ok(sv.chips.includes(`review needed ${expOwed.length}`),
  `"review needed" is a FILTER chip carrying the global count (${sv.chips.join(" | ")})`);
ok(!(await pa.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-monster-sort"] button')].some((x) => /review/.test(x.textContent)))),
  "and not a sort — a sort composed with \"in the making\" read 0 on the batch that had just graduated out of it");
await pa.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-monster-shadow"] button')].find((x) => /^review needed/.test(x.textContent))?.click());
await pa.waitForTimeout(1600);
sv = await shadowBar();
const qIds = await pa.evaluate(() => [...document.querySelectorAll(".showcase-card")].map((a) => a.getAttribute("href").split("/").pop()));
ok(sv.cards === expOwed.length && qIds.every((id) => owedIds.has(id)),
  `choosing it keeps exactly the ones waiting on him (${sv.cards} of ${total})`);
const ats = qIds.map((id) => owedOf(roster.find((m) => m.id === id) ?? {}).at);
const keyed = ats.filter(Boolean).length;
ok(ats.every((a, i) => i === 0 || ats[i - 1] >= a),
  `and orders them NEWEST ART FIRST (${ats.slice(0, 3).map((a) => a || "—").join(" ≥ ")} … ${ats.slice(-1).map((a) => a || "—")})`);
// NOT VACUOUS: the recent ones must exist and must all sit above the backlog.
// With a live feedback file this holds through the stale case alone (a redo
// that landed on a shipped creature), so the claim is checked, not assumed.
ok(keyed > 0 && keyed < ats.length && ats.slice(0, keyed).every(Boolean) && ats.slice(keyed).every((a) => !a),
  `and every creature with recent art sits above the never-opened backlog (${keyed} recent, ${ats.length - keyed} backlog)`);
const lineTxt = await pa.evaluate(() => [...document.querySelectorAll("p.muted")].map((e) => e.textContent).find((t) => /owe/.test(t)) ?? "");
ok(/newest art first/.test(lineTxt) && /‹ › walks only these/.test(lineTxt), `and the page says so (${lineTxt.slice(0, 70)}…)`);
/* AND ‹ › WALKS THE BATCH, NOT THE PAGE. */
await pa.click(".showcase-card");
await pa.waitForTimeout(2400);
const step = () => pa.evaluate(() => ({
  id: location.hash.split("/").pop(),
  count: document.querySelector(".detail-count")?.textContent ?? "",
}));
const walk = [await step()];
for (let i = 0; i < Math.min(expOwed.length, 6); i++) {
  await pa.click('.detail-nav a[title^="Next"]');
  await pa.waitForTimeout(1400);
  walk.push(await step());
}
ok(walk.every((w) => w.count.endsWith(`/ ${expOwed.length}`)),
  `‹ › counts the batch (${walk.map((w) => w.count).join(", ")})`);
ok(walk.every((w) => owedIds.has(w.id)),
  `and never leaves it, even wrapping past the end (${walk.map((w) => w.id).join(" → ")})`);
ok(walk[1].id === qIds[1], `and walks it in the page's order (${walk[0].id} → ${walk[1].id})`);
// The wrap is only observable when the whole batch fits in the steps taken —
// this arms itself on the day he has worked the queue down.
const wrapped = walk.length > expOwed.length;
ok(!wrapped || walk[expOwed.length].id === walk[0].id,
  wrapped ? `and past the last one it wraps to the first (${walk[0].id})`
          : `(batch of ${expOwed.length} is longer than the ${walk.length - 1} steps walked — wrap unobservable)`);
// A verdict entered mid-walk changes what this creature owes. The queue was
// planned on the overview and must not re-plan under his thumb.
const before = await step();
await pa.evaluate(() => [...document.querySelectorAll("button")].find((x) => /^✓\s*approve$/i.test(x.textContent.trim()))?.click());
await pa.waitForTimeout(900);
await pa.click('.detail-nav a[title^="Next"]');
await pa.waitForTimeout(1400);
const after = await step();
ok(after.count.endsWith(`/ ${expOwed.length}`) && owedIds.has(after.id),
  `and a verdict entered mid-walk does not move the queue (${before.count} → ${after.count})`);
await pa.goto(`${W}#/monsters`, { waitUntil: "load" });
await pa.waitForTimeout(1600);
await pa.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-monster-shadow"] button')].find((x) => /^all /.test(x.textContent))?.click());
await pa.waitForTimeout(1200);
await pa.evaluate(() => [...document.querySelectorAll('[data-bar="wiki-monster-shadow"] button')].find((x) => /no shadow/.test(x.textContent))?.click());
await pa.waitForTimeout(1600);
sv = await shadowBar();
ok(sv.cards === expNone, `"no shadow" keeps exactly the ones still on the default (${sv.cards} of ${total})`);
const shownIds = await pa.evaluate(() => [...document.querySelectorAll(".showcase-card")].map((a) => a.getAttribute("href").split("/").pop()));
ok(shownIds.length > 0 && !shownIds.some((id) => setIds.includes(id)),
  `and no creature he has already tuned is among them (${shownIds.filter((id) => setIds.includes(id)).join(", ") || "none"})`);
// THE FILTER HAS TO SURVIVE THE CLICK-THROUGH, or it is the dead end he hit on
// tiles: "I use your code to filter on NOT reviewed. I then click on that tile
// set, but can't navigate further to find the review."
await pa.goto(`${W}#/monsters/${shownIds[0]}`, { waitUntil: "load" });
await pa.waitForTimeout(2200);
const pager = await pa.evaluate(() => document.querySelector(".detail-count")?.textContent ?? "");
ok(pager.endsWith(`/ ${expNone}`), `and ‹ › on a creature page walks only the queue (${pager})`);
/* ---- A FACING THAT DOES NOT EXIST IS STILL A SLOT (maintainer 2026-09-24:
 * "The problem with N being missing is that I can't click on N and place a
 * review to redo N … All monster animation need all 8 directions"). A
 * creature's pad shows all eight, the absent ones dashed; selecting one gives
 * an empty stage, the line saying why, and a live feedback row whose redo
 * colours the chip AND the state. The creature is found from the data, not
 * named here — the day every creature has all eight this block goes quiet. */
const gap = roster.flatMap((m) => Object.entries(m.animations ?? {})
  .filter(([, a]) => !a.still && Object.keys(a.dirs ?? {}).length > 0 && Object.keys(a.dirs ?? {}).length < 8)
  .map(([st, a]) => ({ m, st, missing: D.directions.filter((d) => !a.dirs[d]) })))[0];
if (!gap) console.log("  (every creature has all eight facings in every state — nothing to check)");
else {
  const { m: gm, st: gst, missing: gmiss } = gap;
  await pa.goto(`${W}#/monsters/${gm.id}`, { waitUntil: "load" });
  await pa.waitForTimeout(2200);
  await pa.evaluate((label) => [...document.querySelectorAll(".seg-states button")].find((x) => x.textContent.trim().toLowerCase().startsWith(label))?.click(), gst.toLowerCase());
  await pa.waitForTimeout(700);
  const padOf = () => pa.evaluate(() => [...document.querySelectorAll(".dirpad button")].map((x) => ({ t: x.textContent.trim(), cls: x.className })));
  let pd = await padOf();
  const LBL = { south: "S", "south-east": "SE", east: "E", "north-east": "NE", north: "N", "north-west": "NW", west: "W", "south-west": "SW" };
  const dashed = pd.filter((x) => /\bmissing\b/.test(x.cls)).map((x) => x.t);
  ok(pd.length === 8, `a creature's pad shows all eight facings even when ${gm.id}'s ${gst} ships ${8 - gmiss.length} (${pd.length} chips)`);
  ok(dashed.length === gmiss.length && gmiss.every((d) => dashed.includes(LBL[d])),
    `and exactly the absent ones are dashed (${dashed.join(", ") || "none"} — expected ${gmiss.map((d) => LBL[d]).join(", ")})`);
  const errsBefore = aerrs.length;
  await pa.evaluate((t) => [...document.querySelectorAll(".dirpad button")].find((x) => x.textContent.trim() === t)?.click(), LBL[gmiss[0]]);
  await pa.waitForTimeout(700);
  const absentLine = await pa.evaluate(() => document.querySelector(".facet-absent")?.textContent.trim() ?? "");
  ok(/owes all eight/.test(absentLine) && aerrs.length === errsBefore,
    `selecting it gives an empty stage that says why, without a page error ("${absentLine.slice(0, 48)}…")`);
  await pa.evaluate(() => [...document.querySelectorAll("button")].find((x) => /^↻\s*redo$/.test(x.textContent.trim()))?.click());
  await pa.waitForTimeout(700);
  pd = await padOf();
  const chip = pd.find((x) => x.t === LBL[gmiss[0]]);
  const stateCls = await pa.evaluate(() => document.querySelector(".seg-states button.on")?.className ?? "");
  ok(/judged-redo/.test(chip?.cls ?? "") && /judged-redo/.test(stateCls),
    `and a redo there lands on the facing and colours its state (${LBL[gmiss[0]]}: "${chip?.cls}", state: "${stateCls}")`);
}
ok(aerrs.length === 0, `no page errors in the admin pass${aerrs.length ? `: ${aerrs[0]}` : ""}`);
await actx.close();
// A PLAYER IS NEVER FILTERED BY A CONTROL THEY CANNOT SEE — including one left
// behind in their storage by an admin session in the same browser.
const ctx2 = await b.newContext({ viewport: { width: 393, height: 851 } });
const p2 = await ctx2.newPage();
await p2.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":false}' }));
await p2.addInitScript(() => {
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  localStorage.setItem("wiki-monster-shadow", "set");
  localStorage.setItem("wiki-monster-sort", "review");
});
await p2.goto(`${W}#/monsters`, { waitUntil: "load" });
await p2.waitForTimeout(2400);
const pv = await p2.evaluate(() => ({
  bar: document.querySelectorAll('[data-bar="wiki-monster-shadow"]').length,
  cards: document.querySelectorAll(".showcase-card").length,
  sorts: [...document.querySelectorAll('[data-bar="wiki-monster-sort"] button')].map((x) => x.textContent.trim()),
  sel: [...document.querySelectorAll('[data-bar="wiki-monster-sort"] button.sel')].map((x) => x.textContent.trim()),
}));
ok(!pv.sorts.some((c) => /review needed/.test(c)) && pv.sel.join() === "by name",
  `and no "review needed" sort, which reads verdicts they cannot see — it falls back to by name (${pv.sorts.join(" | ")}, on "${pv.sel.join()}")`);
ok(pv.bar === 0 && pv.cards === shelf.length,
  `a player gets no filter and every finished creature, even with a stale admin preference stored (${pv.cards} of ${shelf.length}, ${pv.bar} bars)`);
await ctx2.close();

ok(errs.length === 0, `no page errors${errs.length ? `: ${errs[0]}` : ""}`);
await b.close();
console.log(fails.length ? `\nCREATURE CHECKS FAILED (${fails.length})` : "\nALL CREATURE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
