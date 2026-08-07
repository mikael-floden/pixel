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
// Canvas is the TOP 61.8% of the page (golden-ratio HUD split) — the camera
// centres the player at CY, and every tap/drag must stay above the HUD.
const CY = Math.round(VH * 0.309);

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

  // ---- version badge (bottom-centre of the game view since 2026-07-17 —
  // anchored by `bottom`, not `top`), 9-char sha ----
  const badge = await page.evaluate(() => {
    const els = [...document.querySelectorAll("div")].filter(
      (d) =>
        d.style.position === "fixed" &&
        (d.style.bottom || d.style.top) &&
        /^[0-9a-f]{9}$|^dev$/.test(d.textContent ?? ""),
    );
    return els[0]?.textContent ?? null;
  });
  if (!badge) fail("version badge missing");
  console.log(`badge OK (${badge})`);

  // ---- tap-to-move: single tap RUNS to the point and arrives (the
  // autopilot walks the final approach itself) ----
  {
    let target = null;
    for (const [dx, dy] of [[100, 55], [-110, 60], [120, -45], [-90, -60]]) {
      await page.mouse.click(VW / 2 + dx, CY + dy);
      await page.waitForTimeout(200);
      target = await page.evaluate(() => window.__ml.target());
      if (target) break;
    }
    if (!target) fail("tap never set a move target");
    if (!target.run) fail("a tap must RUN (single-tap-runs), got run=false");
    const p0 = await pos();
    const d0 = Math.hypot(target.x - p0.x, target.y - p0.y);
    let dEnd = d0;
    // Living camera: while the trip runs the camera must trail the avatar
    // and shed some zoom; once it settles it must sit back on the crisp
    // integer base zoom with the player near dead-centre.
    let chasePeak = { trail: 0, dip: 0 };
    for (let i = 0; i < 80; i++) {
      await page.waitForTimeout(150);
      const s = await page.evaluate(() => ({
        m: window.__ml.me(),
        t: window.__ml.target(),
        c: window.__ml.camInfo(),
      }));
      dEnd = Math.hypot(target.x - s.m.x, target.y - s.m.y);
      if (s.c && !s.c.detached) {
        chasePeak.trail = Math.max(chasePeak.trail, s.c.trail ?? 0);
        chasePeak.dip = Math.max(chasePeak.dip, s.c.base - s.c.zoom);
      }
      if (!s.t) break;
    }
    const arrived = await page.evaluate(() => !window.__ml.target());
    if (!arrived || dEnd > 40) fail(`tap trip did not arrive (${d0.toFixed(0)} → ${dEnd.toFixed(0)}wu)`);
    console.log(`tap-to-move OK (${d0.toFixed(0)} → ${dEnd.toFixed(0)}wu, arrived)`);
    if (chasePeak.trail < 6) fail(`chase-cam never trailed the runner (peak ${chasePeak.trail.toFixed(1)}px)`);
    if (chasePeak.dip < 0.02) fail(`chase-cam never zoomed out while running (dip ${chasePeak.dip.toFixed(3)})`);
    // Settle is FRAME-time ease (CAM_ZOOM_TAU_IN 0.85s), and a starved
    // headless-GL loop fits fewer frames per wall second — a fixed wait is
    // environment-marginal (measured: this settle takes ~5.6s wall on a slow
    // container, ~2s on a fast one). Poll until settled; a REAL regression
    // (e.g. a speed-EMA leak holding the zoom out) never converges and still
    // fails at the deadline.
    let rest = null;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(400);
      rest = await page.evaluate(() => window.__ml.camInfo());
      if (Math.abs(rest.zoom - rest.base) <= 0.01 && (rest.trail ?? 99) <= 8) break;
    }
    if (!rest || Math.abs(rest.zoom - rest.base) > 0.01 || (rest.trail ?? 99) > 8)
      fail(`chase-cam did not settle (zoom ${rest?.zoom.toFixed(3)}/${rest?.base}, trail ${(rest?.trail ?? -1).toFixed(1)}px)`);
    console.log(
      `chase-cam OK (peak trail ${chasePeak.trail.toFixed(0)}px, zoom dip ${chasePeak.dip.toFixed(2)}, settles to ${rest.base})`,
    );
  }

  // ---- hold-to-move: press-and-drag steers the target continuously ----
  {
    await page.mouse.move(VW / 2 + 90, CY + 50);
    await page.mouse.down();
    await page.waitForTimeout(250);
    // Drag through several spots; the target must FOLLOW the finger (each
    // stop that lands on reachable ground re-targets — require at least two
    // distinct targets across the stroke).
    const seen = [];
    // Spots stay inside the TOP 80% of the page — the bottom 20% is the HUD
    // dock (not game viewport; pointer events there never reach Phaser).
    for (const [mx, my] of [[VW - 60, 60], [VW - 50, VH * 0.55], [60, VH * 0.52], [70, 70], [VW / 2, VH * 0.45]]) {
      await page.mouse.move(mx, my, { steps: 6 });
      await page.waitForTimeout(280);
      seen.push(await page.evaluate(() => window.__ml.target()));
    }
    await page.mouse.up();
    const distinct = new Set(seen.filter(Boolean).map((t) => `${Math.round(t.x)},${Math.round(t.y)}`));
    if (distinct.size < 2) fail(`hold-drag did not steer the target (saw ${JSON.stringify([...distinct])})`);
    // Any live target must be a RUN trip (hold uses the same single-gesture
    // rule); after release the trip finishes at the last point OR is seen
    // running on the way there.
    if (seen.filter(Boolean).some((t) => !t.run)) fail("hold-drag produced a non-run trip");
    let runningSeen = false;
    let ended = false;
    for (let i = 0; i < 40 && !runningSeen && !ended; i++) {
      runningSeen = await page.evaluate(() => !!window.__ml.me()?.running);
      ended = await page.evaluate(() => !window.__ml.target());
      await page.waitForTimeout(100);
    }
    if (!runningSeen && !ended) fail("hold-to-move trip neither ran nor completed");
    console.log(
      `hold-to-move OK (${distinct.size} targets steered, ${runningSeen ? "running observed" : "trip completed"})`,
    );
  }

  // ---- HUD: six tabs (gamepad first, 2026-07-22), and Settings hosts the
  // time-of-day button (mobile has no keyboard for the [1] toggle) ----
  {
    const tabs = await page.$$eval(".ml-tab", (els) => els.map((e) => e.dataset.tab));
    if (tabs.length !== 6) fail(`want 6 HUD tabs, got ${JSON.stringify(tabs)}`);
    await page.click('[data-tab="settings"]');
    await page.waitForTimeout(120);
    const t0 = await page.evaluate(() => window.__ml.timeOfDay().name);
    // DOM click, not a pointer click: this harness viewport (480x320, kept
    // small for headless-GL health) squeezes the HUD to ~120px — the plate
    // button is half-clipped there, which is not what this step is judging.
    const clicked = await page.evaluate(() => {
      const b = document.querySelector(".ml-hudbtn");
      if (!b) return false;
      b.click();
      return true;
    });
    if (!clicked) fail("HUD time-of-day button missing");
    // The button is a SERVER round-trip ("timeofday" message → state patch →
    // local phase name): one fixed 150ms sample is starvation-marginal on a
    // slow container. Poll for the change; a dead button still fails.
    let t1 = t0;
    for (let i = 0; i < 25 && t1 === t0; i++) {
      await page.waitForTimeout(200);
      t1 = await page.evaluate(() => window.__ml.timeOfDay().name);
    }
    if (t0 === t1) fail(`HUD time-of-day button did not cycle (${t0})`);
    // …AND THE BUTTON PRINTS THE PHASE IT IS ON. The world clock advances by
    // itself every 20-40s, so a label that only refreshes when something else
    // happens drifts away from the real time (maintainer 2026-08-06). The
    // timeIdx listener is the one that has to re-read it — same path a manual
    // skip takes, which is what this click is.
    let label = "";
    for (let i = 0; i < 15; i++) {
      label = await page.evaluate(
        () => document.querySelector(".ml-hudbtn")?.textContent.trim() || "",
      );
      if (label.endsWith(t1)) break;
      await page.waitForTimeout(200);
    }
    if (!label.endsWith(t1)) fail(`time-of-day button reads "${label}" while the world is ${t1}`);
    console.log(`HUD tabs OK (6 tabs; settings time button ${t0} → ${t1}, label "${label}")`);
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

  // ---- jump animation (single 'jump' clip standing AND running, lands clean) ----
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
    if (!running.includes("jump")) fail(`running jump did not play 'jump' (${running})`);
    if (after === "jump") fail(`stuck in ${after} after landing`);
    console.log(`jump anims OK (standing=${standing} running=${running})`);
  }

  // ---- measured anim playback rates applied (anti-moonwalk) ----
  {
    const manifest = await (await fetch("http://localhost:5173/characters.json")).json();
    const def = manifest.characters.find((c) => c.gaitFps?.walk && c.gaitFps?.run);
    if (!def) fail("no character carries measured gaitFps in characters.json");
    const walk = await page.evaluate((uid) => window.__ml.animRate(uid, "walk", "south"), def.uid);
    const run = await page.evaluate((uid) => window.__ml.animRate(uid, "run", "east"), def.uid);
    const idle = await page.evaluate(() => window.__ml.animRate("default_boy", "idle", "south"));
    const jump = await page.evaluate(() => window.__ml.animRate("default_boy", "jump", "south"));
    if (walk === null || Math.abs(walk - def.gaitFps.walk) > 0.11)
      fail(`walk rate ${def.uid}: want ${def.gaitFps.walk} got ${walk}`);
    if (run === null || Math.abs(run - def.gaitFps.run) > 0.11)
      fail(`run rate ${def.uid}: want ${def.gaitFps.run} got ${run}`);
    // jump's once-through rate is DERIVED (frames / JUMP_MS) so the clip spans
    // the hop whatever the art ships — assert against the manifest frame count.
    const boy = manifest.characters.find((c) => c.uid === "default_boy");
    const wantJump = (boy?.animations?.jump?.south ?? 0) / 0.5;
    if (idle !== 6) fail(`idle fallback rate wrong (${idle})`);
    if (jump === null || Math.abs(jump - wantJump) > 0.01)
      fail(`jump rate: want ${wantJump} (frames/JUMP_MS) got ${jump}`);
    console.log(`anim rates OK (${def.uid} walk=${walk} run=${run}, idle=6, jump=${jump})`);
  }

  // ---- deferred action-state anims arrive in the background ----
  // Boot preloads only idle/walk/run/jump; the other manifest states (kick,
  // sword, …) stream in after join (loadDeferredAnims). Assert one landed.
  {
    const t0 = Date.now();
    let kick = null;
    while (Date.now() - t0 < 30000) {
      kick = await page.evaluate(() => window.__ml.animRate("default_boy", "kick", "south"));
      if (kick !== null) break;
      await page.waitForTimeout(500);
    }
    if (kick === null) fail("deferred anims did not arrive (kick clip missing after 30s)");
    console.log(`deferred anims OK (kick rate ${kick})`);
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

  // ---- one reload: the glow_test showcase (maps2's emissive world) ----
  {
    await page.goto("http://localhost:5173/", { waitUntil: "load" });
    await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
    await page.evaluate(() => {
      const i = window.__mlSelect.worlds().findIndex((w) => /glow/i.test(w));
      if (i >= 0) window.__mlSelect.pickWorld(i);
      window.__mlSelect.commit();
    });
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
    if (!t) fail("glow_test: no tap target found");
    let arrived = false;
    for (let i = 0; i < 100 && !arrived; i++) {
      await page.waitForTimeout(150);
      arrived = await page.evaluate(() => !window.__ml.target());
    }
    const p1 = await pos();
    const dEnd = Math.hypot(t.x - p1.x, t.y - p1.y);
    if (!arrived || dEnd > 40) fail(`glow_test trip did not arrive (dist ${dEnd.toFixed(0)}wu)`);
    console.log(`glow_test smoke OK (arrived, ${dEnd.toFixed(0)}wu)`);
  }

  // ---- one reload: monster_demo (every monster pad; walk anims must PLAY) ----
  // Guards the frozen-slide class: a hardcoded/mis-resolved anim key leaves
  // every monster gliding as a statue — invisible to screenshots (a stuck walk
  // frame looks exactly like the freeze-frame idle), so assert the ANIMATION
  // STATE via __ml.monsterInfo(). Needs a world that actually has zones —
  // prop_demo/glow_test legitimately ship zero (no habitats), monster_demo is
  // the showcase with a pad per roster monster.
  {
    await page.goto("http://localhost:5173/", { waitUntil: "load" });
    await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
    await page.evaluate(() => {
      const i = window.__mlSelect.worlds().findIndex((w) => /monster/i.test(w));
      if (i >= 0) window.__mlSelect.pickWorld(i);
      window.__mlSelect.commit();
    });
    await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const count = await page.evaluate(() => window.__ml.monsterInfo().length);
    if (count === 0) fail("monster_demo has no monsters (zones failed to load)");
    let playingSeen = 0;
    let badIdle = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 10000 && playingSeen === 0) {
      // Camera-gated monsters are PARKED on purpose (no anim, no draw) — only
      // on-screen bodies are expected to animate.
      const info = (await page.evaluate(() => window.__ml.monsterInfo())).filter((m) => !m.culled);
      for (const m of info) {
        if (m.playing && m.anim) playingSeen++;
        if (!m.playing && m.tex.includes("placeholder")) badIdle++;
      }
      await page.waitForTimeout(300);
    }
    if (playingSeen === 0) fail("no monster ever played its walk clip (frozen-slide regression)");
    if (badIdle > 0) fail(`${badIdle} resting monster samples on the placeholder texture`);
    console.log(`monster anims OK (${count} monsters, ${playingSeen} playing samples)`);

    // CAMERA GATE (perf fix #4): only on-screen monsters run the body
    // pipeline. Two things must hold or the gate is a rendering bug, not an
    // optimisation: (a) a culled body is really hidden AND paused — otherwise
    // we pay for it anyway or draw a stale ghost; (b) culling REVERSES — pan
    // the camera away and back and the same bodies animate again. (b) is the
    // regression that would strand every monster invisible.
    {
      const activeIds = async () =>
        (await page.evaluate(() => window.__ml.monsterInfo()))
          .filter((m) => !m.culled)
          .map((m) => m.id);
      const near = await page.evaluate(() => window.__ml.monsterGate());
      if (near.total === 0) fail("monsterGate: no monsters to gate");
      if (near.active === 0) fail("monsterGate: nothing active where the player stands");
      if (near.culled === 0) fail("monsterGate: nothing culled — the gate is not gating");
      if (near.visibleCulled > 0) fail(`monsterGate: ${near.visibleCulled} culled monsters still drawn`);
      if (near.animatingCulled > 0) fail(`monsterGate: ${near.animatingCulled} culled monsters still animating`);
      if (near.wrongCulled > 0) fail(`monsterGate: ${near.wrongCulled} culled monsters overlap the camera view`);
      const before = await activeIds();
      // Pan the camera off the player. We assert nothing about what is at the
      // DESTINATION (a showcase world can have monsters anywhere) — only that
      // the bodies we were rendering here drop out, and come back when we do.
      const me = await page.evaluate(() => window.__ml.me());
      await page.evaluate(({ c, r }) => window.__ml.lookAt(c, r), {
        c: Math.max(0, Math.round(me.x / 32) - 40),
        r: Math.max(0, Math.round(me.y / 32) - 40),
      });
      await page.waitForTimeout(900);
      const away = await page.evaluate(() => window.__ml.monsterGate());
      const stillActive = (await activeIds()).filter((id) => before.includes(id));
      if (stillActive.length === before.length)
        fail(`monsterGate: panning away culled none of the ${before.length} local monsters`);
      if (away.wrongCulled > 0) fail(`monsterGate: ${away.wrongCulled} culled monsters overlap the view off-camera`);
      if (away.visibleCulled > 0) fail(`monsterGate: ${away.visibleCulled} culled monsters drawn off-camera`);
      // ...and back: the gate must re-open and those bodies animate again.
      await page.evaluate(() => window.__ml.lookAt());
      await page.waitForTimeout(1500);
      const back = await page.evaluate(() => window.__ml.monsterGate());
      if (back.wrongCulled > 0) fail(`monsterGate: ${back.wrongCulled} culled monsters overlap the view after panning back`);
      const revived = (await page.evaluate(() => window.__ml.monsterInfo())).filter(
        (m) => !m.culled && before.includes(m.id),
      );
      if (revived.length === 0) fail("monsterGate: local monsters never came back after panning back");
      if (!revived.some((m) => m.playing || m.anim))
        fail("monsterGate: revived monsters never resumed a clip");
      console.log(
        `monster camera gate OK (${near.active}/${near.total} active, ${before.length - stillActive.length} culled by panning, ${revived.length} revived)`,
      );
    }
  }

  // ---- OCCLUDER VIEW-CULL + DECK EXPOSURE (perf #2/#3) ----
  // rebuildOccluders only builds occluder images that can be seen, and gives
  // deck slabs the exposed-face rule terrain already had. Culling an occluder
  // can never leave a hole (the ground RT paints the terrain), but it CAN
  // mis-sort a body — so the invariant is about occluderMeta, which is what
  // resolveBodyDepth reads: every non-prop meta record overlapping the view
  // must still have drawn art behind it. `metaWithoutArt` must be 0, standing
  // AND walking (the camera drifts up to OCC_STEP between rebuilds).
  // Runs on occlusion_test: the only compact world with BOTH raised terrain
  // (level 32) and decks, so it exercises the terrain cull and the deck
  // exposure rule. monster_demo/glow_test/prop_demo are all flat — the check
  // is vacuous there.
  {
    await page.goto("http://localhost:5173/", { waitUntil: "load" });
    await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
    await page.evaluate(() => {
      const i = window.__mlSelect.worlds().findIndex((w) => /occlusion_test/.test(w));
      if (i >= 0) window.__mlSelect.pickWorld(i);
      window.__mlSelect.commit();
    });
    await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, { timeout: 30000 });
    await page.waitForTimeout(3000);
    const audit = await page.evaluate(() => (window.__ml.occAudit ? window.__ml.occAudit() : null));
    if (!audit) fail("occAudit probe missing");
    if (audit.built + audit.culled === 0)
      fail("occAudit: nothing built and nothing culled — the occluder pass did not run");
    if (audit.culled === 0)
      fail("occAudit: culled 0 images on a level-32 world with decks — the cull is not active");
    if (audit.metaWithoutArt > 0)
      fail(
        `occAudit: ${audit.metaWithoutArt} visible occluder columns draw NOTHING ` +
          `(bodies would clip against terrain that is not there): ${JSON.stringify(audit.offenders)}`,
      );
    let worst = 0;
    let peakCulled = audit.culled;
    for (const key of ["ArrowDown", "ArrowRight", "ArrowUp"]) {
      await page.keyboard.down(key);
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(320);
        const a = await page.evaluate(() => window.__ml.occAudit());
        worst = Math.max(worst, a.metaWithoutArt);
        peakCulled = Math.max(peakCulled, a.culled);
      }
      await page.keyboard.up(key);
      await page.waitForTimeout(200);
    }
    if (worst > 0) fail(`occAudit: ${worst} columns drew nothing while WALKING (cull margin too tight)`);
    console.log(`occluder cull OK (built ${audit.built}, culled up to ${peakCulled}, 0 uncovered columns)`);
  }

  if (errors.length) fail("page errors: " + errors.slice(0, 3).join(" | "));
  console.log("SMOKE OK — all browser-glue checks passed in one session");
} finally {
  await browser.close();
}
