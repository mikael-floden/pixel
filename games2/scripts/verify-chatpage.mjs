// QA: HUD Chat tab — the persistent message history that mirrors the on-screen
// chat (bottom-left log). Drives the maintainer's phone geometry and checks the
// eight requirements:
//   1. same stream as the on-screen log (system events + player chat)
//   2. keeps the last 1000 lines (oldest dropped past that)
//   3. each line prints its receive time as HH:MM
//   4. a day divider (YYYY-MM-DD) appears when the real-clock day changes
//   5. the divider LOOKS LIKE the Settings section header (.ml-amb-title) —
//      wiki style now: muted uppercase over a 1px var(--border) top border
//      (the log's FIRST divider drops the border by design, so the compare
//      uses a non-first divider)
//   6. the FIRST message starts with a date divider
//   7. a full-width input at the bottom you click to write a message
//      (wiki remake: the input SPANS the .ml-chat wrap — no side padding —
//      inside the page's 12px padding; no vine rails to clear any more)
//   8. that input actually sends (server round-trip back into the log)
import { chromium } from "playwright-core";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.BASE || "http://localhost:5173";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
let bad = false;
const fail = (m) => { console.log("FAIL:", m); bad = true; };
const ok = (m) => console.log("ok:", m);

async function enter(page, world) {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mlSelect, { timeout: 25000 });
  await page.evaluate((w) => {
    const i = window.__mlSelect.worlds().indexOf(w);
    if (i >= 0) window.__mlSelect.pickWorld(i);
  }, world);
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__mlSelect.commit());
  await page.waitForSelector(".ml-tabrow .ml-tab", { timeout: 30000 });
  // the __ml debug object appears once the local player has joined
  await page.waitForFunction(() => window.__ml && typeof window.__ml.chatPush === "function", { timeout: 30000 });
  // The full-screen #ml-loading cinema fade covers the HUD until the world has
  // real frames on screen — its teardown counts rAF frames, so under headless
  // software-GL it lingers well past the join. Real taps can't reach the tabs
  // through it; wait it out instead of clicking blind.
  await page.waitForSelector("#ml-loading", { state: "detached", timeout: 120000 });
}
const openChat = (page) => page.click('.ml-tab[data-tab="chat"]', { timeout: 60000 });
// read the rendered chat log: ordered rows of {kind:"day"|"line", ...}
const readLog = (page) => page.evaluate(() => {
  const log = document.querySelector(".ml-chat-log");
  if (!log) return null;
  const rows = [...log.children].map((el) => {
    if (el.classList.contains("ml-chat-day")) return { kind: "day", text: el.textContent };
    if (el.classList.contains("ml-chat-line")) {
      const time = el.querySelector(".ml-chat-time")?.textContent ?? "";
      const who = el.querySelector(".ml-chat-who")?.textContent ?? "";
      return { kind: "line", time, who, text: el.textContent };
    }
    return { kind: "other", text: el.textContent };
  });
  return { rows, lines: rows.filter((r) => r.kind === "line").length, days: rows.filter((r) => r.kind === "day").length };
});

try {
  const ctx = await browser.newContext({
    // DEVICE-WIDTH mobile geometry (393×851 = the maintainer's phone in normal
    // mobile view) — the wiki-style remake's QA standard: the new UI is plain
    // responsive CSS with no zoom compensation, so the layout viewport IS the
    // device width. (The old 980×2123 scaled-layout viewport predates the
    // remake, and its huge software-GL canvas starved rAF so badly the loading
    // cinema fade covered the HUD for minutes.)
    viewport: { width: 393, height: 851 }, screen: { width: 393, height: 851 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    timezoneId: "Europe/Stockholm", // deterministic day boundaries for the divider test
  });
  // Reproduce the maintainer's REAL condition (normal mobile mode, "Request
  // Desktop Site" OFF — he accepts the lift not working under desktop-site): a
  // TOUCH device (maxTouchPoints > 0) whose soft keyboard OVERLAYS the page and
  // shrinks NO viewport JS can read (no vk.boundingRect, no visualViewport
  // shrink). That blind spot is the whole difficulty — the lift MUST arm from the
  // touch signal alone and ESTIMATE the height. Force a realistic touch count so
  // the gate is deterministic regardless of Playwright's default.
  await ctx.addInitScript(() => Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5, configurable: true }));
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000); // headless software-GL frames run ~1s — give clicks room
  await enter(page, "ring_test");
  await openChat(page);
  await page.waitForSelector(".ml-chat-log", { timeout: 10000 });

  // ── the input: spans the wrap, breathing room to the viewport edges,
  //    centered, at the bottom. (Wiki remake: the vine rails are GONE — the
  //    old "inset from the rails" gaps were frame art; the inputbar now has NO
  //    side padding, so the input spans .ml-chat, which sits centered inside
  //    the page's 12px padding.) ──
  const inp = await page.evaluate(() => {
    const wrap = document.querySelector(".ml-chat");
    const log = document.querySelector(".ml-chat-log");
    const el = document.querySelector(".ml-chat-input");
    if (!wrap || !log || !el) return null;
    const wr = wrap.getBoundingClientRect(), er = el.getBoundingClientRect(), lr = log.getBoundingClientRect();
    const leftGap = er.left, rightGap = window.innerWidth - er.right; // vs the VIEWPORT now
    return {
      exists: true, maxLength: el.maxLength, placeholder: el.placeholder,
      leftGap, rightGap,
      inViewport: leftGap > 8 && rightGap > 8,       // side margins inside the viewport
      centered: Math.abs(leftGap - rightGap) <= 2,   // equal L/R space
      spansWrap: Math.abs(er.width - wr.width) <= 2, // input spans the wrap (no side padding)
      wide: er.width > wr.width * 0.6,               // still a wide box
      belowLog: er.top >= lr.bottom - 2,             // pinned under the scrolling log
    };
  });
  inp && inp.exists ? ok("chat input present") : fail(`no chat input (${JSON.stringify(inp)})`);
  inp && inp.maxLength === 140 ? ok("input maxLength = MAX_CHAT_LEN (140)") : fail(`maxLength ${inp?.maxLength}`);
  inp && inp.placeholder === "say something…" ? ok("input placeholder matches") : fail(`placeholder "${inp?.placeholder}"`);
  inp && inp.inViewport && inp.centered ? ok(`input centered with side margins (L=${inp.leftGap.toFixed(0)} R=${inp.rightGap.toFixed(0)})`) : fail(`input not inside/centered (${JSON.stringify(inp)})`);
  inp && inp.spansWrap ? ok("input spans the chat wrap (no inputbar side padding)") : fail(`input doesn't span the wrap (${JSON.stringify(inp)})`);
  inp && inp.wide ? ok("input still spans most of the width") : fail(`input too narrow (${JSON.stringify(inp)})`);
  inp && inp.belowLog ? ok("input sits below the log (bottom)") : fail("input not at the bottom");

  // ── keyboard behaviour. TWO requirements, tested by REAL GEOMETRY (not by
  //    "the API is enabled" — the previous gate asserted that and still shipped a
  //    build where the box stayed hidden on the maintainer's phone):
  //      1. the game must not move/resize/scroll when the keyboard opens;
  //      2. the focused chat input must END UP ON SCREEN above the keyboard —
  //         and it must do so even though this harness, like his device, reports
  //         NO keyboard geometry at all (that blind spot WAS the bug). ──
  const meta = await page.evaluate(() => document.querySelector('meta[name=viewport]')?.getAttribute("content") || "");
  !/interactive-widget/.test(meta)
    ? ok("viewport meta doesn't force interactive-widget (that panned the whole game)") : fail(`viewport meta forces interactive-widget: ${meta}`);
  // This harness reproduces the maintainer's phone in normal mobile mode: a touch
  // device (maxTouchPoints>0) with NO keyboard rect from ANY source (vk + visual
  // viewport both silent). The lift MUST arm from the touch signal + estimate the
  // height, or this fails.
  const rep = await page.evaluate(() => ({
    vk: navigator.virtualKeyboard ? navigator.virtualKeyboard.boundingRect.height : null,
    shrink: window.visualViewport ? Math.round(window.innerHeight - window.visualViewport.height) : null,
    touch: navigator.maxTouchPoints, touchDevice: window.__mlKb ? window.__mlKb().touchDevice : null,
    screen: [screen.width, screen.height],
  }));
  rep.touch > 0 && !rep.vk && !rep.shrink
    ? ok(`reproducing mobile mode: touch device (maxTouchPoints=${rep.touch}), no keyboard rect (vk=${rep.vk} shrink=${rep.shrink}) — the device's blind spot`)
    : fail(`harness not reproducing mobile mode: touch=${rep.touch} vk=${rep.vk} shrink=${rep.shrink}`);
  rep.touchDevice === true
    ? ok(`detected as a touch device (lift arms without any keyboard geometry)`)
    : fail(`touch detection failed — the lift would not arm (touch=${rep.touch})`);

  // Geometry of the game BEFORE focus, so we can prove nothing moved after.
  // …including the CHAT PAGE's own boxes: floating the input out of flow used to
  // collapse its row and slide every chat line down (only the input may move).
  const frameBefore = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : null; };
    const h = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null; };
    const cssBottom = (s) => { const e = document.querySelector(s); return e ? Math.round(parseFloat(getComputedStyle(e).bottom)) : null; };
    const first = document.querySelector(".ml-chat-log > *");
    return { game: r("#game"), hud: r(".ml-hud"), tabs: r(".ml-tabrow"), h: window.innerHeight, sy: window.scrollY,
             barH: h(".ml-chat-inputbar"), logH: h(".ml-chat-log"),
             chatlogBottom: cssBottom(".ml-chatlog"), // the on-screen "game-view" chat overlay
             clockBottom: cssBottom(".ml-clock"), // the time-of-day pill, opposite corner
             firstLine: first ? Math.round(first.getBoundingClientRect().top) : null };
  });

  // FOCUS the input for real, and let the lift settle (estimate path ~350ms).
  // Count the focus events the lift listens for, so a failure says WHY.
  await page.evaluate(() => {
    window.__kbdbg = { fin: 0, fout: 0 };
    document.addEventListener("focusin", (e) => { if (e.target.classList?.contains("ml-chat-input")) window.__kbdbg.fin++; });
    document.addEventListener("focusout", (e) => { if (e.target.classList?.contains("ml-chat-input")) window.__kbdbg.fout++; });
  });
  await page.evaluate(() => document.querySelector(".ml-chat-input").focus());
  // Wait for the lift to arm rather than assuming a budget — this harness's WebGL
  // load can starve timers (which once hid a WORKING fix behind a 700ms timeout).
  const armed = await page.waitForFunction(() => document.documentElement.classList.contains("ml-kb-up"), { timeout: 5000 })
    .then(() => true).catch(() => false);
  armed ? ok("lift arms on focus (no keyboard geometry needed)") : fail(`lift never armed: ${JSON.stringify(await page.evaluate(() => window.__mlKb?.()))}`);
  // Let the glide settle before measuring — but by GEOMETRY, not a fixed budget:
  // the box arms pinned at its resting spot, then a rAF raises --ml-kb to the
  // estimate and the 150ms bottom-transition rides up. Headless software-GL
  // frames run ~1s, so wait until the rect has actually reached the CSS target
  // (bottom = --ml-kb + 10) with the estimate (≥ KB_MIN 80) in place.
  await page.waitForFunction(() => {
    const el = document.querySelector(".ml-chat-input");
    if (!el) return false;
    const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ml-kb")) || 0;
    if (kb < 80) return false; // still at the initial pin — the raise hasn't landed
    return Math.abs(window.innerHeight - (kb + 10) - el.getBoundingClientRect().bottom) < 2;
  }, { timeout: 20000 }).catch(() => {}); // a genuine miss fails the geometry checks below
  const lifted = await page.evaluate(() => {
    const el = document.querySelector(".ml-chat-input");
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const g = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : null; };
    const rootCss = getComputedStyle(document.documentElement);
    const hudH = Math.round(parseFloat(rootCss.getPropertyValue("--hud-h")) || 0);
    return {
      position: cs.position, tprop: cs.transitionProperty, tdur: cs.transitionDuration,
      rectBottom: Math.round(r.bottom), rectTop: Math.round(r.top), width: Math.round(r.width),
      rectLeft: Math.round(r.left), rightGap: Math.round(window.innerWidth - r.right),
      kb: rootCss.getPropertyValue("--ml-kb").trim(),
      hudH, railTop: window.innerHeight - hudH, // the HUD's top edge (was the frame's bottom rail)
      up: document.documentElement.classList.contains("ml-kb-up"),
      vh: window.innerHeight,
      game: g("#game"), hud: g(".ml-hud"), tabs: g(".ml-tabrow"), sy: window.scrollY,
      dbg: window.__kbdbg, focused: el.matches(":focus"), active: document.activeElement?.className,
      barH: (() => { const e = document.querySelector(".ml-chat-inputbar"); return e ? Math.round(e.getBoundingClientRect().height) : null; })(),
      logH: (() => { const e = document.querySelector(".ml-chat-log"); return e ? Math.round(e.getBoundingClientRect().height) : null; })(),
      chatlogBottom: (() => { const e = document.querySelector(".ml-chatlog"); return e ? Math.round(parseFloat(getComputedStyle(e).bottom)) : null; })(),
      clockBottom: (() => { const e = document.querySelector(".ml-clock"); return e ? Math.round(parseFloat(getComputedStyle(e).bottom)) : null; })(),
      placeholder: getComputedStyle(document.querySelector(".ml-chat-input"), "::placeholder").color,
      firstLine: (() => { const e = document.querySelector(".ml-chat-log > *"); return e ? Math.round(e.getBoundingClientRect().top) : null; })(),
    };
  });
  // (2) the box actually left its bottom slot and sits ON SCREEN, clear of the keyboard
  lifted.up && lifted.position === "fixed"
    ? ok(`input detached from the HUD (fixed, --ml-kb=${lifted.kb})`)
    : fail(`input did not detach: up=${lifted.up} position=${lifted.position} kb="${lifted.kb}" ` +
           `focusEvents=${JSON.stringify(lifted.dbg)} focused=${lifted.focused} active="${lifted.active}"`);
  const clearance = lifted.vh - lifted.rectBottom;
  clearance > 200
    ? ok(`input rides clear of the keyboard (${clearance}px above the viewport bottom)`)
    : fail(`input only ${clearance}px above the bottom — it would sit under the keyboard`);
  lifted.rectTop >= 0 && lifted.rectBottom <= lifted.vh
    ? ok(`input is fully ON SCREEN (top=${lifted.rectTop} bottom=${lifted.rectBottom} of ${lifted.vh})`)
    : fail(`input off screen: top=${lifted.rectTop} bottom=${lifted.rectBottom} vh=${lifted.vh}`);
  // ONE margin for everything that hugs an edge: 10px, the same as the stat
  // chips and the time-of-day pill (maintainer 2026-07-31 — it was 14 here).
  Math.abs(lifted.rectLeft - 10) <= 2 && Math.abs(lifted.rightGap - 10) <= 2
    ? ok(`floated box on the shared 10px margin (left=${lifted.rectLeft} right=${lifted.rightGap})`)
    : fail(`floated box not at left/right 10: left=${lifted.rectLeft} rightGap=${lifted.rightGap}`);
  // (3) the box CLEARS the HUD's top edge (the frame's bottom-rail art is gone;
  //     --hud-h is the equivalent line now — kbHeight() floors --ml-kb at
  //     hud-h + 2 so the box never sinks into the HUD). Its bottom edge is at
  //     least a hair above that edge.
  lifted.railTop != null && lifted.rectBottom <= lifted.railTop + 2
    ? ok(`input clears the HUD's top edge (box bottom=${lifted.rectBottom} ≤ hudTop=${lifted.railTop})`)
    : fail(`input sits in the HUD: box bottom=${lifted.rectBottom} vs hudTop=${lifted.railTop} (hudH=${lifted.hudH})`);
  // (4) the on-screen "game-view" chat log is pushed UP above the floated box so
  //     the box doesn't cover it (maintainer: "translate the game-view chat higher
  //     up"). Its CSS bottom rises when .ml-kb-up is active.
  frameBefore.chatlogBottom != null && lifted.chatlogBottom != null && lifted.chatlogBottom > frameBefore.chatlogBottom + 20
    ? ok(`game-view chat log lifted to make room (bottom ${frameBefore.chatlogBottom} -> ${lifted.chatlogBottom})`)
    : fail(`game-view chat log not lifted: bottom ${frameBefore.chatlogBottom} -> ${lifted.chatlogBottom}`);
  // …and so does the time-of-day pill in the opposite corner — the keyboard
  // covers both bottom corners, so both step up, and onto the SAME line
  // (maintainer 2026-07-31).
  frameBefore.clockBottom != null && lifted.clockBottom != null && lifted.clockBottom > frameBefore.clockBottom + 20
    ? ok(`time-of-day pill lifted too (bottom ${frameBefore.clockBottom} -> ${lifted.clockBottom})`)
    : fail(`pill not lifted: bottom ${frameBefore.clockBottom} -> ${lifted.clockBottom}`);
  Math.abs(lifted.clockBottom - lifted.chatlogBottom) <= 1
    ? ok(`chat log and pill lifted onto the same line (${lifted.clockBottom}px)`)
    : fail(`log ${lifted.chatlogBottom} and pill ${lifted.clockBottom} lifted to different heights`);
  // The prompt gets out of the way once you are actually typing.
  lifted.placeholder === "rgba(0, 0, 0, 0)"
    ? ok("placeholder hidden while the input has focus")
    : fail(`placeholder still painted while focused: ${lifted.placeholder}`);
  lifted.width > 200 ? ok(`input keeps its width while floated (${lifted.width}px)`) : fail(`floated input too narrow (${lifted.width}px)`);
  /bottom|all/.test(lifted.tprop) && parseFloat(lifted.tdur) > 0
    ? ok(`lift is animated, not snapped (transition ${lifted.tprop} ${lifted.tdur})`) : fail(`no bottom transition (${lifted.tprop} ${lifted.tdur})`);
  // (1) NOTHING else moved: same tops, same scroll, same viewport height
  const moved = ["game", "hud", "tabs"].filter((k) => frameBefore[k] !== lifted[k]);
  moved.length === 0 && lifted.sy === frameBefore.sy && lifted.vh === frameBefore.h
    ? ok(`game/HUD unmoved while the input floats (game=${lifted.game} hud=${lifted.hud} tabs=${lifted.tabs}, scrollY=${lifted.sy})`)
    : fail(`the game moved: ${moved.join(",")} shifted; scrollY ${frameBefore.sy}->${lifted.sy}; vh ${frameBefore.h}->${lifted.vh}`);
  const reflowed = ["barH", "logH", "firstLine"].filter((k) => frameBefore[k] !== lifted[k]);
  reflowed.length === 0
    ? ok(`chat page didn't reflow (row=${lifted.barH}px log=${lifted.logH}px, lines put)`)
    : fail(`chat page reflowed when the input floated: ${reflowed.map((k) => `${k} ${frameBefore[k]}->${lifted[k]}`).join(", ")}`);
  // blur → the box returns to its HUD slot
  await page.evaluate(() => document.querySelector(".ml-chat-input").blur());
  await page.waitForTimeout(150);
  const restored = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".ml-chat-input"));
    return { position: cs.position, up: document.documentElement.classList.contains("ml-kb-up") };
  });
  restored.position !== "fixed" && !restored.up
    ? ok("input returns to the HUD when the box loses focus") : fail(`not restored on blur: ${JSON.stringify(restored)}`);

  // A tap OUTSIDE the floating box retires it — the only way to hide the box on a
  // no-geometry device after the keyboard is dismissed with ▼/Back (which doesn't
  // blur). Re-focus, confirm it floats, then pointerdown elsewhere → it drops.
  await page.evaluate(() => document.querySelector(".ml-chat-input").focus());
  await page.waitForFunction(() => document.documentElement.classList.contains("ml-kb-up"), { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => {
    const t = document.querySelector("#game") || document.body;
    t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
  });
  await page.waitForTimeout(200);
  const outside = await page.evaluate(() => ({
    up: document.documentElement.classList.contains("ml-kb-up"),
    focused: document.querySelector(".ml-chat-input").matches(":focus"),
  }));
  !outside.up && !outside.focused
    ? ok("a tap outside the box retires the float (Android ▼/Back has no blur)") : fail(`outside tap didn't retire: ${JSON.stringify(outside)}`);

  // ── req 1 (system side) + req 6: on login the world logs system events
  //    immediately (time-of-day sync, the join "star"). Wait for one, then the
  //    FIRST row must be a date divider (so the first message shows its date). ──
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".ml-chat-line .ml-chat-who")]
      .some((w) => /^(—|⭐)/.test(w.textContent || "")),
    { timeout: 10000 }).catch(() => {});
  const login = await readLog(page);
  const sysLine = login?.rows.find((r) => r.kind === "line" && /^(—|⭐)/.test(r.who));
  sysLine ? ok(`system message shown on login ("${sysLine.who.trim()} …")`) : fail(`no system message on login: ${JSON.stringify(login)}`);
  login && login.rows[0]?.kind === "day" && /^\d{4}-\d{2}-\d{2}$/.test(login.rows[0].text)
    ? ok(`first message on login starts with a date divider (${login.rows[0].text})`)
    : fail(`first login row is not a date divider: ${JSON.stringify(login?.rows[0])}`);

  // ── keyboard leak guard: a keydown in the input must NOT bubble to window
  //    (Phaser's WASD listener lives there) — stopPropagation like ChatUI. ──
  const leaked = await page.evaluate(() => {
    let hits = 0;
    const h = () => hits++;
    window.addEventListener("keydown", h);
    const el = document.querySelector(".ml-chat-input");
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "w", bubbles: true, cancelable: true }));
    window.removeEventListener("keydown", h);
    el.blur();
    return hits;
  });
  leaked === 0 ? ok("movement keys don't leak past the input") : fail(`keydown leaked to window (${leaked}x)`);

  // ── req 1 + 3 + 6: real path. Send a chat via __ml.say → the server
  //    broadcasts it back → WorldScene.addLog → onLog → the Chat page. ──
  await page.evaluate(() => window.__ml.say("hello from qa"));
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".ml-chat-line")].some((l) => l.textContent.includes("hello from qa")),
    { timeout: 8000 }).catch(() => {});
  let s = await readLog(page);
  const real = s?.rows.find((r) => r.kind === "line" && r.text.includes("hello from qa"));
  real ? ok(`player chat mirrored to the page ("${real.who}…")`) : fail("player chat not mirrored");
  real && /^\d{2}:\d{2}$/.test(real.time) ? ok(`line shows HH:MM time (${real.time})`) : fail(`bad time "${real?.time}"`);
  real && real.who.trim().length > 1 ? ok("line shows sender name") : fail(`no sender ("${real?.who}")`);
  // req 6: the very first row is a date divider
  s && s.rows[0]?.kind === "day" && /^\d{4}-\d{2}-\d{2}$/.test(s.rows[0].text)
    ? ok(`first row is a date divider (${s.rows[0].text})`) : fail(`first row not a divider: ${JSON.stringify(s?.rows[0])}`);

  // ── req 4: a NEW-DAY divider between two lines on different real days. Push
  //    at controlled times (local noon, two adjacent days — no midnight edge). ──
  const dd = await page.evaluate(() => {
    const t1 = new Date(2026, 0, 15, 12, 0, 0).getTime();
    const t2 = new Date(2026, 0, 16, 12, 0, 0).getTime();
    window.__ml.chatPush("Alma", "day-one line", t1);
    window.__ml.chatPush("Bo", "day-two line", t2);
    const f = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
    return { d1: f(t1), d2: f(t2) };
  });
  s = await readLog(page);
  const i1 = s.rows.findIndex((r) => r.kind === "line" && r.text.includes("day-one line"));
  const i2 = s.rows.findIndex((r) => r.kind === "line" && r.text.includes("day-two line"));
  const divBetween = i1 >= 0 && i2 > i1 && s.rows.slice(i1 + 1, i2).some((r) => r.kind === "day" && r.text === dd.d2);
  divBetween ? ok(`new-day divider (${dd.d2}) sits between the two days`) : fail(`no day divider between lines: ${JSON.stringify(s.rows.slice(Math.max(0,i1), i2 + 1))}`);
  s.rows.some((r) => r.kind === "day" && r.text === dd.d1) ? ok(`day-one divider present (${dd.d1})`) : fail(`missing ${dd.d1} divider`);

  // ── req 5: the divider LOOKS LIKE the Settings header (.ml-amb-title) —
  //    wiki style: muted uppercase centered text over a 1px var(--border) top
  //    border, no text-shadow. Compare REAL computed styles on a NON-FIRST
  //    divider (.ml-chat-day:first-child drops its top border by design — the
  //    log panel already draws the top edge; the dd push above guarantees one
  //    exists). letter-spacing is authored in em (.08em on both) but computes
  //    to px of each element's own font size (11px vs 12px), so compare the
  //    em-normalized value. (Runs after req 4 so a non-first divider exists.) ──
  const look = await page.evaluate(() => {
    const key = (el) => {
      const c = getComputedStyle(el);
      const fs = parseFloat(c.fontSize) || 1;
      return { bt: c.borderTopWidth, bs: c.borderTopStyle, bc: c.borderTopColor,
               ta: c.textAlign, tt: c.textTransform, fw: c.fontWeight, col: c.color,
               lsEm: ((parseFloat(c.letterSpacing) || 0) / fs).toFixed(3), sh: c.textShadow };
    };
    const days = [...document.querySelectorAll(".ml-chat-day")];
    const day = days.length > 1 ? days[1] : days[0];
    const title = document.querySelector(".ml-amb-title");
    return day && title ? { day: key(day), title: key(title) } : null;
  });
  if (!look) fail("could not compare divider styles");
  else {
    const same = ["bt", "bs", "bc", "ta", "tt", "fw", "col", "lsEm", "sh"].filter((k) => look.day[k] !== look.title[k]);
    same.length === 0 ? ok(`divider matches Settings header style (${JSON.stringify(look.day)})`)
      : fail(`divider style differs on ${same.join(",")}: ${JSON.stringify(look)}`);
  }

  // ── req 2: cap at 1000, oldest dropped. Bulk-push while the tab is hidden
  //    (no per-push render), then reopen for one render. ──
  await page.click('.ml-tab[data-tab="settings"]');
  await page.evaluate(() => {
    for (let i = 0; i < 1100; i++) window.__ml.chatPush("Bulk", `bulk-${i}`, Date.now());
  });
  await openChat(page);
  await page.waitForTimeout(200);
  const cap = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".ml-chat-line")].map((l) => l.textContent);
    return {
      count: lines.length,
      hasFirst: lines.some((t) => t.includes("hello from qa")),
      hasBulk0: lines.some((t) => /(^|\s)bulk-0($|:|\s)/.test(t)),
      hasBulkLast: lines.some((t) => t.includes("bulk-1099")),
    };
  });
  cap.count === 1000 ? ok(`history capped at exactly 1000 lines`) : fail(`line count ${cap.count} (want 1000)`);
  !cap.hasFirst ? ok("oldest lines dropped past the cap") : fail("oldest line survived the cap");
  cap.hasBulkLast && !cap.hasBulk0 ? ok("newest kept, oldest bulk dropped") : fail(`cap window wrong (last=${cap.hasBulkLast} bulk0=${cap.hasBulk0})`);

  // ── scroll preservation: scrolled UP reading history, an arriving line must
  //    NOT yank the view to the top (the rebuild wipe resets scrollTop to 0). ──
  const scr = await page.evaluate(() => {
    const log = document.querySelector(".ml-chat-log");
    log.scrollTop = 300;              // 1000 lines → well within range, not near bottom
    const before = log.scrollTop, max = log.scrollHeight - log.clientHeight;
    window.__ml.chatPush("Zed", "scroll-preserve probe", Date.now()); // renderChat(false)
    return { before, after: log.scrollTop, max };
  });
  scr.before > 100 && scr.max > 400 && Math.abs(scr.after - scr.before) < 60
    ? ok(`scroll position held on a new line (${scr.before} -> ${scr.after})`)
    : fail(`scroll not held (before=${scr.before} after=${scr.after} max=${scr.max})`);

  // ── req 7/8: type in the box + Enter → it round-trips through the server
  //    back into the log (proves the input actually sends). ──
  const marker = "qa-send-token";
  await page.evaluate((m) => {
    const el = document.querySelector(".ml-chat-input");
    el.focus(); el.value = m;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  }, marker);
  const sent = await page.waitForFunction((m) =>
    [...document.querySelectorAll(".ml-chat-line")].some((l) => l.textContent.includes(m)),
    marker, { timeout: 8000 }).then(() => true).catch(() => false);
  sent ? ok("typing + Enter sends a chat that returns to the log") : fail("input did not send / round-trip");
  const cleared = await page.evaluate(() => document.querySelector(".ml-chat-input").value);
  cleared === "" ? ok("input clears after send") : fail(`input not cleared ("${cleared}")`);

  // ── req 9: A TAP ON THE WORLD ALWAYS DROPS THE BOX'S FOCUS (maintainer
  //    2026-08-05: "select the input, close the keyboard, now attack an enemy
  //    or click the game-view and the keyboard will open again"). Android's
  //    ▼ hides the keyboard WITHOUT blurring, and Phaser preventDefault()s the
  //    canvas pointerdown, so nothing else ever takes focus away — Chrome then
  //    re-opens the keyboard on the next tap. The lift's blur-on-outside-tap
  //    must therefore be gated on FOCUS, not on the box still floating. ──
  const focusDrop = await page.evaluate(() => {
    const el = document.querySelector(".ml-chat-input");
    el.focus();
    const was = document.activeElement === el;
    // a real tap in the game view, captured on the way down
    const c = document.querySelector("#game canvas") || document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    return { was, still: document.activeElement === el };
  });
  focusDrop.was && !focusDrop.still
    ? ok("a tap on the game view blurs the chat box (no phantom keyboard on the next tap)")
    : fail(`chat box kept focus after a world tap: ${JSON.stringify(focusDrop)}`);
  // …and the IN-WORLD box closes on blur, or the world scene would keep
  // Phaser's keyboard disabled forever and the player could never walk.
  const worldBox = await page.evaluate(() => {
    const el = document.querySelector(".ml-chatinput");
    if (!el) return null;
    el.style.display = "block";
    el.focus();
    el.blur();
    return { walk: window.__ml.canWalk() };
  });
  worldBox && worldBox.walk
    ? ok("blurring the in-world chat box hands movement back")
    : fail(`in-world box left the player frozen: ${JSON.stringify(worldBox)}`);
} finally { await browser.close(); }
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
