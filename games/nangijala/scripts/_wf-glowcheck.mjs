import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-frame-rate-limit", "--disable-gpu-vsync", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "wf-glowprobe-77");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);

await page.evaluate(() => window.__ml.timeOfDay("Night"));
await page.waitForTimeout(800);

// View 1: campfire area with pillars nearby
await page.evaluate(() => window.__ml.lookAt(260, 224));
await page.waitForTimeout(1200);
await page.screenshot({ path: OUT + "/wf-glowprobe-night-campfire.png" });

// View 2: across the crystal pillar at (263,226)
await page.evaluate(() => window.__ml.lookAt(262, 227));
await page.waitForTimeout(1200);
await page.screenshot({ path: OUT + "/wf-glowprobe-night-crystal.png" });

await browser.close();
console.log("done");
