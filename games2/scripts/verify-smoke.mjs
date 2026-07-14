// ONE-SESSION browser smoke: everything that genuinely needs the browser
// (rendering glue, real input events, the websocket, Phaser anims) checked
// back-to-back in a single Chromium + single world load — launching a browser
// and joining a world per check is what made full e2e passes cost minutes.
// Navigation LOGIC is not proven here (that's server/test/navigation.sim.test.ts
// at ~1000x real time); this proves the glue: tap picking → trip → input synth,
// anim states, measured playback rates, the version badge, loading overlay,
// and in-place reconnect. Reconnect runs LAST (it swaps the session); then one
// reload covers the emission world's join + a short trip.
//
// PRE-FLIGHT: headless software-GL can starve the frame loop into slow-motion
// that fakes "stuck player" bugs (cost us an hour once). Before any check we
// measure raw keyboard speed and ABORT if the harness itself is too slow.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const fail = (m) => {
  throw new Error(m);
};
const VW = Number(process.env.VW || 480);
const VH = Number(process.env.VH || 320);

try {
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // ---- join the props world (loading overlay checked on the way in) ----
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  const idx = await page.evaluate(() => window.__mlSelect.worlds().findIndex((w) => /prop/i.test(w)));
  if (idx >= 0) await page.evaluate((i) => window.__mlSelect.pickWorld(i), idx);
  await page.evaluate(() => window.__mlSelect.commit());
  const seenLoading = await page
    .waitForSelector("#ml-loading", { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!seenLoading) fail("loading overlay never appeared after Enter world");
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), { timeout: 10000 });
  console.log("loading overlay OK");
  await page.waitForTimeout(1200);
  await page.bringToFront();
  await page.click("canvas");

  const pos = () => page.evaluate(() => ({ x: window.__ml.me().x, y: window.__ml.me().y }));

  // ---- PRE-FLIGHT: is the harness itself healthy? ----
  {
    let best = 0;
    for (const key of ["ArrowDown", "ArrowLeft"]) {
      const p0 = await pos();
      await page.keyboard.down(key);
      await page.waitForTimeout(1200);
      await page.keyboard.up(key);
      await page.waitForTimeout(300);
      const p1 = await pos();
      best = Math.max(best, Math.hypot(p1.x - p0.x, p1.y - p0.y) / 1.5);
      if (best >= 25) break;
    }
    console.log(`preflight speed ≈ ${best.toFixed(1)}wu/s`);
    if (best < 25)
      fail(
        `HARNESS STARVED (${best.toFixed(1)}wu/s < 25) — headless GL too slow at ` +
          `${VW}x${VH}; shrink the viewport. Navigation results would be lies.`,
      );
  }

  // ---- version badge (bottom-centre, 9-char sha) ----
  const badge = await page.evaluate(() => {
    const els = [...document.querySelectorAll("div")].filter(
      (d) => d.style.position === "fixed" && d.style.bottom && /^[0-9a-f]{9}$|^dev$/.test(d.textContent ?? ""),
    );
    return els[0]?.textContent ?? null;
  });
  if (!badge) fail("version badge missing");
  console.log(`badge OK (${badge})`);

  // ---- tap-to-move: WALK (real pointer path: pick → trip → input synth) ----
  {
    let target = null;
    for (const [dx, dy] of [[100, 55], [-110, 60], [120, -45], [-90, -60]]) {
      await page.mouse.click(VW / 2 + dx, VH / 2 + dy);
      await page.waitForTimeout(200);
      target = await page.evaluate(() => window.__ml.target());
      if (target) break;
    }
    if (!target) fail("tap never set a move target");
    if (target.run) fail("single tap must WALK, got run=true");
    const p0 = await pos();
    const d0 = Math.hypot(target.x - p0.x, target.y - p0.y);
    let dEnd = d0;
    for (let i = 0; i < 80; i++) {
      await page.waitForTimeout(150);
      const s = await page.evaluate(() => ({ m: window.__ml.me(), t: window.__ml.target() }));
      dEnd = Math.hypot(target.x - s.m.x, target.y - s.m.y);
      if (!s.t) break;
    }
    const arrived = await page.evaluate(() => !window.__ml.target());
    if (!arrived || dEnd > 40) fail(`tap-walk did not arrive (${d0.toFixed(0)} → ${dEnd.toFixed(0)}wu)`);
    console.log(`tap-to-move OK (${d0.toFixed(0)} → ${dEnd.toFixed(0)}wu, arrived)`);
  }

  // ---- double-tap: RUN (synthetic events — protocol latency breaks the
  // 400ms window if the two taps go through the real mouse API) ----
  {
    let t = null;
    // Far corners first: a close target legitimately walks (the follower
    // drops run inside the last cell), which would starve the running check.
    for (const [cx, cy] of [[VW - 50, 50], [50, VH - 40], [VW - 40, VH - 40], [50, 50], [170, 110]]) {
      await page.evaluate(({ cx, cy }) => {
        const c = document.querySelector("canvas");
        const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
        for (let i = 0; i < 2; i++) {
          c.dispatchEvent(new MouseEvent("mousedown", opts));
          c.dispatchEvent(new MouseEvent("mouseup", opts));
        }
      }, { cx, cy });
      await page.waitForTimeout(250);
      t = await page.evaluate(() => window.__ml.target());
      if (t) break; // spot may be unreachable ground — try another
    }
    if (!t || !t.run) fail(`double tap must RUN, got ${JSON.stringify(t)}`);
    // The run-flagged trip must either be observed running (server state) or
    // finish — short trips can complete between polls, and the follower
    // legitimately walks the final cell. Run MECHANICS are covered by the
    // navigation sim; this asserts the double-tap → run-trip glue.
    let runningSeen = false;
    let ended = false;
    for (let i = 0; i < 30 && !runningSeen && !ended; i++) {
      runningSeen = await page.evaluate(() => !!window.__ml.me()?.running);
      ended = await page.evaluate(() => !window.__ml.target());
      await page.waitForTimeout(100);
    }
    if (!runningSeen && !ended) fail("double-tap trip neither ran nor completed");
    console.log(`double-tap run OK (${runningSeen ? "running observed" : "short trip completed"})`);
  }

  // ---- keyboard cancels the trip ----
  {
    await page.keyboard.down("ArrowDown");
    await page.waitForTimeout(250);
    await page.keyboard.up("ArrowDown");
    const cancelled = await page.evaluate(() => !window.__ml.target());
    if (!cancelled) fail("keyboard did not cancel the tap trip");
    console.log("keyboard-cancels-tap OK");
  }

  // ---- jump animations (standing 'jump', running 'runjump', lands clean) ----
  {
    const sample = async () => {
      const seen = new Set();
      const t0 = Date.now();
      while (Date.now() - t0 < 1400) {
        const a = await page.evaluate(() => window.__ml.anim());
        if (a) seen.add(a.split(":").at(-2));
        await page.waitForTimeout(40);
      }
      return [...seen];
    };
    await page.evaluate(() => window.__ml.jump());
    const standing = await sample();
    await page.waitForTimeout(400);
    await page.keyboard.down("ShiftLeft");
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__ml.jump());
    const running = await sample();
    await page.keyboard.up("ArrowRight");
    await page.keyboard.up("ShiftLeft");
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => window.__ml.anim()?.split(":").at(-2) ?? null);
    if (!standing.includes("jump")) fail(`standing jump did not play 'jump' (${standing})`);
    if (!running.includes("runjump")) fail(`running jump did not play 'runjump' (${running})`);
    if (after === "jump" || after === "runjump") fail(`stuck in ${after} after landing`);
    console.log(`jump anims OK (standing=${standing} running=${running})`);
  }

  // ---- measured anim playback rates applied (anti-moonwalk) ----
  {
    const speeds = await (await fetch("http://localhost:5173/anim-speeds.json")).json();
    const uid = Object.keys(speeds)[0];
    const state = Object.keys(speeds[uid])[0];
    const dir = Object.keys(speeds[uid][state])[0];
    const want = speeds[uid][state][dir];
    const got = await page.evaluate(
      ({ uid, state, dir }) => window.__ml.animRate(uid, state, dir),
      { uid, state, dir },
    );
    const idle = await page.evaluate(() => window.__ml.animRate("default_boy", "idle", "south"));
    const jump = await page.evaluate(() => window.__ml.animRate("default_boy", "jump", "south"));
    if (got === null || Math.abs(got - want) > 0.11) fail(`anim rate ${uid}/${state}/${dir}: want ${want} got ${got}`);
    if (idle !== 6 || jump !== 18) fail(`fallback rates wrong (idle=${idle} jump=${jump})`);
    console.log(`anim rates OK (${uid}/${state}/${dir}=${got}, idle=6, jump=18)`);
  }

  // ---- reconnect in place, LAST (swaps the session) ----
  {
    const before = await page.evaluate(() => {
      window.__noReloadMarker = true;
      const m = window.__ml.me();
      return { x: m.x, y: m.y, id: window.__ml.myId() };
    });
    await page.evaluate(() => window.__ml.dropConnection());
    await page.waitForFunction(
      (oldId) => window.__ml && window.__ml.myId() && window.__ml.myId() !== oldId && window.__ml.players() >= 1,
      before.id,
      { timeout: 20000 },
    );
    const after = await page.evaluate(() => {
      const m = window.__ml.me();
      return { x: m.x, y: m.y, marker: !!window.__noReloadMarker };
    });
    if (!after.marker) fail("page RELOADED — reconnect must happen in place");
    const drift = Math.hypot(after.x - before.x, after.y - before.y);
    if (drift > 64) fail(`reconnect position drifted ${drift.toFixed(0)}wu`);
    const toastGone = await page.evaluate(() => !document.body.innerText.includes("Reconnecting"));
    if (!toastGone) fail("Reconnecting toast still visible after rejoin");
    console.log(`reconnect-in-place OK (drift ${drift.toFixed(0)}wu, no reload)`);
  }

  // ---- one reload: emission world join + a short trip ----
  {
    await page.goto("http://localhost:5173/#emission", { waitUntil: "load" });
    await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
    await page.evaluate(() => window.__mlSelect.commit());
    await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.bringToFront();
    const p0 = await pos();
    const t = await page.evaluate(({ x, y }) => {
      for (const [dx, dy] of [[6, 3], [-6, 4], [5, -4], [-5, -5]]) {
        const tx = x + dx * 32;
        const ty = y + dy * 32;
        if (window.__ml.blockedAt(tx, ty)) continue;
        const s = window.__ml.surfaceAt(tx, ty);
        if (!s || (!s.standable && !s.swimmable)) continue;
        window.__ml.tapTo(tx, ty, false);
        if (window.__ml.target()) return window.__ml.target();
      }
      return null;
    }, p0);
    if (!t) fail("emission: no tap target found");
    let arrived = false;
    for (let i = 0; i < 100 && !arrived; i++) {
      await page.waitForTimeout(150);
      arrived = await page.evaluate(() => !window.__ml.target());
    }
    const p1 = await pos();
    const dEnd = Math.hypot(t.x - p1.x, t.y - p1.y);
    if (!arrived || dEnd > 40) fail(`emission trip did not arrive (dist ${dEnd.toFixed(0)}wu)`);
    console.log(`emission smoke OK (arrived, ${dEnd.toFixed(0)}wu)`);
  }

  if (errors.length) fail("page errors: " + errors.slice(0, 3).join(" | "));
  console.log("SMOKE OK — all browser-glue checks passed in one session");
} finally {
  await browser.close();
}
