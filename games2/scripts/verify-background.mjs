// Background audio behavior (maintainer 2026-08-05): when the page hides,
// (1) the MASTER ducks to half volume, and (2) the score keeps playing — the
// crossfade scheduler (setTimeout-armed, throttled/frozen in background tabs)
// hands off to ONE native-looping source at the measured loop points, then
// takes back over at the same song position on return. Needs a dev stack.
//
// The tab is "hidden" by overriding document.hidden/visibilityState and
// dispatching visibilitychange — the same signal the engine listens to.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const fail = (m) => { throw new Error(m); };
const ok = (m) => console.log(`  ${m}`);

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader", "--mute-audio",
    // The point of the native handoff is surviving timer throttling; disable
    // nothing here — but headless doesn't throttle anyway, so the gate proves
    // the CODE PATH (handoff + position continuity), not Chrome's policy.
  ],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 30000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml?.players?.() > 0, null, { timeout: 60000 });
  // The score streams in lazily — wait for the clock to actually run.
  await page.waitForFunction(() => window.__ml.audioClock().playing, null, { timeout: 45000 });

  const setHidden = (hidden) => page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { get: () => h, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => (h ? "hidden" : "visible"), configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

  const snap = () => page.evaluate(() => {
    const d = window.__ml.audio();
    return { master: d.master, bg: d.music?.backgroundLoop, live: d.music?.liveSources,
             pos: d.music?.position, playing: d.music?.playing };
  });

  const before = await snap();
  if (before.bg) fail("backgroundLoop active while visible");
  ok(`visible baseline: master=${before.master} live=${before.live} pos=${before.pos}`);

  // ---- hide: duck + native handoff ----------------------------------------
  await setHidden(true);
  await page.waitForTimeout(1800); // ease (tau .25) + handoff arming
  const hidden1 = await snap();
  if (!(hidden1.master < 0.62)) fail(`master did not duck (${hidden1.master}, want →0.5)`);
  if (!hidden1.bg) fail("no native background loop after hide");
  ok(`hidden: master=${hidden1.master} (→0.5), native loop armed`);

  // The score must keep ADVANCING while hidden (the actual complaint).
  await page.waitForTimeout(2500);
  const hidden2 = await snap();
  if (!(hidden2.pos !== hidden1.pos)) fail(`score frozen while hidden (pos ${hidden1.pos})`);
  if (!hidden2.playing) fail("clock stopped while hidden");
  ok(`hidden: score advancing (${hidden1.pos}s → ${hidden2.pos}s)`);

  // ---- show: duck released, scheduler resumes at the same position --------
  await setHidden(false);
  await page.waitForTimeout(1800);
  const after = await snap();
  if (after.bg) fail("native loop still active after return");
  if (!(after.master > 0.85)) fail(`master did not recover (${after.master})`);
  if (!(after.live >= 1)) fail("crossfade scheduler did not resume");
  // Continuity: position keeps counting from the background position, no
  // restart-from-zero (the maintainer's standing never-restart rule).
  if (!(Math.abs(after.pos - hidden2.pos) < 8)) fail(`position jumped (${hidden2.pos} → ${after.pos})`);
  ok(`visible again: master=${after.master}, scheduler live=${after.live}, pos continuous (${hidden2.pos}→${after.pos})`);

  // ---- phase 2: the REAL handoff — native loop actually running ----------
  // Hide long enough for the current pass to end so the native source takes
  // over (that moment is exactly where the music used to DIE), then return
  // and require the scheduler to resume from the native position.
  const loop = (await page.evaluate(() => window.__ml.audio().music.loop)) ?? {};
  const posNow = (await snap()).pos;
  const waitS = Math.ceil(Math.max(2, (loop.end ?? 0) - posNow) + 3);
  if (waitS > 150) {
    console.log(`  phase 2 skipped: handoff ${waitS}s away (cap 150s)`);
  } else {
    await setHidden(true);
    console.log(`  phase 2: hiding ${waitS}s so the pass ends and the native loop takes over…`);
    await page.waitForTimeout(waitS * 1000);
    const running = await snap();
    if (!(await page.evaluate(() => window.__ml.audio().music.backgroundRunning)))
      fail("native loop never took over after the pass ended");
    await page.waitForTimeout(2000);
    const running2 = await snap();
    if (!(running2.pos !== running.pos)) fail(`native loop frozen (pos ${running.pos})`);
    ok(`native loop RUNNING and advancing (${running.pos}s → ${running2.pos}s) — the old death moment, survived`);
    await setHidden(false);
    await page.waitForTimeout(1800);
    const back = await snap();
    if (back.bg) fail("native loop still active after phase-2 return");
    if (!(back.live >= 1)) fail("scheduler did not resume after phase-2 return");
    const span = Math.max(1, (loop.end ?? 1) - (loop.start ?? 0));
    let delta = Math.abs(back.pos - running2.pos);
    delta = Math.min(delta, Math.abs(span - delta)); // wrap-tolerant
    if (!(delta < 10)) fail(`phase-2 position jumped (${running2.pos} → ${back.pos})`);
    ok(`phase 2: resumed continuously at ${back.pos}s (native was at ${running2.pos}s)`);
  }

  console.log("verify-background: ALL OK");
} finally {
  await browser.close();
}
