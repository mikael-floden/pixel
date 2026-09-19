// Verify chat: one client sends a message, another receives it as a bubble.
// WIKI-STYLE UI (2026-07-30): the ChatUI overlay (.ml-chatlog/.ml-chatinput)
// is plain CSS anchored in real px above --hud-h (published by hud.ts
// applyLayout: exactly three backpack rows tall in portrait, 2026-09-18). ONE
// MARGIN FOR EVERYTHING that
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
      // THE PORTRAIT HUD IS EXACTLY THREE BACKPACK ROWS TALL (hud.ts
      // portraitHudHeight, maintainer 2026-09-18): 1px rule + tab row + page
      // padding + 3 slots + 2 gaps + the same padding + the safe inset.
      threeRows: (() => {
        const px = (v) => parseFloat(v) || 0;
        const tab = document.querySelector(".ml-tabrow"), pg = document.querySelector('.ml-page[data-page="backpack"]'), grid = pg && pg.querySelector(".ml-slots");
        if (!tab || !grid) return null;
        const pcs = getComputedStyle(pg), gcs = getComputedStyle(grid);
        const inner = Math.min(innerWidth - px(pcs.paddingLeft) - px(pcs.paddingRight), px(gcs.maxWidth) || Infinity);
        const cols = (gcs.gridTemplateColumns.match(/\d+(?=\s*,)/) || [5])[0] * 1;
        const slot = (inner - (cols - 1) * px(gcs.columnGap)) / cols;
        const rows = Math.round(1 + tab.getBoundingClientRect().height + 2 * px(pcs.paddingTop) + 3 * slot + 2 * px(gcs.rowGap) + px(getComputedStyle(document.documentElement).getPropertyValue("--ml-safe-bottom")));
        return Math.min(rows, Math.round(innerHeight * 0.382)); // never taller than the split it replaced
      })(),

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
  if (!near(geo.hudH, geo.threeRows))
    throw new Error(`--hud-h ${geo.hudH} != three backpack rows (${geo.threeRows}) — hud.ts portraitHudHeight`);
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

  // ── THE CHAT TAKES THE CORNER THE STICK DOES NOT — PORTRAIT ONLY ──────
  // Maintainer 2026-09-19: "when the control is left handed … in portrait
  // mode it's hard to read the chat messages. Can we make the chat right
  // aligned for this mode? … still left aligned for right-handed people and
  // I'm only talking about portrait mode here."
  //
  // THE CLAIM IS THE RELATIONSHIP, NOT A SIDE: in portrait the pill and the
  // Wiki row are top-right, so the game view's two bottom corners belong to
  // the ghost stick and this log alone — and they must never be the SAME
  // corner. So the stick is measured with the log in both hands and the two
  // are required to be on opposite sides. Asserting "right-handed ⇒ log at
  // left" alone would pass on a build that moved the STICK instead.
  const sides = async (hand) => {
    await p2.evaluate((h) => window.__ml.hand(h), hand);
    await p2.waitForTimeout(400); // the anchors glide (left/right .3s)
    return p2.evaluate(() => {
      const W = window.innerWidth;
      const gaps = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { l: Math.round(r.left), r: Math.round(W - r.right), w: Math.round(r.width) };
      };
      const input = document.querySelector(".ml-chatinput");
      const prev = input.style.display;
      input.style.display = "block";
      const inp = gaps(".ml-chatinput");
      input.style.display = prev;
      return {
        lh: document.documentElement.classList.contains("ml-lh"),
        land: document.documentElement.classList.contains("ml-land"),
        log: gaps(".ml-chatlog"),
        line: gaps(".ml-chatlog .ml-chatline"),
        input: inp,
        stick: gaps(".ml-pad-stick"),
      };
    });
  };
  const R = await sides("right");
  const L = await sides("left");
  console.log("HANDS " + JSON.stringify({ R, L }));
  if (R.land || L.land) throw new Error("this section is portrait's — .ml-land is set");
  if (!L.lh || R.lh) throw new Error(`ml-lh did not follow __ml.hand (right=${R.lh}, left=${L.lh})`);
  if (!R.stick || !L.stick) throw new Error("no .ml-pad-stick to place the chat against");
  // right-handed: his default, and it must not have moved a pixel
  if (!near(R.log.l, 10)) throw new Error(`right-handed chatlog left ${R.log.l} != 10 — the default moved`);
  if (!(R.stick.r < R.stick.l)) throw new Error(`right-handed ghost stick is not in the RIGHT corner (${JSON.stringify(R.stick)})`);
  // left-handed: the log mirrors, on the SAME margin, and the input with it
  if (!near(L.log.r, 10)) throw new Error(`left-handed chatlog right gap ${L.log.r} != 10 — the mirrored margin is the one margin`);
  if (!(L.log.l > L.log.r)) throw new Error(`left-handed chatlog still hangs off the left (${JSON.stringify(L.log)})`);
  if (!near(L.input.r, 10)) throw new Error(`left-handed chatinput right gap ${L.input.r} != 10 — the box must follow its log`);
  if (!(L.stick.l < L.stick.r)) throw new Error(`left-handed ghost stick is not in the LEFT corner (${JSON.stringify(L.stick)})`);
  // …and the relationship itself, in both hands
  for (const [name, g] of [["right", R], ["left", L]])
    if (Math.sign(g.log.l - g.log.r) === Math.sign(g.stick.l - g.stick.r))
      throw new Error(`${name}-handed: the chat log and the thumb stick share a corner — log ${JSON.stringify(g.log)}, stick ${JSON.stringify(g.stick)}`);
  // the BUBBLES hang off the log's own edge, not just the box moving
  if (!near(R.line.l, R.log.l)) throw new Error(`right-handed bubble left ${R.line.l} != log left ${R.log.l}`);
  if (!near(L.line.r, L.log.r)) throw new Error(`left-handed bubble right ${L.line.r} != log right ${L.log.r} — align-items did not flip`);
  // LANDSCAPE IS UNTOUCHED, by his word ("only … portrait"). The guard is
  // `:not(.ml-land)` in the rule, so the class is what is tested: forced on
  // for the read (applyLayout owns it and will take it back on the next
  // resize), the log must fall straight back to its left anchor.
  const landHeld = await p2.evaluate(() => {
    document.documentElement.classList.add("ml-land");
    const cs = getComputedStyle(document.querySelector(".ml-chatlog"));
    const out = { left: cs.left, right: cs.right, align: cs.alignItems };
    document.documentElement.classList.remove("ml-land");
    return out;
  });
  if (landHeld.left === "auto" || landHeld.align === "flex-end")
    throw new Error(`the mirror leaked into landscape: ${JSON.stringify(landHeld)}`);
  await p2.evaluate(() => window.__ml.hand("right")); // leave his default set
  console.log(`HANDS OK — right-handed log left ${R.log.l} / stick right ${R.stick.r}; left-handed log right ${L.log.r} / stick left ${L.stick.l}; landscape unmirrored`);

  await p2.screenshot({ path: `${OUT}/chat.png` });
  console.log("PASS");
} finally {
  await browser.close();
}
