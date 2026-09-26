// QA: THE COMPASS AND THE CUBE (client/src/spinbar.ts) and the SWIPE that
// turns the view (maintainer 2026-09-26, his picks from ten CSS designs: "I
// want the cube from B3 Pill medallion and the compass from A1 Faceted rose …
// It should also be in sync with the rotation"; and "To navigate to a
// position/marker the player will need to double tap! This frees up the swipe
// input in the game view!").
//
// WHAT IT HOLDS: the compass is the search button's box, 10px left of the pill
// on its line; the cube is centred on the game view and in the HP/XP gap,
// invisible at rest, shown while a turn runs and gone after it lands; neither
// is a button, no arrow is visible, and both are CSS (no image); the needle is
// a heading (+90° a quarter) and the cube turns with it; both follow the
// world's published angle the moment it arrives; the rotation arithmetic (a
// turn is a quarter and lands on it, right then left returns, turns
// accumulate, a reversal mid-flight never goes the long way); and the
// gesture: a swipe turns nothing until the world walks on a double tap
// (tapgesture.ts arms it), then a quick sideways one-finger swipe turns it and
// the second tap of a double tap never does.
//
// IT DOES NOT SAMPLE A FRAME MID-FLIGHT. The headless compositor here is
// starved to ~1 s frames, so one rAF can carry the whole 360 ms animation; the
// target arithmetic is synchronous, so the gate asserts the target, then the
// landing.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => fail(`page error: ${e.message}`));
await page.goto(`${BASE}/`, { waitUntil: "load" });
await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
await page.evaluate(() => window.__mlSelect.commit());
// THE CUBE'S OWN CLOCK: while the world turns the cube follows it (ml-view-angle,
// spinbar.ts), and this software browser's turns would set every pace below.
// The coupling is the view turn's gate; this one holds the cube's arithmetic.
await page.evaluate(() => { window.__mlSpinFollow = false; });
await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 120000 });
await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 90000 });
await page.waitForFunction(() => document.querySelector(".ml-spinbar") && document.querySelector(".ml-clock"), null, { timeout: 30000 });
await page.waitForFunction(() => window.__mlSpin, null, { timeout: 30000 });

// ── 1. WHERE THEY SIT ──────────────────────────────────────────────────────
const geom = () => page.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); if (!e) return null;
    const b = e.getBoundingClientRect();
    return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height, cx: b.left + b.width / 2 }; };
  const cs = getComputedStyle(document.documentElement);
  return { pill: r(".ml-clock"), box: r(".ml-spinneedle-box"), orb: r(".ml-spinorb"), game: r("#game"),
    xp: r(".ml-bars-r"), near: r(".ml-wikinear"), safe: parseFloat(cs.getPropertyValue("--ml-safe-top")) || 0 };
});
const assertPlace = (g, label) => {
  g.pill && g.box && Math.abs(g.box.r - (g.pill.l - 10)) <= 1 && Math.abs((g.box.t + g.box.b) / 2 - (g.pill.t + g.pill.b) / 2) <= 1
    ? ok(`${label}: the compass stands 10px left of the pill, on its line (right ${g.box.r.toFixed(0)} vs pill left ${g.pill.l.toFixed(0)})`)
    : fail(`${label}: compass ${JSON.stringify(g.box)} vs pill ${JSON.stringify(g.pill)}`);
  g.box && g.near && Math.abs(g.box.w - g.near.w) <= 0.5 && Math.abs(g.box.h - g.near.h) <= 0.5
    ? ok(`${label}: the compass is the search button's size (${g.box.w}x${g.box.h})`)
    : fail(`${label}: compass ${g.box?.w}x${g.box?.h} vs search ${g.near?.w}x${g.near?.h}`);
  // the cube's rect is scaled at rest (the fade), so its CENTRE is compared
  const cy = g.orb && (g.orb.t + g.orb.b) / 2;
  g.orb && g.game && g.xp && Math.abs(g.orb.cx - g.game.cx) <= 1 && Math.abs(cy - (g.xp.t + g.xp.b) / 2) <= 1.5
    ? ok(`${label}: the cube sits at the game view's centre line, level with the cards (${g.orb.cx.toFixed(0)} vs ${g.game.cx.toFixed(0)}, mid ${cy.toFixed(0)})`)
    : fail(`${label}: cube ${JSON.stringify(g.orb)} vs game view ${JSON.stringify(g.game)} / XP ${JSON.stringify(g.xp)}`);
};
{
  await page.waitForTimeout(600);
  assertPlace(await geom(), "portrait");
  const v = await page.evaluate(() => ({
    op: getComputedStyle(document.querySelector(".ml-spinorb")).opacity,
    shown: window.__mlSpin().cubeShown,
    arrows: [...document.querySelectorAll(".ml-spinbtn")].filter((e) => e.getBoundingClientRect().width > 0).length,
    pe: [".ml-spinorb", ".ml-spinneedle", ".ml-spinneedle-box"].map((q) => getComputedStyle(document.querySelector(q)).pointerEvents),
  }));
  v.op === "0" && !v.shown
    ? ok("the cube is invisible at rest")
    : fail(`the cube at rest: opacity ${v.op}, shown ${v.shown}`);
  v.arrows === 0 ? ok("no arrow button is visible") : fail(`${v.arrows} arrow buttons are visible`);
  v.pe.every((x) => x === "none") ? ok("neither the cube nor the compass takes a touch") : fail(`pointer-events: ${v.pe.join(",")}`);
}

// ── 2. CSS, NOT ART: the search button's chrome, a real 3D cube ───────────
{
  const c = await page.evaluate(() => {
    const bar = document.querySelector(".ml-spinbar");
    const imgs = [...bar.querySelectorAll("*")].filter((e) => e.tagName === "IMG" || getComputedStyle(e).backgroundImage.includes("url("));
    const box = getComputedStyle(document.querySelector(".ml-spinneedle-box"));
    const near = getComputedStyle(document.querySelector(".ml-wikinear"));
    const keys = ["borderTopWidth", "borderTopColor", "borderTopLeftRadius", "backgroundColor", "backdropFilter"];
    const faces = [...document.querySelectorAll(".ml-spinorb-f")];
    const lit = ["fr", "lt"].map((f) => parseFloat(document.querySelector(`.ml-spinorb-f.${f}`).style.getPropertyValue("--lit")));
    return { imgs: imgs.map((e) => e.className), diff: keys.filter((k) => box[k] !== near[k]).map((k) => `${k}: ${box[k]} vs ${near[k]}`),
      faces: faces.length, p3d: getComputedStyle(document.querySelector(".ml-spinorb-cube")).transformStyle, lit };
  });
  c.imgs.length === 0 ? ok("the compass and the cube are CSS: no image anywhere in them") : fail(`images in the bar: ${c.imgs.join(", ")}`);
  c.diff.length === 0 ? ok("the compass wears the search button's border, radius and frosted glass") : fail(`compass vs search: ${c.diff.join("; ")}`);
  c.faces === 6 && c.p3d === "preserve-3d" ? ok("the cube is six faces in a preserve-3d space") : fail(`cube: ${c.faces} faces, transform-style ${c.p3d}`);
  c.lit.every((x) => x >= 0 && x <= 1) && Math.abs(c.lit[0] - c.lit[1]) > 0.05
    ? ok(`its sides are lit by their angle (front ${c.lit[0]}, left ${c.lit[1]})`)
    : fail(`side light: ${c.lit.join(", ")}`);
}

// ── 3. THE ROTATION: a press is a quarter, and it lands on the boundary ────
{
  // A TAP MOVES THE TARGET, it does not queue an animation — everything below
  // is that one fact. The target arithmetic is synchronous inside the click
  // handler, so these arms read it directly instead of racing the compositor.
  const tap = (sel, n = 1) => page.evaluate(([s, n]) => {
    const before = window.__mlSpin();
    for (let i = 0; i < n; i++) window.__mlSpinTurn(s.includes("left") ? -1 : 1);
    return { before, after: window.__mlSpin() };
  }, [sel, n]);
  // 60s, and it is not slack: the loop clamps dt to 200 ms so a backgrounded
  // tab cannot teleport the orb, and this harness's frames are ~1 s apart, so
  // every real second of travel costs about five here. A 360° journey is 1.6 s
  // on a phone and ~8 s in this browser. Do not tighten it back to a number
  // that looks like the animation's own duration.
  const settle = async () => {
    await page.waitForFunction(() => !window.__mlSpin().spinning, null, { timeout: 60000 });
    return page.evaluate(() => window.__mlSpin());
  };

  {
    const t = await tap(".ml-spinbtn.right");
    t.after.targetQ - t.before.targetQ === 1 && t.after.spinning
      ? ok(`one tap puts the target a quarter ahead at once and starts the travel`)
      : fail(`one tap moved the target ${t.after.targetQ - t.before.targetQ} quarters, spinning=${t.after.spinning}`);
    const r = await settle();
    r.quarter === 1 && r.curQ === r.targetQ
      ? ok(`right lands exactly a quarter on — "a perfect 90° rotation"`)
      : fail(`right settled at quarter ${r.quarter}, curQ ${r.curQ} vs targetQ ${r.targetQ}`);
    const l = await tap(".ml-spinbtn.left"); void l;
    const back = await settle();
    back.quarter === 0 && back.curQ === 0
      ? ok(`left plays it backwards and returns it (quarter 0)`)
      : fail(`left settled at quarter ${back.quarter}, curQ ${back.curQ}`);
  }

  // ── TAPS ACCUMULATE: "twice… 180°. 3 taps = 270°. 4 taps = 360°" ─────────
  for (const [n, deg] of [[2, 180], [3, 270], [4, 360]]) {
    const t = await tap(".ml-spinbtn.right", n);
    const moved = t.after.targetQ - t.before.targetQ;
    moved === n
      ? ok(`${n} quick taps ask for ${deg}° of travel (target moved ${moved} quarters, not normalised to ${deg % 360}°)`)
      : fail(`${n} taps moved the target ${moved} quarters — they must accumulate to ${deg}°`);
    const r = await settle();
    r.curQ === r.targetQ && r.quarter === ((n % 4) + 4) % 4
      ? ok(`…and it travels all of it, landing on quarter ${r.quarter}`)
      : fail(`after ${n} taps it settled at curQ ${r.curQ} (target ${r.targetQ}), quarter ${r.quarter}`);
    // put it back for the next round, in one journey
    await tap(".ml-spinbtn.left", n);
    await settle();
  }

  // A settled position is reduced by a whole turn (spinbar.ts), so -1 quarter
  // reads back as 3. Mid-flight values are unwrapped; settled ones are not.
  const wrapQ = (q) => ((q % 4) + 4) % 4;

  // ── REVERSING MID-FLIGHT ─────────────────────────────────────────────────
  // "if the player presses the left arrow and then the right arrow during the
  // animation the animation should change animation direction immidiatly and
  // go back to the original position."
  // Driven as a FOUR-quarter journey, not one: a single quarter is ~2 frames
  // on this starved harness and the interrupt can fall between polls. Four is
  // the same code path with room to actually catch it in flight.
  {
    const home = (await page.evaluate(() => window.__mlSpin())).targetQ;
    await tap(".ml-spinbtn.left", 4);
    await page.waitForFunction(
      (h) => { const s = window.__mlSpin(); return s.spinning && s.curQ < h - 0.2; },
      home, { timeout: 30000, polling: 50 },
    ).catch(() => fail("the compass never showed up mid-flight — nothing to interrupt"));
    const mid = await tap(".ml-spinbtn.right", 4);
    mid.after.targetQ === home
      ? ok(`tapping the other way mid-flight puts the target straight back (${mid.before.targetQ} -> ${mid.after.targetQ})`)
      : fail(`the reverse taps left the target at ${mid.after.targetQ}, not the original ${home}`);
    mid.after.curQ < home && mid.after.curQ > home - 4
      ? ok(`…while the orb is still part-way round (curQ ${mid.after.curQ.toFixed(2)}), so it has a short way home`)
      : fail(`at the reverse tap the orb was at curQ ${mid.after.curQ} — expected between ${home - 4} and ${home}`);
    const r = await settle();
    r.curQ === wrapQ(home)
      ? ok(`and it turns round on the spot rather than finishing the lap: back at curQ ${r.curQ}`)
      : fail(`after the reversal it settled at curQ ${r.curQ} — wanted ${wrapQ(home)}`);
  }

  // ── NEVER THE LONG WAY ROUND ─────────────────────────────────────────────
  // "the rotation should always [take] the shortest rotation towards the goal
  // and not spin around if going backwards is a shorter rotational distance."
  // With an UNWRAPPED target the long way is not expressible, so the arm is
  // that the travel equals the target's own distance — never that plus a turn.
  {
    const a = await page.evaluate(() => window.__mlSpin());
    await tap(".ml-spinbtn.left", 3);
    await tap(".ml-spinbtn.right", 2); // net one quarter left, asked in two bursts
    const t = await page.evaluate(() => window.__mlSpin());
    t.targetQ === a.targetQ - 1
      ? ok(`bursts net out on the target (3 left + 2 right = one quarter left)`)
      : fail(`3 left + 2 right left the target at ${t.targetQ}, not ${a.targetQ - 1}`);
    const r = await settle();
    r.curQ === wrapQ(a.targetQ - 1)
      ? ok(`…and the orb travels exactly that, never a turn more (curQ ${r.curQ})`)
      : fail(`it settled at curQ ${r.curQ}, wanted ${wrapQ(a.targetQ - 1)}`);
    await tap(".ml-spinbtn.right");
    await settle();
  }
}

// ── 4. THE CUBE SHOWS FOR A TURN, THE NEEDLE IS A HEADING, BOTH IN SYNC ──
{
  const a = await page.evaluate(() => { window.__mlSpinTurn(1); return window.__mlSpin(); });
  a.cubeShown ? ok("a turn shows the cube at once") : fail("a turn did not show the cube");
  await page.waitForFunction(() => !window.__mlSpin().spinning, null, { timeout: 60000 });
  // FADE_HOLD_MS + the fade — a wait, not a sleep: this harness starves timers
  await page.waitForFunction(() => !window.__mlSpin().cubeShown, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  const b = await page.evaluate(() => ({ ...window.__mlSpin(), op: getComputedStyle(document.querySelector(".ml-spinorb")).opacity }));
  // the class, not the opacity: this compositor can sit mid-transition for
  // seconds (the rest-state opacity 0 is asserted in section 1)
  !b.cubeShown
    ? ok("…and fades it out after the turn lands")
    : fail(`after the turn the cube is still shown (opacity ${b.op})`);
  const want = b.curQ * 90;
  Math.abs(b.needleDeg - want) < 0.01 && Math.abs(b.cubeDeg - (45 + want)) < 0.01
    ? ok(`the needle heads ${b.needleDeg}° at quarter ${b.curQ} (90° a quarter) and the cube stands at ${b.cubeDeg}° with it`)
    : fail(`needle ${b.needleDeg}°, cube ${b.cubeDeg}°, want ${want}° / ${45 + want}°`);
  // what is DRAWN, read back off the needle's own transform
  const drawn = await page.evaluate(() => {
    const m = new DOMMatrix(getComputedStyle(document.querySelector(".ml-spinneedle")).transform);
    return (Math.atan2(m.b, m.a) * 180) / Math.PI;
  });
  Math.abs((((drawn - want) % 360) + 540) % 360 - 180) < 0.5
    ? ok(`…and that is the angle on screen (${drawn.toFixed(1)}°)`)
    : fail(`the needle is drawn at ${drawn}°, want ${want}°`);
  await page.evaluate(() => window.__mlSpinTurn(-1));
  await page.waitForFunction(() => !window.__mlSpin().spinning, null, { timeout: 60000 });
  // IN SYNC: the world's angle is drawn the moment it arrives, not a frame
  // later — half-way through the world's turn, the needle is half-way too
  const sync = await page.evaluate(() => {
    window.__mlSpinFollow = true;
    const t0 = window.__mlSpin().targetQ;
    window.__mlSpinTurn(1);
    window.dispatchEvent(new CustomEvent("ml-view-angle", { detail: { q: t0 + 0.5, goal: t0 + 1, busy: true } }));
    const s = window.__mlSpin();
    window.dispatchEvent(new CustomEvent("ml-view-angle", { detail: { q: t0 + 1, goal: t0 + 1, busy: false } }));
    window.__mlSpinFollow = false;
    return { t0, curQ: s.curQ, needle: s.needleDeg, cube: s.cubeDeg, shown: s.cubeShown };
  });
  Math.abs(sync.curQ - (sync.t0 + 0.5)) < 1e-6 && Math.abs(sync.needle - (sync.t0 + 0.5) * 90) < 1e-6 && sync.shown
    ? ok(`both follow the world: at its half-way (q ${sync.t0 + 0.5}) the needle reads ${sync.needle}° and the cube ${sync.cube}°, shown`)
    : fail(`with the world at ${sync.t0 + 0.5}: curQ ${sync.curQ}, needle ${sync.needle}°, shown ${sync.shown}`);
  await page.waitForFunction(() => !window.__mlSpin().spinning, null, { timeout: 60000 });
  await page.evaluate(() => window.__mlSpinTurn(-1));
  await page.waitForFunction(() => !window.__mlSpin().spinning, null, { timeout: 60000 });
}

// ── 5. THE GESTURE: armed by the world, a swipe turns, a double tap never ─
{
  const gesture = (kind, dir = 1) => page.evaluate(([kind, dir]) => {
    const cv = document.querySelector("#game canvas");
    const r = cv.getBoundingClientRect();
    const y = r.top + r.height * 0.55;
    const pe = (type, x) => new PointerEvent(type, { pointerId: 9, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true });
    const x0 = r.left + r.width / 2 - dir * 110;
    const before = window.__mlSpin().targetQ;
    if (kind === "swipe") {
      cv.dispatchEvent(pe("pointerdown", x0));
      for (let i = 1; i <= 6; i++) cv.dispatchEvent(pe("pointermove", x0 + dir * 220 * i / 6));
      cv.dispatchEvent(pe("pointerup", x0 + dir * 220));
    } else {
      // tap, then a second touch-down 100 ms later that flicks sideways: the
      // walk's (it steers the trip), never a swipe
      cv.dispatchEvent(pe("pointerdown", x0)); cv.dispatchEvent(pe("pointerup", x0));
      const u = performance.now() + 100; while (performance.now() < u);
      cv.dispatchEvent(pe("pointerdown", x0));
      cv.dispatchEvent(pe("pointerup", x0 + dir * 220));
    }
    return window.__mlSpin().targetQ - before;
  }, [kind, dir]);
  // NOT ARMED until the world walks on a double tap: a swipe would be a walk too
  const armed = await page.evaluate(() => window.__mlSpin().swipeArmed);
  if (!armed) {
    const u = await gesture("swipe", -1);
    u === 0 ? ok("while the world still walks on a single tap, a swipe turns nothing") : fail(`an unarmed swipe moved the target ${u}`);
    // the world's question, asked exactly as WorldScene's pointerdown asks it
    await page.evaluate(async () => { (await import("/src/tapgesture.ts")).isSecondTap(); });
    (await page.evaluate(() => window.__mlSpin().swipeArmed))
      ? ok("the world asking tapgesture.isSecondTap() arms the swipe")
      : fail("isSecondTap() did not arm the swipe");
    await page.waitForTimeout(500);
  } else ok("the world walks on a double tap: the swipe is armed");
  const l = await gesture("swipe", -1);
  l === -1 ? ok("a left swipe on the world turns it a quarter left") : fail(`a left swipe moved the target ${l}`);
  await page.waitForFunction(() => !window.__mlSpin().spinning, null, { timeout: 60000 });
  const r = await gesture("swipe", 1);
  r === 1 ? ok("…a right swipe a quarter right") : fail(`a right swipe moved the target ${r}`);
  await page.waitForFunction(() => !window.__mlSpin().spinning, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const d = await gesture("double", 1);
  d === 0 ? ok("the second tap of a double tap is the walk's, never a swipe") : fail(`a double tap with a flick turned the view ${d}`);
}

// ── 6. LANDSCAPE: both follow their anchors ────────────────────────────────
{
  await page.setViewportSize({ width: 851, height: 393 });
  await page.waitForTimeout(1500); // the rotation snaps under a veil (hud.ts)
  assertPlace(await geom(), "landscape");
}

await browser.close();
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
