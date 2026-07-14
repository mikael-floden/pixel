import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const spots = [
  ["volcano", 453, 386],
  ["crystalplateau", 316, 106],
  ["spires", 423, 153],
  ["mushroomgrove", 330, 249],
  ["forest", 280, 260],
];
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-frame-rate-limit", "--disable-gpu-vsync", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "wf-regsweep-probe");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__ml.timeOfDay("Day"));
await page.waitForTimeout(500);
for (const [name, col, row] of spots) {
  await page.evaluate(([c, r]) => window.__ml.lookAt(c, r), [col, row]);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/wf-regsweep-${name}.png` });
  console.log("shot", name);
}
await browser.close();
console.log("done");
