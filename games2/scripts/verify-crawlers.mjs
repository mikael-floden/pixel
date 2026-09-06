// Browser gate for the GROUND CRAWLERS — ants and spiders.
//
// These are one and three pixels. There is no art to inspect and no screenshot
// that settles anything: at this size a wrong effect and a right one look
// identical in a still frame, and the maintainer's whole point in asking for
// them small was that the ANIMAL is not the readable part. What is readable is
// BEHAVIOUR, so behaviour is what this measures:
//
//   ANTS    must form a COLUMN along a trail, not a scatter — the trail is the
//           entire reason a 1px dot reads as an ant — and must walk on ground.
//   SPIDERS must SKITTER (dash, stop, dash) rather than glide, stay on ground,
//           and keep out of the player's lap.
//
//   node scripts/verify-crawlers.mjs        (needs the dev stack on :5173)
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

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });

const list = await page.evaluate(() => window.__mlAmbient.list());
for (const n of ["ants", "spiders"]) if (!list.includes(n)) fail(`${n} is not registered`);

// Open grass, clock frozen at Day, only the crawlers running.
await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "ants" || n === "spiders");
  window.__ml.teleport(416, 308);
});
await page.evaluate(async () => { for (let i = 0; i < 220; i++) await new Promise((r) => requestAnimationFrame(r)); });

// ---- ANTS: a column on real ground ----
const ants = await page.evaluate(async () => {
  const first = window.__mlAmbient.debug("ants");
  for (let i = 0; i < 70; i++) await new Promise((r) => requestAnimationFrame(r));
  const second = window.__mlAmbient.debug("ants");
  const onGround = (second.all || []).filter((a) => window.__ml.landableAtScreen(a.x, a.y)).length;
  return { first, second, onGround };
});
const A = ants.second.all || [];
console.log(`ants: ${A.length} on a ${ants.second.trail ? ants.second.trail.len : "?"}px trail, ${ants.onGround} on walkable ground`);
if (A.length < 6) fail(`only ${A.length} ants — too few to judge a column`);
if (A.length && ants.onGround < A.length) fail(`${A.length - ants.onGround} ants are off walkable ground`);

if (A.length >= 6) {
  // A COLUMN, not a cloud: spread along the principal axis must dominate the
  // spread across it. (A bowed trail keeps some cross-spread, hence 2.2x, not 10x.)
  const mx = A.reduce((s, a) => s + a.x, 0) / A.length;
  const my = A.reduce((s, a) => s + a.y, 0) / A.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const a of A) { const dx = a.x - mx, dy = a.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l2 = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const ratio = l2 > 1e-6 ? l1 / l2 : Infinity;
  console.log(`ants: column ratio ${ratio === Infinity ? "inf" : ratio.toFixed(1)} (spread along : across)`);
  if (!(ratio > 2.2)) fail(`ants are a cloud, not a column (ratio ${ratio.toFixed(2)})`);

  // And they must WALK it: t moves, and stays a valid parameter.
  const before = new Map((ants.first.all || []).map((a, i) => [i, a.t]));
  const moved = (ants.second.all || []).filter((a, i) => before.has(i) && Math.abs(a.t - before.get(i)) > 1e-4).length;
  console.log(`ants: ${moved} of ${A.length} advanced along the trail`);
  if (!(moved > A.length / 2)) fail("most ants are not moving along the trail");
  const bad = A.filter((a) => !(a.t >= 0 && a.t <= 1));
  if (bad.length) fail(`${bad.length} ants left the trail parameter (e.g. t=${bad[0].t})`);
}

// ---- SPIDERS: a skitter, on ground, out of the player's lap ----
const sp = await page.evaluate(async () => {
  const seenDash = new Set();
  const seenRest = new Set();
  let maxCount = 0;
  const offGround = [];
  const tooNear = [];
  for (let i = 0; i < 260; i++) {
    const d = window.__mlAmbient.debug("spiders");
    maxCount = Math.max(maxCount, d.spiders);
    const me = window.__ml.myScreen();
    const v = window.__ml.camView();
    const px = me ? v.x + me.sx / me.zoom : null;
    const py = me ? v.y + me.sy / me.zoom : null;
    for (let k = 0; k < (d.all || []).length; k++) {
      const s = d.all[k];
      (s.dashing ? seenDash : seenRest).add(k);
      if (!window.__ml.landableAtScreen(s.x, s.y)) offGround.push(s);
      if (px !== null && Math.hypot(s.x - px, s.y - py) < 30) tooNear.push(s);
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { dash: seenDash.size, rest: seenRest.size, maxCount, offGround: offGround.length, tooNear: tooNear.length };
});
console.log(`spiders: max ${sp.maxCount} at once; ${sp.dash} seen dashing, ${sp.rest} seen resting; ${sp.offGround} off-ground, ${sp.tooNear} in the player's lap`);
if (sp.maxCount === 0) fail("no spiders ever appeared");
if (sp.maxCount > 2) fail(`spiders are meant to be solitary, saw ${sp.maxCount}`);
if (sp.maxCount > 0 && (sp.dash === 0 || sp.rest === 0))
  fail(`spiders must SKITTER — saw dash:${sp.dash} rest:${sp.rest} (one of them never happened)`);
if (sp.offGround) fail(`${sp.offGround} spider samples were off walkable ground`);
if (sp.tooNear) fail(`${sp.tooNear} spider samples were in the player's lap`);

// ---- The env gate (AUTO mode, where fields are NOT forced) ----
// setEnabled() in manual mode calls setForced(), which deliberately bypasses
// the day/night gate so "select ants" shows ants. So the gate can only be
// tested with the director in auto.
const env = await page.evaluate(async () => {
  window.__mlAmbient.auto(true);
  const settle = async () => { for (let i = 0; i < 130; i++) await new Promise((r) => requestAnimationFrame(r)); };
  window.__ml.timeOfDay("Day", true); await settle();
  const day = { ants: window.__mlAmbient.debug("ants").gain, spiders: window.__mlAmbient.debug("spiders").gain };
  window.__ml.timeOfDay("Night", true); await settle();
  const night = { ants: window.__mlAmbient.debug("ants").gain, spiders: window.__mlAmbient.debug("spiders").gain };
  return { day, night };
});
console.log(`env gate — ants day ${env.day.ants} / night ${env.night.ants}; spiders day ${env.day.spiders} / night ${env.night.spiders}`);
if (!(env.day.ants > env.night.ants)) fail(`ants should forage by DAY (day ${env.day.ants} vs night ${env.night.ants})`);
if (!(env.night.spiders > env.day.spiders)) fail(`spiders should favour NIGHT (night ${env.night.spiders} vs day ${env.day.spiders})`);

await browser.close();
console.log(failed ? "verify-crawlers: FAILED" : "verify-crawlers: OK");
if (failed) process.exitCode = 1;
