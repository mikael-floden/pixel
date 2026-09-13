// THE CUTOUT. An installed app that draws edge to edge (viewport-fit=cover is
// set in index.html; Chrome's WebAPK started drawing INTO the camera cutout in
// 2026, iOS always has) puts the phone's notch / punch hole / status bar over
// the top of the page and the gesture bar over its bottom. Everything that
// hugs the TOP edge clears it by env(safe-area-inset-top), published ONCE as
// --ml-safe-top (theme.ts, so every surface reads one token): the stat chips
// (bars.ts), the select screen's corner buttons (select.ts), the landscape
// pill stack that hangs under the XP chip (clock.ts / wikibtn.ts /
// wikinear.ts) and the update toast under the chips (main.ts). The HUD pages
// pad their scroll end by --ml-safe-bottom so the last row can scroll clear of
// the gesture bar. AND THE BAND ITSELF IS PAINTED (#ml-safebar, index.html):
// his shell letterboxes the cutout on one launch and hands the app the whole
// screen on the next, so the strip above the chips was black one time and live
// world the next — the card had not moved (198 vs 196 device px on his two
// shots), but it read as floating. The bar wears the letterbox's own #000, so
// the two launches look alike. Both insets are 0 wherever the browser letterboxes the
// cutout or there is none, so the change is INERT there — proven here on the
// same page, before and after, by driving the insets through CDP
// (Emulation.setSafeAreaInsetsOverride) rather than waiting for a device.
import { chromium } from "playwright-core";

const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const TOP = 40; // a punch-hole band; iPhones report 47-59
const BOTTOM = 24; // Android's gesture bar

let bad = false;
const ok = (m) => console.log("ok:", m);
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const near = (a, b, tol = 1) => a != null && b != null && Math.abs(a - b) <= tol;

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
// Device-width mobile geometry, dsf 1 (software GL at dsf 2 starves the page).
const ctx = await browser.newContext({
  viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const cdp = await ctx.newCDPSession(page);
const insets = async (top, bottom) => {
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top, topMax: top, bottom, bottomMax: bottom, left: 0, leftMax: 0, right: 0, rightMax: 0 },
  });
  await page.waitForTimeout(250);
};
const tokens = () => page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  return { top: cs.getPropertyValue("--ml-safe-top").trim(), bottom: cs.getPropertyValue("--ml-safe-bottom").trim() };
});
const rect = (sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { t: r.top, b: r.bottom, l: r.left, r: r.right, h: r.height };
}, sel);
// The anchors transition (.3s) and the starved compositor can report
// mid-flight values long after wall-clock — poll until two frames agree and
// no rotation veil is up (verify-landscape's rule).
const settle = async () => {
  let prev = "";
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(150);
    const now = await page.evaluate(() => {
      if (document.querySelector(".ml-flip-veil")) return `flipping-${Math.random()}`;
      return [".ml-bars-l", ".ml-bars-r", ".ml-clock", ".ml-wikibtn", ".ml-wikinear"]
        .map((s) => { const e = document.querySelector(s); if (!e) return "-"; const r = e.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)}`; })
        .join("|");
    });
    if (now === prev) return;
    prev = now;
  }
};

try {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 25000 });
  await page.waitForSelector("#ml-wiki", { timeout: 25000 });
  await page.waitForTimeout(300);

  // ---- 1. the select screen's corner buttons ----
  let t = await tokens();
  t.top === "0px" && t.bottom === "0px"
    ? ok(`no cutout: the tokens read 0 (${t.top} / ${t.bottom})`)
    : fail(`tokens without a cutout: top "${t.top}" bottom "${t.bottom}", want 0px`);
  const w0 = await rect("#ml-wiki"), th0 = await rect("#ml-theme-btn");
  near(w0?.t, 12) ? ok(`select: Wiki corner at ${w0.t}px (the 12px margin)`) : fail(`select: Wiki corner at ${w0?.t}, want 12`);
  await insets(TOP, BOTTOM);
  t = await tokens();
  t.top === `${TOP}px` && t.bottom === `${BOTTOM}px`
    ? ok(`with a cutout the tokens carry it (${t.top} / ${t.bottom})`)
    : fail(`tokens under a cutout: top "${t.top}" bottom "${t.bottom}", want ${TOP}px / ${BOTTOM}px`);
  const w1 = await rect("#ml-wiki"), th1 = await rect("#ml-theme-btn");
  near(w1?.t, 12 + TOP) ? ok(`select: Wiki corner steps down to ${w1.t}px under the cutout`) : fail(`select: Wiki corner at ${w1?.t}, want ${12 + TOP}`);
  near(th1?.t - w1?.t, th0?.t - w0?.t)
    ? ok(`select: the Theme button keeps its ${(th0.t - w0.t).toFixed(0)}px offset under Wiki (the pair moves together)`)
    : fail(`select: Wiki/Theme offset changed ${th0?.t - w0?.t} -> ${th1?.t - w1?.t}`);
  await insets(0, 0);

  // ---- 2. in the world, portrait: the stat chips and the page's scroll end ----
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector("#ml-loading"), null, { timeout: 30000 });
  await page.evaluate(() => document.querySelector('[data-tab="settings"]')?.click());
  await settle();
  const pagePad = () => page.evaluate(() => {
    const p = document.querySelector(".ml-page.show");
    return p ? parseFloat(getComputedStyle(p).paddingBottom) : null;
  });
  const l0 = await rect(".ml-bars-l"), r0 = await rect(".ml-bars-r");
  near(l0?.t, 10) && near(r0?.t, 10)
    ? ok(`chips at ${l0.t}px / ${r0.t}px without a cutout (the 10px margin)`)
    : fail(`chips at ${l0?.t} / ${r0?.t} without a cutout, want 10`);
  const pad0 = await pagePad();
  await insets(TOP, BOTTOM);
  await settle();
  const l1 = await rect(".ml-bars-l"), r1 = await rect(".ml-bars-r");
  near(l1?.t, 10 + TOP) && near(r1?.t, 10 + TOP)
    ? ok(`chips step down to ${l1.t}px / ${r1.t}px under a ${TOP}px cutout`)
    : fail(`chips at ${l1?.t} / ${r1?.t} under the cutout, want ${10 + TOP}`);
  const pad1 = await pagePad();
  near(pad1, pad0 + BOTTOM)
    ? ok(`the page's scroll end grows by the ${BOTTOM}px gesture bar (${pad0} -> ${pad1}px)`)
    : fail(`page padding-bottom ${pad0} -> ${pad1}, want +${BOTTOM}`);
  await insets(0, 0);
  await settle();
  const l2 = await rect(".ml-bars-l");
  const pad2 = await pagePad();
  near(l2?.t, 10) && near(pad2, pad0)
    ? ok("…and back to the plain geometry when the cutout goes (inert where there is none)")
    : fail(`after clearing the insets: chip top ${l2?.t} (want 10), page padding ${pad2} (want ${pad0})`);

  // ---- 3. right-handed landscape: the pill stack hangs under the XP chip ----
  await page.setViewportSize({ width: 851, height: 393 });
  await page.waitForFunction(() => document.documentElement.classList.contains("ml-land"), null, { timeout: 15000 });
  await settle();
  const stack = async () => {
    const r = await rect(".ml-bars-r"), c = await rect(".ml-clock"), w = await rect(".ml-wikibtn"), n = await rect(".ml-wikinear");
    const step = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ml-stack-step")));
    return { r, c, w, n, step };
  };
  const s0 = await stack();
  near(s0.c?.t - s0.r?.b, 10) ? ok(`landscape: the pill hangs 10px under the XP chip (chip bottom ${s0.r.b}, pill top ${s0.c.t})`) : fail(`landscape: pill top ${s0.c?.t} vs chip bottom ${s0.r?.b}, want a 10px gap`);
  await insets(TOP, 0);
  await settle();
  const s1 = await stack();
  near(s1.r?.t, 10 + TOP) ? ok(`landscape: the XP chip steps down to ${s1.r.t}px`) : fail(`landscape: XP chip at ${s1.r?.t}, want ${10 + TOP}`);
  near(s1.c?.t - s1.r?.b, 10)
    ? ok(`landscape: the pill keeps its 10px under the moved chip (${s1.r.b} -> ${s1.c.t})`)
    : fail(`landscape: pill top ${s1.c?.t} vs chip bottom ${s1.r?.b} under the cutout — the stack did not take the inset`);
  near(s1.w?.t - s1.c?.t, s1.step) && near(s1.n?.t - s1.c?.t, s1.step)
    ? ok(`landscape: Wiki and 🔍 stay one ${s1.step}px step under the pill`)
    : fail(`landscape: Wiki ${s1.w?.t} / 🔍 ${s1.n?.t} vs pill ${s1.c?.t}, want +${s1.step}`);
  await insets(0, 0);
  await page.setViewportSize({ width: 393, height: 851 });
  await settle();

  // ---- 4. the painted band: zero where there is no cutout, the cutout's own
  //         height where there is one, opaque black, and never over the chips ----
  const bar = () => page.evaluate(() => {
    const e = document.querySelector("#ml-safebar");
    if (!e) return null;
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    const chip = document.querySelector(".ml-bars-l")?.getBoundingClientRect() ?? null;
    return { top: r.top, h: r.height, w: r.width, bg: cs.backgroundColor, pe: cs.pointerEvents,
             vw: window.innerWidth, chipTop: chip ? chip.top : null };
  });
  const b0 = await bar();
  if (!b0) { fail("no #ml-safebar in the page — the cutout band is unpainted"); }
  else {
    b0.h === 0 ? ok("band: no cutout, no paint (0px)") : fail(`band is ${b0.h}px tall without a cutout — it must collapse`);
    await insets(TOP, BOTTOM);
    await settle();
    const b1 = await bar();
    near(b1.h, TOP) && near(b1.top, 0) && near(b1.w, b1.vw)
      ? ok(`band covers the ${TOP}px cutout, full width, at the top`)
      : fail(`band is ${b1.w}x${b1.h} at y ${b1.top}, wanted ${b1.vw}x${TOP} at 0`);
    b1.bg === "rgb(0, 0, 0)"
      ? ok("band wears the letterbox's own black")
      : fail(`band background ${b1.bg}, wanted the shell letterbox's rgb(0, 0, 0)`);
    b1.pe === "none" ? ok("band takes no pointer events (a tap there still reaches the world)") : fail(`band pointer-events ${b1.pe}, wanted none`);
    b1.chipTop != null && b1.chipTop >= b1.h
      ? ok(`the chips start below it (${b1.chipTop} >= ${b1.h}) — it can never cover the HP numbers`)
      : fail(`the band (${b1.h}px) reaches over the chips at ${b1.chipTop}`);
    await insets(0, 0);
    await settle();
    const b2 = await bar();
    b2.h === 0 ? ok("…and collapses again when the cutout goes") : fail(`band stayed ${b2.h}px after the insets cleared`);
  }

  errors.length === 0 ? ok("no page errors") : fail(`page errors: ${errors.join(" | ")}`);
} catch (e) {
  fail(`threw: ${e.message}`);
} finally {
  await browser.close();
}
if (bad) { console.log("verify-safearea: FAIL"); process.exit(1); }
console.log("verify-safearea: OK");
