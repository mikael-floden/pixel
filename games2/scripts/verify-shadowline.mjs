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
//     0.22 → 1.0 at z 5.5);
//  C. the corner column's shadow on the wall beside it (the fire is an AREA
//     source: its edge rays widen the hard test);
//  D. the TORCH beside a wall at 203.4,220.9: the pool reaches the wall and a
//     wall in full view is lit flat (the hard test takes the two-span rule —
//     under a lid the floor is not a hard hit, so no neighbour's skirt shades
//     a ray that runs beside it);
//  E. the ROOF from the street at 300.4,198.6 (the CPU twin): a top surface
//     takes nothing from a point light under its plane — the torch at z 0.55
//     adds nothing to the roof's cells at z 6 while it lights the street.
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
// stone column at (207,204) stands beside the ray from the +row face of
// (208,203) to the brazier — the brazier's centre passes 0.18 cells clear of
// it, so a point-source march lit the whole strip (his fourth mark, "the nice
// shadow ... you removed"). The fire is an AREA source: its edge rays widen the
// hard test, and the strip beside the column is in its penumbra — fully dark
// at the corner, fading out within ~a cell, no stripe per sample (his "vertical
// glitches"), and the wall beyond as the distance falloff leaves it. Read on
// the SHADER's field (calibration 5).
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
// D. THE TORCH BESIDE A WALL (maintainer 2026-09-17, 203.4,220.9, his marks on
// the calibration render): the pool "cut into a circle" and a triangle shadow
// on the wall in full view. Under the cave lid every floor cell's occlusion
// height IS the lid, so every march sample was a hard hit and the neighbour
// walls' bilinear skirts shaded every ray that ran beside them. Measured on his
// screen (calibration 5): the pool along y=800 fell to 56% of its value at
// x=550 within 25px; the wall face at y=600 ran 72 → 126 → 107 across five
// samples (a 1.75 ratio) where a face in full view of a torch two cells away
// is flat. With the two-span hard test: 87% and 1.19.
await page.evaluate(() => window.__ml.teleport(203.4, 220.9));
await page.waitForFunction(() => { const e = document.getElementById("ml-loading"); return !e || !e.isConnected || getComputedStyle(e).display === "none" || Number(getComputedStyle(e).opacity) === 0; }, null, { timeout: 90000 });
// The cut-away's crossfade must land (~27 s at the harness's ~1.7 fps).
// WAIT FOR THE STATE, NOT A TIME. Phaser hands a frame slower than 1000/fps.min
// (200 ms) the TARGET delta of 16.7 ms, so at the harness's 1-2 fps the 0.45 s
// roll needs ~190 frames — two to three minutes, not the 45 s this loop
// waited before (2026-09-18: the cave arms read the unlanded lid as a hard hit).
for (let i = 0; i < 200; i++) { await page.waitForTimeout(2000); const st = await page.evaluate(() => window.__ml.indoor()); if (st.indoor && st.mix >= 0.999) break; }
console.log("landed:", JSON.stringify(await page.evaluate(() => { const s = window.__ml.indoor(); return { indoor: s.indoor, mix: s.mix, mask: s.mask }; })));
await page.evaluate(() => window.__ml.timeOfDay("Day", true));
await page.evaluate(() => window.__ml.torch?.(true));
await page.waitForTimeout(4000);
await page.evaluate(() => window.__ml.nightCal(0, 1, 5));
await page.waitForTimeout(800);
const pngD = PNG.sync.read(await page.screenshot());
const lumD = (x, y) => { const i = (y * pngD.width + x) * 4; return 0.299 * pngD.data[i] + 0.587 * pngD.data[i + 1] + 0.114 * pngD.data[i + 2]; };
await page.evaluate(() => window.__ml.nightCal(0, 1, 0));
const pool = []; for (let x = 550; x <= 700; x += 25) pool.push(lumD(x, 800));
const poolMin = Math.min(...pool.slice(1));
console.log(`torch pool along y=800 from x=550: ${pool.map((v) => v.toFixed(0)).join(" ")} — min beyond ${poolMin.toFixed(0)} against ${pool[0].toFixed(0)} at the start`);
if (!(poolMin >= 0.75 * pool[0])) fail(`the torch pool is cut beside the wall: ${poolMin.toFixed(0)} against ${pool[0].toFixed(0)} at x=550 (want ≥ 75%)`);
for (const y of [500, 600]) {
  const face = []; for (let x = 700; x <= 780; x += 20) face.push(lumD(x, y));
  const ratio = Math.max(...face) / Math.max(1, Math.min(...face));
  console.log(`right wall face at y=${y}, x 700..780: ${face.map((v) => v.toFixed(0)).join(" ")} — max/min ${ratio.toFixed(2)}`);
  if (!(ratio <= 1.3)) fail(`y=${y}: the wall in full view of the torch wears a shadow (max/min ${ratio.toFixed(2)}, want ≤ 1.3)`);
}
// E. THE ROOF FROM THE STREET (maintainer 2026-09-17, 300.4,198.6 at Night,
// after walking out of the hearth house: "renders the roof of a light it
// doesn't have once the fade is over"). The torch he carries out lit the roof
// he had just left: a roof pixel's rays to a torch below run through its own
// slab (air under a light) and clear the wall column near the eaves, and a
// ground/deck pixel had no Lambert gate (faces have one). Measured on the twin:
// +0.10 luma on the roof's south cells at z 6 from a torch at z 0.55. Law: a
// top surface takes nothing from a light under its plane (TOP_UNDER_FADE).
await page.evaluate(() => window.__ml.teleport(300.4, 198.6));
await page.waitForFunction(() => { const e = document.getElementById("ml-loading"); return !e || !e.isConnected || getComputedStyle(e).display === "none" || Number(getComputedStyle(e).opacity) === 0; }, null, { timeout: 90000 });
// The arms above stood INSIDE the ice cave; its room mask outlives the
// teleport by the light roll, and the twin darkens everything outside that
// room while it lasts. Wait for the release (mix 0, no mask) before reading.
for (let i = 0; i < 120; i++) { const st = await page.evaluate(() => window.__ml.indoor()); if (!st.indoor && st.mix === 0 && !st.mask) break; await page.waitForTimeout(500); }
console.log("arm E indoor state:", JSON.stringify(await page.evaluate(() => { const s = window.__ml.indoor(); return { indoor: s.indoor, mix: s.mix, mask: s.mask }; })));
// The server clock patches phaseT every frame at x1 and overwrites a pin
// within a frame or two — freeze it first, then pin, and wait for the pin to
// hold (the first run of arm E read a roof lit +0.100 under a phase that was
// not Night at all).
for (let a = 0; a < 6; a++) {
  await page.evaluate(() => window.__ml.timeSpeed(0));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__ml.timeOfDay("Night", true));
  await page.waitForTimeout(1200);
  const tod = await page.evaluate(() => window.__ml.timeOfDay());
  if (tod && tod.name === "Night" && Math.abs(tod.phaseT - 0.5) < 0.05) break;
}
const roofCells = [[300.5, 195.5, 6], [300.5, 197.5, 6], [302.5, 197.5, 6]];
const readE = async () => page.evaluate((cells) => ({
  roof: cells.map(([c, r, z]) => window.__ml.lightAt(c, r, z)),
  street: window.__ml.lightAt(300.5, 199.5, 0),
}), roofCells);
await page.evaluate(() => window.__ml.torch?.(false));
await page.waitForTimeout(2500);
const offE = await readE();
await page.evaluate(() => window.__ml.torch?.(true));
await page.waitForTimeout(2500);
const onE = await readE();
const lumaE = (v) => 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2];
console.log(`street luma torch off/on: ${lumaE(offE.street).toFixed(3)} / ${lumaE(onE.street).toFixed(3)}`);
if (!(lumaE(onE.street) - lumaE(offE.street) >= 0.15)) fail(`the torch does not light the street it stands on (${lumaE(offE.street).toFixed(3)} -> ${lumaE(onE.street).toFixed(3)})`);
roofCells.forEach(([c, r, z], i) => {
  const d = lumaE(onE.roof[i]) - lumaE(offE.roof[i]);
  console.log(`roof ${c},${r} z${z}: torch off ${lumaE(offE.roof[i]).toFixed(3)} on ${lumaE(onE.roof[i]).toFixed(3)} (+${d.toFixed(3)})`);
  if (!(d <= 0.01)) fail(`the torch in the street lights the roof at ${c},${r} (+${d.toFixed(3)} luma, want ≤ 0.01)`);
});
if (errs.length) fail(`page errors: ${errs.join(" | ")}`);
await browser.close();
console.log(process.exitCode ? "verify-shadowline: FAIL" : "verify-shadowline: ALL OK");
