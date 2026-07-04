// Glow-field seam check: overlapping halo stamps must ACCUMULATE. Phaser's
// ADD blend is (ONE, DST_ALPHA); on a transparent RT every stamp erased a
// rectangle of earlier glow (hard black quad edges — playtester report).
// The fix fills the RT with opaque black first. This probe scans a dense
// glow area for the seam signature: columns whose brightness dips sharply
// below BOTH horizontal neighbours down a long vertical run.
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto((process.env.PROBE_URL || "http://localhost:5173/") + "#emission", { waitUntil: "load" });
await page.waitForFunction(() => window.__ml?.demo === true && window.__ml.nightShader() === true, null, {
  timeout: 30000,
});
await page.waitForTimeout(2500);
const st = await page.evaluate(() =>
  window.__ml.stations().find((s) => s.cat === "cliff_gold_v2" && s.v === 4),
);
await page.evaluate((n) => window.__ml.lookStation(n), st.n);
await page.waitForTimeout(2000);
const shot = PNG.sync.read(await page.screenshot());
let seams = 0;
for (let x = 300; x < 1300; x++) {
  let dip = 0;
  for (let y = 250; y < 750; y += 4) {
    const g = (xx) => shot.data[(y * shot.width + xx) * 4 + 1];
    if (g(x - 3) - g(x) > 25 && g(x + 3) - g(x) > 25) dip++;
  }
  if (dip > 30) seams++;
}
console.log(`hard vertical glow seams: ${seams} (want 0)`);
await browser.close();
process.exit(seams === 0 ? 0 : 1);
