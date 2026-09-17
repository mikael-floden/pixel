// A CAST SHADOW DOES NOT END AT THE LIGHT'S OWN HEIGHT (docs/lighting.md).
// The point-light LOS march used to be skipped for every surface ABOVE the
// light (the billboard rule, from before bodies had lit copies of their own),
// so a wall standing in the shadow of a corner column was dark below the
// brazier's flame and lit above it — one hard line across the face at exactly
// z = light.z, the torch's line one storey lower (maintainer 2026-09-17, the
// ice cave at 208.4,205.1, drawn in red). Two arms at his spot, his screen:
//  A. the SHADER: calibration 5 (the raw light field, opaque) sampled down the
//     two wall faces he marked — no adjacent-row step over STEP_MAX of the
//     column's peak (the old code stepped ~45%);
//  B. the CPU TWIN (`__ml.occAt`): the brazier's occlusion up the left wall's
//     column is continuous through the light's height (the old code jumped
//     0.22 → 1.0 at z 5.5).
// Needs the dev stack (npm run dev). PORT overrides vite's port.
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
const PORT = process.env.PORT || "5173";
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const STEP_MAX = 0.12;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
// His exact screen: 393x851 css at dpr 2.75 (the dpr sets renderScale and the zoom).
const page = await (await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, serviceWorkers: "block" })).newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`http://localhost:${PORT}/#the_game`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 60000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 90000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.__ml.noAggro?.(true));
await page.evaluate(() => window.__ml.teleport(208.4, 205.1));
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 60000 });
await page.waitForFunction(() => { const e = document.getElementById("ml-loading"); return !e || !e.isConnected || getComputedStyle(e).display === "none" || Number(getComputedStyle(e).opacity) === 0; }, null, { timeout: 90000 });
await page.waitForTimeout(3000);
await page.evaluate(() => window.__ml.timeSpeed(0)); // a hop re-syncs the shared clock: pin first
await page.waitForTimeout(500);
await page.evaluate(() => window.__ml.timeOfDay("Evening", true));
await page.evaluate(() => window.__ml.torch?.(true));
await page.waitForTimeout(4000);
// The scenery lights join the ledger after the art streams in: wait for the brazier.
await page.waitForFunction(() => (window.__ml.lights() || []).some((l) => Math.abs(l.col - 207.82) < 0.2 && Math.abs(l.row - 205.84) < 0.2), null, { timeout: 60000 }).catch(() => {});
const lights = await page.evaluate(() => window.__ml.lights());
const bi = lights.findIndex((l) => Math.abs(l.col - 207.82) < 0.2 && Math.abs(l.row - 205.84) < 0.2);
if (bi < 0) fail(`the brazier is not in the light ledger: ${JSON.stringify(lights)}`);
const bz = lights[bi]?.z ?? 5.5;

// A. the shader's light field down the two faces he marked (device px).
await page.evaluate(() => window.__ml.nightCal(0, 1, 5));
await page.waitForTimeout(800);
const png = PNG.sync.read(await page.screenshot());
const luma = (x, y) => { const i = (y * png.width + x) * 4; return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]; };
for (const [name, x, y0, y1] of [["left wall (205,207 +col face)", 110, 560, 672], ["right wall (208,203 +row face)", 680, 520, 670]]) {
  const col = []; for (let y = y0; y <= y1; y += 8) col.push(luma(x, y));
  const peak = Math.max(...col);
  let worst = 0, at = -1;
  for (let k = 1; k < col.length; k++) { const d = Math.abs(col[k] - col[k - 1]) / peak; if (d > worst) { worst = d; at = y0 + k * 8; } }
  console.log(`${name}: light field ${col.map((v) => v.toFixed(0)).join(" ")} — worst adjacent step ${(worst * 100).toFixed(0)}% of peak at y=${at}`);
  if (worst > STEP_MAX) fail(`${name}: a ${(worst * 100).toFixed(0)}% step in the light field at y=${at} — the shadow ends at the light's height`);
}
await page.evaluate(() => window.__ml.nightCal(0, 1, 0));

// B. the CPU twin: the brazier's occlusion up the left wall's column.
const zs = []; for (let z = 4.2; z <= 8.01; z += 0.2) zs.push(+z.toFixed(1));
const occ = [];
for (const z of zs) { const r = await page.evaluate(([c, rr, z]) => window.__ml.occAt(c, rr, z), [205.99, 207.5, z]); occ.push(r?.occ?.[bi] ?? NaN); }
let jump = 0, jz = 0;
for (let k = 1; k < occ.length; k++) { const d = Math.abs(occ[k] - occ[k - 1]); if (d > jump) { jump = d; jz = zs[k]; } }
console.log(`twin: brazier occ up (205.99,207.5) z ${zs[0]}..${zs[zs.length - 1]}: ${occ.map((v) => v.toFixed(2)).join(" ")} — largest step ${jump.toFixed(2)} at z=${jz} (light z ${bz})`);
if (!(jump < 0.15)) fail(`twin: the brazier's occlusion jumps ${jump.toFixed(2)} at z=${jz} — the march stops at the light's height`);

// C. THE INNER CORNER OF THE RIGHT WALL IS IN THE CORNER COLUMN'S SHADOW. The
// stone column at (207,204) stands on the ray from the first ~0.3 cells of the
// +row face of (208,203) to the brazier, but those samples fell inside the
// light's own-trunk skip (a one-cell radius around the brazier's cell, meant
// for the fire's own piece) and the strip at the corner read fully lit beside
// a shadowed run (his second mark, 2026-09-17: "the red area being fully lit up
// is the bug"). The run beyond it KEEPS its soft shadow — the lid-plus-skirt
// darkening he judged right ("the outer part already in shadow looks good");
// the version that dropped it lit every cave wall flat (his fourth mark, "the
// nice shadow ... you removed"). Read on the SHADER's field (calibration 5).
await page.evaluate(() => window.__ml.nightCal(0, 1, 5));
await page.waitForTimeout(800);
const png5 = PNG.sync.read(await page.screenshot());
const lum5 = (x, y) => { const i = (y * png5.width + x) * 4; return 0.299 * png5.data[i] + 0.587 * png5.data[i + 1] + 0.114 * png5.data[i + 2]; };
await page.evaluate(() => window.__ml.nightCal(0, 1, 0));
for (const y of [480, 600]) {
  const run = []; for (let x = 590; x <= 790; x += 10) run.push(lum5(x, y));
  const peak = Math.max(...run);
  console.log(`right wall from the corner, y=${y}: ${run.map((v) => v.toFixed(0)).join(" ")} — corner ${run[0].toFixed(0)}, peak ${peak.toFixed(0)}`);
  if (!(run[0] < 0.7 * peak)) fail(`y=${y}: the corner strip (${run[0].toFixed(0)}) is not in the column's shadow (peak ${peak.toFixed(0)})`);
  for (let k = 1; k <= 5; k++) if (run[k] < run[k - 1] - 8) fail(`y=${y}: the wall gets DARKER within the first half cell from the corner at +${k * 10}px (${run[k - 1].toFixed(0)} -> ${run[k].toFixed(0)})`);
  // The soft shadow beyond the corner stays: somewhere in the first 1.5 cells
  // the field sits well under its peak further along.
  const soft = Math.min(...run.slice(4, 12));
  if (!(soft < 0.85 * peak)) fail(`y=${y}: the run beyond the corner has lost its soft shadow (min ${soft.toFixed(0)} against peak ${peak.toFixed(0)})`);
}
if (errs.length) fail(`page errors: ${errs.join(" | ")}`);
await browser.close();
console.log(process.exitCode ? "verify-shadowline: FAIL" : "verify-shadowline: ALL OK");
