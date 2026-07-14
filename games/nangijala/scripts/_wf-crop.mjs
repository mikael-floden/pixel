import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
// name, sourcefile, x, y, w, h  (crop then scale 2x)
const crops = [
  ["forest-ledge", "wf-regsweep-forest.png", 600, 100, 350, 250],
  ["cp-lines", "wf-regsweep-crystalplateau.png", 480, 0, 420, 460],
  ["mg-hexoutline", "wf-regsweep-mushroomgrove.png", 100, 330, 300, 180],
  ["volcano-star", "wf-regsweep-volcano.png", 150, 100, 400, 280],
];
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-gpu-vsync", "--enable-unsafe-swiftshader"] });
for (const [name, src, x, y, w, h] of crops) {
  const b64 = readFileSync(`${OUT}/${src}`).toString("base64");
  const page = await browser.newPage({ viewport: { width: w * 2, height: h * 2 } });
  await page.setContent(`<body style="margin:0;overflow:hidden"><img style="position:absolute;left:${-x * 2}px;top:${-y * 2}px;width:2800px;image-rendering:pixelated" src="data:image/png;base64,${b64}"></body>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/wf-regsweep-crop-${name}.png` });
  await page.close();
  console.log("crop", name);
}
await browser.close();
