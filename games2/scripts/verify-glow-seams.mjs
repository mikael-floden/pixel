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
// glow_test: maps2's emissive showcase (successor of the retired tiles/
// emission demo) — every glowing tiles2 material as world props.
await page.goto(process.env.PROBE_URL || "http://localhost:5173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, { timeout: 20000 });
await page.evaluate(() => {
  const i = window.__mlSelect.worlds().findIndex((w) => /glow/i.test(w));
  if (i >= 0) window.__mlSelect.pickWorld(i);
  window.__mlSelect.commit();
});
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 30000 });
await page.waitForTimeout(2500);
// Frame a dense emissive area: the middle of the world.
await page.evaluate(() => {
  const w = window.__ml.worldInfo();
  window.__ml.lookAt(Math.floor((w.w ?? 64) / 2), Math.floor((w.h ?? 64) / 2));
});
await page.waitForTimeout(1500);
await page.evaluate(() => window.__ml.nightCal(0, 1, 5)); // raw field, opaque
await page.waitForTimeout(1200);
const shot = PNG.sync.read(await page.screenshot());
const lum = (x, y) => {
  const i = (y * shot.width + x) * 4;
  return shot.data[i] * 0.4 + shot.data[i + 1] * 0.4 + shot.data[i + 2] * 0.2;
};
// A seam = a LONG straight run of strong same-direction luminance steps at
// a fixed x (vertical) or fixed y (horizontal) in the field. Horizontal
// threshold 170px: legitimate halo clamp boundaries stay under ~130px; the
// broken-blend quad edges ran 200-360px. VERTICAL legit edges got taller:
// cliff/wall stations are analytic COLUMNS in the demo's shader world (up
// to 8 levels), whose per-cell emission floor ends in a straight vertical
// edge of (8*19+26)*zoom ≈ 356px — so the vertical threshold sits above
// that. A blend regression still trips the horizontal scan (quad artifacts
// have all four edges).
const RUN = 170;
const RUN_V = 380;
let vSeams = 0;
for (let x = 200; x < 1400; x++) {
  let run = 0, worst = 0;
  for (let y = 120; y < 800; y++) {
    const d = lum(x + 2, y) - lum(x - 2, y);
    if (Math.abs(d) > 22) run++;
    else run = 0;
    if (run > worst) worst = run;
  }
  if (worst >= RUN_V) vSeams++;
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
console.log(`raw-field straight seams (v>=${RUN_V}/h>=${RUN}px): vertical ${vSeams}, horizontal ${hSeams} (want 0/0)`);
await browser.close();
process.exit(vSeams + hSeams === 0 ? 0 : 1);
