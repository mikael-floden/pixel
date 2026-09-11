// Browser gate for FEATHERS — what a flock drops when you spook it.
//
// The arms are the three things a unit test cannot see: that a REAL flush
// reaches this feature at all (it travels over runtime/flush.ts, and a broken
// wire looks exactly like a calm flock), that a feather is DRAWN (four pale
// pixels: a counter cannot tell a drawn one from a forgotten one), and that
// it FALLS and comes to rest instead of hanging in the air.
//
// SPOOKING THEM IS A PROTOCOL, not a lunge, and both halves were paid for:
//   - a flock only SETTLES while the player is far away, so chasing it keeps
//     it airborne and it never lands to be flushed. Stand off, wait for
//     `landed`, then close.
//   - a bird's gx/gy are DRAWN ISO PIXELS, not world units. `teleport` takes
//     a CELL, and gx/32 is a different place entirely (measured: it put the
//     player 150 cells away and nothing ever happened). `pickAt` inverts the
//     projection, and it is the only correct way back.
//
//   node scripts/verify-feathers.mjs        (needs the dev stack on :5173)
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

function chromePath() {
  const root = "/opt/pw-browsers";
  const c = existsSync(root)
    ? readdirSync(root).filter((d) => /^chromium(-\d+)?$/.test(d)).map((d) => join(root, d, "chrome-linux", "chrome"))
    : [];
  return [...c, join(root, "chromium")].find((p) => existsSync(p));
}

const GAME_URL = process.env.GAME_URL || "http://localhost:5173/";
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };
const IDLE_MS = 0.08; // with nothing shed, this feature is arithmetic on an empty list
const MEADOW = { c: 333, r: 240 }; // open dry ground a flock will settle on

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(GAME_URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 60_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("feathers")))) fail("feathers is not registered");

const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find((b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings");
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')].map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("feather")) };
});
if (ui.error) fail(ui.error);
else if (!ui.found) fail(`no "Feathers" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
else console.log(`settings: "Feathers" is one of ${ui.labels.length} ambient rows`);

const dbg = (n) => page.evaluate((n) => window.__mlAmbient.debug(n), n);
const shoot = async () => PNG.sync.read(await page.screenshot());
const luma = (png, X, Y) => { const i = (Y * png.width + X) * 4; return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]; };

/* ---- NOTHING WITHOUT A FLUSH --------------------------------------------- */
await page.evaluate(({ c, r }) => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__ml.weather(0, true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, false);
  window.__ml.teleport(c, r);
}, MEADOW);
await page.waitForTimeout(4000);
const quiet = await dbg("feathers");
console.log(`no flock: shed ${quiet.shed}, demo ${quiet.demo}, live ${quiet.feathers}, source ${quiet.source}`);
if (quiet.feathers > 0) fail(`${quiet.feathers} feathers exist with no birds and the feature switched off`);

/* ---- A REAL FLUSH SHEDS ---------------------------------------------------- */
await page.evaluate(() => {
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "birds" || n === "feathers");
});
await page.waitForTimeout(1500);
const src = (await dbg("feathers")).source;
console.log(`with birds enabled, a flush source is registered: ${src}`);
if (!src) fail("birds is running but no flush source is registered — feathers would run its demo over a live flock");

let flushed = 0;
for (let round = 0; round < 8 && !flushed; round++) {
  // stand off and wait for the flock to settle
  let spot = null;
  for (let i = 0; i < 140; i++) {
    const b = await dbg("birds");
    const down = b.all.filter((x) => x.state === 3 || x.alt < 4);
    if (b.landed >= 2 && down.length) { spot = down[0]; break; }
    await page.waitForTimeout(500);
  }
  if (!spot) continue;
  const cell = await page.evaluate((b) => { const pk = window.__ml.pickAt(b.gx, b.gy); return pk ? { c: pk.x / 32, r: pk.y / 32 } : null; }, spot);
  if (!cell) continue;
  await page.evaluate(({ c, r }) => window.__ml.teleport(c, r), cell);
  for (let k = 0; k < 14 && !flushed; k++) {
    await page.waitForTimeout(250);
    flushed = (await dbg("feathers")).flushes;
  }
}
if (!flushed) fail("could not spook the flock in 8 rounds — the flush never reached feathers");
else {
  const d = await dbg("feathers");
  console.log(`flush: ${d.flushes} birds announced, ${d.shed} feathers shed, ${d.feathers} in flight, demo ${d.demo}`);
  if (d.shed < d.flushes) fail(`${d.flushes} birds flushed but only ${d.shed} feathers were shed`);
  if (d.demo > 0) fail(`${d.demo} DEMO feathers were shed while a real flock was running`);
}

/* ---- IT FALLS, THEN LIES STILL --------------------------------------------- */
const track = await page.evaluate(async () => {
  // ONE feather at a time, by its own id — grouping by position mixed two
  // feathers shed at the same spot and made every series meaningless.
  const seen = new Map();
  for (let i = 0; i < 160; i++) {
    for (const f of window.__mlAmbient.debug("feathers").all) {
      if (!seen.has(f.id)) seen.set(f.id, []);
      seen.get(f.id).push({ dy: f.dy, tilt: f.tilt, down: f.down, x: f.x });
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return [...seen.values()].filter((v) => v.length >= 6);
});
// it must RISE on the wingbeat and then SINK past where it was shed
const fell = track.filter((v) => Math.max(...v.map((s) => s.dy)) > Math.min(...v.map((s) => s.dy)) + 4);
const lifted = track.filter((v) => Math.min(...v.map((s) => s.dy)) < -2);
const swung = track.filter((v) => new Set(v.map((s) => s.tilt)).size >= 2 || new Set(v.map((s) => s.x)).size >= 2);
const rested = track.filter((v) => v.some((s) => s.down));
console.log(`fall: ${track.length} tracked, ${lifted.length} rose on the wingbeat, ${fell.length} sank, ${swung.length} swung or leaned, ${rested.length} came to rest`);
if (!track.length) fail("no feather could be tracked over consecutive frames");
else {
  if (!fell.length) fail("no feather sank — they are hanging in the air");
  if (!lifted.length) fail("no feather rose off the bird — the wingbeat kick is missing, so one shed by a STANDING bird never falls");
  if (!swung.length) fail("no feather swung or changed its lean — it is dropping like a stone");
  if (!rested.length) fail("no feather came to rest on the ground");
}

/* ---- THE SETTINGS DEMO ------------------------------------------------------ */
// Selected ALONE there is no flock, so the row must still show something.
await page.evaluate(() => {
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "feathers");
});
await page.waitForTimeout(7000);
const solo = await dbg("feathers");
console.log(`solo: source ${solo.source}, demo sheds ${solo.demo}, live ${solo.feathers}`);
if (solo.source) fail("a flush source is still registered after birds were switched off");
if (solo.demo === 0) fail("selected alone, feathers shows nothing at all — the Settings row looks broken");

/* ---- IT IS ACTUALLY DRAWN (pixels) ----------------------------------------- */
// A feather lying on the ground, then the SAME ground with the feature
// switched off: the camera and the terrain do not move between the two, so any
// difference is the feather. Switching off is what makes it deterministic —
// waiting for them to fade caught feathers mid-fade and left others in the
// second frame, and the arm measured nothing twice.
/* IN THE CLEAR PART OF THE GAME AREA, never just anywhere on screen: the HUD
 * is DOM over the canvas, and the first feather this arm chose sat behind the
 * level panel at the top right, where both frames are identical whatever the
 * game draws (measured: 0 px changed, peak 0.0, while the frame as a whole
 * differed in 153). Same trap the water gate documents. */
const spotDown = await page.evaluate(async () => {
  const clear = (f) => {
    const v = window.__ml.camView();
    const z = window.__ml.camZoom();
    const sx = (f.x - v.x) * z;
    const sy = (f.y - v.y) * z;
    return sx > 110 && sx < 370 && sy > 50 && sy < 145;
  };
  for (let i = 0; i < 300; i++) {
    const f = window.__mlAmbient.debug("feathers").all.find((x) => x.down && x.a > 0.95 && clear(x));
    if (f) return { x: f.x, y: f.y, view: window.__ml.camView(), zoom: window.__ml.camZoom() };
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
});
if (!spotDown) fail("no resting feather appeared to photograph");
else {
  const { x, y, view, zoom } = spotDown;
  const x0 = Math.max(0, Math.round((x - 7 - view.x) * zoom));
  const x1 = Math.min(480, Math.round((x + 8 - view.x) * zoom));
  const y0 = Math.max(0, Math.round((y - 6 - view.y) * zoom));
  const y1 = Math.min(320, Math.round((y + 7 - view.y) * zoom));
  const withIt = await shoot();
  await page.evaluate(() => window.__mlAmbient.setEnabled("feathers", false));
  await page.waitForTimeout(900);
  const gone = await dbg("feathers");
  const without = await shoot();
  let diff = 0;
  let peak = 0;
  for (let py = y0; py < y1; py++)
    for (let px = x0; px < x1; px++) {
      const d = Math.abs(luma(withIt, px, py) - luma(without, px, py));
      if (d > 18) diff++;
      peak = Math.max(peak, d);
    }
  console.log(`pixels: box ${x1 - x0}x${y1 - y0} at the feather; ${diff} px changed when it was removed, peak ${peak.toFixed(1)} luma (live now ${gone.feathers})`);
  if (gone.feathers > 0) fail(`${gone.feathers} feathers survived the switch-off — the second frame is not a clean control`);
  if (!(diff >= 2 && peak >= 25)) fail(`the resting feather did not draw (changed ${diff} px, peak ${peak.toFixed(1)})`);
}

/* ---- COST -------------------------------------------------------------------- */
await page.evaluate(() => { for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, false); });
await page.waitForTimeout(2000);
const cost = await page.evaluate(async () => {
  window.__mlAmbient.cost(true);
  await new Promise((r) => setTimeout(r, 3000));
  return window.__mlAmbient.cost().feathers;
});
console.log(`cost: ${cost.ms.toFixed(4)} ms/frame idle (peak ${cost.peak}) over ${cost.frames} frames`);
if (cost.frames > 0 && cost.ms > IDLE_MS) fail(`feathers idles at ${cost.ms.toFixed(4)} ms/frame, cap ${IDLE_MS}`);

await browser.close();
if (failed) { console.error("verify-feathers: FAILED"); process.exit(1); }
console.log("verify-feathers: OK");
