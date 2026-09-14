// Browser gate for FISH RISES — a fish takes a fly and the lake keeps the ring.
//
// The three things that would be wrong and invisible to a unit test:
//   ON THE LAKE  — every rise stands on water the game calls swimmable, with
//                  clearance on all sides, and NEVER on the open sea (that is
//                  `deepwater/`'s water) or on land.
//   IT SHOWS     — a pixel arm: the ring brightens the water it is drawn on,
//                  judged against an OFF envelope (the lake chop underneath is
//                  animated, so a single OFF frame is one phase of a moving
//                  picture), with a control box on water far from any rise.
//   IT SPREADS   — the drawn ring's radius grows over consecutive frames. A
//                  ring that appeared and sat still would pass every other arm
//                  here and read as a decal.
//
//   node scripts/verify-fish.mjs        (needs the dev stack on :5173)
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

const IDLE_MS = 0.12; // mean ms/frame over dry land, where nothing may run
const COST_MS = 0.35; // and over a lake, with rises in flight
/** A pond the game ships: the shallows off the beach south-east of spawn. */
const LAKE = { c: 338, r: 258 };
const DRY = { c: 333, r: 251 }; // beach, a few cells inland

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(GAME_URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 60_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("fish")))) fail("fish is not registered");

const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find((b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings");
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')].map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("fish")) };
});
if (ui.error) fail(ui.error);
else if (!ui.found) fail(`no "Fish" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
else console.log(`settings: "Fish" is one of ${ui.labels.length} ambient rows`);

await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__ml.weather(0, true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "fish");
});

const settle = async () => {
  let v = await page.evaluate(() => window.__ml.camView());
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(300);
    const v2 = await page.evaluate(() => window.__ml.camView());
    if (v2.x === v.x && v2.y === v.y) return v2;
    v = v2;
  }
  return v;
};
const goto = async (c, r) => {
  await page.evaluate(({ c, r }) => window.__ml.teleport(c, r), { c, r });
  await page.waitForTimeout(5000);
  return settle();
};
const dbg = () => page.evaluate(() => window.__mlAmbient.debug("fish"));
const shoot = async () => PNG.sync.read(await page.screenshot());
const luma = (png, X, Y) => { const i = (Y * png.width + X) * 4; return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]; };

/* ---- ON THE LAKE --------------------------------------------------------- */
const view = await goto(LAKE.c, LAKE.r);
await page.waitForTimeout(2500);
const d0 = await dbg();
console.log(`lake: gain ${d0.gain.toFixed(2)}, lakeFrac ${d0.lakeFrac}, spawned ${d0.spawned}, rejected ${d0.rejected}`);
if (d0.lakeFrac <= 0) fail(`the probe found no lake at ${LAKE.c},${LAKE.r} — the gate is standing in the wrong place`);

// watch for a while and check every rise the feature makes
const seen = [];
for (let i = 0; i < 40; i++) {
  const d = await dbg();
  for (const r of d.all) if (!seen.some((s) => s.x === r.x && s.y === r.y)) seen.push({ x: r.x, y: r.y });
  await page.waitForTimeout(250);
}
console.log(`lake: ${seen.length} distinct rises in ~10 s`);
if (seen.length < 3) fail(`only ${seen.length} rises in 10 s over open lake — the effect is too rare to see`);

const placed = await page.evaluate((spots) => {
  const R = 15;
  return spots.map((s) => {
    const deep = window.__ml.deepCurrentAtScreen(s.x, s.y);
    return {
      ...s,
      water: window.__ml.waterAtScreen(s.x, s.y),
      deep: !!deep && deep.speed > 0,
      // the widest ring must still be on water, all the way round
      edges: [[R, 0], [-R, 0], [0, 7], [0, -7]].map(([dx, dy]) => window.__ml.waterAtScreen(s.x + dx, s.y + dy)),
    };
  });
}, seen);
for (const p of placed) {
  if (!p.water) fail(`a rise at (${p.x},${p.y}) is not on water`);
  if (p.deep) fail(`a rise at (${p.x},${p.y}) is on the OPEN SEA — that water belongs to deepwater/`);
  if (p.edges.some((e) => !e)) fail(`a rise at (${p.x},${p.y}) has its ring crossing off the water (edges ${p.edges.join(",")})`);
}
console.log(`lake: all ${placed.length} rises on lake water with the ring's clearance`);

/* ---- IT SPREADS ----------------------------------------------------------- */
// the DRAWN radius of one ring, frame after frame
const growth = await page.evaluate(async () => {
  const track = new Map();
  for (let i = 0; i < 120; i++) {
    for (const r of window.__mlAmbient.debug("fish").all) {
      const k = `${r.x},${r.y}`;
      const lead = r.rings[0];
      if (!track.has(k)) track.set(k, []);
      if (lead.a > 0) track.get(k).push(lead.r);
    }
    await new Promise((s) => setTimeout(s, 40));
  }
  return [...track.values()].filter((v) => v.length >= 3).map((v) => [...new Set(v)]);
});
const grew = growth.filter((v) => v.length >= 2 && v.every((r, i) => i === 0 || r >= v[i - 1]));
console.log(`spread: ${growth.length} rings tracked, ${grew.length} grew monotonically; widths ${growth.slice(0, 4).map((v) => `${v[0]}->${v[v.length - 1]}`).join(", ")}`);
if (!growth.length) fail("no ring could be tracked over consecutive frames");
else if (grew.length < Math.max(1, Math.floor(growth.length * 0.8))) fail(`only ${grew.length} of ${growth.length} rings spread — a ring that sits still is a decal`);

/* ---- IT SHOWS (pixels) ---------------------------------------------------- */
const setOn = (on) => page.evaluate((on) => window.__mlAmbient.setEnabled("fish", on), on);
const zoom = await page.evaluate(() => window.__ml.camZoom());
/* THE BOX IS THE GAME AREA, NOT THE SCREEN. At this viewport the canvas is
 * 480x320 and the camera shows 198 px of world; the rest is HUD, and the chat
 * line ("<name> has arrived") rewrites itself while the gate runs. Judging the
 * whole screen measured that text: rise 243.6 with the OFF control also at
 * 243.6, which is what a passing arm would have looked like. */
const BOX = { x0: 96, x1: 384, y0: 40, y1: 150 };
const inBox = (r) => {
  const sx = (r.x - view.x) * zoom, sy = (r.y - view.y) * zoom;
  return sx > BOX.x0 + 18 && sx < BOX.x1 - 18 && sy > BOX.y0 + 10 && sy < BOX.y1 - 10;
};
await setOn(false);
await page.waitForTimeout(2500);
const offs = [];
for (let i = 0; i < 6; i++) { offs.push(await shoot()); await page.waitForTimeout(200); }
const noiseShot = await shoot();
await setOn(true);
// ON frames are kept only when a rise is actually inside the judged box
const ons = [];
for (let i = 0; i < 60 && ons.length < 8; i++) {
  const all = (await dbg()).all;
  if (all.some((r) => r.a > 0.25 && inBox(r))) ons.push(await shoot());
  else await page.waitForTimeout(90);
}
console.log(`pixels: ${ons.length} ON frames with a rise inside the box`);
if (ons.length < 3) fail(`only ${ons.length} frames had a rise inside the judged box`);
const judge = (x0, x1, y0, y1) => {
  const base = new Map();
  for (const png of offs)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const k = y * 10000 + x;
      base.set(k, Math.max(base.get(k) ?? 0, luma(png, x, y)));
    }
  const rise = (png) => { let m = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m = Math.max(m, luma(png, x, y) - base.get(y * 10000 + x)); return m; };
  let best = 0;
  for (const png of ons) best = Math.max(best, rise(png));
  return { best: +best.toFixed(1), noise: +rise(noiseShot).toFixed(1) };
};
if (ons.length) {
  const wide = judge(BOX.x0, BOX.x1, BOX.y0, BOX.y1);
  console.log(`pixels: the lake brightens by ${wide.best} where a rise lands (OFF noise ${wide.noise})`);
  if (!(wide.best >= 18 && wide.best >= wide.noise * 1.6)) fail(`no rise showed on screen (rise ${wide.best}, noise ${wide.noise})`);
}

/* ---- NOTHING ON DRY LAND -------------------------------------------------- */
await goto(DRY.c, DRY.r);
await page.waitForTimeout(3000);
const dry = await dbg();
console.log(`dry land: lakeFrac ${dry.lakeFrac}, rises ${dry.rises}, gain ${dry.gain.toFixed(2)}`);
const onLand = await page.evaluate((spots) => spots.filter((s) => !window.__ml.waterAtScreen(s.x, s.y)).length, dry.all.map((r) => ({ x: r.x, y: r.y })));
if (onLand) fail(`${onLand} rises are standing on dry ground`);
const idle = await page.evaluate(async () => {
  window.__mlAmbient.cost(true);
  await new Promise((r) => setTimeout(r, 3000));
  return window.__mlAmbient.cost().fish;
});
console.log(`cost: ${idle.ms.toFixed(3)} ms/frame inland (peak ${idle.peak}) over ${idle.frames} frames`);
if (idle.frames > 0 && idle.ms > IDLE_MS) fail(`fish costs ${idle.ms.toFixed(3)} ms/frame with no lake in view, cap ${IDLE_MS}`);

await goto(LAKE.c, LAKE.r);
const busy = await page.evaluate(async () => {
  window.__mlAmbient.cost(true);
  await new Promise((r) => setTimeout(r, 4000));
  return window.__mlAmbient.cost().fish;
});
console.log(`cost: ${busy.ms.toFixed(3)} ms/frame over the lake (peak ${busy.peak}) over ${busy.frames} frames`);
if (busy.frames > 0 && busy.ms > COST_MS) fail(`fish costs ${busy.ms.toFixed(3)} ms/frame over a lake, cap ${COST_MS}`);

await browser.close();
if (failed) { console.error("verify-fish: FAILED"); process.exit(1); }
console.log("verify-fish: OK");
