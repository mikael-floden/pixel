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
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
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
const shore = (c, r) => {
  if (!land(c, r)) return false;
  for (let k = 1; k <= 3; k++) if (water(c + k, r) || water(c - k, r) || water(c, r + k) || water(c, r - k)) return true;
  return false;
};
const TERRAIN = {
  crabs: shore,
  // dragonflies belong to the REEDS, which are scenery and not a ground type:
  // a marsh grows them with no water tile in sight, and demanding a shore hid
  // the north-western marsh — the only dragonfly zone whose window was on.
  // Plain land, and the stand retry does the rest.
  bubbles: (c, r) => water(c, r) && water(c + 2, r) && water(c - 2, r) && water(c, r + 2) && water(c, r - 2), // open sea
};
const wants = TERRAIN[EFFECT] || land;

/* AND WHAT HOUR IT KEEPS. A spider's gain is 0.25 + 0.75 x night by design,
 * so holding the clock at Day and demanding a full gain fails a feature that
 * is behaving exactly as written. The phase names are WorldScene's
 * TIME_PHASES. */
const HOURS = { spiders: "Night", fireflies: "Night", moths: "Night", bats: "Night", gnats: "Evening" };
/* AN EPISODE IS JUDGED DIFFERENTLY. Birds wheel ACROSS the sky and bats cross
 * the whole frame: asking whether each one is over the zone's ground is the
 * wrong question, and would fail a flock that is behaving perfectly. What the
 * boundary means for an episode is that it is RUNNING while I stand outside
 * with its zone in view — the director's half of the rule, pinned exactly by
 * the unit test in server/test/zonefield.test.ts. */
const EPISODES = new Set(["birds", "bats", "leaves", "sandstorm", "thunder"]);
const EPISODE = EPISODES.has(EFFECT);
// how long to let a population build before judging it (ms per try x tries)
const HOUR = process.env.HOUR || HOURS[EFFECT] || "Day";
say(`holding the clock at ${HOUR} for ${EFFECT}`);

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
  /* ANCHORS ON A GRID THROUGH THE ZONE, not the first cell of each row. The
   * first-per-row rule always picked the zone's west edge, which for the sea
   * is the map edge: every walk east then ran 200 cells without leaving the
   * water and the gate reported that no sea zone had usable ground. */
  const anchors = [];
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / 600)));
  for (let r = y0; r <= y1 && anchors.length < 600; r += step)
    for (let c = x0; c <= x1 && anchors.length < 600; c += step)
      if (inArea(z.area, c + 0.5, r + 0.5) && wants(c, r)) anchors.push({ c, r });
  if (!anchors.length) continue;
  for (const a of anchors) {
    for (const d of DIRS) {
      // walk out of the polygon from the anchor, then 5 cells further
      // out of the polygon, and it has to be CLOSE: an anchor deep inside a
      // 200-cell sea has no boundary within sight of it
      let k = 0;
      while (k < 14 && inArea(z.area, a.c + d.dc * k + 0.5, a.r + d.dr * k + 0.5)) k++;
      if (k >= 14) continue;
      /* CLEAR OF THE WHOLE POLYGON, not just of the ray. Six steps east out
       * of the southern meadow landed beside another lobe of the same zone
       * and the field read 0.11 at my feet. Walk on until no cell within 3 is
       * inside it — that is what "outside" has to mean for a zone that bends
       * around you. */
      /* FOUR CELLS BEYOND, not six. The view is about twenty cells wide but
       * only seven tall, so a stand six cells north of a zone left the zone
       * off the bottom of the screen and the gate found nothing to look at.
       * The clear-of-the-whole-polygon walk below still pushes further when
       * the zone bends back, and `here <= 0.05` at the stand is what actually
       * proves I am outside it. */
      let out = k + 4;
      const clear = (c, r) => { for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) if (inArea(z.area, c + dc + 0.5, r + dr + 0.5)) return false; return true; };
      while (out < k + 12 && !clear(a.c + d.dc * out, a.r + d.dr * out)) out++;
      const stand = { c: a.c + d.dc * out, r: a.r + d.dr * out };
      if (!clear(stand.c, stand.r)) continue;
      const dist = Math.abs(stand.c - a.c) + Math.abs(stand.r - a.r);
      if (dist > 22) continue;
      const line = [];
      for (let n = 0; n <= out; n++) line.push({ c: a.c + d.dc * n, r: a.r + d.dr * n });
      // ON THE MAP and not molten; I must be standing on dry land myself. The
      // whole line used to have to be land, which can never be true for an
      // effect whose ground IS water (bubbles) — a bay between me and the
      // far side is not an obstacle, a cliff is, and `rise` below is what
      // rules a cliff out.
      if (!line.every((p) => land(p.c, p.r) || water(p.c, p.r))) continue;
      if (!land(stand.c, stand.r)) continue;
      const rise = Math.max(...line.map((p) => lvl(p.c, p.r))) - Math.min(...line.map((p) => lvl(p.c, p.r)));
      if (rise > 3) continue;
      // no other zone over the stand may carry this effect above a trickle
      const others = doc.zones.filter((o) => o !== z && o.kind !== "world" && inArea(o.area, stand.c + 0.5, stand.r + 0.5));
      if (others.some((o) => (o.effects[EFFECT] ?? 0) >= 5)) continue;
      spots.push({ id: z.id, name: z.name, kind: z.kind, dir: d.name, anchor: a, stand, rise, dist, cells: z.cells ?? 0, poly: z.area });
      break;
    }
    // a handful per zone is enough to survive a window that rolled the effect off
    if (spots.filter((q) => q.id === z.id).length >= 3) break;
  }
}
spots.sort((a, b) => b.cells - a.cells || a.rise - b.rise || a.dist - b.dist); // the rise is already capped; a big zone makes the picture
say(`${WORLD}: ${EFFECT} — ${spots.length} stands; first: ${spots.slice(0, 4).map((s) => `${s.name} ${s.dir}@${s.stand.c},${s.stand.r} (anchor ${s.anchor.c},${s.anchor.r}) rise ${s.rise} cells ${s.cells}`).join(" | ")}`);
if (!spots.length) { fail(`no zone carries ${EFFECT} with ground it can use and a flat way in`); process.exit(1); }

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: VIEW });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate((w) => { const i = window.__mlSelect.worlds().findIndex((n) => n === w); if (i >= 0) window.__mlSelect.pickWorld(i); window.__mlSelect.commit(); }, WORLD);
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.zone && document.querySelector(".ml-tab") && window.__ml.myScreen?.() !== null, null, { timeout: 60_000 });
await page.evaluate((h) => { window.__ml.timeSpeed(0); window.__ml.timeOfDay(h, true); }, HOUR);
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
const holdDay = `async (want) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sun = () => { const s = window.__ml.sunInfo(); return { phase: s.phase, sun: +((s.sun[0] + s.sun[1] + s.sun[2]) / 3).toFixed(3) }; };
  for (let tries = 0; tries < 8; tries++) {
    window.__ml.timeSpeed(0);
    window.__ml.timeOfDay(want, true);
    await wait(1500);
    const a = sun();
    await wait(1500);
    const b = sun();
    if (a.phase === want && b.phase === want && Math.abs(a.sun - b.sun) < 0.01) return b;
  }
  return { ...sun(), stuck: true };
}`;
/* the colony search is rate limited and the fade is seconds: give it time */
const grow = `async (name) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // wait for a POPULATION, not for the first one: spiders arrive one at a
  // time and a picture of a single speck proves nothing. Settle for whatever
  // has arrived by the end of the budget.
  for (let i = 0; i < 20; i++) {
    const d = window.__mlAmbient.debug(name);
    if (d && d.gain > 0.02 && (d.all?.length ?? 0) >= 3) break;
    await wait(2000);
  }
  return window.__mlAmbient.debug(name);
}`;

/* WALK THE FIELD AND READ IT: what is drawn, on whose ground, and where to
 * cut the zoom. Run per candidate stand, because a stand can be honestly
 * outside the zone and still show too little of it for the effect to place
 * anything — that is a bad stand, not a broken boundary. */
const look = (s) => withTimeout(page.evaluate(async ({ p, effect, grow }) => {
  const d = await (0, eval)(grow)(effect);
  const inArea = (area, x, y) => { let inn = false; for (let i = 0, j = area.length - 1; i < area.length; j = i++) { const [xi, yi] = area[i], [xj, yj] = area[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn; } return inn; };
  const near = (c, r, reach) => { for (let dr = -reach; dr <= reach; dr++) for (let dc = -reach; dc <= reach; dc++) if (inArea(p.poly, c + dc + 0.5, r + dr + 0.5)) return true; return false; };
  const me = window.__ml.myScreen(); const v = window.__ml.camView();
  const atMe = window.__ml.pickAt(v.x + me.sx / me.zoom, v.y + me.sy / me.zoom);
  const myC = atMe ? { c: Math.floor(atMe.x / 32), r: Math.floor(atMe.y / 32) } : null;
  let inZone = 0, outZone = 0, onMe = 0, unpicked = 0;
  const onGround = [];
  for (const a of d.all ?? []) {
    const at = window.__ml.pickAt(a.x, a.y);
    onGround.push(!!at);
    if (!at) { unpicked++; continue; }
    const c = Math.floor(at.x / 32), r = Math.floor(at.y / 32);
    if (near(c, r, 2)) inZone++; else outZone++;
    if (myC && Math.abs(c - myC.c) <= 2 && Math.abs(r - myC.r) <= 2) onMe++;
  }
  const home = d.colony ? { x: d.colony.x, y: d.colony.y, w: +window.__mlAmbient.zone(effect, d.colony.x, d.colony.y).toFixed(3) } : null;
  /* WHERE TO CUT THE ZOOM: the drawn things and me, in SCREEN pixels — a
   * 1 px ant on a 1280-wide shot is not a picture anyone can judge. */
  const toScreen = (wx, wy) => ({ sx: (wx - v.x) * me.zoom, sy: (wy - v.y) * me.zoom });
  const hull = (qs) => qs.reduce((b, q) => ({ x0: Math.min(b.x0, q.sx), y0: Math.min(b.y0, q.sy), x1: Math.max(b.x1, q.sx), y1: Math.max(b.y1, q.sy) }),
    { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
  const pts = (d.all ?? []).map((a) => toScreen(a.x, a.y)).filter((q, i) => onGround[i]);
  /* THE PICTURE IS ME AND THE NEAREST ONE ACROSS THE LINE. An ant is one
   * pixel: a box round the whole colony is a photograph of a field. The
   * nearest drawn thing to my feet is by construction the one just over the
   * boundary, so that pair frames the line, the empty ground on my side and
   * the effect on theirs — small enough to magnify. */
  let box = null;
  if (pts.length) {
    // CENTRE THE PICTURE ON WHAT WAS DRAWN. An ant is one world pixel: a box
    // stretched to take in my body as well photographs a field with nothing
    // in it. The full frame beside this one shows where I stand; this one has
    // to show the animals and the line they stop at.
    const cx = pts.reduce((a, q) => a + q.sx, 0) / pts.length;
    const cy = pts.reduce((a, q) => a + q.sy, 0) / pts.length;
    box = { x0: cx - 210, y0: cy - 130, x1: cx + 210, y1: cy + 130 };
  }
  /* PLACED, not merely listed. Some features report every pooled instance in
   * `all`, parked ones included — a butterfly waiting for a meadow sits at a
   * sentinel position far off the map — so "drawn" counted four ghosts and
   * one real animal. Only an instance the picker can put on a ground cell is
   * judged, and every one of those is. */
  return { gain: d.gain, running: d.active === true || d.gain > 0.02, zone: d.zone, drawn: (d.all ?? []).length, placed: inZone + outZone, inZone, outZone, onMe, unpicked, home, box,
    // the drawn positions in SCREEN pixels + mine, so the picture can be
    // ringed: several of these effects are ONE pixel and no crop makes a
    // 1 px ant on grass visible to a person judging a screenshot
    pts: pts.map((q) => [Math.round(q.sx), Math.round(q.sy)]), me: [Math.round(me.sx), Math.round(me.sy)] };
}, { p: s, effect: EFFECT, grow }), 90_000, "outside");

let picked = null;
let survey = null;
for (const s of spots.slice(0, 8)) {
  const r = await withTimeout(page.evaluate(async ({ s, effect, settle, holdDay, hour }) => {
    const packed = window.__ml.ambientZoneState().packed;
    const set = (packed.split(";").find((p) => p.startsWith(s.id + "=")) ?? "=").split("=")[1];
    const on = set ? set.split(",").filter(Boolean) : [];
    if (!on.includes(effect)) return { skip: `window has no ${effect} on (${on.join(",") || "nothing"})` };
    /* ASK AGAIN IF IT DID NOT MOVE. A teleport can be refused or swallowed,
     * and then every later stand reports the position of the FIRST one and
     * the run reads as "this zone has no usable stand" when what happened is
     * that I never left. Three asks, then give up on this stand honestly. */
    let cell = null;
    for (let t = 0; t < 3; t++) {
      window.__ml.teleport(s.stand.c + 0.5, s.stand.r + 0.5);
      if (!(await (0, eval)(settle)())) return { skip: "did not settle" };
      const m0 = window.__ml.myScreen(); const v0 = window.__ml.camView();
      const a0 = window.__ml.pickAt(v0.x + m0.sx / m0.zoom, v0.y + m0.sy / m0.zoom);
      cell = a0 ? { col: Math.floor(a0.x / 32), row: Math.floor(a0.y / 32), lvl: a0.lvl } : null;
      if (cell && Math.abs(cell.col - s.stand.c) <= 1 && Math.abs(cell.row - s.stand.r) <= 1) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!cell || Math.abs(cell.col - s.stand.c) > 1 || Math.abs(cell.row - s.stand.r) > 1) return { skip: `landed at ${JSON.stringify(cell)}, not the stand` };
    if (window.__ml.indoor?.().indoor) return { skip: "indoors" };
    const day = await (0, eval)(holdDay)(hour);
    if (day.stuck) return { skip: `could not hold the clock at ${hour}` };
    const me = window.__ml.myScreen(); const v = window.__ml.camView();
    const fx = v.x + me.sx / me.zoom, fy = v.y + me.sy / me.zoom;
    return { on, here: window.__mlAmbient.zone(effect, fx, fy), cov: window.__mlAmbient.zone(effect), cell };
  }, { s, effect: EFFECT, settle, holdDay, hour: HOUR }), 150_000, "stand");
  say(`stand: ${s.kind} "${s.name}" ${s.dir}, col ${s.stand.c} row ${s.stand.r} -> ${JSON.stringify(r)}`);
  if (r.skip) continue;
  if (!(r.here <= 0.05 && r.cov?.any)) continue;
  await page.evaluate(() => window.__mlAmbient.zoneLines(true));
  const o = await look(s);
  if (o.skip) { say(`  ${o.skip}`); continue; }
  if (!EPISODE && !(o.placed > 0)) { say(`  nothing placed from here (coverage ${JSON.stringify(r.cov)}) — too little of the zone on screen to place any; next stand`); continue; }
  /* A STAND THAT SHOWS A FEW. One animal on the far side is a pass but a poor
   * picture and a thin measurement, so keep the first usable stand as a
   * fallback and go on looking for one with a real population. */
  // an episode reports `active`, a field effect reports `gain` — either is "it is running"
  if (EPISODE) { if (o.running) { picked = { ...s, ...r }; survey = o; break; } say(`  the episode is not running here (active ${o.running}, gain ${o.gain}); next stand`); continue; }
  if (o.placed >= 3 || (picked && survey && survey.placed >= o.placed)) {
    if (!picked || o.placed > survey.placed) { picked = { ...s, ...r }; survey = o; }
    if (survey.placed >= 3) break;
  } else { picked = { ...s, ...r }; survey = o; }
}
if (!picked) fail(`could not stand outside a ${EFFECT} zone with ${EFFECT} on and the zone on screen`);
else {
  say(`outside "${picked.name}": field ${picked.here} at my feet, coverage ${JSON.stringify(picked.cov)}`);
  const out = survey;
  say(`outside: ${JSON.stringify(out)}`);
  if (out.skip) fail(`outside: ${out.skip}`);
  else {
    // an EPISODE is switched centrally (runtime/director.ts) and keeps no
    // watch of its own; the stand's own coverage above already proved its
    // zone is on screen
    if (!EPISODE && !out.zone?.any) fail(`${EFFECT} does not see its zone in view from here`);
    // the bar is the feature's own visible threshold (0.02), not a half: a
    // spider by day runs at 0.25 BY DESIGN and is still plainly out there
    if (!out.running) fail(`${EFFECT} is not running from outside (gain ${out.gain}) — "it already exists over there" is not there`);
    if (!EPISODE && !(out.placed > 0)) fail(`nothing placed on the ground: I cannot see the ${EFFECT} on the other side`);
    if (out.home && !(out.home.w > 0.5)) fail(`the colony sits at field weight ${out.home.w} — it was placed outside its zone`);
    // an episode crosses the whole frame by design; only a FIELD effect is
    // held to the zone's ground (see EPISODES above)
    if (!EPISODE && out.outZone > 0) fail(`${out.outZone} of ${out.drawn} drawn on ground outside the zone`);
    if (!EPISODE && out.onMe > 0) fail(`${out.onMe} drawn on the cells around me, on my side of the line`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/critterzone-${EFFECT}-${picked.id}.png` });
    say(`picture: ${OUT}/critterzone-${EFFECT}-${picked.id}.png`);
    writeFileSync(`${OUT}/critterzone-${EFFECT}-${picked.id}.json`,
      JSON.stringify({ effect: EFFECT, zone: picked.id, name: picked.name, pts: out.pts, me: out.me, box: out.box, counts: { drawn: out.drawn, inZone: out.inZone, outZone: out.outZone, onMe: out.onMe } }, null, 1));
    say(`marks: ${OUT}/critterzone-${EFFECT}-${picked.id}.json`);
    /* AND THE ZOOM: the same frame clipped to what was drawn plus me, with a
     * margin, inside the game's own viewport (the HUD sits below it). */
    if (out.box && out.box.x1 > out.box.x0 - 1) {
      const pad = 90;
      const gameH = await page.evaluate(() => Math.round(document.querySelector("canvas")?.getBoundingClientRect().height ?? window.innerHeight));
      const x = Math.max(0, Math.floor(out.box.x0 - pad));
      const y = Math.max(0, Math.floor(out.box.y0 - pad));
      const clip = {
        x, y,
        width: Math.min(VIEW.width - x, Math.ceil(out.box.x1 - out.box.x0) + 2 * pad),
        height: Math.min(gameH - y, Math.ceil(out.box.y1 - out.box.y0) + 2 * pad),
      };
      if (clip.width > 20 && clip.height > 20) {
        await page.screenshot({ path: `${OUT}/critterzone-${EFFECT}-${picked.id}-zoom.png`, clip });
        say(`zoom: ${OUT}/critterzone-${EFFECT}-${picked.id}-zoom.png (${clip.width}x${clip.height})`);
      }
    }
  }
  const cost = await page.evaluate(async (effect) => { window.__mlAmbient.cost(true); await new Promise((r) => setTimeout(r, 3000)); return window.__mlAmbient.cost()[effect]; }, EFFECT);
  say(`cost: ${JSON.stringify(cost)}`);
  await page.evaluate(() => window.__mlAmbient.zoneLines(false));
}
await browser.close();
say(failed ? "verify-critterzone: FAILED" : "verify-critterzone: OK");
process.exit(failed ? 1 : 0);
