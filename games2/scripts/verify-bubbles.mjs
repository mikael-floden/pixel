// Browser gate for BUBBLES — a string of them rising out of the deep and
// bursting at the top.
//
// Three things the maintainer asked for by name (2026-09-07), so three things
// this measures rather than assumes:
//   "don't make the game slow"     → the feature's own ms/frame, its probe rate,
//                                    and the INLAND worst case where there is no
//                                    sea to find and the hunt can never succeed.
//   "think about the fade in/out"  → every bubble is TRACKED BY ID across frames
//                                    and must both arrive and leave faint. A
//                                    bubble that appears or vanishes at full
//                                    opacity is the failure, and only per-bubble
//                                    tracking can see it.
//   "good looking bubbles"         → the parts that make it read: it GROWS as it
//                                    climbs, it RISES up-screen, it BURSTS at the
//                                    top, and it leans on the real current.
//
//   node scripts/verify-bubbles.mjs        (needs the dev stack on :5173)
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
const PROBES_PER_S = 40;
const HUNTS_PER_S = 1.4; // PLACE_MS is 1200 — the no-sea worst case
const FADE_FRAC = 0.55; // first/last alpha must be under this fraction of its own peak

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("bubbles")))) fail("bubbles is not registered");

/* ---- IT IS IN THE SETTINGS MENU, AND THE SWITCH WORKS ---- */
const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find(
    (b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings",
  );
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const rows = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')];
  const labels = rows.map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  return { rows: rows.length, labels, found: labels.some((t) => t.toLowerCase().startsWith("bubbles")) };
});
if (ui.error) fail(ui.error);
else {
  console.log(`settings: ${ui.rows} ambient rows — ${ui.found ? '"Bubbles" is one of them' : "NO bubbles row"}`);
  if (!ui.found) fail(`no "Bubbles" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
}

/* ---- OUT TO THE OPEN SEA ----
 * Two traps, both inherited from verify-deepwater and both still live: TELEPORT
 * IS SERVER-AUTHORITATIVE (reading one frame after asking reads the cell you
 * were standing on), and THE MAP EDGE IS A SHORE (the current ramps down again
 * at the rim, so "keep going until it stops rising" walks you out of the deep). */
await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "bubbles");
});
const sea = await page.evaluate(async () => {
  const CELL = 32;
  const step = () => new Promise((r) => requestAnimationFrame(r));
  const go = async (col, row) => {
    window.__ml.teleport(col, row);
    for (let i = 0; i < 40; i++) {
      await step();
      const me = window.__ml.me();
      if (me && Math.round(me.x / CELL) === col && Math.round(me.y / CELL) === row) return true;
    }
    return false;
  };
  const under = () => {
    const p = window.__ml.myScreen();
    if (!p) return null;
    const v = window.__ml.camView();
    return { x: v.x + p.sx / p.zoom, y: v.y + p.sy / p.zoom };
  };
  const me0 = window.__ml.me();
  const c0 = Math.round(me0.x / CELL);
  const r0 = Math.round(me0.y / CELL);
  const wi = window.__ml.worldInfo();
  const maxCol = (wi.w ?? 512) - 6;
  let best = null;
  for (let d = 0; d < 260 && c0 + d <= maxCol; d += 3) {
    if (!(await go(c0 + d, r0))) continue;
    const at = under();
    if (!at) continue;
    const cur = window.__ml.deepCurrentAtScreen(at.x, at.y);
    if (!cur || !(cur.speed > 0)) continue;
    if (!best || cur.speed > best.speed) best = { col: c0 + d, row: r0, speed: cur.speed };
    if (cur.speed < 119) continue;
    const ring = [[80, 0], [-80, 0], [0, 40], [0, -40]].map(([dx, dy]) =>
      window.__ml.deepCurrentAtScreen(at.x + dx, at.y + dy),
    );
    if (ring.every((c) => c && c.speed >= 119)) return { col: c0 + d, row: r0, speed: cur.speed };
  }
  return best;
});
if (!sea) fail("never reached open sea — cannot exercise the effect");
else {
  console.log(`open sea at (${sea.col}, ${sea.row}) ${sea.speed.toFixed(0)} wu/s`);
  await page.evaluate(async (s) => {
    window.__ml.teleport(s.col, s.row);
    for (let i = 0; i < 260; i++) await new Promise((r) => requestAnimationFrame(r));
  }, sea);

  /* ---- WHAT MAKES IT A BUBBLE: it climbs, it grows, it bursts, it fades ----
   * Tracked BY ID, which is the only way to see a fade: the population is a
   * blur of comings and goings, so a snapshot can never tell an arriving bubble
   * from a leaving one. */
  const life = await page.evaluate(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    const seen = new Map(); // id -> {first, last, peak, y0, y1, st0, st1, n, popped}
    let vents = 0, onLand = 0, samples = 0;
    let ventFlow = null;
    for (let i = 0; i < 900; i++) {
      const d = window.__mlAmbient.debug("bubbles");
      vents = Math.max(vents, d.vents);
      if (!ventFlow && (d.ventList || [])[0]) ventFlow = d.ventList[0].flow;
      for (const b of d.all || []) {
        samples++;
        if (window.__ml.landableAtScreen(b.x, b.y)) onLand++;
        let r = seen.get(b.id);
        if (!r) { r = { first: b.a, peak: b.a, y0: b.y, st0: b.stage, n: 0, popped: false }; seen.set(b.id, r); }
        r.last = b.a;
        r.peak = Math.max(r.peak, b.a);
        r.y1 = b.y;
        r.st1 = b.stage;
        r.n++;
        if (b.popping) r.popped = true;
      }
      await step();
    }
    const done = [...seen.values()].filter((r) => r.n >= 6);
    const rose = done.filter((r) => r.y1 < r.y0).length;
    const grew = done.filter((r) => r.st1 > r.st0).length;
    const popped = done.filter((r) => r.popped).length;
    const softIn = done.filter((r) => r.first <= r.peak * 0.55).length;
    const softOut = done.filter((r) => r.last <= r.peak * 0.55).length;
    const hardIn = done.filter((r) => r.first > r.peak * 0.55).map((r) => +(r.first / r.peak).toFixed(2));
    const hardOut = done.filter((r) => r.last > r.peak * 0.55).map((r) => +(r.last / r.peak).toFixed(2));
    return {
      tracked: done.length, samples, onLand, vents, ventFlow,
      rose, grew, popped, softIn, softOut,
      hardIn: hardIn.slice(0, 5), hardOut: hardOut.slice(0, 5),
      pops: window.__mlAmbient.debug("bubbles").pops,
    };
  });
  console.log(
    `bubbles: ${life.tracked} tracked over ${life.samples} samples from up to ${life.vents} vents ` +
      `(current [${life.ventFlow}]); ${life.rose} rose, ${life.grew} grew, ${life.popped} burst (${life.pops} pops total)`,
  );
  console.log(`fade: ${life.softIn} of ${life.tracked} arrived faint, ${life.softOut} of ${life.tracked} left faint`);
  if (!life.tracked) fail("no bubbles at all on the open sea");
  else {
    if (life.onLand) fail(`${life.onLand} bubble samples were over walkable ground — these are DEEP WATER bubbles`);
    if (life.rose < life.tracked * 0.9) fail(`only ${life.rose} of ${life.tracked} bubbles moved up-screen as they climbed`);
    if (life.grew < life.tracked * 0.7) fail(`only ${life.grew} of ${life.tracked} bubbles grew on the way up`);
    if (!life.popped) fail("no bubble ever burst — the pop is what makes it read as a bubble and not a dot");
    // THE FADE, both ends.
    if (life.softIn < life.tracked * 0.95)
      fail(`${life.tracked - life.softIn} bubbles APPEARED at full opacity (worst ratios ${life.hardIn.join(", ")})`);
    if (life.softOut < life.tracked * 0.95)
      fail(`${life.tracked - life.softOut} bubbles VANISHED at full opacity (worst ratios ${life.hardOut.join(", ")})`);
  }
}

/* ---- FPS: cost, probes, and the worst case where there is no sea ---- */
const cost = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  window.__mlAmbient.cost(true);
  const p0 = window.__mlAmbient.debug("bubbles").probes;
  const t0 = performance.now();
  for (let i = 0; i < 360; i++) await step();
  const atSea = window.__mlAmbient.cost(true).bubbles;
  const probesPerS = ((window.__mlAmbient.debug("bubbles").probes - p0) * 1000) / (performance.now() - t0);

  // Inland: no sea in view, so the vent hunt can never succeed.
  const me = window.__ml.me();
  window.__ml.teleport(Math.round(me.x / 32) - 90, Math.round(me.y / 32));
  for (let i = 0; i < 200; i++) await step();
  window.__mlAmbient.cost(true);
  const h0 = window.__mlAmbient.debug("bubbles").hunts;
  const t1 = performance.now();
  for (let i = 0; i < 300; i++) await step();
  const dry = window.__mlAmbient.cost(true).bubbles;
  const huntsPerS = ((window.__mlAmbient.debug("bubbles").hunts - h0) * 1000) / (performance.now() - t1);
  const d = window.__mlAmbient.debug("bubbles");
  return {
    atSea, dry, probesPerS: +probesPerS.toFixed(1), huntsPerS: +huntsPerS.toFixed(2),
    dryVents: d.vents, dryBubbles: d.bubbles,
  };
});
console.log(
  `cost: at sea ${cost.atSea.ms} ms/frame (peak ${cost.atSea.peak}) over ${cost.atSea.frames} frames, ` +
    `${cost.probesPerS} probes/s; inland ${cost.dry.ms} ms/frame, ${cost.huntsPerS} vent hunts/s ` +
    `(${cost.dryVents} vents, ${cost.dryBubbles} bubbles)`,
);
if (!(cost.atSea.frames > 100)) fail(`only ${cost.atSea.frames} frames measured — the cost check proved nothing`);
if (cost.atSea.ms > COST_MS) fail(`bubbles cost ${cost.atSea.ms} ms/frame at sea (ceiling ${COST_MS})`);
if (cost.probesPerS > PROBES_PER_S) fail(`bubbles probe the world ${cost.probesPerS} times a second (ceiling ${PROBES_PER_S})`);
if (cost.dry.ms > COST_MS / 2) fail(`bubbles cost ${cost.dry.ms} ms/frame INLAND, where they draw nothing`);
if (cost.huntsPerS > HUNTS_PER_S) fail(`bubbles hunt for a vent ${cost.huntsPerS} times a second with no sea in view`);
if (cost.dryVents || cost.dryBubbles) fail(`${cost.dryVents} vents / ${cost.dryBubbles} bubbles inland — this is a deep-water effect`);

await browser.close();
console.log(failed ? "verify-bubbles: FAILED" : "verify-bubbles: OK");
if (failed) process.exitCode = 1;
