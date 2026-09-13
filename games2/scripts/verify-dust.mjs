// Browser gate for LANDING DUST — the ground answers when you come down on it.
//
// The things that would be wrong and invisible to a unit test:
//   IT FIRES      — a hop and a fall are seen at all, off the game's own
//                   `me().jumping` and `fall().falling`. The pure model can be
//                   perfect while the detection never triggers.
//   AT THE FEET   — the puff is on the ground, not in the air. The position
//                   ambient can read is the SPRITE's, and the sprite carries
//                   the hop parabola: measured, firing on the timer alone put
//                   the dust 28 px up.
//   A FALL IS MORE— a drop off a ledge throws a wider, longer, denser puff
//                   than a hop, driven by the game's own fall velocity.
//   IT SHOWS      — a PHASE-MATCHED ON/OFF diff (see below).
//   IT IS THE GROUND — sand, stone and grass each throw their own colour.
//   NOT ON WATER  — landing in a lake is a splash, and this is not it.
//
//   node scripts/verify-dust.mjs        (needs the dev stack on :5173)
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
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
let failed = false;
const fail = (m) => { console.error("FAIL:", m); failed = true; };

const COST_MS = 0.12;         // it is an EVENT effect: idle it does nothing
/** Flat grass beside spawn. */
const GRASS = { c: 333, r: 241 };
/** A 3-level grass ledge: stand at 296,245 and walk north off 296,244. */
const LEDGE = { c: 296, r: 245 };
/** Pure patches for the colour arm, and a lake for the water arm. */
const SAND = { c: 252, r: 346 };
const STONE = { c: 269, r: 218 };
const LAKE = { c: 336, r: 258 };

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(GAME_URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30_000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__mlAmbient?.list, null, { timeout: 30_000 });
await page.waitForFunction(() => !document.getElementById("ml-loading"), null, { timeout: 60_000 });

if (!(await page.evaluate(() => window.__mlAmbient.list().includes("dust")))) fail("dust is not registered");

const ui = await page.evaluate(async () => {
  const tab = [...document.querySelectorAll(".ml-tab")].find((b) => (b.getAttribute("aria-label") || "").toLowerCase() === "settings");
  if (!tab) return { error: "no Settings tab in the HUD" };
  tab.click();
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));
  const labels = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-amb-row')].map((r) => (r.querySelector(".ml-amb-label")?.textContent || "").trim());
  return { labels, found: labels.some((t) => t.toLowerCase().startsWith("dust")) };
});
if (ui.error) fail(ui.error);
else if (!ui.found) fail(`no "Dust" row in the Settings ambient list (rows: ${ui.labels.join(", ")})`);
else console.log(`settings: "Dust" is one of ${ui.labels.length} ambient rows`);

await page.evaluate(() => {
  window.__ml.timeSpeed(0);
  window.__ml.timeOfDay("Day", true);
  window.__ml.weather(0, true);
  window.__mlAmbient.auto(false);
  for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "dust");
});

/** `__ml` goes away for a beat when a teleport crosses a zone border and the
 *  client re-joins — every probe read after a jump waits for it to come back. */
const ready = () => page.waitForFunction(() => !!window.__ml?.camView && !!window.__mlAmbient?.debug, null, { timeout: 60_000 });
/* SETTLE THE AVATAR, NOT JUST THE CAMERA. After a teleport the body eases
 * toward its target for a second or more (`av.lyFlat += (target - it) * k`),
 * so a "standing feet" sample taken too early is 7-14 px from where the feet
 * actually are by the time anything lands there. Wait for BOTH to stop. */
const settle = async () => {
  await ready();
  let v = await page.evaluate(() => window.__ml.camView());
  let f = await page.evaluate(() => window.__ml.myScreen());
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(250);
    const [v2, f2] = await Promise.all([
      page.evaluate(() => window.__ml.camView()),
      page.evaluate(() => window.__ml.myScreen()),
    ]);
    if (v2.x === v.x && v2.y === v.y && f2 && f && Math.abs(f2.sy - f.sy) < 0.5 && Math.abs(f2.sx - f.sx) < 0.5) return v2;
    v = v2;
    f = f2;
  }
  return v;
};
const goto = async (c, r) => {
  await ready();
  await page.evaluate(({ c, r }) => window.__ml.teleport(c, r), { c, r });
  await page.waitForTimeout(4500);
  await ready();
  // a re-join re-reads the toggles, so re-assert our solo selection
  await page.evaluate(() => {
    window.__mlAmbient.auto(false);
    for (const n of window.__mlAmbient.list()) window.__mlAmbient.setEnabled(n, n === "dust");
  });
  return settle();
};
const dbg = () => page.evaluate(() => window.__mlAmbient.debug("dust"));
const shoot = async () => PNG.sync.read(await page.screenshot());
const luma = (png, X, Y) => { const i = (Y * png.width + X) * 4; return 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]; };
/** Jump and wait out the whole landing, returning the puff it threw. */
const hopAndCatch = async () => {
  const before = (await dbg()).puffs;
  await page.evaluate(() => window.__ml.jump());
  for (let i = 0; i < 120; i++) {
    const d = await dbg();
    if (d.puffs > before && d.all.length) return d;
    await page.waitForTimeout(20);
  }
  return null;
};

/* ---- A HOP THROWS DUST ---------------------------------------------------- */
let view = await goto(GRASS.c, GRASS.r);
const hop = await hopAndCatch();
if (!hop) fail("a jump on flat grass threw no dust at all");
else {
  const p = hop.all[hop.all.length - 1];
  console.log(`hop: ${hop.hops} hops seen, puff of ${p.n} specks at power ${p.power}, tint #${p.tint.toString(16)}`);
  if (p.power !== 0) fail(`a flat hop has power ${p.power}; a hop is the zero end of the dial`);
}

/* ---- AT THE FEET ---------------------------------------------------------- */
/* COMPARE THE TWO AT THE SAME INSTANT. A "feet before the jump" reference is
 * the wrong one — the body is still easing toward its target after a teleport
 * and moved 7 px on its own between the sample and the landing. The question
 * is where the dust is relative to where the feet are WHEN IT LANDS, and the
 * check is only meaningful once the avatar is back on the ground. */
{
  const d = await hopAndCatch();
  if (!d) fail("no puff to check the position of");
  else {
    const at = await page.evaluate(() => {
      const v = window.__ml.camView(), z = window.__ml.camZoom(), ms = window.__ml.myScreen();
      return { x: v.x + ms.sx / z, y: v.y + ms.sy / z, jumping: !!window.__ml.me()?.jumping, falling: !!window.__ml.fall()?.falling };
    });
    const p = d.all[d.all.length - 1];
    const dy = Math.abs(p.y - at.y);
    const dx = Math.abs(p.x - at.x);
    console.log(`feet: puff at (${p.x},${p.y}) vs feet on landing (${Math.round(at.x)},${Math.round(at.y)}) — off by ${dx.toFixed(0)},${dy.toFixed(0)} px (airborne: ${at.jumping || at.falling})`);
    if (at.jumping || at.falling) fail("the puff was thrown while the player was still airborne");
    if (dy > 6) fail(`the dust is ${dy.toFixed(0)} px off the ground — it is being thrown in mid-air`);
    if (dx > 6) fail(`the dust is ${dx.toFixed(0)} px sideways of the feet`);
  }
}

/* ---- IT SHOWS: judge the SPECKS the feature claims ------------------------ */
/* A FRAME DIFF CANNOT ISOLATE THIS. The jump animation runs on its own clock,
 * so two jumps never line up: an ON/OFF pass phase-matched on the jump edge
 * still measured 6,074 changed pixels of moving character against four pixels
 * of dust, and PASSED — a false green, which is worse than a red. So the arm
 * asks the feature where each speck is and checks those pixels stand out from
 * the ground around them. No second pass, no phase to match, and it fails if
 * the dust is drawn anywhere other than where it says it is. */
{
  await goto(GRASS.c, GRASS.r);
  const zoom = await page.evaluate(() => window.__ml.camZoom());
  let judged = 0;
  let stood = 0;
  let best = 0;
  for (let round = 0; round < 6 && judged < 6; round++) {
    await page.evaluate(() => window.__ml.jump());
    for (let i = 0; i < 120; i++) {
      const d = await dbg();
      const puff = d.all.find((q) => q.t > q.life * 0.25 && q.t < q.life * 0.8);
      if (!puff) { await page.waitForTimeout(16); continue; }
      const [png, v, me] = await Promise.all([
        shoot(),
        page.evaluate(() => window.__ml.camView()),
        page.evaluate(() => window.__ml.myScreen()),
      ]);
      for (const sp of puff.specks) {
        if (sp.a < 0.2) continue;
        const X = Math.round((sp.x - v.x) * zoom);
        const Y = Math.round((sp.y - v.y) * zoom);
        /* CLEAR OF THE BODY: a speck under the character is judged against
         * the character, which proves nothing about the dust. The box is in
         * WORLD px through the zoom — a humanoid is about 28 px across at the
         * feet and 88 tall — because a box written in screen px is wrong the
         * moment the camera zoom changes. */
        if (Math.abs(X - me.sx) < 16 * zoom && Y < me.sy + 4 * zoom && Y > me.sy - 88 * zoom) continue;
        if (X < 4 || Y < 4 || X > 476 || Y > 316) continue;
        // the speck against the ground a few px away, in four directions
        const ring = [[6, 0], [-6, 0], [0, 5], [0, -5]].map(([dx, dy]) => luma(png, X + dx, Y + dy)).sort((a, b) => a - b);
        const ground = (ring[1] + ring[2]) / 2; // median-ish, ignores one odd neighbour
        const stand = Math.abs(luma(png, X, Y) - ground);
        judged++;
        best = Math.max(best, stand);
        if (stand > 12) stood++;
      }
      break;
    }
    await page.waitForTimeout(800);
  }
  console.log(`pixels: ${judged} specks judged clear of the body, ${stood} stand out from the ground (best ${best.toFixed(1)} luma)`);
  if (!judged) fail("no speck was ever drawn clear of the character — the puff never leaves the boots");
  else if (stood < Math.max(1, Math.floor(judged * 0.4)))
    fail(`only ${stood} of ${judged} specks are visible against the ground (best ${best.toFixed(1)} luma)`);
}

/* ---- A FALL THROWS MORE --------------------------------------------------- */
{
  await goto(LEDGE.c, LEDGE.r);
  const before = await dbg();
  let fell = null;
  for (let k = 0; k < 5 && !fell; k++) {
    await page.evaluate(({ c, r }) => window.__ml.teleport(c, r), LEDGE);
    await page.waitForTimeout(2500);
    await page.keyboard.down("w");
    for (let i = 0; i < 120; i++) {
      const d = await dbg();
      if (d.falls > before.falls && d.all.length) { fell = d; break; }
      await page.waitForTimeout(25);
    }
    await page.keyboard.up("w");
    await page.waitForTimeout(300);
  }
  if (!fell) fail("walking off a 3-level ledge never registered a fall landing");
  else {
    const p = fell.all[fell.all.length - 1];
    console.log(`fall: ${fell.falls} falls seen, puff of ${p.n} specks at power ${p.power}`);
    if (!(p.power > 0)) fail(`a fall landed at power ${p.power} — it is being read as a hop`);
    if (!(p.n > (hop?.all?.[0]?.n ?? 4))) fail(`a fall threw ${p.n} specks, no more than a hop`);
  }
}

/* ---- IT IS THE GROUND IT CAME FROM ---------------------------------------- */
{
  const tints = {};
  for (const [name, at] of [["grass", GRASS], ["sand", SAND], ["stone", STONE]]) {
    await goto(at.c, at.r);
    const sound = await page.evaluate(() => { const m = window.__ml.me(); return window.__ml.surfaceAt(m.x, m.y)?.sound ?? null; });
    const d = await hopAndCatch();
    if (!d) { fail(`no puff on ${name} — could not sample its colour`); continue; }
    tints[name] = { tint: d.all[d.all.length - 1].tint, sound };
  }
  console.log(`ground: ${Object.entries(tints).map(([k, v]) => `${k}(${v.sound}) #${v.tint.toString(16)}`).join(", ")}`);
  const uniq = new Set(Object.values(tints).map((v) => v.tint));
  if (Object.keys(tints).length >= 2 && uniq.size < Object.keys(tints).length)
    fail(`two surfaces threw the same colour dust (${[...uniq].map((t) => "#" + t.toString(16)).join(", ")}) — it is not reading the ground`);
}

/* ---- NOT ON WATER --------------------------------------------------------- */
{
  await goto(LAKE.c, LAKE.r);
  const swimming = await page.evaluate(() => !!window.__ml.me()?.swimming);
  const before = (await dbg()).puffs;
  for (let i = 0; i < 3; i++) { await page.evaluate(() => window.__ml.jump()); await page.waitForTimeout(1100); }
  const after = await dbg();
  console.log(`water: swimming ${swimming}, ${after.puffs - before} puffs thrown in the lake (skippedWet ${after.skippedWet})`);
  if (after.puffs > before) fail(`${after.puffs - before} dust puffs were thrown in a lake — a landing in water is a splash`);
}

/* ---- COST ----------------------------------------------------------------- */
{
  await goto(GRASS.c, GRASS.r);
  const idle = await page.evaluate(async () => {
    window.__mlAmbient.cost(true);
    await new Promise((r) => setTimeout(r, 4000));
    return window.__mlAmbient.cost().dust;
  });
  console.log(`cost: ${idle.ms.toFixed(3)} ms/frame standing still (peak ${idle.peak}) over ${idle.frames} frames`);
  if (idle.frames > 0 && idle.ms > COST_MS) fail(`dust costs ${idle.ms.toFixed(3)} ms/frame with nothing happening, cap ${COST_MS}`);
}

await browser.close();
if (failed) { console.error("verify-dust: FAILED"); process.exit(1); }
console.log("verify-dust: OK");
