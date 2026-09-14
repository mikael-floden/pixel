// Browser gate for SEA FOAM — the white line where moving water meets land.
//
// The maintainer's spec (2026-09-09): "Every game is being evaluated by its
// water ... the white animated line that always appears between moving water
// and land. We have two different types of water to land intersections and
// it's important to get both right": the coast in a boundary tile, and a wall
// going down into the water. So the gate has two hard arms — ON THE COAST and
// ON THE WALL'S CREST — and both are pixel arms: the foam must brighten the
// game's own line and nothing else. Two control boxes (open water, dry sand)
// must not change, or the effect is painting where there is no edge.
//
// Envelope technique (the embers gate's): the baseline is the per-pixel MAXIMUM
// over several effect-OFF frames, because the water underneath has its own
// animated marks; ON frames are judged against that envelope, with one more OFF
// frame as the noise control.
//
//   node scripts/verify-foam.mjs        (needs the dev stack on :5173)
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

const GAME_URL = process.env.GAME_URL || "http://localhost:5173/";
const REPO = join(new URL(".", import.meta.url).pathname, "..", "..");
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };

const IDLE_MS = 0.25; // mean ms/frame with nothing to bake (software GL harness)
const OFF_FRAMES = 5;
const ON_FRAMES = 8;

/* ---- the spots, from the world doc the game reads ------------------------ */
const world = JSON.parse(readFileSync(join(REPO, "maps2/worlds3/the_game/world.json"), "utf8"));
const G = world.grounds, g = world.ground, L = world.level, W = world.size.w, H = world.size.h;
const liquids = new Set(world.liquids || ["water", "deep_water", "lava"]);
const name = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? G[g[y][x]] : null);
const lvl = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? L[y][x] : 0);
const [spawnX, spawnY] = world.spawn;
const dist = (x, y) => Math.hypot(x - spawnX, y - spawnY);
const coasts = [], quays = [];
for (let y = 1; y < H - 1; y++)
  for (let x = 1; x < W - 1; x++) {
    if (name(x, y) !== "water") continue;
    const z = lvl(x, y);
    // a beach coast: a light_beach 4-neighbour on the same level, and no wall about
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => name(x + dx, y + dy) === "light_beach" && lvl(x + dx, y + dy) === z)) coasts.push({ c: x, r: y, d: dist(x, y) });
    const dirs = [];
    for (const [dir, hx, hy] of [["ul", x - 1, y], ["ur", x, y - 1], ["uu", x - 1, y - 1]]) {
      const hg = name(hx, hy);
      if (!hg || liquids.has(hg) || lvl(hx, hy) <= z) continue;
      if (Math.min(lvl(hx + 1, hy), lvl(hx, hy + 1)) === z) dirs.push(dir);
    }
    if (dirs.length) quays.push({ c: x, r: y, dirs, d: dist(x, y) });
  }
coasts.sort((a, b) => a.d - b.d);
quays.sort((a, b) => a.d - b.d);
console.log(`world: ${coasts.length} beach-coast water cells, ${quays.length} wall-foot water cells`);
if (!coasts.length) fail("no beach coast in the world doc");
if (!quays.length) fail("no wall dropping into water in the world doc");

/* ---- boot ------------------------------------------------------------------ */
const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(GAME_URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 60_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("foam")))) fail("foam is not registered");

const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find((b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings");
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')].map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("foam")) };
});
if (ui.error) fail(ui.error);
else if (!ui.found) fail(`no "Foam" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
else console.log(`settings: "Foam" is one of ${ui.labels.length} ambient rows`);

await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__ml.weather(0, true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "foam");
});

const settle = async () => {
  let v = await page.evaluate(() => window.__ml.camView());
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(400);
    const v2 = await page.evaluate(() => window.__ml.camView());
    if (v2.x === v.x && v2.y === v.y) return v2;
    v = v2;
  }
  return v;
};
/** Stand three cells off the spot, look at it, let the ground compose, drain the bakes. */
const goto = async (c, r) => {
  await page.evaluate(({ c, r }) => window.__ml.teleport(c + 3, r + 3), { c, r });
  await page.waitForTimeout(4000);
  await page.evaluate(({ c, r }) => window.__ml.lookAt(c, r), { c, r });
  await page.evaluate(async () => { window.__ml.groundRedraw(); await new Promise((r) => setTimeout(r, 2500)); });
  const view = await settle();
  for (let i = 0; i < 60; i++) {
    const d = await page.evaluate(() => window.__mlAmbient.debug("foam"));
    if (d.pending === 0 && d.sprites > 0) break;
    await page.waitForTimeout(300);
  }
  return view;
};
const shoot = async () => PNG.sync.read(await page.screenshot());
const luma = (png, X, Y) => { const i = (Y * png.width + X) * 4; return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]; };
/** Envelope judgement over a screen box: {best, at, noise}. */
const judge = (offs, noiseShot, ons, x0, x1, y0, y1) => {
  const base = new Map();
  for (const png of offs)
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const k = y * 10000 + x;
        base.set(k, Math.max(base.get(k) ?? 0, luma(png, x, y)));
      }
  const rise = (png) => { let m = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m = Math.max(m, luma(png, x, y) - base.get(y * 10000 + x)); return m; };
  let best = 0, at = -1;
  const rises = ons.map((png, i) => { const r = rise(png); if (r > best) { best = r; at = i; } return r; }).sort((a, b) => a - b);
  // the MEDIAN over the ON frames too: a bird or a name label crossing the box
  // brightens one or two frames, the foam brightens all of them (falsified
  // with the foam sunk under the ground: the wall box still read a 243 max)
  const med = rises[Math.floor(rises.length / 2)];
  return { best: +best.toFixed(1), at, med: +med.toFixed(1), noise: +rise(noiseShot).toFixed(1) };
};
const zoom = await page.evaluate(() => window.__ml.camZoom());

/* ---- ONE ARM PER EDGE ---------------------------------------------------- */
const arm = async (label, spot, findCell) => {
  const view = await goto(spot.c, spot.r);
  const d = await page.evaluate(() => window.__mlAmbient.debug("foam"));
  if (!d.masks) fail(`${label}: the mask sheet did not load (coasts cannot be traced)`);
  if (!d.palette.includes("water")) fail(`${label}: the water palette did not load`);
  const rec = findCell(d.all);
  if (!rec) { fail(`${label}: no foam sprite at cell ${spot.c},${spot.r} (sprites: ${d.all.length})`); return; }
  console.log(`${label}: cell ${rec.c},${rec.r} z${rec.z} foam px ${rec.px}, bbox (${rec.bx},${rec.by}) ${rec.w}x${rec.h}, alpha ${rec.a}`);
  if (rec.a < 0.99) fail(`${label}: drawn alpha ${rec.a}, expected 1 outdoors by day`);
  // depth: just above the ground texture, under every body
  const depth = await page.evaluate(({ x, y, w, h }) => {
    const objs = window.__ml.objectsIn(x, y, x + w, y + h) || [];
    return objs.map((o) => o.depth).filter((z) => z > -1_000_000 && z < -999_000);
  }, { x: rec.x + rec.bx, y: rec.y + rec.by, w: rec.w, h: rec.h });
  if (!depth.length) fail(`${label}: no display object in the ground band (-1e6, -999e3) over the cell — the foam must sit just above the ground texture`);
  else console.log(`${label}: foam depth ${depth[0]}`);
  // the band on screen
  const bx0 = Math.round((rec.x + rec.bx - view.x) * zoom), by0 = Math.round((rec.y + rec.by - view.y) * zoom);
  const bx1 = bx0 + rec.w * zoom, by1 = by0 + rec.h * zoom;
  if (bx0 < 0 || by0 < 0 || bx1 > 480 || by1 > 320) { fail(`${label}: the band box (${bx0},${by0})-(${bx1},${by1}) is off the 480x320 screen`); return; }
  // frames: OFF envelope, OFF control, ON series
  const setOn = (on) => page.evaluate((on) => window.__mlAmbient.setEnabled("foam", on), on);
  await setOn(false);
  await page.waitForTimeout(1500);
  const offs = [];
  for (let i = 0; i < OFF_FRAMES; i++) { offs.push(await shoot()); await page.waitForTimeout(180); }
  const noiseShot = await shoot();
  await setOn(true);
  await page.waitForTimeout(1500);
  const ons = [];
  for (let i = 0; i < ON_FRAMES; i++) { ons.push(await shoot()); await page.waitForTimeout(160); }
  const band = judge(offs, noiseShot, ons, bx0, bx1, by0, by1);
  console.log(`${label}: band luma rise ${band.best} (frame ${band.at}), median over ON frames ${band.med}, OFF noise ${band.noise}`);
  if (!(band.best >= 40 && band.best >= band.noise * 1.8)) fail(`${label}: the foam does not brighten its own band (rise ${band.best}, noise ${band.noise})`);
  if (!(band.med >= 30)) fail(`${label}: the band is bright in only some ON frames (median rise ${band.med}) — a passer-by, not foam`);
  // motion: consecutive ON frames differ inside the band
  let moved = 0;
  for (let i = 1; i < ons.length; i++) {
    let diff = 0;
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) if (Math.abs(luma(ons[i], x, y) - luma(ons[i - 1], x, y)) > 30) diff++;
    if (diff > 4) moved++;
  }
  console.log(`${label}: ${moved} of ${ons.length - 1} consecutive frame pairs differ inside the band`);
  if (moved < 3) fail(`${label}: the foam does not move (${moved} changing frame pairs of ${ons.length - 1})`);
  return { view, offs, noiseShot, ons, rec };
};

/* ---- THE COAST ------------------------------------------------------------ */
const coastSpot = coasts[0];
const coast = await arm("coast", coastSpot, (all) => {
  // the sprite nearest the spot with coast foam in it (any cell of the 3x3)
  return all.filter((a) => Math.abs(a.c - coastSpot.c) <= 1 && Math.abs(a.r - coastSpot.r) <= 1).sort((a, b) => b.px - a.px)[0];
});
if (coast) {
  // CONTROLS: open water 24+ px from any foam sprite, and dry sand 12+ px from the coast — no rise
  const { view, offs, noiseShot, ons } = coast;
  const sprites = await page.evaluate(() => window.__mlAmbient.debug("foam").all);
  const farFromFoam = (X, Y) => sprites.every((s) => X + 12 < s.x + s.bx || X - 12 > s.x + s.bx + s.w || Y + 8 < s.y + s.by || Y - 8 > s.y + s.by + s.h);
  const probes = await page.evaluate(({ view, n }) => {
    const out = [];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const wx = view.x + ((i + 0.5) / n) * view.w, wy = view.y + ((j + 0.5) / n) * view.h;
        const water = window.__ml.waterAtScreen(wx, wy);
        const land = window.__ml.landableAtScreen(wx, wy);
        out.push({ wx, wy, water, land });
      }
    return out;
  }, { view, n: 12 });
  const ctl = (pick, label) => {
    const p = probes.find((q) => pick(q) && farFromFoam(q.wx, q.wy));
    if (!p) { console.log(`${label} control: no spot found on screen — skipped`); return; }
    const x0 = Math.round((p.wx - 8 - view.x) * zoom), y0 = Math.round((p.wy - 6 - view.y) * zoom);
    const r = judge(offs, noiseShot, ons, Math.max(0, x0), Math.min(480, x0 + 16 * zoom), Math.max(0, y0), Math.min(320, y0 + 12 * zoom));
    console.log(`${label} control at world (${Math.round(p.wx)},${Math.round(p.wy)}): rise ${r.best}, noise ${r.noise}`);
    if (r.best > Math.max(12, r.noise * 1.8)) fail(`${label} control changed (rise ${r.best}) — foam is painting where there is no edge`);
  };
  ctl((q) => q.water, "open-water");
  ctl((q) => q.land, "dry-land");
}

/* ---- THE WALL ------------------------------------------------------------- */
// a quay whose water cell is actually VISIBLE (not hidden under a plateau in front)
const visibleQuay = await page.evaluate((cands) => {
  for (const q of cands) {
    const t = window.__ml.t3at(q.c, q.r);
    if (!t?.cell) continue;
    const pk = window.__ml.pickAt(t.cell.sx + 32, t.cell.sy + 18);
    if (pk && Math.floor(pk.x / 32) === q.c && Math.floor(pk.y / 32) === q.r && pk.lvl === t.cell.level) return q;
  }
  return null;
}, quays.slice(0, 200));
if (!visibleQuay) fail("no visible wall-foot water cell among the 200 nearest the spawn");
else {
  console.log(`wall: cell ${visibleQuay.c},${visibleQuay.r} (${visibleQuay.dirs.join("+")})`);
  const q = await arm("wall", visibleQuay, (all) => all.find((a) => a.c === visibleQuay.c && a.r === visibleQuay.r));
  if (q) {
    // the band must cover the crest: for a ul/ur wall the crest is rows 2..3 under the
    // shared edge, which at the diamond's widest is plate rows 2-3 and at the vertex 16-17;
    // structurally: the sprite's rows include a row in [2, 18) and the foam is on this cell
    const { rec } = q;
    if (!(rec.by <= 17 && rec.by + rec.h >= 3)) fail(`wall: the band rows ${rec.by}..${rec.by + rec.h} miss the crest rows`);
  }
}

/* ---- COST ------------------------------------------------------------------ */
const cost = await page.evaluate(async () => {
  window.__mlAmbient.cost(true);
  await new Promise((r) => setTimeout(r, 3000));
  const d = window.__mlAmbient.debug("foam");
  return { idle: window.__mlAmbient.cost().foam, bakes: d.bakes, bakeMs: +d.bakeMs.toFixed(1), texPeak: +d.texPeak.toFixed(1), scanPeak: +d.scanPeak.toFixed(1), live: d.live, sprites: d.sprites };
});
console.log(`cost: idle ${cost.idle.ms.toFixed(3)} ms/frame (peak ${cost.idle.peak}) over ${cost.idle.frames} frames; ${cost.bakes} bakes in ${cost.bakeMs} ms; upload peak ${cost.texPeak} ms; scan peak ${cost.scanPeak} ms; ${cost.live} live cells, ${cost.sprites} sprites`);
if (cost.idle.frames > 0 && cost.idle.ms > IDLE_MS) fail(`foam idles at ${cost.idle.ms.toFixed(3)} ms/frame, cap ${IDLE_MS}`);
if (cost.bakes > 0 && cost.bakeMs / cost.bakes > 1.5) fail(`a bake averages ${(cost.bakeMs / cost.bakes).toFixed(2)} ms, cap 1.5`);

await browser.close();
if (failed) { console.error("verify-foam: FAILED"); process.exit(1); }
console.log("verify-foam: OK");
