// Browser gate for DAWN MIST IN THE HOLLOWS — "ground fog pooling in the low
// ground near water at first light, burning off as the sun climbs" (the
// maintainer's pick, 2026-09-13, from the twenty offered).
//
// Five things to prove, each of them a way this could be wrong while every
// counter read correct:
//  1. IT IS AT YOUR FEET IN A HOLLOW AND NOT ON THE RIDGE. The whole effect is
//     "where", so the gate DERIVES a hollow and the world's summit from the
//     world doc — with its own arithmetic, independent of the model the unit
//     test pins — stands in each, and compares.
//     AND IT COUNTS WHAT IS NEAR THE PLAYER, not what is on screen. The first
//     cut counted patches in the VIEW and failed the effect for fogging a
//     summit: standing on a 46-level peak you look down over half the massif,
//     and the hollows in it are real. "The view from a ridge contains hollows"
//     is not the claim; "a ridge fogs" is, and only the fog around your own
//     feet can answer it.
//  2. IT IS JUST OVER THE DARKNESS OVERLAY — with `drips/`, `dust/` and the
//     fish rings, and NOT in the surface band, where it started. Down there it
//     sits under the terrain OCCLUDERS as well as the ground texture, so in a
//     grassy hollow the fog is behind the world: measured, nineteen banks at
//     alpha 0.45 moved the screen by one luma. Above the overlay it must also
//     stay BELOW the lit copies (900_001+), so a tree still stands in front of
//     the bank rather than the bank washing over it.
//  3. THE SUN BURNS IT OFF, and a CLOUDY sky THINS it. The second half is
//     backwards from every other weather-ish effect and is exactly the kind of
//     rule a later change "fixes" by accident, so it is asserted here as well
//     as in the unit test — against the game's own weather, not a fixture.
//  4. THE RING OF PICKS STAYS OFF THE FRAME. Finding a hollow costs eight
//     probes; doing that per frame is the one way this effect gets expensive.
//  5. IT IS ON THE SCREEN. Per-mark windows inside a clear area measured off
//     the DOM, with the same windows read with the effect OFF as the control.
//
//   node scripts/verify-dawnmist.mjs     (needs the dev stack on :5173)
import { chromium } from "playwright-core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

function chromePath() {
  const root = "/opt/pw-browsers";
  const c = existsSync(root)
    ? readdirSync(root).filter((d) => /^chromium(-\d+)?$/.test(d)).map((d) => join(root, d, "chrome-linux", "chrome"))
    : [];
  return [...c, join(root, "chromium")].find((p) => existsSync(p));
}

const URL = process.env.GAME_URL || "http://localhost:5173/";
const WORLD = process.env.WORLD || "the_game";
const COST_MS = 0.3;
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };

/* ---- WHERE THE HOLLOWS AND THE RIDGES ARE — the gate's OWN arithmetic ----
 * Deliberately not the model's `basin`: a gate that imports the thing it is
 * testing can only prove the code runs. This is the same IDEA (is the ground
 * around this point higher?) written independently, so agreeing with the
 * feature is evidence. */
const worldDoc = (() => {
  const f = join("..", "maps2", "worlds3", WORLD, "world.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
})();
if (!worldDoc) fail(`could not read the world doc for ${WORLD}`);
const places = (() => {
  if (!worldDoc) return { hollows: [], ridges: [] };
  const W = worldDoc.size.w, H = worldDoc.size.h;
  const lvl = worldDoc.level, gnd = worldDoc.ground, land = worldDoc.land;
  const liq = new Set(worldDoc.liquids.map((n) => worldDoc.grounds.indexOf(n)).filter((i) => i >= 0));
  const at = (x, y) => (x >= 0 && x < W && y >= 0 && y < H ? lvl[y][x] : null);
  const scored = [];
  for (let y = land.y0 + 4; y < land.y1 - 4; y += 2)
    for (let x = land.x0 + 4; x < land.x1 - 4; x += 2) {
      if (liq.has(gnd[y][x])) continue;
      const c = lvl[y][x];
      let up = 0, down = 0, n = 0;
      for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2], [2, -2], [-2, 2]]) {
        const l = at(x + dx, y + dy);
        if (l === null) continue;
        n++;
        if (l > c) up++;
        else if (l < c) down++;
      }
      if (!n) continue;
      scored.push({ x, y, l: c, up: up / n, down: down / n });
    }
  // A hollow: nearly the whole ring above it. A ridge: nearly the whole ring
  // below it, and high up, so the view from it is a hillside and not a basin.
  const hollows = scored.filter((s) => s.up >= 0.75).sort((a, b) => b.up - a.up);
  const ridges = scored.filter((s) => s.down >= 0.85 && s.l >= 6).sort((a, b) => b.l - a.l);
  return { hollows, ridges };
})();
console.log(
  `${WORLD}: ${places.hollows.length} strong hollows, ${places.ridges.length} ridges` +
    (places.hollows[0] ? ` — deepest at ${places.hollows[0].x},${places.hollows[0].y} (level ${places.hollows[0].l})` : ""),
);
if (!places.hollows.length) fail("the world has no hollow to stand in — the gate proved nothing");
if (!places.ridges.length) fail("the world has no ridge to falsify against — the gate proved nothing");

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate((w) => {
  const i = window.__mlSelect.worlds().findIndex((n) => n === w);
  if (i >= 0) window.__mlSelect.pickWorld(i);
  window.__mlSelect.commit();
}, WORLD);
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });

/* ---- REGISTERED, AND IN THE SETTINGS LIST THE PLAYER READS ---- */
if (!(await page.evaluate(() => window.__mlAmbient.list().includes("dawnmist")))) fail("dawnmist is not registered");
const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find((b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings");
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')]
    .map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("dawnmist")) };
});
if (ui.error) fail(ui.error);
else if (!ui.found) fail(`no "Dawnmist" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
else console.log(`settings: ${ui.labels.length} ambient rows, "Dawnmist" is one of them`);

/* MANUAL, with dawnmist the only one on. `setEnabled` is REFUSED when an
 * incompatible effect is enabled and CHANGES NOTHING, so the result is read
 * rather than assumed (the chimney gate's lesson: a suppressed field reads
 * zero on every counter below and looks like a broken feature). */
const sel = await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) if (n !== "dawnmist") window.__mlAmbient.setEnabled(n, false);
  const r = window.__mlAmbient.setEnabled("dawnmist", true);
  const e = window.__mlAmbient.effects().find((f) => f.name === "dawnmist");
  return { r, on: e?.on, enabled: e?.enabled, blockedBy: e?.blockedBy ?? null };
});
console.log(`select: dawnmist enabled=${sel.enabled} on=${sel.on} blockedBy=${sel.blockedBy} (setEnabled ${JSON.stringify(sel.r)})`);
if (!sel.enabled) fail(`dawnmist could not be switched on${sel.blockedBy ? ` — blocked by ${sel.blockedBy}` : ""}`);

/* ---- THE SKY RULE ----
 * The unforced `weight`, which the debug block publishes for exactly this: in
 * MANUAL mode a selected field is FORCED, so `gain` reads 1 at noon and proves
 * nothing. The clock is re-applied until the feature's own reported sun agrees
 * — the server rebroadcasts world time over a local override. */
/* DAWN IS THE START OF "Morning", NOT ITS MIDDLE. `timeOfDay(which, instant,
 * phaseT)` lands at phaseT 0.5 by default, and the middle of the game's
 * Morning is already full daylight — the first cut of this arm asked for
 * "Morning" and measured weight 0, which is the model being RIGHT about a
 * bright sky and the gate being wrong about what it had asked for. The
 * sunrise ramp is phaseT 0 of Morning, and it is the whole subject here. */
const atSky = async (phase, weatherIdx, phaseT = 0.5) =>
  page.evaluate(async ({ p, wx, t }) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    for (let tries = 0; tries < 8; tries++) {
      window.__ml.timeSpeed(0);
      window.__ml.timeOfDay(p, true, t);
      if (wx !== null) window.__ml.weather(wx, true);
      for (let i = 0; i < 60; i++) await step();
      const d = window.__mlAmbient.debug("dawnmist");
      const want = p === "Day" ? d.sun > 0.8 : p === "Night" ? d.sun < 0.2 : true;
      if (want) return { sun: d.sun, phase: d.phase, cloud: d.cloud, rain: d.rain, weight: d.weight };
    }
    const d = window.__mlAmbient.debug("dawnmist");
    return { sun: d.sun, phase: d.phase, cloud: d.cloud, rain: d.rain, weight: d.weight, stuck: true };
  }, { p: phase, wx: weatherIdx, t: phaseT });

const clearNight = await atSky("Night", 0);
const dawn = await atSky("Morning", 0, 0);
const midMorning = await atSky("Morning", 0, 0.6);
const noon = await atSky("Day", 0);
const cloudy = await atSky("Night", 1);
console.log(
  `sky: night ${clearNight.weight} (sun ${clearNight.sun}) | dawn ${dawn.weight} (sun ${dawn.sun}) | ` +
    `mid-morning ${midMorning.weight} (sun ${midMorning.sun}) | noon ${noon.weight} (sun ${noon.sun}) | ` +
    `cloudy night ${cloudy.weight} (cloud ${cloudy.cloud})`,
);
if (clearNight.stuck || noon.stuck) fail(`could not hold the clock (night sun ${clearNight.sun}, day sun ${noon.sun})`);
if (!(clearNight.weight > 0.5)) fail(`the fog does not form on a clear night (weight ${clearNight.weight})`);
if (!(noon.weight < 0.05)) fail(`the sun does not burn it off (weight ${noon.weight} at sun ${noon.sun})`);
// THE ASK, in one line: it is there at first light and gone as the sun climbs.
if (!(dawn.sun < midMorning.sun))
  console.log(`sky: the clock did not separate dawn from mid-morning (sun ${dawn.sun} vs ${midMorning.sun}) — the burn-off arm was not exercised`);
else if (!(dawn.weight > midMorning.weight))
  fail(`it does not burn off as the sun climbs (${dawn.weight} at sun ${dawn.sun} vs ${midMorning.weight} at ${midMorning.sun})`);
else if (!(dawn.weight > 0.5)) fail(`first light is the picture he asked for and it reads ${dawn.weight}`);
// THE COUNTER-INTUITIVE ONE: cloud is a blanket that stops the ground
// radiating, so ground fog needs a CLEAR sky. More cloud, less fog.
if (cloudy.cloud <= clearNight.cloud) console.log("sky: the weather did not become cloudier — the cloud arm was not exercised");
else if (!(cloudy.weight < clearNight.weight))
  fail(`cloud did not thin it (${cloudy.weight} at cloud ${cloudy.cloud} vs ${clearNight.weight} at ${clearNight.cloud})`);
await atSky("Morning", 0, 0);

/* ---- THE RING OF PICKS STAYS OFF THE FRAME ---- */
const thr = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  const t0 = performance.now();
  const p0 = window.__mlAmbient.debug("dawnmist").probes;
  for (let i = 0; i < 400; i++) await step();
  const d = window.__mlAmbient.debug("dawnmist");
  return { ms: performance.now() - t0, probes: d.probes - p0, gain: d.gain, tries: d.tries, indoor: !!window.__ml.indoor?.().indoor };
});
// Eight picks a candidate, two candidates an attempt, one attempt per gap
// (400-900ms), plus slack for the frames either side of a boundary.
// The MEAN gap (650ms), not its floor: sizing the ceiling off the shortest
// possible gap made it 2829 against a measured 686, which is a ceiling that
// would not notice the ring being walked every other frame.
const budget = Math.ceil((thr.ms / 650) * 2 * 9) + 20;
console.log(`throttle: ${thr.probes} picks over ${Math.round(thr.ms)}ms (ceiling ${budget}), gain ${thr.gain}, indoor ${thr.indoor}`);
if (!(thr.gain > 0.05)) fail(`the effect was parked (gain ${thr.gain}, indoor ${thr.indoor}) — the throttle arm measured nothing`);
else if (!(thr.probes > 0)) fail("the effect was running and never probed — it cannot find a hollow");
if (thr.probes > budget) fail(`the ring was walked ${thr.probes} times in ${Math.round(thr.ms)}ms — it must stay on its gap`);

/* ---- IT IS IN THE HOLLOW AND NOT ON THE RIDGE ---- */
const visit = (spots, label) =>
  page.evaluate(async ({ spots, label }) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    const out = [];
    for (const s of spots) {
      window.__ml.teleport(s.x + 0.5, s.y + 0.5);
      for (let i = 0; i < 140; i++) await step();
      // Clear what the last place left behind, so the count below belongs to
      // THIS one: park() drops every patch, and the gap refills from here.
      window.__mlAmbient.setEnabled("dawnmist", false);
      for (let i = 0; i < 20; i++) await step();
      window.__mlAmbient.setEnabled("dawnmist", true);
      let patches = 0, damp = 0, best = 0, draw = null, near = 0, nearest = Infinity, nearDamp = 0;
      for (let i = 0; i < 320; i++) {
        const d = window.__mlAmbient.debug("dawnmist");
        patches = Math.max(patches, d.patches);
        best = Math.max(best, d.bestDamp);
        for (const p of d.all) damp = Math.max(damp, p.damp);
        if (d.draw && (!draw || d.draw.alpha > draw.alpha)) draw = d.draw;
        // WHERE THE PLAYER IS, in the world px the patches are placed in.
        const v = window.__ml.camView();
        const me = window.__ml.myScreen();
        if (me) {
          const z = me.zoom ?? 1;
          const px = v.x + me.sx / z;
          const py = v.y + me.sy / z;
          let n = 0;
          for (const p of d.all) {
            // Distance in CELLS, so the x and y squash of the projection do
            // not make "a cell away" mean two different things.
            const dx = (p.x - px) / 32;
            const dy = (p.y - py) / 14;
            const r = Math.sqrt(dx * dx + dy * dy);
            if (r < 4) { n++; nearDamp = Math.max(nearDamp, p.damp); }
            nearest = Math.min(nearest, r);
          }
          near = Math.max(near, n);
        }
        await step();
      }
      out.push({ at: [s.x, s.y], lvl: s.l, patches, damp, best, draw, label, near, nearDamp, nearest: Number.isFinite(nearest) ? +nearest.toFixed(1) : null });
    }
    return out;
  }, { spots, label });

const inHollow = await visit(places.hollows.slice(0, 3).map((h) => ({ x: h.x, y: h.y, l: h.l })), "hollow");
for (const r of inHollow)
  console.log(`hollow ${r.at} (level ${r.lvl}): ${r.patches} patches, ${r.near} within 4 cells of me (nearest ${r.nearest}), thickest damp ${r.damp}`);
const bestHollow = inHollow.reduce((m, r) => (r.near > m.near ? r : m), inHollow[0] ?? { patches: 0, near: 0, damp: 0, draw: null });
if (!bestHollow.patches) fail("no mist gathered in any of the world's deepest hollows");
if (!bestHollow.near) fail("the mist gathered somewhere in view but never around the player standing in the hollow");
if (!(bestHollow.damp >= 0.5)) fail(`the thickest bank in a hollow reads damp ${bestHollow.damp} — it is finding the rim, not the bottom`);

/* THE DEPTH, which is the bug that would look fine at dawn and ruin the night:
 * above the darkness overlay a pale bank is the brightest thing on a dark
 * screen. The surface band is negative — under every body and under the
 * overlay, so the night grades the fog with the ground it lies on. */
if (!bestHollow.draw) fail("no patch ever reached the screen in a hollow");
else {
  const d = bestHollow.draw;
  console.log(`draw: depth ${d.depth}, alpha ${d.alpha}, ${d.dw}x${d.dh}, tex ${d.tex}, blend ${d.blend}, tint ${d.tint}`);
  if (!(d.depth > 900_000))
    fail(`the mist draws at depth ${d.depth} — under the darkness overlay the night hides it (1 luma, measured)`);
  if (!(d.depth < 900_001))
    fail(`the mist draws at depth ${d.depth} — over the lit copies, so it would wash over the scenery standing in it`);
  if (!d.visible) fail("the thickest patch is not visible");
  if (d.blend !== 0) fail(`the mist draws in blend mode ${d.blend} — fog is in the way, it does not glow`);
  if (!(d.dw > 8 && d.dh > 3)) fail(`a patch is ${d.dw}x${d.dh} — that is a speck, not a bank`);
}

const onRidge = await visit(places.ridges.slice(0, 2).map((r) => ({ x: r.x, y: r.y, l: r.l })), "ridge");
for (const r of onRidge) console.log(`ridge ${r.at} (level ${r.lvl}): ${r.patches} patches, thickest damp ${r.damp}`);
const worstRidge = onRidge.reduce((m, r) => (r.near > m.near ? r : m), onRidge[0] ?? { patches: 0, near: 0, damp: 0, nearDamp: 0 });
console.log(
  `where: within 4 cells of the player — the deepest hollow holds ${bestHollow.near} banks (nearest ${bestHollow.nearest} cells), ` +
    `the highest ridge ${worstRidge.near} (nearest ${worstRidge.nearest})`,
);
// The claim is about the ground UNDER YOUR FEET. A summit looks down on the
// slopes around it and the hollows down there are real fog, so counting the
// view would fail a correct effect (measured: 18 patches in view from a
// 46-level peak, every one of them below it).
if (!(bestHollow.near > worstRidge.near * 2 + 1))
  fail(`a ridge fogs at your feet like a hollow (${worstRidge.near} vs ${bestHollow.near} banks within 4 cells)`);
if (worstRidge.near && !(bestHollow.nearDamp > worstRidge.nearDamp + 0.15))
  fail(`what little reaches the ridge is as thick as the hollow's (${worstRidge.nearDamp} vs ${bestHollow.nearDamp})`);

/* ---- AND IT IS ON THE SCREEN ---- */
{
  const at = bestHollow.at;
  const shoot = async () => PNG.sync.read(await page.screenshot({ type: "png" }));
  const lum = (im, x, y) => {
    if (x < 0 || y < 0 || x >= im.width || y >= im.height) return 0;
    const i = (y * im.width + x) * 4;
    return 0.299 * im.data[i] + 0.587 * im.data[i + 1] + 0.114 * im.data[i + 2];
  };
  const setOn = (on) => page.evaluate(async (o) => {
    window.__mlAmbient.setEnabled("dawnmist", o);
    for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  }, on);
  /* FIRST LIGHT, NOT PITCH DARK. The mist draws UNDER the darkness overlay by
   * design, so at sun 0 it is multiplied down with the ground and the two keep
   * their ratio but lose their difference — measured 7.2 luma at sun 0, which
   * says more about the hour than about the fog. The moment this effect exists
   * FOR is the one where the bank is still thick AND the light has arrived, so
   * the arm walks the morning until it finds a sun that is up while the weight
   * is still most of the way on, and says which moment it judged. */
  const lit = await page.evaluate(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    let best = null;
    for (const t of [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4]) {
      window.__ml.timeSpeed(0);
      window.__ml.timeOfDay("Morning", true, t);
      for (let i = 0; i < 45; i++) await step();
      const d = window.__mlAmbient.debug("dawnmist");
      if (d.sun >= 0.25 && d.weight >= 0.4) { best = { t, sun: d.sun, weight: d.weight }; break; }
      if (!best || d.sun > best.sun) best = { t, sun: d.sun, weight: d.weight };
    }
    return best;
  });
  console.log(`pixels: judged at phaseT ${lit?.t} of Morning — sun ${lit?.sun}, weight ${lit?.weight}`);
  if (lit && lit.sun < 0.05)
    console.log("pixels: the clock never lifted the sun off zero — this is the darkest reading the effect can give");
  const layout = await page.evaluate(async (at) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    window.__ml.teleport(at[0] + 0.5, at[1] + 0.5);
    for (let i = 0; i < 180; i++) await step();
    const cv = document.querySelector("canvas").getBoundingClientRect();
    const over = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.tagName === "CANVAS") continue;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || +st.opacity === 0) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      if (b.bottom <= cv.top || b.top >= cv.bottom || b.right <= cv.left || b.left >= cv.right) continue;
      if (b.width * b.height > cv.width * cv.height * 0.9) continue; // a wrapper
      over.push({ x0: b.left, x1: b.right, y0: b.top, y1: b.bottom });
    }
    return { cv: { x0: cv.left, x1: cv.right, y0: cv.top, y1: cv.bottom }, over, me: window.__ml.myScreen() };
  }, at);
  const skipBox = layout.me
    ? { x0: layout.me.sx - 26, x1: layout.me.sx + 26, y0: layout.me.sy - 62, y1: layout.me.sy + 16 }
    : null;
  const clear = (x, y) =>
    x >= layout.cv.x0 && x <= layout.cv.x1 && y >= layout.cv.y0 && y <= layout.cv.y1 &&
    (!skipBox || x < skipBox.x0 || x > skipBox.x1 || y < skipBox.y0 || y > skipBox.y1) &&
    !layout.over.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
  console.log(`pixels: the game area is ${Math.round(layout.cv.x1 - layout.cv.x0)}x${Math.round(layout.cv.y1 - layout.cv.y0)}px with ${layout.over.length} HUD rects over it`);

  const HALF = 6;
  await setOn(false);
  const offs = [];
  for (let i = 0; i < 8; i++) { offs.push(await shoot()); await page.waitForTimeout(150); }
  const noiseShot = await shoot();
  await setOn(true);
  await page.waitForTimeout(4000); // a bank fades in over a fifth of a long life
  const back = await page.evaluate(() => {
    const d = window.__mlAmbient.debug("dawnmist");
    return { gain: d.gain, patches: d.patches };
  });
  console.log(`pixels: after switching back on — gain ${back.gain}, ${back.patches} patches`);
  if (!(back.gain > 0.4)) fail(`the effect did not come back on after the OFF control (gain ${back.gain})`);
  const contrastAt = (png, p) => {
    let m = -Infinity;
    for (let y = p.y - HALF; y <= p.y + HALF; y++)
      for (let x = p.x - HALF; x <= p.x + HALF; x++) {
        if (!clear(x, y)) continue;
        let hi = 0, lo = 255;
        for (const o of offs) { const l = lum(o, x, y); hi = Math.max(hi, l); lo = Math.min(lo, l); }
        const l = lum(png, x, y);
        // Either way: mist is paler than grass and darker than snow.
        m = Math.max(m, l - hi, lo - l);
      }
    return m === -Infinity ? 0 : m;
  };
  const tally = { live: 0, bright: 0, clear: 0, maxA: 0 };
  let best = 0, noise = 0, shots = 0, marks = 0;
  for (let i = 0; i < 120 && shots < 6; i++) {
    const raw = await page.evaluate(() => {
      const v = window.__ml.camView();
      const z = window.__ml.myScreen()?.zoom ?? 1;
      const all = window.__mlAmbient.debug("dawnmist").all;
      return {
        live: all.length,
        maxA: all.reduce((m, q) => Math.max(m, q.a), 0),
        pts: all
          .filter((m) => m.a > 0.05 && m.t > 0.25 && m.t < 0.8)
          .map((m) => ({ x: Math.round((m.x - v.x) * z), y: Math.round((m.y - v.y) * z) })),
      };
    });
    tally.live = Math.max(tally.live, raw.live);
    tally.bright = Math.max(tally.bright, raw.pts.length);
    tally.maxA = Math.max(tally.maxA, raw.maxA);
    const pts = raw.pts.filter(
      (p) =>
        clear(p.x - HALF, p.y - HALF) && clear(p.x + HALF, p.y + HALF) &&
        clear(p.x - HALF, p.y + HALF) && clear(p.x + HALF, p.y - HALF),
    );
    tally.clear = Math.max(tally.clear, pts.length);
    if (!pts.length) { await page.waitForTimeout(150); continue; }
    const png = await shoot();
    shots++;
    marks += pts.length;
    for (const p of pts) {
      best = Math.max(best, contrastAt(png, p));
      noise = Math.max(noise, contrastAt(noiseShot, p)); // the SAME windows, effect off
    }
  }
  console.log(
    `pixels: ${shots} shots over ${marks} bank windows — a bank shifts its own window by ${best.toFixed(1)} luma, ` +
      `against ${noise.toFixed(1)} for the same windows with the effect off`,
  );
  console.log(
    `pixels: at best ${tally.live} patches drawn, ${tally.bright} in the sample band (peak alpha ${tally.maxA.toFixed(3)}), ${tally.clear} clear of the HUD`,
  );
  if (shots < 3)
    fail(
      `only ${shots} frames put a bank in the clear game area — ${tally.live} drawn, ${tally.bright} in the band, ${tally.clear} clear of the HUD` +
        (tally.live === 0 ? " (nothing was drawn at all)" : tally.bright === 0 ? " (every patch was fainter than the band's floor)" : " (the banks are behind the HUD)"),
    );
  if (noise > 12) fail(`the banks' own windows moved ${noise.toFixed(1)} luma with the effect OFF — the envelope is measuring the world, not the fog`);
  if (best < 10) fail(`a bank changes its own pixels by ${best.toFixed(1)} luma — it cannot be seen`);
  if (best < noise * 1.8 + 3) fail(`the banks move ${best.toFixed(1)} luma where the world alone moves ${noise.toFixed(1)}`);
}

/* ---- COST ---- */
const cost = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  window.__mlAmbient.cost(true);
  for (let i = 0; i < 420; i++) await step();
  return window.__mlAmbient.cost(true).dawnmist;
});
console.log(`cost: ${cost.ms} ms/frame (peak ${cost.peak}) over ${cost.frames} frames`);
if (!(cost.frames > 100)) fail(`only ${cost.frames} frames measured — the cost check proved nothing`);
if (cost.ms > COST_MS) fail(`dawnmist cost ${cost.ms} ms/frame (ceiling ${COST_MS})`);
if (cost.peak > 3) fail(`a single frame cost ${cost.peak} ms — the ring of picks must spread over frames, not spike`);

/* Put the player back: the game persists where you logged out. */
await page.evaluate(async () => {
  window.__ml.lookAt();
  window.__ml.teleport(333.5, 237.5);
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
});

await browser.close();
console.log(failed ? "verify-dawnmist: FAILED" : "verify-dawnmist: OK");
if (failed) process.exitCode = 1;
