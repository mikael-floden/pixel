// Browser gate for BEACH CRABS — the sideways scuttle at the water's edge.
//
// Two of these arms exist because the maintainer asked for them by name
// (2026-09-07): "make sure the effect is toggleable in settings this time" and
// "make sure the game FPS is not slowed down by this effect".
//
//   TOGGLEABLE is asserted through the REAL SETTINGS UI — the row is found in
//   the DOM by the label he would read, clicked like he would click it, and the
//   effect has to start and stop drawing. Asserting the API underneath would
//   not have caught a missing row.
//
//   FPS is asserted three ways, because "it feels fine here" is not a
//   measurement: the feature's own per-frame cost, its PROBE rate, and — the
//   real worst case — its SEARCH rate while standing somewhere with no beach at
//   all, where a naive version would hunt for a shoreline every frame forever.
//
//   node scripts/verify-crabs.mjs        (needs the dev stack on :5173)
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

const COST_MS = 0.35;
const PROBES_PER_S = 90; // a bounded beach search, plus one ground probe per dash
const SEARCH_PER_S = 1.2; // PLACE_MS is 1500 — this is the inland worst case

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("crabs")))) fail("crabs is not registered");

/* ---- IT IS IN THE SETTINGS MENU, AND THE SWITCH WORKS ---- */
const ui = await page.evaluate(async () => {
  // Open Settings the way a player does.
  const tab = [...document.querySelectorAll(".ml-tab")].find(
    (b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings",
  );
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const rows = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')];
  const labels = rows.map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  const i = labels.findIndex((t) => t.toLowerCase().startsWith("crabs"));
  return { rows: rows.length, labels, found: i >= 0, label: i >= 0 ? labels[i] : null };
});
if (ui.error) fail(ui.error);
else {
  console.log(`settings: ${ui.rows} ambient rows — ${ui.found ? `"${ui.label}" is one of them` : "NO crabs row"}`);
  if (!ui.found) fail(`no "Crabs" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
}

// Clicking that row must actually start and stop the effect.
const toggled = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  const rowFor = (name) =>
    [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')].find((r) =>
      (r.querySelector(".ml-amb-label")?.textContent || "").toLowerCase().startsWith(name),
    );
  // Everything else off, so only the click under test can draw anything.
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, false);
  for (let i = 0; i < 60; i++) await step();
  const row = rowFor("crabs");
  if (!row) return null;
  row.click();
  for (let i = 0; i < 90; i++) await step();
  const onState = window.__mlAmbient.effects().find((e) => e.name === "crabs");
  const onGain = window.__mlAmbient.debug("crabs").gain;
  row.click();
  for (let i = 0; i < 240; i++) await step();
  const offState = window.__mlAmbient.effects().find((e) => e.name === "crabs");
  const d = window.__mlAmbient.debug("crabs");
  return { onEnabled: !!onState?.enabled, onGain, offEnabled: !!offState?.enabled, offGain: d.gain, offCrabs: d.crabs };
});
if (!toggled) fail("could not click the Crabs row");
else {
  console.log(
    `toggle: click on → enabled ${toggled.onEnabled} (gain ${toggled.onGain}); ` +
      `click off → enabled ${toggled.offEnabled} (gain ${toggled.offGain}, ${toggled.offCrabs} drawn)`,
  );
  if (!toggled.onEnabled) fail("clicking the Crabs row did not enable the effect");
  if (!(toggled.onGain > 0.5)) fail(`the effect did not come up after its switch was clicked (gain ${toggled.onGain})`);
  if (toggled.offEnabled) fail("clicking the Crabs row again did not disable the effect");
  if (toggled.offCrabs) fail(`${toggled.offCrabs} crabs still drawn after the switch was turned off`);
}

/* ---- A BEACH: on the sand, beside the water ---- */
await page.evaluate(async () => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "crabs");
});

// Walk out from the spawn until the feature itself reports it found a beach —
// derived, never a named cell.
const found = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  const me = window.__ml.me();
  const c0 = Math.round(me.x / 32);
  const r0 = Math.round(me.y / 32);
  for (let ring = 0; ring <= 60; ring += 5)
    for (let a = 0; a < 12; a++) {
      const c = c0 + Math.round(Math.cos((a / 12) * 6.283) * ring);
      const r = r0 + Math.round(Math.sin((a / 12) * 6.283) * ring);
      window.__ml.teleport(c, r);
      for (let i = 0; i < 130; i++) await step();
      const d = window.__mlAmbient.debug("crabs");
      if (d.colony && d.crabs) return { col: c, row: r, colony: d.colony, crabs: d.crabs };
    }
  return null;
});
if (!found) fail("no beach found anywhere near the spawn — the effect never placed a colony");
else {
  console.log(
    `beach at ${found.col},${found.row}: ${found.crabs} crabs, shore axis [${found.colony.shore}], ` +
      `water lies [${found.colony.toWater}], span ${found.colony.span}px, sand: ${found.colony.sandy}`,
  );

  const beach = await page.evaluate(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    let onLand = 0, onWater = 0, samples = 0;
    let alongOk = 0, alongBad = 0, moves = 0;
    const prev = new Map();
    let nearWater = null;
    for (let i = 0; i < 220; i++) {
      const d = window.__mlAmbient.debug("crabs");
      const c = d.colony;
      if (c) {
        if (nearWater === null) {
          // Is there really water beside this colony? (its own search says so —
          // this asks the game again, independently)
          nearWater = false;
          for (let k = 1; k <= 5 && !nearWater; k++)
            if (window.__ml.waterAtScreen(c.x + c.toWater[0] * 16 * k, c.y + c.toWater[1] * 16 * k)) nearWater = 16 * k;
        }
        for (const q of d.all || []) {
          samples++;
          if (window.__ml.landableAtScreen(q.x, q.y)) onLand++;
          if (window.__ml.waterAtScreen(q.x, q.y)) onWater++;
          /* THE RUNS FOLLOW THE SHORE — and the shore CURVES, so this asks the
           * LOCAL tangent, not the one at the colony's home. Comparing a
           * 480px bay against a single axis fails wherever the coast bends,
           * which is the coast doing its job (measured: 236 of 2500 "off
           * axis" runs were the curve). The tangent comes from the nearest
           * segment of the walked shoreline. */
          const last = prev.get("p" + (d.all || []).indexOf(q));
          if (last && (c.pts || []).length >= 2) {
            const dx = q.x - last[0];
            const dy = q.y - last[1];
            const len = Math.hypot(dx, dy);
            if (len > 1.2) {
              moves++;
              let bi = 1, bd = Infinity;
              for (let k = 1; k < c.pts.length; k++) {
                const mx = (c.pts[k][0] + c.pts[k - 1][0]) / 2;
                const my = (c.pts[k][1] + c.pts[k - 1][1]) / 2;
                const dd = (mx - q.x) ** 2 + (my - q.y) ** 2;
                if (dd < bd) { bd = dd; bi = k; }
              }
              const tx = c.pts[bi][0] - c.pts[bi - 1][0];
              const ty = c.pts[bi][1] - c.pts[bi - 1][1];
              const tl = Math.hypot(tx, ty) || 1;
              const dot = Math.abs((dx / len) * (tx / tl) + (dy / len) * (ty / tl));
              if (dot > 0.85) alongOk++; else alongBad++;
            }
          }
        }
        (d.all || []).forEach((q, j) => prev.set("p" + j, [q.x, q.y]));
      }
      await step();
    }
    return { onLand, onWater, samples, alongOk, alongBad, moves, nearWater };
  });
  console.log(
    `crabs: ${beach.samples} samples, ${beach.onLand} on land, ${beach.onWater} on water; ` +
      `water ${beach.nearWater === false ? "NOT FOUND" : beach.nearWater + "px"} from the colony; ` +
      `${beach.alongOk} of ${beach.moves} runs along the shore axis`,
  );
  if (!beach.samples) fail("no crabs to measure");
  if (beach.onWater) fail(`${beach.onWater} crab samples were standing on water`);
  if (beach.onLand < beach.samples) fail(`${beach.samples - beach.onLand} crab samples were off walkable ground`);
  if (beach.nearWater === false) fail("the colony is not beside water — these are BEACH crabs");
  if (!beach.moves) fail("no crab ever ran — the dash is the effect");
  if (beach.alongBad > beach.moves * 0.08)
    fail(`${beach.alongBad} of ${beach.moves} runs were off the shore — crabs run ALONG the water`);

  /* IS THAT POLYLINE REALLY THE SHORE? The test above takes the feature's own
   * word for where the beach runs, so this checks a sample of its segments
   * against the game directly: a shore tangent must be perpendicular to the way
   * the water lies at that point, measured here with the gate's own probes. */
  const shoreTruth = await page.evaluate(() => {
    const c = window.__mlAmbient.debug("crabs").colony;
    if (!c || (c.pts || []).length < 3) return null;
    const waterDir = (x, y) => {
      let sx = 0, sy = 0, hits = 0;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const dx = Math.cos(a), dy = Math.sin(a);
        for (let k = 1; k <= 3; k++) {
          if (!window.__ml.waterAtScreen(x + dx * 22 * k, y + dy * 22 * k)) continue;
          sx += dx / k; sy += dy / k; hits++;
          break;
        }
      }
      const len = Math.hypot(sx, sy);
      return hits && len > 1e-6 ? [sx / len, sy / len] : null;
    };
    let checked = 0, square = 0, worst = 0;
    const stride = Math.max(1, Math.floor((c.pts.length - 1) / 8));
    for (let k = 1; k < c.pts.length; k += stride) {
      const mx = (c.pts[k][0] + c.pts[k - 1][0]) / 2;
      const my = (c.pts[k][1] + c.pts[k - 1][1]) / 2;
      const w = waterDir(mx, my);
      if (!w) continue;
      const tx = c.pts[k][0] - c.pts[k - 1][0];
      const ty = c.pts[k][1] - c.pts[k - 1][1];
      const tl = Math.hypot(tx, ty) || 1;
      const dot = Math.abs((tx / tl) * w[0] + (ty / tl) * w[1]); // 0 = perpendicular
      checked++;
      if (dot < 0.5) square++;
      worst = Math.max(worst, dot);
    }
    return { checked, square, worst: +worst.toFixed(2) };
  });
  if (!shoreTruth || !shoreTruth.checked) console.log("shore: could not re-measure the water beside the polyline");
  else {
    console.log(`shore: ${shoreTruth.square} of ${shoreTruth.checked} sampled segments run square to the water (worst |dot| ${shoreTruth.worst})`);
    if (shoreTruth.square < shoreTruth.checked * 0.7)
      fail(`only ${shoreTruth.square} of ${shoreTruth.checked} shoreline segments are square to the water — that polyline is not the shore`);
  }

  /* ---- THEY USE THE WHOLE BEACH ----
   * "I have seen lots of crabs on a beach before, but not on a spot that
   * small! They usually use up the entire beach" (maintainer 2026-09-07). The
   * colony measures the shore for itself at placement; this walks the same
   * shore INDEPENDENTLY — its own loop, its own probes — and asks whether the
   * colony actually covers what is there. Re-deriving it in the gate is the
   * point: a colony that measured wrong would otherwise be checked against its
   * own mistake. */
  const spread = await page.evaluate(async () => {
    const d = window.__mlAmbient.debug("crabs");
    const c = d.colony;
    if (!c) return null;
    const [rx, ry] = c.shore;
    // THE GATE FOLLOWS THE CURVE TOO. A straight walk measures a bay as one
    // tile — which is how the feature's own first version under-measured it —
    // so comparing the colony against a straight walk would be comparing it
    // against the same mistake. Same idea, written independently here.
    const waterDir = (x, y) => {
      let sx = 0, sy = 0, hits = 0;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const dx = Math.cos(a), dy = Math.sin(a);
        for (let k = 1; k <= 3; k++) {
          if (!window.__ml.waterAtScreen(x + dx * 22 * k, y + dy * 22 * k)) continue;
          sx += dx / k; sy += dy / k; hits++;
          break;
        }
      }
      const len = Math.hypot(sx, sy);
      return hits && len > 1e-6 ? [sx / len, sy / len] : null;
    };
    const reach = (sign) => {
      let x = c.x, y = c.y, tx = rx * sign, ty = ry * sign, out = 0;
      for (let k = 0; k < 12; k++) {
        x += tx * 24; y += ty * 24;
        if (!window.__ml.landableAtScreen(x, y)) break;
        const w = waterDir(x, y);
        if (!w) break;
        out += 24;
        let nx = -w[1], ny = w[0];
        if (nx * tx + ny * ty < 0) { nx = -nx; ny = -ny; }
        tx = nx; ty = ny;
      }
      return out;
    };
    const beach = reach(1) + reach(-1);
    // How far apart do the crabs actually stand, along the shore?
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 200; i++) {
      for (const q of window.__mlAmbient.debug("crabs").all || []) { lo = Math.min(lo, q.s); hi = Math.max(hi, q.s); }
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { beach, span: c.span, used: hi - lo, crabs: (d.all || []).length, want: c.want };
  });
  if (!spread) fail("no colony to measure the spread of");
  else {
    console.log(
      `spread: the gate walked ${spread.beach}px of beach, the colony claims ${spread.span}px, ` +
        `and its ${spread.crabs} crabs ranged over ${spread.used.toFixed(0)}px of it`,
    );
    if (spread.beach > 64 && !(spread.span > 64))
      fail(`${spread.beach}px of beach and the colony sits on ${spread.span}px — one tile is exactly the complaint`);
    if (spread.beach > 64 && spread.span < spread.beach * 0.55)
      fail(`the colony uses ${spread.span}px of a ${spread.beach}px beach — crabs use the whole beach`);
    if (spread.used < Math.min(spread.span, 64) * 0.5)
      fail(`the crabs only ranged over ${spread.used.toFixed(0)}px of their own ${spread.span}px colony`);
  }

  /* ---- A CRAB IS RED, AND BIGGER THAN A SPIDER ----
   * Both were wrong on the first cut and both are the kind of thing that reads
   * instantly to a person and not at all to a test that only checks positions
   * (maintainer 2026-09-07: "you know crabs are red and bigger than spiders
   * right?"). The spider publishes its own art size so this compares the two
   * rather than hardcoding a number that rots when either changes. */
  const look = await page.evaluate(() => {
    const c = window.__mlAmbient.debug("crabs");
    const sp = window.__mlAmbient.debug("spiders");
    const tints = (c.all || []).map((q) => q.tint);
    return { art: c.art, spider: sp.art, tint: c.tint, tints };
  });
  const rgb = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const [cr, cg, cb] = rgb(look.tint);
  console.log(
    `look: crab art ${look.art.small.join("x")} / ${look.art.big.join("x")} vs spider ${(look.spider || []).join("x")}; ` +
      `shell rgb(${cr}, ${cg}, ${cb})`,
  );
  if (!look.spider) fail("the spider no longer publishes its art size — this comparison is now vacuous");
  else {
    const bigger = look.art.small[0] > look.spider[0] && look.art.small[0] * look.art.small[1] > look.spider[0] * look.spider[1];
    if (!bigger)
      fail(`a crab (${look.art.small.join("x")}) is not bigger than a spider (${look.spider.join("x")})`);
  }
  if (!(cr > cg * 1.7 && cr > cb * 1.7)) fail(`the shell is not red: rgb(${cr}, ${cg}, ${cb})`);
  for (const t of look.tints) {
    const [r, g, b] = rgb(t);
    if (!(r > g * 1.5 && r > b * 1.5)) { fail(`a drawn crab was not red: rgb(${r}, ${g}, ${b})`); break; }
  }

  /* ---- THE WHOLE BEACH MOVES AT ONCE ---- */
  const flee = await page.evaluate(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    const d0 = window.__mlAmbient.debug("crabs");
    const c = d0.colony;
    if (!c) return null;
    const at = window.__ml.pickAt(c.x, c.y); // WORLD UNITS; teleport takes CELLS
    if (!at) return null;
    /* STAND WELL CLEAR FIRST. Fleeing is per-crab now, so the baseline has to be
     * a colony nobody is near; measuring "calm" while standing in it reads
     * every crab as running and the comparison says nothing (it did: 14 -> 14). */
    /* NEAR CRABS AGAINST FAR CRABS, IN THE SAME COLONY, IN THE SAME FRAMES.
     * Two earlier shapes of this test both measured nothing. Counting the WHOLE
     * colony cannot see a local flee: on a 360px beach only the four at your
     * feet react, while about a fifth of the colony is dashing anyway on its own
     * timers (measured 5 -> 5). And walking away to get a baseline takes the
     * colony OFF VIEW, so it re-places somewhere else and you come back to an
     * empty beach ("no crabs came within reach"). Standing still and comparing
     * the crabs at your feet with the ones down the strand has neither problem,
     * and it is the thing itself: a wave of panic that travels with you. */
    window.__ml.teleport(at.x / 32, at.y / 32);
    for (let i = 0; i < 90; i++) await step();
    let nearSum = 0, nearN = 0, farSum = 0, farN = 0, sawNear = 0;
    for (let i = 0; i < 200; i++) {
      const p = window.__ml.myScreen();
      const v = window.__ml.camView();
      if (p && v) {
        const px = v.x + p.sx / p.zoom;
        const py = v.y + p.sy / p.zoom;
        const all = window.__mlAmbient.debug("crabs").all || [];
        const near = all.filter((q) => Math.hypot(q.x - px, q.y - py) < 74);
        const far = all.filter((q) => Math.hypot(q.x - px, q.y - py) > 150);
        if (near.length) { nearSum += near.filter((q) => q.dashing).length / near.length; nearN++; sawNear = Math.max(sawNear, near.length); }
        if (far.length) { farSum += far.filter((q) => q.dashing).length / far.length; farN++; }
      }
      await step();
    }
    return {
      calm: farN ? +(farSum / farN).toFixed(3) : null,
      spooked: nearN ? +(nearSum / nearN).toFixed(3) : null,
      sawNear,
      n: (window.__mlAmbient.debug("crabs").all || []).length,
    };
  });
  if (!flee) fail("could not measure the flee (no colony)");
  else {
    console.log(
      `flee: standing on the beach, ${flee.spooked === null ? "?" : (flee.spooked * 100).toFixed(0)}% of the ` +
        `${flee.sawNear} crabs at your feet are running against ${flee.calm === null ? "?" : (flee.calm * 100).toFixed(0)}% ` +
        `of the ones down the strand`,
    );
    if (flee.spooked === null || flee.calm === null)
      fail("could not see both near and far crabs at once — the flee check proved nothing");
    else if (!(flee.spooked > flee.calm * 1.6))
      fail(`crabs at your feet run ${(flee.spooked * 100).toFixed(0)}% of the time against ${(flee.calm * 100).toFixed(0)}% down the strand — walking in must set them off`);
  }
}

/* ---- FPS: cost, probe rate, and the inland worst case ---- */
const cost = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  window.__mlAmbient.cost(true);
  const p0 = window.__mlAmbient.debug("crabs").probes;
  const t0 = performance.now();
  for (let i = 0; i < 360; i++) await step();
  const beach = window.__mlAmbient.cost(true).crabs;
  const probesPerS = ((window.__mlAmbient.debug("crabs").probes - p0) * 1000) / (performance.now() - t0);

  // THE WORST CASE IS INLAND: no beach to find, so the search can never
  // succeed. Walk somewhere with no water in view and measure the hunt.
  const me = window.__ml.me();
  let inland = null;
  for (let ring = 8; ring <= 60 && !inland; ring += 6)
    for (let a = 0; a < 12 && !inland; a++) {
      const c = Math.round(me.x / 32) + Math.round(Math.cos((a / 12) * 6.283) * ring);
      const r = Math.round(me.y / 32) + Math.round(Math.sin((a / 12) * 6.283) * ring);
      window.__ml.teleport(c, r);
      for (let i = 0; i < 60; i++) await step();
      const d = window.__mlAmbient.debug("crabs");
      const v = window.__ml.camView();
      let wet = false;
      for (let gx = 0; gx < 6 && !wet; gx++)
        for (let gy = 0; gy < 6 && !wet; gy++)
          if (window.__ml.waterAtScreen(v.x + (v.w * gx) / 5, v.y + (v.h * gy) / 5)) wet = true;
      if (!wet && !d.colony) inland = { col: c, row: r };
    }
  if (!inland) return { beach, probesPerS: +probesPerS.toFixed(1), inland: null };
  window.__mlAmbient.cost(true);
  const s0 = window.__mlAmbient.debug("crabs").searches;
  const t1 = performance.now();
  for (let i = 0; i < 300; i++) await step();
  const dry = window.__mlAmbient.cost(true).crabs;
  const searchPerS = ((window.__mlAmbient.debug("crabs").searches - s0) * 1000) / (performance.now() - t1);
  return { beach, probesPerS: +probesPerS.toFixed(1), inland: { ...inland, dry, searchPerS: +searchPerS.toFixed(2) } };
});
console.log(
  `cost: on the beach ${cost.beach.ms} ms/frame (peak ${cost.beach.peak}) over ${cost.beach.frames} frames, ` +
    `${cost.probesPerS} probes/s`,
);
if (!(cost.beach.frames > 100)) fail(`only ${cost.beach.frames} frames measured — the cost check proved nothing`);
if (cost.beach.ms > COST_MS) fail(`crabs cost ${cost.beach.ms} ms/frame on a beach (ceiling ${COST_MS})`);
if (cost.probesPerS > PROBES_PER_S) fail(`crabs probe the world ${cost.probesPerS} times a second (ceiling ${PROBES_PER_S})`);
if (!cost.inland) console.log("inland: no beachless spot found near the spawn — worst case not exercised");
else {
  console.log(
    `inland (${cost.inland.col},${cost.inland.row}): ${cost.inland.dry.ms} ms/frame, ` +
      `${cost.inland.searchPerS} beach searches/s`,
  );
  if (cost.inland.dry.ms > COST_MS) fail(`crabs cost ${cost.inland.dry.ms} ms/frame INLAND, where they draw nothing`);
  if (cost.inland.searchPerS > SEARCH_PER_S)
    fail(`crabs hunt for a beach ${cost.inland.searchPerS} times a second with none in view — it must be rate-limited`);
}

await browser.close();
console.log(failed ? "verify-crabs: FAILED" : "verify-crabs: OK");
if (failed) process.exitCode = 1;
