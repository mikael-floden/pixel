// Wedged-hold gate (dev-stack browser): a tap whose release the scene never
// receives (DOM overlays racing the join/reconnect, OS touchcancel) must NOT
// leave the hold gesture armed forever — before the fix, holdPointerId stayed
// set, every later tap was ignored at pointerdown, the stale ground point
// re-armed the autopilot trip every frame (the player ran to the same spot
// and "got stuck"), and a respawn ran straight back toward it.
//
// The harness drives the MOUSE pipeline (same one verify-smoke uses; the
// touch backend isn't reachable headlessly) plus the __ml.wedgeHold QA probe,
// which arms the exact wedged state a swallowed release leaves behind: hold
// keyed to a pointer slot that is NOT down + a stale ground point. Asserts:
// (1) real press-and-hold arms the hold, release clears it (no regression);
// (2) the wedge self-heals within a few frames;
// (3) taps AFTER a wedge work (this was the hard lock-out);
// (4) a teleport/respawn cancels an in-flight trip (no running back).
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
await page.addInitScript(() => {
  localStorage.setItem("ml-last-choice", JSON.stringify({ world: "ring_test", characterUid: "default_boy", name: "tw" }));
  sessionStorage.setItem("ml-rejoin", "1");
});
await page.goto("http://localhost:5173/", { waitUntil: "load" });
await page.waitForFunction(() => window.__ml && window.__ml.players?.() >= 1, null, { timeout: 30000 });
await page.waitForTimeout(6000);

const hold = () => page.evaluate(() => window.__ml.holdInfo());
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.log(`FAIL  ${msg}`); fails++; } else console.log(`ok    ${msg}`); };

// Canvas centre sits at ~31% of the viewport height (golden-ratio HUD split).
const CX = 240, CY = 99;

// (1) Real press-and-hold via the mouse pipeline: hold arms while down,
// clears on release, and the tap leaves a trip toward a far point.
await page.mouse.move(CX + 120, CY - 30);
await page.mouse.down();
await page.waitForTimeout(250);
{
  const h = await hold();
  ok(h.held !== null, `press-and-hold arms the hold (held=${h.held})`);
  ok(h.trip !== null, `press arms a trip (trip=${JSON.stringify(h.trip)})`);
}
await page.mouse.up();
await page.waitForTimeout(200);
{
  const h = await hold();
  ok(h.held === null, `release clears the hold (held=${h.held})`);
}
await page.waitForTimeout(5000); // arrive; start the next phase clean

// (2) THE WEDGE: the state a swallowed release leaves behind. The frame-loop
// self-heal (pointer slot not down) must clear it within a few frames —
// before the fix this state persisted forever.
const me0 = await page.evaluate(() => { const m = window.__ml.me(); return { x: m.x, y: m.y }; });
await page.evaluate(([x, y]) => window.__ml.wedgeHold(x, y), [me0.x + 8 * 32, me0.y]);
await page.waitForTimeout(400);
{
  const h = await hold();
  ok(h.held === null, `wedged hold self-heals (held=${h.held})`);
}

// (3) A tap AFTER the wedge must arm a fresh trip (pointerdown used to
// ignore everything while holdPointerId was set).
await page.mouse.click(CX - 110, CY - 20);
await page.waitForTimeout(250);
{
  const h = await hold();
  ok(h.trip !== null, `tap after the wedge arms a trip (trip=${JSON.stringify(h.trip)})`);
  ok(h.held === null, `and its gesture releases cleanly (held=${h.held})`);
}
await page.waitForTimeout(4000);

// (4) Teleport/respawn mid-trip cancels the trip — the player must not run
// back toward the pre-jump target (the respawn half of the report).
await page.mouse.click(CX + 130, CY + 20);
await page.waitForTimeout(250);
{
  const h = await hold();
  ok(h.trip !== null, `pre-teleport trip armed (trip=${JSON.stringify(h.trip)})`);
}
const spot = await page.evaluate(() => { const m = window.__ml.me(); return { c: m.x / 32, r: m.y / 32 }; });
await page.evaluate(([c, r]) => window.__ml.teleport(c + 12, r), [spot.c, spot.r]);
await page.waitForTimeout(700);
{
  const h = await hold();
  ok(h.trip === null && h.held === null, `teleport cancels the trip + hold (trip=${JSON.stringify(h.trip)}, held=${h.held})`);
}

await browser.close();
if (fails) { console.log(`verify-tapwedge: ${fails} FAILURE(S)`); process.exit(1); }
console.log("verify-tapwedge: OK — wedged holds self-heal, later taps work, respawn/teleport cancels the trip.");
