// Tall-world heightmap gate (dev-stack browser, like verify-depthfog): the
// surface/occlusion heightmaps pack a cell's LEVEL into ONE 8-bit channel. The
// historical scale (level*16) SATURATES at 255/16 = 15.9 levels, so a world
// taller than that (the_island2 peaks at 32) clamped every high cell to a
// phantom ~16-level ceiling — the depth-fog's surface resolve then read a bogus
// low `z` while the player's own z was the true peak, a big mismatch that
// painted the WHOLE flat top with a hard jagged fog seam at the player's feet.
// buildHeightmap now picks a per-world pack scale so the tallest cell fits
// (worlds ≤15 keep the exact *16 bytes). This gate stands the player on the
// world's broadest HIGH flat-top (found from world.json, so it survives the
// maps agent regenerating the world) via the __ml.teleport debug tool, and
// asserts the flat ground BESIDE them is NOT fogged — if the saturation
// regresses, that same-level ground floods teal again.
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { readFileSync } from "fs";

const WORLD = "the_island2";
const w = JSON.parse(readFileSync(new URL(`../../maps2/worlds/${WORLD}/world.json`, import.meta.url)));
const L = w.level, W = w.size.w, H = w.size.h;
// Broadest 7x7 flat-top = a cell whose whole neighbourhood sits at one high
// level, so a screen patch beside the standing player is guaranteed same-level.
const R = 3;
let best = { minL: -1, c: 0, r: 0 };
for (let r = R; r < H - R; r++)
  for (let c = R; c < W - R; c++) {
    let mn = 99;
    for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) mn = Math.min(mn, L[r + dr]?.[c + dc] ?? 0);
    if (mn > best.minL) best = { minL: mn, c, r };
  }
console.log(`${WORLD}: broadest flat-top level=${best.minL} at (col,row)=(${best.c},${best.r})`);
if (best.minL <= 15) {
  console.log(`verify-heightscale: SKIP — ${WORLD}'s tallest flat-top is level ${best.minL} (≤15), below the 8-bit saturation point; nothing to exercise.`);
  process.exit(0);
}

const browser = await chromium.launch({ executablePath: EXE_PATH(), args: ["--no-sandbox"] });
function EXE_PATH() { return "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"; }
const page = await browser.newPage({ viewport: { width: 620, height: 1050 } });
await page.addInitScript((world) => {
  localStorage.setItem("ml-last-choice", JSON.stringify({ world, characterUid: "default_boy", name: "df" }));
  sessionStorage.setItem("ml-rejoin", "1");
}, WORLD);
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__ml && window.__ml.players?.() >= 1, null, { timeout: 30000 });
await page.waitForTimeout(9000);
await page.evaluate(() => window.__ml.timeOfDay("Day"));
await page.evaluate(([c, r]) => window.__ml.teleport(c + 0.5, r + 0.5), [best.c, best.r]);
await page.waitForTimeout(2500);
const info = await page.evaluate(() => window.__ml.depthFog());
if (Math.round(info.playerZ) < best.minL - 1) {
  console.log(`FAIL: teleport landed at playerZ=${info.playerZ}, expected ~${best.minL} (the flat-top) — teleport tool broken?`);
  await browser.close();
  process.exit(1);
}

// Mean teal-add over two strips BRACKETING the avatar sprite (which sits at
// screen centre): both are the same-level flat-top → must stay CLEAR. Skips the
// sprite + its name/coord HUD in the middle column.
const tealAdd = (on, off) => {
  const a = PNG.sync.read(on), b = PNG.sync.read(off);
  const boxes = [[150, 265, 250, 400], [355, 470, 250, 400]]; // [x0,x1,y0,y1] left+right of sprite
  let sum = 0, n = 0;
  for (const [x0, x1, y0, y1] of boxes)
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * a.width + x) * 4;
        sum += (a.data[i + 1] - b.data[i + 1] + a.data[i + 2] - b.data[i + 2]) / 2 - (a.data[i] - b.data[i]);
        n++;
      }
  return sum / n;
};

await page.evaluate(() => window.__ml.depthFog(1)); // ON
await page.waitForTimeout(400);
const on = await page.screenshot();
await page.evaluate(() => window.__ml.depthFog(0)); // OFF
await page.waitForTimeout(400);
const off = await page.screenshot();
await browser.close();

const add = tealAdd(on, off);
console.log(`heightscale: playerZ=${info.playerZ} flat-top-beside-player fog-add teal=${add.toFixed(2)} (broken ≈ +30, fixed ≈ 0)`);
if (add > 12) {
  console.log(`FAIL: the flat level-${best.minL} top beside the player is fogged (teal +${add.toFixed(2)} > 12) — heightmap likely saturating again (the level*16 8-bit overflow); the fog paints a phantom seam on tall peaks.`);
  process.exit(1);
}
console.log(`verify-heightscale: OK — tall-world (level ${best.minL}) flat-top reads its true height; no phantom depth-fog on the player's own level.`);
