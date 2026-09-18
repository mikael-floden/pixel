// Verify chat: one client sends a message, another receives it as a bubble.
// WIKI-STYLE UI (2026-07-30): the ChatUI overlay (.ml-chatlog/.ml-chatinput)
// is plain CSS anchored in real px above --hud-h (published by hud.ts
// applyLayout as round(innerHeight*0.382)). ONE MARGIN FOR EVERYTHING that
// hugs an edge (maintainer 2026-07-31): 10px, the same as the stat chips at
// the top and the Wiki row — which this gate checks by comparing against
// that row itself, not a literal. Since 2026-09-17 the row lives TOP-right
// under the XP chip with the time-of-day pill one published --ml-stack-step
// under it (the bottom corner is the portrait ghost stick's), so the log has
// its bottom line to itself. The log only steps up (ml-chat-typing) while the
// input box is open under it.
// There is NO zoom compensation any more (--ml-uizoom is never written).
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
    const clock = document.querySelector(".ml-clock");
    const wiki = document.querySelector(".ml-wikibtn");
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
      // the Wiki row — the shared margin's reference — top-right, and the
      // pill one published step under it
      wikiRect: wiki
        ? { rightGap: window.innerWidth - wiki.getBoundingClientRect().right,
            top: wiki.getBoundingClientRect().top }
        : null,
      clockRect: clock
        ? { rightGap: window.innerWidth - clock.getBoundingClientRect().right,
            top: clock.getBoundingClientRect().top }
        : null,
      step: parseFloat(getComputedStyle(root).getPropertyValue("--ml-stack-step")),
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
  if (!near(geo.logRect.bottomGap, geo.hudH + 10))
    throw new Error(`chatlog bottom gap ${geo.logRect.bottomGap} != hud-h+10 (${geo.hudH + 10})`);
  if (!near(geo.inputRect.left, 10)) throw new Error(`chatinput left ${geo.inputRect.left} != 10px`);
  if (!near(geo.inputRect.bottomGap, geo.hudH + 10))
    throw new Error(`chatinput bottom gap ${geo.inputRect.bottomGap} != hud-h+10 (${geo.hudH + 10})`);
  // The point of that number: the chat and the Wiki row sit on ONE margin —
  // the row's right gap is the chat's left gap — and the row itself is
  // top-right under the XP chip with the pill one published step under it.
  if (!geo.wikiRect) throw new Error("no .ml-wikibtn to compare the chat's margin against");
  if (!geo.clockRect) throw new Error("no .ml-clock under the Wiki row");
  if (!(geo.step > 0)) throw new Error(`--ml-stack-step "${geo.step}" is not a published px height`);
  if (!near(geo.wikiRect.rightGap, geo.logRect.left))
    throw new Error(`chat left ${geo.logRect.left} != Wiki row right ${geo.wikiRect.rightGap}`);
  if (!(geo.wikiRect.top < geo.innerH / 2))
    throw new Error(`Wiki row at top ${geo.wikiRect.top} — in portrait it lives top-right under the XP chip`);
  if (!near(geo.clockRect.rightGap, geo.wikiRect.rightGap))
    throw new Error(`pill right ${geo.clockRect.rightGap} != Wiki row right ${geo.wikiRect.rightGap} — one right edge`);
  if (!near(geo.clockRect.top, geo.wikiRect.top + geo.step))
    throw new Error(`pill top ${geo.clockRect.top} != Wiki row top ${geo.wikiRect.top} + the ${geo.step}px stack step`);
  console.log(`MARGIN OK — chat left and the Wiki row's right share ${geo.wikiRect.rightGap}px to the edge; the pill hangs ${geo.step}px under the row, top-right`);
  if (geo.lineCount < 1 || !geo.msgShown)
    throw new Error(`chat overlay log missing the message chip (lines=${geo.lineCount}, shown=${geo.msgShown})`);
  console.log("GEO OK");

  // ── a settings toggle is a STATUS, not a transcript ────────────────────
  // Maintainer 2026-09-14, at six bubbles and three copies of the legend from
  // three taps of the collision button: "I don't like the big wall of text
  // that happens when I switch collision in settings on/off". Flipping a
  // switch N times must leave ONE line saying what it is now — and the legend,
  // which is a reference rather than an event, must print once a session.
  const toggles = await p2.evaluate(async () => {
    const btn = [...document.querySelectorAll('.ml-page[data-page="settings"] .ml-plate-btn')].find((b) =>
      b.textContent.toLowerCase().includes("collision"),
    );
    if (!btn) return { err: "no collision button on the Settings page" };
    const was = document.querySelectorAll(".ml-chatlog .ml-chatline").length;
    for (let i = 0; i < 6; i++) {
      btn.click();
      await new Promise((r) => setTimeout(r, 120));
    }
    const lines = [...document.querySelectorAll(".ml-chatlog .ml-chatline")].map((l) => l.textContent);
    return {
      was,
      lines,
      state: lines.filter((t) => t.includes("Collision overlay:")).length,
      legend: lines.filter((t) => t.includes("red = terrain")).length,
    };
  });
  if (toggles.err) throw new Error(toggles.err);
  if (toggles.state !== 1)
    throw new Error(
      `six taps of the collision button left ${toggles.state} state lines on screen, not 1 — a status line must replace itself: ${JSON.stringify(toggles.lines)}`,
    );
  if (toggles.legend > 1)
    throw new Error(`the collision legend printed ${toggles.legend} times — it is a reference, not an event`);
  console.log(`TOGGLE OK — six taps, ${toggles.state} state line, ${toggles.legend} legend (log went ${toggles.was} → ${toggles.lines.length} lines)`);

  await p2.screenshot({ path: `${OUT}/chat.png` });
  console.log("PASS");
} finally {
  await browser.close();
}
