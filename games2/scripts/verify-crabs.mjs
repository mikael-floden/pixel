// Browser gate for BEACH CRABS — the sideways scuttle at the water's edge.
//
// Two of these arms exist because the maintainer asked for them by name
// (2026-09-07): "make sure the effect is toggleable in settings this time" and
// "make sure the game FPS is not slowed down by this effect".
//
//   TOGGLEABLE is asserted through the REAL SETTINGS UI — the row is found in
//   the DOM by the label he would read, clicked like he would click it, and the
//   effect has to start and stop drawing. Asserting the API underneath would
//   not have caught a missing row.
//
//   FPS is asserted three ways, because "it feels fine here" is not a
//   measurement: the feature's own per-frame cost, its PROBE rate, and — the
//   real worst case — its SEARCH rate while standing somewhere with no beach at
//   all, where a naive version would hunt for a shoreline every frame forever.
//
//   node scripts/verify-crabs.mjs        (needs the dev stack on :5173)
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
const PROBES_PER_S = 90; // a bounded beach search, plus one ground probe per dash
const SEARCH_PER_S = 1.2; // PLACE_MS is 1500 — this is the inland worst case

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("crabs")))) fail("crabs is not registered");

/* ---- IT IS IN THE SETTINGS MENU, AND THE SWITCH WORKS ---- */
const ui = await page.evaluate(async () => {
  // Open Settings the way a player does.
  const tab = [...document.querySelectorAll(".ml-tab")].find(
    (b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings",
  );
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const rows = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')];
  const labels = rows.map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  const i = labels.findIndex((t) => t.toLowerCase().startsWith("crabs"));
  return { rows: rows.length, labels, found: i >= 0, label: i >= 0 ? labels[i] : null };
});
if (ui.error) fail(ui.error);
else {
  console.log(`settings: ${ui.rows} ambient rows — ${ui.found ? `"${ui.label}" is one of them` : "NO crabs row"}`);
  if (!ui.found) fail(`no "Crabs" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
}

// Clicking that row must actually start and stop the effect.
const toggled = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  const rowFor = (name) =>
    [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')].find((r) =>
      (r.querySelector(".ml-amb-label")?.textContent || "").toLowerCase().startsWith(name),
    );
  // Everything else off, so only the click under test can draw anything.
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, false);
  for (let i = 0; i < 60; i++) await step();
  const row = rowFor("crabs");
  if (!row) return null;
  row.click();
  for (let i = 0; i < 90; i++) await step();
  const onState = window.__mlAmbient.effects().find((e) => e.name === "crabs");
  const onGain = window.__mlAmbient.debug("crabs").gain;
  row.click();
  for (let i = 0; i < 240; i++) await step();
  const offState = window.__mlAmbient.effects().find((e) => e.name === "crabs");
  const d = window.__mlAmbient.debug("crabs");
  return { onEnabled: !!onState?.enabled, onGain, offEnabled: !!offState?.enabled, offGain: d.gain, offCrabs: d.crabs };
});
if (!toggled) fail("could not click the Crabs row");
else {
  console.log(
    `toggle: click on → enabled ${toggled.onEnabled} (gain ${toggled.onGain}); ` +
      `click off → enabled ${toggled.offEnabled} (gain ${toggled.offGain}, ${toggled.offCrabs} drawn)`,
  );
  if (!toggled.onEnabled) fail("clicking the Crabs row did not enable the effect");
  if (!(toggled.onGain > 0.5)) fail(`the effect did not come up after its switch was clicked (gain ${toggled.onGain})`);
  if (toggled.offEnabled) fail("clicking the Crabs row again did not disable the effect");
  if (toggled.offCrabs) fail(`${toggled.offCrabs} crabs still drawn after the switch was turned off`);
}

/* ---- A BEACH: on the sand, beside the water ---- */
await page.evaluate(async () => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "crabs");
});

// Walk out from the spawn until the feature itself reports it found a beach —
// derived, never a named cell.
const found = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  const me = window.__ml.me();
  const c0 = Math.round(me.x / 32);
  const r0 = Math.round(me.y / 32);
  for (let ring = 0; ring <= 60; ring += 5)
    for (let a = 0; a < 12; a++) {
      const c = c0 + Math.round(Math.cos((a / 12) * 6.283) * ring);
      const r = r0 + Math.round(Math.sin((a / 12) * 6.283) * ring);
      window.__ml.teleport(c, r);
      for (let i = 0; i < 130; i++) await step();
      const d = window.__mlAmbient.debug("crabs");
      if (d.colony && d.crabs) return { col: c, row: r, colony: d.colony, crabs: d.crabs };
    }
  return null;
});
if (!found) fail("no beach found anywhere near the spawn — the effect never placed a colony");
else {
  console.log(
    `beach at ${found.col},${found.row}: ${found.crabs} crabs, shore axis [${found.colony.shore}], ` +
      `water lies [${found.colony.toWater}], span ${found.colony.span}px, sand: ${found.colony.sandy}`,
  );

  const beach = await page.evaluate(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    let onLand = 0, onWater = 0, samples = 0;
    let alongOk = 0, alongBad = 0, moves = 0;
    const prev = new Map();
    let nearWater = null;
    for (let i = 0; i < 220; i++) {
      const d = window.__mlAmbient.debug("crabs");
      const c = d.colony;
      if (c) {
        if (nearWater === null) {
          // Is there really water beside this colony? (its own search says so —
          // this asks the game again, independently)
          nearWater = false;
          for (let k = 1; k <= 5 && !nearWater; k++)
            if (window.__ml.waterAtScreen(c.x + c.toWater[0] * 16 * k, c.y + c.toWater[1] * 16 * k)) nearWater = 16 * k;
        }
        for (const q of d.all || []) {
          samples++;
          if (window.__ml.landableAtScreen(q.x, q.y)) onLand++;
          if (window.__ml.waterAtScreen(q.x, q.y)) onWater++;
          // THE RUNS SHARE ONE AXIS — that is what makes it a crab and not a bug.
          const p = prev.get(q.s + ":" + q.dir);
          const last = prev.get("p" + (d.all || []).indexOf(q));
          if (last) {
            const dx = q.x - last[0];
            const dy = q.y - last[1];
            const len = Math.hypot(dx, dy);
            if (len > 1.2) {
              moves++;
              const dot = Math.abs((dx / len) * c.shore[0] + (dy / len) * c.shore[1]);
              if (dot > 0.9) alongOk++; else alongBad++;
            }
          }
          void p;
        }
        (d.all || []).forEach((q, j) => prev.set("p" + j, [q.x, q.y]));
      }
      await step();
    }
    return { onLand, onWater, samples, alongOk, alongBad, moves, nearWater };
  });
  console.log(
    `crabs: ${beach.samples} samples, ${beach.onLand} on land, ${beach.onWater} on water; ` +
      `water ${beach.nearWater === false ? "NOT FOUND" : beach.nearWater + "px"} from the colony; ` +
      `${beach.alongOk} of ${beach.moves} runs along the shore axis`,
  );
  if (!beach.samples) fail("no crabs to measure");
  if (beach.onWater) fail(`${beach.onWater} crab samples were standing on water`);
  if (beach.onLand < beach.samples) fail(`${beach.samples - beach.onLand} crab samples were off walkable ground`);
  if (beach.nearWater === false) fail("the colony is not beside water — these are BEACH crabs");
  if (!beach.moves) fail("no crab ever ran — the dash is the effect");
  if (beach.alongBad > beach.moves * 0.05)
    fail(`${beach.alongBad} of ${beach.moves} runs were off the shore axis — crabs run ALONG the water`);

  /* ---- THE WHOLE BEACH MOVES AT ONCE ---- */
  const flee = await page.evaluate(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    const d0 = window.__mlAmbient.debug("crabs");
    const c = d0.colony;
    if (!c) return null;
    let calm = 0;
    for (let i = 0; i < 90; i++) { calm = Math.max(calm, window.__mlAmbient.debug("crabs").dashing); await step(); }
    const at = window.__ml.pickAt(c.x, c.y); // WORLD UNITS; teleport takes CELLS
    if (!at) return null;
    window.__ml.teleport(at.x / 32, at.y / 32);
    let spooked = 0;
    for (let i = 0; i < 60; i++) { spooked = Math.max(spooked, window.__mlAmbient.debug("crabs").dashing); await step(); }
    return { calm, spooked, n: (window.__mlAmbient.debug("crabs").all || []).length };
  });
  if (!flee) fail("could not measure the flee (no colony)");
  else {
    console.log(`flee: at most ${flee.calm} of ${flee.n} running while left alone, ${flee.spooked} once stood on`);
    if (!(flee.spooked > flee.calm)) fail(`walking onto the colony did not set it running (${flee.calm} -> ${flee.spooked})`);
  }
}

/* ---- FPS: cost, probe rate, and the inland worst case ---- */
const cost = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  window.__mlAmbient.cost(true);
  const p0 = window.__mlAmbient.debug("crabs").probes;
  const t0 = performance.now();
  for (let i = 0; i < 360; i++) await step();
  const beach = window.__mlAmbient.cost(true).crabs;
  const probesPerS = ((window.__mlAmbient.debug("crabs").probes - p0) * 1000) / (performance.now() - t0);

  // THE WORST CASE IS INLAND: no beach to find, so the search can never
  // succeed. Walk somewhere with no water in view and measure the hunt.
  const me = window.__ml.me();
  let inland = null;
  for (let ring = 8; ring <= 60 && !inland; ring += 6)
    for (let a = 0; a < 12 && !inland; a++) {
      const c = Math.round(me.x / 32) + Math.round(Math.cos((a / 12) * 6.283) * ring);
      const r = Math.round(me.y / 32) + Math.round(Math.sin((a / 12) * 6.283) * ring);
      window.__ml.teleport(c, r);
      for (let i = 0; i < 60; i++) await step();
      const d = window.__mlAmbient.debug("crabs");
      const v = window.__ml.camView();
      let wet = false;
      for (let gx = 0; gx < 6 && !wet; gx++)
        for (let gy = 0; gy < 6 && !wet; gy++)
          if (window.__ml.waterAtScreen(v.x + (v.w * gx) / 5, v.y + (v.h * gy) / 5)) wet = true;
      if (!wet && !d.colony) inland = { col: c, row: r };
    }
  if (!inland) return { beach, probesPerS: +probesPerS.toFixed(1), inland: null };
  window.__mlAmbient.cost(true);
  const s0 = window.__mlAmbient.debug("crabs").searches;
  const t1 = performance.now();
  for (let i = 0; i < 300; i++) await step();
  const dry = window.__mlAmbient.cost(true).crabs;
  const searchPerS = ((window.__mlAmbient.debug("crabs").searches - s0) * 1000) / (performance.now() - t1);
  return { beach, probesPerS: +probesPerS.toFixed(1), inland: { ...inland, dry, searchPerS: +searchPerS.toFixed(2) } };
});
console.log(
  `cost: on the beach ${cost.beach.ms} ms/frame (peak ${cost.beach.peak}) over ${cost.beach.frames} frames, ` +
    `${cost.probesPerS} probes/s`,
);
if (!(cost.beach.frames > 100)) fail(`only ${cost.beach.frames} frames measured — the cost check proved nothing`);
if (cost.beach.ms > COST_MS) fail(`crabs cost ${cost.beach.ms} ms/frame on a beach (ceiling ${COST_MS})`);
if (cost.probesPerS > PROBES_PER_S) fail(`crabs probe the world ${cost.probesPerS} times a second (ceiling ${PROBES_PER_S})`);
if (!cost.inland) console.log("inland: no beachless spot found near the spawn — worst case not exercised");
else {
  console.log(
    `inland (${cost.inland.col},${cost.inland.row}): ${cost.inland.dry.ms} ms/frame, ` +
      `${cost.inland.searchPerS} beach searches/s`,
  );
  if (cost.inland.dry.ms > COST_MS) fail(`crabs cost ${cost.inland.dry.ms} ms/frame INLAND, where they draw nothing`);
  if (cost.inland.searchPerS > SEARCH_PER_S)
    fail(`crabs hunt for a beach ${cost.inland.searchPerS} times a second with none in view — it must be rate-limited`);
}

await browser.close();
console.log(failed ? "verify-crabs: FAILED" : "verify-crabs: OK");
if (failed) process.exitCode = 1;
