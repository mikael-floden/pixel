// Verify the PRODUCTION single-origin build: client, pixel assets, and the
// WebSocket world are all served from one port; two browsers share the world.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const URL = process.env.URL || "http://localhost:8080/";
const OUT = process.env.OUT || "/tmp";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
async function join() {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 20000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 20000 });
  return page;
}
try {
  const p1 = await join();
  const p2 = await join();
  await p1.waitForFunction(() => window.__ml.players() >= 2, { timeout: 20000 });
  await p2.waitForFunction(() => window.__ml.players() >= 2, { timeout: 20000 });
  await p1.waitForTimeout(1500);
  await p1.screenshot({ path: `${OUT}/prod.png` });
  const result = { endpoint: await p1.evaluate(() => location.origin), players: await p2.evaluate(() => window.__ml.players()) };
  console.log("RESULT " + JSON.stringify(result));
  if (result.players < 2) throw new Error("players did not converge on single origin");
  console.log("PROD OK");
} finally {
  await browser.close();
}
