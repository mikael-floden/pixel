// Directional sun shadows (day phases): numeric gate on the CPU twin the
// shader mirrors. Joins the smoke's props world, sets each phase INSTANTLY
// via the local __ml.timeOfDay probe, and samples __ml.sunAt over a window
// around the spawn:
//   - NIGHT has no sun -> every factor is exactly 1;
//   - MORNING and EVENING cast in OPPOSITE directions -> there exist cells
//     shaded in one and lit in the other, both ways;
//   - DAY (noon) stands high -> its shaded-cell count is smaller than
//     morning's and evening's (shorter shadows).
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const fail = (m) => {
  console.error(`SUNSHADOW FAIL: ${m}`);
  process.exitCode = 1;
};

try {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  // Default world (demo_lost): real multi-level cliffs — the props demo is
  // flat and casts nothing.
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 30000 });
  await page.waitForTimeout(600);

  const sample = async (phase) =>
    page.evaluate((ph) => {
      window.__ml.timeOfDay(ph, true);
      const me = window.__ml.me();
      const c0 = Math.round(me.x / 32), r0 = Math.round(me.y / 32);
      const out = [];
      for (let r = r0 - 18; r <= r0 + 18; r++)
        for (let c = c0 - 18; c <= c0 + 18; c++) out.push(window.__ml.sunAt(c, r));
      return out;
    }, phase);

  const night = await sample("night");
  if (night.some((f) => f !== 1)) fail(`night must have no sun shading (min ${Math.min(...night)})`);

  const morning = await sample("morning");
  const evening = await sample("evening");
  const day = await sample("day");
  const shaded = (a) => a.filter((f) => f < 0.86).length;
  const flipAB = morning.filter((f, i) => f < 0.86 && evening[i] > 0.96).length;
  const flipBA = morning.filter((f, i) => f > 0.96 && evening[i] < 0.86).length;
  if (shaded(morning) < 5) fail(`morning casts too few shadows (${shaded(morning)} cells)`);
  if (shaded(evening) < 5) fail(`evening casts too few shadows (${shaded(evening)} cells)`);
  if (flipAB < 3 || flipBA < 3) fail(`shadows must flip sides morning<->evening (AB ${flipAB}, BA ${flipBA})`);
  if (!(shaded(day) < shaded(morning) && shaded(day) < shaded(evening)))
    fail(`noon shadows must be shortest (day ${shaded(day)} vs morning ${shaded(morning)}, evening ${shaded(evening)})`);
  console.log(
    `SUNSHADOW OK (shaded cells: morning ${shaded(morning)}, day ${shaded(day)}, evening ${shaded(evening)}; flips ${flipAB}/${flipBA})`,
  );
} finally {
  await browser.close();
}
