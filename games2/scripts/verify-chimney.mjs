// Browser gate for CHIMNEY SMOKE — "a plume off a roof while the hearth inside
// is lit, seen across the town" (the maintainer's pick, 2026-09-13, taken once
// the scenery agent had published the vent coordinate).
//
// THE POINT OF THIS GATE IS THE SEAM, not the pretty part. A plume is easy; a
// plume coming out of the actual hole in the actual state of the actual
// facing, on a stack drawn with a random hflip, is where this goes wrong — and
// it goes wrong SILENTLY, as smoke rising out of brickwork two pixels from the
// flue. So:
//  1. THE PROBE EXISTS AND ANSWERS. `__ml.ventsInView` is the whole contract
//     with the games agent's files; a missing or throwing probe is a broken
//     seam whether or not anything is placed yet.
//  2. THE PLACEMENTS ARE DERIVED, never written down here: the world doc names
//     what maps2 placed, and the scenery manifests say which of those publish
//     a vent. THE DAY A CHIMNEY IS PLACED AND NO SMOKE COMES, THIS FAILS.
//     WHILE NONE IS PLACED (0 in the_game as this ships — the maps agent is
//     still putting them on the roofs) the in-world arms would prove nothing
//     at all, so they run against an INJECTED vent instead: the most-placed
//     piece in the world has a `vent` block added to its manifest AT THE
//     NETWORK BOUNDARY (`page.route`), which exercises the identical path —
//     parse, per-state lookup, the facing, the flip, the drawn transform, the
//     record, the probe, the feature, the pixels — without touching one byte
//     of another domain's data. A fixture, and the log says so; the real
//     placements are still awaited.
//  3. THE MOUTH IS ON THE STACK. Every reported vent must land inside the
//     piece's own drawn box and in its top half, and the puffs must be born
//     there — not at the anchor, not at the canvas centre.
//  4. IT CLIMBS AND IT BENDS. Measured over a puff's life, not asserted.
//  5. IT IS ON THE SCREEN. Per-mark windows inside a clear area measured off
//     the DOM, with the same windows read with the effect OFF as the control.
//
//   node scripts/verify-chimney.mjs      (needs the dev stack on :5173)
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

/* ---- WHAT IS PLACED, AND WHICH OF IT VENTS — both derived ---- */
const worldDoc = (() => {
  const f = join("..", "maps2", "worlds3", WORLD, "world.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
})();
if (!worldDoc) fail(`could not read the world doc for ${WORLD}`);
const ventedPieces = new Map(); // piece id -> true when its manifest publishes a vent
const hasVent = (id) => {
  if (ventedPieces.has(id)) return ventedPieces.get(id);
  const f = join("..", "scenery", id, "scenery.json");
  let v = false;
  if (existsSync(f)) {
    const j = JSON.parse(readFileSync(f, "utf8"));
    v = !!j.vent || Object.values(j.states ?? {}).some((s) => s && s.vent);
  }
  ventedPieces.set(id, v);
  return v;
};
const placed = (worldDoc?.scenery ?? []).filter((s) => s.piece && hasVent(s.piece));
console.log(
  `${WORLD}: ${(worldDoc?.scenery ?? []).length} scenery placements, ${placed.length} of them on pieces that publish a vent` +
    (placed.length ? ` (${[...new Set(placed.map((p) => p.piece))].join(", ")})` : ""),
);

/* WHILE NOTHING REAL IS PLACED: the most-placed piece in the world becomes the
 * stand-in, and its manifest is rewritten in flight. Derived, so this follows
 * the world rather than naming a piece that may be retired tomorrow. */
const counts = new Map();
for (const s of worldDoc?.scenery ?? []) counts.set(s.piece, (counts.get(s.piece) ?? 0) + 1);
const fixturePiece = placed.length ? null : [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const FIXTURE_VENT = { dx: 0.5, dy: -28, conf: "opening", rotations: {} };

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
if (fixturePiece) {
  console.log(`fixture: no chimney placed, so ${fixturePiece} (${counts.get(fixturePiece)} placements) is given a vent in flight`);
  await page.route(`**/scenery/${fixturePiece}/scenery.json`, async (route) => {
    const res = await route.fetch();
    const j = JSON.parse(await res.text());
    j.vent = { ...FIXTURE_VENT };
    for (const st of Object.values(j.states ?? {})) if (st && typeof st === "object") st.vent = { ...FIXTURE_VENT };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });
}

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
if (!(await page.evaluate(() => window.__mlAmbient.list().includes("chimney")))) fail("chimney is not registered");
const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find((b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings");
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')]
    .map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("chimney")) };
});
if (ui.error) fail(ui.error);
else if (!ui.found) fail(`no "Chimney" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
else console.log(`settings: ${ui.labels.length} ambient rows, "Chimney" is one of them`);

/* ---- THE SEAM ITSELF: the probe the games agent's files publish ----
 * This runs whether or not a chimney is placed. A probe that is missing or
 * throws is a broken contract; an empty answer is a world with no chimneys. */
const probe = await page.evaluate(() => {
  if (typeof window.__ml.ventsInView !== "function") return { error: "__ml.ventsInView is not a function" };
  try {
    const a = window.__ml.ventsInView(96);
    if (!Array.isArray(a)) return { error: `ventsInView returned ${typeof a}, not an array` };
    return { n: a.length, keys: a.length ? Object.keys(a[0]).sort() : [] };
  } catch (e) {
    return { error: `ventsInView threw: ${e.message}` };
  }
});
if (probe.error) fail(probe.error);
else {
  console.log(`seam: __ml.ventsInView answers ${probe.n} vent(s) here${probe.keys.length ? ` with ${probe.keys.join(",")}` : ""}`);
  if (probe.keys.length) {
    for (const k of ["id", "x", "y", "conf", "alpha", "litDepth", "piece", "state"])
      if (!probe.keys.includes(k)) fail(`ventsInView records are missing \`${k}\``);
  }
}

/* MANUAL, with chimney the only one on. `setEnabled` is REFUSED when an
 * incompatible effect is already enabled and CHANGES NOTHING — it returns
 * `{ok:false, blockedBy}` — so the result is read rather than assumed: a
 * silently-refused enable leaves the field suppressed, and a suppressed field
 * reads zero on every counter the arms below look at. */
const sel = await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) if (n !== "chimney") window.__mlAmbient.setEnabled(n, false);
  const r = window.__mlAmbient.setEnabled("chimney", true);
  const e = window.__mlAmbient.effects().find((f) => f.name === "chimney");
  return { r, on: e?.on, enabled: e?.enabled, blockedBy: e?.blockedBy ?? null, mode: window.__mlAmbient.mode?.() };
});
console.log(`select: chimney enabled=${sel.enabled} on=${sel.on} blockedBy=${sel.blockedBy} (setEnabled ${JSON.stringify(sel.r)})`);
if (!sel.enabled) fail(`chimney could not be switched on${sel.blockedBy ? ` — blocked by ${sel.blockedBy}` : ""}`);

/* ---- THE HEARTH BURNS HARDER AFTER DARK, AND NEVER GOES OUT ----
 * The unforced `weight`, which is what the debug block publishes for exactly
 * this: in MANUAL mode a selected effect is FORCED, so `gain` reads 1 at
 * midnight and proves nothing. The clock is held, and the phase is re-applied
 * until the feature's own reported sun agrees — the server rebroadcasts world
 * time over a local override (measured on the campfire smoke, 2026-09-13). */
const atPhase = async (phase) =>
  page.evaluate(async (p) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    for (let tries = 0; tries < 8; tries++) {
      window.__ml.timeSpeed(0);
      window.__ml.timeOfDay(p, true);
      for (let i = 0; i < 60; i++) await step();
      const d = window.__mlAmbient.debug("chimney");
      const want = p === "Day" ? d.sun > 0.8 : d.sun < 0.2;
      if (want) return { sun: d.sun, weight: d.weight, rain: d.rain };
    }
    const d = window.__mlAmbient.debug("chimney");
    return { sun: d.sun, weight: d.weight, rain: d.rain, stuck: true };
  }, phase);
const day = await atPhase("Day");
const night = await atPhase("Night");
console.log(`hearth: weight ${day.weight} at sun ${day.sun} (day) vs ${night.weight} at sun ${night.sun} (night)`);
if (day.stuck || night.stuck) fail(`could not hold the clock (day sun ${day.sun}, night sun ${night.sun})`);
else {
  if (!(night.weight > day.weight)) fail(`the hearth does not burn harder after dark (${night.weight} vs ${day.weight})`);
  if (!(day.weight > 0.25)) fail(`the hearth reads ${day.weight} by day — a chimney that stops is a broken effect`);
}
await atPhase("Day");

/* ---- THE PROBE STAYS THROTTLED ----
 * ventsInView walks every drawn scenery placement. Reading it per frame is the
 * one way this effect can cost real money, and the empty world is exactly when
 * a `|| nothing in view` re-read would go unnoticed. */
const thr = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  const t0 = performance.now();
  const p0 = window.__mlAmbient.debug("chimney").probes;
  let frames = 0;
  let minGain = Infinity;
  for (let i = 0; i < 400; i++) {
    await step();
    frames++;
    minGain = Math.min(minGain, window.__mlAmbient.debug("chimney").gain);
  }
  const d = window.__mlAmbient.debug("chimney");
  return { frames, ms: performance.now() - t0, probes: d.probes - p0, gain: d.gain, minGain, indoor: !!window.__ml.indoor?.().indoor };
});
const budget = Math.ceil(thr.ms / 620) + 2;
console.log(
  `throttle: ${thr.probes} vent reads over ${thr.frames} frames / ${Math.round(thr.ms)}ms (ceiling ${budget}), ` +
    `gain ${thr.gain} (min ${thr.minGain === Infinity ? "-" : thr.minGain}), indoor ${thr.indoor}`,
);
/* A PARKED EFFECT READS THE LIST ZERO TIMES, and zero is under every ceiling:
 * without this the arm passes hardest exactly when it is measuring nothing.
 * (Measured 2026-09-13 — one run read 58 and the next 0, and only the gain
 * beside it says which of those is a throttle working and which is an effect
 * that was not running at all.) */
if (!(thr.gain > 0.05))
  fail(`the effect was parked (gain ${thr.gain}, indoor ${thr.indoor}) — the throttle arm measured nothing`);
else if (!(thr.probes > 0))
  fail(`the effect was running at gain ${thr.gain} and never read the vent list — it cannot see a chimney`);
if (thr.probes > budget) fail(`the vent list was read ${thr.probes} times in ${Math.round(thr.ms)}ms — it must stay on its throttle`);

/* ---- THE IN-WORLD ARMS ---- */
const source = placed.length ? placed : (worldDoc?.scenery ?? []).filter((s) => s.piece === fixturePiece);
if (!placed.length)
  console.log(
    "WAITING: no chimney is placed in this world yet (the maps2 agent is putting them on the roofs). " +
      "The arms below therefore run against the INJECTED vent above, which proves the path but not the placement. " +
      "This gate FAILS the day a real vented piece is placed and no smoke comes out of it.",
  );
if (!source.length) fail("nothing in this world carries a vent, injected or real — the in-world arms proved nothing");
else {
  const spots = [...new Map(source.map((p) => [`${Math.floor(p.x / 8)},${Math.floor(p.y / 8)}`, p])).values()].slice(0, 8);
  const seen = await page.evaluate(async (spots) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    for (const s of spots) {
      window.__ml.teleport(s.x + 2.5, s.y + 4.5);
      for (let i = 0; i < 120; i++) await step();
      /* ONE CELL UP-SCREEN OF THE PIECE, and the SAME framing the pixel arm
       * uses below: a vent centred in the view puts its whole plume in the
       * upper half, where this 480x198 game area is thinnest and the HUD sits.
       * `lookAt` takes a continuous cell position (its formula does not index
       * the row array for the point itself), so the fraction is kept. */
      window.__ml.lookAt(s.x - 1, s.y - 1);
      for (let i = 0; i < 60; i++) await step();
      const list = window.__ml.ventsInView(96) || [];
      if (!list.length) continue;
      const born = [];
      const climb = [];
      let vents = 0, puffs = 0, maxA = 0, draw = null;
      const first = new Map();
      for (let i = 0; i < 500; i++) {
        const d = window.__mlAmbient.debug("chimney");
        vents = Math.max(vents, d.vents);
        puffs = Math.max(puffs, d.puffs);
        if (d.draw && d.draw.alpha > maxA) { maxA = d.draw.alpha; draw = d.draw; }
        for (const m of d.all) {
          const k = `${m.vent}:${m.vx},${m.vy}:${Math.round(m.t * 1000)}`;
          // t < 0.025, not 0.08: at 0.08 of a 5.4 s life a puff has already
          // ridden 430 ms of its own rise (up to 10 px), so the window itself
          // failed the arm — the mark was where it belonged and the sample was
          // taken too late (measured 25/237 "strays", all long-lived).
          if (m.t < 0.025 && !first.has(k)) {
            first.set(k, true);
            born.push({ dx: m.x - m.vx, dy: m.y - m.vy });
          }
          climb.push({ t: m.t, dy: m.y - m.vy, dx: Math.abs(m.x - m.vx) });
        }
        await step();
      }
      return { at: [s.x, s.y], list, vents, puffs, maxA, draw, born, climb };
    }
    return null;
  }, spots);

  if (!seen) fail(`no vent was reported at any of the ${spots.length} chimney placements — the seam is not delivering`);
  else {
    console.log(
      `at ${seen.at}: ${seen.list.length} vent(s) reported, ${seen.vents} taken by the effect, ` +
        `${seen.puffs} puffs in the air, brightest mark alpha ${seen.maxA}`,
    );
    for (const v of seen.list) console.log(`  vent ${v.id} ${v.piece}#${v.state} conf=${v.conf} alpha=${v.alpha} at ${Math.round(v.x)},${Math.round(v.y)}`);
    if (!seen.vents) fail("the vents are reported but the effect took none of them");
    if (!seen.puffs) fail("the effect took a vent and emitted nothing");
    if (!seen.draw) fail("no puff ever reached the screen");
    else {
      if (!seen.draw.visible) fail("the brightest puff is not visible");
      if (!(seen.draw.depth > 900_000)) fail(`a puff draws at depth ${seen.draw.depth} — under the darkness overlay`);
      if (seen.draw.blend !== 0) fail(`a puff draws in blend mode ${seen.draw.blend} — smoke is in the way, it does not glow`);
    }
    /* THE MOUTH IS ON THE STACK, not at its foot. `footY` is the placement's
     * own drawn anchor, which the probe reports beside the vent for exactly
     * this: a measured point that comes back BELOW the feet is a point read in
     * the wrong frame (the canvas centre taken for the anchor, or a flip
     * mirrored about the wrong axis), and it is the failure that would
     * otherwise ship as smoke rising out of the brickwork. */
    for (const v of seen.list)
      if (v.y >= v.footY) fail(`vent ${v.id} is at or BELOW the piece's anchor (${Math.round(v.y)} vs ${Math.round(v.footY)})`);
    // BORN AT THE MOUTH: a puff leaves the hole, within the hole's own width
    const strayed = seen.born.filter((b) => Math.abs(b.dx) > 6 || Math.abs(b.dy) > 6);
    console.log(`birth: ${seen.born.length} puffs sampled at the mouth, ${strayed.length} of them further than 6px from it`);
    if (seen.born.length && strayed.length > seen.born.length * 0.1)
      fail(`${strayed.length}/${seen.born.length} puffs were born away from the vent they name`);
    // IT CLIMBS, AND IT BENDS OVER AS IT CLIMBS
    const band = (lo, hi) => seen.climb.filter((c) => c.t >= lo && c.t < hi);
    const mean = (a, k) => (a.length ? a.reduce((s, c) => s + c[k], 0) / a.length : 0);
    const early = band(0.05, 0.2);
    const late = band(0.7, 0.95);
    console.log(
      `column: ${Math.round(-mean(early, "dy"))}px up / ${mean(early, "dx").toFixed(1)}px across early, ` +
        `${Math.round(-mean(late, "dy"))}px up / ${mean(late, "dx").toFixed(1)}px across late (${seen.climb.length} samples)`,
    );
    if (early.length && late.length) {
      if (!(mean(late, "dy") < mean(early, "dy") - 8)) fail("the plume does not climb");
      if (!(mean(late, "dx") > mean(early, "dx") * 1.6)) fail("the plume does not bend over as it rises — that is a post");
    } else fail("not enough of a puff's life was sampled to measure the column");
  }

  /* ---- AND IT IS ON THE SCREEN ---- */
  if (seen) {
    const shoot = async () => PNG.sync.read(await page.screenshot({ type: "png" }));
    const lum = (im, x, y) => {
      if (x < 0 || y < 0 || x >= im.width || y >= im.height) return 0;
      const i = (y * im.width + x) * 4;
      return 0.299 * im.data[i] + 0.587 * im.data[i + 1] + 0.114 * im.data[i + 2];
    };
    const setOn = (on) => page.evaluate(async (o) => {
      window.__mlAmbient.setEnabled("chimney", o);
      for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
    }, on);
    const layout = await page.evaluate(async (at) => {
      const step = () => new Promise((r) => requestAnimationFrame(r));
      window.__ml.teleport(at[0] + 2.5, at[1] + 4.5);
      for (let i = 0; i < 120; i++) await step();
      window.__ml.lookAt(at[0] - 1, at[1] - 1); // the observation's own framing
      for (let i = 0; i < 60; i++) await step();
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
    }, seen.at);
    const skipBox = layout.me
      ? { x0: layout.me.sx - 26, x1: layout.me.sx + 26, y0: layout.me.sy - 62, y1: layout.me.sy + 16 }
      : null;
    const clear = (x, y) =>
      x >= layout.cv.x0 && x <= layout.cv.x1 && y >= layout.cv.y0 && y <= layout.cv.y1 &&
      (!skipBox || x < skipBox.x0 || x > skipBox.x1 || y < skipBox.y0 || y > skipBox.y1) &&
      !layout.over.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
    console.log(
      `pixels: the game area is ${Math.round(layout.cv.x1 - layout.cv.x0)}x${Math.round(layout.cv.y1 - layout.cv.y0)}px with ${layout.over.length} HUD rects over it` +
        (placed.length ? "" : " — NOTE: on the fixture the stage is a forest, where a plume pinned to its own tree's lit depth is painted over by every tree in front of it; a real stack on a roof has nothing in front of it and reads far stronger"),
    );

    const HALF = 5;
    await setOn(false);
    const offs = [];
    for (let i = 0; i < 8; i++) { offs.push(await shoot()); await page.waitForTimeout(150); }
    const noiseShot = await shoot();
    await setOn(true);
    await page.waitForTimeout(1200);
    /* THE EFFECT HAS TO BE BACK ON before a "cannot be seen" verdict means
     * anything: a suppressed field draws nothing and reads exactly like an
     * invisible one from out here. */
    const back = await page.evaluate(() => {
      const d = window.__mlAmbient.debug("chimney");
      const e = window.__mlAmbient.effects().find((f) => f.name === "chimney");
      return { gain: d.gain, puffs: d.puffs, vents: d.vents, enabled: e?.enabled, on: e?.on };
    });
    console.log(`pixels: after switching back on — gain ${back.gain}, ${back.vents} vents, ${back.puffs} puffs, enabled ${back.enabled}`);
    if (!(back.gain > 0.4)) fail(`the effect did not come back on after the OFF control (gain ${back.gain}, enabled ${back.enabled})`);
    const contrastAt = (png, p) => {
      let m = -Infinity;
      for (let y = p.y - HALF; y <= p.y + HALF; y++)
        for (let x = p.x - HALF; x <= p.x + HALF; x++) {
          if (!clear(x, y)) continue;
          let hi = 0, lo = 255;
          for (const o of offs) { const l = lum(o, x, y); hi = Math.max(hi, l); lo = Math.min(lo, l); }
          const l = lum(png, x, y);
          // EITHER WAY: the core is paler than a roof, the rim darker than sky.
          m = Math.max(m, l - hi, lo - l);
        }
      return m === -Infinity ? 0 : m;
    };
    let best = 0, noise = 0, shots = 0, marks = 0;
    /* COUNTERS, SO A MUTE FAILURE CANNOT HAPPEN. "0 shots" has three causes
     * that look identical from the verdict line — the effect is off, its
     * marks are too faint for the sample filter, or they are all under the
     * HUD — and only the tally tells them apart (measured 2026-09-13: a run
     * read 0 shots and the arm could not say which). */
    const tally = { live: 0, bright: 0, clear: 0, maxA: 0 };
    for (let i = 0; i < 120 && shots < 6; i++) {
      const raw = await page.evaluate(() => {
        const v = window.__ml.camView();
        const z = window.__ml.myScreen()?.zoom ?? 1;
        const all = window.__mlAmbient.debug("chimney").all;
        return {
          live: all.length,
          maxA: all.reduce((m, q) => Math.max(m, q.a), 0),
          pts: all
            // The band a mark is BIGGEST and most opaque in. `a` is the DRAWN
            // alpha, which carries the gain: unforced by day that peaks at
            // 0.26, so a 0.3 floor here would sample nothing at all.
            .filter((m) => m.a > 0.18 && m.t > 0.2 && m.t < 0.8)
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
      `pixels: ${shots} shots over ${marks} puff windows — a puff shifts its own window by ${best.toFixed(1)} luma, ` +
        `against ${noise.toFixed(1)} for the same windows with the effect off`,
    );
    console.log(
      `pixels: at best ${tally.live} puffs drawn, ${tally.bright} of them in the sample band (peak alpha ${tally.maxA.toFixed(3)}), ${tally.clear} of those clear of the HUD`,
    );
    if (shots < 3)
      fail(
        `only ${shots} frames put a puff in the clear game area — ${tally.live} puffs drawn, ${tally.bright} in the band, ${tally.clear} clear of the HUD` +
          (tally.live === 0 ? " (nothing was drawn at all)" : tally.bright === 0 ? " (every mark was fainter than the band's floor)" : " (the marks are behind the HUD)"),
      );
    if (noise > 12) fail(`the puffs' own windows moved ${noise.toFixed(1)} luma with the effect OFF — the envelope is measuring the world, not the smoke`);
    if (best < 12) fail(`a puff changes its own pixels by ${best.toFixed(1)} luma — it cannot be seen`);
    if (best < noise * 1.8 + 3) fail(`the marks move ${best.toFixed(1)} luma where the world alone moves ${noise.toFixed(1)}`);
  }
}

/* ---- COST ---- */
const cost = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  window.__mlAmbient.cost(true);
  for (let i = 0; i < 420; i++) await step();
  return window.__mlAmbient.cost(true).chimney;
});
console.log(`cost: ${cost.ms} ms/frame (peak ${cost.peak}) over ${cost.frames} frames`);
if (!(cost.frames > 100)) fail(`only ${cost.frames} frames measured — the cost check proved nothing`);
if (cost.ms > COST_MS) fail(`chimney cost ${cost.ms} ms/frame (ceiling ${COST_MS})`);
if (cost.peak > 3) fail(`a single frame cost ${cost.peak} ms — the vent read must stay throttled, not spike`);

/* Put the player back: the game persists where you logged out. */
await page.evaluate(async () => {
  window.__ml.lookAt();
  window.__ml.teleport(333.5, 237.5);
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
});

await browser.close();
console.log(failed ? "verify-chimney: FAILED" : "verify-chimney: OK");
if (failed) process.exitCode = 1;
