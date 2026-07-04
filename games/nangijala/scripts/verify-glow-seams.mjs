// Glow-field seam check, on the RAW LIGHT FIELD (pattern 5) — the composite
// hides field artifacts under art texture, which let a broken blend slip
// through once. Halos are radial: the field must contain NO long straight
// vertical/horizontal edges. (Phaser's built-in ADD blend is (ONE, DST_ALPHA),
// which on a render texture made every stamp REPLACE the glow beneath its
// quad — hard black rectangles; the stamps now use a custom (ONE, ONE) blend.)
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto((process.env.PROBE_URL || "http://localhost:5173/") + "#emission", { waitUntil: "load" });
await page.waitForFunction(() => window.__ml?.demo === true && window.__ml.nightShader() === true, null, {
  timeout: 30000,
});
await page.waitForTimeout(2500);
const st = await page.evaluate(() =>
  window.__ml.stations().find((s) => s.cat === "cliff_gold_v2" && s.v === 5),
);
await page.evaluate((n) => window.__ml.lookStation(n), st.n);
await page.waitForTimeout(1500);
await page.evaluate(() => window.__ml.nightCal(0, 1, 5)); // raw field, opaque
await page.waitForTimeout(1200);
const shot = PNG.sync.read(await page.screenshot());
const lum = (x, y) => {
  const i = (y * shot.width + x) * 4;
  return shot.data[i] * 0.4 + shot.data[i + 1] * 0.4 + shot.data[i + 2] * 0.2;
};
// A seam = a LONG straight run of strong same-direction luminance steps at
// a fixed x (vertical) or fixed y (horizontal) in the field. Threshold 130px:
// legitimate wall-face floor bands end in vertical edges up to ~2 levels
// (76px at zoom 2) and big saturated halos have flat-ish clamp boundaries
// up to ~130px; the broken-blend quad edges ran 200-360px.
const RUN = 170;
let vSeams = 0;
for (let x = 200; x < 1400; x++) {
  let run = 0, worst = 0;
  for (let y = 120; y < 800; y++) {
    const d = lum(x + 2, y) - lum(x - 2, y);
    if (Math.abs(d) > 22) run++;
    else run = 0;
    if (run > worst) worst = run;
  }
  if (worst >= RUN) vSeams++;
}
let hSeams = 0;
for (let y = 120; y < 800; y++) {
  let run = 0, worst = 0;
  for (let x = 200; x < 1400; x++) {
    const d = lum(x, y + 2) - lum(x, y - 2);
    if (Math.abs(d) > 22) run++;
    else run = 0;
    if (run > worst) worst = run;
  }
  if (worst >= RUN) hSeams++;
}
console.log(`raw-field straight seams (run>=${RUN}px): vertical ${vSeams}, horizontal ${hSeams} (want 0/0)`);
await browser.close();
process.exit(vSeams + hSeams === 0 ? 0 : 1);
