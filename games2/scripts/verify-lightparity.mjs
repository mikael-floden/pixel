// verify-lightparity — the light slot ledger's browser gate (dev stack).
//
// THE CLAIM UNDER TEST (maintainer 2026-08-12): an emissive TILE is a REAL
// light now, not a glow sticker — "there should be NO DIFFERENCE in how bright
// the bonfire [tile] is vs the campfire [object]. SAME PLACE. SAME NIGHT." —
// and the whole thing lives inside a 12-slot budget with 4 reserved slots.
//
// Sections:
//  1. the ledger exists: sources resolved, slot invariants hold
//  2. PARITY — the bonfire tile's ground pool vs the campfire's, measured in
//     luminance rings on real pixels, both fires at night, torch OFF
//  3. INDOORS — the bonfire inside the room lights the room (the maintainer's
//     screenshot showed it pitch black around a burning fire)
//  4. BUDGET — total lights never exceed 12; the QA probe consumes a world
//     slot; overflow is reported, not silently truncated
//
// Method notes: every luminance number is a MEDIAN over a pixel patch (the
// footstep/ambient-agent lesson — single pixels lie); the camera is parked
// with __ml.lookAt so the target sits at screen centre; and the fire's pool is
// isolated from mine by __ml.torch(false).
//
// FIXTURE DEPENDENCY: the outdoor bonfire tile at (205,118) is maps2's
// hand-placed A/B cell (islandworld2.py BONFIRE_AB_CELL — the maintainer's
// same-place-same-night comparison), and the indoor one sits at (170,111).
// If maps2 moves them, re-point the coordinates here — the assertion logic
// doesn't care where they stand.
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const W = 480, H = 320;
let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "OK " : "FAIL"} ${label}`);
  if (!cond) failed++;
};

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});
const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForFunction(() => window.__mlSelect, { timeout: 40000 });
const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /the_island2/i.test(w)));
await page.evaluate((i) => { window.__mlSelect.pickWorld(i); window.__mlSelect.commit(); }, idx);
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 90000 });
await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 30000 });
await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.weather(0, true);
  window.__ml.timeOfDay("Night", true);
  window.__ml.torch(false);
});
await page.waitForTimeout(3500);

// Median luminance of a square patch (screenshot buffer).
const shoot = async () => PNG.sync.read(await page.screenshot());
const lumPatch = (png, cx, cy, half) => {
  const vals = [];
  for (let y = Math.max(0, cy - half); y < Math.min(png.height, cy + half); y++)
    for (let x = Math.max(0, cx - half); x < Math.min(png.width, cx + half); x++) {
      const i = (y * png.width + x) * 4;
      vals.push(0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]);
    }
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)] ?? 0;
};
// Mean luminance over a RING of patches at screen radius r around centre.
const lumRing = (png, cx, cy, r, half = 5) => {
  let s = 0, n = 0;
  for (let a = 0; a < 360; a += 30) {
    // The iso ground plane squashes vertical: sample an ellipse (ry = r*15/32).
    const x = Math.round(cx + r * Math.cos((a * Math.PI) / 180));
    const y = Math.round(cy + r * (15 / 32) * Math.sin((a * Math.PI) / 180));
    if (x < 8 || y < 8 || x > png.width - 8 || y > png.height - 60) continue;
    s += lumPatch(png, x, y, half);
    n++;
  }
  return n ? s / n : 0;
};

// ---- 1. the ledger ----------------------------------------------------------
const slots0 = await page.evaluate(() => window.__ml.lightSlots());
console.log("ledger:", JSON.stringify(slots0));
ok(slots0.sources > 0, `emissive sources resolved (${slots0.sources})`);
ok(slots0.max === 12 && slots0.reserved === 4 && slots0.worldSlots === 8, "ledger layout 12 = 4 reserved + 8 world");
ok(slots0.total <= slots0.max, `total lights ${slots0.total} <= ${slots0.max}`);

// ---- 2. PARITY: bonfire tile vs campfire object -----------------------------
// The campfire object sits a couple of cells from spawn; the bonfire TILE is
// the emissive prop at (205,118) (saturated_grass .../tile_12 — the fire art).
const camp = await page.evaluate(() => window.__ml.campfireInfo());
console.log("campfire at", JSON.stringify(camp));
const zoom = (await page.evaluate(() => window.__ml.camInfo())).zoom;
const CX = W / 2, CY = H / 2;
const ringPx = (cells) => cells * 32 * zoom; // iso half-tile dx = 32 world px

await page.evaluate((c) => window.__ml.lookAt(c.col, c.row), camp);
await page.waitForTimeout(900);
const campSlots = await page.evaluate(() => window.__ml.lightSlots());
ok(campSlots.slotted.includes("campfire"), "campfire holds a world slot");
const campShot = await shoot();
const campR2 = lumRing(campShot, CX, CY, ringPx(2.2));
const campR4 = lumRing(campShot, CX, CY, ringPx(4));

await page.evaluate(() => window.__ml.lookAt(205.5, 118.5));
await page.waitForTimeout(900);
const bonSlots = await page.evaluate(() => window.__ml.lightSlots());
ok(bonSlots.slotted.includes("205,118"), "bonfire tile holds a world slot");
const bonShot = await shoot();
const bonR2 = lumRing(bonShot, CX, CY, ringPx(2.2));
const bonR4 = lumRing(bonShot, CX, CY, ringPx(4));

// "The bonfire ground is LIT": the CPU light twin (the very sample lit copies
// tint by), 2 cells from the fire vs plain night ground 12+ cells from every
// source — pixels near the screen edge hit HUD chips, this cannot.
const lit2 = await page.evaluate(() => window.__ml.lightAt(207, 119));
const litFar = await page.evaluate(() => window.__ml.lightAt(195, 136));
const mag = (l) => (l ? (l[0] + l[1] + l[2]) / 3 : 0);
console.log(
  `luma: campfire r2.2=${campR2.toFixed(1)} r4=${campR4.toFixed(1)} | bonfire r2.2=${bonR2.toFixed(1)} r4=${bonR4.toFixed(1)} | lightAt near=${mag(lit2).toFixed(3)} far=${mag(litFar).toFixed(3)}`,
);
ok(mag(lit2) > mag(litFar) * 2.2, `bonfire ground is LIT (lightAt ${mag(lit2).toFixed(3)} vs far ${mag(litFar).toFixed(3)})`);
// Parity within 2x either way at both rings — the art and the ground albedo
// differ (grass vs sand), the LIGHT params are identical.
const par2 = bonR2 / Math.max(1, campR2);
const par4 = bonR4 / Math.max(1, campR4);
ok(par2 > 0.5 && par2 < 2.0, `parity at 2.2 cells: bonfire/campfire = ${par2.toFixed(2)}`);
ok(par4 > 0.5 && par4 < 2.0, `parity at 4 cells: bonfire/campfire = ${par4.toFixed(2)}`);

// ---- 3. INDOORS: the fire lights its room -----------------------------------
// The maintainer's screenshot: bonfire prop at (170,111), player at ~171,115,
// the room floor pitch black around a burning fire.
await page.evaluate(() => window.__ml.lookAt());
await page.evaluate(() => window.__ml.teleport(171, 113));
await page.waitForTimeout(2500); // indoor fade + camera snap
const indoorSlots = await page.evaluate(() => window.__ml.lightSlots());
ok(indoorSlots.slotted.includes("170,111"), "indoor bonfire holds a world slot");
// The CPU twin again — pixel patches in a small room hit walls, the player's
// own coordinate label, or the white occlusion ring. lightAt cannot.
const inNear = await page.evaluate(() => window.__ml.lightAt(171, 112));
const inFarC = await page.evaluate(() => window.__ml.lightAt(174, 117));
const magIn = (l) => (l ? (l[0] + l[1] + l[2]) / 3 : 0);
console.log(`indoor lightAt: nearFire=${magIn(inNear).toFixed(3)} acrossRoom=${magIn(inFarC).toFixed(3)}`);
ok(magIn(inNear) > 0.25, `the indoor room is fire-lit near the fire (${magIn(inNear).toFixed(3)})`);
ok(magIn(inNear) > magIn(inFarC) * 1.4, `light falls off across the room (${magIn(inNear).toFixed(3)} vs ${magIn(inFarC).toFixed(3)})`);

// ---- 4. BUDGET invariants ----------------------------------------------------
// The probe light consumes a WORLD slot: with it set, world holders <= 7.
await page.evaluate((c) => window.__ml.probeLight(c.col, c.row, c.z, 5), camp);
await page.waitForTimeout(400);
const withProbe = await page.evaluate(() => window.__ml.lightSlots());
ok(withProbe.probe && withProbe.slotted.length <= 7, `probe consumes a world slot (${withProbe.slotted.length} <= 7)`);
ok(withProbe.total <= 12, `total with probe ${withProbe.total} <= 12`);
await page.evaluate(() => window.__ml.probeLight());
// Sweep a handful of spots incl. the crystal cluster; the invariant must hold
// everywhere and overflow must be COUNTED, never silently truncated.
let worstTotal = 0, sawOverflowField = true;
for (const [c, r] of [[114, 50], [120, 40], [35, 130], [98, 49], [171, 113], [205, 118]]) {
  await page.evaluate(([cc, rr]) => window.__ml.lookAt(cc, rr), [c, r]);
  await page.waitForTimeout(350);
  const s = await page.evaluate(() => window.__ml.lightSlots());
  worstTotal = Math.max(worstTotal, s.total);
  if (typeof s.overflow !== "number") sawOverflowField = false;
}
ok(worstTotal <= 12, `worst-case total across sweep = ${worstTotal} <= 12`);
ok(sawOverflowField, "overflow is reported at every spot");

await browser.close();
console.log(failed ? `\nverify-lightparity: ${failed} FAILURE(S)` : "\nverify-lightparity OK");
process.exit(failed ? 1 : 0);
