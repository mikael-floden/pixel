// Every semantic event the game can emit, fired at the engine, asserting which
// ones make a sound. Guards the maintainer's standing rule: a sound plays only
// when it was asked for (2026-08-05 "I don't tell you to add dumb sound").
// Needs a dev stack (npm run dev).
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";

// Everything the combat/loot work (410a17f8e) started emitting. None asked for.
const MUST_BE_SILENT = ["tool.sword_swing", "combat.hit_taken", "item.get", "progress.level_up"];
// Approved in their own rounds, long before the combat work.
const MUST_STILL_SOUND = ["ui.press", "ui.release", "ui.notify"];

const fail = (m) => { throw new Error(m); };
const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml?.players?.() > 0, null, { timeout: 60000 });
  await page.waitForTimeout(4000);

  // Fire each event several times; `played` counts what actually STARTED.
  const probe = async (name) =>
    page.evaluate(async (n) => {
      const before = window.__ml.audio().played;
      for (let i = 0; i < 5; i++) {
        window.__ml.audioEvent(n);
        await new Promise((r) => setTimeout(r, 120)); // clear the 30 ms debounce
      }
      await new Promise((r) => setTimeout(r, 500));
      return window.__ml.audio().played - before;
    }, name);

  for (const name of MUST_BE_SILENT) {
    const n = await probe(name);
    if (n !== 0) fail(`${name} played ${n} sound(s) — it must be silent`);
    console.log(`  silent: ${name}`);
  }
  for (const name of MUST_STILL_SOUND) {
    const n = await probe(name);
    if (n < 1) fail(`${name} played nothing — the mute is too broad`);
    console.log(`  sounds: ${name} (${n})`);
  }
  console.log("verify-quiet: ALL OK");
} finally {
  await browser.close();
}
