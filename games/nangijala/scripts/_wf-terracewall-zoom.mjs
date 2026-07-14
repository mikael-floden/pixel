import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-frame-rate-limit", "--disable-gpu-vsync", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "wf-terracewall-z2");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__ml.timeOfDay("Day"));
await page.waitForTimeout(400);

await page.evaluate(() => window.__ml.lookAt(257, 216));
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/wf-terracewall-focus257-216.png` });

await page.keyboard.press("4");
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/wf-terracewall-focus257-216-collision.png` });
await page.keyboard.press("4");

await browser.close();
console.log("done");
