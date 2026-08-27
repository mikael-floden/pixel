/* A RUNNING PAGE MUST LEARN ABOUT NEW BUILDS. Twice in one afternoon a fix
 * was LIVE while the maintainer's screen ran the previous build — a
 * single-page app in a phone tab never reloads by itself, so he pressed a
 * button that no longer existed in that form and reported it broken,
 * correctly. The page now polls a version beacon and offers ONE bar naming
 * both builds; it must never reload on its own (unsaved verdicts outrank
 * freshness), and it must not cry wolf when the build matches.
 */
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
const fails = []; const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails.push(m); };
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;

const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext({ viewport: { width: 412, height: 900 } });

// ---- 1. same build: no bar, ever ------------------------------------------
{
  const p = await ctx.newPage();
  await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
  await p.addInitScript(() => { localStorage.setItem("wiki-admin-token", "gate"); });
  await p.goto(W, { waitUntil: "load" });
  await p.waitForTimeout(24_000);      // past the 20s first check
  ok(await p.evaluate(() => !document.querySelector(".update-bar")),
    "with the beacon matching the booted sha, no bar appears — it must not cry wolf");
  await p.close();
}

// ---- 2. newer build: one bar, both shas, reload only on tap ---------------
{
  const p = await ctx.newPage();
  await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
  await p.route("**/version.json*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"git_sha":"fee1dead0","generated_at":"2026-08-27T00:00:00Z"}' }));
  await p.addInitScript(() => { localStorage.setItem("wiki-admin-token", "gate"); });
  await p.goto(W, { waitUntil: "load" });
  await p.waitForTimeout(24_000);
  const bar = await p.evaluate(() => ({
    n: document.querySelectorAll(".update-bar").length,
    text: document.querySelector(".update-bar")?.textContent ?? "",
    mine: window.__wiki?.state?.data?.git_sha ?? null,
    hash: location.hash,
  }));
  ok(bar.n === 1 && /fee1dead0/.test(bar.text) && bar.text.includes(bar.mine),
    `a newer beacon shows ONE bar naming both builds (${bar.text})`);
  ok(await p.evaluate(() => !!document.querySelector("main")?.textContent.length),
    "and the page kept running — it never reloads on its own");
  const nav = p.waitForNavigation({ waitUntil: "load", timeout: 15_000 }).then(() => true).catch(() => false);
  await p.click(".update-bar");
  ok(await nav, "tapping the bar reloads the page");
  await p.close();
}
await b.close();
console.log(fails.length ? `\nFRESHNESS CHECKS FAILED (${fails.length})` : "\nALL FRESHNESS CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
