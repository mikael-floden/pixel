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
import { PNG } from "pngjs";

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
        /* BORN AT THE FLAME. The window has to track the physics: a spark
         * leaves at up to RISE0 px/s, so "the first 12% of a 2.1s life" is a
         * quarter of a second and 24px of legitimate travel. Judge it in the
         * first 5% instead, where the bound is real. */
        if (s.t < 0.05 && Math.hypot(s.x - s.fx, s.y - s.fy) > 16) farFromFlame++;
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
  if (burn.farFromFlame) fail(`${burn.farFromFlame} sparks were born more than 16px from their fire — they must leave the FLAME`);
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

/* ---- A FIRE IN A CAVE SPARKS, AND YOU HAVE TO BE IN THERE ----
 * Every other ambient effect is outdoor by charter, and embers inherited that
 * and were silently dead beside the most atmospheric fire in the world: the
 * maintainer stood next to a cave brazier with the effect switched on and got
 * nothing (2026-09-08 — measured at his spot, outdoor gain 0). A spark belongs
 * to a fire you can SEE, so it follows the source instead of the sky, with the
 * sealed half of the rule keeping sparks off a roof that hides their own fire.
 * Most ember placements on the_game are indoors, so this is the common case
 * rather than an edge one. */
const roofed = await page.evaluate(async ({ spots }) => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  for (const spot of spots) {
    window.__ml.teleport(spot.col, spot.row);
    for (let i = 0; i < 220; i++) await step();
    const d = window.__mlAmbient.debug("embers");
    if (!d.inside || !d.fires) continue;
    let most = 0;
    for (let i = 0; i < 200; i++) { most = Math.max(most, window.__mlAmbient.debug("embers").sparks); await step(); }
    return { ...spot, inside: d.inside, fires: d.fires, sparks: most };
  }
  return null;
}, { spots: emberSpots.slice(0, 10) });
if (!roofed) console.log("roofed: no indoor ember fire was reached — the cave case was not exercised");
else {
  console.log(
    `roofed: ${roofed.piece} (${roofed.kind}) at ${roofed.col},${roofed.row} — indoors, ` +
      `${roofed.fires} fire(s), up to ${roofed.sparks} sparks`,
  );
  if (!roofed.sparks) fail("a fire under a roof, with the player in there with it, threw no sparks");
}

/* ---- AND IT IS ON THE SCREEN ----
 * THE ARM THAT WOULD HAVE CAUGHT THE FIRST SHIPPED VERSION. Every other check
 * here reads the effect's own numbers, and all of them passed while the game
 * showed nothing: the sparks were visible, at the right depth, with the right
 * alpha, at the right place, and drawn as 1x1 quads CENTRED on integer
 * positions — straddling two pixels each, so the screen never got them
 * (measured: a spark at alpha 0.81 moved its pixel by 0.1 luma). A counter
 * cannot see that.
 *
 * IT COMPARES A REGION OVER TIME, NOT A POINT. Reading one spark's position and
 * then screenshotting is a race — the screenshot is a separate round trip and
 * the spark has risen tens of pixels by the time it lands, so the arm passed or
 * failed on luck (54, then 30, then 5 luma on identical code). Instead: one
 * baseline with the effect OFF, then several frames with it ON, and the best
 * local brightening anywhere above the fire wins. The fire's own flicker is the
 * noise floor this has to beat.
 */
const shot = async () => PNG.sync.read(await page.screenshot({ type: "png" }));
const region = await page.evaluate(async (spot) => {
  const step = () => new Promise((r) => requestAnimationFrame(r));
  window.__ml.teleport(spot.col, spot.row);
  for (let i = 0; i < 200; i++) await step();
  /* CENTRE ON THE FIRE'S FOOT, NOT ITS FLAME. `pickAt` answers "which cell is
   * DRAWN at this screen point", and a point up in the air resolves to a cell
   * further up-screen — so centring on the flame put the fire 45px from the top
   * edge and the box of air above it collapsed to fifteen pixels. The light's
   * own `footY` is on the ground, where the question has one answer. */
  const l0 = (window.__ml.lightsInView(48) || []).filter((l) => l.embers)[0];
  const cell = l0 ? window.__ml.pickAt(l0.x, l0.footY) : null;
  /* DRIVE THE CAMERA UNTIL THE FIRE IS ACTUALLY FRAMED, rather than assuming a
   * centring worked. Two ways to be wrong here have already cost a run each:
   * `pickAt` on a point up in the air resolves to a different cell, and a
   * camera centred on the fire's own cell still leaves the flame near the top
   * once the piece's height is added. So: step the camera up-screen a cell at a
   * time (which walks the fire DOWN the frame) until there is room above it. */
  if (cell) {
    const c0 = cell.x / 32, r0 = cell.y / 32;
    for (let k = 0; k <= 6; k++) {
      window.__ml.lookAt(c0 - k, r0 - k);
      for (let i = 0; i < 60; i++) await step();
      const v = window.__ml.camView();
      const z = window.__ml.myScreen()?.zoom ?? 1;
      const f = (window.__mlAmbient.debug("embers").fireList || [])[0];
      if (!f) continue;
      if ((f.y - v.y) * z >= 150) break;
    }
  }
  for (let i = 0; i < 120; i++) await step();
  const v = window.__ml.camView();
  const z = window.__ml.myScreen()?.zoom ?? 1;
  const d = window.__mlAmbient.debug("embers");
  const fire = (d.fireList || [])[0];
  if (!fire) return null;
  /* THE PIECE'S OWN DRAWN ART, measured off the display list rather than
   * guessed from the fire point: the second pixel arm below has to look exactly
   * where the piece is, and a box picked by eye would drift with any art. The
   * LIT COPY is the one that matters (depth over the darkness overlay) — it is
   * the opaque thing that was covering the sparks. */
  let art = null;
  for (const o of window.__ml.objectsIn(fire.x - 200, fire.y - 260, fire.x + 200, fire.y + 120))
    if (o.depth > 900_000 && fire.piece && o.key.includes(fire.piece)) { art = o; break; }
  return {
    sx: Math.round((fire.x - v.x) * z), sy: Math.round((fire.y - v.y) * z), z,
    fireDepth: fire.depth, artDepth: art ? art.depth : null,
    art: art ? {
      x0: Math.round((art.x - v.x) * z), y0: Math.round((art.y - v.y) * z),
      x1: Math.round((art.x + art.w - v.x) * z), y1: Math.round((art.y + art.h - v.y) * z),
    } : null,
  };
}, { col: found.col, row: found.row });
if (!region) fail("no fire on screen to judge the sparks against");
else {
  /* WITH A CONTROL, because THE FIRE ITSELF MOVES. A hearth's art is animated
   * and its light flickers, so "the picture changed above the fire" is not
   * evidence of anything on its own — the first version of this arm measured
   * 244 luma of change and could not tell a spark from the flame's own next
   * frame. So: two frames with the effect OFF give the noise floor, and the
   * signal has to beat it. */
  /* AN ENVELOPE, NOT A FRAME. A hearth's art is ANIMATED and its light flickers,
   * so one "off" frame is one phase of a moving picture: comparing against it
   * measured 195 luma of change with the effect off, which is the fire, not a
   * spark. So the baseline is the PER-PIXEL MAXIMUM over several off frames
   * spanning the animation, and a spark has to beat the fire at its brightest,
   * in every phase, at that pixel. */
  await page.evaluate(async () => {
    window.__mlAmbient.setEnabled("embers", false);
    for (let i = 0; i < 220; i++) await new Promise((r) => requestAnimationFrame(r));
  });
  const offs = [];
  for (let i = 0; i < 8; i++) {
    offs.push(await shot());
    await page.evaluate(async () => { for (let k = 0; k < 14; k++) await new Promise((r) => requestAnimationFrame(r)); });
  }
  const off = offs[0];
  // The control: one MORE off frame, judged against the envelope built from the
  // others. Taken here so both boxes below share one set of frames.
  const noiseShot = await shot();
  await page.evaluate(async () => {
    window.__mlAmbient.setEnabled("embers", true);
    for (let i = 0; i < 200; i++) await new Promise((r) => requestAnimationFrame(r));
  });
  const ons = [];
  for (let i = 0; i < 8; i++) {
    ons.push(await shot());
    await page.evaluate(async () => { for (let k = 0; k < 20; k++) await new Promise((r) => requestAnimationFrame(r)); });
  }
  const lum = (im, x, y) => {
    const i = (y * im.width + x) * 4;
    return 0.299 * im.data[i] + 0.587 * im.data[i + 1] + 0.114 * im.data[i + 2];
  };
  /* ONE JUDGE, TWO BOXES. Per-pixel MAXIMUM over the off frames is the
   * baseline; the control is a further off frame against that same envelope. */
  const judge = (x0, x1, y0, y1) => {
    const w = x1 - x0;
    const env = new Float32Array(w * (y1 - y0));
    for (const im of offs)
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y - y0) * w + (x - x0);
          const l = lum(im, x, y);
          if (l > env[i]) env[i] = l;
        }
    const pk = (a) => {
      let b = 0, at = null;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const d = lum(a, x, y) - env[(y - y0) * w + (x - x0)];
          if (d > b) { b = d; at = [x, y]; }
        }
      return { b, at };
    };
    let best = 0, at = null;
    for (const a of ons) { const q = pk(a); if (q.b > best) { best = q.b; at = q.at; } }
    return { best, at, noise: pk(noiseShot).b };
  };
  /* THE AIR ABOVE THE FIRE, not the fire. The flame's own frames are the loudest
   * thing in this picture, so the box starts well clear of it — sparks rise, so
   * that is where they are anyway. */
  const x0 = Math.max(0, region.sx - 55), x1 = Math.min(off.width, region.sx + 55);
  const y0 = Math.max(0, region.sy - 105), y1 = Math.max(0, region.sy - 12);
  if (y1 - y0 < 40 || x1 - x0 < 60)
    fail(`the air above the fire framed as ${x1 - x0}x${y1 - y0}px — the camera is not showing the sparks, so this proves nothing`);
  const air = judge(x0, x1, y0, y1);
  console.log(
    `screen: over ${x1 - x0}x${y1 - y0}px of air above the fire, the sparks brighten a pixel by ` +
      `${air.best.toFixed(1)} luma past the fire's own brightest at ${air.at ? air.at.join(",") : "?"} — ` +
      `against ${air.noise.toFixed(1)} for a frame with no sparks in it`,
  );
  if (air.best < 25) fail(`the brightest thing the sparks add to the screen is ${air.best.toFixed(1)} luma — too faint to find`);
  if (air.best < air.noise * 1.8)
    fail(`the sparks add ${air.best.toFixed(1)} luma where the flame's own animation moves ${air.noise.toFixed(1)} — that is not a spark, that is the fire`);

  /* ---- AND ON THE PIECE ITSELF, which is a DIFFERENT question ----
   *
   * The box above is AIR: it deliberately starts clear of the fire so the
   * flame's own frames are not the subject. That is why it could not see the
   * bug the maintainer found (2026-09-09: "you render the sparks ... behind the
   * Scenery object so it's hard to see"). Every scenery piece draws an opaque
   * LIT COPY at ~900_001 and the sparks sat at ~900_000.08, so the hearth
   * painted over every spark still inside its own art — and the ones that
   * escaped ABOVE it kept this arm green. Measured at his hearth, old depth vs
   * new: the air box read 48.8 luma both ways, while the box ON the piece went
   * 0.0 -> 163.6. A gate that looks only where the thing is not covered cannot
   * see covering.
   *
   * So: the same envelope discipline, over the intersection of the piece's own
   * DRAWN rect with the band above the flame. The rect is measured off the
   * display list, never guessed, and the arm fails loudly if that measurement
   * did not happen — a box it cannot place proves nothing. */
  if (!region.art) fail("could not find the fire's own art on the display list — the covering arm did not run");
  else {
    const ax0 = Math.max(0, region.art.x0), ax1 = Math.min(off.width, region.art.x1);
    // Above the flame (its animation is the loudest thing here) and inside the art.
    const ay0 = Math.max(0, region.art.y0), ay1 = Math.min(off.height, region.sy - 8);
    if (ax1 - ax0 < 20 || ay1 - ay0 < 20)
      fail(`the fire's own art framed as ${ax1 - ax0}x${ay1 - ay0}px — too small to judge covering with`);
    else {
      const on = judge(ax0, ax1, ay0, ay1);
      console.log(
        `covering: over ${ax1 - ax0}x${ay1 - ay0}px OF THE PIECE'S OWN ART (depth ${region.artDepth}, ` +
          `sparks ${region.fireDepth}), the sparks brighten a pixel by ${on.best.toFixed(1)} luma at ` +
          `${on.at ? on.at.join(",") : "?"} — against ${on.noise.toFixed(1)} with no sparks`,
      );
      if (!(region.fireDepth > region.artDepth))
        fail(`sparks draw at ${region.fireDepth} and their own fire's art at ${region.artDepth} — the piece is in front of its own sparks`);
      if (on.best < 25)
        fail(`the sparks add ${on.best.toFixed(1)} luma over the piece they come out of — it is drawing on top of them`);
      if (on.best < on.noise * 1.8)
        fail(`over the piece the sparks add ${on.best.toFixed(1)} luma where its own art moves ${on.noise.toFixed(1)} — that is the art, not a spark`);
    }
  }

  /* AND BIG ENOUGH TO SEE. One WORLD pixel is about one CSS pixel on the
   * maintainer's phone (camera zoom 3 against device ratio 2.75), and an
   * additive speck that size over a lit fireplace cannot be found even when it
   * is genuinely drawn — measured, three times. */
  const size = await page.evaluate(() => window.__mlAmbient.debug("embers").draw);
  if (!size) console.log("size: no live spark to measure");
  else {
    console.log(`size: a spark draws ${size.dw}x${size.dh} world px, blend ${size.blend}`);
    if (size.dw < 2 || size.dh < 2)
      fail(`a spark is ${size.dw}x${size.dh} world px — about one CSS pixel on his phone, which is not visible`);
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
