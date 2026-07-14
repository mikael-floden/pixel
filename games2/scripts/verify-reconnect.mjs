// Dead-connection recovery: when the websocket drops (phone slept, network
// blip), the client must notice, reload itself, SKIP the select screen (the
// ml-rejoin fast path) and land back in the world at the persisted position.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const fail = (m) => {
  throw new Error(m);
};
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 640 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  await page.waitForTimeout(1500); // let the position persist once (onLeave saves too)
  const before = await page.evaluate(() => {
    const m = window.__ml.me();
    return { x: m.x, y: m.y };
  });

  // Kill the socket. The onLeave handler must reload the page on its own.
  await Promise.all([
    page.waitForNavigation({ timeout: 15000 }),
    page.evaluate(() => window.__ml.dropConnection()),
  ]);
  console.log("auto-reload OK");

  // After the reload the select screen must be SKIPPED (rejoin fast path):
  // the world comes up without any __mlSelect.commit() from us.
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  const after = await page.evaluate(() => {
    const m = window.__ml.me();
    return { x: m.x, y: m.y };
  });
  const d = Math.hypot(after.x - before.x, after.y - before.y);
  console.log(`rejoined at ${after.x.toFixed(0)},${after.y.toFixed(0)} (moved ${d.toFixed(0)}wu from before)`);
  if (d > 64) fail(`position not restored (drifted ${d.toFixed(0)}wu)`);
  console.log("RECONNECT OK");
} finally {
  await browser.close();
}
