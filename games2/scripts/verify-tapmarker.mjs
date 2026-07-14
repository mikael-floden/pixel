// Tap-marker glow check: the destination beacon must be BRIGHT AT NIGHT
// (drawn above the darkness overlay, additive), visible when the target is
// on an ELEVATED cell (above terrain occluders), and it must keep pulsating
// until the trip ends. Samples real screenshot pixels around __ml.marker().
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const fail = (m) => {
  throw new Error(m);
};

try {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  const WORLD = process.env.WORLD || "glow";
  await page.evaluate((re) => {
    const i = window.__mlSelect.worlds().findIndex((w) => new RegExp(re, "i").test(w));
    if (i >= 0) window.__mlSelect.pickWorld(i);
    window.__mlSelect.commit();
  }, WORLD);
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.bringToFront();
  await page.evaluate(() => window.__ml.timeOfDay("night", true));
  await page.waitForTimeout(800);

  const sampleAtMarker = async () => {
    let m = await page.evaluate(() => window.__ml.marker());
    if (!m) fail("no marker while a trip is active");
    // The target may be outside the camera window (it follows the player) —
    // pan to the marker for the pixel sample, then re-follow.
    if (m.sx < 20 || m.sy < 20 || m.sx > 620 || m.sy > 380) {
      // Pan by the trip TARGET (world wu) — marker x/y are scene pixels.
      await page.evaluate(() => {
        const t = window.__ml.target();
        if (t) window.__ml.lookAt(Math.floor(t.x / 32), Math.floor(t.y / 32));
      });
      await page.waitForTimeout(400);
      m = await page.evaluate(() => window.__ml.marker());
      if (!m) fail("marker vanished while panning to it");
    }
    // Sample across a pulse cycle (alpha 1 → 0.55 → 1): max of 3 shots.
    let best = 0;
    let lastShot = null;
    for (let shotN = 0; shotN < 3; shotN++) {
      lastShot = await page.screenshot();
      const shot = PNG.sync.read(lastShot);
      for (let dy = -10; dy <= 10; dy++)
        for (let dx = -14; dx <= 14; dx++) {
          const x = Math.round(m.sx + dx);
          const y = Math.round(m.sy + dy);
          if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) continue;
          const i = (y * shot.width + x) * 4;
          best = Math.max(best, 0.35 * shot.data[i] + 0.5 * shot.data[i + 1] + 0.15 * shot.data[i + 2]);
        }
      if (best >= 110) break;
      await page.waitForTimeout(160);
    }
    if (best < 110 && lastShot && process.env.SHOT_DIR) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${process.env.SHOT_DIR}/tapmarker-fail.png`, lastShot);
      console.log(`saved failing shot (marker at ${m.sx.toFixed(0)},${m.sy.toFixed(0)})`);
    }
    await page.evaluate(() => window.__ml.lookAt()); // re-follow the player
    return { ...m, best };
  };

  // Find a FLAT and an ELEVATED standable target near the player.
  const spots = await page.evaluate(() => {
    const me = window.__ml.me();
    const c0 = Math.floor(me.x / 32);
    const r0 = Math.floor(me.y / 32);
    let flat = null;
    let high = null;
    for (let rad = 3; rad <= 24 && (!flat || !high); rad++)
      // (flat can be near; the ELEVATED probe needs distance so the sampler
      // catches the marker mid-trip, not under an already-arrived player)
      for (let dr = -rad; dr <= rad; dr++)
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
          const x = (c0 + dc + 0.5) * 32;
          const y = (r0 + dr + 0.5) * 32;
          const s = window.__ml.surfaceAt(x, y);
          if (!s || !s.standable || window.__ml.blockedAt(x, y)) continue;
          const lvl = window.__ml.levelAt(x, y);
          if (lvl === 0 && !flat) flat = { x, y, lvl };
          if (lvl >= 2 && !high && rad >= 8) high = { x, y, lvl };
        }
    return { flat, high };
  });
  if (!spots.flat) fail("no flat target found near spawn");

  // 1) FLAT target at NIGHT: marker must be bright.
  await page.evaluate(({ x, y }) => window.__ml.tapTo(x, y, false), spots.flat);
  await page.waitForTimeout(300);
  const flat1 = await sampleAtMarker();
  console.log(`flat night marker: peak luminance ${flat1.best.toFixed(0)} at (${flat1.sx.toFixed(0)},${flat1.sy.toFixed(0)})`);
  if (flat1.best < 110) fail(`marker too dark at night (${flat1.best.toFixed(0)} < 110)`);

  // 2) PULSATES until arrival: alpha keeps changing while the trip is live,
  //    and the marker disappears once the target clears.
  const a1 = flat1.alpha;
  await page.waitForTimeout(260);
  const m2 = await page.evaluate(() => window.__ml.marker());
  if (!m2) fail("marker vanished mid-trip");
  if (Math.abs(m2.alpha - a1) < 0.02) fail(`marker not pulsating (alpha ${a1.toFixed(2)} → ${m2.alpha.toFixed(2)})`);
  console.log(`pulsating OK (alpha ${a1.toFixed(2)} → ${m2.alpha.toFixed(2)})`);
  let cleared = false;
  for (let i = 0; i < 120 && !cleared; i++) {
    await page.waitForTimeout(200);
    cleared = await page.evaluate(() => !window.__ml.target());
  }
  if (!cleared) fail("trip never ended");
  await page.waitForTimeout(400); // fade-out
  const gone = await page.evaluate(() => window.__ml.marker());
  if (gone) fail("marker still present after arrival");
  console.log("marker persists to arrival, then clears OK");

  // 3) ELEVATED target: the marker must be visible on top of the cliff.
  if (spots.high) {
    await page.evaluate(({ x, y }) => window.__ml.tapTo(x, y, false), spots.high);
    await page.waitForTimeout(300);
    const high1 = await sampleAtMarker();
    console.log(`elevated (lvl ${spots.high.lvl}) marker: peak luminance ${high1.best.toFixed(0)}`);
    if (high1.best < 110) fail(`marker invisible on elevated cell (${high1.best.toFixed(0)} < 110)`);
    await page.keyboard.down("ArrowDown");
    await page.waitForTimeout(200);
    await page.keyboard.up("ArrowDown"); // cancel the trip
  } else {
    console.log("no elevated cell within 24 cells of spawn — elevated check skipped");
  }

  console.log("TAP-MARKER OK");
} finally {
  await browser.close();
}
