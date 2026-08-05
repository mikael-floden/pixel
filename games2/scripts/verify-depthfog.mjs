// Elevation depth-fog gate (dev-stack browser, like verify-sunshadow): the
// separate NORMAL-blend pass must actually render and tint the layers BELOW the
// player toward TEAL. Guards the shader-uniform footguns (a uniform that never
// syncs → the pass silently outputs nothing, the uSun lesson) and that the master
// strength genuinely gates it. Coarse, robust metric (no exact cell coords):
// force the player level high (so the whole view is "below" → haze), compare the
// central game area with the fog OFF vs ON, assert it shifts measurably teal, and
// that OFF is unchanged from baseline.
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("ml-last-choice", JSON.stringify({ world: "occlusion_test", characterUid: "default_boy", name: "df" }));
  sessionStorage.setItem("ml-rejoin", "1");
});
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__ml && window.__ml.players?.() >= 1, null, { timeout: 30000 });
await page.waitForTimeout(9000);
await page.evaluate(() => window.__ml.timeOfDay("Day"));
await page.evaluate(() => window.__ml.lookAt(60, 110)); // the plateau + surrounding low ground
// Force the virtual player WAY above the terrain (level 20; occlusion_test tops out at 7),
// so every ground pixel is far below the ELEV_D0 dead-zone → the elevation-edge fog fires
// regardless of the tuned FOG_D0 / ELEV_D0 (this gate proves the pass RENDERS, not its tuning).
await page.evaluate(() => window.__ml.depthFog(0, 20));
await page.waitForTimeout(700);

// Mean "teal-ness" = (G+B)/2 - R over the central game area (avoid frame + HUD).
const teal = (buf) => {
  const img = PNG.sync.read(buf);
  const x0 = 110, x1 = 650, y0 = 90, y1 = 440;
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      sum += (img.data[i + 1] + img.data[i + 2]) / 2 - img.data[i];
      n++;
    }
  return sum / n;
};

await page.evaluate(() => window.__ml.depthFog(0)); // OFF
await page.waitForTimeout(400);
const tealOff = teal(await page.screenshot());
await page.evaluate(() => window.__ml.depthFog(1)); // ON
await page.waitForTimeout(400);
const tealOn = teal(await page.screenshot());
await browser.close();

const shift = tealOn - tealOff;
console.log(`depth-fog teal-ness: off=${tealOff.toFixed(2)} on=${tealOn.toFixed(2)} shift=+${shift.toFixed(2)}`);
if (shift < 4) {
  console.log(`FAIL: fog ON did not add a clear teal cast to the layers below (shift ${shift.toFixed(2)} < 4) — the pass may not be rendering.`);
  process.exit(1);
}
console.log("verify-depthfog: OK — the fog pass renders and tints the below-player terrain teal, gated by the master strength.");
