// Verify jump animations: a standing jump plays "jump", a running jump plays
// "runjump", and the sprite returns to a ground gait after landing. Samples the
// local avatar's current animation key via __ml.anim() at the hop apex.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const URL = "http://localhost:5173/";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });

// Poll __ml.anim() for ~JUMP_MS and return the peak (non-ground) state seen.
async function sampleWhileJumping(page) {
  return page.evaluate(async () => {
    const seen = new Set();
    const t0 = performance.now();
    while (performance.now() - t0 < 520) {
      const a = window.__ml.anim();
      if (a) seen.add(a.split(":")[2]); // "anim:<uid>:<state>:<dir>" -> state
      await new Promise((r) => setTimeout(r, 20));
    }
    return [...seen];
  });
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
