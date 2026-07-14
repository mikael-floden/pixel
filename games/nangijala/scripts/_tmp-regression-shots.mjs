// Regression captures for the 8324c5d4 fixes: terrace walls (occluder layer
// completeness), pillar V-vs-collision alignment ([4] overlay), campfire
// lit-copy cover, and the foot-clip walk spot.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const CELL = 32;

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox", "--disable-frame-rate-limit", "--disable-gpu-vsync", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "regprobe");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);

// 1. Terrace rim at night (the "tiles drawn 3 times" report).
await page.evaluate(() => window.__ml.lookAt(261, 207));
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/reg-terrace-night.png` });

// 2. Pillars + collision overlay at day.
await page.evaluate(() => { window.__ml.timeOfDay("Day"); window.__ml.lookAt(261, 223); });
await page.waitForTimeout(900);
await page.keyboard.press("4"); // collision overlay
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/reg-pillars-collision.png` });
await page.keyboard.press("4");

// 3. Campfire with pillars behind it at night (lit-copy cover).
await page.evaluate(() => { window.__ml.timeOfDay("Night"); window.__ml.lookAt(259, 221); });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/reg-campfire.png`, clip: { x: 380, y: 120, width: 640, height: 600 } });

// 4. Walk to the foot-clip spot (west of the lava pillar).
async function walkTo(colT, rowT) {
  const deadline = Date.now() + 40000;
  const keys = { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false };
  const set = async (k, want) => {
    if (keys[k] === want) return;
    keys[k] = want;
    if (want) await page.keyboard.down(k);
    else await page.keyboard.up(k);
  };
  for (;;) {
    const me = await page.evaluate(() => {
      const p = window.__ml.me();
      return p ? { x: p.x, y: p.y } : null;
    });
    if (!me) return null;
    const dxw = colT * CELL + CELL / 2 - me.x;
    const dyw = rowT * CELL + CELL / 2 - me.y;
    const sdx = dxw - dyw;
    const sdy = (dxw + dyw) * 0.40625;
    const done = Math.abs(dxw) < 3 && Math.abs(dyw) < 3;
    if (done || Date.now() > deadline) {
      for (const k of Object.keys(keys)) await set(k, false);
      return { arrived: done, x: me.x / CELL, y: me.y / CELL };
    }
    await set("ArrowRight", sdx > 2);
    await set("ArrowLeft", sdx < -2);
    await set("ArrowDown", sdy > 2);
    await set("ArrowUp", sdy < -2);
    await page.waitForTimeout(80);
  }
}
await page.evaluate(() => window.__ml.lookAt()); // re-follow player
await walkTo(259.5, 220.5);
const r = await walkTo(260.4, 222.6);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/reg-footclip.png`, clip: { x: 480, y: 180, width: 440, height: 470 } });
console.log("footclip spot:", JSON.stringify(r));
await browser.close();
