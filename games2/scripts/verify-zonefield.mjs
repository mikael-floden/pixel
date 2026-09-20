// verify-zonefield — THE ZONE FIELD ANSWERS THE SERVER'S ZONES, SPATIALLY, and
// the Settings/dev "ambient zones" overlay draws them in the world.
//
// Stands OUTSIDE a zone with the zone on screen: the field must say the zone's
// effect is on over there (coverage.any) and not here (weight ~0 at my feet),
// and walking a line across the edge must read as a RAMP. Then the overlay is
// switched on and the picture taken — the one the maintainer judges every
// later effect against.
//
//   node scripts/verify-zonefield.mjs      (needs the dev stack on :5173)
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
const OUT = process.env.OUT || join(tmpdir(), "verify-zonefield");
const VIEW = { width: +(process.env.VIEW_W || 960), height: +(process.env.VIEW_H || 600) };
mkdirSync(OUT, { recursive: true });
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };
const say = (m) => console.log(m);

/* ---- the world doc, read here so the arms are derived, never hand-placed ---- */
const docPath = join("..", "maps2", "worlds3", WORLD, "ambient.json");
const worldPath = join("..", "maps2", "worlds3", WORLD, "world.json");
if (!existsSync(docPath)) { console.log("no ambient.json for this world — nothing to verify"); process.exit(0); }
const doc = JSON.parse(readFileSync(docPath, "utf8"));
const world = JSON.parse(readFileSync(worldPath, "utf8"));
const G = world.grounds, g = world.ground, N = g.length, L = world.level;
const WATER = new Set(["water", "deep_water", "lava"]);
const land = (c, r) => c >= 0 && r >= 0 && c < N && r < N && !WATER.has(G[g[r][c]]);
/* FLAT GROUND ACROSS THE EDGE, or the picture is a cliff: the first run's
 * stand was a summit at level 20 with the zone off the bottom of the screen.
 * The rise across the walked cells, in levels; sorted on before size. */
const rise = (c0, c1, r) => { let lo = Infinity, hi = -Infinity; for (let c = c0; c <= c1; c++) { const v = L?.[r]?.[c] ?? 0; lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };
/* candidate boundary spots: THE POLYGON'S OWN EDGE AT A ROW, not its bounding
 * box (a sea's box reaches far from its shore at most rows — the first cut
 * stood 4 cells outside the box and had no zone on screen). Even-odd, the
 * same test the resolver uses; three rows per zone; land 3 cells out and 2
 * in, and no OTHER zone carrying the same effects over the stand cell, or a
 * neighbour's leaves read as this zone's. Largest first. */
const inside = (area, x, y) => {
  let inn = false;
  for (let i = 0, j = area.length - 1; i < area.length; j = i++) {
    const [xi, yi] = area[i], [xj, yj] = area[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn;
  }
  return inn;
};
const spots = [];
for (const z of doc.zones) {
  if (z.kind === "world" || z.kind === "cave") continue;
  const xs = z.area.map((p) => p[0]), ys = z.area.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  for (const f of [0.5, 0.35, 0.65]) {
    const r = Math.floor(y0 + (y1 - y0) * f);
    let edge = -1;
    for (let c = x0; c <= x1; c++) if (inside(z.area, c + 0.5, r + 0.5)) { edge = c; break; }
    if (edge < 0) continue;
    const standCol = edge - 3;
    if (!(land(standCol, r) && land(edge - 1, r) && land(edge, r) && land(edge + 1, r) && land(edge + 2, r))) continue;
    const others = doc.zones.filter((o) => o !== z && o.kind !== "world" && inside(o.area, standCol + 0.5, r + 0.5));
    const shared = others.some((o) => Object.keys(o.effects).some((e) => e in z.effects));
    if (shared) continue;
    spots.push({ id: z.id, name: z.name, kind: z.kind, edgeCol: edge, standCol, row: r, area: (x1 - x0) * (y1 - y0), rise: rise(standCol - 2, edge + 4, r), effects: Object.keys(z.effects) });
    break;
  }
}
spots.sort((a, b) => a.rise - b.rise || b.area - a.area);
say(`spots: ${spots.slice(0, 6).map((s) => `${s.kind}/${s.name}@${s.standCol},${s.row} rise ${s.rise}`).join(" | ")}`);
say(`${WORLD}: ${doc.zones.length} ambient zones, ${spots.length} with a land edge to stand at`);
if (!spots.length) fail("no zone has a land edge to stand at — the arms cannot run");

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: VIEW });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate((w) => {
  const i = window.__mlSelect.worlds().findIndex((n) => n === w);
  if (i >= 0) window.__mlSelect.pickWorld(i);
  window.__mlSelect.commit();
}, WORLD);
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.zone && document.querySelector(".ml-tab") && window.__ml.myScreen?.() !== null, null, { timeout: 60_000 });
await page.evaluate(() => { window.__ml.timeSpeed(0); window.__ml.timeOfDay("Day", true); });
await page.waitForTimeout(2500);

/* ---- the seam and the field ---- */
const st = await page.evaluate(() => {
  const s = window.__ml.ambientZoneState();
  const z = window.__mlAmbient.zone();
  return { doc: !!s?.doc, zones: s?.doc?.zones?.length ?? 0, packedLen: (s?.packed ?? "").length, roomSky: s?.roomSky, field: z,
    project: typeof window.__ml.projectCell === "function" };
});
say(`seam: doc ${st.doc} (${st.zones} zones), table ${st.packedLen} chars, roomSky ${st.roomSky}, projectCell ${st.project}; field ${JSON.stringify(st.field)}`);
if (!st.doc || !st.project) fail("the seam is missing (ambientZoneState / projectCell)");
if (!st.field?.ruled) fail(`the field is not ruled by the zones (${JSON.stringify(st.field)}) — every weight would read 1 and no boundary exists`);

/* ---- stand outside a zone with the zone on screen ---- */
/* A SPOT GETS 25 s. A teleport across a zone-room border is a hand-off and a
 * fresh join; one that never settles must skip the spot, not hold the gate. */
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((r) => setTimeout(() => r({ skip: `${what}: ${ms} ms passed` }), ms))]);
let picked = null;
for (const s of spots.slice(0, 12)) {
  const r = await withTimeout(page.evaluate(async (s) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    /* TIME, NOT FRAMES: headless Chromium runs this page at 2-5 fps (measured
     * 2026-09-20, both viewports), so "80 frames" is half a minute and a
     * frame-counted wait blows any timeout. The teleport settles in ~3 s. */
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__ml.teleport(s.standCol + 0.5, s.row + 0.5);
    await wait(3000);
    // a hand-off rebuilds the scene: wait for a player on screen again
    for (let i = 0; i < 40 && !(window.__ml?.myScreen?.() && window.__ml.players?.() >= 1); i++) await wait(250);
    if (!window.__ml?.myScreen?.()) return { skip: "no player on screen after the teleport" };
    /* AND FOR THE VEIL TO LIFT. A teleport across a zone-room border is a
     * relocation with the loading card over the canvas; the probes answer
     * from under it, and a picture taken then is the title screen (the
     * fourth run's was). `__ml.relocate()` says when it is down. */
    for (let i = 0; i < 160; i++) { const r = window.__ml.relocate?.(); if (!r || (!r.veil && !r.active)) break; await wait(250); }
    const rl = window.__ml.relocate?.();
    if (rl && (rl.veil || rl.active)) return { skip: `the relocation veil never lifted (${JSON.stringify(rl.active)})` };
    if (window.__ml.indoor?.().indoor) return { skip: "indoors" };
    // which of this zone's effects is ON here now?
    const packed = window.__ml.ambientZoneState().packed;
    const set = (packed.split(";").find((p) => p.startsWith(s.id + "=")) ?? "=").split("=")[1];
    const on = set ? set.split(",").filter(Boolean) : [];
    if (!on.length) return { skip: "the zone's window has nothing on" };
    const name = on[0];
    const me = window.__ml.myScreen();
    const v = window.__ml.camView();
    const here = window.__mlAmbient.zone(name, v.x + me.sx / me.zoom, v.y + me.sy / me.zoom);
    const cov = window.__mlAmbient.zone(name);
    return { name, on, here, cov, view: v, me: { sx: me.sx, sy: me.sy, zoom: me.zoom } };
  }, s), 25_000, "stand");
  say(`stand: ${s.kind} "${s.name}" col ${s.standCol} row ${s.row} (edge ${s.edgeCol}) -> ${JSON.stringify(r)}`);
  if (r.skip) continue;
  if (r.here <= 0.05 && r.cov?.any) { picked = { ...s, ...r }; break; }
  say(`   not usable: weight at my feet ${r.here}, coverage ${JSON.stringify(r.cov)}`);
}
if (!picked) fail("could not stand outside any zone with the zone on screen and its effect on");
else {
  say(`outside "${picked.name}": ${picked.name ? picked.name : ""} effect "${picked.name}" weighs ${picked.here} at my feet, coverage of the view ${JSON.stringify(picked.cov)}`);
  /* THE RAMP, IN CELL SPACE — the field's own geometry along my row, from 3
   * cells outside to 3 inside: monotone, middle values, 0 to 1. Asserted on
   * the blurred cells because that is what the bilinear read interpolates;
   * a walk in PIXELS is reported beside it, not asserted: on a terraced edge
   * the picker maps one pixel of that straight line to the terrace it is
   * drawn on, which is the right answer for a particle at that pixel and a
   * wrong one for a monotonicity test. */
  const ramp = await page.evaluate((p) => {
    const cells = [], px = [];
    const lvl0 = window.__ml.levelAt((p.standCol + 0.5) * 32, (p.row + 0.5) * 32);
    for (let c = p.edgeCol - 3; c <= p.edgeCol + 3; c++) cells.push({ c, b: +window.__mlAmbient.zoneCell(p.name, c, p.row, lvl0).blurred.toFixed(3) });
    for (let c = p.edgeCol - 3; c <= p.edgeCol + 3; c += 0.5) {
      const lvl = window.__ml.levelAt(c * 32, (p.row + 0.5) * 32);
      const q = window.__ml.projectCell(c, p.row + 0.5, lvl);
      px.push({ c, w: +window.__mlAmbient.zone(p.name, q.x, q.y).toFixed(3) });
    }
    return { cells, px, lvl0 };
  }, picked);
  const bs = ramp.cells.map((r) => r.b);
  say(`ramp (cells, level ${ramp.lvl0}) across col ${picked.edgeCol}: ${ramp.cells.map((r) => `${r.c}:${r.b}`).join(" ")}`);
  say(`ramp (pixels, reported): ${ramp.px.map((r) => `${r.c}:${r.w}`).join(" ")}`);
  let mono = true; for (let i = 1; i < bs.length; i++) if (bs[i] < bs[i - 1] - 1e-6) mono = false;
  if (!mono) fail("the blurred field is not monotone across the edge");
  if (!(bs[0] < 0.05)) fail(`3 cells outside still reads ${bs[0]}`);
  if (!(bs[bs.length - 1] > 0.9)) fail(`3 cells inside reads only ${bs[bs.length - 1]}`);
  if (!bs.some((b) => b > 0.2 && b < 0.8)) fail("no middle value: the edge is a step, not a ramp");

  /* ---- the overlay, and the picture ---- */
  const ov = await page.evaluate(async () => {
    const was = window.__mlAmbient.zoneLines();
    window.__mlAmbient.zoneLines(true);
    await new Promise((r) => setTimeout(r, 1500)); // a few frames at 2-5 fps
    const on = window.__mlAmbient.zoneLines();
    // the dev switch reads the same state
    return { was, on, labels: document.querySelectorAll("canvas").length };
  });
  say(`overlay: was ${ov.was}, on ${ov.on}`);
  if (!ov.on) fail("the overlay could not be switched on");
  await page.waitForTimeout(1500);
  const veil = await page.evaluate(() => { const r = window.__ml.relocate?.(); return r ? { veil: r.veil, active: !!r.active } : null; });
  say(`veil before the picture: ${JSON.stringify(veil)}`);
  if (veil && (veil.veil || veil.active)) fail("the loading veil is still over the canvas — the picture would be the title card");
  const shot = `${OUT}/zonefield-${picked.kind}-${picked.id}.png`;
  await page.screenshot({ path: shot });
  say(`picture: ${shot}`);
  const cost = await page.evaluate(async () => {
    window.__mlAmbient.cost(true);
    await new Promise((r) => setTimeout(r, 2000));
    const z = window.__mlAmbient.zone();
    return { field: z, frame: performance.now() };
  });
  say(`field after the walk: ${JSON.stringify(cost.field)}`);
  await page.evaluate(() => window.__mlAmbient.zoneLines(false));
}

await browser.close();
say(failed ? "verify-zonefield: FAILED" : "verify-zonefield: OK");
process.exit(failed ? 1 : 0);
