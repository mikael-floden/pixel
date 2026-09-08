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
/* The off-axis allowance SCALES WITH THE COLUMN. The centroid of n oscillators
 * spread over radius r carries about r/sqrt(n) of standard error, so a fixed
 * pixel threshold silently tightens every time the column grows — and it grew,
 * when the maintainer asked for one that does not sit on a single tile. This is
 * the sway and flick, plus a few standard errors of that noise. */
const OFF_AXIS = (rx) => 8 + rx * 0.75;

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

/* ENABLING A FIELD IN THE SETTINGS *FORCES* IT — `Toggles.apply` calls
 * setForced(true), which is the whole point of the demo switch: you press it to
 * SEE the effect, not to watch it decide. So the dusk gate can only be measured
 * under AUTO, where fields self-gate on env. The first cut of this gate soloed
 * gnats and then asserted they were absent by day; it was measuring a forced
 * effect and reported gain 1 at every hour of the clock. */
const auto = () => page.evaluate(() => window.__mlAmbient.auto(true));
const solo = () =>
  page.evaluate(() => {
    window.__mlAmbient.auto(false);
    for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "gnats");
  });

if (spot) {
  // ---- DUSK ONLY (under AUTO — see above) ----
  await auto();
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

  /* ---- A COLUMN, ON GROUND, IN VIEW, AND STANDING STILL ----
   * DRIFT IS MEASURED WITHIN ONE PLACEMENT. A column expires after 16-44s and
   * stands somewhere else, which is the design; the first cut of this test took
   * the max spread over a whole sampling window and read that legitimate move
   * as an 88px wander. It is easy to sample across one here without noticing:
   * this harness renders far slower than real time, so a "3 second" window of
   * frames is more like fifteen. `places` counts successful placements, so the
   * run segments on it and judges the longest segment. */
  await solo(); // a column at all, whatever the sky is doing
  await settle("Evening");
  const shape = await page.evaluate(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    const segs = [];
    let cur = null;
    let lastPlaces = -1;
    let tall = 0, wide = 0, offGround = 0, offView = 0, samples = 0;
    let ratio = 0;
    for (let i = 0; i < 240; i++) {
      const d = window.__mlAmbient.debug("gnats");
      const all = (d.all || []).filter((q) => q.col === 0);
      if (d.places !== lastPlaces) { cur = []; segs.push(cur); lastPlaces = d.places; }
      const c0 = (d.cols || [])[0];
      if (all.length >= 6 && c0) {
        const mx = all.reduce((s, q) => s + q.x, 0) / all.length;
        const my = all.reduce((s, q) => s + q.y, 0) / all.length;
        // Offset of the swarm's centre from its own anchor, and the anchor.
        cur.push([mx, my, c0.x, c0.y, c0.h, c0.lift, c0.rx]);
        const sx = Math.sqrt(all.reduce((s, q) => s + (q.x - mx) ** 2, 0) / all.length);
        const sy = Math.sqrt(all.reduce((s, q) => s + (q.y - my) ** 2, 0) / all.length);
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
    const best = segs.sort((a, b) => b.length - a.length)[0] || [];
    /* THE ANCHOR IS THE COLUMN'S POSITION; the centroid of two dozen
     * independent oscillators is only a noisy estimate of it (n=24 over a 40px
     * volume is a standard error of ~2.4px, so its range over a long window is
     * a dozen px of pure sampling noise — the first cut of this test called
     * that "wandering"). So: the ANCHOR must not move at all inside one
     * placement, and the swarm must stay in a box around it. That catches a
     * column that TRANSLATES — the failure that would matter — without
     * fighting the noise. */
    let anchorMove = 0, offAxis = 0, outOfBand = 0, rx = 0;
    for (const [mx, my, ax, ay, h, lift, r] of best) {
      rx = Math.max(rx, r || 0);
      anchorMove = Math.max(anchorMove, Math.hypot(ax - best[0][2], ay - best[0][3]));
      offAxis = Math.max(offAxis, Math.abs(mx - ax));
      const top = ay - lift - h - 12;
      const bot = ay - lift + 12;
      if (my < top || my > bot) outOfBand++;
    }
    return {
      samples, tall, wide, ratio: +ratio.toFixed(2), rx,
      anchorMove: +anchorMove.toFixed(1), offAxis: +offAxis.toFixed(1), outOfBand,
      held: best.length, places: segs.length, offGround, offView,
    };
  });
  console.log(
    `column: ${shape.samples} samples over ${shape.places} placement(s), taller than wide in ${shape.tall} ` +
      `(last ratio ${shape.ratio}); within one placement the anchor moved ${shape.anchorMove}px and the swarm ` +
      `stayed within ${shape.offAxis}px of its axis (${shape.outOfBand} samples out of the height band); ` +
      `${shape.offGround} anchors off ground, ${shape.offView} off view`,
  );
  if (!shape.samples) fail("never saw a populated column to measure");
  // IT MUST NOT FIT ON ONE TILE. A tile draws 64px wide here; a column that
  // sits inside one is the thing he asked to be rid of.
  if (!(shape.rx * 2 >= 26)) fail(`the column is only ${(shape.rx * 2).toFixed(0)}px across — it reads as one tile`);
  if (shape.held < 30) fail(`only ${shape.held} samples of a single placement — the drift check proved nothing`);
  if (shape.wide > shape.tall / 4) fail(`${shape.wide} of ${shape.samples} samples were WIDER than tall — a column is vertical`);
  if (shape.anchorMove > 0.5) fail(`the column's anchor moved ${shape.anchorMove}px inside one placement — it must stand still`);
  if (shape.offAxis > OFF_AXIS(shape.rx))
    fail(`the swarm's centre strayed ${shape.offAxis}px from its own axis (allowed ${OFF_AXIS(shape.rx).toFixed(1)} at rx ${shape.rx}) — a column hangs over one spot`);
  if (shape.outOfBand > shape.held * 0.02)
    fail(`${shape.outOfBand} of ${shape.held} samples put the swarm outside its own column height`);
  if (shape.offGround) fail(`${shape.offGround} column anchors were not on dry ground`);
  if (shape.offView) fail(`${shape.offView} column anchors were outside the view`);

  // ---- WALK THROUGH IT ----
  const scatter = await page.evaluate(async ({ spot }) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    /* WIDTH IS THE HORIZONTAL SPREAD, and only that. Measuring the distance
     * from the ANCHOR mixes in the column's own height — the gnats ride 19-60px
     * above their anchor, so that "radius" read 92px on a column 11px wide and
     * a real doubling of the width moved it by a tenth. */
    const stateOf = () => {
      const d = window.__mlAmbient.debug("gnats");
      const all = (d.all || []).filter((q) => q.col === 0);
      const c = (d.cols || [])[0];
      if (all.length < 6 || !c) return null;
      return {
        w: all.reduce((s, q) => s + Math.abs(q.x - c.x), 0) / all.length,
        a: all.reduce((s, q) => s + q.a, 0) / all.length,
        scatter: c.scatter,
        at: window.__ml.pickAt(c.x, c.y),
      };
    };
    // STAND WELL CLEAR FIRST. A column can be placed right where the player is,
    // and then the "before" reading is already a scattered swarm — which is
    // what happened: before and after came out identical to three decimals.
    window.__ml.teleport(spot[0], spot[1]);
    let before = null;
    for (let i = 0; i < 300; i++) {
      const st = stateOf();
      if (st && st.scatter < 0.05 && st.at) { before = st; break; }
      await step();
    }
    if (!before) return null;
    // Stand in it. `pickAt` answers in WORLD UNITS and `teleport` takes CELLS —
    // measured, because passing the raw numbers walks off the end of the map
    // and the swarm you meant to disturb is then nowhere near you.
    window.__ml.teleport(before.at.x / 32, before.at.y / 32);
    let during = null;
    for (let i = 0; i < 150; i++) {
      const st = stateOf();
      if (st && st.scatter > 0.9) { during = st; break; }
      await step();
    }
    // And it must COME BACK — a swarm you walked through is still there when
    // you turn round.
    window.__ml.teleport(spot[0], spot[1]);
    let after = null;
    for (let i = 0; i < 400; i++) {
      const st = stateOf();
      if (st && st.scatter < 0.2) { after = st; break; }
      await step();
    }
    return { before, during, after };
  }, { spot });
  if (!scatter || !scatter.during) fail("could not measure the scatter (no undisturbed column to walk into)");
  else {
    const { before, during, after } = scatter;
    console.log(
      `scatter: half-width ${before.w.toFixed(1)} -> ${during.w.toFixed(1)}px, ` +
        `mean alpha ${before.a.toFixed(3)} -> ${during.a.toFixed(3)} (scatter ${before.scatter} -> ${during.scatter})` +
        (after ? `, re-formed to ${after.w.toFixed(1)}px at scatter ${after.scatter}` : ", NEVER re-formed"),
    );
    if (!(during.w > before.w * 1.25)) fail(`the swarm did not widen when walked through (${before.w.toFixed(1)} -> ${during.w.toFixed(1)}px)`);
    if (!(during.a < before.a * 0.9)) fail(`the swarm did not thin when walked through (alpha ${before.a.toFixed(3)} -> ${during.a.toFixed(3)})`);
    if (!after) fail("the swarm never re-formed after being walked through — it must still be there when you turn round");
  }

  // ---- COST ----
  await auto(); // the day arm only means anything when the env gate is live
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
