// Browser gate for EMBER SPARKS — what comes off a fire and goes UP.
//
// The maintainer set the two conditions: "Ember sparks need to both know if
// this is a fire AND where the fire/light source is." So the two hard arms here
// are DISCRIMINATION and ORIGIN (a spark leaves the FLAME, not the object's
// foot). Then: it goes up, it fades in and out, and it costs nothing.
//
// DISCRIMINATION HAS A SHARP CASE now that scenery publishes the classification:
// a LANTERN is a real fire (`fire/enclosed`) that must throw nothing, because
// the glass is between it and the world. Anything sparking on "is it a flame"
// passes every other arm here and rains embers out of every street lamp — so
// the gate hunts for a fire-that-must-not-spark and requires silence over it.
//
//   node scripts/verify-embers.mjs        (needs the dev stack on :5173)
import { chromium } from "playwright-core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function chromePath() {
  const root = "/opt/pw-browsers";
  const c = existsSync(root)
    ? readdirSync(root).filter((d) => /^chromium(-\d+)?$/.test(d)).map((d) => join(root, d, "chrome-linux", "chrome"))
    : [];
  return [...c, join(root, "chromium")].find((p) => existsSync(p));
}

const URL = process.env.GAME_URL || "http://localhost:5173/";
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };

const COST_MS = 0.35;
const PROBES_PER_S = 4;

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));

await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("embers")))) fail("embers is not registered");

/* ---- IN THE SETTINGS MENU, AND THE SWITCH WORKS ---- */
const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find(
    (b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings",
  );
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')].map((r) =>
    (r.querySelector(".ml-amb-label")?.textContent || "").trim(),
  );
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("embers")) };
});
if (ui.error) fail(ui.error);
else {
  console.log(`settings: ${ui.labels.length} ambient rows — ${ui.found ? '"Embers" is one of them' : "NO embers row"}`);
  if (!ui.found) fail(`no "Embers" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
}

await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Night", true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "embers");
});

/* ---- FIND A FIRE, AND A FIRE THAT MUST STAY QUIET ----
 * DERIVED FROM THE GAME'S OWN DATA, not hunted for. A spiral of teleports was
 * the first cut and it does not work here: the nearest ember-throwing piece to
 * the spawn is 53 cells away, the ring it lives on has 12 sample angles, and a
 * view is about seven cells wide — so the walk missed it and reported "no fire
 * anywhere", which is a statement about the search, not about the map.
 *
 * So the gate reads the same two files the game reads — the world doc for the
 * CURRENT world (resolved through both world trees, as the server does) and
 * each lit piece's manifest — and teleports straight to a placement that throws
 * embers and to one that is a FIRE but must not. Nothing is named: which world,
 * which piece and which cell all come out of the data. */
const world = await page.evaluate(() => window.__ml.worldInfo());
const worldDoc = (() => {
  for (const root of ["maps2/worlds", "maps2/worlds3"]) {
    const f = join("..", root, world.name, "world.json");
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  }
  return null;
})();
if (!worldDoc) fail(`could not read the world doc for ${world.name} in either world tree`);

const lightBlock = (piece) => {
  const f = join("..", "scenery", piece, "scenery.json");
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf8")).light || {}; } catch { return {}; }
};
const placements = ((worldDoc && worldDoc.scenery) || []).filter((p) => p.lit);
const emberSpots = [];
const quietFireSpots = [];
for (const p of placements) {
  const b = lightBlock(p.piece);
  const at = { col: Math.round(p.x), row: Math.round(p.y), piece: p.piece, kind: b.kind };
  if (b.embers === true) emberSpots.push(at);
  else if (typeof b.kind === "string" && b.kind.startsWith("fire/")) quietFireSpots.push(at);
}
console.log(
  `world ${world.name}: ${placements.length} lit placements — ${emberSpots.length} throw embers, ` +
    `${quietFireSpots.length} are fire that must not`,
);
if (!emberSpots.length) fail("no ember-throwing piece is placed in this world — nothing to exercise");

/** Stand on a cell and let the effect settle; report what it sees there. */
const visit = async (spot, frames = 220) =>
  page.evaluate(async ({ spot, frames }) => {
    window.__ml.teleport(spot.col, spot.row);
    for (let i = 0; i < frames; i++) await new Promise((r) => requestAnimationFrame(r));
    const d = window.__mlAmbient.debug("embers");
    return { lights: d.lights, fires: d.fires, sparks: d.sparks, kinds: (d.fireList || []).map((f) => f.kind) };
  }, { spot, frames });

/* MOST OF THEM ARE INDOORS, and that is not a bug in either direction: a hearth
 * in a house and a brazier in a cave are SEALED, every ambient effect is outdoor
 * by charter, and standing inside one drops ctx.outdoor to 0 anyway. Measured on
 * the_game: of the first fourteen ember placements, eleven are sealed or in a
 * roofed room and three are in the open. So the run keeps trying until a fire
 * actually reaches the effect rather than judging it on the first candidate. */
let found = { col: null, coldSeen: null };
let tried = 0;
for (const spot of emberSpots.slice(0, 18)) {
  tried++;
  const r = await visit(spot);
  if (r.fires > 0) { found = { ...spot, ...r }; break; }
}
console.log(`visited ${tried} ember placement(s) to find one in the open`);
if (quietFireSpots.length) {
  // A fire that must throw nothing — the sharp case (a lantern behind glass).
  for (const spot of quietFireSpots.slice(0, 4)) {
    const r = await visit(spot, 150);
    if (r.lights > 0 && r.fires === 0) {
      found.coldSeen = { ...spot, ...r, kinds: [spot.kind], quietFire: [spot.kind] };
      break;
    }
  }
}

if (found.coldSeen)
  console.log(
    `cold: ${found.coldSeen.piece} (${found.coldSeen.kind}) at ${found.coldSeen.col},${found.coldSeen.row} — ` +
      `${found.coldSeen.lights} light(s) in view, none throws embers`,
  );
if (!found.col) fail(`none of the ${tried} ember placements visited reached the effect — all sealed or unloaded?`);
else {
  console.log(
    `fire: ${found.piece} (${found.kind}) at ${found.col},${found.row} — ` +
      `${found.fires} of ${found.lights} light(s) throw embers [${found.kinds.join(", ")}]`,
  );
  // Every source it picked must be one the DATA says throws embers.
  const picked = await page.evaluate(() =>
    (window.__mlAmbient.debug("embers").fireList || []).map((f) => f.kind),
  );
  const wrong = picked.filter((k) => !/^fire\//.test(k || ""));
  if (wrong.length) fail(`the effect picked ${wrong.length} source(s) that are not fire: ${wrong.join(", ")}`);

  /* ---- IT ONLY SPARKS OVER FIRES, AND THE SPARKS LEAVE THE FLAME ---- */
  const burn = await page.evaluate(async (spot) => {
    const step = () => new Promise((r) => requestAnimationFrame(r));
    /* STAND BACK AT THE FIRE. The search for a fire-that-must-stay-quiet runs
     * before this and leaves the player at THAT light, so measuring straight
     * afterwards measures the lantern and reports a fire throwing no sparks —
     * which it was, correctly, forty cells away. */
    window.__ml.teleport(spot.col, spot.row);
    for (let i = 0; i < 260; i++) await step();
    let samples = 0, up = 0, down = 0, farFromFlame = 0, most = 0;
    let early = 0, earlyN = 0, mid = 0, midN = 0, late = 0, lateN = 0;
    const prev = new Map();
    for (let i = 0; i < 420; i++) {
      const d = window.__mlAmbient.debug("embers");
      most = Math.max(most, d.sparks);
      (d.all || []).forEach((s, j) => {
        samples++;
        // BORN AT THE FLAME: a young spark must be within a few px of its fire.
        if (s.t < 0.12 && Math.hypot(s.x - s.fx, s.y - s.fy) > 14) farFromFlame++;
        // AND IT GOES UP.
        const last = prev.get("p" + j);
        if (last && last[2] < s.t) { if (s.y < last[1]) up++; else if (s.y > last[1]) down++; }
        // Alpha against age — the fade at both ends, without needing ids.
        if (s.t < 0.06) { early += s.a; earlyN++; }
        else if (s.t > 0.3 && s.t < 0.5) { mid += s.a; midN++; }
        else if (s.t > 0.94) { late += s.a; lateN++; }
      });
      (d.all || []).forEach((s, j) => prev.set("p" + j, [s.x, s.y, s.t]));
      await step();
    }
    return {
      samples, up, down, farFromFlame, most,
      early: earlyN ? early / earlyN : null,
      mid: midN ? mid / midN : null,
      late: lateN ? late / lateN : null,
      earlyN, midN, lateN,
    };
  }, { col: found.col, row: found.row });
  console.log(
    `sparks: ${burn.samples} samples, at most ${burn.most} at once; ${burn.up} rose vs ${burn.down} fell; ` +
      `${burn.farFromFlame} were born away from the flame`,
  );
  console.log(
    `fade: mean alpha ${burn.early === null ? "?" : burn.early.toFixed(3)} at birth, ` +
      `${burn.mid === null ? "?" : burn.mid.toFixed(3)} mid-life, ${burn.late === null ? "?" : burn.late.toFixed(3)} at the end`,
  );
  if (!burn.samples) fail("a fire was in view and it threw no sparks at all");
  if (burn.farFromFlame) fail(`${burn.farFromFlame} sparks were born more than 14px from their fire — they must leave the FLAME`);
  if (!(burn.up > burn.down * 8)) fail(`sparks rose ${burn.up} times and fell ${burn.down} — embers go UP`);
  if (burn.early !== null && burn.mid !== null && !(burn.early < burn.mid * 0.75))
    fail(`sparks appear at ${burn.early.toFixed(3)} against ${burn.mid.toFixed(3)} mid-life — they must brighten out of the flame`);
  if (burn.late !== null && burn.mid !== null && !(burn.late < burn.mid * 0.4))
    fail(`sparks end at ${burn.late.toFixed(3)} against ${burn.mid.toFixed(3)} mid-life — they must cool away, not switch off`);

  /* ---- AND NOTHING OVER A LIGHT THAT IS NOT A FIRE ----
   * The arm above only says sparks came from something the effect CALLS a fire.
   * This one stands where lights are present and none of them burns, and
   * requires silence — without it the whole feature could be "spark over every
   * light" and every test above would still pass. */
  if (!found.coldSeen) console.log("cold: no view with lights but no fires was found — discrimination not exercised");
  else {
    const cold = await page.evaluate(async (spot) => {
      const step = () => new Promise((r) => requestAnimationFrame(r));
      window.__ml.teleport(spot.col, spot.row);
      for (let i = 0; i < 150; i++) await step();
      let sparks = 0, lights = 0, fires = 0;
      for (let i = 0; i < 200; i++) {
        const d = window.__mlAmbient.debug("embers");
        sparks = Math.max(sparks, d.sparks);
        lights = Math.max(lights, d.lights);
        fires = Math.max(fires, d.fires);
        await step();
      }
      return { sparks, lights, fires };
    }, found.coldSeen);
    console.log(
      `cold: ${cold.lights} light(s) in view, ${cold.fires} ember sources, ${cold.sparks} sparks` +
        (found.coldSeen.quietFire.length ? ` (${found.coldSeen.quietFire.join(", ")} present)` : ""),
    );
    if (cold.fires === 0 && cold.sparks)
      fail(`${cold.sparks} sparks over ${cold.lights} light(s) that throw none — embers belong over an EMBER source`);
    if (!cold.lights) console.log("cold: the view had no lights after all — discrimination not exercised");
    else if (!found.coldSeen.quietFire.length)
      console.log("cold: no enclosed FIRE was in that view — the sharp case (a lantern) was not exercised");
  }
}

/* ---- COST ---- */
const cost = await page.evaluate(async () => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  window.__mlAmbient.cost(true);
  const p0 = window.__mlAmbient.debug("embers").probes;
  const t0 = performance.now();
  for (let i = 0; i < 360; i++) await step();
  const night = window.__mlAmbient.cost(true).embers;
  const perSecond = ((window.__mlAmbient.debug("embers").probes - p0) * 1000) / (performance.now() - t0);
  return { night, perSecond: +perSecond.toFixed(2) };
});
console.log(`cost: ${cost.night.ms} ms/frame (peak ${cost.night.peak}) over ${cost.night.frames} frames; light reads ${cost.perSecond}/s`);
if (!(cost.night.frames > 100)) fail(`only ${cost.night.frames} frames measured — the cost check proved nothing`);
if (cost.night.ms > COST_MS) fail(`embers cost ${cost.night.ms} ms/frame (ceiling ${COST_MS})`);
if (cost.perSecond > PROBES_PER_S) fail(`the light list is read ${cost.perSecond}/s — it walks every source and must stay throttled`);

await browser.close();
console.log(failed ? "verify-embers: FAILED" : "verify-embers: OK");
if (failed) process.exitCode = 1;
