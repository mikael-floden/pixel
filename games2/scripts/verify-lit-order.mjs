// Numeric check: lit copies (above the night overlay) must keep the SAME
// relative draw order as their base sprites — a character in front of the
// campfire must also be in front of the fire's lit copy. Asserts depths only.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "litprobe");
await page.keyboard.press("Enter");
await page.waitForFunction(() => (window).__ml?.players?.() >= 1, null, { timeout: 20000 });
await page.waitForFunction(() => (window).__ml?.litOrder?.()?.fire?.lit !== null, null, { timeout: 20000 });

const o = await page.evaluate(() => (window).__ml.litOrder());
console.log("litOrder:", JSON.stringify(o));
if (!o.me || !o.fire || o.me.lit === null || o.fire.lit === null)
  throw new Error("missing lit copies: " + JSON.stringify(o));
const OVERLAY = 900000;
if (!(o.me.lit > OVERLAY && o.fire.lit > OVERLAY))
  throw new Error("lit copies not above the overlay");
const baseOrder = Math.sign(o.me.base - o.fire.base);
const litOrder = Math.sign(o.me.lit - o.fire.lit);
if (baseOrder !== litOrder)
  throw new Error(`order mismatch: base ${baseOrder} vs lit ${litOrder}`);
console.log(`OK: base order ${baseOrder} preserved in lit layer (me.lit=${o.me.lit}, fire.lit=${o.fire.lit})`);
process.exit(0);
