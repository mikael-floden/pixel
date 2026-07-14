import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";

const sites = [
  { name: "rim261-207", col: 261, row: 207 },
  { name: "rim250-232", col: 250, row: 232 },
  { name: "rim259-208", col: 259, row: 208 },
  { name: "gorge116-93", col: 116, row: 93 },
];

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox", "--disable-frame-rate-limit", "--disable-gpu-vsync", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "wf-terracewall-probe");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);

for (const tod of ["Night", "Day"]) {
  await page.evaluate((t) => window.__ml.timeOfDay(t), tod);
  await page.waitForTimeout(500);
  for (const s of sites) {
    await page.evaluate(({ col, row }) => window.__ml.lookAt(col, row), s);
    await page.waitForTimeout(900);
    const path = `${OUT}/wf-terracewall-${s.name}-${tod.toLowerCase()}.png`;
    await page.screenshot({ path });
    console.log("saved", path);
  }
}

await browser.close();
console.log("done");
