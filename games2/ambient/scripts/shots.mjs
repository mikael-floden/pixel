// Ambient screenshot helper for maintainer review rounds: joins the dev
// stack, forces each ambient mood via the __ml probes, and saves PNGs.
//   node ambient/scripts/shots.mjs [outDir]   (default: ambient/scripts/out)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] || new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const EXE = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 30000 });
await page.waitForFunction(() => window.__mlAmbient, null, { timeout: 10000 });

// Night fireflies
await page.evaluate(() => {
  window.__ml.timeOfDay("night", true);
  window.__ml.weather(0, true);
});
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/ambient-night-fireflies.png` });

// Bats mid-crossing (pin the director roll onto bats)
await page.evaluate(() => window.__mlAmbient.reroll(0.01));
await page.waitForFunction(() => (window.__mlAmbient.debug("bats")?.inFlight ?? 0) > 0, null, { timeout: 15000 });
await page.waitForTimeout(1800); // let the flock reach the frame
await page.screenshot({ path: `${OUT}/ambient-night-bats.png` });

// Thunder flash (pin the roll into thunder's weight band, catch a pulse)
const d = await page.evaluate(() => window.__mlAmbient.reroll(0.5));
console.log("rolled:", d.active, JSON.stringify(d.weights));
try {
  await page.waitForFunction(() => window.__mlAmbient.debug("thunder")?.flashing === true, null, { timeout: 20000 });
  await page.screenshot({ path: `${OUT}/ambient-thunder-flash.png` });
} catch {
  console.log("no flash within 20s — skipped");
}

// Day pollen
await page.evaluate(() => window.__ml.timeOfDay("day", true));
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/ambient-day-pollen.png` });
await browser.close();
console.log(`done -> ${OUT}`);
