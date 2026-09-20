// verify-critterzone — A FIELD EFFECT LIVES IN ITS ZONE, AND I SEE IT FROM OUTSIDE.
//
// Maintainer 2026-09-20: "The crabs, ants, spiders, etc already exist in that
// zone before I walk in. I can stand outside a zone and see effects like a
// crab on the other side, but not on this side."
//
// Stands a few cells OUTSIDE a zone that carries the effect, with a patch of
// the right terrain inside the zone on screen, and asserts:
//   - the effect is RUNNING (its zone is in view, though my own cell is not
//     in it) — that is "it already exists over there";
//   - everything drawn sits on ground inside the zone or within its feather;
//   - nothing is drawn on the cells around me, on this side of the line.
// Then a picture with the ambient-zones overlay on.
//
//   EFFECT=crabs node scripts/verify-critterzone.mjs   (needs the dev stack on :5173)
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
const EFFECT = process.env.EFFECT || "crabs";
const OUT = process.env.OUT || join(tmpdir(), "verify-critterzone");
const VIEW = { width: +(process.env.VIEW_W || 1280), height: +(process.env.VIEW_H || 720) };
mkdirSync(OUT, { recursive: true });
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };
const say = (m) => console.log(m);

const docPath = join("..", "maps2", "worlds3", WORLD, "ambient.json");
const worldPath = join("..", "maps2", "worlds3", WORLD, "world.json");
if (!existsSync(docPath)) { console.log("no ambient.json for this world — nothing to verify"); process.exit(0); }
const doc = JSON.parse(readFileSync(docPath, "utf8"));
const world = JSON.parse(readFileSync(worldPath, "utf8"));
const G = world.grounds, g = world.ground, N = g.length, L = world.level;
const WET = new Set(["water", "deep_water"]);
const HOT = new Set(["lava"]);
const groundAt = (c, r) => (c >= 0 && r >= 0 && c < N && r < N ? G[g[r][c]] : null);
const land = (c, r) => { const t = groundAt(c, r); return !!t && !WET.has(t) && !HOT.has(t); };
const water = (c, r) => WET.has(groundAt(c, r));
const lvl = (c, r) => L?.[r]?.[c] ?? 0;
const inArea = (area, x, y) => { let inn = false; for (let i = 0, j = area.length - 1; i < area.length; j = i++) { const [xi, yi] = area[i], [xj, yj] = area[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn; } return inn; };

/* WHAT GROUND THIS EFFECT NEEDS INSIDE THE ZONE. A crab wants a beach; the
 * crawlers want dry ground. Without this the gate stands at a zone whose
 * inside can never grow the effect and calls the boundary broken. */
const TERRAIN = {
  crabs: (c, r) => {
    if (!land(c, r)) return false;
    for (let k = 1; k <= 3; k++) if (water(c + k, r) || water(c - k, r) || water(c, r + k) || water(c, r - k)) return true;
    return false;
  },
};
const wants = TERRAIN[EFFECT] || land;

const DIRS = [
  { name: "west", dc: -1, dr: 0 }, { name: "east", dc: 1, dr: 0 },
  { name: "north", dc: 0, dr: -1 }, { name: "south", dc: 0, dr: 1 },
];
/* A STAND OUTSIDE, WITH THE EFFECT'S OWN GROUND INSIDE AND IN VIEW: an anchor
 * cell in the zone that the effect can actually use, and a spot 5 cells beyond
 * the polygon on land at much the same height (a cliff between us and it puts
 * the anchor off screen or behind a wall). */
const spots = [];
for (const z of doc.zones) {
  if (z.kind === "world" || !((z.effects[EFFECT] ?? 0) >= 50)) continue;
  const xs = z.area.map((p) => p[0]), ys = z.area.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const anchors = [];
  for (let r = y0; r <= y1 && anchors.length < 400; r++)
    for (let c = x0; c <= x1; c++)
      if (inArea(z.area, c + 0.5, r + 0.5) && wants(c, r)) { anchors.push({ c, r }); break; }
  if (!anchors.length) continue;
  for (const a of anchors) {
    for (const d of DIRS) {
      // walk out of the polygon from the anchor, then 5 cells further
      let k = 0;
      while (k < 24 && inArea(z.area, a.c + d.dc * k + 0.5, a.r + d.dr * k + 0.5)) k++;
      if (k >= 24) continue;
      const stand = { c: a.c + d.dc * (k + 4), r: a.r + d.dr * (k + 4) };
      const dist = Math.abs(stand.c - a.c) + Math.abs(stand.r - a.r);
      if (dist > 18) continue;
      const line = [];
      for (let n = 0; n <= k + 4; n++) line.push({ c: a.c + d.dc * n, r: a.r + d.dr * n });
      if (!line.every((p) => land(p.c, p.r))) continue;
      const rise = Math.max(...line.map((p) => lvl(p.c, p.r))) - Math.min(...line.map((p) => lvl(p.c, p.r)));
      if (rise > 3) continue;
      // no other zone over the stand may carry this effect above a trickle
      const others = doc.zones.filter((o) => o !== z && o.kind !== "world" && inArea(o.area, stand.c + 0.5, stand.r + 0.5));
      if (others.some((o) => (o.effects[EFFECT] ?? 0) >= 5)) continue;
      spots.push({ id: z.id, name: z.name, kind: z.kind, dir: d.name, anchor: a, stand, rise, dist, poly: z.area });
      break;
    }
    if (spots.length && spots[spots.length - 1].id === z.id) break;
  }
}
spots.sort((a, b) => a.rise - b.rise || a.dist - b.dist);
say(`${WORLD}: ${EFFECT} — ${spots.length} stands; first: ${spots.slice(0, 4).map((s) => `${s.name} ${s.dir}@${s.stand.c},${s.stand.r} (anchor ${s.anchor.c},${s.anchor.r}) rise ${s.rise}`).join(" | ")}`);
if (!spots.length) { fail(`no zone carries ${EFFECT} with ground it can use and a flat way in`); process.exit(1); }

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

/* THE WORLD CAN BE PINNED, AND THEN THERE ARE NO ZONES AT ALL — see
 * games2/ambient/README.md. Clear it on a local stack, refuse to run unruled. */
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
/* the colony search is rate limited and the fade is seconds: give it time */
const grow = `async (name) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 20; i++) {
    const d = window.__mlAmbient.debug(name);
    if (d && d.gain > 0.5 && (d.all?.length ?? 0) > 0) break;
    await wait(2000);
  }
  return window.__mlAmbient.debug(name);
}`;

let picked = null;
for (const s of spots.slice(0, 8)) {
  const r = await withTimeout(page.evaluate(async ({ s, effect, settle, holdDay }) => {
    const packed = window.__ml.ambientZoneState().packed;
    const set = (packed.split(";").find((p) => p.startsWith(s.id + "=")) ?? "=").split("=")[1];
    const on = set ? set.split(",").filter(Boolean) : [];
    if (!on.includes(effect)) return { skip: `window has no ${effect} on (${on.join(",") || "nothing"})` };
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
    return { on, here: window.__mlAmbient.zone(effect, fx, fy), cov: window.__mlAmbient.zone(effect), cell };
  }, { s, effect: EFFECT, settle, holdDay }), 90_000, "stand");
  say(`stand: ${s.kind} "${s.name}" ${s.dir}, col ${s.stand.c} row ${s.stand.r} -> ${JSON.stringify(r)}`);
  if (r.skip) continue;
  if (r.here <= 0.05 && r.cov?.any) { picked = { ...s, ...r }; break; }
}
if (!picked) fail(`could not stand outside a ${EFFECT} zone with ${EFFECT} on and the zone on screen`);
else {
  say(`outside "${picked.name}": field ${picked.here} at my feet, coverage ${JSON.stringify(picked.cov)}`);
  await page.evaluate(() => window.__mlAmbient.zoneLines(true));
  const out = await withTimeout(page.evaluate(async ({ p, effect, grow }) => {
    const d = await (0, eval)(grow)(effect);
    const inArea = (area, x, y) => { let inn = false; for (let i = 0, j = area.length - 1; i < area.length; j = i++) { const [xi, yi] = area[i], [xj, yj] = area[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn; } return inn; };
    const near = (c, r, reach) => { for (let dr = -reach; dr <= reach; dr++) for (let dc = -reach; dc <= reach; dc++) if (inArea(p.poly, c + dc + 0.5, r + dr + 0.5)) return true; return false; };
    const me = window.__ml.myScreen(); const v = window.__ml.camView();
    const atMe = window.__ml.pickAt(v.x + me.sx / me.zoom, v.y + me.sy / me.zoom);
    const myC = atMe ? { c: Math.floor(atMe.x / 32), r: Math.floor(atMe.y / 32) } : null;
    let inZone = 0, outZone = 0, onMe = 0, unpicked = 0;
    for (const a of d.all ?? []) {
      const at = window.__ml.pickAt(a.x, a.y);
      if (!at) { unpicked++; continue; }
      const c = Math.floor(at.x / 32), r = Math.floor(at.y / 32);
      if (near(c, r, 2)) inZone++; else outZone++;
      if (myC && Math.abs(c - myC.c) <= 2 && Math.abs(r - myC.r) <= 2) onMe++;
    }
    const home = d.colony ? { x: d.colony.x, y: d.colony.y, w: +window.__mlAmbient.zone(effect, d.colony.x, d.colony.y).toFixed(3) } : null;
    return { gain: d.gain, zone: d.zone, drawn: (d.all ?? []).length, inZone, outZone, onMe, unpicked, home };
  }, { p: picked, effect: EFFECT, grow }), 90_000, "outside");
  say(`outside: ${JSON.stringify(out)}`);
  if (out.skip) fail(`outside: ${out.skip}`);
  else {
    if (!out.zone?.any) fail(`${EFFECT} does not see its zone in view from here`);
    if (!(out.gain > 0.5)) fail(`${EFFECT} is not running from outside (gain ${out.gain}) — "it already exists over there" is not there`);
    if (!(out.drawn > 0)) fail(`nothing drawn: I cannot see the ${EFFECT} on the other side`);
    if (out.home && !(out.home.w > 0.5)) fail(`the colony sits at field weight ${out.home.w} — it was placed outside its zone`);
    if (out.outZone > 0) fail(`${out.outZone} of ${out.drawn} drawn on ground outside the zone`);
    if (out.onMe > 0) fail(`${out.onMe} drawn on the cells around me, on my side of the line`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/critterzone-${EFFECT}-${picked.id}.png` });
    say(`picture: ${OUT}/critterzone-${EFFECT}-${picked.id}.png`);
  }
  const cost = await page.evaluate(async (effect) => { window.__mlAmbient.cost(true); await new Promise((r) => setTimeout(r, 3000)); return window.__mlAmbient.cost()[effect]; }, EFFECT);
  say(`cost: ${JSON.stringify(cost)}`);
  await page.evaluate(() => window.__mlAmbient.zoneLines(false));
}
await browser.close();
say(failed ? "verify-critterzone: FAILED" : "verify-critterzone: OK");
process.exit(failed ? 1 : 0);
