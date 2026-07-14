// Verify jump animations: a standing jump plays "jump", a running jump plays
// "runjump", and the sprite returns to a ground gait after landing. Samples the
// local avatar's current animation key via __ml.anim() at the hop apex.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const URL = "http://localhost:5173/";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });

// Poll __ml.anim() across the jump window and return the states seen. Polls
// from the NODE side (one short evaluate per sample): a single long evaluate
// with setTimeout polling gets background-throttled to ~1Hz in headless and
// can miss the whole 500ms window (it sampled only the post-land idle).
async function sampleWhileJumping(page) {
  const seen = new Set();
  const t0 = Date.now();
  // Generous budget: each evaluate round-trip can cost 300ms+ here, and the
  // hop starts a server round-trip after the trigger — the window must catch
  // several samples inside the ~500ms jump no matter how the latency lands.
  while (Date.now() - t0 < 1400) {
    const a = await page.evaluate(() => window.__ml.anim());
    if (a) seen.add(a.split(":").at(-2)); // "anim:<uid>:<state>:<dir>" -> state
    await page.waitForTimeout(40);
  }
  return [...seen];
}

try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 25000 });
  await page.waitForTimeout(1500); // textures/anims load
  await page.bringToFront();
  await page.click("canvas");

  // 1) Standing jump: fire jump with no movement keys held.
  await page.evaluate(() => window.__ml.jump());
  const standing = await sampleWhileJumping(page);
  await page.waitForTimeout(400); // land + cooldown

  // 2) Running jump: hold Shift(run)+ArrowRight, then jump mid-run.
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(300); // reach run gait
  await page.evaluate(() => window.__ml.jump());
  const running = await sampleWhileJumping(page);
  await page.keyboard.up("ArrowRight");
  await page.keyboard.up("ShiftLeft");
  await page.waitForTimeout(500);
  const afterLand = await page.evaluate(() => window.__ml.anim()?.split(":")[2] ?? null);

  const result = { standing, running, afterLand };
  console.log("RESULT " + JSON.stringify(result));
  if (!standing.includes("jump")) throw new Error(`standing jump did not play 'jump' (saw ${standing})`);
  if (!running.includes("runjump")) throw new Error(`running jump did not play 'runjump' (saw ${running})`);
  if (afterLand === "jump" || afterLand === "runjump") throw new Error(`did not return to ground gait (stuck at ${afterLand})`);
  console.log("JUMP-ANIM OK");
} finally {
  await browser.close();
}
