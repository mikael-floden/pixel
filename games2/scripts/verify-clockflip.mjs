// Time-of-day PILL verification ("Fern starfall"). The half-dial with its two
// cross-fading faces and its rotating .ml-clock-hand is long gone, and with it
// the whole hand-off machinery this gate used to protect: the +360 winding,
// the 1.25s glide, and the SERVER-side freeze (WorldRoom's handoffHoldMs) that
// stopped the world clock while the hand jumped 180°.
//
// What the pill is now: a 40x16 art-pixel scene painted into a canvas, shown
// at x2, with TWO INDEPENDENT BODIES (maintainer 2026-07-31). The sun crosses
// on morning+day+evening, the moon on evening+night+morning — equal spans, so
// EQUAL SPEED — and they share the sky at dawn and dusk. This gate asserts
// exactly that model, in art-pixel coordinates read from the canvas backing
// store (starvation-proof, no screenshot scaling):
//
//   * the sun arcs left -> apex -> right and is gone at midnight
//   * the moon is gone at noon and sits at the apex at midnight
//   * BOTH are on the pill during morning and evening, at opposite ends
//   * they travel the same number of pixels per unit of world time
//   * nothing jumps at a phase boundary or at the day's wrap
//
// Drives the REAL client headlessly against a dev stack.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const OUT = process.env.OUT || "/tmp";
const AW = 40; // art pixels across (clock.ts)
const AH = 16;
const NIGHT = 0;
const MORNING = 1;
const DAY = 2;
const EVENING = 3;

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const fail = (m) => {
  throw new Error(m);
};
try {
  // Device-width mobile geometry — the HUD/visual QA convention since the
  // remake. dsf 1: software-GL at dsf 2 starves the page to ~0.5fps.
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 851 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  // An ISOLATED world (its own room): the pill is world-independent, but a
  // shared room feeds this page "star" broadcasts — every join by a
  // concurrent gate, and the server's wild night stars — and each one
  // repaints the pill with a 900ms streak whose alpha-blended tail lands
  // inside the moon detector's colour window (caught 2026-08-05: "the moon
  // is up 3px while it is still day" whenever the battery froze the shared
  // clock mid-NIGHT and the wild-star timer kept firing).
  await page.evaluate(() => {
    const i = window.__mlSelect.worlds().findIndex((w) => /ring/i.test(w));
    if (i >= 0) window.__mlSelect.pickWorld(i);
  });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 30000 });
  // ms-polled (NOT waitForSelector): the software-GL page starves rAF, which
  // can wedge Playwright's raf-based selector wait even on a visible node.
  await page.waitForFunction(() => !!document.querySelector(".ml-clock canvas"), null, {
    timeout: 15000,
    polling: 100,
  });
  await page.waitForTimeout(1200);
  // FREEZE the world clock first. Everything below parks the clock at an exact
  // (phase, progress); at the default x1 the server keeps patching phaseT and
  // would drag every sample off its keyframe within a frame or two.
  await page.evaluate(() => window.__ml.timeSpeed(0));
  await page.waitForFunction(() => window.__ml.timeSpeed() === 0, null, { timeout: 10000, polling: 100 });
  // …and park the SERVER phase off Night (the settings button sends the real
  // "timeofday" skip): while the server sits in Night its wild-star timer
  // fires every 8-25s, and each star would streak the pill mid-measurement.
  // The local pins below don't touch the server, so this holds for the run.
  for (let i = 0; i < 4; i++) {
    const n = await page.evaluate(() => window.__ml.timeOfDay().name);
    if (n !== "Night") break;
    await page.evaluate(() => document.querySelector(".ml-hudbtn").click());
    await page.waitForFunction(() => window.__ml.timeOfDay().name !== "Night", null, { timeout: 8000, polling: 100 }).catch(() => {});
  }
  await page.waitForTimeout(1000); // let any join-star streak (900ms) die out

  await page.evaluate(
    ([AW, AH]) => {
      const cv = document.querySelector(".ml-clock canvas");
      const c2 = cv.getContext("2d");
      const near = (p, i, hex, tol) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return Math.abs(p[i] - r) <= tol && Math.abs(p[i + 1] - g) <= tol && Math.abs(p[i + 2] - b) <= tol;
      };
      window.__pill = {
        px: () => Array.from(c2.getImageData(0, 0, AW, AH).data),
        // Centroid + count of the pixels matching a body's core colour. The
        // daylit moon washes ~28% toward the sky, hence the roomier default.
        body: (hex, tol = 12) => {
          const d = c2.getImageData(0, 0, AW, AH).data;
          let n = 0;
          let sx = 0;
          let sy = 0;
          for (let y = 0; y < AH; y++)
            for (let x = 0; x < AW; x++) {
              const i = (y * AW + x) * 4;
              if (!near(d, i, hex, tol)) continue;
              n++;
              sx += x;
              sy += y;
            }
          return { n, x: n ? sx / n : -1, y: n ? sy / n : -1 };
        },
        sky: () => {
          const d = c2.getImageData(0, 0, AW, 5).data;
          let s = 0;
          for (let i = 0; i < d.length; i += 4) s += (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;
          return s / (d.length / 4);
        },
      };
      window.__pillDiff = (a, b) => {
        let s = 0;
        let n = 0;
        for (let i = 0; i < a.length; i += 4)
          for (let k = 0; k < 3; k++, n++) s += Math.abs(a[i + k] - b[i + k]);
        return s / n;
      };
    },
    [AW, AH],
  );

  const SUN = "#ffe08a";
  const MOON = "#f6f2e4";
  // Park the world clock at (phase, progress) — instant, no ease to wait out.
  const at = (idx, t) => page.evaluate(([i, p]) => window.__ml.timeOfDay(i, true, p), [idx, t]);
  const body = (hex) => page.evaluate((h) => window.__pill.body(h), hex);
  const pixels = () => page.evaluate(() => window.__pill.px());
  const sky = () => page.evaluate(() => window.__pill.sky());
  const both = async (idx, t) => {
    await at(idx, t);
    return { sun: await body(SUN), moon: await body(MOON) };
  };
  const diff = (a, b) => page.evaluate(([x, y]) => window.__pillDiff(x, y), [a, b]);
  const clip = await page.evaluate(() => {
    const r = document.querySelector(".ml-clock").getBoundingClientRect();
    return { x: Math.max(0, r.left - 40), y: Math.max(0, r.top - 20), width: 140, height: 80 };
  });
  const shotClock = (name) => page.screenshot({ path: `${OUT}/${name}`, clip });

  // ---- 1. structure: a fixed pass-through canvas pill at the game view's
  //         bottom-right, art-res backing store at x2, nearest-neighbour ----
  const s = await page.evaluate(() => {
    const root = document.querySelector(".ml-clock");
    const cs = getComputedStyle(root);
    const r = root.getBoundingClientRect();
    const cv = root.querySelector("canvas");
    return {
      pos: cs.position,
      pe: cs.pointerEvents,
      right: r.right,
      bottom: r.bottom,
      hudTop: document.querySelector(".ml-hud").getBoundingClientRect().top,
      vw: innerWidth,
      cw: cv.width,
      ch: cv.height,
      rect: cv.getBoundingClientRect(),
      smooth: getComputedStyle(cv).imageRendering,
      imgs: root.querySelectorAll("img").length,
      relics: root.querySelectorAll(".ml-clock-hand, .ml-clock-face, .ml-clock-hub").length,
    };
  });
  if (s.pos !== "fixed" || s.pe !== "none") fail(`pill not a fixed pass-through (${s.pos}/${s.pe})`);
  // Bottom-right of the GAME VIEW: 10px in from the right edge (the margin
  // the XP chip keeps at the top) and 10px above the HUD rail.
  if (Math.abs(s.vw - s.right - 10) > 1) fail(`pill right margin ${s.vw - s.right}px, want 10`);
  if (Math.abs(s.hudTop - s.bottom - 10) > 1)
    fail(`pill sits ${s.hudTop - s.bottom}px above the HUD rail, want 10`);
  if (s.cw !== AW || s.ch !== AH) fail(`canvas backing store ${s.cw}x${s.ch}, want ${AW}x${AH} art px`);
  if (Math.abs(s.rect.width - AW * 2) > 1 || Math.abs(s.rect.height - AH * 2) > 1)
    fail(`canvas drawn ${s.rect.width}x${s.rect.height}, want ${AW * 2}x${AH * 2} (x2 exact)`);
  if (s.smooth !== "pixelated") fail(`image-rendering ${s.smooth}, want pixelated`);
  if (s.imgs !== 0) fail(`${s.imgs} <img> inside the pill — the art is painted, not loaded`);
  if (s.relics !== 0) fail(`${s.relics} half-dial relics (hand/face/hub) still in the DOM`);
  console.log(`structure OK (${AW}x${AH} art px at x2, pixelated, bottom-right of the game view)`);

  // ---- 2. NOON: the sun alone, at the apex, dead centre ----
  const noon = await both(DAY, 0.5);
  if (noon.sun.n < 8) fail(`noon: only ${noon.sun.n} sun px on the pill`);
  if (Math.abs(noon.sun.x - AW / 2) > 3) fail(`noon sun at x=${noon.sun.x.toFixed(1)}, want the middle (~20)`);
  if (noon.sun.y > 4.5) fail(`noon sun at y=${noon.sun.y.toFixed(1)}, want the arc's apex`);
  if (noon.moon.n > 0) fail(`${noon.moon.n} moon px at noon — the moon is below the horizon all day`);
  const skyDay = await sky();
  await shotClock("clock-day.png");
  console.log(`noon OK (sun alone at x=${noon.sun.x.toFixed(1)} y=${noon.sun.y.toFixed(1)})`);

  // ---- 3. MIDNIGHT: the moon alone, at the apex, and a dark sky ----
  const mid = await both(NIGHT, 0.5);
  if (mid.moon.n < 8) fail(`midnight: only ${mid.moon.n} moon px on the pill`);
  if (Math.abs(mid.moon.x - AW / 2) > 3) fail(`midnight moon at x=${mid.moon.x.toFixed(1)}, want the middle`);
  if (mid.moon.y > 4.5) fail(`midnight moon at y=${mid.moon.y.toFixed(1)}, want the arc's apex`);
  if (mid.sun.n > 0) fail(`${mid.sun.n} sun px at midnight — the sun must be below the hills`);
  const skyNight = await sky();
  if (!(skyNight < skyDay * 0.5)) fail(`night sky luma ${skyNight.toFixed(1)} vs day ${skyDay.toFixed(1)}`);
  await shotClock("clock-night.png");
  console.log(`midnight OK (moon alone at apex, sky luma ${skyNight.toFixed(1)} vs day ${skyDay.toFixed(1)})`);

  // ---- 4. THE TWO-BODY SKY. Morning and evening are the whole point: both
  //         bodies up at once, at opposite ends. The moon rises the moment
  //         the sun enters evening and lingers all through the morning. ----
  const morn = await both(MORNING, 0.5);
  if (morn.sun.n < 4 || morn.moon.n < 4)
    fail(`morning should show BOTH (sun ${morn.sun.n}px, moon ${morn.moon.n}px)`);
  if (!(morn.sun.x < AW * 0.35)) fail(`morning sun at x=${morn.sun.x.toFixed(1)}, want the left end`);
  if (!(morn.moon.x > AW * 0.65)) fail(`morning moon at x=${morn.moon.x.toFixed(1)}, want the right end`);
  await shotClock("clock-morning.png");

  const eve = await both(EVENING, 0.5);
  if (eve.sun.n < 4 || eve.moon.n < 4)
    fail(`evening should show BOTH (sun ${eve.sun.n}px, moon ${eve.moon.n}px)`);
  if (!(eve.sun.x > AW * 0.65)) fail(`evening sun at x=${eve.sun.x.toFixed(1)}, want the right end`);
  if (!(eve.moon.x < AW * 0.35)) fail(`evening moon at x=${eve.moon.x.toFixed(1)}, want the left end`);
  await shotClock("clock-evening.png");
  console.log(
    `two-body sky OK (morning sun ${morn.sun.x.toFixed(1)} / moon ${morn.moon.x.toFixed(1)}, ` +
      `evening sun ${eve.sun.x.toFixed(1)} / moon ${eve.moon.x.toFixed(1)})`,
  );

  // The moon's crossing STARTS exactly when the sun enters evening: its
  // centre is on the horizon at that instant, so it is invisible through the
  // day, a sliver as evening opens (the last pixels clear the hills a breath
  // early — that is the continuity working, not a pop) and clearly climbing
  // soon after.
  const dayLate = await both(DAY, 0.9);
  const eveStart = await both(EVENING, 0.02);
  const eveUp = await both(EVENING, 0.3);
  if (dayLate.moon.n > 0) fail(`the moon is up ${dayLate.moon.n}px while it is still day`);
  if (eveStart.moon.n < 1) fail("the moon has not started rising at the beginning of evening");
  if (!(eveStart.moon.x < AW * 0.2)) fail(`the new moon rose at x=${eveStart.moon.x.toFixed(1)}, want the left edge`);
  if (!(eveUp.moon.n > eveStart.moon.n * 2)) fail(`the moon is not climbing (${eveStart.moon.n} -> ${eveUp.moon.n}px)`);
  if (!(eveUp.moon.y < eveStart.moon.y)) fail(`the moon sank (y ${eveStart.moon.y} -> ${eveUp.moon.y})`);
  console.log(
    `moonrise OK (none while it is day, ${eveStart.moon.n}px at x=${eveStart.moon.x.toFixed(1)} as evening ` +
      `opens, ${eveUp.moon.n}px climbing soon after)`,
  );

  // ---- 5. EQUAL SPEED — the reason the model changed at all. Both bodies
  //         are sampled over the SAME slice of world time, high in the sky
  //         where nothing clips them, and must cover the same distance. ----
  await at(DAY, 0.25);
  const sunA = (await body(SUN)).x;
  await at(DAY, 0.75);
  const sunB = (await body(SUN)).x;
  await at(NIGHT, 0.25);
  const moonA = (await body(MOON)).x;
  await at(NIGHT, 0.75);
  const moonB = (await body(MOON)).x;
  const dSun = sunB - sunA;
  const dMoon = moonB - moonA;
  if (dSun < 5) fail(`the sun barely moved over half a day (${dSun.toFixed(2)}px)`);
  if (Math.abs(dSun - dMoon) > 1)
    fail(`the moon does NOT keep the sun's pace: ${dSun.toFixed(2)}px vs ${dMoon.toFixed(2)}px per half-phase`);
  console.log(`equal speed OK (sun ${dSun.toFixed(2)}px, moon ${dMoon.toFixed(2)}px over the same world time)`);

  // ---- 6. Nothing jumps: at a phase boundary, or at the day's own wrap. ----
  await at(EVENING, 0.999);
  const beforeSunset = await pixels();
  await at(NIGHT, 0.001);
  const afterSunset = await pixels();
  await at(NIGHT, 0.999);
  const beforeWrap = await pixels();
  await at(MORNING, 0.001);
  const afterWrap = await pixels();
  await at(DAY, 0.5);
  const control0 = await pixels();
  await at(DAY, 0.75);
  const control1 = await pixels();

  const dSunset = await diff(beforeSunset, afterSunset);
  const dWrap = await diff(beforeWrap, afterWrap);
  const dControl = await diff(control0, control1);
  if (dControl < 3) fail(`the diff metric is blind (a quarter-phase of DAY moved it only ${dControl.toFixed(2)})`);
  if (dSunset > 1.5) fail(`sunset JUMPS: mean pixel delta ${dSunset.toFixed(2)} across the boundary (want <1.5)`);
  if (dWrap > 1.5) fail(`the day's wrap JUMPS: mean pixel delta ${dWrap.toFixed(2)}`);
  console.log(
    `continuity OK (sunset delta ${dSunset.toFixed(2)}, day wrap ${dWrap.toFixed(2)}, ` +
      `control step ${dControl.toFixed(2)})`,
  );

  // ---- 7. clockStar(): the HUD echo of a world shooting star repaints the
  //         pill SYNCHRONOUSLY (no CSS animation to starve) ----
  await at(NIGHT, 0.5); // a streak reads loudest against the dark sky
  const star = await page.evaluate(() => {
    const before = window.__pill.px();
    window.__ml.star();
    return window.__pillDiff(before, window.__pill.px());
  });
  if (!(star > 0)) fail("a shooting star left no trace on the pill");
  console.log(`clockStar OK (repaint delta ${star.toFixed(3)})`);

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log("CLOCK OK — sun and moon are two bodies sharing one sky at one speed");
  console.log("PASS");
} finally {
  await browser.close();
}
