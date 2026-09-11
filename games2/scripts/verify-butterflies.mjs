// Browser gate for BUTTERFLIES — the meadow in summer.
//
// A butterfly is four pixels, so nothing here can be judged from a still. The
// things that would be wrong and invisible to a unit test:
//   OVER GRASS   — every butterfly is PLACED on ground the game itself calls
//                  grass, none ever flies over water, and the patch it works
//                  holds it. The unit tests cannot see any of this: the filter
//                  is two live probes, and a set that silently matched nothing
//                  would still pass every test in server/test.
//   IT FLUTTERS  — the drawn body BOBS and the wings pass through all three
//                  silhouettes on a live frame clock. A pure-model test proves
//                  the functions; only this proves they reach the screen.
//   IT CHANGES   — the path is short runs broken by hard turns, measured on
//                  the heading the feature actually flies.
//   IT SETTLES   — one goes down to the grass, shuts its wings, comes back up.
//   IT SHOWS     — a pixel arm against an OFF envelope, inside the clear game
//                  area (the HUD is painted over the canvas). CONTRAST either
//                  way: his commonest butterfly is brown+black, darker than
//                  the grass, so a brightness-only arm would miss it.
//   HIS COLOURS  — the drawn species come from his table and more than one of
//                  them shows up, so a bug that pinned every butterfly to one
//                  mix cannot pass.
//   IT IS A DAY CREATURE — night and rain empty the meadow, and the open sea
//                  never has one over it.
//
//   node scripts/verify-butterflies.mjs        (needs the dev stack on :5173)
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

function chromePath() {
  const root = "/opt/pw-browsers";
  const c = existsSync(root)
    ? readdirSync(root).filter((d) => /^chromium(-\d+)?$/.test(d)).map((d) => join(root, d, "chrome-linux", "chrome"))
    : [];
  return [...c, join(root, "chromium")].find((p) => existsSync(p));
}

const GAME_URL = process.env.GAME_URL || "http://localhost:5173/";
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };

const MEADOW_MS = 0.30; // mean ms/frame over a meadow, butterflies in flight
const SEA_MS = 0.12;    // and over open water, where there is nothing to do
/* MIXED DRY GROUND, on purpose: 63% grass and 37% soil/paving in view, all on
 * one level, right beside spawn. A view of nothing BUT grass makes the whole
 * "over grass" arm vacuous — widening MEADOW to accept every surface in the
 * world passed there, because there was no other surface to get it wrong on. */
const MEADOW = { c: 333, r: 241 };
/** Open sea: no grass within 20 cells, so nothing may be placed at all. */
const SEA = { c: 372, r: 236 };
const TAU = Math.PI * 2;
/** The shortest way round from a to b, so the heading's wrap is not a flick. */
const dh = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return Math.abs(d); };

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(GAME_URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 60_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("butterflies")))) fail("butterflies is not registered");

const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find((b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings");
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')].map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("butterfl")) };
});
if (ui.error) fail(ui.error);
else if (!ui.found) fail(`no "Butterflies" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
else console.log(`settings: "Butterflies" is one of ${ui.labels.length} ambient rows`);

await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__ml.weather(0, true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "butterflies");
});

const settle = async () => {
  let v = await page.evaluate(() => window.__ml.camView());
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(300);
    const v2 = await page.evaluate(() => window.__ml.camView());
    if (v2.x === v.x && v2.y === v.y) return v2;
    v = v2;
  }
  return v;
};
const goto = async (c, r) => {
  await page.evaluate(({ c, r }) => window.__ml.teleport(c, r), { c, r });
  await page.waitForTimeout(5000);
  return settle();
};
const dbg = () => page.evaluate(() => window.__mlAmbient.debug("butterflies"));
const shoot = async () => PNG.sync.read(await page.screenshot());
const luma = (png, X, Y) => { const i = (Y * png.width + X) * 4; return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]; };

/* IN-PAGE LOOPS RUN ON rAF WITH A WALL-CLOCK DEADLINE, never on a setTimeout
 * count. Chromium clamps timers hard in a headless page, so a "900 x 30 ms"
 * loop that should take 27 s took over ten minutes and read as a hung gate.
 * A frame tick is the game's own clock and the deadline is the guarantee. */
const SAMPLE = `const tick = () => new Promise((r) => requestAnimationFrame(r));`;

/* ---- OVER GRASS ----------------------------------------------------------- */
let view = await goto(MEADOW.c, MEADOW.r);
await page.waitForTimeout(4000);
const d0 = await dbg();
console.log(`meadow: gain ${d0.gain.toFixed(2)}, ${d0.count} alive, placed ${d0.placed}, rejected ${d0.rejected}`);
if (!d0.count) fail(`no butterflies over a pure-grass plateau at ${MEADOW.c},${MEADOW.r}`);

/* WHAT THE FEATURE CONTROLS IS WHERE IT PUTS ONE. Asking every DRAWN position
 * to be grass is the wrong arm — it works a patch and the patch has a dirt
 * path through it, so a butterfly crossing that path is a butterfly, not a
 * defect. Two things are: a butterfly PLACED off the meadow, and one flying
 * over water. */
const spots = [];
for (let i = 0; i < 48; i++) {
  for (const f of (await dbg()).all)
    if (f.a > 0.5 && !spots.some((s) => s.x === f.x && s.y === f.y)) spots.push({ x: f.x, y: f.y, hx: f.hx, hy: f.hy });
  await page.waitForTimeout(250);
}
const grounds = await page.evaluate((ss) => {
  const soundAt = (x, y) => { const p = window.__ml.pickAt(x, y); return p ? (window.__ml.surfaceAt(p.x, p.y)?.sound ?? null) : null; };
  return ss.map((s) => ({ ...s, sound: soundAt(s.x, s.y), home: soundAt(s.hx, s.hy), wet: !!window.__ml.waterAtScreen(s.x, s.y) }));
}, spots);
const homes = [...new Map(grounds.map((g) => [`${g.hx},${g.hy}`, g])).values()];
const badHome = homes.filter((g) => g.home !== "grass");
const wet = grounds.filter((g) => g.wet);
const offGrass = grounds.filter((g) => g.sound !== "grass");
console.log(`meadow: ${homes.length} patches placed (${homes.length - badHome.length} on grass); ${grounds.length} drawn positions, ${grounds.length - offGrass.length} over grass, ${wet.length} over water`);
if (badHome.length) fail(`${badHome.length} butterflies were PLACED off the meadow (${[...new Set(badHome.map((g) => g.home))].join(", ")})`);
if (wet.length) fail(`${wet.length} butterfly positions are over water`);
// and the patch has to hold them: free-flying with no tether measured 64%
if (offGrass.length > grounds.length * 0.5)
  fail(`only ${grounds.length - offGrass.length} of ${grounds.length} positions are over grass — the patch is not holding them`);

/* ---- HIS COLOURS ---------------------------------------------------------- */
/* The species table is unit-tested; what a unit test cannot see is whether the
 * feature ever ASKS for more than one mix. A butterfly only draws a new mix
 * when it is PLACED, and the home tether means a placed one stays put — so
 * standing still for 25 s measured four placements, far too thin a sample to
 * judge anything by. Teleporting churns them: every jump puts the whole
 * population off-view and forces fresh placements. */
const MEADOWS = [[333, 241], [264, 243], [335, 245]];
const seenSpecies = new Map();
for (let round = 0; round < 8; round++) {
  await page.evaluate(([c, r]) => window.__ml.teleport(c, r), MEADOWS[round % MEADOWS.length]);
  await page.waitForTimeout(2600);
  for (const f of (await dbg()).all) if (f.a > 0.5) seenSpecies.set(f.species, (seenSpecies.get(f.species) ?? 0) + 1);
}
const spread = [...seenSpecies.entries()].sort((a, b) => b[1] - a[1]);
const sightings = spread.reduce((n, [, c]) => n + c, 0);
console.log(`colours: ${sightings} sightings over ${spread.length} mixes — ${spread.map(([k, c]) => `${k} ${c}`).join(", ")}`);
const TABLE = new Set([
  "brown_black", "black_orange", "brown_orange", "green_black", "yellow_black",
  "blue_black", "white_black", "red_black", "purple_black", "green_blue",
]);
const strangers = spread.filter(([k]) => !TABLE.has(k));
if (strangers.length) fail(`drawn mixes that are not in his table: ${strangers.map(([k]) => k).join(", ")}`);
if (spread.length < 3) fail(`only ${spread.length} butterfly mix(es) drawn over ${sightings} sightings — his table has ten`);
// the common end must be common: nothing from his bottom three may lead
const RARE = new Set(["red_black", "purple_black", "green_blue"]);
if (sightings >= 40 && RARE.has(spread[0][0]))
  fail(`${spread[0][0]} is his rarest end but came out commonest (${spread[0][1]} of ${sightings})`);
// back to the meadow the later arms are calibrated on — and the camera moved,
// so the view every later arm converts screen positions through moves with it
view = await goto(MEADOW.c, MEADOW.r);

/* ---- IT FLUTTERS ---------------------------------------------------------- */
const flutter = await page.evaluate(async (src) => {
  const tick = new Function(src + "; return tick;")();
  const t = new Map();
  const until = performance.now() + 12_000;
  while (performance.now() < until) {
    window.__mlAmbient.debug("butterflies").all.forEach((f, idx) => {
      if (!t.has(idx)) t.set(idx, { wings: [], bobs: [], hs: [] });
      const e = t.get(idx);
      e.wings.push(f.wing);
      e.bobs.push(f.bob);
      e.hs.push(f.h);
    });
    await tick();
  }
  return [...t.values()];
}, SAMPLE);
const wings = new Set(flutter.flatMap((e) => e.wings));
const bobs = new Set(flutter.flatMap((e) => e.bobs));
console.log(`flutter: wing frames seen ${[...wings].sort().join(",")}; bob heights ${[...bobs].sort((a, b) => a - b).join(",")}`);
if (wings.size < 3) fail(`only ${wings.size} of the 3 wing frames reached the screen — the flutter has no silhouette change`);
if (bobs.size < 3) fail(`the body took only ${bobs.size} heights — it is sliding, not bobbing`);
if (![...bobs].some((b) => b < 0) || !bobs.has(0)) fail(`the bob never leaves the flight line (heights ${[...bobs].join(",")})`);

/* ---- IT CHANGES ITS MIND -------------------------------------------------- */
// between flicks the heading drifts at most DRIFT_RAD_S (0.9) rad/s; sampled
// at ~30 ms that is 0.03 rad, so anything past 0.2 is a real turn
const flicks = flutter.map((e) => e.hs.reduce((n, h, i) => n + (i && dh(e.hs[i - 1], h) > 0.2 ? 1 : 0), 0));
const drifted = flutter.map((e) => e.hs.reduce((n, h, i) => n + (i && dh(e.hs[i - 1], h) <= 0.2 ? 1 : 0), 0));
console.log(`path: flicks per butterfly ${flicks.join(",")} over ${flutter[0]?.hs.length ?? 0} samples (gentle steps ${drifted.join(",")})`);
if (!flicks.some((n) => n >= 2)) fail("no butterfly changed its mind — a smoothly curving path reads as a bird");
if (flicks.some((n, i) => n > drifted[i])) fail("the path is all flick and no run — that is a jitter, not a flight");

/* ---- IT SETTLES ----------------------------------------------------------- */
const landing = await page.evaluate(async (src) => {
  const tick = new Function(src + "; return tick;")();
  const seen = { down: 0, shut: 0, lifted: false };
  let wasDown = false;
  const until = performance.now() + 30_000;
  while (performance.now() < until) {
    const all = window.__mlAmbient.debug("butterflies").all;
    for (const f of all) if (f.down) { seen.down++; if (f.wing === 0) seen.shut++; if (f.alt === 0) wasDown = true; }
    if (wasDown && all.every((f) => !f.down)) seen.lifted = true;
    if (seen.down > 5 && seen.lifted) break;
    await tick();
  }
  return { ...seen, settles: window.__mlAmbient.debug("butterflies").settles };
}, SAMPLE);
console.log(`settle: ${landing.settles} settles, ${landing.down} frames on the grass (${landing.shut} with the wings shut), lifted off again: ${landing.lifted}`);
if (!landing.down) fail("nothing ever landed — a meadow where nothing settles is a screen saver");
if (landing.shut !== landing.down) fail(`${landing.down - landing.shut} frames sat on the grass with its wings open`);
if (!landing.lifted) fail("a butterfly landed and never left");

/* ---- IT SHOWS (pixels) ---------------------------------------------------- */
const setOn = (on) => page.evaluate((on) => window.__mlAmbient.setEnabled("butterflies", on), on);
const zoom = await page.evaluate(() => window.__ml.camZoom());
/* THE WINDOW IS THE BUTTERFLY, not a box of the game area. A wide box judged
 * against an OFF envelope also measures whatever else on screen is alive — the
 * player's idle and the scenery's sway are both bigger than a five-pixel
 * butterfly, and a widened-MEADOW falsification run "failed" on a swaying tuft
 * (rise 199 against noise 125) instead of on the thing it was breaking. Each
 * ON frame is judged in a small window around where the feature SAYS its
 * butterfly is; the control is the same window on an OFF frame. */
const HALF = { x: 9, y: 8 };
/* Still inside the clear canvas, so the window can never reach the HUD. */
const CLEAR = { x0: 80, x1: 400, y0: 36, y1: 164 };
const screenOf = (f) => ({ x: Math.round((f.x - view.x) * zoom), y: Math.round((f.y - f.alt + f.bob - view.y) * zoom) });
const inClear = (f) => {
  const s = screenOf(f);
  return s.x > CLEAR.x0 + HALF.x && s.x < CLEAR.x1 - HALF.x && s.y > CLEAR.y0 + HALF.y && s.y < CLEAR.y1 - HALF.y;
};
await setOn(false);
/* WAIT FOR A QUIET SCREEN BEFORE BUILDING AN ENVELOPE. The ground is a render
 * texture that scrolls and repaints in slices, so for a second or two after
 * the camera arrives somewhere the frames differ from each other by more than
 * any butterfly does — measured 99 luma of "noise" in an OFF control right
 * after the colour arm teleported around and came back, which failed the arm
 * on the ground finishing its paint. Two frames that agree is the evidence
 * that the only thing left moving is the feature under test. */
const quiet = async () => {
  let prev = await shoot();
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(400);
    const now = await shoot();
    let worst = 0;
    for (let y = CLEAR.y0; y < CLEAR.y1; y += 2)
      for (let x = CLEAR.x0; x < CLEAR.x1; x += 2) worst = Math.max(worst, Math.abs(luma(now, x, y) - luma(prev, x, y)));
    if (worst < 8) return { settled: true, worst: +worst.toFixed(1), waited: i };
    prev = now;
  }
  return { settled: false, worst: -1, waited: 30 };
};
const q = await quiet();
console.log(`pixels: the screen went quiet after ${(q.waited * 0.4).toFixed(1)}s (frame-to-frame ${q.worst})`);
if (!q.settled) fail("the screen never went quiet — an OFF envelope built on it would measure the scenery");
const offs = [];
for (let i = 0; i < 6; i++) { offs.push(await shoot()); await page.waitForTimeout(200); }
const noiseShot = await shoot();
await setOn(true);
const ons = [];
for (let i = 0; i < 90 && ons.length < 8; i++) {
  const f = (await dbg()).all.find((f) => f.a > 0.5 && inClear(f));
  if (f) ons.push({ png: await shoot(), at: screenOf(f), species: f.species });
  else await page.waitForTimeout(70);
}
console.log(`pixels: ${ons.length} ON frames with a butterfly in the clear canvas`);
if (ons.length < 3) fail(`only ${ons.length} frames put a butterfly in the clear canvas`);
/** CONTRAST in the window, either way. The OFF envelope is a max AND a min
 *  over the OFF frames (the ground animates, so one frame is one phase of a
 *  moving picture), and the arm takes the largest departure from that band in
 *  either direction. A rise alone was right while every butterfly was pale;
 *  his table has brown+black at 22%, and that one is DARKER than the grass —
 *  measuring only brightening would have called the commonest butterfly in
 *  the game invisible. */
const contrastAt = (png, at) => {
  let m = -Infinity;
  for (let y = at.y - HALF.y; y <= at.y + HALF.y; y++)
    for (let x = at.x - HALF.x; x <= at.x + HALF.x; x++) {
      let hi = 0;
      let lo = 255;
      for (const o of offs) {
        const l = luma(o, x, y);
        hi = Math.max(hi, l);
        lo = Math.min(lo, l);
      }
      const l = luma(png, x, y);
      m = Math.max(m, l - hi, lo - l);
    }
  return m;
};
if (ons.length) {
  let best = 0;
  let noise = 0;
  for (const o of ons) {
    best = Math.max(best, contrastAt(o.png, o.at));
    noise = Math.max(noise, contrastAt(noiseShot, o.at)); // the same windows, feature off
  }
  const seen = [...new Set(ons.map((o) => o.species))];
  console.log(`pixels: the ground shifts by ${best.toFixed(1)} luma where the butterfly is (same windows OFF: ${noise.toFixed(1)}); species shot: ${seen.join(", ")}`);
  if (!(best >= 30 && best >= noise * 2 + 10)) fail(`no butterfly showed on screen (contrast ${best.toFixed(1)}, noise ${noise.toFixed(1)})`);
}

/* ---- A DAY CREATURE ------------------------------------------------------- */
/* In MANUAL the toggles force a field ON and its env weight is bypassed, which
 * is exactly the wrong thing to measure here — AUTO is the mode where a field
 * self-gates, so the night/rain arm runs there. */
await page.evaluate(() => window.__mlAmbient.auto(true));
// index 5 = "Heavy rain" and 7 = "Snowing"; index 1 is only "Cloudy at times"
// and leaves env.rain at 0, which is not a weather test at all
for (const [what, weather] of [["night", 0], ["rain", 5], ["snow", 7]]) {
  await page.evaluate(({ what, weather }) => {
    window.__ml.timeOfDay(what === "night" ? "Night" : "Day", true);
    window.__ml.weather(weather, true);
  }, { what, weather });
  await page.waitForTimeout(7000);
  const d = await dbg();
  console.log(`${what}: gain ${d.gain.toFixed(3)}, ${d.count} alive`);
  if (d.gain > 0.05) fail(`butterflies are still out in ${what} (gain ${d.gain.toFixed(3)})`);
}
await page.evaluate(() => {
  window.__ml.timeOfDay("Day", true);
  window.__ml.weather(0, true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "butterflies");
});
await page.waitForTimeout(4000);

/* ---- NOTHING OVER THE OPEN SEA -------------------------------------------- */
await goto(SEA.c, SEA.r);
await page.waitForTimeout(5000);
const sea = await dbg();
const overSea = await page.evaluate((ss) => ss.filter((s) => {
  const p = window.__ml.pickAt(s.x, s.y);
  return !p || (window.__ml.surfaceAt(p.x, p.y)?.sound ?? null) !== "grass";
}).length, sea.all.filter((f) => f.a > 0.5).map((f) => ({ x: f.x, y: f.y })));
const drawn = sea.all.filter((f) => f.a > 0.5).length;
console.log(`sea: ${drawn} drawn, ${overSea} of them not over grass, rejected ${sea.rejected}`);
if (overSea) fail(`${overSea} butterflies are flying over open water`);
if (drawn) fail(`${drawn} butterflies are drawn with no grass within 20 cells`);
if (!sea.rejected) fail("the placement never even tried over the sea — the arm is not testing anything");
const idle = await page.evaluate(async () => {
  window.__mlAmbient.cost(true);
  await new Promise((r) => setTimeout(r, 4000));
  return window.__mlAmbient.cost().butterflies;
});
console.log(`cost: ${idle.ms.toFixed(3)} ms/frame over the sea (peak ${idle.peak}) over ${idle.frames} frames`);
if (idle.frames > 0 && idle.ms > SEA_MS) fail(`butterflies cost ${idle.ms.toFixed(3)} ms/frame with no grass in view, cap ${SEA_MS}`);

await goto(MEADOW.c, MEADOW.r);
const busy = await page.evaluate(async () => {
  window.__mlAmbient.cost(true);
  await new Promise((r) => setTimeout(r, 4000));
  return window.__mlAmbient.cost().butterflies;
});
console.log(`cost: ${busy.ms.toFixed(3)} ms/frame over the meadow (peak ${busy.peak}) over ${busy.frames} frames`);
if (busy.frames > 0 && busy.ms > MEADOW_MS) fail(`butterflies cost ${busy.ms.toFixed(3)} ms/frame over a meadow, cap ${MEADOW_MS}`);

await browser.close();
if (failed) { console.error("verify-butterflies: FAILED"); process.exit(1); }
console.log("verify-butterflies: OK");
