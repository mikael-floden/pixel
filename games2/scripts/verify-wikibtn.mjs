// The IN-GAME WIKI BUTTON (maintainer 2026-08-13): "the wiki button should be
// the same size as the time-of-day pill and be rendered over/under it and
// move if it moves … the player comes back to where in the wiki the player
// was when the player closes the wiki and opens it again."
//
// What this pins, and why each check is shaped the way it is:
//   1. SIZE AND STACK against the REAL pill's rect — never against the
//      button's own constants, which would let the two drift apart the day
//      the pill is resized.
//   2. The three placements from the maintainer's red circles: ABOVE the
//      pill in portrait and left-handed landscape (the pill hugs the bottom
//      edge), BELOW it in right-handed landscape (the pill parks under the
//      XP chip there — its corner belongs to the thumb stick).
//   3. The KEYBOARD RIDE: hud.ts lifts the pill over the phone keyboard via
//      :root.ml-kb-up — the button must hold its 10px gap through the lift.
//      The class+var are set directly (the real focus→lift path is
//      verify-chatpage's subject); what this asserts is the CSS chain.
//   4. THE FREEZE (maintainer 2026-08-13: "the wiki lags a bit when opened on
//      top of the game — can you freeze or pause the game rendering when the
//      wiki is open?"). Asserted on Phaser's OWN step counter, which is the
//      one number that cannot claim a loop stopped when it didn't — plus the
//      outcome it exists for, the frames the wiki's document actually gets.
//   5. THE SPOT: open the wiki, navigate + scroll, close, reopen — same
//      page, same scroll. Read through the iframe (same origin).
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => {
  console.log("FAIL:", m);
  bad = true;
};
const ok = (m) => console.log("ok:", m);

const ctx = await browser.newContext({
  viewport: { width: 393, height: 851 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

/** Rects of the pill + button, settle-polled (their anchors transition). */
const rects = async () => {
  let prev = "";
  for (let i = 0; i < 40; i++) {
    const now = await page.evaluate(() => {
      const r = (s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
      };
      return JSON.stringify({ pill: r(".ml-clock"), btn: r(".ml-wikibtn") });
    });
    if (now === prev) return JSON.parse(now);
    prev = now;
    await page.waitForTimeout(120);
  }
  return JSON.parse(prev);
};

const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

/** The stack invariant: same box, same right edge, 10px gap on `side`. */
const assertStack = (g, side, label) => {
  if (!g.pill || !g.btn) return fail(`${label}: missing ${!g.pill ? "pill" : "button"}`);
  near(g.btn.w, g.pill.w) && near(g.btn.h, g.pill.h)
    ? ok(`${label}: button is pill-sized (${g.btn.w}x${g.btn.h} vs ${g.pill.w}x${g.pill.h})`)
    : fail(`${label}: size mismatch — button ${g.btn.w}x${g.btn.h}, pill ${g.pill.w}x${g.pill.h}`);
  near(g.btn.r, g.pill.r)
    ? ok(`${label}: right edges aligned (${g.btn.r.toFixed(1)})`)
    : fail(`${label}: right edges differ (button ${g.btn.r}, pill ${g.pill.r})`);
  const gap = side === "above" ? g.pill.t - g.btn.b : g.btn.t - g.pill.b;
  near(gap, 10, 2)
    ? ok(`${label}: ${side} the pill with the 10px gap (${gap.toFixed(1)})`)
    : fail(`${label}: wanted ${side} the pill at 10px, gap is ${gap.toFixed(1)} (btn ${g.btn.t.toFixed(0)}..${g.btn.b.toFixed(0)}, pill ${g.pill.t.toFixed(0)}..${g.pill.b.toFixed(0)})`);
};

const frameSel = ".ml-wikipanel iframe";
const wiki = () => page.frames().find((f) => f.url().includes("/assets/wiki/"));
/** `readyState complete` is NOT "the wiki is on screen": the app fetches
 * data.json and renders after the document loads. On a first, uncached open
 * the two are far enough apart to hide it; on a later one the document is
 * complete in a few ms and a query for the wiki's own markup finds an empty
 * shell. Anything reading the wiki's CONTENT must wait for the content. */
const frameReady = async (needNav = false) => {
  await page.waitForFunction(
    () => {
      const f = document.querySelector(".ml-wikipanel iframe");
      return f && f.contentDocument && f.contentDocument.readyState === "complete";
    },
    null,
    { timeout: 20000 },
  );
  if (!needNav) return;
  await wiki().waitForFunction(
    () => [...document.querySelectorAll('a[href^="#/"]')].some((a) => a.getAttribute("href").length > 3),
    null,
    { timeout: 20000 },
  );
};

try {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });

  // ── 0. the drawer opens with NO GAME BEHIND IT ─────────────────────────
  // The select screen has its own wiki button and no Phaser game at all, so
  // the freeze has nothing to freeze. It must no-op, not throw — the whole
  // pre-game half of the app runs through this path.
  await page.click("#ml-wiki");
  await page.waitForSelector(frameSel, { timeout: 10000 });
  await page.evaluate(() => document.querySelector(".ml-wikiback")?.click());
  await page.waitForFunction(() => !document.querySelector(".ml-wikiroot"), null, { timeout: 5000 });
  errors.length === 0
    ? ok("the wiki opens on the select screen, with no game to freeze")
    : fail(`opening the wiki before the game exists threw: ${errors.join(" | ")}`);

  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 40000 });
  await page.waitForFunction(() => !!document.querySelector(".ml-clock"), null, { timeout: 20000 });

  // ── 1. portrait: pill-sized, stacked ABOVE ─────────────────────────────
  assertStack(await rects(), "above", "portrait");

  // ── 2. the keyboard ride: both lift, the gap survives ──────────────────
  const before = await rects();
  // A TALL keyboard, so the movement is unambiguous. The rest anchor is
  // above the 325px HUD and the lift anchor is inputlift+56, so a small
  // inputlift moves the stack DOWN (120px read as "broke the stack" on the
  // first run, with the two moving together perfectly) and 320px rises only
  // 41px. What is under test is that they move AS ONE, whatever the size.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--ml-inputlift", "430px");
    document.documentElement.classList.add("ml-kb-up");
  });
  await page.waitForTimeout(400);
  const lifted = await rects();
  const pillRose = before.pill.b - lifted.pill.b;
  const btnRose = before.btn.b - lifted.btn.b;
  pillRose > 60 && near(btnRose, pillRose, 2)
    ? ok(`keyboard lift: the stack rides together (pill +${pillRose.toFixed(0)}px, button +${btnRose.toFixed(0)}px)`)
    : fail(`keyboard lift broke the stack (pill rose ${pillRose.toFixed(0)}, button ${btnRose.toFixed(0)})`);
  near(lifted.pill.t - lifted.btn.b, 10, 2)
    ? ok("keyboard lift: the 10px gap survives")
    : fail(`gap while lifted: ${(lifted.pill.t - lifted.btn.b).toFixed(1)}px`);
  await page.evaluate(() => {
    document.documentElement.classList.remove("ml-kb-up");
    document.documentElement.style.removeProperty("--ml-inputlift");
  });

  // ── 3. THE FREEZE: the loop sleeps for as long as the drawer is up ─────
  await page.evaluate(() => localStorage.removeItem("ml-wiki-spot"));
  await page.click(".ml-wikibtn");
  await page.waitForSelector(frameSel, { timeout: 10000 });
  await frameReady();
  const f0 = await page.evaluate(() => window.__mlFreeze.frame());
  await page.waitForTimeout(1500);
  const held = await page.evaluate(() => ({
    frozen: window.__mlFreeze.frozen(),
    running: window.__mlFreeze.running(),
    frame: window.__mlFreeze.frame(),
    players: window.__ml.players(),
  }));
  // Phaser's own step counter, not our flag: a loop that claims to be asleep
  // and still steps would pass a `frozen === true` check and fail this one.
  held.frozen && !held.running && held.frame === f0
    ? ok(`the game loop is asleep while the drawer is up (0 frames in 1.5s)`)
    : fail(`the loop kept running: frozen=${held.frozen} running=${held.running} frames=${held.frame - f0}`);
  // Freezing is not disconnecting. The socket is event-driven, so the room
  // must be exactly as alive as it was — a freeze that dropped the player
  // would be a far worse bug than the stutter it fixes.
  held.players >= 1
    ? ok(`the room is untouched by the freeze (${held.players} player(s))`)
    : fail(`the room dropped while frozen (players ${held.players})`);
  // …and the point of all of it: the wiki's own document gets the main
  // thread. With the loop asleep nothing competes, so this should sit near
  // vsync; the floor is low enough to survive a loaded box.
  const wikiFps = await wiki().evaluate(
    () =>
      new Promise((res) => {
        let n = 0;
        const t0 = performance.now();
        const tick = (t) => {
          n++;
          if (t - t0 < 1500) requestAnimationFrame(tick);
          else res((n / (t - t0)) * 1000);
        };
        requestAnimationFrame(tick);
      }),
  );
  wikiFps >= 25
    ? ok(`the wiki gets the thread back (${wikiFps.toFixed(0)} fps in its own document)`)
    : fail(`the wiki is still starved at ${wikiFps.toFixed(1)} fps — is the loop really asleep?`);
  await page.evaluate(() => document.querySelector(".ml-wikiback")?.click());
  await page.waitForFunction(() => !document.querySelector(".ml-wikiroot"), null, { timeout: 5000 });
  const woke = await page.evaluate(() => ({
    frozen: window.__mlFreeze.frozen(),
    running: window.__mlFreeze.running(),
    frame: window.__mlFreeze.frame(),
    cool: window.__mlGame.loop._coolDown,
  }));
  woke.running && !woke.frozen && woke.frame > held.frame
    ? ok(`closing wakes the loop (${woke.frame - held.frame} frames by the time the drawer is gone)`)
    : fail(`the loop did not wake: frozen=${woke.frozen} running=${woke.running} frames=${woke.frame - held.frame}`);
  // THE FIRST FRAME BACK MUST NOT BE BILLED FOR THE READ. `TimeStep.resume()`
  // is the obvious call here and it is the wrong one: it arms Phaser's
  // backgrounded-tab recovery, `_coolDown = panicMax`, which clamps every
  // delta to the 16.7ms target for the next 120 FRAMES — measured as 16.7ms
  // of game time per 167ms of real time, and a player who walked 20wu where
  // an unfrozen one walked 151. gamefreeze.ts moves `lastTime` instead.
  // (Phaser arms the same cooldown from its own window-FOCUS handler, so this
  // is asserted after a scripted close, which never leaves the parent window.)
  woke.cool <= 0
    ? ok("waking does not arm Phaser's panic cooldown (no slow motion on the way back)")
    : fail(`the thaw armed the panic cooldown (_coolDown ${woke.cool}) — the world will run slow for ${woke.cool} frames`);

  // ── 4. the SPOT: navigate, scroll, close, reopen ───────────────────────
  // Start from no remembered spot — section 3's own close saved one.
  await page.evaluate(() => localStorage.removeItem("ml-wiki-spot"));
  await page.click(".ml-wikibtn");
  await frameReady(true);
  // pick a real route off the wiki's own nav, then scroll partway down
  const target = await wiki().evaluate(() => {
    const a = [...document.querySelectorAll('a[href^="#/"]')].find((x) => x.getAttribute("href").length > 3);
    if (!a) return null;
    const href = a.getAttribute("href");
    location.hash = href;
    return href;
  });
  if (!target) fail("no #/ route found in the wiki to navigate to");
  // let the route render, then scroll to a spot that exists
  await page.waitForTimeout(1200);
  const scrolled = await wiki().evaluate(() => {
    const max = (document.scrollingElement?.scrollHeight ?? 0) - innerHeight;
    const want = Math.min(Math.max(0, max), 400);
    scrollTo(0, want);
    return want;
  });
  await page.waitForTimeout(300);
  // close by tapping the game strip (the back layer)
  await page.evaluate(() => document.querySelector(".ml-wikiback")?.click());
  await page.waitForFunction(() => !document.querySelector(".ml-wikiroot"), null, { timeout: 5000 });
  const spot = await page.evaluate(() => JSON.parse(localStorage.getItem("ml-wiki-spot") || "null"));
  spot && spot.hash === target && near(spot.scroll, scrolled, 40)
    ? ok(`closing saves the spot (${spot.hash} @ ${spot.scroll}px)`)
    : fail(`saved spot wrong: ${JSON.stringify(spot)} (wanted ${target} @ ~${scrolled})`);

  // reopen: same page, same scroll
  await page.click(".ml-wikibtn");
  await frameReady();
  let back = null;
  for (let i = 0; i < 30; i++) {
    back = await wiki().evaluate(() => ({ hash: location.hash, scroll: Math.round(scrollY) }));
    if (back.hash === target && near(back.scroll, scrolled, 40)) break;
    await page.waitForTimeout(200);
  }
  back && back.hash === target
    ? ok(`reopening returns to the page (${back.hash})`)
    : fail(`reopened on ${back?.hash}, wanted ${target}`);
  back && (scrolled === 0 || near(back.scroll, scrolled, 40))
    ? ok(`…and to the reading position (${back.scroll}px of ${scrolled})`)
    : fail(`reopened at scroll ${back?.scroll}, wanted ~${scrolled}`);
  await page.evaluate(() => document.querySelector(".ml-wikiback")?.click());
  await page.waitForFunction(() => !document.querySelector(".ml-wikiroot"), null, { timeout: 5000 });

  // ── 5. right-handed landscape: BELOW the pill under the XP chip ────────
  await page.setViewportSize({ width: 851, height: 393 });
  await page.waitForFunction(
    () => document.documentElement.classList.contains("ml-land") && !document.querySelector(".ml-flip-veil"),
    null,
    { timeout: 15000 },
  );
  assertStack(await rects(), "below", "right-handed landscape");

  // ── 6. left-handed landscape: the pill keeps its corner, button ABOVE ──
  await page.evaluate(() => window.__ml.hand("left"));
  await page.waitForTimeout(800);
  assertStack(await rects(), "above", "left-handed landscape");
  await page.evaluate(() => window.__ml.hand("right"));

  // ── 7. portrait return ─────────────────────────────────────────────────
  await page.setViewportSize({ width: 393, height: 851 });
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("ml-land") && !document.querySelector(".ml-flip-veil"),
    null,
    { timeout: 15000 },
  );
  assertStack(await rects(), "above", "portrait return");

  errors.length === 0 ? ok("no page errors") : fail(`page errors: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}

console.log(bad ? "\nWIKIBTN: FAIL" : "\nWIKIBTN: PASS");
process.exit(bad ? 1 : 0);
