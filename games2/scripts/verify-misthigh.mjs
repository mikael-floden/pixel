// verify-misthigh — MIST IS AS THICK ON HIGH GROUND AS ON LOW.
//
// Maintainer 2026-09-23, standing at 305.7,140.5 LEVEL 2 inside a 90%-mist
// marsh: "According to the map the mist should be here, but I can't see it..."
// (and 2026-09-21, five cells away: "flicker in and out of existence").
//
// WHY verify-mistzone COULD NOT SEE THIS. That gate picks its stands on LOW
// ground on purpose — "a mist zone on a summit shows nothing" — so the one
// band where the effect collapsed was the one band never measured. Two reports
// survived a green gate. This is the arm that was missing: stand in the
// HIGHEST mist zone the world has and require the same fog the lowest one gets.
//
// MIST_FRAG hugs the ground with pool = 1 - (z - floor - 0.4) * 0.5. That floor
// was 0 — sea level — so a mountain tarn at level 32 and a lake at median 12
// painted NOTHING, and his marsh at median 2 painted one twentieth. It is now
// the zone's own floor (ambient/runtime/zonefloor.ts), carried in the mask
// texture's G channel.
//
//   node scripts/verify-misthigh.mjs      (needs the dev stack on :5173)
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
const OUT = process.env.OUT || join(tmpdir(), "verify-misthigh");
const VIEW = { width: +(process.env.VIEW_W || 1280), height: +(process.env.VIEW_H || 720) };
mkdirSync(OUT, { recursive: true });
/** The top posterize band MIST_FRAG can paint: floor(1*5)/5*0.74. */
const TOP_BAND = 0.74;
/** Band 4 of 5 — "the full range is available here", not just the faintest. */
const DEEP_BAND = 0.59;
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };
const say = (m) => console.log(m);

const docPath = join("..", "maps2", "worlds3", WORLD, "ambient.json");
const worldPath = join("..", "maps2", "worlds3", WORLD, "world.json");
if (!existsSync(docPath) || !existsSync(worldPath)) { console.log("no world tree — nothing to verify"); process.exit(0); }
const doc = JSON.parse(readFileSync(docPath, "utf8"));
const world = JSON.parse(readFileSync(worldPath, "utf8"));
const G = world.grounds, g = world.ground, N = g.length, L = world.level;
const WATER = new Set(["water", "deep_water", "lava"]);
const land = (c, r) => c >= 0 && r >= 0 && c < N && r < N && !WATER.has(G[g[r][c]]);
const lvl = (c, r) => L?.[r]?.[c] ?? 0;
const inside = (area, x, y) => { let inn = false; for (let i = 0, j = area.length - 1; i < area.length; j = i++) { const [xi, yi] = area[i], [xj, yj] = area[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn; } return inn; };

/* THE TWO STANDS: the highest mist zone in the world and the lowest, each on
 * land, deep enough inside that the mask is whole (5x5 all in the polygon) and
 * on the zone's own median level — the ground the floor is measured from. */
function standIn(z) {
  const xs = z.area.map((p) => p[0]), ys = z.area.map((p) => p[1]);
  const x0 = Math.max(0, Math.min(...xs)), x1 = Math.min(N, Math.max(...xs));
  const y0 = Math.max(0, Math.min(...ys)), y1 = Math.min(N, Math.max(...ys));
  const held = [];
  for (let r = y0; r < y1; r++) for (let c = x0; c < x1; c++) if (inside(z.area, c + 0.5, r + 0.5)) held.push([c, r]);
  if (!held.length) return null;
  const levels = held.map(([c, r]) => lvl(c, r)).sort((a, b) => a - b);
  const median = levels[levels.length >> 1];
  const deep = (c, r) => { for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) if (!inside(z.area, c + dc + 0.5, r + dr + 0.5)) return false; return true; };
  // prefer a cell at the median level with a whole mask around it
  const cands = held.filter(([c, r]) => land(c, r) && lvl(c, r) === median && deep(c, r));
  const pick = cands[Math.floor(cands.length / 2)] ?? held.filter(([c, r]) => land(c, r) && lvl(c, r) === median)[0];
  return pick ? { id: z.id, name: z.name, col: pick[0], row: pick[1], median, cells: held.length } : null;
}

const serious = doc.zones.filter((z) => z.kind !== "world" && z.kind !== "cave" && (z.effects.mist ?? 0) >= 50);
const stands = serious.map(standIn).filter(Boolean).sort((a, b) => a.median - b.median);
if (stands.length < 2) { fail(`need a low and a high mist zone; found ${stands.length}`); process.exit(1); }
say(`${WORLD}: ${stands.length} mist stands — ${stands.map((s) => `${s.name}@lvl${s.median}`).join(", ")}`);
if (!(stands[stands.length - 1].median >= 2)) { say(`the highest mist zone is level ${stands[stands.length - 1].median} — nothing raised to test`); process.exit(0); }

/* EVERY SERIOUS MIST ZONE IS MEASURED, not just the extremes. The bars below
 * are absolute and set from what the BUG produced, because the zones are not
 * comparable to each other: a heath is flat and a tarn sits in a bowl of rock
 * whose rises the fog is SUPPOSED to thin on, so "as thick as the heath" would
 * fail this fix for working correctly. Measured before the fix, on each zone's
 * own floor ground: max 0.148 (band 1, the faintest, and nothing above it) at
 * the marsh and 0.000 at the tarn, the lake and the meadow. */
const MIN_MAX = DEEP_BAND;   // the deep bands must be reachable  (bug: 0.148)
/* BAND 2 IS THE LINE THE BUG COULD NOT CROSS. Above roughly level 1.2 the old
 * pool clamped the density under one fifth, so band 1 (0.148) was its ceiling
 * at EVERY raised stand and 0 at most of them. A bar of band 2 is therefore
 * "strictly more than the bug could ever paint", which is the honest
 * discriminator for the zone-driven arm. */
const BAND_2 = 0.296;
/* mean and paintedFrac DRIFT and are only a net against a dead effect: the
 * banks are smoothstep(0.30, 0.60, noise) over a field that moves, so the
 * share of a view carrying one swings run to run (measured on the same stand
 * across runs: the meadow read 0.54/0.83 and then 0.21/0.39). The arms that
 * do the work are the floor, the top band and the frames. */
const MIN_MEAN = 0.12;       // a fog at all                      (bug: 0.0068 at the tarn)
const MIN_PAINTED = 0.3;     // not a bare screen                 (bug: 0.046 at the tarn)

/* AND A PIXEL ARM, BECAUSE THE TWIN IS NOT THE SHADER. mistDrawAt is an exact
 * JS twin of MIST_FRAG, which makes it a perfect instrument for everything
 * except the one question "did the GLSL change". Proven here the hard way: a
 * mutant that pinned the shader's floor back to sea level passed every arm
 * above, because the arms read the twin and the twin still had the floor. So
 * the frames are compared too — a clear envelope, then the mist up — and that
 * arm fails on the mutant as it should. */
const MIN_LUMA_RISE = 8;     // mean centre luma the fog must lift the ground by

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: VIEW });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate((w) => { const i = window.__mlSelect.worlds().findIndex((n) => n === w); if (i >= 0) window.__mlSelect.pickWorld(i); window.__mlSelect.commit(); }, WORLD);
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.zone && window.__ml.myScreen?.() !== null, null, { timeout: 60_000 });
await page.evaluate(() => { window.__ml.timeSpeed(0); window.__ml.timeOfDay("Day", true); });

/* AN IN-PAGE LOOP RUNS ON rAF WITH A WALL-CLOCK DEADLINE, never on a
 * setTimeout count — Chromium clamps timers hard in a headless page. */
const settle = () => page.evaluate(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  await w(1500);
  for (let i = 0; i < 160; i++) { const r = window.__ml.relocate?.(); if (!r || (!r.veil && !r.active)) break; await w(250); }
});
const holdDay = () => page.evaluate(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let t = 0; t < 6; t++) { window.__ml.timeSpeed(0); window.__ml.timeOfDay("Day", true); await w(1200); }
});
const mistScalar = () => page.evaluate(() => window.__ml.depthFog().mist);

/* THE 4-SECOND ROLL IS NOT 4 SECONDS IN HERE. easeGloom is driven by
 * game.loop.delta — the CLAMPED physics dt, which the comment above its call
 * site already warns "would crawl on slow clients", which is why time-of-day
 * was moved to the wall clock. A software-GL headless page runs ~1.4 fps, so
 * measured here the roll accumulated 0.5 s of delta in 21 s of wall clock and
 * the mist was still at 0.88 when the gate gave up. Waiting is therefore not
 * an option: __ml.weather(idx, true) SNAPS the gloom to its current target
 * (snapGloom), and with the zone field in force that target is the field's own
 * value — so this asks for the answer the roll is heading to, instantly. */
const snapGloom = (idx) => page.evaluate((i) => window.__ml.weather(i, true), idx);

await settle();
await holdDay();

/* THE WORLD CAN BE PINNED, AND THEN THERE ARE NO ZONES AT ALL. A forced sky
 * (an earlier gate's __ml.worldAmbient, this one's own baseline) is persisted
 * by the server in the shared clock document, so it outlives the page: every
 * later run reads ruled:false, coverage {any:true, mean:1, n:0}, and measures
 * a world with no zones in it while reporting success. Cleared here, and the
 * run refuses to go on unruled. Local stacks only. */
const unpin = async () => {
  if (!/localhost|127\.0\.0\.1/.test(URL)) return page.evaluate(() => window.__mlAmbient.zone().ruled);
  for (let i = 0; i < 12; i++) {
    if (await page.evaluate(() => window.__mlAmbient.zone().ruled)) return true;
    await page.evaluate(() => window.__ml.worldAmbient());
    await page.waitForTimeout(1500);
  }
  return page.evaluate(() => window.__mlAmbient.zone().ruled);
};
if (!(await unpin())) {
  fail("the zone field is not ruled: the world's sky is pinned or the world has no ambient.json");
  await browser.close();
  process.exit(1);
}

/* THE ROOM'S SKY IS THE ONLY DETERMINISTIC "OFF". A row switched off in
 * Settings does not clear the mist: the gloom reads the ZONE FIELD, and the
 * field still says the zone it is standing in has mist. Forcing the room's set
 * empty makes the field unruled, which is the one way to a clear baseline.
 * It persists on the server, so it is released again at the end. */
const skyClear = () => page.evaluate(() => window.__ml.worldAmbient([]));
const skyRelease = () => page.evaluate(() => window.__ml.worldAmbient());

const lumaOf = (png) => {
  const n = png.width * png.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] = 0.2126 * png.data[i * 4] + 0.7152 * png.data[i * 4 + 1] + 0.0722 * png.data[i * 4 + 2];
  return out;
};
const frame = async () => lumaOf(PNG.sync.read(await page.screenshot({ type: "png" })));
/* THE CENTRE ONLY: the HUD is DOM over the canvas and never changes with the
 * weather, so including it dilutes every statistic with a constant. */
const centre = (w, h) => { const x0 = Math.round(w * 0.2), x1 = Math.round(w * 0.8), y0 = Math.round(h * 0.15), y1 = Math.round(h * 0.6); return { x0, x1, y0, y1, w }; };
const box = centre(VIEW.width, VIEW.height);
const inBox = (i) => { const x = i % box.w, y = (i / box.w) | 0; return x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1; };

/* THE PIXEL STATISTIC IS THE CENTRE'S MEAN LUMA, not a per-pixel envelope.
 * Fog lifts the whole ground toward pale grey, so the mean moves by many luma
 * and is robust to what a per-pixel envelope cannot survive here: the ground
 * is a render texture that repaints in slices, and a dozen other ambient
 * effects are moving in frame. A first cut required most pixels to beat the
 * envelope's own MAX noise and read 0.000 everywhere — including a heath
 * painting mean alpha 0.73, which is as visible as this effect ever gets.
 * (verify-mistrow reads the same way: "whole centre 142.5 -> 153.9".) */
async function centreLuma(n = 3) {
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const f = await frame();
    let s2 = 0, c = 0;
    for (let i = 0; i < f.length; i++) if (inBox(i)) { s2 += f[i]; c++; }
    sum += s2 / c;
    if (k < n - 1) await page.waitForTimeout(350);
  }
  return +(sum / n).toFixed(2);
}

const survey = () => page.evaluate(() => {
  const v = window.__ml.camView();
  const pts = [];
  for (let j = 0; j < 20; j++) for (let i = 0; i < 32; i++) {
    const x = v.x + v.w * ((i + 0.5) / 32), y = v.y + v.h * ((j + 0.5) / 20);
    const at = window.__ml.pickAt(x, y);
    if (!at) continue;
    pts.push({ a: window.__ml.mistDrawAt(x, y), c: Math.floor(at.x / 32), r: Math.floor(at.y / 32) });
  }
  if (!pts.length) return null;
  const a = pts.map((p) => p.a);
  const painted = a.filter((v2) => v2 > 0.001);
  return {
    n: pts.length,
    max: +Math.max(...a).toFixed(3),
    mean: +(a.reduce((s, v2) => s + v2, 0) / a.length).toFixed(4),
    paintedFrac: +(painted.length / a.length).toFixed(3),
    raw: pts,
    mask: window.__mlAmbient.mistMask(),
  };
});

const brief = (o) => o && { n: o.n, max: o.max, mean: o.mean, paintedFrac: o.paintedFrac, refMax: o.mask?.refMax, forced: o.mask?.forced };

/** The median terrain level the view is actually standing on, read from the
 *  world file — me() is the wire schema and carries no drawn position. */
const viewLevel = (s2) => {
  if (!s2?.raw?.length) return null;
  const ls = s2.raw.map((p) => lvl(p.c, p.r)).sort((a, b) => a - b);
  return ls[ls.length >> 1];
};

/* THE FAIR COMPARISON IS THE ZONE'S OWN FLOOR GROUND, not the whole view. A
 * tarn sits in a BOWL: the rock around it really is higher, and fog thinning
 * on those rises is the effect working, not failing — comparing a mountain
 * view against a heath view whole would fail the fix for being correct.
 * Restricted to the ground the zone is actually on, the two are comparable. */
const onFloor = (s2, level) => {
  if (!s2?.raw?.length) return null;
  const a = s2.raw.filter((p) => Math.abs(lvl(p.c, p.r) - level) <= 1).map((p) => p.a);
  if (a.length < 20) return null;
  return {
    n: a.length,
    mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(4),
    max: +Math.max(...a).toFixed(3),
    paintedFrac: +(a.filter((v) => v > 0.001).length / a.length).toFixed(3),
  };
};

/** Screen luma per pixel, from a PNG-free readback: the page's own canvas. */

/** Force the room's sky empty (the only deterministic "off") or hand it back,
 *  and WAIT for the field to agree. A sky force is persisted by the server, so
 *  a release that silently fails leaves every later stand measuring a world
 *  with no zones in it — which is how a run degraded stand by stand until the
 *  tarn was reading the unfixed behaviour and calling it a regression. */
async function setRuled(want) {
  await (want ? skyRelease() : skyClear());
  for (let i = 0; i < 24; i++) {
    if ((await page.evaluate(() => window.__mlAmbient.zone().ruled)) === want) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function measure(stand, label) {
  say(`\n--- ${label}: ${stand.name} at ${stand.col},${stand.row}, level ${stand.median} ---`);
  await page.evaluate(([c, r]) => window.__ml.teleport(c, r), [stand.col, stand.row]);
  await settle();
  await holdDay();
  await page.waitForTimeout(1500);

  // CLEAR FIRST — the camera must not move between the two readings.
  if (!(await setRuled(false))) { fail(`${label}: the sky would not clear`); return null; }
  await snapGloom(0);
  await page.waitForTimeout(1200);
  const offScalar = await mistScalar();
  const clear = await survey();
  const clearLuma = await centreLuma();
  await page.screenshot({ path: join(OUT, `misthigh-${label}-clear.png`) });

  // back to the zones, then the row forced on: a forced row covers the whole
  // view and floors on the ground I am standing on.
  if (!(await setRuled(true))) { fail(`${label}: the zone field would not come back`); return null; }
  await page.evaluate(() => window.__mlAmbient.setEnabled("mist", true));
  await snapGloom(2);
  await page.waitForTimeout(1500);
  const on = await mistScalar();
  if (on < 0.99) fail(`${label}: a forced mist row only reached ${on.toFixed(3)}`);
  const up = await survey();
  const mistLuma = await centreLuma();
  await page.screenshot({ path: join(OUT, `misthigh-${label}-mist.png`) });

  /* THE ZONE'S OWN ANSWER, when its ten-minute window has mist on: the only
   * path that exercises the floor RASTER (a forced row floors on me instead),
   * and the path he walks into. A 90% zone is off one window in ten, so it is
   * measured when present and skipped, loudly, when not. */
  await page.evaluate(() => window.__mlAmbient.setEnabled("mist", false));
  const here = await page.evaluate(([c, r]) => window.__mlAmbient.zoneCell("mist", c, r, 0), [stand.col, stand.row]);
  let zoned = null;
  if (here?.on) {
    await snapGloom(2);
    await page.waitForTimeout(1200);
    zoned = await survey();
  }

  const seen = viewLevel(up);
  const rise = +(mistLuma - clearLuma).toFixed(2);
  say(`  clear: ${JSON.stringify(brief(clear))} scalar ${offScalar.toFixed(4)} luma ${clearLuma}`);
  say(`  mist : ${JSON.stringify(brief(up))} luma ${mistLuma} (rise ${rise})  view median level ${seen}`);
  say(`  zoned: ${zoned ? JSON.stringify(brief(zoned)) : "SKIPPED — this window has mist off here"}`);
  if (offScalar > 0.01) fail(`${label}: the clear control still reads ${offScalar.toFixed(3)}`);
  if (clear && clear.max > 0.001) fail(`${label}: the clear control already paints ${clear.max}`);
  if (seen === null || Math.abs(seen - stand.median) > 2)
    fail(`${label}: the view stands on level ${seen}, the zone's median is ${stand.median} — measured somewhere else`);
  return { up, zoned, seen, rise };
}

const results = [];
for (const st of stands) results.push({ st, r: await measure(st, st.id) });

say("");
for (const { st, r } of results) {
  if (!r) { fail(`${st.id}: not measured`); continue; }
  const f = onFloor(r.up, r.seen);
  if (!f) { fail(`${st.id}: not enough ground at its own level (${r.seen}) to judge`); continue; }
  const refLvl = r.up.mask?.refMax ?? 0;
  say(`${st.name} (lvl ${st.median}, view ${r.seen}): floor ${refLvl}, on-floor ${JSON.stringify(f)}`);
  // 1. THE FLOOR REACHED THE PASS — without it the pool measures from sea
  //    level and every zone above it is thinned away.
  if (!(refLvl >= r.seen - 1)) fail(`${st.id}: the floor did not reach the pass (refMax ${refLvl}, standing on ${r.seen})`);
  // 2. THE DEEP BANDS PAINT. The bug reached band 1 and stopped.
  if (!(f.max >= MIN_MAX)) fail(`${st.id}: tops out at ${f.max} — the deep bands never paint (bar ${MIN_MAX})`);
  // 3. A REAL FOG on the ground the zone is on.
  if (!(f.mean >= MIN_MEAN)) fail(`${st.id}: mean painted alpha ${f.mean} (bar ${MIN_MEAN})`);
  // 4. A BANK, NOT A STIPPLE.
  if (!(f.paintedFrac >= MIN_PAINTED)) fail(`${st.id}: only ${f.paintedFrac} of its own floor paints (bar ${MIN_PAINTED})`);
  // 4b. THE PIXELS, not the twin — the arm the sea-level mutant fails.
  if (!(r.rise >= MIN_LUMA_RISE))
    fail(`${st.id}: the screen only moved ${r.rise} luma when the fog came up (bar ${MIN_LUMA_RISE})`);
  // 5. THE ZONE'S OWN FLOOR RASTER, when its window let it be measured: the
  //    floor read is the ZONE's ground, and the raster is the only path his
  //    walk uses (the forced row above floors on the player instead).
  if (r.zoned) {
    const zf = r.zoned.mask?.refMax ?? 0;
    if (!(Math.abs(zf - st.median) <= 1)) fail(`${st.id}: the zone's floor raster reads ${zf}, its median ground is ${st.median}`);
    if (!(r.zoned.max >= BAND_2)) fail(`${st.id}: zone-driven mist tops out at ${r.zoned.max} — band 1 or under is what the bug painted (bar ${BAND_2})`);
  }
}

say(`\npictures: ${OUT}`);
await browser.close();
console.log(failed ? "verify-misthigh: FAILED" : "verify-misthigh: OK");
process.exit(failed ? 1 : 0);
