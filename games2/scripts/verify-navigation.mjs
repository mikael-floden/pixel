// Navigation regression: RUN-tap a point 2wu from a prop's face (the
// "fly at the window" bug — most casual taps in a dense prop field land
// beside something). The trip must END cleanly at the clearance-adjusted
// target with no grinding against the prop.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /prop/i.test(w)));
  if (idx >= 0) await page.evaluate((i) => window.__mlSelect.pickWorld(i), idx);
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.bringToFront();
  const t = await page.evaluate(() => {
    const me = window.__ml.me();
    let best = null;
    for (let dy = -10; dy <= 10; dy++)
      for (let dx = -10; dx <= 10; dx++) {
        const x = me.x + dx * 32, y = me.y + dy * 32;
        if (!window.__ml.blockedAt(x, y)) continue;
        const d = Math.hypot(dx, dy);
        if (!best || d < best.d) best = { d, x, y };
      }
    if (!best) return null;
    // Tap 2wu west of the prop's west face — a spot the body can't occupy.
    const c = Math.floor(best.x / 32), r = Math.floor(best.y / 32);
    const tapX = c * 32 - 2, tapY = r * 32 + 16;
    window.__ml.tapTo(tapX, tapY, true); // RUN
    const tgt = window.__ml.target();
    return { propCell: [c, r], rawTap: [tapX, tapY], adjTarget: [Math.round(tgt.x), Math.round(tgt.y)], wp: window.__ml.path().length };
  });
  console.log("TAP", JSON.stringify(t));
  if (!t) throw new Error("no prop near spawn");
  let prev = null, bumps = 0, done = false, i = 0;
  for (; i < 80; i++) {
    const s = await page.evaluate(() => {
      const me = window.__ml.me();
      let dmin = 999;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const cx = Math.floor(me.x / 32) + dx, cy = Math.floor(me.y / 32) + dy;
          if (!window.__ml.blockedAt(cx * 32 + 16, cy * 32 + 16)) continue;
          const ddx = Math.max(cx * 32 - me.x, 0, me.x - (cx + 1) * 32);
          const ddy = Math.max(cy * 32 - me.y, 0, me.y - (cy + 1) * 32);
          dmin = Math.min(dmin, Math.hypot(ddx, ddy));
        }
      return { x: me.x, y: me.y, dmin, target: !!window.__ml.target() };
    });
    if (prev && s.dmin < 13 && Math.hypot(s.x - prev.x, s.y - prev.y) < 2) bumps++;
    prev = s;
    if (!s.target) { done = true; break; }
    await page.waitForTimeout(150);
  }
  console.log(`trip ${done ? "ENDED" : "STILL RUNNING"} after ${(i * 0.15).toFixed(1)}s, bumps=${bumps}`);
  if (!done) throw new Error("trip never ended — still grinding");
  if (bumps > 3) throw new Error(`grinding detected (${bumps} bump ticks)`);
  console.log("NAVIGATION OK");
} finally { await browser.close(); }
