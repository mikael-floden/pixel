// Raw-input speed probe: hold one arrow key for 5s on a world and measure the
// SERVER-truth displacement (__ml.me()). Separates "movement is slow" from
// "the autopilot is confused" — no tap-to-move involved.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });

async function measure(worldTag) {
  const ctx = await browser.newContext({ viewport: { width: Number(process.env.VW || 900), height: Number(process.env.VH || 640) } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  {
    const idx = await page.evaluate(
      (re) => window.__mlSelect.worlds().findIndex((w) => new RegExp(re, "i").test(w)),
      worldTag,
    );
    if (idx >= 0) await page.evaluate((i) => window.__mlSelect.pickWorld(i), idx);
  }
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.bringToFront();
  const pos = () => page.evaluate(() => { const m = window.__ml.me(); return { x: m.x, y: m.y }; });

  // Try all four arrows: some directions may be blocked at spawn; report each.
  for (const key of ["ArrowDown", "ArrowRight"]) {
    const p0 = await pos();
    await page.keyboard.down(key);
    const t0 = Date.now();
    await page.waitForTimeout(5000);
    await page.keyboard.up(key);
    const dts = (Date.now() - t0) / 1000;
    await page.waitForTimeout(400); // let the last input land
    const p1 = await pos();
    const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    console.log(`${worldTag} ${key}: ${d.toFixed(1)}wu in ${dts.toFixed(2)}s = ${(d / dts).toFixed(1)}wu/s (walk=70)`);
  }
  // Frame + timer cadence snapshot.
  const cad = await page.evaluate(async () => {
    const t0 = performance.now();
    let frames = 0;
    await new Promise((res) => {
      const tick = () => (++frames < 8 ? requestAnimationFrame(tick) : res());
      requestAnimationFrame(tick);
    });
    return { rafMs: (performance.now() - t0) / 8 };
  });
  console.log(`${worldTag} rAF interval ≈ ${cad.rafMs.toFixed(0)}ms`);
  await ctx.close();
}

try {
  await measure("prop");
  await measure("glow");
} finally { await browser.close(); }
