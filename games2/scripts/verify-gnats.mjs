// Browser gate for GNATS — the column that hangs over one spot at dusk.
//
// The whole effect is that it STANDS STILL. A swarm that drifts is dust, and
// this repo already has dust, so the centroid test below is not a detail: it is
// the feature. The rest asks what a midge column is — taller than it is wide,
// over dry ground, only at dusk, gone when you walk through it — plus the cost
// ceiling every ambient feature now carries.
//
//   node scripts/verify-gnats.mjs        (needs the dev stack on :5173)
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

const COST_MS = 0.45; // its own update, averaged — up to 52 pooled specks of trig
const DRIFT_PX = 14; // how far a column's centre may wander in 3 s (SWAY_PX is 3.5)

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("gnats")))) fail("gnats is not registered");

/* STAND ON GROUND. Derived, never named — a gate that names a cell is
 * measuring last week's map (the crawlers paid for that one). */
const spot = await page.evaluate(async () => {
  window.__ml.timeSpeed(0);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "gnats");
  const me = window.__ml.me();
  const c0 = Math.round(me.x / 32);
  const r0 = Math.round(me.y / 32);
  for (let ring = 0; ring < 40; ring += 3)
    for (let a = 0; a < 12; a++) {
      const c = c0 + Math.round(Math.cos((a / 12) * 6.283) * ring);
      const r = r0 + Math.round(Math.sin((a / 12) * 6.283) * ring);
      const s = window.__ml.surfaceAt(c * 32 + 16, r * 32 + 16);
      if (s && s.standable) return [c, r];
    }
  return null;
});
if (!spot) fail("no standable ground near the spawn — cannot exercise the effect");

const settle = async (phase, frames = 260) => {
  await page.evaluate(async ({ phase, frames, spot }) => {
    window.__ml.timeOfDay(phase, true);
    if (spot) window.__ml.teleport(spot[0], spot[1]);
    for (let i = 0; i < frames; i++) await new Promise((r) => requestAnimationFrame(r));
  }, { phase, frames, spot });
};

if (spot) {
  // ---- DUSK ONLY ----
  const byPhase = {};
  for (const phase of ["Evening", "Day", "Night", "Evening"]) {
    await settle(phase);
    byPhase[phase] = await page.evaluate(async () => {
      let most = 0;
      for (let i = 0; i < 90; i++) {
        most = Math.max(most, window.__mlAmbient.debug("gnats").gnats);
        await new Promise((r) => requestAnimationFrame(r));
      }
      const d = window.__mlAmbient.debug("gnats");
      return { most, gain: d.gain, phase: d.phase, columns: d.columns, placeFails: d.placeFails };
    });
    console.log(
      `${phase}: up to ${byPhase[phase].most} gnats in ${byPhase[phase].columns} column(s), gain ${byPhase[phase].gain}` +
        (byPhase[phase].placeFails ? `, ${byPhase[phase].placeFails} failed placements` : ""),
    );
  }
  if (!byPhase.Evening.most) fail("no gnats at dusk — the effect never appears");
  if (byPhase.Day.most) fail(`${byPhase.Day.most} gnats in broad daylight — this is a dusk effect`);
  if (byPhase.Night.most) fail(`${byPhase.Night.most} gnats after dark — this is a dusk effect`);

  // ---- A COLUMN, ON GROUND, IN VIEW, AND STANDING STILL ----
  const shape = await page.evaluate(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    // Centroid of one column's own gnats, sampled over 3 seconds.
    const track = [];
    let tall = 0, wide = 0, offGround = 0, offView = 0, samples = 0;
    let ratio = 0;
    for (let i = 0; i < 180; i++) {
      const d = window.__mlAmbient.debug("gnats");
      const all = d.all || [];
      const c0 = all.filter((q) => q.col === 0);
      if (c0.length >= 6) {
        const mx = c0.reduce((s, q) => s + q.x, 0) / c0.length;
        const my = c0.reduce((s, q) => s + q.y, 0) / c0.length;
        track.push([mx, my]);
        const sx = Math.sqrt(c0.reduce((s, q) => s + (q.x - mx) ** 2, 0) / c0.length);
        const sy = Math.sqrt(c0.reduce((s, q) => s + (q.y - my) ** 2, 0) / c0.length);
        if (sy > sx) tall++; else wide++;
        ratio = sy / Math.max(0.001, sx);
        samples++;
      }
      const v = window.__ml.camView();
      for (const c of d.cols || []) {
        if (!window.__ml.landableAtScreen(c.x, c.y)) offGround++;
        if (c.x < v.x || c.x > v.x + v.w || c.y < v.y || c.y > v.y + v.h) offView++;
      }
      await step();
    }
    let drift = 0;
    for (const [x, y] of track) for (const [x2, y2] of track) drift = Math.max(drift, Math.hypot(x - x2, y - y2));
    return { samples, tall, wide, ratio: +ratio.toFixed(2), drift: +drift.toFixed(1), offGround, offView };
  });
  console.log(
    `column: ${shape.samples} samples, taller than wide in ${shape.tall} (last ratio ${shape.ratio}), ` +
      `centre wandered ${shape.drift}px, ${shape.offGround} anchors off ground, ${shape.offView} off view`,
  );
  if (!shape.samples) fail("never saw a populated column to measure");
  if (shape.wide > shape.tall / 4) fail(`${shape.wide} of ${shape.samples} samples were WIDER than tall — a column is vertical`);
  if (shape.drift > DRIFT_PX) fail(`the column wandered ${shape.drift}px — a gnat column stands still (that is the effect)`);
  if (shape.offGround) fail(`${shape.offGround} column anchors were not on dry ground`);
  if (shape.offView) fail(`${shape.offView} column anchors were outside the view`);

  // ---- WALK THROUGH IT ----
  const scatter = await page.evaluate(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    const spreadOf = () => {
      const d = window.__mlAmbient.debug("gnats");
      const all = (d.all || []).filter((q) => q.col === 0);
      if (all.length < 6) return null;
      const c = (d.cols || [])[0];
      if (!c) return null;
      const r = all.reduce((s, q) => s + Math.hypot(q.x - c.x, (q.y - c.y) / 0.55), 0) / all.length;
      const a = all.reduce((s, q) => s + q.a, 0) / all.length;
      return { r, a, scatter: c.scatter, cell: window.__ml.pickAt(c.x, c.y) };
    };
    let before = null;
    for (let i = 0; i < 200 && !before; i++) { before = spreadOf(); if (!before) await step(); }
    if (!before || !before.cell) return null;
    // Stand in it.
    window.__ml.teleport(before.cell.x, before.cell.y);
    for (let i = 0; i < 60; i++) await step();
    const during = spreadOf();
    return { before, during };
  });
  if (!scatter || !scatter.during) fail("could not measure the scatter (no column to walk into)");
  else {
    const { before, during } = scatter;
    console.log(
      `scatter: spread ${before.r.toFixed(1)} -> ${during.r.toFixed(1)}px, ` +
        `mean alpha ${before.a.toFixed(3)} -> ${during.a.toFixed(3)} (scatter ${during.scatter})`,
    );
    if (!(during.scatter > 0.5)) fail(`standing in the column left scatter at ${during.scatter} — walking through must break it up`);
    if (!(during.r > before.r * 1.15)) fail(`the swarm did not widen when walked through (${before.r.toFixed(1)} -> ${during.r.toFixed(1)}px)`);
    if (!(during.a < before.a)) fail(`the swarm did not thin when walked through (alpha ${before.a.toFixed(3)} -> ${during.a.toFixed(3)})`);
  }

  // ---- COST ----
  const cost = await page.evaluate(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    window.__ml.timeOfDay("Evening", true);
    for (let i = 0; i < 180; i++) await step();
    window.__mlAmbient.cost(true);
    for (let i = 0; i < 360; i++) await step();
    const dusk = window.__mlAmbient.cost(true).gnats;
    window.__ml.timeOfDay("Day", true);
    for (let i = 0; i < 220; i++) await step();
    window.__mlAmbient.cost(true);
    for (let i = 0; i < 300; i++) await step();
    return { dusk, day: window.__mlAmbient.cost(true).gnats };
  });
  console.log(`cost: dusk ${cost.dusk.ms} ms/frame (peak ${cost.dusk.peak}) over ${cost.dusk.frames} frames; day ${cost.day.ms} ms/frame`);
  if (!(cost.dusk.frames > 100)) fail(`only ${cost.dusk.frames} frames measured — the cost check proved nothing`);
  if (cost.dusk.ms > COST_MS) fail(`gnats cost ${cost.dusk.ms} ms/frame at dusk (ceiling ${COST_MS})`);
  if (cost.day.ms > COST_MS / 3) fail(`gnats cost ${cost.day.ms} ms/frame BY DAY — it must return before doing anything`);
}

await browser.close();
console.log(failed ? "verify-gnats: FAILED" : "verify-gnats: OK");
if (failed) process.exitCode = 1;
