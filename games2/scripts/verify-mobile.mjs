// Mobile-play verification: PWA installability bits, the post-"Enter world"
// loading overlay, and tap-to-move (tap → walk there, double-tap → run).
// Drives the REAL client headlessly against a dev stack.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const errors = [];
const fail = (m) => {
  throw new Error(m);
};
try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 640 }, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|404/.test(m.text())) errors.push(m.text());
  });

  // ---- 1. PWA surface: manifest + SW + icons reachable and sane ----
  const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  if (manifest.display !== "fullscreen") fail(`manifest.display=${manifest.display}, want fullscreen`);
  if (!manifest.icons || manifest.icons.length < 3) fail("manifest icons missing");
  for (const ic of manifest.icons) {
    const r = await fetch(`${BASE}${ic.src}`);
    if (!r.ok) fail(`icon ${ic.src} → ${r.status}`);
  }
  const sw = await fetch(`${BASE}/sw.js`);
  if (!sw.ok) fail(`sw.js → ${sw.status}`);
  console.log("PWA manifest/sw/icons OK");

  // ---- 2. Select screen: install button appears when the prompt exists ----
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  const hiddenBefore = await page.evaluate(() => window.__mlSelect.installVisible());
  await page.evaluate(() => {
    const e = new Event("beforeinstallprompt");
    e.prompt = () => {};
    e.userChoice = Promise.resolve({ outcome: "dismissed" });
    window.dispatchEvent(e);
  });
  const visibleAfter = await page.evaluate(() => window.__mlSelect.installVisible());
  if (hiddenBefore) fail("install button visible with no install prompt available");
  if (!visibleAfter) fail("install button did not appear after beforeinstallprompt");
  console.log("Install-app button OK (hidden→shown on beforeinstallprompt)");

  // ---- 3. Loading overlay: shows on commit, gone once the avatar is in ----
  await page.evaluate(() => window.__mlSelect.commit());
  const seenLoading = await page
    .waitForSelector("#ml-loading", { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!seenLoading) fail("loading overlay never appeared after Enter world");
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 10000 });
  console.log("Loading overlay OK (shown after commit, hidden when in-world)");

  // ---- 4. Tap-to-move ----
  await page.waitForTimeout(1200);
  await page.bringToFront();
  const start = await page.evaluate(() => {
    const m = window.__ml.me();
    return { x: m.x, y: m.y };
  });
  // Tap a bit down-right of the screen centre (the camera centres the player).
  await page.mouse.click(450 + 130, 320 + 60);
  await page.waitForTimeout(200);
  const target = await page.evaluate(() => window.__ml.target());
  if (!target) fail("tap did not set a move target");
  if (!target.run) fail("a tap must RUN (single-tap-runs), got run=false");
  // The player must make real progress toward the target.
  const d0 = Math.hypot(target.x - start.x, target.y - start.y);
  let dEnd = d0;
  for (let i = 0; i < 100; i++) {
    await page.waitForTimeout(150);
    const s = await page.evaluate(() => {
      const m = window.__ml.me();
      return { x: m.x, y: m.y, t: window.__ml.target() };
    });
    dEnd = Math.hypot(target.x - s.x, target.y - s.y);
    if (!s.t) break; // arrived (target cleared)
  }
  const arrived = await page.evaluate(() => !window.__ml.target());
  if (!(dEnd < d0 * 0.5)) fail(`tap-walk made no progress (${d0.toFixed(0)} → ${dEnd.toFixed(0)}wu)`);
  console.log(
    `Tap-to-move OK (dist ${d0.toFixed(0)} → ${dEnd.toFixed(0)}wu${arrived ? ", arrived" : ""})`,
  );

  // Hold-to-move: press and DRAG — the target must follow the finger (this
  // replaced the old double-tap-to-run gesture; every tap/hold runs now).
  await page.mouse.move(450 + 120, 320 + 55);
  await page.mouse.down();
  await page.waitForTimeout(250);
  const holdSeen = [];
  // Spots stay inside the TOP 80% of the page — the bottom 20% is the HUD dock.
  for (const [mx, my] of [[840, 90], [830, 470], [90, 460], [140, 120]]) {
    await page.mouse.move(mx, my, { steps: 6 });
    await page.waitForTimeout(280);
    holdSeen.push(await page.evaluate(() => window.__ml.target()));
  }
  await page.mouse.up();
  const holdDistinct = new Set(holdSeen.filter(Boolean).map((t) => `${Math.round(t.x)},${Math.round(t.y)}`));
  if (holdDistinct.size < 2) fail(`hold-drag did not steer the target (${JSON.stringify([...holdDistinct])})`);
  if (holdSeen.filter(Boolean).some((t) => !t.run)) fail("hold-drag produced a non-run trip");
  const runningSeen = await page.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      const me = window.__ml.me();
      if (me && me.running) return true;
      if (!window.__ml.target()) return true; // short leg completed — fine
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  });
  if (!runningSeen) fail("hold-to-move trip neither ran nor completed");
  console.log(`Hold-to-move OK (${holdDistinct.size} targets steered)`);

  // Keyboard cancels the trip.
  await page.mouse.click(450 + 100, 320 + 40);
  await page.waitForTimeout(200);
  await page.keyboard.down("ArrowDown");
  await page.waitForTimeout(300);
  await page.keyboard.up("ArrowDown");
  const cancelled = await page.evaluate(() => !window.__ml.target());
  if (!cancelled) fail("keyboard input did not cancel the tap trip");
  console.log("Keyboard-cancels-tap OK");

  if (errors.length) fail("page errors: " + errors.slice(0, 3).join(" | "));
  console.log("MOBILE-VERIFY OK");
} finally {
  await browser.close();
}
