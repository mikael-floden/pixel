// Verify chat: one client sends a message, another receives it as a bubble.
// WIKI-STYLE UI (2026-07-30): the ChatUI overlay (.ml-chatlog/.ml-chatinput)
// is plain CSS anchored in real px above --hud-h (published by hud.ts
// applyLayout as round(innerHeight*0.382)): log bottom = hud-h + 40,
// input bottom = hud-h + 10, both left 10px. There is NO zoom compensation
// any more (--ml-uizoom is never written) — the old kit-frame geometry
// assertions are replaced by these wiki-style equivalents.
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.OUT || "/tmp";

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
async function join() {
  // SMALL viewport (the repo's e2e starvation rule): two concurrent WebGL
  // clients at 900×600 starve headless GL past every join timeout.
  const ctx = await browser.newContext({ viewport: { width: 480, height: 320 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("http://localhost:5173/", { waitUntil: "load" });
  // Auto-enter via the select screen's commit hook. NB: waitForFunction's
  // options ride the THIRD slot — the old `(fn, {timeout})` put them in the
  // arg slot and silently used the 30s default.
  await page.waitForFunction(() => window.__mlSelect, null, { timeout: 20000 });
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForFunction(() => window.__ml && window.__ml.players() >= 1, null, { timeout: 60000 });
  return page;
}
try {
  const p1 = await join();
  const p2 = await join();
  await p1.waitForFunction(() => window.__ml.players() >= 2, null, { timeout: 20000 });
  await p2.waitForFunction(() => window.__ml.players() >= 2, null, { timeout: 20000 });
  await p1.waitForTimeout(1000);

  const MSG = "hello nangijala!";
  await p1.evaluate((m) => window.__ml.say(m), MSG);

  // p2 should receive the broadcast and show a bubble carrying the text.
  // Read the list IMMEDIATELY after the wait — bubbles live BUBBLE_MS (5s of
  // game time), and a starvation-slow screenshot between wait and read used
  // to outlive the bubble and fake "not received".
  await p2.waitForFunction((m) => window.__ml.bubbles().includes(m), MSG, { timeout: 15000 });
  const seen = await p2.evaluate(() => window.__ml.bubbles());
  console.log("RESULT " + JSON.stringify({ seen }));
  if (!seen.includes(MSG)) throw new Error("chat bubble not received by other client");
  console.log("CHAT OK");

  // ── geometry: the wiki-style overlay anchors (plain px above --hud-h) ──
  const geo = await p2.evaluate((m) => {
    const root = document.documentElement;
    const hudRaw = getComputedStyle(root).getPropertyValue("--hud-h").trim();
    const hudH = Math.round(parseFloat(hudRaw));
    const log = document.querySelector(".ml-chatlog");
    const input = document.querySelector(".ml-chatinput");
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, bottomGap: window.innerHeight - r.bottom };
    };
    let inputRect = null;
    if (input) {
      // the input is display:none until Enter opens it — flash it visible to
      // measure its resting anchor, then restore (pure measurement, no focus).
      const prev = input.style.display;
      input.style.display = "block";
      inputRect = rectOf(input);
      input.style.display = prev;
    }
    const lines = [...document.querySelectorAll(".ml-chatlog .ml-chatline")];
    return {
      innerH: window.innerHeight,
      hudRaw,
      hudH,
      uizoom: getComputedStyle(root).getPropertyValue("--ml-uizoom").trim(),
      logPos: log ? getComputedStyle(log).position : null,
      logRect: log ? rectOf(log) : null,
      inputPos: input ? getComputedStyle(input).position : null,
      inputRect,
      lineCount: lines.length,
      msgShown: lines.some((l) => (l.textContent || "").includes(m)),
    };
  }, MSG);
  console.log("GEO " + JSON.stringify(geo));

  const near = (a, b, tol = 1) => a != null && Math.abs(a - b) <= tol;
  if (!/px$/.test(geo.hudRaw)) throw new Error(`--hud-h not real px: "${geo.hudRaw}"`);
  if (!near(geo.hudH, Math.round(geo.innerH * 0.382)))
    throw new Error(`--hud-h ${geo.hudH} != 38.2% of ${geo.innerH}`);
  // NO zoom compensation in the chat overlay: chat.ts never reads
  // --ml-uizoom and the plain-px anchor equalities below prove it (a
  // compensating anchor would divide by the factor). NB the VARIABLE itself
  // may still appear on :root — uiscale.ts applyUiZoom (surviving for the
  // loading overlay / reconnect toast / roster) publishes it as a side
  // effect even though nothing consumes it any more — so we assert the
  // ANCHORS, not the var's absence.
  console.log(`uizoom var (dead, unconsumed): "${geo.uizoom}"`);
  if (geo.logPos !== "fixed" || geo.inputPos !== "fixed")
    throw new Error(`overlay not fixed-positioned (log=${geo.logPos}, input=${geo.inputPos})`);
  if (!near(geo.logRect.left, 10)) throw new Error(`chatlog left ${geo.logRect.left} != 10px`);
  if (!near(geo.logRect.bottomGap, geo.hudH + 40))
    throw new Error(`chatlog bottom gap ${geo.logRect.bottomGap} != hud-h+40 (${geo.hudH + 40})`);
  if (!near(geo.inputRect.left, 10)) throw new Error(`chatinput left ${geo.inputRect.left} != 10px`);
  if (!near(geo.inputRect.bottomGap, geo.hudH + 10))
    throw new Error(`chatinput bottom gap ${geo.inputRect.bottomGap} != hud-h+10 (${geo.hudH + 10})`);
  if (geo.lineCount < 1 || !geo.msgShown)
    throw new Error(`chat overlay log missing the message chip (lines=${geo.lineCount}, shown=${geo.msgShown})`);
  console.log("GEO OK");
  await p2.screenshot({ path: `${OUT}/chat.png` });
  console.log("PASS");
} finally {
  await browser.close();
}
