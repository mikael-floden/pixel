// EVERY WALL TOP OF MY ROOM WEARS HIS "Lowered wall top darkening" DIAL, AND
// THE FACE FADES INTO IT (maintainer 2026-09-18, the hearth house at
// 332.5,232.8: "that darkening is too sharp and would also benefit from a
// bigger darkening top rect/tile ... They should have a nicer fade and be a
// bit bigger"). The lowered walls' lids are painted darker (tiles3draw lid);
// the uncut back walls' tops were the room's own ambient, unlit by the hearth,
// a cold band over a warm face with a hard edge. The light now darkens every
// top above the cut by the dial and ramps the last storey of every face into it
// (nightlight.ts, uLidDark / LID_FADE_LEVELS).
//
// A/B on the dial: the same light-only render (calibration 5) at 0% and at 33%,
// indoors at Night with the torch off. What differs is exactly the tops and the
// fade band. Arms: (1) enough of the frame darkened; (2) the darkened tops sit
// at the dial's share (ratio ~0.67); (3) below each darkened top the ratio
// RAMPS back to 1 over several pixels — a fade, never a step.
// Needs the dev stack (npm run dev). PORT overrides vite's port.
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
const PORT = process.env.PORT || "5173";
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });

async function render(dialPct) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.addInitScript((v) => { try { localStorage.setItem("ml-wall-top-dark", String(v)); } catch {} }, dialPct);
  await page.goto(`http://localhost:${PORT}/#the_game`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 120000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__ml.noAggro?.(true));
  await page.evaluate(() => window.__ml.teleport(332.5, 232.8));
  await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 60000 });
  await page.waitForFunction(() => { const e = document.getElementById("ml-loading"); return !e || !e.isConnected || getComputedStyle(e).display === "none" || Number(getComputedStyle(e).opacity) === 0; }, null, { timeout: 90000 });
  for (let i = 0; i < 200; i++) { await page.waitForTimeout(2000); const st = await page.evaluate(() => window.__ml.indoor()); if (st.indoor && st.mix >= 0.999) break; }
  for (let a = 0; a < 6; a++) {
    await page.evaluate(() => window.__ml.timeSpeed(0)); await page.waitForTimeout(500);
    await page.evaluate(() => window.__ml.timeOfDay("Night", true)); await page.waitForTimeout(1200);
    const tod = await page.evaluate(() => window.__ml.timeOfDay()); if (tod && tod.name === "Night") break;
  }
  await page.evaluate(() => window.__ml.torch?.(false));
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.__ml.nightCal(0, 1, 5));
  await page.waitForTimeout(1500);
  const png = PNG.sync.read(await page.screenshot());
  const dial = await page.evaluate(() => window.__ml.sceneryLightInfo?.() ?? null);
  await ctx.close();
  return { png, dial };
}
const A = await render(0);
const B = await render(33);
await browser.close();
if (A.png.width !== B.png.width || A.png.height !== B.png.height) { fail("frames differ in size"); process.exit(); }
const W = A.png.width, H = A.png.height;
const luma = (png, x, y) => { const i = (y * W + x) * 4; return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]; };
// the game view is the top ~60% of the phone frame (the HUD below is identical in both)
const top = Math.floor(H * 0.1), bottom = Math.floor(H * 0.6);
const ratio = new Float32Array(W * H).fill(1);
let darkened = 0;
const ratios = [];
for (let y = top; y < bottom; y++) for (let x = 0; x < W; x++) {
  const a = luma(A.png, x, y);
  if (a < 40) continue;
  const r = luma(B.png, x, y) / a;
  ratio[y * W + x] = r;
  if (r < 0.8) { darkened++; ratios.push(r); }
}
ratios.sort((p, q) => p - q);
const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : NaN;
console.log(`darkened pixels (ratio < 0.8): ${darkened}; median ratio ${median.toFixed(3)} (dial 33% -> 0.67 expected)`);
if (darkened < 2000) fail(`too little of the room darkened by the dial: ${darkened} px`);
if (!(median > 0.6 && median < 0.75)) fail(`the darkened tops are not at the dial's share: median ratio ${median.toFixed(3)}`);
// THE FADE: under the lowest darkened pixel of a column, the ratio must climb back to ~1 over several pixels.
let cols = 0, ramped = 0;
const ramps = [];
for (let x = 0; x < W; x += 3) {
  let lowest = -1;
  for (let y = top; y < bottom; y++) if (ratio[y * W + x] < 0.72) lowest = y;
  if (lowest < 0) continue;
  // skip a column whose band ends at an unlit pixel (a silhouette edge, not a face)
  if (luma(A.png, x, lowest + 1) < 40) continue;
  let n = 0;
  for (let y = lowest + 1; y < bottom && ratio[y * W + x] < 0.95; y++) n++;
  cols++;
  ramps.push(n);
  if (n >= 4) ramped++;
}
ramps.sort((p, q) => p - q);
console.log(`columns with a darkened top over a lit face: ${cols}; ramp >= 4 px in ${ramped} (median ramp ${ramps.length ? ramps[Math.floor(ramps.length / 2)] : 0} px)`);
if (cols < 30) fail(`too few columns cross a darkened top: ${cols}`);
if (ramped < cols * 0.7) fail(`the face does not fade into the top: only ${ramped} of ${cols} columns ramp over 4+ px`);
console.log(process.exitCode ? "verify-walltop: FAIL" : "verify-walltop: OK");
