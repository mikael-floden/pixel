import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SHOT = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-frame-rate-limit", "--disable-gpu-vsync", "--enable-unsafe-swiftshader"] });
const VW = 900, VH = 700;
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "wf-crystalz-a3-" + Math.floor(Math.random() * 1e5));
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__ml.timeOfDay("Day"));
await page.waitForTimeout(500);

async function walkTo(colT, rowT) {
  const CELL = 32; const deadline = Date.now() + 180000;
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

// Behind-north pose, approaching from due north so the greedy controller
// never wall-slides on the pillar: north lane row ~224.0, then drop south.
for (const [c, w] of [[262.0, 224.2], [263.4, 224.2], [263.4, 225.5]]) {
  const res = await walkTo(c, w);
  console.log("wp", c, w, "->", JSON.stringify(res));
}
await page.waitForTimeout(600);
const clip = { x: VW / 2 - 225, y: VH / 2 - 235, width: 450, height: 470 };
await page.screenshot({ path: `${SHOT}/wf-crystalz-a3-behind-north.png`, clip });
console.log("depthProbe:", JSON.stringify(await page.evaluate(() => window.__ml.depthProbe?.())));
await browser.close();
