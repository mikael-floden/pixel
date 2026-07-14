import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SHOT = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-frame-rate-limit", "--disable-gpu-vsync", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "wf-crystalz-" + Math.floor(Math.random() * 1e5));
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__ml.timeOfDay("Day"));
await page.waitForTimeout(500);

async function walkTo(colT, rowT) {
  const CELL = 32; const deadline = Date.now() + 60000;
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

async function shot(name) {
  await page.waitForTimeout(600); // let camera settle / idle anim
  const clip = { x: 700 - 225, y: 425 - 235, width: 450, height: 470 };
  await page.screenshot({ path: `${SHOT}/wf-crystalz-${name}.png`, clip });
  const probe = await page.evaluate(() => window.__ml.depthProbe?.());
  console.log(name, "depthProbe:", JSON.stringify(probe));
}

const routes = [
  { name: "a-behind-north", wps: [[262.0, 224.2], [263.4, 225.5]] },
  { name: "b-beside-west", wps: [[261.5, 224.5], [261.5, 226.0], [262.3, 226.5]] },
  { name: "c-front", wps: [[261.5, 228.0], [263.5, 227.4]] },
];

for (const r of routes) {
  let res = null;
  for (const [c, w] of r.wps) {
    res = await walkTo(c, w);
    console.log(r.name, "waypoint", c, w, "->", JSON.stringify(res));
  }
  // retry the final target once if the greedy controller stranded
  const [fc, fw] = r.wps[r.wps.length - 1];
  if (!res?.arrived) {
    res = await walkTo(fc, fw);
    console.log(r.name, "RETRY final", fc, fw, "->", JSON.stringify(res));
  }
  await shot(r.name);
}

await browser.close();
