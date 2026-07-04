// Batch-capture the emission demo world: one cropped night screenshot per
// numbered station (plus a stations.json index). Used by the review sweep —
// agents Read the PNGs instead of driving a browser themselves.
// Usage: node scripts/demo-shots.mjs OUT_DIR [from] [to]
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.argv[2] || "/tmp/demo-shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto((process.env.PROBE_URL || "http://localhost:5173/") + "#emission", { waitUntil: "load" });
await page.waitForFunction(() => window.__ml?.demo === true && window.__ml.nightShader() === true, null, {
  timeout: 30000,
});
await page.waitForTimeout(2500);
const stations = await page.evaluate(() => window.__ml.stations());
writeFileSync(`${OUT}/stations.json`, JSON.stringify(stations, null, 1));
const from = Number(process.argv[3] ?? 1);
const to = Number(process.argv[4] ?? stations.length);
console.log(`stations ${stations.length}, capturing ${from}..${to} -> ${OUT}`);
for (const st of stations) {
  if (st.n < from || st.n > to) continue;
  await page.evaluate((n) => window.__ml.lookStation(n), st.n);
  await page.waitForTimeout(1400); // headless frame + stamp rebuild
  await page.screenshot({
    path: `${OUT}/station_${String(st.n).padStart(3, "0")}_${st.cat}_${String(st.v).padStart(2, "0")}.png`,
    clip: { x: 640 - 230, y: 400 - 190, width: 460, height: 380 },
  });
  if (st.n % 20 === 0) console.log(`  ${st.n}/${to}`);
}
await browser.close();
console.log("done");
