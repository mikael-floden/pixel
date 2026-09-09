#!/usr/bin/env node
/* THE PREVIEW NEVER OUTGROWS THE PHONE SCREEN (maintainer 2026-09-09, a tree
 * at 4×: "not the entire scenery is rendered in the preview ... the tree is
 * 'cut'/clipped at the exact preview div boundary").
 *
 * Measured: nothing was clipped. The stage grew to 1,139px on a 740px phone
 * and, once he scrolled to the roots, its top slid under the sticky topbar
 * and crumb row (118px) — which looks exactly like a clip and cannot be told
 * from one. The rule now: the stage stops at the screen visible under both
 * bars and the picture scrolls INSIDE it, on both axes, with `safe` centring
 * so the crown is in real scroll space (a centred taller child parks half of
 * itself in negative scroll space nothing can reach — the same bug the width
 * axis had in August).
 *
 * Driven on a 360×740 phone against the local harness:
 *   node wiki/tools/serve-assets.mjs 8902   (+ serve-repo.mjs 8903 for admin)
 *   node wiki/tools/check-stage.mjs
 */
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
import { existsSync } from "node:fs";
// The browser, wherever it is: this sandbox bakes one in at a fixed path, CI
// installs one where playwright itself can find it (as check-routes does).
const SANDBOX = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const EXE = process.env.CHROMIUM_PATH || (existsSync(SANDBOX) ? SANDBOX : "");
const URL_ = process.env.WIKI_URL ?? "http://127.0.0.1:8902";
const W = `${URL_}/assets/wiki/site/index.html`;

let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? "ok" : "FAIL"}: ${msg}`); if (!c) fails++; };

const b = await chromium.launch(EXE ? { executablePath: EXE } : {});
const ctx = await b.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
await p.addInitScript(() => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", `${location.origin}/assets/`);
  localStorage.setItem("wiki-obj-human", "1");
});

const measure = () => p.evaluate(() => {
  const st = document.querySelector(".player-stage"), c = st.querySelector("canvas");
  const sr = st.getBoundingClientRect(), cr = c.getBoundingClientRect();
  const sticky = [...document.querySelectorAll("*")].filter((e) => getComputedStyle(e).position === "sticky" && e.getBoundingClientRect().top < 200)
    .reduce((m, e) => Math.max(m, e.getBoundingClientRect().bottom), 0);
  return {
    stageH: st.clientHeight, stageW: st.clientWidth, canvasH: c.height, canvasW: c.width,
    scrollH: st.scrollHeight, scrollW: st.scrollWidth, scrollTop: st.scrollTop,
    // where the canvas STARTS in the stage's scroll space — negative means unreachable
    canvasTop: Math.round(cr.top - sr.top + st.scrollTop), canvasLeft: Math.round(cr.left - sr.left + st.scrollLeft),
    room: window.innerHeight - sticky, sticky: Math.round(sticky), innerH: window.innerHeight,
    crumbH: getComputedStyle(document.documentElement).getPropertyValue("--crumb-h").trim(),
  };
});
const zoom = async (z) => {
  await p.evaluate((z) => { const bs = [...document.querySelectorAll(".seg button")].filter((x) => x.textContent.trim() === z); bs[bs.length - 1]?.click(); }, z);
  await p.waitForTimeout(900);
};

// A 246px tree: at 4× the canvas is ~1,100px tall, three phone screens.
await p.goto(`${W}#/objects/ancient_tree_001`, { waitUntil: "load" });
await p.waitForTimeout(3500);
const at2 = await measure();
console.log("2×:", JSON.stringify(at2));
ok(at2.crumbH && /px$/.test(at2.crumbH), `the crumb row's height is measured into --crumb-h (${at2.crumbH})`);
ok(at2.canvasH <= at2.stageH, `at the default zoom the whole picture is in the box (${at2.canvasH} in ${at2.stageH})`);

await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => /Always show hitbox/.test(x.textContent))?.click());
await p.waitForTimeout(700);
await zoom("4×");
const at4 = await measure();
console.log("4×:", JSON.stringify(at4));
ok(at4.canvasH > at4.room, `the 4× canvas is genuinely taller than the screen under the bars (${at4.canvasH} vs ${at4.room}) — otherwise this proves nothing`);
ok(at4.stageH <= at4.room, `so the STAGE stops at that screen (${at4.stageH} ≤ ${at4.room}): it can never slide under the sticky bars and read as a clip`);
ok(at4.scrollH >= at4.canvasH && at4.canvasTop >= 0,
  `and every pixel is reachable by scrolling inside it — the canvas starts at ${at4.canvasTop}px in real scroll space, ${at4.scrollH}px of it`);
ok(at4.scrollW >= at4.canvasW && at4.canvasLeft >= 0, `sideways too (${at4.canvasLeft}px, ${at4.scrollW}px)`);
// Back to 2×: the stage is its usual box again, not stuck at the cap.
await zoom("2×");
const back = await measure();
ok(back.stageH < at4.stageH || back.canvasH <= back.stageH, `and 2× gives the ordinary box back (${back.stageH}, canvas ${back.canvasH})`);

console.log(`page errors: ${errors.length ? errors.join(" | ").slice(0, 300) : "none"}`);
ok(!errors.length, "no page errors while zooming");
await b.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL STAGE CHECKS PASSED");
process.exit(fails ? 1 : 0);
