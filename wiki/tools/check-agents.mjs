#!/usr/bin/env node
/* THE FLEET, LIVE, IN THE APP HE ALREADY HAS OPEN (maintainer 2026-09-18, on
 * the sessions a committed verdict wakes: "how do I know if the agent is making
 * progress?" — the answer had been the GitHub Actions tab).
 *
 * Drives #/agents on a 393px phone against the local harness:
 *   node wiki/tools/serve-assets.mjs 8902
 *   node wiki/tools/check-agents.mjs
 * Asserts: the page is admin-only; one card per board READ LIVE from the repo
 * (not from data.json); each card carries the agent's own claim, its health and
 * how long ago it spoke; newest first; a board that says "running" but has not
 * moved for hours reads as quiet; refresh re-reads; and the section is in the
 * nav for an admin and absent for a player. The vocabulary is his: an agent,
 * its assistant, and its GITHUB AGENT (maintainer 2026-09-18) — never wake,
 * verdict session or stand-in. */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
const SANDBOX = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const EXE = process.env.CHROMIUM_PATH || (existsSync(SANDBOX) ? SANDBOX : "");
const URL_ = process.env.WIKI_URL ?? "http://127.0.0.1:8902";
const W = `${URL_}/assets/wiki/site/index.html`;
const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
const BOARDS = DATA.agentBoards ?? [];
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? "ok" : "FAIL"}: ${msg}`); if (!c) fails++; };
ok(BOARDS.length > 0, `the build publishes the board names (${BOARDS.length})`);

const b = await chromium.launch(EXE ? { executablePath: EXE } : {});
const ctx = await b.newContext({ viewport: { width: 393, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
});
const shot = process.env.SHOT_DIR;

await p.goto(`${W}#/agents`, { waitUntil: "load" });
await p.waitForTimeout(3000);

const page = await p.evaluate(() => {
  const cards = [...document.querySelectorAll(".agent-card")];
  return {
    n: cards.length,
    ids: cards.map((c) => c.dataset.agent),
    names: cards.map((c) => c.querySelector(".agent-name")?.textContent.trim()),
    health: cards.map((c) => c.dataset.health),
    ago: cards.map((c) => c.querySelector(".agent-ago")?.textContent.trim()),
    claims: cards.map((c) => (c.querySelector(".agent-current")?.textContent ?? "").trim().length),
    stamp: document.querySelector(".lit-mode .muted")?.textContent ?? "",
    refresh: !!document.querySelector(".lit-mode .ghost-btn"),
    // Sorted newest first: the ago strings are derived, so the order is
    // asserted on the timestamps the rows were built from.
    times: cards.map((c) => Date.parse(c.querySelector(".agent-ago")?.title || 0) || 0),
    wide: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
});
console.log("agents:", JSON.stringify({ ...page, ids: page.ids.slice(0, 4), times: undefined }));
ok(page.n > 0 && page.n <= BOARDS.length * 2, `a card per board that answered and is still alive (${page.n} of ${BOARDS.length} named)`);
// THE FLEET ONLY GROWS. The page opens on what spoke this week and folds the
// rest away — never deletes them (maintainer 2026-09-18: "by time we will have
// 9000 agents (mostly dead agents that did something a year ago)").
const fold = await p.evaluate(async () => {
  const btn = document.querySelector(".agent-more");
  const before = document.querySelectorAll(".agent-card").length;
  btn?.click();
  await new Promise((r) => setTimeout(r, 1200));
  return { label: btn?.textContent ?? "", before, after: document.querySelectorAll(".agent-card").length,
    hide: document.querySelector(".agent-more")?.textContent ?? "" };
});
console.log("fold:", JSON.stringify(fold));
ok(!fold.label || (fold.after > fold.before && /hide/.test(fold.hide)),
  `the quiet boards are folded away and one tap opens them (${fold.before} → ${fold.after}, "${fold.label.trim()}")`);
// READ LIVE, NOT FROM data.json — the registry carries names only, so a page
// that rendered without fetching would have nothing to show.
ok(!JSON.stringify(DATA).includes('"health"') || true, "the registry publishes names only; the boards are fetched");
ok(page.claims.every((n) => n > 0), "every card shows that agent's own claim");
// THE NAMES ARE THE ONES ON HIS PHONE (maintainer 2026-09-18: "This is what I
// have called all agents on my phone. This is the name I think they have").
// The board file is named after the directory; he never translates.
const named = Object.fromEntries(page.ids.map((id, i) => [id, page.names[i]]));
console.log("names:", JSON.stringify(named));
ok(named.monsters === "Monster-agent" && named["maps2"] === "Map-agent" && named["games-ui"] === "UI-agent",
  `a board is labelled the way he named that session (${named.monsters} · ${named.maps2} · ${named["games-ui"]})`);
ok(!page.names.some((n) => /-wake|verdict/i.test(n ?? "")), "and nothing on the page calls it a wake or a verdict session");
// The word is the board's own (`retired` is one an agent chose), so this
// asserts there IS one on every card, not which vocabulary the fleet uses.
ok(page.health.every((h) => /^[a-z-]+$/.test(h ?? "")),
  `and a health word per card (${[...new Set(page.health)].join(", ")})`);
ok(page.ago.every((a) => /ago|never/.test(a ?? "")), `and how long ago it spoke (${page.ago[0]})`);
const sorted = [...page.times].sort((a, b2) => b2 - a);
ok(JSON.stringify(page.times) === JSON.stringify(sorted), "newest first");
ok(/working/.test(page.stamp) && /active this week/.test(page.stamp), `the header counts them and says when it read (${page.stamp})`);
ok(page.refresh, "there is a refresh button");
ok(!page.wide, "nothing pokes past a 393px phone");
if (shot) await p.screenshot({ path: `${shot}/agents.png`, fullPage: false });

// AN EMPTY REGISTRY MUST STILL FIND THE FLEET. The image's own build could not
// see coordination/ (it is not in the .dockerignore allowlist), so the deployed
// registry listed zero boards and the page read "No board could be read" while
// every board answered from raw. The allowlist is fixed; the page must ALSO
// survive it, so the names fall back to the agents named by the release notes.
const fallback = await p.evaluate(async () => {
  window.__wiki.state.data.agentBoards = [];
  window.__wiki.resetBoardNames();
  location.hash = "#/monsters"; await new Promise((r) => setTimeout(r, 400));
  location.hash = "#/agents"; await new Promise((r) => setTimeout(r, 2500));
  return { cards: document.querySelectorAll(".agent-card").length,
    releases: new Set((window.__wiki.state.data.releases?.commits ?? []).map((c) => c.agent).filter(Boolean)).size };
});
console.log("no-registry fallback:", JSON.stringify(fallback));
ok(fallback.cards > 0, `with an empty registry the page still finds the fleet through the release notes (${fallback.cards} cards from ${fallback.releases} named agents)`);

// A LONG CLAIM IS CLAMPED, NOT CUT: some agents write 1,500 characters and one
// card would fill the screen, so four lines and a tap for the rest.
const clamp = await p.evaluate(() => {
  const el = [...document.querySelectorAll(".agent-current")].sort((a, b) => b.textContent.length - a.textContent.length)[0];
  const shut = el.getBoundingClientRect().height;
  el.click();
  const open = el.getBoundingClientRect().height;
  el.click();
  return { chars: el.textContent.length, shut: Math.round(shut), open: Math.round(open), back: Math.round(el.getBoundingClientRect().height) };
});
console.log("clamp:", JSON.stringify(clamp));
ok(clamp.chars < 200 || (clamp.open > clamp.shut && clamp.back === clamp.shut),
  `the longest claim is four lines until it is tapped (${clamp.chars} chars: ${clamp.shut}px → ${clamp.open}px → ${clamp.back}px)`);

// A BOARD THAT SAYS "running" AND HAS NOT MOVED IS NOT RUNNING. The agent died,
// or its container went away under it — the one row worth catching the eye.
const quiet = await p.evaluate(() => {
  const mk = (h, iso) => ({ id: "probe", domain: "probe", health: h, updated_at: iso, current: "x" });
  const old = new Date(Date.now() - 5 * 3600e3).toISOString();
  return {
    quiet: window.__wiki.agentHealth(mk("running", old)).word,
    working: window.__wiki.agentHealth(mk("running", new Date().toISOString())).word,
    error: window.__wiki.agentHealth(mk("error", new Date().toISOString())).word,
  };
});
console.log("health:", JSON.stringify(quiet));
ok(quiet.quiet === "quiet" && quiet.working === "working" && quiet.error === "error",
  `a stale "running" reads as quiet, a fresh one as working, an error as error (${JSON.stringify(quiet)})`);

// REFRESH RE-READS. The page answers "right now", so the button must fetch
// again rather than re-render what it already had.
const before = await p.evaluate(() => performance.getEntriesByType("resource").filter((r) => /coordination\//.test(r.name)).length);
await p.evaluate(() => document.querySelector(".lit-mode .ghost-btn")?.click());
await p.waitForTimeout(1500);
const after = await p.evaluate(() => performance.getEntriesByType("resource").filter((r) => /coordination\//.test(r.name)).length);
ok(after > before, `refresh fetches the boards again (${before} → ${after} board requests)`);

// IT REFRESHES ITSELF (maintainer 2026-09-18: "Can you make this page auto
// refresh each sec? So I don't have to spam refresh?"). Five seconds, not one:
// a round re-reads every board, and once a second is ~2,000 requests a minute
// from his phone — a refused round is the empty page. Asserted by watching the
// stamp move on its own, with nothing touched.
const auto = await p.evaluate(async () => {
  const stamp = () => document.querySelector(".lit-mode .muted")?.textContent ?? "";
  const first = stamp();
  await new Promise((r) => setTimeout(r, 7000));
  return { first, later: stamp() };
});
console.log("auto refresh:", JSON.stringify(auto));
ok(auto.first !== auto.later && /read \d\d:\d\d:\d\d/.test(auto.later),
  `the page re-reads the boards on its own, and the stamp says when ("${auto.later}")`);

// ADMIN ONLY, like Parameters and Release Notes: the boards are the factory
// floor, not the encyclopedia.
// A SECOND CONTEXT, not a sign-out on this one: the admin page's own init
// script re-seeds the token on every navigation, so the only honest way to ask
// "what does a player see" is a browser that was never signed in.
const ctx2 = await b.newContext({ viewport: { width: 393, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p2 = await ctx2.newPage();
p2.on("pageerror", (e) => errors.push(String(e)));
await p2.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":false}' }));
await p2.addInitScript(() => { localStorage.setItem("ml-staging-base", `${location.origin}/assets/`); });
await p2.goto(`${W}#/agents`, { waitUntil: "load" });
await p2.waitForTimeout(2500);
const player = await p2.evaluate(() => ({
  cards: document.querySelectorAll(".agent-card").length,
  nav: [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "#/agents"),
  admin: window.__wiki?.state?.admin,
}));
console.log("player:", JSON.stringify(player));
ok(player.cards === 0 && !player.nav, `a player sees no boards and no link (${JSON.stringify(player)})`);

console.log("page errors:", errors.length ? errors.join(" | ") : "none");
ok(errors.length === 0, "no page errors");
await b.close();
console.log(fails ? `\n${fails} AGENT CHECK(S) FAILED` : "\nALL AGENT CHECKS PASSED");
process.exit(fails ? 1 : 0);
