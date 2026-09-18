// CONTACT AO — where a scenery piece's ART meets the ground (docs/lighting.md;
// maintainer 2026-09-17/18, six + five marked screenshots: "a scenery object
// placed in the world doesn't look like it actually touches the ground").
// His hearth house at 254.0,304.2 by Day: a table, a chair, a barrel and a
// fireplace stand on the floor. Two checks:
//  1. the stamps EXIST for the drawn pieces (built from resident art);
//  2. the light field (calibration 5) is darker at a contact point than one
//     blob out to the side — the AO lands on the ground and nowhere else.
// Needs the dev stack (npm run dev). PORT overrides vite's port.
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
const PORT = process.env.PORT || "5173";
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await (await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, serviceWorkers: "block" })).newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (/shader night unavailable|contact stamp/i.test(m.text())) console.log("console:", m.text().slice(0, 200)); });
await page.goto(`http://localhost:${PORT}/#the_game`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 120000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.__ml.noAggro?.(true));
await page.evaluate(() => window.__ml.teleport(254.0, 304.2));
await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 60000 });
await page.waitForFunction(() => { const e = document.getElementById("ml-loading"); return !e || !e.isConnected || getComputedStyle(e).display === "none" || Number(getComputedStyle(e).opacity) === 0; }, null, { timeout: 90000 });
// The cut-away's LANDED state (Phaser hands slow frames the 16.7 ms target delta: minutes at 1-2 fps).
for (let i = 0; i < 200; i++) { await page.waitForTimeout(2000); const st = await page.evaluate(() => window.__ml.indoor()); if (st.indoor && st.mix >= 0.999) break; }
for (let a = 0; a < 6; a++) {
  await page.evaluate(() => window.__ml.timeSpeed(0)); await page.waitForTimeout(500);
  await page.evaluate(() => window.__ml.timeOfDay("Day", true)); await page.waitForTimeout(1200);
  const tod = await page.evaluate(() => window.__ml.timeOfDay()); if (tod && tod.name === "Day") break;
}
await page.evaluate(() => window.__ml.torch?.(false));
await page.waitForTimeout(6000); // the stamp jobs run a few per frame
const rep = await page.evaluate(() => window.__ml.contactStamps());
const built = rep.stamps.filter((s) => s.built && s.points.length);
console.log(`contact stamps: ${rep.stamps.length} registered, ${built.length} built (${rep.stat.built} built / ${rep.stat.failed} failed / ${rep.stat.empty} empty), dial ${rep.ao}`);
console.log("pieces:", built.map((s) => `${s.piece}(${s.points.length})`).join(", "));
if (built.length < 3) fail(`fewer than 3 pieces carry a built contact stamp (${built.length})`);
// 2. THE FIELD: calibration 5 is the raw light field, opaque.
await page.evaluate(() => window.__ml.nightCal(0, 1, 5));
await page.waitForTimeout(1500);
const png = PNG.sync.read(await page.screenshot());
await page.evaluate(() => window.__ml.nightCal(0, 1, 0));
const cam = await page.evaluate(() => window.__ml.camView());
// camView is the camera's WORLD rectangle; the screenshot's WIDTH spans it
// exactly, and the same scale holds vertically — the page is taller than the
// canvas (HUD, joystick), so png.height / cam.h is NOT the y scale.
const sc = png.width / cam.w;
const toScreen = (wx, wy) => [Math.round((wx - cam.x) * sc), Math.round((wy - cam.y) * sc)];
const luma = (x, y) => { if (x < 0 || y < 0 || x >= png.width || y >= png.height) return NaN; const i = (y * png.width + x) * 4; return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]; };
let checked = 0, darker = 0;
for (const s of built) {
  // The middle contact point, read a hair below the footline (the blob's pad reaches the ground in front).
  const p = s.points[Math.floor(s.points.length / 2)];
  const [sx, sy] = toScreen(p.x, p.y + 2);
  const at = luma(sx, sy);
  const side = Math.max(luma(sx + 40, sy + 10), luma(sx - 40, sy + 10));
  if (!Number.isFinite(at) || !Number.isFinite(side)) continue;
  checked++;
  if (at < side * 0.92) darker++;
  console.log(`${s.piece}: contact ${at.toFixed(0)} vs beside ${side.toFixed(0)} (${((1 - at / side) * 100).toFixed(0)}% darker)`);
}
if (checked && darker < Math.ceil(checked * 0.6)) fail(`${darker}/${checked} pieces read darker at their contact than beside it (want 60%)`);
// 3. THE ROOF TAKES NONE OF IT: outside the hearth house the furniture's
// stamps lie under the roof; the field is gated on the piece's floor height,
// so the roof's light must not change between the dial at 0 and at 1.
await page.evaluate(() => window.__ml.teleport(298.9, 198.4));
await page.waitForTimeout(6000);
for (let i = 0; i < 60; i++) { await page.waitForTimeout(2000); const st = await page.evaluate(() => window.__ml.indoor()); if (!st.indoor && st.mix <= 0.001) break; }
await page.evaluate(() => window.__ml.nightCal(0, 1, 5));
const boxLumas = async (ao) => {
  await page.evaluate((v) => window.__ml.contactAo(v), ao);
  await page.waitForTimeout(900);
  const shot = PNG.sync.read(await page.screenshot());
  const c = await page.evaluate(() => window.__ml.camView());
  const k = shot.width / c.w;
  // Every stamp the furniture under the roof would draw (registered, faded
  // out with the roof): the mean luma over its screen box.
  const rep2 = await page.evaluate(() => window.__ml.contactStamps());
  const out = [];
  for (const st of rep2.stamps.filter((q) => q.built && !q.visible)) {
    const x0 = Math.round((st.x - c.x) * k), y0 = Math.round((st.y - c.y) * k), x1 = Math.round((st.x + st.w - c.x) * k), y1 = Math.round((st.y + st.h - c.y) * k);
    let sum = 0, n = 0;
    for (let y = Math.max(0, y0); y < Math.min(shot.height, y1); y += 2) for (let x = Math.max(0, x0); x < Math.min(shot.width, x1); x += 2) { const i = (y * shot.width + x) * 4; sum += 0.299 * shot.data[i] + 0.587 * shot.data[i + 1] + 0.114 * shot.data[i + 2]; n++; }
    if (n > 50) out.push({ piece: st.piece, luma: sum / n });
  }
  return out;
};
const roofOff = await boxLumas(0), roofOn = await boxLumas(1);
await page.evaluate(() => window.__ml.nightCal(0, 1, 0));
await page.evaluate(() => window.__ml.contactAo(0.5));
console.log(`roofed pieces: ${roofOff.length}`);
let moved = 0;
for (let i = 0; i < Math.min(roofOff.length, roofOn.length); i++) {
  const d = Math.abs(roofOff[i].luma - roofOn[i].luma);
  if (d > 1.5) { moved++; console.log(`  ${roofOff[i].piece}: ${roofOff[i].luma.toFixed(1)} -> ${roofOn[i].luma.toFixed(1)}`); }
}
if (roofOff.length < 2) console.log("note: fewer than 2 roofed pieces in view — the roof arm did not run");
else if (moved) fail(`${moved} roofed piece(s) changed the roof's light with the contact dial`);
if (errs.length) fail(`page errors: ${errs.join(" | ")}`);
await browser.close();
console.log(process.exitCode ? "verify-contact: FAIL" : "verify-contact: ALL OK");
