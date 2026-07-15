// Weather layer: numeric gate on the cloud-shadow CPU twin (the shader
// mirrors it exactly). Clear sky = no shading anywhere; "cloudy at times"
// = a world-anchored PATCHY field (some ground shaded, some clear) that
// DRIFTS with the wind; at night the missing sun mutes it.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const fail = (m) => {
  console.error(`WEATHER FAIL: ${m}`);
  process.exitCode = 1;
};

try {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 30000 });
  await page.waitForTimeout(600);

  const grid = () =>
    page.evaluate(() => {
      const out = [];
      for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) out.push(window.__ml.cloudAt(x * 45, y * 45));
      return out;
    });

  await page.evaluate(() => {
    window.__ml.timeOfDay("day", true);
    window.__ml.weather(0, true);
  });
  const clear = await grid();
  if (clear.some((f) => f !== 1)) fail(`clear sky must cast nothing (min ${Math.min(...clear)})`);

  await page.evaluate(() => window.__ml.weather(1, true));
  const a = await grid();
  const shaded = a.filter((f) => f < 0.9).length;
  const open = a.filter((f) => f > 0.98).length;
  if (shaded < 40) fail(`cloudy must shade a real share of the ground (${shaded}/1600 cells)`);
  if (open < 200) fail(`cloudy must stay PATCHY — "cloudy at times", not overcast (${open}/1600 clear)`);
  await page.waitForTimeout(2500);
  const b = await grid();
  const moved = a.filter((f, i) => Math.abs(f - b[i]) > 0.05).length;
  if (moved < 30) fail(`clouds must DRIFT (only ${moved}/1600 samples changed after 2.5s)`);

  await page.evaluate(() => window.__ml.timeOfDay("night", true));
  const night = await grid();
  if (Math.min(...night) < 0.9) fail(`night clouds must be muted, no sun to block (min ${Math.min(...night)})`);

  console.log(`WEATHER OK (day: ${shaded} shaded / ${open} clear of 1600; drift ${moved}; night min ${Math.min(...night).toFixed(2)})`);
} finally {
  await browser.close();
}
