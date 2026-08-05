// Which layer owns the sharp edge at a ledge: the LIGHT FIELD (pattern 5)
// or the ART underneath (composite = art x field)? Measures the same
// scanlines in both modes and compares sharpness.
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const W = 64, TOP = 8, MID = 21, BOT = 34, LH = 19;
const aLip = (x) => BOT - (Math.abs(x + 0.5 - W / 2) / (W / 2)) * (BOT - MID);

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 2400, height: 1300 } });
await page.goto(process.env.PROBE_URL || "http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "edgeprobe");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);

const scan = () =>
  page.evaluate(() => {
    const me = window.__ml.me();
    const col0 = Math.floor(me.x / 32), row0 = Math.floor(me.y / 32);
    const out = [];
    for (let row = row0 - 22; row < row0 + 22; row++)
      for (let col = col0 - 20; col < col0 + 20; col++) {
        const c = window.__ml.cellScreen(col, row);
        const fr = window.__ml.cellScreen(col + 1, row);
        const fd = window.__ml.cellScreen(col, row + 1);
        if (!c || !fr || !fd) continue;
        if (fr.level >= c.level && fd.level >= c.level) continue;
        if (c.x < 40 || c.x > 2260 || c.y < 100 || c.y > 1140) continue;
        out.push({ ...c, col, row });
      }
    return out;
  });
let cand = await scan();
for (let t = 0; !cand.length && t < 6; t++) { await page.waitForTimeout(1200); cand = await scan(); }
if (!cand.length) throw new Error("no ledges on screen");
const L = cand.find((c) => c.col >= 250 && c.col <= 253 && c.row >= 228 && c.row <= 235) ?? cand[0];
await page.evaluate(({ col, row }) => {
  const z = window.__ml.levelAt((col + 2) * 32, (row + 2) * 32) + 0.55;
  return window.__ml.probeLight(col + 2.0, row + 2.0, z, 8);
}, { col: L.col, row: L.row });
console.log(`ledge (${L.col},${L.row}) ${L.t} l${L.level}`);

async function grab(test) {
  await page.evaluate((t) => window.__ml.nightCal(0, 1, t), test);
  await page.waitForTimeout(400);
  return PNG.sync.read(await page.screenshot());
}
function profile(shot, c, x) {
  const dpr = shot.width / 2400;
  const lum = (px, py) => {
    const i = (Math.round(py) * shot.width + Math.round(px)) * 4;
    return 0.299 * shot.data[i] + 0.587 * shot.data[i + 1] + 0.114 * shot.data[i + 2];
  };
  const sx = (c.x + (x + 0.5) * c.zoom) * dpr;
  const yB = (c.y + (aLip(x) + LH) * c.zoom) * dpr;
  const span = Math.round(14 * c.zoom * dpr);
  const prof = [];
  for (let dy = -span; dy <= span; dy++) prof.push(lum(sx, yB + dy));
  const total = Math.abs(prof[prof.length - 1] - prof[0]);
  let maxStep = 0;
  for (let k = 1; k < prof.length; k++) maxStep = Math.max(maxStep, Math.abs(prof[k] - prof[k - 1]));
  return { total: +total.toFixed(1), maxStep: +maxStep.toFixed(1), prof: prof.map((v) => Math.round(v)) };
}

const field = await grab(5); // raw light field
const comp = await grab(0);  // normal composite (art x field)
// Also grab surrounding cells of the ledge line for a fuller picture.
const cells = cand.filter((c) => Math.abs(c.col - L.col) <= 2 && Math.abs(c.row - L.row) <= 5);
for (const c of cells.slice(0, 4)) {
  for (const x of [16, 32, 48]) {
    const f = profile(field, c, x);
    const m = profile(comp, c, x);
    if (m.maxStep < 10 && f.maxStep < 10) continue;
    console.log(`cell(${c.col},${c.row}) x=${x}: FIELD maxStep ${f.maxStep} (total ${f.total}) | COMPOSITE maxStep ${m.maxStep} (total ${m.total})`);
    console.log(`  field:     ${f.prof.join(",")}`);
    console.log(`  composite: ${m.prof.join(",")}`);
  }
}
await browser.close();
