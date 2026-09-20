// verify-weatherzone — THE WEATHER SHEET RESPECTS THE ZONE BOUNDARY.
//
// Maintainer 2026-09-20: "It should not suddenly start to snow. I should walk
// into an area/zone that is already snowing ... it should already look like
// it's raining on the other side and look as if it's not raining if you are
// inside and looking out."
//
// Stands OUTSIDE a zone whose live window has a precipitation on, with the
// zone on screen: the row must be running (its zone is in view), every drop
// drawn must carry a weight above zero, and every drop DRAWN must be over the
// zone's ground (the cell under it, within the feather) — none over my head.
// Then steps 6 cells INSIDE and looks back: the sheet covers the view, and
// none of it is drawn past the line. Two pictures, one from each side, with
// the overlay on.
//
//   node scripts/verify-weatherzone.mjs      (needs the dev stack on :5173)
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
const OUT = process.env.OUT || join(tmpdir(), "verify-weatherzone");
const VIEW = { width: +(process.env.VIEW_W || 1280), height: +(process.env.VIEW_H || 720) };
mkdirSync(OUT, { recursive: true });
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };
const say = (m) => console.log(m);
const PRECIP = ["drizzle", "rain", "heavyrain", "storm", "snow", "windy"];

const docPath = join("..", "maps2", "worlds3", WORLD, "ambient.json");
const worldPath = join("..", "maps2", "worlds3", WORLD, "world.json");
if (!existsSync(docPath)) { console.log("no ambient.json for this world — nothing to verify"); process.exit(0); }
const doc = JSON.parse(readFileSync(docPath, "utf8"));
const world = JSON.parse(readFileSync(worldPath, "utf8"));
const G = world.grounds, g = world.ground, N = g.length, L = world.level;
const WATER = new Set(["water", "deep_water", "lava"]);
const land = (c, r) => c >= 0 && r >= 0 && c < N && r < N && !WATER.has(G[g[r][c]]);
const rise = (c0, c1, r) => { let lo = Infinity, hi = -Infinity; for (let c = c0; c <= c1; c++) { const v = L?.[r]?.[c] ?? 0; lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };
const inside = (area, x, y) => { let inn = false; for (let i = 0, j = area.length - 1; i < area.length; j = i++) { const [xi, yi] = area[i], [xj, yj] = area[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn; } return inn; };
/* candidate stands at a zone's true left edge, on flat land, where no other
 * zone carries a precipitation over the stand cell */
const spots = [];
for (const z of doc.zones) {
  if (z.kind === "world" || z.kind === "cave") continue;
  if (!Object.keys(z.effects).some((e) => PRECIP.includes(e) && z.effects[e] >= 50)) continue;
  const xs = z.area.map((p) => p[0]), ys = z.area.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  for (const f of [0.5, 0.35, 0.65]) {
    const r = Math.floor(y0 + (y1 - y0) * f);
    let edge = -1;
    for (let c = x0; c <= x1; c++) if (inside(z.area, c + 0.5, r + 0.5)) { edge = c; break; }
    if (edge < 0) continue;
    const standCol = edge - 4;
    if (!(land(standCol, r) && land(edge - 1, r) && land(edge, r) && land(edge + 3, r) && land(edge + 6, r))) continue;
    /* another zone over the stand cell may carry a precipitation only as a
     * trickle (maps2 gives nearly every zone snow 0.5 / storm 0.5 — a share
     * below 5 is on in under one window of 20, and the live check below
     * still requires the weight at my feet to be ~0) */
    const others = doc.zones.filter((o) => o !== z && o.kind !== "world" && inside(o.area, standCol + 0.5, r + 0.5));
    if (others.some((o) => Object.keys(o.effects).some((e) => PRECIP.includes(e) && o.effects[e] >= 5))) continue;
    /* THE INSIDE STAND is not "6 cells in": a small zone's other edge can be
     * right there (6 cells into the southern sands 2 read weight 0.63). Walk
     * in until the 5x5 around the cell is all inside — the field is then 1. */
    let innerCol = -1;
    for (let n = 3; n <= 14; n++) {
      const c = edge + n;
      if (!land(c, r)) continue;
      let all = true;
      for (let dr = -2; dr <= 2 && all; dr++) for (let dc = -2; dc <= 2; dc++) if (!inside(z.area, c + dc + 0.5, r + dr + 0.5)) { all = false; break; }
      if (all) { innerCol = c; break; }
    }
    if (innerCol < 0) continue;
    spots.push({ id: z.id, name: z.name, kind: z.kind, edgeCol: edge, innerCol, standCol, row: r, rise: rise(standCol - 1, edge + 7, r), area: (x1 - x0) * (y1 - y0), poly: z.area });
    break;
  }
}
/* flat ground first (a cliff between the stand and the edge lets the server
 * move me onto the summit), the bigger zone first among equals */
spots.sort((a, b) => a.rise - b.rise || b.area - a.area);
say(`${WORLD}: ${spots.length} precipitation zones with a flat land edge; first: ${spots.slice(0, 5).map((s) => `${s.name}@${s.standCol},${s.row} rise ${s.rise}`).join(" | ")}`);

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

/* HOLD THE PHASE. A local timeOfDay is overridden by the server's next world
 * time broadcast (measured by the chimney gate, 2026-09-13), and a relocation
 * re-syncs the clock: re-applied after every teleport until the reported sun
 * agrees twice, 1.5 s apart (time-based — headless runs at 2-5 fps). */
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

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((r) => setTimeout(() => r({ skip: `${what}: ${ms} ms passed` }), ms))]);
const settle = `async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(3000);
  for (let i = 0; i < 40 && !(window.__ml?.myScreen?.() && window.__ml.players?.() >= 1); i++) await wait(250);
  for (let i = 0; i < 160; i++) { const r = window.__ml.relocate?.(); if (!r || (!r.veil && !r.active)) break; await wait(250); }
  const rl = window.__ml.relocate?.();
  return !!window.__ml?.myScreen?.() && !(rl && (rl.veil || rl.active));
}`;

/* ---- stand outside a zone whose window has precipitation ON right now ---- */
let picked = null;
for (const s of spots.slice(0, 14)) {
  const r = await withTimeout(page.evaluate(async ({ s, settle, holdDay }) => {
    const packed = window.__ml.ambientZoneState().packed;
    const set = (packed.split(";").find((p) => p.startsWith(s.id + "=")) ?? "=").split("=")[1];
    const on = set ? set.split(",").filter(Boolean) : [];
    const name = on.find((n) => ["drizzle", "rain", "heavyrain", "storm", "snow", "windy"].includes(n));
    if (!name) return { skip: `window has no precipitation on (${on.join(",") || "nothing"})` };
    window.__ml.teleport(s.standCol + 0.5, s.row + 0.5);
    if (!(await (0, eval)(settle)())) return { skip: "did not settle" };
    if (window.__ml.indoor?.().indoor) return { skip: "indoors" };
    const day = await (0, eval)(holdDay)();
    if (day.stuck) return { skip: "could not hold the clock at Day" };
    const me = window.__ml.myScreen(); const v = window.__ml.camView();
    const at = window.__ml.pickAt(v.x + me.sx / me.zoom, v.y + me.sy / me.zoom);
    const cell = at ? { col: Math.floor(at.x / 32), row: Math.floor(at.y / 32), lvl: at.lvl } : null;
    if (!cell || Math.abs(cell.col - s.standCol) > 1 || Math.abs(cell.row - s.row) > 1) return { skip: `landed at ${JSON.stringify(cell)}, not the stand` };
    const here = window.__mlAmbient.zone(name, v.x + me.sx / me.zoom, v.y + me.sy / me.zoom);
    const cov = window.__mlAmbient.zone(name);
    return { name, on, here, cov, cell };
  }, { s, settle, holdDay }), 90_000, "stand");
  say(`stand: ${s.kind} "${s.name}" col ${s.standCol} row ${s.row} (edge ${s.edgeCol}) -> ${JSON.stringify(r)}`);
  if (r.skip) continue;
  /* a fifth of the view in the zone: enough drops for the ratios below to
   * mean something, and a picture that shows the line */
  if (r.here <= 0.05 && r.cov?.any && r.cov.mean >= 0.2) { picked = { ...s, ...r }; break; }
}
if (!picked) fail("could not stand outside any zone with precipitation on and the zone on screen");
else {
  say(`outside "${picked.name}" with ${picked.name} on there: weight ${picked.here} at my feet, coverage ${JSON.stringify(picked.cov)}`);
  await page.evaluate(() => window.__mlAmbient.zoneLines(true));
  /* the sheet fills in over SHOWN_TAU 4 s of EASED time, and the ease advances
   * at most 100 ms per frame: at headless frame rates that is minutes, so wait
   * for 90% of the target (45 s at most) rather than a fixed time */
  const fill = `async (name) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 22; i++) {
      const l = window.__mlAmbient.debug(name).layer;
      if (l.target > 0 && l.shown >= 0.9 * l.target) break;
      await wait(2000);
    }
    return window.__mlAmbient.debug(name).layer;
  }`;
  const out = await page.evaluate(async ({ p, fill }) => {
    await (0, eval)(fill)(p.name);
    const d = window.__mlAmbient.debug(p.name);
    const info = d.layer;
    /* THE EDGE IS A DIAGONAL ON SCREEN (iso), so a drop is judged by the CELL
     * it lands on: inside the polygon, or within the feather's reach of it
     * (2 cells: the 3x3 blur then the bilinear read) */
    const inside = (area, x, y) => { let inn = false; for (let i = 0, j = area.length - 1; i < area.length; j = i++) { const [xi, yi] = area[i], [xj, yj] = area[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn; } return inn; };
    const near = (c, r) => { for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) if (inside(p.poly, c + dc + 0.5, r + dr + 0.5)) return true; return false; };
    const me = window.__ml.myScreen(); const v = window.__ml.camView();
    const meX = v.x + me.sx / me.zoom, meY = v.y + me.sy / me.zoom;
    const cellNear = (x, y) => { const at = window.__ml.pickAt(x, y); return at ? near(Math.floor(at.x / 32), Math.floor(at.y / 32)) : null; };
    /* where each drop is DRAWN is judged against the polygon — the cell under
     * it, within the feather's reach; the few past it are the step's own
     * fade (FALL_RAMP_PX 40 along the fall) and must be faint */
    let over = 0, overMe = 0, unpicked = 0, outDrawn = 0, outMax = 0, outSum = 0;
    for (const s of info.sample) {
      const c = cellNear(s.x, s.y);
      if (c === null) { unpicked++; continue; }
      // over the zone's ground, or the step's faint fringe just past it (alpha x 0.15 is not rain)
      if (c || s.w < 0.15) over++;
      if (!c) { outDrawn++; outSum += s.w; if (s.w > outMax) outMax = s.w; }
      // MY BODY: from my feet up (the zone's own line may pass just below my feet on screen)
      if (Math.abs(s.x - meX) < 30 && s.y > meY - 100 && s.y < meY + 16 && s.w > 0.05) overMe++;
    }
    return { gain: d.gain, cover: d.cover, drawn: info.drawn, w: info.w, shown: info.shown, target: info.target, n: info.sample.length, over, overMe, unpicked, outDrawn, outMax, outMean: outDrawn ? outSum / outDrawn : 0, meX: Math.round(meX) };
  }, { p: picked, fill });
  say(`outside: gain ${out.gain}, cover ${out.cover}, ${out.drawn} drops drawn (pool ${out.shown} of target ${out.target}), drawn weights ${JSON.stringify(out.w)}, ${out.over} of ${out.n} sampled drops drawn over the zone's ground (${out.unpicked} unpicked), ${out.overMe} over my head (x ${out.meX}); ${out.outDrawn} drawn past the line at weight max ${out.outMax.toFixed(2)} mean ${out.outMean.toFixed(2)}`);
  if (!(out.gain > 0)) fail("the row is not running with its zone in view");
  if (!(out.drawn > 0)) fail("no drops drawn with the zone on screen — 'already raining on the other side' is not there");
  if (out.w.min <= 0) fail("a drop is drawn at weight 0");
  // drizzle is the sparsest sheet (90 at the reference area) and a small zone
  // covers a third of the view: five correct drops is the honest floor here
  if (out.n < 5) fail(`only ${out.n} drops sampled — not enough to judge`);
  if (out.n && out.over / out.n < 0.9) fail(`only ${out.over} of ${out.n} drops are drawn over the zone's ground (or faint just past it)`);
  if (out.overMe > 0) fail(`${out.overMe} drops fall over my head, outside the zone`);
  if (out.outMax > 0.6 || out.outMean > 0.35) fail(`drops drawn past the line are too strong (max ${out.outMax.toFixed(2)}, mean ${out.outMean.toFixed(2)}): the step is not fading`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/weatherzone-outside-${picked.id}.png` });
  say(`picture: ${OUT}/weatherzone-outside-${picked.id}.png`);

  /* ---- inside, looking out ---- */
  const inn = await withTimeout(page.evaluate(async ({ p, settle, holdDay, fill }) => {
    window.__ml.teleport(p.innerCol + 0.5, p.row + 0.5);
    if (!(await (0, eval)(settle)())) return { skip: "did not settle" };
    const day = await (0, eval)(holdDay)();
    if (day.stuck) return { skip: "could not hold the clock at Day" };
    await (0, eval)(fill)(p.name);
    const d = window.__mlAmbient.debug(p.name);
    const info = d.layer;
    const me = window.__ml.myScreen(); const v = window.__ml.camView();
    const here = window.__mlAmbient.zone(p.name, v.x + me.sx / me.zoom, v.y + me.sy / me.zoom);
    const inside = (area, x, y) => { let inn = false; for (let i = 0, j = area.length - 1; i < area.length; j = i++) { const [xi, yi] = area[i], [xj, yj] = area[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn; } return inn; };
    const near = (c, r, reach) => { for (let dr = -reach; dr <= reach; dr++) for (let dc = -reach; dc <= reach; dc++) if (inside(p.poly, c + dc + 0.5, r + dr + 0.5)) return true; return false; };
    /* PAST THE FEATHER nothing may be drawn; INSIDE it (2-4 cells: the
     * field's ramp plus the drop's own crossing fade) a drop may still be
     * drawn, faint — that is the soft line he asked for, not a leak. */
    let beyond = 0, fringe = 0, fringeMax = 0;
    for (const s of info.sample) {
      const at = window.__ml.pickAt(s.x, s.y);
      if (!at) continue;
      const c = Math.floor(at.x / 32), r = Math.floor(at.y / 32);
      if (!near(c, r, 4)) beyond++;
      else if (!near(c, r, 2)) { fringe++; if (s.w > fringeMax) fringeMax = s.w; }
    }
    return { here, gain: d.gain, cover: d.cover, drawn: info.drawn, w: info.w, n: info.sample.length, beyond, fringe, fringeMax: +fringeMax.toFixed(3) };
  }, { p: picked, settle, holdDay, fill }), 150_000, "inside");
  say(`inside: ${JSON.stringify(inn)}`);
  if (inn.skip) fail(`inside: ${inn.skip}`);
  else {
    if (!(inn.here > 0.9)) fail(`deep inside the weight at my feet is ${inn.here}`);
    if (!(inn.drawn > 0)) fail("no drops inside the zone");
    if (inn.beyond > 0) fail(`${inn.beyond} of ${inn.n} drops are drawn PAST THE FEATHER while I look out`);
    if (inn.fringeMax > 0.35) fail(`a drop in the fringe draws at ${inn.fringeMax} while I look out — the line leaks instead of fading`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/weatherzone-inside-${picked.id}.png` });
    say(`picture: ${OUT}/weatherzone-inside-${picked.id}.png`);
  }
  const cost = await page.evaluate(async () => { window.__mlAmbient.cost(true); await new Promise((r) => setTimeout(r, 3000)); const c = window.__mlAmbient.cost(); return Object.fromEntries(Object.entries(c).filter(([k]) => ["drizzle", "rain", "heavyrain", "storm", "snow", "windy"].includes(k)).map(([k, v]) => [k, v.ms])); });
  say(`cost ms/frame: ${JSON.stringify(cost)}`);
  await page.evaluate(() => window.__mlAmbient.zoneLines(false));
}
await browser.close();
say(failed ? "verify-weatherzone: FAILED" : "verify-weatherzone: OK");
process.exit(failed ? 1 : 0);
