// Browser gate for DRAGONFLIES — the waterline in summer.
//
// They share a sky with the butterflies, so most of what matters here is the
// CONTRAST, and none of it is judgeable from a still:
//   OVER THE REEDS   — they belong to the maps2 agent's waterline pieces, read
//                      out of the display list by category. No reeds in view,
//                      no dragonflies: the arm that proves the sense of place
//                      is the NEGATIVE one.
//   STILL, LINE, STILL — all three modes happen, and a dart is a straight
//                      segment at one speed that ENDS DEAD. An eased ending
//                      would read as a bee and looks fine frozen.
//   IT SHOWS         — judged at the position the feature itself reports.
//   MUTED            — under the domain's saturation cap.
//   AND IT DOES NOT HITCH — the scenery probe walks the whole display list;
//                      unthrottled it cost a 9.8 ms frame, which is a visible
//                      drop. The cap here is what keeps that fixed.
//
//   node scripts/verify-dragonflies.mjs        (needs the dev stack on :5173)
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

/** The densest waterline cluster the world has: 11 pieces within 5 cells. */
const REEDS = { c: 223, r: 97 };
/** Plain grass with no reed, cattail or lily within 40 cells. */
const DRY = { c: 312, r: 156 };
const COST_MS = 0.25;
/* A single frame may not cost more than this. `objectsIn` walks EVERY object
 * on screen and filters afterwards, so the box it is given does not change its
 * price — one scan is a fixed ~3 ms and the only lever is how often it runs.
 * Unthrottled that was 9.8 ms and constant; it now needs the camera to have
 * moved, water to be in view at all, and at most one heartbeat every ten
 * seconds while it already holds its pieces. 4 ms is a quarter of a 60 fps
 * frame, spent at most that often, and only at a marsh. */
const PEAK_MS = 4.0;

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(GAME_URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 60_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("dragonflies")))) fail("dragonflies is not registered");

const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find((b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings");
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')].map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("dragonfl")) };
});
if (ui.error) fail(ui.error);
else if (!ui.found) fail(`no "Dragonflies" row in the Settings list (rows: ${ui.labels.join(", ")})`);
else console.log(`settings: "Dragonflies" is one of ${ui.labels.length} ambient rows`);

const ready = () => page.waitForFunction(() => !!window.__ml?.camView && !!window.__mlAmbient?.debug, null, { timeout: 60_000 });
const solo = () => page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__ml.weather(0, true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "dragonflies");
});
await solo();
const settle = async () => {
  await ready();
  let v = await page.evaluate(() => window.__ml.camView());
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(250);
    const v2 = await page.evaluate(() => window.__ml.camView());
    if (v2.x === v.x && v2.y === v.y) return v2;
    v = v2;
  }
  return v;
};
const goto = async (c, r) => {
  await ready();
  await page.evaluate(({ c, r }) => window.__ml.teleport(c, r), { c, r });
  await page.waitForTimeout(5000);
  await ready();
  await solo();
  return settle();
};
const dbg = () => page.evaluate(() => window.__mlAmbient.debug("dragonflies"));
const shoot = async () => PNG.sync.read(await page.screenshot());
const luma = (png, X, Y) => { const i = (Y * png.width + X) * 4; return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]; };

/* ---- OVER THE REEDS -------------------------------------------------------- */
let view = await goto(REEDS.c, REEDS.r);
await page.waitForTimeout(4000);
const d0 = await dbg();
console.log(`reeds: ${d0.pieces} waterline pieces in view, ${d0.count} dragonflies, gain ${d0.gain.toFixed(2)}`);
if (!d0.pieces) fail(`the scenery scan found no reeds/lilies at ${REEDS.c},${REEDS.r} — it is not reading the pieces`);
if (!d0.count) fail("reeds in view and not one dragonfly");

/* ---- MUTED ---------------------------------------------------------------- */
console.log(`colour: saturations ${JSON.stringify(d0.sats)}, the domain cap is ${d0.maxSat}`);
if (d0.sats.some((s) => s > d0.maxSat)) fail(`a dragonfly body is over the saturation cap (${d0.sats.join(", ")} vs ${d0.maxSat})`);

/* ---- STILL, LINE, STILL ---------------------------------------------------- */
/* Every mode must actually happen, and the dart has to be a STRAIGHT segment
 * at ONE speed that ends dead — the pure model proves the maths, this proves
 * the feature flies it. Sampled on rAF with a wall-clock deadline: a headless
 * page clamps setTimeout hard, and a loop counted in ticks runs for minutes. */
const flight = await page.evaluate(async () => {
  const tick = () => new Promise((r) => requestAnimationFrame(r));
  const modes = new Set();
  const tracks = new Map();
  const until = performance.now() + 40_000;
  while (performance.now() < until) {
    const all = window.__mlAmbient.debug("dragonflies").all;
    all.forEach((f, i) => {
      modes.add(f.mode);
      if (f.mode === 1) {
        if (!tracks.has(i)) tracks.set(i, []);
        const t = tracks.get(i);
        if (t.length < 40) t.push({ x: f.x, y: f.y, t: performance.now() });
      /* FOUR SAMPLES, not six. A dart is 100-600 ms and a headless page under
       * gate load runs nowhere near 60 fps, so a six-sample floor missed every
       * short dart in one run and passed six in the next — the arm was
       * measuring the frame rate. Four points is still three segments to hold
       * to a line. */
      } else if (tracks.has(i) && tracks.get(i).length >= 4) {
        tracks.set(`done${i}:${Math.random()}`, tracks.get(i));
        tracks.delete(i);
      } else tracks.delete(i);
    });
    await tick();
  }
  const done = [...tracks.entries()].filter(([k]) => String(k).startsWith("done")).map(([, v]) => v);
  return { modes: [...modes], darts: done.slice(0, 6) };
});
console.log(`flight: modes seen ${flight.modes.sort().join(",")} (0 hover, 1 dart, 2 perch); ${flight.darts.length} complete darts tracked`);
for (const m of [0, 1, 2]) if (!flight.modes.includes(m)) fail(`mode ${m} never happened (0 hover, 1 dart, 2 perch)`);
if (!flight.darts.length) fail("no complete dart could be tracked");
else {
  let straight = 0;
  for (const d of flight.darts) {
    // collinearity: every sample within a pixel of the line from first to last
    const a = d[0], b = d[d.length - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 6) continue;
    const off = Math.max(...d.map((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len));
    if (off <= 1.5) straight++;
    else fail(`a dart bent ${off.toFixed(1)} px off its own line — a dragonfly flies segments, not curves`);
  }
  console.log(`flight: ${straight} of ${flight.darts.length} darts are straight lines`);
  if (!straight) fail("no dart was long enough to judge as a line");
}

/* ---- IT SHOWS -------------------------------------------------------------- */
/* Judged where the feature SAYS its dragonfly is, against the ground beside
 * it — not a frame diff. The water under them is animated and the player is
 * animated, so nothing here can be isolated by subtracting two frames. */
{
  const zoom = await page.evaluate(() => window.__ml.camZoom());
  let judged = 0;
  let stood = 0;
  let best = 0;
  for (let i = 0; i < 90 && judged < 6; i++) {
    const all = (await dbg()).all.filter((f) => f.a > 0.5);
    if (!all.length) { await page.waitForTimeout(60); continue; }
    const [png, v, me] = await Promise.all([
      shoot(),
      page.evaluate(() => window.__ml.camView()),
      page.evaluate(() => window.__ml.myScreen()),
    ]);
    for (const f of all) {
      const X = Math.round((f.x - v.x) * zoom);
      const Y = Math.round((f.y - f.alt - v.y) * zoom);
      if (X < 10 || Y < 10 || X > 470 || Y > 300) continue;
      if (Math.abs(X - me.sx) < 16 * zoom && Y < me.sy + 4 * zoom && Y > me.sy - 88 * zoom) continue;
      const ring = [[7, 0], [-7, 0], [0, 6], [0, -6]].map(([dx, dy]) => luma(png, X + dx, Y + dy)).sort((a, b) => a - b);
      const ground = (ring[1] + ring[2]) / 2;
      const stand = Math.abs(luma(png, X, Y) - ground);
      judged++;
      best = Math.max(best, stand);
      if (stand > 10) stood++;
    }
    await page.waitForTimeout(120);
  }
  console.log(`pixels: ${judged} dragonfly positions judged, ${stood} stand out from what is behind them (best ${best.toFixed(1)} luma)`);
  if (!judged) fail("no dragonfly was ever in the clear to judge");
  else if (stood < Math.max(1, Math.floor(judged * 0.3))) fail(`only ${stood} of ${judged} dragonflies are visible (best ${best.toFixed(1)} luma)`);
}

/* ---- NO REEDS, NO DRAGONFLIES ---------------------------------------------- */
{
  await goto(DRY.c, DRY.r);
  await page.waitForTimeout(4000);
  const d = await dbg();
  console.log(`dry: ${d.pieces} waterline pieces, ${d.count} dragonflies, ${d.all.filter((f) => f.a > 0.5).length} drawn`);
  if (d.pieces) fail(`${d.pieces} waterline pieces found 40 cells from the nearest one — the category filter is not filtering`);
  if (d.all.filter((f) => f.a > 0.5).length) fail("dragonflies are flying over dry grass with no reed in sight");
}

/* ---- NOT AT NIGHT, NOT IN WEATHER ------------------------------------------ */
await page.evaluate(() => window.__mlAmbient.auto(true));
for (const [what, phase, weather] of [["night", "Night", 0], ["rain", "Day", 5], ["wind", "Day", 8]]) {
  await page.evaluate(({ phase, weather }) => { window.__ml.timeOfDay(phase, true); window.__ml.weather(weather, true); }, { phase, weather });
  await page.waitForTimeout(7000);
  const d = await dbg();
  console.log(`${what}: gain ${d.gain.toFixed(3)}, ${d.count} alive`);
  if (d.gain > 0.05) fail(`dragonflies are still out in ${what} (gain ${d.gain.toFixed(3)})`);
}
await page.evaluate(() => { window.__ml.timeOfDay("Day", true); window.__ml.weather(0, true); });
await solo();

/* ---- COST, AND NO HITCH ---------------------------------------------------- */
{
  await goto(REEDS.c, REEDS.r);
  const c = await page.evaluate(async () => {
    window.__mlAmbient.cost(true);
    await new Promise((r) => setTimeout(r, 6000));
    return window.__mlAmbient.cost().dragonflies;
  });
  const d = await dbg();
  console.log(`cost: ${c.ms.toFixed(3)} ms/frame over the reeds (peak ${c.peak}) over ${c.frames} frames, ${d.scans} scenery scans`);
  if (c.frames > 0 && c.ms > COST_MS) fail(`dragonflies cost ${c.ms.toFixed(3)} ms/frame, cap ${COST_MS}`);
  if (c.frames > 0 && c.peak > PEAK_MS) fail(`a single frame cost ${c.peak} ms — the scenery scan is hitching, cap ${PEAK_MS}`);
}

await browser.close();
if (failed) { console.error("verify-dragonflies: FAILED"); process.exit(1); }
console.log("verify-dragonflies: OK");
