import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import fs from "node:fs";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const DIR = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const W = 1000, H = 760;
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
let errs = 0;
page.on("pageerror", (e) => { errs++; console.log("[pageerror]", e.message.slice(0, 160)); });
await page.goto("http://localhost:2567", { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 20000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.myX() !== undefined, null, { timeout: 20000 });
await page.waitForTimeout(2500);
// Numeric: the avatar's HEAD region must be bright-ish (its ground light),
// not the dark backdrop — sample around screen centre-up where the head is.
const shot = `${DIR}/mask_smoke.png`;
await page.screenshot({ path: shot });
const png = PNG.sync.read(fs.readFileSync(shot));
const patch = (sx, sy) => { let s = 0, n = 0; for (let dy = -4; dy <= 4; dy += 2) for (let dx = -4; dx <= 4; dx += 2) { const i = ((sy + dy) * W + sx + dx) * 4; s += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3; n++; } return Math.round(s / n); };
console.log(JSON.stringify({ pageErrors: errs, shader: await page.evaluate(() => window.__ml.nightShader()), headArea: patch(W >> 1, (H >> 1) - 25), feetArea: patch(W >> 1, (H >> 1) + 42) }));
await browser.close();
