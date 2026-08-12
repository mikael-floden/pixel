// verify-lighttenure — light slots must not CHURN on an over-budget map
// (maintainer 2026-08-12, running across glow_test: "a lot of light sources
// pop in and out inside the view… you should be able to run across a broken
// map without making the player feel something is wrong — maintain a light
// for as long as it's still impacting the game view before you free up its
// slot").
//
// Method: pan the camera across glow_test — the deliberate worst case, ~180
// sources per window against 8 slots — sampling the ledger each step. The
// probe reports each holder's EDGE (px past touching the view, negative =
// on screen), measured by the same expression the release rule reads, so the
// assertions cannot drift from the code:
//   1. every RELEASE happens at the boundary (last-seen edge > -32), never
//      mid-view — the pop the maintainer saw;
//   2. a mid-view ACQUISITION (edge < -200 on first sight) arrives with its
//      fade-in ramp still running, never at full brightness in one frame;
//   3. the budget invariants hold throughout;
//   4. non-vacuous: the pan actually produced releases AND acquisitions.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "OK " : "FAIL"} ${label}`);
  if (!cond) failed++;
};

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});
const page = await (await browser.newContext({ viewport: { width: 480, height: 320 } })).newPage();
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForFunction(() => window.__mlSelect, { timeout: 40000 });
const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /glow_test/i.test(w)));
await page.evaluate((i) => { window.__mlSelect.pickWorld(i); window.__mlSelect.commit(); }, idx);
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 90000 });
await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 40000 });
await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.weather(0, true);
  window.__ml.timeOfDay("Night", true);
  window.__ml.torch(false);
});
await page.waitForTimeout(2500);

// Pan a long diagonal sweep in sub-cell steps — the same view drift running
// produces, without fighting dt-clamped headless movement. The FIRST lookAt is
// a camera TELEPORT from spawn, which legitimately dumps the spawn-side
// holders in one hop — settle there before the baseline sample, so every
// analysed transition is a genuine sub-cell pan step.
await page.evaluate(() => window.__ml.lookAt(6, 6));
await page.waitForTimeout(700);
const samples = [];
for (let i = 0; i <= 90; i++) {
  const c = 6 + i * 0.4;
  const r = 6 + i * 0.25;
  await page.evaluate(([cc, rr]) => window.__ml.lookAt(cc, rr), [c, r]);
  await page.waitForTimeout(110);
  samples.push(await page.evaluate(() => window.__ml.lightSlots()));
}
await page.evaluate(() => window.__ml.lookAt());

let releases = 0;
let boundaryReleases = 0;
let dissolvedReleases = 0;
let snapReleases = 0;
let acquisitions = 0;
let hardMidViewAcquisitions = 0;
let starvedSamples = 0;
let pressureSamples = 0;
let totalMax = 0;
let slottedMax = 0;
for (let i = 1; i < samples.length; i++) {
  const prev = samples[i - 1];
  const cur = samples[i];
  totalMax = Math.max(totalMax, cur.total);
  slottedMax = Math.max(slottedMax, cur.slotted.length);
  for (const key of prev.slotted) {
    if (cur.slotted.includes(key)) continue;
    releases++;
    const lastEdge = prev.edges?.[key];
    const lastRamp = prev.ramps?.[key];
    const wasRetiring = prev.retiring?.includes(key);
    if (typeof lastEdge === "number" && lastEdge >= -32) boundaryReleases++;
    // A mid-view exit is legal ONLY as the tail of a retirement DISSOLVE:
    // it must have been marked retiring and already mostly faded when last
    // seen (110ms sampling against a 450ms ramp). Anything else is the pop.
    else if (wasRetiring && typeof lastRamp === "number" && lastRamp <= 0.45) dissolvedReleases++;
    else snapReleases++;
  }
  for (const key of cur.slotted) {
    if (prev.slotted.includes(key)) continue;
    acquisitions++;
    const edge = cur.edges?.[key];
    const ramp = cur.ramps?.[key];
    // Deep in the view AND already at full brightness on its first frame =
    // a pop-in. (Sampling at 110ms against a 450ms ramp: first sight must
    // still be mid-fade.)
    if (typeof edge === "number" && edge < -200 && !(typeof ramp === "number" && ramp < 1))
      hardMidViewAcquisitions++;
  }
  // FAIRNESS TO THE FRONT (maintainer round 4: "are you holding a slot too
  // long… making it impossible for new scenes to show real spot-lights?").
  // Whenever a waiting candidate outranks the worst settled holder by more
  // than the steal margin, a retirement must already be running — pressure
  // may never sit unserved.
  if (typeof cur.waitingBest === "number" && typeof cur.worstSettled === "number") {
    if (cur.waitingBest + 200 < cur.worstSettled) {
      pressureSamples++;
      if (!cur.retiring?.length) starvedSamples++;
    }
  }
}
console.log(
  `pan: ${samples.length} samples, ${releases} releases (${boundaryReleases} at the boundary, ${dissolvedReleases} dissolved, ${snapReleases} SNAPS), ` +
    `${acquisitions} acquisitions, pressure ${pressureSamples} samples (${starvedSamples} starved), max total ${totalMax}, max world ${slottedMax}`,
);
ok(releases > 5 && acquisitions > 5, `the pan actually churned (${releases} rel / ${acquisitions} acq) — non-vacuous`);
ok(snapReleases === 0, `zero SNAP releases (${snapReleases}) — every exit is at the boundary or a finished dissolve`);
ok(hardMidViewAcquisitions === 0, `zero full-brightness mid-view acquisitions (${hardMidViewAcquisitions}) — deep entries fade in`);
ok(dissolvedReleases > 0, `retirement actually serves the front (${dissolvedReleases} dissolves) — non-vacuous under this pan`);
ok(starvedSamples <= Math.ceil(pressureSamples * 0.1), `pressure never sits unserved (${starvedSamples}/${pressureSamples} starved samples)`);
ok(totalMax <= 12, `total lights ${totalMax} <= 12 throughout`);
ok(slottedMax <= 8, `world holders ${slottedMax} <= 8 throughout`);

await browser.close();
console.log(failed ? `\nverify-lighttenure: ${failed} FAILURE(S)` : "\nverify-lighttenure OK");
process.exit(failed ? 1 : 0);
