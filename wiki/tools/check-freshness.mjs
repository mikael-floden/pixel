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

/* ---- 1. THE ADMIN CASE THAT BROKE IT. His page re-stamps git_sha with the
 * REPO HEAD it pinned its staging fetch to, while the beacon names the
 * DEPLOYED build — different quantities. Every Commit to live/ moves main
 * without deploying, so comparing the two fired the bar on every tab switch,
 * pointing at an older build than his header showed. Simulated exactly: a
 * beacon that never changes, beside a page whose own stamp differs from it. */
{
  const p = await ctx.newPage();
  await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
  await p.route("**/version.json*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"git_sha":"ed25ed854"}' }));
  await p.addInitScript(() => { localStorage.setItem("wiki-admin-token", "gate"); });
  await p.goto(W, { waitUntil: "load" });
  await p.waitForTimeout(3000);
  await p.evaluate(() => { if (window.__wiki?.state?.data) window.__wiki.state.data.git_sha = "196ce8ca7"; });
  for (let i = 0; i < 3; i++) {       // three tab switches, the exact loop he hit
    await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await p.waitForTimeout(600);
  }
  ok(await p.evaluate(() => !document.querySelector(".update-bar")),
    "an unchanged beacon never offers a reload, however far the page's own stamp has drifted from it");
  await p.close();
}

// ---- 2. a genuinely newer build: one bar, and it names the new one --------
{
  const p = await ctx.newPage();
  let sha = "aaaaaaaaa";
  await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
  await p.route("**/version.json*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ git_sha: sha }) }));
  await p.addInitScript(() => { localStorage.setItem("wiki-admin-token", "gate"); });
  await p.goto(W, { waitUntil: "load" });
  await p.waitForTimeout(2500);
  ok(await p.evaluate(() => !document.querySelector(".update-bar")), "the beacon read at startup anchors, and never offers on its own");
  sha = "bbbbbbbbb";                  // a deploy lands
  await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await p.waitForTimeout(900);
  const bar = await p.evaluate(() => ({
    n: document.querySelectorAll(".update-bar").length,
    text: document.querySelector(".update-go")?.textContent ?? "",
    x: !!document.querySelector(".update-x"),
  }));
  ok(bar.n === 1 && /bbbbbbbbb/.test(bar.text) && bar.x,
    `a changed beacon offers ONE dismissible bar naming the new build (${bar.text})`);
  /* AT THE TOP (maintainer 2026-08-28: "I can't press on Commit and have a
   * lot of things to commit. Annoying as F.") — the bottom is the savebar's
   * ground, and the bar was sitting exactly on the Commit button mid-review. */
  const barPos = await p.evaluate(() => {
    const r = document.querySelector(".update-bar").getBoundingClientRect();
    const sv = document.querySelector("#savebar")?.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: innerHeight,
      overSave: sv ? !(r.bottom <= sv.top || r.top >= sv.bottom) : false };
  });
  ok(barPos.bottom < barPos.vh / 3 && !barPos.overSave,
    `and it sits at the TOP of the screen, never over the Commit bar (top ${Math.round(barPos.top)}px of ${barPos.vh})`);
  ok(await p.evaluate(() => !!document.querySelector("main")?.textContent.length),
    "and the page kept running — it never reloads on its own");
  // Dismissing must stick across further tab switches: a bar that can only be
  // obeyed is a trap when it is wrong, which is how this feature started.
  await p.click(".update-x");
  for (let i = 0; i < 3; i++) { await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await p.waitForTimeout(500); }
  ok(await p.evaluate(() => !document.querySelector(".update-bar")), "dismissing it keeps it dismissed for that build");
  await p.close();
}

// ---- 3. tapping it reloads ------------------------------------------------
{
  const p = await ctx.newPage();
  let sha = "ccccccccc";
  await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
  await p.route("**/version.json*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ git_sha: sha }) }));
  await p.addInitScript(() => { localStorage.setItem("wiki-admin-token", "gate"); });
  await p.goto(W, { waitUntil: "load" });
  await p.waitForTimeout(2500);
  sha = "ddddddddd";
  await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await p.waitForTimeout(900);
  const nav = p.waitForNavigation({ waitUntil: "load", timeout: 15_000 }).then(() => true).catch(() => false);
  await p.click(".update-go");
  ok(await nav, "tapping it reloads the page");
  // AND THE RELOAD ENDS IT: the new page anchors on the current beacon, so the
  // bar cannot come straight back — the loop he actually hit.
  await p.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await p.waitForTimeout(500); }
  ok(await p.evaluate(() => !document.querySelector(".update-bar")),
    "and after the reload it stays gone — the beacon it anchors on is the one it just loaded");
  await p.close();
}
await b.close();
console.log(fails.length ? `\nFRESHNESS CHECKS FAILED (${fails.length})` : "\nALL FRESHNESS CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
