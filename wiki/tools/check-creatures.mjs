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
const expectAggro = roster.filter((m) => aggro(m.id)).length;
console.log(`roster: ${roster.length} creatures, ${expectAggro} with an aggro radius above 0`);
ok(expectAggro > 0 && expectAggro < roster.length,
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
ok(v.cards.length === roster.length, `every creature is carded (${v.cards.length}/${roster.length})`);
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
ok(marked === expectAggro, `${expectAggro} marked aggressive, the other ${roster.length - expectAggro} left unmarked (${marked})`);
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
const unplaced = roster.filter((m) => !spawned(m.id)).length;
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

ok(errs.length === 0, `no page errors${errs.length ? `: ${errs[0]}` : ""}`);
await b.close();
console.log(fails.length ? `\nCREATURE CHECKS FAILED (${fails.length})` : "\nALL CREATURE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
