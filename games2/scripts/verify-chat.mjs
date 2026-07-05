// Verify chat: one client sends a message, another receives it as a bubble.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.OUT || "/tmp";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
async function join() {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  // Auto-enter via the select screen's commit hook.
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
  await p1.waitForTimeout(1000);

  const MSG = "hello nangijala!";
  await p1.evaluate((m) => window.__ml.say(m), MSG);

  // p2 should receive the broadcast and show a bubble carrying the text.
  await p2.waitForFunction((m) => window.__ml.bubbles().includes(m), MSG, { timeout: 8000 });
  await p2.waitForTimeout(500);
  await p2.screenshot({ path: `${OUT}/chat.png` });

  const seen = await p2.evaluate(() => window.__ml.bubbles());
  console.log("RESULT " + JSON.stringify({ seen }));
  if (!seen.includes(MSG)) throw new Error("chat bubble not received by other client");
  console.log("CHAT OK");
} finally {
  await browser.close();
}
