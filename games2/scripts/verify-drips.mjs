// Browser gate for CAVE DRIPS — item 10 of the maintainer's effect list.
//
// Four things this has to prove, and every one of them has burned this folder
// before:
//
//  1. IT ONLY DRIPS IN A CAVE. A house ceiling that drips is a leak, not a
//     mood, so the gate stands in a real house and requires silence — the
//     embers' lantern arm, in stone. Both places are DERIVED from the world
//     doc (deck kinds), never named: a spiral of teleports proves nothing
//     about the map, only about the search.
//  2. IT IS THE MIRROR OF EVERY OTHER EFFECT HERE. Outdoors it draws nothing,
//     however forced — there is no ceiling out there to drip from.
//  3. A DROP FALLS AND LANDS. Accelerating down the screen, then a ring on the
//     floor. Counters, because a screenshot cannot see half a second.
//  4. IT IS ON THE SCREEN. The arm that would have caught the first shipped
//     embers: per-mark windows, an OFF envelope kept as a max AND a min
//     (contrast either way — a pale drop over dark rock is a rise, but the law
//     is the law), a quiet screen measured rather than slept for, and the same
//     windows with the effect off as the control.
//
//   node scripts/verify-drips.mjs        (needs the dev stack on :5173)
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
const COST_MS = 0.25;
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
if (!(await page.evaluate(() => window.__mlAmbient.list().includes("drips")))) fail("drips is not registered");
if (!(await page.evaluate(() => window.__mlAmbient.effects().find((e) => e.name === "drips")?.indoor === true)))
  fail("drips does not declare itself an INDOOR feature — the indoor gate would assert the wrong mirror on it");
const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find((b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings");
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')]
    .map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("drips")) };
});
if (ui.error) fail(ui.error);
else if (!ui.found) fail(`no "Drips" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
else console.log(`settings: ${ui.labels.length} ambient rows, "Drips" is one of them`);

/* ---- WHERE THE CAVES AND THE HOUSES ARE — DERIVED, NEVER NAMED ----
 * The world's decks carry a KIND. A cave cell whose floor sits well below its
 * lid is a chamber you can stand in; a roof deck is a house. Teleporting onto
 * a cave cell lands on the FLOOR under the lid (measured: 4 of 4 candidates
 * read indoor), so the gate asks the game for the verdict rather than assuming
 * either way. */
const worldDoc = (() => {
  const f = join("..", "maps2", "worlds3", WORLD, "world.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
})();
if (!worldDoc) fail(`could not read the world doc for ${WORLD}`);
const lvl = worldDoc?.level ?? [];
const spread = (cells) => {
  const seen = new Set(), out = [];
  for (const c of cells) {
    const k = `${Math.floor(c.x / 8)},${Math.floor(c.y / 8)}`;
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
};
const caveCells = spread(
  (worldDoc?.decks ?? []).filter((d) => d.kind === "cave").flatMap((d) =>
    (d.cells ?? []).filter((c) => typeof lvl[c.y]?.[c.x] === "number" && d.level - lvl[c.y][c.x] >= 4)),
);
const houseCells = spread(
  (worldDoc?.decks ?? []).filter((d) => d.kind === "roof").flatMap((d) => {
    const cx = Math.round(d.cells.reduce((s, c) => s + c.x, 0) / d.cells.length);
    const cy = Math.round(d.cells.reduce((s, c) => s + c.y, 0) / d.cells.length);
    return [{ x: cx, y: cy }, ...d.cells];
  }),
);
console.log(`${WORLD}: ${caveCells.length} sampled cave floors, ${houseCells.length} sampled house cells`);
if (!caveCells.length) fail("the world ships no cave chamber — nothing to exercise");

await page.evaluate(() => {
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "drips");
});

/** Stand somewhere, let the effect settle, and report what it sees. */
const visit = (cells, frames = 300) =>
  page.evaluate(async ({ cells, frames }) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    for (const c of cells.slice(0, 14)) {
      window.__ml.teleport(c.x + 0.5, c.y + 0.5);
      for (let i = 0; i < 40; i++) await step();
      if (!window.__ml.indoor().indoor) continue;
      let spouts = 0, maxA = 0;
      for (let i = 0; i < frames; i++) {
        const d = window.__mlAmbient.debug("drips");
        spouts = Math.max(spouts, d.spouts);
        maxA = Math.max(maxA, 0, ...d.all.map((m) => m.a ?? 0));
        await step();
      }
      const d = window.__mlAmbient.debug("drips");
      return { at: [c.x, c.y], spouts, maxA: +maxA.toFixed(3), ceiling: d.ceiling, caveProbes: d.caveProbes, gain: d.gain };
    }
    return null;
  }, { cells, frames });

/* ---- IT DRIPS IN A CAVE ---- */
const cave = await visit(caveCells);
if (!cave) fail("none of the sampled cave cells read as indoors — the gate never got underground");
else {
  console.log(`cave ${cave.at}: ${cave.spouts} spout(s), ceiling ${cave.ceiling} levels, peak alpha ${cave.maxA}`);
  if (!cave.spouts) fail("standing in a cave, the effect placed no spout at all");
  if (!(cave.maxA > 0.2)) fail(`the brightest drip mark drew at alpha ${cave.maxA} — nothing to see`);
}

/* ---- A DROP FALLS, ACCELERATING, AND LANDS IN A RING ---- */
if (cave) {
  const fall = await page.evaluate(async (at) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    window.__ml.teleport(at[0] + 0.5, at[1] + 0.5);
    for (let i = 0; i < 120; i++) await step();
    const seen = { hang: 0, fall: 0, splash: 0 };
    let down = 0, up = 0, rings = 0, maxR = 0, firstStep = null, lastStep = null, accel = 0;
    const prev = new Map();
    for (let i = 0; i < 1400; i++) {
      for (const m of window.__mlAmbient.debug("drips").all) {
        const k = `${m.x},${m.y}`;
        seen[m.phase] = (seen[m.phase] ?? 0) + 1;
        if (m.phase === "fall" && m.dropY !== null) {
          const p = prev.get(k);
          if (p !== undefined && p !== null) {
            const d = m.dropY - p;
            if (d > 0) down++; else if (d < 0) up++;
            if (d > 0) { if (firstStep === null) firstStep = d; lastStep = d; }
          }
          prev.set(k, m.dropY);
        } else prev.set(k, null);
        if (m.ringR !== null) { rings++; maxR = Math.max(maxR, m.ringR); }
      }
      if (lastStep !== null && firstStep !== null && lastStep > firstStep) accel++;
      await step();
    }
    return { seen, down, up, rings, maxR, firstStep, lastStep, accel };
  }, cave.at);
  console.log(
    `fall: ${fall.seen.hang ?? 0} hang / ${fall.seen.fall ?? 0} fall / ${fall.seen.splash ?? 0} splash samples; ` +
      `${fall.down} steps down vs ${fall.up} up; first step ${fall.firstStep}px, last ${fall.lastStep}px; ` +
      `${fall.rings} ring samples, widest ${fall.maxR}px`,
  );
  if (!fall.seen.hang) fail("no drop ever hung from the ceiling — a drip that appears mid-air is a falling dot");
  if (!fall.down) fail("no drop ever moved down the screen");
  if (fall.up > fall.down * 0.05) fail(`drops moved up ${fall.up} times against ${fall.down} down — water falls`);
  if (!(fall.lastStep > fall.firstStep)) fail(`a drop's step went ${fall.firstStep}px to ${fall.lastStep}px — it must ACCELERATE, not glide`);
  if (!fall.rings) fail("no drop ever landed in a ring — the splash is what says 'floor'");
  if (!(fall.maxR >= 4)) fail(`the widest ring was ${fall.maxR}px — it never spread`);
}

/* ---- AND NOT IN A HOUSE. The sharp case: a roof is a ceiling too. ---- */
const house = await page.evaluate(async (cells) => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  for (const c of cells.slice(0, 20)) {
    window.__ml.teleport(c.x + 0.5, c.y + 0.5);
    for (let i = 0; i < 40; i++) await step();
    if (!window.__ml.indoor().indoor) continue;
    // a cave lid over a house cell would make this arm meaningless
    const decks = (window.__ml.t3at(c.x, c.y)?.decks ?? []).map((d) => d.kind);
    if (decks.includes("cave")) continue;
    let spouts = 0, maxA = 0;
    for (let i = 0; i < 420; i++) {
      const d = window.__mlAmbient.debug("drips");
      spouts = Math.max(spouts, d.spouts);
      maxA = Math.max(maxA, 0, ...d.all.map((m) => m.a ?? 0));
      await step();
    }
    return { at: [c.x, c.y], decks, spouts, maxA: +maxA.toFixed(3) };
  }
  return null;
}, houseCells);
if (!house) console.log("house: no roofed room was reached — the leak case was not exercised");
else {
  console.log(`house ${house.at} (decks ${house.decks.join(",") || "none"}): ${house.spouts} spout(s), peak alpha ${house.maxA}`);
  if (house.spouts || house.maxA > 0) fail(`${house.spouts} spout(s) under a HOUSE roof — a cottage that drips is a leak, not a mood`);
}

/* ---- OUTDOORS IT DRAWS NOTHING, HOWEVER FORCED ---- */
const outside = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  const spawn = window.__ml.worldInfo();
  window.__ml.teleport(333.5, 237.5);
  for (let i = 0; i < 200; i++) await step();
  let maxA = 0, spouts = 0;
  for (let i = 0; i < 300; i++) {
    const d = window.__mlAmbient.debug("drips");
    maxA = Math.max(maxA, 0, ...d.all.map((m) => m.a ?? 0));
    spouts = Math.max(spouts, d.spouts);
    await step();
  }
  return { indoor: window.__ml.indoor().indoor, outdoor: window.__mlAmbient.outdoor().gain, maxA: +maxA.toFixed(3), spouts, world: spawn.name };
});
console.log(`outdoors: indoor=${outside.indoor} outdoorGain=${outside.outdoor} spouts=${outside.spouts} peak alpha ${outside.maxA}`);
if (outside.indoor) console.log("outdoors: the spawn read as indoors — the mirror was not exercised");
else if (outside.maxA > 0 || outside.spouts) fail(`drips drew outdoors (alpha ${outside.maxA}, ${outside.spouts} spouts) — it is the mirror of every other effect here`);

/* ---- AND IT IS ON THE SCREEN ----
 * Per-mark windows, because a box over the whole game area also measures the
 * player's idle and the cave's own lit scenery. The OFF envelope is a max AND
 * a min over several frames and the arm takes the largest departure either way
 * (a pale drop over dark rock is a rise; the law still holds). The screen is
 * measured quiet first — the ground is a render texture that repaints in
 * slices after the camera arrives, and an envelope built on that measures the
 * ground finishing its paint. */
if (cave) {
  const shoot = async () => PNG.sync.read(await page.screenshot({ type: "png" }));
  const lum = (im, x, y) => {
    if (x < 0 || y < 0 || x >= im.width || y >= im.height) return 0;
    const i = (y * im.width + x) * 4;
    return 0.299 * im.data[i] + 0.587 * im.data[i + 1] + 0.114 * im.data[i + 2];
  };
  const setOn = (on) => page.evaluate(async (o) => {
    window.__mlAmbient.setEnabled("drips", o);
    for (let i = 0; i < 60; i++) await new Promise((r) => requestAnimationFrame(r));
  }, on);

  await page.evaluate(async (at) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    window.__ml.teleport(at[0] + 0.5, at[1] + 0.5);
    // Freeze the clock: a sun that keeps moving re-grades the room under the
    // envelope. (The torch is left alone — toggling it re-lights the cave and
    // the frames after that are the loudest thing in the room.)
    window.__ml.timeSpeed(0);
    for (let i = 0; i < 150; i++) await step();
  }, cave.at);

  await setOn(false);
  /* THE BOX IS THE GAME AREA, NEVER THE SCREEN — the butterflies' measured
   * canvas for this viewport. At 480x320 the camera shows about 198 px of world
   * and the rest is HUD, where the clock and the chat line rewrite themselves
   * while the gate runs: a box reaching y=20 measured 243 luma of "noise" at
   * the clock, against 1.8% of samples moving at all. */
  const BOX = { x0: 80, x1: 400, y0: 36, y1: 164 };
  /** A SMALL MARK'S WINDOW IS THE MARK, not the game area: a wide box also
   *  measures the cave's own lit scenery and the player's idle. */
  const HALF = { x: 6, y: 7 };
  /* QUIET MEANS THE GROUND HAS FINISHED PAINTING — NOT THAT NOTHING MOVES.
   * The player is a known moving object and in here they are the loudest thing
   * on the screen: their idle animation and their TORCH swing their own pixels
   * by 244 luma every frame in a dark chamber (measured; with the torch off,
   * 133). Waiting for that to stop is waiting forever. So the scan skips the
   * player's own box and asks the rest of the canvas to agree — which is the
   * question this precondition was always asking: has the ground render
   * texture finished its slices, or would the envelope measure it repainting? */
  const me = await page.evaluate(() => window.__ml.myScreen());
  const SKIP = me ? { x0: me.sx - 44, x1: me.sx + 44, y0: me.sy - 96, y1: me.sy + 28 } : null;
  console.log(`pixels: skipping the player's own box ${SKIP ? `${Math.round(SKIP.x0)},${Math.round(SKIP.y0)}..${Math.round(SKIP.x1)},${Math.round(SKIP.y1)}` : "(no myScreen probe)"}`);
  const outsideMe = (x, y) => !SKIP || x < SKIP.x0 || x > SKIP.x1 || y < SKIP.y0 || y > SKIP.y1;
  let prev = await shoot();
  let settled = false, worst = -1;
  for (let i = 0; i < 30 && !settled; i++) {
    await page.waitForTimeout(400);
    const now = await shoot();
    worst = 0;
    for (let y = BOX.y0; y < BOX.y1; y += 2)
      for (let x = BOX.x0; x < BOX.x1; x += 2)
        if (outsideMe(x, y)) worst = Math.max(worst, Math.abs(lum(now, x, y) - lum(prev, x, y)));
    prev = now;
    settled = worst < 8;
  }
  console.log(`pixels: the screen went quiet at frame-to-frame ${worst.toFixed(1)} (the player's box excluded)`);
  if (!settled) fail("the screen never went quiet — an OFF envelope built on it would measure the cave, not the drips");

  const offs = [];
  for (let i = 0; i < 6; i++) { offs.push(await shoot()); await page.waitForTimeout(200); }
  const noiseShot = await shoot();
  await setOn(true);

  /* NO COORDINATES AT ALL — THE BEST LOCAL BRIGHTENING IN THE GAME AREA WINS.
   * Asking the page where a mark is and then screenshotting is a race the
   * effect keeps winning: a falling drop covers 24 px between the two calls,
   * and even a HANGING one is only `all[0]` until a spout ahead of it in the
   * list wakes up, so the window lands on bare rock (measured, contrast 0.0
   * while a neighbourhood search found the same drop at 157 luma one pixel
   * away). The embers gate settled this shape years of bugs ago: one envelope
   * with the effect OFF, several frames with it ON, and the largest departure
   * anywhere in the box is the answer. The control is one more OFF frame
   * through the same judge, so a torch flicker or a swaying piece of scenery
   * counts against both sides. */
  const ons = [];
  for (let i = 0; i < 8; i++) { ons.push(await shoot()); await page.waitForTimeout(170); }
  const judge = (png) => {
    let best = 0, at = null;
    for (let y = BOX.y0; y < BOX.y1; y++)
      for (let x = BOX.x0; x < BOX.x1; x++) {
        if (!outsideMe(x, y)) continue;
        let hi = 0, lo = 255;
        for (const o of offs) { const l = lum(o, x, y); hi = Math.max(hi, l); lo = Math.min(lo, l); }
        const l = lum(png, x, y);
        const d = Math.max(l - hi, lo - l);
        if (d > best) { best = d; at = [x, y]; }
      }
    return { best, at };
  };
  let best = 0, where = null;
  for (const png of ons) { const q = judge(png); if (q.best > best) { best = q.best; where = q.at; } }
  const noise = judge(noiseShot).best;
  console.log(
    `pixels: over the game area (the player's box excluded) the drips shift a pixel by ${best.toFixed(1)} luma ` +
      `at ${where ? where.join(",") : "?"} — against ${noise.toFixed(1)} for a frame with the effect off`,
  );
  if (!(best >= 25 && best >= noise * 2 + 8))
    fail(`no drip showed on screen (contrast ${best.toFixed(1)}, noise ${noise.toFixed(1)})`);
  // ...and what the sprite itself says, so a failure above says WHY.
  const draw = await page.evaluate(() => window.__mlAmbient.debug("drips").draw);
  console.log(`pixels: the brightest mark draws ${draw ? `${draw.dw}x${draw.dh} at depth ${draw.depth}, alpha ${draw.alpha}, tex ${draw.tex}` : "(nothing live)"}`);
  if (draw && !(draw.depth > 900_000))
    fail(`a drip draws at depth ${draw.depth} — under the darkness overlay at 900000, which paints it out in a cave`);
}

/* ---- COST ---- */
const cost = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  window.__mlAmbient.cost(true);
  for (let i = 0; i < 360; i++) await step();
  return window.__mlAmbient.cost(true).drips;
});
console.log(`cost: ${cost.ms} ms/frame (peak ${cost.peak}) over ${cost.frames} frames`);
if (!(cost.frames > 100)) fail(`only ${cost.frames} frames measured — the cost check proved nothing`);
if (cost.ms > COST_MS) fail(`drips cost ${cost.ms} ms/frame (ceiling ${COST_MS})`);

/* LEAVE THE PLAYER OUTSIDE. The game PERSISTS where you logged out, so a gate
 * that ends underground hands the next one a session that starts indoors —
 * verify-indoor-ambient then fails its very first assertion ("expected to start
 * OUTDOORS") on a tree where nothing is wrong. Any gate that walks somewhere
 * unusual puts the player back. */
await page.evaluate(async () => {
  window.__ml.teleport(333.5, 237.5);
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
});
console.log(`left the player outdoors: indoor=${await page.evaluate(() => window.__ml.indoor().indoor)}`);

await browser.close();
console.log(failed ? "verify-drips: FAILED" : "verify-drips: OK");
if (failed) process.exitCode = 1;
