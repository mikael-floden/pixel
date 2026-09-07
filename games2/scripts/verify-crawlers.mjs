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
//   BOTH    must be ON SCREEN. This is the one property a "healthy" feature can
//           fail while every other number here looks perfect, and it did: the
//           features reported ants walking a valid trail on valid ground at
//           measured screen (-53, 238), off the left edge of a 480x198 world-px
//           view, for the whole 26-55 s of a trail's life (maintainer: "I can't
//           see the spider and ants"). A crawler nobody can see is not a
//           crawler, so the gate now asks the question directly.
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

/* WHERE TO STAND IS DERIVED, NEVER WRITTEN DOWN. This gate used to teleport to
 * cell 416,308 and it went stale the day the maps agent moved the coastline:
 * the cell became open sea, `landableAtScreen` answered false at all 144
 * sampled points of the view, and both features correctly drew nothing while
 * the gate reported them broken. A crawler gate that names cells is measuring
 * last week's map. So it asks the world where the land is — standable cells,
 * spaced well apart so one bad landing cannot decide the run. */
await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "ants" || n === "spiders");
});
const land = await page.evaluate(() => {
  const me = window.__ml.me();
  const c0 = Math.round(me.x / 32);
  const r0 = Math.round(me.y / 32);
  const w = window.__ml.worldInfo();
  const maxC = (w.w ?? 512) - 4;
  const maxR = (w.h ?? 512) - 4;
  const out = [];
  // Rings outward from where we joined, so the spots are near the spawn (where
  // the art is loaded) but spread over real ground.
  for (let ring = 0; ring < 60 && out.length < 4; ring += 3)
    for (let a = 0; a < 12 && out.length < 4; a++) {
      const c = Math.max(4, Math.min(maxC, c0 + Math.round(Math.cos((a / 12) * 6.283) * ring)));
      const r = Math.max(4, Math.min(maxR, r0 + Math.round(Math.sin((a / 12) * 6.283) * ring)));
      // surfaceAt takes WORLD UNITS, not cells (surfaceAtWorld) — passing
      // cells samples a 60x60 wu box at the map's corner, which is open sea,
      // and the scan then reports "no land anywhere".
      const s = window.__ml.surfaceAt(c * 32 + 16, r * 32 + 16);
      if (!s || !s.standable) continue;
      if (out.some((p) => Math.abs(p[0] - c) < 10 && Math.abs(p[1] - r) < 10)) continue;
      out.push([c, r]);
    }
  return out;
});
console.log(`land found: ${land.map(([c, r]) => `${c},${r}`).join("  ") || "NONE"}`);
if (land.length < 2) fail(`only ${land.length} standable spots found near the spawn — cannot exercise ground crawlers`);
await page.evaluate((spot) => window.__ml.teleport(spot[0], spot[1]), land[0] || [416, 308]);
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

// ---- ON SCREEN: the crawlers are where the player is looking ----
// Sampled over time, not once: a trail is laid inside the view and then WALKED,
// so the honest question is whether it stays in sight, not whether it started
// there. A creature may hang a little past the edge (that is what the features'
// own retirement margins allow, 24 px for a trail's extent and 40 for a
// spider); what must never happen is a whole population out of frame.
const onScreen = await page.evaluate(async () => {
  const out = { antBlind: 0, antSamples: 0, antWorst: 0, spBlind: 0, spSamples: 0, spWorst: 0 };
  // camView() answers {x, y, w, h} — NOT width/height. Reading the wrong names
  // gives NaN, every comparison against it is false, and the whole check passes
  // while measuring nothing; it did, once, on the very run it was written for.
  const outside = (m, v) => Math.max(v.x - m.x, m.x - (v.x + v.w), v.y - m.y, m.y - (v.y + v.h), 0);
  for (let i = 0; i < 400; i++) {
    const v = window.__ml.camView();
    for (const [key, blind, samples, worst] of [["ants", "antBlind", "antSamples", "antWorst"], ["spiders", "spBlind", "spSamples", "spWorst"]]) {
      const all = window.__mlAmbient.debug(key).all || [];
      if (!all.length) continue;
      out[samples]++;
      const dists = all.map((m) => outside(m, v));
      out[worst] = Math.max(out[worst], Math.min(...dists));
      if (Math.min(...dists) > 0) out[blind]++; // not one of them is in the view
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  return out;
});
console.log(
  `on screen — ants: ${onScreen.antBlind} of ${onScreen.antSamples} frames with none in view (worst ${onScreen.antWorst.toFixed(0)}px out); ` +
    `spiders: ${onScreen.spBlind} of ${onScreen.spSamples} (worst ${onScreen.spWorst.toFixed(0)}px out)`,
);
if (!(onScreen.antSamples > 100)) fail(`too few frames carried ants to judge visibility (${onScreen.antSamples})`);
// Guard the guard: a NaN here reads as "never outside" and passes everything.
if (!Number.isFinite(onScreen.antWorst) || !Number.isFinite(onScreen.spWorst))
  fail(`the on-screen distance did not compute (ants ${onScreen.antWorst}, spiders ${onScreen.spWorst})`);
if (onScreen.antBlind) fail(`${onScreen.antBlind} frames drew ants with NONE of them on screen`);
if (onScreen.spBlind) fail(`${onScreen.spBlind} frames drew a spider with NONE of them on screen`);
if (onScreen.antWorst > 24) fail(`the whole ant column sat ${onScreen.antWorst.toFixed(0)}px outside the view`);
if (onScreen.spWorst > 40) fail(`every spider sat ${onScreen.spWorst.toFixed(0)}px outside the view`);

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

/* ---- RUN SOMEWHERE NEW: the crawlers must FOLLOW ----
 * The population is simulated in the view; run away and the old one is behind
 * you, so the question is how long the new place stays empty (maintainer
 * 2026-09-07: "I see no spiders and ants if I run away to a different
 * location ... you can move the simulated ants and spiders to a new location").
 * Measured on the two failures this found: a spider was RETIRED 300 ms after
 * going out of frame and the next spawn waited 7-22 s, and an ant trail that
 * could not be laid at full span in the new terrain gave up rather than laying
 * a shorter one. Several hops, because one landing spot proves nothing about
 * the next. */
const RELOCATE_MS = 4000;
const hops = await page.evaluate(async ({ budgetMs, spots }) => {
  const out = [];
  for (const [col, row] of spots) {
    window.__ml.teleport(col, row);
    let antsAt = -1;
    let spidersAt = -1;
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs && (antsAt < 0 || spidersAt < 0)) {
      await new Promise((r) => requestAnimationFrame(r));
      const t = performance.now() - t0;
      if (antsAt < 0 && (window.__mlAmbient.debug("ants").all || []).length > 0) antsAt = t;
      if (spidersAt < 0 && (window.__mlAmbient.debug("spiders").all || []).length > 0) spidersAt = t;
    }
    out.push({ col, row, ants: Math.round(antsAt), spiders: Math.round(spidersAt) });
  }
  return out;
}, { budgetMs: RELOCATE_MS, spots: land });
for (const h of hops)
  console.log(`relocate to ${h.col},${h.row}: ants ${h.ants < 0 ? "NEVER" : h.ants + "ms"}, spiders ${h.spiders < 0 ? "NEVER" : h.spiders + "ms"}`);
const antSlow = hops.filter((h) => h.ants < 0);
const spiderSlow = hops.filter((h) => h.spiders < 0);
if (antSlow.length) fail(`ants never appeared within ${RELOCATE_MS}ms at ${antSlow.length} of ${hops.length} new locations`);
if (spiderSlow.length)
  fail(`spiders never appeared within ${RELOCATE_MS}ms at ${spiderSlow.length} of ${hops.length} new locations`);

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
