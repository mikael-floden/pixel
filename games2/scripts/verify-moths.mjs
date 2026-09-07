// Browser gate for MOTHS — the thing that circles a lamp after dark.
//
// Two questions, and the second one is why this gate exists at all:
//
//   1. IS IT A MOTH? It must be at a LAMP (orbiting it, not floating near it),
//      only after dark, and it must bump the lamp now and then — the dive is
//      what makes two pixels read as an insect rather than as a dot.
//   2. DOES IT COST A FRAME? "Make sure the game doesn't start to lag just
//      because of this feature" (maintainer 2026-09-07). Frame time in a
//      software-GL harness is far too noisy to see a 0.2 ms effect inside it,
//      so the ambient runtime times each feature's own update and this asserts
//      THAT — plus the probe count, because the one expensive call here (the
//      lamp list walks every source in the world) is throttled by design and a
//      regression would show up as calls per second, not as milliseconds.
//
//   node scripts/verify-moths.mjs        (needs the dev stack on :5173)
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

// The whole feature's own update, averaged over a window. It draws at most ten
// 2px marks and does trig on them, so this is a generous ceiling, not a target.
const COST_MS = 0.35;
const PROBES_PER_S = 4; // the lamp list is read ~2/s by design

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("moths")))) fail("moths is not registered");
if (!(await page.evaluate(() => typeof window.__ml.lightsInView === "function")))
  fail("__ml.lightsInView is missing — the feature cannot find a lamp");

/* WHERE THE LAMPS ARE. Derived, never written down: walk out from the spawn
 * and stop where the game reports lit sources in view. A gate that names a
 * cell is measuring last week's map. */
const spot = await page.evaluate(async () => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Night", true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "moths");
  const me = window.__ml.me();
  const c0 = Math.round(me.x / 32);
  const r0 = Math.round(me.y / 32);
  let best = null;
  for (let ring = 0; ring <= 24 && !best; ring += 4)
    for (let a = 0; a < 12 && !best; a++) {
      const c = c0 + Math.round(Math.cos((a / 12) * 6.283) * ring);
      const r = r0 + Math.round(Math.sin((a / 12) * 6.283) * ring);
      window.__ml.teleport(c, r);
      for (let i = 0; i < 30; i++) await new Promise((res) => requestAnimationFrame(res));
      const lit = (window.__ml.lightsInView(64) || []).filter((l) => !l.sealed && l.r >= 1.5);
      if (lit.length) best = { col: c, row: r, lamps: lit.length };
    }
  return best;
});
if (!spot) fail("no lit lamp found near the spawn — cannot exercise the effect");
else console.log(`lamps: ${spot.lamps} in view at ${spot.col},${spot.row}`);

if (spot) {
  // ---- IS IT A MOTH? ----
  const seen = await page.evaluate(async () => {
    for (let i = 0; i < 260; i++) await new Promise((r) => requestAnimationFrame(r));
    let dived = 0;
    let offLamp = 0;
    let far = 0;
    let samples = 0;
    let most = 0;
    for (let i = 0; i < 320; i++) {
      const d = window.__mlAmbient.debug("moths");
      most = Math.max(most, d.moths);
      for (const m of d.all || []) {
        samples++;
        if (m.diving) dived++;
        const dx = m.x - m.lampX;
        const dy = (m.y - m.lampY) / 0.55; // the orbit is squashed on the iso plane
        const r = Math.hypot(dx, dy);
        if (r > 44) offLamp++; // wandered away from the lamp it belongs to
        if (r > 30) far++;
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { dived, offLamp, far, samples, most, probes: window.__mlAmbient.debug("moths").probes };
  });
  console.log(`moths: max ${seen.most} at once, ${seen.samples} samples, ${seen.dived} diving, ${seen.offLamp} off-lamp`);

  /* THEY CIRCLE THE LIGHT, NOT THE POST. A light record's anchor is its foot on
   * the ground and its `z` is the head's lift above that, so a consumer reading
   * the anchor puts the whole dance at the bottom of the lamp — which is what
   * shipped, and what the maintainer photographed on 2026-09-07. Containment
   * alone cannot catch it (the moths were perfectly contained around the wrong
   * point), so this asserts the two are DIFFERENT and that the moths are at the
   * head: it needs a lamp that actually has a lift, or it proves nothing. */
  const head = await page.evaluate(async () => {
    const lit = (window.__ml.lightsInView(64) || []).filter((l) => !l.sealed && l.r >= 1.5);
    const lifted = lit.filter((l) => l.z > 0.05 && l.footY - l.y > 6);
    let above = 0, below = 0, n = 0;
    for (let i = 0; i < 120; i++) {
      for (const m of window.__mlAmbient.debug("moths").all || []) {
        if (!(m.lampFootY - m.lampY > 6)) continue; // this lamp has no head lift to get wrong
        n++;
        if (m.y < m.lampFootY - 4) above++; else below++;
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { lamps: lit.length, lifted: lifted.length, lift: lifted[0] ? +(lifted[0].footY - lifted[0].y).toFixed(1) : 0, above, below, n };
  });
  console.log(
    `head: ${head.lifted} of ${head.lamps} lamps lift their light (first by ${head.lift}px); ` +
      `${head.above} of ${head.n} moth samples were up at the head`,
  );
  if (!head.lifted) fail("no lamp in view lifts its light above its anchor — cannot tell the head from the post here");
  else if (!head.n) fail("no moths were at a lifted lamp — the head check proved nothing");
  else if (head.below > head.n * 0.05)
    fail(`${head.below} of ${head.n} moth samples were down at the post's foot — they must circle the LIGHT`);
  if (!seen.samples) fail("no moths appeared at a lit lamp after dark");
  if (seen.most > 10) fail(`${seen.most} moths at once — the ceiling is 10`);
  if (seen.offLamp) fail(`${seen.offLamp} samples were more than 44px from their own lamp — they must ORBIT it`);
  if (!seen.dived) fail("no moth ever bumped the lamp — the dive is what makes it read as a moth");

  // ---- DOES IT COST A FRAME? ----
  const cost = await page.evaluate(async () => {
    window.__mlAmbient.cost(true); // reset
    for (let i = 0; i < 420; i++) await new Promise((r) => requestAnimationFrame(r));
    const night = window.__mlAmbient.cost(true).moths;
    const probes0 = window.__mlAmbient.debug("moths").probes;
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) await new Promise((r) => requestAnimationFrame(r));
    const perSecond = ((window.__mlAmbient.debug("moths").probes - probes0) * 1000) / (performance.now() - t0);
    // And by DAY it must cost nothing at all: the gain is 0, so the feature
    // returns before it reads anything.
    window.__ml.timeOfDay("Day", true);
    for (let i = 0; i < 200; i++) await new Promise((r) => requestAnimationFrame(r));
    window.__mlAmbient.cost(true);
    for (let i = 0; i < 300; i++) await new Promise((r) => requestAnimationFrame(r));
    const day = window.__mlAmbient.cost(true).moths;
    return { night, day, perSecond: +perSecond.toFixed(2) };
  });
  console.log(
    `cost: night ${cost.night.ms} ms/frame (peak ${cost.night.peak}) over ${cost.night.frames} frames; ` +
      `day ${cost.day.ms} ms/frame; lamp reads ${cost.perSecond}/s`,
  );
  if (!(cost.night.frames > 100)) fail(`only ${cost.night.frames} frames measured — the cost check proved nothing`);
  if (cost.night.ms > COST_MS) fail(`moths cost ${cost.night.ms} ms/frame at night (ceiling ${COST_MS})`);
  if (cost.day.ms > COST_MS / 3) fail(`moths cost ${cost.day.ms} ms/frame BY DAY — it must return before doing anything`);
  if (cost.perSecond > PROBES_PER_S)
    fail(`the lamp list is read ${cost.perSecond}/s — it walks every source in the world and must stay throttled`);
}

await browser.close();
console.log(failed ? "verify-moths: FAILED" : "verify-moths: OK");
if (failed) process.exitCode = 1;
