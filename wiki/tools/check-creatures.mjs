// The Creatures overview: sortable, and "will it come for me" at a glance
// (maintainer 2026-08-06 — sort on level and/or aggressive, and replace the
// habitat text with a red "aggressive" / green "calm" pill).
//
// AGGRESSION IS LIVE DATA, not a build-time snapshot: a monster attacks on
// sight only when its aggro radius is above zero, the tuning default is 0, and
// the wiki can edit that radius at runtime. So the pill is derived from the
// same live doc the page reads, and this gate derives its expectation from
// live/tuning/monsters.json rather than from a list someone typed here.
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
  cards: [...document.querySelectorAll(".card")].map((c) => ({
    name: c.querySelector(".card-name")?.textContent,
    level: Number((c.querySelector(".thumb-chip")?.textContent ?? "").replace(/\D+/g, "")),
    pill: c.querySelector(".card-pills .pill")?.textContent,
    cls: c.querySelector(".card-pills .pill")?.className,
    text: c.textContent,
  })),
}));

// ---- the pill ------------------------------------------------------------
let v = await read();
ok(v.cards.length === roster.length, `every creature is carded (${v.cards.length}/${roster.length})`);
const nameToId = new Map(roster.map((m) => [m.name, m.id]));
const bad = v.cards.filter((c) => {
  const id = nameToId.get(c.name); if (!id) return true;
  const want = aggro(id) ? "aggressive" : "calm";
  const wantCls = aggro(id) ? "err" : "ok";
  return c.pill !== want || !c.cls.includes(wantCls);
});
ok(bad.length === 0, `every card's pill matches its live aggro radius${bad.length ? ` — ${bad.slice(0, 4).map((c) => `${c.name}=${c.pill}`).join(", ")}` : ""}`);
ok(v.cards.filter((c) => c.pill === "aggressive").length === expectAggro,
  `${expectAggro} aggressive, the rest calm (${v.cards.filter((c) => c.pill === "calm").length})`);
// RED and GREEN, not just two words — the whole point is seeing it at a glance.
const colours = await p.evaluate(() => {
  const pick = (t) => [...document.querySelectorAll(".card-pills .pill")].find((x) => x.textContent === t);
  const rgb = (el) => el && getComputedStyle(el).color;
  return { aggressive: rgb(pick("aggressive")), calm: rgb(pick("calm")) };
});
const chan = (s) => (s ?? "").match(/\d+/g)?.map(Number) ?? [0, 0, 0];
ok(chan(colours.aggressive)[0] > chan(colours.aggressive)[1], `"aggressive" is red-dominant (${colours.aggressive})`);
ok(chan(colours.calm)[1] > chan(colours.calm)[0], `"calm" is green-dominant (${colours.calm})`);
// The habitat text it replaced must be gone from the card.
ok(!v.cards.some((c) => /habitat|roaming/.test(c.text)),
  "the habitat/roaming line is off the overview card");

// ---- the sorts -----------------------------------------------------------
const names = (x) => x.cards.map((c) => c.name);
ok(v.buttons.find((x) => x.id === "name")?.sel, "default sort is by name");
const asc = names(v);
ok(asc.every((n, i) => i === 0 || asc[i - 1].localeCompare(n) <= 0), `and it really is A–Z (${asc.slice(0, 3).join(", ")}…)`);

await p.evaluate(() => document.querySelector("[data-sort=level]").click());
await p.waitForTimeout(500);
v = await read();
const lv = v.cards.map((c) => c.level);
ok(lv.every((n, i) => i === 0 || lv[i - 1] >= n), `by level is hardest first (${lv.slice(0, 5).join(" ≥ ")}…)`);

await p.evaluate(() => document.querySelector("[data-sort=threat]").click());
await p.waitForTimeout(500);
v = await read();
const flags = v.cards.map((c) => c.pill === "aggressive");
ok(flags.lastIndexOf(true) < flags.indexOf(false) || !flags.includes(false),
  `aggressive first puts all ${expectAggro} before the calm ones`);
const aggLv = v.cards.filter((c) => c.pill === "aggressive").map((c) => c.level);
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
