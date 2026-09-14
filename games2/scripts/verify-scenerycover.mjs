// THE TREE OVER THE HOUSE (maintainer 2026-09-12, with the screenshot at the
// spawn: "Can you fade out the scenery if it covers too much space inside the
// house? I feel the tree at the spawn almost cover the entire house... I still
// want to see this effect on trees and other scenery that doesn't cover 50% of
// the house like this tree."). ONE session on the_game: stand where he stood
// (333.5, 233.9 — inside the spawn house), let the cut-away land, and read the
// cover probe: at least one outside piece covers half the floor and wears alpha
// 0 (sprite, and its lit copy through `fade`); every piece under the line keeps
// alpha 1 — the silhouette he wants to keep. Then step out onto the spawn square
// and the faded piece is whole again. Run with `npm run dev` up.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const fail = (m) => { throw new Error(m); };
const INSIDE = [333.5, 233.9]; // his screenshot's position
const OUTSIDE = [333, 237]; // the world's spawn square, beside the house

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 520, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 160)));
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /the_game/i.test(w)));
  if (idx < 0) fail("the_game missing from the picker");
  await page.evaluate((i) => { window.__mlSelect.pickWorld(i); window.__mlSelect.commit(); }, idx);
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 40000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 25000 });
  await page.bringToFront();
  if (!(await page.evaluate(() => typeof window.__ml.sceneryCover === "function"))) fail("no __ml.sceneryCover probe in this build");

  const go = async ([c, r]) => page.evaluate(([c, r]) => { const m = window.__ml.me(); if (m?.dead) window.__ml.roomSend("respawn", {}); window.__ml.teleport(c, r); }, [c, r]);
  await go(INSIDE);
  await page.waitForFunction(() => { const f = window.__ml.indoorFade(); return f.inside && f.mix >= 0.99; }, { timeout: 25000 })
    .catch(() => fail(`the cut-away never landed at ${INSIDE}: ${JSON.stringify(page.evaluate(() => window.__ml.indoorFade()))}`));
  // The scenery around the house streams in behind the live world; give the
  // rebuild a moment, then read a settled frame.
  await page.waitForTimeout(2500);
  const fade = await page.evaluate(() => window.__ml.indoorFade());
  const list = await page.evaluate(() => window.__ml.sceneryCover(12));
  console.log(`inside: mix ${fade.mix}, covering ${fade.covering}, coveringAlpha ${fade.coveringAlpha}`);
  for (const p of list) console.log(`  place ${p.place}: cover ${(p.cover * 100).toFixed(0)}% alpha ${p.alpha}${p.fades ? "  <- fades out" : ""}`);
  if (!(fade.covering >= 1)) fail("no outside piece covers half the spawn house — the tree he photographed should");
  const fading = list.filter((p) => p.fades);
  for (const p of fading) if (p.alpha > 0.02) fail(`place ${p.place} covers ${(p.cover * 100).toFixed(0)}% of the room and still wears alpha ${p.alpha}`);
  const kept = list.filter((p) => !p.fades && p.cover > 0);
  for (const p of kept) if (p.alpha !== 1) fail(`place ${p.place} covers only ${(p.cover * 100).toFixed(0)}% and lost its silhouette (alpha ${p.alpha})`);
  console.log(`scenery cover OK: ${fading.length} piece(s) over half the room faded out, ${kept.length} smaller piece(s) over it kept their silhouette`);

  await go(OUTSIDE);
  await page.waitForFunction(() => { const f = window.__ml.indoorFade(); return !f.inside && f.mix <= 0.01; }, { timeout: 25000 })
    .catch(() => fail("never left the house"));
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => window.__ml.sceneryCover(12));
  for (const p of back) if (p.alpha !== 1) fail(`outside again, place ${p.place} still wears alpha ${p.alpha}`);
  console.log(`scenery cover OK: outside again every piece is whole (${back.length} checked)`);
  if (errs.length) fail(`page errors: ${errs.join(" | ")}`);
} finally {
  await browser.close();
}
