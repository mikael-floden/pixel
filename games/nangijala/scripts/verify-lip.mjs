// Numeric check of art-aware shadows (stage B2): with test pattern 4 the
// shader paints its FINAL surface classification (face RED / top GREEN).
// For a real ledge cell near spawn, the red/green boundary in a screenshot
// must sit at analyticLip + bakedLip per art column — no eyeballing.
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const W = 64, TOP = 8, MID = 21, BOT = 34;
const analyticLip = (x) => BOT - (Math.abs(x + 0.5 - W / 2) / (W / 2)) * (BOT - MID);

const prof = JSON.parse(readFileSync("client/public/tile-profiles.json", "utf8"));
const profPng = PNG.sync.read(readFileSync("client/public/tile-profiles.png"));
const lipOf = (key, x) => {
  const row = prof.index[key];
  return row === undefined ? 0 : profPng.data[(row * 64 + x) * 4] - prof.clamp;
};

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(process.env.PROBE_URL || "http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "lipprobe");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1200); // let ground + occluders settle

// Find on-screen ledge cells whose tile has a non-zero baked lip and whose
// BOTH front neighbours are lower (a clean protruding corner: full V exposed).
const cand = await page.evaluate(() => {
  const me = window.__ml.me();
  const col0 = Math.floor(me.x / 32), row0 = Math.floor(me.y / 32);
  const out = [];
  for (let row = row0 - 16; row < row0 + 16; row++)
    for (let col = col0 - 14; col < col0 + 14; col++) {
      const c = window.__ml.cellScreen(col, row);
      const fr = window.__ml.cellScreen(col + 1, row);
      const fd = window.__ml.cellScreen(col, row + 1);
      if (!c || !fr || !fd) continue;
      if (fr.level >= c.level || fd.level >= c.level) continue; // no drop in front
      if (c.x < 40 || c.x > 1140 || c.y < 70 || c.y > 580) continue; // off-screen
      out.push({ ...c, col, row, both: fr.level < c.level && fd.level < c.level });
    }
  return out;
});
const usable = cand.filter((c) => {
  const key = `${c.t}/${c.v}`;
  return prof.index[key] !== undefined && [16, 24, 32, 40, 48].some((x) => lipOf(key, x) !== 0);
});
// A protruding corner (both faces exposed) gives the cleanest V to probe.
const picks = [...usable.filter((c) => c.both), ...usable];
if (!picks.length) throw new Error(`no profiled ledge on screen (${cand.length} ledges seen)`);
const cell = picks[0];
console.log("probing ledge:", JSON.stringify(cell));

await page.evaluate(() => window.__ml.nightCal(0, 1, 4));
await page.waitForTimeout(400);
const shotBuf = await page.screenshot();
const shot = PNG.sync.read(shotBuf);

// Device pixel ratio guard: screenshot px per page px.
const dpr = shot.width / 1280;
const key = `${cell.t}/${cell.v}`;
let pass = 0, fail = 0;
for (const x of [12, 20, 28, 36, 44, 52]) {
  const expected = analyticLip(x) + lipOf(key, x); // art px from tile top
  const sx = Math.round((cell.x + (x + 0.5) * cell.zoom) * dpr);
  // Scan down the tile's art column for the top->face (green->red) flip.
  let boundary = null;
  const y0 = Math.round((cell.y + 6 * cell.zoom) * dpr);
  const y1 = Math.round((cell.y + 52 * cell.zoom) * dpr);
  for (let sy = y0; sy < y1; sy++) {
    const i = (sy * shot.width + sx) * 4;
    const red = shot.data[i] > 150 && shot.data[i + 1] < 100;
    const iPrev = ((sy - 1) * shot.width + sx) * 4;
    const greenPrev = shot.data[iPrev + 1] > 150 && shot.data[iPrev] < 100;
    if (red && greenPrev) { boundary = (sy / dpr - cell.y) / cell.zoom; break; }
  }
  const lip = lipOf(key, x);
  if (boundary === null) {
    console.log(`  x=${x}: no green->red flip found (lip ${lip})`);
    fail++;
    continue;
  }
  const err = boundary - expected;
  const ok = Math.abs(err) <= 2.0;
  console.log(
    `  x=${x}: boundary ${boundary.toFixed(1)}px, analytic ${analyticLip(x).toFixed(1)} + lip ${lip} = ${expected.toFixed(1)} -> err ${err.toFixed(1)}px ${ok ? "OK" : "FAIL"}`,
  );
  ok ? pass++ : fail++;
}
console.log(`lip probe: ${pass} ok, ${fail} fail`);
await browser.close();
process.exit(fail === 0 && pass > 0 ? 0 : 1);
