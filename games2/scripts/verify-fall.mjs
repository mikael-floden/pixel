// Regression guard for the "walk off a ledge FALLS, not teleports" change.
//
// The cliff-fall MATH (gravity descent / snap-up / stairs-ease) is unit-tested
// deterministically in server/test/collision.test.ts via the shared
// `integrateFall`. This browser pass guards the runtime wiring: driving the
// real client, (1) no page errors, (2) the authoritative anchor never TELEPORTS
// (the old code snapped ~2×PLAYER_RADIUS forward at a ledge — the very bug we
// removed), and (3) the per-avatar fall state stays finite. If the walker
// happens to step off a real ledge, the gravity descent is asserted too.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const WORLD = process.env.WORLD || "ring_test";
const CELL = 32;
const TELEPORT_LIMIT = 28; // one 20Hz run-step is well under a cell; a ledge snap was ~24–32u

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message)); // real JS exceptions
  // Ignore benign network 404s (a missing tile/favicon) — only flag JS console errors.
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|404/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`http://localhost:5173/#${WORLD}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 25000 });
  await page.waitForTimeout(1200);
  await page.bringToFront();
  await page.click("canvas");

  // Walk each direction, sampling the authoritative position + fall state every
  // frame. Record the biggest one-frame move and any gravity-fall episode.
  const dirs = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"];
  let maxJump = 0;
  let fallEpisode = null;
  let badFallState = false;
  for (const d of dirs) {
    await page.keyboard.down(d);
    const r = await page.evaluate(async () => {
      let maxj = 0,
        last = null,
        cur = null,
        best = null,
        bad = false;
      const t0 = performance.now();
      while (performance.now() - t0 < 3500) {
        const me = window.__ml.me();
        const f = window.__ml.fall();
        if (me && last) maxj = Math.max(maxj, Math.hypot(me.x - last.x, me.y - last.y));
        if (me) last = { x: me.x, y: me.y };
        if (f) {
          if (!Number.isFinite(f.elev) || !Number.isFinite(f.fallV)) bad = true;
          if (f.falling) (cur ??= []).push(+f.elev.toFixed(2));
          else if (cur) {
            if (!best || cur.length > best.length) best = cur;
            cur = null;
          }
        }
        await new Promise((r) => setTimeout(r, 16));
      }
      if (cur && (!best || cur.length > best.length)) best = cur;
      return { maxj, best, bad };
    });
    await page.keyboard.up(d);
    maxJump = Math.max(maxJump, r.maxj);
    badFallState ||= r.bad;
    if (r.best && r.best.length > (fallEpisode?.length ?? 0)) fallEpisode = r.best;
  }

  await page.screenshot({ path: process.env.OUT || "/tmp/fall_smoke.png" });

  const result = {
    world: WORLD,
    pageErrors: errors.length,
    maxAuthoritativeMovePerFrame: +maxJump.toFixed(1),
    fallStateFinite: !badFallState,
    fallObserved: !!fallEpisode,
    fallFrames: fallEpisode?.length ?? 0,
  };
  console.log("RESULT " + JSON.stringify(result));

  if (errors.length) throw new Error(`page errors: ${errors.slice(0, 3).join(" | ")}`);
  if (badFallState) throw new Error("fall state went non-finite (NaN elev/velocity)");
  if (maxJump > TELEPORT_LIMIT) throw new Error(`anchor teleported ${maxJump}u in one frame (ledge snap regressed)`);
  // Bonus: if a real fall happened, it must be an animated gravity descent.
  if (fallEpisode) {
    const distinct = new Set(fallEpisode);
    if (distinct.size < 2) throw new Error("a fall was observed but not animated (looks like a snap)");
    for (let i = 1; i < fallEpisode.length; i++)
      if (fallEpisode[i] > fallEpisode[i - 1] + 1e-6) throw new Error("elevation rose mid-fall");
    console.log("FALL-ANIM observed + verified");
  } else {
    console.log("(no reachable ledge in this world — fall math covered by unit tests)");
  }
  console.log("FALL-SMOKE OK");
} finally {
  await browser.close();
}
