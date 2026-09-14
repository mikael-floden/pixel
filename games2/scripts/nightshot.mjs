// A LOOK AT ONE SPOT AT NIGHT, torch on: COL= ROW= OUT=<png> [WRAP=0..1]
// [FOG=0|1] node scripts/nightshot.mjs — against the dev stack. Teleports,
// waits for the world to be up (a far teleport is a zone hop and the loading
// overlay), THEN forces night (a hop re-syncs the shared clock, so setting it
// earlier is undone), and screenshots. Swap client/src/nightlight.ts from git
// between two runs for a BEFORE/AFTER of the shader at a spot he sent.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const [col, row, out] = [Number(process.env.COL), Number(process.env.ROW), process.env.OUT];
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
page.on("pageerror", (e) => console.log("pageerror", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("console.error", m.text().slice(0, 300)); });
await page.goto("http://localhost:5173/#the_game", { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 120000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.__ml.noAggro?.(true));
await page.evaluate(() => window.__ml.torch?.(true));
if (process.env.WRAP !== undefined) await page.evaluate((w) => window.__ml.wallWrap?.(w), Number(process.env.WRAP));
if (process.env.FOG !== undefined) await page.evaluate((f) => window.__ml.depthFog?.(f), Number(process.env.FOG));
await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [col, row]);
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 60000 });
await page.waitForFunction(() => { const e = document.getElementById("ml-loading"); return !e || !e.isConnected || getComputedStyle(e).display === "none" || getComputedStyle(e).visibility === "hidden" || Number(getComputedStyle(e).opacity) === 0; }, null, { timeout: 90000 });
await page.evaluate(() => window.__ml.timeOfDay("night", true)); // AFTER the hop: a zone swap re-syncs the shared clock
await page.waitForTimeout(4000);
console.log("torch", await page.evaluate(() => window.__ml.torchOn()), "wrap", await page.evaluate(() => window.__ml.wallWrap?.()));
await page.screenshot({ path: out });
await browser.close();
