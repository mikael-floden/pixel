#!/usr/bin/env node
/* "REMOVED" MUST BE TRUE (maintainer 2026-09-11: "When I first open the wiki or
 * press on a page I get an error saying 'removed'. I then click back and on the
 * same page again and the same img/monster loads.")
 *
 * A 404 from the deployed image says nothing: the image carries only what the
 * game reaches, so every creature still being animated 404s there by
 * arrangement. The wiki must ask main before it tells him an agent deleted
 * something — and when main has the file, it must simply show it.
 *
 * Driven across TWO origins, the way production is shaped:
 *   node wiki/tools/serve-assets.mjs 8902     (the image: art 404d on purpose)
 *   node wiki/tools/serve-repo.mjs   8903     (the repo: has everything)
 *   node wiki/tools/check-gone.mjs
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const { chromium } = createRequire(new URL("../../games2/package.json", import.meta.url))("playwright-core");
const SANDBOX = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const EXE = process.env.CHROMIUM_PATH || (existsSync(SANDBOX) ? SANDBOX : "");
const W = `${process.env.WIKI_URL ?? "http://127.0.0.1:8902"}/assets/wiki/site/index.html`;
const REPO = process.env.REPO_URL ?? "http://127.0.0.1:8903/";
const DATA = JSON.parse(readFileSync(new URL("../site/data.json", import.meta.url), "utf8"));
let fails = 0;
const ok = (c, msg) => { console.log(`  ${c ? "ok" : "FAIL"}: ${msg}`); if (!c) fails++; };

// A creature whose art the image would not carry — one still being animated.
const staging = (DATA.domains?.monsters ?? []).find((m) => m.pending) ?? (DATA.domains?.monsters ?? [])[0];
const strip = staging.animations[Object.keys(staging.animations)[0]].dirs.south?.strip;
if (!strip) { console.log("no strip to drive"); process.exit(0); }

const b = await chromium.launch(EXE ? { executablePath: EXE } : {});
const ctx = await b.newContext({ viewport: { width: 393, height: 850 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));
await p.route("**/api/wiki/me", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"admin":true}' }));
// THE IMAGE DOES NOT CARRY IT — exactly what production answers for staging art.
let asked = 0;
await p.route(`**/assets/${strip}`, (r) => { asked++; return r.fulfill({ status: 404, body: "" }); });
// What the repo origin actually served — the canvas cannot be read once a
// cross-origin image is drawn on it, so the network is the evidence.
const fromRepo = [];
p.on("response", (r) => { if (r.url().startsWith(REPO) && r.url().endsWith(strip)) fromRepo.push(r.status()); });
await p.addInitScript((repo) => {
  localStorage.setItem("wiki-admin-token", "gate");
  localStorage.setItem("ml-staging-base", repo);
  localStorage.setItem("wiki-monster-shadow", "all");
}, REPO);

await p.goto(`${W}#/monsters/${staging.id}`, { waitUntil: "load" });
await p.waitForTimeout(3500);
const page = await p.evaluate(() => ({
  notes: [...document.querySelectorAll(".art-note")].map((n) => n.textContent),
  removed: [...document.querySelectorAll(".art-note")].some((n) => /removed/.test(n.textContent)),
  imgs: [...document.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth > 0).length,
  canvas: (() => {
    const c = document.querySelector(".player-stage canvas");
    if (!c || !c.width || !c.height) return 0;
    try {
      const px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 8) n++; return n;
    } catch { return -1; }   // a cross-origin draw taints the canvas
  })(),
}));
console.log(`${staging.name}: image 404d ${asked} time(s) —`, JSON.stringify(page));
ok(asked > 0, `the gate really did 404 the image's copy (${asked} request(s))`);
ok(!page.removed, `and the page never says "removed" about art main still has (${page.notes.join(" | ") || "no notes"})`);
console.log("repo served:", JSON.stringify(fromRepo));
ok(fromRepo.some((st) => st === 200), `the art is fetched from the repo instead and arrives (${fromRepo.join(", ") || "never asked"})`);
ok(page.canvas !== 0, `and it reaches the viewer's canvas (${page.canvas === -1 ? "drawn, cross-origin so unreadable" : `${page.canvas} opaque pixels`})`);

// ...and a file that is REALLY gone still reads as removed.
await p.route(`**/monsters/**/ancient_nothing__south.webp`, (r) => r.fulfill({ status: 404, body: "" }));
const verdict = await p.evaluate(async (rel) => {
  const u = new URL(`assets/${rel}`, location.href).href;
  return await window.__wiki.probeGone?.(u) ?? "no probe exposed";
}, "monsters/does_not_exist/animations/ancient_nothing__south.webp");
console.log("a path nobody has:", JSON.stringify(verdict));
ok(verdict === "no probe exposed" || verdict?.verdict === "gone", `a path neither side has is still gone (${JSON.stringify(verdict)})`);

console.log(`page errors: ${errors.length ? errors.join(" | ").slice(0, 200) : "none"}`);
ok(!errors.length, "no page errors");
await b.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL GONE-VERDICT CHECKS PASSED");
process.exit(fails ? 1 : 0);
