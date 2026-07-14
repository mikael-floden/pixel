import { chromium } from "playwright-core";

const OUT = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-frame-rate-limit", "--disable-gpu-vsync", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "wf-lp2-" + Math.floor(Math.random() * 1e5));
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__ml.timeOfDay("Day"));
await page.waitForTimeout(400);

async function walkTo(colT, rowT, ms = 30000) {
  const CELL = 32; const deadline = Date.now() + ms;
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

async function snap(name) {
  await page.waitForTimeout(700);
  const clip = { x: 700 - 225, y: 425 - 245, width: 450, height: 470 };
  await page.screenshot({ path: `${OUT}/wf-lavapillar-${name}.png`, clip });
  const info = await page.evaluate(() => ({ me: window.__ml.me(), probe: window.__ml.depthProbe?.() }));
  console.log(name, "cell=", (info.me.x / 32).toFixed(2), (info.me.y / 32).toFixed(2), "depth=", info.probe?.me?.depth, "coverY=", info.probe?.me?.coverY);
}

console.log("wp1:", JSON.stringify(await walkTo(259.5, 220.5)));
console.log("wp2:", JSON.stringify(await walkTo(262.7, 220.4)));
console.log("c:", JSON.stringify(await walkTo(262.6, 222.4)));
await snap("c2-beside-east");

console.log("wp3:", JSON.stringify(await walkTo(262.6, 221.5)));
console.log("e:", JSON.stringify(await walkTo(261.6, 221.55)));
await snap("e-behind-north");

console.log("wp4:", JSON.stringify(await walkTo(260.4, 221.6)));
console.log("a2:", JSON.stringify(await walkTo(260.4, 222.6)));
await snap("a2-beside-west");

await browser.close();
console.log("DONE");
