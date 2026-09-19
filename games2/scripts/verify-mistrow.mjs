// verify-mistrow — DOES FLIPPING A GLOOM-ONLY WEATHER ROW HAZE THE SCREEN?
//
// The maintainer's mist (2026-09-19, "the best looking effect this game has")
// could not be seen by any means he has: no zone assigned it (ambientreach.test
// guards that) and the Settings row for it was a switch wired to nothing — its
// setForced wrote a set only the precipitation features read, while the gloom
// read the server's set alone. This gate stands where he stands: manual mode,
// everything off, flip `mist`, and watch __ml.weatherInfo().mist — the scalar
// the night shader consumes — go to 1 while the server's set never names it;
// then release it and watch it fall back, the world's own sky untouched.
// `cloudy` gets the same treatment. Then a pixel look, so the number is not
// the whole story.
//
//   node scripts/verify-mistrow.mjs      (needs the dev stack on :5173)
import { chromium } from "playwright-core";
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
const OUT = process.env.OUT || join(tmpdir(), "verify-mistrow");
mkdirSync(OUT, { recursive: true });
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };
const say = (m) => console.log(m);

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
// THE WORLD SELECT COMES FIRST: `__ml` does not exist until a world is picked
// and committed (the same three steps every gate in this folder takes).
await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate((w) => {
  const i = window.__mlSelect.worlds().findIndex((n) => n === w);
  if (i >= 0) window.__mlSelect.pickWorld(i);
  window.__mlSelect.commit();
}, WORLD);
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list && typeof window.__ml.weatherInfo === "function", null, { timeout: 30_000 });
// IN THE WORLD, NOT ON THE LOADER: `players() >= 1` is true while the title
// card still covers the canvas (the first run's "off" shot was the LOADING
// screen and the pixel arm passed comparing a logo against the world). The
// HUD's tabs exist only in-game; the clock is then frozen at Day so the two
// shots below differ by the haze and nothing else.
await page.waitForFunction(() => document.querySelector(".ml-tab") && window.__ml.myScreen?.() !== null, null, { timeout: 60_000 });
/* HOLD THE PHASE. A local timeOfDay is overridden by the server's next world
 * time broadcast (the chimney gate measured it, 2026-09-13), so the first
 * run's "before" shot was full Day and its "after" shot the world's evening —
 * 18.5 luma apart with the haze down both times. Re-applied until the
 * reported sun agrees, and read again at every shot below. */
const holdDay = async () =>
  page.evaluate(async () => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    const sun = () => { const s = window.__ml.sunInfo(); return { phase: s.phase, sun: +((s.sun[0] + s.sun[1] + s.sun[2]) / 3).toFixed(3) }; };
    for (let tries = 0; tries < 8; tries++) {
      window.__ml.timeSpeed(0);
      window.__ml.timeOfDay("Day", true);
      for (let i = 0; i < 60; i++) await step();
      const a = sun();
      for (let i = 0; i < 60; i++) await step();
      const b = sun();
      if (a.phase === "Day" && b.phase === "Day" && Math.abs(a.sun - b.sun) < 0.01) return b;
    }
    return { ...sun(), stuck: true };
  });
const held = await holdDay();
say(`phase: ${JSON.stringify(held)}`);
if (held.stuck) fail(`could not hold the clock at Day (${JSON.stringify(held)})`);
const fog = await page.evaluate(() => window.__ml.depthFog());
say(`fog switch: on=${fog?.fogOn} (mist through it: ${fog?.mist})`);
if (!fog?.fogOn) fail("the fog switch is OFF — it also kills the mist pass, so nothing below could draw");
await page.waitForTimeout(1500);

/* THE FIELD THE SHADER DRAWS: nightlight.ts's MIST_FRAG has an exact JS twin,
 * __ml.mistAt(wx, wy) — the fog's cover at a world point, 0 with the haze
 * down. Sampled on a grid around the player, so the pixel look below is not
 * the only witness. */
const FIELD_JS = `() => {
  const me = window.__ml.myScreen(); if (!me) return null;
  const v = window.__ml.camView(); const z = me.zoom ?? 1;
  const cv = document.querySelector("canvas").getBoundingClientRect();
  const pts = []; let max = 0, n = 0, at = null;
  for (let i = 0; i < 12; i++) for (let j = 0; j < 8; j++) {
    const wx = v.x + v.w * (0.06 + 0.08 * i), wy = v.y + v.h * (0.12 + 0.1 * j);
    const m = window.__ml.mistAt(wx, wy); n++; pts.push(+m.toFixed(2));
    if (m > max) { max = m; at = { sx: Math.round(cv.left + (wx - v.x) * z), sy: Math.round(cv.top + (wy - v.y) * z), wx: Math.round(wx), wy: Math.round(wy) }; }
  }
  const s = window.__ml.sunInfo();
  return { max: +max.toFixed(3), n, pts, at, sun: { phase: s.phase, sun: +((s.sun[0] + s.sun[1] + s.sun[2]) / 3).toFixed(3) } };
}`;
const field = async () => page.evaluate(`(${FIELD_JS})()`);

/* ---- the rows exist ---- */
const rows = await page.evaluate(() => window.__mlAmbient.list().filter((n) => n === "mist" || n === "cloudy"));
say(`rows: ${rows.join(", ") || "none"}`);
if (rows.length !== 2) fail(`expected the mist and cloudy rows in the ambient list, got [${rows}]`);

/* ---- a clear sky, manual mode, everything off ---- */
const cleared = await page.evaluate(() => {
  let worldAmbient = "n/a";
  try { worldAmbient = typeof window.__ml.worldAmbient === "function" ? String(window.__ml.worldAmbient([])) : "absent"; } catch (e) { worldAmbient = `threw ${e.message}`; }
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, false);
  return { worldAmbient, mode: window.__mlAmbient.mode?.() ?? "?" };
});
say(`clear: ${JSON.stringify(cleared)}`);
await page.waitForTimeout(2500);
const before = await page.evaluate(() => window.__ml.weatherInfo());
say(`before: mist ${before.mist.toFixed(3)} cloud ${before.cloud.toFixed(3)}, server set [${before.active.join(",")}]`);
if (before.active.includes("mist")) fail("the server's set already names mist — the force cannot be told from a roll");
if (before.mist > 0.05) fail(`mist reads ${before.mist} before anything is forced`);
const fieldOff = await field();
say(`field off: max ${fieldOff?.max} over ${fieldOff?.n} points`);
if (!fieldOff) fail("mistAt could not be sampled (no player on screen)");
else if (fieldOff.max > 0.001) fail(`the mist field reads ${fieldOff.max} with the haze down`);
await page.screenshot({ path: `${OUT}/mist-off.png` });

/* ---- flip the row ---- */
const sel = await page.evaluate(() => {
  const r = window.__mlAmbient.setEnabled("mist", true);
  const e = window.__mlAmbient.effects().find((f) => f.name === "mist");
  return { r, enabled: !!e?.enabled, blockedBy: e?.blockedBy ?? null, gain: window.__mlAmbient.debug("mist")?.gain };
});
say(`flip: ${JSON.stringify(sel)}`);
if (!sel.r?.ok || !sel.enabled) fail(`the mist row could not be switched on (${JSON.stringify(sel.r)}, blocked by ${sel.blockedBy})`);
if (sel.gain !== 1) fail(`the row does not report its force (gain ${sel.gain})`);

/* ---- the scalar the shader consumes rises to 1: tau 4 s, snap at 0.005 -> ~21 s ---- */
const rise = await page.evaluate(async () => {
  const t0 = performance.now(); const trace = [];
  while (performance.now() - t0 < 30_000) {
    const w = window.__ml.weatherInfo();
    trace.push(+w.mist.toFixed(2));
    if (w.mist >= 1) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const w = window.__ml.weatherInfo();
  return { mist: w.mist, active: w.active, secs: +((performance.now() - t0) / 1000).toFixed(1), trace: trace.filter((_, i) => i % 8 === 0) };
});
say(`rise: mist ${rise.mist} after ${rise.secs}s (${rise.trace.join(" > ")}), server set [${rise.active.join(",")}]`);
if (rise.mist < 1) fail(`the forced row left mist at ${rise.mist} after ${rise.secs}s — the switch is still wired to nothing`);
if (rise.active.includes("mist")) fail("the server rolled mist during the run — the rise proves nothing");
const fieldOn = await field();
say(`field on: max ${fieldOn?.max} over ${fieldOn?.n} points, densest at screen ${fieldOn?.at?.sx},${fieldOn?.at?.sy} (world ${fieldOn?.at?.wx},${fieldOn?.at?.wy}); sun ${JSON.stringify(fieldOn?.sun)}`);
if (!fieldOn || fieldOn.max <= 0.001) fail(`the haze scalar is 1 but the mist FIELD reads ${fieldOn?.max} — the shader would draw nothing`);
await page.screenshot({ path: `${OUT}/mist-on.png` });

/* ---- release: back to clear, and nothing else disturbed ---- */
const fall = await page.evaluate(async () => {
  window.__mlAmbient.setEnabled("mist", false);
  const t0 = performance.now();
  while (performance.now() - t0 < 30_000 && window.__ml.weatherInfo().mist > 0) await new Promise((r) => setTimeout(r, 500));
  const w = window.__ml.weatherInfo();
  return { mist: w.mist, cloud: w.cloud, dim: w.precipDim, secs: +((performance.now() - t0) / 1000).toFixed(1) };
});
say(`release: ${JSON.stringify(fall)}`);
if (fall.mist > 0) fail(`releasing the row left mist at ${fall.mist}`);
const fieldAfter = await field();
if (fieldAfter && fieldAfter.max > 0.001) fail(`the mist field still reads ${fieldAfter.max} after release`);
say(`after: sun ${JSON.stringify(fieldAfter?.sun)}`);
if (fieldOn?.sun && fieldAfter?.sun && (fieldOn.sun.phase !== fieldAfter.sun.phase || Math.abs(fieldOn.sun.sun - fieldAfter.sun.sun) > 0.02))
  fail(`the sun moved between the ON and AFTER shots (${JSON.stringify(fieldOn.sun)} -> ${JSON.stringify(fieldAfter.sun)}) — the pair would measure the clock, not the haze`);
await page.screenshot({ path: `${OUT}/mist-after.png` });

/* ---- cloudy, the other orphan ---- */
const cl = await page.evaluate(async () => {
  const r = window.__mlAmbient.setEnabled("cloudy", true);
  const t0 = performance.now();
  while (performance.now() - t0 < 30_000 && window.__ml.weatherInfo().cloud < 1) await new Promise((r2) => setTimeout(r2, 500));
  const w = window.__ml.weatherInfo();
  window.__mlAmbient.setEnabled("cloudy", false);
  return { ok: r?.ok, cloud: w.cloud, secs: +((performance.now() - t0) / 1000).toFixed(1) };
});
say(`cloudy: ${JSON.stringify(cl)}`);
if (cl.cloud < 1) fail(`forcing cloudy left cloud at ${cl.cloud}`);

/* ---- a pixel look: the centre of the game area, haze on vs off ---- */
/* WHERE THE FOG IS, NOT A FIXED RECTANGLE. The first honest run measured the
 * centre of the viewport — mostly HUD cards, under which the pass does not
 * draw — and read 0.1 luma of change while the eye saw a bank over the left
 * third. The window sits on the densest field point of the ON shot, and the
 * same window is read in the AFTER shot of the same scene under the same sun. */
const luma = (file, x0, y0, x1, y1) => {
  const p = PNG.sync.read(readFileSync(file));
  let s = 0, n = 0;
  for (let y = Math.max(0, y0); y < Math.min(p.height, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(p.width, x1); x++) {
      const i = (y * p.width + x) * 4;
      s += 0.299 * p.data[i] + 0.587 * p.data[i + 1] + 0.114 * p.data[i + 2]; n++;
    }
  return n ? s / n : 0;
};
const W = 20;
const at = fieldOn?.at ?? { sx: 240, sy: 130 };
const win = (f) => luma(f, at.sx - W, at.sy - W, at.sx + W, at.sy + W);
const onW = win(`${OUT}/mist-on.png`), afterW = win(`${OUT}/mist-after.png`);
const centre = (f) => luma(f, 120, 80, 360, 240);
say(`pixels: at the densest bank (${at.sx},${at.sy}, ${W * 2}px window) luma ${afterW.toFixed(1)} clear -> ${onW.toFixed(1)} with the haze up (${(onW - afterW >= 0 ? "+" : "")}${(onW - afterW).toFixed(1)}); whole centre ${centre(`${OUT}/mist-after.png`).toFixed(1)} -> ${centre(`${OUT}/mist-on.png`).toFixed(1)}; shots in ${OUT}`);
if (Math.abs(onW - afterW) < 3) fail(`the picture at the densest bank changed by only ${Math.abs(onW - afterW).toFixed(1)} luma with the field at ${fieldOn?.max} — the scalar moved and the pass did not draw`);

await browser.close();
say(failed ? "verify-mistrow: FAILED" : "verify-mistrow: OK");
process.exit(failed ? 1 : 0);
