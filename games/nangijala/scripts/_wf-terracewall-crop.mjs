import { chromium } from "playwright-core";
import { readFileSync } from "fs";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";

const crops = [
  { src: "wf-terracewall-rim261-207-day.png", name: "crop-slivers", x: 210, y: 430, w: 220, h: 200, s: 3 },
  { src: "wf-terracewall-rim261-207-day.png", name: "crop-treecol", x: 790, y: 70, w: 200, h: 300, s: 2 },
  { src: "wf-terracewall-rim250-232-day.png", name: "crop-tallwall", x: 230, y: 50, w: 230, h: 260, s: 2 },
  { src: "wf-terracewall-rim250-232-day.png", name: "crop-seam1141", x: 1090, y: 360, w: 110, h: 160, s: 3 },
  { src: "wf-terracewall-rim250-232-day.png", name: "crop-seam633", x: 590, y: 380, w: 110, h: 160, s: 3 },
  { src: "wf-terracewall-gorge116-93-day.png", name: "crop-gorge-line", x: 390, y: 80, w: 140, h: 360, s: 2 },
  { src: "wf-terracewall-gorge116-93-day.png", name: "crop-gorge-wall", x: 620, y: 540, w: 300, h: 300, s: 2 },
  { src: "wf-terracewall-gorge116-93-day.png", name: "crop-gorge-grey", x: 880, y: 120, w: 180, h: 220, s: 2 },
  { src: "wf-terracewall-rim259-208-day.png", name: "crop-slivers2", x: 420, y: 540, w: 180, h: 140, s: 3 },
];

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--disable-gpu-vsync", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });

for (const c of crops) {
  const b64 = readFileSync(`${OUT}/${c.src}`).toString("base64");
  await page.setContent(`<canvas id=cv width=${c.w * c.s} height=${c.h * c.s} style="display:block"></canvas>`);
  await page.evaluate(async ({ b64, c }) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.getElementById("cv");
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, c.w * c.s, c.h * c.s);
  }, { b64, c });
  const el = await page.$("#cv");
  await el.screenshot({ path: `${OUT}/wf-terracewall-${c.name}.png` });
  console.log("saved", c.name);
}
await browser.close();
