// Wiki-style clock verification (UI remake 2026-07-30): the zodiac wheel PNG +
// frame canvas are GONE — the clock is a plain CSS dial (.ml-clock) fixed
// top-centre with a DAY face and a NIGHT face (night opacity 0/1 cross-fades
// over 1.25s) and a slim .ml-clock-hand DIV rotating about the hub. The
// HAND-OFF LOGIC is unchanged and is what this gate protects: each day/night
// boundary winds the hand FORWARD (+360 to the rotate() target — net +180 on
// screen, never backwards, no teleport) while the faces cross-fade; instant
// join-style syncs snap both without animation.
// Drives the REAL client headlessly against a dev stack.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const OUT = process.env.OUT || "/tmp";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const fail = (m) => {
  throw new Error(m);
};
const mod360 = (d) => ((d % 360) + 360) % 360;
try {
  // Device-width mobile geometry — the HUD/visual QA convention since the remake.
  // Device-width mobile geometry, but dsf 1: software-GL at dsf 2 starves the
  // page to ~0.5fps timer slices and every timing observation goes blind.
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 851 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml?.nightShader?.() === true, null, { timeout: 30000 });
  // ms-polled (NOT waitForSelector): the software-GL page starves rAF, which
  // can wedge Playwright's raf-based selector wait even on a visible node.
  await page.waitForFunction(() => !!document.querySelector(".ml-clock .ml-clock-hand"), null, {
    timeout: 15000,
    polling: 100,
  });
  await page.waitForTimeout(1200);

  const handDeg = () =>
    page.evaluate(() => {
      const h = document.querySelector(".ml-clock-hand");
      const m = /rotate\(([-\d.]+)deg\)/.exec(h.style.transform || "rotate(0deg)");
      return m ? +m[1] : 0;
    });
  const nightOpacity = () =>
    page.evaluate(() => +getComputedStyle(document.querySelector(".ml-clock-face.night")).opacity);
  const shotClock = (name) =>
    page.screenshot({ path: `${OUT}/${name}`, clip: { x: 0, y: 0, width: 393, height: 120 } });

  // ---- 1. structure: fixed round CSS dial top-centre, two faces + hand DIV,
  //         1.25s fades wired, zero <img> art, taps pass through ----
  const s = await page.evaluate(() => {
    const root = document.querySelector(".ml-clock");
    const cs = getComputedStyle(root);
    const r = root.getBoundingClientRect();
    const night = document.querySelector(".ml-clock-face.night");
    const hand = document.querySelector(".ml-clock-hand");
    return {
      pos: cs.position,
      pe: cs.pointerEvents,
      radius: cs.borderRadius,
      top: r.top,
      cx: r.left + r.width / 2,
      w: r.width,
      h: r.height,
      vw: innerWidth,
      day: !!root.querySelector(".ml-clock-face.day"),
      nightFade: parseFloat(getComputedStyle(night).transitionDuration),
      handFade: parseFloat(getComputedStyle(hand).transitionDuration),
      handOriginY: getComputedStyle(hand).transformOrigin.split(" ")[1],
      imgs: root.querySelectorAll("img").length,
    };
  });
  if (s.pos !== "fixed" || s.pe !== "none") fail(`dial not a fixed pass-through (${s.pos}/${s.pe})`);
  if (Math.abs(s.top - 8) > 2) fail(`dial top ${s.top}px, want ~8`);
  if (Math.abs(s.cx - s.vw / 2) > 2) fail(`dial centre x ${s.cx} vs viewport mid ${s.vw / 2}`);
  if (Math.abs(s.w - 54) > 1 || Math.abs(s.h - 54) > 1) fail(`dial ${s.w}x${s.h}, want 54x54`);
  if (!(s.radius.includes("50%") || parseFloat(s.radius) >= s.w / 2 - 1)) fail(`dial not round (${s.radius})`);
  if (!s.day) fail("day face missing");
  if (Math.abs(s.nightFade - 1.25) > 0.01) fail(`night-face fade ${s.nightFade}s, want 1.25`);
  if (Math.abs(s.handFade - 1.25) > 0.01) fail(`hand glide ${s.handFade}s, want 1.25`);
  if (s.handOriginY !== "0px") fail(`hand pivot y ${s.handOriginY}, want 0px (hub at dial centre)`);
  if (s.imgs !== 0) fail(`${s.imgs} <img> inside the dial — wheel/hand art should be gone`);
  console.log(`structure OK (54px CSS dial top-centre, 1.25s fades, no art imgs)`);

  // ---- 2. day baseline: day face down (night opacity 0), hand straight down ----
  await page.evaluate(() => window.__ml.timeOfDay(2)); // Day, instant, phaseT pinned 0.5
  await page.waitForTimeout(400);
  const name0 = await page.evaluate(() => window.__ml.timeOfDay().name);
  if (name0 !== "Day") fail(`probe round-trip says ${name0}, want Day`);
  const o0 = await nightOpacity();
  if (o0 > 0.02) fail(`day: night face opacity ${o0}, want 0`);
  const d0 = await handDeg();
  const p0 = mod360(d0);
  if (p0 > 0.5 && p0 < 359.5) fail(`day hand at ${d0}deg (mod ${p0}), want 0 mod 360`);
  await shotClock("clockflip-day.png");
  console.log(`day face OK (night opacity ${o0}, hand ${d0}deg)`);

  // ---- 3. evening -> night: LIVE hand-off cross-fades the face and winds the
  //         hand +360 (net +180 over the top) — no snap, never backwards ----
  // CSS transition EVENTS are the starvation-proof witness of a real fade: a
  // snapped change (transition:none commit) fires none, and transitionend's
  // elapsedTime reports the true 1.25s however late the event is delivered.
  // (Sampling computed opacity misses the whole fade when software-GL starves
  // the page — measured ~2.2s per timer slice at dsf 2.)
  await page.evaluate(() => {
    const night = document.querySelector(".ml-clock-face.night");
    const hand = document.querySelector(".ml-clock-hand");
    const log = (window.__flipLog = {
      nightStart: 0,
      nightEnd: 0,
      nightElapsed: -1,
      handStart: 0,
      handEnd: 0,
      handElapsed: -1,
    });
    night.addEventListener("transitionstart", (e) => e.propertyName === "opacity" && log.nightStart++);
    night.addEventListener("transitionend", (e) => {
      if (e.propertyName !== "opacity") return;
      log.nightEnd++;
      log.nightElapsed = e.elapsedTime;
    });
    hand.addEventListener("transitionstart", (e) => e.propertyName === "transform" && log.handStart++);
    hand.addEventListener("transitionend", (e) => {
      if (e.propertyName !== "transform") return;
      log.handEnd++;
      log.handElapsed = e.elapsedTime;
    });
  });
  const flipLog = () => page.evaluate(() => window.__flipLog);

  await page.evaluate(() => window.__ml.timeOfDay(3, false)); // Evening: same face, no flip
  await page.waitForFunction(() => window.__flipLog.handEnd >= 1, null, { timeout: 25000, polling: 150 });
  const dEve = await handDeg();
  const oEve = await nightOpacity();
  const lEve = await flipLog();
  if (oEve > 0.02) fail(`evening flipped the night face on (${oEve})`);
  if (lEve.nightStart !== 0) fail("evening started a face cross-fade — same parity must keep the day face");
  if (Math.abs(lEve.handElapsed - 1.25) > 0.01) fail(`evening hand glide ran ${lEve.handElapsed}s, want 1.25`);
  if (Math.abs(mod360(dEve) - 71.25) > 1) fail(`evening hand ${dEve} (mod ${mod360(dEve)}), want ~71.25`);
  if (!(dEve > d0)) fail(`hand went backwards day->evening: ${d0} -> ${dEve}`);
  // Trigger the live change; in the SAME task the flip must only be ARMED —
  // the face still dark-off (a live change animates, it never snaps).
  const armed = await page.evaluate(() => {
    window.__ml.timeOfDay(0, false); // Night
    return +getComputedStyle(document.querySelector(".ml-clock-face.night")).opacity;
  });
  if (armed > 0.05) fail(`night face jumped instantly on a live change (${armed}) — no cross-fade`);
  // Mid-cross-fade screenshot, best effort (a starved page may settle first).
  await page
    .waitForFunction(() => window.__flipLog.nightStart >= 1, null, { timeout: 8000, polling: 100 })
    .catch(() => {});
  await shotClock("clockflip-mid.png");
  await page.waitForFunction(() => window.__flipLog.nightEnd >= 1 && window.__flipLog.handEnd >= 2, null, {
    timeout: 25000,
    polling: 150,
  });
  const dN = await handDeg();
  const oN = await nightOpacity();
  const lN = await flipLog();
  if (lN.nightStart < 1) fail("night face never cross-faded (no transitionstart)");
  if (Math.abs(lN.nightElapsed - 1.25) > 0.01) fail(`face cross-fade ran ${lN.nightElapsed}s, want 1.25`);
  if (Math.abs(lN.handElapsed - 1.25) > 0.01) fail(`hand-off glide ran ${lN.handElapsed}s, want 1.25`);
  if (oN < 0.99) fail(`night face opacity ${oN} after the flip, want 1`);
  if (!(dN > dEve)) fail(`hand went backwards at hand-off: ${dEve} -> ${dN} (teleport?)`);
  if (Math.abs(dN - dEve - 288.75) > 1)
    fail(`night flip wound ${dEve} -> ${dN}, want +288.75 (to 0deg with +360 winding)`);
  if (Math.abs(mod360(dN)) > 1 && Math.abs(mod360(dN) - 360) > 1)
    fail(`night hand ${dN} (mod ${mod360(dN)}), want 0 mod 360`);
  await shotClock("clockflip-night.png");
  console.log(`night hand-off OK (1.25s cross-fade to opacity ${oN}, hand ${dEve} -> ${dN})`);

  // ---- 4. night -> morning: flips again (+360 winding), day face returns ----
  await page.evaluate(() => window.__ml.timeOfDay(1, false)); // Morning
  await page.waitForFunction(() => window.__flipLog.nightEnd >= 2 && window.__flipLog.handEnd >= 3, null, {
    timeout: 25000,
    polling: 150,
  });
  const nameM = await page.evaluate(() => window.__ml.timeOfDay().name);
  if (nameM !== "Morning") fail(`probe round-trip says ${nameM}, want Morning`);
  const dM = await handDeg();
  const oM = await nightOpacity();
  if (oM > 0.01) fail(`morning: night face still at ${oM}, want 0 (day face back)`);
  if (Math.abs(dM - dN - 288.75) > 1)
    fail(`morning flip wound ${dN} -> ${dM}, want +288.75 (to -71.25deg with +360 winding)`);
  console.log(`morning hand-off OK (hand ${dN} -> ${dM}, day face back)`);

  // ---- 5. instant join-style sync lands the right face without animation ----
  const inst = await page.evaluate(() => {
    window.__ml.timeOfDay(0); // Night, instant
    const o = +getComputedStyle(document.querySelector(".ml-clock-face.night")).opacity;
    const h = document.querySelector(".ml-clock-hand");
    const im = /rotate\(([-\d.]+)deg\)/.exec(h.style.transform || "");
    const t = getComputedStyle(h).transform; // matrix(a,b,...) — the DRAWN angle
    const mm = /matrix\(([-\d.e]+),\s*([-\d.e]+)/.exec(t) || [0, "1", "0"];
    const drawn = (Math.atan2(+mm[2], +mm[1]) * 180) / Math.PI;
    return { o, d: im ? +im[1] : 0, drawn };
  });
  if (inst.o < 0.99) fail(`instant night: opacity ${inst.o} right after the call — want a snapped 1`);
  if (Math.abs(inst.d - dM - 431.25) > 1)
    fail(`instant night wound ${dM} -> ${inst.d}, want +431.25 (+360 winding, hand to 0)`);
  const drawnMod = mod360(inst.drawn);
  if (drawnMod > 1 && drawnMod < 359) fail(`instant night DRAWN at ${inst.drawn}deg — transition not snapped`);
  // No transition events may fire for a snapped sync (give delivery a moment).
  await page.waitForTimeout(2500);
  const lI = await flipLog();
  if (lI.nightStart !== 2 || lI.handStart !== 3)
    fail(`instant sync animated (face fades ${lI.nightStart}, hand glides ${lI.handStart} — want 2/3)`);
  console.log(`instant night sync OK (opacity ${inst.o}, hand ${inst.d}deg, drawn ${inst.drawn.toFixed(2)})`);

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log("CLOCKFLIP OK — CSS dial cross-fades faces and winds the hand forward at every hand-off");
  console.log("PASS");
} finally {
  await browser.close();
}
