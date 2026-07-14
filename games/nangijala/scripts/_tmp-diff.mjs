import { PNG } from "pngjs";
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox","--disable-frame-rate-limit","--disable-gpu-vsync","--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
await page.goto("http://localhost:5173/#emission", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "diffprobe"); await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 30000 });
await page.waitForTimeout(2500);
await page.keyboard.press("6"); // douse bonfire (its own flicker would confound)
await page.evaluate(() => window.__ml.lookAt(249, 220));
await page.waitForTimeout(1500);
const a = PNG.sync.read(await page.screenshot());
await page.waitForTimeout(3500); // let slow waves move
const b = PNG.sync.read(await page.screenshot());
let moved = 0, sum = 0;
for (let i = 0; i < a.data.length; i += 4) {
  const d = Math.abs(a.data[i]-b.data[i]) + Math.abs(a.data[i+1]-b.data[i+1]) + Math.abs(a.data[i+2]-b.data[i+2]);
  if (d > 12) moved++;
  sum += d;
}
console.log(`${process.env.LABEL}: moved-pixels ${moved}, total-delta ${sum}`);
await browser.close();
