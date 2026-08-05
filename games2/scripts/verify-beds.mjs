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

  // ---- 3+4. EVERY available bed loads, plays, ADVANCES, and owns the clock
  // Position advancing is the real test: a bed can be "active" while its
  // scheduler is dead, and that sounds exactly like silence. The clock matters
  // because tonal SFX scale-snap and beat-quantize read it — when the context
  // score replaced the catalog bed it would have gone dark without delegation.
  // Every bed is exercised, not just one: a single broken track (the 0.07 s
  // battle take) is exactly the kind of thing a one-bed spot check misses.
  for (const name of before.available) {
    const played = await page.evaluate(async (n) => {
      window.__ml.audioBed(n);
      // WAIT for readiness rather than assuming it: a bed is a ~1.7 MB fetch
      // plus a decode of up to two minutes of audio, and the largest bed
      // (adventure) does not make a fixed 3.5 s window on a cold cache. In the
      // game the catalog bed covers exactly this gap, by design.
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && window.__ml.audio().beds.active !== n)
        await new Promise((r) => setTimeout(r, 250));
      const a = window.__ml.audio().beds;
      const clock = window.__ml.audioClock();
      await new Promise((r) => setTimeout(r, 1500));
      return { a, b: window.__ml.audio().beds, clock };
    }, name);
    if (played.a.active !== name)
      fail(`bed ${name} never became audible within 20 s (active=${played.a.active})`);
    if (!(played.b.position > played.a.position))
      fail(`bed ${name} is not advancing (${played.a.position} → ${played.b.position}) — silent track?`);
    const c = played.clock;
    if (!c.playing) fail(`musical clock idle while ${name} plays`);
    if (!(c.bpm > 20)) fail(`bed ${name} has no tempo (bpm=${c.bpm})`);
    if (!Array.isArray(c.scale) || !c.scale.length)
      fail(`bed ${name} publishes no scale (tonal SFX would stop snapping)`);
    ok(`"${name}": advances ${played.a.position}s→${played.b.position}s, ` +
      `bpm ${c.bpm}, scale [${c.scale}]`);
  }

  // ---- 5. Releasing hands control back to the situation ------------------
  // Force a bed the situation does NOT want, then release and require it to
  // swing back. Auditioning whatever the situation already wanted would pass
  // whether the override cleared or stuck — the assertion has to be able to
  // tell those apart.
  const situation = before.wanted;
  const other = before.available.find((n) => n !== situation);
  if (!other) fail("need two beds to test the audition release");
  const after = await page.evaluate(async (n) => {
    window.__ml.audioBed(n);
    await new Promise((r) => setTimeout(r, 1200));
    const forced = window.__ml.audio().beds.wanted;
    window.__ml.audioBed();
    await new Promise((r) => setTimeout(r, 1500));
    return { forced, released: window.__ml.audio().beds.wanted };
  }, other);
  if (after.forced !== other) fail(`audition did not take (wanted=${after.forced}, asked ${other})`);
  if (after.released === other && situation !== other)
    fail(`release left the override in place (still ${after.released})`);
  ok(`release OK (forced "${other}" → back to "${after.released ?? "none"}", situation wanted "${situation}")`);

  console.log("verify-beds: ALL OK");
} finally {
  await browser.close();
}
