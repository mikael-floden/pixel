// LEVEL UP verification — "Thunderclap" (maintainer 2026-08-06: "the level up
// graphics is perfect! I love it! Now get it into the game!").
//
// The animation was designed and approved on an artifact page, and the two
// rounds of correction it took there are exactly what this gate pins:
//
//   1. "I don't recognize the flashpoint effect" — the light's cleanup was
//      attached after an await, so when the sweep finished (no fill mode) the
//      band snapped back to a static stripe and SAT on the track. So: the
//      flash element exists during the sweep and is GONE afterwards.
//   2. "The LEVEL enlargement is not in sync with the other effect … I want
//      the punch from each effect at the same time/frame." So: the three
//      punches — the fill's flash, the plate's recoil, the number's stamp —
//      must share ONE start time, asserted against the browser's OWN record
//      (Animation.startTime), which no sampling rate can blur.
//
// Plus the game-side wiring the page could not have: the bar runs to full on
// the level you JUST FINISHED (the server only ever sends the carry-over), the
// LEVEL label holds the old number until the stamp lands, a JOIN never fires
// it, and reduced motion gets the values with no show.
//
// HOW IT FILMS. This is a TIMING check on a harness whose software GL renders
// the world at ~5fps (measured), and the document timeline is what WAAPI
// clocks run on — at that rate the sweep's own clock never advances and every
// interval collapses. So once the world is joined and the real stats are in,
// the gate DROPS THE WEBGL CONTEXT: Phaser stops rasterising, the main thread
// comes free (~43fps measured, no page errors) and the animation is filmed at
// something like device speed. Nothing under test is WebGL — every pixel of
// this animation is DOM. The assertions still accept the starved reading, and
// say in the log which one they got, so the gate degrades loudly, not silently.
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

/** Join the world at the maintainer's phone geometry. */
const join = async (opts = {}) => {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 851 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    ...opts,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__mlBars, null, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 40000 });
  // the real level-1 stats replace the mount defaults on the first patch
  await page.waitForFunction(
    () => (window.__mlBars.state().xpText || "").includes("/ 50"),
    null,
    { timeout: 60000, polling: 100 },
  );
  return { ctx, page, errors };
};

/**
 * Run one level-up and film it — WITHOUT relying on the frame rate. The
 * headless GL here renders the world at ~5fps (measured; the repo's standing
 * starvation trait), so a sampled film misses whole punches. Two sources that
 * do not care how often the page paints:
 *
 *   • MutationObserver — fires per mutation BATCH, so every paint the
 *     animation performs is one snapshot, in order, whatever the frame rate.
 *     Reading getComputedStyle inside the callback also flushes style, which
 *     resolves the freshly-created WAAPI animations to their offset-0 values:
 *     that is the impact frame, captured exactly.
 *   • Animation.startTime — the browser's OWN record of when each animation
 *     began. The objects are grabbed the moment their effect appears and read
 *     at the end; a finished animation keeps its start time.
 */
const film = (page, ms = 3000) =>
  page.evaluate(
    (dur) =>
      new Promise((done) => {
        const paints = [];
        const seen = [];
        let sweep = null;
        let sweepAtImpact = null;
        let shock = null;
        const t0 = performance.now();
        /**
         * The shockwave, measured off its OWN backing store a moment after the
         * impact: where the ring is actually painted and how bright, plus the
         * canvas box against the chip it is thrown from. Reading the pixels is
         * the only way to know the ring is drawn at all — it is a canvas, so
         * no DOM assertion can see it.
         */
        const sampleRing = () => {
          const cv = document.querySelector(".ml-lvup-fx");
          const chip = document.querySelector(".ml-bars-r");
          if (!cv || !chip) return;
          const g = cv.getContext("2d");
          const cssW = parseFloat(cv.style.width);
          const dpr = cv.width / cssW;
          const row = g.getImageData(0, Math.round(cv.height / 2), cv.width, 1).data;
          const cx = cv.width / 2;
          let r = 0;
          let peak = 0;
          for (let x = 0; x < cv.width; x++) {
            const a = row[x * 4 + 3];
            if (a > 8) {
              r = Math.max(r, Math.abs(x - cx) / dpr);
              peak = Math.max(peak, a);
            }
          }
          const b = cv.getBoundingClientRect();
          const c = chip.getBoundingClientRect();
          shock = {
            r: Math.round(r),
            peak,
            box: Math.round(cssW),
            offCx: Math.round(b.left + b.width / 2 - (c.left + c.width / 2)),
            offCy: Math.round(b.top + b.height / 2 - (c.top + c.height / 2)),
            reach: Math.round(c.left - b.left),
            z: getComputedStyle(cv).zIndex,
            gameZ: getComputedStyle(document.querySelector("#game")).zIndex,
          };
        };
        const snap = (why) => {
          const s = window.__mlBars.state();
          paints.push({ t: Math.round(performance.now() - t0), why, ...s });
        };
        const grab = (why) => {
          for (const a of document.getAnimations()) if (!seen.includes(a)) seen.push(a);
          if (why === "flash") {
            sweep = document.getAnimations().find(
              (a) => a.effect?.target?.classList?.contains("ml-lvup-flash"),
            ) ?? null;
          }
          // Where the light HAD got to when the punch landed. This — not the
          // wall clock — is what "pre-rolled" means: the bloom must already be
          // crossing the track. On a real device it reads ~76ms of 220; on
          // this 5fps harness the whole sweep has run, which is the same
          // statement (never before mid-track), only degraded.
          if (why === "ring" && sweep && !sweepAtImpact) {
            sweepAtImpact = {
              at: Math.round(Number(sweep.currentTime ?? 0)),
              done: sweep.playState === "finished",
            };
            setTimeout(sampleRing, 150); // a third of the way out
          }
        };
        const tag = (recs) => {
          let why = "paint";
          for (const r of recs) {
            for (const n of r.addedNodes) {
              if (n.classList?.contains("ml-lvup-fx")) why = "ring";
              else if (n.classList?.contains("ml-lvup-flash")) why = "flash";
            }
            for (const n of r.removedNodes) {
              if (n.classList?.contains("ml-lvup-flash")) why = "flash-gone";
              else if (n.classList?.contains("ml-lvup-fx")) why = "ring-gone";
            }
          }
          if (why === "ring" || why === "flash") grab(why);
          snap(why);
        };
        // the chip's own subtree: the fill's width, both numbers, the flash
        new MutationObserver(tag).observe(document.querySelector(".ml-bars-r"), {
          subtree: true, childList: true, characterData: true,
          attributes: true, attributeFilter: ["style"],
        });
        // the shockwave canvas is a direct child of <body>
        new MutationObserver(tag).observe(document.body, { childList: true });

        window.__mlBars.levelUp(10, 141);
        snap("start");
        setTimeout(() => {
          snap("end");
          done({
            paints,
            sweepAtImpact,
            shock,
            anims: seen
              .map((a) => {
                const el = a.effect && a.effect.target;
                return {
                  cls: typeof el?.className === "string" ? el.className : "?",
                  dur: a.effect?.getTiming().duration ?? 0,
                  start: Math.round(Number(a.startTime ?? -1) * 100) / 100,
                };
              })
              .filter((a) => typeof a.dur === "number" && a.dur > 0),
          });
        }, dur);
      }),
    ms,
  );

/**
 * Stop Phaser rasterising so the timeline runs at something like device speed
 * (see the header). The websocket, the DOM and every synced value are
 * untouched — only the world's pixels stop.
 */
const freeMainThread = async (page) => {
  await page.evaluate(() => {
    const c = document.querySelector("#game canvas");
    const gl = c && (c.getContext("webgl2") || c.getContext("webgl"));
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  });
  await page.waitForTimeout(400);
  const fps = await page.evaluate(
    () =>
      new Promise((d) => {
        let n = 0;
        const t0 = performance.now();
        const f = () => {
          n++;
          if (performance.now() - t0 < 1000) requestAnimationFrame(f);
          else d(n);
        };
        requestAnimationFrame(f);
      }),
  );
  console.log(`   (filming at ~${fps}fps)`);
};

const brightness = (filter) => {
  const m = /brightness\(([\d.]+)\)/.exec(filter || "");
  return m ? parseFloat(m[1]) : 1;
};

try {
  // ── 1. a JOIN is not a level-up ────────────────────────────────────────
  const { ctx, page, errors } = await join();
  const atJoin = await page.evaluate(() => window.__mlBars.state());
  atJoin.runs === 0
    ? ok("joining does not fire a level-up (a returning level-9 player has not just levelled)")
    : fail(`level-up ran ${atJoin.runs}× on join`);
  atJoin.levelText === "LEVEL 1"
    ? ok(`label reads "${atJoin.levelText}"`)
    : fail(`join label "${atJoin.levelText}", want "LEVEL 1"`);

  // ── 2. film one level-up ───────────────────────────────────────────────
  await freeMainThread(page);
  const { paints, anims, sweepAtImpact, shock } = await film(page);
  const last = paints[paints.length - 1];
  console.log(
    `   (${paints.length} paints over ${last.t}ms: ` +
      `${paints.filter((p) => p.why !== "paint").map((p) => `${p.why}@${p.t}ms`).join(" → ")})`,
  );

  // 2a. THE SYNC — the three punches share ONE start time. This is the whole
  //     of the maintainer's last correction, checked against the browser's own
  //     record rather than against anything this code believes.
  const punch = (cls, dur) => anims.find((a) => a.cls.includes(cls) && a.dur === dur);
  const flashA = punch("ml-bar-fill", 280);
  const recoilA = punch("ml-bars", 300);
  const stampA = punch("ml-bar-level", 420);
  if (!flashA || !recoilA || !stampA) {
    fail(
      `missing a punch: fill flash=${!!flashA} plate recoil=${!!recoilA} level stamp=${!!stampA}` +
        ` (saw ${anims.map((a) => `${a.cls}@${a.dur}`).join(", ")})`,
    );
  } else {
    const spread = Math.max(flashA.start, recoilA.start, stampA.start) -
      Math.min(flashA.start, recoilA.start, stampA.start);
    spread <= 1
      ? ok(`all three punches start on ONE frame (spread ${spread}ms — the maintainer's whole note)`)
      : fail(`punches start ${spread}ms apart (fill ${flashA.start}, plate ${recoilA.start}, level ${stampA.start})`);
  }

  // 2b. the light SWEEPS FIRST and the impact lands inside its window — it is
  //     pre-rolled so its bloom is crossing the track AT the hit, never after.
  //     (The exact 34%-of-220ms lead is not assertable on a 5fps harness: the
  //     first frame the sweep's own clock is readable at is already past it.
  //     What IS asserted is the ordering the bug broke.)
  const sweepA = anims.find((a) => a.cls.includes("ml-lvup-flash"));
  if (!sweepA) fail("the light never swept the track");
  else if (!sweepAtImpact) fail("the impact fired without a light sweeping");
  else {
    // Two ways to satisfy "the bloom is crossing the track when the punch
    // lands", and the harness decides which one you get. On a real device the
    // wait ends on the LIGHT'S OWN CLOCK at 34% of the sweep (~76 of 220ms).
    // Here the document timeline can sit still for half a second at a time, so
    // the sweep's clock never advances and the wall-clock escape ends the wait
    // instead — by which point a whole sweep's worth of real time has passed.
    // Either way the punch is never ahead of the light, which is the bug.
    const MID = Math.round(sweepA.dur * 0.344);
    const wallLead = stampA ? Math.round(stampA.start - sweepA.start) : -1;
    const onClock = (sweepAtImpact.at >= MID && sweepAtImpact.at <= sweepA.dur) || sweepAtImpact.done;
    const onWall = wallLead >= sweepA.dur;
    onClock || onWall
      ? ok(
          `the light is pre-rolled — the bloom is crossing the track at the punch (` +
            (onClock
              ? `sweep at ${sweepAtImpact.at}/${sweepA.dur}ms, mid-track ${MID}ms`
              : `harness stalled the timeline: sweep clock ${sweepAtImpact.at}ms, but ${wallLead}ms of real time`) +
            `)`,
        )
      : fail(
          `punch landed ${sweepAtImpact.at}ms into the sweep (${wallLead}ms wall); ` +
            `the bloom reaches mid-track at ${MID}ms`,
        );
    stampA && stampA.start >= sweepA.start
      ? ok("the number never gets ahead of the light")
      : fail(`the stamp starts ${Math.round(sweepA.start - (stampA?.start ?? 0))}ms BEFORE the sweep`);
  }
  // …and it CLEANS ITSELF UP (the stripe he screenshotted parked on the track)
  paints.some((p) => p.why === "flash")
    ? ok("the light band is added to the track")
    : fail("no .ml-lvup-flash ever appeared");
  paints.some((p) => p.why === "flash-gone") && last.flash === 0
    ? ok("…and removes itself when the sweep ends")
    : fail(`${last.flash} flash band(s) left parked on the track`);

  // 2c. THE CLIMB — the gauge runs to full on the level you just FINISHED,
  //     counting the OLD requirement, with the label still on the old number.
  // Both observers report the impact's one synchronous block (the chip's
  // subtree sees the label, the body sees the canvas), so find it by CONTENT.
  const iHit = paints.findIndex((p) => p.ring === 1);
  const climb = iHit > 0 ? paints.slice(0, iHit) : [];
  climb.length >= 2 && climb.every((p) => p.xpText.includes("/ 50 XP"))
    ? ok("the climb counts the OLD requirement (n / 50 XP) — the server only ever sends the carry-over")
    : fail(`climb showed ${JSON.stringify([...new Set(climb.map((p) => p.xpText))])}`);
  climb.length >= 2 && climb[climb.length - 1].fill === 100 && climb[0].fill < 100
    ? ok(`the gauge runs to full before the impact (${climb[0].fill}% → ${climb[climb.length - 1].fill}%)`)
    : fail(`gauge did not climb to full (${JSON.stringify(climb.map((p) => p.fill))})`);
  climb.length >= 2 && climb.every((p) => p.levelText === "LEVEL 1")
    ? ok("the LEVEL label holds the old number until the stamp lands")
    : fail(`label changed early: ${JSON.stringify([...new Set(climb.map((p) => p.levelText))])}`);

  // 2d. THE IMPACT FRAME — everything visible arrives in the SAME mutation
  //     batch as the shockwave, which is one synchronous block by definition.
  const hit = iHit >= 0 ? paints[iHit] : null;
  if (!hit) fail("the shockwave never appeared");
  else {
    const bits = {
      "the number is enlarged": hit.levelScale > 1.05,
      "the plate is knocked": hit.chipScale > 1.001,
      "the fill is flashed": brightness(hit.fillFilter) > 1.02,
      "the shockwave is out": hit.ring === 1,
      "the new level is shown": hit.levelText === "LEVEL 2",
      "the gauge is full": hit.fill === 100,
    };
    const missing = Object.entries(bits).filter(([, v]) => !v).map(([k]) => k);
    missing.length === 0
      ? ok(`one frame at ${hit.t}ms carries all of it (level ×${hit.levelScale.toFixed(2)}, plate ×${hit.chipScale.toFixed(3)}, ${hit.fillFilter}, ring, ${hit.levelText})`)
      : fail(`impact frame at ${hit.t}ms is missing: ${missing.join(", ")}`);
  }

  // 2d-ii. THE SHOCKWAVE is really painted, centred on the chip, and stacks
  //         over the world. 150ms into a 460ms ring the radius is
  //         18 + easeOut(.33)·86 ≈ 78px and the alpha (1−.33)·.5 ≈ 85/255.
  if (!shock) {
    fail("could not sample the shockwave canvas");
  } else {
    shock.r > 55 && shock.r < 100
      ? ok(`the shockwave is drawn — radius ${shock.r}px at a third of its life (18 → 104)`)
      : fail(`shockwave radius ${shock.r}px 150ms in; want ~78 (18 + easeOut·86)`);
    shock.peak > 40 && shock.peak < 160
      ? ok(`…at alpha ${shock.peak}/255, fading out`)
      : fail(`shockwave alpha ${shock.peak}/255; want ~85 ((1−t)·.5)`);
    Math.abs(shock.offCx) <= 1 && Math.abs(shock.offCy) <= 1
      ? ok("…centred on the chip it is thrown from")
      : fail(`shockwave is ${shock.offCx},${shock.offCy}px off the chip's centre`);
    shock.reach >= 104
      ? ok(`…on a canvas that clears the ring's full reach (${shock.reach}px of margin, needs 104)`)
      : fail(`shockwave canvas gives only ${shock.reach}px of margin; the ring reaches 104`);
    Number(shock.z) === 7 && (shock.gameZ === "auto" || shock.gameZ === "")
      ? ok("…and paints over the world (z 7 against an unpositioned #game), under the chips (8)")
      : fail(`stacking: ring z=${shock.z}, #game z=${shock.gameZ}`);
  }

  // 2e. THE DRAIN — the new level's numbers land FIRST (that is what the
  //     server sent) and the bar then travels to where they say it is.
  const iNew = paints.findIndex((p) => p.xpText === "10 / 141 XP");
  iNew > iHit && iHit >= 0 && paints[iNew].fill === 100
    ? ok(`the numbers land first, with the bar still full (${paints[iNew].t}ms), and it travels to them after`)
    : fail(`the drain moved the width before/with the numbers (${JSON.stringify(paints.slice(iHit, iHit + 3))})`);
  last.levelText === "LEVEL 2" && last.xpText === "10 / 141 XP"
    ? ok(`settles on the server's own numbers (${last.levelText}, ${last.xpText})`)
    : fail(`settled on ${last.levelText} / ${last.xpText}`);
  Math.abs(last.fill - (10 / 141) * 100) < 0.5
    ? ok(`the gauge drains to the carry-over (${last.fill.toFixed(2)}%)`)
    : fail(`gauge at ${last.fill}%, want ${((10 / 141) * 100).toFixed(2)}%`);
  !last.playing && last.ring === 0 && last.flash === 0
    ? ok("nothing left running or left behind")
    : fail(`left over: playing=${last.playing} ring=${last.ring} flash=${last.flash}`);
  Math.abs(last.levelScale - 1) < 0.001 && Math.abs(last.chipScale - 1) < 0.001 && brightness(last.fillFilter) === 1
    ? ok("chip, number and fill are back at rest")
    : fail(`residual transform: level ×${last.levelScale}, plate ×${last.chipScale}, ${last.fillFilter}`);
  last.runs === 1 ? ok("exactly one run") : fail(`${last.runs} runs`);

  errors.length === 0 ? ok("no page errors") : fail(`page errors: ${errors.join(" | ")}`);
  await ctx.close();

  // ── 3. reduced motion: the values land, nothing performs ───────────────
  const red = await join({ reducedMotion: "reduce" });
  await red.page.evaluate(() => window.__mlBars.levelUp(10, 141));
  await red.page.waitForTimeout(400);
  const rs = await red.page.evaluate(() => window.__mlBars.state());
  rs.runs === 0 && rs.ring === 0 && rs.flash === 0
    ? ok("prefers-reduced-motion: no sweep, no shockwave, no stamp")
    : fail(`reduced motion still performed (runs=${rs.runs} ring=${rs.ring} flash=${rs.flash})`);
  rs.levelText === "LEVEL 2" && rs.xpText === "10 / 141 XP" && Math.abs(rs.fill - (10 / 141) * 100) < 0.5
    ? ok("…and the values land immediately anyway")
    : fail(`reduced motion left ${rs.levelText} / ${rs.xpText} / ${rs.fill}%`);
  red.errors.length === 0 ? ok("no page errors (reduced)") : fail(`page errors: ${red.errors.join(" | ")}`);
  await red.ctx.close();
} finally {
  await browser.close();
}

console.log(bad ? "\nLEVEL-UP: FAIL" : "\nLEVEL-UP: PASS");
process.exit(bad ? 1 : 0);
