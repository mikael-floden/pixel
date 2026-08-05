// Ambient VISUAL QA in the maintainer's REAL phone view.
//
// The maintainer's phone is DESKTOP-SITE layout on a phone screen — a
// DIFFERENT geometry from the small 480x320 movement-timing viewport
// (verify-ambient.mjs / verify-smoke). Screenshots taken at 480x320 do not
// look like the phone at all (wrong HUD, wrong zoom, wrong sky framing), so
// LOOK-AND-FEEL checks for ambient effects MUST render here. See games2/
// CLAUDE.md "HUD / visual QA runs in the maintainer's REAL phone view".
//
// Needs a running dev stack (npm run dev). Usage:
//   node ambient/scripts/shoot-phone.mjs <effect> [phase] [weather] [out.png]
//     effect   an ambient name (birds|bats|leaves|…), "auto", or "none"
//     phase    night|morning|day|evening           (default day)
//     weather  a WEATHER index, e.g. 0 clear       (default 0)
//     out.png  screenshot path            (default scratchpad/phone-<effect>.png)
// Example: node ambient/scripts/shoot-phone.mjs birds day 0 /tmp/birds.png
import pw from "playwright-core";
const { chromium } = pw;

const [effect = "auto", phase = "day", weatherArg = "0", out] = process.argv.slice(2);
const weather = Number(weatherArg) || 0;
const outPath = out || `phone-${effect}.png`;
const URL = process.env.URL || "http://localhost:5173/";
const EXE = process.env.CHROMIUM || "/opt/pw-browsers/chromium";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
// The maintainer's real phone: desktop-site layout on a phone screen.
const ctx = await browser.newContext({
  viewport: { width: 980, height: 2123 },
  screen: { width: 393, height: 851 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
});
try {
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: "load" });
  await p.waitForFunction(() => window.__mlSelect, null, { timeout: 30000 });
  await p.evaluate(() => window.__mlSelect.commit());
  await p.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 40000 });
  await p.waitForFunction(() => window.__mlAmbient, null, { timeout: 15000 });
  const geo = await p.evaluate(() => ({ innerWidth: window.innerWidth, screenWidth: window.screen.width, camZoom: window.__ml.camZoom?.() }));
  console.log("phone geometry:", JSON.stringify(geo)); // expect innerWidth 980, screenWidth 393, camZoom 2

  await p.evaluate(
    ({ phase, weather, effect }) => {
      window.__ml.timeOfDay(phase, true);
      window.__ml.weather(weather, true);
      window.__mlAmbient.demo(effect);
    },
    { phase, weather, effect },
  );

  // Episodes fly a flock every so often; the big viewport starves to ~3fps, so
  // poll patiently and shoot the frame with the most in flight.
  let best = -1;
  for (let i = 0; i < 90; i++) {
    await p.waitForTimeout(350);
    const dbg = await p.evaluate((n) => window.__mlAmbient.debug(n), effect);
    const n = dbg.inFlight ?? dbg.count ?? 0;
    if (n > best) {
      best = n;
      await p.screenshot({ path: outPath });
    }
    if (n >= 4) break;
  }
  console.log(`shot ${outPath} (effect=${effect} phase=${phase} weather=${weather}, best population ${best})`);
} finally {
  await browser.close();
}
