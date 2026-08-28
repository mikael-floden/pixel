/* SLOPES: the walkable ramp, reviewed on a fifth ground tab (maintainer
 * 2026-08-28: "makes a 1 level block look like two 0.5 level blocks so the
 * player can run straight up without jumping ... We need the same as usual.
 * A Accept/Reject/Star/Note. Can you build that page so we are fast to get
 * it running once the tiles have been generated?").
 *
 * Built AHEAD of the data, the fades playbook: the index is the tiles
 * agent's to publish (tiles/slopes/index.json, tiles3/slopes@1 — contract on
 * their board); this gate stubs it with real art files, which is exactly how
 * the tab will meet the real thing — read live, no deploy between their push
 * and his review. */
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const ROOT = new URL("../../", import.meta.url).pathname;
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

// THE REAL INDEX (the tiles agent published 2026-08-28, their own shape:
// 90 Wang-on-elevation sets, 16 tiles each, display = dir/post/<hashed>).
// The pre-data stub retires; only the empty states still stub a 404.
import { existsSync } from "node:fs";
const IDX = JSON.parse(readFileSync(ROOT + "tiles/slopes/index.json", "utf8"));
ok(IDX.schema === "tiles3/slopes@1" && Array.isArray(IDX.sets) && IDX.sets.length >= 30,
  `the index speaks the schema, as a list of sets (${IDX.sets.length})`);
const gSets = IDX.sets.filter((x) => x.ground === "grass");
const expTiles = gSets.reduce((n, x) => n + (x.post_files ?? []).filter((pf, i) => pf || x.tiles?.[String(i)]).length, 0);
ok(gSets.length >= 5 && expTiles >= 60, `grass has real slope sets to review (${gSets.length} sets, ${expTiles} tiles)`);
const gone = IDX.sets.flatMap((x) => (x.post_files ?? []).map((pf) => `${x.dir}/post/${pf}`)).filter((f) => !existsSync(ROOT + f));
ok(gone.length === 0, `every published post file exists on disk (${gone.length ? gone[0] : "all"})`);
const foreign = IDX.sets.reduce((n, x) => n + (x.cliff_ground ?? []).filter((c) => c !== x.ground).length, 0);

const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errs = []; const saves = [];
p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.route("**/api/wiki/save", (r) => { saves.push(r.request().postDataJSON()); r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
// no stub — the page reads the REAL index off the serving origin
await p.addInitScript(() => { localStorage.setItem("wiki-admin-token", "gate"); localStorage.setItem("ml-staging-base", "http://127.0.0.1:8903/"); });

// ---- 1. the tab, its count, and the cards ---------------------------------
await p.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p.waitForTimeout(2600);
await p.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Slope/.test(x.textContent))?.click());
await p.waitForTimeout(1800);
const g = await p.evaluate(() => ({
  tab: [...document.querySelectorAll(".groundtab")].map((x) => x.textContent.trim()),
  fit: (() => { const bar = document.querySelector(".groundtabs"); return Math.round(bar.scrollWidth - bar.clientWidth); })(),
  cards: document.querySelectorAll(".slope-card").length,
  stars: document.querySelectorAll(".slope-card .stars").length,
  regen: [...document.querySelectorAll(".slope-card button")].filter((x) => /regenerate/.test(x.textContent)).length,
  notes: document.querySelectorAll(".slope-card textarea, .slope-card input[placeholder*='Note']").length,
  overPill: [...document.querySelectorAll(".slope-card .pill")].map((x) => x.textContent.trim()).find((x) => /^over /.test(x)),
  more: [...document.querySelectorAll("button")].map((x) => x.textContent.trim()).find((x) => /^Show 12 more/.test(x)),
}));
ok(g.tab.some((x) => x.replace(/\s+/g, "") === `Slope${expTiles}`),
  `the Slope tab exists with the REAL inventory count (${g.tab.join(" | ")})`);
ok(g.fit <= 0, `five tabs still fit the strip — it wraps rather than clips (${g.fit}px over)`);
ok(g.cards === 12 && g.more === `Show 12 more (${expTiles - 12} left)`,
  `twelve cards at a time, the rest behind a button (${g.cards}, ${g.more})`);
ok(g.stars === 12 && g.regen === 12 && g.notes === 12,
  `every card carries the usual: stars, approve/regenerate, note (${g.stars}/${g.regen}/${g.notes})`);
ok(foreign > 0, `the index carries FOREIGN-cliff detections to surface (${foreign} tiles fleet-wide)`);

// ---- 2. verdicts ride feedback/tiles on the agent's own key ----------------
await p.evaluate(() => { const c2 = document.querySelector(".slope-card .fb-row"); c2.querySelectorAll(".stars button")[3]?.click(); });
await p.waitForTimeout(400);
await p.evaluate(() => [...document.querySelectorAll(".slope-card button")].find((x) => /approve/.test(x.textContent))?.click());
await p.waitForTimeout(400);
await p.evaluate(() => document.querySelector("#save-btn")?.click());
await p.waitForTimeout(900);
const sv = saves.at(-1);
ok(sv?.file === "feedback/tiles" && Object.keys(sv.set ?? {}).every((k) => /^tiles\/slopes\//.test(k)),
  `a star and an approve commit to feedback/tiles on the slope's own stable key (${Object.keys(sv?.set ?? {})[0]})`);

// ---- 3. before the index exists: the admin sees the promise, a player nothing
const p2 = await ctx.newPage();
await p2.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p2.route("**/tiles/slopes/index.json*", (r) => r.fulfill({ status: 404, body: "" }));
await p2.addInitScript(() => { localStorage.setItem("wiki-admin-token", "gate"); localStorage.setItem("ml-staging-base", "http://127.0.0.1:8903/"); });
await p2.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p2.waitForTimeout(2400);
await p2.evaluate(() => [...document.querySelectorAll(".groundtab")].find((x) => /Slope/.test(x.textContent))?.click());
await p2.waitForTimeout(1200);
ok(await p2.evaluate(() => /tiles agent is generating|reads live/.test(document.body.textContent)),
  "before the index lands, the admin tab says what is coming and how it will arrive");
await p2.close();
const p3 = await ctx.newPage();
await p3.route("**/tiles/slopes/index.json*", (r) => r.fulfill({ status: 404, body: "" }));
await p3.goto(`${W}#/world/grass`, { waitUntil: "load" });
await p3.waitForTimeout(2400);
const pub = await p3.evaluate(() => {
  const t2 = [...document.querySelectorAll(".groundtab")].find((x) => /Slope/.test(x.textContent));
  return { present: !!t2, disabled: t2?.disabled ?? null };
});
ok(pub.present && pub.disabled === true, "a player sees the tab disabled until a slope is approved — the Details rule");
await p3.close();
ok(errs.length === 0, `no page errors (${errs[0] ?? "none"})`);
await b.close();
console.log(fails.length ? `\nSLOPE CHECKS FAILED (${fails.length})` : "\nALL SLOPE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
