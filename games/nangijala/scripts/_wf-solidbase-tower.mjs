import { chromium } from "playwright-core";

const OUT = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-frame-rate-limit", "--disable-gpu-vsync", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "wf-solidbase-tower");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__ml.timeOfDay("Day"));

async function walkTo(colT, rowT) {
  const CELL = 32; const deadline = Date.now() + 40000;
  const keys = { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false };
  const set = async (k, want) => { if (keys[k] === want) return; keys[k] = want; if (want) await page.keyboard.down(k); else await page.keyboard.up(k); };
  for (;;) {
    const me = await page.evaluate(() => { const p = window.__ml.me(); return p ? { x: p.x, y: p.y } : null; });
    if (!me) return null;
    const dxw = colT * CELL + CELL / 2 - me.x, dyw = rowT * CELL + CELL / 2 - me.y;
    const sdx = dxw - dyw, sdy = (dxw + dyw) * 0.40625;
    const done = Math.abs(dxw) < 3 && Math.abs(dyw) < 3;
    if (done || Date.now() > deadline) { for (const k of Object.keys(keys)) await set(k, false); return { arrived: done, x: me.x / CELL, y: me.y / CELL }; }
    await set("ArrowRight", sdx > 2); await set("ArrowLeft", sdx < -2); await set("ArrowDown", sdy > 2); await set("ArrowUp", sdy < -2);
    await page.waitForTimeout(80);
  }
}

const waypoints = [[256, 230], [251, 234], [246, 237], [242, 239]];
for (const [c, r] of waypoints) {
  const res = await walkTo(c, r);
  console.log(`waypoint (${c},${r}) ->`, JSON.stringify(res));
}
await page.keyboard.press("4");
await page.waitForTimeout(400);
await page.evaluate(() => window.__ml.lookAt(240, 241));
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/wf-solidbase-tower2.png` });
const me = await page.evaluate(() => window.__ml.me());
console.log("final me:", JSON.stringify(me));
await browser.close();
