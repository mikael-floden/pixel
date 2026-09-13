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
  /* QUIET MEANS THE GROUND HAS FINISHED PAINTING — NOT THAT NOTHING MOVES.
   * The player is a known moving object and in here they are the loudest thing
   * on the screen: their idle animation and their TORCH swing their own pixels
   * by 244 luma every frame in a dark chamber (measured; with the torch off,
   * 133). Waiting for that to stop is waiting forever. So the scan skips the
   * player's own box and asks the rest of the canvas to agree — which is the
   * question this precondition was always asking: has the ground render
   * texture finished its slices, or would the envelope measure it repainting? */
  /* THE CLEAR AREA IS MEASURED, NOT GUESSED. Every gate here has carried a
   * hand-picked box, and each one is wrong for the next feature: the
   * butterflies' canvas starts at y=36 to miss the clock, and a cave drip HANGS
   * near the ceiling — measured at y=11 and y=38, so every window this arm
   * sampled was rejected and it read 0.0 luma on a working effect. Ask the page
   * instead. The canvas is the game area; the HUD is DOM painted over it, and
   * its rectangles can be read off the elements themselves. */
  const layout = await page.evaluate(() => {
    const cv = document.querySelector("canvas").getBoundingClientRect();
    const over = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.tagName === "CANVAS") continue;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || +st.opacity === 0) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      if (b.bottom <= cv.top || b.top >= cv.bottom || b.right <= cv.left || b.left >= cv.right) continue;
      // skip the wrappers: an element that covers the whole game area is the
      // canvas's own container, not something painted on top of it
      if (b.width * b.height > cv.width * cv.height * 0.9) continue;
      over.push({ x0: b.left, x1: b.right, y0: b.top, y1: b.bottom });
    }
    return { cv: { x0: cv.left, x1: cv.right, y0: cv.top, y1: cv.bottom }, over, me: window.__ml.myScreen() };
  });
  const me = layout.me;
  /* THE PLAYER'S BOX IS THE PLAYER, not half the frame. A generous one (88 x
   * 124 px) swallows most of the game area, and since a drop hangs near the
   * ceiling — exactly where such a box reaches — every window fell inside it.
   * The avatar is about 26x34 px at this zoom; this is that plus the room its
   * torch lights. */
  const SKIP = me ? { x0: me.sx - 26, x1: me.sx + 26, y0: me.sy - 62, y1: me.sy + 16 } : null;
  const outsideMe = (x, y) => !SKIP || x < SKIP.x0 || x > SKIP.x1 || y < SKIP.y0 || y > SKIP.y1;
  const onHud = (x, y) => layout.over.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
  const judgeable = (x, y) => x >= layout.cv.x0 && x <= layout.cv.x1 && y >= layout.cv.y0 && y <= layout.cv.y1 && outsideMe(x, y) && !onHud(x, y);
  console.log(
    `pixels: the game area is ${Math.round(layout.cv.x1 - layout.cv.x0)}x${Math.round(layout.cv.y1 - layout.cv.y0)}px ` +
      `with ${layout.over.length} HUD rects over it; the player's box is ` +
      `${SKIP ? `${Math.round(SKIP.x0)},${Math.round(SKIP.y0)}..${Math.round(SKIP.x1)},${Math.round(SKIP.y1)}` : "(no myScreen probe)"}`,
  );
  const BOX = { x0: Math.round(layout.cv.x0), x1: Math.round(layout.cv.x1), y0: Math.round(layout.cv.y0), y1: Math.round(layout.cv.y1) };
  /* THE CONTROL IS THE PRECONDITION. This arm used to require the whole game
   * area to go quiet before building an envelope — the butterflies' rule, and
   * right for a wide box, because an envelope built while the ground is still
   * painting its slices measures the ground. With per-mark windows that check
   * measures the wrong thing twice over: a monster crossing the chamber, or the
   * player's torch flickering on the far wall, moves pixels the arm will never
   * look at (measured 68.6 luma at the 99.5th percentile on a run whose own
   * windows read 0.0). So the evidence is taken where it counts instead — the
   * SAME windows, with the effect off, asserted low below. A window that is not
   * quiet fails there, in the place the claim is actually made.
   *
   * The settle is still waited out, just not asserted on: the camera has to
   * arrive and the ground has to land before any of this means anything. */
  for (let i = 0; i < 6; i++) await page.waitForTimeout(400);
  const offs = [];
  for (let i = 0; i < 6; i++) { offs.push(await shoot()); await page.waitForTimeout(200); }
  const noiseShot = await shoot();
  await setOn(true);

  /* THE WINDOW IS THE MARK, AND IT IS EVERY MARK — not the whole game area.
   * Judging the largest departure anywhere in the box works right up until
   * something else in the room moves: a monster walking through a chamber
   * measured 110.8 luma against the drips' 183.1 and the arm could not tell
   * them apart. Small windows on the feature's own marks cannot see it (the
   * butterflies' rule: for a small mark the box is the MARK).
   *
   * AND IT JUDGES THE HANGING DROP, WHICH IS STANDING STILL. A screenshot is a
   * separate round trip, so a falling drop has left the window by the time it
   * lands; a drop swelling at the ceiling has not moved at all. Taking EVERY
   * hanging mark rather than the first also removes the race that made this
   * arm read bare rock: `all[0]` is whichever spout is first in the list, not
   * the one that was there a moment ago. */
  /** A SMALL MARK'S WINDOW IS THE MARK, not the game area. */
  const HALF = 7;
  const contrastAt = (png, p) => {
    let m = -Infinity;
    for (let y = p.y - HALF; y <= p.y + HALF; y++)
      for (let x = p.x - HALF; x <= p.x + HALF; x++) {
        if (!judgeable(x, y)) continue;
        let hi = 0, lo = 255;
        for (const o of offs) { const l = lum(o, x, y); hi = Math.max(hi, l); lo = Math.min(lo, l); }
        const l = lum(png, x, y);
        m = Math.max(m, l - hi, lo - l); // contrast EITHER WAY
      }
    return m === -Infinity ? 0 : m;
  };
  let best = 0, noise = 0, shots = 0, marks = 0;
  for (let i = 0; i < 60 && shots < 6; i++) {
    const pts = await page.evaluate(() => {
      const v = window.__ml.camView();
      const z = window.__ml.myScreen()?.zoom ?? 1;
      return window.__mlAmbient.debug("drips").all
        .filter((m) => m.phase === "hang" && m.a >= 0.5)
        .map((m) => ({ x: Math.round((m.x - v.x) * z), y: Math.round(((m.dropY ?? m.y) - v.y) * z) }));
    });
    // ...and a window that touches the player's box is not evidence either, so
    // it is rejected HERE rather than silently scoring 0 inside the judge.
    const use = pts.filter(
      (p) =>
        judgeable(p.x - HALF, p.y - HALF) && judgeable(p.x + HALF, p.y + HALF) &&
        judgeable(p.x - HALF, p.y + HALF) && judgeable(p.x + HALF, p.y - HALF),
    );
    if (!use.length) { await page.waitForTimeout(120); continue; }
    const png = await shoot();
    shots++;
    marks += use.length;
    for (const p of use) {
      best = Math.max(best, contrastAt(png, p));
      noise = Math.max(noise, contrastAt(noiseShot, p)); // the SAME windows, effect off
    }
  }
  console.log(
    `pixels: ${shots} shots over ${marks} hanging-drop windows — a drip shifts its own window by ${best.toFixed(1)} luma, ` +
      `against ${noise.toFixed(1)} for the same windows with the effect off`,
  );
  if (shots < 3) fail(`only ${shots} frames put a hanging drop in the clear game area`);
  // The control IS the quiet precondition, measured in the windows that matter.
  if (noise > 12)
    fail(`the drops' own windows moved ${noise.toFixed(1)} luma with the effect OFF — the envelope is measuring the cave, not the drips`);
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
