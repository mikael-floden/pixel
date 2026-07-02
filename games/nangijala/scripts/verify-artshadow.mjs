// Round-trip check of art-shaped shadows: test pattern 6 paints the shader's
// per-pixel ART WEIGHT on faces. Sampled values at a real ledge must equal
// the baked atlas values at the same tile-local coordinates — proving the
// slot map, atlas addressing and stamp-local (tx,ty) mapping are all exact.
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const idx = JSON.parse(readFileSync("client/public/tile-shadows.json", "utf8"));
const atlas = PNG.sync.read(readFileSync("client/public/tile-shadows.png"));
const bakedW = (slot, x, y) => {
  const ox = (slot % idx.cols) * 64, oy = Math.floor(slot / idx.cols) * 64;
  return atlas.data[((oy + y) * atlas.width + ox + x) * 4] / 255;
};

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 2400, height: 1300 } });
await page.goto(process.env.PROBE_URL || "http://localhost:5173/", { waitUntil: "load" });
await page.waitForSelector("input", { timeout: 20000 });
await page.fill("input", "artprobe");
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
        out.push({ ...c, col, row, frLower: fr.level < c.level });
      }
    return out;
  });
let cand = await scan();
for (let t = 0; !cand.length && t < 6; t++) { await page.waitForTimeout(1200); cand = await scan(); }
const L = cand.find((c) => idx.index[`${c.t}/${c.v}`] !== undefined);
if (!L) throw new Error("no ledge with a baked atlas slot on screen");
const slot = idx.index[`${L.t}/${L.v}`];
console.log(`ledge (${L.col},${L.row}) ${L.t}/${L.v} l${L.level} slot ${slot}`);

await page.evaluate(() => window.__ml.nightCal(0, 1, 6));
await page.waitForTimeout(400);
const shot = PNG.sync.read(await page.screenshot());
const dpr = shot.width / 2400;

// Pattern 6 emits the shader's OWN (tx, ty) in G/B alongside the weight in
// R. Three self-consistent checks per sample, no screen-alignment guessing:
//  1. tx tracks the sampled art column (+-1.5px),
//  2. ty lies in the face band (rows ~lip..53),
//  3. R equals the baked atlas value AT the shader's (tx, ty) (+-0.06).
const cols = L.frLower ? [38, 42, 46, 50] : [14, 18, 22, 26];
let tested = 0, passed = 0;
for (const x of cols) {
  for (const y of [40, 44, 48]) {
    const sx = Math.round((L.x + (x + 0.5) * L.zoom) * dpr);
    const sy = Math.round((L.y + (y + 0.5) * L.zoom) * dpr);
    const i = (sy * shot.width + sx) * 4;
    const r = shot.data[i] / 255, g = shot.data[i + 1] / 255, bl = shot.data[i + 2] / 255;
    if (r < 0.05 && g > 0.2 && bl < 0.05) continue; // non-face marker
    const tx = g * 64, ty = bl * 64;
    // The debug channels are 8-bit (1 unit = 0.25px): at sharp atlas
    // transitions the decoded coord can round across a texel edge, so accept
    // the best match within the 2x2 neighbourhood.
    let w = 9;
    for (const bx of [Math.floor(tx), Math.ceil(tx)])
      for (const by of [Math.floor(ty), Math.ceil(ty)]) {
        const v = bakedW(slot, Math.max(0, Math.min(63, bx)), Math.max(0, Math.min(63, by)));
        if (Math.abs(r - v) < Math.abs(r - w)) w = v;
      }
    const okX = Math.abs(tx - (x + 0.5)) <= 1.5;
    const okY = Math.abs(ty - (y + 0.5)) <= 1.6;
    const okW = Math.abs(r - w) <= 0.06;
    const ok = okX && okY && okW;
    console.log(
      `  screen(${x},${y}): shader tx ${tx.toFixed(1)} ty ${ty.toFixed(1)} w ${r.toFixed(2)} | baked@(tx,ty) ${w.toFixed(2)} ${ok ? "OK" : `FAIL${okX ? "" : " x"}${okY ? "" : " y"}${okW ? "" : " w"}`}`,
    );
    tested++;
    if (ok) passed++;
  }
}
console.log(`art-shadow round-trip: ${passed}/${tested}`);
await browser.close();
process.exit(tested >= 4 && passed === tested ? 0 : 1);
