// verify-bootfail — THE GAME MUST ALWAYS START, even when a dependency hangs.
//
// Maintainer 2026-08-15, with a screenshot of a black page carrying nothing but
// the version badge: "when I start the game it's sometimes stuck on a black
// screen". Reproduced here exactly — see the baseline note below.
//
// THE FAILURE THIS GUARDS is a HANG, not an error, which is why every existing
// gate was blind to it and why try/catch did not help. An ADMIN's boot awaits
// loadWorldsList -> isAdmin -> stagingWorlds -> resolveStagingBase, which
// fetches api.github.com (rate-limited to 60/hour per IP, unauthenticated) and
// then cdn.jsdelivr.net. Those were wrapped in try/catch, so a FAILING request
// degraded fine; a request that never settles simply never returns, boot never
// reaches the select screen, and showVersion() — which runs before the first
// await — is the only thing on the page.
//
// TWO HARNESS DETAILS THAT COST AN HOUR EACH, both worth keeping:
//  * PROD BUILD ONLY. loadWorldsList returns early on import.meta.env.DEV, so
//    the dev stack never enters the staging path at all and this gate is
//    vacuous against it. Needs `npm run build:client` + a SERVE_CLIENT=1 server.
//  * serviceWorkers: "block". The app registers /sw.js, and a page-level
//    page.route() does NOT intercept requests a service worker makes — the
//    first run of this gate showed admin:false and zero GitHub requests
//    because the real server answered /api/wiki/me behind the worker.
//
// NON-VACUITY, verified 2026-08-15: with the timeout removed from
// resolveStagingBase the hang case reports selectScreen=NO after 20s with
// body text "dev" — the version badge alone, i.e. the maintainer's screenshot.
// With it, the select screen arrives in ~3.2s.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ORIGIN = "http://localhost:2599";

async function run(label, { hangGithub }) {
  const b = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
  const page = await (await b.newContext({ viewport: { width: 393, height: 851 }, serviceWorkers: "block" })).newPage();

  // Be an admin: the server has no real token, so answer /api/wiki/me ourselves.
  await page.route("**/api/wiki/me", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ admin: true }) }),
  );
  // THE FAILURE: a request that never settles. Not an error — a hang, which is
  // precisely what try/catch cannot save you from.
  let githubHits = 0;
  let meHits = 0;
  page.on("request", (r) => { if (r.url().includes("/api/wiki/me")) meHits++; });
  page.on("console", (m) => { const t = m.text(); if (/staging|admin|worlds/i.test(t)) console.log("   [console]", t.slice(0,120)); });
  await page.route("https://api.github.com/**", (r) => {
    githubHits++;
    if (hangGithub) return; // never fulfil, never abort
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sha: "deadbeef" }) });
  });
  await page.route("https://cdn.jsdelivr.net/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devWorlds: [] }) }),
  );

  await page.evaluateOnNewDocument?.(() => {}).catch(() => {});
  await page.addInitScript(() => localStorage.setItem("wiki-admin-token", "probe-token"));

  const t0 = Date.now();
  await page.goto(ORIGIN + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  // The select screen is the proof of a completed boot.
  const ok = await page
    .waitForSelector("#ml-select, .ml-select, button", { timeout: 20000, state: "attached" })
    .then(() => true)
    .catch(() => false);
  const ms = Date.now() - t0;
  const failCard = await page.$("#ml-bootfail");
  const bodyText = (await page.evaluate(() => document.body.innerText.trim().slice(0, 80))) || "(empty)";
  await b.close();
  console.log(
    `${label.padEnd(26)} selectScreen=${ok ? "YES" : "NO "} in ${String(ms).padStart(5)}ms  ` +
      `meReqs=${meHits} githubReqs=${githubHits} bootFailCard=${failCard ? "shown" : "no"}  body="${bodyText.replace(/\n/g, " / ")}"`,
  );
  return ok;
}

const a = await run("github HANGS (the bug)", { hangGithub: true });
const b2 = await run("github responds (control)", { hangGithub: false });
if (!(a && b2)) {
  console.error("verify-bootfail: FAIL — the select screen never appeared; boot dead-ends on black");
  process.exit(1);
}
console.log("verify-bootfail: OK — boot reaches the select screen with api.github.com hanging");
