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
if (errs.length) fail(`page errors: ${errs.join(" | ")}`);
await browser.close();
console.log(process.exitCode ? "verify-shadowline: FAIL" : "verify-shadowline: ALL OK");
