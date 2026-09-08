// Browser gate for EMBER SPARKS — what comes off a fire and goes UP.
//
// The maintainer set the two conditions: "Ember sparks need to both know if
// this is a fire AND where the fire/light source is." So the two hard arms here
// are DISCRIMINATION (sparks over fires and over nothing else — proven against
// a view that also holds lights which are NOT fires, or it proves nothing) and
// ORIGIN (a spark leaves the FLAME, not the object's foot). Then: it goes up,
// it fades in and out, and it costs nothing.
//
//   node scripts/verify-embers.mjs        (needs the dev stack on :5173)
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

const URL = process.env.GAME_URL || "http://localhost:5173/";
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };

const COST_MS = 0.35;
const PROBES_PER_S = 4;

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("embers")))) fail("embers is not registered");

/* ---- IN THE SETTINGS MENU, AND THE SWITCH WORKS ---- */
const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find(
    (b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings",
  );
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')].map((r) =>
    (r.querySelector(".ml-amb-label")?.textContent || "").trim(),
  );
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("embers")) };
});
if (ui.error) fail(ui.error);
else {
  console.log(`settings: ${ui.labels.length} ambient rows — ${ui.found ? '"Embers" is one of them' : "NO embers row"}`);
  if (!ui.found) fail(`no "Embers" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
}

await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Night", true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "embers");
});

/* ---- FIND A FIRE. Derived by walking out until the effect itself reports one
 * — never a named cell, and it also records a view that holds lights which are
 * NOT fires, which is what makes the discrimination arm non-vacuous. */
const found = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  const me = window.__ml.me();
  const c0 = Math.round(me.x / 32);
  const r0 = Math.round(me.y / 32);
  let coldSeen = null; // a view with lights but no fires
  for (let ring = 0; ring <= 40; ring += 4)
    for (let a = 0; a < 12; a++) {
      const c = c0 + Math.round(Math.cos((a / 12) * 6.283) * ring);
      const r = r0 + Math.round(Math.sin((a / 12) * 6.283) * ring);
      window.__ml.teleport(c, r);
      for (let i = 0; i < 90; i++) await step();
      const d = window.__mlAmbient.debug("embers");
      if (!coldSeen && d.lights > 0 && d.fires === 0) coldSeen = { col: c, row: r, lights: d.lights, sparks: d.sparks };
      if (d.fires > 0) return { col: c, row: r, lights: d.lights, fires: d.fires, coldSeen };
    }
  return { col: null, coldSeen };
});
if (found.coldSeen)
  console.log(
    `cold lights at ${found.coldSeen.col},${found.coldSeen.row}: ${found.coldSeen.lights} light(s) in view, ` +
      `0 of them fires, ${found.coldSeen.sparks} sparks drawn`,
  );
if (!found.col) fail("no fire found anywhere near the spawn — the effect never had one to work with");
else {
  console.log(`fire at ${found.col},${found.row}: ${found.fires} of ${found.lights} light(s) in view are fires`);

  /* ---- IT ONLY SPARKS OVER FIRES, AND THE SPARKS LEAVE THE FLAME ---- */
  const burn = await page.evaluate(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 200; i++) await step();
    let samples = 0, up = 0, down = 0, farFromFlame = 0, most = 0;
    let early = 0, earlyN = 0, mid = 0, midN = 0, late = 0, lateN = 0;
    const prev = new Map();
    for (let i = 0; i < 420; i++) {
      const d = window.__mlAmbient.debug("embers");
      most = Math.max(most, d.sparks);
      (d.all || []).forEach((s, j) => {
        samples++;
        // BORN AT THE FLAME: a young spark must be within a few px of its fire.
        if (s.t < 0.12 && Math.hypot(s.x - s.fx, s.y - s.fy) > 14) farFromFlame++;
        // AND IT GOES UP.
        const last = prev.get("p" + j);
        if (last && last[2] < s.t) { if (s.y < last[1]) up++; else if (s.y > last[1]) down++; }
        // Alpha against age — the fade at both ends, without needing ids.
        if (s.t < 0.06) { early += s.a; earlyN++; }
        else if (s.t > 0.3 && s.t < 0.5) { mid += s.a; midN++; }
        else if (s.t > 0.94) { late += s.a; lateN++; }
      });
      (d.all || []).forEach((s, j) => prev.set("p" + j, [s.x, s.y, s.t]));
      await step();
    }
    return {
      samples, up, down, farFromFlame, most,
      early: earlyN ? early / earlyN : null,
      mid: midN ? mid / midN : null,
      late: lateN ? late / lateN : null,
      earlyN, midN, lateN,
    };
  });
  console.log(
    `sparks: ${burn.samples} samples, at most ${burn.most} at once; ${burn.up} rose vs ${burn.down} fell; ` +
      `${burn.farFromFlame} were born away from the flame`,
  );
  console.log(
    `fade: mean alpha ${burn.early === null ? "?" : burn.early.toFixed(3)} at birth, ` +
      `${burn.mid === null ? "?" : burn.mid.toFixed(3)} mid-life, ${burn.late === null ? "?" : burn.late.toFixed(3)} at the end`,
  );
  if (!burn.samples) fail("a fire was in view and it threw no sparks at all");
  if (burn.farFromFlame) fail(`${burn.farFromFlame} sparks were born more than 14px from their fire — they must leave the FLAME`);
  if (!(burn.up > burn.down * 8)) fail(`sparks rose ${burn.up} times and fell ${burn.down} — embers go UP`);
  if (burn.early !== null && burn.mid !== null && !(burn.early < burn.mid * 0.75))
    fail(`sparks appear at ${burn.early.toFixed(3)} against ${burn.mid.toFixed(3)} mid-life — they must brighten out of the flame`);
  if (burn.late !== null && burn.mid !== null && !(burn.late < burn.mid * 0.4))
    fail(`sparks end at ${burn.late.toFixed(3)} against ${burn.mid.toFixed(3)} mid-life — they must cool away, not switch off`);

  /* ---- AND NOTHING OVER A LIGHT THAT IS NOT A FIRE ----
   * The arm above only says sparks came from something the effect CALLS a fire.
   * This one stands where lights are present and none of them burns, and
   * requires silence — without it the whole feature could be "spark over every
   * light" and every test above would still pass. */
  if (!found.coldSeen) console.log("cold: no view with lights but no fires was found — discrimination not exercised");
  else {
    const cold = await page.evaluate(async (spot) => {
      const step = () => new Promise((r) => requestAnimationFrame(r));
      window.__ml.teleport(spot.col, spot.row);
      for (let i = 0; i < 150; i++) await step();
      let sparks = 0, lights = 0, fires = 0;
      for (let i = 0; i < 200; i++) {
        const d = window.__mlAmbient.debug("embers");
        sparks = Math.max(sparks, d.sparks);
        lights = Math.max(lights, d.lights);
        fires = Math.max(fires, d.fires);
        await step();
      }
      return { sparks, lights, fires };
    }, found.coldSeen);
    console.log(`cold: ${cold.lights} light(s) in view, ${cold.fires} fires, ${cold.sparks} sparks`);
    if (cold.fires === 0 && cold.sparks)
      fail(`${cold.sparks} sparks over ${cold.lights} light(s) that are not fires — embers belong over FIRE`);
    if (!cold.lights) console.log("cold: the view had no lights after all — discrimination not exercised");
  }
}

/* ---- COST ---- */
const cost = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  window.__mlAmbient.cost(true);
  const p0 = window.__mlAmbient.debug("embers").probes;
  const t0 = performance.now();
  for (let i = 0; i < 360; i++) await step();
  const night = window.__mlAmbient.cost(true).embers;
  const perSecond = ((window.__mlAmbient.debug("embers").probes - p0) * 1000) / (performance.now() - t0);
  return { night, perSecond: +perSecond.toFixed(2) };
});
console.log(`cost: ${cost.night.ms} ms/frame (peak ${cost.night.peak}) over ${cost.night.frames} frames; light reads ${cost.perSecond}/s`);
if (!(cost.night.frames > 100)) fail(`only ${cost.night.frames} frames measured — the cost check proved nothing`);
if (cost.night.ms > COST_MS) fail(`embers cost ${cost.night.ms} ms/frame (ceiling ${COST_MS})`);
if (cost.perSecond > PROBES_PER_S) fail(`the light list is read ${cost.perSecond}/s — it walks every source and must stay throttled`);

await browser.close();
console.log(failed ? "verify-embers: FAILED" : "verify-embers: OK");
if (failed) process.exitCode = 1;
