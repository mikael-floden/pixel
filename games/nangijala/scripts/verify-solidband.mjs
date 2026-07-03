// Acceptance test for the phantom-block fix: solid-object cells (trees,
// boulders) must NOT produce Lambert-gated wall-face bands. At a solid cell
// under a LATERAL light (which used to gate the band to near-black):
//   1. pattern 4: the analytic band pixels classify as GROUND (green), not face;
//   2. pattern 5: no near-black (lum < 45) on that band while same-row ground
//      is lit, and no 1px luminance knife across the old band edge.
// The cast shadow (soft, bounce-floored) is allowed — only the knife band dies.
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const W = 64, MID = 21, BOT = 34;
const aLip = (x) => BOT - (Math.abs(x + 0.5 - W / 2) / (W / 2)) * (BOT - MID);

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 2400, height: 1300 } });
await page.goto(process.env.PROBE_URL || "http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "solidprobe");
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 20000 });
await page.waitForTimeout(1500);

// Find an on-screen SOLID cell (tree/boulder: not standable, not swimmable).
const scan = () =>
  page.evaluate(() => {
    const me = window.__ml.me();
    const col0 = Math.floor(me.x / 32), row0 = Math.floor(me.y / 32);
    const out = [];
    for (let row = row0 - 20; row < row0 + 20; row++)
      for (let col = col0 - 18; col < col0 + 18; col++) {
        const s = window.__ml.surfaceAt(col * 32 + 16, row * 32 + 16);
        if (!s || s.standable || s.swimmable) continue;
        const c = window.__ml.cellScreen(col, row);
        if (!c || c.x < 150 || c.x > 2100 || c.y < 150 || c.y > 1050) continue;
        out.push({ ...c, col, row });
      }
    return out;
  });
let cand = await scan();
for (let t = 0; !cand.length && t < 6; t++) { await page.waitForTimeout(1200); cand = await scan(); }
if (!cand.length) throw new Error("no solid-object cell on screen");
const L = cand[0];
console.log(`solid cell (${L.col},${L.row}) ${L.t}/${L.v} l${L.level}`);

// Lateral light: behind the +row face plane -> the OLD phantom band gated to
// near-black exactly here.
await page.evaluate(({ col, row }) => {
  const z = window.__ml.levelAt((col + 0.5) * 32, (row - 3) * 32) + 0.55;
  window.__ml.probeLight(col + 0.5, row - 3.0, z, 9);
}, { col: L.col, row: L.row });

async function grab(test) {
  await page.evaluate((t) => window.__ml.nightCal(0, 1, t), test);
  await page.waitForTimeout(400);
  return PNG.sync.read(await page.screenshot());
}
const class4 = await grab(4);
const field5 = await grab(5);
const dpr = class4.width / 2400;
const at = (shot, ax, ay) => {
  const sx = Math.round((L.x + (ax + 0.5) * L.zoom) * dpr);
  const sy = Math.round((L.y + (ay + 0.5) * L.zoom) * dpr);
  const i = (sy * shot.width + sx) * 4;
  return [shot.data[i], shot.data[i + 1], shot.data[i + 2]];
};
const lum = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

// The phantom l+1 band lives at art rows [aLip(x)-19, aLip(x)] of the cell.
let faceHits = 0, darkHits = 0, checked = 0;
for (const x of [4, 16, 32, 48, 60]) {
  for (const dy of [-14, -8, -3]) {
    const y = aLip(x) + dy;
    const c = at(class4, x, y);
    const isFace = c[0] > 150 && c[1] < 100;
    const l5 = lum(at(field5, x, y));
    checked++;
    if (isFace) faceHits++;
    if (l5 < 45) darkHits++;
    console.log(`  (${x},${Math.round(y)}): class ${isFace ? "FACE" : "ground"}, field lum ${l5.toFixed(0)}`);
  }
}
// Knife check: vertical field profile through the old band top edge.
let maxStep = 0, total = 0;
{
  const prof = [];
  for (let y = aLip(32) - 26; y <= aLip(32) + 6; y++) prof.push(lum(at(field5, 32, y)));
  total = Math.abs(prof[prof.length - 1] - prof[0]);
  for (let k = 1; k < prof.length; k++) maxStep = Math.max(maxStep, Math.abs(prof[k] - prof[k - 1]));
  console.log(`  centre profile: total ${total.toFixed(0)}, maxStep ${maxStep.toFixed(0)}`);
}
const knife = total > 20 && maxStep > 0.5 * total;
console.log(
  `solid-band: ${faceHits}/${checked} face-classified (want 0), ${darkHits}/${checked} near-black (want 0), knife: ${knife}`,
);
await browser.close();
process.exit(faceHits === 0 && darkHits === 0 && !knife ? 0 : 1);
