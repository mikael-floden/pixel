// Browser gate for the DEEP-WATER current effect.
//
// The unit test (server/test/deepcurrent.test.ts) pins the projection and the
// ramp. What it cannot see is the thing the effect is FOR: that the drift really
// streams the way the swimmer is being pushed, only on the open sea, and that
// it fades in over the shoreline band instead of switching on at a line.
//
//   node scripts/verify-deepwater.mjs        (needs the dev stack on :5173)
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
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
/* How far above the sea's own colour a mark may sit, measured on the composited
 * screen: the marks draw ADDITIVE, so this is the whole "pop" knob, and only
 * the composite says how loud they are (measured p99 +46, median +27 against a
 * day-lit sea of #cbd8d8).
 *
 * MAGNITUDE ONLY, DELIBERATELY. A hue test was written here and thrown away: on
 * the day-lit sea the blue channel is already 216, so an additive crest CLAMPS
 * blue long before red and every mark measures "warm" — that is the 8-bit
 * ceiling, not the colour choice. Judge how far a crest lifts the water, not
 * which way it tips at the top of the range. */
const POP_P99 = 60;

// The shipped display band (deepwater.ts SHOW_MIN_WU / SHOW_MAX_WU). Mirrored
// here on purpose: if the look is retuned, this gate must be retuned WITH it,
// deliberately, rather than following along and asserting whatever ships.
const SHOW_MIN_WU = 17;
const SHOW_MAX_WU = 41;

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

/* PARK: hold a cell against the current while the harness settles.
 * The deep sea DRAGS — that is the whole feature — so a gate that teleports
 * out to sea and then waits 240 frames measures wherever the swimmer has been
 * carried to, not where it put them: measured, the spot that read 120 wu/s on
 * arrival read 54.5 by the time the marks were sampled, and the "flat field"
 * the speed check needs had become a ramp. Every measurement out at sea is
 * taken while parked. */
await page.evaluate(() => {
  window.__park = async (col, row, frames) => {
    for (let i = 0; i < frames; i++) {
      if (i % 15 === 0) window.__ml.teleport(col, row);
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  window.__under = () => {
    const p = window.__ml.myScreen();
    if (!p) return null;
    const v = window.__ml.camView();
    return { x: v.x + p.sx / p.zoom, y: v.y + p.sy / p.zoom };
  };
});

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
 * shoreline edge, where the ramp is steep) and a spot in the OPEN SEA whose
 * whole neighbourhood is at full strength (where the field is flat). The two
 * bands test different things.
 *
 * TWO TRAPS, both paid for here:
 *   1. TELEPORT IS SERVER-AUTHORITATIVE. Reading the current one frame after
 *      asking to move reads the cell you were STANDING ON, and the search then
 *      picks its spot from stale numbers: it once reported "open sea at 120
 *      wu/s" for a cell whose settled reading is 32.7. Every probe here waits
 *      for `me()` to arrive first.
 *   2. THE MAP EDGE IS A SHORE. The depth field ramps with distance from land,
 *      and the world border behaves like one, so strength FALLS again as you
 *      approach it — walking east until the readings stop climbing walks you
 *      out of the deep and into the rim. The spot is chosen on its own
 *      neighbourhood being deep, not on how far out it is. */
const sea = await page.evaluate(async () => {
  const CELL = 32;
  const rafs = async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); };
  /** Teleport and WAIT for the server to put us there before reading. */
  const go = async (col, row) => {
    window.__ml.teleport(col, row);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => requestAnimationFrame(r));
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
  let edge = null;
  let deep = null;
  let best = null;
  const wi = window.__ml.worldInfo();
  const maxCol = (wi.w ?? 512) - 6;
  for (let d = 0; d < 260 && c0 + d <= maxCol; d += 3) {
    if (!(await go(c0 + d, r0))) continue;
    const at = under();
    if (!at) continue;
    const cur = window.__ml.deepCurrentAtScreen(at.x, at.y);
    if (!cur || !(cur.speed > 0)) continue;
    if (!edge) edge = { col: c0 + d, row: r0, cur };
    if (!best || cur.speed > best.cur.speed) best = { col: c0 + d, row: r0, cur };
    if (cur.speed < 119) continue;
    // FLAT means flat AROUND it, not merely here: the mark speed check compares
    // a reading a mark may have taken up to RECHECK_PX ago, so the field has to
    // hold over that distance in every direction, and the view has to be sea.
    const ring = [[80, 0], [-80, 0], [0, 40], [0, -40], [60, 30], [-60, -30]]
      .map(([dx, dy]) => window.__ml.deepCurrentAtScreen(at.x + dx, at.y + dy));
    if (ring.every((c) => c && c.speed >= 119)) { deep = { col: c0 + d, row: r0, cur }; break; }
  }
  deep = deep || (best && best.cur.speed >= 119 ? best : null);
  if (deep) await go(deep.col, deep.row);
  await rafs(4);
  return edge ? { ...edge, deep } : null;
});
if (!sea) { fail("never reached open sea — cannot exercise the effect"); }
else console.log(`shore edge at (${sea.col}, ${sea.row}) ${sea.cur.speed.toFixed(1)} wu/s; open sea at ${sea.deep ? `(${sea.deep.col}, ${sea.deep.row}) ${sea.deep.cur.speed.toFixed(0)} wu/s` : "NOT REACHED"}`);

if (sea && !sea.deep) fail("never reached full-strength open sea");
if (sea && sea.deep) {
  // Let the flock of marks populate. We are standing in the OPEN SEA here.
  const seen = await page.evaluate(async (d) => {
    await window.__park(d.col, d.row, 240);
    return window.__mlAmbient.debug("deepwater");
  }, sea.deep);
  console.log(`at sea: seaFrac=${seen.seaFrac} meanStrength=${seen.meanStrength} swells=${seen.swells} drift=${seen.drift}`);
  if (!(seen.drift > 0)) fail("no drift drawn on the open sea");
  if (!(seen.swells > 0)) fail("no swells drawn on the open sea");
  if (!(seen.meanStrength > 0.5)) fail(`open sea should be near full strength, got ${seen.meanStrength}`);

  /* THE WAVES MUST NOT PILE UP. The current converges, so it carries marks
   * together and parks them where it stalls; the feature answers by retiring a
   * crowded or stalled mark early and re-placing it. Measured over time, not
   * once: the heap forms as the field transports, so a single frame after a
   * fresh placement would always look evenly spread. */
  const crowd = await page.evaluate(async ({ deep, gap }) => {
    const out = { swell: { worst: 0, frames: 0, crowded: 0 }, drift: { worst: 0, frames: 0, crowded: 0 } };
    for (let i = 0; i < 260; i++) {
      if (i % 15 === 0) window.__ml.teleport(deep.col, deep.row);
      await new Promise((r) => requestAnimationFrame(r));
      const live = (window.__mlAmbient.debug("deepwater").all || []).filter((m) => m.a > 0.05);
      // PER FAMILY: a speck riding over a crest is the design, not crowding.
      for (const kind of ["swell", "drift"]) {
        const all = live.filter((m) => m.kind === kind);
        if (all.length < 4) continue;
        out[kind].frames++;
        let near = 0;
        for (let a = 0; a < all.length; a++)
          for (let b = a + 1; b < all.length; b++)
            if (Math.abs(all[a].x - all[b].x) < gap[kind] && Math.abs(all[a].y - all[b].y) < gap[kind]) near++;
        out[kind].worst = Math.max(out[kind].worst, near);
        if (near > 2) out[kind].crowded++;
      }
    }
    return out;
  }, { deep: sea.deep, gap: { swell: 20, drift: 10 } });
  for (const kind of ["swell", "drift"]) {
    const c = crowd[kind];
    console.log(`spacing (${kind}): ${c.frames} frames judged, worst ${c.worst} close pairs, ${c.crowded} frames with more than 2`);
    if (c.frames < 30) fail(`only ${c.frames} frames carried enough ${kind} marks to judge spacing`);
    if (c.worst > 6) fail(`${kind} marks are piling up: ${c.worst} close pairs in one frame`);
    if (c.crowded > c.frames * 0.25)
      fail(`${c.crowded} of ${c.frames} ${kind} frames are crowded — the density rule is not holding`);
  }

  /* THE SEA MUST STILL QUICKEN AS YOU SWIM OUT. Narrowing the band is a LOOK;
   * the mechanic is that the water visibly runs harder the further out you are,
   * and a flat rate would read as one moving wallpaper everywhere. Measured as
   * the median mark speed at the shoreline edge against the open sea. */
  const ranked = await page.evaluate(async ({ deep, edge }) => {
    const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0);
    const at = async (c) => {
      await window.__park(c.col, c.row, 150);
      const d = window.__mlAmbient.debug("deepwater");
      return {
        spd: median((d.all || []).filter((m) => m.a > 0.05).map((m) => m.spd)),
        n: (d.all || []).length,
        strength: d.meanStrength,
      };
    };
    const shore = await at(edge);
    const sea = await at(deep);
    return { shore, sea };
  }, { deep: sea.deep, edge: { col: sea.col, row: sea.row } });
  console.log(
    `rate ranking: shoreline ${ranked.shore.spd} px/s (strength ${ranked.shore.strength}, ${ranked.shore.n} marks) ` +
      `vs open sea ${ranked.sea.spd} px/s (strength ${ranked.sea.strength}, ${ranked.sea.n} marks)`,
  );
  if (!(ranked.sea.spd > ranked.shore.spd * 1.15))
    fail(`the sea does not quicken with the current: ${ranked.shore.spd} at the shore vs ${ranked.sea.spd} out at sea`);
  if (!(ranked.shore.spd > 4))
    fail(`the shallows are frozen (${ranked.shore.spd} px/s) — a weak current still moves water`);

  /* THE GLITTER RIDES A WAVE, AND ONLY PART OF ONE (maintainer 2026-09-07:
   * "small parts of the wave should spark (not the entire wave line)"). Two
   * halves: a spark must sit ON some crest, and it must BLINK — a spark that is
   * always lit is a bead on a string, not a glint. */
  const spark = await page.evaluate(async (deep) => {
    await window.__park(deep.col, deep.row, 120);
    let frames = 0, sawNone = 0, sawSome = 0, offCrest = 0, most = 0, sparkFrames = 0;
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const d = window.__mlAmbient.debug("deepwater");
      const swells = (d.all || []).filter((m) => m.kind === "swell");
      if (!swells.length) continue;
      frames++;
      const n = d.sparks || 0;
      most = Math.max(most, n);
      if (n === 0) sawNone++;
      else { sawSome++; sparkFrames++; }
      if (n > swells.length) offCrest++; // more glints than waves to carry them
    }
    return { frames, sawNone, sawSome, offCrest, most, sparkFrames };
  }, sea.deep);
  console.log(`sparkle: ${spark.sawSome} of ${spark.frames} frames glinting, at most ${spark.most} at once`);
  if (spark.frames < 30) fail(`only ${spark.frames} frames carried waves — the sparkle check proved nothing`);
  if (!spark.sawSome) fail("the sea never glints");
  if (spark.offCrest) fail(`${spark.offCrest} frames drew more glints than there are waves to carry them`);
  if (spark.most > 8) fail(`${spark.most} glints at once reads as sparkle, not as a wave catching the light`);

  /* THE LAKE CHOP MUST STOP AT THE DEEP-WATER LINE. Its wavelets and glints are
   * a POND look and do not move with the current; drawn over the open sea they
   * read as two seas laid on top of each other. It cannot tell the two apart by
   * surface (identical Surface records), so it reads the current probe. */
  const chop = await page.evaluate(async (deep) => {
    window.__mlAmbient.setEnabled("water", true);
    await window.__park(deep.col, deep.row, 220);
    const d = window.__mlAmbient.debug("water");
    const out = { lit: d.lit, waterFrac: d.waterFrac, gain: d.gain };
    window.__mlAmbient.setEnabled("water", false);
    return out;
  }, sea.deep);
  console.log(`lake chop out at sea: ${chop.lit} marks lit, waterFrac ${chop.waterFrac}`);
  if (chop.lit > 0) fail(`the lake chop drew ${chop.lit} marks on the open sea — deep water has its own effect`);

  // THE WAVES MUST NOT POP (maintainer 2026-09-06: they "should pop less,
  // should be similar in color to the deep_water"). Measured on the real
  // screen, not on the constants: the marks draw ADDITIVE over deep_water's own
  // colour, so what ships is water + colour x alpha, and only the composite
  // says how loud it is. The sample is a strip along the TOP of the game view —
  // open sea at this spot, and far from the swimmer's own foam and waterline.
  if (seen.seaFrac > 0.9) {
    await page.evaluate(async (d) => window.__park(d.col, d.row, 20), sea.deep);
    const png = PNG.sync.read(await page.screenshot({ clip: { x: 0, y: 0, width: 480, height: 64 } }));
    const counts = new Map();
    const at = (i) => [png.data[i], png.data[i + 1], png.data[i + 2]];
    for (let i = 0; i < png.data.length; i += 4) {
      const k = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let mode = 0, best = 0;
    for (const [k, n] of counts) if (n > best) { best = n; mode = k; }
    // NOT named `sea` — that is the outer const holding the spot we swam to,
    // and a same-named local puts it in the temporal dead zone for this whole
    // block (the park call above it throws before a pixel is read).
    const water = [(mode >> 16) & 255, (mode >> 8) & 255, mode & 255];
    const lifts = [];
    for (let i = 0; i < png.data.length; i += 4) {
      const p = at(i);
      const d = [p[0] - water[0], p[1] - water[1], p[2] - water[2]];
      const lift = Math.max(...d);
      if (lift > 4) lifts.push(lift);
    }
    lifts.sort((a, b) => a - b);
    const pct = (q) => (lifts.length ? lifts[Math.min(lifts.length - 1, Math.floor(lifts.length * q))] : 0);
    console.log(
      `crest restraint: sea #${water.map((c) => c.toString(16).padStart(2, "0")).join("")}, ` +
        `${lifts.length} lifted px, median +${pct(0.5)}, p99 +${pct(0.99)}, max +${lifts[lifts.length - 1] ?? 0}`,
    );
    if (lifts.length < 20) fail(`only ${lifts.length} pixels of the strip carry a mark — the sea is not moving at all`);
    if (pct(0.99) > POP_P99) fail(`the marks pop: p99 brightening +${pct(0.99)} over the sea (max +${POP_P99})`);
  }

  // THE POINT OF THE EFFECT: every mark must stream along the current the game
  // would push the player with, at the speed it would push them.
  const agree = await page.evaluate(async ({ RECHECK_PX, deep, SHOW_MIN_WU, SHOW_MAX_WU }) => {
    await window.__park(deep.col, deep.row, 20);
    const d = window.__mlAmbient.debug("deepwater");
    const CELL = 32, IDX = 32, IDY = 14;
    const proj = (cur) => {
      const px = ((cur.dx - cur.dy) / CELL) * IDX;
      const py = ((cur.dx + cur.dy) / CELL) * IDY;
      const L = Math.hypot(px, py) || 1;
      return { ux: px / L, uy: py / L, speed: cur.speed * L, scale: L };
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
      // The SHIPPED display rate: a narrow band that ranks with the current,
      // not the current's own speed (see SHOW_MIN_WU/SHOW_MAX_WU).
      const strength = Math.max(0, Math.min(1, here.speed / 120));
      const want = w.scale * (SHOW_MIN_WU + (SHOW_MAX_WU - SHOW_MIN_WU) * strength);
      out.push({ dot: m.ux * w.ux + m.uy * w.uy, spd: m.spd, want, tow: w.speed, strength, flat });
    }
    return out;
  }, { RECHECK_PX: 44, deep: sea.deep, SHOW_MIN_WU, SHOW_MAX_WU });
  const bad = agree.filter((a) => a.dot < 0.9);
  console.log(`heading agreement: ${agree.length} marks sampled, ${bad.length} off-current`);
  if (agree.length < 5) fail(`only ${agree.length} marks to check — too few to trust`);
  if (bad.length) fail(`${bad.length} marks stream off the real current (worst dot ${Math.min(...bad.map((b) => b.dot)).toFixed(3)})`);
  /* THE PICTURE'S RATE IS NOT THE TOW RATE (maintainer 2026-09-07: matching the
   * two "feels too fast and at the start a bit too slow"). What is asserted is
   * the shipped band — SHOW_MIN_WU..SHOW_MAX_WU scaled by the projection — and,
   * below, that it still RANKS with the current, which is the mechanic. The
   * open sea is checked against a number the tow would fail: at strength 1 the
   * marks run at about a third of what drags the player.
   *
   * Speed is checked HERE, in the open sea, and only here. A mark carries the
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
  // Non-vacuity: the band must be well clear of the tow speed it replaced, or
  // this test would still pass against the rate the maintainer rejected.
  const towed = flat.filter((a) => Math.abs(a.spd - a.tow) < Math.max(2, a.tow * 0.06));
  if (flat.length && towed.length)
    fail(`${towed.length} marks still run at the TOW speed (e.g. ${towed[0].spd} vs tow ${towed[0].tow.toFixed(1)})`);

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
  const ramp = await page.evaluate(async (deep) => {
    await window.__park(deep.col, deep.row, 20);
    const at = window.__under();
    if (!at) return null;
    let x = at.x;
    let y = at.y;
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
  }, sea.deep);
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
    return { seaFrac: d.seaFrac, drift: d.drift, swells: d.swells, maxA: Math.max(0, ...d.all.map((m) => m.a)) };
  }, home);
  console.log(`back inland: seaFrac=${inland.seaFrac} drift=${inland.drift} swells=${inland.swells} maxAlpha=${inland.maxA}`);
  if (inland.maxA > 0) fail(`the current is still drawing inland (alpha ${inland.maxA}) — it must be open sea only`);
}

await browser.close();
console.log(failed ? "verify-deepwater: FAILED" : "verify-deepwater: OK");
if (failed) process.exitCode = 1;
