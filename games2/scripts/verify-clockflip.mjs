// Time-of-day PILL verification ("Fern starfall", 2026-07-31). The half-dial
// with its two cross-fading faces and its rotating .ml-clock-hand is GONE, and
// with it the whole hand-off machinery this gate used to protect: the +360
// winding, the 1.25s glide, and the SERVER-side freeze (WorldRoom's
// handoffHoldMs) that stopped the world clock while the hand jumped 180°.
//
// The pill is REAL PIXEL ART — a 40x16 art-pixel scene painted into a canvas
// and shown at x2 — and the sun and moon ride a continuous BELT: the body
// leaving the right edge and the body entering on the left are the same
// motion. So the property to protect is now CONTINUITY: park the world clock a
// hair on either side of sunset (and of sunrise) and the picture must be
// essentially the same picture. That is the proof there is nothing left to
// freeze.
//
// Drives the REAL client headlessly against a dev stack.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const OUT = process.env.OUT || "/tmp";
const AW = 40; // art pixels across (clock.ts)
const AH = 16;

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
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 30000 });
  // ms-polled (NOT waitForSelector): the software-GL page starves rAF, which
  // can wedge Playwright's raf-based selector wait even on a visible node.
  await page.waitForFunction(() => !!document.querySelector(".ml-clock canvas"), null, {
    timeout: 15000,
    polling: 100,
  });
  await page.waitForTimeout(1200);

  // Everything below reads the canvas BACKING STORE (40x16 art pixels), not a
  // screenshot: exact art-pixel coordinates, immune to starvation and scaling.
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
        // Raw art pixels as a flat array — the diff metric operates on these.
        px: () => Array.from(c2.getImageData(0, 0, AW, AH).data),
        // Centroid + count of the pixels matching a body's core colour.
        body: (hex, tol = 10) => {
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
        // Mean luma of the TOP half (the sky, above the hills).
        sky: () => {
          const d = c2.getImageData(0, 0, AW, 5).data;
          let s = 0;
          for (let i = 0; i < d.length; i += 4) s += (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;
          return s / (d.length / 4);
        },
      };
      // Mean absolute per-channel difference between two px() snapshots.
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
  // The pill lives at the bottom-right of the game view now — crop there.
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

  // ---- 2. the sun ARCS: low at morning, apex dead-centre at noon, low and
  //         far right at evening — and it is GONE at midnight ----
  await at(2, 0.5); // Day, mid-phase = the sun's apex
  const sunDay = await body(SUN);
  if (sunDay.n < 8) fail(`day: only ${sunDay.n} sun px on the pill`);
  if (Math.abs(sunDay.x - AW / 2) > 3) fail(`noon sun at x=${sunDay.x.toFixed(1)}, want the middle (~20)`);
  if (sunDay.y > 4.5) fail(`noon sun at y=${sunDay.y.toFixed(1)}, want the arc's apex (<=4)`);
  await shotClock("clock-day.png");

  await at(1, 0.5); // Morning
  const sunMorn = await body(SUN);
  if (!(sunMorn.x < AW / 2 - 6)) fail(`morning sun at x=${sunMorn.x.toFixed(1)}, want the left half`);
  if (!(sunMorn.y > sunDay.y)) fail(`morning sun (y=${sunMorn.y.toFixed(1)}) not below noon's apex`);

  await at(3, 0.5); // Evening
  const sunEve = await body(SUN);
  if (!(sunEve.x > AW / 2 + 6)) fail(`evening sun at x=${sunEve.x.toFixed(1)}, want the right half`);
  if (!(sunEve.y > sunDay.y)) fail(`evening sun (y=${sunEve.y.toFixed(1)}) not below noon's apex`);
  console.log(
    `sun arc OK (x ${sunMorn.x.toFixed(1)} -> ${sunDay.x.toFixed(1)} -> ${sunEve.x.toFixed(1)}, ` +
      `y ${sunMorn.y.toFixed(1)} -> ${sunDay.y.toFixed(1)} -> ${sunEve.y.toFixed(1)})`,
  );

  // ---- 3. midnight: the MOON is at the apex, the sun has set, sky is dark ----
  const skyDay = await sky();
  await at(0, 0.5); // Night, mid-phase = midnight
  const moon = await body(MOON);
  const sunNight = await body(SUN);
  const skyNight = await sky();
  if (moon.n < 8) fail(`midnight: only ${moon.n} moon px on the pill`);
  if (Math.abs(moon.x - AW / 2) > 3) fail(`midnight moon at x=${moon.x.toFixed(1)}, want the middle`);
  if (moon.y > 4.5) fail(`midnight moon at y=${moon.y.toFixed(1)}, want the arc's apex (<=4)`);
  if (sunNight.n > 0) fail(`${sunNight.n} sun px still visible at midnight — the sun must be below the hills`);
  if (!(skyNight < skyDay * 0.5)) fail(`night sky luma ${skyNight.toFixed(1)} vs day ${skyDay.toFixed(1)}`);
  await shotClock("clock-night.png");
  console.log(`midnight OK (moon at apex, no sun, sky luma ${skyNight.toFixed(1)} vs day ${skyDay.toFixed(1)})`);

  // ---- 4. THE BELT — no hand-off, nothing to freeze. A hair either side of
  //         sunset (evening's end / night's start) the pill must draw
  //         essentially the same frame: the sun leaving on the right and the
  //         moon arriving on the left are ONE continuous motion. Same at
  //         sunrise. The old dial jumped its hand 180° here, which is why the
  //         server had to stop the world clock for 1.25s. ----
  await at(3, 0.999); // last instant of evening
  const beforeSunset = await pixels();
  await at(0, 0.001); // first instant of night
  const afterSunset = await pixels();
  await at(0, 0.999); // last instant of night
  const beforeSunrise = await pixels();
  await at(1, 0.001); // first instant of morning
  const afterSunrise = await pixels();
  // Control: a REAL step through time, to prove the metric can see a change.
  await at(2, 0.5);
  const noon = await pixels();
  await at(2, 0.75);
  const afterNoon = await pixels();

  const diff = (a, b) => page.evaluate(([x, y]) => window.__pillDiff(x, y), [a, b]);
  const dSunset = await diff(beforeSunset, afterSunset);
  const dSunrise = await diff(beforeSunrise, afterSunrise);
  const dControl = await diff(noon, afterNoon);
  if (dControl < 3) fail(`the diff metric is blind (a quarter-phase of DAY moved it only ${dControl.toFixed(2)})`);
  if (dSunset > 1.5) fail(`sunset JUMPS: mean pixel delta ${dSunset.toFixed(2)} across the boundary (want <1.5)`);
  if (dSunrise > 1.5) fail(`sunrise JUMPS: mean pixel delta ${dSunrise.toFixed(2)} across the boundary`);
  console.log(
    `belt continuity OK (sunset delta ${dSunset.toFixed(2)}, sunrise ${dSunrise.toFixed(2)}, ` +
      `control step ${dControl.toFixed(2)})`,
  );

  // The belt in motion around that boundary: the sun works its way right and
  // SINKS behind the hills, and the moon climbs out of them on the left.
  await at(3, 0.2);
  const setA = await body(SUN);
  await at(3, 0.6);
  const setB = await body(SUN);
  await at(3, 0.95);
  const setC = await body(SUN);
  if (!(setB.x > setA.x && setC.x > setB.x))
    fail(`evening sun went backwards (${setA.x.toFixed(1)} -> ${setB.x.toFixed(1)} -> ${setC.x.toFixed(1)})`);
  if (!(setB.y >= setA.y && setC.y >= setB.y))
    fail(`evening sun rose instead of setting (y ${setA.y} -> ${setB.y} -> ${setC.y})`);
  if (!(setC.n < setA.n * 0.7))
    fail(`evening sun not sinking behind the hills (${setA.n} -> ${setC.n} px still showing)`);
  await shotClock("clock-sunset.png");

  await at(0, 0.05);
  const riseA = await body(MOON);
  await at(0, 0.2);
  const riseB = await body(MOON);
  if (riseA.n < 1) fail("no moon just after sunset — it should be climbing out of the hills on the left");
  if (!(riseA.x < AW * 0.25)) fail(`the new moon entered at x=${riseA.x.toFixed(1)}, want the left edge`);
  if (!(riseB.x > riseA.x)) fail(`the moon went backwards (${riseA.x.toFixed(1)} -> ${riseB.x.toFixed(1)})`);
  if (!(riseB.y < riseA.y)) fail(`the moon sank instead of rising (y ${riseA.y} -> ${riseB.y})`);
  console.log(
    `belt motion OK (sun sets right x ${setA.x.toFixed(1)}->${setC.x.toFixed(1)}, ` +
      `${setA.n}->${setC.n} px above the hills; moon rises left ` +
      `x ${riseA.x.toFixed(1)}->${riseB.x.toFixed(1)}, ${riseA.n}->${riseB.n} px)`,
  );

  // ---- 5. clockStar(): the HUD echo of a world shooting star repaints the
  //         pill SYNCHRONOUSLY (no CSS animation to starve) ----
  await at(0, 0.5); // night — a streak reads loudest against the dark sky
  const star = await page.evaluate(() => {
    const before = window.__pill.px();
    window.__ml.star();
    return window.__pillDiff(before, window.__pill.px());
  });
  if (!(star > 0)) fail("a shooting star left no trace on the pill");
  console.log(`clockStar OK (repaint delta ${star.toFixed(3)})`);

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log("CLOCK OK — the sun and moon ride one continuous belt; no hand-off, no freeze");
  console.log("PASS");
} finally {
  await browser.close();
}
