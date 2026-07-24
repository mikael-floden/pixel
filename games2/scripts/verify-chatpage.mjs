// QA: HUD Chat tab — the persistent message history that mirrors the on-screen
// chat (bottom-left log). Drives the maintainer's phone geometry and checks the
// eight requirements:
//   1. same stream as the on-screen log (system events + player chat)
//   2. keeps the last 1000 lines (oldest dropped past that)
//   3. each line prints its receive time as HH:MM
//   4. a day divider (YYYY-MM-DD) appears when the real-clock day changes
//   5. the divider LOOKS LIKE the Settings section header (.ml-amb-title)
//   6. the FIRST message starts with a date divider
//   7. a full-width input at the bottom you click to write a message
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
}
const openChat = (page) => page.click('.ml-tab[data-tab="chat"]');
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
    viewport: { width: 980, height: 2123 }, screen: { width: 393, height: 851 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    timezoneId: "Europe/Stockholm", // deterministic day boundaries for the divider test
  });
  // Reproduce the maintainer's REAL condition: Chrome "Request Desktop Site"
  // reports navigator.maxTouchPoints === 0 (a mouse desktop), which is what hid
  // the keyboard lift on his phone. Force it 0 for the whole session so the lift
  // MUST work via the physical screen size (screen.width 393), not maxTouchPoints.
  // Without this override the gate passed while his device failed.
  await ctx.addInitScript(() => Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0, configurable: true }));
  const page = await ctx.newPage();
  await enter(page, "ring_test");
  await openChat(page);
  await page.waitForSelector(".ml-chat-log", { timeout: 10000 });

  // ── the input: inset from the rails, wide, centered, at the bottom ──
  const inp = await page.evaluate(() => {
    const wrap = document.querySelector(".ml-chat");
    const log = document.querySelector(".ml-chat-log");
    const el = document.querySelector(".ml-chat-input");
    if (!wrap || !log || !el) return null;
    const wr = wrap.getBoundingClientRect(), er = el.getBoundingClientRect(), lr = log.getBoundingClientRect();
    const leftGap = er.left - wr.left, rightGap = wr.right - er.right;
    return {
      exists: true, maxLength: el.maxLength, placeholder: el.placeholder,
      leftGap, rightGap,
      inset: leftGap > 12 && rightGap > 12,          // clears the vine rails both sides
      centered: Math.abs(leftGap - rightGap) <= 2,   // equal L/R space
      wide: er.width > wr.width * 0.6,               // still a wide box
      belowLog: er.top >= lr.bottom - 2,             // pinned under the scrolling log
    };
  });
  inp && inp.exists ? ok("chat input present") : fail(`no chat input (${JSON.stringify(inp)})`);
  inp && inp.maxLength === 140 ? ok("input maxLength = MAX_CHAT_LEN (140)") : fail(`maxLength ${inp?.maxLength}`);
  inp && inp.placeholder === "say something…" ? ok("input placeholder matches") : fail(`placeholder "${inp?.placeholder}"`);
  inp && inp.inset && inp.centered ? ok(`input inset from the rails (L=${inp.leftGap.toFixed(0)} R=${inp.rightGap.toFixed(0)})`) : fail(`input not inset/centered (${JSON.stringify(inp)})`);
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
  // This harness now reproduces the maintainer's phone under "Request Desktop
  // Site": NO keyboard rect from any source AND navigator.maxTouchPoints === 0
  // (the very thing that hid the lift). The lift MUST still work — via the
  // physical screen size — or this fails, unlike the old gate.
  const rep = await page.evaluate(() => ({
    vk: navigator.virtualKeyboard ? navigator.virtualKeyboard.boundingRect.height : null,
    shrink: window.visualViewport ? Math.round(window.innerHeight - window.visualViewport.height) : null,
    touch: navigator.maxTouchPoints, phone: window.__mlKb ? window.__mlKb().phone : null,
    screen: [screen.width, screen.height],
  }));
  rep.touch === 0
    ? ok(`reproducing desktop-site: maxTouchPoints=0, no keyboard rect (vk=${rep.vk} shrink=${rep.shrink}) — the device's blind spot`)
    : fail(`harness not reproducing desktop-site: maxTouchPoints=${rep.touch} (override failed)`);
  rep.phone === true
    ? ok(`still detected as a phone via screen ${JSON.stringify(rep.screen)} (survives desktop-site)`)
    : fail(`phone detection failed with maxTouchPoints=0 — the lift would not arm (screen=${JSON.stringify(rep.screen)})`);

  // Geometry of the game BEFORE focus, so we can prove nothing moved after.
  // …including the CHAT PAGE's own boxes: floating the input out of flow used to
  // collapse its row and slide every chat line down (only the input may move).
  const frameBefore = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : null; };
    const h = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null; };
    const first = document.querySelector(".ml-chat-log > *");
    return { game: r("#game"), hud: r(".ml-hud"), tabs: r(".ml-tabrow"), h: window.innerHeight, sy: window.scrollY,
             barH: h(".ml-chat-inputbar"), logH: h(".ml-chat-log"),
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
  await page.waitForTimeout(500); // let the glide transition settle before measuring
  const lifted = await page.evaluate(() => {
    const el = document.querySelector(".ml-chat-input");
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const g = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : null; };
    return {
      position: cs.position, tprop: cs.transitionProperty, tdur: cs.transitionDuration,
      rectBottom: Math.round(r.bottom), rectTop: Math.round(r.top), width: Math.round(r.width),
      kb: getComputedStyle(document.documentElement).getPropertyValue("--ml-kb").trim(),
      up: document.documentElement.classList.contains("ml-kb-up"),
      vh: window.innerHeight,
      game: g("#game"), hud: g(".ml-hud"), tabs: g(".ml-tabrow"), sy: window.scrollY,
      dbg: window.__kbdbg, focused: el.matches(":focus"), active: document.activeElement?.className,
      barH: (() => { const e = document.querySelector(".ml-chat-inputbar"); return e ? Math.round(e.getBoundingClientRect().height) : null; })(),
      logH: (() => { const e = document.querySelector(".ml-chat-log"); return e ? Math.round(e.getBoundingClientRect().height) : null; })(),
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

  // ── req 5: the divider LOOKS LIKE the Settings header (.ml-amb-title) ──
  const look = await page.evaluate(() => {
    const key = (el) => {
      const c = getComputedStyle(el);
      // include text-shadow: .ml-chat-log sets one that inherits, so the divider
      // must reset it to truly match the (shadowless) Settings header.
      return { bt: c.borderTopWidth, bs: c.borderTopStyle, ta: c.textAlign, tt: c.textTransform, ls: c.letterSpacing, sh: c.textShadow };
    };
    const day = document.querySelector(".ml-chat-day");
    const title = document.querySelector(".ml-amb-title");
    return day && title ? { day: key(day), title: key(title) } : null;
  });
  if (!look) fail("could not compare divider styles");
  else {
    const same = ["bt", "bs", "ta", "tt", "ls", "sh"].filter((k) => look.day[k] !== look.title[k]);
    same.length === 0 ? ok(`divider matches Settings header style (${JSON.stringify(look.day)})`)
      : fail(`divider style differs on ${same.join(",")}: ${JSON.stringify(look)}`);
  }

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
} finally { await browser.close(); }
console.log(bad ? "\n=== FAIL ===" : "\n=== PASS ===");
process.exit(bad ? 1 : 0);
