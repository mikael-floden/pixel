import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  const expected = await (await fetch("http://localhost:5173/anim-speeds.json")).json();
  let bad = 0;
  for (const [uid, states] of Object.entries(expected)) {
    for (const [state, dirs] of Object.entries(states)) {
      for (const [dir, fps] of Object.entries(dirs)) {
        const got = await page.evaluate(({ uid, state, dir }) => window.__ml.animRate(uid, state, dir), { uid, state, dir });
        const ok = got !== null && Math.abs(got - fps) < 0.11;
        if (!ok) { bad++; console.log(`MISMATCH ${uid} ${state} ${dir}: json=${fps} anim=${got}`); }
      }
    }
  }
  // idle must stay at the default (6), jump untouched (18)
  const idle = await page.evaluate(() => window.__ml.animRate("default_boy", "idle", "south"));
  const jump = await page.evaluate(() => window.__ml.animRate("default_boy", "jump", "south"));
  console.log(`checked all measured entries; idle=${idle} (want 6), jump=${jump} (want 18), mismatches=${bad}`);
  if (bad || idle !== 6 || jump !== 18) throw new Error("anim rates wrong");
  console.log("ANIM-RATES OK");
} finally { await browser.close(); }
