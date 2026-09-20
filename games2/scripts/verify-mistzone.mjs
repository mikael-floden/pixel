// verify-mistzone — THE MIST RESPECTS THE ZONE BOUNDARY (unit 2 of the boundaries).
//
// Maintainer 2026-09-20: "The mist already exist in that zone and I walk into
// it. The mist also looks good at the boundary (no hard cuts)."
//
// Stands OUTSIDE a zone whose live window has mist on, on low ground (the
// banks pool on level <= ~2 ground and nowhere else — nightlight's MIST_FRAG),
// with the zone on screen: the mist scalar must be UP while my cell is outside
// (the banks exist over there), the mask's twin must read 0 at my feet and
// ramp to 1 inside, and the mist's own twin (__ml.mistAt, mask included) must
// be 0 over ground outside the zone and > 0 somewhere inside. Then 6 cells
// inside looking out: the same, from the other side. Two pictures, overlay on.
//
//   node scripts/verify-mistzone.mjs      (needs the dev stack on :5173)
import { chromium } from "playwright-core";
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function chromePath() {
  const root = "/opt/pw-browsers";
  const c = existsSync(root)
    ? readdirSync(root).filter((d) => /^chromium(-\d+)?$/.test(d)).map((d) => join(root, d, "chrome-linux", "chrome"))
    : [];
  return [...c, join(root, "chromium")].find((p) => existsSync(p));
}
const URL = process.env.GAME_URL || "http://localhost:5173/";
const WORLD = process.env.WORLD || "the_game";
const OUT = process.env.OUT || join(tmpdir(), "verify-mistzone");
const VIEW = { width: +(process.env.VIEW_W || 1280), height: +(process.env.VIEW_H || 720) };
mkdirSync(OUT, { recursive: true });
/** The faintest band MIST_FRAG can paint (floor(d*5)/5*0.74 at one fifth). */
const BAND = 0.148;
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };
const say = (m) => console.log(m);

const docPath = join("..", "maps2", "worlds3", WORLD, "ambient.json");
const worldPath = join("..", "maps2", "worlds3", WORLD, "world.json");
if (!existsSync(docPath)) { console.log("no ambient.json for this world — nothing to verify"); process.exit(0); }
const doc = JSON.parse(readFileSync(docPath, "utf8"));
const world = JSON.parse(readFileSync(worldPath, "utf8"));
const G = world.grounds, g = world.ground, N = g.length, L = world.level;
const WATER = new Set(["water", "deep_water", "lava"]);
const land = (c, r) => c >= 0 && r >= 0 && c < N && r < N && !WATER.has(G[g[r][c]]);
const lvl = (c, r) => L?.[r]?.[c] ?? 0;
const inside = (area, x, y) => { let inn = false; for (let i = 0, j = area.length - 1; i < area.length; j = i++) { const [xi, yi] = area[i], [xj, yj] = area[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn; } return inn; };

/* CANDIDATE STANDS: every edge of every mist zone (west, east, north, south),
 * 4 cells outside on flat land, where the ground just inside is LOW (the
 * banks pool on level <= ~2 ground; a mist zone on a summit shows nothing),
 * and no other zone over the stand carries mist above a trickle. */
const DIRS = [
  { name: "west", dc: -1, dr: 0 }, { name: "east", dc: 1, dr: 0 },
  { name: "north", dc: 0, dr: -1 }, { name: "south", dc: 0, dr: 1 },
];
const spots = [];
for (const z of doc.zones) {
  if (z.kind === "world" || z.kind === "cave" || !(z.effects.mist >= 50)) continue;
  const xs = z.area.map((p) => p[0]), ys = z.area.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  for (const d of DIRS) {
    for (const f of [0.5, 0.35, 0.65]) {
      // the line to scan along, and the first cell of the zone met coming from outside
      const fixed = d.dr === 0 ? Math.floor(y0 + (y1 - y0) * f) : Math.floor(x0 + (x1 - x0) * f);
      let edge = null;
      const from = d.dc < 0 || d.dr < 0 ? (d.dr === 0 ? x0 : y0) : (d.dr === 0 ? x1 : y1);
      const to = d.dc < 0 || d.dr < 0 ? (d.dr === 0 ? x1 : y1) : (d.dr === 0 ? x0 : y0);
      const step = from <= to ? 1 : -1;
      for (let k = from; step > 0 ? k <= to : k >= to; k += step) {
        const c = d.dr === 0 ? k : fixed, r = d.dr === 0 ? fixed : k;
        if (inside(z.area, c + 0.5, r + 0.5)) { edge = { c, r }; break; }
      }
      if (!edge) continue;
      /* `d` POINTS OUT of the zone (west = -x at a west edge), so at(n) with
       * n > 0 walks OUTSIDE and n < 0 walks in — the first run had this
       * inverted and every "stand" read field 1, standing inside. */
      const at = (n) => ({ c: edge.c + d.dc * n, r: edge.r + d.dr * n });
      const stand = at(4);
      const line = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map(at);
      if (!line.every((p) => land(p.c, p.r))) continue;
      const levels = line.map((p) => lvl(p.c, p.r));
      const rise = Math.max(...levels) - Math.min(...levels);
      const innerLevel = [0, -1, -2, -3, -4, -5].map((n) => lvl(at(n).c, at(n).r)).reduce((a, b) => a + b, 0) / 6;
      if (innerLevel > 1.5) continue;
      const others = doc.zones.filter((o) => o !== z && o.kind !== "world" && inside(o.area, stand.c + 0.5, stand.r + 0.5));
      if (others.some((o) => (o.effects.mist ?? 0) >= 5)) continue;
      /* THE INSIDE STAND is not "6 cells in": a zone's other edge can be right
       * there (6 cells in from the green's south edge sits on its east edge,
       * field 0.67). Walk in until the 5x5 around the cell is all inside — the
       * field is then exactly 1 and the mask whole. */
      let innerStand = null;
      for (let n = 3; n <= 14; n++) {
        const q = at(-n);
        if (!land(q.c, q.r) || lvl(q.c, q.r) > 2) continue;
        let all = true;
        for (let dr = -2; dr <= 2 && all; dr++) for (let dc = -2; dc <= 2; dc++) if (!inside(z.area, q.c + dc + 0.5, q.r + dr + 0.5)) { all = false; break; }
        if (all) { innerStand = q; break; }
      }
      if (!innerStand) continue;
      spots.push({ id: z.id, name: z.name, kind: z.kind, dir: d.name, dc: d.dc, dr: d.dr, edge, stand, innerStand, rise, innerLevel, area: (x1 - x0) * (y1 - y0), poly: z.area });
      break;
    }
  }
}
spots.sort((a, b) => a.rise - b.rise || a.innerLevel - b.innerLevel || b.area - a.area);
say(`${WORLD}: ${spots.length} mist stands; first: ${spots.slice(0, 5).map((s) => `${s.name} ${s.dir}@${s.stand.c},${s.stand.r} rise ${s.rise} inner ${s.innerLevel.toFixed(1)}`).join(" | ")}`);
if (spots.length === 0) { fail("no mist zone with a flat, low, land edge to stand at"); process.exit(1); }

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: VIEW });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate((w) => { const i = window.__mlSelect.worlds().findIndex((n) => n === w); if (i >= 0) window.__mlSelect.pickWorld(i); window.__mlSelect.commit(); }, WORLD);
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.zone && document.querySelector(".ml-tab") && window.__ml.myScreen?.() !== null, null, { timeout: 60_000 });
await page.evaluate(() => { window.__ml.timeSpeed(0); window.__ml.timeOfDay("Day", true); });
await page.waitForTimeout(2500);

/* THE WORLD CAN BE PINNED, AND THEN THERE ARE NO ZONES AT ALL. `__ml.worldAmbient(set)`
 * forces the room's sky on the SERVER and the server persists it in the shared
 * clock document (WorldRoom.saveClock) — it outlives the page, so one earlier
 * gate that forced a weather leaves every later zone gate reading `ruled:false`
 * (coverage {any:true, mean:1, n:0}) and standing "outside" a zone that is not
 * there. Clear it here (an empty `ambient` message re-rolls, which drops the
 * force where zones rule) and refuse to run unruled. Local stacks only — never
 * clear a pin the maintainer set on a live server. */
const unpin = async () => {
  if (!/localhost|127\.0\.0\.1/.test(URL)) return page.evaluate(() => window.__mlAmbient.zone().ruled);
  for (let i = 0; i < 12; i++) {
    const ruled = await page.evaluate(() => window.__mlAmbient.zone().ruled);
    if (ruled) return true;
    await page.evaluate(() => window.__ml.worldAmbient());
    await page.waitForTimeout(1500);
  }
  return page.evaluate(() => window.__mlAmbient.zone().ruled);
};
if (!(await unpin())) {
  fail("the zone field is not ruled: the world's sky is pinned (an earlier gate's __ml.worldAmbient) or it has no ambient.json");
  await browser.close();
  process.exit(1);
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((r) => setTimeout(() => r({ skip: `${what}: ${ms} ms passed` }), ms))]);
const settle = `async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(3000);
  for (let i = 0; i < 40 && !(window.__ml?.myScreen?.() && window.__ml.players?.() >= 1); i++) await wait(250);
  for (let i = 0; i < 160; i++) { const r = window.__ml.relocate?.(); if (!r || (!r.veil && !r.active)) break; await wait(250); }
  const rl = window.__ml.relocate?.();
  return !!window.__ml?.myScreen?.() && !(rl && (rl.veil || rl.active));
}`;
const holdDay = `async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sun = () => { const s = window.__ml.sunInfo(); return { phase: s.phase, sun: +((s.sun[0] + s.sun[1] + s.sun[2]) / 3).toFixed(3) }; };
  for (let tries = 0; tries < 8; tries++) {
    window.__ml.timeSpeed(0);
    window.__ml.timeOfDay("Day", true);
    await wait(1500);
    const a = sun();
    await wait(1500);
    const b = sun();
    if (a.phase === "Day" && b.phase === "Day" && Math.abs(a.sun - b.sun) < 0.01) return b;
  }
  return { ...sun(), stuck: true };
}`;
/* the mist scalar eases over 4 s of Phaser delta; wait for 0.9 (45 s at most) */
const rise = `async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 22; i++) { if (window.__ml.depthFog().mist >= 0.9) break; await wait(2000); }
  return window.__ml.depthFog();
}`;
/* READ THE FIELD AND THE MIST OVER THE VIEW: a grid of points, each judged
 * by the cell under it (in the polygon, within its feather, or outside) */
const survey = `(poly) => {
  const inside = (area, x, y) => { let inn = false; for (let i = 0, j = area.length - 1; i < area.length; j = i++) { const [xi, yi] = area[i], [xj, yj] = area[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn; } return inn; };
  const near = (c, r, reach) => { for (let dr = -reach; dr <= reach; dr++) for (let dc = -reach; dc <= reach; dc++) if (inside(poly, c + dc + 0.5, r + dr + 0.5)) return true; return false; };
  const deep = (c, r) => { for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) if (!inside(poly, c + dc + 0.5, r + dr + 0.5)) return false; return true; };
  const v = window.__ml.camView(); // {x, y, w, h} — NOT width/height
  /* THE BAND THE SHADER WOULD DRAW: MIST_FRAG posterizes the density into
   * five layers (floor(d*5)/5*0.74) AFTER the mask, so anything under 0.2
   * paints not one pixel. That is the honest test of "it is not misting
   * here" — the mask's LINEAR read spreads about one texel (~1 cell) past
   * the field, and this says whether that skirt can ever be seen. */
  const band = (d) => Math.floor(d * 5 + 0.001) / 5 * 0.74;
  const out = { outside: { n: 0, mistMax: 0, maskMax: 0, drawMax: 0 }, skirt: { n: 0, mistMax: 0, drawMax: 0 }, deep: { n: 0, mistMax: 0, maskMin: 1, maskMean: 0, mistMean: 0 }, ramp: { n: 0, mid: 0 }, unpicked: 0 };
  for (let j = 0; j < 14; j++) for (let i = 0; i < 24; i++) {
    const x = v.x + v.w * ((i + 0.5) / 24), y = v.y + v.h * ((j + 0.5) / 14);
    const at = window.__ml.pickAt(x, y);
    if (!at) { out.unpicked++; continue; }
    const c = Math.floor(at.x / 32), r = Math.floor(at.y / 32);
    const mist = window.__ml.mistAt(x, y), mask = window.__ml.mistMaskAt(x, y), field = window.__mlAmbient.zone("mist", x, y);
    if (!near(c, r, 4)) { out.outside.n++; out.outside.mistMax = Math.max(out.outside.mistMax, mist); out.outside.maskMax = Math.max(out.outside.maskMax, mask); out.outside.drawMax = Math.max(out.outside.drawMax, band(mist)); }
    else if (!near(c, r, 2)) { out.skirt.n++; out.skirt.mistMax = Math.max(out.skirt.mistMax, mist); out.skirt.drawMax = Math.max(out.skirt.drawMax, band(mist)); }
    else if (deep(c, r)) { out.deep.n++; out.deep.mistMax = Math.max(out.deep.mistMax, mist); out.deep.maskMin = Math.min(out.deep.maskMin, mask); out.deep.maskMean += mask; out.deep.mistMean += mist; }
    else { out.ramp.n++; if (field > 0.1 && field < 0.9) out.ramp.mid++; }
  }
  if (out.deep.n) { out.deep.maskMean /= out.deep.n; out.deep.mistMean /= out.deep.n; }
  for (const k of ["outside", "skirt", "deep"]) for (const kk of Object.keys(out[k])) if (typeof out[k][kk] === "number") out[k][kk] = +out[k][kk].toFixed(3);
  return out;
}`;

let picked = null;
for (const s of spots.slice(0, 8)) {
  const r = await withTimeout(page.evaluate(async ({ s, settle, holdDay }) => {
    const packed = window.__ml.ambientZoneState().packed;
    const set = (packed.split(";").find((p) => p.startsWith(s.id + "=")) ?? "=").split("=")[1];
    const on = set ? set.split(",").filter(Boolean) : [];
    if (!on.includes("mist")) return { skip: `window has no mist on (${on.join(",") || "nothing"})` };
    window.__ml.teleport(s.stand.c + 0.5, s.stand.r + 0.5);
    if (!(await (0, eval)(settle)())) return { skip: "did not settle" };
    if (window.__ml.indoor?.().indoor) return { skip: "indoors" };
    const day = await (0, eval)(holdDay)();
    if (day.stuck) return { skip: "could not hold the clock at Day" };
    const me = window.__ml.myScreen(); const v = window.__ml.camView();
    const fx = v.x + me.sx / me.zoom, fy = v.y + me.sy / me.zoom;
    const at = window.__ml.pickAt(fx, fy);
    const cell = at ? { col: Math.floor(at.x / 32), row: Math.floor(at.y / 32), lvl: at.lvl } : null;
    if (!cell || Math.abs(cell.col - s.stand.c) > 1 || Math.abs(cell.row - s.stand.r) > 1) return { skip: `landed at ${JSON.stringify(cell)}, not the stand` };
    const here = window.__mlAmbient.zone("mist", fx, fy);
    const cov = window.__mlAmbient.zone("mist");
    const fog = window.__ml.depthFog();
    return { on, here, cov, cell, fogOn: fog.fogOn, mask: window.__mlAmbient.mistMask() };
  }, { s, settle, holdDay }), 90_000, "stand");
  say(`stand: ${s.kind} "${s.name}" ${s.dir} edge, col ${s.stand.c} row ${s.stand.r} (edge ${s.edge.c},${s.edge.r}) -> ${JSON.stringify(r)}`);
  if (r.skip) continue;
  if (!r.fogOn) { fail("the fog switch is off — the mist cannot show"); break; }
  if (r.here <= 0.05 && r.cov?.any && r.cov.mean >= 0.15) { picked = { ...s, ...r }; break; }
}
if (!picked) fail("could not stand outside a low mist zone with mist on and the zone on screen");
else {
  say(`outside "${picked.name}" with mist on there: field ${picked.here} at my feet, coverage ${JSON.stringify(picked.cov)}, mask ${JSON.stringify(picked.mask)}`);
  await page.evaluate(() => window.__mlAmbient.zoneLines(true));
  const out = await withTimeout(page.evaluate(async ({ p, rise, survey }) => {
    const fog = await (0, eval)(rise)();
    const me = window.__ml.myScreen(); const v = window.__ml.camView();
    const fx = v.x + me.sx / me.zoom, fy = v.y + me.sy / me.zoom;
    return { fog, atMe: { mist: +window.__ml.mistAt(fx, fy).toFixed(3), mask: +window.__ml.mistMaskAt(fx, fy).toFixed(3) }, ...(0, eval)(survey)(p.poly) };
  }, { p: picked, rise, survey }), 120_000, "outside");
  say(`outside: ${JSON.stringify(out)}`);
  if (out.skip) fail(`outside: ${out.skip}`);
  else {
    if (!(out.fog.mist >= 0.9)) fail(`the mist scalar is ${out.fog.mist} with the mist's zone in view — the banks are not up over there`);
    if (out.atMe.mask > 0.05 || out.atMe.mist > 0.01) fail(`mist at my feet outside the zone: mask ${out.atMe.mask}, mist ${out.atMe.mist}`);
    if (out.outside.n < 20) fail(`only ${out.outside.n} points outside sampled`);
    if (out.outside.mistMax > 0.02 || out.outside.maskMax > 0.05) fail(`mist over ground outside the zone: max ${out.outside.mistMax}, mask max ${out.outside.maskMax}`);
    /* THE FEATHER IS THE POINT — "the mist also looks good at the boundary
     * (no hard cuts)": it may fade for the 3 cells of the field's ramp plus
     * the mask's texel, at no more than the FAINTEST of the five bands, and
     * must be gone beyond that. */
    if (out.outside.drawMax > 0) fail(`a band is DRAWN past the feather (${out.outside.drawMax})`);
    if (out.skirt.drawMax > BAND) fail(`the fade past the line is ${out.skirt.drawMax}, more than the faintest band (${BAND})`);
    if (out.deep.n < 10) fail(`only ${out.deep.n} points deep inside sampled — the zone is not on screen enough`);
    if (out.deep.maskMin < 0.95) fail(`the mask is not whole deep inside the zone (min ${out.deep.maskMin})`);
    if (!(out.deep.mistMax > 0.15)) fail(`no bank inside the zone (mist max ${out.deep.mistMax}) — 'the mist already exists in that zone' is not there`);
    if (out.ramp.mid === 0) fail("no middle values across the line — a step, not a ramp");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/mistzone-outside-${picked.id}.png` });
    say(`picture: ${OUT}/mistzone-outside-${picked.id}.png`);
  }

  /* ---- inside, looking out ---- */
  const inn = await withTimeout(page.evaluate(async ({ p, settle, holdDay, rise, survey }) => {
    window.__ml.teleport(p.innerStand.c + 0.5, p.innerStand.r + 0.5);
    if (!(await (0, eval)(settle)())) return { skip: "did not settle" };
    const day = await (0, eval)(holdDay)();
    if (day.stuck) return { skip: "could not hold the clock at Day" };
    const fog = await (0, eval)(rise)();
    const me = window.__ml.myScreen(); const v = window.__ml.camView();
    const fx = v.x + me.sx / me.zoom, fy = v.y + me.sy / me.zoom;
    return { fog, here: window.__mlAmbient.zone("mist", fx, fy), atMe: { mask: +window.__ml.mistMaskAt(fx, fy).toFixed(3) }, ...(0, eval)(survey)(p.poly) };
  }, { p: picked, settle, holdDay, rise, survey }), 150_000, "inside");
  say(`inside: ${JSON.stringify(inn)}`);
  if (inn.skip) fail(`inside: ${inn.skip}`);
  else {
    if (!(inn.here > 0.9 && inn.atMe.mask > 0.9)) fail(`deep inside the field at my feet is ${inn.here}, the mask ${inn.atMe.mask}`);
    if (!(inn.fog.mist >= 0.9)) fail(`the mist scalar is ${inn.fog.mist} inside the zone`);
    if (inn.outside.n && (inn.outside.mistMax > 0.02 || inn.outside.maskMax > 0.05)) fail(`looking out, mist over ground outside: max ${inn.outside.mistMax}, mask max ${inn.outside.maskMax}`);
    if (inn.outside.drawMax > 0) fail(`looking out, a band is DRAWN past the feather (${inn.outside.drawMax})`);
    if (inn.skirt.drawMax > BAND) fail(`looking out, the fade past the line is ${inn.skirt.drawMax}, more than the faintest band (${BAND})`);
    if (!(inn.deep.mistMean > 4 * (inn.skirt.mistMax || 0.001) || inn.deep.mistMean > 0.4)) fail(`the banks inside (${inn.deep.mistMean}) are not clearly thicker than the fade outside (${inn.skirt.mistMax})`);
    if (!(inn.deep.mistMax > 0.15)) fail(`no bank around me inside (mist max ${inn.deep.mistMax})`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/mistzone-inside-${picked.id}.png` });
    say(`picture: ${OUT}/mistzone-inside-${picked.id}.png`);
  }
  await page.evaluate(() => window.__mlAmbient.zoneLines(false));
}
await browser.close();
say(failed ? "verify-mistzone: FAILED" : "verify-mistzone: OK");
process.exit(failed ? 1 : 0);
