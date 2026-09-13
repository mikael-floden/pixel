// Browser gate for FIRE SMOKE — "thin grey wisps curling up from open flames,
// so a fire reads as burning by day too" (maintainer 2026-09-13).
//
// NOT scripts/verify-smoke.mjs — that name is the games agent's whole-game
// smoke test and has been since long before this effect existed.
//
// The five things his sentence asks for, each measured:
//  1. OPEN FLAMES ONLY. A lantern is a real fire behind glass and must give off
//     nothing; a glow, a crystal and a shrine are not fires at all. The gate
//     stands at an enclosed lantern and requires silence — the embers' sharp
//     case. Both spots are DERIVED from the world doc and the scenery
//     manifests, never named.
//  2. IT GOES UP, and it is a COLUMN rather than a puff: the marks reach well
//     above the flame and never descend.
//  3. IT CURLS. The column's horizontal spread over its height is measured, so
//     a straight post fails.
//  4. THIN AND GREY, NOT ADDITIVE. A glowing grey over dark rock is a lantern;
//     the blend and the tint are asserted off the live sprite.
//  5. BY DAY. The point of the whole effect: the embers are the night half of
//     a fire and by noon nothing came off one at all.
//
//   node scripts/verify-firesmoke.mjs      (needs the dev stack on :5173)
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
const PROBES_PER_S = 4;
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
if (!(await page.evaluate(() => window.__mlAmbient.list().includes("smoke")))) fail("smoke is not registered");
const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find((b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings");
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')]
    .map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("smoke")) };
});
if (ui.error) fail(ui.error);
else if (!ui.found) fail(`no "Smoke" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
else console.log(`settings: ${ui.labels.length} ambient rows, "Smoke" is one of them`);

/* ---- WHERE THE FIRES ARE — DERIVED FROM THE SAME TWO FILES THE GAME READS ----
 * The world doc says which pieces are placed and lit; each piece's manifest
 * says what KIND of light it is. Nothing here is named: which world, which
 * piece and which cell all come out of the data (the embers' lesson — a
 * spiral of teleports measures the search, not the map). */
const worldDoc = (() => {
  const f = join("..", "maps2", "worlds3", WORLD, "world.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
})();
if (!worldDoc) fail(`could not read the world doc for ${WORLD}`);
const lightBlock = (piece) => {
  const f = join("..", "scenery", piece, "scenery.json");
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf8")).light || {}; } catch { return {}; }
};
/* ...and WHICH OF THEM STAND IN THE OPEN, from the deck cover rather than from
 * the player's own indoor verdict: `indoor()` answers about where the player is
 * standing, which reads roofed in a doorway, and the run then measured a cave
 * brazier instead of a fire on sunlit ground — the case the effect exists for.
 * 44 of the 51 open fires in the_game are outdoors. */
const roofed = new Set();
for (const d of worldDoc?.decks ?? [])
  if (d.kind === "roof" || d.kind === "cave") for (const c of d.cells ?? []) roofed.add(`${c.x},${c.y}`);
const openFires = [];
const lanterns = [];
for (const p of (worldDoc?.scenery ?? []).filter((p) => p.lit)) {
  const k = lightBlock(p.piece).kind;
  const col = Math.round(p.x), row = Math.round(p.y);
  const at = { col, row, piece: p.piece, kind: k ?? null, open: !roofed.has(`${col},${row}`) };
  if (typeof k === "string" && k.startsWith("fire/") && k !== "fire/enclosed") openFires.push(at);
  else if (k === "fire/enclosed") lanterns.push(at);
}
openFires.sort((a, b) => Number(b.open) - Number(a.open)); // sunlit ground first
console.log(
  `${WORLD}: ${openFires.length} open fires placed (${openFires.filter((f) => f.open).length} of them outdoors), ` +
    `${lanterns.length} enclosed lanterns`,
);
if (!openFires.length) fail("no open fire is placed in this world — nothing to exercise");

await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "smoke");
});

/** Stand at a spot and let the effect settle; report what it sees there.
 *  `wantOutdoor` prefers a fire in the open — the daylight case is the point
 *  of the effect, and most placements are indoors. */
const visit = (spots, { wantOutdoor = false, frames = 500 } = {}) =>
  page.evaluate(async ({ spots, wantOutdoor, frames }) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    for (const s of spots.slice(0, 16)) {
      window.__ml.teleport(s.col + 0.5, s.row + 0.5);
      for (let i = 0; i < 140; i++) await step();
      const d0 = window.__mlAmbient.debug("smoke");
      if (!d0.fires) continue;
      if (wantOutdoor && window.__ml.indoor().indoor) continue;
      let puffs = 0, maxA = 0, rose = 0, fell = 0, top = 0, spread = 0, draw = null;
      for (let i = 0; i < frames; i++) {
        const d = window.__mlAmbient.debug("smoke");
        puffs = Math.max(puffs, d.puffs);
        if (d.draw && (!draw || d.draw.alpha > draw.alpha)) draw = d.draw;
        for (const m of d.all) {
          maxA = Math.max(maxA, m.a);
          const up = m.fy - m.y;               // px above its own flame
          if (up > 0) rose++; else fell++;
          top = Math.max(top, up);
          spread = Math.max(spread, Math.abs(m.x - m.fx));
        }
        await step();
      }
      // the light counts from the FIRST read: a puff outlives the fire going
      // out of view, so reading them at the end can say "0 of 0 smoke" while
      // sixteen wisps are still in the air.
      return {
        at: [s.col, s.row], piece: s.piece, kind: s.kind, openGround: s.open, indoor: window.__ml.indoor().indoor,
        fires: d0.fires, lights: d0.lights, puffs, maxA: +maxA.toFixed(3),
        rose, fell, top, spread, draw,
      };
    }
    return null;
  }, { spots, wantOutdoor, frames });

/* ---- AN OPEN FIRE SMOKES, AND IT GOES UP ---- */
const fire = (await visit(openFires, { wantOutdoor: true })) ?? (await visit(openFires));
if (fire && !fire.openGround) console.log("fire: the run landed on a roofed fire — the sunlit case was not the one measured");
if (!fire) fail("none of the open fires visited reached the effect — all sealed or unloaded?");
else {
  console.log(
    `fire: ${fire.piece} (${fire.kind}) at ${fire.at}, indoor=${fire.indoor} — ${fire.fires} of ${fire.lights} light(s) ` +
      `smoke; up to ${fire.puffs} puffs, peak alpha ${fire.maxA}; reached ${fire.top}px above the flame ` +
      `(${fire.rose} samples above it, ${fire.fell} below); widest ${fire.spread}px off the column`,
  );
  if (!fire.puffs) fail("an open fire was in view and gave off nothing");
  if (!(fire.maxA > 0.05)) fail(`the thickest wisp drew at alpha ${fire.maxA} — nothing to see`);
  if (fire.fell > fire.rose * 0.02) fail(`${fire.fell} samples sat below their own flame against ${fire.rose} above — smoke goes UP`);
  if (!(fire.top >= 25)) fail(`the column only reached ${fire.top}px above the flame — it must climb clear of the piece`);
  // THIN: his first word. A column wider than it is tall is a cloud.
  if (!(fire.spread >= 2)) fail(`the column never left its own axis (${fire.spread}px) — it must CURL, not stand like a post`);
  if (fire.spread > fire.top) fail(`the column is ${fire.spread}px wide against ${fire.top}px tall — that is a cloud, not a wisp`);
  // GREY, AND NOT ADDITIVE.
  const d = fire.draw;
  if (!d) fail("no live puff to measure");
  else {
    const r = (d.tint >> 16) & 255, g = (d.tint >> 8) & 255, b = d.tint & 255;
    console.log(`look: ${d.dw}x${d.dh}px, blend ${d.blend}, tint ${r},${g},${b}, alpha ${d.alpha}, depth ${d.depth}`);
    if (d.blend !== 0) fail(`smoke draws with blend mode ${d.blend} — it must be NORMAL, never additive: smoke is in the way, it does not glow`);
    if (!(r === g && g === b)) fail(`the tint is ${r},${g},${b} — smoke has no colour of its own`);
    if (!(d.alpha > 0 && d.alpha <= 0.6)) fail(`a wisp drew at alpha ${d.alpha} — thin is the COLUMN, but a mark over 0.6 is a pillar`);
    if (!(d.depth > 900_000)) fail(`a wisp draws at depth ${d.depth} — under the darkness overlay, which paints it out`);
  }
}

/* ---- AND A LANTERN GIVES OFF NOTHING. The sharp case: it IS a fire. ---- */
if (!lanterns.length) console.log("lantern: none placed in this world — the discrimination was not exercised");
else {
  const cold = await page.evaluate(async (spots) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    for (const s of spots.slice(0, 12)) {
      window.__ml.teleport(s.col + 0.5, s.row + 0.5);
      for (let i = 0; i < 150; i++) await step();
      const d0 = window.__mlAmbient.debug("smoke");
      // a view with a lantern in it and no open fire anywhere near
      if (!d0.lights || d0.fires) continue;
      let puffs = 0, lights = 0;
      for (let i = 0; i < 260; i++) {
        const d = window.__mlAmbient.debug("smoke");
        puffs = Math.max(puffs, d.puffs);
        lights = Math.max(lights, d.lights);
        await step();
      }
      return { at: [s.col, s.row], piece: s.piece, kind: s.kind, puffs, lights };
    }
    return null;
  }, lanterns);
  if (!cold) console.log("lantern: no view with a lantern and no open fire was found — discrimination not exercised");
  else {
    console.log(`lantern: ${cold.piece} (${cold.kind}) at ${cold.at} — ${cold.lights} light(s) in view, ${cold.puffs} puffs`);
    if (cold.puffs) fail(`${cold.puffs} wisps over a light that is not an open flame — a lantern burns behind glass`);
  }
}

/* ---- IT IS THE DAY CASE ---- */
if (fire) {
  const byHour = await page.evaluate(async (at) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    window.__ml.teleport(at[0] + 0.5, at[1] + 0.5);
    const sample = async (phase) => {
      window.__ml.timeOfDay(phase, true);
      for (let i = 0; i < 260; i++) await step();
      const d = window.__mlAmbient.debug("smoke");
      let a = 0;
      for (let i = 0; i < 120; i++) {
        for (const m of window.__mlAmbient.debug("smoke").all) a = Math.max(a, m.a);
        await step();
      }
      /* THE UNFORCED WEIGHT, not `gain`. This gate runs in MANUAL mode, where
       * the toggles FORCE an enabled field on regardless of its env gate — so
       * `gain` is 1 at midnight and says nothing about the day rule. */
      return { w: d.weight, gain: +d.gain.toFixed(3), maxA: +a.toFixed(3), sun: +d.sun.toFixed(2) };
    };
    const day = await sample("Day");
    const night = await sample("Night");
    window.__ml.timeOfDay("Day", true);
    for (let i = 0; i < 120; i++) await step();
    return { day, night };
  }, fire.at);
  console.log(
    `day/night: unforced weight ${byHour.day.w} at sun ${byHour.day.sun}, ${byHour.night.w} at sun ${byHour.night.sun}; ` +
      `peak alpha ${byHour.day.maxA} vs ${byHour.night.maxA} (both forced by the demo toggle)`,
  );
  if (!(byHour.day.sun > byHour.night.sun + 0.3)) fail(`the sun barely moved (${byHour.day.sun} vs ${byHour.night.sun}) — the day rule was not exercised`);
  if (!(byHour.day.w > byHour.night.w * 1.2))
    fail(`smoke weighs ${byHour.day.w} by day against ${byHour.night.w} at night — it is the DAYLIGHT half of a fire`);
  if (!(byHour.night.w > 0.15)) fail(`smoke fell to ${byHour.night.w} at night — a fire burns all night too`);
  if (!(byHour.day.maxA > 0)) fail("nothing came off the fire at noon, which is the whole point of the effect");
}

/* ---- AND IT IS ON THE SCREEN ----
 * THE BOX IS THE AIR ABOVE THE FLAME, anchored on the FIRE — which, unlike a
 * drop or a spark, does not move, so a box placed from its reported position
 * is still over the smoke when the screenshot lands. The flame's own frames
 * and its flicker are the loudest thing in this picture, so the box starts
 * clear of the piece; smoke rises, so that is where it is anyway. The envelope
 * is a per-pixel max AND min over several OFF frames (the fire is animated:
 * one off frame is one phase of a moving picture), and the control is a
 * further OFF frame through the same judge. */
if (fire) {
  const shoot = async () => PNG.sync.read(await page.screenshot({ type: "png" }));
  const lum = (im, x, y) => {
    if (x < 0 || y < 0 || x >= im.width || y >= im.height) return 0;
    const i = (y * im.width + x) * 4;
    return 0.299 * im.data[i] + 0.587 * im.data[i + 1] + 0.114 * im.data[i + 2];
  };
  const setOn = (on) => page.evaluate(async (o) => {
    window.__mlAmbient.setEnabled("smoke", o);
    for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  }, on);

  /* DRIVE THE CAMERA UNTIL THERE IS SKY ABOVE THE FIRE. A camera centred on
   * the fire's own cell still leaves the flame near the top once the piece's
   * height is added, and the box of air then collapses to nothing (the embers
   * paid for this). Step the camera up-screen a cell at a time, which walks
   * the fire DOWN the frame. */
  const frame = await page.evaluate(async (at) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    window.__ml.teleport(at[0] + 0.5, at[1] + 0.5);
    for (let i = 0; i < 160; i++) await step();
    for (let k = 0; k <= 7; k++) {
      window.__ml.lookAt(at[0] - k, at[1] - k);
      for (let i = 0; i < 50; i++) await step();
      const v = window.__ml.camView();
      const z = window.__ml.myScreen()?.zoom ?? 1;
      const f = (window.__mlAmbient.debug("smoke").fireList || [])[0];
      if (f && (f.y - v.y) * z >= 120) break;
    }
    for (let i = 0; i < 90; i++) await step();
    const v = window.__ml.camView();
    const z = window.__ml.myScreen()?.zoom ?? 1;
    const f = (window.__mlAmbient.debug("smoke").fireList || [])[0];
    const me = window.__ml.myScreen();
    return f ? { sx: Math.round((f.x - v.x) * z), sy: Math.round((f.y - v.y) * z), me } : null;
  }, fire.at);
  if (!frame) fail("no fire on screen to judge the smoke against");
  else {
    /* THE WINDOW IS THE WISP, NOT A BOX OF AIR. A box big enough to hold the
     * column also holds the fire's own glow on the geometry around it, and a
     * hearth's art is animated: measured, the largest departure inside a
     * 68x66 box above the flame was 167.5 luma with the effect ON and 167.5
     * with it OFF — the same pixel, the fire, both times. So the arm asks the
     * feature where its marks are and judges a few pixels around each.
     *
     * THAT IS ONLY SAFE BECAUSE SMOKE IS SLOW. A falling drop covers 24 px
     * between the read and the screenshot and the window lands on bare rock
     * (the drips paid for that); a wisp climbs about 30 px a SECOND, so it has
     * moved a pixel or two by the time the shot lands and a window a few
     * pixels wider than the mark still contains it.
     *
     * AND ONLY MARKS WELL CLEAR OF THE FLAME COUNT — 22 px up, past the art
     * and its glow, which is where smoke is anyway. */
    /* THE CLEAR AREA IS MEASURED, NOT GUESSED — the drips' lesson, ported.
     * A hand-picked box is wrong for the next feature that comes along (the
     * butterflies' canvas starts below the clock; a cave drip hangs above it),
     * so ask the page: the canvas is the game area and the HUD is DOM painted
     * over it, with rectangles the elements themselves will report. And never
     * over the player, whose idle and torch move more than a wisp does. */
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
        if (b.width * b.height > cv.width * cv.height * 0.9) continue; // a wrapper, not an overlay
        over.push({ x0: b.left, x1: b.right, y0: b.top, y1: b.bottom });
      }
      return { cv: { x0: cv.left, x1: cv.right, y0: cv.top, y1: cv.bottom }, over };
    });
    const skip = frame.me
      ? { x0: frame.me.sx - 26, x1: frame.me.sx + 26, y0: frame.me.sy - 62, y1: frame.me.sy + 16 }
      : null;
    const clear = (x, y) =>
      x >= layout.cv.x0 && x <= layout.cv.x1 && y >= layout.cv.y0 && y <= layout.cv.y1 &&
      (!skip || x < skip.x0 || x > skip.x1 || y < skip.y0 || y > skip.y1) &&
      !layout.over.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
    console.log(`pixels: the game area is ${Math.round(layout.cv.x1 - layout.cv.x0)}x${Math.round(layout.cv.y1 - layout.cv.y0)}px with ${layout.over.length} HUD rects over it`);
    const HALF = 6;
    const CLEAR_OF_FLAME = 22;
    await setOn(false);
    const offs = [];
    for (let i = 0; i < 8; i++) { offs.push(await shoot()); await page.waitForTimeout(150); }
    const noiseShot = await shoot();
    await setOn(true);
    await page.waitForTimeout(600);
    const contrastAt = (png, p) => {
      let m = -Infinity;
      for (let y = p.y - HALF; y <= p.y + HALF; y++)
        for (let x = p.x - HALF; x <= p.x + HALF; x++) {
          if (!clear(x, y)) continue;
          let hi = 0, lo = 255;
          for (const o of offs) { const l = lum(o, x, y); hi = Math.max(hi, l); lo = Math.min(lo, l); }
          const l = lum(png, x, y);
          // CONTRAST EITHER WAY: smoke is darker than sky and paler than rock.
          m = Math.max(m, l - hi, lo - l);
        }
      return m === -Infinity ? 0 : m;
    };
    let best = 0, noise = 0, shots = 0, marks = 0;
    for (let i = 0; i < 14 && shots < 6; i++) {
      const raw = await page.evaluate((clearOf) => {
        const v = window.__ml.camView();
        const z = window.__ml.myScreen()?.zoom ?? 1;
        return window.__mlAmbient.debug("smoke").all
          .filter((m) => m.a > 0.1 && m.fy - m.y >= clearOf)
          .map((m) => ({ x: Math.round((m.x - v.x) * z), y: Math.round((m.y - v.y) * z) }));
      }, CLEAR_OF_FLAME);
      // the WHOLE window has to be judgeable, or it silently scores 0 inside
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
      `pixels: ${shots} shots over ${marks} wisp windows — the smoke shifts its own window by ${best.toFixed(1)} luma, ` +
        `against ${noise.toFixed(1)} for the same windows with the effect off`,
    );
    if (shots < 3) fail(`only ${shots} frames put a wisp clear of the flame on screen`);
    // the control IS the quiet precondition, measured in the windows that matter
    if (noise > 12)
      fail(`the wisps' own windows moved ${noise.toFixed(1)} luma with the effect OFF — the envelope is measuring the fire, not the smoke`);
    if (best < 6) fail(`a wisp changes its own pixels by ${best.toFixed(1)} luma — too faint to see`);
    if (best < noise * 1.8 + 2)
      fail(`the smoke moves ${best.toFixed(1)} luma where the scene alone moves ${noise.toFixed(1)} — that is not smoke`);
  }
}

/* ---- COST, AND THE LIGHT LIST STAYS THROTTLED ---- */
const cost = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  window.__mlAmbient.cost(true);
  const p0 = window.__mlAmbient.debug("smoke").probes;
  const t0 = performance.now();
  for (let i = 0; i < 360; i++) await step();
  const c = window.__mlAmbient.cost(true).smoke;
  const perSecond = ((window.__mlAmbient.debug("smoke").probes - p0) * 1000) / (performance.now() - t0);
  return { c, perSecond: +perSecond.toFixed(2) };
});
console.log(`cost: ${cost.c.ms} ms/frame (peak ${cost.c.peak}) over ${cost.c.frames} frames; light reads ${cost.perSecond}/s`);
if (!(cost.c.frames > 100)) fail(`only ${cost.c.frames} frames measured — the cost check proved nothing`);
if (cost.c.ms > COST_MS) fail(`smoke cost ${cost.c.ms} ms/frame (ceiling ${COST_MS})`);
if (cost.perSecond > PROBES_PER_S) fail(`the light list is read ${cost.perSecond}/s — it walks every source and must stay throttled`);

/* Put the camera and the player back: the game persists where you logged out,
 * and a gate that ends somewhere odd hands the next one a bad starting point. */
await page.evaluate(async () => {
  window.__ml.lookAt();
  window.__ml.teleport(333.5, 237.5);
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
});

await browser.close();
console.log(failed ? "verify-firesmoke: FAILED" : "verify-firesmoke: OK");
if (failed) process.exitCode = 1;
