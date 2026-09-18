// WEATHER IS AMBIENT — the gate (maintainer 2026-09-17, full ownership).
//
// Four things a unit test cannot see, because they need the real game:
//   1. all six weathers are REGISTERED and appear as their own Settings rows;
//   2. a weather draws ONLY its own sheet, and a clear sky draws NOTHING —
//      the regression this gate was born from: a gain ease stacked on the
//      density ease left a storm raining 160 drops on a clear sky, RISING;
//   3. the MANUAL lock actually refuses — two rain types can never be
//      switched on together by hand (the half `conflicts` exists for);
//   4. the sheet obeys the roof: no rain indoors;
//   5. THE SERVER OWNS IT (maintainer 2026-09-18): forcing the ROOM's set on
//      the server reaches this client as its active set and draws — thunder
//      under rain together, snow alone — and zone control off/on hands the
//      stage to the client lottery and back.
//
//   node scripts/verify-weather.mjs      (needs the dev stack on :5173)
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

const WX = ["cloudy", "mist", "drizzle", "rain", "heavyrain", "storm", "snow", "windy"];
const SHEETS = ["drizzle", "rain", "heavyrain", "storm", "snow", "windy"];
/** index -> [feature, cloud, dim] straight out of ambient/weather/gloom.ts. */
const CASES = [
  [3, "drizzle", 0.35, 0.05],
  [4, "rain", 0.7, 0.12],
  [5, "heavyrain", 1, 0.22],
  [6, "storm", 1, 0.34],
  [7, "snow", 0.4, 0.05],
  [8, "windy", 0.25, 0],
  [0, null, 0, 0],   // clear sky: nothing falls
  [1, null, 1, 0],   // cloudy: gloom only, still no particles
];

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(GAME_URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 60_000 });
await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__mlAmbient.auto(true);
});

/* ---- 1. six rows, one per weather ---------------------------------------- */
const rows = await page.evaluate(() => window.__mlAmbient.list());
const missing = WX.filter((n) => !rows.includes(n));
console.log(`settings: ${rows.length} ambient rows; weather rows ${WX.filter((n) => rows.includes(n)).join(", ") || "NONE"}`);
if (missing.length) fail(`weather rows missing from ambient: ${missing.join(", ")}`);

/* ---- 2. one sheet at a time, and a clear sky is clear -------------------- */
for (const [idx, want, cloud, dim] of CASES) {
  await page.evaluate((i) => window.__ml.weather(i, true), idx);
  await page.waitForTimeout(6000);
  const r = await page.evaluate((names) => {
    const out = {};
    for (const n of names) {
      const d = window.__mlAmbient.debug(n);
      if (d) out[n] = d.drawn ?? 0;
    }
    const wi = window.__ml.weatherInfo();
    return { out, cloud: +wi.cloud.toFixed(3), dim: +wi.precipDim.toFixed(3) };
  }, SHEETS);
  const drawing = Object.entries(r.out).filter(([, v]) => v > 0);
  console.log(`weather ${idx}: drawing [${drawing.map(([k, v]) => `${k}:${v}`).join(", ") || "nothing"}] cloud ${r.cloud} dim ${r.dim}`);
  if (drawing.length > 1) fail(`weather ${idx} has ${drawing.length} sheets up at once: ${drawing.map(([k]) => k).join(" + ")}`);
  if (want && (r.out[want] ?? 0) <= 0) fail(`weather ${idx} should be drawing ${want}, drew nothing`);
  if (!want && drawing.length) fail(`weather ${idx} draws no precipitation, but ${drawing.map(([k]) => k).join(",")} is up`);
  // the gloom is ambient's now — it must still grade the shader
  if (Math.abs(r.cloud - cloud) > 0.02) fail(`weather ${idx}: cloud ${r.cloud}, expected ${cloud}`);
  if (Math.abs(r.dim - dim) > 0.02) fail(`weather ${idx}: precip dim ${r.dim}, expected ${dim}`);
}

/* ---- 5. the SERVER owns the set --------------------------------------------- */
const srv = await page.evaluate(async () => {
  window.__mlAmbient.auto(true);
  window.__mlAmbient.zoneControl(true);
  window.__ml.worldAmbient(["rain", "thunder"]);
  await new Promise((r) => setTimeout(r, 7000));
  const act = window.__ml.ambientActive();
  const rain = window.__mlAmbient.debug("rain");
  const th = window.__mlAmbient.debug("thunder");
  const dir = window.__mlAmbient.director?.() ?? null;
  window.__ml.worldAmbient(["snow"]);
  await new Promise((r) => setTimeout(r, 7000));
  const act2 = window.__ml.ambientActive();
  const snow = window.__mlAmbient.debug("snow");
  const rain2 = window.__mlAmbient.debug("rain");
  // hand the stage back to the client lottery, then to the server again
  window.__mlAmbient.zoneControl(false);
  await new Promise((r) => setTimeout(r, 1500));
  const free = window.__mlAmbient.zoneControl();
  window.__mlAmbient.zoneControl(true);
  await new Promise((r) => setTimeout(r, 1500));
  const back = window.__mlAmbient.zoneControl();
  return { act, rainDrawn: rain?.drawn ?? 0, thunderOn: !!(th && (th.active ?? th.on ?? th.gain > 0)), act2, snowDrawn: snow?.drawn ?? 0, rainAfter: rain2?.drawn ?? 0, free, back, dir };
});
console.log(`server: forced [rain,thunder] -> client active [${srv.act}] rain drawn ${srv.rainDrawn} thunder on ${srv.thunderOn}; forced [snow] -> [${srv.act2}] snow ${srv.snowDrawn} rain ${srv.rainAfter}; zoneControl off=${srv.free} on=${srv.back}`);
if (!(srv.act.includes("rain") && srv.act.includes("thunder"))) fail("the server's forced set did not reach the client");
if (srv.rainDrawn <= 0) fail("rain was in the server's set but drew nothing");
if (!srv.thunderOn) fail("thunder was in the server's set but the episode did not start");
if (!(srv.act2.length === 1 && srv.act2[0] === "snow")) fail(`forcing [snow] left the client at [${srv.act2}]`);
if (srv.snowDrawn <= 0 || srv.rainAfter > 0) fail(`after [snow]: snow ${srv.snowDrawn}, rain ${srv.rainAfter}`);
if (srv.free !== false || srv.back !== true) fail("zoneControl did not toggle");
await page.evaluate(() => window.__ml.worldAmbient([])); // clear the room for the arms below
await page.waitForTimeout(5000);

/* ---- 3. MANUAL refuses a second rain type -------------------------------- */
const lock = await page.evaluate((names) => {
  const A = "rain";
  const B = "snow";
  window.__mlAmbient.setEnabled(A, true);
  const second = window.__mlAmbient.setEnabled(B, true);
  const eff = window.__mlAmbient.effects();
  const row = (n) => eff.find((e) => e.name === n) ?? null;
  const out = { second, aOn: !!row(A)?.enabled, bOn: !!row(B)?.enabled, bBlocked: row(B)?.blocked ?? null };
  window.__mlAmbient.auto(true); // back to the world's own weather
  return out;
}, WX);
console.log(`manual: rain on -> enabling snow returned ${JSON.stringify(lock.second)}; snow enabled=${lock.bOn} blocked by ${lock.bBlocked}`);
if (lock.aOn && lock.bOn) fail("MANUAL let rain and snow both be switched on — the conflicts lock does nothing");
if (!lock.bBlocked) fail("the UI is not told WHICH effect blocks snow, so it cannot grey the switch");

/* ---- 4. the roof stops the rain ------------------------------------------ */
await page.evaluate(() => { window.__mlAmbient.auto(true); window.__ml.weather(5, true); });
await page.waitForTimeout(4000);
const outdoors = await page.evaluate(() => window.__mlAmbient.debug("heavyrain")?.drawn ?? 0);
const cave = await page.evaluate(async () => {
  window.__ml.teleport(250, 188); // the cave the drips gate uses
  await new Promise((r) => setTimeout(r, 9000));
  return { indoor: !!window.__ml.indoor()?.indoor, drawn: window.__mlAmbient.debug("heavyrain")?.drawn ?? 0 };
});
console.log(`roof: heavy rain drew ${outdoors} outdoors; in the cave indoor=${cave.indoor} drawn=${cave.drawn}`);
if (!outdoors) fail("heavy rain drew nothing outdoors — the roof arm proves nothing");
if (cave.indoor && cave.drawn > 0) fail(`rain is falling inside a cave (${cave.drawn} drops)`);

await browser.close();
if (failed) { console.error("verify-weather: FAILED"); process.exit(1); }
console.log("verify-weather: OK");
