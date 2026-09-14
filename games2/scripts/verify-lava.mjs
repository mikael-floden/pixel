// Browser gate for LAVA BUBBLES AND ASH — "slow bubbles that swell and pop on
// the lava surface with a spark or two, and dark ash motes drifting up from it"
// (maintainer 2026-09-13, his pick from the ten).
//
// Five things to prove, each of them a way the effect could be wrong while
// every counter read correct:
//  1. IT IS ON LAVA AND NOWHERE ELSE. Water must not bubble like lava — that
//     is `bubbles/`'s job and a different animal. Both spots are DERIVED from
//     the world doc's ground names, never written down here.
//  2. A DOME SWELLS, HOLDS AND BURSTS. Slow: molten rock is viscous. The gate
//     watches one cycle through the phases rather than trusting a counter.
//  3. ASH RISES AND STOPS INSIDE THE GLOW. A dark speck is legible over bright
//     lava and invisible against the rock above it, so it must fade out before
//     it climbs clear — the smoke's lesson, asserted.
//  4. THE COLOUR COMES FROM THE TILES DOMAIN, and departs from the pool in
//     BOTH directions: a hotter dome, a cooler crust. A mark that is merely
//     orange is lost on `#fd5a02`.
//  5. IT IS ON THE SCREEN. Per-mark windows on the vents — which, unlike a
//     falling drop, stand still — inside a clear area measured off the DOM.
//
//   node scripts/verify-lava.mjs        (needs the dev stack on :5173)
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
if (!(await page.evaluate(() => window.__mlAmbient.list().includes("lava")))) fail("lava is not registered");
const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find((b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings");
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')]
    .map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("lava")) };
});
if (ui.error) fail(ui.error);
else if (!ui.found) fail(`no "Lava" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
else console.log(`settings: ${ui.labels.length} ambient rows, "Lava" is one of them`);

/* ---- WHERE THE LAVA AND THE WATER ARE — from the world's own ground names ---- */
const worldDoc = (() => {
  const f = join("..", "maps2", "worlds3", WORLD, "world.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
})();
if (!worldDoc) fail(`could not read the world doc for ${WORLD}`);
const cellsOf = (name) => {
  const id = (worldDoc?.grounds ?? []).indexOf(name);
  const out = [];
  if (id < 0) return out;
  const g = worldDoc.ground ?? [];
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[y].length; x++) if (g[y][x] === id) out.push({ x, y });
  return out;
};
const spread = (cells, n) => {
  const seen = new Set(), out = [];
  for (const c of cells) {
    const k = `${Math.floor(c.x / n)},${Math.floor(c.y / n)}`;
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
};
const lavaCells = spread(cellsOf("lava"), 4);
const waterCells = spread(cellsOf("water"), 24);
console.log(`${WORLD}: ${cellsOf("lava").length} lava cells (${lavaCells.length} sampled), ${waterCells.length} sampled water spots`);
if (!lavaCells.length) fail("the world ships no lava — nothing to exercise");

await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "lava");
});

/** Stand BESIDE a pool (lava burns) and watch it for a while. */
const visit = (cells, frames = 900) =>
  page.evaluate(async ({ cells, frames }) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    for (const c of cells.slice(0, 12)) {
      window.__ml.teleport(c.x + 2.5, c.y + 2.5);
      for (let i = 0; i < 170; i++) await step();
      const d0 = window.__mlAmbient.debug("lava");
      if (!d0.vents) continue;
      const phases = {};
      let vents = 0, motes = 0, maxA = 0, draw = null;
      let domeGrew = 0, ringGrew = 0, ashTop = 0, ashRose = 0, ashSank = 0;
      const lastDome = new Map(), lastRing = new Map(), lastUp = new Map();
      const bursts0 = d0.bursts;
      for (let i = 0; i < frames; i++) {
        const d = window.__mlAmbient.debug("lava");
        vents = Math.max(vents, d.vents);
        motes = Math.max(motes, d.ash);
        if (d.draw && (!draw || d.draw.alpha > draw.alpha)) draw = d.draw;
        for (const m of d.all) {
          maxA = Math.max(maxA, m.a);
          phases[m.phase] = (phases[m.phase] ?? 0) + 1;
          const k = `${m.x},${m.y}`;
          if (m.domeR !== null) {
            const p = lastDome.get(k);
            if (p !== undefined && m.domeR > p) domeGrew++;
            lastDome.set(k, m.domeR);
          } else lastDome.delete(k);
          if (m.ringR !== null) {
            const p = lastRing.get(k);
            if (p !== undefined && m.ringR > p) ringGrew++;
            lastRing.set(k, m.ringR);
          } else lastRing.delete(k);
        }
        // follow each mote BY ITS ID: a position is not an identity, and two
        // motes drifting across each other reported ash sinking on a curve
        // that is monotone by construction.
        for (const q of d.motes) {
          ashTop = Math.max(ashTop, q.up);
          const p = lastUp.get(q.id);
          if (p !== undefined) { if (q.up > p) ashRose++; else if (q.up < p) ashSank++; }
          lastUp.set(q.id, q.up);
        }
        await step();
      }
      const d = window.__mlAmbient.debug("lava");
      return {
        at: [c.x, c.y], indoor: window.__ml.indoor().indoor,
        vents, motes, maxA: +maxA.toFixed(3), phases,
        bursts: d.bursts - bursts0, domeGrew, ringGrew, ashTop, ashRose, ashSank,
        palette: d.palette, lava: d.lava, wall: d.wall, draw,
      };
    }
    return null;
  }, { cells, frames });

/* ---- THE POOL BREATHES ---- */
const pool = await visit(lavaCells);
if (!pool) fail("none of the sampled lava cells reached the effect");
else {
  console.log(
    `pool ${pool.at} (indoor=${pool.indoor}): ${pool.vents} vent(s), ${pool.motes} ash motes, peak alpha ${pool.maxA}; ` +
      `${pool.bursts} bursts; phases ${JSON.stringify(pool.phases)}; dome grew ${pool.domeGrew}x, ring spread ${pool.ringGrew}x; ` +
      `ash reached ${pool.ashTop}px (${pool.ashRose} rose, ${pool.ashSank} sank)`,
  );
  if (!pool.vents) fail("standing at a lava pool, the effect placed no vent");
  if (!(pool.maxA > 0.2)) fail(`the brightest mark drew at alpha ${pool.maxA} — nothing to see`);
  if (!pool.phases.swell) fail("no dome ever swelled — a bubble that only pops is a flash");
  if (!pool.bursts) fail("no bubble ever burst in the time watched — the pool is not breathing");
  if (!(pool.domeGrew > 5)) fail(`the dome grew ${pool.domeGrew} times — it must SWELL, slowly`);
  if (!(pool.ringGrew > 5)) fail(`the crust ring spread ${pool.ringGrew} times — a burst must leave a ring`);
  // ASH: it rises, and it is gone before it leaves the pool's own light.
  if (!pool.motes) fail("no ash came off the pool");
  if (!(pool.ashRose > pool.ashSank * 4)) fail(`ash rose ${pool.ashRose} times and sank ${pool.ashSank} — it goes UP`);
  if (!(pool.ashTop >= 6)) fail(`ash only reached ${pool.ashTop}px — it never left the surface`);
  if (pool.ashTop > 30)
    fail(`ash climbed ${pool.ashTop}px, out of the pool's glow — a dark speck on dark rock cannot be seen`);
  // THE COLOUR IS THE TILES DOMAIN'S.
  const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, "0")}`;
  const doc = (() => {
    const f = join("..", "tiles", "ground_types.json");
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  })();
  const table = doc?.grounds ?? doc ?? {};
  console.log(`palette: ${pool.palette}; pool ${hex(pool.lava)}, crust ${hex(pool.wall)}; tiles says ${table.lava?.palette?.top} / ${table.lava?.palette?.wall}`);
  if (pool.palette !== "fetched")
    fail("the pool's colour was not read from /assets/tiles/ground_types.json — it fell back to the measured tone");
  if (table.lava?.palette?.top && hex(pool.lava).toLowerCase() !== String(table.lava.palette.top).toLowerCase())
    fail(`the effect thinks lava is ${hex(pool.lava)}, the tiles domain says ${table.lava.palette.top}`);
  const d = pool.draw;
  if (!d) fail("no live mark to measure");
  else {
    const lum = (c) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
    console.log(`look: ${d.dw}x${d.dh}px, blend ${d.blend}, tint ${hex(d.tint)}, alpha ${d.alpha}, depth ${d.depth}, tex ${d.tex}`);
    if (!(d.depth > 900_000)) fail(`a mark draws at depth ${d.depth} — under the darkness overlay, which paints it out`);
    // the brightest mark is the dome or the flash, and both are HOTTER than the pool
    if (!(lum(d.tint) > lum(pool.lava) + 15))
      fail(`the brightest mark is ${lum(d.tint).toFixed(0)} luma against a pool at ${lum(pool.lava).toFixed(0)} — it is lost in the lava`);
  }
}

/* ---- AND WATER DOES NOT BUBBLE LIKE LAVA ---- */
if (!waterCells.length) console.log("water: none sampled — the discrimination was not exercised");
else {
  const wet = await page.evaluate(async (cells) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    for (const c of cells.slice(0, 14)) {
      window.__ml.teleport(c.x + 2.5, c.y + 2.5);
      for (let i = 0; i < 150; i++) await step();
      let vents = 0, motes = 0;
      for (let i = 0; i < 300; i++) {
        const d = window.__mlAmbient.debug("lava");
        vents = Math.max(vents, d.vents);
        motes = Math.max(motes, d.ash);
        await step();
      }
      return { at: [c.x, c.y], vents, motes };
    }
    return null;
  }, waterCells);
  if (!wet) console.log("water: no water spot was reached");
  else {
    console.log(`water ${wet.at}: ${wet.vents} vent(s), ${wet.motes} ash motes`);
    if (wet.vents || wet.motes) fail(`${wet.vents} vents over WATER — only the liquid that burns bubbles like this`);
  }
}

/* ---- AND IT IS ON THE SCREEN ----
 * Per-mark windows on the vents. A vent does not move — unlike a falling drop,
 * which no screenshot can catch where the probe said it was — so a window read
 * from the probe still contains it when the shot lands. The clear area is
 * MEASURED off the DOM (the canvas is the game area, the HUD is painted over
 * it), never a hand-picked box, and the control is the same windows with the
 * effect off. */
if (pool) {
  const shoot = async () => PNG.sync.read(await page.screenshot({ type: "png" }));
  const lum = (im, x, y) => {
    if (x < 0 || y < 0 || x >= im.width || y >= im.height) return 0;
    const i = (y * im.width + x) * 4;
    return 0.299 * im.data[i] + 0.587 * im.data[i + 1] + 0.114 * im.data[i + 2];
  };
  const setOn = (on) => page.evaluate(async (o) => {
    window.__mlAmbient.setEnabled("lava", o);
    for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  }, on);

  const layout = await page.evaluate(async (at) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    window.__ml.teleport(at[0] + 2.5, at[1] + 2.5);
    for (let i = 0; i < 160; i++) await step();
    // ...and put the POOL in the middle of the frame, not the player: a vent
    // at the edge of the view is rejected by the clear-area test and the arm
    // then reads two usable frames in forty.
    window.__ml.lookAt(at[0], at[1]);
    for (let i = 0; i < 90; i++) await step();
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
  }, pool.at);
  const skip = layout.me
    ? { x0: layout.me.sx - 26, x1: layout.me.sx + 26, y0: layout.me.sy - 62, y1: layout.me.sy + 16 }
    : null;
  const clear = (x, y) =>
    x >= layout.cv.x0 && x <= layout.cv.x1 && y >= layout.cv.y0 && y <= layout.cv.y1 &&
    (!skip || x < skip.x0 || x > skip.x1 || y < skip.y0 || y > skip.y1) &&
    !layout.over.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
  console.log(`pixels: the game area is ${Math.round(layout.cv.x1 - layout.cv.x0)}x${Math.round(layout.cv.y1 - layout.cv.y0)}px with ${layout.over.length} HUD rects over it`);

  const HALF = 7;
  await setOn(false);
  const offs = [];
  for (let i = 0; i < 8; i++) { offs.push(await shoot()); await page.waitForTimeout(150); }
  const noiseShot = await shoot();
  await setOn(true);
  await page.waitForTimeout(700);
  const contrastAt = (png, p) => {
    let m = -Infinity;
    for (let y = p.y - HALF; y <= p.y + HALF; y++)
      for (let x = p.x - HALF; x <= p.x + HALF; x++) {
        if (!clear(x, y)) continue;
        let hi = 0, lo = 255;
        for (const o of offs) { const l = lum(o, x, y); hi = Math.max(hi, l); lo = Math.min(lo, l); }
        const l = lum(png, x, y);
        // CONTRAST EITHER WAY: the dome is hotter than the pool, the crust cooler.
        m = Math.max(m, l - hi, lo - l);
      }
    return m === -Infinity ? 0 : m;
  };
  let best = 0, noise = 0, shots = 0, marks = 0;
  for (let i = 0; i < 120 && shots < 6; i++) {
    const raw = await page.evaluate(() => {
      const v = window.__ml.camView();
      const z = window.__ml.myScreen()?.zoom ?? 1;
      return window.__mlAmbient.debug("lava").all
        .filter((m) => m.a > 0.25)
        .map((m) => ({ x: Math.round((m.x - v.x) * z), y: Math.round((m.y - v.y) * z) }));
    });
    const pts = raw.filter(
      (p) =>
        clear(p.x - HALF, p.y - HALF) && clear(p.x + HALF, p.y + HALF) &&
        clear(p.x - HALF, p.y + HALF) && clear(p.x + HALF, p.y - HALF),
    );
    if (!pts.length) { await page.waitForTimeout(120); continue; }
    const png = await shoot();
    shots++;
    marks += pts.length;
    for (const p of pts) {
      best = Math.max(best, contrastAt(png, p));
      noise = Math.max(noise, contrastAt(noiseShot, p)); // the SAME windows, effect off
    }
  }
  console.log(
    `pixels: ${shots} shots over ${marks} vent windows — the pool's marks shift their own window by ${best.toFixed(1)} luma, ` +
      `against ${noise.toFixed(1)} for the same windows with the effect off`,
  );
  if (shots < 3) fail(`only ${shots} frames put a lava mark in the clear game area`);
  // the control IS the quiet precondition, measured where the claim is made
  if (noise > 12)
    fail(`the vents' own windows moved ${noise.toFixed(1)} luma with the effect OFF — the envelope is measuring the pool, not the bubbles`);
  if (best < 12) fail(`a bubble changes its own pixels by ${best.toFixed(1)} luma — too faint on a bright pool`);
  if (best < noise * 1.8 + 3)
    fail(`the marks move ${best.toFixed(1)} luma where the pool alone moves ${noise.toFixed(1)} — that is the lava, not the bubbles`);
}

/* ---- COST ---- */
const cost = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  window.__mlAmbient.cost(true);
  for (let i = 0; i < 420; i++) await step();
  return window.__mlAmbient.cost(true).lava;
});
console.log(`cost: ${cost.ms} ms/frame (peak ${cost.peak}) over ${cost.frames} frames`);
if (!(cost.frames > 100)) fail(`only ${cost.frames} frames measured — the cost check proved nothing`);
if (cost.ms > COST_MS) fail(`lava cost ${cost.ms} ms/frame (ceiling ${COST_MS})`);
if (cost.peak > 3) fail(`a single frame cost ${cost.peak} ms — the placement search must spread over frames, not spike`);

/* Put the player back: the game persists where you logged out. */
await page.evaluate(async () => {
  window.__ml.lookAt();
  window.__ml.teleport(333.5, 237.5);
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
});

await browser.close();
console.log(failed ? "verify-lava: FAILED" : "verify-lava: OK");
if (failed) process.exitCode = 1;
