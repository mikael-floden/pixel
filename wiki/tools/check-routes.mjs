// DOES THE WIKI STILL RENDER? Walk the main routes in a real browser and fail
// on any page error.
//
// The deploy already refuses a wiki.js that cannot PARSE (check-script.mjs).
// A missing identifier parses perfectly and throws when the route runs, which
// is how the tiles2 retirement (dc23b51893) left every Scenery page dead in
// production on 2026-09-09: it deleted OBJ_TYPES, OBJ_TYPE_KEY, objTypeLabel,
// OBJ_SORT_KEY and OBJ_FILTER_KEY along with the tiles2 code and left their
// uses behind. wiki.js is a 770 KB single-file script that four other agents
// edit in passing, so "it parses" is not the same question as "it runs".
//
// Static analysis was tried and rejected: without a JS parser the scan reports
// 493 candidates on a healthy file (object keys, destructuring, parameters),
// and there is no parser in this repo's dependencies. A browser answers the
// real question in eight seconds.
//
// Needs the asset server: `node wiki/tools/serve-assets.mjs 8902`.
import { createRequire } from "node:module";
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../../games2/package.json", import.meta.url))("playwright-core");
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
/* THE LISTS *AND* A DETAIL PAGE OF EACH. Most of this file's code runs on the
 * page for one thing, not on the index of them: the first cut of this walk
 * missed `stillStates`, orphaned by the same retirement, because it only
 * opened #/objects and the fault was on every piece page under it. The ids
 * come from the registry, so the walk follows the domain rather than a list
 * that rots. */
const DATA = JSON.parse((await import("node:fs")).readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const first = (dom) => (DATA.domains?.[dom] ?? [])[0]?.id ?? null;
const ROUTES = [
  "#/", "#/objects", "#/monsters", "#/items", "#/sounds", "#/music", "#/world",
  "#/characters", "#/lore", "#/tiles", "#/near",
  ...[["objects", "objects"], ["monsters", "monsters"], ["items", "items"], ["characters", "characters"]]
    .map(([dom, path]) => (first(dom) ? `#/${path}/${first(dom)}` : null)).filter(Boolean),
];
const fails = [];
/* THE BROWSER, wherever it is: this sandbox bakes one in at a fixed path, CI
 * installs one where playwright itself can find it. An empty CHROMIUM_PATH is
 * not a path — passing "" as executablePath fails to launch, which is what a
 * `?? ` here would have shipped. */
const { existsSync } = await import("node:fs");
const SANDBOX = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const exe = process.env.CHROMIUM_PATH || (existsSync(SANDBOX) ? SANDBOX : "");
const b = await chromium.launch(exe ? { executablePath: exe } : {});
// BOTH FACES: a player's page and the Game Master's are different code paths,
// and the identifiers that went missing were only reachable from his.
for (const admin of [false, true]) {
  const ctx = await b.newContext({ viewport: { width: 412, height: 900 } });
  const p = await ctx.newPage();
  const errs = new Map();
  p.on("pageerror", (e) => {
    const line = String(e).split("\n")[0].slice(0, 160);
    errs.set(line, (errs.get(line) ?? 0) + 1);
  });
  await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ admin }) }));
  if (admin) await p.addInitScript(() => localStorage.setItem("wiki-admin-token", "gate"));
  await p.addInitScript(() => localStorage.setItem("ml-staging-base", `${location.origin}/assets/`));
  for (const r of ROUTES) {
    await p.goto(W + r, { waitUntil: "load" });
    await p.waitForTimeout(2200);
  }
  const rendered = await p.evaluate(() => (document.body.innerText || "").length);
  console.log(`  ${admin ? "Game Master" : "player     "}: ${ROUTES.length} routes, ${errs.size} distinct errors, ${rendered} chars rendered`);
  for (const [e, n] of errs) console.log(`      ${n}x ${e}`);
  if (errs.size) fails.push(`${admin ? "admin" : "player"}: ${[...errs.keys()][0]}`);
  if (rendered < 200) fails.push(`${admin ? "admin" : "player"}: the last route rendered almost nothing (${rendered} chars)`);
  await ctx.close();
}
await b.close();
console.log(fails.length ? `\nROUTE CHECKS FAILED (${fails.length})\n  ${fails.join("\n  ")}` : "\nALL ROUTE CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
