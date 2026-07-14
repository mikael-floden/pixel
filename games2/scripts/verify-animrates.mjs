// Verify the anti-moonwalk gait playback: every walk/run clip is built at the
// measured per-gait fps from characters.json (gaitFps — ONE cadence per gait,
// all 8 directions), non-gait clips keep their static defaults, and the LIVE
// rate ∝ speed scaling works: while keyboard-walking, anims.timeScale tracks
// the avatar's actual on-screen speed / WALK_SPEED (≈1 at full speed).
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const DIRS = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
try {
  // Small viewport: big headless-GL viewports starve the frame loop (HARNESS
  // STARVED) and the timeScale samples would measure the harness, not the game.
  const ctx = await browser.newContext({ viewport: { width: 480, height: 320 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });

  const manifest = await (await fetch("http://localhost:5173/characters.json")).json();
  let bad = 0;
  for (const def of manifest.characters) {
    for (const gait of ["walk", "run"]) {
      const want = def.gaitFps?.[gait];
      if (!want) {
        console.log(`MISSING gaitFps ${def.uid}.${gait}`);
        bad++;
        continue;
      }
      for (const dir of DIRS) {
        const got = await page.evaluate(
          ({ uid, gait, dir }) => window.__ml.animRate(uid, gait, dir),
          { uid: def.uid, gait, dir },
        );
        if (got === null || Math.abs(got - want) > 0.11) {
          console.log(`MISMATCH ${def.uid} ${gait} ${dir}: gaitFps=${want} anim=${got}`);
          bad++;
        }
      }
    }
  }
  // Non-gait clips stay at their static defaults.
  const idle = await page.evaluate(() => window.__ml.animRate("default_boy", "idle", "south"));
  const jump = await page.evaluate(() => window.__ml.animRate("default_boy", "jump", "south"));

  // Live rate ∝ speed: hold a walk for ~1.2s, then sample timeScale + the
  // EMA'd screen speed. At full walking speed timeScale ≈ speed/WALK_SPEED ≈ 1
  // (loose bounds: headless frame pacing wobbles the EMA a little).
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(1200);
  const live = await page.evaluate(() => ({
    ts: window.__ml.timeScale(),
    spd: window.__ml.screenSpeed(),
    anim: window.__ml.anim(),
  }));
  await page.keyboard.up("ArrowRight");
  const walking = typeof live.anim === "string" && live.anim.includes(":walk:");
  const tsOk = walking && live.ts !== null && live.ts >= 0.6 && live.ts <= 1.4;
  const spdOk = live.spd !== null && live.spd > 40;
  if (!tsOk || !spdOk) {
    console.log(`LIVE timeScale check failed: ${JSON.stringify(live)}`);
    bad++;
  }
  console.log(
    `gait rates: all chars x walk/run x 8 dirs; idle=${idle} (want 6), jump=${jump} (want 18), ` +
      `live walk timeScale=${live.ts?.toFixed?.(2)} spd=${live.spd?.toFixed?.(1)}px/s, mismatches=${bad}`,
  );
  if (bad || idle !== 6 || jump !== 18) throw new Error("anim rates wrong");
  console.log("ANIM-RATES OK");
} finally {
  await browser.close();
}
