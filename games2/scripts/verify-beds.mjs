// The CONTEXT SCORE, end to end in the real client (composer/engine/contextMusic.ts).
//
// bedSelect.test.ts already pins the DECISION table as pure logic. What this
// gate covers is everything that only exists in a browser: the world sampler
// actually produces the signals the score reads, a bed really loads/plays/
// advances, it owns the musical clock while it does, and control returns to
// the situation afterwards. Needs a dev stack (npm run dev).
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const WORLD = process.env.WORLD || "the_island2";

const fail = (m) => {
  throw new Error(m);
};
const ok = (m) => console.log(`  ${m}`);

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30000 });
  const idx = await page.evaluate(
    (re) => window.__mlSelect.worlds().findIndex((w) => new RegExp(re, "i").test(w)),
    WORLD,
  );
  if (idx >= 0) await page.evaluate((i) => window.__mlSelect.pickWorld(i), idx);
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml?.players?.() > 0, null, { timeout: 60000 });
  await page.waitForTimeout(4000);

  // ---- 1. The world sampler feeds the score ------------------------------
  const field = await page.evaluate(() => window.__ml.audioField());
  for (const k of ["forest", "water", "town", "fire", "cave", "threat"]) {
    if (typeof field[k] !== "number" || Number.isNaN(field[k]))
      fail(`field.${k} is not a number (${JSON.stringify(field)})`);
    if (field[k] < 0 || field[k] > 1) fail(`field.${k} out of 0..1: ${field[k]}`);
  }
  ok(`field OK (${Object.entries(field).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ")})`);

  // ---- 2. Availability is honest ----------------------------------------
  const before = await page.evaluate(() => window.__ml.audio().beds);
  if (!Array.isArray(before.available)) fail("beds.available missing");
  if (!before.available.length) fail("no music beds bundled at all");
  ok(`beds available: ${before.available.join(", ")}`);

  // ---- 3. An available bed loads, plays, and ADVANCES --------------------
  // Position advancing is the real test: a bed can be "active" while its
  // scheduler is dead, and that sounds exactly like silence.
  const pick = before.available[0];
  const played = await page.evaluate(async (name) => {
    window.__ml.audioBed(name);
    await new Promise((r) => setTimeout(r, 3500));
    const a = window.__ml.audio().beds;
    const clock = window.__ml.audioClock();
    await new Promise((r) => setTimeout(r, 1500));
    return { a, b: window.__ml.audio().beds, clock };
  }, pick);
  if (played.a.active !== pick) fail(`audition ${pick}: active=${played.a.active}`);
  if (!(played.b.position > played.a.position))
    fail(`bed ${pick} is not advancing (${played.a.position} → ${played.b.position})`);
  ok(`bed "${pick}" plays and advances (${played.a.position}s → ${played.b.position}s)`);

  // ---- 4. The playing bed owns the musical clock -------------------------
  // Tonal SFX scale-snap and beat-quantize read this; when the context score
  // replaced the catalog bed it would have gone dark without the delegation.
  const c = played.clock;
  if (!c.playing) fail("musical clock idle while a bed is playing");
  if (!(c.bpm > 20)) fail(`clock has no tempo (bpm=${c.bpm})`);
  if (!Array.isArray(c.scale) || !c.scale.length)
    fail(`clock publishes no scale (tonal SFX would stop snapping): ${JSON.stringify(c.scale)}`);
  ok(`clock OK (bpm=${c.bpm}, section=${c.section}, scale=[${c.scale}])`);

  // ---- 5. Releasing hands control back to the situation ------------------
  const after = await page.evaluate(async () => {
    window.__ml.audioBed();
    await new Promise((r) => setTimeout(r, 1500));
    return window.__ml.audio().beds;
  });
  if (after.wanted === pick && before.wanted !== pick)
    fail(`release left the audition override in place (wanted=${after.wanted})`);
  ok(`release OK (wanted=${after.wanted ?? "situation"})`);

  console.log("verify-beds: ALL OK");
} finally {
  await browser.close();
}
