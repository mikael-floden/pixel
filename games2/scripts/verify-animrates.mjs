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

  // Live rate ∝ WORLD speed: the reference is the side-view world speed,
  // WALK_SPEED·√½ ≈ 49.5wu/s, so timeScale must equal worldSpeed/49.5 at any
  // actual pace (starvation-independent). Walking screen-north covers ~2.13×
  // the world ground of east at the same screen speed — its timeScale must
  // follow (the "N/S walk plays too slow" fix). Consistency is asserted per
  // heading whenever the avatar genuinely moved (spd > 25wu/s).
  const REF = 70 * Math.SQRT1_2;
  const liveOut = [];
  for (const [key, name] of [["ArrowRight", "east"], ["ArrowUp", "north"]]) {
    await page.keyboard.down(key);
    await page.waitForTimeout(1200);
    const live = await page.evaluate(() => ({
      ts: window.__ml.timeScale(),
      spd: window.__ml.worldSpeed(),
      anim: window.__ml.anim(),
    }));
    await page.keyboard.up(key);
    await page.waitForTimeout(300);
    const walking = typeof live.anim === "string" && live.anim.includes(":walk:");
    if (!walking || live.ts === null || live.spd === null) {
      console.log(`LIVE ${name}: no walk sample (${JSON.stringify(live)})`);
      bad++;
      continue;
    }
    if (live.spd > 25) {
      const want = Math.min(2.6, Math.max(0.4, live.spd / REF));
      if (Math.abs(live.ts - want) > Math.max(0.15, want * 0.15)) {
        console.log(`LIVE ${name}: timeScale=${live.ts.toFixed(2)} but worldSpeed/REF=${want.toFixed(2)}`);
        bad++;
      }
    } else console.log(`LIVE ${name}: too slow to judge (${live.spd.toFixed(1)}wu/s) — skipped`);
    liveOut.push(`${name} ts=${live.ts.toFixed(2)} spd=${live.spd.toFixed(1)}wu/s`);
  }
  console.log(
    `gait rates: all chars x walk/run x 8 dirs; idle=${idle} (want 6), jump=${jump} (want 18), ` +
      `live: ${liveOut.join(", ")}, mismatches=${bad}`,
  );
  if (bad || idle !== 6 || jump !== 18) throw new Error("anim rates wrong");
  console.log("ANIM-RATES OK");
} finally {
  await browser.close();
}
