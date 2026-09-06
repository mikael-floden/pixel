// Browser gate for the DEEP-WATER current effect.
//
// The unit test (server/test/deepcurrent.test.ts) pins the projection and the
// ramp. What it cannot see is the thing the effect is FOR: that the foam really
// streams the way the swimmer is being pushed, only on the open sea, and that
// it fades in over the shoreline band instead of switching on at a line.
//
//   node scripts/verify-deepwater.mjs        (needs the dev stack on :5173)
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
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 60_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });

// The probe must exist at all — without it the feature is dark by design.
const hasProbe = await page.evaluate(() => typeof window.__ml.deepCurrentAtScreen === "function");
if (!hasProbe) fail("__ml.deepCurrentAtScreen is missing — the effect cannot see deep water");
console.log("probe present:", hasProbe);

// Freeze the world clock at Day. The clock runs during a (slow, headless)
// settle, and night halves the marks' alpha — an unpinned run drifts into
// evening and reports a dimmer effect than the one being tested.
await page.evaluate(() => { window.__ml.timeSpeed(0); window.__ml.timeOfDay("Day", true); });

// Register + enable the feature on its own (no other effect in the picture).
const listed = await page.evaluate(() => {
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "deepwater");
  return window.__mlAmbient.list();
});
if (!listed.includes("deepwater")) fail(`feature not registered; list = ${listed.join(", ")}`);

// Where the player starts: dry land / the sheltered shallows. Recorded BEFORE
// going to sea so the return trip is a real return.
const home = await page.evaluate(() => {
  const me = window.__ml.me();
  return { col: Math.round(me.x / 32), row: Math.round(me.y / 32) };
});

/** Walk out to sea, recording BOTH the first cell that has any current (the
 * shoreline edge, where the ramp is steep) and the first at full strength (the
 * open sea, where the field is flat). The two bands test different things. */
const sea = await page.evaluate(async () => {
  const me = window.__ml.me();
  const CELL = 32;
  const c0 = Math.round(me.x / CELL);
  const r0 = Math.round(me.y / CELL);
  let edge = null;
  let deep = null;
  let full = 0;
  let last = null; // deepest full-strength cell seen, if the map runs out first
  const wi = window.__ml.worldInfo();
  const maxCol = (wi.w ?? 512) - 6; // never walk into the map bound: off-grid clamps
  for (let d = 0; d < 260 && c0 + d <= maxCol; d += 3) {
    window.__ml.teleport(c0 + d, r0);
    await new Promise((r) => requestAnimationFrame(r));
    const p = window.__ml.myScreen();
    if (!p) continue;
    const v = window.__ml.camView();
    const cur = window.__ml.deepCurrentAtScreen(v.x + p.sx / p.zoom, v.y + p.sy / p.zoom);
    if (!cur || !(cur.speed > 0)) continue;
    if (!edge) edge = { col: c0 + d, row: r0, cur };
    // Not merely the FIRST full-strength cell: the camera shows ~15 cells, and
    // the ramp band is 5.5 of them, so a view taken at the edge of the deep is
    // still mostly shoreline and proves nothing about the flat field. Keep
    // going until the current has been at full strength for a good stretch.
    if (cur.speed >= 119) {
      full += 3;
      last = { col: c0 + d, row: r0, cur };
      if (full >= 24) { deep = last; break; }
    } else full = 0;
  }
  deep = deep || last;
  if (deep) window.__ml.teleport(deep.col, deep.row);
  return edge ? { ...edge, deep } : null;
});
if (!sea) { fail("never reached open sea — cannot exercise the effect"); }
else console.log(`shore edge at (${sea.col}, ${sea.row}) ${sea.cur.speed.toFixed(1)} wu/s; open sea at ${sea.deep ? `(${sea.deep.col}, ${sea.deep.row}) ${sea.deep.cur.speed.toFixed(0)} wu/s` : "NOT REACHED"}`);

if (sea && !sea.deep) fail("never reached full-strength open sea");
if (sea && sea.deep) {
  // Let the flock of marks populate. We are standing in the OPEN SEA here.
  const seen = await page.evaluate(async () => {
    for (let i = 0; i < 240; i++) await new Promise((r) => requestAnimationFrame(r));
    return window.__mlAmbient.debug("deepwater");
  });
  console.log(`at sea: seaFrac=${seen.seaFrac} meanStrength=${seen.meanStrength} swells=${seen.swells} foam=${seen.foam}`);
  if (!(seen.foam > 0)) fail("no foam drawn on the open sea");
  if (!(seen.swells > 0)) fail("no swells drawn on the open sea");
  if (!(seen.meanStrength > 0.5)) fail(`open sea should be near full strength, got ${seen.meanStrength}`);

  // THE POINT OF THE EFFECT: every mark must stream along the current the game
  // would push the player with, at the speed it would push them.
  const agree = await page.evaluate((RECHECK_PX) => {
    const d = window.__mlAmbient.debug("deepwater");
    const CELL = 32, IDX = 32, IDY = 14;
    const proj = (cur) => {
      const px = ((cur.dx - cur.dy) / CELL) * IDX;
      const py = ((cur.dx + cur.dy) / CELL) * IDY;
      const L = Math.hypot(px, py) || 1;
      return { ux: px / L, uy: py / L, speed: cur.speed * L };
    };
    const out = [];
    for (const m of d.all) {
      const here = window.__ml.deepCurrentAtScreen(m.x, m.y);
      if (!here) continue;
      // Was the field FLAT over the whole distance this mark may have carried a
      // stale reading? Sample back along its own heading by the staleness bound.
      const back = window.__ml.deepCurrentAtScreen(m.x - m.ux * RECHECK_PX, m.y - m.uy * RECHECK_PX);
      const flat = !!back && here.speed >= 119 && back.speed >= 119;
      const w = proj(here);
      out.push({ dot: m.ux * w.ux + m.uy * w.uy, spd: m.spd, want: w.speed, flat });
    }
    return out;
  }, 44);
  const bad = agree.filter((a) => a.dot < 0.9);
  console.log(`heading agreement: ${agree.length} marks sampled, ${bad.length} off-current`);
  if (agree.length < 5) fail(`only ${agree.length} marks to check — too few to trust`);
  if (bad.length) fail(`${bad.length} marks stream off the real current (worst dot ${Math.min(...bad.map((b) => b.dot)).toFixed(3)})`);
  /* Speed is checked HERE, in the open sea, and only here. A mark carries the
   * reading from where it last probed (bounded by RECHECK_PX), so across the
   * shoreline ramp — which climbs 0 to full over ~176 px — a perfectly correct
   * mark legitimately differs from the current under its feet. Out at sea the
   * field is flat, so staleness cannot hide a wrong speed and the tolerance can
   * be tight. Direction, which the ramp does not change, is checked everywhere. */
  const flat = agree.filter((a) => a.flat);
  const spdOff = flat.filter((a) => Math.abs(a.spd - a.want) > Math.max(2, a.want * 0.06));
  console.log(`speed agreement: ${flat.length} of ${agree.length} marks sit in a FLAT field, ${spdOff.length} off-rate`);
  if (flat.length < 3) fail(`only ${flat.length} marks in a flat field — the speed check proved nothing`);
  if (spdOff.length) fail(`${spdOff.length} marks move at the wrong speed (e.g. ${spdOff[0].spd} vs ${spdOff[0].want.toFixed(1)})`);

  /* THE RAMP MUST RAMP. The current fades in over a shoreline band so the sea
   * does not switch on at a line; if that inverted or flattened, the effect
   * would shout loudest exactly where it barely acts.
   *
   * Walked with the PROBE, not with the player. Teleporting and re-reading is
   * server-authoritative and needs the move to land first, which made this
   * check depend on how many frames a starved headless run happened to get —
   * it read the previous cell and reported a real ramp as flat. Stepping a
   * sampling point along the current's own direction has no such race: the
   * flow points inward, so walking WITH it walks toward the shallows. */
  const ramp = await page.evaluate(() => {
    const me = window.__ml.myScreen();
    const v = window.__ml.camView();
    if (!me) return null;
    let x = v.x + me.sx / me.zoom;
    let y = v.y + me.sy / me.zoom;
    const out = [];
    for (let i = 0; i < 10; i++) {
      const cur = window.__ml.deepCurrentAtScreen(x, y);
      out.push(cur ? +cur.speed.toFixed(1) : 0);
      if (!cur) break;
      // Project the flat current into drawn space and step along it (inward).
      const CELL = 32, IDX = 32, IDY = 14;
      const px = ((cur.dx - cur.dy) / CELL) * IDX;
      const py = ((cur.dx + cur.dy) / CELL) * IDY;
      const L = Math.hypot(px, py) || 1;
      x += (px / L) * 46;
      y += (py / L) * 46;
    }
    return out;
  });
  console.log("current walking INWARD from the open sea:", ramp ? ramp.join(" -> ") : "(no reading)");
  if (!ramp || ramp.length < 3) fail("could not walk the ramp inward");
  else {
    if (!(ramp[0] >= 119)) fail(`should start at full strength out at sea, got ${ramp[0]}`);
    if (!(ramp[ramp.length - 1] < ramp[0]))
      fail(`the current does not weaken toward the shore: ${ramp.join(", ")}`);
    // Monotone within a tolerance: the walk is a straight line across a field
    // built from a BFS distance, so a step may sidle along an isoline, but it
    // must never climb back up on the way in.
    const climbs = ramp.filter((v, i) => i > 0 && v > ramp[i - 1] + 1);
    if (climbs.length) fail(`the current strengthens on the way IN: ${ramp.join(", ")}`);
  }

  // ON A LAKE / ON LAND the effect must draw nothing at all — that is the whole
  // complaint this feature answers (the same chop on a pond and the open sea).
  const inland = await page.evaluate(async (h) => {
    window.__ml.teleport(h.col, h.row);
    for (let i = 0; i < 260; i++) await new Promise((r) => requestAnimationFrame(r));
    const d = window.__mlAmbient.debug("deepwater");
    return { seaFrac: d.seaFrac, foam: d.foam, swells: d.swells, maxA: Math.max(0, ...d.all.map((m) => m.a)) };
  }, home);
  console.log(`back inland: seaFrac=${inland.seaFrac} foam=${inland.foam} swells=${inland.swells} maxAlpha=${inland.maxA}`);
  if (inland.maxA > 0) fail(`the current is still drawing inland (alpha ${inland.maxA}) — it must be open sea only`);
}

await browser.close();
console.log(failed ? "verify-deepwater: FAILED" : "verify-deepwater: OK");
if (failed) process.exitCode = 1;
