// OUTDOOR SCENERY LIGHTS FADE OUT IN THE DAY, and come back through the evening
// (maintainer 2026-09-19: "the sun is usually so bright you can't have light
// like that outdoor. This is why we hid away the TORCH during the day ... But no
// popping! We are talking about a fade here").
//
// WHY IT EXISTS: the giant mushroom at 154.1,320.3 is placed LIT_1 and was
// lighting its OWN contact shadow — measured 1.250 raw light at its base against
// 0.793 on open ground seven cells away. Above 1.0 the screen clips, so the
// multiplicative contact AO darkened nothing: it read 16% there where indoor
// furniture reads 31%, which is exactly what he saw ("hard to see the scenery
// ambient occlusion ... I still have a hard time seeing it when I put the
// texture back on").
//
// ITS OWN SESSION, not an arm of verify-contact: that gate works the hearth
// house first, and a teleport across the world from there never streams this
// piece in — 40 s of polling and its contact stamp never appears, while a
// session that boots straight here has it in ~10 s.
//
// Needs the dev stack (npm run dev). PORT overrides vite's port.
import { chromium } from "playwright-core";
const PORT = process.env.PORT || "5173";
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await (await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, serviceWorkers: "block" })).newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`http://localhost:${PORT}/#the_game`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 120000 });
await page.evaluate(() => window.__mlSelect.commit());
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.__ml.noAggro?.(true));
await page.evaluate(() => window.__ml.teleport(154.1, 320.3));
await page.evaluate(() => window.__ml.torch?.(false));

// Wait for the PIECE, not the clock: scenery and its light stream in last
// through the art queue, and a reading taken before it arrives measures bare
// ground and blames the fade.
let there = false;
for (let i = 0; i < 40; i++) {
  there = await page.evaluate(() => ((window.__ml.contactStamps().stamps) || []).some((x) => /mushroom/i.test(x.piece || "") && x.built));
  if (there) break;
  await page.waitForTimeout(1000);
}
if (!there) fail("the giant mushroom never streamed in at 154.1,320.3");

const phase = async (name) => {
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.__ml.timeSpeed(0));
    await page.evaluate((n) => window.__ml.timeOfDay(n, true), name);
    await page.waitForTimeout(700);
    const t = await page.evaluate(() => window.__ml.timeOfDay());
    if (t && t.name === name) return true;
  }
  return false;
};
const lightAt = (c, r) => page.evaluate(([c, r]) => { const L = window.__ml.lightAtCell(c, r, 0); return Array.isArray(L) ? Math.max(...L) : L; }, [c, r]);
// SAMPLE A NEIGHBOURHOOD, MIN AND MAX. A single hardcoded cell read 0.66 one
// run and 1.07 the next: the contact band is thin and the SUN ROTATES within a
// phase, so the piece's own shadow moves off any fixed point. (The stamp's
// `points` are in the contact field's own space — 230,229 for a piece placed at
// 154,320 — so they are not cells and cannot be used here.)
//
// The two questions want different statistics, and asking each for its own is
// what makes this stable: by DAY, is the darkest point at its foot darker than
// open ground (it casts a shadow); by NIGHT, is the brightest point there much
// brighter (it lights its surroundings).
const around = async (c, r) => {
  const vals = [];
  for (let dc = -1; dc <= 1; dc++)
    for (let dr = -1; dr <= 1; dr++) vals.push(await lightAt(c + dc * 0.4, r + dr * 0.4));
  return { min: Math.min(...vals), max: Math.max(...vals) };
};
const BASE = [155.1, 319.6], OPEN = [162.0, 324.0];

if (there) {
  await phase("Day");
  await page.waitForTimeout(2500);
  const day = await page.evaluate(() => window.__ml.sceneryDayFade());
  const dayBase = await around(...BASE), dayOpen = await around(...OPEN);
  const dayR = dayBase.min / dayOpen.min;
  console.log(`day:     factor ${day.factor} (torchF ${day.torchF}), darkest at its foot ${dayBase.min.toFixed(3)} vs open ground ${dayOpen.min.toFixed(3)} = ${dayR.toFixed(3)}x`);
  if (day.factor > 0.01) fail(`an outdoor scenery light still burns at full Day (factor ${day.factor})`);
  // Below 1 means the piece is DARKER at its foot than open ground — it casts a
  // shadow instead of filling one in. It measured 1.58 before this existed.
  if (!(dayR < 1.0)) fail(`by Day the lit piece's foot is ${dayR.toFixed(2)}x open ground — it is still lighting its own contact shadow`);

  await phase("Night");
  await page.waitForTimeout(2500);
  const night = await page.evaluate(() => window.__ml.sceneryDayFade());
  const nightBase = await around(...BASE), nightOpen = await around(...OPEN);
  const nightR = nightBase.max / nightOpen.max;
  console.log(`night:   factor ${night.factor} (torchF ${night.torchF}), brightest at its foot ${nightBase.max.toFixed(3)} vs open ground ${nightOpen.max.toFixed(3)} = ${nightR.toFixed(3)}x`);
  if (night.factor < 0.99) fail(`an outdoor scenery light did not come back at Night (factor ${night.factor})`);
  if (!(nightR > 2.0)) fail(`at Night the lit piece lights its surroundings only ${nightR.toFixed(2)}x — the light never came back`);
}

// AND IT IS A FADE, NOT A SWITCH — the thing he asked for twice ("But no
// popping! We are talking about a fade here ofc!").
//
// SWEPT DETERMINISTICALLY, by pinning the clock at fine steps, NOT by running
// it: `timeOfDay(idx, true, phaseT)` sets the position exactly, while letting
// the world clock run at 4x means the server's own phase sync lands inside the
// sample window and re-pins the curve. That read 0.45 on one run and 0.045 on
// the next — flaky, and measuring the clock's sync rather than this fade.
{
  const PHASES = await page.evaluate(() => window.__ml.timeOfDay().phases?.length ?? 4);
  const STEP = 0.02;
  const seen = [];
  for (let i = 0; i <= PHASES / STEP; i++) {
    const u = i * STEP;
    const idx = Math.floor(u) % PHASES;
    const t = u - Math.floor(u);
    seen.push(await page.evaluate(([idx, t]) => { window.__ml.timeOfDay(idx, true, t); return window.__ml.sceneryDayFade().factor; }, [idx, t]));
  }
  const jump = seen.reduce((m, v, i) => (i ? Math.max(m, Math.abs(v - seen[i - 1])) : m), 0);
  const mid = seen.filter((v) => v > 0.05 && v < 0.95).length;
  console.log(`fade:    ${mid} intermediate of ${seen.length} samples across ${PHASES} phases, largest step ${jump.toFixed(3)}`);
  if (!mid) fail("the fade was never seen part-way — it is switching, not fading");
  // A 0.02-phase step moves a linear ramp by about 0.04. Anything near 1 is a switch.
  if (jump > 0.15) fail(`the fade STEPS by ${jump.toFixed(2)} across a ${STEP} phase step — it must ease`);
  await page.evaluate(() => window.__ml.timeOfDay("Day", true));
}

if (errs.length) fail(`page errors: ${errs.join(" | ")}`);
await browser.close();
console.log(process.exitCode ? "verify-scenerydayfade: FAIL" : "verify-scenerydayfade: ALL OK");
